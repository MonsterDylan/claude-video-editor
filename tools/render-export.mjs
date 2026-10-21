#!/usr/bin/env node
// Claude Video Editor: render what you asked for with the editor's Export button.
//
//   node tools/render-export.mjs [<project id>] [--id <request id>] [--list] [--dry] [--again]
//
// Export saves a request in the project (size, clips, your trims, approvals) and copies a one-line ask that names its id.
// This renders that request. No project = the newest request in any project; no --id = that project's newest request.
// --list shows a project's requests, --dry prints the plan and renders nothing, --again renders a request a second time.
//
// A clip with raw footage is cut from the raw recording at your trims (picture and sound on the same frame edges, so lip
// sync cannot drift), cropped to the size's shape around the centre of the frame (or rubric.json "exportCrop"
// { x, y, w, h } on the raw frame), scaled, and its sound levelled with loudnorm. A clip with no raw footage renders from
// its own finished video. Each file goes to projects/<project>/exports/<clip>-<W>x<H>.mp4 (never overwritten: -2, -3),
// is checked with ffprobe and a full decode, and is logged in exports/export-log.json. Needs ffmpeg on your PATH.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fwd = p => String(p).split(path.sep).join('/');
const die = m => { console.error('\n  ' + m + '\n'); process.exit(1); };
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.error && r.error.code === 'ENOENT') die(`${cmd} was not found. Install ffmpeg (it includes ffprobe): https://ffmpeg.org/download.html`);
  return r;
};

let PROJECTS = path.join(KIT, 'projects');
try {
  const m = fs.readFileSync(path.join(KIT, 'env.local'), 'utf8').match(/^[ \t]*PROJECTS_DIR[ \t]*=[ \t]*(\S.*?)[ \t]*$/m);
  if (m && m[1]) PROJECTS = path.resolve(KIT, m[1].replace(/^["']|["']$/g, ''));
} catch (_) {}

const args = process.argv.slice(2), flag = k => args.includes(k);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const projArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--id');

function requestsIn(dir) {
  let st; try { st = JSON.parse(fs.readFileSync(path.join(dir, 'rubric-state.json'), 'utf8')); } catch (_) { return []; }
  const out = [];
  for (const [k, v] of Object.entries(st.keys || {})) {
    if (!k.endsWith(':export')) continue;
    try { out.push(...(JSON.parse(v).requests || []).filter(r => r && r.id)); } catch (_) {}
  }
  return out.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
}
function probe(file) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate,start_time:format=duration,start_time', '-of', 'json', file]);
  if (r.status !== 0) return null;
  const j = JSON.parse(r.stdout), v = (j.streams || []).find(s => s.codec_type === 'video');
  if (!v) return null;
  const num = x => (x == null || x === 'N/A' ? 0 : Number(x)), [n, d] = String(v.r_frame_rate || '30/1').split('/').map(Number);
  return { w: v.width, h: v.height, rate: v.r_frame_rate || '30/1', fps: n / (d || 1), voff: num(v.start_time) - num(j.format && j.format.start_time),
    dur: num(j.format && j.format.duration), audio: (j.streams || []).some(s => s.codec_type === 'audio') };
}
// the part of the frame that fills W x H: rubric.json exportCrop when it fits, else centred
function cropFor(sw, sh, W, H, conf) {
  const ar = W / H, c = conf.exportCrop;
  if (c && ['x', 'y', 'w', 'h'].every(k => typeof c[k] === 'number')) {
    const { x, y, w, h } = c;
    if (x >= 0 && y >= 0 && x + w <= sw && y + h <= sh && Math.abs(w / h - ar) / ar < 0.02) return [[x, y, w, h], 'rubric.json exportCrop'];
    console.log(`  note: rubric.json exportCrop does not fit a ${sw}x${sh} frame at ${W}x${H}, so the crop is centred`);
  }
  if (Math.abs(sw / sh - ar) / ar < 0.005) return [[0, 0, sw, sh], 'whole frame'];
  if (sw / sh > ar) { const cw = Math.round(sh * ar / 2) * 2; return [[Math.floor((sw - cw) / 2), 0, cw, sh], 'centred']; }
  const ch = Math.round(sw / ar / 2) * 2; return [[0, Math.floor((sh - ch) / 2), sw, ch], 'centred'];
}
let gpu = null;
// an NVIDIA card encodes several times faster; RUBRIC_NO_GPU=1 forces the CPU encoder
const nvenc = () => gpu ??= !process.env.RUBRIC_NO_GPU && run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2', '-c:v', 'h264_nvenc', '-f', 'null', '-']).status === 0;
const venc = (useGpu, gop) => useGpu
  ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '18', '-b:v', '0', '-g', String(gop), '-bf', '0', '-pix_fmt', 'yuv420p']
  : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-g', String(gop), '-pix_fmt', 'yuv420p'];

// the raw recording cut at the kept ranges: one decode per forward run, every part the same length in picture and sound
function rawGraph(src, keeps, info, W, H, crop) {
  const { fps, voff } = info, frames = [];
  keeps.forEach(([a, b]) => { const fa = Math.round((a - voff) * fps), fb = Math.round((b - voff) * fps); if (fb > fa) { const p = frames[frames.length - 1]; if (p && p[1] === fa) p[1] = fb; else frames.push([fa, fb]); } });
  const runs = [];
  frames.forEach(k => { const r = runs[runs.length - 1]; if (r && k[0] >= r[r.length - 1][1] && (k[0] - r[r.length - 1][1]) / fps <= 8) r.push(k); else runs.push([k]); });
  const ins = [], g = []; let n = 0;
  runs.forEach((grp, ri) => {
    const first = Math.max(0, (grp[0][0] - Math.round(fps)) / fps + voff);
    ins.push('-ss', first.toFixed(6), '-to', (grp[grp.length - 1][1] / fps + voff + 0.5).toFixed(6), '-i', src);
    const at = k => k / fps + voff - first;
    g.push(`[${ri}:v:0]split=${grp.length}` + grp.map((_, i) => `[v${n + i}]`).join(''), `[${ri}:a:0]asplit=${grp.length}` + grp.map((_, i) => `[a${n + i}]`).join(''));
    grp.forEach(([fa, fb], i) => g.push(`[v${n + i}]trim=start=${Math.max(0, at(fa - 0.5)).toFixed(6)}:end=${at(fb - 0.5).toFixed(6)},setpts=PTS-STARTPTS[x${n + i}]`,
      `[a${n + i}]atrim=start=${Math.max(0, at(fa)).toFixed(6)}:end=${at(fb).toFixed(6)},asetpts=PTS-STARTPTS[y${n + i}]`));
    n += grp.length;
  });
  const [x, y, cw, ch] = crop;
  g.push(Array.from({ length: n }, (_, i) => `[x${i}][y${i}]`).join('') + `concat=n=${n}:v=1:a=1[cv][ca]`,
    `[cv]crop=${cw}:${ch}:${x}:${y},scale=${W}:${H}:flags=lanczos,setsar=1,fps=${info.rate}[vo]`,
    '[ca]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=7,aresample=48000[ao]');
  return { ins, graph: g.join(';\n'), frames, runs: runs.length };
}

function renderClip(dir, conf, req, clip, dry, taken) {
  const W = Number(req.width), H = Number(req.height), label = `${clip.num || ''} ${clip.id}`.trim();
  const stem = `${String(clip.id).replace('@', '-')}-${W}x${H}`;   // 01-intro@v2 -> 01-intro-v2-1920x1080.mp4
  const out = (() => { let p = path.join(dir, 'exports', `${stem}.mp4`), k = 2; while (fs.existsSync(p) || taken.has(p)) p = path.join(dir, 'exports', `${stem}-${k++}.mp4`); taken.add(p); return p; })();
  const local = p => (p ? (path.isAbsolute(p) ? p : path.resolve(KIT, p)) : null);
  let cmd, expected, script = null, info;
  if (clip.keeps && clip.keeps.length) {
    const src = local(clip.source);
    info = src && fs.existsSync(src) ? probe(src) : null;
    if (!info) return { clip: clip.id, ok: false, why: 'raw recording not found or unreadable: ' + (clip.source || '-') };
    const [crop, how] = cropFor(info.w, info.h, W, H, conf);
    const g = rawGraph(src, clip.keeps, info, W, H, crop);
    if (!g.frames.length) return { clip: clip.id, ok: false, why: 'every part is deleted, nothing to render' };
    expected = g.frames.reduce((a, [fa, fb]) => a + fb - fa, 0) / info.fps;
    console.log(`${label}: raw ${fwd(clip.source)} (${info.w}x${info.h}), ${g.frames.length} kept parts, ${clip.trims || 0} trim(s), crop ${crop[2]}x${crop[3]} (${how})`);
    if (dry) { console.log(`  would write ${fwd(out)}, ${expected.toFixed(2)} s`); return { clip: clip.id, ok: true, dry: true }; }
    script = out + '.filter.txt';
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(script, g.graph);
    cmd = useGpu => ['-y', '-v', 'error', ...g.ins, '-filter_complex_script', script, '-map', '[vo]', '-map', '[ao]', ...venc(useGpu, Math.max(1, Math.round(info.fps))),
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-movflags', '+faststart', out];
  } else {
    const src = [local(clip.fullVideo), path.join(dir, String(clip.video || ''))].find(p => p && fs.existsSync(p));
    info = src ? probe(src) : null;
    if (!info) return { clip: clip.id, ok: false, why: 'finished video not found: ' + (clip.fullVideo || clip.video || '-') };
    const [[x, y, cw, ch], how] = cropFor(info.w, info.h, W, H, conf);
    expected = info.dur;
    console.log(`${label}: finished video ${fwd(path.relative(KIT, src))} (${info.w}x${info.h}), crop ${cw}x${ch} (${how})`);
    if (dry) { console.log(`  would write ${fwd(out)}, ${expected.toFixed(2)} s`); return { clip: clip.id, ok: true, dry: true }; }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    cmd = useGpu => ['-y', '-v', 'error', '-i', src, '-vf', `crop=${cw}:${ch}:${x}:${y},scale=${W}:${H}:flags=lanczos,setsar=1`, '-map', '0:v:0', '-map', '0:a:0?',
      ...venc(useGpu, Math.max(1, Math.round(info.fps))), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out];
  }
  const t = Date.now();
  let r = run('ffmpeg', cmd(nvenc()));
  if (r.status !== 0 && gpu) r = run('ffmpeg', cmd(false));   // a GPU encoder hiccup: the same job on the CPU
  if (script) fs.unlinkSync(script);
  if (r.status !== 0) return { clip: clip.id, ok: false, why: 'ffmpeg failed: ' + String(r.stderr).trim().slice(-300) };
  const got = probe(out), dec = run('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-']);
  const ok = !!got && got.w === W && got.h === H && got.audio === info.audio && Math.abs(got.dur - expected) <= 0.1 && !String(dec.stderr).trim();
  return { clip: clip.id, path: fwd(out), ok, width: got && got.w, height: got && got.h, seconds: got && +got.dur.toFixed(3), expected: +expected.toFixed(3),
    sound: !!(got && got.audio), decodeErrors: String(dec.stderr).trim().slice(0, 300), renderSeconds: +((Date.now() - t) / 1000).toFixed(1) };
}

// ---------- which request ----------
let dir, reqs;
if (projArg) {
  dir = path.resolve(PROJECTS, projArg);
  if (!fs.existsSync(path.join(dir, 'reels-data.js'))) die(`No project "${projArg}" in ${fwd(PROJECTS)}`);
  reqs = requestsIn(dir);
} else {
  let best = null;
  for (const name of fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS) : []) {
    const d = path.join(PROJECTS, name);
    for (const r of requestsIn(d)) if ((!opt('--id') || r.id === opt('--id')) && (!best || String(r.at) > String(best[1].at))) best = [d, r];
  }
  if (!best) die('No export request in any project' + (opt('--id') ? ' with id ' + opt('--id') : '') + '. Click Export in the editor first.');
  dir = best[0]; reqs = requestsIn(dir);
}
const logFile = path.join(dir, 'exports', 'export-log.json');
const log = (() => { try { return JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch (_) { return { runs: [] }; } })();
const doneIds = new Map(log.runs.map(x => [x.request, x]));
if (flag('--list')) {
  if (!reqs.length) console.log('No export requests in ' + path.basename(dir));
  reqs.forEach(r => console.log(`${r.id}  ${r.at}  ${r.scope}  ${r.width}x${r.height}  ${(r.clips || []).map(c => c.num || c.id).join(', ')}  ${doneIds.has(r.id) ? 'rendered' : 'not rendered'}`));
  process.exit(0);
}
const req = opt('--id') ? reqs.find(r => r.id === opt('--id')) : reqs[reqs.length - 1];
if (!req) die(`No export request ${opt('--id') || ''} in ${path.basename(dir)}`);
console.log(`project ${path.basename(dir)}\nrequest ${req.id} from ${req.at}: ${req.scope} at ${req.width}x${req.height}, ${req.clips.length} clip(s)`);
if (doneIds.has(req.id) && !flag('--again') && !flag('--dry')) {
  console.log('Already rendered (add --again to render it again):');
  doneIds.get(req.id).files.forEach(f => console.log('  ' + (f.path || f.why)));
  process.exit(0);
}
const conf = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'rubric.json'), 'utf8')); } catch (_) { return {}; } })();
if (!flag('--dry')) console.log('encoder: ' + (nvenc() ? 'h264_nvenc (GPU)' : 'libx264'));
const taken = new Set();
const results = req.clips.map(c => renderClip(dir, conf, req, c, flag('--dry'), taken));
if (flag('--dry')) process.exit(0);
log.runs.push({ request: req.id, requested: req.at, rendered: new Date().toISOString(), size: `${req.width}x${req.height}`, scope: req.scope, files: results });
fs.mkdirSync(path.dirname(logFile), { recursive: true });
fs.writeFileSync(logFile, JSON.stringify(log, null, 1));
console.log('');
results.forEach(x => console.log(x.path
  ? `${x.ok ? 'OK   ' : 'CHECK'} ${x.path}  ${x.width}x${x.height}, ${x.seconds} s (trims ${x.expected} s), sound ${x.sound ? 'yes' : 'no'}, ${x.renderSeconds} s to render${x.decodeErrors ? ', decode errors: ' + x.decodeErrors : ''}`
  : `FAIL  ${x.clip}: ${x.why}`));
process.exit(results.some(x => !x.ok) ? 1 : 0);
