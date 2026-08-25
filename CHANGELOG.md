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
