# Design QA

This file indexes dated verification evidence. A result applies to the stated version,
flow, and environment; it is not a claim that all present or future UI/UX is accepted.
Current behavior belongs in [the usage guide](docs/usage.zh-CN.md), maintenance rules
in [AGENTS.md](AGENTS.md), and verification requirements in
[the architecture guide](docs/architecture.md#verification-matrix).

## Sources and visual direction

- Shipped versions: [GitHub Releases](https://github.com/wowayou/pi-provider-manager/releases) and tags.
- Declared compatibility baselines: `piValidatedVersion` and `codexValidatedVersion` in [package.json](package.json).
- Pending work and release history: [CHANGELOG.md](CHANGELOG.md).
- Owner decision, 2026-09-24: retain the original v0.4.7 visual language. The later broad charcoal/blue, system-font, compact-layout candidate was rejected. It is not an accepted reference. PR #133 changes only sidebar utility alignment.
- Historical images: `design-reference.png` and the `qa/pi-provider-manager-v11-*.png` captures describe the earlier V1.1 demo, using generic paths and fake keys. They are not current-product screenshots. Theme controls, row dimensions, fonts, and colors must be checked against the current implementation.
- Full earlier QA narratives, including superseded visual reviews, restart incidents, and compatibility triage: [snapshot before this documentation cleanup](https://github.com/wowayou/pi-provider-manager/blob/f744d4cf6bb743e95d64ebea095812a0b5d54a97/design-qa.md). Archived conclusions retain their original scope and dates.

## How to reproduce relevant checks

| Scope | Command / evidence |
|---|---|
| Production UI | `npm run build` then `npm run test:ui`; the suite serves `server.mjs` and isolates both agents' directories |
| Pi configuration, headers, discovery, update/restart | `npm run test:server`; exercise changed API boundaries against production serving |
| Codex configuration and bridge supervision | `npm run test:codex` |
| Global prompt files | `npm run test:prompts` |
| Real Codex config, advertised commands, credential and bridge wire paths | `npm run test:codex-real`; Codex and LiteLLM must be available, with 0 skips |
| Real Pi model/header behavior | `npm run test:pi-real`; installed Pi against an isolated loopback gateway, with 0 skips |
| Claude Code storage, API boundaries and per-terminal launcher | `npm run test:claude` |
| Real Claude credentials, aliases, `CLAUDE.md` and parallel terminals | `npm run test:claude-real`; installed Claude Code against loopback fake gateways, with 0 skips |
| Sites, releases, launchers | `test:sites`, `test:release`, `test:launcher`; Windows execution is covered by CI |
| All local suites | `npm test`; inspect complete totals and skipped count |

Manual page/API checks use `PI_PROVIDER_MANAGER_SERVE_UI=1` with separate temporary
`PI_CODING_AGENT_DIR` and `PI_PROVIDER_MANAGER_CODEX_DIR` directories. Vite and
`?demo=1` supplement these checks; they do not prove the production headers or API.
See [AGENTS.md](AGENTS.md) for the detached-runner workaround if a controlling
terminal stops a browser suite before it prints a complete summary.

## v0.5.4 Release Acceptance — 2026-10-08

- **Scope.** The Pi `1.1.0` compatibility and version-detection changes below,
  plus release metadata. Node `24.18.0`, npm `11.16.0`; the installed Pi command
  now reports `1.1.0`. No global agent installation or owner configuration was
  changed during release acceptance.
- **Full candidate run.** `npm ci --ignore-scripts`, then full `npm test`,
  detached with `setsid`, exit 0: 304 tests, 302 passed, 0 failed. The two skips
  are Windows-only Claude launcher cases run by the required CI Windows job.
  Production browser: 36/36. Real binaries: Codex `0.160.0` 5/5 including the
  LiteLLM bridge, Pi `1.1.0` 3/3, Claude Code `2.1.285` 10/10 including all three
  interactive pty cases; each real-binary suite has zero skips.
- **Archive.** `npm run package:linux` built the candidate without `node_modules`.
  Extracted outside the checkout, it passed 13 checks using separate temporary
  Pi, Codex and Claude directories: production page/CSP, all three version
  values, provider and Settings saves preserving unknown fields and OAuth,
  mixed model endpoints, default selection, credentials absent from responses,
  `auth.json` at `0600`, and real Pi listing both saved models offline without
  rewriting any of the three Pi files. Chromium opened the archive's Settings
  page, rendered detected Pi `1.1.0`, validated Pi `1.1.0` and manager `0.5.4`,
  and reported no JavaScript errors. The screenshot remains outside the repo.
- **Release boundaries.** Build produced all three required Sites entry files;
  the existing chunk-size warning remains non-fatal. The read-only Pi monitor
  reported baseline `1.1.0`, latest stable `1.1.0`, status `current`. No real
  gateway or paid inference was used; Codex's declared baseline is unchanged.

## Pi 1.1.0 and managed-install migration — 2026-10-08

- **Scope.** Manager `0.5.3` plus these unreleased changes; Node `24.18.0`, npm
  `11.16.0`. The owner's official managed installation remains Pi `1.0.4`.
  Pi `1.1.0` was installed only in a temporary prefix using the official release's
  install manifest and lockfile with `npm ci --ignore-scripts`.
- **Upstream review.** Read the `1.0.3`, `1.0.4` and `1.1.0` release notes and
  compared pinned `v1.0.2...v1.1.0` sources. Reviewed models, settings, providers,
  configuration and custom-provider references, auth schema/resolution, provider
  composition, prompt loading and the managed wire implementations. Managed file
  shapes, gateway API identifiers, thinking levels and transport values are
  unchanged. `--tools` modifiers and expanded `outputPad` semantics remain Pi's
  responsibility. The Azure **provider ID** changed to `azure`, while its
  `azure-openai-responses` **API** did not; the guide records this conditional
  migration. A boolean-only inspection found no legacy Azure reference in the
  owner's auth, models, default, scope or thinking-level settings; none was edited.
- **Version-detection defect.** A fake old nvm manifest made the previous detector
  report `1.0.2` without ever asking a runnable `1.1.0`. Four regressions failed
  before the fix; all 12 version tests pass afterward. The detector no longer
  scans installation manifests. With a deliberately stale `hash -p` in the parent
  Bash, both Node's direct `pi --version` and the manager detected the installed
  managed `1.0.4`, proving the terminal hash is not shared.
- **Real Pi.** `test:pi-real`: `1.0.4` 3/3 and `1.1.0` 3/3, zero skips. Stored
  credentials, Anthropic/OpenAI Chat/Responses paths, explicit and inherited model
  addresses, custom prefixes, advertised `--model provider/model:off`, preserved
  sampling parameters, beta override/replacement and clearing all reached the
  loopback gateways correctly. With thinking enabled, the sibling still sent
  `interleaved-thinking-2025-05-14` and the override replaced it.
- **Production boundary.** Built `server.mjs` with separate temporary Pi/Codex/
  Claude directories. Saved a dummy `.invalid` provider and both models through
  the API, then changed defaults through Settings. Unknown settings (including
  `defaultTools`, `codemode`, `outputPad` and `npmCommand`) and an OAuth-shaped entry
  survived both writes; responses contained no key/token and `auth.json` remained
  `0600`. Pi `1.1.0` listed both models offline without rewriting any managed file.
  Opened the production Settings page in Chromium; it rendered the detected and
  validated versions without JavaScript errors. The server fixture now checks
  these unmanaged settings after both types of save and isolates the Codex dir.
- **Regression.** Separate detached runs, not a full `npm test`: server 105/105,
  production browser 36/36, Sites 4/4, update monitor 8/8, prompts 15/15, release
  staging 1/1, launchers 8/8. Including both real-Pi runs: 183 tests, zero failures
  and zero skips. Build produced all three required Sites entry files.
- **Install/build warnings.** Reviewed the installed npm 11.16 documentation:
  unreviewed scripts still run by default and the pending-list command is read-only.
  No approval policy was changed. A separate clean temporary project install using
  `npm ci --ignore-scripts` also built successfully. Vite still warns about the
  535.13 kB JS chunk (155.98 kB gzip); no threshold, UI or splitting change was made.
- **Limits.** No global Pi upgrade, owner configuration write, real gateway request
  or paid inference. Interactive Pi `/model`, live Azure, Windows Pi detection,
  and real Codex/Claude binaries were not revalidated in this task. The `402`
  diagnosis is based on the gateway error the owner supplied, not a live quota
  probe. `piValidatedVersion` advances only after these compatibility checks;
  Codex's baseline is unchanged.

## Pi 1.0.2 and mixed-protocol addresses — 2026-10-05

- **Scope.** Local changes after v0.5.2; Node `24.18.0`, installed Pi `1.0.2`.
  Reviewed official [1.0.1](https://github.com/earendil-works/pi/releases/tag/v1.0.1)
  and [1.0.2](https://github.com/earendil-works/pi/releases/tag/v1.0.2) releases and
  the `v1.0.0...v1.0.2` diff. Managed auth/settings contracts and API identifiers
  are unchanged. The relevant addition is `samplingParamsByThinkingLevel`;
  provider/model merge preservation already supports it.
- **Real Pi, 3/3, zero skips.** One loopback gateway and one stored dummy credential
  served Anthropic Messages, OpenAI Chat and Responses. Pi reached `/v1/messages`,
  `/v1/chat/completions`, and `/v1/responses`; after changing the provider default,
  inherited Chat and explicit `/anthropic/v1/messages` and `/openai/v1/responses`
  still worked. Commands included the advertised `--model provider/model:off`
  form. Stored `samplingParamsByThinkingLevel.off` reached Chat as temperature
  `0.7` and top_p `0.8` after a manager save. Both prior beta-header tests passed.
- **Production API smoke.** Separate temporary Pi/Codex/Claude directories;
  built UI served by `server.mjs`. Saved a dummy `.invalid` provider, then settings;
  Pi listed both models offline. OAuth credentials and unknown settings
  (`quietStartup: "header"`, `tuiMode`, `defaultTools`, `codemode`) survived;
  credentials were absent from state and `auth.json` remained `0600`.
- **Regression.** `test:server` 103/103; `test:ui` 36/36; `test:sites` 4/4;
  `test:pi-update` 8/8; release staging 1/1. All zero skips. Browser coverage
  includes address save/reload, unchanged JSON round trips, invalid URL focus
  after saving from step 2, restoring inheritance and undo, plus existing Beta,
  discovery, default/409, Codex and Claude flows. For the v0.5.3 release
  candidate the full `npm test` was re-run: 300 of 302, 0 failures, 2
  Windows-only skips, including 5 real-Codex tests on `0.160.0`, 3 real-Pi
  tests on `1.0.2` and 10 real-Claude tests on `2.1.285`.
- **Preview.** Opened real production pages at 1440px light, 850px dark and
  390px light. No horizontal page overflow; fields stay within the panel. The
  phone disclosure keeps its title on one line and its count below. Contrast
  and control-size checks passed in the browser suite. Captures use dummy
  gateways and stay outside the repository.
- **Limits.** No live gateway, paid request, real credential or owner config was
  used. Gateway-specific prefixes still require the gateway's documentation.

## v0.5.2 Release Acceptance — 2026-10-02

- **Scope.** `main` after #157: the Pi `1.0.0` baseline below, the symlinked prompt fix and the Claude Code `2.1.287` resume case. Only `version` changed for the release.
- **Release candidate.** Node `24.18.0`, with Pi `1.0.0` first on `PATH`. Full `npm test`, detached with `setsid`, exit 0: 297 tests, 294 passed, 0 failed.
  - The 3 skips are Windows-only: two Claude launcher cases and one PowerShell launcher case, all run by the CI Windows job.
  - Production browser: 36/36.
  - Real binaries: Codex `0.149.0` 5/5 including the LiteLLM bridge, Pi `1.0.0` 2/2, Claude Code `2.1.287` 10/10 including the pty cases.
- **Archive.** `npm run package:linux` built `pi-provider-manager-v0.5.2-linux-wsl.tar.gz` with no `node_modules`. Extracted outside any checkout, its `server.mjs` passed the same 10 checks as the Pi `1.0.0` record: page served, no key returned, settings (including `quietStartup: "header"` and `tuiMode`) and OAuth entry preserved through a provider save and a Settings save, `auth.json` at `0600`, and Pi `1.0.0` listing both saved models.

## Pi 1.0.0 Compatibility — 2026-10-02

- **Pi `0.99.2` → `1.0.0` (closes #158, opened by the update monitor on 2026-10-02).** I read the release notes and diffed the two source archives.
  - `models.md` only adds image models, reached through codemode and extensions; the custom model schema is unchanged. `custom-provider.md` and `configuration.md` are unchanged. `providers.md` is retitled "Providers" and documents Radius.
  - `settings.md`: `quietStartup` also accepts `"header"`, and `tuiMode` now defaults to `"fullscreen"`. Neither is a managed key.
  - `cli.md`: `--provider` now requires `--model`. The handed-out command is `pi --model provider/model[:level]`; `model-resolver.ts` is unchanged.
  - `model-registry.ts` only adds `generateImages()`. `anthropic-messages.ts` is unchanged. `openai-responses-shared.ts` only changes which replayed tool-call item IDs it drops. The `KnownApi` identifiers, thinking levels and transport values are unchanged.
- **Checklist steps 6–8, production server.**
  - Setup: Pi `1.0.0` was installed into a temporary npm prefix and put first on `PATH`; this machine's global Pi stays `0.99.1`. Pi, Codex and Claude directories were temporary. `settings.json` was seeded with `theme`, `defaultTools`, `codemode`, `fullscreenWheelScrollLines`, `quietStartup: "header"` and `tuiMode: "regular"`, and `auth.json` with an OAuth-shaped entry.
  - A fake provider (HTTPS `.invalid` host, dummy key, two models, set as default) was saved through the API, then the default model, thinking level, thinking-block visibility and transport were changed through `/api/settings`. All 10 checks passed:
    - The page was served.
    - `/api/state` and the save response carried no key.
    - The seeded settings survived both saves, and the OAuth entry was untouched.
    - `auth.json` stayed `0600`.
    - `PI_OFFLINE=1 pi --list-models qa-check` listed both models with the saved context, output, thinking and image values.
    - The Pi run did not rewrite manager-written files.
    - `detectPiVersion()` parsed `1.0.0` from the `pi` on `PATH`. The login-shell path reported this machine's global `0.99.1`, as before.
  - The handed-out command ran against the fake Anthropic gateway: `pi --model qa/claude-qa:high` sent thinking enabled, `:off` sent it disabled, both with the stored key.
- **Suites.** Node `24.18.0`, with Pi `1.0.0` first on `PATH`. Full `npm test`, detached with `setsid`, exit 0: 297 tests, 294 passed, 0 failed, 3 Windows-only skips.
  - Real binaries: Pi `1.0.0` 2/2, Codex `0.149.0` 5/5 including the LiteLLM bridge, Claude Code `2.1.287` 10/10 including the pty cases.
- **Baselines.** `piValidatedVersion` raised to `1.0.0`. `codexValidatedVersion` unchanged at `0.154.0`.

## Symlinked Prompt Files — 2026-10-02

- **Trigger.** The owner plans to link `$CODEX_HOME/AGENTS.md` to a shared guidance repository, and to have `CLAUDE.md` import it.
- **Measured before the change**, with an isolated temporary directory:
  - `writeTextAtomic` renamed over a symlinked slot. The slot became a plain `0600` file, and the source kept its old text.
  - `createFileGuard.writeAll` rolled back every file in its group after a failure, including files it never wrote. That rollback replaced an untouched link the same way.
- **What each agent reads**, measured with fake gateways, temporary config directories and dummy keys:
  - Codex `0.149.0` sent the linked file's text when `$CODEX_HOME/AGENTS.md` was a symlink.
  - Claude Code `2.1.287` sent it when `CLAUDE.md` was a symlink, and also when `CLAUDE.md` held only `@<absolute path>`.
  - A control run with no `CLAUDE.md` did not contain it.
  - Checked later the same day with a temporary `HOME`: `2.1.287` also sent it when `CLAUDE.md` held only `@~/<path>`. A control `CLAUDE.md` without the import did not.
- **Change.**
  - Prompt state reports `link: { target, exists }`.
  - Saving, activating, or deleting the live document of a linked slot is refused before any write. Storing a document without activating it is still allowed.
  - Rollback restores only the files whose bytes changed.
  - The prompt screen shows the link target and a status line.
- **Verification.** Node `24.18.0`, full `npm test` detached with `setsid`, exit 0: 297 tests, 294 passed, 0 failed, 3 Windows-only skips. That includes 3 new library tests, which failed before the change, and a production-browser case: the save was refused, the link survived, and the source was unchanged. Real Claude Code `2.1.287` 10/10. The light and dark screenshots were checked by eye.

## Claude Code 2.1.287 Resume Fallback — 2026-10-02

- **Trigger.** This machine's Claude Code auto-updated from `2.1.286` to `2.1.287`. Full `npm test` then failed one case in `test:claude-real`: "cross-gateway resume fails when the new relay rejects the signature with a non-standard error". It expected one request to the new gateway and saw two. It reproduced twice in isolation. Every other suite passed.
- **Cause, measured with the test's fake gateways.**
  - `2.1.287` sends `thinking.display: "updates"` with the `thinking-display-updates-2026-08-18` beta.
  - When the gateway answers that request with a bare `400 Bad request`, Claude Code repeats it about 10 ms later without that field and without that beta. Both requests carry `x-stainless-retry-count: 0`, and nothing else in the body differs. The replayed signature stays, so the repeat is refused too, and the turn fails with 400 as before.
  - `2.1.286`, installed into a temporary prefix, sends one request without the field.
  - The user-facing behaviour is unchanged. Only the request count differs.
- **Change.** The case now accepts one request, or a second one that equals the first minus `thinking.display`. In both shapes, every request must still carry the history and the signature. `docs/claude-code.md` describes the repeat. The CI pin stays at `2.1.285`. No product code changed.
- **Verification.** Node `24.18.0`, detached with `setsid`. `test:claude-real` on `2.1.287`: 10/10, 0 skips, including the pty cases. The three resume cases on `2.1.286`: 3/3.

## Pi 0.99.2 Compatibility and v0.5.1 Release Acceptance — 2026-10-01

- **Pi `0.99.1` → `0.99.2` (closes #152, opened by the update monitor).** I read the release notes and compared `v0.99.1...v0.99.2`, 213 files.
  - `models.md`, `custom-provider.md` and `configuration.md` are unchanged.
  - `providers.md` only adds Anthropic workload identity federation, read from `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID` and `ANTHROPIC_IDENTITY_TOKEN_FILE`; `auth.json` is not involved.
  - `settings.md` rewords `codemode.mode` and documents that `/reload` enables newly added `defaultTools`. There are no new settings keys.
  - The `anthropic-messages.ts` changes are federation auth and non-strict tools for schemas strict mode rejects. Model `headers` handling is unchanged.
  - No managed file structure, API identifier, thinking level or managed settings key changed.
- **Checklist steps 6–8, production server.**
  - Setup: Pi `0.99.2` was installed into a temporary npm prefix and put first on `PATH`; this machine's global Pi stays `0.99.1`. The manager ran with `PI_PROVIDER_MANAGER_SERVE_UI=1` and temporary Pi, Codex and Claude directories. `settings.json` was seeded with `theme`, `defaultTools` (`+grep`, `-bash`, `+powershell`), `codemode` and `fullscreenWheelScrollLines`, and `auth.json` with an OAuth-shaped entry.
  - A fake provider (HTTPS `.invalid` host, dummy key, two models, set as default) was saved through the API. All 10 checks passed:
    - The page was served.
    - `/api/state` and the save response carried no key.
    - The seeded settings survived, and the OAuth entry was untouched.
    - `auth.json` stayed `0600`.
    - `PI_OFFLINE=1 pi --list-models qa-check` listed both models with the saved context, output, thinking and image values.
    - The Pi run did not rewrite manager-written settings.
    - `detectPiVersion()` parsed `0.99.2` from the `pi` on `PATH`.
  - The login-shell path, which the manager uses so a detached server still finds the user's own Pi, reported the global `0.99.1`. That is the version this machine's shell would run, so it is correct.
  - Real Pi `0.99.2` (`test:pi-real`): 2/2, 0 skips.
- **Release candidate.** Node `24.18.0`, with Pi `0.99.2` first on `PATH`. Full `npm test`, detached with `setsid`, exit 0: 293 tests, 290 passed, 0 failed.
  - The 3 skips are Windows-only: two Claude launcher cases and one PowerShell launcher case, all run by the CI Windows job.
  - Production browser: 35/35.
  - Real binaries: Codex `0.149.0` 5/5 including the LiteLLM bridge, Pi `0.99.2` 2/2, Claude Code `2.1.286` 10/10 including the pty cases.
- **Archive.** `npm run package:linux` built `pi-provider-manager-v0.5.1-linux-wsl.tar.gz` with no `node_modules`. Extracted outside any checkout, its `server.mjs` passed the same 10 checks: page served, no key returned, settings and OAuth entry preserved, `auth.json` at `0600`, and Pi `0.99.2` listing both saved models.
- **Baselines.** `piValidatedVersion` raised to `0.99.2`. `codexValidatedVersion` unchanged at `0.154.0`.

## UI Loose Ends — 2026-10-01

- **Sidebar selection bar.** Measured in `?demo=1` with all nine providers selected.
  - Before, at 1440px, the bar was 295px wide while its items needed 296px, so 取消全选 took two lines. At 1024px and 900px the bar was 215px; 已选 9 个 was squeezed to 12px wide, one character per line, and the bar was 87px tall.
  - Now the bar is a two-row grid: selection and count on top, buttons right-aligned below, with `white-space: nowrap` on the labels. It is 77px at all three widths.
  - The bulk-delete browser case now runs at 1024px and asserts every text node in the bar has one line box. Against the old build that assertion reported 全选 and 已选; it passes now.
- **Demo Anthropic URL.** `discoveryRequest` derives `https://api.any-claude.com/v1/v1/models?limit=1000` for the demo's old base URL, so the demo showed what the server would really request. The data was wrong: Pi appends `/v1/messages` to an Anthropic base URL. The demo base URL is now `https://api.any-claude.com`, and the dialog shows `…/v1/models?limit=1000`.
- **Demo delete dialog.** It says no other provider has models. Checked, not a defect: the other eight demo Pi providers have `models: []`.
- **Bridge buttons.** Measured in the real `a saved bridged Codex provider gets its bridge control` flow: 启动桥 is 40px at 14px/600. Its 18px icon is now 16px, like the other `.button-md` buttons. A scan of every `.button-md` and `.button-sm` button found no other icon above 16px.
- **Stale test comment.** The #147 comment in the deletion case described the scroll reset as running in an animation frame; since #150 it runs at commit. The comment now says so. The two-frame wait stays as a guard.
- Verification on Node `24.18.0`: full `npm test`, detached with `setsid`, exit 0.
  - Server 99, Codex 75, Claude 34 (32 passed, 2 Windows-only skips), prompts 12, Sites 4, Pi update 8, release 1, launchers 8 (7 passed; 1 skip, no Windows PowerShell on this machine).
  - Production browser 35.
  - Real Codex `0.149.0` 5/5, including the LiteLLM bridge. Real Pi `0.99.1` 2/2. Real Claude Code `2.1.286` 10/10, including the three pty cases.

## Save From Any Step — 2026-10-01

- Scope: item 4, the last item of the UI consistency plan; the plan file is removed with this change, and its items are recorded in the entries below. The owner approved the behaviour change on 2026-10-01.
  - Steps 1 and 2 show 保存更改 for a draft with a stored source (`identity.sourceId`), in Pi and Codex through a shared `StepFooter` and in Claude in its own footer.
  - It calls the same save as step 3's 保存更改. Pi's default keeps `setDefault`; the live Codex provider stays live; Claude saves without activating.
  - Pi's and Codex's step-3 checks now move to step 3 when they refuse: at least one model, a named default, an over-long User-Agent, model-ID identity. Before, they set an error with no step change. Claude already did this.
  - Steps 1 and 2 render `ErrorBanner` with `conflict`.
- **Scroll race found and fixed.** A refusal from step 2 landed on step 3 with the User-Agent field focused but scrolled off screen.
  - Cause: the step-change scroll reset ran in an animation frame registered after the field's own focus-and-scroll, so it undid it.
  - Fix: the reset now runs as a layout effect at commit. Heading focus stays in the frame, so a field that already holds focus keeps it.
  - Mutation check: putting the reset back in the frame made the new browser case time out at its "field is on screen" assertion.
- **New production-browser case** `a saved provider saves from steps 1 and 2; a new draft keeps the three-step flow`:
  - A new draft shows no 保存更改 on steps 1 and 2.
  - Pi step 2: 保存更改 is disabled with 没有改动 until a Base URL edit. The save writes the new `baseUrl` and keeps the models, Pi's default provider and model, and the stored key.
  - Pi step 1: a protocol change plus an external `models.json` edit returns a 409 shown on step 1 with 重新读取, and the external edit survives.
  - An over-long User-Agent saved from step 2 lands on step 3 with the field focused, on screen and `aria-invalid`, and nothing written.
  - Codex: the adopted provider saves from step 2 with a new key and address, and `config.toml` keeps its comment and hand-written table.
  - The Claude workflow case now also saves a new base URL from step 2 and checks `ANTHROPIC_BASE_URL`.
- Element diff of 25 screens: only the step 1 and 2 footers changed. The first-run (new draft) screen is pixel-identical.
- Verification on Node `24.18.0`, detached with `setsid`: build passed; `test:server` 99/99, `test:codex` 75/75, `test:claude` 32 passed with 2 Windows-only skips, production browser 35/35.

## Sidebar Status — 2026-10-01

- Scope: item 3 of `docs/plans/ui-consistency.md`. The amber dot renders only when `provider.ready` is false. Its `aria-label` and `title` read 未配置凭据, and the row's tooltip appends it. The badge moved into a `provider-name-line` beside the name. The unused `readyLabel` strings went with the green dot.
- Before, a badge in the trailing column truncated subtitles: Claude's "Anthropic Messages" showed as "Anthropic Mes…" and Codex's "2 个模型 · Responses" as "Respo…". Both now render in full.
- Row height:
  - The first version grew badged rows from 62 to 63px at 1440px and from 51 to 57px at 390px.
  - Measured cause: the badge's CJK label sets a 17px line where the Latin name sets 15px (13px text) or 16px (14px text).
  - Fix: on the name line the badge drops its vertical padding and takes a −1px block margin.
  - Re-measured: badged and plain rows are both 62px at 1440px and 51px at 390px. The 25-screen element diff reports no height change on any row.
- Verification on Node `24.18.0`, detached with `setsid`: build passed; `test:server` 99/99; production browser 34/34. The cases that read `.provider-badge` per row, or find a renamed row by a `title` ending in its ID, still pass. Those rows have credentials, so their titles are unchanged.

## Claude Code Summary, Footer and Settings Parity — 2026-10-01

- Scope: item 2 of `docs/plans/ui-consistency.md`. `ProviderSummary`, `WizardFooter` and `KeyValueList` were added to `ui-kit.jsx`.
  - Pi uses all three: step 3 and its settings.
  - Codex uses all three: step 3 and its settings.
  - The shared manager card uses `KeyValueList`.
  - Claude uses all three: step 3, every wizard step's footer, and settings, where the footer also became the `settings-footer`.
  - `.compact-button` and the two Claude-only summary rules were removed once nothing used them.
- Extraction check: the 25-screen capture of a `main` build was compared pixel by pixel with the extracted build before any size change.
  - Every Pi screen was identical.
  - Codex differed only in a 9×8px patch where `model_providers.custom` became one text node instead of two. That is a sub-pixel antialiasing change at the dot, not a visible one.
  - The other differences matched the 2px strips two captures of one build already disagree on.
- Then 复制供应商 and 删除供应商 moved onto the scale: from 36px at 16px/700 to `--button-md` at 14px/600, and at 600px and below to `--button-sm` at 13px. Before, only delete shrank there, to 34px. The element diff showed only these two buttons change.
- Claude now matches Pi and Codex. Its step-3 summary carries the icon, the auth-type badge (a button back to step 1 once saved), the address (a button to step 2 once saved), the credential status, and the outlined actions. The footer note is 13px grey beside the actions. Its 390px footer, which wrapped to two rows with the longer 已读取保存的配置, fits one row with 没有改动.
- Verification on Node `24.18.0`, detached with `setsid`: build passed; `test:server` 99/99; `test:claude` 32 passed, 2 Windows-only skips; production browser 34/34. The Claude production workflow case now finds the summary actions under `.gateway-side` and the settings note under `.settings-footer .dirty-note`, with the same text asserted.

## Type Scale for Text — 2026-10-01

- Scope: every `font-size` in `src/styles.css`, plus the one `font` shorthand, now reads a `--text-*` token.
  - Literals already on the scale (12/13/14/16/18/24px) were replaced one for one.
  - Off-scale values went to the nearest step: 11 and 11.5px to 12px, 12.5px to 13px, 15px to 14px, 21px to 18px, and 28px to 24px.
  - 13.5px sits exactly between two steps, so it was split by role: labels and list names went up to 14px (sidebar navigation, prompt names), prose notes went down to 13px (bridge notes).
- Method: the same 25-screen element diff as the button slice, against the build that included #146, plus the seven dialogs.
  - Only the intended elements changed. In order of visibility: the success-page title (28 to 24px), dialog titles and the sidebar app name (21 to 18px), sidebar provider names (15 to 14px), sidebar navigation (13.5 to 14px).
  - Also: config-editor text and gutter, notes, and prompt status went from 12.5 to 13px.
  - Line heights set in px stayed put, so the editor gutter stays aligned with its text.
  - No element went below 12px.
- Regression guard: `tests/style-tokens.test.mjs` fails on a px font size outside the scale. Reintroducing one `13px` literal made it fail; it passes on the migrated stylesheet.
- Flaky case found and fixed: the first full production-browser run failed one case, `production UI protects persisted model deletion paths`, at its 420px `removeTopmost` check.
  - A probe showed `step-scroll` back at `scrollTop` 0, with the delete control at y 1001 in a 900px viewport.
  - Cause: entering step 3 schedules the app's scroll-to-top for the next animation frame. The case scrolled before that frame ran, so its scroll was undone.
  - It is a race in the test, not a regression. The same probe on a `main` build failed 2 of 8 runs.
  - Fix: the case now waits two frames before scrolling and asserts the position held. 8 of 8 runs passed, then the full suite.
- Verification on Node `24.18.0`, detached with `setsid`: build passed; `test:server` 99/99; production browser 34/34, including contrast and 12px CJK in both themes.

## Type and Button Scale, Remaining Buttons — 2026-10-01

- Scope: every action button not covered by #144 and #145, except Claude's provider summary (item 2 of `docs/plans/ui-consistency.md`). The owner told the remaining slices to proceed without a stop between them.
  - Unclassed variant buttons are now the large size, set by the base rule: 44px at 16px, weight 600 instead of 700, and inline padding 20px instead of 22px.
  - `.button-md` covers the manager card, the prompt editor's 启用这一份 / 保存并写入文件 / 删除, the JSON and `config.toml` editors' 取消/应用, and the bridge pair.
  - `.button-sm` covers the User-Agent and Beta helpers, 编辑原始配置, 校验/自动格式化, the sidebar bulk-action bar and the command copy button.
  - The `.compact-button` overrides in the bulk bar, User-Agent and Beta rows were removed.
- Method: production build served by `server.mjs` with `PI_PROVIDER_MANAGER_SERVE_UI=1` and isolated directories. 25 screens were captured: the three targets' wizard steps, the advanced panel, the JSON editor, the `config.toml` paste panel, settings, success, prompts, sidebar selection mode, and the first-run screen. Each was taken in light at 1440×900 and 390×844 and in dark at 1440×900, under `?demo=1` except first-run. Every visible element's computed font size and weight, and every button's size, were diffed before and after.
- Result: only the intended buttons changed.
  - Before, the same kind of button measured 34–44px at 12–16px depending on where it sat. The editors' 校验/自动格式化 went from 44px at 16px in the JSON editor (13px in the paste panel) to 32px at 13px everywhere.
  - No text outside a button changed.
  - One side effect: Claude's provider-summary base-URL button went from 15.04px to 16px, because the base rule now sets the size; item 2 replaces that button.
  - Not captured: the bridge start/stop pair, which `?demo=1` does not render. The production-browser bridge case still renders 启动桥 on the success screen, but nothing measured the pair's new size.
- Verification on Node `24.18.0`, detached with `setsid`: build passed; `test:server` 98/98; production browser 34/34.

## Type and Button Scale, Second Slice: Dialogs — 2026-10-01

- Scope: every dialog's buttons. 获取模型, 批量添加模型, Pi delete and bulk delete, Codex delete and bulk delete, and Claude delete. `.button-sm` was added. The owner approved the first slice (#144) before this one started.
- Measured on the production build, served by `server.mjs` with `PI_PROVIDER_MANAGER_SERVE_UI=1` and isolated directories, under `?demo=1` (layout only), light and dark, 1440×900 and 390×844:
  - Action rows went from 44px at 16px/700 with 18px trash icons to 40px at 14px/600 with 16px icons. 取消 is now 62px wide, down from 78px.
  - In the 获取模型 dialog, the path retry went from 36px at 12px/700 to 40px at 14px/600, beside the 42px path input. 全选/清空 went from 32px at 12px/700 to 32px at 13px/600.
  - The 520px rule that stretches the delete dialogs' buttons to full width is unchanged.
  - Before/after screenshots were sent to the owner for local review and are not committed.
- Verification on Node `24.18.0`, detached with `setsid`: build passed; `test:server` 98/98; production browser 34/34, including contrast, target size and 12px CJK in both themes.

## Type and Button Scale, First Slice: Model-Table Toolbar — 2026-10-01

- Scope: item 1 of `docs/plans/ui-consistency.md`, limited to the model-table toolbar in Pi and Codex. The tokens `--text-*` and `--button-*` and the `.button-md` class were added. Nothing else reads them yet.
- Measured on the production build, served by `server.mjs` with `PI_PROVIDER_MANAGER_SERVE_UI=1` and isolated Pi, Codex and Claude directories, light and dark: at 1440×900 the buttons were 44px tall at 16px/700 with 18–19px icons (Pi widths 154/122/122/123), and are now 40px at 14px/600 with 16px icons (142/114/114/114). At 390×844 the icon-only squares went from 44×44 to 40×40. The 18px/700 heading is unchanged. Before/after screenshots went to the owner for review; they are not committed.
- In this Linux machine's headless Chrome screenshots the CJK labels render at the same visible weight at 700 and at 600; only the size and height change shows. The weight change was not checked against a font with a distinct semibold face (PingFang SC, Inter).
- Verification on Node `24.18.0`, detached with `setsid`: build passed; `test:server` 98/98, including the stylesheet token check; production browser 34/34, including contrast, target size and 12px CJK in both themes.

## Sidebar Add Button Height and Claude Code Copy — 2026-10-01

- Cause: `.add-provider` could shrink inside the sidebar's flex column, so once the provider list overflowed it measured about 30px instead of 48px (demo's nine providers at 1440×900). It is now `flex: none`. The Claude Code tip no longer claims a single user-level gateway, and Claude settings label `default-home` as 自动识别 · 用户主目录 like Pi and Codex.
- Regression: the target-size browser case now loads the nine-provider demo, requires the provider list to overflow, and asserts a 48px button. Against the unfixed stylesheet it failed with 30px.
- Verification on Node `24.18.0`, detached with `setsid`: build passed; production browser 34/34 against `server.mjs` with `PI_PROVIDER_MANAGER_SERVE_UI=1`; `test:claude` 32 passed, 2 Windows-only skips. Sidebar children were measured at 900px and 640px heights; the tip's absence at 640px is the existing `max-height: 760px` rule.

## Pi 0.99.1 Compatibility and v0.5.0 Release Acceptance — 2026-10-01

- **Pi `0.87.1` → `0.99.1` (#139).** There are only two releases in this range: 0.99.0 and 0.99.1. I compared the changelog and the pinned `models.md`, `settings.md`, `providers.md`, `custom-provider.md` and `configuration.md` between those versions. None of these changed: the structure of `models.json`, `auth.json` or `settings.json`, API identifiers, thinking levels, and the settings keys the manager writes. New in 0.99: `theme` defaults to `system`; `fullscreenWheelScrollLines`, `codemode.*`, and `deviceId` (from Sign in with ChatGPT); `defaultTools` `+name`/`-name` entries; `extensions` `-builtin:` entries; `mcp.json`; and image/classifier model types, which exist only in the extension registration API. No code change was needed.
- **Checklist steps 6–8, production server.** Ran `PI_PROVIDER_MANAGER_SERVE_UI=1` with temporary Pi/Codex/Claude directories. `settings.json` was seeded with every new key above, and `auth.json` with an OpenAI OAuth-shaped entry. A fake provider (HTTPS `.invalid` host, dummy key) was saved through the API. All 14 checks passed:
  - Every new key survived unchanged, and the OAuth entry was untouched.
  - `/api/state` listed the OAuth entry by ID only; the response carried no key.
  - `PI_OFFLINE=1 pi --list-models` listed both saved models.
  - The Pi run did not rewrite manager-written settings.
  - `detectPiVersion()` reported `0.99.1`.
- **Release candidate.** Node `24.18.0`, full `npm test` detached with `setsid`: 288 tests, 285 passed, 0 failed. The 3 skips are Windows-only: two Claude launcher cases and one PowerShell launcher case, all run by the CI Windows job. Real-binary suites: real Pi `0.99.1` 2/2, real Codex `0.149.0` 5/5 including the LiteLLM bridge, real Claude Code `2.1.285` 10/10 including the pty cases. Production browser: 34/34. `npm run package:linux` built an archive with no `node_modules`; run from an isolated directory, it served the page, saved a fake provider without returning its key, kept `auth.json` at `0600`, and real Pi listed the saved model.
- **Test flake fixed during acceptance.** An earlier full run failed one pty case: the load average was 6–10, and Claude had not exited within the driver's fixed five-second wait. The driver now polls for up to 20 seconds. A/B under full load on 8 cores: old driver 1 of 3 passed, new driver 3 of 3. One earlier full run also skipped the Codex bridge case because the LiteLLM probe missed once under load. Two separate reruns and the final full run each passed it with 0 skips; no code change.
- **Baselines.** `piValidatedVersion` raised to `0.99.1`. `codexValidatedVersion` unchanged at `0.154.0`.

## Post-Merge Verification on a Second Linux Machine — 2026-09-30

- Scope: `main` at `684155b` (PR #138), rerun on a second Linux machine after merge, so the Claude Code baseline also covers `2.1.285` (the version CI's Windows job pins) and not only `2.1.284`. No product code changed.
- Verification on Node `24.18.0`: `npm ci`, then build, then each suite run detached with `setsid`. Results: server 95, Codex 75, Claude 34 (32 pass, 2 Windows-only skips), prompts 12, Sites 4, Pi update 8, release 1, launchers 8 (7 pass, 1 skip because this machine has no Windows PowerShell), production browser 34, real Codex `0.149.0` 5, real Claude Code `2.1.285` 10. Total: 282 tests, 0 failures, 5 skips.
- Real Claude Code `2.1.285` ran 10 of 10 with 0 skips, including the three interactive pty cases (`/exit`, Ctrl+C, terminal close) that CI's Windows job skips. Real Codex `0.149.0` also passed the LiteLLM bridge case, which found LiteLLM through `uvx`.
- Not verified here: real Pi skipped both cases (`pi is not installed`). Pi evidence remains the 2026-09-29 run against `0.87.1`. Compatibility baselines were not advanced.

## Claude Code Target and Per-Terminal Provider — 2026-09-29

- Scope (unreleased): Claude Code as a third target (static Anthropic Messages gateways, Bearer/API-key auth, default model and aliases, rename, duplicate, guarded delete, reply settings, global `CLAUDE.md`), plus a dedicated per-terminal command that starts Claude with a private per-run `--settings` snapshot without switching the global default.
- Launch modes and launcher hardening: the command card offers 固定此供应商 (pinned per-run snapshot) and 跟随全局默认 (plain `claude`, which Claude Code hot-reloads from user `settings.json`; measured ~3 s after a rewrite, not within 500 ms). The launcher now handles SIGHUP (terminal close), does not re-forward a terminal Ctrl+C, force-stops a client ignoring the hangup after 10 s, records launcher/Claude PIDs, and the next launch sweeps sessions whose recorded processes are provably gone. It refuses a symlinked or foreign-owned runtime directory. The manager also sweeps provably stale sessions at startup (never creating the directory, never following a symlink). On Windows the launcher runs the npm package's native `bin/claude.exe` directly instead of handing it to `node`.
- Verification on Node `24.18.0`, each suite run detached with `setsid`: build passed; server 95, Codex 75, Claude 34 (32 pass, 2 Windows-only skips run by the CI Windows job), prompts 12, Sites 4, Pi update 8, release 1, launchers 8, production browser 34, real Codex `0.158.0` 5, real Pi `0.87.1` 2, real Claude Code `2.1.284` 10 — 288 tests, 0 failures. Suites were run individually, not as one `npm test` invocation.
- The real-Claude cases use fake credentials and loopback gateways only: both auth modes reach the wire, aliases resolve, `CLAUDE.md` is sent, two pinned clients keep their gateways across a global switch, a follow-mode client switches gateway/credential/alias, three cross-gateway resume cases (different model: continues; same model + standard signature error: retries and continues; non-standard error: fails), and interactive pty sessions through the launcher (`/exit`, Ctrl+C, terminal close) leave no snapshot. CI's Windows job installs Claude Code `2.1.285` and runs the real cases, allowing only the three pty skips. Not covered: closing a real Windows console window around a real Claude (the SIGHUP handler is exercised in-process on every platform), and real third-party relays' resume behaviour.
- Compatibility baselines (`piValidatedVersion`, `codexValidatedVersion`) were not advanced.

## v0.4.9 Release Acceptance — 2026-09-28

- Final candidate: `npm ci --ignore-scripts` and full `npm test` passed; 243 tests, 0 failures, 0 skips on Node `24.18.0`. Counts: server 95, Codex 75, prompts 12, Sites 4, Pi update 8, release 1, launchers 8, production browser 33, real Codex `0.157.1` 5, real Pi `0.87.1` 2. Both declared agent compatibility baselines remain unchanged.
- The four capacity-review regressions remain covered. Release review additionally reproduced and fixed prototype-named cache IDs writing through inherited properties, and an unchanged advanced JSON round trip dropping automatic capacity updates. The JSON regression failed before the fix and passes in both unit and production-browser coverage. Cache tests cover malformed timestamps, invalid pairs, eviction past 1000 entries, and an actual cache-write failure that still returns a successful provider save; cache-only changes leave the Pi revision unchanged.
- `npm run package:linux` produced the candidate archive. Its contents were inspected and unpacked into a temporary directory; `server.mjs` started without `node_modules`, served the built UI, and saved a fake provider with the expected capacity hints and `0600` cache mode without returning its key. The source document is now included in release staging and checked by `test:release`; both READMEs describe the feature and private cache. Windows execution remains part of the required CI gate.

## Model Capacity Review Corrections — 2026-09-28

- Scope: separate GPT-4.1's 1047576 / 32768 from GPT-5's 400000 / 128000; use one gateway-hint/discovery/generation seed rule for manual entry, bulk paste, and discovery; keep imported rows automatic until either capacity is edited; make partial or conflicting discovery capacities saveable without increasing the gateway's reported context. Sources and the exact adjustment policy are recorded in [model capacities](docs/model-capacities.md).
- Production-browser regression: learn 64000 / 8192 through a real provider save, remove the model, and verify manual and bulk re-add. Check that focusing a field preserves automatic updates, editing either capacity stops them, and changing an imported ID uses its own generation. A loopback gateway returns only an 8192 context for one model; the browser fills 4096 output, reaches the success screen, and the test checks both numbers on disk. The gateway's other row verifies that a learned pair wins over reported capacities. Both agent directories are isolated, and no real credentials or upstream inference are used.
- Verification: full `npm test` passed 238/238, 0 failed, 0 skipped on Node `24.18.0`; server 90, Codex 75, prompts 12, Sites 4, Pi update 8, release 1, launcher 8, production browser 33 (30 top-level cases plus 3 capacity subtests), real Codex `0.157.1` 5, real Pi `0.87.1` 2. Production build passed. Compatibility baselines were not advanced. This records the corrected behaviors exercised, not blanket UI acceptance.
- Handoff: the final build repeated the capacity-browser regression successfully, then the running manager was replaced through its built-in restart endpoint. The replacement reports no restart/build error, exposes capacity hints, and serves the exact built index. Public Pi/Codex configuration is unchanged; all five existing managed files have modification and metadata-change times predating the handoff. Opaque revisions are intentionally regenerated per process and cannot be compared across a restart.

## Provider Rename — 2026-09-28

- Scope: editing a saved provider's ID now moves its configuration, credential, and provider-keyed references — Pi's `defaultProvider`, `modelThinkingLevels`, `compaction.modelOverrides`, and `enabledModels` `old/` prefixes in `settings.json`, and Codex's store entry and active marker. An occupied target (including a retained Pi credential ID) is refused in the wizard with `aria-invalid` and again on the server, so a rename cannot silently overwrite or fork. Keeping the existing key works throughout ID edits, Pi discovery, and Codex bridge saves; the credential is never returned to the browser. A running Codex bridge's provider label is relabelled after the configuration commits, without restarting or signalling the process. Pi and Codex keep separate revision checks.
- Verification: full local `npm test` on the release candidate passed 224/224 with 0 skips — production browser 29, real Codex 5, real Pi 2 — on Node `24.18.0`. The rename browser cases run against `server.mjs` with `PI_PROVIDER_MANAGER_SERVE_UI=1` and isolated Pi/Codex directories. All required CI jobs, including the `ci-passed` aggregate, passed on the feature branch. No compatibility baseline or configuration-format change.

## Sidebar Utility Alignment — 2026-09-24

- The support link uses a 36px target matching the theme toggle, an 18px icon, and padding/gap that align its icon centre and text with the navigation above. Original colours, font settings, filled heart, theme toggle and page layout are retained.
- Verification: production build passed. An isolated production-browser check exercised light/dark at 1440×900 and 390×844 (4/4): utility heights and icon sizes match, centres/text align within 1px, and sidebar font/colours plus workspace height match the original measurements. [PR #133](https://github.com/wowayou/pi-provider-manager/pull/133) also passed all required CI jobs; its production-browser suite reported 26/26 with 0 skips.

## Initial Configuration Navigation Race — 2026-09-24

- Cause: the sidebar rendered before the first `/api/state` response. Clicking Codex in that interval selected a blank draft that the eventual response did not refresh; clicking Add could let the response replace the new Pi draft. Holding the response reproduced the Codex failure even with a 30-second DOM wait.
- Fix: configuration-dependent navigation waits for a successful initial read, including the target switch's arrow-key handler. A failed read keeps navigation locked and the reload action usable. Browser cases wait for usable controls rather than the sidebar's presence; the shared 10-second DOM wait is unchanged and now reports the page state on failure.
- Regression: a browser request is paused through the Chrome DevTools Protocol, then released after attempting navigation. The same case exercises a failed read and the real reload/retry path. It failed against the original product before the fix and passes after it, without sleep-based timing or product test hooks.
- Verification: production build served by `server.mjs` with `PI_PROVIDER_MANAGER_SERVE_UI=1`, isolated Pi and Codex directories, `build` passed and the full browser suite passed 26/26 with 0 skips on Node `24.18.0`. The `0.4.7` release candidate, including the empty-prompt and heading-focus fixes, also passed full `npm test`: 214/214, 0 skips, including real Codex 5/5 and real Pi `0.87.1` 2/2. No config format or runtime compatibility baseline changed.

## v0.4.6 UX Review Implementation — 2026-09-24

- Scope: the P0/P1/P2 items from the UX review (leave guard, save-only new provider, Codex bridge on the success screen, free step-jump, field-level credential errors and heading focus, model filter and on-demand protocol overrides, toast stack, Codex delete dialog parity, shared ManagerCard, keyboard row menu, 12px CJK floor, bounded Codex context window, key show/hide).
- Verification: every item has a browser assertion in `tests/model-deletion-ui.test.mjs`, run against `server.mjs` with `PI_PROVIDER_MANAGER_SERVE_UI=1` on isolated `PI_CODING_AGENT_DIR` / `isolatedCodexDir` (not `?demo=1`). Full local run with 0 skips: `test:ui` 25/25, `test:server` 77/77 (incl. `draftSignature` unit tests), `test:codex` 71/71, `test:codex-real` 5/5, `test:pi-real` 2/2, `test:prompts` 11/11, `test:sites` 4/4, `test:pi-update` 8/8, `test:launcher` 8/8, `test:release` 1/1, plus `build`. The two-theme WCAG-AA sweep and a new both-theme CJK-size sweep pass.
- Not re-measured here: static screenshots in `qa/` were not regenerated this round.

## Compatibility evidence carried forward

- **Pi, 2026-09-23:** Pi `0.87.1` was installed in a temporary location and validated before advancing the declared baseline. The real-Pi header suite passed 2/2; server, Sites, build, and production-browser checks are recorded in the history below.
- **Codex, 2026-09-12:** the `0.154.0` triage checked Responses-only protocol support, required provider `name`, ignored unknown fields, credential selection, reasoning-effort preservation, and the profile migration boundary. The interactive TUI was not exercised.
- **Codex, 2026-09-24:** the v0.4.7 candidate ran the real suite against `0.156.1` (5/5, 0 skips). `doctor` may report an existing deprecated setting as a warning while still loading the config. The preservation check now compares that warning before/after saving and rejects a new warning. This test evidence did not advance the declared `codexValidatedVersion` baseline. See the [v0.4.7 changelog](CHANGELOG.md#047---2026-09-24).
- **Pi User-Agent, 2026-09-16:** real Pi `0.85.1` sent 20 requests to a loopback gateway across the four supported APIs; literal, external, absent, model override, and clear behavior were exercised. This is dated wire evidence, not a claim about a live provider today.
- **Pi `anthropic-beta`, 2026-09-18:** real Pi `0.85.1` proved that a model override replaces the derived beta list, its sibling retains the automatic list, clearing restores it, and a `[1M]` model ID stays unchanged. `test:pi-real` carries the regression check.
- **Pi discovery, 2026-09-18:** live relay checks led to the same-origin path rule. Paths outside the API base prefix are accepted on that origin; off-origin paths are refused. The historical relay results do not promise current gateway availability or inference support.

## Limits of the recorded evidence

These limits were carried forward from the earlier QA records. They are not new test results.

- Interactive `/model` inside Pi and Codex's interactive TUI are not covered by the recorded runs. Pi CLI evidence comes from `--list-models` and the loopback wire tests; Codex CLI evidence comes from `codex doctor` and `codex exec`.
- A model-defined `Custom(String)` reasoning effort has never been obtained from a real model — the invented `"turbo"` is a stand-in for the shape the parser accepts, not proof that a model emits one.
- A manager actually hosted on Windows has never driven `POST /api/update/apply`. The Windows archive branches ran on Windows as a library against the published assets, with the bytes served from disk, because Windows Node cannot reach GitHub's object storage on that host.
- No archive install has ever upgraded twice in a row, so the existing-sibling refusal has only ever been met in unit tests.
- Pi has never been installed on the Windows side of the development machine, so Windows `pi` detection has only ever answered `unknown`.
- The archive's Windows download mark was written by hand, not produced by a real browser download.
- The original V1.1 manual browser scenarios were exercised on 2026-08-18. Later automated and manual checks cover the cases explicitly recorded above; they do not establish that every visual detail has been reaccepted.

## Verification history

Historical run summaries are retained below. Full narratives are in the linked snapshot.
The blocked Pi `0.84.4` run was completed by its dated successor; no blanket acceptance is inferred.

| Date | Manager | What was exercised | Result |
|---|---|---|---|
| 2026-08-19 | 0.1.x | Model deletion protection: persisted IDs read-only, armed-delete geometry stable at 85px, 撤销, 420px viewport | passed |
| 2026-08-19 | 0.1.x | Provider deletion: named dialog, Cancel focus, credential retention default, replacement validation server-side | passed |
| 2026-08-21 | 0.2.x | Codex `0.149.0` real binary: generated config loaded, adoption, byte-exact preservation, project-local config shadows nothing, two launcher defects found | passed |
| 2026-08-26 | 0.3.3 | Pi `0.84.3` vs `0.84.2`: byte-identical rows; BOM tolerance found and fixed on the manager side; auth.json chmod note | passed |
| 2026-08-26 | 0.3.4 | Stale version reporting: live detection, manifest-move assertions in payload and rendered card, PowerShell launcher reuse, Windows `.cmd` shim | passed |
| 2026-08-26 | 0.3.5 | Restart handover: both outcomes; stdio-hang rule found by a hang; archive run on Windows; `Unblock-File` guidance against a real mark | passed |
| 2026-08-26 | 0.3.5 | Update check/apply: real-API check by hand, all three refusal reasons, stale-bundle guard, browser assertions on the control's promise | passed |
| 2026-08-26 | 0.3.6 | Upgrade end to end on a real checkout; Windows archive branch against the real `v0.3.5` release | passed |
| 2026-08-26 | 0.3.6 | Archive install self-upgraded through the endpoints; blocked fast-forward staged against the real remote | passed |
| 2026-08-29 | 0.3.7 | Sidecar verification on the real `v0.3.7` release; three refusals each left nothing on disk | passed |
| 2026-08-29 | 0.3.7 | Pi `0.84.4` triage: fixture extended with the four new settings keys; step 8 blocked (fetch refused), baseline held | blocked |
| 2026-08-31 | 0.3.7 | Pi `0.84.4` step 8 on the release itself; byte-identical row against the `0.84.3` control | passed |
| 2026-08-31 | 0.3.7 | Windows archive verifier on Windows: `OpenRead`/`Expand-Archive` on the published zip, two refusals, bytes from disk (`ECONNRESET`) | passed |
| 2026-08-31 | 0.3.8 | Codex `0.151.0` triage: four invariants unchanged; the reasoning-effort rewrite defect found and fixed | passed |
| 2026-09-18 | 0.4.0 | Anthropic beta on the wire, real Pi `0.85.1` against a loopback gateway: the override sent alone, its sibling keeping the derived list, a `[1M]` id as-is, clearing restoring the derived list | passed |
| 2026-09-18 | 0.4.0 | Model discovery against six configured relays; the listing-path boundary exercised on the live server; the dialog's fit measured at 1280×600 | passed |
| 2026-09-20 | 0.4.0+unreleased | Pi baseline moved 0.85.1 → 0.86.1: no config/provider/settings/thinking-level change upstream; `npm test` 185 pass, 0 skipped, real Pi `0.86.1` and real Codex binary suites included; 获取模型 TLS-against-HTTP message translated and pinned | passed |
| 2026-09-22 | 0.4.3+unreleased | Pi baseline moved 0.86.1 → 0.87.0: the four API identifiers and seven thinking levels (off/minimal/low/medium/high/xhigh/max) unchanged upstream, no new token; `npm test` 188 pass, 0 skipped, real Pi `0.87.0` + real Codex `0.154.0` + LiteLLM `1.72.0`; `test:pi-real` confirms the anthropic-beta replace-not-append behaviour still holds on the wire | passed |
| 2026-09-28 | 0.4.8 | Provider rename preserves configuration, credential, and provider-keyed settings references on both targets; occupied targets refused in the wizard and server; a running Codex bridge relabelled without signalling; `npm test` 224 pass, 0 skipped (browser 29, real Codex 5, real Pi 2) | passed |
| 2026-09-23 | 0.4.5 | Pi baseline moved 0.87.0 → 0.87.1 (patch): validated against a temp-installed real Pi `0.87.1` without touching the global 0.87.0 — `test:pi-real` 2/2 (override sent alone; sibling keeps Pi's derived list incl. `interleaved-thinking-2025-05-14`; replace-not-append holds), `test:server` 32/32 (unknown-field preservation), `test:sites` 4/4, `build` ok, browser UI 15/15 both themes incl. WCAG-AA audit; no config/provider/settings/thinking-level/API-identifier change observed. Same release carries a two-theme visual refresh (L2 cool-neutral light, M2 monochrome dark, Linear-aligned), Codex bulk delete, and the advanced config-JSON editor | passed |
