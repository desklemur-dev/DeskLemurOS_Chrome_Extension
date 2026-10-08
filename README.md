# DeskLemurOS_Chrome_Extension

Chrome extension source for **DeskLemurOS Browser Bridge**. It connects Chrome
to a DeskLemurOS desktop app on the same computer so the app can open web pages,
read their content, and close the tabs it created.

The extension is installed separately from the desktop app. This directory
contains the browser extension only; the desktop app, native messaging host,
and app-side setup and packaging scripts are not included.

## Requirements

- Chrome 120 or later, as specified in `manifest.json`.
- A compatible DeskLemurOS desktop app and its registered native messaging host.
- The current app-side transport targets macOS and uses a Unix socket.
- Node.js is needed to run the extension's local test.
- Python 3.9 or later, Git, and GitHub CLI (`gh`) are needed for the publishing helper.

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

The command set is fixed. The extension does not execute code supplied by the
app, open non-HTTP(S) URLs, or read or close tabs outside its owned-tab list.

```text
DeskLemurOS app <-> Unix socket <-> native messaging host <-> Chrome extension <-> tabs
```

The connection to the desktop app uses Chrome Native Messaging. Chrome starts
the registered native host, which relays messages to the app's local socket.
The bridge does not open a TCP port.

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
non-HTTP(S) URLs, and rejection of unknown tabs and commands. Success prints
`service_worker.js: ok`.

## Publish changes to GitHub

This repository is maintained at `desklemur-dev/DeskLemurOS_Chrome_Extension`.
The publishing helper is configured for this private repository and its `main`
branch. Use its HTTPS `origin` URL; Git network operations use the same GitHub
CLI account checked by the helper. It does not publish to the Chrome Web Store.

From this extension directory, check the files and preview the changes:

```bash
python3 publish.py
```

To validate, commit changes, and push them:

```bash
python3 publish.py --push -m "Describe the extension changes"
```

Use the same command again if a previous push failed; an existing local commit
can be pushed without creating another commit. The helper checks the extension
files, runs the service-worker test, checks the repository and authenticated
account, and checks the remote branch before publishing. It stops on unexpected
files, pre-staged changes, or a remote branch that needs reconciliation. It
never force-pushes or changes your global Git or GitHub login settings.

The active GitHub CLI account must be `desklemur-dev`. If needed, switch to
that already-authenticated account before publishing:

```bash
gh auth switch --hostname github.com --user desklemur-dev
```

You can check the publishing helper itself with:

```bash
python3 -m unittest -v test_publish
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
| `popup.html`, `popup.js` | Connection status and reconnect controls. |
| `icons/` | Extension icons. |
| `test_service_worker.cjs` | Local service-worker regression test. |
| `publish.py` | Validate changes and publish them to the configured private GitHub repository. |
| `test_publish.py` | Regression tests for the publishing helper. |
| `STORE_LISTING.md` | Draft Chrome Web Store submission notes. |

## Contribution notes

- Request only permissions used by the extension, and update the corresponding
  explanations in `STORE_LISTING.md` when capabilities change.
- Keep source readable. Do not add obfuscated code or runtime-loaded scripts,
  `eval`, or `new Function`. Add capabilities as named commands.
- Route owned-tab changes through `changeOwnedTabs` to preserve concurrent
  storage updates, and run `node test_service_worker.cjs` after changes.
- Keep `HOST_NAME`, `PROTOCOL_VERSION`, and the method list aligned with
  `core/browser_bridge.py` in the app source. Run the app-side tests there.
- The public `key` field in `manifest.json` determines the unpacked extension
  ID. Coordinate ID changes with the app's allowed-extension registration; do
  not substitute a private signing key.
- Check third-party code licenses before introducing dependencies.

Windows support requires an app-side named-pipe transport and registry setup.
Other browsers need their own native-host registration locations.
