// Plays exact time segments of a whole-surah audio file and runs practice sessions.
//
// Session modes:
//   cumulative – ayah `from`, then from..from+1, ... up to from..to; each step `repeats` times
//   single     – one ayah once
//   full       – the whole file, `repeats` times
//
// The end of a segment is checked on `timeupdate` (keeps firing with the screen off) and on a
// short interval (precise while the page is visible).

export class Player {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.key = null;
    this.session = null;
    this.paused = false;
    this.gapping = false;
    this.rate = 1;
    this.token = 0;
    this.stateListeners = new Set();
    this.timeListeners = new Set();

    this.audio.addEventListener('error', () => {
      if (!this.session || !this.audio.src) return;
      this._fail('Couldn’t load the recitation audio. Check your connection and try again.');
    });

    this.audio.addEventListener('timeupdate', () => this._emitTime());
    this._setupMediaSession();
  }

  onState(fn) { this.stateListeners.add(fn); return () => this.stateListeners.delete(fn); }
  onTime(fn) { this.timeListeners.add(fn); return () => this.timeListeners.delete(fn); }

  snapshot() {
    const s = this.session;
    if (!s) return { active: false, paused: false };
    const steps = s.mode === 'cumulative' ? s.to - s.from + 1 : 1;
    const step = s.mode === 'cumulative' ? s.k - s.from + 1 : 1;
    const doneSegments = (step - 1) * s.repeats + (s.r - 1);
    return {
      active: true,
      paused: this.paused,
      gapping: this.gapping,
      mode: s.mode,
      from: s.from,
      to: s.to,
      k: s.k,
      r: s.r,
      repeats: s.repeats,
      step,
      steps,
      progress: doneSegments / (steps * s.repeats),
      meta: s.meta,
    };
  }

  _emit(extra = {}) {
    const snap = { ...this.snapshot(), ...extra };
    for (const fn of this.stateListeners) fn(snap);
    this._updateMediaSession(snap);
  }

  _emitTime() {
    if (!this.session) return;
    const t = this.audio.currentTime * 1000;
    for (const fn of this.timeListeners) fn(t, this.session);
    this._checkEnd?.();
  }

  setRate(rate) {
    this.rate = rate;
    this.audio.playbackRate = rate;
  }

  // `key` identifies the recording; `src` may be a blob URL for offline audio.
  _setSource(key, src) {
    if (this.key === key) return;
    this.key = key;
    this.audio.src = src;
  }

  start({ mode = 'cumulative', key, src, timings = null, from = 1, to = 1, repeats = 1, gap = 0, meta = {} }) {
    this.stop(false);
    this._setSource(key, src);
    this.session = { mode, timings, from, to, k: from, r: 1, repeats, gap, meta };
    this.paused = false;
    this._run();
  }

  pause() {
    if (!this.session || this.paused) return;
    this.paused = true;
    this.audio.pause();
    this._emit();
  }

  resume() {
    if (!this.session || !this.paused) return;
    this.paused = false;
    if (this.inSegment) this.audio.play().catch((e) => this._fail(playError(e)));
    this._emit();
  }

  toggle() { this.paused ? this.resume() : this.pause(); }

  next() {
    const s = this.session;
    if (!s || s.mode !== 'cumulative' || s.k >= s.to) return;
    s.k++; s.r = 1;
    this.paused = false;
    this._run();
  }

  prev() {
    const s = this.session;
    if (!s || s.mode !== 'cumulative') return;
    if (s.k > s.from) s.k--;
    s.r = 1;
    this.paused = false;
    this._run();
  }

  stop(emit = true) {
    this.token++;
    this.audio.pause();
    this.session = null;
    this.paused = false;
    this.gapping = false;
    this.inSegment = false;
    this._checkEnd = null;
    if (emit) this._emit();
  }

  _fail(message) {
    this.stop(false);
    this._emit({ error: message });
  }

  _finish() {
    this.token++;
    this.audio.pause();
    this.session = null;
    this.paused = false;
    this.gapping = false;
    this.inSegment = false;
    this._emit({ done: true });
  }

  async _run() {
    const token = ++this.token;
    const s = this.session;
    while (this.session === s && token === this.token) {
      this.gapping = false;
      this._emit();

      const start = s.mode === 'full' ? 0 : s.timings[s.from].start;
      const end = s.mode === 'full' ? Infinity : s.timings[s.k].end;

      let finished;
      try {
        finished = await this._segment(start, end, token);
      } catch (e) {
        if (token === this.token) this._fail(playError(e));
        return;
      }
      if (!finished || token !== this.token) return;

      if (s.r < s.repeats) s.r++;
      else if (s.mode === 'cumulative' && s.k < s.to) { s.k++; s.r = 1; }
      else { this._finish(); return; }

      if (s.gap > 0) {
        this.gapping = true;
        this._emit();
        await this._sleep(s.gap * 1000, token);
        if (token !== this.token) return;
      }
    }
  }

  async _segment(startMs, endMs, token) {
    const a = this.audio;
    a.playbackRate = this.rate;
    await this._seek(startMs / 1000);
    if (token !== this.token) return false;

    this.inSegment = true;
    const done = new Promise((resolve) => {
      const finish = (ok) => {
        clearInterval(timer);
        a.removeEventListener('ended', onEnded);
        this._checkEnd = null;
        this.inSegment = false;
        resolve(ok);
      };
      const check = () => {
        if (token !== this.token) return finish(false);
        if (a.currentTime * 1000 >= endMs - 30) {
          a.pause();
          finish(true);
        }
      };
      const onEnded = () => { if (token === this.token) finish(true); else finish(false); };
      const timer = setInterval(check, 40);
      a.addEventListener('ended', onEnded);
      this._checkEnd = check;
    });

    if (!this.paused) await a.play();
    return done;
  }

  _seek(sec) {
    const a = this.audio;
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        a.removeEventListener('seeked', done);
        a.removeEventListener('error', done);
        resolve();
      };
      const go = () => {
        if (Math.abs(a.currentTime - sec) < 0.02) return done();
        a.addEventListener('seeked', done);
        a.currentTime = sec;
        setTimeout(done, 5000);
      };
      a.addEventListener('error', done, { once: true });
      if (a.readyState >= 1) go();
      else a.addEventListener('loadedmetadata', go, { once: true });
    });
  }

  _sleep(ms, token) {
    return new Promise((resolve) => {
      let left = ms;
      let last = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        if (!this.paused) left -= now - last;
        last = now;
        if (token !== this.token || left <= 0) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  }

  _setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* unsupported */ } };
    set('play', () => this.resume());
    set('pause', () => this.pause());
    set('stop', () => this.stop());
    set('nexttrack', () => this.next());
    set('previoustrack', () => this.prev());
  }

  _updateMediaSession(snap) {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    if (!snap.active) { ms.playbackState = 'none'; return; }
    ms.playbackState = snap.paused ? 'paused' : 'playing';
    const title = snap.meta?.title || 'Quran';
    const artist = snap.meta?.reciter || '';
    if (!ms.metadata || ms.metadata.title !== title || ms.metadata.artist !== artist) {
      ms.metadata = new MediaMetadata({
        title,
        artist,
        album: 'Hifz',
        artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
    }
  }
}

function playError(e) {
  if (e && e.name === 'NotAllowedError') return 'Tap play again to start audio.';
  return 'Couldn’t play the recitation audio. Check your connection and try again.';
}
