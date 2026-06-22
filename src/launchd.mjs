import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { GATEWAY_HOME, LAUNCH_AGENTS_DIR, LAUNCHD_LABEL, LAUNCHD_PLIST_PATH } from "./paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const CLI_PATH = path.join(PROJECT_ROOT, "bin", "cli.mjs");

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function plistContent({ nodePath = process.execPath } = {}) {
  const stdoutPath = path.join(GATEWAY_HOME, "gateway.out.log");
  const stderrPath = path.join(GATEWAY_HOME, "gateway.err.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(CLI_PATH)}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(PROJECT_ROOT)}</string>
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
