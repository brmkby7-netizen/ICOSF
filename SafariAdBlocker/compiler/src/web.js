// Indexes rules for the Bastion web extension by hostname so content scripts
// only touch the handful that apply to the current page.
//
// Format v2:
// {
//   v: 2,
//   entries: [ {s:[name,...args]} | {sel} | {sel, style, ext?} ],   // deduplicated
//   generic: { s:[i], e:[i], c:[i], xs:[sig], xe:[sel] },
//   domains: { "example.com" | "example.*": { s:[i], e:[i], c:[i], xs:[sig], xe:[sel], n:{i:[excluded]} } }
// }
// `s` = scriptlets, `e` = procedural selectors, `c` = CSS injections,
// `xs` = scriptlet exceptions (JSON signature, "" = all), `xe` = procedural
// exceptions. Entries may carry `n` (excluded domains).

export function buildWebIndex(web) {
  const entries = [];
  const entryIds = new Map();
  const idOf = (value) => {
    const key = JSON.stringify(value);
    let id = entryIds.get(key);
    if (id === undefined) {
      id = entries.length;
      entries.push(value);
      entryIds.set(key, id);
    }
    return id;
  };
  const index = { v: 2, entries, generic: { s: [], e: [], c: [] }, domains: {} };
  const bucket = (d) => (index.domains[d] ||= {});
  const push = (target, key, value) => (target[key] ||= []).push(value);

  const add = (list, key, mk) => {
    for (const item of list) {
      const value = mk(item);
      if (item.n && item.n.length) value.n = [...item.n].sort();
      const id = idOf(value);
      if (!item.d || item.d.length === 0) push(index.generic, key, id);
      else for (const d of item.d) push(bucket(d), key, id);
    }
  };
  add(web.scriptlets, 's', (i) => ({ s: i.s }));
  add(web.extended, 'e', (i) => ({ sel: i.sel }));
  add(web.css, 'c', (i) => ({ sel: i.sel, style: i.style, ...(i.ext ? { ext: 1 } : {}) }));

  for (const x of web.scriptletExceptions) {
    const sig = x.s.length ? JSON.stringify(x.s) : '';
    if (!x.d || x.d.length === 0) push(index.generic, 'xs', sig);
    else for (const d of x.d) push(bucket(d), 'xs', sig);
  }
  for (const x of web.extendedExceptions) {
    if (!x.d || x.d.length === 0) push(index.generic, 'xe', x.sel);
    else for (const d of x.d) push(bucket(d), 'xe', x.sel);
  }
  return index;
}

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Index keys that can apply to `hostname`: its parent domains + entities. */
export function candidateKeys(hostname) {
  const labels = hostname.split('.');
  const keys = [];
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i).join('.');
    if (i < labels.length - 1 || labels.length === 1) keys.push(suffix);
    // Entities: "example.*" matches example.<any public suffix>.
    for (let j = i + 1; j < labels.length; j++) keys.push(labels.slice(i, j).join('.') + '.*');
  }
  return keys;
}

/** Splits an index into self-contained shards keyed by fnv1a(key) % count. */
export function shardWebIndex(index, count = 64) {
  const shards = Array.from({ length: count }, () => ({ entries: [], domains: {} }));
  const local = Array.from({ length: count }, () => new Map());
  const remap = (shardNo, ids) =>
    ids.map((id) => {
      const m = local[shardNo];
      let n = m.get(id);
      if (n === undefined) {
        n = shards[shardNo].entries.length;
        shards[shardNo].entries.push(index.entries[id]);
        m.set(id, n);
      }
      return n;
    });
  for (const [d, v] of Object.entries(index.domains)) {
    const no = fnv1a(d) % count;
    const out = {};
    for (const k of ['s', 'e', 'c']) if (v[k]) out[k] = remap(no, v[k]);
    if (v.xs) out.xs = v.xs;
    if (v.xe) out.xe = v.xe;
    shards[no].domains[d] = out;
  }
  const generic = { entries: [], domains: { '': {} } };
  const gmap = new Map();
  for (const k of ['s', 'e', 'c']) {
    generic.domains[''][k] = (index.generic[k] || []).map((id) => {
      if (!gmap.has(id)) {
        gmap.set(id, generic.entries.length);
        generic.entries.push(index.entries[id]);
      }
      return gmap.get(id);
    });
  }
  if (index.generic.xs) generic.domains[''].xs = index.generic.xs;
  if (index.generic.xe) generic.domains[''].xe = index.generic.xe;
  return { generic, shards, count };
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

/**
 * Resolves the rules that apply to `hostname` from one or more
 * {entries, domains} parts (a full index, or generic + shards).
 * Mirrored in extension/content.js; keep them in sync.
 */
export function lookupParts(parts, hostname) {
  const keys = candidateKeys(hostname);
  const out = { s: [], e: [], c: [] };
  const xs = new Set();
  const xe = new Set();
  const seen = new Set();
  for (const part of parts) {
    const take = (bucket) => {
      if (!bucket) return;
      for (const k of ['s', 'e', 'c']) {
        for (const id of bucket[k] || []) {
          const entry = part.entries[id];
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

export function lookupWebRules(index, hostname) {
  return lookupParts([index], hostname);
}
