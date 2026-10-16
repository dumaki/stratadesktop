// Strata Desktop: one window for the Strata engine (setup, start, stop, chat, monitor) and the opencode coding
// agent (its web UI and its terminal UI), so neither has to be driven from a separate terminal.
// Local mode runs Strata on this PC; remote mode uses a Strata server on another PC (for example a Mac working off
// the Windows PC's model), and opencode still runs here.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session, clipboard } = require("electron")
const path = require("path")
const fs = require("fs")
const http = require("http")
const https = require("https")
const crypto = require("crypto")
const { spawn, execFile } = require("child_process")
const pty = require("@lydell/node-pty")

const IS_WIN = process.platform === "win32"

// opencode 2.x makes up a server password when none is given, so the app sets one itself (every version takes
// OPENCODE_SERVER_PASSWORD, user "opencode") and sends it from the Coding Agent tab.
const AGENT_USER = "opencode"
const AGENT_PASSWORD = crypto.randomBytes(18).toString("base64url")
const AGENT_AUTH = "Basic " + Buffer.from(`${AGENT_USER}:${AGENT_PASSWORD}`).toString("base64")

// Strata's scripts on Windows and their equivalents on macOS / Linux
const STRATA_SCRIPTS = IS_WIN
  ? { start: ["START-HERE.bat"], update: ["UPDATE.bat"], bench: ["BENCH.bat"] }
  : { start: ["./setup.sh"], update: ["./update.sh"], bench: ["./bench.sh"] }
const STRATA_MARKER = IS_WIN ? "START-HERE.bat" : "setup.sh"

// read when the app is ready, so a --user-data-dir switch is already applied
const settingsFile = () => path.join(app.getPath("userData"), "settings.json")
const DEFAULTS = {
  mode: "local",
  remoteUrl: "",
  strataDir: "",
  projectDir: app.getPath("home"),
  port: 8080,
  apiKey: "",
  opencodePort: 4096,
  opencodePath: "",
  strataDefaultModel: true,
  autoStartStrata: false,
  autoStartAgent: true,
}

// apps opened from Finder get a minimal PATH; add the usual places opencode and Homebrew live
if (!IS_WIN) {
  const home = app.getPath("home")
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".opencode", "bin"), path.join(home, ".local", "bin"), path.join(home, ".bun", "bin")]
  const have = (process.env.PATH || "").split(":")
  process.env.PATH = [...have, ...extra.filter((p) => !have.includes(p))].join(":")
}

let win = null
const terms = new Map() // id -> { proc, kind }
let agentServer = null // the `opencode serve` child process
let agentLog = ""

function guessStrataDir() {
  const candidates = [
    path.join(path.dirname(app.getPath("exe")), "Strata"),
    path.join(app.getPath("home"), "StrataDesktop", "Strata"),
    path.join(app.getPath("home"), "StrataDesktop", "src", "strata", "Strata-0.1.44.1"),
    path.join(app.getPath("home"), "Strata"),
  ]
  return candidates.find((d) => fs.existsSync(path.join(d, STRATA_MARKER))) || ""
}

function loadSettings() {
  let s = {}
  try {
    s = JSON.parse(fs.readFileSync(settingsFile(), "utf8"))
  } catch {}
  s = { ...DEFAULTS, ...s }
  if (!s.strataDir) s.strataDir = guessStrataDir()
  return s
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2))
}

let settings = { ...DEFAULTS } // loaded in app.whenReady

const isRemote = () => settings.mode === "remote"

// where Strata answers: this PC, or the remote host (http://win-pc:8080, a Tailscale name, https://...)
function strataBase() {
  if (isRemote()) {
    let u = (settings.remoteUrl || "").trim().replace(/\/+$/, "")
    if (u && !/^https?:\/\//i.test(u)) u = "http://" + u
    if (u.endsWith("/v1")) u = u.slice(0, -3)
    return u
  }
  return `http://127.0.0.1:${settings.port}`
}

const strataHeaders = () => (settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {})

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function opencodeBin() {
  if (settings.opencodePath && fs.existsSync(settings.opencodePath)) return settings.opencodePath
  const name = IS_WIN ? "opencode.exe" : "opencode"
  const bundled = [path.join(process.resourcesPath || "", "opencode", name), path.join(__dirname, "resources", "opencode", name)]
  return bundled.find((p) => fs.existsSync(p)) || "opencode"
}

function getJson(url, timeout = 1500, headers = {}) {
  return new Promise((resolve) => {
    let req
    try {
      req = (url.startsWith("https:") ? https : http).get(url, { timeout, headers }, (res) => {
        let body = ""
        res.on("data", (c) => (body += c))
        res.on("end", () => {
          try {
            resolve({ code: res.statusCode, json: JSON.parse(body) })
          } catch {
            resolve({ code: res.statusCode, json: null })
          }
        })
      })
    } catch {
      return resolve(null)
    }
    req.on("timeout", () => req.destroy())
    req.on("error", () => resolve(null))
  })
}

// opencode reads OPENCODE_CONFIG_CONTENT on top of the user's own config, so their settings stay as they are and
// Strata is added as one more provider.
async function opencodeConfig() {
  const base = strataBase()
  const health = base ? await getJson(`${base}/health`, isRemote() ? 4000 : 1500, strataHeaders()) : null
  const h = (health && health.json) || {}
  const cfg = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      strata: {
        npm: "@ai-sdk/openai-compatible",
        name: isRemote() ? "Strata (remote)" : "Strata (local)",
        options: { baseURL: `${base}/v1`, apiKey: settings.apiKey || "strata" },
        models: {
          strata: {
            name: h.model ? `Strata: ${h.model}` : "Strata model",
            tool_call: true,
            reasoning: true,
            limit: { context: h.max_context || 131072, output: 32768 },
          },
        },
      },
    },
  }
  if (settings.strataDefaultModel) cfg.model = "strata/strata"
  return JSON.stringify(cfg)
}

async function opencodeEnv() {
  return { ...process.env, OPENCODE_CONFIG_CONTENT: await opencodeConfig(), FORCE_COLOR: "1" }
}

// ends a process and everything it started: taskkill /T on Windows; elsewhere the process group (pty children and
// the agent server are started as group leaders), TERM first and KILL if it is still there
function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve()
    if (IS_WIN) return execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => resolve())
    const sig = (s) => {
      try {
        process.kill(-pid, s)
      } catch {
        try {
          process.kill(pid, s)
        } catch {}
      }
    }
    sig("SIGTERM")
    setTimeout(() => {
      sig("SIGKILL")
      resolve()
    }, 2000)
  })
}

// ---- terminals (a real console, so setup's questions and the opencode TUI behave exactly as in a terminal) ----

async function startTerm(id, kind, args = [], cols = 120, rows = 30) {
  if (terms.has(id)) return { ok: false, error: "already running" }
  let file, argv, cwd, env
  if (kind === "strata") {
    if (isRemote()) return { ok: false, error: "Strata runs on the remote PC in remote mode: start and set it up there." }
    if (!settings.strataDir || !fs.existsSync(path.join(settings.strataDir, STRATA_MARKER)))
      return { ok: false, error: `Set the Strata folder in Settings first (the folder with ${STRATA_MARKER}).` }
    // args[0] may name one of Strata's own scripts ("update", "bench"); the start script otherwise
    const which = ["update", "bench"].includes(args[0]) ? args[0] : "start"
    const extra = which === "start" ? [...args] : args.slice(1)
    if (which !== "bench") {
      if (settings.port !== 8080 && !extra.includes("--port")) extra.push("--port", String(settings.port))
      if (settings.apiKey && !extra.includes("--api-key")) extra.push("--api-key", settings.apiKey)
      if (!extra.includes("--browser") && !extra.includes("--check")) extra.push("--no-browser")
    }
    const script = STRATA_SCRIPTS[which]
    if (IS_WIN) {
      file = "cmd.exe"
      argv = ["/d", "/c", ...script, ...extra]
    } else {
      file = "/bin/bash"
      argv = [...script, ...extra]
    }
    cwd = settings.strataDir
    env = { ...process.env, PYTHONUNBUFFERED: "1" }
  } else if (kind === "agent-tui") {
    file = opencodeBin()
    argv = args
    cwd = settings.projectDir || app.getPath("home")
    env = await opencodeEnv()
    if (IS_WIN && file === "opencode") {
      argv = ["/d", "/c", file, ...args]
      file = "cmd.exe"
    }
  } else if (kind === "shell") {
    if (IS_WIN) {
      file = "powershell.exe"
      argv = ["-NoLogo"]
    } else {
      file = process.env.SHELL || "/bin/zsh"
      argv = ["-l"]
    }
    cwd = settings.projectDir || app.getPath("home")
    env = await opencodeEnv()
  } else {
    return { ok: false, error: "unknown terminal " + kind }
  }
  let proc
  try {
    proc = pty.spawn(file, argv, { name: "xterm-256color", cols, rows, cwd, env, useConpty: true })
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
  terms.set(id, { proc, kind })
  proc.onData((d) => send("term:data", id, d))
  proc.onExit(({ exitCode }) => {
    terms.delete(id)
    send("term:exit", id, exitCode)
  })
  return { ok: true }
}

async function stopTerm(id, graceful = true) {
  const t = terms.get(id)
  if (!t) return
  if (graceful) {
    try {
      t.proc.write("\x03")
    } catch {}
    await new Promise((r) => setTimeout(r, 3000))
    if (!terms.has(id)) return
  }
  // the whole tree (cmd or bash, python, the engine); node-pty notices the exit by itself
  await killTree(t.proc.pid)
}

// ---- the opencode server behind the coding agent's web UI ----

function agentLogAppend(s) {
  agentLog = (agentLog + s).slice(-200000)
  send("agent:log", s)
}

async function startAgentServer() {
  if (agentServer) return { ok: true }
  const bin = opencodeBin()
  const args = ["serve", "--hostname", "127.0.0.1", "--port", String(settings.opencodePort)]
  const env = { ...(await opencodeEnv()), OPENCODE_SERVER_USERNAME: AGENT_USER, OPENCODE_SERVER_PASSWORD: AGENT_PASSWORD }
  const opts = { cwd: settings.projectDir || app.getPath("home"), env, windowsHide: true }
  try {
    if (IS_WIN && (bin === "opencode" || /\.(cmd|bat)$/i.test(bin))) {
      // Node does not start .cmd/.bat files (npm's launchers, such as opencode.cmd) directly: EINVAL. cmd.exe does.
      const line = [bin, ...args].map((a) => (/[\s&()^|<>]/.test(a) ? `"${a}"` : a)).join(" ")
      agentServer = spawn("cmd.exe", ["/d", "/s", "/c", `"${line}"`], { ...opts, windowsVerbatimArguments: true })
    } else agentServer = spawn(bin, args, IS_WIN ? opts : { ...opts, detached: true }) // own process group to stop it whole
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
  agentLogAppend(`> ${bin} ${args.join(" ")}\n`)
  agentServer.stdout.on("data", (d) => agentLogAppend(d.toString()))
  agentServer.stderr.on("data", (d) => agentLogAppend(d.toString()))
  agentServer.on("error", (e) => agentLogAppend(`error: ${e.message}\n`))
  agentServer.on("exit", (code) => {
    agentLogAppend(`opencode server stopped (exit ${code})\n`)
    agentServer = null
    send("agent:state", false)
  })
  send("agent:state", true)
  return { ok: true }
}

async function stopAgentServer() {
  if (!agentServer) return
  const p = agentServer
  await killTree(p.pid)
}

// ---- window ----

function createWindow() {
  // Windows: no menu bar. macOS keeps the app and Edit menus, which carry Cmd+C / Cmd+V / Cmd+Q.
  Menu.setApplicationMenu(IS_WIN ? null : Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]))
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    title: "Strata Desktop",
    backgroundColor: "#0f1115",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  })
  win.loadFile(path.join(__dirname, "renderer", "index.html"))
  // links that open new windows (docs, GitHub) go to the user's browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: "deny" }
  })
  win.webContents.on("before-input-event", (_e, input) => {
    if (input.type === "keyDown" && input.key === "F12") win.webContents.toggleDevTools()
  })
}

app.on("render-process-gone", (_e, contents, details) => {
  console.error(`render process gone (${contents.getType()} ${contents.getURL()}): ${details.reason} ${details.exitCode}`)
})

app.on("web-contents-created", (_e, contents) => {
  if (contents.getType() === "webview") {
    contents.setWindowOpenHandler(({ url }) => {
      const base = strataBase()
      if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url) || (base && url.startsWith(base + "/"))) return { action: "allow" }
      shell.openExternal(url)
      return { action: "deny" }
    })
  }
})

ipcMain.handle("settings:get", () => settings)
ipcMain.handle("settings:set", (_e, s) => {
  settings = { ...settings, ...s, port: Number(s.port ?? settings.port), opencodePort: Number(s.opencodePort ?? settings.opencodePort) }
  saveSettings(settings)
  return settings
})
ipcMain.handle("dialog:folder", async (_e, title) => {
  const r = await dialog.showOpenDialog(win, { title, properties: ["openDirectory"] })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle("dialog:file", async (_e, title) => {
  const filters = IS_WIN ? [{ name: "Programs", extensions: ["exe", "cmd", "bat"] }] : []
  const r = await dialog.showOpenDialog(win, { title, properties: ["openFile"], filters })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle("term:start", (_e, id, kind, args, cols, rows) => startTerm(id, kind, args, cols, rows))
ipcMain.handle("term:stop", (_e, id, graceful) => stopTerm(id, graceful))
ipcMain.handle("term:running", (_e, id) => terms.has(id))
ipcMain.on("term:write", (_e, id, data) => terms.get(id)?.proc.write(data))
ipcMain.on("term:resize", (_e, id, cols, rows) => {
  try {
    terms.get(id)?.proc.resize(cols, rows)
  } catch {}
})
// /health is open; /status needs the key when the server has one
ipcMain.handle("strata:health", async () => {
  const base = strataBase()
  if (!base) return null
  const r = await getJson(`${base}/health`, isRemote() ? 4000 : 1500, strataHeaders())
  return r && r.json ? r.json : null
})
ipcMain.handle("strata:status", async () => {
  const base = strataBase()
  if (!base) return null
  const r = await getJson(`${base}/status`, isRemote() ? 4000 : 1500, strataHeaders())
  if (r && r.code === 401) return { unauthorized: true }
  return r && r.json ? r.json : null
})
ipcMain.handle("strata:base", () => strataBase())
ipcMain.handle("agent:start", () => startAgentServer())
ipcMain.handle("agent:stop", () => stopAgentServer())
ipcMain.handle("agent:restart", async () => {
  await stopAgentServer()
  await new Promise((r) => setTimeout(r, 800))
  return startAgentServer()
})
ipcMain.handle("agent:running", () => !!agentServer)
ipcMain.handle("agent:log", () => agentLog)
ipcMain.handle("agent:ready", async () => {
  // 1.x answers this route; 2.x serves its web app here, which also says the server is up
  const r = await getJson(`http://127.0.0.1:${settings.opencodePort}/global/health`, 1500, { Authorization: AGENT_AUTH })
  return !!(r && r.code && r.code < 400)
})
ipcMain.handle("agent:credentials", () => {
  clipboard.writeText(AGENT_PASSWORD)
  return { user: AGENT_USER, password: AGENT_PASSWORD }
})
ipcMain.handle("open:external", (_e, url) => shell.openExternal(url))
ipcMain.handle("open:path", (_e, p) => shell.openPath(p))
ipcMain.handle("app:info", () => ({ version: app.getVersion(), opencode: opencodeBin(), userData: app.getPath("userData"), platform: process.platform }))

app.whenReady().then(() => {
  settings = loadSettings()
  // the Coding Agent tab's requests to the opencode server carry the password
  session.fromPartition("persist:opencode").webRequest.onBeforeSendHeaders((details, cb) => {
    const own = details.url.startsWith(`http://127.0.0.1:${settings.opencodePort}/`)
    cb({ requestHeaders: own ? { ...details.requestHeaders, Authorization: AGENT_AUTH } : details.requestHeaders })
  })
  // the Chat & Monitor views send Strata's API key (needed on a remote server set up with --api-key)
  session.fromPartition("persist:strata").webRequest.onBeforeSendHeaders((details, cb) => {
    const base = strataBase()
    const own = settings.apiKey && base && (details.url === base || details.url.startsWith(base + "/"))
    cb({ requestHeaders: own ? { ...details.requestHeaders, ...strataHeaders() } : details.requestHeaders })
  })
  createWindow()
})

let quitting = false
app.on("before-quit", async (e) => {
  if (quitting) return
  e.preventDefault()
  quitting = true
  await Promise.all([...terms.keys()].map((id) => stopTerm(id, id === "strata")))
  await stopAgentServer()
  app.exit(0)
})
app.on("window-all-closed", () => app.quit())
