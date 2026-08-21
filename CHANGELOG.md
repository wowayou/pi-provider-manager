# Changelog

## 0.2.0 - 2026-08-21

- Added Codex CLI support. A Pi/Codex switch at the top of the sidebar routes the same provider list, three-step wizard, settings screen, and success handoff to whichever agent you are configuring; the Pi side is unchanged. The manager writes `$CODEX_HOME/config.toml` and `auth.json`, remembers every provider's definition and key in its own `0600` store, and switches the active gateway in one click.
- `config.toml` edits are surgical. A small TOML document model rewrites only the manager's own `[model_providers.<id>]` table, its generated `[profiles.*]`, and the top-level model keys; comments, unrelated keys, and provider tables written by hand survive byte for byte. Regenerated profiles are deleted by recorded name rather than by prefix, so a hand-written profile sharing the prefix is not swept away.
- A `config.toml` that predates the manager is adopted rather than overwritten: if the owned table matches nothing in the store, the file wins and the entry is labelled as adopted. Reading state never writes, so opening the page cannot disturb a working setup.
- Added a managed bridge for upstreams that expose only `/v1/chat/completions`, which Codex cannot reach at all since it dropped the `chat` wire protocol. Choosing that path asks for the upstream's own address and key; the manager writes LiteLLM's config, points Codex at the local proxy with `requires_openai_auth = false`, and starts and stops the process. The user installs LiteLLM and nothing else. The upstream key enters neither config file — it lives in the manager's `0600` store and reaches LiteLLM through an environment variable. The proxy is pinned to `127.0.0.1`, because LiteLLM defaults to `0.0.0.0` and would otherwise publish an unauthenticated proxy holding that key on every interface; it is started detached so closing the manager does not cut Codex off; and a recorded process id is never signalled unless procfs still shows it running the manager's own config file, since process ids are reused.
- This project still does not translate model traffic. Writing a third-party config file and supervising a process is the same work it already does for Pi and Codex; the translation stays LiteLLM's to maintain, which matters because the part that keeps moving is Codex's side of the wire and Codex ships weekly.
- Codex writes carry their own revision, separate from Pi's, so editing one agent's configuration cannot invalidate an in-flight draft for the other. All three Codex files move together or roll back together.
- Added `codexValidatedVersion` to `package.json` and Codex version detection to the server, shown side by side in the Codex settings screen under the same one-copy rule as `piValidatedVersion`.
- Extracted the atomic-write, validation, and TOML primitives into `lib/`, shipped as source in the release archives; both launchers now resolve and pass the Codex directory explicitly, because a detached WSL process does not inherit the calling shell's environment.
- Fixed the launcher hanging on its own port probe. `port_in_use` connected through bash's `/dev/tcp`, which has no connect timeout; under WSL2 mirrored networking a connect to an unbound loopback port never returns, so the launcher stalled on its first candidate port with nothing on screen. It now asks Node whether the port can be bound. The launcher also prints its URL and both config directories unconditionally, and detaches the browser bridge, so a blocked `wslview` or `powershell.exe` can no longer look like a hang.

- The Codex settings screen now names any hand-written `[model_providers.*]` table that omits `name`. Verified against the real binary: one such table makes Codex refuse to load the entire config, every other provider included. The manager preserves those tables rather than repairing them, so the least it can do is say which one is at fault.
- Added `npm run test:codex-real`, which runs the installed `codex` binary against manager-generated configuration and proves both paths end to end, offline and without a key. The direct path asserts Codex sent the exact credential the manager stored; the bridged path stands up a gateway that refuses `/v1/responses`, has the manager configure and start LiteLLM in front of it, and asserts `codex exec` completes a turn while the upstream sees only authenticated Chat Completions. It skips itself where Codex or LiteLLM is absent, so it is the first thing to run after a Codex upgrade.

The managed bridge was additionally exercised on the owner's WSL2 machine against a real third-party gateway: the manager generated LiteLLM's config, started the proxy, and Codex resolved the bridged model and had its request accepted.

**Validated against Codex `0.149.0`.** On 2026-08-21 a real `codex-cli 0.149.0` on WSL2 started against a manager-written `config.toml` and reported the expected model and reasoning effort, confirming the generated `[model_providers.*]` table passes its `deny_unknown_fields` check. Per-project trust tables keyed by quoted paths containing slashes and CJK, and legacy keys such as `disable_response_storage`, survived the round trip. This is now automated as `npm run test:codex-real`, which asserts `codex doctor --json` reports `config.load: ok` after the manager rewrites a realistic file; `reachability mode` also switches to `API key auth`, confirming Codex resolved the generated provider and took the `auth.json` credential path. The dated record is in `design-qa.md`; see `docs/compatibility.md` for the items to recheck on a Codex upgrade.

## 0.1.9 - 2026-08-19

- Added optimistic concurrency protection across `auth.json`, `models.json`, and `settings.json`. The server returns an opaque HMAC revision with every state response and requires it on provider, deletion, and settings writes. If CC Switch, another browser tab, or a text editor changed any managed file, the stale request returns HTTP 409 without writing; the UI keeps the draft and offers to reload.
- Added prebuilt release archives for Linux/WSL and Windows. They contain the built UI, dependency-free Node server, documentation, and platform launchers without `node_modules` or Pi data. A release-published workflow builds both archives from the tag, while CI validates the staging contents and parses the PowerShell launcher on Windows.
- Made both launchers resolve a bundled project relative to their own location, so an extracted release can run from any directory while copied launchers and the existing environment overrides continue to work.
- Moved the project into focused maintenance mode. CC Switch now owns the broader Pi workflow; this manager remains intentionally limited to Pi credentials, runtime defaults, and native-file consistency. The unstarted CC-Switch/CSV import and model-discovery roadmap is retired.

**Validated against Pi `0.84.2`.** The Pi-facing schema is unchanged from 0.1.8. Production-shaped regressions exercise successful writes, externally modified files, HTTP 409 conflicts, preserved external fields, and the browser reload action using isolated temporary Pi directories.

## 0.1.8 - 2026-08-19

- Added guarded provider deletion. A named confirmation dialog removes the provider and all of its models, deletes its stored credential by default, and can explicitly retain that credential for later reuse. Deleting Pi's current default requires a valid replacement provider/model; the server validates and writes all three files as one rollback-protected operation, so stale tabs and direct API calls cannot break the invariant.
- Persisted model IDs are now read-only storage identities. Replacing one means adding the new ID and deleting the old row through the armed, reversible flow; a second draft guard rejects programmatic identity drift, and saving no longer silently falls back to the first named model when no default radio is selected.
- Arming any model deletion now states the consequence in a toast, with model IDs in the product's monospace face. The live-default badge and protocol note share a reserved annotation rail, so all model rows stay 85px tall and every primary control remains on the same 42px top-aligned rail before, during, and after confirmation.
- Added a production-browser UI regression job for model deletion protection. It serves the built app from `server.mjs` with isolated Pi files and checks read-only persisted IDs, live and ordinary delete warnings, fixed row geometry, delete/undo, editable new rows, dark theme, mobile overflow, and browser errors before `ci-passed` can succeed.
- Deleting the model Pi is currently using is now visible before it happens and reversible after. The row Pi's default points at carries a "Pi 当前默认" badge that stays put no matter where the default radio is moved, arming its delete button says which model the default will fall back to, and every removal offers 撤销 in its toast — a removed row otherwise takes its stored compatibility flags and preserved unknown fields with it when the provider is saved.
- Saving a provider can no longer leave `settings.json` pointing at a model that `models.json` no longer contains. The submitted list replaces the stored one wholesale, so dropping the current default without naming a replacement is refused with the model ID in the message; "保存并设为默认" is the path that removes it.
- Aligned the English and Chinese project guides, architecture vocabulary, security boundary, Pi compatibility runbook, contribution rules, and handoff around shared sources of truth.
- Updated the GitHub checkout and Node setup actions to their Node 24-based releases after GitHub deprecated the actions' Node 20 runtime.
- Added a daily, maintenance-only Pi release monitor that opens or refreshes one owner-assigned compatibility issue without adding a Pi runtime dependency or advancing the validated baseline.
- Added an architecture and ownership guide, expanded the Pi compatibility runbook, and linked both from the contributor and user documentation.
- Demo mode now reads the manager and validated Pi versions from `package.json` at build time instead of carrying copies that can drift.

**Validated against Pi `0.84.2`.** Provider deletion was exercised against a production-shaped server with an isolated temporary Pi directory. A non-default provider was deleted with `keepCredential: true`: it disappeared from `models.json` and the provider list, while its `auth.json` entry and `authProviders` ID remained. Recreating the same provider with `credential.mode: "keep"` succeeded without submitting a new key.

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
