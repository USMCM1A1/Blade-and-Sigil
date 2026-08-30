// Title screen + character creation (Phase 2).
// One hero at a time: name, race, class, roll 3d6 (re-rolling 1s), arrange
// scores as desired, pick a row. Produces a party definition in the same
// shape as data/party.json; created parties are saved in the browser.

import { abilityMod } from './rules.js';
import { spellPointsFor } from './magic.js';

const SAVE_KEY = 'bs_party';
const PARTY_SIZE = 4;
const ABILITIES = ['str', 'int', 'wis', 'dex', 'con', 'cha'];
const ABILITY_NAMES = {
  str: 'Strength', int: 'Intelligence', wis: 'Wisdom',
  dex: 'Dexterity', con: 'Constitution', cha: 'Charisma',
};

// Design doc: roll 3d6, re-rolling any die that shows a 1.
const d6no1 = () => 2 + Math.floor(Math.random() * 5);
const roll3d6 = () => d6no1() + d6no1() + d6no1();
const rollAbilitySet = () => ABILITIES.map(() => roll3d6());

const fmtMod = n => (n >= 0 ? `+${n}` : `${n}`);

function loadSavedParty(data) {
  try {
    const def = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (!Array.isArray(def) || !def.length) return null;
    // A save from before a class or race was retired (the Archer) is set
    // aside — the premade party plays instead of a boot error.
    if (def.some(h => !data.classes.classes[h.class] || !data.races.races[h.race])) return null;
    return def;
  } catch { return null; }
}

// Resolves with a party definition array once the player has chosen a party.
export function choosePartyDef(data) {
  const root = document.getElementById('creation');
  return new Promise(resolve => {
    const finish = def => {
      root.style.display = 'none';
      root.innerHTML = '';
      resolve(def);
    };
    showTitle();

    // ---- Title screen ----
    // Two choices only: make a party, or play one — your saved party if you
    // have one, otherwise the premade party from data/party.json.
    function showTitle() {
      const saved = loadSavedParty(data);
      const play = saved ?? data.party.party;
      root.style.display = 'flex';
      root.innerHTML = `
        <div class="cr-panel cr-title">
          <h1>Blade &amp; Sigil</h1>
          <p class="cr-sub">An old-school party dungeon crawl</p>
          <div class="cr-title-buttons">
            <button id="cr-new">Create New Party</button>
            <button id="cr-play">${saved ? 'Play Your Party' : 'Quick Start'} (${play.map(h => h.name).join(', ')})</button>
          </div>
        </div>`;
      root.querySelector('#cr-new').onclick = () => startWizard();
      root.querySelector('#cr-play').onclick = () => finish(play);
    }

    // ---- The wizard: one hero at a time ----
    function startWizard() {
      const heroes = []; // finished hero defs
      heroStep(0);

      // Each hero is built in TWO steps (designer's ask 2026-08-27): first
      // the mechanics (race/class/abilities/row), then name & appearance —
      // with the portrait AND the full figure shown large enough to judge.
      function heroStep(idx, phase = 'build') {
        // Start from the previous visit's choices when stepping back.
        const state = heroes[idx] ?? {
          name: '',
          race: 'human',
          class: null,
          look: 'm1', // appearance variant: m1/m2/f1/f2 (2026-08-26)
          gift: null, // the level-1 creation gift {id, element?} for classes with a creation_pick (2026-08-29)
          bonusAbility: 'dex', // the Half-Elf's floating +1 (races with floating_bonus)
          favored: null, // the Ranger's first favored enemy (classes with favored_enemy)
          rolls: rollAbilitySet(),
          row: idx < 2 ? 'front' : 'back',
        };
        let swapFrom = null; // index of the first score clicked when swapping

        render();

        function classesFor(race) {
          // "locked": true in classes.json hides a class until its lanes are
          // built (designer's call 2026-08-26) — delete the flag to release it.
          return Object.entries(data.classes.classes)
            .filter(([, c]) => !c.locked && c.allowed_races.includes(race));
        }

        function derive() {
          const race = data.races.races[state.race];
          const allowed = classesFor(state.race);
          if (!allowed.some(([id]) => id === state.class)) state.class = allowed[0][0];
          const cls = data.classes.classes[state.class];
          // A class with a creation_pick owes a gift; default to its first option.
          const pick = cls.creation_pick ?? null;
          if (pick && !pick.options.some(o => o.id === state.gift?.id)) state.gift = { id: pick.options[0].id };
          if (!pick) state.gift = null;
          const giftOpt = pick?.options.find(o => o.id === state.gift.id) ?? null;
          if (giftOpt?.ac_vs_element !== undefined && !state.gift.element) state.gift.element = 'fire';
          if (giftOpt && giftOpt.ac_vs_element === undefined) delete state.gift.element;
          if (cls.favored_enemy && !state.favored) state.favored = 'humanoid';
          if (!cls.favored_enemy) state.favored = null;
          const bonus = ab => (race.ability_bonus[ab] ?? 0) + (race.floating_bonus && state.bonusAbility === ab ? race.floating_bonus : 0);
          const final = ab => state.rolls[ABILITIES.indexOf(ab)] + bonus(ab);
          const hp = Math.max(1, cls.hp_die + abilityMod(final('con')));
          const ac = 10 + cls.ac_bonus[0] + abilityMod(final('dex'));
          const weap = id => data.items.items[data.classes.classes[id].starting_weapon] ?? { name: '?', damage: '?' };
          const hit = cls.hit_bonus[0] + abilityMod(final(weap(state.class).range ? 'dex' : 'str')); // ranged weapons aim with DEX
          return { race, allowed, cls, bonus, final, hp, ac, weap, hit, pick, giftOpt };
        }

        function render() {
          if (phase === 'look') renderLook(); else renderBuild();
        }

        // ---- Step 2 of 2: name & appearance, art shown LARGE ----
        function renderLook() {
          const { race, cls, hp, ac, hit } = derive();
          const LABELS = { m1: 'Male', m2: 'Male', f1: 'Female', f2: 'Female' };
          root.innerHTML = `
            <div class="cr-panel">
              <div class="cr-step">Hero ${idx + 1} of ${PARTY_SIZE} — step 2 of 2: name &amp; appearance</div>
              <div class="cr-lookhead">
                <input id="cr-name" maxlength="14" value="${state.name.replace(/"/g, '&quot;')}" placeholder="Name your ${race.name} ${cls.name}">
                <span class="cr-dim">${race.name} ${cls.name} · HP ${hp} · AC ${ac} · to-hit ${fmtMod(hit)}${spellPointsFor(cls, 1) ? ` · SP ${spellPointsFor(cls, 1)}` : ''}</span>
              </div>
              <div class="cr-lookgrid">
                ${['m1', 'm2', 'f1', 'f2'].map(v => `
                  <button class="cr-lookbig ${v === state.look ? 'picked' : ''}" data-look="${v}">
                    <span class="cr-looklabel">${LABELS[v]}</span>
                    <img class="cr-lookface" src="assets/heroes/gen/${state.race}_${state.class}_${v}_face.png"
                         onerror="this.style.display='none'" alt="">
                    <span class="cr-lookdoll"><img src="assets/heroes/gen/${state.race}_${state.class}_${v}.png"
                         onerror="this.src='${cls.sprite}'; this.onerror=null" alt=""></span>
                  </button>`).join('')}
              </div>
              <div class="cr-nav">
                <button id="cr-back" class="cr-minor">← Race &amp; class</button>
                <button id="cr-next">${idx === PARTY_SIZE - 1 ? 'Begin the Descent ▼' : 'Next hero →'}</button>
              </div>
            </div>`;

          const nameEl = root.querySelector('#cr-name');
          nameEl.oninput = () => { state.name = nameEl.value; };
          for (const b of root.querySelectorAll('[data-look]')) {
            b.onclick = () => { state.look = b.dataset.look; state.name = nameEl.value; render(); };
          }
          root.querySelector('#cr-back').onclick = () => {
            state.name = nameEl.value; heroes[idx] = state;
            heroStep(idx, 'build');
          };
          root.querySelector('#cr-next').onclick = () => {
            state.name = nameEl.value;
            if (!state.name.trim()) { nameEl.focus(); nameEl.classList.add('cr-error'); return; }
            heroes[idx] = state;
            if (idx === PARTY_SIZE - 1) finishWizard(); else heroStep(idx + 1, 'build');
          };
          nameEl.focus();
        }

        // ---- Step 1 of 2: the mechanics ----
        function renderBuild() {
          const { race, allowed, cls, bonus, final, hp, ac, weap, hit, pick, giftOpt } = derive();
          const ELEMENTS = ['fire', 'frost', 'lightning', 'poison'];
          const FAMILIES = ['undead', 'outsider', 'beast', 'vermin', 'humanoid', 'construct', 'ooze', 'aberration', 'dragon', 'elemental'];
          const favoredHtml = cls.favored_enemy ? `
                  <label class="cr-label">Favored enemy <span class="cr-dim">(+1 to hit and damage against one kind of monster; more picks at levels ${cls.favored_enemy.levels.slice(1).join('/')})</span></label>
                  <div class="cr-choices cr-rows">
                    ${FAMILIES.map(f => `<button class="cr-choice ${f === state.favored ? 'picked' : ''}" data-favored="${f}"><b>${f}</b></button>`).join('')}
                  </div>` : '';
          const floatHtml = race.floating_bonus ? `
                  <label class="cr-label">The floating +${race.floating_bonus} <span class="cr-dim">(a ${race.name} chooses where it lands)</span></label>
                  <div class="cr-choices cr-rows">
                    ${ABILITIES.map(ab => `<button class="cr-choice ${ab === state.bonusAbility ? 'picked' : ''}" data-bonus="${ab}"><b>${ab.toUpperCase()}</b></button>`).join('')}
                  </div>` : '';
          const giftHtml = pick ? `
                  <label class="cr-label">${pick.title ?? 'A gift'} <span class="cr-dim">(${pick.blurb ?? 'choose one'})</span></label>
                  <div class="cr-choices" id="cr-gifts">
                    ${pick.options.map(o => `
                      <button class="cr-choice ${o.id === state.gift.id ? 'picked' : ''}" data-gift="${o.id}">
                        <b>${o.name}</b>
                        <span>${o.blurb ?? ''}</span>
                      </button>`).join('')}
                  </div>
                  ${giftOpt?.ac_vs_element !== undefined ? `
                  <div class="cr-choices cr-rows">
                    ${ELEMENTS.map(e => `<button class="cr-choice ${e === state.gift.element ? 'picked' : ''}" data-element="${e}"><b>${e}</b></button>`).join('')}
                  </div>` : ''}` : '';

          root.innerHTML = `
            <div class="cr-panel">
              <div class="cr-step">Hero ${idx + 1} of ${PARTY_SIZE} — step 1 of 2: race, class &amp; abilities</div>
              <div class="cr-columns">
                <div class="cr-col">
                  <label class="cr-label">Race</label>
                  <div class="cr-choices" id="cr-races">
                    ${Object.entries(data.races.races).map(([id, r]) => `
                      <button class="cr-choice ${id === state.race ? 'picked' : ''}" data-race="${id}">
                        <b>${r.name}</b>
                        <span>${Object.entries(r.ability_bonus).map(([ab, b]) => `${fmtMod(b)} ${ab.toUpperCase()}`).join(', ')} · ${r.traits.join(' · ')}</span>
                      </button>`).join('')}
                  </div>

                  <label class="cr-label">Class <span class="cr-dim">(a ${race.name} may be:)</span></label>
                  <div class="cr-choices" id="cr-classes">
                    ${allowed.map(([id, c]) => `
                      <button class="cr-choice ${id === state.class ? 'picked' : ''}" data-class="${id}">
                        <b>${c.name}</b>
                        <span>d${c.hp_die} hits · ${weap(id).name} ${weap(id).damage}${spellPointsFor(c, 1) ? ` · ${spellPointsFor(c, 1)} spell points` : ''}</span>
                      </button>`).join('')}
                  </div>
                  ${floatHtml}
                  ${favoredHtml}
                  ${giftHtml}
                </div>

                <div class="cr-col">
                  <label class="cr-label">Abilities <span class="cr-dim">(3d6, 1s re-rolled — click two scores to swap them)</span></label>
                  <div class="cr-abilities">
                    ${ABILITIES.map((ab, i) => `
                      <button class="cr-ability ${swapFrom === i ? 'swapping' : ''}" data-ab="${i}">
                        <span class="cr-ab-name">${ABILITY_NAMES[ab]}</span>
                        <span class="cr-ab-score">${state.rolls[i]}${bonus(ab) ? `<i> ${fmtMod(bonus(ab))}</i>` : ''}</span>
                        <span class="cr-ab-mod">${fmtMod(abilityMod(final(ab)))}</span>
                      </button>`).join('')}
                  </div>
                  <button id="cr-reroll" class="cr-minor">🎲 Roll again</button>

                  <label class="cr-label">Marching row</label>
                  <div class="cr-choices cr-rows">
                    <button class="cr-choice ${state.row === 'front' ? 'picked' : ''}" data-row="front"><b>Front row</b><span>takes the hits</span></button>
                    <button class="cr-choice ${state.row === 'back' ? 'picked' : ''}" data-row="back"><b>Back row</b><span>safe while the front line stands</span></button>
                  </div>

                  <div class="cr-preview">
                    <img src="assets/heroes/gen/${state.race}_${state.class}_${state.look}.png"
                         onerror="this.src='${cls.sprite}'" alt="${cls.name}">
                    <div>${race.name} ${cls.name}<br>
                      <span class="cr-dim">HP ${hp} · AC ${ac} · to-hit ${fmtMod(hit)}${spellPointsFor(cls, 1) ? ` · SP ${spellPointsFor(cls, 1)}` : ''}</span>
                    </div>
                  </div>
                </div>
              </div>
              <div class="cr-nav">
                <button id="cr-back" class="cr-minor">${idx === 0 ? '← Title' : '← Previous hero'}</button>
                <button id="cr-next">Name &amp; appearance →</button>
              </div>
            </div>`;

          for (const b of root.querySelectorAll('[data-race]')) b.onclick = () => { state.race = b.dataset.race; render(); };
          for (const b of root.querySelectorAll('[data-class]')) b.onclick = () => { state.class = b.dataset.class; render(); };
          for (const b of root.querySelectorAll('[data-row]')) b.onclick = () => { state.row = b.dataset.row; render(); };
          for (const b of root.querySelectorAll('[data-gift]')) b.onclick = () => { state.gift = { id: b.dataset.gift }; render(); };
          for (const b of root.querySelectorAll('[data-favored]')) b.onclick = () => { state.favored = b.dataset.favored; render(); };
          for (const b of root.querySelectorAll('[data-bonus]')) b.onclick = () => { state.bonusAbility = b.dataset.bonus; render(); };
          for (const b of root.querySelectorAll('[data-element]')) b.onclick = () => { state.gift.element = b.dataset.element; render(); };
          for (const b of root.querySelectorAll('[data-ab]')) b.onclick = () => {
            const i = Number(b.dataset.ab);
            if (swapFrom === null) { swapFrom = i; }
            else {
              [state.rolls[swapFrom], state.rolls[i]] = [state.rolls[i], state.rolls[swapFrom]];
              swapFrom = null;
            }
            render();
          };
          root.querySelector('#cr-reroll').onclick = () => { state.rolls = rollAbilitySet(); swapFrom = null; render(); };
          root.querySelector('#cr-back').onclick = () => {
            heroes[idx] = state;
            if (idx === 0) showTitle(); else heroStep(idx - 1, 'look');
          };
          root.querySelector('#cr-next').onclick = () => {
            heroes[idx] = state;
            heroStep(idx, 'look');
          };
        }
      }

      function finishWizard() {
        const def = heroes.map(h => ({
          name: h.name.trim(),
          race: h.race,
          class: h.class,
          level: 1,
          row: h.row,
          abilities: Object.fromEntries(ABILITIES.map((ab, i) => [ab, h.rolls[i]])),
          gift: h.gift ?? null,
          favored: h.favored ?? undefined,
          bonus_ability: data.races.races[h.race].floating_bonus ? (h.bonusAbility ?? 'dex') : undefined,
          look: {
            sprite: `assets/heroes/gen/${h.race}_${h.class}_${h.look ?? 'm1'}.png`,
            portrait: `assets/heroes/gen/${h.race}_${h.class}_${h.look ?? 'm1'}_face.png`,
          },
        }));
        try { localStorage.setItem(SAVE_KEY, JSON.stringify(def)); } catch { /* private mode: play without saving */ }
        finish(def);
      }
    }
  });
}
