# Pi Provider Manager

[English](README.md)

一个面向 **Pi 与 Codex CLI** 的本地模型目录与 API 网关管理器。它不替代这两个 agent，而是安全、可视化地维护它们各自的原生配置文件。

## 我们解决的核心问题

Pi 在运行时以模型为中心，但配置不是“只有模型”：

- 会话最终选择的是具体 `provider/model`
- thinking level 与模型 ID 分离
- key 和默认接口协议属于 provider
- 一个 provider 可以包含多个模型
- 混合协议网关可以为单个模型覆盖 API 类型

因此本项目不是普通的“供应商切换器”，而是把 Pi 的 provider/model/thinking 关系做成小白也能理解的本地工作流。

Codex 的问题正好相反：配置很小，但一点都不宽容 —— 只有一个凭据槽、只剩一种还被接受的 wire 协议、而且供应商表里多写一个字段整张表就解析失败。手工换网关意味着每次都要同时改对两个文件，还得把当前没在用的那把 key 放到别处存着。同一套三步流程现在也覆盖了这件事，见[Codex 支持](#codex-支持)。

## 项目亮点

- **Pi 原生语义**：直接管理 provider、模型 ID、思考强度、图像能力、上下文、最大输出和模型级协议覆盖。
- **适合聚合网关**：一个类似 OpenRouter 的网关可以挂载多个上游厂商模型。
- **key 不回传浏览器**：已有 key 只保存在服务端和 Pi 的 `auth.json`，前端只能看到“已配置”。
- **三文件原子写入与回滚**：写入前校验，失败时回滚，避免半配置状态。
- **并发编辑保护**：每次写入都携带不透明 revision；CC Switch、另一个标签页或文本编辑器改过文件后，旧表单会收到 `409`，不会覆盖新修改。
- **受保护的供应商删除**：删除网关时明确说明受影响的模型，默认同时删除凭据，也可选择保留；若它是 Pi 当前默认项，必须先指定有效的替代供应商和模型。
- **面向 Pi 更新**：编辑已知字段时保留未知 provider/model/settings 字段，降低升级时的数据损失风险。
- **保存后有明确闭环**：显示准确的 `pi --model provider/model:thinking` 命令，并指导用户用 `/model` 验证。
- **适合长模型清单**：表头吸顶、内部滚动、批量粘贴模型 ID，并提示 `-max/-xhigh` 可能只是 thinking level。
- **真实设置页**：可修改默认 provider/model/thinking、传输方式、thinking 显示，并查看 Pi 版本和兼容状态。
- **Codex CLI 支持**：同一套侧栏与三步向导管理 `~/.codex/config.toml` 与 `auth.json`，一键切换生效网关，并逐字节保留文件里的注释和你手写的表。
- **上游只有 chat/completions 也能用**：Codex 只说 Responses API，管理器会为这类网关配置并起停一个本机 LiteLLM 桥。你只需装好 LiteLLM，配置、接线、起停都由它完成。
- **不锁定数据**：Pi 自己的配置文件始终是唯一事实来源，程序不会读取或写入 `models-store.json`。

## 管理的文件

Pi：

- `~/.pi/agent/auth.json`
- `~/.pi/agent/models.json`
- `~/.pi/agent/settings.json`

`models-store.json` 不在本管理器的职责范围内，程序既不读取也不写入它。

Codex（`$CODEX_HOME`，缺省 `~/.codex`）：

- `config.toml` —— 只写本管理器自己的那张 `[model_providers.<id>]`，以及顶层的模型/推理相关键。注释、无关键、你手写的其它供应商表都逐字节保留。
- `auth.json` —— 只写当前生效供应商的 `auth_mode` 与 `OPENAI_API_KEY`，其余键（包括 ChatGPT 登录态）保留。
- `pi-provider-manager-store.json` —— 本管理器自己的供应商库，权限 `0600`，见 [Codex 支持](#codex-支持)。
- `pi-provider-manager-litellm.yaml`、`pi-provider-manager-bridge.json`、`pi-provider-manager-bridge.log` —— 只有供应商用了托管桥时才会写：LiteLLM 的生成配置、代理的运行时记录，以及它的输出。


## Codex 支持

Codex 和 Pi 的形态很不一样，设计上的取舍都来自它的三个事实：

- 它只有**一个凭据槽**：`auth.json` 里只放得下一个 `OPENAI_API_KEY`。
- 从 2026 年 2 月起它**只说 Responses API**。`wire_api = "chat"` 已被移除，写进去会让整份 `config.toml` 加载失败。
- 它的配置**只在启动时读一次**。切换供应商影响的是新开的会话；已经在跑的 `codex` 进程不受影响。

### 单表模式：原地整表重写

`config.toml` 里任何时刻只有一张本管理器拥有的供应商表，所以文件形状和厂商文档里给的片段完全一致：

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

切换供应商 = 整表重写这一张 + 换掉 `auth.json` 里的 key。因为 Codex 没有地方安放"当前没在用"的供应商，其余供应商的地址、模型列表和 key 存在 `pi-provider-manager-store.json`（权限 `0600`，永不回传浏览器）。**`config.toml` 仍然是"Codex 实际会怎么做"的事实来源；供应商库是"你还配了些什么"的事实来源。**

如果磁盘上的这张表和库里对不上 —— 第一次使用，或者你手动改过 —— 以**文件为准**：它会被接管为一个供应商条目，界面上明确标注"已接管"。读取状态永远不写盘，所以打开页面本身不会动到一套正在工作的配置。

表名默认 `custom`，可在设置里改。Codex 的内建 id（`openai`、`ollama`、`lmstudio`、两个 Bedrock）会被拒绝。

### 在同一供应商内换模型

默认模型会写进 `config.toml`。该供应商的其它模型，开会话时在命令行上指定：

```bash
codex                              # 该供应商的默认模型
codex -m gpt-5.1-codex             # 同一供应商的另一个模型
codex -m gpt-5.1-codex -c model_reasoning_effort="low"
```

本管理器不写任何 `[profiles.*]`。Codex 0.149.0 已把 `config.toml` 里的 profile 判为 legacy，只要存在同名表就**直接拒绝 `--profile <name>`**，于是生成它反而弄坏了它本该启用的那条命令。0.2.0 和 0.2.1 确实生成过；下一次保存会精确删掉它们记录下来的那批，你自己手写的 `[profiles.*]` 即使前缀相同也不会被碰。

注意走桥的供应商只服务你在向导里列出的模型 —— LiteLLM 只应答这些，所以 `-m` 指定一个没配过的模型会在桥这一层失败，得先回界面把它加上。

### 全局提示词

两个 agent 的全局提示词都落在本管理器已经在管的目录里，所以一套界面同时服务两边。每个文件同时只有一份内容生效，其余存在管理器自己的库里 —— 和未生效的供应商是同一套做法。

| Agent | 文件 | 作用 |
|---|---|---|
| Pi | `~/.pi/agent/AGENTS.md` | 与项目、父目录的 `AGENTS.md` 拼接 |
| Pi | `~/.pi/agent/SYSTEM.md` | 整体替换默认系统提示 |
| Pi | `~/.pi/agent/APPEND_SYSTEM.md` | 追加在默认系统提示之后 |
| Codex | `$CODEX_HOME/AGENTS.md` | 与项目的 `AGENTS.md` 拼接 |

早于本管理器就存在的文件会被**接管**而不是当作不存在，且只发生在读路径上 —— 打开这个界面永远不写盘。删除当前正在文件里的那一份时必须指定替代，规则与删除生效中的供应商一致。

和凭据不同，提示词正文会返回给浏览器。这是有意的：读不回来的文档没法编辑。真正需要保密的东西属于凭据，不属于提示词。

### 上游只提供 `/v1/chat/completions` 时

Codex 直连不了这类上游，靠配置也解决不了 —— 必须有一层翻译。管理器会替你配置并起停它，你只需要装。

Debian / Ubuntu（包括 WSL）按 [PEP 668](https://peps.python.org/pep-0668/) 禁止系统级 `pip install`，用 `pipx` 或 venv：

```bash
pipx install 'litellm[proxy]'
# 或
python3 -m venv ~/.local/litellm && ~/.local/litellm/bin/pip install 'litellm[proxy]'
```

这两种落到的位置管理器都会自己找，不需要再配任何东西；凭据那一步会显示它实际选中了哪个可执行文件。

**LiteLLM 要单独装。** 在同一条命令里附带别的版本钉子，解析器会转而把 LiteLLM 降级去满足那个钉子，而旧版**完全没有** Responses→Chat 的桥接能力 —— `1.79.0` 实测会把 `/v1/responses` 原样转发给上游然后拿到 404。本项目验证过的是 `1.97.0`。

如果之后 `litellm --version` 吐的是 traceback 而不是版本号，再**单独**降 FastAPI：

```bash
pip install 'fastapi==0.115.14'
```

LiteLLM 没把 FastAPI 钉死，而 `fastapi 0.141.1` 会在 import 时报 `cannot import name 'get_flat_dependant'`。

然后在第一步选「上游只有 chat/completions」，填**你上游自己的**地址和 key。剩下的管理器来做：

- 为你的每个模型生成 LiteLLM 的 `config.yaml`，带上 `use_chat_completions_api: true`
- 把 Codex 指向本机代理（`base_url = "http://127.0.0.1:43210/v1"`、`requires_openai_auth = false`）
- 在凭据那一步直接起停这个代理

上游的 key 两个配置文件里都不会出现。它存在管理器自己的 `0600` 库里，通过环境变量 `PPM_BRIDGE_UPSTREAM_KEY` 交给 LiteLLM —— 这正是配置里 `api_key: os.environ/...` 期待的形式。代理被强制绑定在 `127.0.0.1`：LiteLLM 自己的默认是 `0.0.0.0`，那会把一个持有你 key、且无鉴权的代理暴露在所有网卡上。

代理是 detach 启动的，关掉管理器不会把 Codex 掐断。停止时只会对「命令行里仍然指向管理器那份配置文件」的进程发信号，因为 pid 会被复用。

在管理器无法证明「已启动的进程仍是自己那个」的平台上（没有 procfs 的系统，包括原生 Windows），它不会去代管进程。配置照样生成，凭据那一步会给出手动运行的命令。Codex 的其余部分（包括直连供应商）不受影响。

**本项目仍然不自己翻译模型流量。** 写第三方配置文件、看管一个进程，和它已经在为 Pi 和 Codex 做的是同一类事；没有任何请求经过管理器。翻译这件事留给 LiteLLM 维护 —— 这很重要，因为一直在动的那一侧是 Codex：reasoning item、加密的 reasoning 内容、tool call 的结构，而 Codex 基本每周发版。[codex-relay](https://github.com/MetaFARS/codex-relay) 是另一个你可以自己跑的选择，那种情况下按普通供应商指向它即可。

### 如果 Codex 提示「project-local config keys」

Codex 还会从当前工作目录往上找 `.codex/config.toml`，遇到它在项目级不认的键时会警告：

```
⚠ Ignored unsupported project-local config keys in <目录>/.codex/config.toml: model_provider, model_providers
```

这说的是**那个目录自己的文件**，不是本管理器编辑的那份。`model_provider` 和 `model_providers` 只能在用户级设置 —— 而那正是管理器写的位置（`$CODEX_HOME/config.toml`）。最常见的触发方式是在一个恰好含有 `.codex/` 的家目录里跑 `codex`，比如 WSL 下的 `/mnt/c/Users/<你>`（Windows 上也装了 Codex 时）。换到你的项目目录里跑就行。

### 切换能带走什么，不能带走什么

新会话会干净地用上新配置。**但换供应商后用 `codex resume` 接续旧会话并不可靠**：Codex 会请求 `reasoning.encrypted_content` 并在后续轮次原样回传，而一家加密的内容另一家读不了。这是 Codex 的设计，任何切换工具都绕不过去。同一段对话请在开始它的那家上聊完。

## 项目状态与 CC Switch

本项目处于维护模式。后续只处理确认过的缺陷、安全修复和 Pi / Codex 兼容变化，不再追求与 [CC Switch](https://github.com/farion1231/cc-switch) 的大而全功能对齐。

Codex 支持是有意加入的，范围同样收窄：供应商、凭据和当前生效项。不做预设库、模型发现、用量看板，也不做流量代理。

CC Switch 3.20 已完整接入 Pi 的供应商预设、模型发现、提示词、Skills、会话和用量统计，但它明确不读写 Pi 的 `auth.json`、`defaultProvider` 和 `defaultModel`。本项目继续作为一个更小、无数据库的工具，负责凭据/默认项边界、三份原生配置之间的一致性，以及它们旁边的全局提示词文件。两者可以读取同一套 Pi 文件，但一个工具保存后，另一个工具里已经打开的旧页面必须重新读取。

## 安装 Release 归档

从[最新 Release](https://github.com/wowayou/pi-provider-manager/releases/latest)下载 Linux/WSL 或 Windows 归档。归档已经包含构建后的 UI 和无第三方运行依赖的服务端，只需安装 Node.js 18 或更高版本。

Linux 或 WSL：

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

环境变量覆盖和执行策略说明见归档内的 `INSTALL.md`。

## 在 Linux 或 WSL 从源码构建

```bash
git clone https://github.com/wowayou/pi-provider-manager.git ~/pi-provider-manager-ui
cd ~/pi-provider-manager-ui
npm ci
npm run build
install -m 700 bin/pi-provider-manager-ui ~/.pi/agent/bin/pi-provider-manager-ui
~/.pi/agent/bin/pi-provider-manager-ui
```

启动器会复用已运行的管理器，或在 `43127-43146` 中自动选择空闲端口。在 WSL 下会打开 Windows 默认浏览器；其他环境会使用可用的 WSL/PowerShell 浏览器桥接，若都不存在则输出本地 URL。复用前会检查 `/api/state` 身份，不会把同端口的其他应用误认成本项目。

如果仓库不在 `~/pi-provider-manager-ui`，请先把 `PI_PROVIDER_MANAGER_PROJECT_DIR` 设置为仓库绝对路径。

### 自动识别与环境变量覆盖

| 环境变量 | 自动默认值 | 用途 |
|---|---|---|
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi 的 auth/models/settings 配置目录 |
| `CODEX_HOME` | `~/.codex` | Codex 配置目录，沿用 Codex 自己的优先级 |
| `PI_PROVIDER_MANAGER_CODEX_DIR` | `CODEX_HOME` 的值 | 仅对本管理器生效的 Codex 目录覆盖 |
| `PI_PROVIDER_MANAGER_LITELLM` | 依次查找 `~/.local/bin/litellm`、`~/.local/litellm/bin/litellm` 等常见 venv 路径，最后回落到 `PATH` | 启动托管桥使用的可执行文件。只有装在冷僻位置时才需要设置；凭据那一步会显示实际选中的是哪个。 |
| `PI_PROVIDER_MANAGER_PROJECT_DIR` | 当前匹配仓库，其次 `~/pi-provider-manager-ui` | 项目与构建产物位置 |
| `PI_PROVIDER_MANAGER_PORT` | 从 `43127-43146` 自动选择 | 严格指定本地服务端口 |
| `PI_PROVIDER_MANAGER_NODE` | 当前 `node` 可执行文件 | 后台服务使用的 Node 路径 |
| `PI_PROVIDER_MANAGER_OPEN_BROWSER` | `1` | 设为 `0` 时只启动服务，不自动打开浏览器 |
| `WSL_DISTRO_NAME` | WSL 自动提供 | Windows 隐藏启动时使用的发行版 |

监听地址固定为 `127.0.0.1`，不会自动开放到局域网或公网。

专用端口段还可以避开 Vite 常用的 `4173` origin 上残留的旧 Service Worker 和站点缓存。

## 安全边界

- 服务只监听 `127.0.0.1`
- API 请求必须携带白名单内的 loopback `Host`；写请求还必须使用 `application/json`，防止外部网页通过跨域简单请求修改配置
- 已有 key 不会出现在浏览器响应中
- 新 key 仅在保存动作中提交
- 后端测试全部使用临时目录和假 key
- 禁止在 GitHub Issue 中上传 `auth.json`、真实 key 或私有供应商导出

漏洞披露方式和完整威胁边界见 [SECURITY.md](SECURITY.md)。

## Pi 与 Codex 兼容性

本管理器验证过的 Pi 版本只记录在一处 —— `package.json` 的 `piValidatedVersion`，并在设置页与实际检测到的 Pi 版本并列显示；两者不一致时设置页会直接说明。`codexValidatedVersion` 对 Codex 是同样的约定。

未知字段会被保留，但 Pi 如果修改配置结构、API 类型、认证格式、模型能力字段或设置名称，本项目仍需要发布对应兼容更新。每个版本都会跑 [docs/compatibility.md](docs/compatibility.md) 里的兼容性清单，并在 release notes 中写明验证过的 Pi 版本。

Codex 侧没有自动监测：它发版远比 Pi 频繁，每日提醒只会变成噪音。需要复核时，按 [docs/compatibility.md](docs/compatibility.md) 里列出的四项（`wire_api` 取值、供应商表的 deny-unknown、第三方鉴权顺序、推理强度取值）逐条确认。

仓库另有一个每日运行的维护 workflow，只比较该基线与 Pi 最新稳定 GitHub Release；需要复核时，它会创建或更新维护 issue。监测不进入应用运行链：启动和构建不会访问上游，不引入 Pi npm 依赖，也不会自动推进兼容性基线。

程序会保留未知字段，但出现以下变化时仍可能需要发布兼容更新：

- 配置文件名或根结构
- API 类型标识
- 认证条目格式
- 模型能力字段或 thinking level 语义
- 设置项名称或允许值

## 项目结构与维护

[docs/architecture.md](docs/architecture.md) 统一项目术语和事实来源，并说明本地产品、Vite 开发环境、Sites 静态产物和更新监测之间的边界，以及各组件职责、配置所有权、安全约束和验证矩阵。处理 Pi 更新或修改 Pi 配置 schema 前，先读 [docs/compatibility.md](docs/compatibility.md)。

维护者可运行 `npm run check:pi-update` 做一次只读上游比较；监测逻辑的本地测试是 `npm run test:pi-update`。

## 开发

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

使用 `/?demo=1` 进入不会写配置的视觉和交互 demo。

普通开发命令会启动真实、可写的 API；如果不希望修改日常 Pi 配置，请先把 `PI_CODING_AGENT_DIR` 指向临时目录。只有 demo 模式和 Sites 产物是不可写路径。

## 开源状态

项目使用 [MIT License](LICENSE) 开源。首次推送后的仓库加固事项见 [OPEN_SOURCE_CHECKLIST.md](OPEN_SOURCE_CHECKLIST.md)。

## 路线图

- 稳定维护：安全修复、确认过的正确性缺陷和 Pi / Codex 兼容更新
- 不再计划 CSV/CC-Switch 导入、模型发现、会话浏览、Skills、用量看板或代理功能
- 更广的一站式工作流交给 CC Switch；本项目保持聚焦于 Pi 与 Codex 的凭据、默认项和原生文件一致性

视觉对照、交互验证和历史 QA 记录见 `design-qa.md` 与 `qa/`。
