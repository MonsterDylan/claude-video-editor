#!/usr/bin/env node
// Claude Video Editor: turn a cut into a project the editor can open. The /cut skill runs this for you; run it yourself for a
// cut you made somewhere else.
//
//   node tools/make-project.mjs path/to/spec.json
//
// Needs ffmpeg and ffprobe on your PATH. Reads the spec (what your clips are, see the README), then writes
// projects/<id>/: copies of your videos, posters, waveforms, filmstrips, a small proxy of any raw recording, and the five
// data files the editor reads. Run it again after a new version or a new cut: your saved comments, trims and approvals
// (rubric-state.json) are never touched.

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) { console.error('\n  make-project needs Node.js 18 or newer. You are running ' + process.version + '\n'); process.exit(1); }

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PEAKS_PER_SEC = 50, RAW_PEAKS_PER_SEC = 100, STRIP_W = 96, STRIP_H = 54;

// ---------- small helpers ----------
function die(msg) { console.error('\n  ' + msg + '\n'); process.exit(1); }
const fwd = p => p.split(path.sep).join('/');
const pad2 = n => String(n).padStart(2, '0');
const r3 = x => Math.round(x * 1000) / 1000;
const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40).replace(/-$/, '');
const validId = id => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(id) && !id.includes('..');
// how a file shows up in exports: relative to the kit when it lives inside it, otherwise its full path on this machine
const shown = f => { const r = path.relative(KIT, f); return r && !r.startsWith('..') && !path.isAbsolute(r) ? fwd(r) : fwd(f); };
function run(cmd, args) {
  const r = spawnSync(cmd, args, { windowsHide: true, maxBuffer: 1 << 30 });
  if (r.error) { if (r.error.code === 'ENOENT') die(`${cmd} was not found. Install ffmpeg (it includes ffprobe) and make sure it is on your PATH: https://ffmpeg.org/download.html`); throw r.error; }
  return r;
}
function ffmpeg(args, what) {
  const r = run('ffmpeg', ['-v', 'error', '-y', ...args]);
  if (r.status !== 0) die(`ffmpeg failed while ${what}:\n  ${String(r.stderr).trim().split('\n').slice(-4).join('\n  ')}`);
  return r;
}
function probe(file) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', file]);
  if (r.status !== 0) die(`ffprobe could not read ${file}. Is it a video or audio file?`);
  const j = JSON.parse(String(r.stdout)), streams = j.streams || [];
  const v = streams.find(s => s.codec_type === 'video'), a = streams.find(s => s.codec_type === 'audio');
  return { duration: Number(j.format && j.format.duration) || 0, video: v || null, audio: a || null, w: v ? v.width : 0, h: v ? v.height : 0 };
}
const fresh = (src, dest) => { try { return fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs; } catch (_) { return false; } };
const maxOf = (...lists) => lists.reduce((m, a) => a.reduce((x, v) => (v > x ? v : x), m), 0);   // no spread: long recordings have huge arrays

// ---------- reading the spec ----------
const specArg = process.argv[2];
if (!specArg || specArg === '--help' || specArg === '-h') {
  console.log('\n  Usage: node tools/make-project.mjs path/to/spec.json\n  The README shows what goes in the spec. Try it on the sample: node tools/make-project.mjs sample/spec.json\n');
  process.exit(specArg ? 0 : 1);
}
const SPEC_FILE = path.resolve(specArg);
let spec; try { spec = JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8')); } catch (e) { die(`Could not read ${SPEC_FILE}: ${e.message}`); }
const SPEC_DIR = path.dirname(SPEC_FILE);
const file = (p, what) => {
  if (!p || typeof p !== 'string') die(`${what} is missing in the spec.`);
  const f = path.resolve(SPEC_DIR, p);
  if (!fs.existsSync(f)) die(`${what} not found: ${f}`);
  return f;
};
if (!Array.isArray(spec.clips) || !spec.clips.length) die('The spec needs a "clips" list with at least one clip.');
const ID = spec.id || slug(spec.title) || slug(path.basename(SPEC_DIR));
if (!validId(ID)) die(`"id" must be letters, numbers, dots, dashes or underscores (got "${ID}").`);

// projects folder: PROJECTS_DIR from env.local if set, like the server
let projectsDir = path.join(KIT, 'projects');
try {
  const env = fs.readFileSync(path.join(KIT, 'env.local'), 'utf8').match(/^[ \t]*PROJECTS_DIR[ \t]*=[ \t]*(\S.*?)[ \t]*$/m);
  if (env && env[1]) projectsDir = path.resolve(KIT, env[1].replace(/^["']|["']$/g, ''));
} catch (_) {}
const OUT = path.join(projectsDir, ID);
fs.mkdirSync(OUT, { recursive: true });
run('ffprobe', ['-version']);

// ---------- words ----------
// Accepts [{text, start, end}], {words: [...]} or {segments: [{words: [...]}]}; "word" or "t" for the text, "s"/"e" for
// times. Seconds by default; milliseconds when the spec says "wordsUnit": "ms" or the numbers are clearly too big.
function readWords(f, unit, mediaLen) {
  let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { die(`Could not read the words file ${f}: ${e.message}`); }
  let list = Array.isArray(j) ? j : Array.isArray(j.words) ? j.words : Array.isArray(j.segments) ? j.segments.flatMap(s => s.words || []) : null;
  if (!list) die(`${f} has no words list. Use [{"text": "Hello", "start": 1.2, "end": 1.5}, ...].`);
  list = list.map(w => ({ t: String(w.text ?? w.word ?? w.t ?? '').trim(), s: Number(w.start ?? w.s), e: Number(w.end ?? w.e) }))
    .filter(w => w.t && isFinite(w.s) && isFinite(w.e));
  const top = maxOf(list.map(w => w.e));
  const ms = unit === 'ms' || (unit !== 's' && top > 1000 && mediaLen > 0 && top > mediaLen * 3);
  return list.map(w => ({ t: w.t, s: r3(ms ? w.s / 1000 : w.s), e: r3(Math.max(ms ? w.e / 1000 : w.e, ms ? w.s / 1000 : w.s)) }))
    .sort((a, b) => a.s - b.s);
}
const sentenceEnd = t => /[.!?]["')\]]*$/.test(t);
const tokensOf = words => words.map((w, i) => ({ t: w.t, s: w.s, e: w.e, ...(sentenceEnd(w.t) && i < words.length - 1 ? { br: 1 } : {}) }));

// ---------- sound ----------
// peak level per slice of time on a gentle curve (0..1), from any file with audio
function envelope(f, perSec, from, to) {
  const args = [];
  if (from != null) args.push('-ss', String(from), '-to', String(to));
  args.push('-i', f, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-');
  const r = run('ffmpeg', ['-v', 'error', ...args]);
  if (r.status !== 0 || !r.stdout || !r.stdout.length) return [];
  const buf = r.stdout, n = Math.floor(buf.length / 2), step = Math.floor(8000 / perSec), out = [];
  for (let i = 0; i < n; i += step) {
    let m = 0; for (let k = i; k < Math.min(n, i + step); k++) { const v = Math.abs(buf.readInt16LE(k * 2)); if (v > m) m = v; }
    out.push(Math.pow(m / 32768, 0.6));
  }
  return out;
}
const to99 = (arr, top) => arr.map(x => Math.round(Math.min(99, (x / (top || 1)) * 99)));

// ---------- pictures ----------
function poster(video, dest, t, vertical) {
  ffmpeg(['-ss', String(t), '-i', video, '-frames:v', '1', '-vf', vertical ? 'scale=-2:1280' : 'scale=1280:-2', '-q:v', '4', dest], 'making a poster');
}
// one frame from the middle of each second, in a grid (the timeline's filmstrip)
function strip(video, dest, from, seconds) {
  const n = Math.max(1, Math.ceil(seconds)), cols = Math.min(n, 60), rows = Math.ceil(n / cols);
  ffmpeg(['-ss', String(from + 0.5), '-i', video, '-vf',
    `fps=1,scale=${STRIP_W}:${STRIP_H}:force_original_aspect_ratio=decrease,pad=${STRIP_W}:${STRIP_H}:(ow-iw)/2:(oh-ih)/2:color=black,tile=${cols}x${rows}`,
    '-frames:v', '1', '-q:v', '4', dest], 'making a filmstrip');
  return { strip: n, cols };
}

// ---------- media copies ----------
// Browsers play mp4/webm with h264, vp8, vp9 or av1: those are copied as they are, anything else becomes an h264 mp4.
function videoCopy(src, info, destBase) {
  const ext = path.extname(src).toLowerCase();
  const ok = ['.mp4', '.m4v', '.webm'].includes(ext) && info.video && ['h264', 'vp8', 'vp9', 'av1'].includes(info.video.codec_name) &&
    (!info.audio || ['aac', 'mp3', 'opus', 'vorbis'].includes(info.audio.codec_name));
  const dest = destBase + (ok ? ext : '.mp4');
  if (fresh(src, dest)) return dest;
  if (ok) fs.copyFileSync(src, dest);
  else ffmpeg(['-i', src, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', dest], `converting ${path.basename(src)} to mp4`);
  return dest;
}
function audioCopy(src, destBase) {
  const ext = path.extname(src).toLowerCase(), ok = ['.wav', '.mp3', '.m4a', '.ogg', '.opus', '.flac'].includes(ext);
  const dest = destBase + (ok ? ext : '.wav');
  if (fresh(src, dest)) return dest;
  if (ok) fs.copyFileSync(src, dest); else ffmpeg(['-i', src, '-vn', '-c:a', 'pcm_s16le', dest], `converting ${path.basename(src)} to wav`);
  return dest;
}
function proxy(raw, dest, t0, t1, vertical) {
  // rebuilt when the raw file changes or the kept range moves (the proxy covers t0..t1 only)
  const meta = dest + '.json', want = JSON.stringify({ t0, t1, size: fs.statSync(raw).size });
  let had = null; try { had = fs.readFileSync(meta, 'utf8'); } catch (_) {}
  if (fresh(raw, dest) && had === want) return;
  ffmpeg(['-ss', String(t0), '-to', String(t1), '-i', raw, '-vf', vertical ? 'scale=540:-2' : 'scale=-2:540', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
    '-g', '15', '-keyint_min', '15', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', dest], 'making the raw proxy');
  fs.writeFileSync(meta, want);
}

// ---------- time on the raw recording ----------
function checkKeeps(keeps, rawLen, clipName) {
  if (!Array.isArray(keeps) || !keeps.length) die(`Clip "${clipName}" has "raw" but no "keeps". List the raw seconds your cut uses, in order: [[3.2, 10.8], [12.1, 20.0]].`);
  let last = -1;
  return keeps.map((k, i) => {
    const [a, b] = (Array.isArray(k) ? k : []).map(Number);
    if (!(isFinite(a) && isFinite(b) && b > a)) die(`Clip "${clipName}": keep ${i + 1} must be [start, end] with end after start.`);
    if (a < last - 1e-3) die(`Clip "${clipName}": keeps must be in order and must not overlap (keep ${i + 1} starts at ${a}).`);
    if (a > rawLen + 0.05) die(`Clip "${clipName}": keep ${i + 1} starts at ${a} s but the raw recording is only ${rawLen.toFixed(2)} s long.`);
    last = b;
    return [r3(a), r3(Math.min(b, rawLen))];
  });
}
function rawToEdit(t, keeps) {
  let acc = 0;
  for (const [a, b] of keeps) { if (t < a) return acc; if (t <= b) return acc + (t - a); acc += b - a; }
  return acc;
}

// ---------- build ----------
const conf0 = (() => { try { return JSON.parse(fs.readFileSync(path.join(OUT, 'rubric.json'), 'utf8')); } catch (_) { return {}; } })();
const REELS = [], SOURCE = {}, FIXES = {};
let orientation = spec.orientation === 'vertical' || spec.orientation === 'landscape' ? spec.orientation : null;
const seen = new Set();

spec.clips.forEach((clip, ci) => {
  const title = String(clip.title || `Clip ${ci + 1}`);
  const cid = clip.id ? String(clip.id) : `${pad2(ci + 1)}-${slug(title) || 'clip'}`;
  if (!validId(cid)) die(`Clip id "${cid}" must be letters, numbers, dots, dashes or underscores.`);
  if (seen.has(cid)) die(`Two clips share the id "${cid}". Give each clip its own "id".`);
  seen.add(cid);
  const mdir = path.join(OUT, 'media', cid); fs.mkdirSync(mdir, { recursive: true });
  const versions = Array.isArray(clip.versions) && clip.versions.length ? clip.versions
    : [{ video: clip.video, note: clip.note, words: clip.words, layers: clip.layers, fixes: clip.fixes }];
  const scenes = (clip.scenes || []).map((s, i) => ({ n: i + 1, s: r3(Number(s.s ?? s.start)), e: r3(Number(s.e ?? s.end)),
    visual: String(s.visual || 'shot'), asset: '', title: String(s.title || ''), layout: String(s.layout || 'full') })).filter(s => isFinite(s.s) && isFinite(s.e));

  // the raw recording this clip was cut from (optional)
  let raw = null;
  if (clip.raw) {
    const rawFile = file(clip.raw, `Clip "${title}": raw`), info = probe(rawFile);
    if (!info.video) die(`Clip "${title}": the raw file has no video.`);
    const keeps = checkKeeps(clip.keeps, info.duration, title);
    const notes = (clip.removed || []).map(x => ({ a: Number(x.from), b: Number(x.to ?? x.from), why: String(x.why || x.reason || 'removed') }))
      .filter(x => isFinite(x.a) && isFinite(x.b));
    const pad = Math.max(0, Number(clip.rawPadding ?? spec.rawPadding ?? 5));
    const first = Math.min(keeps[0][0], ...notes.map(x => x.a));
    const t0 = r3(Math.max(0, first - pad)), t1 = r3(Math.min(info.duration, keeps[keeps.length - 1][1] + pad));
    const removed = [];
    let cur = t0;
    const gap = (a, b) => {
      if (b - a < 0.01) return;
      let why = notes.filter(x => x.a < b - 0.01 && x.b > a + 0.01).map(x => x.why);
      if (!why.length) why = [b <= keeps[0][0] + 1e-3 ? 'before the first kept part' : a >= keeps[keeps.length - 1][1] - 1e-3 ? 'after the last kept part' : 'removed in the cut'];
      removed.push({ s: r3(a), e: r3(b), why: [...new Set(why)] });
    };
    for (const [a, b] of keeps) { if (a > cur + 0.01) gap(cur, a); cur = Math.max(cur, b); }
    if (cur < t1 - 0.01) gap(cur, t1);
    const words = clip.rawWords ? readWords(file(clip.rawWords, `Clip "${title}": rawWords`), clip.wordsUnit || spec.wordsUnit, info.duration)
      .filter(w => w.s >= t0 && w.s < t1) : [];
    const vertical = info.h > info.w;
    const proxyFile = path.join(mdir, 'raw-proxy.mp4'), stripFile = path.join(mdir, 'raw-strip.jpg');
    proxy(rawFile, proxyFile, t0, t1, vertical);
    const st = strip(proxyFile, stripFile, 0, t1 - t0);
    const pk = envelope(rawFile, RAW_PEAKS_PER_SEC, t0, t1), top = maxOf(pk);
    raw = { keeps, words };
    SOURCE[cid] = { id: cid, title, num: pad2(ci + 1), source: shown(rawFile), folder: shown(path.dirname(rawFile)), t0, t1, keeps, removed, words,
      peaksPerSec: RAW_PEAKS_PER_SEC, peaks: to99(pk, top), proxy: fwd(path.relative(OUT, proxyFile)), proxyT0: t0,
      strip: fwd(path.relative(OUT, stripFile)), stripSeconds: st.strip, stripCols: st.cols, stripW: STRIP_W, stripH: STRIP_H, stripT0: t0,
      applyHint: String(clip.applyHint || 'New kept ranges for this clip (raw seconds). Put them in "keeps" for this clip in the spec, re-cut the clip, then run make-project again:') };
    console.log(`  ${cid}: raw ${t0}-${t1} s, ${keeps.length} kept parts, ${removed.length} removed parts, ${words.length} words`);
  }

  versions.forEach((v, vi) => {
    const k = vi + 1, vid = `${cid}@v${k}`;
    const src = file(v.video, `Clip "${title}" version ${k}: video`), info = probe(src);
    if (!info.video) die(`${src} has no video stream.`);
    const vertical = info.h > info.w;
    if (!orientation) orientation = vertical ? 'vertical' : 'landscape';
    const dur = r3(info.duration);
    const dest = videoCopy(src, info, path.join(mdir, `v${k}`));
    const posterFile = path.join(mdir, `v${k}-poster.jpg`);
    if (!fresh(src, posterFile)) poster(src, posterFile, Math.min(1, dur / 2), vertical);
    // words: this version's own file, or the raw recording's words mapped onto the cut (a straight cut of the kept parts)
    let words = [];
    if (v.words) words = readWords(file(v.words, `Clip "${title}" version ${k}: words`), v.wordsUnit || clip.wordsUnit || spec.wordsUnit, dur);
    else if (raw && raw.words.length) words = raw.words.filter(w => raw.keeps.some(([a, b]) => (w.s + w.e) / 2 >= a && (w.s + w.e) / 2 < b))
      .map(w => ({ t: w.t, s: r3(rawToEdit(w.s, raw.keeps)), e: r3(rawToEdit(w.e, raw.keeps)) }));
    if (raw && vi === versions.length - 1) {
      const kept = raw.keeps.reduce((a, [s, e]) => a + e - s, 0);
      if (Math.abs(kept - dur) > 0.5) console.log(`  note: "${title}" v${k} is ${dur.toFixed(2)} s but its kept parts add up to ${kept.toFixed(2)} s. The timeline lines them up by shared words when it has them, otherwise it assumes the cut plays the kept parts back to back.`);
    }
    // sound: the version's mix, plus any layers, on one scale so a quiet layer looks quiet
    const mix = info.audio ? envelope(src, PEAKS_PER_SEC) : [];
    const layerIds = new Set();
    const layers = (v.layers || clip.layers || []).map((l, li) => {
      const lf = file(l.file, `Clip "${title}" version ${k}: layer ${li + 1} file`);
      let id = slug(l.id || l.name) || `layer-${li + 1}`; while (layerIds.has(id)) id += '-2'; layerIds.add(id);
      const copy = audioCopy(lf, path.join(mdir, `v${k}-${id}`));
      return { id, name: String(l.name || id), src: fwd(path.relative(OUT, copy)), file: shown(lf), env: envelope(lf, PEAKS_PER_SEC) };
    });
    const top = maxOf(mix, ...layers.map(l => l.env));
    const reel = { id: vid, base: cid, version: `v${k}`, versionNote: String(v.note || (k === 1 ? 'first cut' : `version ${k}`)), note: String(v.note || ''),
      num: pad2(ci + 1), title, keyword: null, duration: dur, folder: shown(path.dirname(src)), fullVideo: shown(src),
      video: fwd(path.relative(OUT, dest)), poster: fwd(path.relative(OUT, posterFile)), scenes, tokens: tokensOf(words),
      peaksPerSec: PEAKS_PER_SEC, peaks: mix.length ? to99(mix, top) : new Array(Math.ceil(dur * PEAKS_PER_SEC)).fill(0), remake: k > 1 };
    if (!raw) {   // no raw recording: the clip is its own timeline, with its own filmstrip
      const stripFile = path.join(mdir, `v${k}-strip.jpg`);
      const st = fresh(src, stripFile) ? { strip: Math.max(1, Math.ceil(dur)), cols: Math.min(Math.max(1, Math.ceil(dur)), 60) } : strip(src, stripFile, 0, dur);
      Object.assign(reel, { strip: fwd(path.relative(OUT, stripFile)), stripW: STRIP_W, stripH: STRIP_H, stripCols: st.cols, stripT0: 0, stripSeconds: st.strip });
    }
    if (layers.length) reel.layers = layers.map(({ env, ...l }) => ({ ...l, peaksPerSec: PEAKS_PER_SEC, peaks: to99(env, top) }));
    const fx = (v.fixes || []).map(f => ({ t: r3(Number(f.t) || 0), label: String(f.label || f.text || '') })).filter(f => f.label);
    if (fx.length) FIXES[vid] = fx;
    REELS.push(reel);
    console.log(`  ${vid}: ${dur.toFixed(2)} s, ${words.length} words${layers.length ? ', layers: ' + layers.map(l => l.name).join(', ') : ''}`);
  });
});

// ---------- write the data files ----------
const title = String(spec.title || ID);
const writeJs = (name, text) => fs.writeFileSync(path.join(OUT, name), text);
writeJs('reels-data.js', '// Written by tools/make-project.mjs. Edit the spec and run it again rather than editing this file.\n' +
  'window.REEL_BATCH = ' + JSON.stringify({ name: title, dir: shown(OUT), orientation: orientation || 'landscape' }) + ';\n' +
  'window.REELS = ' + JSON.stringify(REELS) + ';\n');
writeJs('source-data.js', '// The raw recording behind each clip that has one (kept parts, removed parts, words, waveform, proxy, filmstrip).\n' +
  'window.SOURCE = ' + JSON.stringify(SOURCE) + ';\n');
writeJs('fixes.js', '// What each version fixed, from "fixes" in the spec. Shows as "Fixed in V2" above the comments.\nwindow.FIXES = ' + JSON.stringify(FIXES, null, 1) + ';\n');
if (!fs.existsSync(path.join(OUT, 'approvals.js'))) writeJs('approvals.js', '// Clips signed off outside the editor: { "<clip id>": { "version": "v2", "date": "2026-01-31" } }. A click on Approve in the editor wins.\nwindow.APPROVED = {};\n');
if (!fs.existsSync(path.join(OUT, 'resolutions.js'))) writeJs('resolutions.js', '// Comments a later version applied, per version id: { "<clip>@v1": [{ "type": "pin", "t": 3.2, "x": 0.4, "y": 0.6, "in": "v2", "how": "..." }] }.\nwindow.RESOLVED = {};\n');
const conf = { ...conf0, title, kicker: String(spec.kicker ?? conf0.kicker ?? ''), orientation: orientation || 'landscape',
  created: conf0.created || new Date().toISOString(), built: new Date().toISOString(), spec: shown(SPEC_FILE),
  storeKey: conf0.storeKey || `rubric-editor-${ID}`, ns: conf0.ns || conf0.storeKey || `rubric-editor-${ID}` };
fs.writeFileSync(path.join(OUT, 'rubric.json'), JSON.stringify(conf, null, 1) + '\n');

let port = 50002;
try { const m = fs.readFileSync(path.join(KIT, 'env.local'), 'utf8').match(/^[ \t]*PORT[ \t]*=[ \t]*(\d+)[ \t]*$/m); if (m) port = Number(m[1]); } catch (_) {}
console.log(`\n  Done: ${REELS.length} version${REELS.length === 1 ? '' : 's'} of ${spec.clips.length} clip${spec.clips.length === 1 ? '' : 's'} in ${shown(OUT)}`);
console.log(`  With the server running (node server.mjs), open http://127.0.0.1:${port}/projects/${ID}/\n`);
