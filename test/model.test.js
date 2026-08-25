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
    " statusDetail, parseResources, resourceAddress, resourceCountLabel }"
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

test("parseResources reads an aligned table", () => {
  const raw = [
    "Name                Address                  Status",
    "------------------  -----------------------  --------",
    "Prod database       db.internal.example      Online",
    "Grafana             grafana.internal         Online"
  ].join("\n")

  const resources = Model.parseResources(raw)
  assert.equal(resources.length, 2)
  assert.deepEqual(
    { name: resources[0].name, address: resources[0].address, detail: resources[0].detail },
    { name: "Prod database", address: "db.internal.example", detail: "Online" }
  )
  assert.equal(resources[1].name, "Grafana")
})

test("parseResources keeps names that contain single spaces", () => {
  // Splitting on a single space would shred "Prod database" into two columns.
  const resources = Model.parseResources("Prod database       db.internal.example")
  assert.equal(resources[0].name, "Prod database")
  assert.equal(resources[0].address, "db.internal.example")
})

test("parseResources drops the disconnected notice, not the table", () => {
  assert.deepEqual(Model.parseResources("Twingate must be connected to display available resources."), [])
})

test("parseResources skips box-drawing and ASCII rules", () => {
  const raw = ["Name    Address", "────────", "app     app.internal"].join("\n")
  const resources = Model.parseResources(raw)
  assert.equal(resources.length, 1)
  assert.equal(resources[0].name, "app")
})

test("parseResources preserves an unrecognised row instead of dropping it", () => {
  // The column layout varies by CLI version. Losing a resource silently is
  // worse than showing a row we could not fully classify.
  const resources = Model.parseResources("something-unexpected")
  assert.equal(resources.length, 1)
  assert.equal(resources[0].name, "something-unexpected")
  assert.equal(resources[0].address, "")
  assert.equal(resources[0].raw, "something-unexpected")
})

test("parseResources handles empty and blank input", () => {
  assert.deepEqual(Model.parseResources(""), [])
  assert.deepEqual(Model.parseResources("\n\n   \n"), [])
  assert.deepEqual(Model.parseResources(null), [])
})

test("resourceAddress only accepts host-shaped values", () => {
  assert.equal(Model.resourceAddress({ address: "db.internal.example" }), "db.internal.example")
  assert.equal(Model.resourceAddress({ address: "10.0.153.99" }), "10.0.153.99")
  assert.equal(Model.resourceAddress({ address: "Online" }), "Online")
  assert.equal(Model.resourceAddress({ address: "not a host" }), "")
  assert.equal(Model.resourceAddress({ address: "" }), "")
  assert.equal(Model.resourceAddress(null), "")
})

test("resourceCountLabel pluralises and reflects scope", () => {
  assert.equal(Model.resourceCountLabel(1, "default"), "1 resource")
  assert.equal(Model.resourceCountLabel(4, "default"), "4 resources")
  assert.equal(Model.resourceCountLabel(4, "all"), "4 resources (including hidden)")
  assert.equal(Model.resourceCountLabel(0, "default"), "0 resources")
})
