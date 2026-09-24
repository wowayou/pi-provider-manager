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
| Sites, releases, launchers | `test:sites`, `test:release`, `test:launcher`; Windows execution is covered by CI |
| All local suites | `npm test`; inspect complete totals and skipped count |

Manual page/API checks use `PI_PROVIDER_MANAGER_SERVE_UI=1` with separate temporary
`PI_CODING_AGENT_DIR` and `PI_PROVIDER_MANAGER_CODEX_DIR` directories. Vite and
`?demo=1` supplement these checks; they do not prove the production headers or API.
See [AGENTS.md](AGENTS.md) for the detached-runner workaround if a controlling
terminal stops a browser suite before it prints a complete summary.

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
| 2026-09-23 | 0.4.5 | Pi baseline moved 0.87.0 → 0.87.1 (patch): validated against a temp-installed real Pi `0.87.1` without touching the global 0.87.0 — `test:pi-real` 2/2 (override sent alone; sibling keeps Pi's derived list incl. `interleaved-thinking-2025-05-14`; replace-not-append holds), `test:server` 32/32 (unknown-field preservation), `test:sites` 4/4, `build` ok, browser UI 15/15 both themes incl. WCAG-AA audit; no config/provider/settings/thinking-level/API-identifier change observed. Same release carries a two-theme visual refresh (L2 cool-neutral light, M2 monochrome dark, Linear-aligned), Codex bulk delete, and the advanced config-JSON editor | passed |
