import QtQuick
import qs.Commons
import qs.Ui

// A gateway. Connected fills it solid; disconnected leaves it a hollow arch.
//
// The states differ in MASS, not in detail. An earlier version drew a square
// gate and signalled "shut" with a thin bar across the middle, which at bar
// size (~22px) left the two states differing by a few pixels and made the pair
// read as the letters "Pi" and "A" rather than as an icon. Fill against
// outline is legible in peripheral vision, which is the whole job here.
//
// Note this is a different thing from signalling state with opacity, which
// does not work at this size: a dimmer copy of the same silhouette is not
// readable at a glance. Filled versus hollow is a genuine shape difference.
//
// Drawn from primitives rather than an SVG so it stays crisp in a small bar
// slot and follows the theme foreground exactly. It is deliberately a generic
// gateway and not a reproduction of Twingate's brand mark -- see the
// trademark note in the README.
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

  // The badge sits INSIDE the opening rather than in the bottom-right corner.
  // The corner is where the arch's right leg lands, and every corner placement
  // tried there clipped the leg into something that read as a broken glyph.
  // Nesting it in the gateway leaves the arch whole, and says the thing that
  // needs attention is the gateway itself.
  Rectangle {
    visible: root.warning
    // Sized to sit clearly INSIDE the opening with daylight around it. An
    // earlier 0.74 of the opening touched both legs and read as a blob
    // filling the arch rather than as a badge within it.
    readonly property real size: Math.min(root.opening * 0.52, root.iconSize * 0.28)
    width: size
    height: size
    radius: size / 2
    x: (root.iconSize - size) / 2
    y: root.iconSize - root.inset - size - Math.max(1, root.iconSize * 0.06)
    color: root.badgeColor
    // A plain dot, with no "!" inside it. The badge is about 6-9px wherever it
    // is drawn -- bar slot or panel header -- and an exclamation mark at that
    // size rendered as a two-pixel smear with subpixel colour fringing, which
    // made the badge look damaged rather than urgent. A dot reads as
    // "attention" on its own, and the panel says which attention it wants.
    //
    // The ring only matters if the badge ever lands on the filled state;
    // against the dark panel background it is invisible either way.
    border.color: Color.popups.background
    border.width: root.open ? 1 : 0
  }
}
