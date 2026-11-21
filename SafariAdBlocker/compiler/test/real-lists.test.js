// Compiles real filter lists (from filters/cache, or $BASTION_LISTS_DIR) and
// checks every produced rule against Safari's constraints. Skipped when no
// lists are available: run `npm run fetch-lists -- --default` first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../src/index.js';
import { assertValidRuleList, evaluate } from './webkit-sim.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = process.env.BASTION_LISTS_DIR || path.join(root, 'filters/cache');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'filters/catalog.json'), 'utf8'));
const lists = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).map((f) => {
      const id = f.replace(/\.txt$/, '');
      const entry = catalog.lists.find((l) => l.id === id);
      return { id, category: entry ? entry.category : 'ads', trusted: entry ? entry.trusted !== false : false, text: fs.readFileSync(path.join(dir, f), 'utf8') };
    })
  : [];

test('real filter lists compile to valid Safari rule lists', { skip: lists.length === 0 && 'no cached lists' }, () => {
  const out = build(lists);
  for (const [slot, rules] of Object.entries(out.blockers)) {
    assert.doesNotThrow(() => assertValidRuleList(rules), slot);
  }
  assert.equal(out.report.distribution.dropped, 0, 'nothing dropped for the lists under test');
  assert.ok(/^[\x00-\x7f]*$/.test(JSON.stringify(out.webIndex).replace(/[^\x00-\x7f]/g, '')));
  // Spot checks that should hold for any mainstream ad list.
  const ads = out.blockers.ads;
  if (lists.some((l) => /easylist|adguard-base/.test(l.id))) {
    assert.ok(evaluate(ads, { url: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', type: 'script', page: 'https://news.example/' }).blocked);
    assert.ok(!evaluate(ads, { url: 'https://news.example/app.js', type: 'script', page: 'https://news.example/' }).blocked);
  }
});
