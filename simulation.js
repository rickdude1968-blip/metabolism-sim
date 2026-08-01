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
   simulation.js — multi-day metabolic simulation engine
   Implements Sections 3A–3G of the model spec.

   The daily schedule (meals / exercise / sleep, given as HH:MM) is repeated
   across DAYS calendar days and run as ONE continuous simulation, so glycogen
   stores, amino-acid pool, and the calorie balance carry over from night to
   night — letting cumulative multi-day effects emerge.

   Exposes globally (no ES-module imports, so it works from file:// directly):
     window.runSimulation(profile, schedule) -> Array(STEPS) of timestep objects
     window.DEFAULT_PROFILE, window.DEFAULT_SCHEDULE, window.SIM_DAYS, window.SIM_STEPS
   ========================================================================= */
(function () {
  'use strict';

  const TIMESTEP = 5;                             // minutes per step
  const DAYS = 5;                                 // number of days to simulate
  const MINS_PER_DAY = 1440;
  const STEPS_PER_DAY = MINS_PER_DAY / TIMESTEP;  // 288
  const STEPS = STEPS_PER_DAY * DAYS;             // 1440 steps for 5 days
  const KCAL_CARB = 4;
  const KCAL_FAT = 9;
  const KCAL_ALCOHOL = 7;
  // Below this the pool is a pharmacologically meaningless trace: it is still
  // oxidized (so the tail of an absorption curve can never strand), but it does
  // not suppress fat oxidation and is not reported. Flag, on-screen readout and
  // the metabolic effect all use this one threshold, so they can never disagree.
  const ALCOHOL_REPORT_MIN = 0.05;   // grams

  // ---- utility ------------------------------------------------------------
  function hhmmToMin(s) {
    if (typeof s === 'number') return s;
    const [h, m] = String(s).split(':').map(Number);
    return h * 60 + (m || 0);
  }
  function minToLabel(m) {
    m = ((m % 1440) + 1440) % 1440;
    const h = Math.floor(m / 60), mm = m % 60;
    return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }
  // Absolute-minute label including which day, e.g. "D2 07:00".
  function stampLabel(absMin) {
    const day = Math.floor(absMin / MINS_PER_DAY);
    return 'D' + (day + 1) + ' ' + minToLabel(absMin);
  }
  // Is minute `m` inside interval [start,end) allowing midnight wrap.
  function inInterval(m, start, end) {
    if (start === end) return false;
    if (start < end) return m >= start && m < end;
    return m >= start || m < end;    // wraps midnight
  }
  // Elapsed minutes since `start`, allowing wrap.
  function elapsedSince(m, start) {
    return ((m - start) % 1440 + 1440) % 1440;
  }

  // ---- derived constants (Section 1) -------------------------------------
  function computeConstants(p) {
    const w = p.weight, h = p.height, a = p.age;
    let bmr = 10 * w + 6.25 * h - 5 * a + (p.sex === 'female' ? -161 : 5);

    const muscleMax = {
      sedentary: 300 + (w - 70) * 2,
      recreational: 375 + (w - 70) * 2.5,
      trained: 450 + (w - 70) * 3,
      athlete: 500 + (w - 70) * 3.5
    }[p.training];

    const fatOxCap = {
      sedentary: 0.07, recreational: 0.09, trained: 0.12, athlete: 0.15
    }[p.training];

    // Estimated body-fat mass (g) via Deurenberg: BF% = 1.20·BMI + 0.23·age
    // − 10.8·(male?1:0) − 5.4. Used as the starting fat reserve so that fat
    // oxidation can draw it down and storage can build it up.
    const bmi = w / Math.pow(h / 100, 2);
    let bfPct = 1.20 * bmi + 0.23 * a - 10.8 * (p.sex === 'female' ? 0 : 1) - 5.4;
    bfPct = Math.max(6, Math.min(55, bfPct));           // keep in a sane range
    const bodyFat_g = w * (bfPct / 100) * 1000;

    return {
      BMR: bmr,
      BMR_PER_MIN: bmr / 1440,
      LIVER_GLYCOGEN_MAX: 100,
      MUSCLE_GLYCOGEN_MAX: Math.max(150, muscleMax),
      FAT_OXIDATION_CAPACITY: fatOxCap,
      BODY_FAT_G: bodyFat_g,
      BODY_FAT_PCT: bfPct
    };
  }

  // ---- gamma-shaped absorption kernel (Section 3A) -----------------------
  // Mass-conserving gamma(2) kernel: peaks at τ=peak and integrates to `grams`
  // over its full support, so the total mass entering circulation equals the
  // grams eaten (minus the small tail truncated beyond `cutoff`).
  //
  // NOTE: the spec's literal formula used exp(1 - τ/peak); that peaks at the
  // right time but its AREA is grams*e (~2.718x), so ~2.7x the mass eaten was
  // being absorbed. That inflated every macronutrient — most visibly ethanol,
  // whose fixed 0.1 g/min clearance then took ~2.7x too long. Dropping the
  // exp(1) factor (exp(1-x) = e*exp(-x)) normalizes the area to `grams`.
  function gammaRate(grams, tau, peak, cutoff) {
    if (tau < 0 || tau > cutoff) return 0;
    const x = tau / peak;
    return grams * x * Math.exp(-x) / peak;
  }

  // ---- activity timeline (Sections 3C/3D) --------------------------------
  const AEROBIC_MET = { light: 3.5, moderate: 6.0, vigorous: 10.0 };
  const RESIST_MET = { light: 3.0, moderate: 5.0, hard: 6.5 };
  const AEROBIC_FATFRAC = { light: 0.65, moderate: 0.45, vigorous: 0.20 };

  // `carryIn` (optional) is the list of REAL trailing events from a previous
  // block, each with `minutesBefore` = how long before this run's t=0 it began.
  // Pass an array (possibly empty) to mark this as a CONTINUED run: the
  // fabricated "night before day 1" priming is then suppressed, because the
  // carried state plus these real events already describe the history.
  // Pass null/undefined for a fresh run, which keeps the priming fiction.
  function buildTimeline(schedule, carryIn) {
    const meals = [], aerobics = [], resistances = [], sleeps = [];

    // Place one event at ABSOLUTE minutes, based on its (1-indexed) day.
    // dayOverride lets us also drop a copy on the "night before day 1" (day 0).
    function place(ev, dayOverride) {
      const day = dayOverride != null ? dayOverride : (+ev.day || 1);
      const off = (day - 1) * MINS_PER_DAY;
      if (ev.type === 'meal') meals.push({
        min: hhmmToMin(ev.time) + off, day,
        kcal: +ev.kcal || 0, carbs: +ev.carbs || 0, protein: +ev.protein || 0,
        fat: +ev.fat || 0, alcohol: +ev.alcohol || 0, name: ev.name || 'Meal'
      });
      else if (ev.type === 'aerobic') aerobics.push({
        start: hhmmToMin(ev.start) + off, dur: +ev.duration || 0, intensity: ev.intensity, day
      });
      else if (ev.type === 'resistance') resistances.push({
        start: hhmmToMin(ev.start) + off, dur: +ev.duration || 0, intensity: ev.intensity, day
      });
      else if (ev.type === 'sleep') {
        const s = hhmmToMin(ev.start);
        let e = hhmmToMin(ev.end);
        if (e <= s) e += MINS_PER_DAY;             // wraps past midnight
        sleeps.push({ start: s + off, end: e + off, day });
      }
    }

    // Place a carry-in event at NEGATIVE absolute minutes, `minutesBefore`
    // ahead of this run's t=0.
    function placeCarryIn(ev) {
      const at = -Math.abs(+ev.minutesBefore || 0);
      if (ev.type === 'meal') meals.push({
        min: at, day: 0, carryIn: true,
        kcal: +ev.kcal || 0, carbs: +ev.carbs || 0, protein: +ev.protein || 0,
        fat: +ev.fat || 0, alcohol: +ev.alcohol || 0, name: ev.name || 'Meal'
      });
      else if (ev.type === 'aerobic') aerobics.push({
        start: at, dur: +ev.duration || 0, intensity: ev.intensity, day: 0, carryIn: true
      });
      else if (ev.type === 'resistance') resistances.push({
        start: at, dur: +ev.duration || 0, intensity: ev.intensity, day: 0, carryIn: true
      });
      else if (ev.type === 'sleep') sleeps.push({
        start: at, end: at + (+ev.duration || 0), day: 0, carryIn: true
      });
    }

    for (const ev of schedule) place(ev);
    if (carryIn) {
      // Continued run — real history, no fabrication.
      for (const ev of carryIn) placeCarryIn(ev);
    } else {
      // Fresh run — prime the night before day 1 using day-1 events shifted back
      // one day, so the first morning inherits overnight sleep + prior meals.
      for (const ev of schedule) if ((+ev.day || 1) === 1) place(ev, 0);
    }

    meals.sort((a, b) => a.min - b.min);
    const totalMin = MINS_PER_DAY * DAYS;

    // Per-session leucine adequacy: a >=20 g protein meal within +/-2 h of the
    // session start (evaluated on the absolute timeline, so it respects the day).
    for (const r of resistances)
      r.leucine = meals.some(me => me.protein >= 20 && Math.abs(me.min - r.start) <= 120);

    return {
      meals, aerobics, resistances, sleeps,
      totalMin
    };
  }

  // Harvest the real trailing events around a boundary so the NEXT block can
  // reproduce this one's history exactly. 48 h covers every history-dependent
  // mechanism in the model: MPS elevation (48 h), absorption tails (<=6 h),
  // EPOC (90 min) and the Cori-cycle lactate flush (120 min).
  const CARRY_IN_WINDOW = 2880;                       // minutes (48 h)
  function buildCarryIn(tl, boundaryMin, windowMin) {
    const W = windowMin || CARRY_IN_WINDOW;
    const out = [];
    const near = t => t <= boundaryMin && (boundaryMin - t) <= W;
    for (const m of tl.meals) if (near(m.min)) out.push({
      type: 'meal', minutesBefore: boundaryMin - m.min, name: m.name,
      kcal: m.kcal, carbs: m.carbs, protein: m.protein, fat: m.fat, alcohol: m.alcohol
    });
    for (const e of tl.aerobics) if (near(e.start)) out.push({
      type: 'aerobic', minutesBefore: boundaryMin - e.start, duration: e.dur, intensity: e.intensity
    });
    for (const e of tl.resistances) if (near(e.start)) out.push({
      type: 'resistance', minutesBefore: boundaryMin - e.start, duration: e.dur, intensity: e.intensity
    });
    // Only a sleep still in progress at the boundary matters (the sleeper wakes
    // up inside the next block); earlier sleeps can't affect any future step.
    for (const s of tl.sleeps) if (s.start <= boundaryMin && s.end > boundaryMin) out.push({
      type: 'sleep', minutesBefore: boundaryMin - s.start, duration: s.end - s.start
    });
    return out;
  }

  // Determine what the body is doing at minute m.
  function activityAt(m, tl) {
    // exercise takes precedence
    for (const e of tl.aerobics)
      if (m >= e.start && m < e.start + e.dur)
        return { kind: 'aerobic', intensity: e.intensity, met: AEROBIC_MET[e.intensity],
                 fatFrac: AEROBIC_FATFRAC[e.intensity] };
    for (const e of tl.resistances)
      if (m >= e.start && m < e.start + e.dur)
        return { kind: 'resistance', intensity: e.intensity, met: RESIST_MET[e.intensity],
                 fatFrac: 0.10 };
    for (const s of tl.sleeps)               // expanded sleeps are absolute, start < end
      if (m >= s.start && m < s.end)
        return { kind: 'sleep', met: 0.9, fatFrac: 0.75 };
    return { kind: 'sedentary', met: 1.2, fatFrac: 0.70 };
  }

  // EPOC multiplier applied to sedentary demand after an exercise ends.
  function epocMultiplier(m, tl) {
    let mult = 1.0;
    for (const e of tl.aerobics) {
      const end = e.start + e.dur, dt = m - end;
      if (dt >= 0 && dt < 30) mult = Math.max(mult, 1.15);
      else if (dt >= 30 && dt < 60) mult = Math.max(mult, 1.07);
    }
    for (const e of tl.resistances) {
      const end = e.start + e.dur, dt = m - end;
      if (dt >= 0 && dt < 45) mult = Math.max(mult, 1.10);
      else if (dt >= 45 && dt < 90) mult = Math.max(mult, 1.05);
    }
    return mult;
  }

  // ---- gluconeogenesis precursor rates (Section 2) -----------------------
  // Lactate (Cori cycle): activity-driven base rate, g glucose/min.
  function lactateGngBase(act) {
    if (act.kind === 'aerobic') return { light: 0.07, moderate: 0.12, vigorous: 0.10 }[act.intensity];
    if (act.kind === 'resistance') return { light: 0.08, moderate: 0.13, hard: 0.14 }[act.intensity];
    if (act.kind === 'sleep') return 0.03;
    return 0.04; // sedentary
  }
  // Post-exercise Cori-cycle "flush": a decaying lactate load cleared after
  // exercise ends. Resistance leaves a larger, longer debt than aerobic.
  function lactateFlush(m, tl) {
    let f = 0;
    for (const e of tl.aerobics) { const dt = m - (e.start + e.dur); if (dt >= 0 && dt < 60) f += 0.08 * Math.exp(-dt / 30); }
    for (const e of tl.resistances) { const dt = m - (e.start + e.dur); if (dt >= 0 && dt < 120) f += 0.12 * Math.exp(-dt / 40); }
    return f;
  }

  // ---- MPS time course after exercise (Section 3F) -----------------------
  // Elevation rises to a peak a few hours post-exercise, then decays back toward
  // baseline — a resistance session stays meaningfully elevated for ~24-48 h,
  // hard aerobic for ~12 h. Returns a 0..1 multiplier on the peak elevation.
  function resistanceMpsFactor(dtMin) {
    if (dtMin < 30 || dtMin > 2880) return 0;          // active 30 min .. 48 h
    const h = dtMin / 60;
    if (h <= 3) return 0.5 + 0.5 * (h - 0.5) / 2.5;    // rise 0.5 -> 1.0 over 0.5-3 h
    return Math.exp(-(h - 3) / 14);                    // decay (~14 h constant)
  }
  function aerobicMpsFactor(dtMin) {
    if (dtMin < 30 || dtMin > 720) return 0;           // active 30 min .. 12 h
    const h = dtMin / 60;
    if (h <= 2) return 0.5 + 0.5 * (h - 0.5) / 1.5;    // rise 0.5 -> 1.0 over 0.5-2 h
    return Math.exp(-(h - 2) / 5);                     // decay (~5 h constant)
  }

  // sleep GH window: hours 1–3 after sleep onset
  function ghActive(m, tl) {
    for (const s of tl.sleeps) {
      if (m >= s.start && m < s.end) {
        const el = m - s.start;
        if (el >= 60 && el <= 180) return true;
      }
    }
    return false;
  }

  // ========================================================================
  //  MAIN SIMULATION
  // ========================================================================
  // `initialState` (optional) seeds the starting body state so a run can
  // CONTINUE from a previous one: glycogen / amino pool / insulin / alcohol /
  // body fat carry over, while the charts and cumulative counters reset fresh.
  function runSimulation(profile, schedule, initialState, carryInEvents) {
    const C = computeConstants(profile);
    // Supplying an initialState marks this as a CONTINUED run, which suppresses
    // the fabricated day-0 priming; carryInEvents then supply the real history.
    const tl = buildTimeline(schedule, initialState ? (carryInEvents || []) : null);
    // Overall leucine verdict across the real (within-window) resistance sessions:
    // null = no resistance training; true = every session well-timed; false = one or more missed.
    const realRes = tl.resistances.filter(r => r.start >= 0 && r.start < tl.totalMin);
    const leucine = realRes.length ? realRes.every(r => r.leucine) : null;

    const IS = initialState || null;
    const pick = (v, dflt) => (typeof v === 'number' && isFinite(v)) ? v : dflt;

    // ---- state (defaults, or carried over from a previous run) ---------
    let liver = pick(IS && IS.liver, C.LIVER_GLYCOGEN_MAX);   // fresh runs start full
    let muscle = pick(IS && IS.muscle, C.MUSCLE_GLYCOGEN_MAX);
    let aminoPool = pick(IS && IS.aminoPool, 0);
    let insulin = pick(IS && IS.insulin, 0.5);                 // baseline
    let alcoholInSystem = pick(IS && IS.alcoholInSystem, 0);
    let fatStored_g = pick(IS && IS.fatStored_g, C.BODY_FAT_G); // real body-fat reserve
    const fatStartReserve = fatStored_g;
    let cumSurplusGlucose = 0;     // running total across the whole run (chart resets)
    let daySurplusGlucose = 0;     // resets each midnight (per-day, per spec)
    let cumConsumed = 0, cumExpended = 0;

    const INSULIN_BASELINE = 0.5;
    const INSULIN_DECAY = Math.exp(-TIMESTEP / 90);
    // Gain that turns the spec's per-step contribution into the intended
    // magnitude. Calibrated so a 60 g carb bolus peaks at insulin index ~4.5
    // (spec 3B target "~4-5"); a 52 g breakfast peaks ~3.9. (Re-tuned upward
    // after the absorption kernel was mass-normalized — see gammaRate.)
    const INSULIN_GAIN = 10.2;
    const LIVER_OUTPUT_MAX = 1.5 * TIMESTEP;   // 7.5 g / step
    const MUSCLE_REFILL_MAX = 0.5 * TIMESTEP;  // 2.5 g / step
    const ETHANOL_RATE_G = 0.1 * TIMESTEP;     // 0.5 g / step (zero-order)

    // last meal minute lookup (for phase logic)
    const out = [];

    for (let i = 0; i < STEPS; i++) {
      const m = i * TIMESTEP;
      if (m > 0 && m % MINS_PER_DAY === 0) daySurplusGlucose = 0;   // new day → reset
      const act = activityAt(m, tl);
      const sleeping = act.kind === 'sleep';
      const exercising = act.kind === 'aerobic' || act.kind === 'resistance';

      // ---- 3A. gut absorption (sum across meals) ----------------------
      let aCarb = 0, aProt = 0, aFat = 0, aAlc = 0;
      let lastMealMin = -99999, lastMealName = null;
      for (const meal of tl.meals) {         // meals are absolute across all days
        const tau = m - meal.min;
        aCarb += gammaRate(meal.carbs, tau, 45, 240);
        aProt += gammaRate(meal.protein, tau, 90, 300);
        aFat  += gammaRate(meal.fat, tau, 120, 360);
        if (meal.alcohol) aAlc += gammaRate(meal.alcohol, tau, 20, 240);
        if (meal.min <= m && meal.min > lastMealMin) { lastMealMin = meal.min; lastMealName = meal.name; }
      }
      const gutActive = (aCarb + aProt + aFat + aAlc) > 0.01;
      const minsSinceMeal = lastMealMin > -99999 ? (m - lastMealMin) : 99999;
      // Hours since the last meal finished absorbing (~4 h carb absorption);
      // carried continuously across nights and days.
      const hoursFasted = Math.max(0, (m - (lastMealMin > -99999 ? lastMealMin : 0)) / 60 - 4);

      // protein absorbed -> amino acid pool (cap 30 g)
      aminoPool = Math.min(30, aminoPool + aProt * TIMESTEP);
      // alcohol absorbed -> system
      alcoholInSystem += aAlc * TIMESTEP;

      // ---- 3B. insulin -----------------------------------------------
      let insulinInput = (aCarb * 0.08 + aProt * 0.03) * INSULIN_GAIN;
      insulin = insulin * INSULIN_DECAY + insulinInput;
      if (act.kind === 'aerobic') insulin *= 0.5;   // GLUT4 independent uptake
      insulin = Math.max(INSULIN_BASELINE, Math.min(10, insulin));

      // ---- 3C. energy demand -----------------------------------------
      let demandPerMin = C.BMR_PER_MIN * act.met;
      if (act.kind === 'sedentary') demandPerMin *= epocMultiplier(m, tl);
      let demandKcal = demandPerMin * TIMESTEP;
      cumExpended += demandKcal;

      // ---- 3D step 1&2. fat/carb split + insulin suppression ----------
      const insulinSuppressor = 1 - (insulin / 10) * 0.85;
      let fatFrac = act.fatFrac * insulinSuppressor;

      // ---- 3E. alcohol override --------------------------------------
      // The pool at the START of the step is what governs this step's
      // metabolism, so the flag, the on-screen number and the fat suppression
      // are all derived from it (previously the flag used the pre-burn pool
      // while the display used the post-burn one, so they disagreed for a few
      // steps at the end of every drinking episode).
      const alcoholAtStepStart = alcoholInSystem;
      const alcoholActive = alcoholAtStepStart >= ALCOHOL_REPORT_MIN;
      if (alcoholActive) fatFrac *= 0.25;          // NADH suppresses beta-oxidation
      fatFrac = Math.max(0, Math.min(1, fatFrac));
      let carbFrac = 1 - fatFrac;
      // Hard ceiling on fat oxidation while ethanol is on board; later stages
      // must not raise fat use back above it.
      const alcoholFatCeiling = alcoholActive ? fatFrac : 1;

      // obligatory ethanol oxidation first (displaces other fuels)
      let ethanolKcal = 0;
      // No lower gate: whatever ethanol is present gets oxidized, so the thin
      // tail of an absorption curve arriving after the pool empties cannot be
      // left stranded in the body forever.
      if (alcoholInSystem > 0) {
        const burn = Math.min(ETHANOL_RATE_G, alcoholInSystem);
        alcoholInSystem -= burn;
        ethanolKcal = Math.min(burn * KCAL_ALCOHOL, demandKcal);
      }
      let remainingDemand = demandKcal - ethanolKcal;

      // Fasted / sleeping rest: glucose use is the obligate brain+RBC need
      // (~0.11 g/min), progressively spared by ketones as the fast lengthens;
      // fat supplies the remainder. This decouples brain glucose from the
      // RQ-based carb fraction, so the liver actually drains overnight and
      // gluconeogenesis can defend blood glucose (Sections 4–5). Active only at
      // rest with low insulin and no active absorption — meals/exercise use the
      // normal substrate split.
      if (!exercising && !gutActive && insulin < 2.5 && remainingDemand > 0) {
        // Ketone sparing deepens with the fast, dropping obligate glucose below
        // the sustainable GNG rate so the liver stabilizes rather than emptying.
        const ketoSparing = Math.min(0.75, Math.max(0, hoursFasted - 4) * 0.04);
        const obligateGlucoseKcal = 0.13 * (1 - ketoSparing) * KCAL_CARB * TIMESTEP;
        carbFrac = Math.min(1, obligateGlucoseKcal / remainingDemand);
        fatFrac = 1 - carbFrac;
        // Alcohol still blocks beta-oxidation. Without this clamp the branch
        // would overwrite the ethanol override and hand fat oxidation back,
        // exactly during the fasted/overnight hours when drinking suppresses it.
        if (fatFrac > alcoholFatCeiling) { fatFrac = alcoholFatCeiling; carbFrac = 1 - fatFrac; }
      }

      // ---- fat energy (computed first — the glycerol GNG stream needs it) ---
      let fatDemand = remainingDemand * fatFrac;
      const gutFatAvail = aFat * TIMESTEP * KCAL_FAT;
      let gutFat = Math.min(gutFatAvail, fatDemand);
      fatDemand -= gutFat;

      // FAT_OXIDATION_CAPACITY is a peak fat-oxidation RATE in g/min (Achten &
      // Jeukendrup Fatmax units: ~0.07-0.15 g/min). Convert to kcal per step.
      const maxFatOx = C.FAT_OXIDATION_CAPACITY * KCAL_FAT * TIMESTEP;
      let adipose = Math.min(maxFatOx, fatDemand);
      fatDemand -= adipose;

      // ---- 3H. hepatic gluconeogenesis rate (Section 2) --------------------
      // (a) lactate — Cori cycle: activity base + decaying post-exercise flush
      const lactateFlushRate = lactateFlush(m, tl);
      const lactateGng = lactateGngBase(act) + lactateFlushRate;
      // (b) alanine — glucose-alanine cycle: fasting- and insulin-modulated
      const fastMult = hoursFasted < 4 ? 1.0 : hoursFasted < 8 ? 1.3 : hoursFasted < 14 ? 1.6 : 2.0;
      let alanineGng = (sleeping ? 0.015 : (exercising ? 0.025 : 0.018)) * fastMult * Math.max(0, 1 - insulin * 0.06);
      if (aminoPool < 2) alanineGng = 0.005;               // substrate-limited floor
      // (c) glycerol — from adipose lipolysis; tracks fat oxidation, insulin-suppressed
      const adiposeFatOxG = (adipose / KCAL_FAT) / TIMESTEP;    // g fat/min oxidized from adipose
      const glycerolGng = adiposeFatOxG * 0.073 * Math.max(0, 1 - insulin * 0.08);
      const gngRate = lactateGng + alanineGng + glycerolGng;   // g glucose/min
      let gngGlucose = gngRate * TIMESTEP;                      // g this timestep
      // amino-acid cost of the alanine-derived glucose (1.75 g amino / g glucose)
      const alanineGlucose = alanineGng * TIMESTEP;
      let aminoCost = alanineGlucose * 1.75;
      if (aminoCost > aminoPool) { gngGlucose -= (alanineGlucose - aminoPool / 1.75); aminoCost = aminoPool; }
      aminoPool = Math.max(0, aminoPool - aminoCost);

      // ---- 3D step 3. carbohydrate energy ----------------------------------
      let carbDemand = remainingDemand * carbFrac;
      const gutGlucoseAvail = aCarb * TIMESTEP * KCAL_CARB;
      let gutGlucose = Math.min(gutGlucoseAvail, carbDemand);
      carbDemand -= gutGlucose;

      // When insulin is low (fasting / exercise), GNG feeds blood glucose IN
      // PARALLEL with glycogenolysis (~a fifth-to-a-third of hepatic output), so
      // it appears as its own fuel band instead of hiding inside liver glycogen.
      let gngKcal = 0;
      if (insulin < 2 && carbDemand > 0 && gngGlucose > 0) {
        const fillG = Math.min(gngGlucose, carbDemand / KCAL_CARB);
        gngKcal = fillG * KCAL_CARB; carbDemand -= gngKcal; gngGlucose -= fillG;
      }

      // Glycogenolysis for the rest. Contracting muscle burns its OWN glycogen
      // (and hepatic output is capped ~1.5 g/min), so during exercise muscle is
      // drawn first; at rest the liver is the glucose buffer.
      let liverKcal = 0, muscleKcal = 0;
      const drawLiver = () => {
        const k = Math.min(liver * KCAL_CARB, carbDemand, LIVER_OUTPUT_MAX * KCAL_CARB);
        liver -= k / KCAL_CARB; carbDemand -= k; return k;
      };
      const drawMuscle = () => {
        const k = Math.min(muscle * KCAL_CARB, carbDemand);
        muscle -= k / KCAL_CARB; carbDemand -= k; return k;
      };
      if (exercising) { muscleKcal = drawMuscle(); liverKcal = drawLiver(); }
      else { liverKcal = drawLiver(); muscleKcal = drawMuscle(); }

      // Any GNG glucose not used for fuel replenishes LIVER glycogen (never
      // muscle — GNG exports via blood; muscle refills only via GLUT4 uptake).
      let gngRefill = 0;
      if (gngGlucose > 0 && liver < C.LIVER_GLYCOGEN_MAX) {
        gngRefill = Math.min(gngGlucose, C.LIVER_GLYCOGEN_MAX - liver);
        liver += gngRefill; gngGlucose -= gngRefill;
      }

      // ---- 3D step 4. surplus handling -------------------------------
      let surplusGlucose = (gutGlucoseAvail - gutGlucose) / KCAL_CARB;
      if (surplusGlucose > 0 && muscle < C.MUSCLE_GLYCOGEN_MAX && insulin > 2) {
        let refill = Math.min(surplusGlucose, C.MUSCLE_GLYCOGEN_MAX - muscle, MUSCLE_REFILL_MAX);
        muscle += refill; surplusGlucose -= refill;
      }
      if (surplusGlucose > 0 && liver < C.LIVER_GLYCOGEN_MAX) {
        let refill = Math.min(surplusGlucose, C.LIVER_GLYCOGEN_MAX - liver);
        liver += refill; surplusGlucose -= refill;
      }
      if (surplusGlucose > 0) { cumSurplusGlucose += surplusGlucose; daySurplusGlucose += surplusGlucose; fatStored_g += surplusGlucose * 0.5; }
      const surplusFat_g = fatDemand < 0 ? 0 : (gutFatAvail - gutFat) / KCAL_FAT;
      if (surplusFat_g > 0) fatStored_g += surplusFat_g;
      // Body-fat reserve is DEBITED by adipose fat oxidized this step, so the
      // store falls when burning fat and rises when storing it.
      fatStored_g = Math.max(0, fatStored_g - adipose / KCAL_FAT);

      // ---- 3F. MPS ---------------------------------------------------
      const MPS_BASELINE = 0.002;
      let mpsRate = MPS_BASELINE, mpsStatus = 'Baseline';
      // Strongest current stimulus governs (highest elevation factor), decaying
      // with time since each session rather than sitting flat at the peak.
      let resistFactor = 0, governingLeucine = false;
      for (const r of tl.resistances) {
        const f = resistanceMpsFactor(m - (r.start + r.dur));
        if (f > resistFactor) { resistFactor = f; governingLeucine = !!r.leucine; }
      }
      let aerobicFactor = 0;
      for (const e of tl.aerobics)
        if (e.intensity === 'vigorous') aerobicFactor = Math.max(aerobicFactor, aerobicMpsFactor(m - (e.start + e.dur)));

      const resistWindow = resistFactor > 0, aerobicWindow = aerobicFactor > 0;
      const adequateAA = aminoPool > 2;
      if (resistWindow) {
        const peak = adequateAA ? 0.012 : 0.006;
        mpsRate = MPS_BASELINE + (peak - MPS_BASELINE) * resistFactor;
        mpsStatus = !adequateAA ? 'Suboptimal (low amino acids)'
                  : resistFactor >= 0.5 ? 'Active (resistance)' : 'Tapering (resistance)';
      } else if (aerobicWindow) {
        const peak = adequateAA ? 0.005 : 0.002;
        mpsRate = MPS_BASELINE + (peak - MPS_BASELINE) * aerobicFactor;
        mpsStatus = adequateAA ? (aerobicFactor >= 0.5 ? 'Active (aerobic)' : 'Tapering (aerobic)') : 'Baseline';
      }
      if (sleeping && ghActive(m, tl) && adequateAA) mpsRate *= 1.3;   // GH sleep boost
      // consume amino acids
      let mpsConsumed = mpsRate * TIMESTEP;
      if (aminoPool - mpsConsumed < 0) { mpsRate = MPS_BASELINE; mpsStatus = 'Baseline (substrate limited)'; mpsConsumed = mpsRate * TIMESTEP; }
      aminoPool = Math.max(0, aminoPool - mpsConsumed);

      // ---- consumed calories (step at meal times) --------------------
      for (const meal of tl.meals)
        if (meal.min >= m && meal.min < m + TIMESTEP) cumConsumed += meal.kcal;

      // ---- fractions for the substrate-trace chart -------------------
      const fatKcal = gutFat + adipose;
      const totalSupplied = gutGlucose + liverKcal + muscleKcal + gngKcal + fatKcal + ethanolKcal;
      const denom = totalSupplied > 0 ? totalSupplied : 1;
      const fr = {
        gutGlucose: gutGlucose / denom,
        liver: liverKcal / denom,
        muscle: muscleKcal / denom,
        gng: gngKcal / denom,
        adipose: adipose / denom,
        gutFat: gutFat / denom,
        alcohol: ethanolKcal / denom
      };

      // ---- blood-glucose proxy & phase -------------------------------
      let glucoseState, glucoseMgdl;
      if (insulin > 5 && gutActive) { glucoseState = 'elevated'; glucoseMgdl = 140; }
      else if (insulin < 1.5 && !gutActive) { glucoseState = 'low'; glucoseMgdl = 60; }
      else { glucoseState = 'normal'; glucoseMgdl = 95; }

      // metabolic phase — sleep/absorptive first, then fasting-duration bands (Section 4)
      let phase;
      if (sleeping) phase = 'Sleep — growth-hormone window, fat oxidation dominant';
      else if (insulin > 5 && gutActive) phase = 'Absorptive — processing recent meal';
      else if (hoursFasted < 4) phase = insulin >= 2 ? 'Early post-absorptive — glucose still available' : 'Post-absorptive — fat oxidation rising';
      else if (hoursFasted < 8) phase = 'Post-absorptive — GNG active, fat oxidation rising';
      else if (hoursFasted < 16) phase = 'Short-term fasted — GNG accelerating, ketone production begins';
      else if (hoursFasted < 24) phase = 'Extended fast — protein catabolism increasing';
      else phase = 'Prolonged fast — gluconeogenesis sustaining blood glucose';

      // dominant fuel
      const fuelMap = {
        'Gut glucose': fr.gutGlucose, 'Liver glycogen': fr.liver,
        'Muscle glycogen': fr.muscle, 'Gluconeogenesis': fr.gng, 'Adipose fat': fr.adipose,
        'Dietary fat': fr.gutFat, 'Alcohol': fr.alcohol
      };
      let dominantFuel = 'Fat', best = -1;
      for (const k in fuelMap) if (fuelMap[k] > best) { best = fuelMap[k]; dominantFuel = k; }

      // glycogen status labels
      const statusOf = (v, max) => {
        const r = v / max;
        if (r > 0.66) return 'replete'; if (r > 0.33) return 'partial';
        if (r > 0.2) return 'low'; return 'depleted';
      };

      // ---- flags -----------------------------------------------------
      const flags = [];
      if (insulin > 5) flags.push('Fat oxidation suppressed — insulin elevated from recent meal');
      if ((act.kind === 'aerobic' && act.intensity === 'vigorous') ||
          (act.kind === 'resistance' && muscleKcal > 0.5))
        flags.push('Glycogen being rapidly depleted during exercise');
      if (insulin > 2 && muscle < C.MUSCLE_GLYCOGEN_MAX && (gutGlucoseAvail - gutGlucose) > 1)
        flags.push('Muscle glycogen replenishment window — carbs now preferentially refill muscle stores');
      if (resistWindow && governingLeucine) flags.push('Protein timing is well-matched to resistance exercise');
      if (alcoholActive) flags.push('Alcohol present — fat oxidation significantly suppressed');
      if (liver / C.LIVER_GLYCOGEN_MAX < 0.2) flags.push('Liver glycogen low — approaching fasted metabolic state');
      if (mpsStatus.startsWith('Suboptimal')) flags.push('Leucine threshold may not be met — consider 20–40 g protein within 2 h of resistance training');
      if (daySurplusGlucose > 150) flags.push('Large glucose surplus today — de novo lipogenesis likely');
      // gluconeogenesis flags (Section 7)
      if (gngRate > 0.08 && insulin < 3) flags.push('GNG active — liver synthesizing glucose from lactate, amino acids, and glycerol');
      if (liver / C.LIVER_GLYCOGEN_MAX < 0.05 && gngKcal > 0) flags.push('Liver glycogen depleted — gluconeogenesis is the primary glucose source');
      if (sleeping && gngRefill > 0.01 && liver < C.LIVER_GLYCOGEN_MAX) flags.push('Overnight GNG gradually refilling liver glycogen — normal fasting response');
      if (lactateFlushRate > 0.015) flags.push('Post-exercise lactate flush — Cori cycle running at high rate');
      if (aminoPool < 2 && hoursFasted > 4) flags.push('Amino acid pool low — protein catabolism contributing to gluconeogenesis; consider protein intake');
      if (hoursFasted > 16) flags.push('Extended fast — gluconeogenesis accelerating; muscle protein at risk if prolonged');

      out.push({
        i, minute: m, dayIndex: Math.floor(m / MINS_PER_DAY),
        timeLabel: stampLabel(m), todLabel: minToLabel(m),
        activity: act.kind, intensity: act.intensity || null, met: act.met,
        demandKcal, insulin, glucoseState, glucoseMgdl,
        absorption: { carb: aCarb, protein: aProt, fat: aFat, alcohol: aAlc },
        kcal: { gutGlucose, liver: liverKcal, muscle: muscleKcal, gng: gngKcal,
                gutFat, adipose, alcohol: ethanolKcal },
        fractions: fr,
        liverGlycogen: liver, muscleGlycogen: muscle, aminoPool,
        fatFracAdjusted: fatFrac,
        mpsRate, mpsStatus,
        gngRate, gngKcal, gngRefill, hoursFasted,
        gngPrecursors: { lactate: lactateGng, alanine: alanineGng, glycerol: glycerolGng },
        // `alcoholInSystem` is the true END-of-step state, consistent with every
        // other state variable here — scenario chaining seeds from these, so it
        // must not be the pre-burn value. The display fields are separate.
        alcoholInSystem,
        alcoholDuringStep: alcoholAtStepStart,   // what was on board during the step
        alcoholActive,                           // drove suppression + flag this step
        fatStored_g, fatDelta: fatStored_g - fatStartReserve,
        cumSurplusGlucose, daySurplusGlucose,
        cumConsumed, cumExpended,
        phase, dominantFuel,
        liverStatus: statusOf(liver, C.LIVER_GLYCOGEN_MAX),
        muscleStatus: statusOf(muscle, C.MUSCLE_GLYCOGEN_MAX),
        flags,
        lastMealName, minsSinceMeal
      });
    }

    out.constants = C;
    out.leucineMet = leucine;
    out.timeline = tl;
    // End-of-run body state + the real trailing events, so another block can
    // CONTINUE from here and reproduce this run's history exactly.
    out.endState = { liver, muscle, aminoPool, insulin, alcoholInSystem, fatStored_g };
    out.carryIn = buildCarryIn(tl, tl.totalMin);
    out.fatStartReserve = fatStartReserve;
    return out;
  }

  // ---- defaults (Section 8) ----------------------------------------------
  const DEFAULT_PROFILE = { weight: 80, height: 175, age: 35, sex: 'male', training: 'recreational' };

  // A daily template, expanded to all DAYS with per-day `day` tags. To show off
  // day-to-day variation out of the box, Day 3 is a rest day (no run) and Day 5
  // swaps the midday run for an evening resistance session.
  // Carbs are set so the week is roughly glycogen-stable for this profile
  // (~250 g/day carb ≈ the daily carb oxidation), rather than a slow deficit.
  const DAILY_TEMPLATE = [
    { type: 'sleep', start: '22:30', end: '06:30' },
    { type: 'meal', time: '07:00', name: 'Breakfast', kcal: 560, carbs: 68, protein: 28, fat: 18, alcohol: 0 },
    { type: 'aerobic', start: '11:30', duration: 45, intensity: 'moderate' },
    { type: 'meal', time: '13:00', name: 'Lunch', kcal: 740, carbs: 84, protein: 44, fat: 22, alcohol: 0 },
    { type: 'meal', time: '18:30', name: 'Dinner', kcal: 830, carbs: 96, protein: 48, fat: 30, alcohol: 0 }
  ];
  const DEFAULT_SCHEDULE = [];
  for (let d = 1; d <= DAYS; d++) {
    for (const ev of DAILY_TEMPLATE) {
      if (d === 3 && ev.type === 'aerobic') continue;                       // Day 3: rest day
      if (d === 5 && ev.type === 'aerobic') {                               // Day 5: resistance instead
        DEFAULT_SCHEDULE.push({ type: 'resistance', day: d, start: '17:30', duration: 45, intensity: 'hard' });
        continue;
      }
      DEFAULT_SCHEDULE.push(Object.assign({ day: d }, ev));
    }
  }

  window.runSimulation = runSimulation;
  window.buildTimeline = buildTimeline;
  window.buildCarryIn = buildCarryIn;
  window.computeConstants = computeConstants;
  window.DEFAULT_PROFILE = DEFAULT_PROFILE;
  window.DEFAULT_SCHEDULE = DEFAULT_SCHEDULE;
  window.MET_INFO = { AEROBIC_MET, RESIST_MET };
  window.simUtil = { hhmmToMin, minToLabel, stampLabel };
  window.ALCOHOL_REPORT_MIN = ALCOHOL_REPORT_MIN;
  window.SIM_DAYS = DAYS;
  window.SIM_STEPS = STEPS;
  window.SIM_STEPS_PER_DAY = STEPS_PER_DAY;
})();
