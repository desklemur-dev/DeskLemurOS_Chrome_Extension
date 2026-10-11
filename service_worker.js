// DeskLemurOS Browser Bridge — extension side.
//
// [DeskLemurOS] <-> native host (stdio relay) <-> this service worker <-> tabs
//
// This file is the whole extension. It is plain, unminified, dependency-free
// JavaScript on purpose: both extension stores refuse obfuscated code, and a
// bridge that can read pages in someone's logged-in browser should be readable
// by the person installing it.
//
// Three rules shape everything below.
//
//   1. A fixed command vocabulary. Manifest V3 forbids running code that
//      arrives at runtime, so DeskLemurOS can ask for one of the named methods
//      and nothing else — it can never send a script to execute.
//   2. Only http(s) pages, and only tabs this bridge opened itself. The app can
//      ask for a page to be opened and then read *that* page; it cannot reach
//      into a tab the user already had open.
//   3. The extension dials out; nothing listens. chrome.runtime.connectNative
//      starts the native host, and Chrome only lets extensions listed in that
//      host's manifest do so. There is no port for anything else to find.

const HOST_NAME = "com.desklemur.browser_bridge";
// Bumped only for a change the other side cannot ignore. The app compares it to
// its own and refuses a mismatch rather than guessing at a newer vocabulary.
const PROTOCOL_VERSION = 1;
const RECONNECT_ALARM = "desklemur-bridge-reconnect";
const OWNED_TABS_KEY = "bridgeTabs";
// A page's visible text. Far below the browser's own message limit; a page
// larger than this is almost certainly not something a reader wants whole.
const MAX_TEXT_CHARS = 4_000_000;
// A page's markup, for the app to parse search-result cards out of. Larger than
// the text cap because markup is mostly not text; still far below the browser's
// limit for a message to the native host.
const MAX_HTML_CHARS = 8_000_000;
// How long `reload` waits before reloading, so its reply reaches the app first.
const RELOAD_DELAY_MS = 200;

let port = null;
// Requests being handled right now, a reload's own included.
let inFlight = 0;
// Set once a reload is accepted. Nothing new is started after that: the reload
// ends this worker, and a tab opened in the meantime would be forgotten by it
// and left open in the user's browser.
let reloadScheduled = false;
// Tabs opened so far, so a reload that waited on storage can tell whether one
// was opened while it waited.
let tabsOpened = 0;
// What the popup shows. "connected" is set only when the app has answered:
// connectNative returns a port even when nothing is behind it, so an open port
// alone proves nothing.
//   state: "disconnected" | "connecting" | "connected" | "rejected"
//   detail: Chrome's own disconnect reason, or the app's rejection reason
let link = { state: "disconnected", detail: "", app: null };

function setLink(state, detail = "", app = null) {
  link = { state, detail, app };
}

class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ── Connection ───────────────────────────────────────────────────────

function connect() {
  if (port) return;
  let candidate;
  try {
    candidate = chrome.runtime.connectNative(HOST_NAME);
  } catch (error) {
    console.warn("[bridge] connectNative threw:", error?.message || error);
    return;
  }
  port = candidate;
  setLink("connecting");
  candidate.onMessage.addListener(message => {
    void handleMessage(candidate, message);
  });
  candidate.onDisconnect.addListener(() => {
    // The ordinary case, not a fault: DeskLemurOS is simply not running, so the
    // host found nothing to relay to and exited. The alarm tries again later.
    const reason = chrome.runtime.lastError?.message || "port closed";
    if (port === candidate) {
      port = null;
      setLink("disconnected", reason);
    }
    console.info("[bridge] disconnected:", reason);
  });
  // Announce first, so the app knows which vocabulary this side speaks before
  // it sends anything. Posting to a host that has already exited is harmless.
  candidate.postMessage({
    event: "hello",
    data: {
      protocol: PROTOCOL_VERSION,
      extension_version: chrome.runtime.getManifest().version,
      browser: "chrome",
    },
  });
}

// An open native port keeps this worker alive. A closed one does not, so the
// retry has to come from an alarm, which wakes the worker again. 30 seconds is
// the shortest period Chrome allows.
function scheduleReconnect() {
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => {
  scheduleReconnect();
  connect();
});
chrome.runtime.onStartup.addListener(() => {
  scheduleReconnect();
  connect();
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === RECONNECT_ALARM) connect();
});
// The popup is the "DeskLemurOS just started, connect now" shortcut, so nobody
// has to wait out the alarm: opening it asks for a connection and shows how it
// went. Only this extension's own pages are answered.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type !== "status" && message?.type !== "connect") return false;
  if (message.type === "connect") connect();
  sendResponse({ ...link, version: chrome.runtime.getManifest().version });
  return false;
});

// ── Tabs this bridge owns ────────────────────────────────────────────
// Kept in session storage rather than a variable: the worker can be torn down
// and restarted between two commands, and forgetting ownership would either
// strand the tab or, worse, tempt a fallback that reads tabs it did not open.

async function readOwnedTabs() {
  const stored = await chrome.storage.session.get(OWNED_TABS_KEY);
  return new Set(Array.isArray(stored[OWNED_TABS_KEY]) ? stored[OWNED_TABS_KEY] : []);
}

// Every change to the list goes through this one queue. Storage is read and
// written asynchronously, so two changes that overlap — a tab closing while the
// next one opens, or several opening at once for a search — would each start
// from the same old list and the later write would erase the earlier one. A tab
// dropped that way can no longer be read *or closed*, and stays open in the
// user's browser.
let ownedTabsQueue = Promise.resolve();

function changeOwnedTabs(change) {
  const done = ownedTabsQueue.then(async () => {
    const tabs = await readOwnedTabs();
    if (change(tabs) !== false) {
      await chrome.storage.session.set({ [OWNED_TABS_KEY]: [...tabs] });
    }
  });
  ownedTabsQueue = done.catch(() => {});
  return done;
}

function rememberTab(tabId) {
  return changeOwnedTabs(tabs => { tabs.add(tabId); });
}

function forgetTab(tabId) {
  return changeOwnedTabs(tabs => tabs.delete(tabId));
}

async function ownedTabs() {
  // Behind any change already under way, so a read never sees a half-applied list.
  await ownedTabsQueue;
  return readOwnedTabs();
}

async function requireOwnedTab(params) {
  const tabId = params?.tab_id;
  if (!Number.isInteger(tabId)) {
    throw new BridgeError("invalid_params", "tab_id must be an integer");
  }
  if (!(await ownedTabs()).has(tabId)) {
    throw new BridgeError("unknown_tab", "that tab was not opened by the bridge, or is already closed");
  }
  return tabId;
}

chrome.tabs.onRemoved.addListener(tabId => {
  void forgetTab(tabId);
});

// ── Commands ─────────────────────────────────────────────────────────

function waitForLoad(tabId, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const finish = loaded => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(loaded);
    };
    const onUpdated = (updatedId, changeInfo) => {
      if (updatedId === tabId && changeInfo.status === "complete") finish(true);
    };
    // A slow page is reported, not failed: what has rendered so far may be
    // exactly what the reader wants, and that is the caller's call to make.
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    // The load may have completed before the listener was attached.
    chrome.tabs.get(tabId).then(
      tab => { if (tab.status === "complete") finish(true); },
      () => finish(false),
    );
  });
}

async function openUrl(params) {
  let parsed;
  try {
    parsed = new URL(String(params?.url ?? ""));
  } catch {
    throw new BridgeError("invalid_params", "url is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BridgeError("forbidden_url", "only http and https pages can be opened");
  }
  const requested = Number(params?.timeout_ms);
  const timeoutMs = Number.isFinite(requested) ? Math.min(Math.max(requested, 1000), 120000) : 30000;
  // Background by default: opening a page for the app must not pull the
  // browser in front of whatever the user is doing.
  tabsOpened += 1;
  const tab = await chrome.tabs.create({ url: parsed.href, active: params?.active === true });
  await rememberTab(tab.id);
  const loaded = await waitForLoad(tab.id, timeoutMs);
  const current = await chrome.tabs.get(tab.id).catch(() => tab);
  return { tab_id: tab.id, url: current.url || parsed.href, title: current.title || "", loaded };
}

// Runs one of this file's own functions in a tab the bridge opened. `func` is
// always a function defined here and shipped with the extension — never a
// string received from the app.
async function readFromOwnedTab(params, func) {
  const tabId = await requireOwnedTab(params);
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId }, func });
  } catch (error) {
    // The browser's own pages, the Web Store, and network error pages refuse
    // scripting; a bridge tab can end up on one through a redirect.
    throw new BridgeError("script_failed", String(error?.message || error));
  }
  const page = results?.[0]?.result;
  if (!page) throw new BridgeError("script_failed", "the page returned no result");
  return { tabId, page };
}

function bounded(value, limit) {
  const text = String(value ?? "");
  return { value: text.length > limit ? text.slice(0, limit) : text, truncated: text.length > limit };
}

async function readPageText(params) {
  const { tabId, page } = await readFromOwnedTab(params, () => ({
    url: location.href,
    title: document.title,
    text: document.body ? document.body.innerText : "",
  }));
  const text = bounded(page.text, MAX_TEXT_CHARS);
  return { tab_id: tabId, url: page.url, title: page.title, text: text.value, truncated: text.truncated };
}

async function readPageHtml(params) {
  const { tabId, page } = await readFromOwnedTab(params, () => ({
    url: location.href,
    title: document.title,
    html: document.documentElement ? document.documentElement.outerHTML : "",
  }));
  const html = bounded(page.html, MAX_HTML_CHARS);
  return { tab_id: tabId, url: page.url, title: page.title, html: html.value, truncated: html.truncated };
}

async function closeTab(params) {
  const tabId = await requireOwnedTab(params);
  await chrome.tabs.remove(tabId).catch(() => {});
  await forgetTab(tabId);
  return { tab_id: tabId, closed: true };
}

// How an update of this folder reaches the browser. A service worker keeps
// running the code it started with, even across a browser restart, until the
// extension is reloaded. Refused while the app still has tabs open through the
// bridge, or other requests under way: a reload forgets the tabs it opened, and
// they would stay open in the user's browser.
function busyWithRequests() {
  const others = inFlight - 1;
  return others > 0
    ? new BridgeError("busy", `the bridge is handling ${others} other request(s); try again when they have finished`)
    : null;
}

async function reloadExtension() {
  const early = busyWithRequests();
  if (early) throw early;
  const openedBefore = tabsOpened;
  const open = [];
  for (const tabId of await ownedTabs()) {
    // A tab that no longer exists is not a reason to refuse.
    if (await chrome.tabs.get(tabId).then(() => true, () => false)) open.push(tabId);
    else await forgetTab(tabId);
  }
  if (open.length > 0) {
    throw new BridgeError("busy", `the bridge still has ${open.length} tab(s) open; try again when they are closed`);
  }
  // The checks above waited on storage, and another request may have started
  // or opened a tab meanwhile. Checked again with no await before the flag is
  // set, so nothing can slip in between.
  const late = busyWithRequests();
  if (late) throw late;
  if (tabsOpened !== openedBefore) {
    throw new BridgeError("busy", "the bridge opened a tab while the reload was being checked; try again");
  }
  reloadScheduled = true;
  // After the reply below has gone out: reloading ends this worker at once.
  setTimeout(() => chrome.runtime.reload(), RELOAD_DELAY_MS);
  return { reloading: true, version: chrome.runtime.getManifest().version };
}

const METHODS = {
  open_url: openUrl,
  read_page_text: readPageText,
  read_page_html: readPageHtml,
  close_tab: closeTab,
  reload: reloadExtension,
};

function handleAppEvent(source, message) {
  // Stale ports must not overwrite the state of the live one.
  if (source !== port) return;
  const data = message.data && typeof message.data === "object" ? message.data : {};
  if (message.event === "welcome") {
    setLink("connected", "", data);
  } else if (message.event === "rejected") {
    setLink("rejected", String(data.reason || ""), data);
  }
}

async function handleMessage(source, message) {
  if (message && typeof message.event === "string") {
    handleAppEvent(source, message);
    return;
  }
  // Otherwise only requests are expected from the app. Anything without an id
  // cannot be answered, so it is dropped rather than guessed at.
  if (!message || typeof message.id !== "string") return;
  const reply = body => {
    try {
      source.postMessage({ id: message.id, ...body });
    } catch (error) {
      console.warn("[bridge] could not reply:", error?.message || error);
    }
  };
  if (reloadScheduled) {
    reply({
      ok: false,
      error: { code: "reloading", message: "the extension is reloading; send this again once it has reconnected" },
    });
    return;
  }
  const method = Object.hasOwn(METHODS, message.method) ? METHODS[message.method] : null;
  if (!method) {
    reply({ ok: false, error: { code: "unknown_method", message: `unknown method: ${String(message.method)}` } });
    return;
  }
  // Counted from here, before the method's first await, so a reload arriving
  // next sees this request under way.
  inFlight += 1;
  try {
    reply({ ok: true, result: await method(message.params || {}) });
  } catch (error) {
    reply({
      ok: false,
      error: {
        code: error instanceof BridgeError ? error.code : "internal",
        message: String(error?.message || error),
      },
    });
  } finally {
    inFlight -= 1;
  }
}

// Also on every worker start: the events above do not fire when the worker is
// merely woken, and a wake is exactly when a connection may be missing.
scheduleReconnect();
connect();
