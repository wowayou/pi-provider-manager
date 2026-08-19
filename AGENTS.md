# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Selected Product Direction

- Use the beginner-friendly three-step flow from visual option 2 as the overall framework.
- Combine the provider/model master-detail clarity from visual option 3, especially the multi-model table and default-model selection.
- Keep compatibility flags collapsed and clearly labeled as normally unnecessary.
- Never return an existing API key to the browser. The UI may show only whether a credential is configured.
- The normal user should be able to finish setup without knowing context limits, cache settings, strict tools, or adaptive-thinking terminology.
- Treat a provider as an API gateway/router similar to OpenRouter: one Base URL and credential can contain many upstream model families.
- Keep a default wire protocol at provider level, while allowing an advanced per-model protocol override for gateways that expose mixed APIs.
- Settings must be a real screen, not a placeholder. It owns Pi defaults, thinking level, transport, thinking-block visibility, and compatibility status.
- After saving, show a dedicated success/next-step screen with the exact Pi model command and `/model` guidance; do not leave the user at the bottom of the edit form.
- Treat Pi as provider-scoped configuration plus model-centric runtime selection. Preserve unknown provider/model/settings fields to reduce breakage across Pi upgrades.
- Keep Pi update detection in repository maintenance automation. It may compare stable release metadata and open a reminder, but must not add a Pi runtime dependency, make application startup depend on upstream availability, or advance `piValidatedVersion` without manual validation.
- Keep `models.json` and `settings.json` consistent by construction. A save that would leave `settings.defaultModel` pointing at a model the submitted list no longer contains is refused by the server; the client cannot be the only thing standing between the two files, because a stale tab or a direct API call reaches the same endpoint.
- Treat a persisted model ID as storage identity, not as an ordinary editable label. It is read-only in the form; replacing it means adding the new ID and deleting the old row through the armed, reversible removal flow. Reject identity drift before saving, and never silently choose the first named model when no default radio is selected.
- Optimize long model catalogs with a sticky header, internal scrolling, compact rows, and bulk model-ID import.
- Public screenshots and documentation must not expose machine-specific home paths or credentials.

## Interaction and UI Conventions

- Typeset every machine literal in the monospace `--mono` face: provider IDs, base URLs, model IDs, token counts, thinking levels, config paths, versions, and the `pi --model` command. Prose stays in Inter. This is the product's visual signature, so do not mix the two roles.
- Use one focus treatment app-wide: a 2px `--orange` `:focus-visible` outline with 2px offset, and the `--ring` box-shadow on text fields. Never remove focus styling from an interactive element.
- All motion uses the `--fast` / `--base` / `--ease` tokens and must degrade under `prefers-reduced-motion`; only progress indicators keep animating there.
- Feedback must be truthful: a control may only show a success state after the underlying action actually succeeded. Clipboard writes can fail, so the copy control falls back to selecting the command and reports the failure in the error toast tone.
- Destructive row actions arm on first click and delete on the second; they never delete on a single click and never open a dialog. Arming is where the consequence is stated, and every removal offers 撤销 in its toast. The row Pi's default currently points at is marked from `state.settings`, never from the form's own default radio, so the mark stays on the live model when the radio is moved.
- A destructive action that is temporarily unavailable must remain visible and focusable. Activating it explains the blocking invariant and offers the shortest corrective action; never communicate the restriction only through a disabled control, low opacity, or a hover-only tooltip.
- In the model catalog, primary controls share one 42px top-aligned rail and every row keeps stable geometry while badges, protocol notes, or armed-delete feedback change. Put the deletion consequence in the shared toast rather than expanding one row; render every model ID in that feedback with the monospace face.
- Keep repeated per-row helpers out of the model table. Bulk affordances belong in the section header so rows stay compact and long catalogs stay scannable.
- Do not hide primary navigation at narrow widths. The provider list becomes a horizontally scrollable rail below 860px rather than disappearing.
- Every colour lives in a token on `:root`. Do not write a literal hex value in a rule; add or reuse a semantic token instead, otherwise dark mode silently breaks.
- Dark is the same design at a second set of token values, never a second design. Layout, spacing, type, and structure are identical; only the palette differs. Orange fills keep their brand value, while orange used as text lightens to `--orange-dark` so it stays legible on dark panels.
- Theme has three states: `system` (default), `light`, and `dark`. The resolved value is written to `document.documentElement.dataset.theme` by a pre-paint inline script in `index.html`, so the CSS only needs a `[data-theme="dark"]` block and the app never flashes the wrong theme. Keep that script in sync with the `ppm-theme` localStorage key.
- Set `color-scheme` per theme so native selects, scrollbars, and search fields follow. Overlays step one surface lighter in dark via `--surface-overlay`.
- Radios and checkboxes are drawn from our own tokens with `appearance: none` on the native input, so the two themes match. Keep the native input: it carries keyboard support, radio grouping, and form semantics that a `div` would have to reimplement.
- Never count or accumulate inside a `setState` updater. React may run it late, twice under StrictMode, or skip its eager path entirely, so anything read afterwards is unreliable. Derive counts from the currently rendered value before dispatching the update.
- Blue link styling means an informational disclosure and nothing else. Anything that writes to the form is a button, and anything that overwrites values the user may have typed carries an undo action in its toast.
- A field must not accept keystrokes its parser will reject. Mark invalid drafts with `aria-invalid` while typing rather than reverting silently on blur, and bound numeric input on both ends so a typo cannot become a plausible-looking value.
- Treat a key that is absent from the config file as unwritten, not as saved. Filling a default in the UI and then reporting it as already persisted leaves the user unable to write it.

## Handoff — current state as of 2026-08-19

Read this section first, then `design-qa.md` for how the UI got to its current
form and what has already been reviewed.

**Where things are.** The latest published release is `v0.1.7`; releases
`v0.1.2` through `v0.1.7` are tagged and published. `main` is ahead of that tag
with the work listed under `CHANGELOG.md`'s `Unreleased` section: structured
issue forms, the architecture and compatibility documentation, decoupled Pi
update monitoring, dated real-Pi evidence, Node 24-based GitHub Actions, and
deletion protection for the model Pi is currently using (PR #27).
`package.json.version` intentionally remains `0.1.7` until the next release.
Every checklist item required before the first public push is done. The source
of truth for remaining publication work and its prerequisites is
`OPEN_SOURCE_CHECKLIST.md`; do not copy its item count here.

**Use one project vocabulary and one source for live facts.** The vocabulary and
documentation ownership table are in `docs/architecture.md`. In particular, a
provider is an API gateway entry that may contain several upstream model
families, `models-store.json` is never read or written, GitHub Releases define
what shipped, and `main` may carry unreleased work. Keep the English and Chinese
READMEs aligned.

**How to land changes.** `main` is protected and the rules apply to
administrators, so there is no direct push. Open a branch, open a pull request,
let the required `ci-passed` check go green, then merge with a rebase to keep
history linear. `ci-passed` is a single aggregate job that depends on the whole
Node matrix and the production-browser UI job; require that check and never the
individual implementation jobs, because a required check naming a Node version
or UI job disappears when the workflow changes and then blocks every pull request
with no visible cause.

**Model deletion and identity replacement are guarded, and provider deletion
does not exist yet.** Saving a provider replaces its stored model list wholesale,
so removing a row also discards that model's compatibility flags and the unknown
fields we promise to preserve. Persisted model IDs are therefore read-only in the
form: replacement is add the new ID, then delete the old row through the armed,
reversible flow. The draft rejects identity drift and refuses to invent a default
when no named row is selected. `saveProvider` separately refuses to drop the model
`settings.json` points at unless the same request names a replacement. The model
table marks the live default from `state.settings`; arming any delete explains its
consequence in a monospace-aware toast without moving the fixed row controls, and
the completed removal offers 撤销. There is no provider-level delete at all:
the API only exposes `POST /api/providers` and `POST /api/settings`. If one is
added, it needs the same invariant plus removal of the provider's `auth.json`
entry, and the credential is the part that is not recoverable by re-typing a
model ID.

**Verify against the shape the product actually ships in.** Two shipped bugs
came from verifying somewhere the product does not run. An indicator for
unwritten settings was only ever exercised in demo mode, where the fixture omits
keys, while the real server normalizes every key before the client sees it, so
the branch could never fire. The pre-paint theme script was only checked against
`vite dev`, which sends no CSP, while the packaged server sends one that blocked
the script outright. Anything touching the served page or the API has to be run
against `server.mjs` with `PI_PROVIDER_MANAGER_SERVE_UI=1`, not only against the
dev server or `?demo=1`.

**Exercise the boundary, do not read it.** The most serious defect found so far
was a cross-origin write that let any visited page copy a stored API key onto an
attacker-controlled gateway. It had been present since the first public commit
and is invisible on inspection; it showed up only once a real cross-origin
request was actually sent. The same applies to header handling: `fetch()`
silently refuses to set `Host`, so rebinding checks need a raw `http.request`.

**Every release states the Pi version it was validated against.** The number
lives once, as `piValidatedVersion` in `package.json`; the server reads it and
Settings shows it beside the Pi version detected on the machine, saying plainly
when the two differ. Release notes quote it. The full procedure after a Pi
upgrade is in `docs/compatibility.md`.

**Latest real-Pi evidence.** On 2026-08-18, the production-shaped server wrote a
fake provider into an isolated `PI_CODING_AGENT_DIR`, and Pi `0.84.2` listed its
model with the expected context, output, thinking, and image capabilities. No
real endpoint, credential, or normal home config was used. The dated record is
in `design-qa.md`; the live baseline remains only in `package.json`.

**Pi updates are monitored outside the product runtime.** A daily/manual
workflow compares `piValidatedVersion` with the latest stable
`earendil-works/pi` GitHub Release and maintains one owner-assigned compatibility
issue when review is needed. It does not import Pi code, run during application
startup or builds, or update the baseline. Current behavior and triage ownership
are documented in `docs/compatibility.md`.

**Open items.**

- CVE identifiers were requested for both advisories and accepted with HTTP 202,
  but not yet assigned. When they arrive, add them to the advisories and to the
  `v0.1.4` release notes.
- The `local-history` branch holds pre-publication history and may exist in an
  older checkout. It must never be pushed; the GitHub remote must not contain it.
- Remaining Recommended publication tasks and their authorization/sample
  prerequisites are tracked only in `OPEN_SOURCE_CHECKLIST.md`.

**Quick check that everything is where this section says.**

```bash
git -C . log --oneline -1 && node -e "const p=require('./package.json'); console.log({version:p.version, piValidatedVersion:p.piValidatedVersion})"
npm ci && npm run build && npm run test:server && npm run test:ui && npm run test:sites && npm run test:pi-update
npm run check:pi-update
gh pr list --state open
gh issue list --state open
gh api repos/wowayou/pi-provider-manager/branches --jq '.[].name'
gh api repos/wowayou/pi-provider-manager/security-advisories --jq '.[] | "\(.ghsa_id) \(.cve_id // "pending")"'
```

The working directory differs per machine. Trust the git remote,
`wowayou/pi-provider-manager`, rather than any absolute path recorded in an old
handoff or shell history.
