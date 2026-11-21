// extension/lookup.js must agree with compiler/src/web.js on every lookup,
// both against the full index and against shards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { build, shardWebIndex, lookupWebRules } from '../../compiler/src/index.js';

const sandbox = {};
vm.runInNewContext(fs.readFileSync(new URL('../lookup.js', import.meta.url), 'utf8'), { globalThis: sandbox });
const { lookupParts, shardsFor } = sandbox.BastionLookup;

test('extension lookup matches compiler lookup', () => {
  const out = build([{ id: 't', trusted: true, text: `
example.com##+js(set, a, 1)
sub.example.com##+js(set, b, 2)
~skip.example.com,example.com##+js(set, c, 3)
deep.sub.example.com#@#+js(set, a, 1)
site.*#?#.x:has-text(y)
~site.co.uk,site.*##+js(aopr, z)
##+js(nowebrtc)
generic.test#$#body { overflow: auto !important; }
off.example.com#@#+js()
` }]);
  const sharded = shardWebIndex(out.webIndex, 16);
  const hosts = ['example.com', 'www.example.com', 'sub.example.com', 'deep.sub.example.com', 'skip.example.com',
    'site.com', 'www.site.co.uk', 'site.de', 'notsite.com', 'generic.test', 'off.example.com', 'unrelated.org', 'localhost'];
  for (const host of hosts) {
    const expected = JSON.parse(JSON.stringify(lookupWebRules(out.webIndex, host)));
    const full = JSON.parse(JSON.stringify(lookupParts([out.webIndex], host)));
    const parts = [sharded.generic, ...shardsFor(host, 16).map((n) => sharded.shards[n])];
    const viaShards = JSON.parse(JSON.stringify(lookupParts(parts, host)));
    assert.deepEqual(full, expected, host);
    assert.deepEqual(viaShards, expected, host + ' (shards)');
  }
  const deep = lookupWebRules(out.webIndex, 'deep.sub.example.com').scriptlets.map((s) => s.join(','));
  assert.ok(!deep.includes('set-constant,a,1') && deep.includes('set-constant,b,2'));
  assert.ok(!lookupWebRules(out.webIndex, 'skip.example.com').scriptlets.some((s) => s[2] === '3'));
  assert.ok(lookupWebRules(out.webIndex, 'site.de').extended.includes('.x:has-text(y)'));
  assert.ok(!lookupWebRules(out.webIndex, 'www.site.co.uk').scriptlets.some((s) => s[0] === 'abort-on-property-read'));
  assert.deepEqual(lookupWebRules(out.webIndex, 'off.example.com').scriptlets, []);
});
