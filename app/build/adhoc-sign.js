// electron-builder afterPack hook (runs before the DMG is made). Without a Developer ID the app is not signed, and
// Apple Silicon Macs refuse to start unsigned code, so sign ad hoc: first the bundled opencode, then the whole app.
// Nothing happens on Windows, or when a real identity signed the app (CSC_LINK / CSC_NAME set).
const { execFileSync } = require("child_process")
const fs = require("fs")
const path = require("path")

exports.default = async function (context) {
  if (context.electronPlatformName !== "darwin") return
  if (process.env.CSC_LINK || process.env.CSC_NAME) return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const opencode = path.join(app, "Contents", "Resources", "opencode", "opencode")
  if (fs.existsSync(opencode)) execFileSync("codesign", ["--force", "--sign", "-", opencode], { stdio: "inherit" })
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" })
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" })
}
