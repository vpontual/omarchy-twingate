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

// A one-line explanation for states that need one. Connected deliberately
// has none: the plugin only knows that `twingate status` said "online", which
// is not the same as any particular resource being reachable -- that depends
// on the connector, the host and the path between them. Claiming reachability
// from a proxy signal is the kind of statement that reads as fact and is not
// one. The resource list below is the honest answer to "what do I have?".
function statusDetail(state) {
  switch (state) {
  case STATE_ONLINE: return ""
  case STATE_OFFLINE: return "Signed out of your Twingate network"
  case STATE_AUTHENTICATING: return "Waiting for browser authentication"
  case STATE_NOT_RUNNING: return "The twingate daemon is not running"
  case STATE_MISSING: return "The twingate CLI was not found on PATH"
  default: return "The CLI reported a state this plugin does not recognise"
  }
}

// `twingate resources` prints a TAB-separated table. Each field is also
// space-padded to a column width, which makes the output look aligned and is
// exactly the trap this parser used to fall into: splitting on runs of two or
// more spaces works right up until a value fills its column exactly and is
// followed by a lone tab. Measured against a real connected client:
//
//   Jellyfin<pad>\tjellyfin.casavp.com\t-<pad>\tAuth expires in 4 days
//
// "jellyfin.casavp.com" fills the address column, so there is no padding
// before the next tab, the space-run split does not fire, and the address and
// alias fuse into one unusable field -- the row then displayed its auth
// status where its address belonged. Likewise a 20-character name like
// "Twingate Connector 2" never separated from its address at all.
//
// Split on the tab, which is the actual delimiter, and trim the padding.
//
//   RESOURCE NAME \t ADDRESS \t ALIAS \t AUTH STATUS
function parseResources(raw) {
  var lines = stripAnsi(raw).split("\n")
  var resources = []

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\s+$/, "")
    if (line.replace(/\s/g, "") === "") continue

    // "Twingate must be connected to display available resources."
    if (/must be connected/i.test(line)) continue
    // Rules between the header and the body, if a future version adds them.
    if (/^[\s─-╿=_-]+$/.test(line)) continue

    var columns = line.split("\t")
    for (var c = 0; c < columns.length; c++) {
      columns[c] = columns[c].replace(/^\s+/, "").replace(/\s+$/, "")
    }

    // Column header.
    if (/^(resource\s+)?name$/i.test(columns[0]) && columns.length > 1) continue

    // `--all` groups rows under bare section headings such as
    // "MAIN RESOURCES". They carry no tab and are all upper case; without
    // this they would be listed as a resource named after the heading.
    if (columns.length === 1 && /^[A-Z0-9][A-Z0-9 ]*$/.test(columns[0])) continue

    var name = columns[0]
    if (name === "") continue

    // The CLI writes "-" for an absent alias. Carrying that through would
    // print a dash where a hostname belongs.
    var alias = String(columns[2] || "")
    if (alias === "-") alias = ""

    resources.push({
      name: name,
      address: String(columns[1] || ""),
      alias: alias,
      authStatus: String(columns[3] || ""),
      raw: line.replace(/\t/g, "  ").replace(/\s+$/, "")
    })
  }

  return resources
}

// Every row normally carries the same auth status, so repeating it on each
// one is noise. Return it only when the whole list agrees; a row that differs
// is the interesting case and is surfaced on the row itself.
function sharedAuthStatus(resources) {
  if (!resources || resources.length === 0) return ""
  var first = String(resources[0].authStatus || "")
  if (first === "") return ""
  for (var i = 1; i < resources.length; i++) {
    if (String(resources[i].authStatus || "") !== first) return ""
  }
  return first
}

// A countdown -- "Auth expires in 4 days" -- is never shown, because it has no
// action attached to it. When the authorisation lapses you turn the switch on,
// the sign-in page opens, and you sign in. That is the ordinary flow, not a
// special one, so knowing it is coming four days early changes nothing. There
// is no "re-authenticate now" to offer, and the switch already does the only
// thing there is to do.
//
// A status that is NOT a countdown is different: "Auth required" or "Expired"
// means a resource is unreachable right now, and the value of showing it is
// explanatory rather than actionable -- it answers "why can I not reach this?"
// (`twingate auth <resource>` re-authenticates a single locked one.)
//
// So the rule keys off shape, not urgency: suppress the countdown, show
// everything else including any wording this plugin does not recognise.
function isCountdownAuthStatus(status) {
  return /^auth expires in\b/i.test(String(status || ""))
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

// The count rides in the section heading rather than on a line of its own --
// "8 resources" below a "Resources" header spent a whole row restating it.
// The scope is folded in too, since "All resources" is the only signal that
// hidden entries are included.
function resourceHeading(count, scope) {
  var n = Number(count) || 0
  return (scope === "all" ? "All resources" : "Resources") + " (" + n + ")"
}
