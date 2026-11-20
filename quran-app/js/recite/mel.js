// Whisper-style 80-bin log-mel spectrogram of 16 kHz audio (the input the speech model was trained on).
// Matches faster-whisper's FeatureExtractor with padding=0: periodic Hann window of 400 samples, hop 160,
// reflect padding of 200 at both ends, last frame dropped, log10, floor at (max - 8), then (x + 4) / 4.
// MelStream computes frames incrementally as audio arrives, so live checking stays cheap.

export const SR = 16000;
const N_FFT = 400, HOP = 160, N_MELS = 80, N_BINS = N_FFT / 2 + 1, PAD = N_FFT / 2;

let WIN, COS, SIN, FILTERS; // FILTERS: per mel band, [startBin, weights...]

function init() {
  if (WIN) return;
  WIN = new Float32Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) WIN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  COS = new Float32Array(N_FFT);
  SIN = new Float32Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) { COS[i] = Math.cos((2 * Math.PI * i) / N_FFT); SIN[i] = Math.sin((2 * Math.PI * i) / N_FFT); }
  // mel filter bank (Slaney scale, as in Whisper / librosa)
  const fft = Array.from({ length: N_BINS }, (_, k) => (k * SR) / N_FFT);
  const mels = Array.from({ length: N_MELS + 2 }, (_, i) => (45.245640471924965 * i) / (N_MELS + 1));
  const fSp = 200 / 3, minLogHz = 1000, minLogMel = minLogHz / fSp, logStep = Math.log(6.4) / 27;
  const freqs = mels.map((m) => (m >= minLogMel ? minLogHz * Math.exp(logStep * (m - minLogMel)) : fSp * m));
  FILTERS = [];
  for (let m = 0; m < N_MELS; m++) {
    const enorm = 2 / (freqs[m + 2] - freqs[m]);
    const w = new Float32Array(N_BINS);
    let lo = -1, hi = -1;
    for (let k = 0; k < N_BINS; k++) {
      const lower = (fft[k] - freqs[m]) / (freqs[m + 1] - freqs[m]);
      const upper = (freqs[m + 2] - fft[k]) / (freqs[m + 2] - freqs[m + 1]);
      const v = Math.max(0, Math.min(lower, upper)) * enorm;
      w[k] = v;
      if (v > 0) { if (lo < 0) lo = k; hi = k; }
    }
    FILTERS.push({ lo: Math.max(0, lo), hi: Math.max(0, hi), w });
  }
}

// mel power of one frame starting at sample index `start` of the (virtually) reflect-padded signal
function frame(get, start, out, offset) {
  const buf = new Float32Array(N_FFT);
  for (let n = 0; n < N_FFT; n++) buf[n] = get(start + n) * WIN[n];
  const power = new Float32Array(N_BINS);
  for (let k = 0; k < N_BINS; k++) {
    let re = 0, im = 0, idx = 0;
    for (let n = 0; n < N_FFT; n++) {
      re += buf[n] * COS[idx];
      im -= buf[n] * SIN[idx];
      idx += k; if (idx >= N_FFT) idx -= N_FFT;
    }
    power[k] = re * re + im * im;
  }
  for (let m = 0; m < N_MELS; m++) {
    const f = FILTERS[m];
    let s = 0;
    for (let k = f.lo; k <= f.hi; k++) s += f.w[k] * power[k];
    out[offset + m] = s;
  }
}

function reflectGetter(x) {
  const L = x.length;
  return (i) => {
    let j = i - PAD;
    if (j < 0) j = -j;
    if (j >= L) j = 2 * (L - 1) - j;
    return x[Math.max(0, Math.min(L - 1, j))] || 0;
  };
}

// Whole signal → { data: Float32Array [80 x T] (mel-major), frames: T }
export function logMel(x) {
  init();
  const T = Math.floor(x.length / HOP);
  const pow = new Float32Array(T * N_MELS);
  const get = reflectGetter(x);
  for (let t = 0; t < T; t++) frame(get, t * HOP, pow, t * N_MELS);
  return finish(pow, T);
}

function finish(pow, T) {
  const data = new Float32Array(N_MELS * T);
  let max = -Infinity;
  for (let i = 0; i < pow.length; i++) {
    const v = Math.log10(Math.max(pow[i], 1e-10));
    pow[i] = v;
    if (v > max) max = v;
  }
  const floor = max - 8;
  for (let t = 0; t < T; t++) {
    for (let m = 0; m < N_MELS; m++) data[m * T + t] = (Math.max(pow[t * N_MELS + m], floor) + 4) / 4;
  }
  return { data, frames: T };
}

// Incremental: push audio as it arrives; window(from) gives the model input for audio [from, now), with the 0.4 s
// of silence the model was trained with added at both ends. Frames are cached on a fixed grid (every 160 samples),
// so each new 10 ms of audio costs one frame; only the last frames (whose window reaches the moving end) are redone.
export const LEAD_FRAMES = 40; // 0.4 s

export class MelStream {
  constructor() {
    init();
    this.audio = new Float32Array(SR * 60);
    this.len = 0;
    this.pow = new Float32Array(N_MELS * 6000);
    this.cached = 0; // frames on the grid that are final
  }
  push(chunk) {
    if (this.len + chunk.length > this.audio.length) {
      const bigger = new Float32Array(Math.max(this.audio.length * 2, this.len + chunk.length));
      bigger.set(this.audio.subarray(0, this.len));
      this.audio = bigger;
    }
    this.audio.set(chunk, this.len);
    this.len += chunk.length;
  }
  get seconds() { return this.len / SR; }
  ensure(frames) {
    if (frames * N_MELS > this.pow.length) {
      const bigger = new Float32Array(Math.max(this.pow.length * 2, frames * N_MELS));
      bigger.set(this.pow);
      this.pow = bigger;
    }
  }
  // log-mel model input for audio [fromSample, now): { data [80 x T], frames: T } (T even, at most 3000)
  window(fromSample = 0) {
    const x = this.audio.subarray(0, this.len);
    const get = reflectGetter(x);
    const total = Math.floor(this.len / HOP);
    // final frames: their window [t*HOP - PAD, t*HOP + PAD) lies inside the audio
    const finalUpTo = Math.max(0, Math.floor((this.len - PAD) / HOP));
    this.ensure(total + 2);
    for (let t = this.cached; t < finalUpTo; t++) frame(get, t * HOP, this.pow, t * N_MELS);
    this.cached = Math.max(this.cached, finalUpTo);
    const tail = new Float32Array(Math.max(0, total - finalUpTo) * N_MELS);
    for (let t = finalUpTo; t < total; t++) frame(get, t * HOP, tail, (t - finalUpTo) * N_MELS);

    let f0 = Math.floor(fromSample / HOP);
    let usable = total - f0;
    const maxReal = 3000 - 2 * LEAD_FRAMES;
    if (usable > maxReal) { f0 = total - maxReal; usable = maxReal; } // keep the most recent audio
    let T = usable + 2 * LEAD_FRAMES;
    T -= T % 2;
    const pow = new Float32Array(T * N_MELS); // zeros = the added silence
    for (let t = 0; t < usable && LEAD_FRAMES + t < T; t++) {
      const g = f0 + t;
      const src = g < finalUpTo ? this.pow.subarray(g * N_MELS, (g + 1) * N_MELS) : tail.subarray((g - finalUpTo) * N_MELS, (g - finalUpTo + 1) * N_MELS);
      pow.set(src, (LEAD_FRAMES + t) * N_MELS);
    }
    return { ...finish(pow, T), startSample: f0 * HOP };
  }
}
