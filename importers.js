/*
 * Metabolic Simulator
 * Copyright (C) 2026 Rick Theiner
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/* =========================================================================
   importers.js — food-log importers (adapter pattern)

   Three layers, deliberately separated so the next source is a parser and
   nothing else:

     1. CSV reading + header matching   (shared plumbing)
     2. per-source PARSERS              parse(text) -> { entries, warnings }
     3. the shared MAPPER               mapEntriesToSchedule(entries, opts)

   Every parser emits the same ImportedEntry shape, so MyFitnessPal and
   FatSecret only need step 2 — register them with registerImportParser()
   and they inherit detection, review, day-mapping and merging for free.

     ImportedEntry = {
       kind:      'food'                  (default when absent)
       date:      'YYYY-MM-DD'
       time:      'HH:MM' | null          null = export had no clock time
       mealSlot:  string | null           source's group/meal label
       name:      string
       kcal:      number
       carbs_g:   number
       protein_g: number
       fat_g:     number
       alcohol_g: number | null           null ONLY if the source cannot know
       amount:    string                  display-only, optional
     }

     ImportedExercise = { kind: 'exercise', date, time, name, minutes,
                          kcalBurned }

   This file is DOM-free on purpose: the regression suite runs the parsers
   and the mapper directly, with no page to build.
   ========================================================================= */
(function () {
  'use strict';

  // =======================================================================
  //  1 · CSV reading
  // =======================================================================
  // Quote-aware reader -> array of rows (arrays of cell strings). Handles
  // embedded commas, embedded newlines and doubled quotes, which a
  // split(',') cannot — food names like "Bread, whole wheat" are routine.
  // Fully blank rows are dropped; a row that is blank except for trailing
  // empty cells is not, so a genuinely empty nutrient row still reports.
  function parseCSV(text) {
    const rows = []; let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(c => (c || '').trim() !== ''));
  }

  // ---- header matching --------------------------------------------------
  // Cronometer writes dozens of nutrient columns and both their order and
  // their number change with the user's diary settings, so every column is
  // located BY NAME. Normalising strips the unit suffix and any punctuation
  // so "Carbs (g)", "carbs(g)" and "Carbs" all land on "carbs".
  function normHeader(h) {
    return String(h == null ? '' : h)
      .replace(/^﻿/, '')          // BOM rides on the first header
      .replace(/\([^)]*\)/g, ' ')      // drop "(g)" / "(kcal)" / "(kJ)"
      .replace(/[^a-z0-9]+/gi, ' ')    // hyphens, slashes, punctuation -> space
      .trim().toLowerCase().replace(/\s+/g, ' ');
  }
  const leadWord = s => s.split(' ')[0];

  // Score a normalised header against one alias.
  //   3  exact match                      "carbs"      vs "carbs"
  //   2  alias is a whole-word prefix     "total fat"  vs "total fat"
  //   1  same leading word, SINGLE-word aliases only
  //
  // The single-word restriction on tier 1 is load-bearing. With it removed,
  // the alias "total fat" would claim a "Total Carbs" column through the
  // shared leading word "total".
  function scoreHeader(h, alias) {
    if (!h || !alias) return 0;
    if (h === alias) return 3;
    if (h.indexOf(alias + ' ') === 0) return 2;
    if (alias.indexOf(' ') < 0 && leadWord(h) === alias) return 1;
    return 0;
  }

  // headers -> { field: {idx, raw, norm} }.
  //
  // Alias ORDER is a tie-break, ranking above column position: an export
  // carrying both "Group" and "Category" must resolve to Group whichever
  // one the source happens to write first, so the alias list states the
  // preference and the file's layout does not get a vote. Position only
  // settles a tie between two headers matching the same alias equally well,
  // where leftmost wins — sources put the headline macro before its
  // breakdown.
  function matchHeaders(headers, aliasMap) {
    const norm = headers.map(normHeader);
    const found = {};
    Object.keys(aliasMap).forEach(field => {
      const aliases = aliasMap[field];
      let best = 0, bestIdx = -1;
      norm.forEach((h, i) => {
        let s = 0;
        for (let a = 0; a < aliases.length; a++) {
          const raw = scoreHeader(h, aliases[a]);
          if (!raw) continue;
          // tier dominates, then earlier alias, then earlier column
          s = Math.max(s, raw * 100 - a);
        }
        if (s > best) { best = s; bestIdx = i; }
      });
      if (bestIdx >= 0) found[field] = { idx: bestIdx, raw: headers[bestIdx], norm: norm[bestIdx] };
    });
    return found;
  }

  // ---- cell coercion ----------------------------------------------------
  // A blank nutrient cell means "none logged", so it is 0 — never NaN, which
  // would silently poison every downstream total. A cell that has content but
  // is not a number is also 0, but reports itself so the review screen can
  // show it rather than pretending the file was clean.
  function toNumber(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s || s === '-' || s === '--' || s === 'N/A' || s === 'n/a') return { v: 0, ok: true, blank: true };
    let t = s.replace(/[^0-9,.\-+eE]/g, '');            // strip stray units ("12 g")
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');   // 1,234.5
    else if (t.indexOf(',') >= 0 && t.indexOf('.') < 0) t = t.replace(',', '.');  // decimal comma
    else t = t.replace(/,/g, '');
    const v = parseFloat(t);
    if (!isFinite(v)) return { v: 0, ok: false, blank: false };
    return { v, ok: true, blank: false };
  }

  const pad2 = n => (n < 10 ? '0' : '') + n;

  // 'HH:MM' | null. Accepts 24h and 12h-with-meridiem, since diary exports
  // follow the account's locale setting rather than one fixed format.
  function parseTime(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    const m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])\.?\s*m\.?$/i.exec(s) ||
              /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
    if (!m) return null;
    let h = +m[1];
    const mi = +m[2];
    const ap = (m[3] || '').toLowerCase();
    if (ap === 'a') { if (h === 12) h = 0; }
    else if (ap === 'p') { if (h < 12) h += 12; }
    if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) return null;
    return pad2(h) + ':' + pad2(mi);
  }

  // 'YYYY-MM-DD' | null. ISO is what Cronometer writes; US M/D/YYYY is
  // accepted because a spreadsheet round-trip often rewrites it that way.
  function parseDate(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    let y, mo, d, m;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(s))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(s))) { y = +m[3]; mo = +m[1]; d = +m[2]; }
    else return null;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return y + '-' + pad2(mo) + '-' + pad2(d);
  }

  // Whole days between two ISO dates. Built from local-midnight components
  // (never new Date('YYYY-MM-DD'), which is UTC midnight and lands on the
  // previous day west of Greenwich), and rounded so a DST boundary inside
  // the span cannot shift the answer by the odd hour.
  function dateToLocal(iso) {
    const p = String(iso).split('-').map(Number);
    if (p.length !== 3 || !p.every(isFinite)) return null;
    const d = new Date(p[0], p[1] - 1, p[2]);
    return isNaN(d.getTime()) ? null : d;
  }
  function daysBetween(fromIso, toIso) {
    const a = dateToLocal(fromIso), b = dateToLocal(toIso);
    if (!a || !b) return null;
    return Math.round((b - a) / 86400000);
  }

  // A rejection the UI can show verbatim. Thrown only when the file is not
  // the kind of file it was handed to — per-ROW trouble becomes a warning.
  function ImportError(message, detail) {
    const e = new Error(message);
    e.code = 'IMPORT_REJECTED';
    e.detail = detail || '';
    return e;
  }

  // Atwater factors, incl. the 7 kcal/g ethanol term.
  function atwaterKcal(e) {
    return 4 * (+e.carbs_g || 0) + 4 * (+e.protein_g || 0) +
           9 * (+e.fat_g || 0) + 7 * (+e.alcohol_g || 0);
  }

  // =======================================================================
  //  2 · Parsers
  // =======================================================================

  const SERVING_ALIASES = {
    date:    ['day', 'date'],
    time:    ['time'],
    group:   ['group', 'meal', 'category'],
    name:    ['food name', 'food', 'name'],
    amount:  ['amount', 'quantity', 'serving'],
    kcal:    ['energy', 'calories', 'kcal'],
    carbs:   ['carbs', 'carbohydrate', 'carbohydrates', 'total carbs'],
    protein: ['protein'],
    fat:     ['fat', 'total fat'],
    alcohol: ['alcohol', 'ethanol']
  };

  // Rows Cronometer (or a spreadsheet edit) appends below the data.
  const SUMMARY_RE = /^(totals?|daily totals?|summary|grand total|average|averages)\b/i;

  /**
   * Cronometer "Export Servings" CSV -> { entries, warnings, meta }.
   *
   * Throws ImportError when the required columns are absent, i.e. when the
   * file is not a servings export at all. Anything wrong with an individual
   * ROW is collected into `warnings` and the rest of the file still imports:
   * one bad cell in a 400-row export should not cost you the other 399.
   */
  function parseCronometer(csvText) {
    const rows = parseCSV(String(csvText == null ? '' : csvText));
    if (!rows.length) throw ImportError('That file is empty.');

    const headers = rows[0];
    const col = matchHeaders(headers, SERVING_ALIASES);

    const missing = [];
    if (!col.date) missing.push('Day');
    if (!col.name) missing.push('Food Name');
    if (!col.kcal && !col.carbs && !col.protein && !col.fat) missing.push('Energy (kcal) or any macro column');
    if (missing.length) {
      throw ImportError(
        'This does not look like a Cronometer servings export.',
        'Missing: ' + missing.join(', ') + '.\nColumns found: ' +
        headers.map(h => String(h).trim()).filter(Boolean).slice(0, 12).join(', ') +
        (headers.length > 12 ? ', …' : ''));
    }

    // Cronometer can emit kilojoules when the account is set to kJ. Detected
    // from the RAW header, since normalising strips the unit.
    const kJ = !!(col.kcal && /\bkj\b/i.test(col.kcal.raw));

    const entries = [], warnings = [];
    const cell = (row, c) => (c && row[c.idx] !== undefined ? String(row[c.idx]).trim() : '');

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const lineNo = r + 1;                       // 1-based, matching a spreadsheet
      const name = cell(row, col.name);
      const dateRaw = cell(row, col.date);

      // Skip quietly: a nameless row is a spacer, a summary row is a footer.
      // Neither is a defect worth reporting.
      if (!name) continue;
      if (SUMMARY_RE.test(name) || SUMMARY_RE.test(dateRaw)) continue;

      const date = parseDate(dateRaw);
      if (!date) {
        warnings.push({ row: lineNo, text: 'Row ' + lineNo + ' (' + name + '): could not read the date "' +
                        dateRaw + '" — row skipped.' });
        continue;
      }

      const bad = [];
      const numAt = (c, label) => {
        const n = toNumber(cell(row, c));
        if (!n.ok) bad.push(label);
        return n.v;
      };
      let kcal = numAt(col.kcal, 'Energy');
      if (kJ) kcal = kcal / 4.184;

      const entry = {
        kind: 'food',
        date: date,
        time: parseTime(cell(row, col.time)),
        mealSlot: cell(row, col.group) || null,
        name: name,
        amount: cell(row, col.amount),
        kcal: kcal,
        carbs_g: numAt(col.carbs, 'Carbs'),
        protein_g: numAt(col.protein, 'Protein'),
        fat_g: numAt(col.fat, 'Fat'),
        // Cronometer TRACKS alcohol, so an empty cell is a real zero, not an
        // unknown. Only a source without the column at all yields null.
        alcohol_g: col.alcohol ? numAt(col.alcohol, 'Alcohol') : null,
        sourceRow: lineNo
      };
      if (bad.length) {
        warnings.push({ row: lineNo, text: 'Row ' + lineNo + ' (' + name + '): ' + bad.join(', ') +
                        ' could not be read as numbers — counted as 0.' });
      }
      // A populated Time column that does not parse is worth saying out loud;
      // the entry still imports, it just falls back to its meal-slot default.
      if (!entry.time && cell(row, col.time)) {
        warnings.push({ row: lineNo, text: 'Row ' + lineNo + ' (' + name + '): could not read the time "' +
                        cell(row, col.time) + '" — using the meal-slot default.' });
      }
      entries.push(entry);
    }

    if (!entries.length) {
      throw ImportError('No food rows were found in that file.',
        'The header row matched, but every data row was blank, a summary line, or undated.');
    }
    return {
      entries: entries,
      warnings: warnings,
      meta: {
        source: 'Cronometer', kind: 'food',
        hasTimeColumn: !!col.time,
        hasAlcoholColumn: !!col.alcohol,
        energyUnit: kJ ? 'kJ' : 'kcal',
        columns: Object.keys(col).reduce((o, k) => { o[k] = col[k].raw; return o; }, {})
      }
    };
  }

  const EXERCISE_ALIASES = {
    date:    ['day', 'date'],
    time:    ['time', 'start'],
    name:    ['exercise', 'activity', 'name'],
    minutes: ['minutes', 'duration', 'mins'],
    kcal:    ['calories burned', 'energy', 'calories', 'kcal']
  };

  /** Cronometer "Export Exercises" CSV -> { entries, warnings, meta }. */
  function parseCronometerExercises(csvText) {
    const rows = parseCSV(String(csvText == null ? '' : csvText));
    if (!rows.length) throw ImportError('That file is empty.');

    const headers = rows[0];
    const col = matchHeaders(headers, EXERCISE_ALIASES);
    const missing = [];
    if (!col.date) missing.push('Day');
    if (!col.name) missing.push('Exercise');
    if (!col.minutes) missing.push('Minutes');
    if (missing.length) {
      throw ImportError(
        'This does not look like a Cronometer exercises export.',
        'Missing: ' + missing.join(', ') + '.\nColumns found: ' +
        headers.map(h => String(h).trim()).filter(Boolean).slice(0, 12).join(', '));
    }

    const entries = [], warnings = [];
    const cell = (row, c) => (c && row[c.idx] !== undefined ? String(row[c.idx]).trim() : '');

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r], lineNo = r + 1;
      const name = cell(row, col.name);
      const dateRaw = cell(row, col.date);
      if (!name) continue;
      if (SUMMARY_RE.test(name) || SUMMARY_RE.test(dateRaw)) continue;

      const date = parseDate(dateRaw);
      if (!date) {
        warnings.push({ row: lineNo, text: 'Row ' + lineNo + ' (' + name + '): could not read the date "' +
                        dateRaw + '" — row skipped.' });
        continue;
      }
      const mins = toNumber(cell(row, col.minutes));
      if (!mins.ok || mins.v <= 0) {
        warnings.push({ row: lineNo, text: 'Row ' + lineNo + ' (' + name + '): duration "' +
                        cell(row, col.minutes) + '" is not a positive number — row skipped.' });
        continue;
      }
      entries.push({
        kind: 'exercise',
        date: date,
        time: parseTime(cell(row, col.time)),
        name: name,
        minutes: mins.v,
        kcalBurned: toNumber(cell(row, col.kcal)).v,
        sourceRow: lineNo
      });
    }
    if (!entries.length) {
      throw ImportError('No exercise rows were found in that file.',
        'The header row matched, but every data row was blank, a summary line, or undated.');
    }
    return {
      entries: entries, warnings: warnings,
      meta: { source: 'Cronometer', kind: 'exercise', hasTimeColumn: !!col.time }
    };
  }

  // =======================================================================
  //  Parser registry — the extension point for the next source
  // =======================================================================
  // MyFitnessPal and FatSecret plug in HERE and nowhere else. A parser owns
  // exactly two things: recognising its own file, and turning it into
  // ImportedEntry[]. Everything after that is shared.
  //
  //   registerImportParser({
  //     id:     'myfitnesspal-nutrition',
  //     label:  'MyFitnessPal — Nutrition',
  //     source: 'MyFitnessPal',
  //     kind:   'food',
  //     detect: headers => 0..3,      // confidence; 0 = not mine
  //     parse:  text => ({ entries, warnings, meta })
  //   });
  //
  // Sources that do not report alcohol must emit alcohol_g: null rather than
  // 0, so the review screen can say "this source cannot see alcohol" instead
  // of asserting a zero it did not measure.
  const parsers = [];
  function registerImportParser(def) {
    if (!def || !def.id || typeof def.parse !== 'function')
      throw new Error('registerImportParser: need at least { id, parse }');
    const i = parsers.findIndex(p => p.id === def.id);
    const rec = {
      id: def.id, label: def.label || def.id, source: def.source || def.label || def.id,
      kind: def.kind || 'food', detect: def.detect || (() => 0), parse: def.parse
    };
    if (i >= 0) parsers[i] = rec; else parsers.push(rec);
    return rec;
  }
  function listImportParsers() { return parsers.slice(); }

  // Pick the parser whose detect() is most confident about this text.
  // Returns null when nothing recognises it, which the caller reports as a
  // clean rejection rather than guessing and producing nonsense.
  function detectParser(csvText) {
    let rows;
    try { rows = parseCSV(String(csvText == null ? '' : csvText)); } catch (e) { return null; }
    if (!rows.length) return null;
    const headers = rows[0];
    let best = null, bestScore = 0;
    for (const p of parsers) {
      let s = 0;
      try { s = +p.detect(headers, rows) || 0; } catch (e) { s = 0; }
      if (s > bestScore) { bestScore = s; best = p; }
    }
    return bestScore > 0 ? best : null;
  }

  // Detection reuses the same header matcher the parsers use, so a file that
  // detects as Cronometer is one the Cronometer parser can actually read.
  const has = (col, k) => !!col[k];
  registerImportParser({
    id: 'cronometer-servings', label: 'Cronometer — Servings', source: 'Cronometer',
    kind: 'food', parse: parseCronometer,
    detect: headers => {
      const col = matchHeaders(headers, SERVING_ALIASES);
      if (!has(col, 'date') || !has(col, 'name')) return 0;
      // "Food Name" + a group column is the servings-export signature. Score
      // above the exercises parser so a file carrying both cannot be taken
      // for an exercise log.
      let s = 1;
      if (has(col, 'kcal')) s++;
      if (has(col, 'group')) s++;
      if (has(col, 'carbs') || has(col, 'protein') || has(col, 'fat')) s++;
      // An exercise export also has Day + a name-ish column; Minutes is what
      // tells them apart, so stand down when it is present and macros are not.
      const ex = matchHeaders(headers, EXERCISE_ALIASES);
      if (has(ex, 'minutes') && !has(col, 'carbs') && !has(col, 'protein') && !has(col, 'fat')) return 0;
      return s;
    }
  });
  registerImportParser({
    id: 'cronometer-exercises', label: 'Cronometer — Exercises', source: 'Cronometer',
    kind: 'exercise', parse: parseCronometerExercises,
    detect: headers => {
      const col = matchHeaders(headers, EXERCISE_ALIASES);
      if (!has(col, 'date') || !has(col, 'name') || !has(col, 'minutes')) return 0;
      return has(col, 'kcal') ? 4 : 3;
    }
  });

  // =======================================================================
  //  3 · Shared mapper: ImportedEntry[] -> schedule events
  // =======================================================================

  const DEFAULT_TIMES = {
    breakfast: '07:30', lunch: '12:30', dinner: '18:30',
    snack: '15:00', snack2: '21:00', unknown: '12:00'
  };
  const DEFAULT_EXERCISE_START = '17:00';

  // Map a source's own group wording onto one of our slots. Users rename
  // Cronometer groups freely ("Post-workout", "Second Breakfast"), so this
  // matches on substrings and falls through to `unknown` rather than
  // guessing.
  function slotOf(group) {
    const g = String(group == null ? '' : group).toLowerCase();
    if (!g) return 'unknown';
    if (/breakfast/.test(g)) return 'breakfast';
    if (/lunch/.test(g)) return 'lunch';
    if (/dinner|supper|evening meal/.test(g)) return 'dinner';
    if (/snack/.test(g)) return 'snack';
    return 'unknown';
  }

  // Percentage disagreement between the logged kcal and what its macros
  // imply. Below KCAL_FLOOR the check is skipped: a 6 kcal stick of gum can
  // be 100% "off" and mean nothing, and a review screen full of those is a
  // review screen nobody reads.
  const KCAL_TOLERANCE = 0.15;
  const KCAL_FLOOR = 20;
  function kcalDiscrepancy(e) {
    const a = atwaterKcal(e), k = +e.kcal || 0;
    const scale = Math.max(a, k);
    if (scale < KCAL_FLOOR) return null;
    const rel = Math.abs(k - a) / scale;
    if (rel <= KCAL_TOLERANCE) return null;
    return { logged: k, computed: a, rel: rel };
  }

  /**
   * mapEntriesToSchedule(entries, options) -> plan
   *
   * options:
   *   startDate  'YYYY-MM-DD' | ''   Day 1 of the scenario. Empty means the
   *                                  earliest date in the import becomes
   *                                  Day 1 (reported as inferredDayOne).
   *   days       number              simulation length (default SIM_DAYS)
   *   merge      boolean             one event per group instead of per food
   *   defaultTimes {...}             overrides for DEFAULT_TIMES
   *   exercise   { defaultStart, map: { name: {type, intensity} } }
   *
   * plan:
   *   planned  [{ ev, date, sources[], explicitTime, flags[] }]
   *   skipped  [{ name, date, day, reason }]
   *   warnings [string]              file-level notes
   *   dayOne, inferredDayOne, unclassified[]
   *
   * NOTE ON DATES: the plan is the ONLY place a calendar date is consulted.
   * What comes out the far side is keyed by day NUMBER alone, which is what
   * keeps a scenario behaving identically with or without a Day 1 date set.
   */
  function mapEntriesToSchedule(entries, options) {
    const o = options || {};
    const days = +o.days || window.SIM_DAYS || 5;
    const times = Object.assign({}, DEFAULT_TIMES, o.defaultTimes || {});
    const exOpt = Object.assign({ defaultStart: DEFAULT_EXERCISE_START, map: {} }, o.exercise || {});
    const list = (entries || []).filter(Boolean);

    const planned = [], skipped = [], warnings = [], unclassified = [];

    // ---- Day 1 -----------------------------------------------------------
    let dayOne = parseDate(o.startDate || '');
    const inferredDayOne = !dayOne;
    if (!dayOne) {
      const dated = list.map(e => e.date).filter(Boolean).sort();
      if (!dated.length) return { planned, skipped, warnings: ['No usable dates in that file.'],
                                  dayOne: null, inferredDayOne: false, unclassified };
      dayOne = dated[0];
    }

    // ---- snack slots -----------------------------------------------------
    // "Snacks 15:00, a second snack the same day 21:00". Occurrence is keyed
    // off the source's own group LABEL, so "Snacks" and "Evening Snack" on
    // one day are two occurrences while five foods inside "Snacks" stay one.
    const snackOrder = {};                       // day -> [label, …]
    function snackIndex(day, label) {
      const k = String(day);
      const seen = snackOrder[k] || (snackOrder[k] = []);
      const lbl = String(label || '').toLowerCase();
      let i = seen.indexOf(lbl);
      if (i < 0) { seen.push(lbl); i = seen.length - 1; }
      return i;
    }

    // Pre-compute each entry's day so snack ordering follows the source's
    // own row order within a day.
    const withDay = [];
    for (const e of list) {
      const delta = e.date ? daysBetween(dayOne, e.date) : null;
      withDay.push({ e: e, day: delta === null ? null : delta + 1 });
    }

    for (const rec of withDay) {
      const e = rec.e, day = rec.day;
      const label = e.name || (e.kind === 'exercise' ? 'Exercise' : 'Food');

      if (day === null) { skipped.push({ name: label, date: e.date || '—', day: null,
                                         reason: 'no readable date' }); continue; }
      if (day < 1 || day > days) {
        skipped.push({ name: label, date: e.date, day: day,
                       reason: day < 1 ? 'falls before Day 1' : 'falls beyond Day ' + days });
        continue;
      }

      // ---- exercise ------------------------------------------------------
      if (e.kind === 'exercise') {
        const cls = exOpt.map[e.name];
        if (!cls || !cls.type) {
          if (unclassified.indexOf(e.name) < 0) unclassified.push(e.name);
          continue;                              // held back until classified
        }
        const type = cls.type === 'resistance' ? 'resistance' : 'aerobic';
        const allowed = type === 'resistance' ? ['light', 'moderate', 'hard']
                                              : ['light', 'moderate', 'vigorous'];
        let intensity = String(cls.intensity || 'moderate').toLowerCase();
        // The two vocabularies differ by one word at the top end; translate
        // rather than silently dropping to moderate.
        if (type === 'resistance' && intensity === 'vigorous') intensity = 'hard';
        if (type === 'aerobic' && intensity === 'hard') intensity = 'vigorous';
        if (allowed.indexOf(intensity) < 0) intensity = 'moderate';

        const flags = [];
        if (e.kcalBurned > 0) {
          flags.push({ level: 'info', text: 'Cronometer logged ' + Math.round(e.kcalBurned) +
            ' kcal burned. The simulator ignores that figure and computes its own cost from ' +
            'duration and intensity, so the two will not agree.' });
        }
        planned.push({
          ev: { type: type, day: day, start: e.time || exOpt.defaultStart,
                duration: Math.max(1, Math.round(e.minutes)), intensity: intensity },
          date: e.date, sources: [e.name], explicitTime: !!e.time, flags: flags
        });
        continue;
      }

      // ---- food ----------------------------------------------------------
      const slot = slotOf(e.mealSlot);
      let time = e.time;
      if (!time) {
        if (slot === 'snack') {
          const i = snackIndex(day, e.mealSlot);
          time = i === 0 ? times.snack : times.snack2;
        } else time = times[slot] || times.unknown;
      }
      const flags = [];
      if (slot === 'unknown' && !e.time) {
        flags.push({ level: 'warn', text: 'No meal group and no time' +
          (e.mealSlot ? ' — "' + e.mealSlot + '" is not a group I recognise' : '') +
          ', so it was placed at ' + times.unknown + '. Adjust it if that is wrong.' });
      }
      const disc = kcalDiscrepancy(e);
      if (disc) {
        flags.push({ level: 'warn', text: 'Logged ' + Math.round(disc.logged) +
          ' kcal but its macros come to ' + Math.round(disc.computed) + ' kcal (' +
          Math.round(disc.rel * 100) + '% apart).' +
          (disc.logged === 0 ? ' A zero-calorie entry with macros is usually an incomplete food record.' : '') });
      }
      planned.push({
        ev: { type: 'meal', day: day, time: time, name: e.name,
              kcal: round2(e.kcal), carbs: round2(e.carbs_g), protein: round2(e.protein_g),
              fat: round2(e.fat_g), alcohol: round2(e.alcohol_g || 0) },
        date: e.date, sources: [e.name], explicitTime: !!e.time,
        slot: slot, group: e.mealSlot || '', amount: e.amount || '', flags: flags
      });
    }

    // ---- merge -----------------------------------------------------------
    // Collapses to one meal per (day, group). Macros sum; the time is the
    // earliest EXPLICIT time in the group if the source had any, otherwise
    // the slot default. Flags follow their food across the merge so a bad
    // row is still visible after its name is gone.
    let out = planned;
    if (o.merge) {
      const groups = new Map();
      const others = [];
      for (const p of planned) {
        if (p.ev.type !== 'meal') { others.push(p); continue; }
        const key = p.ev.day + '|' + (p.group || p.slot || 'unknown').toLowerCase();
        if (!groups.has(key)) {
          groups.set(key, { ev: Object.assign({}, p.ev, { name: p.group || titleCase(p.slot) }),
                            date: p.date, sources: [], explicitTime: p.explicitTime,
                            slot: p.slot, group: p.group, flags: [] });
          const g = groups.get(key);
          g.ev.kcal = 0; g.ev.carbs = 0; g.ev.protein = 0; g.ev.fat = 0; g.ev.alcohol = 0;
          g.earliest = null;
        }
        const g = groups.get(key);
        g.ev.kcal += p.ev.kcal; g.ev.carbs += p.ev.carbs; g.ev.protein += p.ev.protein;
        g.ev.fat += p.ev.fat; g.ev.alcohol += p.ev.alcohol;
        g.sources.push(p.ev.name);
        if (p.explicitTime && (!g.earliest || p.ev.time < g.earliest)) g.earliest = p.ev.time;
        for (const f of p.flags) g.flags.push({ level: f.level, text: p.ev.name + ': ' + f.text });
      }
      const merged = [];
      groups.forEach(g => {
        if (g.earliest) { g.ev.time = g.earliest; g.explicitTime = true; }
        ['kcal', 'carbs', 'protein', 'fat', 'alcohol'].forEach(k => { g.ev[k] = round2(g.ev[k]); });
        delete g.earliest;
        merged.push(g);
      });
      out = merged.concat(others);
    }

    out.sort((a, b) => (a.ev.day - b.ev.day) ||
      (hhmm(a.ev.time || a.ev.start) - hhmm(b.ev.time || b.ev.start)));

    if (inferredDayOne) {
      warnings.push('No Day 1 date was set, so the earliest date in this file (' + dayOne +
        ') is being treated as Day 1.');
    }
    if (unclassified.length) {
      warnings.push(unclassified.length + ' exercise type' + (unclassified.length !== 1 ? 's' : '') +
        ' still need classifying before they can be imported.');
    }
    return { planned: out, skipped: skipped, warnings: warnings,
             dayOne: dayOne, inferredDayOne: inferredDayOne, unclassified: unclassified };
  }

  function round2(n) { const v = +n || 0; return Math.round(v * 100) / 100; }
  function titleCase(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
  function hhmm(t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '00:00'));
    return m ? +m[1] * 60 + +m[2] : 0;
  }

  // Per-day macro totals for the review screen.
  function summarise(planned) {
    const byDay = {};
    for (const p of planned) {
      const d = byDay[p.ev.day] || (byDay[p.ev.day] = { day: p.ev.day, meals: 0, exercises: 0,
        kcal: 0, carbs: 0, protein: 0, fat: 0, alcohol: 0, minutes: 0 });
      if (p.ev.type === 'meal') {
        d.meals++; d.kcal += p.ev.kcal; d.carbs += p.ev.carbs;
        d.protein += p.ev.protein; d.fat += p.ev.fat; d.alcohol += p.ev.alcohol;
      } else { d.exercises++; d.minutes += +p.ev.duration || 0; }
    }
    return Object.keys(byDay).map(Number).sort((a, b) => a - b).map(k => byDay[k]);
  }

  window.foodImport = {
    // plumbing
    parseCSV: parseCSV, normHeader: normHeader, matchHeaders: matchHeaders,
    toNumber: toNumber, parseTime: parseTime, parseDate: parseDate, daysBetween: daysBetween,
    // parsers
    parseCronometer: parseCronometer, parseCronometerExercises: parseCronometerExercises,
    // registry (extension point for MyFitnessPal / FatSecret)
    registerImportParser: registerImportParser, listImportParsers: listImportParsers,
    detectParser: detectParser,
    // mapper
    mapEntriesToSchedule: mapEntriesToSchedule, summarise: summarise,
    slotOf: slotOf, atwaterKcal: atwaterKcal, kcalDiscrepancy: kcalDiscrepancy,
    DEFAULT_TIMES: DEFAULT_TIMES, DEFAULT_EXERCISE_START: DEFAULT_EXERCISE_START,
    KCAL_TOLERANCE: KCAL_TOLERANCE, KCAL_FLOOR: KCAL_FLOOR
  };
})();
