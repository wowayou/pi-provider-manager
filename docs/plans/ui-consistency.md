# UI Consistency Plan

Working plan for the design-system follow-ups found in the 2026-10-01 UI review. Live rules are in
`AGENTS.md`; dated verification goes in `design-qa.md`. The v0.4.7 visual language and the orange palette
are the baseline (owner decisions 2026-09-24 and 2026-10-01). Nothing here changes the palette, fonts, or
layout grid. Delete an item from this file once it ships, or the whole file once none remain.

Handled separately from this plan: the sidebar add-button height and the Claude tip and path-source label
(#142), and the stylesheet token check with the `.model-filter` token fix (the pull request that added this
file). Item 1, the type and button scale, shipped in #144–#147; item 2, Claude Code summary, footer and
settings parity, in #148; item 3, sidebar status, in the pull request that removed it from this file.
Their rules are in `AGENTS.md`.

## How to verify any item here

Owner feedback asks for visual experiments small enough to compare one change at a time. For each item:

1. Capture before/after screenshots from `server.mjs` with `PI_PROVIDER_MANAGER_SERVE_UI=1` and isolated
   Pi, Codex and Claude directories, in light and dark, at 1440×900 and 390×844. `?demo=1` is enough for
   layout-only comparisons; anything touching saves must also run without it.
2. Attach the pairs to the pull request and wait for owner approval before the next item.
3. Run `npm run build`, `npm run test:server` (which includes the token check), and `npm run test:ui`. The
   contrast, target-size and 12px CJK browser cases must still pass.

## 4. Save from any step when editing (behaviour; needs owner decision first)

Evidence: editing a saved provider opens the three-step wizard; steps 1 and 2 only offer 下一步, so a
Base URL change needs a trip to step 3 before it can be saved.

- Proposal: for a persisted provider, show 保存更改 on every step. New drafts keep the three-step flow.
- Constraints: the step's own validation still runs before saving (`lib/validation.mjs` on both ends),
  and the leave guard and 409 behaviour are unchanged.
- Do not start without owner approval: it changes how the beginner flow looks while editing.
