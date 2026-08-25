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
    " statusDetail, parseResources, resourceAddress, resourceHeading, parseAuthUrl, sharedAuthStatus, isCountdownAuthStatus, stripControl }"
)()

const ESC = ""

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

test("parseAuthUrl refuses non-https schemes", () => {
  // The result goes straight to xdg-open, so file:// and http:// must not pass.
  assert.equal(Model.parseAuthUrl("file:///etc/passwd"), "")
  assert.equal(Model.parseAuthUrl("http://evil.example/login"), "")
})

test("parseAuthUrl stops at whitespace and quotes", () => {
  const url = Model.parseAuthUrl('https://x.twingate.com/login?a=1 then some prose')
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
  assert.equal(Model.parseAuthUrl("xhttps://evil.example/path"), "")
})

test("parseAuthUrl still rejects credentials and non-https", () => {
  assert.equal(Model.parseAuthUrl("https://user:pass@evil.example/x"), "")
  assert.equal(Model.parseAuthUrl("http://evil.example/x"), "")
  assert.equal(Model.parseAuthUrl("file:///etc/passwd"), "")
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
