// On-device persistence. Everything lives in localStorage under the "qm." prefix.
const P = 'qm.';

function read(key, fallback) {
  try {
    const v = localStorage.getItem(P + key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(P + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(key) {
  try { localStorage.removeItem(P + key); } catch { /* ignore */ }
}

const DEFAULTS = {
  reciter: 'abkar',
  showTranslation: true,
  tajweed: true,
  autoscroll: true,
  keepAwake: true,
  favoriteReciters: [],
  theme: 'auto',
  repeats: 3,
  linkRepeats: 2,
  gap: 0,
  speed: 1,
  reviewCap: 50,
  maxGap: 30,
};

export const getSettings = () => ({ ...DEFAULTS, ...read('settings', {}) });
export const saveSettings = (s) => write('settings', s);

// Memorized ayat: { [surah]: [ayah, ...] }
let memorized = read('memorized', {});

export const getMemorizedSet = (surah) => new Set(memorized[surah] || []);
export const countMemorized = (surah) => (memorized[surah] || []).length;
export const totalMemorized = () =>
  Object.values(memorized).reduce((n, list) => n + list.length, 0);

export function setMemorized(surah, set) {
  const list = [...set].sort((a, b) => a - b);
  if (list.length) memorized[surah] = list;
  else delete memorized[surah];
  return write('memorized', memorized);
}

// Last practice range, used for "Continue".
export const getLast = () => read('last', null);
export const setLast = (v) => write('last', v);

// The practice range for each surah, so the user can move on from where they left off.
export const getPlan = (surah) => read('plans', {})[surah] || null;
export function setPlan(surah, plan) {
  const plans = read('plans', {});
  plans[surah] = plan;
  return write('plans', plans);
}

// Revision schedule: { "surah:ayah": { d: dueMs, s: stage, i: intervalDays, l: lapses, r: lastReviewMs, t: addedMs } }
export const getReviews = () => read('reviews', {});
export const saveReviews = (v) => write('reviews', v);
// How many ayat were revised today: { day: 'YYYY-MM-DD', count }
export const getReviewLog = () => read('reviewlog', { day: '', count: 0 });
export const saveReviewLog = (v) => write('reviewlog', v);

// Ayah timings a user marked by hand, stored as [[startMs, endMs], ...] (index = ayah - 1).
export function getTimings(reciterId, surah) {
  const list = read(`timings.${reciterId}.${surah}`, null);
  if (!Array.isArray(list) || !list.length) return null;
  const map = {};
  list.forEach(([start, end], i) => { map[i + 1] = { start, end }; });
  return map;
}
export const setTimings = (reciterId, surah, list) => write(`timings.${reciterId}.${surah}`, list);
export const clearTimings = (reciterId, surah) => remove(`timings.${reciterId}.${surah}`);

// Per-ayah timing fixes, applied on top of any reciter's timings: { [ayah]: [startMs, endMs] }
export const getTimingFixes = (reciterId, surah) => read(`timingfix.${reciterId}.${surah}`, {});
export function setTimingFixes(reciterId, surah, fixes) {
  if (Object.keys(fixes).length) return write(`timingfix.${reciterId}.${surah}`, fixes);
  remove(`timingfix.${reciterId}.${surah}`);
  return true;
}

// Timings with the user's fixes applied.
export function withFixes(reciterId, surah, timings) {
  if (!timings) return timings;
  const fixes = getTimingFixes(reciterId, surah);
  if (!Object.keys(fixes).length) return timings;
  const out = { ...timings };
  for (const [a, [start, end]] of Object.entries(fixes)) if (out[a]) out[a] = { start, end, fixed: true };
  return out;
}

export function exportAll() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(P)) data[k] = localStorage.getItem(k);
  }
  return { app: 'hifz', version: 1, exported: new Date().toISOString(), data };
}

export function importAll(obj) {
  if (!obj || obj.app !== 'hifz' || typeof obj.data !== 'object') {
    throw new Error('This file is not a Hifz backup.');
  }
  for (const [k, v] of Object.entries(obj.data)) {
    if (k.startsWith(P) && typeof v === 'string') localStorage.setItem(k, v);
  }
  memorized = read('memorized', {});
}
