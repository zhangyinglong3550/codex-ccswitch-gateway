import { app, BrowserWindow, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import os from "node:os";

// 网关作为独立 launchd 后台服务运行，不内嵌在 Electron 里。
// app 启动时检测网关是否在线，离线则自动安装 launchd 服务。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const CLI_PATH = path.join(PROJECT_ROOT, "bin", "cli.mjs");
const NODE_BIN = process.execPath;

const HOME = os.homedir();
const CCSWITCH_HOME = process.env.CCSWITCH_HOME || path.join(HOME, ".cc-switch");
const CCSWITCH_DB = process.env.CCSWITCH_DB || path.join(CCSWITCH_HOME, "cc-switch.db");
const GATEWAY_HOME = process.env.CODEX_CCSWITCH_GATEWAY_HOME || path.join(HOME, ".codex-ccswitch-gateway");
const CATALOG_PATH = process.env.CODEX_CCSWITCH_CATALOG || path.join(GATEWAY_HOME, "model-catalog.json");

const GATEWAY_HOST = process.env.CODEX_CCSWITCH_HOST || "127.0.0.1";
const GATEWAY_PORT = Number(process.env.CODEX_CCSWITCH_PORT || "15721");
const GATEWAY_BASE = `http://${GATEWAY_HOST}:${GATEWAY_PORT}`;

const LOG_OUT = path.join(GATEWAY_HOME, "gateway.out.log");
const LOG_ERR = path.join(GATEWAY_HOME, "gateway.err.log");

let mainWindow = null;
let dbWatcher = null;
let dbWatchTimer = null;
let dbWatchEnabled = true;

const gatewayUrl = (p) => `${GATEWAY_BASE}${p}`;

async function autoEnsureGateway() {
  // 先检测网关是否已在线
  const h = await gatewayFetch("/health", { timeoutMs: 2000 });
  if (h.ok) { console.log("[gateway] already running"); return { started: false, reason: "already running" }; }
  // 网关离线，自动安装 launchd 服务
  console.log("[gateway] offline, auto-installing launchd service...");
  const res = await serviceInstall();
  if (res.ok) {
    // 等待服务启动
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const check = await gatewayFetch("/health", { timeoutMs: 2000 });
      if (check.ok) { console.log("[gateway] service started and online"); return { started: true, reason: "service installed" }; }
    }
    return { started: false, reason: "service installed but health check failed" };
  }
  return { started: false, reason: "service install failed", error: res.error };
}

async function gatewayFetch(p, opts = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs || 4000);
  try {
    const res = await fetch(gatewayUrl(p), { ...opts, signal: controller.signal });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: { error: err.message || String(err), code: err.code || "unreachable" } };
  } finally { clearTimeout(timeout); }
}

function runCli(args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    execFile(NODE_BIN, [CLI_PATH, ...args], { cwd: PROJECT_ROOT, encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }, (err, stdout, stderr) => {
      if (err && err.killed) { resolve({ ok: false, error: `Command timed out after ${timeoutMs}ms`, stdout, stderr }); return; }
      if (err) { resolve({ ok: false, error: err.message || String(err), stdout, stderr }); return; }
      let parsed = null; try { parsed = JSON.parse(stdout.trim()); } catch { parsed = null; }
      resolve({ ok: true, stdout, stderr, json: parsed });
    });
  });
}

const getHealth = () => gatewayFetch("/health", { timeoutMs: 3000 });
const getModels = () => gatewayFetch("/v1/models", { timeoutMs: 4000 });
const getConfig = () => gatewayFetch("/v1/config", { timeoutMs: 4000 });
const adminReload = () => gatewayFetch("/admin/reload", { method: "POST", timeoutMs: 6000 });
const refreshCatalog = () => runCli(["refresh"], { timeoutMs: 20000 });
const runDoctor = () => runCli(["doctor"], { timeoutMs: 20000 });
const runProfile = () => runCli(["profile"], { timeoutMs: 15000 });
const serviceInstall = () => runCli(["service-install"], { timeoutMs: 20000 });
const serviceUninstall = () => runCli(["service-uninstall"], { timeoutMs: 15000 });
const serviceRestart = async () => ({ uninstall: await serviceUninstall(), install: await serviceInstall() });

async function serviceStatus() {
  const uid = process.getuid ? process.getuid() : 0;
  return new Promise((resolve) => {
    execFile("launchctl", ["print", "gui/" + uid + "/com.local.codex-ccswitch-gateway"], { encoding: "utf8", timeout: 3000 }, (err, stdout, stderr) => {
      if (err) { resolve({ ok: false, loaded: false, error: stderr || err.message }); return; }
      const loaded = /state\s*=\s*running/i.test(stdout) || /run\s*=\s*true/i.test(stdout);
      resolve({ ok: true, loaded, raw: stdout.slice(0, 200) });
    });
  });
}

async function testModel(modelSlug, { prompt = "只回复 OK", stream = true } = {}) {
  const body = { model: modelSlug, stream, input: prompt };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(gatewayUrl("/v1/responses"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    if (!res.ok) { const text = await res.text(); return { ok: false, status: res.status, error: text || res.statusText }; }
    if (stream) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let firstContent = ""; let firstErr = ""; let buf = "";
      const started = Date.now();
      while (Date.now() - started < 25000) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const evt = JSON.parse(payload);
            if (evt.type === "error" || evt.error) firstErr = JSON.stringify(evt.error || evt);
            const text = evt.delta || evt.output_text || evt.response?.output_text || evt.text || "";
            if (text && !firstContent) firstContent = text;
          } catch { /* partial */ }
          if (firstContent || firstErr) { reader.cancel().catch(() => {}); return { ok: !firstErr, content: firstContent, error: firstErr }; }
        }
      }
      try { await reader.cancel(); } catch {}
      return { ok: Boolean(firstContent) && !firstErr, content: firstContent, error: firstErr || "No content received within timeout" };
    } else {
      const text = await res.text();
      let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
      const out = parsed.output_text || parsed.output?.[0]?.content?.[0]?.text || text.slice(0, 400);
      return { ok: true, content: out };
    }
  } catch (err) { return { ok: false, error: err.message || String(err), code: err.code || "failed" }; }
  finally { clearTimeout(timeout); }
}

function readLogFile(p, { tail = 400 } = {}) {
  try {
    if (!fs.existsSync(p)) return { ok: true, content: "", exists: false };
    const stat = fs.statSync(p); const size = stat.size; const start = Math.max(0, size - tail * 200);
    const fd = fs.openSync(p, "r"); const len = size - start; const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start); fs.closeSync(fd);
    return { ok: true, content: buf.toString("utf8").split("\n").slice(-tail).join("\n"), exists: true, size };
  } catch (err) { return { ok: false, content: "", error: err.message || String(err) }; }
}

const getLogs = () => ({ ok: true, out: readLogFile(LOG_OUT), err: readLogFile(LOG_ERR) });

function getCatalogFromDisk() {
  try {
    if (!fs.existsSync(CATALOG_PATH)) return { ok: false, error: "Catalog file not found", path: CATALOG_PATH };
    const data = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
    return { ok: true, path: CATALOG_PATH, models: data.models || [], generatedAt: data.generatedAt || null };
  } catch (err) { return { ok: false, error: err.message || String(err), path: CATALOG_PATH }; }
}

function getDbInfo() {
  try {
    if (!fs.existsSync(CCSWITCH_DB)) return { ok: false, exists: false, path: CCSWITCH_DB };
    const stat = fs.statSync(CCSWITCH_DB);
    return { ok: true, exists: true, path: CCSWITCH_DB, size: stat.size, mtime: stat.mtimeMs };
  } catch (err) { return { ok: false, exists: false, path: CCSWITCH_DB, error: err.message || String(err) }; }
}

let dbStatPrev = null;
function setupDbWatch() {
  stopDbWatch();
  if (!dbWatchEnabled || !fs.existsSync(CCSWITCH_DB)) return;
  dbStatPrev = fs.statSync(CCSWITCH_DB);
  dbWatcher = fs.watchFile(CCSWITCH_DB, { interval: 2000, persistent: false }, (curr) => {
    if (!dbStatPrev) { dbStatPrev = curr; return; }
    if (curr.mtimeMs === dbStatPrev.mtimeMs && curr.size === dbStatPrev.size) return;
    dbStatPrev = curr;
    if (dbWatchTimer) clearTimeout(dbWatchTimer);
    dbWatchTimer = setTimeout(async () => {
      dbWatchTimer = null;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send("db:changed", getDbInfo());
      const reloadRes = await adminReload();
      const catRes = await refreshCatalog();
      mainWindow.webContents.send("refresh:done", { reload: reloadRes, catalog: catRes });
    }, 600);
  });
}

function stopDbWatch() {
  if (dbWatchTimer) { clearTimeout(dbWatchTimer); dbWatchTimer = null; }
  if (dbWatcher) { try { fs.unwatchFile(CCSWITCH_DB); } catch {} dbWatcher = null; }
  dbStatPrev = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1080, height: 720, minWidth: 720, minHeight: 480, title: "Codex CC Switch Gateway", backgroundColor: "#0f1115", show: false, webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  mainWindow.once("ready-to-show", () => {
    if (process.argv.includes("--screenshot")) {
      mainWindow.show();
      const shots = ["status", "models", "service", "test", "logs", "settings"];
      let idx = 0;
      const takeShot = async () => {
        if (idx >= shots.length) { console.log("SCREENSHOT_DONE"); app.quit(); return; }
        const tab = shots[idx];
        const jsCode = "document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));document.querySelector('.tab[data-tab=\"" + tab + "\"]').classList.add('active');document.getElementById('tab-" + tab + "').classList.add('active');";
        await mainWindow.webContents.executeJavaScript(jsCode);
        await new Promise(r => setTimeout(r, 1500));
        try {
          const img = await mainWindow.webContents.capturePage();
          fs.writeFileSync(path.join(os.tmpdir(), "electron-shot-" + tab + ".png"), img.toPNG());
          console.log("SHOT:", tab);
        } catch (err) { console.log("SHOT_ERR:", tab, err.message); }
        idx++;
        setTimeout(takeShot, 300);
      };
      setTimeout(takeShot, 3000);
    } else {
      mainWindow.show();
    }
  });
  setTimeout(() => setupDbWatch(), 1500);
}

function registerIpc() {
  ipcMain.handle("status:health", getHealth);
  ipcMain.handle("models:list", getModels);
  ipcMain.handle("config:list", getConfig);
  ipcMain.handle("catalog:disk", getCatalogFromDisk);
  ipcMain.handle("db:info", getDbInfo);
  ipcMain.handle("refresh:run", async () => ({ catalog: await refreshCatalog(), reload: await adminReload() }));
  ipcMain.handle("doctor:run", runDoctor);
  ipcMain.handle("profile:run", runProfile);
  ipcMain.handle("service:install", serviceInstall);
  ipcMain.handle("service:uninstall", serviceUninstall);
  ipcMain.handle("service:restart", serviceRestart);
  ipcMain.handle("service:status", serviceStatus);
  ipcMain.handle("model:test", (_e, slug, opts) => testModel(slug, opts || {}));
  ipcMain.handle("logs:read", getLogs);
  ipcMain.handle("paths:info", () => ({ projectRoot: PROJECT_ROOT, cliPath: CLI_PATH, nodeBin: NODE_BIN, gatewayBase: GATEWAY_BASE, ccswitchDb: CCSWITCH_DB, gatewayHome: GATEWAY_HOME, catalogPath: CATALOG_PATH, logOut: LOG_OUT, logErr: LOG_ERR }));
  ipcMain.handle("watch:set", (_e, enabled) => { dbWatchEnabled = Boolean(enabled); if (dbWatchEnabled) setupDbWatch(); else stopDbWatch(); return { ok: true, enabled: dbWatchEnabled }; });
  ipcMain.handle("shell:open", (_e, p) => { try { shell.showItemInFolder(p); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; } });
}

async function runSelfTest() {
  const results = {};
  results.health = await getHealth();
  results.models = await getModels();
  results.config = await getConfig();
  results.catalog = getCatalogFromDisk();
  results.dbInfo = getDbInfo();
  results.refresh = { catalog: await refreshCatalog(), reload: await adminReload() };
  results.doctor = await runDoctor();
  results.profile = await runProfile();
  results.serviceStatus = await serviceStatus();
  results.logs = getLogs();
  results.paths = { projectRoot: PROJECT_ROOT, gatewayBase: GATEWAY_BASE, ccswitchDb: CCSWITCH_DB };
  const fs2 = (await import("node:fs")).default;
  fs2.writeFileSync(path.join(os.tmpdir(), "electron-selftest.json"), JSON.stringify(results, null, 2));
  console.log("SELFTEST_DONE");
}

app.whenReady().then(() => {
  if (process.argv.includes("--self-test")) { registerIpc(); runSelfTest().then(() => app.quit()); return; }
  registerIpc();
  autoEnsureGateway().then((r) => console.log("[gateway] autoEnsure:", JSON.stringify(r)));
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { stopDbWatch(); if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", stopDbWatch);
