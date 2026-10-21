#!/usr/bin/env node
// /cut step 3: cut the recording by plan.json, put the cut on the Claude Video Editor.
//
//   node cut.mjs <work folder | plan.json> [--dry] [--full] [--force] [--no-editor]
//
// plan.json (your agent writes it from sentences.txt, see SKILL.md):
//   { "title": "My video", "sections": [ { "title": "Intro", "keep": [[1.2, 4.5], [16.4, 20.5]],
//       "why": { "4.5": "false start, redone at 16.4 s" } } ] }
// keep = the raw seconds to keep, in play order. Each edge is moved into the nearest real pause on the audio, with about
// 0.1 s of air before the first word and after the last ("exact": true on a section keeps its edges as written).
//
// --dry   writes cut-review.md (every kept and cut part with its words, plus CHECK lines) and stops: read it first.
// Without --dry it also cuts a review copy of each section (720p; --full keeps the recording's own size) into cuts/,
// writes spec.json and builds the editor project with the Claude Video Editor's tools/make-project.mjs. A section whose keeps
// changed gets a new version (V2, V3) beside the old one, so the editor shows what changed. --force re-cuts everything.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { settings, editorDir, die, ffmpeg, probe, samples, readWords, slug, pad2, r3, fwd } from './lib.mjs';

const args = process.argv.slice(2), flag = k => args.includes(k);
const target = args.find(a => !a.startsWith('--'));
if (!target) die('Usage: node cut.mjs <work folder | plan.json> [--dry] [--full] [--force] [--no-editor]');
const PLAN_FILE = path.resolve(fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, 'plan.json') : target);
const WORK = path.dirname(PLAN_FILE);
if (!fs.existsSync(PLAN_FILE)) die('No plan.json in ' + fwd(WORK) + '. Write it from sentences.txt first (SKILL.md, step 2).');
let plan; try { plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')); } catch (e) { die('plan.json is not valid JSON: ' + e.message); }
const rec = (() => { try { return JSON.parse(fs.readFileSync(path.join(WORK, 'recording.json'), 'utf8')); } catch (_) { return {}; } })();
const RAW = path.resolve(WORK, plan.recording || rec.recording || '');
if (!fs.existsSync(RAW) || fs.statSync(RAW).isDirectory()) die('Recording not found. Set "recording" in plan.json to its path.');
const S = settings(), AIR = Number(S.air ?? 0.1), EDITOR = editorDir(S);
// a path as the editor and the review show it: relative to the Claude Video Editor folder when it is inside it
const shown = f => { const r = path.relative(EDITOR, f); return r && !r.startsWith('..') && !path.isAbsolute(r) ? fwd(r) : fwd(f); };
const info = probe(RAW), FPS = info.fps, VOFF = info.voff;
const WORDS = readWords(path.join(WORK, 'words.json'));
const sections = Array.isArray(plan.sections) ? plan.sections : [];
if (!sections.length) die('plan.json needs a "sections" list with at least one section.');

// ---------- the sound, 10 ms at a time ----------
const x = samples(RAW, 16000), N = Math.floor(x.length / 160), db = new Float32Array(N);
for (let i = 0; i < N; i++) { let s = 0; for (let k = i * 160; k < i * 160 + 160; k++) s += x[k] * x[k]; db[i] = 10 * Math.log10(s / 160 + 1e-12); }
const sorted = Float32Array.from(db).sort();
const FLOOR = sorted[Math.floor(N * 0.1)];
const QUIET = S.quietDb != null ? Number(S.quietDb) : Math.min(-30, Math.max(-60, FLOOR + 14));   // room noise plus a margin
const loud = i => i >= 0 && i < N && db[i] > QUIET;
const quietFor = (i, n) => { for (let k = 0; k < n; k++) if (loud(i + k)) return false; return true; };
const F = t => Math.round(t * 100);

// a start edge: back to where the sound under it begins, or on to the first sound after it, then AIR before that
function startEdge(a, floorT) {
  let i = F(a), onset = null, note = null;
  if (loud(i) || !quietFor(i, 3)) {
    for (let j = i; j > F(a - 0.8); j--) if (quietFor(j - 12, 12)) { onset = j / 100; break; }
    if (onset == null) { onset = a; note = `start ${a.toFixed(2)} s sits inside sound with no pause within 0.8 s before it: listen there`; }
  } else {
    for (let j = i; j < F(a + 1.5); j++) if (loud(j) && loud(j + 1)) { onset = j / 100; break; }
    if (onset == null) { onset = a; note = `no sound within 1.5 s after the start at ${a.toFixed(2)} s`; }
  }
  return { t: Math.max(floorT, onset - AIR), note };
}
// an end edge: on to where the sound ends (a 0.25 s pause), or back to the last sound before it, then AIR after that
function endEdge(b, ceilT) {
  let i = F(b), offset = null, note = null;
  if (!quietFor(i, 25)) {
    for (let j = i; j < F(b + 1.2); j++) if (quietFor(j, 25)) { offset = j / 100; break; }
    if (offset == null) { offset = b; note = `end ${b.toFixed(2)} s sits inside sound with no pause within 1.2 s after it: listen there`; }
  } else {
    for (let j = i; j > F(b - 1.5); j--) if (loud(j - 1)) { offset = j / 100; break; }
    if (offset == null) { offset = b; note = `no sound within 1.5 s before the end at ${b.toFixed(2)} s`; }
  }
  return { t: Math.min(ceilT, offset + AIR + 0.02), note };
}
const onFrame = t => r3(VOFF + Math.round((t - VOFF) * FPS) / FPS);   // picture and sound cut on the same frame edge

// ---------- edges, words and checks per section ----------
const wordsIn = (a, b) => WORDS.filter(w => { const m = (w.start + w.end) / 2; return m >= a && m < b; });
const said = list => list.map(w => w.text).join(' ');
const whyAt = (sec, a, b) => {
  const hits = Object.entries(sec.why || {}).filter(([k]) => Number(k) >= a - 0.6 && Number(k) <= b + 0.6).map(([, v]) => String(v));
  return hits.length ? hits.join('; ') : wordsIn(a, b).length ? 'removed in the cut' : 'pause';
};

const done = sections.map((sec, si) => {
  const title = String(sec.title || `Section ${si + 1}`);
  const id = String(sec.id || `${pad2(si + 1)}-${slug(title) || 'section'}`);
  const keep = (sec.keep || []).map(k => [Number(k[0]), Number(k[1])]);
  if (!keep.length || keep.some(([a, b]) => !(b > a))) die(`Section "${title}": "keep" needs ranges like [[1.2, 4.5]] with end after start.`);
  const checks = [], keeps = [];
  keep.forEach(([a, b], k) => {
    const prev = keeps.length ? keeps[keeps.length - 1][1] : 0;
    const next = k + 1 < keep.length && keep[k + 1][0] > b ? keep[k + 1][0] : info.duration;
    let s, e;
    if (sec.exact) {
      s = a; e = b;
      if (loud(F(a)) && loud(F(a) - 1)) checks.push(`exact start ${a.toFixed(2)} s sits inside sound: listen there`);
      if (loud(F(b)) && loud(F(b) + 1)) checks.push(`exact end ${b.toFixed(2)} s sits inside sound: listen there`);
    } else {
      const st = startEdge(a, keep[k - 1] && keep[k - 1][0] < a ? prev : 0), en = endEdge(b, next);
      s = st.t; e = en.t;
      if (st.note) checks.push(st.note); if (en.note) checks.push(en.note);
    }
    s = Math.max(0, onFrame(s)); e = Math.min(info.duration, onFrame(e));
    if (e - s < 0.05) { checks.push(`keep ${k + 1} (${a}-${b}) came out empty and was left out`); return; }
    keeps.push([s, e]);
  });
  // words an edge cuts through, and phrases the cut keeps twice (a retake left in)
  keeps.forEach(([s, e]) => WORDS.forEach(w => {
    if (w.start < s - 0.03 && w.end > s + 0.06) checks.push(`the start at ${s.toFixed(2)} s cuts into "${w.text}" (${w.start.toFixed(2)}-${w.end.toFixed(2)} s): check the transcript time against the audio`);
    if (w.start < e - 0.06 && w.end > e + 0.03) checks.push(`the end at ${e.toFixed(2)} s cuts into "${w.text}" (${w.start.toFixed(2)}-${w.end.toFixed(2)} s): check the transcript time against the audio`);
  }));
  const kept = keeps.flatMap(([s, e]) => wordsIn(s, e));
  const norm = w => w.text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  const seen = new Map();
  for (let i = 0; i + 4 <= kept.length; i++) {
    const key = kept.slice(i, i + 4).map(norm).join(' ');
    if (key.split(' ').some(t => !t)) continue;
    if (seen.has(key) && kept[i].start - kept[seen.get(key)].start > 1) { checks.push(`kept twice: "${key}" at ${kept[seen.get(key)].start.toFixed(1)} s and ${kept[i].start.toFixed(1)} s (a retake left in?)`); break; }
    if (!seen.has(key)) seen.set(key, i);
  }
  // what the cut leaves out between the first and last kept part, and a little either side
  const lo = Math.max(0, keeps[0][0] - 3), hi = Math.min(info.duration, keeps[keeps.length - 1][1] + 3);
  const removed = []; let cur = lo;
  const outside = (a, b, where) => wordsIn(a, b).length ? where : 'pause';   // the edges of a section: not a cut, just outside it
  [...keeps].sort((p, q) => p[0] - q[0]).forEach(([s, e], k) => { if (s - cur > 0.02) removed.push({ from: r3(cur), to: r3(s), why: k ? whyAt(sec, cur, s) : outside(cur, s, 'before this section') }); cur = Math.max(cur, e); });
  if (hi - cur > 0.02) removed.push({ from: r3(cur), to: r3(hi), why: outside(cur, hi, 'after this section') });
  return { si, id, title, sec, keeps, checks: [...new Set(checks)], removed, kept };
});

// ---------- cut-review.md: read this before anything is cut ----------
const mmss = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const R = [`# Cut review: ${plan.title || path.basename(WORK)}`, '',
  `Recording: ${shown(RAW)} (${mmss(info.duration)}). Pauses are anything under ${QUIET.toFixed(0)} dB (room noise ${FLOOR.toFixed(0)} dB). Air at each edge: ${AIR} s.`,
  'Read every KEPT TEXT the way the viewer will hear it: a line said twice is a retake left in, a sentence missing its start is a keep that starts late.', ''];
let keptTotal = 0;
done.forEach(d => {
  const len = d.keeps.reduce((a, [s, e]) => a + e - s, 0); keptTotal += len;
  R.push(`## ${d.id}: ${d.title} (${len.toFixed(1)} s kept${d.sec.exact ? ', exact edges' : ''})`, '');
  const rows = [...d.keeps.map(([s, e]) => ({ s, e, k: 1 })), ...d.removed.map(r => ({ s: r.from, e: r.to, k: 0, why: r.why }))].sort((p, q) => p.s - q.s);
  rows.forEach(r => R.push(r.k ? `KEEP ${r.s.toFixed(2)}-${r.e.toFixed(2)}  ${said(wordsIn(r.s, r.e)) || '(no words)'}`
    : `cut  ${r.s.toFixed(2)}-${r.e.toFixed(2)}  ${r.why}${wordsIn(r.s, r.e).length ? ': "' + said(wordsIn(r.s, r.e)) + '"' : ''}`));
  R.push('', 'KEPT TEXT: ' + (said(d.kept) || '(no words)'), '');
  d.checks.forEach(c => R.push('CHECK ' + c));
  if (d.checks.length) R.push('');
});
R.push(`Total kept: ${mmss(keptTotal)} of ${mmss(info.duration)} raw.`);
fs.writeFileSync(path.join(WORK, 'cut-review.md'), R.join('\n') + '\n');
console.log(R.join('\n'));
if (flag('--dry')) { console.log(`\n  Dry run: nothing cut. Read ${shown(path.join(WORK, 'cut-review.md'))}, fix plan.json, run again without --dry.\n`); process.exit(0); }

// ---------- cut each section: one decode per forward run of the recording, picture and sound on the same frames ----------
const CUTS = path.join(WORK, 'cuts'); fs.mkdirSync(CUTS, { recursive: true });
const HIST = path.join(CUTS, 'history.json');
const hist = (() => { try { return JSON.parse(fs.readFileSync(HIST, 'utf8')); } catch (_) { return {}; } })();
const same = (p, q) => p && q && p.length === q.length && p.every((k, i) => Math.abs(k[0] - q[i][0]) < 1e-3 && Math.abs(k[1] - q[i][1]) < 1e-3);
const vertical = info.h > info.w, H = Number(S.reviewHeight) || 720;
const scale = flag('--full') ? '' : vertical ? (info.w > H ? `,scale=${H}:-2:flags=bicubic` : '') : (info.h > H ? `,scale=-2:${H}:flags=bicubic` : '');

function encode(keeps, dest) {
  const frames = [];
  keeps.forEach(([a, b]) => { const fa = Math.round((a - VOFF) * FPS), fb = Math.round((b - VOFF) * FPS); if (fb > fa) { const p = frames[frames.length - 1]; if (p && p[1] === fa) p[1] = fb; else frames.push([fa, fb]); } });
  const runs = [];
  frames.forEach(k => { const r = runs[runs.length - 1]; if (r && k[0] >= r[r.length - 1][1] && (k[0] - r[r.length - 1][1]) / FPS <= 8) r.push(k); else runs.push([k]); });
  const ins = [], g = []; let n = 0;
  runs.forEach((grp, ri) => {
    const first = Math.max(0, (grp[0][0] - Math.round(FPS)) / FPS + VOFF);   // seek one second early, trim the rest exactly
    ins.push('-ss', first.toFixed(6), '-to', (grp[grp.length - 1][1] / FPS + VOFF + 0.5).toFixed(6), '-i', RAW);
    const at = k => k / FPS + VOFF - first;
    g.push(`[${ri}:v:0]split=${grp.length}` + grp.map((_, i) => `[v${n + i}]`).join(''));
    g.push(`[${ri}:a:0]asplit=${grp.length}` + grp.map((_, i) => `[a${n + i}]`).join(''));
    grp.forEach(([fa, fb], i) => {
      g.push(`[v${n + i}]trim=start=${Math.max(0, at(fa - 0.5)).toFixed(6)}:end=${at(fb - 0.5).toFixed(6)},setpts=PTS-STARTPTS[x${n + i}]`);
      g.push(`[a${n + i}]atrim=start=${Math.max(0, at(fa)).toFixed(6)}:end=${at(fb).toFixed(6)},asetpts=PTS-STARTPTS[y${n + i}]`);
    });
    n += grp.length;
  });
  g.push(Array.from({ length: n }, (_, i) => `[x${i}][y${i}]`).join('') + `concat=n=${n}:v=1:a=1[cv][ca]`);
  g.push(`[cv]setsar=1${scale}[vo]`, '[ca]aresample=48000[ao]');
  const script = dest + '.filter.txt';
  fs.writeFileSync(script, g.join(';\n'));
  ffmpeg([...ins, '-filter_complex_script', script, '-map', '[vo]', '-map', '[ao]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-g', String(Math.max(1, Math.round(FPS))), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart', dest], 'cutting ' + path.basename(dest));
  fs.unlinkSync(script);
}
// the words of a version on its own clock (the kept parts back to back), for the editor's Script panel
function cutWords(keeps) {
  const out = []; let acc = 0;
  keeps.forEach(([s, e]) => { wordsIn(s, e).forEach(w => out.push({ text: w.text, start: r3(acc + Math.max(0, w.start - s)), end: r3(acc + Math.min(e, w.end) - s) })); acc += e - s; });
  return out;
}

const T0 = Date.now();
done.forEach(d => {
  const list = hist[d.id] || (hist[d.id] = []);
  const last = list[list.length - 1];
  if (last && same(last.keeps, d.keeps) && fs.existsSync(path.join(WORK, last.file)) && !flag('--force')) { console.log(`  ${d.id}: unchanged, kept V${last.v}`); return; }
  const v = last && !flag('--force') ? last.v + 1 : last ? last.v : 1;
  const file = `cuts/${d.id}-v${v}.mp4`;
  encode(d.keeps, path.join(WORK, file));
  fs.writeFileSync(path.join(WORK, `cuts/${d.id}-v${v}.words.json`), JSON.stringify(cutWords(d.keeps)));
  const note = String(d.sec.note || (v === 1 ? 'first cut' : 're-cut'));
  if (last && last.v === v) list[list.length - 1] = { v, file, keeps: d.keeps, note, at: new Date().toISOString() };
  else list.push({ v, file, keeps: d.keeps, note, at: new Date().toISOString() });
  console.log(`  ${d.id}: cut V${v} (${d.keeps.reduce((a, [s, e]) => a + e - s, 0).toFixed(1)} s)`);
});
fs.writeFileSync(HIST, JSON.stringify(hist, null, 1));
console.log(`  cut in ${((Date.now() - T0) / 1000).toFixed(1)} s`);

// ---------- spec.json for the editor, then the editor project ----------
const ID = String(plan.id || slug(path.basename(WORK)) || 'cut');
const rel = f => fwd(path.relative(WORK, f));
const spec = { id: ID, title: String(plan.title || path.basename(WORK)), kicker: String(plan.kicker ?? 'cut by /cut'), wordsUnit: 's', clips: done.map(d => ({
  id: d.id, title: d.title, raw: rel(RAW), rawWords: 'words.json', keeps: d.keeps, removed: d.removed,
  applyHint: `New kept ranges for this clip (raw seconds): in ${shown(PLAN_FILE)}, replace the "keep" of section ${d.si + 1} ("${d.title}") with this list and set "exact": true on it, then run cut.mjs again:`,
  versions: hist[d.id].map(h => ({ video: h.file, note: h.note, words: h.file.replace(/\.mp4$/, '.words.json') })),
})) };
fs.writeFileSync(path.join(WORK, 'spec.json'), JSON.stringify(spec, null, 1) + '\n');
if (flag('--no-editor')) { console.log(`\n  spec.json written. Build the editor project with: node "${fwd(path.join(EDITOR, 'tools', 'make-project.mjs'))}" "${fwd(path.join(WORK, 'spec.json'))}"\n`); process.exit(0); }
console.log('');
const r = spawnSync(process.execPath, [path.join(EDITOR, 'tools', 'make-project.mjs'), path.join(WORK, 'spec.json')], { encoding: 'utf8', windowsHide: true });
process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
if (r.status !== 0) die('make-project could not build the editor project (above).');
