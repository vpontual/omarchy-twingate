# Changelog

## 0.1.0 — unreleased

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
- IPC: `open`, `close`, `toggle`, `refresh`, `connect`, `disconnect`,
  `toggleConnection`, `status`.
- Settings for refresh interval, bar visibility, and whether hidden resources
  are listed.
- 27 tests, no dependencies.

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
- **Auth countdowns are not displayed.** They carry no action a user can take
  that differs from ordinary use. Statuses that explain a current failure are
  shown.
