// Packs compiled rules into Safari content-blocker extensions ("slots").
//
// Safari caps every content blocker at 150,000 rules, and rules in one
// extension cannot see rules in another: an exception only cancels blocks in
// its own list. So we replicate exceptions into every slot that holds rules
// they could cancel, and spill block rules into slots with spare room.

import { SECTION_ORDER, isExceptionSection, CATEGORIES } from './compile.js';

export const SAFARI_RULE_LIMIT = 150000;

export const DEFAULT_SLOTS = [
  { id: 'ads', categories: ['ads'] },
  { id: 'privacy', categories: ['privacy', 'security'] },
  { id: 'annoyances', categories: ['annoyances', 'social'] },
  { id: 'extra', categories: ['custom'] },
];

const COSMETIC_EXCEPTIONS = new Set(['specifichideExceptions', 'generichideExceptions', 'elemhideExceptions']);
const NETWORK_EXCEPTIONS = new Set(['networkExceptions', 'importantExceptions']);

/**
 * @param {object} compiled - output of compile()
 * @param {object} [options]
 * @param {Array} [options.slots]
 * @param {number} [options.limit] - per-slot cap (default leaves room for the allowlist)
 * @returns {{ slots: Record<string, object[]>, report: object }}
 */
export function distribute(compiled, options = {}) {
  const slots = options.slots || DEFAULT_SLOTS;
  const limit = options.limit || SAFARI_RULE_LIMIT - 2000;

  // Gather every category's rules per section; `shared` goes everywhere.
  const blockSections = SECTION_ORDER.filter((s) => !isExceptionSection(s));
  const exceptionsBySection = {};
  for (const s of SECTION_ORDER) if (isExceptionSection(s)) exceptionsBySection[s] = [];

  const slotBlocks = {};
  for (const slot of slots) {
    slotBlocks[slot.id] = {};
    for (const s of blockSections) slotBlocks[slot.id][s] = [];
  }

  const catToSlot = {};
  for (const slot of slots) for (const c of slot.categories) catToSlot[c] = slot.id;
  const fallbackSlot = slots[slots.length - 1].id;

  for (const c of CATEGORIES) {
    const bucket = compiled.categories[c];
    if (!bucket) continue;
    const target = catToSlot[c] || fallbackSlot;
    for (const s of SECTION_ORDER) {
      if (isExceptionSection(s)) exceptionsBySection[s].push(...bucket[s]);
      else slotBlocks[target][s].push(...bucket[s]);
    }
  }
  const shared = compiled.shared || {};
  for (const s of SECTION_ORDER) {
    const rules = shared[s] || [];
    if (isExceptionSection(s)) exceptionsBySection[s].push(...rules);
    else for (const slot of slots) slotBlocks[slot.id][s].push(...rules);
  }

  const dedupe = (rules) => {
    const seen = new Set();
    return rules.filter((r) => {
      const k = JSON.stringify(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  for (const s of Object.keys(exceptionsBySection)) exceptionsBySection[s] = dedupe(exceptionsBySection[s]);

  const countBlocks = (id) => blockSections.reduce((n, s) => n + slotBlocks[id][s].length, 0);
  const hasCosmetic = (id) => slotBlocks[id].specificHide.length + slotBlocks[id].genericHide.length > 0;
  const hasNetwork = (id) => slotBlocks[id].network.length + slotBlocks[id].important.length > 0;
  const exceptionCost = (id) => {
    let n = exceptionsBySection.documentExceptions.length;
    if (hasCosmetic(id)) for (const s of COSMETIC_EXCEPTIONS) n += exceptionsBySection[s].length;
    if (hasNetwork(id)) for (const s of NETWORK_EXCEPTIONS) n += exceptionsBySection[s].length;
    return n;
  };

  // Spill overflow (network first, they are the cheapest to move) into the
  // slot with the most room. Spilled rules carry their exceptions with them
  // because exceptions are replicated per slot anyway.
  const dropped = { count: 0 };
  for (const slot of slots) {
    let over = countBlocks(slot.id) + exceptionCost(slot.id) - limit;
    for (const section of ['network', 'genericHide', 'specificHide']) {
      while (over > 0 && slotBlocks[slot.id][section].length) {
        const target = slots
          .filter((s) => s.id !== slot.id)
          .map((s) => {
            const extra = section === 'network' && !hasNetwork(s.id)
              ? exceptionsBySection.networkExceptions.length + exceptionsBySection.importantExceptions.length
              : section !== 'network' && !hasCosmetic(s.id)
                ? exceptionsBySection.specifichideExceptions.length + exceptionsBySection.generichideExceptions.length + exceptionsBySection.elemhideExceptions.length
                : 0;
            return { id: s.id, room: limit - countBlocks(s.id) - exceptionCost(s.id) - extra };
          })
          .sort((a, b) => b.room - a.room)[0];
        const n = Math.min(over, slotBlocks[slot.id][section].length, target ? Math.max(0, target.room) : 0);
        if (n <= 0) break;
        const moved = slotBlocks[slot.id][section].splice(slotBlocks[slot.id][section].length - n, n);
        slotBlocks[target.id][section].push(...moved);
        over -= n;
      }
    }
    if (over > 0) {
      // Out of room everywhere: drop from the tail of the generic network
      // rules (lists put their most important rules first).
      const n = Math.min(over, slotBlocks[slot.id].network.length);
      slotBlocks[slot.id].network.splice(slotBlocks[slot.id].network.length - n, n);
      dropped.count += n;
    }
  }

  const out = {};
  const report = { slots: {}, dropped: dropped.count, limit };
  for (const slot of slots) {
    const rules = [];
    const counts = {};
    for (const s of SECTION_ORDER) {
      let part;
      if (!isExceptionSection(s)) part = slotBlocks[slot.id][s];
      else if (s === 'documentExceptions') part = exceptionsBySection[s];
      else if (COSMETIC_EXCEPTIONS.has(s)) part = hasCosmetic(slot.id) ? exceptionsBySection[s] : [];
      else part = hasNetwork(slot.id) ? exceptionsBySection[s] : [];
      counts[s] = part.length;
      rules.push(...part);
    }
    out[slot.id] = rules;
    report.slots[slot.id] = { total: rules.length, sections: counts };
  }
  return { slots: out, report };
}

/** Rules that turn Bastion off on the given sites. Appended last in every slot. */
export function allowlistRules(domains) {
  const clean = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))].sort();
  if (clean.length === 0) return [];
  return [{ trigger: { 'url-filter': '.*', 'if-domain': clean.map((d) => '*' + d) }, action: { type: 'ignore-previous-rules' } }];
}
