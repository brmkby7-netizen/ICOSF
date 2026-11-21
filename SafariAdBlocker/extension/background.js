/*
 * Bastion background service worker.
 *
 * - Registers the content scripts, excluding paused sites.
 * - Syncs with the native app (allowlist, newest compiled web rules) over
 *   native messaging; the app is the source of truth.
 * - Inserts CSS and (when a page's CSP blocks inline scripts) scriptlets on
 *   behalf of content scripts.
 * - Stores element-picker rules.
 */
/* global importScripts, bastionScriptletRuntime, BastionLookup */
importScripts('lookup.js', 'scriptlets.js');

const B = globalThis.browser || globalThis.chrome;
const NATIVE_APP_ID = 'app.bastion.Bastion'; // Ignored by Safari, required by the API.
const CONTENT_SCRIPT_ID = 'bastion-content';
const CHUNK_SIZE = 512 * 1024;

// True once the content scripts are registered dynamically. Engines without
// scripting.registerContentScripts fall back to injecting on navigation.
let dynamicRegistration = false;
const CONTENT_FILES = ['lookup.js', 'scriptlets.js', 'procedural.js', 'content.js'];

const state = {
  loaded: null,
  allowlist: [],
  picker: {}, // host -> [selectors]
  webIndex: null, // newest index from the app (parsed), or null to use bundled rules
  webIndexVersion: null,
  hiddenByTab: new Map(),
  lastSync: 0,
};

// ---- persistence -------------------------------------------------------------
function load() {
  if (!state.loaded) {
    state.loaded = B.storage.local.get(['allowlist', 'picker', 'webIndexVersion', 'webIndexJSON']).then((s) => {
      state.allowlist = s.allowlist || [];
      state.picker = s.picker || {};
      if (s.webIndexJSON) {
        try {
          state.webIndex = JSON.parse(s.webIndexJSON);
          state.webIndexVersion = s.webIndexVersion || null;
        } catch {
          state.webIndex = null;
        }
      }
    });
  }
  return state.loaded;
}

function save(keys) {
  const data = {};
  for (const k of keys) data[k] = state[k];
  return B.storage.local.set(data);
}

// ---- content script registration -------------------------------------------
function excludeMatches() {
  return state.allowlist.flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]);
}

async function registerContentScripts() {
  if (!B.scripting || !B.scripting.registerContentScripts) return;
  const script = {
    id: CONTENT_SCRIPT_ID,
    js: CONTENT_FILES,
    matches: ['http://*/*', 'https://*/*'],
    excludeMatches: excludeMatches(),
    runAt: 'document_start',
    allFrames: true,
  };
  try {
    const existing = await B.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    if (existing && existing.length) await B.scripting.updateContentScripts([script]);
    else await B.scripting.registerContentScripts([script]);
    dynamicRegistration = true;
  } catch (e) {
    // Some engines reject updates for scripts registered by a previous
    // worker instance; start over.
    try {
      await B.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    } catch {}
    try {
      await B.scripting.registerContentScripts([script]);
      dynamicRegistration = true;
    } catch (e2) {
      dynamicRegistration = false;
      console.error('[Bastion] could not register content scripts; injecting on navigation instead', e2);
    }
  }
}

// ---- native app sync -----------------------------------------------------------
async function native(message) {
  try {
    return await B.runtime.sendNativeMessage(NATIVE_APP_ID, message);
  } catch (e) {
    return null; // App not installed / not reachable (e.g. development in Chrome).
  }
}

async function syncWithApp(force) {
  await load();
  if (!force && Date.now() - state.lastSync < 60 * 1000) return;
  state.lastSync = Date.now();
  const remote = await native({ type: 'getState' });
  if (!remote) return;

  if (Array.isArray(remote.allowlist)) {
    const changed = JSON.stringify(remote.allowlist) !== JSON.stringify(state.allowlist);
    state.allowlist = remote.allowlist;
    if (changed) {
      await save(['allowlist']);
      await registerContentScripts();
    }
  }

  if (remote.webIndexVersion && remote.webIndexVersion !== state.webIndexVersion && remote.webIndexSize > 0) {
    let json = '';
    for (let offset = 0; offset < remote.webIndexSize; offset += CHUNK_SIZE) {
      const chunk = await native({ type: 'getWebIndexChunk', version: remote.webIndexVersion, offset, length: CHUNK_SIZE });
      if (!chunk || typeof chunk.data !== 'string') return;
      json += chunk.data;
    }
    try {
      state.webIndex = JSON.parse(json);
      state.webIndexVersion = remote.webIndexVersion;
      await B.storage.local.set({ webIndexJSON: json, webIndexVersion: remote.webIndexVersion });
    } catch (e) {
      console.error('[Bastion] bad web index from app', e);
    }
  }
}

// ---- helpers -------------------------------------------------------------------
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isPaused(host) {
  return state.allowlist.some((d) => host === d || host.endsWith('.' + d));
}

function pickerRulesFor(host) {
  const out = [];
  for (const [d, selectors] of Object.entries(state.picker)) {
    if (host === d || host.endsWith('.' + d)) out.push(...selectors);
  }
  return out;
}

function registrableDomain(host) {
  // Good enough for the allowlist UI; the app shows the exact entry.
  const parts = host.replace(/^www\./, '').split('.');
  if (parts.length > 2 && /^(co|com|org|net|gov|ac|edu)$/.test(parts[parts.length - 2])) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

// ---- messages ------------------------------------------------------------------
async function handleMessage(msg, sender) {
  await load();
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  const frameId = sender && typeof sender.frameId === 'number' ? sender.frameId : 0;

  switch (msg && msg.type) {
    case 'page': {
      syncWithApp(false);
      const rules = state.webIndex ? BastionLookup.lookupParts([state.webIndex], msg.host) : null;
      if (sender.frameId === 0 && tabId !== undefined) state.hiddenByTab.set(tabId, 0);
      return { rules, picker: pickerRulesFor(msg.host) };
    }
    case 'insertCSS': {
      if (tabId === undefined) return false;
      const details = { target: { tabId, frameIds: [frameId] }, css: msg.css };
      try {
        await B.scripting.insertCSS({ ...details, origin: 'USER' });
      } catch {
        await B.scripting.insertCSS(details);
      }
      return true;
    }
    case 'injectScriptlets': {
      if (tabId === undefined || !Array.isArray(msg.calls)) return false;
      await B.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        world: 'MAIN',
        injectImmediately: true,
        func: bastionScriptletRuntime,
        args: [msg.calls, { debug: false }],
      });
      return true;
    }
    case 'count': {
      if (tabId !== undefined) state.hiddenByTab.set(tabId, msg.hidden);
      return true;
    }

    // ---- popup ----
    case 'getTabState': {
      syncWithApp(false);
      const tab = await B.tabs.get(msg.tabId);
      const host = hostOf(tab.url || '');
      return {
        host,
        site: host ? registrableDomain(host) : '',
        supported: /^https?:/.test(tab.url || ''),
        paused: host ? isPaused(host) : false,
        hidden: state.hiddenByTab.get(msg.tabId) || 0,
        pickerCount: host ? pickerRulesFor(host).length : 0,
        rulesVersion: state.webIndexVersion,
      };
    }
    case 'setPaused': {
      const site = msg.site;
      if (!site) return false;
      if (msg.paused) state.allowlist.push(site);
      // Resuming removes every entry covering this site (parents and children).
      else state.allowlist = state.allowlist.filter((d) => !(site === d || site.endsWith('.' + d) || d.endsWith('.' + site)));
      state.allowlist = [...new Set(state.allowlist)].sort();
      await save(['allowlist']);
      await registerContentScripts();
      // The app rebuilds the content blockers' allowlist rules and reloads them.
      await native({ type: 'setAllowlist', allowlist: state.allowlist });
      return { paused: msg.paused };
    }
    case 'startPicker': {
      await B.scripting.executeScript({ target: { tabId: msg.tabId }, files: ['picker.js'] });
      return true;
    }
    case 'pickerAdd': {
      const host = msg.host;
      if (!host || !msg.selector) return false;
      const key = registrableDomain(host) === host.replace(/^www\./, '') ? registrableDomain(host) : host;
      state.picker[key] = [...new Set([...(state.picker[key] || []), msg.selector])];
      await save(['picker']);
      if (tabId !== undefined) {
        await B.scripting.insertCSS({ target: { tabId, allFrames: true }, css: `${msg.selector} { display: none !important; }` }).catch(() => {});
      }
      // Also hand it to the app so the content blocker hides it before paint.
      native({ type: 'addCustomRule', rule: `${key}##${msg.selector}` });
      return true;
    }
    case 'resetPicker': {
      const host = msg.host;
      const removed = [];
      for (const d of Object.keys(state.picker)) {
        if (host === d || host.endsWith('.' + d)) {
          removed.push(...state.picker[d].map((s) => `${d}##${s}`));
          delete state.picker[d];
        }
      }
      await save(['picker']);
      if (removed.length) native({ type: 'removeCustomRules', rules: removed });
      return true;
    }
    case 'syncNow': {
      await syncWithApp(true);
      return { version: state.webIndexVersion };
    }
    default:
      return undefined;
  }
}

B.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse, (e) => {
    console.error('[Bastion]', e);
    sendResponse(undefined);
  });
  return true;
});

// Fallback injection for engines without dynamic content-script registration.
if (B.webNavigation && B.webNavigation.onCommitted) {
  B.webNavigation.onCommitted.addListener(async (details) => {
    if (dynamicRegistration || !/^https?:/.test(details.url)) return;
    await load();
    if (isPaused(hostOf(details.url))) return;
    B.scripting
      .executeScript({ target: { tabId: details.tabId, frameIds: [details.frameId] }, files: CONTENT_FILES, injectImmediately: true })
      .catch(() => {});
  });
}

B.tabs.onRemoved.addListener((tabId) => state.hiddenByTab.delete(tabId));

B.runtime.onInstalled.addListener(() => {
  load().then(registerContentScripts).then(() => syncWithApp(true));
});
B.runtime.onStartup && B.runtime.onStartup.addListener(() => {
  load().then(registerContentScripts).then(() => syncWithApp(true));
});

// Each time the worker wakes up, make sure registration reflects storage.
load().then(registerContentScripts);
