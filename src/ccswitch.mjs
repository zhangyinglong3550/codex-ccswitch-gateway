import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { CCSWITCH_DB } from "./paths.mjs";

function sqliteJson(sql, dbPath = CCSWITCH_DB) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`CC Switch DB not found: ${dbPath}`);
  }
  const out = execFileSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return out.trim() ? JSON.parse(out) : [];
}

export function readProxyConfig() {
  const rows = sqliteJson(`
    select app_type, proxy_enabled, listen_address, listen_port, enabled
    from proxy_config
    where app_type = 'codex'
    limit 1;
  `);
  return rows[0] || null;
}

export function readCodexProviders() {
  const rows = sqliteJson(`
    select
      p.id,
      p.name,
      p.is_current,
      p.in_failover_queue,
      p.provider_type,
      p.category,
      p.settings_config,
      p.meta,
      group_concat(e.url, char(10)) as endpoints
    from providers p
    left join provider_endpoints e
      on e.provider_id = p.id and e.app_type = p.app_type
    where p.app_type = 'codex'
    group by p.id, p.name, p.is_current, p.in_failover_queue, p.provider_type, p.category, p.settings_config, p.meta
    order by p.sort_index, p.name;
  `);

  return rows.map((row) => {
    let settings = {};
    let meta = {};
    try {
      settings = JSON.parse(row.settings_config || "{}");
    } catch {
      settings = {};
    }
    try {
      meta = JSON.parse(row.meta || "{}");
    } catch {
      meta = {};
    }
    return {
      id: row.id,
      name: row.name,
      isCurrent: row.is_current === 1,
      inFailoverQueue: row.in_failover_queue === 1,
      providerType: row.provider_type || "",
      category: row.category || "",
      endpoints: String(row.endpoints || "").split("\n").filter(Boolean),
      settings,
      meta
    };
  });
}

export function extractApiKey(provider) {
  const auth = provider?.settings?.auth || {};
  return auth.OPENAI_API_KEY || auth.api_key || auth.apiKey || "";
}

export function extractModelCatalog(provider) {
  const catalog = provider?.settings?.modelCatalog;
  if (!catalog) return [];
  if (Array.isArray(catalog.models)) return catalog.models;
  if (Array.isArray(catalog)) return catalog;
  return [];
}

export function extractConfiguredModel(provider) {
  const config = provider?.settings?.config || "";
  if (typeof config !== "string") return "";
  const match = config.match(/^\s*model\s*=\s*"([^"]+)"/m);
  return match?.[1] || "";
}

export function extractWireApi(provider) {
  const config = provider?.settings?.config || "";
  if (typeof config !== "string") return "";
  const match = config.match(/^\s*wire_api\s*=\s*"([^"]+)"/m);
  return (match?.[1] || "").toLowerCase();
}

export function extractApiFormat(provider) {
  return String(provider?.settings?.apiFormat || provider?.meta?.apiFormat || "").toLowerCase();
}

export function extractCodexChatReasoning(provider) {
  const config = provider?.settings?.codexChatReasoning || provider?.meta?.codexChatReasoning;
  return config && typeof config === "object" ? config : {};
}

export function providerKind(provider) {
  const name = String(provider?.name || "").toLowerCase();
  if (name.includes("openai official")) return "official";
  if (name.includes("deepseek")) return "deepseek";
  if (name.includes("mimo") || name.includes("xiaomi")) return "mimo";
  if (name.includes("opencode")) return "opencode";
  if (name.includes("火山") || name.includes("volc") || name.includes("agentplan")) return "volcengine";
  return "custom";
}
