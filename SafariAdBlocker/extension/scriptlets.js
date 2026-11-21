/*
 * Bastion scriptlet runtime.
 *
 * `bastionScriptletRuntime` is serialized with Function.prototype.toString
 * and executed in the page's main world, so it must be fully self-contained:
 * no references to anything outside its own body.
 *
 * Implements the scriptlets filter lists rely on most (uBO / AdGuard / ABP
 * names are normalized by the compiler to the canonical names below).
 * Implementations are Bastion's own.
 */
/* eslint-disable no-new-func, no-proto */
globalThis.bastionScriptletRuntime = function bastionScriptletRuntime(calls, options) {
  'use strict';
  const debug = Boolean(options && options.debug);
  const win = window;
  const doc = document;
  const log = (...a) => { if (debug) console.log('[Bastion]', ...a); };
  const MAGIC = 'bastion-' + Math.random().toString(36).slice(2);
  const native = {
    defineProperty: Object.defineProperty,
    getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
    fnToString: Function.prototype.toString,
    JSONparse: JSON.parse,
    JSONstringify: JSON.stringify,
  };

  // Swallow errors we throw on purpose so they do not pollute consoles.
  win.addEventListener('error', (ev) => {
    if (ev && typeof ev.message === 'string' && ev.message.includes(MAGIC)) ev.preventDefault();
  }, true);

  // ---- helpers -----------------------------------------------------------
  function toRegex(pattern, flags) {
    if (pattern instanceof RegExp) return pattern;
    const m = /^\/(.+)\/([dgimsuy]*)$/.exec(pattern);
    if (m) {
      try { return new RegExp(m[1], flags !== undefined ? flags : m[2]); } catch { return /(?!)/; }
    }
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags || '');
  }

  /** '' -> matches all; '!x' -> negated; '/re/' -> regex; else substring. */
  function matcher(needle) {
    if (needle === undefined || needle === null || needle === '' || needle === '*') return () => true;
    let negate = false;
    let n = String(needle);
    if (n.startsWith('!')) { negate = true; n = n.slice(1); }
    const re = toRegex(n);
    return (s) => re.test(String(s)) !== negate;
  }

  function fnText(fn) {
    try {
      return typeof fn === 'function' ? native.fnToString.call(fn) : String(fn);
    } catch { return ''; }
  }

  function wrapFunction(owner, name, handler) {
    const original = owner[name];
    if (typeof original !== 'function') return;
    owner[name] = new Proxy(original, {
      apply(target, thisArg, args) { return handler(target, thisArg, args); },
    });
  }

  const SAFE_VALUES = {
    undefined: undefined, false: false, true: true, null: null,
    noopFunc: function () {}, trueFunc: function () { return true; }, falseFunc: function () { return false; },
    emptyObj: {}, emptyArr: [], emptyStr: '', '': '',
    noopPromiseResolve: function () { return Promise.resolve(); },
    noopPromiseReject: function () { return Promise.reject(); },
    '-1': -1, yes: 'yes', no: 'no', on: 'on', off: 'off',
  };
  const INVALID = {};
  function resolveValue(raw) {
    if (raw === '{}') return {};
    if (raw === '[]') return [];
    if (Object.prototype.hasOwnProperty.call(SAFE_VALUES, raw)) {
      const v = SAFE_VALUES[raw];
      if (raw === 'emptyObj') return {};
      if (raw === 'emptyArr') return [];
      return v;
    }
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if (/^'.*'$|^".*"$/.test(raw)) return raw.slice(1, -1);
    if (/^[{[]/.test(raw)) {
      try { return native.JSONparse(raw); } catch { return INVALID; }
    }
    return INVALID;
  }

  /**
   * Walks `chain` (a.b.c) from `root`, calling `onFinal(owner, prop)` when
   * the last owner exists. Missing intermediate objects are trapped so the
   * hook still lands when the page creates them later.
   */
  function onChain(root, chain, onFinal) {
    const dot = chain.indexOf('.');
    if (dot === -1) { onFinal(root, chain); return; }
    const prop = chain.slice(0, dot);
    const rest = chain.slice(dot + 1);
    let value = root[prop];
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
      onChain(value, rest, onFinal);
      return;
    }
    const desc = native.getOwnPropertyDescriptor(root, prop);
    if (desc && desc.configurable === false) return;
    try {
      native.defineProperty(root, prop, {
        configurable: true,
        enumerable: true,
        get() { return value; },
        set(v) {
          value = v;
          if (v !== null && (typeof v === 'object' || typeof v === 'function')) onChain(v, rest, onFinal);
        },
      });
    } catch (e) { log('trap failed', chain, e); }
  }

  function parseUrlMatch(args) {
    // AdGuard: (…, propsToMatch). uBO: (…, 'propsToMatch', value) or 'url:/re/'.
    let spec = '';
    const i = args.indexOf('propsToMatch');
    if (i !== -1) spec = args[i + 1] || '';
    else spec = args.find((a) => a && a !== 'propsToMatch') || '';
    const parts = {};
    for (const token of spec.split(/\s+/).filter(Boolean)) {
      const m = /^(url|method):(.*)$/.exec(token);
      if (m) parts[m[1]] = m[2];
      else parts.url = token;
    }
    const urlTest = parts.url ? matcher(parts.url) : () => true;
    const methodTest = parts.method ? matcher(parts.method) : () => true;
    return (url, method) => urlTest(url) && methodTest(method || 'GET');
  }

  function onReady(fn) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  }

  function observe(fn, { stay = false, timeout = 10000 } = {}) {
    let scheduled = false;
    const run = () => { scheduled = false; try { fn(); } catch (e) { log(e); } };
    const mo = new MutationObserver(() => {
      if (!scheduled) { scheduled = true; requestAnimationFrame(run); }
    });
    const start = () => {
      run();
      mo.observe(doc.documentElement || doc, { childList: true, subtree: true, attributes: true });
      if (!stay) setTimeout(() => mo.disconnect(), timeout);
    };
    if (doc.documentElement) start(); else onReady(start);
  }

  // ---- JSON pruning ------------------------------------------------------
  function pathExists(obj, path) {
    let cur = obj;
    for (const key of path.split('.')) {
      if (cur === null || typeof cur !== 'object' || !(key in cur)) return false;
      cur = cur[key];
    }
    return true;
  }

  function prunePath(obj, segments) {
    if (obj === null || typeof obj !== 'object') return false;
    const [head, ...rest] = segments;
    if (head === '[]' || head === '*') {
      let hit = false;
      for (const k of Object.keys(obj)) if (rest.length ? prunePath(obj[k], rest) : (delete obj[k], true)) hit = true;
      return hit;
    }
    if (head === '[-]') {
      // Remove array items in which the remaining path exists.
      if (!Array.isArray(obj)) return false;
      let hit = false;
      for (let i = obj.length - 1; i >= 0; i--) {
        if (rest.length === 0 || pathExists(obj[i], rest.join('.'))) { obj.splice(i, 1); hit = true; }
      }
      return hit;
    }
    if (!(head in obj)) return false;
    if (rest.length === 0) { delete obj[head]; return true; }
    return prunePath(obj[head], rest);
  }

  function makePruner(prunePaths, requiredPaths) {
    const prune = (prunePaths || '').split(/\s+/).filter(Boolean).map((p) => p.split('.'));
    const required = (requiredPaths || '').split(/\s+/).filter(Boolean);
    return (obj) => {
      if (obj === null || typeof obj !== 'object') return obj;
      if (required.length && !required.every((p) => pathExists(obj, p))) return obj;
      for (const p of prune) if (prunePath(obj, p)) log('json-prune', p.join('.'));
      return obj;
    };
  }

  // ---- fetch / XHR response hooks ------------------------------------------
  function hookFetchResponse(urlTest, transformText) {
    wrapFunction(win, 'fetch', (target, thisArg, args) => {
      const req = args[0];
      const url = req instanceof Request ? req.url : String(req);
      const method = (args[1] && args[1].method) || (req instanceof Request ? req.method : 'GET');
      const p = Reflect.apply(target, thisArg, args);
      if (!urlTest(url, method)) return p;
      return p.then((res) => res.clone().text().then((text) => {
        const out = transformText(text);
        if (out === text) return res;
        const replaced = new Response(out, { status: res.status, statusText: res.statusText, headers: res.headers });
        try {
          native.defineProperty(replaced, 'url', { value: res.url });
          native.defineProperty(replaced, 'type', { value: res.type });
        } catch {}
        return replaced;
      }).catch(() => res));
    });
  }

  function hookXhrResponse(urlTest, transformText) {
    const Native = win.XMLHttpRequest;
    const cache = new WeakMap();
    class Hooked extends Native {
      open(method, url, ...rest) {
        cache.set(this, { url: String(url), method: String(method), done: null });
        return super.open(method, url, ...rest);
      }
      _bastionResult() {
        const st = cache.get(this);
        if (!st || this.readyState !== 4 || !urlTest(st.url, st.method)) return null;
        if (st.done === null) {
          const type = super.responseType;
          if (type !== '' && type !== 'text' && type !== 'json') { st.done = false; return null; }
          let text;
          try { text = type === 'json' ? native.JSONstringify(super.response) : super.responseText; } catch { st.done = false; return null; }
          const out = transformText(text);
          st.done = out === text ? false : { text: out, type };
        }
        return st.done || null;
      }
      get response() {
        const r = this._bastionResult();
        if (!r) return super.response;
        if (r.type === 'json') { try { return native.JSONparse(r.text); } catch { return null; } }
        return r.text;
      }
      get responseText() {
        const r = this._bastionResult();
        return r && r.type !== 'json' ? r.text : super.responseText;
      }
    }
    win.XMLHttpRequest = Hooked;
  }

  // ---- scriptlets ----------------------------------------------------------
  const S = {};

  S['set-constant'] = (chain, raw) => {
    if (!chain) return;
    const value = resolveValue(raw === undefined ? 'undefined' : raw);
    if (value === INVALID) { log('set-constant: unsupported value', raw); return; }
    onChain(win, chain, (owner, prop) => {
      const desc = native.getOwnPropertyDescriptor(owner, prop);
      if (desc && desc.configurable === false) {
        if (desc.writable) try { owner[prop] = value; } catch {}
        return;
      }
      try {
        native.defineProperty(owner, prop, {
          configurable: false,
          enumerable: true,
          get() { return value; },
          set() {},
        });
      } catch (e) { log('set-constant failed', chain, e); }
    });
  };

  S['abort-on-property-read'] = (chain) => {
    if (!chain) return;
    onChain(win, chain, (owner, prop) => {
      try {
        native.defineProperty(owner, prop, {
          configurable: true,
          get() { throw new ReferenceError(MAGIC); },
          set() {},
        });
      } catch {}
    });
  };

  S['abort-on-property-write'] = (chain) => {
    if (!chain) return;
    onChain(win, chain, (owner, prop) => {
      try {
        native.defineProperty(owner, prop, {
          configurable: true,
          get() { return undefined; },
          set() { throw new ReferenceError(MAGIC); },
        });
      } catch {}
    });
  };

  S['abort-current-script'] = (chain, needle, context) => {
    if (!chain) return;
    const test = matcher(needle);
    const ctx = context ? matcher(context) : () => true;
    const shouldAbort = () => {
      const s = doc.currentScript;
      if (!s || !(s instanceof HTMLScriptElement)) return false;
      const text = s.src ? s.src : s.textContent;
      return ctx(text) && test(text);
    };
    onChain(win, chain, (owner, prop) => {
      let value = owner[prop];
      const desc = native.getOwnPropertyDescriptor(owner, prop);
      if (desc && desc.configurable === false) return;
      const getter = desc && desc.get;
      const setter = desc && desc.set;
      try {
        native.defineProperty(owner, prop, {
          configurable: true,
          get() {
            if (shouldAbort()) throw new ReferenceError(MAGIC);
            return getter ? getter.call(this) : value;
          },
          set(v) {
            if (shouldAbort()) throw new ReferenceError(MAGIC);
            if (setter) setter.call(this, v); else value = v;
          },
        });
      } catch {}
    });
  };

  S['abort-on-stack-trace'] = (chain, needle) => {
    if (!chain || !needle) return;
    const test = matcher(needle);
    onChain(win, chain, (owner, prop) => {
      let value = owner[prop];
      try {
        native.defineProperty(owner, prop, {
          configurable: true,
          get() { if (test(new Error().stack || '')) throw new ReferenceError(MAGIC); return value; },
          set(v) { if (test(new Error().stack || '')) throw new ReferenceError(MAGIC); value = v; },
        });
      } catch {}
    });
  };

  S['json-prune'] = (prunePaths, required) => {
    const prune = makePruner(prunePaths, required);
    wrapFunction(JSON, 'parse', (target, thisArg, args) => prune(Reflect.apply(target, thisArg, args)));
    wrapFunction(Response.prototype, 'json', (target, thisArg, args) => Reflect.apply(target, thisArg, args).then((o) => prune(o)));
  };

  S['json-prune-fetch-response'] = (prunePaths, required, ...rest) => {
    const prune = makePruner(prunePaths, required);
    hookFetchResponse(parseUrlMatch(rest), (text) => {
      try { return native.JSONstringify(prune(native.JSONparse(text))); } catch { return text; }
    });
  };

  S['json-prune-xhr-response'] = (prunePaths, required, ...rest) => {
    const prune = makePruner(prunePaths, required);
    hookXhrResponse(parseUrlMatch(rest), (text) => {
      try { return native.JSONstringify(prune(native.JSONparse(text))); } catch { return text; }
    });
  };

  function replacer(pattern, replacement) {
    if (!pattern) return null;
    const re = /^\/.+\/[dgimsuy]*$/.test(pattern) ? toRegex(pattern) : toRegex(pattern, 'g');
    const rep = replacement === undefined ? '' : replacement;
    return (text) => text.replace(re, rep);
  }

  S['replace-fetch-response'] = (pattern, replacement, ...rest) => {
    const r = replacer(pattern, replacement);
    if (r) hookFetchResponse(parseUrlMatch(rest), r);
  };

  S['replace-xhr-response'] = (pattern, replacement, ...rest) => {
    const r = replacer(pattern, replacement);
    if (r) hookXhrResponse(parseUrlMatch(rest), r);
  };

  function timerDefuser(name) {
    return (needle, delay) => {
      const test = matcher(needle);
      let delayTest = () => true;
      if (delay !== undefined && delay !== '') {
        const neg = String(delay).startsWith('!');
        const d = parseInt(String(delay).replace('!', ''), 10);
        delayTest = (v) => ((Number(v) || 0) === d) !== neg;
      }
      wrapFunction(win, name, (target, thisArg, args) => {
        if (test(fnText(args[0])) && delayTest(args[1])) {
          log(name, 'defused', fnText(args[0]).slice(0, 80));
          args = [function () {}, args[1]];
        }
        return Reflect.apply(target, thisArg, args);
      });
    };
  }
  S['prevent-setTimeout'] = timerDefuser('setTimeout');
  S['prevent-setInterval'] = timerDefuser('setInterval');

  function timerBooster(name) {
    return (needle, delay, boost) => {
      const test = matcher(needle);
      const d = delay === undefined || delay === '' || delay === '*' ? null : parseInt(delay, 10);
      let b = parseFloat(boost);
      if (!(b > 0)) b = 0.05;
      b = Math.min(50, Math.max(0.001, b));
      wrapFunction(win, name, (target, thisArg, args) => {
        if (test(fnText(args[0])) && (d === null || Number(args[1]) === d)) args[1] = (Number(args[1]) || 0) * b;
        return Reflect.apply(target, thisArg, args);
      });
    };
  }
  S['adjust-setTimeout'] = timerBooster('setTimeout');
  S['adjust-setInterval'] = timerBooster('setInterval');

  S['prevent-requestAnimationFrame'] = (needle) => {
    const test = matcher(needle);
    wrapFunction(win, 'requestAnimationFrame', (target, thisArg, args) => {
      if (test(fnText(args[0]))) args = [function () {}];
      return Reflect.apply(target, thisArg, args);
    });
  };

  S['prevent-addEventListener'] = (type, needle) => {
    const typeTest = matcher(type);
    const test = matcher(needle);
    wrapFunction(EventTarget.prototype, 'addEventListener', (target, thisArg, args) => {
      const handler = args[1];
      const text = handler && typeof handler === 'object' && handler.handleEvent ? fnText(handler.handleEvent) : fnText(handler);
      if (typeTest(args[0]) && test(text)) {
        log('addEventListener defused', args[0]);
        return undefined;
      }
      return Reflect.apply(target, thisArg, args);
    });
  };

  function fakeResponseBody(kind) {
    if (kind === 'emptyObj') return '{}';
    if (kind === 'emptyArr') return '[]';
    if (kind === 'emptyStr' || !kind) return '';
    return '';
  }

  S['prevent-fetch'] = (props, responseBody, responseType) => {
    if (props === undefined || props === '') return;
    const test = parseUrlMatch([props === '*' ? '' : props]);
    wrapFunction(win, 'fetch', (target, thisArg, args) => {
      const req = args[0];
      const url = req instanceof Request ? req.url : String(req);
      const method = (args[1] && args[1].method) || (req instanceof Request ? req.method : 'GET');
      if (!test(url, method)) return Reflect.apply(target, thisArg, args);
      log('fetch prevented', url);
      const res = new Response(fakeResponseBody(responseBody), { status: 200, statusText: 'OK' });
      try {
        native.defineProperty(res, 'url', { value: url });
        if (responseType === 'opaque') native.defineProperty(res, 'type', { value: 'opaque' });
      } catch {}
      return Promise.resolve(res);
    });
  };

  S['prevent-xhr'] = (props, responseBody) => {
    if (props === undefined || props === '') return;
    const test = parseUrlMatch([props === '*' ? '' : props]);
    const Native = win.XMLHttpRequest;
    const state = new WeakMap();
    class Hooked extends Native {
      open(method, url, ...rest) {
        state.set(this, { prevented: test(String(url), String(method)), url: String(url) });
        return super.open(method, url, ...rest);
      }
      send(...args) {
        const st = state.get(this);
        if (!st || !st.prevented) return super.send(...args);
        log('xhr prevented', st.url);
        const body = fakeResponseBody(responseBody);
        const define = (k, v) => { try { native.defineProperty(this, k, { value: v, configurable: true }); } catch {} };
        define('readyState', 4);
        define('status', 200);
        define('statusText', 'OK');
        define('responseURL', st.url);
        define('responseText', body);
        define('response', this.responseType === 'json' ? (body ? native.JSONparse(body) : null) : body);
        setTimeout(() => {
          for (const t of ['readystatechange', 'load', 'loadend']) {
            this.dispatchEvent(new Event(t));
          }
        }, 1);
      }
    }
    win.XMLHttpRequest = Hooked;
  };

  function forEachMatch(selector, fn, behavior) {
    const stay = /stay/.test(behavior || '');
    const run = () => { for (const el of doc.querySelectorAll(selector)) fn(el); };
    if (/complete/.test(behavior || '')) {
      if (doc.readyState === 'complete') observe(run, { stay });
      else win.addEventListener('load', () => observe(run, { stay }), { once: true });
    } else observe(run, { stay });
  }

  S['remove-attr'] = (attrs, selector, behavior) => {
    const names = (attrs || '').split(/\s*\|\s*/).filter(Boolean);
    if (!names.length) return;
    const sel = selector || names.map((n) => `[${CSS.escape(n)}]`).join(',');
    forEachMatch(sel, (el) => { for (const n of names) el.removeAttribute(n); }, behavior);
  };

  S['remove-class'] = (classes, selector, behavior) => {
    const names = (classes || '').split(/\s*\|\s*/).filter(Boolean);
    if (!names.length) return;
    const sel = selector || names.map((n) => '.' + CSS.escape(n)).join(',');
    forEachMatch(sel, (el) => el.classList.remove(...names), behavior);
  };

  S['set-attr'] = (selector, attr, value) => {
    if (!selector || !attr || /^on/i.test(attr)) return;
    const v = value === undefined ? '' : value;
    forEachMatch(selector, (el) => { if (el.getAttribute(attr) !== v) el.setAttribute(attr, v); }, 'stay');
  };

  function setCookie(name, value, path) {
    if (!name) return false;
    const before = doc.cookie;
    const v = value === undefined ? '' : value;
    let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(v)}; path=${path === 'none' ? '' : (path || '/')}`;
    if (location.protocol === 'https:') cookie += '; secure';
    cookie += '; max-age=31536000; samesite=lax';
    doc.cookie = cookie;
    return before !== doc.cookie;
  }

  S['set-cookie'] = (name, value, path) => { setCookie(name, value, path); };

  S['set-cookie-reload'] = (name, value, path) => {
    const key = 'bastion-reload-' + name;
    if (setCookie(name, value, path) && !sessionStorage.getItem(key)) {
      try { sessionStorage.setItem(key, '1'); } catch {}
      location.reload();
    }
  };

  S['remove-cookie'] = (needle) => {
    const test = matcher(needle);
    const removeAll = () => {
      for (const part of doc.cookie.split(';')) {
        const name = part.split('=')[0].trim();
        if (!name || !test(name)) continue;
        const host = location.hostname;
        for (const domain of ['', host, '.' + host, '.' + host.split('.').slice(-2).join('.')]) {
          doc.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/` + (domain ? '; domain=' + domain : '');
        }
      }
    };
    removeAll();
    win.addEventListener('beforeunload', removeAll);
    onReady(removeAll);
  };

  function storageSetter(storageName) {
    return (key, raw) => {
      if (!key) return;
      let storage;
      try { storage = win[storageName]; } catch { return; }
      if (raw === '$remove$') {
        const test = matcher(key);
        for (const k of Object.keys(storage)) if (test(k)) storage.removeItem(k);
        return;
      }
      const value = resolveValue(raw === undefined ? '' : raw);
      if (value === INVALID && raw !== undefined) { storage.setItem(key, raw); return; }
      if (value === undefined) { storage.removeItem(key); return; }
      storage.setItem(key, typeof value === 'object' ? native.JSONstringify(value) : String(value));
    };
  }
  S['set-local-storage-item'] = storageSetter('localStorage');
  S['set-session-storage-item'] = storageSetter('sessionStorage');

  S['prevent-window-open'] = (needle, delay, decoy) => {
    const test = matcher(needle);
    wrapFunction(win, 'open', (target, thisArg, args) => {
      if (!test(String(args[0] || ''))) return Reflect.apply(target, thisArg, args);
      log('window.open prevented', args[0]);
      if (decoy) return null;
      // A minimal fake window so scripts that check the return value proceed.
      return new Proxy({}, {
        get(t, prop) {
          if (prop === 'closed') return false;
          if (prop === 'document') return doc.implementation.createHTMLDocument('');
          return function () {};
        },
        set() { return true; },
      });
    });
  };

  S['prevent-eval-if'] = (needle) => {
    const test = matcher(needle);
    wrapFunction(win, 'eval', (target, thisArg, args) => {
      if (test(String(args[0]))) { log('eval prevented'); return undefined; }
      return Reflect.apply(target, thisArg, args);
    });
  };

  S['prevent-refresh'] = () => {
    onReady(() => {
      for (const meta of doc.querySelectorAll('meta[http-equiv="refresh" i]')) meta.remove();
    });
  };

  S['nowebrtc'] = () => {
    const names = ['RTCPeerConnection', 'webkitRTCPeerConnection'];
    for (const n of names) {
      if (typeof win[n] !== 'function') continue;
      win[n] = function () {
        return { close() {}, createDataChannel() { return {}; }, createOffer() { return Promise.reject(new Error('blocked')); }, setLocalDescription() { return Promise.resolve(); }, addEventListener() {} };
      };
    }
  };

  S['disable-newtab-links'] = () => {
    doc.addEventListener('click', (ev) => {
      const a = ev.target && ev.target.closest && ev.target.closest('a[target]');
      if (a && a.target !== '_self') a.target = '_self';
    }, true);
  };

  S['close-window'] = (path) => {
    if (!path || matcher(path)(location.pathname + location.search)) win.close();
  };

  S['remove-node-text'] = (nodeName, needle) => {
    const nameTest = matcher(nodeName === '#text' ? '#text' : (nodeName || '').toUpperCase());
    const test = matcher(needle);
    const check = (node) => {
      const name = node.nodeName === '#text' ? '#text' : node.nodeName.toUpperCase();
      if (nameTest(name) && test(node.textContent)) { node.textContent = ''; log('node text removed'); }
    };
    const mo = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) check(n);
    });
    mo.observe(doc, { childList: true, subtree: true });
    onReady(() => { setTimeout(() => mo.disconnect(), 30000); });
  };

  S['replace-node-text'] = (nodeName, textMatch, pattern, replacement) => {
    const nameTest = matcher((nodeName || '').toUpperCase());
    const test = matcher(textMatch);
    const r = replacer(pattern, replacement);
    if (!r) return;
    const mo = new MutationObserver((records) => {
      for (const rec of records) for (const n of rec.addedNodes) {
        const name = n.nodeName.toUpperCase();
        if (nameTest(name) && test(n.textContent)) n.textContent = r(n.textContent);
      }
    });
    mo.observe(doc, { childList: true, subtree: true });
    onReady(() => { setTimeout(() => mo.disconnect(), 30000); });
  };

  S['prevent-element-src-loading'] = (tagName, needle) => {
    const tags = { script: 'HTMLScriptElement', img: 'HTMLImageElement', iframe: 'HTMLIFrameElement', link: 'HTMLLinkElement' };
    const ctorName = tags[(tagName || '').toLowerCase()];
    if (!ctorName || !win[ctorName]) return;
    const test = matcher(needle);
    const attr = tagName.toLowerCase() === 'link' ? 'href' : 'src';
    const blank = tagName.toLowerCase() === 'script' ? 'data:text/javascript,' : 'data:,';
    const proto = win[ctorName].prototype;
    const desc = native.getOwnPropertyDescriptor(proto, attr);
    if (desc && desc.set) {
      native.defineProperty(proto, attr, {
        ...desc,
        set(v) { return desc.set.call(this, test(String(v)) ? blank : v); },
      });
    }
    wrapFunction(Element.prototype, 'setAttribute', (target, thisArg, args) => {
      if (thisArg instanceof win[ctorName] && String(args[0]).toLowerCase() === attr && test(String(args[1]))) args = [args[0], blank];
      return Reflect.apply(target, thisArg, args);
    });
  };

  S['href-sanitizer'] = (selector, source) => {
    if (!selector) return;
    const src = source || 'text';
    forEachMatch(selector, (a) => {
      let target = null;
      if (src === 'text') target = a.textContent.trim();
      else if (src.startsWith('?')) {
        try { target = new URL(a.href).searchParams.get(src.slice(1)); } catch {}
      } else if (src.startsWith('[') && src.endsWith(']')) target = a.getAttribute(src.slice(1, -1));
      if (target && /^https?:\/\//.test(target) && a.href !== target) a.href = target;
    }, 'stay');
  };

  S['no-topics'] = () => {
    if ('browsingTopics' in doc) {
      try { native.defineProperty(doc, 'browsingTopics', { value: () => Promise.resolve([]) }); } catch {}
    }
  };

  S['hide-if-contains'] = (search, selector, searchSelector) => {
    if (!search || !selector) return;
    const test = matcher(search);
    forEachMatch(selector, (el) => {
      const targets = searchSelector ? el.querySelectorAll(searchSelector) : [el];
      for (const t of targets) {
        if (test(t.textContent)) { el.style.setProperty('display', 'none', 'important'); break; }
      }
    }, 'stay');
  };

  S['click-element'] = (selectors, extraMatch, delay) => {
    if (!selectors) return;
    const list = selectors.split(/\s*,\s*(?![^[]*\])/).filter(Boolean);
    const wait = Math.min(10000, Math.max(0, parseInt(delay, 10) || 0));
    let i = 0;
    const deadline = Date.now() + 10000;
    const tick = () => {
      if (i >= list.length || Date.now() > deadline) return true;
      let el = null;
      try {
        // ">>>" pierces open shadow roots (uBO syntax).
        const parts = list[i].split(/\s*>>>\s*/);
        let root = doc;
        for (const p of parts) {
          el = root.querySelector(p);
          if (!el) break;
          root = el.shadowRoot || el;
        }
      } catch { i++; return false; }
      if (el) {
        setTimeout(() => { try { el.click(); log('clicked', list[i - 1]); } catch {} }, wait);
        i++;
      }
      return i >= list.length;
    };
    const mo = new MutationObserver(() => { if (tick()) mo.disconnect(); });
    onReady(() => {
      if (tick()) return;
      mo.observe(doc.documentElement, { childList: true, subtree: true });
      setTimeout(() => mo.disconnect(), 10000);
    });
  };

  S['log'] = (...args) => console.log('[Bastion log]', ...args);

  // ---- run -----------------------------------------------------------------
  for (const call of calls) {
    const [name, ...args] = call;
    const fn = S[name];
    if (!fn) { log('unknown scriptlet', name); continue; }
    try { fn(...args); log('ran', name, args); } catch (e) { log('scriptlet failed', name, e); }
  }
};
