# Design QA

- Product version: `0.1.1`
- Source visual truth: `design-reference.png` plus user acceptance screenshots for the settings, long-model-list, and post-save problems
- Model editor screenshot: `qa/pi-provider-manager-v11-models.png`
- Settings screenshot: `qa/pi-provider-manager-v11-settings.png`
- Success/next-step screenshot: `qa/pi-provider-manager-v11-success.png`
- Responsive evidence: `qa/pi-provider-manager-v11-responsive-900.png`
- Primary viewport: `1487 x 1058 CSS px`, device scale factor `1`
- State: demo mode with generic paths and fake credentials only

**Findings**

- No actionable P0/P1/P2 differences remain for the V1.1 scope.
- [P3] Some provider marks use the closest available Phosphor icon instead of licensed official provider assets.
  - Impact: minor brand-fidelity difference; model recognition and interaction are unaffected.
  - Follow-up: add official marks only when their license and source files are suitable for redistribution.

**Acceptance Problems Addressed**

1. Placeholder Settings action
   - Earlier evidence: Settings only exposed the config path and changed no Pi behavior.
   - Fix: real settings screen for default provider/model/thinking, transport, thinking-block visibility, Pi version, manager version, config path, and compatibility policy.
2. Unclear post-save state
   - Earlier evidence: the user remained at the bottom of a long form with only a toast.
   - Fix: dedicated success screen with the exact `pi --model provider/model:thinking` command, `/model` guidance, provider verification, upstream error explanation, and clear next actions.
3. Long model catalog and page scrolling
   - Earlier evidence: several model rows plus advanced settings pushed primary actions below the fold.
   - Fix: sticky model header, internal model-list scrolling, compact rows, bulk model-ID import, and responsive local table scrolling.
4. Thinking levels encoded as model IDs
   - Earlier evidence: model IDs ending in `-max` and `-xhigh` appeared alongside Pi's separate thinking-level status.
   - Fix: warning when IDs look like thinking aliases, with guidance to use the reasoning capability field and Shift+Tab unless the gateway truly exposes those IDs.
5. Pi upgrade data-loss risk
   - Earlier behavior: editing a model rebuilt the full known object and could drop future/unknown metadata.
   - Fix: preserve unknown provider, model, model-compat, and settings fields while updating known fields; automated tests cover future fields.

**Required Fidelity Surfaces**

- Fonts and typography: passed. Chinese and Latin hierarchy, wrapping, labels, commands, and status copy are legible without target-viewport truncation.
- Spacing and layout rhythm: passed. Main editor stays within the viewport; long catalogs scroll internally; Settings and Success pages use coherent desktop spacing.
- Colors and visual tokens: passed. Orange actions, green success states, blue help links, warnings, borders, and neutral surfaces are consistent.
- Image quality and asset fidelity: passed. The Pi mark comes from the selected source; standard UI icons use Phosphor rather than handcrafted assets.
- Copy and content: passed. Provider/model/thinking semantics, secret boundary, save handoff, upstream error distinction, and compatibility wording match actual Pi behavior.

**Primary Interactions Tested**

- Open real Settings and modify transport/thinking visibility in demo mode.
- Navigate all three provider setup steps.
- Choose credential migration from a provider dropdown.
- Bulk-import several model IDs and ignore duplicates.
- Select a default model and set a model-level API override.
- Save and reach the dedicated success screen.
- Copy the exact Pi model command.
- Return from Success to the saved provider detail.
- Check 900px layout for page-level horizontal overflow.
- Check browser console and page errors: none.
- Backend isolation: static UI serving, secret non-disclosure, router-style multi-model writes, per-model API override, credential migration, settings writes, rollback, and unknown-field preservation passed.

**Compatibility Evidence**

- Installed Pi version detected as `0.84.2`.
- Manager version reported as `0.1.1`.
- Real state shows providers `any-codex` and `sota`, default `sota/claude-opus-5:high`, with no key field in API responses.
- Single-process production launcher remains available after the launching shell exits.

**Implementation Checklist**

- [x] Real settings page
- [x] Dedicated post-save success flow
- [x] Sticky/internal-scrolling model catalog
- [x] Bulk model-ID import
- [x] Thinking-alias warning
- [x] Unknown-field preservation
- [x] Installed Pi version detection
- [x] Persistent single-process WSL launcher
- [x] Production build
- [x] Backend and Sites tests
- [x] Playwright desktop, settings, success, interaction, console, and responsive checks

**Follow-up Polish**

- Add licensed provider marks when available.
- Add CSV/CC-Switch import only after a redacted fixture defines the source schema.

final result: passed
