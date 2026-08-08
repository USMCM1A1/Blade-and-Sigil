// DOM panels: party roster, message log, gold/location readouts.

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
    u.img.src = ch.alive ? ch.cls.sprite : (ch.cls.sprite_dead || ch.cls.sprite);
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
