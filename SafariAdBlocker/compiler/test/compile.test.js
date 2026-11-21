import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, compile, lookupWebRules, allowlistRules } from '../src/index.js';
import { evaluate, hiddenSelectors, assertValidRuleList } from './webkit-sim.js';

function rulesFor(text, category = 'ads') {
  const out = build([{ id: 't', text, category }]);
  const all = Object.values(out.blockers).flat();
  for (const list of Object.values(out.blockers)) assertValidRuleList(list);
  return { out, slot: out.blockers[{ ads: 'ads', privacy: 'privacy', annoyances: 'annoyances' }[category] || 'ads'], all };
}

const req = (url, type = 'script', page = 'https://news.example/', frame) => ({ url, type, page, frame });

test('basic blocking and exceptions', () => {
  const { slot } = rulesFor(`
||adserver.test^
/banner/ad-
@@||adserver.test/allowed.js
||tracker.test^$third-party
||img.test^$image
||cdn.test/ads/*$script,domain=news.example|~sports.news.example
`);
  assert.ok(evaluate(slot, req('https://adserver.test/x.js')).blocked);
  assert.ok(evaluate(slot, req('https://www.adserver.test/x.png', 'image')).blocked);
  assert.ok(!evaluate(slot, req('https://adserver.test/allowed.js')).blocked, 'exception applies');
  assert.ok(evaluate(slot, req('https://site.test/banner/ad-1.png', 'image')).blocked);
  assert.ok(!evaluate(slot, req('https://site.test/banner/ad-1.html', 'document', 'https://site.test/banner/ad-1.html')).blocked, 'top-level documents are not blocked by path rules');
  assert.ok(evaluate(slot, req('https://site.test/banner/ad-1.html', 'document', 'https://news.example/', 'child-frame')).blocked, 'ad iframes are');
  assert.ok(evaluate(slot, req('https://tracker.test/p.gif', 'image')).blocked);
  assert.ok(!evaluate(slot, req('https://tracker.test/p.gif', 'image', 'https://tracker.test/')).blocked, 'first-party not blocked');
  assert.ok(evaluate(slot, req('https://img.test/a.png', 'image')).blocked);
  assert.ok(!evaluate(slot, req('https://img.test/a.js', 'script')).blocked);
  assert.ok(evaluate(slot, req('https://cdn.test/ads/x.js', 'script', 'https://www.news.example/')).blocked);
  assert.ok(!evaluate(slot, req('https://cdn.test/ads/x.js', 'script', 'https://sports.news.example/')).blocked, 'excluded subdomain');
  assert.ok(!evaluate(slot, req('https://cdn.test/ads/x.js', 'script', 'https://other.example/')).blocked);
});

test('important beats exceptions, document exception beats all', () => {
  const { slot } = rulesFor(`
||bad.test^$important
@@||bad.test^
||ads.test^
@@||trusted.example^$document
`);
  assert.ok(evaluate(slot, req('https://bad.test/a.js')).blocked);
  assert.ok(evaluate(slot, req('https://ads.test/a.js')).blocked);
  assert.ok(!evaluate(slot, req('https://ads.test/a.js', 'script', 'https://trusted.example/')).blocked);
  assert.ok(!evaluate(slot, req('https://bad.test/a.js', 'script', 'https://www.trusted.example/')).blocked);
});

test('badfilter removes rules', () => {
  const { slot } = rulesFor(`
||ads.test^$script
||ads.test^$script,badfilter
||keep.test^
`);
  assert.ok(!evaluate(slot, req('https://ads.test/a.js')).blocked);
  assert.ok(evaluate(slot, req('https://keep.test/a.js')).blocked);
});

test('regex rules and denyallow', () => {
  const { slot } = rulesFor(`
/^https?:\\/\\/[a-z]{6,10}\\.(com|net)\\/pop\\.js/$script,third-party
*$script,third-party,denyallow=cdn.test|static.test,domain=strict.example
`);
  assert.ok(evaluate(slot, req('https://abcdefg.net/pop.js')).blocked);
  assert.ok(!evaluate(slot, req('https://abc.net/pop.js')).blocked);
  assert.ok(evaluate(slot, req('https://random.test/x.js', 'script', 'https://strict.example/')).blocked);
  assert.ok(!evaluate(slot, req('https://cdn.test/x.js', 'script', 'https://strict.example/')).blocked);
  assert.ok(!evaluate(slot, req('https://img.static.test/x.js', 'script', 'https://strict.example/')).blocked);
});

test('cosmetic hiding, exceptions and elemhide', () => {
  const { slot } = rulesFor(`
##.ad-banner
##.sponsored
news.example##.promo
~nohide.example##.everywhere-but
news.example#@#.sponsored
@@||clean.example^$elemhide
@@||nogeneric.example^$generichide
nogeneric.example##.specific
`);
  const hidden = hiddenSelectors(slot, 'https://news.example/');
  assert.ok(hidden.includes('.ad-banner'));
  assert.ok(hidden.includes('.promo'));
  assert.ok(hidden.includes('.everywhere-but'));
  assert.ok(!hidden.includes('.sponsored'), 'domain exception');
  assert.ok(hiddenSelectors(slot, 'https://other.example/').includes('.sponsored'));
  assert.ok(!hiddenSelectors(slot, 'https://nohide.example/').includes('.everywhere-but'));
  assert.deepEqual(hiddenSelectors(slot, 'https://clean.example/'), []);
  const ng = hiddenSelectors(slot, 'https://nogeneric.example/');
  assert.ok(ng.includes('.specific'));
  assert.ok(!ng.includes('.ad-banner'));
});

test('if-directives and affinity', () => {
  const { out } = rulesFor(`
!#if !ext_ublock
||safari-only.test^
!#endif
!#if ext_ublock
||ubo-only.test^
!#endif
!#if (adguard_ext_firefox || adguard_ext_chromium)
||chromium.test^
!#else
||not-chromium.test^
!#endif
!#safari_cb_affinity(privacy)
||privacy-affinity.test^
!#safari_cb_affinity
`);
  const ads = out.blockers.ads;
  assert.ok(evaluate(ads, req('https://safari-only.test/')).blocked);
  assert.ok(!evaluate(ads, req('https://ubo-only.test/')).blocked);
  assert.ok(!evaluate(ads, req('https://chromium.test/')).blocked);
  assert.ok(evaluate(ads, req('https://not-chromium.test/')).blocked);
  assert.ok(!evaluate(ads, req('https://privacy-affinity.test/')).blocked);
  assert.ok(evaluate(out.blockers.privacy, req('https://privacy-affinity.test/')).blocked);
});

test('hosts files and plain domain lists', () => {
  const { slot } = rulesFor(`
# comment
0.0.0.0 hosts-ad.test
127.0.0.1 localhost
plain-domain.test
`);
  assert.ok(evaluate(slot, req('https://hosts-ad.test/a.js')).blocked);
  assert.ok(evaluate(slot, req('https://plain-domain.test/a.js')).blocked);
});

test('exceptions are replicated across extensions', () => {
  const out = build([
    { id: 'a', category: 'ads', text: '||shared.test^' },
    { id: 'p', category: 'privacy', text: '||track.test^\n@@||shared.test/ok.js' },
  ]);
  assert.ok(!evaluate(out.blockers.ads, req('https://shared.test/ok.js')).blocked);
  assert.ok(evaluate(out.blockers.ads, req('https://shared.test/no.js')).blocked);
});

test('allowlist disables everything for a site', () => {
  const { slot } = rulesFor('||ads.test^\n##.ad');
  const list = [...slot, ...allowlistRules(['paused.example'])];
  assert.ok(!evaluate(list, req('https://ads.test/a.js', 'script', 'https://paused.example/')).blocked);
  assert.deepEqual(hiddenSelectors(list, 'https://www.paused.example/'), []);
  assert.ok(evaluate(list, req('https://ads.test/a.js')).blocked);
});

test('web extension rules: scriptlets, procedural, css', () => {
  const out = build([{ id: 't', category: 'ads', trusted: true, text: `
example.com##+js(set, ads.enabled, false)
example.com##+js(aopr, adBlockDetected)
sub.example.com#@#+js(aopr, adBlockDetected)
example.com#%#//scriptlet('prevent-setTimeout', 'adblock')
example.com#?#div.post:has-text(Sponsored)
example.com##.card:upward(2)
example.com#$#body { overflow: auto !important; }
example.com#$#.modal { remove: true; }
example.com#$#abort-on-property-read Foo; json-prune ads
nojs.example#@#+js()
nojs.example##+js(set, x, 1)
example.com##+js(trusted-set-cookie, a, b)
` }]);
  const r = lookupWebRules(out.webIndex, 'www.example.com');
  const names = r.scriptlets.map((s) => s[0]);
  assert.ok(names.includes('set-constant'));
  assert.ok(names.includes('abort-on-property-read'));
  assert.ok(names.includes('prevent-setTimeout'));
  assert.ok(names.includes('json-prune'));
  assert.ok(names.includes('set-cookie'));
  assert.deepEqual(r.extended.sort(), ['.card:upward(2)', '.modal:remove()', 'div.post:has-text(Sponsored)']);
  assert.equal(r.css[0].style, 'overflow: auto !important;');
  const sub = lookupWebRules(out.webIndex, 'sub.example.com');
  assert.ok(!sub.scriptlets.some((s) => s[0] === 'abort-on-property-read' && s[1] === 'adBlockDetected'));
  assert.deepEqual(lookupWebRules(out.webIndex, 'nojs.example').scriptlets, []);

  const untrusted = build([{ id: 'u', category: 'ads', trusted: false, text: 'example.com##+js(trusted-set-cookie, a, b)' }]);
  assert.deepEqual(lookupWebRules(untrusted.webIndex, 'example.com').scriptlets, []);
});

test('unsupported options are skipped, not approximated', () => {
  const c = compile([{ id: 't', text: '||x.test^$csp=script-src none\n||y.test^$removeparam=utm\n||z.test^$redirect-rule=noopjs' }]);
  assert.equal(c.stats.contentBlockerRules, 0);
});

test('huge lists compile and overflow into other content blockers', () => {
  // Regression: push(...rules) threw RangeError beyond ~100k rules.
  const text = Array.from({ length: 250000 }, (_, i) => `||ad${i}.example^`).join('\n');
  const out = build([{ id: 'big', text, category: 'ads' }]);
  const totals = Object.values(out.report.distribution.slots).map((s) => s.total);
  assert.ok(totals.every((t) => t <= 150000));
  assert.equal(totals.reduce((a, b) => a + b, 0), 250000);
  assert.equal(out.report.distribution.dropped, 0);
});
