import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CODEX_HOME, GATEWAY_HOME } from "./paths.mjs";

const DEFAULT_SOURCE_PROVIDERS = ["openai", "deepseek", "ccswitch_gateway"];
const TARGET_PROVIDER = "custom";

function sqliteJson(dbPath, sql) {
  const out = execFileSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return out.trim() ? JSON.parse(out) : [];
}

function sqliteExec(dbPath, sql) {
  execFileSync("sqlite3", [dbPath, sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function quoteSql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    "_",
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds())
  ].join("");
}

function backupPathFor(root, filePath) {
  const relative = path.relative(CODEX_HOME, filePath);
  return path.join(root, relative.startsWith("..") ? path.basename(filePath) : relative);
}

function backupFile(root, filePath) {
  if (!fs.existsSync(filePath)) return false;
  const target = backupPathFor(root, filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(filePath, target);
  return true;
}

function replaceSessionMetaProvider(filePath, targetProvider) {
  const original = fs.readFileSync(filePath, "utf8");
  const lines = original.split(/\n/);
  let changed = false;
  const next = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const item = JSON.parse(line);
      if (item.type === "session_meta" && item.payload?.model_provider !== targetProvider) {
        item.payload.model_provider = targetProvider;
        changed = true;
        return JSON.stringify(item);
      }
    } catch {
      return line;
    }
    return line;
  }).join("\n");
  if (changed) {
    fs.writeFileSync(filePath, next, "utf8");
  }
  return changed;
}

export function unifyCodexHistory({
  sourceProviders = DEFAULT_SOURCE_PROVIDERS,
  targetProvider = TARGET_PROVIDER,
  dryRun = false
} = {}) {
  const stateDb = path.join(CODEX_HOME, "state_5.sqlite");
  if (!fs.existsSync(stateDb)) {
    throw new Error(`Codex state DB not found: ${stateDb}`);
  }

  const providers = sourceProviders.filter((p) => p && p !== targetProvider);
  const providerList = providers.map(quoteSql).join(", ");
  if (!providerList) {
    throw new Error("No source providers to migrate.");
  }

  const rows = sqliteJson(stateDb, `
    SELECT id, rollout_path, model_provider
    FROM threads
    WHERE model_provider IN (${providerList})
      AND rollout_path IS NOT NULL
      AND rollout_path != ''
    ORDER BY updated_at DESC;
  `);

  const counts = rows.reduce((acc, row) => {
    acc[row.model_provider] = (acc[row.model_provider] || 0) + 1;
    return acc;
  }, {});

  const backupRoot = path.join(GATEWAY_HOME, "history-unify-backups", timestamp());
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      targetProvider,
      sourceProviders: providers,
      affectedThreads: rows.length,
      counts,
      backupRoot
    };
  }

  fs.mkdirSync(backupRoot, { recursive: true });
  backupFile(backupRoot, stateDb);
  const walPath = `${stateDb}-wal`;
  const shmPath = `${stateDb}-shm`;
  backupFile(backupRoot, walPath);
  backupFile(backupRoot, shmPath);

  let backedUpRollouts = 0;
  let updatedRollouts = 0;
  for (const row of rows) {
    if (!fs.existsSync(row.rollout_path)) continue;
    if (backupFile(backupRoot, row.rollout_path)) backedUpRollouts += 1;
    if (replaceSessionMetaProvider(row.rollout_path, targetProvider)) updatedRollouts += 1;
  }

  sqliteExec(stateDb, `
    UPDATE threads
    SET model_provider = ${quoteSql(targetProvider)}
    WHERE model_provider IN (${providerList});
  `);

  return {
    ok: true,
    dryRun: false,
    targetProvider,
    sourceProviders: providers,
    affectedThreads: rows.length,
    counts,
    backedUpRollouts,
    updatedRollouts,
    backupRoot
  };
}
