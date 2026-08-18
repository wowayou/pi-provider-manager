# Open-source Publication Checklist

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

- [ ] Add release archives for Linux/WSL and Windows launchers. Publishing packages or binaries requires explicit owner authorization; do not infer it from ordinary maintenance work.
- [x] Add issue templates for bugs, Pi compatibility reports, and provider schema requests.
- [ ] Add a redacted CC-Switch/CSV fixture before implementing import. Start from a real sample supplied or approved for publication; do not invent a format or sanitize private data without review.
- [x] Document the supported Pi version in every release. Declared once as `piValidatedVersion` in `package.json`, shown in Settings beside the detected version, and stated in the notes of every published release.

## Owner-authorized for the first publication

- MIT license
- Public repository creation at `wowayou/pi-provider-manager`
- Initial public push

Publishing packages or binaries remains out of scope until explicitly requested. The unchecked archive item above is a recommendation, not standing publication authorization.
