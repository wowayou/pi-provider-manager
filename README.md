# Pi Provider Manager

[简体中文](README.zh-CN.md)

A local model catalog and API gateway manager for **Pi and the Codex CLI**. It gives each agent's own config files a safe visual workflow without hiding or replacing their native configuration model.

A step-by-step usage manual, written for people using the tool rather than maintaining it, is in [docs/usage.zh-CN.md](docs/usage.zh-CN.md) (Simplified Chinese). It covers installation, both wizards, the managed bridge, every environment variable, and a troubleshooting table indexed by the exact text on screen.

## Why this exists

Pi is model-centric at runtime but provider-scoped in configuration:

- sessions select a concrete `provider/model`
- thinking level is independent from the model ID
- credentials and default wire protocol belong to the provider
- a provider can expose many models
- a model can override its provider's API when a gateway mixes protocols

Pi Provider Manager makes that relationship visible instead of forcing users to hand-edit three JSON files.

Codex has the opposite problem. Its configuration is small but unforgiving: one credential slot, one wire protocol it still accepts, and a TOML table where a single unrecognised key fails the whole thing. Switching gateways by hand means editing two files correctly every time, and keeping the key you are not currently using somewhere safe. The same three-step workflow now covers that too — see [Codex support](#codex-support).

## Highlights

- **Pi-native provider/model workflow** — model IDs, default thinking level, image capability, context/output limits, and per-model API overrides.
- **Router-first catalog management** — one OpenRouter-like gateway can contain models from many upstream vendors.
- **Secret-safe local boundary** — existing API keys are never returned to the browser; the backend binds to `127.0.0.1` only.
- **Validated atomic writes** — updates to `models.json`, `auth.json`, and `settings.json` use validated temporary files and rollback on failure.
- **Concurrent-edit protection** — every write carries an opaque revision; changes made by CC Switch, another tab, or a text editor cause a `409` instead of being overwritten by stale form data.
- **Guarded provider deletion** — removing a gateway names every affected model, deletes its credential by default with an option to retain it, and requires a valid replacement before deleting Pi's current default.
- **Forward-compatible edits** — unknown provider, model, and settings fields are preserved when known fields are updated.
- **Beginner save handoff** — after saving, the app gives the exact `pi --model provider/model:thinking` command and `/model` verification steps.
- **Large catalog UX** — sticky model header, internal scrolling, bulk model-ID import, and warnings when `-max`/`-xhigh` may be thinking levels rather than real model IDs.
- **Real Pi settings** — default provider/model/thinking, transport, thinking-block visibility, installed Pi version, and compatibility status.
- **Codex CLI support** — the same sidebar and three-step wizard manage `~/.codex/config.toml` and `auth.json`, switch the active gateway in one click, and preserve every comment and hand-written table in the file.
- **Chat-Completions-only upstreams** — Codex speaks only the Responses API, so the manager configures and supervises a local LiteLLM bridge for gateways that never implemented it. You install LiteLLM; it writes the config, wires Codex to the proxy, and starts or stops it.
- **No database lock-in** — Pi remains the source of truth; the app edits Pi's own documented files and never reads or writes `models-store.json`.

## Files managed

Pi:

- `~/.pi/agent/auth.json`
- `~/.pi/agent/models.json`
- `~/.pi/agent/settings.json`

`models-store.json` is outside the manager's scope and is never read or written.

Codex (`$CODEX_HOME`, default `~/.codex`):

- `config.toml` — only the manager's own `[model_providers.<id>]` table and the top-level model/reasoning keys. Comments, unrelated keys, and provider tables you wrote by hand are preserved byte for byte.
- `auth.json` — `auth_mode` and `OPENAI_API_KEY` for the active provider. Other keys, including a ChatGPT login, are preserved.
- `pi-provider-manager-store.json` — this manager's own provider store, `0600`. See [Codex support](#codex-support).
- `pi-provider-manager-litellm.yaml`, `pi-provider-manager-bridge.json`, `pi-provider-manager-bridge.log` — written only when a provider uses the managed bridge: LiteLLM's generated config, the proxy's runtime record, and its output.


## Codex support

Codex is shaped differently from Pi, and the design follows from three facts about it:

- It has exactly **one credential slot**: `auth.json` holds a single `OPENAI_API_KEY`.
- Since February 2026 it speaks **only the Responses API**. `wire_api = "chat"` was removed; writing it makes the whole `config.toml` fail to load.
- Its config is read **once at startup**. Switching providers affects newly started sessions; a `codex` process already running is unaffected.

### One table, switched in place

`config.toml` carries exactly one manager-owned provider table, so the file stays identical in shape to the snippet vendors publish:

```toml
model_provider = "custom"
model = "gpt-5.6-sol"
model_reasoning_effort = "high"

[model_providers.custom]
name = "PackyCode"
base_url = "https://api.packycode.com/v1"
wire_api = "responses"
requires_openai_auth = true
```

Switching providers rewrites that one table and swaps the key in `auth.json`. Because Codex has nowhere to keep an inactive provider, every other provider's base URL, model list, and key live in `pi-provider-manager-store.json` (`0600`, never returned to the browser). `config.toml` stays the truth for what Codex will do; the store is the truth for what else you have configured.

If the table on disk matches nothing in the store — a fresh install, or a hand edit — the **file wins**: it is adopted as a provider and labelled as adopted in the UI. Reading state never writes, so opening the page cannot disturb a working setup.

The table id is `custom` by default and configurable in settings. Codex's built-in ids (`openai`, `ollama`, `lmstudio`, the Bedrock pair) are refused.

### Switching model within a provider

The default model is written to `config.toml`. For the provider's other models, name one on the command line:

```bash
codex                              # the provider's default model
codex -m gpt-5.1-codex             # another model on the same provider
codex -m gpt-5.1-codex -c model_reasoning_effort="low"
```

This manager writes no `[profiles.*]` tables. Codex 0.149.0 treats profiles in `config.toml` as legacy and **refuses `--profile <name>` outright** while a matching table is present, so generating them broke the command they were meant to enable. Versions 0.2.0 and 0.2.1 did generate them; the next save removes exactly the ones they recorded, and a `[profiles.*]` you wrote yourself is left alone even if it shares the prefix.

Note that a bridged provider only serves the models you listed in the wizard — LiteLLM answers for those and nothing else, so `-m` with an unconfigured model fails at the bridge. Add it in the UI first.

### Global prompts

Both agents read their global instructions from the directory this manager already owns, so one screen serves both. Each file holds one document at a time; the alternatives live in the manager's own store, exactly as inactive providers do.

| Agent | File | Effect |
|---|---|---|
| Pi | `~/.pi/agent/AGENTS.md` | concatenated with the project's and parent directories' `AGENTS.md` |
| Pi | `~/.pi/agent/SYSTEM.md` | replaces the default system prompt entirely |
| Pi | `~/.pi/agent/APPEND_SYSTEM.md` | appended to the default system prompt |
| Codex | `$CODEX_HOME/AGENTS.md` | concatenated with the project's `AGENTS.md` |

A file that predates the manager is adopted rather than presented as absent, on the read path only — opening the screen never writes. Deleting the document that is currently in a file requires naming its replacement, the same rule as deleting a live provider.

Prompt text is returned to the browser, unlike a credential. That is deliberate: a document nobody can read back cannot be edited. Anything secret belongs in a credential, not in a prompt.

### Upstreams that only expose `/v1/chat/completions`

Codex cannot talk to these directly and no configuration can change that — a translation layer is required. The manager configures and supervises one for you; you only install it.

Debian and Ubuntu — including WSL — refuse a system-wide `pip install` under [PEP 668](https://peps.python.org/pep-0668/), so use `pipx` or a virtualenv:

```bash
pipx install 'litellm[proxy]'
# or
python3 -m venv ~/.local/litellm && ~/.local/litellm/bin/pip install 'litellm[proxy]'
```

Both land somewhere the manager already looks, so no further configuration is needed; the credentials step names the executable it picked.

**Install LiteLLM by itself.** Adding a version pin for anything else to that same command lets the resolver satisfy the pin by downgrading LiteLLM instead, and older releases have no Responses-to-Chat bridging at all — verified against `1.79.0`, which forwards `/v1/responses` straight to the upstream and gets a 404. This project is verified against `1.97.0`.

If `litellm --version` then prints a traceback instead of a version, downgrade FastAPI as a **separate** step:

```bash
pip install 'fastapi==0.140.6'
```

LiteLLM does not pin FastAPI tightly enough. FastAPI removed `get_flat_dependant` in `0.140.7`, and LiteLLM `1.97.0` still imports it, so anything from `0.140.7` up — including the current `0.141.1` — fails at import with `cannot import name 'get_flat_dependant'` while satisfying LiteLLM's own `fastapi>=0.136.3,<1.0`. `0.140.6` is the newest release that works; older ones such as `0.115.14` work too.

Then pick **上游只有 chat/completions** in step one and fill in your *upstream's* address and key. The manager does the rest:

- writes LiteLLM's `config.yaml` with `use_chat_completions_api: true` for each of your models
- points Codex at the local proxy (`base_url = "http://127.0.0.1:43210/v1"`, `requires_openai_auth = false`)
- starts and stops the proxy from the credentials step

The upstream key never enters either config file. It is stored in the manager's own `0600` store and passed to LiteLLM through `PPM_BRIDGE_UPSTREAM_KEY`, which is what LiteLLM's `api_key: os.environ/...` reference expects. The proxy is pinned to `127.0.0.1` — LiteLLM's own default is `0.0.0.0`, which would publish an unauthenticated proxy holding your key on every interface.

The proxy is started detached, so closing the manager does not cut Codex off. Stopping it only ever signals a process whose command line still names the manager's config file, because process ids get reused.

On a platform where the manager cannot prove a started process is still its own — anything without procfs, which includes native Windows — it will not adopt one. The config is still generated, and the credentials step shows the command to run by hand. Everything else about Codex, including a directly connected provider, is unaffected.

**This project still does not translate model traffic itself.** Writing a third-party config file and supervising a process is the same kind of work it already does for Pi and Codex; no request passes through the manager. The translation stays LiteLLM's to maintain, which matters because the part that keeps moving is Codex's side of the wire — reasoning items, encrypted reasoning content, tool-call shapes — and Codex ships weekly. [codex-relay](https://github.com/MetaFARS/codex-relay) and [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) are alternatives you can run yourself; point a normal provider at either instead of using the bridge. CLIProxyAPI serves its own Responses endpoint and takes a keyed Chat-Completions upstream under `openai-compatibility`, so from here it is an ordinary provider — the key you enter is the one from its own `api-keys` list, not your upstream's. Bind it yourself: its listener defaults to `host: ""` on port 8317, which is every interface, for the same reason this project pins LiteLLM to `127.0.0.1`.

### If Codex warns about "project-local config keys"

Codex also reads a `.codex/config.toml` from the working directory tree, and warns when one carries keys it will not honour there:

```
⚠ Ignored unsupported project-local config keys in <dir>/.codex/config.toml: model_provider, model_providers
```

This is about that directory's own file, not the one this manager edits. `model_provider` and `model_providers` are user-level only, which is exactly where the manager writes them — `$CODEX_HOME/config.toml`. The usual way to meet this warning is running `codex` from a home directory that happens to contain a `.codex/`, such as `/mnt/c/Users/<you>` under WSL when Codex is also installed on Windows. Run Codex from your project directory instead.

### What switching does and does not carry over

New sessions pick up the change cleanly. **Resuming an old session against a different provider does not work reliably**: Codex asks for `reasoning.encrypted_content` and replays it on later turns, and content encrypted by one provider is meaningless to another. This is Codex's design, not something a switching tool can work around. Finish a conversation on the provider that started it.

## Project status and CC Switch

This project is in maintenance mode. New work is limited to confirmed defects, security fixes, and Pi or Codex compatibility changes; it does not plan to match the broader feature set in [CC Switch](https://github.com/farion1231/cc-switch).

Codex support was added deliberately and stays narrow: providers, credentials, and the active selection. It does not add presets, model discovery, usage dashboards, or a traffic proxy.

CC Switch 3.20 added a comprehensive Pi integration for provider presets, model discovery, prompts, Skills, sessions, and usage. It deliberately does not read or write Pi's `auth.json`, `defaultProvider`, or `defaultModel`. Pi Provider Manager remains a smaller, database-free tool for that credential/default boundary, the three-file invariants around it, and the global instruction files beside them. Both can use the same Pi files, but a stale page must reload after another editor changes them.

## Install a release archive

Download the Linux/WSL or Windows archive from the [latest release](https://github.com/wowayou/pi-provider-manager/releases/latest). The archive already contains the built UI and the dependency-free server; only Node.js 18 or newer is required.

Linux or WSL:

```bash
tar -xzf pi-provider-manager-v*-linux-wsl.tar.gz
cd pi-provider-manager-v*
./bin/pi-provider-manager-ui
```

Windows PowerShell 7:

```powershell
Expand-Archive .\pi-provider-manager-v*-windows.zip -DestinationPath .\pi-provider-manager
cd .\pi-provider-manager\pi-provider-manager-v*
pwsh -File .\bin\pi-provider-manager.ps1
```

See `INSTALL.md` inside the archive for environment overrides and execution-policy guidance.

## Build from source on Linux or WSL

```bash
git clone https://github.com/wowayou/pi-provider-manager.git ~/pi-provider-manager-ui
cd ~/pi-provider-manager-ui
npm run setup
~/.pi/agent/bin/pi-provider-manager-ui
```

`npm run setup` is `npm ci`, `npm run build`, and `npm run install:launcher` in that
order. Run the three separately if you want to see them individually; the result is
the same.

`npm run install:launcher` takes no arguments and no path, which is the point: the
two-operand `install` command this replaced failed with GNU install's own
"missing destination file operand" when run from anywhere but the checkout, and
that message names neither this project nor the mistake.

What it installs is a shim, not a copy. A copy stops matching the checkout the
moment you pull, and a stale launcher does not fail — a pre-0.3.0 one starts, and
silently stops handing the Codex directory and the LiteLLM path to the server, so
the managed bridge breaks far from the cause. The shim execs whatever is in the
checkout, so `git pull` is the whole upgrade. If you copied a launcher by hand
before, the launcher itself now compares its content with the checkout's and says
so before starting; re-run `npm run install:launcher` to replace it. Anything at
that path that is not one of ours is left alone unless you pass `--force`.

Release archives do not need this: they are replaced wholesale on upgrade, so a
shim pointing into one would break at the next release. Run `./bin/pi-provider-manager-ui`
from the extracted directory instead.

The launcher reuses an existing manager instance or selects a free port from `43127-43146`. Under WSL it opens the Windows default browser; otherwise it uses an available WSL/PowerShell browser bridge or prints the local URL. It verifies `/api/state` before reuse, so another app on the same port is never mistaken for Pi Provider Manager.

If the repository is cloned elsewhere, `npm run install:launcher` records that path in the shim, so nothing else is needed. Without it, set `PI_PROVIDER_MANAGER_PROJECT_DIR` to the absolute path, or run `./bin/pi-provider-manager-ui` from inside the checkout. When the launcher cannot find a checkout it now prints all four places it looked and what each resolved to.

### Runtime discovery and overrides

| Variable | Auto-detected default | Purpose |
|---|---|---|
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi config directory used for auth, models, and settings |
| `CODEX_HOME` | `~/.codex` | Codex config directory, following Codex's own precedence |
| `PI_PROVIDER_MANAGER_CODEX_DIR` | value of `CODEX_HOME` | Codex directory override for this manager only |
| `PI_PROVIDER_MANAGER_LITELLM` | first of `~/.local/bin/litellm`, `~/.local/litellm/bin/litellm`, a few sibling virtualenv paths, then `PATH` | Executable used to start the managed bridge. Only needed when LiteLLM is somewhere unusual; the credentials step shows which one was picked. |
| `PI_PROVIDER_MANAGER_PROJECT_DIR` | current matching repo, then `~/pi-provider-manager-ui` | Project/build location |
| `PI_PROVIDER_MANAGER_PORT` | auto-select from `43127-43146` | Strict local loopback port override |
| `PI_PROVIDER_MANAGER_NODE` | current `node` executable | Node binary used by the detached service |
| `PI_PROVIDER_MANAGER_OPEN_BROWSER` | `1` | Set to `0` to start without opening a browser |
| `WSL_DISTRO_NAME` | supplied automatically by WSL | Distribution used by the detached Windows launcher |

The service host intentionally stays fixed at `127.0.0.1`; it is not configurable to a public/LAN address.

The dedicated port range also avoids stale Service Workers and cached apps commonly left on Vite's default `4173` origin.

## Security boundary

- The API binds to `127.0.0.1` only.
- API requests require an allowlisted loopback `Host`; writes additionally require `application/json`, so a foreign page cannot use a simple cross-origin request to mutate configuration.
- Existing API keys are never serialized into browser responses.
- New keys are accepted only on save and written to `auth.json` with private permissions.
- Backend tests use temporary directories and fake keys.
- Do not attach `auth.json`, API keys, or private provider exports to GitHub issues.

See [SECURITY.md](SECURITY.md) for the disclosure policy and threat boundary.

## Compatibility

The Pi release this manager is validated against is recorded once, as `piValidatedVersion` in `package.json`, and surfaced in Settings next to the Pi version actually detected on your machine. Settings says so plainly when the two differ. `codexValidatedVersion` does the same for Codex.

Pi evolves independently, so every release runs the compatibility checklist in [docs/compatibility.md](docs/compatibility.md) and states the validated Pi version in its release notes.

A separate daily repository workflow compares that baseline with Pi's latest stable GitHub Release and opens or refreshes a maintenance issue when review is needed. It is not part of the app: startup and builds do not contact upstream, no Pi package is added as a dependency, and the baseline never advances without manual compatibility validation.

The manager intentionally preserves unknown fields, but a release may still be required when Pi changes:

- config filenames or root structure
- API type identifiers
- auth entry format
- model capability fields or thinking-level semantics
- settings names or allowed values

## Project guide

See [docs/architecture.md](docs/architecture.md) for the shared vocabulary, sources of truth, runtime shapes, component responsibilities, configuration ownership, security invariants, compatibility boundary, and change-specific verification matrix. Maintainers should also read [docs/compatibility.md](docs/compatibility.md) before changing Pi-facing schemas or processing an update reminder.

## Development

```bash
npm ci
npm run dev -- --host 127.0.0.1 --port 4173 --strictPort
npm run build
npm run test:server
npm run test:codex
npm run test:ui
npm run test:sites
npm run test:pi-update
```

Use `/?demo=1` for a non-writing visual and interaction demo.

The normal development command starts the real writable API. Set `PI_CODING_AGENT_DIR` to a temporary directory before using it when you do not intend to edit your normal Pi configuration. Demo mode and the Sites artifact are the non-writing paths.

`npm run check:pi-update` performs an optional live, read-only comparison against Pi's latest stable GitHub Release.

## Open-source status

Released under the [MIT License](LICENSE). See [OPEN_SOURCE_CHECKLIST.md](OPEN_SOURCE_CHECKLIST.md) for repository hardening tasks that remain after the first push.

## Roadmap

- Stable maintenance: security fixes, confirmed correctness defects, and Pi or Codex compatibility updates
- No planned CSV/CC-Switch import, model discovery, session browser, Skills, usage dashboard, or proxy features
- Broader all-in-one workflows belong in CC Switch; this project stays focused on Pi and Codex credentials, defaults, and native-file consistency

See `design-qa.md` and `qa/` for visual comparisons, interaction evidence, and QA history.
