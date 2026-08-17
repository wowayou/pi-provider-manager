# Changelog

## 0.1.1 - 2026-08-17

- Replaced the placeholder Settings action with a real Pi settings and compatibility screen.
- Added a post-save success screen with the exact Pi model command and `/model` verification steps.
- Added sticky, internally scrollable model catalogs and bulk model-ID import.
- Added warnings for model IDs that may incorrectly encode thinking levels.
- Preserved unknown provider, model, compatibility, and settings fields across edits.
- Added installed Pi version detection and compatibility policy.
- Added open-source readiness documentation and CI.

## 0.1.0 - 2026-08-17

- Initial local provider/model manager.
- Added secret-safe credential handling and atomic config writes.
- Added per-model API overrides and Playwright-verified three-step setup flow.
