const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const productFilename = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);

  if (!fs.existsSync(appPath)) {
    throw new Error(`Cannot ad-hoc sign missing macOS app: ${appPath}`);
  }

  try {
    execFileSync("xattr", ["-dr", "com.apple.quarantine", appPath], { stdio: "ignore" });
  } catch {
    // The app normally has no quarantine flag during local builds.
  }

  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], { stdio: "inherit" });
};
