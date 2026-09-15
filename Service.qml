import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "Model.js" as Model

// Twingate state for the bar widget.
//
// Three kinds of command, kept apart:
//   * read-only polls (status, resources, account, unit state) run headless
//     through _bounded();
//   * connect and disconnect run through pkexec.
//     The CLI re-invokes sudo internally, which cannot prompt without a TTY;
//     pkexec elevates the whole command first through the desktop's polkit
//     agent (password or fingerprint), so that inner sudo has nothing to ask;
//   * installing the client and authenticating a single locked resource open
//     a floating terminal, because both print output the user has to read.
//
// A NOPASSWD sudoers rule is deliberately not used: it would let any process
// running as this user start or stop the tunnel without the user present.
Item {
  id: root

  property var settings: ({})
  property QtObject bar: null
  // Set by the Panel while its popup is open. Nothing on the bar icon reads
  // `resources`, so polling them while nobody can see them is pure waste in a
  // process shared with the whole desktop. The install-path probe and `status` stay
  // unconditional -- the icon does depend on those.
  property bool wantResources: false

  // ── Observed state ──────────────────────────────────────────────────
  property bool installed: false
  property string connectionState: "unknown"
  property var resources: []
  // What the last poll could not read. Cleared by the next good poll.
  property string lastError: ""
  // Why the last action failed. Kept apart from lastError so the poll that
  // follows a failure does not erase the explanation; cleared when the next
  // action starts.
  property string actionError: ""
  // The signed-in account, from `twingate account`. Empty when signed out or
  // not yet read.
  property string accountEmail: ""
  property string accountNetwork: ""
  // Set while a user-initiated action is in flight, so the switch shows the
  // requested position instead of snapping back on the next poll.
  property bool actionPending: false
  // Which action `actionProcess` is running.
  property string _actionKind: ""
  // Wall-clock floor between terminal launches. Deliberately independent of
  // observed state -- see runInTerminal.
  // Lower case initial is not style here, it is a hard QML rule: a property
  // whose name begins with a capital fails to parse and takes the whole
  // component down with it.
  readonly property int minLaunchGapMs: 5000
  property double _lastLaunchMs: 0
  // Written only when a connect is launched, and consumed by the transition
  // into authenticating. No other action may authorize an automatic browser
  // launch.
  property double _connectLaunchMs: 0

  readonly property bool connected: Model.isConnected(connectionState)
  readonly property bool daemonDown: Model.isDaemonDown(connectionState)
  // Authentication is the "switching on" phase, not a third resting state.
  // The switch has to read on throughout it, or the panel says
  // AUTHENTICATING beside a switch that says nothing is happening.
  readonly property bool connecting: connectionState === "authenticating"
  // What the user just asked for, while an action is still in flight. The
  // switch binds to observed state, and a connect waits on the polkit prompt
  // and then the daemon, so without this the knob snapped straight back to off
  // the instant it was flicked. -1 = no intent.
  property int _desired: -1
  readonly property bool desiredOn: _desired === -1 ? (connected || connecting) : (_desired === 1)

  // The badge rule, owned in one place. It was duplicated on the bar icon and
  // the hero icon, so editing one made the two disagree about whether
  // something was wrong.
  readonly property bool needsAttention: !installed || connectionState === "unknown"
  // Reserved for a user-initiated action. A routine status poll must NOT
  // count: it is true for an instant every few seconds, which spins the
  // refresh icon at random and implies the panel is working on something the
  // user asked for when it is only reading state in the background.
  readonly property bool busy: actionPending || actionProcess.running
  readonly property bool signedIn: accountEmail !== ""
  readonly property string statusLabel: Model.statusLabel(installed ? connectionState : "missing")
  readonly property string statusDetail: Model.statusDetail(installed ? connectionState : "missing")
  // What the whole list agrees on, used to decide whether a row's own status
  // is worth repeating. Not necessarily displayed -- see displayAuthStatus.
  readonly property string sharedAuthStatus: Model.sharedAuthStatus(resources)

  // Shown only when it explains something. A countdown does not.
  readonly property string displayAuthStatus: {
    return Model.isCountdownAuthStatus(sharedAuthStatus) ? "" : sharedAuthStatus
  }
  readonly property string resourceHeading: Model.resourceHeading(resources.length, resourceScope, resources.truncated === true)

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
  // The state when the last action was launched.
  property string _stateAtAction: ""

  // Everything an agent -- or a person running `omarchy-shell <id>
  // diagnostics` -- needs to explain a problem without reading the source.
  // The account address is deliberately left out: this output gets pasted
  // into bug reports.
  function diagnosticsJson() {
    return JSON.stringify({
      plugin: "veepee.twingate",
      installed: installed,
      state: installed ? connectionState : "missing",
      connected: connected,
      connecting: connecting,
      daemonDown: daemonDown,
      signedIn: signedIn,
      actionPending: actionPending,
      actionRunning: actionProcess.running ? _actionKind : "",
      awaitingSignIn: authUrl !== "",
      resourceCount: resources.length,
      resourcesTruncated: resources.truncated === true,
      lastError: lastError,
      actionError: actionError,
      settings: {
        refreshIntervalSec: refreshIntervalSec,
        visibility: visibility,
        resourceScope: resourceScope
      }
    }, null, 2)
  }

  // Logged with a namespace prefix so `qs -p ... log | grep twingate` finds
  // it, matching how the first-party idle and hass plugins log. Only failures
  // and state changes -- a line per poll would drown the shell's log.
  function _log(message) {
    console.warn("twingate: " + message)
  }

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
  // Probe for the CLI on every cycle rather than once. An earlier version
  // latched: it probed once, and if the client was absent `refresh()` returned
  // early forever, so installing the client never took effect.
  //
  // Quickshell's StdioCollector has no size limit of any kind -- its entire
  // API is text/data/waitForEnd -- so it retains everything a process writes,
  // in the shell's heap, and the clamp in each onExited below only runs once
  // that has already happened. A hostile or malfunctioning `twingate` could
  // therefore grow omarchy-shell, a long-lived process that owns the whole
  // bar, without bound before a single byte was ever parsed.
  //
  // So bound the producer instead. `head` closes the pipe at READ_LIMIT and
  // the CLI dies of SIGPIPE rather than being absorbed. The fd swap caps
  // stdout and stderr independently, which matters because this plugin reads
  // them separately: merging them would let stderr noise reach normalizeStatus
  // and be parsed as connection state. `pipefail` keeps the CLI's own exit
  // code -- without it the pipeline reports head's status (0) and every CLI
  // failure would read as success.
  //
  // `timeoutSec` defaults to the poll deadline. Actions pass a longer one,
  // because they wait on a person at the polkit prompt.
  function _bounded(argv, timeoutSec) {
    var seconds = timeoutSec === undefined ? Model.CLI_TIMEOUT_SEC : timeoutSec
    // Constants today, but this renders into a shell string, so validate
    // rather than trust. Only the leading executables may be absolute paths,
    // and only the ones this plugin is known to run.
    var leading = true
    for (var i = 0; i < argv.length; i++) {
      var arg = String(argv[i])
      if (leading && Model.TRUSTED_EXECUTABLES.indexOf(arg) !== -1) continue
      leading = false
      if (!/^[A-Za-z0-9_.-]+$/.test(arg)) {
        _log("refusing an unexpected CLI argument: " + arg)
        return []
      }
    }
    // Not just argv. READ_LIMIT is pasted into the shell string and the
    // deadline is interpreted as timeout's duration argument, so both are
    // validated exactly as CLIENT_VERSION and CLIENT_BUILDS.bytes are.
    var n = Model.READ_LIMIT
    if (!/^[1-9][0-9]{0,9}$/.test(String(n)) ||
        !/^[1-9][0-9]{0,3}$/.test(String(seconds))) {
      _log("refusing to render a malformed bound")
      return []
    }
    // `timeout` wraps BASH, not the CLI, and the order is the whole point.
    // GNU timeout runs its command in a new process group and at the deadline
    // sends SIGKILL to that group in one step, so a child cannot survive by
    // forking and ignoring SIGTERM. Both cases are executed in the test suite.
    //
    // Two limits, stated rather than hidden: a CLI that deliberately forks a
    // DETACHED child escapes the group, and a command pkexec has already
    // elevated runs as root, which this user cannot signal. In both cases the
    // wrapper still ends at the deadline, so the widget recovers; the escaped
    // process is outside what a bar widget can contain.
    //
    // `env -u` because non-interactive `bash -c` SOURCES $BASH_ENV before it
    // runs the script -- measured, not assumed. Not a privilege boundary, but
    // it costs one cheap fork.
    return ["/usr/bin/env", "-u", "BASH_ENV", "-u", "ENV",
            "/usr/bin/timeout", "--signal=KILL", String(seconds),
            "/usr/bin/bash", "-o", "pipefail", "-c",
            "{ { " + argv.join(" ") + "; } 2>&1 1>&3 3>&- | /usr/bin/head -c " + n + " >&2; }" +
            " 3>&1 | /usr/bin/head -c " + n]
  }

  // The vendor package installs this path. Testing it every interval is
  // cheaper than any scheme for deciding when to re-check, and it self-heals
  // in both directions. A fixed path also prevents an inherited interactive
  // PATH from substituting a different executable.
  function refresh() {
    if (whichProcess.running) return
    whichProcess.command = ["/usr/bin/test", "-x", "/usr/bin/twingate"]
    whichProcess.running = true
    _armPollWatchdog()
  }

  function refreshStatus() {
    if (statusProcess.running) return
    // -d disables colour so the parser never sees escape sequences.
    var cmd = _bounded(["/usr/bin/twingate", "status", "-d"])
    if (cmd.length === 0) return
    statusProcess.command = cmd
    statusProcess.running = true
    _armPollWatchdog()
  }

  function refreshAuthUrl() {
    if (verboseProcess.running) return
    var cmd = _bounded(["/usr/bin/twingate", "status", "-v", "-d"])
    if (cmd.length === 0) return
    verboseProcess.command = cmd
    verboseProcess.running = true
    _armPollWatchdog()
  }

  function refreshResources() {
    if (resourcesProcess.running) return
    // Clearing comes BEFORE the wantResources gate, so a disconnect with the
    // panel closed does not leave the last list behind for diagnostics to
    // report beside `connected: false`.
    if (!connected) {
      resources = []
      return
    }
    if (!wantResources) return
    var argv = ["/usr/bin/twingate", "resources", "-d"]
    if (resourceScope === "all") argv.push("--all")
    var cmd = _bounded(argv)
    if (cmd.length === 0) return
    resourcesProcess.command = cmd
    resourcesProcess.running = true
    _armPollWatchdog()
  }

  // Only the panel shows the account, so it is read only while the panel is
  // open.
  function refreshAccount() {
    if (accountProcess.running || !wantResources) return
    var cmd = _bounded(["/usr/bin/twingate", "account", "-d"])
    if (cmd.length === 0) return
    accountProcess.command = cmd
    accountProcess.running = true
    _armPollWatchdog()
  }

  // Every poll launcher returns early while its own process is still running,
  // so a `twingate` call that never exits would freeze the widget on stale
  // state permanently. It talks to a daemon that can wedge, so this is not
  // hypothetical; the first-party tailscale plugin ships the same guard.
  //
  // Armed on launch and not restarted while a poll is still in flight, so the
  // deadline cannot be outrun by an interval shorter than the timeout. Each
  // stage of a multi-stage refresh gets its own deadline, because the timer
  // is disarmed whenever nothing is running.
  function _armPollWatchdog() {
    if (!pollWatchdog.running) pollWatchdog.restart()
  }

  // Disarm as soon as the burst finishes. Without this a poll launched
  // shortly before the deadline was reaped a second later while perfectly
  // healthy, which produced an empty read and reported "unknown".
  function _disarmPollWatchdogIfIdle() {
    if (whichProcess.running || statusProcess.running || resourcesProcess.running
        || verboseProcess.running || accountProcess.running) return
    pollWatchdog.stop()
  }

  Timer {
    id: pollWatchdog
    interval: 15000
    repeat: false
    onTriggered: {
      var stuck = []
      if (whichProcess.running) { stuck.push("which"); whichProcess.running = false }
      if (statusProcess.running) { stuck.push("status"); statusProcess.running = false }
      if (resourcesProcess.running) { stuck.push("resources"); resourcesProcess.running = false }
      if (verboseProcess.running) { stuck.push("status -v"); verboseProcess.running = false }
      if (accountProcess.running) { stuck.push("account"); accountProcess.running = false }
      if (stuck.length > 0) {
        root.lastError = "Timed out waiting for: " + stuck.join(", ")
        root._log("watchdog reaped " + stuck.join(", ") + " after 15s")
      }
    }
  }

  // ── Actions without a terminal ──────────────────────────────────────
  // One action at a time. Returns whether it launched, so callers do not
  // assert an intent that was dropped. The refusal is visible: returning
  // silently after the switch had moved looked exactly like a broken switch.
  function _runAction(kind, argv) {
    if (actionProcess.running || actionPending) {
      lastError = "Another Twingate action is still running"
      _log("refused " + kind + " while another action was running")
      return false
    }
    var cmd = _bounded(argv, Model.ACTION_TIMEOUT_SEC)
    if (cmd.length === 0) return false
    // Any later action supersedes an earlier connect request. A connect
    // writes a fresh marker immediately after this returns.
    _connectLaunchMs = 0
    _actionKind = kind
    _stateAtAction = connectionState
    actionError = ""
    actionPending = true
    actionProcess.command = cmd
    actionProcess.running = true
    return true
  }

  // A connect-specific launcher, so only a connect can authorize the
  // automatic sign-in page.
  function _launchConnect(argv) {
    var launched = _runAction("connect", argv)
    if (launched) _connectLaunchMs = Date.now()
    return launched
  }

  // Also starts the daemon when it is down. Measured from `not-running`:
  // `pkexec twingate connect` printed "Starting Twingate service" and the
  // status read online within ten seconds, so there is no separate
  // start-service path.
  function connectNetwork() {
    return _launchConnect(["/usr/bin/pkexec", "/usr/bin/twingate", "connect"])
  }

  // `disconnect`, not `stop` -- though on Linux the difference is only in
  // intent, not in effect. Measured: BOTH exit the client, which takes
  // twingate.service down with it, so there is no disconnected-but-running
  // state to aim at (see isDaemonDown in Model.js).
  function disconnectNetwork() {
    return _runAction("disconnect", ["/usr/bin/pkexec", "/usr/bin/twingate", "disconnect"])
  }

  // Signing out is the user's own account state and needs no elevation.
  // With no identifier the CLI signs out the current account, which keeps
  // the account address out of the command line.
  function signOut() {
    if (!installed || !signedIn) return false
    return _runAction("sign-out", ["/usr/bin/twingate", "account", "logout", "-d"])
  }

  // `twingate start` does not reliably open a browser, and the URL it prints
  // is invisible when nothing shows the output, so turning the switch on
  // would strand the user on "Authenticating" with nothing to act on.
  //
  // `twingate status --verbose` re-prints the URL for as long as the session
  // is pending, so the switch can complete the job it started: turning it on
  // opens the sign-in page itself, and the panel needs no sign-in buttons.
  function openAuthUrl() {
    if (authUrl === "") return
    _openedAuthUrl = authUrl
    // Omarchy's browser launcher, not xdg-open: it resolves the configured
    // browser, launches it outside the shell's cgroup, and then focuses the
    // window. Opening the sign-in page behind the current window strands the
    // user exactly as not opening it at all would.
    Quickshell.execDetached(["/usr/bin/omarchy-launch-browser", authUrl])
  }

  // ── Actions in a terminal ───────────────────────────────────────────
  // `tracksState` is false for an action that does not move the connection
  // state, such as authenticating one resource: holding the switch busy for
  // the settle window would then block every other action for no reason.
  function runInTerminal(command, tracksState) {
    // Two independent bounds, because they fail differently.
    //
    // The monotonic floor comes first. `actionPending` alone only throttles:
    // it is cleared as soon as a status poll sees the state move. This floor
    // is wall-clock and nothing observed can shorten it.
    //
    // What it is NOT: a security boundary. Anything running as this user can
    // spawn a terminal directly, so this bounds a looping or buggy caller.
    var now = Date.now()
    if (now - _lastLaunchMs < minLaunchGapMs) {
      lastError = "Twingate actions are rate limited; try again in a moment"
      _log("refused a terminal action " + (now - _lastLaunchMs) + "ms after the last")
      return false
    }

    // The refusal must be VISIBLE. Returning silently after the switch had
    // moved looked exactly like a switch that does not work.
    if (actionPending) {
      lastError = "Another Twingate action is still running"
      _log("refused a second terminal action while one was pending")
      return false
    }
    if (!bar || typeof bar.run !== "function") {
      lastError = "No bar available to launch a terminal"
      return false
    }
    _lastLaunchMs = now
    // Any later action supersedes an earlier connect request.
    _connectLaunchMs = 0
    bar.run("/usr/bin/omarchy-launch-floating-terminal-with-presentation " + Util.shellQuote(command))
    if (tracksState === false) return true
    // The command runs outside our control, so poll harder for a short while
    // rather than waiting up to a full interval to notice the new state.
    _stateAtAction = connectionState
    actionPending = true
    settleTimer.elapsed = 0
    settleTimer.restart()
    return true
  }

  // A resource with its own authentication policy stays locked until the
  // user signs in to it. `twingate auth` prints the URL to open, so it runs
  // where that output can be read. The name is tenant-controlled: it is
  // quoted for the shell and placed after `--`, so a name beginning with a
  // dash cannot become an option.
  function authenticateResource(resource) {
    if (!resource || !connected || !Model.isLockedAuthStatus(resource.authStatus)) return false
    var name = Model.stripControl(resource.name)
    if (name === "") return false
    return runInTerminal("PATH=/usr/bin:/bin\n" +
                         "export PATH\n" +
                         "echo " + Util.shellQuote("Authenticating " + name + "...") + "\n" +
                         "twingate auth -- " + Util.shellQuote(name), false)
  }

  // Install the pinned client.
  //
  // A marketplace reviewer rejected an earlier version of this for fetching
  // the mutable `stable` path and handing it to `sudo pacman -U`, which let
  // root-executed bytes change independently of the reviewed commit. That
  // objection is answered by pinning, not by dropping the feature:
  //
  //   * the URL carries an explicit VERSION, so the path is immutable;
  //   * the sha256 is pinned in Model.js and verified BEFORE pacman is given
  //     the file, so a substituted artifact aborts the install rather than
  //     being executed as root;
  //   * `pacman -U` runs without --noconfirm, so the user still sees the
  //     package and confirms it.
  //
  // Twingate publishes no signature, so this digest is the only integrity
  // control in the chain -- which is exactly why it must be checked here and
  // never skipped.
  function installClient() {
    // Every pinned build is rendered into the case, so adding an architecture
    // to CLIENT_BUILDS is enough. The version is rendered too -- into
    // `url='...'` and, at the echo, inside DOUBLE quotes where $(...) and
    // backticks execute -- so it is validated like the build table.
    if (!/^[0-9A-Za-z._-]+$/.test(String(Model.CLIENT_VERSION))) {
      _log("refusing to render a malformed CLIENT_VERSION")
      return
    }
    var branches = ""
    for (var arch in Model.CLIENT_BUILDS) {
      var b = Model.CLIENT_BUILDS[arch]
      // Validated, not trusted. These are constants today, but this loop is
      // the documented extension point, so a malformed future entry must fail
      // to render rather than paste itself into a shell.
      if (!/^[A-Za-z0-9_]+$/.test(arch) ||
          !/^[A-Za-z0-9._-]+$/.test(String(b.file)) ||
          !/^[0-9a-f]{64}$/.test(String(b.sha256)) ||
          !/^[1-9][0-9]{0,9}$/.test(String(b.bytes))) {
        _log("skipping malformed CLIENT_BUILDS entry: " + arch)
        continue
      }
      branches += "  '" + arch + "')\n" +
                  "    url='" + Model.clientUrl(arch) + "'\n" +
                  "    file='" + b.file + "'\n" +
                  "    sum='" + b.sha256 + "'\n" +
                  "    max='" + b.bytes + "'\n" +
                  "    ;;\n"
    }
    runInTerminal(
      "set -u\n" +
      // The last hop before root, so nothing below is resolved through an
      // inherited PATH that may contain user-writable directories. /bin is a
      // symlink to /usr/bin on Arch; both are listed so the script is not
      // silently wrong on a distribution where they differ.
      "PATH=/usr/bin:/bin\n" +
      "export PATH\n" +
      "url=; file=; sum=; max=\n" +
      "case \"$(uname -m)\" in\n" + branches +
      "  *) echo \"No pinned Twingate build for $(uname -m).\" ;;\n" +
      "esac\n" +
      "if [ -n \"$url\" ]; then\n" +
      "  tmp=$(mktemp -d) || tmp=\n" +
      "  if [ -z \"$tmp\" ]; then echo 'Could not create a temporary directory.'; fi\n" +
      "  if [ -n \"$tmp\" ]; then\n" +
      "    trap 'rm -rf \"$tmp\"' EXIT\n" +
      "    echo \"Downloading Twingate " + Model.CLIENT_VERSION + " ($(uname -m))\"\n" +
      // The digest below fixes the byte count exactly, but it cannot say so
      // until curl has already finished writing. --max-filesize is that same
      // bound applied on the wire, and the scheme and redirect limits stop -L
      // being walked somewhere else entirely.
      "    if curl -fL --proto '=https' --proto-redir '=https' --max-redirs 5 \\\n" +
      "            --max-filesize \"$max\" --progress-bar -o \"$tmp/$file\" \"$url\"; then\n" +
      "      echo; echo 'Verifying checksum...'\n" +
      "      if (cd \"$tmp\" && printf '%s  %s\\n' \"$sum\" \"$file\" | sha256sum -c -); then\n" +
      "        echo\n" +
      "        sudo pacman -U \"$tmp/$file\"\n" +
      "      else\n" +
      "        echo; echo 'CHECKSUM MISMATCH - refusing to install.'\n" +
      "        echo 'The published file is not the one this plugin was reviewed against.'\n" +
      "      fi\n" +
      "    else\n" +
      "      echo; echo 'Download failed.'\n" +
      "    fi\n" +
      "  fi\n" +
      "fi")
  }

  // The switch is the only connection control, so "on" has to mean connected.
  // A connect starts the daemon itself when it is down, so there are only two
  // branches. The intent is recorded only if the action actually launched.
  function toggleConnection() {
    if (!installed) return "not-installed"
    if (connected || connecting) return disconnectNetwork() ? (_desired = 0, "ok") : "busy"
    return connectNetwork() ? (_desired = 1, "ok") : "busy"
  }

  // Opening a resource in a browser is an explicit opt-in (the `o` key), NOT
  // what clicking a row does, because most Twingate resources are not web
  // services and the CLI gives us no way to tell which are. The resources
  // table has no port or protocol, and `https://<ip>` on an SSH host merely
  // produces a browser error, so clicking copies the address instead.
  function openResource(resource) {
    if (!resource) return
    var address = Model.resourceAddress(resource)
    if (address === "") {
      copyToClipboard(Model.clipboardValue(resource))
      return
    }
    Quickshell.execDetached(["/usr/bin/omarchy-launch-browser", "https://" + address])
  }

  function copyToClipboard(value) {
    var text = String(value || "")
    if (text === "") return
    // wl-copy accepts the content as argv. `--` keeps an address beginning
    // with a dash from becoming an option, and no shell or quoting rule sits
    // between tenant-controlled text and the clipboard.
    Quickshell.execDetached(["/usr/bin/wl-copy", "--", text])
  }

  // ── Processes ───────────────────────────────────────────────────────
  Process {
    id: whichProcess
    running: false
    command: []
    onExited: function(exitCode) {
      root._disarmPollWatchdogIfIdle()
      if (root.installed && exitCode !== 0) root._log("the twingate CLI disappeared from /usr/bin")
      root.installed = exitCode === 0
      if (root.installed) {
        root.refreshStatus()
        root.refreshAccount()
      } else {
        root.connectionState = "unknown"
        root.resources = []
        root.accountEmail = ""
        root.accountNetwork = ""
        root.authUrl = ""
        root._openedAuthUrl = ""
        root._autoOpenArmed = false
        root._connectLaunchMs = 0
        root._lastState = ""
      }
    }
  }

  Process {
    id: statusProcess
    running: false
    command: []
    stdout: StdioCollector { id: statusStdout; waitForEnd: true }
    stderr: StdioCollector { id: statusStderr; waitForEnd: true }
    onExited: function(exitCode) {
      root._disarmPollWatchdogIfIdle()
      // Second line of defence only. The real bound is _bounded() above,
      // which caps the CLI before its bytes ever reach the collector.
      var out = String(statusStdout.text || "").slice(0, Model.READ_LIMIT)
      var err = String(statusStderr.text || "").slice(0, Model.READ_LIMIT)

      // State comes from stdout ONLY. normalizeStatus matches the state token
      // as a PREFIX, so a diagnostic like "online: failed to contact daemon"
      // on stderr would parse as `online`. stderr's job is the error text.
      var next = Model.normalizeStatus(out)
      if (next === "unknown" && exitCode !== 0) {
        root.lastError = Model.clampField(Model.stripControl(err.split("\n")[0])) || "twingate status failed"
        root._log("status exited " + exitCode + ": " + root.lastError)
      } else if (next === "unknown") {
        root._log("could not parse status output: " + JSON.stringify(out.slice(0, 120)))
        root.lastError = ""
      } else {
        root.lastError = ""
      }
      // Arm the browser launch on the TRANSITION into authenticating, not on
      // the request that caused it: the request returns before authentication
      // begins. The marker is written only by a connect and consumed here, so
      // the permission is one-shot.
      if (Model.shouldArmAutoOpen(next, root._lastState,
                                  root._connectLaunchMs, Date.now())) {
        root._connectLaunchMs = 0
        root._autoOpenArmed = true
      }
      // Do not record "unknown" as the previous state -- it is the absence of
      // information, and remembering it turns the next real reading into a
      // spurious transition.
      if (next !== "unknown") root._lastState = next

      // Stop the settle as soon as the state moves, but never while the
      // action itself is still running: its prompt may still be open.
      if (root.actionPending && !actionProcess.running && next !== root._stateAtAction) {
        root.actionPending = false
        root._desired = -1
        settleTimer.stop()
      }

      root.connectionState = next
      if (next === "authenticating") {
        root.refreshAuthUrl()
      } else if (next !== "unknown") {
        // Only a DEFINITE state clears the auth memory. Clearing it on
        // "unknown" meant one unparseable poll mid-sign-in re-armed and opened
        // the same login in another browser tab.
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
    stdout: StdioCollector { id: verboseStdout; waitForEnd: true }
    stderr: StdioCollector { id: verboseStderr; waitForEnd: true }
    onExited: function(exitCode) {
      root._disarmPollWatchdogIfIdle()
      // stdout ONLY, as for normalizeStatus: this URL is handed to a browser
      // with no user action, so tenant-controlled diagnostics on stderr must
      // not be able to supply it.
      var out = String(verboseStdout.text || "").slice(0, Model.READ_LIMIT)
      root.authUrl = Model.parseAuthUrl(out)
      // Open once, and only after a recent plugin connect request produced an
      // observed transition into authenticating.
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
    stdout: StdioCollector { id: resourcesStdout; waitForEnd: true }
    stderr: StdioCollector { id: resourcesStderr; waitForEnd: true }
    onExited: function(exitCode) {
      root._disarmPollWatchdogIfIdle()
      var out = String(resourcesStdout.text || "").slice(0, Model.READ_LIMIT)
      // An empty list and a failed listing are different things; only replace
      // a good list when the command actually produced output.
      if (exitCode === 0 || out !== "") {
        root.resources = Model.parseResources(out)
      } else {
        var rerr = Model.clampField(Model.stripControl(
          String(resourcesStderr.text || "").slice(0, Model.READ_LIMIT).split("\n")[0]))
        // A fixed fallback, because several real failures produce a non-zero
        // exit with EMPTY stderr -- `timeout` killing the CLI is one. Without
        // it the old list stayed on screen with nothing marking it stale.
        if (rerr === "") rerr = "twingate resources failed"
        root.lastError = rerr
      }
    }
  }

  Process {
    id: accountProcess
    running: false
    command: []
    stdout: StdioCollector { id: accountStdout; waitForEnd: true }
    onExited: function(exitCode) {
      root._disarmPollWatchdogIfIdle()
      var out = String(accountStdout.text || "").slice(0, Model.READ_LIMIT)
      // A failed read says nothing about the account, so it keeps what is
      // shown. A successful read without the sentence means signed out.
      if (exitCode !== 0 && out === "") return
      var account = Model.parseAccount(out)
      root.accountEmail = account.email
      root.accountNetwork = account.network
    }
  }

  Process {
    id: actionProcess
    running: false
    command: []
    stdout: StdioCollector { id: actionStdout; waitForEnd: true }
    stderr: StdioCollector { id: actionStderr; waitForEnd: true }
    onExited: function(exitCode) {
      var kind = root._actionKind
      root._actionKind = ""
      if (exitCode === 0) {
        // Poll harder until the new state shows, or the settle window ends.
        settleTimer.elapsed = 0
        settleTimer.restart()
        root.refresh()
        return
      }
      root.actionPending = false
      root._desired = -1
      root._connectLaunchMs = 0
      settleTimer.stop()
      // stderr first: that is where the CLI and pkexec explain a failure.
      var output = String(actionStderr.text || "").slice(0, Model.READ_LIMIT) + "\n" +
                   String(actionStdout.text || "").slice(0, Model.READ_LIMIT)
      var failure = Model.clampField(Model.stripControl(Model.actionFailure(kind, exitCode, output)))
      // Dismissing the prompt is a choice, not an error: the switch simply
      // returns to where it was.
      root.actionError = failure
      if (failure !== "") root._log(kind + " exited " + exitCode + ": " + failure)
      root.refresh()
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

  // After an action, poll every 2s for 30s so the widget reflects the result
  // promptly. Authentication in the browser can take a while, hence the long
  // window.
  Timer {
    id: settleTimer
    interval: 2000
    repeat: true
    running: false
    property int elapsed: 0
    onRunningChanged: if (running) elapsed = 0
    onTriggered: {
      elapsed += interval
      root.refresh()
      if (elapsed >= 30000) {
        running = false
        root.actionPending = false
        // Stop asserting an intent reality never confirmed.
        root._desired = -1
      }
    }
  }
}
