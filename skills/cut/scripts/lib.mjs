// Shared helpers for the /cut scripts: settings, where the Claude Video Editor folder is, API keys, ffmpeg and ffprobe calls,
// reading word files. No dependencies beyond Node.js 18+ and ffmpeg on your PATH.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) { console.error('\n  /cut needs Node.js 18 or newer. You are running ' + process.version + '\n'); process.exit(1); }

export const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
export const SKILL = path.resolve(SCRIPTS, '..');

export function die(msg) { console.error('\n  ' + msg + '\n'); process.exit(1); }
export const fwd = p => String(p).split(path.sep).join('/');
export const r3 = x => Math.round(x * 1000) / 1000;
export const pad2 = n => String(n).padStart(2, '0');
export const slug = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40).replace(/-$/, '');

// settings.json beside SKILL.md: which transcriber, where the editor lives, and the edge settings
export function settings() {
  const def = { transcriber: 'assemblyai', editor: '', language: 'en', air: 0.1, quietDb: null, reviewHeight: 720, elevenlabsModel: 'scribe_v1', whisperModel: 'small' };
  try { return { ...def, ...JSON.parse(fs.readFileSync(path.join(SKILL, 'settings.json'), 'utf8')) }; } catch (_) { return def; }
}

// The Claude Video Editor folder: settings.json "editor", else RUBRIC_EDITOR_DIR, else the folder this skill shipped in.
export function editorDir(s = settings()) {
  const tries = [s.editor, process.env.RUBRIC_EDITOR_DIR, path.resolve(SKILL, '..', '..')].filter(Boolean);
  for (const d of tries) if (fs.existsSync(path.join(d, 'server.mjs')) && fs.existsSync(path.join(d, 'tools', 'make-project.mjs'))) return path.resolve(d);
  die('Could not find the Claude Video Editor folder. Put its full path in "editor" in ' + fwd(path.join(SKILL, 'settings.json')) + '.');
}

// A key from the environment, else from the editor's env.local. Never printed.
export function secret(name, editor) {
  if (process.env[name]) return process.env[name].trim();
  try {
    const m = fs.readFileSync(path.join(editor, 'env.local'), 'utf8').match(new RegExp('^[ \\t]*' + name + '[ \\t]*=[ \\t]*(\\S.*?)[ \\t]*$', 'm'));
    if (m) return m[1].replace(/^["']|["']$/g, '');
  } catch (_) {}
  return '';
}

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { windowsHide: true, maxBuffer: 1 << 30, ...opts });
  if (r.error && r.error.code === 'ENOENT') die(/^ff/.test(cmd) ? `${cmd} was not found. Install ffmpeg (it includes ffprobe) and open a new terminal: https://ffmpeg.org/download.html`
    : `${cmd} was not found. Install it (see SKILL.md) and open a new terminal.`);
  if (r.error) throw r.error;
  return r;
}
export function ffmpeg(args, what) {
  const r = run('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) die(`ffmpeg failed while ${what}:\n  ${String(r.stderr).trim().split('\n').slice(-4).join('\n  ')}`);
  return r;
}

// length, frame rate and where the picture starts on the file's clock (some recorders start the sound a little earlier)
export function probe(file) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate,start_time:format=duration,start_time', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0) die(`ffprobe could not read ${file}. Is it a video file?`);
  const j = JSON.parse(r.stdout), st = j.streams || [];
  const v = st.find(s => s.codec_type === 'video'), a = st.find(s => s.codec_type === 'audio');
  const num = x => (x == null || x === 'N/A' ? 0 : Number(x));
  const [n, d] = String((v && v.r_frame_rate) || '30/1').split('/').map(Number);
  return { duration: num(j.format && j.format.duration), w: v ? v.width : 0, h: v ? v.height : 0, rate: (v && v.r_frame_rate) || '30/1',
    fps: n / (d || 1), voff: v ? num(v.start_time) - num(j.format && j.format.start_time) : 0, video: !!v, audio: !!a };
}

// mono samples of a file (or a part of it) as 32-bit floats
export function samples(file, sr = 16000, from = null, to = null) {
  const args = ['-v', 'error'];
  if (from != null) args.push('-ss', String(from), '-to', String(to));
  args.push('-i', file, '-vn', '-ac', '1', '-ar', String(sr), '-f', 'f32le', '-');
  const r = run('ffmpeg', args);
  if (r.status !== 0) die(`ffmpeg could not read the sound of ${file}`);
  const b = r.stdout, n = Math.floor(b.length / 4);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + n * 4));   // a copy, so the floats line up
}

// [{text, start, end}] in seconds from words.json (or any word list with start/end)
export function readWords(file) {
  if (!fs.existsSync(file)) return [];
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(j) ? j : j.words || [];
  return list.map(w => ({ text: String(w.text ?? w.word ?? '').trim(), start: Number(w.start), end: Number(w.end) }))
    .filter(w => w.text && isFinite(w.start) && isFinite(w.end)).sort((a, b) => a.start - b.start);
}
