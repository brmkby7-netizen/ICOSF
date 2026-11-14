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

export async function getVerses(surah) {
  const [arabic, english] = await Promise.all([
    getJson(`${QURAN}/quran/verses/uthmani?chapter_number=${surah}`),
    getJson(`${QURAN}/quran/translations/${TRANSLATION_ID}?chapter_number=${surah}`),
  ]);
  return arabic.verses.map((v, i) => ({
    n: Number(v.verse_key.split(':')[1]),
    text: v.text_uthmani.trim(),
    translation: cleanTranslation(english.translations[i]?.text),
  }));
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
