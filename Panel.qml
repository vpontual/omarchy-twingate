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
// KeyboardPanel, PanelHero, ToggleSwitch, TextField, Style, Color) rather
// than hand-rolled styling, so the popup inherits Quattro's surface, border,
// spacing and focus behaviour and tracks every Omarchy theme for free.
Panel {
  id: root

  moduleName: "veepee.twingate"
  ipcTarget: "veepee.twingate"
  manageIpc: false

  // Bar.qml collapses a slot on `activeItem.visible`, and activeItem is this
  // root, not the button inside it -- so visibility and size belong here, or
  // a hidden widget leaves a gap in the bar.
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

  // ── Search and the keyboard cursor over the resource list ───────────
  property string searchText: ""
  // Every cursor index below is into this list, not the full one, so the
  // highlight, Enter, `c`, `o` and `a` all agree on the row while filtering.
  readonly property var visibleResources: twingate.connected
    ? Model.filterResources(twingate.resources, searchText) : []
  readonly property bool searchAvailable: twingate.connected
    && twingate.resources.length >= Model.SEARCH_MIN_RESOURCES

  property bool cursorActive: false
  property int resourceIndex: 0
  // Which row was just copied, so it can confirm. Copying is otherwise
  // completely silent, which is indistinguishable from a broken click.
  property int copiedIndex: -1

  Timer {
    id: copiedTimer
    interval: 1400
    onTriggered: root.copiedIndex = -1
  }
  readonly property bool hasResources: visibleResources.length > 0

  function selectedResource() {
    if (!hasResources) return null
    return visibleResources[Math.max(0, Math.min(resourceIndex, visibleResources.length - 1))]
  }

  // CursorSurface's contract: rows must NOT read containsMouse for their own
  // colour. Hover updates the panel's cursor at the root and the visuals derive
  // from hasCursor, which is what keeps exactly one highlight on screen.
  function setResourceCursor(index) {
    cursorActive = true
    resourceIndex = index
  }

  // The list changes under the cursor -- reconnects, auth expiry, a scope
  // change, a new search -- so the highlight is kept on a real row.
  function clampCursor() {
    var count = visibleResources.length
    if (count === 0) { resourceIndex = 0; cursorActive = false }
    else if (resourceIndex > count - 1) resourceIndex = count - 1
    copiedIndex = -1
  }

  function moveCursor(dy) {
    if (!hasResources) return
    var count = visibleResources.length
    resourceIndex = Math.max(0, Math.min(count - 1, resourceIndex + dy))
    scrollCursorIntoView()
  }

  // A Column inside a Flickable has no positionViewAtIndex, so this is done by
  // hand -- the same way the first-party tailscale and dropbox panels do it.
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
    // The clamped index, not the raw one, so the confirmation lands on the
    // row that was actually copied.
    copiedIndex = Math.max(0, Math.min(resourceIndex, visibleResources.length - 1))
    copiedTimer.restart()
  }

  function focusSearch() {
    if (!searchAvailable) return
    searchField.forceActiveFocus()
  }

  // Down or Enter in the search box hands the keyboard back to the list, on
  // the first match.
  function enterListFromSearch() {
    keyCatcher.forceActiveFocus()
    if (!hasResources) return
    cursorActive = true
    resourceIndex = 0
    scrollCursorIntoView()
  }

  onSearchTextChanged: {
    resourceIndex = 0
    clampCursor()
  }

  onOpenedChanged: {
    if (opened) {
      cursorActive = false
      resourceIndex = 0
      copiedIndex = -1
      searchText = ""
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
    // Only poll the resource list and account while they can be seen.
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
    // These report what actually happened: "busy" when the action was refused.
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
      // The search box needs every key while it is focused.
      blocked: searchField.activeFocus
      onMoveRequested: function(dx, dy) {
        if (!root.cursorActive) { root.cursorActive = true; return }
        root.moveCursor(dy)
      }
      onActivateRequested: if (root.cursorActive) root.copySelectedAddress()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      // c, o and a act on the selection, so like Enter they require one: no
      // keystroke acts on a row that is not highlighted.
      onTextKey: function(t) {
        var key = String(t || "").toLowerCase()
        if (key === "t") twingate.toggleConnection()
        else if (key === "r") twingate.refresh()
        else if (key === "/") root.focusSearch()
        else if (!root.cursorActive) return
        else if (key === "c") root.copySelectedAddress()
        else if (key === "o") twingate.openResource(root.selectedResource())
        else if (key === "a") twingate.authenticateResource(root.selectedResource())
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
          // No `detail` pill: it renders as a bordered box on the title row,
          // and the resource count is already in the section heading.
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

          // ── Account ────────────────────────────────────────────────
          // Which account the switch will connect, and the one thing to do
          // about it here. Hidden when signed out: turning the switch on is
          // then what signs you in.
          Item {
            width: parent.width
            visible: twingate.installed && twingate.signedIn
            implicitHeight: Math.max(accountColumn.implicitHeight, signOutButton.implicitHeight)

            // Two lines rather than one joined string: side by side, the
            // network name was the part squeezed into an ellipsis.
            Column {
              id: accountColumn
              anchors.left: parent.left
              anchors.right: signOutButton.left
              anchors.rightMargin: Style.spacing.lg
              anchors.verticalCenter: parent.verticalCenter

              // The account address and network name are the tenant's.
              Text {
                width: parent.width
                textFormat: Text.PlainText
                text: twingate.accountEmail
                color: root.foreground
                elide: Text.ElideMiddle
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
              }

              Text {
                width: parent.width
                visible: text !== ""
                textFormat: Text.PlainText
                text: twingate.accountNetwork
                color: root.dim
                elide: Text.ElideRight
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }

            ActionPill {
              id: signOutButton
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              fontSize: Style.font.caption
              verticalPadding: Style.spacing.controlPaddingY
              text: "Sign out"
              tooltipText: "Sign out of this Twingate account"
              enabled: !twingate.busy
              onClicked: twingate.signOut()
            }
          }

          // Only when something follows it; disconnected, it underlined nothing.
          PanelSeparator {
            width: parent.width
            foreground: root.foreground
            visible: twingate.connected || !twingate.installed
                     || twingate.actionError !== "" || twingate.lastError !== ""
          }

          // ── Actions ────────────────────────────────────────────────
          // The switch owns connect and disconnect, and a connect starts the
          // daemon itself, so there is no Disconnect or Stop-service button:
          // on Linux both would do exactly what turning the switch off does.
          // What remains is only what the switch cannot do.
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
            // section header rather than beside the count.
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

          TextField {
            id: searchField
            width: parent.width
            visible: root.searchAvailable
            placeholderText: "Search resources  ( / )"
            foreground: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            verticalPadding: Style.spacing.controlPaddingY
            text: root.searchText
            onTextChanged: if (text !== root.searchText) root.searchText = text
            onAccepted: root.enterListFromSearch()
            Keys.onDownPressed: root.enterListFromSearch()
            // Escape clears first, then leaves the box, then (from the list)
            // closes the panel.
            Keys.onEscapePressed: {
              if (text !== "") root.searchText = ""
              else keyCatcher.forceActiveFocus()
            }
            onVisibleChanged: {
              if (visible) return
              root.searchText = ""
              if (activeFocus) keyCatcher.forceActiveFocus()
            }
          }

          Repeater {
            id: resourceRepeater
            model: root.visibleResources
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
              onAuthenticate: twingate.authenticateResource(modelData)
            }
          }

          Text {
            width: parent.width
            visible: twingate.connected && twingate.resources.length > 0
                     && root.visibleResources.length === 0
            textFormat: Text.PlainText
            text: "No resources match “" + root.searchText + "”"
            color: root.dim
            elide: Text.ElideRight
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          // Say so when the list was cut, rather than silently showing a
          // shorter fleet than the user has.
          Text {
            width: parent.width
            // Not for an empty list, which the next message explains.
            visible: twingate.connected && twingate.resources.truncated === true
                     && twingate.resources.length > 0
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
                     && twingate.resources.truncated !== true
            textFormat: Text.PlainText
            text: "No resources are assigned to this device."
            color: root.dim
            wrapMode: Text.WordWrap
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
          }

          // ── Errors ─────────────────────────────────────────────────
          // An action's failure outranks a poll's: it answers "why did the
          // thing I just did not work?".
          Text {
            width: parent.width
            visible: text !== ""
            textFormat: Text.PlainText
            text: twingate.actionError !== "" ? twingate.actionError : twingate.lastError
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
  // Thin wrappers over the shell's own primitives so they pick up the native
  // fills, borders, focus rings and tooltips rather than approximating them.

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
    signal authenticate()

    readonly property string address: Model.resourceAddress(resourceRow.resource)
    readonly property bool locked: resourceRow.resource !== null
      && Model.isLockedAuthStatus(resourceRow.resource.authStatus)

    // Name and address share one line -- name left, address right. Stacking
    // them left most of the panel's width empty.
    implicitHeight: Math.max(nameText.implicitHeight, authButton.visible ? authButton.implicitHeight : 0)
                    + Style.spacing.md * 2
    hasCursor: resourceRow.selected
    foreground: root.foreground
    fill: root.hoverFill

    // Declared before the button so the button sits above it and receives
    // its own clicks; everywhere else on the row a click copies.
    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onEntered: resourceRow.hovered()
      onClicked: resourceRow.activated()
    }

    ActionPill {
      id: authButton
      anchors.right: parent.right
      anchors.rightMargin: Style.spacing.lg
      anchors.verticalCenter: parent.verticalCenter
      visible: resourceRow.locked && !resourceRow.copied
      fontSize: Style.font.caption
      verticalPadding: Style.spacing.controlPaddingY
      text: "Authenticate"
      tooltipText: "This resource needs its own sign-in"
      onClicked: resourceRow.authenticate()
    }

    Text {
      id: addressText
      anchors.right: authButton.visible ? authButton.left : parent.right
      anchors.rightMargin: Style.spacing.lg
      anchors.verticalCenter: parent.verticalCenter
      // Bounded and elided, so a long address cannot starve the name.
      width: Math.min(implicitWidth, resourceRow.width * (authButton.visible ? 0.3 : 0.55))
      horizontalAlignment: Text.AlignRight
      elide: Text.ElideRight
      // Tenant-admin-controlled: Qt's default AutoText renders a string
      // beginning with a tag as rich text, so a resource named
      // <img src="https://attacker/x"> would fetch a remote resource.
      textFormat: Text.PlainText
      // "Copied" replaces the address in place, so the row keeps its width and
      // nothing below it moves.
      text: {
        if (resourceRow.copied) return "Copied"
        if (!resourceRow.resource) return ""
        var parts = []
        parts.push(resourceRow.address !== "" ? resourceRow.address
                                              : String(resourceRow.resource.address || ""))
        if (resourceRow.resource.alias) parts.push(resourceRow.resource.alias)
        // A row shows its own status only when it diverges from the rest, is
        // not the countdown everyone shares, and is not already said by the
        // Authenticate button.
        if (twingate.sharedAuthStatus === "" && resourceRow.resource.authStatus
            && !Model.isCountdownAuthStatus(resourceRow.resource.authStatus)
            && !resourceRow.locked)
          parts.push(resourceRow.resource.authStatus)
        return parts.filter(function(x) { return x !== "" }).join("  ·  ")
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
  }
}
