# Security Policy

## Scope

Pi Provider Manager handles local API credentials and edits Pi configuration files. Security reports involving credential disclosure, unsafe network exposure, path traversal, cross-origin writes, or config corruption are high priority.

## Safe defaults

- The backend binds to `127.0.0.1` only.
- Existing API keys are never returned by API responses.
- Config writes use private permissions where supported.
- Provider updates validate temporary JSON files and roll back multi-file failures.
- `models-store.json` is never modified.

## Reporting a vulnerability

Use GitHub Private Vulnerability Reporting:
<https://github.com/wowayou/pi-provider-manager/security/advisories/new>

Do not include any of the following in a public issue:

- API keys or tokens
- `auth.json`
- private provider exports
- private Base URLs containing account identifiers
- screenshots that show credentials

Use fake credentials and a temporary `PI_CODING_AGENT_DIR` for reproductions.

## Out of scope

- Upstream provider outages or rate limits
- Pi runtime defects unrelated to files written by this manager
- Risks caused by intentionally binding a modified fork to a public interface
