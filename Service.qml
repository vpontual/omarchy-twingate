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
  // Set by the Panel while its popup is open. Nothing on the bar icon reads
  // `resources`, so polling them while nobody can see them is pure waste in a
  // process shared with the whole desktop. `which` and `status` stay
  // unconditional -- the icon does depend on those.
  property bool wantResources: false

  // ── Observed state ──────────────────────────────────────────────────
  property bool installed: false
  property string connectionState: "unknown"
  property var resources: []
  property string lastError: ""
  // Set while a terminal action is in flight so the UI can show the toggle as
  // busy instead of snapping back to the pre-action state on the next poll.
  property bool actionPending: false
  // Wall-clock floor between terminal launches. Deliberately independent of
  // observed state -- see runInTerminal.
  // Lower case initial is not style here, it is a hard QML rule: a property
  // whose name begins with a capital fails to parse and takes the whole
  // component down with it. Shipped once as MIN_LAUNCH_GAP_MS, which made the
  // plugin fail to load entirely -- and neither the test suite nor
  // `omarchy plugin validate` noticed, because neither one loads the QML.
  readonly property int minLaunchGapMs: 5000
  property double _lastLaunchMs: 0

  readonly property bool connected: Model.isConnected(connectionState)
  readonly property bool daemonDown: Model.isDaemonDown(connectionState)
  // Authentication is the "switching on" phase, not a third resting state.
  // The switch has to read on throughout it, or the panel says
  // AUTHENTICATING beside a switch that says nothing is happening.
  readonly property bool connecting: connectionState === "authenticating"
  // What the user just asked for, while a terminal action is still in flight.
  // The switch binds to observed state, and a connect takes 5-60s (sudo
  // prompt, a gum question, then `twingate start` waiting on a keypress), so
  // without this the knob snapped straight back to off the instant it was
  // flicked -- and `busy` then swallowed further clicks. -1 = no intent.
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
  readonly property bool busy: actionPending
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
  // The state when the last terminal action was launched.
  property string _stateAtAction: ""

  // Everything an agent -- or a person running `omarchy-shell <id>
  // diagnostics` -- needs to explain a problem without reading the source.
  // Deliberately a single call: the alternative is a dozen getters, and
  // whoever is debugging does not yet know which one they need.
  function diagnosticsJson() {
    return JSON.stringify({
      plugin: "veepee.twingate",
      installed: installed,
      state: installed ? connectionState : "missing",
      connected: connected,
      connecting: connecting,
      daemonDown: daemonDown,
      actionPending: actionPending,
      awaitingSignIn: authUrl !== "",
      resourceCount: resources.length,
      resourcesTruncated: resources.truncated === true,
      lastError: lastError,
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
  // early forever, so installing the client never took effect. The panel then
  // sat on "Not installed" while polling that had resumed by another path
  // listed eight live resources beneath it -- the header and the body of the
  // same panel disagreeing.
  //
  // Quickshell's StdioCollector has no size limit of any kind -- its entire
  // API is text/data/waitForEnd -- so it retains everything a process writes,
  // in the shell's heap, and the clamp in each onExited below only runs once
  // that has already happened. A hostile or malfunctioning `twingate` could
  // therefore grow omarchy-shell, a long-lived process that owns the whole
  // bar, without bound before a single byte was ever parsed.
  //
  // So bound the producer instead. `head` closes the pipe at MAX_INPUT and the
  // CLI dies of SIGPIPE rather than being absorbed. The fd swap caps stdout
  // and stderr independently, which matters because this plugin reads them
  // separately: merging them would let stderr noise reach normalizeStatus and
  // be parsed as connection state. `pipefail` is what keeps the CLI's own exit
  // code -- without it the pipeline reports head's status (0) and every CLI
  // failure would read as success, which all three handlers treat as
  // load-bearing (`installed` is literally `exitCode === 0`).
  function _bounded(argv) {
    // Constants today, but this renders into a shell string, so validate
    // rather than trust -- the same rule as the CLIENT_BUILDS loop.
    for (var i = 0; i < argv.length; i++) {
      if (!/^[A-Za-z0-9_.-]+$/.test(String(argv[i]))) {
        _log("refusing an unexpected CLI argument: " + argv[i])
        return []
      }
    }
    var n = Model.READ_LIMIT
    // `env -u` because non-interactive `bash -c` SOURCES $BASH_ENV before it
    // runs the script -- measured, not assumed. Not a privilege boundary:
    // anything that can set BASH_ENV in the shell's environment already runs
    // as this user. It is defence in depth, and it costs one cheap fork.
    return ["env", "-u", "BASH_ENV", "-u", "ENV",
            "bash", "-o", "pipefail", "-c",
            "{ { " + argv.join(" ") + "; } 2>&1 1>&3 3>&- | head -c " + n + " >&2; }" +
            " 3>&1 | head -c " + n]
  }

  // `which` is a PATH lookup costing well under a millisecond, so running it
  // every interval is cheaper than any scheme for deciding when to re-check,
  // and it self-heals in both directions: install or remove the client and the
  // panel is right within one refresh.
  function refresh() {
    if (whichProcess.running) return
    whichProcess.command = ["which", "twingate"]
    whichProcess.running = true
    _armPollWatchdog()
  }

  function refreshStatus() {
    if (statusProcess.running) return
    // -d disables colour so the parser never sees escape sequences.
    var cmd = _bounded(["twingate", "status", "-d"])
    if (cmd.length === 0) return
    statusProcess.command = cmd
    statusProcess.running = true
    _armPollWatchdog()
  }

  function refreshAuthUrl() {
    if (verboseProcess.running) return
    var cmd = _bounded(["twingate", "status", "-v", "-d"])
    if (cmd.length === 0) return
    verboseProcess.command = cmd
    verboseProcess.running = true
    _armPollWatchdog()
  }

  function refreshResources() {
    if (resourcesProcess.running) return
    // Clearing comes BEFORE the wantResources gate. With the order reversed a
    // closed panel skipped the clear, so a disconnect left the last good list
    // in place -- invisible in the UI, which gates every resource binding on
    // `connected`, but diagnostics reports the count unconditionally and would
    // print `connected: false` beside a non-zero resourceCount.
    if (!connected) {
      resources = []
      return
    }
    if (!wantResources) return
    var argv = ["twingate", "resources", "-d"]
    if (resourceScope === "all") argv.push("--all")
    var cmd = _bounded(argv)
    if (cmd.length === 0) return
    resourcesProcess.command = cmd
    resourcesProcess.running = true
    _armPollWatchdog()
  }

  // Every poll launcher returns early while its own process is still running,
  // so a `twingate` call that never exits would freeze the widget on stale
  // state permanently -- no error, no recovery short of restarting the shell.
  // It talks to a daemon that can wedge, so this is not hypothetical; the
  // first-party tailscale plugin ships the same guard for the same reason.
  //
  // Armed on launch and never re-armed by a later poll: restarting it each
  // refresh would let the deadline outrun a hung process once the interval is
  // shorter than the timeout, and the interval floor here is 5s.
  function _armPollWatchdog() {
    if (!pollWatchdog.running) pollWatchdog.restart()
  }

  // Disarm as soon as the burst finishes. Without this the deadline kept
  // running after a healthy poll completed, so a poll launched shortly before
  // it expired was reaped a second later while perfectly healthy -- which
  // produced an empty read and reported "unknown". Only a poll that is STILL
  // running at the deadline should be treated as hung.
  function _disarmPollWatchdogIfIdle() {
    if (whichProcess.running || statusProcess.running
        || resourcesProcess.running || verboseProcess.running) return
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
      if (stuck.length > 0) {
        root.lastError = "Timed out waiting for: " + stuck.join(", ")
        root._log("watchdog reaped " + stuck.join(", ") + " after 15s")
      }
    }
  }

  // ── Actions (all privileged, all via a terminal) ─────────────────────
  // Returns whether the action was actually launched, so callers do not
  // assert an intent that was dropped.
  function runInTerminal(command) {
    // Two independent bounds, because they fail differently.
    //
    // The monotonic floor comes first. `actionPending` alone only throttles:
    // it is cleared as soon as a status poll sees the state move, and the
    // launched action is precisely what moves it, so the guard released while
    // the first terminal was still sitting at its sudo prompt. This floor is
    // wall-clock and nothing observed can shorten it.
    //
    // What it is NOT: a security boundary. Anything running as this user can
    // spawn a terminal directly and never touch our IPC, so this bounds a
    // looping or buggy caller, not an attacker who already has execution.
    var now = Date.now()
    if (now - _lastLaunchMs < minLaunchGapMs) {
      lastError = "Twingate actions are rate limited; try again in a moment"
      _log("refused a terminal action " + (now - _lastLaunchMs) + "ms after the last")
      return false
    }

    // The refusal must be VISIBLE. Returning silently while toggleConnection
    // had already set _desired moved the switch to the new position, did
    // nothing, and let it snap back 30s later -- which is precisely the
    // "the switch does not work" symptom _desired was written to eliminate.
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
    bar.run("omarchy-launch-floating-terminal-with-presentation " + Util.shellQuote(command))
    // The command runs outside our control, so poll harder for a short while
    // rather than waiting up to a full interval to notice the new state.
    // Remember what we are leaving, so the settle can end the moment the state
    // actually moves instead of always running its full length.
    _stateAtAction = connectionState
    actionPending = true
    // Belt and braces. Timer.restart() does stop-then-start, so
    // onRunningChanged fires and elapsed resets on its own -- this does not
    // depend on that side effect.
    settleTimer.elapsed = 0
    settleTimer.restart()
    return true
  }

  function connectNetwork() {
    return runInTerminal("echo 'Connecting to Twingate...'; twingate start")
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
    // omarchy-launch-browser, not xdg-open: it resolves the configured
    // browser, launches it outside the shell's cgroup, and then focuses the
    // window. The sign-in flow depends on the tab actually coming to the
    // front -- opening it behind the current window strands the user exactly
    // as not opening it at all would.
    Quickshell.execDetached(["omarchy-launch-browser", authUrl])
  }

  // `disconnect`, not `stop` -- though on Linux the difference is only in
  // intent, not in effect. Measured: BOTH exit the client, which takes
  // twingate.service down with it, so there is no disconnected-but-running
  // state to aim at (see isDaemonDown in Model.js for the daemon log).
  //
  // `disconnect` is still the right verb to send: it is the one documented as
  // "Pause connections without clearing tokens", so if Twingate ever makes it
  // behave that way, or another platform already does, this asks for the
  // lighter action rather than the heavier one.
  function disconnectNetwork() {
    return runInTerminal("echo 'Disconnecting Twingate...'; twingate disconnect")
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
  // No `exit` anywhere in these scripts. The launcher wraps them as
  //   omarchy-show-logo; $cmd; if (( $? != 130 )); then omarchy-show-done; fi
  // so any exit short-circuits the wrapper and the window closes instantly --
  // destroying the message printed immediately before it. A failed sudo would
  // have vanished with nothing on screen, leaving the panel on "Disconnected"
  // and the user with no idea why. Fall through to the end instead.
  function _serviceStartScript() {
    return "echo 'Starting the Twingate service...'\n" +
           "if ! sudo twingate service-start; then\n" +
           "  echo\n" +
           "  echo 'Could not start the Twingate service.'\n" +
           "elif ! systemctl is-enabled --quiet twingate.service; then\n" +
           "  echo\n" +
           "  if gum confirm --default=false 'Also start Twingate automatically at every boot?'; then\n" +
           "    sudo systemctl enable twingate.service\n" +
           "  else\n" +
           "    echo 'Left as manual. Enable later with: sudo systemctl enable twingate.service'\n" +
           "  fi\n" +
           "fi\n"
  }

  // One flick, one terminal, both steps -- and the same sudo session covers
  // the service start and the connect.
  function startServiceAndConnect() {
    return runInTerminal(_serviceStartScript() +
                  "echo\n" +
                  "echo 'Connecting to Twingate...'\n" +
                  "twingate start")
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
    // to CLIENT_BUILDS is enough. An earlier version hardcoded x86_64, which
    // left ARM users refused and pointed at the README -- where the only
    // instruction was the mutable unsigned path this pin exists to replace.
    // The build table below is validated per entry, but the version is
    // rendered too -- into `url='...'` and, at the echo, inside DOUBLE quotes
    // where $(...) and backticks execute. It is a constant exactly as the
    // digests are, and docs/NOTES.md documents bumping it as routine
    // copy-paste, so it gets the same treatment rather than the benefit of the
    // doubt.
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
      // bound applied on the wire, so a hijacked CDN, DNS answer or redirect
      // hop cannot spend the disk before verification runs. The scheme and
      // redirect limits stop -L being walked somewhere else entirely.
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

  // The switch is the only connection control, so "on" has to mean connected,
  // not "one step closer to connected". With the daemon down that means
  // starting the service AND connecting in the same terminal run: doing only
  // the first would start the service, leave the state at offline, and spring
  // the switch back to off, which reads as the switch not working.
  // Only record the intent if the action actually launched. Setting _desired
  // first meant a refused action still moved the switch.
  function toggleConnection() {
    if (!installed) return "not-installed"
    if (daemonDown) return startServiceAndConnect() ? (_desired = 1, "ok") : "busy"
    if (connected || connecting) return disconnectNetwork() ? (_desired = 0, "ok") : "busy"
    return connectNetwork() ? (_desired = 1, "ok") : "busy"
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
  // A wildcard such as "*.example.co" has no single address; resourceAddress()
  // already rejects it (a leading * fails the host shape), so it copies.
  function openResource(resource) {
    if (!resource) return
    var address = Model.resourceAddress(resource)
    if (address === "") {
      copyToClipboard(String(resource.address || resource.name || ""))
      return
    }
    Quickshell.execDetached(["omarchy-launch-browser", "https://" + address])
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
      root._disarmPollWatchdogIfIdle()
      if (root.installed && exitCode !== 0) root._log("the twingate CLI disappeared from PATH")
      root.installed = exitCode === 0
      if (root.installed) {
        root.refreshStatus()
      } else {
        root.connectionState = "unknown"
        root.resources = []
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
      // which caps the CLI before its bytes ever reach the collector; this
      // clamp just means no parser downstream can be handed more than
      // MAX_INPUT even if that wrapper were ever bypassed.
      var out = String(statusStdout.text || "").slice(0, Model.READ_LIMIT)
      var err = String(statusStderr.text || "").slice(0, Model.READ_LIMIT)

      // The CLI prints the state token on stdout and exits non-zero for some
      // states, so a non-zero exit is only an error when nothing parseable
      // came back on either stream.
      var next = Model.normalizeStatus(out !== "" ? out : err)
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
      // the request that caused it. An earlier version set a flag inside
      // connectNetwork(), but `twingate start` runs in a terminal and takes
      // seconds: the very next poll still saw "offline", cleared the flag,
      // and the browser never opened once authentication actually began.
      if (next === "authenticating" && root._lastState !== "" && root._lastState !== "authenticating"
          && root._lastState !== "unknown") {
        root._autoOpenArmed = true
      }
      // Do not record "unknown" as the previous state -- it is the absence of
      // information, and remembering it turns the next real reading into a
      // spurious transition.
      if (next !== "unknown") root._lastState = next

      // Stop the settle as soon as the state moves. Running it for the full
      // 30s regardless left the refresh icon spinning long after the action
      // had finished, which reads as the panel being stuck.
      if (root.actionPending && next !== root._stateAtAction) {
        root.actionPending = false
        root._desired = -1
        settleTimer.stop()
      }

      root.connectionState = next
      if (next === "authenticating") {
        root.refreshAuthUrl()
      } else if (next !== "unknown") {
        // Only a DEFINITE state clears the auth memory. Clearing it on
        // "unknown" meant one unparseable poll mid-sign-in wiped
        // _openedAuthUrl, so the next poll re-armed and opened the same login
        // in another browser tab -- once per glitch.
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
      var out = String(verboseStdout.text || "").slice(0, Model.READ_LIMIT)
      if (out === "") out = String(verboseStderr.text || "").slice(0, Model.READ_LIMIT)
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
        // Previously collected and dropped, so a listing that failed outright
        // left the last good list on screen with nothing saying it was stale.
        var rerr = Model.clampField(Model.stripControl(
          String(resourcesStderr.text || "").slice(0, Model.READ_LIMIT).split("\n")[0]))
        if (rerr !== "") root.lastError = rerr
      }
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
