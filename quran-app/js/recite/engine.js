// Recitation checker: compares what the speech model heard (Quran phonetic script, one symbol per sound, with a
// confidence and a time each) against the expected pronunciation of an ayah, and returns a verdict per word.
//
// A JavaScript port of the rule engine ("imam") that ships with the HisnLabs tajweed-v2 model (Apache-2.0), with
// two changes for phones:
//   - breaths (waqf / ibtida) are found from pauses in the recitation instead of a brute-force search;
//   - a recitation that stops part-way is handled: unreached words are "pending" (or "missed" once finished).
//
// Expected pronunciation per ayah comes precomputed (data/phonetic/NNN.json): phonemes, word spans and the tajweed
// units (madd, qalqalah, ikhfa, iqlab, ghunnah, idgham, shadda) the phonetizer tagged.

const LONG = new Set(['ا', 'ۥ', 'ۦ']);
const HARAKAT = new Set(['َ', 'ُ', 'ِ']);
const ONSET = 3;           // first symbols of a breath: not judged for letters (often clipped)
const TIME_SIX = 8.3, TIME_FIVE = 7.0;
const DIFFERENT_WORD = 0.5; // share of a word's core sounds that differ: a different word was recited

const MADD = {
  NormalMaddRule: [[2], 'natural madd'],
  MonfaselMaddRule: [[2, 4, 5], 'separated madd (munfasil)'],
  MottaselMaddRule: [[4, 5, 6], 'joined madd (muttasil)'],
  MottaselMaddPauseRule: [[4, 5, 6], 'joined madd at a stop'],
  LazemMaddRule: [[6], 'necessary madd (lazim)'],
  AaredMaddRule: [[2, 4, 6], 'madd before a stop (ʿarid)'],
  LeenMaddRule: [[2, 4, 6], 'soft madd (lin)'],
  BadalMadd: [[2], 'madd after a hamza (badal)'],
  LeenHamzaMadd: [[4, 6], 'soft madd before a hamza (lin)'],
};
const VOWEL = { 'َ': 'a (fatha)', 'ُ': 'u (damma)', 'ِ': 'i (kasra)' };

const counts = (n) => `${n} counts`;

// ---------- edit distance with alignment (Levenshtein opcodes) ----------

export function opcodes(a, b) {
  const n = a.length, m = b.length, w = m + 1;
  const d = new Int32Array((n + 1) * w);
  for (let j = 0; j <= m; j++) d[j] = j;
  for (let i = 1; i <= n; i++) {
    d[i * w] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= m; j++) {
      const sub = d[(i - 1) * w + j - 1] + (ai === b[j - 1] ? 0 : 1);
      const del = d[(i - 1) * w + j] + 1;
      const ins = d[i * w + j - 1] + 1;
      d[i * w + j] = sub < del ? (sub < ins ? sub : ins) : (del < ins ? del : ins);
    }
  }
  // backtrace into edit operations
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const cur = d[i * w + j];
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && cur === d[(i - 1) * w + j - 1]) { ops.push(['equal', i - 1, j - 1]); i--; j--; }
    else if (i > 0 && j > 0 && cur === d[(i - 1) * w + j - 1] + 1) { ops.push(['replace', i - 1, j - 1]); i--; j--; }
    else if (i > 0 && cur === d[(i - 1) * w + j] + 1) { ops.push(['delete', i - 1, j]); i--; }
    else { ops.push(['insert', i, j - 1]); j--; }
  }
  ops.reverse();
  // group into opcodes (tag, i1, i2, j1, j2)
  const out = [];
  for (const [tag, x, y] of ops) {
    const last = out[out.length - 1];
    const di = tag === 'insert' ? 0 : 1, dj = tag === 'delete' ? 0 : 1;
    if (last && last[0] === tag && last[2] === x && last[4] === y) { last[2] += di; last[4] += dj; }
    else out.push([tag, x, x + di, y, y + dj]);
  }
  return out;
}

export function distance(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Int32Array(b.length + 1), cur = new Int32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= b.length; j++) {
      const sub = prev[j - 1] + (ai === b[j - 1] ? 0 : 1);
      const del = prev[j] + 1, ins = cur[j - 1] + 1;
      cur[j] = sub < del ? (sub < ins ? sub : ins) : (del < ins ? del : ins);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

function boundaries(ref, heard) {
  const b = new Array(ref.length + 1).fill(0);
  for (const [, i1, i2, j1, j2] of opcodes(ref, heard)) {
    for (let k = i1; k <= i2; k++) b[k] = j1 + (i2 > i1 ? Math.round(((k - i1) * (j2 - j1)) / (i2 - i1)) : 0);
  }
  b[ref.length] = heard.length;
  return b;
}

function run(heard, a, b, c) {
  let k = -1;
  for (let x = a; x < b; x++) if (heard[x] === c) { k = x; break; }
  if (k < 0) return [0, a, a];
  let s = k, e = k;
  while (s > 0 && heard[s - 1] === c) s--;
  while (e < heard.length && heard[e] === c) e++;
  return [e - s, s, e];
}

function dur(heard, times, s, e) {
  const a = s && HARAKAT.has(heard[s - 1]) ? times[s - 1] : times[s];
  return Math.max(0, times[Math.min(e, times.length - 1)] - a);
}

function stripLen(s) {
  let out = '';
  for (const c of s) if (out[out.length - 1] !== c) out += c;
  return [...out].filter((c) => !LONG.has(c) && !'ںڇ۾'.includes(c)).join('');
}

const setOf = (s) => new Set(s);
const subset = (a, b) => [...a].every((c) => b.has(c));

// ---------- expected pronunciation of part of an ayah ----------

// data: { p, s: [[s,e] per word], u: [[s, e, kindIdx, word, golden, ruleIdx, char]] }, kinds, rules
export function ayahRef(data, kinds, rules) {
  return {
    phonemes: data.p,
    spans: data.s,
    units: data.u.map(([s, e, k, word, golden, r, char]) => ({ s, e, kind: kinds[k], word, golden, rule: r >= 0 ? rules[r] : '', char })),
    words: data.s.length,
  };
}

// Words [a, b) of an ayah, sliced from the whole-ayah pronunciation (context kept; the stop / restart forms at the
// slice edges are approximated, and tolerated by `listen`).
export const sliceRef = (ref, a, b) => slice(ref, a, b);

function slice(ref, a, b) {
  const S = ref.spans[a][0];
  const E = ref.spans[b - 1][1];
  return {
    phonemes: ref.phonemes.slice(S, E),
    spans: ref.spans.slice(a, b).map(([x, y]) => [Math.max(0, x - S), Math.max(0, y - S)]),
    units: ref.units.filter((u) => u.s >= S && u.e <= E && u.word >= a && u.word < b)
      .map((u) => ({ ...u, s: u.s - S, e: u.e - S, word: u.word - a })),
    words: b - a,
  };
}

// ---------- one breath ----------

function tempoOf(ref, heard, b, times, stopWords) {
  if (!times || times.length !== heard.length + 1) return null;
  const nat = [];
  for (const u of ref.units) {
    if (u.kind === 'madd' && u.rule === 'NormalMaddRule' && u.word !== ref.words - 1 && !stopWords.has(u.word)) {
      const [n, s, e] = run(heard, Math.max(0, b[u.s] - 1), Math.min(heard.length, b[u.e] + 1), u.char);
      if (n >= 1 && n <= 3) {
        const d = dur(heard, times, s, e);
        if (d > 0.08 && d < 2) nat.push(d);
      }
    }
  }
  if (nat.length < 2) return null;
  nat.sort((x, y) => x - y);
  return nat[Math.floor(nat.length / 2)] / 2;
}

// ref: expected pronunciation (one or more breaths joined); heard/probs/times: what the model heard.
// ref.breaths: [{ s, e, stop, word }] phoneme ranges of each breath; `stop` = it ends with a stop inside the ayah
// (the pausal form is not in `ref`), `word` = index of its last word. Restart / stop edges are tolerated.
export function listen(ref, heard, probs, times, { minProb = 0.6, minProbJali = 0.9 } = {}) {
  const breaths = ref.breaths || [{ s: 0, e: ref.phonemes.length, stop: false, word: ref.words - 1 }];
  const stopWords = new Set(breaths.filter((x) => x.stop).map((x) => x.word));
  const inOnset = (i) => breaths.some((x) => i >= x.s && i < x.s + ONSET);
  const inStopTail = (i) => breaths.some((x) => x.stop && i >= x.e - 3 && i <= x.e);
  const b = boundaries(ref.phonemes, heard);
  const notes = Array.from({ length: ref.words }, () => []);
  const covered = new Array(ref.phonemes.length).fill(false);
  let span = [0, 0];
  const unsure = (hs, he, thr = minProb) => {
    if (!probs || !probs.length) return false;
    const seg = probs.slice(Math.max(0, hs - 1), Math.min(probs.length, he + 1));
    return seg.length > 0 && Math.min(...seg) < thr;
  };
  const add = (w, rule, severity, msg) => {
    if (unsure(span[0], span[1])) return;
    notes[w].push({ rule, severity, msg });
  };
  const moreNun = (u, hs, he) =>
    (heard.slice(Math.max(0, hs - 2), he).match(/ن/g) || []).length > (ref.phonemes.slice(Math.max(0, u.s - 2), u.e).match(/ن/g) || []).length;

  const lastWord = ref.words - 1;
  const unit = tempoOf(ref, heard, b, times, stopWords);
  for (const u of ref.units) {
    for (let x = u.s; x < u.e; x++) covered[x] = true;
    const hs = b[u.s], he = b[u.e];
    span = [hs, he];
    if (u.kind === 'madd') {
      let [n, rs, re] = run(heard, Math.max(0, hs - 1), Math.min(heard.length, he + 1), u.char);
      if (u.rule.startsWith('Leen') && n > 0) n += 1;
      let allowed = MADD[u.rule][0];
      // a natural madd on the word before a stop becomes ʿarid (2, 4 or 6)
      if (stopWords.has(u.word) && u.rule === 'NormalMaddRule') allowed = [2, 4, 6];
      if (unit && (n === 4 || n === 5)) {
        const tc = dur(heard, times, rs, re) / unit;
        n = tc >= TIME_SIX ? 6 : tc >= TIME_FIVE ? 5 : 4;
      }
      const name = MADD[u.rule][1];
      const near = allowed.reduce((p, a) => (Math.abs(a - n) < Math.abs(p - n) ? a : p), allowed[0]);
      if (n === 0 && !u.rule.startsWith('Leen')) {
        add(u.word, u.rule, 'jali', `${name} dropped: the vowel must be lengthened`);
      } else if (Math.abs(n - near) > 1 && !unsure(hs, he)) {
        const want = allowed.includes(u.golden) ? u.golden : near;
        notes[u.word].push({ rule: u.rule, severity: 'khafi', msg: `${name} too ${n > near ? 'long' : 'short'}: ${counts(n)} instead of ${counts(want)}` });
      }
    } else if (u.kind === 'qalqalah') {
      if (!heard.slice(Math.max(0, hs - 1), he + 1).includes('ڇ')) {
        add(u.word, 'qalqalah', 'khafi', `qalqalah missing on ${u.s ? ref.phonemes[u.s - 1] : ''}: let it bounce`);
      }
    } else if (u.kind === 'ikhfa') {
      const [n] = run(heard, hs, Math.max(he, hs + 1), 'ں');
      if (n === 0 && heard.slice(hs, he + 1).includes('ن')) add(u.word, 'ikhfa', 'khafi', 'ikhfaʾ: the nun was pronounced clearly; hide it with ghunnah');
      else if (n && n < u.golden - 1) add(u.word, 'ikhfa', 'khafi', 'ikhfaʾ: the ghunnah is too short');
    } else if (u.kind === 'iqlab') {
      if (!heard.slice(Math.max(0, hs - 1), he + 1).includes('۾')) add(u.word, 'iqlab', 'khafi', 'iqlab: the nun becomes a hidden mim with ghunnah before ب');
    } else if (u.kind === 'ghunnah' || u.kind === 'idgham_ghunnah') {
      const [n] = run(heard, Math.max(0, hs - 1), Math.min(heard.length, he + 1), u.char);
      if (u.kind === 'idgham_ghunnah' && u.char !== 'ن' && moreNun(u, hs, he)) add(u.word, 'idgham', 'khafi', `idgham: the nun was pronounced; merge it into ${u.char}`);
      else if (n < u.golden) add(u.word, u.kind, 'khafi', u.kind === 'ghunnah' ? 'ghunnah too short: hold the nasal sound for 2 counts' : 'idgham with ghunnah: the ghunnah is missing');
    } else if (u.kind === 'shadda' || u.kind === 'idgham') {
      const [n] = run(heard, Math.max(0, hs - 1), Math.min(heard.length, he + 1), u.char);
      if (u.kind === 'idgham' && moreNun(u, hs, he)) add(u.word, 'idgham', 'khafi', `idgham: the nun was pronounced; merge it into ${u.char}`);
      else if (n === 1) add(u.word, 'shadda', 'jali', `the shadda on ${u.char} was not pronounced`);
    }
  }

  // whatever the rules did not explain: other letters, vowels, dropped or added sounds (clear mistakes)
  const extra = new Set([...LONG, 'ڇ', 'ں', '۾', 'ن', 'م']);
  for (const [tag, i1, i2, j1, j2] of opcodes(ref.phonemes, heard)) {
    if (tag === 'equal') continue;
    const exp = ref.phonemes.slice(i1, i2), got = heard.slice(j1, j2);
    if (i2 > i1 && covered.slice(i1, i2).every(Boolean) && (!got || subset(setOf(got), new Set([...setOf(exp), ...extra])))) continue;
    if (tag === 'insert' && ref.units.some((u) => u.kind === 'madd' && u.s <= i1 && i1 <= u.e && subset(setOf(got), new Set([u.char])))) continue;
    if (inStopTail(i1) && (tag === 'delete' || tag === 'replace')) continue; // pausal ending at a stop inside the ayah
    // a short stop on a word (waqf): its final vowel / tanween falls silent, or a qalqalah letter bounces instead
    if ((tag === 'delete' || tag === 'replace') && ref.spans.some(([, z]) => i2 === z || i2 === z - 1)) {
      const expCore = [...exp].filter((c) => !LONG.has(c));
      const pausalEnd = expCore.length && expCore.every((c) => HARAKAT.has(c) || c === 'ن');
      const gap = times && times.length > j2 ? times[Math.min(j2, times.length - 1)] - times[Math.max(0, Math.min(j2, times.length - 1) - 1)] : 0;
      if (pausalEnd && (got === 'ڇ' || (!got.length && gap >= 0.3) || (got === 'ڇ'))) continue;
    }
    if (tag === 'insert' && inOnset(i1)) continue; // a restart voices its hamzat wasl
    let w = ref.spans.findIndex(([a, z]) => a <= i1 && i1 < z);
    if (w < 0) w = lastWord;
    span = [j1, j2];
    if (inOnset(i1)) continue;
    const eCore = stripLen(exp), gCore = stripLen(got);
    if (eCore === gCore) continue;
    if (unsure(j1, j2, minProbJali)) continue;
    if (tag === 'replace' && eCore.length === 1 && gCore.length === 1 && HARAKAT.has(eCore) && HARAKAT.has(gCore)) {
      notes[w].push({ rule: 'vowel', severity: 'jali', msg: `wrong vowel: ${VOWEL[gCore]} instead of ${VOWEL[eCore]}` });
    } else if (tag === 'replace') {
      add(w, 'letter', 'jali', `pronounced ${got} instead of ${exp}`);
    } else if (tag === 'delete') {
      if (exp.length === 1 && (LONG.has(exp) || HARAKAT.has(exp))) continue;
      if (!unsure(span[0], span[1])) notes[w].push({ rule: 'dropped', severity: 'jali', msg: `a sound was dropped: ${exp}`, size: eCore.length });
    } else if (tag === 'insert') {
      if (i1 === 0 || i1 === ref.phonemes.length) continue;
      if (subset(setOf(got), LONG)) {
        if (got.length >= 2) add(w, 'madd_added', 'khafi', 'a vowel lengthened where there is no madd');
        continue;
      }
      if (got.length === 1 && HARAKAT.has(got)) continue;
      add(w, 'added', 'jali', `an extra sound: ${got}`);
    }
  }

  // a different word: most of its core sounds differ (judged whatever the model's confidence, as a teacher would)
  ref.spans.forEach(([a, z], k) => {
    if (z <= a || notes[k].some((n) => n.rule === 'different')) return;
    const exp = stripLen(ref.phonemes.slice(a, z)), got = stripLen(heard.slice(b[a], b[z]));
    if (exp.length >= 3 && distance(exp, got) / exp.length >= DIFFERENT_WORD) {
      notes[k].push({ rule: 'different', severity: 'jali', msg: 'a different word was heard here' });
    }
  });

  // a word whose sounds are (almost) all missing was skipped
  ref.spans.forEach(([a, z], k) => {
    if (z > a && b[z] - b[a] <= Math.max(0, Math.floor((z - a) / 4))) {
      notes[k] = [{ rule: 'word', severity: 'jali', msg: 'this word was not heard' }];
    }
  });
  return notes;
}

// ---------- a whole ayah, possibly in several breaths, possibly unfinished ----------

// red ('missed' / 'wrong') only for clear-cut mistakes: a skipped word, a different word, another consonant.
// Single-sound remarks (a vowel, a shadda, one dropped or extra sound) are where the model's false alarms
// concentrate, so they are shown softly with the tajweed points ('tajweed': underlined, tap to explain).
const RED = new Set(['different', 'letter']);
export function verdictOf(notes) {
  if (!notes) return 'pending';
  if (!notes.length) return 'ok';
  if (notes.some((n) => n.rule === 'word')) return 'missed';
  if (notes.some((n) => RED.has(n.rule) || (n.rule === 'dropped' && n.size >= 2))) return 'wrong';
  return 'tajweed';
}

// Where in the heard symbols does this whole ayah end? j such that text[0:j] matches the full expected ayah best
// (one alignment; ties go to the longer prefix so a held last sound stays with the ayah).
export function ayahEndIn(ref, text) {
  const P = ref.phonemes, m = text.length;
  let prev = new Int32Array(m + 1), cur = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= P.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + (P[i - 1] === text[j - 1] ? 0 : 1);
      const del = prev[j] + 1, ins = cur[j - 1] + 1;
      cur[j] = sub < del ? (sub < ins ? sub : ins) : (del < ins ? del : ins);
    }
    [prev, cur] = [cur, prev];
  }
  let best = 0;
  for (let j = 1; j <= m; j++) if (prev[j] <= prev[best]) best = j;
  return { end: best, cost: prev[best] / Math.max(1, P.length) };
}

// The first `j` heard symbols (with their probabilities and times).
export const heardPrefix = (h, j) => ({ text: h.text.slice(0, j), probs: h.probs.slice(0, j), times: h.times.slice(0, j).concat([h.times[j] ?? h.times[h.times.length - 1]]) });

// Several breaths joined into one reference (as the reciter delivered them): parts = [[a, b], ...] word ranges.
function joinParts(ref, parts, endsAtAyahEnd) {
  let phonemes = '';
  const spans = [], units = [], index = [], breaths = [];
  for (const [a, b] of parts) {
    const sub = slice(ref, a, b);
    const o = phonemes.length, w0 = index.length;
    phonemes += sub.phonemes;
    sub.spans.forEach(([x, y]) => spans.push([x + o, y + o]));
    sub.units.forEach((u) => units.push({ ...u, s: u.s + o, e: u.e + o, word: u.word + w0 }));
    for (let k = a; k < b; k++) index.push(k);
    breaths.push({ s: o, e: phonemes.length, stop: false, word: index.length - 1, last: b });
  }
  breaths.forEach((x, i) => { x.stop = i < breaths.length - 1 || !endsAtAyahEnd; });
  return { phonemes, spans, units, words: index.length, index, breaths };
}

const partsText = (ref, parts) => parts.map(([a, b]) => ref.phonemes.slice(ref.spans[a][0], ref.spans[b - 1][1])).join('');

// heard: { text, probs, times } (times has one extra entry: the end of the last symbol).
// final: the reciter has finished this ayah (unreached words are then missed, not pending).
// Returns per word { verdict: 'ok'|'tajweed'|'wrong'|'missed'|'pending', notes }, `done` (all words reached)
// and `reached` (words recited so far).
export function judgeAyah(ref, heard, { final = false, back = 4, margin = 3, ...opts } = {}) {
  const n = ref.words;
  const text = heard.text;
  const empty = (v) => ({ verdict: v, notes: v === 'missed' ? [{ rule: 'word', severity: 'jali', msg: 'this word was not heard' }] : [] });
  if (!text.length) return { words: Array.from({ length: n }, () => empty(final ? 'missed' : 'pending')), done: false, reached: 0, ends: [] };

  // 1. how far did the reciter get? (best-matching prefix of the ayah, from one alignment)
  const P = ref.phonemes, m = text.length;
  let prev = new Int32Array(m + 1), cur = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  const rowEnd = new Int32Array(P.length + 1); // distance of P[0:i] to the whole heard text
  rowEnd[0] = m;
  for (let i = 1; i <= P.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + (P[i - 1] === text[j - 1] ? 0 : 1);
      const del = prev[j] + 1, ins = cur[j - 1] + 1;
      cur[j] = sub < del ? (sub < ins ? sub : ins) : (del < ins ? del : ins);
    }
    rowEnd[i] = cur[m];
    [prev, cur] = [cur, prev];
  }
  let reached = n, bestD = rowEnd[ref.spans[n - 1][1]];
  for (let k = n - 1; k >= 1; k--) {
    const d = rowEnd[ref.spans[k - 1][1]];
    if (d < bestD - 1) { bestD = d; reached = k; } // prefer the longer prefix unless a shorter one is clearly better
  }

  // 2. stops and restarts within [0, reached): greedy, a split must explain `margin` more sounds (as the original)
  let parts = [[0, reached]];
  let best = distance(partsText(ref, parts), text);
  for (let guard = 0; guard < 8; guard++) {
    let cand = null;
    parts.forEach(([a, b], i) => {
      for (let k = a + 1; k < b; k++) {
        for (let j = Math.max(a + 1, k - back); j <= k; j++) {
          const p2 = [...parts.slice(0, i), [a, k], [j, b], ...parts.slice(i + 1)];
          const c = distance(partsText(ref, p2), text);
          if (!cand || c < cand.c) cand = { c, p: p2 };
        }
      }
    });
    if (!cand || cand.c > best - margin) break;
    best = cand.c;
    parts = cand.p;
  }

  // 3. judge all breaths together
  const joined = joinParts(ref, parts, reached >= n);
  const notes = listen(joined, text, heard.probs, heard.times, opts);
  const result = Array.from({ length: n }, () => null);
  joined.index.forEach((w, i) => { result[w] = notes[i]; }); // a word recited again after a restart: the latest counts

  // when each word ended (seconds, from the heard symbols' times): where the next ayah's audio starts
  const bj = boundaries(joined.phonemes, text);
  const ends = new Array(n).fill(null);
  joined.index.forEach((w, i) => {
    const [a, z] = joined.spans[i];
    if (z <= a) return;
    // the heard symbol aligned with the word's last sound, then the time of the symbol after it
    const last = Math.min(bj[z - 1] + 1, text.length);
    ends[w] = heard.times[Math.min(last, heard.times.length - 1)];
  });

  const words = result.map((nt) => (nt ? { verdict: verdictOf(nt), notes: nt } : empty(final ? 'missed' : 'pending')));
  // while still reciting, the word being spoken may be incomplete: keep it pending
  if (!final && reached < n && words[reached - 1] && words[reached - 1].verdict !== 'ok') words[reached - 1] = empty('pending');
  // finished only once the last word itself sounds complete (while reciting, a half-said last word is not done)
  const lastOk = words[n - 1] && (words[n - 1].verdict === 'ok' || words[n - 1].verdict === 'tajweed');
  return { words, done: reached >= n && (final || lastOk), reached, ends: ends.slice(0, reached) };
}
