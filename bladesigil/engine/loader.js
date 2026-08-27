// Data loading with designer-friendly error reporting: a broken JSON file
// shows WHICH file and WHAT's wrong instead of a blank page.

export async function loadJSON(path) {
  let resp;
  try {
    resp = await fetch(path);
  } catch (first) {
    // A cold local server occasionally drops the very first fetch — one quiet
    // retry beats a blank title screen (seen intermittently 2026-08-27).
    await new Promise(r => setTimeout(r, 350));
    try {
      resp = await fetch(path);
    } catch (e) {
      throw new DataError(path, `Could not fetch the file. Are you running via Play.command (a local server)?\n${e.message}`);
    }
  }
  if (!resp.ok) throw new DataError(path, `File not found (HTTP ${resp.status}). Check the filename.`);
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new DataError(path, friendlyJsonError(text, e));
  }
}

export class DataError extends Error {
  constructor(file, detail) {
    super(detail);
    this.file = file;
  }
}

// Point at the line where JSON parsing failed.
function friendlyJsonError(text, err) {
  const m = /position (\d+)/.exec(err.message);
  if (!m) return err.message;
  const pos = +m[1];
  const before = text.slice(0, pos);
  const line = before.split('\n').length;
  const lines = text.split('\n');
  const context = lines.slice(Math.max(0, line - 3), line + 2)
    .map((l, i) => `${Math.max(0, line - 3) + i + 1}:  ${l}`).join('\n');
  return `${err.message}\n\nAround line ${line}:\n${context}\n\nCommon causes: a missing comma, an extra comma before } or ], or unquoted text.`;
}

export function showFatal(err) {
  const el = document.getElementById('fatal');
  const msg = document.getElementById('fatal-msg');
  const file = err.file ? `File: ${err.file}\n\n` : '';
  msg.textContent = `${file}${err.message}\n\nFix the file and refresh the page (Cmd+R).`;
  el.style.display = 'block';
  console.error(err);
}
