# Twingate for Omarchy

Twingate Zero Trust client status, connect/disconnect, and authorized resource
browsing in the Omarchy bar.

![The Twingate panel](preview.png)

## Install

```sh
omarchy plugin add https://github.com/vpontual/omarchy-twingate.git --enable
```

Requires Omarchy 4 (Quattro) or newer, and the Twingate client.

Twingate publishes an Arch package directly. Order does not matter: install
this plugin first and the panel offers an **Install Twingate client** button,
or do it yourself:

```sh
url=https://binaries.twingate.com/client/linux/ARCH/x86_64/stable/twingate-amd64.pkg.tar.zst
curl -fLO "$url" && sudo pacman -U twingate-amd64.pkg.tar.zst
```

On `aarch64` use `.../aarch64/stable/twingate-arm64.pkg.tar.zst`. The plugin
drives the official `twingate` CLI; it does not replace or bundle it.

**Download first, then install the local file** — do not hand the URL straight
to `pacman -U`. Given a URL, pacman applies `RemoteFileSigLevel`, which Arch
leaves at `Required`, and Twingate publishes no detached signature: the
install fetches all 10 MiB and then dies on

```
error: failed retrieving file 'twingate-amd64.pkg.tar.zst.sig' : 404
```

A local file is governed by `LocalFileSigLevel`, which Arch ships as
`Optional`, so the same package installs.

Worth stating plainly: Twingate publishes **no signature and no checksum** for
this file, so HTTPS to their domain is the only integrity guarantee you get.
That is also true of the AUR packages — their pinned hashes are computed by a
volunteer from the same unauthenticated download, and one of them is currently
wrong.

### Why not the AUR

That file **is already a pacman package** — it carries `.PKGINFO`, `.MTREE`
and `.INSTALL`, and its `pkgname` is `twingate`. Both AUR packages amount to
unpacking it and packing it again, and as of 2026-08-25 both introduce a bug
the original does not have:

| | `twingate` | `twingate-bin` |
|---|---|---|
| Ships `/usr/bin/twingate-classic` | yes | **no** |
| Checksum currently valid | **no** | yes |
| Symptom | `yay -S` fails its validity check | installs fine, then disconnect dies with `sudo: twingate-classic: command not found` |
| Reported upstream | yes — 2026-07-10, confirmed 2026-07-13, unfixed | **no comments at all** |

`twingate` untars the whole vendor archive so it is functionally complete, but
its pinned `sha256` went stale on 2026-07-09 when Twingate republished the
**unversioned** `…/stable/…` URL — the bytes behind it change without the AUR
`pkgver` changing.

`twingate-bin` hand-lists the files it copies and omits `twingate-classic`,
which the client shells out to for privileged work. That is the exact failure
a commenter predicted on the AUR in June 2025, asking for the whole archive to
be extracted rather than selected files.

**The trade-off of going direct:** pacman does not track updates for a `-U`
install, so re-run the command to upgrade. Update integration was the only
thing the AUR was buying, which is a poor trade against two broken packages.
If both are fixed, the AUR becomes the better route again.

### Didn't enable it during install?

Omarchy prints `Enable it later with: omarchy plugin enable <id>`. You do not
need to remember that — it is under **Setup → Plugins → Enable Plugin**, listed
by name as *Twingate*.

## Use

| Action | Result |
|---|---|
| The switch | Connect or disconnect — starting the daemon first if needed |
| Click the bar icon | Open the panel |
| Right-click the bar icon | Connect or disconnect |
| Middle-click the bar icon | Refresh |
| `t` / `r` / `c` | Toggle / refresh / copy the selected resource address |
| Click a resource | Copy its address |
| `↑` `↓` then `Enter` | Move through resources, copy the selected one |
| `c` / `o` | Copy the selected address / open it in a browser |

**The switch is the only connection control.** There is no Disconnect button
beneath it, because that is what the switch does. Turning it on with the
daemon stopped starts the daemon *and* connects, in one terminal run — a
switch that only got you halfway and then sprang back to off would read as
broken.

Stopping the daemon outright is a different, rarer thing: it leaves the widget
badged as a problem rather than simply off. It is a plain text link at the very bottom of
the panel, below the whole resource list — deliberately not a button, and
deliberately not near the switch, because people reach for "off for now"
there. From a terminal it is `sudo twingate service-stop`.

The bar icon is a gateway: **solid when connected, a hollow arch when not**,
with a dot inside it when the CLI is missing, the daemon is stopped, or the
state is unrecognised. The two states differ in mass rather than in detail —
an earlier version signalled "shut" with a thin bar across a square gate,
which at 22px left the pair reading as the letters Pi and A.

**Clicking a resource copies its address**, which is useful whatever the
resource turns out to be. Opening one in a browser is `o`, deliberately an
opt-in.

That is not timidity — the CLI gives no way to know which resources are web
services. The table has four columns (`NAME`, `ADDRESS`, `ALIAS`,
`AUTH STATUS`) and no port or protocol, and a Twingate resource is just as
likely to be an SSH host, a database or an RDP target. Measured on a real
network: of eight resources, two were web hostnames, one a wildcard with no
single address, and the rest bare IPs reached over SSH. Opening
`https://10.0.153.99` on an SSH host only produces a browser error, so that
is not what a click does.

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

## First-time setup

1. **Install the plugin** (above). The gate icon appears in the bar
   immediately — no restart, no logout.
2. **Install the client**, if you have not: the panel's **Install Twingate
   client** button, or the `pacman -U` command above.
3. **Point the client at your network**, once: `twingate setup`.
4. **Start the service and sign in**: the panel's **Start service** then
   **Connect** buttons, or `sudo twingate service-start` and `twingate start`.
   Both open a terminal — see below for why.

Only step 3 is genuinely manual: the plugin cannot know your network name.
Steps 2 and 4 are buttons, and the browser sign-in persists, so day to day it
is one click on **Connect**.

### Starting at boot

`twingate.service` ships **disabled on Arch and stays that way**, so without
intervention every reboot lands you back on *Service stopped*.

That is a packaging bug, not a choice: the AUR package's `.install` hook is
Twingate's Debian `postinst`, and its `systemctl preset` call sits inside a
block gated on `$1 = "configure"` — a dpkg argument. On Arch `$1` is the
version string, so the block never executes and the unit is never preset.

**Start service** therefore offers to fix it, once, right after the service
starts — the moment sudo is already authenticated, so saying yes costs no
extra prompt. It only asks while the unit is actually disabled, and it
**defaults to No**: enabling a system unit at boot is a persistent change to
the machine and should never happen because someone pressed Enter out of
reflex. Declining prints the command so the choice stays recoverable.

### Signing in

Turning the switch on opens the sign-in page for you when one is needed.

`twingate start` prints a sign-in URL but does not reliably launch a browser,
and the URL scrolls away with the terminal, so the switch reads it back from
`twingate status --verbose` and opens it itself. No extra buttons.

The browser opens on the *transition* into authenticating — an authentication
that begins while the plugin is watching. A session already pending when the
shell starts is left alone: reopening someone's hours-old login in a browser
they did not just ask for is worse than making them press **Connect**.

A pending authentication expires after roughly five minutes and takes the
daemon down with it; the panel falls back to *Service stopped*.

What the panel shows as you go:

| Panel says | Meaning |
|---|---|
| `NOT INSTALLED` | No `twingate` on `PATH` |
| `SERVICE STOPPED` | Daemon down — turn the switch on |
| `DISCONNECTED` | Daemon up, signed out — turn the switch on |
| `AUTHENTICATING` | Waiting on your browser |
| `CONNECTED` | Resources listed; click one to copy its address |

Every state except `CONNECTED` carries a one-line explanation. `CONNECTED`
deliberately does not: the plugin knows only that `twingate status` returned
`online`, which is **not** the same as any given resource being reachable —
that depends on the connector, the host, and the path between them. The
resource list is the honest answer to what you have.

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

### Auth status

The CLI's `AUTH STATUS` column reports the **authorisation for a resource** —
not the client session and not the daemon. A Twingate resource can carry a
re-authentication policy, so access to it lapses after a set period.

**A countdown is never displayed.** "Auth expires in 4 days" is true, but
there is no action attached to it: when the authorisation lapses you turn the
switch on, the sign-in page opens, and you sign in — the ordinary flow, not a
special one. There is no "re-authenticate now" to offer, so knowing four days
in advance changes nothing you would do.

A status that is *not* a countdown is shown, because it explains a failure
rather than predicting one. "Auth required" or "Expired" means a resource is
unreachable right now, and that answers "why can I not reach this?" even
though the remedy is the same sign-in. `twingate auth <resource>`
re-authenticates a single locked resource.

Anything this plugin does not recognise is shown rather than hidden: only the
countdown shape is suppressed.

### Resource table format

`twingate resources` output is **tab-separated and additionally space-padded**
to column widths, which makes it look space-aligned and is a trap:

```
RESOURCE NAME       <TAB>ADDRESS            <TAB>ALIAS<TAB>AUTH STATUS
Docker VM           <TAB>10.0.153.99        <TAB>-    <TAB>Auth expires in 4 days
Jellyfin            <TAB>jellyfin.casavp.com<TAB>-    <TAB>Auth expires in 4 days
```

Splitting on runs of two or more spaces works until a value exactly fills its
column and is followed by a lone tab — as `jellyfin.casavp.com` does above.
The parser therefore splits on the tab and trims the padding. Verified against
a live connected client on 2026-08-25.

### Where the panel appears

The popup is positioned by Omarchy's own `KeyboardPanel`: centred on the
widget's bar icon and clamped to the screen edge. That is `readonly` in the
shell component, so it is not something a plugin chooses — every native panel
behaves identically. If you want the popup further right, move the widget
further right in the bar and the popup follows:

```sh
omarchy bar move io.github.vpontual.twingate --section right
```

The panel uses the same content width as Omarchy's own Wi-Fi panel.

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
