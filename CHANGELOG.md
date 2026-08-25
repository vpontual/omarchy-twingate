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
