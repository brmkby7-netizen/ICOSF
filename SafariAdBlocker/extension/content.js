/*
 * Bastion content script (isolated world, document_start, all frames).
 *
 * 1. Synchronously loads the bundled rule shards for this hostname and
 *    injects scriptlets before page scripts run.
 * 2. Starts the procedural cosmetic engine and asks the background worker
 *    to insert CSS as a user stylesheet (pages cannot remove it).
 * 3. Asks the background worker for rules from the newest dataset the app
 *    has compiled, plus element-picker rules, and applies anything new.
 *
 * Paused sites never get this script: the background worker registers it
 * with excludeMatches built from the allowlist.
 */
(function () {
  'use strict';
  if (globalThis.__bastionContentLoaded) return;
  globalThis.__bastionContentLoaded = true;

  const B = globalThis.browser || globalThis.chrome;
  const { lookupParts, shardsFor } = globalThis.BastionLookup;

  let host = location.hostname;
  if (!host) {
    // about:blank / srcdoc frames inherit their parent's origin.
    try { host = window.parent.location.hostname; } catch { host = ''; }
  }
  if (!host || !/^https?:$|^about:$/.test(location.protocol)) return;

  const applied = { scriptlets: new Set(), extended: new Set(), css: new Set() };
  const engine = new globalThis.BastionProcedural.Engine({
    onHide: (n) => reportCount(n),
  });

  // ---- 1. bundled rules, synchronously ------------------------------------
  function syncJSON(path) {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', B.runtime.getURL(path), false);
      xhr.send();
      if (xhr.status === 200 || (xhr.status === 0 && xhr.responseText)) return JSON.parse(xhr.responseText);
    } catch {
      // Missing bundle (e.g. development build without rules): fall through.
    }
    return null;
  }

  let bundledVersion = null;
  const manifest = syncJSON('rules/web/manifest.json');
  if (manifest) {
    bundledVersion = manifest.version;
    const parts = [syncJSON('rules/web/generic.json')];
    for (const n of shardsFor(host, manifest.count)) parts.push(syncJSON(`rules/web/s${n}.json`));
    applyRules(lookupParts(parts, host));
  }

  // ---- 3. newest rules + picker rules from the background -------------------
  try {
    B.runtime.sendMessage({ type: 'page', host, bundledVersion }).then((resp) => {
      if (!resp) return;
      if (resp.rules) applyRules(resp.rules);
      if (resp.picker && resp.picker.length) {
        insertCSS(resp.picker.map((sel) => `${sel} { display: none !important; }`).join('\n'));
      }
      if (resp.debug) console.log('[Bastion] rules for', host, resp.rules);
    }, () => {});
  } catch {
    // Extension context invalidated (e.g. extension updated): nothing to do.
  }

  function applyRules(rules) {
    const scriptlets = rules.scriptlets.filter((s) => {
      const k = JSON.stringify(s);
      if (applied.scriptlets.has(k)) return false;
      applied.scriptlets.add(k);
      return true;
    });
    if (scriptlets.length) injectScriptlets(scriptlets);

    const css = [];
    for (const c of rules.css) {
      const k = c.sel + '{' + c.style;
      if (applied.css.has(k)) continue;
      applied.css.add(k);
      if (c.ext) engine.add([c.sel], c.style);
      else css.push(`${c.sel} { ${c.style} }`);
    }
    if (css.length) insertCSS(css.join('\n'));

    const extended = rules.extended.filter((sel) => {
      if (applied.extended.has(sel)) return false;
      applied.extended.add(sel);
      return true;
    });
    if (extended.length) engine.add(extended);
  }

  // ---- scriptlet injection ---------------------------------------------------
  function injectScriptlets(calls) {
    // The inline script fires a one-off DOM event so we can tell (synchronously)
    // whether the page's CSP let it run. Events cross the world boundary.
    const flag = 'bst' + Math.random().toString(36).slice(2, 10);
    const code =
      `document.dispatchEvent(new Event(${JSON.stringify(flag)}));` +
      `(${globalThis.bastionScriptletRuntime.toString()})(${JSON.stringify(calls)},{debug:false});`;
    let ran = false;
    const onRan = () => { ran = true; };
    document.addEventListener(flag, onRan, { once: true });
    try {
      const script = document.createElement('script');
      script.textContent = code;
      // At document_start <html> may not exist yet; a script appended to the
      // document itself still executes synchronously.
      (document.head || document.documentElement || document).appendChild(script);
      script.remove();
    } catch {}
    document.removeEventListener(flag, onRan);
    if (!ran) {
      // Blocked by the page's Content-Security-Policy: let the background
      // worker inject through the scripting API instead.
      try { B.runtime.sendMessage({ type: 'injectScriptlets', calls }); } catch {}
    }
  }

  function insertCSS(css) {
    try {
      B.runtime.sendMessage({ type: 'insertCSS', css }).then(null, () => fallbackStyle(css));
    } catch {
      fallbackStyle(css);
    }
  }

  function fallbackStyle(css) {
    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  let countTimer = 0;
  function reportCount(n) {
    if (window !== window.top) return;
    clearTimeout(countTimer);
    countTimer = setTimeout(() => {
      try { B.runtime.sendMessage({ type: 'count', hidden: n }); } catch {}
    }, 500);
  }
})();
