# Pi Provider Manager UI

A beginner-friendly local UI for managing custom Pi Agent API gateways and their models without manually editing JSON files.

## What it manages

- `~/.pi/agent/auth.json`
- `~/.pi/agent/models.json`
- `~/.pi/agent/settings.json`

`models-store.json` is read-only and is never modified.

## Core model

A provider is treated as an API gateway/router similar to OpenRouter:

- one provider ID
- one Base URL
- one credential
- one default wire protocol
- many models from different upstream vendors
- optional per-model protocol overrides under Advanced settings

## Start in WSL

```bash
~/.pi/agent/bin/pi-provider-manager-ui
```

The launcher starts the local service when needed and opens `http://127.0.0.1:4173/` in the Windows default browser.

## Security boundary

- The API binds to `127.0.0.1` only.
- Existing API keys are never returned to the browser.
- The UI displays only whether a credential is configured.
- New keys are accepted only on save and written to `auth.json` with private file permissions.
- Changes to `models.json`, `auth.json`, and `settings.json` use validated temporary files and rollback on failure.
- Backend tests use temporary directories and fake keys.

## Development

```bash
npm run dev -- --host 127.0.0.1 --port 4173 --strictPort
npm run build
npm run test:server
npm run test:sites
```

Use `/?demo=1` for a non-writing visual and interaction demo.

## Roadmap

- V1: visual manual provider/model management
- V2: CSV import and CC-Switch configuration import after a redacted sample format is available

See `design-qa.md` and `qa/` for the selected design, browser screenshots, comparisons, interaction evidence, and QA history.
