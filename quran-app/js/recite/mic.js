// Microphone capture at 16 kHz mono, with a simple voice-activity detector.
// onAudio(Float32Array chunk at 16 kHz); returns { stop(), level(), speaking(), silenceFor() }.

function resampler(from, to) {
  const ratio = from / to;
  let carry = new Float32Array(0), pos = 0; // pos: position of the next output sample in the carried buffer
  return (input) => {
    const buf = new Float32Array(carry.length + input.length);
    buf.set(carry); buf.set(input, carry.length);
    const out = [];
    const half = Math.max(0.5, ratio / 2);
    while (pos + half < buf.length) {
      // box filter over the input samples this output sample covers (a cheap low-pass for speech)
      const a = Math.max(0, Math.floor(pos - half)), b = Math.min(buf.length - 1, Math.ceil(pos + half));
      let s = 0;
      for (let i = a; i <= b; i++) s += buf[i];
      out.push(s / (b - a + 1));
      pos += ratio;
    }
    const keep = Math.max(0, Math.floor(pos - half) - 1);
    carry = buf.slice(keep);
    pos -= keep;
    return Float32Array.from(out);
  };
}

export async function startMic(onAudio) {
  const stream = await navigator.mediaDevices.getUserMedia({
    // voice processing (echo cancellation, noise suppression) distorts held recitation sounds: off
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  const toTarget = resampler(ctx.sampleRate, 16000);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  mute.connect(ctx.destination);

  // voice activity: RMS per chunk against an adaptive noise floor
  let level = 0, floor = 0.003, lastVoice = 0, voiced = false;
  const t0 = performance.now();
  const handle = (chunk) => {
    const x = toTarget(chunk);
    if (!x.length) return;
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i] * x[i];
    const rms = Math.sqrt(s / x.length);
    level = level * 0.6 + rms * 0.4;
    floor = rms < floor ? floor * 0.9 + rms * 0.1 : floor * 0.999 + rms * 0.001;
    voiced = rms > Math.max(0.006, floor * 3);
    if (voiced) lastVoice = performance.now();
    onAudio(x);
  };

  let node;
  if (ctx.audioWorklet && window.AudioWorkletNode) {
    const code = 'class C extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor("hifz-capture",C)';
    const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    node = new AudioWorkletNode(ctx, 'hifz-capture');
    node.port.onmessage = (e) => handle(e.data);
  } else {
    node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => handle(e.inputBuffer.getChannelData(0).slice(0));
  }
  src.connect(node);
  node.connect(mute);

  return {
    stop() {
      try { src.disconnect(); node.disconnect(); } catch { /* ignore */ }
      stream.getTracks().forEach((t) => t.stop());
      ctx.close();
    },
    level: () => Math.min(1, level * 12),
    speaking: () => voiced,
    silenceFor: () => (performance.now() - (lastVoice || t0)) / 1000,
  };
}
