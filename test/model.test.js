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
    " statusDetail, parseResources, resourceAddress, resourceHeading, parseAuthUrl, sharedAuthStatus, isCountdownAuthStatus }"
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

test("every state has a label and a detail", () => {
  for (const state of ["online", "offline", "authenticating", "not-running", "missing", "unknown"]) {
    assert.ok(Model.statusLabel(state).length > 0, state)
    assert.ok(Model.statusDetail(state).length > 0, state)
  }
})

test("stripAnsi removes colour escapes", () => {
  assert.equal(Model.stripAnsi(ESC + "[1mbold" + ESC + "[0m"), "bold")
})

// Captured verbatim from a real connected client, 2026-08-25. The columns are
// TAB-separated AND space-padded, which is what makes a space-run split wrong.
const T = "\t"
const REAL = [
  "RESOURCE NAME       " + T + "ADDRESS            " + T + "ALIAS" + T + "AUTH STATUS",
  "Docker VM           " + T + "10.0.153.99        " + T + "-    " + T + "Auth expires in 4 days",
  // Address exactly fills its column: a lone tab follows, no padding.
  "Jellyfin            " + T + "jellyfin.casavp.com" + T + "-    " + T + "Auth expires in 4 days",
  // Name exactly fills its column: a lone tab follows, no padding.
  "Twingate Connector 2" + T + "10.0.153.40        " + T + "-    " + T + "Auth expires in 4 days",
  "casavp Access       " + T + "*.casavp.com       " + T + "-    " + T + "Auth expires in 4 days"
].join("\n")

test("parseResources reads the real tab-separated table", () => {
  const r = Model.parseResources(REAL)
  assert.equal(r.length, 4)
  assert.deepEqual(
    { name: r[0].name, address: r[0].address, alias: r[0].alias, authStatus: r[0].authStatus },
    { name: "Docker VM", address: "10.0.153.99", alias: "", authStatus: "Auth expires in 4 days" }
  )
})

test("parseResources handles an address that exactly fills its column", () => {
  // The regression: a lone tab with no padding used to fuse address+alias,
  // so the row rendered its auth status where the address belonged.
  const jellyfin = Model.parseResources(REAL).find(r => r.name === "Jellyfin")
  assert.equal(jellyfin.address, "jellyfin.casavp.com")
  assert.equal(jellyfin.authStatus, "Auth expires in 4 days")
  assert.equal(Model.resourceAddress(jellyfin), "jellyfin.casavp.com")
})

test("parseResources handles a name that exactly fills its column", () => {
  // This one used to come through as a single field: name and address fused.
  const conn = Model.parseResources(REAL).find(r => r.name === "Twingate Connector 2")
  assert.ok(conn, "row should not have fused name and address")
  assert.equal(conn.address, "10.0.153.40")
})

test("parseResources keeps names containing single spaces", () => {
  const r = Model.parseResources(REAL)
  assert.ok(r.some(x => x.name === "casavp Access"))
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
  assert.equal(Model.resourceAddress({ address: "10.0.153.99" }), "10.0.153.99")
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

https://veepee.twingate.com/client-node/login?redirect_uri=https%3A%2F%2Fveepee.twingate.com%2Fapi%2Fv5%2Fclient%2Flogin%3Fdevice_hardware_id%3Dabc123%26auth_session_id%3Dxyz789
`

test("parseAuthUrl pulls the sign-in URL out of verbose status", () => {
  const url = Model.parseAuthUrl(VERBOSE_AUTHENTICATING)
  assert.ok(url.startsWith("https://veepee.twingate.com/client-node/login"))
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
