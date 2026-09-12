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
