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
    this.turn = 0;
    this.over = false;      // party wiped
    this.victory = false;   // reached the stairs
    this.battle = null;     // active tactical battle, or null while exploring
    this.party = data.party.party.map(p => this.buildCharacter(p));
    this.loadLevel(data.level);
    this.log(`Welcome to ${this.level.name}. The party descends into darkness...`, 'info');
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
    const maxSp = cls.spell_points[lvlIdx];
    return {
      name: def.name,
      race, cls, level: def.level, row: def.row,
      abilities,
      hp: maxHp, maxHp,
      sp: maxSp, maxSp,
      xp: 0,
      ac: 10 + cls.ac_bonus[lvlIdx] + abilityMod(abilities.dex),
      // Attack math lives in battle.js: melee uses STR, ranged weapons use DEX
      // (design doc), and battle buffs stack on top of hitBase.
      hitBase: cls.hit_bonus[lvlIdx],
      attacks: cls.attacks_per_round[lvlIdx],
      weapon: cls.weapon,
      buffs: { hit: 0, dmg: 0 },
      conditions: [], // {id, rounds, mapCounter} — see data/conditions.json
      alive: true,
    };
  }

  // ---- Level parsing ----
  loadLevel(levelData) {
    const rows = levelData.map;
    const w = rows[0].length;
    if (!rows.every(r => r.length === w)) {
      const bad = rows.findIndex(r => r.length !== w);
      throw new DataError('data/levels/level1.json', `Map row ${bad + 1} is ${rows[bad].length} characters wide but row 1 is ${w}. All rows must match.`);
    }
    this.level = { name: levelData.name, w, h: rows.length, chestGold: levelData.chest_gold || '2d20+10' };
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
      this.log(`You pry open the chest — ${amount} gold!`, 'gold');
    } else if (cell === '>') {
      this.victory = true;
      audio.play('victory');
      this.log('You descend the stairs... The Vermin Warrens are cleared! (Deeper levels arrive in a later phase.)', 'good');
      return;
    } else {
      this.partyPos = { x: nx, y: ny };
      this.updateVision();
    }
    this.endPlayerTurn();
  }

  wait() {
    if (this.over || this.victory || this.battle) return;
    this.endPlayerTurn();
  }

  // Make camp: restore HP and spell points. Only safe when no enemy is in
  // sight; the fallen stay fallen (that takes greater magic than a nap).
  // Camp time advances the clock a full watch — lingering afflictions
  // (Phase 3d conditions) will tick during it.
  rest() {
    if (this.over || this.victory || this.battle) return;
    if (this.monsters.some(m => this.isVisible(m.x, m.y))) {
      this.log('You cannot make camp with enemies in sight!', 'info');
      return;
    }
    const before = this.party.map(ch => ch.hp);
    for (const ch of this.party) {
      if (!ch.alive) continue;
      ch.hp = ch.maxHp;
      ch.sp = ch.maxSp;
    }
    audio.play('victory');
    const healed = this.party.some((ch, i) => ch.hp !== before[i]);
    this.log(`The party makes camp and rests. ${healed ? 'Wounds mend and spirits return.' : 'Spirits return.'}`, 'good');
    // A watch of camp time passes AFTER the healing — lingering poison
    // ticks through the night, so cure it before you sleep.
    this.advanceTime(50);
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
  startBattle(trigger) {
    const foes = this.monsters.filter(m =>
      Math.max(Math.abs(m.x - this.partyPos.x), Math.abs(m.y - this.partyPos.y)) <= BATTLE_RADIUS
      && this.isVisible(m.x, m.y));
    if (!foes.includes(trigger)) foes.push(trigger);
    audio.play('melee');
    const article = /^[aeiou]/i.test(trigger.name) ? 'An' : 'A';
    this.log(foes.length === 1
      ? `Battle! ${article} ${trigger.name} blocks your path!`
      : `Battle! ${foes.length} monsters close in!`, 'info');
    const names = Object.keys(this.data.tactics);
    const pick = this.data.tactics[names[Math.floor(Math.random() * names.length)]];
    this.battle = new Battle(this, pick, foes);
  }

  endPlayerTurn() {
    this.updateVision(); // doors opening (etc.) change what the party can see
    this.advanceTime(1);
    if (this.over) return;
    this.monstersAct();
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
      if (m.speed > 1 && this.turn % m.speed !== 0) continue; // slow monsters skip turns
      const dx = this.partyPos.x - m.x, dy = this.partyPos.y - m.y;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      if (dist <= 1) {
        this.log(`The ${m.name} catches the party!`, 'info');
        this.startBattle(m);
        return; // battle takes over; the rest of the map freezes
      } else if (dist <= MONSTER_AGGRO_RANGE && this.isVisible(m.x, m.y)) {
        this.monsterStep(m, dx, dy);
        if (Math.max(Math.abs(this.partyPos.x - m.x), Math.abs(this.partyPos.y - m.y)) <= 1) {
          this.log(`The ${m.name} catches the party!`, 'info');
          this.startBattle(m);
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
