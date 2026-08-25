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
    if (!twingate.installed) return "Install Twingate"
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
          crossed: twingate.installed && !twingate.connected && twingate.connectionState !== "authenticating"
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
          PanelHero {
            id: hero
            width: parent.width
            title: "Twingate"
            meta: twingate.statusLabel
            detail: twingate.statusDetail
            foreground: root.foreground
            fontFamily: root.fontFamily
            iconOpacity: twingate.connected ? 1.0 : 0.5
            iconComponent: Component {
              TwingateIcon {
                iconSize: Style.font.display
                color: root.iconColor
                badgeColor: root.urgent
                open: twingate.connected
                crossed: twingate.installed && !twingate.connected && twingate.connectionState !== "authenticating"
                warning: !twingate.installed || twingate.daemonDown
              }
            }
            trailingControl: Component {
              ToggleSwitch {
                visible: twingate.installed
                checked: twingate.connected
                busy: twingate.busy
                foreground: root.foreground
                onToggled: twingate.toggleConnection()
              }
            }
          }

          PanelSeparator {
            width: parent.width
            foreground: root.foreground
          }

          // ── Primary action ─────────────────────────────────────────
          // Every state-changing Twingate command needs a terminal, so this
          // opens one rather than pretending it can act silently.
          ActionRow {
            width: parent.width
            label: root.primaryActionLabel
            hint: twingate.installed ? "Opens a terminal" : "Opens the Twingate download page"
            enabled: !twingate.actionPending
            onActivated: {
              if (!twingate.installed) Quickshell.execDetached(["xdg-open", "https://www.twingate.com/download"])
              else twingate.toggleConnection()
            }
          }

          ActionRow {
            width: parent.width
            visible: twingate.installed && !twingate.daemonDown
            label: "Stop service"
            hint: "Shuts down the twingate daemon"
            enabled: !twingate.actionPending
            onActivated: twingate.stopService()
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

          ActionRow {
            width: parent.width
            visible: twingate.connected
            label: "Open in terminal"
            hint: "Full status and resource list"
            onActivated: twingate.openResourcesInTerminal()
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

  // ── Local row components ──────────────────────────────────────────────
  component ActionRow: Rectangle {
    id: actionRow
    property string label: ""
    property string hint: ""
    signal activated()

    implicitHeight: actionLabel.implicitHeight + hintLabel.implicitHeight + Style.spacing.lg * 2
    radius: Style.cornerRadius
    color: actionMouse.containsMouse && actionRow.enabled ? root.hoverFill : "transparent"
    opacity: actionRow.enabled ? 1.0 : 0.45

    Column {
      anchors.verticalCenter: parent.verticalCenter
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.leftMargin: Style.spacing.lg
      anchors.rightMargin: Style.spacing.lg
      spacing: Style.spacing.xxs

      Text {
        id: actionLabel
        text: actionRow.label
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
      }
      Text {
        id: hintLabel
        text: actionRow.hint
        visible: actionRow.hint !== ""
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }

    MouseArea {
      id: actionMouse
      anchors.fill: parent
      hoverEnabled: true
      enabled: actionRow.enabled
      cursorShape: Qt.PointingHandCursor
      onClicked: actionRow.activated()
    }
  }

  component ResourceRow: Rectangle {
    id: resourceRow
    property var resource: null
    property bool selected: false
    signal activated()

    readonly property string address: Model.resourceAddress(resourceRow.resource)

    implicitHeight: nameLabel.implicitHeight + addressLabel.implicitHeight + Style.spacing.md * 2
    radius: Style.cornerRadius
    color: resourceRow.selected ? root.selectedFill
         : (resourceMouse.containsMouse ? root.hoverFill : "transparent")

    Column {
      anchors.verticalCenter: parent.verticalCenter
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.leftMargin: Style.spacing.lg
      anchors.rightMargin: Style.spacing.lg
      spacing: Style.spacing.xxs

      Text {
        id: nameLabel
        width: parent.width
        text: resourceRow.resource ? resourceRow.resource.name : ""
        color: root.foreground
        elide: Text.ElideRight
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
      }
      Text {
        id: addressLabel
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
      id: resourceMouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: resourceRow.activated()
    }
  }
}
