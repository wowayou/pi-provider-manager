# Pi and Codex Compatibility Policy

## Supported baseline

- The latest locally validated Pi version is `piValidatedVersion` in `package.json`. That field is the only live baseline; the build and server read it, and Settings shows it beside the Pi version detected on the machine. Do not maintain a second current-baseline copy in code, documentation, or automation. Release notes and dated QA evidence may quote the version they actually tested.
- Managed Pi files: `auth.json`, `models.json`, `settings.json`
- Out-of-scope Pi file: `models-store.json` is never read or written
- The latest locally validated Codex version is `codexValidatedVersion` in `package.json`, under the same one-copy rule.
- Managed Codex files: `config.toml`, `auth.json`, and this manager's own `pi-provider-manager-store.json`

Dated compatibility evidence belongs in `design-qa.md`. It records what was actually exercised, while `piValidatedVersion` remains the only live compatibility baseline.

## Compatibility design

The manager is an adapter over Pi's documented configuration files, not a replacement runtime.

To reduce breakage:

1. Unknown top-level settings are preserved.
2. Unknown provider properties are preserved.
3. Unknown model properties such as future pricing, headers, sampling, or capability metadata are preserved when the same model ID is edited.
4. Unknown model-level compatibility properties are preserved except fields the user explicitly changes.
5. Files are parsed and validated before replacement.
6. Multi-file provider updates roll back if any write fails.
7. The config directory follows Pi's own precedence: `PI_CODING_AGENT_DIR`, then `~/.pi/agent`.
8. Project path, port, Node binary, browser opening, and WSL distribution are discovered or explicitly overridable; the network host remains loopback-only.


## Codex compatibility

Codex is a second adapter target with its own invariants. Four of them are the ones a Codex upgrade is most likely to break, so check each after bumping `codexValidatedVersion`:

1. **`wire_api` values.** Codex accepted `"chat"` until February 2026 and now accepts only `"responses"`; an unknown value makes the whole `config.toml` fail to load. Verify the accepted set in `codex-rs/model-provider-info/src/lib.rs`.
2. **`[model_providers.<id>]` is `deny_unknown_fields`.** One unrecognised key fails the entire table, so this manager writes only `name`, `base_url`, `wire_api`, and `requires_openai_auth`. Adding a field means confirming the installed Codex accepts it.
3. **How a third-party provider authenticates.** Today the order is `env_key` → `experimental_bearer_token` → `requires_openai_auth` with `auth.json`. A configured `env_key` whose environment variable is unset is a hard error, which is why this manager sets `requires_openai_auth = true` and never writes `env_key`.
4. **Reasoning-effort values.** `model_reasoning_effort` and `plan_mode_reasoning_effort` currently accept `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`.

Two further points shape the design rather than the schema:

- **Codex has one credential slot.** `auth.json` holds a single `OPENAI_API_KEY`, so only the active provider's key can live there. Every other provider's key lives in `pi-provider-manager-store.json` with `0600` permissions.
- **`config.toml` is not the source of truth for inactive providers.** In the single-table layout the manager owns exactly one `[model_providers.<id>]`, so the store carries the rest. If the table on disk does not match anything in the store, the *file* wins and is adopted as a provider entry — the read path never rewrites the file to make the store look right.

Codex layers a `.codex/config.toml` from the working directory tree on top of the user-level file, but `model_provider` and `model_providers` cannot be overridden there — Codex warns and ignores them. This manager therefore writes the user-level `$CODEX_HOME/config.toml` and nothing else; a warning naming those keys concerns the working directory's own file. If a future release makes them project-overridable, revisit whether the manager should see project configs at all.

Unknown top-level keys in `config.toml` are ignored by Codex rather than rejected (`ConfigToml` carries `schemars(deny_unknown_fields)` but not the serde equivalent). That is why a legacy `disable_response_storage` can be preserved without breaking a current install, even though the key is gone from the schema and `store` is hard-coded to `false` in the request builder.

There is no automated Codex release monitor. Codex ships far more often than Pi, and a daily reminder would be noise; check the four items above when a user reports a Codex-side problem or when the baseline is deliberately advanced.

## Update monitoring

The `Pi update monitor` workflow runs daily and can also be dispatched manually. It calls `scripts/check-pi-update.mjs`, reads the latest published stable release from `earendil-works/pi`, and compares its tag with `piValidatedVersion`.

The monitor is intentionally outside the product runtime:

- no Pi package is added to this project's dependencies
- application startup and builds make no upstream network request
- prereleases, tags without a GitHub Release, and upstream `main` commits do not create reminders
- the monitor never changes `piValidatedVersion` or declares compatibility
- a failed upstream request fails the workflow instead of guessing
- a baseline newer than the latest stable Release is treated as an error and never closes or edits a reminder

GitHub may delay scheduled jobs, and scheduled workflows on inactive public repositories can be disabled. The manual `workflow_dispatch` entry and `npm run check:pi-update` command remain the fallback; Actions failures must not be treated as proof that Pi is current.

When the stable release is newer, the workflow creates one `enhancement` issue assigned to the repository owner. Later Pi releases refresh that same issue and add a comment rather than creating a queue of duplicates. Once the validated baseline catches up, the workflow closes the reminder.

Run a read-only comparison locally with:

```bash
npm run check:pi-update
```

The official release source is GitHub Releases. Pi's npm package scope has changed before, so package-registry names are only a cross-check and are not used by the monitor.

## Why updates may still be required

Forward preservation cannot solve semantic or structural changes. A manager release is required when Pi changes any of the following:

- config file locations or root object structure
- provider credential/auth entry schema
- supported API identifiers
- provider/model merge semantics
- thinking-level names or mapping behavior
- model capability fields
- default settings keys or valid values
- live reload behavior

## Release checklist after a Pi update

1. Read Pi's release notes and `docs/models.md`, `docs/settings.md`, and `docs/providers.md`.
2. Refresh test fixtures with a redacted config generated by the new Pi release.
3. Run `npm run test:server` and confirm unknown fields survive an edit.
4. Run `npm run build` and `npm run test:sites`.
5. Repeat the relevant browser scenarios from `design-qa.md` against `/?demo=1` with Playwright or equivalent browser automation. The repository does not currently bundle a browser-test command.
6. Serve the built page with `PI_PROVIDER_MANAGER_SERVE_UI=1 node server.mjs` and exercise the real page/API boundary with a temporary `PI_CODING_AGENT_DIR`.
7. With the released Pi installed, add a fake provider through the manager in that temporary directory. Point it at a non-routable URL and use a dummy key; do not contact a provider.
8. Point Pi at the same directory and verify the model schema directly with `PI_CODING_AGENT_DIR=<temporary-directory> PI_OFFLINE=1 pi --list-models <provider>`. If running an interactive smoke test, also confirm it appears in `/model`.
9. Record the dated result in `design-qa.md`, including the Pi and manager versions but no machine path or credential.
10. Update only `piValidatedVersion` in `package.json` after every check passes.
11. State the validated Pi version in the release notes. Every release says which Pi it was checked against, so a user on a newer Pi can tell how far ahead they are.

## Versioning policy

- Patch release: UI fixes and non-schema behavior
- Minor release: support for new Pi fields, API types, or import sources
- Major release: incompatible config model or migration behavior

## Upstream references

- Pi releases: <https://github.com/earendil-works/pi/releases>
- Pi coding-agent changelog: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md>
- Pi custom models: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md>
- Pi settings: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md>
- Pi providers: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md>
