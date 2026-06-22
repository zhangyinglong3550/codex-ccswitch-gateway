# Codex CC Switch Gateway Electron 控制台使用指南

## 这是什么

一个本地桌面控制台，让你不用敲命令也能管理 Codex CC Switch Gateway。

## 前置条件

- macOS
- Node.js 18+
- CC Switch 已安装并配置好 Codex provider
- 网关服务已安装（`npm run service:install`）

## 安装

```bash
cd codex-ccswitch-gateway
npm install
```

## 启动

```bash
npm run electron
```

## 页面说明

### 状态页

打开后自动检测网关是否在线、模型数、provider 数、CC Switch DB 是否存在。

按钮：
- **立即刷新**：重新构建 catalog 并通知网关 reload
- **运行 doctor**：执行 `npm run doctor`，输出诊断信息
- **生成 profile**：执行 `npm run profile`，写入 `~/.codex/ccswitch-gateway.config.toml`
- **重新拉取**：刷新状态卡片

### 模型页

- **拉取模型**：从 `/v1/models` 获取模型列表，表格展示 slug、provider、类型、wire API、是否有 key
- **读取本地 catalog**：直接读 `~/.codex-ccswitch-gateway/model-catalog.json`
- **拉取 /v1/config**：展示所有 provider 的配置详情
- 点击表格行可跳转到模型测试页

### 服务页

- **安装并启动**：`npm run service:install`，安装 launchd 服务并启动
- **停止并卸载**：`npm run service:uninstall`，停止并移除 launchd plist
- **重启**：先卸载再安装
- **刷新状态**：读取 `launchctl print` 判断服务是否运行

### 模型测试页

1. 从下拉框选择模型（或从模型页点击表格行跳转）
2. 修改 prompt（默认 "只回复 OK"）
3. 勾选/取消流式
4. 点击"运行测试"

结果框会显示成功（绿色边框）或失败（红色边框），以及返回内容或错误信息。

已验证可测试的模型：
- 官方 GPT：gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5.2
- opencode go：glm-5.2, kimi-k2.7-code
- DeepSeek：deepseek-v4-pro, deepseek-v4-flash
- 火山：volcengine-glm-5.2
- 小米：mimo-v2.5-pro

### 日志页

- 读取 `~/.codex-ccswitch-gateway/gateway.out.log` 和 `gateway.err.log`
- 勾选"自动刷新"每 4 秒重新读取
- 默认显示最后 400 行

### 设置页

- 展示所有关键路径（项目根、CLI、Node、网关地址、DB 路径等）
- 点击路径可在 Finder 中定位
- 自动监听 DB 开关：开启后监听 `~/.cc-switch/cc-switch.db` 变化，自动触发 catalog 刷新和网关 reload

## 自动刷新机制

控制台使用 `fs.watchFile` 轮询 CC Switch DB 文件。当 DB 的 mtime 或 size 变化时：

1. 通知渲染层显示"DB 变化，刷新中"
2. 调用 `POST /admin/reload` 让网关重新读取 providers
3. 执行 `npm run refresh` 重建 catalog
4. 通知渲染层刷新当前页面

防抖延迟 600ms，避免 CC Switch 连续写入时频繁刷新。

## 排障

### 打开后显示"网关离线"

1. 检查服务页是否显示"运行中"
2. 如果未安装，点击"安装并启动"
3. 如果已安装但未运行，点击"重启"
4. 检查端口 15721 是否被占用：`lsof -i :15721`

### 模型测试失败

- 官方 GPT 失败：确认 Codex App 已登录，或设置了 `OPENAI_API_KEY`。官方 GPT 需要流式请求。
- DeepSeek/GLM/Kimi 失败：检查 CC Switch 里 provider 的 base URL 和 API key 是否正确。
- 火山 GLM 失败：确认 provider 名称包含"火山"或"coding"。

### 自动刷新不触发

- 确认设置页"自动监听 DB"开关已开启
- CC Switch 写入 DB 后可能需要 2-3 秒被检测到（轮询间隔 2 秒）
- 也可以手动点击"立即刷新"

### Electron 无法启动

- 确认 `npm install` 成功（Electron 二进制已下载）
- 检查 `node_modules/electron/dist/Electron.app` 是否存在
- 如果下载失败，设置镜像：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`

## 安全注意事项

控制台**不会**：
- 新增、编辑或删除 CC Switch provider
- 存储或展示完整 API Key（只显示"有/无"）
- 修改 `~/.codex/config.toml`
- 编辑 `~/.cc-switch/cc-switch.db`

控制台**只做**：
- 读取网关 HTTP 端点（/health, /v1/models, /v1/config）
- 调用现有 CLI 命令（refresh, doctor, profile, service-install, service-uninstall）
- 读取日志文件和 catalog 文件
- 监听 DB 文件的 mtime/size 变化

## 开发调试

```bash
# 语法检查
npm run electron:check

# 自检模式（不启动 UI，执行所有 IPC handler 并输出 JSON）
./node_modules/.bin/electron electron/main.mjs --self-test

# 截图模式（启动 UI，自动切换标签页截图）
./node_modules/.bin/electron electron/main.mjs --screenshot
```

## 技术架构

```
electron/
  main.mjs        # 主进程：IPC handler、网关 HTTP 调用、CLI 调用、DB 监听
  preload.cjs     # 预加载：contextBridge 暴露安全 API
  renderer/
    index.html    # 页面结构
    style.css     # 暗色工具型视觉
    app.js        # 渲染层逻辑：标签切换、数据加载、按钮绑定
```

主进程通过 `execFile` 调用 `node bin/cli.mjs <command>`，通过 `fetch` 调用网关 HTTP 端点。渲染层通过 `contextBridge` 暴露的 `window.api` 与主进程通信，`contextIsolation: true`，`nodeIntegration: false`。
