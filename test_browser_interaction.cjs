// DOM integration checks against local, intercepted fixtures. No external page
// or user's browser is touched. Run from the app checkout with Playwright:
//     node browser_extension/test_browser_interaction.cjs
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const source = fs.readFileSync(path.join(__dirname, 'browser_interaction.js'), 'utf8');

const fixture = `<!doctype html><html><head><title>Browser interaction fixture</title></head><body>
  <form action="/submitted"><label>Search <input name="query" value="old"></label><button>Search now</button></form>
  <label>Category <select><option value="all">All</option><option value=" books ">Books</option><option value="closed" disabled>Closed</option></select></label>
  <label>Multiple <select multiple><option value="one" selected>One</option><option value="two" selected>Two</option></select></label>
  <label>Notes <textarea></textarea></label><div contenteditable="true" aria-label="Document">old text</div>
  <label>Password <input type="password" value="secret-fixture"></label>
  <button id="count" type="button" onclick="this.dataset.count=String(Number(this.dataset.count||0)+1)">Count</button>
  <button disabled>Unavailable</button><button style="display:none">Hidden</button>
  <a href="https://browser-test.invalid/next">Next</a><a href="file:///secret">Forbidden</a>
  <a href="https://browser-test.invalid/new" target="_blank">New tab</a>
  <div id="covered" style="position:relative;width:250px;height:50px"><button style="width:200px">Covered</button><div style="position:absolute;inset:0;background:#fff">Overlay</div></div>
  <iframe src="/frame"></iframe><div style="height:3000px">Long page</div>
</body></html>`;

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname !== 'browser-test.invalid') return route.abort();
      return route.fulfill({ contentType: 'text/html', body: url.pathname === '/' ? fixture : '<!doctype html><title>Result</title><p>Result page</p>' });
    });
    await page.goto('https://browser-test.invalid/');
    await page.addScriptTag({ content: source });
    const run = command => page.evaluate(command => browserPageCommand(command), { session_id: 'session_test_001', ...command });
    const observe = async () => (await run({ operation: 'snapshot' })).snapshot;
    const find = (snapshot, name) => {
      const item = snapshot.elements.find(element => element.name === name);
      assert.ok(item, `expected element ${name}`);
      return item.ref;
    };
    const act = (snapshot, action, name, rest = {}) => run({ operation: 'action', action, snapshot_id: snapshot.snapshot_id, ref: name ? find(snapshot, name) : undefined, ...rest });

    let snapshot = await observe();
    assert.equal(snapshot.frame_count, 1);
    assert.ok(snapshot.limitations.includes('main_frame_only'));
    assert.ok(!snapshot.elements.some(element => element.name === 'Hidden'));
    assert.ok(!Object.hasOwn(snapshot.elements.find(element => element.type === 'password'), 'value'));
    assert.equal((await act(snapshot, 'click', 'Unavailable')).error.code, 'element_disabled');
    assert.equal((await act(snapshot, 'click', 'Covered')).error.code, 'element_obscured');
    assert.equal((await act(snapshot, 'click', 'Forbidden')).error.code, 'forbidden_url');
    assert.equal((await act(snapshot, 'click', 'New tab')).error.code, 'unsupported_target');
    assert.equal((await act(snapshot, 'press', 'Search', { key: 'Tab' })).error.code, 'unsupported_key');
    assert.equal((await act(snapshot, 'select', 'Category', { value: 'closed' })).error.code, 'invalid_option');
    assert.equal((await act(snapshot, 'select', 'Multiple', { value: 'one' })).error.code, 'unsupported_element');
    assert.deepEqual(await page.locator('select[multiple]').evaluate(element => [...element.selectedOptions].map(option => option.value)), ['one', 'two'], 'single-value selection never clears a multi-select');

    assert.equal((await act(snapshot, 'fill', 'Search', { text: 'new query' })).action_dispatched, true);
    assert.equal(await page.locator('input[name=query]').inputValue(), 'new query');
    assert.equal((await act(snapshot, 'click', 'Count')).error.code, 'stale_snapshot', 'an action consumes its snapshot');
    snapshot = await observe();
    assert.equal(snapshot.elements.find(element => element.name === 'Category').options[1].value, ' books ', 'option values are preserved exactly');
    assert.equal((await act(snapshot, 'select', 'Category', { value: ' books ' })).action_dispatched, true);
    assert.equal(await page.locator('select:not([multiple])').inputValue(), ' books ');
    snapshot = await observe();
    assert.equal((await act(snapshot, 'fill', 'Document', { text: 'new content' })).action_dispatched, true);
    assert.equal(await page.locator('[contenteditable]').innerText(), 'new content');

    snapshot = await observe();
    await page.locator('#count').evaluate(element => { element.textContent = 'Different action'; });
    assert.equal((await act(snapshot, 'click', 'Count')).error.code, 'stale_ref', 'changed targets must be observed again');
    snapshot = await observe();
    await page.locator('#count').evaluate(element => { element.outerHTML = element.outerHTML; });
    assert.equal((await act(snapshot, 'click', 'Different action')).error.code, 'stale_ref', 'a replacement node must not inherit the old ref');
    snapshot = await observe();
    await page.locator('input[name=query]').fill('user edited');
    assert.equal((await act(snapshot, 'fill', 'Search', { text: 'overwrite' })).error.code, 'stale_ref', 'concurrent edits are not silently overwritten');
    snapshot = await observe();
    const earlier = snapshot;
    snapshot = await observe();
    assert.equal((await act(earlier, 'click', 'Different action')).error.code, 'stale_snapshot');
    assert.equal((await run({ operation: 'action', session_id: 'another_session', action: 'click', snapshot_id: snapshot.snapshot_id, ref: find(snapshot, 'Different action') })).error.code, 'stale_snapshot');
    assert.equal((await act(snapshot, 'click', 'Different action')).action_dispatched, true);
    assert.equal(await page.locator('#count').getAttribute('data-count'), '1');

    snapshot = await observe();
    assert.equal((await act(snapshot, 'scroll', null, { direction: 'down', amount: 500 })).action_dispatched, true);
    assert.ok(await page.evaluate(() => scrollY > 0));
    snapshot = await observe();
    const submitted = await act(snapshot, 'press', 'Search', { key: 'Enter' });
    assert.equal(submitted.action_dispatched, true);
    await page.waitForURL('**/submitted?query=user+edited');
    await page.addScriptTag({ content: source });
    assert.equal((await act(snapshot, 'click', 'Different action')).error.code, 'stale_snapshot', 'navigation cannot reuse references');
    snapshot = await observe();
    assert.equal(snapshot.title, 'Result');
    assert.equal((await run({ operation: 'back' })).action_dispatched, true);
    await page.waitForURL('https://browser-test.invalid/');
    await page.addScriptTag({ content: source });
    snapshot = await observe();
    assert.equal(snapshot.title, 'Browser interaction fixture', 'packaged history back returns to the previous document');

    await page.evaluate(() => {
      document.body.innerHTML = '<p>' + 'x'.repeat(7000) + '</p>' + Array.from({ length: 110 }, (_, i) => '<button style="display:block;height:60px">Button ' + i + '</button>').join('');
    });
    snapshot = await observe();
    assert.equal(snapshot.text.length, 6000);
    assert.equal(snapshot.elements.length, 100);
    assert.equal(snapshot.truncated, true);
    assert.equal(snapshot.total_elements, 110);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    snapshot = await observe();
    assert.ok(snapshot.elements.some(element => element.name === 'Button 109'), 'scrolling exposes elements beyond the original cap');
    assert.ok(snapshot.elements[0].in_viewport, 'viewport elements come first');
    await page.goto('http://browser-test.invalid/');
    await page.addScriptTag({ content: source });
    assert.equal(await page.evaluate(() => isSecureContext), false);
    snapshot = await observe();
    assert.ok(snapshot.snapshot_id, 'snapshots work on ordinary HTTP pages without crypto.randomUUID');
    console.log('browser_interaction.js: DOM integration ok');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
