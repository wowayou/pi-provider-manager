# Pi Provider Manager

[English](README.md)

Pi Provider Manager 是一个面向 **Pi、Codex CLI 和 Claude Code** 的本地原生配置管理器。它编辑三个 agent 自己的配置文件，帮助管理供应商、凭据、默认模型和全局提示词；模型请求仍由 agent 直接发送到配置的网关。

它不承载推理流量，也不是 API 聚合网关。Codex 遇到只有 Chat Completions 的上游时，可选用 LiteLLM 作为本机第三方桥接程序；本项目只生成配置并看管进程，仍不经过模型请求。

**使用手册：** [docs/usage.zh-CN.md](docs/usage.zh-CN.md) · **架构：** [docs/architecture.md](docs/architecture.md) · **兼容性：** [docs/compatibility.md](docs/compatibility.md) · **Claude Code：** [docs/claude-code.md](docs/claude-code.md)

## 项目状态

当前版本是 `0.5.6`。这是一个为作者本人维护的冻结工具：后续只处理真实使用中的缺陷、安全修复，以及 Pi、Codex 或 Claude Code 的兼容变化，不再扩展新的目标、功能路线或 CC Switch 功能追平。

对需要更完整 Pi 工作流的人，[CC Switch](https://github.com/farion1231/cc-switch) 通常更合适。按其 [v4.0.6 原生契约](https://github.com/farion1231/cc-switch/blob/v4.0.6/docs/pi-native-contract-zh.md)，它会读取 Pi 全局 `defaultProvider` / `defaultModel` 用于提醒，但不会写入；也不读写 Pi 的 `auth.json`。本项目保留的差异是直接管理 Pi 凭据、默认项和三份原生文件的一致性，并管理其旁边的全局提示词文件。两个工具共用 Pi 文件时，另一个工具保存后，已经打开的页面需要重新读取。

[Octopus](https://github.com/bestruirui/octopus) 属于另一类产品：它是带渠道聚合、协议转换、故障转移和统计能力的 LLM API 网关。本项目不替代它，也不试图成为一个网关；本项目解决的是 agent 原生配置的本地管理。

## 管理范围

| 目标 | 管理内容 | 关键事实来源 |
| --- | --- | --- |
| Pi | 供应商、模型、协议和模型地址覆盖、容量、思考级别、默认项、兼容请求头、全局提示词 | `auth.json`、`models.json`、`settings.json` |
| Codex CLI | 当前供应商、凭据、模型和推理设置；可选的本机 LiteLLM 桥 | `config.toml`、`auth.json`；其余供应商在管理器私有库 |
| Claude Code | 静态 Anthropic 网关、两种认证方式、模型别名、回复偏好、全局 `CLAUDE.md`、每终端固定供应商命令 | `settings.json`、管理器私有库、`CLAUDE.md` |

三个目标共用侧栏、三步向导和设置页，但配置文件、修订号和运行语义彼此独立。Pi 的模型发现只在用户明确点击「获取模型」时进行；Codex 不提供模型发现。

## 凭据与安全边界

- 已保存的 API key 永不返回浏览器。提示词正文可以返回浏览器，这是为了编辑文档的明确例外。
- 服务端只监听 `127.0.0.1`，写请求还会校验 loopback Host 和 JSON 内容类型。
- 保存前会校验并以原子方式写入；并发修改会返回 `409`，不会用旧页面覆盖 CC Switch、文本编辑器或其他标签页的修改。
- Pi、Codex 和 Claude 的原生文件仍是运行时事实来源；管理器私有库只保存它确实需要额外保存的数据。
- 启动和打开页面不会自动请求上游。版本检查、Pi 模型发现和可选桥接都由用户主动触发。
- 不要把 `auth.json`、真实 API key 或私有供应商库上传到 issue。漏洞披露规则见 [SECURITY.md](SECURITY.md)。

## 安装

从 [最新 Release](https://github.com/wowayou/pi-provider-manager/releases/latest) 下载 Linux/WSL 或 Windows 归档。归档已经包含构建后的 UI 和无第三方运行依赖的服务端，只需 Node.js 18 或更高版本。

Linux/WSL：

```bash
tar -xzf pi-provider-manager-v*-linux-wsl.tar.gz
cd pi-provider-manager-v*
./bin/pi-provider-manager-ui
```

Windows PowerShell 7：

```powershell
Expand-Archive .\pi-provider-manager-v*-windows.zip -DestinationPath .\pi-provider-manager
cd .\pi-provider-manager\pi-provider-manager-v*
pwsh -File .\bin\pi-provider-manager.ps1
```

归档内的 `INSTALL.md` 说明环境变量和 Windows 执行策略。完整安装、升级、卸载和故障排查见 [使用手册](docs/usage.zh-CN.md)。

从源码安装（Linux/WSL）：

```bash
git clone https://github.com/wowayou/pi-provider-manager.git ~/pi-provider-manager-ui
cd ~/pi-provider-manager-ui
npm run setup
~/.pi/agent/bin/pi-provider-manager-ui
```

`npm run setup` 会依次执行依赖安装、构建和启动器安装。源码安装的环境变量与临时配置目录也见使用手册。

## 维护者入口

```bash
npm ci
npm run build
npm test
```

开发服务器会访问真实配置。进行本地开发或测试时，请把 `PI_CODING_AGENT_DIR`、`PI_PROVIDER_MANAGER_CODEX_DIR` 和 `PI_PROVIDER_MANAGER_CLAUDE_DIR` 指向临时目录；`/?demo=1` 只用于不写配置的界面演示。

兼容性变更前先阅读 [docs/compatibility.md](docs/compatibility.md)，架构和所有权问题见 [docs/architecture.md](docs/architecture.md)。带日期的验证记录在 [design-qa.md](design-qa.md)，发布历史在 [CHANGELOG.md](CHANGELOG.md)。

## 开源许可

项目使用 [MIT License](LICENSE) 开源。仓库加固记录见 [OPEN_SOURCE_CHECKLIST.md](OPEN_SOURCE_CHECKLIST.md)。

<a href="https://star-history.com/#wowayou/pi-provider-manager&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=wowayou/pi-provider-manager&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=wowayou/pi-provider-manager&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=wowayou/pi-provider-manager&type=Date" width="640" />
  </picture>
</a>
