// Tap-to-mark: the user listens to a whole surah and taps once when ayah 1 begins and once at
// the end of every ayah. marks[0] = start of ayah 1, marks[i] = end of ayah i.
import { $, esc, arNum, fmtTime, maxContiguous, icons, toast } from './ui.js';

export function renderMarker(root, { chapter, verses, reciter, src, existing, onSave }) {
  const N = verses.length;
  const marks = [];
  const k0 = maxContiguous(existing);
  if (k0) {
    marks.push(existing[1].start);
    for (let i = 1; i <= k0; i++) marks.push(existing[i].end);
  }

  const audio = new Audio(src);
  audio.preload = 'auto';

  root.innerHTML = `
    <a href="#/surah/${chapter.id}" class="back">${icons.back}<span>${esc(chapter.name_simple)}</span></a>
    <h1 class="page-title">Mark ayah timings</h1>
    <p class="muted">${esc(reciter.name)} · ${esc(chapter.name_simple)} · ${N} ayat</p>

    <details class="card help" ${k0 ? '' : 'open'}>
      <summary>How it works</summary>
      <ol>
        <li>Press <strong>Play</strong> and listen.</li>
        <li>Tap the big button the moment <strong>ayah 1 begins</strong>${chapter.id === 1 ? '' : ' (after the opening isti‘adha and basmala)'}.</li>
        <li>Then tap it each time an ayah <strong>ends</strong>. The <kbd>Space</kbd> bar works too.</li>
        <li>Missed one? Use <strong>Undo</strong>; it rewinds a few seconds so you can tap again.</li>
        <li>You can save part-way and continue later. Looping works for every ayah you’ve marked.</li>
      </ol>
    </details>

    <section class="card marker">
      <p class="marker-prompt" id="prompt"></p>
      <p class="ar marker-ayah" lang="ar" dir="rtl" id="ayah-text"></p>
      <button class="tap" id="tap" type="button"></button>
      <div class="marker-meta">
        <span id="count"></span>
        <span id="clock" class="mono">0:00</span>
      </div>
      <div class="marker-ctrls">
        <button class="btn" id="m-play" type="button"></button>
        <button class="btn ghost" id="m-back" type="button">${icons.rewind}<span>Back 5 s</span></button>
        <button class="btn ghost" id="m-undo" type="button">${icons.undo}<span>Undo</span></button>
      </div>
    </section>

    <div class="btn-row end">
      <a class="btn ghost" href="#/surah/${chapter.id}">Cancel</a>
      <button class="btn primary" id="m-save" type="button">Save timings</button>
    </div>`;

  const els = {
    prompt: $('#prompt', root), text: $('#ayah-text', root), tap: $('#tap', root),
    count: $('#count', root), clock: $('#clock', root), play: $('#m-play', root),
    back: $('#m-back', root), undo: $('#m-undo', root), save: $('#m-save', root),
  };

  function update() {
    const m = marks.length;
    const complete = m === N + 1;
    const current = Math.min(Math.max(m, 1), N);
    els.text.innerHTML = `${esc(verses[current - 1].text)} <span class="end">﴿${arNum(current)}﴾</span>`;
    if (complete) {
      els.prompt.textContent = 'All ayat marked. Save your timings.';
      els.tap.textContent = 'Done';
    } else if (m === 0) {
      els.prompt.textContent = 'Waiting for ayah 1 to begin…';
      els.tap.textContent = 'Ayah 1 begins';
    } else {
      els.prompt.textContent = `Reciting ayah ${m}. Tap when it ends.`;
      els.tap.textContent = `End of ayah ${m}`;
    }
    els.tap.disabled = complete || audio.paused;
    els.count.textContent = `${Math.max(m - 1, 0)} of ${N} ayat marked`;
    els.play.innerHTML = audio.paused ? `${icons.play}<span>Play</span>` : `${icons.pause}<span>Pause</span>`;
    els.undo.disabled = m === 0;
    els.save.disabled = m < 2;
  }

  function tap() {
    if (audio.paused || marks.length > N) return;
    const t = Math.round(audio.currentTime * 1000);
    if (marks.length && t <= marks[marks.length - 1] + 250) return; // ignore double taps
    marks.push(t);
    if (marks.length === N + 1) audio.pause();
    els.tap.classList.remove('pulse');
    void els.tap.offsetWidth;
    els.tap.classList.add('pulse');
    update();
  }

  function seekTo(ms) {
    audio.currentTime = Math.max(0, ms / 1000);
  }

  els.tap.addEventListener('click', tap);
  els.play.addEventListener('click', () => {
    if (audio.paused) audio.play().catch(() => toast('Couldn’t play the audio. Check your connection.'));
    else audio.pause();
  });
  els.back.addEventListener('click', () => seekTo(audio.currentTime * 1000 - 5000));
  els.undo.addEventListener('click', () => {
    const removed = marks.pop();
    if (removed != null) seekTo(removed - 3000);
    update();
  });
  els.save.addEventListener('click', () => {
    audio.pause();
    const list = [];
    for (let i = 1; i < marks.length; i++) list.push([marks[i - 1], marks[i]]);
    onSave(list);
  });

  const tick = () => { els.clock.textContent = fmtTime(audio.currentTime * 1000); };
  audio.addEventListener('timeupdate', tick);
  audio.addEventListener('play', update);
  audio.addEventListener('pause', update);
  audio.addEventListener('error', () => toast('Couldn’t load the recitation audio. Check your connection.'));
  audio.addEventListener('loadedmetadata', () => {
    if (marks.length) seekTo(marks[marks.length - 1] - 3000);
  }, { once: true });

  const onKey = (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    e.preventDefault();
    tap();
  };
  document.addEventListener('keydown', onKey);

  update();

  return () => {
    document.removeEventListener('keydown', onKey);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  };
}
