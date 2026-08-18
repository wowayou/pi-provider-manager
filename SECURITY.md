# Security Policy

## Scope

Pi Provider Manager handles local API credentials and edits Pi configuration files. Security reports involving credential disclosure, unsafe network exposure, path traversal, cross-origin writes, or config corruption are high priority.

The browser is not trusted merely because the API listens on localhost: any page a user visits can attempt requests to loopback, and DNS rebinding can make an attacker-controlled hostname resolve there. `server.mjs` is therefore an authorization boundary as well as a local file editor.

## Safe defaults

- The backend binds to `127.0.0.1` only.
- Every API request requires `127.0.0.1`, `localhost`, or `[::1]` in `Host`, on the actual service port, to block DNS rebinding.
- Every write requires `Content-Type: application/json`. A foreign page cannot send that as a CORS simple request, and the server does not enable CORS or answer preflight.
- Existing API keys are never returned by API responses.
- Request bodies are capped at 1 MB, and provider IDs, credential migration sources, URLs, protocols, models, and settings are validated before use.
- Config writes use private permissions where supported.
- Provider updates validate temporary JSON files and roll back multi-file failures.
- `models-store.json` is never read or written.

Do not relax the `Host` or JSON requirements to accommodate a new client without replacing them with an equally strong, tested authorization design. Security regression tests in `tests/server.test.mjs` must exercise real cross-origin-style and raw-`Host` requests; browser `fetch()` cannot set `Host` and is not a valid DNS-rebinding test.

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
- Processes or users that already have permission to read the same Pi config directory
- A compromised local operating-system account or browser
- Risks caused by intentionally binding a modified fork to a public interface
