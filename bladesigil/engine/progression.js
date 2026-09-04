// Class Progression v2 framework (design doc v2): the generic machinery for
// lane forks, passives, signature verbs, capstones, and refinements. All the
// CONTENT lives in user-owned data/progression.json — a class with no entry
// there simply levels along its base tables. This module only answers
// questions ("what lane is Kael?", "does he have Rampage yet?"); the effects
// themselves are applied in game.js (stat offsets) and battle.js (abilities).

import { DataError } from './loader.js';
import { conditionIds } from './validate.js';
import { spellPicksOwed, studiesOwed, bonusPicksOwed } from './magic.js';

// The half-caster classes (Spellblade, Stoneshaper — companion doc v1,
// 2026-08-29) added sundered_calm/granite_skin/warding_presence, the
// riposte/ward-surge/unyielding/shared-fortitude verbs, and their kin.
const PASSIVES = ['weapon_focus', 'braced_stance', 'vital_strike', 'keen_senses',
  'prepared_mind', 'overchannel', 'blessed_hands', 'sacred_weapon',
  'sundered_calm', 'granite_skin', 'warding_presence', 'ambidexterity', 'snap_shot'];
const VERBS = ['rampage', 'guardians_stand', 'assassinate', 'vanish',
  'arcane_insight', 'overcast', 'mercy', 'zealous_strike',
  'runic_riposte', 'ward_surge', 'unyielding', 'shared_fortitude', 'hunters_surge', 'volley'];
const CAPSTONES = ['rage', 'bulwark', 'lethality', 'set_trap', 'deadly_webs',
  'archmage', 'twin_surge', 'miracle', 'divine_inspiration',
  'whirling_verse', 'mirror_ward', 'mountains_heart', 'deep_roots', 'storm_of_blades', 'rain_of_arrows'];
const REFINEMENTS = ['rampage_crits', 'stand_half_cost', 'assassinate_low_hp', 'vanish_free',
  'insight_double', 'overcast_cheap', 'mercy_cures', 'zealous_immunity',
  'riposte_allies', 'ward_surge_allies', 'unyielding_allies', 'fortitude_two', 'offhand_free', 'hawk_on_the_move'];
const RITE_ABILITIES = ['whirlwind', 'aegis', 'deathblow', 'shadowstep',
  'final_word', 'maelstrom', 'sanctuary', 'judgment',
  'crescendo', 'unbroken_chord', 'bedrock', 'hearthfire', 'pack_instinct', 'true_shot'];
export const TRACKED_STATS = ['rampageKills', 'standSaves', 'assassinateKills', 'shadowFeats',
  'bookCasts', 'overcasts', 'mercySaves', 'zealousStrikes',
  'riposteKills', 'wardDeflects', 'unyieldingSaves', 'alliesFortified', 'surgeKills', 'volleyKills'];

export const WEAPON_CATEGORIES = ['light_blade', 'med_blade', 'heavy_blade', 'axe', 'light_blunt', 'med_blunt', 'heavy_blunt', 'bow'];

// ---- Weapon Focus groups (designer ruling 2026-09-02) ----
// Focus is sworn to a GROUP (Blades / Blunt / Axes / Bows), not to the
// narrow item type, so finding a great two-hander never wastes the pick.
// The map lives in user-owned items.json → focus_groups; item `type` is
// untouched and still governs class restrictions and equip slots.
export function focusGroups(data) { return data.items.focus_groups ?? {}; }

// The group a weapon type belongs to ('med_blade' → 'blade'), or null.
export function groupOfType(data, type) {
  const t = (type ?? '').replace(/^weapon_/, '');
  return Object.keys(focusGroups(data)).find(g => focusGroups(data)[g].types?.includes(t)) ?? null;
}

// Every weapon family this hero has sworn to. A hero swears one at the
// fork and ADDS another at each of the passive's extra_levels, so this is
// a list. Tolerant of two older shapes: a single group id ('blade') and
// the oldest raw weapon type ('med_blade') — both answer with the group.
export function focusList(data, ch) {
  const raw = ch.focusTypes ?? (ch.focusType ? [ch.focusType] : []);
  const out = [];
  for (const f of raw) {
    const g = focusGroups(data)[f] ? f : groupOfType(data, f);
    if (g && !out.includes(g)) out.push(g);
  }
  return out;
}

// The FIRST family sworn (the sheet's headline), or null.
export function focusGroupOf(data, ch) { return focusList(data, ch)[0] ?? null; }

// Does the weapon in hand belong to any family the hero has sworn?
export function focusMatches(data, ch, weapon) {
  const g = groupOfType(data, weapon?.type);
  return !!g && focusList(data, ch).includes(g);
}

// How many more weapon families this hero may swear to right now: one at
// the fork, plus one for each of the passive's extra_levels reached —
// capped by the families their class can actually wield.
export function focusPicksOwed(data, ch) {
  const p = passiveOf(data, ch);
  if (p?.id !== 'weapon_focus') return 0;
  const granted = 1 + (p.extra_levels ?? []).filter(l => ch.level >= l).length;
  const taken = focusList(data, ch).length;
  const available = focusOptions(data, ch).length; // options already exclude taken
  return Math.min(Math.max(0, granted - taken), available);
}

// ---- Snares (designer ruling 2026-09-03) ----
// The Shadows lane's toy, granted WITH the lane (lane.grant) instead of
// held back to the capstone. Damage grows with the levels since the fork.
export function snareGrant(data, ch) {
  const lane = laneOf(data, ch);
  const g = lane?.grant;
  return g?.id === 'snares' && ch.level >= (classProg(data, ch)?.fork_level ?? 99) ? g : null;
}

// The kinds of snare this hero can lay: the plain one, plus any taken as
// growth picks ('snare' field). Each returns {id, name, blurb, rider}.
export function snareKinds(data, ch) {
  const g = snareGrant(data, ch);
  if (!g) return [];
  const out = [{ id: 'plain', name: g.name ?? 'Snare', blurb: 'A simple mechanism — it hurts whatever finds it.' }];
  for (const o of growthPicks(data, ch)) {
    if (o.snare) out.push({ id: o.snare, name: o.name, blurb: o.blurb });
  }
  return out;
}

// A snare's damage dice at this level: the grant's dice, plus one more of
// scale.dice for every scale.per_levels above the fork.
export function snareDice(data, ch) {
  const g = snareGrant(data, ch);
  if (!g) return null;
  const fork = classProg(data, ch)?.fork_level ?? 5;
  const per = g.scale?.per_levels ?? 4;
  const steps = Math.max(0, Math.floor((ch.level - fork) / per));
  const base = g.dice ?? '2d6';
  if (!steps || !g.scale?.dice) return { dice: base, steps: 0 };
  const m = /^(\d+)d(\d+)$/.exec(base), e = /^(\d+)d(\d+)$/.exec(g.scale.dice);
  if (!m || !e || m[2] !== e[2]) return { dice: base, steps };
  return { dice: `${Number(m[1]) + steps * Number(e[1])}d${m[2]}`, steps };
}

// ---- Lane growth (designer session 2026-09-02) ----
// A lane may carry a "growth" block in progression.json: {levels, options}.
// The hero picks ONE option at each level, and every list holds MORE options
// than picks — so two heroes of the same lane end up genuinely different.
// Weapon Focus is the same idea with its own older machinery; the Ranger has
// none because Favored Enemy already IS a growth list.
export function growthBlock(data, ch) { return laneOf(data, ch)?.growth ?? null; }

// The option ids this hero has taken.
export function growthTaken(ch) { return ch.growth ?? []; }

// Options still on the table (the taken ones drop out, so the list empties).
export function growthOptions(data, ch) {
  const g = growthBlock(data, ch);
  if (!g) return [];
  const taken = growthTaken(ch);
  return (g.options ?? []).filter(o => !taken.includes(o.id));
}

export function growthPicksOwed(data, ch) {
  const g = growthBlock(data, ch);
  if (!g) return 0;
  const granted = (g.levels ?? []).filter(l => ch.level >= l).length;
  const owed = Math.max(0, granted - growthTaken(ch).length);
  return Math.min(owed, growthOptions(data, ch).length); // never owe what cannot be taken
}

// How many picks this hero should hold at their CURRENT level — the bench
// uses it to hand growth back when it drops someone below a growth level.
export function growthPicksAllowed(data, ch) {
  const g = growthBlock(data, ch);
  return g ? (g.levels ?? []).filter(l => ch.level >= l).length : 0;
}

// The taken options themselves, so consumers can read their effect fields.
export function growthPicks(data, ch) {
  const g = growthBlock(data, ch);
  if (!g) return [];
  return growthTaken(ch).map(id => (g.options ?? []).find(o => o.id === id)).filter(Boolean);
}

// Does this hero hold a growth pick carrying `field`? Returns the value
// (summed for numbers, true for flags) — the one call every consumer uses.
export function growthEffect(data, ch, field) {
  let out = 0, flag = false;
  for (const o of growthPicks(data, ch)) {
    const v = o[field];
    if (v === undefined) continue;
    if (typeof v === 'number') out += v; else flag = true;
  }
  return out || flag;
}

// Growth picks whose `field` equals `value` (brace_vs: 'spell', refuse: 'poison').
export function growthNamed(data, ch, field, value) {
  return growthPicks(data, ch).find(o => o[field] === value) ?? null;
}

// ---- The level-10 ability boost (designer ruling 2026-09-02) ----
// Every class gets +1 to an ability of the player's choice at each level
// in progression.json → ability_boost.levels. Gear grants no ability
// scores any more, so this is the only way one rises after creation.
export function abilityBoost(data) { return data.progression.ability_boost ?? null; }

// Picks are stored in the order they were made (ch.abilityBoosts, e.g.
// ['str']) so the playtest bench can undo them when it drops a level.
export function abilityPicksOwed(data, ch) {
  const b = abilityBoost(data);
  if (!b) return 0;
  const granted = (b.levels ?? []).filter(l => ch.level >= l).length;
  return Math.max(0, granted - (ch.abilityBoosts ?? []).length);
}

// How many picks this hero should have at their CURRENT level — the bench
// uses it to hand points back when it drops someone below the boost level.
export function abilityPicksAllowed(data, ch) {
  const b = abilityBoost(data);
  return b ? (b.levels ?? []).filter(l => ch.level >= l).length : 0;
}

// The display name of a focus group ('blade' → 'Blades').
export function focusName(data, group) {
  return focusGroups(data)[group]?.name ?? (group ?? '').replace('_', ' ');
}

// Friendly boot-time validation, in designer terms.
export function validateProgression(data) {
  // Weapon Focus groups (items.json → focus_groups): every weapon category
  // must live in exactly one group, or a hero could swear to a focus that
  // no weapon in the game answers to.
  const groups = data.items.focus_groups;
  if (!groups || !Object.keys(groups).length) {
    throw new DataError('data/items.json', `"focus_groups" is missing — Weapon Focus needs at least one group, e.g. {"blade": {"name": "Blades", "types": ["light_blade", "med_blade", "heavy_blade"]}}.`);
  }
  const seen = new Map();
  for (const [g, def] of Object.entries(groups)) {
    if (!Array.isArray(def.types) || !def.types.length) {
      throw new DataError('data/items.json', `focus group "${g}" needs a "types" list naming the weapon categories it covers. Valid categories: ${WEAPON_CATEGORIES.join(', ')}.`);
    }
    for (const t of def.types) {
      if (!WEAPON_CATEGORIES.includes(t)) {
        throw new DataError('data/items.json', `focus group "${g}" lists weapon type "${t}", which is not a weapon category. Valid: ${WEAPON_CATEGORIES.join(', ')}.`);
      }
      if (seen.has(t)) {
        throw new DataError('data/items.json', `weapon type "${t}" is in two focus groups ("${seen.get(t)}" and "${g}") — each type belongs to exactly one.`);
      }
      seen.set(t, g);
    }
  }
  const orphans = WEAPON_CATEGORIES.filter(t => !seen.has(t));
  if (orphans.length) {
    throw new DataError('data/items.json', `these weapon types belong to no focus group: ${orphans.join(', ')}. Add each to a group in "focus_groups" so Weapon Focus can cover them.`);
  }
  // The level-10 ability boost block.
  const boost = data.progression.ability_boost;
  if (boost) {
    if (!Array.isArray(boost.levels) || !boost.levels.every(l => Number.isInteger(l) && l >= 1 && l <= 20)) {
      throw new DataError('data/progression.json', `"ability_boost" needs "levels": a list of character levels from 1 to 20, e.g. [10].`);
    }
    if (!Number.isInteger(boost.amount) || boost.amount < 1) {
      throw new DataError('data/progression.json', `"ability_boost" needs "amount": how many points the hero adds, a whole number 1 or more.`);
    }
  }
  // Lane growth blocks: levels, unique option ids, known effect fields, and
  // the rule that makes builds differ — more options than picks.
  const GROWTH_FIELDS = ['id', 'name', 'blurb', 'brace_vs', 'brace_bonus', 'brace_no_shield',
    'brace_allies', 'refuse', 'aura_ac', 'aura_reduce', 'aura_saves', 'aura_party',
    'aura_refuse', 'vital_when', 'skill', 'find_range', 'search_turns', 'disarm_safe',
    'chest_safe', 'find_sure', 'saves', 'snare', 'see_hidden', 'watch'];
  const VITAL_WHEN = ['poisoned', 'wounded', 'held', 'frightened', 'alone', 'bigger'];
  const BRACE_VS = ['spell', 'trap', 'ranged'];
  const condIds = conditionIds(data);
  for (const [cid, c] of Object.entries(data.progression.classes ?? {})) {
    for (const lane of c.lanes ?? []) {
      const g = lane.growth;
      if (!g) continue;
      const where = `${cid} / ${lane.name}`;
      if (!Array.isArray(g.levels) || !g.levels.length || !g.levels.every(l => Number.isInteger(l) && l >= 1 && l <= 20)) {
        throw new DataError('data/progression.json', `${where}: "growth" needs "levels" — the character levels a pick is offered, e.g. [8, 14, 16].`);
      }
      if (!Array.isArray(g.options) || !g.options.length) {
        throw new DataError('data/progression.json', `${where}: "growth" needs an "options" list — the choices offered at those levels.`);
      }
      if (g.options.length <= g.levels.length) {
        throw new DataError('data/progression.json', `${where}: growth offers ${g.options.length} options for ${g.levels.length} picks. Give it MORE options than picks, or every hero of this lane ends up identical.`);
      }
      const ids = new Set();
      for (const o of g.options) {
        if (!o.id || !o.name) throw new DataError('data/progression.json', `${where}: every growth option needs an "id" and a "name".`);
        if (ids.has(o.id)) throw new DataError('data/progression.json', `${where}: two growth options share the id "${o.id}" — ids must be unique.`);
        ids.add(o.id);
        for (const k of Object.keys(o)) {
          if (!GROWTH_FIELDS.includes(k)) {
            throw new DataError('data/progression.json', `${where}: growth option "${o.id}" has unknown field "${k}". Valid: ${GROWTH_FIELDS.join(', ')}.`);
          }
        }
        if (o.vital_when && !VITAL_WHEN.includes(o.vital_when)) {
          throw new DataError('data/progression.json', `${where}: growth option "${o.id}" has vital_when "${o.vital_when}". Valid: ${VITAL_WHEN.join(', ')}.`);
        }
        if (o.snare && !['venom', 'bear', 'caltrops', 'flash'].includes(o.snare)) {
          throw new DataError('data/progression.json', `${where}: growth option "${o.id}" lays a "${o.snare}" snare. Valid: venom (poisons), bear (holds), caltrops (slows), flash (blinds).`);
        }
        if (o.brace_vs && !BRACE_VS.includes(o.brace_vs)) {
          throw new DataError('data/progression.json', `${where}: growth option "${o.id}" braces against "${o.brace_vs}". Valid: ${BRACE_VS.join(', ')}.`);
        }
        for (const f of ['refuse', 'aura_refuse']) {
          if (o[f] && !condIds.includes(o[f])) {
            throw new DataError('data/progression.json', `${where}: growth option "${o.id}" names condition "${o[f]}". Valid: ${condIds.join(', ')}.`);
          }
        }
      }
    }
  }
  // Weapon Focus extra_levels, where a hero swears to another family.
  for (const [cid, c] of Object.entries(data.progression.classes ?? {})) {
    for (const lane of c.lanes ?? []) {
      const ex = lane.passive?.extra_levels;
      if (ex === undefined) continue;
      if (lane.passive.id !== 'weapon_focus') {
        throw new DataError('data/progression.json', `${cid} / ${lane.name}: "extra_levels" only means something on a "weapon_focus" passive (this one is "${lane.passive.id}").`);
      }
      if (!Array.isArray(ex) || !ex.every(l => Number.isInteger(l) && l >= 1 && l <= 20)) {
        throw new DataError('data/progression.json', `${cid} / ${lane.name}: weapon_focus "extra_levels" must be a list of character levels 1-20, e.g. [8, 14, 16].`);
      }
    }
  }
  const sigil = data.progression.sigil;
  if (sigil) {
    for (const part of ['shapes', 'modifiers', 'colors']) {
      if (!Array.isArray(sigil[part]) || !sigil[part].length) {
        throw new DataError('data/progression.json', `The "sigil" vocabulary needs a non-empty "${part}" list.`);
      }
    }
  }
  for (const [clsId, prog] of Object.entries(data.progression.classes || {})) {
    const where = `data/progression.json ("${clsId}")`;
    if (!data.classes.classes[clsId]) {
      throw new DataError('data/progression.json', `"${clsId}" is not a class in classes.json. Valid: ${Object.keys(data.classes.classes).join(', ')}`);
    }
    if (typeof prog.fork_level !== 'number' || prog.fork_level < 2 || prog.fork_level > 20) {
      throw new DataError(where, `"fork_level" must be a level between 2 and 20.`);
    }
    if (!Array.isArray(prog.lanes) || prog.lanes.length !== 2) {
      throw new DataError(where, `"lanes" must list exactly two paths (the hard fork).`);
    }
    for (const lane of prog.lanes) {
      const laneWhere = `${where} lane "${lane.id || '?'}"`;
      if (!lane.id || !lane.name) throw new DataError(laneWhere, `Every lane needs an "id" and a "name".`);
      if (lane.passive && !PASSIVES.includes(lane.passive.id)) {
        throw new DataError(laneWhere, `Unknown passive "${lane.passive.id}". The engine knows: ${PASSIVES.join(', ')}`);
      }
      for (const l of lane.passive?.bonus_pick_levels ?? []) {
        if (typeof l !== 'number' || l < 1 || l > 20) throw new DataError(laneWhere, `overchannel "bonus_pick_levels" must list character levels 1-20.`);
      }
      if (lane.passive?.slots_bonus !== undefined && typeof lane.passive.slots_bonus !== 'number') {
        throw new DataError(laneWhere, `prepared_mind "slots_bonus" must be a number of extra prepared slots.`);
      }
      if (lane.verb && !VERBS.includes(lane.verb.id)) {
        throw new DataError(laneWhere, `Unknown verb "${lane.verb.id}". The engine knows: ${VERBS.join(', ')}`);
      }
      if (lane.capstone && !CAPSTONES.includes(lane.capstone.id)) {
        throw new DataError(laneWhere, `Unknown capstone "${lane.capstone.id}". The engine knows: ${CAPSTONES.join(', ')}`);
      }
      if (lane.refinement && !REFINEMENTS.includes(lane.refinement.id)) {
        throw new DataError(laneWhere, `Unknown refinement "${lane.refinement.id}". The engine knows: ${REFINEMENTS.join(', ')}`);
      }
      if (lane.rite) {
        const r = lane.rite;
        if (!r.ability || !RITE_ABILITIES.includes(r.ability.id)) {
          throw new DataError(laneWhere, `The rite needs an "ability" with an id the engine knows: ${RITE_ABILITIES.join(', ')}`);
        }
        if (!TRACKED_STATS.includes(r.tracked)) {
          throw new DataError(laneWhere, `Rite "tracked" must be one of the playstyle counters: ${TRACKED_STATS.join(', ')}`);
        }
        if (!Array.isArray(r.tiers) || r.tiers.length !== 3) {
          throw new DataError(laneWhere, `Rite "tiers" must list exactly three entries, low to high.`);
        }
        r.tiers.forEach((t, i) => {
          if (typeof t.min !== 'number' || !t.title) {
            throw new DataError(laneWhere, `Rite tier ${i + 1} needs a numeric "min" and a "title".`);
          }
          if (i > 0 && t.min <= r.tiers[i - 1].min) {
            throw new DataError(laneWhere, `Rite tier ${i + 1}'s "min" must be higher than tier ${i}'s.`);
          }
          if (t.trinket && !data.items.items[t.trinket]) {
            throw new DataError(laneWhere, `Rite tier ${i + 1}'s trinket "${t.trinket}" is not in items.json.`);
          }
        });
        if (!data.progression.sigil) {
          throw new DataError('data/progression.json', `A lane has a "rite" but there is no top-level "sigil" vocabulary block.`);
        }
      }
    }
  }
}

// The class id for a built hero (ch.cls is the class OBJECT).
export function classId(data, ch) {
  return Object.keys(data.classes.classes).find(k => data.classes.classes[k] === ch.cls);
}

export function classProg(data, ch) {
  return data.progression?.classes?.[classId(data, ch)] ?? null;
}

// The lane the hero walked at the fork — null before choosing (or for
// classes with no progression entry).
export function laneOf(data, ch) {
  const prog = classProg(data, ch);
  return prog?.lanes.find(l => l.id === ch.lane) ?? null;
}

export function passiveOf(data, ch) {
  return laneOf(data, ch)?.passive ?? null;
}

// The name a passive wears in every log line: its own 'name' if the
// designer gave one (Edge Eternal), else the engine's default.
export function passiveName(p, fallback) { return p?.name ?? fallback; }

export function hasVerb(data, ch, id) {
  const lane = laneOf(data, ch);
  return !!lane?.verb && lane.verb.id === id && ch.level >= lane.verb.level;
}

export function hasCapstone(data, ch, id) {
  const lane = laneOf(data, ch);
  return !!lane?.capstone && lane.capstone.id === id && ch.level >= lane.capstone.level;
}

export function hasRefinement(data, ch, id) {
  const lane = laneOf(data, ch);
  return !!lane?.refinement && lane.refinement.id === id && ch.level >= lane.refinement.level;
}

// From the capstone level on, the lane's archetype IS the hero's title.
export function displayClass(data, ch) {
  const lane = laneOf(data, ch);
  if (!lane) return ch.cls.name;
  if (lane.archetype && lane.capstone && ch.level >= lane.capstone.level) return lane.archetype;
  return `${ch.cls.name} · ${lane.name}`;
}

// ---- The Level 20 Rite ----
export function riteOf(data, ch) {
  const lane = laneOf(data, ch);
  return (lane?.rite && ch.level >= 20) ? lane.rite : null;
}

// Which tier (0/1/2) the hero's tracked playstyle counter has earned.
export function riteTier(data, ch) {
  const rite = laneOf(data, ch)?.rite;
  if (!rite) return 0;
  const stat = ch.counters?.[rite.tracked] ?? 0;
  let tier = 0;
  rite.tiers.forEach((t, i) => { if (stat >= t.min) tier = i; });
  return tier;
}

// Does this hero know their level-20 rite ability (ceremony completed)?
export function hasRiteAbility(data, ch, id) {
  const rite = riteOf(data, ch);
  return !!ch.rite && !!rite && rite.ability.id === id;
}

// Weapon categories this hero may focus in (the Blade-lane sub-choice).
// The focus GROUPS this hero may still swear to: offered when the class
// can actually wield something in it (a priest sees Blunt only), minus
// the families they have already sworn.
export function focusOptions(data, ch) {
  const types = ch.cls.weapon_types ?? ['any'];
  const all = types.includes('any') ? WEAPON_CATEGORIES : types;
  const groups = focusGroups(data);
  const held = focusList(data, ch);
  return Object.keys(groups).filter(g => !held.includes(g) && groups[g].types?.some(t => all.includes(t)));
}

// Favored Enemy (the Ranger): picks granted by the class's favored_enemy
// levels minus picks already made. The first pick is made in creation.
export function favoredPicksOwed(ch) {
  const fe = ch.cls.favored_enemy;
  if (!fe) return 0;
  const granted = (fe.levels ?? []).filter(l => l <= ch.level).length;
  return Math.max(0, granted - (ch.favoredPicks ?? 0));
}

// Choices this hero is owed. Presented on the map, one modal at a time —
// also fires for freshly-built high-level heroes (the party.json test path).
export function pendingChoices(data, ch) {
  const out = [];
  if (!ch.alive) return out;
  for (let i = 0; i < favoredPicksOwed(ch); i++) out.push({ type: 'favored', ch });
  const prog = classProg(data, ch);
  if (!prog) return out;
  if (ch.level >= prog.fork_level && !ch.lane) out.push({ type: 'lane', ch, prog });
  // The level-10 boost: +1 to an ability of the player's choice. Every
  // class, every lane — the only way an ability rises after creation.
  for (let i = 0; i < abilityPicksOwed(data, ch); i++) out.push({ type: 'ability', ch });
  // Weapon Focus: one family at the fork, another at each extra_level.
  for (let i = 0; i < focusPicksOwed(data, ch); i++) out.push({ type: 'focus', ch });
  // Lane growth: the lane's own list widens at its growth levels.
  for (let i = 0; i < growthPicksOwed(data, ch); i++) out.push({ type: 'growth', ch });
  // The Sorcerer's narrow gift: each unlocked spell level owes its picks,
  // and the blood remembers a wild pick at each bonus level.
  for (const owed of spellPicksOwed(data, ch)) {
    for (let i = 0; i < owed.remaining; i++) out.push({ type: 'spell', ch, level: owed.level });
  }
  const bonus = bonusPicksOwed(data, ch);
  if (bonus.options.length) for (let i = 0; i < bonus.remaining; i++) out.push({ type: 'spell', ch, level: 'any' });
  // The spellbook's study: a free page at each study level (magic v3) —
  // only offered while there is something left to learn at this tier.
  const study = studiesOwed(data, ch);
  if (study.options.length) for (let i = 0; i < study.remaining; i++) out.push({ type: 'study', ch });
  // The Level 20 Rite: owed once the lane is walked and the pinnacle reached.
  const lane = laneOf(data, ch);
  if (lane?.rite && ch.level >= 20 && !ch.rite) out.push({ type: 'rite', ch, lane });
  return out;
}
