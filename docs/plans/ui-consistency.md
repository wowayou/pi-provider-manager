# UI Consistency Plan

Working plan for the design-system follow-ups found in the 2026-10-01 UI review. Live rules are in
`AGENTS.md`; dated verification goes in `design-qa.md`. The v0.4.7 visual language and the orange palette
are the baseline (owner decisions 2026-09-24 and 2026-10-01). Nothing here changes the palette, fonts, or
layout grid. Delete an item from this file once it ships, or the whole file once none remain.

Handled separately from this plan: the sidebar add-button height and the Claude tip and path-source label
(#142), and the stylesheet token check with the `.model-filter` token fix (the pull request that added this
file).

## How to verify any item here

Owner feedback asks for visual experiments small enough to compare one change at a time. For each item:

1. Capture before/after screenshots from `server.mjs` with `PI_PROVIDER_MANAGER_SERVE_UI=1` and isolated
   Pi, Codex and Claude directories, in light and dark, at 1440×900 and 390×844. `?demo=1` is enough for
   layout-only comparisons; anything touching saves must also run without it.
2. Attach the pairs to the pull request and wait for owner approval before the next item.
3. Run `npm run build`, `npm run test:server` (which includes the token check), and `npm run test:ui`. The
   contrast, target-size and 12px CJK browser cases must still pass.

## 1. Type and button scale (visual; start with one surface)

Evidence, measured on the production build: 12 distinct `font-size` values in `src/styles.css` (11, 12,
12.5, 13, 13.5, 14, 15, 16, 18, 21, 24, 28) and 16 distinct button size combinations. The model-table
toolbar buttons (获取模型, 批量添加, 全部用安全值) are 16px/700, heavier than the 18px section heading
above them and far above the 13px body.

- Add `--text-xs/sm/md/lg/xl/2xl` (12/13/14/16/18/24) beside the spacing and radius tokens.
- Add three button sizes (32/40/44px), weight 600.
- **First slice (done, awaiting owner approval):** the tokens above, `--button-sm/md/lg`, and a
  `.button-md` size class (40px, 14px/600, 16px icons). Every button in the model-table toolbar uses it, in Pi
  (全部用安全值, 获取模型, 批量添加, 添加模型) and Codex (批量添加, 添加模型), because they share one toolbar
  row. At 600px and below the icon-only buttons are 40×40 instead of 44×44.
- Next, only after approval: move other button groups onto `.button-sm/md/lg` and other text onto the
  `--text-*` tokens, one surface at a time.
- Accept when every changed rule reads a scale token, and CJK text stays at 12px or above.

## 2. Claude Code summary, footer and settings parity (visual, converging on existing Pi/Codex look)

Evidence: in `src/claude-view.jsx` the provider summary has no icon or credential status, the base URL is a
button styled like an input, and 删除供应商 is a solid `danger-button` where Pi/Codex use an outlined one.
The footer note is 16px and centered or left-aligned instead of the small grey note beside the primary
action. Claude settings list 配置范围 as paragraphs where Pi and Codex use a `<dl>` key–value card.

- Extract the Pi/Codex provider summary, wizard footer and key–value list into `ui-kit.jsx`, and have
  Claude use them. Pi and Codex output should stay pixel-identical, so compare their screenshots too.
- Solid `danger-button` stays only on confirm-delete dialogs.
- Accept when Claude's step 3 and settings match Pi/Codex anatomy, and the Claude production workflow
  browser case still passes.

## 3. Sidebar status (visual)

Evidence: the row dot means "credential configured" (`provider.ready` in `src/App.jsx`) but is explained
only by its `aria-label`. When a badge (默认, 生效中, 全局默认) is present, the protocol subtitle is cut
to "Anthro…".

- Show the dot only when something needs attention (no credential), with visible text in the row's
  tooltip and the existing `aria-label`.
- Move the badge onto the name line so the subtitle keeps its width.
- Accept when a missing credential is still visible at a glance and row height stays unchanged.

## 4. Save from any step when editing (behaviour; needs owner decision first)

Evidence: editing a saved provider opens the three-step wizard; steps 1 and 2 only offer 下一步, so a
Base URL change needs a trip to step 3 before it can be saved.

- Proposal: for a persisted provider, show 保存更改 on every step. New drafts keep the three-step flow.
- Constraints: the step's own validation still runs before saving (`lib/validation.mjs` on both ends),
  and the leave guard and 409 behaviour are unchanged.
- Do not start without owner approval: it changes how the beginner flow looks while editing.
