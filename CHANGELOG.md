# Changelog

## Unreleased

- Updated the GitHub checkout and Node setup actions to their Node 24-based releases after GitHub deprecated the actions' Node 20 runtime.
- Added a daily, maintenance-only Pi release monitor that opens or refreshes one owner-assigned compatibility issue without adding a Pi runtime dependency or advancing the validated baseline.
- Added an architecture and ownership guide, expanded the Pi compatibility runbook, and linked both from the contributor and user documentation.
- Demo mode now reads the manager and validated Pi versions from `package.json` at build time instead of carrying copies that can drift.

## 0.1.7 - 2026-08-18

- Settings now shows the Pi release this manager was validated against, beside the Pi version detected on your machine, and says so plainly when the two differ. Previously the validated version only existed in documentation.
- The validated Pi version is declared once, as `piValidatedVersion` in `package.json`, instead of being restated in the READMEs and compatibility notes where nothing read it and the copies could drift.

## 0.1.6 - 2026-08-18

- Switching a provider's protocol no longer leaves the previous protocol's compatibility flags in `models.json`. Flags that both protocols accept are kept; ones the new protocol rejects are dropped.
- Models saved with 推理能力 = 不支持 no longer get `forceAdaptiveThinking` written into their compatibility block. The value was validated on the way in but reapplied unconditionally when merging with the stored model.
- An API address that cannot be parsed now explains the expected form instead of surfacing the runtime's own `Invalid URL` text, and an empty address is reported as empty rather than as a parse failure.
- The server test no longer inherits environment variables that override its own settings. `PI_PROVIDER_MANAGER_PORT` takes precedence over `PI_PROVIDER_MANAGER_API_PORT`, so a developer with the former exported made the spawned server bind elsewhere while the test polled a dead port.
- The server test waits long enough for installed-Pi detection, which can spend up to eight seconds in a login shell before the server binds.

## 0.1.5 - 2026-08-18

- Editing a model ID no longer clears its default selection. The default was tracked by the model ID, which is an editable field, so correcting a typo in the default row silently unticked it and made saving fail with no indication why.
- Editing a provider no longer takes over Pi's global default. The single save action always set the provider as default, so opening a non-default gateway just to fix a model ID rewrote `settings.defaultProvider`. Existing non-default providers now offer "保存更改" alongside "保存并设为默认", and the success screen says which one happened.
- Renaming a provider no longer claims to keep a credential it never had. The "保留现有 key" mode persisted after the ID stopped matching a stored credential, leaving no tab selected while the panel still reported the credential as saved.
- Settings now reports how many defaults are still absent from `settings.json` rather than claiming everything is written. The server sends which keys the file actually holds, because every value it returns is normalized and a fallback was indistinguishable from a stored value.
- The default-provider list keeps the provider it is displaying. Providers without models were filtered out, so a default with none rendered as a different provider; it now stays listed and labelled, with the model field disabled and explained.
- The theme is applied before first paint again in the packaged app. The pre-paint script was blocked by the server's `script-src 'self'`, so the wrong-theme flash it prevents had returned whenever the UI was served by `server.mjs`. The policy now allows it by hash.

## 0.1.4 - 2026-08-18

Security release. Upgrade if you have ever run the manager while browsing the web.

- **Fixed credential theft through cross-origin writes.** The local API accepted any POST regardless of `Origin`, `Host`, or `Content-Type`. A page the user visited could submit a `text/plain` form post — a CORS simple request, so never preflighted — and use `credential.mode: "migrate"` to copy the user's stored API key onto a provider with an attacker-controlled `baseUrl`, then mark it default. The next `pi` session would send the real key to the attacker. Requests to `/api/` now require a loopback `Host` on the service port, which also blocks DNS rebinding, and mutating requests must send `Content-Type: application/json`, which forces a preflight that is never answered.
- **Fixed silent destruction of a stored credential.** `credential.fromProvider` was unvalidated, so `__proto__`, `constructor`, and `toString` passed an existence check by resolving on `Object.prototype`, overwrote a real key with `{}`, and returned success while the UI still showed the credential as configured. Migration sources must now be an own, object-valued entry matching the provider-id pattern. The same unguarded lookup in the settings endpoint is fixed too.
- Added regression tests for cross-origin writes, DNS rebinding, prototype-chain credential sources, and the legitimate paths that must keep working.
- The dev proxy now sets `changeOrigin`, so proxied requests present the API's own host.

## 0.1.3 - 2026-08-18

- Updated `vite` to 6.4.3, `postcss` to 8.5.26, and `nanoid` to 3.3.18, clearing all six Dependabot advisories. `npm audit` reports no vulnerabilities. All three are build-time only; neither the local server nor the Sites worker imports them.
- Moved `vite` and `@vitejs/plugin-react` to `devDependencies`, so build tooling is no longer reported as a runtime dependency. Every documented install path uses a plain `npm ci`, which still installs them.
- Fixed a flaky port in the server test, which derived its port from the process id and collided with concurrent runs or an already-bound port.
- Read the reported manager version from `package.json` instead of a second hardcoded copy in the server, and report `unknown` rather than a stale literal when compatibility data is unavailable.

## 0.1.2 - 2026-08-18

- Set every machine literal — provider IDs, base URLs, model IDs, token counts, config paths, versions, and the `pi --model` command — in a monospace face, so values that belong in a config file are typeset like one.
- Added a dark theme with three states: follow system, light, and dark. The choice persists and is resolved before first paint, so the app never flashes the wrong theme.
- Lifted every colour into a semantic token, so the two themes are one design at two sets of values.
- Added a visible keyboard focus ring to every interactive element; previously only text inputs had one.
- Made the protocol picker and theme switch real radio groups with arrow-key selection.
- Replaced two link-styled labels that did nothing with a protocol hint panel and a safe-defaults action.
- Made the copy button report success only when the clipboard write actually succeeds, falling back to selecting the command.
- Added undo to the bulk safe-defaults action, which overwrites context and output limits the user may have typed.
- Required a deliberate second click to delete a model, so a double-click cannot remove a row.
- Accepted `200k` and `1.05m` in token fields, marked invalid input while typing, and bounded values so a typo cannot become a plausible number.
- Reported settings keys missing from `settings.json` as unwritten instead of saved, which previously left them impossible to persist.
- Compacted model rows from 112px to 66px, roughly doubling how much of a long catalog is visible.
- Kept the provider list reachable below 860px as a scrollable rail instead of hiding it.
- Added Escape, backdrop close, Cmd/Ctrl+Enter, and a duplicate-aware count to bulk model import.
- Drew radios and checkboxes from the app's own tokens so both themes match.
- Read the reported manager version from `package.json` instead of a second hardcoded copy.

## 0.1.1 - 2026-08-17

- Replaced the placeholder Settings action with a real Pi settings and compatibility screen.
- Added a post-save success screen with the exact Pi model command and `/model` verification steps.
- Added sticky, internally scrollable model catalogs and bulk model-ID import.
- Added warnings for model IDs that may incorrectly encode thinking levels.
- Preserved unknown provider, model, compatibility, and settings fields across edits.
- Added installed Pi version detection and compatibility policy.
- Added automatic config/project/Node/WSL discovery with explicit environment-variable overrides and a loopback-only host boundary.
- Replaced the shared Vite port `4173` with identity-checked automatic selection from `43127-43146`, preventing stale Service Workers or unrelated apps from opening first.
- Added open-source readiness documentation and CI.

## 0.1.0 - 2026-08-17

- Initial local provider/model manager.
- Added secret-safe credential handling and atomic config writes.
- Added per-model API overrides and Playwright-verified three-step setup flow.
