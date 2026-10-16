# Strata Desktop

One app for the Strata engine and the opencode coding agent, without a separate terminal. It runs on Windows and
macOS (Apple Silicon).

- **Engine**: in local mode, runs Strata's own scripts (`START-HERE.bat` / `UPDATE.bat` / `BENCH.bat` / `--check`
  on Windows, `./setup.sh` / `./update.sh` / `./bench.sh` on macOS) in a real console inside the app, so setup's
  questions work as in a terminal. **Stop** sends Ctrl+C, then ends the process tree. In remote mode it shows the
  remote engine's status and its Monitor.
- **Chat & Monitor**: Strata's web app (`http://127.0.0.1:8080`, or the remote address) once the model is ready.
- **Coding Agent**: opencode's web UI (`opencode serve` on `127.0.0.1:4096`), with the bundled opencode 1.19.1.
- **Agent Terminal**: opencode's full terminal UI, or a shell (PowerShell on Windows, your login shell on macOS)
  with the Strata provider already configured.
- **Settings**: local or remote Strata, Strata folder or remote address, project folder, ports, API key, opencode
  path, auto-start.

opencode gets the Strata provider through `OPENCODE_CONFIG_CONTENT` (provider `strata`, OpenAI-compatible,
`<Strata address>/v1` with the API key), layered on top of your own opencode config, so your other providers keep
working.

## Local or remote Strata

**Local** (the default): Strata runs on this computer. The app sets it up, starts and stops it.

**Remote**: Strata runs on another computer, for example a Windows PC with the graphics card, and this app (for
example on a Mac) uses it. In **Settings → Where Strata runs**, choose **On another computer**, enter the address
(`http://win-pc:8080`, a Tailscale name such as `http://win-pc.your-tailnet.ts.net:8080`, or an IP) and the API key,
and save. Then:

- Chat & Monitor and the Engine tab's Monitor load the remote Strata; the app sends the key with every request.
- The coding agent runs on this computer, on your files here, and sends only the model's requests to the remote
  Strata (provider **Strata (remote)**). Saving a new address restarts the coding agent so it picks it up.
- Setup, Start, Stop, Update, Check PC and Benchmark are hidden: do those on the PC that runs Strata.
- Nothing of Strata is installed on this computer, and no model is downloaded here.

## Set up the Windows PC as the Strata host

The PC keeps running Strata (and the model) and serves it to the Mac. It can run without a monitor, keyboard or a
signed-in user.

1. **Let other computers reach Strata, with a key.** In the Strata folder, start it once with:

   ```bat
   START-HERE.bat --host 0.0.0.0 --api-key <a long random secret>
   ```

   Strata keeps both in its config (`strata-<model>.json`), so later starts use them too. Never use
   `--host 0.0.0.0` without `--api-key`. Put the same key into the app's Settings on the Mac.

2. **Start it at boot, with nobody signed in.** Task Scheduler → **Create Task**:
   - General: **Run whether user is logged on or not**, **Run with highest privileges**.
   - Triggers: **At startup**.
   - Actions: **Start a program**, program `C:\Users\<you>\StrataDesktop\Strata\START-HERE.bat`, arguments
     `--no-browser`, start in `C:\Users\<you>\StrataDesktop\Strata`.
   - Settings: untick **Stop the task if it runs longer than**.

   Or from an administrator PowerShell (it asks for your Windows password once):

   ```powershell
   $dir = "$env:USERPROFILE\StrataDesktop\Strata"
   $action = New-ScheduledTaskAction -Execute "$dir\START-HERE.bat" -Argument "--no-browser" -WorkingDirectory $dir
   $trigger = New-ScheduledTaskTrigger -AtStartup
   $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
   Register-ScheduledTask -TaskName "Strata" -Action $action -Trigger $trigger -Settings $settings -User $env:USERNAME -RunLevel Highest -Password (Read-Host "Windows password")
   ```

   The model takes 1-3 minutes to load after boot. Run the task once by hand (`Start-ScheduledTask Strata`) and
   check that `http://127.0.0.1:8080/health` answers on the PC.

3. **Never sleep.** Settings → System → Power: **Never** for sleep when plugged in, or:

   ```powershell
   powercfg /change standby-timeout-ac 0
   powercfg /change hibernate-timeout-ac 0
   ```

4. **Network: use Tailscale, or open the port on your home network.**
   - **Tailscale** (recommended): install it on the PC and the Mac and sign in to the same account. The Mac reaches
     the PC as `http://<pc-name>:8080` (MagicDNS) from anywhere, encrypted, with no port open on your router.
   - **Home network only**: allow port 8080 in Windows Firewall (administrator PowerShell), then use the PC's name
     or IP (`ipconfig`):

     ```powershell
     New-NetFirewallRule -DisplayName "Strata 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private
     ```

   Never forward the port on your router to the internet.

## Build on Windows

```bash
npm install
npm run dist
```

`resources/opencode/opencode.exe` comes from `packages/opencode` in the opencode source:
`OPENCODE_VERSION=1.19.1 OPENCODE_CHANNEL=latest bun run build --single`.
Output: `dist/StrataDesktop-1.0.0-portable.exe` and `dist/StrataDesktop-1.0.0-setup.exe`.

## Build the Mac app (DMG)

A DMG can only be built on macOS. Two ways:

**On GitHub** (no Mac tools needed): push this folder (the parent of `app/`) to a GitHub repository, then run the
**Mac DMG** workflow (`.github/workflows/mac-dmg.yml`) from the Actions tab, or push a tag like `v1.0.0`. It builds
opencode 1.19.1 for darwin-arm64 from source, bundles it, builds the DMG and attaches it to the run as an artifact.

**On the Mac itself** (Apple Silicon, macOS 13 or newer):

```bash
xcode-select --install                      # once: Apple's command line tools
brew install node                           # or Node 22 from nodejs.org
curl -fsSL https://bun.sh/install | bash    # bun, to build opencode

# opencode 1.19.1 for darwin-arm64
git clone --depth 1 --branch v1.19.1 https://github.com/anomalyco/opencode.git opencode-src
cd opencode-src && bun install && cd packages/opencode
OPENCODE_VERSION=1.19.1 OPENCODE_CHANNEL=latest bun run build --single
cp dist/opencode-darwin-arm64/bin/opencode <path to>/app/resources/opencode/opencode

# the app
cd <path to>/app
npm ci
npm run dist:mac                            # dist/StrataDesktop-1.0.0-arm64.dmg
```

Skip the opencode build to use one you already have: install opencode on the Mac (`brew install anomalyco/tap/opencode`
or `npm i -g opencode-ai`) and point **Settings → opencode program** at it; the app also finds `opencode` on the
usual Homebrew paths.

The app is signed ad hoc, not with an Apple Developer ID. The first time, macOS says it can't check it: right-click
**Strata Desktop** in Applications → **Open** → **Open**. A DMG downloaded from GitHub may instead say the app "is
damaged": run `xattr -cr "/Applications/Strata Desktop.app"` once, then open it.
