// -------------------------------------------------------------
// Extra features, layered on top of script.js (loaded after it):
//  - changes since your last import (+ a toast after importing)
//  - how long ago you followed each account, and sort by it
//  - list 3 views: changes, stats with a trend, mutuals, fans, compare,
//  - export (CSV)
//  - undo after unfollowing / starring / removing
//  - select several rows and act on them at once
//  - daily unfollow counter with a warning
//  - re-import reminder, installable app (manifest + service worker)
// Everything reuses the app's own styles and motion: list 3's row slides,
// the popup window style, the instructions tab highlight, list 3 easing.
// -------------------------------------------------------------
(() => {
  const EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
  // One motion for everything inside list 3's tabs, matched to the tab
  // highlight's glide (520ms): what leaves eases out in 200ms, what arrives
  // glides in over 320ms on the highlight's curve, so it lands with it.
  const GLIDE = 'cubic-bezier(0.32, 0.72, 0, 1)';
  // Content changing inside a view (an account picked, files imported):
  // the instructions window's own motion — out like it closes, in like it
  // opens: an even 0.45s, fading while sinking 14px and easing to 95%.
  const MODAL_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
  const MODAL_OUT = [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(14px) scale(0.95)' }];
  const MODAL_IN = [{ opacity: 0, transform: 'translateY(14px) scale(0.95)' }, { opacity: 1, transform: 'none' }];
  const LEAVE = { duration: 450, easing: MODAL_EASE, fill: 'forwards' };
  const ARRIVE = { duration: 320, easing: GLIDE };
  const SLIDE_X = 24; // tab switches slide sideways
  // Switching tabs: a push, like iOS navigation — the view you leave slides
  // fully out one side while the new one slides in from the other, edge to
  // edge, with a soft fade. The same motion as every tab switcher in the
  // app (script.js: TAB_MOTION, tabSlideOut/In).
  const SWITCH_OUT = { ...TAB_MOTION.in, fill: 'forwards' };
  const slideOut = (el, dx) => tabSlideOut(el, dx);
  const slideIn = (el, dx) => tabSlideIn(el, dx);
  const boxWidth = () => (altView && altView.parentNode ? altView.parentNode.clientWidth : 320);
  const SLIDE_Y = 12; // data changes lift away and settle
  const DAY = 24 * 60 * 60 * 1000;

  // Everything here hooks into the app's own updates (loading your data at
  // log in among them). A mistake in one of these extras must never stop
  // that: it's caught and logged, and the app carries on without it.
  function safe(fn, what) {
    try { return fn(); } catch (err) { console.error(`[features] ${what || 'extra'} failed:`, err); return undefined; }
  }

  const accKey = () => (state.selectedAccountUsername ? state.selectedAccountUsername.toLowerCase() : '_global_');
  const readJSON = (key, fallback) => { try { const v = JSON.parse(storageGet(key) || 'null'); return v == null ? fallback : v; } catch (e) { return fallback; } };
  const writeJSON = (key, value) => storageSet(key, JSON.stringify(value));
  const esc = (v) => escapeHtml(v);
  const byName = (list) => new Map((list || []).map(u => [u.username, u]));
  const animateIn = (el, from = 'translateY(6px)') => {
    if (el && typeof el.animate === 'function') {
      el.animate([{ opacity: 0, transform: from }, { opacity: 1, transform: 'none' }], { duration: 380, easing: EASE });
    }
  };

  let sortMode = 'default'; // 'default' | 'oldest' | 'newest'
  try { sortMode = localStorage.getItem('list3_sort') || 'default'; } catch (e) {}

  const timeOf = (u) => {
    if (!u || !u.timestamp) return null;
    const t = new Date(u.timestamp).getTime();
    return Number.isFinite(t) ? t : null;
  };

  // ---------- list 3: sorting ----------
  // Every path that changes list 3 ends in updateResultsUI, so the sort is
  // applied right there.
  const baseUpdateResultsUI = updateResultsUI;
  updateResultsUI = function (opts) {
    safe(() => {
    let list = state.unfollowers;
    if (sortMode !== 'default') {
      const dir = sortMode === 'oldest' ? 1 : -1;
      list = list.map((u, i) => [u, i]).sort((a, b) => {
        const ta = timeOf(a[0]), tb = timeOf(b[0]);
        if (ta === null && tb === null) return a[1] - b[1];
        if (ta === null) return 1;
        if (tb === null) return -1;
        return (ta - tb) * dir || a[1] - b[1];
      }).map(x => x[0]);
    }
    state.unfollowers = list;
    }, 'sort');
    safe(refreshUndo, 'undo'); // the steps belong to the account on screen
    safe(refreshSavedImports, 'saved imports');
    // The toolbar first: its reminder pill showing or hiding moves list 3's
    // box, and doing that after the rows were placed left one unanimated.
    safe(refreshToolbar, 'toolbar');
    const result = baseUpdateResultsUI.call(this, opts);
    safe(keepSelection, 'selection');
    safe(refreshToolbar, 'toolbar');
    safe(refreshView, 'view');
    safe(() => renderExtras(true), 'extra lists'); // an account picked: its lists
    centerSoon();
    return result;
  };

  // ---------- toast (undo, messages) ----------
  let toastEl = null;
  let toastTimer = null;
  function showToast(message, action, onAction, { tone = '', duration = 5000 } = {}) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'feature-toast';
      document.body.appendChild(toastEl);
    }
    clearTimeout(toastTimer);
    toastEl.className = `feature-toast ${tone}${action ? '' : ' no-action'}`;
    toastEl.innerHTML = `<span class="feature-toast-text">${esc(message)}</span>${action ? `<button class="feature-toast-btn">${esc(action)}</button>` : ''}`;
    if (action) {
      toastEl.querySelector('.feature-toast-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        hideToast();
        onAction();
      }, { once: true });
    }
    void toastEl.offsetWidth;
    toastEl.classList.add('show');
    toastTimer = setTimeout(hideToast, duration);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    if (toastEl) toastEl.classList.remove('show');
  }

  // ---------- undo ----------
  // A snapshot of the lists from just before an action; undo puts them
  // back and list 3 / the submenus animate the change back like any other.
  function snapshot() {
    return {
      acc: accKey(),
      following: state.following.slice(),
      unfollowed: state.unfollowed.slice(),
      starred: state.starred.slice()
    };
  }
  function restore(snap) {
    if (snap.acc !== accKey()) return;
    if (snap.cleared) { restoreClearedList(snap); return; }
    if (snap.pending) {
      const lists = readExtraLists(state.selectedAccountUsername);
      lists.pending = snap.pending;
      writeExtraLists(state.selectedAccountUsername, lists);
      safe(() => renderExtras(true), 'extra lists');
    }
    state.following = snap.following;
    state.unfollowed = snap.unfollowed;
    state.starred = snap.starred;
    elements.inputFollowing.value = state.following.map(u => `@${u.originalUsername}`).join('\n');
    updateListUI('following');
    saveCurrentAccountData();
    calculateUnfollowers({ animate: true });
    updateUnfollowedUI();
    updateStarredUI();
  }
  // The undo button (right of list 3's info button) lights up once the
  // action's slide has finished (its completion updates the lists) and
  // undoes the latest action.
  // A stack: each tap undoes one more action, back until there's none left
  // (up to 50, for the account on screen).
  const undoStack = [];
  let undoBtn = null;
  const undoable = () => undoStack.filter(x => x.snap.acc === accKey());
  function refreshUndo() {
    const list = undoable();
    setUndoReady(list.length > 0);
    if (undoBtn && list.length) undoBtn.title = `undo: ${list[list.length - 1].message}${list.length > 1 ? ` (${list.length} steps to undo)` : ''}`;
  }
  function offerUndo(snap, message) {
    setTimeout(() => {
      undoStack.push({ snap, message });
      if (undoStack.length > 50) undoStack.shift();
      refreshUndo();
    }, ROW_MOTION_MS + 60);
  }
  function setUndoReady(ready) {
    if (!undoBtn) return;
    const was = undoBtn.classList.contains('ready');
    undoBtn.classList.toggle('ready', ready);
    undoBtn.setAttribute('aria-disabled', ready ? 'false' : 'true');
    if (!ready) undoBtn.title = 'nothing to undo';
    if (ready && !was && typeof undoBtn.animate === 'function') {
      undoBtn.animate([{ scale: 0.85 }, { scale: 1 }], { duration: 380, easing: EASE });
    }
  }
  // An open unfollowed/starred submenu closes first (its usual close
  // animation), and the undo plays out once it's gone. Undos tapped while
  // it's closing wait their turn, in order.
  let undoQueue = null;
  function afterSubmenusClose(fn) {
    if (undoQueue) { undoQueue.push(fn); return; }
    const open = [['list-unfollowed', 'toggle-preview-unfollowed'], ['list-starred', 'toggle-preview-starred']]
      .map(([list, toggle]) => [document.getElementById(list), document.getElementById(toggle)])
      .filter(([list]) => list && list.classList.contains('show'));
    if (!open.length) { fn(); return; }
    undoQueue = [fn];
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      const queued = undoQueue;
      undoQueue = null;
      queued.forEach(f => f());
    };
    open.forEach(([list, toggle]) => {
      list.addEventListener('transitionend', function onEnd(ev) {
        if (ev.target !== list || ev.propertyName !== 'opacity') return;
        list.removeEventListener('transitionend', onEnd);
        run();
      });
      list.classList.remove('show');
      if (toggle) toggle.classList.remove('active');
    });
    setTimeout(run, 700); // no transitionend (reduced motion, hidden tab)
  }

  function buildUndoButton() {
    const info = document.getElementById('btn-instructions-info');
    if (!info || document.getElementById('btn-undo')) return;
    undoBtn = info.cloneNode(false);
    undoBtn.id = 'btn-undo';
    undoBtn.classList.add('undo-btn');
    undoBtn.setAttribute('aria-label', 'undo');
    undoBtn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"></path><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"></path></svg>';
    info.parentNode.insertBefore(undoBtn, info.nextSibling);
    undoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      for (let i = undoStack.length - 1; i >= 0; i--) {
        if (undoStack[i].snap.acc !== accKey()) continue;
        const [{ snap }] = undoStack.splice(i, 1);
        afterSubmenusClose(() => restore(snap));
        break;
      }
      refreshUndo();
    });
    setUndoReady(false);
  }

  const ACTIONS = [
    ['#list-unfollowers .action-star', 'starred'],
    ['#list-unfollowers .action-delete', 'unfollowed'],
    ['#list-unfollowers .action-dismiss', 'removed from list 3'],
    ['#list-unfollowed .star-unfollowed-btn', 'moved to starred'],
    ['#list-unfollowed .remove-unfollowed-btn', 'moved back to list 3'],
    ['#list-starred .unstar-btn', 'unstarred'],
    ['#list-starred .unfollow-starred-btn', 'moved to unfollowed'],
    ['#list-starred .remove-unfollowed-btn', 'moved back to list 3'],
  ];
  document.addEventListener('click', (e) => {
    if (selectMode || e.target.closest('.row-select-bar')) return;
    for (const [sel, verb] of ACTIONS) {
      const btn = e.target.closest(sel);
      if (btn) {
        // The row, not the button (submenu buttons carry the username too).
        const row = btn.closest('.user-row, .parsed-item') || btn.closest('[data-username]');
        if (row && row.classList.contains('username-exit')) return;
        const name = row ? row.querySelector('.user-link, .parsed-username') : null;
        offerUndo(snapshot(), `${name ? name.textContent.trim() : 'account'} ${verb}`);
        return;
      }
    }
    // A plain tap on a list 3 row opens the profile and unfollows it.
    const row = e.target.closest('#list-unfollowers .user-row');
    if (row && !row.classList.contains('username-exit') && !e.target.closest('.action-arrow, .user-row-actions')) {
      const name = row.querySelector('.user-link');
      offerUndo(snapshot(), `${name ? name.textContent.trim() : 'account'} unfollowed`);
    }
  }, true);

  // Clearing list 1 or 2 can be undone too: the list's text comes back
  // exactly as it was (the undo button, or the toast's undo).
  function restoreClearedList(snap) {
    const kind = snap.cleared;
    const ta = kind === 'following' ? elements.inputFollowing : elements.inputFollowers;
    state[kind] = snap.list;
    ta.value = snap.text;
    updateListUI(kind);
    saveCurrentAccountData();
    calculateUnfollowers({ animate: true });
  }
  [['following', 'clear-following', 'list 1'], ['followers', 'clear-followers', 'list 2']].forEach(([kind, id, label]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const ta = kind === 'following' ? elements.inputFollowing : elements.inputFollowers;
      if (!ta || ta.value.trim() === '') return;
      const entry = { snap: { acc: accKey(), cleared: kind, list: state[kind].slice(), text: ta.value }, message: `${label} cleared` };
      // After the text has faded out (smoothClearTextarea, 280ms).
      setTimeout(() => {
        undoStack.push(entry);
        if (undoStack.length > 50) undoStack.shift();
        refreshUndo();
        showToast(`${label} cleared`, 'undo', () => {
          const i = undoStack.indexOf(entry);
          if (i < 0) return; // already undone with the undo button
          undoStack.splice(i, 1);
          refreshUndo();
          afterSubmenusClose(() => restore(entry.snap));
        });
      }, 320);
    }, true);
  });

  // ---------- import history & changes ----------
  // At the end of every import (recordImportDate), compare the new lists
  // with the previous import's and keep the result.
  const baseRecordImportDate = recordImportDate;
  recordImportDate = function (accountUsername) {
    const result = baseRecordImportDate.call(this, accountUsername);
    safe(() => recordChanges(accountUsername), 'import history');
    return result;
  };
  function recordChanges(accountUsername) {
    const key = accountUsername ? accountUsername.toLowerCase() : '_global_';
    if (key === DEMO_ID) return;
    const history = readJSON(`import_history_${key}`, []);
    const prev = history[history.length - 1];
    const following = state.following.map(u => u.username);
    const followers = state.followers.map(u => u.username);
    const unfollowers = state.unfollowers.length;
    let diff = null;
    if (prev && prev.followingList) {
      const pf = new Set(prev.followingList), pr = new Set(prev.followersList);
      const nf = new Set(following), nr = new Set(followers);
      diff = {
        date: Date.now(),
        since: prev.date,
        lostFollowers: prev.followersList.filter(n => !nr.has(n)),
        newFollowers: followers.filter(n => !pr.has(n)),
        stoppedFollowing: prev.followingList.filter(n => !nf.has(n)),
        startedFollowing: following.filter(n => !pf.has(n))
      };
      writeJSON(`import_diff_${key}`, diff);
      const total = diff.lostFollowers.length + diff.newFollowers.length + diff.stoppedFollowing.length + diff.startedFollowing.length;
      setTimeout(() => showToast(total ? `${total} change${total === 1 ? '' : 's'} since your last import` : 'no changes since your last import',
        total ? 'view' : null, () => { showView('changes'); viewNav && viewNav.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }), 900);
    }
    // Full lists only for the latest import (for the next comparison);
    // counts for the trend.
    history.forEach(h => { delete h.followingList; delete h.followersList; });
    history.push({ date: Date.now(), following: following.length, followers: followers.length, unfollowers, followingList: following, followersList: followers });
    writeJSON(`import_history_${key}`, history.slice(-24));
    safe(() => saveImport(key, diff).catch(err => console.error('[features] saved imports failed:', err)), 'saved imports');
  }

  // ---------- saved imports ----------
  // Every import is logged with what changed since the one before. The
  // uploaded files themselves are kept (on this device, in IndexedDB — far
  // too big for the 5 mb cloud) for the first import, every 5th import and
  // the latest one; an import in between keeps only its changes once a
  // newer one comes in. Settings shows how close the next full save is,
  // and tapping it lists every import to download: the files as a zip, or
  // just the changes as a spreadsheet.
  const FULL_EVERY = 5;
  const logKey = (key) => `import_log_${key}`;
  const fileKey = (key, n) => `${key}|${n}`;
  let dbPromise = null;
  function filesDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('no IndexedDB')); return; }
        const req = indexedDB.open('ig-checker-files', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('imports');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  }
  async function dbDo(mode, fn) {
    const db = await filesDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('imports', mode);
      const req = fn(tx.objectStore('imports'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  const isFullSave = (n) => n === 1 || n % FULL_EVERY === 0;
  async function saveImport(key, diff) {
    const log = readJSON(logKey(key), []);
    const prev = log[log.length - 1];
    const n = (prev ? prev.n : 0) + 1;
    const entry = {
      n, date: Date.now(), full: isFullSave(n), files: false,
      following: state.following.length, followers: state.followers.length,
      changes: diff ? { lost: diff.lostFollowers, gained: diff.newFollowers, stopped: diff.stoppedFollowing, started: diff.startedFollowing } : null
    };
    log.push(entry);
    writeJSON(logKey(key), log);
    refreshSavedImports();
    const files = (typeof lastImportFiles !== 'undefined' ? lastImportFiles : []) || [];
    if (!files.length) return;
    const stored = await Promise.all(files.map(async file => ({ name: file.webkitRelativePath || file.name, type: file.type || '', data: await file.arrayBuffer() })));
    await dbDo('readwrite', store => store.put({ files: stored }, fileKey(key, n)));
    const fresh = readJSON(logKey(key), []);
    const mine = fresh.find(x => x.n === n);
    if (mine) mine.files = true;
    // The import before this one is no longer the latest: unless it was a
    // full save, it keeps just its changes.
    const before = fresh.find(x => x.n === n - 1);
    if (before && before.files && !before.full) {
      await dbDo('readwrite', store => store.delete(fileKey(key, before.n)));
      before.files = false;
    }
    writeJSON(logKey(key), fresh);
    refreshSavedImports();
  }
  function refreshSavedImports() {
    const box = document.getElementById('saved-imports-box');
    if (!box) return;
    const key = accKey();
    const log = key === DEMO_ID ? [] : readJSON(logKey(key), []);
    const set = (id, text) => { const el = document.getElementById(id); if (el && el.textContent !== text) el.textContent = text; };
    const fill = document.getElementById('saved-imports-fill');
    if (!log.length) {
      set('saved-imports-value', 'not started');
      set('saved-imports-detail', 'import your files to start saving them');
      set('saved-imports-count', '');
      if (fill) fill.style.width = '0%';
      box.classList.add('empty');
      return;
    }
    box.classList.remove('empty');
    const n = log[log.length - 1].n;
    const step = n % FULL_EVERY || FULL_EVERY; // 1..5 into this round
    const left = FULL_EVERY - step;
    set('saved-imports-value', `${step}/${FULL_EVERY}`);
    set('saved-imports-detail', left ? `full save in ${plural(left, 'import')}` : 'full save done');
    set('saved-imports-count', `${plural(log.length, 'import')} saved`);
    if (fill) fill.style.width = `${(step / FULL_EVERY) * 100}%`;
  }

  // A plain zip (stored, not compressed) of the saved files.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
    return t;
  })();
  const crc32 = (bytes) => { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function makeZip(files, when) {
    const enc = new TextEncoder();
    const d = new Date(when);
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const parts = [], central = [];
    let offset = 0;
    const used = new Set();
    files.forEach(file => {
      let name = file.name;
      for (let i = 2; used.has(name); i++) name = file.name.replace(/(\.[^.]*)?$/, `_${i}$1`);
      used.add(name);
      const nameBytes = enc.encode(name);
      const data = new Uint8Array(file.data);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true); local.setUint16(10, time, true); local.setUint16(12, date, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
      parts.push(local.buffer, nameBytes, data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true); cen.setUint16(12, time, true); cen.setUint16(14, date, true);
      cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true);
      cen.setUint16(28, nameBytes.length, true); cen.setUint32(42, offset, true);
      central.push(cen.buffer, nameBytes);
      offset += 30 + nameBytes.length + data.length;
    });
    const size = central.reduce((s, p) => s + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, size, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }
  const fileDate = (t) => new Date(t).toISOString().slice(0, 10);
  const longDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  async function downloadSaved(key, entry) {
    const who = key === '_global_' ? 'lists' : key;
    if (entry.files) {
      const rec = await dbDo('readonly', store => store.get(fileKey(key, entry.n)));
      if (rec && rec.files && rec.files.length) {
        saveFile(`ig-checker-${who}-import-${entry.n}-${fileDate(entry.date)}.zip`, makeZip(rec.files, entry.date));
        return;
      }
    }
    // Just the changes: one row per username, with what happened.
    const c = entry.changes || {};
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['change', 'username']];
    [['lost', 'unfollowed you'], ['gained', 'new follower'], ['stopped', 'you stopped following'], ['started', 'you started following']]
      .forEach(([k, label]) => (c[k] || []).forEach(name => rows.push([label, name])));
    saveFile(`ig-checker-${who}-import-${entry.n}-changes-${fileDate(entry.date)}.csv`, new Blob([rows.map(r => r.map(cell).join(',')).join('\n')], { type: 'text/csv' }));
  }
  let savedOverlay = null;
  function openSavedImports() {
    const key = accKey();
    const log = key === DEMO_ID ? [] : readJSON(logKey(key), []);
    if (!savedOverlay) {
      savedOverlay = document.createElement('div');
      savedOverlay.className = 'modal-overlay hidden export-overlay saved-imports-overlay';
      savedOverlay.innerHTML = `
        <div class="account-modal-card glass export-card">
          <div class="account-modal-header"><h3>saved imports</h3></div>
          <div class="insights-sub">full saves download the files you uploaded as a zip; the imports in between download just what changed</div>
          <div class="export-options saved-imports-list"></div>
          <div class="account-modal-actions">
            <button class="btn btn-secondary" data-saved="close">close</button>
          </div>
        </div>`;
      document.body.appendChild(savedOverlay);
      savedOverlay.addEventListener('click', (e) => {
        if (e.target === savedOverlay || e.target.closest('[data-saved="close"]')) { closeSavedImports(); return; }
        const row = e.target.closest('[data-import]');
        if (!row) return;
        const entry = readJSON(logKey(accKey()), []).find(x => String(x.n) === row.dataset.import);
        if (entry) downloadSaved(accKey(), entry).catch(err => { console.error('[features] download failed:', err); showSiteAlert("couldn't download", "that import's files aren't on this device."); });
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && savedOverlay && !savedOverlay.classList.contains('hidden')) closeSavedImports(); });
    }
    const listEl = savedOverlay.querySelector('.saved-imports-list');
    listEl.innerHTML = log.length ? log.slice().reverse().map(entry => {
      const c = entry.changes;
      const count = c ? c.lost.length + c.gained.length + c.stopped.length + c.started.length : 0;
      const kind = entry.files ? 'full folder · zip' : (c ? `${plural(count, 'change')} · csv` : 'no changes saved');
      return `<button class="export-option saved-import" data-import="${entry.n}"${!entry.files && !c ? ' disabled' : ''}>
          <span class="export-label">import ${entry.n}<span class="saved-import-date">${esc(longDate(entry.date))}</span></span>
          <span class="export-count">${esc(kind)}</span>
        </button>`;
    }).join('') : '<div class="dropdown-empty-message">no imports saved yet</div>';
    showModalOverlay(savedOverlay);
    lockPageScroll();
  }
  function closeSavedImports() {
    savedOverlay.classList.remove('show');
    unlockPageScroll();
    scheduleOverlayHide(savedOverlay, () => savedOverlay.classList.add('hidden'));
  }
  function setupSavedImports() {
    const box = document.getElementById('saved-imports-box');
    if (!box) return;
    box.addEventListener('click', (e) => { e.stopPropagation(); openSavedImports(); });
    refreshSavedImports();
  }

  // ---------- list 3 toolbar: sort, select, today's count, reminder ----------
  let toolbar = null;
  function buildToolbar() {
    const wrapper = document.querySelector('#card-unfollowers .results-layout-wrapper');
    if (!wrapper || toolbar) return;
    toolbar = document.createElement('div');
    toolbar.className = 'list-toolbar';
    // Sort and select share one row; the re-import reminder, when it
    // shows, sits on its own line under them.
    toolbar.innerHTML = `
      <div class="toolbar-row">
      <button class="toolbar-pill" data-act="sort" title="sort list 3">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/></svg>
        <span class="sort-window"><span class="toolbar-pill-text sort-current"></span><span class="toolbar-pill-text sort-probe" aria-hidden="true"></span></span>
      </button>
      <button class="toolbar-pill" data-act="select" title="select several accounts">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        <span class="toolbar-pill-text">select</span>
      </button>
      </div>
      <button class="toolbar-pill toolbar-reminder" data-act="reminder" title="import your files again"></button>`;
    wrapper.parentNode.insertBefore(toolbar, wrapper);
    toolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'sort') {
        sortMode = sortMode === 'default' ? 'oldest' : sortMode === 'oldest' ? 'newest' : 'default';
        try { localStorage.setItem('list3_sort', sortMode); } catch (err) {}
        // List 3 first (its rows slide to the new order), then the label —
        // on the next frame, once that work is done, so neither stutters.
        calculateUnfollowers({ animate: true });
        requestAnimationFrame(() => slideSortLabel(btn));
      } else if (act === 'select') {
        setSelectMode(!selectMode);
      } else if (act === 'reminder') {
        if (elements.btnAddAccount && !elements.btnAddAccount.disabled) elements.btnAddAccount.click();
      }
    });
    refreshToolbar();
  }

  const SORT_LABELS = { default: 'sort', oldest: 'oldest first', newest: 'newest first' };
  // The pill resizes to its label smoothly (the label window's width
  // transitions, style.css) while the old label slides out left and the
  // new one slides in from the right. The window only ever holds one label
  // in flow (the old one is laid over it), and the label text is only ever
  // changed here — refreshToolbar used to rewrite it too, which could swap
  // it a frame early and flicker.
  function textWidth(win, label) {
    const probe = win.querySelector('.sort-probe');
    probe.textContent = label;
    return Math.ceil(probe.offsetWidth);
  }
  function slideSortLabel(btn) {
    const win = btn.querySelector('.sort-window');
    const text = win.querySelector('.sort-current');
    const label = SORT_LABELS[sortMode];
    if (text.textContent === label) return;
    win.querySelectorAll('.toolbar-pill-text-old').forEach(el => el.remove());
    win.style.width = `${win.offsetWidth}px`; // from exactly where it is now
    void win.offsetWidth;
    const old = text.cloneNode(true);
    old.classList.remove('sort-current');
    old.classList.add('toolbar-pill-text-old');
    win.appendChild(old);
    text.textContent = label;
    const target = textWidth(win, label);
    win.style.width = `${target}px`;
    // Back to its natural width once the resize has played (a width fixed
    // from a measurement taken before layout was 0 — just the icon showed).
    clearTimeout(win._widthTimer);
    win._widthTimer = setTimeout(() => { win.style.width = ''; }, 360);
    if (typeof text.animate !== 'function') { old.remove(); return; }
    const timing = { duration: 320, easing: EASE };
    old.animate([{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(-16px)' }], { ...timing, fill: 'forwards' })
      .finished.then(() => old.remove(), () => old.remove());
    text.animate([{ opacity: 0, transform: 'translateX(16px)' }, { opacity: 1, transform: 'translateX(0)' }], timing);
  }

  function refreshToolbar() {
    if (!toolbar) return;
    const win = toolbar.querySelector('.sort-window');
    const sortText = win.querySelector('.sort-current');
    if (!sortText.textContent) sortText.textContent = SORT_LABELS[sortMode]; // first time only; changes slide (slideSortLabel)
    toolbar.querySelector('[data-act="sort"]').classList.toggle('on', sortMode !== 'default');
    // Sort and select only work on the results view.
    const hasRows = state.unfollowers.length > 0 && currentView === 'results' && subTab.results === 'unfollowers';
    const pendingNow = extraListsNow().pending;
    const hasPending = currentView === 'results' && subTab.results === 'pending' && Array.isArray(pendingNow) && pendingNow.length > 0;
    toolbar.querySelector('[data-act="sort"]').disabled = !hasRows;
    toolbar.querySelector('[data-act="select"]').disabled = !hasRows && !hasPending && !selectMode;
    toolbar.querySelector('[data-act="select"]').classList.toggle('on', selectMode);

    const importedAt = +(storageGet(`import_date_${accKey()}`) || 0);
    const due = importedAt && Date.now() - importedAt > 7 * DAY && accKey() !== DEMO_ID;
    setPill(toolbar.querySelector('[data-act="reminder"]'), !!due, due ? `imported ${plural(Math.floor((Date.now() - importedAt) / DAY), 'day')} ago · import again` : '');
  }
  // Shows/hides a pill with the chips' fade (in) / a quick fade (out).
  function setPill(el, show, text) {
    if (show && el.textContent !== text) el.textContent = text;
    const shown = !el.classList.contains('pill-hidden');
    if (show === shown) return;
    el.classList.toggle('pill-hidden', !show);
    // Comes in like the pop-ups do.
    if (show && typeof el.animate === 'function') el.animate(MODAL_IN, { duration: 450, easing: MODAL_EASE });
  }

  // ---------- select several rows ----------
  let selectMode = false;
  let selectBar = null;
  const selected = new Set();
  // What select works on: list 3, or the pending requests tab.
  const selectOnPending = () => subTab.results === 'pending';
  const selectHosts = () => [elements.listUnfollowers, extraPanes.pending].filter(Boolean);
  function setSelectMode(on) {
    selectMode = on;
    selected.clear();
    selectHosts().forEach(h => {
      h.classList.toggle('select-mode', on && (h === elements.listUnfollowers ? !selectOnPending() : selectOnPending()));
      h.querySelectorAll('.multi-selected').forEach(r => r.classList.remove('multi-selected'));
    });
    if (!selectBar) {
      selectBar = document.createElement('div');
      selectBar.className = 'row-select-bar';
      selectBar.innerHTML = `
        <span class="row-select-count">0 selected</span>
        <button data-bulk="star">star</button>
        <button data-bulk="unfollow">unfollow</button>
        <button data-bulk="cancel" class="muted">cancel</button>`;
      document.body.appendChild(selectBar);
      selectBar.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-bulk]');
        if (!btn) return;
        e.stopPropagation();
        bulkAction(btn.dataset.bulk);
      });
    }
    // On desktop the bar floats over lists 1 and 2, which blur out behind
    // it while selecting (on phones they're further down: it stays at the
    // bottom of the screen).
    placeSelectBar();
    document.body.classList.toggle('select-active', on);
    // Commit its hidden starting state first — on the very first use the bar
    // was created and shown in the same frame, so it just appeared.
    void selectBar.offsetWidth;
    selectBar.classList.toggle('show', on);
    updateSelectCount();
    refreshToolbar();
  }
  function placeSelectBar() {
    if (!selectBar) return;
    const a = document.getElementById('card-following'), b = document.getElementById('card-followers');
    const wide = window.matchMedia('(min-width: 1025px)').matches && a && b && a.getClientRects().length;
    selectBar.classList.toggle('over-lists', !!wide);
    if (!wide) { selectBar.style.left = ''; selectBar.style.top = ''; return; }
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const left = Math.min(ra.left, rb.left), right = Math.max(ra.right, rb.right);
    const top = Math.min(ra.top, rb.top), bottom = Math.max(ra.bottom, rb.bottom);
    selectBar.style.left = `${(left + right) / 2}px`;
    selectBar.style.top = `${(top + bottom) / 2}px`;
  }
  window.addEventListener('resize', () => { if (selectMode) placeSelectBar(); });
  // List 3 re-renders (a search, a row leaving, switching accounts) rebuilt
  // the rows without their selected outline, and the count kept usernames
  // that were no longer there.
  function keepSelection() {
    if (!selectMode || selectOnPending()) return;
    const here = new Set(state.unfollowers.map(u => u.username));
    [...selected].forEach(n => { if (!here.has(n)) selected.delete(n); });
    elements.listUnfollowers.classList.add('select-mode');
    elements.listUnfollowers.querySelectorAll('.user-row').forEach(r => r.classList.toggle('multi-selected', selected.has(r.dataset.username)));
    updateSelectCount();
  }
  function updateSelectCount() {
    if (!selectBar) return;
    // The count pill eases to its new width (the bar, sized to its content,
    // follows along), instead of snapping when the number gets a digit.
    const count = selectBar.querySelector('.row-select-count');
    const text = `${selected.size} selected`;
    if (count.textContent !== text) {
      const from = count.getBoundingClientRect().width;
      if (count._anim) count._anim.cancel();
      count.textContent = text;
      const to = count.getBoundingClientRect().width;
      if (from && Math.abs(from - to) > 0.5 && selectBar.classList.contains('show') && typeof count.animate === 'function') {
        count._anim = count.animate([{ width: `${from}px` }, { width: `${to}px` }], { duration: 260, easing: EASE });
      }
    }
    selectBar.querySelectorAll('[data-bulk]:not([data-bulk="cancel"])').forEach(b => { b.disabled = selected.size === 0; });
  }
  // Pending requests' rows, in select mode.
  document.addEventListener('click', (e) => {
    if (!selectMode || !selectOnPending()) return;
    const row = e.target.closest('.results-extra[data-sub="pending"] .user-row');
    if (!row || row.classList.contains('username-exit')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const name = row.dataset.username;
    if (selected.has(name)) selected.delete(name); else selected.add(name);
    row.classList.toggle('multi-selected', selected.has(name));
    updateSelectCount();
  }, true);
  elements.listUnfollowers.addEventListener('click', (e) => {
    if (!selectMode) return;
    const row = e.target.closest('.user-row');
    if (!row || row.classList.contains('username-exit')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const name = row.dataset.username;
    if (selected.has(name)) selected.delete(name); else selected.add(name);
    row.classList.toggle('multi-selected', selected.has(name));
    updateSelectCount();
  }, true);
  function bulkAction(kind) {
    if (kind === 'cancel' || selected.size === 0) { setSelectMode(false); return; }
    if (selectOnPending()) {
      const names = [...selected];
      setSelectMode(false);
      movePending(names, kind === 'star' ? 'star' : 'unfollow', null);
      return;
    }
    const snap = snapshot();
    const acc = accKey();
    const users = state.unfollowers.filter(u => selected.has(u.username));
    if (kind === 'star') {
      const have = new Set(state.starred.map(u => u.username));
      users.forEach(u => { if (!have.has(u.username)) state.starred.unshift({ ...u, account: acc }); });
    } else if (kind === 'unfollow') {
      const have = new Set(state.unfollowed.map(u => u.username));
      users.forEach(u => { if (!have.has(u.username)) state.unfollowed.unshift({ ...u, account: acc }); });
    }
    const n = users.length;
    setSelectMode(false);
    saveCurrentAccountData();
    calculateUnfollowers({ animate: true }); // they slide out of list 3
    offerUndo(snap, `${plural(n, 'account')} ${kind === 'star' ? 'starred' : 'unfollowed'}`);
  }

  // ---------- list 3 views: a tab switcher above list 3's box ----------
  // Same bar and sliding highlight as the instructions window. Switching
  // only swaps what's inside list 3's box: the old view slides out, the new
  // one slides in, in the direction of the tab — together 550ms on the
  // highlight's easing, so the content lands as the highlight does.
  const VIEWS = [
    ['results', 'results'], ['changes', 'changes'], ['mutuals', 'mutuals'], ['fans', 'fans'],
    ['compare', 'compare'], ['stats', 'stats']
  ];
  // The switchers inside views, and the tab each one is on (results and
  // stats remember theirs on this device).
  const SUB_TABS = {
    changes: [['lost', 'unfollowed you'], ['new', 'new followers'], ['stopped', 'you stopped following'], ['started', 'you started following']],
    stats: [['overview', 'overview'], ['timeline', 'timeline']],
    results: [['unfollowers', 'unfollowers'], ['pending', 'pending requests'], ['closeFriends', 'close friends'], ['blocked', 'blocked'], ['restricted', 'restricted']]
  };
  const savedSub = (key, view) => {
    try { const v = localStorage.getItem(key); if (SUB_TABS[view].some(t => t[0] === v)) return v; } catch (e) {}
    return SUB_TABS[view][0][0];
  };
  const subTab = { changes: 'lost', stats: savedSub('stats_sub', 'stats'), results: savedSub('results_sub', 'results') };
  let viewNav = null;
  let altView = null;
  let currentView = 'results';
  let viewToken = 0;
  function buildViewSwitcher() {
    const box = document.querySelector('#card-unfollowers .results-container');
    if (!box || viewNav) return;
    // Open on the view you were last on (saved on this device), without a
    // slide — not always back on results after a reload.
    let saved = 'results';
    try { saved = localStorage.getItem('list3_view') || 'results'; } catch (e) {}
    if (!VIEWS.some(v => v[0] === saved)) saved = 'results';
    currentView = saved;
    viewNav = document.createElement('div');
    viewNav.className = 'instructions-steps-nav list3-views';
    viewNav.innerHTML = `<div class="instructions-nav-indicator list3-views-indicator"></div>
      ${VIEWS.map(([id, label]) => `<button class="insights-tab${id === saved ? ' active' : ''}" data-view="${id}">${label}</button>`).join('')}`;
    box.parentNode.insertBefore(viewNav, box);
    altView = document.createElement('div');
    altView.className = `list3-alt-view${saved === 'results' ? ' hidden' : ''}`;
    box.appendChild(altView);
    if (saved !== 'results') {
      box.classList.add('showing-alt');
      settleRender(); // drawn once the data has loaded (see below)
    }
    viewNav.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-view]');
      if (!tab) return;
      e.stopPropagation();
      showView(tab.dataset.view);
    });
    altView.addEventListener('change', (e) => { if (e.target.matches('.compare-select')) renderView(); });
    altView.addEventListener('click', (e) => {
      const box = e.target.closest('.insights-stat');
      if (box) { safe(() => goToStat([...box.parentNode.children].indexOf(box)), 'stat box'); return; }
      const tab = e.target.closest('[data-sub]');
      if (tab) { e.stopPropagation(); showAltSub(tab.dataset.sub); }
    });
    // Park the highlight under "results" once the bar has a size.
    // Re-places the highlight after a real change in the tabs' size or
    // position. iPhone Safari fires "resize" constantly (its toolbars grow
    // and shrink); re-placing then cut the slide short and it snapped onto
    // the tab. A slide that's playing, or a highlight already on its tab,
    // is left alone.
    const place = () => {
      const active = viewNav.querySelector('.insights-tab.active');
      if (!active || !active.offsetWidth) return;
      const indicator = viewNav.querySelector('.list3-views-indicator');
      const running = indicator._anims && indicator._anims.some(an => an.playState === 'running');
      const pos = indicator._pos;
      if (running || (pos && Math.abs(pos.x - active.offsetLeft) < 0.5 && Math.abs(pos.w - active.offsetWidth) < 0.5)) return;
      indicator._pos = null;
      moveInstructionsIndicator(indicator, active);
      // A restored tab near the end (stats) scrolled into view.
      const right = active.offsetLeft + active.offsetWidth + 12;
      if (right > viewNav.scrollLeft + viewNav.clientWidth) viewNav.scrollLeft = right - viewNav.clientWidth;
      else if (active.offsetLeft - 12 < viewNav.scrollLeft) viewNav.scrollLeft = Math.max(0, active.offsetLeft - 12);
    };
    requestAnimationFrame(place);
    // Once the font has loaded the tabs have their real widths.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { place(); placeChangesIndicator(); });
    window.addEventListener('resize', place);
    // Searching or jumping to list 3 by keyboard brings the results back.
    // Only once something is typed (just tapping the search box leaves you
    // where you are); one step (two queued separately, the second
    // replaced the first).
    elements.searchUnfollowers && elements.searchUnfollowers.addEventListener('input', () => elements.searchUnfollowers.value.trim() && (currentView !== 'results' || subTab.results !== 'unfollowers') && queueSwitch(viewGate, () => {
      if (currentView === 'results') { switchResultsSub('unfollowers'); return; }
      jumpResultsSub('unfollowers'); // not on screen: no slide needed
      switchView('results');
    }));
    if (window.ResizeObserver) new ResizeObserver(place).observe(viewNav);
  }
  // What's showing in the box for a view.
  const viewEls = (view) => view === 'results'
    ? [elements.listUnfollowers, document.getElementById('unfollowers-empty-state')].filter(el => el && !el.classList.contains('hidden'))
    : [altView];
  // One tab switch at a time: a tap early in a slide waits until the slide
  // is mostly done (SLIDE_WAIT of it: most of the way across on its eased
  // curve), then goes (only the latest such tap) and carries on smoothly
  // from there. Waiting for the very end felt laggy; not waiting at all cut
  // slides short and looked broken.
  const SLIDE_WAIT = 0.55;
  function queueSwitch(gate, run) {
    const left = (gate.until || 0) - performance.now();
    if (left <= 0 && !gate.next) { run(); return; }
    gate.next = run;
    clearTimeout(gate.timer);
    gate.timer = setTimeout(() => { const next = gate.next; gate.next = null; if (next) next(); }, Math.max(0, left) + 20);
  }
  // Shared by every switcher (list 3's views and the tabs inside them): a
  // view tapped right after a tab inside it waits too, or the bar slid away
  // while its own tabs were still gliding back across it.
  const viewGate = {};
  function showView(view) {
    queueSwitch(viewGate, () => switchView(view));
  }
  function switchView(view) {
    if (!viewNav || view === currentView) return;
    clearTimeout(settleTimer); // a switch takes over from the load-time draw
    if (altView) altView.style.opacity = '';
    const ids = VIEWS.map(v => v[0]);
    const dir = ids.indexOf(view) > ids.indexOf(currentView) ? 1 : -1;
    const tabs = [...viewNav.querySelectorAll('[data-view]')];
    const active = tabs.find(t => t.dataset.view === view);
    tabs.forEach(t => t.classList.toggle('active', t === active));
    moveInstructionsIndicator(viewNav.querySelector('.list3-views-indicator'), active);
    // Same scroll rule as the instructions bar: peek at the next tab.
    const left = active.offsetLeft - 12, right = active.offsetLeft + active.offsetWidth + (active.nextElementSibling ? 38 : 12);
    if (left < viewNav.scrollLeft) scrollInstructionsNav(viewNav, Math.max(0, left));
    else if (right > viewNav.scrollLeft + viewNav.clientWidth) scrollInstructionsNav(viewNav, right - viewNav.clientWidth);

    if (view !== 'results' && selectMode) setSelectMode(false);
    try { localStorage.setItem('list3_view', view); } catch (e) {}
    currentView = view;
    const box = altView.parentNode;
    const w = boxWidth();
    const listEls = resultsEls;
    const panes = () => [...altView.querySelectorAll(':scope > .insights-pane')];
    // Tapping again mid-slide: everything carries on from where it's drawn
    // right now (no snapping back). Record it, then stop the old slide.
    const at = new Map();
    const track = (el) => {
      if (!el || at.has(el) || !el.getClientRects().length) return;
      const cs = getComputedStyle(el);
      at.set(el, { x: new DOMMatrixReadOnly(cs.transform).m41 || 0, o: +cs.opacity });
    };
    [...listEls(), altView, ...panes()].forEach(track);
    at.forEach((_, el) => el.getAnimations().forEach(an => an.cancel()));
    panes().forEach(p => { p.style.transform = ''; p.style.opacity = ''; });
    clearTimeout(switchTimer);
    // When the whole box moves (to or from the results), the pages inside
    // it keep the offset they were drawn at, so nothing jumps inside it.
    const freezePanes = () => panes().forEach(p => {
      const a = at.get(p);
      if (a && (Math.abs(a.x) > 0.5 || a.o < 0.99)) { p.style.transform = `translateX(${a.x}px)`; p.style.opacity = a.o; }
    });

    let incoming = [];
    const leaving = [];
    const altShowing = !altView.classList.contains('hidden') && !altView.classList.contains('view-leaving');
    if (view === 'results') {
      box.classList.remove('showing-alt');
      // Back in the flow (a list still sliding between results tabs stays
      // pinned until it has gone).
      listEls().forEach(el => { el.classList.remove('view-leaving'); if (!el.classList.contains('pane-out')) clearPin(el); });
      incoming = listEls();
      if (at.has(altView)) { freezePanes(); altView.classList.add('view-leaving'); leaving.push(altView); }
      else altView.classList.add('hidden');
    } else if (!altShowing) {
      // From the results (or on its way there): the list goes, the view box
      // comes — the same box turning round if it was the one leaving.
      // Pinned where they are (the switcher on top, the list under it) while
      // they slide away over the box.
      const going = listEls().filter(el => at.has(el) || el.getClientRects().length);
      pinAll(box, going.filter(el => !el.classList.contains('pane-out') && !el.classList.contains('view-leaving')));
      going.forEach(el => { el.classList.add('view-leaving'); leaving.push(el); });
      const live = altView.querySelector(':scope > .insights-pane:not(.pane-leaving)');
      altView.classList.remove('view-leaving', 'hidden');
      box.classList.add('showing-alt');
      // Its page is only reused while it's still sliding (turning round);
      // one put away earlier is drawn again — the data may have changed
      // since (an import on the results, say).
      if (!live || live.dataset.view !== view || !at.has(altView)) { panes().filter(p => p !== live).forEach(p => p.remove()); renderView(); altView.scrollTop = 0; }
      else {
        altView._html = renderView(true);
        // The page that's coming back was drawn off-centre inside the box:
        // the box takes over that offset, the page sits centred in it.
        const a = at.get(live), b = at.get(altView);
        if (a && b) at.set(altView, { x: b.x + a.x, o: Math.min(b.o, a.o) });
        // Pages still on their way out inside the box finish leaving from
        // where they're drawn (relative to the box's new place).
        altView.querySelectorAll(':scope > .insights-pane.pane-leaving').forEach(p => {
          const f = at.get(p) || { x: 0, o: 0.35 };
          const rel = f.x - (a ? a.x : 0);
          const to = rel < 0 ? rel - w * 0.5 : rel + w * 0.5;
          if (typeof p.animate === 'function') p.animate([{ transform: `translateX(${rel}px)`, opacity: f.o }, { transform: `translateX(${to}px)`, opacity: 0 }], { duration: 300, easing: TAB_MOTION.in.easing, fill: 'forwards' });
          else p.remove();
        });
      }
      incoming = [altView];
    } else {
      // View to view inside the box: the page you go to may still be on its
      // way out — it turns round; otherwise it's drawn.
      let target = panes().find(p => p.dataset.view === view);
      const others = panes().filter(p => p !== target);
      const scroll = altView.scrollTop;
      others.forEach(p => { if (!p.classList.contains('pane-leaving')) { p.classList.add('pane-leaving'); p.style.top = `${12 - scroll}px`; } });
      if (target) {
        target.classList.remove('pane-leaving');
        target.style.top = '';
        altView._html = renderView(true);
      } else {
        others.forEach(p => p.remove());
        renderView();
        target = altView.querySelector(':scope > .insights-pane');
        others.forEach(p => altView.appendChild(p));
      }
      altView.scrollTop = 0;
      incoming = [target];
      leaving.push(...others);
      listEls().filter(el => el.classList.contains('view-leaving')).forEach(el => leaving.push(el));
    }
    refreshToolbar();
    centerSoon();
    if (typeof altView.animate !== 'function') { finishSwitch(); return; }
    const D = TAB_MOTION.in.duration;
    const timing = (dist) => ({ duration: Math.round(D * Math.min(1, Math.max(0.35, Math.abs(dist) / w))), easing: TAB_MOTION.in.easing });
    let longest = 0;
    incoming.forEach(el => {
      const from = at.has(el) ? at.get(el) : { x: dir * w, o: 0.35 };
      const t = timing(from.x);
      longest = Math.max(longest, t.duration);
      el.animate([{ transform: `translateX(${from.x}px)`, opacity: from.o }, { transform: 'translateX(0)', opacity: 1 }], t);
    });
    // Like a carousel in tab order: a page for a tab left of the one you
    // chose leaves to the left, one to its right leaves to the right — so
    // however fast you tap, the pages keep their order on screen.
    const order = (v) => VIEWS.findIndex(x => x[0] === v);
    const viewOf = (el) => el === altView
      ? ((altView.querySelector(':scope > .insights-pane:not(.pane-leaving)') || {}).dataset || {}).view
      : el.classList.contains('insights-pane') ? el.dataset.view : 'results';
    const targetOrder = order(view);
    leaving.forEach(el => {
      const from = at.has(el) ? at.get(el) : { x: 0, o: 1 };
      const o = order(viewOf(el));
      const to = (o >= 0 ? o < targetOrder : dir > 0) ? -w : w;
      // Already mostly off the other side: it just fades where it is,
      // rather than travelling back across the box.
      if (Math.sign(from.x) === -Math.sign(to) && Math.abs(from.x) > 0.4 * w) {
        el.animate([{ transform: `translateX(${from.x}px)`, opacity: from.o }, { transform: `translateX(${from.x}px)`, opacity: 0 }], { duration: 90, fill: 'forwards' });
        return;
      }
      const t = timing(to - from.x);
      longest = Math.max(longest, t.duration);
      el.animate([{ transform: `translateX(${from.x}px)`, opacity: from.o }, { transform: `translateX(${to}px)`, opacity: 0.35 }], { ...t, fill: 'forwards' });
    });
    const token = ++viewToken;
    switchTimer = setTimeout(() => { if (token === viewToken) finishSwitch(); }, longest + 30);
    viewGate.until = performance.now() + longest * SLIDE_WAIT;
  }
  let switchTimer = null;
  // Once a switch has played out: what slid away is put away.
  function finishSwitch() {
    if (!altView) return;
    altView.querySelectorAll(':scope > .insights-pane.pane-leaving').forEach(p => p.remove());
    const box = altView.parentNode;
    // The results slid away: a results tab switch it cut short is put away
    // too. (Back on the results, one that's playing carries on.)
    if (currentView !== 'results') settleSub(box);
    [resultsSubnav, ...resultsPanes()].forEach(el => {
      if (!el || !el.classList.contains('view-leaving')) return;
      el.getAnimations().forEach(an => an.cancel());
      el.classList.remove('view-leaving');
      if (!el.classList.contains('pane-out')) clearPin(el);
    });
    if (currentView === 'results') {
      altView.getAnimations().forEach(an => an.cancel());
      altView.classList.remove('view-leaving');
      altView.classList.add('hidden');
      altView.querySelectorAll(':scope > .insights-pane').forEach(p => { p.style.transform = ''; p.style.opacity = ''; });
    }
  }
  // Keep the open view current as the data changes (imports, account
  // switches, unfollows).
  // The data behind a view changed (an account picked or dropped, files
  // imported): the old content fades up and away while the new comes in
  // piece by piece. Stats animates its own numbers and graph instead.
  // While the page loads, the data arrives in steps (nothing, this device's
  // copy, the cloud's), and drawing each one made the view's text flicker.
  // So for the first few seconds (or until you touch the page) the view
  // waits for the data to settle, then draws once and fades in.
  let pageLoading = true;
  setTimeout(() => { pageLoading = false; }, 4000);
  // A tap or a key ends it (not a scroll: touching to scroll ended it early).
  ['click', 'keydown'].forEach(ev => window.addEventListener(ev, () => { pageLoading = false; }, { once: true, capture: true }));
  let settleTimer = null;
  function settleRender() {
    if (!altView) return;
    altView.style.opacity = '0';
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (currentView === 'results') { altView.style.opacity = ''; return; }
      renderView();
      altView.style.opacity = '';
      if (typeof altView.animate === 'function') altView.animate([{ opacity: 0, transform: `translateY(${-SLIDE_Y}px)` }, { opacity: 1, transform: 'none' }], ARRIVE);
    }, 350);
  }
  function refreshView() {
    if (currentView === 'results' || !altView) return;
    if (pageLoading) { settleRender(); return; }
    if (currentView === 'stats') { renderView(); return; }
    if (renderView(true) === altView._html) return; // nothing changed
    const oldPane = altView.querySelector('.insights-pane:not(.pane-leaving)');
    const scroll = altView.scrollTop;
    renderView();
    // Its usernames already slid in and out like list 3's rows: done.
    if (altView._rowsSlid) { altView.scrollTop = scroll; return; }
    altView.scrollTop = 0;
    if (!oldPane || typeof oldPane.animate !== 'function') return;
    oldPane.classList.add('pane-leaving');
    // The changes view's switcher stays put (the new one sits exactly where
    // the old one was); only what's under it swaps.
    // So do the views' explanation lines ("they follow you, but you don't
    // follow them back"): they don't animate at all.
    oldPane.querySelectorAll(':scope > .changes-nav, :scope > .insights-sub').forEach(el => { el.style.visibility = 'hidden'; });
    oldPane.style.top = `${12 - scroll}px`;
    altView.appendChild(oldPane);
    // Empty texts leave with the one empty-text fade, not the window motion.
    oldPane.querySelectorAll('.dropdown-empty-message').forEach(m => { fadeGhostOut(m); m.style.visibility = 'hidden'; });
    // Gone once it has faded — and also if the fade gets interrupted (a
    // phone can while the page is still loading), with a backup timer: a
    // leftover used to sit on top of the new content after a reload.
    const drop = () => oldPane.remove();
    oldPane.animate(MODAL_OUT, LEAVE).finished.then(drop, drop);
    setTimeout(drop, LEAVE.duration + 400);
    // The new content only comes in once the old has gone, so the two never
    // show on top of each other (two texts in the same spot did).
    contentIn(altView.querySelector('.insights-pane:not(.pane-leaving)'), LEAVE.duration);
  }
  // The new content comes in as one block, the exit played backwards
  // (the changes view's switcher stays put, only what's under it moves).
  function contentIn(pane, delay = 0) {
    if (!pane || typeof pane.animate !== 'function') return;
    [...pane.children]
      .filter(ch => !ch.matches('.changes-nav, .insights-sub') && !(ch.matches('.changes-pane') && !ch.classList.contains('active')))
      .forEach(el => {
        // An empty text (alone, or all its list holds) comes in with the
        // one empty-text fade.
        const onlyEmpty = el.matches('.dropdown-empty-message') || (el.children.length === 1 && el.firstElementChild.matches('.dropdown-empty-message'));
        if (onlyEmpty) fadeEmptyIn(el, delay);
        else el.animate(MODAL_IN, { duration: 450, easing: MODAL_EASE, delay, fill: 'backwards' });
      });
  }


  const followingSet = () => new Set(state.following.map(u => u.username));
  const followersSet = () => new Set(state.followers.map(u => u.username));
  // Every username list (changes, mutuals, fans, compare, the results
  // tabs) uses list 3's own row box: avatar, @name, a note under it, and
  // the profile arrow (plus the X where a row can be removed).
  const STAR_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>';
  const TRASH_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
  // dismiss: true (the X) or 'pending' (star, unfollow and the X, like
  // list 3's own rows: starred/unfollowed ones move to those submenus).
  const boxRowHtml = (u, noteOf, dismiss) => {
    const href = esc(safeProfileUrl(u));
    const name = u.originalUsername || u.username;
    const note = noteOf && noteOf(u);
    return `<div class="user-row" data-username="${esc(u.username)}">
          <div class="user-info">
            <a href="${href}" target="_blank" rel="noopener" class="user-avatar-link" title="visit instagram profile"><div class="user-avatar">${esc(name.substring(0, 2))}</div></a>
            <div class="user-details"><a href="${href}" target="_blank" rel="noopener" class="user-link">@${esc(name)}</a>${note ? `<span class="user-fullname">${esc(note)}</span>` : ''}</div>
          </div>
          <div class="user-meta"><div class="user-row-actions">
            ${dismiss === 'pending' ? `<button class="action-star" aria-label="star this account" title="move to the starred list">${STAR_ICON}</button><button class="action-delete" aria-label="mark as unfollowed" title="move to the unfollowed list">${TRASH_ICON}</button>` : ''}
            <a href="${href}" target="_blank" rel="noopener" class="action-arrow" aria-label="visit instagram profile" title="visit instagram profile">${ARROW_ICON}</a>
            ${dismiss ? `<button class="action-dismiss" aria-label="remove from this list" title="remove from this list">${X_ICON}</button>` : ''}
          </div></div>
        </div>`;
  };
  // Long lists: the first LIST_PAGE (script.js) now, the rest a page at a
  // time behind a loading sign at the end (wireRowsMore). The rest waits
  // here under a key made from the list itself, so the same list gives the
  // same HTML (the views compare HTML to skip needless redraws).
  const moreRows = new Map();
  const boxRowsHtml = (users, empty, noteOf, dismiss) => {
    if (!users.length) return empty ? `<div class="dropdown-empty-message">${empty}</div>` : '';
    let more = '';
    if (users.length > LIST_PAGE) {
      const key = `${users.length}|${users[0].username}|${users[users.length - 1].username}|${dismiss || 0}`;
      if (moreRows.size > 40) moreRows.clear();
      moreRows.set(key, { users, noteOf, dismiss });
      more = `<div class="rows-more" data-more-key="${esc(key)}" role="status" aria-label="loading more"><span class="rows-more-spinner" aria-hidden="true"></span></div>`;
    }
    return `<div class="pending-list">${users.slice(0, LIST_PAGE).map(u => boxRowHtml(u, noteOf, dismiss)).join('')}${more}</div>`;
  };
  // Hooks up each new loading sign: once scrolled to, the next page comes
  // in (and a new sign after it, if there's still more).
  function wireRowsMore(root) {
    root.querySelectorAll('.rows-more[data-more-key]').forEach(el => {
      if (el._loadMore) return;
      const entry = moreRows.get(el.dataset.moreKey);
      if (!entry) { el.remove(); return; }
      const list = el.parentNode;
      el._loadMore = () => {
        const shown = list.querySelectorAll(':scope > .user-row:not(.username-exit)').length;
        const next = entry.users.slice(shown, shown + LIST_PAGE);
        list.insertAdjacentHTML('beforeend', next.map(u => boxRowHtml(u, entry.noteOf, entry.dismiss)).join(''));
        if (shown + next.length < entry.users.length) {
          const sign = makeRowsMore(el._loadMore);
          list.appendChild(sign);
        }
      };
      watchRowsMore(el);
    });
  }
  let wireQueued = false;
  new MutationObserver(() => {
    if (wireQueued) return;
    wireQueued = true;
    requestAnimationFrame(() => { wireQueued = false; safe(() => wireRowsMore(document.getElementById('card-unfollowers') || document), 'more rows'); });
  }).observe(document.body, { childList: true, subtree: true });
  const userRowsHtml = (users, empty, action, flagOf) => boxRowsHtml(users, empty, flagOf, false);
  // Stats: six boxes, each with its own color, and a bar per box in the
  // graph below in the same color. No data yet: a greyed-out example graph.
  // A calm, professional palette; a box and its bar share one.
  const STAT_COLORS = ['#4f7fe8', '#2f9e7e', '#7b6ee6', '#d6588f', '#e0604f', '#dd9a2b'];
  let poppedStat = -1; // the box tapped: its bar stays popped out
  const MOCK_HEIGHTS = [60, 85, 70, 40, 55, 30];
  const chartHtml = (heights, mock) => `<div class="trend-chart${mock ? ' trend-mock' : ''}"${mock ? ' aria-hidden="true"' : ''}>${heights.map((h, i) =>
    `<div class="trend-bar" style="height:${h}%;--bar:${STAT_COLORS[i]}"></div>`).join('')}</div>`;
  const asUsers = (names) => names.map(n => ({ username: n, originalUsername: n }));
  const stat = (value, label, i) => `<div class="insights-stat" style="--stat:${STAT_COLORS[i]}"><div class="insights-stat-value">${value}</div><div class="insights-stat-label">${label}</div></div>`;

  // ---------- stats: timeline ----------
  // Following and followers at each import (the last 24), as two lines in
  // their stat boxes' colors. Before a second import: a greyed-out example,
  // like the overview's graph.
  const MOCK_TIMELINE = [[40, 52], [46, 55], [44, 61], [52, 64], [55, 72], [58, 77]]; // [following, followers]
  const shortDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  // Each date keeps its time, so a change can roll it to the new one.
  const dateSpans = (times) => times.map(t => `<span data-t="${Math.round(t)}">${shortDate(t)}</span>`).join('');
  function timelineHtml(key) {
    const hist = key === DEMO_ID ? [] : readJSON(`import_history_${key}`, [])
      .filter(h => h && Number.isFinite(h.date) && Number.isFinite(h.following) && Number.isFinite(h.followers));
    // Real as soon as there's data: each import, and now (if the lists have
    // changed since). With one point only, it's drawn as a flat line.
    const nowA = state.following.length, nowB = state.followers.length;
    const real = nowA > 0 || nowB > 0;
    let pts;
    let single = false;
    if (real) {
      pts = hist.map(h => ({ t: h.date, a: h.following, b: h.followers }));
      const lastH = pts[pts.length - 1];
      if (!lastH || lastH.a !== nowA || lastH.b !== nowB) pts.push({ t: Date.now(), a: nowA, b: nowB });
      if (pts.length === 1) { single = true; pts = [{ ...pts[0], t: pts[0].t - DAY }, pts[0]]; }
    } else {
      pts = MOCK_TIMELINE.map(([a, b], i) => ({ t: i, a, b }));
    }
    const W = 320, H = 150, PX = 6, PY = 14;
    const vals = pts.flatMap(p => [p.a, p.b]);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi - lo < 4) { lo -= 2; hi += 2; }
    const pad = (hi - lo) * 0.12;
    lo = Math.max(0, lo - pad); hi += pad;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const fx = (p, i) => (t1 > t0 ? (p.t - t0) / (t1 - t0) : i / Math.max(1, pts.length - 1));
    const x = (p, i) => PX + (W - 2 * PX) * fx(p, i);
    const y = (v) => PY + (H - 2 * PY) * (1 - (v - lo) / (hi - lo));
    const series = [['a', 'following', STAT_COLORS[0]], ['b', 'followers', STAT_COLORS[1]]];
    const path = (k) => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p, i).toFixed(1)} ${y(p[k]).toFixed(1)}`).join(' ');
    const grid = [0.25, 0.5, 0.75].map(g => `<line class="tl-grid" x1="0" x2="${W}" y1="${(H * g).toFixed(1)}" y2="${(H * g).toFixed(1)}"/>`).join('');
    const dots = series.map(([k, , c]) => pts.map((p, i) => `<span class="tl-dot" style="--c:${c};--x:${fx(p, i).toFixed(3)};left:${(x(p, i) / W * 100).toFixed(2)}%;top:${(y(p[k]) / H * 100).toFixed(2)}%"></span>`).join('')).join('');
    const last = pts[pts.length - 1];
    const sig = `${real ? 'r' : 'm'}:${pts.map(p => `${p.t}.${p.a}.${p.b}`).join(',')}`;
    // Where each point is drawn (graph units), so a change can move the
    // lines from one set of points to the next (morphTimeline).
    const shape = pts.map((p, i) => `${x(p, i).toFixed(1)},${y(p.a).toFixed(1)},${y(p.b).toFixed(1)}`).join(';');
    return `<div class="timeline${real ? '' : ' timeline-mock'}" data-sig="${sig}" data-pts="${shape}">
        <div class="timeline-legend">${series.map(([k, label, c]) => `<span class="timeline-key" style="--c:${c}"><i></i>${label}<b>${real ? last[k] : 0}</b></span>`).join('')}</div>
        <div class="timeline-chart"${real ? '' : ' aria-hidden="true"'}>
          <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${series.map(([k, , c]) => `<path class="tl-line" d="${path(k)}" style="--c:${c}"/>`).join('')}</svg>
          ${dots}
        </div>
        <div class="timeline-dates">${dateSpans(!real ? [new Date(new Date().getFullYear(), 9, 9).getTime(), new Date(new Date().getFullYear(), 9, 9).getTime()] : single ? [t1] : [t0, t1])}</div>
      </div>`;
  }
  // New numbers: the lines bend from where they are into their new shape
  // (points travelling with them), the example's grey warms into the real
  // colors, and the legend's numbers count to the new ones — like the stat
  // boxes. `tl` stays on screen and takes on `fresh`.
  const TL_W = 320, TL_H = 150, TL_MS = 900;
  const tlEase = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  function morphTimeline(tl, fresh) {
    const parse = (el) => (el.dataset.pts || '').split(';').filter(Boolean).map(p => p.split(',').map(Number));
    const from = tl._shape || parse(tl), to = parse(fresh);
    if (!from.length || !to.length) { tl.replaceWith(fresh); return; }
    // Height of the old line at x (straight between its points).
    const yAt = (pts, x, k) => {
      if (x <= pts[0][0]) return pts[0][k];
      for (let i = 1; i < pts.length; i++) {
        if (x <= pts[i][0]) { const [x0] = pts[i - 1], [x1] = pts[i]; const f = x1 > x0 ? (x - x0) / (x1 - x0) : 1; return pts[i - 1][k] + (pts[i][k] - pts[i - 1][k]) * f; }
      }
      return pts[pts.length - 1][k];
    };
    tl.dataset.sig = fresh.dataset.sig;
    tl.dataset.pts = fresh.dataset.pts;
    // Legend: the numbers count from the old to the new.
    const oldNums = [...tl.querySelectorAll('.timeline-key b')].map(b => parseInt(b.textContent, 10) || 0);
    tl.querySelector('.timeline-legend').replaceWith(fresh.querySelector('.timeline-legend'));
    tl.querySelectorAll('.timeline-key b').forEach((b, i) => {
      const a = oldNums[i] ?? 0, z = parseInt(b.textContent, 10) || 0;
      if (a === z) return;
      const t0 = performance.now();
      // Counted exactly like the stat boxes' numbers (updateStats): 650ms,
      // easing out, so every number in between shows.
      const step = (now) => { const t = Math.min(1, (now - t0) / 650); b.textContent = Math.round(a + (z - a) * (1 - Math.pow(1 - t, 3))); if (t < 1 && b.isConnected) requestAnimationFrame(step); };
      b.textContent = a;
      requestAnimationFrame(step);
    });
    // Dates: each rolls from the old date to the new one, month and day
    // ticking through like the numbers count.
    const oldTimes = [...tl.querySelectorAll('.timeline-dates [data-t]')].map(el => +el.dataset.t);
    tl.querySelector('.timeline-dates').replaceWith(fresh.querySelector('.timeline-dates'));
    tl.querySelectorAll('.timeline-dates [data-t]').forEach((el, i) => {
      const a = oldTimes[i] ?? oldTimes[oldTimes.length - 1], z = +el.dataset.t;
      if (a === undefined || shortDate(a) === shortDate(z)) return;
      const t0 = performance.now();
      el.textContent = shortDate(a);
      const step = (now) => { const t = Math.min(1, (now - t0) / TL_MS); el.textContent = shortDate(a + (z - a) * tlEase(t)); if (t < 1 && el.isConnected) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
    // The line is drawn through every old and new point while it moves
    // (so the example's bends flatten out gradually rather than vanishing
    // when there are fewer points); the old points fade out and the new
    // ones fade in, each riding the moving line.
    const chart = tl.querySelector('.timeline-chart');
    const xs = [...new Set([...from.map(p => p[0]), ...to.map(p => p[0])])].sort((a, b) => a - b);
    const oldDots = [...chart.querySelectorAll('.tl-dot')].map(d => {
      d.getAnimations().forEach(an => an.cancel());
      const x = parseFloat(d.style.left) / 100 * TL_W;
      return { d, x, k: parseFloat(d.style.top) / 100 * TL_H === yAt(from, x, 1) ? 1 : (Math.abs(parseFloat(d.style.top) / 100 * TL_H - yAt(from, x, 1)) < Math.abs(parseFloat(d.style.top) / 100 * TL_H - yAt(from, x, 2)) ? 1 : 2) };
    });
    const dots = [...fresh.querySelectorAll('.tl-dot')];
    dots.forEach(d => chart.appendChild(d));
    if (typeof chart.animate === 'function') {
      oldDots.forEach(({ d }) => { d.classList.add('tl-dot-old'); d.animate([{ opacity: 1 }, { opacity: 0 }], { duration: TL_MS * 0.6, easing: MODAL_EASE, fill: 'forwards' }); });
      dots.forEach(d => d.animate([{ opacity: 0 }, { opacity: 1 }], { duration: TL_MS * 0.6, delay: TL_MS * 0.4, easing: MODAL_EASE, fill: 'backwards' }));
    }
    setTimeout(() => oldDots.forEach(({ d }) => d.remove()), TL_MS + 50);
    const paths = [...chart.querySelectorAll('.tl-line')];
    [...fresh.querySelectorAll('.tl-line')].forEach((p, i) => { if (paths[i]) paths[i].setAttribute('style', p.getAttribute('style')); });
    // The colors change last, once the pieces above have their current
    // (grey or old) color on screen, so it eases across instead of jumping.
    tl.querySelectorAll('.tl-line, .tl-dot, .timeline-key i, .timeline-key b').forEach(el => { const cs = getComputedStyle(el); void (cs.stroke + cs.borderColor + cs.backgroundColor + cs.color); });
    tl.className = fresh.className;
    const token = (tl._morph = {});
    const t0 = performance.now();
    const draw = (e, done) => {
      const at = (x, k) => yAt(from, x, k) + (yAt(to, x, k) - yAt(from, x, k)) * e;
      const line = (done ? to.map(p => p[0]) : xs).map(x => [x, at(x, 1), at(x, 2)]);
      tl._shape = line; // a change mid-way carries on from here
      [1, 2].forEach((k, s) => {
        if (paths[s]) paths[s].setAttribute('d', line.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[k].toFixed(1)}`).join(' '));
        to.forEach((p, i) => { const d = dots[s * to.length + i]; if (d) d.style.top = `${(at(p[0], k) / TL_H * 100).toFixed(2)}%`; });
      });
      oldDots.forEach(({ d, x, k }) => { d.style.top = `${(at(x, k) / TL_H * 100).toFixed(2)}%`; });
    };
    draw(0);
    const step = (now) => {
      if (tl._morph !== token) return;
      const t = Math.min(1, (now - t0) / TL_MS);
      draw(tlEase(t), t >= 1);
      if (t < 1) requestAnimationFrame(step); else tl._shape = null;
    };
    requestAnimationFrame(step);
  }

  // The lines draw in from the left, the points pop in as the line reaches
  // them.
  function drawTimeline(scope) {
    const tl = scope && scope.querySelector('.timeline:not(.timeline-leaving)');
    const svg = tl && tl.querySelector('svg');
    if (!svg || typeof svg.animate !== 'function') return;
    const D = 900, DELAY = 120;
    svg.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)' }], { duration: D, delay: DELAY, easing: GLIDE, fill: 'backwards' });
    tl.querySelectorAll('.tl-dot').forEach(d => {
      const at = parseFloat(d.style.getPropertyValue('--x')) || 0;
      d.animate([{ opacity: 0, transform: 'translate(-50%, -50%) scale(0.3)' }, { opacity: 1, transform: 'translate(-50%, -50%) scale(1)' }],
        { duration: 380, delay: DELAY + D * 0.75 * at, easing: EASE, fill: 'backwards' });
    });
  }

  // dry: just return what the view would show (to tell if it changed).
  function renderView(dry = false) {
    const body = altView;
    const key = accKey();
    let html = '';
    if (currentView === 'changes') {
      const d = readJSON(`import_diff_${key}`, null);
      {
        // Its own switcher, same design as the one above list 3 — always
        // there, each tab with its own empty text.
        const lists = d ? { lost: d.lostFollowers, new: d.newFollowers, stopped: d.stoppedFollowing, started: d.startedFollowing } : { lost: [], new: [], stopped: [], started: [] };
        html = `${subNavHtml(SUB_TABS.changes, subTab.changes)}
          ${SUB_TABS.changes.map(([id]) => `<div class="changes-pane${id === subTab.changes ? ' active' : ''}" data-pane="${id}">${userRowsHtml(asUsers(lists[id]), CHANGE_EMPTY[id])}</div>`).join('')}`;
      }
    } else if (currentView === 'stats') {
      const following = state.following.length, followers = state.followers.length;
      const fset = followersSet();
      const mutual = state.following.filter(u => fset.has(u.username)).length;
      const ratio = following ? Math.round((mutual / following) * 100) : 0;
      const counts = [following, followers, null, state.unfollowers.length, state.unfollowed.length, state.starred.length];
      const hasData = following > 0 || followers > 0;
      const maxCount = Math.max(1, ...counts.filter(c => c !== null));
      // Log scale: next to 1,574 followers a count of 1, 12 or 50 was a
      // sliver on a straight scale; this keeps the order and shows them.
      const logScale = (c) => Math.round((Math.log1p(c) / Math.log1p(maxCount)) * 100);
      const heights = counts.map(c => c === null ? Math.max(4, ratio) : Math.max(4, logScale(c)));
      const pane = (id, inner) => `<div class="changes-pane${id === subTab.stats ? ' active' : ''}" data-pane="${id}">${inner}</div>`;
      html = `${subNavHtml(SUB_TABS.stats, subTab.stats)}
        ${pane('overview', `<div class="insights-stats">
          ${stat(following, 'following', 0)}${stat(followers, 'followers', 1)}${stat(`${ratio}%`, 'follow you back', 2)}
          ${stat(state.unfollowers.length, "don't follow you back", 3)}${stat(state.unfollowed.length, 'unfollowed', 4)}${stat(state.starred.length, 'starred', 5)}
        </div>
        <div class="trend-wrap">${hasData ? chartHtml(heights, false) : chartHtml(MOCK_HEIGHTS, true)}</div>`)}
        ${pane('timeline', timelineHtml(key))}`;
    } else if (currentView === 'mutuals') {
      const fset = followersSet();
      html = userRowsHtml(state.following.filter(u => fset.has(u.username)), 'no mutual accounts yet');
    } else if (currentView === 'fans') {
      const fset = followingSet();
      html = `<div class="insights-sub">they follow you, but you don't follow them back</div>${userRowsHtml(state.followers.filter(u => !fset.has(u.username)), 'no fan accounts yet')}`;
    } else if (currentView === 'compare') {
      const accounts = state.instagramAccounts.filter(a => !isDemoAccount(a));
      if (accounts.length < 2) html = `<div class="dropdown-empty-message">add a second account to compare who follows each one</div>`;
      else {
        const sel = [...altView.querySelectorAll('.compare-select')].map(s => s.value);
        const a = sel[0] || accounts[0].originalUsername.toLowerCase();
        const b = sel[1] || accounts[1].originalUsername.toLowerCase();
        const opts = (v) => accounts.map(x => `<option value="${esc(x.originalUsername.toLowerCase())}"${x.originalUsername.toLowerCase() === v ? ' selected' : ''}>@${esc(x.username)}</option>`).join('');
        const fol = (k) => readJSON(`followers_users_${k}`, []);
        const fa = fol(a), fb = fol(b);
        const sa = new Set(fa.map(u => u.username)), sb = new Set(fb.map(u => u.username));
        const nameOf = (v) => `@${esc((accounts.find(x => x.originalUsername.toLowerCase() === v) || {}).username || v)}`;
        const chevron = '<svg class="compare-pick-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
        const pick = (v) => `<label class="compare-pick"><span class="compare-pick-label">${nameOf(v)}</span>${chevron}<select class="compare-select" aria-label="account">${opts(v)}</select></label>`;
        // A side with nobody in it isn't shown at all (its heading on its
        // own read as the other side's heading repeated).
        const onlyA = fa.filter(u => !sb.has(u.username)), onlyB = fb.filter(u => !sa.has(u.username));
        const section = (title, users) => (users.length ? `<div class="insights-section"><div class="insights-section-title">${title}</div>${userRowsHtml(users, '')}</div>` : '');
        html = `<div class="compare-pickers">${pick(a)}<span>vs</span>${pick(b)}</div>
          ${section('follows the first account but not the second account', onlyA)}
          ${section('follows the second account but not the first account', onlyB)}`;
      }
    }
    if (dry) return html;
    body._html = html;
    // The graph's frame survives the redraw (see updateChart), so a slide
    // that's playing carries on through quick back-to-back redraws.
    const oldWrap = body.querySelector('.insights-pane:not(.pane-leaving) .trend-wrap');
    if (oldWrap) oldWrap.remove();
    // Same for the stat boxes: kept, and their numbers count to the new
    // values (rebuilding them re-ran their fade-in: a flicker).
    const oldStats = body.querySelector('.insights-pane:not(.pane-leaving) .insights-stats');
    if (oldStats) oldStats.remove();
    // And the timeline: kept while its numbers are the same.
    const oldTl = body.querySelector('.insights-pane:not(.pane-leaving) .timeline:not(.timeline-leaving)');
    if (oldTl) oldTl.remove();
    body.querySelectorAll('.pane-leaving').forEach(el => el.remove());
    const rowsBefore = captureViewRows(body);
    body.innerHTML = `<div class="insights-pane" data-view="${currentView}">${html}</div>`;
    body._rowsSlid = !!safe(() => slideViewRows(body, rowsBefore), 'view rows');
    placeChangesIndicator();
    const newStats = body.querySelector('.insights-stats');
    if (newStats && oldStats) { newStats.replaceWith(oldStats); updateStats(oldStats, newStats); }
    else if (newStats) {
      newStats.classList.add('stats-enter');
      setTimeout(() => newStats.classList.remove('stats-enter'), 500); // so moving it later can't replay it
    }
    const newWrap = body.querySelector('.trend-wrap');
    if (newWrap && oldWrap) { newWrap.replaceWith(oldWrap); updateChart(oldWrap, newWrap); }
    else if (newWrap) growChart(newWrap.querySelector('.trend-chart'));
    const newTl = body.querySelector('.timeline');
    if (newTl) {
      const tlPane = newTl.parentNode;
      const showing = tlPane.classList.contains('active');
      if (oldTl && oldTl.dataset.sig === newTl.dataset.sig) newTl.replaceWith(oldTl);
      else if (oldTl && showing && !pageLoading) {
        // New numbers: the lines move to them (from the example's, or the
        // last account's), like the stat boxes' numbers do.
        newTl.replaceWith(oldTl);
        morphTimeline(oldTl, newTl);
      } else if (showing) drawTimeline(tlPane);
    }
    applyPopped();
    centerSoon();
  }

  // A view's lists change like list 3 (an account picked, files imported,
  // the compare picks): usernames that stay stay put (or glide to their
  // new spot), gone ones slide out, new ones slide in — list 3's own row
  // engine (animateResultsExits / animateResultsReentry in script.js).
  // Only for the same view already on screen; switching views keeps its
  // sideways push.
  const listKey = (list) => {
    const section = list.closest('.insights-section');
    const title = section && section.querySelector('.insights-section-title');
    if (title) return `section:${title.textContent}`;
    const pane = list.closest('.changes-pane');
    const lists = [...(pane || list.closest('.insights-pane')).querySelectorAll('.pending-list')];
    return `${pane ? pane.dataset.pane : ''}#${lists.indexOf(list)}`;
  };
  function captureViewRows(body) {
    const pane = body.querySelector(':scope > .insights-pane:not(.pane-leaving)');
    if (!pane || pageLoading || !pane.getClientRects().length) return null;
    const out = { view: pane.dataset.view, lists: new Map(), ghosts: [] };
    // Its empty texts, to fade out if they're not there any more.
    pane.querySelectorAll('.dropdown-empty-message').forEach(m => {
      const play = m.getClientRects().length ? captureGhost(m) : null;
      if (play) out.ghosts.push({ text: m.textContent, play });
    });
    pane.querySelectorAll('.pending-list').forEach(list => {
      if (!list.getClientRects().length) return;
      const tops = new Map(), rows = new Map();
      list.querySelectorAll(':scope > .user-row:not(.username-exit)').forEach(r => {
        stopRowMotion(r);
        const rect = r.getBoundingClientRect();
        tops.set(r.dataset.username, rect.top);
        rows.set(r, { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width, pitch: r.offsetHeight + (parseFloat(getComputedStyle(r).marginBottom) || 0) });
      });
      out.lists.set(listKey(list), { tops, rows });
    });
    return out;
  }
  // Played whenever the same view is on screen and either side has rows:
  // kept usernames glide to their spot, gone ones slide out (pinned where
  // they were drawn), new ones slide in, and an empty text that's now
  // showing fades in once the rows have gone — like list 3 itself.
  function slideViewRows(body, before) {
    if (!before) return false;
    const pane = body.querySelector(':scope > .insights-pane');
    if (!pane || pane.dataset.view !== before.view) return false;
    const lists = [...pane.querySelectorAll('.pending-list')].filter(l => l.getClientRects().length);
    if (!lists.length && !before.lists.size) return false;
    const shownTexts = new Set([...pane.querySelectorAll('.dropdown-empty-message')].filter(m => m.getClientRects().length).map(m => m.textContent));
    before.ghosts.forEach(g => { if (!shownTexts.has(g.text)) g.play(); });
    const margin = window.innerHeight || 800;
    const onScreen = (rect) => rect.bottom > -margin && rect.top < window.innerHeight + margin;
    const pinOut = (host, rect, r) => {
      const hr = host.getBoundingClientRect();
      const k = host.offsetWidth ? hr.width / host.offsetWidth : 1;
      Object.assign(r.style, { position: 'absolute', top: `${(rect.top - hr.top) / k - host.clientTop}px`, left: `${(rect.left - hr.left) / k - host.clientLeft}px`, width: `${rect.width / k}px`, margin: '0', zIndex: '1' });
      r.classList.add('username-exit');
      host.appendChild(r);
      slideRowOut(r, rect.pitch, ROW_MOTION_MS, () => r.remove());
    };
    let left = 0;
    const used = new Set();
    lists.forEach(list => {
      const key = listKey(list);
      const was = before.lists.get(key);
      if (!was) { animateResultsReentry(list, new Map()); return; }
      used.add(key);
      const stay = new Set([...list.querySelectorAll(':scope > .user-row')].map(r => r.dataset.username));
      was.rows.forEach((rect, r) => {
        if (stay.has(r.dataset.username) || !onScreen(rect)) return;
        pinOut(list, rect, r);
        left++;
      });
      animateResultsReentry(list, was.tops);
    });
    // Lists that are gone altogether (now empty): their rows slide out over
    // where they were, laid over the view's own box (never by making the
    // view's content a positioned box: the sub-tabs' slide pins its panes
    // against the view's box, and a positioned parent in between put the
    // leaving pane lower by the switcher's height).
    before.lists.forEach((was, key) => {
      if (used.has(key)) return;
      left += pinRowsOut(body, was.rows, null);
    });
    // Its empty text only once those rows have left.
    if (left) pane.querySelectorAll('.dropdown-empty-message').forEach(m => { if (m.getClientRects().length) fadeEmptyIn(m, ROW_MOTION_MS); });
    stepRowMotion();
    return true;
  }

  // The stats graph. First time in: the bars grow up. Switching between
  // the example and real data: the one showing slides down out of sight,
  // then the new one slides up into place (slowly). New numbers, same kind:
  // each bar eases to its new height.
  // A stat box's number counts from its old value to the new one.
  function updateStats(stats, fresh) {
    const newVals = [...fresh.querySelectorAll('.insights-stat-value')].map(e => e.textContent);
    stats.querySelectorAll('.insights-stat-value').forEach((el, i) => {
      const to = newVals[i];
      if (to === undefined || el.textContent === to) return;
      const pct = to.endsWith('%');
      const a = parseInt(el.textContent, 10) || 0, b = parseInt(to, 10) || 0;
      const token = (el._countToken = {});
      const t0 = performance.now(), dur = 650;
      const ease = (t) => 1 - Math.pow(1 - t, 3);
      const step = (now) => {
        if (el._countToken !== token) return;
        const t = Math.min(1, (now - t0) / dur);
        el.textContent = `${Math.round(a + (b - a) * ease(t))}${pct ? '%' : ''}`;
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }
  // Tapping a stat box takes you to its list: following / followers →
  // list 1 / list 2 (brought into view with a brief outline), follow you
  // back → mutuals, don't follow you back → list 3's results, unfollowed /
  // starred → their submenus open.
  function goToStat(i) {
    if (i === 0 || i === 1) {
      const card = document.getElementById(i === 0 ? 'card-following' : 'card-followers');
      if (!card) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      card.classList.remove('card-flash');
      void card.offsetWidth;
      card.classList.add('card-flash');
      setTimeout(() => card.classList.remove('card-flash'), 1300);
    } else if (i === 2) {
      showView('mutuals');
    } else if (i === 3) {
      jumpResultsSub('unfollowers');
      showView('results');
    } else if (i === 4 || i === 5) {
      const toggle = document.getElementById(i === 4 ? 'toggle-preview-unfollowed' : 'toggle-preview-starred');
      const menu = document.getElementById(i === 4 ? 'list-unfollowed' : 'list-starred');
      if (!toggle || !menu || toggle.getAttribute('aria-disabled') === 'true') return;
      toggle.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      // After this tap has finished (the page's "tap outside closes menus"
      // would shut it straight away otherwise).
      if (!menu.classList.contains('show')) setTimeout(() => toggle.click(), 0);
    }
  }
  // Tapping a stat box pops its bar out and keeps it there (tap it again,
  // or another box, to change that); the box gets a matching outline.
  function setPopped(index) {
    poppedStat = poppedStat === index ? -1 : index;
    applyPopped();
  }
  function applyPopped() {
    if (!altView) return;
    altView.querySelectorAll('.insights-stat').forEach((box, i) => box.classList.toggle('stat-on', i === poppedStat));
    altView.querySelectorAll('.trend-wrap .trend-chart:not(.trend-leaving) .trend-bar').forEach((bar, i) => bar.classList.toggle('bar-on', i === poppedStat));
  }
  const kindOf = (chart) => chart.classList.contains('trend-mock') ? 'mock' : 'real';
  function growChart(chart) {
    if (!chart || typeof chart.animate !== 'function') return;
    chart.querySelectorAll('.trend-bar').forEach((bar, i) => bar.animate(
      [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }],
      { duration: 700, delay: i * 50, easing: GLIDE, fill: 'backwards' }));
  }
  function updateChart(wrap, fresh) {
    const cur = wrap.querySelector('.trend-chart:not(.trend-leaving)');
    const next = fresh.querySelector('.trend-chart');
    if (!next) return;
    if (!cur) { wrap.appendChild(next); growChart(next); return; }
    // Example <-> real: the same bars morph in one go — each grows or
    // shrinks to its new height while its grey warms into its box's color
    // (or back). Swapping one graph for the other looked like a jump.
    let morph = false;
    if (kindOf(cur) !== kindOf(next)) {
      wrap.querySelectorAll('.trend-leaving').forEach(el => el.remove());
      cur.getAnimations().forEach(a => a.cancel());
      cur.querySelectorAll('.trend-bar').forEach(bar => { bar.getAnimations().forEach(a => a.cancel()); const cs = getComputedStyle(bar); void (cs.backgroundColor + cs.borderColor); });
      const mock = kindOf(next) === 'mock';
      cur.classList.toggle('trend-mock', mock);
      if (mock) cur.setAttribute('aria-hidden', 'true'); else cur.removeAttribute('aria-hidden');
      morph = true;
    }
    {
      const newBars = [...next.querySelectorAll('.trend-bar')];
      cur.querySelectorAll('.trend-bar').forEach((bar, i) => {
        const to = newBars[i] && newBars[i].style.height;
        if (!to || to === bar.style.height) return;
        const from = `${bar.getBoundingClientRect().height}px`;
        bar.style.height = to;
        if (typeof bar.animate === 'function') bar.animate([{ height: from }, { height: to }], morph ? { duration: 900, easing: MODAL_EASE } : { duration: 520, easing: GLIDE });
      });
      applyPopped();
      return;
    }
    // Swap: an earlier one still leaving goes now; this one leaves from
    // wherever it is (even mid-slide), the new one follows it in.
    wrap.querySelectorAll('.trend-leaving').forEach(el => el.remove());
    const fromY = cur.getBoundingClientRect().top - wrap.getBoundingClientRect().top;
    cur.getAnimations().forEach(a => a.cancel());
    cur.classList.add('trend-leaving');
    wrap.appendChild(next);
    if (typeof cur.animate !== 'function') { cur.remove(); return; }
    const h = wrap.clientHeight || 1;
    cur.animate([{ transform: `translateY(${fromY}px)`, opacity: 1 - Math.min(1, fromY / h) }, { transform: 'translateY(105%)', opacity: 0 }],
      { duration: 650, easing: 'cubic-bezier(0.55, 0, 0.45, 1)', fill: 'forwards' })
      .finished.then(() => cur.remove(), () => cur.remove());
    setTimeout(() => cur.remove(), 1100); // never left behind
    next.animate([{ transform: 'translateY(105%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }],
      { duration: 750, delay: 520, easing: GLIDE, fill: 'backwards' });
  }

  // ---------- tab switchers inside the views (changes, stats, results) ----------
  // Worded like the unfollowed / starred submenus' empty lines.
  const CHANGE_EMPTY = {
    lost: 'no accounts have unfollowed you', new: 'no new followers',
    stopped: "no accounts you've stopped following", started: "no accounts you've started following"
  };
  // Every switcher is the same bar, highlight and slide as list 3's own.
  const subNavHtml = (tabs, current) => `<div class="instructions-steps-nav changes-nav">
      <div class="instructions-nav-indicator changes-indicator"></div>
      ${tabs.map(([id, label]) => `<button class="insights-tab${id === current ? ' active' : ''}" data-sub="${id}">${label}</button>`).join('')}
    </div>`;
  // Places the outline on the active tab. On a reload the view is drawn
  // before its tabs have their real size (the font, the layout), which
  // left only the outline's left end showing — so it waits for a measured
  // tab, and re-places itself whenever the tabs change size (also when a
  // hidden switcher shows again).
  function placeSubIndicator(nav, tries = 0) {
    if (!nav || !nav.isConnected) return;
    const active = nav.querySelector('.insights-tab.active');
    if (!active) return;
    const indicator = nav.querySelector('.changes-indicator');
    if (!nav._sizeWatch && window.ResizeObserver) {
      nav._sizeWatch = new ResizeObserver(() => {
        const cur = nav.querySelector('.insights-tab.active');
        if (!cur || !cur.offsetWidth || !nav.isConnected) return;
        const running = indicator._anims && indicator._anims.some(an => an.playState === 'running');
        const pos = indicator._pos;
        if (running || (pos && Math.abs(pos.x - cur.offsetLeft) < 0.5 && Math.abs(pos.w - cur.offsetWidth) < 0.5)) return;
        indicator._pos = null;
        moveInstructionsIndicator(indicator, cur);
      });
      nav.querySelectorAll('.insights-tab').forEach(t => nav._sizeWatch.observe(t));
    }
    if (!active.offsetWidth) {
      if (tries < 30) requestAnimationFrame(() => placeSubIndicator(nav, tries + 1));
      return;
    }
    indicator._pos = null;
    moveInstructionsIndicator(indicator, active);
    const left = active.offsetLeft - 12;
    if (left > 0) nav.scrollLeft = left;
  }
  // Every switcher in the open view.
  function placeChangesIndicator() {
    if (!altView) return;
    altView.querySelectorAll(':scope > .insights-pane:not(.pane-leaving) .changes-nav').forEach(nav => placeSubIndicator(nav));
  }
  // The highlight glides to the tab; a tab near an edge scrolls into view,
  // peeking at the next one (the instructions bar's rule).
  function selectSubTab(nav, id) {
    const tabs = [...nav.querySelectorAll('[data-sub]')];
    const active = tabs.find(t => t.dataset.sub === id);
    if (!active) return;
    tabs.forEach(t => t.classList.toggle('active', t === active));
    moveInstructionsIndicator(nav.querySelector('.changes-indicator'), active);
    const left = active.offsetLeft - 12, right = active.offsetLeft + active.offsetWidth + (active.nextElementSibling ? 38 : 12);
    if (left < nav.scrollLeft) scrollInstructionsNav(nav, Math.max(0, left));
    else if (right > nav.scrollLeft + nav.clientWidth) scrollInstructionsNav(nav, right - nav.clientWidth);
  }
  // Switching: the list you leave slides fully out one side while the new
  // one slides in from the other, like a carousel in tab order (the same
  // push as list 3's views). Tapping again mid-slide carries on from where
  // each list is drawn. `on` is the class that shows a list; a list on its
  // way out is pinned where it was (out of the flow) until it has gone.
  const clearPin = (el) => { el.style.position = el.style.top = el.style.left = el.style.width = el.style.height = ''; };
  function pinAll(host, els) {
    const hr = host.getBoundingClientRect();
    // Screen size to layout size (the guest preview draws the app scaled).
    const k = host.offsetWidth ? hr.width / host.offsetWidth : 1;
    // Measured first, then pinned: pinning one moves the next up.
    const spots = els.map(el => {
      const r = el.getBoundingClientRect();
      return { el, top: (r.top - hr.top) / k - host.clientTop + host.scrollTop, left: (r.left - hr.left) / k - host.clientLeft, width: el.offsetWidth, height: el.offsetHeight };
    });
    spots.forEach(({ el, top, left, width, height }) => Object.assign(el.style, { position: 'absolute', top: `${top}px`, left: `${left}px`, width: `${width}px`, height: `${height}px` }));
  }
  function settleSub(host) {
    clearTimeout(host._subTimer);
    (host._subAll || []).forEach(p => {
      if (!p.classList.contains('pane-out')) return;
      p.getAnimations().forEach(an => an.cancel());
      p.classList.remove('pane-out');
      if (!(host._subTargets || []).includes(p)) p.classList.remove(host._subOn);
      clearPin(p);
    });
  }
  function slideSub(host, all, targets, on, orderOf, dir) {
    const shown = all.filter(p => (p.classList.contains(on) || p.classList.contains('pane-out')) && p.getClientRects().length);
    const at = new Map(shown.map(p => { const cs = getComputedStyle(p); return [p, { x: new DOMMatrixReadOnly(cs.transform).m41 || 0, o: +cs.opacity }]; }));
    shown.forEach(p => p.getAnimations().forEach(an => an.cancel()));
    clearTimeout(host._subTimer);
    host._subAll = all;
    host._subTargets = targets;
    host._subOn = on;
    // Lists for other tabs that aren't on screen right now (list 3 empty,
    // say) are put away too: one left marked as showing came back later,
    // under another tab's list, once it had rows again.
    all.filter(p => !targets.includes(p) && !shown.includes(p) && !p.classList.contains('pane-out')).forEach(p => { p.classList.remove(on); clearPin(p); });
    if (typeof host.animate !== 'function') {
      shown.forEach(p => p.classList.add('pane-out'));
      targets.forEach(t => t.classList.add(on));
      settleSub(host);
      return;
    }
    pinAll(host, shown.filter(p => !targets.includes(p) && !p.classList.contains('pane-out')));
    shown.filter(p => !targets.includes(p)).forEach(p => p.classList.add('pane-out'));
    targets.forEach(t => { t.classList.remove('pane-out'); clearPin(t); t.classList.add(on); });
    const w = host.clientWidth || 320;
    const D = TAB_MOTION.in.duration;
    const timing = (dist) => ({ duration: Math.round(D * Math.min(1, Math.max(0.35, Math.abs(dist) / w))), easing: TAB_MOTION.in.easing });
    let longest = 0;
    targets.filter(t => t.getClientRects().length).forEach(t => {
      const from = at.get(t) || { x: dir * w, o: 0.35 };
      const tIn = timing(from.x);
      longest = Math.max(longest, tIn.duration);
      t.animate([{ transform: `translateX(${from.x}px)`, opacity: from.o }, { transform: 'translateX(0)', opacity: 1 }], tIn);
    });
    const targetOrder = orderOf(targets[0]);
    shown.filter(p => !targets.includes(p)).forEach(p => {
      const f = at.get(p) || { x: 0, o: 1 };
      const to = orderOf(p) < targetOrder ? -w : w; // carousel order
      // Already mostly off the other side: it just fades where it is.
      if (Math.sign(f.x) === -Math.sign(to) && Math.abs(f.x) > 0.4 * w) {
        p.animate([{ transform: `translateX(${f.x}px)`, opacity: f.o }, { transform: `translateX(${f.x}px)`, opacity: 0 }], { duration: 90, fill: 'forwards' });
        return;
      }
      const t = timing(to - f.x);
      longest = Math.max(longest, t.duration);
      p.animate([{ transform: `translateX(${f.x}px)`, opacity: f.o }, { transform: `translateX(${to}px)`, opacity: 0.35 }], { ...t, fill: 'forwards' });
    });
    host._subTimer = setTimeout(() => settleSub(host), longest + 30);
    viewGate.until = Math.max(viewGate.until || 0, performance.now() + longest * SLIDE_WAIT);
  }

  // The switchers inside the changes and stats views.
  function showAltSub(id) {
    queueSwitch(viewGate, () => switchAltSub(id));
  }
  function switchAltSub(id) {
    const view = currentView;
    const tabs = SUB_TABS[view];
    const live = altView && altView.querySelector(':scope > .insights-pane:not(.pane-leaving)');
    const nav = live && live.querySelector(':scope > .changes-nav');
    if (!tabs || !nav || subTab[view] === id || !tabs.some(t => t[0] === id)) return;
    const order = tabs.map(t => t[0]);
    const dir = order.indexOf(id) > order.indexOf(subTab[view]) ? 1 : -1;
    subTab[view] = id;
    if (view === 'stats') { try { localStorage.setItem('stats_sub', id); } catch (e) {} }
    selectSubTab(nav, id);
    const all = [...live.querySelectorAll(':scope > .changes-pane')];
    const target = all.find(p => p.dataset.pane === id);
    slideSub(altView, all, [target], 'active', p => order.indexOf(p.dataset.pane), dir);
    centerSoon();
    if (id === 'timeline') drawTimeline(target);
  }

  // ---------- empty texts: centered in list 3's whole box ----------
  // A tab's "no …" text fills its own list's space (so it's clipped with it
  // and slides with it) and is moved up by exactly as much as puts it in
  // the middle of the whole box, switcher included. The amount only
  // depends on the switcher's height, so it's known before a tab shows
  // (no jump on its first frame). Stretching the text over the whole box
  // instead left it showing outside its list mid-slide on iPhone.
  function centerEmpties() {
    const box = document.querySelector('#card-unfollowers .results-container');
    if (!box || !viewNav || !viewNav.offsetHeight) return;
    // Every switcher is the same bar as list 3's own (always on screen),
    // 8px in from the box's top: results' lists start 4px under it, the
    // views' 12px (and end 12px above the box's bottom).
    const h = viewNav.offsetHeight;
    box.style.setProperty('--extra-shift', `${-(8 + h + 4) / 2}px`);
    box.style.setProperty('--pane-shift', `${-(h + 8) / 2}px`);
  }
  const centerSoon = () => requestAnimationFrame(() => safe(centerEmpties, 'empty texts'));

  // ---------- results: its own switcher ----------
  // Unfollowers (list 3 itself) and the export's other lists: requests you
  // sent that are still pending, close friends, blocked, restricted. The
  // switcher sits at the top of list 3's box; the lists slide under it.
  let resultsSubnav = null;
  const extraPanes = {};
  const EXTRA_TEXT = {
    pending: { sub: '', empty: 'no pending requests', missing: 'requests you sent that are still pending' },
    closeFriends: { sub: '', empty: 'no close friends', missing: 'close friends' },
    blocked: { sub: '', empty: 'no blocked accounts', missing: 'blocked accounts' },
    restricted: { sub: '', empty: 'no restricted accounts', missing: 'restricted accounts' }
  };
  const extraListsNow = () => readExtraLists(state.selectedAccountUsername);
  const mainPanes = () => [document.getElementById('unfollowers-empty-state'), elements.listUnfollowers].filter(Boolean);
  const resultsPanes = () => [...mainPanes(), ...Object.values(extraPanes)];
  const resultsSubOf = (el) => el.classList.contains('results-extra') ? el.dataset.sub : 'unfollowers';
  // What's showing for the results view (to slide it as one when switching
  // views): the switcher and the list it's on.
  const resultsEls = () => (resultsSubnav
    ? [resultsSubnav, ...resultsPanes()].filter(el => !el.classList.contains('hidden') && (el === resultsSubnav || el.classList.contains('sub-on') || el.classList.contains('pane-out')))
    : mainPanes().filter(el => !el.classList.contains('hidden')));
  function buildResultsSwitcher() {
    const box = document.querySelector('#card-unfollowers .results-container');
    if (!box || resultsSubnav) return;
    resultsSubnav = document.createElement('div');
    resultsSubnav.className = 'results-subnav';
    resultsSubnav.innerHTML = subNavHtml(SUB_TABS.results, subTab.results);
    box.insertBefore(resultsSubnav, box.firstChild);
    SUB_TABS.results.slice(1).forEach(([id]) => {
      const pane = document.createElement('div');
      pane.className = 'results-extra';
      pane.dataset.sub = id;
      box.insertBefore(pane, altView && altView.parentNode === box ? altView : null);
      extraPanes[id] = pane;
    });
    box.classList.add('has-sub');
    box.classList.toggle('sub-extra', subTab.results !== 'unfollowers');
    mainPanes().forEach(el => el.classList.toggle('sub-on', subTab.results === 'unfollowers'));
    if (extraPanes[subTab.results]) extraPanes[subTab.results].classList.add('sub-on');
    renderExtras(false);
    resultsSubnav.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-sub]');
      if (!tab) return;
      e.stopPropagation();
      showResultsSub(tab.dataset.sub);
    });
    // A pending request's X: it slides off the list like a list 3 row.
    box.addEventListener('click', (e) => {
      const mv = e.target.closest('.results-extra[data-sub="pending"] .user-row .action-star, .results-extra[data-sub="pending"] .user-row .action-delete');
      if (mv) {
        e.stopPropagation();
        const row = mv.closest('.user-row');
        if (!row || row.classList.contains('username-exit')) return;
        movePending([row.dataset.username], mv.classList.contains('action-star') ? 'star' : 'unfollow', row);
        return;
      }
      const x = e.target.closest('.results-extra .user-row .action-dismiss');
      if (!x) return;
      e.stopPropagation();
      const row = x.closest('.user-row');
      if (!row || row.classList.contains('username-exit')) return;
      removeExtra(x.closest('.results-extra').dataset.sub, row.dataset.username, row);
    });
    const nav = resultsSubnav.querySelector('.changes-nav');
    requestAnimationFrame(() => placeSubIndicator(nav));
    if (window.ResizeObserver) new ResizeObserver(centerSoon).observe(box);
    centerEmpties();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => placeSubIndicator(nav));
  }
  function showResultsSub(id) {
    if (!resultsSubnav) return;
    queueSwitch(viewGate, () => switchResultsSub(id));
  }
  function switchResultsSub(id) {
    if (!resultsSubnav || subTab.results === id || !SUB_TABS.results.some(t => t[0] === id)) return;
    const order = SUB_TABS.results.map(t => t[0]);
    const dir = order.indexOf(id) > order.indexOf(subTab.results) ? 1 : -1;
    subTab.results = id;
    try { localStorage.setItem('results_sub', id); } catch (e) {}
    if (selectMode) setSelectMode(false); // select is per tab
    selectSubTab(resultsSubnav.querySelector('.changes-nav'), id);
    const box = resultsSubnav.parentNode;
    box.classList.toggle('sub-extra', id !== 'unfollowers');
    const targets = id === 'unfollowers' ? mainPanes() : [extraPanes[id]];
    slideSub(box, resultsPanes(), targets, 'sub-on', el => order.indexOf(resultsSubOf(el)), dir);
    refreshToolbar();
    centerSoon();
  }
  // Pending requests are drawn like list 3's own rows (the avatar, the
  // username, the box), with the arrow (opens the profile, to cancel it
  // there) and the X (takes it off the list once you have).
  const X_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
  const ARROW_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>';
  const pendingRowsHtml = (users, empty, noteOf) => boxRowsHtml(users, empty, noteOf, true);
  // Straight to a results tab, no slide (for when the results aren't on
  // screen). The highlight is re-placed once the switcher shows again.
  function jumpResultsSub(id) {
    if (!resultsSubnav || subTab.results === id) return;
    subTab.results = id;
    try { localStorage.setItem('results_sub', id); } catch (e) {}
    const box = resultsSubnav.parentNode;
    settleSub(box);
    resultsSubnav.querySelectorAll('[data-sub]').forEach(t => t.classList.toggle('active', t.dataset.sub === id));
    const ind = resultsSubnav.querySelector('.changes-indicator');
    if (ind) ind._pos = null;
    box.classList.toggle('sub-extra', id !== 'unfollowers');
    resultsPanes().forEach(p => { p.classList.remove('pane-out'); clearPin(p); p.classList.toggle('sub-on', p.classList.contains('results-extra') ? p.dataset.sub === id : id === 'unfollowers'); });
    refreshToolbar();
  }
  function extraContent(id) {
    const text = EXTRA_TEXT[id];
    const list = extraListsNow()[id];
    if (!Array.isArray(list)) {
      return { sub: '', body: `<div class="dropdown-empty-message">${text.empty}</div>` };
    }
    let users = list;
    let flagOf = null;
    if (id === 'closeFriends' && state.followers.length) {
      const f = followersSet();
      users = [...list.filter(u => !f.has(u.username)), ...list.filter(u => f.has(u.username))];
      flagOf = (u) => (f.has(u.username) ? '' : "doesn't follow you back");
    }
    if (id === 'pending') return { sub: text.sub, body: boxRowsHtml(users, text.empty, flagOf, 'pending') };
    return { sub: text.sub, body: pendingRowsHtml(users, text.empty, flagOf) };
  }
  // A list's content changed (an account picked, files imported): like list
  // 3's views, the old goes like the instructions window closes and the new
  // comes in like it opens; the line on top stays put.
  function renderExtra(id, animate) {
    const pane = extraPanes[id];
    if (!pane) return;
    const { sub, body } = extraContent(id);
    const sig = `${sub}|${body}`;
    if (pane._sig === sig) return;
    pane._sig = sig;
    const old = pane.querySelector(':scope > .extra-body:not(.extra-leaving)');
    const fresh = document.createElement('div');
    fresh.className = 'extra-body';
    fresh.innerHTML = `${sub ? `<div class="insights-sub">${esc(sub)}</div>` : ''}${body}`;
    pane.querySelectorAll(':scope > .extra-leaving').forEach(el => el.remove());
    const showing = animate && !pageLoading && old && pane.classList.contains('sub-on') && pane.getClientRects().length && typeof old.animate === 'function';
    if (!showing) {
      if (old) old.remove();
      pane.appendChild(fresh);
      return;
    }
    swapPendingRows(pane, old, fresh); return;
    const scroll = old.scrollTop;
    old.classList.add('extra-leaving');
    old.scrollTop = scroll;
    const oldSub = old.querySelector(':scope > .insights-sub');
    const keepSub = oldSub && oldSub.textContent === sub;
    if (keepSub) oldSub.style.visibility = 'hidden';
    old.querySelectorAll('.dropdown-empty-message').forEach(m => { fadeGhostOut(m); m.style.visibility = 'hidden'; });
    pane.appendChild(fresh);
    const drop = () => old.remove();
    old.animate(MODAL_OUT, LEAVE).finished.then(drop, drop);
    setTimeout(drop, LEAVE.duration + 400);
    [...fresh.children].filter(el => !(keepSub && el.matches('.insights-sub')))
      .forEach(el => (el.matches('.dropdown-empty-message') ? fadeEmptyIn(el, LEAVE.duration)
        : el.animate(MODAL_IN, { duration: 450, easing: MODAL_EASE, delay: LEAVE.duration, fill: 'backwards' })));
  }
  // Pending requests change like list 3's rows (an account picked, files
  // imported): the boxes on screen slide out, the new ones slide in, each
  // with list 3's own row slide (script.js's row engine).
  function swapPendingRows(pane, old, fresh) {
    // Exactly list 3's own row motion: usernames that stay keep their box
    // and glide to their new spot, gone ones slide out one by one where
    // they were, new ones slide in — the list as a whole never swaps.
    const before = { rows: new Map(), tops: new Map() };
    old.querySelectorAll('.pending-list > .user-row:not(.username-exit)').forEach(r => {
      stopRowMotion(r);
      const rect = r.getBoundingClientRect();
      before.tops.set(r.dataset.username, rect.top);
      before.rows.set(r, { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width, pitch: r.offsetHeight + (parseFloat(getComputedStyle(r).marginBottom) || 0) });
    });
    const ghosts = [...old.querySelectorAll('.dropdown-empty-message')].map(m => captureGhost(m)).filter(Boolean);
    old.replaceWith(fresh);
    const list = fresh.querySelector('.pending-list');
    if (!list) ghosts.length = 0; // still empty: the text stays as it is
    ghosts.forEach(play => play());
    const left = pinRowsOut(list || fresh, before.rows, list);
    if (list) animateResultsReentry(list, before.tops);
    const msg = fresh.querySelector('.dropdown-empty-message');
    if (msg && left) fadeEmptyIn(msg, ROW_MOTION_MS);
    stepRowMotion();
  }
  // Rows that aren't in `list` any more slide out where they were drawn,
  // laid over `host` (the list itself, or its pane once the list is gone).
  function pinRowsOut(host, rows, list) {
    const stay = new Set(list ? [...list.querySelectorAll(':scope > .user-row')].map(r => r.dataset.username) : []);
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const hr = host.getBoundingClientRect();
    const k = host.offsetWidth ? hr.width / host.offsetWidth : 1;
    const margin = window.innerHeight || 800;
    let n = 0;
    rows.forEach((rect, r) => {
      if (stay.has(r.dataset.username) || rect.bottom < -margin || rect.top > window.innerHeight + margin) return;
      Object.assign(r.style, { position: 'absolute', top: `${(rect.top - hr.top) / k - host.clientTop + host.scrollTop}px`, left: `${(rect.left - hr.left) / k - host.clientLeft}px`, width: `${rect.width / k}px`, margin: '0', zIndex: '1' });
      r.classList.add('username-exit');
      host.appendChild(r);
      slideRowOut(r, rect.pitch, ROW_MOTION_MS, () => r.remove());
      n++;
    });
    return n;
  }
  function renderExtras(animate = true) {
    Object.keys(extraPanes).forEach(id => renderExtra(id, animate));
    centerSoon();
  }
  // Its X tapped (cancelled on Instagram): it slides out like a list 3 row.
  function removeExtra(kind, name, row) {
    const acc = state.selectedAccountUsername;
    const lists = readExtraLists(acc);
    const before = Array.isArray(lists[kind]) ? lists[kind].slice() : [];
    if (!before.some(u => u.username === name)) return;
    lists[kind] = before.filter(u => u.username !== name);
    writeExtraLists(acc, lists);
    pushToCloud();
    const done = () => {
      // Still that account on screen: the list is already right (the row
      // has gone), unless it's now empty — then the empty text comes in.
      if ((state.selectedAccountUsername || '') !== (acc || '')) return;
      if (lists[kind].length) extraPanes[kind]._sig = (({ sub, body }) => `${sub}|${body}`)(extraContent(kind));
      else renderExtra(kind, true);
    };
    exitListRow(row, done);
  }
  // Pending requests starred or marked unfollowed (a row's buttons or the
  // bulk bar): they leave the pending list and go to that submenu, like
  // list 3's rows do. Undoable.
  function movePending(names, kind, row) {
    const acc = state.selectedAccountUsername;
    const lists = readExtraLists(acc);
    const before = Array.isArray(lists.pending) ? lists.pending.slice() : [];
    const pick = new Set(names);
    const users = before.filter(u => pick.has(u.username));
    if (!users.length) return;
    const snap = { ...snapshot(), pending: before };
    const tag = accKey();
    const target = kind === 'star' ? state.starred : state.unfollowed;
    const have = new Set(target.map(u => u.username));
    users.forEach(u => { if (!have.has(u.username)) target.unshift({ ...cleanExtraEntry(u), account: tag }); });
    lists.pending = before.filter(u => !pick.has(u.username));
    writeExtraLists(acc, lists);
    saveCurrentAccountData();
    const done = () => {
      if (kind === 'star') updateStarredUI(users[0].username); else updateUnfollowedUI(users[0].username);
      if ((state.selectedAccountUsername || '') !== (acc || '')) return;
      if (row && lists.pending.length) extraPanes.pending._sig = (({ sub, body }) => `${sub}|${body}`)(extraContent('pending'));
      else renderExtra('pending', true);
    };
    if (row) exitListRow(row, done); else done();
    pushToCloud();
    offerUndo(snap, `${users.length === 1 ? `@${users[0].originalUsername || users[0].username}` : plural(users.length, 'account')} ${kind === 'star' ? 'starred' : 'unfollowed'}`);
  }
  // The lists came in from an import (script.js).
  extraListsChanged = function () {
    safe(() => renderExtras(true), 'extra lists');
    safe(refreshView, 'view');
  };
  // Pending requests used to be merged into list 1 (so they showed as not
  // following you back): moved into their own list, for this account.
  function movePendingOut() {
    if (!state.following.some(u => u && u.isPendingRequest)) return false;
    const moved = state.following.filter(u => u.isPendingRequest).map(cleanExtraEntry);
    state.following = state.following.filter(u => !u.isPendingRequest);
    const acc = state.selectedAccountUsername;
    const lists = readExtraLists(acc);
    const have = new Set((lists.pending || []).map(u => u.username));
    lists.pending = [...(lists.pending || []), ...moved.filter(u => !have.has(u.username))];
    writeExtraLists(acc, lists);
    storageSet(listStorageKey('following'), JSON.stringify(state.following));
    elements.inputFollowing.value = state.following.map(u => `@${u.originalUsername}`).join('\n');
    return true;
  }

  const EXPORT_LISTS = [
    ['list3', "list 3 · don't follow you back"], ['unfollowed', 'unfollowed'], ['starred', 'starred'],
    ['following', 'list 1 · following'], ['followers', 'list 2 · followers'], ['mutuals', 'mutuals'], ['fans', 'fans'],
    ['pending', 'pending requests'], ['closeFriends', 'close friends'], ['blocked', 'blocked'], ['restricted', 'restricted']
  ];
  function listFor(kind) {
    if (kind === 'following') return state.following;
    if (kind === 'followers') return state.followers;
    if (kind === 'list3') return state.unfollowers;
    if (kind === 'unfollowed') return state.unfollowed;
    if (kind === 'starred') return state.starred;
    if (kind === 'mutuals') { const f = followersSet(); return state.following.filter(u => f.has(u.username)); }
    if (kind === 'fans') { const f = followingSet(); return state.followers.filter(u => !f.has(u.username)); }
    if (EXTRA_TEXT[kind]) { const list = extraListsNow()[kind]; return Array.isArray(list) ? list : []; }
    return [];
  }
  function saveFile(name, blob) {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
      return navigator.share({ files: [file] }).catch(() => {});
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  // One list: its own file. Several: one file with a 'list' column.
  function exportCsv(kinds) {
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const multi = kinds.length > 1;
    const head = ['username', 'full name', 'followed', 'profile'];
    const rows = [multi ? ['list'].concat(head) : head];
    kinds.forEach(kind => {
      const name = (EXPORT_LISTS.find(x => x[0] === kind) || [kind, kind])[1];
      listFor(kind).forEach(u => {
        const t = timeOf(u);
        const row = [u.originalUsername || u.username, u.fullName || '', t ? new Date(t).toISOString().slice(0, 10) : '', safeProfileUrl(u)];
        rows.push(multi ? [name].concat(row) : row);
      });
    });
    const file = multi ? 'ig-checker-lists.csv' : `ig-checker-${kinds[0]}.csv`;
    saveFile(file, new Blob([rows.map(r => r.map(cell).join(',')).join('\n')], { type: 'text/csv' }));
  }

  let exportOverlay = null;
  function openExport() {
    if (!exportOverlay) {
      exportOverlay = document.createElement('div');
      exportOverlay.className = 'modal-overlay hidden export-overlay';
      exportOverlay.innerHTML = `
        <div class="account-modal-card glass export-card">
          <div class="account-modal-header"><h3>export</h3></div>
          <div class="insights-sub">choose the lists you want to download as a spreadsheet (csv), and the stats image if you want it</div>
          <div class="export-options"></div>
          <button class="export-option export-image" data-exp="image">
            <span class="export-check"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>
            <span class="export-label">stats image</span>
            <span class="export-count">png</span>
          </button>
          <div class="account-modal-actions">
            <button class="btn btn-secondary" data-exp="cancel">cancel</button>
            <button class="btn btn-primary" data-exp="go">export</button>
          </div>
        </div>`;
      document.body.appendChild(exportOverlay);
      exportOverlay.addEventListener('click', (e) => {
        if (e.target === exportOverlay || e.target.closest('[data-exp="cancel"]')) return closeExport();
        if (e.target.closest('[data-exp="go"]')) {
          // The stats image is ticked like a list and saved only now.
          const kinds = [...exportOverlay.querySelectorAll('.export-option.on[data-kind]')].map(o => o.dataset.kind);
          const image = exportOverlay.querySelector('.export-image').classList.contains('on');
          if (!kinds.length && !image) return;
          if (kinds.length) exportCsv(kinds);
          if (image) safe(() => { statsImage().then(blob => blob && saveFile('ig-stats.png', blob)).catch(err => console.error('[features] stats image failed:', err)); }, 'stats image');
          closeExport();
          return;
        }
        const opt = e.target.closest('.export-option');
        if (opt) { opt.classList.toggle('on'); updateExportButton(); }
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !exportOverlay.classList.contains('hidden')) closeExport(); });
    }
    // The export's other lists only once they've been imported.
    const lists = extraListsNow();
    exportOverlay.querySelector('.export-options').innerHTML = EXPORT_LISTS.filter(([kind]) => !EXTRA_TEXT[kind] || Array.isArray(lists[kind])).map(([kind, label], i) => `
      <button class="export-option${i === 0 ? ' on' : ''}" data-kind="${kind}">
        <span class="export-check"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>
        <span class="export-label">${esc(label)}</span>
        <span class="export-count">${listFor(kind).length}</span>
      </button>`).join('');
    exportOverlay.querySelector('.export-image').classList.remove('on');
    updateExportButton();
    showModalOverlay(exportOverlay);
    lockPageScroll();
  }
  // ---------- stats image (export window) ----------
  // A picture of the stats view to share: the six numbers in their colors
  // and the graph, in the app's current theme. No usernames in it.
  const hexA = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  };
  function roundRect(ctx, x, y, w, h, r) {
    const rr = typeof r === 'number' ? [r, r, r, r] : r;
    ctx.beginPath();
    ctx.moveTo(x + rr[0], y);
    ctx.lineTo(x + w - rr[1], y); ctx.quadraticCurveTo(x + w, y, x + w, y + rr[1]);
    ctx.lineTo(x + w, y + h - rr[2]); ctx.quadraticCurveTo(x + w, y + h, x + w - rr[2], y + h);
    ctx.lineTo(x + rr[3], y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - rr[3]);
    ctx.lineTo(x, y + rr[0]); ctx.quadraticCurveTo(x, y, x + rr[0], y);
    ctx.closePath();
  }
  async function statsImage() {
    const W = 1080, H = 1350, P = 72;
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const C = dark
      ? { bg: '#09090b', text: '#fafafa', muted: '#a1a1aa' }
      : { bg: '#ffffff', text: '#09090b', muted: '#71717a' };
    const body = getComputedStyle(document.body).fontFamily || 'sans-serif';
    const display = `'Outfit', ${body}`;
    try { if (document.fonts) await Promise.all([document.fonts.load(`800 80px 'Outfit'`), document.fonts.load(`500 30px ${body}`)]); } catch (e) {}
    const following = state.following.length, followers = state.followers.length;
    const fset = followersSet();
    const mutual = state.following.filter(u => fset.has(u.username)).length;
    const ratio = following ? Math.round((mutual / following) * 100) : 0;
    const counts = [following, followers, null, state.unfollowers.length, state.unfollowed.length, state.starred.length];
    const values = [following, followers, `${ratio}%`, state.unfollowers.length, state.unfollowed.length, state.starred.length];
    const labels = ['following', 'followers', 'follow you back', "don't follow you back", 'unfollowed', 'starred'];
    const maxCount = Math.max(1, ...counts.filter(c => c !== null));
    const heights = counts.map(c => (c === null ? Math.max(4, ratio) : Math.max(4, Math.round((Math.log1p(c) / Math.log1p(maxCount)) * 100))));

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.text;
    ctx.font = `800 68px ${display}`;
    ctx.fillText('my instagram stats', P, P + 60);
    ctx.fillStyle = C.muted;
    ctx.font = `500 30px ${body}`;
    ctx.fillText(new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }), P, P + 112);

    // The six boxes, three to a row.
    const gap = 20, top = P + 170, bw = (W - P * 2 - gap * 2) / 3, bh = 190;
    ctx.textAlign = 'center';
    values.forEach((v, i) => {
      const x = P + (i % 3) * (bw + gap), y = top + Math.floor(i / 3) * (bh + gap);
      roundRect(ctx, x, y, bw, bh, 26);
      ctx.fillStyle = hexA(STAT_COLORS[i], dark ? 0.12 : 0.07);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = hexA(STAT_COLORS[i], 0.7);
      ctx.stroke();
      ctx.fillStyle = C.text;
      ctx.font = `800 64px ${display}`;
      ctx.fillText(String(v), x + bw / 2, y + 102);
      ctx.fillStyle = C.muted;
      ctx.font = `500 25px ${body}`;
      ctx.fillText(labels[i], x + bw / 2, y + 146);
    });

    // The graph: a bar per box, in its color.
    const gTop = top + bh * 2 + gap + 70, gBottom = H - P - 70, gh = gBottom - gTop;
    const barGap = 22, barW = (W - P * 2 - barGap * 5) / 6;
    heights.forEach((h, i) => {
      const bhh = Math.max(10, gh * h / 100), x = P + i * (barW + barGap), y = gBottom - bhh;
      const r = Math.min(18, bhh, barW / 2);
      roundRect(ctx, x, y, barW, bhh, [r, r, 0, 0]);
      ctx.fillStyle = hexA(STAT_COLORS[i], 0.26);
      ctx.fill();
      // Outlined like the app's bars: the top and sides, open at the bottom.
      ctx.beginPath();
      ctx.moveTo(x, gBottom);
      ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.lineTo(x + barW - r, y); ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
      ctx.lineTo(x + barW, gBottom);
      ctx.lineWidth = 3;
      ctx.strokeStyle = hexA(STAT_COLORS[i], 0.7);
      ctx.stroke();
    });

    ctx.fillStyle = C.muted;
    ctx.font = `500 24px ${body}`;
    ctx.fillText((document.title || 'instagram follower checker').toLowerCase(), W / 2, H - P + 10);
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  }

  function updateExportButton() {
    const lists = exportOverlay.querySelectorAll('.export-option.on[data-kind]').length;
    const image = exportOverlay.querySelector('.export-image').classList.contains('on');
    const go = exportOverlay.querySelector('[data-exp="go"]');
    go.disabled = lists === 0 && !image;
    go.textContent = lists > 1 ? `export ${lists} lists${image ? ' + image' : ''}` : 'export';
  }
  function closeExport() {
    exportOverlay.classList.remove('show');
    unlockPageScroll();
    scheduleOverlayHide(exportOverlay, () => exportOverlay.classList.add('hidden'));
  }

  // An export icon in every list's search row (the search box shrinks to
  // make room): lists 1 and 2 download themselves, list 3 opens the window.
  const EXPORT_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';
  function makeIconButton(id, title) {
    const info = document.getElementById('btn-instructions-info');
    const btn = info.cloneNode(false);
    btn.id = id;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = EXPORT_ICON;
    return btn;
  }
  function buildExportButtons() {
    const info = document.getElementById('btn-instructions-info');
    if (!info || document.getElementById('btn-export-list3')) return;
    const b3 = makeIconButton('btn-export-list3', 'export lists');
    info.parentNode.insertBefore(b3, info);
    b3.addEventListener('click', (e) => { e.stopPropagation(); openExport(); });
    [['search-following', 'following', 'export list 1'], ['search-followers', 'followers', 'export list 2']].forEach(([inputId, kind, title]) => {
      const box = document.getElementById(inputId)?.closest('.search-box');
      if (!box) return;
      const row = document.createElement('div');
      row.className = 'list-search-row';
      box.parentNode.insertBefore(row, box);
      row.appendChild(box);
      const btn = makeIconButton(`btn-export-${kind}`, title);
      // The button keeps its full size and outline; this wrapper opens and
      // closes around it (see .export-wrap in style.css).
      const wrap = document.createElement('span');
      wrap.className = 'export-wrap';
      wrap.appendChild(btn);
      row.appendChild(wrap);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!listFor(kind).length) return;
        exportCsv([kind]);
      });
    });
    refreshListExports(false);
  }

  // Lists 1/2: the export button only shows while its text box has
  // something in it; the search box eases wider/narrower as it comes and
  // goes (style.css, .export-off).
  function refreshListExports(animate = true) {
    [['following', elements.inputFollowing], ['followers', elements.inputFollowers]].forEach(([kind, ta]) => {
      const btn = document.getElementById(`btn-export-${kind}`);
      if (!btn || !ta) return;
      const off = ta.value.trim() === '';
      if (btn.classList.contains('export-off') === off) return;
      const wrap = btn.parentElement;
      if (!animate) { btn.classList.add('no-anim'); wrap.classList.add('no-anim'); }
      btn.classList.toggle('export-off', off);
      wrap.classList.toggle('export-off', off);
      btn.tabIndex = off ? -1 : 0;
      if (!animate) { void btn.offsetWidth; btn.classList.remove('no-anim'); wrap.classList.remove('no-anim'); }
    });
  }
  // updateListUI runs whenever list 1 or 2 changes (typing, import,
  // switching accounts, clearing).
  const baseUpdateListUI = updateListUI;
  updateListUI = function (type) {
    const moved = type === 'following' && safe(movePendingOut, 'pending requests');
    const result = baseUpdateListUI.call(this, type);
    if (moved) setTimeout(() => calculateUnfollowers({ animate: true }), 0);
    safe(refreshListExports, 'list export');
    return result;
  };
  [elements.inputFollowing, elements.inputFollowers].forEach(ta => ta && ta.addEventListener('input', () => refreshListExports()));
  // ---------- installable app ----------
  function setupInstall() {
    if (!document.querySelector('link[rel="manifest"]')) {
      const link = document.createElement('link');
      link.rel = 'manifest'; link.href = 'manifest.json';
      document.head.appendChild(link);
    }
    const native = window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform();
    if (!native && 'serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  // List 3's search row, in order: search, undo, export, info.
  function arrangeList3Buttons() {
    const row = document.querySelector('#card-unfollowers .search-row');
    const search = row && row.querySelector('.search-box');
    if (!row || !search) return;
    let after = search;
    ['btn-undo', 'btn-export-list3', 'btn-instructions-info'].forEach(id => {
      const btn = document.getElementById(id);
      if (!btn) return;
      row.insertBefore(btn, after.nextSibling);
      after = btn;
    });
  }

  // The daily unfollow tally and the notes were removed: clear what they
  // left on the device.
  function clearOldTally() {
    try {
      Object.keys(localStorage).forEach(k => { if (k === 'unfollow_tally' || k === 'user_notes' || k.startsWith('unfollow_count_')) localStorage.removeItem(k); });
    } catch (e) {}
  }

  // Tab bars too narrow for all their tabs scroll sideways. On desktop that
  // just looked like a tab cut off mid-word, so the edge that has more
  // tabs past it fades out (.fade-left / .fade-right, see style.css), and
  // a mouse wheel over the bar scrolls it sideways (there's no swipe).
  function setupNavOverflow() {
    const NAV = '.instructions-steps-nav';
    const update = nav => {
      const max = nav.scrollWidth - nav.clientWidth;
      nav.classList.toggle('fade-left', max > 1 && nav.scrollLeft > 1);
      nav.classList.toggle('fade-right', max > 1 && nav.scrollLeft < max - 1);
    };
    let queued = false;
    const updateAll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; document.querySelectorAll(NAV).forEach(update); });
    };
    document.addEventListener('scroll', e => { if (e.target.matches && e.target.matches(NAV)) update(e.target); }, true);
    document.addEventListener('wheel', e => {
      const nav = e.target.closest && e.target.closest(NAV);
      if (!nav || e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      const max = nav.scrollWidth - nav.clientWidth;
      if (max <= 1) return;
      e.preventDefault();
      nav.scrollLeft = Math.max(0, Math.min(max, nav.scrollLeft + e.deltaY));
    }, { passive: false });
    window.addEventListener('resize', updateAll);
    // Bars are built, re-filled and shown/hidden as views change.
    new MutationObserver(updateAll).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(updateAll);
    updateAll();
  }

  function init() {
    // Each part on its own: one failing can't take the rest (or the app)
    // down with it.
    safe(clearOldTally, 'cleanup');
    safe(setupNavOverflow, 'tab bars');
    safe(setupSavedImports, 'saved imports');
    safe(buildToolbar, 'toolbar');
    safe(buildViewSwitcher, 'views');
    safe(buildResultsSwitcher, 'results tabs');
    safe(buildExportButtons, 'export');
    safe(buildUndoButton, 'undo');
    safe(arrangeList3Buttons, 'buttons');
    safe(setupInstall, 'install');
    safe(refreshToolbar, 'toolbar');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // For the rest of the app (and tests).
  window.igFeatures = { showView, showToast, setSelectMode, refreshToolbar, centerEmpties: () => safe(centerEmpties, 'empty texts') };
})();
