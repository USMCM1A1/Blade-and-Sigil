// Game state and rules: party building, level parsing, movement, combat, monster AI.

import { roll, d20, abilityMod } from './rules.js';
import { DataError } from './loader.js';
import { Battle } from './battle.js';
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
    this.party = data.party.party.map(p => this.buildCharacter(p));
    // Each hero brings their own purse to the pool (data/party.json rule).
    const goldDice = data.party.starting_gold || '4d6+200';
    for (const ch of this.party) this.gold += roll(goldDice);
    this.onBuilding = null; // main.js hooks this to open the shop/inn/temple panels
    this.enterTown(true);   // Novamagus is home: every run starts here
    this.log(`The party pools its purses: ${this.gold} gold.`, 'gold');
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
    this.mode = 'dungeon';
    this.loadLevel(this.data.level);
    this.log(`The party descends into ${this.level.name}...`, 'info');
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
    audio.play('victory');
    this.log(`The party sleeps soundly at the inn. Wounds mend and spirits return. (−${price} gold)`, 'good');
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
    audio.play('victory');
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
    audio.play('gold');
    this.log(`Bought ${def.name} for ${price} gold.`, 'gold');
    return true;
  }

  shopSell(id) {
    if (!(this.inventory[id] > 0)) return false;
    const def = this.itemDef(id);
    const price = Math.floor((def.value ?? 0) * (this.data.town.shop.sell_rate ?? 0.5));
    this.inventory[id]--;
    this.gold += price;
    audio.play('gold');
    this.log(`Sold ${def.name} for ${price} gold.`, 'gold');
    return true;
  }

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
    // Design doc: max HP roll at creation, +con modifier per level (min 1/level).
    const maxHp = Math.max(1, cls.hp_die + abilityMod(abilities.con)) * def.level;
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
      hitBase: cls.hit_bonus[lvlIdx],
      attacks: cls.attacks_per_round[lvlIdx],
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
    this.refreshDerived(ch);
    ch.sp = ch.maxSp;
    return ch;
  }

  // Recompute everything a hero's gear touches: AC, weapon in hand, max SP.
  // Called at creation and after every equip/unequip. Every worn piece may
  // carry 'ac' and/or 'sp' — it all stacks.
  refreshDerived(ch) {
    const lvlIdx = ch.level - 1;
    const pieces = Object.values(ch.equipment).filter(Boolean).map(id => this.itemDef(id));
    ch.weapon = pieces.find(d => d.type.startsWith('weapon_')); // battle.js reads name/damage/range
    ch.ac = 10 + ch.cls.ac_bonus[lvlIdx] + abilityMod(ch.abilities.dex)
      + pieces.reduce((sum, d) => sum + (d.ac || 0), 0);
    const newMax = ch.cls.spell_points[lvlIdx] + pieces.reduce((sum, d) => sum + (d.sp || 0), 0);
    if (newMax > ch.maxSp) ch.sp += newMax - ch.maxSp; // a found ring's points are ready to use
    ch.maxSp = newMax;
    ch.sp = Math.min(ch.sp, ch.maxSp);
  }

  // ---- Level parsing ----
  loadLevel(levelData) {
    const rows = levelData.map;
    const w = rows[0].length;
    if (!rows.every(r => r.length === w)) {
      const bad = rows.findIndex(r => r.length !== w);
      throw new DataError('data/levels/level1.json', `Map row ${bad + 1} is ${rows[bad].length} characters wide but row 1 is ${w}. All rows must match.`);
    }
    this.level = {
      name: levelData.name, w, h: rows.length,
      chestGold: levelData.chest_gold || '2d20+10',
      chestItems: levelData.chest_items || [],
      chestRandom: levelData.chest_random || 0, // guaranteed random items per chest
      restAmbush: levelData.rest_ambush ?? 0,   // chance camp is interrupted
    };
    if (typeof this.level.restAmbush !== 'number' || this.level.restAmbush < 0 || this.level.restAmbush > 1) {
      throw new DataError('data/levels/level1.json', `"rest_ambush" must be a number between 0 and 1 (e.g. 0.25 = a quarter of camps are attacked).`);
    }
    for (const entry of this.level.chestItems) {
      if (!this.data.items.items[entry.id]) {
        throw new DataError('data/levels/level1.json', `chest_items lists "${entry.id}" but there is no such item in items.json. Valid: ${Object.keys(this.data.items.items).join(', ')}`);
      }
      if (typeof entry.chance !== 'number' || entry.chance < 0 || entry.chance > 1) {
        throw new DataError('data/levels/level1.json', `chest_items entry "${entry.id}" needs a "chance" between 0 and 1 (e.g. 0.5 = half of chests).`);
      }
    }
    this.grid = rows.map(r => r.split(''));
    this.monsters = [];
    this.seen = Array.from({ length: rows.length }, () => new Array(w).fill(false));
    this.partyPos = null;

    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < w; x++) {
        const c = this.grid[y][x];
        if (c === '@') {
          this.partyPos = { x, y };
          this.grid[y][x] = '.';
        } else if (levelData.legend[c]) {
          const id = levelData.legend[c];
          const def = this.data.monsters.monsters[id];
          if (!def) throw new DataError('data/levels/level1.json', `Legend says "${c}" = "${id}" but there is no monster "${id}" in monsters.json. Valid: ${Object.keys(this.data.monsters.monsters).join(', ')}`);
          this.monsters.push({ ...def, id, x, y, maxHp: def.hp, conditions: [] });
          this.grid[y][x] = '.';
        } else if (!'#.+>$'.includes(c)) {
          throw new DataError('data/levels/level1.json', `Unknown map symbol "${c}" at row ${y + 1}, column ${x + 1}. Use # . + > $ @ or a letter from the legend.`);
        }
      }
    }
    if (!this.partyPos) throw new DataError('data/levels/level1.json', 'No "@" (party start position) found on the map.');
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
    return c === '#' || c === '+';
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
    } else if (cell === '+') {
      this.grid[ny][nx] = "'";
      this.log('You push open the heavy door.', 'info');
    } else if (cell === '$') {
      const amount = roll(this.level.chestGold);
      this.gold += amount;
      this.grid[ny][nx] = '.';
      audio.play('gold');
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
      audio.play('victory');
      this.log('The Vermin Warrens are cleared! The party climbs back to the surface. (Deeper levels arrive in a later phase.)', 'good');
      this.enterTown();
      return;
    } else {
      this.partyPos = { x: nx, y: ny };
      this.updateVision();
    }
    this.endPlayerTurn();
  }

  wait() {
    if (this.over || this.victory || this.battle || this.mode === 'town') return;
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
    audio.play('victory');
    const healed = this.party.some((ch, i) => ch.hp !== before[i]);
    this.log(`The party makes camp and rests (−${mouths} rations). ${healed ? 'Wounds mend and spirits return.' : 'Spirits return.'}`, 'good');
    // A watch of camp time passes AFTER the healing — lingering poison
    // ticks through the night, so cure it before you sleep.
    this.advanceTime(50);
  }

  // Wandering monsters stumble onto the camp: 1-3 of one type from this
  // level's roster, placed on open floor around the sleepers. Returns the
  // pack (now real map monsters — flee and they're still out there).
  spawnCampAmbush() {
    const ids = [...new Set(Object.values(this.data.level.legend || {}))];
    if (!ids.length) return null;
    const id = ids[Math.floor(Math.random() * ids.length)];
    const def = this.data.monsters.monsters[id];
    const count = 1 + Math.floor(Math.random() * 3);
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
    if (!spots.length) return null;
    const pack = spots.map(s => ({ ...def, id, x: s.x, y: s.y, maxHp: def.hp, conditions: [] }));
    this.monsters.push(...pack);
    return pack;
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
    audio.play('melee');
    const article = /^[aeiou]/i.test(trigger.name) ? 'An' : 'A';
    this.log(ambush
      ? 'Battle! They are upon you before you can form ranks!'
      : foes.length === 1
        ? `Battle! ${article} ${trigger.name} blocks your path!`
        : `Battle! ${foes.length} monsters close in!`, 'info');
    const names = Object.keys(this.data.tactics);
    const pick = this.data.tactics[names[Math.floor(Math.random() * names.length)]];
    this.battle = new Battle(this, pick, foes, { ambush });
  }

  endPlayerTurn() {
    this.updateVision(); // doors opening (etc.) change what the party can see
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
    audio.play('gold');
    this.log(`${ch.name} equips the ${def.name}.`, 'good');
    return true;
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
    audio.play('spell');
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
      this.log('The entire party has fallen. Darkness claims the Vermin Warrens. Press R to try again.', 'death');
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
