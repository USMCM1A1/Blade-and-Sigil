// Entity constructors (refactor step 3, 2026-09-03). The hero and the
// monster each get built in ONE place; save.js derives its field list from
// the hero shape here, so a new hero field can no longer be forgotten by
// the save (drained and focusType had been).

import { roll, abilityMod } from './rules.js';
import { DataError } from './loader.js';
import { TRACKED_STATS, groupOfType } from './progression.js';
import { refreshSpellbook, magicModel, studiesGrantedBy, autoStudy } from './magic.js';

// ---- Hit points ----
// The HP rule (designer, 2026-08-22): a hero starts with the MAX of their hit
// die at level 1; every level after that is ROLLED, rerolling ones, + CON
// (minimum 1 a level). Heroes built above level 1 (premade parties, bench
// jumps) simulate those rolls so they match a hero who climbed there.
export function rollHp(cls, conMod) {
  let rolled = roll(`1d${cls.hp_die}`);
  let rerolled = false;
  while (rolled === 1 && cls.hp_die > 1) { rerolled = true; rolled = roll(`1d${cls.hp_die}`); }
  return { rolled, rerolled, gain: Math.max(1, rolled + conMod) };
}

export function hpAtLevel(cls, conMod, level) {
  let maxHp = Math.max(1, cls.hp_die + conMod);
  for (let l = 2; l <= level; l++) maxHp += rollHp(cls, conMod).gain;
  return maxHp;
}

// ---- Monsters ----
// A monster on the map: its monsters.json definition spread
// flat, plus the fields play adds. opts.hp overrides the definition's HP
// (the bench's shrunken bosses).
export function makeMonster(def, id, x, y, opts = {}) {
  const hp = opts.hp ?? def.hp;
  return {
    ...def, id, x, y,
    hp, maxHp: hp,
    conditions: [],
    regroup: 0,      // map turns it spends regrouping after the party flees
    halted: false,   // the scout's warning stopped it beside the party
    pack: opts.pack ?? null, // the named encounter it belongs to
  };
}

// ---- Heroes ----
// Fields refreshDerived recomputes from race/class/gear/lane — never saved.
const DERIVED = new Set(['race', 'cls', 'abilities', 'maxSp', 'hitBase', 'attacks', 'buffs']);

export function makeHero(game, def) {
  const cls = game.data.classes.classes[def.class];
  if (!cls) throw new DataError('data/party.json', `Unknown class "${def.class}" for ${def.name}. Valid: ${Object.keys(game.data.classes.classes).join(', ')}`);
  const race = game.data.races.races[def.race];
  if (!race) throw new DataError('data/party.json', `Unknown race "${def.race}" for ${def.name}. Valid: ${Object.keys(game.data.races.races).join(', ')}`);
  if (!cls.allowed_races.includes(def.race)) {
    throw new DataError('data/party.json', `${def.name}: a ${race.name} cannot be a ${cls.name}. Allowed races: ${cls.allowed_races.join(', ')}`);
  }
  // Apply racial ability bonus to rolled scores.
  const abilities = { ...def.abilities };
  for (const [ab, bonus] of Object.entries(race.ability_bonus)) abilities[ab] += bonus;
  // The Half-Elf's floating +1: party.json "bonus_ability" (default DEX).
  if (race.floating_bonus) {
    const ab = def.bonus_ability ?? 'dex';
    if (!(ab in abilities)) throw new DataError('data/party.json', `${def.name}: bonus_ability "${ab}" — use one of str, int, wis, dex, con, cha.`);
    abilities[ab] += race.floating_bonus;
  }

  // The HP rule (designer, 2026-08-22): a hero starts with the MAX of their
  // hit die at level 1; every level after that is rolled, rerolling ones.
  // Heroes built above level 1 (premade parties, bench jumps) simulate
  // those rolls so they match a hero who climbed there.
  const maxHp = hpAtLevel(cls, abilityMod(abilities.con), def.level);
  if (!game.data.items.items[cls.starting_weapon]) {
    throw new DataError('data/classes.json', `${cls.name}'s starting_weapon "${cls.starting_weapon}" is not in items.json. Valid: ${Object.keys(game.data.items.items).join(', ')}`);
  }
  const ch = {
    name: def.name,
    race, cls, level: def.level, row: def.row,
    abilities,
    hp: maxHp, maxHp,
    drained: 0, // max HP the undead have drunk (restored in full by any full rest)
    sp: 0, maxSp: 0,
    xp: 0,
    // Attack math lives in battle.js: melee uses STR, ranged weapons use DEX
    // (design doc), and battle buffs stack on top of hitBase.
    // hitBase/attacks are computed in refreshDerived (lane offsets apply).
    hitBase: 0,
    attacks: 1,
    // Progression v2: the lane walked at the fork (null until chosen), the
    // Weapon Focus category, timed battle buffs (Rage), and the playstyle
    // counters that will feed the level-20 Rite's titles.
    // Appearance (2026-08-26): creation lets each hero pick one of four
    // race+sex body/portrait variants; null falls back to the class art.
    // party.json may use the friendly variant key ("m1"/"f2"), expanded here.
    look: game.resolveLook(def),
    lane: def.lane ?? null,
    // Weapon families sworn. party.json may say "focus": "blade" or a
    // list; a focus saved under the older rules was a raw weapon type
    // ('med_blade'), which is read as its family ('blade').
    focusType: null, // the headline oath, kept for older readers (focusTypes[0] once sworn)
    focusTypes: [def.focus ?? []].flat().map(f => game.data.items.focus_groups?.[f] ? f : groupOfType(game.data, f)).filter(Boolean),
    abilityBoosts: [],
    growth: [],
    // The creation gift (half-casters, companion doc v1): {id, element?}
    // from classes.json creation_pick — resolved below.
    gift: game.resolveGift(def, cls),
    bonusAbility: def.bonus_ability ?? (race.floating_bonus ? 'dex' : null),
    // Favored enemies (the Ranger): {family: bonus}; picks made so far.
    favored: game.resolveFavored(def, cls),
    favoredPicks: 0,
    timedBuffs: [],
    counters: Object.fromEntries(TRACKED_STATS.map(k => [k, 0])),
    rite: null, // filled by the Level 20 Rite: {abilityName, sigil, title, tier}
    // Magic v2: the Wizard lane's book & daily preparation, the Sorcerer
    // lane's fixed repertoire, and the once-per-rest powers already spent.
    spellbook: [],
    prepared: [],
    knownSpells: [],
    formerBook: null, // magic v3: the Raw Gift sets the book aside here (its pages may be picked as bloodline)
    studyOwed: 0,     // magic v3: free spellbook picks banked from study levels
    bonusPicksTaken: 0, // magic v3: the Sorcerer's wild picks already made
    spentRest: {},   // {archmage: true, miracle: true, ...} — cleared by a full rest
    prepFresh: false, // Prepared Mind: the re-pick window a rest opens
    // The paper doll: item ids from items.json. Hands hold weapons or a
    // shield; a hero always keeps at least one weapon in hand.
    equipment: {
      hand1: cls.starting_weapon, hand2: null,
      head: null, necklace: null, armor: null, cloak: null, boots: null,
      ring1: null, ring2: null,
    },
    buffs: { hit: 0, dmg: 0 },
    quiver: 0, // arrows this hero carries (filled from the pouch; see restockQuiver)
    conditions: [], // {id, rounds, mapCounter} — see data/conditions.json
    alive: true,
  };
  // The spellbook (magic v3): a wizard opens the class kit at level 1 — or
  // the pages party.json names ("spells": [...]). A hero built above
  // level 1 (premade parties, test parties) has studied on the road: the
  // study credits they are owed are spent automatically so nobody faces
  // a stack of modals on arrival.
  if (def.spells) {
    for (const id of def.spells) {
      const sd = game.data.spells.spells[id];
      if (!sd) throw new DataError('data/party.json', `${def.name}'s "spells" names "${id}", which isn't in spells.json.`);
      if (!sd.classes.includes(def.class)) throw new DataError('data/party.json', `${def.name}'s "spells" names "${id}", which a ${cls.name} cannot cast.`);
    }
    ch.spellbook = [...def.spells];
  }
  if (Object.keys(ch.favored).length) ch.favoredPicks = 1;
  refreshSpellbook(game.data, ch);
  if (magicModel(game.data, ch) === 'spellbook' && def.level > 1) {
    const kit = (cls.spellbook?.starting_spells ?? []).length;
    ch.studyOwed = Math.max(0, studiesGrantedBy(ch) - Math.max(0, ch.spellbook.length - kit));
    autoStudy(game.data, ch);
  }
  game.refreshDerived(ch);
  ch.sp = ch.maxSp;
  return ch;
}

// Everything about a hero that is played, not derived — THE save field list.
// Built from a throwaway hero so it can never drift from the shape above.
export const HERO_FIELDS = (() => {
  const probe = makeHeroShape();
  return Object.keys(probe).filter(k => !DERIVED.has(k));
})();

// The bare shape (no data needed): every field makeHero sets, in order.
function makeHeroShape() {
  return {
    name: '', race: null, cls: null, level: 1, row: 'front', abilities: {},
    hp: 1, maxHp: 1, drained: 0, sp: 0, maxSp: 0, xp: 0, hitBase: 0, attacks: 1,
    look: null, lane: null, focusType: null, focusTypes: [], abilityBoosts: [], growth: [],
    gift: null, bonusAbility: null, favored: {}, favoredPicks: 0,
    timedBuffs: [], counters: {}, rite: null,
    spellbook: [], prepared: [], knownSpells: [], formerBook: null, studyOwed: 0,
    bonusPicksTaken: 0, spentRest: {}, prepFresh: false,
    equipment: {}, buffs: {}, quiver: 0, conditions: [], alive: true,
  };
}
