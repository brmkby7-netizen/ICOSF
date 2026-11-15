// Data sources: Quran.com (text + translation) and mp3quran.net (audio + Idris Abkar ayah timings).
const QURAN = 'https://api.quran.com/api/v4';
const MP3 = 'https://mp3quran.net/api/v3';
const TRANSLATION_ID = 20; // Saheeh International
const AUDIO_CACHE = 'qm-audio';

export const RECITERS = {
  abkar: {
    id: 'abkar',
    name: 'Idris Abkar',
    mp3quranId: 12,
    moshafId: 12,
    server: 'https://cdn.mp3quran.net/audio/idrees-abkar/r1/',
    timingRead: 12, // mp3quran publishes ayah timings for this recording
  },
  sobhi: {
    id: 'sobhi',
    name: 'Islam Sobhi',
    mp3quranId: 253,
    moshafId: 253,
    server: 'https://cdn.mp3quran.net/audio/islam-sobhi/r1/',
    timingRead: null, // no published timings: the user marks them once per surah
  },
};

const memo = new Map();
function getJson(url) {
  if (memo.has(url)) return memo.get(url);
  const p = fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Request failed (${r.status})`);
    return r.json();
  });
  memo.set(url, p);
  p.catch(() => memo.delete(url));
  return p;
}

const decoder = document.createElement('textarea');
function cleanTranslation(html) {
  const stripped = String(html || '')
    .replace(/<sup[^>]*>.*?<\/sup>/gi, '')
    .replace(/<[^>]+>/g, '');
  decoder.innerHTML = stripped;
  return decoder.value.replace(/\s+/g, ' ').trim();
}

export async function getChapters() {
  const data = await getJson(`${QURAN}/chapters?language=en`);
  return data.chapters;
}

// Display text and tajweed come from two Quran.com fields:
//   – text_qpc_hafs: the text encoded for the KFGQPC Uthmanic Hafs font. This is what we show.
//   – text_uthmani_tajweed: tajweed markup (<tajweed class=rule>…</tajweed>), but in an older
//     encoding with stand-in characters (e.g. ٲ for the superscript alif ٰ, ْ for ۡ, ٮ for ى)
//     that this font can't draw. Shown directly, Safari renders them on dotted circles.
// So we align the two texts character by character and copy each letter's tajweed rule onto
// the KFGQPC text.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (s) => s.replace(/[&<>"']/g, (c) => ESC[c]);
const IS_MARK = /^\p{M}$/u;

// Characters that are the same thing in the two encodings compare equal.
const EQUIV = {
  'ٲ': 'ٰ', // ٲ → superscript alif
  'ْ': 'ۡ', // sukun → KFGQPC sukun
  '۟': 'ۡ', // small high rounded zero
  'ٮ': 'ى', // dotless beh → alef maksura
  'ٗ': 'ً', 'ࣰ': 'ً', // tanween fath variants
  'ٞ': 'ٌ', 'ࣱ': 'ٌ', // tanween damm variants
  'ٖ': 'ٍ', 'ࣲ': 'ٍ', // tanween kasr variants
  '‌': ' ', // ZWNJ before waqf marks ~ space
};
const key = (c) => EQUIV[c] || c;

// Tajweed markup → [{ ch, rule }]
function tajweedChars(markup) {
  const src = String(markup || '').replace(/<span class=["']?end["']?>[^<]*<\/span>/g, '');
  const out = [];
  const stack = [];
  let last = 0;
  const push = (text) => {
    const rule = stack.length ? stack[stack.length - 1] : null;
    for (const ch of text) out.push({ ch, rule });
  };
  for (const m of src.matchAll(/<(\/?)(tajweed|span)\b([^>]*)>/g)) {
    push(src.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) stack.pop();
    else stack.push(/class=["']?([a-z_]+)/.exec(m[3])?.[1] || null);
  }
  push(src.slice(last));
  return out;
}

// Rule for every character of `display`, taken from the aligned tajweed characters (LCS).
function alignRules(display, taj) {
  const a = [...display];
  const b = taj;
  const n = a.length, m = b.length;
  const ak = a.map(key), bk = b.map((x) => key(x.ch));
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = ak[i] === bk[j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const rules = new Array(n).fill(undefined);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (ak[i] === bk[j]) { rules[i] = b[j].rule; i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  // Unmatched characters take the rule of their neighbours when both agree (e.g. a mark
  // inside a coloured letter); otherwise they stay uncoloured.
  for (let i = 0; i < n; i++) {
    if (rules[i] !== undefined) continue;
    let p = i - 1; while (p >= 0 && rules[p] === undefined) p--;
    let q = i + 1; while (q < n && rules[q] === undefined) q++;
    const before = p >= 0 ? rules[p] : null;
    const after = q < n ? rules[q] : null;
    rules[i] = before && before === after ? before : null;
  }
  return { chars: a, rules };
}

// Build safe HTML. No coloured span may start with a combining mark: Safari draws a mark that
// starts its own element on a dotted circle. A span of marks only takes in the letter they sit
// on; leading marks of other spans move back onto the previous letter.
function tajweedHtml(display, markup) {
  const { chars, rules } = alignRules(display, tajweedChars(markup));
  const segs = [];
  chars.forEach((ch, i) => {
    const rule = rules[i];
    const prev = segs[segs.length - 1];
    if (prev && prev.rule === rule) prev.text += ch;
    else segs.push({ text: ch, rule });
  });
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i], prev = segs[i - 1];
    if (!seg.rule) continue;
    const lead = [...seg.text];
    let k = 0; while (k < lead.length && IS_MARK.test(lead[k])) k++;
    if (k === 0) continue;
    if (k === lead.length) {
      const p = [...prev.text];
      let c = p.length; while (c > 0 && IS_MARK.test(p[c - 1])) c--;
      if (c > 0 && p[c - 1].trim()) {
        seg.text = p.slice(c - 1).join('') + seg.text;
        prev.text = p.slice(0, c - 1).join('');
      }
    } else {
      prev.text += lead.slice(0, k).join('');
      seg.text = lead.slice(k).join('');
    }
  }
  return segs
    .filter((x) => x.text)
    .map((x) => (x.rule && /^[a-z_]+$/.test(x.rule) ? `<span class="tj tj-${x.rule}">${escape(x.text)}</span>` : escape(x.text)))
    .join('');
}

const stripAyahNumber = (t) => String(t || '').replace(/[\s ]*[٠-٩]+\s*$/, '').trim();

export async function getVerses(surah) {
  const [display, tajweed, english] = await Promise.all([
    getJson(`${QURAN}/quran/verses/qpc_hafs?chapter_number=${surah}`),
    getJson(`${QURAN}/quran/verses/uthmani_tajweed?chapter_number=${surah}`).catch(() => null),
    getJson(`${QURAN}/quran/translations/${TRANSLATION_ID}?chapter_number=${surah}`),
  ]);
  const tjByKey = new Map((tajweed?.verses || []).map((v) => [v.verse_key, v.text_uthmani_tajweed]));
  return display.verses.map((v, i) => {
    const text = stripAyahNumber(v.text_qpc_hafs);
    const markup = tjByKey.get(v.verse_key);
    return {
      n: Number(v.verse_key.split(':')[1]),
      text,
      html: markup ? tajweedHtml(text, markup) : escape(text),
      translation: cleanTranslation(english.translations[i]?.text),
    };
  });
}

// [{ juz, ranges: { [surah]: [from, to] }, count }]
export async function getJuzs() {
  const data = await getJson(`${QURAN}/juzs`);
  const byNumber = new Map();
  for (const j of data.juzs) {
    if (byNumber.has(j.juz_number)) continue;
    const ranges = {};
    for (const [s, r] of Object.entries(j.verse_mapping)) {
      const [from, to] = r.split('-').map(Number);
      ranges[s] = [from, to];
    }
    byNumber.set(j.juz_number, { juz: j.juz_number, ranges, count: j.verses_count });
  }
  return [...byNumber.values()].sort((a, b) => a.juz - b.juz);
}

// { [ayah]: { start, end } } in milliseconds.
export async function getTimings(reciter, surah) {
  const data = await getJson(`${MP3}/ayat_timing?surah=${surah}&read=${reciter.timingRead}`);
  const map = {};
  for (const x of data) {
    if (x.ayah > 0 && x.end_time > x.start_time) map[x.ayah] = { start: x.start_time, end: x.end_time };
  }
  return map;
}

const surahLists = new Map();
async function surahList(reciter) {
  if (!surahLists.has(reciter.id)) {
    const p = getJson(`${MP3}/reciters?language=eng&reciter=${reciter.mp3quranId}`).then((d) => {
      const r = d.reciters?.[0];
      const m = r?.moshaf?.find((x) => x.id === reciter.moshafId) || r?.moshaf?.[0];
      return new Set(String(m.surah_list).split(',').map(Number));
    });
    surahLists.set(reciter.id, p);
    p.catch(() => surahLists.delete(reciter.id));
  }
  return surahLists.get(reciter.id);
}

export async function isAvailable(reciter, surah) {
  try {
    return (await surahList(reciter)).has(surah);
  } catch {
    return true; // can't tell (offline?) – let the audio element try
  }
}

export const audioUrl = (reciter, surah) => `${reciter.server}${String(surah).padStart(3, '0')}.mp3`;

// Offline audio: whole-surah files saved in Cache Storage and played back from a blob URL.
export async function resolveAudio(url) {
  try {
    const cache = await caches.open(AUDIO_CACHE);
    const hit = await cache.match(url);
    if (hit) return URL.createObjectURL(await hit.blob());
  } catch { /* fall through */ }
  return url;
}

export async function isSavedOffline(url) {
  try {
    return !!(await (await caches.open(AUDIO_CACHE)).match(url));
  } catch {
    return false;
  }
}

export async function saveOffline(url) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  await (await caches.open(AUDIO_CACHE)).put(url, res);
}

export async function removeOffline(url) {
  try { await (await caches.open(AUDIO_CACHE)).delete(url); } catch { /* ignore */ }
}
