# Twingate for Omarchy

Twingate Zero Trust client status, connect/disconnect, and authorized resource
browsing in the Omarchy bar.

![The Twingate panel](preview.png)

## Install

```sh
omarchy plugin add https://github.com/vpontual/omarchy-twingate.git --enable
```

Requires the [Twingate Linux client](https://www.twingate.com/download)
(`twingate` on `PATH`) and Omarchy 4 (Quattro) or newer.

## Use

| Action | Result |
|---|---|
| Click the bar icon | Open the panel |
| Right-click | Connect or disconnect |
| Middle-click | Refresh |
| `t` / `r` / `c` | Toggle / refresh / copy the selected resource address |
| `↑` `↓` then `Enter` | Move through resources and copy the address |

The bar icon is a gate: clear when traffic can flow, barred when it cannot, with
a badge when the CLI is missing or the daemon is stopped. Open and shut differ in
shape rather than in opacity, which is unreadable at bar size.

Clicking a resource copies its address to the clipboard.

## Why every action opens a terminal

This is the constraint that shapes the whole plugin, so it is worth stating
plainly rather than leaving it to look like a shortcut.

`twingate start` and `twingate stop` re-invoke `sudo` themselves, and
`twingate start` is interactive beyond that — it asks the operator to press
enter. The Omarchy shell runs commands without a controlling terminal, so
running either from the panel directly fails:

```
$ twingate stop --print-commands
sudo: a terminal is required to read the password; either use the -S option
      to read from standard input or configure an askpass helper

$ twingate start --print-commands
Please, run systemctl is-active --quiet twingate in another terminal and
then press [enter] to continue...
```

So the split is absolute: `twingate status` and `twingate resources` are
read-only and run headless; **everything that changes state is handed to a
floating terminal**, where sudo can prompt and you can see what happened.

**This plugin deliberately does not ask you to add a NOPASSWD sudoers rule.**
A sudoers rule would not help — it would not make `twingate start`
non-interactive — and it would widen your privilege surface for no gain. Any
Omarchy plugin that asks you to weaken `sudo` for a client that still needs a
TTY is not buying you anything.

## Settings

Configure through the Omarchy bar settings, or directly:

```sh
omarchy bar set io.github.vpontual.twingate refreshIntervalSec 30
omarchy bar move io.github.vpontual.twingate --section right
```

| Key | Default | Values |
|---|---|---|
| `refreshIntervalSec` | `10` | `5`–`3600` |
| `visibility` | `always` | `always`, `when-online`, `when-installed` |
| `resourceScope` | `default` | `default`, `all` (include hidden resources) |

`visibility` defaults to `always` on purpose: a widget that silently vanishes is
indistinguishable from a broken one. Set `when-online` if you would rather it
stay out of the way while disconnected.

## IPC

```sh
omarchy-shell shell summon "io.github.vpontual.twingate" '{}'
qs -p /usr/share/omarchy/shell ipc call io.github.vpontual.twingate status
```

`open`, `close`, `toggle`, `refresh`, `connect`, `disconnect`,
`toggleConnection`, and `status` are exposed — enough to bind connecting to a
Hyprland key or drive it from a script.

## Development

```sh
git clone https://github.com/vpontual/omarchy-twingate.git
cd omarchy-twingate
npm test                       # 14 tests, no dependencies
omarchy plugin validate .
omarchy plugin add "$PWD" --enable   # git clone works from a local path
omarchy-restart-shell          # NOT omarchy-refresh-shell, which resets shell.json
```

`Model.js` holds every parser as a pure function precisely so it can be tested
without a running shell. `Service.qml` owns process handling and state;
`Panel.qml` is presentation only.

Note that `qmllint` exits `255` with no output on this codebase — it does the
same on Omarchy's own shipped first-party plugins, so treat it as a broken tool
rather than a signal.

### Known limitation

The `twingate resources` table is whitespace-aligned and its columns vary by
CLI version. `parseResources` is tolerant by design — it recovers a name and an
address when the shape is recognisable and otherwise preserves the raw line
rather than dropping a resource silently — but **it has been unit-tested against
representative output, not yet verified against a live connected client**. If
your resource list renders oddly, please open an issue with the output of
`twingate resources -d` and it will be fixed against the real shape.

## Design notes

The panel is built entirely from the shell's own primitives — `Panel`,
`KeyboardPanel`, `PanelHero`, `ToggleSwitch`, `Button`, `CursorSurface`,
`Style`, `Color` — rather than hand-rolled styling. That is what makes it match
Quattro's popover surface, border, spacing and focus behaviour exactly, and
track every Omarchy theme for free.

The icon is drawn from primitives instead of shipping an SVG, so it stays crisp
in a small bar slot and follows the theme foreground.

## Trademark

Twingate is a trademark of Twingate Inc. This is an unofficial, community-built
plugin and is not affiliated with, endorsed by, or supported by Twingate Inc.
The bar icon is a generic gate glyph drawn for this plugin, not a reproduction
of Twingate's brand mark.

## Licence

MIT — see [LICENSE](LICENSE).
