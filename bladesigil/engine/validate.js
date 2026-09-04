// The shared validation vocabulary (refactor step 1, 2026-09-03).
// Every boot-time validator used to carry its own copy of these lists and
// its own dice regex — three grammars had drifted apart. This file is the
// ONE place they live; the validators in game.js / magic.js / progression.js
// / dungeon.js import from here and keep their friendly messages verbatim.

export const ELEMENTS = ['fire', 'frost', 'lightning', 'poison'];
export const FAMILIES = ['undead', 'outsider', 'beast', 'vermin', 'humanoid', 'construct', 'ooze', 'aberration', 'dragon', 'elemental'];
export const ABILITIES = ['str', 'int', 'wis', 'dex', 'con', 'cha'];
export const SAVES = ABILITIES; // a save is always rolled on an ability
export const KINDS = ['edged', 'piercing', 'blunt']; // physical damage kinds

// THE dice grammar: "NdN", "NdN+N", "NdN-N", or a bare whole number (a flat
// amount — items.json's "+1 fire" blades use it). rules.js roll()/maxRoll()
// accept exactly this, so anything that validates here also rolls.
const DICE_RE = /^\d+d\d+([+-]\d+)?$|^\d+$/;
export const isDice = v => typeof v === 'string' && DICE_RE.test(v.trim());
// Dice or an actual number (summon counts, item stacks).
export const isDiceOrInt = v => (Number.isInteger(v) && v >= 1) || isDice(String(v));

export const isInt = (v, min = 0) => Number.isInteger(v) && v >= min;
export const isLevel = v => Number.isInteger(v) && v >= 1 && v <= 20;

// Data-file id lists with the designer's "_comment"-style keys filtered out.
const ids = obj => Object.keys(obj ?? {}).filter(k => !k.startsWith('_'));
export const conditionIds = data => ids(data.conditions.conditions);
export const monsterIds = data => ids(data.monsters.monsters);
export const spellIds = data => ids(data.spells.spells);
export const itemIds = data => ids(data.items.items);
export const classIds = data => ids(data.classes.classes);
