// DOM panels: party roster, message log, gold/location readouts, party pouch.

// ---- Party pouch (map inventory, toggled with I) ----
export function inventoryOpen() {
  return document.getElementById('inventory').style.display === 'block';
}

export function toggleInventory(game, show) {
  const panel = document.getElementById('inventory');
  const opening = show ?? !inventoryOpen();
  panel.style.display = opening ? 'block' : 'none';
  if (opening) renderInventory(game);
}

// A one-line designer-friendly summary of what a piece of gear does.
function gearStats(def) {
  const kind = def.type.replace('weapon_', '').replace('armor_', '').replace('jewelry_', '').replace('_', ' ');
  const bits = [kind];
  if (def.damage) bits.push(def.damage + (def.range ? ` · range ${def.range}` : ''));
  if (def.ac) bits.push(`AC +${def.ac}`);
  if (def.sp) bits.push(`+${def.sp} SP`);
  return bits.join(' · ');
}

function renderInventory(game) {
  const list = document.getElementById('inv-list');
  const potions = game.heldItems();
  const gear = game.heldGear();
  list.innerHTML = '';
  if (!potions.length && !gear.length) {
    list.innerHTML = '<p class="inv-empty">The pouch is empty. Chests sometimes hold potions and gear...</p>';
  }

  for (const it of potions) {
    const row = document.createElement('div');
    row.className = 'inv-item';
    row.innerHTML = `
      <div class="inv-head">${it.def.name} <span class="inv-count">×${it.count}</span></div>
      <div class="inv-desc">${it.def.description}</div>
      <div class="inv-heroes"><span>Drink:</span></div>`;
    const heroes = row.querySelector('.inv-heroes');
    for (const ch of game.party) {
      const btn = document.createElement('button');
      const reason = game.itemBlockReason(it.def, ch);
      btn.textContent = `${ch.name} ${ch.alive ? `${ch.hp}/${ch.maxHp}` : '✝'}`;
      if (reason) { btn.disabled = true; btn.title = reason; }
      btn.addEventListener('click', () => {
        game.useItemOnMap(it.id, ch);
        // Drinking passes a turn — the world may answer with a battle.
        if (game.battle) toggleInventory(game, false);
        else renderInventory(game);
      });
      heroes.appendChild(btn);
    }
    list.appendChild(row);
  }

  if (gear.length) {
    const row = document.createElement('div');
    row.className = 'inv-item';
    row.innerHTML = `
      <div class="inv-head">Carried gear</div>
      <div class="inv-desc">${gear.map(it => `${it.def.name} ×${it.count}`).join(' · ')}</div>
      <div class="inv-desc">Press <b>E</b> to open the equipment screen.</div>`;
    list.appendChild(row);
  }
}

// ---- Paper doll (equipment screen, toggled with E) ----
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
  document.getElementById('location').textContent = game.level.name;
  document.getElementById('gold-display').textContent = `Gold: ${game.gold}`;

  for (const ch of game.party) {
    const u = ch.ui;
    u.card.classList.toggle('dead', !ch.alive);
    u.img.src = ch.alive ? (ch.cls.portrait || ch.cls.sprite) : (ch.cls.sprite_dead || ch.cls.sprite);
    // AC and weapon change when gear does.
    const sub = `Level ${ch.level} ${ch.race.name} ${ch.cls.name} · AC ${ch.ac} · ${ch.weapon.name}`;
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
