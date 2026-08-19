# Pi Provider Manager

[简体中文](README.zh-CN.md)

A local, Pi-native model catalog and API gateway manager. It gives `auth.json`, `models.json`, and `settings.json` a safe visual workflow without hiding or replacing Pi's native configuration model.

## Why this exists

Pi is model-centric at runtime but provider-scoped in configuration:

- sessions select a concrete `provider/model`
- thinking level is independent from the model ID
- credentials and default wire protocol belong to the provider
- a provider can expose many models
- a model can override its provider's API when a gateway mixes protocols

Pi Provider Manager makes that relationship visible instead of forcing users to hand-edit three JSON files.

## Highlights

- **Pi-native provider/model workflow** — model IDs, default thinking level, image capability, context/output limits, and per-model API overrides.
- **Router-first catalog management** — one OpenRouter-like gateway can contain models from many upstream vendors.
- **Secret-safe local boundary** — existing API keys are never returned to the browser; the backend binds to `127.0.0.1` only.
- **Validated atomic writes** — updates to `models.json`, `auth.json`, and `settings.json` use validated temporary files and rollback on failure.
- **Guarded provider deletion** — removing a gateway names every affected model, deletes its credential by default with an option to retain it, and requires a valid replacement before deleting Pi's current default.
- **Forward-compatible edits** — unknown provider, model, and settings fields are preserved when known fields are updated.
- **Beginner save handoff** — after saving, the app gives the exact `pi --model provider/model:thinking` command and `/model` verification steps.
- **Large catalog UX** — sticky model header, internal scrolling, bulk model-ID import, and warnings when `-max`/`-xhigh` may be thinking levels rather than real model IDs.
- **Real Pi settings** — default provider/model/thinking, transport, thinking-block visibility, installed Pi version, and compatibility status.
- **No database lock-in** — Pi remains the source of truth; the app edits Pi's own documented files and never reads or writes `models-store.json`.

## Files managed

- `~/.pi/agent/auth.json`
- `~/.pi/agent/models.json`
- `~/.pi/agent/settings.json`

`models-store.json` is outside the manager's scope and is never read or written.

## Start locally on Linux or WSL

```bash
git clone https://github.com/wowayou/pi-provider-manager.git ~/pi-provider-manager-ui
cd ~/pi-provider-manager-ui
npm ci
npm run build
install -m 700 bin/pi-provider-manager-ui ~/.pi/agent/bin/pi-provider-manager-ui
~/.pi/agent/bin/pi-provider-manager-ui
```

The launcher reuses an existing manager instance or selects a free port from `43127-43146`. Under WSL it opens the Windows default browser; otherwise it uses an available WSL/PowerShell browser bridge or prints the local URL. It verifies `/api/state` before reuse, so another app on the same port is never mistaken for Pi Provider Manager.

If the repository is cloned elsewhere, set `PI_PROVIDER_MANAGER_PROJECT_DIR` to that absolute path before running the launcher.

### Runtime discovery and overrides

| Variable | Auto-detected default | Purpose |
|---|---|---|
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi config directory used for auth, models, and settings |
| `PI_PROVIDER_MANAGER_PROJECT_DIR` | current matching repo, then `~/pi-provider-manager-ui` | Project/build location |
| `PI_PROVIDER_MANAGER_PORT` | auto-select from `43127-43146` | Strict local loopback port override |
| `PI_PROVIDER_MANAGER_NODE` | current `node` executable | Node binary used by the detached service |
| `PI_PROVIDER_MANAGER_OPEN_BROWSER` | `1` | Set to `0` to start without opening a browser |
| `WSL_DISTRO_NAME` | supplied automatically by WSL | Distribution used by the detached Windows launcher |

The service host intentionally stays fixed at `127.0.0.1`; it is not configurable to a public/LAN address.

The dedicated port range also avoids stale Service Workers and cached apps commonly left on Vite's default `4173` origin.

## Security boundary

- The API binds to `127.0.0.1` only.
- API requests require an allowlisted loopback `Host`; writes additionally require `application/json`, so a foreign page cannot use a simple cross-origin request to mutate configuration.
- Existing API keys are never serialized into browser responses.
- New keys are accepted only on save and written to `auth.json` with private permissions.
- Backend tests use temporary directories and fake keys.
- Do not attach `auth.json`, API keys, or private provider exports to GitHub issues.

See [SECURITY.md](SECURITY.md) for the disclosure policy and threat boundary.

## Compatibility

The Pi release this manager is validated against is recorded once, as `piValidatedVersion` in `package.json`, and surfaced in Settings next to the Pi version actually detected on your machine. Settings says so plainly when the two differ.

Pi evolves independently, so every release runs the compatibility checklist in [docs/compatibility.md](docs/compatibility.md) and states the validated Pi version in its release notes.

A separate daily repository workflow compares that baseline with Pi's latest stable GitHub Release and opens or refreshes a maintenance issue when review is needed. It is not part of the app: startup and builds do not contact upstream, no Pi package is added as a dependency, and the baseline never advances without manual compatibility validation.

The manager intentionally preserves unknown fields, but a release may still be required when Pi changes:

- config filenames or root structure
- API type identifiers
- auth entry format
- model capability fields or thinking-level semantics
- settings names or allowed values

## Project guide

See [docs/architecture.md](docs/architecture.md) for the shared vocabulary, sources of truth, runtime shapes, component responsibilities, configuration ownership, security invariants, compatibility boundary, and change-specific verification matrix. Maintainers should also read [docs/compatibility.md](docs/compatibility.md) before changing Pi-facing schemas or processing an update reminder.

## Development

```bash
npm ci
npm run dev -- --host 127.0.0.1 --port 4173 --strictPort
npm run build
npm run test:server
npm run test:sites
npm run test:pi-update
```

Use `/?demo=1` for a non-writing visual and interaction demo.

The normal development command starts the real writable API. Set `PI_CODING_AGENT_DIR` to a temporary directory before using it when you do not intend to edit your normal Pi configuration. Demo mode and the Sites artifact are the non-writing paths.

`npm run check:pi-update` performs an optional live, read-only comparison against Pi's latest stable GitHub Release.

## Open-source status

Released under the [MIT License](LICENSE). See [OPEN_SOURCE_CHECKLIST.md](OPEN_SOURCE_CHECKLIST.md) for repository hardening tasks that remain after the first push.

## Roadmap

- Completed V1.1: visual provider/model management, real settings, save handoff, compatibility-preserving writes
- Planned V2: CSV import and CC-Switch import after a redacted sample format is available
- Future: optional model-catalog discovery and provider connectivity checks with explicit user consent

See `design-qa.md` and `qa/` for visual comparisons, interaction evidence, and QA history.
