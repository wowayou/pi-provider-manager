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

- **Pi-native provider/model workflow** — model IDs, default thinking level, image capability, context/output limits, and per-model API and Base URL overrides.
- **Router-first catalog management** — one OpenRouter-like gateway can contain models from many upstream vendors.
- **On-demand remote catalog discovery** — only an explicit user action lets the server test the current credential and read the gateway's model catalog; results can be deduplicated into the form without saving automatically.
- **Secret-safe local boundary** — existing API keys are never returned to the browser; the backend binds to `127.0.0.1` only.
- **Validated atomic writes** — updates to `models.json`, `auth.json`, and `settings.json` use validated temporary files and rollback on failure.
- **Forward-compatible edits** — unknown provider, model, and settings fields are preserved when known fields are updated.
- **Beginner save handoff** — after saving, the app gives the exact `pi --model provider/model:thinking` command and `/model` verification steps.
- **Large catalog UX** — sticky model header, internal scrolling, bulk model-ID import, and warnings when `-max`/`-xhigh` may be thinking levels rather than real model IDs.
- **Complete gateway lifecycle** — provider deletion uses a clear confirmation dialog, removes the matching credential, and keeps Pi's default model reference valid.
- **Real Pi settings** — default provider/model/thinking, transport, thinking-block visibility, installed Pi version, and compatibility status.
- **No database lock-in** — Pi remains the source of truth; the app edits Pi's own documented files and never reads or writes `models-store.json`.

## Files managed

- `~/.pi/agent/auth.json`
- `~/.pi/agent/models.json`
- `~/.pi/agent/settings.json`

`models-store.json` is outside the manager's scope and is never read or written.

## Mixed-protocol gateways

A provider still needs only one credential, but different protocols do not always share one base endpoint. OpenAI-compatible APIs commonly use a URL such as `https://gateway.example/v1`. The Anthropic SDK appends `/v1/messages` itself, so its base URL is commonly `https://gateway.example`; reusing the OpenAI URL would produce the wrong path.

The manager therefore supports both provider defaults and per-model API/Base URL overrides. For example, keep OpenAI as the provider default with the `/v1` URL, then set a Claude model to `anthropic-messages` and give that model the gateway URL without `/v1`. It remains under the same provider and shares the same credential.

A blank model Base URL inherits the provider default. Overriding only the API does not guess or rewrite the URL.

## Gateway configuration guidance

Treat a provider as an API gateway entry rather than a single vendor: one entry normally needs one credential, one default wire protocol, and one default Base URL, then can contain models from several upstream families. Confirm the protocol and endpoint root in the gateway documentation before adding models; do not put a concrete request path such as `/chat/completions` or `/messages` in the Base URL.

Use Advanced compatibility settings only when a gateway mixes protocols or exposes different endpoint roots for different models. Leaving both model fields blank fully inherits the gateway defaults; changing only the protocol never guesses a URL.

After entering an endpoint and credential, users may explicitly run “Test and load catalog.” The server requests the protocol's model-list endpoint with an eight-second timeout, a response-size cap, and redirects disabled; existing keys are never returned to the browser. A `404` only means that automatic catalog listing is unavailable, not that a manually configured inference model cannot work. Importing results changes the current form only and still requires an explicit save.

Deleting a gateway opens a confirmation dialog that names the models, credential, and default reference being removed. Confirmation then updates `models.json`, `auth.json`, and `settings.json` atomically.

## Select controls

Finite option lists use the shared `SelectControl`. It remains a native `select` with a consistent caret, focus, hover, disabled, and dark-theme treatment, preserving keyboard navigation, screen-reader semantics, and the mobile platform picker.

This does not make every choice a dropdown: protocol cards and the light/system/dark theme switch use native radio groups because their options should stay visible, while provider filtering and bulk model import use text inputs. A custom searchable or multi-select combobox would require a separate accessibility and mobile-behavior review before adoption.

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

Check or stop the detached service with:

```bash
~/.pi/agent/bin/pi-provider-manager-ui status
~/.pi/agent/bin/pi-provider-manager-ui stop
```

`stop` verifies that the process on the port is Pi Provider Manager, then asks its loopback API to shut down cleanly. For an older release without the shutdown route, it sends `TERM` only after confirming that the listener is a `server.mjs` process. It also succeeds safely when no manager is running. If the service was started with a custom `PI_PROVIDER_MANAGER_PORT`, use the same variable when stopping it.

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
- Completed: explicitly authorized connection checks and remote model-catalog import
- Future: filtered import for very large catalogs and an optional one-model inference probe

See `design-qa.md` and `qa/` for visual comparisons, interaction evidence, and QA history.
