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
          warning: !twingate.installed || twingate.daemonDown || twingate.connectionState === "unknown"
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
    contentWidth: panel.fittedContentWidth(Style.space(340))
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
          // `detail` is a short bordered pill on the title row, not a
          // description: PanelHero sizes the title against it, so a long
          // string there collapses the title to zero width and hides it.
          PanelHero {
            id: hero
            width: parent.width
            title: "Twingate"
            meta: twingate.statusLabel
            detail: twingate.connected && twingate.resources.length > 0 ? String(twingate.resources.length) : ""
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconOpacity: twingate.connected ? 1.0 : 0.5
            iconComponent: Component {
              TwingateIcon {
                iconSize: Style.font.display
                color: root.iconColor
                badgeColor: root.urgent
                open: twingate.connected
                warning: !twingate.installed || twingate.daemonDown
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
          // Every state-changing Twingate command needs a terminal, so these
          // open one rather than pretending they can act silently.
          Row {
            id: actionRow
            width: parent.width
            spacing: Style.space(8)

            readonly property int count: twingate.installed && !twingate.daemonDown ? 2 : 1
            readonly property real cellWidth: (width - spacing * (count - 1)) / count

            ActionPill {
              width: actionRow.cellWidth
              text: root.primaryActionLabel
              tooltipText: twingate.installed ? "Opens a floating terminal"
                                              : "Installs the twingate AUR package"
              active: twingate.connected
              enabled: !twingate.actionPending
              onClicked: {
                if (!twingate.installed) twingate.installClient()
                else twingate.toggleConnection()
              }
            }

            ActionPill {
              width: actionRow.cellWidth
              visible: twingate.installed && !twingate.daemonDown
              text: "Stop service"
              tooltipText: "Shuts down the twingate daemon"
              enabled: !twingate.actionPending
              onClicked: twingate.stopService()
            }
          }

          // ── Resources ──────────────────────────────────────────────
          PanelSectionHeader {
            width: parent.width
            visible: twingate.connected
            text: "Resources"
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Text {
            width: parent.width
            visible: twingate.connected
            text: twingate.resourceCountLabel
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }

          Repeater {
            model: twingate.connected ? twingate.resources : []
            delegate: ResourceRow {
              required property var modelData
              required property int index
              width: column.width
              resource: modelData
              selected: root.cursorActive && root.resourceIndex === index
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

          ActionPill {
            width: parent.width
            visible: twingate.connected
            text: "Open in terminal"
            tooltipText: "Full status and resource list"
            onClicked: twingate.openResourcesInTerminal()
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
    signal activated()

    readonly property string address: Model.resourceAddress(resourceRow.resource)

    implicitHeight: resourceLabels.implicitHeight + Style.spacing.md * 2
    hasCursor: resourceRow.selected
    foreground: root.foreground
    fill: root.hoverFill
    currentFill: root.selectedFill

    Column {
      id: resourceLabels
      anchors.verticalCenter: parent.verticalCenter
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.leftMargin: Style.spacing.lg
      anchors.rightMargin: Style.spacing.lg
      spacing: Style.spacing.xxs

      Text {
        width: parent.width
        text: resourceRow.resource ? resourceRow.resource.name : ""
        color: root.foreground
        elide: Text.ElideRight
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
      }
      Text {
        width: parent.width
        // Fall back to the raw line when the columns were not recognisable, so
        // an unparsed row still shows what the CLI actually said.
        text: {
          if (!resourceRow.resource) return ""
          if (resourceRow.address !== "") return resourceRow.address
          return resourceRow.resource.detail || ""
        }
        visible: text !== ""
        color: root.dim
        elide: Text.ElideRight
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: resourceRow.activated()
    }
  }
}
