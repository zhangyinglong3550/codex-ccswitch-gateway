# Security Policy

This project is a local gateway. It should never contain real provider credentials.

## Do Not Commit

- CC Switch databases: `~/.cc-switch/cc-switch.db`
- Codex auth files: `~/.codex/auth.json`
- Codex config files that contain private provider data
- Gateway logs
- API keys, bearer tokens, cookies, or copied provider JSON from CC Switch

## Credential Handling

The gateway reads credentials at runtime from:

- CC Switch provider configuration
- Codex/ChatGPT local login state
- `OPENAI_API_KEY`, when provided by the user

These values are not written to this repository by the gateway.

## Reporting

If you find a security issue, open a private report or contact the maintainer directly. Do not publish real tokens or private logs in a public issue.
