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
  const STEPS = window.SIM_STEPS || 288;

  const $ = id => document.getElementById(id);

  // ---- profile read / derived constants ---------------------------------
  function readProfile() {
    return {
      weight: +$('pWeight').value, height: +$('pHeight').value, age: +$('pAge').value,
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
      html += `<div class="day-group"><div class="day-head">Day ${d}</div>`;
      html += items.length
        ? items.map(({ ev, idx }) =>
            `<div class="event ${ev.type}"><span>${evLabel(ev)}</span>` +
            `<button class="del" data-del="${idx}" title="remove">✕</button></div>`).join('')
        : '<div class="event-empty muted">— no events —</div>';
      html += '</div>';
    }
    $('eventList').innerHTML = html;
    $('eventList').querySelectorAll('[data-del]').forEach(b =>
      b.onclick = () => { schedule.splice(+b.dataset.del, 1); renderList(); });
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
          kcal: +$('mKcal').value, carbs: +$('mCarb').value, protein: +$('mProt').value, fat: +$('mFat').value, alcohol: +$('mAlc').value }; }
        else if (t === 'aerobic') { daySel = 'aDay'; base = { type: 'aerobic', start: $('aStart').value, duration: +$('aDur').value, intensity: $('aInt').value }; }
        else if (t === 'resistance') { daySel = 'rDay'; base = { type: 'resistance', start: $('rStart').value, duration: +$('rDur').value, intensity: $('rInt').value }; }
        else if (t === 'sleep') { daySel = 'sDay'; base = { type: 'sleep', start: $('sStart').value, end: $('sEnd').value }; }
        for (const day of daysFrom(daySel)) schedule.push(Object.assign({ day }, base));
        renderList();
      };
    });
  }

  // ---- run --------------------------------------------------------------
  function run() {
    simData = window.runSimulation(readProfile(), schedule, carryOverState);
    window.renderCharts(simData);
    setNow(+$('nowSlider').value);
    updateContinueBanner();
  }
  function updateContinueBanner() {
    const el = $('continueBanner');
    if (!el) return;
    if (carryOverState) {
      el.textContent = '▶ Continuing from a saved end-state — glycogen, amino acids, and body fat carried over. (Reset to example to start fresh.)';
      el.style.display = '';
    } else { el.style.display = 'none'; }
  }

  // ---- now cursor / status ----------------------------------------------
  function setNow(idx) {
    idx = Math.max(0, Math.min(STEPS - 1, idx));
    $('nowSlider').value = idx;
    if (!simData) return;
    const d = simData[idx];
    $('nowLabel').textContent = d.timeLabel;
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
    if (d.alcoholInSystem > 0.01) html += cell('Alcohol in system', d.alcoholInSystem.toFixed(1) + ' g');
    html += '</div>';

    if (d.flags.length) {
      html += '<div class="flags">' + d.flags.map(f => `<div class="flag">⚑ ${f}</div>`).join('') + '</div>';
    }
    if (simData.leucineMet === false) {
      html += `<div class="flag warn">⚑ Leucine threshold: no ≥20 g protein meal within 2 h of resistance training — MPS may be sub-optimal.</div>`;
    }
    $('statusPanel').innerHTML = html;
  }
  function cell(k, v) { return `<div class="scell"><span>${k}</span><b>${v}</b></div>`; }
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
  function currentSnapshot() {
    return { app: 'metabolism-sim', profile: readProfile(),
             schedule: JSON.parse(JSON.stringify(schedule)),
             endState: (simData && simData.endState) ? simData.endState : null,
             savedAt: new Date().toISOString() };
  }
  function applySnapshot(snap) {
    if (!snap || !Array.isArray(snap.schedule)) { alert('That file is not a valid scenario.'); return; }
    const p = snap.profile || {};
    if (p.weight) $('pWeight').value = p.weight;
    if (p.height) $('pHeight').value = p.height;
    if (p.age) $('pAge').value = p.age;
    if (p.sex) $('pSex').value = p.sex;
    if (p.training) $('pTraining').value = p.training;
    schedule = JSON.parse(JSON.stringify(snap.schedule));
    // "Continue" starts the next 5 days from the saved end-state; otherwise fresh.
    const wantContinue = $('scenContinue') && $('scenContinue').checked;
    if (wantContinue && snap.endState) carryOverState = snap.endState;
    else {
      carryOverState = null;
      if (wantContinue && !snap.endState)
        alert('This scenario was saved before "Continue" was supported (no end-state stored), so it will load fresh. Re-run and re-save it to enable continuation.');
    }
    renderList(); showDerived(); run();
  }
  function renderScenarios() {
    const store = loadStore();
    const names = Object.keys(store).sort((a, b) => a.localeCompare(b));
    $('scenList').innerHTML = names.length
      ? names.map((n, i) => {
          const when = store[n].savedAt ? new Date(store[n].savedAt).toLocaleString() : '';
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
    store[name] = currentSnapshot();
    if (saveStore(store)) { $('scenName').value = ''; renderScenarios(); }
  }
  function exportScenario() {
    const name = ($('scenName').value || '').trim() || 'scenario';
    const data = currentSnapshot(); data.name = name;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name.replace(/[^\w.-]+/g, '_') + '.json';
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
  function importScenario(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let snap; try { snap = JSON.parse(reader.result); } catch (e) { alert('Could not read that file — it is not valid scenario JSON.'); return; }
      applySnapshot(snap);
      if (snap.name) $('scenName').value = snap.name;
    };
    reader.readAsText(file);
  }
  function wireScenarios() {
    $('scenSave').onclick = saveScenario;
    $('scenName').addEventListener('keydown', e => { if (e.key === 'Enter') saveScenario(); });
    $('scenExport').onclick = exportScenario;
    $('scenImport').addEventListener('change', e => { if (e.target.files[0]) importScenario(e.target.files[0]); e.target.value = ''; });
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
          let dur = 30;
          if (endRaw) { const d = hh(endRaw) - hh(timeRaw); if (d > 0) dur = d; }   // no End -> 30 min
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

      renderList();
      const bits = [`Imported ${added} event${added !== 1 ? 's' : ''}`];
      if (ignored) bits.push(`${ignored} row${ignored !== 1 ? 's' : ''} skipped`);
      if (outOfRange) bits.push(`${outOfRange} beyond day ${DAYS} skipped`);
      $('csvStatus').textContent = bits.join(' · ') + (added ? '. Review the list, delete any duplicates, then Run simulation.' : '.');
    };
    reader.readAsText(file);
  }

  // ---- init --------------------------------------------------------------
  function init() {
    $('nowSlider').max = STEPS - 1;   // span the full multi-day window
    ['pWeight', 'pHeight', 'pAge', 'pSex', 'pTraining'].forEach(id => $(id).addEventListener('input', showDerived));
    $('nowSlider').addEventListener('input', e => setNow(+e.target.value));
    $('runBtn').onclick = run;
    $('playBtn').onclick = togglePlay;
    $('resetBtn').onclick = () => {
      schedule = JSON.parse(JSON.stringify(window.DEFAULT_SCHEDULE));
      carryOverState = null;                                  // back to a fresh body
      if ($('scenContinue')) $('scenContinue').checked = false;
      $('pWeight').value = 80; $('pHeight').value = 175; $('pAge').value = 35;
      $('pSex').value = 'male'; $('pTraining').value = 'recreational';
      renderList(); showDerived(); run();
    };
    $('csvImport').addEventListener('change', e => { if (e.target.files[0]) importEventsCsv(e.target.files[0]); e.target.value = ''; });
    fillDaySelects();
    wireAdders();
    wireScenarios();
    renderList();
    showDerived();
    run();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
