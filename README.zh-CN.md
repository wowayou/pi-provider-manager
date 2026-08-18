# Pi Provider Manager

[English](README.md)

一个专注于 Pi 的本地模型目录与 API 网关管理器。它不建立自己的数据库，也不替代 Pi，而是安全、可视化地维护 Pi 原生的 `auth.json`、`models.json` 和 `settings.json`。

## 我们解决的核心问题

Pi 在运行时以模型为中心，但配置不是“只有模型”：

- 会话最终选择的是具体 `provider/model`
- thinking level 与模型 ID 分离
- key 和默认接口协议属于 provider
- 一个 provider 可以包含多个模型
- 混合协议网关可以为单个模型覆盖 API 类型

因此本项目不是普通的“网关切换器”，而是把 Pi 的 provider/model/thinking 关系做成小白也能理解的本地工作流。

## 项目亮点

- **Pi 原生语义**：直接管理 provider、模型 ID、思考强度、图像能力、上下文、最大输出，以及模型级协议和 API 地址覆盖。
- **适合聚合网关**：一个类似 OpenRouter 的网关可以挂载多个上游厂商模型。
- **按需读取模型目录**：只有用户主动点击时，服务端才会使用当前凭据检测连接并读取远程模型目录；结果可去重导入，不会自动保存配置。
- **key 不回传浏览器**：已有 key 只保存在服务端和 Pi 的 `auth.json`，前端只能看到“已配置”。
- **三文件原子写入与回滚**：写入前校验，失败时回滚，避免半配置状态。
- **面向 Pi 更新**：编辑已知字段时保留未知 provider/model/settings 字段，降低升级时的数据损失风险。
- **保存后有明确闭环**：显示准确的 `pi --model provider/model:thinking` 命令，并指导用户用 `/model` 验证。
- **适合长模型清单**：表头吸顶、内部滚动、批量粘贴模型 ID，并提示 `-max/-xhigh` 可能只是 thinking level。
- **网关生命周期完整**：删除供应商网关前会弹窗明确确认；删除时同步清理对应凭据，并自动维护 Pi 的默认模型引用。
- **真实设置页**：可修改默认 provider/model/thinking、传输方式、thinking 显示，并查看 Pi 版本和兼容状态。
- **不锁定数据**：Pi 自己的配置文件始终是唯一事实来源，程序不会读取或写入 `models-store.json`。

## 管理的文件

- `~/.pi/agent/auth.json`
- `~/.pi/agent/models.json`
- `~/.pi/agent/settings.json`

`models-store.json` 不在本管理器的职责范围内，程序既不读取也不写入它。

## 混合协议网关

一个供应商网关仍只需要一份凭据，但不同协议不一定共用同一个基础地址。OpenAI 兼容接口通常使用类似 `https://gateway.example/v1` 的地址；Anthropic SDK 会自行请求 `/v1/messages`，所以它的基础地址通常是 `https://gateway.example`，不能简单复用前者。

本管理器因此同时支持 provider 默认协议/地址和模型级协议/地址覆盖。例如，把 OpenAI 设为默认协议并填写带 `/v1` 的默认地址，再为 Claude 模型把协议改为 `anthropic-messages`、把模型 API 地址改为不带 `/v1` 的网关根地址。模型仍属于同一个供应商网关（provider），并共用同一份 key。

模型 API 地址留空表示继承 provider 默认地址；仅覆盖协议不会自动猜测或改写 URL。

## 网关配置建议

把 provider 当作“供应商网关入口”而不是单一上游厂商：一个入口通常只需要一份凭据、一个默认协议和一个默认 Base URL，再在模型列表中挂载多个上游模型。推荐先用网关文档确认协议与地址，再添加模型；不要把具体请求路径（如 `/chat/completions` 或 `/messages`）填进 Base URL。

高级兼容设置只在网关混用协议、或同一协议的模型位于不同地址根目录时使用。模型协议和地址都留空时完整继承网关默认值；只改协议不会替你猜测 URL。

填写地址与凭据后，可以主动执行一次“检测并读取目录”。服务端会根据协议请求模型目录，8 秒超时、限制响应大小且不跟随重定向；已有 key 不会返回浏览器。目录端点返回 `404` 只表示不能自动列出模型，不代表手动填写的模型一定不可调用。导入目录只修改当前表单，仍需用户保存才会写入 Pi。

删除网关会打开确认弹窗，明确列出将移除的模型、凭据和默认引用；确认后才会原子修改 `models.json`、`auth.json` 和 `settings.json`。

## 下拉菜单与选择控件

有限选项的下拉菜单统一使用共享的 `SelectControl`。它仍然是原生 `select`，只是用统一的箭头、焦点、悬停、禁用和暗色样式包起来，因此键盘操作、读屏语义和手机系统选择器都保持可靠。

这不代表所有选择都必须做成下拉菜单：协议卡片和外观切换使用原生 radio，因为选项需要直接可见；供应商筛选和批量模型导入使用文本输入。只有未来需要可搜索、多选的大型目录筛选时，才考虑自定义 combobox，并单独做可访问性与移动端评审。

## 在 Linux 或 WSL 本地启动

```bash
git clone https://github.com/wowayou/pi-provider-manager.git ~/pi-provider-manager-ui
cd ~/pi-provider-manager-ui
npm ci
npm run build
install -m 700 bin/pi-provider-manager-ui ~/.pi/agent/bin/pi-provider-manager-ui
~/.pi/agent/bin/pi-provider-manager-ui
```

启动器会复用已运行的管理器，或在 `43127-43146` 中自动选择空闲端口。在 WSL 下会打开 Windows 默认浏览器；其他环境会使用可用的 WSL/PowerShell 浏览器桥接，若都不存在则输出本地 URL。复用前会检查 `/api/state` 身份，不会把同端口的其他应用误认成本项目。

查看状态或停止后台服务：

```bash
~/.pi/agent/bin/pi-provider-manager-ui status
~/.pi/agent/bin/pi-provider-manager-ui stop
```

`stop` 会先验证端口上运行的确实是 Pi Provider Manager，再通过本地 API 请求它正常退出；对于还没有停止接口的旧版本，确认监听进程是 `server.mjs` 后发送 `TERM`。未运行时也会安全返回。如果启动时设置了自定义 `PI_PROVIDER_MANAGER_PORT`，停止时使用同一个环境变量。

如果仓库不在 `~/pi-provider-manager-ui`，请先把 `PI_PROVIDER_MANAGER_PROJECT_DIR` 设置为仓库绝对路径。

### 自动识别与环境变量覆盖

| 环境变量 | 自动默认值 | 用途 |
|---|---|---|
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi 的 auth/models/settings 配置目录 |
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

## Pi 兼容性

本管理器验证过的 Pi 版本只记录在一处 —— `package.json` 的 `piValidatedVersion`，并在设置页与实际检测到的 Pi 版本并列显示；两者不一致时设置页会直接说明。

未知字段会被保留，但 Pi 如果修改配置结构、API 类型、认证格式、模型能力字段或设置名称，本项目仍需要发布对应兼容更新。每个版本都会跑 [docs/compatibility.md](docs/compatibility.md) 里的兼容性清单，并在 release notes 中写明验证过的 Pi 版本。

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
npm run test:sites
npm run test:pi-update
```

使用 `/?demo=1` 进入不会写配置的视觉和交互 demo。

普通开发命令会启动真实、可写的 API；如果不希望修改日常 Pi 配置，请先把 `PI_CODING_AGENT_DIR` 指向临时目录。只有 demo 模式和 Sites 产物是不可写路径。

## 开源状态

项目使用 [MIT License](LICENSE) 开源。首次推送后的仓库加固事项见 [OPEN_SOURCE_CHECKLIST.md](OPEN_SOURCE_CHECKLIST.md)。

## 路线图

- 已完成 V1.1：可视化 provider/model 管理、真实设置页、保存闭环、保留未知字段
- 计划 V2：取得真实脱敏样本格式后，再实现 CSV 和 CC-Switch 配置导入
- 已完成：用户主动授权的连接检测与远程模型目录导入
- 后续：针对超大目录的筛选导入与单模型真实推理探测

视觉对照、交互验证和历史 QA 记录见 `design-qa.md` 与 `qa/`。
