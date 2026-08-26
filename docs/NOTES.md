# Design notes

Why this plugin is built the way it is. None of this is needed to use it — see
the [README](../README.md) for that. It is kept because every item below was
measured against a real client, and each one changed the design.

## Why not the AUR

Twingate's published `.pkg.tar.zst` **is already a pacman package** — it carries `.PKGINFO`, `.MTREE`
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
install, and the plugin pins an exact version — so re-running the install
reinstalls the *same* build, not a newer one. The plugin is the update
gatekeeper: a new client ships when `CLIENT_VERSION`, both digests **and**
both sizes are bumped together, in one reviewable commit. All three values come
out of the same download, so there is no extra step:

```sh
V=<new-version>
for a in x86_64:twingate-amd64.pkg.tar.zst aarch64:twingate-arm64.pkg.tar.zst; do
  IFS=: read arch file <<<"$a"
  curl -fsSL -O "https://binaries.twingate.com/client/linux/ARCH/$arch/$V/$file"
  echo "$arch  sha256=$(sha256sum "$file" | cut -d' ' -f1)  bytes=$(wc -c < "$file")"
done
```

`bytes` is not a second integrity check — the digest already fixes the byte
count. It is a ceiling, passed to `curl --max-filesize`, because the digest
cannot say anything until curl has finished writing. A stale `bytes` refuses
the install before the transfer starts, which is loud and safe, but it does
mean the size cannot be skipped when bumping a version. To move faster than that, install a
newer version yourself.

That pinning is deliberate. A marketplace reviewer rejected an earlier build
for fetching the mutable `stable` path and running `sudo pacman -U` on it,
which let root-executed bytes change independently of the reviewed commit. An
unpinned install cannot be made safe; a stale pin can at least be seen.

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

### Starting at boot

`twingate.service` ships **disabled on Arch and stays that way**, so without
intervention every reboot lands you disconnected. This matters more than it
looks: since turning the switch off stops the daemon, the boot setting is the
only thing that decides whether Twingate is up when you log in.

That is a packaging bug, not a choice. The package ships an `.install` hook
that is Twingate's Debian `postinst`, and its `systemctl preset` call sits
inside a block gated on `$1 = "configure"` — a dpkg argument. On Arch `$1` is
the version string, so the block never executes and the unit is never preset.
This is true of Twingate's own package and of both AUR repackages alike.

**Turning the switch on therefore offers to fix it**, right after the service
starts — the moment sudo is already authenticated, so saying yes costs no
extra prompt. It asks whenever the unit is disabled, so declining today does
not stop it asking next time; saying yes stops it for good. It
**defaults to No**: enabling a system unit at boot is a persistent change to
the machine and should never happen because someone pressed Enter out of
reflex. Declining prints the command so the choice stays recoverable.

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
Docker VM           <TAB>192.0.2.10         <TAB>-    <TAB>Auth expires in 4 days
Jellyfin            <TAB>assets.example.test<TAB>-    <TAB>Auth expires in 4 days
```

Splitting on runs of two or more spaces works until a value exactly fills its
column and is followed by a lone tab — as `assets.example.test` does above.
The parser therefore splits on the tab and trims the padding. Verified against
a live connected client on 2026-08-25.

### Where the panel appears

The popup is positioned by Omarchy's own `KeyboardPanel`: centred on the
widget's bar icon and clamped to the screen edge. That is `readonly` in the
shell component, so it is not something a plugin chooses — every native panel
behaves identically. If you want the popup further right, move the widget
further right in the bar and the popup follows:

```sh
omarchy bar move veepee.twingate --section right
```

The panel uses the same content width as Omarchy's own Wi-Fi panel.

### The panel and the icon

The panel is built entirely from the shell's own primitives — `Panel`,
`KeyboardPanel`, `PanelHero`, `ToggleSwitch`, `Button`, `CursorSurface`,
`Style`, `Color` — rather than hand-rolled styling. That is what makes it match
Quattro's popover surface, border, spacing and focus behaviour exactly, and
track every Omarchy theme for free.

The icon is drawn from primitives instead of shipping an SVG, so it stays
crisp in a small bar slot and follows the theme foreground. Connected fills the
gateway solid; disconnected leaves it a hollow arch. The states differ in mass
rather than in detail, because at 22px that is what reads in peripheral
vision — an earlier version signalled "shut" with a thin bar across a square
gate and the pair read as the letters Pi and A.

## CLI output is not line-oriented

`twingate status` does not always terminate its state token with a newline.
When a resource requires per-resource re-authentication it writes the token
and then appends prose to the same line:

```
onlineA resource you attempted to access requires additional authentication.
Open the following URL to authorize access to the resource:

https://...
```

`normalizeStatus` therefore matches the token as a **prefix** of the first
non-blank line, longest candidate first so `offline` can never lose to
`online`. Requiring equality reported `unknown` — urgent badge, switch off,
and a panel telling the user the CLI said something unrecognisable — while
the client was in fact connected.

This is the same per-resource authorisation the `AUTH STATUS` column reports;
`twingate auth <resource>` clears it.

## Working on it

```sh
npm test                      # 102 tests, no dependencies
omarchy plugin validate .
omarchy plugin add "$PWD" --enable    # git clone accepts a local path
omarchy-restart-shell         # NOT omarchy-refresh-shell, which resets shell.json
```

`Model.js` holds every parser as a pure function precisely so it can be tested
without a running shell. `Service.qml` owns processes and state; `Panel.qml` is
presentation only.

Two traps worth knowing. `qmllint` exits 255 with no output on this codebase —
and on Omarchy's own shipped plugins — so treat it as a broken tool, not a
signal; verify with `omarchy plugin validate` plus an IPC call that returns live
state. And rsyncing into the installed plugin directory dirties that checkout,
after which `omarchy plugin update` refuses to fast-forward; follow any rsync
with `git -C <plugindir> fetch && git reset --hard origin/main`.
