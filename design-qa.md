# Design QA

- Evidence date: `2026-08-18`
- Evidence scope: historical acceptance and compatibility results, not live repository or machine state
- Product version: `0.1.8`
- Source visual truth: `design-reference.png` plus user acceptance screenshots for the settings, long-model-list, and post-save problems
- Model editor screenshot: `qa/pi-provider-manager-v11-models.png`
- Settings screenshot: `qa/pi-provider-manager-v11-settings.png`
- Success/next-step screenshot: `qa/pi-provider-manager-v11-success.png`
- Responsive evidence: `qa/pi-provider-manager-v11-responsive-900.png`
- Dark theme evidence: `qa/pi-provider-manager-v11-models-dark.png`, `-settings-dark.png`, `-success-dark.png`, `-responsive-900-dark.png`
- Primary viewport: `1487 x 1058 CSS px`, device scale factor `1`
- State: demo mode with generic paths and fake credentials only

**Findings**

- No actionable P0/P1/P2 differences remain for the V1.1 scope.
- [P3] Some provider marks use the closest available Phosphor icon instead of licensed official provider assets.
  - Impact: minor brand-fidelity difference; model recognition and interaction are unaffected.
  - Follow-up: add official marks only when their license and source files are suitable for redistribution.

**Acceptance Problems Addressed**

1. Placeholder Settings action
   - Earlier evidence: Settings only exposed the config path and changed no Pi behavior.
   - Fix: real settings screen for default provider/model/thinking, transport, thinking-block visibility, Pi version, manager version, config path, and compatibility policy.
2. Unclear post-save state
   - Earlier evidence: the user remained at the bottom of a long form with only a toast.
   - Fix: dedicated success screen with the exact `pi --model provider/model:thinking` command, `/model` guidance, provider verification, upstream error explanation, and clear next actions.
3. Long model catalog and page scrolling
   - Earlier evidence: several model rows plus advanced settings pushed primary actions below the fold.
   - Fix: sticky model header, internal model-list scrolling, compact rows, bulk model-ID import, and responsive local table scrolling.
4. Thinking levels encoded as model IDs
   - Earlier evidence: model IDs ending in `-max` and `-xhigh` appeared alongside Pi's separate thinking-level status.
   - Fix: warning when IDs look like thinking aliases, with guidance to use the reasoning capability field and Shift+Tab unless the gateway truly exposes those IDs.
5. Pi upgrade data-loss risk
   - Earlier behavior: editing a model rebuilt the full known object and could drop future/unknown metadata.
   - Fix: preserve unknown provider, model, model-compat, and settings fields while updating known fields; automated tests cover future fields.

**Required Fidelity Surfaces**

- Fonts and typography: passed. Chinese and Latin hierarchy, wrapping, labels, commands, and status copy are legible without target-viewport truncation.
- Spacing and layout rhythm: passed. Main editor stays within the viewport; long catalogs scroll internally; Settings and Success pages use coherent desktop spacing.
- Colors and visual tokens: passed. Orange actions, green success states, blue help links, warnings, borders, and neutral surfaces are consistent.
- Image quality and asset fidelity: passed. The Pi mark comes from the selected source; standard UI icons use Phosphor rather than handcrafted assets.
- Copy and content: passed. Provider/model/thinking semantics, secret boundary, save handoff, upstream error distinction, and compatibility wording match actual Pi behavior.

**Primary Interactions Tested**

- Open real Settings and modify transport/thinking visibility in demo mode.
- Navigate all three provider setup steps.
- Choose credential migration from a provider dropdown.
- Bulk-import several model IDs and ignore duplicates.
- Select a default model and set a model-level API override.
- Save and reach the dedicated success screen.
- Copy the exact Pi model command.
- Return from Success to the saved provider detail.
- Check 900px layout for page-level horizontal overflow.
- Check browser console and page errors: none.
- Backend isolation: static UI serving, secret non-disclosure, router-style multi-model writes, per-model API override, credential migration, settings writes, rollback, and unknown-field preservation passed.

**Compatibility Evidence**

- Installed Pi version detected as `0.84.2`.
- Manager version reported as `0.1.8`.
- 2026-08-18 production-shape smoke: with `PI_PROVIDER_MANAGER_SERVE_UI=1` and an isolated `PI_CODING_AGENT_DIR`, the manager wrote a fixture provider and Pi `0.84.2` listed `compat-fixture/fixture-model` with the expected context, output, thinking, and image capabilities. The fixture used a non-routable URL and a dummy key; no real credential or home config was touched.
- Real state shows providers `any-codex` and `sota`, default `sota/claude-opus-5:high`, with no key field in API responses.
- Single-process production launcher remains available after the launching shell exits.
- Launcher identity-checks `/api/state`, automatically selects `43127-43146`, and does not reuse unrelated apps or stale Service Worker origins on Vite's common `4173` port.

**Implementation Checklist**

- [x] Real settings page
- [x] Dedicated post-save success flow
- [x] Sticky/internal-scrolling model catalog
- [x] Bulk model-ID import
- [x] Thinking-alias warning
- [x] Unknown-field preservation
- [x] Installed Pi version detection
- [x] Persistent single-process WSL launcher
- [x] Production build
- [x] Backend and Sites tests
- [x] Playwright desktop, settings, success, interaction, console, and responsive checks

**Follow-up Polish**

- Add licensed provider marks when available.
- Add CSV/CC-Switch import only after a redacted fixture defines the source schema.

## Interaction and UI Detail Pass

Scope: interaction and visual detail only. Product structure, flows, backend contracts, and copy semantics are unchanged.

**Design direction**

- Signature: the machine face. Provider IDs, base URLs, model IDs, token counts, config paths, versions, and the `pi --model` command are now set in the monospace `--mono` stack; prose stays in Inter. The tool configures a CLI agent, so the values a user copies into a config file are typeset like a config file.
- Tokens: added an ink ramp (`--ink`, `--ink-2`, `--ink-3`), `--line-strong`, `--orange-tint`, and motion tokens (`--fast` 110ms, `--base` 180ms, `--ease`). The orange brand values are unchanged.

**Interaction fixes**

- Focus: a single `:focus-visible` ring across every interactive element. Previously only text inputs had any focus styling, so keyboard users had no visible position.
- Protocol picker: real `radiogroup` semantics with `aria-checked`, roving `tabIndex`, and arrow-key selection.
- Dead affordances: the two blue link-styled `<span>` elements now do something. Step 1 opens a hint panel that maps documented endpoint suffixes to protocols; step 3 applies safe defaults to every model row.
- Toast: single shared timer (overlapping toasts previously cut each other short), `role="status"`, a manual dismiss control, and a distinct error tone.
- Copy: reports success only when `navigator.clipboard.writeText` resolves. On rejection it selects the command text and says so instead of claiming a copy that did not happen.
- Bulk import: Escape and backdrop close, Cmd/Ctrl+Enter submits, a live count that separates new IDs from ones already in the list, and a disabled action when nothing new would be imported.
- Delete: arms on first click, deletes on the second, and disarms on blur or after 3.2s.
- Token fields: accept `200k` / `1.05m`, select-all on focus, commit on Enter, and expose the exact token count on hover.
- Settings: tracks dirty state, disables the save action when nothing changed, and reports which state it is in.
- Errors use `role="alert"`; the view scrolls to top on step and view changes.

**Density and layout**

- Model rows dropped from 112px to 66px by removing the duplicated per-field "safe value" links (both wrote both fields) in favour of one header action, and by moving the protocol-override note under the model ID it describes. Roughly six rows are now visible in the catalog instead of three.
- Sticky table header gains a scroll shadow; a scroll hint appears at widths where the table scrolls horizontally.
- Sidebar: provider count, a filter field past six providers, and empty states for both "no providers" and "no matches".
- Loading is a skeleton rather than a line of text; saving actions show an inline spinner.

**Responsive**

- The provider list is no longer hidden below 860px; it becomes a horizontally scrollable rail, so provider switching stays reachable on phones.
- Action buttons no longer wrap mid-word at 900px; the stepper connector is hidden below 1080px where it degenerated into a dash.
- No page-level horizontal overflow at 1487px, 900px, or 420px.

**Verification**

- Playwright pass at 1487x1058, 900x1000, and 420x900: no console errors, no page errors, no page-level horizontal overflow.
- Clipboard round-trip asserted against the real clipboard: `pi --model qa-router/gpt-5.6-sol:high`.
- `npm run build`, `npm run test:server`, and `npm run test:sites` pass.
- Screenshots in `qa/` regenerated from demo mode with generic paths and fake credentials.

## Dark Theme

Scope: a second set of token values. No layout, spacing, type, structure, or copy changed.

**Method**

- Every literal colour in `styles.css` was first lifted into a semantic token on `:root` (surfaces, derived ink, brand accents, status surfaces, overlays, shadows). Only `#fff` remains inline, as the label on a solid danger button, which is correct in both themes.
- Dark redefines those tokens under `:root[data-theme="dark"]`. Orange fills keep the brand value `#f36a21`; `--orange-dark`, which serves both as button-hover fill and as orange text, lightens to `#ff8542` so it stays legible on dark panels.
- The neutral ramp stays warm rather than switching to a cold slate, so the dark theme reads as the same product.
- Overlays step one surface lighter than panels in dark via `--surface-overlay`, following normal dark elevation.

**Theme control**

- Three states: system (default), light, dark, exposed as a segmented radiogroup in the sidebar footer and persisted under the `ppm-theme` localStorage key. Choosing system clears the key.
- A pre-paint inline script in `index.html` resolves the theme onto `document.documentElement.dataset.theme` before first paint, so there is no wrong-theme flash and the CSS needs only one dark block.
- `color-scheme` is set per theme so native selects, scrollbars, and the search field's clear control follow.

**Verification**

- Light baseline regression: pixel diff of the 1487x1058 model editor against the pre-dark screenshot is 3,928 differing pixels, all inside x 33-303, y 866-1030, which is the sidebar footer where the new theme control sits. No drift anywhere else in the light theme.
- Theme state machine asserted end to end: system resolves from the OS, choosing dark stores `dark` and survives reload, returning to system clears the key and re-resolves.
- Dark pass over the model editor, settings, protocol step with hint panel, bulk modal, validation error, and the success screen including a real clipboard round trip: no console errors, no page errors.
- No page-level horizontal overflow in dark at 1487px, 900px, or 420px.
- `npm run build`, `npm run test:server`, and `npm run test:sites` pass.
- Evidence: `qa/*-dark.png` alongside the existing light screenshots.

## Custom Form Controls and Review Pass

**Controls**

- Radios and checkboxes now use `appearance: none` on the native input and are drawn from the same tokens as the rest of the UI, closing the dark-mode gap where unchecked controls read heavier than checked ones. The native input is kept, so keyboard interaction, radio grouping, and form semantics are unchanged; arrow-key movement within the model table's default-model group was asserted in both themes.
- One implementation note: the radio's inner dot was first sized in percentages, which collapsed to nothing because a pseudo-element in a `display: grid` box resolves percentage sizing against an indefinite track. Fixed sizes in px.

**Findings fixed in review**

- Correctness: the bulk "safe defaults" action counted changed rows inside the `setForm` updater and read that count immediately afterwards. React only computed it in time because of its eager-state shortcut; with any pending update on the same state the count stayed zero. Reproduced by dispatching a model-ID edit and the action in one tick: the values changed from 200K to 128K while the toast claimed nothing had changed. The count is now derived from the rendered value before the update is dispatched, which also removes a side effect from a function React may run twice under StrictMode.
- Consistency: the toast state is a nullable object but was being cleared with `""` in two places.
- Duplication: `SettingsScreen` carried three copies of the saved-settings shape across a `useState` initializer, a sync effect, and the dirty check. Collapsed to one `saved` memo that feeds all three.
- Accessibility: the theme switch declared `role="radiogroup"` without the roving tabindex and arrow-key movement that role implies. Both radiogroups now share one `createRadioKeyHandler` helper.
- Dead code: an unused `panelRef` in the bulk modal and an unused `UploadSimple` import; the import list was re-sorted.

**Findings from the review agent, all fixed**

1. The bulk safe-defaults action was styled as a `.help-link`, visually identical to the purely informational disclosure on step 1, but it overwrote every model's context window and max output with 128K/16K. Combined with the removal of the per-row helpers, a user with eight accurately entered models could flatten all of them in one click with no undo. Now: it is a plain secondary button grouped with the other model actions, it reports how many rows it changed, and the toast carries an 撤销 action that restores exactly the two numeric fields it touched. The per-row correction is back as well, revealed on row hover or keyboard focus so rows stay compact.
2. `TokenField` accepted characters its parser rejected, so `128kk` or `1.2.3` reverted silently on blur, and a bare `128.5` parsed successfully into a 129-token context window. The parser now only accepts a plain integer or a decimal carrying a k/m unit, invalid drafts are marked with `aria-invalid` and a red border while typing, and a ceiling of 100M rejects typos like `900m` that previously produced multi-trillion-token values.
3. `dirty` compared the draft against client-side fallbacks rather than against settings.json. When the file omitted keys the screen owns, the footer claimed everything was written and the disabled Save button made those defaults impossible to persist. Missing keys now count as unwritten, and the footer says how many are outstanding.
4. `.list-empty` collapsed to a one-character-wide column inside the new mobile provider rail, because it inherited flex-item shrinking. Given `flex: 1 1 100%` in that breakpoint.
5. The sidebar filter kept its query across provider creation, so a stale filter could hide the gateway the user had just saved. The query clears when 添加供应商 is pressed.
6. The clipboard fallback called `removeAllRanges()` on a possibly-null `getSelection()`, which would throw on exactly the path that exists to handle failure. Guarded.
7. Two-click delete confirmation could be satisfied by a double-click on the trash icon. The confirming click is now ignored within 400ms of arming.

**Verification**

- Each finding re-tested against the behaviour it described: undo restores 200K after the bulk action writes 128K; the per-row button appears on focus; the parser matrix accepts `200000`/`200k`/`1.05m` and rejects `128.5`/`128kk`/`900m`/`0` while leaving the previous value intact; a double-click leaves the row count unchanged while a deliberate second click deletes; the filter query clears on add; the empty state renders 768px wide at an 800px viewport.
- The reproduced counter bug re-tested after the fix: the pending-update case now reports the correct count, and the genuine no-op case still reports no change.
- Settings dirty gate across its lifecycle in both themes. It now starts enabled against the demo state, which lacks `transport` and `hideThinkingBlock`, and disables once those are written. That is the point of finding 3.
- Full wizard to success with a real clipboard round trip in both themes, no console or page errors, no horizontal overflow at 420px.
- `npm run build`, `npm run test:server`, and `npm run test:sites` pass.

## Second Review Round

A `/code-review high` pass over the whole of `main` (no diff to review, so the source itself was the target) returned twelve findings. Two were security issues shipped in 0.1.4 and recorded in GHSA-wqcr-r9hp-xrcx and GHSA-78m8-7gh8-qr33. Six functional findings were fixed in 0.1.5, and the five remaining low-priority ones in 0.1.6, closing all twelve.

**Root cause worth recording**

Two of the six existed only because verification ran somewhere the product does not:

- The "unwritten settings" indicator was checked in demo mode, where the fixture omits keys. Against the real server every key is normalized before it reaches the client, so the branch could never fire.
- The pre-paint theme bootstrap was verified against the vite dev server, which sends no CSP. The production launcher does, and `script-src 'self'` blocked the script outright, restoring the wrong-theme flash it exists to prevent.

Both now have server-side tests, so the gap is closed by CI rather than by remembering to switch environments. Verification of anything that touches the served page or the API should run against `server.mjs`, not only against `vite dev`.

final result: passed

## Model Deletion Protection Follow-up

- Evidence date: `2026-08-19`
- Evidence shape: production build served by `server.mjs` with `PI_PROVIDER_MANAGER_SERVE_UI=1` and an isolated `PI_CODING_AGENT_DIR`; six fake models, a non-routable URL, and a dummy credential only.
- Persisted model IDs rendered read-only and rejected attempted keyboard replacement; a newly added row remained editable.
- A pure draft guard rejected both clearing and renaming persisted IDs, and default selection returned no model instead of falling back when the selected row was blank or missing.
- Arming the live default named its fallback and compatibility-field loss; arming an ordinary persisted row named its compatibility-field loss. Both messages rendered model IDs in the monospace stack.
- All six rows stayed exactly `85px` high while armed and unarmed. The model ID, context, output, image, and reasoning controls had identical top coordinates within every row; arming caused zero geometry shift.
- Confirmed deletion followed by 撤销 restored the original index and selected default. Browser console/page errors: zero.
- At `420 x 900`, page-level horizontal overflow was zero, the toast fit inside the viewport, and it did not intersect the save action.
- The same production-shaped flow is automated by `npm run test:ui` in a dedicated Node 22 browser job, and `ci-passed` depends on that job as well as the Node test matrix.

## Provider Deletion Follow-up

- Evidence date: `2026-08-19`.
- Evidence shape: production build served by `server.mjs` with `PI_PROVIDER_MANAGER_SERVE_UI=1`, two fake providers, non-routable URLs, dummy credentials, and an isolated `PI_CODING_AGENT_DIR`.
- The visible “删除供应商” command fit inside the active internal scroll viewport at both `1440 x 900` and `420 x 900`; page-level horizontal and vertical overflow remained zero.
- The confirmation dialog named the provider and model count, gave Cancel initial focus, trapped keyboard focus, closed on Escape, and fit fully inside both viewports after its entry animation.
- Deleting the current default exposed native replacement-provider and replacement-model selects; the server separately rejected missing, unknown, and mismatched replacements.
- Credential removal was the default. Selecting “保留凭据” removed the provider from `models.json` and navigation while keeping its secret entry in `auth.json` and `authProviders`; the credential never appeared in a browser response.
- Server regression covers validation-without-writes, unknown-field preservation, auth-only public state, strict boolean retention, ordinary deletion, and default replacement. The production-browser regression covers desktop/mobile discovery and the retained-credential path with zero console errors.
