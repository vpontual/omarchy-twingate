import QtQuick
import qs.Commons
import qs.Ui

// A gateway. Connected fills it solid; disconnected leaves it a hollow arch.
//
// The states differ in mass, not in detail: at bar size (~22px) fill against
// outline reads in peripheral vision, where a thin added line or a change of
// opacity does not.
//
// Drawn from primitives rather than an SVG so it stays crisp in a small bar
// slot and follows the theme foreground. It is deliberately a generic gateway,
// not Twingate's brand mark -- see the trademark note in the README.
Item {
  id: root

  property real iconSize: Style.font.icon
  property color color: Color.foreground
  property color badgeColor: Color.urgent
  // Traffic can flow: the gateway is solid.
  property bool open: false
  property bool warning: false

  width: iconSize
  height: iconSize
  implicitWidth: iconSize
  implicitHeight: iconSize

  readonly property real stroke: Math.max(1.5, root.iconSize * 0.13)
  readonly property real inset: root.iconSize * 0.08
  readonly property real span: root.iconSize - root.inset * 2
  // The clear width between the two legs, which is what the badge nests into.
  readonly property real opening: root.span - root.stroke * 2

  // The arch. Per-corner radii (Qt 6.7+) give a semicircular crown over
  // straight legs without pulling in QtQuick.Shapes for one glyph.
  Rectangle {
    x: root.inset
    y: root.inset
    width: root.span
    height: root.span
    topLeftRadius: root.span / 2
    topRightRadius: root.span / 2
    bottomLeftRadius: 0
    bottomRightRadius: 0
    color: root.open ? root.color : "transparent"
    border.color: root.color
    border.width: root.open ? 0 : root.stroke
  }

  // The badge sits inside the opening rather than in a corner, where it would
  // clip the arch's right leg. Nested in the gateway, the arch stays whole.
  Rectangle {
    visible: root.warning
    // Small enough to leave daylight between it and both legs; any larger it
    // reads as a blob filling the arch.
    readonly property real size: Math.min(root.opening * 0.52, root.iconSize * 0.28)
    width: size
    height: size
    radius: size / 2
    x: (root.iconSize - size) / 2
    y: root.iconSize - root.inset - size - Math.max(1, root.iconSize * 0.06)
    color: root.badgeColor
    // A plain dot: at 6-9px an exclamation mark renders as a smear. The panel
    // says what needs attention. The ring only shows against the filled state.
    border.color: Color.popups.background
    border.width: root.open ? 1 : 0
  }
}
