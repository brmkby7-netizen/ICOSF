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
  theme: 'auto',
  repeats: 3,
  linkRepeats: 2,
  gap: 0,
  speed: 1,
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
