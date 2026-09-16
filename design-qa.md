# Design QA

- Evidence date: `2026-08-18`
- Evidence scope: accepted design evidence and compatibility-triage results, not live repository or machine state
- Structure: bounded. Current baseline evidence is replaced in place by each triage; what it supersedes joins the verification history as one row. The full dated text of superseded sections lives in git history, and the CHANGELOG carries what changed and why.
- Product version: `0.1.8`
- Source visual truth: `design-reference.png` plus user acceptance screenshots for the settings, long-model-list, and post-save problems
- Model editor screenshot: `qa/pi-provider-manager-v11-models.png`
- Settings screenshot: `qa/pi-provider-manager-v11-settings.png`
- Success/next-step screenshot: `qa/pi-provider-manager-v11-success.png`
- Responsive evidence: `qa/pi-provider-manager-v11-responsive-900.png`
- Dark theme evidence: `qa/pi-provider-manager-v11-models-dark.png`, `-settings-dark.png`, `-success-dark.png`, `-responsive-900-dark.png`
- Primary viewport: `1487 x 1058 CSS px`, device scale factor `1`
- State: demo mode with generic paths and fake credentials only

## Design Acceptance — V1.1

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
- Colors and visual tokens: passed. Orange actions, green success states, blue help links, warnings, borders, and neutral surfaces are consistent. Contrast is measured rather than assumed: `tests/model-deletion-ui.test.mjs` walks every rendered text node in both themes against WCAG AA, resolving each element's real backdrop and applying the large-text exemption. This line once said "passed" on inspection alone, and 17 of 64 elements were in fact below AA — including both primary buttons at 3.05:1, which is why white text sits on `--orange-strong` rather than on the brand `--orange`. The audit also sweeps every hover state the stylesheet defines, by moving the pointer for real: `.safe-default` only exists while its row is hovered, and it sat at 4.49:1 on the default row's tint until that sweep measured it, hence `--blue` is `#2b66d8`. Inherited opacity is composited too, so a faded control is measured as it is painted, and text WCAG exempts for being genuinely disabled is reported rather than asserted.
- Target sizes: passed, measured. `every control is big enough to hit` checks every interactive element against WCAG 2.2 SC 2.5.8 in the state it is actually used in. It resolves a control's real target — the default-model radio is a 22x20 input inside an 86x42 `<label>` that activates it, so the input's own box is not what a pointer has to hit — and only accepts the 24px spacing exception when no neighbour's circle overlaps. It also asserts that a padded target's line box is a fixed number rather than `normal`: `.safe-default` was a 24px target here and a 20px one on CI, because its label is Chinese and a CJK fallback the runner lacks decides the line height. Anyone without that font had the undersized button. A measurement only ever sees the fonts of the machine taking it, so font-independence is asserted rather than measured.
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

- **Follow-up, `2026-08-21`, development machine.** Codex `0.149.0` was installed locally so this stops depending on a second machine. `codex doctor --json` reports `config.load: ok` both for a realistic pre-existing file and after the manager rewrote its provider table, and `reachability mode` switches to `API key auth`, which confirms Codex resolved the generated provider and took the `auth.json` credential path rather than falling back to ChatGPT. Automated as `npm run test:codex-real`, which skips itself where Codex is absent.
- **A provider table without `name` breaks everything.** Bisecting a failing `codex doctor` run showed that one `[model_providers.*]` lacking `name` makes Codex refuse the whole config, every other provider included. The manager always writes one, but it preserves hand-written tables verbatim, so it now names any offender in the Codex settings screen rather than leaving the user with an unexplained failure.
- **`spawn` reporting a missing binary would have crashed the server.** An unlistened `error` event on a `ChildProcess` is re-thrown as an uncaught exception, so clicking "start bridge" without LiteLLM installed would have taken the manager down. Now recorded in the bridge log with the `PI_PROVIDER_MANAGER_LITELLM` hint.

- **Both paths proven end to end, offline, `2026-08-21`.** Two stand-in gateways on loopback make this checkable without a key or a network. Direct: `codex exec "say hi"` returned the gateway's reply, and the gateway recorded `Authorization: Bearer <the key saved through the manager>` — the whole chain, from writing `config.toml` and `auth.json` to Codex resolving the provider and sending the stored credential. Bridged: a gateway that answers 404 on `/v1/responses` became usable once the manager wrote LiteLLM's config and started it; the upstream saw only `POST /v1/chat/completions auth=yes`, and the key appears in neither config file. Both are automated in `tests/codex-real-binary.test.mjs` and skip where Codex or LiteLLM is absent.
- **LiteLLM does not pin FastAPI tightly enough.** `litellm 1.97.0` with `fastapi 0.141.1` fails at import with `cannot import name 'get_flat_dependant'`, on Python 3.12 and 3.14 alike. `fastapi==0.115.14` works; both READMEs say so, since a user meeting it would reasonably blame this manager.

- **Managed bridge, real machine and real upstream, `2026-08-21`.** On the owner's WSL2 box: the manager generated LiteLLM's config for a third-party gateway, started the proxy (`127.0.0.1:43210`, readiness `200`), and Codex `0.149.0` resolved the bridged model and had its request accepted — a failure in the translation, the injected upstream key, or the connection would have surfaced immediately, as the earlier direct-provider `401` did. This is the first end-to-end run against a real upstream rather than a stand-in.
- **Three launcher variables now travel explicitly.** `PI_PROVIDER_MANAGER_LITELLM` joined `PI_CODING_AGENT_DIR` and `PI_PROVIDER_MANAGER_CODEX_DIR`: under WSL the launcher starts the service through `powershell.exe -> wsl.exe -- env`, which inherits nothing, so exporting the variable in a shell silently did nothing and a virtualenv LiteLLM — the normal case under PEP 668 — was unreachable. The launcher prints it when set, so a wrong path is visible at startup rather than as a failed button click later.

- **Out-of-the-box verification, `2026-08-22`.** `npm run test:codex-real` passes 4/4 with **no environment variables set at all** — the manager discovers LiteLLM itself, starts the bridge, and Codex completes a turn through it. Skipped counts as failed for this purpose: an earlier run reported "3 passed" while silently skipping the bridge, because the test probed `litellm` on PATH while the product had learned to look elsewhere. Both now resolve the binary the same way.
- **LiteLLM's install order decides whether bridging exists at all.** Pinning FastAPI in the same command as `litellm[proxy]` lets the resolver satisfy the pin by downgrading LiteLLM to `1.79.0`, which has no Responses-to-Chat bridging: it forwards `/v1/responses` to the upstream and surfaces the upstream's 404, which reads like a broken gateway. Installed alone it resolves to `1.97.0`, which works. Both READMEs now say to install it by itself, and the credentials step reports the executable and version actually in use.

- **The published archive was checked, and that is what caught the last defect, `2026-08-22`.** Downloading and running `v0.2.0` showed the LiteLLM version blank: `litellm --version` takes eight to nine seconds, and the probe sat in the status path behind a three-second bound, so it could never succeed. Building from source had hidden nothing — the bug was in the code, not the packaging — but nothing before that step had actually read the value the release notes told people to check. Fixed in `0.2.1` by moving the probe off the request path.

final result: passed

## Current Baseline Evidence

## Pi 0.85.1 Compatibility Triage — Evidence

- Evidence date: `2026-09-12`. Manager `0.3.9`. Baseline moved from Pi `0.84.4` to `0.85.1`.
- **What moved upstream between `v0.84.4` and `v0.85.1`.** `providers.md` is unchanged. `settings.md` only rewords four existing descriptions — `showCacheMissNotices`, `enableInstallTelemetry` (which now also covers the provider attribution headers it sends), `fullscreenScrollbar`, and `branchSummary.reserveTokens` — with no key added or removed. `models.md` documents one new model-level compatibility boolean, `supportsMidConvoEffort` (per-turn effort for the exact supported Claude model on a faithful Anthropic Messages transport), and rewords `supportsLongCacheRetention` because `0.85.1` sends `prompt_cache_options.ttl: "30m"` for GPT-5.6+ Responses models. `src/config.ts` and the package's `dist/config.d.ts` differ by one added export (`isBundledNode`). No config path, provider field, API identifier, settings key, or thinking level changed; the seven thinking levels are still the seven this manager offers.
- **The new flag is unknown to this manager and is preserved by design.** `mergeExistingModel` spreads the stored model under the submitted one and strips only `forceAdaptiveThinking`, so a `compat.supportsMidConvoEffort` a user hand-writes after upgrading Pi survives every manager save. Proven on the live boundary rather than only read from the merge code: after a hand edit added the flag, a second `POST /api/providers` returned `200` and the written `models.json` still carried it.
- **The real page/API boundary ran on the built bundle.** `PI_PROVIDER_MANAGER_SERVE_UI=1 node server.mjs` against a temporary `PI_CODING_AGENT_DIR` served `/` as `text/html` with the `Content-Security-Policy` and `X-Content-Type-Options` headers intact, and `POST /api/providers` — carrying the revision from `/api/state` — wrote the `compat-check` provider pointed at the non-routable `http://127.0.0.1:9/v1` with a dummy key. `models.json`, `settings.json` and `auth.json` came out with exactly the submitted shape. An unknown `futureSetting` added by hand to `settings.json` survived a `POST /api/settings`, matching the fixture test.
- **Pi read that config — both versions, against the same directory.** `PI_OFFLINE=1 … --list-models compat-check` under `@earendil-works/pi-coding-agent@0.85.1` listed `compat-model` with `200K` context, `8.2K` max output, thinking `yes`, images `no`; the `0.84.4` control run against the same directory printed the same row, character for character. Both releases were fetched and run without being installed, so the machine's own Pi is unchanged.
- **The settings fixture did not need refreshing.** `0.85.1` added no settings keys, so the `tests/server.test.mjs` fixture shaped like a current Pi's `settings.json` still covers every key this release could contribute.
- `npm test`: 148 pass, 0 fail, 0 skipped — including the Chrome-driven UI suite against the built page and the real-binary Codex suite. A browser smoke against the production-shaped server confirmed the provider rail, the model-table conventions, and the compatibility panel, which reports the `0.84.4` baseline beside the machine's detected Pi until the release carrying this bump ships.
- **Not run in this pass, and so not claimed:** the optional interactive smoke test — `/model` inside a running Pi.

final result: passed

## Provider User-Agent Compatibility Setting — Evidence

- Evidence date: `2026-09-16`. Manager `0.3.11`.
- The production-shaped server/API fixture covers the three states `none`, `literal`, and `external`; it confirms that provider and model header values, including fake secrets, never enter `/api/state` or a save response. Explicit set, clear, omission, malformed values, and revision-protected writes were exercised; unknown model fields remained on disk.
- `npm run build`: passed. `npm run test:server`: 52 pass, 0 fail, 0 skipped, including the server UA contract, model-response projection, copy semantics, and changed-provider-ID write intent. `npm run test:ui`: 11 pass, 0 fail, 0 skipped against the built page and production-shaped server. `npm run test:sites`: 4 pass, 0 fail, 0 skipped.
- The released Pi request-level procedure was completed against a fake gateway. The strict evidence artifact is `artifacts/ua-review-20260916/wire-strict-results.json`: Pi `0.85.1`, 20 requests passed and 0 were skipped across OpenAI Completions, OpenAI Responses, Anthropic Messages, and Google Generative AI. It covers the custom provider User-Agent, two models inheriting it, clearing back to Pi's default, a model-level override, and the Anthropic `/v1/messages` path.
- **Not run in this pass, and so not claimed:** an interactive `/model` smoke inside a running Pi session. The evidence here is the released Pi's request-level wire behavior only, using the documented fake-gateway procedure.

## Codex 0.154.0 Compatibility Triage — Evidence

- Evidence date: `2026-09-12`. Manager `0.3.9`. Baseline moved from Codex `0.151.0` to `0.154.0`.
- **What moved upstream.** The `0.152.0`–`0.154.0` release notes name no change to `[model_providers.*]`, `wire_api`, credential resolution, reasoning-effort values, or profile handling — the window is MCP, session, approval, and Windows-daemon work. `codex-rs/model-provider-info/src/lib.rs` differs by exactly one added constant (`AMAZON_BEDROCK_GPT_6_ASTRA_MODEL_ID`).
- **Four invariants hold unchanged on the real `0.154.0` binary.** `wire_api` accepts `"responses"` and refuses `"chat"` with the same specific removal error (`is no longer supported` naming `model_providers.custom.wire_api`, not a generic parse failure). A provider table without `name` still fails `config.load` for the whole config. `model_reasoning_effort = "persistent"` and an invented `"turbo"` both load. A legacy `[profiles.custom]` table still parses — `codex doctor` says ok — while `codex exec --profile custom` still refuses with the legacy-table error naming the table.
- **The fifth exposed an error in this project's own record, not in `0.154.0`.** An unrecognised key inside `[model_providers.<id>]` loads fine on `0.154.0` — and, as a control, the identical driver run against the installed `0.151.0` accepts it too, so nothing moved upstream. The invariant had been recorded as "one unrecognised key fails the entire table"; the struct carries `#[schemars(deny_unknown_fields)]`, which shapes the generated JSON schema only, and the serde TOML parser has no deny attribute. `docs/compatibility.md` invariant 2 now states what the parser actually does. The manager's written output is unchanged: it never emitted a key outside the documented set, and staying inside it remains the rule — deliberately conservative now, rather than parser-forced.
- **`npm run test:codex-real` on `0.154.0`: 5 pass, 0 fail, 0 skipped.** The release was installed into a throwaway prefix and put on `PATH` for the run, so the machine's own Codex stays `0.151.0`; the suite is green on both.
- **Not run in this pass, and so not claimed:** the interactive TUI on `0.154.0` — `/model`, `/thinking` and the plan-mode control were not exercised.

final result: passed

## Standing Caveats — Not Claimed To Date

- The interactive smoke tests have never run: `/model` inside a running Pi and Codex's interactive TUI. Every Pi validation went through `--list-models`; every Codex check through `codex doctor` and `codex exec`.
- A model-defined `Custom(String)` reasoning effort has never been obtained from a real model — the invented `"turbo"` is a stand-in for the shape the parser accepts, not proof that a model emits one.
- A manager actually hosted on Windows has never driven `POST /api/update/apply`. The Windows archive branches ran on Windows as a library against the published assets, with the bytes served from disk, because Windows Node cannot reach GitHub's object storage on that host.
- No archive install has ever upgraded twice in a row, so the existing-sibling refusal has only ever been met in unit tests.
- Pi has never been installed on the Windows side of the development machine, so Windows `pi` detection has only ever answered `unknown`.
- The archive's Windows download mark was written by hand, not produced by a real browser download.
- The manual browser scenarios in the design sections were walked by hand on 2026-08-18; since then the real page is driven by the automated production-browser suite, plus a light smoke on 2026-09-12.

## Verification History

One row per superseded evidence section; the full dated text of each lives in git history.

| Date | Manager | What was exercised | Result |
|---|---|---|---|
| 2026-08-19 | 0.1.x | Model deletion protection: persisted IDs read-only, armed-delete geometry stable at 85px, 撤销, 420px viewport | passed |
| 2026-08-19 | 0.1.x | Provider deletion: named dialog, Cancel focus, credential retention default, replacement validation server-side | passed |
| 2026-08-21 | 0.2.x | Codex `0.149.0` real binary: generated config loaded, adoption, byte-exact preservation, project-local config shadows nothing, two launcher defects found | passed |
| 2026-08-26 | 0.3.3 | Pi `0.84.3` vs `0.84.2`: byte-identical rows; BOM tolerance found and fixed on the manager side; auth.json chmod note | passed |
| 2026-08-26 | 0.3.4 | Stale version reporting: live detection, manifest-move assertions in payload and rendered card, PowerShell launcher reuse, Windows `.cmd` shim | passed |
| 2026-08-26 | 0.3.5 | Restart handover: both outcomes; stdio-hang rule found by a hang; archive run on Windows; `Unblock-File` guidance against a real mark | passed |
| 2026-08-26 | 0.3.5 | Update check/apply: real-API check by hand, all three refusal reasons, stale-bundle guard, browser assertions on the control's promise | passed |
| 2026-08-26 | 0.3.6 | Upgrade end to end on a real checkout; Windows archive branch against the real `v0.3.5` release | passed |
| 2026-08-26 | 0.3.6 | Archive install self-upgraded through the endpoints; blocked fast-forward staged against the real remote | passed |
| 2026-08-29 | 0.3.7 | Sidecar verification on the real `v0.3.7` release; three refusals each left nothing on disk | passed |
| 2026-08-29 | 0.3.7 | Pi `0.84.4` triage: fixture extended with the four new settings keys; step 8 blocked (fetch refused), baseline held | blocked |
| 2026-08-31 | 0.3.7 | Pi `0.84.4` step 8 on the release itself; byte-identical row against the `0.84.3` control | passed |
| 2026-08-31 | 0.3.7 | Windows archive verifier on Windows: `OpenRead`/`Expand-Archive` on the published zip, two refusals, bytes from disk (`ECONNRESET`) | passed |
| 2026-08-31 | 0.3.8 | Codex `0.151.0` triage: four invariants unchanged; the reasoning-effort rewrite defect found and fixed | passed |

final result: all historical sections passed except the one recorded as blocked, which its successor section closed

## UI Polish Round — Evidence

- Evidence date: `2026-09-12`. Manager `0.3.10` (post-release). Owner-directed round referencing mature product patterns (Linear/Vercel/Stripe), inside the existing design language — no layout or structure change.
- **Thin token-colored scrollbars on the app's inner scrollers.** The full-height native scrollbar was the loudest element in the dark theme. `--line-strong`/`--border-hover` thumbs, transparent tracks, 10px boxes with a padding-box inset; native scrolling untouched.
- **Fixed a focus-cue defect on the prompt editor.** `outline: 2px solid var(--ring)` built an outline from a box-shadow value — an invalid declaration, which left the textarea with the global `outline: none` for text fields and nothing but a hairline border change on keyboard focus. It now takes the standard text-field treatment: orange border plus the `--ring` shadow. Found by reading, not by the contrast sweep — the sweep walks rendered text, not focus treatments.
- **Settings/credential forms cap at 880px** on wide screens; a URL input stretched across the full card stopped reading as a field.
- **First-run empty state** (zero providers) is now an icon plus the pointing sentence, still the `.list-empty` block with unchanged width behaviour.
- **Verified against the production build served by `server.mjs`** (`PI_PROVIDER_MANAGER_SERVE_UI=1`, temporary config directories): dark model editor with the thin list scrollbar, light theme at the second token set, and the 420px rail layout each rendered and were screenshotted; computed styles confirmed the light-theme field backgrounds rather than trusting pixels after the capture pipeline produced stale-tile composites mid-session.
- `npm test`: 148 pass, 0 fail, 0 skipped — the WCAG AA contrast sweep and the WCAG 2.2 target-size audit pass unchanged, as does the 420px overflow check.
- **Found on the way, and fixed before landing:** the empty-state icon was first written as Phosphor's `Inbox`, which the pinned `@phosphor-icons/react@2.1.10` does not export — `vite build` would have failed, and the dev page rendered blank until the import was corrected to `Tray`. The earlier green `npm test` in this round had run before the JSX edit; the final run covers it.

final result: passed

## Second UI Round — Evidence

- Evidence date: `2026-09-12`. Manager `0.3.10` (post-release). Owner-directed continuation, same constraints as the first round.
- **A demo-mode defect found by walking the Codex happy path.** The Pi save path has faked its success under `?demo=1` since V1.1, but `saveCodex` and `saveCodexSettings` never gained the mirror: saving in the Codex workspace posted the fixture's empty revision to the real API and was refused with 409, every time, with a message blaming an external modification that had not happened. The Codex success screen was unreachable in demo. Both paths now carry demo branches mirroring the Pi ones, and the Codex success screen renders from a demo save. The automated Codex UI suite runs against a real server, which is why nothing caught this.
- **The 409 corrective action now survives its toast.** The conflict toast offers 重新读取 (a reload) but expires after seven seconds; the persistent banner only quoted the instruction as text. Measured by letting the toast expire and re-saving: the second save failed the same way with no action in reach. The banner — shared `ErrorBanner` on the four surfaces that can see a request 409 — now carries the button itself, driven by a conflict flag set beside the request error and cleared at the entry of every save.
- Both verified against the production build served by `server.mjs`: the demo Codex save reaches the success screen, and a staged 409 (demo revision against the real endpoint) shows the banner with its 重新读取 button.
- `npm test`: 148 pass, 0 fail, 0 skipped. The first run of the round failed its two Codex-workspace tests with `conflict is not defined` — the banner replacement had landed in CodexCredentialsStep, whose destructure had not gained the prop — fixed, and the recorded run covers the corrected code.
- **Known demo gaps left open, recorded rather than hidden:** the prompt save/activate/delete paths and the Codex provider-delete dialog still post to the real API under `?demo=1`. They fail safely (a refusal, not a wrong write), and this round did not widen further. Correction on review: the Pi provider-delete path already had a demo branch — listing it here was wrong.

## Third UI Round — Demo Parity Completed, and 复制供应商

- Evidence date: `2026-09-12`. Manager `0.3.10` (post-release).
- **The remaining demo gaps closed.** `promptRequest` now mirrors the prompt library's own semantics on the fixture — upsert with a unique slug, activate, delete-with-replacement for the live document — and `deleteCodexProvider` fakes the active-slot handover. The previous round's list of open demo gaps named the Pi provider-delete path in error; that path has had a demo branch all along, and the record above is corrected.
- **复制供应商 (both targets).** A saved provider's summary gains a 复制 button beside 删除供应商: neutral palette on purpose — a copy is a safe act and must not read as a danger. The draft lands on the credentials step with a free `<id>-copy` ID (counting `-copy-2`, `-copy-3`, … past collisions), the source's gateway address, protocol, models with fresh row keys, compatibility flags and reasoning efforts. The stored key never returns to the browser, so a copy is born asking for a new one — exactly the workflow a duplicate exists for. A bridged source carries the bridge's upstream address but not the bridge's held key.
- **Verified:** unit tests over the pure draft logic (free-ID suggestion, credential stripping, row-key freshness, default-row remapping, source-draft immutability); one browser test drives the whole Pi flow against the production server — 复制 → free ID prefilled, source address kept, new-key tab active, three model rows copied → key typed → saved → `models.json` and `auth.json` on disk carry the copy with the right protocol, and the source provider is untouched. Demo prompt save/activate/delete and the staged-409 banner button were driven by hand in the served page.
- `npm test`: 152 pass, 0 fail, 0 skipped (148 prior + three draft-logic unit tests + the new duplicate-flow browser test).

## Fourth Round — Review, Hazard Fixes, Documentation Alignment

- Evidence date: `2026-09-12`. Manager `0.3.10` (post-release). Owner-directed
  review of the third round before publishing it: find latent hazards, fix them,
  bring the documentation back in line, converge, then push.
- **A duplicate carried storage identity it does not have.** `duplicatePiForm`
  spread each source row, which brought `persistedId` — the field that marks a
  model as already on disk — into a draft where nothing is on disk yet. The copy
  therefore rendered its model IDs read-only, refusing the one edit a duplicate
  is most likely to need, and `changedPersistedModel` was ready to refuse the
  save for drifting from an identity the copy never had. Every row of a copy is
  now new to disk, which is what it is.
- **A duplicate could have moved the source's credential out from under it.**
  `moveCredential` also carried over, and it defaults to true. Reusing an
  existing credential in the copy would then delete the entry the source
  provider is still using — the source is still there, and still needs its key.
  A copy never moves a credential.
- **Three surfaces set the conflict flag and offered nothing to do about it.**
  The previous round put 重新读取 in the shared banner on the four save screens
  and stopped there. The prompts screen rendered a 409 as a plain warning note;
  both provider-delete dialogs rendered it as a bare banner. All three now use
  `ErrorBanner` with the flag, so the corrective action is in reach wherever a
  409 can be seen. The Pi dialog suppresses it while the message is the dialog's
  own local validation, which no reload fixes.
- **Three write paths never cleared the flag at entry**, against the convention
  the previous round itself wrote down: `promptRequest`, `deleteProvider`, and
  `deleteCodexProvider`. A resolved conflict left a stale 重新读取 button beside
  the next, unrelated error.
- **Documentation had fallen behind three merged pull requests.** #84, #85 and
  #86 were on `main` with no `CHANGELOG` entry — the repository's own convention
  is to record work under `Unreleased` as it lands — and 复制供应商 shipped
  undocumented in both READMEs and the usage guide. All four are now aligned, and
  the two AGENTS.md conventions this round found holes in say what they actually
  require: which fields a copy must drop, and that every surface showing a
  request error uses the shared banner.
- Note on the environment, not the product: this round's first `npm test` failed
  before any test ran, with rollup unable to load
  `@rollup/rollup-win32-x64-msvc`. The installed tree was incomplete and one
  `node_modules/.bin` entry was an unreadable stale directory entry that neither
  `rm` nor `del` could remove; moving it outside `node_modules` and reinstalling
  cleared it. No source involved.
- **The suite could not reach green on Windows, for two reasons that were the
  tests' own and not the product's.** Four restart/upgrade tests spawn a server
  whose working directory is the temp directory they then delete; `child.kill()`
  only asks, and Windows refuses to remove a live process's working directory, so
  all four failed with `EBUSY` in their `finally` block *after* every assertion
  had passed. The correlation was exact — the four failures were the four tests
  spawning with `cwd: projectDir`. A shared `stopAndClean` now waits for the exit
  event before removing, and retries a lingering handle. Two LiteLLM bridge tests
  assert POSIX-only facts: that starting a bridge reaches spawn at all, which the
  product deliberately refuses where process ownership cannot be proven, and that
  `chmod 0o644` makes a file unusable, which on Windows it does not. Both now skip
  on Windows in the idiom this file already used eleven times; both still run on
  the Linux CI matrix, which is what the skipped-count rule is about.
- **The browser suite could not run on Windows at all, and said so as eight
  failures.** `findChrome()` offered four Linux paths and two Linux Playwright
  layouts, so on a machine with Chrome installed in `Program Files` every one of
  the eight tests failed identically on discovery. Earlier rounds had passed
  `CHROME_BIN` by hand, which is exactly how a gap like this stays invisible. The
  three standard Windows install roots and the Playwright `-win64` layout are now
  in the list; with that alone seven of the eight passed, and the eighth was the
  same `EBUSY` teardown as above — the upgrade test signals the replacement
  manager and removes its working directory without waiting for the exit.
- All of these were pre-existing rather than introduced here: each was confirmed
  by stashing this round's changes, re-running, and getting the identical
  failures.
- `npm test` after the fixes: **152 pass, 0 fail**, across every group — 45 server,
  48 Codex, 11 prompts, 4 sites, 8 Pi-update, 1 release, 1 launcher, 8 UI, 4
  real-Codex. Skips are all environmental and each one is a platform fact rather
  than an untested claim: the launcher's seven need Windows PowerShell reachable
  from this shell, the Codex group's fourteen need procfs or POSIX file modes, and
  `test:codex-real`'s one needs LiteLLM installed — the bridge is the one thing
  this Windows host could not have supervised anyway. The four real-Codex checks
  that do not depend on LiteLLM ran against the installed binary and passed,
  including `codex exec` reaching a stand-in gateway with the stored credential.

## Fifth UI Round — Cross-Target Consistency — Evidence

- Evidence date: `2026-09-16`. Manager `0.3.12` (post-release). Owner-directed
  detail round, opened by one observation: the Codex sidebar marked its live
  provider and Pi's did not. Chasing that asymmetry turned up three more places
  where the two targets answered the same question differently, one of them a
  control that did nothing when clicked.
- **The Pi sidebar now marks its default provider.** The server has always sent
  `isDefault`; the sidebar mapping discarded it and rendered an empty badge cell,
  so "which one am I actually using" was answered on one target and not the
  other. Pi's row now carries 默认, derived from `state.settings.defaultProvider`
  rather than the per-provider `isDefault` field, because a local save updates
  `settings.defaultProvider` and deriving the mark from the same field keeps the
  two from disagreeing. Deliberately not 生效中: Pi resolves a provider per model,
  so nothing about the other rows is switched off.
- **A Codex control that did nothing (defect).** `复制供应商` was gated on the
  *selection* (`canDeleteProvider`) while `duplicateCodexProvider` bails unless
  the *form's* provider ID names a stored provider. Opening a saved provider,
  renaming its ID at step two and continuing therefore left the button visible
  and inert. It is now gated on the same fact the handler checks, which is how the
  Pi side has always gated it. Confirmed reachable by driving the real page: the
  renamed draft's arm is blocked by the step's own "请输入 API Key。" until a key is
  typed, which is what the first attempt at the test walked into.
- **The Codex model row now states the consequence of removing the live model.**
  Pi said so in the armed-delete tooltip, the accessible label and the arm toast;
  Codex said only "再点一次确认删除". The wording names the button that is actually
  on screen: only the active provider can have a live model, and that provider's
  footer offers 保存更改 alone, not 保存并设为当前生效.
- **A Codex provider needing no credential no longer reports 凭据已配置.**
  `requires_openai_auth = false` means Codex sends no Authorization header, so the
  green tick's label claimed a key where none was ever asked for. The tick stays —
  the provider is ready — and the label now reads 无需凭据.
- **Pi's provider filter searches the gateway address**, as Codex's already did.
  With several entries from one vendor the host is the one thing a user
  remembers, and it was the one thing Pi would not match.
- **The Pi model row no longer draws a drag handle it does not implement.** The
  glyph had no reordering behind it, and row order means nothing in `models.json`
  beyond which row the default radio marks. Glyph, its leading grid column, the
  header's empty cell and the narrow-width `min-width` all go together.
- Verified against the production build served by `server.mjs`
  (`PI_PROVIDER_MANAGER_SERVE_UI=1`, `?demo=1` for the populated fixture): both
  targets screenshotted in light and dark at 1440x900, confirming the badge and
  the re-aligned model table after the column removal, and that 默认 / 生效中 land
  on the right rows.
- Each new browser assertion was run against deliberately reverted code before
  being kept, and failed as intended: the duplicate gate reported
  `duplicate: true` where the fixed build reports `false`; disabling the
  live-model branch left the arm toast matching neither half of the asserted
  wording; and making `nextDefaultAfterRemoving` return an empty id collapsed the
  named-replacement half into the ask-for-one message. Three mutations, three
  failures, each on the assertion meant to hold it.
- Note for future tests in this suite, learned the hard way here: the delete
  buttons arm on first click and are reset by `onBlur`, but a synthetic
  `element.click()` does not move focus, so `onBlur` never fires and the armed
  state survives. A second synthetic click more than `CONFIRM_ARM_DELAY` later
  therefore *deletes* the row rather than re-arming it. The test now waits for the
  button to lose `is-confirming` — the component's own 3.2s window — before
  arming it again, instead of assuming a blur that a scripted click never causes.
- `npm test`: **162 pass, 0 fail, 0 skipped** — 52 server, 62 Codex, 11 prompts,
  4 sites, 8 Pi-update, 1 release, 8 launcher, 11 UI, 5 real-Codex. Zero skips
  means the LiteLLM bridge and the real `codex exec` paths were actually exercised
  on this host, not sat out.
- Documentation aligned in the same round: `AGENTS.md` rewritten to 141 lines
  with every rule retained but the narrative justification behind the durable
  decisions compressed; the sidebar live-selection mark added to the
  `docs/architecture.md` vocabulary and both targets' sections of the Chinese
  usage guide; the round recorded under `CHANGELOG.md`'s `Unreleased`.

final result: passed

## Restart Observability — Evidence

- Evidence date: `2026-09-16`. Manager `0.3.13` (post-release). Owner-reported
  incident: pressing 重启以应用 0.3.13 in Settings left the browser with
  `ERR_CONNECTION_REFUSED` and no message anywhere — no port, no page, no log.
- **What was established before any code changed.** The handoff itself works: a
  controlled restart on an isolated port handed 43299 from pid 2140650 to
  2140861, same port, both lines in the log, when the parent's streams were
  files. The launcher on this machine takes its **WSL branch** (WSL_DISTRO_NAME is
  set and `powershell.exe` is reachable), which starts the manager through
  `Start-Process wsl.exe -WindowStyle Hidden` and, unlike the `nohup` branch, wrote
  **no log at all** — `fd/1 -> /dev/pts/…`, a hidden console. So the failure had
  nowhere to be written down, whatever its cause.
- **The structural defect, stated without claiming a trigger:** `applyRestart`
  calls `process.exit(0)` as soon as a *different* pid answers `/api/state`, and
  never watches the replacement afterwards. A replacement that answers once and
  then dies therefore leaves no service, no `restartError` (it is a variable in
  the memory of the process that just exited), and — with the old output path —
  no account. The precise reason that replacement died is **not** established, and
  this round does not claim one; the round removes the blindness instead.
- **This round is the observability half, chosen by the owner.** Two files, both
  bounded at 64 KiB, neither able to prevent a start: `pi-provider-manager-ui.log`
  receives the manager's own output in both launcher branches, and
  `pi-provider-manager-restart.log` records every start and every handoff step
  (`handoff requested` → `spawned replacement` → `handoff complete`/`handoff
  failed`, plus `listening … replacing=<old pid>`).
- **Two mechanisms that look like they should work, and do not** — recorded
  because both were tried and measured here. Reopening fd 1 onto the log creates
  the file and leaves it empty: Node binds `process.stdout` to the console's
  handle at startup, so nothing writes to the fresh descriptor. (It *does* work
  when the parent's stdout is a file, which is why the isolated probe passed and
  the real WSL branch still produced a 0-byte log — the difference is the TTY.)
  Intercepting the streams alone is also insufficient: Node's uncaught-exception
  report writes past both of them. The shipped implementation tees
  `process.stdout`/`process.stderr` **and** handles `uncaughtException`, writing
  the stack to both logs before exiting 1.
- **Launcher:** the WSL branch now passes `PI_PROVIDER_MANAGER_LOG` as a
  single-token `env` element and prints the log path on a fresh start. It is
  deliberately *not* `-RedirectStandardOutput`: `Start-Process` refuses one file
  for both streams, and any `-ArgumentList` element containing spaces is silently
  mangled — wrapping the command in `bash -c '<script>'` produced an empty log and
  no server, with `set -e` swallowing the launcher's own failure so it exited
  silently with no output at all.
- **Verified end to end through the real WSL branch**, which is the path that
  failed: `pi-provider-manager-ui.log` came back with the four startup lines, and
  the handoff log with `teeing output into …` and `listening pid=… version=0.3.13`.
  For the crash case the manager was made to fail the only way that matters here —
  a second instance on a held port — and `EADDRINUSE` with its full stack landed in
  both files, where previously there was nothing anywhere.
- **Both new tests were run against deliberately reverted code and failed as
  intended:** removing the launcher's `PI_PROVIDER_MANAGER_LOG` token and
  disabling the server's tee each failed exactly the assertion meant to hold them.
  The existing successful- and failed-handoff tests were extended to assert the
  handoff log's contents rather than only `restartError` in memory.
- Not claimed: the replacement that died in the reported incident would still have
  died. What changes is that the next one leaves a stack trace and a handoff
  narrative instead of a refused connection.

final result: passed

## Handoff Convergence — Evidence

- Evidence date: `2026-09-16`. Manager `0.3.13` (post-release). The second half of
  the owner-reported incident, after the observability round: fix the handoff's
  timing, and handle the flaky CI assertion found on the way.
- **The handoff no longer accepts one reply as proof.** `applyRestart` exited the
  moment a different pid answered `/api/state` and watched nothing afterwards, so a
  replacement that bound the port, answered and then died left no service, no
  `restartError` (a variable in the memory of the process that had just exited) and
  nothing to read. The port is now surrendered only when the replacement is still
  answering at the end of a five-second settle window. If it dies or is no longer
  the process answering, the old manager kills it, waits for the socket and
  reclaims the port.
- **Death is taken from the exit event, not from the probe**, and that distinction
  is deliberate: this process spawned the replacement, so its exit is reported
  directly, while a probe can fail for reasons of its own on a loaded machine —
  treating that as death would abandon a healthy replacement on a busy host. A
  reply from a *different* pid is still treated as failure, because the port has
  genuinely changed hands and the decision is no longer this process's to make.
- **New test: a replacement that answers and then dies is taken back.** The copied
  `server.mjs` is made to poll the port and exit 1.5s *after it binds* — timed off
  the port rather than off startup, because version detection before `listen` can
  take seconds and a fixed delay from module evaluation would kill the replacement
  before it ever bound, which is the other failure the suite already covers. The
  test asserts the recovering pid, the message, that the log says
  `replacement answered pid=…` first, and that it does **not** claim `handoff
  complete`.
- **Confirmed against reverted code:** forcing `settled = Boolean(replacementPid)`
  — the old answer-once behaviour — makes the new test fail on its deadline.
- **A failed `server.listen` is reported, not fatal.** Node delivers it as an
  `'error'` event and an unlistened event is an uncaught exception, so a busy port
  at startup produced a dead process with nothing said. Binds are awaited, retried
  to a deadline (the launcher probes the port and then the manager binds it; the
  recovery path has just killed the process holding the socket), and answered with
  the address and the code. The existing log test was updated accordingly: the
  crash log now carries `EADDRINUSE` and `端口已被占用`, and the handoff log carries
  `listen failed: EADDRINUSE` — where it previously recorded an uncaught exception,
  which is exactly what this item removes.
- **The flaky 420px assertion was measuring the toast.** `removeTopmost` asked
  `elementFromPoint` whether anything covered the delete control, and it was read
  *after* the test clicked that control and raised the armed-delete toast. The
  answer therefore depended on the toast's height against the scroll position,
  which moves with font metrics — on a page this round never touched, which is why
  it failed once on CI and passed on re-run with byte-identical assets. It is now
  measured in the resting layout, before the toast exists. Recorded honestly: the
  transient overlap it was picking up is real (at 420px the toast can sit over a
  control the user just armed and can still click), but this round does not claim
  to have fixed it, and no attempt was made to reproduce it outside CI.
- **Cost, measured:** the successful-handoff test went from 2.8s to 6.2s and the
  browser suite from 33s to 41s, all of it the settle window. It is invisible to a
  user — the replacement is the process serving during that window — and it is the
  price of not handing over the port on a single reply.
- Not claimed: the replacement that died in the reported incident is still not
  explained. What changed is that its shape is now survivable, and its account is
  written down.

final result: passed

## The Incident Explained — Evidence

- Evidence date: `2026-09-16`. Manager `0.3.14` (post-release). The failure the
  previous two rounds were built around was reproduced with a stack trace while
  verifying the 0.3.14 release on this machine's own instance.
- **What the report actually was.** Restarting the running manager to apply
  0.3.14 produced, in the handoff log:

  ```
  handoff requested old=2196664 version=0.3.13
  spawned replacement pid=2212967 old=2196664
  listening pid=2212967 port=43127 version=0.3.14 replacing=2196664
  uncaught exception: Error: write EIO
      at Socket._write ... at stream.write (server.mjs:118) at server.mjs:1345
  ```

  The manager's stdout is a pty whose master had gone: the launcher's WSL branch
  starts it on a hidden console, and that console dies with the session that opened
  it. The replacement bound the port, logged its startup lines, and then died on its
  **first output write** — a write error arrives as an `'error'` event on the
  stream, and an unhandled stream error is an uncaught exception. That is the whole
  of the original incident: nothing on the port, nothing written down, an answer to
  the readiness probe followed by death. Earlier in this session a pty experiment
  aimed at this was inconclusive and was recorded as such; this is direct evidence,
  and it arrived only because the previous round made the failure legible.
- **Fix 1, load-bearing: output is not a lifeline.** When a log is named, the
  manager attaches an `'error'` handler to both output streams, so a console that
  goes away drops output instead of killing the process, and records it once in the
  handoff log rather than once per failed write. Stream writes are also guarded
  against a destroyed stream's synchronous throw.
- **Fix 2, the source of it: a detached replacement is not handed a terminal.**
  `outlivesUs` treated any character device as a destination that outlives this
  process, and a pty is a character device — so the replacement inherited the very
  console that had just died, and its first write was the fatal one. A TTY now
  counts as already gone. Verified on a real pty: the manager's own stdout was
  `/dev/pts/3` while its replacement's is `/dev/null`. `/dev/null`, files and the
  existing pipe rule are unchanged.
- **Coverage, and what it pins.** A new test spawns the manager with a log,
  destroys the parent's read ends of its output, and then makes it report a failed
  restart — the write a manager reaches for at exactly the wrong moment. The reader
  going away is modelled with a destroyed pipe after measuring that it fails the
  same way (`write EPIPE`, same unhandled `'error'` event). Confirmed against
  reverted code: with the handler removed the manager dies and the test fails with
  *"the manager died with its console instead of reporting the failure"*. The test
  pins fix 1; **fix 2 has no automated coverage**, because a pty whose master closes
  while the child lives is not reproducible here — `script(1)`'s child dies of
  SIGHUP with its wrapper, measured — so fix 2 rests on the `/dev/pts/3` →
  `/dev/null` observation above.
- **A note on the release that shipped without this.** `v0.3.14` contains the
  handoff log and the settle window, but not these two fixes: its restart can still
  kill a manager whose console has gone, which is what happened during verification.
  The settle window is what kept that from being a silent outage — the old process
  reclaimed the port — and the handoff log is what named the cause. Both fixes are
  on `main` and need a release of their own.
- Not claimed: nothing about the user's machine is inferred from this. The
  reproduction is on the same host, the same launcher branch and the same console
  lifecycle, and the stack trace is the same error.

final result: passed
