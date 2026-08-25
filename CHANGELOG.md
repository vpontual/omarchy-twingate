# Changelog

## Unreleased

First working version.

- Bar widget showing Twingate state: connected, disconnected, authenticating,
  service stopped, and CLI missing, each as a distinct state rather than a
  binary on/off.
- Panel with a connect/disconnect toggle, a service stop action, and the
  authorized resource list; clicking a resource copies its address.
- Keyboard navigation over the resource list, with `t`, `r` and `c` shortcuts.
- IPC: `open`, `close`, `toggle`, `refresh`, `connect`, `disconnect`,
  `toggleConnection`, `status`.
- Settings for refresh interval, bar visibility, and whether hidden resources
  are listed.

Known limitation: `parseResources` is unit-tested against representative
output but not yet verified against a live connected client.

### Fixed before first release

- The "not installed" action opened `twingate.com/download`, which offers only
  `.deb` and `.rpm` — useless on Arch. It now installs the AUR package through
  `omarchy-pkg-aur-add`.
- That install targets `twingate-bin`, not `twingate`. Both AUR packages fetch
  the same unversioned upstream tarball, so a republish invalidates any pin
  that has not been refreshed; measured 2026-08-25, `twingate` failed
  `makepkg --verifysource` and `twingate-bin` passed.
- Turning the switch on opens the sign-in page when one is needed.
  `twingate start` prints the URL but does not reliably open a browser, and
  the URL scrolls away with the terminal, so the plugin reads it back from
  `twingate status --verbose`. Fires on the transition into authenticating, so
  a session already pending when the shell starts is left alone.
- **Start service** offers, once, to enable `twingate.service` at boot. The
  unit ships disabled on Arch because the package's Debian `postinst` hook
  never runs there. Defaults to No.
- Resource rows parse correctly. The table is tab-separated *and* space-padded;
  splitting on space runs broke whenever a value exactly filled its column,
  which showed auth status where an address belonged and fused long names into
  their addresses. Verified against a live connected client.
- A uniform auth status is stated once above the list instead of on all rows.
- Removed the Disconnect and Stop service buttons. The switch is the only
  connection control; stopping the daemon is a header icon.
- Clicking a resource copies its address; `o` opens it in a browser. Most
  Twingate resources are not web services and the CLI exposes no protocol, so
  opening is an opt-in rather than what a click does. Removed the "Open in
  terminal" action.
- Stopping the daemon is a text link at the foot of the panel, not a button.
- Panel width matches Omarchy's native Wi-Fi panel.
- Resource rows put the name and address on one line, name left and address
  right, instead of stacking them and leaving most of the panel empty.
- Removed the unexplained count pill from the header; the count is already
  stated in words.
- The shared auth status moved onto the Resources header, where it reads as a
  property of the list rather than of the count.
- The count folds into the section heading — `Resources (8)` — instead of
  spending a line restating it below the header.
- Auth countdowns are no longer displayed. They have no action attached — when
  authorisation lapses you turn the switch on and sign in, which is the
  ordinary flow. Statuses that explain a current failure ("Auth required",
  "Expired") are still shown.
- Removed "Private resources are reachable". The plugin knows only that
  `twingate status` returned `online`, which is not the same claim.
- The stop link is centred, so it reads as a footer rather than as another
  resource row, and only the text itself is clickable.
- The install action points at `twingate`, not `twingate-bin`. `twingate-bin`
  omits `/usr/bin/twingate-classic`, which the client shells out to, so
  disconnect fails with "sudo: twingate-classic: command not found". Both AUR
  packages are broken in different ways; the README documents both.
- The install action fetches Twingate's own Arch package with `pacman -U`
  instead of going through the AUR. The published file is already a pacman
  package; both AUR packages repackage it and both are currently broken.
- Redrew the bar icon. Connected is a solid gateway, disconnected a hollow
  arch, and the warning badge is a dot nested inside the opening.
- The install downloads the package before handing it to pacman. Given a URL,
  pacman requires a detached signature that Twingate does not publish, so the
  install died on a 404 after fetching the whole file.
- The CLI probe no longer latches. Installing the client while the plugin was
  running never took effect, so the panel showed "Not installed" above a live
  list of eight resources.
- Turning the switch off runs `twingate disconnect` rather than
  `twingate stop`. `stop` takes the daemon down despite its help text, so the
  switch was doing the same thing as the stop-the-daemon link.
