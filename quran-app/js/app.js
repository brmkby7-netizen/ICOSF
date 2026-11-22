import * as api from './api.js';
import * as store from './storage.js';
import { Player } from './player.js';
import { renderMarker } from './marker.js';
import * as revision from './revision.js';
import * as recite from './recite/client.js';
import { ReciteSession } from './recite/session.js';
import { ayahRef } from './recite/engine.js';
import * as context from './context.js';
import { searchReciters } from './search.js';
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
  const tab = page === 'progress' || page === 'settings' ? page : page === 'today' || page === 'review' ? 'today' : '';
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('active', a.dataset.nav === tab);
  updateDueBadge();
  try {
    if (page === 'settings') settingsView();
    else if (page === 'test') await testView(Number(arg));
    else if (page === 'today') await todayView();
    else if (page === 'review') await reviewView();
    else if (page === 'surah') await surahView(Number(arg));
    else if (page === 'mark') await markView(Number(arg));
    else if (page === 'progress') await progressView();
    else await homeView();
  } catch (err) {
    console.error(err);
    view.innerHTML = errorView(err);
  }
  setupNav();
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
    <h1 class="large-title">Surahs</h1>
    ${lastCh ? `
      <a class="card continue" href="#/surah/${last.surah}">
        <span class="continue-row">
          <span class="eyebrow">Continue</span>
          <strong>${esc(lastCh.name_simple)}</strong>
          <span class="muted">Ayat ${last.from}–${last.to}</span>
        </span>
      </a>` : `
      <section class="card intro">
        <h1>Memorize ayah by ayah</h1>
        <p class="muted">Pick a surah, choose a range, and Hifz builds it up for you: ayah 1, then 1–2, then 1–3, repeating each step until it sticks.</p>
      </section>`}
    ${revisionCard()}
    ${done ? `<a href="#/progress" class="summary-link"><span>${done} of ${TOTAL_AYAT} ayat memorized</span>${progressBar(pct(done, TOTAL_AYAT))}</a>` : ''}
    <div class="search">
      <input type="search" id="q" placeholder="Search by name or number" aria-label="Search surahs" autocomplete="off">
    </div>
    <ol class="list surah-list" id="list">${chapters.map(surahRow).join('')}</ol>
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
  const [verses] = await Promise.all([api.getVerses(n), api.getReciters()]);
  if (!settings.reciter || api.reciter(settings.reciter).id !== settings.reciter) saveSettings({ reciter: 'abkar' });
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
  ctxKey = '';
  movedTo = 0;
  const mem = store.getMemorizedSet(num);
  const plan = store.getPlan(num);
  const from = plan ? plan.from : 1;
  const to = plan ? plan.to : Math.min(verses.length, 5);

  view.innerHTML = `
    <a href="#/" class="back">${icons.back}<span>Surahs</span></a>
    <header class="surah-head">
      <p class="ar surah-title-ar" lang="ar" dir="rtl">${esc(chapter.name_arabic)}</p>
      <h1>${esc(chapter.name_simple)}</h1>
      <p class="muted">${chapter.id} · ${esc(chapter.translated_name.name)} · ${chapter.verses_count} ayat · ${chapter.revelation_place === 'makkah' ? 'Makki' : 'Madani'}</p>
    </header>

    <section class="practice" aria-label="Practice">
      <h2 class="list-header">Practice</h2>
      <div class="list">
        <button type="button" class="row chev" id="reciter-btn" aria-haspopup="dialog">
          <span class="row-label">Reciter</span>
          <span class="row-value reciter-value" id="reciter-name">${esc(api.reciterLabel(api.reciter(settings.reciter)))}</span>
        </button>
      </div>
      <div id="audio-status"></div>
      <div id="practice-controls" hidden>
        <div class="list">
          <label class="row"><span class="row-label">From ayah</span><select id="from" class="row-select" data-v="${from}"></select></label>
          <label class="row"><span class="row-label">To ayah</span><select id="to" class="row-select" data-v="${to}"></select></label>
          <label class="row" id="page-row" hidden><span class="row-label">Mushaf page</span><select id="page" class="row-select" aria-label="Mushaf page"></select></label>
        </div>
        <section class="ctx" id="ctx" aria-label="Understand before you memorize"></section>
        <div class="list">
          <label class="row"><span class="row-label">Each ayah</span>
            <select id="repeats" class="row-select">${countOptions(settings.repeats)}</select>
          </label>
          <label class="row"><span class="row-label">Link together</span>
            <select id="link" class="row-select">${countOptions(settings.linkRepeats)}</select>
          </label>
          <label class="row"><span class="row-label">Pause to recite</span>
            <select id="gap" class="row-select">${[0, 1, 2, 3, 5, 8].map((v) => `<option value="${v}" ${v === settings.gap ? 'selected' : ''}>${v ? `${v} s` : 'None'}</option>`).join('')}</select>
          </label>
        </div>
        <p class="list-footer plan" id="plan"></p>
        <div class="session-choice">
          <button class="btn primary wide" id="start" type="button">${icons.play}<span id="start-label">Start</span></button>
        </div>
        <div class="session-choice" id="move-on-box" hidden>
          <button class="btn wide move-on" id="move-on" type="button"><span id="move-on-label"></span>${icons.next}</button>
          <p class="list-footer plan" id="move-on-plan"></p>
          <p class="list-footer move-on-meaning" id="move-on-meaning"></p>
        </div>
        <p class="list-footer plan" id="end-note" hidden></p>
      </div>
      <div class="session-choice">
        <button class="btn wide" id="test-me" type="button">${icons.mic}<span>Test yourself</span></button>
        <p class="list-footer">Recite the range from memory; the app listens and reveals each word you get right.</p>
      </div>
    </section>

    <div class="mem-bar">
      <span id="mem-count"></span>
      <span class="mem-actions">
        <button class="link" id="hide-text" type="button" aria-pressed="false">Hide text</button>
        <button class="link" id="mark-all" type="button">Mark all memorized</button>
        <button class="link" id="clear-all" type="button">Clear</button>
      </span>
    </div>

    ${chapter.bismillah_pre ? '<p class="ar basmala" lang="ar" dir="rtl">بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ</p>' : ''}

    ${tajweedLegend()}

    <div class="ayat${settings.showTranslation ? '' : ' no-tr'}${settings.tajweed ? '' : ' no-tajweed'}" id="ayat">
      ${verses.map((v) => ayahHtml(v, mem.has(v.n))).join('')}
    </div>`;

  updateMemCount();

  $('#reciter-btn').addEventListener('click', () => openReciterPicker((id) => {
    if (id === settings.reciter) return;
    if (player.session) player.stop();
    saveSettings({ reciter: id });
    $('#reciter-name').textContent = api.reciterLabel(api.reciter(id));
    loadAudioState();
  }));

  for (const id of ['from', 'to', 'repeats', 'link', 'gap']) $(`#${id}`).addEventListener('change', updatePlan);
  $('#page').addEventListener('change', (e) => {
    const pg = current.pages?.find((x) => String(x.page) === e.target.value);
    if (!pg) return;
    const max = $('#to').options.length;
    $('#from').value = String(pg.from);
    $('#to').value = String(Math.min(pg.to, max));
    updatePlan();
  });
  $('#ctx').addEventListener('click', onContextClick);
  $('#start').addEventListener('click', startRange);
  $('#move-on').addEventListener('click', moveOn);
  $('#test-me').addEventListener('click', () => {
    if ($('#from').options.length) rememberRange(readRange());
    location.hash = `#/test/${current.num}`;
  });

  $('#ayat').addEventListener('click', (e) => {
    const art = e.target.closest('.ayah');
    if (!art) return;
    const n = Number(art.dataset.n);
    if (e.target.closest('.mem')) toggleMemorized(n, art);
    else if (e.target.closest('.play-one')) playOne(n);
    else if (e.target.closest('.fix-one')) openTimingFix(n);
    else if (e.target.closest('.ayah-text') && $('#ayat').classList.contains('test-mode')) {
      e.target.closest('.ayah-text').classList.toggle('revealed');
    }
  });

  $('#hide-text').addEventListener('click', (e) => {
    const on = $('#ayat').classList.toggle('test-mode');
    e.target.setAttribute('aria-pressed', String(on));
    e.target.textContent = on ? 'Show text' : 'Hide text';
    for (const el of document.querySelectorAll('.ayah-text.revealed')) el.classList.remove('revealed');
    if (on) toast('Recite from memory. Tap an ayah to check it.');
  });

  $('#mark-all').addEventListener('click', () => {
    const all = verses.map((v) => v.n);
    store.setMemorized(num, new Set(all));
    const added = revision.addKnown(num, all, { spread: true });
    refreshMemorized();
    updateDueBadge();
    toast(`${chapter.name_simple} marked as memorized${added ? ' and added to your revision' : ''}. Masha’Allah!`);
  });
  $('#clear-all').addEventListener('click', () => {
    if (!store.countMemorized(num)) return;
    if (!confirm(`Clear memorized marks for ${chapter.name_simple}? These ayat will also leave your revision.`)) return;
    revision.remove(num, [...store.getMemorizedSet(num)]);
    store.setMemorized(num, new Set());
    updateDueBadge();
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
      <button class="icon-btn fix-one" type="button" aria-label="Adjust timing of ayah ${v.n}" title="Adjust timing" hidden>${icons.clock}</button>
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
  if (on) revision.addKnown(current.num, [n]);
  else revision.remove(current.num, [n]);
  updateDueBadge();
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
  const r = api.reciter(settings.reciter);
  const { num, verses } = current;
  const box = $('#audio-status');
  const controls = $('#practice-controls');
  current.timings = null;
  markFixedAyat();
  current.audioUrl = api.audioUrl(r, num);
  controls.hidden = true;
  box.innerHTML = loading('Loading recitation…');

  const available = await api.isAvailable(r, num);
  if (current?.num !== num || settings.reciter !== r.id) return;
  if (!available) {
    box.innerHTML = notice(`${esc(r.name)}’s recording of this surah isn’t available. Choose another reciter.`);
    return;
  }

  let timings, source;
  try {
    ({ timings, source } = await rawTimings(r, num));
  } catch {
    box.innerHTML = notice('Couldn’t load the ayah timings. Check your connection and open this surah again.');
    return;
  }
  if (current?.num !== num || settings.reciter !== r.id) return;
  if (r.timingRead && !Object.keys(timings || {}).length) {
    box.innerHTML = notice(`${esc(api.reciterLabel(r))}’s recording of this surah isn’t available. Choose another reciter.`);
    return;
  }

  current.timings = store.withFixes(r.id, num, timings);
  markFixedAyat();
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
    const label = source === 'official' ? 'Ayah timings by mp3quran.net'
      : source === 'auto' ? `Ayah timings detected automatically. If an ayah starts or stops in the wrong place, tap its ${icons.clock} to fix it · <a href="#/mark/${num}">Mark all yourself</a>`
        : `Timings marked by you · <a href="#/mark/${num}">Re-mark</a> · <button class="link" id="clear-timings" type="button">${api.reciter(settings.reciter).bundled ? 'Use automatic timings' : 'Delete'}</button>`;
    box.innerHTML = `<p class="small muted status-line">${label} · ${offlineBtn}</p>`;
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
  fillPageSelect(marked);
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

  // "Move on" is always available until the end of the surah (or of the marked timings).
  const plan = store.getPlan(current.num);
  const started = plan && plan.from === r.from && plan.to === r.to;
  const canMove = r.to < max;
  $('#move-on-box').hidden = !canMove;
  if (canMove) {
    const next = moveOnSteps(r);
    $('#move-on-label').textContent = `Move on: ayat ${span(r.from + 1, r.to + 1)}`;
    $('#move-on-plan').textContent = `New ayah ${r.to + 1} ×${r.repeats}, then ${span(r.from + 1, r.to + 1)} together ×${r.link} · ${fmtDuration(stepsDuration(next, r.gap))}`;
    showMeaningOf(r.to + 1, $('#move-on-meaning'));
  }
  if (movedTo && movedTo !== r.to) movedTo = 0;
  syncPage(r);
  updateContext(r);
  const atEnd = started && r.to >= current.verses.length;
  const end = $('#end-note');
  end.hidden = !(started && r.to >= max);
  const pending = [];
  for (let a = r.from; a <= r.to; a++) if (!revision.has(current.num, a)) pending.push(a);
  end.innerHTML = atEnd
    ? `You’ve reached the end of the surah.${pending.length ? ` <button class="link" id="finish-surah" type="button">Add ayat ${span(pending[0], pending.at(-1))} to revision</button>` : ''}`
    : esc(`Mark the timings for ayah ${max + 1} onwards to move on further.`);
  $('#finish-surah')?.addEventListener('click', () => {
    revision.addNew(current.num, pending);
    updateDueBadge();
    toast(`Ayat ${span(pending[0], pending.at(-1))} added to your revision.`);
    updatePlan();
  });
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
  await startSession({ steps: rangeSteps(r), gap: r.gap, title: `ayat ${span(r.from, r.to)}`, range: true });
}

async function moveOn() {
  const r = readRange();
  const next = { ...r, from: r.from + 1, to: r.to + 1 };
  if (!current.timings[next.to]) return;
  $('#from').value = String(next.from);
  $('#to').value = String(next.to);
  if (revision.addNew(current.num, [r.from])) {
    updateDueBadge();
    toast(`Ayah ${r.from} moved to your revision. It comes back later today.`);
  }
  rememberRange(next);
  movedTo = next.to;
  updatePlan();
  await startSession({ steps: moveOnSteps(r), gap: r.gap, title: `ayat ${span(next.from, next.to)}`, range: true });
}

// ---------- reciter picker (searchable) ----------

const reciterDlg = $('#reciter-sheet');
let onReciterPick = null;

function openReciterPicker(onPick) {
  onReciterPick = onPick;
  $('#reciter-q').value = '';
  renderReciters('');
  reciterDlg.showModal();
  $('#reciter-results').scrollTop = 0;
  reciterDlg.querySelector('.pick-row[aria-selected="true"]')?.scrollIntoView({ block: 'center' });
}

function reciterRow(r) {
  const on = r.id === settings.reciter;
  return `<button type="button" class="row pick-row" role="option" aria-selected="${on}" data-id="${esc(r.id)}">
    <span class="row-label">
      <span class="pick-name">${esc(api.reciterLabel(r))}</span>
      ${r.nameAr ? `<span class="pick-ar" lang="ar">${esc(r.nameAr)}</span>` : ''}
    </span>
    ${on ? `<span class="pick-check" aria-hidden="true">${icons.check}</span>` : ''}
  </button>`;
}

function renderReciters(query) {
  const list = api.reciterList();
  const box = $('#reciter-results');
  const q = query.trim();
  if (!q) {
    const groups = [
      ['Popular', list.filter((r) => r.popular && r.timingRead), ''],
      ['All reciters (A–Z)', list.filter((r) => !r.popular && r.timingRead), ''],
      ['Mark ayah timings yourself', list.filter((r) => !r.timingRead), 'No published ayah timings: you tap along once per surah.'],
    ];
    box.innerHTML = groups.filter(([, g]) => g.length).map(([label, g, note]) => `
      <h3 class="list-header">${label}</h3>
      <div class="list" role="listbox" aria-label="${label}">${g.map(reciterRow).join('')}</div>
      ${note ? `<p class="list-footer">${note}</p>` : ''}`).join('');
    return;
  }
  const found = searchReciters(list, q);
  box.innerHTML = found.length
    ? `<h3 class="list-header">${found.length === 1 ? '1 reciter' : `${found.length} reciters`}</h3>
       <div class="list" role="listbox" aria-label="Search results">${found.map(reciterRow).join('')}</div>`
    : `<p class="empty-search muted">No reciter matches “${esc(q)}”. Try part of the name, or type it in Arabic.</p>`;
}

function pickReciter(id) {
  const fn = onReciterPick;
  onReciterPick = null;
  reciterDlg.close();
  fn?.(id);
}

$('#reciter-q').addEventListener('input', (e) => renderReciters(e.target.value));
$('#reciter-q').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();   // Enter picks the best match instead of closing the sheet
  const first = $('#reciter-results .pick-row');
  if (first) pickReciter(first.dataset.id);
});
$('#reciter-results').addEventListener('click', (e) => {
  const row = e.target.closest('.pick-row');
  if (row) pickReciter(row.dataset.id);
});

// ---------- understand before you memorize (classical tafsir) ----------

let ctxKey = '';     // surah:from-to shown in the context card
let ctxReq = 0;
let movedTo = 0;     // the ayah just added by Move on (shown first in the card)
let ctxData = null;  // { range, data } behind the card, for the tafsir sheet

const ctxHead = (r) => `<h2 class="list-header">Before you memorize · ${r.from === r.to ? `ayah ${r.from}` : `ayat ${span(r.from, r.to)}`}</h2>`;
const ctxSource = '<p class="list-footer">Classical tafsir: Ibn Kathir (Abridged) and Tazkirul Quran by Maulana Wahiduddin Khan, via Quran.com.</p>';

async function updateContext(r) {
  const box = $('#ctx');
  if (!box || !current) return;
  const key = `${current.num}:${r.from}-${r.to}:${movedTo}`;
  if (key === ctxKey) return;
  ctxKey = key;
  const req = ++ctxReq;
  const num = current.num;
  if (!box.firstChild) box.innerHTML = `${ctxHead(r)}<div class="list"><div class="ctx-block">${loading('Loading the tafsir…')}</div></div>`;
  let data;
  try {
    data = await context.forRange(num, current.verses, r.from, r.to);
  } catch {
    data = null;
  }
  if (req !== ctxReq || current?.num !== num || !$('#ctx')) return;
  if (!data || !data.available) {
    box.innerHTML = `${ctxHead(r)}<div class="list"><div class="ctx-block muted">The tafsir couldn’t be loaded. Check your connection; once it has loaded it stays available offline.</div></div>`;
    return;
  }
  ctxData = { range: { from: r.from, to: r.to }, data };
  box.innerHTML = ctxHead(r) + `<div class="list">${contextRows(r, data)}</div>` + ctxSource;
  requestAnimationFrame(() => {
    for (const more of box.querySelectorAll('[data-more]')) {
      const el = more.previousElementSibling;
      more.hidden = !el || el.scrollHeight <= el.clientHeight + 2;
    }
  });
}

// Sections that cover the same ayat are shown as one step of the flow
function flowSteps(sections) {
  const steps = [];
  sections.forEach((s, i) => {
    if (!s.title) return;
    const last = steps[steps.length - 1];
    if (last && last.from === s.from && last.to === s.to) last.titles.push(s.title);
    else steps.push({ from: s.from, to: s.to, titles: [s.title], index: i });
  });
  return steps;
}

const clampText = (text, cls = '') => `<p class="ctx-text clamp ${cls}">${esc(text)}</p><button class="link ctx-more" type="button" data-more>More</button>`;

function contextRows(r, data) {
  const rows = [];
  if (movedTo && movedTo === r.to) {
    const v = current.verses[movedTo - 1];
    const sec = data.sections.find((s) => s.from === movedTo && s.title);
    rows.push(`<div class="ctx-block ctx-new">
      <p class="ctx-label">New ayah ${movedTo}</p>
      ${sec ? `<p class="ctx-section">Starts a new section: ${esc(sec.title)}</p>` : ''}
      <p class="ctx-text">${esc(v?.translation || '')}</p>
    </div>`);
  }
  const steps = flowSteps(data.sections);
  if (steps.length) {
    rows.push(`<div class="ctx-block">
      <p class="ctx-label">Flow of the passage</p>
      <ol class="ctx-flow">${steps.map((st) => `
        <li><button type="button" class="ctx-step" data-sec="${st.index}">
          <span class="ctx-range">${span(Math.max(st.from, 1), st.to)}</span>
          <span class="ctx-step-title">${st.titles.map(esc).join('<span class="sep"> · </span>')}</span>
        </button></li>`).join('')}
      </ol>
    </div>`);
  }
  if (data.stories.length) {
    const st = data.stories[0];
    rows.push(`<div class="ctx-block">
      <p class="ctx-label">Story and reason for revelation</p>
      ${st.title ? `<p class="ctx-section">${esc(st.title)} <span class="muted">· ${st.from === st.to ? `ayah ${st.from}` : `ayat ${span(st.from, st.to)}`}</span></p>` : ''}
      ${clampText(st.text)}
    </div>`);
  }
  if (data.brief.length) {
    rows.push(`<div class="ctx-block">
      <p class="ctx-label">In brief <span class="muted">· Tazkirul Quran</span></p>
      <div class="clamp-box">${data.brief.map((g) => `<p class="ctx-text"><span class="ctx-range">${span(g.from, g.to)}</span> ${esc(g.text)}</p>`).join('')}</div>
      <button class="link ctx-more" type="button" data-more>More</button>
    </div>`);
  }
  if (data.intro.length) rows.push(`<button class="row chev" type="button" data-read="intro"><span class="row-label">About this surah</span><span class="row-value">Ibn Kathir</span></button>`);
  if (data.sections.length) rows.push(`<button class="row chev" type="button" data-read="tafsir"><span class="row-label row-action">Read the tafsir</span><span class="row-value">Ibn Kathir</span></button>`);
  return rows.join('');
}

function onContextClick(e) {
  const more = e.target.closest('[data-more]');
  if (more) {
    const block = more.closest('.ctx-block');
    const open = block.classList.toggle('open');
    more.textContent = open ? 'Less' : 'More';
    return;
  }
  const step = e.target.closest('[data-sec]');
  if (step) { openTafsir('tafsir', Number(step.dataset.sec)); return; }
  const read = e.target.closest('[data-read]');
  if (read) openTafsir(read.dataset.read);
}

const tafsirDlg = $('#tafsir');

function blocksHtml(blocks) {
  return blocks.map((b) => (b.type === 'h'
    ? `<h4>${esc(b.text)}</h4>`
    : b.arabic ? `<p class="ar tf-ar" lang="ar" dir="rtl">${esc(b.text)}</p>` : `<p>${esc(b.text)}</p>`)).join('');
}

function openTafsir(which, sectionIndex = -1) {
  if (!ctxData) return;
  const { range, data } = ctxData;
  const name = current.chapter.name_simple;
  if (which === 'intro') {
    $('#tafsir-title').textContent = `About ${name}`;
    $('#tafsir-body').innerHTML = `<p class="muted small">Ibn Kathir (Abridged), via Quran.com</p>${blocksHtml(data.intro)}`;
  } else {
    $('#tafsir-title').textContent = `${name} ${span(range.from, range.to)}`;
    $('#tafsir-body').innerHTML = `<p class="muted small">Ibn Kathir (Abridged), via Quran.com</p>` + data.sections.map((s, i) => `
      <section class="tf-sec" id="tf-${i}">
        <h3><span class="ctx-range">${span(s.from, s.to)}</span> ${esc(s.title || (s.from === s.to ? `Ayah ${s.from}` : `Ayat ${span(s.from, s.to)}`))}</h3>
        ${blocksHtml(s.blocks)}
      </section>`).join('');
  }
  tafsirDlg.showModal();
  const target = sectionIndex >= 0 && $(`#tf-${sectionIndex}`);
  if (target) target.scrollIntoView({ block: 'start' });
  else tafsirDlg.scrollTop = 0;
}

// The meaning of one ayah (Saheeh International), with the Ibn Kathir section it opens, if any
function showMeaningOf(n, el, surah = current?.num, verses = current?.verses) {
  const v = verses?.[n - 1];
  if (!el || !v) return;
  el.dataset.n = String(n);
  el.innerHTML = `<strong>Ayah ${n}:</strong> ${esc(v.translation)}`;
  context.sectionOf(surah, verses, n).then((s) => {
    if (!s || s.from !== n || !s.title || el.dataset.n !== String(n) || !el.isConnected) return;
    el.insertAdjacentHTML('afterbegin', `<span class="meaning-section">New section: ${esc(s.title)}</span>`);
  });
}

// ---------- pick by Mushaf page ----------

async function fillPageSelect(max) {
  const num = current.num;
  let list;
  try { list = await context.pages(num); } catch { return; }
  if (current?.num !== num || !$('#page')) return;
  current.pages = list;
  $('#page').innerHTML = `<option value="" id="page-none"></option>` + list.map((pg) => `
    <option value="${pg.page}" ${pg.from > max ? 'disabled' : ''}>Page ${pg.page} · ${pg.from === Math.min(pg.to, max) ? `ayah ${pg.from}` : `ayat ${span(pg.from, Math.min(pg.to, max))}`}</option>`).join('');
  $('#page-row').hidden = false;
  syncPage(readRange());
}

// Show the page the range is on; select it when the range is exactly that page
function syncPage(r) {
  const sel = $('#page');
  if (!sel || !current.pages) return;
  const max = $('#to').options.length;
  const hit = current.pages.find((pg) => pg.from === r.from && Math.min(pg.to, max) === r.to);
  const on = current.pages.filter((pg) => pg.from <= r.to && pg.to >= r.from).map((pg) => pg.page);
  const none = $('#page-none');
  if (none) none.textContent = on.length > 1 ? `Pages ${on[0]}–${on.at(-1)}` : on.length ? `On page ${on[0]}` : 'Choose';
  sel.value = hit ? String(hit.page) : '';
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
  const r = api.reciter(settings.reciter);
  const src = await api.resolveAudio(current.audioUrl);
  player.start({
    ...opts,
    key: current.audioUrl,
    src,
    timings: current.timings,
    meta: {
      surah: current.num,
      surahName: current.chapter.name_simple,
      reciter: api.reciterLabel(r),
      title: `${current.chapter.name_simple} ${opts.title}`.trim(),
      range: !!opts.range,
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

// Where a reciter's timings come from: mp3quran's published timings, the user's own marks,
// or timings detected automatically and shipped with the app.
async function rawTimings(r, surah) {
  if (r.timingRead) return { timings: await api.getTimings(r, surah), source: 'official' };
  const mine = store.getTimings(r.id, surah);
  if (mine) return { timings: mine, source: 'mine' };
  const auto = await api.getBundledTimings(r, surah);
  return { timings: auto, source: auto ? 'auto' : null };
}

// ---------- test yourself (recitation check) ----------

const displayWords = (v) => v.text.split(/\s+/).filter((t) => t && !/^[۞۩]+$/.test(t));

let testSession = null;

async function testView(n) {
  if (!(n >= 1 && n <= 114)) { location.hash = '#/'; return; }
  view.innerHTML = loading();
  await ensureChapters();
  if (player.session) player.stop();
  const chapter = chapters[n - 1];
  const plan = store.getPlan(n) || { from: 1, to: Math.min(5, chapter.verses_count) };
  const [verses, phon] = await Promise.all([api.getVerses(n), api.getPhonetic(n)]);
  const range = verses.filter((v) => v.n >= plan.from && v.n <= plan.to);

  const header = `
    <a href="#/surah/${n}" class="back">${icons.back}<span>${esc(chapter.name_simple)}</span></a>
    <h1 class="large-title">Test yourself</h1>
    <p class="muted subtitle">${esc(chapter.name_simple)} · ${plan.from === plan.to ? `ayah ${plan.from}` : `ayat ${plan.from}–${plan.to}`}</p>`;

  if (!(await recite.isDownloaded())) {
    view.innerHTML = `${header}
      <div class="card explain">
        <p><strong>Check your recitation on this device</strong></p>
        <p class="muted">Recite from memory and Hifz listens: each word you get right is revealed, missed or wrong words turn red, and tajweed points are underlined in orange.</p>
        <p class="muted">This needs a one-time download of ${recite.TOTAL_MB} MB. After that it works offline, and your voice never leaves your phone.</p>
        <button class="btn primary wide" id="get-model" type="button">Download (${recite.TOTAL_MB} MB)</button>
        <div class="download-bar" id="dl" hidden><i></i></div>
      </div>`;
    $('#get-model').addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Downloading…';
      $('#dl').hidden = false;
      try {
        await recite.download((f) => { $('#dl i').style.width = `${Math.round(f * 100)}%`; });
        route();
      } catch {
        toast('The download didn’t finish. Check your connection and try again.');
        e.target.disabled = false;
        e.target.textContent = `Download (${recite.TOTAL_MB} MB)`;
      }
    });
    return;
  }

  view.innerHTML = `${header}
    <div id="test-summary"></div>
    <div class="test-legend">
      <span><i class="dot ok"></i>Correct</span><span><i class="dot taj"></i>Tajweed or pronunciation point</span><span><i class="dot bad"></i>Missed or wrong</span>
    </div>
    <div class="t-list" id="t-list">
      ${range.map((v, i) => `
        <article class="t-ayah${i === 0 ? ' current' : ''}" data-i="${i}">
          <p class="ar t-words" lang="ar" dir="rtl">${displayWords(v).map((w, k) => `<span class="w w-pending" data-k="${k}">${esc(w)}</span>`).join(' ')} <span class="ayah-end">${arNum(v.n)}</span></p>
          <p class="t-meaning" hidden></p>
          <p class="t-note" hidden></p>
        </article>`).join('')}
    </div>
    <div class="mic-dock">
      <button class="mic-btn" id="mic" type="button" aria-label="Start reciting">${icons.mic}</button>
      <div class="mic-row">
        <span class="mic-status" id="mic-status">Preparing…</span>
        <button class="hint-chip" id="t-hint" type="button">Meaning</button>
      </div>
    </div>`;
  document.body.classList.add('has-mic');

  const ayat = range.map((v) => ({ ref: ayahRef(phon.ayat[v.n - 1], phon.kinds, phon.rules), verse: v }));
  const status = (t) => { const el = $('#mic-status'); if (el) el.textContent = t; };
  const lastNotes = new Map(); // "i:k" → notes, for tap-to-explain

  // a hint while reciting: the meaning of the ayah you're on
  $('#t-hint').addEventListener('click', () => {
    const art = view.querySelector('.t-ayah.current') || view.querySelector('.t-ayah');
    if (!art) return;
    const el = art.querySelector('.t-meaning');
    showMeaningOf(range[Number(art.dataset.i)].n, el, n, verses);
    el.hidden = false;
  });

  try {
    await recite.initModel();
    status('Tap the microphone and recite from memory');
  } catch {
    status('The speech model couldn’t start on this device.');
    $('#mic').disabled = true;
  }

  const paint = (i, words) => {
    const art = view.querySelector(`.t-ayah[data-i="${i}"]`);
    if (!art) return;
    art.querySelectorAll('.w').forEach((el) => {
      const k = Number(el.dataset.k);
      const w = words[k];
      if (!w) return;
      el.className = `w w-${w.verdict}`;
      if (w.notes?.length) lastNotes.set(`${i}:${k}`, w.notes); else lastNotes.delete(`${i}:${k}`);
    });
  };
  const setCurrent = (i) => view.querySelectorAll('.t-ayah').forEach((el) => el.classList.toggle('current', Number(el.dataset.i) === i));


  $('#t-list').addEventListener('click', (e) => {
    const el = e.target.closest('.w');
    if (!el) return;
    const art = el.closest('.t-ayah');
    const notes = lastNotes.get(`${art.dataset.i}:${el.dataset.k}`);
    const note = art.querySelector('.t-note');
    if (!notes) { note.hidden = true; return; }
    note.hidden = false;
    note.innerHTML = `<span class="ar">${esc(el.textContent)}</span> ${notes.map((x) => esc(x.msg)).join(' · ')}`;
  });

  const finish = (results) => {
    document.body.classList.remove('listening');
    $('#mic').innerHTML = icons.mic;
    $('#mic').setAttribute('aria-label', 'Start again');
    const all = results.flat().filter((w) => w.verdict !== 'pending');
    const ok = all.filter((w) => w.verdict === 'ok' || w.verdict === 'tajweed').length;
    const bad = all.filter((w) => w.verdict === 'missed' || w.verdict === 'wrong').length;
    const taj = all.filter((w) => w.verdict === 'tajweed').length;
    const weak = results.map((ws, i) => (ws.some((w) => w.verdict === 'missed' || w.verdict === 'wrong') ? range[i].n : null)).filter(Boolean);
    status('Tap the microphone to try again');
    $('#test-summary').innerHTML = all.length ? `
      <div class="card summary">
        <p class="summary-big">${ok} of ${all.length} words</p>
        <p class="muted">${bad ? `${bad} missed or wrong` : 'No missed words. Masha’Allah!'}${taj ? ` · ${taj} tajweed ${taj === 1 ? 'point' : 'points'}` : ''}</p>
        ${weak.length ? `<button class="btn small-btn" id="weak-rev" type="button">Revise ayat ${weak.join(', ')} tomorrow</button>` : ''}
      </div>` : '';
    $('#weak-rev')?.addEventListener('click', (e) => {
      revision.addNew(n, weak);
      revision.grade(n, Object.fromEntries(weak.map((a) => [a, 'again'])), { maxGap: settings.maxGap });
      updateDueBadge();
      e.target.disabled = true;
      e.target.textContent = 'Added to your revision';
    });
    testSession = null;
    updateWakeLock();
  };

  $('#mic').addEventListener('click', async () => {
    if (testSession) { status('Checking…'); finish(await testSession.stop()); return; }
    // fresh start
    view.querySelectorAll('.w').forEach((el) => { el.className = 'w w-pending'; });
    view.querySelectorAll('.t-note, .t-meaning').forEach((el) => { el.hidden = true; });
    lastNotes.clear();
    $('#test-summary').innerHTML = '';
    setCurrent(0);
    testSession = new ReciteSession(ayat, {
      onUpdate: paint,
      onAyah: (i) => { setCurrent(i + 1); status(i + 1 < ayat.length ? `Listening… ayah ${range[i + 1].n}` : 'Checking…'); },
      onLevel: (lvl) => { $('#mic')?.style.setProperty('--lvl', lvl.toFixed(2)); },
      onError: (e) => { console.error('recite error', e && e.stack || e); status('Something went wrong while listening.'); },
      onDone: finish,
    });
    try {
      await testSession.start();
      updateWakeLock();
      document.body.classList.add('listening');
      $('#mic').innerHTML = icons.stop;
      $('#mic').setAttribute('aria-label', 'Stop');
      status(`Listening… ayah ${range[0].n}`);
    } catch {
      testSession = null;
      status('Microphone access is needed. Allow it in your browser settings.');
    }
  });

  cleanup = () => {
    document.body.classList.remove('has-mic', 'listening');
    if (testSession) { testSession.stop(); testSession = null; }
    updateWakeLock();
  };
}

// ---------- per-ayah timing fixes ----------

function markFixedAyat() {
  for (const art of document.querySelectorAll('.ayah')) {
    const t = current?.timings?.[art.dataset.n];
    art.classList.toggle('timing-fixed', !!t?.fixed);
    art.querySelector('.fix-one')?.toggleAttribute('hidden', !t);
  }
}

const fixDlg = $('#fix-timing');
const fixAudio = new Audio();
fixAudio.preload = 'auto';
let fix = null; // { n, start, end, original, prevEnd, nextStart }
let fixTimer = null;

const fmtClock = (ms) => {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

function stopClip() {
  clearInterval(fixTimer);
  fixTimer = null;
  fixAudio.pause();
  $('#fix-mark').hidden = true;
}

async function playClip(fromMs, toMs, { marking = false } = {}) {
  stopClip();
  if (player.session) player.pause();
  fixAudio.currentTime = Math.max(0, fromMs) / 1000;
  try { await fixAudio.play(); } catch { toast('Couldn’t play the audio. Check your connection.'); return; }
  $('#fix-mark').hidden = !marking;
  fixTimer = setInterval(() => {
    const t = fixAudio.currentTime * 1000;
    $('#fix-clock').textContent = fmtClock(t);
    if (t >= toMs || fixAudio.ended) stopClip();
  }, 50);
}

function renderFix() {
  $('#fix-start').textContent = fmtClock(fix.start);
  $('#fix-end').textContent = fmtClock(fix.end);
  $('#fix-reset').disabled = !fix.wasFixed && fix.start === fix.original.start && fix.end === fix.original.end;
}

async function openTimingFix(n) {
  const r = api.reciter(settings.reciter);
  const t = current.timings?.[n];
  if (!t) return;
  // The original (unfixed) timing, for "Reset".
  const { timings: raw } = await rawTimings(r, current.num);
  const original = raw?.[n] ? { start: raw[n].start, end: raw[n].end } : { start: t.start, end: t.end };
  fix = { n, start: t.start, end: t.end, original, wasFixed: !!t.fixed, reciter: r };
  $('#fix-title').textContent = `Adjust timing · ayah ${n}`;
  $('#fix-clock').textContent = '';
  const src = await api.resolveAudio(current.audioUrl);
  if (fixAudio.dataset.key !== current.audioUrl) { fixAudio.src = src; fixAudio.dataset.key = current.audioUrl; }
  renderFix();
  fixDlg.showModal();
}

fixDlg.addEventListener('close', stopClip);
fixDlg.addEventListener('click', (e) => {
  if (e.target === fixDlg) { fixDlg.close(); return; }
  const nudge = e.target.closest('[data-nudge]')?.dataset.nudge;
  if (nudge) {
    const [edge, delta] = nudge.split(':');
    fix[edge] = Math.max(0, fix[edge] + Number(delta));
    if (fix.end <= fix.start + 300) {
      if (edge === 'start') fix.start = fix.end - 300; else fix.end = fix.start + 300;
    }
    renderFix();
    if (edge === 'start') playClip(fix.start, fix.start + 2500);
    else playClip(fix.end - 2500, fix.end);
    return;
  }
  const hear = e.target.closest('[data-hear]')?.dataset.hear;
  if (hear === 'start') playClip(fix.start, fix.start + 3000);
  else if (hear === 'end') playClip(fix.end - 3000, fix.end);
  else if (hear === 'ayah') playClip(fix.start, fix.end);
  else if (hear === 'around') playClip(fix.start - 3000, fix.end + 3000, { marking: true });
  const mark = e.target.closest('[data-mark]')?.dataset.mark;
  if (mark) {
    const t = Math.round(fixAudio.currentTime * 1000);
    if (mark === 'start' && t < fix.end - 300) fix.start = t;
    else if (mark === 'end' && t > fix.start + 300) fix.end = t;
    else { toast(mark === 'start' ? 'The start must be before the end.' : 'The end must be after the start.'); return; }
    renderFix();
  }
});

$('#fix-reset').addEventListener('click', () => {
  fix.start = fix.original.start;
  fix.end = fix.original.end;
  const fixes = store.getTimingFixes(fix.reciter.id, current.num);
  delete fixes[fix.n];
  if ($('#fix-neighbours').checked) { delete fixes[fix.n - 1]; delete fixes[fix.n + 1]; }
  store.setTimingFixes(fix.reciter.id, current.num, fixes);
  fix.wasFixed = false;
  applyFixes();
  renderFix();
  toast(`Ayah ${fix.n} is back to its original timing.`);
});

$('#fix-save').addEventListener('click', () => {
  const { n, reciter: r } = fix;
  const fixes = store.getTimingFixes(r.id, current.num);
  fixes[n] = [Math.round(fix.start), Math.round(fix.end)];
  if ($('#fix-neighbours').checked) {
    const prev = current.timings[n - 1];
    const next = current.timings[n + 1];
    // Only when the edge stays inside the neighbour, so it is never squeezed to nothing.
    if (prev && fix.start > prev.start + 500) fixes[n - 1] = [prev.start, Math.round(fix.start)];
    if (next && fix.end < next.end - 500) fixes[n + 1] = [Math.round(fix.end), next.end];
  }
  store.setTimingFixes(r.id, current.num, fixes);
  applyFixes();
  fixDlg.close();
  toast(`Saved the timing for ayah ${n}.`);
});

async function applyFixes() {
  const r = api.reciter(settings.reciter);
  const { timings: raw } = await rawTimings(r, current.num);
  current.timings = store.withFixes(r.id, current.num, raw);
  markFixedAyat();
  updatePlan();
}

// ---------- marking ----------

async function markView(n) {
  if (!(n >= 1 && n <= 114)) { location.hash = '#/'; return; }
  view.innerHTML = loading();
  await ensureChapters();
  const chapter = chapters[n - 1];
  const verses = await api.getVerses(n);
  if (player.session) player.stop();
  await api.getReciters();
  const chosen = api.reciter(settings.reciter);
  const r = chosen.timingRead ? api.SOBHI_RECITER : chosen;
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

// ---------- revision ----------

function updateDueBadge() {
  const badge = $('#due-badge');
  if (!badge) return;
  const n = revision.dueCount();
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.hidden = n === 0;
}

const surahName = (n) => chapters[n - 1]?.name_simple || `Surah ${n}`;

function fmtWhen(t) {
  const d = new Date(t);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `today at ${time}`;
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return 'tomorrow morning';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function revisionCard() {
  const due = revision.dueCount();
  if (!due) return '';
  return `<a class="card revision-card" href="#/today">
    <span class="continue-row"><span class="eyebrow">Today’s revision</span><strong>${due} ${due === 1 ? 'ayah' : 'ayat'} due</strong></span>
  </a>`;
}

function passageLabel(p) {
  if (p.stale && p.items.some((x) => x.r)) return `Not revised for ${p.staleDays} days`;
  if (p.weak) return 'Weak spot';
  return p.old ? 'Old revision' : 'Recent';
}

async function todayView() {
  view.innerHTML = loading();
  await ensureChapters();
  const plan = revision.todayPlan({ cap: settings.reviewCap });

  if (!plan.total) {
    view.innerHTML = `
      <h1 class="page-title">Today</h1>
      <div class="card explain">
        <p><strong>Nothing to revise yet.</strong></p>
        <p class="muted">Ayat join your revision automatically:</p>
        <ul class="muted">
          <li>when you press <strong>Move on</strong>, the ayah that leaves the range comes back later today, tomorrow morning, then after 2, 3 and 7 days, then less and less often;</li>
          <li>when you tick ✓ an ayah you already know, it joins your regular rotation.</li>
        </ul>
        <a class="btn" href="#/">Choose a surah</a>
      </div>`;
    return;
  }

  const old = plan.today.filter((p) => p.old);
  const recent = plan.today.filter((p) => !p.old);
  const row = (p, i) => `
    <li class="passage">
      <div>
        <strong>${esc(surahName(p.surah))} ${span(p.from, p.to)}</strong>
        <span class="muted small">${p.items.length} ${p.items.length === 1 ? 'ayah' : 'ayat'} · ${passageLabel(p)}</span>
      </div>
      <button class="btn small-btn" data-start="${i}">Revise</button>
    </li>`;
  const section = (title, list, offset) => list.length
    ? `<h2 class="list-header">${title}</h2><ol class="list passages">${list.map((p, i) => row(p, i + offset)).join('')}</ol>` : '';

  view.innerHTML = `
    <h1 class="page-title">Today</h1>
    ${plan.today.length ? `
      <p class="muted subtitle">${plan.shownAyat} ayat in ${plan.today.length} ${plan.today.length === 1 ? 'passage' : 'passages'}${plan.doneToday ? ` · ${plan.doneToday} done today` : ''}</p>
      <button class="btn primary wide" id="start-review" type="button">${icons.play}<span>Start revision</span></button>
      ${plan.behind ? `<div class="notice small"><p>You’re behind on revision (${plan.dueAyat} ayat due, daily limit ${settings.reviewCap}). The rest will wait for the next days. Consider revising before learning new ayat until you catch up.</p></div>` : ''}
      ${section('Old revision', old, 0)}
      ${section('Recent', recent, old.length)}` : `
      <div class="card explain">
        <p><strong>${plan.doneToday ? `Done for today. ${plan.doneToday} ayat revised. Masha’Allah!` : 'All caught up.'}</strong></p>
        ${plan.waiting ? `<p class="muted">You’ve reached today’s limit of ${settings.reviewCap} ayat. ${plan.waiting} more will come tomorrow. You can raise the limit in Settings.</p>` : ''}
        ${plan.nextDue ? `<p class="muted">Next revision: ${fmtWhen(plan.nextDue)}.</p>` : ''}
      </div>`}
    ${plan.laterToday && plan.today.length ? `<p class="muted small">${plan.laterToday} more ${plan.laterToday === 1 ? 'ayah comes' : 'ayat come'} back later today.</p>` : ''}`;

  const ordered = [...old, ...recent];
  $('#start-review')?.addEventListener('click', () => startReview(ordered));
  for (const list of view.querySelectorAll('.passages')) {
    list.addEventListener('click', (e) => {
      const i = e.target.closest('[data-start]')?.dataset.start;
      if (i != null) startReview(ordered.slice(Number(i)));
    });
  }
}

let reviewQueue = null; // { passages, index, revised }

function startReview(passages) {
  reviewQueue = { passages, index: 0, revised: 0, again: 0 };
  if (location.hash === '#/review') route();
  else location.hash = '#/review';
}

async function audioFor(surah) {
  // Prefer the chosen reciter; fall back to Idris Abkar when there are no timings.
  for (const id of [settings.reciter, 'abkar']) {
    await api.getReciters();
    const r = api.reciter(id);
    if (!(await api.isAvailable(r, surah))) continue;
    try {
      const { timings: raw } = await rawTimings(r, surah);
      const timings = store.withFixes(r.id, surah, raw);
      if (timings && Object.keys(timings).length) return { reciter: r, timings, url: api.audioUrl(r, surah) };
    } catch { /* try next */ }
  }
  return null;
}

async function reviewView() {
  if (!reviewQueue || reviewQueue.index >= reviewQueue.passages.length) {
    if (!reviewQueue) { location.replace('#/today'); return; }
    return reviewSummary();
  }
  view.innerHTML = loading();
  await ensureChapters();
  const q = reviewQueue;
  const p = q.passages[q.index];
  const verses = (await api.getVerses(p.surah)).filter((v) => v.n >= p.from && v.n <= p.to);
  const maxGap = settings.maxGap;
  const preview = (g) => revision.fmtGap(revision.previewInterval(p.items, g, maxGap));
  const firstWord = verses[0]?.text.split(' ')[0] || '';

  view.innerHTML = `
    <a href="#/today" class="back">${icons.back}<span>Today</span></a>
    <p class="muted small review-count">Passage ${q.index + 1} of ${q.passages.length} · ${passageLabel(p)}</p>
    <h1 class="page-title">${esc(surahName(p.surah))} · ${p.from === p.to ? `ayah ${p.from}` : `ayat ${p.from}–${p.to}`}</h1>
    <p class="muted" id="review-help">Recite from memory, then reveal to check yourself.</p>

    <div class="review-tools">
      <button class="btn ghost small-btn" id="hint" type="button">First word</button>
      <button class="btn ghost small-btn" id="hint-meaning" type="button">Meaning</button>
      <button class="btn ghost small-btn" id="listen" type="button" disabled>${icons.play}<span>Listen</span></button>
      <button class="btn primary small-btn" id="reveal" type="button">Reveal</button>
    </div>
    <p class="hint ar" lang="ar" dir="rtl" id="hint-text" hidden>${esc(firstWord)} …</p>
    <div class="card meaning-hint" id="meaning-text" hidden></div>

    <div class="review-ayat hidden-text" id="review-ayat">
      ${verses.map((v) => `
        <button class="review-ayah" type="button" data-n="${v.n}" aria-pressed="false" disabled>
          <span class="ayah-num">${v.n}</span>
          <span class="ar" lang="ar" dir="rtl">${v.html} <span class="ayah-end">${arNum(v.n)}</span></span>
        </button>`).join('')}
    </div>

    <div class="grade" id="grade" hidden>
      <p class="muted small">Tap any ayah you slipped on, then rate how it went:</p>
      <div class="grade-row">
        <button class="grade-btn again" data-g="again" type="button"><strong>Forgot</strong><span>${preview('again')}</span></button>
        <button class="grade-btn hard" data-g="hard" type="button"><strong>Hard</strong><span>${preview('hard')}</span></button>
        <button class="grade-btn good" data-g="good" type="button"><strong>Good</strong><span>${preview('good')}</span></button>
        <button class="grade-btn easy" data-g="easy" type="button"><strong>Easy</strong><span>${preview('easy')}</span></button>
      </div>
    </div>
    <p class="small"><button class="link muted" id="stop-revising" type="button">Stop revising these ayat</button></p>`;

  const box = $('#review-ayat');
  $('#hint').addEventListener('click', () => { $('#hint-text').hidden = false; });
  $('#hint-meaning').addEventListener('click', async () => {
    const box = $('#meaning-text');
    box.hidden = false;
    const v = verses[0];
    box.innerHTML = `<p><strong>${p.from === p.to ? `Ayah ${v.n}` : `Starts with ayah ${v.n}`}:</strong> ${esc(v.translation)}</p>`;
    // the flow of the passage (Ibn Kathir's headings), when the tafsir is at hand
    try {
      const all = await api.getVerses(p.surah);
      const data = await context.forRange(p.surah, all, p.from, p.to);
      const steps = flowSteps(data.sections);
      if (steps.length && box.isConnected) box.insertAdjacentHTML('beforeend', `<p class="ctx-label">Flow</p><ol class="ctx-flow plain">${steps.map((st) => `<li><span class="ctx-range">${span(st.from, st.to)}</span> <span>${st.titles.map(esc).join(' · ')}</span></li>`).join('')}</ol>`);
    } catch { /* offline: the translation is enough */ }
  });
  $('#reveal').addEventListener('click', () => {
    box.classList.remove('hidden-text');
    for (const b of box.querySelectorAll('.review-ayah')) b.disabled = false;
    $('#reveal').hidden = true;
    $('#hint').hidden = true;
    $('#hint-text').hidden = true;
    $('#hint-meaning').hidden = true;
    $('#review-help').textContent = 'Check what you recited.';
    $('#grade').hidden = false;
  });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('.review-ayah');
    if (!b || b.disabled) return;
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
  });
  $('#grade').addEventListener('click', (e) => {
    const g = e.target.closest('[data-g]')?.dataset.g;
    if (!g) return;
    const slipped = new Set([...box.querySelectorAll('.review-ayah[aria-pressed="true"]')].map((b) => Number(b.dataset.n)));
    const grades = {};
    for (let a = p.from; a <= p.to; a++) grades[a] = slipped.has(a) ? 'again' : g;
    revision.grade(p.surah, grades, { maxGap });
    if (player.session?.meta?.review) player.stop();
    q.revised += p.to - p.from + 1;
    q.again += Object.values(grades).filter((x) => x === 'again').length;
    q.index++;
    updateDueBadge();
    route();
    window.scrollTo(0, 0);
  });
  $('#stop-revising').addEventListener('click', () => {
    if (!confirm(`Stop revising ${surahName(p.surah)} ${span(p.from, p.to)}? You can add them back by ticking ✓ on the surah page.`)) return;
    revision.remove(p.surah, Array.from({ length: p.to - p.from + 1 }, (_, i) => p.from + i));
    q.index++;
    updateDueBadge();
    route();
  });

  const audio = await audioFor(p.surah);
  const listen = $('#listen');
  if (!audio || !audio.timings[p.from] || !audio.timings[p.to] || !listen) return;
  listen.disabled = false;
  listen.addEventListener('click', async () => {
    const src = await api.resolveAudio(audio.url);
    player.start({
      key: audio.url,
      src,
      timings: audio.timings,
      steps: [{ kind: p.from === p.to ? 'ayah' : 'link', from: p.from, to: p.to, repeats: 1 }],
      gap: 0,
      meta: { surah: p.surah, surahName: surahName(p.surah), reciter: audio.reciter.name, title: `${surahName(p.surah)} ${span(p.from, p.to)}`, review: true },
    });
  });
}

function reviewSummary() {
  const q = reviewQueue;
  reviewQueue = null;
  const plan = revision.todayPlan({ cap: settings.reviewCap });
  view.innerHTML = `
    <div class="empty">
      <h1 class="page-title">Revision done. Masha’Allah!</h1>
      <p class="muted">${q.revised} ${q.revised === 1 ? 'ayah' : 'ayat'} revised${q.again ? `, ${q.again} to look at again tomorrow` : ''}.</p>
      ${plan.today.length ? `<p class="muted">${plan.shownAyat} more ayat are due today.</p><a class="btn primary" href="#/today">Continue</a>` : `
        ${plan.nextDue ? `<p class="muted">Next revision: ${fmtWhen(plan.nextDue)}.</p>` : ''}
        <a class="btn" href="#/">Back to surahs</a>`}
    </div>`;
}

function revisionStats() {
  const st = revision.stats();
  if (!st.total) return '';
  const weak = revision.toPassages(st.weak).slice(0, 8);
  return `
    <h2 class="list-header">Revision</h2>
    <section class="stats">
      <div class="stat"><span class="stat-n">${st.total}</span><span class="muted small">ayat in revision</span></div>
      <div class="stat"><span class="stat-n">${st.due}</span><span class="muted small">due now</span></div>
      <div class="stat"><span class="stat-n">${st.weak.length}</span><span class="muted small">weak ayat</span></div>
    </section>
    ${weak.length ? `<p class="muted small">Weak spots (forgotten twice or more): ${weak.map((p) => `<a href="#/surah/${p.surah}">${esc(surahName(p.surah))} ${span(p.from, p.to)}</a>`).join(' · ')}</p>` : ''}`;
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

    ${revisionStats()}

    <h2 class="list-header">By juz</h2>
    <div class="juz-grid">${juzHtml}</div>

    <h2 class="list-header">By surah</h2>
    ${inProgress.length
      ? `<ol class="list surah-list">${inProgress.map(surahRow).join('')}</ol>`
      : `<div class="empty"><p class="muted">Nothing marked yet. Open a surah and tap ✓ next to each ayah you’ve memorized.</p><a class="btn" href="#/">Browse surahs</a></div>`}`;
}

// ---------- keep the screen on while practising ----------

let wakeLock = null;
let wakeBusy = false;
const wantAwake = () => settings.keepAwake && document.visibilityState === 'visible' && ((player.session && !player.paused) || !!testSession);

async function updateWakeLock() {
  if (!('wakeLock' in navigator) || wakeBusy) return;
  wakeBusy = true;
  let failed = false;
  try {
    if (wantAwake() && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!wantAwake() && wakeLock) {
      const w = wakeLock;
      wakeLock = null;
      await w.release();
    }
  } catch {
    wakeLock = null; // not allowed right now (low power mode, page hidden): the phone sleeps as usual
    failed = true;
  } finally {
    wakeBusy = false;
  }
  // the state may have changed while the request was pending
  if (!failed && !!wakeLock !== !!wantAwake()) setTimeout(updateWakeLock, 0);
}
player.onState(updateWakeLock);
// the system drops the lock when the app is hidden; take it again on return
document.addEventListener('visibilitychange', updateWakeLock);

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
  const move = moveOnLabel(s.meta);
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
    ${move ? `<button class="player-move" data-move type="button"><span>${move}</span>${icons.next}</button>` : ''}
    ${multi ? `<div class="player-progress"><i style="width:${Math.round(s.progress * 100)}%"></i></div>` : ''}`;
});

// "Move on: ayat 2–6" when the range on the open surah page can still move forward.
function moveOnLabel(meta) {
  if (!meta?.range || !current || meta.surah !== current.num || !$('#move-on-box') || $('#move-on-box').hidden) return '';
  return esc($('#move-on-label').textContent);
}

// After a range session: offer to move on (or repeat) right from the bar.
function showDoneBar() {
  document.querySelector('.ayah.playing')?.classList.remove('playing');
  lastHighlighted = null;
  const { from, to } = readRange();
  const move = moveOnLabel({ range: true, surah: current.num });
  bar.hidden = false;
  document.body.classList.add('has-player');
  bar.innerHTML = `
    <div class="player-inner done">
      <div class="player-info">
        <span class="player-title">Ayat ${span(from, to)} done. Well done!</span>
        <span class="player-label">${move ? `Move on whenever you’re ready.` : 'You’ve reached the end of this surah.'}</span>
      </div>
      <div class="player-ctrls">
        <button class="icon-btn" data-done="close" aria-label="Close">✕</button>
      </div>
    </div>
    ${move ? `<button class="player-move" data-move type="button"><span>${move}</span>${icons.next}</button>` : ''}`;
}

function hideBar() {
  bar.hidden = true;
  document.body.classList.remove('has-player');
}

bar.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act) { player[act](); return; }
  const done = e.target.closest('[data-done]')?.dataset.done;
  if (e.target.closest('[data-move]')) { moveOn(); return; }
  if (done === 'close') hideBar();
});

// ---------- settings ----------

const APP_VERSION = '2026.11.22-1';

const selectRow = (name, label, options, value) => `
  <label class="row">
    <span class="row-label">${label}</span>
    <select name="${name}" class="row-select">${options.map(([v, t]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${t}</option>`).join('')}</select>
  </label>`;

const switchRow = (name, label, on) => `
  <label class="row switch-row">
    <span class="row-label">${label}</span>
    <input type="checkbox" class="switch" name="${name}" ${on ? 'checked' : ''}>
  </label>`;

function settingsView() {
  view.innerHTML = `
    <h1 class="large-title">Settings</h1>
    <form id="settings-form" class="settings" onsubmit="return false">
      <h2 class="list-header">Reading</h2>
      <div class="list">
        ${selectRow('theme', 'Appearance', [['auto', 'Automatic'], ['light', 'Light'], ['dark', 'Dark']], settings.theme)}
        ${switchRow('tajweed', 'Tajweed colors', settings.tajweed)}
        ${switchRow('showTranslation', 'English translation', settings.showTranslation)}
        ${switchRow('autoscroll', 'Follow the recitation', settings.autoscroll)}
      </div>
      <p class="list-footer">The translation is Saheeh International. “Follow the recitation” scrolls to the ayah being recited.</p>

      <h2 class="list-header">Playback</h2>
      <div class="list">
        ${selectRow('speed', 'Speed', [['0.75', '0.75×'], ['0.9', '0.9×'], ['1', 'Normal'], ['1.15', '1.15×'], ['1.25', '1.25×']], settings.speed)}
        ${switchRow('keepAwake', 'Keep screen on', settings.keepAwake)}
      </div>
      <p class="list-footer">“Keep screen on” stops the phone from going to sleep while a session is playing or Test yourself is listening. If you lock the phone, the recitation keeps playing, but Test yourself can’t listen with the screen off.</p>

      <h2 class="list-header">Revision</h2>
      <div class="list">
        ${selectRow('reviewCap', 'Daily limit', [20, 30, 50, 80, 120, 200].map((v) => [v, `${v} ayat`]), settings.reviewCap)}
        ${selectRow('maxGap', 'Longest gap', [7, 14, 21, 30, 45].map((v) => [v, `${v} days`]), settings.maxGap)}
      </div>
      <p class="list-footer">Every ayah in your revision comes back at least once within the longest gap.</p>

      <h2 class="list-header">Recitation check</h2>
      <div class="list">
        <div class="row"><span class="row-label">Speech model</span><span class="row-value" id="model-state">Checking…</span></div>
        <button type="button" class="row row-action" id="model-remove" hidden>Remove download</button>
      </div>
      <p class="list-footer">Used by “Test yourself”. Runs on this device; your voice is never uploaded.</p>

      <h2 class="list-header">Your data</h2>
      <div class="list">
        <button type="button" class="row row-action" id="export">Export backup</button>
        <label class="row row-action">Import backup<input type="file" id="import" accept="application/json" hidden></label>
      </div>
      <p class="list-footer">Your progress, revision and timings are saved only on this device. Export a backup to keep them safe or move them to another device.</p>

      <h2 class="list-header">About</h2>
      <div class="list">
        <div class="row"><span class="row-label">Version</span><span class="row-value" id="app-version">${APP_VERSION}</span></div>
      </div>
      <p class="list-footer">Text, tajweed and translation: Quran.com. Quran font: KFGQPC Uthmanic Script Hafs, © King Fahd Glorious Quran Printing Complex. Recitations and ayah timings: mp3quran.net.</p>
    </form>`;

  const form = $('#settings-form');
  recite.isDownloaded().then((ok) => {
    const st = $('#model-state');
    if (!st) return;
    st.textContent = ok ? `Downloaded (${recite.TOTAL_MB} MB)` : 'Not downloaded';
    $('#model-remove').hidden = !ok;
  });
  $('#model-remove').addEventListener('click', async () => {
    await recite.remove();
    $('#model-state').textContent = 'Not downloaded';
    $('#model-remove').hidden = true;
    toast('Speech model removed.');
  });
  form.addEventListener('change', (e) => {
    if (e.target.id === 'import') return;
    saveSettings({
      theme: form.theme.value,
      showTranslation: form.showTranslation.checked,
      tajweed: form.tajweed.checked,
      autoscroll: form.autoscroll.checked,
      keepAwake: form.keepAwake.checked,
      speed: Number(form.speed.value),
      reviewCap: Number(form.reviewCap.value),
      maxGap: Number(form.maxGap.value),
    });
    applyTheme();
    player.setRate(settings.speed);
  });

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
      toast('Backup restored.');
      route();
    } catch (err) {
      toast(err.message || 'Couldn’t read that file.');
    }
    e.target.value = '';
  });
}

// ---------- navigation bar ----------
// iOS-style: a large title in the page; once it scrolls under the bar, a small title appears
// in the bar. A page's ".back" link moves into the bar's left side.

const navbar = $('#navbar');
const titleObserver = new IntersectionObserver(([entry]) => {
  navbar.classList.toggle('collapsed', !entry.isIntersecting);
}, { rootMargin: '-52px 0px 0px 0px' });

function setupNav() {
  const left = $('#nav-left');
  left.innerHTML = '';
  const back = view.querySelector('a.back');
  if (back) left.append(back);
  const title = view.querySelector('.large-title, .page-title, .surah-head h1');
  $('#nav-title').textContent = title ? title.textContent.trim() : '';
  titleObserver.disconnect();
  navbar.classList.remove('collapsed');
  if (title) titleObserver.observe(title);
  onScroll();
}

function onScroll() {
  navbar.classList.toggle('scrolled', window.scrollY > 2);
}
window.addEventListener('scroll', onScroll, { passive: true });

// ---------- boot ----------

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => { /* offline support unavailable */ });
  // When a new version takes over, reload once so the page runs the new code.
  let reloaded = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    location.reload();
  });
}

route();
