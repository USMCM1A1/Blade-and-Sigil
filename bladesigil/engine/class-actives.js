// The class-active registry (refactor step 5b, 2026-09-04): every battle
// art a hero picks from the C menu that is NOT a spell — lane verbs, level-15
// capstones, snares, the Rite's unique power. One entry per menu id:
//   menu(b, c, ctx, out)  — push the entry (or entries) when the hero has it
//   use(b, c, entry, ctx) — resolve it (targeted arts resolve at the crosshair instead)
//   flags — per-battle hero fields the art reads (reset at battle start/end)
//   lapse — an "until your next turn" flag and the name it fades under
// ctx = { D: data, ref: the hero, lane, cap: lane capstone, rite }. The
// order here IS the menu order. Adding an art = one entry.

import { laneOf, hasVerb, hasCapstone, hasRefinement, riteOf, snareGrant, snareKinds, snareDice } from './progression.js';
import { activeStances } from './magic.js';
import * as audio from './audio.js';
import { COLOR } from './constants.js';

// What each kind of snare does beyond the damage (designer session
// 2026-09-03). The DC is the thief's own skill — craft, not caster level.
export const SNARE_RIDERS = {
  venom: { condition: 'poison', rounds: 3, verb: 'poisons what it catches' },
  bear: { condition: 'paralysis', rounds: 2, verb: 'holds it fast' },
  caltrops: { condition: 'slowed', rounds: 3, verb: 'slows it to a crawl' },
  flash: { condition: 'blinded', rounds: 2, verb: 'blinds it' },
};

export const CLASS_ACTIVES = [
  {
    id: 'vanish',
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      // Vanish (Shadows, level 10): an active verb, not a reaction.
      if (hasVerb(D, ref, 'vanish') && !ref.hidden) {
        const free = hasRefinement(D, ref, 'vanish_free');
        out.push({ kind: 'active', id: 'vanish', name: lane.verb.name ?? 'Vanish', cost: 0, affordable: true,
          description: `Melt into shadow — foes lose you until you strike.${free ? ' (Perfected: costs nothing.)' : ' Costs your whole action.'}` });
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        audio.play('vanish'); // its own moment id (designer's pick 2026-08-26: sdr_invisible)
        ref.hidden = true;
        ref.counters.shadowFeats++;
        b.addFx(c.x, c.y, 'VANISH', COLOR.shadow);
        b.game.log(`${ref.name} melts into the shadows — the enemy blinks, and finds nothing.`, 'good');
        // Perfected Vanish (18) costs nothing; before that, it IS the action.
        if (!hasRefinement(D, ref, 'vanish_free')) b.endHeroTurn();
        return;
    },
  },
  {
    id: 'insight',
    flags: { insight: null },
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      // Arcane Insight (Wizard-lane verb): once per battle, the action buys a
      // lasting edge. At 18 the reading is deep enough for two edges at once.
      if (hasVerb(D, ref, 'arcane_insight') && !b.spentOnce(ref, 'insight')) {
        const v = lane.verb;
        const opts = hasRefinement(D, ref, 'insight_double')
          ? [['hit_dc', `+${v.hit ?? 2} to-hit & +${v.dc ?? 1} save DC`], ['hit_dmg', `+${v.hit ?? 2} to-hit & +${v.dmg ?? 2} spell damage`], ['dc_dmg', `+${v.dc ?? 1} save DC & +${v.dmg ?? 2} spell damage`]]
          : [['hit', `+${v.hit ?? 2} to-hit`], ['dc', `+${v.dc ?? 1} save DC`], ['dmg', `+${v.dmg ?? 2} spell damage`]];
        for (const [pick, blurb] of opts) {
          out.push({ kind: 'active', id: 'insight', pick, name: `${v.name ?? 'Arcane Insight'} — ${blurb}`, cost: 0, affordable: true,
            description: `Read the fight (your action): ${blurb} for the rest of this battle. Once per battle.` });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        b.markSpent(ref, 'insight');
        audio.play('spell_arcane');
        const v = lane.verb;
        const picks = entry.pick.split('_');
        ref.insight = {
          hit: picks.includes('hit') ? (v.hit ?? 2) : 0,
          dc: picks.includes('dc') ? (v.dc ?? 1) : 0,
          dmg: picks.includes('dmg') ? (v.dmg ?? 2) : 0,
        };
        b.addFx(c.x, c.y, `${(v.name ?? 'Insight').toUpperCase()}!`, '#8fb8e8');
        b.game.log(`${ref.name} reads the whole fight in a heartbeat — ${entry.name.split('— ')[1] ?? 'the edge is theirs'} for the rest of it.`, 'good');
        b.endHeroTurn();
        return;
    },
  },
  {
    id: 'overcast_toggle',
    flags: { overcastOn: false },
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      // Overcast (Sorcerer-lane verb): a stance, free to flip — while ON,
      // damage and healing spells cost more and hit one level harder.
      if (hasVerb(D, ref, 'overcast')) {
        const v = lane.verb;
        out.push({ kind: 'active', id: 'overcast_toggle', hint: v.name ?? 'Overcast', name: `${v.name ?? 'Overcast'}: ${ref.overcastOn ? 'ON — cast normally again' : 'OFF — pour it on'}`, cost: 0, affordable: true,
          description: `Free to flip. While burning: damage/heal spells cost ${hasRefinement(D, ref, 'overcast_cheap') ? '×1.5' : 'double'} SP for +${v.extra_dice ?? '2d6'} and +${v.dc_bonus ?? 1} save DC.` });
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        ref.overcastOn = !ref.overcastOn;
        b.game.log(`${ref.name} ${ref.overcastOn ? `opens the channel wide — ${lane.verb.name ?? 'Overcast'} burns until doused` : `steadies the flow — ${lane.verb.name ?? 'Overcast'} rests`}.`, 'info');
        return;
    },
  },
  {
    id: 'zealous_toggle',
    flags: { zealousOn: false, zealousImmune: false },
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      // Zealous Strike (Templar-lane verb): a stance — every landed melee hit
      // spends SP for divine damage and a taste of healing.
      if (hasVerb(D, ref, 'zealous_strike')) {
        const v = lane.verb;
        out.push({ kind: 'active', id: 'zealous_toggle', hint: v.name ?? 'Zealous Strike', name: `${v.name ?? 'Zealous Strike'}: ${ref.zealousOn ? 'ON — sheathe the fire' : 'OFF — let it burn'}`, cost: 0, affordable: true,
          description: `Free to flip. While burning: each landed melee hit spends ${v.cost ?? 3} SP for +${v.dice ?? '2d6'} divine damage and ${v.heal ?? '1d6'} self-healing.` });
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        ref.zealousOn = !ref.zealousOn;
        b.game.log(`${ref.name} ${ref.zealousOn ? `lets the faith burn — every landed blow will carry ${lane.verb.name ?? 'Zealous Strike'}` : 'banks the holy fire'}.`, 'info');
        return;
    },
  },
  {
    id: 'surge_toggle',
    flags: { surgeOn: false },
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      // Hunter's Surge (Wolf verb): a stance — each attack action spends SP so
      // the off-hand keeps pace with the main hand.
      if (hasVerb(D, ref, 'hunters_surge')) {
        const v = lane.verb;
        out.push({ kind: 'active', id: 'surge_toggle', hint: v.name ?? "Hunter's Surge", name: `${v.name ?? "Hunter's Surge"}: ${ref.surgeOn ? 'ON — let the blades rest' : 'OFF — both blades, blow for blow'}`, cost: 0, affordable: true,
          description: `Free to flip. While burning: each attack action spends ${ref.packArmed ? 0 : v.cost ?? 2} SP and the off-hand attacks as many times as the main hand${ref.offhand ? '' : ' (needs a second blade in hand)'}.` });
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        ref.surgeOn = !ref.surgeOn;
        b.game.log(`${ref.name} ${ref.surgeOn ? `lets the hunt take over — ${lane.verb.name ?? "Hunter's Surge"} burns with every attack` : 'lets the blades rest'}.`, 'info');
        return;
    },
  },
  {
    id: 'fortify',
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      // Shared Fortitude (Hearthstone verb): spell points become an ally's second wind.
      if (hasVerb(D, ref, 'shared_fortitude')) {
        const v = lane.verb;
        const two = hasRefinement(D, ref, 'fortitude_two');
        out.push({ kind: 'active', id: 'fortify', name: v.name ?? 'Shared Fortitude', cost: v.cost ?? 3, affordable: b.game.arena || ref.sp >= (v.cost ?? 3),
          targeted: { kind: 'fortify', range: 6 },
          description: `${v.cost ?? 3} SP: an ally gains ${v.dice ?? '2d8'} + your CON of absorbed damage for the battle${two ? ' — and the most wounded other ally beside them shares it' : ''}.` });
      }
    },
  },
  {
    id: 'storm_of_blades',
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (cap && ref.level >= cap.level) {

        if (cap.id === 'storm_of_blades') {
          const minSp = cap.min_sp ?? 1;
          out.push({ kind: 'active', id: 'storm_of_blades', name: cap.name ?? 'Storm of Blades', cost: Math.max(minSp, ref.sp), affordable: b.game.arena || ref.sp >= minSp,
            description: `ALL remaining SP (${ref.sp}; needs ${minSp}+): for ${cap.rounds ?? 3} rounds every main-hand hit earns a free off-hand strike at no penalty, and every attack lands +${cap.dmg ?? 2} harder.` });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        const spent = b.game.arena ? Math.max(cap.min_sp ?? 1, ref.sp) : ref.sp;
        if (!b.game.arena) ref.sp = 0;
        audio.play('spell_buff');
        ref.timedBuffs = ref.timedBuffs.filter(b => !b.storm);
        b.addTimedBuff(ref, { name: cap.name ?? 'Storm of Blades', dmg: cap.dmg ?? 2, rounds: cap.rounds ?? 3, storm: true });
        b.addFx(c.x, c.y, `${(cap.name ?? 'STORM OF BLADES').toUpperCase()}!`, COLOR.sun);
        b.game.log(`${ref.name} spends everything (${spent} SP) on ${cap.name ?? 'the Storm of Blades'} — two knives, ${cap.rounds ?? 3} rounds, no mercy.`, 'good');
        b.endHeroTurn();
        return;
    },
  },
  {
    id: 'rain_of_arrows',
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (cap && ref.level >= cap.level) {
        if (cap.id === 'rain_of_arrows') {
          out.push({ kind: 'active', id: 'rain_of_arrows', name: cap.name ?? 'Rain of Arrows', cost: 0, affordable: !!ref.weapon?.range,
            description: `${cap.rounds ?? 3} rounds: every shot also strikes each foe within ${cap.spread ?? 1} of its target (one arrow each) — and you cannot move.${ref.weapon?.range ? '' : ' Needs a bow in hand.'}` });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        if (!ref.weapon?.range) { b.game.log(`${cap.name ?? 'Rain of Arrows'} needs a bow in hand.`, 'info'); return; }
        audio.play('arrow');
        ref.timedBuffs = ref.timedBuffs.filter(b => !b.rain);
        b.addTimedBuff(ref, { name: cap.name ?? 'Rain of Arrows', rounds: cap.rounds ?? 3, rain: true, spread: cap.spread ?? 1, rooted: true });
        b.addFx(c.x, c.y, `${(cap.name ?? 'RAIN OF ARROWS').toUpperCase()}!`, COLOR.amber);
        b.game.log(`${ref.name} plants their feet and lets the ${cap.name ?? 'Rain of Arrows'} fall — every shot finds every foe beside its mark, for ${cap.rounds ?? 3} rounds.`, 'good');
        b.endHeroTurn();
        return;
    },
  },
  {
    id: 'whirling_verse',
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (cap && ref.level >= cap.level) {
        if (cap.id === 'whirling_verse') {
          const minSp = cap.min_sp ?? 1;
          const stance = activeStances(ref).map(b => b.name).join(' & ');
          out.push({ kind: 'active', id: 'whirling_verse', name: cap.name ?? 'Whirling Verse', cost: Math.max(minSp, ref.sp), affordable: b.game.arena || ref.sp >= minSp,
            description: `ALL remaining SP (${ref.sp}; needs ${minSp}+)${stance ? ` and ${stance} falls silent` : ''}: for ${cap.rounds ?? 3} rounds every landed hit grants a free extra strike. When it ends you have nothing left.` });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        // v1.1: the all-in gamble — every spell point, and the Stance with it.
        const spent = b.game.arena ? 0 : ref.sp;
        if (!b.game.arena) ref.sp = 0;
        const silenced = activeStances(ref).map(b => b.name);
        ref.timedBuffs = ref.timedBuffs.filter(b => !b.verse && !b.stance);
        b.addTimedBuff(ref, { name: cap.name ?? 'Whirling Verse', rounds: cap.rounds ?? 3, verse: true });
        audio.play('spell_buff');
        b.addFx(c.x, c.y, `${(cap.name ?? 'WHIRLING VERSE').toUpperCase()}!`, COLOR.sun);
        b.game.log(`${ref.name} pours everything into ${cap.name ?? 'the Whirling Verse'} — ${spent} SP gone${silenced.length ? `, ${silenced.join(' & ')} falls silent` : ''}. For ${cap.rounds ?? 3} rounds every hit will earn another.`, 'good');
        b.endHeroTurn();
        return;
    },
  },
  {
    id: 'mirror_ward',
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (cap && ref.level >= cap.level) {
        if (cap.id === 'mirror_ward') {
          out.push({ kind: 'active', id: 'mirror_ward', name: cap.name ?? 'Mirror Ward', cost: 0, affordable: true,
            description: `${cap.rounds ?? 3} rounds: ${Math.round((cap.reflect ?? 0.5) * 100)}% of every melee wound is thrown back at its source — and you cannot move.` });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        audio.play('spell_arcane');
        ref.timedBuffs = ref.timedBuffs.filter(b => b.name !== (cap.name ?? 'Mirror Ward'));
        b.addTimedBuff(ref, { name: cap.name ?? 'Mirror Ward', rounds: cap.rounds ?? 3, reflect: cap.reflect ?? 0.5, rooted: true });
        b.addFx(c.x, c.y, `${(cap.name ?? 'MIRROR WARD').toUpperCase()}!`, '#cfe6ff');
        b.game.log(`${ref.name} raises ${cap.name ?? 'the Mirror Ward'} — what strikes them strikes back, and they will not move.`, 'good');
        b.endHeroTurn();
        return;
    },
  },
  {
    id: 'mountains_heart',
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (cap && ref.level >= cap.level) {
        if (cap.id === 'mountains_heart') {
          out.push({ kind: 'active', id: 'mountains_heart', name: cap.name ?? "Mountain's Heart", cost: 0, affordable: true,
            description: `${cap.rounds ?? 3} rounds: every wound halved, no crit can land — your hit/damage bonus is nothing and you cannot move.` });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        audio.play('spell_buff');
        ref.timedBuffs = ref.timedBuffs.filter(b => b.name !== (cap.name ?? "Mountain's Heart"));
        b.addTimedBuff(ref, { name: cap.name ?? "Mountain's Heart", rounds: cap.rounds ?? 3, halve: true, crit_immune: true, no_hit_bonus: true, rooted: true });
        b.addFx(c.x, c.y, `${(cap.name ?? "MOUNTAIN'S HEART").toUpperCase()}!`, '#b8a890');
        b.game.log(`${ref.name} becomes ${cap.name ?? "the Mountain's Heart"} — a wall, not a warrior, for ${cap.rounds ?? 3} rounds.`, 'good');
        b.endHeroTurn();
        return;
    },
  },
  {
    id: 'deep_roots',
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (cap && ref.level >= cap.level) {
        if (cap.id === 'deep_roots' && !ref.spentRest?.deep_roots) {
          const minSp = cap.min_sp ?? 3;
          const wards = b.shareableWards(ref);
          out.push({ kind: 'active', id: 'deep_roots', name: cap.name ?? 'Aegis of the Deep Roots', cost: Math.max(minSp, ref.sp), affordable: wards.length > 0 && (b.game.arena || ref.sp >= minSp),
            description: wards.length
              ? `Once per rest — ALL remaining SP (${ref.sp}; needs ${minSp}+): ${wards.map(b => b.name).join(', ')} spread to the whole party for ${cap.rounds ?? 3} rounds.`
              : `Once per rest — ALL remaining SP: every AC/save/resist ward on you spreads to the party. Nothing to share yet — raise a ward first.` });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        const wards = b.shareableWards(ref);
        if (!wards.length) {
          b.addFx(c.x, c.y, 'nothing to share', COLOR.dim);
          b.game.log(`${ref.name} has no ward raised to share — sing one first.`, 'info');
          return; // the moment isn't wasted
        }
        ref.spentRest.deep_roots = true;
        const spent = ref.sp;
        if (!b.game.arena) ref.sp = 0;
        audio.play('spell_buff');
        let n = 0;
        for (const hc of b.heroes()) {
          if (!hc.ref.alive || hc.ref === ref) continue;
          for (const b of wards) {
            const name = `${b.name} (${cap.name ?? 'Deep Roots'})`;
            hc.ref.timedBuffs = (hc.ref.timedBuffs ?? []).filter(x => x.name !== name);
            b.addTimedBuff(hc.ref, { name, ac: b.ac ?? 0, saves: b.saves ?? 0, rounds: cap.rounds ?? 3,
              resist: b.resist ?? null, reduce: b.reduce ?? 0, halve: !!b.halve, immune_conditions: b.immune_conditions ?? false });
          }
          b.particleFx(hc.x, hc.y, 'sparkle', COLOR.ember);
          b.addFx(hc.x, hc.y, 'the roots hold', COLOR.ember);
          n++;
        }
        ref.counters.alliesFortified += n;
        b.addFx(c.x, c.y, `${(cap.name ?? 'DEEP ROOTS').toUpperCase()}!`, COLOR.ember);
        b.game.log(`${ref.name} pours everything (${spent} SP) into ${cap.name ?? 'the Deep Roots'} — ${wards.map(b => b.name).join(', ')} spread${wards.length === 1 ? 's' : ''} to the whole party for ${cap.rounds ?? 3} rounds.`, 'good');
        b.endHeroTurn();
        return;
    },
  },
  {
    id: 'rage',
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (cap && ref.level >= cap.level) {
        if (cap.id === 'rage') {
          out.push({ kind: 'active', id: 'rage', name: cap.name ?? 'Rage', cost: 0, affordable: true,
            description: `+${cap.hit ?? 2} hit, +${cap.dmg ?? 2} damage, ${cap.extra_attacks ?? 1} extra attack, ${cap.ac ?? -2} AC for ${cap.rounds ?? 3} rounds.` });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        audio.play('spell_buff');
        ref.timedBuffs = ref.timedBuffs.filter(b => b.name !== (cap.name ?? 'Rage'));
        b.addTimedBuff(ref, {
          name: cap.name ?? 'Rage',
          hit: cap.hit ?? 2, dmg: cap.dmg ?? 2, ac: cap.ac ?? -2,
          attacks: cap.extra_attacks ?? 1, rounds: cap.rounds ?? 3,
        });
        b.addFx(c.x, c.y, 'RAGE!', COLOR.red);
        b.game.log(`${ref.name} gives themself to the fury — all blade, no shield!`, 'good');
        b.endHeroTurn();
    },
  },
  {
    id: 'taunt',
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (cap && ref.level >= cap.level) {
        if (cap.id === 'bulwark') {
          out.push({ kind: 'active', id: 'taunt', name: 'Taunt', cost: 0, affordable: true,
            description: `Bellow a challenge — enemies strike at YOU for ${cap.taunt_rounds ?? 2} rounds.` });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        audio.play('spell_buff');
        b.taunt = { c, until: b.round + (cap.taunt_rounds ?? 2) };
        b.addFx(c.x, c.y, 'TAUNT!', COLOR.amber);
        b.game.log(`${ref.name} bellows a challenge — every foe turns their way!`, 'good');
        b.endHeroTurn();
    },
  },
  {
    id: 'twin_surge',
    flags: { twinArmed: false },
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (cap && ref.level >= cap.level) {
        if (cap.id === 'twin_surge' && !ref.spentRest?.twin_surge && !ref.twinArmed) {
          out.push({ kind: 'active', id: 'twin_surge', name: cap.name ?? 'Stormsurge', cost: 0, affordable: true,
            description: 'Once per rest, free to arm: your next spell resolves TWICE — then the channeling leaves you Exhausted for a round.' });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        ref.twinArmed = true;
        audio.play('spell_arcane');
        b.addFx(c.x, c.y, `${(entry.name ?? 'Stormsurge').toUpperCase()} armed`, '#8fb8e8');
        b.game.log(`${ref.name} gathers the storm — the next spell will strike TWICE (and the backlash will cost a round).`, 'good');
        return;
    },
  },
  {
    id: 'divine_inspiration',
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (cap && ref.level >= cap.level) {
        if (cap.id === 'divine_inspiration') {
          const minSp = cap.min_sp ?? 5;
          out.push({ kind: 'active', id: 'divine_inspiration', name: cap.name ?? 'Divine Inspiration', cost: Math.max(minSp, ref.sp), affordable: b.game.arena || ref.sp >= minSp,
            description: `ALL remaining SP (${ref.sp}; needs ${minSp}+): +${cap.hit ?? 3} hit, +${cap.dmg ?? 3} damage, +${cap.ac ?? 3} AC for ${cap.rounds ?? 3} rounds.` });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        const spent = b.game.arena ? Math.max(cap.min_sp ?? 5, ref.sp) : ref.sp;
        if (!b.game.arena) ref.sp = 0;
        ref.timedBuffs = ref.timedBuffs.filter(b => b.name !== (cap.name ?? 'Divine Inspiration'));
        audio.play('spell_light');
        b.addTimedBuff(ref, {
          name: cap.name ?? 'Divine Inspiration',
          hit: cap.hit ?? 3, dmg: cap.dmg ?? 3, ac: cap.ac ?? 3, rounds: cap.rounds ?? 3,
        });
        b.addFx(c.x, c.y, `${(cap.name ?? 'DIVINE INSPIRATION').toUpperCase()}!`, COLOR.gold);
        b.game.log(`${ref.name} pours every prayer into one moment (${spent} SP) — heaven fights in their armor!`, 'good');
        b.endHeroTurn();
        return;
    },
  },
  {
    id: 'miracle',
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (cap && ref.level >= cap.level) {
        if (cap.id === 'miracle' && !ref.spentRest?.miracle) {
          const minSp = cap.min_sp ?? 5;
          out.push({ kind: 'active', id: 'miracle', name: cap.name ?? 'Miracle', cost: Math.max(minSp, ref.sp), affordable: b.game.arena || ref.sp >= minSp,
            description: `Once per rest — ALL remaining SP (${ref.sp}; needs ${minSp}+): the living are healed to full, the fallen rise at half.` });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        b.markSpent(ref, 'miracle');
        audio.play('spell_heal');
        ref.spentRest.miracle = true;
        const spent = ref.sp;
        if (!b.game.arena) ref.sp = 0;
        b.addFx(c.x, c.y, `${(cap.name ?? 'MIRACLE').toUpperCase()}!`, COLOR.gold);
        b.game.log(`${ref.name} spends everything at once (${spent} SP) — a ${cap.name ?? 'Miracle'}!`, 'good');
        for (const hc of b.heroes()) {
          const ally = hc.ref;
          if (ally.alive && ally.hp < ally.maxHp) {
            const healed = ally.maxHp - ally.hp;
            ally.hp = ally.maxHp;
            b.fxOn(ally, `+${healed}`, COLOR.green);
          } else if (!ally.alive) {
            ally.alive = true;
            ally.hp = Math.max(1, Math.floor(ally.maxHp / 2));
            ally.conditions = [];
            b.fxOn(ally, 'RISEN!', COLOR.gold);
            b.game.log(`${ally.name} rises — called back by the ${cap.name ?? 'Miracle'}!`, 'good');
          }
        }
        b.endHeroTurn();
        return;
    },
  },
  {
    id: 'snares',
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      // Snares (2026-09-03): granted with the Shadows lane at the fork. One
      // menu entry per kind known — they aim like a spell and always place.
      const grant = snareGrant(D, ref);
      if (grant) {
        const { dice, steps } = snareDice(D, ref);
        const live = b.battleTraps.filter(t => t.owner === ref).length;
        const cap = hasCapstone(D, ref, 'deadly_webs') ? laneOf(D, ref).capstone : null;
        const max = cap?.max_traps ?? 1;
        for (const kind of snareKinds(D, ref)) {
          const riderText = SNARE_RIDERS[kind.id]
            ? ` · ${SNARE_RIDERS[kind.id].verb} (DC ${b.snareDC(ref)})` : '';
          out.push({ kind: 'active', id: `snare_${kind.id}`, name: kind.name, cost: 0,
            affordable: live < max,
            targeted: { kind: 'trap', range: grant.range ?? 3, snare: kind.id },
            description: live >= max
              ? `You already have ${live} snare${live > 1 ? 's' : ''} live (limit ${max}).`
              : `Lay it on a square within ${grant.range ?? 3} — ${dice}${steps ? ' (grown with your level)' : ''} to the first foe that finds it${riderText}.${cap ? ' It springs on anything stepping beside it.' : ''}` });
        }
      }
    },
  },
  {
    id: 'whirlwind',
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (rite && ref.rite) {

        if (rite.ability.id === 'whirlwind') {
          out.push({ kind: 'active', id: 'whirlwind', name: ref.rite.abilityName, cost: 0, affordable: true,
            description: 'One furious action: strike every foe in reach, each once.' });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        audio.play('melee_hit');
        // The Rite's storm of steel: one strike at every foe in reach.
        const foes = b.monsters().filter(mc => b.adjacent(mc, c));
        if (!foes.length) {
          b.addFx(c.x, c.y, 'no foe in reach', COLOR.dim);
          b.game.log(`${ref.name} finds no one in reach for ${entry.name}.`, 'info');
          return; // the action isn't wasted — move in and try again
        }
        b.addFx(c.x, c.y, `${entry.name.toUpperCase()}!`, COLOR.gold);
        b.game.log(`${ref.name} unleashes ${entry.name} — steel in every direction!`, 'good');
        for (const foeC of foes) {
          const res = b.strike(c, foeC, 'swings');
          if (res.kill) b.slay(foeC.ref);
        }
        b.endHeroTurn();
    },
  },
  {
    id: 'aegis',
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (rite && ref.rite) {
        if (rite.ability.id === 'aegis' && !b.aegisSpent?.has(ref)) {
          out.push({ kind: 'active', id: 'aegis', name: ref.rite.abilityName, cost: 0, affordable: true,
            description: 'Once per battle: for a full round, every blow on any ally strikes you instead — at half force.' });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        audio.play('spell_buff');
        (b.aegisSpent ??= new Set()).add(ref);
        b.aegis = { c, until: b.round + 1 };
        b.addFx(c.x, c.y, `${entry.name.toUpperCase()}!`, COLOR.teal);
        b.game.log(`${ref.name} raises ${entry.name} — for this round, every blow meant for the party finds them instead.`, 'good');
        b.endHeroTurn();
    },
  },
  {
    id: 'deathblow',
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (rite && ref.rite) {
        if (rite.ability.id === 'deathblow' && !b.spentOnce(ref, 'deathblow')) {
          out.push({ kind: 'active', id: 'deathblow', name: ref.rite.abilityName, cost: 0, affordable: true,
            targeted: { kind: 'deathblow', range: 1 },
            description: 'Once per battle: a full Assassinate against any foe in reach — no matter how alert or guarded.' });
        }
      }
    },
  },
  {
    id: 'shadowstep',
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (rite && ref.rite) {
        if (rite.ability.id === 'shadowstep' && !b.spentOnce(ref, 'shadowstep')) {
          out.push({ kind: 'active', id: 'shadowstep', name: ref.rite.abilityName, cost: 0, affordable: true,
            targeted: { kind: 'shadowstep', range: 6 },
            description: 'Once per battle, freely: reappear on any square you can see — hidden.' });
        }
      }
    },
  },
  {
    id: 'final_word',
    flags: { finalWordArmed: false },
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (rite && ref.rite) {
        if (rite.ability.id === 'final_word' && !b.spentOnce(ref, 'final_word') && !ref.finalWordArmed) {
          out.push({ kind: 'active', id: 'final_word', name: ref.rite.abilityName, cost: 0, affordable: true,
            description: 'Once per battle, free to arm: your next spell may come from ANYWHERE in the book — and costs nothing.' });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        ref.finalWordArmed = true;
        audio.play('spell_arcane');
        b.addFx(c.x, c.y, `${entry.name.toUpperCase()} armed`, COLOR.amber);
        b.game.log(`${ref.name} opens the book to a page no one else can read. The next spell is free — any page at all.`, 'good');
        return;
    },
  },
  {
    id: 'maelstrom',
    flags: { maelstromArmed: false },
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (rite && ref.rite) {
        if (rite.ability.id === 'maelstrom' && !b.spentOnce(ref, 'maelstrom') && !ref.maelstromArmed) {
          out.push({ kind: 'active', id: 'maelstrom', name: ref.rite.abilityName, cost: 0, affordable: true,
            description: 'Once per battle, free to arm: your next damage spell ignores range and area — it strikes EVERY foe on the field.' });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        ref.maelstromArmed = true;
        audio.play('spell_arcane');
        b.addFx(c.x, c.y, `${entry.name.toUpperCase()} armed`, '#8fb8e8');
        b.game.log(`${ref.name} lets go of aim itself — the next blast will find EVERYONE.`, 'good');
        return;
    },
  },
  {
    id: 'sanctuary',
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (rite && ref.rite) {
        if (rite.ability.id === 'sanctuary' && !b.spentOnce(ref, 'sanctuary')) {
          out.push({ kind: 'active', id: 'sanctuary', name: ref.rite.abilityName, cost: 0, affordable: true,
            description: 'Once per battle, freely: until your next turn, no ally can be brought below 1 HP.' });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        b.markSpent(ref, 'sanctuary');
        audio.play('spell_light');
        b.sanctuary = { c };
        b.addFx(c.x, c.y, `${entry.name.toUpperCase()}!`, COLOR.teal);
        b.game.log(`${ref.name} raises ${entry.name} — until their next turn, death waits outside the circle.`, 'good');
        return;
    },
  },
  {
    id: 'pack_instinct',
    flags: { packArmed: false },
    lapse: { flag: 'packArmed', what: 'Pack Instinct' },
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (rite && ref.rite) {
        if (rite.ability.id === 'pack_instinct' && !b.spentOnce(ref, 'pack_instinct')) {
          out.push({ kind: 'active', id: 'pack_instinct', name: ref.rite.abilityName, cost: 0, affordable: true,
            description: "Once per battle, freely: until your next turn, Hunter's Surge costs nothing and the off-hand swings without penalty." });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        b.markSpent(ref, 'pack_instinct');
        ref.packArmed = true;
        audio.play('spell_buff');
        b.addFx(c.x, c.y, `${entry.name.toUpperCase()}!`, COLOR.sun);
        b.game.log(`${ref.name} feels the pack at their back — until their next turn the surge is free and the off-hand true.`, 'good');
        return;
    },
  },
  {
    id: 'true_shot',
    flags: { trueShotArmed: false },
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (rite && ref.rite) {
        if (rite.ability.id === 'true_shot' && !b.spentOnce(ref, 'true_shot') && !ref.trueShotArmed) {
          out.push({ kind: 'active', id: 'true_shot', name: ref.rite.abilityName, cost: 0, affordable: true,
            description: 'Once per battle, free to arm: your next shot cannot miss and is a critical hit.' });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        b.markSpent(ref, 'true_shot');
        ref.trueShotArmed = true;
        audio.play('spell_buff');
        b.addFx(c.x, c.y, `${entry.name.toUpperCase()} armed`, COLOR.gold);
        b.game.log(`${ref.name} nocks ${entry.name} — the next arrow was always going to land.`, 'good');
        return;
    },
  },
  {
    id: 'crescendo',
    flags: { crescendoArmed: false },
    lapse: { flag: 'crescendoArmed', what: 'Crescendo' },
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (rite && ref.rite) {
        if (rite.ability.id === 'crescendo' && !b.spentOnce(ref, 'crescendo')) {
          out.push({ kind: 'active', id: 'crescendo', name: ref.rite.abilityName, cost: 0, affordable: true,
            description: 'Once per battle, freely: until your next turn, every Runic Riposte is an automatic critical hit.' });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        b.markSpent(ref, entry.id);
        ref[{ crescendo: 'crescendoArmed', unbroken_chord: 'chordArmed', bedrock: 'bedrock' }[entry.id]] = true;
        audio.play(entry.id === 'bedrock' ? 'spell_buff' : 'spell_arcane');
        b.addFx(c.x, c.y, `${entry.name.toUpperCase()}!`, entry.id === 'bedrock' ? '#b8a890' : COLOR.sun);
        b.game.log(entry.id === 'crescendo' ? `${ref.name} raises ${entry.name} — until their next turn, every riposte lands perfectly.`
          : entry.id === 'unbroken_chord' ? `${ref.name} sings ${entry.name} — until their next turn, the ward costs nothing.`
            : `${ref.name} becomes ${entry.name} — until their next turn, no blow can do more than 1.`, 'good');
        return;
    },
  },
  {
    id: 'unbroken_chord',
    flags: { chordArmed: false },
    lapse: { flag: 'chordArmed', what: 'the Unbroken Chord' },
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (rite && ref.rite) {
        if (rite.ability.id === 'unbroken_chord' && !b.spentOnce(ref, 'unbroken_chord')) {
          out.push({ kind: 'active', id: 'unbroken_chord', name: ref.rite.abilityName, cost: 0, affordable: true,
            description: 'Once per battle, freely: until your next turn, every Ward Surge costs nothing.' });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        b.markSpent(ref, entry.id);
        ref[{ crescendo: 'crescendoArmed', unbroken_chord: 'chordArmed', bedrock: 'bedrock' }[entry.id]] = true;
        audio.play(entry.id === 'bedrock' ? 'spell_buff' : 'spell_arcane');
        b.addFx(c.x, c.y, `${entry.name.toUpperCase()}!`, entry.id === 'bedrock' ? '#b8a890' : COLOR.sun);
        b.game.log(entry.id === 'crescendo' ? `${ref.name} raises ${entry.name} — until their next turn, every riposte lands perfectly.`
          : entry.id === 'unbroken_chord' ? `${ref.name} sings ${entry.name} — until their next turn, the ward costs nothing.`
            : `${ref.name} becomes ${entry.name} — until their next turn, no blow can do more than 1.`, 'good');
        return;
    },
  },
  {
    id: 'bedrock',
    flags: { bedrock: false },
    lapse: { flag: 'bedrock', what: 'Bedrock' },
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (rite && ref.rite) {
        if (rite.ability.id === 'bedrock' && !b.spentOnce(ref, 'bedrock')) {
          out.push({ kind: 'active', id: 'bedrock', name: ref.rite.abilityName, cost: 0, affordable: true,
            description: 'Once per battle, freely: until your next turn, no blow can do you more than 1 damage.' });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        b.markSpent(ref, entry.id);
        ref[{ crescendo: 'crescendoArmed', unbroken_chord: 'chordArmed', bedrock: 'bedrock' }[entry.id]] = true;
        audio.play(entry.id === 'bedrock' ? 'spell_buff' : 'spell_arcane');
        b.addFx(c.x, c.y, `${entry.name.toUpperCase()}!`, entry.id === 'bedrock' ? '#b8a890' : COLOR.sun);
        b.game.log(entry.id === 'crescendo' ? `${ref.name} raises ${entry.name} — until their next turn, every riposte lands perfectly.`
          : entry.id === 'unbroken_chord' ? `${ref.name} sings ${entry.name} — until their next turn, the ward costs nothing.`
            : `${ref.name} becomes ${entry.name} — until their next turn, no blow can do more than 1.`, 'good');
        return;
    },
  },
  {
    id: 'hearthfire',
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (rite && ref.rite) {
        if (rite.ability.id === 'hearthfire' && !b.spentOnce(ref, 'hearthfire')) {
          out.push({ kind: 'active', id: 'hearthfire', name: ref.rite.abilityName, cost: 0, affordable: true,
            description: `Once per battle, freely: every living ally gains ${ref.level} absorbed damage and +1 on every save for 3 rounds.` });
        }
      }
    },
    use: (b, c, entry, { D, ref, lane, cap }) => {

        b.markSpent(ref, 'hearthfire');
        audio.play('spell_buff');
        let n = 0;
        for (const hc of b.heroes()) {
          if (!hc.ref.alive || hc.ref === ref) continue;
          hc.ref.timedBuffs = (hc.ref.timedBuffs ?? []).filter(b => b.name !== entry.name);
          b.addTimedBuff(hc.ref, { name: entry.name, saves: 1, rounds: 3, absorb: ref.level });
          b.addFx(hc.x, hc.y, `+${ref.level} ward`, COLOR.ember);
          b.particleFx(hc.x, hc.y, 'sparkle', COLOR.ember);
          n++;
        }
        ref.counters.alliesFortified += n;
        b.addFx(c.x, c.y, `${entry.name.toUpperCase()}!`, COLOR.ember);
        b.game.log(`${ref.name} kindles ${entry.name} — ${n} all${n === 1 ? 'y' : 'ies'} warmed: ${ref.level} absorbed damage and +1 saves for 3 rounds.`, 'good');
        return;
    },
  },
  {
    id: 'judgment',
    menu: (b, c, { D, ref, lane, cap, rite }, out) => {
      if (rite && ref.rite) {
        if (rite.ability.id === 'judgment' && !b.spentOnce(ref, 'judgment')) {
          out.push({ kind: 'active', id: 'judgment', name: ref.rite.abilityName, cost: 0, affordable: true,
            targeted: { kind: 'judgment', range: 1 },
            description: 'Once per battle: a strike that cannot miss — an automatic critical — and its damage returns to you as healing.' });
        }
      }
    },
  },
];

// Per-battle hero fields every art may read — fresh at battle start, cleared
// at its end. Derived from the entries so no list can drift.
export const BATTLE_FLAGS = Object.assign({ freeSwapsUsed: 0 }, ...CLASS_ACTIVES.map(a => a.flags ?? {}));
// "Until your next turn" powers, in the order they are announced as spent.
export const LAPSES = CLASS_ACTIVES.filter(a => a.lapse).map(a => a.lapse);
