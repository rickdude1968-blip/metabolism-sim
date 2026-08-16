<!--
  Metabolic Simulator
  Copyright (C) 2026 Rick Theiner

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program. If not, see <https://www.gnu.org/licenses/>.
-->

# 5-Day Metabolism Simulator

A single-page web application that simulates human substrate metabolism (which
fuels the body burns, how blood sugar and insulin move, how glycogen stores
rise and fall, and how muscle protein synthesis responds) across **5 days**.
You build a **per-day schedule** of meals, exercise, and sleep — each day can
differ — and it runs as **one continuous simulation** at 5-minute resolution
(1,440 timesteps). Because it never resets between days, glycogen stores, the
amino-acid pool, and the running calorie balance carry over from night to night
— so you can watch multi-day cumulative trends emerge (e.g. a small daily
deficit compounding, or a rest day letting glycogen recover).

> **This is an educational model, not a medical or nutritional tool.** It uses
> simplified, population-average equations from the exercise-physiology
> literature. It cannot account for your individual biology, medical
> conditions, or medications. **Do not use it to make health, diet, medication,
> or training decisions.** For anything that matters to your health, talk to a
> qualified professional.

---

## Table of contents
1. [Quick start](#quick-start)
2. [What's in the folder](#whats-in-the-folder)
3. [How to use it](#how-to-use-it)
4. [Importing from a nutrition app](#importing-from-a-nutrition-app)
5. [Using it on a phone](#using-it-on-a-phone)
6. [How the model works](#how-the-model-works)
7. [The charts and status panel](#the-charts-and-status-panel)
8. [Deliberate deviations from a literal reading of the spec](#deliberate-deviations)
9. [Limitations (what it does NOT model)](#limitations)
10. [System requirements & restrictions](#system-requirements--restrictions)
11. [Possible errors & troubleshooting](#possible-errors--troubleshooting)
12. [Customizing / editing the app](#customizing--editing-the-app)
13. [Scientific references](#scientific-references)
14. [License](#license)

---

## Quick start

1. Make sure all files stay together in one folder (see below).
2. **Double-click `index.html`.** It opens in your default web browser.
3. The example day loads and runs automatically. Drag the **Now** slider (or
   press **▶ Play**) to move through all 5 days and watch the numbers change.
   The cursor position is labelled by day and time (e.g. "D3 13:00").

No installation, no internet connection, and no server are required. It works
on Windows, macOS, and Linux, and fully offline.

On a **phone**, open it from a hosted link instead of a local file — see
[Using it on a phone](#using-it-on-a-phone).

---

## What's in the folder

Everything must stay in one folder and keep its filename — `index.html` loads
the rest by exact name, so renaming or separating them breaks the app.

| File | What it does |
|------|--------------|
| `index.html` | The page itself — layout, input controls, chart containers. **This is the file you open.** |
| `simulation.js` | The metabolic model. Runs the 5-minute-step simulation and returns 1,440 timesteps (5 days) of data. The number of days is the `DAYS` constant near the top — change it to simulate a different span. |
| `charts.js` | Draws the six charts using Chart.js, plus the meal/exercise/sleep shading and the draggable "now" cursor. |
| `importers.js` | Reads food-log exports from other apps (Cronometer today) and turns them into schedule events. Self-contained and DOM-free, so new sources plug in here without touching the rest. |
| `app.js` | Connects the buttons, sliders, and schedule builder to the model; writes the status panel; handles files and autosave. |
| `styles.css` | Colors, layout, and styling. |
| `chart.umd.min.js` | The Chart.js graphing library, bundled locally so no internet is needed. |
| `manifest.json` | Lets the app be installed to a phone home screen. |
| `icon-192.png`, `icon-512.png` | App icons used by the manifest. |
| `apple-touch-icon.png` | The home-screen icon on iOS, which ignores the manifest's icons. |
| `LICENSE` | The GNU GPL v3, which this program is released under. |
| `README.md` | This file. |
| `test-scenarios/` | Fixture files the regression test loads, including `imports/` for the food-log importers. Not needed to run the app. |
| `test/roundtrip-test.html` | A regression test — see [Regression test](#regression-test--run-this-after-changing-the-model). Not needed to run the app. |

---

## How to use it

### Profile (top-left)
Set body weight, height, age, sex, and training status. As you change these, the
**derived constants** box updates live:

- **BMR** — basal metabolic rate (Mifflin-St Jeor equation).
- **Liver glycogen max** — fixed at 100 g.
- **Muscle glycogen max** — scales with body weight and training status.
- **Fat-oxidation capacity** — the ceiling on how fast you can burn body fat at
  rest; higher for trained people.

### Schedule (left)
The schedule is **per day** — every event belongs to a specific day, so you can
vary the five days however you like. The list is grouped into **Day 1 … Day 5**
panels, and a sample week is preloaded (Day 3 is a rest day and Day 5 swaps the
midday run for an evening resistance session, to show the variation).

- **Each event carries both a time and a day.** When you add one under
  **"+ Add event"** (meals, aerobic, resistance, or sleep), pick the **Day** from
  the dropdown at the top of that form.
- **"All days"** in the Day dropdown adds the event to every day at once. It
  creates five independent copies — so you can afterwards tweak or delete any
  single day's copy (e.g. add a run to all days, then remove it from Day 3).
- **Remove** any event with the ✕ button; it only removes that day's copy.
- Any time on a given day not covered by exercise or sleep is automatically
  treated as **sedentary**.
- The night before Day 1 is auto-primed from your Day 1 events, so the first
  morning still starts realistically mid-sleep.

Click **Run simulation** after editing to recompute. **Reset to example**
restores the sample week and default profile.

### Exporting events to a CSV
**Export events CSV…** saves the current schedule as a spreadsheet using the very
same column layout the importer reads, so you can open it in Excel or Sheets,
edit or extend it, and bring it straight back in with **Import events CSV…**.

Every exported row carries `x` in the **Total (x/o)** column so it re-imports.
To park a row without deleting it, blank that cell out (or put anything other
than `x` there) and the importer will skip it — handy for keeping alternatives
in the file.

Exercise rows are written as `Time` + `End`, which is how the importer recovers
the duration; **Sleep** uses `End` as the wake time. The `Date` and `What`
columns are left blank — the model doesn't use them, and the importer ignores
them, so they're yours for notes. Files are named from the scenario name plus a
timestamp (`My_Week_2026-08-01_1018.csv`), and are written with a BOM so Excel
opens accented characters correctly.

### Importing events from a CSV
**Import events CSV…** adds events from a spreadsheet without touching anything
already in the schedule (so if a row duplicates an existing event, delete one
copy by hand afterwards). The importer reads these columns (matching the sample
`Events.csv`):

- **Total (x/o)** — a row is imported only if this is exactly `x`; anything else
  is skipped (treated as a comment/alternative).
- **Event** — must be `Meal`, `Aerobic`, `Resistance`, or `Sleep`; any other
  value is ignored.
- **Day** and **Time** (24-hour) apply to every event. Rows for a day beyond the
  5-day window are skipped.
- **Meal:** Name, Kcal, Prot, Carb, Fat, Alc — blanks count as 0.
- **Aerobic / Resistance:** duration = End − Time (or 30 min if End is blank);
  intensity comes from the **Exercise** column. Because the model uses different
  scales, a Resistance `vigorous` becomes `hard` and an Aerobic `hard` becomes
  `vigorous`; a blank/unrecognized intensity defaults to `moderate`.
- **Sleep:** End is the wake time.

After import you'll see a summary (how many events were added and how many rows
were skipped); review the day-grouped list, remove any duplicates, then **Run
simulation**.

### Timeline (right)
- The **Now** slider scrubs through all 5 days in 5-minute steps.
- **▶ Play** animates the cursor automatically; press again to pause.
- The vertical black line on every chart marks the current time, and the
  **Status** panel is always describing that exact moment.

### Saving scenarios (left, "Scenarios")
Once you've built a profile + schedule you like, you can save it and return to
it later without re-entering anything.

- **Save:** type a name and click **Save**. The current profile and full
  schedule are stored in your browser under that name. Saving again with the
  same name overwrites it (after a confirm).
- **Load / delete:** each saved scenario appears in the list with a **Load**
  button (restores it and re-runs) and a ✕ to delete it.
- **Export file… / Import file…:** save the current setup to a `.json` file on
  disk, or load one back. Use this to **move scenarios between computers or
  browsers**, or as a backup — the in-browser saves live only in the browser
  that made them (clearing browser data erases them), whereas a `.json` file is
  portable and permanent. Exported files from the two apps are interchangeable.
- **Set start state from file… (the usual way to chain weeks):** takes *only*
  the ending state out of another scenario and uses it as this scenario's
  starting point. Your **schedule, profile and Day 1 date are left exactly as
  they are** — which is what you want when this week is already built and you
  just need last week's finish as its starting point. A banner then names where
  the state came from, with a **Start fresh instead** button to drop it again
  without disturbing the schedule.

  Use this rather than Continue + Import if you have already built the week you
  want to run. **Importing a whole scenario replaces everything** — schedule,
  profile and date — so importing last week to "adjust the starting point" would
  quietly discard the week you were working on.

- **Continue (carry the body over):** tick the **Continue** checkbox before you
  Load or Import, and the next 5 days start from that scenario's *ending body
  state* instead of a fresh, fully-fuelled start — liver & muscle glycogen, the
  amino-acid pool, and body fat all pick up where the saved run left off. The
  **charts reset** to a fresh 5-day window (calorie balance back to zero), but
  the *status values carry over*, so you can chain block after block. A green
  banner above the charts shows when a run is a continuation; **Reset to
  example** clears it.

  Continuation is **numerically exact**: a chained run reproduces an
  uninterrupted one variable-for-variable (verified by `test/roundtrip-test.html`,
  which compares all 18 state and trajectory variables across the seam). That
  works because the file also carries **`carryInEvents`** — the real meals,
  workouts and sleep from the 48 h before the boundary. Those are what let the
  new block get gut absorption still in flight, the muscle-protein-synthesis
  window, EPOC and the lactate flush exactly right; the six body-state numbers
  alone cannot express them.

### The scenario file format (schema v2)
Exported `.json` files store **inputs only** — never the computed curves — so
they stay small (~6 KB) and keep working as the model changes:

| Field | Purpose |
|---|---|
| `schemaVersion` | Format version (currently `2`). A file from a newer version is refused rather than half-read; older v0/v1 files still load. |
| `app` | `"metabolism-simulator"`. Files from other programs are rejected cleanly. Both editions share this ID, so exports are interchangeable between them. |
| `name`, `created` | Human-readable label and ISO timestamp. |
| `profile` | Body parameters. |
| `settings` | Simulation settings (Metabolism-EDU stores its meal-timing offset here; the plain simulator ignores it). |
| `schedule` | Your meals / exercise / sleep events. |
| `startDate` | **Optional label** for Day 1, or `null`. Purely cosmetic — see below. |
| `endState` | Where this run **ended** — the six body-state values a continuation starts from, or `null`. |
| `carryInEvents` | Real trailing events from the end of this run, or `null`. |
| `startedFrom` | Where this run **began**, or `null` for a fresh run. |
| `startedFromCarryIn` | The carry-in events this run was actually seeded with, or `null`. |

Files are named from the scenario name plus a timestamp
(`My_Week_1_2026-07-21_1432.json`), so they stay distinguishable once several
pile up.

#### Reading a chain
`endState` and `startedFrom` are two different things, and the distinction
matters when you chain blocks:

- **`endState`** is where that file's run *finished*. Tick **Continue** on import
  and the next block starts from exactly this.
- **`startedFrom`** is where that file's run *began* — `null` if it was a fresh
  run rather than a continuation.

So to confirm block B really followed block A, open both files and check that
**B's `startedFrom` equals A's `endState`**. They should match digit for digit.

> Schema v1 stored only the end state, under the name `initialState` — which
> read like "where this run started" but held the opposite. A v1 file therefore
> cannot tell you what it was seeded with. v1 files still load (their
> `initialState` is treated as the end state, which is what it was), but they
> will show no `startedFrom` until you re-run and re-save them as v2.

#### The Day 1 date
`startDate` is an **optional label only**, so you can tell one week's scenario
from another at a glance. Set it under **Schedule → Day 1 date** and the day
headers and the "now" cursor pick up calendar dates (`Day 3 · Thu, Aug 6`).

**Nothing in the model reads it.** Every calculation is keyed off the Day
*number* alone, so a scenario behaves identically whether the date is set,
cleared, or wrong — the date is never even passed to the simulation engine.
That means you can compare scenarios from different weeks freely without the
dates affecting anything.

**Import is validated before anything is loaded.** A file with the wrong `app`,
a too-new `schemaVersion`, a missing field, or a non-numeric value is rejected
with a message naming the specific problem (e.g. *"initialState.insulin must be
a finite number"*). Nothing is ever partially applied — a half-loaded scenario
would otherwise reach the model as `NaN` and produce curves that look fine and
mean nothing. Older files saved before this format are still accepted, with a
note that their continuation will be approximate across the seam.

---

## Importing from a nutrition app

**Import food log…** (under the schedule) reads an export from a nutrition
tracker and turns it into meals and training sessions. Today it understands
**Cronometer**; MyFitnessPal and FatSecret are planned and will appear on the
same button, because the file that reads them is built to take more sources.

Nothing is added until you press **Confirm import**. Everything the importer
worked out is shown to you first, and all of it is editable.

### Getting the file out of Cronometer

On the Cronometer website (not the phone app):

1. **Profile ▸ Account ▸ Export Data**
2. Pick a date range.
3. **Export Servings** for food, or **Export Exercises** for training.

Export the CSV as-is — do not delete or rename the header row, which is how
every column is located. You can import the two files one after the other.

### The review screen

| Section | What it is for |
|---------|----------------|
| Summary | Which file, which importer read it, how many rows became how many events, and which calendar date is being treated as Day 1. |
| Import options | The merge toggle and the default times (below). |
| Classify these exercises | Only for exercise imports — see below. |
| Warnings | Rows that could not be read, entries placed by guesswork, calorie mismatches, and anything falling outside the 5-day window. Nothing is dropped without appearing here. |
| Timeline | Every event that will be added, grouped by day with that day's macro totals. Each row can be edited or deleted with ✕. |

**Merge each meal group into one event** is off by default, giving one event
per logged food — which matches how the log was actually kept. Turn it on to
collapse each group (Breakfast, Lunch, …) into a single meal with summed
macros. Merging never changes a day's totals, only how many events carry them.

> Changing any option rebuilds the list from the file, which discards row edits
> you have already made. It says so when it happens. Set the options first, then
> edit rows.

### Times

If your Cronometer diary records times, they are used exactly as logged.
If it does not, each entry is placed by its meal group:

| Group | Default |
|-------|---------|
| Breakfast | 07:30 |
| Lunch | 12:30 |
| Dinner | 18:30 |
| Snacks | 15:00 |
| A second, separately-named snack group the same day | 21:00 |
| No group, or a group name I don't recognise | 12:00 |

All six are editable on the review screen, and any individual row's time can be
changed afterwards. Because meal timing drives insulin, glycogen refill and the
overnight fast, a guessed time is worth a look — every row placed this way is
labelled *"time assigned by this app"*.

### Exercises

Cronometer's exercise export says what you did and for how long, but not how
the body should treat it. The first time a given exercise name appears you are
asked to classify it as **aerobic** or **resistance** and pick an intensity.
The answer is remembered in this browser, so repeat imports never ask twice.
Until a name is classified, its rows are held back rather than guessed at.

The export has no start time either; all sessions default to **17:00**,
adjustable for the whole import or per row.

**Cronometer's "Calories Burned" is deliberately ignored.** The simulator
computes a session's cost itself, from duration, intensity and your profile,
and then spends that cost out of specific fuel stores. Importing a flat calorie
figure would double-count it. The logged figure is shown on each row so you can
see the difference; expect the two to disagree.

### Checks it runs

- **Calorie consistency.** Each entry's logged calories are compared with what
  its macros imply (4/4/9 plus 7 kcal/g for alcohol). More than 15% apart and
  the row is flagged. This usually means an incomplete food record — most often
  an entry logged with macros but zero calories.
- **Blank cells count as zero, not as missing.** A blank Alcohol cell is a real
  zero because Cronometer tracks alcohol; a source that cannot see alcohol at
  all would be treated differently.
- **Days outside the window.** Dates before Day 1 or beyond Day 5 are listed as
  skipped. They are never silently dropped.

### Day 1 and dates

Dates are used **only** to work out which simulation day an entry belongs to.
Once that is done the events are keyed by day number alone, exactly like
hand-entered ones — so a scenario behaves identically whether or not a Day 1
date is set.

If no Day 1 date is set, the earliest date in the file becomes Day 1 and the
review screen offers to record that date as the scenario's label.

### Importing twice

Import **adds**; it never replaces or removes. If a target day already has
events, the review screen says so and makes you tick a box before confirming,
because importing the same file twice will otherwise quietly double that day.

### If the file is rejected

You'll get a panel naming what was missing and listing the columns actually
found. The usual cause is exporting the wrong report — a Servings export needs
`Day` and `Food Name`, an Exercises export needs `Day`, `Exercise` and
`Minutes`. Editing the header row in a spreadsheet before importing will also
do it.

### Adding another source

`importers.js` is split into three layers: CSV/header plumbing, one **parser**
per source, and a shared **mapper**. A new source only needs a parser that
returns the common `ImportedEntry` shape, registered through
`registerImportParser()`. Detection, the review screen, day mapping, merging
and default times all come for free. The contract is documented at the top of
the file.

---

## Using it on a phone

The app is a normal web page, so it works on a phone browser as-is — but a few
things are built specifically for touch.

### Getting it onto a phone
Host the folder as a static site (this repo is set up for **GitHub Pages** —
`index.html` is at the root, all asset paths are relative, and a `.nojekyll`
file stops Pages from reprocessing it) and open the link on the phone. No build
step is needed.

**Install it to the home screen** for a full-screen, app-like window: *Share →
Add to Home Screen* on iOS, or *Install app* / *Add to Home screen* on Android.
`manifest.json` and `apple-touch-icon.png` supply the name and icon.

> There is **deliberately no service worker**, so the app is not available
> offline from the home screen. That is a choice, not an omission: an offline
> cache would pin anyone who installed it to a stale build while the model is
> still changing. Every open fetches the current version.

### The bottom tab bar
On narrow screens the layout collapses to three tabs — **📝 Events**,
**📈 Output**, **💾 Files** — instead of trying to show the schedule and the
charts side by side. On a wide screen the tab bar disappears and everything is
visible at once. Banners (carry-over, backup reminders) sit outside the tabs so
they stay visible whichever one is open.

### Your work is saved as you go
Edits are **autosaved to the browser** a moment after you make them, and
restored when you come back — mobile Safari discards backgrounded tabs
aggressively, and a half-entered schedule is painful to lose. You will see
*"Restored your unsaved work from this browser"* when that happens.

This is a convenience, not a backup:

- It lives only in **that browser on that device**. Clearing browsing data
  erases it.
- iOS Safari evicts storage after about **7 days without a visit**, unless the
  app has been added to the home screen.
- After a few days without an export, a reminder appears suggesting you save a
  file. **Export / share…** or **Copy as text** both count as backing up, and
  dismiss it.

For anything you want to keep, export a `.json` file.

### Getting files in and out on touch
`<a download>` is unreliable on iOS Safari — it tends to open the file in a
viewer instead of saving it — so on touch devices **Export / share…** opens the
system **share sheet** (choose *Save to Files*, or send it to yourself). On a
desktop it stays a plain one-click download, because the share dialog there
often cannot save to disk at all.

Some in-app browsers (Instagram, Facebook, several mail clients) block both
downloads *and* the share sheet. For those there is **Copy as text** and
**Paste text…**, which move a scenario through the clipboard and always work.

### Known limitation — do not expect AirDrop to work
A web app on iOS cannot register as a handler for `.json` files. If someone
AirDrops you a scenario, **tapping it will not open this app**. The flow is:
open the app → **Import file…** → pick it from Files.

---

## How the model works

The engine divides the 5 days into **1,440 five-minute steps** (288 per day) and,
at each step, computes everything in this order:

1. **Gut absorption.** Each meal releases carbs, protein, and fat into the
   bloodstream on gamma-shaped curves — carbs fastest (peak ~45 min), protein
   slower (~90 min), fat slowest (~120 min, via the lymphatics). Alcohol, if
   present, absorbs fastest of all.

2. **Insulin index (0–10).** Absorbed carbs (and, less so, protein) drive
   insulin up; between meals it decays with a ~90-minute time constant. Aerobic
   exercise halves it (muscle can take up glucose without insulin). It never
   falls below a fasting baseline of 0.5.

3. **Energy demand.** Set by what you're doing — sleeping, sedentary, or
   exercising at a given intensity (via MET multipliers on your BMR) — plus an
   **EPOC** "afterburn" bump for up to 60–90 minutes after exercise.

4. **Substrate selection.** This is the core. An exercise-intensity baseline
   sets the fat-vs-carb split, then **insulin suppresses fat burning** (high
   insulin → little fat oxidation). Carb energy is drawn in priority order from
   gut glucose → liver glycogen → muscle glycogen → amino acids; fat energy from
   dietary (gut) fat → body-fat stores.

5. **Storage of surplus.** Absorbed nutrients that aren't burned refill muscle
   and liver glycogen (muscle first when insulin is high — the "refuelling
   window"), with any remainder going to fat.

6. **Hepatic gluconeogenesis (GNG).** The liver continuously manufactures new
   glucose from three precursors — **lactate** (Cori cycle, activity-driven,
   with a post-exercise flush), **alanine** (from muscle protein, rising with
   fasting duration and costing amino-acid pool), and **glycerol** (from fat
   breakdown). When insulin is low (fasting/exercise) this glucose feeds blood
   sugar directly — its own **brown band** on the chart — and any surplus
   refills liver glycogen. This is why the liver doesn't sit empty between
   meals, and why an overnight fast lands at ~40–65% liver glycogen by morning
   rather than zero. When fasting or asleep, whole-body glucose use drops to the
   obligate brain/red-cell need, spared by ketones as the fast deepens.

7. **Alcohol**, when present, is burned at a fixed rate and **strongly
   suppresses fat oxidation** while it's in the system.

8. **Muscle protein synthesis (MPS)** runs as a parallel track. After resistance
   training it **rises to a peak a few hours later, then decays back toward
   baseline over ~24–48 h** (hard aerobic work gives a smaller, ~12 h bump) —
   so a day-old session shows only a little residual elevation, not the full
   peak. It's scaled by whether enough amino acids (protein) are available and
   gets a boost during the deep-sleep growth-hormone window.

9. **Sleep** is modeled as a fasting, fat-dominant state in which the liver
   slowly exports glucose overnight (net of GNG) — which is why the liver store
   is partly depleted by morning and breakfast refills it.

Because it's a **deterministic** model, the same profile + schedule always
produces exactly the same result.

---

## The charts and status panel

| # | Chart | Shows |
|---|-------|-------|
| 1 | **Substrate trace** (primary) | Stacked % of energy from each fuel source at every moment, with liver and muscle glycogen levels overlaid as dashed lines (right axis). The fractions always sum to 100%. |
| 2 | **Insulin & glucose** | Insulin index (0–10) plus a blood-glucose proxy (low / normal / elevated). |
| 3 | **Glycogen stores** | Liver and muscle glycogen in grams, with dashed reference lines at 50% and 20% of liver capacity. |
| 4 | **MPS activity** | Muscle-protein-synthesis rate over the 5 days. |
| 5 | **Calorie balance** | Cumulative calories eaten vs. burned across the whole 5 days, shaded green (surplus) or red (deficit) — this is where a small daily deficit or surplus visibly compounds. |
| 6 | **Blood alcohol (BAC)** | Estimated BAC in g/dL, with dashed reference thresholds (0.02 … 0.40), a tinted band above the US 0.08 limit, and a marker on the axis for each drink. **Only appears when the schedule contains alcohol.** |

Every chart spans all 5 days left-to-right. The horizontal axis is labelled
**"Day 1"…"Day 5"** at each midnight (with a 12:00 tick mid-day), and faint
vertical lines mark the day boundaries. **Dashed vertical lines** mark meals,
**blue/violet tint** marks exercise, **dark tint** marks the nightly sleep
periods, and the **black line** is the draggable "now" cursor.

The **Status panel** (below chart 1) translates the current moment into plain
English: metabolic phase, dominant fuel, glycogen status, MPS status,
gluconeogenesis rate, hours fasted, **glucose surplus (today)** and **body-fat
store**, and context-specific **flags** (e.g. "Fat oxidation suppressed —
insulin elevated," "Muscle glycogen replenishment window," "Alcohol present,"
"Liver glycogen low").

Every flag describes **that moment**, not the week as a whole. The protein-timing
warning, for example, names the training session it refers to and appears only
while that session is the one actually driving muscle protein synthesis — so it
tells you *which* workout was under-fuelled and *when* it mattered.

The **glucose surplus** figure is per-day: it's the glucose absorbed today that
couldn't be burned or stored as glycogen (i.e. converted to fat via de-novo
lipogenesis), and it **resets each midnight** — so a carb-heavy day flags a
surplus that day without leaving the warning stuck on for the rest of the week.

The **body-fat store** is a real reserve (estimated from your profile via the
Deurenberg body-fat formula). It **goes up when you store fat** (surplus glucose
or unburned dietary fat) and **down when you burn body fat**, so it drifts with
the circumstances rather than only climbing. The "Δ … this run" shows the net
change since the start of the current 5-day window; the absolute reserve carries
over if you use **Continue**.


### Blood alcohol (BAC)
When any meal carries alcohol, a sixth chart appears estimating **blood alcohol
concentration** from the circulating ethanol the model is already tracking, via
the Widmark relation:

```
BAC (g/dL) = grams of circulating ethanol / (body weight kg x 10 x r)
```

`r` is the distribution factor — the fraction of body mass that behaves as
alcohol-diluting water. It is **0.68 for men, 0.55 for women**, nudged by
training status (sedentary x0.97, recreational x1.00, trained x1.03,
athlete x1.05) since leaner bodies hold more water per kilogram. So the same
drink produces a markedly higher BAC in a lighter or less lean person.

The **status panel** adds, whenever BAC is above zero: the current value, a
plain-language impairment label, when the alcohol fully clears, and — if you are
over 0.08 — when you would drop back below it. Both are given as an interval and
the clock time it lands on.

**Alcohol with food peaks lower and later.** A drink taken within 30 minutes of
real food (>=10 g of carbs/protein/fat, in the same entry or a neighbouring one)
absorbs on a slower curve, reflecting delayed gastric emptying and gastric
alcohol dehydrogenase. In the built-in check, 70 g on an empty stomach peaks at
**0.106 g/dL at 21:40**; the same 70 g alongside a large dinner peaks at
**0.085 g/dL at 23:00**.

> **These are estimates, not a breathalyser.** Real BAC varies by roughly
> ±15–20% between individuals, and the model knows nothing about your tolerance,
> medications, or health. It is an educational illustration of how alcohol
> clears — **never** a basis for deciding whether to drive. When in doubt,
> do not drive.

---

## Deliberate deviations

A few intentional differences from a strictly literal reading of the original
model spec, each chosen to make the app more correct or more usable:

1. **Chart.js is bundled locally** (`chart.umd.min.js`) instead of being loaded
   from an internet CDN. This is why the app works offline. If you would rather
   load it from the internet, replace the `<script src="chart.umd.min.js">` line
   near the bottom of `index.html` with
   `<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>`.

2. **During exercise, muscle glycogen is used before liver glycogen.** The spec
   lists liver first in all cases, but working muscle actually burns its own
   local glycogen, and the liver can only release glucose slowly (~1.5 g/min).
   Using the strict order left muscle stores untouched even during a run, which
   contradicted the expected behavior. At rest, the liver is still used first.

3. **The absorption curve is mass-conserving.** The spec's literal formula
   `grams × (τ/peak) × exp(1 − τ/peak) × (1/peak)` peaks at the right time but
   its *area* is `grams × e` (~2.7×), so it would deliver ~2.7× the mass eaten
   into circulation. Dropping the `exp(1)` factor normalizes the area to the
   grams actually eaten. (This is the fix for the "alcohol takes days to clear"
   bug — 70 g of ethanol now clears in ~12 h at the 0.1 g/min oxidation rate,
   instead of the ~2.7× longer time the inflated absorption produced.)

4. **Fat-oxidation capacity is read as g/min, not kcal/min.** The spec labels
   `FAT_OXIDATION_CAPACITY` (0.07–0.15) as "kcal/min", but those numbers match
   resting/Fatmax fat oxidation in **g/min** (Achten & Jeukendrup). Used as
   kcal/min it capped fat burning at ~130 kcal/day — far too little to fuel
   resting metabolism — so it is multiplied by 9 kcal/g. (With the old inflated
   absorption this cap never mattered; once absorption was corrected, it did.)

Also note: **insulin is calibrated** so a 60 g carbohydrate meal peaks the
insulin index at about 4.5 (the spec's stated target of "~4–5"); the gain was
re-tuned after fix #3 changed how much glucose actually reaches circulation.
Insulin peaks roughly 90 minutes after a meal because the model tracks the
*biological effect* of insulin, not the shorter-lived serum concentration.

**Tip:** to watch the alcohol pool deplete directly, add a meal with alcohol,
then drag the "now" cursor — the status panel shows **"Alcohol in system … g"**
at every timestep while any ethanol remains.

---

## Limitations

This is a teaching model. It deliberately simplifies or omits a great deal of
real physiology. Among the larger simplifications:

- **Population averages only.** The equations don't know your genetics, insulin
  sensitivity, gut transit speed, body composition, hormones, medications, or
  health conditions.
- **Body-fat stores are treated as effectively unlimited** across the run; the
  model tracks net fat storage but doesn't cap it.
- **Insulin, glucose, and "insulin index" are proxies,** not measured
  milli-unit or mg/dL values. The blood-glucose readout is a coarse
  low/normal/elevated indicator, not a glucometer.
- **Each day is what you schedule it to be**, but there is no longer-term
  *adaptation* (fitness gains, changing insulin sensitivity, etc.) as the days
  pass — the same event on Day 1 and Day 5 is modeled identically. What carries
  over is the physical state: glycogen, amino-acid pool, and calorie balance
  flow continuously across all 5 days. Glycogen starts full on the first
  midnight, so Day 1 begins slightly "fresher" than later days.
- **Absorption is idealized.** Fixed gamma curves regardless of meal size,
  fiber, food matrix, or mixed-meal interactions. Very large meals absorb on the
  same shaped curve as small ones.
- **Fixed alcohol clearance** (~one drink/hour) regardless of body size or
  tolerance; it does not model intoxication, impairment, or health effects.
- **MPS and the "leucine threshold" are simplified** to a few rate tiers and a
  single 20 g protein / ±2 h timing rule.
- **No thermic effect of food, no micronutrients, no hydration, no fatigue, no
  hormonal cycles, no training adaptation over the 5 days.**
- The very first morning is primed with the previous evening's meal and
  overnight sleep (so day 1 starts realistically mid-sleep rather than cold).

If a number looks surprising, assume the model is being simplistic before
assuming your body would behave that way.

---

## System requirements & restrictions

- **A modern web browser** — Chrome, Edge, Firefox, or Safari from roughly the
  last five years. Chart.js 4 needs a reasonably current browser.
- **JavaScript must be enabled** (it is, by default, in normal browsers).
- **Will not run in Internet Explorer.**
- No account, no admin rights, and no data leaves your device — everything runs
  locally in the browser. Opened from a local folder it needs no internet at
  all; served from a link it fetches only the page itself.
- **Phones and tablets are supported.** Below ~980 px the layout switches to a
  three-tab view built for touch, and the app can be installed to the home
  screen — see [Using it on a phone](#using-it-on-a-phone). The charts are still
  easier to read on a larger screen.

---

## Possible errors & troubleshooting

**The page is blank, unstyled, or the charts don't appear.**
- The most common cause is that the files got separated. Every file must be
  in the **same folder**, with their **original names**. If you copied only
  `index.html`, go back and copy the whole folder.
- Make sure you extracted the ZIP rather than opening `index.html` from *inside*
  the ZIP viewer. Right-click the ZIP → **Extract All** first, then open the
  extracted folder.

**"Chart is not defined" or charts missing, everything else works.**
- `chart.umd.min.js` is missing, renamed, or wasn't copied. Restore it to the
  folder next to `index.html`.
- If you switched the app to load Chart.js from the internet CDN, check that you
  actually have an internet connection.

**Nothing happens when I click "Run simulation," or numbers look frozen.**
- Open the browser's developer console (**F12**, then the **Console** tab) and
  look for red error text. Nine times out of ten it names a missing or renamed
  file.

**A chart is empty or a line is flat.**
- That may be correct — e.g. muscle glycogen stays flat if you never exercise,
  and MPS stays at baseline with no resistance training. Add the relevant event
  and click **Run simulation**.
- Check that meal/exercise **times are valid** and that durations are positive
  numbers.

**I entered a meal but the totals don't match the macros.**
- The app uses the macro grams (carb/protein/fat/alcohol) you enter to drive
  metabolism; the "kcal" field is only used for the calorie-balance chart. They
  won't perfectly agree unless your kcal equals 4×carbs + 4×protein + 9×fat +
  7×alcohol. Enter whichever you care about most.

**"Nothing recognised that file" when importing a food log.**
- Check you exported the right report: **Export Servings** (food) or **Export
  Exercises** (training), not one of Cronometer's other exports.
- The first line has to be the export's original header row. If you opened the
  file in a spreadsheet and renamed, reordered or deleted header cells, export
  a fresh copy.
- Some spreadsheets save as semicolon-separated CSV in non-US locales. Save as
  a plain comma-separated CSV.

**A food log imported, but a day's totals look wrong.**
- Open the review screen again and look at the warnings — an unreadable cell
  counts as 0 and says so there.
- If you imported the same file twice, that day now holds both copies. Import
  adds and never replaces; delete the duplicates from the schedule list.
- Check the **merge** toggle. Merging changes how many events a day has, but
  never that day's totals — if the totals themselves moved, something else did
  it.

**Imported meals are all at 07:30 / 12:30 / 18:30.**
- Your Cronometer diary isn't recording times, so each entry was placed by its
  meal group. Every one of those rows is labelled *"time assigned by this app"*.
  Adjust the defaults or individual rows on the review screen — meal timing
  genuinely changes the results.

**An imported workout burns a different number of calories than Cronometer said.**
- Expected. The simulator computes the cost itself from duration, intensity and
  your profile, then spends it out of specific fuel stores. Cronometer's figure
  is shown for reference only and is never used.

**The results look extreme or physically impossible.**
- Check your inputs for typos (e.g. 700 g of carbs instead of 70). The model
  will faithfully simulate nonsense inputs.

**A security prompt appears when opening the file.**
- Some setups warn before opening local HTML. It is a normal static web page
  and safe to open. If your organization blocks local HTML entirely, ask your
  IT department, or serve the folder over a simple local web server.

**It won't open from a network drive or cloud-sync folder.**
- Copy the folder to a local disk (e.g. your Desktop or Documents) and open it
  from there.

**Advanced: running via a local server (optional).**
- The app is designed to open directly (`file://`) with no server. If you ever
  need one, from inside the folder run `python -m http.server 8000` and visit
  `http://localhost:8000/` in your browser.

---

## Customizing / editing the app

All files are plain text — edit them with any code or text editor (VS Code,
Notepad++, etc.). Nothing needs to be "compiled."

- **Change the default day or default profile:** edit `DEFAULT_SCHEDULE` and
  `DEFAULT_PROFILE` near the bottom of `simulation.js`.
- **Tune the physiology** (absorption speeds, insulin behavior, MET values, fat
  fractions, MPS rates): all live in `simulation.js`, with comments pointing to
  the relevant part of the model.
- **Change colors or layout:** `styles.css` for the page, and the `COLORS`
  object at the top of `charts.js` for the chart fuel colors.

After any edit, just refresh the browser (no build step).

### Regression test — run this after changing the model
This repository includes a permanent, committed regression test at
**`test/roundtrip-test.html`**, next to the app files.

It covers three areas:

1. **Scenario chaining** — that continuing a scenario reproduces an
   uninterrupted run **exactly**, across all 18 state and trajectory variables
   to floating-point tolerance.
2. **Post-workout glycogen resynthesis** — two fixtures at different carb
   doses, checking the muscle refill, that mass is conserved, and that the
   larger dose stores more.
3. **Food-log import** — 124 checks over the fixtures in
   `test-scenarios/imports/`: column matching against decoy headers
   (`Net Carbs`, `Saturated`, `Cystine`), quoted food names containing commas,
   blank cells becoming 0 rather than NaN, alcohol grams reaching the schedule
   event, default-time assignment, day-range mapping, the merge toggle, and a
   clean rejection for a file that isn't a Cronometer export.

To run it, serve this folder and open the page:

```bash
python -m http.server 8000
```

then visit `http://localhost:8000/test/roundtrip-test.html`. It runs on load and
shows a green (pass) or red (fail) verdict; `window.__results.pass` gives the
same answer programmatically.

The page must be **served over HTTP** — the fixtures are fetched, which a
`file://` open cannot do. Opened that way, the chaining section still runs and
the two fixture-based sections report that they were skipped.

**Why it matters:** if you add any new variable that persists between timesteps
and forget to include it in the scenario file's `initialState` (or in the
`carryInEvents` history), chained runs will silently drift away from continuous
ones — curves that render fine and mean nothing. This test is what catches that.
It is worth re-running after any change to `simulation.js`.

The import checks guard a quieter failure: an importer that "works" while
putting the wrong numbers in. Because Cronometer's column count varies with
each user's diary settings, anything reading nutrients by column *position*
breaks for one person and not another — so the fixtures deliberately include
decoy columns and awkward rows, and are worth extending rather than tidying.
Re-run after any change to `importers.js`.

---

## Scientific references

The model draws on standard exercise-physiology and nutrition sources,
including: Mifflin-St Jeor (BMR); McArdle, Katch & Katch, *Exercise Physiology*,
8th ed. (glycogen); Bergström et al. 1967 and Hawley et al. 1997 (muscle
glycogen); Achten & Jeukendrup 2004 (Fatmax / fat oxidation); Brooks & Mercier
1994 (crossover concept); Sidossis & Wolfe 1996, Wolfe 1998 (insulin and fat
oxidation); Richter & Hargreaves 2013 (exercise glucose uptake); Boirie et al.
1997, Dangin et al. 2001 (protein kinetics); Fielding et al. 1996 (chylomicrons);
Wahren et al. 1971 (hepatic glucose output); Børsheim & Bahr 2003 (EPOC); Siler
et al. 1999, Shelmet et al. 1988 (alcohol metabolism); Norton & Layman 2006,
Churchward-Venne et al. 2012 (leucine / MPS).

These are cited to indicate the *origin of the model's assumptions*; the
implementation is a simplified approximation and should not be taken as a
faithful reproduction of any single study.

---

## License

Copyright (C) 2026 Rick Theiner

This program is free software: you can redistribute it and/or modify it
under the terms of the GNU General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option)
any later version. See [LICENSE](LICENSE) for the full text.

This program is distributed WITHOUT ANY WARRANTY. It is intended for
educational and exploratory use and is not medical advice.
