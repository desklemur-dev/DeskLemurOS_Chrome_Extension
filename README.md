# DeskLemurOS_Chrome_Extension

Chrome extension source for **DeskLemurOS Browser Bridge**. It connects Chrome
to a DeskLemurOS desktop app on the same computer so the app can open web pages,
read their content, click controls, fill forms, navigate, and close the tabs it created.

The extension is installed separately from the desktop app. This directory
contains the browser extension only; the desktop app, native messaging host,
and app-side setup and packaging scripts are not included.

## Requirements

See [CHANGELOG.md](CHANGELOG.md) for version history and compatibility notes.

- Chrome 120 or later, as specified in `manifest.json`.
- A compatible DeskLemurOS desktop app and its registered native messaging host.
- A matching app build with interactive `websurfing` support is required for clicks, forms, and navigation.
- Node.js is needed to run the extension's local test.

## Install an unpacked copy

1. Download or clone this source and locate the directory containing
   `manifest.json`.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load
   unpacked**, and select that directory.
3. In DeskLemurOS, open **Tools → websurfing → Policy**, choose **Register with
   Chrome**, and enable the browser bridge.
4. Click the extension's toolbar button. The popup shows **Connected to
   DeskLemurOS** after the desktop app acknowledges the connection.

The extension needs the desktop app and native host to work. If the popup says
**Not set up in this browser**, register the host in DeskLemurOS. If it says
**DeskLemurOS is not reachable**, start the app and enable the bridge. The host's
registration must allow the ID of the extension installed in Chrome.

## What it can do

| Method | Effect |
| --- | --- |
| `open_url` | Opens an HTTP or HTTPS URL in a background tab and waits for it to load. |
| `read_page_text` | Returns the visible text of a tab the bridge opened. |
| `read_page_html` | Returns the markup of a tab the bridge opened, including search-result pages. |
| `close_tab` | Closes a tab the bridge opened. |
| `reload` | Reloads the extension so Chrome runs the files now in its folder, for example after an update. Refused with `busy` while the bridge has tabs open or other requests under way. Once accepted, every further request is refused with `reloading` until the reloaded extension reconnects. |
| `browser_open` | Creates a persistent, task-owned tab and returns its first snapshot. |
| `browser_snapshot` | Observes visible text and interactive elements with short reference IDs. |
| `browser_action` | Clicks, fills, selects, presses Enter/Escape, scrolls, navigates, or goes back; returns the resulting snapshot. |
| `browser_close` | Closes the interactive session's tab. |

In DeskLemurOS, select `websurfing` in Tool Control and enable Browser Bridge.
The same tool handles search, page reading, and explicit interactive operations;
there is no separate browser tool. Search and page reading also work without
this extension through the app's existing retrieval and browser fallback paths.
Interactive operations require the connected extension and never switch an
active session to a different browser.

The agent opens a session, uses the latest snapshot's references, checks the
state after each action, then closes the tab. Sessions are tied to one agent
invocation and one browser connection. They are cleaned up when the invocation
ends or the app disconnects. Reloading the extension ends existing sessions.

The first version supports ordinary controls in the main document. Snapshots
are bounded and prioritize viewport elements; scroll to expose more controls.
Frames, shadow DOM, canvas interaction, native dialogs, multiple-selection fields, and trusted
input events are not supported. DOM keyboard events are synthetic. A dispatched
action does not prove that a website accepted or completed it. After a lost
reply, inspect the current page instead of blindly repeating a submission.
Action replies also report `observed_state_changed` and `before_snapshot_id`.
An unchanged captured view does not rule out a remote side effect, and a null
comparison means the before/after view was unavailable.

The command set is fixed. The extension does not execute code supplied by the
app, open non-HTTP(S) URLs, or read or close tabs outside its owned-tab list.

```text
DeskLemurOS app <-> local transport <-> native messaging host <-> Chrome extension <-> tabs
```

The connection to the desktop app uses Chrome Native Messaging. Chrome starts
the registered native host. The app uses a Unix socket on macOS/Linux and an
authenticated loopback-only transport on Windows.

Pages opened by the bridge use the browser's normal signed-in sessions. The
extension sends their requested content to the local DeskLemurOS app; the app
may then send that content to the AI provider configured by the user. See
[STORE_LISTING.md](STORE_LISTING.md) for the draft data disclosures and reviewer
instructions.

## Run the extension test

From this directory:

```bash
node test_service_worker.cjs
```

The test uses Node.js built-in modules and a simulated Chrome API. No package
installation, running browser, desktop app, or native host is needed. It checks
concurrent tab ownership updates, reading and closing owned tabs, rejection of
non-HTTP(S) URLs, rejection of unknown tabs and commands, and that `reload`
answers before it reloads, is refused while bridge tabs are open or another
request is under way, and that nothing new starts once a reload is accepted,
so no tab can be left open by a reload. Success
prints `service_worker.js: ok`.

For DOM behavior, install Playwright and its Chromium browser in a development environment and run
`node test_browser_interaction.cjs`. It uses isolated test pages and checks
element references, form controls, scrolling, stale observations, and unsupported
targets. In a full app checkout, this additionally exercises the native host and
a disposable Chrome for Testing profile:

```bash
DESKLEMUR_BROWSER_E2E=1 python -m pytest core/test_browser_interaction_e2e.py
```

## Develop with the desktop app source

The following commands must run from a **full DeskLemurOS app source checkout**
containing `core/`, `rust_core/`, and `scripts/`. They do not run from this
standalone extension directory. Use matching app and extension versions.

```bash
cd /path/to/DeskLemurOS-app-source
(cd rust_core && cargo build -p desklemur-browser-host)
python scripts/browser_bridge_dev.py register
```

Load this extension directory through `chrome://extensions` as described above,
then run the demo from that same app source root:

```bash
python scripts/browser_bridge_dev.py demo https://example.com
```

The demo starts its own app-side bridge for development. Rust/Cargo and the
app's Python environment are required for these commands.

## Prepare a Chrome Web Store package

The packaging script belongs to the full app source checkout. It reads the
extension files specifically from that checkout's `browser_extension/`
directory, so synchronize the extension version to be packaged into that
directory first. From the app source root, run:

```bash
python scripts/package_browser_extension.py --check
python scripts/package_browser_extension.py
```

The script writes
`target/browser_extension/desklemuros-browser-bridge-<version>.zip`. It uses a
runtime-file allowlist, excludes the README, submission notes, and tests, and
removes the development `key` field from the packaged manifest.

[STORE_LISTING.md](STORE_LISTING.md) contains draft submission text and the
remaining publisher tasks, including store images, a privacy policy URL,
reviewer access to the app, and extension-ID registration after publication.
Uploading this source to GitHub does not publish it to the Chrome Web Store.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest V3 metadata, permissions, and extension entry points. |
| `service_worker.js` | Native messaging connection and fixed browser commands. |
| `browser_interaction.js` | Packaged DOM actions, snapshots, references and session ownership. |
| `popup.html`, `popup.js` | Connection status and reconnect controls. |
| `icons/` | Extension icons. |
| `test_service_worker.cjs` | Local service-worker regression test. |
| `test_browser_interaction.cjs` | Browser DOM interaction regression test. |
| `STORE_LISTING.md` | Draft Chrome Web Store submission notes. |

## Contribution notes

- Request only permissions used by the extension, and update the corresponding
  explanations in `STORE_LISTING.md` when capabilities change.
- Keep source readable. Do not add obfuscated code or remotely loaded scripts,
  `eval`, or `new Function`. Add capabilities as named commands.
- Route owned-tab changes through `changeOwnedTabs` to preserve concurrent
  storage updates, and run `node test_service_worker.cjs` after changes.
- Keep `HOST_NAME`, `PROTOCOL_VERSION`, and the method list aligned with
  `core/browser_bridge.py` in the app source. Run the app-side tests there.
- The public `key` field in `manifest.json` determines the unpacked extension
  ID. Coordinate ID changes with the app's allowed-extension registration; do
  not substitute a private signing key.
- Check third-party code licenses before introducing dependencies.

Each supported browser needs its own app-side native-host registration.

## License

This browser extension is licensed under the [MIT License](LICENSE).
The separately distributed DeskLemurOS desktop app has its own license.
