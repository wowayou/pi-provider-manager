# Contributing

Thanks for helping improve Pi Provider Manager.

## Before opening a change

1. Do not commit real credentials, `auth.json`, or private provider exports.
2. Use separate temporary `PI_CODING_AGENT_DIR` and `PI_PROVIDER_MANAGER_CODEX_DIR` directories for manual testing; every state read inspects both targets.
3. Preserve unknown Pi and Codex config fields unless the change is an explicit migration.
4. Keep the UI beginner-facing; advanced compatibility options belong behind a disclosure.
5. Document the relevant agent version used for schema-sensitive changes.

Read [docs/architecture.md](docs/architecture.md) before changing component boundaries, the local API, or build/hosting behavior. Read [docs/compatibility.md](docs/compatibility.md) before changing Pi- or Codex-facing schemas or processing an automated Pi update reminder.

Use the vocabulary in the architecture guide consistently: a provider is an API gateway entry and may contain several upstream model families. Pi selects a model as `provider/model`; Codex selects a model within its active provider. API means the wire-protocol identifier; thinking/reasoning effort is separate from the model ID.

## Documentation consistency

- Update `README.md` and `README.zh-CN.md` together when user-facing behavior, setup, safety, compatibility, or roadmap wording changes.
- Read manager version and validated Pi/Codex versions from `package.json`. Do not add another live copy; release notes and dated QA evidence may quote the values they actually tested.
- Treat Git tags and GitHub Releases as shipped state. Put work merged after the latest release under `CHANGELOG.md`'s `Unreleased` section.
- Describe `models-store.json` as out of scope: the manager neither reads nor writes it.
- Keep dated visual and compatibility evidence in `design-qa.md`; do not present historical fixture state as the current state of a user's machine.

## Development checks

```bash
npm ci
npm test
```

`npm test` runs the build and all suites defined in `package.json`. Individual scripts
(`npm run test:server`, `test:codex`, `test:ui`, …) are useful while iterating.
Choose local checks from the [verification matrix](docs/architecture.md#verification-matrix);
every PR must pass the required CI checks. A skipped real-binary test is not evidence
of compatibility: inspect the skipped count and record missing prerequisites.

For UI changes, run `npm run build` followed by `npm run test:ui`. The browser suite serves the production build through `server.mjs` with isolated Pi and Codex directories. Exercise any additional affected flows against `PI_PROVIDER_MANAGER_SERVE_UI=1 node server.mjs` with both directories isolated, and record dated evidence in `design-qa.md`. Vite and `/?demo=1` are useful supplements but do not verify production CSP or the real API boundary.

## Pull requests

`main` is protected. Land changes through a branch and pull request, wait for the required aggregate `ci-passed` check, and squash-merge, so each commit on `main` is one pull request.

Describe:

- the user problem
- affected Pi or Codex config files and fields
- compatibility impact
- security impact
- tests performed
- screenshots for visible changes

Use fake provider names, public documentation URLs, and fake keys in fixtures and screenshots.
