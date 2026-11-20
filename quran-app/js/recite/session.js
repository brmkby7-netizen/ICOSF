// A live recitation-check session over a range of ayat: listens, re-checks the current ayah about once a second,
// moves on when the ayah is complete, and finishes the current ayah when stopped.
import { MelStream, SR } from './mel.js';
import { startMic } from './mic.js';
import { hear } from './client.js';
import { judgeAyah, sliceRef, distance, ayahEndIn, heardPrefix } from './engine.js';

const RUN_EVERY = 1.1;     // seconds between live checks while speaking
const NEXT_AFTER = 0.6;    // silence after a complete ayah before moving on
const LONG_WINDOW = 20;    // seconds: beyond this, recited words are committed and the window moves on

export class ReciteSession {
  // ayat: [{ ref }] (expected pronunciation per ayah), callbacks: onUpdate(i, words), onAyah(i), onDone(results)
  constructor(ayat, { onUpdate = () => {}, onAyah = () => {}, onLevel = () => {}, onError = () => {}, onDone = () => {} } = {}) {
    Object.assign(this, { ayat, onUpdate, onAyah, onLevel, onError, onDone });
    this.mel = new MelStream();
    this.i = 0;                 // current ayah
    this.segStart = 0;          // sample where the current ayah's audio starts
    this.committed = 0;         // words of the current ayah already judged and fixed (long ayat)
    this.results = ayat.map((a) => Array.from({ length: a.ref.words }, () => ({ verdict: 'pending', notes: [] })));
    this.busy = false;
    this.lastRun = 0;
    this.stopped = false;
    this.debug = /debug/.test(location.search) ? (window.__reciteDebug = []) : null;
  }

  async start() {
    this.mic = await startMic((x) => this.mel.push(x));
    this.timer = setInterval(() => this.tick(), 150);
  }

  async tick() {
    if (this.stopped) return;
    this.onLevel(this.mic.level(), this.mic.speaking());
    if (this.busy || this.i >= this.ayat.length) return;
    const now = this.mel.seconds;
    if (now - this.segStart / SR < 0.6 || now - this.lastRun < RUN_EVERY) return;
    this.busy = true;
    try { await this.check(false); } catch (e) { this.onError(e); } finally { this.busy = false; }
  }

  refNow() {
    const ref = this.ayat[this.i].ref;
    return this.committed ? sliceRef(ref, this.committed, ref.words) : ref;
  }

  async check(final) {
    this.lastRun = this.mel.seconds;
    const heard = await hear(this.mel.window(this.segStart));
    this.lastHeardLength = heard.text.length;
    if (this.stopped && !final) return;
    let ref = this.refNow();
    // a whole ayah skipped? if what was heard fits the next ayah clearly better, this one was missed
    if (!this.committed && this.i + 1 < this.ayat.length && heard.text.length >= 8) {
      const L = heard.text.length;
      const next = this.ayat[this.i + 1].ref;
      const here = distance(ref.phonemes.slice(0, L + 4), heard.text) / L;
      const there = distance(next.phonemes.slice(0, L + 4), heard.text) / L;
      if (L >= Math.min(12, next.phonemes.length * 0.6) && here > 0.45 && there < here * 0.5) {
        this.results[this.i] = this.results[this.i].map(() => ({ verdict: 'missed', notes: [{ rule: 'word', severity: 'jali', msg: 'this ayah was skipped' }] }));
        this.onUpdate(this.i, this.results[this.i]);
        this.onAyah(this.i);
        this.i++;
        ref = this.refNow();
      }
    }
    // has the reciter already gone on into the next ayah? then judge this ayah on its own sounds and move on
    if (!final && this.i + 1 < this.ayat.length) {
      const { end, cost } = ayahEndIn(ref, heard.text);
      const rest = heard.text.slice(end);
      if (cost < 0.5 && rest.length >= 4) {
        const near = (k) => (this.ayat[k] ? distance(this.ayat[k].ref.phonemes.slice(0, rest.length + 2), rest) / rest.length : 9);
        const nearNext = near(this.i + 1);
        // the reciter may also have skipped the next ayah and gone on to the one after
        const nearAfter = rest.length >= 8 ? near(this.i + 2) : 9;
        const skipped = nearAfter < 0.6 && nearAfter < nearNext * 0.6;
        if (nearNext < 0.6 || skipped) {
          const fin = judgeAyah(ref, heardPrefix(heard, end), { final: true });
          const out = this.results[this.i];
          fin.words.forEach((w, k) => { out[this.committed + k] = w; });
          this.onUpdate(this.i, out);
          if (this.debug) this.debug.push({ i: this.i, flow: true, cut: heard.times[end], heard: heard.text.slice(0, end), v: fin.words.map((w) => w.verdict[0]).join('') });
          this.advance(heard.times[end] - 0.05);
          if (skipped && this.i < this.ayat.length) {
            this.results[this.i] = this.results[this.i].map(() => ({ verdict: 'missed', notes: [{ rule: 'word', severity: 'jali', msg: 'this ayah was skipped' }] }));
            this.onUpdate(this.i, this.results[this.i]);
            this.onAyah(this.i);
            this.i++;
            if (this.i >= this.ayat.length) this.finish();
          }
          this.prevText = null;
          this.stableCount = 0;
          return;
        }
      }
    }
    const r = judgeAyah(ref, heard, { final });
    if (this.debug) this.debug.push({ i: this.i, from: +(this.segStart / SR).toFixed(2), now: +this.mel.seconds.toFixed(2), heard: heard.text, reached: r.reached, done: r.done, final, v: r.words.map((w) => w.verdict[0]).join('') });
    const out = this.results[this.i];
    r.words.forEach((w, k) => { out[this.committed + k] = w; });
    this.onUpdate(this.i, out);

    const silence = this.mic ? this.mic.silenceFor() : 99;
    const stable = heard.text === this.prevText;
    this.prevText = heard.text;
    if (!final && r.done) {
      const lastEnd = r.ends[r.ends.length - 1] || 0;
      // symbols heard after the last word: the reciter has already moved into the next ayah
      const after = heard.times.slice(0, heard.text.length).filter((t) => t > lastEnd + 0.1).length;
      const flowing = after >= 4;
      const paused = silence >= NEXT_AFTER && stable;
      if (flowing || paused || (stable && this.stableCount >= 1)) {
        const fin = judgeAyah(ref, heard, { final: true });
        fin.words.forEach((w, k) => { out[this.committed + k] = w; });
        this.onUpdate(this.i, out);
        // cut where the next ayah starts (flowing), or where the voice stopped (paused)
        const voiceEnd = this.mel.seconds - silence;
        this.advance(flowing ? lastEnd : Math.max(lastEnd, Math.min(voiceEnd, this.mel.seconds)) + 0.08);
        this.stableCount = 0;
        this.prevText = null;
        return;
      }
      this.stableCount = stable ? (this.stableCount || 0) + 1 : 0;
    }
    // a long ayah: fix the words recited so far and move the listening window on
    const span = this.mel.seconds - this.segStart / SR;
    if (!final && span > LONG_WINDOW && r.reached >= 3) {
      const keep = r.reached - 2;
      const t = r.ends[keep - 1];
      if (t && t * SR > this.segStart) {
        this.committed += keep;
        this.segStart = Math.floor(t * SR);
      }
    }
  }

  advance(cutTime) {
    this.onAyah(this.i);
    this.i++;
    this.committed = 0;
    this.segStart = Math.floor(Math.max(this.segStart / SR, cutTime || this.mel.seconds) * SR);
    if (this.i >= this.ayat.length) this.finish();
  }

  // Stop listening; the current ayah is judged as finished (words not reached count as missed).
  async stop() {
    if (this.stopped) return this.results;
    this.stopped = true;
    clearInterval(this.timer);
    this.mic?.stop();
    while (this.busy) await new Promise((r) => setTimeout(r, 50));
    if (this.i < this.ayat.length && this.mel.seconds - this.segStart / SR > 0.5) {
      const before = this.results[this.i].map((w) => w);
      try { await this.check(true); } catch (e) { this.onError(e); }
      // nothing of this ayah was recited (stopped right after the previous one): it was not reached, not missed
      if (this.lastHeardLength < 3) { this.results[this.i] = before; this.onUpdate(this.i, before); }
    }
    // ayat after the one stopped on stay "pending" (not reached)
    return this.results;
  }

  finish() {
    this.stop().then((res) => this.onDone(res));
  }
}
