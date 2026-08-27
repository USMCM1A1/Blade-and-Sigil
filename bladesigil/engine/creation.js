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

function loadSavedParty() {
  try {
    const def = JSON.parse(localStorage.getItem(SAVE_KEY));
    return Array.isArray(def) && def.length ? def : null;
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
      const saved = loadSavedParty();
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

      function heroStep(idx) {
        // Start from the previous visit's choices when stepping back.
        const state = heroes[idx] ?? {
          name: '',
          race: 'human',
          class: null,
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

        function render() {
          const race = data.races.races[state.race];
          const allowed = classesFor(state.race);
          if (!allowed.some(([id]) => id === state.class)) state.class = allowed[0][0];
          const cls = data.classes.classes[state.class];

          const bonus = ab => race.ability_bonus[ab] ?? 0;
          const final = ab => state.rolls[ABILITIES.indexOf(ab)] + bonus(ab);
          const hp = Math.max(1, cls.hp_die + abilityMod(final('con')));
          const ac = 10 + cls.ac_bonus[0] + abilityMod(final('dex'));
          const weap = id => data.items.items[data.classes.classes[id].starting_weapon] ?? { name: '?', damage: '?' };
          const hit = cls.hit_bonus[0] + abilityMod(final(weap(state.class).range ? 'dex' : 'str')); // ranged weapons aim with DEX

          root.innerHTML = `
            <div class="cr-panel">
              <div class="cr-step">Hero ${idx + 1} of ${PARTY_SIZE}</div>
              <div class="cr-columns">
                <div class="cr-col">
                  <label class="cr-label">Name</label>
                  <input id="cr-name" maxlength="14" value="${state.name.replace(/"/g, '&quot;')}" placeholder="Name your hero">

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
                    <img src="${cls.sprite}" alt="${cls.name}">
                    <div>${race.name} ${cls.name}<br>
                      <span class="cr-dim">HP ${hp} · AC ${ac} · to-hit ${fmtMod(hit)}${spellPointsFor(cls, 1) ? ` · SP ${spellPointsFor(cls, 1)}` : ''}</span>
                    </div>
                  </div>
                </div>
              </div>
              <div class="cr-nav">
                <button id="cr-back" class="cr-minor">${idx === 0 ? '← Title' : '← Previous hero'}</button>
                <button id="cr-next">${idx === PARTY_SIZE - 1 ? 'Begin the Descent ▼' : 'Next hero →'}</button>
              </div>
            </div>`;

          const nameEl = root.querySelector('#cr-name');
          nameEl.oninput = () => { state.name = nameEl.value; };
          for (const b of root.querySelectorAll('[data-race]')) b.onclick = () => { state.race = b.dataset.race; keepName(); render(); };
          for (const b of root.querySelectorAll('[data-class]')) b.onclick = () => { state.class = b.dataset.class; keepName(); render(); };
          for (const b of root.querySelectorAll('[data-row]')) b.onclick = () => { state.row = b.dataset.row; keepName(); render(); };
          for (const b of root.querySelectorAll('[data-ab]')) b.onclick = () => {
            const i = Number(b.dataset.ab);
            if (swapFrom === null) { swapFrom = i; }
            else {
              [state.rolls[swapFrom], state.rolls[i]] = [state.rolls[i], state.rolls[swapFrom]];
              swapFrom = null;
            }
            keepName(); render();
          };
          root.querySelector('#cr-reroll').onclick = () => { state.rolls = rollAbilitySet(); swapFrom = null; keepName(); render(); };
          root.querySelector('#cr-back').onclick = () => {
            keepName(); heroes[idx] = state;
            if (idx === 0) showTitle(); else heroStep(idx - 1);
          };
          root.querySelector('#cr-next').onclick = () => {
            keepName();
            if (!state.name.trim()) { nameEl.focus(); nameEl.classList.add('cr-error'); return; }
            heroes[idx] = state;
            if (idx === PARTY_SIZE - 1) finishWizard(); else heroStep(idx + 1);
          };
          function keepName() { state.name = root.querySelector('#cr-name').value; }
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
        }));
        try { localStorage.setItem(SAVE_KEY, JSON.stringify(def)); } catch { /* private mode: play without saving */ }
        finish(def);
      }
    }
  });
}
