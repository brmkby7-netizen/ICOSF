// Recitation checker: one-time download of the model files, and a small client for the model worker.
const BASE = new URL('../../', import.meta.url).href;
export const FILES = [
  { url: `${BASE}models/tajweed-v2/model-int8.onnx`, size: 23_173_931 },
  { url: `${BASE}vendor/onnxruntime-web/ort-wasm-simd-threaded.wasm`, size: 14_239_897 },
  { url: `${BASE}vendor/onnxruntime-web/ort-wasm-simd-threaded.mjs`, size: 24_381 },
  { url: `${BASE}vendor/onnxruntime-web/ort.wasm.min.js`, size: 50_196 },
  { url: `${BASE}models/tajweed-v2/config.json`, size: 308 },
];
export const TOTAL_MB = Math.round(FILES.reduce((n, f) => n + f.size, 0) / 1e6);
const CACHE = 'qm-recite';

export async function isDownloaded() {
  try {
    const c = await caches.open(CACHE);
    for (const f of FILES) if (!(await c.match(f.url))) return false;
    return true;
  } catch {
    return false;
  }
}

// Download every file into Cache Storage, reporting progress (0..1). The service worker serves them from there.
export async function download(onProgress = () => {}) {
  const c = await caches.open(CACHE);
  const total = FILES.reduce((n, f) => n + f.size, 0);
  let done = 0;
  for (const f of FILES) {
    if (await c.match(f.url)) { done += f.size; onProgress(done / total); continue; }
    const res = await fetch(f.url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const reader = res.body.getReader();
    const chunks = [];
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      chunks.push(value);
      done += value.length;
      onProgress(Math.min(1, done / total));
    }
    await c.put(f.url, new Response(new Blob(chunks), { headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream' } }));
  }
  onProgress(1);
}

export async function remove() {
  try { await caches.delete(CACHE); } catch { /* ignore */ }
  worker?.terminate();
  worker = null;
}

let worker = null, nextId = 1;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url));
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      e.data.ok ? p.resolve(e.data) : p.reject(new Error(e.data.error));
    };
  }
  return worker;
}

function call(msg, transfer) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, ...msg }, transfer || []);
  });
}

export const initModel = () => call({ type: 'init' });

// mel: { data, frames, startSample } from MelStream.window → { text, probs, times } with absolute times (s)
export async function hear(mel) {
  const r = await call({ type: 'run', mel: mel.data, frames: mel.frames }, [mel.data.buffer]);
  const offset = mel.startSample / 16000;
  return { text: r.text, probs: r.probs, times: r.times.map((t) => t + offset) };
}
