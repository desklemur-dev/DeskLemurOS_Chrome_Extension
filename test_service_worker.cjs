// Runs service_worker.js against a stand-in `chrome` API, under Node.
//
//     node browser_extension/test_service_worker.cjs
//
// The stand-in's storage is deliberately slow and asynchronous, because the bug
// this exists for only shows when two updates overlap: the list of tabs the
// bridge owns was read, changed and written back by each caller independently,
// so a tab closing while another opened erased one of them. A tab lost that way
// can be neither read nor closed, and stays open in the user's browser.
//
// Not part of the store package; scripts/package_browser_extension.py ships an
// allowlist of files.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeChrome(seed = {}) {
  const listeners = { message: [], disconnect: [], removed: [], updated: [] };
  const store = JSON.parse(JSON.stringify(seed.store || {}));
  const tabs = new Map((seed.tabs || []).map(tab => [tab.id, tab]));
  const sent = [];
  let nextTab = 100;
  const reloads = [];
  const created = [];
  const executed = [];
  let observationFails = false;
  const port = {
    onMessage: { addListener: fn => listeners.message.push(fn) },
    onDisconnect: { addListener: fn => listeners.disconnect.push(fn) },
    postMessage: message => sent.push(message),
  };
  const chrome = {
    runtime: {
      id: 'test-extension',
      lastError: null,
      connectNative: () => port,
      getManifest: () => ({ version: '0.0.0-test' }),
      // Records when it was called, measured in replies already sent.
      reload: () => reloads.push(sent.length),
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener() {} },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    storage: {
      session: {
        // Slow on purpose: every get and set yields, so overlapping callers
        // really do interleave.
        async get(key) { await delay(5); return { [key]: store[key] === undefined ? undefined : JSON.parse(JSON.stringify(store[key])) }; },
        async set(values) { await delay(5); Object.assign(store, JSON.parse(JSON.stringify(values))); },
      },
    },
    tabs: {
      async create({ url }) {
        created.push(url);
        const tab = { id: nextTab++, url, title: 'T', status: 'complete' };
        tabs.set(tab.id, tab);
        return tab;
      },
      async get(id) { if (!tabs.has(id)) throw new Error('No tab with id'); return tabs.get(id); },
      async update(id, properties) { const tab = await this.get(id); Object.assign(tab, properties); return tab; },
      async goBack(id) { const tab = await this.get(id); tab.url = 'https://previous.example/'; },
      async remove(id) { tabs.delete(id); for (const fn of listeners.removed) fn(id); },
      onUpdated: { addListener: fn => listeners.updated.push(fn), removeListener() {} },
      onRemoved: { addListener: fn => listeners.removed.push(fn) },
    },
    scripting: {
      async executeScript({ target, args }) {
        const tab = tabs.get(target.tabId);
        if (!tab) throw new Error('No tab with id');
        if (args) {
          executed.push({ tabId: target.tabId, command: args[0] });
          if (args[0].operation === 'back') tab.url = 'https://previous.example/';
          if (args[0].operation === 'snapshot') {
            if (observationFails) throw new Error('Document is navigating');
            return [{ result: { ok: true, snapshot: { snapshot_id: `snap-${executed.length}`, url: tab.url, title: tab.title, text: 'page', elements: [] } } }];
          }
          return [{ result: { ok: true, action_dispatched: true } }];
        }
        return [{ result: { url: tab.url, title: tab.title, text: `text of ${tab.url}`, html: `<html>${tab.url}</html>` } }];
      },
    },
  };
  let requestId = 0;
  // Send one request the way the app does, and wait for its reply.
  async function request(method, params) {
    const id = `r${++requestId}`;
    for (const fn of listeners.message) fn({ id, method, params });
    for (let waited = 0; waited < 400; waited++) {
      const reply = sent.find(message => message.id === id);
      if (reply) return reply;
      await delay(5);
    }
    throw new Error(`no reply to ${method}`);
  }
  return { chrome, request, sent, openTabs: tabs, store, reloads, created, executed,
    failObservation: () => { observationFails = true; },
    disconnect: () => { for (const fn of listeners.disconnect) fn(); },
  };
}

const SOURCE = fs.readFileSync(path.join(__dirname, 'service_worker.js'), 'utf8');

// A fresh worker against a fresh stand-in browser.
function boot(seed) {
  const world = makeChrome(seed);
  const context = vm.createContext({ chrome: world.chrome, console, setTimeout, clearTimeout, URL, Promise,
    crypto: require('node:crypto').webcrypto, TextEncoder });
  context.importScripts = filename => vm.runInContext(fs.readFileSync(path.join(__dirname, filename), 'utf8'), context);
  vm.runInContext(SOURCE, context);
  return world;
}

async function interactiveSessions() {
  const world = boot();
  const { request, openTabs, store, executed } = world;
  assert.deepEqual(Array.from(world.sent[0].data.capabilities), ['browser_interaction_v1']);
  const [opened, queuedSnapshot] = await Promise.all([
    request('browser_open', { session_id: 'session_alpha', url: 'https://start.example/' }),
    request('browser_snapshot', { session_id: 'session_alpha' }),
  ]);
  assert.ok(opened.ok, JSON.stringify(opened));
  assert.ok(queuedSnapshot.ok, 'snapshot waits for the same session open');
  const tabId = opened.result.tab_id;
  assert.equal(queuedSnapshot.result.tab_id, tabId);
  assert.equal(store.bridgeBrowserSessionsV1.session_alpha.tab_id, tabId);
  assert.equal((await request('read_page_text', { tab_id: tabId })).error.code, 'session_required');
  assert.equal((await request('close_tab', { tab_id: tabId })).error.code, 'session_required');
  assert.equal((await request('browser_open', { session_id: 'session_alpha', url: 'https://other.example/' })).error.code, 'session_exists');
  assert.equal(openTabs.size, 1, 'a retry does not create a duplicate tab');
  assert.equal((await request('browser_snapshot', { session_id: 'session_other' })).error.code, 'unknown_session');
  assert.equal((await request('browser_action', { session_id: 'session_alpha', action: 'fill', text: 'test' })).error.code, 'invalid_params');
  assert.equal((await request('browser_action', { session_id: 'session_alpha', action: 'navigate', url: 'file:///secret' })).error.code, 'forbidden_url');
  assert.equal((await request('browser_action', { session_id: 'session_alpha', action: 'run_script' })).error.code, 'invalid_params');
  const navigated = await request('browser_action', { session_id: 'session_alpha', action: 'navigate', url: 'https://next.example/' });
  assert.equal(navigated.result.snapshot.url, 'https://next.example/');
  assert.equal(navigated.result.action_dispatched, true);
  assert.equal(navigated.result.outcome, 'dispatched_verify_snapshot');
  assert.equal(navigated.result.before_snapshot_id, queuedSnapshot.result.snapshot.snapshot_id);
  assert.equal(navigated.result.observed_state_changed, true);
  const unchanged = await request('browser_action', { session_id: 'session_alpha', action: 'click', snapshot_id: navigated.result.snapshot.snapshot_id, ref: 'e1' });
  assert.equal(unchanged.result.observed_state_changed, false, 'a fresh snapshot id does not by itself count as a state change');
  assert.equal(unchanged.result.state_comparison_scope, 'bounded_snapshot_not_remote_side_effects');
  const back = await request('browser_action', { session_id: 'session_alpha', action: 'back' });
  assert.equal(back.result.snapshot.url, 'https://previous.example/');
  assert.ok(executed.some(item => item.command.operation === 'back'), 'HTTP history uses the packaged page history operation');
  world.failObservation();
  const clicked = await request('browser_action', { session_id: 'session_alpha', action: 'click', snapshot_id: 'snap-latest', ref: 'e1' });
  assert.ok(clicked.ok);
  assert.equal(clicked.result.action_dispatched, true);
  assert.equal(clicked.result.outcome, 'observation_unavailable');
  assert.equal(clicked.result.snapshot, null);
  assert.equal(clicked.result.observed_state_changed, null);
  assert.equal(executed.filter(item => item.command.action === 'click').length, 2, 'failed after-observation never replays a click');
  assert.equal((await request('reload', {})).error.code, 'busy', 'interactive tabs participate in reload protection');
  assert.ok((await request('browser_close', { session_id: 'session_alpha' })).ok);
  assert.equal((await request('browser_close', { session_id: 'session_alpha' })).result.already_closed, true);
  assert.equal(openTabs.size, 0);
  assert.equal((await request('browser_snapshot', { session_id: 'session_alpha' })).error.code, 'unknown_session');

  const disconnected = boot();
  const regular = await disconnected.request('open_url', { url: 'https://read.example/' });
  await disconnected.request('browser_open', { session_id: 'session_disconnect', url: 'https://interactive.example/' });
  disconnected.disconnect();
  await delay(160);
  assert.equal(disconnected.openTabs.size, 1, 'disconnect closes interactive tabs only');
  assert.ok(disconnected.openTabs.has(regular.result.tab_id));
  assert.deepEqual(Object.keys(disconnected.store.bridgeBrowserSessionsV1), []);

  const restarted = boot({
    store: { bridgeTabs: [81, 82], bridgeBrowserSessionsV1: { orphan_session: { tab_id: 81 } } },
    tabs: [{ id: 81, url: 'https://orphan.example/', status: 'complete' }, { id: 82, url: 'https://read.example/', status: 'complete' }],
  });
  const fresh = await restarted.request('browser_open', { session_id: 'session_fresh', url: 'https://fresh.example/' });
  assert.ok(fresh.ok, JSON.stringify(fresh));
  assert.equal(restarted.openTabs.has(81), false, 'startup cleans interactive tabs orphaned by a terminated worker');
  assert.equal(restarted.openTabs.has(82), true, 'legacy read tabs are preserved');
  assert.deepEqual(Object.keys(restarted.store.bridgeBrowserSessionsV1), ['session_fresh']);
}

// A reload must not overlap anything that could open a tab: the reload ends
// the worker, forgets the tabs it owns, and a tab opened around it would stay
// open in the user's browser for good.
async function reloadRaces() {
  // 1. A page is being opened when the reload arrives: the reload is refused.
  {
    const { request, openTabs, reloads } = boot();
    const [opened, reload] = await Promise.all([
      request('open_url', { url: 'https://during.example/' }),
      request('reload', {}),
    ]);
    assert.ok(opened.ok, 'the page being opened is opened');
    assert.equal(reload.ok, false);
    assert.equal(reload.error.code, 'busy', 'no reload while another request is under way');
    await delay(250);
    assert.equal(reloads.length, 0, 'and nothing was reloaded');
    const closed = await request('close_tab', { tab_id: opened.result.tab_id });
    assert.ok(closed.ok, 'the tab can still be closed');
    assert.equal(openTabs.size, 0);
    assert.ok((await request('reload', {})).ok, 'and the reload is accepted afterwards');
  }

  // 2. A page is asked for once the reload has been accepted: refused, and no
  //    tab is created at all.
  {
    const { request, created, openTabs, reloads, store } = boot();
    const reload = await request('reload', {});
    assert.ok(reload.ok, 'the reload is accepted');
    const opened = await request('open_url', { url: 'https://after.example/' });
    assert.equal(opened.ok, false);
    assert.equal(opened.error.code, 'reloading', 'nothing new starts once a reload is scheduled');
    assert.deepEqual(created, [], 'no tab was created');
    assert.equal(openTabs.size, 0);
    assert.equal((await request('read_page_text', { tab_id: 1 })).error.code, 'reloading');
    assert.equal((await request('reload', {})).error.code, 'reloading', 'nor a second reload');
    await delay(300);
    assert.equal(reloads.length, 1, 'the extension reloads once');
    assert.deepEqual(store.bridgeTabs ?? [], []);
  }

  // 3. A page is asked for while the reload is still checking its tabs (that
  //    waits on storage): the page wins, the reload is refused.
  {
    const { request, openTabs, reloads } = boot();
    const reloading = request('reload', {});
    await delay(1);
    const opening = request('open_url', { url: 'https://meanwhile.example/' });
    const [reload, opened] = await Promise.all([reloading, opening]);
    assert.ok(opened.ok, 'the page asked for during the check is opened');
    assert.equal(reload.ok, false);
    assert.equal(reload.error.code, 'busy');
    await delay(250);
    assert.equal(reloads.length, 0, 'and nothing was reloaded behind its back');
    assert.ok((await request('close_tab', { tab_id: opened.result.tab_id })).ok);
    assert.equal(openTabs.size, 0);
  }
}

async function main() {
  const { request, sent, openTabs, store, reloads } = boot();

  assert.equal(sent[0].event, 'hello', 'the worker announces itself on connect');

  // 1. Several pages opened at once, as a search does.
  const urls = [1, 2, 3, 4, 5, 6].map(n => `https://e${n}.example/?q=x`);
  const opened = await Promise.all(urls.map(url => request('open_url', { url })));
  assert.ok(opened.every(reply => reply.ok), 'every concurrent open succeeds');
  const ids = opened.map(reply => reply.result.tab_id);
  assert.deepEqual([...store.bridgeTabs].sort(), [...ids].sort(), 'every opened tab is remembered');

  const read = await Promise.all(ids.map(tab_id => request('read_page_html', { tab_id })));
  assert.ok(read.every(reply => reply.ok), 'every tab the bridge opened can be read');

  // A reload would forget the tabs it opened and strand them in the browser.
  const refused = await request('reload', {});
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'busy', 'no reload while the bridge has tabs open');
  await delay(250);
  assert.equal(reloads.length, 0, 'and nothing was reloaded');

  // 2. A tab closing while the next one opens — a read, then the next read.
  const [closing, next] = await Promise.all([
    request('close_tab', { tab_id: ids[0] }),
    request('open_url', { url: 'https://next.example/' }),
  ]);
  assert.ok(closing.ok && next.ok);
  const after = await request('read_page_text', { tab_id: next.result.tab_id });
  assert.ok(after.ok, 'the tab opened during a close is still owned');
  assert.equal((await request('read_page_text', { tab_id: ids[0] })).error.code, 'unknown_tab');

  // 3. Everything can be closed again: nothing is stranded in the browser.
  const remaining = [...ids.slice(1), next.result.tab_id];
  const closed = await Promise.all(remaining.map(tab_id => request('close_tab', { tab_id })));
  assert.ok(closed.every(reply => reply.ok), 'every remaining tab can be closed');
  await delay(60);
  assert.equal(openTabs.size, 0, 'no tab is left open');
  assert.deepEqual(store.bridgeTabs, [], 'and none is still recorded as owned');

  // 4. The fixed boundaries hold.
  assert.equal((await request('open_url', { url: 'file:///etc/passwd' })).error.code, 'forbidden_url');
  assert.equal((await request('read_page_text', { tab_id: 999 })).error.code, 'unknown_tab');
  assert.equal((await request('run_script', { code: 'alert(1)' })).error.code, 'unknown_method');
  assert.equal((await request('constructor', {})).error.code, 'unknown_method');

  // 5. Reload: answered first, reloaded after. A tab that is already gone (its
  //    close was missed) does not hold it back, and is forgotten.
  store.bridgeTabs = [4242];
  const reloading = await request('reload', {});
  assert.ok(reloading.ok, 'reload is accepted once no bridge tab is open');
  assert.deepEqual({ ...reloading.result }, { reloading: true, version: '0.0.0-test' });
  assert.equal(reloads.length, 0, 'the reply goes out before the reload');
  await delay(300);
  assert.equal(reloads.length, 1, 'then the extension reloads, once');
  const repliedBefore = sent.findIndex(message => message.id === reloading.id) + 1;
  assert.ok(reloads[0] >= repliedBefore, 'after its reply was sent');
  assert.deepEqual(store.bridgeTabs, [], 'the missing tab was forgotten');

  await reloadRaces();
  await interactiveSessions();

  console.log('service_worker.js: ok');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
