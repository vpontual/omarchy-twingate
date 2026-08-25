import QtQuick
import qs.Commons
import qs.Ui

// A gate: two posts and a lintel, with a passage between them that is lit when
// traffic can flow. Drawn from primitives rather than an SVG so it stays crisp
// in a tiny bar slot and tracks the theme foreground exactly.
//
// This is deliberately a generic gate glyph and not a reproduction of
// Twingate's brand mark -- see the trademark note in the README.
Item {
  id: root

  property real iconSize: Style.font.icon
  property color color: Color.foreground
  property color badgeColor: Color.urgent
  // Passage open: the gap between the posts is lit.
  property bool open: false
  property bool crossed: false
  property bool warning: false

  width: iconSize
  height: iconSize
  implicitWidth: iconSize
  implicitHeight: iconSize

  readonly property real stroke: Math.max(1.5, root.iconSize * 0.16)
  readonly property real postHeight: root.iconSize * 0.82
  readonly property real inset: root.iconSize * 0.06

  // Lintel across the top of the posts.
  Rectangle {
    x: root.inset
    y: root.inset
    width: root.iconSize - root.inset * 2
    height: root.stroke
    radius: height / 2
    color: root.color
  }

  // Left post.
  Rectangle {
    x: root.inset
    y: root.inset
    width: root.stroke
    height: root.postHeight
    radius: width / 2
    color: root.color
  }

  // Right post.
  Rectangle {
    x: root.iconSize - root.inset - root.stroke
    y: root.inset
    width: root.stroke
    height: root.postHeight
    radius: width / 2
    color: root.color
  }

  // The passage. Solid when open, a faint outline when shut, so the two states
  // differ in shape and not only in overall opacity -- opacity alone is hard to
  // read at bar size and invisible to anyone with low contrast sensitivity.
  Rectangle {
    anchors.horizontalCenter: parent.horizontalCenter
    y: root.inset + root.stroke * 2.1
    width: root.stroke * 1.15
    height: root.postHeight - root.stroke * 2.1
    radius: width / 2
    color: root.open ? root.color : "transparent"
    border.color: root.color
    border.width: root.open ? 0 : Math.max(1, root.stroke * 0.45)
    opacity: root.open ? 1.0 : 0.55
  }

  Rectangle {
    visible: root.crossed
    anchors.centerIn: parent
    width: parent.width * 1.22
    height: Math.max(2, parent.height * 0.14)
    radius: height / 2
    color: root.color
    rotation: -45
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
