# Pi Provider Manager 使用说明书

面向使用者，不是面向维护者。设计取舍与兼容性策略见
[`docs/architecture.md`](architecture.md) 和 [`docs/compatibility.md`](compatibility.md)。

这个程序做的事只有一件：**安全地编辑 Pi 和 Codex 自己的配置文件**。它不是运行时，
不代理模型流量，关掉它之后两个 agent 照常工作。

> 全文里的中文界面文字都是程序里的原文，可以直接用来在界面上定位。

## 目录

- [一、装好并跑起来](#一装好并跑起来)
- [二、它会读写哪些文件](#二它会读写哪些文件)
- [三、Pi：接一个 API 网关](#三pi接一个-api-网关)
- [四、Pi：模型清单里的几个省事功能](#四pi模型清单里的几个省事功能)
- [五、Pi：设置与兼容性](#五pi设置与兼容性)
- [六、Codex：接一个网关](#六codex接一个网关)
- [七、Codex：上游只有 `/v1/chat/completions` 时](#七codex上游只有-v1chatcompletions-时)
- [八、全局提示词](#八全局提示词)
- [九、删除，以及不会被你覆盖掉的东西](#九删除以及不会被你覆盖掉的东西)
- [十、环境变量](#十环境变量)
- [十一、故障排查：按屏幕上的原话查](#十一故障排查按屏幕上的原话查)
- [十二、升级与卸载](#十二升级与卸载)
- [十三、安全边界](#十三安全边界)

## 一、装好并跑起来

只有一个前置条件：**Node.js 18 或更高**。低于这个版本启动器会直接拒绝并告诉你用的是哪个
node，不会让你撞上服务端内部的语法错误。

### 从源码（Linux / WSL，推荐）

```bash
git clone https://github.com/wowayou/pi-provider-manager.git ~/pi-provider-manager-ui
cd ~/pi-provider-manager-ui
npm run setup
~/.pi/agent/bin/pi-provider-manager-ui
```

`npm run setup` = `npm ci` + `npm run build` + `npm run install:launcher`，一条命令。

装到 `~/.pi/agent/bin/` 的是一个**转发脚本**，不是启动器的副本。它每次执行仓库里当前那一
份，所以以后升级只需要：

```bash
cd ~/pi-provider-manager-ui && git pull && npm run setup
```

副本会过期，而过期的启动器**不报错**：0.3.0 之前那一代照样能启动，只是不再把 Codex 目录和
LiteLLM 路径交给后台服务，于是托管桥在离原因很远的地方坏掉。如果你以前手工复制过启动器，现在
启动器会自己发现并在启动前说出来 —— 重跑一次 `npm run install:launcher` 就换掉了。

仓库不在 `~/pi-provider-manager-ui` 也没关系，转发脚本里记的是实际路径。

### 从 Release 归档

```bash
tar -xzf pi-provider-manager-v*-linux-wsl.tar.gz
cd pi-provider-manager-v*
./bin/pi-provider-manager-ui
```

归档已经含构建产物，不需要 `npm install`。**归档不要装转发脚本**：归档升级时是整个替换的，
指向旧归档的转发脚本会在下个版本失效。解包后原地运行即可。

### Windows PowerShell 7

```powershell
Expand-Archive .\pi-provider-manager-v*-windows.zip -DestinationPath .\pi-provider-manager
cd .\pi-provider-manager\pi-provider-manager-v*
pwsh -File .\bin\pi-provider-manager.ps1
```

Windows 上没有既成的"命令安装位置"惯例，所以 `npm run install:launcher` 在这里什么都不装，
只告诉你从仓库/归档里怎么起。PowerShell 启动器和 bash 启动器的检查是对齐的：同样的四处查找
说明、同样的 Node 下限、同样的过期副本告警、同样的复用报告与重启命令。

**从 PowerShell 跑一个放在 WSL 里的 checkout 是跑不起来的**，这一点值得单独说，因为报错不会
提到本项目：默认执行策略 `RemoteSigned` 把 `\\wsl.localhost\...` 当远程路径，未签名脚本一律
拒绝，只留下一句 `is not digitally signed`。实测于 PowerShell 7.6.3。两条正路：checkout 放在
Windows 本地盘（本地未签名脚本是策略允许的），或者就用 WSL 里的 bash 启动器——它本来就是
WSL checkout 的那一条。`pwsh -ExecutionPolicy Bypass -File ...` 也能跑通，但那是按进程放宽
执行策略，要清楚自己在放宽什么。

### 启动之后

启动器会打印三行关键信息：

```
Pi Provider Manager is ready: http://127.0.0.1:43127/
  Pi config:    /home/you/.pi/agent
  Codex config: /home/you/.codex
```

两个目录一定会打印出来，因为 `CODEX_HOME=""` 这种"看着像设了其实等于默认值"的失误，只有在
写任何东西之前看到路径才发现得了。

端口在 `43127-43146` 里自动选，专用段是为了避开 Vite 常用的 `4173` 上残留的 Service
Worker 和站点缓存。**再次运行同一条命令不会起第二个进程**：它先用 `/api/state` 确认端口上那
个确实是本管理器，然后复用，并明确告诉你复用了谁：

```
  (reused the instance already running on this port, version <运行中那个实例的版本>)
  Restart it to pick up an upgrade: the version and directories above are the ones it started with.
    kill <pid> && '<launcher>'
```

WSL 下会自动打开 Windows 默认浏览器。不想开浏览器就 `PI_PROVIDER_MANAGER_OPEN_BROWSER=0`。

## 二、它会读写哪些文件

打开界面本身**永远不写盘**。只有你点保存才会写。

### Pi（`PI_CODING_AGENT_DIR`，缺省 `~/.pi/agent`）

| 文件 | 内容 |
|---|---|
| `auth.json` | 各供应商的 key |
| `models.json` | 供应商与模型清单 |
| `settings.json` | 默认供应商/模型/thinking、传输方式等 |

`models-store.json` **不在管理范围内**，既不读也不写。

### Codex（`CODEX_HOME`，缺省 `~/.codex`）

| 文件 | 管理器写什么 |
|---|---|
| `config.toml` | 只写它自己那一张 `[model_providers.<id>]`，以及顶层的模型/推理键 |
| `auth.json` | 只写生效供应商的 `auth_mode` 和 `OPENAI_API_KEY` |
| `pi-provider-manager-store.json` | 它自己的供应商库，权限 `0600`，永不回传浏览器 |
| `pi-provider-manager-litellm.yaml` | 仅用托管桥时：LiteLLM 的生成配置 |
| `pi-provider-manager-bridge.json` | 仅用托管桥时：桥的运行时记录 |
| `pi-provider-manager-bridge.log` | 仅用托管桥时：LiteLLM 自己的输出，权限 `0600` |

`config.toml` 里的注释、无关键、你手写的其它供应商表，**逐字节保留**。

## 三、Pi：接一个 API 网关

侧栏「我的供应商 / API 网关」→ 添加供应商，三步：

**第 1 步「选择协议」** —— 选这个网关默认说哪种接口。四个选项：

| 选项 | 什么时候选 |
|---|---|
| OpenAI Responses（新接口） | 支持 Responses API 的网关与新模型 |
| OpenAI Chat（兼容接口） | 最常见的 Chat Completions 兼容网关 |
| Anthropic Messages | 提供 Anthropic Messages 接口的网关 |
| Gemini | Gemini 原生格式的服务 |

这是**供应商级的默认值**。单个模型可以在第 3 步单独覆盖 —— 混合协议的聚合网关就是靠这个支持的。

**第 2 步「填写凭据」** —— 供应商 ID、名称、API 地址、key。

- 地址填**接口根地址**，不要带具体模型路径。
- key 提交后不再回显，界面只显示「凭据已配置」。想换就重填一次。
- 已有供应商可以选「迁移/复制已有凭据」，不用把 key 再找一遍。

**第 3 步「确认模型」** —— 一个网关可以挂多个不同厂商的模型。每行可填：模型 ID、上下文容量、
最大输出、图像能力、推理能力、以及是否设为该供应商的默认模型。

保存后界面给你一条可以直接复制的命令：

```bash
pi --model provider/model:thinking
```

并提示用 `/model` 在 Pi 里验证。**没改全局默认时它会明说**「本次没有改动全局默认，用上面的命令
直接指定」—— 这样你不会以为默认变了。

## 四、Pi：模型清单里的几个省事功能

- **批量添加**：把一串模型 ID 粘进「批量添加模型 ID」，一次生成多行。长清单不用一行行敲。
- **全部用安全值 / 这一行用安全值**：把上下文容量与最大输出改成安全默认值，**可撤销**。不确定
  某个网关的真实上限时先用这个，能起来再调。「这一行用安全值」只在鼠标悬停在那一行时出现。
- **thinking 后缀提示**：填了 `xxx-max`、`xxx-xhigh` 这类 ID 时会提示「发现疑似思考档位后缀」。
  很多网关把 thinking level 拼进模型名，而 Pi 里 thinking 是**独立维度**，写成模型 ID 会白
  占一行。
- **容量输入**：接受 1 到 100m 之间的整数，或带 k / m 的写法 —— `200000`、`200k`、`1.05m`。
- **模型 ID 不能改名**：已保存的模型只能"加新的、删旧的"。直接改名会让 Pi 那边的历史对不上。
- **删除保护**：不能删掉一个供应商的唯一模型（要整个删就用「删除供应商」）；要删 Pi 当前默认的
  模型，得再点一次确认。

## 五、Pi：设置与兼容性

侧栏「设置」。上半部分写进 `settings.json`：默认供应商 / 模型 / thinking、传输方式、thinking
显示、外观（跟随系统 / 浅色 / 深色，存在浏览器本地）。

下半部分是只读的诊断信息，报障时把这几行贴出来最省事：

| 字段 | 含义 |
|---|---|
| 管理器版本 | **正在运行的**这个进程的版本，不是磁盘上的版本 |
| Pi 版本 | 这台机器上检测到的 Pi，实时读取，Pi 升级后无需重启本程序 |
| 已验证兼容 | 正在运行的这个版本实际验证过的 Pi 版本（`piValidatedVersion`） |
| 配置目录 / 路径来源 | 实际在编辑哪个目录，以及这个路径是环境变量给的还是默认推出来的 |
| 配置策略 | 固定「保留未知字段」 |
| 本地服务 / Node | 服务端状态与 Node 版本 |

升级本程序（`git pull` 或解开新的发布包）之后，已经在跑的进程仍然是旧代码：「管理器版本」和
「已验证兼容」都还是旧的那一组数字。这时卡片上会多出一行提示，写明磁盘上是哪个版本、当前跑的
是哪个版本；重启本地服务后才会更新。启动器（`pi-provider-manager-ui`）复用已在运行的实例时也会
打印同样的信息，并给出 `kill <pid> && …` 的重启命令。

## 六、Codex：接一个网关

Codex 的形态和 Pi 很不一样，三件事决定了这里的所有设计：

1. **只有一个凭据槽**。`auth.json` 里只放得下一个 `OPENAI_API_KEY`。
2. **只说 Responses API**。2026 年 2 月起 `wire_api = "chat"` 被移除，写进去会让**整份**
   `config.toml` 加载失败。
3. **配置只在启动时读一次**。切换供应商影响的是**新开的会话**，正在跑的 `codex` 不受影响。

三步向导：**「接入方式」→「填写凭据」→「确认模型」**。

第 1 步问的是"上游是否支持 Responses"：

- 上游支持 Responses → 选「上游支持 Responses」，直连即可。
- 上游只提供 `/v1/chat/completions` → 选「上游只有 chat/completions」，见下一节。

### 单表模式

`config.toml` 里任何时刻只有一张本管理器拥有的供应商表，所以文件形状和厂商文档给的片段完全一样：

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

切换供应商 = 重写这一张表 + 换掉 `auth.json` 里的 key。因为 Codex 没有地方放"当前没在用"的
供应商，其余供应商的地址、模型和 key 存在 `pi-provider-manager-store.json`。

**`config.toml` 仍然是"Codex 实际会怎么做"的事实来源**；供应商库是"你还配了些什么"的事实来源。
两边对不上时（第一次使用，或者你手动改过）以**文件为准**：它会被接管为一个供应商条目，界面标注
「已接管」。

表名默认 `custom`，可在设置里改。Codex 的内建 id（`openai`、`ollama`、`lmstudio`、两个
Bedrock）会被拒绝。

### 在同一供应商内换模型

默认模型写进 `config.toml`。该供应商的其它模型在开会话时用命令行指定：

```bash
codex                              # 该供应商的默认模型
codex -m gpt-5.1-codex             # 同一供应商的另一个模型
codex -m gpt-5.1-codex -c model_reasoning_effort="low"
```

本管理器**不写任何 `[profiles.*]`**。Codex 0.149.0 已把 `config.toml` 里的 profile 判为
legacy，只要存在同名表就直接拒绝 `--profile <name>` —— 于是生成它反而弄坏了它本该启用的那条
命令。0.2.0 / 0.2.1 生成过，下一次保存会精确删掉它们记录的那批；你自己手写的 `[profiles.*]`
即使前缀相同也不会被碰。

**跨供应商续聊是不行的**：Codex 会把上一家加密的 reasoning 内容原样回传，另一家读不了。

## 七、Codex：上游只有 `/v1/chat/completions` 时

Codex 直连不了这类上游，靠配置也解决不了 —— 必须有一层翻译。管理器会替你**生成配置、接线、起
停**一个本机 LiteLLM 代理；你只需要把 LiteLLM 装上。

Debian / Ubuntu（含 WSL）按 [PEP 668](https://peps.python.org/pep-0668/) 禁止系统级
`pip install`，用 pipx：

```bash
pipx install 'litellm[proxy]'
```

管理器会自动按顺序找这几个位置 —— `~/.local/bin/litellm`（pipx 链接的位置）、
`~/.local/litellm/bin/litellm`、`~/.local/share/litellm/bin/litellm`、
`~/.venvs/litellm/bin/litellm`、`~/venvs/litellm/bin/litellm` —— 最后回落到 `PATH`。
装在冷僻位置就设 `PI_PROVIDER_MANAGER_LITELLM`。**「填写凭据」那一步会显示它实际选中的是哪个**。

流程上你要填的是**上游**的地址和 key：

- 上游 API 地址：你那个只提供 `/v1/chat/completions` 的地址。
- 上游凭据：上游的 key。**它由本管理器保管并交给本地桥，不会写进 Codex 的配置。**

而 Codex 那边被指向的是本机的桥（默认 `http://127.0.0.1:43210/v1`，只监听 `127.0.0.1`）。
界面上这个供应商会显示「托管桥」徽标。

桥的按钮在「填写凭据」那一步：**启动桥 / 停止桥**。首次启动 LiteLLM 会慢一些，界面会提示
「几秒后再看状态」。

两个必须知道的点：

- **桥只服务你在向导里列出的模型。** LiteLLM 只应答这些，所以 `codex -m 某个没配过的模型` 会在
  桥这一层失败 —— 回界面把它加上。
- **桥没跑，Codex 就发不出请求。** 界面会直接说「本地桥未运行 —— Codex 现在发不出请求」。

某些平台需要你自己起桥，界面会把命令列出来让你复制。

### 不用托管桥的替代做法

你也可以自己跑一个代理，然后当成普通供应商填进来 —— README 里列了
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 和
[codex-relay](https://github.com/MetaFARS/codex-relay)。用 CLIProxyAPI 有两点要注意：

- 填给管理器的 key 是 CLIProxyAPI **自己 `api-keys` 列表里的**那一把，不是你上游的。
- **自己绑定监听地址**：它默认 `host: ""`，也就是所有网卡，端口 8317。本项目把 LiteLLM 钉在
  `127.0.0.1` 就是同一个道理。

## 八、全局提示词

两个 agent 的全局提示词都落在管理器已经在管的目录里，所以一套界面同时服务两边。每个文件同时只有
一份内容生效，其余存在管理器自己的库里 —— 和未生效的供应商同一套做法。

| Agent | 文件 | 作用 |
|---|---|---|
| Pi | `~/.pi/agent/AGENTS.md` | 与项目、父目录的 `AGENTS.md` 拼接 |
| Pi | `~/.pi/agent/SYSTEM.md` | **整体替换**默认系统提示。写错会影响 Pi 的全部行为 |
| Pi | `~/.pi/agent/APPEND_SYSTEM.md` | 追加在默认系统提示之后，不替换它 |
| Codex | `$CODEX_HOME/AGENTS.md` | 与项目的 `AGENTS.md` 拼接 |

早于管理器就存在的文件会被**接管**，而不是当作不存在，且只发生在读路径上。删除当前正在文件里的
那一份时必须指定替代，规则和删除生效中的供应商一致。

和凭据不同，提示词正文**会**返回给浏览器。这是有意的：读不回来的文档没法编辑。真正需要保密的东西
属于凭据，不属于提示词。

## 九、删除，以及不会被你覆盖掉的东西

**删除供应商**会明确说清影响范围，三种措辞对应三种情况：

- 「供应商、全部模型和已保存的凭据会被永久删除。」
- 「供应商和模型会被永久删除，已保存的凭据会保留。」（你选了保留凭据）
- 「供应商和全部模型会被永久删除；该供应商没有已保存的凭据。」

如果它是 Pi 当前的默认项，**必须先指定有效的替代供应商和模型**才能删；界面会说「先添加另一个带
模型的供应商，才能替换 Pi 当前默认项」。

**并发编辑保护**：每次写入都带一个不透明 revision。如果 CC Switch、另一个标签页或文本编辑器在
你编辑期间改过文件，保存会被拒绝，并明确告诉你草稿**没有**写进去：

> ……已被其他程序或标签页修改。当前草稿尚未写入，请重新读取配置后再试。

提示条上会出现「重新读取」按钮。这不是失败，是它在替你避免覆盖别人的修改。

**未知字段保留**：编辑已知字段时，Pi 那边未知的 provider / model / settings 字段会原样保留，
Codex 那边不认识的键、注释、你手写的其它供应商表也逐字节保留。这样上游加了新字段，你用旧版管理器
编辑也不会把它们抹掉。

## 十、环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi 的配置目录 |
| `CODEX_HOME` | `~/.codex` | Codex 配置目录，沿用 Codex 自己的优先级 |
| `PI_PROVIDER_MANAGER_CODEX_DIR` | `CODEX_HOME` 的值 | 只对本管理器生效的 Codex 目录覆盖 |
| `PI_PROVIDER_MANAGER_LITELLM` | 自动查找常见 venv 路径，再回落 `PATH` | 桥用哪个 litellm 可执行文件 |
| `PI_PROVIDER_MANAGER_PROJECT_DIR` | 转发脚本记录的路径 / 当前仓库 / `~/pi-provider-manager-ui` | 项目与构建产物位置 |
| `PI_PROVIDER_MANAGER_PORT` | `43127-43146` 自动选 | 严格指定端口 |
| `PI_PROVIDER_MANAGER_NODE` | 当前 `node` | 后台服务用哪个 Node |
| `PI_PROVIDER_MANAGER_OPEN_BROWSER` | `1` | 设 `0` 只起服务不开浏览器 |

**想先拿废弃副本试试**，不要碰真实配置：

```bash
cp -r ~/.pi/agent /tmp/pi-try && cp -r ~/.codex /tmp/codex-try
PI_CODING_AGENT_DIR=/tmp/pi-try CODEX_HOME=/tmp/codex-try \
  ~/.pi/agent/bin/pi-provider-manager-ui
```

启动器会把这两个目录打印出来，照着确认一遍再动手。

监听地址固定 `127.0.0.1`，不会自动开放到局域网或公网。

## 十一、故障排查：按屏幕上的原话查

### 启动阶段

| 你看到的 | 含义与做法 |
|---|---|
| `Node.js executable not found.` | 找不到 node。设 `PI_PROVIDER_MANAGER_NODE` 指到实际路径 |
| `Node.js 16 is too old: this project needs 18 or newer.` | Node 太旧。它会同时打印用的是哪个 node —— 常见原因是 nvm 装了新版但这个 shell 里是旧版 |
| `Pi Provider Manager project not found:` | 找不到仓库。它会列出**查过的四个位置**和各自解析结果；照着改那一个，或在仓库里跑 `npm run install:launcher` |
| `Built UI not found. Run 'npm ci && npm run build'` | 只 clone 没构建。跑 `npm run setup` |
| `Warning: the launcher you ran is not the one in the checkout` | 你在跑一份过期副本。`npm run install:launcher` 换成转发脚本 |
| `Pi Provider Manager is no longer at:` | 转发脚本指向的仓库被移动或删除了。在新位置重跑 `npm run install:launcher` |
| `Port N is already used by another application.` | 你指定的端口被别的程序占了。换一个，或者别指定让它自动选 |
| `No free port found in 43127-43146.` | 20 个端口全被占。用 `PI_PROVIDER_MANAGER_PORT` 指一个 |
| `Pi Provider Manager failed to start.` | 服务起不来。它会打印一条可以直接粘贴的手动启动命令，前台跑一遍就能看到真正的报错；日志在 `$PI_CODING_AGENT_DIR/pi-provider-manager-ui.log` |
| 打印了 `(reused the instance already running on this port)` | 端口上已经有一个了，这是**正常复用**。升级或刚装完 LiteLLM 需要重启时，照它给的 `kill <pid> && <launcher>` 做 |

### Codex 相关

| 你看到的 | 含义与做法 |
|---|---|
| 「这个桥还没有可用的上游 key」 | 早于 0.3.0 的版本可能把**上游地址**错存进 key 那一栏，那样的值读作"未配置"。在上面填一次真正的 key 再保存，旧值就被替换掉 |
| 「本地桥未运行 —— Codex 现在发不出请求」 | 回「填写凭据」那一步点「启动桥」。正常时这一行是「本地桥正在运行（127.0.0.1:43210）」 |
| 「有一个之前启动的进程还在，但无法确认是否属于本管理器」 | 桥的状态行。记录里有一个之前起过的进程，但无法确认它就是本管理器起的那个。它**不会**贸然去杀 —— 自己确认那是什么再决定 |
| Codex 报 `project-local config keys` 警告 | 那是你**工作目录**里 `.codex/config.toml` 的问题。`model_provider` / `model_providers` 不能在项目级覆盖，Codex 会警告并忽略。本管理器只写用户级文件 |
| Codex 完全加载不了 config | 最可能是某张**手写的**供应商表少了 `name`。少一个 `name` 会让 Codex 拒绝加载**整份**配置，不只是那张表。Codex 设置页会把这样的表点出来 |
| 换了供应商但 Codex 行为没变 | Codex 配置只在启动时读一次。**开新会话**；正在跑的进程不受影响 |
| `codex -m <某模型>` 在桥上失败 | 桥只应答向导里列过的模型。回界面把它加进模型清单 |
| `--profile` 报错 | `config.toml` 里存在同名 `[profiles.*]` 就会直接拒绝。本管理器不写 profile；0.2.0/0.2.1 生成过的那批会在下一次保存时精确删除 |

### 保存相关

| 你看到的 | 含义与做法 |
|---|---|
| 「……已被其他程序或标签页修改。当前草稿尚未写入」 | 并发保护生效了。点「重新读取」，然后重做这次修改。**你的草稿没有写进去，别人的修改也没被覆盖** |
| 「……正在被其他程序持续修改，请稍后重新读取。」 | 有程序在反复写这些文件。等它停下来 |
| 「不能删除唯一模型。先添加替代模型并设为默认。」 | 要整个移除就用「删除供应商」 |
| 「已保存的模型 ID 不可直接改名」 | 加新的、删旧的 |

### 还是不行

把设置页那几行诊断信息（管理器版本、Pi 版本、已验证兼容、配置目录、路径来源、Node）一起贴出来。
**不要上传 `auth.json`、真实 key 或私有供应商导出。**

## 十二、升级与卸载

### 升级（源码安装）

```bash
cd ~/pi-provider-manager-ui && git pull && npm run setup
```

转发脚本不用重装也能生效（它每次执行仓库里当前那一份），但 `npm run setup` 会顺手确认这一点。
**已经在跑的服务不会自动换版本** —— 启动器复用它时会告诉你怎么重启：

```
kill <pid> && '<launcher>'
```

### 升级（归档安装）

下载新归档、解包、运行新目录里的启动器。旧目录可以直接删。别给归档装转发脚本。

### 卸载

```bash
rm -f ~/.pi/agent/bin/pi-provider-manager-ui   # 转发脚本，删掉无副作用
rm -rf ~/pi-provider-manager-ui                # 仓库
```

**你的配置不会跟着消失** —— `~/.pi/agent` 和 `~/.codex` 是 Pi 和 Codex 自己的文件，本程序只是
编辑过它们。想连管理器自己的供应商库一起清掉，再删
`~/.codex/pi-provider-manager-*`（`store.json` / `litellm.yaml` / `bridge.json` /
`bridge.log`）—— 注意 store 里存着未生效供应商的 key，删了就找不回来。

## 十三、安全边界

- 服务只监听 `127.0.0.1`。
- API 请求必须带白名单内的 loopback `Host`；写请求还必须是 `application/json` —— 防止外部网页
  用跨域简单请求改你的配置。
- **已有 key 不会出现在浏览器响应里。** 界面只能看到「凭据已配置」。
- 新 key 只在保存动作里提交。
- 管理器自己的供应商库权限 `0600`；桥日志也是 `0600`（它捕获 LiteLLM 自己的输出，一条 traceback
  就可能带出上游 key）。
- 后端测试全部用临时目录和假 key。

完整威胁边界与漏洞披露方式见 [SECURITY.md](../SECURITY.md)。
