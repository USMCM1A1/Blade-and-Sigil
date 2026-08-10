// DOM panels: party roster, message log, gold/location readouts, and the
// inventory screen (paper doll + potions + gear pool, toggled with I or E).

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
    btn.innerHTML = `<img src="${hero.alive ? (hero.cls.portrait || hero.cls.sprite) : (hero.cls.sprite_dead || hero.cls.sprite)}" alt=""><span>${hero.name}</span>`;
    btn.addEventListener('click', () => { eqHeroIdx = i; renderEquipment(game); });
    tabs.appendChild(btn);
  });

  document.getElementById('eq-name').textContent = ch.name;
  document.getElementById('eq-stats').textContent =
    `Level ${ch.level} ${ch.race.name} ${ch.cls.name} · AC ${ch.ac} · ${ch.weapon.name} ${ch.weapon.damage}${ch.maxSp ? ` · SP ${ch.sp}/${ch.maxSp}` : ''}`;

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

export function buildPartyPanel(game) {
  const sidebar = document.getElementById('sidebar');
  sidebar.innerHTML = '';
  for (const ch of game.party) {
    const card = document.createElement('div');
    card.className = 'char-card';
    card.innerHTML = `
      <img alt="${ch.name}">
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
    // AC and weapon change when gear does.
    const sub = `Level ${ch.level} ${ch.race.name} ${ch.cls.name} · AC ${ch.ac} · ${ch.weapon.name}${ch.xp ? ` · ${ch.xp} XP` : ''}`;
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
