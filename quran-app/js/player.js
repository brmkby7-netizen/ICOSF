// Plays exact time segments of a whole-surah audio file and runs practice sessions.
//
// A session is a list of steps. Each step plays ayat `from`..`to` as one continuous segment,
// `repeats` times. `kind` is 'ayah' (a single ayah on its own), 'link' (several ayat read
// together) or 'full' (the whole file). The app builds the step list; see buildSteps in app.js.
//
// The end of a segment is checked on `timeupdate` (keeps firing with the screen off), on a
// short interval (precise while the page is visible) and on a timer set for the expected end.
//
// Screen off / phone asleep: a phone suspends a page as soon as its audio stops, and a paused
// page can't start its audio again. So within a session the audio element never pauses: it jumps
// to the next segment while playing (muted during the jump), and plays muted through the
// "pause to recite" gaps. It only pauses when you pause, stop, or the session ends.

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
    // Paused by the system (a phone call, another app's audio, the phone itself): show it as paused,
    // so the play button (here or on the lock screen) carries on from the same place.
    this.audio.addEventListener('pause', () => {
      if (this.selfPaused) { this.selfPaused = false; return; }
      if (!this.session || this.paused || this.audio.ended) return;
      this.paused = true;
      this._emit();
    });
    this._setupMediaSession();
  }

  onState(fn) { this.stateListeners.add(fn); return () => this.stateListeners.delete(fn); }
  onTime(fn) { this.timeListeners.add(fn); return () => this.timeListeners.delete(fn); }

  snapshot() {
    const s = this.session;
    if (!s) return { active: false, paused: false };
    const step = s.steps[s.i];
    const total = s.steps.reduce((n, x) => n + x.repeats, 0);
    const done = s.steps.slice(0, s.i).reduce((n, x) => n + x.repeats, 0) + (s.r - 1);
    return {
      active: true,
      paused: this.paused,
      gapping: this.gapping,
      kind: step.kind,
      from: step.from,
      to: step.to,
      r: s.r,
      repeats: step.repeats,
      index: s.i,
      count: s.steps.length,
      progress: done / total,
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
    // while muted (a jump or a gap) the position isn't the ayah being recited
    if (!this.gapping && !this.audio.muted) {
      const t = this.audio.currentTime * 1000;
      for (const fn of this.timeListeners) fn(t, this.session);
    }
    this._tick?.();
  }

  // pause the element ourselves (so the 'pause' listener knows it wasn't the system)
  _pauseAudio() {
    if (this.audio.paused) return;
    this.selfPaused = true;
    this.audio.pause();
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

  start({ key, src, timings = null, steps, gap = 0, meta = {} }) {
    this.stop(false);
    this._setSource(key, src);
    this.session = { steps, timings, i: 0, r: 1, gap, meta };
    this.paused = false;
    this._run();
  }

  pause() {
    if (!this.session || this.paused) return;
    this.paused = true;
    this._pauseAudio();
    this._emit();
  }

  resume() {
    if (!this.session || !this.paused) return;
    this.paused = false;
    if (this.inSegment || this.gapping) this.audio.play().catch((e) => this._fail(playError(e)));
    this._emit();
  }

  toggle() { this.paused ? this.resume() : this.pause(); }

  next() {
    const s = this.session;
    if (!s || s.i >= s.steps.length - 1) return;
    s.i++; s.r = 1;
    this.paused = false;
    this._run();
  }

  prev() {
    const s = this.session;
    if (!s) return;
    if (s.i > 0) s.i--;
    s.r = 1;
    this.paused = false;
    this._run();
  }

  stop(emit = true) {
    this.token++;
    this._pauseAudio();
    this.audio.muted = false;
    this.session = null;
    this.paused = false;
    this.gapping = false;
    this.inSegment = false;
    this._tick = null;
    if (emit) this._emit();
  }

  _fail(message) {
    this.stop(false);
    this._emit({ error: message });
  }

  _finish() {
    const { count, meta } = this.snapshot();
    this.token++;
    this._pauseAudio();
    this.audio.muted = false;
    this._tick = null;
    this.session = null;
    this.paused = false;
    this.gapping = false;
    this.inSegment = false;
    this._emit({ done: true, count, meta });
  }

  async _run() {
    const token = ++this.token;
    const s = this.session;
    while (this.session === s && token === this.token) {
      this.gapping = false;
      this._emit();

      const step = s.steps[s.i];
      const start = step.kind === 'full' ? 0 : s.timings[step.from].start;
      const end = step.kind === 'full' ? Infinity : s.timings[step.to].end;

      let finished;
      try {
        finished = await this._segment(start, end, token);
      } catch (e) {
        if (token === this.token) this._fail(playError(e));
        return;
      }
      if (!finished || token !== this.token) return;

      if (s.r < step.repeats) s.r++;
      else if (s.i < s.steps.length - 1) { s.i++; s.r = 1; }
      else { this._finish(); return; }

      if (s.gap > 0) {
        const nx = s.steps[s.i];
        this.gapping = true;
        this._emit();
        await this._gap(nx.kind === 'full' ? 0 : s.timings[nx.from].start, s.gap * 1000, token);
        if (token !== this.token) return;
      }
    }
  }

  async _segment(startMs, endMs, token) {
    const a = this.audio;
    a.playbackRate = this.rate;
    // jump to the start, silently, while the element keeps playing
    if (a.paused || Math.abs(a.currentTime * 1000 - startMs) > 120) {
      a.muted = true;
      await this._seek(startMs / 1000);
    }
    if (token !== this.token) return false;
    // never let the file run to its end inside a session: an ended element stops like a paused one
    if (Number.isFinite(endMs) && a.duration > 1) endMs = Math.min(endMs, a.duration * 1000 - 350);

    this.inSegment = true;
    let endTimer = 0;
    const done = new Promise((resolve) => {
      const finish = (ok) => {
        clearInterval(timer);
        clearTimeout(endTimer);
        a.removeEventListener('ended', onEnded);
        this._tick = null;
        this.inSegment = false;
        resolve(ok);
      };
      const check = () => {
        if (token !== this.token) return finish(false);
        const left = endMs - a.currentTime * 1000;
        if (left <= 30) {
          // keep playing, muted, into whatever comes next: a jump or a gap (the end of a session pauses)
          a.muted = true;
          finish(true);
          return;
        }
        // with the screen off, timeupdate comes only every quarter second: aim a timer at the end
        if (!this.paused && left < 700) {
          clearTimeout(endTimer);
          endTimer = setTimeout(check, Math.max(0, left / this.rate - 15));
        }
      };
      const onEnded = () => finish(token === this.token);
      const timer = setInterval(check, 40);
      a.addEventListener('ended', onEnded);
      this._tick = check;
    });

    a.muted = false;
    if (!this.paused && a.paused) await a.play();
    return done;
  }

  // "Pause to recite": silence for `ms`, with the element still playing (muted) so the phone keeps the
  // app running with the screen off. It starts early enough to reach the next segment as the pause ends.
  async _gap(nextStartMs, ms, token) {
    const a = this.audio;
    a.muted = true;
    await this._seek(Math.max(0, nextStartMs - ms * this.rate) / 1000);
    if (token !== this.token) return;
    if (!this.paused && a.paused) a.play().catch(() => {});
    await this._wait(ms, token);
  }

  // Wall-clock wait that doesn't count paused time; checked on a timer and on timeupdate (screen off).
  _wait(ms, token) {
    return new Promise((resolve) => {
      let left = ms;
      let last = performance.now();
      const check = () => {
        const now = performance.now();
        if (!this.paused) left -= now - last;
        last = now;
        if (token !== this.token || left <= 0) {
          clearInterval(timer);
          clearTimeout(t2);
          if (this._tick === check) this._tick = null;
          resolve();
        }
      };
      const timer = setInterval(check, 100);
      const t2 = setTimeout(check, ms + 5);
      this._tick = check;
    });
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
