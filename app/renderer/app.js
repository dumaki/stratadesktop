/* global Terminal, FitAddon, desk */
const $ = (s) => document.querySelector(s)
let settings = {}
let strataBase = "" // http://127.0.0.1:8080 locally, the remote host in remote mode
let platform = "win32"
let strataReady = false
let agentReady = false

// ---- tabs ----
function showTab(name) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name))
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name))
  requestAnimationFrame(() => Object.values(terms).forEach((t) => t.fit()))
  if (name === "tui") terms.tui.term.focus()
  if (name === "engine" && !isRemote()) terms.strata.term.focus()
}
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)))
document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.goto)))

// ---- terminals ----
const terms = {}
function makeTerm(id, el) {
  const term = new Terminal({
    fontFamily: "Cascadia Mono, Consolas, Menlo, monospace",
    fontSize: 13,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 20000,
    theme: { background: "#0b0d12", foreground: "#e6e8ee", cursor: "#6aa7ff", selectionBackground: "#2d3a55" },
  })
  const fit = new FitAddon.FitAddon()
  term.loadAddon(fit)
  term.open(el)
  // Windows: Ctrl+C copies when text is selected, Ctrl+V pastes; otherwise keys go to the program as in a terminal.
  // macOS: Cmd+C / Cmd+V (the Edit menu) copy and paste, and Ctrl keys always go to the program.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || platform === "darwin") return true
    if (e.ctrlKey && e.key === "c" && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection())
      term.clearSelection()
      return false
    }
    if (e.ctrlKey && e.key === "v") {
      navigator.clipboard.readText().then((t) => desk.termWrite(id, t))
      return false
    }
    return true
  })
  term.onData((d) => desk.termWrite(id, d))
  const t = {
    term,
    running: false,
    fit() {
      if (!el.offsetParent) return
      try {
        fit.fit()
        desk.termResize(id, term.cols, term.rows)
      } catch {}
    },
  }
  new ResizeObserver(() => t.fit()).observe(el)
  terms[id] = t
  return t
}
makeTerm("strata", $("#term-strata"))
makeTerm("tui", $("#term-tui"))
desk.onTermData((id, d) => terms[id]?.term.write(d))
desk.onTermExit((id, code) => {
  const t = terms[id]
  if (!t) return
  t.running = false
  t.term.write(`\r\n\x1b[90m[process ended, exit code ${code}]\x1b[0m\r\n`)
  refreshButtons()
})

async function runTerm(id, kind, args) {
  const t = terms[id]
  if (t.running) return
  t.fit()
  const startScript = platform === "win32" ? "START-HERE.bat " : "./setup.sh "
  const shown = kind === "strata" ? (["update", "bench"].includes(args[0]) ? "" : startScript) : kind === "shell" ? "" : "opencode "
  t.term.write(`\x1b[90m$ ${shown}${args.join(" ")}\x1b[0m\r\n`)
  const r = await desk.termStart(id, kind, args, t.term.cols, t.term.rows)
  if (!r.ok) {
    t.term.write(`\x1b[31m${r.error}\x1b[0m\r\n`)
    return
  }
  t.running = true
  t.term.focus()
  refreshButtons()
}

// split "--a b \"c d\"" into arguments
function splitArgs(s) {
  const out = []
  s.replace(/"([^"]*)"|(\S+)/g, (_, q, w) => out.push(q ?? w))
  return out
}

// ---- engine ----
const strataArgs = (more) => [...more, ...splitArgs($("#strata-args").value)]
$("#btn-strata-start").onclick = () => runTerm("strata", "strata", strataArgs([]))
$("#btn-strata-setup").onclick = () => runTerm("strata", "strata", strataArgs(["--setup"]))
$("#btn-strata-update").onclick = () => runTerm("strata", "strata", strataArgs(["update"]))
$("#btn-strata-check").onclick = () => runTerm("strata", "strata", strataArgs(["--check"]))
$("#btn-strata-bench").onclick = () => runTerm("strata", "strata", strataArgs(["bench"]))
$("#btn-strata-stop").onclick = async () => {
  terms.strata.term.write("\r\n\x1b[90m[stopping Strata ...]\x1b[0m\r\n")
  await desk.termStop("strata", true)
}
$("#btn-strata-folder").onclick = () => settings.strataDir && desk.openPath(settings.strataDir)

// ---- chat ----
const chatView = $("#chat-view")
const strataUrl = () => strataBase + "/"
const isRemote = () => settings.mode === "remote"
$("#btn-chat-reload").onclick = () => strataReady && chatView.loadURL(strataUrl())
$("#btn-chat-monitor").onclick = () => strataReady && chatView.loadURL(strataUrl() + "#monitor")
$("#btn-chat-browser").onclick = () => desk.openExternal(strataUrl())

// ---- coding agent ----
const agentView = $("#agent-view")
const agentUrl = () => `http://127.0.0.1:${settings.opencodePort}/`
const startAgent = async () => {
  const r = await desk.agentStart()
  if (!r.ok) appendAgentLog(`error: ${r.error}\n`)
  refreshAgent()
}
$("#btn-agent-start").onclick = startAgent
$("#btn-agent-start2").onclick = startAgent
$("#btn-agent-stop").onclick = async () => {
  await desk.agentStop()
  setTimeout(refreshAgent, 500)
}
$("#btn-agent-restart").onclick = async () => {
  agentReady = false
  showAgentView()
  await desk.agentRestart()
}
$("#btn-agent-browser").onclick = async () => {
  // a browser outside the app asks for the server's login; the password is on the clipboard
  const c = await desk.agentCredentials()
  appendAgentLog(`Browser login: user "${c.user}", password copied to the clipboard (${c.password})\n`)
  alert(`Your browser will ask for a login.\n\nUser: ${c.user}\nPassword: copied to the clipboard (paste it)`)
  desk.openExternal(agentUrl())
}
$("#btn-agent-log").onclick = () => {
  const log = $("#agent-log")
  log.classList.toggle("hidden")
  log.scrollTop = log.scrollHeight
}
$("#btn-agent-project").onclick = async () => {
  const dir = await desk.pickFolder("Project folder for the coding agent")
  if (!dir) return
  settings = await desk.setSettings({ projectDir: dir })
  fillSettings()
  if (await desk.agentRunning()) $("#btn-agent-restart").click()
}
function appendAgentLog(s) {
  const log = $("#agent-log")
  log.textContent = (log.textContent + s).slice(-200000)
  log.scrollTop = log.scrollHeight
}
desk.onAgentLog(appendAgentLog)
desk.onAgentState(() => refreshAgent())
desk.agentLog().then((s) => ($("#agent-log").textContent = s))

let agentViewLoaded = false
function showAgentView() {
  $("#agent-placeholder").classList.toggle("hidden", agentReady)
  agentView.classList.toggle("hidden", !agentReady)
  if (agentReady && !agentViewLoaded) {
    agentView.src = agentUrl()
    agentViewLoaded = true
  }
  if (!agentReady) agentViewLoaded = false
}

// ---- agent terminal ----
$("#btn-tui-start").onclick = () => runTerm("tui", "agent-tui", splitArgs($("#tui-args").value))
$("#btn-tui-shell").onclick = () => runTerm("tui", "shell", [])
$("#btn-tui-stop").onclick = () => desk.termStop("tui", false)

function refreshButtons() {
  const s = terms.strata.running
  for (const b of ["start", "setup", "update", "check", "bench"]) $("#btn-strata-" + b).disabled = s
  $("#btn-strata-stop").disabled = !s
  $("#btn-tui-start").disabled = $("#btn-tui-shell").disabled = terms.tui.running
  $("#btn-tui-stop").disabled = !terms.tui.running
}

// ---- remote engine: status and the remote Monitor ----
const monitorView = $("#monitor-view")
let monitorLoaded = false
$("#btn-remote-reload").onclick = () => strataReady && monitorView.loadURL(strataUrl() + "#monitor")
function updateRemote(h, st) {
  if (!isRemote()) return
  const ready = !!(h && h.loaded !== false)
  $("#remote-state").textContent = !h ? "unreachable" : ready ? "ready" : "loading the model"
  $("#remote-model").textContent = (h && h.model) || "-"
  $("#remote-ctx").textContent = h && h.max_context ? h.max_context.toLocaleString() + " tokens" : "-"
  $("#remote-key").textContent = !h ? "-" : !h.api_key ? "not required (server has no key)" : st && st.unauthorized ? "wrong or missing: set it in Settings" : "accepted"
  $("#remote-activity").textContent = !ready ? "-" : st && st.busy ? `busy${st.tokens_per_s ? ` · ${st.tokens_per_s} tok/s` : ""}${st.queued ? ` · ${st.queued} waiting` : ""}` : st && !st.unauthorized ? "idle" : "-"
  $("#remote-placeholder").classList.toggle("hidden", ready)
  monitorView.classList.toggle("hidden", !ready)
  if (ready && !monitorLoaded) {
    monitorView.src = strataUrl() + "#monitor"
    monitorLoaded = true
  }
  if (!ready) monitorLoaded = false
}

// ---- status polling ----
let chatLoaded = false
async function pollStrata() {
  const h = await desk.strataHealth()
  const dot = $("#strata-dot")
  const label = $("#strata-label")
  const ready = !!(h && h.loaded !== false)
  if (h && !ready) {
    dot.className = "dot warn"
    label.textContent = "loading"
  } else if (ready) {
    dot.className = "dot ok"
    label.textContent = "ready"
  } else if (terms.strata.running && !isRemote()) {
    dot.className = "dot warn"
    label.textContent = "starting"
  } else {
    dot.className = "dot off"
    label.textContent = isRemote() ? "unreachable" : "offline"
  }
  $("#strata-label").title = h && h.model ? h.model : ""
  if (ready !== strataReady) {
    strataReady = ready
    $("#chat-placeholder").classList.toggle("hidden", ready)
    chatView.classList.toggle("hidden", !ready)
    if (ready && !chatLoaded) {
      chatView.src = strataUrl()
      chatLoaded = true
    }
    if (!ready) chatLoaded = false
  }
  const st = ready ? await desk.strataStatus() : null
  if (ready) {
    $("#strata-speed").textContent =
      (isRemote() ? "remote · " : "") + (h.model ? h.model + " · " : "") + (st && st.busy ? `busy${st.tokens_per_s ? ` · ${st.tokens_per_s} tok/s` : ""}` : "idle")
  } else $("#strata-speed").textContent = ""
  updateRemote(h, st)
}

async function refreshAgent() {
  const running = await desk.agentRunning()
  const ready = running && (await desk.agentReady())
  $("#agent-dot").className = "dot " + (ready ? "ok" : running ? "warn" : "off")
  $("#agent-label").textContent = ready ? "ready" : running ? "starting" : "stopped"
  $("#btn-agent-start").disabled = running
  $("#btn-agent-stop").disabled = $("#btn-agent-restart").disabled = !running
  if (ready !== agentReady) {
    agentReady = ready
    showAgentView()
  }
}

// ---- settings ----
const form = $("#settings")
function fillSettings() {
  for (const el of form.elements) {
    if (!el.name) continue
    if (el.type === "checkbox") el.checked = !!settings[el.name]
    else if (el.type === "radio") el.checked = (settings[el.name] || "local") === el.value
    else el.value = settings[el.name] ?? ""
  }
  $("#btn-agent-project").textContent = settings.projectDir || "(choose)"
  $("#btn-agent-project").title = settings.projectDir
  $("#chat-url").textContent = strataUrl()
  applyMode()
}

// what differs between local and remote mode, and between Windows and macOS
function applyMode() {
  document.body.classList.toggle("remote", isRemote())
  $("#remote-host").textContent = strataBase || "(no address set)"
  $("#chat-why").innerHTML = isRemote()
    ? "Can't reach the remote Strata yet. Check the address and key in <b>Settings</b> and that Strata is running on that PC."
    : "Start the engine on the <b>Engine</b> tab. The chat opens here as soon as the model is ready."
  $("#chat-placeholder").querySelector("h3").textContent = isRemote() ? "Remote Strata is not reachable" : "Strata is not running"
  const win = platform === "win32"
  $("#btn-tui-shell").textContent = win ? "PowerShell" : "Shell"
  $("#shell-name").textContent = win ? "PowerShell" : "Shell"
  $("#strata-dir-hint").textContent = win
    ? "(the folder with START-HERE.bat; the model goes to Strata-data next to it)"
    : "(the folder with setup.sh; the model goes to Strata-data next to it)"
}

// reload the views that show Strata after the address or key changed
function resetStrataViews() {
  strataReady = false
  chatLoaded = monitorLoaded = false
  chatView.classList.add("hidden")
  monitorView.classList.add("hidden")
  $("#chat-placeholder").classList.remove("hidden")
}
form.addEventListener("submit", async (e) => {
  e.preventDefault()
  const s = {}
  for (const el of form.elements) {
    if (!el.name) continue
    if (el.type === "radio") {
      if (el.checked) s[el.name] = el.value
    } else s[el.name] = el.type === "checkbox" ? el.checked : el.value.trim()
  }
  const before = JSON.stringify([settings.mode, settings.remoteUrl, settings.port, settings.apiKey])
  settings = await desk.setSettings(s)
  strataBase = await desk.strataBase()
  fillSettings()
  const strataChanged = before !== JSON.stringify([settings.mode, settings.remoteUrl, settings.port, settings.apiKey])
  if (strataChanged) {
    resetStrataViews()
    pollStrata()
    // opencode reads the Strata address and key when it starts
    if (await desk.agentRunning()) $("#btn-agent-restart").click()
  }
  $("#settings-saved").textContent = strataChanged
    ? "Saved. The coding agent restarted with the new Strata address (the Agent Terminal picks it up on its next start)."
    : "Saved. Restart the coding agent to apply port or model changes."
  setTimeout(() => ($("#settings-saved").textContent = ""), 5000)
})
form.querySelectorAll("[data-pick]").forEach((b) =>
  b.addEventListener("click", async () => {
    const d = await desk.pickFolder("Choose folder")
    if (d) form.elements[b.dataset.pick].value = d
  }),
)
form.querySelectorAll("[data-pickfile]").forEach((b) =>
  b.addEventListener("click", async () => {
    const f = await desk.pickFile("Choose the opencode program")
    if (f) form.elements[b.dataset.pickfile].value = f
  }),
)

// ---- start ----
;(async () => {
  settings = await desk.getSettings()
  const info = await desk.info()
  platform = info.platform
  strataBase = await desk.strataBase()
  fillSettings()
  $("#about").textContent = `Strata Desktop ${info.version} · opencode: ${info.opencode} · settings: ${info.userData}`
  if (!settings.strataDir && !isRemote()) {
    const marker = platform === "win32" ? "START-HERE.bat" : "setup.sh"
    terms.strata.term.write(`\x1b[33mChoose the Strata folder (the one with ${marker}) in Settings, or set Strata to remote.\x1b[0m\r\n`)
  }
  refreshButtons()
  await pollStrata()
  if (settings.autoStartStrata && !isRemote() && !strataReady && settings.strataDir) runTerm("strata", "strata", [])
  if (settings.autoStartAgent) startAgent()
  setInterval(pollStrata, 2000)
  setInterval(refreshAgent, 2000)
})()
