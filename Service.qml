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
  readonly property bool busy: statusProcess.running || resourcesProcess.running || whichProcess.running || actionPending
  readonly property string statusLabel: Model.statusLabel(installed ? connectionState : "missing")
  readonly property string statusDetail: Model.statusDetail(installed ? connectionState : "missing")
  readonly property string resourceCountLabel: Model.resourceCountLabel(resources.length, resourceScope)

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

  property string _statusOut: ""
  property string _resourcesOut: ""

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
    actionPending = true
    settleTimer.restart()
  }

  function connectNetwork() {
    runInTerminal("echo 'Connecting to Twingate...'; twingate start")
  }

  function disconnectNetwork() {
    runInTerminal("echo 'Disconnecting Twingate...'; sudo twingate stop")
  }

  function startService() {
    runInTerminal("echo 'Starting the Twingate service...'; sudo twingate service-start")
  }

  function stopService() {
    runInTerminal("echo 'Stopping the Twingate service...'; sudo twingate service-stop")
  }

  // One toggle that always does the obvious next thing for the current state.
  function toggleConnection() {
    if (!installed) return
    if (daemonDown) startService()
    else if (connected || connectionState === "authenticating") disconnectNetwork()
    else connectNetwork()
  }

  function openResourcesInTerminal() {
    var scope = resourceScope === "all" ? "twingate resources -d --all" : "twingate resources -d"
    runInTerminal("twingate status -d; echo; " + scope + "; echo; read -rp 'Press Enter to close...'")
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
      root.connectionState = next
      root.refreshResources()
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
