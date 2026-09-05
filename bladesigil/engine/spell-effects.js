// The spell-effect registry (refactor step 5d, 2026-09-04). One entry per
// spells.json "type" — how it aims, whether Overcast may swell it, its
// voice and its default look, the friendly crosshair's first candidates,
// what makes a target legal, and the resolver on the Battle that plays it
// out. Adding an effect type = one entry plus its resolver. Every
// per-type `if` in battle.js used to be its own copy of this table.
//
//   friendly     — aims at allies (the crosshair starts on a friend)
//   overcast     — the Sorcerer's Overcast may swell it
//   soundFirst(s)— a voice that beats even spells.json fx.sound (the L5 miracle)
//   sound        — the type's voice when the spell names none
//   fx(s)        — default look when the spell has no "fx"
//   candidates(b, s, alive) — friendly targets worth offering first (null = the wounded)
//   legal(b, c, s, x, y)    — may it land on this square?
//   resolve(b, c, s, x, y, m, impact)

import { COLOR } from './constants.js';

const heroAt = (b, c, s, x, y) => s.targets === 'allies' || s.targets === 'self' || !!b.friendAt(x, y); // a hero — or a creature the party called
const foeAt = (b, c, s, x, y) => {
  const aimed = s.area === 'all' || (c.ref.maelstromArmed && s.type === 'damage' && typeof s.scroll !== 'string');
  return aimed || s.area > 0 || !!b.monsterAt(x, y);
};

export const SPELL_EFFECTS = {
  damage: {
    overcast: true,
    fx: s => s.area ? { kind: 'bolt', color: '#ff9a3a', burst: 'fire' } : { kind: 'bolt', color: '#ffb04a' },
    legal: foeAt,
    resolve: (b, c, s, x, y, m, impact) => b.resolveDamage(c, s, x, y, m, impact),
  },
  heal: {
    friendly: true,
    overcast: true,
    // Designer rule (2026-08-26): level-5 healing is a MIRACLE and sounds like one.
    soundFirst: s => (s.level >= 5 ? 'spell_heal_major' : null),
    sound: 'spell_heal',
    fx: () => ({ kind: 'sparkle', color: COLOR.green }),
    legal: heroAt,
    resolve: (b, c, s, x, y, m, impact) => b.resolveHeal(c, s, x, y, m, impact),
  },
  buff: {
    friendly: true,
    sound: 'spell_buff',
    fx: () => ({ kind: 'sparkle', color: COLOR.amber }),
    candidates: (b, s, alive) => alive.filter(h => h !== b.active()),
    legal: (b, c, s, x, y) => s.targets !== 'ally' || heroAt(b, c, s, x, y),
    resolve: (b, c, s, x, y, m) => b.resolveBuff(c, s, x, y, m),
  },
  afflict: {
    fx: () => ({ kind: 'wisp', color: COLOR.shadow }),
    legal: foeAt,
    resolve: (b, c, s, x, y, m, impact) => b.resolveAfflict(c, s, x, y, m, impact),
  },
  cure: {
    friendly: true,
    candidates: (b, s, alive) => alive.filter(h => h.ref.conditions.some(cd => s.cures === 'all' || s.cures?.includes(cd.id))),
    legal: heroAt,
    resolve: (b, c, s, x, y, m, impact) => b.resolveCure(c, s, x, y, m, impact),
  },
  raise: {
    friendly: true,
    candidates: b => b.heroes().filter(h => !h.ref.alive), // the fallen, always
    legal: (b, c, s, x, y) => !!b.heroes().find(h => !h.ref.alive && h.x === x && h.y === y),
    resolve: (b, c, s, x, y, m, impact) => b.resolveRaise(c, s, x, y, m, impact),
  },
};

export const SPELL_TYPES = Object.keys(SPELL_EFFECTS);
