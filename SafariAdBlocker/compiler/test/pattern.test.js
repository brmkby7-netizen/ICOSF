import { test } from 'node:test';
import assert from 'node:assert/strict';
import { abpPatternToRegex, jsRegexToWebKit, validateWebKitRegex, HOST_PREFIX } from '../src/pattern.js';
import { toASCII, parseDomainList } from '../src/domains.js';

const rx = (p) => abpPatternToRegex(p).regex;
const matches = (pattern, url) => new RegExp(rx(pattern), 'i').test(url);

test('host anchors', () => {
  assert.equal(rx('||ads.example.com^'), HOST_PREFIX + 'ads\\.example\\.com[/:]');
  assert.equal(abpPatternToRegex('||ads.example.com^').host, 'ads.example.com');
  assert.equal(abpPatternToRegex('||ads.example.com/x').host, null);
  assert.ok(matches('||example.com^', 'https://example.com/'));
  assert.ok(matches('||example.com^', 'https://sub.example.com/a.js'));
  assert.ok(matches('||example.com^', 'http://example.com:8080/'));
  assert.ok(!matches('||example.com^', 'https://notexample.com/'));
  assert.ok(!matches('||example.com^', 'https://example.com.evil.net/'));
  assert.ok(!matches('||example.com^', 'https://other.net/?u=example.com/'));
});

test('separators, wildcards and anchors', () => {
  assert.ok(matches('/ads/banner^', 'https://x.com/ads/banner?id=1'));
  assert.ok(matches('/ads/banner^', 'https://x.com/ads/banner'));
  assert.ok(!matches('/ads/banner^', 'https://x.com/ads/bannerz'));
  assert.ok(matches('/ad*.js', 'https://x.com/adserver/main.js'));
  assert.ok(matches('|https://x.com/', 'https://x.com/a'));
  assert.ok(!matches('|https://x.com/', 'https://y.com/?https://x.com/'));
  assert.ok(matches('.swf|', 'https://x.com/a.swf'));
  assert.ok(!matches('.swf|', 'https://x.com/a.swf?x'));
  assert.equal(rx('*'), '.*');
  assert.equal(rx('ad*'), 'ad');
  assert.equal(rx('*/ads/*'), '/ads/');
});

test('literal escaping and non-ASCII', () => {
  assert.equal(rx('a.b+c?d(e)'), 'a\\.b\\+c\\?d\\(e\\)');
  assert.equal(rx('/püb/'), '/p%C3%BCb/');
  assert.equal(rx('||bücher.de^'), HOST_PREFIX + 'xn--bcher-kva\\.de[/:]');
  for (const p of ['||a.com^', '/x^y^', 'a|b', '|x|', '^ads^', '||x.com/a^b*c^']) {
    assert.equal(validateWebKitRegex(rx(p)), null, p + ' -> ' + rx(p));
  }
});

test('JS regex conversion', () => {
  assert.deepEqual(jsRegexToWebKit('ad\\d+\\.js'), ['ad[0-9]+\\.js']);
  assert.deepEqual(jsRegexToWebKit('(?:ads|banners)\\/'), ['ads/', 'banners/']);
  assert.deepEqual(jsRegexToWebKit('^https?:\\/\\/(www\\.)?x\\.com\\/'), ['^https?://(www\\.)?x\\.com/']);
  assert.deepEqual(jsRegexToWebKit('(^|\\.)x\\.com'), ['^x\\.com', '\\.x\\.com']);
  assert.deepEqual(jsRegexToWebKit('a[0-9]{2,3}b'), ['a[0-9][0-9][0-9]?b']);
  assert.deepEqual(jsRegexToWebKit('[a-z]{8,40}\\.js'), ['[a-z][a-z][a-z][a-z][a-z][a-z][a-z][a-z]+\\.js']);
  assert.deepEqual(jsRegexToWebKit('a(b|c)?d'), ['ad', 'abd', 'acd']);
  assert.throws(() => jsRegexToWebKit('(?=x)'));
  assert.throws(() => jsRegexToWebKit('a\\bb'));
  assert.throws(() => jsRegexToWebKit('(a|b)+'));
  assert.throws(() => jsRegexToWebKit('a^b'));
  for (const r of jsRegexToWebKit('^https?:\\/\\/[a-z]{5,12}\\.(com|net)\\/[a-z0-9]{3,}\\.js$')) {
    assert.equal(validateWebKitRegex(r), null, r);
    assert.ok(new RegExp(r).test('https://abcdefg.net/abcd.js') || new RegExp(r).test('https://abcdefg.com/abcd.js'));
  }
});

test('WebKit regex validator', () => {
  assert.equal(validateWebKitRegex('^a(b)?c$'), null);
  assert.equal(validateWebKitRegex('[^a-z]+'), null);
  assert.ok(validateWebKitRegex('a|b'));
  assert.ok(validateWebKitRegex('a{2}'));
  assert.ok(validateWebKitRegex('a^'));
  assert.ok(validateWebKitRegex('$a'));
  assert.ok(validateWebKitRegex('\\d'));
  assert.ok(validateWebKitRegex('(?:a)'));
  assert.ok(validateWebKitRegex('*a'));
  assert.ok(validateWebKitRegex('é'));
  assert.ok(validateWebKitRegex('(a'));
});

test('domains', () => {
  assert.equal(toASCII('MÜNCHEN.de'), 'xn--mnchen-3ya.de');
  assert.equal(toASCII('例え.jp'), 'xn--r8jz45g.jp');
  const d = parseDomainList('a.com|~b.a.com|site.*|/re/', '|');
  assert.deepEqual(d.include.slice(0, 2), ['a.com', 'site.com']);
  assert.ok(d.include.includes('site.co.uk'));
  assert.deepEqual(d.exclude, ['b.a.com']);
  assert.deepEqual(d.unsupported, ['/re/']);
});
