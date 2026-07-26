# Phase 4b — Bottom tab navigation (mobile only)

Insert this between Phase 4 and Phase 5 of `MOBILE_SHARING_TASK.md`.

**Scope:** `metabolism-sim` only. Metabolism-EDU is out of scope for all remaining work.

## Goal

Add a bottom tab bar on narrow screens with three tabs:

1. **Events** — profile fields, schedule, add-event form, Run control
2. **Output** — charts and results panels
3. **Files** — import, export, continue-from-scenario

Rationale: on a phone, stacking everything into one long scroll means paging past the
controls to reach the charts and back again. Tabs make each mode a fixed destination.

**This is a UX improvement, not a bug fix** — the Phase 4 stacking fix already resolved the
panel overlap. Don't reintroduce or work around that.

## Scope boundary

Tabs apply **below the existing 980px breakpoint only.** The desktop sidebar layout stays
exactly as it is — it works, and it's the layout I use most. Above 980px the tab bar should
not exist in the layout at all.

---

## Step 1 — Map before building

List which existing DOM elements go into which tab, and report it before making changes.
Flag anything that doesn't obviously belong to one tab.

Specifically: **global banners must not live inside a tab panel.** The carry-over banner and
the stale-storage export nudge both need to be visible regardless of which tab is active —
an export reminder buried in an inactive tab defeats its purpose. Put them above the tab
panels, in persistent layout.

---

## Step 2 — Known failure modes

Each of these fails silently. Handle all four.

### Chart.js in a hidden container

If the Output panel starts as `display: none`, Chart.js initializes at zero width and renders
blank or as a sliver. Call `chart.resize()` when the Output tab becomes active. Verify by
loading the app, running a sim while Events is active, *then* switching to Output — that's
the failing sequence.

### Safe area inset

A fixed bottom bar sits under the iPhone home indicator. Needs both:

- `padding-bottom: env(safe-area-inset-bottom)` on the bar
- `viewport-fit=cover` added to the viewport meta tag

The `env()` variable returns zero without `viewport-fit=cover`, so the padding silently does
nothing if you add only one.

### Keyboard collision

When the number pad opens, a `position: fixed` bar can float mid-screen over the inputs.
This app is mostly data entry, so this matters. Pick one and tell me which:

- Hide the bar while any input has focus, or
- Use a flex column with the bar as a non-fixed last child

### Draft preservation

Switching tabs mid-entry must not discard a half-entered event. Phase 4's autosave already
persists the `draft` field, so this probably works — **verify it explicitly rather than
assuming.** Test: start entering an event, switch to Output, switch back.

---

## Step 3 — Behavior details

- **After a successful run, auto-switch to Output.** Running a sim and seeing nothing change
  is confusing. Keep it a one-time switch on completion, not on every recalculation.
- Persist the active tab in the existing autosave so a reload returns to where I was. If this
  interacts awkwardly with the restore path, skip it and say so.
- Tab targets ≥44px, 16px minimum font — consistent with Phase 4.
- Show the active tab clearly. Color alone isn't enough; use weight or an indicator too.

---

## Step 4 — Regressions to check

Re-run before committing:

- [ ] Phase 1 round-trip regression test — 18 variables, 0 failures
- [ ] Phase 3 export and import both still work
- [ ] Phase 4 `numField()` guard still blocks garbage from reaching the integrator
- [ ] The `draft` field still does not leak into exported scenario files
- [ ] Desktop layout above 980px is visually unchanged

**Testing caveat you found in Phase 4:** the `pagehide` flush overwrites planted localStorage
values before a reload, which made two tests pass for the wrong reason. Neuter
`localStorage.setItem` before reloading when testing any storage path here.

---

## Constraints

- No service worker. Still deliberate — it would pin installed users to stale builds.
- Restore `test/roundtrip-test.html` to the project folder if it isn't there. It should be a
  committed, permanent regression test, not a scratch file.
- Commit when the regression list above is green.
