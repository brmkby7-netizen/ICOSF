#!/usr/bin/env node
// Explains what Bastion's bundled rules do to a request or a page.
//   npm run inspect -- <url> [--page <page-url>] [--type script|image|document|...] [--frame child-frame]
//   npm run inspect -- --page <page-url>          (cosmetic + advanced rules for a page)
import fs from 'node:fs';
import path from 'node:path';
import { root } from './lists.mjs';
import { DEFAULT_SLOTS, lookupParts } from '../compiler/src/index.js';
import { evaluate } from '../compiler/test/webkit-sim.js';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const url = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const page = opt('--page', url);
const type = opt('--type', 'script');
const frame = opt('--frame', 'top-frame');
if (!page) {
  console.log('usage: npm run inspect -- <url> [--page <page-url>] [--type script] [--frame child-frame]');
  process.exit(1);
}

function explain(rules, req) {
  // Re-run the evaluation keeping the rules (not just actions) that fired.
  const fired = [];
  for (const r of rules) {
    if (evaluate([r], req).actions.length || (r.action.type === 'ignore-previous-rules' && wouldMatch(r, req))) fired.push(r);
  }
  return fired;
}
function wouldMatch(rule, req) {
  const probe = { trigger: rule.trigger, action: { type: 'block' } };
  return evaluate([probe], req).blocked;
}

for (const slot of DEFAULT_SLOTS) {
  const file = path.join(root, 'apple/ContentBlocker/Bundled', slot.id, 'blockerList.json');
  if (!fs.existsSync(file)) {
    console.log('No bundled rules yet: run `npm run build` first.');
    process.exit(1);
  }
  const rules = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (url) {
    const req = { url, type, page, frame };
    const result = evaluate(rules, req);
    const fired = explain(rules, req).filter((r) => r.action.type !== 'css-display-none');
    console.log(`\n[${slot.id}] ${result.blocked ? 'BLOCKED' : 'allowed'}`);
    for (const r of fired) console.log('  ', r.action.type.padEnd(22), JSON.stringify(r.trigger));
  }
}

const webDir = path.join(root, 'extension/rules/web');
if (!url || args.includes('--page')) {
  const host = new URL(page).hostname;
  const manifest = JSON.parse(fs.readFileSync(path.join(webDir, 'manifest.json'), 'utf8'));
  const parts = [JSON.parse(fs.readFileSync(path.join(webDir, 'generic.json'), 'utf8'))];
  for (let i = 0; i < manifest.count; i++) parts.push(JSON.parse(fs.readFileSync(path.join(webDir, `s${i}.json`), 'utf8')));
  const web = lookupParts(parts, host);
  console.log(`\nAdvanced rules for ${host}:`);
  for (const s of web.scriptlets) console.log('  scriptlet ', JSON.stringify(s));
  for (const e of web.extended) console.log('  procedural', e);
  for (const c of web.css) console.log('  css       ', `${c.sel} { ${c.style} }`);
}
