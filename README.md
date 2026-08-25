# Twingate for Omarchy

Twingate Zero Trust client status, connect/disconnect, and authorized resource
browsing in the Omarchy bar.

![The Twingate panel](preview.png)

## Install

```sh
omarchy plugin add https://github.com/vpontual/omarchy-twingate.git --enable
```

Requires Omarchy 4 (Quattro) or newer, and the Twingate client.

Twingate ships no Arch package of its own — the client lives in the AUR. Order
does not matter: install this plugin first and the panel offers an **Install
Twingate client** button, or do it yourself:

```sh
omarchy pkg aur add twingate-bin      # or: yay -S twingate-bin
```

The plugin drives the official `twingate` CLI; it does not replace or bundle
it.

### Why `twingate-bin` and not `twingate`

Both AUR packages install the same client from the same place. They differ only
in whether their pinned checksum is currently correct — and **as of
2026-08-25 `twingate`'s is not**.

Both fetch an **unversioned** upstream URL:

```
https://binaries.twingate.com/client/linux/ARCH/x86_64/stable/twingate-amd64.pkg.tar.zst
```

Because `…/stable/…` has no version in the path, the file behind it changes
whenever Twingate publishes — **without the AUR `pkgver` changing**. Every
PKGBUILD that has not been re-pinned since then starts failing its integrity
check. That is what happened here: `twingate` was pinned on 2026-07-08,
upstream republished on 2026-07-09, and it was never re-pinned.
`twingate-bin` was corrected on 2026-07-29.

Neither package declares `provides`/`conflicts`, so do not install both — they
would collide on `/usr/bin/twingate`.

### Independent verification

This is a point-in-time observation, not a standing guarantee. It is recorded
so you can see what was checked, and repeated occasionally — but **it is not a
promise to audit every release, and it does not carry forward to any version
other than the one named.**

Checked **2026-08-25** against AUR `pkgver=2026.188.6692-1`:

| What | Result |
|---|---|
| `makepkg --verifysource`, `twingate-bin` | **Passed** |
| `makepkg --verifysource`, `twingate` | **FAILED** — stale checksum |
| Upstream host | `binaries.twingate.com` over HTTPS — Twingate's own domain |
| Tarball | 10,473,309 bytes, `sha256 7b1a3fc6ada23940d6df45d2521143d46ceb0c91797c0959c4621656f7d25ae1` |
| PKGBUILD `prepare()` / `build()` | None. `package()` only untars the vendor archive |
| Extra network calls in the PKGBUILD | None |
| `.install` root hook | Twingate's Debian `postinst`, transplanted. On Arch its `$1` is a version string and never `"configure"`, so the body does not execute. No network, no writes outside systemd unit dirs |

**What this does not cover:** the Twingate client is proprietary and ships as a
prebuilt binary. Verifying the PKGBUILD proves the packaging is honest about
what it fetches and where from. It says nothing about the contents of the
binary, which cannot be audited from source by anyone outside Twingate.

**Check it yourself in about a minute** — this is more useful than trusting the
date above:

```sh
git clone https://aur.archlinux.org/twingate-bin.git
cd twingate-bin
cat PKGBUILD *.install        # read what it does, and where it fetches from
makepkg --verifysource        # downloads and checks the sha256, builds nothing
```

If that reports `FAILED`, the pin has gone stale again — try the other package,
or open an issue on the AUR page so the maintainer re-pins. **Do not reach for
`--skipinteg`**: the pinned checksum is the only integrity control on a
proprietary binary from an unversioned URL, and skipping it removes the entire
point of the exercise.

### Didn't enable it during install?

Omarchy prints `Enable it later with: omarchy plugin enable <id>`. You do not
need to remember that — it is under **Setup → Plugins → Enable Plugin**, listed
by name as *Twingate*.

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

## First-time setup

1. **Install the plugin** (above). The gate icon appears in the bar
   immediately — no restart, no logout.
2. **Install the client**, if you have not: the panel's **Install Twingate
   client** button, or `omarchy pkg aur add twingate-bin`.
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

### If the browser does not open

`twingate start` prints a sign-in URL but does not reliably launch a browser,
and the URL scrolls away with the terminal. While authentication is pending
the panel therefore offers **Open sign-in page** and **Copy sign-in link** —
the latter for signing in from a phone.

The browser is opened automatically only for an authentication *this plugin
started*. A session begun from a terminal, or left pending from earlier, is
surfaced as buttons but never has its browser hijacked by a background poll.

Note that a pending authentication expires after roughly five minutes and
takes the daemon down with it; the panel falls back to *Service stopped*.

What the panel shows as you go:

| Panel says | Meaning |
|---|---|
| `NOT INSTALLED` | No `twingate` on `PATH` |
| `SERVICE STOPPED` | Daemon down — press **Start service** |
| `DISCONNECTED` | Daemon up, signed out — press **Connect** |
| `AUTHENTICATING` | Waiting on your browser |
| `CONNECTED` | Resources listed; click one to copy its address |

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
