// Pure parsing helpers for the Twingate CLI. Kept free of QML types so the
// logic can be reasoned about (and tested) on its own.
//
// Only `twingate status` and `twingate resources` are ever parsed here. Every
// state-changing Twingate command shells out to sudo and expects a TTY, so
// those never run headless -- see Service.qml.

var STATE_ONLINE = "online"
var STATE_OFFLINE = "offline"
var STATE_AUTHENTICATING = "authenticating"
var STATE_NOT_RUNNING = "not-running"
var STATE_MISSING = "missing"
var STATE_UNKNOWN = "unknown"

// The CLI colourises output unless -d is passed. We pass it, but a stray
// escape sequence must never become part of a resource name.
function stripAnsi(text) {
  return String(text || "").replace(/\[[0-9;]*[A-Za-z]/g, "")
}

// `twingate status` prints exactly one token. Anything unrecognised is
// reported as unknown rather than guessed at -- a wrong state is worse than
// an honest "unknown", because the toggle acts on it.
function normalizeStatus(raw) {
  var first = stripAnsi(raw).split("\n")[0] || ""
  var token = first.replace(/\s+/g, "").toLowerCase()
  if (token === "") return STATE_UNKNOWN
  if (token === STATE_ONLINE) return STATE_ONLINE
  if (token === STATE_OFFLINE) return STATE_OFFLINE
  if (token === STATE_AUTHENTICATING) return STATE_AUTHENTICATING
  // The CLI has printed both "not-running" and "notrunning" across versions.
  if (token === "not-running" || token === "notrunning") return STATE_NOT_RUNNING
  return STATE_UNKNOWN
}

function isConnected(state) {
  return state === STATE_ONLINE
}

// The daemon being down is a distinct, actionable state from being signed out,
// and they need different buttons, so never collapse them into "off".
function isDaemonDown(state) {
  return state === STATE_NOT_RUNNING
}

function statusLabel(state) {
  switch (state) {
  case STATE_ONLINE: return "Connected"
  case STATE_OFFLINE: return "Disconnected"
  case STATE_AUTHENTICATING: return "Authenticating"
  case STATE_NOT_RUNNING: return "Service stopped"
  case STATE_MISSING: return "Not installed"
  default: return "Unknown"
  }
}

function statusDetail(state) {
  switch (state) {
  case STATE_ONLINE: return "Private resources are reachable"
  case STATE_OFFLINE: return "Signed out of your Twingate network"
  case STATE_AUTHENTICATING: return "Waiting for browser authentication"
  case STATE_NOT_RUNNING: return "The twingate daemon is not running"
  case STATE_MISSING: return "The twingate CLI was not found on PATH"
  default: return "The CLI reported a state this plugin does not recognise"
  }
}

// `twingate resources` prints a whitespace-aligned table whose exact columns
// vary by CLI version, so the parser is deliberately tolerant: it recovers a
// name and an address when the shape is recognisable and otherwise preserves
// the raw line rather than dropping information it cannot classify.
function parseResources(raw) {
  var lines = stripAnsi(raw).split("\n")
  var resources = []

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\s+$/, "")
    if (line.replace(/\s/g, "") === "") continue

    // "Twingate must be connected to display available resources."
    if (/must be connected/i.test(line)) continue
    // Box-drawing or ASCII rules between the header and the body.
    if (/^[\s─-╿=_-]+$/.test(line)) continue
    // Column header.
    if (/^\s*(resource\s+)?name\b/i.test(line) && /\baddress\b/i.test(line)) continue

    var columns = line.replace(/^\s+/, "").split(/\s{2,}/)
    var name = String(columns[0] || "").replace(/\s+$/, "")
    if (name === "") continue

    resources.push({
      name: name,
      address: String(columns[1] || "").replace(/\s+$/, ""),
      detail: columns.length > 2 ? columns.slice(2).join(" - ") : "",
      raw: line.replace(/^\s+/, "")
    })
  }

  return resources
}

// While authenticating, `twingate status --verbose` prints the sign-in URL:
//
//   Authenticating: None
//
//   Visit the following URL to authenticate to your Twingate network:
//
//   https://<network>.twingate.com/client-node/login?redirect_uri=...
//
// `twingate start` does not reliably open a browser itself, so the plugin
// has to surface this or the user is stranded on "Authenticating" with no
// idea what it is waiting for.
//
// Only https is accepted, and only on the network's own domain shape -- this
// string is handed straight to xdg-open, so it must never be able to become
// a file:// or a shell-relevant token.
function parseAuthUrl(raw) {
  var text = stripAnsi(raw)
  var match = text.match(/https:\/\/[A-Za-z0-9._-]+\/[^\s"'<>]*/)
  if (!match) return ""
  var url = match[0]
  return url.length <= 2048 ? url : ""
}

// A resource is only addressable when the CLI gave us something that looks
// like a host or IP; otherwise the row is shown but not offered as copyable.
function resourceAddress(resource) {
  if (!resource) return ""
  var address = String(resource.address || "")
  return /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/.test(address) ? address : ""
}

function resourceCountLabel(count, scope) {
  var n = Number(count) || 0
  var noun = n === 1 ? "resource" : "resources"
  return scope === "all" ? n + " " + noun + " (including hidden)" : n + " " + noun
}
