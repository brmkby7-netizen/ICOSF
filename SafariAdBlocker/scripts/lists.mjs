// Shared helpers for scripts that need filter list text.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const cacheDir = path.join(root, 'filters/cache');

export function loadCatalog() {
  return JSON.parse(fs.readFileSync(path.join(root, 'filters/catalog.json'), 'utf8'));
}

async function download(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Bastion-Filter-Builder/1.0' }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length < 100 || /^\s*</.test(text)) throw new Error('response does not look like a filter list');
  return text;
}

/**
 * Returns list text, trying (in order): an explicit directory of <id>.txt
 * files, the network (primary URL then mirrors), then the local cache.
 */
export async function getListText(list, { listsDir, offline } = {}) {
  if (listsDir) {
    const p = path.join(listsDir, list.id + '.txt');
    if (fs.existsSync(p)) return { text: fs.readFileSync(p, 'utf8'), source: p };
  }
  const cached = path.join(cacheDir, list.id + '.txt');
  if (!offline) {
    for (const url of [list.url, ...(list.mirrors || [])]) {
      try {
        const text = await download(url);
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(cached, text);
        return { text, source: url };
      } catch (e) {
        console.warn(`  ! ${list.id}: ${url} failed (${e.message})`);
      }
    }
  }
  if (fs.existsSync(cached)) return { text: fs.readFileSync(cached, 'utf8'), source: cached + ' (cache)' };
  return null;
}
