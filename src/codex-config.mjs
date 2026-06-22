import fs from "node:fs";
import path from "node:path";
import { CATALOG_PATH, CODEX_CONFIG_PATH, CODEX_HOME, DEFAULT_HOST, DEFAULT_PORT, GATEWAY_HOME, MANAGED_BEGIN, MANAGED_END } from "./paths.mjs";

function stripManagedBlocks(content) {
  const pattern = new RegExp(`${escapeRegExp(MANAGED_BEGIN)}[\\s\\S]*?${escapeRegExp(MANAGED_END)}\\n?`, "g");
  return content.replace(pattern, "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeTopLevelKeys(content, keys) {
  const keySet = new Set(keys);
  const lines = content.split(/\r?\n/);
  let inTable = false;
  return lines.filter((line) => {
    if (/^\s*\[/.test(line)) inTable = true;
    if (!inTable) {
      const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
      if (match && keySet.has(match[1])) return false;
    }
    return true;
  }).join("\n");
}

export function installCodexConfig({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  throw new Error("Refusing to patch ~/.codex/config.toml. Use `npm run profile` and test with `codex -p ccswitch-gateway` instead.");
}

export function writeCodexProfile({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  const managed = `${MANAGED_BEGIN}
model_provider = "custom"
model_catalog_json = "${CATALOG_PATH}"
openai_base_url = "http://${host}:${port}/v1"

[model_providers.custom]
name = "CC Switch Gateway"
base_url = "http://${host}:${port}/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "dummy"
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 600000
${MANAGED_END}
`;
  const profilePath = path.join(CODEX_HOME, "ccswitch-gateway.config.toml");
  fs.writeFileSync(profilePath, managed, "utf8");
  return profilePath;
}

export function restoreCodexConfig() {
  if (!fs.existsSync(CODEX_CONFIG_PATH)) {
    throw new Error(`Codex config not found: ${CODEX_CONFIG_PATH}`);
  }
  const content = fs.readFileSync(CODEX_CONFIG_PATH, "utf8");
  const restored = stripManagedBlocks(content).trim() + "\n";
  fs.writeFileSync(CODEX_CONFIG_PATH, restored, "utf8");
}
