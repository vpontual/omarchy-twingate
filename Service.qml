import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "Model.js" as Model

// Twingate state for the bar widget.
//
// The hard constraint that shapes this file: `twingate start` and
// `twingate stop` re-invoke sudo themselves and expect a controlling
// terminal. `twingate start` is interactive beyond that -- it asks the
// operator to press enter. Running either from omarchy-shell (which has no
// TTY) fails with "sudo: a terminal is required to read the password".
//
// So the split is absolute:
//   * read-only commands (status, resources) run headless here;
//   * every state-changing command is handed to a floating terminal.
//
// A NOPASSWD sudoers rule would not fix this and is deliberately not used --
// it would not make `twingate start` non-interactive, and it would widen the
// plugin's privilege surface for no gain.
Item {
  id: root

  property var settings: ({})
  property QtObject bar: null

  // ── Observed state ──────────────────────────────────────────────────
  property bool installed: false
  property bool probedInstall: false
  property string connectionState: "unknown"
  property var resources: []
  property bool refreshing: false
  property string lastError: ""
  // Set while a terminal action is in flight so the UI can show the toggle as
  // busy instead of snapping back to the pre-action state on the next poll.
  property bool actionPending: false

  readonly property bool connected: Model.isConnected(connectionState)
  readonly property bool daemonDown: Model.isDaemonDown(connectionState)
  // Authentication is the "switching on" phase, not a third resting state.
  // The switch has to read on throughout it, or the panel says
  // AUTHENTICATING beside a switch that says nothing is happening.
  readonly property bool connecting: connectionState === "authenticating"
  // Reserved for a user-initiated action. A routine status poll must NOT
  // count: it is true for an instant every few seconds, which spins the
  // refresh icon at random and implies the panel is working on something the
  // user asked for when it is only reading state in the background.
  readonly property bool busy: actionPending
  readonly property bool polling: statusProcess.running || resourcesProcess.running || whichProcess.running
  readonly property string statusLabel: Model.statusLabel(installed ? connectionState : "missing")
  readonly property string statusDetail: Model.statusDetail(installed ? connectionState : "missing")
  // What the whole list agrees on, used to decide whether a row's own status
  // is worth repeating. Not necessarily displayed -- see displayAuthStatus.
  readonly property string sharedAuthStatus: Model.sharedAuthStatus(resources)

  // Shown only when it explains something. A countdown does not.
  readonly property string displayAuthStatus: {
    return Model.isCountdownAuthStatus(sharedAuthStatus) ? "" : sharedAuthStatus
  }
  readonly property string resourceHeading: Model.resourceHeading(resources.length, resourceScope)

  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 10, 5, 3600)
  readonly property string visibility: stringSetting("visibility", "always")
  readonly property string resourceScope: stringSetting("resourceScope", "default")

  // Whether the bar should render this widget at all, per the visibility
  // setting. "always" is the default because a widget that silently vanishes
  // is indistinguishable from a broken one.
  readonly property bool shouldShow: {
    if (visibility === "when-online") return connected
    if (visibility === "when-installed") return installed
    return true
  }

  // The sign-in URL, present only while authenticating.
  property string authUrl: ""

  property string _statusOut: ""
  property string _resourcesOut: ""
  property string _verboseOut: ""
  // The URL we have already opened, so a poll every few seconds does not
  // reopen a browser tab forever.
  property string _openedAuthUrl: ""
  // The previously observed state, so we can tell "authentication just
  // started" from "authentication was already pending when we looked".
  property string _lastState: ""
  // Armed by a transition INTO authenticating, i.e. an auth that began while
  // we were watching. A session already pending when the shell starts is
  // never auto-opened -- reopening someone's hours-old login in a browser
  // they did not just ask for is worse than making them press Connect again.
  property bool _autoOpenArmed: false
  // The state when the last terminal action was launched.
  property string _stateAtAction: ""

  // ── Settings ────────────────────────────────────────────────────────
  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function intSetting(name, fallback, min, max) {
    var value = Number(setting(name, fallback))
    if (!isFinite(value)) return fallback
    return Math.max(min, Math.min(max, Math.round(value)))
  }

  function stringSetting(name, fallback) {
    var value = setting(name, fallback)
    return typeof value === "string" && value !== "" ? value : fallback
  }

  // ── Polling ─────────────────────────────────────────────────────────
  function refresh() {
    if (!probedInstall) {
      whichProcess.command = ["which", "twingate"]
      whichProcess.running = true
      return
    }
    if (!installed) return
    refreshStatus()
  }

  function refreshStatus() {
    if (statusProcess.running) return
    refreshing = true
    // -d disables colour so the parser never sees escape sequences.
    statusProcess.command = ["twingate", "status", "-d"]
    statusProcess.running = true
  }

  function refreshAuthUrl() {
    if (verboseProcess.running) return
    verboseProcess.command = ["twingate", "status", "-v", "-d"]
    verboseProcess.running = true
  }

  function refreshResources() {
    if (resourcesProcess.running) return
    if (!connected) {
      resources = []
      return
    }
    var argv = ["twingate", "resources", "-d"]
    if (resourceScope === "all") argv.push("--all")
    resourcesProcess.command = argv
    resourcesProcess.running = true
  }

  // ── Actions (all privileged, all via a terminal) ─────────────────────
  function runInTerminal(command) {
    if (!bar || typeof bar.run !== "function") {
      lastError = "No bar available to launch a terminal"
      return
    }
    bar.run("omarchy-launch-floating-terminal-with-presentation " + Util.shellQuote(command))
    // The command runs outside our control, so poll harder for a short while
    // rather than waiting up to a full interval to notice the new state.
    // Remember what we are leaving, so the settle can end the moment the state
    // actually moves instead of always running its full length.
    _stateAtAction = connectionState
    actionPending = true
    settleTimer.restart()
  }

  function connectNetwork() {
    runInTerminal("echo 'Connecting to Twingate...'; twingate start")
  }

  // `twingate start` does not reliably open a browser, and the URL it prints
  // scrolls away with the terminal, so flipping the switch used to strand the
  // user on "Authenticating" with nothing to act on. That is a real report
  // from first use, not a hypothetical.
  //
  // `twingate status --verbose` re-prints the URL for as long as the session
  // is pending, so the switch can complete the job it started: turning it on
  // opens the sign-in page itself, and the panel needs no sign-in buttons.
  function openAuthUrl() {
    if (authUrl === "") return
    _openedAuthUrl = authUrl
    Quickshell.execDetached(["xdg-open", authUrl])
  }

  function disconnectNetwork() {
    runInTerminal("echo 'Disconnecting Twingate...'; sudo twingate stop")
  }

  // Starting the service is not enough on its own: twingate.service ships
  // disabled on Arch and stays that way. The package's .install hook is
  // Twingate's Debian postinst, and its `systemctl preset` call sits inside a
  // block gated on $1 = "configure" -- a dpkg argument. On Arch $1 is the
  // version string, so that block never runs and the unit is never preset.
  // The result is that every reboot lands the user back on "Service stopped".
  //
  // So offer to fix it, once, at the only moment it makes sense: the user has
  // just chosen to start the service and sudo is already authenticated, so
  // accepting costs no extra prompt. The question is only asked while the
  // unit is actually disabled, and defaults to No -- enabling a system unit
  // at boot is a persistent change to the machine and must never happen
  // because someone hit Enter out of reflex. Declining prints the command so
  // the choice stays recoverable.
  function _serviceStartScript() {
    return "echo 'Starting the Twingate service...'\n" +
           "sudo twingate service-start || exit 1\n" +
           "if ! systemctl is-enabled --quiet twingate.service; then\n" +
           "  echo\n" +
           "  if gum confirm --default=false 'Also start Twingate automatically at every boot?'; then\n" +
           "    sudo systemctl enable twingate.service\n" +
           "  else\n" +
           "    echo 'Left as manual. Enable later with: sudo systemctl enable twingate.service'\n" +
           "  fi\n" +
           "fi\n"
  }

  function startService() {
    runInTerminal(_serviceStartScript() + "exit 0")
  }

  // One flick, one terminal, both steps -- and the same sudo session covers
  // the service start and the connect.
  function startServiceAndConnect() {
    runInTerminal(_serviceStartScript() +
                  "echo\n" +
                  "echo 'Connecting to Twingate...'\n" +
                  "twingate start\n" +
                  "exit 0")
  }

  function stopService() {
    runInTerminal("echo 'Stopping the Twingate service...'; sudo twingate service-stop")
  }

  // Install straight from Twingate.
  //
  // The file Twingate publishes is ALREADY a pacman package -- it carries
  // .PKGINFO, .MTREE and .INSTALL, and its pkgname is "twingate". That is why
  // both AUR packages amount to unpacking it and packing it again, and both
  // currently introduce a bug the original does not have:
  //
  //   twingate      pinned sha256 went stale on 2026-07-09 when upstream
  //                 republished; reported on the AUR 2026-07-10 and confirmed
  //                 2026-07-13, still unfixed. `yay -S` fails validity check.
  //
  //   twingate-bin  hand-lists the files it copies and omits
  //                 /usr/bin/twingate-classic, which the client shells out to
  //                 for privileged work. Installs cleanly, then disconnect
  //                 dies with "sudo: twingate-classic: command not found".
  //                 Zero comments on its AUR page -- unreported.
  //
  // So neither middleman is used. pacman installs from a URL directly, which
  // gets the current build with all four binaries and no third party in the
  // path. The cost is that pacman will not track updates for a -U install;
  // the README says so. `yay` update integration was the only thing the AUR
  // was buying, and it is a poor trade against two broken packages.
  //
  // Verified 2026-08-25: upstream .PKGINFO reads pkgver 2026.190.6704-1,
  // newer than either AUR package claims.
  function installClient() {
    runInTerminal(
      "base='https://binaries.twingate.com/client/linux/ARCH'\n" +
      "case \"$(uname -m)\" in\n" +
      "  x86_64)  url=\"$base/x86_64/stable/twingate-amd64.pkg.tar.zst\" ;;\n" +
      "  aarch64) url=\"$base/aarch64/stable/twingate-arm64.pkg.tar.zst\" ;;\n" +
      "  *) echo \"No Twingate build for $(uname -m).\"; exit 1 ;;\n" +
      "esac\n" +
      "echo \"Installing the Twingate client from $url\"\n" +
      "sudo pacman -U --noconfirm \"$url\"")
  }

  // The switch is the only connection control, so "on" has to mean connected,
  // not "one step closer to connected". With the daemon down that means
  // starting the service AND connecting in the same terminal run: doing only
  // the first would start the service, leave the state at offline, and spring
  // the switch back to off, which reads as the switch not working.
  function toggleConnection() {
    if (!installed) return
    if (daemonDown) startServiceAndConnect()
    else if (connected || connecting) disconnectNetwork()
    else connectNetwork()
  }

  // Opening a resource in a browser is an explicit opt-in (the `o` key), NOT
  // what clicking a row does, because most Twingate resources are not web
  // services and the CLI gives us no way to tell which are.
  //
  // The resources table has exactly four columns -- NAME, ADDRESS, ALIAS,
  // AUTH STATUS -- and no port or protocol. A resource can equally be an SSH
  // host, a database, an RDP target or a web UI on a non-standard port.
  // Measured on a real network: of eight resources, two were web hostnames,
  // one was a wildcard with no single address, and the rest were bare IPs
  // reached over SSH. `https://<ip>` on an SSH host merely produces a browser
  // error, so clicking copies the address instead -- useful whatever the
  // protocol turns out to be.
  //
  // A wildcard such as "*.casavp.com" has no single address; resourceAddress()
  // already rejects it (a leading * fails the host shape), so it copies.
  function openResource(resource) {
    if (!resource) return
    var address = Model.resourceAddress(resource)
    if (address === "") {
      copyToClipboard(String(resource.address || resource.name || ""))
      return
    }
    Quickshell.execDetached(["xdg-open", "https://" + address])
  }

  function copyToClipboard(value) {
    var text = String(value || "")
    if (text === "") return
    Quickshell.execDetached(["bash", "-c", "printf %s " + Util.shellQuote(text) + " | wl-copy"])
  }

  // ── Processes ───────────────────────────────────────────────────────
  Process {
    id: whichProcess
    running: false
    command: []
    onExited: function(exitCode) {
      root.probedInstall = true
      root.installed = exitCode === 0
      if (root.installed) {
        root.refreshStatus()
      } else {
        root.refreshing = false
        root.connectionState = "unknown"
        root.resources = []
      }
    }
  }

  Process {
    id: statusProcess
    running: false
    command: []
    stdout: StdioCollector { id: statusStdout; waitForEnd: true; onStreamFinished: root._statusOut = text }
    stderr: StdioCollector { id: statusStderr; waitForEnd: true }
    onExited: function(exitCode) {
      root.refreshing = false
      var out = String(statusStdout.text || root._statusOut || "")
      var err = String(statusStderr.text || "")

      // The CLI prints the state token on stdout and exits non-zero for some
      // states, so a non-zero exit is only an error when nothing parseable
      // came back on either stream.
      var next = Model.normalizeStatus(out !== "" ? out : err)
      if (next === "unknown" && exitCode !== 0) {
        root.lastError = err.split("\n")[0] || "twingate status failed"
      } else {
        root.lastError = ""
      }
      // Arm the browser launch on the TRANSITION into authenticating, not on
      // the request that caused it. An earlier version set a flag inside
      // connectNetwork(), but `twingate start` runs in a terminal and takes
      // seconds: the very next poll still saw "offline", cleared the flag,
      // and the browser never opened once authentication actually began.
      if (next === "authenticating" && root._lastState !== "" && root._lastState !== "authenticating") {
        root._autoOpenArmed = true
      }
      root._lastState = next

      // Stop the settle as soon as the state moves. Running it for the full
      // 30s regardless left the refresh icon spinning long after the action
      // had finished, which reads as the panel being stuck.
      if (root.actionPending && next !== root._stateAtAction) {
        root.actionPending = false
        settleTimer.stop()
      }

      root.connectionState = next
      if (next === "authenticating") {
        root.refreshAuthUrl()
      } else {
        root.authUrl = ""
        root._openedAuthUrl = ""
        root._autoOpenArmed = false
      }
      root.refreshResources()
    }
  }

  Process {
    id: verboseProcess
    running: false
    command: []
    stdout: StdioCollector { id: verboseStdout; waitForEnd: true; onStreamFinished: root._verboseOut = text }
    stderr: StdioCollector { id: verboseStderr; waitForEnd: true }
    onExited: function(exitCode) {
      var out = String(verboseStdout.text || root._verboseOut || "")
      if (out === "") out = String(verboseStderr.text || "")
      root.authUrl = Model.parseAuthUrl(out)
      // Open once, and only for an auth this plugin started.
      if (root.authUrl !== "" && root._autoOpenArmed && root.authUrl !== root._openedAuthUrl) {
        root._autoOpenArmed = false
        root.openAuthUrl()
      }
    }
  }

  Process {
    id: resourcesProcess
    running: false
    command: []
    stdout: StdioCollector { id: resourcesStdout; waitForEnd: true; onStreamFinished: root._resourcesOut = text }
    stderr: StdioCollector { id: resourcesStderr; waitForEnd: true }
    onExited: function(exitCode) {
      var out = String(resourcesStdout.text || root._resourcesOut || "")
      // An empty list and a failed listing are different things; only replace
      // a good list when the command actually produced output.
      if (exitCode === 0 || out !== "") root.resources = Model.parseResources(out)
    }
  }

  // ── Timers ──────────────────────────────────────────────────────────
  Timer {
    id: refreshTimer
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  // After a terminal action, poll every 2s for 30s so the widget reflects the
  // result promptly. Authentication can take a while, hence the long window.
  Timer {
    id: settleTimer
    interval: 2000
    repeat: true
    running: false
    property int elapsed: 0
    onRunningChanged: if (running) elapsed = 0
    onTriggered: {
      elapsed += interval
      root.refreshStatus()
      if (elapsed >= 30000) {
        running = false
        root.actionPending = false
      }
    }
  }
}
