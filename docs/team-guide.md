# Codex CC Switch Gateway 同事使用手册

这份手册给内部同事使用，目标是：在 Codex App 里同时选择官方 GPT 模型和 CC Switch 中配置的第三方模型。

## 一句话说明

先在 CC Switch 里配置模型和 API Key，再启动本机 gateway，最后在 Codex App 模型列表里选择模型。

## 安装前准备

需要确认：

- macOS。
- 已安装 Node.js 18 或更高版本。
- 终端能运行 `sqlite3`。
- 已安装并能打开 CC Switch。
- 已安装 Codex App 或 Codex CLI。
- 官方 GPT 需要已登录 Codex/ChatGPT；第三方模型需要在 CC Switch 中配置自己的 API Key。

不要向别人索要或转发 API Key、Cookie、`auth.json`、`cc-switch.db`。

## 安装

```bash
git clone https://github.com/zhangyinglong3550/codex-ccswitch-gateway.git
cd codex-ccswitch-gateway
npm run doctor
npm run service:install
npm run profile
```

安装后 gateway 地址是：

```text
http://127.0.0.1:15721/v1
```

## 在 CC Switch 添加模型

1. 打开 CC Switch。
2. 选择 Codex 应用类型。
3. 添加 provider，例如 DeepSeek、Xiaomi MiMo、openCode go、火山 Agentplan/Coding plan。
4. 填写 base URL 和自己的 API Key。
5. 如果 provider 不是原生 Responses API，而是 OpenAI Chat Completions 兼容接口，开启本地路由映射。
6. 如果模型支持思考，按供应商真实能力开启“支持思考模式”和“支持思考等级”。
7. 保存。

## 刷新 Codex 模型列表

新增或修改模型后执行：

```bash
cd codex-ccswitch-gateway
npm run refresh
```

如果 Codex App 里模型列表还没变，重启 Codex App。

## 使用 Codex App

1. 确认 gateway 正在运行：

   ```bash
   curl -s http://127.0.0.1:15721/health
   ```

2. 打开 Codex App。
3. 在模型选择器里选择官方 GPT 或第三方模型。
4. 切换模型后，历史会话应仍在同一个列表中，因为 gateway 使用 `custom` provider id。

## 使用 Codex CLI

```bash
codex -p ccswitch-gateway
```

## 常用命令

```bash
npm run doctor
npm run service:install
npm run service:uninstall
npm run refresh
npm run profile
```

## 已知兼容策略

- DeepSeek：保留 `reasoning_content`，并在缺失历史 thinking 内容时做兼容转换。
- openCode go：GLM/Kimi 不同时发送 `thinking` 和 `reasoning_effort`，避免上游拒绝。
- 火山 Agentplan/Coding plan：走 Responses 直通，并规整 message content，避免缺 `input.content.text`。
- 小米 MiMo：走 Chat Completions，并把 `reasoning_content` 转为 Codex Responses reasoning。
- 官方 GPT：走本机 Codex/ChatGPT 登录态或 `OPENAI_API_KEY`。

## 排障

### gateway 没启动

```bash
npm run service:install
curl -s http://127.0.0.1:15721/health
```

查看日志：

```bash
tail -n 80 ~/.codex-ccswitch-gateway/gateway.err.log
```

### 新模型看不到

```bash
npm run refresh
```

然后重启 Codex App。

### 官方 GPT 报 `fetch failed`

先确认 Codex 官方模型在原生 Codex App 中是否能用。若原生能用但 gateway 不行，检查本机代理、ProxyBridge、DNS 或公司网络策略。

### 火山报缺 `input.content.text`

更新到最新版，然后执行：

```bash
npm run service:install
```

### openCode go 报 thinking 和 reasoning_effort 冲突

更新到最新版，然后执行：

```bash
npm run service:install
```

## 安全要求

不要提交、发送或截图以下内容：

- API Key
- Bearer Token
- Cookie
- `~/.cc-switch/cc-switch.db`
- `~/.codex/auth.json`
- 带密钥的 `~/.codex/config.toml`
- gateway 日志中可能包含的内部错误上下文

项目本身不需要共享任何个人密钥。同事应该在自己的 CC Switch 里配置自己的 provider。
