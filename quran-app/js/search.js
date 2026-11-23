// Find reciters by name, in English or Arabic, forgiving the many ways the names are spelled:
// "Alafasy" / "Alafasi" / "Al-Afasy", "Sudais" / "Alsudaes", "Ajmi" / "Ajmy" / "Ajami", "Huthaifi" / "Hudhaifi".

const ARTICLES = new Set(['al', 'el', 'as', 'ash', 'az', 'ad', 'ar', 'at', 'an']);

// one spelling per sound: doubled letters, ee/i, ou/u, a final y
const plain = (w) => w.replace(/ee/g, 'i').replace(/oo|ou/g, 'u').replace(/ae/g, 'ai').replace(/y$/, 'i').replace(/(.)\1/g, '$1');
// consonants only, with letters that stand for the same Arabic sound folded together
const skel = (w) => w.replace(/ph/g, 'f').replace(/[dt]h|z/g, 'z').replace(/[qc]/g, 'k').replace(/[aeiou]/g, '').replace(/(?!^)y/g, '').replace(/(.)\1+/g, '$1');

function latinWords(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z]+/)
    .filter((w) => w && !ARTICLES.has(w))
    .map((w) => (w.length > 4 && w.startsWith('al') ? w.slice(2) : w))   // "Alsudaes" → "sudaes"
    .map(plain);
}

function arabicWords(s) {
  return String(s)
    .replace(/[\u064B-\u0652\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .split(/[^\u0621-\u064A]+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.startsWith('ال') ? w.slice(2) : w));   // "العفاسي" → "عفاسي"
}

const isArabic = (s) => /[\u0600-\u06FF]/.test(s);

// How well one query word fits a name: 4 start of the first name, 3 start of a word, 2 inside a word,
// 1 same consonants (a different spelling, for words of 4+ letters), 0 not at all
function wordScore(q, words, skels) {
  let best = 0;
  words.forEach((w, i) => {
    if (w.startsWith(q)) best = Math.max(best, i === 0 ? 4 : 3);
    else if (w.includes(q)) best = Math.max(best, 2);
    else if (skels && q.length >= 4) {
      const s = skel(q);
      if (s.length >= 2 && skels[i].startsWith(s)) best = Math.max(best, 1);
    }
  });
  return best;
}

// list: [{ id, name, nameAr, style, popular }]. Returns the matching reciters, best first
// (among equally good matches: favorites, then well-known reciters).
export function searchReciters(list, query, { favorites = new Set() } = {}) {
  const arabic = isArabic(query);
  const q = arabic ? arabicWords(query) : latinWords(query);
  if (!q.length) return [];
  const out = [];
  for (const r of list) {
    const words = arabic ? arabicWords(r.nameAr || '') : latinWords(`${r.name} ${r.style || ''}`);
    if (!words.length) continue;
    const skels = arabic ? null : words.map(skel);
    let score = 0;
    for (const w of q) {
      const s = wordScore(w, words, skels);
      if (!s) { score = 0; break; }
      score += s;
    }
    // "abdul basit" for "Abdulbasit", "عبد الرحمن" for "عبدالرحمن"
    if (!score && words.join('').includes(q.join(''))) score = 2 * q.length;
    if (score) out.push({ r, score });
  }
  out.sort((a, b) => b.score - a.score
    || (favorites.has(b.r.id) ? 1 : 0) - (favorites.has(a.r.id) ? 1 : 0)
    || (b.r.popular ? 1 : 0) - (a.r.popular ? 1 : 0)
    || a.r.name.localeCompare(b.r.name)
    || (a.r.style ? 1 : 0) - (b.r.style ? 1 : 0));   // the plain recitation before the Mujawwad one
  return out.map((x) => x.r);
}
