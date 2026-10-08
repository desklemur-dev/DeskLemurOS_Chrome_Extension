# Chrome Web Store submission notes

Paths such as `scripts/` and `core/` below belong to the full DeskLemurOS app
source checkout, not this standalone extension repository. See
[README.md](README.md) for the development and packaging steps.

Working text for the Developer Dashboard. Not part of the package:
`scripts/package_browser_extension.py` ships an allowlist of files and this is
not on it.

Everything below has to stay true. If the extension gains a permission or a
capability, the matching answer here changes with it — a justification that no
longer matches the code is a rejection reason on its own.

## Package

```bash
python scripts/package_browser_extension.py
```

Upload `target/browser_extension/desklemuros-browser-bridge-<version>.zip`.
The builder removes `key` from the manifest; the published item's ID is assigned
by the store.

## Store listing tab

**Category:** Productivity → Tools (or Workflow & Planning)

**Description**

> DeskLemurOS Browser Bridge connects this browser to the DeskLemurOS desktop
> app on the same computer.
>
> When you enable it in DeskLemurOS, the app can open a web page in a background
> tab of this browser, read the page's content, and close the tab again. That
> lets DeskLemurOS read pages and search results the way you see them, instead
> of through a separate automated browser.
>
> What it does not do: it cannot read tabs you opened yourself, it opens only
> http and https pages, and it runs a fixed set of commands — the app cannot
> send it code to execute.
>
> The extension contacts no server. It talks only to the DeskLemurOS app on
> your computer, through Chrome's Native Messaging.
>
> Requires the DeskLemurOS desktop app. Without it, the extension does nothing.

**Images to prepare** (the store requires all three):

| Asset | Size | Status |
| --- | --- | --- |
| Extension icon | 128×128 PNG, inside the ZIP | done — `icons/icon128.png` |
| Small promo tile | 440×280 | to make |
| Screenshot (1–5) | 1280×800 or 640×400 | to make — the popup showing "Connected to DeskLemurOS" beside the app's Policy dialog is the natural one |

## Privacy tab

**Single purpose**

> Lets the DeskLemurOS desktop app on the same computer open web pages in this
> browser and read their content.

**Permission justifications**

| Permission | Justification |
| --- | --- |
| `nativeMessaging` | The extension's only communication channel. It exchanges messages with the DeskLemurOS desktop app installed on the same computer. No network connection is made. |
| `scripting` | Reads the visible text (`document.body.innerText`) or the markup (`document.documentElement.outerHTML`), plus the title and URL, of a tab that the extension itself opened at the app's request. The markup is used to pick search results out of a results page. The injected functions are part of the extension package; no code is received at runtime. |
| `storage` | Uses `chrome.storage.session` to remember which tab IDs the extension opened, so it never reads or closes a tab the user opened. Nothing is stored persistently. |
| `alarms` | Retries the connection to the desktop app every 30 seconds while it is not running. A Manifest V3 service worker cannot keep a timer alive on its own. |
| Host permissions `http://*/*`, `https://*/*` | The user's app decides which page to open, so the address is not known in advance. Access is used only on tabs the extension opened; it does not read or modify any other tab. |

`tabs` is deliberately **not** requested. Host permissions already expose the
URL and title of the pages the extension opens, and the store rejects
permissions an extension does not need.

**Remote code:** No. All code is in the package.

**Data usage**

- Collected: **Website content** — the visible text or markup, title, and URL
  of pages the extension opens at the app's request.
- Not collected: personally identifiable information, health, financial,
  authentication, personal communications, location, web history, user activity.
- Certify all three limited-use statements. They are true as long as the page
  text goes only to the user's own DeskLemurOS installation.

**Privacy policy URL** — required, and has to be hosted by the publisher. It
must say, accurately:

1. What is read: the text or markup, title, and URL of pages DeskLemurOS asks
   the extension to open, including search-result pages. Pages load with the
   user's signed-in sessions, so a search made this way is made as the user and
   may appear in their search history with that provider.
2. Where it goes: only to the DeskLemurOS app on the same computer. The
   extension sends nothing to the publisher or to any server.
3. What DeskLemurOS then does with it: the text is given to the AI model the
   user configured. **If that model is a cloud service, the page text is sent to
   that provider.** Do not write "nothing leaves your computer" — it is true of
   the extension, not of every DeskLemurOS configuration.
4. That it is off until the user enables it in DeskLemurOS, and how to turn it
   off or remove it.

## Test instructions (for the reviewer)

The reviewer cannot exercise the extension without the desktop app. Give them a
way to get it, or the review has nothing to verify.

> This extension is a companion to the DeskLemurOS desktop app and has no
> function without it.
> 1. Install DeskLemurOS from <download URL>.
> 2. In DeskLemurOS: Tools → websurfing → Policy → "Register with Chrome", then
>    "Enable".
> 3. Click the extension's toolbar button. Its popup shows "Connected to
>    DeskLemurOS". (Before step 2 it shows "Not set up in this browser", and
>    with DeskLemurOS closed, "DeskLemurOS is not reachable".)
> 4. Ask DeskLemurOS to read a JavaScript-heavy page. A background tab opens,
>    is read, and closes.

## After the first upload

The dashboard assigns the item ID as soon as the draft is uploaded, before
review. Then:

1. Dashboard → Package → **View public key**. Put that key (one line, no
   header/footer) in `manifest.json` → `"key"`, replacing the development key,
   so the unpacked copy and the published item share one ID.
2. Set `DEV_EXTENSION_ID` in `core/browser_bridge.py` to the item ID.
   `core/test_browser_bridge.py` fails until the two agree.
3. Users must run "Register with Chrome" again after updating DeskLemurOS: the
   native host manifest lists the allowed extension IDs, and the Policy dialog
   reports the old registration as needing to be redone.
