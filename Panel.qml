import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Bar widget + popup for the Twingate client.
//
// Everything visual is built from the shell's own primitives (Panel,
// KeyboardPanel, PanelHero, ToggleSwitch, Style, Color) rather than
// hand-rolled styling, so the popup inherits Quattro's surface, border,
// spacing and focus behaviour and tracks every Omarchy theme for free.
Panel {
  id: root

  moduleName: "veepee.twingate"
  ipcTarget: "veepee.twingate"
  manageIpc: false

  // Bar.qml collapses a slot on `activeItem.visible`, and activeItem is THIS
  // root -- not the button inside it. With `visible` on the button the icon
  // hid but its slot kept `button.implicitWidth`, leaving a dead gap in the
  // bar. The first-party weather widget puts `visible` on the root for the
  // same reason.
  visible: twingate.shouldShow
  implicitWidth: twingate.shouldShow ? button.implicitWidth : 0
  implicitHeight: twingate.shouldShow ? button.implicitHeight : 0
  onVisibleChanged: if (!visible) close()

  // ── Theme-derived colours ───────────────────────────────────────────
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color hoverFill: bar ? Style.hoverFillFor(bar.foreground, Color.accent, bar.urgent) : "transparent"

  readonly property color barIconColor: twingate.connected ? barForeground : Qt.darker(barForeground, 1.55)
  readonly property color iconColor: twingate.connected ? foreground : dim

  // ── Keyboard cursor over the resource list ──────────────────────────
  property bool cursorActive: false
  property int resourceIndex: 0
  // Which row was just copied, so it can confirm. Copying is otherwise
  // completely silent: the pointer turns into a hand and nothing else happens,
  // which is indistinguishable from a broken click.
  property int copiedIndex: -1

  Timer {
    id: copiedTimer
    interval: 1400
    onTriggered: root.copiedIndex = -1
  }
  readonly property bool hasResources: twingate.connected && twingate.resources.length > 0

  function selectedResource() {
    if (!hasResources) return null
    return twingate.resources[Math.max(0, Math.min(resourceIndex, twingate.resources.length - 1))]
  }

  // CursorSurface's contract: rows must NOT read containsMouse for their own
  // colour. Hover updates the panel's cursor at the root and the visuals derive
  // from hasCursor, which is what keeps exactly one highlight on screen.
  // Without this the mouse got a pointing-hand cursor and no feedback at all.
  function setResourceCursor(index) {
    cursorActive = true
    resourceIndex = index
  }

  // The list changes under the cursor -- reconnects, auth expiry, a scope
  // change. Unclamped, the highlight pointed at nothing while Enter and `c`
  // still copied whatever selectedResource() clamped to.
  function clampCursor() {
    var count = twingate.resources.length
    if (count === 0) { resourceIndex = 0; cursorActive = false }
    else if (resourceIndex > count - 1) resourceIndex = count - 1
    copiedIndex = -1
  }

  function moveCursor(dy) {
    if (!hasResources) return
    var count = twingate.resources.length
    resourceIndex = Math.max(0, Math.min(count - 1, resourceIndex + dy))
    scrollCursorIntoView()
  }

  // A Column inside a Flickable has no positionViewAtIndex, so this is done by
  // hand -- the same way the first-party tailscale and dropbox panels do it.
  // The popup caps its height, so without this the cursor simply walked into
  // the clipped region and the panel looked frozen.
  function scrollCursorIntoView() {
    if (!panelFlick || !resourceRepeater) return
    var item = resourceRepeater.itemAt(resourceIndex)
    if (!item) return
    var top = item.mapToItem(column, 0, 0).y
    var bottom = top + item.height
    if (top < panelFlick.contentY) panelFlick.contentY = top
    else if (bottom > panelFlick.contentY + panelFlick.height)
      panelFlick.contentY = bottom - panelFlick.height
  }

  function copySelectedAddress() {
    var resource = selectedResource()
    if (!resource) return
    twingate.copyToClipboard(Model.clipboardValue(resource))
    // The clamped index, not the raw one: they differ when the list shrank
    // under the cursor, and the confirmation must land on the row that was
    // actually copied.
    copiedIndex = Math.max(0, Math.min(resourceIndex, twingate.resources.length - 1))
    copiedTimer.restart()
  }

  onOpenedChanged: {
    if (opened) {
      cursorActive = false
      resourceIndex = 0
      copiedIndex = -1
      // Reopening otherwise lands on the previous scroll offset with the
      // cursor logically at row 0, i.e. off-screen.
      if (panelFlick) panelFlick.contentY = 0
      twingate.refresh()
    }
  }

  Service {
    id: twingate
    settings: root.settings
    bar: root.bar
    // Only poll the resource list while it can actually be seen.
    wantResources: root.opened
  }

  Connections {
    target: twingate
    function onResourcesChanged() { root.clampCursor() }
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { twingate.refresh(); return "ok" }
    // These report what actually happened. Returning "ok" for an action the
    // busy guard refused told a script the opposite of the truth, and the
    // plugin already argues elsewhere that a caller must be able to tell
    // states apart.
    function connect(): string {
      if (!twingate.installed) return "not-installed"
      return twingate.connectNetwork() ? "ok" : "busy"
    }
    function disconnect(): string {
      if (!twingate.installed) return "not-installed"
      return twingate.disconnectNetwork() ? "ok" : "busy"
    }
    function toggleConnection(): string { return twingate.toggleConnection() }
    // "missing" rather than "unknown" when there is no CLI: a script calling
    // this could not otherwise tell "not installed" from "said something I did
    // not recognise", which need different responses.
    function status(): string { return twingate.installed ? twingate.connectionState : "missing" }
    function diagnostics(): string { return twingate.diagnosticsJson() }
  }

  // ── Bar button ──────────────────────────────────────────────────────
  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    iconComponent: Component {
      Item {
        TwingateIcon {
          anchors.centerIn: parent
          iconSize: Style.space(11)
          color: root.barIconColor
          badgeColor: root.urgent
          open: twingate.connected
          warning: twingate.needsAttention
        }
      }
    }
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) twingate.toggleConnection()
      else if (buttonCode === Qt.MiddleButton) twingate.refresh()
      else root.toggle()
    }
  }

  // ── Popup ───────────────────────────────────────────────────────────
  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(520))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        root.moveCursor(dy)
      }
      onActivateRequested: if (root.cursorActive) root.copySelectedAddress()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      // c and o act on the selection, so they require one to exist -- exactly
      // as Enter does. Without the guard, `c` as the first keystroke in a
      // fresh panel copied row 0 with nothing highlighted, which is the silent
      // clipboard write the "Copied" confirmation exists to rule out.
      onTextKey: function(t) {
        var key = String(t || "").toLowerCase()
        if (key === "t") twingate.toggleConnection()
        else if (key === "r") twingate.refresh()
        else if (!root.cursorActive) return
        else if (key === "c") root.copySelectedAddress()
        else if (key === "o") twingate.openResource(root.selectedResource())
      }

      Flickable {
        id: panelFlick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: column
          width: panelFlick.width
          spacing: Style.space(12)

          // ── Hero: identity, state, and the toggle ──────────────────
          // No `detail` pill. It renders as a small bordered box floating at
          // the end of the title row, and a bare number there reads as
          // unexplained chrome -- the count is already stated in words below.
          PanelHero {
            id: hero
            width: parent.width
            title: "Twingate"
            meta: twingate.statusLabel
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconOpacity: twingate.connected ? 1.0 : 0.5
            iconComponent: Component {
              TwingateIcon {
                iconSize: Style.font.display
                color: root.iconColor
                badgeColor: root.urgent
                open: twingate.connected
                warning: twingate.needsAttention
              }
            }
            trailingControl: Component {
              Row {
                spacing: Style.space(8)

                Button {
                  iconText: "\u{f0450}"
                  tooltipText: "Refresh"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  iconSize: Style.font.icon
                  horizontalPadding: Style.space(5)
                  verticalPadding: Style.space(2)
                  iconSpinning: twingate.busy
                  anchors.verticalCenter: parent.verticalCenter
                  onClicked: twingate.refresh()
                }

                ToggleSwitch {
                  visible: twingate.installed
                  // Optimistic while an action is in flight, observed
                  // otherwise. Authentication counts as on: it is the
                  // switching-on phase, and it gives the user one flick to
                  // abandon a sign-in they no longer want.
                  checked: twingate.desiredOn
                  busy: twingate.busy
                  foreground: root.foreground
                  anchors.verticalCenter: parent.verticalCenter
                  onToggled: twingate.toggleConnection()
                }
              }
            }
          }

          // The one-line explanation of the current state, which the hero pill
          // is too small to carry.
          Text {
            width: parent.width
            visible: text !== ""
            textFormat: Text.PlainText
            text: twingate.statusDetail
            color: root.dim
            wrapMode: Text.WordWrap
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          PanelSeparator {
            width: parent.width
            foreground: root.foreground
          }

          // ── Actions ────────────────────────────────────────────────
          // The switch owns connect, disconnect, and starting the daemon, so
          // there is deliberately no Disconnect button beneath it and no Stop
          // service button either.
          //
          // There is no Stop-service action either. On Linux stopping the
          // daemon is what turning the switch off already does -- both
          // `twingate stop` and `twingate disconnect` exit the client -- so a
          // separate control would duplicate the switch while looking heavier.
          //
          // What remains is only what the switch cannot do: install the client,
          // for which the switch is hidden anyway.
          ActionPill {
            width: parent.width
            visible: !twingate.installed
            text: "Install Twingate client"
            tooltipText: "Installs the pinned client after verifying its checksum"
            enabled: !twingate.actionPending
            onClicked: twingate.installClient()
          }

          // ── Resources ──────────────────────────────────────────────
          Item {
            width: parent.width
            visible: twingate.connected
            implicitHeight: sectionHeader.implicitHeight

            PanelSectionHeader {
              id: sectionHeader
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              text: twingate.resourceHeading
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            // Twingate's own wording, verbatim. It is the authorisation for
            // these resources, not the client session, so it belongs on the
            // section header rather than beside the count where it read as a
            // property of the number.
            Text {
              anchors.right: parent.right
              anchors.rightMargin: Style.spacing.lg
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: twingate.displayAuthStatus
              visible: text !== ""
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }

          Repeater {
            id: resourceRepeater
            model: twingate.connected ? twingate.resources : []
            delegate: ResourceRow {
              required property var modelData
              required property int index
              width: column.width
              resource: modelData
              selected: root.cursorActive && root.resourceIndex === index
              copied: root.copiedIndex === index
              onHovered: root.setResourceCursor(index)
              onActivated: {
                root.resourceIndex = index
                root.copySelectedAddress()
              }
            }
          }

          // Say so when the list was cut, rather than silently showing a
          // shorter fleet than the user has.
          Text {
            width: parent.width
            visible: twingate.connected && twingate.resources.truncated === true
            text: "Showing the first " + twingate.resources.length + " resources"
            color: root.dim
            textFormat: Text.PlainText
            wrapMode: Text.WordWrap
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          // A connected client with no resources is a real, explicable state
          // (nothing assigned to you), so say that rather than showing nothing.
          Text {
            width: parent.width
            visible: twingate.connected && twingate.resources.length === 0
            textFormat: Text.PlainText
            text: "No resources are assigned to this device."
            color: root.dim
            wrapMode: Text.WordWrap
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          // ── Errors ─────────────────────────────────────────────────
          Text {
            width: parent.width
            visible: twingate.lastError !== ""
            textFormat: Text.PlainText
            text: twingate.lastError
            color: root.urgent
            wrapMode: Text.WordWrap
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }
        }
      }
    }
  }

  // ── Local components ──────────────────────────────────────────────────
  // Both are thin wrappers over the shell's own primitives so they pick up
  // the native fills, borders, focus rings and tooltips rather than
  // approximating them.

  component ActionPill: Button {
    fontSize: Style.font.bodySmall
    foreground: root.foreground
    fontFamily: root.fontFamily
    horizontalPadding: Style.spacing.controlPaddingX
    verticalPadding: Style.spacing.controlPaddingY + Style.space(2)
    bordered: true
    opacity: enabled ? 1.0 : 0.45
  }

  component ResourceRow: CursorSurface {
    id: resourceRow
    property var resource: null
    property bool selected: false
    property bool copied: false
    signal activated()
    signal hovered()

    readonly property string address: Model.resourceAddress(resourceRow.resource)

    // Name and address share one line -- name left, address right. Stacking
    // them left most of the panel's width empty and made eight resources
    // twice as tall as they needed to be.
    implicitHeight: nameText.implicitHeight + Style.spacing.md * 2
    hasCursor: resourceRow.selected
    foreground: root.foreground
    fill: root.hoverFill

    Text {
      id: addressText
      anchors.right: parent.right
      anchors.rightMargin: Style.spacing.lg
      anchors.verticalCenter: parent.verticalCenter
      // Bounded and elided. This text is a join of up to three CLI fields, and
      // unbounded it starved nameText -- whose right edge anchors to this --
      // of all its width, so the name vanished and the address painted out
      // past the panel edge. Half the row is the most it may claim.
      width: Math.min(implicitWidth, resourceRow.width * 0.55)
      horizontalAlignment: Text.AlignRight
      elide: Text.ElideRight
      // Tenant-admin-controlled: Qt's default AutoText renders a string
      // beginning with a tag as rich text, so a resource named
      // <img src="https://attacker/x"> would fetch a remote resource and take
      // over the row's layout.
      textFormat: Text.PlainText
      // "Copied" replaces the address in place, so the row keeps its width and
      // nothing below it moves. A value that was not host-shaped -- a wildcard
      // like *.example.com -- is real and still shown.
      text: {
        if (resourceRow.copied) return "Copied"
        if (!resourceRow.resource) return ""
        var parts = []
        parts.push(resourceRow.address !== "" ? resourceRow.address
                                              : String(resourceRow.resource.address || ""))
        if (resourceRow.resource.alias) parts.push(resourceRow.resource.alias)
        // Per-row auth status only when it disagrees with the rest; the shared
        // case is stated once on the section header instead.
        // A row shows its own status when it diverges from the rest, and never
        // when it is just the countdown everyone shares.
        if (twingate.sharedAuthStatus === "" && resourceRow.resource.authStatus
            && !Model.isCountdownAuthStatus(resourceRow.resource.authStatus))
          parts.push(resourceRow.resource.authStatus)
        return parts.filter(function(x) { return x !== "" }).join("  \u00b7  ")
      }
      color: resourceRow.copied ? root.foreground : root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      Behavior on color { ColorAnimation { duration: 120 } }
    }

    Text {
      id: nameText
      anchors.left: parent.left
      anchors.leftMargin: Style.spacing.lg
      // Anchored to the address, so a long name elides rather than colliding
      // with it.
      anchors.right: addressText.left
      anchors.rightMargin: Style.spacing.xl
      anchors.verticalCenter: parent.verticalCenter
      textFormat: Text.PlainText
      text: resourceRow.resource ? resourceRow.resource.name : ""
      color: root.foreground
      elide: Text.ElideRight
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
    }

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: resourceRow.hovered()
      onClicked: resourceRow.activated()
    }
  }
}
