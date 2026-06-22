import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { GATEWAY_HOME, LAUNCH_AGENTS_DIR, LAUNCHD_LABEL, LAUNCHD_PLIST_PATH } from "./paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// 打包模式下 CLI 和 gateway-runner 都在 app resources 里。
// 开发模式下它们在项目根目录。
function isPackaged() {
  // Electron 打包后 process.resourcesPath 指向 app/Contents/Resources
  if (process.versions.electron && process.resourcesPath) {
    return path.basename(__dirname) !== "src" || !fs.existsSync(path.join(PROJECT_ROOT, "bin", "cli.mjs"));
  }
  return false;
}

function getRunnerPath() {
  if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, "gateway-runner.mjs"))) {
    return path.join(process.resourcesPath, "gateway-runner.mjs");
  }
  return path.join(__dirname, "..", "electron", "gateway-runner.mjs");
}

function getCliPath() {
  const dev = path.join(PROJECT_ROOT, "bin", "cli.mjs");
  if (fs.existsSync(dev)) return dev;
  if (process.resourcesPath) {
    const packed = path.join(process.resourcesPath, "app", "bin", "cli.mjs");
    if (fs.existsSync(packed)) return packed;
  }
  return dev;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function nodeSupportsZstd(nodePath) {
  try {
    const out = execFileSync(nodePath, ["-p", "typeof require('node:zlib').zstdDecompressSync"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000
    });
    return out.trim() === "function";
  } catch {
    return false;
  }
}

function firstExistingPath(paths) {
  return paths.find((p) => p && fs.existsSync(p)) || "";
}

function findLaunchdNodePath() {
  const envPath = process.env.CODEX_CCSWITCH_NODE;
  const shellNode = (() => {
    try {
      return execFileSync("/usr/bin/env", ["which", "node"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
        env: { ...process.env }
      }).trim();
    } catch {
      return "";
    }
  })();
  const candidates = [
    envPath,
    shellNode,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    firstExistingPath([
      "/opt/homebrew/opt/node/bin/node",
      "/usr/local/opt/node/bin/node"
    ]),
    process.execPath
  ].filter(Boolean);

  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (nodeSupportsZstd(candidate)) return candidate;
  }
  return process.execPath;
}

function plistContent({ nodePath = findLaunchdNodePath() } = {}) {
  const stdoutPath = path.join(GATEWAY_HOME, "gateway.out.log");
  const stderrPath = path.join(GATEWAY_HOME, "gateway.err.log");
  const runnerPath = getRunnerPath();
  const cliPath = getCliPath();
  // 优先用 gateway-runner.mjs（支持打包模式），回退到 CLI
  const entryScript = fs.existsSync(runnerPath) ? runnerPath : cliPath;
  const entryArg = entryScript === runnerPath ? [] : ["start"];
  const programArgs = [nodePath, entryScript, ...entryArg];

  const programArgsXml = programArgs.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(stderrPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(process.env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin")}</string>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
    <key>CODEX_CCSWITCH_NODE</key>
    <string>${xmlEscape(nodePath)}</string>
  </dict>
</dict>
</plist>
`;
}

function launchctl(args) {
  return execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function installLaunchdService({ load = true } = {}) {
  fs.mkdirSync(GATEWAY_HOME, { recursive: true });
  fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  fs.writeFileSync(LAUNCHD_PLIST_PATH, plistContent(), "utf8");

  if (load) {
    const domain = `gui/${process.getuid()}`;
    try {
      launchctl(["bootout", domain, LAUNCHD_PLIST_PATH]);
    } catch {
      // Service may not be loaded yet.
    }
    launchctl(["bootstrap", domain, LAUNCHD_PLIST_PATH]);
    launchctl(["kickstart", "-k", `${domain}/${LAUNCHD_LABEL}`]);
  }

  return {
    plistPath: LAUNCHD_PLIST_PATH,
    nodePath: findLaunchdNodePath(),
    stdoutPath: path.join(GATEWAY_HOME, "gateway.out.log"),
    stderrPath: path.join(GATEWAY_HOME, "gateway.err.log")
  };
}

export function uninstallLaunchdService() {
  const domain = `gui/${process.getuid()}`;
  try {
    launchctl(["bootout", domain, LAUNCHD_PLIST_PATH]);
  } catch {
    // Service may not be loaded.
  }
  if (fs.existsSync(LAUNCHD_PLIST_PATH)) {
    fs.unlinkSync(LAUNCHD_PLIST_PATH);
  }
  return { plistPath: LAUNCHD_PLIST_PATH };
}
