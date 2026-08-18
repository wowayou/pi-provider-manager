# Contributing

Thanks for helping improve Pi Provider Manager.

## Before opening a change

1. Do not commit real credentials, `auth.json`, or private provider exports.
2. Use a temporary `PI_CODING_AGENT_DIR` for manual testing.
3. Preserve unknown Pi config fields unless the change is an explicit migration.
4. Keep the UI beginner-facing; advanced compatibility options belong behind a disclosure.
5. Document the Pi version used for schema-sensitive changes.

## Development checks

```bash
npm ci
npm run build
npm run test:server
npm run test:sites
```

For UI changes, also run the local Playwright flow against `/?demo=1` and update `design-qa.md` when the visible product changes materially.

## Pull requests

Describe:

- the user problem
- affected Pi config files and fields
- compatibility impact
- security impact
- tests performed
- screenshots for visible changes

Use fake provider names, public documentation URLs, and fake keys in fixtures and screenshots.
