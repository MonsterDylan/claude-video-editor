# Claude Video Editor

Your raw talking-head recording in, a clean cut out, reviewed like you're talking to an editor. Then graphics timed to your words.

You give Claude Code a raw recording. **/cut** transcribes it with a time for every word, keeps the last clean take of every line, cuts the false starts and long pauses, and puts the cut on this editor in Chrome. You review it like you would in Premiere: play it fast, drag a clip's edge to bring back something it cut, press C to split a clip, pin a comment on the picture. One button copies every fix as a clean list for Claude, and with **Teach my /cut** on, it learns from your fixes so the next cut needs fewer of them.

On top of that, the **FX and SFX lanes** let you drop motion graphics and sound effects onto the timeline at the word you want them, with a live preview over the picture, straight from the free effects library: https://github.com/MonsterDylan/claude-video-effects

By Dylan Watkins. Built on Claude Video Editor by Jay E, CC BY 4.0 (see License at the bottom).

**What's different from the original:**
- FX and SFX lanes on the timeline, with a picker that shows every effect and lets you listen to every sound
- Live FX preview: the real effects library runs over the picture, aimed at your face when a face track exists
- Copy comments includes your FX and SFX picks, so Claude builds the graphics pass from them
- /cut: joins multi-part recordings, names each run after the video (no collisions), and handles noisy rooms (CHECK on every edge)
- Fixes: export no longer fails when a setting is left blank, dictation (Wispr Flow etc.) pastes more than once per page

## What's inside

```
rubric-editor/
├── server.mjs                # the local server (Node.js, no dependencies)
├── app/                      # the editor page, its timeline, the homepage, the save script
├── skills/cut/               # the /cut skill: SKILL.md, my-style.md, settings.json, scripts/
├── tools/make-project.mjs    # turns any cut into an editor project (/cut runs it for you)
├── tools/render-export.mjs   # renders what you ask for with the Export button
├── sample/                   # a 58-second sample recording, its transcript, plan and cut
├── projects/sample-recording # the sample, ready to review the moment the server starts
├── env.example               # settings and transcription keys. Copy it to env.local
└── LICENSE
```

The sample is not a real person: a built-in computer voice reads a short script over plain colour cards that show each line's number. It has one false start (line 2, take 1) and one long pause (after line 3), the two things /cut removes, so you can see a cut before you bring your own footage.

## Set it up (let Claude do it)

Open Claude Code in the folder where you keep projects and paste:

```
Set up Claude Video Editor for me:
1. Clone https://github.com/MonsterDylan/claude-video-editor and
   https://github.com/MonsterDylan/claude-video-effects into this folder, side by side.
2. In claude-video-editor: check Node.js (18+) and ffmpeg, copy env.example to env.local,
   start the server (node server.mjs) in the background, and give me the link to the sample project.
3. Install the skill in claude-video-editor/skills/cut so I can use /cut, and set its "editor" path.
4. Walk me through getting a transcription key (AssemblyAI by default).
```

The FX and SFX lanes find `claude-video-effects` next to the editor on their own. Somewhere else? Set `FX_LIBRARY_DIR` and `SFX_DIR` in `env.local`.

### By hand (2 minutes)

You need **Node.js 18 or newer** (https://nodejs.org) and **ffmpeg** (https://ffmpeg.org/download.html) on your PATH. There is nothing to `npm install`.

1. Open a terminal in this folder and run `node server.mjs`. Leave it open.
2. Open http://127.0.0.1:50002/ in Chrome and click **Sample recording**.
3. Copy `skills/cut/` into your agent's skills folder, and put this folder's full path in `"editor"` in its `settings.json`.

Port 50002 taken? `node server.mjs --port 50010`, or set `PORT` in `env.local`.

## Your first cut

1. **Get a transcription key** (once). The default is AssemblyAI: sign up at https://www.assemblyai.com/dashboard, copy your key from API Keys, and put it in `env.local` as `ASSEMBLYAI_API_KEY=...`. Your agent can walk you through it. The key stays on your computer.
2. **Run /cut** with your recording's path, plus a line of context if you have it: `/cut C:\Videos\my-reels.mkv - 7 reels, one per script, titles: ...`. Context isn't required (the models are good at finding where each part starts), but it helps it get the sections right the first time.
3. **Review** at the link your agent gives you.

### Which transcriber

/cut needs every word with the time it was said, because that's how it knows what to keep and where to cut. Pick one in `skills/cut/settings.json` (`"transcriber"`), or just tell your agent which one you want.

| Transcriber | 1 hour of video takes | Cost | Key |
|---|---|---|---|
| **AssemblyAI** (default) | about 33 seconds | paid per hour of audio, see their pricing page | `ASSEMBLYAI_API_KEY`, from assemblyai.com/dashboard |
| **ElevenLabs Scribe** | about the same | a bit more than AssemblyAI. Good if you already pay for ElevenLabs | `ELEVENLABS_API_KEY`, from elevenlabs.io/app/settings/api-keys |
| **Whisper** | 15 to 50 minutes, on your own computer (a faster CPU is quicker) | free | none. Your agent installs it (Python, then `pip install -U openai-whisper`) when you ask for it |

## Review in the editor

| Key or action | What it does |
|---|---|
| Space | Play or pause the cut |
| `R`, or tick **Raw footage** | Play the raw recording instead, cut parts included, so you hear what was removed |
| `S` / `D` | Slower / faster (click the 1.0x button for a slider). Reviewing at 2x is normal |
| `F` | Full screen |
| Ctrl + mouse wheel | Zoom the timeline in and out |
| Shift + mouse wheel | Move along the timeline, left and right |
| Drag a clip's edge | Bring back footage the cut removed, or trim more. It becomes a comment on that clip |
| `C` | Cut the clip under the playhead in two (then drag or delete either half) |
| `Del` | Delete the selected clip or comment |
| `H` | Hide the cut parts, so the clips sit back to back |
| Click the picture | Pin a comment on that spot |
| `A`, or `+` on the playhead | Mark something to add (drag the `+` to mark a span of the raw recording) |
| `1` to `9`, `V` | Switch clip, switch version |
| Ctrl+Z, Ctrl+Shift+Z | Undo, redo |
| The expand button on any panel | Make that panel fill the page (Esc to go back) |

When you're happy with a clip, click **Approve**. Your agent leaves approved clips alone.

## Hand your fixes to your agent

Click **Copy comments for ALL clips** (or **for this clip**) and paste it to your agent. Every item says what it is, where it is and what was said there: `EXTEND`, `TRIM` and `DELETE` with the clip's new kept ranges, ready to re-cut; `PIN` and `ADD` with your note; `APPROVED` per clip. Your agent re-cuts what changed, and the editor shows the new cut as V2 next to V1.

**Teach my /cut** (top of the editor, on by default) adds one line to what you copy: after your agent applies your fixes, it folds what they say about how you like your cuts into `skills/cut/my-style.md`, and reads that file before every cut. Everyone talks differently: some people pause a lot, some restart lines a lot, some talk fast. The first cuts may need a fair few fixes; each round makes the next cut closer to what you want, the same way reinforcement learning works, just on a small scale. Switch it off for a round you don't want it to learn from.

**Graphics:** put effects and sounds on the FX and SFX lanes while you review. Copy comments lists them under "## FX and SFX lanes", and Claude builds them with the effects library.

## Export and render

Click **Export**, pick a size (three per shape, landscape or vertical), then **Render this clip** or **Render all**. The editor saves the request and copies a one-line ask: paste it to your agent. It runs `node tools/render-export.mjs`, which cuts your raw recording at your trims, crops to the shape, levels the sound and checks each file. The files land in `projects/<project>/exports/`.

Already edit in Premiere Pro, DaVinci Resolve or Final Cut Pro? Your agent can drive those too through an MCP connector (a plugin that lets it control the app). That's optional and not part of this kit; the kept ranges /cut writes in `spec.json` are what it would lay out.

## Try /cut on the sample

- Open the **Sample recording** project. Tick **Raw footage** (or press `R`) and play: you'll hear the false start of line 2 and the long pause after line 3 that the cut removed.
- Drag the left edge of the second clip in **Intro** to the left, then press Space: the cut now plays some of the false start again.
- Ask your agent: `/cut, dry run the sample in sample/`. It reads `sample/plan.json` and shows you what it keeps and why, without needing a key.
- With a key set up, ask it to `/cut sample/raw-sample.mp4` from scratch and compare its plan with the one in `sample/`.

## Make a project from a cut you made elsewhere

/cut writes this for you. For a video you cut in another tool, write a `spec.json` and run `node tools/make-project.mjs path/to/spec.json`:

```json
{
  "title": "Launch video",
  "clips": [
    { "title": "Full cut", "video": "launch-video-v1.mp4" }
  ]
}
```

Add `"raw": "raw-take.mp4"` and `"keeps": [[3.2, 10.8], [12.1, 20.0]]` (the raw seconds your cut uses, in order) to a clip to get the raw-footage timeline, and `"rawWords": "words.json"` for the words. A clip can have `"versions": [{ "video", "note" }, ...]`, `"layers": [{ "name": "Music", "file": "music.wav" }]` for sound lanes with Mute and Solo, and `"scenes": [{ "s": 0, "e": 3, "title": "Hook" }]`. Paths are relative to the spec file. Your agent can read `tools/make-project.mjs` for every field.

## How your work is saved

- Everything you do on a project (comments, notes, trims, approvals, the Teach switches) saves to `projects/<project>/rubric-state.json` a moment after you do it.
- If the server stops, a red note appears bottom left. Your changes wait in the browser and save when it's back.
- Rebuilding a project (/cut or make-project) never touches `rubric-state.json`. To start a project over, stop the server and delete that file.

## Settings (env.local)

Copy `env.example` to `env.local`. Every line is optional.

| Key | Default | What it does |
|---|---|---|
| `PORT` | 50002 | Where the server listens |
| `PROJECTS_DIR` | `projects` | Where your projects live |
| `RUBRIC_TOKEN` | blank (off) | Optional shared secret for the API (see Security model) |
| `ASSEMBLYAI_API_KEY` | blank | For /cut with AssemblyAI |
| `ELEVENLABS_API_KEY` | blank | For /cut with ElevenLabs Scribe |

/cut's own settings live in `skills/cut/settings.json`: the transcriber, the editor folder, the language, the air left at each edge (`air`, 0.1 s), and the review copy height (720).

## Keep it running (optional)

`node server.mjs` is all you need while you review. To start it with your computer, any process manager works, for example pm2: `npm install -g pm2`, then in this folder `pm2 start server.mjs --name rubric-editor`, `pm2 save`, and `pm2 startup` once. Or ask your agent to set up an autostart that fits your computer.

## Security model

- The server listens on `127.0.0.1` only, so nothing else on your network can reach it, and it answers only to `127.0.0.1`, `localhost` and `[::1]` on its own port (any other host name gets a 403, which blocks DNS rebinding).
- It sends no CORS headers, so other websites can't call its API from your browser. Saves must be JSON, and every request body is capped at 1 MB.
- Optional `RUBRIC_TOKEN`: when set, every `/api` call needs the matching `x-rubric-token` header. The pages the server serves get it automatically.
- It serves the pages in `app/` and media and data files inside each project folder. Hidden files, anything outside a project folder and `rubric-state.json` itself are never served as files. Titles, words and comments are escaped before they are shown.
- The server writes only `projects/<project>/rubric-state.json`, makes no network calls and starts no programs. The pages load the Outfit and Doto fonts from Google Fonts.
- The /cut scripts run only when you or your agent run them. `transcribe.mjs` sends a small audio-only copy of your recording to the transcriber you picked (none for Whisper), reading the key from your environment or `env.local`. They start `ffmpeg` and write only inside the work folder and `projects/`. `render-export.mjs` writes only to `projects/<project>/exports/`.

## How it's built (for your agent)

```
raw recording
   │  skills/cut/scripts/transcribe.mjs   ->  work/<name>/words.json, sentences.txt
   │  your agent writes work/<name>/plan.json (what to keep, and why)
   │  skills/cut/scripts/cut.mjs --dry    ->  cut-review.md (kept text, checks)
   │  skills/cut/scripts/cut.mjs          ->  cuts/<section>-v1.mp4, spec.json, then tools/make-project.mjs
   ▼
projects/<id>/   reels-data.js, source-data.js (raw recording, kept parts, words, waveform, proxy), fixes.js,
                 approvals.js, resolutions.js, rubric.json, media/, rubric-state.json (your saved work)
   │
   ▼  node server.mjs
http://127.0.0.1:50002/projects/<id>/    app/editor.html + editor-timeline.js/.css, built on every request
```

| Route | What it does |
|---|---|
| `GET /` | The homepage: every project, with search and sorting |
| `GET /projects/<id>/` | The editor for that project |
| `GET /api/projects` | Every project, with its length, dates, comment and approval counts |
| `GET /api/state/<id>` | The project's saved work |
| `POST /api/state/<id>` | Save changes: `{ "set": { key: value }, "del": [key] }` |

Saved work (`rubric-state.json`) keeps the page's storage entries under the project's storage key (`rubric-editor-<id>`): comments, notes and approvals under the key itself, trims under `:srcTrim`, the Teach switches under `:teach`, export requests under `:export`. The copied comments are usually the better input, because they already name the words and the new ranges.

## Troubleshooting

- **"Port 50002 is already in use":** `node server.mjs --port 50010`, or set `PORT` in `env.local`.
- **A red "Can't reach the Claude Video Editor server" note:** the server stopped. Start it again; your changes save by themselves.
- **"ffmpeg was not found":** install ffmpeg and open a new terminal so your PATH updates.
- **"No AssemblyAI key":** put `ASSEMBLYAI_API_KEY=...` in `env.local` in this folder (not `env.example`).
- **A cut clips the end of a word:** tell your agent; it can raise `air` in `skills/cut/settings.json`, or extend that clip's edge in the editor and paste the comments.
- **A project doesn't show on the homepage:** refresh. It needs a `reels-data.js` in its folder, which make-project writes.

## License

CC BY 4.0. Use it, change it, share it, even commercially, with credit.

- Original work: **RUBRIC Editor, with the /cut skill, by Jay E (RoboNuggets)**, licensed CC BY 4.0. The original copyright and license are kept in LICENSE.
- Changes in this version (FX and SFX lanes, live FX preview, /cut additions, the fixes listed at the top, renaming) by Dylan Watkins, also under CC BY 4.0.
