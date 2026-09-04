// Game state and rules: party building, level parsing, movement, combat, monster AI.

import { roll, d20, abilityMod } from './rules.js';
import { DataError } from './loader.js';
import { Battle } from './battle.js';
import { generateFloor } from './dungeon.js';
import { laneOf, passiveOf, classProg, pendingChoices, focusOptions, displayClass, riteTier, TRACKED_STATS, hasRefinement, groupOfType, focusGroupOf, focusList, focusName, abilityPicksAllowed, growthPicksAllowed, growthEffect, growthNamed, growthPicks } from './progression.js';
import { maxSpellLevel, spellPointsFor, spellCost, magicModel, refreshSpellbook, autoPrepare, castableSpells, knownSpells, preparedSlots, studiesGrantedBy, autoStudy, scrollReadable, revelationsAt, spellSchool, laneSpellsAt, laneSpells, giftOf, heroMaxSpellLevel, spellBuff, activeStances, FAMILIES } from './magic.js';
import { autosave as autosaveRun } from './save.js';
import * as audio from './audio.js';

// "a, b and c" — for lists spoken in the log.
function listWords(words) {
  return words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

// Itemization v2: friendly boot-time validation for the new item fields.
export function validateItems(data) {
  const ABILITIES = ['str', 'int', 'wis', 'dex', 'con', 'cha'];
  const EFFECTS = ['heal', 'cure', 'mana', 'invisibility'];
  const ELEMENTS = ['fire', 'frost', 'lightning', 'poison'];
  const FAMILIES = ['undead', 'outsider', 'beast', 'vermin', 'humanoid', 'construct', 'ooze', 'aberration', 'dragon', 'elemental'];
  for (const [id, d] of Object.entries(data.items.items)) {
    if (d.tier !== undefined && ![1, 2, 3, 4, 5].includes(d.tier)) {
      throw new DataError('data/items.json', `"${id}" has tier ${JSON.stringify(d.tier)} — tiers run 1 (regular) to 5 (unique).`);
    }
    if (d.effect && d.type === 'consumable' && !EFFECTS.includes(d.effect)) {
      throw new DataError('data/items.json', `"${id}" has effect "${d.effect}". Valid potion effects: ${EFFECTS.join(', ')}.`);
    }
    for (const c of d.immune ?? []) {
      if (!data.conditions.conditions[c] && !ELEMENTS.includes(c)) {
        throw new DataError('data/items.json', `"${id}" grants immunity to "${c}" — use a condition (${Object.keys(data.conditions.conditions).join(', ')}) or an element (${ELEMENTS.join(', ')}).`);
      }
    }
    for (const e of d.resist ?? []) {
      if (!ELEMENTS.includes(e)) {
        throw new DataError('data/items.json', `"${id}" resists "${e}". Valid elements: ${ELEMENTS.join(', ')}.`);
      }
    }
    if (d.bonus_damage && (!/^\d+(d\d+([+-]\d+)?)?$/.test(d.bonus_damage.dice ?? '') || !ELEMENTS.includes(d.bonus_damage.element))) {
      throw new DataError('data/items.json', `"${id}" bonus_damage needs {dice, element}: dice like "1d6" (or a flat "1"), element from: ${ELEMENTS.join(', ')}.`);
    }
    if (d.double_vs && !FAMILIES.includes(d.double_vs)) {
      throw new DataError('data/items.json', `"${id}" doubles vs "${d.double_vs}". Valid monster families: ${FAMILIES.join(', ')}.`);
    }
    for (const ab of Object.keys(d.abilities ?? {})) {
      if (!ABILITIES.includes(ab)) {
        throw new DataError('data/items.json', `"${id}" boosts ability "${ab}". Valid: ${ABILITIES.join(', ')}.`);
      }
    }
  }
}

// The bestiary's rules (special-abilities pass, 2026-09-01): family/element
// tags, the passive danger fields (attacks, regen, drains, death_burst,
// resist_physical, touch, bonus_damage, splash), and the active "abilities"
// list — every mistake named with its valid options.
export function validateMonsters(data) {
  const ELEMENTS = ['fire', 'frost', 'lightning', 'poison'];
  const FAMILIES = ['undead', 'outsider', 'beast', 'vermin', 'humanoid', 'construct', 'ooze', 'aberration', 'dragon', 'elemental'];
  const KINDS = ['edged', 'piercing', 'blunt'];
  const ABILITY_TYPES = ['bolt', 'breath', 'afflict', 'haste', 'spell', 'vanish', 'summon', 'blink'];
  const SAVES = ['str', 'int', 'wis', 'dex', 'con', 'cha'];
  const DICE = /^\d+d\d+([+-]\d+)?$/;
  const conditionIds = Object.keys(data.conditions.conditions).filter(k => !k.startsWith('_'));
  const err = (id, msg) => { throw new DataError('data/monsters.json', `"${id}" ${msg}`); };
  for (const [id, m] of Object.entries(data.monsters.monsters)) {
    if (id.startsWith('_')) continue;
    if (m.family && !FAMILIES.includes(m.family)) err(id, `has family "${m.family}". Valid: ${FAMILIES.join(', ')}.`);
    if (m.element && !ELEMENTS.includes(m.element)) err(id, `attacks with element "${m.element}". Valid: ${ELEMENTS.join(', ')}.`);
    if (m.attacks !== undefined && (!Number.isInteger(m.attacks) || m.attacks < 1)) err(id, `has attacks ${JSON.stringify(m.attacks)} — a whole number of swings per turn, 1 or more.`);
    if (m.hidden !== undefined && typeof m.hidden !== 'boolean') err(id, `has hidden ${JSON.stringify(m.hidden)} — use true (it begins every fight unseen) or leave it out.`);
    if (m.inflicts && !conditionIds.includes(m.inflicts.condition)) err(id, `inflicts "${m.inflicts.condition}". Valid conditions: ${conditionIds.join(', ')}.`);
    for (const k of m.resist_physical ?? []) {
      if (!KINDS.includes(k)) err(id, `resists physical "${k}". Valid: ${KINDS.join(', ')}.`);
    }
    if (m.regen && (!Number.isInteger(m.regen.amount) || m.regen.amount < 1)) err(id, `regen needs {amount: N} — whole HP per turn.`);
    for (const e of m.regen?.blocked_by ?? []) {
      if (!ELEMENTS.includes(e)) err(id, `regen is blocked_by "${e}". Valid elements: ${ELEMENTS.join(', ')}.`);
    }
    if (m.drains) {
      const a = m.drains.amount;
      if (a !== 'level' && a !== 'damage' && !DICE.test(a ?? '')) err(id, `drains amount ${JSON.stringify(a)} — use dice ("1d4"), "level" (a level's worth of HP), or "damage" (what the blow dealt).`);
    }
    if (m.bonus_damage && (!DICE.test(m.bonus_damage.dice ?? '') || !ELEMENTS.includes(m.bonus_damage.element))) err(id, `bonus_damage needs {dice, element} — dice like "2d6", element from: ${ELEMENTS.join(', ')}.`);
    if (m.splash && (!DICE.test(m.splash.dice ?? '') || !ELEMENTS.includes(m.splash.element))) err(id, `splash needs {dice, element} — dice like "1d6", element from: ${ELEMENTS.join(', ')}.`);
    if (m.death_burst && (!DICE.test(m.death_burst.dice ?? '') || (m.death_burst.element && !ELEMENTS.includes(m.death_burst.element)))) err(id, `death_burst needs {dice, element?, area?, save?, dc?} — dice like "3d6", element from: ${ELEMENTS.join(', ')}.`);
    if (m.fear_aura && (!Number.isInteger(m.fear_aura.dc) || !Number.isInteger(m.fear_aura.rounds) || m.fear_aura.rounds < 1)) err(id, `fear_aura needs {dc: N, rounds: N} — a WIS save DC to close with or stand beside it, and how long the fright lasts.`);
    const monsterIds = Object.keys(data.monsters.monsters).filter(k => !k.startsWith('_'));
    const checkAbility = (ab, i, prefix = '') => {
      const where = `${prefix}ability ${i + 1}${ab.name ? ` (${ab.name})` : ''}`;
      if (ab.line !== undefined && typeof ab.line !== 'string') err(id, `${where} has a line that is not text — "line" is what the monster says when it uses this.`);
      if (ab.type === 'summon') {
        if (!Array.isArray(ab.monsters) || !ab.monsters.length) err(id, `${where} needs monsters: [{id, count}] — what it conjures.`);
        for (const e of ab.monsters) {
          if (!monsterIds.includes(e.id)) err(id, `${where} summons unknown monster "${e.id}". Valid: ${monsterIds.join(', ')}.`);
          if (e.id === id) err(id, `${where} summons itself — that way lies an endless court.`);
          if (e.count !== undefined && !(Number.isInteger(e.count) && e.count >= 1) && !DICE.test(String(e.count))) err(id, `${where} count ${JSON.stringify(e.count)} — a whole number or dice like "1d2".`);
        }
        if (ab.max_allies !== undefined && (!Number.isInteger(ab.max_allies) || ab.max_allies < 1)) err(id, `${where} max_allies ${JSON.stringify(ab.max_allies)} — how many living allies it tolerates before it stops summoning (a whole number, 1+).`);
      }
      if (ab.type === 'blink' && ab.when_within !== undefined && (!Number.isInteger(ab.when_within) || ab.when_within < 0)) err(id, `${where} when_within ${JSON.stringify(ab.when_within)} — blink when a hero is this close (a whole number).`);
      if (!ABILITY_TYPES.includes(ab.type)) err(id, `${where} has type "${ab.type}". Valid: ${ABILITY_TYPES.join(', ')}.`);
      if (ab.save && !SAVES.includes(ab.save)) err(id, `${where} saves with "${ab.save}". Valid: ${SAVES.join(', ')}.`);
      if ((ab.type === 'bolt' || ab.type === 'breath') && !DICE.test(ab.dice ?? '')) err(id, `${where} needs dice like "3d6".`);
      if (ab.type === 'afflict') {
        if (!conditionIds.includes(ab.condition)) err(id, `${where} inflicts "${ab.condition}". Valid conditions: ${conditionIds.join(', ')}.`);
        if (ab.targets && ab.targets !== 'party') err(id, `${where} targets "${ab.targets}" — an afflict aims at one hero unless targets is "party".`);
      }
      if (ab.type === 'haste' && ab.targets && !['self', 'allies'].includes(ab.targets)) err(id, `${where} targets "${ab.targets}". A haste targets "self" or "allies".`);
      if (ab.type === 'spell') {
        const s = data.spells.spells[ab.id];
        if (!s) err(id, `${where} casts unknown spell "${ab.id}" — check data/spells.json.`);
        if (!['damage', 'afflict'].includes(s.type)) err(id, `${where} casts "${ab.id}" (a ${s.type} spell) — monsters cast only damage and afflict spells for now.`);
      }
      if (ab.element && !ELEMENTS.includes(ab.element)) err(id, `${where} uses element "${ab.element}". Valid: ${ELEMENTS.join(', ')}.`);
      for (const [k, v] of Object.entries({ range: ab.range, area: ab.area, cooldown: ab.cooldown, uses: ab.uses, rounds: ab.rounds })) {
        if (v !== undefined && (!Number.isInteger(v) || v < 0)) err(id, `${where} has ${k} ${JSON.stringify(v)} — a whole number.`);
      }
    };
    (m.abilities ?? []).forEach((ab, i) => checkAbility(ab, i));
    if (m.intro !== undefined && typeof m.intro !== 'string') err(id, `has an intro that is not text — "intro" is the line it speaks as the battle begins.`);
    // Boss phases: ordered by falling HP fraction, each with its own ability list.
    if (m.phases !== undefined) {
      if (!Array.isArray(m.phases) || !m.phases.length) err(id, `phases must be a list: [{below: 0.6, name, line, abilities: [...]}].`);
      let last = 1;
      m.phases.forEach((ph, i) => {
        const where = `phase ${i + 1}${ph.name ? ` (${ph.name})` : ''}`;
        if (typeof ph.below !== 'number' || ph.below <= 0 || ph.below >= 1) err(id, `${where} needs below: a fraction of max HP between 0 and 1 (0.6 = it begins at 60% health).`);
        if (ph.below >= last) err(id, `${where} has below ${ph.below} — phases must run from high to low (each below smaller than the one before).`);
        last = ph.below;
        if (ph.line !== undefined && typeof ph.line !== 'string') err(id, `${where} has a line that is not text.`);
        if (!Array.isArray(ph.abilities)) err(id, `${where} needs abilities: [...] — what it fights with from then on (an empty list means it only swings).`);
        ph.abilities.forEach((ab, j) => checkAbility(ab, j, `${where} `));
      });
    }
  }
}

const VISION_RADIUS = 6.5;
const MONSTER_AGGRO_RANGE = 7;
const BATTLE_RADIUS = 3; // monsters this close (and visible) join a battle

export class Game {
  constructor(data) {
    this.data = data;
    this.messages = [];
    this.gold = 0;
    this.inventory = {}; // shared party pouch: item id -> count
    this.turn = 0;
    this.over = false;      // party wiped
    this.victory = false;   // reached the stairs
    this.battle = null;     // active tactical battle, or null while exploring
    this.floors = {};       // visited floors keyed by depth — cleared rooms STAY cleared this run
    this.depth = 0;         // current floor number ('boss' on the final floor)
    this.deepest = 0;       // deepest floor REACHED this run — the shop's stock scales with it (economy pass 2026-08-31)
    this.party = data.party.party.map(p => this.buildCharacter(p));
    // Each hero brings their own purse to the pool (data/party.json rule).
    const goldDice = data.party.starting_gold || '4d6+200';
    for (const ch of this.party) this.gold += roll(goldDice);
    this.onBuilding = null; // main.js hooks this to open the shop/inn/temple panels
    this.choiceQueue = [];  // progression choices owed (lane forks etc.) — shown on the map
    this.refreshChoices();  // pre-leveled heroes (party.json test path) owe theirs at once
    this.enterTown(true);   // Novamagus is home: every run starts here
    this.log(`The party pools its purses: ${this.gold} gold.`, 'gold');
    this.refillQuivers(true);
  }

  // ---- Progression choices (v2 lanes) ----
  refreshChoices() {
    this.choiceQueue = this.party.flatMap(ch => pendingChoices(this.data, ch));
  }

  displayClass(ch) { return displayClass(this.data, ch); }
  focusOptions(ch) { return focusOptions(this.data, ch); }

  // ---- Magic v2 (engine/magic.js holds the rules) ----
  castableSpells(ch) { return castableSpells(this.data, ch); }
  spellCost(ch, s) { return spellCost(this.data, ch, s); }

  // A full night's rest: once-per-rest powers return, and Prepared Mind's
  // re-pick window opens (it closes again when the next battle begins).
  // An AMBUSHED camp grants neither — the night was never finished.
  afterFullRest() {
    for (const ch of this.party) {
      if (!ch.alive) continue;
      ch.spentRest = {};
      // Drained life (the wight's touch) flows back with a full night's
      // sleep — the designer's ruling: dread in the moment, no permanent
      // unfixable loss.
      if (ch.drained > 0) {
        ch.maxHp += ch.drained;
        ch.hp = Math.min(ch.hp + ch.drained, ch.maxHp);
        this.log(`${ch.name}'s drained life returns with the rest — ${ch.drained} maximum HP restored.`, 'good');
        ch.drained = 0;
      }
      // A Stance (v1.1) lasts exactly until this moment: the verse fades
      // with the rest, and the hero sings it anew for its flat cost.
      const held = activeStances(ch);
      if (held.length) {
        ch.timedBuffs = (ch.timedBuffs ?? []).filter(b => !b.stance);
        this.log(`${ch.name}'s ${held.map(b => b.name).join(' & ')} fades with the rest — sing it again from the spellbook (B) for ${held.map(b => this.data.spells.spells[b.spell]?.stance ?? 1).join('/')} SP.`, 'info');
      }
      if (magicModel(this.data, ch) === 'spellbook') {
        ch.prepFresh = true;
        this.log(`${ch.name}'s mind is clear — prepared spells may be re-picked on the character sheet (C) until the next fight.`, 'info');
      }
    }
  }

  // Sing a Stance on the map (v1.1): the half-casters' level-1 verse, cast
  // once after a rest for its flat cost and held until the next one. From
  // the spellbook screen (B); `target` is the hero it lands on (an ally-
  // targeted verse names one, a self verse ignores it). Costs one map turn,
  // like a potion. Returns true if the verse was sung.
  castStance(ch, spellId, target = null) {
    if (this.over || this.victory) return false;
    if (this.battle) { this.log('In battle a verse is sung from the C menu.', 'info'); return false; }
    const s = { id: spellId, ...this.data.spells.spells[spellId] };
    if (!s.stance) { this.log(`${s.name ?? spellId} is not a Stance — it is sung in battle only.`, 'info'); return false; }
    if (!ch.alive) { this.log(`${ch.name} cannot sing — they have fallen.`, 'info'); return false; }
    if (!castableSpells(this.data, ch).some(k => k.id === spellId)) { this.log(`${ch.name} does not know ${s.name}.`, 'info'); return false; }
    const cost = spellCost(this.data, ch, s);
    if (ch.sp < cost) { this.log(`${s.name} costs ${cost} SP — ${ch.name} has ${ch.sp}. Rest, or drink a mana potion.`, 'info'); return false; }
    const who = s.targets === 'ally' ? target : ch;
    if (!who || !who.alive) { this.log(`${s.name} needs a living ally to settle on.`, 'info'); return false; }
    if (activeStances(who).some(b => b.spell === spellId)) { this.log(`${s.name} already holds on ${who.name} — it lasts until the next full rest.`, 'info'); return false; }
    ch.sp -= cost;
    who.timedBuffs = (who.timedBuffs ?? []).filter(b => b.name !== s.name);
    who.timedBuffs.push(spellBuff(s));
    if (who !== ch && laneOf(this.data, ch)?.rite?.tracked === 'alliesFortified') ch.counters.alliesFortified++;
    audio.play(s.fx?.sound ? `spell_${s.fx.sound}` : 'spell_buff'); // the same element rule as battle.js spellSound
    const bits = [];
    if (s.hit) bits.push(`${s.hit > 0 ? '+' : ''}${s.hit} hit`);
    if (s.dmg) bits.push(`${s.dmg > 0 ? '+' : ''}${s.dmg} damage`);
    if (s.ac) bits.push(`${s.ac > 0 ? '+' : ''}${s.ac} AC`);
    if (s.saves) bits.push(`${s.saves > 0 ? '+' : ''}${s.saves} saves`);
    this.log(`${ch.name} sings ${s.name}${who !== ch ? ` over ${who.name}` : ''} (−${cost} SP): ${bits.join(', ')} — a Stance, held until the next full rest.`, 'good');
    this.advanceTime(1);
    return true;
  }

  // Copy a scroll into a Wizard-lane hero's spellbook. The scroll burns.
  copyScroll(id, ch) {
    const def = this.itemDef(id);
    if (!def || def.type !== 'scroll' || !(this.inventory[id] > 0)) return false;
    const spell = this.data.spells.spells[def.spell];
    if (!spell) {
      this.log(`${def.name} names a spell ("${def.spell}") that isn't in spells.json — nothing to copy.`, 'info');
      return false;
    }
    if (!ch.alive) { this.log(`${ch.name} is beyond study.`, 'info'); return false; }
    if (magicModel(this.data, ch) !== 'spellbook') {
      this.log(`Only a spellbook can hold a scroll's lore — and ${ch.name} keeps none. (A Wizard's book copies scrolls; an arcane caster may still read one in battle; anyone can sell them.)`, 'info');
      return false;
    }
    if (ch.spellbook.includes(def.spell)) {
      this.log(`${spell.name} is already inked in ${ch.name}'s book.`, 'info');
      return false;
    }
    if (spellSchool(spell) !== 'arcane') {
      this.log(`A prayer-scroll takes no ink — ${spell.name} can only be voiced, once, by a divine caster.`, 'info');
      return false;
    }
    this.inventory[id]--;
    ch.spellbook.push(def.spell);
    audio.play('spell_arcane');
    if (ch.prepared.length < preparedSlots(this.data, ch) && spell.level <= maxSpellLevel(ch.level)) ch.prepared.push(def.spell); // the new page takes a free slot — nothing else is touched
    this.log(`${ch.name} copies ${spell.name} into the spellbook — the scroll crumbles as the ink takes.${spell.level > maxSpellLevel(ch.level) ? ` (A level-${spell.level} spell: castable at character level ${[0, 1, 4, 8, 12, 16][spell.level]}.)` : ' Prepare it at any rest.'}`, 'good');
    return true;
  }

  // The player walked a path (or picked a focus). Hard lock — no take-backs.
  applyChoice(choice, value) {
    const ch = choice.ch;
    if (choice.type === 'lane') {
      ch.lane = value;
      const lane = laneOf(this.data, ch);
      this.log(`${ch.name} walks ${/^the /i.test(lane.name) ? lane.name : `the ${lane.name}`}. There is no turning back.`, 'good');
      // A caster lane opens its magic on the spot: the Wizard's book fills
      // with every spell of their training; the Sorcerer will pick theirs.
      const model = magicModel(this.data, ch);
      if (model === 'spellbook') {
        refreshSpellbook(this.data, ch);
        this.log(`${ch.name} keeps the book — ${ch.spellbook.length} spells inked, ${preparedSlots(this.data, ch)} prepared at a time (re-pick at any rest), and every scroll found is a page to be.`, 'good');
      } else if (model === 'lane') {
        // The half-casters' fixed list: the lane's verses open as their levels do.
        const list = laneSpells(this.data, ch);
        const names = list.filter(sp => sp.level <= maxSpellLevel(ch.level)).map(sp => sp.name);
        this.log(`${ch.name}'s ${lane.name} opens its verses: ${names.join(', ')} — the rest arrive as each spell level does.`, 'good');
        // v1.1: a Stance the lane does not sing is swapped for the lane's
        // own, free — the fork just replaces it (the doc's ruling).
        const replacement = list.find(sp => sp.stance) ?? null;
        for (const b of activeStances(ch)) {
          if (list.some(sp => sp.id === b.spell)) continue;
          ch.timedBuffs = ch.timedBuffs.filter(x => x !== b);
          if (replacement) {
            ch.timedBuffs.push(spellBuff(replacement));
            this.log(`${b.name} is exchanged for ${replacement.name} at no cost — the lane's own verse, held until the next rest.`, 'good');
          } else {
            this.log(`${b.name} falls silent — ${lane.name} does not sing it.`, 'info');
          }
        }
      } else if (model === 'known') {
        // The Raw Gift: the book is set aside. Its pages may still be
        // chosen as bloodline (spellPicksOwed offers the former book).
        ch.formerBook = [...(ch.spellbook ?? [])];
        ch.spellbook = [];
        ch.prepared = [];
        ch.studyOwed = 0;
        ch.prepFresh = false;
        this.log(`${ch.name} closes the spellbook for the last time — the magic runs in the blood now: fewer spells, deeper wells. Choose them (the old pages may be chosen too).`, 'good');
      }
    } else if (choice.type === 'favored') {
      // Favored Enemy: a new family at +1, or a known one deepened (capped).
      ch.favored ??= {};
      ch.favored[value] = Math.min(ch.cls.favored_enemy?.cap ?? 3, (ch.favored[value] ?? 0) + 1);
      ch.favoredPicks = (ch.favoredPicks ?? 0) + 1;
      this.log(`${ch.name} knows the ${value} now — favored enemy, +${ch.favored[value]} to hit and damage against them.`, 'good');
    } else if (choice.type === 'focus') {
      (ch.focusTypes ??= focusList(this.data, ch)).push(value);
      ch.focusType = ch.focusTypes[0]; // the headline oath, for older readers
      const sworn = focusList(this.data, ch);
      this.log(sworn.length === 1
        ? `${ch.name}'s hands know ${focusName(this.data, value).toLowerCase()} now — Weapon Focus (+1 damage with every weapon in the family).`
        : `${ch.name} takes up ${focusName(this.data, value).toLowerCase()} as well — Weapon Focus now covers ${listWords(sworn.map(g => focusName(this.data, g).toLowerCase()))}.`, 'good');
    } else if (choice.type === 'growth') {
      const lane = laneOf(this.data, ch);
      const opt = (lane?.growth?.options ?? []).find(o => o.id === value);
      (ch.growth ??= []).push(value);
      this.refreshDerived(ch);
      this.log(`${ch.name} takes ${opt?.name ?? value} — ${opt?.blurb ?? 'the lane deepens'}`, 'good');
    } else if (choice.type === 'ability') {
      // The level-10 boost: it raises the ROLLED score, so it is permanent
      // and shows as the hero's own, not as something the gear lends.
      const amount = this.data.progression.ability_boost?.amount ?? 1;
      const before = ch.baseAbilities[value];
      ch.baseAbilities[value] = before + amount;
      (ch.abilityBoosts ??= []).push(value); // kept in order so the bench can undo it
      this.refreshDerived(ch);
      const mod = abilityMod(ch.abilities[value]);
      this.log(`${ch.name} grows: ${value.toUpperCase()} ${before} → ${ch.baseAbilities[value]} (modifier ${mod >= 0 ? '+' : ''}${mod}).`, 'good');
    } else if (choice.type === 'spell') {
      // The Sorcerer's pick: one spell, known forever. A wild pick (any
      // level, from bonus_pick_levels) counts against the bonus tally.
      (ch.knownSpells ??= []).push(value);
      if (choice.level === 'any') ch.bonusPicksTaken = (ch.bonusPicksTaken ?? 0) + 1;
      const s = this.data.spells.spells[value];
      this.log(`${ch.name} seizes ${s?.name ?? value} — it is in the blood now, never to be unlearned.`, 'good');
    } else if (choice.type === 'study') {
      // Study (magic v3): a free page into the spellbook.
      (ch.spellbook ??= []).push(value);
      ch.studyOwed = Math.max(0, (ch.studyOwed ?? 0) - 1);
      const s = this.data.spells.spells[value];
      if (ch.prepared.length < preparedSlots(this.data, ch) && (s?.level ?? 9) <= maxSpellLevel(ch.level)) ch.prepared.push(value); // the new page takes a free slot — nothing else is touched
      this.log(`${ch.name} studies ${s?.name ?? value} — a new page in the spellbook.${ch.prepared.includes(value) ? ' It is prepared.' : ' Prepare it at any rest.'}`, 'good');
    }
    audio.play('leveling');
    this.refreshDerived(ch); // lane offsets land immediately
    this.refreshChoices();   // a lane pick may owe a follow-up (weapon focus)
  }

  // The Level 20 Rite concludes (ui.js ran the four-step ceremony).
  // result: {abilityName, sigil: {shape, modifier, color}, title}
  applyRite(ch, result) {
    const lane = laneOf(this.data, ch);
    const rite = lane?.rite;
    if (!rite || ch.rite) return;
    const tier = riteTier(this.data, ch);
    ch.rite = { ...result, tier };
    audio.play('rite');
    this.log(`The Rite is complete. ${ch.name} ${ch.rite.title} bears the sigil of the ${result.sigil.modifier} ${result.sigil.shape}, wrought in ${result.sigil.color.toLowerCase()}.`, 'good');
    this.log(`${result.abilityName} is theirs alone now — no other living soul commands it. (C in battle)`, 'good');
    const tierDef = rite.tiers[tier];
    if (tierDef.trinket) {
      this.addItem(tierDef.trinket);
      this.log(`The Rite leaves a gift: ${this.itemDef(tierDef.trinket).name} (in the party pouch).`, 'gold');
    }
    if (tierDef.dungeon) {
      ch.rite.dungeonUnlocked = true;
      this.log(`Legends of ${ch.name} ${ch.rite.title} spread. Somewhere, a door has opened: ${tierDef.dungeon.toLowerCase()}. (Its floor arrives in a coming build.)`, 'gold');
    }
    this.refreshChoices();
  }

  // ---- Marching order (O): reorder the party, flip front/back rows ----
  // Never mid-battle (placement is already decided). Edits the party def
  // that built the run and re-saves it when a saved party exists, so the
  // order survives a refresh; the premade party keeps its order for the run.
  moveHero(idx, dir) {
    if (this.battle) return false;
    const j = idx + dir;
    if (idx < 0 || j < 0 || idx >= this.party.length || j >= this.party.length) return false;
    [this.party[idx], this.party[j]] = [this.party[j], this.party[idx]];
    if (this.partyDef) [this.partyDef[idx], this.partyDef[j]] = [this.partyDef[j], this.partyDef[idx]];
    this.saveMarchingOrder();
    return true;
  }

  setRow(ch, row) {
    if (this.battle || !['front', 'back'].includes(row) || ch.row === row) return false;
    ch.row = row;
    const def = this.partyDef?.[this.party.indexOf(ch)];
    if (def) def.row = row;
    this.saveMarchingOrder();
    this.log(`${ch.name} takes the ${row} row.`, 'info');
    return true;
  }

  saveMarchingOrder() {
    if (!this.partyDef) return;
    try {
      if (localStorage.getItem('bs_party')) localStorage.setItem('bs_party', JSON.stringify(this.partyDef));
    } catch { /* private mode: the order lasts the run */ }
  }

  // ---- Novamagus (Phase 4): the home base between dungeon dives ----
  enterTown(first = false) {
    const t = this.data.town;
    const rows = t.map;
    const w = rows[0].length;
    if (!rows.every(r => r.length === w)) {
      throw new DataError('data/town.json', `Town map rows must all be the same length (row 1 is ${w} characters).`);
    }
    this.mode = 'town';
    this.level = { name: t.name, w, h: rows.length };
    this.grid = rows.map(r => r.split(''));
    this.monsters = [];
    this.partyPos = null;
    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < w; x++) {
        const c = this.grid[y][x];
        if (c === '@') { this.partyPos = { x, y }; this.grid[y][x] = '.'; }
        else if (!'.vistd'.includes(c)) {
          throw new DataError('data/town.json', `Unknown town map symbol "${c}" at row ${y + 1}, column ${x + 1}. Use . v @ i s t d.`);
        }
      }
    }
    if (!this.partyPos) throw new DataError('data/town.json', 'No "@" (party position) found on the town map.');
    this.log(first
      ? `Welcome to ${t.name}. The inn is warm, the shop is stocked, and the dungeon waits below.`
      : `You emerge into the daylight of ${t.name}.`, 'info');
  }

  enterDungeon() {
    this.enterFloor(1, 'down');
  }

  // ---- Multi-floor dungeon (Phase 5) ----
  // Floor 1 is the hand-made level; everything deeper is generated from
  // data/dungeon.json's tier tables. Visited floors are cached for the whole
  // run — kill a monster or loot a chest and it STAYS dead/empty, even
  // after a trip to town (no more chest farming).
  saveFloor() {
    if (this.mode !== 'dungeon') return;
    this.floors[this.depth] = {
      level: this.level, grid: this.grid, monsters: this.monsters,
      seen: this.seen, traps: this.traps, chestTraps: this.chestTraps,
      revealed: this.revealed,
    };
  }

  stairsAt(ch) {
    for (let y = 0; y < this.level.h; y++) {
      const x = this.grid[y].indexOf(ch);
      if (x !== -1) return { x, y };
    }
    return null;
  }

  allAtPinnacle() { return this.party.every(ch => ch.level >= 20); }

  enterFloor(depth, dir) {
    this.saveFloor();
    // Generate the new floor BEFORE committing to it: if the tier's data is
    // bad, the error must not leave the depth counter pointing at a floor we
    // never reached (the bug that once "descended" from 4 straight to 9).
    const cached = this.floors[depth];
    const fresh = cached ? null
      : depth === 'boss' ? this.data.dungeon.boss
      : depth === 1 ? this.data.level
      : generateFloor(this.data, depth);
    this.mode = 'dungeon';
    this.depth = depth;
    this.deepest = Math.max(this.deepest ?? 0, typeof depth === 'number' ? depth : 20);
    if (cached) {
      this.level = cached.level;
      this.grid = cached.grid;
      this.monsters = cached.monsters;
      this.seen = cached.seen;
      this.traps = cached.traps;
      this.chestTraps = cached.chestTraps || [];
      this.revealed = cached.revealed;
      // Arriving from above, you stand on the up-stairs; from below, the down-stairs.
      this.partyPos = (dir === 'down' ? this.stairsAt('<') : this.stairsAt('>')) || this.partyPos;
      this.updateVision();
    } else {
      this.loadLevel(fresh);
    }
    this.log(depth === 'boss'
      ? `The stairs twist into darkness no map has charted. This is ${this.level.name}.`
      : dir === 'down'
        ? `The party descends to ${this.level.name}...`
        : `The party climbs back up to ${this.level.name}.`, 'info');
    this.searchNearby();
  }

  townMove(dx, dy) {
    const nx = this.partyPos.x + dx, ny = this.partyPos.y + dy;
    const cell = this.grid[ny]?.[nx];
    if (cell === undefined || cell === 'v') return; // hedges block the way
    if (cell === 'd') { this.enterDungeon(); return; }
    const building = { i: 'inn', s: 'shop', t: 'temple' }[cell];
    if (building) { this.onBuilding?.(building); return; }
    this.partyPos = { x: nx, y: ny }; // town time stands still — no turns pass
  }

  // Building services. Each returns true if the transaction happened.
  innRest() {
    const price = this.data.town.inn.price;
    if (this.gold < price) { this.log(`A night at the inn costs ${price} gold — the party cannot pay.`, 'info'); return false; }
    this.gold -= price;
    this.refillQuivers();
    for (const ch of this.party) {
      if (!ch.alive) continue;
      ch.hp = ch.maxHp;
      ch.sp = ch.maxSp;
    }
    audio.play('inn');
    this.log(`The party sleeps soundly at the inn. Wounds mend and spirits return. (−${price} gold)`, 'good');
    this.afterFullRest();
    return true;
  }

  templeRevive(ch) {
    const price = this.data.town.temple.price;
    if (ch.alive) return false;
    if (this.gold < price) { this.log(`The offering is ${price} gold — the party cannot pay.`, 'info'); return false; }
    this.gold -= price;
    ch.alive = true;
    if (ch.drained > 0) { ch.maxHp += ch.drained; ch.drained = 0; } // the altar restores what the undead drank
    ch.hp = ch.maxHp;
    ch.sp = ch.maxSp;
    ch.conditions = [];
    ch.timedBuffs = []; // a Stance died with them
    audio.play('temple_revive');
    this.log(`Light floods the altar — ${ch.name} draws breath once more! (−${price} gold)`, 'good');
    return true;
  }

  // The shop's stock scales with the party's deeds: an entry may be
  // {"id", "at_depth": N} in town.json — locked until depth N is reached.
  shopStockEntries() {
    return (this.data.town.shop.stock ?? []).map(e => typeof e === 'string' ? { id: e, at_depth: 0 } : e);
  }

  shopBuy(id) {
    const def = this.itemDef(id);
    if (!def) return false;
    const entry = this.shopStockEntries().find(e => e.id === id);
    if (entry && (entry.at_depth ?? 0) > (this.deepest ?? 0)) {
      this.log(`The shopkeep shakes their head — the ${def.name.toLowerCase()} is for delvers who have seen depth ${entry.at_depth}.`, 'info');
      return false;
    }
    if (def.max_carry && (this.inventory[id] || 0) >= def.max_carry) {
      this.log(`The party can only carry ${def.max_carry} ${def.name.toLowerCase()}.`, 'info');
      return false;
    }
    const price = def.value ?? 0;
    if (this.gold < price) { this.log(`${def.name} costs ${price} gold — the party cannot pay.`, 'info'); return false; }
    this.gold -= price;
    const got = this.addItem(id, def.bundle ?? 1); // arrows come by the dozen
    audio.play('purchase'); // coins on the counter — the bell is only the door now
    this.log(`Bought ${got > 1 ? `${got} ` : ''}${def.name} for ${price} gold.`, 'gold');
    return true;
  }

  shopSell(id) {
    if (!(this.inventory[id] > 0)) return false;
    const def = this.itemDef(id);
    const price = Math.floor((def.value ?? 0) * (this.data.town.shop.sell_rate ?? 0.5));
    this.inventory[id]--;
    this.gold += price;
    audio.play('purchase'); // coins change hands either direction
    this.log(`Sold ${def.name} for ${price} gold.`, 'gold');
    return true;
  }

  // A hero's face and figure: their chosen appearance variant, falling back
  // to the class art (premade parties, Quick Start, pre-appearance saves).
  heroSprite(ch) { return ch.look?.sprite || ch.cls.sprite; }
  heroPortrait(ch) { return ch.look?.portrait || ch.cls.portrait || this.heroSprite(ch); }

  // ---- Character building (design doc rules) ----
  // A hero's appearance: creation saves the full {sprite, portrait} object,
  // while party.json may say just "look": "m1" (m1/m2/f1/f2) — the friendly
  // form, expanded to the generated-art paths here.
  // The level-1 gift a class offers at creation (classes.json
  // creation_pick). party.json may name it as "gift": "stonespeak" or
  // {"id": "ironward", "element": "fire"}; a class with a pick and no gift
  // named simply takes the first option (premade parties, test parties).
  resolveGift(def, cls) {
    const pick = cls.creation_pick;
    if (!pick) return null;
    const raw = def.gift == null ? { id: pick.options[0].id } : typeof def.gift === 'string' ? { id: def.gift } : def.gift;
    const opt = pick.options.find(o => o.id === raw.id);
    if (!opt) throw new DataError('data/party.json', `${def.name}: unknown gift "${raw.id}" for a ${cls.name}. Valid: ${pick.options.map(o => o.id).join(', ')}`);
    const ELEMENTS = ['fire', 'frost', 'lightning', 'poison'];
    if (opt.ac_vs_element !== undefined) {
      const el = raw.element ?? ELEMENTS[0];
      if (!ELEMENTS.includes(el)) throw new DataError('data/party.json', `${def.name}: gift "${opt.id}" needs an "element" from: ${ELEMENTS.join(', ')}`);
      return { id: opt.id, element: el };
    }
    return { id: opt.id };
  }

  // The Ranger's first favored enemy comes from creation ("favored": "undead");
  // a hero built without one takes nothing yet — the pick pops on the map.
  resolveFavored(def, cls) {
    if (!cls.favored_enemy) return {};
    if (!def.favored) return {};
    if (!FAMILIES.includes(def.favored)) throw new DataError('data/party.json', `${def.name}: favored enemy "${def.favored}" — valid families: ${FAMILIES.join(', ')}`);
    return { [def.favored]: 1 };
  }

  resolveLook(def) {
    if (!def.look) return null;
    if (typeof def.look !== 'string') return def.look;
    const variants = ['m1', 'm2', 'f1', 'f2'];
    if (!variants.includes(def.look)) {
      throw new DataError('data/party.json', `${def.name}: unknown look "${def.look}". Valid: ${variants.join(', ')} (or leave it out for the old class art).`);
    }
    return {
      sprite: `assets/heroes/gen/${def.race}_${def.class}_${def.look}.png`,
      portrait: `assets/heroes/gen/${def.race}_${def.class}_${def.look}_face.png`,
    };
  }

  buildCharacter(def) {
    const cls = this.data.classes.classes[def.class];
    if (!cls) throw new DataError('data/party.json', `Unknown class "${def.class}" for ${def.name}. Valid: ${Object.keys(this.data.classes.classes).join(', ')}`);
    const race = this.data.races.races[def.race];
    if (!race) throw new DataError('data/party.json', `Unknown race "${def.race}" for ${def.name}. Valid: ${Object.keys(this.data.races.races).join(', ')}`);
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

    const lvlIdx = def.level - 1;
    // The HP rule (designer, 2026-08-22): a hero starts with the MAX of their
    // hit die at level 1; every level after that is rolled, rerolling ones.
    // Heroes built above level 1 (premade parties, bench jumps) simulate
    // those rolls so they match a hero who climbed there.
    const conMod = abilityMod(abilities.con);
    let maxHp = Math.max(1, cls.hp_die + conMod);
    for (let l = 2; l <= def.level; l++) maxHp += this.rollHp(cls, conMod).gain;
    if (!this.data.items.items[cls.starting_weapon]) {
      throw new DataError('data/classes.json', `${cls.name}'s starting_weapon "${cls.starting_weapon}" is not in items.json. Valid: ${Object.keys(this.data.items.items).join(', ')}`);
    }
    const ch = {
      name: def.name,
      race, cls, level: def.level, row: def.row,
      abilities,
      hp: maxHp, maxHp,
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
      look: this.resolveLook(def),
      lane: def.lane ?? null,
      // Weapon families sworn. party.json may say "focus": "blade" or a
      // list; a focus saved under the older rules was a raw weapon type
      // ('med_blade'), which is read as its family ('blade').
      focusTypes: [def.focus ?? []].flat().map(f => this.data.items.focus_groups?.[f] ? f : groupOfType(this.data, f)).filter(Boolean),
      abilityBoosts: [],
      growth: [],
      // The creation gift (half-casters, companion doc v1): {id, element?}
      // from classes.json creation_pick — resolved below.
      gift: this.resolveGift(def, cls),
      bonusAbility: def.bonus_ability ?? (race.floating_bonus ? 'dex' : null),
      // Favored enemies (the Ranger): {family: bonus}; picks made so far.
      favored: this.resolveFavored(def, cls),
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
        const sd = this.data.spells.spells[id];
        if (!sd) throw new DataError('data/party.json', `${def.name}'s "spells" names "${id}", which isn't in spells.json.`);
        if (!sd.classes.includes(def.class)) throw new DataError('data/party.json', `${def.name}'s "spells" names "${id}", which a ${cls.name} cannot cast.`);
      }
      ch.spellbook = [...def.spells];
    }
    if (Object.keys(ch.favored).length) ch.favoredPicks = 1;
    refreshSpellbook(this.data, ch);
    if (magicModel(this.data, ch) === 'spellbook' && def.level > 1) {
      const kit = (cls.spellbook?.starting_spells ?? []).length;
      ch.studyOwed = Math.max(0, studiesGrantedBy(ch) - Math.max(0, ch.spellbook.length - kit));
      autoStudy(this.data, ch);
    }
    this.refreshDerived(ch);
    ch.sp = ch.maxSp;
    return ch;
  }

  // Recompute everything a hero's gear touches: AC, weapon in hand, max SP.
  // Called at creation and after every equip/unequip. Every worn piece may
  // carry 'ac' and/or 'sp' — it all stacks.
  refreshDerived(ch) {
    const lvlIdx = ch.level - 1;
    const lane = laneOf(this.data, ch); // v2 lanes: permanent stat leans on top of the base tables
    const off = lane?.offsets ?? {};
    const pieces = Object.values(ch.equipment).filter(Boolean).map(id => this.itemDef(id));
    // Ability-boosting gear (itemization v2): the rolled scores are the
    // baseline; worn "abilities": {str: 1, ...} stacks on top, and everything
    // downstream (mods, AC, attack math, spell DCs) reads the boosted scores.
    if (!ch.baseAbilities) ch.baseAbilities = { ...ch.abilities };
    ch.abilities = { ...ch.baseAbilities };
    for (const d of pieces) {
      for (const [ab, bonus] of Object.entries(d.abilities ?? {})) ch.abilities[ab] += bonus;
    }
    ch.weapon = pieces.find(d => d.type.startsWith('weapon_')); // battle.js reads name/damage/range
    // Two blades (the Ranger): the second one-handed melee weapon in hand.
    const weapons = ['hand1', 'hand2'].map(h => ch.equipment[h] && this.itemDef(ch.equipment[h])).filter(d => d && d.type.startsWith('weapon_'));
    ch.offhand = weapons.length > 1 && !weapons[1].range && weapons[1].hands !== 2 ? weapons[1] : null;
    ch.gearDmg = pieces.reduce((sum, d) => sum + (d.dmg || 0), 0); // worn 'dmg' stacks onto every hit
    // Worn 'hit' (enchanted weapons and finer things) — battle.js names each
    // piece in the attack math, per the named-bonus rule.
    ch.gearHit = pieces.reduce((sum, d) => sum + (d.hit || 0), 0);
    ch.hitPieces = pieces.filter(d => d.hit).map(d => ({ name: d.name, hit: d.hit }));
    ch.hitBase = ch.cls.hit_bonus[lvlIdx] + (off.hit ?? 0);
    ch.attacks = ch.cls.attacks_per_round[lvlIdx];
    ch.ac = 10 + ch.cls.ac_bonus[lvlIdx] + abilityMod(ch.abilities.dex) + (off.ac ?? 0)
      + pieces.reduce((sum, d) => sum + (d.ac || 0), 0);
    // Magic v2: the doc's SP formula (or a legacy array) + lane lean + gear.
    const newMax = Math.max(0, spellPointsFor(ch.cls, ch.level) + (off.sp ?? 0)
      + pieces.reduce((sum, d) => sum + (d.sp || 0), 0));
    if (newMax > ch.maxSp) ch.sp += newMax - ch.maxSp; // a found ring's points are ready to use
    ch.maxSp = newMax;
    ch.sp = Math.min(ch.sp, ch.maxSp);
  }

  // ---- Experience & leveling ----
  // Legacy player.py rule (the design doc is silent on XP): reaching the
  // next level costs 50 × current level XP; the doc's per-level class
  // tables (already in classes.json) say what each new level grants.
  // XP to the next level: progression.json's xp_curve (base x growth^(level-1),
  // rounded to 5s) - or the flat legacy 50 x level when the block is absent.
  // Raised from the flat rule after the 2026-08-30 playtest: rising monster
  // XP against a linear ladder had the party at 20 by floor 13.
  xpToLevel(ch) {
    const c = this.data.progression?.xp_curve;
    if (!c) return 50 * ch.level;
    return Math.max(5, Math.round((c.base ?? 50) * Math.pow(c.growth ?? 1.3, ch.level - 1) / 5) * 5);
  }

  // Every living hero shares the kill — but XP only ACCUMULATES here.
  // Taking the level is the player's act: a gold cross marks who's ready,
  // and the Level Up button lives on the inventory screen (I). Returns the
  // heroes who just crossed the threshold so battles can float the news.
  awardXp(amount) {
    const newlyReady = [];
    for (const ch of this.party) {
      if (!ch.alive || ch.level >= 20) continue;
      const ready = this.canLevel(ch);
      ch.xp += amount;
      if (!ready && this.canLevel(ch)) newlyReady.push(ch);
    }
    return newlyReady;
  }

  canLevel(ch) { return ch.alive && ch.level < 20 && ch.xp >= this.xpToLevel(ch); }

  // The HP a new level grants: roll the class hit die (ones are always
  // rerolled — the designer's rule), + CON modifier, minimum 1.
  rollHp(cls, conMod) {
    let rolled = roll(`1d${cls.hp_die}`);
    let rerolled = false;
    while (rolled === 1 && cls.hp_die > 1) { rerolled = true; rolled = roll(`1d${cls.hp_die}`); }
    return { rolled, rerolled, gain: Math.max(1, rolled + conMod) };
  }

  // The player takes the level (the button on the inventory screen).
  // New HP is ROLLED — 1d(class hit die) + CON modifier, minimum 1 — the
  // one moment of chance in leveling. Returns a summary of everything that
  // changed so the UI can show it (null if the hero can't level).
  levelUp(ch) {
    if (!this.canLevel(ch)) return null;
    const before = { maxHp: ch.maxHp, hitBase: ch.hitBase, attacks: ch.attacks, ac: ch.ac, maxSp: ch.maxSp };
    ch.xp -= this.xpToLevel(ch);
    const tierBefore = heroMaxSpellLevel(ch);
    ch.level++;
    const newTier = heroMaxSpellLevel(ch) > tierBefore ? heroMaxSpellLevel(ch) : 0;
    const conMod = abilityMod(ch.abilities.con);
    const { rolled, rerolled, gain: hpGain } = this.rollHp(ch.cls, conMod);
    ch.maxHp += hpGain;
    ch.hp += hpGain; // the surge of a new level heals what it grants
    // Magic v3: a study level owes the spellbook a free page (the pick
    // pops on the map, after this flow); the Sorcerer's picks likewise.
    // Revelations (rare prayers) simply arrive.
    const slotsBefore = magicModel(this.data, ch) === 'spellbook' ? preparedSlots(this.data, { ...ch, level: ch.level - 1 }) : 0;
    const studied = magicModel(this.data, ch) === 'spellbook' && (ch.cls.spellbook?.study_levels ?? []).includes(ch.level);
    if (studied) ch.studyOwed = (ch.studyOwed ?? 0) + 1;
    refreshSpellbook(this.data, ch); // preparation stays legal as slots grow
    const revealed = revelationsAt(this.data, ch, ch.level);
    for (const r of revealed) this.log(`A revelation: ${r.name} comes to ${ch.name} unbidden — a prayer no book teaches.`, 'good');
    this.refreshDerived(ch); // hit/attacks/AC/spell points follow the tables (+ lane offsets)
    this.refreshChoices();   // fork levels owe a choice (pops once back on the map)
    audio.play('leveling');
    this.log(`${ch.name} reaches level ${ch.level}! (+${hpGain} HP)`, 'good');
    if (ch.level === 20) this.log(`${ch.name} has reached the pinnacle of their art.`, 'good');
    if (this.party.every(c => c.level >= 20)) {
      this.log('The whole party stands at the height of mortal skill. Something below has taken notice...', 'death');
    }
    // Milestones this level unlocked: {kind, text} — the text is the summary
    // teaser, the kind drives the full narrated card that follows it.
    const milestones = [];
    const prog = classProg(this.data, ch);
    if (newTier > 1 && spellPointsFor(ch.cls, ch.level) > 0) {
      milestones.push({ kind: 'spelltier', tier: newTier, text: `Deeper magic: level-${newTier} spells are within reach!` });
    }
    if (studied) milestones.push({ kind: 'study', text: 'A study is owed: a new page for the spellbook — choose it next.' });
    const slotsAfter = magicModel(this.data, ch) === 'spellbook' ? preparedSlots(this.data, ch) : 0;
    if (slotsAfter > slotsBefore) milestones.push({ kind: 'slot', slots: slotsAfter, text: `Prepared spells: ${slotsBefore} → ${slotsAfter} at a time.` });
    for (const r of revealed) milestones.push({ kind: 'revelation', spell: r.id, text: `A revelation: ${r.name}.` });
    for (const sp of laneSpellsAt(this.data, ch, ch.level)) milestones.push({ kind: 'revelation', spell: sp.id, lane: true, text: `A new verse: ${sp.name}.` });
    if (prog && ch.level === prog.fork_level && !ch.lane) {
      milestones.push({ kind: 'fork', text: `The ${ch.cls.name}'s road forks here.` });
    }
    const lane = laneOf(this.data, ch);
    if (lane?.verb && ch.level === lane.verb.level) milestones.push({ kind: 'verb', text: `New signature move: ${lane.verb.name}!` });
    if (lane?.capstone && ch.level === lane.capstone.level) {
      milestones.push({ kind: 'capstone', text: `${ch.name} is now a ${lane.archetype ?? lane.capstone.name}!` });
    }
    if (lane?.refinement && ch.level === lane.refinement.level) milestones.push({ kind: 'refinement', text: `${lane.verb?.name ?? 'Their signature move'} sharpens.` });
    if (lane?.rite && ch.level === 20) milestones.push({ kind: 'rite', text: 'The Rite awaits.' });
    return { ch, rolled, rerolled, conMod, hpGain, before, milestones };
  }

  // ---- Level parsing ----
  loadLevel(levelData) {
    const src = levelData.file || 'data/levels/level1.json';
    const rows = levelData.map;
    const w = rows[0].length;
    if (!rows.every(r => r.length === w)) {
      const bad = rows.findIndex(r => r.length !== w);
      throw new DataError(src, `Map row ${bad + 1} is ${rows[bad].length} characters wide but row 1 is ${w}. All rows must match.`);
    }
    this.level = {
      name: levelData.name, w, h: rows.length,
      chestGold: levelData.chest_gold || '2d20+10',
      chestItems: levelData.chest_items || [],
      chestRandom: levelData.chest_random || 0, // guaranteed random items per chest
      // Rigged chests (2026-08-27): each chest rolls this chance to hide a
      // trap in its latch, drawn from the floor's chest_traps pool.
      chestTrapChance: levelData.chest_trap_chance ?? this.data.dungeon.chest_trap_chance ?? 0,
      chestTrapPool: levelData.chest_traps || [],
      restAmbush: levelData.rest_ambush ?? 0,   // chance camp is interrupted
      legend: levelData.legend || {},           // this floor's monster roster (camp ambushes draw from it)
      tacticsNames: levelData.tactics,          // which battle templates fit this floor's style
    };
    if (typeof this.level.restAmbush !== 'number' || this.level.restAmbush < 0 || this.level.restAmbush > 1) {
      throw new DataError('data/levels/level1.json', `"rest_ambush" must be a number between 0 and 1 (e.g. 0.25 = a quarter of camps are attacked).`);
    }
    for (const entry of this.level.chestItems) {
      if (!this.data.items.items[entry.id]) {
        throw new DataError(src, `chest_items lists "${entry.id}" but there is no such item in items.json. Valid: ${Object.keys(this.data.items.items).join(', ')}`);
      }
      if (typeof entry.chance !== 'number' || entry.chance < 0 || entry.chance > 1) {
        throw new DataError(src, `chest_items entry "${entry.id}" needs a "chance" between 0 and 1 (e.g. 0.5 = half of chests).`);
      }
    }
    this.grid = rows.map(r => r.split(''));
    this.monsters = [];
    this.seen = Array.from({ length: rows.length }, () => new Array(w).fill(false));
    this.partyPos = null;
    // Hidden dangers: traps [{x, y, id}] and secret doors ('S' on the map).
    this.traps = (levelData.traps || []).map(t => ({ ...t, detected: false }));
    for (const t of this.traps) {
      if (!this.data.dungeon.traps[t.id]) {
        throw new DataError('data/dungeon.json', `A floor placed trap "${t.id}" but the "traps" section doesn't define it. Valid: ${Object.keys(this.data.dungeon.traps).join(', ')}`);
      }
    }
    // Rigged chests: roll each chest on the floor once, here, so a chest is
    // trapped (or not) for the whole run — leaving and returning changes nothing.
    const ctc = this.level.chestTrapChance;
    if (typeof ctc !== 'number' || ctc < 0 || ctc > 1) {
      throw new DataError(src, `"chest_trap_chance" must be a number between 0 and 1 (e.g. 0.25 = one chest in four is rigged).`);
    }
    for (const id of this.level.chestTrapPool) {
      if (!this.data.dungeon.traps[id]) {
        throw new DataError(src, `"chest_traps" lists "${id}" but dungeon.json's traps section doesn't define it. Valid: ${Object.keys(this.data.dungeon.traps).join(', ')}`);
      }
    }
    this.chestTraps = [];
    if (ctc > 0 && this.level.chestTrapPool.length) {
      for (let y = 0; y < rows.length; y++) {
        for (let x = 0; x < w; x++) {
          if ((this.grid[y][x] === '$' || this.grid[y][x] === '*') && Math.random() < ctc) {
            const id = this.level.chestTrapPool[Math.floor(Math.random() * this.level.chestTrapPool.length)];
            this.chestTraps.push({ x, y, id, detected: false });
          }
        }
      }
    }
    this.revealed = new Set();   // secret doors the party has spotted ("x,y")

    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < w; x++) {
        const c = this.grid[y][x];
        if (c === '@') {
          this.partyPos = { x, y };
          this.grid[y][x] = '.';
        } else if (levelData.legend?.[c]) {
          const id = levelData.legend[c];
          const def = this.data.monsters.monsters[id];
          if (!def) throw new DataError(src, `Legend says "${c}" = "${id}" but there is no monster "${id}" in monsters.json. Valid: ${Object.keys(this.data.monsters.monsters).join(', ')}`);
          this.monsters.push({ ...def, id, x, y, maxHp: def.hp, conditions: [] });
          this.grid[y][x] = '.';
        } else if (!'#.+>$<S*'.includes(c)) {
          throw new DataError(src, `Unknown map symbol "${c}" at row ${y + 1}, column ${x + 1}. Use # . + > < $ * S @ or a letter from the legend.`);
        }
      }
    }
    if (!this.partyPos) throw new DataError(src, 'No "@" (party start position) found on the map.');
    // Encounters: members of a named group wear its name — the battle-start
    // line speaks it when the court fights together.
    for (const pk of levelData.packs ?? []) {
      for (const [px, py] of pk.spots) {
        const m = this.monsters.find(mm => mm.x === px && mm.y === py);
        if (m) m.pack = pk.name;
      }
    }
    this.updateVision();
  }

  // ---- Messages ----
  log(text, kind = 'combat') {
    this.messages.push({ text, kind });
    if (this.messages.length > 200) this.messages.shift();
    // Nearly every state change speaks — so every message quietly refreshes
    // the run autosave (debounced; never in battle/arena; a wipe clears it).
    this.autosave();
  }

  // The run autosave (engine/save.js): one localStorage slot, map moments only.
  autosave(flush = false) { autosaveRun(this, flush); }

  // ---- Vision (fog of war with line of sight) ----
  // A tile is visible when it's in torch radius AND an unblocked sight line
  // reaches it. Walls and closed doors block sight (open doors don't).
  blocksSight(x, y) {
    const c = this.grid[y]?.[x];
    return c === '#' || c === '+' || c === 'S'; // a secret door looks and acts like wall
  }

  // Bresenham line from (x0,y0) to (x1,y1): true if no cell strictly between
  // the endpoints blocks sight (so walls themselves light up when you face them).
  losClear(x0, y0, x1, y1) {
    let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy, x = x0, y = y0;
    while (true) {
      if (x === x1 && y === y1) return true;
      if ((x !== x0 || y !== y0) && this.blocksSight(x, y)) return false;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }

  updateVision() {
    const { x: px, y: py } = this.partyPos;
    this.visible = new Set();
    for (let y = 0; y < this.level.h; y++) {
      for (let x = 0; x < this.level.w; x++) {
        if (Math.hypot(x - px, y - py) > VISION_RADIUS) continue;
        if (!this.losClear(px, py, x, y)) continue;
        this.seen[y][x] = true;
        this.visible.add(y * this.level.w + x);
      }
    }
  }

  isVisible(x, y) { return this.visible.has(y * this.level.w + x); }
  monsterAt(x, y) { return this.monsters.find(m => m.x === x && m.y === y); }

  // ---- Player turn ----
  tryMove(dx, dy) {
    if (this.over || this.victory || this.battle) return;
    if (this.mode === 'town') return this.townMove(dx, dy);
    const nx = this.partyPos.x + dx, ny = this.partyPos.y + dy;
    if (nx < 0 || ny < 0 || nx >= this.level.w || ny >= this.level.h) return;
    const cell = this.grid[ny][nx];
    const monster = this.monsterAt(nx, ny);

    if (monster) {
      this.startBattle(monster);
      return; // battle rounds take over; no map turn passes
    } else if (cell === '#') {
      return; // walls don't consume a turn
    } else if (cell === 'S') {
      if (!this.revealed.has(`${nx},${ny}`)) return; // to unknowing eyes, just wall
      this.grid[ny][nx] = "'";
      audio.play('stone_door'); // secret doors grind in stone; wooden doors keep 'door'
      this.log('The hidden panel swings aside — a secret passage!', 'good');
    } else if (cell === '+') {
      this.grid[ny][nx] = "'";
      audio.play('door');
      this.log('You push open the heavy door.', 'info');
    } else if (cell === '$' || cell === '*') {
      // A rigged latch fires (or is picked apart) before any loot changes hands.
      const chestTrap = this.chestTraps?.find(t => t.x === nx && t.y === ny);
      if (chestTrap && !this.resolveChestTrap(chestTrap)) return; // the party fell
      this.openChest(nx, ny, cell === '*');
    } else if (cell === '>') {
      if (this.allAtPinnacle() && this.depth !== 'boss') {
        this.preBossDepth = this.depth;
        this.enterFloor('boss', 'down');
      } else {
        this.enterFloor(this.depth + 1, 'down');
      }
      return; // arriving on a new floor costs no turn
    } else if (cell === '<') {
      if (this.depth === 'boss') this.enterFloor(this.preBossDepth || 20, 'up');
      else if (this.depth === 1) { this.saveFloor(); this.enterTown(); }
      else this.enterFloor(this.depth - 1, 'up');
      return;
    } else {
      const trap = this.trapAt(nx, ny);
      this.partyPos = { x: nx, y: ny };
      this.updateVision();
      if (trap && !this.resolveTrap(trap)) return; // the party fell — no more turn
    }
    this.endPlayerTurn();
  }

  trapAt(x, y) { return this.traps?.find(t => t.x === x && t.y === y); }

  // One hero's trap-and-secrets skill (in %): the design doc's thief/archer
  // per-level table, +5% per DEX modifier, + racial bonus, + the Thief lane
  // leans (Shadows up, Blade Work down) and Keen Senses. Used for detection,
  // disarming, and the Burglar's Set Trap.
  heroSkill(ch) {
    const base = ch.cls.detect?.[ch.level - 1] ?? 0;
    const racial = ch.race.detect_bonus ?? 0;
    // Worn 'detect' (Cloak of Elvenkind and kin) sharpens the eye too — and
    // magic works even for a class with no training of its own.
    const gear = Object.values(ch.equipment).filter(Boolean)
      .reduce((sum, id) => sum + (this.itemDef(id).detect || 0), 0);
    const gift = giftOf(ch)?.detect ?? 0; // Stonespeak: the stone tells you
    if (base + racial + gear + gift <= 0) return 0; // no eye for it at all
    const lane = laneOf(this.data, ch);
    const p = passiveOf(this.data, ch);
    return base + racial + gear + gift
      + (lane?.offsets?.detect ?? 0)
      + (p?.id === 'keen_senses' ? (p.bonus ?? 10) : 0)
      + growthEffect(this.data, ch, 'skill') // the rogue's craft (Sharper Eye)
      + 5 * abilityMod(ch.abilities.dex);
  }

  // Elemental protection (tier abilities, 2026-08-27): a worn piece with
  // "immune": ["fire"] zeroes that element's damage; "resist": ["fire"]
  // halves it (designer ruling: half damage only). Returns the guarding
  // piece so every halving can wear its name.
  elementGuard(ch, element) {
    if (!element || !ch.equipment) return null;
    const pieces = Object.values(ch.equipment).filter(Boolean).map(id => this.itemDef(id));
    const immune = pieces.find(d => d.immune?.includes(element));
    if (immune) return { kind: 'immune', name: immune.name };
    const resist = pieces.find(d => d.resist?.includes(element));
    if (resist) return { kind: 'resist', name: resist.name };
    // Magic v3: a warding spell (Sanctified Ground) resists too, by name.
    const ward = (ch.timedBuffs ?? []).find(b => b.resist === 'all' || b.resist?.includes?.(element));
    if (ward) return { kind: 'resist', name: ward.name };
    return null;
  }

  // Worn 'save_bonus' pieces (talismans, rings of protection) stack with the
  // racial save bonus on every saving throw.
  heroSaveBonus(ch) {
    const p = passiveOf(this.data, ch);
    return (ch.race.save_bonus ?? 0) + Object.values(ch.equipment).filter(Boolean)
      .reduce((sum, id) => sum + (this.itemDef(id).save_bonus || 0), 0)
      + (ch.timedBuffs ?? []).reduce((sum, b) => sum + (b.saves || 0), 0)
      + this.condStat(ch, 'saves')
      + (p?.id === 'sundered_calm' ? (p.saves ?? 1) : 0) // the Wardsong's calm
      + (this.battle?.auraSaves(ch) ?? 0); // a Hearthstone dwarf standing beside you
  }

  // Stat conditions (magic v3): the sum of one modifier across everything
  // afflicting this creature (hero or monster) — 'hit', 'dmg', 'ac', 'saves'.
  condStat(ref, key) {
    return (ref.conditions ?? []).reduce((sum, c) => {
      const def = this.conditionDef(c.id);
      return sum + (def?.effect === 'stat' ? (def[key] || 0) : 0);
    }, 0);
  }

  // Named stat-condition parts for the combat math: [[value, name], ...].
  condParts(ref, key) {
    return (ref.conditions ?? []).map(c => this.conditionDef(c.id)).filter(d => d?.effect === 'stat' && d[key])
      .map(d => [d[key], d.name]);
  }

  // The party's best chance of noticing hidden things as they explore.
  detectChance() {
    return Math.max(0, ...this.party.filter(ch => ch.alive).map(ch => this.heroSkill(ch)));
  }

  // WHO has that best eye — the hero whose skill detectChance() uses, so
  // every discovery message can give them the credit (designer rule
  // 2026-08-30: the finder is named, ties go to marching order).
  bestDetector() {
    let best = null;
    for (const ch of this.party) {
      if (!ch.alive) continue;
      if (!best || this.heroSkill(ch) > this.heroSkill(best)) best = ch;
    }
    return best;
  }

  // How far the party's eye reaches (Shadows growth "Long Look" widens the
  // adjacent default), and how long a thorough search takes ("Quick Hands").
  detectReach() {
    return Math.max(1, ...this.party.filter(ch => ch.alive)
      .map(ch => growthEffect(this.data, ch, 'find_range') || 1));
  }

  searchTurns() {
    const base = this.data.dungeon.search_turns ?? 5;
    const quick = this.party.filter(ch => ch.alive)
      .map(ch => growthEffect(this.data, ch, 'search_turns')).filter(n => n > 0);
    return quick.length ? Math.min(base, ...quick) : base;
  }

  // The hero whose growth pick applies to a party-wide craft (named in the log).
  craftHero(field) {
    return this.party.find(ch => ch.alive && growthEffect(this.data, ch, field)) ?? null;
  }

  // Called after every step: each hidden feature beside the party gets a
  // fresh detection roll (designer ruling 2026-08-27 — walking past gives a
  // few chances, lingering nearby will find it; Space is the sure thing).
  searchNearby() {
    if (this.mode !== 'dungeon') return;
    let chance = this.detectChance();
    if (chance <= 0) return;
    const reach = this.detectReach();
    // Unerring Eye (Shadows growth): within reach, the roll is a formality.
    if (this.craftHero('find_sure')) chance = 100;
    const near = (x, y) => Math.max(Math.abs(x - this.partyPos.x), Math.abs(y - this.partyPos.y)) <= reach;
    for (const t of this.traps) {
      if (t.detected || !near(t.x, t.y)) continue;
      if (Math.random() * 100 < chance) {
        t.detected = true;
        audio.play('discover');
        this.log(`${this.bestDetector().name}'s sharp eyes catch a ${this.data.dungeon.traps[t.id].name.toLowerCase()} hidden in the floor!`, 'good');
      }
    }
    for (const t of this.chestTraps ?? []) {
      if (t.detected || !near(t.x, t.y)) continue;
      if (Math.random() * 100 < chance) {
        t.detected = true;
        audio.play('discover');
        this.log(`${this.bestDetector().name} spots a ${this.data.dungeon.traps[t.id].name.toLowerCase()} rigged to the chest's latch!`, 'good');
      }
    }
    for (let y = this.partyPos.y - reach; y <= this.partyPos.y + reach; y++) {
      for (let x = this.partyPos.x - reach; x <= this.partyPos.x + reach; x++) {
        if (this.grid[y]?.[x] !== 'S' || this.revealed.has(`${x},${y}`)) continue;
        if (Math.random() * 100 < chance) {
          this.revealed.add(`${x},${y}`);
          audio.play('discover');
          this.log(`${this.bestDetector().name} notices a seam in the stonework — there is a secret door here!`, 'good');
        }
      }
    }
  }

  // Prying open a chest ('$'), or a secret vault's chest ('*') — the vault
  // pays out per dungeon.json's vault_loot: multiplied gold plus real gear,
  // drawn from the finest pieces this depth can offer.
  openChest(x, y, vault) {
    const v = this.data.dungeon.vault_loot || {};
    const amount = roll(this.level.chestGold) * (vault ? (v.gold_multiplier ?? 3) : 1);
    this.gold += amount;
    this.grid[y][x] = '.';
    audio.play('coins');
    const found = [], left = [];
    for (const entry of this.level.chestItems) {
      if (Math.random() < entry.chance) {
        const def = this.itemDef(entry.id);
        const got = this.addItem(entry.id, def.bundle ?? 1);
        (got ? found : left).push(`${got > 1 ? `${got} ` : ''}${def.name}`);
      }
    }
    // Guaranteed surprises: N items drawn at random from the whole catalog.
    const ids = Object.keys(this.data.items.items);
    for (let i = 0; i < this.level.chestRandom; i++) {
      const id = ids[Math.floor(Math.random() * ids.length)];
      (this.addItem(id) ? found : left).push(this.itemDef(id).name);
    }
    // Magic v3: a scroll may lie among the coin (dungeon.json scroll_drops).
    const scroll = this.rollScroll(vault);
    if (scroll) (this.addItem(scroll) ? found : left).push(this.itemDef(scroll).name);
    if (vault) {
      // The vault's promise: gear from the floor's TIER (itemization v2 —
      // depth 1-4 draws tier 1, 5-8 tier 2, up to tier 5 at 17+; an empty
      // tier falls back down a band). Never the rusty starters, and never a
      // Rite trinket — those are earned in the ceremony, not fished from a box.
      const depth = this.depth === 'boss' ? 20 : this.depth;
      const wearable = t => t.startsWith('weapon_') || t.startsWith('armor_') || t.startsWith('jewelry_')
        || t === 'shield' || t === 'helm' || t === 'cloak' || t === 'boots';
      const offLimits = new Set(Object.values(this.data.classes.classes).map(c => c.starting_weapon));
      for (const cls of Object.values(this.data.progression.classes ?? {})) {
        for (const lane of Object.values(cls.lanes ?? {})) {
          for (const tier of lane.rite?.tiers ?? []) if (tier.trinket) offLimits.add(tier.trinket);
        }
      }
      const shelfAt = band => Object.entries(this.data.items.items)
        .filter(([id, d]) => wearable(d.type) && (d.tier ?? 1) === band && !offLimits.has(id));
      for (let i = 0; i < (v.gear_pieces ?? 1); i++) {
        let band = Math.min(5, Math.ceil(depth / 4));
        let shelf = shelfAt(band);
        while (!shelf.length && band > 1) shelf = shelfAt(--band);
        if (!shelf.length) break;
        const [id, def] = shelf[Math.floor(Math.random() * shelf.length)];
        (this.addItem(id) ? found : left).push(def.name);
      }
    }
    const opener = vault ? 'The vault\'s chest is heavy with riches' : 'You pry open the chest';
    this.log(found.length
      ? `${opener} — ${amount} gold and: ${found.join(', ')}! (I — inventory)`
      : `${opener} — ${amount} gold!`, 'gold');
    if (left.length) this.log(`The party can carry no more and leaves behind: ${left.join(', ')}.`, 'info');
  }

  // dungeon.json → scroll_drops: does this chest hold a scroll, and which?
  // Regular chests use the band's own knobs, vaults the band's 'vault'
  // block. Rare/common pools fall back to each other; nothing drops for
  // spell levels with no scroll items. Returns an item id or null.
  rollScroll(vault) {
    const bands = this.data.dungeon.scroll_drops?.bands ?? [];
    const depth = this.depth === 'boss' ? 20 : (this.depth || 1);
    const band = bands.find(b => depth >= b.floors[0] && depth <= b.floors[1]);
    const knobs = vault ? band?.vault : band;
    if (!knobs || Math.random() >= (knobs.chance ?? 0)) return null;
    const pool = rare => Object.entries(this.data.items.items)
      .filter(([, d]) => d.type === 'scroll' && (knobs.levels ?? []).includes(this.data.spells.spells[d.spell]?.level)
        && !!this.data.spells.spells[d.spell]?.rare === rare)
      .map(([id]) => id);
    const wantRare = Math.random() < (knobs.rare_chance ?? 0);
    let ids = pool(wantRare);
    if (!ids.length) ids = pool(!wantRare);
    if (!ids.length) return null;
    return ids[Math.floor(Math.random() * ids.length)];
  }

  // A rigged chest latch: a detected one lets the thief pick it apart first;
  // an unseen one simply fires on whoever opens the lid.
  // Returns false if the party wiped.
  resolveChestTrap(trap) {
    const def = this.data.dungeon.traps[trap.id];
    this.chestTraps = this.chestTraps.filter(t => t !== trap); // spent either way
    // Latchbreaker (Shadows growth): chests simply never bite this party.
    const latch = this.craftHero('chest_safe');
    if (latch) {
      audio.play('disarm');
      this.log(`${latch.name} has the lid open and the ${def.name.toLowerCase()} out of its latch before anyone else reaches for it — Latchbreaker.`, 'good');
      return true;
    }
    const disarmer = trap.detected
      ? this.party.find(ch => ch.alive && ch.cls.disarms)
      : null;
    if (disarmer) {
      if (Math.random() * 100 < this.heroSkill(disarmer)) {
        audio.play('disarm');
        this.log(`${disarmer.name} eases the ${def.name.toLowerCase()} out of the chest's latch — disarmed!`, 'good');
        return true;
      }
      if (growthEffect(this.data, disarmer, 'disarm_safe')) {
        this.log(`${disarmer.name}'s hand slips — but Steady Hands catch the ${def.name.toLowerCase()} before it can fire.`, 'good');
        return true;
      }
      this.log(`${disarmer.name} slips — the ${def.name.toLowerCase()} in the latch goes off!`, 'death');
      return this.springTrap(def, disarmer);
    }
    return this.springTrap(def);
  }

  // A trap goes off (or a thief defuses it). Returns false if the party wiped.
  resolveTrap(trap) {
    const def = this.data.dungeon.traps[trap.id];
    this.traps = this.traps.filter(t => t !== trap); // one way or another, it's spent
    const disarmer = trap.detected
      ? this.party.find(ch => ch.alive && ch.cls.disarms) // the design doc: only thieves remove traps
      : null;
    if (disarmer) {
      const chance = this.heroSkill(disarmer);
      if (Math.random() * 100 < chance) {
        audio.play('disarm'); // its own moment (2026-08-26): discover = spotting, disarm = picking it apart
        this.log(`${disarmer.name} picks the ${def.name.toLowerCase()} apart — disarmed!`, 'good');
        return true;
      }
      if (growthEffect(this.data, disarmer, 'disarm_safe')) {
        this.log(`${disarmer.name} fumbles the mechanism — but Steady Hands ease it back before it fires.`, 'good');
        return true;
      }
      this.log(`${disarmer.name} fumbles the mechanism — the ${def.name.toLowerCase()} goes off!`, 'death');
      return this.springTrap(def, disarmer);
    }
    return this.springTrap(def);
  }

  springTrap(def, victim) {
    audio.play('trap_springs');
    const living = this.party.filter(ch => ch.alive);
    const ch = victim && victim.alive ? victim : living[Math.floor(Math.random() * living.length)];
    let dmg = Math.max(1, roll(def.dice));
    const saved = d20() + abilityMod(ch.abilities[def.save ?? 'dex']) + this.heroSaveBonus(ch) >= def.dc;
    if (saved) dmg = Math.floor(dmg / 2);
    // Typed traps meet elemental protection: immunity shrugs the whole thing
    // off; resistance halves what got through the save.
    const guard = this.elementGuard(ch, def.element);
    if (guard?.kind === 'immune') {
      this.log(`${def.name}! The ${guard.name} drinks the ${def.element} — ${ch.name} is untouched.`, 'good');
      return true;
    }
    if (guard?.kind === 'resist') {
      dmg = Math.max(1, Math.floor(dmg / 2));
      this.log(`The ${guard.name} turns half the ${def.element} aside.`, 'good');
    }
    // Wary Step (Way of the Shield growth): the raised guard blunts traps too.
    const wary = growthNamed(this.data, ch, 'brace_vs', 'trap');
    if (wary && dmg > 0) {
      const p = passiveOf(this.data, ch);
      const cut = (p?.reduce ?? 1) + growthEffect(this.data, ch, 'brace_bonus');
      const was = dmg;
      dmg = Math.max(0, dmg - cut);
      if (was !== dmg) this.log(`${wary.name} — ${ch.name}'s guard turns ${was - dmg} of it aside.`, 'good');
    }
    ch.hp -= dmg;
    this.log(saved
      ? `${def.name}! ${ch.name} twists away — ${dmg} damage.`
      : `${def.name}! ${ch.name} takes it full on — ${dmg} damage!`, 'death');
    if (!saved && def.condition) this.applyCondition(ch, def.condition.id, def.condition.rounds);
    if (ch.hp <= 0) {
      ch.hp = 0;
      ch.alive = false;
      this.log(`${ch.name} has fallen!`, 'death');
    }
    if (this.party.every(c => !c.alive)) {
      this.over = true;
      this.log('The entire party has fallen. The dungeon keeps its secrets. Press R to try again.', 'death');
      return false;
    }
    return true;
  }

  // Space: a deliberate, thorough search (designer ruling 2026-08-27). The
  // party combs every adjacent wall and floor tile — it ALWAYS finds what is
  // hidden, provided anyone has the eye for it, but it takes real time
  // (dungeon.json search_turns; poison ticks and monsters keep moving).
  wait() {
    if (this.over || this.victory || this.battle || this.mode === 'town') return;
    if (this.detectChance() <= 0) {
      this.log('The party pokes at the nearby walls, but no one has the eye for hidden things.', 'info');
      this.endPlayerTurn();
      return;
    }
    const turns = this.searchTurns();
    const reach = this.detectReach();
    const near = (x, y) => Math.max(Math.abs(x - this.partyPos.x), Math.abs(y - this.partyPos.y)) <= reach;
    let found = 0;
    for (const t of this.traps) {
      if (t.detected || !near(t.x, t.y)) continue;
      t.detected = true; found++;
      this.log(`${this.bestDetector().name}'s search uncovers a ${this.data.dungeon.traps[t.id].name.toLowerCase()} hidden in the floor!`, 'good');
    }
    for (const t of this.chestTraps ?? []) {
      if (t.detected || !near(t.x, t.y)) continue;
      t.detected = true; found++;
      this.log(`${this.bestDetector().name}'s search uncovers a ${this.data.dungeon.traps[t.id].name.toLowerCase()} rigged to the chest's latch!`, 'good');
    }
    for (let y = this.partyPos.y - reach; y <= this.partyPos.y + reach; y++) {
      for (let x = this.partyPos.x - reach; x <= this.partyPos.x + reach; x++) {
        if (this.grid[y]?.[x] !== 'S' || this.revealed.has(`${x},${y}`)) continue;
        this.revealed.add(`${x},${y}`); found++;
        this.log(`${this.bestDetector().name} finds a seam in the stonework — there is a secret door here!`, 'good');
      }
    }
    if (found) audio.play('discover');
    else this.log(`The party searches every nearby crack and seam — nothing is hidden here. (${turns} turns pass)`, 'info');
    // The time cost: the dungeon does not hold its breath while you search.
    for (let i = 0; i < turns; i++) {
      this.advanceTime(1);
      if (this.over || this.battle) return;
      this.monstersAct();
      if (this.over || this.battle) return;
    }
  }

  // Make camp: restore HP and spell points. Only safe when no enemy is in
  // sight; the fallen stay fallen (that takes greater magic than a nap).
  // Camp burns 1 ration per living hero (the shop sells them, chests drop
  // them), so rest is a resource, not a free heal between every room — and
  // the level's rest_ambush chance means wandering monsters may find the
  // fire: the party wakes half-healed and fighting, rations already spent.
  rest() {
    if (this.over || this.victory || this.battle) return;
    if (this.mode === 'town') {
      this.log('No need to pitch camp on cobblestones — the inn is right there.', 'info');
      return;
    }
    if (this.monsters.some(m => this.isVisible(m.x, m.y))) {
      this.log('You cannot make camp with enemies in sight!', 'info');
      return;
    }
    const mouths = this.party.filter(ch => ch.alive).length;
    const packed = this.inventory.rations || 0;
    if (packed < mouths) {
      this.log(`Camp takes ${mouths} rations and the party carries ${packed}. The shop in Novamagus sells them.`, 'info');
      return;
    }
    this.inventory.rations = packed - mouths;

    if (Math.random() < this.level.restAmbush) {
      const pack = this.spawnCampAmbush();
      if (pack) {
        // Half a night's sleep: half the missing HP and SP come back.
        for (const ch of this.party) {
          if (!ch.alive) continue;
          ch.hp += Math.ceil((ch.maxHp - ch.hp) / 2);
          ch.sp += Math.ceil((ch.maxSp - ch.sp) / 2);
        }
        this.log(`The party makes camp (−${mouths} rations)... but in the dead of night, something finds the fire!`, 'death');
        this.advanceTime(25); // half a watch passes before the attack
        if (this.over) return;
        this.updateVision();
        this.startBattle(pack[0], true);
        return;
      }
    }

    const before = this.party.map(ch => ch.hp);
    for (const ch of this.party) {
      if (!ch.alive) continue;
      ch.hp = ch.maxHp;
      ch.sp = ch.maxSp;
    }
    audio.play('camp');
    const healed = this.party.some((ch, i) => ch.hp !== before[i]);
    this.log(`The party makes camp and rests (−${mouths} rations). ${healed ? 'Wounds mend and spirits return.' : 'Spirits return.'}`, 'good');
    this.refillQuivers();
    this.afterFullRest();
    // A watch of camp time passes AFTER the healing — lingering poison
    // ticks through the night, so cure it before you sleep.
    this.advanceTime(50);
  }

  // Wandering monsters stumble onto the camp: 1-3 of one type from this
  // level's roster, placed on open floor around the sleepers. Returns the
  // pack (now real map monsters — flee and they're still out there).
  spawnCampAmbush() {
    const ids = [...new Set(Object.values(this.level.legend || {}))];
    if (!ids.length) return null;
    const id = ids[Math.floor(Math.random() * ids.length)];
    const def = this.data.monsters.monsters[id];
    const count = 1 + Math.floor(Math.random() * 3);
    const spots = this.openSpotsAround(count);
    if (!spots.length) return null;
    const pack = spots.map(s => ({ ...def, id, x: s.x, y: s.y, maxHp: def.hp, conditions: [] }));
    this.monsters.push(...pack);
    return pack;
  }

  // Open floor tiles ringing the party, nearest ring first — shared by camp
  // ambushes and the playtest bench's monster spawner.
  openSpotsAround(count) {
    const spots = [];
    for (let r = 1; r <= 3 && spots.length < count; r++) {
      for (let dy = -r; dy <= r && spots.length < count; dy++) {
        for (let dx = -r; dx <= r && spots.length < count; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = this.partyPos.x + dx, y = this.partyPos.y + dy;
          const cell = this.grid[y]?.[x];
          if ((cell === '.' || cell === "'") && !this.monsterAt(x, y)) spots.push({ x, y });
        }
      }
    }
    return spots;
  }

  // ---- Playtest bench (P key): the designer's test tools ----
  // Set every hero to an exact level in one stroke, recomputing HP/AC/SP
  // from the class tables. Dropping below a class's fork un-walks the lane
  // (and Weapon Focus) so the choice can be tested again; jumping up leaves
  // the owed forks in the queue — they pop once the bench is closed.
  debugSetPartyLevel(n) {
    n = Math.max(1, Math.min(20, Math.round(n)));
    for (const ch of this.party) {
      ch.level = n;
      ch.xp = 0;
      const prog = classProg(this.data, ch);
      if (prog && n < prog.fork_level) {
        ch.lane = null; ch.focusType = null; ch.focusTypes = []; ch.growth = [];
        // Un-walk the caster lanes: the Raw Gift's set-aside book returns.
        if (ch.formerBook) { ch.spellbook = [...ch.formerBook]; ch.formerBook = null; }
        ch.knownSpells = []; ch.bonusPicksTaken = 0;
      }
      // Weapon families sworn above this level are given back, newest first.
      const famAllowed = passiveOf(this.data, ch)?.id === 'weapon_focus'
        ? 1 + (passiveOf(this.data, ch).extra_levels ?? []).filter(l => n >= l).length : 0;
      if ((ch.focusTypes ?? []).length > famAllowed) {
        ch.focusTypes = ch.focusTypes.slice(0, famAllowed);
        ch.focusType = ch.focusTypes[0] ?? null;
      }
      // Lane growth taken above this level is given back, newest first.
      const grAllowed = growthPicksAllowed(this.data, ch);
      if ((ch.growth ?? []).length > grAllowed) ch.growth = ch.growth.slice(0, grAllowed);
      // …and so are ability points bought above it, so the pick re-tests.
      const abAllowed = abilityPicksAllowed(this.data, ch);
      const amount = this.data.progression.ability_boost?.amount ?? 1;
      while ((ch.abilityBoosts ?? []).length > abAllowed) {
        const undo = ch.abilityBoosts.pop();
        ch.baseAbilities[undo] -= amount;
      }
      if (n < 20) ch.rite = null; // dropping below the pinnacle un-runs the Rite (re-testable)
      ch.spentRest = {}; // the jump is a fresh day — once-per-rest powers return
      ch.timedBuffs = []; // …and any Stance held is sung anew
      refreshSpellbook(this.data, ch); // the kit opens if the book is empty; preparation stays legal
      if (magicModel(this.data, ch) === 'spellbook') {
        // Study credits for the jump are spent on the spot (no modal avalanche).
        const kit = (ch.cls.spellbook?.starting_spells ?? []).length;
        ch.studyOwed = Math.max(0, studiesGrantedBy(ch) - Math.max(0, ch.spellbook.length - kit));
        autoStudy(this.data, ch);
        ch.prepFresh = true;
      }
      // Same HP rule as real play: max die at level 1, rolled (rerolling
      // ones) for every level after — simulated fresh for the jump.
      const conMod = abilityMod(ch.abilities.con);
      ch.maxHp = Math.max(1, ch.cls.hp_die + conMod);
      for (let l = 2; l <= n; l++) ch.maxHp += this.rollHp(ch.cls, conMod).gain;
      if (ch.alive) ch.hp = ch.maxHp;
      this.refreshDerived(ch);
      if (ch.alive) ch.sp = ch.maxSp;
    }
    this.refreshChoices();
    this.log(`TEST: the whole party now stands at level ${n}. The tables paid out in full:`, 'info');
    for (const ch of this.party) {
      this.log(`TEST: ${ch.name} — HP ${ch.hp}/${ch.maxHp} · hit +${ch.hitBase} · ${ch.attacks} attack${ch.attacks > 1 ? 's' : ''} · AC ${ch.ac}${ch.maxSp ? ` · SP ${ch.sp}/${ch.maxSp}` : ''}`, 'info');
    }
  }

  // Bank enough XP for each hero to TAKE the next `times` levels themselves —
  // the real flow: gold cross, Level Up button, HP roll, summary, forks.
  // Nothing levels automatically here.
  debugGrantLevelXp(times = 1) {
    for (const ch of this.party) {
      if (!ch.alive || ch.level >= 20) continue;
      let need = 0;
      for (let i = 0; i < times && ch.level + i < 20; i++) need += 50 * (ch.level + i);
      ch.xp = Math.max(ch.xp, need);
    }
    this.log(`TEST: the party has earned enough XP to level ${times > 1 ? `${times} times` : 'up'} — the gold ✚ marks who's ready (open I).`, 'info');
  }

  debugHealParty() {
    for (const ch of this.party) {
      ch.alive = true;
      ch.hp = ch.maxHp;
      ch.sp = ch.maxSp;
      ch.conditions = [];
    }
    this.log('TEST: the party is made whole — wounds, deaths, and ailments erased.', 'good');
  }

  debugGold(amount) {
    this.gold += amount;
    this.log(`TEST: ${amount} gold appears in the purse.`, 'gold');
  }

  // Bump every hero's tracked playstyle counters — for testing the Rite's
  // title tiers without grinding real Rampage kills / Stand saves.
  debugAddCounters(amount) {
    for (const ch of this.party) {
      for (const key of Object.keys(ch.counters)) ch.counters[key] += amount;
    }
    this.log(`TEST: every playstyle counter grows by ${amount}.`, 'info');
  }

  // Conjure a pack beside the party and fight it on the spot. These are real
  // monsters with real stakes: they grant XP, and if the party flees they
  // stay prowling on the map.
  debugFight(id, count) {
    if (this.battle || this.over || this.victory) return false;
    // Destiny before bloodshed: a hero with an unmade choice (crossroads,
    // weapon focus, the Rite) would fight WITHOUT the powers that choice
    // unlocks — confusing every playtest. The choices open first.
    if (this.choiceQueue.length) {
      this.log(`TEST: choices wait first — ${[...new Set(this.choiceQueue.map(c => c.ch.name))].join(' and ')} must decide their path before the next fight.`, 'info');
      return false;
    }
    if (this.mode !== 'dungeon') {
      this.log('TEST: Novamagus stays monster-free — step through the dungeon gate first.', 'info');
      return false;
    }
    const def = this.data.monsters.monsters[id];
    if (!def) return false;
    const spots = this.openSpotsAround(count);
    if (!spots.length) {
      this.log('TEST: no open floor beside the party to spawn on.', 'info');
      return false;
    }
    const pack = spots.map(s => ({ ...def, id, x: s.x, y: s.y, maxHp: def.hp, conditions: [] }));
    this.monsters.push(...pack);
    this.updateVision();
    this.log(`TEST: ${pack.length} ${def.name}${pack.length > 1 ? 's' : ''} step${pack.length > 1 ? '' : 's'} out of thin air — and the party has the drop!`, 'info');
    // NOT an ambush: summoned fights count as party-initiated, so the
    // monsters start unaware — the only way to playtest stealth on demand.
    this.startBattle(pack[0]);
    return true;
  }

  // ---- Training arena (debug/design sandbox) ----
  // One of every monster at 5x HP, spells cost nothing, and the party's real
  // state is snapshotted on entry and restored on exit: nothing that happens
  // in the arena is real — no XP, no lasting wounds, no lasting cures.
  startArena() {
    if (this.over || this.victory || this.battle) return;
    this.arenaSnapshot = this.party.map(ch => ({
      hp: ch.hp, sp: ch.sp, xp: ch.xp, alive: ch.alive,
      buffs: { ...ch.buffs },
      conditions: ch.conditions.map(c => ({ ...c })),
      counters: { ...ch.counters }, // sparring feats don't count toward titles
      spentRest: { ...ch.spentRest }, // arena previews of once-per-rest powers are free
      stances: activeStances(ch).map(b => ({ ...b })), // a Stance held going in is held coming out
    }));
    this.arena = true;
    const dummies = Object.entries(this.data.monsters.monsters).map(([id, def]) => ({
      ...def, id, x: 0, y: 0,
      hp: def.hp * 5, maxHp: def.hp * 5,
      conditions: [],
    }));
    this.log('Training arena: nothing here is real. Spells are free; leave with Esc.', 'info');
    this.battle = new Battle(this, this.data.arenaTemplate, dummies);
  }

  endArena() {
    this.party.forEach((ch, i) => {
      const s = this.arenaSnapshot[i];
      ch.hp = s.hp; ch.sp = s.sp; ch.xp = s.xp; ch.alive = s.alive;
      ch.buffs = s.buffs;
      ch.conditions = s.conditions;
      ch.timedBuffs = s.stances; // Rage and its kin are battle-scoped — only the Stances held before leave the ring
      ch.counters = s.counters;
      ch.spentRest = s.spentRest;
      ch.insight = null; // Arcane Insight is battle-scoped
    });
    this.arena = false;
    this.arenaSnapshot = null;
    this.log('The party steps out of the training arena, unharmed and unchanged.', 'info');
  }

  // ---- Tactical battle ----
  // Bumping a monster (or being caught by one) pulls every visible monster in
  // the same room (within BATTLE_RADIUS) onto a tactical battlefield built
  // from one of the level's templates in data/tactics/. Map time freezes;
  // the battle runs on initiative until one side falls or the party flees.
  startBattle(trigger, ambush = false) {
    const foes = this.monsters.filter(m =>
      Math.max(Math.abs(m.x - this.partyPos.x), Math.abs(m.y - this.partyPos.y)) <= BATTLE_RADIUS
      && this.isVisible(m.x, m.y));
    if (!foes.includes(trigger)) foes.push(trigger);
    audio.play('battle_start');
    // A named terror (monsters.json "unique": true — the Overlord) takes no article.
    const article = trigger.unique ? '' : /^[aeiou]/i.test(trigger.name) ? 'An ' : 'A ';
    // A named encounter announces itself when the group fights together.
    const packName = trigger.pack && foes.filter(f => f.pack === trigger.pack).length > 1 ? trigger.pack : null;
    this.log(ambush
      ? `Battle! ${packName ? `${packName[0].toUpperCase()}${packName.slice(1)} is` : 'They are'} upon you before you can form ranks!`
      : packName
        ? `Battle! ${packName[0].toUpperCase()}${packName.slice(1)}!`
        : foes.length === 1
          ? `Battle! ${article}${trigger.name} blocks your path!`
          : `Battle! ${foes.length} monsters close in!`, 'info');
    const pool = (this.level.tacticsNames || []).filter(n => this.data.tactics[n]);
    const names = pool.length ? pool : Object.keys(this.data.tactics);
    const pick = this.data.tactics[names[Math.floor(Math.random() * names.length)]];
    this.battle = new Battle(this, pick, foes, { ambush });
  }

  endPlayerTurn() {
    this.updateVision(); // doors opening (etc.) change what the party can see
    this.searchNearby(); // passive detection as the party passes hidden things
    this.advanceTime(1);
    if (this.over) return;
    this.monstersAct();
  }

  // ---- Items (shared party pouch) ----
  itemDef(id) { return this.data.items.items[id]; }

  // Add to the pouch, honoring the item's max_carry cap (rations can't be
  // stockpiled into an endless larder). Returns how many were actually taken.
  addItem(id, n = 1) {
    const cap = this.itemDef(id)?.max_carry;
    const have = this.inventory[id] || 0;
    // Arrows found or bought go to empty quivers first, the pouch after.
    let toQuivers = 0;
    if (id === this.ammoId() && !this.battle) {
      for (const ch of this.party) {
        if (!ch.alive || !ch.weapon?.range) continue;
        const room = this.quiverCap(ch) - Math.min(ch.quiver ?? 0, this.quiverCap(ch));
        const give = Math.max(0, Math.min(room, n - toQuivers));
        if (give > 0) { ch.quiver = (ch.quiver ?? 0) + give; toQuivers += give; }
      }
    }
    const rest = n - toQuivers;
    const taken = cap ? Math.min(rest, Math.max(0, cap - have)) : rest;
    if (taken > 0) this.inventory[id] = have + taken;
    return taken + toQuivers;
  }

  // Held consumables, for menus: [{id, def, count}]
  heldItems() {
    return Object.entries(this.inventory)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => ({ id, def: this.itemDef(id), count: n }))
      .filter(it => it.def && it.def.type === 'consumable');
  }

  // Scrolls in the pouch, for the battle item menu: [{id, def, spell, count,
  // reason}] — reason is null when this hero may read it (magic v3).
  readableScrolls(ch) {
    return Object.entries(this.inventory)
      .filter(([id, n]) => n > 0 && this.itemDef(id)?.type === 'scroll')
      .map(([id, n]) => {
        const def = this.itemDef(id);
        const spell = this.data.spells.spells[def.spell];
        return { id, def, spell: spell ? { id: def.spell, ...spell } : null, count: n,
          reason: spell ? scrollReadable(this.data, ch, spell) : `names an unknown spell "${def.spell}"` };
      });
  }

  // ---- Ranged rules (items.json 'ranged' block) ----
  rangedRules() { return this.data.items.ranged ?? {}; }
  ammoId() { return this.rangedRules().ammo ?? null; }
  ammoCount() { const id = this.ammoId(); return id ? (this.inventory[id] || 0) : Infinity; }

  // ---- Quivers (designer's call, 2026-08-29): arrows ride on the HERO ----
  // Capacity: the bow's own 'quiver', else items.json ranged.quiver_capacity.
  quiverCap(ch) {
    if (!this.ammoId() || !ch.weapon?.range) return 0;
    return (ch.weapon.quiver ?? this.rangedRules().quiver_capacity ?? 20) + (giftOf(ch)?.quiver_bonus ?? 0);
  }
  quiverCount(ch) { return this.ammoId() ? Math.min(ch.quiver ?? 0, this.quiverCap(ch) || Infinity) : Infinity; }
  // A shot spends one arrow from the shooter's quiver (the arena's is bottomless).
  spendAmmo(ch) {
    if (!this.ammoId() || this.arena) return;
    if (ch && ch.quiver > 0) ch.quiver--;
  }
  // Move spare arrows from the pouch into a hero's quiver, up to its cap.
  // Returns how many moved. Free out of battle; in battle it costs the turn.
  restockQuiver(ch) {
    const id = this.ammoId();
    if (!id) return 0;
    const cap = this.quiverCap(ch);
    ch.quiver = Math.min(ch.quiver ?? 0, cap);
    const want = cap - ch.quiver;
    const moved = Math.max(0, Math.min(want, this.inventory[id] || 0));
    if (moved > 0) { ch.quiver += moved; this.inventory[id] -= moved; }
    return moved;
  }
  // Out of battle every bow-wielder tops up quietly (battle's end, camp,
  // the inn, arrows found or bought, a bow strung). Logs only when it moved.
  refillQuivers(quiet = false) {
    if (this.battle && !this.arena) return;
    for (const ch of this.party) {
      if (!ch.alive || !ch.weapon?.range) continue;
      const moved = this.restockQuiver(ch);
      if (moved > 0 && !quiet) this.log(`${ch.name} fills the quiver: +${moved} (${ch.quiver}/${this.quiverCap(ch)}).`, 'info');
    }
  }

  // Weapons and shields in the pouch this hero could swap to in battle:
  // [{id, def, count, reason}] — reason set when the class may not use it.
  swapOptions(ch) {
    return Object.entries(this.inventory)
      .filter(([id, n]) => n > 0)
      .map(([id, n]) => ({ id, def: this.itemDef(id), count: n }))
      .filter(it => it.def && (it.def.type.startsWith('weapon_') || it.def.type === 'shield'))
      .map(it => ({ ...it, reason: this.gearBlockReason(it.def, ch) }));
  }

  // The words burn off the page (the arena keeps its scrolls).
  consumeScroll(id) {
    if (this.arena) return;
    if (this.inventory[id] > 0) this.inventory[id]--;
  }

  // Camp supplies (rations etc.), for the inventory screen: [{id, def, count}]
  heldSupplies() {
    return Object.entries(this.inventory)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => ({ id, def: this.itemDef(id), count: n }))
      .filter(it => it.def && it.def.type === 'supply');
  }

  // Worn gear in the pouch, for the equip UI: [{id, def, count}]
  heldGear() {
    return Object.entries(this.inventory)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => ({ id, def: this.itemDef(id), count: n }))
      .filter(it => it.def && this.equipSlot(it.def));
  }

  // Which family of paper-doll slot a piece of gear goes to.
  equipSlot(def) {
    if (def.type === 'shield' || def.type.startsWith('weapon_')) return 'hand';
    if (def.type.startsWith('armor_')) return 'armor';
    if (def.type === 'helm') return 'head';
    if (def.type === 'cloak') return 'cloak'; // itemization v2: the 9th slot, fits anyone
    if (def.type === 'boots') return 'boots';
    if (def.type === 'jewelry_neck') return 'necklace';
    if (def.type === 'jewelry_ring') return 'ring';
    return null; // consumables etc.
  }

  isWeapon(id) { const d = id && this.itemDef(id); return !!d && d.type.startsWith('weapon_'); }
  hasShield(ch) { return ['hand1', 'hand2'].some(h => ch.equipment[h] && this.itemDef(ch.equipment[h]).type === 'shield'); }
  // A two-handed weapon ("hands": 2 on the item) claims both hand slots.
  twoHanded(ch) { const d = ch.equipment.hand1 && this.itemDef(ch.equipment.hand1); return d?.hands === 2 ? d : null; }

  // Why this hero can't wear this — or null if they can (design doc item rules).
  gearBlockReason(def, ch) {
    if (!ch.alive) return `${ch.name} is beyond gear.`;
    const cls = ch.cls;
    if (def.type.startsWith('weapon_')) {
      const cat = def.type.slice('weapon_'.length);
      const types = cls.weapon_types ?? ['any'];
      if (!types.includes('any') && !types.includes(cat)) {
        return `A ${cls.name} cannot wield the ${def.name}.`;
      }
    }
    if (def.type.startsWith('armor_')) {
      const cat = def.type.slice('armor_'.length);
      if (!(cls.armor_types ?? []).includes(cat)) return `A ${cls.name} cannot wear ${def.name}.`;
    }
    if (def.type === 'shield') {
      if (!cls.shields) return `A ${cls.name} cannot carry a shield.`;
      const two = this.twoHanded(ch);
      if (two) return `${ch.name}'s ${two.name} needs both hands.`;
    }
    return null;
  }

  // Pick the concrete slot a piece goes into: empty slot of its family first,
  // otherwise the sensible one to swap out.
  resolveSlot(def, ch) {
    const family = this.equipSlot(def);
    if (family === 'ring') return !ch.equipment.ring1 ? 'ring1' : !ch.equipment.ring2 ? 'ring2' : 'ring1';
    if (family !== 'hand') return family;
    if (def.type.startsWith('weapon_')) {
      // A dual-wielder (classes.json dual_wield) with a one-hander in one
      // hand and a free (or shield) hand puts a second one-hander there.
      if (ch.cls.dual_wield && def.hands !== 2 && !def.range && !this.twoHanded(ch)
        && this.isWeapon(ch.equipment.hand1) && !this.itemDef(ch.equipment.hand1).range && !this.isWeapon(ch.equipment.hand2)) return 'hand2';
      // A weapon replaces the hand already holding a weapon (or takes a free one).
      if (this.isWeapon(ch.equipment.hand1)) return 'hand1';
      if (this.isWeapon(ch.equipment.hand2)) return 'hand2';
      return !ch.equipment.hand1 ? 'hand1' : 'hand2';
    }
    // A shield takes the non-weapon hand.
    if (!this.isWeapon(ch.equipment.hand2)) return 'hand2';
    return 'hand1';
  }

  // Equip from the pouch; whatever the piece displaces goes back in.
  equipItem(id, ch) {
    const def = this.itemDef(id);
    if (!def || !(this.inventory[id] > 0)) return false;
    const reason = this.gearBlockReason(def, ch);
    if (reason) { this.log(reason, 'info'); return false; }
    const slot = this.resolveSlot(def, ch);
    this.inventory[id]--;
    if (def.hands === 2) {
      // Claim both hands: everything held goes back to the pouch.
      for (const h of ['hand1', 'hand2']) if (ch.equipment[h]) { this.addItem(ch.equipment[h]); ch.equipment[h] = null; }
      ch.equipment.hand1 = id;
    } else {
      if (def.type.startsWith('weapon_') && this.twoHanded(ch)) {
        // A one-hander replaces the two-hander entirely.
        this.addItem(ch.equipment.hand1);
        ch.equipment.hand1 = id;
      } else {
        if (ch.equipment[slot]) this.addItem(ch.equipment[slot]);
        ch.equipment[slot] = id;
      }
    }
    this.refreshDerived(ch);
    if (!this.battle) this.refillQuivers(true);
    audio.play(this.equipSound(id, def));
    this.log(`${ch.name} equips the ${def.name}.`, 'good');
    return true;
  }

  // Gear speaks by what it's made of (designer's picks, 2026-08-26): metal
  // weapons clank, wooden ones (bows, staffs) knock, armor rustles, small
  // wearables slip on, jewelry chimes. 'robe'/'cape' in an item id gets its
  // own sound the day such items exist.
  equipSound(id, def) {
    const t = def.type;
    if (t === 'weapon_bow' || id.includes('staff')) return 'equip_wood';
    if (t.startsWith('weapon')) return 'equip_metal';
    if (t === 'cloak' || id.includes('robe') || id.includes('cape')) return 'equip_robe';
    if (t.startsWith('armor') || t === 'shield') return 'equip_armor';
    if (t === 'helm' || t === 'boots') return 'equip_clothing';
    if (t.startsWith('jewelry')) return 'equip_jewelry';
    return 'gear_equip';
  }

  // Take a piece off (back into the pouch). A hero's last weapon only leaves
  // by swap — nobody fights the dungeon bare-handed.
  unequipItem(ch, slot) {
    const id = ch.equipment[slot];
    if (!id) return;
    if (this.isWeapon(id) && !['hand1', 'hand2'].some(h => h !== slot && this.isWeapon(ch.equipment[h]))) {
      this.log(`${ch.name} keeps a weapon in hand — swap in another instead.`, 'info');
      return;
    }
    ch.equipment[slot] = null;
    this.addItem(id);
    this.refreshDerived(ch);
    this.log(`${ch.name} removes the ${this.itemDef(id).name}.`, 'info');
  }

  // Why this hero can't drink this item right now — or null if they can.
  // Blocking wasteful sips keeps a misclick from burning a rare potion.
  itemBlockReason(def, ch) {
    if (!ch.alive) return `${ch.name} is beyond potions.`;
    if (def.type === 'scroll') return 'A scroll is read in battle (I) — or copied into a spellbook on the character sheet.';
    if (def.effect === 'heal' && ch.hp >= ch.maxHp) return `${ch.name} is unhurt.`;
    if (def.effect === 'cure' && !ch.conditions.some(c => c.id === def.cures)) {
      const cond = this.conditionDef(def.cures);
      return `${ch.name} is not ${cond ? cond.name.toLowerCase() : def.cures}.`;
    }
    if (def.effect === 'mana') {
      if (ch.maxSp <= 0) return `${ch.name} has no wellspring of magic to refill.`;
      if (ch.sp >= ch.maxSp) return `${ch.name}'s spell points are already full.`;
    }
    if (def.effect === 'invisibility') {
      // Designer ruling 2026-08-27: battle-only, exactly the thief's Vanish.
      if (!this.battle) return 'There is no one here to hide from — save it for battle.';
      if (ch.hidden) return `${ch.name} is already unseen.`;
    }
    return null;
  }

  // Drink: applies the effect and consumes the item (the arena refunds it).
  // Returns {ok, fxText, fxColor} so battles can float the result.
  useItem(id, ch) {
    const def = this.itemDef(id);
    if (!def || !(this.inventory[id] > 0)) return { ok: false };
    const reason = this.itemBlockReason(def, ch);
    if (reason) { this.log(reason, 'info'); return { ok: false }; }
    if (!this.arena) this.inventory[id]--;
    audio.play('potion_drink');
    if (def.effect === 'heal') {
      const healed = Math.min(roll(def.dice), ch.maxHp - ch.hp);
      ch.hp += healed;
      this.log(`${ch.name} drinks the ${def.name} — ${healed} HP restored.${this.arena ? ' (arena: not consumed)' : ''}`, 'good');
      return { ok: true, fxText: `+${healed}`, fxColor: '#6ad46a' };
    }
    if (def.effect === 'cure') {
      ch.conditions = ch.conditions.filter(c => c.id !== def.cures);
      const cond = this.conditionDef(def.cures);
      this.log(`${ch.name} drinks the ${def.name} — ${cond.name.toLowerCase()} no more.${this.arena ? ' (arena: not consumed)' : ''}`, 'good');
      return { ok: true, fxText: 'cured!', fxColor: '#6ad46a' };
    }
    if (def.effect === 'mana') {
      const restored = Math.min(roll(def.dice), ch.maxSp - ch.sp);
      ch.sp += restored;
      this.log(`${ch.name} drinks the ${def.name} — ${restored} spell points return.${this.arena ? ' (arena: not consumed)' : ''}`, 'good');
      return { ok: true, fxText: `+${restored} SP`, fxColor: '#6a9ad4' };
    }
    if (def.effect === 'invisibility') {
      audio.play('vanish');
      ch.hidden = true; // battle.js: unseen until they strike, exactly like Vanish
      this.log(`${ch.name} drinks the ${def.name} — and is simply not there anymore.`, 'good');
      return { ok: true, fxText: 'unseen!', fxColor: '#b9a7e8' };
    }
    return { ok: false };
  }

  // Drinking on the map takes a moment: the world gets a turn.
  useItemOnMap(id, ch) {
    if (this.over || this.victory || this.battle) return false;
    const res = this.useItem(id, ch);
    if (res.ok) this.endPlayerTurn();
    return res.ok;
  }

  // ---- Conditions on the map clock ----
  // Lingering conditions (poison) tick every `map_tick_every` map turns.
  conditionDef(id) { return this.data.conditions.conditions[id]; }

  // `source` (optional): the battle-local uid of the combatant that caused
  // it — fear conditions ("fear": true in conditions.json) use it to forbid
  // approaching whoever scared you. Battle-only; never serialized meaningfully.
  applyCondition(ref, id, rounds, source) {
    const def = this.conditionDef(id);
    if (!def) return;
    // Protective gear (itemization v2): a worn piece with "immune": ["poison"]
    // simply refuses the condition — and says which piece did it. Elemental
    // immunity covers the element's condition too (fire blocks burning).
    const ELEMENT_OF = { burning: 'fire', poison: 'poison' };
    if (ref.equipment) {
      const guard = Object.values(ref.equipment).filter(Boolean).map(i => this.itemDef(i))
        .find(d => d.immune?.includes(id) || (ELEMENT_OF[id] && d.immune?.includes(ELEMENT_OF[id])));
      if (guard) {
        this.log(`The ${guard.name} turns the ${def.name.toLowerCase()} aside!`, 'good');
        return;
      }
    }
    // Lane growth (Bulwark's refusals, 2026-09-02): the mountain simply
    // cannot take this condition — and the aura may refuse it for allies.
    const refusal = growthNamed(this.data, ref, 'refuse', id);
    if (refusal) {
      this.log(`${refusal.name} — it finds no purchase on ${ref.name}.`, 'good');
      return;
    }
    if (this.battle) {
      const warden = this.party.find(o => o.alive && o !== ref && growthNamed(this.data, o, 'aura_refuse', id)
        && this.battle.adjacentAllies?.(o, ref));
      if (warden) {
        const w = growthNamed(this.data, warden, 'aura_refuse', id);
        this.log(`${warden.name}'s ${w.name} shelters ${ref.name} — it takes no hold.`, 'good');
        return;
      }
    }
    // A warding spell (Sanctified Ground) refuses every affliction while it holds.
    const ward = (ref.timedBuffs ?? []).find(b => b.immune_conditions === true || (Array.isArray(b.immune_conditions) && b.immune_conditions.includes(id)));
    if (ward) {
      this.log(`${ward.name} refuses the ${def.name.toLowerCase()} — nothing foul takes hold of ${ref.name}.`, 'good');
      return;
    }
    const existing = ref.conditions.find(c => c.id === id);
    if (existing) {
      existing.rounds = Math.max(existing.rounds, rounds); // re-poisoning refreshes, no stacking
      if (source !== undefined) existing.source = source;  // fresh terror, fresh source
    } else {
      const cond = { id, rounds, mapCounter: 0 };
      if (source !== undefined) cond.source = source;
      ref.conditions.push(cond);
    }
    this.log(`${ref.name} is ${def.name.toLowerCase()}!`, 'death');
  }

  advanceTime(turns) {
    this.autosave(); // steps and searches count, even the quiet ones
    for (let t = 0; t < turns; t++) {
      this.turn++;
      for (const ch of this.party) {
        if (!ch.alive) continue;
        for (const c of [...ch.conditions]) {
          const def = this.conditionDef(c.id);
          if (!def.lingers) continue;
          c.mapCounter++;
          if (c.mapCounter < (def.map_tick_every ?? 10)) continue;
          c.mapCounter = 0;
          if (def.effect === 'damage') {
            const dmg = Math.max(1, roll(def.dice));
            ch.hp -= dmg;
            this.log(`${ch.name} suffers ${dmg} damage from ${def.name.toLowerCase()}.`, 'death');
            if (ch.hp <= 0) {
              ch.hp = 0;
              ch.alive = false;
              this.log(`${ch.name} succumbs to ${def.name.toLowerCase()}!`, 'death');
            }
          }
          c.rounds--;
          if (c.rounds <= 0) {
            ch.conditions = ch.conditions.filter(x => x !== c);
            this.log(`${ch.name} recovers from ${def.name.toLowerCase()}.`, 'good');
          }
        }
      }
    }
    if (this.party.every(ch => !ch.alive)) {
      this.over = true;
      this.log('The entire party has fallen. The dungeon keeps its dead. Press R to try again.', 'death');
    }
  }

  // ---- Monster turns ----
  monstersAct() {
    for (const m of this.monsters) {
      if (m.regroup > 0) { m.regroup--; continue; } // just fled from: it regroups while you run
      if (m.speed > 1 && this.turn % m.speed !== 0) continue; // slow monsters skip turns
      const dx = this.partyPos.x - m.x, dy = this.partyPos.y - m.y;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      if (dist <= 1) {
        this.log(`The ${m.name} catches the party!`, 'info');
        this.startBattle(m, true);
        return; // battle takes over; the rest of the map freezes
      } else if (dist <= MONSTER_AGGRO_RANGE && this.isVisible(m.x, m.y)) {
        this.monsterStep(m, dx, dy);
        if (Math.max(Math.abs(this.partyPos.x - m.x), Math.abs(this.partyPos.y - m.y)) <= 1) {
          // The scout's warning (designer 2026-09-03): a watchful hero may
          // call the approach — the monster halts, the party acts first.
          // It only works once per approach: dither, and it catches you.
          const scout = !m.halted && this.scoutWarning(m);
          if (scout) {
            m.halted = true;
            audio.play('discover');
            this.log(`${scout.name} hears them coming — the ${m.name} halts at the edge of the torchlight. (${scout.what}: rolled ${scout.roll} vs ${scout.chance}%)`, 'good');
            continue;
          }
          this.log(`The ${m.name} catches the party!`, 'info');
          this.startBattle(m, true);
          return;
        }
      }
    }
  }

  // Heroes who keep watch on the approach: a Ranger (classes.json
  // "scouting") or a Shadows thief with the Point Man pick (growth
  // "watch": true). Each rolls d100 under their skill; the first success
  // wears the credit (highest skill rolls first).
  scouts() {
    return this.party.filter(ch => ch.alive && (ch.cls.scouting || growthEffect(this.data, ch, 'watch')))
      .map(ch => ({ ch, chance: Math.max(0, Math.min(95, this.heroSkill(ch) + (ch.cls.scouting?.bonus ?? 0))),
        what: ch.cls.scouting ? (ch.cls.scouting.name ?? 'Scouting') : (growthPicks(this.data, ch).find(o => o.watch)?.name ?? 'Point Man') }))
      .filter(s => s.chance > 0)
      .sort((a, b) => b.chance - a.chance);
  }

  scoutWarning(m) {
    for (const s of this.scouts()) {
      const roll = Math.floor(Math.random() * 100) + 1;
      if (roll <= s.chance) return { name: s.ch.name, what: s.what, roll, chance: s.chance };
    }
    return null;
  }

  monsterStep(m, dx, dy) {
    // Greedy chase: try the dominant axis first, then the other.
    const steps = [];
    const sx = Math.sign(dx), sy = Math.sign(dy);
    if (Math.abs(dx) >= Math.abs(dy)) steps.push([sx, 0], [0, sy]);
    else steps.push([0, sy], [sx, 0]);
    for (const [mx, my] of steps) {
      if (mx === 0 && my === 0) continue;
      const nx = m.x + mx, ny = m.y + my;
      const cell = this.grid[ny]?.[nx];
      const blocked = cell !== '.' && cell !== "'"; // monsters can't open doors or cross chests
      const occupied = this.monsterAt(nx, ny) || (nx === this.partyPos.x && ny === this.partyPos.y);
      if (!blocked && !occupied) { m.x = nx; m.y = ny; return; }
    }
  }

}
