import QtQuick
import qs.Commons
import qs.Ui

// A gate: two posts under a lintel, with the passage between them either
// clear or barred. Open and shut differ in *shape*, not in opacity or a
// diagonal slash laid over the top -- at bar size (~11px) an opacity
// difference is unreadable and a slash merges with the posts into an
// indistinct box.
//
// Drawn from primitives rather than an SVG so it stays crisp in a small bar
// slot and follows the theme foreground exactly. This is deliberately a
// generic gate glyph and not a reproduction of Twingate's brand mark -- see
// the trademark note in the README.
Item {
  id: root

  property real iconSize: Style.font.icon
  property color color: Color.foreground
  property color badgeColor: Color.urgent
  // Passage clear: traffic can flow.
  property bool open: false
  property bool warning: false

  width: iconSize
  height: iconSize
  implicitWidth: iconSize
  implicitHeight: iconSize

  readonly property real stroke: Math.max(1.5, root.iconSize * 0.13)
  readonly property real inset: root.iconSize * 0.08
  readonly property real span: root.iconSize - root.inset * 2
  // Inner edges of the posts, i.e. the passage itself.
  readonly property real gapLeft: root.inset + root.stroke
  readonly property real gapWidth: root.span - root.stroke * 2

  // Lintel.
  Rectangle {
    x: root.inset
    y: root.inset
    width: root.span
    height: root.stroke
    radius: height / 2
    color: root.color
  }

  // Left post.
  Rectangle {
    x: root.inset
    y: root.inset
    width: root.stroke
    height: root.span
    radius: width / 2
    color: root.color
  }

  // Right post.
  Rectangle {
    x: root.iconSize - root.inset - root.stroke
    y: root.inset
    width: root.stroke
    height: root.span
    radius: width / 2
    color: root.color
  }

  // The bar across the passage. Present only when shut, so an open gate is
  // read by the absence of an obstruction rather than by a subtler cue.
  Rectangle {
    visible: !root.open
    x: root.gapLeft
    y: root.inset + root.span * 0.52
    width: root.gapWidth
    height: root.stroke
    radius: height / 2
    color: root.color
  }

  BorderSurface {
    visible: root.warning
    width: Math.max(7, parent.width * 0.42)
    height: width
    radius: width / 2
    color: root.badgeColor
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    borderSpec: Border.flat(Color.popups.background, 1)

    Text {
      anchors.centerIn: parent
      text: "!"
      color: Color.background
      font.family: Style.font.family
      font.pixelSize: Math.max(6, parent.height * 0.72)
      font.bold: true
    }
  }
}
