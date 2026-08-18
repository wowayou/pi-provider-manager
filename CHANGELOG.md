# Changelog

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
