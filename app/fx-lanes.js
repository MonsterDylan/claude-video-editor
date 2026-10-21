// Claude Video Editor: FX and SFX lanes (added 2026-10-19 for Dylan's Hyperframes pipeline; not part of the upstream editor).
// Two lanes under SCENE: FX places a Signal FX Library effect on a moment of the clip, SFX places a sound from the sound
// folder. Both lists come from the server's /api/library, which reads the library folders on every request, so a new
// effect or a new sound file shows up the next time the editor opens. "+ New effect" / "+ New sound" asks Claude to build
// one that isn't in the library yet.
//
// Every item sits on the raw recording's clock (like comments), so it stays on its word through re-cuts. Items save under
// the project's storage key + ':fx' (the shim copies that to rubric-state.json), and Copy comments lists them as FX / SFX
// lines for the agent (window.RubricFX.markdown, called from buildMarkdown in editor.html).
//
// Click an empty spot of a lane (or G for FX / X for SFX at the playhead) to add; the time snaps to the start of the word
// there. Click a block to edit it, drag it to move it, drag its right edge to change its length. While the clip plays, each
// SFX plays at its moment and the FX on screen shows as a tag on the picture.
(function () {
  const ST = window.SrcTrim, APP = window.__RUBRIC_APP || {};
  if (!ST || !document.getElementById('stInner')) return;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const f2 = t => (+t).toFixed(2);
  const KEY = ((APP.prefixes && APP.prefixes[0]) || 'rubric-editor') + ':fx';
  const headers = APP.token ? { 'x-rubric-token': APP.token } : {};
  let CAT = { fx: [], sfx: [] }, catErr = null;
  let state = { version: 1, items: {} };
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.items) state = s; } catch (e) {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} };
  const uid = () => Math.random().toString(36).slice(2, 9);

  // ---------- lanes ----------
  const heads = document.querySelector('.st-heads'), inner = $('stInner'), scenes = $('stScenes');
  const hScenes = heads.querySelector('.st-h-scenes');
  const mkHead = (cls, label, title) => { const d = document.createElement('div'); d.className = cls + ' fx-head'; d.textContent = label; d.title = title; return d; };
  const hFx = mkHead('st-h-fx', 'FX', 'Visual effects from the Signal FX Library. Click the lane or press G to add one.');
  const hSfx = mkHead('st-h-sfx', 'SFX', 'Sound effects from the sound folder. Click the lane or press X to add one.');
  hScenes.after(hFx); hFx.after(hSfx);
  const laneFx = document.createElement('div'); laneFx.className = 'st-lane st-h-fx fx-lane'; laneFx.id = 'stFx'; laneFx.dataset.kind = 'fx';
  const laneSfx = document.createElement('div'); laneSfx.className = 'st-lane st-h-sfx fx-lane'; laneSfx.id = 'stSfx'; laneSfx.dataset.kind = 'sfx';
  laneFx.title = 'Click to add an effect here (G at the playhead)'; laneSfx.title = 'Click to add a sound here (X at the playhead)';
  scenes.after(laneFx); laneFx.after(laneSfx);

  const baseOf = r => r ? (r.base || r.id) : null;
  const cur = () => baseOf(ST.reel());
  const itemsOf = base => (state.items[base] = state.items[base] || []);
  const catFx = fn => CAT.fx.find(x => x.fn === fn);
  const catSfx = file => CAT.sfx.find(x => x.file === file);
  const labelOf = it => it.kind === 'fx' ? (it.isNew ? 'NEW: ' + (it.desc || 'effect') : (it.name || it.fn)) : (it.isNew ? 'NEW: ' + (it.desc || 'sound') : (it.name || it.file));

  function render() {
    const base = cur(), on = ST.loaded() && base;
    let hf = '', hs = '';
    if (on) {
      const w = ST.win() || { a: 0, b: 1e9 };
      itemsOf(base).forEach(it => {
        const x1 = ST.X(it.t), len = it.kind === 'fx' ? (it.dur || 1) : Math.max(it.dur || .35, .2);
        const x2 = Math.max(x1 + (it.kind === 'fx' ? 10 : 14), ST.X(it.t + len));
        if (x2 < w.a || x1 > w.b) return;
        const tip = esc(labelOf(it) + ' · ' + f2(it.t) + ' s raw' + (it.kind === 'fx' ? ' · ' + f2(len) + ' s' : '') + (it.note ? '\n' + it.note : ''));
        const h = '<div class="fx-blk fx-' + it.kind + (it.isNew ? ' fx-new' : '') + '" data-id="' + it.id + '" title="' + tip + '" style="left:' + x1 + 'px;width:' + (x2 - x1) + 'px">' +
          '<span>' + esc(labelOf(it)) + '</span>' + (it.kind === 'fx' ? '<i class="fx-h" data-edge="r"></i>' : '') + '</div>';
        if (it.kind === 'fx') hf += h; else hs += h;
      });
    }
    laneFx.innerHTML = hf; laneSfx.innerHTML = hs;
    previewBuild();
  }
  const prevStatics = ST.onStatics;
  ST.onStatics = () => { if (prevStatics) prevStatics(); render(); };

  // the start of the word at (or just after) raw time t, so an effect lands on the word
  function snap(t) {
    const W = ST.words(); if (!W.length) return t;
    let best = null;
    for (const w of W) {
      if (t >= w.s - .05 && t <= w.e) return w.s;
      if (w.s > t) { if (w.s - t < .45) best = w.s; break; }
    }
    return best != null ? best : t;
  }
  function saidAt(r, t, len) { try { return (ST.rawWords(r, t, t + Math.max(.6, Math.min(len || .8, 2))) || '').trim(); } catch (e) { return ''; } }

  // ---------- pointer: add, move, resize, edit ----------
  let drag = null;
  const tAt = e => ST.Tx(Math.max(0, e.clientX - inner.getBoundingClientRect().left));
  [laneFx, laneSfx].forEach(lane => lane.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !ST.loaded()) return;
    e.stopPropagation(); e.preventDefault();
    const blk = e.target.closest('.fx-blk'), kind = lane.dataset.kind;
    if (!blk) { openPicker(kind, snap(tAt(e))); return; }
    const it = itemsOf(cur()).find(x => x.id === blk.dataset.id); if (!it) return;
    drag = { it, x0: e.clientX, t0: it.t, d0: it.dur || 1, mode: e.target.closest('.fx-h') ? 'resize' : 'move', moved: false };
    lane.setPointerCapture(e.pointerId);
  }));
  [laneFx, laneSfx].forEach(lane => {
    lane.addEventListener('pointermove', e => {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x0) > 3) drag.moved = true;
      if (!drag.moved) return;
      const dt = ST.Tx(ST.X(drag.t0) + (e.clientX - drag.x0)) - drag.t0;
      if (drag.mode === 'move') drag.it.t = Math.max(0, drag.t0 + dt);
      else drag.it.dur = Math.max(.3, +(drag.d0 + dt).toFixed(2));
      render();
    });
    lane.addEventListener('pointerup', () => {
      if (!drag) return;
      const d = drag; drag = null;
      if (d.moved) { if (d.mode === 'move') d.it.t = +snap(d.it.t).toFixed(3); save(); render(); }
      else openEditor(d.it);
    });
  });

  // ---------- picker + editor (one floating panel) ----------
  const pop = document.createElement('div'); pop.className = 'fx-pop'; pop.hidden = true; document.body.appendChild(pop);
  const close = () => { pop.hidden = true; pop.innerHTML = ''; stopPreview(); };
  pop.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  document.addEventListener('pointerdown', e => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.fx-lane')) close(); });
  let preview = null;
  const stopPreview = () => { if (preview) { preview.pause(); preview = null; } };
  const playFile = (src, vol) => { stopPreview(); preview = new Audio(src); preview.volume = Math.min(1, vol == null ? 1 : vol); preview.play().catch(() => {}); };

  function where(t) {
    const r = ST.reel(), said = saidAt(r, t, .8);
    return 'at ' + f2(ST.rawToReel(t)) + ' s of the clip' + (said ? ' · on “' + esc(said) + '”' : '');
  }
  function openPicker(kind, t) {
    ST.stopAll && ST.stopAll();
    const list = kind === 'fx' ? CAT.fx : CAT.sfx;
    pop.innerHTML = '<div class="fx-pop-head"><b>' + (kind === 'fx' ? 'Add an effect' : 'Add a sound') + '</b><span>' + where(t) + '</span>' +
      '<button class="btn tiny ghost fx-x" title="Close (Esc)">✕</button></div>' +
      '<input class="fx-search" placeholder="' + (kind === 'fx' ? 'Search ' + list.length + ' effects' : 'Search ' + list.length + ' sounds') + '">' +
      (catErr ? '<div class="fx-err">' + esc(catErr) + '</div>' : '') +
      '<div class="fx-grid fx-grid-' + kind + '"></div>';
    const grid = pop.querySelector('.fx-grid'), search = pop.querySelector('.fx-search');
    const draw = q => {
      q = (q || '').toLowerCase();
      const hit = x => !q || [x.name, x.fn, x.use, x.desc, x.category, x.file].join(' ').toLowerCase().includes(q);
      const newCard = '<button class="fx-card fx-newcard" data-new="1"><span class="fx-plus">+</span><b>' + (kind === 'fx' ? 'New effect' : 'New sound') + '</b><small>Describe it. Claude builds it and adds it to the library.</small></button>';
      grid.innerHTML = list.filter(hit).map(x => kind === 'fx'
        ? '<button class="fx-card" data-k="' + esc(x.fn) + '">' + (x.still ? '<img src="' + x.still + '" alt="" loading="lazy">' : '<span class="fx-num">' + x.num + '</span>') +
          '<b>' + esc(x.name) + '</b><small>' + esc(x.use || x.desc) + '</small></button>'
        : '<div class="fx-row" data-k="' + esc(x.file) + '"><button class="btn tiny icon fx-play" title="Listen">▶</button><b>' + esc(x.name) + '</b><span class="fx-cat">' + esc(x.category) + '</span><small>' + esc(x.use) + '</small></div>'
      ).join('') + newCard;
    };
    draw('');
    search.addEventListener('input', () => draw(search.value));
    grid.addEventListener('click', e => {
      const play = e.target.closest('.fx-play'), row = e.target.closest('[data-k],[data-new]');
      if (play) { const s = catSfx(play.closest('.fx-row').dataset.k); if (s) playFile(s.src, 1); return; }
      if (!row) return;
      const it = { id: uid(), kind, t: +t.toFixed(3), note: '', fields: {} };
      if (row.dataset.new) { it.isNew = true; it.desc = ''; it.dur = kind === 'fx' ? 1.2 : .5; }
      else if (kind === 'fx') { const c = catFx(row.dataset.k); Object.assign(it, { fn: c.fn, name: c.name, dur: c.dur || 1.2 }); }
      else { const c = catSfx(row.dataset.k); Object.assign(it, { file: c.file, name: c.id, dur: c.dur || .4, gain: 1 }); }
      openEditor(it, true);
    });
    pop.querySelector('.fx-x').onclick = close;
    show(); search.focus();
  }

  function openEditor(it, isAdd) {
    const c = it.kind === 'fx' ? catFx(it.fn) : catSfx(it.file);
    const fields = it.kind === 'fx' && !it.isNew && c ? c.fields : [];
    const fieldHtml = fields.map(f => '<label class="fx-f"><span>' + esc(f) + (f === 'lines' ? ' <small>(one per line)</small>' : '') + '</span>' +
      (f === 'lines' ? '<textarea data-f="' + f + '" rows="2">' + esc(it.fields[f] || '') + '</textarea>' : '<input data-f="' + f + '" value="' + esc(it.fields[f] || '') + '">') + '</label>').join('');
    pop.innerHTML = '<div class="fx-pop-head"><b>' + esc(it.isNew ? (it.kind === 'fx' ? 'New effect' : 'New sound') : (c ? c.name || c.id : labelOf(it))) + '</b><span>' + where(it.t) + '</span>' +
      '<button class="btn tiny ghost fx-x" title="Close (Esc)">✕</button></div>' +
      (c && c.still ? '<img class="fx-big" src="' + c.still + '" alt="">' : '') +
      (c && it.kind === 'fx' && !it.isNew ? '<p class="fx-desc">' + esc(c.desc) + (c.params ? '<br><small>Options: ' + esc(c.params) + '</small>' : '') + '</p>' : '') +
      (it.isNew ? '<label class="fx-f"><span>Describe it</span><textarea data-f="__desc" rows="3" placeholder="' + (it.kind === 'fx' ? 'e.g. my logo shatters like glass, pieces fall behind my head' : 'e.g. a deep cinematic boom') + '">' + esc(it.desc || '') + '</textarea></label>' : '') +
      fieldHtml +
      '<div class="fx-row2">' + (it.kind === 'fx' || it.isNew ? '<label class="fx-f fx-s"><span>Length (s)</span><input data-f="__dur" type="number" step="0.1" min="0.2" value="' + f2(it.dur || 1) + '"></label>' : '') +
      (it.kind === 'sfx' ? '<label class="fx-f fx-s"><span>Volume</span><input data-f="__gain" type="number" step="0.1" min="0" max="2" value="' + (it.gain == null ? 1 : it.gain) + '"></label>' : '') +
      (it.kind === 'sfx' && !it.isNew ? '<button class="btn tiny fx-listen">▶ Listen</button>' : '') + '</div>' +
      '<label class="fx-f"><span>Note for Claude</span><textarea data-f="__note" rows="2" placeholder="Anything else: where on screen, what text, how it should feel">' + esc(it.note || '') + '</textarea></label>' +
      '<div class="fx-actions">' + (isAdd ? '<button class="btn tiny ghost fx-back">← Pick another</button>' : '<button class="btn tiny ghost fx-del">Delete</button><button class="btn tiny ghost fx-go">Go to it</button>') +
      '<span class="spacer"></span><button class="btn primary fx-save">' + (isAdd ? 'Add' : 'Save') + '</button></div>';
    const q = s => pop.querySelector(s);
    q('.fx-x').onclick = close;
    if (q('.fx-listen')) q('.fx-listen').onclick = () => playFile(c.src, +(q('[data-f="__gain"]').value) || 1);
    if (q('.fx-back')) q('.fx-back').onclick = () => openPicker(it.kind, it.t);
    if (q('.fx-go')) q('.fx-go').onclick = () => { ST.seekRaw(it.t); };
    if (q('.fx-del')) q('.fx-del').onclick = () => { const L = itemsOf(cur()); const i = L.indexOf(it); if (i >= 0) L.splice(i, 1); save(); render(); close(); };
    q('.fx-save').onclick = () => {
      pop.querySelectorAll('[data-f]').forEach(el => {
        const f = el.dataset.f, v = el.value;
        if (f === '__note') it.note = v.trim(); else if (f === '__desc') it.desc = v.trim();
        else if (f === '__dur') it.dur = Math.max(.2, +v || it.dur || 1);
        else if (f === '__gain') it.gain = Math.max(0, Math.min(2, +v || 0));
        else if (v.trim()) it.fields[f] = v.trim(); else delete it.fields[f];
      });
      if (isAdd) itemsOf(cur()).push(it);
      itemsOf(cur()).sort((a, b) => a.t - b.t);
      save(); render(); close();
    };
    show(); const first = pop.querySelector('textarea[data-f="__desc"], [data-f]:not([data-f^="__"])'); if (first) first.focus();
  }
  function show() {
    pop.hidden = false;
    const tl = $('stPanel').getBoundingClientRect();
    pop.style.left = Math.max(12, Math.min(innerWidth - pop.offsetWidth - 12, tl.left + 120)) + 'px';
    pop.style.top = Math.max(12, tl.top - Math.min(pop.offsetHeight, innerHeight - 24) + 40) + 'px';
  }

  // ---------- keys: G = effect at the playhead, X = sound at the playhead ----------
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || document.activeElement.isContentEditable || !pop.hidden) return;
    const k = e.key.toLowerCase();
    if ((k === 'g' || k === 'x') && ST.loaded()) { e.preventDefault(); openPicker(k === 'g' ? 'fx' : 'sfx', snap(ST.headRaw())); }
  });
  const hints = document.querySelector('#stPanel .hints');
  if (hints) hints.insertAdjacentHTML('beforeend', ' · <kbd>G</kbd> add an effect · <kbd>X</kbd> add a sound (or click the FX / SFX lane)');

  // ---------- playback: sounds at their moment, the effect on screen as a tag ----------
  const tag = document.createElement('div'); tag.className = 'fx-tag'; tag.hidden = true;
  const vbox = document.querySelector('.vbox'); if (vbox) vbox.appendChild(tag);
  let prevT = null, tagId = null;
  ST.onTick = t => {
    const base = cur(); if (!base) return;
    const items = state.items[base] || [];
    const playing = ST.isPlaying && ST.isPlaying();
    if (playing && prevT != null && t > prevT && t - prevT < .5) {
      items.forEach(it => { if (it.kind === 'sfx' && !it.isNew && it.t > prevT && it.t <= t) { const c = catSfx(it.file); if (c) { const a = new Audio(c.src); a.volume = Math.min(1, it.gain == null ? 1 : it.gain); a.play().catch(() => {}); } } });
    }
    prevT = t;
    previewSeek(t, items);
    const on = items.find(it => it.kind === 'fx' && it.isNew && t >= it.t && t < it.t + (it.dur || 1));   // real effects show in the live preview; only NEW ones get a label
    const id = on ? on.id : null;
    if (id !== tagId) {
      tagId = id; tag.hidden = !on;
      if (on) tag.innerHTML = '<b>FX</b> ' + esc(labelOf(on)) + (Object.keys(on.fields || {}).length ? ' <small>' + esc(Object.values(on.fields).join(' · ').replace(/\n/g, ' / ')) + '</small>' : '');
    }
  };

  // ---------- live preview: the real effects over the clip (app/fx-preview.html) ----------
  // An iframe over the picture runs fx.js on its own muted copies of the clip, on a GSAP timeline built from this clip's FX
  // lane (clip time = the editor's reel time). It shows only while an effect is on screen and the cut (not the raw
  // footage) is showing, and follows the playhead every frame. Effects that need pictures get Dylan's demo set from the
  // library's demo/ folder unless the note or fields give their own.
  const DEMO = { feed: [1, 2, 3, 4, 5, 6].map(i => 'demo/r' + i + '.jpg'), thumbs: [1, 2, 3, 4, 5, 6, 7, 8].map(i => 'demo/t' + i + '.jpg'),
    icons: ['capcut', 'edits', 'inshot', 'premiere'].map(n => ({ src: 'demo/' + n + '-app-icon.png', label: n[0].toUpperCase() + n.slice(1), full: true })) };
  const NUM = new Set(['to', 'from', 'scale']);
  function optsFor(it, at) {
    const o = { dur: it.dur || 1, sfx: false };
    Object.entries(it.fields || {}).forEach(([k, v]) => {
      if (k === 'lines') o.lines = String(v).split('\n').map(x => x.trim()).filter(Boolean);
      else if (NUM.has(k)) { const n = parseFloat(String(v).replace(/[^\d.-]/g, '')); if (!isNaN(n)) o[k] = n; }
      else o[k] = v;
    });
    switch (it.fn) {
      case 'phoneFeed': o.images = o.images || DEMO.feed; break;
      case 'storyboardDeck': o.images = DEMO.thumbs.slice(0, 5); break;
      case 'playingGrid': o.images = DEMO.thumbs.slice(0, 4); break;
      case 'reelFeed': o.src = o.src || 'demo/reel.jpg'; break;
      case 'iconStrike': o.icons = DEMO.icons.slice(0, 2); break;
      case 'jiggleDelete': o.icons = DEMO.icons; break;
      case 'fileDrop': case 'videoCard': o.copy = '#fx-copy-1'; break;
      case 'multiverse': o.copies = ['#fx-copy-1', '#fx-copy-2']; break;
      case 'titleCard': o.tcFrom = at; break;
      case 'model3D': o.src = o.src || 'fx/models/terminal.glb'; break;
    }
    return o;
  }
  const pv = document.createElement('iframe');
  pv.className = 'fx-preview'; pv.src = '/__rubric/fx-preview.html'; pv.setAttribute('aria-hidden', 'true'); pv.tabIndex = -1;
  if (vbox) vbox.appendChild(pv);
  let pvKey = '', pvSpec = null, pvWins = [], pvShown = false;
  const faces = {};
  const FXP = () => { try { return pv.contentWindow && pv.contentWindow.FXP; } catch (e) { return null; } };
  function previewBuild() {
    const base = cur(), mv = $('video'); if (!base || !mv) return;
    const fx = (state.items[base] || []).filter(it => it.kind === 'fx' && !it.isNew && it.fn);
    const items = fx.map(it => { const at = ST.rawToReel(it.t); return { fn: it.fn, at, opts: optsFor(it, at) }; });
    const src = mv.currentSrc || mv.src;
    // face track for this clip (tools/face-track.sh output saved next to it as <video>.face.js), so Face zoom / Face lock aim
    // at the real face in the preview; without one they fall back to the library's static face box
    if (src && !(src in faces)) {
      faces[src] = null;
      fetch(src.replace(/\.(mp4|m4v|mov|webm)(\?.*)?$/i, '.face.js'), { headers }).then(r => r.ok ? r.text() : '')
        .then(t => { const m = t.match(/window\.FX_FACE\s*=\s*([\s\S]*?);?\s*$/); if (m) { try { faces[src] = new Function('return (' + m[1] + ')')();   // our own tracker's output, served by this local server
 pvKey = ''; previewBuild(); } catch (e) {} } }).catch(() => {});
    }
    const spec = { src, face: faces[src] || null, items };
    const key = JSON.stringify(spec);
    pvWins = items.map(i => [i.at - .05, i.at + (i.opts.dur || 1) + .05]);
    if (key === pvKey) return;
    pvKey = key; pvSpec = spec;
    const F = FXP(); if (F) { const err = F.build(spec); if (err.length) console.warn('[fx-preview]', err); }
  }
  pv.addEventListener('load', () => { pvKey = ''; previewBuild(); });
  function previewSeek(rawT) {
    const F = FXP(); if (!F) return;
    const mv = $('video'), reelView = !(ST.view && ST.view() === 'raw');
    const playing = !!mv && !mv.paused;
    const rt = playing ? mv.currentTime : ST.rawToReel(rawT);
    const on = reelView && pvWins.some(([a, b]) => rt >= a && rt < b);
    if (on !== pvShown) { pvShown = on; pv.classList.toggle('on', on); }
    if (on || playing) F.seek(rt, playing && on);
  }


  function reelTime(r, t) {
    if (baseOf(ST.reel()) === baseOf(r)) return ST.rawToReel(t);
    const D = (window.SOURCE || {})[baseOf(r)]; if (!D || !D.keeps) return null;
    let acc = 0;
    for (const [a, b] of D.keeps) { if (t < a) return acc; if (t <= b) return acc + (t - a); acc += b - a; }
    return acc;
  }
  function markdown(reels) {
    const lines = []; let count = 0;
    reels.forEach(r => {
      const items = (state.items[baseOf(r)] || []).slice().sort((a, b) => a.t - b.t);
      if (!items.length) return;
      if (!lines.length) lines.push('## FX and SFX lanes',
        'Key: FX = place that Signal FX Library effect (FX.<function>) starting at that moment for that length, with the text given. SFX = mix that sound file from the sound folder at that moment, at that volume. NEW = not in the library yet: build it, add it to the library (fx.js / the sound folder) so it shows in the picker next time, then place it. raw = seconds in the raw recording (stays on the word through re-cuts); clip = seconds in this cut.', '');
      lines.push('### ' + r.num + ' ' + r.title);
      let nf = 0, ns = 0;
      items.forEach(it => {
        const rt = reelTime(r, it.t), when = 'at clip ' + (rt == null ? '?' : f2(rt)) + 's (raw ' + f2(it.t) + 's)', said = saidAt(r, it.t, it.dur);
        const extra = Object.entries(it.fields || {}).map(([k, v]) => k + ': ' + String(v).replace(/\n/g, ' / ')).join(' · ');
        if (it.kind === 'fx') lines.push('FX ' + (++nf) + '. ' + (it.isNew ? 'NEW effect: "' + (it.desc || '?') + '"' : it.fn + ' (' + it.name + ')') + ' ' + when + ', ' + f2(it.dur || 1) + 's' +
          (said ? ', on "' + said + '"' : '') + (extra ? ' · ' + extra : '') + (it.note ? ' · note: ' + it.note : ''));
        else lines.push('SFX ' + (++ns) + '. ' + (it.isNew ? 'NEW sound: "' + (it.desc || '?') + '"' : it.file) + ' ' + when + ', volume ' + (it.gain == null ? 1 : it.gain) +
          (said ? ', on "' + said + '"' : '') + (it.note ? ' · note: ' + it.note : ''));
        count++;
      });
      lines.push('');
    });
    return { lines, count };
  }
  window.RubricFX = { markdown, state: () => state, catalog: () => CAT, render };

  // ---------- load the libraries ----------
  fetch('/api/library', { headers }).then(r => r.ok ? r.json() : Promise.reject(r.status)).then(d => { CAT = { fx: d.fx || [], sfx: d.sfx || [] }; render(); })
    .catch(e => { catErr = 'Could not load the FX/SFX libraries (' + e + '). Check FX_LIBRARY_DIR and SFX_DIR in env.local.'; });
  render();
})();
