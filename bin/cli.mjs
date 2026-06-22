#!/usr/bin/env node
import fs from "node:fs";
import { buildCatalog, writeCatalog } from "../src/catalog.mjs";
import { extractApiKey, providerKind, readCodexProviders, readProxyConfig } from "../src/ccswitch.mjs";
import { installCodexConfig, restoreCodexConfig, writeCodexProfile } from "../src/codex-config.mjs";
import { unifyCodexHistory } from "../src/history-unify.mjs";
import { installLaunchdService, uninstallLaunchdService } from "../src/launchd.mjs";
import { CATALOG_PATH, CCSWITCH_DB, CODEX_CONFIG_PATH, DEFAULT_HOST, DEFAULT_PORT } from "../src/paths.mjs";
import { startServer } from "../src/server.mjs";

const command = process.argv[2] || "help";

function printHelp() {
  console.log(`codex-ccswitch-gateway

Usage:
  codex-ccswitch-gateway doctor
  codex-ccswitch-gateway catalog
  codex-ccswitch-gateway refresh
  codex-ccswitch-gateway start
  codex-ccswitch-gateway profile
  codex-ccswitch-gateway install   # disabled: refuses to patch ~/.codex/config.toml
  codex-ccswitch-gateway restore
  codex-ccswitch-gateway history-unify [--dry-run]
  codex-ccswitch-gateway service-install
  codex-ccswitch-gateway service-uninstall

Environment:
  CODEX_CCSWITCH_HOST      default ${DEFAULT_HOST}
  CODEX_CCSWITCH_PORT      default ${DEFAULT_PORT}
  CCSWITCH_DB              default ${CCSWITCH_DB}
  CODEX_CCSWITCH_CATALOG   default ${CATALOG_PATH}
`);
}

function summarizeProviders() {
  return readCodexProviders().map((p) => ({
    id: p.id,
    name: p.name,
    kind: providerKind(p),
    endpoints: p.endpoints,
    hasApiKey: Boolean(extractApiKey(p)),
    isCurrent: p.isCurrent
  }));
}

async function main() {
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "doctor") {
    const providers = summarizeProviders();
    const catalog = buildCatalog();
    const proxyConfig = readProxyConfig();
    console.log(JSON.stringify({
      ok: true,
      ccSwitchDb: { path: CCSWITCH_DB, exists: fs.existsSync(CCSWITCH_DB) },
      codexConfig: { path: CODEX_CONFIG_PATH, exists: fs.existsSync(CODEX_CONFIG_PATH) },
      catalog: { path: CATALOG_PATH, modelCount: catalog.models.length, models: catalog.models.map((m) => m.slug) },
      ccSwitchProxyConfig: proxyConfig,
      providers
    }, null, 2));
    return;
  }

  if (command === "catalog") {
    const catalog = buildCatalog();
    const out = writeCatalog(catalog);
    console.log(JSON.stringify({ ok: true, path: out, modelCount: catalog.models.length, models: catalog.models.map((m) => m.slug) }, null, 2));
    return;
  }

  if (command === "refresh") {
    const catalog = buildCatalog();
    const out = writeCatalog(catalog);
    let reload = null;
    try {
      const response = await fetch(`http://${DEFAULT_HOST}:${DEFAULT_PORT}/admin/reload`, { method: "POST" });
      reload = await response.json();
    } catch (error) {
      reload = { ok: false, error: error.message || String(error) };
    }
    console.log(JSON.stringify({
      ok: true,
      path: out,
      modelCount: catalog.models.length,
      models: catalog.models.map((m) => m.slug),
      gatewayReload: reload
    }, null, 2));
    return;
  }

  if (command === "start") {
    writeCatalog(buildCatalog());
    startServer();
    return;
  }

  if (command === "install") {
    writeCatalog(buildCatalog());
    installCodexConfig();
    return;
  }

  if (command === "profile") {
    writeCatalog(buildCatalog());
    const profilePath = writeCodexProfile();
    console.log(JSON.stringify({
      ok: true,
      message: "Wrote Codex profile using provider id 'custom'. Test with: codex -p ccswitch-gateway",
      profilePath,
      catalogPath: CATALOG_PATH,
      gatewayUrl: `http://${DEFAULT_HOST}:${DEFAULT_PORT}`
    }, null, 2));
    return;
  }

  if (command === "restore") {
    restoreCodexConfig();
    console.log(JSON.stringify({ ok: true, message: "Removed codex-ccswitch-gateway managed block from Codex config." }, null, 2));
    return;
  }

  if (command === "history-unify") {
    const result = unifyCodexHistory({ dryRun: process.argv.includes("--dry-run") });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "service-install") {
    writeCatalog(buildCatalog());
    const service = installLaunchdService();
    console.log(JSON.stringify({
      ok: true,
      message: "Installed and started user launchd service.",
      ...service,
      gatewayUrl: `http://${DEFAULT_HOST}:${DEFAULT_PORT}`
    }, null, 2));
    return;
  }

  if (command === "service-uninstall") {
    const service = uninstallLaunchdService();
    console.log(JSON.stringify({
      ok: true,
      message: "Stopped and removed user launchd service.",
      ...service
    }, null, 2));
    return;
  }

  printHelp();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
