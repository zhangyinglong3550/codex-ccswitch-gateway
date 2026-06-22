# Codex CC Switch Gateway

一个本机 Codex 模型网关，用来在 Codex App / Codex CLI 里同时选择官方 GPT 模型和 CC Switch 中配置的第三方模型。

适合已经使用 [CC Switch](https://github.com/chenyueban/cc-switch) 管理第三方模型的人。你可以在 Codex 的同一个模型列表里选择 DeepSeek、GLM、Kimi、MiMo、火山等模型，不需要手动改 `~/.codex/config.toml`。

## 功能

- 从 `~/.cc-switch/cc-switch.db` 读取 Codex provider、endpoint 和模型目录。
- 生成 Codex 可读取的模型目录：`~/.codex-ccswitch-gateway/model-catalog.json`。
- 在本机启动 OpenAI Responses 兼容接口：`http://127.0.0.1:15721`。
- 官方 GPT 模型转发到本机 Codex / ChatGPT 登录态，或 `OPENAI_API_KEY`。
- 对只支持 Chat Completions 的第三方 provider，把 Codex Responses 请求转换成 `/chat/completions` 请求。
- 兼容 Codex App 中浏览器、Chrome 等工具调用历史。
- 读取 CC Switch 中的思考能力配置，包括思考模式和思考等级。
- 使用 Codex provider id `custom`，让官方模型和第三方模型尽量共享同一个会话历史列表。

## 已支持的路由

| Provider 类型 | 上游协议 | 说明 |
|---|---:|---|
| 官方 GPT | Responses | 依赖 Codex / ChatGPT 登录态或 `OPENAI_API_KEY`；Codex App 通常使用流式请求。 |
| DeepSeek | Chat Completions | 兼容 `reasoning_content` 和工具历史。 |
| Xiaomi MiMo | Chat Completions | 将 `reasoning_content` 转回 Codex Responses reasoning。 |
| openCode go | Chat Completions | 已兼容 GLM/Kimi；`qwen3.7-max` 因上游不支持 `oa-compat` 默认隐藏。 |
| 火山 Agentplan / Coding plan | Responses | 保留 `/api/plan/v3` 和 `/api/coding/v3` 路由选择。 |

## 环境要求

- macOS。
- Node.js 18 或更高版本。
- 系统能运行 `sqlite3`。
- 已安装并配置 CC Switch。
- 已安装 Codex App 或 Codex CLI。
- 官方 GPT 需要已登录 Codex / ChatGPT，或者设置 `OPENAI_API_KEY`。

本项目不会保存 API Key。密钥仍然留在 CC Switch、Codex auth 文件或你的 shell 环境变量中。

## 安装

```bash
git clone https://github.com/zhangyinglong3550/codex-ccswitch-gateway.git
cd codex-ccswitch-gateway
npm run doctor
npm run service:install
npm run profile
```

`npm run profile` 会写入：

```text
~/.codex/ccswitch-gateway.config.toml
```

它不会修改你的主配置：

```text
~/.codex/config.toml
```

## 在 Codex App 中使用

1. 启动本机网关：

   ```bash
   cd codex-ccswitch-gateway
   npm run service:install
   ```

2. 确认 profile 已生成：

   ```bash
   npm run profile
   ```

3. 打开或重启 Codex App。

4. 在模型选择器里选择官方 GPT 或第三方模型。

网关地址：

```text
http://127.0.0.1:15721/v1
```

## 在 Codex CLI 中使用

```bash
codex -p ccswitch-gateway
```

## 添加或刷新模型

模型来源是 CC Switch，不是在本仓库里手写。

1. 打开 CC Switch。
2. 添加或编辑 Codex provider。
3. 在 CC Switch 里填写 base URL 和 API Key。
4. 如果 provider 是 OpenAI Chat Completions 兼容接口，而不是原生 Responses API，开启本地路由映射。
5. 如果模型支持思考能力，再按供应商真实能力开启思考模式 / 思考等级。
6. 回到本项目执行：

   ```bash
   cd codex-ccswitch-gateway
   npm run refresh
   ```

7. 如果 Codex App 模型列表仍没变化，重启 Codex App。

## 常用命令

```bash
npm run doctor
npm run catalog
npm run refresh
npm run profile
npm run service:install
npm run service:uninstall
npm run history:unify:dry-run
npm run history:unify
npm run electron
```

## 健康检查

```bash
curl -s http://127.0.0.1:15721/health
curl -s http://127.0.0.1:15721/v1/models
curl -s http://127.0.0.1:15721/v1/config
```

流式 smoke test：

```bash
curl -s -N http://127.0.0.1:15721/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.4-mini","stream":true,"input":"只回复 OK"}'
```

## 会话历史

Codex 会按 `model_provider` 分组显示会话。这个网关使用 `custom`，因此官方模型和第三方模型可以尽量出现在同一个历史列表中。

预览历史迁移影响：

```bash
npm run history:unify:dry-run
```

执行迁移：

```bash
npm run history:unify
```

备份目录：

```text
~/.codex-ccswitch-gateway/history-unify-backups/
```

## 排障

### 官方 GPT 在原生 Codex 可用，但通过网关失败

Codex App 通常发送流式请求。ChatGPT Codex 后端对非流式请求可能返回：

```text
Stream must be set to true
```

测试时请带上 `stream: true`。

如果看到 `fetch failed`，优先检查本机代理、DNS、ProxyBridge 或公司网络策略。网关默认不强制公共 DNS，也不接管系统代理。

### openCode go 报 `cannot specify both 'thinking' and 'reasoning_effort'`

网关已经对 `opencode` provider 做了兼容：发送 `thinking` 时不会再同时发送 `reasoning_effort`。更新后执行：

```bash
npm run service:install
```

### Kimi 在工具调用后报 `tool_call_id` 或 `tool_calls`

网关已经对 `opencode + Kimi` 做了专门兼容：旧工具调用历史会压成普通文本上下文，同时保留当前轮工具定义。更新后执行：

```bash
npm run service:install
```

### 火山报缺少 `input.content.text`

网关会在转发到火山 Responses API 前规整 message content。更新后执行：

```bash
npm run service:install
```

### 新增模型没有出现

```bash
npm run refresh
```

如果 Codex App 仍显示旧列表，重启 Codex App。

## Electron 桌面控制台

一个桌面控制台，不用敲命令也能管理网关。打开就自动启动后台网关服务，关掉控制台网关也继续运行。

### 下载安装（普通用户）

1. 下载 `Codex CC Switch Gateway-x.x.x-arm64.dmg`（GitHub Releases 页面）
2. 打开 dmg，把 app 拖到「应用程序」
3. 打开 app
4. 首次打开会自动安装 launchd 后台服务并启动网关
5. 在 CC Switch 里配置好 provider 后，重启 Codex App 即可使用

不需要安装 Node.js，不需要 clone 仓库，不需要跑任何命令。

### 从源码运行（开发者）

```bash
git clone https://github.com/zhangyinglong3550/codex-ccswitch-gateway.git
cd codex-ccswitch-gateway
npm install
npm run electron
```

如果 Electron 二进制下载失败，设置镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```

### 打包成 dmg

```bash
npm run dist
```

生成的 dmg 在 `dist/` 目录下。

### 功能

- **状态**：网关健康检查、模型数、provider 数、CC Switch DB 信息
- **模型**：从 `/v1/models` 拉取模型列表、`/v1/config` 查看 provider 配置、读取本地 catalog
- **服务**：安装 / 卸载 / 重启 launchd 服务、查看服务状态
- **模型测试**：向任意模型发送测试请求，验证连通性
- **日志**：实时查看网关 stdout 和 stderr 日志
- **设置**：关键路径展示、DB 自动监听开关

### 自动启动

打开控制台时，如果网关未运行，会自动安装 launchd 后台服务并启动。关闭控制台后网关继续运行。重启 Mac 后网关也会自动启动（launchd 的 RunAtLoad 和 KeepAlive）。

### 自动刷新

控制台监听 `~/.cc-switch/cc-switch.db` 的文件变化。当 CC Switch 更新 provider 后，控制台自动刷新 catalog 并通知网关 reload。

### 安全边界

控制台**不会**：

- 新增、编辑或删除 CC Switch provider
- 存储或展示 API Key
- 修改 `~/.codex/config.toml`
- 编辑 `~/.cc-switch/cc-switch.db`

它只读取网关状态并调用现有 CLI 命令。

### 开发调试

```bash
# 语法检查
npm run electron:check

# 自检模式（不启动 UI，执行所有 IPC handler 并输出 JSON）
./node_modules/.bin/electron electron/main.mjs --self-test

# 截图模式（启动 UI，自动切换标签页截图）
./node_modules/.bin/electron electron/main.mjs --screenshot
```

## 安全说明

不要提交或分享：

- `~/.cc-switch/cc-switch.db`
- `~/.codex/auth.json`
- 含私有 provider 信息的 `~/.codex/config.toml`
- `~/.codex-ccswitch-gateway/*.log`
- API Key、Bearer Token、Cookie
- 从 CC Switch 复制出来的完整 provider JSON

详见 [SECURITY.md](./SECURITY.md)。

## 许可证

MIT
