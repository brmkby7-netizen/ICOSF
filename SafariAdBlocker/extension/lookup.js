/*
 * Hostname -> rules lookup over the compiled web index (format v2, see
 * compiler/src/web.js). Shared by content scripts and the background worker.
 * Kept in sync with compiler/src/web.js by extension/test/lookup.test.js.
 */
(function () {
  'use strict';

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function candidateKeys(hostname) {
    const labels = hostname.split('.');
    const keys = [];
    for (let i = 0; i < labels.length; i++) {
      const suffix = labels.slice(i).join('.');
      if (i < labels.length - 1 || labels.length === 1) keys.push(suffix);
      for (let j = i + 1; j < labels.length; j++) keys.push(labels.slice(i, j).join('.') + '.*');
    }
    return keys;
  }

  function matchesDomain(hostname, d) {
    if (d.endsWith('.*')) {
      const base = d.slice(0, -2);
      const at = hostname === base ? -1 : hostname.indexOf(base + '.');
      if (at === -1) return false;
      return at === 0 || hostname[at - 1] === '.';
    }
    return hostname === d || hostname.endsWith('.' + d);
  }

  function lookupParts(parts, hostname) {
    const keys = candidateKeys(hostname);
    const out = { s: [], e: [], c: [] };
    const xs = new Set();
    const xe = new Set();
    const seen = new Set();
    for (const part of parts) {
      if (!part) continue;
      const take = (bucket) => {
        if (!bucket) return;
        for (const k of ['s', 'e', 'c']) {
          for (const id of bucket[k] || []) {
            const entry = part.entries[id];
            if (!entry) continue;
            if (entry.n && entry.n.some((d) => matchesDomain(hostname, d))) continue;
            const sig = k + JSON.stringify(entry);
            if (seen.has(sig)) continue;
            seen.add(sig);
            out[k].push(entry);
          }
        }
        for (const x of bucket.xs || []) xs.add(x);
        for (const x of bucket.xe || []) xe.add(x);
      };
      if (part.generic) take(part.generic);
      if (part.domains) {
        take(part.domains['']);
        for (const key of keys) take(part.domains[key]);
      }
    }
    const scriptlets = xs.has('') ? [] : out.s.map((e) => e.s).filter((s) => !xs.has(JSON.stringify(s)));
    return {
      scriptlets,
      extended: out.e.map((e) => e.sel).filter((sel) => !xe.has(sel)),
      css: out.c.map(({ sel, style, ext }) => ({ sel, style, ext: Boolean(ext) })),
    };
  }

  /** Shard numbers a content script must load for `hostname`. */
  function shardsFor(hostname, count) {
    return [...new Set(candidateKeys(hostname).map((k) => fnv1a(k) % count))].sort((a, b) => a - b);
  }

  globalThis.BastionLookup = { fnv1a, candidateKeys, matchesDomain, lookupParts, shardsFor };
})();
