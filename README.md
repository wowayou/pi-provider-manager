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
- **Forward-compatible edits** — unknown provider, model, and settings fields are preserved when known fields are updated.
- **Beginner save handoff** — after saving, the app gives the exact `pi --model provider/model:thinking` command and `/model` verification steps.
- **Large catalog UX** — sticky model header, internal scrolling, bulk model-ID import, and warnings when `-max`/`-xhigh` may be thinking levels rather than real model IDs.
- **Real Pi settings** — default provider/model/thinking, transport, thinking-block visibility, installed Pi version, and compatibility status.
- **No database lock-in** — Pi remains the source of truth; the app edits Pi's own documented files and never modifies `models-store.json`.

## Files managed

- `~/.pi/agent/auth.json`
- `~/.pi/agent/models.json`
- `~/.pi/agent/settings.json`

`models-store.json` is read-only and is never modified.

## Start in WSL

```bash
git clone <your-repository-url> ~/pi-provider-manager-ui
cd ~/pi-provider-manager-ui
npm ci
npm run build
install -m 700 bin/pi-provider-manager-ui ~/.pi/agent/bin/pi-provider-manager-ui
~/.pi/agent/bin/pi-provider-manager-ui
```

The launcher starts the local service when needed and opens `http://127.0.0.1:4173/` in the Windows default browser.

If the repository is cloned elsewhere, set `PI_PROVIDER_MANAGER_PROJECT_DIR` to that absolute path before running the launcher.

## Security boundary

- The API binds to `127.0.0.1` only.
- Existing API keys are never serialized into browser responses.
- New keys are accepted only on save and written to `auth.json` with private permissions.
- Backend tests use temporary directories and fake keys.
- Do not attach `auth.json`, API keys, or private provider exports to GitHub issues.

See [SECURITY.md](SECURITY.md) for the disclosure policy and threat boundary.

## Compatibility

Validated locally against Pi `0.84.2`. Pi can evolve independently, so every release should run the compatibility checklist in [docs/compatibility.md](docs/compatibility.md).

The manager intentionally preserves unknown fields, but a release may still be required when Pi changes:

- config filenames or root structure
- API type identifiers
- auth entry format
- model capability fields or thinking-level semantics
- settings names or allowed values

## Development

```bash
npm ci
npm run dev -- --host 127.0.0.1 --port 4173 --strictPort
npm run build
npm run test:server
npm run test:sites
```

Use `/?demo=1` for a non-writing visual and interaction demo.

## Open-source status

The repository is prepared for public review with CI, security guidance, compatibility documentation, and contribution rules. A public push is intentionally not performed yet.

Before publishing, choose a license and complete [OPEN_SOURCE_CHECKLIST.md](OPEN_SOURCE_CHECKLIST.md).

## Roadmap

- V1.1: visual provider/model management, real settings, save handoff, compatibility-preserving writes
- V2: CSV import and CC-Switch import after a redacted sample format is available
- Future: optional model-catalog discovery and provider connectivity checks with explicit user consent

See `design-qa.md` and `qa/` for visual comparisons, interaction evidence, and QA history.
