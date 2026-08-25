# Twingate Omarchy Widget

Unofficial Omarchy bar widget for the [Twingate](https://www.twingate.com)
Zero Trust client.

![The Twingate panel](preview.png)

## Install

```sh
omarchy plugin add https://github.com/vpontual/omarchy-twingate.git --enable
```

Then install the Twingate client, if you do not have it. Twingate publishes an
Arch package directly — download it first, then install the local file:

```sh
curl -fLO https://binaries.twingate.com/client/linux/ARCH/x86_64/stable/twingate-amd64.pkg.tar.zst
sudo pacman -U twingate-amd64.pkg.tar.zst
```

On `aarch64` use `.../aarch64/stable/twingate-arm64.pkg.tar.zst`.

The panel offers **Copy the install command**, which puts exactly that on your
clipboard. It deliberately does not run it: that URL is the mutable `stable`
path with no version, digest or signature, so a plugin executing it as root
would run bytes that can change after the plugin itself was reviewed. Reading
the command and running it yourself is where that decision belongs.

> Not from the AUR: `twingate` currently fails its checksum and `twingate-bin`
> omits `/usr/bin/twingate-classic`, so disconnect breaks. Details in
> [docs/NOTES.md](docs/NOTES.md).

Point the client at your network once — the plugin cannot know its name:

```sh
twingate setup
```

Then turn the switch on. It starts the daemon, connects, and opens the sign-in
page in your browser.

## Features

- Shows Twingate connection state in the bar
- One switch: connects, disconnects, and starts the daemon when needed — in a
  single terminal run under one sudo prompt
- Opens the sign-in page for you when authentication is needed
- Offers to start Twingate at boot (the unit ships disabled on Arch)
- Browses your authorized resources from `twingate resources`
- Click a resource to copy its address; the row confirms
- Left click opens a keyboard-friendly panel

## Keyboard shortcuts

Inside the panel:

- `↑` / `↓`: move cursor
- `enter` / `c`: copy the selected resource's address
- `o`: open the selected resource in a browser
- `t`: toggle the connection
- `r`: refresh
- `esc`: close

On the bar icon: left click opens the panel, right click toggles the
connection, middle click refreshes.

## Requirements

- `twingate` CLI on `PATH`
- Omarchy 4 (Quattro) or newer
- `wl-copy` for clipboard actions

## Settings

```sh
omarchy bar set veepee.twingate refreshIntervalSec 30
omarchy bar move veepee.twingate --section right
```

| Key | Default | Values |
|---|---|---|
| `refreshIntervalSec` | `10` | `5`–`3600` |
| `visibility` | `always` | `always`, `when-online`, `when-installed` |
| `resourceScope` | `default` | `default`, `all` (include hidden resources) |

## What it runs on your machine

Nothing privileged runs on its own. Every `sudo` happens in a floating
terminal where you type the password and can read what happened.

**Headless, on a timer:** `which twingate`, `twingate status -d`,
`twingate status -v -d` (only while authenticating), `twingate resources -d`
(only while the panel is open).

**In a terminal, only when you act:** `twingate start`, `twingate disconnect`,
`sudo twingate service-start`, and `sudo systemctl enable twingate.service`
(only if you say yes).

**The plugin never installs software.** It can copy an install command to your
clipboard; running it is yours.

**Also:** `omarchy-launch-browser` to open a sign-in page or a resource, and
`wl-copy` to copy an address.

## Updating

```sh
omarchy plugin update veepee.twingate
```

It shows you the diff, asks before applying, and rolls back automatically if
the new version fails validation.

## Removing

```sh
omarchy plugin remove veepee.twingate
```

Or **Setup → Plugins → Remove Plugin**. The Twingate client itself is
untouched.

## Troubleshooting

```sh
omarchy-shell veepee.twingate diagnostics          # full state as JSON
qs -p /usr/share/omarchy/shell log | grep twingate  # what the plugin logged
```

`diagnostics` reports whether the CLI was found, the state it parsed, the last
error it saw, and the settings in effect — enough to explain most problems
without reading the source.

## Icon

Renders a gateway natively in the theme colour: solid when connected, a hollow
arch when not, with a dot when the plugin cannot do its job. Deliberately not
a reproduction of, nor a lookalike of, Twingate's brand mark.

## Notes

Design rationale, CLI quirks worth knowing, and the measured findings behind
several decisions: [docs/NOTES.md](docs/NOTES.md).

## Trademark

Twingate is a trademark of Twingate Inc. This is an unofficial,
community-built plugin and is not affiliated with, endorsed by, or supported
by Twingate Inc.

## Licence

MIT — see [LICENSE](LICENSE).
