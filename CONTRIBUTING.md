# Contributing

Thanks for helping improve Pi Provider Manager.

## Before opening a change

1. Do not commit real credentials, `auth.json`, or private provider exports.
2. Use a temporary `PI_CODING_AGENT_DIR` for manual testing.
3. Preserve unknown Pi config fields unless the change is an explicit migration.
4. Keep the UI beginner-facing; advanced compatibility options belong behind a disclosure.
5. Document the Pi version used for schema-sensitive changes.

Read [docs/architecture.md](docs/architecture.md) before changing component boundaries, the local API, or build/hosting behavior. Read [docs/compatibility.md](docs/compatibility.md) before changing Pi-facing schemas or processing an automated Pi update reminder.

## Development checks

```bash
npm ci
npm run build
npm run test:server
npm run test:sites
npm run test:pi-update
```

For UI changes, also run the local Playwright flow against `/?demo=1` and update `design-qa.md` when the visible product changes materially. Any change touching the served page or API must also be exercised against `PI_PROVIDER_MANAGER_SERVE_UI=1 node server.mjs` with a temporary `PI_CODING_AGENT_DIR`; Vite alone does not cover production CSP or the real API boundary.

## Pull requests

Describe:

- the user problem
- affected Pi config files and fields
- compatibility impact
- security impact
- tests performed
- screenshots for visible changes

Use fake provider names, public documentation URLs, and fake keys in fixtures and screenshots.
