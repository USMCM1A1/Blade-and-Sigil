// Class Progression v2 framework (design doc v2): the generic machinery for
// lane forks, passives, signature verbs, capstones, and refinements. All the
// CONTENT lives in user-owned data/progression.json — a class with no entry
// there simply levels along its base tables. This module only answers
// questions ("what lane is Kael?", "does he have Rampage yet?"); the effects
// themselves are applied in game.js (stat offsets) and battle.js (abilities).

import { DataError } from './loader.js';
import { spellPicksOwed } from './magic.js';

const PASSIVES = ['weapon_focus', 'braced_stance', 'vital_strike', 'keen_senses',
  'prepared_mind', 'overchannel', 'blessed_hands', 'sacred_weapon'];
const VERBS = ['rampage', 'guardians_stand', 'assassinate', 'vanish',
  'arcane_insight', 'overcast', 'mercy', 'zealous_strike'];
const CAPSTONES = ['rage', 'bulwark', 'lethality', 'set_trap',
  'archmage', 'twin_surge', 'miracle', 'divine_inspiration'];
const REFINEMENTS = ['rampage_crits', 'stand_half_cost', 'assassinate_low_hp', 'vanish_free',
  'insight_double', 'overcast_cheap', 'mercy_cures', 'zealous_immunity'];
const RITE_ABILITIES = ['whirlwind', 'aegis', 'deathblow', 'shadowstep',
  'final_word', 'maelstrom', 'sanctuary', 'judgment'];
const TRACKED_STATS = ['rampageKills', 'standSaves', 'assassinateKills', 'shadowFeats',
  'bookCasts', 'overcasts', 'mercySaves', 'zealousStrikes'];

export const WEAPON_CATEGORIES = ['light_blade', 'med_blade', 'heavy_blade', 'light_blunt', 'med_blunt', 'heavy_blunt', 'bow'];

// Friendly boot-time validation, in designer terms.
export function validateProgression(data) {
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
export function focusOptions(data, ch) {
  const types = ch.cls.weapon_types ?? ['any'];
  return types.includes('any') ? WEAPON_CATEGORIES : types;
}

// Choices this hero is owed. Presented on the map, one modal at a time —
// also fires for freshly-built high-level heroes (the party.json test path).
export function pendingChoices(data, ch) {
  const out = [];
  if (!ch.alive) return out;
  const prog = classProg(data, ch);
  if (!prog) return out;
  if (ch.level >= prog.fork_level && !ch.lane) out.push({ type: 'lane', ch, prog });
  const passive = passiveOf(data, ch);
  if (passive?.id === 'weapon_focus' && !ch.focusType) out.push({ type: 'focus', ch });
  // The Sorcerer's narrow gift: each unlocked spell level owes its picks.
  for (const owed of spellPicksOwed(data, ch)) {
    for (let i = 0; i < owed.remaining; i++) out.push({ type: 'spell', ch, level: owed.level });
  }
  // The Level 20 Rite: owed once the lane is walked and the pinnacle reached.
  const lane = laneOf(data, ch);
  if (lane?.rite && ch.level >= 20 && !ch.rite) out.push({ type: 'rite', ch, lane });
  return out;
}
