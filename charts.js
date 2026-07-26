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
   charts.js — Chart.js rendering (Sections 4 & 5)
   Exposes: window.renderCharts(simData), window.updateNowLine(index)
   ========================================================================= */
(function () {
  'use strict';

  const COLORS = {
    gutGlucose: '#4CAF50', liver: '#FF9800', muscle: '#FF5722',
    gng: '#795548', adipose: '#E91E63', gutFat: '#F48FB1', alcohol: '#607D8B'
  };

  let charts = {};
  let currentData = null;
  let nowIndex = 0;

  const STEPS = window.SIM_STEPS || 288;
  const DAYS = window.SIM_DAYS || 1;
  const STEPS_PER_DAY = window.SIM_STEPS_PER_DAY || STEPS;

  const labels = () => currentData.map(d => d.timeLabel);
  // Over a multi-day span, label each midnight "Day N" plus a noon tick.
  const tickCb = (val, idx) => {
    if (idx % STEPS_PER_DAY === 0) return 'Day ' + (idx / STEPS_PER_DAY + 1);
    if (idx % STEPS_PER_DAY === STEPS_PER_DAY / 2) return '12:00';
    return '';
  };

  // ---- background plugin: sleep/exercise bands, meal lines, now cursor ----
  const bandsPlugin = {
    id: 'bands',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: area, scales: { x } } = chart;
      if (!currentData || !area) return;
      const tl = currentData.timeline;
      const total = tl.totalMin || (STEPS * 5);
      const idxOf = min => Math.max(0, Math.min(STEPS - 1, Math.round(min / 5)));

      ctx.save();
      // sleep bands (dark) — expanded events are absolute with start < end
      ctx.fillStyle = 'rgba(40,50,80,0.18)';
      for (const s of tl.sleeps) rect(s.start, s.end);
      // aerobic bands (blue tint) / resistance (violet tint)
      for (const e of tl.aerobics) { ctx.fillStyle = 'rgba(33,150,243,0.12)'; rect(e.start, e.start + e.dur); }
      for (const e of tl.resistances) { ctx.fillStyle = 'rgba(156,39,176,0.12)'; rect(e.start, e.start + e.dur); }

      function rect(a, b) {
        if (b <= 0 || a >= total) return;                 // fully outside the window
        const xa = x.getPixelForValue(idxOf(a)), xb = x.getPixelForValue(idxOf(b));
        if (xb > xa) ctx.fillRect(xa, area.top, xb - xa, area.bottom - area.top);
      }

      // day-boundary divider lines
      ctx.strokeStyle = 'rgba(0,0,0,0.16)'; ctx.setLineDash([]); ctx.lineWidth = 1;
      for (let d = 1; d < DAYS; d++) {
        const xp = x.getPixelForValue(d * STEPS_PER_DAY);
        ctx.beginPath(); ctx.moveTo(xp, area.top); ctx.lineTo(xp, area.bottom); ctx.stroke();
      }

      // meal vertical dashed lines (skip the day -1 priming meals)
      ctx.strokeStyle = 'rgba(120,120,120,0.5)';
      ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      for (const meal of tl.meals) {
        if (meal.min < 0 || meal.min > total) continue;
        const xp = x.getPixelForValue(idxOf(meal.min));
        ctx.beginPath(); ctx.moveTo(xp, area.top); ctx.lineTo(xp, area.bottom); ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();
    },
    afterDatasetsDraw(chart) {
      const { ctx, chartArea: area, scales: { x } } = chart;
      if (!currentData || !area) return;
      // "now" cursor
      const xp = x.getPixelForValue(nowIndex);
      ctx.save();
      ctx.strokeStyle = '#111'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(xp, area.top); ctx.lineTo(xp, area.bottom); ctx.stroke();
      ctx.fillStyle = '#111';
      ctx.beginPath(); ctx.moveTo(xp - 4, area.top); ctx.lineTo(xp + 4, area.top); ctx.lineTo(xp, area.top + 6); ctx.fill();
      ctx.restore();
    }
  };

  function baseOpts(extra) {
    return Object.assign({
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      animation: false,
      plugins: {
        legend: { labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: {} }
      },
      scales: {
        x: { ticks: { callback: tickCb, maxRotation: 0, autoSkip: false, font: { size: 10 } }, grid: { display: false } }
      }
    }, extra || {});
  }

  function area(dataFn, color, label, extra) {
    return Object.assign({
      label, data: currentData.map(dataFn),
      backgroundColor: color, borderColor: color, borderWidth: 0,
      fill: true, pointRadius: 0, tension: 0.25, stack: 'stack'
    }, extra || {});
  }

  function renderCharts(simData) {
    currentData = simData;
    Object.values(charts).forEach(c => c && c.destroy());
    charts = {};

    // ---------- Chart 1: Substrate trace (stacked %) + glycogen lines ----
    const pct = f => currentData.map(d => d.fractions[f] * 100);
    charts.trace = new Chart(document.getElementById('chartTrace'), {
      type: 'line',
      data: {
        labels: labels(),
        datasets: [
          stackArea('Gut glucose', pct('gutGlucose'), COLORS.gutGlucose),
          stackArea('Liver glycogen', pct('liver'), COLORS.liver),
          stackArea('Muscle glycogen', pct('muscle'), COLORS.muscle),
          stackArea('Gluconeogenesis', pct('gng'), COLORS.gng),
          stackArea('Dietary fat', pct('gutFat'), COLORS.gutFat),
          stackArea('Adipose fat', pct('adipose'), COLORS.adipose),
          stackArea('Alcohol', pct('alcohol'), COLORS.alcohol),
          glyLine('Liver glycogen (g)', d => d.liverGlycogen, COLORS.liver),
          glyLine('Muscle glycogen (g)', d => d.muscleGlycogen, COLORS.muscle)
        ]
      },
      options: baseOpts({
        scales: {
          x: baseOpts().scales.x,
          y: { stacked: true, min: 0, max: 100, title: { display: true, text: '% of energy' }, ticks: { font: { size: 10 } } },
          yG: { position: 'right', min: 0, max: currentData.constants.MUSCLE_GLYCOGEN_MAX, title: { display: true, text: 'glycogen (g)' }, grid: { drawOnChartArea: false }, ticks: { font: { size: 10 } } }
        },
        plugins: { legend: { labels: { boxWidth: 12, font: { size: 10 } } } }
      }),
      plugins: [bandsPlugin]
    });

    // ---------- Chart 2: Insulin index + glucose proxy -------------------
    charts.insulin = new Chart(document.getElementById('chartInsulin'), {
      type: 'line',
      data: {
        labels: labels(),
        datasets: [
          { label: 'Insulin index (0–10)', data: currentData.map(d => d.insulin), borderColor: '#2196F3', backgroundColor: 'rgba(33,150,243,0.12)', fill: true, pointRadius: 0, borderWidth: 2, tension: 0.3 },
          { label: 'Blood glucose (mg/dL proxy)', data: currentData.map(d => d.glucoseMgdl), borderColor: '#E53935', backgroundColor: 'transparent', fill: false, pointRadius: 0, borderWidth: 1.5, tension: 0.3, yAxisID: 'yG' }
        ]
      },
      options: baseOpts({
        scales: {
          x: baseOpts().scales.x,
          y: { min: 0, max: 10, title: { display: true, text: 'insulin index' } },
          yG: { position: 'right', min: 40, max: 180, title: { display: true, text: 'mg/dL' }, grid: { drawOnChartArea: false } }
        }
      }),
      plugins: [bandsPlugin]
    });

    // ---------- Chart 3: Glycogen stores --------------------------------
    const lMax = currentData.constants.LIVER_GLYCOGEN_MAX, mMax = currentData.constants.MUSCLE_GLYCOGEN_MAX;
    charts.glycogen = new Chart(document.getElementById('chartGlycogen'), {
      type: 'line',
      data: {
        labels: labels(),
        datasets: [
          { label: 'Liver glycogen (g)', data: currentData.map(d => d.liverGlycogen), borderColor: COLORS.liver, backgroundColor: 'transparent', fill: false, pointRadius: 0, borderWidth: 2, tension: 0.3 },
          { label: 'Muscle glycogen (g)', data: currentData.map(d => d.muscleGlycogen), borderColor: COLORS.muscle, backgroundColor: 'transparent', fill: false, pointRadius: 0, borderWidth: 2, tension: 0.3, yAxisID: 'yM' }
        ]
      },
      options: baseOpts({
        scales: {
          x: baseOpts().scales.x,
          y: { position: 'left', min: 0, max: lMax, title: { display: true, text: 'liver (g)' } },
          yM: { position: 'right', min: 0, max: mMax, title: { display: true, text: 'muscle (g)' }, grid: { drawOnChartArea: false } }
        }
      }),
      plugins: [bandsPlugin, refLinesPlugin(lMax, mMax)]
    });

    // ---------- Chart 4: MPS activity -----------------------------------
    charts.mps = new Chart(document.getElementById('chartMps'), {
      type: 'line',
      data: {
        labels: labels(),
        datasets: [{
          label: 'MPS rate (g/min)', data: currentData.map(d => d.mpsRate),
          borderColor: '#2E7D32', pointRadius: 0, borderWidth: 2, tension: 0.25,
          fill: true,
          backgroundColor: ctx => {
            const c = ctx.chart, { ctx: cc, chartArea } = c;
            if (!chartArea) return 'rgba(76,175,80,0.3)';
            const g = cc.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
            g.addColorStop(0, 'rgba(150,150,150,0.15)'); g.addColorStop(1, 'rgba(46,125,50,0.5)');
            return g;
          }
        }]
      },
      options: baseOpts({
        scales: { x: baseOpts().scales.x, y: { min: 0, suggestedMax: 0.016, title: { display: true, text: 'g/min' } } }
      }),
      plugins: [bandsPlugin]
    });

    // ---------- Chart 5: Calorie balance --------------------------------
    charts.balance = new Chart(document.getElementById('chartBalance'), {
      type: 'line',
      data: {
        labels: labels(),
        datasets: [
          { label: 'Cumulative consumed (kcal)', data: currentData.map(d => d.cumConsumed), borderColor: '#43A047', backgroundColor: 'transparent', fill: false, pointRadius: 0, borderWidth: 2, tension: 0 },
          { label: 'Cumulative expended (kcal)', data: currentData.map(d => d.cumExpended), borderColor: '#E53935', backgroundColor: 'transparent', fill: '-1', pointRadius: 0, borderWidth: 2, tension: 0,
            segment: {}, }
        ]
      },
      options: baseOpts({
        plugins: { legend: baseOpts().plugins.legend,
          tooltip: { callbacks: { afterBody: items => {
            const idx = items[0].dataIndex; const d = currentData[idx];
            const bal = d.cumConsumed - d.cumExpended;
            return (bal >= 0 ? 'Surplus: +' : 'Deficit: ') + Math.round(bal) + ' kcal';
          } } } },
        scales: { x: baseOpts().scales.x, y: { title: { display: true, text: 'kcal' } } }
      }),
      plugins: [bandsPlugin, balanceFillPlugin]
    });

    updateNowLine(nowIndex);
  }

  function stackArea(label, data, color) {
    return { label, data, backgroundColor: hexA(color, 0.75), borderColor: color, borderWidth: 0, fill: true, pointRadius: 0, tension: 0.2, stack: 's', yAxisID: 'y' };
  }
  function glyLine(label, fn, color) {
    return { label, data: currentData.map(fn), borderColor: color, backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [5, 3], fill: false, pointRadius: 0, tension: 0.3, yAxisID: 'yG', stack: false };
  }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // reference lines at 20% and 50% for glycogen chart
  function refLinesPlugin(lMax, mMax) {
    return {
      id: 'reflines',
      beforeDatasetsDraw(chart) {
        const { ctx, chartArea: a, scales } = chart;
        ctx.save(); ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
        for (const frac of [0.5, 0.2]) {
          const yp = scales.y.getPixelForValue(lMax * frac);
          ctx.strokeStyle = frac === 0.2 ? 'rgba(229,57,53,0.5)' : 'rgba(150,150,150,0.5)';
          ctx.beginPath(); ctx.moveTo(a.left, yp); ctx.lineTo(a.right, yp); ctx.stroke();
        }
        ctx.restore();
      }
    };
  }

  // green/red fill between consumed & expended
  const balanceFillPlugin = {
    id: 'balancefill',
    beforeDatasetsDraw(chart) {
      const { ctx, scales: { x, y } } = chart;
      const cons = currentData.map(d => d.cumConsumed), exp = currentData.map(d => d.cumExpended);
      ctx.save();
      for (let i = 1; i < currentData.length; i++) {
        const surplus = cons[i] >= exp[i];
        ctx.fillStyle = surplus ? 'rgba(76,175,80,0.15)' : 'rgba(229,57,53,0.15)';
        ctx.beginPath();
        ctx.moveTo(x.getPixelForValue(i - 1), y.getPixelForValue(cons[i - 1]));
        ctx.lineTo(x.getPixelForValue(i), y.getPixelForValue(cons[i]));
        ctx.lineTo(x.getPixelForValue(i), y.getPixelForValue(exp[i]));
        ctx.lineTo(x.getPixelForValue(i - 1), y.getPixelForValue(exp[i - 1]));
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
  };

  function updateNowLine(index) {
    nowIndex = index;
    Object.values(charts).forEach(c => c && c.draw());
  }

  // Chart.js measures its container on creation. A chart built while its panel is
  // display:none comes out zero-width and renders blank or as a sliver, so the tab
  // switch has to re-measure once the panel is actually laid out.
  function resizeCharts() {
    Object.values(charts).forEach(c => { if (c) c.resize(); });
  }

  window.renderCharts = renderCharts;
  window.updateNowLine = updateNowLine;
  window.resizeCharts = resizeCharts;
})();
