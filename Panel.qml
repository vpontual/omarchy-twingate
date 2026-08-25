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

  moduleName: "io.github.vpontual.twingate"
  ipcTarget: "io.github.vpontual.twingate"
  manageIpc: false

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  // ── Theme-derived colours ───────────────────────────────────────────
  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color hoverFill: bar ? Style.hoverFillFor(bar.foreground, Color.accent, bar.urgent) : "transparent"
  readonly property color selectedFill: bar ? Style.selectedFillFor(bar.foreground, Color.accent, bar.urgent) : "transparent"

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

  function moveCursor(dy) {
    if (!hasResources) return
    var count = twingate.resources.length
    resourceIndex = Math.max(0, Math.min(count - 1, resourceIndex + dy))
  }

  function copySelectedAddress() {
    var resource = selectedResource()
    if (!resource) return
    var address = Model.resourceAddress(resource)
    twingate.copyToClipboard(address !== "" ? address : resource.name)
    copiedIndex = resourceIndex
    copiedTimer.restart()
  }

  // The primary action label tracks state so the button never lies about what
  // pressing it will do.
  readonly property string primaryActionLabel: {
    if (!twingate.installed) return "Install Twingate client"
    if (twingate.daemonDown) return "Start service"
    if (twingate.connected) return "Disconnect"
    if (twingate.connectionState === "authenticating") return "Cancel authentication"
    return "Connect"
  }

  onOpenedChanged: {
    if (opened) {
      cursorActive = false
      resourceIndex = 0
      twingate.refresh()
    }
  }

  Service {
    id: twingate
    settings: root.settings
    bar: root.bar
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { twingate.refresh(); return "ok" }
    function connect(): string { twingate.connectNetwork(); return "ok" }
    function disconnect(): string { twingate.disconnectNetwork(); return "ok" }
    function toggleConnection(): string { twingate.toggleConnection(); return "ok" }
    function status(): string { return twingate.connectionState }
  }

  // ── Bar button ──────────────────────────────────────────────────────
  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    visible: twingate.shouldShow
    iconComponent: Component {
      Item {
        TwingateIcon {
          anchors.centerIn: parent
          iconSize: Style.space(11)
          color: root.barIconColor
          badgeColor: root.urgent
          open: twingate.connected
          warning: !twingate.installed || twingate.connectionState === "unknown"
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
      onTextKey: function(t) {
        var key = String(t || "").toLowerCase()
        if (key === "t") twingate.toggleConnection()
        else if (key === "r") twingate.refresh()
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
                warning: !twingate.installed || twingate.connectionState === "unknown"
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
                  // On throughout authentication: it is the switching-on
                  // phase, and it gives the user one flick to abandon a
                  // sign-in they no longer want.
                  checked: twingate.connected || twingate.connecting
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
          // Stop service was removed on purpose. It reads like an off switch
          // sitting next to the actual off switch, but it is a heavier action:
          // it leaves the widget showing a warning badge, which looks like
          // something is broken rather than like Twingate is simply off. Users
          // reaching for "off for now" must land on the switch. Stopping the
          // daemon is an administrative action and lives in the README as
          // `sudo twingate service-stop`.
          //
          // What remains is only what the switch cannot do: install the client,
          // for which the switch is hidden anyway.
          ActionPill {
            width: parent.width
            visible: !twingate.installed
            text: "Install Twingate client"
            tooltipText: "Installs the twingate AUR package"
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
              text: twingate.displayAuthStatus
              visible: text !== ""
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }

          Repeater {
            model: twingate.connected ? twingate.resources : []
            delegate: ResourceRow {
              required property var modelData
              required property int index
              width: column.width
              resource: modelData
              selected: root.cursorActive && root.resourceIndex === index
              copied: root.copiedIndex === index
              onActivated: {
                root.resourceIndex = index
                root.copySelectedAddress()
              }
            }
          }

          // A connected client with no resources is a real, explicable state
          // (nothing assigned to you), so say that rather than showing nothing.
          Text {
            width: parent.width
            visible: twingate.connected && twingate.resources.length === 0
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

    readonly property string address: Model.resourceAddress(resourceRow.resource)

    // Name and address share one line -- name left, address right. Stacking
    // them left most of the panel's width empty and made eight resources
    // twice as tall as they needed to be.
    implicitHeight: nameText.implicitHeight + Style.spacing.md * 2
    hasCursor: resourceRow.selected
    foreground: root.foreground
    fill: root.hoverFill
    currentFill: root.selectedFill

    Text {
      id: addressText
      anchors.right: parent.right
      anchors.rightMargin: Style.spacing.lg
      anchors.verticalCenter: parent.verticalCenter
      // Falls back to the raw value when the address was not host-shaped -- a
      // wildcard like *.casavp.com is real and must still be shown.
      // Confirmation replaces the address in place rather than appearing
      // beside it, so the row does not change width and nothing below it moves.
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
      onClicked: resourceRow.activated()
    }
  }
}
