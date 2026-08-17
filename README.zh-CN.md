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

因此本项目不是普通的“供应商切换器”，而是把 Pi 的 provider/model/thinking 关系做成小白也能理解的本地工作流。

## 项目亮点

- **Pi 原生语义**：直接管理 provider、模型 ID、思考强度、图像能力、上下文、最大输出和模型级协议覆盖。
- **适合聚合网关**：一个类似 OpenRouter 的网关可以挂载多个上游厂商模型。
- **key 不回传浏览器**：已有 key 只保存在服务端和 Pi 的 `auth.json`，前端只能看到“已配置”。
- **三文件原子写入与回滚**：写入前校验，失败时回滚，避免半配置状态。
- **面向 Pi 更新**：编辑已知字段时保留未知 provider/model/settings 字段，降低升级时的数据损失风险。
- **保存后有明确闭环**：显示准确的 `pi --model provider/model:thinking` 命令，并指导用户用 `/model` 验证。
- **适合长模型清单**：表头吸顶、内部滚动、批量粘贴模型 ID，并提示 `-max/-xhigh` 可能只是 thinking level。
- **真实设置页**：可修改默认 provider/model/thinking、传输方式、thinking 显示，并查看 Pi 版本和兼容状态。
- **不锁定数据**：Pi 自己的配置文件始终是唯一事实来源，程序不会修改 `models-store.json`。

## 启动

```bash
git clone <你的仓库地址> ~/pi-provider-manager-ui
cd ~/pi-provider-manager-ui
npm ci
npm run build
install -m 700 bin/pi-provider-manager-ui ~/.pi/agent/bin/pi-provider-manager-ui
~/.pi/agent/bin/pi-provider-manager-ui
```

启动器会复用已运行的管理器，或在 `43127-43146` 中自动选择空闲端口，再用 Windows 默认浏览器打开。复用前会检查 `/api/state` 身份，不会把同端口的其他应用误认成本项目。

如果仓库不在 `~/pi-provider-manager-ui`，请先把 `PI_PROVIDER_MANAGER_PROJECT_DIR` 设置为仓库绝对路径。

### 自动识别与环境变量覆盖

| 环境变量 | 自动默认值 | 用途 |
|---|---|---|
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi 的 auth/models/settings 配置目录 |
| `PI_PROVIDER_MANAGER_PROJECT_DIR` | 当前匹配仓库，其次 `~/pi-provider-manager-ui` | 项目与构建产物位置 |
| `PI_PROVIDER_MANAGER_PORT` | 从 `43127-43146` 自动选择 | 严格指定本地服务端口 |
| `PI_PROVIDER_MANAGER_NODE` | 当前 `node` 可执行文件 | 隐藏 WSL 服务使用的 Node 路径 |
| `PI_PROVIDER_MANAGER_OPEN_BROWSER` | `1` | 设为 `0` 时只启动服务，不自动打开浏览器 |
| `WSL_DISTRO_NAME` | WSL 自动提供 | Windows 隐藏启动时使用的发行版 |

监听地址固定为 `127.0.0.1`，不会自动开放到局域网或公网。

专用端口段还可以避开 Vite 常用的 `4173` origin 上残留的旧 Service Worker 和站点缓存。

## 安全边界

- 服务只监听 `127.0.0.1`
- 已有 key 不会出现在浏览器响应中
- 新 key 仅在保存动作中提交
- 后端测试全部使用临时目录和假 key
- 禁止在 GitHub Issue 中上传 `auth.json`、真实 key 或私有供应商导出

## Pi 兼容性

当前本地验证版本：Pi `0.84.2`。

未知字段会被保留，但 Pi 如果修改配置结构、API 类型、认证格式、模型能力字段或设置名称，本项目仍需要发布对应兼容更新。详见 [docs/compatibility.md](docs/compatibility.md)。

## 开源前

代码、CI、安全说明和贡献指南会准备好，但不会替你选择许可证，也不会自动推送到 GitHub。

公开前请完成 [OPEN_SOURCE_CHECKLIST.md](OPEN_SOURCE_CHECKLIST.md)。

## 路线图

- V1.1：可视化 provider/model 管理、真实设置页、保存闭环、保留未知字段
- V2：CSV 导入和 CC-Switch 配置导入
- 后续：经用户明确授权的模型目录发现与连接测试
