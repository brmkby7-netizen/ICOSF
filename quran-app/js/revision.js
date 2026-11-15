// Revision planner: a small spaced-repetition scheduler for ayat, stored on the device.
//
// New ayat (those that leave the Move on window) come back after ~6 hours, then the next
// morning, then after 2, 3 and 7 days. After that the gap doubles on each good review, up to
// the user's maximum gap (default 30 days), so nothing goes unrevised for longer than that.
// Ayat ticked as already memorized join further along the ladder (next check tomorrow, then
// weekly and longer).
import * as store from './storage.js';

const DAY = 86400000;
const HOUR = 3600000;
export const STEPS = [0.25, 1, 2, 3, 7]; // days until the next review, by stage
export const LONG_TERM = STEPS.length; // stage at which an ayah counts as "old revision"
const MAX_PASSAGE = 10; // ayat per review passage
const STALE_DAYS = 21;

const keyOf = (surah, ayah) => `${surah}:${ayah}`;
const parseKey = (k) => k.split(':').map(Number);

export function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const dayStamp = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Under a day: that many hours from now. Otherwise: early morning (4 am) of the target day.
function dueAfter(days, now) {
  if (days < 1) return now + days * DAY;
  const d = new Date(startOfDay(now));
  d.setDate(d.getDate() + Math.round(days));
  d.setHours(4);
  return d.getTime();
}

function nextInterval(item, grade, maxGap) {
  if (grade === 'again') return { s: 1, i: 1 };
  if (grade === 'hard') {
    const i = item.s < STEPS.length ? STEPS[item.s] : Math.max(1, Math.round(item.i * 1.2));
    return { s: item.s, i: Math.min(i, maxGap) };
  }
  const s = item.s + (grade === 'easy' ? 2 : 1);
  if (s < STEPS.length) return { s, i: STEPS[s] };
  const grown = Math.round((item.i || STEPS[STEPS.length - 1]) * (grade === 'easy' ? 3 : 2));
  return { s, i: Math.min(maxGap, Math.max((item.i || 0) + 1, grown)) };
}

export function previewInterval(items, grade, maxGap) {
  // The passage's label uses its least-advanced ayah, so it never promises too long a gap.
  const weakest = items.reduce((a, b) => (b.s < a.s ? b : a), items[0]);
  return nextInterval(weakest, grade, maxGap).i;
}

export function fmtGap(days) {
  if (days < 1) return `in ${Math.round(days * 24)} h`;
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

// ---------- changes ----------

export function addNew(surah, ayat, now = Date.now()) {
  const all = store.getReviews();
  let added = 0;
  for (const a of ayat) {
    const k = keyOf(surah, a);
    if (all[k]) continue;
    all[k] = { d: now + STEPS[0] * DAY, s: 0, i: 0, l: 0, r: 0, t: now };
    added++;
  }
  if (added) store.saveReviews(all);
  return added;
}

// Already-memorized ayat. With `spread`, a large batch is spread over the next two weeks so it
// doesn't all fall due on the same day.
export function addKnown(surah, ayat, { spread = false, now = Date.now() } = {}) {
  const all = store.getReviews();
  let added = 0;
  ayat.forEach((a, idx) => {
    const k = keyOf(surah, a);
    if (all[k]) return;
    const offset = spread ? 1 + (Math.floor(idx / MAX_PASSAGE) % 14) : 1;
    all[k] = { d: dueAfter(offset, now), s: LONG_TERM, i: STEPS[LONG_TERM - 1], l: 0, r: 0, t: now };
    added++;
  });
  if (added) store.saveReviews(all);
  return added;
}

export function remove(surah, ayat) {
  const all = store.getReviews();
  let n = 0;
  for (const a of ayat) if (delete all[keyOf(surah, a)]) n++;
  if (n) store.saveReviews(all);
}

export function has(surah, ayah) {
  return !!store.getReviews()[keyOf(surah, ayah)];
}

// grades: { [ayah]: 'again' | 'hard' | 'good' | 'easy' }
export function grade(surah, grades, { now = Date.now(), maxGap = 30 } = {}) {
  const all = store.getReviews();
  for (const [a, g] of Object.entries(grades)) {
    const k = keyOf(surah, a);
    const item = all[k];
    if (!item) continue;
    const { s, i } = nextInterval(item, g, maxGap);
    all[k] = { ...item, s, i, d: dueAfter(i, now), r: now, l: item.l + (g === 'again' ? 1 : 0) };
  }
  store.saveReviews(all);
  logReviewed(Object.keys(grades).length, now);
}

function logReviewed(n, now) {
  const day = dayStamp(now);
  const log = store.getReviewLog();
  store.saveReviewLog({ day, count: (log.day === day ? log.count : 0) + n });
}

export function reviewedToday(now = Date.now()) {
  const log = store.getReviewLog();
  return log.day === dayStamp(now) ? log.count : 0;
}

// ---------- queries ----------

export function entries() {
  return Object.entries(store.getReviews()).map(([k, item]) => {
    const [surah, ayah] = parseKey(k);
    return { surah, ayah, ...item };
  });
}

// Group ayat into passages: contiguous runs in the same surah, at most MAX_PASSAGE ayat each.
export function toPassages(list, now = Date.now()) {
  const sorted = [...list].sort((a, b) => a.surah - b.surah || a.ayah - b.ayah);
  const out = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    if (last && last.surah === e.surah && last.to === e.ayah - 1 && last.items.length < MAX_PASSAGE) {
      last.to = e.ayah;
      last.items.push(e);
    } else {
      out.push({ surah: e.surah, from: e.ayah, to: e.ayah, items: [e] });
    }
  }
  for (const p of out) {
    p.old = p.items.filter((x) => x.s >= LONG_TERM).length * 2 >= p.items.length;
    p.due = Math.min(...p.items.map((x) => x.d));
    const lastSeen = Math.min(...p.items.map((x) => x.r || x.t));
    p.staleDays = Math.floor((now - lastSeen) / DAY);
    p.stale = p.staleDays >= STALE_DAYS;
    p.weak = p.items.some((x) => x.l >= 2);
  }
  return out;
}

// Today's plan: old revision first, then recent; most overdue first; up to the daily cap.
export function todayPlan({ now = Date.now(), cap = 50 } = {}) {
  const all = entries();
  const due = all.filter((e) => e.d <= now);
  const passages = toPassages(due, now).sort((a, b) => (b.old - a.old) || (a.due - b.due));
  const done = reviewedToday(now);
  let room = Math.max(0, cap - done);
  const today = [];
  for (const p of passages) {
    if (room <= 0) break;
    today.push(p);
    room -= p.items.length;
  }
  const shown = today.reduce((n, p) => n + p.items.length, 0);
  const endOfDay = startOfDay(now) + DAY;
  const laterToday = all.filter((e) => e.d > now && e.d < endOfDay).length;
  const nextDue = all.filter((e) => e.d > now).reduce((m, e) => Math.min(m, e.d), Infinity);
  return {
    today,
    dueAyat: due.length,
    shownAyat: shown,
    waiting: due.length - shown,
    behind: due.length > cap,
    doneToday: done,
    laterToday,
    nextDue: Number.isFinite(nextDue) ? nextDue : null,
    total: all.length,
  };
}

export function dueCount(now = Date.now()) {
  return entries().filter((e) => e.d <= now).length;
}

export function stats(now = Date.now()) {
  const all = entries();
  return {
    total: all.length,
    due: all.filter((e) => e.d <= now).length,
    old: all.filter((e) => e.s >= LONG_TERM).length,
    weak: all.filter((e) => e.l >= 2),
  };
}

export const HOURS = HOUR;
