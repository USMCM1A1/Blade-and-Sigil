// Tactical battle (Phase 3a): an abstract battlefield built from a template
// in data/tactics/. Each side starts on its own edge, initiative decides the
// turn order, and every combatant moves and fights on their own square.

import { roll, d20, maxRoll, abilityMod } from './rules.js';
import { DataError } from './loader.js';
import { laneOf, passiveOf, hasVerb, hasCapstone, hasRefinement, riteOf } from './progression.js';
import * as audio from './audio.js';

// Sum of a field across a hero's timed buffs (Rage etc.).
const timedSum = (ref, key) => (ref.timedBuffs ?? []).reduce((s, b) => s + (b[key] || 0), 0);

export const GRID_W = 13, GRID_H = 8;
const HERO_MOVE = 4;
const monsterMove = m => (m.speed > 1 ? 2 : 4); // map-slow monsters are battle-slow too

export class Battle {
  constructor(game, template, foes, opts = {}) {
    this.game = game;
    this.ambush = !!opts.ambush; // monsters caught the party: they start on top of you
    this.round = 1;
    this.templateName = template.name;
    this.mode = 'move';   // 'move' | 'menu' | 'target'
    this.pending = null;  // the spell or shot being aimed
    this.cursor = null;   // targeting crosshair {x, y}
    this.fx = [];         // floating combat text: {x, y, text, color, born}
    this.busy = false;    // true while a monster acts (player input locked)
    this.pendingReaction = null; // Guardian's Stand: an ally's Y/N moment
    this.taunt = null;    // Bulwark's taunt: {c, until} — monsters strike the knight
    this.fleeing = false; // parting blows allow no heroics
    this.battleTraps = []; // Burglar's Set Trap: {x, y, owner, dice}
    for (const ch of game.party) {
      ch.buffs = { hit: 0, dmg: 0 }; // buffs last one battle
      ch.timedBuffs = [];
      // Stealthy classes (thief: "stealthy" in classes.json) slip ahead as
      // the party forces a fight — they BEGIN hidden, so their opening
      // strike always lands on the unaware (the Blade Work rogue's whole
      // livelihood). Ambushed parties get no such grace.
      ch.hidden = !this.ambush && ch.alive && !!ch.cls.stealthy;
      if (ch.hidden) game.log(`${ch.name} slips into the shadows as the fight begins.`, 'good');
    }
    // A hero with an unmade choice fights WITHOUT the powers it unlocks —
    // say so, or the player hunts the C menu for verbs that don't exist yet.
    for (const owed of game.choiceQueue) {
      if (owed.type === 'lane') game.log(`${owed.ch.name} walks no path yet — the crossroads (and every power beyond it) waits on the map.`, 'info');
      if (owed.type === 'focus') game.log(`${owed.ch.name} has not chosen a Weapon Focus — that +1 waits on the map.`, 'info');
      if (owed.type === 'rite') game.log(`${owed.ch.name}'s Rite is unfinished — their unique power sleeps until the ceremony is held (it begins on the map).`, 'info');
    }
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
    // Ambushed (the monsters caught the party): they pour in right on top of
    // the front line instead of forming up across the field — fleeing and
    // re-engaging never buys free distance.
    const anchors = this.combatants
      .filter(c => c.ref.alive)
      .sort((a, b) => (a.ref.row === 'front' ? 0 : 1) - (b.ref.row === 'front' ? 0 : 1));
    foes.forEach((m, i) => {
      const spot = this.ambush && anchors.length
        ? (() => { const a = anchors[i % anchors.length]; return this.nearestOpen(a.x + 1, a.y); })()
        : take(mSpawns, { x: GRID_W - 2, y: 3 });
      // Stealth: when the PARTY forces the fight, the enemy is caught flat —
      // every monster starts UNAWARE until its first turn (or first wound).
      // Monsters that caught the party (ambush) were ready all along.
      this.combatants.push({ kind: 'monster', ref: m, x: spot.x, y: spot.y, aware: this.ambush, alivePos: () => m.hp > 0 });
    });
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
        // Timed powers (Rage) burn down at the start of their owner's turn.
        for (const b of [...(c.ref.timedBuffs ?? [])]) {
          b.rounds--;
          if (b.rounds <= 0) {
            c.ref.timedBuffs = c.ref.timedBuffs.filter(x => x !== b);
            this.addFx(c.x, c.y, `${b.name} fades`, '#9a94a8');
            this.game.log(`${c.ref.name}'s ${b.name.toLowerCase()} fades.`);
          }
        }
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
        c.aware = true; // its turn has come — the moment of surprise is over
        if (c.ref.speed > 1 && this.round % c.ref.speed !== 0) continue; // slow monsters sit out odd rounds
        this.busy = true;
        setTimeout(() => {
          if (this.game.battle !== this || c.ref.hp <= 0) return;
          const verdict = this.tickConditions(c);
          if (this.checkEnd()) return;
          if (verdict !== 'dead' && verdict !== 'skip') this.monsterTurn(c);
          if (this.pendingReaction) return; // frozen mid-blow — resolveReaction resumes
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

  // Melee: STR. Ranged weapons (a "range" on the weapon): DEX. Buffs stack —
  // battle buffs (spells), timed buffs (Rage), and the Weapon Focus passive.
  // Both rolls are built from NAMED parts so the log can show the player
  // exactly where every point came from (a designer rule: math is reward).
  // DESIGN RULE (user, 2026-08-24): every bonus wears the NAME of the thing
  // that granted it — "+2 Thief +1 Blade Work", never a generic "+3 skill".
  // Seeing the named +1 is the reward for having earned it.
  baseParts(ch) {
    const parts = [];
    const lane = laneOf(this.game.data, ch);
    const laneHit = lane?.offsets?.hit ?? 0;
    const classHit = ch.hitBase - laneHit; // the class table's share
    if (classHit) parts.push([classHit, ch.cls.name]);
    if (laneHit) parts.push([laneHit, lane.name]);
    const ab = abilityMod(ch.weapon.range ? ch.abilities.dex : ch.abilities.str);
    if (ab) parts.push([ab, ch.weapon.range ? 'DEX' : 'STR']);
    return parts;
  }

  attackParts(ch) {
    const parts = this.baseParts(ch);
    if (ch.buffs.hit) parts.push([ch.buffs.hit, ch.buffs.sources?.join(' & ') || 'blessing']);
    for (const b of ch.timedBuffs ?? []) if (b.hit) parts.push([b.hit, b.name]);
    return parts;
  }

  // opts.vital: 'unaware' | 'flanked' when Vital Strike applies this swing.
  damageParts(ch, opts = {}) {
    const parts = this.baseParts(ch);
    if (ch.buffs.dmg) parts.push([ch.buffs.dmg, ch.buffs.sources?.join(' & ') || 'blessing']);
    for (const b of ch.timedBuffs ?? []) if (b.dmg) parts.push([b.dmg, b.name]);
    if (ch.gearDmg) parts.push([ch.gearDmg, 'gear']);
    const p = passiveOf(this.game.data, ch);
    if (p?.id === 'weapon_focus' && ch.focusType && ch.weapon.type === `weapon_${ch.focusType}`) {
      parts.push([p.dmg ?? 1, 'Weapon Focus']);
    }
    if (p?.id === 'vital_strike' && opts.vital) parts.push([p.dmg ?? 2, `Vital Strike, ${opts.vital}`]);
    return parts;
  }

  sumParts(parts) { return parts.reduce((s, [v]) => s + v, 0); }
  fmtParts(parts) { return parts.map(([v, l]) => ` ${v > 0 ? '+' : '−'}${Math.abs(v)} ${l}`).join(''); }

  attackBonus(ch) { return this.sumParts(this.attackParts(ch)); }
  damageBonus(ch) { return this.sumParts(this.damageParts(ch)); }
  heroAttacks(ch) { return ch.attacks + timedSum(ch, 'attacks'); } // Rage grants extras

  // ---- Stealth & awareness (the Thief stage) ----
  // A foe is UNAWARE of an attacker until its first turn in a fight the
  // party started (surprise!), or whenever the attacker is hidden (Vanish).
  isUnaware(foeC, attackerRef) { return !foeC.aware || !!attackerRef?.hidden; }
  // A foe hemmed in by two or more living heroes is flanked.
  isFlanked(foeC) {
    return this.heroes().filter(h =>
      h.ref.alive && Math.abs(h.x - foeC.x) + Math.abs(h.y - foeC.y) === 1).length >= 2;
  }
  // Lethality's demand: no OTHER party member beside the mark.
  isIsolated(foeC, attackerC) {
    return !this.heroes().some(h =>
      h !== attackerC && h.ref.alive && Math.abs(h.x - foeC.x) + Math.abs(h.y - foeC.y) === 1);
  }

  // Does this swing trigger Assassinate? Level 10: the mark is unaware.
  // Level 15 (Lethality): also demands the mark stand alone. Level 18: the
  // badly wounded (below a quarter) are marks too, aware or not.
  assassinateTriggers(c, foeC) {
    const ch = c.ref;
    if (!hasVerb(this.game.data, ch, 'assassinate')) return false;
    if (this.forceAssassinate) return true; // Deathblow ignores every condition
    if (ch.weapon.range) return false;
    const lowHp = hasRefinement(this.game.data, ch, 'assassinate_low_hp')
      && foeC.ref.hp <= Math.floor(foeC.ref.maxHp / 4);
    if (!this.isUnaware(foeC, ch) && !lowHp) return false;
    if (hasCapstone(this.game.data, ch, 'lethality') && !this.isIsolated(foeC, c)) return false;
    return true;
  }

  // One swing (or shot). A natural 20 always hits and crits; a crit deals
  // the weapon's maximum PLUS a fresh damage roll (the full-crit rule —
  // a proposal, tune freely). Assassinate turns a swing on a valid mark
  // into an automatic crit; Lethality doubles it. Vital Strike adds its
  // bonus against the unaware and the flanked. Returns what happened so
  // Rampage can chain and Assassinate kills can be counted.
  // Assassinate WOULD fire, except Lethality's isolation demand blocks it.
  // Surfaced everywhere (log + bump preview): a power that silently refuses
  // reads as a power that doesn't work.
  assassinateGuarded(c, foeC) {
    const ch = c.ref;
    return hasVerb(this.game.data, ch, 'assassinate') && !ch.weapon.range
      && this.isUnaware(foeC, ch)
      && hasCapstone(this.game.data, ch, 'lethality') && !this.isIsolated(foeC, c);
  }

  strike(c, foeC, verb) {
    const ch = c.ref, monster = foeC.ref;
    const assassinate = this.assassinateTriggers(c, foeC);
    if (!assassinate && this.assassinateGuarded(c, foeC)) {
      this.addFx(foeC.x, foeC.y, 'guarded!', '#9a94a8');
      this.game.log(`The ${monster.name} is unaware — but an ally stands beside it, and Lethality strikes only the isolated. No Assassinate.`, 'info');
    }
    const wasHidden = !!ch.hidden;
    const vital = this.isUnaware(foeC, ch) ? 'unaware' : this.isFlanked(foeC) ? 'flanked' : null;
    ch.hidden = false;   // the strike itself steps out of the shadows
    foeC.aware = true;   // one way or another, they know NOW
    const die = d20();
    const crit = die === 20 || assassinate;
    const atkParts = this.attackParts(ch);
    const atkTotal = die + this.sumParts(atkParts);
    const ac = 10 + monster.ac;
    if (crit || atkTotal >= ac) {
      // The full-crit rule: the weapon's maximum plus a fresh damage roll.
      const critExtra = crit ? Math.max(0, roll(ch.weapon.damage)) : 0;
      const base = crit ? maxRoll(ch.weapon.damage) + critExtra : roll(ch.weapon.damage);
      const dmgParts = this.damageParts(ch, { vital });
      let dmg = Math.max(1, base + this.sumParts(dmgParts));
      let label = crit ? `-${dmg}!!` : `-${dmg}`;
      let lethal = 0;
      if (assassinate && hasCapstone(this.game.data, ch, 'lethality')) {
        lethal = laneOf(this.game.data, ch).capstone.multiplier ?? 2;
        dmg *= lethal;
        label = `-${dmg}!!!`;
      }
      monster.hp -= dmg;
      if (assassinate) this.addFx(foeC.x, foeC.y, 'ASSASSINATE!', '#b03a8e');
      else if (vital && dmgParts.some(([, l]) => l.startsWith('Vital'))) {
        this.addFx(foeC.x, foeC.y, vital === 'unaware' ? 'vital: unaware!' : 'vital: flanked!', '#b03a8e');
      }
      this.addFx(foeC.x, foeC.y, label, crit ? '#ffd24a' : '#ff6a4a');
      // The math, spelled out: every bonus by name, so a +1 FEELS like a +1.
      const toHit = assassinate ? 'auto-hit' : crit ? 'natural 20!' : `d20 ${die}${this.fmtParts(atkParts)} = ${atkTotal} vs AC ${ac}`;
      const dmgMath = `${crit ? `max ${maxRoll(ch.weapon.damage)} + ${ch.weapon.damage} → ${critExtra}` : `${ch.weapon.damage} → ${base}`}${this.fmtParts(dmgParts)}${lethal ? ` = ${dmg / lethal}, ×${lethal} Lethality` : ''} = ${dmg}`;
      this.game.log(assassinate
        ? `${ch.name} strikes from ${wasHidden ? 'the shadows' : 'nowhere'} — ASSASSINATE! (${dmgMath}) — ${dmg} damage to the ${monster.name}!`
        : crit
          ? `A perfect blow! ${ch.name} crits the ${monster.name} (${toHit} · ${dmgMath}) — ${dmg} damage!`
          : `${ch.name} hits the ${monster.name} (${toHit} · ${dmgMath}) — ${dmg} damage.`);
      return { hit: true, crit, assassinate, kill: monster.hp <= 0 };
    }
    this.addFx(foeC.x, foeC.y, 'miss', '#9a94a8');
    this.game.log(`${ch.name} ${verb} at the ${monster.name} and misses (d20 ${die}${this.fmtParts(atkParts)} = ${atkTotal} vs AC ${ac}).`);
    return { hit: false, crit: false, assassinate: false, kill: false };
  }

  // Way of the Blade, level 10: felling a foe grants a free attack on
  // another foe in reach — and kills CHAIN. At 18 a natural 20 counts too.
  rampageChain(c) {
    if (!hasVerb(this.game.data, c.ref, 'rampage')) return;
    for (let links = 0; links < 12; links++) { // generous cap against pathology
      const next = this.monsters()
        .filter(mc => Math.abs(mc.x - c.x) + Math.abs(mc.y - c.y) === 1)
        .sort((a, b) => a.ref.hp - b.ref.hp)[0]; // fury seeks the weakest neighbor
      if (!next) return;
      this.addFx(c.x, c.y, 'RAMPAGE!', '#e0483a');
      this.game.log(`${c.ref.name} rampages onward!`, 'combat');
      const res = this.strike(c, next, 'swings');
      if (res.kill) {
        c.ref.counters.rampageKills++;
        this.slay(next.ref);
        continue; // another falls — the chain rolls on
      }
      if (res.crit && hasRefinement(this.game.data, c.ref, 'rampage_crits')) continue;
      return;
    }
  }

  heroAttack(c, foeC, verb = 'swings') {
    const ch = c.ref, monster = foeC.ref;
    audio.play('melee');
    let killed = false, crit = false;
    for (let a = 0; a < this.heroAttacks(ch) && monster.hp > 0; a++) {
      const res = this.strike(c, foeC, verb);
      killed = killed || res.kill;
      crit = crit || res.crit;
      if (res.assassinate && res.kill) ch.counters.assassinateKills++;
    }
    if (monster.hp <= 0) this.slay(monster);
    // Rampage: a kill (or, refined, a crit) with a melee weapon lets the
    // fury spill onto the next foe in reach.
    if (!ch.weapon.range && (killed || (crit && hasRefinement(this.game.data, ch, 'rampage_crits')))) {
      this.rampageChain(c);
    }
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

  // Class actives (capstones and the Rite's unique power) — listed beside
  // spells in the C menu, driven by the lane data in progression.json.
  // Once-per-battle powers already spent by this hero.
  spentOnce(ref, id) { return (this.onceUsed ??= new Set()).has(`${this.game.party.indexOf(ref)}:${id}`); }
  markSpent(ref, id) { (this.onceUsed ??= new Set()).add(`${this.game.party.indexOf(ref)}:${id}`); }

  classActives(c) {
    const ref = c.ref;
    const lane = laneOf(this.game.data, ref);
    const out = [];
    // Vanish (Shadows, level 10): an active verb, not a reaction.
    if (hasVerb(this.game.data, ref, 'vanish') && !ref.hidden) {
      const free = hasRefinement(this.game.data, ref, 'vanish_free');
      out.push({ kind: 'active', id: 'vanish', name: lane.verb.name ?? 'Vanish', cost: 0, affordable: true,
        description: `Melt into shadow — foes lose you until you strike.${free ? ' (Perfected: costs nothing.)' : ' Costs your whole action.'}` });
    }
    const cap = lane?.capstone;
    if (cap && ref.level >= cap.level) {
      if (cap.id === 'rage') {
        out.push({ kind: 'active', id: 'rage', name: cap.name ?? 'Rage', cost: 0, affordable: true,
          description: `+${cap.hit ?? 2} hit, +${cap.dmg ?? 2} damage, ${cap.extra_attacks ?? 1} extra attack, ${cap.ac ?? -2} AC for ${cap.rounds ?? 3} rounds.` });
      }
      if (cap.id === 'bulwark') {
        out.push({ kind: 'active', id: 'taunt', name: 'Taunt', cost: 0, affordable: true,
          description: `Bellow a challenge — enemies strike at YOU for ${cap.taunt_rounds ?? 2} rounds.` });
      }
      if (cap.id === 'set_trap') {
        out.push({ kind: 'active', id: 'set_trap', name: cap.name ?? 'Set Trap', cost: 0, affordable: true,
          targeted: { kind: 'trap', range: cap.range ?? 3 },
          description: `Plant a trap on a square within ${cap.range ?? 3} (${Math.max(0, Math.min(95, this.game.heroSkill(ref)))}% skill) — ${cap.dice ?? '2d6'} to the first foe on it.` });
      }
    }
    // The Rite's unique power, under the name the player gave it.
    const rite = riteOf(this.game.data, ref);
    if (rite && ref.rite) {
      if (rite.ability.id === 'whirlwind') {
        out.push({ kind: 'active', id: 'whirlwind', name: ref.rite.abilityName, cost: 0, affordable: true,
          description: 'One furious action: strike every foe in reach, each once.' });
      }
      if (rite.ability.id === 'aegis' && !this.aegisSpent?.has(ref)) {
        out.push({ kind: 'active', id: 'aegis', name: ref.rite.abilityName, cost: 0, affordable: true,
          description: 'Once per battle: for a full round, every blow on any ally strikes you instead — at half force.' });
      }
      if (rite.ability.id === 'deathblow' && !this.spentOnce(ref, 'deathblow')) {
        out.push({ kind: 'active', id: 'deathblow', name: ref.rite.abilityName, cost: 0, affordable: true,
          targeted: { kind: 'deathblow', range: 1 },
          description: 'Once per battle: a full Assassinate against any foe in reach — no matter how alert or guarded.' });
      }
      if (rite.ability.id === 'shadowstep' && !this.spentOnce(ref, 'shadowstep')) {
        out.push({ kind: 'active', id: 'shadowstep', name: ref.rite.abilityName, cost: 0, affordable: true,
          targeted: { kind: 'shadowstep', range: 6 },
          description: 'Once per battle, freely: reappear on any square you can see — hidden.' });
      }
    }
    return out;
  }

  abilities(c) { return [...this.castables(c), ...this.classActives(c)]; }

  openMenu() {
    const c = this.active();
    if (!c || c.kind !== 'hero') return;
    if (!this.abilities(c).length) {
      this.game.log(`${c.ref.name} knows no spells or battle arts.`, 'info');
      return;
    }
    this.mode = 'menu';
  }

  chooseSpell(n) {
    const c = this.active();
    const list = this.abilities(c);
    const s = list[n - 1];
    if (!s) return;
    if (s.kind === 'active') {
      if (s.targeted) { // trap squares, deathblow marks, shadowstep landings
        this.pending = { kind: s.targeted.kind, range: s.targeted.range, entry: s };
        this.beginTargeting(s.targeted.kind === 'shadowstep');
        return;
      }
      this.mode = 'move';
      this.useActive(c, s);
      return;
    }
    if (!s.affordable) {
      this.addFx(c.x, c.y, 'not enough SP', '#9a94a8');
      this.game.log(`${c.ref.name} lacks the spell points for ${s.name}.`, 'info');
      return;
    }
    if (s.type === 'buff') { this.mode = 'move'; this.castBuff(c, s); return; }
    this.pending = { kind: 'spell', spell: s, range: s.range };
    this.beginTargeting(s.type === 'heal');
  }

  // Capstone actives. Like a swing or a spell, using one ends the turn.
  useActive(c, entry) {
    const ref = c.ref;
    const cap = laneOf(this.game.data, ref).capstone;
    audio.play('spell');
    if (entry.id === 'rage') {
      ref.timedBuffs = ref.timedBuffs.filter(b => b.name !== (cap.name ?? 'Rage'));
      ref.timedBuffs.push({
        name: cap.name ?? 'Rage',
        hit: cap.hit ?? 2, dmg: cap.dmg ?? 2, ac: cap.ac ?? -2,
        attacks: cap.extra_attacks ?? 1, rounds: cap.rounds ?? 3,
      });
      this.addFx(c.x, c.y, 'RAGE!', '#e0483a');
      this.game.log(`${ref.name} gives themself to the fury — all blade, no shield!`, 'good');
    } else if (entry.id === 'taunt') {
      this.taunt = { c, until: this.round + (cap.taunt_rounds ?? 2) };
      this.addFx(c.x, c.y, 'TAUNT!', '#d4a94e');
      this.game.log(`${ref.name} bellows a challenge — every foe turns their way!`, 'good');
    } else if (entry.id === 'whirlwind') {
      // The Rite's storm of steel: one strike at every foe in reach.
      const foes = this.monsters().filter(mc => Math.abs(mc.x - c.x) + Math.abs(mc.y - c.y) === 1);
      if (!foes.length) {
        this.addFx(c.x, c.y, 'no foe in reach', '#9a94a8');
        this.game.log(`${ref.name} finds no one in reach for ${entry.name}.`, 'info');
        return; // the action isn't wasted — move in and try again
      }
      this.addFx(c.x, c.y, `${entry.name.toUpperCase()}!`, '#ffd24a');
      this.game.log(`${ref.name} unleashes ${entry.name} — steel in every direction!`, 'good');
      for (const foeC of foes) {
        const res = this.strike(c, foeC, 'swings');
        if (res.kill) this.slay(foeC.ref);
      }
    } else if (entry.id === 'aegis') {
      (this.aegisSpent ??= new Set()).add(ref);
      this.aegis = { c, until: this.round + 1 };
      this.addFx(c.x, c.y, `${entry.name.toUpperCase()}!`, '#7fd4c8');
      this.game.log(`${ref.name} raises ${entry.name} — for this round, every blow meant for the party finds them instead.`, 'good');
    } else if (entry.id === 'vanish') {
      ref.hidden = true;
      ref.counters.shadowFeats++;
      this.addFx(c.x, c.y, 'VANISH', '#8a7ab8');
      this.game.log(`${ref.name} melts into the shadows — the enemy blinks, and finds nothing.`, 'good');
      // Perfected Vanish (18) costs nothing; before that, it IS the action.
      if (!hasRefinement(this.game.data, ref, 'vanish_free')) this.endHeroTurn();
      return;
    }
    this.endHeroTurn();
  }

  // The Rite's Aegis: while raised, a blow aimed at any OTHER ally lands on
  // the knight at half force instead.
  aegisGuard(target) {
    const a = this.aegis;
    if (!a || this.round > a.until || !a.c.ref.alive || a.c.ref === target) return null;
    return a.c;
  }

  // ---- Items: the acting hero drinks from the shared pouch. It's their
  // action — they can move first, but drinking ends the turn like a swing.
  usableItems(c) {
    return this.game.heldItems().map(it =>
      ({ ...it, usable: !this.game.itemBlockReason(it.def, c.ref) }));
  }

  openItems() {
    const c = this.active();
    if (!c || c.kind !== 'hero') return;
    if (!this.game.heldItems().length) {
      this.game.log('The party pouch holds no potions.', 'info');
      return;
    }
    this.mode = 'items';
  }

  chooseItem(n) {
    const c = this.active();
    const it = this.usableItems(c)[n - 1];
    if (!it) return;
    const res = this.game.useItem(it.id, c.ref);
    if (!res.ok) return; // blocked (unhurt / not poisoned) — menu stays open
    this.mode = 'move';
    this.addFx(c.x, c.y, res.fxText, res.fxColor);
    this.endHeroTurn();
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
      c.ref.hidden = false; // loosing an arrow gives you away
      this.heroAttack(c, foe, 'shoots'); // ends the turn
      return;
    }

    // Burglar's Set Trap: an empty square, a skill roll, a nasty surprise.
    if (p.kind === 'trap') {
      if (!this.open(x, y)) return; // needs bare floor
      this.cancelTargeting();
      const cap = laneOf(this.game.data, c.ref).capstone;
      const chance = Math.max(0, Math.min(95, this.game.heroSkill(c.ref)));
      audio.play('melee');
      if (Math.random() * 100 < chance) {
        this.battleTraps.push({ x, y, owner: c.ref, dice: cap.dice ?? '2d6' });
        c.ref.counters.shadowFeats++;
        this.addFx(x, y, 'trap set', '#d4a94e');
        this.game.log(`${c.ref.name} plants a trap with a craftsman's touch. Someone will find it the hard way.`, 'good');
      } else {
        this.addFx(c.x, c.y, 'jammed!', '#9a94a8');
        this.game.log(`${c.ref.name}'s trap mechanism jams — the moment is wasted.`, 'info');
      }
      this.endHeroTurn();
      return;
    }

    // Deathblow (the Assassin's Rite): one perfect strike, no conditions.
    if (p.kind === 'deathblow') {
      const foeC = this.monsterAt(x, y);
      if (!foeC) return;
      this.cancelTargeting();
      this.markSpent(c.ref, 'deathblow');
      audio.play('melee');
      this.addFx(c.x, c.y, `${p.entry.name.toUpperCase()}!`, '#b03a8e');
      this.game.log(`${c.ref.name} unleashes ${p.entry.name} — there was never anywhere to hide from this.`, 'good');
      this.forceAssassinate = true; // the perfect strike makes its own surprise
      const res = this.strike(c, foeC, 'strikes');
      this.forceAssassinate = false;
      if (res.assassinate && res.kill) c.ref.counters.assassinateKills++;
      if (foeC.ref.hp <= 0) this.slay(foeC.ref);
      this.endHeroTurn();
      return;
    }

    // Shadowstep (the Burglar's Rite): cross the room in a blink, hidden —
    // and the night is still young (a free action).
    if (p.kind === 'shadowstep') {
      if (!this.open(x, y)) return; // needs an empty square
      this.cancelTargeting();
      this.markSpent(c.ref, 'shadowstep');
      audio.play('spell');
      this.addFx(c.x, c.y, `${p.entry.name.toUpperCase()}!`, '#8a7ab8');
      c.x = x; c.y = y;
      c.ref.hidden = true;
      c.ref.counters.shadowFeats++;
      this.addFx(x, y, 'from the shadows…', '#8a7ab8');
      this.game.log(`${c.ref.name} is simply… elsewhere. The shadows keep their secret.`, 'good');
      return; // free — the turn goes on
    }

    const s = p.spell;
    c.ref.hidden = false; // spellwork glows — the shadows can't keep you
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
      if (t.kind === 'monster') t.aware = true; // seared awake, saved or not
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
      // The buff's NAME rides along so the combat math can credit it.
      if (!(ch.buffs.sources ??= []).includes(s.name)) ch.buffs.sources.push(s.name);
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

  // Bulwark's taunt: while it holds, monsters strike the knight if they can.
  tauntActive() {
    return this.taunt && this.round <= this.taunt.until && this.taunt.c.ref.alive;
  }

  adjacentHero(c) {
    // A hidden hero simply isn't there, as far as any monster knows.
    const near = this.heroes().filter(h => h.ref.alive && !h.ref.hidden && Math.abs(h.x - c.x) + Math.abs(h.y - c.y) === 1);
    if (!near.length) return null;
    if (this.tauntActive() && near.includes(this.taunt.c)) return this.taunt.c;
    return near[Math.floor(Math.random() * near.length)];
  }

  stepToward(c) {
    // BFS to the closest square adjacent to a living hero, then take the first
    // step. A taunting knight draws every march toward himself.
    const pool = this.tauntActive() ? [this.taunt.c] : this.heroes().filter(h => !h.ref.hidden);
    const targets = new Set();
    for (const h of pool) {
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
    this.checkBattleTrap(c);
    return true;
  }

  // The Burglar's handiwork: the first foe to step on a planted trap
  // springs it — damage, and the trap is spent.
  checkBattleTrap(c) {
    const trap = this.battleTraps.find(t => t.x === c.x && t.y === c.y);
    if (!trap) return;
    this.battleTraps = this.battleTraps.filter(t => t !== trap);
    const dmg = Math.max(1, roll(trap.dice));
    c.ref.hp -= dmg;
    c.aware = true;
    audio.play('melee');
    this.addFx(c.x, c.y, `TRAP! -${dmg}`, '#e0912f');
    this.game.log(`The ${c.ref.name} steps on ${trap.owner.name}'s trap — it springs shut for ${dmg} damage!`, 'good');
    if (c.ref.hp <= 0) this.slay(c.ref);
  }

  // A hero's AC in the moment: sheet AC, timed buffs (Rage's recklessness),
  // and Bulwark — a knight standing beside you turns blades aside.
  heroAcOf(hc) {
    let ac = hc.ref.ac + timedSum(hc.ref, 'ac');
    for (const other of this.heroes()) {
      if (other === hc || !other.ref.alive) continue;
      const lane = laneOf(this.game.data, other.ref);
      if (lane?.capstone?.id === 'bulwark' && other.ref.level >= lane.capstone.level
        && Math.abs(other.x - hc.x) + Math.abs(other.y - hc.y) === 1) {
        ac += lane.capstone.aura_ac ?? 1;
      }
    }
    return ac;
  }

  // A living shield-brother who could take this blow instead (level-10 verb).
  standCandidate(target) {
    return this.heroes().map(h => h.ref).find(ref =>
      ref.alive && ref !== target && hasVerb(this.game.data, ref, 'guardians_stand'));
  }

  monsterAttack(m, target) {
    const tc = this.combatants.find(cc => cc.ref === target);
    const ac = tc?.kind === 'hero' ? this.heroAcOf(tc) : target.ac;
    const die = d20();
    if (die + m.to_hit >= ac) {
      const dmg = Math.max(1, roll(m.damage));
      this.lastMonsterRoll = `d20 ${die} +${m.to_hit} = ${die + m.to_hit} vs AC ${ac}`;
      // Aegis (the Rite): the raised guard takes the blow at half force —
      // no question asked, that's what the round was bought for.
      const aegisC = tc?.kind === 'hero' && !this.fleeing ? this.aegisGuard(target) : null;
      if (aegisC) {
        this.fxOn(target, 'shielded!', '#7fd4c8');
        this.game.log(`The blow meant for ${target.name} breaks against ${aegisC.ref.name}'s guard!`, 'good');
        this.applyMonsterHit(m, aegisC.ref, Math.max(1, Math.ceil(dmg / 2)));
        return;
      }
      // Guardian's Stand: the blow hangs in the air while the player decides.
      const guardian = this.fleeing ? null : this.standCandidate(target);
      if (guardian) {
        this.pendingReaction = { m, target, dmg, guardian };
        this.mode = 'reaction';
        return;
      }
      this.applyMonsterHit(m, target, dmg);
    } else {
      this.fxOn(target, 'miss', '#9a94a8');
      this.game.log(`The ${m.name} lunges at ${target.name} but misses (d20 ${die} +${m.to_hit} = ${die + m.to_hit} vs AC ${ac}).`);
    }
  }

  applyMonsterHit(m, target, dmg) {
    // Braced Stance (Way of the Shield): a shield in hand blunts every hit.
    const p = passiveOf(this.game.data, target);
    const braced = p?.id === 'braced_stance' && this.game.hasShield(target) ? (p.reduce ?? 1) : 0;
    if (braced) dmg = Math.max(0, dmg - braced);
    const rollText = this.lastMonsterRoll ? `${this.lastMonsterRoll}${braced ? ` · shield turns ${braced} aside` : ''}` : (braced ? `shield turns ${braced} aside` : '');
    this.lastMonsterRoll = null; // redirected blows (Aegis, the Stand) skip the roll text next time
    audio.play('melee');
    if (dmg <= 0) {
      this.fxOn(target, 'blocked', '#9a94a8');
      this.game.log(`The ${m.name} strikes ${target.name} — the shield takes it all${rollText ? ` (${rollText})` : ''}.`);
      return;
    }
    target.hp -= dmg;
    this.fxOn(target, `-${dmg}`, '#ff6a4a');
    this.game.log(`The ${m.name} strikes ${target.name} for ${dmg} damage${rollText ? ` (${rollText})` : ''}!`);
    if (target.hp <= 0) {
      target.hp = 0;
      target.alive = false;
      this.fxOn(target, 'FALLEN', '#b03535');
      this.game.log(`${target.name} has fallen!`, 'death');
    } else if (m.inflicts) {
      const tc = this.combatants.find(cc => cc.ref === target);
      if (tc) this.tryInflict(tc, m.inflicts.condition, m.inflicts.rounds, m.inflicts.dc);
    }
  }

  // The player answered the Guardian's Stand prompt (Y/N from main.js).
  resolveReaction(accept) {
    const r = this.pendingReaction;
    if (!r) return;
    this.pendingReaction = null;
    this.mode = 'move';
    if (accept) {
      this.lastMonsterRoll = null; // the blow never lands as rolled
      const g = r.guardian;
      let cost = hasRefinement(this.game.data, g, 'stand_half_cost') ? Math.ceil(r.dmg / 2) : r.dmg;
      const p = passiveOf(this.game.data, g);
      if (p?.id === 'braced_stance' && this.game.hasShield(g)) cost = Math.max(0, cost - (p.reduce ?? 1));
      g.counters.standSaves++;
      audio.play('melee');
      this.fxOn(r.target, 'shielded!', '#7fd4c8');
      this.fxOn(g, cost > 0 ? `-${cost}` : 'blocked', '#d4a94e');
      this.game.log(`${g.name} throws themself before the blow meant for ${r.target.name}${cost > 0 ? ` — ${cost} damage taken` : ' — and shrugs it off'}!`, 'good');
      g.hp -= cost;
      if (g.hp <= 0) {
        g.hp = 0;
        g.alive = false;
        this.fxOn(g, 'FALLEN', '#b03535');
        this.game.log(`${g.name} has fallen!`, 'death');
      }
    } else {
      this.applyMonsterHit(r.m, r.target, r.dmg);
    }
    if (this.checkEnd()) return;
    this.nextTurn();
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
    for (const ch of this.game.awardXp(monster.xp)) this.fxOn(ch, 'READY TO LEVEL!', '#d4a94e');
    if (this.game.depth === 'boss' && monster.id === this.game.data.dungeon.boss.monster) {
      this.game.victory = true; // the run is won — the map shows the banner when the fight ends
      this.game.log(`The ${monster.name} is destroyed! The endless dark is broken — the party has conquered the dungeon!`, 'good');
    }
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
      game.log('The entire party has fallen. The dungeon keeps its dead. Press R to try again.', 'death');
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
      ch.timedBuffs = []; // Rage and its kin gutter out with the fight
      ch.hidden = false;  // shadows are for battlefields
    }
  }

  flee() {
    this.fleeing = true; // no Guardian's Stand for backs that are turned
    if (this.game.arena) {
      this.game.battle = null;
      this.game.endArena();
      return;
    }
    if (this.ending) return;
    const exit = () => {
      if (this.game.battle !== this) return;
      this.stripBattleConditions();
      // The foes spend a few map turns regrouping before they give chase —
      // fleeing buys real distance instead of an instant rematch.
      for (const mc of this.monsters()) mc.ref.regroup = 3;
      this.game.battle = null;
      this.game.log('The party breaks away from the fight — run!', 'info');
    };
    // Parting blows: every monster standing beside a hero gets one free
    // swing at the fleeing party's backs. Running out of melee has a price.
    const blows = [];
    for (const mc of this.monsters()) {
      const target = this.adjacentHero(mc);
      if (target) blows.push([mc.ref, target.ref]);
    }
    if (!blows.length) { exit(); return; }
    this.busy = true; // input stays locked while the blows land
    this.game.log('The party turns to flee — the enemy strikes at their backs!', 'combat');
    blows.forEach(([m, t], i) => setTimeout(() => {
      if (this.game.battle !== this) return;
      if (t.alive) this.monsterAttack(m, t);
      if (i === blows.length - 1 && !this.checkEnd()) setTimeout(exit, 900);
    }, 400 + i * 600));
  }
}
