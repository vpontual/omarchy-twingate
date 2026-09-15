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

## Why connect and disconnect use pkexec

`twingate connect`, `disconnect`, `start` and `stop` re-invoke `sudo`
themselves, and `twingate start` is interactive beyond that — it asks the
operator to press enter. The Omarchy shell runs commands without a controlling
terminal, so running them from the panel directly fails:

```
sudo: a terminal is required to read the password; either use the -S option
      to read from standard input or configure an askpass helper
```

Version 0.1.0 therefore handed every state-changing command to a floating
terminal. 0.2.0 runs connect and disconnect as `pkexec /usr/bin/twingate …`
instead. pkexec elevates the whole command up front through the desktop's
polkit agent (Omarchy ships one, with password and fingerprint), so the CLI's
inner `sudo` is root-to-root and never prompts. Measured on 2026-09-15 with no
TTY: `pkexec twingate connect` from a stopped daemon printed "Starting Twingate
service" and `twingate status` read `online` within ten seconds;
`pkexec twingate disconnect` returned the client to `not-running` in three.
A connect starts the daemon itself, so there is no separate start-service step.

**Why not `systemctl start|stop twingate.service`?** systemd's
`manage-units` action is `auth_admin_keep`, which suggests one prompt could
cover several toggles. Measured on Omarchy on 2026-09-15, it does not: a start
and a stop 46 seconds apart each raised a fingerprint prompt, and polkit's
agent log shows two separate authentications. The start did connect (online
within six seconds), so the approach works — it just asks as often as pkexec
does, and pkexec runs Twingate's own `connect` and `disconnect`, which is what
the CLI documents.

pkexec exits **126** when the prompt is dismissed. The plugin treats that as a
choice, not a failure: the switch returns to where it was and nothing is
reported. Omarchy's own Tailscale panel uses pkexec the same way.

**Sign out goes through pkexec too, and answers a question.** Measured on
2026-09-15: `twingate account logout` first asks "This will log out the
account … Are you sure? [y/N]" and reads standard input, then runs
`sudo twingate-classic service-stop --purge`. Quickshell gives child processes
an input pipe that never closes, so the first version sat at that question
until its 300-second deadline; with the question answered, the inner `sudo`
tried the fingerprint reader for 30 seconds with no dialog on screen and
failed. The plugin now runs `pkexec twingate account logout -d` with `y` as
its input, and every other command it runs reads an empty input, so a
question it does not expect ends at once instead of waiting.

Signing out ends the session, not the account: `twingate account` still
names the account afterwards, and the next connect goes through the browser
sign-in again (verified: the sign-in page opened by itself and the client
came back online).

A deadline kill does not arrive as exit code 137. `timeout` ends the wrapper
with SIGKILL, and Quickshell reports a killed process as a crash carrying the
bare signal number, 9; the handler converts it to the shell's 128 + signal
before deciding what to say.

Two commands still open a terminal, because their output has to be read:
installing the client, and `twingate auth` for a single locked resource, which
prints the sign-in link.

**This plugin deliberately does not ask you to add a NOPASSWD sudoers rule.**
It would let any process running as your user start or stop the tunnel
without you present, which is the wrong trade for a Zero Trust client.

### Boot behaviour

Twingate stays off after a reboot unless you configured it otherwise, and the
plugin does nothing to change that.

Version 0.1.0 offered to `systemctl enable twingate.service`, on the theory
that the unit being disabled was what left you disconnected after a reboot.
That was wrong. Measured on 2026-09-15: with the unit enabled, `twingated`
started at boot, and the client stayed off because Twingate's own autostart
setting (`/etc/twingate/autostart.conf`) was `0`. Whether the client connects
at boot is that setting, not the unit, so the offer is gone.

### Auth status

The CLI's `AUTH STATUS` column reports the **authorisation for a resource** —
not the client session and not the daemon. A Twingate resource can carry a
re-authentication policy, so access to it lapses after a set period.

**A countdown is never displayed.** "Auth expires in 4 days" is true, but
there is no action attached to it, so knowing four days in advance changes
nothing you would do.

**"Not authenticated" gets an Authenticate button.** It is the CLI's exact
wording for a resource with its own authentication policy that you have not
signed in to yet (the two shapes the binary prints are that and the
countdown). The button runs `twingate auth -- <resource>` in a terminal,
because the command prints the link to open, and takes the place of the status
text on that row. The match is exact.

Any other status that is not a countdown is shown as text, including wording
this plugin does not recognise, because it explains a failure rather than
predicting one.

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
`KeyboardPanel`, `PanelHero`, `ToggleSwitch`, `Button`, `TextField`, `CursorSurface`,
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
`twingate auth -- <resource>` clears it.

## Working on it

```sh
npm test                      # 144 tests, no dependencies
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
