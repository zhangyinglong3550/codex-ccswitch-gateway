import os from "node:os";
import path from "node:path";

export const HOME = os.homedir();
export const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
export const CCSWITCH_HOME = process.env.CCSWITCH_HOME || path.join(HOME, ".cc-switch");
export const CCSWITCH_DB = process.env.CCSWITCH_DB || path.join(CCSWITCH_HOME, "cc-switch.db");
export const GATEWAY_HOME = process.env.CODEX_CCSWITCH_GATEWAY_HOME || path.join(HOME, ".codex-ccswitch-gateway");
export const CATALOG_PATH = process.env.CODEX_CCSWITCH_CATALOG || path.join(GATEWAY_HOME, "model-catalog.json");
export const CONFIG_PATH = process.env.CODEX_CCSWITCH_CONFIG || path.join(GATEWAY_HOME, "gateway.json");
export const CODEX_CONFIG_PATH = process.env.CODEX_CONFIG_PATH || path.join(CODEX_HOME, "config.toml");
export const LAUNCH_AGENTS_DIR = path.join(HOME, "Library", "LaunchAgents");
export const LAUNCHD_LABEL = "com.local.codex-ccswitch-gateway";
export const LAUNCHD_PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${LAUNCHD_LABEL}.plist`);

export const DEFAULT_HOST = process.env.CODEX_CCSWITCH_HOST || "127.0.0.1";
export const DEFAULT_PORT = Number(process.env.CODEX_CCSWITCH_PORT || "15721");

export const MANAGED_BEGIN = "# >>> codex-ccswitch-gateway managed >>>";
export const MANAGED_END = "# <<< codex-ccswitch-gateway managed <<<";
