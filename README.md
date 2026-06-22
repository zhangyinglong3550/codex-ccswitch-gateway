# Codex CC Switch Gateway

Local gateway for using official Codex/ChatGPT models and custom CC Switch models from the same Codex model list.

It is designed for Codex App and Codex CLI users who already manage third-party model providers in [CC Switch](https://github.com/chenyueban/cc-switch) and want to select models such as DeepSeek, GLM, Kimi, MiMo, or Volcengine from Codex without hand-editing `~/.codex/config.toml`.

## What It Does

- Reads Codex providers from `~/.cc-switch/cc-switch.db`.
- Generates a Codex-compatible model catalog at `~/.codex-ccswitch-gateway/model-catalog.json`.
- Starts a local OpenAI-compatible Responses endpoint on `http://127.0.0.1:15721`.
- Routes official GPT models to the local Codex/ChatGPT login state or `OPENAI_API_KEY`.
- Converts Codex Responses requests to Chat Completions for providers that only expose `/chat/completions`.
- Preserves tool-call history for Codex App browser/Chrome tools where provider APIs allow it.
- Reads CC Switch reasoning metadata, including thinking mode and reasoning effort.
- Uses the `custom` Codex provider id so official and custom models share the same conversation history bucket.

## Supported Routes

| Provider type | Wire API | Notes |
|---|---:|---|
| Official GPT | Responses | Requires Codex/ChatGPT login or `OPENAI_API_KEY`. Codex App normally uses streaming. |
| DeepSeek | Chat Completions | Handles `reasoning_content` and tool history compatibility. |
| Xiaomi MiMo | Chat Completions | Supports thinking output via `reasoning_content`. |
| openCode go | Chat Completions | GLM/Kimi are supported; `qwen3.7-max` is hidden because the upstream rejects `oa-compat`. |
| Volcengine Agentplan/Coding plan | Responses | Preserves `/api/plan/v3` and `/api/coding/v3` endpoint selection. |

## Requirements

- macOS.
- Node.js 18 or newer.
- `sqlite3` available in `PATH`.
- CC Switch installed and configured for Codex providers.
- Codex App or Codex CLI installed.
- Official GPT access through Codex/ChatGPT login, or `OPENAI_API_KEY`.

No API keys are stored in this project. Keys remain in CC Switch, Codex auth, or your shell environment.

## Install

```bash
git clone https://github.com/zhangyinglong3550/codex-ccswitch-gateway.git
cd codex-ccswitch-gateway
npm run doctor
npm run service:install
npm run profile
```

`npm run profile` writes `~/.codex/ccswitch-gateway.config.toml`. It does not patch `~/.codex/config.toml`.

## Use With Codex App

1. Start the gateway:

   ```bash
   cd codex-ccswitch-gateway
   npm run service:install
   ```

2. Make sure the profile exists:

   ```bash
   npm run profile
   ```

3. Restart Codex App if the model list does not refresh.

4. Select a model from the Codex model picker.

The gateway URL is:

```text
http://127.0.0.1:15721/v1
```

## Use With Codex CLI

```bash
codex -p ccswitch-gateway
```

## Add Or Refresh Models

Models come from CC Switch, not from files in this repository.

1. Open CC Switch.
2. Add or edit a Codex provider.
3. Fill in base URL and API key in CC Switch.
4. Enable local route mapping if the provider is OpenAI Chat compatible rather than native Responses.
5. Enable thinking mode / reasoning effort only when the upstream actually supports it.
6. Refresh the gateway:

   ```bash
   cd codex-ccswitch-gateway
   npm run refresh
   ```

7. Restart Codex App if the model picker still shows the old list.

## Useful Commands

```bash
npm run doctor
npm run catalog
npm run refresh
npm run profile
npm run service:install
npm run service:uninstall
npm run history:unify:dry-run
npm run history:unify
```

## Health Checks

```bash
curl -s http://127.0.0.1:15721/health
curl -s http://127.0.0.1:15721/v1/models
curl -s http://127.0.0.1:15721/v1/config
```

Quick streaming smoke test:

```bash
curl -s -N http://127.0.0.1:15721/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.4-mini","stream":true,"input":"只回复 OK"}'
```

## Conversation History

Codex groups conversations by `model_provider`. This gateway uses `custom` so official and custom models can appear in the same history bucket.

To preview historical migration:

```bash
npm run history:unify:dry-run
```

To migrate old local Codex history to `custom`:

```bash
npm run history:unify
```

Backups are written to:

```text
~/.codex-ccswitch-gateway/history-unify-backups/
```

## Troubleshooting

**Official GPT works in Codex but fails through the gateway**

Codex App normally sends streaming requests. Non-streaming requests to the ChatGPT Codex backend may return `Stream must be set to true`. Test with `stream: true`.

If you see `fetch failed`, check local proxy/DNS tools such as ProxyBridge. The gateway does not force a public DNS or proxy.

**openCode go returns `cannot specify both 'thinking' and 'reasoning_effort'`**

This is handled by the gateway for the `opencode` provider: it sends `thinking` without `reasoning_effort`.

**Volcengine returns missing `input.content.text`**

The gateway normalizes Responses message content before forwarding to Volcengine. Run `npm run service:install` after updating to this version.

**A newly added model does not appear**

Run:

```bash
npm run refresh
```

Then restart Codex App if needed.

## Security

Do not commit or share:

- `~/.cc-switch/cc-switch.db`
- `~/.codex/auth.json`
- `~/.codex/config.toml` if it contains local auth or internal provider data
- `~/.codex-ccswitch-gateway/*.log`
- API keys, bearer tokens, cookies, or copied CC Switch provider JSON

See [SECURITY.md](./SECURITY.md).

## License

MIT
