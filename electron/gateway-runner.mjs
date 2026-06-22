// launchd 后台服务入口。被 plist 以 ELECTRON_RUN_AS_NODE=1 调用。
// 打包后此文件位于 app/Contents/Resources/gateway-runner.mjs（asar 外）。
// 开发模式下位于 electron/gateway-runner.mjs。
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 开发模式: electron/ -> 项目根目录的 src/
// 打包模式: app/Contents/Resources/ -> app/Contents/Resources/app/src/（asar 内）
let srcDir;
if (path.basename(__dirname) === "Resources") {
  srcDir = path.join(__dirname, "app", "src");
} else {
  srcDir = path.join(__dirname, "..", "src");
}

try {
  const { startServer } = await import(path.join(srcDir, "server.mjs"));
  startServer();
} catch (err) {
  console.error("[gateway-runner] failed to start:", err.stack || err.message);
  process.exit(1);
}
