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

function makeChrome() {
  const listeners = { message: [], disconnect: [], removed: [], updated: [] };
  const store = {};
  const tabs = new Map();
  const sent = [];
  let nextTab = 100;
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
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener() {} },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    storage: {
      session: {
        // Slow on purpose: every get and set yields, so overlapping callers
        // really do interleave.
        async get(key) { await delay(5); return { [key]: store[key] === undefined ? undefined : [...store[key]] }; },
        async set(values) { await delay(5); Object.assign(store, JSON.parse(JSON.stringify(values))); },
      },
    },
    tabs: {
      async create({ url }) { const tab = { id: nextTab++, url, title: 'T', status: 'complete' }; tabs.set(tab.id, tab); return tab; },
      async get(id) { if (!tabs.has(id)) throw new Error('No tab with id'); return tabs.get(id); },
      async remove(id) { tabs.delete(id); for (const fn of listeners.removed) fn(id); },
      onUpdated: { addListener: fn => listeners.updated.push(fn), removeListener() {} },
      onRemoved: { addListener: fn => listeners.removed.push(fn) },
    },
    scripting: {
      async executeScript({ target }) {
        const tab = tabs.get(target.tabId);
        if (!tab) throw new Error('No tab with id');
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
  return { chrome, request, sent, openTabs: tabs, store };
}

async function main() {
  const { chrome, request, sent, openTabs, store } = makeChrome();
  const source = fs.readFileSync(path.join(__dirname, 'service_worker.js'), 'utf8');
  vm.runInNewContext(source, { chrome, console, setTimeout, clearTimeout, URL, Promise });

  assert.equal(sent[0].event, 'hello', 'the worker announces itself on connect');

  // 1. Several pages opened at once, as a search does.
  const urls = [1, 2, 3, 4, 5, 6].map(n => `https://e${n}.example/?q=x`);
  const opened = await Promise.all(urls.map(url => request('open_url', { url })));
  assert.ok(opened.every(reply => reply.ok), 'every concurrent open succeeds');
  const ids = opened.map(reply => reply.result.tab_id);
  assert.deepEqual([...store.bridgeTabs].sort(), [...ids].sort(), 'every opened tab is remembered');

  const read = await Promise.all(ids.map(tab_id => request('read_page_html', { tab_id })));
  assert.ok(read.every(reply => reply.ok), 'every tab the bridge opened can be read');

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

  console.log('service_worker.js: ok');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
