// Game state and rules: party building, level parsing, movement, combat, monster AI.

import { roll, d20, abilityMod } from './rules.js';
import { DataError } from './loader.js';
import { Battle } from './battle.js';
import { generateFloor } from './dungeon.js';
import { laneOf, passiveOf, classProg, pendingChoices, focusOptions, displayClass, riteTier } from './progression.js';
import { maxSpellLevel, spellPointsFor, spellCost, magicModel, refreshSpellbook, autoPrepare, castableSpells, knownSpells, preparedSlots } from './magic.js';
import * as audio from './audio.js';

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
    this.party = data.party.party.map(p => this.buildCharacter(p));
    // Each hero brings their own purse to the pool (data/party.json rule).
    const goldDice = data.party.starting_gold || '4d6+200';
    for (const ch of this.party) this.gold += roll(goldDice);
    this.onBuilding = null; // main.js hooks this to open the shop/inn/temple panels
    this.choiceQueue = [];  // progression choices owed (lane forks etc.) — shown on the map
    this.refreshChoices();  // pre-leveled heroes (party.json test path) owe theirs at once
    this.enterTown(true);   // Novamagus is home: every run starts here
    this.log(`The party pools its purses: ${this.gold} gold.`, 'gold');
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
      if (magicModel(this.data, ch) === 'spellbook') {
        ch.prepFresh = true;
        this.log(`${ch.name}'s mind is clear — prepared spells may be re-picked on the character sheet (C) until the next fight.`, 'info');
      }
    }
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
      this.log(`Only a spellbook can hold a scroll's lore — and ${ch.name} keeps none. (The Wizard's Spellbook lane copies scrolls; anyone can sell them.)`, 'info');
      return false;
    }
    if (ch.spellbook.includes(def.spell)) {
      this.log(`${spell.name} is already inked in ${ch.name}'s book.`, 'info');
      return false;
    }
    this.inventory[id]--;
    ch.spellbook.push(def.spell);
    audio.play('spell_arcane');
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
        this.log(`A spellbook opens in ${ch.name}'s hands — ${ch.spellbook.length} spells inked, ${preparedSlots(this.data, ch)} prepared at a time (re-pick at any rest).`, 'good');
      } else if (model === 'known') {
        this.log(`${ch.name}'s magic runs in the blood now — fewer spells, deeper wells. Choose them.`, 'good');
      }
    } else if (choice.type === 'focus') {
      ch.focusType = value;
      this.log(`${ch.name}'s hands know the ${value.replace('_', ' ')} now — Weapon Focus (+1 damage with it).`, 'good');
    } else if (choice.type === 'spell') {
      // The Sorcerer's pick: one spell, known forever.
      (ch.knownSpells ??= []).push(value);
      const s = this.data.spells.spells[value];
      this.log(`${ch.name} seizes ${s?.name ?? value} — it is in the blood now, never to be unlearned.`, 'good');
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
      seen: this.seen, traps: this.traps, revealed: this.revealed,
      triedDoors: this.triedDoors,
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
    this.mode = 'dungeon';
    this.depth = depth;
    const cached = this.floors[depth];
    if (cached) {
      this.level = cached.level;
      this.grid = cached.grid;
      this.monsters = cached.monsters;
      this.seen = cached.seen;
      this.traps = cached.traps;
      this.revealed = cached.revealed;
      this.triedDoors = cached.triedDoors;
      // Arriving from above, you stand on the up-stairs; from below, the down-stairs.
      this.partyPos = (dir === 'down' ? this.stairsAt('<') : this.stairsAt('>')) || this.partyPos;
      this.updateVision();
    } else if (depth === 'boss') {
      this.loadLevel(this.data.dungeon.boss);
    } else if (depth === 1) {
      this.loadLevel(this.data.level);
    } else {
      this.loadLevel(generateFloor(this.data, depth));
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
    ch.hp = ch.maxHp;
    ch.sp = ch.maxSp;
    ch.conditions = [];
    audio.play('temple_revive');
    this.log(`Light floods the altar — ${ch.name} draws breath once more! (−${price} gold)`, 'good');
    return true;
  }

  shopBuy(id) {
    const def = this.itemDef(id);
    if (!def) return false;
    if (def.max_carry && (this.inventory[id] || 0) >= def.max_carry) {
      this.log(`The party can only carry ${def.max_carry} ${def.name.toLowerCase()}.`, 'info');
      return false;
    }
    const price = def.value ?? 0;
    if (this.gold < price) { this.log(`${def.name} costs ${price} gold — the party cannot pay.`, 'info'); return false; }
    this.gold -= price;
    this.addItem(id);
    audio.play('purchase'); // coins on the counter — the bell is only the door now
    this.log(`Bought ${def.name} for ${price} gold.`, 'gold');
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
      look: def.look ?? null,
      lane: def.lane ?? null,
      focusType: def.focus ?? null,
      timedBuffs: [],
      counters: { rampageKills: 0, standSaves: 0, assassinateKills: 0, shadowFeats: 0,
        bookCasts: 0, overcasts: 0, mercySaves: 0, zealousStrikes: 0 },
      rite: null, // filled by the Level 20 Rite: {abilityName, sigil, title, tier}
      // Magic v2: the Wizard lane's book & daily preparation, the Sorcerer
      // lane's fixed repertoire, and the once-per-rest powers already spent.
      spellbook: [],
      prepared: [],
      knownSpells: [],
      spentRest: {},   // {archmage: true, miracle: true, ...} — cleared by a full rest
      prepFresh: false, // Prepared Mind: the re-pick window a rest opens
      // The paper doll: item ids from items.json. Hands hold weapons or a
      // shield; a hero always keeps at least one weapon in hand.
      equipment: {
        hand1: cls.starting_weapon, hand2: null,
        head: null, necklace: null, armor: null, boots: null,
        ring1: null, ring2: null,
      },
      buffs: { hit: 0, dmg: 0 },
      conditions: [], // {id, rounds, mapCounter} — see data/conditions.json
      alive: true,
    };
    // A hero built already walking a caster lane (premade parties, saved
    // parties, bench jumps) opens their book / repertoire on the spot.
    refreshSpellbook(this.data, ch);
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
    ch.weapon = pieces.find(d => d.type.startsWith('weapon_')); // battle.js reads name/damage/range
    ch.gearDmg = pieces.reduce((sum, d) => sum + (d.dmg || 0), 0); // worn 'dmg' stacks onto every hit
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
  xpToLevel(ch) { return 50 * ch.level; }

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
    const tierBefore = maxSpellLevel(ch.level);
    ch.level++;
    const newTier = maxSpellLevel(ch.level) > tierBefore ? maxSpellLevel(ch.level) : 0;
    const conMod = abilityMod(ch.abilities.con);
    const { rolled, rerolled, gain: hpGain } = this.rollHp(ch.cls, conMod);
    ch.maxHp += hpGain;
    ch.hp += hpGain; // the surge of a new level heals what it grants
    // A new spell level unlocked: the Wizard-lane book grows its own pages;
    // the Sorcerer's picks arrive via refreshChoices below.
    const newPages = refreshSpellbook(this.data, ch);
    if (newPages.length) {
      this.log(`New pages write themselves into ${ch.name}'s spellbook: ${newPages.map(id => this.data.spells.spells[id]?.name ?? id).join(', ')}.`, 'good');
    }
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
    this.traps = (levelData.traps || []).map(t => ({ ...t, detected: false, tried: false }));
    for (const t of this.traps) {
      if (!this.data.dungeon.traps[t.id]) {
        throw new DataError('data/dungeon.json', `A floor placed trap "${t.id}" but the "traps" section doesn't define it. Valid: ${Object.keys(this.data.dungeon.traps).join(', ')}`);
      }
    }
    this.revealed = new Set();   // secret doors the party has spotted ("x,y")
    this.triedDoors = new Set(); // walls already searched (Space re-searches)

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
        } else if (!'#.+>$<S'.includes(c)) {
          throw new DataError(src, `Unknown map symbol "${c}" at row ${y + 1}, column ${x + 1}. Use # . + > < $ S @ or a letter from the legend.`);
        }
      }
    }
    if (!this.partyPos) throw new DataError(src, 'No "@" (party start position) found on the map.');
    this.updateVision();
  }

  // ---- Messages ----
  log(text, kind = 'combat') {
    this.messages.push({ text, kind });
    if (this.messages.length > 200) this.messages.shift();
  }

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
    } else if (cell === '$') {
      const amount = roll(this.level.chestGold);
      this.gold += amount;
      this.grid[ny][nx] = '.';
      audio.play('coins');
      const found = [], left = [];
      for (const entry of this.level.chestItems) {
        if (Math.random() < entry.chance) {
          (this.addItem(entry.id) ? found : left).push(this.itemDef(entry.id).name);
        }
      }
      // Guaranteed surprises: N items drawn at random from the whole catalog.
      const ids = Object.keys(this.data.items.items);
      for (let i = 0; i < this.level.chestRandom; i++) {
        const id = ids[Math.floor(Math.random() * ids.length)];
        (this.addItem(id) ? found : left).push(this.itemDef(id).name);
      }
      this.log(found.length
        ? `You pry open the chest — ${amount} gold and: ${found.join(', ')}! (I — inventory)`
        : `You pry open the chest — ${amount} gold!`, 'gold');
      if (left.length) this.log(`The party can carry no more and leaves behind: ${left.join(', ')}.`, 'info');
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
    if (base + racial <= 0) return 0; // this class has no eye for it at all
    const lane = laneOf(this.data, ch);
    const p = passiveOf(this.data, ch);
    return base + racial
      + (lane?.offsets?.detect ?? 0)
      + (p?.id === 'keen_senses' ? (p.bonus ?? 10) : 0)
      + 5 * abilityMod(ch.abilities.dex);
  }

  // The party's best chance of noticing hidden things as they explore.
  detectChance() {
    return Math.max(0, ...this.party.filter(ch => ch.alive).map(ch => this.heroSkill(ch)));
  }

  // Called after every step (once per hidden feature) and again on Space —
  // waiting is active searching, so a suspicious party can re-check a wall.
  searchNearby(force = false) {
    if (this.mode !== 'dungeon') return;
    const chance = this.detectChance();
    if (chance <= 0) return;
    const near = (x, y) => Math.max(Math.abs(x - this.partyPos.x), Math.abs(y - this.partyPos.y)) <= 1;
    for (const t of this.traps) {
      if (t.detected || !near(t.x, t.y) || (t.tried && !force)) continue;
      t.tried = true;
      if (Math.random() * 100 < chance) {
        t.detected = true;
        audio.play('discover');
        this.log(`Sharp eyes catch a ${this.data.dungeon.traps[t.id].name.toLowerCase()} hidden in the floor!`, 'good');
      }
    }
    for (let y = this.partyPos.y - 1; y <= this.partyPos.y + 1; y++) {
      for (let x = this.partyPos.x - 1; x <= this.partyPos.x + 1; x++) {
        if (this.grid[y]?.[x] !== 'S' || this.revealed.has(`${x},${y}`)) continue;
        const key = `${x},${y}`;
        if (this.triedDoors.has(key) && !force) continue;
        this.triedDoors.add(key);
        if (Math.random() * 100 < chance) {
          this.revealed.add(key);
          audio.play('discover');
          this.log('A seam in the stonework — there is a secret door here!', 'good');
        }
      }
    }
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
    const saved = d20() + abilityMod(ch.abilities[def.save ?? 'dex']) + (ch.race.save_bonus ?? 0) >= def.dc;
    if (saved) dmg = Math.floor(dmg / 2);
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

  wait() {
    if (this.over || this.victory || this.battle || this.mode === 'town') return;
    this.searchNearby(true); // waiting is searching: re-check the nearby walls and floor
    this.endPlayerTurn();
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
        ch.lane = null; ch.focusType = null;
        ch.spellbook = []; ch.prepared = []; ch.knownSpells = []; // un-walk the caster lanes too
      }
      if (n < 20) ch.rite = null; // dropping below the pinnacle un-runs the Rite (re-testable)
      ch.spentRest = {}; // the jump is a fresh day — once-per-rest powers return
      refreshSpellbook(this.data, ch); // a Wizard-lane book grows into the new level
      if (magicModel(this.data, ch) === 'spellbook') ch.prepFresh = true;
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
      ch.timedBuffs = []; // Rage and its kin are battle-scoped — nothing leaves the ring
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
    const article = /^[aeiou]/i.test(trigger.name) ? 'An' : 'A';
    this.log(ambush
      ? 'Battle! They are upon you before you can form ranks!'
      : foes.length === 1
        ? `Battle! ${article} ${trigger.name} blocks your path!`
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
    const taken = cap ? Math.min(n, Math.max(0, cap - have)) : n;
    if (taken > 0) this.inventory[id] = have + taken;
    return taken;
  }

  // Held consumables, for menus: [{id, def, count}]
  heldItems() {
    return Object.entries(this.inventory)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => ({ id, def: this.itemDef(id), count: n }))
      .filter(it => it.def && it.def.type === 'consumable');
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
    if (id.includes('robe') || id.includes('cape')) return 'equip_robe';
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
    if (def.effect === 'heal' && ch.hp >= ch.maxHp) return `${ch.name} is unhurt.`;
    if (def.effect === 'cure' && !ch.conditions.some(c => c.id === def.cures)) {
      const cond = this.conditionDef(def.cures);
      return `${ch.name} is not ${cond ? cond.name.toLowerCase() : def.cures}.`;
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

  applyCondition(ref, id, rounds) {
    const def = this.conditionDef(id);
    if (!def) return;
    const existing = ref.conditions.find(c => c.id === id);
    if (existing) existing.rounds = Math.max(existing.rounds, rounds); // re-poisoning refreshes, no stacking
    else ref.conditions.push({ id, rounds, mapCounter: 0 });
    this.log(`${ref.name} is ${def.name.toLowerCase()}!`, 'death');
  }

  advanceTime(turns) {
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
          this.log(`The ${m.name} catches the party!`, 'info');
          this.startBattle(m, true);
          return;
        }
      }
    }
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
