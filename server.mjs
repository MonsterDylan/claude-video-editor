#!/usr/bin/env node
// Claude Video Editor: the small local server for the review app. No dependencies, nothing to install.
//
//   node server.mjs                  then open http://127.0.0.1:50002/
//   node server.mjs --port 50010     any free port (or set PORT in env.local)
//
// Every project is a folder in projects/ that tools/make-project.mjs wrote. The editor page is built from app/ on every
// request, so a project always opens the current editor. Everything you do on a project (comments, notes, trims,
// approvals) is saved to projects/<project>/rubric-state.json, where your agent can read it.

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error('\n  Claude Video Editor needs Node.js 18 or newer. You are running ' + process.version + '\n');
  process.exit(1);
}

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { libraryDirs, fxCatalog, sfxCatalog, libraryFile, fxCodeFile } from './fx-library.mjs';   // FX/SFX lanes (Dylan, 2026-10-19)

const VERSION = '1.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------- settings: env.local fills in anything the real environment doesn't set ----------
function loadEnvFile(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return false; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
  return true;
}
loadEnvFile(path.join(HERE, 'env.local'));
const argPort = (() => { const i = process.argv.indexOf('--port'); return i > 0 ? Number(process.argv[i + 1]) : 0; })();
const PORT = argPort || Number(process.env.PORT) || 50002;
const TOKEN = String(process.env.RUBRIC_TOKEN || '').trim();
const PROJECTS = path.resolve(HERE, String(process.env.PROJECTS_DIR || '').trim() || 'projects');
const APP = path.join(HERE, 'app');
const LIB = libraryDirs(process.env);                           // the FX and SFX libraries the lanes pick from
const STATE = 'rubric-state.json';
const BODY_CAP = 1024 * 1024;                                   // 1 MB for any request body
const STUBS = {                                                 // data files a project may leave out
  'resolutions.js': 'window.RESOLVED = {};\n', 'fixes.js': 'window.FIXES = {};\n',
  'approvals.js': 'window.APPROVED = {};\n', 'source-data.js': 'window.SOURCE = {};\n'
};
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary'
};

// ---------- helpers ----------
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch (_) { return 0; } };
const born = f => { try { const s = fs.statSync(f); return s.birthtimeMs || s.mtimeMs; } catch (_) { return 0; } };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inside = (root, file) => { const r = path.resolve(root), f = path.resolve(file); return f === r || f.startsWith(r + path.sep); };
const jsVar = (txt, name) => {
  const m = (txt || '').match(new RegExp(`window\\.${name}\\s*=\\s*([\\s\\S]*?);\\s*(\\n|$)`));
  try { return m ? JSON.parse(m[1]) : null; } catch (_) { return null; }
};
const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(id) && !id.includes('..');
const urlOf = (id, rel) => rel ? '/projects/' + encodeURIComponent(id) + '/' + String(rel).split('/').map(encodeURIComponent).join('/') : null;

// ---------- projects ----------
function readConf(dir) { try { return JSON.parse(fs.readFileSync(path.join(dir, 'rubric.json'), 'utf8')) || {}; } catch (_) { return {}; } }
function project(id) {
  if (!validId(id)) return null;
  const dir = path.join(PROJECTS, id);
  if (!inside(PROJECTS, dir) || !fs.existsSync(path.join(dir, 'reels-data.js'))) return null;
  const conf = readConf(dir);
  const batch = jsVar(read(path.join(dir, 'reels-data.js')), 'REEL_BATCH') || {};
  const storeKey = typeof conf.storeKey === 'string' && /^[\w.:-]{1,120}$/.test(conf.storeKey) ? conf.storeKey : 'rubric-editor-' + id;
  const ns = typeof conf.ns === 'string' && /^[\w.:-]{1,120}$/.test(conf.ns) ? conf.ns : storeKey;
  return { id, dir, conf, batch, title: String(conf.title || batch.name || id), kicker: String(conf.kicker || ''), storeKey, ns,
    prefixes: [...new Set([storeKey, ns])] };
}
function projects() {
  let names = [];
  try { names = fs.readdirSync(PROJECTS, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch (_) {}
  return names.map(project).filter(Boolean);
}
const loadState = p => { try { return JSON.parse(fs.readFileSync(path.join(p.dir, STATE), 'utf8')); } catch (_) { return { keys: {} }; } };
function saveState(p, st) {
  st.project = p.id; st.updated = new Date().toISOString();
  const f = path.join(p.dir, STATE), text = JSON.stringify(st, null, 1);
  fs.writeFileSync(f + '.tmp', text);
  try { fs.renameSync(f + '.tmp', f); } catch (_) { fs.writeFileSync(f, text); try { fs.unlinkSync(f + '.tmp'); } catch (__) {} }
}
const mine = (p, k) => p.prefixes.some(x => k === x || k.startsWith(x + ':'));

// What a homepage card shows: the newest version of each clip, the first clip's poster and video, the total length,
// the dates, and how many comments and approvals are saved.
function card(p) {
  const reels = jsVar(read(path.join(p.dir, 'reels-data.js')), 'REELS') || [];
  const newest = new Map(), vnum = r => Number((String(r.version || '').match(/\d+/) || [0])[0]);
  for (const r of reels) { const k = r.base || r.id; const cur = newest.get(k); if (!cur || vnum(r) >= vnum(cur)) newest.set(k, r); }
  const clips = [...newest.values()], first = clips[0] || {};
  const st = loadState(p); let S = {}; try { S = JSON.parse((st.keys || {})[p.storeKey] || '{}') || {}; } catch (_) {}
  let comments = 0;
  Object.values(S.reels || {}).forEach(r => { (r.marks || []).forEach(m => { if (m.type === 'pin' || m.type === 'add' || m.type === 'layer') comments++; }); });
  const approved = Object.values(S.approvals || {}).filter(a => a && !a.off).length;
  const created = Date.parse(p.conf.created || '') || born(p.dir);
  return { id: p.id, title: p.title, kicker: p.kicker, orientation: p.conf.orientation || p.batch.orientation || 'landscape',
    clips: clips.length, seconds: Math.round(clips.reduce((s, r) => s + (Number(r.duration) || 0), 0)),
    poster: urlOf(p.id, first.poster), video: urlOf(p.id, first.video),
    created, edited: Math.max(mtime(path.join(p.dir, 'reels-data.js')), st.workAt || 0), comments, approved };
}

// ---------- pages ----------
function boot(obj) { return `<script>window.__RUBRIC_APP=${JSON.stringify(obj).replace(/</g, '\\u003c')};</script>`; }
function editorPage(p) {
  let h = read(path.join(APP, 'editor.html'));
  const swap = (a, b) => { if (!h.includes(a)) throw new Error('editor.html is missing ' + a); h = h.split(a).join(b); };
  swap('href="editor-timeline.css"', 'href="/__rubric/timeline.css"');
  swap('<script src="editor-timeline.js"></script>', `<script src="/__rubric/timeline.js?ns=${encodeURIComponent(p.ns)}"></script>`);
  h = h.replace(/<title>[^<]*<\/title>/, () => `<title>${esc(p.title)} · Claude Video Editor</title>`)
       .replace(/const STORE_KEY = '[^']*';/, () => `const STORE_KEY = ${JSON.stringify(p.storeKey)};`)
       .replace(/<div class="kicker batch-kicker">[\s\S]*?<\/div>/, () => `<div class="kicker batch-kicker">${esc(p.title)}` +
         (p.kicker ? ` · <span style="color:var(--accent)">${esc(p.kicker)}</span>` : '') + '</div>');
  // orientation: rubric.json's, so Export offers sizes in the project's shape
  const b = boot({ project: p.id, prefixes: p.prefixes, keys: loadState(p).keys || {}, token: TOKEN || null,
    orientation: p.conf.orientation === 'vertical' || p.conf.orientation === 'landscape' ? p.conf.orientation : null });
  h = h.replace('</body>', '<link rel="stylesheet" href="/__rubric/fx-lanes.css">\n<script src="/__rubric/fx-lanes.js"></script>\n</body>');   // FX/SFX lanes
  return h.replace(/<head[^>]*>/, m => `${m}\n${b}\n<script src="/__rubric/shim.js"></script>`);
}
function homePage() {
  const h = read(path.join(APP, 'home.html')) || '';
  return h.replace(/<head[^>]*>/, m => `${m}\n${boot({ token: TOKEN || null, version: VERSION })}`);
}

// ---------- responses ----------
const HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
function send(res, code, type, body) { res.writeHead(code, { ...HEADERS, 'Content-Type': type }); res.end(body); }
const json = (res, obj, code = 200) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
const notFound = res => send(res, 404, 'text/plain; charset=utf-8', 'Not found');
function sendFile(req, res, f) {
  let st; try { st = fs.statSync(f); } catch (_) { return notFound(res); }
  if (!st.isFile()) return notFound(res);
  const type = TYPES[path.extname(f).toLowerCase()];
  if (!type) return notFound(res);
  const tag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const head = { ...HEADERS, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', ETag: tag };
  const range = req.headers.range && req.headers.range.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] !== '' || range[2] !== '')) {        // video seeking needs byte ranges
    let a = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
    let b = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
    if (a < 0) a = 0; if (b >= st.size) b = st.size - 1;
    if (a > b) { res.writeHead(416, { ...HEADERS, 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1 });
    return req.method === 'HEAD' ? res.end() : fs.createReadStream(f, { start: a, end: b }).pipe(res);
  }
  if (req.headers['if-none-match'] === tag) { res.writeHead(304, head); return res.end(); }
  res.writeHead(200, { ...head, 'Content-Length': st.size });
  return req.method === 'HEAD' ? res.end() : fs.createReadStream(f).pipe(res);
}
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
function body(req) {
  return new Promise((ok, bad) => {
    const chunks = []; let size = 0, over = false;
    req.on('data', c => { if (over) return; size += c.length; if (size > BODY_CAP) { over = true; bad(new HttpError(413, 'Request too large (1 MB limit)')); return; } chunks.push(c); });
    req.on('end', () => { if (!over) ok(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', bad);
  });
}
async function jsonBody(req) {
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) throw new HttpError(415, 'Send JSON (Content-Type: application/json)');
  const text = await body(req);
  try { return JSON.parse(text || '{}') || {}; } catch (_) { throw new HttpError(400, 'Not valid JSON'); }
}
// Only the names this server answers to on your own machine: blocks DNS rebinding (a website pointing its own name here).
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  try {
    if (!HOSTS.has(String(req.headers.host || '').toLowerCase())) return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden');
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;

    if (p.startsWith('/api/')) {
      if (TOKEN && req.headers['x-rubric-token'] !== TOKEN) return json(res, { error: 'Missing or wrong x-rubric-token' }, 401);
      if (p === '/api/health' && req.method === 'GET') return json(res, { ok: true, app: 'rubric-editor', version: VERSION, projects: projects().length });
      if (p === '/api/projects' && req.method === 'GET') return json(res, { projects: projects().map(card) });
      if (p === '/api/library' && req.method === 'GET') return json(res, { fx: fxCatalog(LIB.fx), sfx: sfxCatalog(LIB.sfx), dirs: LIB });
      const m = p.match(/^\/api\/state\/([^/]+)$/);
      if (m) {
        const proj = project(decodeURIComponent(m[1]));
        if (!proj) return json(res, { error: 'No such project' }, 404);
        if (req.method === 'GET') return json(res, loadState(proj));
        if (req.method !== 'POST') return json(res, { error: 'Method not allowed' }, 405);
        const inp = await jsonBody(req), st = loadState(proj); st.keys = st.keys || {};
        let n = 0;
        for (const [k, v] of Object.entries(inp.set || {})) if (mine(proj, k)) {
          // "last edited" counts your work (comments, trims, approvals), not view settings, switches or export requests
          if (!/:(cur|cur-src|rate|layout|raw|hideCuts|teach|export)$/.test(k) && st.keys[k] !== String(v)) st.workAt = Date.now();
          st.keys[k] = String(v); n++;
        }
        for (const k of Array.isArray(inp.del) ? inp.del : []) if (typeof k === 'string' && mine(proj, k)) { delete st.keys[k]; n++; }
        if (n) saveState(proj, st);
        return json(res, { ok: true, saved: n });
      }
      return json(res, { error: 'Not found' }, 404);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    if (p === '/' || p === '/index.html') return send(res, 200, 'text/html; charset=utf-8', homePage());
    if (p === '/__rubric/shim.js') return sendFile(req, res, path.join(APP, 'shim.js'));
    if (p === '/__rubric/fx-lanes.js') return sendFile(req, res, path.join(APP, 'fx-lanes.js'));
    if (p === '/__rubric/fx-lanes.css') return sendFile(req, res, path.join(APP, 'fx-lanes.css'));
    if (p === '/__rubric/fx-preview.html') return sendFile(req, res, path.join(APP, 'fx-preview.html'));
    { const cm = p.match(/^\/lib\/fxcode\/(.+)$/);
      if (cm) { let n; try { n = decodeURIComponent(cm[1]); } catch (_) { return notFound(res); } const f = fxCodeFile(LIB, n); return f ? sendFile(req, res, f) : notFound(res); } }
    { const lm = p.match(/^\/lib\/(fx|sfx)\/([^/]+)$/);
      if (lm) { let n; try { n = decodeURIComponent(lm[2]); } catch (_) { return notFound(res); } const f = libraryFile(LIB, lm[1], n); return f ? sendFile(req, res, f) : notFound(res); } }
    if (p === '/__rubric/timeline.css') return sendFile(req, res, path.join(APP, 'editor-timeline.css'));
    if (p === '/__rubric/timeline.js') {
      const ns = u.searchParams.get('ns');
      const safe = ns && /^[\w.:-]{1,120}$/.test(ns) ? ns : 'rubric-editor';
      const js = (read(path.join(APP, 'editor-timeline.js')) || '').replace(/const NS = '[^']*';/, () => `const NS = ${JSON.stringify(safe)};`);
      return send(res, 200, 'text/javascript; charset=utf-8', js);
    }
    let m = p.match(/^\/projects\/([^/]+)\/(index\.html)?$/);
    if (m) {
      const proj = project(decodeURIComponent(m[1]));
      return proj ? send(res, 200, 'text/html; charset=utf-8', editorPage(proj)) : notFound(res);
    }
    if (p.match(/^\/projects\/[^/]+$/)) { res.writeHead(302, { ...HEADERS, Location: p + '/' }); return res.end(); }
    m = p.match(/^\/projects\/([^/]+)\/(.+)$/);
    if (m) {
      const proj = project(decodeURIComponent(m[1]));
      if (!proj) return notFound(res);
      let rel; try { rel = decodeURIComponent(m[2]); } catch (_) { return notFound(res); }
      const parts = rel.split('/');
      // never through here: your saved work (read it with the API), or hidden files
      if (parts.some(s => !s || s.startsWith('.') || s === '..') || /^rubric-state\.json/i.test(parts[parts.length - 1])) return notFound(res);
      const f = path.resolve(proj.dir, ...parts);
      if (!inside(proj.dir, f)) return notFound(res);
      if (!fs.existsSync(f) && parts.length === 1 && STUBS[rel]) return send(res, 200, 'text/javascript; charset=utf-8', STUBS[rel]);
      return sendFile(req, res, f);
    }
    if (p === '/favicon.ico') { res.writeHead(204, HEADERS); return res.end(); }
    return notFound(res);
  } catch (e) {
    if (e instanceof HttpError) return json(res, { error: e.message }, e.code);
    console.error(new Date().toISOString(), req.url, e && e.message);
    return json(res, { error: 'Server error' }, 500);
  }
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Pick another one: node server.mjs --port 50010 (or set PORT in env.local).\n`);
    process.exit(1);
  }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  const n = projects().length;
  console.log(`\n  Claude Video Editor ${VERSION} on http://127.0.0.1:${PORT}/`);
  console.log(`  ${n} project${n === 1 ? '' : 's'} in ${PROJECTS}${TOKEN ? '\n  RUBRIC_TOKEN is on: /api calls need the x-rubric-token header' : ''}\n`);
});
