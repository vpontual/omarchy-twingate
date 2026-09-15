// Pure parsing helpers for the Twingate CLI. Kept free of QML types so the
// logic can be reasoned about (and tested) on its own. Service.qml owns every
// process; nothing here runs a command.

// The exact client this plugin installs, pinned by version, digest and size.
//
// The URL is version-qualified rather than the mutable `stable` path, so the
// bytes executed as root cannot change after this commit is reviewed.
// Twingate ships no signature, so the digest is the integrity control: the
// install refuses on mismatch. Both digests were computed from the published
// packages on 2026-09-15 and confirmed from each .PKGINFO as
// twingate 2026.239.6882-1.
//
// `bytes` is the exact published size, passed to curl --max-filesize: the
// digest can only reject bytes after they are written, and this bounds what a
// hijacked download can spend of the disk before then.
//
// Bump the version, both digests and both sizes together -- see docs/NOTES.md.
var CLIENT_VERSION = "2026.239.6882"
var CLIENT_BUILDS = {
  x86_64: {
    file: "twingate-amd64.pkg.tar.zst",
    sha256: "05eb46885776f8873f6a8e07fbca338d4526a547dcd6f67fa1f11749da5de996",
    bytes: 10495187
  },
  aarch64: {
    file: "twingate-arm64.pkg.tar.zst",
    sha256: "cb6f981787d33cd52c2a9bb6c23e0f24a651521569ac2aa221fe4c500ad5617d",
    bytes: 10567441
  }
}

function clientUrl(arch) {
  var b = CLIENT_BUILDS[arch]
  if (!b) return ""
  return "https://binaries.twingate.com/client/linux/ARCH/" + arch + "/" + CLIENT_VERSION + "/" + b.file
}

var STATE_ONLINE = "online"
var STATE_OFFLINE = "offline"
var STATE_AUTHENTICATING = "authenticating"
var STATE_NOT_RUNNING = "not-running"
var STATE_MISSING = "missing"
var STATE_UNKNOWN = "unknown"

// Resource names come from whoever administers the Twingate network, and they
// reach the screen and the clipboard. A CR pasted into a terminal executes
// what follows it; a bidi override makes "invoice\u202egnp.exe" render
// reversed.
//
// Removed: C0/C1 controls, bidi controls, zero-width and word-joining
// characters, Hangul fillers, the invisible-operator block, the separators Qt
// renders as line breaks, and the astral TAG characters. This is not a
// complete Default_Ignorable policy and not a confusables defence -- Cyrillic
// homoglyphs still look like Latin letters.
function stripControl(text) {
  return String(text || "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\u0080-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u2028\u2029\u3164\ufeff\uffa0\ufff9-\ufffb]/g, "")
    // TAG characters (U+E0000-U+E007F) are astral, so they arrive as a
    // surrogate pair no BMP class can reach. They render as nothing.
    .replace(/\udb40[\udc00-\udc7f]/g, "")
}

// The CLI colourises output unless -d is passed. The ESC is written as \x1b
// on purpose: a literal byte is invisible in editors and diffs, and without
// it this would strip bracketed text from real names.
function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
}

// `twingate status` prints exactly one token. Anything unrecognised is
// reported as unknown rather than guessed at -- a wrong state is worse than
// an honest "unknown", because the toggle acts on it.
function normalizeStatus(raw) {
  // The first non-blank line, so a leading newline or banner does not read
  // as an unknown state.
  var lines = stripAnsi(raw).split("\n")
  var first = ""
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].replace(/\s/g, "") !== "") { first = lines[i]; break }
  }
  var token = first.replace(/\s+/g, "").toLowerCase()
  if (token === "") return STATE_UNKNOWN

  // A prefix, not equality. When a resource needs its own authentication the
  // CLI writes the token with no trailing newline and appends prose:
  //
  //   onlineA resource you attempted to access requires additional
  //   authentication. Open the following URL to authorize access...
  //
  // Longest first, so a token that is a prefix of another cannot win early.
  var known = [
    [STATE_AUTHENTICATING, "authenticating"],
    [STATE_NOT_RUNNING, "not-running"],
    [STATE_NOT_RUNNING, "notrunning"],
    [STATE_OFFLINE, "offline"],
    [STATE_ONLINE, "online"]
  ]
  for (var k = 0; k < known.length; k++) {
    if (token.indexOf(known[k][1]) === 0) return known[k][0]
  }
  return STATE_UNKNOWN
}

function isConnected(state) {
  return state === STATE_ONLINE
}

// "not-running" is the ordinary OFF state, not a fault.
//
// There is no disconnected-but-running state on Linux. Both `twingate stop`
// and `twingate disconnect` (documented as "Pause connections without
// clearing tokens") exit the client, taking twingate.service down with it --
// the daemon log goes Offline, Exiting, Deactivated within one second. So
// `offline` is parsed but effectively never observed, and turning the switch
// off lands here: this state is labelled "off", not badged as broken.
function isDaemonDown(state) {
  return state === STATE_NOT_RUNNING
}

function statusLabel(state) {
  switch (state) {
  case STATE_ONLINE: return "Connected"
  // Effectively unreachable -- see the note on isDaemonDown.
  case STATE_OFFLINE: return "Disconnected"
  case STATE_AUTHENTICATING: return "Authenticating"
  case STATE_NOT_RUNNING: return "Disconnected"
  case STATE_MISSING: return "Not installed"
  default: return "Unknown"
  }
}

// A one-line explanation for states that need one. Connected has none:
// `twingate status` saying "online" does not mean any particular resource is
// reachable, so the panel does not claim it.
function statusDetail(state) {
  switch (state) {
  case STATE_ONLINE: return ""
  case STATE_OFFLINE: return "Signed out of your Twingate network"
  case STATE_AUTHENTICATING: return "Waiting for browser authentication"
  case STATE_NOT_RUNNING: return ""
  case STATE_MISSING: return "The Twingate CLI was not found at /usr/bin/twingate"
  default: return "The CLI reported a state this plugin does not recognise"
  }
}

// Ceilings on tenant-controlled data. Resource names and addresses are set by
// whoever administers the Twingate network and arrive in a long-lived desktop
// process, so tens of thousands of rows or one enormous name must not degrade
// the shell.
var MAX_RESOURCES = 200
var MAX_FIELD = 1024

function clampField(value) {
  var v = String(value || "")
  if (v.length <= MAX_FIELD) return v
  var cut = MAX_FIELD
  // Never split a surrogate pair, which renders as a replacement box.
  var last = v.charCodeAt(cut - 1)
  if (last >= 0xD800 && last <= 0xDBFF) cut -= 1
  return v.slice(0, cut) + "\u2026"
}

var MAX_INPUT = 1048576
// One byte past MAX_INPUT, so output that was clipped at the producer can be
// told apart from output that exactly filled the bound. See wasClipped().
var READ_LIMIT = MAX_INPUT + 1

// Seconds before a polled CLI call is killed. Under the 15s poll watchdog, so
// this fires first: the watchdog can only stop the wrapper Quickshell tracks,
// not its descendants. A status call normally returns in ~50ms.
var CLI_TIMEOUT_SEC = 12

// Deadline for an action. It includes the time a person spends at the polkit
// prompt, so it is generous; it exists so a forgotten prompt or a wedged
// command cannot hold the switch busy forever.
var ACTION_TIMEOUT_SEC = 300

// The only absolute paths the command wrapper will render. Everything after
// them must be a plain argument.
var TRUSTED_EXECUTABLES = ["/usr/bin/pkexec", "/usr/bin/twingate"]

// Actions that go through pkexec, whose exit codes carry meaning of their own.
var PKEXEC_ACTIONS = ["connect", "disconnect", "sign-out"]

function actionLabel(kind) {
  switch (kind) {
  case "connect": return "connect"
  case "disconnect": return "disconnect"
  case "sign-out": return "sign out"
  default: return "complete that action"
  }
}

// What to tell the user when an action exits non-zero, or "" for nothing.
//
// pkexec exits 126 when the prompt is dismissed. That is a choice, not a
// failure, so it produces no message. 137 is SIGKILL in the shell's 128 +
// signal form, which for these commands means `timeout` ended the wrapper at
// ACTION_TIMEOUT_SEC. Quickshell reports that kill as a crash with the bare
// signal number, so its handler converts it before calling this. Anything else reports the first line the command
// printed -- pkexec and the CLI both explain themselves -- or a fixed
// sentence when it printed nothing.
function actionFailure(kind, exitCode, output) {
  var code = Number(exitCode)
  if (code === 0) return ""
  if (code === 126 && PKEXEC_ACTIONS.indexOf(kind) !== -1) return ""
  if (code === 137) return "Timed out trying to " + actionLabel(kind)
  var lines = stripAnsi(String(output || "").slice(0, MAX_INPUT)).split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = stripControl(lines[i]).replace(/^\s+/, "").replace(/\s+$/, "")
    if (line !== "") return line
  }
  return "Could not " + actionLabel(kind)
}

// `twingate account` prints the current account on its first line, then the
// connection state -- captured from a real client:
//
//   Currently signed in as user@example.com - acme (twingate.com)
//   not-running
//
// The address and network name are the tenant's, so both are stripped and
// clamped. Anything that does not match reads as signed out rather than
// guessing at a partial account.
var SIGNED_IN_LABEL = "Currently signed in as "

function parseAccount(raw) {
  var none = { email: "", network: "" }
  var lines = stripAnsi(String(raw || "").slice(0, MAX_INPUT)).split("\n")
  for (var i = 0; i < lines.length; i++) {
    var at = lines[i].indexOf(SIGNED_IN_LABEL)
    if (at === -1) continue
    var rest = lines[i].slice(at + SIGNED_IN_LABEL.length)
    var dash = rest.indexOf(" - ")
    if (dash <= 0) return none
    var email = stripControl(rest.slice(0, dash)).replace(/^\s+|\s+$/g, "")
    var network = rest.slice(dash + 3)
    // The trailing "(twingate.com)" is the controller domain, not part of the
    // network name. Only a final parenthesised group is removed.
    var paren = network.lastIndexOf(" (")
    if (paren > 0 && /\)\s*$/.test(network)) network = network.slice(0, paren)
    network = stripControl(network).replace(/^\s+|\s+$/g, "")
    if (email === "" || /\s/.test(email)) return none
    return { email: clampField(email), network: clampField(network) }
  }
  return none
}

// A resource with its own authentication policy that has not been
// authorized yet. The CLI's wording, from the strings in its binary, is
// exactly "Not authenticated"; the other shape it prints is the
// "Auth expires in ..." countdown. Exact rather than a substring, so a
// resource named or described differently is never offered an action that
// does not apply to it.
function isLockedAuthStatus(status) {
  return String(status || "").replace(/^\s+|\s+$/g, "").toLowerCase() === "not authenticated"
}

// The search box appears once a list is long enough to need one.
var SEARCH_MIN_RESOURCES = 8

// Case-insensitive match on what a row displays: name, address and alias.
function filterResources(resources, query) {
  if (!resources) return []
  var q = String(query || "").replace(/^\s+|\s+$/g, "").toLowerCase()
  if (q === "") return resources
  var matches = []
  for (var i = 0; i < resources.length; i++) {
    var r = resources[i]
    var haystack = [r.name, r.address, r.alias].join("\n").toLowerCase()
    if (haystack.indexOf(q) !== -1) matches.push(r)
  }
  return matches
}

// How long after this plugin launches a connect an observed move into
// `authenticating` may still be attributed to it.
//
// Opening the sign-in page is the only browser launch without a direct
// click, so it happens only for an authentication this plugin started -- not
// for `twingate start` run in your own terminal. Generous, because a connect
// waits on a person at the polkit prompt, but finite.
var AUTO_OPEN_WINDOW_MS = 120000

// Pure, so that launch can be tested as behaviour. Only a connect grants it.
function shouldArmAutoOpen(next, lastState, connectLaunchMs, nowMs) {
  if (next !== STATE_AUTHENTICATING || lastState === "" ||
      lastState === STATE_AUTHENTICATING || lastState === STATE_UNKNOWN)
    return false
  var launched = Number(connectLaunchMs)
  var now = Number(nowMs)
  if (!isFinite(launched) || !isFinite(now) || launched <= 0 || now < launched)
    return false
  return now - launched < AUTO_OPEN_WINDOW_MS
}

// UTF-8 byte length, without allocating a copy.
//
// The producer caps bytes (`head -c`), while string length counts UTF-16
// units; the two agree only for ASCII. With non-Latin resource names, a
// clipped listing would otherwise read as complete.
function byteLength(text) {
  var bytes = 0
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i)
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff) { bytes += 4; i++ }  // surrogate pair
    else bytes += 3
  }
  return bytes
}

// A buffer that reached the producer's byte cap was clipped by it.
function wasClipped(text) {
  return byteLength(text) >= READ_LIMIT || text.length > MAX_INPUT
}

// `twingate resources` prints a table that is tab-separated AND space-padded
// to column widths. Splitting on runs of spaces fails whenever a value exactly
// fills its column and is followed by a lone tab, so split on the tab and trim.
//
//   RESOURCE NAME \t ADDRESS \t ALIAS \t AUTH STATUS
function parseResources(raw) {
  // Bound the input as well as the rows: the row cap only fires after the
  // whole buffer has been copied and split.
  var input = String(raw || "")
  var clipped = wasClipped(input)
  if (input.length > MAX_INPUT) input = input.slice(0, MAX_INPUT)
  var lines = stripAnsi(input).split("\n")
  var resources = []
  var seenHeader = false
  var truncated = false

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/\s+$/, "")
    if (line.replace(/\s/g, "") === "") continue

    // "Twingate must be connected to display available resources."
    if (/must be connected/i.test(line)) continue
    // Rules between the header and the body, if a future version adds them.
    if (/^[\s─-╿=_-]+$/.test(line)) continue

    var columns = line.split("\t")
    for (var c = 0; c < columns.length; c++) {
      columns[c] = stripControl(columns[c]).replace(/^\s+/, "").replace(/\s+$/, "")
    }

    // `--all` groups rows under bare headings such as "MAIN RESOURCES". A
    // resource row always has tabs, so a line without one is a heading. This
    // comes before the header check, because with `--all` the heading is the
    // first line.
    if (columns.length === 1) continue

    // Column header -- only the first tabbed row, so a resource really named
    // "Name" is kept.
    if (!seenHeader) {
      seenHeader = true
      if (/^(resource\s+)?name$/i.test(columns[0])) continue
    }

    var name = columns[0]
    if (name === "") continue
    // Whether the displayed name is byte-for-byte the CLI's. A name that lost
    // an invisible character or was clamped is fine to show, but passing it
    // back to `twingate auth` would name a resource that does not exist.
    var rawName = line.split("\t")[0].replace(/^\s+|\s+$/g, "")
    var exactName = rawName === name && name.length <= MAX_FIELD

    // The CLI writes "-" for an absent alias.
    var alias = String(columns[2] || "")
    if (alias === "-") alias = ""

    if (resources.length >= MAX_RESOURCES) { truncated = true; break }

    resources.push({
      name: clampField(name),
      exactName: exactName,
      address: clampField(columns[1] || ""),
      alias: clampField(alias),
      authStatus: clampField(columns[3] || ""),
    })
  }

  if (truncated || clipped) resources.truncated = true
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

// A countdown -- "Auth expires in 4 days" -- is never shown: nothing can be
// done about it early, and when it lapses the switch signs you in as usual.
// Any other status explains why a resource is unreachable now, so it is shown,
// including wording this plugin does not recognise.
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
// The CLI does not reliably open a browser itself, so the plugin opens this.
//
// The result goes straight to Omarchy's browser launcher, so: https only, an
// ASCII hostname charset (which also rejects credentials, since `@` is not in
// it), no whitespace or quotes, and a length bound. The host is not limited to
// twingate.com, because networks can use a custom domain.
function parseAuthUrl(raw) {
  var text = stripAnsi(raw)

  // Anchored on the CLI's full sign-in sentence, never the first https:// in
  // the output: the CLI prints other links, and this URL opens with no click.
  // No label, no URL.
  var label = text.search(/Visit the following URL to authenticate/i)
  if (label === -1) return ""
  // Only the lines right after the label, so a URL further down cannot be
  // captured by it.
  var scope = text.slice(label).split("\n").slice(0, 4).join("\n")

  // (^|\s) so a bare "xhttps://..." cannot match mid-token.
  var match = scope.match(/(^|\s)(https:\/\/[A-Za-z0-9._-]+\/[^\s"'<>]*)/)
  if (!match) return ""
  var url = match[2]
  return url.length <= 2048 ? url : ""
}

// What clicking, Enter, `c` or `o` puts on the clipboard, in one place: the
// address, even when it is a wildcard that cannot be opened. The name is used
// only when there is no address at all.
function clipboardValue(resource) {
  if (!resource) return ""
  return String(resource.address || resource.name || "")
}

// A resource is only addressable when the CLI gave us something that looks
// like a host or IP; otherwise the row is shown but not offered as copyable.
function resourceAddress(resource) {
  if (!resource) return ""
  var address = String(resource.address || "")
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/.test(address)) return ""
  // A bare IPv6 literal passes the charset test but is not a URL a browser
  // parses, so it falls back to copying.
  if (address.indexOf(":") !== -1 && !/^[A-Za-z0-9.-]+:[0-9]+$/.test(address)) return ""
  return address
}

// The count and scope ride in the section heading; "All resources" is the
// only signal that hidden entries are included.
function resourceHeading(count, scope, truncated) {
  var n = Number(count) || 0
  // A clipped list is "200+", never presented as the total.
  var shown = truncated ? n + "+" : String(n)
  return (scope === "all" ? "All resources" : "Resources") + " (" + shown + ")"
}
