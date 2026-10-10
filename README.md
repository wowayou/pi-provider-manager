# Pi Provider Manager

[简体中文](README.zh-CN.md)

Pi Provider Manager is a local native-configuration manager for **Pi, the Codex CLI, and Claude Code**. It edits each agent's own configuration files to manage providers, credentials, defaults, and global instructions; the agent still sends model requests directly to the configured gateway.

It does not carry inference traffic and is not an API aggregation gateway. When Codex needs an upstream that exposes only Chat Completions, an optional local LiteLLM process can bridge it; this project only writes that process's configuration and supervises it.

**User guide:** [docs/usage.zh-CN.md](docs/usage.zh-CN.md) · **Architecture:** [docs/architecture.md](docs/architecture.md) · **Compatibility:** [docs/compatibility.md](docs/compatibility.md) · **Claude Code:** [docs/claude-code.md](docs/claude-code.md)

## Project status

The current version is `0.5.6`. This is a frozen personal tool: future work is limited to defects found in real use, security fixes, and Pi, Codex, or Claude Code compatibility changes. There is no new-target, feature-expansion, or CC Switch parity roadmap.

For a broader Pi workflow, [CC Switch](https://github.com/farion1231/cc-switch) is usually the better choice. Its [v4.0.6 native contract](https://github.com/farion1231/cc-switch/blob/v4.0.6/docs/pi-native-contract-zh.md) reads Pi's global `defaultProvider` / `defaultModel` for warnings but does not write them, and it does not read or write Pi's `auth.json`. This project keeps the boundary CC Switch leaves open: direct management of Pi credentials, defaults, consistency across the three native files, and global instruction files beside them. When both tools use the same Pi files, reload an already-open page after the other tool saves.

[Octopus](https://github.com/bestruirui/octopus) is a different category: an LLM API aggregation gateway with channel aggregation, protocol conversion, failover, and statistics. This project does not replace it or try to become a gateway; it manages an agent's native configuration locally.

## Scope

| Target | Managed | Runtime source of truth |
| --- | --- | --- |
| Pi | Providers, models, protocol and per-model URL overrides, capacities, thinking levels, defaults, compatibility headers, global instructions | `auth.json`, `models.json`, `settings.json` |
| Codex CLI | Active provider, credentials, model and reasoning settings; optional local LiteLLM bridge | `config.toml`, `auth.json`; other providers in the manager's private store |
| Claude Code | Static Anthropic gateways, both auth modes, model aliases, reply preferences, global `CLAUDE.md`, and per-terminal pinned-provider commands | `settings.json`, the manager's private store, `CLAUDE.md` |

All three targets share the sidebar, three-step wizard, and settings screen, but have separate files, revisions, and runtime semantics. Pi model discovery runs only after the user explicitly chooses **获取模型**; Codex discovery is out of scope.

## Credentials and security boundary

- Saved API keys are never returned to the browser. Prompt text is an intentional exception so documents can be edited.
- The server listens on `127.0.0.1` only; writes also validate an allowlisted loopback Host and JSON content type.
- Saves validate first and use atomic replacement; concurrent edits return `409` instead of overwriting changes from CC Switch, a text editor, or another tab.
- Each agent's native files remain the runtime source of truth. The manager's private stores contain only data the manager must retain separately.
- Startup and page load do not contact upstream services. Version checks, Pi discovery, and the optional bridge are user-triggered.
- Do not attach `auth.json`, real API keys, or private provider stores to issues. See [SECURITY.md](SECURITY.md) for disclosure and threat-boundary details.

## Install

Download the Linux/WSL or Windows archive from the [latest release](https://github.com/wowayou/pi-provider-manager/releases/latest). The archive includes the built UI and dependency-free server; Node.js 18 or newer is required.

Linux/WSL:

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

The archive's `INSTALL.md` covers environment overrides and Windows execution policy. The [user guide](docs/usage.zh-CN.md) covers installation, upgrades, removal, and troubleshooting.

From source on Linux/WSL:

```bash
git clone https://github.com/wowayou/pi-provider-manager.git ~/pi-provider-manager-ui
cd ~/pi-provider-manager-ui
npm run setup
~/.pi/agent/bin/pi-provider-manager-ui
```

`npm run setup` installs dependencies, builds the UI, and installs the launcher. Source-install environment variables and isolated temporary config directories are documented in the user guide.

## Maintainer entry points

```bash
npm ci
npm run build
npm test
```

The development server accesses real configuration. For local development or tests, set `PI_CODING_AGENT_DIR`, `PI_PROVIDER_MANAGER_CODEX_DIR`, and `PI_PROVIDER_MANAGER_CLAUDE_DIR` to temporary directories; `/?demo=1` is the non-writing UI demo.

Read [docs/compatibility.md](docs/compatibility.md) before compatibility changes. Use [docs/architecture.md](docs/architecture.md) for ownership and design boundaries, [design-qa.md](design-qa.md) for dated verification evidence, and [CHANGELOG.md](CHANGELOG.md) for release history.

## License

Released under the [MIT License](LICENSE). Repository-hardening notes are in [OPEN_SOURCE_CHECKLIST.md](OPEN_SOURCE_CHECKLIST.md).

<a href="https://star-history.com/#wowayou/pi-provider-manager&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=wowayou/pi-provider-manager&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=wowayou/pi-provider-manager&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=wowayou/pi-provider-manager&type=Date" width="640" />
  </picture>
</a>
