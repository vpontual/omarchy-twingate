// Pure parsing helpers for the Twingate CLI. Kept free of QML types so the
// logic can be reasoned about (and tested) on its own.
//
// Only `twingate status` and `twingate resources` are ever parsed here. Every
// state-changing Twingate command shells out to sudo and expects a TTY, so
// those never run headless -- see Service.qml.

// The exact client this plugin will install, pinned by VERSION and DIGEST.
//
// A marketplace reviewer rejected an earlier version for fetching the mutable
// `stable` path and handing it to `sudo pacman -U`: the bytes executed as root
// could change independently of the reviewed commit. Twingate also publishes
// immutable versioned paths, so the fix is to pin one and verify it, not to
// drop the feature.
//
// Both digests were computed from the published artifacts on 2026-08-25 and
// confirmed with `pacman -Qip` as twingate 2026.190.6704-1. Twingate ships no
// signature of its own, so this digest IS the integrity control -- the install
// refuses on mismatch rather than proceeding.
//
// `bytes` is the exact published size, and it is a ceiling rather than a
// second integrity check: the digest already fixes the byte count, but it can
// only say so AFTER curl has finished writing. Passing it to --max-filesize
// bounds what a hijacked CDN, DNS answer or redirect hop can spend of the
// disk before verification ever runs.
//
// Bumping the client means bumping the version, both digests AND both sizes
// together, in a commit that can be reviewed as a unit. All three come out of
// the same download, so there is no extra step -- see docs/NOTES.md.
var CLIENT_VERSION = "2026.190.6704"
var CLIENT_BUILDS = {
  x86_64: {
    file: "twingate-amd64.pkg.tar.zst",
    sha256: "7b1a3fc6ada23940d6df45d2521143d46ceb0c91797c0959c4621656f7d25ae1",
    bytes: 10473309
  },
  aarch64: {
    file: "twingate-arm64.pkg.tar.zst",
    sha256: "0886076ef9bd4a85d8a0e10f4e0d3a551307a98efeb1cad7e02e3a90ace4c90a",
    bytes: 10492572
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

// The CLI colourises output unless -d is passed. We pass it, but a stray
// escape sequence must never become part of a resource name.
//
// The \x1b is written as an escape on purpose. It used to be a literal 0x1b
// byte, which is invisible in every editor and diff: a reviewer read the regex
// as `\[[0-9;]*[A-Za-z]` and reported that it would eat bracketed text out of
// real names. It would -- if the byte were ever dropped. Spell it out.
function stripControl(text) {
  // Resource names come from whoever administers the Twingate network. A name
  // containing CR or BEL reaches the clipboard, and pasting CR into a terminal
  // without bracketed paste executes what follows it.
  // Also the explicitly listed bidi, zero-width and formatting ranges: a name
  // like "invoice\u202Egnp.exe" renders reversed and lands in the clipboard
  // that way, which is the same spoofing hazard as the control characters,
  // just a different block.
  //
  // SCOPE, stated precisely because an earlier comment overclaimed: this
  // removes C0/C1, the Unicode bidi controls, the zero-width and word-joining
  // characters, the Hangul fillers, the invisible-operator block, the
  // separators Qt renders as line breaks, and the astral TAG characters. It is
  // NOT a complete Default_Ignorable policy, and it is deliberately not a
  // confusables defence: a name spelled with Cyrillic homoglyphs renders
  // identically to a Latin one and no strip rule fixes that. What this
  // guarantees is narrower: terminal controls, bidi overrides, the listed
  // invisible formatting characters, and separators that break out of a row
  // do not survive. It does not promise that arbitrary Unicode cannot carry
  // hidden data or that two names cannot be made to look alike.
  return String(text || "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[\u0080-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u2028\u2029\u3164\ufeff\uffa0\ufff9-\ufffb]/g, "")
    // Unicode TAG characters (U+E0000-U+E007F) are astral, so they arrive as a
    // surrogate pair and no BMP character class can reach them. They render as
    // nothing at all and can smuggle a whole ASCII string inside a name.
    .replace(/\udb40[\udc00-\udc7f]/g, "")
}
function stripAnsi(text) {
  return String(text || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
}

// `twingate status` prints exactly one token. Anything unrecognised is
// reported as unknown rather than guessed at -- a wrong state is worse than
// an honest "unknown", because the toggle acts on it.
function normalizeStatus(raw) {
  // The first NON-BLANK line, not line 0. A single leading newline, banner or
  // deprecation notice on stdout would otherwise drive the widget to
  // "unknown": urgent badge, switch off, and a panel blaming the CLI for a
  // state it did not report.
  var lines = stripAnsi(raw).split("\n")
  var first = ""
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].replace(/\s/g, "") !== "") { first = lines[i]; break }
  }
  var token = first.replace(/\s+/g, "").toLowerCase()
  if (token === "") return STATE_UNKNOWN

  // PREFIX, not equality. Captured from a real client: when a resource needs
  // per-resource re-authentication, the CLI writes the state token with NO
  // trailing newline and then appends prose to the same line --
  //
  //   onlineA resource you attempted to access requires additional
  //   authentication. Open the following URL to authorize access...
  //
  // Requiring the whole line to equal "online" reported "unknown" while the
  // client was in fact connected: urgent badge, switch off, and a panel
  // telling the user the CLI said something unrecognisable.
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
// and `twingate disconnect` -- the latter documented as "Pause connections
// without clearing tokens" -- end by exiting the client process, which takes
// twingate.service down with it. Measured: the daemon log goes
//
//   State: 'Offline'  ->  Exiting Twingate Client  ->  Deactivated successfully
//
// within the same second. STATE_OFFLINE therefore exists internally for a few
// milliseconds and was never once observed from `twingate status` across a
// full session of testing. It is still parsed, in case another platform or a
// later version does report it, but nothing should be designed around it.
//
// The practical consequence: turning the switch off necessarily stops the
// daemon, so this state must be labelled and badged as "off", not as broken.
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
  case STATE_NOT_RUNNING: return ""
  case STATE_MISSING: return "The Twingate CLI was not found at /usr/bin/twingate"
  default: return "The CLI reported a state this plugin does not recognise"
  }
}

// `twingate resources` prints a TAB-separated table. Each field is also
// space-padded to a column width, which makes the output look aligned and is
// exactly the trap this parser used to fall into: splitting on runs of two or
// more spaces works right up until a value fills its column exactly and is
// followed by a lone tab. Measured against a real connected client:
//
//   Jellyfin<pad>\tassets.example.test\t-<pad>\tAuth expires in 4 days
//
// "assets.example.test" fills the address column, so there is no padding
// before the next tab, the space-run split does not fire, and the address and
// alias fuse into one unusable field -- the row then displayed its auth
// status where its address belonged. Likewise a 20-character name like
// "Twingate Connector 2" never separated from its address at all.
//
// Split on the tab, which is the actual delimiter, and trim the padding.
//
//   RESOURCE NAME \t ADDRESS \t ALIAS \t AUTH STATUS
// Ceilings on tenant-admin-controlled data. Resource names and addresses are
// configured by whoever administers the Twingate network, not by the user of
// this plugin, so they are untrusted input arriving at a long-lived desktop
// process. Without bounds, a network returning tens of thousands of rows -- or
// one enormous name -- degrades the shell itself rather than a disposable app.
var MAX_RESOURCES = 200
var MAX_FIELD = 1024

function clampField(value) {
  var v = String(value || "")
  if (v.length <= MAX_FIELD) return v
  var cut = MAX_FIELD
  // Never split a surrogate pair: slicing by UTF-16 code unit through an
  // emoji leaves a lone high surrogate, which renders as a replacement box.
  var last = v.charCodeAt(cut - 1)
  if (last >= 0xD800 && last <= 0xDBFF) cut -= 1
  return v.slice(0, cut) + "\u2026"
}

var MAX_INPUT = 1048576
// Deliberately ONE past MAX_INPUT, so a buffer that filled the bound is
// distinguishable from one that merely reached it. Capping the producer at
// MAX_INPUT itself silently disabled clip detection entirely. See wasClipped()
// below for why the detection is byte-based rather than length-based -- the +1
// alone was not enough.
var READ_LIMIT = MAX_INPUT + 1

// Seconds before the polled CLI is killed outright. Kept under the poll
// watchdog's 15s so this fires first: the watchdog can only signal the process
// Quickshell tracks, which is the shell wrapper, and Qt does not signal its
// descendants -- so a silently wedged `twingate` survived every watchdog cycle
// and each poll added another. This bounds the CLI itself. A status call
// normally returns in ~50ms.
var CLI_TIMEOUT_SEC = 12

// How long after this plugin launches a connect request an observed move into
// `authenticating` may still be attributed to that request.
//
// The auto-open path is the ONLY thing here that launches a browser with no
// user action, and it used to arm on ANY transition into `authenticating` --
// so running `twingate start` in your own terminal, or a re-auth the plugin
// knew nothing about, opened a tab at a tenant-supplied URL. The old code had
// no evidence that the plugin had even requested a connect. This window is
// generous because a connect involves a sudo prompt, a gum question and a
// keypress, but finite.
var AUTO_OPEN_WINDOW_MS = 120000

// Pure so the one browser launch that happens without a direct click can be
// tested as behavior rather than inferred from a QML condition. Attribution
// belongs to a CONNECT action specifically -- install and disconnect also open
// terminals, but neither is permission to open a tenant-supplied URL later.
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
// The producer caps BYTES (`head -c`); JavaScript string length counts UTF-16
// code units. Those coincide only for ASCII, so inferring "was this clipped?"
// from string length silently fails the moment a Twingate admin uses a
// non-Latin resource name: 1,048,577 bytes of CJK decodes to ~352,000 units,
// the length test reads false, and a list cut from 150 rows to 115 is
// presented as complete. Measured, not theorised.
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

// A buffer that reached the producer's byte cap was clipped by it. Erring
// toward "truncated" on an exact-fit buffer is the safe direction: the cost is
// a spurious "showing the first N" line, against silently asserting a short
// list is the whole list.
function wasClipped(text) {
  return byteLength(text) >= READ_LIMIT || text.length > MAX_INPUT
}

function parseResources(raw) {
  // Bound the INPUT, not just the output. The 200-row cap fires after the
  // whole buffer has already been regex-copied and split, so a hostile or
  // merely enormous listing still cost a full-string copy and a
  // multi-million-element array inside the desktop's own process. Measured:
  // 16 MB took 415ms to produce 200 rows.
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

    // `--all` groups rows under bare section headings such as "MAIN
    // RESOURCES". A resource row ALWAYS has tabs, so the absence of one is the
    // reliable signal -- an earlier upper-case-only test let a heading like
    // "NON-DEFAULT RESOURCES" through as a phantom resource, which inflated
    // the count and, having an empty auth status, flipped every real row into
    // printing its own.
    //
    // This must come BEFORE the header check: with `--all` the heading is the
    // first line, and letting it consume the "first row" slot meant the real
    // column header slipped through as a resource.
    if (columns.length === 1) continue

    // Column header -- only the first tabbed row. Testing every line meant a
    // resource genuinely named "Name" or "Resource Name" vanished with no
    // trace anywhere in the UI.
    if (!seenHeader) {
      seenHeader = true
      if (/^(resource\s+)?name$/i.test(columns[0])) continue
    }

    var name = columns[0]
    if (name === "") continue

    // The CLI writes "-" for an absent alias. Carrying that through would
    // print a dash where a hostname belongs.
    var alias = String(columns[2] || "")
    if (alias === "-") alias = ""

    if (resources.length >= MAX_RESOURCES) { truncated = true; break }

    resources.push({
      name: clampField(name),
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
// This string is handed straight to Omarchy's browser launcher, so: https only
// (no file://, no scheme confusion), host limited to an ASCII hostname charset
// -- which also rejects credentials, since `@` is not in it -- no whitespace
// or quotes, and a length bound.
//
// It does NOT restrict the host to twingate.com. Networks with a custom
// domain would break, and an operator hostile enough to serve a bad host
// already controls your routing. The realistic risk is the CLI printing some
// other link first, which the anchoring below addresses.
function parseAuthUrl(raw) {
  var text = stripAnsi(raw)

  // Anchor to the CLI's own label rather than taking the first https:// in the
  // output. `twingate` prints other links (documentation, "Learn more"), so a
  // first-match rule would hand the browser whichever URL happened to come first
  // if a future version reorders its output -- silently, with no code change.
  // No label, no URL. Falling back to "first https:// anywhere" reinstated
  // exactly the first-match behaviour the anchor exists to prevent -- and this
  // result is opened in a browser automatically, with no user action.
  //
  // Anchored on the full sign-in sentence, NOT a generic "the following URL".
  // The CLI's other label ("Open the following URL to authorize access to the
  // resource") is emitted in the ONLINE state, while this only ever runs while
  // authenticating -- so accepting it bought nothing and cost the anchor:
  // search() returns the FIRST match, so generic prose appearing earlier in
  // tenant-controlled output would win, and this URL is opened in a browser
  // with no user action.
  var label = text.search(/Visit the following URL to authenticate/i)
  if (label === -1) return ""
  // Bounded to the label's own vicinity, so a URL further down the buffer
  // cannot be captured by a label that was not introducing it.
  var scope = text.slice(label).split("\n").slice(0, 4).join("\n")

  // (^|\s) so a bare "xhttps://..." cannot match mid-token.
  var match = scope.match(/(^|\s)(https:\/\/[A-Za-z0-9._-]+\/[^\s"'<>]*)/)
  if (!match) return ""
  var url = match[2]
  return url.length <= 2048 ? url : ""
}

// What clicking, Enter, or `o` puts on the clipboard, in ONE place.
//
// These three used to disagree. A wildcard like *.corp.internal is not
// browser-openable, so resourceAddress() returns "" -- and the panel then fell
// back to the resource NAME while the `o` shortcut fell back to the raw
// ADDRESS. Same row, two interactions, two different clipboard values, and the
// README promises the address. The address is what the user wants: the name is
// a label, and no one pastes a label into a terminal.
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
  // A bare IPv6 literal passes the charset test but "https://2001:db8::1" is
  // not a URL any browser parses. Treat it as not-openable so it falls back
  // to copying, which is what the user can actually use.
  if (address.indexOf(":") !== -1 && !/^[A-Za-z0-9.-]+:[0-9]+$/.test(address)) return ""
  return address
}

// The count rides in the section heading rather than on a line of its own --
// "8 resources" below a "Resources" header spent a whole row restating it.
// The scope is folded in too, since "All resources" is the only signal that
// hidden entries are included.
function resourceHeading(count, scope, truncated) {
  var n = Number(count) || 0
  // "(200)" beside "Showing the first 200" claimed the cap WAS the total.
  var shown = truncated ? n + "+" : String(n)
  return (scope === "all" ? "All resources" : "Resources") + " (" + shown + ")"
}
