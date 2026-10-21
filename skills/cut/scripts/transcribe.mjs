#!/usr/bin/env node
// /cut step 1: transcribe a raw recording with a time for every word.
//
//   node transcribe.mjs <recording.mp4 | .mkv | .mov> [--out <work folder>] [--engine assemblyai|elevenlabs|whisper] [--lang en]
//
// Writes into the work folder (default: <Claude Video Editor folder>/work/<recording name>/):
//   recording.json   which recording, its length, which transcriber
//   transcript.json  the transcriber's full answer, kept as it came
//   words.json       every word with its start and end in seconds: [{ "text", "start", "end" }]
//   sentences.txt    one timed line per sentence ("  12.3-  15.8 the words"), split at sentence ends and at gaps over
//                    1.2 s, which is where retakes start. Your agent plans the cut from this file.
// The transcriber comes from --engine, else "transcriber" in settings.json (default assemblyai). Keys come from the
// environment or the Claude Video Editor's env.local: ASSEMBLYAI_API_KEY, ELEVENLABS_API_KEY. Whisper runs on your computer
// and needs no key.
import fs from 'node:fs';
import path from 'node:path';
import { settings, editorDir, secret, die, run, ffmpeg, probe, slug, fwd, r3 } from './lib.mjs';

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const recArg = args.find((a, i) => !a.startsWith('--') && !['--out', '--engine', '--lang'].includes(args[i - 1]));
if (!recArg) die('Usage: node transcribe.mjs <recording> [--out <work folder>] [--engine assemblyai|elevenlabs|whisper] [--lang en]');
const REC = path.resolve(recArg);
if (!fs.existsSync(REC)) die('Recording not found: ' + REC);
const S = settings(), EDITOR = editorDir(S);
const ENGINE = (opt('--engine') || S.transcriber || 'assemblyai').toLowerCase();
const LANG = opt('--lang') || S.language || 'en';
const WORK = path.resolve(opt('--out') || path.join(EDITOR, 'work', slug(path.parse(REC).name) || 'recording'));
fs.mkdirSync(WORK, { recursive: true });
const T0 = Date.now(), secs = () => ((Date.now() - T0) / 1000).toFixed(1) + ' s';

const info = probe(REC);
if (!info.audio) die('The recording has no sound track to transcribe.');
console.log(`  ${path.basename(REC)}: ${(info.duration / 60).toFixed(1)} min, ${info.w}x${info.h}, transcribing with ${ENGINE}`);

// a small mono MP3 uploads in seconds, where the recording itself can be gigabytes
const MP3 = path.join(WORK, 'audio.mp3');
ffmpeg(['-i', REC, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', MP3], 'making the audio for the transcriber');

// Write every word as it was said, including repeats, restarts and filler words: /cut needs them to find the retakes.
const VERBATIM = 'Verbatim transcript of one speaker recording a video with retakes. Write every word exactly as spoken: ' +
  'keep repeated words and repeated phrases, false starts, restarts and filler words. Never merge, shorten or tidy a repeat. ' +
  'Write nothing where there is no speech.';

async function assemblyai() {
  const key = secret('ASSEMBLYAI_API_KEY', EDITOR);
  if (!key) die('No AssemblyAI key. Get one at https://www.assemblyai.com/dashboard (API Keys), then put ASSEMBLYAI_API_KEY=your-key in ' + fwd(path.join(EDITOR, 'env.local')));
  const call = async (method, route, body, type) => {
    const r = await fetch('https://api.assemblyai.com' + route, { method, body, headers: { authorization: key, ...(type ? { 'content-type': type } : {}) } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) die(`AssemblyAI said ${r.status}: ${j.error || JSON.stringify(j).slice(0, 300)}`);
    return j;
  };
  const up = await call('POST', '/v2/upload', fs.readFileSync(MP3), 'application/octet-stream');
  const job = await call('POST', '/v2/transcript', JSON.stringify({ audio_url: up.upload_url, speech_models: ['universal-3-pro', 'universal-2'],
    language_code: LANG, disfluencies: true, ...(LANG === 'en' ? { prompt: VERBATIM } : {}) }), 'application/json');
  let res;
  for (;;) {
    res = await call('GET', '/v2/transcript/' + job.id);
    if (res.status === 'completed') break;
    if (res.status === 'error') die('AssemblyAI could not transcribe it: ' + res.error);
    await new Promise(ok => setTimeout(ok, 2000));
  }
  return { raw: res, model: res.speech_model_used || 'assemblyai', words: (res.words || []).map(w => ({ text: w.text, start: w.start / 1000, end: w.end / 1000 })) };
}

async function elevenlabs() {
  const key = secret('ELEVENLABS_API_KEY', EDITOR);
  if (!key) die('No ElevenLabs key. Get one at https://elevenlabs.io/app/settings/api-keys, then put ELEVENLABS_API_KEY=your-key in ' + fwd(path.join(EDITOR, 'env.local')));
  const form = new FormData();
  form.append('model_id', S.elevenlabsModel || 'scribe_v1');
  form.append('file', new Blob([fs.readFileSync(MP3)], { type: 'audio/mpeg' }), 'audio.mp3');
  form.append('timestamps_granularity', 'word');
  form.append('tag_audio_events', 'false');
  if (LANG) form.append('language_code', LANG);
  const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: form });
  const res = await r.json().catch(() => ({}));
  if (!r.ok) die(`ElevenLabs said ${r.status}: ${JSON.stringify(res.detail || res).slice(0, 300)}`);
  return { raw: res, model: S.elevenlabsModel || 'scribe_v1', words: (res.words || []).filter(w => w.type === 'word').map(w => ({ text: w.text, start: w.start, end: w.end })) };
}

function whisper() {
  // Whisper, the free open-source model, run on this computer: about 15 to 50 minutes per hour of video on a normal CPU.
  // Set up once with: pip install -U openai-whisper   (it uses the same ffmpeg)
  const model = S.whisperModel || 'small';
  const r = run('whisper', [MP3, '--model', model, '--language', LANG, '--word_timestamps', 'True', '--output_format', 'json', '--output_dir', WORK, '--verbose', 'False'], { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) die('Whisper did not finish. Is it installed? pip install -U openai-whisper');
  const res = JSON.parse(fs.readFileSync(path.join(WORK, 'audio.json'), 'utf8'));
  const words = (res.segments || []).flatMap(s => s.words || []).map(w => ({ text: String(w.word).trim(), start: w.start, end: w.end }));
  return { raw: res, model: 'whisper-' + model, words };
}

const engines = { assemblyai, elevenlabs, whisper };
if (!engines[ENGINE]) die(`Unknown transcriber "${ENGINE}". Use assemblyai, elevenlabs or whisper.`);
const out = await engines[ENGINE]();
// a long dash marks a word cut off mid-way ("your-"); a plain hyphen keeps the files easy to read and search
const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']', 'g');
const W = out.words.filter(w => w.text && isFinite(w.start) && isFinite(w.end))
  .map(w => ({ text: String(w.text).replace(DASHES, '-'), start: r3(w.start), end: r3(Math.max(w.end, w.start)) }));
if (!W.length) die('The transcriber returned no words. Is there speech in the recording?');

fs.writeFileSync(path.join(WORK, 'transcript.json'), JSON.stringify(out.raw, null, 1));
fs.writeFileSync(path.join(WORK, 'words.json'), JSON.stringify(W, null, 0).replace(/\},\{/g, '},\n{'));
const rel = path.relative(WORK, REC);
fs.writeFileSync(path.join(WORK, 'recording.json'), JSON.stringify({ recording: rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? fwd(rel) : fwd(REC),
  duration: r3(info.duration), width: info.w, height: info.h, transcriber: ENGINE, model: out.model, language: LANG, words: W.length,
  transcribed: new Date().toISOString() }, null, 1) + '\n');

// sentences.txt: what your agent reads to plan the cut
const lines = []; let cur = [];
W.forEach(w => {
  if (cur.length && w.start - cur[cur.length - 1].end > 1.2) { lines.push(cur); cur = []; }
  cur.push(w);
  if (/[.!?]["')\]]*$/.test(w.text)) { lines.push(cur); cur = []; }
});
if (cur.length) lines.push(cur);
const f1 = x => x.toFixed(1).padStart(7);
fs.writeFileSync(path.join(WORK, 'sentences.txt'), lines.map(l => `${f1(l[0].start)}-${f1(l[l.length - 1].end)} ` + l.map(w => w.text).join(' ')).join('\n') + '\n');
try { fs.unlinkSync(MP3); } catch (_) {}
console.log(`  ${W.length} words, ${lines.length} lines in ${secs()} (${out.model})`);
console.log(`  Work folder: ${fwd(WORK)}`);
console.log(`  Next: plan the cut from sentences.txt into plan.json, then run cut.mjs on the work folder.\n`);
