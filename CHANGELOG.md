# Changelog

## 0.1.0 — 2026-08-25

First working version.

### The plugin

- Bar widget showing Twingate state: connected, disconnected, authenticating,
  and CLI-not-installed, each distinct rather than a binary on/off.
- **One switch.** It connects, disconnects, and starts the daemon when that is
  needed, in a single terminal run under one sudo prompt. There is no separate
  Disconnect or Stop-service action, because on Linux there is nothing else to
  control — see below.
- Turning the switch on **opens the sign-in page** when one is needed.
  `twingate start` prints the URL but does not reliably launch a browser, and
  the URL scrolls away with the terminal.
- Offers, once, to **enable `twingate.service` at boot**. The unit ships
  disabled on Arch and stays that way. Defaults to No.
- **Resource list** with name and address on one line. Clicking a resource
  copies its address and the row confirms; `o` opens it in a browser.
- Keyboard navigation over the list, with `t`, `r`, `c` and `o`.
- IPC: `open`, `close`, `show`, `hide`, `toggle`, `refresh`, `connect`,
  `disconnect`, `toggleConnection`, `status`, `diagnostics`. The connect verbs
  report `ok`, `busy` or `not-installed` rather than always claiming success.
- **Install Twingate client**, which downloads a version-pinned package,
  verifies its SHA-256, and refuses to install on mismatch.
- Settings for refresh interval, bar visibility, and whether hidden resources
  are listed.
- 115 tests, no dependencies.

### Hardening after marketplace review

Two marketplace security reviews landed here, plus several independent
passes over the result. Almost every finding was the same shape — a bound
applied one step too late, or a claim that the code did not support — and they
are worth stating plainly rather than burying:

- **Process output is bounded at the producer, not at the read.** Quickshell's
  `StdioCollector` has no size limit of any kind, so an earlier build that
  clamped in `onExited` was clamping *after* the shell had already buffered
  whatever the CLI wrote. Each poll now runs through a wrapper that caps stdout
  and stderr independently with `head -c`, so a runaway CLI takes SIGPIPE
  instead of growing `omarchy-shell`. `pipefail` preserves the CLI's own exit
  code, which the handlers depend on.
- **The polled CLI runs with `BASH_ENV` and `ENV` cleared.** Non-interactive
  `bash -c` sources `$BASH_ENV` before it runs its script — measured, not
  assumed. Not a privilege boundary (anything that can set it already runs as
  this user), but the wrapper should not be a way to reach a shell it did not
  intend to.
- **A wedged wrapper has a hard deadline.** Quickshell's `running = false` signals
  the process it *tracks*, and Qt does not signal descendants — so once the
  poll ran inside a shell wrapper, a silently hung `twingate` survived every
  watchdog cycle. `timeout` now wraps **bash**, not the CLI, and sends SIGKILL
  to its process group at the deadline. Wrapping the CLI instead — which an
  earlier version of this entry described as the fix — only bounded a hanging
  leader: a CLI that forked a child and exited left it holding the pipe, and
  the wrapper hung indefinitely. A deliberately detached child is outside that
  process group and can still survive; containing one requires a cgroup rather
  than another shell signal, so that boundary is stated rather than hidden.
- **Clipping is detected by bytes, not string length.** `head -c` caps bytes;
  JavaScript string length counts UTF-16 code units, and they coincide only for
  ASCII. With non-Latin resource names a list cut from 150 rows to 115 was
  presented as complete. `wasClipped()` measures UTF-8 bytes.
- **stderr is never parsed as connection state.** `normalizeStatus` matches the
  state token as a prefix, so `online: failed to contact daemon` on stderr
  parsed as `online` — a failing command reporting a connected tunnel on the
  strength of its own error message.
- **The installer pins `PATH`.** `curl`, `sha256sum`, `sudo` and `pacman` were
  resolved through the inherited `PATH`, and a typical machine has several
  user-writable directories ahead of `/usr/bin`.
- **Fixed dependencies use fixed system paths.** The poll wrapper, vendor CLI,
  Omarchy launchers and clipboard tool no longer resolve through that inherited
  `PATH`. Clipboard content is passed directly to `wl-copy` as argv, so
  tenant-controlled text never reaches a shell.
- **The download is capped on the wire.** The SHA-256 pin fixes the byte count,
  but only once `curl` has finished writing. `CLIENT_BUILDS` now carries the
  exact published size and passes it to `--max-filesize`, with `--proto`,
  `--proto-redir` and `--max-redirs` so a redirect cannot change scheme or
  loop. Bumping the client means bumping the version, both digests **and** both
  sizes together — all three come from the same download.

### Things worth knowing

These were all measured against a real client rather than assumed, and each
one changed the design.

- **There is no disconnected-but-running state.** Both `twingate stop` and
  `twingate disconnect` — the latter documented as "Pause connections without
  clearing tokens" — exit the client and take `twingate.service` down. So the
  off state is labelled *Disconnected* and carries no warning badge: it is
  ordinary operation, not a fault.
- **Every state-changing command needs a terminal.** They re-invoke `sudo`
  themselves and `twingate start` is interactive beyond that. A NOPASSWD
  sudoers rule would not help and is deliberately not requested.
- **`twingate resources` is tab-separated *and* space-padded**, so splitting on
  runs of spaces breaks whenever a value exactly fills its column.
- **Install comes from Twingate directly**, not the AUR. The file Twingate
  publishes is already a pacman package; both AUR repackages are currently
  broken, in different ways.
- **The installed client is pinned by version and SHA-256**, and the digest is
  verified before `pacman` sees the file — a mismatch refuses to install. The
  URL carries an explicit version rather than the mutable `stable` path, and the
  digest is what actually guarantees the bytes. Twingate publishes no signature, so that digest is the only
  integrity control in the chain. Bumping the client means bumping the version,
  both architectures' digests and both sizes together.
- **Tenant-controlled data is bounded and never rendered as markup.** Resource
  names and addresses are set by whoever administers the Twingate network, so
  every `Text` uses `Text.PlainText`; each CLI buffer is bounded at the producer
  (see above) and clamped again at the read, so every parser downstream
  inherits the bound; the list is capped, and
  a list shortened by either the row cap or the input clamp says so rather
  than presenting the short count as the total. The named invisible classes —
  C0/C1, the bidi controls that make `invoice\u202Egnp.exe` read backwards,
  selected zero-width and word-joining ranges, the Hangul fillers, the
  invisible operators, the separators Qt would turn into line breaks, and the
  astral TAG characters — are stripped before a name is displayed or copied.
  That is a bounded list, not a complete `Default_Ignorable` policy, and
  deliberately not a confusables defence: homoglyphs render alike and no strip
  rule changes it.
- **The sign-in URL is anchored to its own label.** It is opened in a browser
  with no user action, so it is taken only from the CLI's full sign-in
  sentence and only from that sentence's immediate vicinity — earlier output
  cannot volunteer a different URL for the plugin to open.
- **Automatic browser opening is attributed to a connect action.** Install and
  disconnect use the same terminal launcher but cannot arm the browser. The
  marker is one-shot, time-bounded, and invalidated by a later terminal action
  or by the client disappearing.
- **Terminal launches carry a wall-clock floor.** Anything running as this
  user can spawn a terminal directly, so this is not a privilege boundary; it
  bounds a looping or buggy caller of the IPC verbs rather than letting each
  call open another window sitting at a sudo prompt.
- **Auth countdowns are not displayed.** They carry no action a user can take
  that differs from ordinary use. Statuses that explain a current failure are
  shown.
