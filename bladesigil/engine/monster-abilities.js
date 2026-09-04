// The monster ability registry (refactor step 5a, 2026-09-04). One entry
// per "abilities" type in monsters.json: how it is validated at boot, when
// the AI may pick it, and what it does. Adding a type = one entry here plus
// its resolver on the Battle (which the entry names). The friendly boot
// messages are the same ones validateMonsters always printed.
//
//   validate(ab, ctx)  ctx = {err, where, id, data, conditionIds, monsterIds}
//   viable(battle, c, ab) → boolean — may the AI use it this turn?
//   act(battle, c, ab) — resolve it (async actions call finishMonsterAction)

import { isDice, isDiceOrInt } from './validate.js';

const notAfflicted = (h, condition) => !h.ref.conditions.some(cd => cd.id === condition);

export const MONSTER_ABILITIES = {
  bolt: {
    validate: (ab, { err, where }) => { if (!isDice(ab.dice)) err(`${where} needs dice like "3d6".`); },
    viable: (b, c, ab) => !!b.abilityTarget(c, ab), // someone in reach
    act: (b, c, ab) => b.monsterBlast(c, ab),
  },
  breath: {
    validate: (ab, { err, where }) => { if (!isDice(ab.dice)) err(`${where} needs dice like "3d6".`); },
    viable: (b, c, ab) => !!b.abilityTarget(c, ab),
    act: (b, c, ab) => b.monsterBlast(c, ab), // bolt & breath share a resolution
  },
  afflict: {
    validate: (ab, { err, where, conditionIds }) => {
      if (!conditionIds.includes(ab.condition)) err(`${where} inflicts "${ab.condition}". Valid conditions: ${conditionIds.join(', ')}.`);
      if (ab.targets && ab.targets !== 'party') err(`${where} targets "${ab.targets}" — an afflict aims at one hero unless targets is "party".`);
    },
    viable: (b, c, ab) => ab.targets === 'party'
      ? b.heroes().some(h => h.ref.alive && notAfflicted(h, ab.condition))
      : b.heroesInReach(c, ab.range ?? 6).some(h => notAfflicted(h, ab.condition)),
    act: (b, c, ab) => b.monsterAfflict(c, ab),
  },
  haste: {
    validate: (ab, { err, where }) => { if (ab.targets && !['self', 'allies'].includes(ab.targets)) err(`${where} targets "${ab.targets}". A haste targets "self" or "allies".`); },
    viable: (b, c, ab) => {
      const targets = ab.targets === 'self' ? [c] : b.monsters().filter(mc => mc !== c && mc.ref.hp > 0);
      return targets.some(t => !t.haste);
    },
    act: (b, c, ab) => b.monsterHaste(c, ab),
  },
  spell: {
    validate: (ab, { err, where, data }) => {
      const s = data.spells.spells[ab.id];
      if (!s) err(`${where} casts unknown spell "${ab.id}" — check data/spells.json.`);
      if (!['damage', 'afflict'].includes(s.type)) err(`${where} casts "${ab.id}" (a ${s.type} spell) — monsters cast only damage and afflict spells for now.`);
    },
    viable: (b, c, ab) => {
      const s = b.game.data.spells.spells[ab.id];
      if (!s) return false;
      if (s.type === 'afflict' && !(s.area === 'all')) return b.heroesInReach(c, s.range ?? 6).some(h => notAfflicted(h, s.condition.id));
      if (s.area === 'all') return b.heroes().some(h => h.ref.alive && !h.ref.hidden);
      return !!b.abilityTarget(c, { range: s.range ?? 6 });
    },
    act: (b, c, ab) => b.monsterCastSpell(c, ab),
  },
  vanish: {
    // Pointless if already unseen; impossible while a Piercing Sight /
    // Light of Truth burns or a seer's eye is on the field.
    viable: (b, c) => !c.unseen && !b.seersEye(),
    act: (b, c, ab) => b.monsterVanish(c, ab),
  },
  summon: {
    validate: (ab, { err, where, id, monsterIds }) => {
      if (!Array.isArray(ab.monsters) || !ab.monsters.length) err(`${where} needs monsters: [{id, count}] — what it conjures.`);
      for (const e of ab.monsters) {
        if (!monsterIds.includes(e.id)) err(`${where} summons unknown monster "${e.id}". Valid: ${monsterIds.join(', ')}.`);
        if (e.id === id) err(`${where} summons itself — that way lies an endless court.`);
        if (e.count !== undefined && !isDiceOrInt(e.count)) err(`${where} count ${JSON.stringify(e.count)} — a whole number or dice like "1d2".`);
      }
      if (ab.max_allies !== undefined && (!Number.isInteger(ab.max_allies) || ab.max_allies < 1)) err(`${where} max_allies ${JSON.stringify(ab.max_allies)} — how many living allies it tolerates before it stops summoning (a whole number, 1+).`);
    },
    // A summoner holds its hand while its court is still standing.
    viable: (b, c, ab) => b.monsters().filter(mc => mc !== c).length < (ab.max_allies ?? 4),
    act: (b, c, ab) => b.monsterSummon(c, ab),
  },
  blink: {
    validate: (ab, { err, where }) => { if (ab.when_within !== undefined && (!Number.isInteger(ab.when_within) || ab.when_within < 0)) err(`${where} when_within ${JSON.stringify(ab.when_within)} — blink when a hero is this close (a whole number).`); },
    // Blinking away only matters with a hero close (when_within, default 1).
    viable: (b, c, ab) => b.heroes().some(h => h.ref.alive && !h.ref.hidden && b.dist(h.x, h.y, c.x, c.y) <= (ab.when_within ?? 1)) && !!b.farthestOpen(c),
    act: (b, c, ab) => b.monsterBlink(c, ab),
  },
};

export const ABILITY_TYPES = Object.keys(MONSTER_ABILITIES);
