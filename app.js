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
   app.js — UI wiring, schedule builder, status panel (Section 6)
   ========================================================================= */
(function () {
  'use strict';

  let schedule = JSON.parse(JSON.stringify(window.DEFAULT_SCHEDULE));
  let simData = null;
  let playTimer = null;
  let carryOverState = null;   // when set, the next run continues from this body state
  let carryOverCarryIn = null; // real trailing events from the previous block
  let carryOverLabel = '';     // human name of where the carry-over came from
  // A cosmetic label for Day 1 so different scenarios can be told apart. It is
  // deliberately NEVER passed to runSimulation — every calculation is keyed off
  // the Day number alone, so a scenario behaves identically with or without it.
  let startDate = '';
  const STEPS = window.SIM_STEPS || 288;

  const $ = id => document.getElementById(id);

  // ---- profile read / derived constants ---------------------------------
  // The numeric fields are type="text" + inputmode="decimal", so their value can
  // be anything the user typed — including "" mid-edit or plain nonsense. A
  // non-finite number reaching the integrator would produce NaN curves that
  // render fine and mean nothing, so every read goes through here.
  // The comma swap covers keyboards that emit a decimal comma.
  function numField(id, fallback, lo, hi) {
    const el = $(id);
    const v = parseFloat(String(el ? el.value : '').replace(',', '.'));
    if (!isFinite(v)) return fallback;
    if (lo !== undefined && v < lo) return lo;
    if (hi !== undefined && v > hi) return hi;
    return v;
  }
  // Shared with parseScenario's import checks so a typed value and an imported
  // one are held to the same range — otherwise a file could display one weight
  // and silently simulate another.
  const PROFILE_RANGES = { weight: [20, 400], height: [80, 260], age: [5, 120] };
  function readProfile() {
    return {
      weight: numField('pWeight', 80, PROFILE_RANGES.weight[0], PROFILE_RANGES.weight[1]),
      height: numField('pHeight', 175, PROFILE_RANGES.height[0], PROFILE_RANGES.height[1]),
      age: numField('pAge', 35, PROFILE_RANGES.age[0], PROFILE_RANGES.age[1]),
      sex: $('pSex').value, training: $('pTraining').value
    };
  }
  function showDerived() {
    const C = window.computeConstants(readProfile());
    $('derived').innerHTML =
      `<div><span>BMR</span><b>${Math.round(C.BMR)} kcal/day</b></div>` +
      `<div><span>Liver glycogen max</span><b>${C.LIVER_GLYCOGEN_MAX} g</b></div>` +
      `<div><span>Muscle glycogen max</span><b>${Math.round(C.MUSCLE_GLYCOGEN_MAX)} g</b></div>` +
      `<div><span>Fat-ox capacity</span><b>${C.FAT_OXIDATION_CAPACITY.toFixed(2)} g/min</b></div>`;
  }

  // Calendar date for a 1-based day number, or '' when no Day 1 date is set.
  // Parsed component-wise: new Date('2026-08-04') is UTC midnight and would show
  // the previous day west of Greenwich.
  function dayDate(n) {
    if (!startDate) return '';
    const p = String(startDate).split('-').map(Number);
    if (p.length !== 3 || !p.every(isFinite)) return '';
    const d = new Date(p[0], p[1] - 1, p[2] + (n - 1));
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  // ---- schedule list rendering ------------------------------------------
  const DAYS = window.SIM_DAYS || 5;
  function evLabel(ev) {
    if (ev.type === 'meal')
      return `🍽 <b>${ev.name}</b> ${ev.time} — ${ev.kcal} kcal · C${ev.carbs} P${ev.protein} F${ev.fat}${ev.alcohol ? ' A' + ev.alcohol : ''}`;
    if (ev.type === 'aerobic')
      return `🏃 <b>Aerobic</b> ${ev.start} · ${ev.duration} min · ${ev.intensity}`;
    if (ev.type === 'resistance')
      return `🏋 <b>Resistance</b> ${ev.start} · ${ev.duration} min · ${ev.intensity}`;
    if (ev.type === 'sleep')
      return `😴 <b>Sleep</b> ${ev.start} → ${ev.end}`;
  }
  function sortKey(ev) { return window.simUtil.hhmmToMin(ev.time || ev.start); }

  // Group the schedule by day, one panel per day.
  function renderList() {
    const byDay = {};
    schedule.forEach((ev, idx) => { (byDay[+ev.day || 1] = byDay[+ev.day || 1] || []).push({ ev, idx }); });
    let html = '';
    for (let d = 1; d <= DAYS; d++) {
      const items = (byDay[d] || []).sort((a, b) => sortKey(a.ev) - sortKey(b.ev));
      const dd = dayDate(d);
      html += `<div class="day-group"><div class="day-head">Day ${d}` +
              (dd ? ` <span class="day-date">· ${dd}</span>` : '') + `</div>`;
      html += items.length
        ? items.map(({ ev, idx }) =>
            `<div class="event ${ev.type}"><span>${evLabel(ev)}</span>` +
            `<button class="del" data-del="${idx}" title="remove">✕</button></div>`).join('')
        : '<div class="event-empty muted">— no events —</div>';
      html += '</div>';
    }
    $('eventList').innerHTML = html;
    $('eventList').querySelectorAll('[data-del]').forEach(b =>
      b.onclick = () => { schedule.splice(+b.dataset.del, 1); renderList(); saveWorking(); });
  }

  // Populate every "Day" dropdown with "All days" + Day 1..DAYS
  function fillDaySelects() {
    const opts = '<option value="all">All days</option>' +
      Array.from({ length: DAYS }, (_, i) => `<option value="${i + 1}">Day ${i + 1}</option>`).join('');
    ['mDay', 'aDay', 'rDay', 'sDay'].forEach(id => { if ($(id)) $(id).innerHTML = opts; });
  }

  // ---- add-event handlers -----------------------------------------------
  // Build the event (without day), then push one copy per chosen day. "All days"
  // expands to concrete per-day events so each stays individually editable.
  function daysFrom(sel) {
    const v = $(sel).value;
    return v === 'all' ? Array.from({ length: DAYS }, (_, i) => i + 1) : [+v];
  }
  function wireAdders() {
    document.querySelectorAll('[data-add]').forEach(btn => {
      btn.onclick = () => {
        const t = btn.dataset.add;
        let base, daySel;
        if (t === 'meal') { daySel = 'mDay'; base = { type: 'meal', name: $('mName').value || 'Meal', time: $('mTime').value,
          kcal: numField('mKcal', 0, 0), carbs: numField('mCarb', 0, 0), protein: numField('mProt', 0, 0),
          fat: numField('mFat', 0, 0), alcohol: numField('mAlc', 0, 0) }; }
        else if (t === 'aerobic') { daySel = 'aDay'; base = { type: 'aerobic', start: $('aStart').value, duration: numField('aDur', 30, 1), intensity: $('aInt').value }; }
        else if (t === 'resistance') { daySel = 'rDay'; base = { type: 'resistance', start: $('rStart').value, duration: numField('rDur', 45, 1), intensity: $('rInt').value }; }
        else if (t === 'sleep') { daySel = 'sDay'; base = { type: 'sleep', start: $('sStart').value, end: $('sEnd').value }; }
        for (const day of daysFrom(daySel)) schedule.push(Object.assign({ day }, base));
        renderList(); saveWorking();
      };
    });
  }

  // ---- run --------------------------------------------------------------
  function run() {
    simData = window.runSimulation(readProfile(), schedule, carryOverState, carryOverCarryIn);
    window.renderCharts(simData);
    setNow(+$('nowSlider').value);
    updateContinueBanner();
  }
  function updateContinueBanner() {
    const el = $('continueBanner');
    if (!el) return;
    if (carryOverState) {
      const src = carryOverLabel ? ' from <b>' + esc(carryOverLabel) + '</b>' : '';
      el.innerHTML = '<span>▶ Starting state carried over' + src +
        ' — glycogen, amino acids and body fat begin where that run ended.</span>' +
        '<button id="clearCarryBtn" class="mini" title="Discard the carried-over state and start this schedule from a rested, fully-fuelled body. Your schedule is not touched.">Start fresh instead</button>';
      el.style.display = '';
      const b = $('clearCarryBtn');
      if (b) b.onclick = clearStartState;
    } else { el.style.display = 'none'; }
  }
  // Drop the carry-over without disturbing the schedule, profile or date. Before
  // this existed the only way out was Reset to example, which wiped the schedule.
  function clearStartState() {
    carryOverState = null; carryOverCarryIn = null; carryOverLabel = '';
    if ($('scenContinue')) $('scenContinue').checked = false;
    startStateStatus('Cleared — this schedule now starts from a rested, fully-fuelled body.');
    run(); flushWorking();
  }
  function startStateStatus(msg) { const el = $('startStateStatus'); if (el) el.textContent = msg || ''; }

  // ---- bottom tab navigation (narrow screens only) -----------------------
  const TABS = ['tabEvents', 'tabOutput', 'tabFiles'];
  let activeTab = TABS[0];
  const tabsActive = () => window.matchMedia && window.matchMedia('(max-width: 980px)').matches;

  function setTab(id) {
    if (TABS.indexOf(id) < 0) id = TABS[0];
    activeTab = id;
    // Two panels share the .inputs wrapper, so decide each wrapper once rather
    // than toggling per panel — otherwise the inactive sibling clears the flag.
    const wrappers = [];
    TABS.forEach(t => {
      const panel = $(t);
      if (!panel) return;
      panel.classList.toggle('is-active', t === id);
      const btn = $('tabBtn' + t.slice(3));
      if (btn) btn.setAttribute('aria-selected', t === id ? 'true' : 'false');
      if (panel.parentElement && wrappers.indexOf(panel.parentElement) < 0) wrappers.push(panel.parentElement);
    });
    const activePanel = $(id);
    wrappers.forEach(w => w.classList.toggle('has-active', !!activePanel && w === activePanel.parentElement));
    // Re-measure only once the panel is laid out, or the charts stay zero-width.
    if (id === 'tabOutput' && window.resizeCharts) {
      window.resizeCharts();
      if (simData) window.updateNowLine(+$('nowSlider').value);
    }
    saveWorking();
  }

  // Only fields that actually raise a keyboard count; selects and sliders do not.
  const KB_TYPES = ['text', 'number', 'time', 'email', 'tel', 'url', 'search', 'password'];
  const opensKeyboard = el => !!el && (el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' && KB_TYPES.indexOf(String(el.type).toLowerCase()) >= 0));

  // Derived from whatever is focused right now rather than from paired
  // focusin/focusout events. Removing a focused element — or hiding one with
  // display:none — moves focus to <body> without firing focusout, so a paired
  // implementation strands the bar hidden with nothing left to restore it.
  // execCopy() and hideScenText() both do exactly that.
  function syncKeyboardState() {
    const bar = $('tabBar');
    if (bar) bar.classList.toggle('kb-hidden', opensKeyboard(document.activeElement));
  }

  function wireTabs() {
    document.querySelectorAll('#tabBar .tab-btn').forEach(b =>
      b.onclick = () => setTab(b.dataset.tab));
    document.addEventListener('focusin', syncKeyboardState);
    // During focusout activeElement has not moved yet, so re-read after the task.
    document.addEventListener('focusout', () => setTimeout(syncKeyboardState, 0));
  }

  // ---- now cursor / status ----------------------------------------------
  function setNow(idx) {
    idx = Math.max(0, Math.min(STEPS - 1, idx));
    $('nowSlider').value = idx;
    if (!simData) return;
    const d = simData[idx];
    const dd = dayDate((d.dayIndex || 0) + 1);
    $('nowLabel').textContent = d.timeLabel + (dd ? '  ·  ' + dd : '');
    window.updateNowLine(idx);
    renderStatus(d);
  }

  function pctBadge(status) {
    return `<span class="badge ${status.split(' ')[0].toLowerCase()}">${status}</span>`;
  }

  function renderStatus(d) {
    const C = simData.constants;
    const fuelPct = (d.fractions[fuelKey(d.dominantFuel)] * 100).toFixed(0);
    const liverPct = Math.round(d.liverGlycogen / C.LIVER_GLYCOGEN_MAX * 100);
    const musclePct = Math.round(d.muscleGlycogen / C.MUSCLE_GLYCOGEN_MAX * 100);
    const bal = d.cumConsumed - d.cumExpended;

    let html = `<div class="status-head">Status @ <b>${d.timeLabel}</b> — ${d.activity}${d.intensity ? ' (' + d.intensity + ')' : ''}</div>`;
    html += '<div class="status-grid">';
    html += cell('Metabolic phase', d.phase);
    html += cell('Dominant fuel', `${d.dominantFuel} (${fuelPct}%)`);
    html += cell('Insulin index', d.insulin.toFixed(2) + ' / 10 · glucose ' + d.glucoseState);
    html += cell('Liver glycogen', `${d.liverGlycogen.toFixed(0)} g (${liverPct}%) · ${pctBadge(d.liverStatus)}`);
    html += cell('Muscle glycogen', `${d.muscleGlycogen.toFixed(0)} g (${musclePct}%) · ${pctBadge(d.muscleStatus)}`);
    html += cell('MPS status', `${d.mpsStatus} · ${d.mpsRate.toFixed(3)} g/min`);
    html += cell('Amino-acid pool', d.aminoPool.toFixed(1) + ' g');
    html += cell('Gluconeogenesis', `${d.gngRate.toFixed(3)} g/min${d.gngKcal > 0.01 ? ' · fueling blood glucose' : ''}`);
    html += cell('Fasting', `${d.hoursFasted.toFixed(1)} h since last meal`);
    html += cell('Energy demand', d.demandKcal.toFixed(1) + ' kcal / 5 min');
    html += cell('Calorie balance', (bal >= 0 ? '+' : '') + Math.round(bal) + ' kcal');
    html += cell('Glucose surplus (today)', `${d.daySurplusGlucose.toFixed(0)} g${d.daySurplusGlucose > 150 ? ' · lipogenesis likely' : ''}`);
    const dlt = d.fatDelta;
    html += cell('Body-fat store', `${(d.fatStored_g / 1000).toFixed(2)} kg · Δ ${dlt >= 0 ? '+' : '−'}${Math.abs(dlt).toFixed(0)} g this run`);
    // Gated on the very same flag that drove the suppression, so the number,
    // the flag and the metabolic effect can never disagree.
    if (d.alcoholActive) html += cell('Alcohol in system', d.alcoholDuringStep.toFixed(2) + ' g');
    if (d.bac > 0) {
      const over = d.bac >= (window.BAC_LEGAL_US || 0.08);
      html += `<div class="scell${over ? ' bac-over' : ''}"><span>Blood alcohol (est.)</span>` +
              `<b>${d.bac.toFixed(3)} g/dL</b></div>`;
      html += cell('Impairment', bacLabel(d.bac));
      html += cell('Clears at', clockIn(d, d.bacToZeroMin));
      if (d.bacToLegalMin > 0) html += cell('Under 0.08 at', clockIn(d, d.bacToLegalMin));
    }
    html += '</div>';

    // Everything shown here is a statement about THIS timestep. The leucine
    // warning used to be appended separately from simData.leucineMet — a
    // whole-run verdict — so one missed session showed on all 1,440 steps and
    // could sit directly beneath the per-step "protein timing is well-matched"
    // flag. It is now one of d.flags, attributed to the governing session.
    if (d.flags.length) {
      html += '<div class="flags">' + d.flags.map(f => `<div class="flag">⚑ ${f}</div>`).join('') + '</div>';
    }
    $('statusPanel').innerHTML = html;
  }
  function cell(k, v) { return `<div class="scell"><span>${k}</span><b>${v}</b></div>`; }

  // ---- BAC wording ------------------------------------------------------
  function bacLabel(b) {
    if (b <= 0)    return 'No alcohol detected';
    if (b < 0.02)  return 'Trace — below perceptible effects for most people';
    if (b < 0.05)  return 'Mild — subtle relaxation, minimal impairment';
    if (b < 0.08)  return 'Moderate — judgment and reaction time affected; do not drive in many jurisdictions';
    if (b < 0.10)  return 'Impaired — at or above US legal driving limit';
    if (b < 0.15)  return 'Clearly impaired — do not drive';
    if (b < 0.20)  return 'Significantly impaired — coordination substantially reduced';
    return 'Severely impaired — medical risk';
  }
  // "1 hr 25 min (≈ D2 03:15)" — both the interval and the clock time it lands on.
  function clockIn(d, mins) {
    const total = Math.round(mins);                 // whole minutes, or the
    const h = Math.floor(total / 60), m = total % 60;   // clock label goes fractional
    const span = (h ? h + ' hr ' : '') + m + ' min';
    return span + ' (≈ ' + window.simUtil.stampLabel(d.minute + total) + ')';
  }
  function fuelKey(name) {
    return { 'Gut glucose': 'gutGlucose', 'Liver glycogen': 'liver', 'Muscle glycogen': 'muscle',
             'Adipose fat': 'adipose', 'Dietary fat': 'gutFat', 'Gluconeogenesis': 'gng',
             'Alcohol': 'alcohol', 'Fat': 'adipose' }[name] || 'adipose';
  }

  // ---- play animation ----------------------------------------------------
  function togglePlay() {
    if (playTimer) { clearInterval(playTimer); playTimer = null; $('playBtn').textContent = '▶ Play'; return; }
    $('playBtn').textContent = '⏸ Pause';
    playTimer = setInterval(() => {
      let n = (+$('nowSlider').value + 1) % STEPS;
      setNow(n);
    }, 40);
  }

  // ---- scenarios (save/load profile + schedule) -------------------------
  const STORE_KEY = 'metabolismSim.scenarios.v1';
  function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function loadStore() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { return {}; } }
  function saveStore(o) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(o)); return true; }
    catch (e) { alert('Browser storage is unavailable, so in-app saving won\'t work here. Use "Export file…" instead to save a scenario to disk.'); return false; }
  }
  // ---- scenario file format, schema v1 ----------------------------------
  // Stores INPUTS ONLY (profile, schedule, settings) plus the carried-in state.
  // The trajectory is never serialized — it regenerates, so files stay small
  // and survive model changes.
  const SCHEMA_VERSION = 2;
  const APP_ID = 'metabolism-simulator';                  // shared by both editions
  const LEGACY_APP_IDS = ['metabolism-sim', 'metabolism-edu'];   // pre-v1 exports
  const STATE_FIELDS = ['liver', 'muscle', 'aminoPool', 'insulin', 'alcoholInSystem', 'fatStored_g'];
  const TRAININGS = ['sedentary', 'recreational', 'trained', 'athlete'];
  const EVENT_TYPES = ['meal', 'aerobic', 'resistance', 'sleep'];
  const INTENSITIES = { aerobic: ['light', 'moderate', 'vigorous'], resistance: ['light', 'moderate', 'hard'] };

  const isNum = v => typeof v === 'number' && isFinite(v);
  const isHHMM = v => typeof v === 'string' && /^\d{1,2}:\d{2}$/.test(v);
  const show = v => JSON.stringify(v === undefined ? null : v);

  function currentSnapshot(name) {
    return {
      schemaVersion: SCHEMA_VERSION,
      app: APP_ID,
      name: name || ($('scenName').value || '').trim() || 'scenario',
      created: new Date().toISOString(),
      profile: readProfile(),
      settings: {},
      startDate: startDate || null,        // label only; no calculation reads it
      schedule: JSON.parse(JSON.stringify(schedule)),
      // Where this run ENDED, plus the trailing events that let the next block
      // reproduce its history. These are what a continuation starts FROM.
      endState: (simData && simData.endState) ? simData.endState : null,
      carryInEvents: (simData && simData.carryIn) ? simData.carryIn : null,
      // Where this run BEGAN — null for a fresh run. Recorded so a chain can be
      // audited after the fact: block B's startedFrom should equal block A's
      // endState. (v1 files stored only the end state, under the misleading
      // name "initialState", so a continuation could not be checked later.)
      startedFrom: carryOverState || null,
      startedFromCarryIn: carryOverCarryIn || null
    };
  }

  // Validate a raw parsed object and return a normalized scenario.
  // Throws Error with a readable, specific message. Never partially applies:
  // callers only touch app state after this returns successfully.
  function parseScenario(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('That file does not contain a scenario object.');

    // --- identity gate (checked first, so a foreign file fails fast) -----
    const gate = [];
    if (raw.app === undefined) gate.push('it has no "app" field, so it may not be a scenario file');
    else if (raw.app !== APP_ID && LEGACY_APP_IDS.indexOf(raw.app) < 0)
      gate.push('it was written by a different program (app = ' + show(raw.app) + ')');
    const ver = raw.schemaVersion === undefined ? 0 : raw.schemaVersion;
    if (!(isNum(ver) && Math.floor(ver) === ver && ver >= 0))
      gate.push('"schemaVersion" must be a whole number (got ' + show(raw.schemaVersion) + ')');
    else if (ver > SCHEMA_VERSION)
      gate.push('it uses format version ' + ver + ', but this build only understands up to ' +
                SCHEMA_VERSION + ' — update the app to open it');
    if (gate.length) throw new Error('Cannot open this scenario: ' + gate.join('; ') + '.');

    const bad = [];

    // --- profile ---------------------------------------------------------
    const p = raw.profile;
    if (!p || typeof p !== 'object') bad.push('"profile" is missing');
    else {
      Object.keys(PROFILE_RANGES).forEach(k => {
        const lo = PROFILE_RANGES[k][0], hi = PROFILE_RANGES[k][1];
        if (!isNum(p[k])) bad.push('profile.' + k + ' must be a finite number (got ' + show(p[k]) + ')');
        else if (p[k] < lo || p[k] > hi) bad.push('profile.' + k + ' = ' + p[k] + ' is outside the plausible range ' + lo + '–' + hi);
      });
      if (p.sex !== 'male' && p.sex !== 'female') bad.push('profile.sex must be "male" or "female" (got ' + show(p.sex) + ')');
      if (TRAININGS.indexOf(p.training) < 0) bad.push('profile.training must be one of ' + TRAININGS.join(' / ') + ' (got ' + show(p.training) + ')');
    }

    // --- schedule --------------------------------------------------------
    if (!Array.isArray(raw.schedule)) bad.push('"schedule" is missing or is not a list of events');
    else raw.schedule.forEach((ev, i) => {
      const at = 'schedule[' + i + ']';
      if (!ev || typeof ev !== 'object') { bad.push(at + ' is not an event object'); return; }
      if (EVENT_TYPES.indexOf(ev.type) < 0) { bad.push(at + '.type must be one of ' + EVENT_TYPES.join(' / ') + ' (got ' + show(ev.type) + ')'); return; }
      if (ev.day !== undefined && !(isNum(ev.day) && ev.day >= 1)) bad.push(at + '.day must be a positive number (got ' + show(ev.day) + ')');
      if (ev.type === 'meal') {
        if (!isHHMM(ev.time)) bad.push(at + '.time must be "HH:MM" (got ' + show(ev.time) + ')');
        ['kcal', 'carbs', 'protein', 'fat', 'alcohol'].forEach(k => {
          if (ev[k] !== undefined && !isNum(ev[k])) bad.push(at + '.' + k + ' must be a finite number (got ' + show(ev[k]) + ')');
        });
      } else if (ev.type === 'sleep') {
        if (!isHHMM(ev.start)) bad.push(at + '.start must be "HH:MM" (got ' + show(ev.start) + ')');
        if (!isHHMM(ev.end)) bad.push(at + '.end must be "HH:MM" (got ' + show(ev.end) + ')');
      } else {
        if (!isHHMM(ev.start)) bad.push(at + '.start must be "HH:MM" (got ' + show(ev.start) + ')');
        if (!(isNum(ev.duration) && ev.duration > 0)) bad.push(at + '.duration must be a positive number of minutes (got ' + show(ev.duration) + ')');
        if (INTENSITIES[ev.type].indexOf(ev.intensity) < 0)
          bad.push(at + '.intensity must be one of ' + INTENSITIES[ev.type].join(' / ') + ' (got ' + show(ev.intensity) + ')');
      }
    });

    // --- initial state (optional, but must be COMPLETE if present) -------
    // A missing field arriving as undefined would become NaN inside the
    // integrator and silently produce curves that render fine and mean nothing.
    // v2 calls it endState; v1 called the same thing initialState; the original
    // pre-schema export also used endState. Prefer the correctly-named one.
    const rawState = raw.endState !== undefined ? raw.endState : raw.initialState;
    let endState = null;
    if (rawState !== undefined && rawState !== null) {
      if (typeof rawState !== 'object' || Array.isArray(rawState)) bad.push('"endState" must be an object');
      else {
        endState = {};
        STATE_FIELDS.forEach(k => {
          if (!isNum(rawState[k])) bad.push('endState.' + k + ' must be a finite number (got ' + show(rawState[k]) + ') — an incomplete state would produce meaningless results');
          else endState[k] = rawState[k];
        });
      }
    }

    // --- carry-in event lists (optional) ---------------------------------
    function checkCarryIn(list, field) {
      if (list === undefined || list === null) return null;
      if (!Array.isArray(list)) { bad.push('"' + field + '" must be a list'); return null; }
      const out = [];
      list.forEach((ev, i) => {
        const at = field + '[' + i + ']';
        if (!ev || typeof ev !== 'object') { bad.push(at + ' is not an event object'); return; }
        if (EVENT_TYPES.indexOf(ev.type) < 0) { bad.push(at + '.type must be one of ' + EVENT_TYPES.join(' / ') + ' (got ' + show(ev.type) + ')'); return; }
        if (!(isNum(ev.minutesBefore) && ev.minutesBefore >= 0)) bad.push(at + '.minutesBefore must be a number >= 0 (got ' + show(ev.minutesBefore) + ')');
        if (ev.type !== 'meal' && !(isNum(ev.duration) && ev.duration > 0)) bad.push(at + '.duration must be a positive number (got ' + show(ev.duration) + ')');
        if (ev.type === 'meal') ['kcal', 'carbs', 'protein', 'fat', 'alcohol'].forEach(k => {
          if (ev[k] !== undefined && !isNum(ev[k])) bad.push(at + '.' + k + ' must be a finite number (got ' + show(ev[k]) + ')');
        });
        out.push(ev);
      });
      return out;
    }
    const carryInEvents = checkCarryIn(raw.carryInEvents, 'carryInEvents');
    const startedFromCarryIn = checkCarryIn(raw.startedFromCarryIn, 'startedFromCarryIn');

    // --- startedFrom (optional; complete if present) ----------------------
    let startedFrom = null;
    if (raw.startedFrom !== undefined && raw.startedFrom !== null) {
      if (typeof raw.startedFrom !== 'object' || Array.isArray(raw.startedFrom)) bad.push('"startedFrom" must be an object');
      else {
        startedFrom = {};
        STATE_FIELDS.forEach(k => {
          if (!isNum(raw.startedFrom[k])) bad.push('startedFrom.' + k + ' must be a finite number (got ' + show(raw.startedFrom[k]) + ')');
          else startedFrom[k] = raw.startedFrom[k];
        });
      }
    }

    // --- startDate (optional label; never used in any calculation) --------
    let sDate = '';
    if (raw.startDate !== undefined && raw.startDate !== null && raw.startDate !== '') {
      if (typeof raw.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.startDate))
        bad.push('"startDate" must be a YYYY-MM-DD date or empty (got ' + show(raw.startDate) + ')');
      else sDate = raw.startDate;
    }

    if (bad.length) {
      const shown = bad.slice(0, 6).join('\n• ');
      throw new Error('This scenario file has ' + bad.length + ' problem' + (bad.length > 1 ? 's' : '') +
        ' and was not loaded:\n\n• ' + shown + (bad.length > 6 ? '\n• …and ' + (bad.length - 6) + ' more' : ''));
    }

    return {
      schemaVersion: SCHEMA_VERSION, app: APP_ID,
      name: typeof raw.name === 'string' ? raw.name : '',
      created: typeof raw.created === 'string' ? raw.created : (raw.savedAt || ''),
      profile: p, settings: (raw.settings && typeof raw.settings === 'object') ? raw.settings : {},
      schedule: raw.schedule, startDate: sDate,
      endState, carryInEvents, startedFrom, startedFromCarryIn
    };
  }

  // Apply an already-parsed scenario. Only called after validation succeeds.
  function applyScenario(scn) {
    const p = scn.profile;
    $('pWeight').value = p.weight; $('pHeight').value = p.height; $('pAge').value = p.age;
    $('pSex').value = p.sex; $('pTraining').value = p.training;
    schedule = JSON.parse(JSON.stringify(scn.schedule));
    startDate = scn.startDate || '';
    if ($('startDate')) $('startDate').value = startDate;
    // "Continue" starts the next 5 days from the saved end-state; otherwise fresh.
    const wantContinue = $('scenContinue') && $('scenContinue').checked;
    if (wantContinue && scn.endState) {
      carryOverState = scn.endState;
      carryOverCarryIn = scn.carryInEvents || [];
      carryOverLabel = scn.name || '';
      if (!scn.carryInEvents)
        alert('Continuing, but this file predates carry-in events: the first few hours after the seam will be approximate. Re-run and re-save to get an exact continuation.');
    } else {
      carryOverState = null; carryOverCarryIn = null; carryOverLabel = '';
      if (wantContinue && !scn.endState)
        alert('This scenario has no saved end-state, so it will load fresh. Run it, save it again, then Continue will work.');
    }
    renderList(); showDerived(); run(); flushWorking();
  }

  // ---- autosave of the in-progress working state ------------------------
  // Separate from the named-scenario list: this is the "don't lose my typing"
  // net. Mobile Safari discards backgrounded tabs aggressively, so every change
  // is persisted rather than waiting for a Save button.
  const WORK_KEY = 'metabolismSim.working.v1';
  const SINCE_KEY = 'metabolismSim.storedSince.v1';   // when autosave first wrote anything
  const BACKUP_KEY = 'metabolismSim.lastBackup.v1';   // last successful export / share / copy
  const DISMISS_KEY = 'metabolismSim.backupNoteDismissed';
  const DAY_MS = 86400000, STALE_DAYS = 3;
  // The add-event forms are the half-entered forms most likely to be lost.
  const DRAFT_FIELDS = ['mDay', 'mName', 'mTime', 'mKcal', 'mCarb', 'mProt', 'mFat', 'mAlc',
                        'aDay', 'aStart', 'aDur', 'aInt', 'rDay', 'rStart', 'rDur', 'rInt',
                        'sDay', 'sStart', 'sEnd'];
  let workTimer = null;

  function readDraft() {
    const d = {};
    DRAFT_FIELDS.forEach(id => { if ($(id)) d[id] = String($(id).value); });
    return d;
  }
  function applyDraft(d) {
    if (!d || typeof d !== 'object') return;
    DRAFT_FIELDS.forEach(id => { if ($(id) && typeof d[id] === 'string') $(id).value = d[id]; });
  }
  // Shaped like a scenario file so restore can reuse parseScenario's validation.
  // Stores the ACTIVE carry-over, not simData.endState — otherwise a plain
  // reload would silently turn a fresh run into a continued one.
  function workingSnapshot() {
    return {
      schemaVersion: SCHEMA_VERSION, app: APP_ID,
      name: ($('scenName').value || '').trim(),
      created: new Date().toISOString(),
      profile: readProfile(), settings: {},
      schedule: JSON.parse(JSON.stringify(schedule)),
      startDate: startDate || null,
      startedFrom: carryOverState, startedFromCarryIn: carryOverCarryIn,
      carryOverLabel: carryOverLabel || null,
      draft: readDraft(), activeTab: activeTab
    };
  }
  function writeWorking() {
    try {
      localStorage.setItem(WORK_KEY, JSON.stringify(workingSnapshot()));
      if (!localStorage.getItem(SINCE_KEY)) localStorage.setItem(SINCE_KEY, new Date().toISOString());
    } catch (e) { /* private mode or quota — autosave is best-effort */ }
  }
  function saveWorking() {
    if (workTimer) clearTimeout(workTimer);
    workTimer = setTimeout(() => { workTimer = null; writeWorking(); }, 400);
  }
  function flushWorking() {
    if (workTimer) { clearTimeout(workTimer); workTimer = null; }
    writeWorking();
  }
  // Restore returns true only if something was actually loaded. Anything stale or
  // corrupt falls through to the defaults rather than half-applying.
  function restoreWorking() {
    let raw;
    try { raw = JSON.parse(localStorage.getItem(WORK_KEY)); } catch (e) { return false; }
    if (!raw) return false;
    let scn;
    try { scn = parseScenario(raw); } catch (e) { return false; }
    const p = scn.profile;
    $('pWeight').value = p.weight; $('pHeight').value = p.height; $('pAge').value = p.age;
    $('pSex').value = p.sex; $('pTraining').value = p.training;
    schedule = JSON.parse(JSON.stringify(scn.schedule));
    // startedFrom is where this session's run was seeded; older working states
    // stored the same thing under initialState, which parseScenario maps to endState.
    carryOverState = scn.startedFrom || scn.endState;
    carryOverCarryIn = scn.startedFromCarryIn || scn.carryInEvents;
    // cosmetic only, so it comes off the raw object rather than the validated one
    carryOverLabel = (typeof raw.carryOverLabel === 'string') ? raw.carryOverLabel : '';
    startDate = scn.startDate || '';
    if ($('startDate')) $('startDate').value = startDate;
    if (scn.name) $('scenName').value = scn.name;
    applyDraft(raw.draft);
    // parseScenario normalises away anything it does not know about, so the tab
    // comes off the raw object — and only if it names a tab this build has.
    if (TABS.indexOf(raw.activeTab) >= 0) setTab(raw.activeTab);
    return true;
  }

  // ---- stale-storage nudge ----------------------------------------------
  // iOS Safari evicts localStorage after ~7 days without a visit unless the app
  // has been added to the home screen, so work that only ever lived in the
  // browser can simply disappear. Suggest a real export before that happens.
  function markBackedUp() {
    try { localStorage.setItem(BACKUP_KEY, new Date().toISOString()); } catch (e) { /* best-effort */ }
    hideBackupNote();
  }
  function hideBackupNote() { const el = $('backupNote'); if (el) el.hidden = true; }
  function maybeWarnStale() {
    const el = $('backupNote');
    if (!el) return;
    let since, backup, dismissed;
    try {
      since = localStorage.getItem(SINCE_KEY);
      backup = localStorage.getItem(BACKUP_KEY);
      dismissed = sessionStorage.getItem(DISMISS_KEY);
    } catch (e) { return; }          // no storage at all: nothing to lose, nothing to warn about
    if (!since || dismissed) return;
    const age = Date.now() - new Date(since).getTime();
    if (!isFinite(age) || age < STALE_DAYS * DAY_MS) return;
    const backupAge = backup ? Date.now() - new Date(backup).getTime() : Infinity;
    if (isFinite(backupAge) && backupAge < STALE_DAYS * DAY_MS) return;
    const days = Math.floor(age / DAY_MS);
    el.innerHTML = '<span>This browser has been holding your work for ' + days + ' days with no export. ' +
      'Phone browsers clear stored data on their own — use <b>Export / share…</b> to keep a copy.</span>' +
      '<button type="button" id="backupNoteHide">Dismiss</button>';
    el.hidden = false;
    $('backupNoteHide').onclick = () => {
      try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch (e) { /* best-effort */ }
      hideBackupNote();
    };
  }

  // Read only the ending state out of a scenario file and adopt it as this
  // scenario's starting point. Deliberately leaves the schedule, profile and
  // Day 1 date alone — importing a whole scenario replaces all of those, which
  // is wrong when the week you want to run is already built.
  function importStartState(file) {
    const reader = new FileReader();
    reader.onerror = () => startStateStatus('Could not read that file.');
    reader.onload = () => {
      let raw;
      try { raw = JSON.parse(reader.result); }
      catch (e) {
        startStateStatus('That file is not valid JSON, so no starting state was set.');
        alert('That file is not valid JSON.\n\n(' + e.message + ')');
        return;
      }
      let scn;
      try { scn = parseScenario(raw); } catch (e) { startStateStatus('No starting state was set.'); alert(e.message); return; }
      if (!scn.endState) {
        startStateStatus('No starting state was set.');
        alert('That scenario has no saved ending state, so there is nothing to start from.\n\n' +
              'Open it, press Run simulation, and save or export it again — the ending state is recorded at that point.');
        return;
      }
      carryOverState = scn.endState;
      carryOverCarryIn = scn.carryInEvents || [];
      carryOverLabel = (scn.name || file.name || 'another scenario');
      if (!scn.carryInEvents)
        startStateStatus('Start state set from "' + carryOverLabel + '". That file predates carry-in events, so the first few hours will be approximate.');
      else
        startStateStatus('Start state set from "' + carryOverLabel + '" — your schedule, profile and Day 1 date are unchanged.');
      run(); flushWorking();
    };
    reader.readAsText(file);
  }

  // Back-compat wrapper used by the in-app saved list.
  function applySnapshot(raw) {
    let scn; try { scn = parseScenario(raw); } catch (e) { alert(e.message); return; }
    applyScenario(scn);
  }
  function renderScenarios() {
    const store = loadStore();
    const names = Object.keys(store).sort((a, b) => a.localeCompare(b));
    $('scenList').innerHTML = names.length
      ? names.map((n, i) => {
          const when = (store[n].created || store[n].savedAt) ? new Date(store[n].created || store[n].savedAt).toLocaleString() : '';
          return `<div class="scenario"><span class="scen-name" title="saved ${esc(when)}">${esc(n)}</span>` +
                 `<span class="scen-actions"><button data-i="${i}" data-act="load">Load</button>` +
                 `<button class="del" data-i="${i}" data-act="del" title="delete">✕</button></span></div>`;
        }).join('')
      : '<div class="scen-empty muted">No saved scenarios yet.</div>';
    $('scenList').querySelectorAll('button[data-act]').forEach(b => b.onclick = () => {
      const n = names[+b.dataset.i];
      if (b.dataset.act === 'load') applySnapshot(loadStore()[n]);
      else { const s = loadStore(); delete s[n]; saveStore(s); renderScenarios(); }
    });
  }
  function saveScenario() {
    const name = ($('scenName').value || '').trim();
    if (!name) { $('scenName').focus(); return; }
    const store = loadStore();
    if (store[name] && !confirm(`Overwrite the saved scenario "${name}"?`)) return;
    store[name] = currentSnapshot(name);
    if (saveStore(store)) { $('scenName').value = ''; renderScenarios(); }
  }
  // Filename = scenario name + timestamp, sanitized. People accumulate several
  // of these, so "export.json" would be useless.
  function scenarioFilename(name, iso, ext) {
    const d = iso ? new Date(iso) : new Date();
    const p = n => String(n).padStart(2, '0');
    const stamp = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
                  '_' + p(d.getHours()) + p(d.getMinutes());
    const safe = (name || 'scenario').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'scenario';
    return safe + '_' + stamp + (ext || '.json');
  }
  function scenStatus(msg) { const el = $('scenFileStatus'); if (el) el.textContent = msg || ''; }

  // Download via <a download>. Works everywhere except iOS Safari, which tends
  // to open the file in a viewer instead of saving it — hence the share path below.
  function downloadScenario(text, filename) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    // Revoking immediately cancels the download in Safari — let the click settle.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    markBackedUp();
    scenStatus('Saved ' + filename + '. If it opened in a viewer instead of saving, use "Copy as text".');
  }

  // On touch devices the Web Share sheet is the only reliable way to get a file
  // into Files.app / Drive. On a desktop it would replace a working one-click
  // download with an OS share dialog that often cannot save to disk at all, so
  // the share path is deliberately limited to coarse-pointer devices.
  function canShareFiles(file) {
    if (!file || !navigator.canShare || !navigator.share) return false;
    if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) return false;
    try { return navigator.canShare({ files: [file] }); } catch (e) { return false; }
  }

  function exportScenario() {
    const name = ($('scenName').value || '').trim() || 'scenario';
    const data = currentSnapshot(name);
    const text = JSON.stringify(data, null, 2);
    const filename = scenarioFilename(name, data.created);

    let file = null;
    try { file = new File([text], filename, { type: 'application/json' }); } catch (e) { /* no File constructor */ }

    // navigator.share must be reached without an intervening await, or the
    // browser treats the call as gestureless and rejects it.
    if (canShareFiles(file)) {
      scenStatus('Opening the share sheet — choose "Save to Files" to keep it.');
      navigator.share({ files: [file], title: data.name }).then(
        () => { markBackedUp(); scenStatus('Shared ' + filename + '.'); },
        e => {
          if (e && e.name === 'AbortError') { scenStatus(''); return; }  // user dismissed the sheet
          downloadScenario(text, filename);
        });
      return;
    }
    downloadScenario(text, filename);
  }

  // ---- clipboard export (last resort) -----------------------------------
  // Some in-app browsers (Instagram, Facebook, several email clients) block
  // both downloads and the share sheet. Text always survives.
  function execCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    ta.setSelectionRange(0, text.length);   // iOS ignores select() alone
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    syncKeyboardState();   // removal fires no focusout; re-derive rather than strand
    return ok;
  }
  function copyScenarioText() {
    const name = ($('scenName').value || '').trim() || 'scenario';
    const text = JSON.stringify(currentSnapshot(name), null, 2);
    const kb = Math.max(1, Math.round(text.length / 1024));
    const done = () => { hideScenText(); markBackedUp(); scenStatus('Scenario copied (' + kb + ' KB of text). Paste it into a note or a message; load it back with "Paste text…".'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => showForManualCopy(text));
    } else if (execCopy(text)) { done(); }
    else showForManualCopy(text);
  }
  function showForManualCopy(text) {
    showScenText('Copying automatically was blocked here. The scenario text is below — select all of it, copy, and keep it somewhere safe.', text, false);
    scenStatus('');
  }

  // ---- text panel, shared by manual copy and paste-to-load --------------
  function showScenText(hint, value, showLoad) {
    $('scenTextHint').textContent = hint;
    $('scenTextBox').value = value || '';
    $('scenTextLoad').hidden = !showLoad;
    $('scenTextWrap').hidden = false;
    $('scenTextBox').focus();
    if (!showLoad) $('scenTextBox').select();
  }
  function hideScenText() {
    const box = $('scenTextBox');
    // Hiding a focused field fires no focusout and does not clear activeElement
    // synchronously, so blur first — otherwise the sync below reads the field
    // that is already gone and leaves the tab bar hidden.
    if (box && document.activeElement === box) box.blur();
    $('scenTextWrap').hidden = true;
    if (box) box.value = '';
    syncKeyboardState();
  }

  // Parse + validate + apply. Returns the scenario on success, null on failure;
  // nothing is applied unless validation passed.
  function loadScenarioText(text, sourceLabel) {
    let raw;
    try { raw = JSON.parse(text); }
    catch (e) { alert('That ' + sourceLabel + ' is not valid JSON, so it could not be opened.\n\n(' + e.message + ')'); return null; }
    let scn;
    try { scn = parseScenario(raw); } catch (e) { alert(e.message); return null; }
    applyScenario(scn);
    if (scn.name) $('scenName').value = scn.name;
    return scn;
  }
  function loadPastedScenario() {
    const text = $('scenTextBox').value.trim();
    if (!text) { $('scenTextBox').focus(); return; }
    const scn = loadScenarioText(text, 'text');
    if (!scn) return;
    hideScenText();
    scenStatus('Loaded ' + (scn.name ? '"' + scn.name + '"' : 'scenario') + ' from pasted text.');
  }

  function importScenario(file) {
    const reader = new FileReader();
    reader.onerror = () => alert('Could not read that file.');
    reader.onload = () => {
      const scn = loadScenarioText(String(reader.result), 'file');
      if (scn) scenStatus('Loaded ' + (scn.name ? '"' + scn.name + '"' : 'scenario') + ' from ' + file.name + '.');
    };
    reader.readAsText(file);
  }
  function wireScenarios() {
    $('scenSave').onclick = saveScenario;
    $('scenName').addEventListener('keydown', e => { if (e.key === 'Enter') saveScenario(); });
    $('scenExport').onclick = exportScenario;
    $('scenImport').addEventListener('change', e => { if (e.target.files[0]) importScenario(e.target.files[0]); e.target.value = ''; });
    $('scenCopy').onclick = copyScenarioText;
    $('scenPasteOpen').onclick = () => showScenText('Paste the scenario text you copied, then load it.', '', true);
    $('scenTextLoad').onclick = loadPastedScenario;
    $('scenTextClose').onclick = hideScenText;
    renderScenarios();
  }

  // ---- CSV import (append events, never touch existing ones) ------------
  // Minimal quote-aware CSV parser -> array of rows (arrays of cell strings).
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

  // ---- CSV export --------------------------------------------------------
  // Writes the SAME 14-column layout importEventsCsv reads, so a file exported
  // here can be edited in a spreadsheet and imported straight back. Every row
  // gets "x" in Total so it re-imports; blank out that cell (or type anything
  // else) to park a row without deleting it.
  const CSV_HEAD = ['Date', 'Day', 'Event', 'Time', 'End', 'Total (x/o)', 'Exercise',
                    'What', 'Name', 'Kcal', 'Prot', 'Carb', 'Fat', 'Alc'];
  function csvCell(v) {
    const s = (v === undefined || v === null) ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function buildEventsCsv() {
    const hh = window.simUtil.hhmmToMin, lbl = window.simUtil.minToLabel;
    const rows = [CSV_HEAD];
    const sorted = schedule.slice().sort((a, b) =>
      ((+a.day || 1) - (+b.day || 1)) || (sortKey(a) - sortKey(b)));
    for (const ev of sorted) {
      const r = new Array(CSV_HEAD.length).fill('');
      r[1] = +ev.day || 1;          // Day
      r[5] = 'x';                   // Total (x/o) — marks the row as live
      if (ev.type === 'meal') {
        r[2] = 'Meal'; r[3] = ev.time; r[8] = ev.name || 'Meal';
        r[9] = ev.kcal; r[10] = ev.protein; r[11] = ev.carbs; r[12] = ev.fat; r[13] = ev.alcohol;
      } else if (ev.type === 'aerobic' || ev.type === 'resistance') {
        r[2] = ev.type === 'aerobic' ? 'Aerobic' : 'Resistance';
        r[3] = ev.start;
        // End = start + duration, which is how the importer recovers duration.
        r[4] = lbl(hh(ev.start) + (+ev.duration || 0));
        r[6] = ev.intensity;
      } else if (ev.type === 'sleep') {
        r[2] = 'Sleep'; r[3] = ev.start; r[4] = ev.end;
      } else continue;
      rows.push(r);
    }
    // Leading BOM + CRLF so Excel opens it cleanly; the importer ignores both
    // (the BOM lands in the Date column, which it never reads).
    return { text: '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n',
             count: rows.length - 1 };
  }

  function downloadCsv(text, filename, count) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);   // revoking at once cancels it in Safari
    $('csvStatus').textContent = 'Saved ' + filename + ' — ' + count + ' event' + (count !== 1 ? 's' : '') + '.';
  }

  function exportEventsCsv() {
    if (!schedule.length) { $('csvStatus').textContent = 'No events to export yet.'; return; }
    const built = buildEventsCsv();
    const base = ($('scenName') && ($('scenName').value || '').trim()) || 'events';
    const filename = scenarioFilename(base, null, '.csv');

    let file = null;
    try { file = new File([built.text], filename, { type: 'text/csv' }); } catch (e) { /* no File ctor */ }

    // Same reasoning as the scenario export: on touch devices the share sheet is
    // the only reliable route into Files.app, and it must be reached without an
    // intervening await or the browser rejects it as gestureless.
    if (canShareFiles(file)) {
      $('csvStatus').textContent = 'Opening the share sheet — choose "Save to Files" to keep it.';
      navigator.share({ files: [file], title: filename }).then(
        () => { $('csvStatus').textContent = 'Shared ' + filename + ' — ' + built.count + ' events.'; },
        e => {
          if (e && e.name === 'AbortError') { $('csvStatus').textContent = ''; return; }
          downloadCsv(built.text, filename, built.count);
        });
      return;
    }
    downloadCsv(built.text, filename, built.count);
  }

  function importEventsCsv(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let rows;
      try { rows = parseCSV(reader.result); } catch (e) { $('csvStatus').textContent = 'Could not read that CSV.'; return; }
      if (!rows.length) { $('csvStatus').textContent = 'CSV appears to be empty.'; return; }

      // Column indices (A=0 … N=13): B Day, C Event, D Time, E End, F Total,
      // G Exercise/Intensity, I Name, J Kcal, K Prot, L Carb, M Fat, N Alc.
      const first = rows[0].map(s => (s || '').trim().toLowerCase());
      const start = (first[2] === 'event' || (first[5] || '').includes('total')) ? 1 : 0;

      const hh = window.simUtil.hhmmToMin, lbl = window.simUtil.minToLabel;
      let added = 0, ignored = 0, outOfRange = 0;

      for (let r = start; r < rows.length; r++) {
        const row = rows[r];
        const cell = i => (row[i] !== undefined ? String(row[i]).trim() : '');
        if (cell(5).toLowerCase() !== 'x') { ignored++; continue; }        // Column F must be "x"
        const type = cell(2).toLowerCase();                                // Column C
        const day = parseInt(cell(1), 10);                                 // Column B
        const timeRaw = cell(3);                                           // Column D
        if (!day || day < 1) { ignored++; continue; }
        if (day > DAYS) { outOfRange++; continue; }
        const num = i => { const v = parseFloat(cell(i)); return isFinite(v) ? v : 0; };
        const toHHMM = t => lbl(hh(t));

        if (type === 'meal') {
          if (!timeRaw) { ignored++; continue; }
          schedule.push({ type: 'meal', day, time: toHHMM(timeRaw), name: cell(8) || 'Meal',
            kcal: num(9), protein: num(10), carbs: num(11), fat: num(12), alcohol: num(13) });
          added++;
        } else if (type === 'aerobic' || type === 'resistance') {
          if (!timeRaw) { ignored++; continue; }
          const endRaw = cell(4);
          let dur = 30;                                              // no End -> 30 min
          if (endRaw) {
            const d = hh(endRaw) - hh(timeRaw);
            if (d > 0) dur = d;                                      // End later the same day
            // End past midnight (23:30 -> 00:15) reads as negative. Accept the
            // wrap only for a plausible session length; a bigger number is far
            // more likely an End-before-Time typo, so keep the 30 min default.
            else if (d + 1440 <= 360) dur = d + 1440;
          }
          let intensity = cell(6).toLowerCase();                                    // Column G
          if (type === 'resistance') {
            if (intensity === 'vigorous') intensity = 'hard';                       // resistance has no "vigorous"
            if (!['light', 'moderate', 'hard'].includes(intensity)) intensity = 'moderate';
          } else {
            if (intensity === 'hard') intensity = 'vigorous';                       // aerobic has no "hard"
            if (!['light', 'moderate', 'vigorous'].includes(intensity)) intensity = 'moderate';
          }
          schedule.push({ type, day, start: toHHMM(timeRaw), duration: dur, intensity });
          added++;
        } else if (type === 'sleep') {
          if (!timeRaw) { ignored++; continue; }
          const endRaw = cell(4);                                                   // Column E = end time
          schedule.push({ type: 'sleep', day, start: toHHMM(timeRaw), end: endRaw ? toHHMM(endRaw) : lbl(hh(timeRaw) + 480) });
          added++;
        } else { ignored++; }                                                       // Column C not an event
      }

      renderList(); saveWorking();
      const bits = [`Imported ${added} event${added !== 1 ? 's' : ''}`];
      if (ignored) bits.push(`${ignored} row${ignored !== 1 ? 's' : ''} skipped`);
      if (outOfRange) bits.push(`${outOfRange} beyond day ${DAYS} skipped`);
      $('csvStatus').textContent = bits.join(' · ') + (added ? '. Review the list, delete any duplicates, then Run simulation.' : '.');
    };
    reader.readAsText(file);
  }

  // ---- food-log import (Cronometer today; see importers.js) --------------
  // Everything foreign goes through a review screen. The events CSV above
  // reads a file this app wrote, so its shape is known; a nutrition-app
  // export is someone else's format carrying someone else's assumptions,
  // and the only safe way to land it is to show the user exactly what will
  // be added and let them change it first.

  // Classifications are remembered so a weekly import only ever asks about
  // an exercise name once. Keyed by the name exactly as the source writes it.
  const EXMAP_KEY = 'metabolismSim.exerciseMap.v1';
  function loadExerciseMap() {
    try { const m = JSON.parse(localStorage.getItem(EXMAP_KEY)); return (m && typeof m === 'object') ? m : {}; }
    catch (e) { return {}; }
  }
  function saveExerciseMap(m) { try { localStorage.setItem(EXMAP_KEY, JSON.stringify(m)); } catch (e) { /* private mode */ } }

  let imp = null;                       // the in-progress import, or null
  const impStatus = msg => { const el = $('foodLogStatus'); if (el) el.textContent = msg || ''; };
  // esc() is for TEXT nodes and leaves quotes alone, which is fine there and
  // wrong inside an attribute: a food logged as Kellogg's "Special K" would
  // close the value early and arrive truncated. Imported names are foreign
  // input, so every attribute they land in uses this instead.
  const ESC_A = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escAttr(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ESC_A[c]); }
  const n0 = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  function isoPlus(iso, n) {
    const p = String(iso || '').split('-').map(Number);
    if (p.length !== 3 || !p.every(isFinite)) return '';
    const d = new Date(p[0], p[1] - 1, p[2] + n);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined,
      { weekday: 'short', day: 'numeric', month: 'short' });
  }

  function showImportOverlay(on) {
    const el = $('importOverlay');
    if (!el) return;
    el.hidden = !on;
    document.body.classList.toggle('import-open', !!on);
    if (on) { const b = el.querySelector('.import-body'); if (b) b.scrollTop = 0; }
  }
  function closeImport() { imp = null; showImportOverlay(false); }

  // A file we cannot read at all gets the same overlay, because the reason
  // is usually actionable ("you exported the wrong report") and a one-line
  // status message is not enough room to say so.
  function openImportReject(title, message, detail) {
    imp = null;
    $('importTitle').textContent = title;
    $('importSummary').innerHTML =
      '<div class="imp-reject"><p><b>' + esc(message) + '</b></p>' +
      (detail ? '<pre class="imp-reject-detail">' + esc(detail) + '</pre>' : '') +
      '<p class="imp-opt-hint">In Cronometer: <b>Profile ▸ Account ▸ Export Data</b>, then ' +
      '<b>Export Servings</b> for food or <b>Export Exercises</b> for training. ' +
      'Pick a date range and export the CSV without editing the header row.</p></div>';
    $('importOptsWrap').hidden = true;
    $('importExercise').hidden = true;
    $('importIssues').innerHTML = '';
    $('importTimeline').innerHTML = '';
    $('importClash').hidden = true;
    $('importConfirm').style.display = 'none';
    $('importCancel').textContent = 'Close';
    showImportOverlay(true);
  }

  function importFoodLog(file) {
    const reader = new FileReader();
    reader.onerror = () => impStatus('Could not read that file.');
    reader.onload = () => {
      const text = String(reader.result || '');
      const F = window.foodImport;
      const parser = F.detectParser(text);
      if (!parser) {
        openImportReject('Import failed', 'Nothing recognised that file.',
          'No importer claimed it. The first line has to be the export\'s own header row — ' +
          'a servings export needs Day and Food Name columns, an exercises export needs ' +
          'Day, Exercise and Minutes.');
        impStatus('');
        return;
      }
      let parsed;
      try { parsed = parser.parse(text); }
      catch (e) {
        openImportReject('Import failed', e.message || 'That file could not be read.', e.detail || '');
        impStatus('');
        return;
      }
      imp = {
        fileName: file.name || 'import.csv',
        parser: parser,
        parsed: parsed,
        edited: false,
        options: {
          merge: false,
          defaultTimes: Object.assign({}, window.foodImport.DEFAULT_TIMES),
          exercise: { defaultStart: window.foodImport.DEFAULT_EXERCISE_START, map: loadExerciseMap() }
        },
        setDayOne: false,
        clashAck: false,
        pendingEx: {}          // half-finished exercise classifications
      };
      // Reset the panel from any previous rejection.
      $('importTitle').textContent = 'Review import';
      $('importOptsWrap').hidden = false;
      $('importConfirm').style.display = '';
      $('importCancel').textContent = 'Cancel';
      syncOptionControls();
      remapImport();
      showImportOverlay(true);
      impStatus('');
    };
    reader.readAsText(file);
  }

  // Push imp.options into the option controls (they persist across imports
  // within a session, so they must be re-read, not assumed).
  function syncOptionControls() {
    const t = imp.options.defaultTimes;
    $('impMerge').checked = !!imp.options.merge;
    $('impTBreakfast').value = t.breakfast; $('impTLunch').value = t.lunch;
    $('impTDinner').value = t.dinner; $('impTSnack').value = t.snack;
    $('impTSnack2').value = t.snack2; $('impTUnknown').value = t.unknown;
    $('impExStart').value = imp.options.exercise.defaultStart;
    const isEx = imp.parsed.meta && imp.parsed.meta.kind === 'exercise';
    $('impExStartWrap').hidden = !isEx;
    $('impTimesWrap').hidden = isEx;
  }

  // Rebuild the plan from the current options. Any per-row edits are lost,
  // which is why it warns rather than doing it quietly.
  function remapImport() {
    if (!imp) return;
    if (imp.edited && imp.plan) {
      imp.rebuiltNote = 'Options changed, so the list below was rebuilt — your row edits were reset.';
    }
    imp.plan = window.foodImport.mapEntriesToSchedule(imp.parsed.entries, {
      startDate: startDate, days: DAYS,
      merge: imp.options.merge,
      defaultTimes: imp.options.defaultTimes,
      exercise: imp.options.exercise
    });
    imp.edited = false;
    renderReview();
  }

  function liveRows() { return imp.plan.planned.filter(p => !p.removed); }

  function dayTotals(rows) {
    const t = { kcal: 0, carbs: 0, protein: 0, fat: 0, alcohol: 0, minutes: 0, ex: 0 };
    for (const p of rows) {
      if (p.ev.type === 'meal') {
        t.kcal += n0(p.ev.kcal); t.carbs += n0(p.ev.carbs); t.protein += n0(p.ev.protein);
        t.fat += n0(p.ev.fat); t.alcohol += n0(p.ev.alcohol);
      } else { t.ex++; t.minutes += n0(p.ev.duration); }
    }
    return t;
  }
  function totalsText(t) {
    const bits = [];
    if (t.kcal || t.carbs || t.protein || t.fat) {
      bits.push(Math.round(t.kcal) + ' kcal', 'C ' + Math.round(t.carbs),
                'P ' + Math.round(t.protein), 'F ' + Math.round(t.fat));
      if (t.alcohol > 0) bits.push('Alc ' + Math.round(t.alcohol * 10) / 10 + ' g');
    }
    if (t.ex) bits.push(t.ex + ' session' + (t.ex !== 1 ? 's' : '') + ' · ' + Math.round(t.minutes) + ' min');
    return bits.join(' · ') || '—';
  }
  // Totals move on every keystroke, so they are patched in place rather than
  // re-rendering the list — a re-render would steal focus mid-edit.
  function updateTotals() {
    const rows = liveRows();
    const days = {};
    rows.forEach(p => { (days[p.ev.day] = days[p.ev.day] || []).push(p); });
    for (let d = 1; d <= DAYS; d++) {
      const el = $('impTot' + d);
      if (el) el.textContent = totalsText(dayTotals(days[d] || []));
    }
    const g = $('impGrand');
    if (g) g.textContent = rows.length + ' event' + (rows.length !== 1 ? 's' : '');
  }

  function renderReview() {
    const P = imp.plan, meta = imp.parsed.meta || {};
    const body = $('importOverlay').querySelector('.import-body');
    const keepScroll = body ? body.scrollTop : 0;
    const rows = liveRows();

    // ---- summary --------------------------------------------------------
    const dayNums = rows.map(p => p.ev.day);
    const lo = dayNums.length ? Math.min.apply(null, dayNums) : 0;
    const hi = dayNums.length ? Math.max.apply(null, dayNums) : 0;
    let s = '<div class="imp-sum-line"><b>' + esc(imp.fileName) + '</b> · read as <b>' +
      esc(imp.parser.label) + '</b></div>';
    s += '<div class="imp-sum-line">' + imp.parsed.entries.length + ' row' +
      (imp.parsed.entries.length !== 1 ? 's' : '') + ' in the file → <b id="impGrand">' +
      rows.length + ' event' + (rows.length !== 1 ? 's' : '') + '</b>' +
      (dayNums.length ? ' on Day ' + (lo === hi ? lo : lo + '–' + hi) : '') + '</div>';
    s += '<div class="imp-sum-line imp-dayone">Day 1 = <b>' + esc(P.dayOne || '—') + '</b>' +
      (P.inferredDayOne
        ? ' <span class="opt">(taken from the earliest date in the file — no Day 1 date is set)</span>'
        : ' <span class="opt">(this scenario\'s Day 1 date)</span>') + '</div>';
    if (P.inferredDayOne) {
      s += '<label class="imp-check imp-setdate"><input type="checkbox" id="impSetDayOne"' +
        (imp.setDayOne ? ' checked' : '') + ' />' +
        '<span>Also set this scenario\'s Day 1 date to ' + esc(P.dayOne) +
        ' <span class="opt">(a label only — no calculation reads it)</span></span></label>';
    }
    $('importSummary').innerHTML = s;

    // ---- exercise classification ----------------------------------------
    const ex = $('importExercise');
    if (P.unclassified.length) {
      let h = '<h3>Classify these exercises</h3>' +
        '<p class="imp-opt-hint">The export says what you did and for how long, but not how the ' +
        'body should treat it. Choose once — the answer is remembered for future imports.</p>';
      for (const name of P.unclassified) {
        // Reflect any half-answer already given, so a re-render (triggered by
        // any other option change) does not visibly reset the user's pick.
        const pend = imp.pendingEx[name] || {};
        h += '<div class="imp-exrow"><span class="imp-exname">' + esc(name) + '</span>' +
          '<select data-exname="' + escAttr(name) + '" data-exf="type">' +
          '<option value="">— choose —</option>' +
          '<option value="aerobic"' + (pend.type === 'aerobic' ? ' selected' : '') + '>Aerobic</option>' +
          '<option value="resistance"' + (pend.type === 'resistance' ? ' selected' : '') + '>Resistance</option></select>' +
          '<select data-exname="' + escAttr(name) + '" data-exf="intensity">' +
          ['light', 'moderate', 'vigorous'].map(i =>
            '<option value="' + i + '"' +
            ((pend.intensity || 'moderate') === i ? ' selected' : '') + '>' +
            (i === 'vigorous' ? 'vigorous / hard' : i) + '</option>').join('') +
          '</select></div>';
      }
      ex.innerHTML = h;
      ex.hidden = false;
    } else if (imp.parsed.meta && imp.parsed.meta.kind === 'exercise') {
      const known = Object.keys(imp.options.exercise.map);
      ex.innerHTML = '<h3>Exercise types</h3><div class="imp-exrows-known">' +
        known.filter(k => imp.parsed.entries.some(e => e.name === k)).map(k =>
          '<div class="imp-exrow"><span class="imp-exname">' + esc(k) + '</span>' +
          '<select data-exname="' + escAttr(k) + '" data-exf="type">' +
          '<option value="aerobic"' + (imp.options.exercise.map[k].type === 'aerobic' ? ' selected' : '') + '>Aerobic</option>' +
          '<option value="resistance"' + (imp.options.exercise.map[k].type === 'resistance' ? ' selected' : '') + '>Resistance</option></select>' +
          '<select data-exname="' + escAttr(k) + '" data-exf="intensity">' +
          ['light', 'moderate', 'vigorous'].map(i =>
            '<option value="' + i + '"' +
            ((imp.options.exercise.map[k].intensity === i ||
              (i === 'vigorous' && imp.options.exercise.map[k].intensity === 'hard')) ? ' selected' : '') +
            '>' + (i === 'vigorous' ? 'vigorous / hard' : i) + '</option>').join('') +
          '</select></div>').join('') + '</div>';
      ex.hidden = false;
    } else { ex.innerHTML = ''; ex.hidden = true; }

    // ---- issues ---------------------------------------------------------
    // Parse warnings, mapper notes, skipped rows and per-entry flags all
    // land here. Nothing is dropped without appearing in this block.
    let iss = '';
    const note = imp.rebuiltNote; imp.rebuiltNote = '';
    if (note) iss += '<div class="imp-issue info">↻ ' + esc(note) + '</div>';
    for (const w of P.warnings) iss += '<div class="imp-issue warn">⚑ ' + esc(w) + '</div>';
    for (const w of imp.parsed.warnings) iss += '<div class="imp-issue warn">⚑ ' + esc(w.text) + '</div>';
    if (P.skipped.length) {
      iss += '<details class="imp-skipped"><summary>' + P.skipped.length + ' row' +
        (P.skipped.length !== 1 ? 's' : '') + ' outside the Day 1–' + DAYS +
        ' window — not imported</summary><ul>' +
        P.skipped.map(s2 => '<li>' + esc(s2.date) + ' · ' + esc(s2.name) +
          ' <span class="opt">(' + esc(s2.reason) + ')</span></li>').join('') +
        '</ul></details>';
    }
    const flagged = rows.reduce((n, p) => n + p.flags.filter(f => f.level === 'warn').length, 0);
    if (flagged) {
      iss += '<div class="imp-issue warn">⚑ ' + flagged + ' entr' + (flagged !== 1 ? 'ies' : 'y') +
        ' below ' + (flagged !== 1 ? 'need' : 'needs') + ' a look — each is marked in the list.</div>';
    }
    $('importIssues').innerHTML = iss;

    // ---- timeline -------------------------------------------------------
    const byDay = {};
    imp.plan.planned.forEach((p, i) => {
      if (p.removed) return;
      (byDay[p.ev.day] = byDay[p.ev.day] || []).push({ p, i });
    });
    let tl = '';
    for (let d = 1; d <= DAYS; d++) {
      const items = byDay[d];
      if (!items) continue;
      tl += '<div class="imp-day"><div class="imp-day-head"><span>Day ' + d +
        '<span class="day-date"> · ' + esc(isoPlus(P.dayOne, d - 1)) + '</span></span>' +
        '<span class="imp-tot" id="impTot' + d + '">' + esc(totalsText(dayTotals(items.map(o => o.p)))) +
        '</span></div>';
      tl += '<div class="imp-cols"><span>Time</span><span>What</span><span>kcal</span>' +
            '<span>C</span><span>P</span><span>F</span><span>Alc</span><span></span></div>';
      for (const { p, i } of items) {
        const ev = p.ev;
        tl += '<div class="imp-row" data-idx="' + i + '">';
        if (ev.type === 'meal') {
          tl += '<input class="imp-time" type="time" data-f="time" value="' + escAttr(ev.time) + '" />' +
            '<input class="imp-name" type="text" data-f="name" value="' + escAttr(ev.name) + '" />' +
            ['kcal', 'carbs', 'protein', 'fat', 'alcohol'].map(f =>
              '<input class="imp-n" type="text" inputmode="decimal" data-f="' + f +
              '" value="' + escAttr(ev[f]) + '" />').join('');
        } else {
          // The source's own exercise name, not just "Aerobic" — with four
          // sessions on screen it is the only thing telling them apart.
          tl += '<input class="imp-time" type="time" data-f="start" value="' + escAttr(ev.start) + '" />' +
            '<span class="imp-name imp-exlabel">' +
            (ev.type === 'resistance' ? '🏋 ' : '🏃 ') +
            esc((p.sources && p.sources[0]) || (ev.type === 'resistance' ? 'Resistance' : 'Aerobic')) +
            '</span>' +
            '<input class="imp-n" type="text" inputmode="decimal" data-f="duration" value="' +
            escAttr(ev.duration) + '" title="minutes" />' +
            '<select class="imp-int" data-f="intensity">' +
            (ev.type === 'resistance' ? ['light', 'moderate', 'hard'] : ['light', 'moderate', 'vigorous'])
              .map(i => '<option' + (ev.intensity === i ? ' selected' : '') + '>' + i + '</option>').join('') +
            '</select><span class="imp-pad"></span><span class="imp-pad"></span>';
        }
        tl += '<button type="button" class="del" data-rm="' + i + '" title="remove this row">✕</button>';
        const sub = [];
        if (p.group) sub.push(esc(p.group));
        if (p.amount) sub.push(esc(p.amount));
        if (ev.type !== 'meal') sub.push((ev.type === 'resistance' ? 'Resistance' : 'Aerobic') + ' · minutes + intensity');
        if (p.sources && p.sources.length > 1) sub.push(p.sources.length + ' foods merged');
        if (!p.explicitTime) sub.push('time assigned by this app');
        if (sub.length) tl += '<div class="imp-sub">' + sub.join(' · ') + '</div>';
        for (const f of p.flags) {
          tl += '<div class="imp-flag ' + (f.level === 'info' ? 'info' : '') + '">' +
            (f.level === 'info' ? 'ℹ ' : '⚑ ') + esc(f.text) + '</div>';
        }
        tl += '</div>';
      }
      tl += '</div>';
    }
    if (!tl) {
      tl = '<div class="imp-empty">Nothing to import' +
        (P.unclassified.length ? ' until the exercises above are classified.' : '.') + '</div>';
    }
    $('importTimeline').innerHTML = tl;

    // ---- clash warning + confirm gate -----------------------------------
    // Import APPENDS. That is the safe default, but it means importing twice
    // silently doubles a day, so an occupied target day has to be confirmed.
    const targetDays = {};
    rows.forEach(p => { targetDays[p.ev.day] = true; });
    const clash = Object.keys(targetDays).map(Number).filter(d =>
      schedule.some(ev => (+ev.day || 1) === d)).sort((a, b) => a - b);
    const clashEl = $('importClash');
    if (clash.length) {
      clashEl.innerHTML = '<label class="imp-check"><input type="checkbox" id="impClashAck"' +
        (imp.clashAck ? ' checked' : '') + ' /><span><b>Day ' + clash.join(', ') +
        '</b> already ' + (clash.length > 1 ? 'have' : 'has') + ' events. This import <b>adds</b> to ' +
        (clash.length > 1 ? 'them' : 'it') + ' — nothing is replaced or removed, so you may end up ' +
        'with duplicates. I understand.</span></label>';
      clashEl.hidden = false;
    } else { clashEl.innerHTML = ''; clashEl.hidden = true; }

    const blocked = !rows.length || (clash.length && !imp.clashAck);
    $('importConfirm').disabled = !!blocked;
    $('importConfirm').textContent = rows.length
      ? 'Confirm import — add ' + rows.length + ' event' + (rows.length !== 1 ? 's' : '')
      : 'Confirm import';

    if (body) body.scrollTop = keepScroll;
  }

  // Strip the review-only bookkeeping and coerce every field, so what lands
  // in the schedule is indistinguishable from a hand-entered event.
  function cleanImportedEvent(ev) {
    const day = Math.min(DAYS, Math.max(1, Math.round(+ev.day || 1)));
    const lbl = window.simUtil.minToLabel, hh = window.simUtil.hhmmToMin;
    if (ev.type === 'meal') {
      return { type: 'meal', day: day, time: lbl(hh(ev.time || '12:00')),
               name: String(ev.name || 'Meal').trim() || 'Meal',
               kcal: n0(ev.kcal), carbs: n0(ev.carbs), protein: n0(ev.protein),
               fat: n0(ev.fat), alcohol: n0(ev.alcohol) };
    }
    const type = ev.type === 'resistance' ? 'resistance' : 'aerobic';
    const allowed = type === 'resistance' ? ['light', 'moderate', 'hard'] : ['light', 'moderate', 'vigorous'];
    let intensity = String(ev.intensity || 'moderate');
    if (allowed.indexOf(intensity) < 0) intensity = 'moderate';
    return { type: type, day: day, start: lbl(hh(ev.start || '17:00')),
             duration: Math.max(1, Math.round(n0(ev.duration) || 30)), intensity: intensity };
  }

  function confirmImport() {
    if (!imp) return;
    const rows = liveRows();
    if (!rows.length) return;
    const added = rows.map(p => cleanImportedEvent(p.ev));
    for (const ev of added) schedule.push(ev);

    if (imp.plan.inferredDayOne && imp.setDayOne && imp.plan.dayOne) {
      startDate = imp.plan.dayOne;
      if ($('startDate')) $('startDate').value = startDate;
    }
    const meals = added.filter(e => e.type === 'meal').length;
    const sess = added.length - meals;
    const src = imp.parser.source || 'file';
    const skipped = imp.plan.skipped.length;
    closeImport();
    renderList(); showDerived(); run(); flushWorking();
    const bits = ['Imported ' + added.length + ' event' + (added.length !== 1 ? 's' : '') + ' from ' + src];
    if (meals && sess) bits.push(meals + ' meals, ' + sess + ' session' + (sess !== 1 ? 's' : ''));
    if (skipped) bits.push(skipped + ' row' + (skipped !== 1 ? 's' : '') + ' outside the day window skipped');
    impStatus(bits.join(' · ') + '.');
  }

  function wireImport() {
    const fi = $('foodLogImport');
    if (!fi) return;
    fi.addEventListener('change', e => {
      if (e.target.files[0]) importFoodLog(e.target.files[0]);
      e.target.value = '';                       // re-selecting the same file must re-fire
    });
    $('importClose').onclick = closeImport;
    $('importCancel').onclick = closeImport;
    $('importConfirm').onclick = confirmImport;
    $('importOverlay').addEventListener('click', e => {
      if (e.target === $('importOverlay')) closeImport();   // click the backdrop
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !$('importOverlay').hidden) closeImport();
    });

    // ---- options -> remap ----
    $('impMerge').addEventListener('change', e => {
      imp.options.merge = e.target.checked; remapImport();
    });
    const TIME_IDS = { impTBreakfast: 'breakfast', impTLunch: 'lunch', impTDinner: 'dinner',
                       impTSnack: 'snack', impTSnack2: 'snack2', impTUnknown: 'unknown' };
    Object.keys(TIME_IDS).forEach(id => {
      $(id).addEventListener('change', e => {
        if (!imp || !e.target.value) return;
        imp.options.defaultTimes[TIME_IDS[id]] = e.target.value;
        remapImport();
      });
    });
    $('impExStart').addEventListener('change', e => {
      if (!imp || !e.target.value) return;
      imp.options.exercise.defaultStart = e.target.value;
      remapImport();
    });

    // ---- exercise classification ----
    $('importExercise').addEventListener('change', e => {
      const el = e.target, name = el.dataset.exname, f = el.dataset.exf;
      if (!imp || !name || !f) return;
      const map = imp.options.exercise.map;
      // Answers accumulate in `pendingEx` first. The two selects can be used
      // in either order, and an intensity chosen BEFORE a type has nowhere
      // committed to live yet — parking it here is what stops it being
      // silently discarded and the entry defaulting back to moderate.
      const pend = imp.pendingEx[name] ||
        (imp.pendingEx[name] = Object.assign({ type: '', intensity: 'moderate' }, map[name] || {}));
      pend[f] = el.value;
      if (!pend.type) { delete map[name]; return; }   // still a half-answer
      map[name] = { type: pend.type, intensity: pend.intensity };
      saveExerciseMap(map);
      remapImport();
    });

    // ---- summary checkbox + clash acknowledgement ----
    $('importSummary').addEventListener('change', e => {
      if (imp && e.target.id === 'impSetDayOne') imp.setDayOne = e.target.checked;
    });
    $('importClash').addEventListener('change', e => {
      if (!imp || e.target.id !== 'impClashAck') return;
      imp.clashAck = e.target.checked;
      $('importConfirm').disabled = !imp.clashAck || !liveRows().length;
    });

    // ---- per-row edit + delete ----
    $('importTimeline').addEventListener('input', e => {
      const el = e.target;
      const row = el.parentElement && el.parentElement.classList.contains('imp-row')
        ? el.parentElement : (el.closest ? el.closest('.imp-row') : null);
      if (!imp || !row || !el.dataset.f) return;
      const p = imp.plan.planned[+row.dataset.idx];
      if (!p) return;
      imp.edited = true;
      const f = el.dataset.f;
      if (f === 'name') p.ev.name = el.value;
      else if (f === 'time' || f === 'start') { if (el.value) p.ev[f] = el.value; }
      else if (f === 'intensity') p.ev.intensity = el.value;
      else if (f === 'duration') p.ev.duration = Math.max(1, Math.round(n0(el.value)) || 1);
      else p.ev[f] = n0(el.value);
      updateTotals();
    });
    $('importTimeline').addEventListener('click', e => {
      const btn = e.target.closest ? e.target.closest('[data-rm]') : null;
      if (!imp || !btn) return;
      const p = imp.plan.planned[+btn.dataset.rm];
      if (p) { p.removed = true; renderReview(); }
    });
  }

  // ---- init --------------------------------------------------------------
  function init() {
    $('nowSlider').max = STEPS - 1;   // span the full multi-day window
    fillDaySelects();                 // day selects must exist before a draft is restored
    wireTabs();
    setTab(activeTab);                // establish is-active / has-active before first paint
    const restored = restoreWorking();

    ['pWeight', 'pHeight', 'pAge', 'pSex', 'pTraining'].forEach(id =>
      $(id).addEventListener('input', () => { showDerived(); saveWorking(); }));
    DRAFT_FIELDS.forEach(id => { if ($(id)) $(id).addEventListener('input', saveWorking); });
    $('scenName').addEventListener('input', saveWorking);
    $('nowSlider').addEventListener('input', e => setNow(+e.target.value));
    // Running and seeing nothing change is confusing on a phone, so an explicit Run
    // jumps to Output. Only this handler switches — the run() calls behind init,
    // reset, restore and import leave the current tab alone.
    $('runBtn').onclick = () => { run(); if (tabsActive()) setTab('tabOutput'); };
    $('playBtn').onclick = togglePlay;
    $('resetBtn').onclick = () => {
      schedule = JSON.parse(JSON.stringify(window.DEFAULT_SCHEDULE));
      carryOverState = null; carryOverCarryIn = null; carryOverLabel = '';   // fresh body
      startStateStatus('');
      startDate = ''; if ($('startDate')) $('startDate').value = '';
      if ($('scenContinue')) $('scenContinue').checked = false;
      $('pWeight').value = 80; $('pHeight').value = 175; $('pAge').value = 35;
      $('pSex').value = 'male'; $('pTraining').value = 'recreational';
      renderList(); showDerived(); run(); flushWorking();
    };
    if ($('startDate')) $('startDate').addEventListener('change', e => {
      startDate = e.target.value || '';
      // Relabel only. No re-run: the date feeds nothing the model computes.
      renderList(); setNow(+$('nowSlider').value); saveWorking();
    });
    if ($('startStateImport')) $('startStateImport').addEventListener('change', e => {
      if (e.target.files[0]) importStartState(e.target.files[0]); e.target.value = '';
    });
    $('csvImport').addEventListener('change', e => { if (e.target.files[0]) importEventsCsv(e.target.files[0]); e.target.value = ''; });
    if ($('csvExport')) $('csvExport').onclick = exportEventsCsv;

    // Last chance to persist: mobile Safari may never fire unload before it
    // discards a backgrounded tab, but it does fire these.
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushWorking(); });
    window.addEventListener('pagehide', flushWorking);

    wireAdders();
    wireScenarios();
    wireImport();
    renderList();
    showDerived();
    run();
    if (restored) scenStatus('Restored your unsaved work from this browser.');
    else flushWorking();
    maybeWarnStale();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
