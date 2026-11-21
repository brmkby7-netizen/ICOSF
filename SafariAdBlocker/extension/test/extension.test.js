// Runs the extension's page-side code (procedural engine, scriptlets, the
// content-script pipeline) in a real browser engine against fixture pages.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build, shardWebIndex } from '../../compiler/src/index.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const dir = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(dir, '..');
const read = (f) => fs.readFileSync(path.join(ext, f), 'utf8');

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
});

async function pageWith(html, { init = [], routes = {} } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const script of init) await page.addInitScript(script);
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (routes[url.pathname]) return route.fulfill(routes[url.pathname]);
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('https://test.example/');
  return { page, context };
}

const runtime = `(${'bastionScriptletRuntime'})`;
function scriptletInit(calls) {
  // Same mechanism content.js uses: serialize the runtime into the page.
  return `${read('scriptlets.js')}\n;globalThis.bastionScriptletRuntime(${JSON.stringify(calls)}, {});`;
}

test('procedural engine', async () => {
  const html = `<!doctype html><body>
    <div class="post" id="p1"><span>Sponsored</span> content</div>
    <div class="post" id="p2">Normal content</div>
    <div class="card" id="c1"><div><span class="label">Ad</span></div></div>
    <div class="card" id="c2"><div><span class="label">News</span></div></div>
    <section id="wrap"><div><div><b class="mark" id="m1">x</b></div></div></section>
    <div id="fixed" style="position: fixed; top: 0">overlay</div>
    <div id="long">aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</div>
    <div id="xp" data-ad="1">xpath target</div>
    <div id="rm" class="remove-me">remove</div>
    <div id="st" class="style-me">style</div>
    <ul><li id="li1"><a href="https://ads.example/1">a</a></li><li id="li2"><a href="https://ok.example/">b</a></li></ul>
    <div class="nest" id="n1"><div class="inner"><p class="deep">promo</p></div></div>
  </body>`;
  const { page, context } = await pageWith(html, { init: [read('procedural.js')] });
  await page.evaluate(() => {
    const engine = new BastionProcedural.Engine();
    engine.add([
      '.post:has-text(Sponsored)',
      '.card:-abp-has(.label:contains(/^Ad$/))',
      '.mark:upward(2)',
      'b.mark:upward(section)',
      'div:matches-css(position: fixed)',
      'div#long:min-text-length(40)',
      ':xpath(//div[@data-ad="1"])',
      '.remove-me:remove()',
      'li:has(a[href*="ads.example"])',
      '.nest:has(.inner:has(.deep))',
    ]);
    engine.add(['.style-me'], 'color: rgb(255, 0, 0) !important');
    engine.apply();
  });
  const hidden = await page.evaluate(() => [...document.querySelectorAll('[style*="display: none"]')].map((e) => e.id || e.tagName));
  for (const id of ['p1', 'c1', 'fixed', 'long', 'xp', 'li1', 'n1']) assert.ok(hidden.includes(id), id + ' should be hidden: ' + hidden);
  for (const id of ['p2', 'c2', 'li2']) assert.ok(!hidden.includes(id), id + ' should stay visible');
  assert.ok(hidden.includes('wrap'), 'upward(section)');
  assert.equal(await page.evaluate(() => document.getElementById('rm')), null, ':remove()');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('st')).color), 'rgb(255, 0, 0)');

  // Dynamically inserted content is caught by the observer.
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div class="post" id="late">Sponsored later</div>'));
  await page.waitForFunction(() => document.getElementById('late').style.display === 'none');

  // Unsupported syntax compiles to null instead of hiding the wrong things.
  assert.equal(await page.evaluate(() => BastionProcedural.compile('div:others()')), null);
  assert.equal(await page.evaluate(() => BastionProcedural.compile('.a:remove() .b')), null);
  await context.close();
});

test('scriptlets: properties, timers, JSON', async () => {
  const html = `<!doctype html><script>
    window.results = {};
    window.ads = { enabled: true };
    try { results.aopr = typeof adBlockDetector; } catch (e) { results.aopr = 'threw'; }
    window.config = { ads: { enabled: true } };
    results.deep = window.config.ads.enabled;
    results.later = null;
    setTimeout(() => { results.timerRan = true; }, 0);
    setTimeout(function detectAdblock() { results.adblockTimer = true; }, 0);
    results.parsed = JSON.parse('{"playerAds":[1],"keep":1,"adPlacements":[{"x":1}]}');
    results.items = JSON.parse('{"items":[{"ad":{"id":1}},{"video":2},{"ad":{"id":3}}]}');
  </script>`;
  const { page, context } = await pageWith(html, {
    init: [scriptletInit([
      ['abort-on-property-read', 'adBlockDetector'],
      ['set-constant', 'config.ads.enabled', 'false'],
      ['set-constant', 'player.ads', 'null'],
      ['prevent-setTimeout', 'detectAdblock'],
      ['json-prune', 'playerAds adPlacements'],
      ['json-prune', 'items.[-].ad'],
    ])],
  });
  await page.waitForTimeout(50);
  const r = await page.evaluate(() => window.results);
  assert.equal(r.aopr, 'threw');
  assert.equal(r.deep, false, 'set-constant on an object created after injection');
  assert.equal(r.timerRan, true);
  assert.equal(r.adblockTimer, undefined);
  assert.deepEqual(r.parsed, { keep: 1 });
  assert.deepEqual(r.items, { items: [{ video: 2 }] });
  assert.equal(await page.evaluate(() => { window.player = { ads: 5 }; return window.player.ads; }), null, 'trap set before object exists');
  assert.equal(await page.evaluate(() => /native code/.test(Function.prototype.toString.call(setTimeout))), true, 'wrapped functions look native');
  await context.close();
});

test('scriptlets: network hooks', async () => {
  const html = `<!doctype html><script>
    window.results = {};
    (async () => {
      const a = await fetch('/api/player?id=1').then((r) => r.json());
      results.fetchPruned = a;
      const b = await fetch('/ads/beacon').then((r) => r.text());
      results.prevented = b;
      const x = new XMLHttpRequest();
      x.open('GET', '/api/watch');
      x.onload = () => { results.xhr = x.responseText; };
      x.send();
      results.popup = window.open('https://popunder.example/') !== null;
    })();
  </script>`;
  const { page, context } = await pageWith(html, {
    init: [scriptletInit([
      ['json-prune-fetch-response', 'adPlacements', '', 'propsToMatch', '/api/player'],
      ['prevent-fetch', '/ads/'],
      ['replace-xhr-response', '/"adSlots":\\[[^\\]]*\\],?/', '', '/api/watch'],
      ['prevent-window-open', 'popunder'],
    ])],
    routes: {
      '/api/player': { contentType: 'application/json', body: '{"video":"v","adPlacements":[1,2]}' },
      '/api/watch': { contentType: 'application/json', body: '{"adSlots":[1,2],"video":"w"}' },
      '/ads/beacon': { body: 'SHOULD-NOT-LOAD' },
    },
  });
  await page.waitForFunction(() => window.results.xhr !== undefined);
  const r = await page.evaluate(() => window.results);
  assert.deepEqual(r.fetchPruned, { video: 'v' });
  assert.equal(r.prevented, '');
  assert.equal(r.xhr, '{"video":"w"}');
  assert.equal(r.popup, true, 'returns a decoy window so pages do not detect the block');
  await context.close();
});

test('scriptlets: DOM helpers', async () => {
  const html = `<!doctype html><body>
    <a id="a" href="https://x.example" target="_blank" onclick="1">x</a>
    <div id="d" class="ad-overlay blur">d</div>
    <button id="consent" onclick="window.clicked = true">Reject</button>
  </body>`;
  const { page, context } = await pageWith(html, {
    init: [scriptletInit([
      ['remove-attr', 'onclick', '#a'],
      ['remove-class', 'blur', '#d'],
      ['set-cookie', 'consent', 'no'],
      ['click-element', '#consent'],
    ])],
  });
  await page.waitForFunction(() => window.clicked === true);
  assert.equal(await page.evaluate(() => document.getElementById('a').hasAttribute('onclick')), false);
  assert.equal(await page.evaluate(() => document.getElementById('d').className), 'ad-overlay');
  assert.match(await page.evaluate(() => document.cookie), /consent=no/);
  await context.close();
});

test('content script end to end: bundled shards, scriptlets before page scripts, CSS, procedural', async () => {
  const lists = [{ id: 't', category: 'ads', trusted: true, text: `
test.example##+js(set, adsAllowed, false)
test.example#?#.promo:has-text(Sponsored)
test.example#$#.banner { visibility: hidden !important; }
other.example##+js(set, adsAllowed, true)
` }];
  const out = build(lists);
  const sharded = shardWebIndex(out.webIndex, 8);
  const files = {
    'rules/web/manifest.json': JSON.stringify({ version: 'test', count: 8 }),
    'rules/web/generic.json': JSON.stringify(sharded.generic),
  };
  sharded.shards.forEach((s, i) => { files[`rules/web/s${i}.json`] = JSON.stringify(s); });

  const routes = {};
  for (const [f, body] of Object.entries(files)) routes['/__ext/' + f] = { contentType: 'application/json', body };
  const html = `<!doctype html><head><script>window.seenAtParse = window.adsAllowed;</script></head><body>
    <div class="promo" id="p">Sponsored post</div><div class="banner" id="b">banner</div></body>`;

  const browserShim = `
    window.__messages = [];
    globalThis.browser = { runtime: {
      getURL: (p) => location.origin + '/__ext/' + p,
      sendMessage: (m) => { window.__messages.push(m); return Promise.resolve(m.type === 'page' ? { rules: null, picker: ['#picked'] } : true); },
    } };`;
  const { page, context } = await pageWith(html, {
    init: [browserShim, read('lookup.js'), read('scriptlets.js'), read('procedural.js'), read('content.js')],
    routes,
  });
  await page.waitForFunction(() => document.getElementById('p').style.display === 'none');
  assert.equal(await page.evaluate(() => window.seenAtParse), false, 'scriptlet ran before the first page script');
  const messages = await page.evaluate(() => window.__messages);
  const css = messages.filter((m) => m.type === 'insertCSS').map((m) => m.css).join('\n');
  assert.match(css, /\.banner \{ visibility: hidden !important; \}/);
  assert.match(css, /#picked \{ display: none !important; \}/);
  assert.ok(messages.some((m) => m.type === 'page' && m.host === 'test.example' && m.bundledVersion === 'test'));
  await context.close();
});
