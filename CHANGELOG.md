# Changelog

All notable changes to q-sys-mcp are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Transparent auto-reconnect. On an unexpected socket drop (Core restart,
  leaving Emulate mode, a network blip) the client re-dials with exponential
  backoff and replays its logon + change-group registrations, so polling resumes
  without re-calling `qsys_connect`. In-flight and subsequent requests wait for
  the reconnect and retry once — drops are transparent to callers. On by
  default; opt out per connection with `reconnect: false` on `qsys_connect`.

### Changed

- Richer package description + expanded npm keywords, and added GitHub repo
  description + topics, for search and discoverability.

## [0.1.1] - 2026-06-22

### Changed

- No functional changes. First release cut through the GitHub Actions
  trusted-publishing pipeline (OIDC, no token) — published with build
  provenance. `0.1.0` was a manual bootstrap publish.

## [0.1.0] - 2026-06-22

### Added

- Initial release: an MCP server that controls Q-SYS over the QRC protocol
  (JSON-RPC 2.0 over TCP 1710), pointed at a real Core or at Q-SYS Designer in
  Emulate mode.
- 13 tools — connect, status, component/control discovery, get/set for both
  Named Controls and component controls (with ramps), change groups
  (create / poll / add-component / destroy), and disconnect.
- Response shaping (`filter`, `names_only`, `type`) to keep large designs from
  flooding an agent's context.
- Live-Core write warning and a 30 s NoOp keepalive.
- Cross-platform CI (Linux / macOS / Windows × Node 18 & 20) with a
  hardware-free test suite (mock QRC + in-memory MCP transport).

[Unreleased]: https://github.com/reowens/q-sys-mcp/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/reowens/q-sys-mcp/releases/tag/v0.1.1
[0.1.0]: https://www.npmjs.com/package/q-sys-mcp/v/0.1.0
