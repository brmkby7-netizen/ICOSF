#!/usr/bin/env node
// Compiles the default filter lists into the rule sets bundled with the app,
// so protection works offline on first launch:
//   apple/ContentBlocker/Bundled/<slot>/blockerList.json   (one per Safari content blocker)
//   extension/rules/web/{manifest,generic,s0..sN}.json      (web extension rules, sharded)
//   build/report.json                                       (stats + skipped-rule reasons)
//
// Options:
//   --lists-dir <dir>   use <dir>/<id>.txt instead of downloading
//   --offline           never touch the network (use filters/cache)
//   --lists a,b,c       compile these list ids instead of the defaults
//   --placeholder       only write minimal placeholder outputs (no lists needed)
import fs from 'node:fs';
import path from 'node:path';
import { root, loadCatalog, getListText } from './lists.mjs';
import { build, shardWebIndex, DEFAULT_SLOTS } from '../compiler/src/index.js';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const SHARDS = 64;
const PLACEHOLDER_RULE = [{ trigger: { 'url-filter': '^bastion-placeholder:' }, action: { type: 'block' } }];

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
}

function writeOutputs(blockers, webIndex, report) {
  for (const slot of DEFAULT_SLOTS) {
    const rules = blockers[slot.id] && blockers[slot.id].length ? blockers[slot.id] : PLACEHOLDER_RULE;
    writeJSON(path.join(root, 'apple/ContentBlocker/Bundled', slot.id, 'blockerList.json'), rules);
  }
  const webDir = path.join(root, 'extension/rules/web');
  fs.rmSync(webDir, { recursive: true, force: true });
  const sharded = shardWebIndex(webIndex, SHARDS);
  writeJSON(path.join(webDir, 'manifest.json'), { version: report.builtAt, count: SHARDS });
  writeJSON(path.join(webDir, 'generic.json'), sharded.generic);
  sharded.shards.forEach((s, i) => writeJSON(path.join(webDir, `s${i}.json`), s));
  writeJSON(path.join(root, 'build/report.json'), JSON.stringify(report, null, 2));
}

if (args.includes('--placeholder')) {
  writeOutputs({}, { v: 2, entries: [], generic: {}, domains: {} }, { builtAt: 'placeholder', placeholder: true });
  console.log('wrote placeholder rule sets');
  process.exit(0);
}

const catalog = loadCatalog();
const wanted = opt('--lists') ? opt('--lists').split(',') : catalog.lists.filter((l) => l.default).map((l) => l.id);
const inputs = [];
console.log('Collecting filter lists…');
for (const id of wanted) {
  const list = catalog.lists.find((l) => l.id === id);
  if (!list) {
    console.warn(`  ! unknown list ${id}`);
    continue;
  }
  const r = await getListText(list, { listsDir: opt('--lists-dir'), offline: args.includes('--offline') });
  if (!r) {
    console.warn(`  ✗ ${id}: unavailable, skipped`);
    continue;
  }
  console.log(`  ✓ ${id.padEnd(20)} ${(r.text.length / 1024).toFixed(0).padStart(6)} KB  ${r.source}`);
  inputs.push({ id, text: r.text, category: list.category, trusted: list.trusted !== false });
}
if (inputs.length === 0) {
  console.warn('No lists available; writing placeholders. Run again with network access or --lists-dir.');
  writeOutputs({}, { v: 2, entries: [], generic: {}, domains: {} }, { builtAt: 'placeholder', placeholder: true });
  process.exit(0);
}

const out = build(inputs);
out.report.lists = inputs.map((l) => l.id);
writeOutputs(out.blockers, out.webIndex, out.report);

const s = out.report.stats;
console.log(`\nCompiled ${s.lines.toLocaleString()} filter lines in ${out.report.durationMs} ms`);
console.log(`  content-blocker rules: ${s.contentBlockerRules.toLocaleString()}  web-extension rules: ${s.webRules.toLocaleString()}  skipped: ${s.skipped.toLocaleString()}`);
for (const [slot, r] of Object.entries(out.report.distribution.slots)) {
  console.log(`  ${slot.padEnd(11)} ${String(r.total).padStart(7)} / ${out.report.distribution.limit} rules`);
}
if (out.report.distribution.dropped) console.warn(`  ! ${out.report.distribution.dropped} rules dropped: over Safari's limit`);
console.log('  top skip reasons:');
for (const e of out.report.errors.slice(0, 6)) console.log(`    ${String(e.count).padStart(6)}  ${e.reason}`);
