// "Understand before you memorize": classical tafsir for the range being memorized, fetched from Quran.com.
//   - Ibn Kathir (Abridged), English: its section headings give the flow of a passage; each section's text is the
//     explanation (stories and reasons for revelation are told there, as the tafsir tells them).
//   - Tazkirul Quran (Maulana Wahiduddin Khan): short explanations of groups of ayat.
// The texts are fetched at runtime (not stored in the app) and shown as plain text. Ibn Kathir's sections are mapped
// to ayat by matching the Arabic it quotes against the ayat of the surah.

const QURAN = 'https://api.quran.com/api/v4';
export const IBN_KATHIR = 169;
export const TAZKIRUL = 817;
export const SOURCES = 'Ibn Kathir (Abridged) and Tazkirul Quran (Maulana Wahiduddin Khan), via Quran.com';

const memo = new Map();
async function getJson(url) {
  if (!memo.has(url)) {
    const p = fetch(url).then((r) => { if (!r.ok) throw new Error(`Request failed (${r.status})`); return r.json(); });
    memo.set(url, p);
    p.catch(() => memo.delete(url));
  }
  return memo.get(url);
}

async function entries(id, surah) {
  const out = [];
  let page = 1;
  for (let guard = 0; guard < 20; guard++) {
    const d = await getJson(`${QURAN}/tafsirs/${id}/by_chapter/${surah}?per_page=50&page=${page}`);
    out.push(...d.tafsirs);
    const next = d.pagination && d.pagination.next_page;
    if (!next) break;
    page = next;
  }
  return out.filter((t) => t.text && t.text.trim());
}

const ayahOf = (key) => Number(String(key).split(':')[1]);

// ---------- text helpers (no HTML is ever inserted as-is) ----------

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function textOf(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENT[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

// HTML → blocks: [{ type: 'h' | 'p', text, arabic }]
function blocks(html) {
  const out = [];
  const re = /<(h[1-4]|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m, last = 0, any = false;
  while ((m = re.exec(html))) {
    any = true;
    const between = textOf(html.slice(last, m.index));
    if (between) out.push(block('p', between));
    out.push(block(m[1][0].toLowerCase() === 'h' ? 'h' : 'p', textOf(m[2])));
    last = re.lastIndex;
  }
  const tail = textOf(html.slice(last));
  if (tail) out.push(block('p', tail));
  if (!any && !out.length) out.push(block('p', textOf(html)));
  return out.filter((b) => b.text);
}

function block(type, text) {
  const letters = text.replace(/[^\p{L}]/gu, '');
  const arabicLetters = letters.replace(/[^؀-ۿ]/g, '');
  return { type, text, arabic: letters.length > 0 && arabicLetters.length / letters.length > 0.7 };
}

// Arabic skeleton for matching: no vowels or Quranic marks, one form per letter family
export function skeleton(s) {
  return String(s)
    .replace(/[ؐ-ًؚ-ٰٟۖ-ۭـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[^ء-ي]/g, '');
}

function similarity(seg, ayah) {
  if (!seg || !ayah) return 0;
  if (ayah.includes(seg)) return 1;
  // compare against the start of the ayah (quotes often begin an ayah)
  const a = ayah.slice(0, seg.length + 2);
  const n = seg.length, m = a.length;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (seg[i - 1] === a[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - Math.min(...prev) / n;
}

// Some headings in the source run into the first sentence ("The Location of the Cave This indicates that…").
// Keep the heading and hand the rest back to the text.
const STARTERS = new Set(['Here', 'This', 'These', 'Allah', 'In', 'When', 'After', 'It', 'He', 'They', 'Then', 'So', 'Meaning', 'Indeed', 'There', 'We', 'Such', 'Thus', 'As', 'Imam', 'Al-Bukhari', 'Muslim', 'Ahmad', 'Abu', 'Ibn', 'The']);
const SMALL = new Set(['of', 'the', 'and', 'in', 'a', 'an', 'to', 'for', 'on', 'by', 'with', 'from', 'his', 'her', 'their', 'its', 'over', 'about', 'as', 'at', 'is', 'are', 'be', 'not', 'or', 'that', 'who', 'what', 'which', 'him', 'them', 'he', 'they', 'all', 'has', 'have', 'had', 'was', 'were', 'will', 'would', 'can', 'could', 'may', 'shall', 'should', 'no']);
const CONNECT = new Set(['Who', 'Whom', 'Whose', 'Which', 'That', 'When', 'Where', 'What', 'And', 'Or', 'But', 'If', 'Is', 'Are']);
const lowerWords = (ws) => ws.filter((w) => /^[a-z]/.test(w) && !SMALL.has(w)).length;
export function splitHeading(text) {
  if (text.length <= 60) return [text, ''];
  const words = text.split(' ');
  // cut before word k; the title must still read as a title
  const cut = (k) => {
    const title = words.slice(0, k).join(' ').replace(/[\s:,;`'"-]+$/, '');
    return title.length >= 12 ? [title, words.slice(k).join(' ')] : null;
  };
  // numbered points: "…Ten Complete Arabic Sentences 1. Allah's statement,"
  const num = words.findIndex((w, k) => k > 2 && /^\d+\.$/.test(w));
  if (num > 0) { const r = cut(num); if (r) return r; }
  if (text.length < 90) return [text, ''];
  for (let k = 3; k < words.length - 2; k++) {
    const w = words[k], prev = words[k - 1];
    const sentence = lowerWords(words.slice(k + 1, k + 9)) >= 3;
    if (!sentence || /[,;]$/.test(prev) || CONNECT.has(prev[0].toUpperCase() + prev.slice(1))) continue;
    // "…when death approaches Allah tells us…"
    const says = (w === 'Allah' || w === 'He') && /^(says|said|tells|states|informs|describes|mentions|threatens|commands|reminds|addresses|praises)$/.test(words[k + 1]);
    // "…of the Cave This indicates…": a title ends on a capitalised word, not on "before", "of", "to"
    const starts = STARTERS.has(w) && /^[A-Z(]|[).]$/.test(prev);
    if (says || starts) { const r = cut(k); if (r) return r; }
  }
  const colon = text.indexOf(': ');
  if (colon > 15 && colon < 90 && text.length - colon > 60) return [text.slice(0, colon), text.slice(colon + 2)];
  return [text, ''];
}

// ---------- Ibn Kathir: sections with ayah ranges ----------

// ayat: [{ n, text }] for the whole surah. Returns { intro: [blocks], sections: [{ from, to, title, blocks }] }
const mapped = new Map();
export function ibnKathir(surah, ayat) {
  if (!mapped.has(surah)) {
    const p = mapIbnKathir(surah, ayat);
    mapped.set(surah, p);
    p.catch(() => mapped.delete(surah));
  }
  return mapped.get(surah);
}

async function mapIbnKathir(surah, ayat) {
  const list = await entries(IBN_KATHIR, surah);
  const skel = new Map(ayat.map((v) => [v.n, skeleton(v.text)]));
  const last = ayat.length ? ayat[ayat.length - 1].n : 0;
  const starts = list.map((t) => ayahOf(t.verse_key));
  const intro = [];
  const sections = [];
  list.forEach((t, gi) => {
    const gFrom = starts[gi];
    const gTo = gi + 1 < starts.length ? starts[gi + 1] - 1 : last;
    // split the group's text at its headings
    const parts = [];
    for (const b of blocks(t.text)) {
      if (b.type === 'h') {
        const [title, rest] = splitHeading(b.text);
        parts.push({ title, blocks: rest ? [{ type: 'p', text: rest, arabic: false }] : [] });
      } else if (!parts.length) parts.push({ title: '', blocks: [b] });
      else parts[parts.length - 1].blocks.push(b);
    }
    for (const part of parts) {
      // which ayat does this section quote?
      const found = [];
      for (const b of part.blocks) {
        if (!b.arabic) continue;
        for (const seg of b.text.split(/\s[-–]\s|[﴿﴾]/)) {
          const s = skeleton(seg);
          if (s.length < 5) continue;
          let best = null;
          for (let a = gFrom; a <= gTo; a++) {
            const sc = similarity(s, skel.get(a) || '');
            if (sc >= 0.75 && (!best || sc > best.sc)) best = { a, sc };
          }
          if (best) found.push(best.a);
        }
      }
      part.found = found;
      part.gFrom = gFrom;
      part.gTo = gTo;
    }
    // ranges: a section runs from the first ayah it quotes to just before the next section's first ayah
    const first = ayat[0] && ayat[0].n;
    const asText = (p) => [...(p.title ? [{ type: 'h', text: p.title }] : []), ...p.blocks];
    // the surah's virtues / place of revelation, told before the first ayah, belong to the introduction
    const aboutSurah = (p) => gFrom === first && /\b(virtues?|merits?|excellence|revealed in (makkah|madinah|al-madinah)|which was revealed)\b/i.test(p.title);
    let withAyat = parts.filter((p) => p.found.length);
    if (gFrom === first && withAyat.length > 1) withAyat = withAyat.filter((p, i) => !(i === 0 && aboutSurah(p)));
    let cur = null;   // the last section in this group that quotes an ayah
    parts.forEach((p) => {
      if (withAyat.includes(p)) { p.from = p.found[0]; cur = p; return; }
      // no quoted ayah: a surah introduction (before any ayah) or a note inside the group
      if (gFrom === first && !cur) intro.push(...asText(p));
      else (cur || withAyat[0] || sections[sections.length - 1] || { blocks: [] }).blocks.push(...asText(p));
    });
    if (!withAyat.length) {
      // nothing quoted that could be matched: the group still explains its own ayat
      // (at the start of a surah, the opening notes about the surah stay in the introduction)
      let k = 0;
      if (gFrom === first) while (k < parts.length && (!parts[k].title || aboutSurah(parts[k]))) k++;
      const rest = parts.slice(k);
      if (!rest.length) return;
      if (gFrom === first) intro.length -= parts.slice(k).reduce((n, p) => n + asText(p).length, 0);
      sections.push({ from: gFrom, to: gTo, title: rest[0].title, blocks: [...rest[0].blocks, ...rest.slice(1).flatMap(asText)] });
      return;
    }
    withAyat.sort((x, y) => x.from - y.from);
    withAyat.forEach((p, i) => {
      const nextFrom = i + 1 < withAyat.length ? withAyat[i + 1].from : gTo + 1;
      // the group's text begins at its first ayah, so its first section does too
      const from = i === 0 ? gFrom : Math.max(gFrom, Math.min(p.from, nextFrom - 1));
      sections.push({ from, to: Math.max(from, nextFrom - 1), title: p.title, blocks: p.blocks });
    });
  });
  // keep sections in order and without overlaps
  sections.sort((a, b) => a.from - b.from);
  for (let i = 1; i < sections.length; i++) if (sections[i].from <= sections[i - 1].to) sections[i - 1].to = Math.max(sections[i - 1].from, sections[i].from - 1);
  return { intro, sections };
}

// ---------- Tazkirul Quran: short explanations per group (filed under the group's last ayah) ----------

export async function tazkirul(surah) {
  const list = await entries(TAZKIRUL, surah);
  let prevEnd = 0;
  return list.map((t) => {
    const to = ayahOf(t.verse_key);
    const g = { from: prevEnd + 1, to, text: blocks(t.text).map((b) => b.text).join(' ') };
    prevEnd = to;
    return g;
  });
}

// The story or reason for revelation, where Ibn Kathir tells one: the paragraph that says why or about whom the ayat
// were revealed, or the opening of a section titled as a story.
const REVEALED = /\b(reasons? for (its|the|this) revelation|(was|were) revealed (about|concerning|regarding|when|after|because|in response|in connection)|revealed (this|these) (ayah|ayat|surah|verses?)|(ayah|ayat|surah|verses?) (was|were) revealed|sent down (about|concerning|regarding)|(so|then|and) Allah revealed)\b/i;
const ALREADY = /\b(already been (mentioned|discussed)|mentioned (earlier|previously|before))\b/i;
const STORY = /\b(story|stories|reason for (the )?revelation|incident|battle|treaty)\b/i;

function storiesIn(parts) {
  const out = [];
  for (const { title, blocks: bl, from, to } of parts) {
    const paras = bl.filter((b) => b.type === 'p' && !b.arabic && b.text.length > 60);
    const hit = paras.find((b) => REVEALED.test(b.text) && !ALREADY.test(b.text)) || (STORY.test(title || '') ? paras[0] : null);
    if (hit && !out.some((o) => o.text === hit.text)) out.push({ from, to, title, text: hit.text });
  }
  return out;
}

// the introduction split at its headings
function introParts(intro, first) {
  const parts = [];
  for (const b of intro) {
    if (b.type === 'h') parts.push({ title: b.text, blocks: [], from: first, to: first });
    else if (!parts.length) parts.push({ title: '', blocks: [b], from: first, to: first });
    else parts[parts.length - 1].blocks.push(b);
  }
  return parts;
}

// Everything that overlaps ayat [from, to]
export async function forRange(surah, ayat, from, to) {
  const [ik, tz] = await Promise.all([
    ibnKathir(surah, ayat).catch(() => null),
    tazkirul(surah).catch(() => []),
  ]);
  const overlaps = (x) => x.from <= to && x.to >= from;
  const first = ayat[0] && ayat[0].n;
  const intro = ik && from === first ? ik.intro : [];
  const sections = ik ? ik.sections.filter(overlaps) : [];
  return {
    intro,
    sections,
    brief: tz.filter(overlaps),
    stories: [...storiesIn(introParts(intro, first)), ...storiesIn(sections)].slice(0, 3),
    available: !!ik || tz.length > 0,
  };
}

// The Ibn Kathir section an ayah belongs to (for "new section" notes on Move on)
export async function sectionOf(surah, ayat, n) {
  try {
    const ik = await ibnKathir(surah, ayat);
    return ik.sections.find((s) => s.from <= n && n <= s.to) || null;
  } catch {
    return null;
  }
}
