// Magic v3 (design doc v3 + the 2026-08-28 designer session): spell levels
// 1-5, the spell-point formula, spell cost, WHO KNOWS WHAT, caster-level
// scaling, and scrolls. All content lives in user-owned data/spells.json,
// classes.json, progression.json; this module only answers rules questions.
//
// The rules implemented here:
// - Max castable spell level by character level: 1-3→1, 4-7→2, 8-11→3,
//   12-15→4, 16-20→5.
// - Spell points: base + (level × multiplier × 3), from the class's
//   "spell_points": {"base": N, "multiplier": M} in classes.json (legacy
//   arrays still work).
// - Spell cost: spell level × 2 + 1 (3/5/7/9/11). Not stored in spells.json —
//   computed, so the designer can never desync a cost from a level.
//
// KNOWING SPELLS — three models, decided by class block + lane passive:
// - 'spellbook': any class carrying a "spellbook" block in classes.json (the
//   Wizard, FROM LEVEL 1). The book opens with `starting_spells`; it grows by
//   STUDY (a free pick at each of `study_levels`) and by copying scrolls in.
//   Only PREPARED spells (ch.prepared, re-picked freely at each rest) are
//   castable; slots = slots_base + max spell level + extra_slot_levels
//   reached (+ the Spellbook lane's prepared_mind.slots_bonus).
// - 'known': the lane passive `overchannel` (the Raw Gift / Sorcerer). At the
//   fork the book is set aside (ch.formerBook); the hero picks
//   known_per_level spells per unlocked spell level (from the catalog OR the
//   former book), plus one wild pick at each `bonus_pick_levels`. No scrolls,
//   no swapping. Overchannel: every cast costs 1 less (floor 1).
// - 'open' (null): everyone else (the Priest) — every non-rare class spell of
//   castable level, plus rare prayers granted as REVELATIONS at the class's
//   `revelation_levels` ({spellLevel: charLevel}).
// - "rare": true = scroll-only lore for arcane casters (a Wizard's book copies
//   it in; a Sorcerer may pick it if it was in the former book); for the
//   Priest it is a revelation.
// SCROLLS: a spell with "scroll": true (or {value, tier}) makes the engine
// synthesize the item `scroll_<id>` at boot (explicit items.json entries win).
// Any hero whose class says "caster": "arcane" may READ one in battle (0 SP,
// consumed) up to max spell level + 1; only a spellbook may copy one.
// SCALING: an optional "scale" rule grows a spell as the caster outlevels
// its unlock level — steps = min(max, floor((level − unlock) / per_levels)).

import { laneOf, passiveOf } from './progression.js';
import { DataError } from './loader.js';
import { ELEMENTS, FAMILIES, ABILITIES, isDice, conditionIds, classIds as classIdList } from './validate.js';
import { SPELL_TYPES } from './spell-effects.js';

export { FAMILIES }; // older importers still take it from here
const UNLOCK = [0, 1, 4, 8, 12, 16]; // spell level → character level it opens at

// ---- Scroll synthesis (runs BEFORE validation, from main.js) ----
// A spell flagged "scroll" gets an item `scroll_<id>` unless items.json
// already defines one for it. Value comes from items.json's ladder
// (scroll_values by spell level × rare_multiplier); tier = spell level.
export function deriveScrollItems(data) {
  const items = data.items.items;
  const ladder = data.items.scroll_values ?? [100, 250, 500, 900, 1500];
  const rareMult = data.items.rare_multiplier ?? 1.5;
  const covered = new Set(Object.values(items).filter(d => d.type === 'scroll').map(d => d.spell));
  for (const [id, s] of Object.entries(data.spells.spells)) {
    if (!s.scroll || covered.has(id)) continue;
    const itemId = `scroll_${id}`;
    if (items[itemId] && items[itemId].type !== 'scroll') {
      throw new DataError('data/items.json', `"${itemId}" is already an item that is not a scroll — rename it, or drop "scroll" from the spell "${id}".`);
    }
    const o = typeof s.scroll === 'object' ? s.scroll : {};
    const base = ladder[Math.min(ladder.length, s.level) - 1] ?? 100;
    items[itemId] = {
      name: `Scroll of ${s.name}`,
      type: 'scroll',
      spell: id,
      value: o.value ?? Math.round(base * (s.rare ? rareMult : 1)),
      tier: o.tier ?? s.level,
      description: spellSchool(s) === 'divine' ? `${s.name} as a prayer-scroll — voiced once by a divine caster; no book can copy it`
        : s.rare ? `${s.name}, in a hand no living school teaches — read once, or copy it into a spellbook` : `${s.name}, transcribed — read once, or copy it into a spellbook`,
      synthesized: true,
    };
    covered.add(id);
  }
}

// Friendly boot-time validation for spells.json, classes.json's magic
// blocks, conditions.json effects, and the scrolls that point into spells —
// file, what's wrong, and the valid options.
export function validateMagic(data) {
  const classIds = classIdList(data);
  const condIds = conditionIds(data);
  const spells = data.spells.spells;

  for (const [id, c] of Object.entries(data.conditions.conditions)) {
    if (id.startsWith('_')) continue;
    const where = `data/conditions.json ("${id}")`;
    if (!['damage', 'skip', 'stat', 'slow'].includes(c.effect)) {
      throw new DataError(where, `Unknown effect "${c.effect}". Use damage (lose dice HP each tick), skip (lose the turn), stat (hit/dmg/ac/saves modifiers while it lasts), or slow (acts on even rounds only).`);
    }
    if (c.effect === 'damage' && !isDice(c.dice)) throw new DataError(where, `A damage condition needs "dice" (e.g. "1d4").`);
    if (c.effect === 'stat' && !['hit', 'dmg', 'ac', 'saves'].some(k => typeof c[k] === 'number')) {
      throw new DataError(where, `A stat condition needs at least one of "hit", "dmg", "ac", "saves" (negative numbers weaken, e.g. "hit": -2; "save" alone names the resisting ability).`);
    }
    if (c.save && !ABILITIES.includes(c.save)) throw new DataError(where, `"save" must be an ability: ${ABILITIES.join(', ')}.`);
  }

  for (const [id, s] of Object.entries(spells)) {
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
    if (!SPELL_TYPES.includes(s.type)) {
      throw new DataError(where, `Unknown type "${s.type}". Use damage, heal, buff, afflict, cure, or raise.`);
    }
    if (s.stat && !ABILITIES.includes(s.stat)) throw new DataError(where, `"stat" must be an ability: ${ABILITIES.join(', ')}.`);
    if (s.school && !['arcane', 'divine'].includes(s.school)) throw new DataError(where, `"school" must be arcane or divine.`);
    if ((s.type === 'damage' || s.type === 'heal') && !isDice(s.dice)) {
      throw new DataError(where, `A ${s.type} spell needs "dice" (e.g. "${s.level * 2}d6").`);
    }
    if (s.type === 'afflict' && !s.condition) {
      throw new DataError(where, `An afflict spell needs a "condition": {"id", "rounds"}.`);
    }
    if (s.condition && !condIds.includes(s.condition.id)) {
      throw new DataError(where, `Condition "${s.condition.id}" isn't in conditions.json. Valid: ${condIds.join(', ')}`);
    }
    if (s.condition && (typeof s.condition.rounds !== 'number' || s.condition.rounds < 1)) {
      throw new DataError(where, `"condition" needs "rounds" (1 or more).`);
    }
    if (s.area !== undefined && s.area !== 'all' && (typeof s.area !== 'number' || s.area < 0 || s.area > 3)) {
      throw new DataError(where, `"area" must be 0 (one target), 1 (3×3), 2 (5×5), 3 (7×7), or "all" (every foe on the field).`);
    }
    if (s.save && !ABILITIES.includes(s.save)) throw new DataError(where, `"save" must be an ability: ${ABILITIES.join(', ')}.`);
    if (s.targets && !['self', 'ally', 'allies'].includes(s.targets)) {
      throw new DataError(where, `"targets" must be self, ally (aim at one hero), or allies (the whole living party).`);
    }
    if (s.type === 'cure') {
      const list = s.cures === 'all' ? [] : s.cures;
      if (!Array.isArray(list) && s.cures !== 'all') throw new DataError(where, `A cure spell needs "cures": ["poison", ...] or "all".`);
      for (const c of list) if (!condIds.includes(c)) throw new DataError(where, `cures "${c}" isn't in conditions.json. Valid: ${condIds.join(', ')}`);
    } else if (s.cures) {
      const list = s.cures === 'all' ? [] : s.cures;
      if (!Array.isArray(list) && s.cures !== 'all') throw new DataError(where, `"cures" must be a list of condition ids or "all".`);
      for (const c of list) if (!condIds.includes(c)) throw new DataError(where, `cures "${c}" isn't in conditions.json. Valid: ${condIds.join(', ')}`);
    }
    if (s.type === 'raise' && s.hp !== undefined && (typeof s.hp !== 'number' || s.hp <= 0 || s.hp > 1)) {
      throw new DataError(where, `A raise spell's "hp" is the fraction of max HP the fallen rise with (0.5 = half).`);
    }
    if (s.lane) {
      const lanes = (data.progression?.classes ?? {});
      const ok = s.classes.some(c => lanes[c]?.lanes?.some(l => l.id === s.lane));
      if (!ok) throw new DataError(where, `"lane": "${s.lane}" is not a lane of ${s.classes.join('/')} in progression.json. Valid: ${s.classes.flatMap(c => (lanes[c]?.lanes ?? []).map(l => l.id)).join(', ') || '(that class has no lanes)'}`);
    }
    if (s.type === 'buff') {
      for (const k of ['hit', 'dmg', 'ac', 'saves', 'attacks', 'reduce']) {
        if (s[k] !== undefined && typeof s[k] !== 'number') throw new DataError(where, `Buff field "${k}" must be a number.`);
      }
      if (s.enchant !== undefined && s.enchant !== true) throw new DataError(where, `"enchant" is simply true — while the buff holds, the target's weapon counts as ENCHANTED and bites magic_to_hit foes.`);
      for (const k of ['reflect', 'lifesteal']) {
        if (s[k] !== undefined && (typeof s[k] !== 'number' || s[k] <= 0 || s[k] > 1)) throw new DataError(where, `"${k}" is a fraction (0.5 = half)${k === 'reflect' ? ' of melee damage taken thrown back at the attacker' : ' of weapon damage dealt that heals you'}.`);
      }
      if (s.immune_conditions !== undefined && s.immune_conditions !== true && !Array.isArray(s.immune_conditions)) {
        throw new DataError(where, `"immune_conditions" is true (no affliction lands) or a list of condition ids.`);
      }
      for (const c of Array.isArray(s.immune_conditions) ? s.immune_conditions : []) {
        if (!condIds.includes(c)) throw new DataError(where, `immune_conditions "${c}" isn't in conditions.json. Valid: ${condIds.join(', ')}`);
      }
      if (s.absorb !== undefined && !isDice(s.absorb)) throw new DataError(where, `"absorb" must be dice (e.g. "1d8") — a shield that drinks that much damage.`);
      if (s.bonus_damage && (!isDice(s.bonus_damage.dice) || !ELEMENTS.includes(s.bonus_damage.element))) {
        throw new DataError(where, `"bonus_damage" needs {dice, element}: dice like "1d6", element from: ${ELEMENTS.join(', ')}.`);
      }
      if (s.resist !== undefined) {
        const list = s.resist === 'all' ? [] : s.resist;
        if (!Array.isArray(list) && s.resist !== 'all') throw new DataError(where, `"resist" must be a list of elements (${ELEMENTS.join(', ')}) or "all".`);
        for (const e of list) if (!ELEMENTS.includes(e)) throw new DataError(where, `resist "${e}" — valid elements: ${ELEMENTS.join(', ')}.`);
      }
      if (s.rounds !== undefined && (typeof s.rounds !== 'number' || s.rounds < 1)) throw new DataError(where, `"rounds" must be 1 or more (leave it out for a buff that lasts the whole battle).`);
      if (s.stance !== undefined) {
        if (!Number.isInteger(s.stance) || s.stance < 1) throw new DataError(where, `"stance" is the flat SP cost of a Stance (1 or more) — a buff that lasts until the next full rest.`);
        if (s.rounds !== undefined) throw new DataError(where, `A Stance lasts until the next full rest — drop "rounds".`);
        if (s.once_per_rest) throw new DataError(where, `A Stance already lasts until the next rest — "once_per_rest" makes no sense on it.`);
        if (s.absorb !== undefined || s.hidden) throw new DataError(where, `A Stance carries lasting modifiers (hit/dmg/ac/saves/attacks/resist/immune_conditions/reduce/halve/reflect/lifesteal/auto_hit/bonus_damage) — not absorb or hidden, which are battle things.`);
      }
    }
    if (s.stance !== undefined && s.type !== 'buff') throw new DataError(where, `"stance" belongs on a buff spell only.`);
    if (s.drain !== undefined && (typeof s.drain !== 'number' || s.drain <= 0 || s.drain > 1)) {
      throw new DataError(where, `"drain" is the fraction of damage dealt that heals the caster (0.5 = half).`);
    }
    if (s.double_vs && !FAMILIES.includes(s.double_vs)) throw new DataError(where, `"double_vs" must be a monster family: ${FAMILIES.join(', ')}.`);
    for (const f of s.only_family ?? []) if (!FAMILIES.includes(f)) throw new DataError(where, `only_family "${f}" — valid families: ${FAMILIES.join(', ')}.`);
    if (s.restore_sp !== undefined || s.pool === 'sp') {
      throw new DataError(where, `Spell-point-restoring spells are not allowed — they undercut the spell-point economy (designer's call). Mana potions are the refill.`);
    }
    if (s.scale) {
      const sc = s.scale;
      if (typeof sc.per_levels !== 'number' || sc.per_levels < 1) throw new DataError(where, `"scale" needs "per_levels" (e.g. 2 = one step every 2 caster levels past the spell's unlock).`);
      if (sc.max !== undefined && (typeof sc.max !== 'number' || sc.max < 1)) throw new DataError(where, `scale "max" is the most steps it can grow (1 or more).`);
      if (sc.dice !== undefined && !isDice(sc.dice)) throw new DataError(where, `scale "dice" must be dice (e.g. "1d6") added per step.`);
      if (!['dice', 'flat', 'rounds', 'extra_targets', 'ac', 'area'].some(k => sc[k] !== undefined)) {
        throw new DataError(where, `"scale" needs something to grow: dice, flat, rounds, extra_targets, ac, or area (per step).`);
      }
    }
    if (s.fx) {
      const kinds = ['bolt', 'beam', 'lightning', 'burst', 'sparkle', 'wisp'];
      if (s.fx.kind && !kinds.includes(s.fx.kind)) {
        throw new DataError(where, `fx "kind" must be one of: ${kinds.join(', ')}.`);
      }
      if (s.fx.burst && !['fire', 'frost', 'holy'].includes(s.fx.burst)) {
        throw new DataError(where, `fx "burst" must be fire, frost, or holy (the sprites in assets/fx/).`);
      }
      if (s.fx.sound && !['fire', 'frost', 'lightning', 'light', 'arcane', 'heal', 'buff', 'sonic', 'cloud', 'web'].includes(s.fx.sound)) {
        throw new DataError(where, `fx "sound" must be fire, frost, lightning, light, arcane, heal, buff, sonic, cloud, or web (spell_* ids in data/sounds.json).`);
      }
    }
  }

  // Classes' magic blocks.
  for (const [cid, cls] of Object.entries(data.classes.classes)) {
    const where = `data/classes.json ("${cid}")`;
    if (cls.caster && !['arcane', 'divine'].includes(cls.caster)) throw new DataError(where, `"caster" must be arcane or divine.`);
    if (cls.magic !== undefined && cls.magic !== 'lane') throw new DataError(where, `"magic" must be "lane" (the fixed list decided by the level-5 lane) — or leave it out.`);
    if (cls.magic === 'lane' && !data.progression?.classes?.[cid]) throw new DataError(where, `"magic": "lane" needs a progression.json entry for ${cid} — the lanes decide the spell list.`);
    for (const [lvl, at] of Object.entries(cls.spell_unlocks ?? {})) {
      if (!['1', '2', '3', '4', '5'].includes(lvl) || typeof at !== 'number' || at < 1 || at > 20) throw new DataError(where, `spell_unlocks maps a spell level ("1"-"5") to the character level (1-20) it opens at — levels not listed never open.`);
    }
    if (cls.dual_wield && typeof cls.dual_wield.penalty !== 'number') throw new DataError(where, `dual_wield needs {"penalty": N} — the off-hand's to-hit penalty.`);
    if (cls.favored_enemy) {
      const fe = cls.favored_enemy;
      if (!Array.isArray(fe.levels) || fe.levels.some(l => typeof l !== 'number' || l < 1 || l > 20)) throw new DataError(where, `favored_enemy "levels" lists the character levels (1-20) that grant a pick.`);
      if (fe.cap !== undefined && (typeof fe.cap !== 'number' || fe.cap < 1)) throw new DataError(where, `favored_enemy "cap" is the highest bonus one family can reach.`);
    }
    if (cls.starting_spells !== undefined) {
      if (cls.magic !== 'lane') throw new DataError(where, `"starting_spells" at the class level is for "magic": "lane" classes (the verses known before the fork) — a spellbook class puts them inside its spellbook block.`);
      if (!Array.isArray(cls.starting_spells) || !cls.starting_spells.length) throw new DataError(where, `"starting_spells" is a list of spell ids known before the fork.`);
      for (const id of cls.starting_spells) {
        if (!spells[id]) throw new DataError(where, `starting_spells names "${id}", which isn't in spells.json.`);
        if (!spells[id].classes.includes(cid)) throw new DataError(where, `starting_spells names "${id}", which a ${cls.name} cannot cast (its "classes" list lacks ${cid}).`);
      }
    }
    if (cls.spell_cost && (typeof cls.spell_cost.per_level !== 'number' || typeof cls.spell_cost.base !== 'number')) {
      throw new DataError(where, `"spell_cost" needs {"per_level": N, "base": N} — cost = spell level × per_level + base.`);
    }
    if (cls.creation_pick) {
      const cp = cls.creation_pick;
      if (!Array.isArray(cp.options) || cp.options.length < 2) throw new DataError(where, `creation_pick needs an "options" list of at least two gifts.`);
      for (const o of cp.options) {
        if (!o.id || !o.name) throw new DataError(where, `Every creation_pick option needs an "id" and a "name".`);
        if (o.spell && !spells[o.spell]) throw new DataError(where, `creation_pick "${o.name}" names spell "${o.spell}", which isn't in spells.json.`);
        if (o.spell && !spells[o.spell].classes.includes(cid)) throw new DataError(where, `creation_pick "${o.name}" names "${o.spell}", which a ${cls.name} cannot cast.`);
        if (o.detect !== undefined && typeof o.detect !== 'number') throw new DataError(where, `creation_pick "${o.name}": "detect" is a number of percent.`);
        if (o.ac_vs_element !== undefined && typeof o.ac_vs_element !== 'number') throw new DataError(where, `creation_pick "${o.name}": "ac_vs_element" is the AC bonus against one element (chosen at creation).`);
        for (const k of ['free_swaps', 'quiver_bonus']) if (o[k] !== undefined && typeof o[k] !== 'number') throw new DataError(where, `creation_pick "${o.name}": "${k}" is a number.`);
      }
    }
    const sb = cls.spellbook;
    if (sb) {
      for (const id of sb.starting_spells ?? []) {
        if (!spells[id]) throw new DataError(where, `spellbook.starting_spells names "${id}", which isn't in spells.json.`);
        if (!spells[id].classes.includes(cid)) throw new DataError(where, `spellbook.starting_spells names "${id}", which a ${cls.name} cannot cast (its "classes" list lacks ${cid}).`);
      }
      for (const key of ['study_levels', 'extra_slot_levels']) {
        for (const l of sb[key] ?? []) {
          if (typeof l !== 'number' || l < 1 || l > 20) throw new DataError(where, `spellbook.${key} must list character levels 1-20.`);
        }
      }
      if (sb.slots_base !== undefined && (typeof sb.slots_base !== 'number' || sb.slots_base < 0)) throw new DataError(where, `spellbook.slots_base must be a number (prepared slots before the spell-level bonus).`);
    }
    for (const [lvl, at] of Object.entries(cls.revelation_levels ?? {})) {
      if (!['1', '2', '3', '4', '5'].includes(lvl) || typeof at !== 'number' || at < 1 || at > 20) {
        throw new DataError(where, `revelation_levels maps a spell level ("1"-"5") to the character level (1-20) its rare spells are revealed at.`);
      }
    }
  }

  // Scrolls: point at real arcane spells; every rare arcane spell needs one.
  const seen = new Map();
  for (const [id, it] of Object.entries(data.items.items)) {
    if (it.type !== 'scroll') continue;
    const s = spells[it.spell];
    if (!s) throw new DataError(`data/items.json ("${id}")`, `This scroll names a spell "${it.spell}" that isn't in spells.json. Valid: ${Object.keys(spells).join(', ')}`);
    if (seen.has(it.spell)) throw new DataError(`data/items.json ("${id}")`, `Two scrolls for the same spell ("${seen.get(it.spell)}" and "${id}") — drops would double-weight it. Keep one.`);
    seen.set(it.spell, id);
    // Divine prayer-scrolls opened 2026-08-31 (the shop's Cure Light Wounds):
    // read by divine casters, never copied — only arcane words take ink.
  }
  for (const [id, s] of Object.entries(spells)) {
    if (s.rare && spellSchool(s) === 'arcane' && !seen.has(id)) {
      throw new DataError(`data/spells.json ("${id}")`, `A rare arcane spell is only ever found on a scroll — add "scroll": true to it (the engine makes the scroll item), or define "scroll_${id}" in items.json.`);
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

export function unlockLevel(spellLevel) { return UNLOCK[spellLevel] ?? 1; }

// A HERO's highest castable spell level: the universal table — or the
// class's own 'spell_unlocks' ({"1": 9, "2": 15}, the Ranger's quarter-
// caster ladder), which also caps the top level (no entry = never).
export function heroMaxSpellLevel(ch, level = ch.level) {
  const u = ch.cls.spell_unlocks;
  if (!u) return maxSpellLevel(level);
  let best = 0;
  for (const [lvl, at] of Object.entries(u)) if (level >= at) best = Math.max(best, Number(lvl));
  return best;
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

// Spell cost = level × 2 + 1 — or the class's own 'spell_cost' ladder
// ({per_level, base}: the half-casters pay level + 1); the Sorcerer's
// Overchannel shaves 1 (floor 1).
export function spellCost(data, ch, spell) {
  if (spell.stance) return spell.stance; // a Stance: flat, cheap, until the next full rest (v1.1)
  const f = ch.cls.spell_cost ?? {};
  let cost = spell.level * (f.per_level ?? 2) + (f.base ?? 1);
  const p = passiveOf(data, ch);
  if (p?.id === 'overchannel') cost = Math.max(1, cost - (p.discount ?? 1));
  return cost;
}

// arcane or divine — explicit "school", else from the casting stat.
export function spellSchool(s) { return s.school ?? (s.stat === 'wis' ? 'divine' : 'arcane'); }

// Every spell this class may ever touch, as [{id, ...def}] — lowest spell
// level first (the menu order), file order within a level.
export function classSpellList(data, clsId) {
  return Object.entries(data.spells.spells)
    .filter(([, s]) => s.classes.includes(clsId))
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => a.level - b.level);
}

export function classIdOf(data, ch) {
  const classes = data.classes.classes;
  return Object.keys(classes).find(k => classes[k] === ch.cls);
}

// Which knowledge model this hero runs: 'known' (the Raw Gift lane),
// 'spellbook' (a class with a spellbook block), 'lane' (the half-casters'
// fixed list, decided by the level-5 lane), or null (the open model).
export function magicModel(data, ch) {
  const p = passiveOf(data, ch)?.id;
  if (p === 'overchannel') return 'known';
  if (p === 'prepared_mind' || ch.cls.spellbook) return 'spellbook';
  if (ch.cls.magic === 'lane') return 'lane';
  return null;
}

// The 'lane' model (Spellblade, Stoneshaper): before the fork the hero
// knows ONLY the creation gift's spell (if the gift named one), else the
// class's 'starting_spells' (the Stoneshaper's Skin of Stone), else the
// class's level-1 spells of every lane; from the fork on, every spell
// tagged with the walked lane (untagged class spells belong to both). A
// gift verse the lane does not sing is swapped away at the fork (v1.1 —
// game.applyChoice exchanges an active Stance free). Returns [{id, ...def}].
export function laneSpells(data, ch) {
  const clsId = classIdOf(data, ch);
  const all = classSpellList(data, clsId);
  const gift = giftOf(ch)?.spell ?? null;
  if (!ch.lane) {
    if (gift) return all.filter(s => s.id === gift);
    if (ch.cls.starting_spells?.length) return all.filter(s => ch.cls.starting_spells.includes(s.id));
    return all.filter(s => s.level === 1 && heroMaxSpellLevel(ch) >= 1);
  }
  return all.filter(s => !s.lane || s.lane === ch.lane);
}

// The buff a spell lays on a hero (magic v3): every named part reaches the
// combat math through ch.timedBuffs. rounds null = the whole battle; a
// STANCE (v1.1) is flagged so it outlives the fight — until the next full
// rest. `extra` carries what only the cast knows: scaled ac, rounds, the
// absorb roll.
export function spellBuff(s, extra = {}) {
  return {
    name: s.name, spell: s.id ?? null, stance: !!s.stance,
    hit: s.hit ?? 0, dmg: s.dmg ?? 0, ac: extra.ac ?? s.ac ?? 0, saves: s.saves ?? 0, attacks: s.attacks ?? 0,
    rounds: s.stance ? null : (extra.rounds ?? (s.rounds || null)), absorb: extra.absorb ?? 0,
    bonus_damage: s.bonus_damage ?? null, resist: s.resist ?? null,
    immune_conditions: s.immune_conditions ?? false,
    reduce: s.reduce ?? 0, halve: !!s.halve, reflect: s.reflect ?? 0, lifesteal: s.lifesteal ?? 0, auto_hit: !!s.auto_hit, enchant: !!s.enchant,
    reveal: !!s.reveal,
  };
}

// The Stances a hero holds right now (buffs that outlast the battle).
export function activeStances(ch) { return (ch.timedBuffs ?? []).filter(b => b.stance); }

// The creation gift a hero carries (classes.json creation_pick option).
export function giftOf(ch) {
  const pick = ch.cls.creation_pick;
  if (!pick || !ch.gift) return null;
  return pick.options.find(o => o.id === ch.gift.id) ?? null;
}

// The lane spells that OPEN at exactly this character level (level-up card).
export function laneSpellsAt(data, ch, level) {
  if (magicModel(data, ch) !== 'lane') return [];
  const tierNow = heroMaxSpellLevel(ch, level), tierBefore = heroMaxSpellLevel(ch, level - 1);
  if (tierNow === tierBefore) return [];
  return laneSpells(data, ch).filter(s => s.level === tierNow);
}

// Prepared slots: class slots_base + max spell level + extra slots reached
// (+ the Spellbook lane's bonus). The old lane-side slots_base still counts
// if a designer left it there.
export function preparedSlots(data, ch) {
  const sb = ch.cls.spellbook ?? {};
  const p = passiveOf(data, ch);
  const base = p?.id === 'prepared_mind' && p.slots_base !== undefined ? p.slots_base : (sb.slots_base ?? 3);
  const extra = (sb.extra_slot_levels ?? []).filter(l => l <= ch.level).length;
  const bonus = p?.id === 'prepared_mind' ? (p.slots_bonus ?? 0) : 0;
  return base + maxSpellLevel(ch.level) + extra + bonus;
}

// Sorcerer: how many spells per spell level the lane grants.
export function knownPerLevel(data, ch) {
  return passiveOf(data, ch)?.known_per_level ?? 2;
}

// Open model: the rare spells revealed to this hero by level (the Priest's
// revelations) — [{id, ...def}].
export function revealedSpells(data, ch) {
  const rl = ch.cls.revelation_levels;
  if (!rl) return [];
  const clsId = classIdOf(data, ch);
  return classSpellList(data, clsId).filter(s => s.rare && rl[String(s.level)] !== undefined && ch.level >= rl[String(s.level)]);
}

// The spells this hero KNOWS (before any prepared filter): the designer-
// facing list for the character sheet.
export function knownSpells(data, ch) {
  const clsId = classIdOf(data, ch);
  const tier = heroMaxSpellLevel(ch);
  const model = magicModel(data, ch);
  const all = classSpellList(data, clsId);
  if (model === 'spellbook') {
    return all.filter(s => (ch.spellbook ?? []).includes(s.id));
  }
  if (model === 'known') {
    return all.filter(s => (ch.knownSpells ?? []).includes(s.id));
  }
  if (model === 'lane') return laneSpells(data, ch).filter(s => s.level <= tier);
  const revealed = new Set(revealedSpells(data, ch).map(s => s.id));
  return all.filter(s => (!s.rare && s.level <= tier) || revealed.has(s.id));
}

// The spells this hero can CAST right now (the battle menu's list).
export function castableSpells(data, ch) {
  const model = magicModel(data, ch);
  const tier = heroMaxSpellLevel(ch);
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

// Opening the book: seed the class's starting spells into an EMPTY book,
// then keep preparation legal (only book spells, only so many slots).
// The book never auto-fills a tier — pages come from study and scrolls.
// Returns the ids newly added (for the log).
export function refreshSpellbook(data, ch) {
  if (magicModel(data, ch) !== 'spellbook') return [];
  ch.spellbook ??= [];
  const added = [];
  if (!ch.spellbook.length) {
    for (const id of ch.cls.spellbook?.starting_spells ?? []) {
      if (!ch.spellbook.includes(id)) { ch.spellbook.push(id); added.push(id); }
    }
  }
  ch.prepared ??= [];
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

// ---- Study (the spellbook's free picks) ----
// How many study picks a hero of this level has been granted in total.
export function studiesGrantedBy(ch, level = ch.level) {
  return (ch.cls.spellbook?.study_levels ?? []).filter(l => l <= level).length;
}

// The common spells a spellbook hero could study right now.
export function studyOptions(data, ch) {
  if (magicModel(data, ch) !== 'spellbook') return [];
  const tier = maxSpellLevel(ch.level);
  return classSpellList(data, classIdOf(data, ch))
    .filter(s => !s.rare && s.level <= tier && !(ch.spellbook ?? []).includes(s.id));
}

// Study picks owed: credits banked minus none — options may be empty (then
// the credit waits for a deeper tier). Returns {remaining, options}.
export function studiesOwed(data, ch) {
  if (magicModel(data, ch) !== 'spellbook') return { remaining: 0, options: [] };
  return { remaining: Math.max(0, ch.studyOwed ?? 0), options: studyOptions(data, ch) };
}

// Spend banked study credits automatically (heroes built above level 1,
// bench jumps): lowest spell level first, round-robin so the book reads
// like one that grew naturally. Returns the ids learned.
export function autoStudy(data, ch) {
  const learned = [];
  while ((ch.studyOwed ?? 0) > 0) {
    const opts = studyOptions(data, ch);
    if (!opts.length) break;
    // Prefer the highest reachable level not yet represented, then lowest.
    const byLevel = {};
    for (const s of opts) (byLevel[s.level] ??= []).push(s);
    const levels = Object.keys(byLevel).map(Number).sort((a, b) => a - b);
    const have = l => (ch.spellbook ?? []).filter(id => data.spells.spells[id]?.level === l).length;
    const lvl = levels.sort((a, b) => have(a) - have(b) || a - b)[0];
    const pick = byLevel[lvl][0];
    ch.spellbook.push(pick.id);
    ch.studyOwed--;
    learned.push(pick.id);
  }
  autoPrepare(data, ch);
  return learned;
}

// Sorcerer: the picks this hero is still owed, oldest spell level first —
// [{level, remaining, options: [spells not yet known at that level]}].
// The pool at each level is the common catalog PLUS whatever the former
// book held (an inked rare may become bloodline).
export function spellPicksOwed(data, ch) {
  if (magicModel(data, ch) !== 'known') return [];
  const clsId = classIdOf(data, ch);
  const per = knownPerLevel(data, ch);
  const known = ch.knownSpells ?? [];
  const former = new Set(ch.formerBook ?? []);
  const out = [];
  for (let lvl = 1; lvl <= maxSpellLevel(ch.level); lvl++) {
    const pool = classSpellList(data, clsId).filter(s => s.level === lvl && (!s.rare || former.has(s.id)));
    const have = pool.filter(s => known.includes(s.id)).length;
    const remaining = Math.min(per, pool.length) - have;
    const options = pool.filter(s => !known.includes(s.id));
    if (remaining > 0 && options.length) out.push({ level: lvl, remaining, options });
  }
  return out;
}

// Sorcerer: wild picks (any castable level) owed from bonus_pick_levels.
export function bonusPicksOwed(data, ch) {
  if (magicModel(data, ch) !== 'known') return { remaining: 0, options: [] };
  const p = passiveOf(data, ch);
  const granted = (p?.bonus_pick_levels ?? []).filter(l => l <= ch.level).length;
  const remaining = Math.max(0, granted - (ch.bonusPicksTaken ?? 0));
  const former = new Set(ch.formerBook ?? []);
  const tier = maxSpellLevel(ch.level);
  const options = classSpellList(data, classIdOf(data, ch))
    .filter(s => s.level <= tier && (!s.rare || former.has(s.id)) && !(ch.knownSpells ?? []).includes(s.id));
  return { remaining, options };
}

// ---- Caster-level scaling ----
// steps = min(max, floor((casterLevel − unlock(spell.level)) / per_levels)).
export function scaleSteps(spell, casterLevel) {
  const sc = spell.scale;
  if (!sc) return 0;
  const steps = Math.floor((casterLevel - unlockLevel(spell.level)) / sc.per_levels);
  return Math.max(0, Math.min(sc.max ?? Infinity, steps));
}

// A designer-readable description of a scale rule ("+1d6 per 2 levels (max 2)").
export function describeScale(spell) {
  const sc = spell.scale;
  if (!sc) return '';
  const what = sc.dice ? `+${sc.dice}` : sc.flat ? `+${sc.flat}` : sc.extra_targets ? `+${sc.extra_targets} target${sc.extra_targets > 1 ? 's' : ''}`
    : sc.rounds ? `+${sc.rounds} round${sc.rounds > 1 ? 's' : ''}` : sc.ac ? `+${sc.ac} AC` : sc.area ? `+${sc.area} area` : '';
  return `${what} per ${sc.per_levels} level${sc.per_levels > 1 ? 's' : ''}${sc.max ? ` (max ${sc.max})` : ''}`;
}

// ---- Scrolls ----
// May this hero READ this scroll's spell in battle? null = yes, else the
// reason (designer-facing). Each school reads its own: arcane hands for
// arcane scrolls, divine voices for prayer-scrolls. Up to max spell level + 1.
export function scrollReadable(data, ch, spell) {
  if (!ch.alive) return `${ch.name} is beyond reading.`;
  const school = spellSchool(spell);
  const gamble = scrollGamble(ch, spell);
  if (ch.cls.caster !== school && !gamble) return school === 'divine'
    ? `Only a divine caster can voice a prayer-scroll — ${ch.name} is a ${ch.cls.name}.`
    : `Only an arcane caster can read the words off a scroll — ${ch.name} is a ${ch.cls.name}.`;
  // A real caster reads one tier deeper than they can cast; a gambler
  // (the Thief) is held to what a caster of their level could actually cast.
  const limit = maxSpellLevel(ch.level) + (gamble ? 0 : 1);
  if (spell.level > limit) return gamble
    ? `Too deep to puzzle out — a level-${spell.level} spell (${ch.name} can attempt up to level ${limit}).`
    : `Too deep to read — a level-${spell.level} spell (${ch.name} can read up to level ${limit}). Copy it and wait, or sell it.`;
  return null;
}

// The Thief's gamble (classes.json 'scroll_gamble', designer ruling
// 2026-09-03): a non-caster class may TRY a scroll of the named school.
// Returns {chance, school} when this hero may attempt THIS spell, else null.
export function scrollGamble(ch, spell) {
  const g = ch.cls.scroll_gamble;
  if (!g || ch.cls.caster === spellSchool(spell)) return null; // real casters just read it
  return spellSchool(spell) === (g.school ?? 'arcane') ? g : null;
}

// Spells this hero has been OWED as revelations at exactly this level (for
// the level-up card) — the rare prayers unlocking now.
export function revelationsAt(data, ch, level) {
  const rl = ch.cls.revelation_levels;
  if (!rl) return [];
  return classSpellList(data, classIdOf(data, ch)).filter(s => s.rare && rl[String(s.level)] === level);
}
