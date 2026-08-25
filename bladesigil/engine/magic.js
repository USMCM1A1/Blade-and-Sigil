// Magic v2 (design doc v3): spell levels 1-5, the spell-point formula, spell
// cost, and WHO KNOWS WHAT. All content lives in user-owned data/spells.json;
// this module only answers rules questions.
//
// The doc's rules implemented here:
// - Max castable spell level by character level: 1-3→1, 4-7→2, 8-11→3,
//   12-15→4, 16-20→5.
// - Spell points: base + (level × multiplier × 3), from the class's
//   "spell_points": {"base": N, "multiplier": M} in classes.json (the doc's
//   Magic System Overview formula — the designer's call, 2026-08-24, over
//   the older +1/level class tables; legacy arrays still work).
// - Spell cost: spell level × 2 + 1 (3/5/7/9/11). Not stored in spells.json —
//   computed, so the designer can never desync a cost from a level.
//
// KNOWING SPELLS (the lane model — proposals where the doc is silent):
// - Before any fork (and always, for Priests and Spell Blades): a caster
//   commands every non-rare class spell of a castable level.
// - Wizard lane: a SPELLBOOK (ch.spellbook). It opens holding every non-rare
//   wizard spell of unlocked levels; each new spell level adds its pages
//   automatically; scrolls copy in anything else (including rare spells).
//   Only PREPARED spells (ch.prepared, re-picked freely at each rest —
//   Prepared Mind) are castable; slots = slots_base + max spell level.
// - Sorcerer lane: a fixed known list (ch.knownSpells) — picks known_per_level
//   spells per spell level, chosen by the player as the levels unlock. No
//   scrolls, no swapping. Overchannel: every cast costs 1 less (floor 1).
// - "rare": true on a spell = scroll-only lore: nobody learns it from
//   training, only a Wizard-lane spellbook can copy it in.

import { laneOf, passiveOf } from './progression.js';
import { DataError } from './loader.js';

// Friendly boot-time validation for spells.json (and the scrolls that
// point into it) — file, what's wrong, and the valid options.
export function validateMagic(data) {
  const classIds = Object.keys(data.classes.classes);
  for (const [id, s] of Object.entries(data.spells.spells)) {
    const where = `data/spells.json ("${id}")`;
    if (typeof s.level !== 'number' || s.level < 1 || s.level > 5) {
      throw new DataError(where, `"level" must be a spell level from 1 to 5.`);
    }
    if ('cost' in s) {
      throw new DataError(where, `Remove "cost" — costs are computed from the level (level × 2 + 1 = ${s.level * 2 + 1} SP here), so they can never drift apart.`);
    }
    if (!Array.isArray(s.classes) || !s.classes.length || s.classes.some(c => !classIds.includes(c))) {
      throw new DataError(where, `"classes" must list who casts it. Valid: ${classIds.join(', ')}`);
    }
    if (!['damage', 'heal', 'buff', 'afflict'].includes(s.type)) {
      throw new DataError(where, `Unknown type "${s.type}". Use damage, heal, buff, or afflict.`);
    }
    if ((s.type === 'damage' || s.type === 'heal') && !s.dice) {
      throw new DataError(where, `A ${s.type} spell needs "dice" (e.g. "${s.level * 2}d6").`);
    }
    if (s.type === 'afflict' && !s.condition) {
      throw new DataError(where, `An afflict spell needs a "condition": {"id", "rounds"}.`);
    }
    if (s.condition && !data.conditions.conditions[s.condition.id]) {
      throw new DataError(where, `Condition "${s.condition.id}" isn't in conditions.json. Valid: ${Object.keys(data.conditions.conditions).join(', ')}`);
    }
  }
  for (const [id, it] of Object.entries(data.items.items)) {
    if (it.type === 'scroll' && !data.spells.spells[it.spell]) {
      throw new DataError(`data/items.json ("${id}")`, `This scroll names a spell "${it.spell}" that isn't in spells.json. Valid: ${Object.keys(data.spells.spells).join(', ')}`);
    }
  }
}

// Character level → highest castable spell level (doc table).
export function maxSpellLevel(charLevel) {
  if (charLevel >= 16) return 5;
  if (charLevel >= 12) return 4;
  if (charLevel >= 8) return 3;
  if (charLevel >= 4) return 2;
  return 1;
}

// The doc's SP formula — or a legacy per-level array, or nothing (0 SP).
export function spellPointsFor(cls, level) {
  const sp = cls.spell_points;
  if (Array.isArray(sp)) return sp[level - 1] ?? 0;
  if (sp && typeof sp === 'object') {
    return (sp.base ?? 0) + Math.floor(level * (sp.multiplier ?? 0) * 3);
  }
  return 0;
}

// Spell cost = level × 2 + 1; the Sorcerer's Overchannel shaves 1 (floor 1).
export function spellCost(data, ch, spell) {
  let cost = spell.level * 2 + 1;
  const p = passiveOf(data, ch);
  if (p?.id === 'overchannel') cost = Math.max(1, cost - (p.discount ?? 1));
  return cost;
}

// Every spell this class may ever touch, as [{id, ...def}] — lowest spell
// level first (the menu order), file order within a level.
export function classSpellList(data, clsId) {
  return Object.entries(data.spells.spells)
    .filter(([, s]) => s.classes.includes(clsId))
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => a.level - b.level);
}

function classIdOf(data, ch) {
  const classes = data.classes.classes;
  return Object.keys(classes).find(k => classes[k] === ch.cls);
}

// Which lane-flavored spell model this hero runs (null = the open model).
export function magicModel(data, ch) {
  const lane = laneOf(data, ch);
  const p = lane?.passive;
  if (p?.id === 'prepared_mind') return 'spellbook';
  if (p?.id === 'overchannel') return 'known';
  return null;
}

// Prepared Mind: how many spells fit in today's preparation.
export function preparedSlots(data, ch) {
  const p = passiveOf(data, ch);
  return (p?.slots_base ?? 3) + maxSpellLevel(ch.level);
}

// Sorcerer: how many spells per spell level the lane grants.
export function knownPerLevel(data, ch) {
  return passiveOf(data, ch)?.known_per_level ?? 2;
}

// The spells this hero KNOWS (before any prepared filter): the designer-
// facing list for the character sheet.
export function knownSpells(data, ch) {
  const clsId = classIdOf(data, ch);
  const tier = maxSpellLevel(ch.level);
  const model = magicModel(data, ch);
  const all = classSpellList(data, clsId);
  if (model === 'spellbook') {
    return all.filter(s => (ch.spellbook ?? []).includes(s.id));
  }
  if (model === 'known') {
    return all.filter(s => (ch.knownSpells ?? []).includes(s.id));
  }
  return all.filter(s => !s.rare && s.level <= tier);
}

// The spells this hero can CAST right now (the battle menu's list).
// The Wizard lane casts only what is prepared — unless the Archmage's
// once-per-rest reach into the whole book is open (battle.js handles that).
export function castableSpells(data, ch) {
  const model = magicModel(data, ch);
  const tier = maxSpellLevel(ch.level);
  const known = knownSpells(data, ch).filter(s => s.level <= tier);
  if (model === 'spellbook') return known.filter(s => (ch.prepared ?? []).includes(s.id));
  return known;
}

// Wizard lane: everything in the book that is NOT prepared today (the
// Archmage's once-per-rest menu, and the sheet's greyed rows).
export function unpreparedSpells(data, ch) {
  if (magicModel(data, ch) !== 'spellbook') return [];
  return knownSpells(data, ch).filter(s => !(ch.prepared ?? []).includes(s.id));
}

// Opening the spellbook at the fork — and refilling it as levels unlock:
// every non-rare class spell of every unlocked level belongs in the book.
// Returns the ids newly added (for the log).
export function refreshSpellbook(data, ch) {
  if (magicModel(data, ch) !== 'spellbook') return [];
  const clsId = classIdOf(data, ch);
  const tier = maxSpellLevel(ch.level);
  ch.spellbook ??= [];
  const added = [];
  for (const s of classSpellList(data, clsId)) {
    if (!s.rare && s.level <= tier && !ch.spellbook.includes(s.id)) {
      ch.spellbook.push(s.id);
      added.push(s.id);
    }
  }
  ch.prepared ??= [];
  // Preparation must stay legal: only book spells, only so many slots.
  ch.prepared = ch.prepared.filter(id => ch.spellbook.includes(id));
  autoPrepare(data, ch);
  return added;
}

// Fill empty preparation slots (lowest level first — the bread and butter);
// never unprepares anything the player chose.
export function autoPrepare(data, ch) {
  const slots = preparedSlots(data, ch);
  ch.prepared = (ch.prepared ?? []).slice(0, slots);
  const book = knownSpells(data, ch)
    .filter(s => s.level <= maxSpellLevel(ch.level)) // a scroll may outpace the caster
    .sort((a, b) => a.level - b.level);
  for (const s of book) {
    if (ch.prepared.length >= slots) break;
    if (!ch.prepared.includes(s.id)) ch.prepared.push(s.id);
  }
}

// Sorcerer: the picks this hero is still owed, oldest spell level first —
// [{level, remaining, options: [spell ids not yet known at that level]}].
export function spellPicksOwed(data, ch) {
  if (magicModel(data, ch) !== 'known') return [];
  const clsId = classIdOf(data, ch);
  const per = knownPerLevel(data, ch);
  const known = ch.knownSpells ?? [];
  const out = [];
  for (let lvl = 1; lvl <= maxSpellLevel(ch.level); lvl++) {
    const pool = classSpellList(data, clsId).filter(s => !s.rare && s.level === lvl);
    const have = pool.filter(s => known.includes(s.id)).length;
    const remaining = Math.min(per, pool.length) - have;
    const options = pool.filter(s => !known.includes(s.id));
    if (remaining > 0 && options.length) out.push({ level: lvl, remaining, options });
  }
  return out;
}
