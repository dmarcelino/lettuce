---
name: lettuce-ui-verification
description: 'lettuce UI-change gates: before implementing any web/ change, mock the target state at phone (390px) and desktop (1280px) into the flow plan and get the mockups approved; after implementing, a holistic visual pass over screenshots and the live page — task accomplishment, consistency with sibling screens, broken layout, overflows, stray scrollbars — never pixel diffs. Mechanics: a static mock page linking web/src/styles.css for fidelity, rendered to plan/mockups/ PNGs with headless chromium and embedded in plan.md, plus Playwright screenshots and ui-check output in .ui-check/. Read before implementing any web/ UI change, before handing a UI change off for the container test, or when a review asks "does this fit the app".'
---

# UI change gates: mockups before, visual pass after

Two gates bracket every `web/` UI change. Both are eyes-on: no pixel-diff tool, no new CI job —
`ui-check` already owns the measurable layout assertions. The gates exist because a transcript-only
review cannot see that a row wraps, a timer wobbles, or a control reads wrong at 390px.

## Gate 1 — target state approved before implementing

When the change is more than a trivial fix, before writing UI code, in the **plan** stage — dev-flow's UI
feature gate requires rendered mockups in the plan directory and refuses a plan without them
(`mockupGlobs`, default `*.png`):

1. Write one static mock per screen/state at `.dev-flow/<slug>/plan/mockups/<screen>.html` that **links
   the real stylesheet** — from `plan/mockups/` that is `../../../../web/src/styles.css` — and
   reuses the app's own class names and tokens. Fidelity is then by construction, not by effort —
   colours, type scale, borders, square corners all real.
2. Render each one at **both widths — phone 390 and desktop 1280** with headless chromium (the command the
   plan stage prescribes: `--no-sandbox --disable-gpu --hide-scrollbars --window-size=<width>,<height>
   --screenshot=…`), one section per variant/state, and **embed every PNG in plan.md** so the plan is one
   reviewable document. A mock that was never rendered is not a mockup.
3. Name a recommendation and **stop for Approve?** — the gate question is the mockup approval, and the
   approved mock is the spec.

Skip mockups only for changes a screenshot of the fix would explain better than a mock (one-line
label, colour token); say so in the PR. `--ui` is what makes the gate demand them: `flow start <slug>
--ui`.

## Gate 2 — holistic visual pass after implementing

After the implementation runs in the container (or the local stack), before handing to the operator's
own test — and repeat on the merged artifact if the bundle changed:

1. Capture every changed surface at both widths: `bun run ui-check` (screenshots land in
   `.ui-check/`), or Playwright against the live stack when the state needs real data — drive a
   real turn or state, then screenshot. A quick live sampler (poll a DOM node's text every ~250 ms
   through a scripted turn) is how the working line was actually verified, transient states included.
2. Review the screenshots holistically — the checklist is the gate:
   - can a user accomplish the task from what is on screen, no hidden affordances;
   - does the surface read like its neighbours — same type scale, spacing rhythm, icon language,
     control heights (`--control-h`), square theme;
   - nothing broken: clipped text, overlapping rows, text colliding with icons;
   - no horizontal overflow at 390px; long strings truncate mid-string where the tail matters;
   - no unnecessary scrollbars (a one-line textarea with a scrollbar is the classic);
   - transient states exist in both directions (loading/empty/error), and numbers don't jitter.
3. Pixel accuracy is **not** the goal — placement inside a few pixels of a mock is fine; a control
   that reads wrong, or a state no one tested, is not.
4. Record what was looked at in the PR's container-test section: surfaces, widths, states.

Fix what the pass finds before the PR; a visual-pass finding that changes scope goes back to gate 1.

## Why this lives outside CI

Tier A has no stack and no data; Tier B cannot yet seed an agent, so it proves boot, not screens.
Layout invariants worth asserting forever do belong in `ui-check` as measured assertions — the visual
pass is for everything that needs judgment, which is most of design.
