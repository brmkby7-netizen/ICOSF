#!/usr/bin/env node
// Downloads every list in the catalog (or --default) into filters/cache/.
import { loadCatalog, getListText } from './lists.mjs';

const onlyDefault = process.argv.includes('--default');
const catalog = loadCatalog();
for (const list of catalog.lists) {
  if (onlyDefault && !list.default) continue;
  const r = await getListText(list);
  console.log(r ? `✓ ${list.id.padEnd(22)} ${(r.text.length / 1024).toFixed(0).padStart(6)} KB  ${r.source}` : `✗ ${list.id}`);
}
