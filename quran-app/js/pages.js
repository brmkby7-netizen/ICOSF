// Madinah Mushaf pages (604): which ayat of a surah are on each page, and which pages you have passed.
// A page counts as memorized when you recite it (the part of it in one surah) in Test yourself with no
// missed or wrong words. Tajweed notes don't stop a pass.
import * as store from './storage.js';

let data = null;        // { surah: [page of ayah 1, page of ayah 2, …] }
let loading = null;
const parts = new Map(); // surah → [{ page, from, to }]

export function load() {
  if (data) return Promise.resolve();
  if (!loading) {
    loading = fetch(new URL('../data/pages.json', import.meta.url).href)
      .then((r) => { if (!r.ok) throw new Error('pages'); return r.json(); })
      .then((d) => { data = d; })
      .catch((e) => { loading = null; throw e; });
  }
  return loading;
}

// The pages a surah spans, with the ayat of this surah on each: [{ page, from, to }]
export function pagesOf(surah) {
  if (!data) return [];
  if (!parts.has(surah)) {
    const out = [];
    (data[surah] || []).forEach((pg, i) => {
      const last = out[out.length - 1];
      if (last && last.page === pg) last.to = i + 1;
      else out.push({ page: pg, from: i + 1, to: i + 1 });
    });
    parts.set(surah, out);
  }
  return parts.get(surah);
}

export const pageOf = (surah, ayah) => (data?.[surah] || [])[ayah - 1] || null;
export const partOf = (surah, page) => pagesOf(surah).find((p) => p.page === page) || null;
// the pages that ayat from..to touch
export const partsIn = (surah, from, to) => pagesOf(surah).filter((p) => p.from <= to && p.to >= from);

// Local calendar day, "YYYY-MM-DD"
export function today(t = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

// Where you stand on one page (its part in this surah)
export function status(surah, part) {
  const tested = store.getTested();
  let clean = 0;
  for (let a = part.from; a <= part.to; a++) if (tested[`${surah}:${a}`]) clean++;
  return { clean, total: part.to - part.from + 1, passed: store.getPagesPassed()[`${surah}:${part.page}`] || null };
}
export const isClean = (surah, ayah) => !!store.getTested()[`${surah}:${ayah}`];

// After Test yourself. results: [{ n, clean }] for the ayat tested (clean = every word right).
// Returns the pages it counted, and the pages it touched without counting (with the reason).
export function recordTest(surah, results) {
  const day = today();
  const tested = store.getTested();
  const passed = store.getPagesPassed();
  const cleanSet = new Set(results.filter((x) => x.clean).map((x) => x.n));
  // the latest result counts: a slip on an ayah recited correctly before takes it back off the page
  for (const x of results) {
    if (x.clean) tested[`${surah}:${x.n}`] = day;
    else delete tested[`${surah}:${x.n}`];
  }
  store.saveTested(tested);
  const testedSet = new Set(results.map((x) => x.n));
  const from = Math.min(...testedSet), to = Math.max(...testedSet);
  const counted = [], notYet = [];
  for (const part of partsIn(surah, from, to)) {
    let whole = true, allClean = true;
    const slips = [];
    for (let a = part.from; a <= part.to; a++) {
      if (!testedSet.has(a)) whole = false;
      else if (!cleanSet.has(a)) { allClean = false; slips.push(a); }
    }
    if (whole && allClean) {
      if (!passed[`${surah}:${part.page}`]) counted.push(part);
      passed[`${surah}:${part.page}`] = day;
    } else notYet.push({ ...part, whole, slips });
  }
  store.savePagesPassed(passed);
  return { counted, notYet };
}

// How much of a page you passed today, in pages (a part of a page shared by two surahs counts as its share)
export function passedToday() {
  if (!data) return 0;
  const day = today();
  let total = 0;
  for (const [key, d] of Object.entries(store.getPagesPassed())) {
    if (d !== day) continue;
    const [surah, page] = key.split(':').map(Number);
    const part = partOf(surah, page);
    if (!part) continue;
    let onPage = 0;
    for (const list of Object.values(data)) for (const pg of list) if (pg === page) onPage++;
    total += (part.to - part.from + 1) / (onPage || 1);
  }
  return total;
}

// The page to learn next in this surah: the first not yet passed, skipping pages you ticked ✓ as memorized.
// `max`: the last ayah with timings, so the page can be practised.
export function nextToLearn(surah, memorized, max) {
  const passed = store.getPagesPassed();
  for (const part of pagesOf(surah)) {
    if (part.from > max) return null;
    if (passed[`${surah}:${part.page}`]) continue;
    let known = true;
    for (let a = part.from; a <= part.to; a++) if (!memorized.has(a)) { known = false; break; }
    if (!known) return { ...part, to: Math.min(part.to, max) };
  }
  return null;
}
