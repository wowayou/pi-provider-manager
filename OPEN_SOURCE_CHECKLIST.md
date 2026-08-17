# Open-source Publication Checklist

## Required before the first public push

- [ ] Choose a license. MIT is the simplest default; Apache-2.0 adds an explicit patent grant.
- [ ] Choose the final GitHub owner and repository name.
- [ ] Review Git author name and email in existing commits.
- [ ] Confirm all screenshots use generic paths such as `~/.pi/agent`.
- [ ] Create a clean squashed public history. Early local QA commits contained a machine-specific home path; do not push the existing local history directly.
- [ ] Run a secret scan over the full Git history.
- [ ] Confirm no real provider keys, private exports, or account-specific URLs exist.
- [ ] Enable GitHub Private Vulnerability Reporting.
- [ ] Enable branch protection and required CI checks.
- [ ] Add repository topics such as `pi`, `pi-agent`, `model-manager`, `api-gateway`, and `local-first`.

## Recommended

- [ ] Add release archives for Linux/WSL and Windows launchers.
- [ ] Add issue templates for bugs, Pi compatibility reports, and provider schema requests.
- [ ] Add a redacted CC-Switch/CSV fixture before implementing import.
- [ ] Document the supported Pi version in every release.

## Explicitly not automated

- License selection
- Public GitHub repository creation
- Public push
- Publishing a package or binary

These actions require an explicit owner decision.
