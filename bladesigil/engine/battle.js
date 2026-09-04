// Tactical battle (Phase 3a): an abstract battlefield built from a template
// in data/tactics/. Each side starts on its own edge, initiative decides the
// turn order, and every combatant moves and fights on their own square.

import { roll, d20, maxRoll, abilityMod } from './rules.js';
import { DataError } from './loader.js';
import { ELEMENTS } from './validate.js';
import { HERO_MOVE, MONSTER_MOVE, CHAIN_CAP, TIMING, COLOR } from './constants.js';
import { MONSTER_ABILITIES } from './monster-abilities.js';
import { CLASS_ACTIVES, BATTLE_FLAGS, LAPSES, SNARE_RIDERS } from './class-actives.js';
import { SPELL_EFFECTS } from './spell-effects.js';
import { laneOf, passiveOf, hasVerb, hasCapstone, hasRefinement, riteOf, passiveName, focusMatches, groupOfType, focusName, growthEffect, growthNamed, growthPicks, snareGrant, snareKinds, snareDice } from './progression.js';
import { spellCost, spellBuff, activeStances, unpreparedSpells, knownSpells, scaleSteps, giftOf, scrollGamble } from './magic.js';
import * as audio from './audio.js';

// Sum of a field across a hero's timed buffs (Rage etc.).
const timedSum = (ref, key) => (ref.timedBuffs ?? []).reduce((s, b) => s + (b[key] || 0), 0);

export const GRID_W = 13, GRID_H = 8;
const hpMax = ref => ref.maxHp ?? ref.hp; // monsters built before maxHp existed
const monsterMove = m => (m.speed > 1 ? MONSTER_MOVE.slow : MONSTER_MOVE.normal); // map-slow monsters are battle-slow too

// Is THIS cast being read off a page? spells.json's "scroll": true only says
// a scroll of the spell can EXIST; the reading path sets s.scroll to the
// item's id (a string). Testing the boolean made every scroll-able spell
// free and mislabelled — fixed 2026-09-03.
const fromScroll = s => typeof s.scroll === 'string';



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
    this.spellFx = [];    // animated spell visuals: bolts, beams, bursts, sparkles
    this.busy = false;    // true while a monster acts (player input locked)
    this.pendingReaction = null; // Guardian's Stand: an ally's Y/N moment
    this.taunt = null;    // Bulwark's taunt: {c, until} — monsters strike the knight
    this.fleeing = false; // parting blows allow no heroics
    this.battleTraps = []; // Burglar's Set Trap: {x, y, owner, dice}
    this.sanctuary = null; // the Cleric's Rite: {c} — nobody falls while it holds
    for (const ch of game.party) {
      ch.buffs = { hit: 0, dmg: 0 }; // buffs last one battle
      // Stances (v1.1) hold until the next full rest; everything else is fresh.
      ch.timedBuffs = (ch.timedBuffs ?? []).filter(b => b.stance);
      // Magic v2 battle state: Arcane Insight's chosen edge, the Overcast and
      // Zealous Strike stances, and the armed one-shot wonders — all fresh
      // each fight. Battle also slams the Prepared Mind window shut.
      Object.assign(ch, BATTLE_FLAGS); // every art's per-battle flag, from the registry
      ch.prepFresh = false;
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
    // The hunter senses a favored enemy before the first blow.
    for (const ch of game.party) {
      if (!ch.alive || !ch.favored) continue;
      const fams = [...new Set(foes.map(m => m.family).filter(f => f && ch.favored[f]))];
      if (fams.length) game.log(`${ch.name} stiffens — favored prey is near: ${fams.join(', ')}.`, 'info');
    }
    this.parseTemplate(template);
    this.placeCombatants(foes);
    for (const m of foes) if (m.intro) this.speak(m, m.intro); // the Overlord greets his guests
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
      this.combatants.push({ kind: 'monster', ref: m, x: spot.x, y: spot.y, aware: this.ambush,
        unseen: !!m.hidden, alivePos: () => m.hp > 0 });
    });
    // Dead heroes still hold a square (a fallen body); dead monsters vanish.
    // A stable battle-local id per combatant — fear conditions remember WHO
    // scared their victim by this uid ("cannot approach the source").
    this.combatants.forEach((c, i) => { c.uid = i; if (c.kind === 'hero') c.steeled = new Set(); });
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
  // Monsters the party can actually SEE (and therefore aim at). A monster
  // hides two ways: monsters.json "hidden": true (it began the fight
  // unseen) or the 'vanish' ability used mid-fight. Either way c.unseen
  // is the live flag, and `seen` is what the rest of the engine asks.
  visibleMonsters() { return this.monsters().filter(c => !c.unseen); }
  monsterAtSeen(x, y) { return this.visibleMonsters().find(c => c.x === x && c.y === y); }

  // Is anything on the field hiding right now?
  anyUnseen() { return this.monsters().some(c => c.unseen); }

  // A hidden thing steps into the light — for any reason (it struck, a
  // spell found it, a rogue's eye caught it). Returns true if it WAS hidden.
  revealMonster(c, why) {
    if (!c.unseen) return false;
    c.unseen = false;
    c.revealedRound = this.round;
    this.addFx(c.x, c.y, 'revealed!', COLOR.gold);
    if (why) this.game.log(why, 'good');
    return true;
  }

  // Does any hero see through hiding outright? (the Shadows growth pick,
  // or a Piercing Sight / Light of Truth buff still burning)
  seersEye() {
    for (const h of this.heroes()) {
      if (!h.ref.alive) continue;
      if (growthEffect(this.game.data, h.ref, 'see_hidden')) return { name: `${h.ref.name}'s eye`, ref: h.ref };
      const buff = (h.ref.timedBuffs ?? []).find(b => b.reveal);
      if (buff) return { name: buff.name, ref: h.ref };
    }
    return null;
  }

  // Called whenever sight might have changed: anything that can no longer
  // hide steps into view.
  sweepHidden() {
    const eye = this.seersEye();
    if (!eye) return;
    for (const c of this.monsters()) {
      this.revealMonster(c, `${eye.name} picks the ${c.ref.name} out of the dark — it cannot hide from this party.`);
    }
  }
  heroAt(x, y) { return this.heroes().find(c => c.ref.alive && c.x === x && c.y === y); }
  monsterAt(x, y) { return this.monsters().find(c => c.x === x && c.y === y); }
  byUid(uid) { return this.combatants.find(cc => cc.uid === uid); }

  // ---- Shared helpers (refactor step 4, 2026-09-03) ----
  // The combatant standing for a hero or monster object (undefined if not on the field).
  combatantOf(ref) { return this.combatants.find(cc => cc.ref === ref); }
  // Orthogonally adjacent (a bump, a flank, an aura's reach).
  adjacent(a, b) { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1; }

  // A timed buff on a hero: every field the combat math reads is present,
  // zeroed unless given, so no reader has to guard against undefined.
  addTimedBuff(ref, buff) {
    ref.timedBuffs ??= [];
    ref.timedBuffs.push({ hit: 0, dmg: 0, ac: 0, saves: 0, attacks: 0, ...buff });
  }

  // 'resisted' — the float and the line, together.
  resisted(ref, line, impact = 0) {
    const c = this.combatantOf(ref);
    if (c) this.addFx(c.x, c.y, 'resisted', COLOR.dim, impact);
    this.game.log(line);
  }

  // A wound lands: HP, waking, the float. The caller writes the line.
  wound(ref, dmg, color = '#ff6a4a', impact = 0) {
    ref.hp -= dmg;
    this.wake(ref);
    const c = this.combatantOf(ref);
    if (c) this.addFx(c.x, c.y, `-${dmg}`, color, impact);
  }

  // The text a half-damage save leaves in the math: ", halved — save…" or " · save…".
  saveBits(saved, text) { return saved ? `, halved — ${text}` : text ? ` · ${text}` : ''; }

  // Worn immunity / resistance (or a warding spell) meets elemental harm:
  // returns null when immune (after `immune(guard)`), else the damage —
  // halved to no less than `min` when resisted (after `resist(guard, cut)`).
  guardElement(target, element, dmg, { min = 1, immune, resist } = {}) {
    const guard = element ? this.game.elementGuard(target, element) : null;
    if (guard?.kind === 'immune') { immune?.(guard); return null; }
    if (guard?.kind === 'resist') { const cut = Math.max(min, Math.floor(dmg / 2)); resist?.(guard, cut); return cut; }
    return dmg;
  }

  // ONE staggered monster action: after `lead` ms, `each(target, i)` runs
  // per target `step` ms apart (skipping the fallen), then `then()` and the
  // hand-back to the scheduler. Owns pendingAction and the battle-identity
  // guard on every timer, so no caller can forget either.
  staggerTargets(targets, { lead = 0, step, tail = TIMING.staggerTail, each, then }) {
    this.pendingAction = true;
    setTimeout(() => {
      if (this.game.battle !== this) return;
      targets.forEach((t, i) => setTimeout(() => {
        if (this.game.battle !== this || t.ref.alive === false) return;
        each(t, i);
      }, i * step));
      setTimeout(() => {
        if (this.game.battle !== this) return;
        then?.();
        this.finishMonsterAction();
      }, targets.length * step + tail);
    }, lead);
  }

  // ---- Fear (behavioral, designer ruling 2026-09-02) ----
  // A condition flagged "fear": true in conditions.json remembers WHO caused
  // it (the condition's `source` uid) and forbids every step that would
  // close the distance to that terror while it still stands. Applies to
  // frightened heroes AND frightened monsters (Turn Undead does what its
  // name promises now).
  fearSources(ref) {
    const out = [];
    for (const cond of ref.conditions ?? []) {
      if (cond.source === undefined || !this.game.conditionDef(cond.id)?.fear) continue;
      const src = this.byUid(cond.source);
      if (!src || src.ref === ref) continue;
      if (src.kind === 'monster' ? src.ref.hp <= 0 : !src.ref.alive) continue; // a dead terror binds no one
      out.push(src);
    }
    return out;
  }

  // The source this step would close with, or null if courage permits it.
  fearBlock(ref, fromX, fromY, toX, toY) {
    return this.fearSources(ref).find(src =>
      this.dist(toX, toY, src.x, src.y) < this.dist(fromX, fromY, src.x, src.y)) ?? null;
  }

  // fear_aura (monsters.json — the death knight's black dread): stepping
  // NEXT TO the bearer, or starting your turn beside it, demands a WIS save
  // vs its dc. Pass once and the hero is steeled against that monster for
  // the whole battle; fail and they're frightened (source = the bearer, so
  // the fear rule also refuses the approach). Returns false when courage fails.
  fearAuraCheck(hc, mc, closing) {
    const aura = mc.ref.fear_aura;
    if (!aura || mc.ref.hp <= 0 || hc.steeled?.has(mc.uid)) return true;
    if ((hc.ref.conditions ?? []).some(cd => this.game.conditionDef(cd.id)?.fear && cd.source === mc.uid)) return false; // already cowed by it
    const bonus = abilityMod(hc.ref.abilities.wis) + this.game.heroSaveBonus(hc.ref);
    const die = d20();
    const math = `save d20 ${die} ${bonus >= 0 ? '+' : '−'}${Math.abs(bonus)} = ${die + bonus} vs DC ${aura.dc}`;
    if (die + bonus >= aura.dc) {
      hc.steeled.add(mc.uid);
      this.addFx(hc.x, hc.y, 'steeled!', COLOR.gold);
      this.game.log(`Dread rolls off the ${mc.ref.name} — ${hc.ref.name} ${closing ? 'closes in anyway' : 'stands firm'} (${math}), steeled against it for the battle.`, 'good');
      return true;
    }
    this.addFx(hc.x, hc.y, 'cowed!', '#c8b8e8');
    this.game.log(`The ${mc.ref.name}'s dread crawls over ${hc.ref.name} (${math})!`, 'death');
    this.game.applyCondition(hc.ref, 'frightened', aura.rounds, mc.uid);
    return false;
  }

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
        // Sanctuary and Zealous immunity hold "until your next turn" — this is it.
        if (this.sanctuary?.c.ref === c.ref) {
          this.sanctuary = null;
          this.game.log(`The circle of ${c.ref.rite?.abilityName ?? 'Sanctuary'} fades.`, 'info');
        }
        c.ref.zealousImmune = false;
        // The half-casters' until-your-next-turn powers lapse here.
        for (const { flag, what } of LAPSES) {
          if (c.ref[flag]) { c.ref[flag] = false; this.game.log(`${c.ref.rite?.abilityName ?? what} has run its course.`, 'info'); }
        }
        this.surgeSave = null;
        // Timed powers (Rage) burn down at the start of their owner's turn.
        for (const b of [...(c.ref.timedBuffs ?? [])]) {
          if (b.rounds == null) continue; // a battle-long spell buff (magic v3) fades with the fight
          b.rounds--;
          if (b.rounds <= 0) {
            c.ref.timedBuffs = c.ref.timedBuffs.filter(x => x !== b);
            this.addFx(c.x, c.y, `${b.name} fades`, COLOR.dim);
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
          }, TIMING.skipTurn);
          return;
        }
        this.movesLeft = HERO_MOVE;
        // A fear aura tests the hero who STARTS their turn beside the bearer
        // ("to stay next to it you must pass a saving throw" — designer 2026-09-02).
        for (const mc of this.monsters()) {
          if (mc.ref.fear_aura && this.adjacent(mc, c)) this.fearAuraCheck(c, mc, false);
        }
        // Mirror Ward / Mountain's Heart: the singer stands where they stand.
        const root = this.rootedBy(c.ref);
        if (root) {
          this.movesLeft = 0;
          this.addFx(c.x, c.y, 'rooted', COLOR.dim);
          this.game.log(`${c.ref.name} cannot move while ${root.name} holds.`, 'info');
        }
        this.busy = false;
        return;
      }
      if (c.kind === 'monster' && c.ref.hp > 0) {
        c.aware = true; // its turn has come — the moment of surprise is over
        const period = (c.ref.speed > 1 ? c.ref.speed : 1) * (this.isSlowed(c.ref) ? 2 : 1);
        if (period > 1 && this.round % period !== 0) continue; // slow (and Slowed) monsters sit out odd rounds
        this.busy = true;
        setTimeout(() => {
          if (this.game.battle !== this || c.ref.hp <= 0) return;
          const verdict = this.tickConditions(c);
          if (this.checkEnd()) return;
          if (verdict !== 'dead' && verdict !== 'skip') {
            this.tickMonsterState(c); // regen, cooldowns, a fading War Drums
            this.monsterTurn(c);
          }
          if (this.pendingReaction || this.pendingAction) return; // frozen mid-blow, or an ability still in flight — resumeAfterBlow / finishMonsterAction continues
          if (this.checkEnd()) return;
          this.nextTurn();
        }, TIMING.monsterTurn);
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
        this.wake(ref);
      } else if (def.effect === 'skip') {
        this.addFx(c.x, c.y, def.name, def.color);
        this.game.log(`${ref.name} is ${def.name.toLowerCase()} and cannot act!`);
        verdict = 'skip';
      } else if (def.effect === 'slow' && c.kind === 'hero' && this.round % 2 === 1) {
        // Heroes mired by Slowed lose every odd round (monsters skip theirs in nextTurn).
        this.addFx(c.x, c.y, def.name, def.color);
        this.game.log(`${ref.name} is ${def.name.toLowerCase()} — the turn drags past unused.`);
        verdict = 'skip';
      } else if (def.effect === 'stat' || def.effect === 'slow') {
        this.addFx(c.x, c.y, def.name, def.color);
      }
      cond.rounds--;
      if (cond.rounds <= 0) {
        ref.conditions = ref.conditions.filter(x => x !== cond);
        this.game.log(`${ref.name} recovers from ${def.name.toLowerCase()}.`, 'good');
      }
    }
    if (ref.hp <= 0) {
      if (c.kind === 'monster') { this.slay(ref); return 'dead'; }
      if (this.downHero(ref)) return 'dead';
      return verdict; // caught at the brink (Sanctuary, Mercy) — the turn goes on
    }
    return verdict;
  }

  // Something tries to inflict a condition: the victim saves against the DC.
  tryInflict(targetC, condId, rounds, dc, source) {
    const def = this.game.conditionDef(condId);
    if (!def) return;
    const ref = targetC.ref;
    // Zealous Strike, perfected (18): the last blow's fire still shields.
    if (targetC.kind === 'hero' && ref.zealousImmune) {
      this.addFx(targetC.x, targetC.y, 'immune!', COLOR.gold);
      this.game.log(`${ref.name}'s Zealous Strike still burns — no affliction can touch them.`, 'good');
      return;
    }
    let bonus = targetC.kind === 'monster'
      ? (ref.save ?? 0)
      : abilityMod(ref.abilities[def.save ?? 'con']) + this.game.heroSaveBonus(ref);
    if (targetC.kind === 'hero' && this.surgeSave?.target === ref) bonus += this.surgeSave.ac; // Ward Surge guards the save too
    if (d20() + bonus >= dc) {
      this.resisted(ref, `${ref.name} resists — not ${def.name.toLowerCase()}!`);
      return;
    }
    this.game.applyCondition(ref, condId, rounds, source);
    this.addFx(targetC.x, targetC.y, def.name + '!', def.color);
  }

  // Slowed (magic v3): acts on even rounds only.
  isSlowed(ref) { return (ref.conditions ?? []).some(c => this.game.conditionDef(c.id)?.effect === 'slow'); }

  // Pain breaks a Sleep (any condition with breaks_on_damage).
  wake(ref) {
    const broke = (ref.conditions ?? []).filter(c => this.game.conditionDef(c.id)?.breaks_on_damage);
    if (!broke.length) return;
    ref.conditions = ref.conditions.filter(c => !broke.includes(c));
    this.fxOn(ref, 'awake!', '#b8a8e8');
    this.game.log(`${ref.name} jolts awake!`);
  }

  // A buff that plants the hero in place (Mirror Ward, Mountain's Heart).
  rootedBy(ref) { return (ref.timedBuffs ?? []).find(b => b.rooted) ?? null; }

  // Are these two heroes standing next to each other? (game.js asks, for
  // the Hearthstone aura's refusals; The Wide Hearth drops the requirement.)
  adjacentAllies(a, b) {
    if (growthEffect(this.game.data, a, 'aura_party')) return true;
    const ac = this.combatantOf(a);
    const bc = this.combatantOf(b);
    return !!ac && !!bc && this.adjacent(ac, bc);
  }

  // Warding Presence (Hearthstone passive): +saves for allies standing
  // beside the dwarf. game.heroSaveBonus asks here in battle.
  auraSaves(ref) {
    const hc = this.combatantOf(ref);
    if (!hc) return 0;
    let bonus = 0;
    for (const other of this.heroes()) {
      if (other === hc || !other.ref.alive) continue;
      const p = passiveOf(this.game.data, other.ref);
      if (p?.id !== 'warding_presence') continue;
      // The Wide Hearth (growth) drops the arm's-reach requirement.
      const wide = growthEffect(this.game.data, other.ref, 'aura_party');
      if (!wide && !this.adjacent(other, hc)) continue;
      bonus += (p.saves ?? 1) + growthEffect(this.game.data, other.ref, 'aura_saves');
    }
    return bonus;
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
          if (!seen.has(k) && this.open(nx, ny) && !this.fearBlock(c.ref, x, y, nx, ny)) {
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
    if (foe?.unseen) {
      // Blundering into something unseen: you find it the hard way, and it
      // costs the step — but at least now everyone can see it.
      this.revealMonster(foe, `${c.ref.name} walks straight into something unseen — there it is!`);
      return;
    }
    if (foe) { this.heroAttack(c, foe); return; }
    if (this.movesLeft <= 0 || !this.open(nx, ny)) {
      const root = this.movesLeft <= 0 ? this.rootedBy(c.ref) : null;
      if (root) { this.addFx(c.x, c.y, 'rooted', COLOR.dim); this.game.log(`${c.ref.name} is rooted by ${root.name}.`, 'info'); }
      return;
    }
    // Fear: a frightened hero cannot force a step toward whoever scared them.
    const scare = this.fearBlock(c.ref, c.x, c.y, nx, ny);
    if (scare) {
      this.addFx(c.x, c.y, 'cowed!', '#c8b8e8');
      this.game.log(`${c.ref.name} is frightened — they cannot make themselves approach the ${scare.ref.name}!`, 'info');
      return;
    }
    // A fear aura tests courage at the threshold: stepping ADJACENT to the
    // bearer from farther away demands the save. Failing refuses the step.
    for (const mc of this.monsters()) {
      if (!mc.ref.fear_aura) continue;
      const wasAdj = this.adjacent(c, mc);
      const nowAdj = Math.abs(nx - mc.x) + Math.abs(ny - mc.y) === 1;
      if (nowAdj && !wasAdj && !this.fearAuraCheck(c, mc, true)) return;
    }
    c.x = nx; c.y = ny;
    this.movesLeft--;
  }

  // Floating combat text, drawn by the renderer right on the battlefield.
  // `delay` (ms) holds the text back — damage numbers land AT impact, after
  // the bolt has crossed the field, never before it.
  addFx(x, y, text, color, delay = 0) {
    this.fx.push({ x, y, text, color, born: performance.now() + delay + (this.fxDelay ?? 0) });
  }

  fxOn(ref, text, color) {
    const c = this.combatantOf(ref);
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
    // Mountain's Heart: a wall, not a warrior — the trained bonus is nothing.
    const wall = (ch.timedBuffs ?? []).find(b => b.no_hit_bonus);
    if (wall && classHit + laneHit) parts.push([-(classHit + laneHit), wall.name]);
    // Finesse (light blades): the wielder's better of STR and DEX — the
    // session ruling that lets a DEX thief's dagger finally bite.
    const finesse = ch.weapon.finesse && abilityMod(ch.abilities.dex) > abilityMod(ch.abilities.str);
    const useDex = !!ch.weapon.range || finesse;
    const ab = abilityMod(useDex ? ch.abilities.dex : ch.abilities.str);
    if (ab) parts.push([ab, finesse ? 'DEX (finesse)' : useDex ? 'DEX' : 'STR']);
    return parts;
  }

  // Favored Enemy (the Ranger): +N to hit and damage vs a known family.
  favoredPart(ch, foe) {
    const fam = foe?.family;
    const n = fam && ch.favored ? (ch.favored[fam] ?? 0) : 0;
    return n ? [n, `favored enemy — ${fam}`] : null;
  }

  attackParts(ch, foe = null) {
    const parts = this.baseParts(ch);
    const fav = this.favoredPart(ch, foe);
    if (fav) parts.push(fav);
    if (this.offhandPenalty) parts.push([-this.offhandPenalty, 'off-hand']);
    // Worn 'hit' pieces (enchanted weapons and finer things), each by name.
    for (const p of ch.hitPieces ?? []) parts.push([p.hit, p.name]);
    if (ch.buffs.hit) parts.push([ch.buffs.hit, ch.buffs.sources?.join(' & ') || 'blessing']);
    for (const b of ch.timedBuffs ?? []) if (b.hit) parts.push([b.hit, b.name]);
    if (ch.insight?.hit) parts.push([ch.insight.hit, 'Arcane Insight']);
    for (const part of this.game.condParts(ch, 'hit')) parts.push(part); // Weakened, Frightened…
    // Point-blank (ranged rules): loosing an arrow with a foe at your elbow.
    const pb = this.pointBlank(ch);
    if (pb) parts.push([-pb, 'point-blank']);
    return parts;
  }

  // A bow-wielder with a living foe adjacent shoots at a penalty
  // (items.json ranged.point_blank_penalty). 0 when it doesn't apply.
  pointBlank(ch) {
    if (!ch.weapon?.range) return 0;
    const c = this.combatantOf(ch);
    if (!c) return 0;
    const near = this.monsters().some(mc => this.adjacent(mc, c));
    if (!near) return 0;
    // The Ranger's reflexes (classes.json point_blank_penalty), and the
    // Hawk's Snap Shot passive, undercut the default.
    const p = passiveOf(this.game.data, ch);
    if (p?.id === 'snap_shot') return p.point_blank ?? 0;
    return ch.cls.point_blank_penalty ?? this.game.rangedRules().point_blank_penalty ?? 4;
  }

  // The off-hand's to-hit penalty for this hero right now (dual_wield class).
  offhandPenaltyFor(ch) {
    if (!ch.cls.dual_wield) return 0;
    if (ch.packArmed || hasRefinement(this.game.data, ch, 'offhand_free')) return 0;
    const p = passiveOf(this.game.data, ch);
    if (p?.id === 'ambidexterity') return p.penalty ?? 2;
    return ch.cls.dual_wield.penalty ?? 4;
  }

  // Why this hero can't shoot right now — or null. The hint line and the F
  // key both ask, so a refusal is never silent.
  shootBlock(c) {
    const ch = c.ref;
    if (!ch.weapon?.range) return null;
    if (ch.weapon.steady && this.movesLeft < HERO_MOVE && !hasRefinement(this.game.data, ch, 'hawk_on_the_move')) return `the ${ch.weapon.name.toLowerCase()} needs a planted stance — no shot on a turn you have moved`;
    if (this.game.quiverCount(ch) <= 0) return this.game.ammoCount() > 0 ? `the quiver is empty — restock from the pouch (I) or swap weapons` : `the quiver is empty and the pouch holds no arrows`;
    return null;
  }

  // opts.vital: 'unaware' | 'flanked' when Vital Strike applies this swing.
  damageParts(ch, opts = {}) {
    const parts = this.baseParts(ch);
    const fav = this.favoredPart(ch, opts.foe);
    if (fav) parts.push(fav);
    if (ch.buffs.dmg) parts.push([ch.buffs.dmg, ch.buffs.sources?.join(' & ') || 'blessing']);
    for (const b of ch.timedBuffs ?? []) if (b.dmg) parts.push([b.dmg, b.name]);
    if (ch.gearDmg) parts.push([ch.gearDmg, 'gear']);
    const p = passiveOf(this.game.data, ch);
    // Weapon Focus is sworn to a GROUP (Blades, Blunt, Axes, Bows) — any
    // weapon in it earns the bonus, so a great find is never wasted.
    if (p?.id === 'weapon_focus' && focusMatches(this.game.data, ch, ch.weapon)) {
      const fam = groupOfType(this.game.data, ch.weapon.type); // the family this weapon belongs to
      parts.push([p.dmg ?? 1, `${passiveName(p, 'Weapon Focus')}, ${focusName(this.game.data, fam).toLowerCase()}`]);
    }
    if (p?.id === 'vital_strike' && opts.vital) parts.push([p.dmg ?? 2, `Vital Strike, ${opts.vital}`]);
    if (p?.id === 'sacred_weapon') parts.push([p.dmg ?? 1, 'Sacred Weapon']);
    // The Ranger's styles: Ambidexterity favors one-handed melee, Snap Shot the bow.
    if (p?.id === 'ambidexterity' && !ch.weapon.range && ch.weapon.hands !== 2) parts.push([p.dmg ?? 1, passiveName(p, 'Ambidexterity')]);
    if (p?.id === 'snap_shot' && ch.weapon.range) parts.push([p.dmg ?? 1, passiveName(p, 'Snap Shot')]);
    for (const part of this.game.condParts(ch, 'dmg')) parts.push(part);
    return parts;
  }

  // The physical KIND of a wielded weapon, for monsters that resist steel
  // (resist_physical): blades and axes cut (edged), bows pierce, blunt is
  // blunt — the counterplay weapon for the animated sword's kin.
  weaponKind(w) {
    if (!w?.type) return 'blunt';
    if (w.type === 'weapon_bow') return 'piercing';
    if (w.type.endsWith('_blunt')) return 'blunt';
    return 'edged'; // light/med/heavy blades and axes
  }

  sumParts(parts) { return parts.reduce((s, [v]) => s + v, 0); }
  fmtParts(parts) { return parts.map(([v, l]) => ` ${v > 0 ? '+' : '−'}${Math.abs(v)} ${l}`).join(''); }

  attackBonus(ch, foe = null) { return this.sumParts(this.attackParts(ch, foe)); }
  damageBonus(ch) { return this.sumParts(this.damageParts(ch)); }
  heroAttacks(ch) { return ch.attacks + timedSum(ch, 'attacks'); } // Rage grants extras

  // ---- Stealth & awareness (the Thief stage) ----
  // A foe is UNAWARE of an attacker until its first turn in a fight the
  // party started (surprise!), or whenever the attacker is hidden (Vanish).
  isUnaware(foeC, attackerRef) { return !foeC.aware || !!attackerRef?.hidden; }
  // A foe hemmed in by two or more living heroes is flanked.
  isFlanked(foeC) {
    return this.heroes().filter(h =>
      h.ref.alive && this.adjacent(h, foeC)).length >= 2;
  }
  // Blade Work growth: the extra openings a thief learns to read. Returns
  // the name of the first one that fits (it becomes the log's reason), or
  // null. 'unaware' and 'flanked' are checked before this by the caller.
  growthVital(ch, foeC) {
    const picks = growthPicks(this.game.data, ch).filter(o => o.vital_when);
    if (!picks.length) return null;
    const m = foeC.ref;
    const has = id => (m.conditions ?? []).some(c => c.id === id);
    const fits = {
      poisoned: () => has('poison'),
      wounded: () => m.hp * 2 <= hpMax(m),
      held: () => has('paralysis') || has('sleep') || has('slowed'),
      frightened: () => has('frightened'),
      alone: () => this.isIsolated(foeC, this.combatantOf(ch)),
      bigger: () => hpMax(m) > ch.maxHp,
    };
    const hit = picks.find(o => fits[o.vital_when]?.());
    return hit ? hit.name.toLowerCase() : null;
  }

  // Lethality's demand: no OTHER party member beside the mark.
  isIsolated(foeC, attackerC) {
    return !this.heroes().some(h =>
      h !== attackerC && h.ref.alive && this.adjacent(h, foeC));
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
    // Itemization v2: some foes exist half-elsewhere — mundane steel passes
    // straight through them. Only an 'enchanted' weapon (tier 2+), a spell,
    // or a weapon under an ENCHANT buff (Blooded Steel, Enchant Weapon —
    // designer's magic-to-hit ruling 2026-08-31) can bite a monster marked
    // magic_to_hit in monsters.json.
    if (monster.magic_to_hit && !ch.weapon.enchanted && !(ch.timedBuffs ?? []).some(b => b.enchant)) {
      ch.hidden = false;
      foeC.aware = true;
      this.addFx(foeC.x, foeC.y, 'needs magic!', COLOR.dim);
      this.game.log(`${ch.name}'s ${ch.weapon.name.toLowerCase()} passes straight through the ${monster.name} — only an enchanted weapon or a spell can bite it!`, 'info');
      return { hit: false, immune: true };
    }
    const assassinate = this.assassinateTriggers(c, foeC);
    if (!assassinate && this.assassinateGuarded(c, foeC)) {
      this.addFx(foeC.x, foeC.y, 'guarded!', COLOR.dim);
      this.game.log(`The ${monster.name} is unaware — but an ally stands beside it, and Lethality strikes only the isolated. No Assassinate.`, 'info');
    }
    const wasHidden = !!ch.hidden;
    const vital = this.isUnaware(foeC, ch) ? 'unaware'
      : this.isFlanked(foeC) ? 'flanked'
        : this.growthVital(ch, foeC);
    ch.hidden = false;   // the strike itself steps out of the shadows
    foeC.aware = true;   // one way or another, they know NOW
    const die = d20();
    // True Shot (the Deadeye's Rite): the armed shot cannot miss and crits.
    const trueShot = ch.trueShotArmed && ch.weapon.range && !this.offhandPenalty;
    if (trueShot) { ch.trueShotArmed = false; this.addFx(c.x, c.y, `${(ch.rite?.abilityName ?? 'TRUE SHOT').toUpperCase()}!`, COLOR.gold); }
    const crit = die === 20 || assassinate || !!this.forceCrit || trueShot;
    const atkParts = this.attackParts(ch, monster);
    const atkTotal = die + this.sumParts(atkParts);
    const acCond = this.game.condStat(monster, 'ac');
    const ac = 10 + monster.ac + acCond;
    const acText = `AC ${ac}${acCond ? ` (${acCond > 0 ? '+' : '−'}${Math.abs(acCond)} ${this.game.condParts(monster, 'ac').map(([, n]) => n).join(' & ')})` : ''}`;
    const sure = (ch.timedBuffs ?? []).find(b => b.auto_hit) ?? null; // Eclipse Blade: the blade cannot miss
    if (crit || sure || atkTotal >= ac) {
      // The full-crit rule: the weapon's maximum plus a fresh damage roll.
      const critExtra = crit ? Math.max(0, roll(ch.weapon.damage)) : 0;
      const base = crit ? maxRoll(ch.weapon.damage) + critExtra : roll(ch.weapon.damage);
      const dmgParts = this.damageParts(ch, { vital, foe: monster });
      // Zealous Strike: the stance pays its SP the instant a melee blow lands.
      const zVerb = ch.zealousOn && !ch.weapon.range && hasVerb(this.game.data, ch, 'zealous_strike')
        ? laneOf(this.game.data, ch).verb : null;
      const zeal = zVerb && (this.game.arena || ch.sp >= (zVerb.cost ?? 3));
      if (zVerb && !zeal) this.addFx(foeC.x, foeC.y, 'zeal falters — no SP', COLOR.dim);
      if (zeal) {
        if (!this.game.arena) ch.sp -= zVerb.cost ?? 3;
        dmgParts.push([Math.max(1, roll(zVerb.dice ?? '2d6')), `${zVerb.name ?? 'Zealous Strike'} (${zVerb.dice ?? '2d6'})`]);
      }
      // Elemental weapons (tier abilities): the blade's own extra elemental
      // damage, named. 'dice' may be a die ("1d6") or a flat number ("1" —
      // the tier-3 elemental blades' small offensive rider).
      if (ch.weapon.bonus_damage) {
        const bd = ch.weapon.bonus_damage;
        const flat = /^\d+$/.test(bd.dice);
        const amount = flat ? parseInt(bd.dice, 10) : Math.max(1, roll(bd.dice));
        dmgParts.push([amount, `${flat ? '' : bd.dice + ' '}${bd.element} — ${ch.weapon.name}`]);
      }
      // Spell-borne weapon fire (Mantle of Storms): every timed buff that
      // carries bonus_damage adds its die, by name.
      for (const b of ch.timedBuffs ?? []) {
        if (b.bonus_damage) dmgParts.push([Math.max(1, roll(b.bonus_damage.dice)), `${b.bonus_damage.dice} ${b.bonus_damage.element} — ${b.name}`]);
      }
      let dmg = Math.max(1, base + this.sumParts(dmgParts));
      const preMult = dmg;
      let label = crit ? `-${dmg}!!` : `-${dmg}`;
      let lethal = 0;
      if (assassinate && hasCapstone(this.game.data, ch, 'lethality')) {
        lethal = laneOf(this.game.data, ch).capstone.multiplier ?? 2;
        dmg *= lethal;
        label = `-${dmg}!!!`;
      }
      // Ancient & Bane weapons: against the right family the FINAL total
      // doubles (designer ruling), logged like Lethality.
      const bane = ch.weapon.double_vs && monster.family === ch.weapon.double_vs
        ? `×2 ${ch.weapon.name} — ${ch.weapon.flavor ?? 'bane'} vs ${monster.family}` : null;
      if (bane) {
        dmg *= 2;
        label = `-${dmg}!!`;
        this.addFx(foeC.x, foeC.y, ch.weapon.flavor === 'holy' ? 'holy fire!' : 'bane!', COLOR.gold);
      }
      // Physical resists (the animated sword): edged and piercing steel
      // glances off some hides — half damage, named. Bring a mace.
      const kind = this.weaponKind(ch.weapon);
      let phys = null;
      if (monster.resist_physical?.includes(kind) && dmg > 1) {
        const was = dmg;
        dmg = Math.max(1, Math.floor(dmg / 2));
        phys = `resists ${kind}: ${was} → ${dmg}`;
        this.addFx(foeC.x, foeC.y, `resists ${kind}!`, COLOR.dim);
        label = label.replace(/-\d+/, `-${dmg}`); // keep any crit exclamations
      }
      // Regeneration bookkeeping: an elemental rider on the blow sears the
      // wound so it cannot knit closed next round (troll vs Flame Blade).
      if (ch.weapon.bonus_damage) this.noteElementHit(foeC, ch.weapon.bonus_damage.element);
      for (const b of ch.timedBuffs ?? []) if (b.bonus_damage) this.noteElementHit(foeC, b.bonus_damage.element);
      monster.hp -= dmg;
      this.wake(monster);
      if (crit) audio.play('crit_strike'); // silent until the designer maps it
      if (assassinate) this.addFx(foeC.x, foeC.y, 'ASSASSINATE!', '#b03a8e');
      else if (vital && dmgParts.some(([, l]) => l.startsWith('Vital'))) {
        this.addFx(foeC.x, foeC.y, vital === 'unaware' ? 'vital: unaware!' : 'vital: flanked!', '#b03a8e');
      }
      this.addFx(foeC.x, foeC.y, label, crit ? COLOR.gold : '#ff6a4a');
      // The math, spelled out: every bonus by name, so a +1 FEELS like a +1.
      const toHit = assassinate ? 'auto-hit' : crit ? 'natural 20!' : sure && atkTotal < ac ? `cannot miss — ${sure.name}` : `d20 ${die}${this.fmtParts(atkParts)} = ${atkTotal} vs ${acText}`;
      const mults = `${lethal ? `, ×${lethal} Lethality` : ''}${bane ? `, ${bane}` : ''}${phys ? `, ½ ${phys}` : ''}`;
      const dmgMath = `${crit ? `max ${maxRoll(ch.weapon.damage)} + ${ch.weapon.damage} → ${critExtra}` : `${ch.weapon.damage} → ${base}`}${this.fmtParts(dmgParts)}${mults ? ` = ${preMult}${mults}` : ''} = ${dmg}`;
      this.game.log(assassinate
        ? `${ch.name} strikes from ${wasHidden ? 'the shadows' : 'nowhere'} — ASSASSINATE! (${dmgMath}) — ${dmg} damage to the ${monster.name}!`
        : crit
          ? `A perfect blow! ${ch.name} crits the ${monster.name} (${toHit} · ${dmgMath}) — ${dmg} damage!`
          : `${ch.name} hits the ${monster.name} (${toHit} · ${dmgMath}) — ${dmg} damage.`);
      // Zealous aftermath: the tracked deed, the self-heal, the 18 immunity.
      if (zeal) {
        ch.counters.zealousStrikes++;
        const heal = Math.min(Math.max(1, roll(zVerb.heal ?? '1d6')), ch.maxHp - ch.hp);
        if (heal > 0) { ch.hp += heal; this.fxOn(ch, `+${heal}`, COLOR.green); }
        const immune = hasRefinement(this.game.data, ch, 'zealous_immunity');
        if (immune) ch.zealousImmune = true;
        this.game.log(`${zVerb.name ?? 'Zealous Strike'}! ${ch.name} burns ${this.game.arena ? 0 : zVerb.cost ?? 3} SP${heal > 0 ? ` — ${heal} HP returns` : ''}${immune ? ' — and no affliction can touch them until their next turn' : ''}.`, 'good');
      }
      // Deathless Fury: a share of the wound flows back as the singer's blood.
      const steal = (ch.timedBuffs ?? []).filter(b => b.lifesteal).reduce((m, b) => Math.max(m, b.lifesteal), 0);
      if (steal > 0) {
        const heal = Math.min(Math.floor(dmg * steal), ch.maxHp - ch.hp);
        if (heal > 0) {
          ch.hp += heal;
          this.fxOn(ch, `+${heal}`, '#c03050');
          this.game.log(`${(ch.timedBuffs ?? []).find(b => b.lifesteal === steal)?.name ?? 'The fury'} drinks — ${heal} HP back to ${ch.name}.`, 'good');
        }
      }
      // Whirling Verse: every landed hit earns one more strike (which does
      // not itself chain — the verse has a meter).
      const verse = (ch.timedBuffs ?? []).find(b => b.verse);
      let kill = monster.hp <= 0;
      // Storm of Blades: a main-hand hit earns a free off-hand strike, no penalty.
      const storm = (ch.timedBuffs ?? []).find(b => b.storm);
      if (storm && ch.offhand && !this.offhanding && !this.offhandPenalty && monster.hp > 0 && !ch.weapon.range) {
        this.addFx(c.x, c.y, `${storm.name}!`, COLOR.sun);
        const again = this.offhandStrike(c, foeC, 0);
        dmg += again.dmg ?? 0;
        kill = kill || again.kill;
      }
      if (verse && !this.inVerse && monster.hp > 0 && !ch.weapon.range) {
        this.inVerse = true;
        this.addFx(c.x, c.y, `${verse.name}!`, COLOR.sun);
        this.game.log(`${verse.name} — ${ch.name} strikes again!`, 'combat');
        const again = this.strike(c, foeC, 'strikes');
        this.inVerse = false;
        dmg += again.dmg ?? 0;
        kill = kill || again.kill;
      }
      return { hit: true, crit, assassinate, kill, dmg };
    }
    this.addFx(foeC.x, foeC.y, 'miss', COLOR.dim);
    this.game.log(`${ch.name} ${verb} at the ${monster.name} and misses (d20 ${die}${this.fmtParts(atkParts)} = ${atkTotal} vs ${acText}).`);
    return { hit: false, crit: false, assassinate: false, kill: false, dmg: 0 };
  }

  // The Hawk's Volley: after a bow kill, another arrow flies free at the
  // nearest other foe in range and sight; a kill keeps the chain going.
  volleyChain(c) {
    const ch = c.ref;
    const verb = laneOf(this.game.data, ch).verb;
    for (let links = 0; links < CHAIN_CAP; links++) {
      if (this.game.quiverCount(ch) <= 0) { this.game.log(`${verb.name ?? 'Volley'} ends — the quiver is empty.`, 'info'); return; }
      const next = this.monsters()
        .filter(m => this.dist(c.x, c.y, m.x, m.y) <= (ch.weapon.range ?? 0) && this.losClear(c.x, c.y, m.x, m.y))
        .sort((a, b) => this.dist(c.x, c.y, a.x, a.y) - this.dist(c.x, c.y, b.x, b.y))[0];
      if (!next) return;
      this.addFx(c.x, c.y, `${(verb.name ?? 'VOLLEY').toUpperCase()}!`, COLOR.amber);
      this.game.log(`${verb.name ?? 'Volley'}! ${ch.name} looses again at the ${next.ref.name}.`, 'combat');
      const res = this.shoot(c, next, 0);
      if (res.kill) { ch.counters.volleyKills++; this.slay(next.ref); continue; }
      return;
    }
  }

  // Way of the Blade, level 10: felling a foe grants a free attack on
  // another foe in reach — and kills CHAIN. At 18 a natural 20 counts too.
  rampageChain(c) {
    if (!hasVerb(this.game.data, c.ref, 'rampage')) return;
    for (let links = 0; links < CHAIN_CAP; links++) { // generous cap against pathology
      const next = this.monsters()
        .filter(mc => this.adjacent(mc, c))
        .sort((a, b) => a.ref.hp - b.ref.hp)[0]; // fury seeks the weakest neighbor
      if (!next) return;
      this.addFx(c.x, c.y, 'RAMPAGE!', COLOR.red);
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

  // One swing with the OFF-HAND weapon (the Ranger's second blade), at the
  // given to-hit penalty. The main weapon is swapped out for the roll so
  // every part of the math names the right blade.
  offhandStrike(c, foeC, penalty) {
    const ch = c.ref;
    const main = ch.weapon;
    ch.weapon = ch.offhand;
    this.offhandPenalty = penalty;
    this.offhanding = true;
    this.game.log(`${ch.name}'s off-hand ${ch.weapon.name.toLowerCase()} follows${penalty ? ` (−${penalty} off-hand)` : ''}.`, 'combat');
    const res = this.strike(c, foeC, 'cuts');
    this.offhanding = false;
    this.offhandPenalty = 0;
    ch.weapon = main;
    return res;
  }

  // One shot's bookkeeping: an arrow spent, the flight drawn, the strike.
  shoot(c, foeC, delay = 0) {
    const ch = c.ref;
    this.game.spendAmmo(ch);
    audio.play('arrow');
    this.fxDelay = this.emitArrow(c, foeC, delay);
    const res = this.strike(c, foeC, 'shoots');
    this.fxDelay = 0;
    if (!res.hit && !res.immune) (this.arrowsMissed ??= new Map()).set(ch, (this.arrowsMissed.get(ch) ?? 0) + 1);
    return res;
  }

  heroAttack(c, foeC, verb = 'swings') {
    const ch = c.ref, monster = foeC.ref;
    const shooting = verb === 'shoots';
    if (!shooting) audio.play('melee_hit');
    let killed = false, crit = false;
    // Hunter's Surge (Wolf stance): the attack action spends SP so the
    // off-hand matches the main hand blow for blow this turn.
    const surgeVerb = ch.surgeOn && ch.offhand && !shooting && hasVerb(this.game.data, ch, 'hunters_surge') ? laneOf(this.game.data, ch).verb : null;
    const surgeCost = ch.packArmed ? 0 : (surgeVerb?.cost ?? 2);
    const surging = surgeVerb && (this.game.arena || ch.sp >= surgeCost);
    if (surgeVerb && !surging) this.addFx(c.x, c.y, 'surge falters — no SP', COLOR.dim);
    if (surging) {
      if (!this.game.arena) ch.sp -= surgeCost;
      this.addFx(c.x, c.y, `${(surgeVerb.name ?? 'SURGE').toUpperCase()}!`, COLOR.sun);
      this.game.log(`${surgeVerb.name ?? "Hunter's Surge"}! ${ch.name} spends ${surgeCost} SP — both blades, blow for blow.`, 'good');
    }
    const rain = shooting ? (ch.timedBuffs ?? []).find(b => b.rain) : null;
    const huntKills = () => surging || (ch.timedBuffs ?? []).some(b => b.storm);
    for (let a = 0; a < this.heroAttacks(ch) && monster.hp > 0; a++) {
      let res;
      if (shooting) {
        // The arrow crosses the field; its number lands on impact. A second
        // shot follows a beat behind the first.
        if (this.game.quiverCount(ch) <= 0) { this.game.log(`${ch.name}'s quiver is empty.`, 'info'); break; }
        res = this.shoot(c, foeC, a * TIMING.stagger);
        // Rain of Arrows: every foe beside the target takes a shaft too.
        if (rain) {
          for (const other of this.monsters().filter(m => m !== foeC && this.dist(m.x, m.y, foeC.x, foeC.y) <= (rain.spread ?? 1))) {
            if (this.game.quiverCount(ch) <= 0) { this.game.log(`The quiver runs dry mid-rain.`, 'info'); break; }
            if (!this.losClear(c.x, c.y, other.x, other.y)) continue;
            this.addFx(other.x, other.y, rain.name, COLOR.amber);
            const r2 = this.shoot(c, other, a * TIMING.stagger + 120);
            if (r2.kill) this.slay(other.ref);
          }
        }
      } else {
        res = this.strike(c, foeC, verb);
      }
      killed = killed || res.kill;
      crit = crit || res.crit;
      if (res.assassinate && res.kill) ch.counters.assassinateKills++;
      if (res.kill && huntKills()) ch.counters.surgeKills++;
    }
    // Two blades: the off-hand swings once (or, surging, once per main-hand
    // attack) at the style's penalty — never alongside a bow.
    if (!shooting && ch.offhand && monster.hp > 0 && !(ch.timedBuffs ?? []).some(b => b.storm)) {
      const swings = surging ? this.heroAttacks(ch) : 1;
      const penalty = this.offhandPenaltyFor(ch);
      for (let a = 0; a < swings && monster.hp > 0; a++) {
        const res = this.offhandStrike(c, foeC, penalty);
        killed = killed || res.kill;
        if (res.kill && huntKills()) ch.counters.surgeKills++;
      }
    }
    if (monster.hp <= 0) this.slay(monster);
    // Volley (Hawk verb): a bow kill grants a free shot at another foe in
    // range — the chain runs while kills and arrows last.
    if (shooting && killed && hasVerb(this.game.data, ch, 'volley')) this.volleyChain(c);
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

  // Overcast can boost any spell that rolls dice (damage or healing).
  overcastable(s) { return !!SPELL_EFFECTS[s.type].overcast; }

  overcastCost(ch, base) {
    return hasRefinement(this.game.data, ch, 'overcast_cheap') ? Math.ceil(base * 1.5) : base * 2;
  }

  // The battle menu's spell list (magic v2): what the hero KNOWS and may
  // cast — prepared spells for the Wizard lane, the blood-list for the
  // Sorcerer, everything trained for everyone else. Costs are computed
  // (level × 2 + 1, Overchannel −1), doubled under an Overcast stance.
  // The Final Word (armed) opens the whole book at no cost; the Archmage's
  // once-per-rest reach appends the unprepared pages at ALL remaining SP.
  castables(c) {
    const ch = c.ref;
    const data = this.game.data;
    if (ch.finalWordArmed) {
      return knownSpells(data, ch).map(s => ({ ...s, cost: 0, free: true, affordable: true,
        description: `${s.description} (${ch.rite?.abilityName ?? 'The Final Word'}: costs nothing)` }));
    }
    const list = this.game.castableSpells(ch).map(s => {
      let cost = spellCost(data, ch, s);
      let overcast = false;
      if (ch.overcastOn && this.overcastable(s)) {
        cost = this.overcastCost(ch, cost);
        overcast = true;
      }
      const v = overcast ? laneOf(data, ch).verb : null;
      const spent = !!s.once_per_rest && !!ch.spentRest?.[s.id];
      return { ...s, cost, overcast, dc_bonus: v ? (v.dc_bonus ?? 1) : 0,
        affordable: !spent && (this.game.arena || ch.sp >= cost),
        description: spent ? `${s.description} (once per rest — spent; a night's rest returns it)` : s.once_per_rest ? `${s.description} (once per rest)` : s.description };
    });
    if (hasCapstone(data, ch, 'archmage') && !ch.spentRest?.archmage) {
      const capName = laneOf(data, ch).capstone.name ?? 'Archmage';
      for (const s of unpreparedSpells(data, ch)) {
        list.push({ ...s, cost: Math.max(1, ch.sp), archmage: true, affordable: this.game.arena || ch.sp >= 1,
          description: `${s.description} (${capName}: unprepared — costs ALL ${ch.sp} SP, once per rest)` });
      }
    }
    return list;
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
    const ctx = { D: this.game.data, ref, lane, cap: lane?.capstone, rite: riteOf(this.game.data, ref) };
    const out = [];
    for (const art of CLASS_ACTIVES) art.menu(this, c, ctx, out);
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
    this.menuSel = 0; // the list can outgrow the digits — arrows walk it
    this.mode = 'menu';
  }

  menuMove(dy) {
    const c = this.active();
    const n = this.abilities(c).length;
    if (!n) return;
    this.menuSel = ((this.menuSel ?? 0) + dy + n) % n;
  }

  chooseSpell(n) {
    const c = this.active();
    const list = this.abilities(c);
    const s = list[n - 1];
    if (!s) return;
    if (s.kind === 'active') {
      if (s.targeted) { // trap squares, deathblow marks, shadowstep landings
        this.pending = { kind: s.targeted.kind, range: s.targeted.range, snare: s.targeted.snare, entry: s };
        this.beginTargeting(s.targeted.kind === 'shadowstep');
        return;
      }
      this.mode = 'move';
      this.useActive(c, s);
      return;
    }
    if (!s.affordable) {
      const spent = s.once_per_rest && c.ref.spentRest?.[s.id];
      this.addFx(c.x, c.y, spent ? 'spent — rest first' : 'not enough SP', COLOR.dim);
      this.game.log(spent ? `${s.name} is spent until the party rests.` : `${c.ref.name} lacks the spell points for ${s.name}.`, 'info');
      return;
    }
    this.startCast(c, s);
  }

  // A spell leaves the menu: some need no aim at all (the whole party, the
  // caster alone, a burst centered on the caster, every foe on the field);
  // the rest raise the crosshair — friendly for heals, cures, raisings and
  // single-ally buffs.
  startCast(c, s) {
    const selfCentered = s.targets === 'self' || s.targets === 'allies' || s.area === 'all'
      || ((s.range ?? 0) === 0 && (s.area ?? 0) > 0);
    if (selfCentered) { this.mode = 'move'; this.castAt(c, s, c.x, c.y); return; }
    this.pending = { kind: 'spell', spell: s, range: s.range ?? 0 };
    this.beginTargeting(!!SPELL_EFFECTS[s.type].friendly, s);
  }

  // Capstone actives. Like a swing or a spell, using one ends the turn.
  useActive(c, entry) {
    const ref = c.ref;
    const lane = laneOf(this.game.data, ref);
    const art = CLASS_ACTIVES.find(a => a.id === entry.id);
    if (!art?.use) throw new Error(`No battle art resolves "${entry.id}" — add it to engine/class-actives.js.`);
    art.use(this, c, entry, { D: this.game.data, ref, lane, cap: lane?.capstone });
  }

  // Deep Roots: the defensive buffs on the dwarf worth sharing — anything
  // with AC, saves, resistance, or damage reduction (not the capstone's own
  // wall, which is theirs alone).
  shareableWards(ref) {
    return (ref.timedBuffs ?? []).filter(b => !b.no_hit_bonus && ((b.ac ?? 0) > 0 || (b.saves ?? 0) > 0 || b.resist || (b.reduce ?? 0) > 0 || b.halve));
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
    const potions = this.game.heldItems().map(it =>
      ({ ...it, kind: 'potion', usable: !this.game.itemBlockReason(it.def, c.ref) }));
    // Scrolls (magic v3): an arcane caster reads the words off the page —
    // one cast, no SP, the scroll burns. Others see why they can't.
    const scrolls = this.game.readableScrolls(c.ref).map(sc => ({ ...sc, kind: 'scroll', usable: !sc.reason }));
    // Restocking the quiver mid-fight: a full turn's work (the arena's is bottomless).
    const out = [...potions, ...scrolls];
    const ch = c.ref;
    const ammo = this.game.ammoId();
    if (ammo && ch.weapon?.range && !this.game.arena) {
      const cap = this.game.quiverCap(ch), have = this.game.quiverCount(ch), spare = this.game.ammoCount();
      const room = cap - have;
      const usable = room > 0 && spare > 0;
      out.push({ id: '__restock', kind: 'restock', usable, count: spare,
        def: { name: 'Restock the quiver', description: !room ? `The quiver is full (${have}/${cap}).` : !spare ? `The pouch holds no spare arrows.` : `Move ${Math.min(room, spare)} arrows from the pouch into the quiver (${have}/${cap}) — takes the turn.` } });
    }
    return out;
  }

  openItems() {
    const c = this.active();
    if (!c || c.kind !== 'hero') return;
    if (!this.usableItems(c).length) {
      this.game.log('The party pouch holds no potions or scrolls.', 'info');
      return;
    }
    this.mode = 'items';
  }

  chooseItem(n) {
    const c = this.active();
    const it = this.usableItems(c)[n - 1];
    if (!it) return;
    if (it.kind === 'restock') {
      if (!it.usable) { this.game.log(it.def.description, 'info'); return; }
      const moved = this.game.restockQuiver(c.ref);
      this.mode = 'move';
      this.addFx(c.x, c.y, `+${moved} arrows`, COLOR.amber);
      this.game.log(`${c.ref.name} refills the quiver from the pouch (+${moved} → ${c.ref.quiver}/${this.game.quiverCap(c.ref)}) — it takes the turn.`, 'info');
      this.endHeroTurn();
      return;
    }
    if (it.kind === 'scroll') {
      if (!it.usable) { this.game.log(it.reason, 'info'); return; }
      this.mode = 'move';
      // The Thief's gamble (2026-09-03): a non-caster puzzling at a scroll
      // gets one roll. Fail and the page burns anyway — that IS the risk.
      const gamble = scrollGamble(c.ref, it.spell);
      if (gamble) {
        const roll = Math.floor(Math.random() * 100) + 1;
        const chance = gamble.chance ?? 60;
        if (roll > chance) {
          this.game.consumeScroll(it.id);
          audio.play('spellbook');
          this.addFx(c.x, c.y, 'it burns!', COLOR.red);
          this.game.log(`${c.ref.name} squints at the ${it.def.name} — the words twist away (rolled ${roll} vs ${chance}%). The page blackens and crumbles, and the moment is lost.`, 'death');
          this.endHeroTurn();
          return;
        }
        this.game.log(`${c.ref.name} wrestles the ${it.def.name} into sense (rolled ${roll} vs ${chance}%) — it works!`, 'good');
      }
      // The scroll's spell, cast at no cost — the item id rides along so
      // spendSpell can burn it instead of SP.
      this.startCast(c, { ...it.spell, cost: 0, scroll: it.id, scrollName: it.def.name, affordable: true });
      return;
    }
    const res = this.game.useItem(it.id, c.ref);
    if (!res.ok) return; // blocked (unhurt / not poisoned) — menu stays open
    this.mode = 'move';
    this.addFx(c.x, c.y, res.fxText, res.fxColor);
    this.endHeroTurn();
  }

  beginShoot() {
    const c = this.active();
    if (!c || c.kind !== 'hero' || !this.canShoot(c)) return;
    const why = this.shootBlock(c);
    if (why) {
      this.addFx(c.x, c.y, 'no shot', COLOR.dim);
      this.game.log(`${c.ref.name} cannot shoot — ${why}.`, 'info');
      return;
    }
    this.pending = { kind: 'shoot', range: c.ref.weapon.range };
    this.beginTargeting(false);
  }

  // ---- Swap weapons (W): draw a blade, or ready the bow — it costs the turn.
  swapOptions(c) { return this.game.swapOptions(c.ref); }

  openSwap() {
    const c = this.active();
    if (!c || c.kind !== 'hero') return;
    if (!this.swapOptions(c).length) {
      this.game.log('The party pouch holds no other weapon or shield.', 'info');
      return;
    }
    this.mode = 'swap';
  }

  chooseSwap(n) {
    const c = this.active();
    const it = this.swapOptions(c)[n - 1];
    if (!it) return;
    if (it.reason) { this.game.log(it.reason, 'info'); return; }
    const ch = c.ref;
    const wasTwoHanded = !!this.game.twoHanded(ch);
    if (!this.game.equipItem(it.id, ch)) return;
    // Readying for melee is ONE act: a one-hander drawn in place of a bow
    // brings a shield up with it, if the pouch holds one the hero may carry.
    if (wasTwoHanded && it.def.type.startsWith('weapon_') && it.def.hands !== 2 && !ch.equipment.hand2) {
      const shield = this.game.swapOptions(ch).find(o => o.def.type === 'shield' && !o.reason);
      if (shield) this.game.equipItem(shield.id, ch);
    }
    this.mode = 'move';
    this.addFx(c.x, c.y, `${it.def.name} ready`, COLOR.amber);
    // Quickdraw (a Ranger knack): so many swaps per battle cost nothing.
    const free = giftOf(ch)?.free_swaps ?? 0;
    if (free > (ch.freeSwapsUsed ?? 0)) {
      ch.freeSwapsUsed = (ch.freeSwapsUsed ?? 0) + 1;
      this.game.log(`${ch.name} readies the ${it.def.name.toLowerCase()} in a blink — ${giftOf(ch).name}: no turn spent.`, 'good');
      return;
    }
    this.game.log(`${ch.name} readies the ${it.def.name.toLowerCase()} — the swap takes the turn.`, 'info');
    this.endHeroTurn();
  }

  // A square the crosshair may occupy: in range AND in line of sight.
  // The cursor is hard-clamped to these — you can never aim at what you
  // cannot legally hit.
  targetable(x, y) {
    const c = this.active();
    if (this.monsterAt(x, y)?.unseen) return false; // you cannot aim at what you cannot see
    return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H
      && this.dist(c.x, c.y, x, y) <= this.pending.range
      && this.losClear(c.x, c.y, x, y);
  }

  // The heroes a friendly spell would most obviously want: the fallen for
  // a raising, the afflicted for a cure, the wounded for a heal, and any
  // OTHER living ally for a single-ally buff — then anyone living.
  friendlyCandidates(s) {
    const alive = this.heroes().filter(h => h.ref.alive);
    if (s?.type === 'raise') return SPELL_EFFECTS.raise.candidates(this, s, alive);
    const pick = SPELL_EFFECTS[s?.type]?.candidates?.(this, s, alive) ?? alive.filter(h => h.ref.hp < h.ref.maxHp);
    return pick.length ? pick : alive;
  }

  beginTargeting(friendly, spell = null) {
    const c = this.active();
    this.mode = 'target';
    // Start the crosshair on the most obvious LEGAL target; if nothing is
    // in reach, fall back to the caster's own square so the player sees
    // the range ring around themselves rather than a phantom lock-on.
    const candidates = friendly ? this.friendlyCandidates(spell) : this.visibleMonsters();
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
      c.ref.hidden = false; // loosing an arrow gives you away
      this.heroAttack(c, foe, 'shoots'); // ends the turn
      return;
    }

    // Snares (2026-09-03): an empty square and your whole turn. Placing
    // ALWAYS works — skill instead sets the DC of the rider, so a sharper
    // rogue's venom is harder to shake. No more wasted turns to a jam.
    if (p.kind === 'trap') {
      if (!this.open(x, y)) return; // needs bare floor
      this.cancelTargeting();
      const { dice } = snareDice(this.game.data, c.ref);
      const kind = p.snare ?? 'plain';
      const rider = SNARE_RIDERS[kind] ?? null;
      const name = snareKinds(this.game.data, c.ref).find(k => k.id === kind)?.name ?? 'snare';
      audio.play('disarm');
      this.battleTraps.push({ x, y, owner: c.ref, dice, kind, name, rider, dc: this.snareDC(c.ref) });
      c.ref.counters.shadowFeats++;
      this.addFx(x, y, 'snare set', COLOR.amber);
      this.game.log(`${c.ref.name} lays ${name === 'Snare' ? 'a snare' : `a ${name.toLowerCase()}`} and steps back. Someone will find it the hard way.`, 'good');
      this.endHeroTurn();
      return;
    }

    // Shared Fortitude (Hearthstone verb): an ally's second wind, bought with SP.
    if (p.kind === 'fortify') {
      const hc = this.heroAt(x, y);
      if (!hc) return;
      if (hc === c) { this.game.log(`${c.ref.name}'s fortitude is for others — aim at an ally.`, 'info'); return; }
      this.cancelTargeting();
      const v = laneOf(this.game.data, c.ref).verb;
      const cost = v.cost ?? 3;
      if (!this.game.arena) c.ref.sp = Math.max(0, c.ref.sp - cost);
      audio.play('spell_buff');
      const targets = [hc];
      if (hasRefinement(this.game.data, c.ref, 'fortitude_two')) {
        const other = this.heroes().filter(h => h !== hc && h !== c && h.ref.alive)
          .sort((a, b) => a.ref.hp / a.ref.maxHp - b.ref.hp / b.ref.maxHp)[0];
        if (other) targets.push(other);
      }
      const con = abilityMod(c.ref.abilities.con);
      for (const t of targets) {
        const base = Math.max(1, roll(v.dice ?? '2d8'));
        const pool = Math.max(1, base + con);
        t.ref.timedBuffs = (t.ref.timedBuffs ?? []).filter(b => b.name !== (v.name ?? 'Shared Fortitude'));
        this.addTimedBuff(t.ref, { name: v.name ?? 'Shared Fortitude', rounds: null, absorb: pool });
        c.ref.counters.alliesFortified++;
        this.addFx(t.x, t.y, `+${pool} ward`, COLOR.ember);
        this.particleFx(t.x, t.y, 'sparkle', COLOR.ember);
        this.game.log(`${v.name ?? 'Shared Fortitude'}: ${t.ref.name} gains ${pool} absorbed damage (${v.dice ?? '2d8'} → ${base}${con ? ` ${con > 0 ? '+' : '−'}${Math.abs(con)} CON` : ''}) for the battle${targets.length > 1 && t === targets[1] ? ' — sheltered too' : ''}.`, 'good');
      }
      this.game.log(`${c.ref.name} spends ${this.game.arena ? 0 : cost} SP on ${v.name ?? 'Shared Fortitude'}.`, 'info');
      this.endHeroTurn();
      return;
    }

    // Deathblow (the Assassin's Rite): one perfect strike, no conditions.
    if (p.kind === 'deathblow') {
      const foeC = this.monsterAt(x, y);
      if (!foeC) return;
      this.cancelTargeting();
      this.markSpent(c.ref, 'deathblow');
      audio.play('melee_hit');
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

    // Judgment (the Knight Templar's Rite): a strike that was always going
    // to land — an automatic critical whose damage returns as healing.
    if (p.kind === 'judgment') {
      const foeC = this.monsterAt(x, y);
      if (!foeC) return;
      this.cancelTargeting();
      this.markSpent(c.ref, 'judgment');
      audio.play('spell_light');
      this.addFx(c.x, c.y, `${p.entry.name.toUpperCase()}!`, COLOR.gold);
      this.game.log(`${c.ref.name} pronounces ${p.entry.name} — this blow was written before the fight began.`, 'good');
      this.forceCrit = true;
      const res = this.strike(c, foeC, 'strikes');
      this.forceCrit = false;
      const heal = Math.min(res.dmg ?? 0, c.ref.maxHp - c.ref.hp);
      if (heal > 0) {
        c.ref.hp += heal;
        this.fxOn(c.ref, `+${heal}`, COLOR.green);
        this.game.log(`${p.entry.name} returns its harvest — ${heal} HP to ${c.ref.name}.`, 'good');
      }
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
      audio.play('spell_arcane');
      this.addFx(c.x, c.y, `${p.entry.name.toUpperCase()}!`, COLOR.shadow);
      c.x = x; c.y = y;
      c.ref.hidden = true;
      c.ref.counters.shadowFeats++;
      this.addFx(x, y, 'from the shadows…', COLOR.shadow);
      this.game.log(`${c.ref.name} is simply… elsewhere. The shadows keep their secret.`, 'good');
      return; // free — the turn goes on
    }

    this.castAt(c, p.spell, x, y); // keeps aiming if the square is no legal target
  }

  // Cast (or read) a spell at a square. Returns false — crosshair stays up —
  // when the square is no legal target for it.
  castAt(c, s, x, y) {
    // Legal-target checks first (per effect type — engine/spell-effects.js).
    if (!SPELL_EFFECTS[s.type].legal(this, c, s, x, y)) return false;
    if (this.mode === 'target') this.cancelTargeting();
    c.ref.hidden = false; // spellwork glows — the shadows can't keep you
    this.spendSpell(c.ref, s);
    audio.play(this.spellSound(s));
    if (fromScroll(s)) {
      this.game.log(`${c.ref.name} unrolls the ${s.scrollName} and reads ${s.name} — the words burn off the page${this.game.arena ? ' (arena: the scroll survives)' : ''}.`, 'info');
    } else {
      this.game.log(`${c.ref.name} casts ${s.name}${s.overcast ? ' — OVERCAST' : ''}${s.archmage ? ` — ${laneOf(this.game.data, c.ref).capstone.name ?? 'the Archmage\'s reach'}, every point spent` : ''}${s.free ? ` — by ${c.ref.rite?.abilityName ?? 'the Final Word'}, freely` : ''}!`, 'info');
    }
    this.resolveSpell(c, s, x, y);
    // Stormsurge: the same spell, twice in immediate succession — then the
    // backlash claims the next round. A scroll read is not a cast.
    if (c.ref.twinArmed && s.type !== 'buff' && !fromScroll(s)) {
      c.ref.twinArmed = false;
      c.ref.spentRest.twin_surge = true;
      const capName = laneOf(this.game.data, c.ref).capstone?.name ?? 'Stormsurge';
      this.game.log(`${capName}! The storm is not done — ${s.name} strikes AGAIN!`, 'good');
      this.resolveSpell(c, s, x, y);
      this.game.applyCondition(c.ref, 'exhaustion', 1);
      this.fxOn(c.ref, 'Exhausted', '#c8b88a');
    }
    this.endHeroTurn();
    return true;
  }

  // A spell's voice: its element class from spells.json fx.sound
  // (fire/frost/lightning/light/arcane), or heal/buff/arcane by type.
  spellSound(s) {
    const e = SPELL_EFFECTS[s.type];
    const first = e.soundFirst?.(s); // the L5 miracle speaks ahead of everything else
    if (first) return first;
    if (s.fx?.sound) return `spell_${s.fx.sound}`;
    return e.sound ?? 'spell_arcane';
  }

  // ---- Spell visuals ----
  // Every cast draws its geometry: a dart that TRAVELS the line, a beam that
  // CONNECTS caster and target, a burst that washes exactly the squares it
  // caught, sparkles that rise from the mended. The look lives in
  // spells.json "fx" ({kind, color, burst}); these defaults cover any spell
  // without one. Returns the milliseconds until IMPACT so the numbers can
  // arrive with the blow.
  defaultFx(s) {
    return SPELL_EFFECTS[s.type]?.fx?.(s) ?? SPELL_EFFECTS.damage.fx(s); // monster abilities pass type 'damage'
  }

  emitSpellFx(c, s, x, y) {
    const fx = { ...this.defaultFx(s), ...(s.fx ?? {}) };
    const now = performance.now();
    const from = { x: c.x, y: c.y }, to = { x, y };
    let impact = 0;
    if (fx.kind === 'bolt' && (from.x !== to.x || from.y !== to.y)) {
      const dur = Math.min(420, 140 + Math.hypot(to.x - from.x, to.y - from.y) * 42);
      this.spellFx.push({ kind: 'bolt', from, to, color: fx.color, born: now, dur });
      impact = dur;
    } else if (fx.kind === 'lightning') {
      // The jag is rolled ONCE so every frame draws the same crack.
      const steps = Math.max(4, Math.round(Math.hypot(to.x - from.x, to.y - from.y) * 2));
      const points = Array.from({ length: steps + 1 }, (_, i) => {
        const t = i / steps;
        const mid = i > 0 && i < steps;
        return {
          x: from.x + (to.x - from.x) * t + (mid ? (Math.random() - 0.5) * 0.7 : 0),
          y: from.y + (to.y - from.y) * t + (mid ? (Math.random() - 0.5) * 0.7 : 0),
        };
      });
      this.spellFx.push({ kind: 'lightning', from, to, points, color: fx.color, born: now, dur: 380 });
      impact = 90;
    } else if (fx.kind === 'beam') {
      this.spellFx.push({ kind: 'beam', from, to, color: fx.color, born: now, dur: 340 });
      impact = 90;
    } else if (fx.kind === 'sparkle' || fx.kind === 'wisp') {
      this.particleFx(x, y, fx.kind, fx.color);
    }
    if (fx.burst || fx.kind === 'burst') {
      this.spellFx.push({
        kind: 'burst', to, area: typeof s.area === 'number' ? s.area : 0, sprite: fx.burst ?? 'fire',
        color: fx.color, born: now + impact, dur: 460,
      });
    }
    return impact;
  }

  particleFx(x, y, kind, color) {
    const parts = Array.from({ length: 7 }, () => ({
      dx: (Math.random() - 0.5) * 0.9,
      rise: 0.25 + Math.random() * 0.5,
      scale: 0.45 + Math.random() * 0.55,
      phase: Math.random() * 0.35,
    }));
    this.spellFx.push({ kind, to: { x, y }, parts, color, born: performance.now(), dur: 750 });
  }

  // A shot in flight: a thin dark shaft, no glow, travelling caster→target
  // like a bolt. Returns the ms until it lands (numbers wait for it).
  emitArrow(c, foeC, delay = 0) {
    const from = { x: c.x, y: c.y }, to = { x: foeC.x, y: foeC.y };
    const dur = Math.min(360, 120 + Math.hypot(to.x - from.x, to.y - from.y) * 36);
    this.spellFx.push({ kind: 'arrow', from, to, color: '#2a2218', born: performance.now() + delay, dur });
    return delay + dur;
  }

  // Pay for a cast (and settle the flags & tracked deeds that ride along).
  spendSpell(ref, s) {
    if (fromScroll(s)) { this.game.consumeScroll(s.scroll); return; } // the page, not the well
    if (s.free) { ref.finalWordArmed = false; this.markSpent(ref, 'final_word'); }
    if (s.overcast) ref.counters.overcasts++; // the Sorcerer's tracked deed
    if (s.once_per_rest) (ref.spentRest ??= {})[s.id] = true; // Circle of Endurance and kin
    if ((s.archmage || s.free) && !(ref.prepared ?? []).includes(s.id)) {
      ref.counters.bookCasts++; // a page read outside today's preparation
    }
    if (this.game.arena) return; // training is free
    if (s.archmage) { ref.spentRest.archmage = true; ref.sp = 0; return; }
    if (!s.free) ref.sp = Math.max(0, ref.sp - (s.cost ?? 0));
  }

  // The shared arithmetic of a cast: stat mod, the save DC (spelled out),
  // the Overcast verb if burning, and this spell's caster-level growth.
  spellMath(c, s) {
    const ch = c.ref;
    const statName = s.stat === 'wis' ? 'WIS' : 'INT';
    const statMod = abilityMod(ch.abilities[s.stat]);
    const fmtStat = statMod ? ` ${statMod > 0 ? '+' : '−'}${Math.abs(statMod)} ${statName}` : '';
    const over = s.overcast ? laneOf(this.game.data, ch).verb : null;
    let dc = 10 + s.level + statMod;
    let dcMath = `10 +${s.level} spell level${fmtStat}`;
    if (ch.insight?.dc) { dc += ch.insight.dc; dcMath += ` +${ch.insight.dc} Arcane Insight`; }
    if (over) { dc += over.dc_bonus ?? 1; dcMath += ` +${over.dc_bonus ?? 1} ${over.name ?? 'Overcast'}`; }
    const steps = scaleSteps(s, ch.level);
    const sc = s.scale ?? {};
    return { statMod, fmtStat, over, dc, dcMath, steps, sc,
      extraRounds: sc.rounds ? steps * sc.rounds : 0,
      extraTargets: sc.extra_targets ? steps * sc.extra_targets : 0,
      extraArea: sc.area ? steps * sc.area : 0 };
  }

  // Dice + stat + Insight + Overcast + caster-level growth, every part named.
  rollSpellAmount(c, s, m, kind) {
    const ch = c.ref;
    const base = roll(s.dice);
    let amount = base + m.statMod;
    let math = `${s.dice} → ${base}${m.fmtStat}`;
    if (kind === 'damage' && ch.insight?.dmg) { amount += ch.insight.dmg; math += ` +${ch.insight.dmg} Arcane Insight`; }
    if (kind === 'heal') {
      const p = passiveOf(this.game.data, ch);
      if (p?.id === 'blessed_hands') { amount += p.heal ?? 2; math += ` +${p.heal ?? 2} Blessed Hands`; }
    }
    if (m.over) { const extra = roll(m.over.extra_dice ?? '2d6'); amount += extra; math += ` +${m.over.extra_dice ?? '2d6'} → ${extra} ${m.over.name ?? 'Overcast'}`; }
    if (m.steps > 0 && (m.sc.dice || m.sc.flat)) {
      if (m.sc.dice) {
        let grown = 0;
        for (let i = 0; i < m.steps; i++) grown += roll(m.sc.dice);
        amount += grown;
        math += ` +${m.steps > 1 ? `${m.steps}×` : ''}${m.sc.dice} → ${grown} caster level`;
      }
      if (m.sc.flat) { amount += m.steps * m.sc.flat; math += ` +${m.steps * m.sc.flat} caster level`; }
    }
    return { amount: Math.max(1, amount), math };
  }

  // One full resolution of a spell's effect — no cost, no turn-end (so
  // Stormsurge can simply run it twice). Every number wears its name.
  resolveSpell(c, s, x, y) {
    const m = this.spellMath(c, s);
    // The spell's geometry plays out; numbers wait for the moment of impact.
    const impact = this.emitSpellFx(c, s, x, y);
    return SPELL_EFFECTS[s.type].resolve(this, c, s, x, y, m, impact);
  }

  // Strip the conditions a spell cures from one hero; returns the names.
  cureConditions(ref, cures) {
    const gone = [];
    ref.conditions = ref.conditions.filter(cd => {
      const hit = cures === 'all' || (cures ?? []).includes(cd.id);
      if (hit) gone.push(this.game.conditionDef(cd.id)?.name ?? cd.id);
      return !hit;
    });
    return gone;
  }

  resolveHeal(c, s, x, y, m, impact) {
    const targets = s.targets === 'allies'
      ? this.heroes().filter(h => h.ref.alive)
      : [this.heroAt(x, y)].filter(Boolean);
    if (!targets.length) return;
    for (const t of targets) {
      const { amount, math } = this.rollSpellAmount(c, s, m, 'heal');
      const healed = Math.min(amount, t.ref.maxHp - t.ref.hp);
      t.ref.hp += healed;
      const cured = s.cures ? this.cureConditions(t.ref, s.cures) : [];
      if (healed > 0 || cured.length) this.addFx(t.x, t.y, healed > 0 ? `+${healed}` : 'cured!', COLOR.green, impact);
      if (targets.length > 1 && t !== targets[0]) this.particleFx(t.x, t.y, 'sparkle', s.fx?.color ?? COLOR.green);
      this.game.log(`${t.ref.name} recovers ${healed} HP (${math}${healed < amount ? ' — capped at full' : ''})${cured.length ? ` — ${cured.map(n => n.toLowerCase()).join(', ')} cured` : ''}.`, 'good');
    }
  }

  resolveCure(c, s, x, y, m, impact) {
    const ally = this.heroAt(x, y);
    if (!ally) return;
    const cured = this.cureConditions(ally.ref, s.cures);
    let healed = 0, math = '';
    if (s.dice) {
      const r = this.rollSpellAmount(c, s, m, 'heal');
      healed = Math.min(r.amount, ally.ref.maxHp - ally.ref.hp);
      ally.ref.hp += healed;
      math = r.math;
    }
    this.addFx(x, y, cured.length ? 'cured!' : healed > 0 ? `+${healed}` : 'nothing to cure', cured.length || healed > 0 ? COLOR.green : COLOR.dim, impact);
    this.game.log(cured.length
      ? `${s.name} lifts ${cured.map(n => n.toLowerCase()).join(', ')} from ${ally.ref.name}${healed > 0 ? ` and mends ${healed} HP (${math})` : ''}.`
      : `${ally.ref.name} had nothing for ${s.name} to cure${healed > 0 ? ` — but ${healed} HP mends (${math})` : ''}.`, cured.length ? 'good' : 'info');
  }

  resolveRaise(c, s, x, y, m, impact) {
    const fallen = this.heroes().find(h => !h.ref.alive && h.x === x && h.y === y);
    if (!fallen) return;
    const ref = fallen.ref;
    ref.alive = true;
    ref.hp = Math.max(1, Math.floor(ref.maxHp * (s.hp ?? 0.5)));
    ref.conditions = [];
    audio.play('temple_revive');
    this.addFx(x, y, 'RISEN!', COLOR.gold, impact);
    this.game.log(`${ref.name} rises — ${s.name} calls them back with ${ref.hp} HP.`, 'good');
  }

  // The foes a burst catches (monsters only for afflictions; damage bursts
  // also scorch heroes — handled by the caller), family-filtered.
  foesInBurst(s, x, y, m) {
    let foes;
    if (s.area === 'all') foes = [...this.monsters()];
    else if ((s.area ?? 0) > 0) foes = this.monsters().filter(t => this.dist(t.x, t.y, x, y) <= s.area + m.extraArea);
    else foes = [this.monsterAt(x, y)].filter(Boolean);
    return foes;
  }

  // Family gates (Turn Undead, Exorcism): the rest are simply untouched.
  familyAllowed(s, ref) { return !s.only_family || s.only_family.includes(ref.family); }

  resolveAfflict(c, s, x, y, m, impact) {
    const foes = this.foesInBurst(s, x, y, m);
    if (!foes.length) return;
    const spared = foes.filter(t => !this.familyAllowed(s, t.ref));
    if (spared.length) this.game.log(`${s.name} passes over the ${[...new Set(spared.map(t => t.ref.name))].join(', ')} — not its kind.`, 'info');
    const targets = foes.filter(t => this.familyAllowed(s, t.ref));
    if (!targets.length) return;
    const rounds = s.condition.rounds + m.extraRounds;
    const grown = m.extraRounds ? ` (+${m.extraRounds} round${m.extraRounds > 1 ? 's' : ''} caster level)` : '';
    if (!s.auto) this.game.log(`Save DC ${m.dc} (${m.dcMath})${grown}.`, 'info');
    for (const t of targets) {
      t.aware = true;
      if (s.auto) {
        this.game.applyCondition(t.ref, s.condition.id, rounds, c.uid);
        const cdef = this.game.conditionDef(s.condition.id);
        if (cdef) this.addFx(t.x, t.y, cdef.name + '!', cdef.color, impact);
      } else {
        this.tryInflict(t, s.condition.id, rounds, m.dc, c.uid);
      }
    }
  }

  resolveDamage(c, s, x, y, m, impact) {
    const ch = c.ref;
    // Maelstrom (armed): the blast forgets range and area — every foe.
    const maelstrom = ch.maelstromArmed && !fromScroll(s);
    let targets;
    if (maelstrom) {
      ch.maelstromArmed = false;
      this.markSpent(ch, 'maelstrom');
      this.addFx(c.x, c.y, `${(ch.rite?.abilityName ?? 'MAELSTROM').toUpperCase()}!`, '#8fb8e8');
      this.game.log(`${ch.rite?.abilityName ?? 'Maelstrom'}! ${s.name} tears loose of aim itself — every foe on the field!`, 'good');
      targets = [...this.monsters()];
    } else if (s.area === 'all') {
      targets = [...this.monsters()];
    } else {
      const area = (s.area ?? 0) + (s.area ? m.extraArea : 0);
      targets = [];
      for (const t of [...this.monsters(), ...this.heroes().filter(h => h.ref.alive)]) {
        if (this.dist(t.x, t.y, x, y) <= area && !(area === 0 && t.kind === 'hero')) {
          if (t === c && area === 0) continue;
          targets.push(t);
        }
      }
      // Magic Missile's growth: more darts — the caster's level decides HOW
      // MANY, always. They spread to the nearest other foes in reach, and any
      // dart with no one else to seek strikes the first target again.
      if (area === 0 && m.extraTargets > 0 && targets.length) {
        const more = this.monsters()
          .filter(t => !targets.includes(t) && this.dist(c.x, c.y, t.x, t.y) <= (s.range ?? 0) && this.losClear(c.x, c.y, t.x, t.y))
          .sort((a, b) => this.dist(c.x, c.y, a.x, a.y) - this.dist(c.x, c.y, b.x, b.y))
          .slice(0, m.extraTargets);
        const primary = targets[0];
        const again = m.extraTargets - more.length;
        this.game.log(`${s.name} splits into ${1 + m.extraTargets} darts (caster level)${again > 0 && more.length ? ` — ${again} strike${again > 1 ? '' : 's'} the ${primary.ref.name} again` : again > 0 ? ` — all on the ${primary.ref.name}` : ''}.`, 'info');
        for (const t of more) { this.emitSpellFx(c, s, t.x, t.y); targets.push(t); }
        for (let i = 0; i < again; i++) { this.emitSpellFx(c, s, primary.x, primary.y); targets.push(primary); }
      }
    }
    // Family gates: the rest of the blast is simply untouched.
    const spared = targets.filter(t => t.kind === 'monster' ? !this.familyAllowed(s, t.ref) : !!s.only_family);
    if (spared.length) this.game.log(`${s.name} passes over ${[...new Set(spared.map(t => t.ref.name))].join(', ')} — not its kind.`, 'info');
    targets = targets.filter(t => !spared.includes(t));
    if (!s.auto && s.save && targets.length) this.game.log(`Save DC ${m.dc} (${m.dcMath}).`, 'info');
    let dealt = 0;
    const spellElem = ELEMENTS.includes(s.fx?.sound) ? s.fx.sound : null;
    for (const t of targets) {
      const ref = t.ref;
      if (t.kind === 'monster' && ref.hp <= 0) continue; // an earlier dart already finished it
      let { amount: dmg, math } = this.rollSpellAmount(c, s, m, 'damage');
      let saved = false;
      let saveText = '';
      if (!s.auto && s.save) {
        const bonus = t.kind === 'monster'
          ? (ref.save ?? 0) + this.game.condStat(ref, 'saves')
          : abilityMod(ref.abilities[s.save]) + this.game.heroSaveBonus(ref);
        const die = d20();
        saved = die + bonus >= m.dc;
        saveText = ` · save d20 ${die}${bonus ? ` ${bonus > 0 ? '+' : '−'}${Math.abs(bonus)}` : ''} = ${die + bonus} vs ${m.dc}`;
      }
      if (saved) dmg = Math.floor(dmg / 2);
      // Ancient-weapon logic for spells: the right family takes it doubled.
      if (t.kind === 'monster' && s.double_vs && ref.family === s.double_vs) {
        dmg *= 2;
        math += ` ×2 vs ${ref.family}`;
        this.addFx(t.x, t.y, s.fx?.sound === 'light' ? 'holy fire!' : 'bane!', COLOR.gold, impact);
      }
      // Friendly fire meets elemental protection: a hero caught in the blast
      // is guarded by worn resist/immunity (or a warding spell) for the element.
      if (t.kind === 'hero') {
        const elem = spellElem;
        const kept = this.guardElement(ref, elem, dmg, { min: 0,
          immune: guard => {
            this.addFx(t.x, t.y, 'immune!', COLOR.teal, impact);
            this.game.log(`The blast washes over ${ref.name} — the ${guard.name} drinks the ${elem} whole!`, 'good');
          },
          resist: guard => this.game.log(`${guard.name} turns half the ${elem} aside.`, 'good'),
        });
        if (kept === null) continue;
        dmg = kept;
      }
      if (t.kind === 'monster') t.aware = true; // seared awake, saved or not
      if (saved && dmg <= 0) {
        this.resisted(ref, `${ref.name} shrugs off the ${s.name.toLowerCase()} (${math}${saveText}).`, impact);
        continue;
      }
      this.wound(ref, dmg, saved ? '#d8c06a' : '#ffb04a', impact);
      dealt += dmg;
      if (t.kind === 'monster') this.noteElementHit(t, spellElem); // fire sears a troll's regrowth
      this.game.log(saved
        ? `${ref.name} twists aside — only ${dmg} damage (${math}, halved${saveText}).`
        : `${ref.name} is seared for ${dmg} damage (${math}${saveText})!`);
      if (ref.hp > 0 && s.condition && !saved) {
        this.game.applyCondition(ref, s.condition.id, s.condition.rounds + m.extraRounds, c.uid);
        const cdef = this.game.conditionDef(s.condition.id);
        if (cdef) this.addFx(t.x, t.y, cdef.name + '!', cdef.color, impact);
      }
      if (t.kind === 'monster' && ref.hp <= 0) this.slay(ref);
      if (t.kind === 'hero' && ref.hp <= 0) this.downHero(ref);
    }
    // Vampiric Touch: a share of the harm flows back to the caster.
    if (s.drain && dealt > 0 && ch.alive) {
      const heal = Math.min(Math.floor(dealt * s.drain), ch.maxHp - ch.hp);
      if (heal > 0) {
        ch.hp += heal;
        this.fxOn(ch, `+${heal}`, '#c03050');
        this.game.log(`${s.name} drinks deep — ${heal} HP flows back into ${ch.name}.`, 'good');
      }
    }
  }

  // Buffs (magic v3) ride on ch.timedBuffs so every named part reaches the
  // combat math; rounds null = the whole battle. Recasting refreshes.
  resolveBuff(c, s, x, y, m) {
    const targets = s.targets === 'self' ? [c.ref]
      : s.targets === 'ally' ? [this.heroAt(x, y)?.ref].filter(Boolean)
        : this.game.party.filter(ch => ch.alive);
    if (!targets.length) return;
    const bits = [];
    if (s.hit) bits.push(`${s.hit > 0 ? '+' : ''}${s.hit} hit`);
    if (s.dmg) bits.push(`${s.dmg > 0 ? '+' : ''}${s.dmg} damage`);
    const ac = (s.ac ?? 0) + (m.sc.ac ? m.steps * m.sc.ac : 0);
    if (ac) bits.push(`${ac > 0 ? '+' : ''}${ac} AC${m.sc.ac && m.steps ? ' (caster level)' : ''}`);
    if (s.saves) bits.push(`${s.saves > 0 ? '+' : ''}${s.saves} saves`);
    if (s.attacks) bits.push(`+${s.attacks} attack${s.attacks > 1 ? 's' : ''}`);
    if (s.bonus_damage) bits.push(`+${s.bonus_damage.dice} ${s.bonus_damage.element} on every hit`);
    if (s.resist) bits.push(s.resist === 'all' ? 'every element halved' : `${s.resist.join('/')} halved`);
    if (s.immune_conditions === true) bits.push('no affliction can land');
    else if (Array.isArray(s.immune_conditions)) bits.push(`immune to ${s.immune_conditions.map(id => this.game.conditionDef(id)?.name?.toLowerCase() ?? id).join('/')}`);
    if (s.reveal) bits.push('nothing may hide from the party');
    if (s.reduce) bits.push(`every blow loses ${s.reduce}`);
    if (s.halve) bits.push('every wound halved');
    if (s.reflect) bits.push(`${Math.round(s.reflect * 100)}% of melee wounds thrown back`);
    if (s.lifesteal) bits.push(`${Math.round(s.lifesteal * 100)}% of weapon damage heals you`);
    if (s.auto_hit) bits.push('attacks cannot miss');
    if (s.enchant) bits.push('the weapon strikes as enchanted');
    if (s.hidden) bits.push('unseen');
    const rounds = s.rounds && !s.stance ? s.rounds + m.extraRounds : null;
    let absorbText = '';
    for (const ch of targets) {
      ch.timedBuffs = (ch.timedBuffs ?? []).filter(b => b.name !== s.name);
      const absorb = s.absorb ? Math.max(1, roll(s.absorb)) : 0;
      if (absorb) absorbText = ` — drinks ${absorb} (${s.absorb})`;
      this.addTimedBuff(ch, spellBuff(s, { ac, rounds, absorb }));
      if (s.reveal) this.sweepHidden(); // the light goes up — nothing stays hidden
      // A Hearthstone dwarf's tracked deed: every ally sheltered by a verse.
      if (ch !== c.ref && laneOf(this.game.data, c.ref)?.rite?.tracked === 'alliesFortified') c.ref.counters.alliesFortified++;
      if (s.hidden) { ch.hidden = true; audio.play('vanish'); }
      this.fxOn(ch, s.name, s.fx?.color ?? COLOR.amber);
      const tc = this.combatantOf(ch);
      if (tc) this.particleFx(tc.x, tc.y, s.fx?.kind === 'wisp' ? 'wisp' : 'sparkle', s.fx?.color ?? COLOR.amber);
    }
    const who = s.targets === 'self' ? c.ref.name : s.targets === 'ally' ? targets[0].name : 'the party';
    this.game.log(`${s.name} settles on ${who}: ${bits.join(', ')}${absorbText}${rounds ? ` for ${rounds} round${rounds > 1 ? 's' : ''}${m.extraRounds ? ` (+${m.extraRounds} caster level)` : ''}` : s.stance ? ' — a Stance, held until the next full rest' : ' this battle'}.`, 'good');
  }

  // A buff that needs no aim (self / the whole party): straight to resolution.
  castBuff(c, s) { this.castAt(c, s, c.x, c.y); }

  endHeroTurn() {
    if (this.checkEnd()) return;
    this.nextTurn();
    this.checkEnd();
  }

  // ---- Monster AI (special-abilities pass, 2026-09-01) ----
  // The priority ladder: try the abilities list in order (data-driven,
  // monsters.json "abilities"); if none is usable, walk toward the nearest
  // living hero and swing — possibly more than once ("attacks", haste).
  // Async rule: anything that staggers over time (a traveling bolt, a
  // second swing) sets this.pendingAction and later calls
  // finishMonsterAction() — the nextTurn scheduler waits for it, exactly
  // like the pendingReaction freeze.
  monsterTurn(c) {
    const m = c.ref;
    const ab = this.pickAbility(c);
    if (ab) { this.useAbility(c, ab); return; }
    for (let step = 0; step <= monsterMove(m); step++) {
      const target = this.adjacentHero(c);
      if (target) { this.startSwings(c, target); return; }
      if (step === monsterMove(m)) break;
      if (!this.stepToward(c)) break; // boxed in — or fear leaves no path
    }
    // It neither struck nor reached anyone — if fear pinned it, say so
    // (a Turned mummy visibly cowers instead of silently milling about).
    const dread = this.fearSources(m)[0];
    if (dread) {
      this.fxOn(m, 'cowed', '#c8b8e8');
      this.game.log(`The ${m.name} cowers — it will not go near ${dread.ref.name}.`, 'info');
    }
  }

  // Per-turn upkeep for one monster: regeneration, ability cooldowns, and
  // the rounds left on a haste laid over it.
  tickMonsterState(c) {
    const m = c.ref;
    for (const k of Object.keys(c.cds ?? {})) if (c.cds[k] > 0) c.cds[k]--;
    if (c.haste && --c.haste.rounds <= 0) {
      this.game.log(`${c.haste.name} fades from the ${m.name}.`, 'info');
      c.haste = null;
    }
    // Regeneration (troll): the wound closes at the start of its turn —
    // unless a blocked_by element seared it since its last one.
    if (m.regen && m.hp < hpMax(m)) {
      const seared = (m.regen.blocked_by ?? []).find(e => c.seared?.[e]);
      if (seared) {
        this.addFx(c.x, c.y, 'no regrowth!', '#e0912f');
        this.game.log(`The ${seared} sears the ${m.name}'s wounds shut — no regrowth this round.`, 'good');
      } else {
        const heal = Math.min(m.regen.amount ?? 5, hpMax(m) - m.hp);
        m.hp += heal;
        this.addFx(c.x, c.y, `+${heal} regeneration`, COLOR.green);
        this.game.log(`The ${m.name}'s wounds knit closed — ${heal} HP regenerates.`);
      }
    }
    c.seared = null; // last round's burns are spent either way
  }

  // A hero damage source of a named element marks the monster: regeneration
  // checks the mark at its next turn. strike() and resolveDamage() call this.
  noteElementHit(mc, element) {
    if (!element || !mc || mc.kind !== 'monster' || !mc.ref.regen) return;
    (mc.seared ??= {})[element] = true;
  }

  // ---- The abilities framework (data-driven, monsters.json "abilities") ----
  // First usable entry in list order wins: off cooldown, uses left, a legal
  // target in range and sight, and not redundant (an afflict everyone
  // already bears, a haste already held).
  // The ability list in force right now: a boss in a later phase fights
  // from that phase's list (monsters.json "phases"), everyone else from
  // their own "abilities".
  abilityList(c) {
    const ph = c.ref.phases?.[c.phase ?? -1];
    return ph?.abilities ?? c.ref.abilities ?? [];
  }

  // ---- Boss phases (the Overlord, 2026-09-03) ----
  // monsters.json "phases": [{below: 0.6, name, line, abilities}] — when the
  // monster's HP first drops to or under `below` of its maximum it ENTERS
  // that phase at once (not at its next turn): it speaks its line, its
  // cooldowns clear, and from then on it fights from the phase's own
  // ability list. checkEnd() runs this after every wound.
  checkPhases() {
    for (const c of this.monsters()) {
      const m = c.ref;
      if (!m.phases?.length) continue;
      const frac = m.hp / hpMax(m);
      let idx = -1;
      m.phases.forEach((ph, i) => { if (frac <= ph.below) idx = i; });
      const cur = c.phase ?? -1;
      if (idx <= cur) continue;
      c.phase = idx;
      c.cds = {}; c.uses = {}; // a new phase opens with every power ready (its list is its own — indices restart)
      const ph = m.phases[idx];
      this.fxOn(m, (ph.name ?? 'a new phase').toUpperCase() + '!', COLOR.amber);
      this.game.log(`The ${m.name} enters ${ph.name ?? `phase ${idx + 2}`}${ph.name ? '' : ''}!`, 'death');
      if (ph.line) this.speak(m, ph.line);
    }
  }

  // A monster's spoken line (the Overlord's mockery): a gold italic log
  // entry wearing the speaker's name. Content lives in monsters.json —
  // "intro" on the monster, "line" on any ability or phase.
  speak(m, line) {
    if (!line) return;
    this.game.log(`${m.name}: “${line}”`, 'boss');
  }

  pickAbility(c) {
    const list = this.abilityList(c);
    for (let i = 0; i < list.length; i++) {
      const ab = list[i];
      if ((c.cds?.[i] ?? 0) > 0) continue;
      if (ab.uses !== undefined && (c.uses?.[i] ?? 0) >= ab.uses) continue;
      if (!this.abilityViable(c, ab)) continue;
      return { ...ab, index: i };
    }
    return null;
  }

  // Living heroes this monster can see and reach with a ranged ability.
  heroesInReach(c, range) {
    return this.heroes().filter(h => h.ref.alive && !h.ref.hidden
      && this.dist(h.x, h.y, c.x, c.y) <= range && this.losClear(c.x, c.y, h.x, h.y))
      .sort((a, b) => this.dist(c.x, c.y, a.x, a.y) - this.dist(c.x, c.y, b.x, b.y));
  }

  abilityTarget(c, ab) {
    const pool = this.heroesInReach(c, ab.range ?? 6);
    if (!pool.length) return null;
    // A taunting knight draws the fire too, if he's in reach.
    if (this.tauntActive()) {
      const knight = pool.find(h => h === this.taunt.c);
      if (knight) return knight;
    }
    return pool[0];
  }

  abilityViable(c, ab) { return MONSTER_ABILITIES[ab.type].viable(this, c, ab); }

  useAbility(c, ab) {
    (c.cds ??= {})[ab.index] = (ab.cooldown ?? 0) + 1; // +1: it ticks down at ITS next turn
    if (ab.uses !== undefined) (c.uses ??= {})[ab.index] = (c.uses?.[ab.index] ?? 0) + 1;
    if (ab.line) this.speak(c.ref, ab.line); // the mocking word comes before the deed
    return MONSTER_ABILITIES[ab.type].act(this, c, ab);
  }

  // The ability's save: a hero rolls d20 + ability mod + every named save
  // bonus vs the ability's DC. Returns {saved, text}.
  abilitySave(hc, save, dc) {
    const ref = hc.ref;
    let bonus = abilityMod(ref.abilities[save ?? 'dex']) + this.game.heroSaveBonus(ref);
    if (this.surgeSave?.target === ref) bonus += this.surgeSave.ac;
    const die = d20();
    return {
      saved: die + bonus >= dc,
      text: `save d20 ${die}${bonus ? ` ${bonus > 0 ? '+' : '−'}${Math.abs(bonus)}` : ''} = ${die + bonus} vs DC ${dc}`,
    };
  }

  // Elemental damage from an ability lands on a hero: worn guards, absorb
  // pools and warding buffs all drink first, each by name — the same
  // pipeline a melee blow walks, minus the melee-only pieces.
  abilityHit(m, hc, dmg, element, bits) {
    const target = hc.ref;
    dmg = this.guardElement(target, element, dmg, {
      immune: guard => {
        this.fxOn(target, 'immune!', COLOR.teal);
        this.game.log(`The blast washes over ${target.name} — the ${guard.name} drinks the ${element} whole!`, 'good');
      },
      resist: guard => bits.push(`${guard.name} turns half the ${element} aside`),
    });
    if (dmg === null) return;
    dmg = this.soakDamage(target, dmg, bits, {
      betweenPools: d => this.braceSoak(target, d, bits, 'spell'),
    });
    if (dmg <= 0) {
      this.fxOn(target, 'blocked', COLOR.dim);
      this.game.log(`${target.name} — the ward takes it all (${bits.join(' · ')}).`, 'good');
      return;
    }
    this.wound(target, dmg);
    this.game.log(`${target.name} takes ${dmg} damage (${bits.join(' · ')})!`);
    if (target.hp <= 0) this.downHero(target); // spellfire, not a blow — Unyielding sleeps
  }

  // bolt: one hero. breath: every hero within `area` of the chosen one —
  // clumping is punished exactly like friendly-fire bursts, visibly.
  monsterBlast(c, ab) {
    const m = c.ref;
    const primary = this.abilityTarget(c, ab);
    if (!primary) return;
    const targets = ab.type === 'breath'
      ? this.heroes().filter(h => h.ref.alive && this.dist(h.x, h.y, primary.x, primary.y) <= (ab.area ?? 1))
      : [primary];
    const fxSpell = { area: ab.type === 'breath' ? (ab.area ?? 1) : 0, fx: ab.fx, type: 'damage' };
    const impact = this.emitSpellFx(c, fxSpell, primary.x, primary.y);
    if (ab.fx?.sound) audio.play(`spell_${ab.fx.sound}`);
    this.game.log(`The ${m.name} unleashes ${ab.name ?? 'a blast'}${targets.length > 1 ? ` — ${targets.length} heroes are caught!` : ` at ${primary.ref.name}!`}`, 'combat');
    this.staggerTargets(targets, { lead: impact, step: TIMING.stagger,
      each: hc => {
          const raw = Math.max(1, roll(ab.dice));
          const { saved, text } = ab.save ? this.abilitySave(hc, ab.save, ab.dc ?? 13) : { saved: false, text: '' };
          const dmg = saved ? Math.floor(raw / 2) : raw;
          const bits = [`${ab.name ?? 'blast'} ${ab.dice} → ${raw}${this.saveBits(saved, text)}`];
          if (saved && dmg <= 0) {
            this.resisted(hc.ref, `${hc.ref.name} twists clear of the ${(ab.name ?? 'blast').toLowerCase()} (${text}).`);
          } else {
            this.abilityHit(m, hc, dmg, ab.element, bits);
          }
      },
    });
  }

  // afflict: a condition thrown at range — one hero, or the whole PARTY
  // (targets: "party"), each saving alone as the wave rolls over the line.
  monsterAfflict(c, ab) {
    const m = c.ref;
    const party = ab.targets === 'party';
    let targets;
    if (party) targets = this.heroes().filter(h => h.ref.alive);
    else {
      const primary = this.abilityTarget(c, ab);
      if (!primary) return;
      targets = (ab.area ?? 0) > 0
        ? this.heroes().filter(h => h.ref.alive && this.dist(h.x, h.y, primary.x, primary.y) <= ab.area)
        : [primary];
    }
    const cdef = this.game.conditionDef(ab.condition);
    const impact = party ? 0 : this.emitSpellFx(c, { fx: ab.fx ?? { kind: 'wisp', color: cdef?.color ?? COLOR.shadow }, type: 'afflict' }, targets[0].x, targets[0].y);
    if (ab.fx?.sound) audio.play(`spell_${ab.fx.sound}`);
    this.game.log(`The ${m.name} ${party ? `casts ${ab.name ?? 'a curse'} over the whole party` : `aims ${ab.name ?? 'a curse'} at ${targets[0].ref.name}`}! Save DC ${ab.dc ?? 13}.`, 'combat');
    this.staggerTargets(targets, { lead: impact, step: TIMING.staggerSlow,
      each: hc => {
        this.particleFx(hc.x, hc.y, ab.fx?.kind === 'sparkle' ? 'sparkle' : 'wisp', ab.fx?.color ?? cdef?.color ?? COLOR.shadow);
        this.tryInflict(hc, ab.condition, ab.rounds ?? 2, ab.dc ?? 13, c.uid);
      },
    });
  }

  // haste: the pack-leader's gift (or its own frenzy) — extra swings for
  // `rounds` of the target's turns, named in every attack line.
  // 'vanish' (2026-09-03): the player's own trick, turned around. The
  // monster spends its turn to disappear; it cannot be aimed at, and its
  // next blow lands as though nobody saw it coming — until it strikes,
  // which gives it away exactly as it does for a Thief.
  // ---- summon (the Overlord, 2026-09-03) ----
  // {type:'summon', name, monsters:[{id, count}], max_allies?, unbound?, line?}
  // Real monsters.json creatures step out of nothing beside the caster and
  // join the fight at the END of the initiative order. They are conjured,
  // not native: they are not on the map (fleeing leaves nothing behind),
  // they award NO XP (a caster with a cooldown must not be an XP farm —
  // the road to 20 stays long), and when the summoner dies the binding
  // breaks and they dissolve — unless the ability says `unbound: true`.
  monsterSummon(c, ab) {
    const m = c.ref;
    const made = [];
    let nextUid = Math.max(...this.combatants.map(x => x.uid)) + 1;
    for (const entry of ab.monsters ?? []) {
      const def = this.game.data.monsters.monsters[entry.id];
      if (!def) continue;
      const n = typeof entry.count === 'number' ? entry.count : Math.max(1, roll(entry.count ?? '1'));
      for (let i = 0; i < n; i++) {
        const spot = this.nearestOpen(c.x, c.y);
        if (!this.open(spot.x, spot.y)) break; // the field is full
        const ref = { ...def, id: entry.id, x: -1, y: -1, maxHp: def.hp, conditions: [],
          summoned: ab.unbound ? null : c.uid, xp: 0 };
        const cc = { kind: 'monster', ref, x: spot.x, y: spot.y, aware: true, unseen: !!def.hidden,
          alivePos: () => ref.hp > 0, uid: nextUid++, init: -99 };
        this.combatants.push(cc);
        made.push(cc);
      }
    }
    if (!made.length) {
      this.game.log(`The ${m.name} gestures — but there is no room on the field for anything to answer.`, 'info');
      this.finishMonsterAction();
      return;
    }
    audio.play('summon');
    this.particleFx(c.x, c.y, ab.fx?.kind ?? 'wisp', ab.fx?.color ?? COLOR.violet);
    this.addFx(c.x, c.y, (ab.name ?? 'SUMMON').toUpperCase() + '!', ab.fx?.color ?? COLOR.violet);
    this.staggerTargets(made, { lead: TIMING.staggerTail, step: TIMING.staggerSlow,
      each: cc => {
        this.particleFx(cc.x, cc.y, 'wisp', ab.fx?.color ?? COLOR.violet);
        this.addFx(cc.x, cc.y, cc.ref.name + '!', ab.fx?.color ?? COLOR.violet);
      },
    });
    const tally = {};
    for (const cc of made) tally[cc.ref.name] = (tally[cc.ref.name] ?? 0) + 1;
    const list = Object.entries(tally).map(([n, k]) => (k > 1 ? `${k} ${n}s` : `a ${n}`)).join(', ');
    this.game.log(`The ${m.name} ${ab.name ? `works ${ab.name} — ` : 'gestures, and '}${list} tear${made.length > 1 ? '' : 's'} into being beside it! (Conjured: no XP, and ${ab.unbound ? 'they stay when it falls' : 'they dissolve when their master falls'}.)`, 'death');
    this.sweepHidden();
  }

  // Summons bound to a fallen master dissolve. Called from slay().
  breakBindings(masterC) {
    const bound = this.monsters().filter(mc => mc.ref.summoned === masterC.uid);
    if (!bound.length) return;
    for (const mc of bound) {
      mc.ref.hp = 0;
      mc.diedAt = performance.now();
      this.addFx(mc.x, mc.y, 'unmade!', COLOR.violet);
    }
    this.game.log(`The binding breaks — ${bound.map(mc => mc.ref.name).join(', ')} unravel${bound.length > 1 ? '' : 's'} into nothing without ${masterC.ref.name}'s will to hold them.`, 'good');
  }

  // The open square farthest from the nearest living hero (a blink's
  // destination); null if nothing beats where the monster stands.
  farthestOpen(c) {
    const heroes = this.heroes().filter(h => h.ref.alive && !h.ref.hidden);
    const gap = (x, y) => Math.min(...heroes.map(h => this.dist(h.x, h.y, x, y)));
    let best = null, bestGap = gap(c.x, c.y);
    for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
      if (!this.open(x, y)) continue;
      const g = gap(x, y);
      if (g > bestGap || (g === bestGap && best && Math.random() < 0.5)) { best = { x, y }; bestGap = g; }
    }
    return best;
  }

  // ---- blink (the Overlord) ----
  // {type:'blink', name, when_within?, line?} — the caster vanishes from
  // under the party's blades and reappears across the field. It costs
  // the turn; a melee party spends its next one walking.
  monsterBlink(c, ab) {
    const to = this.farthestOpen(c);
    if (!to) { this.finishMonsterAction(); return; }
    const from = { x: c.x, y: c.y };
    audio.play('vanish');
    this.particleFx(from.x, from.y, ab.fx?.kind ?? 'wisp', ab.fx?.color ?? COLOR.violet);
    this.addFx(from.x, from.y, (ab.name ?? 'BLINK').toUpperCase() + '!', ab.fx?.color ?? COLOR.violet);
    c.x = to.x; c.y = to.y;
    this.pendingAction = true;
    setTimeout(() => {
      if (this.game.battle !== this) return;
      this.particleFx(to.x, to.y, 'sparkle', ab.fx?.color ?? COLOR.violet);
      this.game.log(`The ${c.ref.name} ${ab.name ? `works ${ab.name} and ` : ''}is elsewhere — it reappears ${this.dist(from.x, from.y, to.x, to.y)} squares away, out of reach.`, 'death');
      this.finishMonsterAction();
    }, TIMING.blink);
  }

  monsterVanish(c, ab) {
    c.unseen = true;
    audio.play('vanish');
    this.particleFx(c.x, c.y, ab.fx?.kind ?? 'wisp', ab.fx?.color ?? COLOR.shadow);
    this.addFx(c.x, c.y, (ab.name ?? 'VANISH').toUpperCase(), COLOR.shadow);
    this.game.log(`The ${c.ref.name} ${ab.name ? `works ${ab.name} and ` : ''}is simply gone — the party's eyes slide off the empty air.`, 'death');
    this.finishMonsterAction();
  }

  monsterHaste(c, ab) {
    const m = c.ref;
    const name = ab.name ?? 'Frenzy';
    const targets = ab.targets === 'self' ? [c]
      : this.monsters().filter(mc => mc !== c && mc.ref.hp > 0 && !mc.haste);
    if (!targets.length) return;
    for (const t of targets) {
      t.haste = { attacks: ab.extra_attacks ?? 1, rounds: (ab.rounds ?? 2) + 1, name };
      this.particleFx(t.x, t.y, 'sparkle', ab.fx?.color ?? COLOR.red);
      this.addFx(t.x, t.y, name + '!', ab.fx?.color ?? COLOR.red);
    }
    audio.play('spell_buff');
    this.game.log(ab.targets === 'self'
      ? `The ${m.name} whips itself into ${name} — +${ab.extra_attacks ?? 1} attack for ${ab.rounds ?? 2} rounds!`
      : `The ${m.name} calls ${name} over its pack — +${ab.extra_attacks ?? 1} attack each for ${ab.rounds ?? 2} rounds! Cut the leader down!`, 'death');
  }

  // type "spell" (the lich): a REAL page from spells.json, cast monster-side
  // at a fixed caster_level. Damage and afflict spells only (validated).
  monsterCastSpell(c, ab) {
    const m = c.ref;
    const s = { id: ab.id, ...this.game.data.spells.spells[ab.id] };
    const lvl = ab.caster_level ?? 15;
    const castMod = ab.cast_mod ?? Math.floor(lvl / 4);
    const dc = 10 + s.level + castMod;
    const steps = scaleSteps(s, lvl);
    const primary = s.area === 'all' ? null : this.abilityTarget(c, { range: s.range ?? 6 });
    if (!primary && s.area !== 'all') return;
    const aim = primary ?? this.heroes().find(h => h.ref.alive);
    const impact = this.emitSpellFx(c, s, aim.x, aim.y);
    if (s.fx?.sound) audio.play(`spell_${s.fx.sound}`);
    this.game.log(`The ${m.name} casts ${s.name}!`, 'death');
    const targets = s.area === 'all' ? this.heroes().filter(h => h.ref.alive)
      : (typeof s.area === 'number' && s.area > 0)
        ? this.heroes().filter(h => h.ref.alive && this.dist(h.x, h.y, primary.x, primary.y) <= s.area)
        : [primary];
    let dealt = 0;
    this.staggerTargets(targets, { lead: impact, step: TIMING.stagger,
      each: hc => {
          if (s.type === 'afflict') {
            this.particleFx(hc.x, hc.y, 'wisp', s.fx?.color ?? COLOR.shadow);
            this.tryInflict(hc, s.condition.id, s.condition.rounds + (s.scale?.rounds ? steps * s.scale.rounds : 0), dc, c.uid);
            return;
          }
          // damage: dice + caster-level growth, save for half, guards by name.
          let raw = Math.max(1, roll(s.dice));
          let math = `${s.dice} → ${raw}`;
          if (steps > 0 && s.scale?.dice) {
            let grown = 0;
            for (let k = 0; k < steps; k++) grown += roll(s.scale.dice);
            raw += grown; math += ` +${steps > 1 ? `${steps}×` : ''}${s.scale.dice} → ${grown} caster level`;
          }
          if (steps > 0 && s.scale?.flat) { raw += steps * s.scale.flat; math += ` +${steps * s.scale.flat} caster level`; }
          const { saved, text } = s.auto ? { saved: false, text: '' } : this.abilitySave(hc, s.save ?? 'dex', dc);
          const dmg = saved ? Math.floor(raw / 2) : raw;
          if (saved && dmg <= 0) {
            this.resisted(hc.ref, `${hc.ref.name} shrugs off the ${s.name.toLowerCase()} (${text}).`);
            return;
          }
          const elem = ELEMENTS.includes(s.fx?.sound) ? s.fx.sound : null;
          const bits = [`${s.name} ${math}${this.saveBits(saved, text)}`];
          const before = hc.ref.hp;
          this.abilityHit(m, hc, dmg, elem, bits);
          dealt += Math.max(0, before - hc.ref.hp);
          if (hc.ref.alive && hc.ref.hp > 0 && s.condition && !saved) {
            this.game.applyCondition(hc.ref, s.condition.id, s.condition.rounds, c.uid);
            const cdef = this.game.conditionDef(s.condition.id);
            if (cdef) this.addFx(hc.x, hc.y, cdef.name + '!', cdef.color);
          }
      },
      then: () => {
        // Vampiric Touch in undead hands drinks just the same.
        if (s.drain && dealt > 0 && m.hp > 0) {
          const heal = Math.min(Math.floor(dealt * s.drain), hpMax(m) - m.hp);
          if (heal > 0) { m.hp += heal; this.fxOn(m, `+${heal}`, '#c03050'); this.game.log(`${s.name} drinks deep — ${heal} HP flows back into the ${m.name}.`, 'death'); }
        }
      },
    });
  }

  // ---- Multi-attack ("attacks": N, plus a haste's extras) ----
  // Swings resolve one at a time, ~300ms apart so the player SEES each
  // blow; a reaction (Ward Surge, the Stand) freezes the chain and
  // resumeAfterBlow picks it back up. Each swing re-finds a living
  // adjacent target — the first may have fallen or been saved elsewhere.
  monsterSwings(c) { return (c.ref.attacks ?? 1) + (c.haste?.attacks ?? 0); }

  startSwings(c, targetC) {
    this.swingChain = { c, remaining: this.monsterSwings(c), swung: 0 };
    this.doSwing(targetC);
  }

  doSwing(targetC) {
    const chain = this.swingChain;
    if (!chain) return; // a stale timer from a chain that already ended (seen 2026-09-03: two overlapping chains crashed the bot)
    // Striking gives you away — the same rule the player's hiding lives by.
    this.revealMonster(chain.c, `The ${chain.c.ref.name} breaks cover as it strikes!`);
    chain.remaining--;
    chain.swung++;
    if (chain.swung > 1) {
      const h = chain.c.haste;
      const extraName = h && chain.swung > (chain.c.ref.attacks ?? 1) ? ` — ${h.name}` : '';
      this.game.log(`The ${chain.c.ref.name} strikes again (attack ${chain.swung}${extraName})!`, 'combat');
    }
    this.monsterAttack(chain.c.ref, targetC.ref);
    if (this.pendingReaction) { this.pendingAction = true; return; } // resolveReaction resumes the chain
    this.afterSwing();
  }

  afterSwing() {
    const chain = this.swingChain;
    if (!chain || chain.remaining <= 0 || chain.c.ref.hp <= 0) {
      // Done. If we ever went async (a stagger or a reaction), WE own the
      // hand-back; a fully synchronous single swing leaves it to the
      // nextTurn scheduler that called monsterTurn — never both.
      this.swingChain = null;
      if (this.pendingAction) this.finishMonsterAction();
      return;
    }
    this.pendingAction = true;
    setTimeout(() => {
      if (this.game.battle !== this || this.swingChain !== chain) return; // battle over, or another chain replaced this one
      const next = this.adjacentHero(chain.c);
      if (!next || chain.c.ref.hp <= 0) { this.swingChain = null; this.finishMonsterAction(); return; }
      this.doSwing(next);
    }, TIMING.swing);
  }

  // An async monster action (staggered swings, a traveled bolt) is done:
  // release the lock and hand the round back to the scheduler.
  finishMonsterAction() {
    this.pendingAction = false;
    if (this.pendingReaction) return;
    if (this.checkEnd()) return;
    this.nextTurn();
  }

  // A blow just fully resolved (possibly through a reaction): continue the
  // swing chain if one is mid-flight, else hand back to the scheduler.
  resumeAfterBlow() {
    if (this.pendingReaction) return;
    if (this.swingChain) { this.afterSwing(); return; }
    this.pendingAction = false;
    if (this.checkEnd()) return;
    this.nextTurn();
  }

  // Bulwark's taunt: while it holds, monsters strike the knight if they can.
  tauntActive() {
    return this.taunt && this.round <= this.taunt.until && this.taunt.c.ref.alive;
  }

  adjacentHero(c) {
    // A hidden hero simply isn't there, as far as any monster knows.
    const near = this.heroes().filter(h => h.ref.alive && !h.ref.hidden && this.adjacent(h, c));
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
        if (this.fearBlock(c.ref, x, y, nx, ny)) continue; // cowed — no path leads toward the terror
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

  // A snare's rider is resisted by the thief's own craft, not caster level:
  // 10 + a tenth of their skill, so an 80% rogue sets DC 18.
  snareDC(ref) { return 10 + Math.round(this.game.heroSkill(ref) / 10); }

  // The rogue's handiwork: a monster finds a snare by stepping on it — or,
  // once Deadly Webs is walked, merely by stepping BESIDE it.
  checkBattleTrap(c) {
    const webs = this.battleTraps.find(t => {
      if (t.x === c.x && t.y === c.y) return true;
      const cap = hasCapstone(this.game.data, t.owner, 'deadly_webs') ? laneOf(this.game.data, t.owner).capstone : null;
      return cap?.adjacent && this.adjacent(t, c);
    });
    if (!webs) return;
    this.battleTraps = this.battleTraps.filter(t => t !== webs);
    const dmg = Math.max(1, roll(webs.dice));
    c.ref.hp -= dmg;
    this.wake(c.ref);
    c.aware = true;
    this.revealMonster(c, `The ${c.ref.name} blunders into a snare and gives itself away!`);
    audio.play('trap_springs');
    this.addFx(c.x, c.y, `${(webs.name ?? 'TRAP').toUpperCase()}! -${dmg}`, '#e0912f');
    const near = webs.x === c.x && webs.y === c.y ? 'steps on' : 'brushes';
    this.game.log(`The ${c.ref.name} ${near} ${webs.owner.name}'s ${(webs.name ?? 'snare').toLowerCase()} — ${dmg} damage!`, 'good');
    if (c.ref.hp > 0 && webs.rider) {
      this.tryInflict(c, webs.rider.condition, webs.rider.rounds, webs.dc ?? 13,
        this.combatantOf(webs.owner)?.uid);
    }
    if (c.ref.hp <= 0) this.slay(c.ref);
  }

  // A hero's AC in the moment: sheet AC, timed buffs (Rage's recklessness),
  // and Bulwark — a knight standing beside you turns blades aside.
  heroAcOf(hc, m = null) {
    let ac = hc.ref.ac + this.game.condStat(hc.ref, 'ac'); // timed buffs arrive by name via acExtras
    // Incorporeal touch (shadow, spectre): worn armor and shield mean
    // nothing — the blow reaches through steel. DEX, buffs, rings remain.
    if (m?.touch) ac -= this.gearAcOf(hc.ref);
    for (const other of this.heroes()) {
      if (other === hc || !other.ref.alive) continue;
      const lane = laneOf(this.game.data, other.ref);
      if (lane?.capstone?.id === 'bulwark' && other.ref.level >= lane.capstone.level
        && this.adjacent(other, hc)) {
        ac += lane.capstone.aura_ac ?? 1;
      }
    }
    for (const [v] of this.acExtras(hc.ref, m)) ac += v;
    return ac;
  }

  // The AC a hero owes purely to worn armor and shield — the share an
  // incorporeal touch attack ignores.
  gearAcOf(ref) {
    if (!ref.equipment) return 0;
    return Object.values(ref.equipment).filter(Boolean).map(id => this.game.itemDef(id))
      .filter(d => d.type?.startsWith('armor_') || d.type === 'shield')
      .reduce((s, d) => s + (d.ac || 0), 0);
  }

  // Named AC parts that depend on WHO is swinging: Ironward (the Stoneshaper's
  // creation gift, vs one element) and a Ward Surge sung over this blow.
  acExtras(ref, m) {
    const parts = [];
    for (const b of ref.timedBuffs ?? []) if (b.ac) parts.push([b.ac, b.name]); // Aegis of Dawn, Rage's recklessness…
    const gift = ref.cls.creation_pick?.options.find(o => o.id === ref.gift?.id);
    if (gift?.ac_vs_element && m?.element && m.element === ref.gift.element) parts.push([gift.ac_vs_element, `${gift.name} vs ${m.element}`]);
    if (this.wardBonus && this.wardBonus.target === ref) parts.push([this.wardBonus.ac, this.wardBonus.name]);
    return parts;
  }

  // Ward Surge (Wardsong verb): who could sing a ward over this blow, and
  // what it costs them. The target first; at 18, a singer standing beside.
  wardSurgeOffer(target) {
    const tc = this.combatantOf(target);
    if (!tc) return null;
    const candidates = [tc, ...this.heroes().filter(h => h !== tc && this.adjacent(h, tc))];
    for (const hc of candidates) {
      const s = hc.ref;
      if (!s.alive || !hasVerb(this.game.data, s, 'ward_surge')) continue;
      if (hc !== tc && !hasRefinement(this.game.data, s, 'ward_surge_allies')) continue;
      const v = laneOf(this.game.data, s).verb;
      const cost = s.chordArmed ? 0 : (v.cost ?? 2);
      if (!this.game.arena && s.sp < cost) continue;
      return { singer: s, cost, ac: v.ac ?? 4, name: v.name ?? 'Ward Surge' };
    }
    return null;
  }

  // A living shield-brother who could take this blow instead (level-10 verb).
  standCandidate(target) {
    return this.heroes().map(h => h.ref).find(ref =>
      ref.alive && ref !== target && hasVerb(this.game.data, ref, 'guardians_stand'));
  }

  monsterAttack(m, target) {
    const tc = this.combatantOf(target);
    // Ward Surge: BEFORE the die is cast, a Wardsong singer may buy a ward
    // over this one blow — the world waits on a Y/N (like the Stand).
    if (tc?.kind === 'hero' && !this.fleeing && !this.surgeDone) {
      const offer = this.wardSurgeOffer(target);
      if (offer) {
        const baseAc = this.heroAcOf(tc, m);
        this.pendingReaction = { kind: 'ward', m, target, ...offer, baseAc, toHit: m.to_hit + this.game.condStat(m, 'hit') };
        this.mode = 'reaction';
        return;
      }
    }
    this.surgeDone = false;
    const extras = tc?.kind === 'hero' ? this.acExtras(target, m) : [];
    const ac = tc?.kind === 'hero' ? this.heroAcOf(tc, m) : target.ac;
    const surge = this.wardBonus?.target === target ? this.wardBonus : null;
    this.wardBonus = null; // spent on this blow, hit or miss
    if (surge) this.surgeSave = { target, ac: surge.ac }; // the ward guards the save too
    const die = d20();
    const hitCond = this.game.condStat(m, 'hit'), dmgCond = this.game.condStat(m, 'dmg');
    const condName = hitCond || dmgCond ? this.game.condParts(m, hitCond ? 'hit' : 'dmg').map(([, n]) => n).join(' & ') : '';
    const toHit = m.to_hit + hitCond;
    const touch = tc?.kind === 'hero' && m.touch ? this.gearAcOf(target) : 0;
    const hitText = `d20 ${die} +${m.to_hit}${hitCond ? ` ${hitCond > 0 ? '+' : '−'}${Math.abs(hitCond)} ${condName}` : ''} = ${die + toHit} vs AC ${ac}${touch ? ' (touch — armor avails nothing)' : ''}${extras.length ? ` (${this.fmtParts(extras).trim()})` : ''}`;
    if (surge && die + toHit < ac && die + toHit >= ac - surge.ac) {
      // The ward alone turned it — the singer's tracked deed.
      surge.singer.counters.wardDeflects++;
      this.fxOn(target, `${surge.name} turns it!`, '#9fc8ff');
    }
    if (die + toHit >= ac) {
      const dmg = Math.max(1, roll(m.damage) + dmgCond);
      this.lastMonsterRoll = `${hitText}${dmgCond ? ` · ${dmgCond > 0 ? '+' : '−'}${Math.abs(dmgCond)} damage ${condName}` : ''}`;
      // Aegis (the Rite): the raised guard takes the blow at half force —
      // no question asked, that's what the round was bought for.
      const aegisC = tc?.kind === 'hero' && !this.fleeing ? this.aegisGuard(target) : null;
      if (aegisC) {
        this.fxOn(target, 'shielded!', COLOR.teal);
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
      this.fxOn(target, 'miss', COLOR.dim);
      this.game.log(`The ${m.name} lunges at ${target.name} but misses (${hitText}).`);
    }
  }

  applyMonsterHit(m, target, dmg) {
    // Typed attacks (tier abilities): a red dragon's blow is FIRE — worn
    // immunity drinks it whole, resistance halves it, each by name.
    dmg = this.guardElement(target, m.element, dmg, {
      immune: guard => {
        this.lastMonsterRoll = null;
        this.fxOn(target, 'immune!', COLOR.teal);
        this.game.log(`The ${m.name} strikes ${target.name} — the ${guard.name} drinks the ${m.element} whole!`, 'good');
      },
      resist: guard => this.game.log(`The ${guard.name} turns half the ${m.element} aside.`, 'good'),
    });
    if (dmg === null) return;
    const soak = [];
    // Braced Stance and Granite Skin blunt BLOWS; growth picks may widen the
    // stance to spellfire and to the ally beside you (handled in braceSoak).
    const p = passiveOf(this.game.data, target);
    dmg = this.soakDamage(target, dmg, soak, {
      betweenPools: d => {
        d = this.braceSoak(target, d, soak, 'melee');
        const granite = p?.id === 'granite_skin' && !m.element ? (p.reduce ?? 1) : 0;
        if (granite) { d = Math.max(0, d - granite); soak.push(`${passiveName(p, 'Granite Skin')} turns ${granite} aside`); }
        return d;
      },
    });
    const bits = [this.lastMonsterRoll, ...soak].filter(Boolean);
    const rollText = bits.join(' · ');
    this.lastMonsterRoll = null; // redirected blows (Aegis, the Stand) skip the roll text next time
    audio.play('melee_hit');
    if (dmg <= 0) {
      this.fxOn(target, 'blocked', COLOR.dim);
      this.game.log(`The ${m.name} strikes ${target.name} — the guard takes it all${rollText ? ` (${rollText})` : ''}.`);
      this.riposte(m, target);
      return;
    }
    this.wound(target, dmg);
    this.game.log(`The ${m.name} strikes ${target.name} for ${dmg} damage${rollText ? ` (${rollText})` : ''}!`);
    // An elemental rider on the blow (elementals: "bonus_damage" on the
    // monster) — its own die, its own guard check, its own float.
    if (m.bonus_damage && target.alive && target.hp > 0) {
      const bd = m.bonus_damage;
      let guardText = '';
      const extra = this.guardElement(target, bd.element, Math.max(1, roll(bd.dice)), {
        immune: guard => this.game.log(`The ${bd.element} crackles over ${target.name} — the ${guard.name} drinks it whole.`, 'good'),
        resist: guard => { guardText = ` (${guard.name} turns half aside)`; },
      });
      if (extra !== null) {
        target.hp -= extra;
        this.fxOn(target, `-${extra} ${bd.element}`, '#e0912f');
        this.game.log(`${bd.element} sears ${target.name} for ${extra} more (${bd.dice} ${bd.element} — the ${m.name}'s touch)${guardText}!`);
        if (target.hp <= 0) { this.downHero(target, { attack: true }); this.riposte(m, target); return; }
      }
    }
    // Splash (the efreet's burning presence): heroes beside the struck one
    // catch the element too, each with their own float and guard.
    if (m.splash && target.alive) {
      const tcS = this.combatantOf(target);
      const near = tcS ? this.heroes().filter(h => h.ref.alive && h.ref !== target
        && this.adjacent(h, tcS)) : [];
      for (const h of near) {
        let halved = null;
        const sp = this.guardElement(h.ref, m.splash.element, Math.max(1, roll(m.splash.dice)), {
          immune: guard => this.game.log(`The ${m.splash.element} washes over ${h.ref.name} — the ${guard.name} drinks it whole.`, 'good'),
          resist: guard => { halved = guard; },
        });
        if (sp === null) continue;
        h.ref.hp -= sp;
        this.particleFx(h.x, h.y, 'wisp', '#ff8c3a');
        this.fxOn(h.ref, `-${sp} splash`, '#e0912f');
        this.game.log(`${m.splash.element} splashes onto ${h.ref.name} for ${sp} (${m.splash.dice} — beside the ${m.name})${halved ? ` — ${halved.name} halves it` : ''}!`);
        if (h.ref.hp <= 0) this.downHero(h.ref, { attack: true });
      }
    }
    // Mirror Ward / Bastion Veil: a share of the wound flies back at its source.
    const mirror = (target.timedBuffs ?? []).filter(b => b.reflect > 0).sort((a, b) => b.reflect - a.reflect)[0];
    if (mirror && m.hp > 0) {
      const back = Math.max(1, Math.floor(dmg * mirror.reflect));
      m.hp -= back;
      this.wake(m);
      this.fxOn(m, `-${back} reflected`, '#9fc8ff');
      this.game.log(`${mirror.name} throws ${back} of it back at the ${m.name}!`, 'good');
      if (laneOf(this.game.data, target)?.rite?.tracked === 'wardDeflects') target.counters.wardDeflects++;
      if (m.hp <= 0) this.slay(m);
    }
    if (target.hp <= 0) {
      this.downHero(target, { attack: true });
    } else {
      const tc = this.combatantOf(target);
      if (tc && m.inflicts) this.tryInflict(tc, m.inflicts.condition, m.inflicts.rounds, m.inflicts.dc, this.combatantOf(m)?.uid);
      if (tc && m.drains) this.monsterDrain(m, tc, dmg);
    }
    this.riposte(m, target);
  }

  // Warding buffs drink an incoming wound, by name: absorb pools first,
  // then (for melee, via betweenPools) the blow-only passives, then flat
  // reduction, halving, and Bedrock. Shared by melee and abilities.
  // Braced Stance and its growth. `source` is 'melee' (a blow) or 'spell'
  // (a monster ability, breath or spell). The base stance only blunts blows
  // and wants a shield; Spellguard and Ingrained Guard lift those limits,
  // Deeper Stance adds to it, and Shieldwall lends it to the hero beside you.
  braceSoak(target, dmg, bits, source) {
    if (dmg <= 0) return dmg;
    const D = this.game.data;
    const bracer = (ref) => {
      const p = passiveOf(D, ref);
      if (p?.id !== 'braced_stance') return 0;
      if (!this.game.hasShield(ref) && !growthEffect(D, ref, 'brace_no_shield')) return 0;
      if (source !== 'melee' && !growthNamed(D, ref, 'brace_vs', source)) return 0;
      return (p.reduce ?? 1) + growthEffect(D, ref, 'brace_bonus');
    };
    let cut = bracer(target);
    let name = null;
    if (cut) name = source === 'melee' ? 'shield' : growthNamed(D, target, 'brace_vs', source).name;
    if (!cut) {
      // Shieldwall: a braced ally standing next to you shares the guard.
      const tc = this.combatantOf(target);
      for (const other of this.heroes()) {
        if (!tc || other.ref === target || !other.ref.alive) continue;
        if (!this.adjacent(other, tc)) continue;
        const wall = growthNamed(D, other.ref, 'brace_allies', true) ?? (growthEffect(D, other.ref, 'brace_allies') ? growthPicks(D, other.ref).find(o => o.brace_allies) : null);
        if (!wall) continue;
        const share = bracer(other.ref);
        if (share) { cut = share; name = `${other.ref.name}'s ${wall.name}`; break; }
      }
    }
    if (!cut) return dmg;
    const was = dmg;
    dmg = Math.max(0, dmg - cut);
    if (was !== dmg) bits.push(`${name} turns ${was - dmg} aside`);
    return dmg;
  }

  soakDamage(target, dmg, bits, opts = {}) {
    for (const b of target.timedBuffs ?? []) {
      if (!(b.absorb > 0) || dmg <= 0) continue;
      const sip = Math.min(b.absorb, dmg);
      b.absorb -= sip; dmg -= sip;
      bits.push(`${b.name} drinks ${sip}${b.absorb <= 0 ? ' and is spent' : ''}`);
    }
    if (opts.betweenPools) dmg = opts.betweenPools(dmg);
    for (const b of target.timedBuffs ?? []) {
      if (b.reduce > 0 && dmg > 0) { const cut = Math.min(b.reduce, dmg); dmg -= cut; bits.push(`${b.name} turns ${cut} aside`); }
    }
    const halver = (target.timedBuffs ?? []).find(b => b.halve);
    if (halver && dmg > 1) { const was = dmg; dmg = Math.ceil(dmg / 2); bits.push(`${halver.name} halves ${was} → ${dmg}`); }
    if (target.bedrock && dmg > 1) { bits.push(`${target.rite?.abilityName ?? 'Bedrock'}: ${dmg} → 1`); dmg = 1; }
    return Math.max(0, dmg);
  }

  // Life drain (wight, spectre, vampire — the designer's max-HP ruling):
  // a failed CON save shrinks the hero's MAXIMUM HP until a full rest or
  // the temple restores it. "level" drains what a level gave (the class
  // hit die + CON, rolled); "damage" drains what the blow just dealt;
  // dice roll themselves. heals: true — the monster drinks what it takes.
  monsterDrain(m, tc, dealt) {
    const target = tc.ref;
    const d = m.drains;
    const { saved, text } = this.abilitySave(tc, 'con', d.dc ?? 14);
    if (saved) {
      this.fxOn(target, 'resisted', COLOR.dim);
      this.game.log(`${target.name}'s life holds fast against the ${m.name}'s drain (${text}).`, 'good');
      return;
    }
    let amount;
    if (d.amount === 'level') amount = this.game.rollHp(target.cls, abilityMod(target.abilities.con)).gain;
    else if (d.amount === 'damage') amount = Math.max(1, dealt ?? 1);
    else amount = Math.max(1, roll(d.amount));
    amount = Math.min(amount, Math.max(0, target.maxHp - 1)); // drained to the last breath, never past it
    if (amount <= 0) return;
    target.maxHp -= amount;
    target.hp = Math.min(target.hp, target.maxHp);
    target.drained = (target.drained ?? 0) + amount;
    audio.play('level_drain');
    this.fxOn(target, `LIFE DRAINED −${amount}`, '#b03a8e');
    this.game.log(`The ${m.name} drains the life from ${target.name} — ${amount} maximum HP torn away (${text})! A full rest or the temple restores it.`, 'death');
    if (d.heals && m.hp > 0) {
      const heal = Math.min(amount, hpMax(m) - m.hp);
      if (heal > 0) { m.hp += heal; this.fxOn(m, `+${heal}`, '#c03050'); this.game.log(`The ${m.name} drinks what it stole — ${heal} HP.`, 'death'); }
    }
  }

  // Runic Riposte (Bladesong verb): a monster's blow that lands on the
  // singer is answered at once with a free strike. At 18, blows on an ally
  // standing beside them are answered too. Never while fleeing; never from
  // inside another riposte; a bow can't riposte.
  riposte(m, victim) {
    if (this.fleeing || this.riposting || m.hp <= 0 || !victim.alive) return;
    const mc = this.combatantOf(m);
    const vc = this.combatantOf(victim);
    if (!mc || !vc) return;
    let rc = null;
    if (hasVerb(this.game.data, victim, 'runic_riposte') && !victim.weapon?.range && this.adjacent(vc, mc)) rc = vc;
    else {
      rc = this.heroes().find(h => h !== vc && h.ref.alive && !h.ref.weapon?.range
        && hasVerb(this.game.data, h.ref, 'runic_riposte') && hasRefinement(this.game.data, h.ref, 'riposte_allies')
        && this.adjacent(h, vc) && this.adjacent(h, mc)) ?? null;
    }
    if (!rc) return;
    const ch = rc.ref;
    const verb = laneOf(this.game.data, ch).verb;
    this.riposting = true;
    this.addFx(rc.x, rc.y, `${(verb.name ?? 'RIPOSTE').toUpperCase()}!`, COLOR.sun);
    this.game.log(`${verb.name ?? 'Runic Riposte'}! ${ch.name} answers the ${m.name}${rc !== vc ? ` for ${victim.name}` : ''}.`, 'combat');
    audio.play('melee_hit');
    if (ch.crescendoArmed) this.forceCrit = true;
    const res = this.strike(rc, mc, 'ripostes');
    this.forceCrit = false;
    this.riposting = false;
    if (res.kill) {
      ch.counters.riposteKills++;
      this.slay(m);
    }
  }

  // The player answered the Guardian's Stand prompt (Y/N from main.js).
  resolveReaction(accept) {
    const r = this.pendingReaction;
    if (!r) return;
    this.pendingReaction = null;
    this.mode = 'move';
    if (r.kind === 'ward') {
      if (accept) {
        if (!this.game.arena) r.singer.sp = Math.max(0, r.singer.sp - r.cost);
        this.wardBonus = { target: r.target, ac: r.ac, name: r.name, singer: r.singer };
        audio.play('spell_buff');
        this.fxOn(r.target, `${r.name}! +${r.ac} AC`, '#9fc8ff');
        this.game.log(`${r.singer.name} sings ${r.name} over ${r.target === r.singer ? 'themself' : r.target.name} (${r.cost} SP): +${r.ac} AC and saves against this blow.`, 'good');
      } else {
        this.game.log(`${r.singer.name} lets the blow come as it will.`, 'info');
      }
      this.surgeDone = true;   // no second offer for the same swing
      this.monsterAttack(r.m, r.target);
      if (this.pendingReaction) return; // the Stand asks next — wait again
      this.resumeAfterBlow(); // a multi-attacker's chain picks back up here
      return;
    }
    if (accept) {
      this.lastMonsterRoll = null; // the blow never lands as rolled
      const g = r.guardian;
      let cost = hasRefinement(this.game.data, g, 'stand_half_cost') ? Math.ceil(r.dmg / 2) : r.dmg;
      const p = passiveOf(this.game.data, g);
      if (p?.id === 'braced_stance' && this.game.hasShield(g)) cost = Math.max(0, cost - (p.reduce ?? 1));
      g.counters.standSaves++;
      audio.play('melee_hit');
      this.fxOn(r.target, 'shielded!', COLOR.teal);
      this.fxOn(g, cost > 0 ? `-${cost}` : 'blocked', COLOR.amber);
      this.game.log(`${g.name} throws themself before the blow meant for ${r.target.name}${cost > 0 ? ` — ${cost} damage taken` : ' — and shrugs it off'}!`, 'good');
      g.hp -= cost;
      if (g.hp <= 0) this.downHero(g, { attack: true });
    } else {
      this.applyMonsterHit(r.m, r.target, r.dmg);
    }
    this.resumeAfterBlow(); // a multi-attacker's chain picks back up here
  }

  // ---- The brink (magic v2): every way a hero can hit 0 HP funnels here.
  // Sanctuary holds the line first; then a Cleric's Mercy catches the fall
  // (a free reaction, every time — limited only by allies actually falling).
  // Returns true if the hero truly goes down.
  downHero(ref, opts = {}) {
    const data = this.game.data;
    const sc = this.sanctuary;
    if (sc && sc.c.ref.alive) {
      ref.hp = 1;
      this.fxOn(ref, 'SANCTUARY!', COLOR.teal);
      this.game.log(`${ref.name} is struck to the very edge — and ${sc.c.ref.rite?.abilityName ?? 'Sanctuary'} refuses the fall. 1 HP.`, 'good');
      return false;
    }
    // Unyielding (Bulwark verb): a BLOW that would drop the dwarf to 0 leaves
    // them at 1 — uncapped, per the doc. At 18 an ally beside them is caught
    // too. Poison and spellfire are not blows.
    if (opts.attack) {
      const rc = this.combatantOf(ref);
      let stone = null;
      if (hasVerb(data, ref, 'unyielding')) stone = ref;
      else if (rc) {
        stone = this.heroes().find(h => h.ref !== ref && h.ref.alive && hasVerb(data, h.ref, 'unyielding')
          && hasRefinement(data, h.ref, 'unyielding_allies') && this.adjacent(h, rc))?.ref ?? null;
      }
      if (stone) {
        const verb = laneOf(data, stone).verb;
        ref.hp = 1;
        stone.counters.unyieldingSaves++;
        this.fxOn(ref, `${(verb.name ?? 'UNYIELDING').toUpperCase()}!`, '#b8a890');
        this.game.log(`${ref.name} should have fallen — ${stone === ref ? `but ${verb.name ?? 'Unyielding'} holds them at 1 HP` : `but ${stone.name}'s ${verb.name ?? 'Unyielding'} holds them at 1 HP`}.`, 'good');
        return false;
      }
    }
    ref.hp = 0;
    const cleric = this.heroes().map(h => h.ref).find(r =>
      r.alive && r !== ref && hasVerb(data, r, 'mercy'));
    if (cleric) {
      const verb = laneOf(data, cleric).verb;
      const base = roll(verb.dice ?? '1d8');
      const wis = abilityMod(cleric.abilities.wis);
      ref.hp = Math.min(ref.maxHp, Math.max(1, base + wis));
      cleric.counters.mercySaves++;
      let cured = null;
      if (hasRefinement(data, cleric, 'mercy_cures') && ref.conditions.length) {
        cured = this.game.conditionDef(ref.conditions[0].id)?.name;
        ref.conditions.shift();
      }
      this.fxOn(ref, `MERCY! +${ref.hp}`, COLOR.green);
      this.game.log(`${ref.name} falls — and ${cleric.name}'s ${verb.name ?? 'Mercy'} catches them before they land: up again with ${ref.hp} HP (${verb.dice ?? '1d8'} → ${base}${wis ? ` ${wis > 0 ? '+' : '−'}${Math.abs(wis)} WIS` : ''})${cured ? `, ${cured.toLowerCase()} cured` : ''}.`, 'good');
      return false;
    }
    ref.alive = false;
    ref.timedBuffs = []; // every verse dies with the singer — a Stance too
    audio.play('hero_falls'); // silent until the designer maps it
    this.fxOn(ref, 'FALLEN', '#b03535');
    this.game.log(`${ref.name} has fallen!`, 'death');
    return true;
  }

  slay(monster) {
    this.game.monsters = this.game.monsters.filter(x => x !== monster);
    const c = this.combatantOf(monster);
    if (c) {
      c.diedAt = performance.now(); // the renderer shows the body falling
      this.addFx(c.x, c.y, 'slain!', COLOR.red);
      // Death burst (the black slaad): the corpse detonates — don't stand
      // next to the kill. Heroes in the wash save for half.
      if (monster.death_burst && !monster.burst) {
        monster.burst = true; // once, however many code paths reach slay
        this.deathBurst(monster, c);
      }
      this.breakBindings(c); // its conjured court dissolves with it
    }
    if (this.game.arena) {
      this.game.log(`The ${monster.name} collapses. (No XP in the training arena.)`, 'good');
      return;
    }
    if (monster.summoned !== undefined) {
      this.game.log(`The conjured ${monster.name} is destroyed — it unravels into nothing (no XP for a summoning).`, 'good');
      return;
    }
    this.game.log(`The ${monster.name} is slain! Each hero gains ${monster.xp} XP.`, 'good');
    const newlyReady = this.game.awardXp(monster.xp);
    if (newlyReady.length) audio.play('ready_to_level'); // the ding means ONE thing now
    for (const ch of newlyReady) this.fxOn(ch, 'READY TO LEVEL!', COLOR.amber);
    if (this.game.depth === 'boss' && monster.id === this.game.data.dungeon.boss.monster) {
      this.game.victory = true; // the run is won — the map shows the banner when the fight ends
      this.game.log(`The ${monster.name} is destroyed! The endless dark is broken — the party has conquered the dungeon!`, 'good');
    }
  }

  // The corpse detonates (death_burst): every hero within `area` of the
  // body saves for half of the dice, guards and wards drinking by name.
  deathBurst(monster, c) {
    const db = monster.death_burst;
    const burstSprite = db.element === 'frost' ? 'frost' : db.element === 'lightning' ? 'holy' : 'fire';
    const color = { fire: '#ff5a2a', frost: '#9fd8ff', lightning: '#e8e07a', poison: '#7ec850' }[db.element] ?? '#ff5a2a';
    this.emitSpellFx({ x: c.x, y: c.y }, { area: db.area ?? 1, type: 'damage', fx: { kind: 'burst', burst: burstSprite, color } }, c.x, c.y);
    if (db.element) audio.play(`spell_${db.element === 'frost' ? 'frost' : db.element === 'lightning' ? 'lightning' : 'fire'}`);
    this.game.log(`The ${monster.name} BURSTS as it dies${db.element ? ` — ${db.element} washes everything within ${db.area ?? 1}` : ''}!`, 'death');
    for (const h of this.heroes()) {
      if (!h.ref.alive || this.dist(h.x, h.y, c.x, c.y) > (db.area ?? 1)) continue;
      const raw = Math.max(1, roll(db.dice));
      const { saved, text } = db.save ? this.abilitySave(h, db.save, db.dc ?? 14) : { saved: false, text: '' };
      const dmg = saved ? Math.floor(raw / 2) : raw;
      if (saved && dmg <= 0) {
        this.resisted(h.ref, `${h.ref.name} dives clear of the burst (${text}).`);
        continue;
      }
      const bits = [`death burst ${db.dice} → ${raw}${this.saveBits(saved, text)}`];
      this.abilityHit(monster, h, dmg, db.element, bits);
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
    this.checkPhases(); // a wounded boss may change its game before anything else happens
    if (game.arena) {
      // Arena endings never touch the real game: win or wipe, the party is
      // restored from the entry snapshot and steps back onto the map.
      const wipe = game.party.every(ch => !ch.alive);
      if (!wipe && this.monsters().length) return false;
      this.ending = wipe ? 'defeat' : 'victory';
      this.endedAt = performance.now();
      this.busy = true;
      if (!wipe) audio.play('battle_victory');
      setTimeout(() => {
        if (game.battle !== this) return;
        game.battle = null;
        game.endArena();
      }, TIMING.endBeat);
      return true;
    }
    if (game.party.every(ch => !ch.alive)) {
      this.ending = 'defeat';
      this.endedAt = performance.now();
      this.busy = true; // input locked while the scene plays out
      game.over = true;
      game.log('The entire party has fallen. The dungeon keeps its dead. Press R to try again.', 'death');
      setTimeout(() => { if (game.battle === this) game.battle = null; }, TIMING.wipeBeat);
      return true;
    }
    if (!this.monsters().length) {
      this.ending = 'victory';
      this.endedAt = performance.now();
      this.busy = true;
      this.stripBattleConditions(); // burning etc. gutter out when the fight ends
      this.recoverArrows();
      audio.play('battle_victory');
      game.log('The battlefield falls silent. The party stands victorious.', 'good');
      setTimeout(() => {
        if (game.battle === this) {
          game.battle = null;
          game.updateVision();
          game.autosave(); // the dust settles — the run is worth keeping again
        }
      }, TIMING.endBeat);
      return true;
    }
    return false;
  }

  // After a won fight the party walks the field: a share of the arrows
  // that missed (items.json ranged.recover_misses) come back to the quiver.
  recoverArrows() {
    const id = this.game.ammoId();
    if (!id || !this.arrowsMissed) return;
    for (const [ch, missed] of this.arrowsMissed) {
      const all = !!giftOf(ch)?.recover_all; // Fletcher: every shaft comes home
      const back = all ? missed : Math.floor(missed * (this.game.rangedRules().recover_misses ?? 0.5));
      if (back <= 0) continue;
      // The shooter's own quiver first; what won't fit goes to the pouch.
      const cap = this.game.quiverCap(ch);
      const toQuiver = ch.weapon?.range ? Math.max(0, Math.min(back, cap - (ch.quiver ?? 0))) : 0;
      ch.quiver = (ch.quiver ?? 0) + toQuiver;
      const pouch = back - toQuiver > 0 ? this.game.addItem(id, back - toQuiver) : 0;
      this.game.log(`${ch.name} gathers ${toQuiver + pouch} arrow${toQuiver + pouch === 1 ? '' : 's'} from the field${toQuiver ? ` (quiver ${ch.quiver}/${cap})` : ''}.`, 'good');
    }
  }

  stripBattleConditions() {
    for (const ch of this.game.party) {
      ch.conditions = ch.conditions.filter(c => this.game.conditionDef(c.id)?.lingers);
      ch.timedBuffs = ch.alive ? ch.timedBuffs.filter(b => b.stance) : []; // Rage and its kin gutter out; a Stance (v1.1) holds till the next rest
      ch.hidden = false;  // shadows are for battlefields
      // Magic v2 battle state guttering out with the fight.
      Object.assign(ch, BATTLE_FLAGS);
    }
    this.wardBonus = null;
    this.surgeSave = null;
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
      if (i === blows.length - 1 && !this.checkEnd()) setTimeout(exit, TIMING.fleeExit);
    }, TIMING.partingLead + i * TIMING.partingBlow));
  }
}
