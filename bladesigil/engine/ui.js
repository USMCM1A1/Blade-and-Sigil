// DOM panels: party roster, message log, gold/location readouts, and the
// character sheet (stats + paper doll + potions + gear pool + leveling,
// toggled with I, E, or C).

import { abilityMod } from './rules.js';
import { classProg, laneOf, passiveOf, riteTier, favoredPicksOwed, groupOfType, focusGroupOf, focusList, focusName, growthOptions, growthPicks } from './progression.js';
import { unlockLevel, magicModel, maxSpellLevel, spellCost, knownSpells, castableSpells, preparedSlots, spellPicksOwed, bonusPicksOwed, studiesOwed, describeScale, scrollReadable, giftOf, activeStances, spellSchool, FAMILIES } from './magic.js';
import * as audio from './audio.js';

// Every UI button clicks (designer's pick 2026-08-26: GAM_09) — except where
// the moment already has its own voice (one sound means one thing): the
// spellbook's prepare/set-aside/copy buttons speak as the book, and the whole
// leveling flow (the Level Up button, the #choice fork/pick/Rite modals, the
// #levelup summary & milestone cards) speaks only as leveling/the Rite —
// designer's ruling 2026-08-26: "it should not be both".
document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  if (b.id === 'eq-levelup' || b.closest('#choice') || b.closest('#levelup')) return;
  if (b.dataset.prep || b.dataset.unprep || b.dataset.copy || b.dataset.study) audio.play('spellbook');
  else audio.play('button_click');
});

// A one-line designer-friendly summary of what a piece of gear does.
function gearStats(def) {
  const kind = def.type.replace('weapon_', '').replace('armor_', '').replace('jewelry_', '').replace('_', ' ');
  const bits = [kind];
  if (def.damage) bits.push(def.damage + (def.range ? ` · range ${def.range}` : ''));
  if (def.hit) bits.push(`+${def.hit} to hit`);
  if (def.enchanted) bits.push('magical');
  if (def.ac) bits.push(`AC +${def.ac}`);
  if (def.sp) bits.push(`+${def.sp} SP`);
  if (def.dmg) bits.push(`+${def.dmg} dmg`);
  if (def.detect) bits.push(`+${def.detect}% detect`);
  if (def.save_bonus) bits.push(`+${def.save_bonus} saves`);
  for (const [ab, v] of Object.entries(def.abilities ?? {})) bits.push(`+${v} ${ab.toUpperCase()}`);
  if (def.bonus_damage) bits.push(`+${def.bonus_damage.dice} ${def.bonus_damage.element}`);
  if (def.double_vs) bits.push(`×2 vs ${def.double_vs}${def.flavor ? ` (${def.flavor})` : ''}`);
  if (def.resist?.length) bits.push(`resist: ${def.resist.join(', ')}`);
  if (def.immune?.length) bits.push(`immune: ${def.immune.join(', ')}`);
  return bits.join(' · ');
}

// Shop/pouch rows: gear shows its numbers, everything else its description.
function itemStats(def) {
  return def.type === 'consumable' || def.type === 'supply' ? def.description : gearStats(def);
}

// ---- Progression choices: the lane fork & weapon focus (v2) ----
export function choiceOpen() {
  return document.getElementById('choice').style.display === 'flex';
}

// Called every frame: opens the next owed choice whenever the party is on
// the map (never mid-battle) and nothing else is being decided.
export function maybeOpenChoice(game) {
  if (game.battle || game.over || !game.choiceQueue.length || choiceOpen() || buildingOpen() || equipmentOpen() || spellbookOpen() || playtestOpen() || marchingOpen()) return;
  renderChoice(game, game.choiceQueue[0]);
}

// Number keys pick cards (main.js routes digits here while the modal is up).
export function choicePick(n) {
  document.querySelectorAll('#choice .cr-choice')[n - 1]?.click();
}

// One line of designer-friendly spell facts: level, cost, reach, dice,
// and every magic-v3 rider (duration, AC, wards, cures, growth).
function spellMetaLine(game, ch, s) {
  const bits = [`L${s.level}`, `${spellCost(game.data, ch, s)} SP`];
  if (s.range) bits.push(`range ${s.range}`);
  if (s.area === 'all') bits.push('every foe'); else if (s.area) bits.push(`burst ${s.area}`);
  if (s.targets === 'allies') bits.push('whole party'); else if (s.targets === 'ally') bits.push('one ally'); else if (s.targets === 'self') bits.push('self');
  if (s.dice) bits.push(s.dice);
  if (s.condition) bits.push(`${game.conditionDef(s.condition.id)?.name?.toLowerCase() ?? s.condition.id} ${s.condition.rounds}r`);
  if (s.hit) bits.push(`${s.hit > 0 ? '+' : ''}${s.hit} hit`);
  if (s.dmg) bits.push(`${s.dmg > 0 ? '+' : ''}${s.dmg} dmg`);
  if (s.ac) bits.push(`${s.ac > 0 ? '+' : ''}${s.ac} AC`);
  if (s.saves) bits.push(`${s.saves > 0 ? '+' : ''}${s.saves} saves`);
  if (s.attacks) bits.push(`+${s.attacks} attack`);
  if (s.absorb) bits.push(`ward ${s.absorb}`);
  if (s.bonus_damage) bits.push(`+${s.bonus_damage.dice} ${s.bonus_damage.element}`);
  if (s.hidden) bits.push('unseen');
  if (s.enchant) bits.push('weapon counts as enchanted');
  if (s.resist) bits.push(s.resist === 'all' ? 'all elements halved' : `${s.resist.join('/')} halved`);
  if (s.immune_conditions) bits.push('no afflictions');
  if (s.stance) bits.push('a Stance — until the next full rest');
  if (s.rounds) bits.push(`${s.rounds} rounds`);
  if (s.cures) bits.push(s.cures === 'all' ? 'cures all' : `cures ${s.cures.map(c => game.conditionDef(c)?.name?.toLowerCase() ?? c).join('/')}`);
  if (s.drain) bits.push(`drains ${Math.round(s.drain * 100)}%`);
  if (s.double_vs) bits.push(`×2 vs ${s.double_vs}`);
  if (s.only_family) bits.push(`${s.only_family.join('/')} only`);
  if (s.hp) bits.push(`rise at ${Math.round(s.hp * 100)}%`);
  if (s.scale) bits.push(describeScale(s));
  return bits.join(' · ');
}

function fmtOffsets(off = {}) {
  const parts = [];
  if (off.hit) parts.push(`${off.hit > 0 ? '+' : ''}${off.hit} hit & damage`);
  if (off.ac) parts.push(`${off.ac > 0 ? '+' : ''}${off.ac} AC`);
  if (off.sp) parts.push(`${off.sp > 0 ? '+' : ''}${off.sp} spell points`);
  if (off.detect) parts.push(`${off.detect > 0 ? '+' : ''}${off.detect}% detection`);
  return parts.join(', ');
}

function passiveBlurb(p) {
  if (p.id === 'weapon_focus') return `${p.name ?? 'Weapon Focus'}: +${p.dmg ?? 1} damage with a weapon type you choose`;
  if (p.id === 'braced_stance') return `Braced Stance: −${p.reduce ?? 1} damage from every hit while a shield is worn`;
  if (p.id === 'vital_strike') return `Vital Strike: +${p.dmg ?? 2} damage against unaware or flanked foes`;
  if (p.id === 'keen_senses') return `Keen Senses: +${p.bonus ?? 10}% to detect traps, secret doors, and trap work`;
  if (p.id === 'prepared_mind') return `Prepared Mind: keep the spellbook — study on, copy every scroll you find, and prepare ${p.slots_bonus ? `${p.slots_bonus} more spell${p.slots_bonus > 1 ? 's' : ''}` : 'your pages'} at a time, re-picked freely at every rest`;
  if (p.id === 'overchannel') return `Overchannel: every cast costs ${p.discount ?? 1} less spell point (never below 1) — the book is set aside: you know only ${p.known_per_level ?? 2} spells per spell level (chosen forever, from the catalog or your old pages)${p.bonus_pick_levels?.length ? `, plus one wild pick at levels ${p.bonus_pick_levels.join('/')}` : ''}`;
  if (p.id === 'blessed_hands') return `Blessed Hands: +${p.heal ?? 2} HP on every healing spell you cast`;
  if (p.id === 'sacred_weapon') return `Sacred Weapon: +${p.dmg ?? 1} divine damage on every weapon hit`;
  if (p.id === 'sundered_calm') return `${p.name ?? 'Sundered Calm'}: +${p.saves ?? 1} on every saving throw`;
  if (p.id === 'granite_skin') return `${p.name ?? 'Granite Skin'}: every un-elemental blow loses ${p.reduce ?? 1} damage`;
  if (p.id === 'warding_presence') return `${p.name ?? 'Warding Presence'}: allies standing beside you gain +${p.saves ?? 1} on every save`;
  if (p.id === 'ambidexterity') return `${p.name ?? 'Ambidexterity'}: the off-hand blade swings at only −${p.penalty ?? 2}, and one-handed melee weapons hit +${p.dmg ?? 1} harder`;
  if (p.id === 'snap_shot') return `${p.name ?? 'Snap Shot'}: no point-blank penalty${p.point_blank ? ` (only −${p.point_blank})` : ''}, and bows hit +${p.dmg ?? 1} harder`;
  return p.id;
}

function laneMilestones(l) {
  const bits = [];
  if (l.verb) bits.push(`Level ${l.verb.level}: ${l.verb.name}`);
  if (l.capstone) bits.push(`Level ${l.capstone.level}: become the ${l.archetype ?? l.capstone.name ?? 'capstone'}`);
  return bits.join(' · ');
}

// Open every choice this hero is owed, one after another (lane → focus →
// rite), then call onDone. This is how leveling FINISHES with one hero
// before the player moves on — no bouncing back to the map between picks.
function openChoicesFor(game, ch, onDone) {
  const choice = game.choiceQueue.find(c => c.ch === ch);
  if (!choice) { onDone?.(); return; }
  renderChoice(game, choice, () => openChoicesFor(game, ch, onDone));
}

// ---- Choice cards (refactor step 5c, 2026-09-04) ----
// Every choice a hero is owed (the fork, a spell pick, a study page, a
// favored enemy, a weapon family, the level-10 ability point, lane growth)
// is the SAME card: a step label, the portrait beside an intro, numbered
// option buttons, an optional warning. CHOICE_TYPES says what each kind
// puts in those slots; renderChoice draws it and wires the click. The
// option's `id` is what game.applyChoice receives.
const ABILITY_BUYS = {
  str: 'melee to-hit and damage',
  dex: 'bow to-hit and damage, AC, initiative',
  con: 'the HP you roll from here on',
  int: 'wizard spell damage and save DCs',
  wis: 'priest spell power, and saves against fear',
  cha: 'presence — few rules lean on it yet',
};

const CHOICE_TYPES = {
  lane: {
    step: () => 'A crossroads',
    intro: (game, ch) => `<b>${ch.name}</b> stands at level ${ch.level} — and the ${ch.cls.name}'s road forks here.`,
    options: (game, ch, choice) => choice.prog.lanes.map(l => ({ id: l.id, name: l.name,
      lines: [l.blurb ?? '', `${fmtOffsets(l.offsets)}${l.passive ? ` · ${passiveBlurb(l.passive)}` : ''}`, laneMilestones(l)] })),
    warn: () => 'This choice is forever — the path not walked stays closed.',
  },
  spell: {
    // The Sorcerer's pick: one spell of this level, in the blood forever —
    // or a wild pick (any castable level) at a bonus level.
    closeIfEmpty: true, // nothing left to pick (data changed?)
    step: (game, ch, choice) => choice.level === 'any' ? 'The blood remembers — a spell of any level' : `The Raw Gift — a level-${choice.level} spell`,
    intro: (game, ch, choice) => {
      const wild = choice.level === 'any';
      const owed = wild ? bonusPicksOwed(game.data, ch) : spellPicksOwed(game.data, ch).find(o => o.level === choice.level);
      return `<b>${ch.name}</b>'s magic is blood, not books: few spells, never dry.
          ${wild ? 'The gift deepens: choose ONE more spell of any level you can reach' : `Choose a level-${choice.level} spell`} to keep forever${owed.remaining > 1 ? ` (${owed.remaining} picks${wild ? '' : ' at this level'})` : ''}.`;
    },
    options: (game, ch, choice) => {
      const owed = choice.level === 'any' ? bonusPicksOwed(game.data, ch) : spellPicksOwed(game.data, ch).find(o => o.level === choice.level);
      return (owed?.options ?? []).map(s => ({ id: s.id, name: s.name, lines: [s.description, `${spellMetaLine(game, ch, s)}${s.rare ? ' · from the old book' : ''}`] }));
    },
    warn: () => 'Chosen is chosen — a Sorcerer never swaps spells.',
  },
  study: {
    // Study (magic v3): a free page for the spellbook — any common spell of
    // a level the hero can reach.
    closeIfEmpty: true,
    step: () => 'Study — a new page',
    intro: (game, ch) => {
      const owed = studiesOwed(game.data, ch);
      return `Candle-light and quiet hours: <b>${ch.name}</b> may ink one more spell into the spellbook${owed.remaining > 1 ? ` (${owed.remaining} pages owed)` : ''}. Rarer lore is found only on scrolls.`;
    },
    options: (game, ch) => studiesOwed(game.data, ch).options.map(s => ({ id: s.id, name: s.name, lines: [s.description, spellMetaLine(game, ch, s)] })),
    warn: () => 'A page inked is a page kept — prepare it at any rest.',
  },
  favored: {
    // Favored Enemy (the Ranger): a new family, or a known one deepened.
    step: () => 'Favored enemy',
    intro: (game, ch) => `<b>${ch.name}</b> has learned a prey's habits. Take up a new family (+1 to hit and damage against it) or deepen a known one (up to +${ch.cls.favored_enemy?.cap ?? 3}).`,
    options: (game, ch) => {
      const cap = ch.cls.favored_enemy?.cap ?? 3;
      const have = ch.favored ?? {};
      return FAMILIES.filter(f => (have[f] ?? 0) < cap).map(f => ({ id: f, name: f, lines: [have[f] ? `known: +${have[f]} → +${have[f] + 1}` : 'new: +1'] }));
    },
    warn: () => 'The hunter never forgets a quarry.',
  },
  focus: {
    step: () => 'Weapon Focus',
    intro: (game, ch) => {
      const fg = game.data.items.focus_groups ?? {};
      const held = focusList(game.data, ch);
      return held.length
        ? `<b>${ch.name}</b> already fights by ${held.map(g => (fg[g]?.name ?? g).toLowerCase()).join(' and ')}. Training adds another family — +1 damage with those weapons too.`
        : `<b>${ch.name}</b> hones one family of weapons — +1 damage with every weapon in it, forever. Which?`;
    },
    options: (game, ch) => {
      const current = groupOfType(game.data, ch.weapon?.type);
      const fg = game.data.items.focus_groups ?? {};
      return game.focusOptions(ch).map(t => ({ id: t, name: fg[t]?.name ?? t,
        lines: [fg[t]?.blurb || null, t === current ? '(in hand right now)' : null] }));
    },
  },
  ability: {
    // The level-10 boost (2026-09-02): +1 to one ability, the hero's own
    // and permanent. Each row shows what the point actually buys.
    step: () => 'A hero grows',
    intro: (game, ch) => `<b>${ch.name}</b> has come far enough to change in the bone. Add +${game.data.progression.ability_boost?.amount ?? 1} to one ability — it is permanent, and no item in the world can do this for you.`,
    options: (game, ch) => {
      const amount = game.data.progression.ability_boost?.amount ?? 1;
      return ['str', 'dex', 'con', 'int', 'wis', 'cha'].map(k => {
        const now = ch.baseAbilities[k], next = now + amount;
        const m1 = abilityMod(now), m2 = abilityMod(next);
        const gain = m2 > m1 ? ` — modifier ${m1 >= 0 ? '+' : ''}${m1} rises to ${m2 >= 0 ? '+' : ''}${m2}` : ` — modifier stays ${m1 >= 0 ? '+' : ''}${m1}`;
        return { id: k, name: `${k.toUpperCase()} ${now} → ${next}`, lines: [`${ABILITY_BUYS[k]}${gain}`] };
      });
    },
  },
  growth: {
    // Lane growth (2026-09-02): the lane's own list, minus what's taken.
    // Deliberately more options than picks — what you leave behind is what
    // makes your hero different from the last one you played.
    step: (game, ch) => `${laneOf(game.data, ch)?.name ?? 'The lane'} deepens`,
    intro: (game, ch) => {
      const held = growthPicks(game.data, ch);
      return `<b>${ch.name}</b> has drilled long enough to add something lasting.${held.length ? ` Already held: ${held.map(o => o.name).join(', ')}.` : ''} This one is permanent.`;
    },
    options: (game, ch) => growthOptions(game.data, ch).map(o => ({ id: o.id, name: o.name, lines: [o.blurb || null] })),
    note: () => 'You will not take them all — choose what this hero becomes.',
  },
};

function renderChoice(game, choice, after) {
  const root = document.getElementById('choice');
  const ch = choice.ch;
  root.style.display = 'flex';
  const portrait = game.heroPortrait(ch);
  const close = () => { root.style.display = 'none'; root.innerHTML = ''; };

  if (choice.type === 'rite') {
    renderRite(game, choice, after);
    return;
  }
  const kind = CHOICE_TYPES[choice.type];
  if (!kind) return;
  const opts = kind.options(game, ch, choice);
  if (kind.closeIfEmpty && !opts.length) { close(); after?.(); return; }
  root.innerHTML = `
      <div class="cr-panel ch-panel">
        <div class="cr-step">${kind.step(game, ch, choice)}</div>
        <div class="ch-head"><img src="${portrait}" alt="">
          <div>${kind.intro(game, ch, choice)}</div></div>
        <div class="cr-choices">
          ${opts.map((o, i) => `
            <button class="cr-choice" data-pick="${o.id}">
              <b>${i + 1}. ${o.name}</b>
              ${o.lines.filter(l => l != null).map(l => `<span>${l}</span>`).join('')}
            </button>`).join('')}
        </div>
        ${kind.warn ? `<p class="ch-warn">${kind.warn(game, ch, choice)}</p>` : ''}
        ${kind.note ? `<div class="cr-note">${kind.note(game, ch, choice)}</div>` : ''}
      </div>`;
  for (const b of root.querySelectorAll('[data-pick]')) {
    b.onclick = () => { game.applyChoice(choice, b.dataset.pick); close(); after?.(); };
  }
}

// ---- Sigil art: the Rite's emblem made visible ----
// Layers from data/progression.json "sigil_art": the shape image under the
// modifier image, both tinted the sigil's color. A missing word or file
// falls back to words-only (drawSigil resolves false; callers keep text).
const sigilImgCache = new Map();
function sigilImg(src) {
  if (!sigilImgCache.has(src)) {
    sigilImgCache.set(src, new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    }));
  }
  return sigilImgCache.get(src);
}

async function drawSigil(game, canvas, sigil, size = 72) {
  const art = game.data.progression.sigil_art;
  if (!art || !canvas || !sigil) return false;
  const shapeSrc = art.shapes?.[sigil.shape];
  const modSrc = art.modifiers?.[sigil.modifier];
  const hex = art.colors?.[sigil.color] ?? '#cfc4a6';
  if (!shapeSrc || !modSrc) return false;
  const [shape, mod] = await Promise.all([sigilImg(shapeSrc), sigilImg(modSrc)]);
  if (!shape || !mod) return false;
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const tinted = img => {
    const off = document.createElement('canvas');
    off.width = off.height = size;
    const c2 = off.getContext('2d');
    c2.drawImage(img, 0, 0, size, size);
    c2.globalCompositeOperation = 'source-in';
    c2.fillStyle = hex;
    c2.fillRect(0, 0, size, size);
    return off;
  };
  // Dark tints (void-black on a dark panel) get a pale breath behind them.
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  if (0.299 * r + 0.587 * g + 0.114 * b < 90) {
    ctx.filter = 'drop-shadow(0 0 3px rgba(216,206,176,0.55))';
  }
  ctx.drawImage(tinted(shape), 0, 0);
  ctx.drawImage(tinted(mod), 0, 0);
  ctx.filter = 'none';
  canvas.classList.add('rt-sigil-drawn');
  return true;
}

// ---- The Level 20 Rite: a four-step ceremony (design doc v3) ----
// I. the unique power revealed · II. the Naming (free text) · III. the Sigil
// (three drawn combinations, or hand-pick each part) · IV. the Title (the
// tracked playstyle stat sets the tier; the wording is the player's).
function renderRite(game, choice, after) {
  const ch = choice.ch;
  const rite = choice.lane.rite;
  const vocab = game.data.progression.sigil;
  const root = document.getElementById('choice');
  const portrait = game.heroPortrait(ch);
  root.style.display = 'flex';
  const state = { name: rite.ability.name, sigil: null };
  const rand = list => list[Math.floor(Math.random() * list.length)];

  const shell = body => {
    root.innerHTML = `<div class="cr-panel ch-panel">
      <div class="ch-head"><img src="${portrait}" alt=""><div><b>${ch.name}</b> stands at the height of mortal skill. The Rite begins.</div></div>
      ${body}</div>`;
  };

  const stepReveal = () => {
    shell(`
      <div class="cr-step">The Rite — I. The Power</div>
      <p class="rt-text">Something answers from beyond the tables and the dice. A power no other living soul commands:</p>
      <div class="rt-power"><b>${rite.ability.name}</b><span>${rite.ability.blurb ?? ''}</span></div>
      <button class="rt-next">Continue</button>`);
    root.querySelector('.rt-next').onclick = stepNaming;
  };

  const stepNaming = () => {
    shell(`
      <div class="cr-step">The Rite — II. The Naming</div>
      <p class="rt-text">This power is ${ch.name}'s alone — and it takes whatever name they give it. Speak it:</p>
      <input id="rt-name" type="text" maxlength="40" value="${state.name.replace(/"/g, '&quot;')}">
      <button class="rt-next">Seal the name</button>`);
    const input = root.querySelector('#rt-name');
    input.focus();
    input.select();
    const seal = () => {
      state.name = input.value.trim() || rite.ability.name;
      stepSigil();
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') seal(); });
    root.querySelector('.rt-next').onclick = seal;
  };

  const sigilText = s => `The ${s.modifier} ${s.shape}, wrought in ${s.color}`;

  const stepSigil = () => {
    const draws = Array.from({ length: 3 }, () =>
      ({ shape: rand(vocab.shapes), modifier: rand(vocab.modifiers), color: rand(vocab.colors) }));
    shell(`
      <div class="cr-step">The Rite — III. The Sigil</div>
      <p class="rt-text">An emblem to mark banners and legend. Three visions rise — choose one, or shape your own:</p>
      <div class="cr-choices">
        ${draws.map((s, i) => `<button class="cr-choice rt-sigil-choice" data-draw="${i}">
          <canvas class="rt-sigil" width="72" height="72"></canvas>
          <b>${i + 1}. ${sigilText(s)}</b></button>`).join('')}
        <button class="cr-choice" data-handpick><b>4. None of these — I will shape it myself</b></button>
      </div>`);
    root.querySelectorAll('[data-draw]').forEach((b, i) => {
      drawSigil(game, b.querySelector('canvas'), draws[i]); // the vision, made visible
      b.onclick = () => { state.sigil = draws[Number(b.dataset.draw)]; stepTitle(); };
    });
    root.querySelector('[data-handpick]').onclick = stepHandpick;
  };

  const stepHandpick = () => {
    const sel = (id, label, list) => `
      <label class="rt-sel"><b>${label}</b><select id="${id}">
        ${list.map(v => `<option>${v}</option>`).join('')}</select></label>`;
    shell(`
      <div class="cr-step">The Rite — III. The Sigil</div>
      <p class="rt-text">Then shape it, piece by piece:</p>
      <canvas class="rt-sigil rt-sigil-live" width="96" height="96"></canvas>
      ${sel('rt-shape', 'Base shape', vocab.shapes)}
      ${sel('rt-mod', 'Bearing', vocab.modifiers)}
      ${sel('rt-color', 'Wrought in', vocab.colors)}
      <button class="rt-next">So it is drawn</button>`);
    const current = () => ({
      shape: root.querySelector('#rt-shape').value,
      modifier: root.querySelector('#rt-mod').value,
      color: root.querySelector('#rt-color').value,
    });
    // The emblem redraws live as each piece is chosen.
    const preview = () => drawSigil(game, root.querySelector('.rt-sigil-live'), current(), 96);
    for (const id of ['rt-shape', 'rt-mod', 'rt-color']) root.querySelector(`#${id}`).onchange = preview;
    preview();
    root.querySelector('.rt-next').onclick = () => { state.sigil = current(); stepTitle(); };
  };

  const stepTitle = () => {
    const tier = riteTier(game.data, ch);
    const tierDef = rite.tiers[tier];
    const stat = ch.counters?.[rite.tracked] ?? 0;
    const statLabel = {
      rampageKills: 'foes felled in Rampage',
      standSaves: "blows taken for allies at Guardian's Stand",
      assassinateKills: 'marks slain by Assassinate',
      shadowFeats: 'vanishings and traps sprung from the shadows',
      bookCasts: 'spells cast from the book outside the day\'s preparation',
      overcasts: 'spells overcast beyond their level',
      mercySaves: 'allies caught by Mercy at the brink',
      zealousStrikes: 'blows landed burning with Zealous Strike',
    }[rite.tracked] ?? rite.tracked;
    const rewards = [
      tierDef.trinket ? `the Rite leaves a gift: ${game.itemDef(tierDef.trinket)?.name ?? tierDef.trinket}` : null,
      tierDef.dungeon ? `and word of a place only such a legend may enter: ${tierDef.dungeon.toLowerCase()}` : null,
    ].filter(Boolean).join('; ');
    shell(`
      <div class="cr-step">The Rite — IV. The Title</div>
      <canvas class="rt-sigil rt-sigil-live" width="96" height="96"></canvas>
      <p class="rt-text">The deeds are already written: <b>${stat}</b> ${statLabel}. The world has settled on what to call such a ${choice.lane.archetype ?? ch.cls.name} — though ${ch.name} may bend the wording:</p>
      <input id="rt-title" type="text" maxlength="40" value="${tierDef.title.replace(/"/g, '&quot;')}">
      <p class="rt-text rt-dim">Tier ${tier + 1} of 3${rewards ? ` — ${rewards}.` : ' — title and sigil alone; greater deeds earn greater rewards.'}</p>
      <button class="rt-next">Complete the Rite</button>`);
    drawSigil(game, root.querySelector('.rt-sigil-live'), state.sigil, 96);
    const input = root.querySelector('#rt-title');
    const complete = () => {
      const title = input.value.trim() || tierDef.title;
      root.style.display = 'none';
      root.innerHTML = '';
      game.applyRite(ch, { abilityName: state.name, sigil: state.sigil, title });
      after?.();
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') complete(); });
    root.querySelector('.rt-next').onclick = complete;
  };

  stepReveal();
}

// ---- Playtest bench (P): the designer's test tools ----
export function playtestOpen() {
  return document.getElementById('playtest').style.display === 'block';
}

export function togglePlaytest(game, show) {
  const panel = document.getElementById('playtest');
  const opening = show ?? !playtestOpen();
  panel.style.display = opening ? 'block' : 'none';
  if (opening) renderPlaytest(game);
}

// Where this monster lives in the endless dungeon, in designer terms.
// The bench's item chest: every item in items.json, by category, with
// collapsible groups — one click drops a copy into the party pouch (the
// real addItem, so max_carry caps still apply). Equip from the sheet.
const CHEST_GROUPS = [
  ['Weapons — blades', d => d.type === 'weapon_light_blade' || d.type === 'weapon_med_blade' || d.type === 'weapon_heavy_blade' || d.type === 'weapon_axe'],
  ['Weapons — blunt', d => d.type === 'weapon_light_blunt' || d.type === 'weapon_med_blunt' || d.type === 'weapon_heavy_blunt'],
  ['Weapons — bows', d => d.type === 'weapon_bow'],
  ['Armor & robes', d => d.type.startsWith('armor_')],
  ['Shields', d => d.type === 'shield'],
  ['Helms, cloaks & boots', d => ['helm', 'cloak', 'boots'].includes(d.type)],
  ['Rings & necklaces', d => d.type.startsWith('jewelry_')],
  ['Potions', d => d.type === 'consumable'],
  ['Supplies', d => d.type === 'supply'],
  ['Scrolls', d => d.type === 'scroll'],
];
let chestOpen = new Set(); // which groups the designer has unfolded (kept across re-renders)
let chestFilter = '';

function renderItemChest(game) {
  const body = document.getElementById('pt-body');
  const items = Object.entries(game.data.items.items);
  const used = new Set();
  const groups = CHEST_GROUPS.map(([name, test]) => {
    const list = items.filter(([id, d]) => !used.has(id) && test(d));
    for (const [id] of list) used.add(id);
    return [name, list];
  });
  const rest = items.filter(([id]) => !used.has(id));
  if (rest.length) groups.push(['Everything else', rest]);
  const q = chestFilter.trim().toLowerCase();
  const matches = ([id, d]) => !q || d.name.toLowerCase().includes(q) || id.includes(q) || (d.description ?? '').toLowerCase().includes(q);
  const row = ([id, d]) => {
    const have = game.inventory[id] || 0;
    const stack = d.type === 'consumable' || d.type === 'supply' || d.type === 'scroll';
    return `<div class="eq-pool-item">
      <span class="eq-pool-name">${d.name}${d.tier ? ` <span class="inv-stats">T${d.tier}</span>` : ''}${have ? ` <span class="inv-count">×${have} in pouch</span>` : ''}
        <span class="inv-stats">${gearStats(d)}${d.value ? ` · ${d.value}g` : ''}</span>
        ${d.description ? `<span class="inv-stats">${d.description}</span>` : ''}</span>
      <button data-give="${id}" data-n="1">+1</button>${stack ? `<button data-give="${id}" data-n="5">+5</button>` : ''}
    </div>`;
  };
  body.innerHTML = `
    <div class="pt-btnrow" style="align-items:center">
      <button data-back>← Back to the bench</button>
      <input id="pt-chest-filter" type="text" placeholder="filter by name…" value="${chestFilter.replace(/"/g, '&quot;')}"
        style="font-family:Georgia,serif;background:#1d1d28;color:var(--parchment);border:1px solid var(--panel-edge);border-radius:4px;padding:5px 8px;font-size:13px;flex:1;min-width:160px">
      <button data-unfold="1">Unfold all</button><button data-unfold="0">Fold all</button>
    </div>
    <p class="pt-note">${items.length} items in items.json. Click a category to open it; +1 drops one into the party pouch
    (potions, supplies and scrolls get a +5). Gold: ${game.gold}.</p>
    ${groups.map(([name, list]) => {
      const shown = list.filter(matches);
      if (q && !shown.length) return '';
      const open = q ? shown.length > 0 : chestOpen.has(name);
      return `<details data-group="${name}"${open ? ' open' : ''}>
        <summary class="eq-sec" style="cursor:pointer;margin-top:10px">${name} <span class="inv-stats">${shown.length}${q ? ` of ${list.length}` : ''}</span></summary>
        ${shown.map(row).join('')}
      </details>`;
    }).join('')}`;
  body.querySelector('[data-back]').onclick = () => renderPlaytest(game);
  const filter = body.querySelector('#pt-chest-filter');
  filter.oninput = () => { chestFilter = filter.value; const at = filter.selectionStart; renderItemChest(game); const f2 = document.getElementById('pt-chest-filter'); f2.focus(); f2.setSelectionRange(at, at); };
  for (const b of body.querySelectorAll('[data-unfold]')) {
    b.onclick = () => { chestOpen = b.dataset.unfold === '1' ? new Set(groups.map(([n]) => n)) : new Set(); renderItemChest(game); };
  }
  for (const det of body.querySelectorAll('details[data-group]')) {
    det.ontoggle = () => { if (det.open) chestOpen.add(det.dataset.group); else chestOpen.delete(det.dataset.group); };
  }
  for (const b of body.querySelectorAll('[data-give]')) {
    b.onclick = () => {
      const id = b.dataset.give, n = Number(b.dataset.n);
      const taken = game.addItem(id, n);
      const d = game.itemDef(id);
      game.log(taken > 0
        ? `TEST: ${taken}× ${d.name} appears in the party pouch.${taken < n ? ' (The rest would not fit — max_carry.)' : ''}`
        : `TEST: the pouch cannot hold another ${d.name} (max_carry ${d.max_carry}).`, 'info');
      renderItemChest(game);
      updateUI(game);
    };
  }
}

function monsterTierLabel(game, id) {
  if (game.data.dungeon.boss?.monster === id) return 'the boss floor';
  const spans = (game.data.dungeon.tiers || [])
    .filter(t => t.monsters?.[id])
    .map(t => `${t.floors[0]}–${t.floors[1]}`);
  return spans.length ? `floors ${spans.join(', ')}` : 'in no tier yet';
}

function renderPlaytest(game) {
  const body = document.getElementById('pt-body');
  const inDungeon = game.mode === 'dungeon';
  const levels = [1, 4, 5, 9, 10, 14, 15, 17, 18, 20];
  const monsters = Object.entries(game.data.monsters.monsters);
  body.innerHTML = `
    <div class="eq-sec">Experience — test the real leveling flow</div>
    <p class="pt-note">Banks enough XP for the next level(s): the gold ✚ appears and you
    take each level yourself on the character sheet (C or I) — HP roll, summary, forks and
    all. <b>Banked XP grants nothing by itself</b> — until the level is taken, the hero
    fights at their old strength.</p>
    <div class="pt-btnrow">
      <button data-grantxp="1">Ready to level ×1</button>
      <button data-grantxp="3">×3</button>
      <button data-grantxp="5">×5</button>
    </div>
    <div class="eq-sec" style="margin-top:16px">Jump straight to a level — now ${game.party.map(c => c.level).join(' / ')}</div>
    <div class="pt-stats">
      ${game.party.map(c => `<div class="pt-stat"><b>${c.name}</b> L${c.level} · HP ${c.hp}/${c.maxHp} · hit +${c.hitBase} · ${c.attacks}atk · AC ${c.ac}${c.maxSp ? ` · SP ${c.sp}/${c.maxSp}` : ''}${game.canLevel(c) ? ' · <i>✚ ready</i>' : ''}</div>`).join('')}
    </div>
    <p class="pt-note">Skips the leveling moments entirely (HP is simulated). Milestones:
    fork at 5 · signature move at 10 · capstone at 15 · refinement at 18. Dropping below a
    fork clears that choice so it can be re-tested — close this bench and the crossroads
    pops up. Every jump fully heals the living.</p>
    <div class="pt-btnrow">
      ${levels.map(n => `<button data-setlevel="${n}">${n}</button>`).join('')}
      <button data-dlevel="-1">−1</button>
      <button data-dlevel="1">+1</button>
    </div>
    <div class="eq-sec" style="margin-top:16px">Party care</div>
    <div class="pt-btnrow">
      <button data-heal>Heal &amp; revive everyone</button>
      <button data-gold>+1000 gold</button>
      <button data-chest>Open the item chest…</button>
    </div>
    <p class="pt-note">The item chest lists every item in items.json by category — drop any of them
    into the party pouch, then equip or drink from the character sheet (C).</p>
    <div class="eq-sec" style="margin-top:16px">Playstyle counters — ${game.party.map(c => Object.values(c.counters).join('·')).join(' / ')}</div>
    <p class="pt-note">The deeds that weigh the Rite's Title at level 20 (tiers at 0 / 5 / 15).
    Bump them here to test all three tiers; drop below level 20 to re-run a Rite.</p>
    <div class="pt-btnrow">
      <button data-counters="5">+5 to every counter</button>
      <button data-counters="15">+15</button>
    </div>
    <div class="eq-sec" style="margin-top:16px">Summon a fight${inDungeon ? '' : ' <span class="pt-warn">— dungeon only (you are in town)</span>'}</div>
    <p class="pt-note">Real monsters with real stakes: they grant XP, and if you flee they
    stay on the map. Summons count as a fight YOU started — the monsters begin
    <b>unaware</b> (💤), so stealth and Assassinate are testable here.</p>
    ${monsters.map(([id, m]) => `
      <div class="eq-pool-item">
        <span class="eq-pool-name">${m.name}
          <span class="inv-stats">HP ${m.hp} · AC ${m.ac} · hit +${m.to_hit} · ${m.damage} · ${monsterTierLabel(game, id)}</span></span>
        ${[1, 3, 5].map(n => `<button data-fight="${id}" data-count="${n}"${inDungeon ? '' : ' disabled'}>×${n}</button>`).join('')}
      </div>`).join('')}`;

  for (const b of body.querySelectorAll('[data-grantxp]')) {
    b.onclick = () => { game.debugGrantLevelXp(Number(b.dataset.grantxp)); renderPlaytest(game); };
  }
  for (const b of body.querySelectorAll('[data-setlevel]')) {
    b.onclick = () => { game.debugSetPartyLevel(Number(b.dataset.setlevel)); renderPlaytest(game); };
  }
  for (const b of body.querySelectorAll('[data-dlevel]')) {
    b.onclick = () => {
      const top = Math.max(...game.party.map(c => c.level));
      game.debugSetPartyLevel(top + Number(b.dataset.dlevel));
      renderPlaytest(game);
    };
  }
  body.querySelector('[data-heal]').onclick = () => { game.debugHealParty(); renderPlaytest(game); };
  body.querySelector('[data-chest]').onclick = () => renderItemChest(game);
  body.querySelector('[data-gold]').onclick = () => { game.debugGold(1000); renderPlaytest(game); };
  for (const b of body.querySelectorAll('[data-counters]')) {
    b.onclick = () => { game.debugAddCounters(Number(b.dataset.counters)); renderPlaytest(game); };
  }
  for (const b of body.querySelectorAll('[data-fight]')) {
    b.onclick = () => {
      if (game.debugFight(b.dataset.fight, Number(b.dataset.count))) togglePlaytest(game, false);
      else if (game.choiceQueue.length) togglePlaytest(game, false); // let the owed choice pop instead
    };
  }
}

// ---- Town buildings: shop, inn, temple (Phase 4) ----
export function buildingOpen() {
  return document.getElementById('building').style.display === 'block';
}

export function closeBuilding() {
  document.getElementById('building').style.display = 'none';
}

export function openBuilding(game, kind) {
  document.getElementById('building').style.display = 'block';
  if (kind === 'shop') audio.play('shop'); // the bell rings as you ENTER (2026-08-26); buying plays 'purchase'
  renderBuilding(game, kind);
}

const KEEPERS = { inn: 'assets/town/innkeep.png', shop: 'assets/town/shopkeep.jpg' };
const B_TITLES = { inn: 'The Inn', shop: 'The Shop', temple: 'The Temple', gate: 'The Dungeon Gate', stairs: 'The Stairs Up' };

function renderBuilding(game, kind) {
  const conf = game.data.town[kind] ?? {};
  document.getElementById('b-title').textContent = B_TITLES[kind];
  const keeper = document.getElementById('b-keeper');
  if (KEEPERS[kind]) { keeper.src = KEEPERS[kind]; keeper.style.display = 'block'; }
  else keeper.style.display = 'none';
  document.getElementById('b-welcome').textContent = conf.welcome ?? '';
  document.getElementById('b-gold').textContent = `Party gold: ${game.gold}`;
  const body = document.getElementById('b-body');
  body.innerHTML = '';
  const again = () => renderBuilding(game, kind);

  const row = (label, stats, btnText, disabledReason, act) => {
    const div = document.createElement('div');
    div.className = 'eq-pool-item';
    div.innerHTML = `<span class="eq-pool-name">${label}</span><span class="inv-stats">${stats}</span>`;
    const btn = document.createElement('button');
    btn.textContent = btnText;
    if (disabledReason) { btn.disabled = true; btn.title = disabledReason; }
    btn.addEventListener('click', () => { if (act() === 'close') { closeBuilding(); return; } again(); });
    div.appendChild(btn);
    body.appendChild(div);
    return div;
  };

  if (kind === 'inn') {
    row('A night for the whole party', 'full HP & spell points for the living', `Rest — ${conf.price} gold`,
      game.gold < conf.price ? 'Not enough gold.' : null, () => game.innRest());
  }

  // Express travel (designer ruling 2026-09-03): the gate and the stairs
  // offer the whole trip at once — time passes, nothing attacks.
  if (kind === 'gate') {
    const per = game.data.town.travel?.turns_per_floor ?? 10;
    row('Enter the dungeon', 'floor 1 — The Vermin Warrens', 'Descend', null, () => { game.gateDescend(1); return 'close'; });
    if ((game.deepest ?? 1) > 1) {
      row(`Straight down to depth ${game.deepest}`, `the deepest floor reached — ${(game.deepest - 1) * per} turns pass on the cleared stairs`, 'Descend', null, () => { game.gateDescend(game.deepest); return 'close'; });
    }
    if (game.portal) {
      row(`Through your portal — depth ${game.portal.depth}`, 'the scroll\'s sigil still burns: you arrive exactly where you left it', 'Step through', null, () => { game.gatePortal(); return 'close'; });
    }
  }
  if (kind === 'stairs') {
    const per = game.data.town.travel?.turns_per_floor ?? 10;
    const above = game.depth - 1;
    row('Climb one floor', `depth ${above}`, 'Climb', null, () => { game.enterFloor(above, 'up'); return 'close'; });
    row('Straight up to Novamagus', `${above} cleared floor${above === 1 ? '' : 's'} — ${above * per} turns pass, no fights`, 'Climb', null, () => { game.climbToTown(); return 'close'; });
  }

  if (kind === 'temple') {
    const fallen = game.party.filter(ch => !ch.alive);
    if (!fallen.length) {
      body.innerHTML = '<p class="inv-empty">The Light finds no one to call back. May it stay that way.</p>';
    }
    for (const ch of fallen) {
      row(ch.name, `Level ${ch.level} ${ch.race.name} ${ch.cls.name}`, `Revive — ${conf.price} gold`,
        game.gold < conf.price ? 'Not enough gold.' : null, () => game.templeRevive(ch));
    }
  }

  if (kind === 'shop') {
    const sale = document.createElement('div');
    sale.className = 'eq-sec';
    sale.textContent = 'For sale';
    body.appendChild(sale);
    for (const entry of game.shopStockEntries()) {
      const def = game.itemDef(entry.id);
      if (!def) continue; // unknown ids in town.json just don't appear
      const locked = (entry.at_depth ?? 0) > (game.deepest ?? 0);
      const el = row(def.name, itemStats(def), locked ? `Depth ${entry.at_depth}` : `Buy — ${def.value} gold`,
        locked ? `The shopkeep's finer stock waits on deeper deeds — reach dungeon depth ${entry.at_depth} (deepest so far: ${game.deepest ?? 0}).`
          : game.gold < (def.value ?? 0) ? 'Not enough gold.' : null, () => game.shopBuy(entry.id));
      if (locked) el.style.opacity = '0.45';
    }
    const sellHead = document.createElement('div');
    sellHead.className = 'eq-sec';
    sellHead.style.marginTop = '12px';
    sellHead.textContent = 'From the party pouch';
    body.appendChild(sellHead);
    const held = Object.entries(game.inventory).filter(([, n]) => n > 0);
    if (!held.length) body.insertAdjacentHTML('beforeend', '<p class="inv-empty">Nothing to sell.</p>');
    for (const [id, n] of held) {
      const def = game.itemDef(id);
      const price = Math.floor((def.value ?? 0) * (conf.sell_rate ?? 0.5));
      row(`${def.name} ×${n}`, itemStats(def),
        `Sell — ${price} gold`, null, () => game.shopSell(id));
    }
  }
}

// ---- The inventory screen ----
// Slots are laid out around the hero's figure: head above, hands at the
// sides, rings by the hands, boots at the feet — see #eq-doll grid areas.
const DOLL_SLOTS = [
  ['necklace', 'Necklace', '❧'], ['head', 'Head', '⛑'], ['armor', 'Armor', '🛡'],
  ['hand1', 'Main hand', '⚔'], ['hand2', 'Off hand', '✋'],
  ['ring1', 'Ring', '◌'], ['ring2', 'Ring', '◌'],
  ['cloak', 'Cloak', '🧥'], ['boots', 'Boots', '👢'],
];
let eqHeroIdx = 0;

export function equipmentOpen() {
  return document.getElementById('equipment').style.display === 'block';
}

export function toggleEquipment(game, show) {
  const panel = document.getElementById('equipment');
  const opening = show ?? !equipmentOpen();
  panel.style.display = opening ? 'block' : 'none';
  if (opening) renderEquipment(game);
}

function renderEquipment(game) {
  const ch = game.party[eqHeroIdx];

  // Portrait tabs down the side, Baldur's-Gate style.
  const tabs = document.getElementById('eq-tabs');
  tabs.innerHTML = '';
  game.party.forEach((hero, i) => {
    const btn = document.createElement('button');
    btn.className = 'eq-portrait' + (i === eqHeroIdx ? ' picked' : '') + (hero.alive ? '' : ' dead');
    btn.innerHTML = `<img src="${hero.alive ? game.heroPortrait(hero) : (hero.cls.sprite_dead || hero.cls.sprite)}" alt="">
      ${game.canLevel(hero) ? '<span class="level-cross" title="Ready to level up!">✚</span>' : ''}<span>${hero.name}</span>`;
    btn.addEventListener('click', () => { eqHeroIdx = i; renderEquipment(game); });
    tabs.appendChild(btn);
  });

  // The Rite-completed wear their sigil WITH the name — the mark of legend
  // belongs at the top of the sheet, not filed under a list of powers.
  const nameEl = document.getElementById('eq-name');
  if (ch.rite) {
    nameEl.innerHTML = `<canvas class="eq-name-sigil" width="52" height="52"></canvas><span>${ch.name} ${ch.rite.title}</span>`;
    drawSigil(game, nameEl.querySelector('canvas'), ch.rite.sigil, 52);
  } else {
    nameEl.textContent = ch.name;
  }
  document.getElementById('eq-stats').textContent =
    `Level ${ch.level} ${ch.race.name} ${game.displayClass(ch)} · AC ${ch.ac} · ${ch.weapon.name} ${ch.weapon.damage}${ch.maxSp ? ` · SP ${ch.sp}/${ch.maxSp}` : ''}`;

  // The six abilities, with the design-doc modifier beside each score. A
  // score raised by gear glows gold and NAMES the piece (the named-bonus rule).
  document.getElementById('eq-abilities').innerHTML =
    ['str', 'int', 'wis', 'dex', 'con', 'cha'].map(k => {
      const v = ch.abilities[k];
      const mod = abilityMod(v);
      const boosted = v !== (ch.baseAbilities?.[k] ?? v);
      const sources = boosted
        ? Object.values(ch.equipment).filter(Boolean).map(id => game.itemDef(id))
            .filter(d => d.abilities?.[k]).map(d => `+${d.abilities[k]} ${d.name}`).join(', ')
        : '';
      return `<div class="eq-ab"${sources ? ` title="${ch.baseAbilities[k]} rolled, ${sources}"` : ''}>` +
        `<b>${k.toUpperCase()}</b><span${boosted ? ' style="color:#e8c860"' : ''}>${v}</span>` +
        `<i>${mod >= 0 ? '+' : ''}${mod}</i>` +
        `${sources ? `<small style="display:block;font-size:9.5px;color:#e8c860">${sources}</small>` : ''}</div>`;
    }).join('');

  renderPath(game, ch);
  renderMagic(game, ch);

  // The road to the next level: an XP bar, and — when the hero has earned
  // it — the Level Up button. Taking a level rolls the class hit die.
  const xpDiv = document.getElementById('eq-xp');
  if (ch.level >= 20) {
    xpDiv.innerHTML = '<div class="eq-xp-max">Level 20 — the pinnacle of mortal skill</div>';
  } else {
    const need = game.xpToLevel(ch);
    xpDiv.innerHTML = `
      <div class="bar xp"><div class="fill" style="transform:scaleX(${Math.min(1, ch.xp / need)})"></div>
        <div class="bar-label">XP ${ch.xp} / ${need} to level ${ch.level + 1}</div></div>
      ${game.canLevel(ch) ? '<button id="eq-levelup">✚ Level up — roll for HP!</button>' : ''}`;
    document.getElementById('eq-levelup')?.addEventListener('click', () => {
      const summary = game.levelUp(ch);
      renderEquipment(game);
      if (summary) openLevelSummary(game, summary);
    });
  }

  // The doll: the hero stands in the middle, gear slots hug the body.
  // Click a filled slot to take the piece off.
  const doll = document.getElementById('eq-doll');
  doll.innerHTML = `<div class="eq-figure"><img src="${game.heroSprite(ch)}" alt="${ch.name}"></div>`;
  const twoHander = game.twoHanded(ch);
  for (const [slot, label, glyph] of DOLL_SLOTS) {
    const cell = document.createElement('div');
    cell.className = 'eq-slot' + (ch.equipment[slot] ? ' filled' : '');
    cell.style.gridArea = slot;
    const ghost = slot === 'hand2' && twoHander
      ? `<i class="eq-2h">(${twoHander.name})</i>` : `<i class="eq-glyph">${glyph}</i>`;
    const worn = ch.equipment[slot] ? game.itemDef(ch.equipment[slot]) : null;
    cell.innerHTML = `<b>${label}</b>${worn ? `${worn.name}<span>${gearStats(worn)}</span>` : ghost}`;
    if (worn) {
      cell.title = `Remove the ${worn.name} (back to the pouch)`;
      cell.addEventListener('click', () => { game.unequipItem(ch, slot); renderEquipment(game); });
    }
    doll.appendChild(cell);
  }

  // Potions: drunk by the hero whose page is open (drinking passes a turn).
  const potions = document.getElementById('eq-potions');
  const held = game.heldItems();
  const supplies = game.heldSupplies();
  potions.innerHTML = held.length || supplies.length ? '' : '<p class="inv-empty">No potions in the pouch.</p>';
  for (const it of held) {
    const row = document.createElement('div');
    row.className = 'eq-pool-item';
    const reason = game.itemBlockReason(it.def, ch);
    row.innerHTML = `
      <span class="eq-pool-name">${it.def.name} <span class="inv-count">×${it.count}</span></span>
      <span class="inv-stats">${it.def.description}</span>`;
    const btn = document.createElement('button');
    btn.textContent = 'Drink';
    if (reason) { btn.disabled = true; btn.title = reason; }
    btn.addEventListener('click', () => {
      game.useItemOnMap(it.id, ch);
      // A turn passes as they drink — the world may answer with a battle.
      if (game.battle) toggleEquipment(game, false);
      else renderEquipment(game);
    });
    row.appendChild(btn);
    potions.appendChild(row);
  }
  // Camp supplies ride along here — nothing to click, just the count.
  for (const it of supplies) {
    const row = document.createElement('div');
    row.className = 'eq-pool-item';
    row.innerHTML = `
      <span class="eq-pool-name">${it.def.name} <span class="inv-count">×${it.count}${it.def.max_carry ? `/${it.def.max_carry}` : ''}</span></span>
      <span class="inv-stats">${it.def.description}</span>`;
    potions.appendChild(row);
  }

  // The pool: party gear this hero could put on.
  document.getElementById('eq-gold').textContent = `Party gear — Gold: ${game.gold}`;
  const pool = document.getElementById('eq-pool');
  const gear = game.heldGear();
  pool.innerHTML = gear.length ? '' : '<p class="inv-empty">No gear in the party pouch.</p>';
  for (const it of gear) {
    const row = document.createElement('div');
    row.className = 'eq-pool-item';
    const reason = game.gearBlockReason(it.def, ch);
    row.innerHTML = `
      <span class="eq-pool-name">${it.def.name} <span class="inv-count">×${it.count}</span></span>
      <span class="inv-stats">${gearStats(it.def)}</span>`;
    const btn = document.createElement('button');
    btn.textContent = 'Equip';
    if (reason) { btn.disabled = true; btn.title = reason; }
    btn.addEventListener('click', () => { game.equipItem(it.id, ch); renderEquipment(game); });
    row.appendChild(btn);
    pool.appendChild(row);
  }
}

// ---- The level-up moment chain ----
// Taking a level plays out as a sequence, all with ONE hero before the
// player touches anyone else: the summary (what changed), then any choices
// they're owed (lane fork → weapon focus → the Rite), then a full narrated
// card for each automatic milestone (signature move, capstone, refinement).
let lvFlow = null; // {game, s, choicesDone, cards, idx}

export function levelupOpen() {
  return document.getElementById('levelup').style.display === 'flex';
}

function hideLevelPanel() {
  const root = document.getElementById('levelup');
  root.style.display = 'none';
  root.innerHTML = '';
}

// Called from main.js (Enter/Space/Esc) and the Onward buttons alike.
export function dismissLevelup(game) {
  advanceLevelFlow(game);
}

function advanceLevelFlow(game) {
  hideLevelPanel();
  const f = lvFlow;
  if (!f) { refreshSheet(game); return; }
  if (!f.choicesDone) {
    f.choicesDone = true;
    f.cards = f.s.milestones.filter(m => ['verb', 'capstone', 'refinement', 'spelltier', 'slot', 'revelation'].includes(m.kind));
    f.idx = 0;
    openChoicesFor(game, f.s.ch, () => showNextCard(game));
    return;
  }
  showNextCard(game);
}

function showNextCard(game) {
  const f = lvFlow;
  if (!f || f.idx >= f.cards.length) {
    lvFlow = null;
    refreshSheet(game);
    return;
  }
  renderMilestoneCard(game, f.s.ch, f.cards[f.idx++]);
}

function refreshSheet(game) {
  if (equipmentOpen()) renderEquipment(game);
}

function openLevelSummary(game, s) {
  const ch = s.ch;
  const root = document.getElementById('levelup');
  const conBit = s.conMod ? ` ${s.conMod > 0 ? '+' : '−'} ${Math.abs(s.conMod)} CON` : '';
  const rows = [
    ['Hit points', `${s.before.maxHp} → ${ch.maxHp}`, `rolled ${s.rolled} on the d${ch.cls.hp_die}${s.rerolled ? ' (a 1 — rerolled!)' : ''}${conBit} = +${s.hpGain}`],
  ];
  if (ch.hitBase !== s.before.hitBase) rows.push(['To-hit bonus', `+${s.before.hitBase} → +${ch.hitBase}`, 'blows land more often']);
  if (ch.attacks !== s.before.attacks) rows.push(['Attacks per round', `${s.before.attacks} → ${ch.attacks}`, 'more strikes every turn']);
  if (ch.ac !== s.before.ac) rows.push(['Armor class', `${s.before.ac} → ${ch.ac}`, 'harder to hit']);
  if (ch.maxSp !== s.before.maxSp) rows.push(['Spell points', `${s.before.maxSp} → ${ch.maxSp}`, 'more magic to spend']);
  lvFlow = { game, s, choicesDone: false };
  root.style.display = 'flex';
  root.innerHTML = `
    <div class="cr-panel lv-panel">
      <div class="cr-step">Level ${ch.level}!</div>
      <div class="ch-head"><img src="${game.heroPortrait(ch)}" alt="">
        <div><b>${ch.name}</b> grows in skill and legend.</div></div>
      <table class="lv-table">
        ${rows.map(([what, change, note]) => `
          <tr><td>${what}</td><td class="lv-change">${change}</td><td class="lv-note">${note}</td></tr>`).join('')}
      </table>
      ${s.milestones.map(m => `<p class="lv-milestone">✦ ${m.text}</p>`).join('')}
      <button id="lv-close">Onward</button>
    </div>`;
  document.getElementById('lv-close').onclick = () => advanceLevelFlow(game);
}

// What each engine power actually feels like at the table — shown on the
// milestone cards so the player knows HOW to use what they just gained.
const POWER_HOW = {
  rampage: 'It happens in the thick of battle: fell a foe with a melee swing and you strike again, free, at another foe in reach — and kills chain onward.',
  guardians_stand: "It's a reaction: when a blow is about to land on an ally, the battle pauses and asks. Y takes the hit yourself; N lets it fall.",
  rage: 'Open the C menu in battle and choose it — trade your guard for fury.',
  bulwark: 'Always on: allies standing beside you gain armor. And Taunt joins the C menu — bellow, and enemies come for YOU.',
  assassinate: 'It happens on its own: strike a foe marked "unaware" (start fights yourself, or Vanish first) and the blow is an automatic critical.',
  vanish: 'Open the C menu in battle and choose it — you disappear, monsters lose you entirely, and your next strike lands as an Assassinate.',
  lethality: 'Automatic, but demanding: Assassinate now doubles its damage, and only triggers when no other party member stands beside the mark.',
  set_trap: 'Joins the C menu: aim at a nearby empty square and roll your trap skill. The first monster to step there springs it.',
  arcane_insight: 'Joins the C menu, once per battle: spend your action to read the fight and pick an edge — to-hit, save DC, or spell damage — that lasts the whole encounter.',
  overcast: "A stance in the C menu, free to flip: while it burns, damage and healing spells cost extra SP and strike one level harder. Watch the menu's costs change.",
  mercy: 'It happens on its own: the instant an ally is cut to 0 HP, they rise again with 1d8 + your WIS. Every single time, free.',
  zealous_strike: 'A stance in the C menu, free to flip: while it burns, every melee hit you land spends SP for bonus divine damage — and heals you a little.',
  archmage: 'In battle, the C menu now lists your UNPREPARED spells too — casting one spends every spell point you have. Once per rest.',
  twin_surge: 'Joins the C menu, once per rest: arm it, then cast — the spell resolves twice, and the backlash costs you your next turn.',
  miracle: 'Joins the C menu, once per rest: every remaining spell point at once — the living are healed to full, the fallen rise at half.',
  divine_inspiration: 'Joins the C menu: every remaining spell point at once (5 minimum) buys +3 hit, +3 damage, +3 AC for 3 rounds.',
  runic_riposte: "It happens on its own: whenever a monster's melee blow lands on you (even one your wards soak), you strike straight back — free, every time. Stand beside your foes.",
  ward_surge: "It's a reaction: as a foe swings at you, the battle pauses and asks. Y spends the SP for +4 AC and saves against that one blow; N lets the die roll as it will.",
  unyielding: 'It happens on its own: any blow that would drop you to 0 HP leaves you at 1 instead. Poison and spellfire are not blows — mind them.',
  shared_fortitude: 'Joins the C menu: aim at an ally and spend the SP — they gain a pool of absorbed damage that drinks blows first, all battle long.',
  whirling_verse: "Open the C menu and choose it — it takes EVERY spell point you have left and ends your Stance, and for 3 rounds every landed hit strikes again. An all-in gamble: when it ends you have nothing.",
  mirror_ward: 'Open the C menu and choose it — for 3 rounds half of every wound flies back at the attacker, but you cannot move. Plant yourself where they must come.',
  mountains_heart: 'Open the C menu and choose it — for 3 rounds wounds are halved, but your hit/damage bonus is nothing and you cannot move. Hold a doorway; let others swing.',
  deep_roots: 'Joins the C menu, once per rest: raise your wards FIRST, then spend every spell point to spread them across the whole party for 3 rounds.',
  hunters_surge: "A stance in the C menu, free to flip: while it burns, each attack action spends SP and your off-hand blade swings as many times as your main hand. Needs two one-handed weapons in hand (E).",
  volley: 'It happens on its own: drop a foe with a bow shot and another arrow flies free at the nearest foe in range — kills chain while the quiver holds.',
  storm_of_blades: 'Open the C menu and choose it — every spell point at once buys 3 rounds where every main-hand hit earns a free off-hand strike with no penalty, +2 damage on everything.',
  rain_of_arrows: 'Open the C menu with a bow in hand — for 3 rounds every shot also strikes each foe beside its target (one arrow each), but you cannot move. Find a line and hold it.',
};

function renderMilestoneCard(game, ch, m) {
  const lane = laneOf(game.data, ch);
  const root = document.getElementById('levelup');
  let step = '', headline = '', power = null, how = '';
  if (m.kind === 'verb') {
    step = `Level ${lane.verb.level} — a signature move`;
    headline = `The ${lane.name} bares its teeth. <b>${ch.name}</b> learns <b>${lane.verb.name}</b>.`;
    power = lane.verb;
    how = POWER_HOW[lane.verb.id] ?? '';
  } else if (m.kind === 'capstone') {
    step = `Level ${lane.capstone.level} — a name earned`;
    headline = `The road has remade the walker. From this day, <b>${ch.name}</b> is a <b>${lane.archetype ?? lane.capstone.name}</b> — and gains <b>${lane.capstone.name}</b>.`;
    power = lane.capstone;
    how = POWER_HOW[lane.capstone.id] ?? '';
  } else if (m.kind === 'spelltier') {
    step = `Level ${ch.level} — deeper magic`;
    headline = `The veil thins. <b>${ch.name}</b> can now reach <b>level-${m.tier} spells</b>.`;
    const model = magicModel(game.data, ch);
    power = { name: `Level-${m.tier} spells`, blurb: `Cost ${m.tier * 2 + 1} SP each (level × 2 + 1). ${model === 'spellbook' ? 'Your studies can reach them now — and any scroll of that level can be copied in.' : model === 'known' ? 'New picks are owed — choose which spells join the blood.' : model === 'lane' ? 'The verse of that level is already in hand — see the character sheet.' : 'Every new prayer of your training is already in hand — see the character sheet.'}` };
    how = '';
  } else if (m.kind === 'slot') {
    step = `Level ${ch.level} — a fuller mind`;
    headline = `<b>${ch.name}</b> can hold more at once: <b>${m.slots} prepared spells</b>.`;
    power = { name: `${m.slots} prepared at a time`, blurb: 'Pick which pages are ready each morning on the character sheet (C) — the window opens at every full rest.' };
    how = '';
  } else if (m.kind === 'revelation') {
    const sp = game.data.spells.spells[m.spell];
    step = m.lane ? `Level ${ch.level} — a new verse` : `Level ${ch.level} — a revelation`;
    headline = m.lane
      ? `The road teaches its own songs. <b>${ch.name}</b> now knows <b>${sp?.name ?? m.spell}</b>.`
      : `In the quiet after prayer, a word arrives unbidden. <b>${ch.name}</b> now knows <b>${sp?.name ?? m.spell}</b> — a prayer no book teaches.`;
    power = { name: sp?.name ?? m.spell, blurb: `${sp?.description ?? ''} (${spellMetaLine(game, ch, { id: m.spell, ...sp })})` };
    how = `It joins the C menu in battle like any prayer, castable from ${unlockLevel(sp?.level ?? 1) <= ch.level ? 'now' : `character level ${unlockLevel(sp?.level ?? 1)}`}.`;
  } else if (m.kind === 'refinement') {
    step = 'Level 18 — mastery';
    headline = `Ten thousand repetitions have honed <b>${lane.verb?.name ?? 'the signature move'}</b> to its final edge.`;
    power = { name: lane.refinement.name ?? `${lane.verb?.name ?? 'Refinement'}, perfected`, blurb: lane.refinement.blurb };
    how = '';
  }
  root.style.display = 'flex';
  root.innerHTML = `
    <div class="cr-panel lv-panel">
      <div class="cr-step">${step}</div>
      <div class="ch-head"><img src="${game.heroPortrait(ch)}" alt=""><div>${headline}</div></div>
      ${power ? `<div class="rt-power"><b>${power.name}</b><span>${power.blurb ?? ''}</span></div>` : ''}
      ${how ? `<p class="lv-how">${how}</p>` : ''}
      <button id="lv-close">Onward</button>
    </div>`;
  document.getElementById('lv-close').onclick = () => advanceLevelFlow(game);
}

// Path & Powers: the hero's lane, everything it has granted, and everything
// still ahead (greyed, with its level). Classes without a progression entry
// simply don't show the section.
function renderPath(game, ch) {
  const panel = document.getElementById('eq-path');
  const prog = classProg(game.data, ch);
  if (!prog) { panel.innerHTML = ''; panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  const lane = laneOf(game.data, ch);
  const row = (unlocked, name, blurb, note) => `
    <div class="eq-power${unlocked ? '' : ' locked'}">
      <b>${name}</b>${note ? `<i>${note}</i>` : ''}<span>${blurb ?? ''}</span>
    </div>`;
  let rows = '';
  const gift = giftOf(ch);
  if (gift) rows += row(true, gift.name, `${gift.blurb ?? ''}${ch.gift?.element ? ` Sworn against ${ch.gift.element}.` : ''}`, 'creation gift');
  if (ch.cls.scouting) rows += row(true, ch.cls.scouting.name ?? 'Scouting', `${ch.cls.scouting.blurb ?? ''} (${game.scoutChance(ch)}% now)`, 'class');
  if (ch.cls.favored_enemy) {
    const fav = Object.entries(ch.favored ?? {});
    const next = (ch.cls.favored_enemy.levels ?? []).find(l => l > ch.level);
    rows += row(fav.length > 0, 'Favored enemies', fav.length ? fav.map(([f, n]) => `+${n} vs ${f}`).join(', ') : 'none yet',
      favoredPicksOwed(ch) ? 'a pick awaits!' : next ? `next at level ${next}` : '');
  }
  if (!lane) {
    rows = rows + row(false, 'A crossroads', `At level ${prog.fork_level}, the ${ch.cls.name}'s road forks — two paths, one choice, forever.`,
      ch.level >= prog.fork_level ? 'awaits!' : `at level ${prog.fork_level}`);
  } else {
    rows += row(true, lane.name, lane.blurb);
    // Lane growth: what this hero chose to become (Path & Powers panel).
    for (const o of growthPicks(game.data, ch)) {
      rows += row(true, o.name, o.blurb ?? '');
    }
    if (lane.passive) {
      rows += row(true, passiveBlurb(lane.passive).split(':')[0],
        passiveBlurb(lane.passive).split(': ')[1] + (focusList(game.data, ch).length
          ? ` — ${focusList(game.data, ch).map(g => focusName(game.data, g)).join(', ')}`
          : ''));
    }
    if (lane.verb) {
      const has = ch.level >= lane.verb.level;
      rows += row(has, lane.verb.name, lane.verb.blurb, has ? '' : `at level ${lane.verb.level}`);
    }
    if (lane.capstone) {
      const has = ch.level >= lane.capstone.level;
      rows += row(has, lane.capstone.name, `${lane.capstone.blurb ?? ''}${lane.archetype ? ` The ${ch.cls.name} becomes the ${lane.archetype}.` : ''}`,
        has ? '' : `at level ${lane.capstone.level}`);
    }
    if (lane.refinement) {
      const has = ch.level >= lane.refinement.level;
      rows += row(has, `${lane.verb?.name ?? 'Refinement'}, perfected`, lane.refinement.blurb, has ? '' : `at level ${lane.refinement.level}`);
    }
    if (lane.rite) {
      if (ch.rite) {
        rows += row(true, ch.rite.abilityName, `${lane.rite.ability.blurb ?? ''}`, 'the Rite');
        rows += row(true, `Sigil: the ${ch.rite.sigil.modifier} ${ch.rite.sigil.shape}`, `Wrought in ${ch.rite.sigil.color.toLowerCase()} — worn beside the name above. Known to all as ${ch.name} ${ch.rite.title} (tier ${ch.rite.tier + 1}).`);
      } else {
        rows += row(false, 'The Rite', 'At the height of mortal skill, something answers.', ch.level >= 20 ? 'awaits!' : 'at level 20');
      }
      // The tracked deed that will one day weigh the Title.
      if (lane.verb && ch.level >= lane.verb.level) {
        const label = {
          rampageKills: 'Foes felled in Rampage',
          standSaves: 'Blows taken for allies',
          assassinateKills: 'Marks slain by Assassinate',
          shadowFeats: 'Vanishes & traps set',
          bookCasts: 'Book-casts outside preparation',
          overcasts: 'Overcasts landed',
          mercySaves: 'Allies caught by Mercy',
          zealousStrikes: 'Zealous Strikes landed',
          riposteKills: 'Foes felled by Runic Riposte',
          wardDeflects: 'Blows turned or reflected',
          unyieldingSaves: 'Falls refused by Unyielding',
          alliesFortified: 'Allies fortified & sheltered',
          surgeKills: "Kills under Hunter's Surge / the Storm",
          volleyKills: 'Foes felled by Volley',
        }[lane.rite.tracked] ?? lane.rite.tracked;
        rows += `<div class="eq-power tally"><b>${label}</b><span>${ch.counters?.[lane.rite.tracked] ?? 0}${ch.rite ? '' : ' — deeds weigh the Title at level 20'}</span></div>`;
      }
    }
  }
  panel.innerHTML = `<div class="eq-sec">Path &amp; powers</div>${rows}`;
}

// ---- Magic on the character sheet: a summary, and the door to the Spellbook screen (B) ----
function renderMagic(game, ch) {
  const panel = document.getElementById('eq-magic');
  const model = magicModel(game.data, ch);
  const known = knownSpells(game.data, ch);
  const scrolls = Object.values(game.inventory).length && Object.entries(game.inventory)
    .filter(([id, n]) => n > 0 && game.itemDef(id)?.type === 'scroll').reduce((sum, [, n]) => sum + n, 0);
  if (!known.length && !ch.maxSp && !scrolls) {
    panel.innerHTML = '';
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  let line = '';
  if (model === 'spellbook') {
    const slots = preparedSlots(game.data, ch);
    const study = studiesOwed(game.data, ch);
    line = `${known.length} page${known.length === 1 ? '' : 's'} · ${ch.prepared.length}/${slots} prepared${ch.prepFresh ? ' · <i>rested: re-pick freely</i>' : ''}${study.remaining ? ` · <i>a study is owed</i>` : ''}`;
  } else if (model === 'known') {
    line = `${known.length} spell${known.length === 1 ? '' : 's'} in the blood · Overchannel counted in each cost`;
  } else if (model === 'lane') {
    const held = activeStances(ch).map(b => b.name);
    line = `${known.length} verse${known.length === 1 ? '' : 's'} of ${laneOf(game.data, ch)?.name ?? 'the road before the fork'} · ${held.length ? `<b>${held.join(' & ')}</b> held until the next rest` : 'no Stance held — sing one from the spellbook (B)'}`;
  } else if (known.length) {
    line = `${known.length} prayer${known.length === 1 ? '' : 's'} of ${ch.name}'s training`;
  }
  if (scrolls) line += `${line ? ' · ' : ''}${scrolls} scroll${scrolls === 1 ? '' : 's'} in the pouch`;
  panel.innerHTML = `<div class="eq-sec">Magic</div><p class="pt-note" style="margin:2px 0 4px">${line}</p>
    <button class="sb-open" data-open-book>Open the spellbook (B)</button>`;
  panel.querySelector('[data-open-book]').onclick = () => flipToBook(game);
}

// ---- The Spellbook screen (B) ----
// A caster's whole magic in one place: pages grouped by spell level, the
// day's preparation (spellbook model), the Sorcerer's blood-list, the
// Priest's prayers and revelations, scrolls in the pouch, once-per-rest
// powers, and what is still owed (study, picks).
let sbHeroIdx = 0;

export function spellbookOpen() {
  return document.getElementById('spellbook').style.display === 'block';
}

function isCaster(game, ch) {
  return ch.maxSp > 0 || knownSpells(game.data, ch).length > 0 || !!ch.cls.spellbook;
}

// Flip between the two screens keeping the same hero in view.
export function flipToSheet(game) { eqHeroIdx = sbHeroIdx; toggleSpellbook(game, false); toggleEquipment(game, true); }
export function flipToBook(game) { sbHeroIdx = eqHeroIdx; toggleEquipment(game, false); toggleSpellbook(game, true); }

export function toggleSpellbook(game, show) {
  const panel = document.getElementById('spellbook');
  const opening = show ?? !spellbookOpen();
  if (opening && !game.party.some(ch => isCaster(game, ch))) {
    game.log('Nobody in the party works magic — no spellbook to open.', 'info');
    return;
  }
  panel.style.display = opening ? 'block' : 'none';
  if (opening) renderSpellbook(game);
}

function renderSpellbook(game) {
  const casters = game.party.map((ch, i) => [ch, i]).filter(([ch]) => isCaster(game, ch));
  if (!casters.some(([, i]) => i === sbHeroIdx)) sbHeroIdx = casters[0][1];
  const ch = game.party[sbHeroIdx];
  const model = magicModel(game.data, ch);
  const tier = maxSpellLevel(ch.level);
  const known = knownSpells(game.data, ch);

  // Portrait tabs — casters only.
  const tabs = document.getElementById('sb-tabs');
  tabs.innerHTML = '';
  for (const [hero, i] of casters) {
    const btn = document.createElement('button');
    btn.className = 'eq-portrait' + (i === sbHeroIdx ? ' picked' : '') + (hero.alive ? '' : ' dead');
    btn.innerHTML = `<img src="${hero.alive ? game.heroPortrait(hero) : (hero.cls.sprite_dead || hero.cls.sprite)}" alt=""><span>${hero.name}</span>`;
    btn.addEventListener('click', () => { sbHeroIdx = i; renderSpellbook(game); });
    tabs.appendChild(btn);
  }

  document.getElementById('sb-name').textContent = model === 'spellbook' ? `${ch.name}'s Spellbook`
    : model === 'known' ? `${ch.name} — the Raw Gift` : model === 'lane' ? `${ch.name}'s Verses` : `${ch.name}'s Prayers`;
  const slots = model === 'spellbook' ? preparedSlots(game.data, ch) : 0;
  document.getElementById('sb-stats').innerHTML =
    `Level ${ch.level} ${game.displayClass(ch)} · SP ${ch.sp}/${ch.maxSp} · spells up to level ${tier}` +
    (model === 'spellbook' ? ` · <b>${ch.prepared.length}/${slots} prepared</b> — ${ch.prepFresh ? '<i>rested: re-pick freely until the next fight</i>' : 'set for the day; a full rest reopens the choice'}` : '') +
    (model === 'known' ? ` · Overchannel: every cast 1 SP cheaper` : '');

  // Pages by level.
  const byLevel = {};
  for (const s of known) (byLevel[s.level] ??= []).push(s);
  let pages = '';
  for (let lvl = 1; lvl <= 5; lvl++) {
    const list = byLevel[lvl] ?? [];
    const unlockAt = unlockLevel(lvl);
    const deep = lvl > tier;
    if (!list.length && deep) continue; // nothing to say about a level not yet reached
    const stanceLvl = model === 'lane' && list.length && list.every(s => s.stance);
    pages += `<div class="sb-level"><div class="eq-sec">Level ${lvl} spells<span>${stanceLvl ? `Stance — ${list[0].stance} SP, until the next full rest` : `${spellCost(game.data, ch, { level: lvl })} SP each`}${deep ? ` · castable at character level ${unlockAt}` : ''}${model === 'spellbook' && !deep && !list.length ? ' · no pages yet' : ''}</span></div>`;
    if (!list.length) pages += `<div class="sb-page"><small>${model === 'spellbook' ? 'Study or a scroll will fill this level.' : model === 'known' ? 'No spell of this level in the blood.' : model === 'lane' ? (ch.lane ? 'No verse of this level.' : 'The road forks at level 5 — the lane decides the verses.') : 'Nothing of this level.'}</small></div>`;
    for (const s of list) {
      const prepped = model === 'spellbook' && ch.prepared.includes(s.id);
      let btn = '';
      if (model === 'lane' && s.stance) {
        // v1.1: a Stance is sung from here, on the map — held until the next full rest.
        const cost = spellCost(game.data, ch, s);
        const targets = s.targets === 'ally' ? game.party.filter(c => c.alive) : [ch];
        btn = '<div class="sb-stance">' + targets.map(t => {
          const idx = game.party.indexOf(t);
          const held = activeStances(t).some(b => b.spell === s.id);
          const label = s.targets === 'ally' ? (held ? `${t.name}: held` : `over ${t.name}`) : (held ? 'Held till the next rest' : `Sing it — ${cost} SP`);
          const why = held ? `${s.name} already holds on ${t.name} until the next full rest.` : game.battle ? 'In battle, sing it from the C menu.' : ch.sp < cost ? `Costs ${cost} SP — ${ch.name} has ${ch.sp}.` : !ch.alive ? `${ch.name} has fallen.` : '';
          return `<button data-stance="${s.id}" data-target="${idx}"${why ? ` disabled title="${why.replace(/"/g, '&quot;')}"` : ` title="${cost} SP, one map turn — lasts until the next full rest"`}>${label}</button>`;
        }).join('') + '</div>';
      }
      if (model === 'spellbook') {
        btn = deep
          ? `<button disabled title="A level-${s.level} spell — beyond ${ch.name}'s reach until character level ${unlockAt}.">too deep</button>`
          : prepped
            ? `<button data-unprep="${s.id}"${ch.prepFresh ? '' : ' disabled title="Preparation is set for the day — rest to re-pick."'}>Set aside</button>`
            : `<button data-prep="${s.id}"${ch.prepFresh ? (ch.prepared.length >= slots ? ' disabled title="Every slot is full — set another aside first."' : '') : ' disabled title="Preparation is set for the day — rest to re-pick."'}>Prepare</button>`;
      }
      pages += `<div class="sb-page${prepped ? ' prepared' : ''}${deep ? ' deep' : ''}">
        <div class="sb-page-main"><b>${prepped ? '✦ ' : model !== 'spellbook' && s.rare ? '✧ ' : ''}${s.name}</b>${s.rare ? ` <span class="inv-stats">${model === 'spellbook' ? 'scroll-lore' : model === 'known' ? 'from the old book' : 'a revelation'}</span>` : ''}
          <small>${s.description}</small><small>${spellMetaLine(game, ch, s)}</small></div>${btn}</div>`;
    }
    pages += '</div>';
  }
  if (!known.length) pages = `<p class="pt-note">${model === 'spellbook' ? 'The book is empty.' : 'No spells yet.'}</p>`;
  document.getElementById('sb-pages').innerHTML = pages;

  // The side column: what is owed, scrolls, once-per-rest powers.
  let side = '';
  if (model === 'spellbook') {
    const study = studiesOwed(game.data, ch);
    const sb = ch.cls.spellbook ?? {};
    const nextStudy = (sb.study_levels ?? []).find(l => l > ch.level);
    const nextSlot = (sb.extra_slot_levels ?? []).find(l => l > ch.level);
    side += `<div class="eq-sec">Study</div><p class="pt-note">${study.remaining
      ? (study.options.length ? `<b>${study.remaining} page${study.remaining > 1 ? 's' : ''} owed</b> — the choice opens on the map.` : `${study.remaining} study pick${study.remaining > 1 ? 's' : ''} banked: every common spell of reach is already inked; the next spell level will open new pages.`)
      : `Nothing owed.`}${nextStudy ? ` Next study at level ${nextStudy}.` : ''}${nextSlot ? ` One more prepared slot at level ${nextSlot}.` : ''}
      Rarer lore is never studied — it comes only on scrolls.</p>`;
  } else if (model === 'known') {
    const picks = spellPicksOwed(game.data, ch);
    const bonus = bonusPicksOwed(game.data, ch);
    const p = passiveOf(game.data, ch);
    const nextBonus = (p?.bonus_pick_levels ?? []).find(l => l > ch.level);
    side += `<div class="eq-sec">The blood</div><p class="pt-note">${picks.length || bonus.remaining ? '<b>A pick is owed</b> — it arrives on the map.' : 'No pick owed.'} Two spells per spell level as each unlocks${nextBonus ? `, and a wild pick of any level at ${nextBonus}` : ''}. Chosen is chosen. No scrolls copy in — but ${ch.name} may still read one in battle.</p>`;
    if (ch.formerBook?.length) side += `<p class="pt-note">The old book (set aside at the fork): ${ch.formerBook.map(id => game.data.spells.spells[id]?.name ?? id).join(', ')} — its pages may still be chosen.</p>`;
  } else if (model === 'lane') {
    const lane = laneOf(game.data, ch);
    const prog = classProg(game.data, ch);
    const held = activeStances(ch).map(b => b.name);
    side += `<div class="eq-sec">The verses</div><p class="pt-note">${lane
      ? `${lane.name}'s verses open on their own as each spell level does — no book, no study, no picks.`
      : `Before the fork ${ch.name} knows ${giftOf(ch)?.spell ? 'only the creation gift' : 'the first verse'}; at level ${prog?.fork_level ?? 5} the lane decides the rest (a Stance the lane does not sing is swapped free).`}</p>
      <div class="eq-sec" style="margin-top:12px">Stance &amp; Surge</div><p class="pt-note">The level-1 verse is a <b>Stance</b>: a flat 1 SP, sung here on the map or in battle, and held through every fight until the next full rest (camp or inn). Every deeper verse is a <b>Surge</b> at the usual cost (level × 2 + 1) for one fight or a few rounds — hoard the points for the battle that needs them.${held.length ? ` <b>Held now: ${held.join(' & ')}.</b>` : ''}</p>`;
  } else {
    const rl = ch.cls.revelation_levels ?? {};
    const next = Object.entries(rl).map(([l, at]) => [Number(l), at]).filter(([, at]) => at > ch.level).sort((a, b) => a[1] - b[1])[0];
    side += `<div class="eq-sec">Grace</div><p class="pt-note">Every common prayer of ${ch.name}'s training is known the moment its level opens. Rare prayers arrive as revelations${next ? ` — the next at level ${next[1]}` : ''}.</p>`;
  }

  // Scrolls in the pouch.
  const scrolls = Object.entries(game.inventory)
    .filter(([id, n]) => n > 0 && game.itemDef(id)?.type === 'scroll')
    .map(([id, n]) => ({ id, def: game.itemDef(id), count: n }));
  side += `<div class="eq-sec" style="margin-top:12px">Scrolls in the pouch</div>`;
  if (!scrolls.length) side += `<p class="pt-note">None. Scrolls turn up in chests and vaults, and Novamagus sells the simplest.</p>`;
  for (const sc of scrolls) {
    const spell = game.data.spells.spells[sc.def.spell];
    const already = model === 'spellbook' && spell && ch.spellbook.includes(sc.def.spell);
    const reason = spell && spellSchool(spell) !== 'arcane'
      ? `A prayer-scroll takes no ink — it is voiced, once, by a divine caster.`
      : model !== 'spellbook'
        ? `Only a spellbook holds a scroll's lore — ${ch.name} keeps none.`
        : already ? `${spell.name} is already inked in the book.` : null;
    const readNote = spell ? (scrollReadable(game.data, ch, spell) ?? `${ch.name} can read it in battle (I) — once, for no SP`) : '';
    side += `<div class="sb-page"><div class="sb-page-main"><b>${sc.def.name}</b> <span class="inv-count">×${sc.count}</span>
        <small>${spell ? `${spell.description} — ${spellMetaLine(game, ch, { id: sc.def.spell, ...spell })}` : `names an unknown spell "${sc.def.spell}"`}</small>
        <small>${readNote}</small></div>
      <button data-copy="${sc.id}"${reason ? ` disabled title="${reason.replace(/"/g, '&quot;')}"` : ''}>Copy into book</button></div>`;
  }

  // Once-per-rest powers: say plainly whether they are ready or spent.
  const lane = laneOf(game.data, ch);
  if (lane?.capstone && ch.level >= lane.capstone.level && ['archmage', 'twin_surge', 'miracle'].includes(lane.capstone.id)) {
    const key = lane.capstone.id;
    side += `<div class="eq-sec" style="margin-top:12px">Once per rest</div><p class="pt-note">${lane.capstone.name ?? key}: ${ch.spentRest?.[key] ? 'spent — it returns with a night\'s rest' : 'ready'}.</p>`;
  }
  side += `<p style="margin-top:14px"><button class="sb-open" data-open-sheet>Character sheet (C)</button></p>`;
  const sideEl = document.getElementById('sb-side');
  sideEl.innerHTML = side;
  // The footer speaks to the hero on screen — a priest is never told to prepare pages.
  document.getElementById('sb-foot').innerHTML = (model === 'spellbook'
    ? 'Prepare pages after a full rest &middot; scrolls copy in here and are read in battle (I) &middot; '
    : model === 'known' ? 'Chosen is chosen &middot; scrolls are read in battle (I) &middot; '
      : model === 'lane' ? 'The lane decides the verses &middot; each opens with its spell level &middot; '
        : 'Every prayer is ready the moment its level opens &middot; ')
    + 'B or Esc closes &middot; C — character sheet';

  const root = document.getElementById('spellbook');
  for (const b of root.querySelectorAll('[data-prep]')) {
    b.onclick = () => {
      if (ch.prepared.length < preparedSlots(game.data, ch)) ch.prepared.push(b.dataset.prep);
      renderSpellbook(game);
    };
  }
  for (const b of root.querySelectorAll('[data-unprep]')) {
    b.onclick = () => { ch.prepared = ch.prepared.filter(id => id !== b.dataset.unprep); renderSpellbook(game); };
  }
  for (const b of root.querySelectorAll('[data-copy]')) {
    b.onclick = () => { game.copyScroll(b.dataset.copy, ch); renderSpellbook(game); };
  }
  for (const b of root.querySelectorAll('[data-stance]')) {
    b.onclick = () => { game.castStance(ch, b.dataset.stance, game.party[Number(b.dataset.target)]); renderSpellbook(game); };
  }
  sideEl.querySelector('[data-open-sheet]').onclick = () => flipToSheet(game);
}

// ---- Marching order (O) ----
export function marchingOpen() { return document.getElementById('marching').style.display === 'block'; }

export function toggleMarching(game, show) {
  const panel = document.getElementById('marching');
  const opening = show ?? !marchingOpen();
  if (opening && game.battle) { game.log('The line is already drawn — no reordering mid-battle.', 'info'); return; }
  panel.style.display = opening ? 'block' : 'none';
  if (opening) renderMarching(game);
}

function renderMarching(game) {
  const panel = document.getElementById('marching');
  const n = game.party.length;
  panel.innerHTML = `
    <h2>Marching order</h2>
    <p class="pt-sub">Top to bottom is the order of march. Front-row heroes take the field nearest the enemy; the back row stands behind them. Ambushes fall on the front.</p>
    ${game.party.map((ch, i) => `
      <div class="mo-row${ch.alive ? '' : ' dead'}">
        <img src="${ch.alive ? game.heroPortrait(ch) : (ch.cls.sprite_dead || ch.cls.sprite)}" alt="">
        <div class="mo-name"><b>${i + 1}. ${ch.name}</b><small>Level ${ch.level} ${ch.race.name} ${game.displayClass(ch)} · ${ch.weapon.name}${ch.alive ? '' : ' · fallen'}</small></div>
        <button data-row="front" data-i="${i}" class="${ch.row === 'front' ? 'front' : ''}" title="Front row: takes the hits">Front</button>
        <button data-row="back" data-i="${i}" class="${ch.row === 'back' ? 'back' : ''}" title="Back row: behind the line">Back</button>
        <button data-move="-1" data-i="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">▲</button>
        <button data-move="1" data-i="${i}" ${i === n - 1 ? 'disabled' : ''} title="Move down">▼</button>
      </div>`).join('')}
    <p class="pt-note" style="margin-top:10px">${game.party.filter(c => c.row === 'front').length ? '' : 'Nobody in the front row — the enemy will reach the back line at once. '}${localStorage.getItem('bs_party') ? 'Saved with your party.' : 'The premade party keeps this order for the run.'}</p>
    <div class="dismiss" style="text-align:center;color:var(--dim);font-style:italic">O or Esc closes</div>`;
  for (const b of panel.querySelectorAll('[data-move]')) {
    b.onclick = () => { if (game.moveHero(Number(b.dataset.i), Number(b.dataset.move))) { buildPartyPanel(game); renderMarching(game); } };
  }
  for (const b of panel.querySelectorAll('[data-row]')) {
    b.onclick = () => { if (game.setRow(game.party[Number(b.dataset.i)], b.dataset.row)) { buildPartyPanel(game); renderMarching(game); } };
  }
}

export function buildPartyPanel(game) {
  const sidebar = document.getElementById('sidebar');
  sidebar.innerHTML = '';
  for (const ch of game.party) {
    const card = document.createElement('div');
    card.className = 'char-card';
    card.innerHTML = `
      <div class="char-portrait"><img alt="${ch.name}"><span class="level-cross" title="Ready to level up! Open the inventory (I).">✚</span></div>
      <div class="char-info">
        <div class="char-name">${ch.name} <span class="row-tag">(${ch.row} row)</span></div>
        <div class="char-sub">Level ${ch.level} ${ch.race.name} ${ch.cls.name} · AC ${ch.ac} · ${ch.weapon.name}</div>
        <div class="bar hp"><div class="fill"></div><div class="bar-label"></div></div>
        ${ch.maxSp > 0 ? '<div class="bar sp"><div class="fill"></div><div class="bar-label"></div></div>' : ''}
        <div class="char-status"></div>
      </div>`;
    ch.ui = {
      card,
      img: card.querySelector('img'),
      cross: card.querySelector('.level-cross'),
      sub: card.querySelector('.char-sub'),
      hpFill: card.querySelector('.bar.hp .fill'),
      hpLabel: card.querySelector('.bar.hp .bar-label'),
      spFill: card.querySelector('.bar.sp .fill'),
      spLabel: card.querySelector('.bar.sp .bar-label'),
      status: card.querySelector('.char-status'),
    };
    sidebar.appendChild(card);
  }
}

export function updateUI(game) {
  document.getElementById('location').textContent =
    game.mode === 'town' ? game.level.name : `${game.level.name} · Turn ${game.turn}`;
  document.getElementById('gold-display').textContent = `Gold: ${game.gold}`;

  for (const ch of game.party) {
    const u = ch.ui;
    u.card.classList.toggle('dead', !ch.alive);
    u.img.src = ch.alive ? game.heroPortrait(ch) : (ch.cls.sprite_dead || ch.cls.sprite);
    u.cross.style.display = game.canLevel(ch) ? 'flex' : 'none';
    // AC and weapon change when gear does.
    const q = game.quiverCap(ch) ? ` · 🏹 ${game.quiverCount(ch)}/${game.quiverCap(ch)}` : '';
    const sub = `Level ${ch.level} ${ch.race.name} ${game.displayClass(ch)} · AC ${ch.ac} · ${ch.weapon.name}${q}${ch.level >= 20 ? ' · MAX' : ch.xp ? ` · XP ${ch.xp}/${game.xpToLevel(ch)}` : ''}`;
    if (u.sub.textContent !== sub) u.sub.textContent = sub;
    u.hpFill.style.transform = `scaleX(${Math.max(0, ch.hp / ch.maxHp)})`;
    u.hpLabel.textContent = ch.alive ? `HP ${ch.hp}/${ch.maxHp}` : 'DEAD';
    if (u.spFill) {
      u.spFill.style.transform = `scaleX(${Math.max(0, ch.sp / ch.maxSp)})`;
      u.spLabel.textContent = `SP ${ch.sp}/${ch.maxSp}`;
    }
    // Active conditions, colored per data/conditions.json — each badge leads
    // with its emoji "icon" (same glyph the battle tiles wear).
    const badges = ch.conditions.map(c => {
      const def = game.conditionDef(c.id);
      return def ? `<span style="color:${def.color}" title="${def.description ?? ''}">${def.icon ? def.icon + ' ' : ''}${def.name}</span>` : '';
    }).concat(activeStances(ch).map(b => `<span style="color:#d4a94e" title="a Stance — held until the next full rest">♪ ${b.name}</span>`)).join(' · ');
    if (u.status.innerHTML !== badges) u.status.innerHTML = badges;
  }

  const log = document.getElementById('log');
  while (log.children.length < game.messages.length) {
    const m = game.messages[log.children.length];
    const div = document.createElement('div');
    div.className = `msg-${m.kind}`;
    div.textContent = m.text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
}
