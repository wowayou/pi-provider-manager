# Contributing

Thanks for helping improve Pi Provider Manager.

## Before opening a change

1. Do not commit real credentials, `auth.json`, or private provider exports.
2. Use a temporary `PI_CODING_AGENT_DIR` for manual testing.
3. Preserve unknown Pi config fields unless the change is an explicit migration.
4. Keep the UI beginner-facing; advanced compatibility options belong behind a disclosure.
5. Document the Pi version used for schema-sensitive changes.
6. Mock gateway catalog endpoints with a loopback server and fake credentials; never use a real provider key in tests, fixtures, screenshots, or review logs.

Read [docs/architecture.md](docs/architecture.md) before changing component boundaries, the local API, or build/hosting behavior. Read [docs/compatibility.md](docs/compatibility.md) before changing Pi-facing schemas or processing an automated Pi update reminder.

Use the vocabulary in the architecture guide consistently: a provider is one Pi API gateway entry (供应商网关) and may contain several upstream model families (上游厂商); a model is selected as `provider/model`; API means the wire-protocol identifier; Base URL means the endpoint root; thinking level is separate from the model ID.

For finite option lists, use the shared `SelectControl` wrapper around a native `select`. Do not replace it with a simulated menu popover. Native radio groups remain appropriate when choices should be visible, and text inputs remain appropriate for search or bulk import.

## Documentation consistency

- Update `README.md` and `README.zh-CN.md` together when user-facing behavior, setup, safety, compatibility, or roadmap wording changes.
- Read manager version and validated Pi version from `package.json`. Do not add another live copy; release notes and dated QA evidence may quote the values they actually tested.
- Treat Git tags and GitHub Releases as shipped state. Put work merged after the latest release under `CHANGELOG.md`'s `Unreleased` section.
- Describe `models-store.json` as out of scope: the manager neither reads nor writes it.
- Keep dated visual and compatibility evidence in `design-qa.md`; do not present historical fixture state as the current state of a user's machine.

## Development checks

```bash
npm ci
npm run build
npm run test:server
npm run test:sites
npm run test:pi-update
```

For UI changes, repeat the relevant browser scenarios in `design-qa.md` against `/?demo=1` with Playwright or equivalent browser automation, and update the evidence when the visible product changes materially. The repository does not currently bundle a browser-test command. Any change touching the served page or API must also be exercised against `PI_PROVIDER_MANAGER_SERVE_UI=1 node server.mjs` with a temporary `PI_CODING_AGENT_DIR`; Vite alone does not cover production CSP or the real API boundary.

## Pull requests

`main` is protected. Land changes through a branch and pull request, wait for the required aggregate `ci-passed` check, and use rebase merge so history remains linear.

Describe:

- the user problem
- affected Pi config files and fields
- compatibility impact
- security impact
- tests performed
- screenshots for visible changes

Use fake provider names, public documentation URLs, and fake keys in fixtures and screenshots.
