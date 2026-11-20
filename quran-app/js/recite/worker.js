// Speech model worker: runs the tajweed-v2 ONNX model (ONNX Runtime Web, WebAssembly) off the main thread.
// Messages: { id, type: 'init' } → { id, ok } ; { id, type: 'run', mel: Float32Array [80 x T], frames: T }
//   → { id, text, probs, times } (times in seconds from the start of the window's real audio, plus an end time).
/* global ort */
importScripts('../../vendor/onnxruntime-web/ort.wasm.min.js');

const BASE = new URL('../../', self.location.href).href;
const LEAD = 0.4; // seconds of silence added around the audio
let session = null, phonemes = null, blank = 0;

async function init() {
  if (session) return;
  ort.env.wasm.wasmPaths = `${BASE}vendor/onnxruntime-web/`;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  const cfg = await (await fetch(`${BASE}models/tajweed-v2/config.json`)).json();
  phonemes = cfg.phonemes;
  blank = cfg.blank || 0;
  const model = await (await fetch(`${BASE}models/tajweed-v2/model-int8.onnx`)).arrayBuffer();
  session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
}

async function run(mel, frames) {
  const feeds = {
    mel: new ort.Tensor('float32', mel, [1, 80, frames]),
    riwaya: new ort.Tensor('int64', BigInt64Array.from([0n]), [1]),
  };
  const out = await session.run(feeds);
  const lp = out[Object.keys(out)[0]];
  const [, F, V] = lp.dims;
  const data = lp.data;
  const step = (frames * 0.01) / F; // seconds per output frame (20 ms)
  let text = '';
  const probs = [], times = [];
  let prev = blank, lastNonBlank = -1;
  for (let t = 0; t < F; t++) {
    let best = 0, bv = -Infinity;
    for (let v = 0; v < V; v++) { const x = data[t * V + v]; if (x > bv) { bv = x; best = v; } }
    if (best !== blank) lastNonBlank = t;
    if (best !== prev && best !== blank) {
      text += phonemes[best - 1];
      probs.push(Math.exp(bv));
      times.push((t + 0.5) * step - LEAD);
    }
    prev = best;
  }
  times.push(lastNonBlank >= 0 ? (lastNonBlank + 1) * step - LEAD : 0);
  return { text, probs, times };
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === 'init') { await init(); self.postMessage({ id, ok: true }); }
    else if (type === 'run') { await init(); self.postMessage({ id, ok: true, ...(await run(e.data.mel, e.data.frames)) }); }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
