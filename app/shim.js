// Claude Video Editor: loaded first in every editor page. The editor keeps its work in the browser's localStorage; this
// copies the project's saved work from disk into localStorage before the editor reads it, then sends every change back to
// the server, which writes it to projects/<project>/rubric-state.json. A change the server hasn't confirmed stays in a
// pending list in this browser, so a moment offline loses nothing.
(function () {
  var C = window.__RUBRIC_APP; if (!C || !C.project) return;
  var ls = window.localStorage, P = C.prefixes || [], PEND = '__rubric_pending:' + C.project;
  var set0 = Storage.prototype.setItem, rem0 = Storage.prototype.removeItem;
  var mine = function (k) { return P.some(function (p) { return k === p || k.indexOf(p + ':') === 0; }); };
  var pending = {}; try { pending = JSON.parse(ls.getItem(PEND) || '{}') || {}; } catch (e) { pending = {}; }
  var savePend = function () { try { set0.call(ls, PEND, JSON.stringify(pending)); } catch (e) {} };

  // 1. The disk wins, except for changes this browser made that never reached the server.
  var disk = C.keys || {};
  Object.keys(disk).forEach(function (k) { if (!(k in pending)) { try { set0.call(ls, k, disk[k]); } catch (e) {} } });
  // 2. Anything else under this project's keys in this browser is not on disk, so it goes: the page shows what is saved.
  var stale = [];
  for (var i = 0; i < ls.length; i++) { var k = ls.key(i); if (mine(k) && !(k in disk) && !(k in pending)) stale.push(k); }
  stale.forEach(function (k) { rem0.call(ls, k); });
  // 3. Unsent changes are this project's newest values; put them back.
  Object.keys(pending).forEach(function (k) { try { if (pending[k] === null) rem0.call(ls, k); else set0.call(ls, k, pending[k]); } catch (e) {} });
  savePend();

  var url = '/api/state/' + encodeURIComponent(C.project), timer = null, busy = false, banner = null;
  var headers = { 'Content-Type': 'application/json' };
  if (C.token) headers['x-rubric-token'] = C.token;
  function showOffline(on, why) {
    if (on && !banner && document.body) {
      banner = document.createElement('div');
      banner.textContent = why || "Can't reach the Claude Video Editor server. Your changes are kept in this browser and save when it's back.";
      banner.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;background:#b3261e;color:#fff;font:500 13px/1.4 Outfit,system-ui,sans-serif;padding:8px 12px;border-radius:6px;max-width:420px';
      document.body.appendChild(banner);
    } else if (!on && banner) { banner.remove(); banner = null; }
  }
  function payload() {
    var set = {}, del = [];
    Object.keys(pending).forEach(function (k) { if (pending[k] === null) del.push(k); else set[k] = pending[k]; });
    return { set: set, del: del };
  }
  function flush() {
    if (busy || !Object.keys(pending).length) return;
    busy = true; var sent = JSON.parse(JSON.stringify(pending));
    fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(payload()) })
      .then(function (r) {
        if (r.status === 401) throw new Error('token');
        if (r.status === 413) throw new Error('size');
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then(function () {
        Object.keys(sent).forEach(function (k) { if (pending[k] === sent[k]) delete pending[k]; });
        savePend(); busy = false; showOffline(false);
        if (Object.keys(pending).length) schedule();
      })
      .catch(function (e) {
        busy = false;
        showOffline(true, e && e.message === 'token' ? 'The server refused the save: RUBRIC_TOKEN changed. Reload the page.'
          : e && e.message === 'size' ? "This project's saved work is over the 1 MB save limit. Your changes are kept in this browser." : null);
        clearTimeout(timer); timer = setTimeout(flush, 4000);
      });
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(flush, 400); }

  Storage.prototype.setItem = function (k, v) {
    set0.call(this, k, v);
    if (this === ls && mine(k)) { pending[k] = String(v); savePend(); schedule(); }
  };
  Storage.prototype.removeItem = function (k) {
    rem0.call(this, k);
    if (this === ls && mine(k)) { pending[k] = null; savePend(); schedule(); }
  };
  // Leaving the page: send whatever is still waiting. If it doesn't make it, it stays pending and goes on the next visit.
  addEventListener('pagehide', function () {
    if (!Object.keys(pending).length) return;
    try { fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(payload()), keepalive: true }).catch(function () {}); } catch (e) {}
  });
  if (Object.keys(pending).length) setTimeout(flush, 800);
})();

// Paste fix (Dylan, 2026-10-19): Wispr Flow dictation pastes via Cmd+V and then restores the clipboard. Chrome reads the
// clipboard twice (once for the paste event, again to insert), and from the second paste on its second read came back
// empty, so nothing landed (recorded with ?debugkeys: paste event had the text, beforeinput had none, no input event).
// Insert the text the paste event carries ourselves, through the browser's own editing command, so undo and the page's
// input handlers work exactly as for typing. Plain text only, and only in text boxes.
(function () {
  document.addEventListener('paste', function (e) {
    var el = e.target, tag = (el && el.tagName || '').toLowerCase();
    var box = tag === 'textarea' || (tag === 'input' && /^(text|search|url|email|number|tel|)$/.test(el.type || '')) || (el && el.isContentEditable);
    if (!box || e.defaultPrevented || !e.clipboardData) return;
    var text = e.clipboardData.getData('text/plain');
    if (!text) return;   // nothing we can insert: leave it to the browser
    e.preventDefault();
    if (!document.execCommand('insertText', false, text)) {   // fallback where execCommand is unavailable
      var a = el.selectionStart, b = el.selectionEnd;
      if (typeof a === 'number') { el.setRangeText(text, a, b, 'end'); el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text })); }
    }
  }, true);
})();
