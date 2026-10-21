// Claude Video Editor: the timeline and the one player. Each part the cut kept sits on the raw recording, with the parts it
// removed between them: drag a clip edge out to bring footage back or in to trim more, cut a clip in two (C), delete a whole
// clip, hide the cuts to see the clips back to back. The raw footage plays inside the main preview window (#stVideo sits on
// top of the finished clip in the same box) while you drag an edge, while the new edit or the raw recording plays, and when
// the playhead sits on footage the finished clip does not have. Clip time <-> raw time is one straight line per kept part,
// lined up by the words both share; nothing snaps to words. Comments show as numbered markers.
// A clip with no raw recording (a finished animation) is its own timeline, with its own filmstrip and waveform.
// Sound layers (optional): a clip version that carries `layers` ([{id, name, src, file, peaks, peaksPerSec}]) gets one lane
// per layer under A1, each with its own waveform, Mute and Solo; the video is then muted and the layer files play in step
// with it through Web Audio, so what you hear is exactly the layers left on.
// Layer 2 (optional): a clip that carries `overlays` ([{id, name, src, start, in, len, thumb}]) gets a V2 lane above V1 for
// b-roll and title cards that sit over the main video; the eye on the lane head (or B) hides it.
// Export (the header's Export button) asks api.exportOf for each clip's footage as it stands; this file never saves a request.
// Only the stretch of timeline on screen (plus one screen either side) is drawn, so an hour-long recording handles like a
// one-minute clip. Data per clip comes from source-data.js and reels-data.js (tools/make-project.mjs writes both). Undo and
// redo live in the editor page (one history for trims and comments); this file asks it for snapshots through api.history.
(function () {
  const SRC = window.SOURCE || {};
  const NS = 'rubric-editor';
  const KEY = NS + ':srcTrim';
  const MIN_CLIP = 0.2;
  const WORD_PPS = 3;   // zoomed out past this many px a second, words are ticks on one canvas instead of an element each
  const $ = id => document.getElementById(id);
  const panel = $('stPanel'); if (!panel) return;
  const v = $('stVideo'), sc = $('stScroll'), inner = $('stInner'), tlBox = $('stTl'), mainV = $('video'), V1 = $('stV1'), ph = $('stPh');
  const tip = document.createElement('div'); tip.className = 'st-tip'; document.body.appendChild(tip);
  const vbox = document.querySelector('.vbox');
  let saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {}
  let compact = false; try { compact = localStorage.getItem(NS + ':hideCuts') === '1'; } catch (e) {}
  let L = null, R = null, T0 = 0, T1 = 1, clips = [], pps = 100, mode = 'edit', active = 'reel', stopAt = null, img = null;
  let selClip = null, anchors = [], markers = [], selfSeek = 0, lastT = 0, nowW = -1, view = '', kmap = [], P0 = 0, addDrag = null;
  // park = the raw time you put the playhead at by clicking or scrubbing the timeline. While nothing plays the playhead sits
  // exactly there and Play starts there, whichever picture is showing; it clears once something plays or the page seeks the
  // reel itself (a script word, a comment, the arrow keys). Before, the playhead was read back from the reel through the
  // reel-to-raw map and from two videos whose seeks and pause events land late, so it could sit (and Play could start) far
  // from the click.
  let park = null;
  let LY = [], layerKey = '', layerSel = null;   // sound layers on screen (see the sound layers block below)
  let OV = [], ovKey = '', v2On = true, ovShown = -1, ovHead = null, ovLane = null;   // layer 2 (see the layer 2 block below)
  // what is drawn right now (see "drawing only what is on screen" below)
  let win = null, clipEls = new Map(), wordR = [0, -1], wordW = [], wordWas = [], keepsS = [], filmSrc = null, filmGen = 0;
  let eIdx = { c: [], s: [], acc: [], end: [], len: 0 }, clipsVer = 0, chCache = null;
  const api = window.SrcTrim = { onChange: null, onSeekReel: null, onSelectClip: null, onMarkerDown: null, onMarkerMove: null, onMarkerUp: null, onLayerMark: null, notify: null, history: null };

  // ---------- helpers ----------
  const fmt = t => { const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2); };
  const fmtTick = (t, step) => { const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + (step < 1 ? s.toFixed(1) : Math.round(s)); };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clampT = t => Math.min(T1, Math.max(T0, t));
  const sameKeeps = (a, b) => !!a && !!b && a.length === b.length && a.every((k, i) => Math.abs(k[0] - b[i][0]) < 1e-3 && Math.abs(k[1] - b[i][1]) < 1e-3);
  const lenOf = cl => cl.reduce((a, c) => a + (c.del ? 0 : c.e - c.s), 0);
  const act = () => clips.filter(c => !c.del);
  const inKeep = (t, keeps) => keeps.some(k => t >= k[0] && t < k[1]);
  const note = msg => { if (api.notify) api.notify(msg); };
  // the words said in raw a..b, for every label (export, drag tip). Where the builder checked the audio word by word (D.heard
  // over D.checked, from a word-by-word check) those words win; elsewhere the literal words. Never the aligned words: they can sit
  // seconds away from the sound. A word belongs to the span its middle sits in (tested against spans re-heard one by one:
  // the middle names them better than the onset, which pulls in the next word).
  const midOf = w => (w.s + w.e) / 2;
  function spanWords(D, a, b) {
    const inSpan = w => { const m = midOf(w); return m >= a && m < b; };
    const chk = D.checked || [], checked = t => chk.some(([s, e]) => t >= s && t < e);
    const heard = (D.heard || []).filter(w => inSpan(w) && checked(midOf(w)));
    const rest = (D.words || []).filter(w => inSpan(w) && !checked(midOf(w)));
    return heard.concat(rest).sort((x, y) => x.s - y.s).map(w => w.t).join(' ');
  }
  // true when the builder word-checks this section but a..b runs outside what it checked (removed footage): that label rests
  // on the one-pass literal transcript, which skips or mishears retakes, so the export says so and the agent re-hears it
  const UNCHECKED = ' (literal transcript, not word-checked)';
  function unchecked(D, a, b) {
    if (!D.checked) return false;
    let t = a;
    for (const [s, e] of D.checked.slice().sort((x, y) => x[0] - y[0])) { if (e <= t) continue; if (s > t + .01) return true; t = e; if (t >= b - .01) return false; }
    return t < b - .01;
  }
  // raw time <-> time in the new edit (deleted clips and removed parts take no time), by binary search over the live clips.
  // Every change to the clips goes through paint or rebuild, and both start with reindex, so the table is always current.
  function reindex() {
    const c = act(), s = [], acc = [], end = []; let a = 0;
    c.forEach(x => { s.push(x.s); acc.push(a); a += x.e - x.s; end.push(a); });
    eIdx = { c, s, acc, end, len: a }; clipsVer++;
  }
  function rawToEdit(t) {
    const S = eIdx.s; let lo = 0, hi = S.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (S[m] <= t) { k = m; lo = m + 1; } else hi = m - 1; }
    if (k < 0) return 0;
    const c = eIdx.c[k]; return t <= c.e ? eIdx.acc[k] + (t - c.s) : eIdx.end[k];
  }
  function editToRaw(e) {
    const E = eIdx.end; if (!E.length) return T0;
    let lo = 0, hi = E.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (E[m] >= e) { k = m; hi = m - 1; } else lo = m + 1; }
    return k < 0 ? eIdx.c[E.length - 1].e : eIdx.c[k].s + (e - eIdx.acc[k]);
  }
  // pixels: with the cuts hidden the timeline is the new edit, clips back to back
  const X = t => compact ? rawToEdit(t) * pps : (t - T0) * pps;
  const Tx = x => compact ? editToRaw(x / pps) : T0 + x / pps;
  const spanNow = () => compact ? lenOf(clips) : T1 - T0;
  // the clip that holds raw time t, deleted or not (clips run in time order and never overlap)
  function clipAt(t) { let lo = 0, hi = clips.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1, c = clips[m]; if (c.e <= t) lo = m + 1; else if (c.s > t) hi = m - 1; else return c; } return null; }
  const keptAt = t => { const c = clipAt(t); return !!c && !c.del; };
  // scrubbing asks for a new frame on every mouse move, and a video finishes one seek at a time: while one runs, the newest
  // time waits and goes next (a fresh seek on every move restarted the last one, so the picture froze until the mouse stopped)
  let scrubbing = false; const pend = { raw: null, reel: null };
  function rawSeek(t) { if (scrubbing && v.seeking) pend.raw = t; else { pend.raw = null; v.currentTime = t; } }
  function reelSeek(t) { if (!api.onSeekReel) return; if (scrubbing && mainV.seeking) pend.reel = t; else { pend.reel = null; api.onSeekReel(t); } }
  v.addEventListener('seeked', () => { if (scrubbing && pend.raw != null) { const t = pend.raw; pend.raw = null; v.currentTime = t; } });
  mainV.addEventListener('seeked', () => { if (scrubbing && pend.reel != null && api.onSeekReel) { const t = pend.reel; pend.reel = null; api.onSeekReel(t); } });
  function endScrub() {
    scrubbing = false;
    if (pend.raw != null) v.currentTime = pend.raw;
    if (pend.reel != null && api.onSeekReel) api.onSeekReel(pend.reel);
    pend.raw = pend.reel = null;
  }

  function clipsFor(D) {
    const fresh = () => D.keeps.map(([s, e], i) => ({ i, k: i, s, e, os: s, oe: e, del: false }));
    const sv = saved[D.id];
    // trims saved against an older cut of this section no longer line up, so they are dropped
    if (!sv || !sameKeeps(sv.keeps, D.keeps)) return fresh();
    if (sv.v === 2) return sv.clips.map(([s, e, os, oe, del, k], i) => ({ i, k, s, e, os, oe, del: !!del }));
    const cl = fresh();   // older saves: one entry per autocut clip, deleted ones listed by index
    sv.clips.forEach(([s, e], i) => { if (cl[i]) { cl[i].s = s; cl[i].e = e; } }); (sv.del || []).forEach(i => { if (cl[i]) cl[i].del = true; });
    return cl;
  }
  // what changed, as footage: ranges brought back and ranges taken out, measured against the autocut's kept ranges.
  // Cutting a clip in two changes nothing here; only footage in or out counts.
  function merged(list) {
    const r = [];
    list.slice().sort((a, b) => a[0] - b[0]).forEach(([a, b]) => { const p = r[r.length - 1]; if (p && a <= p[1] + 1e-3) p[1] = Math.max(p[1], b); else r.push([a, b]); });
    return r;
  }
  // A minus B, both merged (sorted, no overlaps): one sweep, so a one-clip cut of a long recording (hundreds of clips, run
  // every frame through hasChanges) costs a few hundred steps instead of the old clip-by-clip 61,000
  function minus(A, B) {
    const out = []; let j = 0;
    for (const [a, b] of A) {
      while (j < B.length && B[j][1] <= a) j++;
      let x = a;
      for (let k = j; k < B.length && B[k][0] < b; k++) {
        if (B[k][0] - x > .004) out.push([x, B[k][0]]);
        x = Math.max(x, B[k][1]);
        if (x >= b) break;
      }
      if (b - x > .004) out.push([x, b]);
    }
    return out;
  }
  // words === false: only whether and where footage changed (hasChanges, count), without looking up the words said
  function changesOf(cl, D, words) {
    const orig = merged(D.keeps), now = merged(cl.filter(c => !c.del).map(c => [c.s, c.e]));
    const add = minus(now, orig).map(([a, b]) => ({ add: true, a, b })), rem = minus(orig, now).map(([a, b]) => ({ add: false, a, b }));
    const all = add.concat(rem).sort((x, y) => x.a - y.a);
    if (words === false) return all;
    return all.map(c => {
      const k = D.keeps.findIndex(([s, e]) => Math.abs(s - c.a) < .01 && Math.abs(e - c.b) < .01);
      return Object.assign(c, { d: c.b - c.a, whole: !c.add && k >= 0 ? k + 1 : 0, words: spanWords(D, c.a, c.b), unchecked: unchecked(D, c.a, c.b) });
    });
  }
  const snapshot = () => JSON.stringify(clips.map(c => [c.s, c.e, c.os, c.oe, c.del]));
  const checkpoint = label => { if (api.history) api.history.push(api.history.snap(label)); };
  function persist() {
    if (L.synthetic) return;
    const moved = clips.length !== L.keeps.length || clips.some(c => c.del || Math.abs(c.s - c.os) > .004 || Math.abs(c.e - c.oe) > .004);
    if (moved) saved[L.id] = { keeps: L.keeps, v: 2, clips: clips.map(c => [+c.s.toFixed(3), +c.e.toFixed(3), +c.os.toFixed(3), +c.oe.toFixed(3), c.del ? 1 : 0, c.k]) }; else delete saved[L.id];
    try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) {}
    if (api.onChange) api.onChange();
  }
  function commit() { paint(); persist(); }

  // ---------- reel time <-> raw time, through the words the reel and the recording share ----------
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  function buildAnchors() {
    anchors = [];
    if (!L || L.synthetic || !R) return;
    const A = R.tokens || [], B = L.words.filter(w => inKeep((w.s + w.e) / 2, L.keeps));
    let i = 0, j = 0;
    while (i < A.length && j < B.length) {
      if (norm(A[i].t) === norm(B[j].t)) { anchors.push([A[i].s, B[j].s], [A[i].e, B[j].e]); i++; j++; continue; }
      let found = false;
      for (let d = 1; d <= 6 && !found; d++) for (let a = 0; a <= d; a++) { const b = d - a;
        if (i + a < A.length && j + b < B.length && norm(A[i + a].t) === norm(B[j + b].t)) { i += a; j += b; found = true; break; } }
      if (!found) { i++; j++; }
    }
    const mono = []; anchors.forEach(p => { const q = mono[mono.length - 1]; if (!q || (p[0] >= q[0] && p[1] >= q[1])) mono.push(p); }); anchors = mono;
  }
  function lastAnchor(val, col) { let lo = 0, hi = anchors.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (anchors[m][col] <= val) { k = m; lo = m + 1; } else hi = m - 1; } return k; }
  // reel time <-> raw time: one straight line per clip the autocut kept. Inside a clip the reel runs at the recording's own
  // pace, so the playhead glides and never holds on a word. A clip's line comes from the words
  // the reel and the recording share: a warped beat's fit when the reel plays it faster or slower, else the median offset.
  // A clip that starts right where the clip ahead ends (a quarter second either way) takes its words' line as it is. A jump
  // (footage the reel adds, or cuts out of the clip ahead) needs four words on the line and most of the clip's words, and
  // never starts before the last clip its words placed; otherwise the clip sits right after the one ahead, like a clip with
  // no shared words. Clips with no words of their own give way to a placed clip that starts before them (a vertical reel
  // that drops two short clips). The word match can lose step for a stretch (a retake says the same words): in one
  // long cut, 1-3 stray words a clip pulled runs of clips 12-37 s early, so a click there drew the playhead, and played the
  // reel, that far from the click.
  function buildKmap() {
    kmap = [];
    if (!L) return;
    const onLine = (inK, rs, sc, s) => inK.reduce((n, p) => n + (Math.abs(p[0] - (rs + (p[1] - s) * sc)) <= .15 ? 1 : 0), 0);
    let prev = null, fix = null; const free = [];
    L.keeps.forEach(([s, e]) => {
      const inK = anchors.filter(p => p[1] >= s - .01 && p[1] <= e + .01);
      let sc = 1, rs = null;
      if (inK.length) {
        const offs = inK.map(p => p[0] - p[1]).sort((a, b) => a - b), lines = [];
        const f = inK[0], l = inK[inK.length - 1];   // a reel that plays this clip faster or slower (a warped beat)
        if (l[1] - f[1] > 2 && l[0] - f[0] > 0) { const fit = (l[0] - f[0]) / (l[1] - f[1]); if (Math.abs(fit - 1) > .05) { const w = Math.max(.4, Math.min(2.5, fit)); lines.push([f[0] - (f[1] - s) * w, w]); } }
        lines.push([s + offs[offs.length >> 1], 1]);
        for (const [r, w] of lines) {
          const jump = prev ? r - prev.re : 0, n = onLine(inK, r, w, s);
          if (Math.abs(jump) <= .25 || (n >= 8 && n >= inK.length * .5 && (!fix || r >= fix.rs))) { rs = r; sc = w; break; }
        }
      }
      const placed = rs != null;
      if (!placed) rs = prev ? prev.re : 0;
      else { free.forEach(m => { if (m.rs > rs) { m.rs = rs; m.re = rs + (m.e - m.s) * m.sc; } }); free.length = 0; }
      if (prev && rs < prev.rs) rs = prev.rs;   // the starts only go up
      prev = { s, e, rs, sc, re: rs + (e - s) * sc }; kmap.push(prev);
      if (placed) fix = prev; else free.push(prev);
    });
    fitKmapToSound();
  }
  // The words place a clip only as well as the reel's word times are true, and a cut's reel words are the raw words moved by
  // the summed lengths of the clips before them. The render pads every clip to whole video frames, so each clip really starts
  // a few ms later than that sum and the gap grows along the reel (0.3 to 0.8 s by the end of a long lesson).
  // Switching between the edit and the raw footage landed that far from the moment the other one was on, and every reel part
  // the new edit plays after a cut started that far off. So each clip's start in the reel is then set by its sound: the
  // reel's waveform matched against the raw recording's, near where the clip before put it (a render shifts each clip by a
  // frame or two at most), which lands within 15 ms of where the reel really plays it. A clip too short or too quiet to match
  // keeps the shift of the clip before it.
  const soundFits = new Map();
  function fitKmapToSound() {
    if (!L || L.synthetic || !R || !kmap.length || !(R.peaks && R.peaks.length > 10) || !(L.peaks && L.peaks.length > 10)) return;
    const key = R.id + '|' + L.id + '|' + kmap.length;
    const RP = R.peaks, rr = R.peaksPerSec || 50, WP = L.peaks, wr = L.peaksPerSec || 100, bin = 1 / rr;
    let fit = soundFits.get(key);
    if (!fit) {
      // how well clip m matches the reel when it starts at reel time rs and runs at speed sc (Pearson over the reel's bins)
      const score = (m, rs, sc) => {
        const i0 = Math.max(0, Math.ceil(rs * rr)), i1 = Math.min(RP.length, Math.floor((rs + (m.e - m.s) * sc) * rr));
        const n = i1 - i0; if (n < 15) return -1;
        let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
        for (let i = i0; i < i1; i++) {
          const x = RP[i], t = m.s + (i / rr - rs) / sc, y = peakIn(WP, wr, t - T0, t + bin / sc - T0);
          sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
        }
        const vx = sxx - sx * sx / n, vy = syy - sy * sy / n;
        return vx < n || vy < n ? -1 : (sxy - sx * sy / n) / Math.sqrt(vx * vy);
      };
      // d = how far the clip before ended from where the words put its end; it carries on past a jump in the word map too,
      // since the render's padding sits behind every later clip. A clip the words call faster or slower (a warped beat) is
      // also tried at normal speed straight after the clip before: in a plain cut a few misheard words made one.
      fit = []; let d = 0, pw = null;
      kmap.forEach(m => {
        const joined = pw && Math.abs(m.rs - pw.re) <= .25, lo = d + (joined ? -.05 : -.5), hi = d + (joined ? .1 : .5);
        const tries = [[m.sc, m.rs]]; if (Math.abs(m.sc - 1) > 1e-3) tries.push([1, joined ? pw.re : m.rs]);
        // never into the clip before when the words had them apart: a reel time both clips claim plays the earlier one, so a
        // click in removed footage played the end of the clip before instead of the next one
        const floor = pw && m.rs >= pw.re - 1e-3 ? pw.re + d : -Infinity;
        let best = .6, brs = Math.max(m.rs + d, floor), bs = m.sc;
        for (const [sc, ref] of tries) {
          for (let x = lo; x <= hi + 1e-9; x += .005) { if (ref + x < floor - 1e-6) continue; const c = score(m, ref + x, sc); if (c > best) { best = c; brs = ref + x; bs = sc; } }
        }
        d = brs + (m.e - m.s) * bs - m.re; pw = m; fit.push([brs - m.rs, bs]);
      });
      soundFits.set(key, fit);
    }
    let prev = null;
    kmap.forEach((m, k) => {
      m.rs += fit[k][0]; m.sc = fit[k][1];
      if (prev && m.rs < prev.rs) m.rs = prev.rs;
      m.re = m.rs + (m.e - m.s) * m.sc; prev = m;
    });
  }
  // the first clip whose reel span holds t; a reel time before a clip (footage the reel adds) is that clip's start. Where two
  // clips touch at a cut, the cut belongs to the second, so a clip's first frame maps to that clip: it went to the end of the
  // clip before, across the removed footage between them (once 550 s off), because rounding leaves the first clip a
  // hair past the cut and a video seeked to the cut reads back up to a microsecond short of it (Chrome keeps whole
  // microseconds). A real overlap (a warped beat running into the next clip) stays with the earlier clip.
  function reelToRaw(t) {
    if (!kmap.length) return T0;
    for (let k = 0; k < kmap.length; k++) {
      const m = kmap[k], n = kmap[k + 1];
      if (t < m.rs) return m.s;
      if (t < m.re && !(n && t >= n.rs - 1e-5 && m.re - n.rs < 1e-3)) return m.s + (t - m.rs) / m.sc;
    }
    return kmap[kmap.length - 1].e;
  }
  function rawToReel(t) {
    const dur = R ? R.duration : 0;
    if (!kmap.length) return 0;
    const f = kmap[0];
    if (t < f.s) return Math.max(0, f.rs - (f.s - t));
    // the first clip that ends at or after t (the keeps run in time order), found by binary search
    let lo = 0, hi = kmap.length - 1, k = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (kmap[mid].e >= t) { k = mid; hi = mid - 1; } else lo = mid + 1; }
    if (k >= 0) { const m = kmap[k]; return t < m.s ? m.rs : Math.min(dur, m.rs + (t - m.s) * m.sc); }
    const l = kmap[kmap.length - 1]; return Math.min(dur, l.re + (t - l.e));
  }

  // ---------- drawing only what is on screen ----------
  // win = the pixels of the timeline drawn right now: what you see plus one screen either side, so it is never wider than a
  // canvas can be. A clip keeps its elements while it stays inside it, so dragging one edge repaints one clip.
  const viewW = () => sc.clientWidth > 50 ? sc.clientWidth : 1200;   // a hidden panel measures 0
  const widthPx = () => Math.max(10, Math.ceil(spanNow() * pps));
  function winFor() { const o = viewW(), l = sc.scrollLeft; return { a: Math.max(0, Math.floor(l - o)), b: Math.min(widthPx(), Math.ceil(l + viewW() + o)) }; }
  // true once the view comes within half a screen of the drawn stretch's edge (and there is more timeline past that edge)
  function winStale() {
    if (!win) return true;
    const l = sc.scrollLeft, r = l + viewW(), m = viewW() / 2;
    return (win.a > 0 && l < win.a + m) || (win.b < widthPx() && r > win.b - m);
  }
  // per section: the keeps in order, whether the autocut kept each word, and each word's width in the lane's font (zoom
  // never changes it, so it is measured once, and again when the font finishes loading)
  const mc = document.createElement('canvas').getContext('2d'); mc.font = "500 11.5px Outfit, sans-serif";
  const wWidth = k => wordW[k] != null ? wordW[k] : (wordW[k] = mc.measureText(L.words[k].t).width);
  function prepSection() {
    keepsS = L.keeps.slice().sort((a, b) => a[0] - b[0]);
    wordWas = L.words.map(w => inKeep(midOf(w), L.keeps)); wordW = [];
  }
  if (document.fonts) document.fonts.addEventListener('loadingdone', () => { wordW = []; if (L && win) rebuild(); });
  // a strip wider than a graphics card holds in one piece (often 16,384 px; a long lesson needs 28,800) is cut once into pieces it
  // holds, so no thumbnail is drawn from an oversized image
  function stripTiles(D, im) {
    filmSrc = null;
    const W = im.naturalWidth, per = Math.max(1, Math.floor(8192 / (D.stripW || 1)));
    if (W <= 8192 || !D.stripW || !window.createImageBitmap) return;
    const jobs = [];
    for (let x = 0; x < W; x += per * D.stripW) jobs.push(createImageBitmap(im, x, 0, Math.min(per * D.stripW, W - x), im.naturalHeight));
    Promise.all(jobs).then(bm => { if (img !== im || L !== D) return; filmSrc = { per, bm }; filmGen++; dynamics(); }, () => {});
  }
  function stripFor(D) {
    const im = img = new Image(); filmSrc = null;
    im.onload = () => { if (L !== D) return; stripTiles(D, im); filmGen++; dynamics(); };
    im.src = D.strip;
  }

  // ---------- clip elements: made when a clip comes into the drawn stretch, dropped when it leaves ----------
  // after the clips themselves change (a cut, a reset, an undo, another section) every clip gets fresh elements
  function buildClips() { V1.innerHTML = '<div id="stGaps"></div>'; clipEls = new Map(); }
  // one clip's elements, copied from a template (Fit on an hour-long recording makes all 247 at once: parsing each from
  // text took about 150 ms, a copy is a fraction of that)
  const clipTpl = document.createElement('div'), ghostTpl = document.createElement('div');
  clipTpl.className = 'st-clip'; ghostTpl.className = 'st-ghost';
  clipTpl.innerHTML = '<canvas></canvas><div class="st-rest"></div><div class="st-rest"></div><div class="st-orig"></div><div class="st-orig"></div><div class="st-lbl"></div>' +
    '<button class="st-del"></button>' +
    '<div class="st-handle s" data-side="s" title="Drag to move this clip\'s start. Double-click to put it back."></div>' +
    '<div class="st-handle e" data-side="e" title="Drag to move this clip\'s end. Double-click to put it back."></div>';
  function clipRec() {
    const el = clipTpl.cloneNode(true), gs = ghostTpl.cloneNode(false), ge = ghostTpl.cloneNode(false), q = el.children;
    return { el, gs, ge, cv: q[0], rs: q[1], re: q[2], os: q[3], oe: q[4], lb: q[5], del: q[6], hs: q[7], he: q[8], key: '' };
  }
  function paintClips() {
    const keep = new Set(), held = drag && drag.cl;
    let next = null;   // the first element of the next clip in time: a new clip goes right before it, so the order holds
    for (let k = clips.length - 1; k >= 0; k--) {
      const cl = clips[k], lo = Math.min(X(cl.s), X(cl.os)), hi = Math.max(X(cl.e), X(cl.oe));
      if (cl !== held && (hi < win.a || lo > win.b)) continue;   // the clip being dragged always stays
      let r = clipEls.get(cl);
      if (!r) { r = clipRec(); clipEls.set(cl, r); V1.insertBefore(r.gs, next); V1.insertBefore(r.ge, next); V1.insertBefore(r.el, next); }
      keep.add(cl); next = r.gs;
      paintClip(cl, r);
    }
    for (const [cl, r] of clipEls) if (!keep.has(cl)) { r.gs.remove(); r.ge.remove(); r.el.remove(); clipEls.delete(cl); }
  }
  function paintClip(cl, r) {
    const x = X(cl.s), w = (cl.e - cl.s) * pps, i = cl.i;
    const key = [x, w, i, cl.del, cl.os, cl.oe, win.a, win.b, filmGen].join();
    if (key === r.key) return;   // nothing about this clip changed: leave it be
    r.key = key;
    r.el.id = 'stC' + i; r.el.dataset.i = r.del.dataset.i = r.hs.dataset.i = r.he.dataset.i = i;
    r.el.style.left = x + 'px'; r.el.style.width = w + 'px';
    r.el.classList.toggle('del', cl.del);
    r.el.classList.toggle('narrow', w < 40);   // its ✕ would cover the clip: shown only once the clip is selected
    // orange stripes = footage brought back, red ghosts = footage trimmed away, dashed lines = where the edges were
    const rs = Math.max(0, cl.os - cl.s), re = Math.max(0, cl.e - cl.oe), ts = Math.max(0, cl.s - cl.os), te = Math.max(0, cl.oe - cl.e);
    r.rs.style.cssText = 'left:0;width:' + rs * pps + 'px';
    r.re.style.cssText = 'right:0;width:' + re * pps + 'px';
    r.gs.style.cssText = 'left:' + X(cl.os) + 'px;width:' + ts * pps + 'px;display:' + (ts > .004 && !cl.del ? 'block' : 'none');
    r.ge.style.cssText = 'left:' + X(cl.e) + 'px;width:' + te * pps + 'px;display:' + (te > .004 && !cl.del ? 'block' : 'none');
    r.os.style.cssText = 'left:' + ((cl.os - cl.s) * pps - 1) + 'px;display:' + (Math.abs(cl.s - cl.os) > .004 ? 'block' : 'none');
    r.oe.style.cssText = 'left:' + ((cl.oe - cl.s) * pps - 1) + 'px;display:' + (Math.abs(cl.e - cl.oe) > .004 ? 'block' : 'none');
    // a label only where it fits: the full one on a wide clip, its number on a narrow one, nothing on a sliver
    r.lb.textContent = w >= 110 ? 'Clip ' + (i + 1) + ' · ' + (cl.del ? 'deleted' : (cl.e - cl.s).toFixed(2) + ' s') : w >= 30 ? String(i + 1) : '';
    r.del.textContent = cl.del ? '↺ Restore' : '✕'; r.del.title = cl.del ? 'Bring this clip back' : 'Delete this whole clip (Del)';
    drawFilm(cl, r, x, w);
  }
  // the filmstrip for the part of a clip inside the drawn stretch: one 16:9 thumbnail per slot, from the second under it.
  // A clip under 6 px shows no picture anyway, so it gets none (and no canvas memory)
  function drawFilm(cl, r, x0, w) {
    const cv = r.cv;
    if (w < 6) { cv.width = cv.height = 0; cv.style.width = '0'; return; }
    const a = Math.max(0, Math.floor(win.a - x0)), b = Math.max(a + 1, Math.min(Math.ceil(w), Math.ceil(win.b - x0)));
    const h = 54, cw = b - a;
    cv.width = cw; cv.height = h; cv.style.left = a + 'px'; cv.style.width = cw + 'px';
    if (!img || !img.complete || !img.naturalWidth) return;
    const g = cv.getContext('2d'), tw = h * 16 / 9, cols = L.stripCols || 1e9, t0 = L.stripT0 != null ? L.stripT0 : T0;
    for (let x = Math.floor(a / tw) * tw; x < b; x += tw) {
      const sec = Math.min(L.stripSeconds - 1, Math.max(0, Math.floor(cl.s + x / pps - t0))), col = sec % cols, row = Math.floor(sec / cols);
      let src = img, sx = col * L.stripW;
      if (filmSrc) { const k = Math.floor(col / filmSrc.per); src = filmSrc.bm[k]; sx = (col - k * filmSrc.per) * L.stripW; }
      g.drawImage(src, sx, row * L.stripH, L.stripW, L.stripH, x - a, 0, tw, h);
    }
  }

  // ---------- layers that depend on zoom, on the drawn stretch and (with the cuts hidden) on the clips ----------
  function statics() {
    const W = widthPx(); inner.style.width = W + 'px';
    tlBox.classList.toggle('compact', compact);
    win = winFor();
    const A = win.a, B = win.b, inWin = (x1, x2) => x2 >= A && x1 <= B;
    // the ruler: a label at least every 50 px, however far out you zoom
    const base = compact ? 0 : T0, span = spanNow();
    const step = pps >= 120 ? .5 : pps >= 50 ? 1 : pps >= 25 ? 2 : pps >= 11 ? 5 : pps >= 5 ? 10 : pps >= 3.4 ? 15 : pps >= 1.7 ? 30 : pps >= .85 ? 60 : pps >= .34 ? 150 : 300;
    let h = '';
    for (let n = Math.ceil((base + A / pps) / step - 1e-9); n * step <= base + Math.min(B / pps, span) + 1e-6; n++) {
      const t = n * step, maj = n % 2 === 0;
      h += '<div class="st-tick' + (maj ? ' maj' : '') + '" style="left:' + ((t - base) * pps) + 'px">' + (maj || step >= 2 ? '<span>' + fmtTick(t, step) + '</span>' : '') + '</div>';
    }
    $('stRuler').innerHTML = h;
    let c = '', g = '';
    if (!compact) L.removed.forEach(r => {
      const x1 = X(r.s), x2 = X(r.e); if (!inWin(x1, x2)) return;
      const w = x2 - x1, first = r.why[0].replace(/^earlier take of: .*/, 'earlier take');
      const label = r.why.length > 1 ? first + ' +' + (r.why.length - 1) + ' more' : first;
      const why = esc('Removed ' + (r.e - r.s).toFixed(2) + ' s\n' + r.why.join('\n'));
      // the dot only where the gap holds it (zoomed far out they piled into a smear); the hatched gap keeps the same hover
      c += '<div class="st-gap" title="' + why + '" style="left:' + x1 + 'px;width:' + w + 'px"></div>' + (w >= 22 ? '<div class="st-chip dot" title="' + why + '" style="left:' + (x1 + 2) + 'px;max-width:' + Math.max(0, w - 4) + 'px"><i></i></div>' : '');
      g += '<div class="st-gap" style="left:' + x1 + 'px;width:' + w + 'px"></div>';
    });
    $('stCuts').innerHTML = c; $('stGaps').innerHTML = g;
    // what is on screen in the rendered reel, mapped onto this timeline
    $('stScenes').innerHTML = ((R && R.scenes) || []).map(s => {
      const x1 = X(reelToRaw(s.s)), x2 = X(reelToRaw(Math.max(s.s, s.e - .02)));
      if (!inWin(x1, x2)) return '';
      return '<div class="st-scene" title="' + esc('S' + s.n + ' ' + s.visual + (s.title ? ' "' + s.title + '"' : '') + ' · ' + s.s.toFixed(2) + '-' + s.e.toFixed(2) + ' s of the reel') + '" style="left:' + x1 + 'px;width:' + Math.max(2, x2 - x1 - 1) + 'px">S' + s.n + '</div>';
    }).join('');
    if (ovLane) paintV2(A, B);
    // the words in the drawn stretch (starting 5 s early catches a word already under way at its left edge). A word shows
    // only when it fits its own time span; otherwise a tick with the word on hover, never a chopped word. Zoomed far out,
    // every word is a tick on one canvas.
    const Wd = L.words, tA = Tx(A) - 5, tB = Tx(B);
    let k0 = Wd.length; { let lo = 0, hi = Wd.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (Wd[m].s >= tA) { k0 = m; hi = m - 1; } else lo = m + 1; } }
    let k1 = k0 - 1; while (k1 + 1 < Wd.length && Wd[k1 + 1].s <= tB) k1++;
    wordR = [k0, k1];
    if (pps < WORD_PPS) $('stWords').innerHTML = '<canvas class="st-wave" id="stWordsCv" width="' + (B - A) + '" height="36" style="left:' + A + 'px;width:' + (B - A) + 'px"></canvas>';
    else {
      let wh = '';
      for (let k = k0; k <= k1; k++) {
        const w = Wd[k], x1 = X(w.s), bw = Math.max(3, X(w.e) - x1);
        if (!inWin(x1, x1 + bw)) continue;
        const fits = wWidth(k) + 6 <= bw;
        wh += '<div class="st-word' + (fits ? '' : ' tickw') + '" id="stW' + k + '" title="' + esc(w.t) + '" style="left:' + x1 + 'px;width:' + bw + 'px">' + (fits ? esc(w.t) : '') + '</div>';
      }
      $('stWords').innerHTML = wh;
    }
    const wv = $('stWave'); wv.width = B - A; wv.style.width = (B - A) + 'px'; wv.style.left = A + 'px';
    LY.forEach(l => { l.cv.width = B - A; l.cv.style.width = (B - A) + 'px'; l.cv.style.left = A + 'px'; });

    if (api.onStatics) api.onStatics();   // FX/SFX lanes (app/fx-lanes.js) redraw with the stretch on screen
  }

  // ---------- layers that change with every edge move ----------
  // one pixel = the loudest moment in the stretch of recording it covers (a single sample per pixel skipped peaks zoomed
  // out). Kept, brought back or cut is read at the pixel's middle, walking the clips and the keeps along with x.
  const peakIn = (P, rate, a, b) => { let i = Math.max(0, Math.floor(a * rate)); const j = Math.min(P.length, Math.floor(b * rate)); let p = P[i] || 0; for (i++; i < j; i++) if (P[i] > p) p = P[i]; return p; };
  function drawWave() {
    const cv = $('stWave'), g = cv.getContext('2d'), W = cv.width, H = cv.height, cs = getComputedStyle(document.documentElement);
    g.clearRect(0, 0, W, H);
    if (!win) return;
    const colKeep = cs.getPropertyValue('--text').trim(), colCut = cs.getPropertyValue('--wave').trim();
    const P = L.peaks, pr = L.peaksPerSec, half = .5 / pps, n = clips.length, nk = keepsS.length;
    let ci = 0, ki = 0, style = '';
    for (let x = 0; x < W; x++) {
      const t = Tx(win.a + x + .5), p = peakIn(P, pr, t - half - T0, t + half - T0), hh = Math.max(1, p / 99 * (H - 10));
      while (ci < n && clips[ci].e <= t) ci++;
      while (ki < nk && keepsS[ki][1] <= t) ki++;
      const kept = ci < n && clips[ci].s <= t && !clips[ci].del, was = ki < nk && keepsS[ki][0] <= t;
      const st = kept ? (was ? 'k' : 'b') : 'c';
      if (st !== style) { style = st; g.globalAlpha = kept ? .8 : .35; g.fillStyle = st === 'b' ? '#ff6b1a' : kept ? colKeep : colCut; }
      g.fillRect(x, (H - hh) / 2, 1, hh);
    }
    g.globalAlpha = 1;
  }
  // zoomed far out: each word is a tick on one canvas (grey like a narrow word; orange = brought back, red = taken out)
  function drawWordTicks() {
    const cv = $('stWordsCv'); if (!cv || !L || !win) return;
    const g = cv.getContext('2d'), cs = getComputedStyle(document.documentElement);
    const line = cs.getPropertyValue('--line').trim(), trim = cs.getPropertyValue('--st-trim').trim();
    g.clearRect(0, 0, cv.width, cv.height);
    for (let k = wordR[0]; k <= wordR[1]; k++) {
      const w = L.words[k], kept = keptAt(midOf(w)), was = wordWas[k];
      if (compact && !kept) continue;
      const x1 = X(w.s) - win.a, x2 = Math.max(x1 + 1, X(w.e) - win.a);
      g.globalAlpha = kept ? 1 : .5; g.fillStyle = kept && !was ? '#ff6b1a' : !kept && was ? trim : line;
      g.fillRect(x1, 15, x2 - x1, 6);
    }
    g.globalAlpha = 1;
  }
  // an ADD mark is a green pill over the raw seconds it covers (a plain circle while it is a point). Drag an end to change
  // the seconds, the middle to move it, a point to widen it. Right-click any mark for Remove.
  const spanOf = m => { const a = m.raw != null ? m.raw : reelToRaw(m.t); return [a, m.raw2 != null ? Math.max(a, m.raw2) : a]; };
  function addPill(a, b, cls, id, title) {
    const x1 = X(a), x2 = X(b), wide = x2 - x1 >= 16;
    return '<div class="st-mk add' + (b - a > .004 ? ' span' : '') + cls + '"' + (id ? ' data-id="' + id + '"' : '') + ' style="left:' + x1 + 'px;width:' + (x2 - x1 + 18) + 'px"' + (title ? ' title="' + esc(title) + '"' : '') + '><b>+</b>' +
      (wide ? '<i class="st-addh s" data-edge="s"></i><i class="st-addh e" data-edge="e"></i>' : '') + '</div>';
  }
  function renderMarkers() {
    const at = m => X(m.raw != null ? m.raw : reelToRaw(m.t));
    const pin = (m, on) => '<div class="st-mk' + (m.sel ? ' sel' : '') + '" data-id="' + m.id + '" style="left:' + at(m) + 'px" title="Comment ' + m.n + (on ? ' on ' + esc(on) : '') + ' at ' + m.t.toFixed(2) + ' s of the reel. Drag to move it in time. Right-click to remove.">' + m.n + '</div>';
    // a comment on a sound layer sits in that layer's lane
    const laneOf = m => m.kind === 'layer' ? LY.find(l => l.id === m.layer) : null;
    LY.forEach(l => { l.marks.innerHTML = markers.filter(m => laneOf(m) === l).map(m => pin(m, l.name)).join(''); });
    // painted wide spans first, so a narrower span over a wider one stays reachable, and numbered pins on top
    const depth = m => m.kind === 'add' ? spanOf(m)[1] - spanOf(m)[0] : -1;
    $('stPins').innerHTML = markers.filter(m => !laneOf(m)).sort((p, q) => depth(q) - depth(p)).map(m => {
      if (m.kind !== 'add') return pin(m);
      const [a, b] = spanOf(m);
      return addPill(a, b, m.sel ? ' sel' : '', m.id, b - a > .004 ? 'Add: ' + fmt(a) + ' to ' + fmt(b) + ' raw. Drag an end to change the seconds. Right-click to remove.' : 'Add at ' + fmt(a) + ' raw. Drag to mark the seconds to add. Right-click to remove.');
    }).join('') + (addDrag && addDrag.moved ? addPill(addDrag.a, addDrag.b, ' ghost', '', '') : '');
    $('stMkLines').innerHTML = markers.map(m => {
      if (m.kind !== 'add') return '<div class="st-mkline" style="left:' + at(m) + 'px"></div>';
      const [a, b] = spanOf(m);
      return '<div class="st-mkline add' + (b - a > .004 ? ' span' : '') + '" style="left:' + X(a) + 'px;width:' + Math.max(0, X(b) - X(a)) + 'px"></div>';
    }).join('');
  }
  function paintSel() { clipEls.forEach((r, cl) => r.el.classList.toggle('sel', cl.i === selClip)); }
  function dynamics() {
    if (!win || !L) return;
    paintClips();
    if (pps >= WORD_PPS) for (let k = wordR[0]; k <= wordR[1]; k++) {
      const el = $('stW' + k); if (!el) continue;
      const kept = keptAt(midOf(L.words[k])), was = wordWas[k];
      const cls = 'st-word' + (el.textContent ? '' : ' tickw') + (kept && !was ? ' back' : !kept && was ? ' gone' : !kept ? ' cut' : '') + (compact && !kept ? ' hid' : '') + (k === nowW ? ' now' : '');
      if (el.className !== cls) el.className = cls;
    }
    paintSel(); drawWave(); drawLayers(); drawWordTicks(); renderMarkers();
  }
  function paint() { reindex(); if (compact) statics(); dynamics(); }
  function rebuild() { reindex(); statics(); dynamics(); }
  // scrolling near the edge of the drawn stretch (by hand, or the playhead paging along) draws the next one
  const reWin = () => { if (L && winStale()) { statics(); dynamics(); } };
  sc.addEventListener('scroll', reWin, { passive: true });
  window.addEventListener('resize', reWin);

  // ---------- select and delete whole clips ----------
  function setSel(i) { if (selClip === i) return; selClip = i; if (i != null && api.onSelectClip) api.onSelectClip(); paintSel(); }
  function toggleDelete(i) {
    const c = clips[i]; if (!c || L.synthetic) return;
    if (!c.del && act().length <= 1) { note('Keep at least one clip'); return; }
    checkpoint((c.del ? 'restore clip ' : 'delete clip ') + (i + 1));
    c.del = !c.del; if (compact && c.del) selClip = null;
    commit();
  }
  V1.addEventListener('click', e => { const b = e.target.closest('.st-del'); if (b) toggleDelete(+b.dataset.i); });
  // C cuts the clip under the playhead in two, like Premiere's razor. Each half gets its own edges, so either half can be
  // trimmed or deleted; the cut alone changes no footage, so the edit plays exactly as before.
  function razor() {
    if (!L || L.synthetic) return;
    const t = lastT, c = act().find(c => t > c.s + MIN_CLIP && t < c.e - MIN_CLIP);
    if (!c) { note('Put the playhead inside a clip, then press C to cut it in two'); return; }
    checkpoint('cut clip ' + (c.i + 1) + ' in two');
    const a = t < c.os ? { os: t, oe: t } : { os: c.os, oe: Math.min(t, c.oe) };
    const b = t > c.oe ? { os: t, oe: t } : { os: Math.max(t, c.os), oe: c.oe };
    const A = Object.assign({ k: c.k, s: c.s, e: t, del: false }, a), B = Object.assign({ k: c.k, s: t, e: c.e, del: false }, b);
    clips.splice(clips.indexOf(c), 1, A, B); clips.forEach((x, i) => { x.i = i; });
    selClip = B.i; buildClips(); rebuild(); persist();
    note('Cut clip ' + (A.i + 1) + ' in two at ' + fmt(t) + ' raw. Delete or trim either half.');
  }


  // ---------- edge dragging ----------
  function bounds(cl, side) {
    const prev = clips[cl.i - 1], next = clips[cl.i + 1];
    return side === 's' ? [prev ? prev.e : T0, cl.e - MIN_CLIP] : [cl.s + MIN_CLIP, next ? next.s : T1];
  }
  function setEdge(cl, side, t) { const [a, b] = bounds(cl, side); cl[side] = Math.min(b, Math.max(a, t)); }
  let drag = null, seekPending = null, seekBusy = false;
  // one set of listeners on the V1 lane serves every clip's edges, clips drawn later included. Nothing moves until the mouse
  // does: a click on an edge puts the playhead at the click like a click anywhere else. An edge grip is 14 px wide, so on a
  // short clip or a short gap it is most of what you can click, and a click there used to leave the playhead (and Play)
  // where it was, or send the reel to the next clip.
  V1.addEventListener('pointerdown', e => {
    const h = e.target.closest('.st-handle'); if (!h || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const cl = clips[+h.dataset.i], side = h.dataset.side;
    drag = { h, cl, side, x0: e.clientX, t0: cl[side], moved: false, resume: isPlaying(), snap: snapshot(), pre: api.history ? api.history.snap('move clip ' + (cl.i + 1) + ' ' + (side === 's' ? 'start' : 'end')) : null };
    h.setPointerCapture(e.pointerId);
  });
  V1.addEventListener('pointermove', e => {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.x0) <= 3) return;
      drag.moved = true; drag.h.classList.add('drag'); stopAll(); setSel(drag.cl.i); scrubbing = true;
    }
    // the edge goes exactly where the mouse is: nothing snaps to a word
    const cl = drag.cl, side = drag.side;
    setEdge(cl, side, drag.t0 + (e.clientX - drag.x0) / pps);
    const t = cl[side]; paint();
    showTip(e, cl, side); queueSeek(side === 'e' ? t - 1 / 30 : t);
  });
  const endDrag = e => {
    if (!drag) return;
    if (!drag.moved) {   // a click, not a drag
      const d = drag; drag = null;
      if (e.type !== 'pointerup') return;
      setSel(d.cl.i); if (d.resume) stopAll();
      seekBoth(timeAtX(e)); if (d.resume) play();
      return;
    }
    drag.h.classList.remove('drag'); tip.style.display = 'none';
    if (snapshot() !== drag.snap) { if (api.history && drag.pre) api.history.push(drag.pre); persist(); }
    endScrub(); reelToHere(drag.cl[drag.side]);
    drag = null;
  };
  V1.addEventListener('pointerup', endDrag); V1.addEventListener('pointercancel', endDrag);
  V1.addEventListener('dblclick', e => {
    const h = e.target.closest('.st-handle'); if (!h) return;
    e.stopPropagation(); const cl = clips[+h.dataset.i], side = h.dataset.side;
    checkpoint('put back clip ' + (cl.i + 1) + ' ' + (side === 's' ? 'start' : 'end')); setEdge(cl, side, side === 's' ? cl.os : cl.oe); commit();
  });
  function showTip(e, cl, side) {
    const d = side === 's' ? cl.os - cl.s : cl.e - cl.oe;
    const words = d > 0 ? (side === 's' ? spanWords(L, cl.s, cl.os) : spanWords(L, cl.oe, cl.e)) : (side === 's' ? spanWords(L, cl.os, cl.s) : spanWords(L, cl.e, cl.oe));
    const [a, b] = bounds(cl, side), room = side === 's' ? cl.s - a : b - cl.e;
    tip.innerHTML = '<b class="' + (d > .004 ? 'st-plus' : d < -.004 ? 'st-minus' : '') + '">' + (Math.abs(d) < .004 ? '0.00 s' : (d > 0 ? '+' : '−') + Math.abs(d).toFixed(2) + ' s ' + (d > 0 ? 'brought back' : 'trimmed')) + '</b>' +
      (words ? '<div>“' + esc(words) + '”</div>' : '') + '<span>' + (side === 's' ? 'start' : 'end') + ' at ' + fmt(cl[side]) + ' raw · ' + room.toFixed(2) + ' s more room this way</span>';
    tip.style.display = 'block'; tip.style.left = Math.min(innerWidth - 330, e.clientX + 14) + 'px'; tip.style.top = Math.max(8, e.clientY - 96) + 'px';
  }
  // while dragging, the monitor shows the raw frame at the edge (one seek per animation frame)
  function queueSeek(t) {
    park = null;   // the playhead follows the raw frame being shown
    seekPending = t; if (seekBusy) return; seekBusy = true;
    requestAnimationFrame(() => {
      seekBusy = false; if (seekPending == null) return;
      const vt = Math.max(0, Math.min(v.duration || 1e9, seekPending - P0));
      if (v.fastSeek) v.fastSeek(vt); else rawSeek(vt);
      seekPending = null; setMode('raw'); active = 'raw';
    });
  }

  // ---------- playback: NEW EDIT skips removed parts and deleted clips, RAW plays everything ----------
  // the finished reel needs no label; only raw footage and a layer 2 clip on screen get one
  function paintTag() { const tag = $('stTag'); tag.textContent = view === 'raw' ? (mode === 'edit' ? 'NEW EDIT · RAW FOOTAGE' : mode === 'plan' ? 'ADDED FOOTAGE · RAW' : 'RAW FOOTAGE') : (ovShown >= 0 ? 'V2' : ''); tag.hidden = !tag.textContent; tag.className = 'st-tag' + (view === 'raw' ? ' raw' : ''); }
  function setMode(m) { mode = m; paintTag(); }
  // the one player: 'reel' = the finished render, 'raw' = the recording (edge drags, new edit, raw playback, removed footage)
  function setView(which) { if (view === which) return; view = which; vbox.classList.toggle('raw', which === 'raw'); paintTag(); }
  // where the playhead is right now, in raw time: where you parked it, else the picture that shows (as tick draws it)
  const headNow = () => park != null ? park : (!L || L.synthetic || active === 'reel') ? reelToRaw(mainV.currentTime || 0) : v.currentTime + P0;
  const clipAtOrAfter = t => act().find(c => t < c.e - .01) || null;
  function pauseMain() { if (mainV && !mainV.paused) mainV.pause(); }
  function playEdit(from, until) {
    if (!L || L.synthetic) return;
    plan.on = false; setMode('edit'); stopAt = until == null ? null : until; pauseMain(); active = 'raw';
    let t = from == null ? v.currentTime + P0 : from, c = clipAtOrAfter(t);
    if (!c) { c = act()[0]; t = c.s; }
    if (t < c.s) t = c.s;
    v.currentTime = t - P0; v.play();
  }
  // the recording plays from the playhead, not from wherever the raw video was last left (a reel seek's late follow-up could
  // have moved it, or a click on a clip edge never moved it)
  function playRaw() {
    if (!L || L.synthetic) return;
    const t = headNow(); plan.on = false; setMode('raw'); stopAt = null; pauseMain(); active = 'raw'; park = null;
    if (Math.abs(v.currentTime + P0 - t) > .01) v.currentTime = Math.max(0, t - P0);
    v.play();
  }
  function playEditFromStart() { if (!R) return; stopAll(); plan.segs = buildPlan(); plan.on = true; playSeg(0); }
  function togglePlayEdit() { if (isPlaying()) stopAll(); else playEditFromStart(); }

  // ---------- Play = your edit as it stands. The finished reel plays wherever it still matches your clips; footage you
  // dragged back in plays from the raw recording in the same window; trimmed parts and deleted clips are skipped. With no
  // changes the plan is one segment, the plain reel. Shift+Space (playEdit above) still plays everything from the raw. ----------
  const plan = { on: false, segs: [], i: -1, pre: false };
  // reel time of a raw moment inside clip c: the reel plays each clip at normal speed, pinned to the first word it shares
  function reelAt(c, t) { const m = kmap[c.k]; return m ? m.rs + (t - m.s) * m.sc : rawToReel(t); }
  function buildPlan() {
    const dur = R ? R.duration : 0;
    if (!L || L.synthetic) return [{ src: 'reel', a: 0, b: dur, ra: 0, rb: dur }];
    const live = act(), segs = [], eps = .02;
    live.forEach(c => {
      if (c.s < c.os - eps) segs.push({ src: 'raw', a: c.s, b: Math.min(c.os, c.e) });
      const a = Math.max(c.s, c.os), b = Math.min(c.e, c.oe);
      if (b - a > eps) segs.push({ src: 'reel', a, b, ra: reelAt(c, a), rb: reelAt(c, b), c0: c.i, c1: c.i, open: Math.abs(c.s - c.os) < eps, close: Math.abs(c.e - c.oe) < eps });
      if (c.e > c.oe + eps) segs.push({ src: 'raw', a: Math.max(c.oe, c.s), b: c.e });
    });
    // the reel's own lead-in and tail stay when the first / last clip keeps its original edge
    const f = live[0], l = live[live.length - 1], first = segs[0], last = segs[segs.length - 1];
    if (first && first.src === 'reel' && f.i === 0 && Math.abs(f.s - f.os) < eps) first.ra = 0;
    if (last && last.src === 'reel' && l.i === clips.length - 1 && Math.abs(l.e - l.oe) < eps) last.rb = dur;
    // two neighbouring clips whose shared cut is untouched already sit back to back in the reel: play straight through,
    // no seek, so an unchanged reel is one segment and plays exactly as before
    const out = [];
    segs.forEach(s => {
      const p = out[out.length - 1];
      if (p && p.src === 'reel' && s.src === 'reel' && p.close && s.open && s.c0 === p.c1 + 1) { p.b = s.b; p.rb = s.rb; p.c1 = s.c1; p.close = s.close; }
      else out.push(s);
    });
    out.forEach(s => { if (s.src === 'reel') { s.ra = Math.max(0, s.ra); s.rb = Math.min(dur, s.rb); } });
    return out;
  }
  const isPlaying = () => plan.on || !mainV.paused || !v.paused;
  function stopAll() { plan.on = false; if (!mainV.paused) mainV.pause(); if (!v.paused) v.pause(); }
  function playSeg(i, at) {
    const s = plan.segs[i]; plan.i = i; plan.pre = false;
    // start the new picture before stopping the old one, so the raw footage's pause handler never drags the reel along
    if (s.src === 'reel') { mainV.currentTime = at != null ? at : s.ra; active = 'reel'; mainV.play(); if (!v.paused) v.pause(); }
    else { setMode('plan'); v.currentTime = Math.max(0, (at != null ? at : s.a) - P0); active = 'raw'; v.play(); pauseMain(); }
  }
  function startPlan() {
    if (!R) return;
    // Play at (or within a quarter second of) the end starts over from the top: without this the press found no part left to
    // play, sat on the last frame and looked broken. The fast-seek copy can run a few ms past R.duration.
    const endAt = Math.min(R.duration || Infinity, mainV.duration || Infinity);
    if (active !== 'raw' && isFinite(endAt) && (mainV.ended || (mainV.currentTime || 0) >= endAt - .25)) {
      mainV.currentTime = 0; park = null; if (L && !L.synthetic && act()[0]) lastT = act()[0].s;
    }
    plan.segs = buildPlan(); plan.on = true;
    const segs = plan.segs;
    let i = -1, at = null;
    // a parked playhead is a raw time: it plays from there (below), never from the reel's own clock
    if ((active === 'reel' && park == null) || !L || L.synthetic) {
      const rt = mainV.currentTime || 0;
      i = segs.findIndex(s => s.src === 'reel' && rt >= s.ra - .05 && rt < s.rb - .05);
      if (i >= 0) at = Math.max(segs[i].ra, rt);
    }
    if (i < 0) {
      const t = headNow(), c = act().find(c => t >= c.s - .02 && t < c.e);
      i = segs.findIndex(s => t >= s.a - .02 && t < s.b - .05);
      // a reel part that spans several untouched clips also spans the removed footage between them: a playhead parked in that
      // footage plays from where the monitor shows it (the next kept word, rawToReel), never from the part's start
      // (a playhead up to 20 ms before a clip counts as that clip and starts on its first frame, not the last frame of the clip
      // before it in the reel)
      if (i >= 0) at = segs[i].src === 'raw' ? Math.max(segs[i].a, t) : (c ? Math.max(segs[i].ra, reelAt(c, Math.max(t, c.s))) : Math.min(segs[i].rb, Math.max(segs[i].ra, rawToReel(t))));
      else { i = segs.findIndex(s => s.a >= t); if (i < 0) i = 0; at = null; }   // on removed footage: the next part; at the end: from the top
    }
    playSeg(i, at);
  }
  // one Play: the edit as it stands, or the original recording when the Raw footage box is ticked
  let rawOn = false; try { rawOn = localStorage.getItem(NS + ':raw') === '1'; } catch (e) {}
  const rawBox = $('stRawToggle');
  // Ticking it (or R) while something plays carries on from the same spoken moment in the other one: the moment is read
  // before anything stops (a stopped video's late pause event used to move the other picture first) and held as the parked
  // playhead, which both Plays start from. Ticked while stopped, the next Play starts from the playhead.
  if (rawBox) { rawBox.checked = rawOn; rawBox.addEventListener('change', () => {
    rawOn = rawBox.checked; try { localStorage.setItem(NS + ':raw', rawOn ? '1' : '0'); } catch (e) {}
    const was = isPlaying() && L && !L.synthetic, t = was ? headNow() : null;
    stopAll(); rawBox.blur();
    if (was) { park = t; selfSeek = performance.now() + 400; play(); }
  }); }
  // Play, the same way wherever it starts from: the Space key, the button, and playback picking up again after a click on
  // the timeline while it played (that once always played the edit, so with Raw footage ticked a click jumped to the reel)
  function play() { if (rawOn && L && !L.synthetic) playRaw(); else startPlan(); }
  function togglePlay() { if (isPlaying()) stopAll(); else play(); }
  mainV.addEventListener('play', () => { if (!v.paused) v.pause(); active = 'reel'; });
  // the raw monitor follows the reel preview whenever the preview stops somewhere new
  // (not while the playhead is parked: the raw video already sits at the click, and a reel seek that finishes after the
  // 400 ms guard used to drag it to the map's idea of that spot)
  function followReel() { if (!L || L.synthetic || park != null || performance.now() < selfSeek || active !== 'reel' || !v.paused || !mainV.paused) return; v.currentTime = Math.max(0, reelToRaw(mainV.currentTime || 0) - P0); }
  mainV.addEventListener('seeked', followReel); mainV.addEventListener('pause', followReel);
  function reelToHere(t) { selfSeek = performance.now() + 400; if (api.onSeekReel) api.onSeekReel(rawToReel(t)); }
  // the reel catches up when the raw footage stops, unless a click parked the playhead: a click while the raw played pauses
  // it, and this event lands after the click's own seeks, so it put the reel back where the raw had been
  v.addEventListener('pause', () => { if (L && !L.synthetic && !drag && mainV.paused && park == null) reelToHere(v.currentTime + P0); });
  let lastBtn = '', phX = null, clkRaw = '', clkEdit = '';
  (function tick() {
    // a card with no raw-footage panel (a tier card) never runs the loop below, so its finished Play stayed "on" and the next
    // press only stopped it: clear it here once the reel has stopped
    if (plan.on && (!L || panel.hidden) && (mainV.paused || mainV.ended)) plan.on = false;
    if (L && !panel.hidden && win) {
      if (!mainV.paused) active = 'reel'; else if (!v.paused) active = 'raw';
      if (!mainV.paused || !v.paused) park = null;
      setView(L.synthetic ? 'reel' : active);
      const t = headNow();
      if (plan.on) {
        const s = plan.segs[plan.i], el = s && (s.src === 'reel' ? mainV : v);
        if (!s || el.paused) plan.on = false;   // something else stopped it: a drag, a pin, the end of the video
        else {
          const done = s.src === 'reel' ? (mainV.ended || mainV.currentTime >= s.rb - .04) : (v.currentTime + P0 >= s.b - .03);
          if (done) { if (plan.i + 1 < plan.segs.length) playSeg(plan.i + 1); else stopAll(); }
          else if (!plan.pre && plan.segs[plan.i + 1]) {   // line the other picture up now, so the switch is instant
            const n = plan.segs[plan.i + 1]; plan.pre = true;
            if (n.src === 'raw' && s.src === 'reel') v.currentTime = Math.max(0, n.a - P0);
            if (n.src === 'reel' && s.src === 'raw') mainV.currentTime = n.ra;
          }
        }
      }
      if (!plan.on && !v.paused && mode === 'edit') {
        const live = act(), k = live.findIndex(c => t >= c.s - .02 && t < c.e);
        if (k < 0) { const n = clipAtOrAfter(t); if (n && n.s > t) v.currentTime = n.s - P0; else if (!n) v.pause(); }
        else if (t >= live[k].e - .03) { const n = live[k + 1]; if (n) v.currentTime = n.s - P0; else v.pause(); }
      }
      if (!v.paused && stopAt != null && t >= stopAt) { v.pause(); stopAt = null; }
      lastT = t;
      if (api.onTick) api.onTick(t);   // FX/SFX lanes: SFX playback + FX tag follow the playhead
      // page along with the playhead (layout is read here, before this frame writes anything)
      const x = X(t);
      if ((!v.paused || !mainV.paused) && !drag) { if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 30) sc.scrollLeft = x - 60; }
      // the playhead moves by transform (no layout), and the clocks change only when their text does
      if (x !== phX) { phX = x; ph.style.transform = 'translateX(' + x + 'px)'; }
      const cr = fmt(t), ce = fmt(rawToEdit(t));
      if (cr !== clkRaw) { clkRaw = cr; $('stClkRaw').textContent = cr; }
      if (ce !== clkEdit) { clkEdit = ce; $('stClkEdit').textContent = ce; }
      // the word being said
      let w = -1; const W = L.words; { let lo = 0, hi = W.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (W[m].s <= t) { w = m; lo = m + 1; } else hi = m - 1; } if (w >= 0 && t > W[w].e + .25) w = -1; }
      if (w !== nowW) { const a = $('stW' + nowW), b = $('stW' + w); if (a) a.classList.remove('now'); if (b) b.classList.add('now'); nowW = w; }
    }
    requestAnimationFrame(tick);
  })();

  // ---------- pointer on the tracks: move a comment in time, select a clip, or move the playhead ----------
  let ptr = null;
  function seekBoth(t) {
    selfSeek = performance.now() + 400;
    if (!L.synthetic) { park = t; rawSeek(Math.max(0, t - P0)); if (mainV.paused && v.paused) active = inKeep(t, L.keeps) ? 'reel' : 'raw'; }
    reelSeek(rawToReel(t));
  }
  const timeAtX = e => clampT(Tx(Math.max(0, e.clientX - inner.getBoundingClientRect().left)));
  const toReel = t => L.synthetic ? t : rawToReel(t);
  // an ADD span being dragged: the tip names the seconds and the words in them, the monitor shows the raw frame at the pointer
  function spanTip(e, a, b) {
    const words = spanWords(L, a, b);
    tip.innerHTML = '<b class="st-okc">' + (b - a).toFixed(2) + ' s</b>' + (words ? '<div>“' + esc(words) + '”</div>' : '') + '<span>' + fmt(a) + ' to ' + fmt(b) + ' raw</span>';
    tip.style.display = 'block'; tip.style.left = Math.min(innerWidth - 330, e.clientX + 14) + 'px'; tip.style.top = Math.max(8, e.clientY - 96) + 'px';
  }
  inner.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !L || e.target.closest('.st-handle, .st-del, .st-ph-add')) return;
    inner.setPointerCapture(e.pointerId);
    const mk = e.target.closest('.st-mk'), m = mk && markers.find(x => x.id === mk.dataset.id);
    if (m && m.kind === 'add') {
      // an end = that end follows the mouse; the middle of a wide span = move it; a point or a thin span = widen it,
      // towards whichever way the mouse goes first
      const [a, b] = spanOf(m), edge = e.target.closest('.st-addh');
      ptr = { kind: 'add', id: m.id, x0: e.clientX, t0: timeAtX(e), a, b, mode: edge ? edge.dataset.edge : mk.querySelector('.st-addh') ? 'move' : 'widen', moved: false };
      scrubbing = true; if (api.onMarkerDown) api.onMarkerDown(ptr.id); return;
    }
    if (mk) { park = null; ptr = { kind: 'marker', id: mk.dataset.id, x0: e.clientX, moved: false }; if (api.onMarkerDown) api.onMarkerDown(ptr.id); return; }
    const clipEl = e.target.closest('.st-clip');
    setSel(clipEl && !L.synthetic ? +clipEl.dataset.i : null);
    // a sound lane: a click comments on that layer at that moment (and picks the lane for A); a drag only scrubs
    const lane = e.target.closest('.st-layer'); if (lane) selectLayer(lane.dataset.layer);
    // a block on V2: the playhead goes to that overlay's start (a drag from it still scrubs)
    const ovEl = e.target.closest('.st-ov'), ovT = ovEl ? ovStartAt(+ovEl.dataset.ov) : null;
    ptr = { kind: 'scrub', resume: isPlaying(), layer: lane ? lane.dataset.layer : null, x0: e.clientX, moved: false, t: ovT != null ? ovT : timeAtX(e) };
    if (ptr.resume) stopAll(); scrubbing = true; seekBoth(ptr.t);
  });
  inner.addEventListener('pointermove', e => {
    if (!ptr) return;
    if (ptr.kind === 'scrub') { if (Math.abs(e.clientX - ptr.x0) > 3) ptr.moved = true; ptr.t = timeAtX(e); seekBoth(ptr.t); return; }
    if (Math.abs(e.clientX - ptr.x0) > 2) ptr.moved = true;
    if (!ptr.moved) return;
    const t = timeAtX(e);
    if (ptr.kind === 'add') {
      if (isPlaying()) stopAll();
      let a, b;
      if (ptr.mode === 'move') { const d = Math.max(T0 - ptr.a, Math.min(T1 - ptr.b, t - ptr.t0)); a = ptr.a + d; b = ptr.b + d; }
      else {
        if (ptr.mode === 'widen') ptr.mode = t >= ptr.t0 ? 'e' : 's';
        const anchor = ptr.mode === 's' ? ptr.b : ptr.a; a = Math.min(anchor, t); b = Math.max(anchor, t);
      }
      spanTip(e, a, b); if (!L.synthetic) queueSeek(ptr.mode === 'move' ? a : t);
      if (api.onAddSpan) api.onAddSpan(ptr.id, a, b, toReel(a));
      return;
    }
    if (api.onMarkerMove) api.onMarkerMove(ptr.id, rawToReel(t), t);
  });
  const endPtr = () => {
    if (!ptr) return; const p = ptr; ptr = null; endScrub();
    if (p.kind === 'add') { tip.style.display = 'none'; if (api.onMarkerUp) api.onMarkerUp(p.id, p.moved); return; }
    if (p.kind === 'scrub' && p.layer && !p.moved) { if (api.onLayerMark) api.onLayerMark(p.layer, toReel(p.t)); return; }
    if (p.kind === 'marker' && api.onMarkerUp) api.onMarkerUp(p.id, p.moved); if (p.kind === 'scrub' && p.resume) play();
  };
  inner.addEventListener('pointerup', endPtr); inner.addEventListener('pointercancel', endPtr);
  // right-click a mark on the timeline: the editor opens its Remove menu
  inner.addEventListener('contextmenu', e => { const mk = e.target.closest('.st-mk[data-id]'); if (!mk) return; e.preventDefault(); if (api.onMarkerContext) api.onMarkerContext(mk.dataset.id, e.clientX, e.clientY); });

  // ---------- toolbar ----------
  // Fit shows the whole recording, an hour-long one too (nothing off screen is drawn, so zoom no longer stops at 6 px a
  // second); that far out the words become ticks and clip labels shorten to what fits
  const fitRaw = () => (viewW() - 8) / Math.max(1, spanNow());
  const minPps = () => Math.max(.05, Math.min(6, fitRaw()));
  const fitPps = () => Math.max(minPps(), Math.min(260, fitRaw()));
  // keep raw time t under screen x: the new width goes in first, so the scroll can reach it, then the stretch there is drawn
  function relayout(t, x) { reindex(); inner.style.width = widthPx() + 'px'; sc.scrollLeft = X(t) - x; rebuild(); }
  function setZoom(p, keepT, atX) {
    const t = keepT == null ? lastT : keepT, x = atX == null ? sc.clientWidth / 2 : atX;
    pps = Math.max(minPps(), Math.min(260, +p.toFixed(3))); relayout(t, x);
  }
  $('stZoomIn').addEventListener('click', () => setZoom(pps * 1.4));
  $('stZoomOut').addEventListener('click', () => setZoom(pps / 1.4));
  $('stFit').addEventListener('click', () => setZoom(fitPps(), T0, 0));
  // Ctrl + wheel zooms around the mouse. The wheel events of one frame add up into one zoom, sized by how far the wheel
  // turned: one mouse notch is 1.15x as before, and a trackpad pinch glides instead of jumping 15% a tick
  let zq = null;
  sc.addEventListener('wheel', e => {
    if ((!e.ctrlKey && !e.metaKey) || !L) return;
    e.preventDefault();
    const dy = Math.max(-300, Math.min(300, e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1)));
    if (!zq) {
      const r = inner.getBoundingClientRect();
      zq = { f: 1, t: Tx(e.clientX - r.left), x: e.clientX - sc.getBoundingClientRect().left };
      requestAnimationFrame(() => { const q = zq; zq = null; setZoom(pps * q.f, q.t, q.x); });
    }
    zq.f *= Math.exp(-dy * .0014);
  }, { passive: false });
  function paintHide() { const b = $('stHideCuts'); b.textContent = compact ? '◧ Show cuts' : '◨ Hide cuts'; b.classList.toggle('primary', compact); }
  function setCompact(on) {
    compact = !!on; try { localStorage.setItem(NS + ':hideCuts', compact ? '1' : '0'); } catch (e) {}
    paintHide(); if (!L) return;
    if (compact && selClip != null && clips[selClip].del) selClip = null;
    pps = Math.max(minPps(), pps); relayout(lastT, sc.clientWidth / 2);
  }
  $('stHideCuts').addEventListener('click', () => setCompact(!compact)); paintHide();
  $('stUndo').addEventListener('click', () => { if (api.history) api.history.undo(); });
  $('stRedo').addEventListener('click', () => { if (api.history) api.history.redo(); });
  $('stReset').addEventListener('click', () => {
    if (!L || L.synthetic || (clips.length === L.keeps.length && !changesOf(clips, L, false).length)) return;
    checkpoint('reset all clips'); clips = L.keeps.map(([s, e], i) => ({ i, k: i, s, e, os: s, oe: e, del: false })); selClip = null; buildClips(); rebuild(); persist();
  });
  new MutationObserver(() => { if (L) { drawWave(); drawLayers(); drawWordTicks(); } }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ---------- sound layers (opt-in) ----------
  // A version's reel, or its section in source-data.js, may carry `layers`. Each gets a lane under A1 (its waveform in reel
  // time; on a raw-footage section only over the footage the reel kept), with Mute (M) and Solo (S) in its head. While layers
  // exist the reel video is muted and the layer files play through Web Audio: started at the video's own time on every play,
  // seek and speed change (the pitch follows the speed), stopped on every pause, and lined up again if they drift apart. The
  // raw recording keeps its own sound. A page opened as a file can't read the layer files (the browser blocks it), so there
  // the lanes still show and take comments while the reel plays its own mix.
  const layerAudio = /^https?:$/.test(location.protocol);
  const mix = {};                              // mute / solo per layer id, kept across versions for this page load
  const bufs = new Map();                      // src -> decoded audio (a promise), only for the layers on screen
  const sync = { on: false, at: 0, ctxAt: 0, rate: 1, hold: 0 };
  let ac = null, master = null, outMeter = null, masterMuted = false, decoder = null;
  const levelOf = an => { if (!an) return 0; const a = new Float32Array(an.fftSize); an.getFloatTimeDomainData(a); let m = 0; for (const x of a) m = Math.max(m, Math.abs(x)); return +m.toFixed(4); };
  function layersOf(r) {
    const D = SRC[r.base || r.id], list = r.layers && r.layers.length ? r.layers : D && D.layers;
    return list && list.length ? list : null;
  }
  const audible = l => !mix[l.id].mute && (!LY.some(x => mix[x.id].solo) || mix[l.id].solo);
  const expected = () => sync.at + (ac.currentTime - sync.ctxAt) * sync.rate;
  function paintLayers() {
    LY.forEach(l => {
      const m = mix[l.id], on = audible(l), sel = layerSel === l.id;
      l.head.querySelector('[data-act="mute"]').classList.toggle('on', m.mute);
      l.head.querySelector('[data-act="solo"]').classList.toggle('on', m.solo);
      l.head.classList.toggle('sel', sel); l.lane.classList.toggle('sel', sel);
      l.head.classList.toggle('off', !on); l.lane.classList.toggle('off', !on);
    });
    const add = $('stAdd'), s = LY.find(l => l.id === layerSel);
    if (add) add.title = s ? 'Comment on the ' + s.name + ' layer here (A)' : 'Mark something to add here (A)';
  }
  function applyMute() {
    mainV.muted = masterMuted || (LY.length > 0 && layerAudio);
    v.muted = masterMuted;
    if (master) master.gain.value = masterMuted ? 0 : 1;
    LY.forEach(l => { if (l.gain) l.gain.gain.value = audible(l) ? 1 : 0; });
    paintLayers();
  }
  function selectLayer(id) { layerSel = id && LY.some(l => l.id === id) ? id : null; paintLayers(); }
  function wireLayer(l) {
    if (!ac || l.gain) return;
    l.gain = ac.createGain(); l.meter = ac.createAnalyser(); l.meter.fftSize = 2048;
    l.gain.connect(l.meter); l.meter.connect(master);
  }
  function ensureContext() {
    if (ac || !layerAudio) return ac;
    const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return null;
    ac = new Ctx(); master = ac.createGain(); outMeter = ac.createAnalyser(); outMeter.fftSize = 2048;
    master.connect(outMeter); outMeter.connect(ac.destination);
    LY.forEach(wireLayer); applyMute();
    return ac;
  }
  function layerStop() {
    LY.forEach(l => { if (l.node) { try { l.node.stop(); } catch (e) {} l.node.disconnect(); l.node = null; } });
    sync.on = false;
  }
  function layerStart() {
    layerStop();
    if (!LY.length || !ac || mainV.paused) return;
    const t = mainV.currentTime || 0, rate = mainV.playbackRate || 1;
    LY.forEach(l => {
      if (!l.buf || !l.gain || t >= l.buf.duration) return;
      const n = ac.createBufferSource(); n.buffer = l.buf; n.playbackRate.value = rate; n.connect(l.gain); n.start(0, t); l.node = n;
    });
    Object.assign(sync, { on: true, at: t, ctxAt: ac.currentTime, rate, hold: performance.now() + 350 });
  }
  function layerPlay() {
    if (!LY.length || !layerAudio || mainV.paused || !ensureContext()) return;
    if (ac.state !== 'running') { ac.resume().then(() => { if (!mainV.paused) layerStart(); }, () => {}); return; }
    if (sync.on && sync.rate === (mainV.playbackRate || 1) && Math.abs(expected() - mainV.currentTime) < .05) return;
    layerStart();
  }
  function loadLayer(l) {
    if (!bufs.has(l.src)) {
      if (!decoder) decoder = new OfflineAudioContext(2, 1, 48000);
      bufs.set(l.src, fetch(l.src).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); }).then(b => decoder.decodeAudioData(b)));
    }
    bufs.get(l.src).then(buf => {
      if (!LY.includes(l)) return;
      l.buf = buf;
      if (sync.on) layerStart(); else layerPlay();
    }, () => { l.head.title = 'Could not load ' + l.src; l.head.classList.add('off'); });
  }
  function setLayers(list) {
    const key = list ? list.map(d => d.id + '|' + d.src).join(',') : '';
    if (key === layerKey) return;
    layerStop();
    LY.forEach(l => { l.head.remove(); l.lane.remove(); if (l.meter) { try { l.gain.disconnect(); l.meter.disconnect(); } catch (e) {} } });
    for (const k of [...bufs.keys()]) if (!list || !list.some(d => d.src === k)) bufs.delete(k);
    layerKey = key; LY = [];
    const heads = tlBox.querySelector('.st-heads'), a1h = heads.querySelector('.st-h-a1');
    let hAt = a1h, lAt = $('stWave').parentElement;
    (list || []).forEach(d => {
      const name = d.name || d.id;
      if (!mix[d.id]) mix[d.id] = { mute: false, solo: false };
      const off = layerAudio ? '' : ' disabled title="Mute and Solo play the layers when the page comes from the Claude Video Editor server (node server.mjs)"';
      const head = document.createElement('div'); head.className = 'st-h-layer st-lhead'; head.dataset.layer = d.id;
      head.title = 'Click to pick this lane: A (or + on the playhead) then comments on ' + name + '.';
      head.innerHTML = '<span class="st-lname">' + esc(name) + '</span><span class="st-lbtns">' +
        '<button class="st-lb" data-act="mute"' + (off || ' title="Mute ' + esc(name) + '"') + '>M</button>' +
        '<button class="st-lb" data-act="solo"' + (off || ' title="Solo: hear only ' + esc(name) + '"') + '>S</button></span>';
      const lane = document.createElement('div'); lane.className = 'st-lane st-h-layer st-layer'; lane.dataset.layer = d.id;
      lane.title = 'Click to comment on ' + name + ' at this moment. Drag to move the playhead.';
      lane.innerHTML = '<canvas class="st-wave" height="42"></canvas><div class="st-lmarks"></div>';
      hAt.after(head); lAt.after(lane); hAt = head; lAt = lane;
      LY.push({ id: d.id, name, src: d.src, file: d.file, peaks: d.peaks || [], pps: d.peaksPerSec || 50, head, lane,
        cv: lane.querySelector('canvas'), marks: lane.querySelector('.st-lmarks'), gain: null, meter: null, node: null, buf: null });
    });
    tlBox.classList.toggle('has-layers', LY.length > 0); document.body.classList.toggle('has-layers', LY.length > 0);
    if (LY.length) { a1h.innerHTML = 'A1<small>MIX</small>'; a1h.title = 'A1: the full mix, every layer together'; } else { a1h.textContent = 'A1'; a1h.removeAttribute('title'); }
    const hints = panel.querySelector('.hints'); let hint = $('stLayerHint');
    if (LY.length && hints && !hint) { hint = document.createElement('span'); hint.id = 'stLayerHint'; hints.appendChild(hint); }
    if (hint) { if (LY.length) hint.innerHTML = ' · click a sound lane to comment on that layer, or click its name and press <kbd>A</kbd> · M mutes a layer, S plays it alone'; else hint.remove(); }
    if (!LY.some(l => l.id === layerSel)) layerSel = null;
    if (ac) LY.forEach(wireLayer);
    if (layerAudio) LY.forEach(loadLayer);
    applyMute();
  }
  // each lane over the drawn stretch: in reel time, and on a raw-footage section only over the footage the reel kept
  function drawLayers() {
    if (!LY.length || !L || !win) return;
    const col = getComputedStyle(document.documentElement).getPropertyValue('--text').trim(), half = .5 / pps;
    LY.forEach(l => {
      const g = l.cv.getContext('2d'), W = l.cv.width, H = l.cv.height;
      g.clearRect(0, 0, W, H); g.fillStyle = col; g.globalAlpha = .8;
      let ki = 0;
      for (let x = 0; x < W; x++) {
        const t = Tx(win.a + x + .5);
        if (!L.synthetic) { while (ki < keepsS.length && keepsS[ki][1] <= t) ki++; if (!(ki < keepsS.length && keepsS[ki][0] <= t)) continue; }
        const p = (L.synthetic ? peakIn(l.peaks, l.pps, t - half - T0, t + half - T0) : l.peaks[Math.floor(rawToReel(t) * l.pps)] || 0) / 99, hh = Math.max(1, p * (H - 8));
        g.fillRect(x, (H - hh) / 2, 1, hh);
      }
      g.globalAlpha = 1;
    });
  }
  tlBox.querySelector('.st-heads').addEventListener('click', e => {
    const head = e.target.closest('.st-lhead'); if (!head) return;
    const id = head.dataset.layer, b = e.target.closest('[data-act]');
    if (b) { mix[id][b.dataset.act] = !mix[id][b.dataset.act]; b.blur(); applyMute(); return; }
    selectLayer(layerSel === id ? null : id);
  });
  ['pause', 'waiting', 'seeking', 'emptied', 'ended'].forEach(ev => mainV.addEventListener(ev, layerStop));
  ['playing', 'seeked'].forEach(ev => mainV.addEventListener(ev, layerPlay));
  mainV.addEventListener('ratechange', () => { if (sync.on) layerStart(); });
  (function layerLoop() {
    if (sync.on && ac) {
      if (mainV.paused) layerStop();
      else if (performance.now() > sync.hold && Math.abs(expected() - (mainV.currentTime || 0)) > .12) layerStart();
    }
    requestAnimationFrame(layerLoop);
  })();

  // ---------- layer 2 (opt-in): b-roll and title cards over the main video ----------
  // A version's reel, or its section in source-data.js, may carry `overlays`: clips on layer 2 of the edit, over the main
  // video. `start` is the reel's own time (the edit clock), `in` the overlay file's time at that moment, `len` how long it
  // stays. Each gets a block on a V2 lane above V1 (a click goes to its start). While the playhead is inside one, its video
  // plays over the reel, full frame and muted (the reel's sound carries on), held to the reel's frame: seeked to
  // in + (t - start) whenever the reel stops, seeks or scrubs, and nudged back into step while both play, at any speed and
  // on Full screen. Never over the raw recording: overlays belong to the edit. One video element per overlay, each waiting
  // on its first frame, so the picture changes the moment the reel reaches it. The eye on the lane head, or B, hides layer 2
  // to see the footage under it; a pin made while one shows is tagged with it (overlayNow), so the export names it.
  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
  function overlaysOf(r) {
    const D = SRC[r.base || r.id], list = r.overlays && r.overlays.length ? r.overlays : D && D.overlays;
    return list && list.length ? list : null;
  }
  // where an overlay sits on this timeline: its stretch of the reel, split where the reel jumps from one kept clip to the
  // next, so on a raw-footage section each piece lies over the footage under it (removed footage between pieces has none).
  // In reel order: the first piece starts where the overlay starts.
  function ovPieces(o) {
    const a = o.start, b = o.start + o.len;
    if (!L || L.synthetic || !kmap.length) return [[a, b]];
    const out = [];
    kmap.forEach(m => { const x = Math.max(a, m.rs), y = Math.min(b, m.re); if (y - x > .01) out.push([clampT(m.s + (x - m.rs) / m.sc), clampT(m.s + (y - m.rs) / m.sc)]); });
    return out.length ? out : [[reelToRaw(a), reelToRaw(b)]];
  }
  const ovStartAt = i => OV[i] ? OV[i].head : null;
  // the overlay that holds reel time t (one track: where two overlap, the later one is on top)
  function ovAt(t) { for (let i = OV.length - 1; i >= 0; i--) { const o = OV[i]; if (t >= o.start - .01 && t < o.start + o.len) return i; } return -1; }
  function paintEye() {
    if (!ovHead) return;
    const b = ovHead.querySelector('button');
    b.innerHTML = EYE + (v2On ? '' : '<path d="M4 4l16 16"/>') + '</svg>';
    b.title = (v2On ? 'Hide' : 'Show') + ' layer 2, the b-roll and title cards over the main video (B)';
    b.setAttribute('aria-pressed', v2On ? 'false' : 'true');
    ovHead.classList.toggle('off', !v2On); ovLane.classList.toggle('off', !v2On);
  }
  function setV2(on) { v2On = !!on; paintEye(); ovSync(); }
  function setOverlays(list) {
    const key = list ? list.map(o => [o.id, o.src, o.start, o.in, o.len, o.thumb].join('|')).join(',') : '';
    if (key !== ovKey) {
      ovKey = key;
      OV.forEach(o => { o.el.pause(); o.el.removeAttribute('src'); try { o.el.load(); } catch (e) {} o.el.remove(); });
      ovShown = -1;
      OV = (list || []).map((d, i) => {
        const el = document.createElement('video');
        el.className = 'st-ovv'; el.muted = el.defaultMuted = true; el.playsInline = true; el.preload = 'auto'; el.setAttribute('aria-hidden', 'true');
        el.src = d.src;
        vbox.insertBefore(el, $('stTag'));   // over both players, under the tag and the pins
        return { i, id: d.id, name: d.name || d.id, src: d.src, start: +d.start || 0, in: +d.in || 0, len: +d.len || 0, thumb: d.thumb || '', el, cued: false, hold: 0, pieces: [] };
      });
      const heads = tlBox.querySelector('.st-heads');
      if (OV.length && !ovHead) {
        ovHead = document.createElement('div'); ovHead.className = 'st-h-v2 st-v2head';
        ovHead.innerHTML = '<span>V2</span><span class="st-lbtns"><button class="st-lb st-eye" id="stV2Eye"></button><kbd>B</kbd></span>';
        heads.insertBefore(ovHead, heads.querySelector('.st-h-v1'));
        ovLane = document.createElement('div'); ovLane.className = 'st-lane st-h-v2 st-v2'; ovLane.id = 'stV2';
        inner.insertBefore(ovLane, V1);
        ovHead.querySelector('button').addEventListener('click', e => { setV2(!v2On); e.currentTarget.blur(); });
        paintEye();
      } else if (!OV.length && ovHead) { ovHead.remove(); ovLane.remove(); ovHead = ovLane = null; }
      document.body.classList.toggle('has-v2', OV.length > 0);
      const hints = panel.querySelector('.hints'); let hint = $('stV2Hint');
      if (OV.length && hints && !hint) { hint = document.createElement('span'); hint.id = 'stV2Hint'; hint.innerHTML = ' · <kbd>B</kbd> show or hide layer 2 (V2: b-roll, title cards)'; hints.appendChild(hint); }
      else if (!OV.length && hint) hint.remove();
      paintTag();
    }
    // another version of the section can sit on the raw footage differently
    OV.forEach(o => { const p = ovPieces(o); o.head = p[0][0]; o.pieces = p.slice().sort((x, y) => x[0] - y[0]); });
  }
  // a block's label: the whole name where it fits, else the name without a kind in front ("B-roll: usage eaten" becomes
  // "usage eaten"), since on narrow blocks every name was cut to the same "B-roll: ..."
  const lc = document.createElement('canvas').getContext('2d');
  function ovLabel(name, room) {
    lc.font = "600 11px Outfit, sans-serif";
    const short = name.replace(/^[^:]{1,16}:\s+/, '');
    return lc.measureText(name).width <= room || short === name ? name : short;
  }
  // one block per overlay, over every piece of it; removed footage inside the block (an overlay that runs across a cut of
  // the edit) is hatched like a gap on V1, and with the cuts hidden it takes no room, so the block is whole
  function paintV2(A, B) {
    let h = '';
    OV.forEach((o, i) => {
      const P = o.pieces; if (!P.length) return;
      const x1 = X(P[0][0]), w = X(P[P.length - 1][1]) - x1;
      if (w < .5 || x1 + w < A || x1 > B) return;
      let gaps = '';
      for (let k = 1; k < P.length; k++) { const g1 = X(P[k - 1][1]) - x1, g2 = X(P[k][0]) - x1; if (g2 - g1 >= 1) gaps += '<i class="st-ovgap" style="left:' + g1 + 'px;width:' + (g2 - g1) + 'px"></i>'; }
      const pic = o.thumb && w >= 6 ? ';background-image:url(&quot;' + esc(o.thumb) + '&quot;)' : '';
      const tip = 'V2 ' + o.name + ' · ' + o.start.toFixed(2) + '-' + (o.start + o.len).toFixed(2) + ' s of the reel. Click to go to its start.';
      h += '<div class="st-ov' + (i === ovShown ? ' on' : '') + '" data-ov="' + i + '" title="' + esc(tip) + '" style="left:' + x1 + 'px;width:' + w + 'px' + pic + '">' + gaps +
        (w >= 40 ? '<span class="st-lbl">' + esc(ovLabel(o.name, w - 16)) + '</span>' : '') + '</div>';
    });
    ovLane.innerHTML = h;
  }
  // every frame while the reel has overlays: which one is on the picture, and each one's frame
  function ovSync() {
    if (!OV.length) return;
    const t = mainV.currentTime || 0, k = v2On && view !== 'raw' ? ovAt(t) : -1;
    const rate = mainV.playbackRate || 1, running = !mainV.paused && !mainV.ended && !mainV.seeking && mainV.readyState >= 3, now = performance.now();
    OV.forEach((o, i) => {
      const el = o.el;
      if (i !== k) {
        if (!el.paused) el.pause();
        if (!o.cued && el.readyState >= 1 && !el.seeking) { el.currentTime = o.in; o.cued = true; }   // waits on its first frame
        return;
      }
      o.cued = false;
      const want = Math.max(0, Math.min((el.duration || 1e9) - .001, o.in + (t - o.start)));
      if (!running) {   // the reel stopped, seeks or scrubs: the same frame, one seek at a time (the next frame asks again)
        if (!el.paused) el.pause();
        if (!el.seeking && el.readyState >= 1 && Math.abs(el.currentTime - want) > .008) el.currentTime = want;
        return;
      }
      if (el.paused) { el.currentTime = want; el.playbackRate = rate; o.hold = now + 300; el.play().catch(() => {}); return; }
      // both play: a big drift (a stall) jumps back into step, a small one is closed by running a touch faster or slower
      const d = el.currentTime - want;
      if (Math.abs(d) > .15 && now > o.hold) { el.currentTime = want; o.hold = now + 300; }
      const r = Math.abs(d) < .03 ? rate : rate * Math.max(.9, Math.min(1.1, 1 - d * 2));
      if (Math.abs(el.playbackRate - r) > .004) el.playbackRate = r;
    });
    const show = k >= 0 && OV[k].el.readyState >= 2 ? k : -1;
    if (show !== ovShown) {
      ovShown = show;
      OV.forEach((o, i) => o.el.classList.toggle('on', i === show));
      if (ovLane) ovLane.querySelectorAll('.st-ov').forEach(b => b.classList.toggle('on', +b.dataset.ov === show));
      paintTag();
    }
  }
  (function ovLoop() { ovSync(); requestAnimationFrame(ovLoop); })();

  // ---------- hooks the editor calls ----------
  // a finished animation has no raw footage: the section is the reel itself (its filmstrip, when the reel carries one)
  function synth(r) { return { id: r.id, synthetic: true, title: r.title, t0: 0, t1: r.duration, keeps: [[0, r.duration]], removed: [], words: r.tokens || [], peaks: r.peaks || [], peaksPerSec: r.peaksPerSec || 100,
    strip: r.strip || null, stripW: r.stripW, stripH: r.stripH, stripCols: r.stripCols, stripT0: r.stripT0, stripSeconds: r.stripSeconds || 0, layers: r.layers || null }; }
  api.has = base => !!SRC[base];
  api.show = r => {
    const D = SRC[r.base || r.id] || synth(r), same = L && L.id === D.id && !D.synthetic;
    R = r; L = D; T0 = D.t0; T1 = D.t1; P0 = D.proxyT0 != null ? D.proxyT0 : D.t0; nowW = -1; park = null; buildAnchors(); buildKmap();
    panel.classList.toggle('synthetic', !!D.synthetic);
    document.body.classList.toggle('no-raw', !!D.synthetic);  // the raw-footage buttons sit in the player bar, outside this panel
    setLayers(layersOf(r)); setOverlays(overlaysOf(r));
    if (same) { rebuild(); return; }  // another version of the same tip: same raw footage, keep the view
    prepSection();
    clips = clipsFor(D); selClip = null; stopAt = null; setMode('edit'); active = 'reel'; lastT = T0; v.pause();
    if (D.synthetic) { v.removeAttribute('src'); try { v.load(); } catch (e) {} img = null; filmSrc = null; if (D.strip) stripFor(D); }
    else { if (v.getAttribute('src') !== D.proxy) v.src = D.proxy; stripFor(D); }
    // opens fitted, but never below 6 px a second: a long recording opens where clips are wide enough to grab and the
    // playhead visibly moves (Fit still shows the whole of it)
    buildClips(); reindex(); pps = Math.max(6, fitPps()); sc.scrollLeft = 0; rebuild();
    if (!D.synthetic) requestAnimationFrame(() => { if (L === D) v.currentTime = clips[0].s - P0; });
  };
  api.setMarkers = list => { markers = list || []; if (L) renderMarkers(); };
  // sound layers: the list for any reel (labels and export), the lanes on screen, the picked lane, and the one Mute button
  api.layersOf = layersOf;
  api.layers = () => LY.map(l => ({ id: l.id, name: l.name, src: l.src, file: l.file, mute: mix[l.id].mute, solo: mix[l.id].solo, audible: audible(l),
    gain: l.gain ? l.gain.gain.value : null, loaded: !!l.buf, playing: !!l.node }));
  api.selectLayer = selectLayer;
  api.selectedLayer = () => layerSel;
  api.setMuted = m => { masterMuted = !!m; if (LY.length) applyMute(); else { mainV.muted = masterMuted; v.muted = masterMuted; } };
  // how loud each layer is right now after its Mute / Solo, and what reaches the speakers after the main Mute (0 = silent)
  api.layerLevels = () => LY.map(l => levelOf(l.meter));
  api.outLevel = () => levelOf(outMeter);
  // layer 2: the list for any reel (labels and export), whether it shows, the one on the picture now (a pin made now is
  // about it), and the one a pin at reel time t would be about while layer 2 shows
  api.overlaysOf = overlaysOf;
  api.v2On = () => v2On;
  api.overlayNow = () => ovShown >= 0 ? { id: OV[ovShown].id, name: OV[ovShown].name } : null;
  api.overlayAt = t => { const k = v2On ? ovAt(t) : -1; return k >= 0 ? { id: OV[k].id, name: OV[k].name } : null; };
  api.follow = who => { active = who; park = null; };   // the page seeked the reel itself: the playhead follows the reel
  api.clearSelection = () => setSel(null);
  api.hasSelection = () => selClip != null && !!L && !L.synthetic;
  api.deleteSelected = () => { if (api.hasSelection()) toggleDelete(selClip); };
  api.togglePlayEdit = togglePlayEdit;
  api.togglePlay = togglePlay;
  // + on the playhead / A: an "add something here" mark at the playhead's raw time; with a sound lane picked, a comment on
  // that layer at the playhead instead
  function addMark() {
    if (L && layerSel && LY.some(l => l.id === layerSel) && api.onLayerMark) { api.onLayerMark(layerSel, toReel(lastT)); return; }
    if (L && !L.synthetic && api.onAddMark) api.onAddMark(lastT, rawToReel(lastT)); else if (L && api.onAddMark) api.onAddMark(lastT, lastT);
  }
  // press the + and drag: the span runs from the playhead to the mouse (the + follows the mouse); let go to make the mark.
  // A plain click is a point at the playhead.
  const addBtn = $('stAdd');
  addBtn.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !L) return;
    e.preventDefault(); e.stopPropagation(); addBtn.setPointerCapture(e.pointerId);
    addDrag = { x0: e.clientX, t0: lastT, a: lastT, b: lastT, moved: false };
  });
  addBtn.addEventListener('pointermove', e => {
    if (!addDrag) return;
    if (!addDrag.moved && Math.abs(e.clientX - addDrag.x0) <= 3) return;
    if (!addDrag.moved && isPlaying()) stopAll();
    addDrag.moved = true; scrubbing = true;
    const t = timeAtX(e); addDrag.a = Math.min(addDrag.t0, t); addDrag.b = Math.max(addDrag.t0, t);
    spanTip(e, addDrag.a, addDrag.b); if (!L.synthetic) queueSeek(t);
    renderMarkers();
  });
  addBtn.addEventListener('pointerup', () => {
    const d = addDrag; addDrag = null; if (!d) return;
    tip.style.display = 'none'; addBtn.blur(); endScrub();
    if (!d.moved) { addMark(); return; }
    renderMarkers();
    if (api.onAddMark) api.onAddMark(d.a, toReel(d.a), d.b);
  });
  addBtn.addEventListener('pointercancel', () => { if (!addDrag) return; addDrag = null; tip.style.display = 'none'; endScrub(); renderMarkers(); });
  addBtn.addEventListener('click', e => { e.stopPropagation(); if (e.detail === 0) addMark(); });   // Enter / Space on the focused +
  api.addMark = addMark;
  // FX/SFX lanes (app/fx-lanes.js) draw on the same raw-time axis as every other lane
  api.X = t => X(t); api.Tx = x => Tx(x); api.win = () => win; api.reel = () => R; api.loaded = () => !!L && !L.synthetic;
  api.words = () => (L && L.words) || []; api.rawToReel = rawToReel; api.reelToRaw = reelToRaw; api.headRaw = () => lastT;
  api.seekRaw = t => { park = null; seekBoth(clampT(t)); }; api.redraw = () => { if (L) statics(); };
  api.stopAll = stopAll;
  api.isPlaying = isPlaying;
  api.planOn = () => plan.on;
  // asked on every frame while a changed edit plays: worked out once per change to the clips
  api.hasChanges = () => {
    if (!L || L.synthetic) return false;
    if (!chCache || chCache.v !== clipsVer || chCache.L !== L) chCache = { v: clipsVer, L, has: changesOf(clips, L, false).length > 0 };
    return chCache.has;
  };
  api.razor = razor;
  api.view = () => view;
  api.rawPlaying = () => !v.paused;
  api.pauseRaw = () => v.pause();
  api.backToReel = () => { plan.on = false; if (!v.paused) v.pause(); active = 'reel'; park = null; };
  api.reelTimeNow = () => rawToReel(lastT);
  api.editClock = () => ({ t: rawToEdit(lastT), len: lenOf(clips), mode });
  api.zoomBy = f => { if (L) setZoom(pps * f); };
  api.toggleCuts = () => setCompact(!compact);
  api.count = base => { const D = SRC[base]; return D ? changesOf(clipsFor(D), D, false).length : 0; };
  api.markdown = base => {
    const D = SRC[base]; if (!D) return null;
    const cl = clipsFor(D), ch = changesOf(cl, D); if (!ch.length) return null;
    const was = D.keeps.reduce((a, [s, e]) => a + e - s, 0), now = lenOf(cl), d = now - was;
    const q = c => (c.words ? '"' + c.words + '"' : 'no words, only the pause') + (c.unchecked ? UNCHECKED : '');
    const lines = ['Source trims (changes made on the raw recording):', 'Raw source: ' + D.source,
      'Edit length: ' + was.toFixed(2) + ' s → ' + now.toFixed(2) + ' s (' + (d >= 0 ? '+' : '') + d.toFixed(2) + ' s)'];
    ch.forEach(c => lines.push(c.add
      ? '- EXTEND, bring back ' + c.d.toFixed(2) + ' s: ' + c.a.toFixed(3) + ' → ' + c.b.toFixed(3) + ' s raw. Restores: ' + q(c)
      : c.whole ? '- DELETE the whole clip ' + c.whole + ': ' + c.a.toFixed(3) + ' → ' + c.b.toFixed(3) + ' s raw (' + c.d.toFixed(2) + ' s). Removes: ' + q(c)
      : '- TRIM, remove ' + c.d.toFixed(2) + ' s: ' + c.a.toFixed(3) + ' → ' + c.b.toFixed(3) + ' s raw. Removes: ' + q(c)));
    lines.push(D.applyHint || 'New kept ranges for this clip (raw seconds; replace the old list, then re-cut):', '```json',
      JSON.stringify(merged(cl.filter(c => !c.del).map(c => [c.s, c.e])).map(([s, e]) => [+s.toFixed(3), +e.toFixed(3)])), '```');
    return { lines, count: ch.length };
  };
  // Export: the footage a render of this section uses as the timeline stands (your trims in, deleted clips out, a clip cut
  // in two joined back up), on the raw clock and in play order (a pickup plays first from later in the raw). null when the
  // reel has no raw footage: a finished animation renders from its own video.
  api.exportOf = base => {
    const D = SRC[base]; if (!D) return null;
    const cl = clipsFor(D), keeps = [];
    cl.filter(c => !c.del).forEach(c => { const p = keeps[keeps.length - 1]; if (p && Math.abs(c.s - p[1]) < 1e-3) p[1] = c.e; else keeps.push([c.s, c.e]); });
    return { source: D.source || null, t0: D.t0, t1: D.t1, keeps: keeps.map(([s, e]) => [+s.toFixed(3), +e.toFixed(3)]),
      autocut: D.keeps, trims: changesOf(cl, D, false).length };
  };
  // the words in raw a..b of a reel's recording (an ADD span in the export); a reel with no raw footage uses its own words
  api.rawWords = (r, a, b) => spanWords(SRC[r.base || r.id] || synth(r), a, b);
  api.rawUnchecked = (r, a, b) => { const D = SRC[r.base || r.id]; return !!D && unchecked(D, a, b); };
  api.UNCHECKED = UNCHECKED;
  api.state = () => saved;
  api.load = obj => {
    saved = obj || {};
    try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) {}
    if (L && !L.synthetic) { clips = clipsFor(L); selClip = null; buildClips(); rebuild(); }
    if (api.onChange) api.onChange();
  };
  api._debug = () => ({ clips, T0, T1, P0, pps, compact, video: v, anchors, kmap, active, reelToRaw, rawToReel, X, reelAt, buildPlan, plan, view, markers, spanWords: (a, b) => spanWords(L, a, b),
    win, drawnClips: clipEls.size,
    overlays: () => OV.map((o, i) => ({ id: o.id, name: o.name, start: o.start, in: o.in, len: o.len, pieces: o.pieces, shown: i === ovShown, ready: o.el.readyState, at: o.el.currentTime, paused: o.el.paused, rate: o.el.playbackRate })),
    layerSync: () => ({ on: sync.on, rate: sync.rate, drift: sync.on && ac ? expected() - mainV.currentTime : null, ctx: ac ? ac.state : null, master: master ? master.gain.value : null,
      nodes: LY.map(l => l.node ? l.node.playbackRate.value : null), videoMuted: mainV.muted }) });
  api._playEdit = playEdit;
})();
