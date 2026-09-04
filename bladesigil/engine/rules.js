// Core dice + rules helpers, straight from the Blade & Sigil design doc.

// Parse and roll dice strings like "1d8", "2d6+1", "3d20+20".
export function roll(diceStr) {
  if (/^\d+$/.test(String(diceStr).trim())) return parseInt(diceStr, 10); // a flat amount
  const m = /^(\d+)d(\d+)([+-]\d+)?$/.exec(diceStr.trim());
  if (!m) throw new Error(`Bad dice string: "${diceStr}"`);
  const [, count, sides, mod] = m;
  let total = mod ? parseInt(mod, 10) : 0;
  for (let i = 0; i < +count; i++) total += 1 + Math.floor(Math.random() * +sides);
  return total;
}

export const d20 = () => 1 + Math.floor(Math.random() * 20);

// The biggest a dice string can roll — a natural 20 deals this (crits).
export function maxRoll(diceStr) {
  if (/^\d+$/.test(String(diceStr).trim())) return parseInt(diceStr, 10);
  const m = /^(\d+)d(\d+)([+-]\d+)?$/.exec(diceStr.trim());
  if (!m) throw new Error(`Bad dice string: "${diceStr}"`);
  const [, count, sides, mod] = m;
  return +count * +sides + (mod ? parseInt(mod, 10) : 0);
}

// Ability modifier table from the design doc.
// Ability modifiers — designer's revised table (2026-08-30, replaces the
// doc's original 13-15/+1 curve): 12-13 +1, 14-15 +2, 16-17 +3, 18 +4,
// 19+ +5 (a 20, reachable with racial bonuses, is treated as 19 — the
// designer's table stops there).
export function abilityMod(score) {
  if (score <= 5) return -2;
  if (score <= 8) return -1;
  if (score <= 11) return 0;
  if (score <= 13) return 1;
  if (score <= 15) return 2;
  if (score <= 17) return 3;
  if (score === 18) return 4;
  return 5;
}

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
