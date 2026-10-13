# Changelog

## 0.2.0 — 2026-10-13

### Added

- Interactive browsing in tabs opened by DeskLemurOS: click controls, fill fields, select options, press Enter or Escape, scroll, navigate, and go back.
- Task-owned browser sessions and bounded page snapshots with element references.
- Checks for stale snapshots, changed elements, disabled controls, obscured targets, and unsupported actions.
- Before-and-after snapshot information to distinguish dispatched actions from observed page changes.
- A GitHub repository link in the extension popup.
- Regression tests for session ownership, reload behavior, DOM interaction, and ordinary HTTP pages.

### Changed

- Updated the popup, README, and store listing to describe interactive browsing through the app's single `websurfing` tool.
- Kept interactive sessions separate from temporary page-reading tabs and included them in disconnect cleanup and reload checks.
- Updated platform transport documentation.

### Compatibility and limitations

- Interactive operations require an updated DeskLemurOS desktop app with interactive `websurfing` support and Browser Bridge enabled.
- Existing one-shot page-reading commands remain available. The app's extension-free search and page-reading fallback paths are unchanged.
- Native messaging protocol version remains 1; interactive support is advertised through a capability flag. No new Chrome permissions are requested.
- Interaction supports ordinary controls in the main document. Frames, shadow DOM, canvas interaction, native dialogs, multiple-selection fields, and trusted input events are not supported.
- A dispatched action does not prove that a website completed it. Inspect a fresh snapshot after a lost reply instead of blindly repeating an action.
