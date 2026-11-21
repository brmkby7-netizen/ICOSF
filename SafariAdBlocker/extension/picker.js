/*
 * Bastion element picker. Injected on demand from the popup.
 * Hover to highlight, click to select, adjust specificity, then "Hide".
 * UI lives in a closed shadow root so page styles cannot interfere.
 */
(function () {
  'use strict';
  if (globalThis.__bastionPickerActive) return;
  globalThis.__bastionPickerActive = true;
  const B = globalThis.browser || globalThis.chrome;

  const host = document.createElement('bastion-picker');
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .box { position: fixed; pointer-events: none; background: rgba(255, 95, 70, .18); outline: 2px solid #ff5f46; border-radius: 3px; transition: all .06s linear; }
      .panel { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); pointer-events: auto;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #f4f4f5;
        background: rgba(24, 24, 27, .96); border-radius: 14px; padding: 12px; width: min(560px, calc(100vw - 32px));
        box-shadow: 0 12px 40px rgba(0,0,0,.35); backdrop-filter: blur(12px); box-sizing: border-box; }
      .row { display: flex; gap: 8px; align-items: center; }
      .hint { color: #a1a1aa; margin-bottom: 8px; }
      code { display: block; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: #27272a; padding: 7px 9px; border-radius: 8px; }
      button { font: inherit; border: 0; border-radius: 8px; padding: 7px 12px; cursor: pointer; color: #f4f4f5; background: #3f3f46; }
      button.primary { background: #ff5f46; color: #fff; font-weight: 600; }
      button:disabled { opacity: .4; cursor: default; }
      input[type=range] { flex: 1; accent-color: #ff5f46; }
      .count { color: #a1a1aa; min-width: 72px; text-align: right; font-variant-numeric: tabular-nums; }
    </style>
    <div class="box" hidden></div>
    <div class="panel">
      <div class="hint">Click an element to hide it. Esc to cancel.</div>
      <div class="row" style="margin-bottom:8px"><code class="sel">—</code><span class="count"></span></div>
      <div class="row">
        <span style="color:#a1a1aa">Broader</span><input class="depth" type="range" min="0" max="0" value="0"><span style="color:#a1a1aa">Narrower</span>
      </div>
      <div class="row" style="margin-top:10px; justify-content:flex-end">
        <button class="cancel">Cancel</button>
        <button class="primary hide" disabled>Hide element</button>
      </div>
    </div>`;
  document.documentElement.appendChild(host);

  const box = root.querySelector('.box');
  const panel = root.querySelector('.panel');
  const selEl = root.querySelector('.sel');
  const countEl = root.querySelector('.count');
  const depth = root.querySelector('.depth');
  const hideBtn = root.querySelector('.hide');
  let target = null;
  let locked = false;
  let candidates = [];

  function isStable(token) {
    // Skip generated-looking ids/classes (hashes, long digit runs).
    return token && !/\d{4,}|[0-9a-f]{8,}|^[a-z]{1,2}\d|__[a-z0-9]{5,}$/i.test(token) && token.length < 40;
  }

  function stepFor(el) {
    const tag = el.localName;
    if (el.id && isStable(el.id)) return { sel: '#' + CSS.escape(el.id), unique: true };
    const classes = [...el.classList].filter(isStable).slice(0, 3).map((c) => '.' + CSS.escape(c)).join('');
    let sel = tag + classes;
    const parent = el.parentElement;
    if (parent && !classes) {
      const same = [...parent.children].filter((c) => c.localName === tag);
      if (same.length > 1) sel += `:nth-of-type(${same.indexOf(el) + 1})`;
    }
    return { sel, unique: false };
  }

  /** Builds selectors from broad (just the element) to narrow (full path). */
  function buildCandidates(el) {
    const steps = [];
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const s = stepFor(n);
      steps.unshift(s.sel);
      if (s.unique) break;
      if (steps.length >= 6) break;
    }
    const out = [];
    for (let i = steps.length - 1; i >= 0; i--) out.push(steps.slice(i).join(' > '));
    return [...new Set(out)].filter((s) => {
      try { return document.querySelectorAll(s).length > 0; } catch { return false; }
    });
  }

  function highlight(el) {
    if (!el) { box.hidden = true; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    box.hidden = false;
  }

  function current() {
    return candidates[Number(depth.value)] || '';
  }

  function updateSelection() {
    const sel = current();
    selEl.textContent = sel || '—';
    let n = 0;
    try { n = sel ? document.querySelectorAll(sel).length : 0; } catch {}
    countEl.textContent = n ? `${n} match${n === 1 ? '' : 'es'}` : '';
    hideBtn.disabled = !sel;
    try { highlight(sel ? document.querySelector(sel) : null); } catch {}
  }

  function elementAt(x, y) {
    host.style.display = 'none';
    const el = document.elementFromPoint(x, y);
    host.style.display = '';
    return el;
  }

  function onMove(ev) {
    if (locked) return;
    target = elementAt(ev.clientX, ev.clientY);
    highlight(target);
  }

  function onClick(ev) {
    if (ev.composedPath().includes(panel)) return;
    ev.preventDefault();
    ev.stopPropagation();
    target = elementAt(ev.clientX, ev.clientY);
    if (!target) return;
    locked = true;
    candidates = buildCandidates(target);
    depth.max = String(Math.max(0, candidates.length - 1));
    depth.value = '0';
    updateSelection();
  }

  function stop() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    host.remove();
    globalThis.__bastionPickerActive = false;
  }

  function onKey(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); stop(); }
  }

  depth.addEventListener('input', updateSelection);
  root.querySelector('.cancel').addEventListener('click', stop);
  hideBtn.addEventListener('click', () => {
    const sel = current();
    if (!sel) return;
    try { for (const el of document.querySelectorAll(sel)) el.style.setProperty('display', 'none', 'important'); } catch {}
    B.runtime.sendMessage({ type: 'pickerAdd', host: location.hostname, selector: sel });
    stop();
  });

  // Touch devices: a tap is a click; there is no hover.
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
})();
