# Completed First-publication Checklist

This is the completed publication record, not a checklist for the next release.
For release packaging, see [docs/release-install.md](docs/release-install.md);
for compatibility validation, see [docs/compatibility.md](docs/compatibility.md).

## Required before the first public push

- [x] Choose a license: MIT.
- [x] Choose the final GitHub owner and repository name: `wowayou/pi-provider-manager`.
- [x] Use a GitHub noreply identity for the clean public commit.
- [x] Confirm all screenshots use generic paths such as `~/.pi/agent`.
- [x] Create a clean single-commit public history; retain early local QA history only on the local `local-history` branch.
- [x] Run a secret scan over the public candidate tree.
- [x] Confirm no real provider keys, private exports, or account-specific URLs exist.
- [x] Enable GitHub Private Vulnerability Reporting.
- [x] Enable branch protection and required CI checks.
- [x] Add repository topics: `pi`, `pi-agent`, `model-manager`, `api-gateway`, `local-first`.

## Also enabled after the first publication

- [x] Dependabot alerts and Dependabot security updates.
- [x] Published security advisories for the vulnerabilities fixed in 0.1.4.

## Recommended

- [x] Add release archives for Linux/WSL and Windows launchers. The owner explicitly authorized this final packaging pass; published releases build the archives from the tagged source.
- [x] Add issue templates for bugs, Pi compatibility reports, and provider schema requests.
- [x] Retire the CC-Switch/CSV import plan. CC Switch now manages Pi's native `models.json` directly, no approved fixture was supplied, and this project has entered focused maintenance mode.
- [x] Document the supported Pi version in every release. Declared once as `piValidatedVersion` in `package.json`, shown in Settings beside the detected version, and stated in the notes of every published release.

## Owner-authorized for the first publication

- MIT license
- Public repository creation at `wowayou/pi-provider-manager`
- Initial public push

Release archives were subsequently authorized and are published from release tags.
Completion of this checklist does not authorize a new release; follow the owner’s
release instruction and the protected-branch workflow in [CONTRIBUTING.md](CONTRIBUTING.md).
