// DOM panels: party roster, message log, gold/location readouts, and the
// character sheet (stats + paper doll + potions + gear pool + leveling,
// toggled with I, E, or C).

import { abilityMod } from './rules.js';
import { classProg, laneOf, riteTier } from './progression.js';

// A one-line designer-friendly summary of what a piece of gear does.
function gearStats(def) {
  const kind = def.type.replace('weapon_', '').replace('armor_', '').replace('jewelry_', '').replace('_', ' ');
  const bits = [kind];
  if (def.damage) bits.push(def.damage + (def.range ? ` · range ${def.range}` : ''));
  if (def.ac) bits.push(`AC +${def.ac}`);
  if (def.sp) bits.push(`+${def.sp} SP`);
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
  if (game.battle || game.over || !game.choiceQueue.length || choiceOpen() || buildingOpen() || equipmentOpen() || playtestOpen()) return;
  renderChoice(game, game.choiceQueue[0]);
}

// Number keys pick cards (main.js routes digits here while the modal is up).
export function choicePick(n) {
  document.querySelectorAll('#choice .cr-choice')[n - 1]?.click();
}

function fmtOffsets(off = {}) {
  const parts = [];
  if (off.hit) parts.push(`${off.hit > 0 ? '+' : ''}${off.hit} hit & damage`);
  if (off.ac) parts.push(`${off.ac > 0 ? '+' : ''}${off.ac} AC`);
  if (off.sp) parts.push(`${off.sp > 0 ? '+' : ''}${off.sp} spell points`);
  return parts.join(', ');
}

function passiveBlurb(p) {
  if (p.id === 'weapon_focus') return `Weapon Focus: +${p.dmg ?? 1} damage with a weapon type you choose`;
  if (p.id === 'braced_stance') return `Braced Stance: −${p.reduce ?? 1} damage from every hit while a shield is worn`;
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

function renderChoice(game, choice, after) {
  const root = document.getElementById('choice');
  const ch = choice.ch;
  root.style.display = 'flex';
  const portrait = ch.cls.portrait || ch.cls.sprite;
  const close = () => { root.style.display = 'none'; root.innerHTML = ''; };

  if (choice.type === 'rite') {
    renderRite(game, choice, after);
    return;
  }
  if (choice.type === 'lane') {
    root.innerHTML = `
      <div class="cr-panel ch-panel">
        <div class="cr-step">A crossroads</div>
        <div class="ch-head"><img src="${portrait}" alt="">
          <div><b>${ch.name}</b> stands at level ${ch.level} — and the ${ch.cls.name}'s road forks here.</div></div>
        <div class="cr-choices">
          ${choice.prog.lanes.map((l, i) => `
            <button class="cr-choice" data-lane="${l.id}">
              <b>${i + 1}. ${l.name}</b>
              <span>${l.blurb ?? ''}</span>
              <span>${fmtOffsets(l.offsets)}${l.passive ? ` · ${passiveBlurb(l.passive)}` : ''}</span>
              <span>${laneMilestones(l)}</span>
            </button>`).join('')}
        </div>
        <p class="ch-warn">This choice is forever — the path not walked stays closed.</p>
      </div>`;
    for (const b of root.querySelectorAll('[data-lane]')) {
      b.onclick = () => { game.applyChoice(choice, b.dataset.lane); close(); after?.(); };
    }
  } else if (choice.type === 'focus') {
    const current = ch.weapon?.type?.replace('weapon_', '');
    const opts = game.focusOptions(ch);
    root.innerHTML = `
      <div class="cr-panel ch-panel">
        <div class="cr-step">Weapon Focus</div>
        <div class="ch-head"><img src="${portrait}" alt="">
          <div><b>${ch.name}</b> hones one kind of weapon — +1 damage with it, forever. Which?</div></div>
        <div class="cr-choices">
          ${opts.map((t, i) => `
            <button class="cr-choice" data-focus="${t}">
              <b>${i + 1}. ${t.replace('_', ' ')}</b>
              ${t === current ? '<span>(in hand right now)</span>' : ''}
            </button>`).join('')}
        </div>
      </div>`;
    for (const b of root.querySelectorAll('[data-focus]')) {
      b.onclick = () => { game.applyChoice(choice, b.dataset.focus); close(); after?.(); };
    }
  }
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
  const portrait = ch.cls.portrait || ch.cls.sprite;
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
        ${draws.map((s, i) => `<button class="cr-choice" data-draw="${i}"><b>${i + 1}. ${sigilText(s)}</b></button>`).join('')}
        <button class="cr-choice" data-handpick><b>4. None of these — I will shape it myself</b></button>
      </div>`);
    for (const b of root.querySelectorAll('[data-draw]')) {
      b.onclick = () => { state.sigil = draws[Number(b.dataset.draw)]; stepTitle(); };
    }
    root.querySelector('[data-handpick]').onclick = stepHandpick;
  };

  const stepHandpick = () => {
    const sel = (id, label, list) => `
      <label class="rt-sel"><b>${label}</b><select id="${id}">
        ${list.map(v => `<option>${v}</option>`).join('')}</select></label>`;
    shell(`
      <div class="cr-step">The Rite — III. The Sigil</div>
      <p class="rt-text">Then shape it, piece by piece:</p>
      ${sel('rt-shape', 'Base shape', vocab.shapes)}
      ${sel('rt-mod', 'Bearing', vocab.modifiers)}
      ${sel('rt-color', 'Wrought in', vocab.colors)}
      <button class="rt-next">So it is drawn</button>`);
    root.querySelector('.rt-next').onclick = () => {
      state.sigil = {
        shape: root.querySelector('#rt-shape').value,
        modifier: root.querySelector('#rt-mod').value,
        color: root.querySelector('#rt-color').value,
      };
      stepTitle();
    };
  };

  const stepTitle = () => {
    const tier = riteTier(game.data, ch);
    const tierDef = rite.tiers[tier];
    const stat = ch.counters?.[rite.tracked] ?? 0;
    const statLabel = { rampageKills: 'foes felled in Rampage', standSaves: "blows taken for allies at Guardian's Stand" }[rite.tracked] ?? rite.tracked;
    const rewards = [
      tierDef.trinket ? `the Rite leaves a gift: ${game.itemDef(tierDef.trinket)?.name ?? tierDef.trinket}` : null,
      tierDef.dungeon ? `and word of a place only such a legend may enter: ${tierDef.dungeon.toLowerCase()}` : null,
    ].filter(Boolean).join('; ');
    shell(`
      <div class="cr-step">The Rite — IV. The Title</div>
      <p class="rt-text">The deeds are already written: <b>${stat}</b> ${statLabel}. The world has settled on what to call such a ${choice.lane.archetype ?? ch.cls.name} — though ${ch.name} may bend the wording:</p>
      <input id="rt-title" type="text" maxlength="40" value="${tierDef.title.replace(/"/g, '&quot;')}">
      <p class="rt-text rt-dim">Tier ${tier + 1} of 3${rewards ? ` — ${rewards}.` : ' — title and sigil alone; greater deeds earn greater rewards.'}</p>
      <button class="rt-next">Complete the Rite</button>`);
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
    </div>
    <div class="eq-sec" style="margin-top:16px">Playstyle counters — ${game.party.map(c => Object.values(c.counters).join('·')).join(' / ')}</div>
    <p class="pt-note">The deeds that weigh the Rite's Title at level 20 (tiers at 0 / 5 / 15).
    Bump them here to test all three tiers; drop below level 20 to re-run a Rite.</p>
    <div class="pt-btnrow">
      <button data-counters="5">+5 to every counter</button>
      <button data-counters="15">+15</button>
    </div>
    <div class="eq-sec" style="margin-top:16px">Summon a fight${inDungeon ? '' : ' <span class="pt-warn">— dungeon only (you are in town)</span>'}</div>
    <p class="pt-note">Real monsters with real stakes: they appear beside the party and
    attack at once, they grant XP, and if you flee they stay on the map.</p>
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
  body.querySelector('[data-gold]').onclick = () => { game.debugGold(1000); renderPlaytest(game); };
  for (const b of body.querySelectorAll('[data-counters]')) {
    b.onclick = () => { game.debugAddCounters(Number(b.dataset.counters)); renderPlaytest(game); };
  }
  for (const b of body.querySelectorAll('[data-fight]')) {
    b.onclick = () => {
      if (game.debugFight(b.dataset.fight, Number(b.dataset.count))) togglePlaytest(game, false);
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
  renderBuilding(game, kind);
}

const KEEPERS = { inn: 'assets/town/innkeep.png', shop: 'assets/town/shopkeep.jpg' };
const B_TITLES = { inn: 'The Inn', shop: 'The Shop', temple: 'The Temple' };

function renderBuilding(game, kind) {
  const conf = game.data.town[kind];
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
    btn.addEventListener('click', () => { act(); again(); });
    div.appendChild(btn);
    body.appendChild(div);
    return div;
  };

  if (kind === 'inn') {
    row('A night for the whole party', 'full HP & spell points for the living', `Rest — ${conf.price} gold`,
      game.gold < conf.price ? 'Not enough gold.' : null, () => game.innRest());
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
    for (const id of conf.stock) {
      const def = game.itemDef(id);
      if (!def) continue; // unknown ids in town.json just don't appear
      row(def.name, itemStats(def), `Buy — ${def.value} gold`,
        game.gold < (def.value ?? 0) ? 'Not enough gold.' : null, () => game.shopBuy(id));
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
  ['boots', 'Boots', '👢'],
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
    btn.innerHTML = `<img src="${hero.alive ? (hero.cls.portrait || hero.cls.sprite) : (hero.cls.sprite_dead || hero.cls.sprite)}" alt="">
      ${game.canLevel(hero) ? '<span class="level-cross" title="Ready to level up!">✚</span>' : ''}<span>${hero.name}</span>`;
    btn.addEventListener('click', () => { eqHeroIdx = i; renderEquipment(game); });
    tabs.appendChild(btn);
  });

  document.getElementById('eq-name').textContent = ch.rite ? `${ch.name} ${ch.rite.title}` : ch.name;
  document.getElementById('eq-stats').textContent =
    `Level ${ch.level} ${ch.race.name} ${game.displayClass(ch)} · AC ${ch.ac} · ${ch.weapon.name} ${ch.weapon.damage}${ch.maxSp ? ` · SP ${ch.sp}/${ch.maxSp}` : ''}`;

  // The six abilities, with the design-doc modifier beside each score.
  document.getElementById('eq-abilities').innerHTML =
    ['str', 'int', 'wis', 'dex', 'con', 'cha'].map(k => {
      const v = ch.abilities[k];
      const mod = abilityMod(v);
      return `<div class="eq-ab"><b>${k.toUpperCase()}</b><span>${v}</span><i>${mod >= 0 ? '+' : ''}${mod}</i></div>`;
    }).join('');

  renderPath(game, ch);

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
  doll.innerHTML = `<div class="eq-figure"><img src="${ch.cls.sprite}" alt="${ch.name}"></div>`;
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
    f.cards = f.s.milestones.filter(m => ['verb', 'capstone', 'refinement'].includes(m.kind));
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
      <div class="ch-head"><img src="${ch.cls.portrait || ch.cls.sprite}" alt="">
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
      <div class="ch-head"><img src="${ch.cls.portrait || ch.cls.sprite}" alt=""><div>${headline}</div></div>
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
  if (!lane) {
    rows = row(false, 'A crossroads', `At level ${prog.fork_level}, the ${ch.cls.name}'s road forks — two paths, one choice, forever.`,
      ch.level >= prog.fork_level ? 'awaits!' : `at level ${prog.fork_level}`);
  } else {
    rows += row(true, lane.name, lane.blurb);
    if (lane.passive) {
      rows += row(true, passiveBlurb(lane.passive).split(':')[0],
        passiveBlurb(lane.passive).split(': ')[1] + (ch.focusType ? ` — ${ch.focusType.replace('_', ' ')}` : ''));
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
        rows += row(true, `Sigil: the ${ch.rite.sigil.modifier} ${ch.rite.sigil.shape}`, `Wrought in ${ch.rite.sigil.color.toLowerCase()}. Known to all as ${ch.name} ${ch.rite.title} (tier ${ch.rite.tier + 1}).`);
      } else {
        rows += row(false, 'The Rite', 'At the height of mortal skill, something answers.', ch.level >= 20 ? 'awaits!' : 'at level 20');
      }
      // The tracked deed that will one day weigh the Title.
      if (lane.verb && ch.level >= lane.verb.level) {
        const label = { rampageKills: 'Foes felled in Rampage', standSaves: 'Blows taken for allies' }[lane.rite.tracked] ?? lane.rite.tracked;
        rows += `<div class="eq-power tally"><b>${label}</b><span>${ch.counters?.[lane.rite.tracked] ?? 0}${ch.rite ? '' : ' — deeds weigh the Title at level 20'}</span></div>`;
      }
    }
  }
  panel.innerHTML = `<div class="eq-sec">Path &amp; powers</div>${rows}`;
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
    u.img.src = ch.alive ? (ch.cls.portrait || ch.cls.sprite) : (ch.cls.sprite_dead || ch.cls.sprite);
    u.cross.style.display = game.canLevel(ch) ? 'flex' : 'none';
    // AC and weapon change when gear does.
    const sub = `Level ${ch.level} ${ch.race.name} ${game.displayClass(ch)} · AC ${ch.ac} · ${ch.weapon.name}${ch.level >= 20 ? ' · MAX' : ch.xp ? ` · XP ${ch.xp}/${game.xpToLevel(ch)}` : ''}`;
    if (u.sub.textContent !== sub) u.sub.textContent = sub;
    u.hpFill.style.transform = `scaleX(${Math.max(0, ch.hp / ch.maxHp)})`;
    u.hpLabel.textContent = ch.alive ? `HP ${ch.hp}/${ch.maxHp}` : 'DEAD';
    if (u.spFill) {
      u.spFill.style.transform = `scaleX(${Math.max(0, ch.sp / ch.maxSp)})`;
      u.spLabel.textContent = `SP ${ch.sp}/${ch.maxSp}`;
    }
    // Active conditions, colored per data/conditions.json.
    const badges = ch.conditions.map(c => {
      const def = game.conditionDef(c.id);
      return def ? `<span style="color:${def.color}">${def.name}</span>` : '';
    }).join(' · ');
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
