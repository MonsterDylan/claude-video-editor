// FX + SFX libraries for the editor's FX and SFX lanes (app/fx-lanes.js). Added 2026-10-19 for Dylan's pipeline; not part
// of the upstream Claude Video Editor. Both lists are built fresh on every request from the library folders themselves, so a new
// effect in fx.js or a new sound dropped in the sound folder shows up the next time the editor opens. Nothing is cached.
//
//   FX_LIBRARY_DIR  the Signal FX Library folder: fx.js (one /** NN Name: what it does */ doc comment per effect),
//                   README.md (the effects table: function, layer, default length, params, use it when),
//                   stills/<function>.jpg (optional picture per effect for the picker)
//   SFX_DIR         the sound folder: every audio file in it is a sound; sfx-library.json adds notes where it has them
//
// Routes (wired in server.mjs): GET /api/library -> { fx, sfx }, GET /lib/fx/<still>, GET /lib/sfx/<sound>.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AUDIO = new Set(['.wav', '.mp3', '.m4a', '.ogg', '.aac', '.flac']);
const STILL = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return ''; } };
const cell = s => String(s || '').replace(/\*\*/g, '').trim();

export function libraryDirs(env) {
  // default: the claude-video-effects repo cloned NEXT TO this folder (github.com/MonsterDylan/claude-video-effects);
  // point FX_LIBRARY_DIR / SFX_DIR in env.local anywhere else
  const sib = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'claude-video-effects');
  return {
    fx: path.resolve(String(env.FX_LIBRARY_DIR || '').trim() || sib),
    sfx: path.resolve(String(env.SFX_DIR || '').trim() || path.join(sib, 'sounds'))
  };
}

// the README's effects table, by function name: | NN | Name | `fn` | layer | dur | params | use it when |
function readmeRows(dir) {
  const rows = {};
  for (const line of read(path.join(dir, 'README.md')).split(/\r?\n/)) {
    const c = line.split('|').map(x => x.trim());
    if (c.length < 8 || !/^\d+$/.test(c[1])) continue;
    const fn = (c[3].match(/`(\w+)`/) || [])[1];
    if (!fn) continue;
    rows[fn] = { layer: cell(c[4]), dur: parseFloat(c[5]) || null, params: cell(c[6]), use: cell(c[7]) };
  }
  return rows;
}

// simple text fields the picker can ask for, read from the params cell (`lines`, `word`, `keyword`, ...). Anything shaped
// like a list of objects or a file stays out: it goes in the note, where Claude reads it.
const TEXT_FIELDS = new Set(['lines', 'word', 'kicker', 'big', 'accent', 'text', 'label', 'prompt', 'result', 'status', 'title',
  'keyword', 'reply', 'caption', 'handle', 'filename', 'duration', 'sub', 'delta', 'to', 'from', 'line', 'scale', 'style', 'out']);
function fieldsOf(params) {
  const names = [...String(params || '').matchAll(/`([a-zA-Z]+)/g)].map(m => m[1]);
  return [...new Set(names.filter(n => TEXT_FIELDS.has(n)))];
}

export function fxCatalog(dir) {
  const js = read(path.join(dir, 'fx.js')), rows = readmeRows(dir), out = [];
  // each /** NN Name: ... */ comment names the next FX.<function> = function after it (helpers may sit in between)
  const docs = [...js.matchAll(/\/\*\*\s*(\d+)\s+([^:]+?):\s*([\s\S]*?)\*\//g)];
  docs.forEach((m, i) => {
    const end = i + 1 < docs.length ? docs[i + 1].index : js.length;
    const fm = js.slice(m.index + m[0].length, end).match(/FX\.(\w+)\s*=\s*function/);
    if (!fm) return;
    const [, num, name, desc] = m, fn = fm[1], row = rows[fn] || {};
    const still = STILL.map(e => fn + e).find(f => fs.existsSync(path.join(dir, 'stills', f)));
    out.push({ fn, num: +num, name: name.replace(/\s*\(NEW\)\s*$/i, '').trim(), desc: desc.replace(/\s+/g, ' ').trim(),
      dur: row.dur || 1.2, layer: row.layer || '', params: row.params || '', use: row.use || '', fields: fieldsOf(row.params),
      still: still ? '/lib/fx/' + encodeURIComponent(still) : null });
  });
  return out.sort((a, b) => a.num - b.num);
}

export function sfxCatalog(dir) {
  let meta = [];
  try { meta = JSON.parse(read(path.join(dir, 'sfx-library.json')) || '[]'); } catch (_) {}
  const byFile = new Map((Array.isArray(meta) ? meta : []).map(x => [x.filename, x]));
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => !f.startsWith('.') && AUDIO.has(path.extname(f).toLowerCase())); } catch (_) {}
  return files.sort((a, b) => a.localeCompare(b)).map(f => {
    const x = byFile.get(f) || {}, id = path.basename(f, path.extname(f));
    const ui = /^ui-/.test(id);
    return { file: f, id, name: x.id || id, category: x.category || (ui ? 'ui' : 'other'), dur: x.duration_sec || null,
      use: Array.isArray(x.use_when) ? x.use_when[0] : (ui ? 'interface sound (CC0 Kenney)' : ''),
      avoid: Array.isArray(x.avoid_when) ? x.avoid_when[0] : '', src: '/lib/sfx/' + encodeURIComponent(f) };
  });
}

// one file straight out of a library folder: a bare file name only, never a path, never a hidden file
export function libraryFile(dirs, kind, name) {
  if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.') || name.includes('..')) return null;
  const root = kind === 'fx' ? path.join(dirs.fx, 'stills') : dirs.sfx;
  const f = path.resolve(root, name);
  return f.startsWith(path.resolve(root) + path.sep) ? f : null;
}

// the effect code and its assets for the live preview (app/fx-preview.html): fx.js, fx.css, 3D models, demo images
export function fxCodeFile(dirs, rel) {
  if (!rel || rel.includes('..') || rel.includes('\\')) return null;
  let f = null;
  if (rel === 'fx.js' || rel === 'fx.css') f = path.join(dirs.fx, rel);
  else if (/^fx\/models\/[\w.-]+\.glb$/.test(rel)) f = path.join(dirs.fx, 'models', path.basename(rel));
  else if (/^demo\/[\w.-]+\.(jpg|jpeg|png|webp)$/.test(rel)) f = path.join(dirs.fx, 'demo', path.basename(rel));
  return f && f.startsWith(path.resolve(dirs.fx) + path.sep) ? f : null;
}
