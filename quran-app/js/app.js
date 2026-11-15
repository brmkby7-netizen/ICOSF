import * as api from './api.js';
import * as store from './storage.js';
import { Player } from './player.js';
import { renderMarker } from './marker.js';
import { $, esc, arNum, fmtDuration, maxContiguous, toast, icons } from './ui.js';

const TOTAL_AYAT = 6236;
const view = $('#view');
const bar = $('#player');
const player = new Player();

let settings = store.getSettings();
let chapters = [];
let current = null; // { num, chapter, verses, timings, audioUrl }
let cleanup = null;
let lastHighlighted = null;

player.setRate(settings.speed);
applyTheme();

// ---------- helpers ----------

function saveSettings(patch) {
  settings = { ...settings, ...patch };
  store.saveSettings(settings);
}

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
}

async function ensureChapters() {
  if (!chapters.length) chapters = await api.getChapters();
}

const loading = (label = 'Loading…') => `<div class="loading" aria-busy="true"><span class="spinner"></span>${esc(label)}</div>`;

const notice = (text, actions = '') =>
  `<div class="notice"><p>${text}</p>${actions ? `<div class="btn-row">${actions}</div>` : ''}</div>`;

function errorView(err) {
  const offline = !navigator.onLine;
  return `<div class="empty">
    <h2>${offline ? 'You’re offline' : 'Something went wrong'}</h2>
    <p class="muted">${offline
      ? 'This page hasn’t been saved for offline use yet. Connect to the internet and try again.'
      : esc(err?.message || 'Please try again.')}</p>
    <button class="btn" onclick="location.reload()">Try again</button>
  </div>`;
}

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
// Precise percentage for headline numbers, so a few ayat don't read as 0%.
const pctLabel = (a, b) => {
  const p = b ? (a / b) * 100 : 0;
  if (p === 0 || p >= 10) return `${Math.round(p)}%`;
  return `${p < 0.1 ? '<0.1' : p.toFixed(1)}%`;
};
const progressBar = (p) => `<span class="bar" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><i style="width:${p}%"></i></span>`;

// ---------- router ----------

async function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  if (!player.session) hideBar();
  const [page, arg] = location.hash.replace(/^#\/?/, '').split('/');
  for (const a of document.querySelectorAll('[data-nav]')) {
    a.classList.toggle('active', a.dataset.nav === (page === 'progress' ? 'progress' : ''));
  }
  try {
    if (page === 'surah') await surahView(Number(arg));
    else if (page === 'mark') await markView(Number(arg));
    else if (page === 'progress') await progressView();
    else await homeView();
  } catch (err) {
    console.error(err);
    view.innerHTML = errorView(err);
  }
}

window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });

// ---------- home ----------

async function homeView() {
  view.innerHTML = loading();
  await ensureChapters();
  const last = store.getLast();
  const lastCh = last && chapters[last.surah - 1];
  const done = store.totalMemorized();

  view.innerHTML = `
    ${lastCh ? `
      <a class="card continue" href="#/surah/${last.surah}">
        <span class="eyebrow">Continue</span>
        <span class="continue-row">
          <strong>${esc(lastCh.name_simple)}</strong>
          <span class="muted">Ayat ${last.from}–${last.to}</span>
        </span>
      </a>` : `
      <section class="card intro">
        <h1>Memorize ayah by ayah</h1>
        <p class="muted">Pick a surah, choose a range, and Hifz builds it up for you: ayah 1, then 1–2, then 1–3, repeating each step until it sticks.</p>
      </section>`}
    ${done ? `<a href="#/progress" class="summary-link"><span>${done} of ${TOTAL_AYAT} ayat memorized</span>${progressBar(pct(done, TOTAL_AYAT))}</a>` : ''}
    <div class="search">
      <input type="search" id="q" placeholder="Search by name or number" aria-label="Search surahs" autocomplete="off">
    </div>
    <ol class="surah-list" id="list">${chapters.map(surahRow).join('')}</ol>
    <p class="empty-search muted" id="no-results" hidden>No surah matches that search.</p>`;

  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  $('#q').addEventListener('input', (e) => {
    const q = norm(e.target.value.trim());
    let shown = 0;
    for (const li of $('#list').children) {
      li.hidden = !!q && !li.dataset.search.includes(q);
      if (!li.hidden) shown++;
    }
    $('#no-results').hidden = shown > 0;
  });
}

function surahRow(c) {
  const done = store.countMemorized(c.id);
  const search = `${c.id} ${c.name_simple} ${c.translated_name.name}`.toLowerCase().replace(/[^a-z0-9 ]/g, '');
  return `<li data-search="${esc(search)}">
    <a href="#/surah/${c.id}" class="surah-row">
      <span class="num">${c.id}</span>
      <span class="names">
        <strong>${esc(c.name_simple)}</strong>
        <span class="muted small">${esc(c.translated_name.name)} · ${c.verses_count} ayat</span>
        ${done ? progressBar(pct(done, c.verses_count)) : ''}
      </span>
      <span class="ar surah-ar" lang="ar" dir="rtl">${esc(c.name_arabic)}</span>
    </a>
  </li>`;
}

// ---------- surah ----------

async function surahView(n) {
  if (!(n >= 1 && n <= 114)) { location.hash = '#/'; return; }
  view.innerHTML = loading();
  await ensureChapters();
  const chapter = chapters[n - 1];
  const verses = await api.getVerses(n);
  if (player.session && player.session.meta.surah !== n) player.stop();
  current = { num: n, chapter, verses, timings: null, audioUrl: null };
  renderSurah();
  const offTime = player.onTime(highlight);
  cleanup = () => { offTime(); lastHighlighted = null; };
}

function selectOptions(max, selected) {
  let out = '';
  for (let i = 1; i <= max; i++) out += `<option value="${i}" ${i === selected ? 'selected' : ''}>${i}</option>`;
  return out;
}

function renderSurah() {
  const { num, chapter, verses } = current;
  const mem = store.getMemorizedSet(num);
  const plan = store.getPlan(num);
  const from = plan ? plan.from : 1;
  const to = plan ? plan.to : Math.min(verses.length, 5);

  view.innerHTML = `
    <a href="#/" class="back">${icons.back}<span>Surahs</span></a>
    <header class="surah-head">
      <p class="ar surah-title-ar" lang="ar" dir="rtl">${esc(chapter.name_arabic)}</p>
      <h1>${chapter.id}. ${esc(chapter.name_simple)}</h1>
      <p class="muted">${esc(chapter.translated_name.name)} · ${chapter.verses_count} ayat · ${chapter.revelation_place === 'makkah' ? 'Makki' : 'Madani'}</p>
    </header>

    <section class="card practice" aria-label="Practice">
      <div class="field-row">
        <span class="label">Reciter</span>
        <div class="seg" role="radiogroup" aria-label="Reciter" id="reciters">
          ${Object.values(api.RECITERS).map((r) => `<button type="button" role="radio" data-r="${r.id}" aria-checked="${settings.reciter === r.id}">${esc(r.name)}</button>`).join('')}
        </div>
      </div>
      <div id="audio-status"></div>
      <div id="practice-controls" hidden>
        <div class="grid two">
          <label class="field"><span>From ayah</span><select id="from" data-v="${from}"></select></label>
          <label class="field"><span>To ayah</span><select id="to" data-v="${to}"></select></label>
        </div>
        <div class="grid three">
          <label class="field"><span>Each ayah</span>
            <select id="repeats">${countOptions(settings.repeats)}</select>
          </label>
          <label class="field"><span>Link together</span>
            <select id="link">${countOptions(settings.linkRepeats)}</select>
          </label>
          <label class="field"><span>Pause to recite</span>
            <select id="gap">${[0, 1, 2, 3, 5, 8].map((v) => `<option value="${v}" ${v === settings.gap ? 'selected' : ''}>${v ? `${v} s` : 'None'}</option>`).join('')}</select>
          </label>
        </div>
        <div class="session-choice">
          <button class="btn primary wide" id="start" type="button">${icons.play}<span id="start-label">Start</span></button>
          <p class="plan muted small" id="plan"></p>
        </div>
        <div class="session-choice" id="move-on-box" hidden>
          <button class="btn wide move-on" id="move-on" type="button"><span id="move-on-label"></span>${icons.next}</button>
          <p class="plan muted small" id="move-on-plan"></p>
        </div>
        <p class="plan muted small" id="end-note" hidden></p>
      </div>
    </section>

    <div class="mem-bar">
      <span id="mem-count"></span>
      <span class="mem-actions">
        <button class="link" id="mark-all" type="button">Mark all memorized</button>
        <button class="link" id="clear-all" type="button">Clear</button>
      </span>
    </div>

    ${chapter.bismillah_pre ? '<p class="ar basmala" lang="ar" dir="rtl">بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ</p>' : ''}

    ${tajweedLegend()}

    <div class="ayat${settings.showTranslation ? '' : ' no-tr'}${settings.tajweed ? '' : ' no-tajweed'}" id="ayat">
      ${verses.map((v) => ayahHtml(v, mem.has(v.n))).join('')}
    </div>`;

  updateMemCount();

  $('#reciters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-r]');
    if (!b || b.dataset.r === settings.reciter) return;
    if (player.session) player.stop();
    saveSettings({ reciter: b.dataset.r });
    for (const x of $('#reciters').children) x.setAttribute('aria-checked', String(x.dataset.r === settings.reciter));
    loadAudioState();
  });

  for (const id of ['from', 'to', 'repeats', 'link', 'gap']) $(`#${id}`).addEventListener('change', updatePlan);
  $('#start').addEventListener('click', startRange);
  $('#move-on').addEventListener('click', moveOn);

  $('#ayat').addEventListener('click', (e) => {
    const art = e.target.closest('.ayah');
    if (!art) return;
    const n = Number(art.dataset.n);
    if (e.target.closest('.mem')) toggleMemorized(n, art);
    else if (e.target.closest('.play-one')) playOne(n);
  });

  $('#mark-all').addEventListener('click', () => {
    store.setMemorized(num, new Set(verses.map((v) => v.n)));
    refreshMemorized();
    toast(`${chapter.name_simple} marked as memorized. Masha’Allah!`);
  });
  $('#clear-all').addEventListener('click', () => {
    if (!store.countMemorized(num)) return;
    if (!confirm(`Clear memorized marks for ${chapter.name_simple}?`)) return;
    store.setMemorized(num, new Set());
    refreshMemorized();
  });

  loadAudioState();
}

const TAJWEED_KEY = [
  ['madd-6', 'Necessary madd · 6'],
  ['madd-4', 'Obligatory madd · 4–5'],
  ['madd-246', 'Permissible madd · 2, 4, 6'],
  ['madd-2', 'Normal madd · 2'],
  ['ghunnah', 'Ghunnah · ikhfa · iqlab · idgham with ghunnah'],
  ['qalqalah', 'Qalqalah'],
  ['silent', 'Not pronounced · idgham without ghunnah'],
];

function tajweedLegend() {
  return `<details class="tajweed-key"${settings.tajweed ? '' : ' hidden'}>
    <summary>Tajweed colors</summary>
    <ul>${TAJWEED_KEY.map(([k, label]) => `<li><span class="swatch sw-${k}"></span>${label}</li>`).join('')}</ul>
  </details>`;
}

const ayahHtml = (v, memorized) => `
  <article class="ayah${memorized ? ' memorized' : ''}" data-n="${v.n}" id="a${v.n}">
    <div class="ayah-tools">
      <span class="ayah-num">${v.n}</span>
      <button class="icon-btn play-one" type="button" aria-label="Play ayah ${v.n}" title="Play this ayah">${icons.play}</button>
      <button class="icon-btn mem" type="button" aria-pressed="${memorized}" aria-label="Memorized ayah ${v.n}" title="Mark as memorized">${icons.check}</button>
    </div>
    <p class="ar ayah-text" lang="ar" dir="rtl">${v.html} <span class="ayah-end">${arNum(v.n)}</span></p>
    <p class="tr">${esc(v.translation)}</p>
  </article>`;

function updateMemCount() {
  const n = store.countMemorized(current.num);
  const total = current.verses.length;
  $('#mem-count').innerHTML = `<strong>${n}</strong> of ${total} memorized ${progressBar(pct(n, total))}`;
}

function toggleMemorized(n, art) {
  const set = store.getMemorizedSet(current.num);
  set.has(n) ? set.delete(n) : set.add(n);
  store.setMemorized(current.num, set);
  const on = set.has(n);
  art.classList.toggle('memorized', on);
  art.querySelector('.mem').setAttribute('aria-pressed', String(on));
  updateMemCount();
  if (on && set.size === current.verses.length) toast(`You’ve memorized all of ${current.chapter.name_simple}. Masha’Allah!`);
}

function refreshMemorized() {
  const set = store.getMemorizedSet(current.num);
  for (const art of document.querySelectorAll('.ayah')) {
    const on = set.has(Number(art.dataset.n));
    art.classList.toggle('memorized', on);
    art.querySelector('.mem').setAttribute('aria-pressed', String(on));
  }
  updateMemCount();
}

async function loadAudioState() {
  const r = api.RECITERS[settings.reciter] || api.RECITERS.abkar;
  const { num, verses } = current;
  const box = $('#audio-status');
  const controls = $('#practice-controls');
  current.timings = null;
  current.audioUrl = api.audioUrl(r, num);
  controls.hidden = true;
  box.innerHTML = loading('Loading recitation…');

  const available = await api.isAvailable(r, num);
  if (current?.num !== num || settings.reciter !== r.id) return;
  if (!available) {
    box.innerHTML = notice(`${esc(r.name)}’s recording of this surah isn’t available. Choose another reciter.`);
    return;
  }

  let timings;
  if (r.timingRead) {
    try {
      timings = await api.getTimings(r, num);
    } catch {
      box.innerHTML = notice('Couldn’t load the ayah timings. Check your connection and open this surah again.');
      return;
    }
  } else {
    timings = store.getTimings(r.id, num);
  }
  if (current?.num !== num || settings.reciter !== r.id) return;

  current.timings = timings;
  const marked = Math.min(maxContiguous(timings), verses.length);
  const saved = await api.isSavedOffline(current.audioUrl);
  const offlineBtn = `<button class="link" id="offline" type="button">${saved ? 'Saved offline ✓ · Remove' : 'Save audio for offline'}</button>`;

  if (!r.timingRead && marked === 0) {
    box.innerHTML = notice(
      `To loop ayat with ${esc(r.name)}, mark where each ayah ends. You only do this once per surah: tap along while it plays.`,
      `<a class="btn primary" href="#/mark/${num}">Mark ayah timings</a>
       <button class="btn ghost" id="play-full" type="button">${icons.play}<span>Play whole surah</span></button>`,
    );
    $('#play-full').addEventListener('click', playFull);
    return;
  }

  if (!r.timingRead && marked < verses.length) {
    box.innerHTML = notice(
      `You’ve marked ayat 1–${marked} of ${verses.length}. You can practise those now.`,
      `<a class="btn" href="#/mark/${num}">Continue marking</a>`,
    ) + `<p class="small muted status-line">${offlineBtn}</p>`;
  } else {
    box.innerHTML = `<p class="small muted status-line">
      ${r.timingRead ? 'Ayah timings by mp3quran.net' : `Timings marked by you · <a href="#/mark/${num}">Re-mark</a> · <button class="link" id="clear-timings" type="button">Delete</button>`}
      · ${offlineBtn}</p>`;
  }

  $('#clear-timings')?.addEventListener('click', () => {
    if (!confirm('Delete your ayah timings for this surah?')) return;
    if (player.session) player.stop();
    store.clearTimings(r.id, num);
    loadAudioState();
  });
  $('#offline').addEventListener('click', () => toggleOffline(saved));

  fillRangeSelects(marked);
  controls.hidden = false;
  updatePlan();
}

function fillRangeSelects(max) {
  const from = $('#from'), to = $('#to');
  const f = Math.min(Number(from.value || from.dataset.v) || 1, max);
  const t = Math.min(Number(to.value || to.dataset.v) || max, max);
  from.innerHTML = selectOptions(max, f);
  to.innerHTML = selectOptions(max, Math.max(t, f));
}

function countOptions(selected) {
  return [1, 2, 3, 4, 5, 6, 7, 8, 10, 15, 20]
    .map((v) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${v}×</option>`).join('');
}

function readRange() {
  let from = Number($('#from').value);
  let to = Number($('#to').value);
  if (from > to) [from, to] = [to, from];
  return {
    from,
    to,
    repeats: Number($('#repeats').value),
    link: Number($('#link').value),
    gap: Number($('#gap').value),
  };
}

// Full pattern for a range, e.g. 1–3 with each ayah ×3 and linking ×2:
//   1 ×3 · 2 ×3 · 1–2 ×2 · 3 ×3 · 1–3 ×2
function rangeSteps({ from, to, repeats, link }) {
  const steps = [];
  for (let k = from; k <= to; k++) {
    steps.push({ kind: 'ayah', from: k, to: k, repeats });
    if (k > from) steps.push({ kind: 'link', from, to: k, repeats: link });
  }
  return steps;
}

// Moving on from from–to: the new ayah on its own, then the whole new range linked.
//   2–6: 6 ×3 · 2–6 ×2
function moveOnSteps({ from, to, repeats, link }) {
  return [
    { kind: 'ayah', from: to + 1, to: to + 1, repeats },
    { kind: 'link', from: from + 1, to: to + 1, repeats: link },
  ];
}

function stepsDuration(steps, gap) {
  let ms = 0, plays = 0;
  for (const st of steps) {
    ms += (current.timings[st.to].end - current.timings[st.from].start) * st.repeats;
    plays += st.repeats;
  }
  return ms / settings.speed + Math.max(plays - 1, 0) * gap * 1000;
}

const span = (a, b) => (a === b ? `${a}` : `${a}–${b}`);

function describeSteps(steps) {
  const parts = steps.map((st) => `${span(st.from, st.to)} ×${st.repeats}`);
  return parts.length > 5 ? `${parts.slice(0, 3).join(' · ')} · … · ${parts.at(-1)}` : parts.join(' · ');
}

function updatePlan() {
  if (!current?.timings) return;
  const r = readRange();
  const max = Number($('#to').options.length);
  const steps = rangeSteps(r);
  $('#start-label').textContent = `Start ayat ${span(r.from, r.to)}`;
  $('#plan').textContent = `${describeSteps(steps)} · ${fmtDuration(stepsDuration(steps, r.gap))}`;

  // "Move on" appears once this range has been practised, until the end of the surah.
  const plan = store.getPlan(current.num);
  const started = plan && plan.from === r.from && plan.to === r.to;
  const canMove = started && r.to < max;
  $('#move-on-box').hidden = !canMove;
  if (canMove) {
    const next = moveOnSteps(r);
    $('#move-on-label').textContent = `Move on: ayat ${span(r.from + 1, r.to + 1)}`;
    $('#move-on-plan').textContent = `New ayah ${r.to + 1} ×${r.repeats}, then ${span(r.from + 1, r.to + 1)} together ×${r.link} · ${fmtDuration(stepsDuration(next, r.gap))}`;
  }
  const atEnd = started && r.to >= current.verses.length;
  const end = $('#end-note');
  end.hidden = !(started && r.to >= max);
  end.textContent = atEnd
    ? 'You’ve reached the end of the surah.'
    : `Mark the timings for ayah ${max + 1} onwards to move on further.`;
}

function rememberRange(r) {
  saveSettings({ repeats: r.repeats, linkRepeats: r.link, gap: r.gap });
  store.setPlan(current.num, { from: r.from, to: r.to });
  store.setLast({ surah: current.num, from: r.from, to: r.to });
}

async function startRange() {
  const r = readRange();
  rememberRange(r);
  updatePlan();
  await startSession({ steps: rangeSteps(r), gap: r.gap, title: `ayat ${span(r.from, r.to)}` });
}

async function moveOn() {
  const r = readRange();
  const next = { ...r, from: r.from + 1, to: r.to + 1 };
  if (!current.timings[next.to]) return;
  $('#from').value = String(next.from);
  $('#to').value = String(next.to);
  rememberRange(next);
  updatePlan();
  await startSession({ steps: moveOnSteps(r), gap: r.gap, title: `ayat ${span(next.from, next.to)}` });
}

async function playOne(n) {
  if (!current.timings?.[n]) {
    toast(settings.reciter === 'sobhi' ? 'Mark the ayah timings for this surah first.' : 'Timings for this ayah aren’t available yet.');
    return;
  }
  await startSession({ steps: [{ kind: 'ayah', from: n, to: n, repeats: 1 }], gap: 0, title: `ayah ${n}` });
}

async function playFull() {
  await startSession({ steps: [{ kind: 'full', from: 1, to: 1, repeats: 1 }], gap: 0, title: '' });
}

async function startSession(opts) {
  const r = api.RECITERS[settings.reciter];
  const src = await api.resolveAudio(current.audioUrl);
  player.start({
    ...opts,
    key: current.audioUrl,
    src,
    timings: current.timings,
    meta: {
      surah: current.num,
      surahName: current.chapter.name_simple,
      reciter: r.name,
      title: `${current.chapter.name_simple} ${opts.title}`.trim(),
    },
  });
}

async function toggleOffline(saved) {
  const btn = $('#offline');
  if (saved) {
    await api.removeOffline(current.audioUrl);
    toast('Offline audio removed.');
    loadAudioState();
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Downloading…';
  try {
    await api.saveOffline(current.audioUrl);
    toast('Audio saved. This surah now plays offline.');
  } catch {
    toast('Couldn’t save this audio for offline use.');
  }
  loadAudioState();
}

function highlight(t, session) {
  const step = session.steps[session.i];
  if (!current || session.meta.surah !== current.num || step.kind === 'full' || !current.timings) return;
  let playing = null;
  for (let k = step.from; k <= step.to; k++) {
    const seg = current.timings[k];
    if (seg && t >= seg.start - 50 && t < seg.end) { playing = k; break; }
  }
  if (playing === lastHighlighted) return;
  document.querySelector('.ayah.playing')?.classList.remove('playing');
  lastHighlighted = playing;
  if (playing == null) return;
  const el = document.getElementById(`a${playing}`);
  if (!el) return;
  el.classList.add('playing');
  if (settings.autoscroll && !document.hidden) {
    const r = el.getBoundingClientRect();
    if (r.top < 80 || r.bottom > innerHeight - 140) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ---------- marking ----------

async function markView(n) {
  if (!(n >= 1 && n <= 114)) { location.hash = '#/'; return; }
  view.innerHTML = loading();
  await ensureChapters();
  const chapter = chapters[n - 1];
  const verses = await api.getVerses(n);
  if (player.session) player.stop();
  const r = api.RECITERS[settings.reciter]?.timingRead ? api.RECITERS.sobhi : api.RECITERS[settings.reciter];
  const src = await api.resolveAudio(api.audioUrl(r, n));
  cleanup = renderMarker(view, {
    chapter,
    verses,
    reciter: r,
    src,
    existing: store.getTimings(r.id, n),
    onSave(list) {
      if (!store.setTimings(r.id, n, list)) { toast('Couldn’t save: this device’s storage is full.'); return; }
      saveSettings({ reciter: r.id });
      toast(`Saved timings for ${list.length} ayat.`);
      location.hash = `#/surah/${n}`;
    },
  });
}

// ---------- progress ----------

async function progressView() {
  view.innerHTML = loading();
  await ensureChapters();
  let juzs = null;
  try { juzs = await api.getJuzs(); } catch { /* shown as unavailable */ }

  const done = store.totalMemorized();
  const complete = chapters.filter((c) => store.countMemorized(c.id) === c.verses_count).length;
  const inProgress = chapters.filter((c) => store.countMemorized(c.id) > 0);

  const juzHtml = juzs ? juzs.map((j) => {
    let m = 0;
    for (const [s, [from, to]] of Object.entries(j.ranges)) {
      for (const a of store.getMemorizedSet(Number(s))) if (a >= from && a <= to) m++;
    }
    const p = pct(m, j.count);
    return `<div class="juz${p === 100 ? ' full' : ''}" title="${m} of ${j.count} ayat">
      <span class="juz-n">Juz ${j.juz}</span>
      <span class="juz-p">${pctLabel(m, j.count)}</span>
      ${progressBar(p)}
    </div>`;
  }).join('') : '<p class="muted">Juz overview needs an internet connection the first time.</p>';

  view.innerHTML = `
    <h1 class="page-title">Progress</h1>
    <section class="stats">
      <div class="stat"><span class="stat-n">${done}</span><span class="muted small">of ${TOTAL_AYAT} ayat</span></div>
      <div class="stat"><span class="stat-n">${pctLabel(done, TOTAL_AYAT)}</span><span class="muted small">of the Quran</span></div>
      <div class="stat"><span class="stat-n">${complete}</span><span class="muted small">surahs complete</span></div>
    </section>

    <h2 class="section-title">By juz</h2>
    <div class="juz-grid">${juzHtml}</div>

    <h2 class="section-title">By surah</h2>
    ${inProgress.length
      ? `<ol class="surah-list">${inProgress.map(surahRow).join('')}</ol>`
      : `<div class="empty"><p class="muted">Nothing marked yet. Open a surah and tap ✓ next to each ayah you’ve memorized.</p><a class="btn" href="#/">Browse surahs</a></div>`}`;
}

// ---------- player bar ----------

player.onState((s) => {
  if (s.error) toast(s.error, 5000);
  if (s.done && current && s.meta?.surah === current.num && $('#plan')) {
    updatePlan();
    if (s.count > 1) { showDoneBar(); return; }
  }
  if (!s.active) {
    bar.hidden = true;
    document.body.classList.remove('has-player');
    document.querySelector('.ayah.playing')?.classList.remove('playing');
    lastHighlighted = null;
    return;
  }
  bar.hidden = false;
  document.body.classList.add('has-player');

  let label;
  if (s.kind === 'full') label = 'Whole surah';
  else if (s.kind === 'ayah') label = `Ayah ${s.from}`;
  else label = `Ayat ${s.from}–${s.to} together`;
  if (s.repeats > 1) label += ` · ${s.r} of ${s.repeats}`;
  if (s.count > 1) label = `${s.index + 1}/${s.count} · ${label}`;

  const multi = s.count > 1;
  bar.innerHTML = `
    <div class="player-inner">
      <div class="player-info">
        <a href="#/surah/${s.meta.surah}" class="player-title">${esc(s.meta.surahName)}<span class="wide-only"> · ${esc(s.meta.reciter)}</span></a>
        <span class="player-label">${s.gapping ? '<em>Your turn, recite…</em> · ' : ''}${label}</span>
      </div>
      <div class="player-ctrls">
        ${multi ? `<button class="icon-btn" data-act="prev" aria-label="Previous step" ${s.index === 0 ? 'disabled' : ''}>${icons.prev}</button>` : ''}
        <button class="icon-btn pp" data-act="toggle" aria-label="${s.paused ? 'Resume' : 'Pause'}">${s.paused ? icons.play : icons.pause}</button>
        ${multi ? `<button class="icon-btn" data-act="next" aria-label="Next step" ${s.index >= s.count - 1 ? 'disabled' : ''}>${icons.next}</button>` : ''}
        <button class="icon-btn" data-act="stop" aria-label="Stop">${icons.stop}</button>
      </div>
    </div>
    ${multi ? `<div class="player-progress"><i style="width:${Math.round(s.progress * 100)}%"></i></div>` : ''}`;
});

// After a range session: offer to move on (or repeat) right from the bar.
function showDoneBar() {
  document.querySelector('.ayah.playing')?.classList.remove('playing');
  lastHighlighted = null;
  const { from, to } = readRange();
  const canMove = !$('#move-on-box').hidden;
  bar.hidden = false;
  document.body.classList.add('has-player');
  bar.innerHTML = `
    <div class="player-inner done">
      <div class="player-info">
        <span class="player-title">Ayat ${span(from, to)} done. Well done!</span>
        <span class="player-label">${canMove ? `Ready for ayah ${to + 1}?` : 'Practise again or pick a new range.'}</span>
      </div>
      <div class="player-ctrls">
        <button class="btn ghost small-btn" data-done="again">Again</button>
        ${canMove ? `<button class="btn primary small-btn" data-done="move">Move on ${icons.next}</button>` : ''}
        <button class="icon-btn" data-done="close" aria-label="Close">✕</button>
      </div>
    </div>`;
}

function hideBar() {
  bar.hidden = true;
  document.body.classList.remove('has-player');
}

bar.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act) { player[act](); return; }
  const done = e.target.closest('[data-done]')?.dataset.done;
  if (done === 'close') hideBar();
  else if (done === 'again') startRange();
  else if (done === 'move') moveOn();
});

// ---------- settings ----------

const dlg = $('#settings');
const form = dlg.querySelector('form');

$('#open-settings').addEventListener('click', () => {
  form.theme.value = settings.theme;
  form.showTranslation.checked = settings.showTranslation;
  form.tajweed.checked = settings.tajweed;
  form.autoscroll.checked = settings.autoscroll;
  form.speed.value = String(settings.speed);
  dlg.showModal();
});

form.addEventListener('change', () => {
  saveSettings({
    theme: form.theme.value,
    showTranslation: form.showTranslation.checked,
    tajweed: form.tajweed.checked,
    autoscroll: form.autoscroll.checked,
    speed: Number(form.speed.value),
  });
  applyTheme();
  player.setRate(settings.speed);
  $('#ayat')?.classList.toggle('no-tr', !settings.showTranslation);
  $('#ayat')?.classList.toggle('no-tajweed', !settings.tajweed);
  const key = document.querySelector('.tajweed-key');
  if (key) key.hidden = !settings.tajweed;
  if (current && $('#plan')) updatePlan();
});

dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

$('#export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(store.exportAll(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `hifz-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    store.importAll(JSON.parse(await file.text()));
    settings = store.getSettings();
    applyTheme();
    player.setRate(settings.speed);
    dlg.close();
    toast('Backup restored.');
    route();
  } catch (err) {
    toast(err.message || 'Couldn’t read that file.');
  }
  e.target.value = '';
});

// ---------- boot ----------

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support unavailable */ });
}

route();
