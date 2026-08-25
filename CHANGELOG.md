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
- 72 tests, no dependencies.

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
  integrity control in the chain. Bumping the client means bumping the version
  and both architectures' digests together.
- **Tenant-controlled data is bounded and never rendered as markup.** Resource
  names and addresses are set by whoever administers the Twingate network, so
  every `Text` uses `Text.PlainText`; each CLI buffer is clamped where it is
  read, so every parser downstream inherits the bound; the list is capped, and
  a list shortened by either the row cap or the input clamp says so rather
  than presenting the short count as the total. Invisible characters —
  including the bidi controls that make `invoice\u202Egnp.exe` read backwards,
  and the separators Qt would turn into line breaks — are stripped before a
  name is displayed or copied.
- **The sign-in URL is anchored to its own label.** It is opened in a browser
  with no user action, so it is taken only from the CLI's full sign-in
  sentence and only from that sentence's immediate vicinity — earlier output
  cannot volunteer a different URL for the plugin to open.
- **Terminal launches carry a wall-clock floor.** Anything running as this
  user can spawn a terminal directly, so this is not a privilege boundary; it
  bounds a looping or buggy caller of the IPC verbs rather than letting each
  call open another window sitting at a sudo prompt.
- **Auth countdowns are not displayed.** They carry no action a user can take
  that differs from ordinary use. Statuses that explain a current failure are
  shown.
