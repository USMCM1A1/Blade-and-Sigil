// Tactical battle (Phase 3a): an abstract battlefield built from a template
// in data/tactics/. Each side starts on its own edge, initiative decides the
// turn order, and every combatant moves and fights on their own square.

import { roll, d20, abilityMod } from './rules.js';
import { DataError } from './loader.js';
import * as audio from './audio.js';

export const GRID_W = 13, GRID_H = 8;
const HERO_MOVE = 4;
const monsterMove = m => (m.speed > 1 ? 2 : 4); // map-slow monsters are battle-slow too

export class Battle {
  constructor(game, template, foes) {
    this.game = game;
    this.round = 1;
    this.templateName = template.name;
    this.mode = 'move';   // 'move' | 'menu' | 'target'
    this.pending = null;  // the spell or shot being aimed
    this.cursor = null;   // targeting crosshair {x, y}
    this.fx = [];         // floating combat text: {x, y, text, color, born}
    this.busy = false;    // true while a monster acts (player input locked)
    for (const ch of game.party) ch.buffs = { hit: 0, dmg: 0 }; // buffs last one battle
    this.parseTemplate(template);
    this.placeCombatants(foes);
    this.rollInitiative();
    this.turnIdx = -1;
    this.nextTurn(); // also auto-runs leading monster turns
  }

  parseTemplate(template) {
    const rows = template.map;
    if (rows.length !== GRID_H || rows.some(r => r.length !== GRID_W)) {
      throw new DataError(`data/tactics/${template.file || ''}`, `Tactical map "${template.name}" must be exactly ${GRID_W} wide and ${GRID_H} tall.`);
    }
    this.walls = [];
    this.spawns = { f: [], b: [], m: [] };
    this.grid = rows.map((row, y) => row.split('').map((c, x) => {
      if (c === '#') return '#';
      if (c === 'f' || c === 'b' || c === 'm') { this.spawns[c].push({ x, y }); return '.'; }
      if (c !== '.') throw new DataError('data/tactics/', `Unknown symbol "${c}" in tactical map "${template.name}" (row ${y + 1}, col ${x + 1}). Use # . f b m.`);
      return '.';
    }));
  }

  occupied(x, y) { return this.combatants.some(c => c.alivePos() && c.x === x && c.y === y); }
  open(x, y) { return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H && this.grid[y][x] === '.' && !this.occupied(x, y); }

  nearestOpen(sx, sy) {
    // BFS ring search so overflow combatants land close to their spawn zone.
    const q = [[sx, sy]], seen = new Set([sy * GRID_W + sx]);
    while (q.length) {
      const [x, y] = q.shift();
      if (this.open(x, y)) return { x, y };
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, k = ny * GRID_W + nx;
        if (nx >= 0 && ny >= 0 && nx < GRID_W && ny < GRID_H && !seen.has(k)) { seen.add(k); q.push([nx, ny]); }
      }
    }
    return { x: sx, y: sy };
  }

  placeCombatants(foes) {
    this.combatants = [];
    const take = (list, fallback) => list.length ? list.shift() : this.nearestOpen(fallback.x, fallback.y);
    const fSpawns = [...this.spawns.f], bSpawns = [...this.spawns.b], mSpawns = [...this.spawns.m];
    for (const ch of this.game.party) {
      const wantsFront = ch.row === 'front';
      const pool = wantsFront ? (fSpawns.length ? fSpawns : bSpawns) : (bSpawns.length ? bSpawns : fSpawns);
      const spot = take(pool, { x: wantsFront ? 3 : 1, y: 3 });
      this.combatants.push({ kind: 'hero', ref: ch, x: spot.x, y: spot.y, alivePos: () => true });
    }
    for (const m of foes) {
      const spot = take(mSpawns, { x: GRID_W - 2, y: 3 });
      this.combatants.push({ kind: 'monster', ref: m, x: spot.x, y: spot.y, alivePos: () => m.hp > 0 });
    }
    // Dead heroes still hold a square (a fallen body); dead monsters vanish.
  }

  rollInitiative() {
    for (const c of this.combatants) {
      c.init = d20() + (c.kind === 'hero' ? abilityMod(c.ref.abilities.dex) : 0);
    }
    this.combatants.sort((a, b) => b.init - a.init || (a.kind === 'hero' ? -1 : 1));
    const order = this.combatants.map(c => `${c.ref.name} ${c.init}`).join(', ');
    this.game.log(`Initiative: ${order}.`, 'info');
  }

  active() { return this.combatants[this.turnIdx]; }
  heroes() { return this.combatants.filter(c => c.kind === 'hero'); }
  monsters() { return this.combatants.filter(c => c.kind === 'monster' && c.ref.hp > 0); }
  heroAt(x, y) { return this.heroes().find(c => c.ref.alive && c.x === x && c.y === y); }
  monsterAt(x, y) { return this.monsters().find(c => c.x === x && c.y === y); }

  // ---- Turn order ----
  // Monster turns are paced with a short delay (and a red ring in the
  // renderer) so the player can see who is acting — instant retaliation
  // reads as noise. `busy` locks player input while a monster acts.
  nextTurn() {
    if (this.finished()) return;
    for (let hop = 0; hop < this.combatants.length + 1; hop++) {
      this.turnIdx++;
      if (this.turnIdx >= this.combatants.length) {
        this.turnIdx = 0;
        this.round++;
      }
      const c = this.active();
      if (c.kind === 'hero' && c.ref.alive) {
        const verdict = this.tickConditions(c); // burn ticks, paralysis check
        if (this.checkEnd()) return;
        if (verdict === 'dead') continue;
        if (verdict === 'skip') {
          this.busy = true;
          setTimeout(() => {
            if (this.game.battle !== this) return;
            this.nextTurn();
          }, 800);
          return;
        }
        this.movesLeft = HERO_MOVE;
        this.busy = false;
        return;
      }
      if (c.kind === 'monster' && c.ref.hp > 0) {
        if (c.ref.speed > 1 && this.round % c.ref.speed !== 0) continue; // slow monsters sit out odd rounds
        this.busy = true;
        setTimeout(() => {
          if (this.game.battle !== this || c.ref.hp <= 0) return;
          const verdict = this.tickConditions(c);
          if (this.checkEnd()) return;
          if (verdict !== 'dead' && verdict !== 'skip') this.monsterTurn(c);
          if (this.checkEnd()) return;
          this.nextTurn();
        }, 600);
        return;
      }
    }
    this.busy = false;
  }

  // Tick this combatant's conditions at the start of their turn.
  // Returns 'dead', 'skip', or 'act'.
  tickConditions(c) {
    const ref = c.ref;
    let verdict = 'act';
    for (const cond of [...ref.conditions]) {
      const def = this.game.conditionDef(cond.id);
      if (!def) continue;
      if (def.effect === 'damage') {
        const dmg = Math.max(1, roll(def.dice));
        ref.hp -= dmg;
        this.addFx(c.x, c.y, `-${dmg} ${def.name.toLowerCase()}`, def.color);
        this.game.log(`${ref.name} suffers ${dmg} damage from ${def.name.toLowerCase()}.`);
      } else if (def.effect === 'skip') {
        this.addFx(c.x, c.y, def.name, def.color);
        this.game.log(`${ref.name} is ${def.name.toLowerCase()} and cannot act!`);
        verdict = 'skip';
      }
      cond.rounds--;
      if (cond.rounds <= 0) {
        ref.conditions = ref.conditions.filter(x => x !== cond);
        this.game.log(`${ref.name} recovers from ${def.name.toLowerCase()}.`, 'good');
      }
    }
    if (ref.hp <= 0) {
      if (c.kind === 'monster') {
        this.slay(ref);
      } else {
        ref.hp = 0;
        ref.alive = false;
        this.addFx(c.x, c.y, 'FALLEN', '#b03535');
        this.game.log(`${ref.name} has fallen!`, 'death');
      }
      return 'dead';
    }
    return verdict;
  }

  // Something tries to inflict a condition: the victim saves against the DC.
  tryInflict(targetC, condId, rounds, dc) {
    const def = this.game.conditionDef(condId);
    if (!def) return;
    const ref = targetC.ref;
    const bonus = targetC.kind === 'monster'
      ? (ref.save ?? 0)
      : abilityMod(ref.abilities[def.save ?? 'con']) + (ref.race.save_bonus ?? 0);
    if (d20() + bonus >= dc) {
      this.addFx(targetC.x, targetC.y, 'resisted', '#9a94a8');
      this.game.log(`${ref.name} resists the ${def.name.toLowerCase()}.`);
      return;
    }
    this.game.applyCondition(ref, condId, rounds);
    this.addFx(targetC.x, targetC.y, def.name + '!', def.color);
  }

  // Squares the active hero can still walk to (for the renderer's highlight).
  reachable() {
    const c = this.active();
    if (!c || c.kind !== 'hero') return new Set();
    const out = new Set();
    let frontier = [[c.x, c.y]];
    const seen = new Set([c.y * GRID_W + c.x]);
    for (let step = 0; step < this.movesLeft; step++) {
      const next = [];
      for (const [x, y] of frontier) {
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy, k = ny * GRID_W + nx;
          if (!seen.has(k) && this.open(nx, ny)) {
            seen.add(k); out.add(k); next.push([nx, ny]);
          }
        }
      }
      frontier = next;
    }
    return out;
  }

  // ---- Hero actions ----
  heroMove(dx, dy) {
    const c = this.active();
    if (!c || c.kind !== 'hero') return;
    const nx = c.x + dx, ny = c.y + dy;
    const foe = this.monsterAt(nx, ny);
    if (foe) { this.heroAttack(c, foe); return; }
    if (this.movesLeft <= 0 || !this.open(nx, ny)) return;
    c.x = nx; c.y = ny;
    this.movesLeft--;
  }

  // Floating combat text, drawn by the renderer right on the battlefield.
  addFx(x, y, text, color) {
    this.fx.push({ x, y, text, color, born: performance.now() });
  }

  fxOn(ref, text, color) {
    const c = this.combatants.find(cc => cc.ref === ref);
    if (c) this.addFx(c.x, c.y, text, color);
  }

  // Melee: STR. Ranged weapons (a "range" on the weapon): DEX. Buffs stack.
  attackBonus(ch) { return ch.hitBase + abilityMod(ch.weapon.range ? ch.abilities.dex : ch.abilities.str) + ch.buffs.hit; }
  damageBonus(ch) { return ch.hitBase + abilityMod(ch.weapon.range ? ch.abilities.dex : ch.abilities.str) + ch.buffs.dmg; }

  heroAttack(c, foeC, verb = 'swings') {
    const ch = c.ref, monster = foeC.ref;
    audio.play('melee');
    for (let a = 0; a < ch.attacks && monster.hp > 0; a++) {
      if (d20() + this.attackBonus(ch) >= 10 + monster.ac) {
        const dmg = Math.max(1, roll(ch.weapon.damage) + this.damageBonus(ch));
        monster.hp -= dmg;
        this.addFx(foeC.x, foeC.y, `-${dmg}`, '#ff6a4a');
        this.game.log(`${ch.name} hits the ${monster.name} with ${ch.weapon.name.toLowerCase()} for ${dmg} damage.`);
      } else {
        this.addFx(foeC.x, foeC.y, 'miss', '#9a94a8');
        this.game.log(`${ch.name} ${verb} at the ${monster.name} and misses.`);
      }
    }
    if (monster.hp <= 0) this.slay(monster);
    this.endHeroTurn();
  }

  // ---- Spells & ranged attacks (Phase 3b) ----
  losClear(x0, y0, x1, y1) {
    let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy, x = x0, y = y0;
    while (true) {
      if (x === x1 && y === y1) return true;
      if ((x !== x0 || y !== y0) && this.grid[y][x] === '#') return false;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }

  dist(ax, ay, bx, by) { return Math.max(Math.abs(ax - bx), Math.abs(ay - by)); }

  castables(c) {
    const spells = this.game.data.spells?.spells ?? {};
    return Object.entries(spells)
      .filter(([, s]) => s.classes.includes(this.classId(c.ref)))
      .map(([id, s]) => ({ id, ...s, affordable: this.game.arena || c.ref.sp >= s.cost }));
  }

  classId(ch) {
    const classes = this.game.data.classes.classes;
    return Object.keys(classes).find(k => classes[k] === ch.cls);
  }

  canShoot(c) { return !!c.ref.weapon.range; }

  openMenu() {
    const c = this.active();
    if (!c || c.kind !== 'hero') return;
    if (!this.castables(c).length) {
      this.game.log(`${c.ref.name} knows no spells.`, 'info');
      return;
    }
    this.mode = 'menu';
  }

  chooseSpell(n) {
    const c = this.active();
    const list = this.castables(c);
    const s = list[n - 1];
    if (!s) return;
    if (!s.affordable) {
      this.addFx(c.x, c.y, 'not enough SP', '#9a94a8');
      this.game.log(`${c.ref.name} lacks the spell points for ${s.name}.`, 'info');
      return;
    }
    if (s.type === 'buff') { this.mode = 'move'; this.castBuff(c, s); return; }
    this.pending = { kind: 'spell', spell: s, range: s.range };
    this.beginTargeting(s.type === 'heal');
  }

  beginShoot() {
    const c = this.active();
    if (!c || c.kind !== 'hero' || !this.canShoot(c)) return;
    this.pending = { kind: 'shoot', range: c.ref.weapon.range };
    this.beginTargeting(false);
  }

  // A square the crosshair may occupy: in range AND in line of sight.
  // The cursor is hard-clamped to these — you can never aim at what you
  // cannot legally hit.
  targetable(x, y) {
    const c = this.active();
    return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H
      && this.dist(c.x, c.y, x, y) <= this.pending.range
      && this.losClear(c.x, c.y, x, y);
  }

  beginTargeting(friendly) {
    const c = this.active();
    this.mode = 'target';
    // Start the crosshair on the most obvious LEGAL target; if nothing is
    // in reach, fall back to the caster's own square so the player sees
    // the range ring around themselves rather than a phantom lock-on.
    const candidates = friendly
      ? this.heroes().filter(h => h.ref.alive && h.ref.hp < h.ref.maxHp)
      : this.monsters();
    const pick = candidates
      .filter(t => this.targetable(t.x, t.y))
      .sort((a, b) => this.dist(c.x, c.y, a.x, a.y) - this.dist(c.x, c.y, b.x, b.y))[0];
    this.cursor = pick ? { x: pick.x, y: pick.y } : { x: c.x, y: c.y };
    if (!pick) this.game.log('Nothing in range — move closer, or Esc to cancel.', 'info');
  }

  moveCursor(dx, dy) {
    if (this.mode !== 'target') return;
    const nx = this.cursor.x + dx, ny = this.cursor.y + dy;
    if (this.targetable(nx, ny)) { this.cursor.x = nx; this.cursor.y = ny; }
  }

  cursorValid() {
    return this.targetable(this.cursor.x, this.cursor.y);
  }

  cancelTargeting() {
    this.mode = 'move';
    this.pending = null;
    this.cursor = null;
  }

  confirm() {
    if (this.mode !== 'target' || !this.cursorValid()) return;
    const c = this.active();
    const p = this.pending;
    const { x, y } = this.cursor;

    if (p.kind === 'shoot') {
      const foe = this.monsterAt(x, y);
      if (!foe) return; // keep aiming
      this.cancelTargeting();
      audio.play('arrow');
      this.heroAttack(c, foe, 'shoots'); // ends the turn
      return;
    }

    const s = p.spell;
    if (s.type === 'heal') {
      const ally = this.heroAt(x, y);
      if (!ally || !ally.ref.alive) return;
      this.cancelTargeting();
      if (!this.game.arena) c.ref.sp -= s.cost; // training is free
      const amount = Math.max(1, roll(s.dice) + abilityMod(c.ref.abilities[s.stat]));
      const healed = Math.min(amount, ally.ref.maxHp - ally.ref.hp);
      ally.ref.hp += healed;
      audio.play('spell');
      this.addFx(x, y, `+${healed}`, '#6ad46a');
      this.game.log(`${c.ref.name} casts ${s.name} — ${ally.ref.name} recovers ${healed} HP.`, 'good');
      this.endHeroTurn();
      return;
    }

    // Affliction spell: no damage — the target saves or gains the condition.
    if (s.type === 'afflict') {
      const foeC = this.monsterAt(x, y);
      if (!foeC) return;
      this.cancelTargeting();
      if (!this.game.arena) c.ref.sp -= s.cost; // training is free
      audio.play('spell');
      this.game.log(`${c.ref.name} casts ${s.name}!`, 'info');
      const statMod = abilityMod(c.ref.abilities[s.stat]);
      this.tryInflict(foeC, s.condition.id, s.condition.rounds, 10 + s.level + statMod);
      this.endHeroTurn();
      return;
    }

    // Damage spell: single target needs a monster; a burst just needs ground.
    // Spells never miss — targets roll a saving throw for half damage instead
    // (d20 + save bonus vs DC 10 + spell level + caster's stat mod).
    if (!s.area && !this.monsterAt(x, y)) return;
    this.cancelTargeting();
    if (!this.game.arena) c.ref.sp -= s.cost; // training is free
    audio.play('spell');
    this.game.log(`${c.ref.name} casts ${s.name}!`, 'info');
    const statMod = abilityMod(c.ref.abilities[s.stat]);
    const dc = 10 + s.level + statMod;
    const targets = [];
    for (const t of [...this.monsters(), ...this.heroes().filter(h => h.ref.alive)]) {
      if (this.dist(t.x, t.y, x, y) <= s.area && !(s.area === 0 && t.kind === 'hero')) {
        if (t === c && s.area === 0) continue;
        targets.push(t);
      }
    }
    for (const t of targets) {
      const ref = t.ref;
      let dmg = Math.max(1, roll(s.dice) + statMod);
      let saved = false;
      if (!s.auto && s.save) {
        const bonus = t.kind === 'monster'
          ? (ref.save ?? 0)
          : abilityMod(ref.abilities[s.save]) + (ref.race.save_bonus ?? 0);
        saved = d20() + bonus >= dc;
      }
      if (saved) dmg = Math.floor(dmg / 2);
      if (saved && dmg <= 0) {
        this.addFx(t.x, t.y, 'resisted', '#9a94a8');
        this.game.log(`${ref.name} shrugs off the ${s.name.toLowerCase()}.`);
        continue;
      }
      ref.hp -= dmg;
      this.addFx(t.x, t.y, `-${dmg}`, saved ? '#d8c06a' : '#ffb04a');
      this.game.log(saved
        ? `${ref.name} twists aside — only ${dmg} damage.`
        : `${ref.name} is seared for ${dmg} damage!`);
      if (ref.hp > 0 && s.condition && !saved) {
        this.game.applyCondition(ref, s.condition.id, s.condition.rounds);
        const cdef = this.game.conditionDef(s.condition.id);
        if (cdef) this.addFx(t.x, t.y, cdef.name + '!', cdef.color);
      }
      if (t.kind === 'monster' && ref.hp <= 0) this.slay(ref);
      if (t.kind === 'hero' && ref.hp <= 0) {
        ref.hp = 0;
        ref.alive = false;
        this.addFx(t.x, t.y, 'FALLEN', '#b03535');
        this.game.log(`${ref.name} has fallen!`, 'death');
      }
    }
    this.endHeroTurn();
  }

  castBuff(c, s) {
    if (!this.game.arena) c.ref.sp -= s.cost; // training is free
    audio.play('spell');
    const targets = s.targets === 'self' ? [c.ref] : this.game.party.filter(ch => ch.alive);
    for (const ch of targets) {
      ch.buffs.hit += s.hit ?? 0;
      ch.buffs.dmg += s.dmg ?? 0;
      this.fxOn(ch, s.name, '#d4a94e');
    }
    this.game.log(`${c.ref.name} casts ${s.name}! ${s.description}.`, 'good');
    this.endHeroTurn();
  }

  endHeroTurn() {
    if (this.checkEnd()) return;
    this.nextTurn();
    this.checkEnd();
  }

  // ---- Monster AI: walk toward the nearest living hero, attack if adjacent ----
  monsterTurn(c) {
    const m = c.ref;
    for (let step = 0; step <= monsterMove(m); step++) {
      const target = this.adjacentHero(c);
      if (target) { this.monsterAttack(m, target.ref); return; }
      if (step === monsterMove(m)) return;
      if (!this.stepToward(c)) return; // boxed in
    }
  }

  adjacentHero(c) {
    const near = this.heroes().filter(h => h.ref.alive && Math.abs(h.x - c.x) + Math.abs(h.y - c.y) === 1);
    if (!near.length) return null;
    return near[Math.floor(Math.random() * near.length)];
  }

  stepToward(c) {
    // BFS to the closest square adjacent to a living hero, then take the first step.
    const targets = new Set();
    for (const h of this.heroes()) {
      if (!h.ref.alive) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = h.x + dx, y = h.y + dy;
        if (this.open(x, y) || (x === c.x && y === c.y)) targets.add(y * GRID_W + x);
      }
    }
    if (!targets.size) return false;
    const prev = new Map([[c.y * GRID_W + c.x, null]]);
    const q = [[c.x, c.y]];
    let found = null;
    while (q.length && found === null) {
      const [x, y] = q.shift();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, k = ny * GRID_W + nx;
        if (prev.has(k) || !this.open(nx, ny)) continue;
        prev.set(k, y * GRID_W + x);
        if (targets.has(k)) { found = k; break; }
        q.push([nx, ny]);
      }
    }
    if (found === null) return false;
    let k = found;
    while (prev.get(k) !== c.y * GRID_W + c.x) k = prev.get(k);
    c.x = k % GRID_W; c.y = Math.floor(k / GRID_W);
    return true;
  }

  monsterAttack(m, target) {
    if (d20() + m.to_hit >= target.ac) {
      const dmg = Math.max(1, roll(m.damage));
      target.hp -= dmg;
      audio.play('melee');
      this.fxOn(target, `-${dmg}`, '#ff6a4a');
      this.game.log(`The ${m.name} strikes ${target.name} for ${dmg} damage!`);
      if (target.hp <= 0) {
        target.hp = 0;
        target.alive = false;
        this.fxOn(target, 'FALLEN', '#b03535');
        this.game.log(`${target.name} has fallen!`, 'death');
      } else if (m.inflicts) {
        const tc = this.combatants.find(cc => cc.ref === target);
        if (tc) this.tryInflict(tc, m.inflicts.condition, m.inflicts.rounds, m.inflicts.dc);
      }
    } else {
      this.fxOn(target, 'miss', '#9a94a8');
      this.game.log(`The ${m.name} lunges at ${target.name} but misses.`);
    }
  }

  slay(monster) {
    this.game.monsters = this.game.monsters.filter(x => x !== monster);
    const c = this.combatants.find(cc => cc.ref === monster);
    if (c) {
      c.diedAt = performance.now(); // the renderer shows the body falling
      this.addFx(c.x, c.y, 'slain!', '#e0483a');
    }
    if (this.game.arena) {
      this.game.log(`The ${monster.name} collapses. (No XP in the training arena.)`, 'good');
      return;
    }
    this.game.log(`The ${monster.name} is slain! Each hero gains ${monster.xp} XP.`, 'good');
    for (const ch of this.game.party) if (ch.alive) ch.xp += monster.xp;
  }

  finished() {
    return !this.monsters().length || this.game.party.every(ch => !ch.alive);
  }

  // The battle doesn't cut away on the killing blow: the field stays up for
  // a beat so the numbers land, the body falls, and the banner shows —
  // THEN the map returns.
  checkEnd() {
    const game = this.game;
    if (this.ending) return true;
    if (game.arena) {
      // Arena endings never touch the real game: win or wipe, the party is
      // restored from the entry snapshot and steps back onto the map.
      const wipe = game.party.every(ch => !ch.alive);
      if (!wipe && this.monsters().length) return false;
      this.ending = wipe ? 'defeat' : 'victory';
      this.endedAt = performance.now();
      this.busy = true;
      if (!wipe) audio.play('victory');
      setTimeout(() => {
        if (game.battle !== this) return;
        game.battle = null;
        game.endArena();
      }, 2000);
      return true;
    }
    if (game.party.every(ch => !ch.alive)) {
      this.ending = 'defeat';
      this.endedAt = performance.now();
      this.busy = true; // input locked while the scene plays out
      game.over = true;
      game.log('The entire party has fallen. Darkness claims the Vermin Warrens. Press R to try again.', 'death');
      setTimeout(() => { if (game.battle === this) game.battle = null; }, 2400);
      return true;
    }
    if (!this.monsters().length) {
      this.ending = 'victory';
      this.endedAt = performance.now();
      this.busy = true;
      this.stripBattleConditions(); // burning etc. gutter out when the fight ends
      audio.play('victory');
      game.log('The battlefield falls silent. The party stands victorious.', 'good');
      setTimeout(() => {
        if (game.battle === this) {
          game.battle = null;
          game.updateVision();
        }
      }, 2000);
      return true;
    }
    return false;
  }

  stripBattleConditions() {
    for (const ch of this.game.party) {
      ch.conditions = ch.conditions.filter(c => this.game.conditionDef(c.id)?.lingers);
    }
  }

  flee() {
    if (this.game.arena) {
      this.game.battle = null;
      this.game.endArena();
      return;
    }
    this.stripBattleConditions();
    this.game.battle = null;
    this.game.log('The party breaks away from the fight!', 'info');
  }
}
