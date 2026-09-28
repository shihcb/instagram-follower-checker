// -------------------------------------------------------------
// Extra features, layered on top of script.js (loaded after it):
//  - changes since your last import (+ a toast after importing)
//  - how long ago you followed each account, and sort by it
//  - list 3 views: changes, stats with a trend, mutuals, fans, compare,
//  - export (CSV)
//  - undo after unfollowing / starring / removing
//  - select several rows and act on them at once
//  - notes and tags per username (long-press or right-click a row)
//  - daily unfollow counter with a warning
//  - re-import reminder, installable app (manifest + service worker)
// Everything reuses the app's own styles and motion: list 3's row slides,
// the popup window style, the instructions tab highlight, list 3 easing.
// -------------------------------------------------------------
(() => {
  const EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
  const DAY = 24 * 60 * 60 * 1000;

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

  // ---------- data ----------
  const getNotes = () => readJSON('user_notes', {});
  const setNotes = (notes) => { writeJSON('user_notes', notes); pushToCloud(); };
  // One read per render of list 3, not one per row.
  let notesMemo = null;
  const notesForRender = () => {
    if (!notesMemo) { notesMemo = getNotes(); setTimeout(() => { notesMemo = null; }, 0); }
    return notesMemo;
  };
  // ---------- today's unfollow tally ----------
  // Every account unfollowed today (from list 3, the starred menu, several
  // at once), kept as "account:username" so an undo can take exactly that
  // one back off. Your own calendar day (not UTC's): it starts again at
  // midnight. Saved on the device and in the cloud with the rest.
  const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const readTally = () => {
    const t = readJSON('unfollow_tally', null);
    return t && t.date === localDay() && Array.isArray(t.names) ? t.names : [];
  };
  // `updated` lets the cloud copy and this device's settle on the latest.
  const writeTally = (names) => { writeJSON('unfollow_tally', { date: localDay(), names, updated: Date.now() }); pushToCloud(); refreshToolbar(); };
  const getToday = () => readTally().length;
  function tallyAdd(usernames) {
    const acc = accKey();
    if (acc === DEMO_ID || !usernames.length) return;
    const names = readTally();
    usernames.forEach(u => { const id = `${acc}:${u}`; if (!names.includes(id)) names.push(id); });
    writeTally(names);
  }
  // Back to list 3 (the x in the unfollowed menu) or moved to starred: no
  // longer unfollowed, so it comes off today's count.
  function tallyRemove(usernames) {
    const acc = accKey();
    const drop = new Set(usernames.map(u => `${acc}:${u}`));
    const names = readTally();
    const kept = names.filter(id => !drop.has(id));
    if (kept.length !== names.length) writeTally(kept);
  }
  // Undo: this account's part of the count goes back to exactly what it was
  // before that step (an undone unfollow comes off, an undone "back to list
  // 3" goes back on); other accounts' are left alone.
  function tallyUndo(snap) {
    if (!snap.tally) return;
    const mine = (id) => id.startsWith(`${snap.acc}:`);
    const names = readTally();
    const next = names.filter(id => !mine(id)).concat(snap.tally.filter(mine));
    if (next.length !== names.length || next.some(id => !names.includes(id))) writeTally(next);
  }
  // Midnight: the tally starts over even with the page left open.
  (function atMidnight() {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
    setTimeout(() => { refreshToolbar(); atMidnight(); }, next - now);
  })();

  let sortMode = 'default'; // 'default' | 'oldest' | 'newest'
  try { sortMode = localStorage.getItem('list3_sort') || 'default'; } catch (e) {}

  const timeOf = (u) => {
    if (!u || !u.timestamp) return null;
    const t = new Date(u.timestamp).getTime();
    return Number.isFinite(t) ? t : null;
  };
  const ago = (t) => {
    const d = Math.max(0, Date.now() - t) / DAY;
    if (d < 1) return 'today';
    if (d < 30) return plural(Math.floor(d), 'day');
    if (d < 365) return plural(Math.floor(d / 30), 'month');
    return plural(Math.floor(d / 365), 'year');
  };

  // ---------- list 3: sorting ----------
  // Every path that changes list 3 ends in updateResultsUI, so the sort is
  // applied right there.
  const baseUpdateResultsUI = updateResultsUI;
  updateResultsUI = function (opts) {
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
    refreshUndo(); // the steps belong to the account on screen
    const result = baseUpdateResultsUI.call(this, opts);
    keepSelection();
    refreshToolbar();
    refreshView();
    return result;
  };

  // Rows: how long ago you followed them, your note and tags.
  const baseRowHtml = renderUnfollowerRowHtml;
  renderUnfollowerRowHtml = function (user, index) {
    let html = baseRowHtml.call(this, user, index);
    const t = timeOf(user);
    const note = notesForRender()[user.username];
    const extras = [];
    if (t !== null) extras.push(`<span class="row-age" title="followed ${esc(new Date(t).toLocaleDateString())}">followed ${ago(t) === 'today' ? 'today' : `${ago(t)} ago`}</span>`);
    if (note && note.tags && note.tags.length) extras.push(note.tags.map(tag => `<span class="row-tag">${esc(tag)}</span>`).join(''));
    if (note && note.text) extras.push(`<span class="row-note">${esc(note.text)}</span>`);
    if (extras.length) {
      html = html.replace(/(<div class="user-details">[\s\S]*?)(\n\s*<\/div>\n\s*<\/div>\n\s*<div class="user-meta">)/, `$1<div class="row-extras">${extras.join('')}</div>$2`);
    }
    return html;
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
      starred: state.starred.slice(),
      tally: readTally().slice()
    };
  }
  function restore(snap) {
    if (snap.acc !== accKey()) return;
    state.following = snap.following;
    state.unfollowed = snap.unfollowed;
    state.starred = snap.starred;
    tallyUndo(snap);
    elements.inputFollowing.value = state.following.map(u => `@${u.originalUsername}`).join('\n');
    updateListUI('following');
    saveCurrentAccountData();
    calculateUnfollowers({ animate: true });
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
        restore(snap);
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
        if (row && sel.startsWith('#list-unfollowed ')) tallyRemove([row.dataset.username]);
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

  // ---------- daily unfollow counter ----------
  const baseUpdateUnfollowedUI = updateUnfollowedUI;
  updateUnfollowedUI = function (enteringUsername) {
    if (enteringUsername) {
      tallyAdd([enteringUsername]);
      refreshToolbar();
    }
    return baseUpdateUnfollowedUI.call(this, enteringUsername);
  };

  // ---------- import history & changes ----------
  // At the end of every import (recordImportDate), compare the new lists
  // with the previous import's and keep the result.
  const baseRecordImportDate = recordImportDate;
  recordImportDate = function (accountUsername) {
    const result = baseRecordImportDate.call(this, accountUsername);
    const key = accountUsername ? accountUsername.toLowerCase() : '_global_';
    if (key === DEMO_ID) return result;
    const history = readJSON(`import_history_${key}`, []);
    const prev = history[history.length - 1];
    const following = state.following.map(u => u.username);
    const followers = state.followers.map(u => u.username);
    const unfollowers = state.unfollowers.length;
    if (prev && prev.followingList) {
      const pf = new Set(prev.followingList), pr = new Set(prev.followersList);
      const nf = new Set(following), nr = new Set(followers);
      const diff = {
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
    return result;
  };

  // ---------- list 3 toolbar: sort, select, today's count, reminder ----------
  let toolbar = null;
  function buildToolbar() {
    const wrapper = document.querySelector('#card-unfollowers .results-layout-wrapper');
    if (!wrapper || toolbar) return;
    toolbar = document.createElement('div');
    toolbar.className = 'list-toolbar';
    // Sort, select and today's tally share one row; the re-import
    // reminder, when it shows, sits on its own line under them.
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
      <span class="toolbar-pill toolbar-count" data-act="count" title="accounts unfollowed today"></span>
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
    const hasRows = state.unfollowers.length > 0 && currentView === 'results';
    toolbar.querySelector('[data-act="sort"]').disabled = !hasRows;
    toolbar.querySelector('[data-act="select"]').disabled = !hasRows && !selectMode;
    toolbar.querySelector('[data-act="select"]').classList.toggle('on', selectMode);

    const count = getToday();
    const countEl = toolbar.querySelector('[data-act="count"]');
    setPill(countEl, count > 0, `${count} unfollowed today`);
    fitCount();
    watchCountFit();

    const importedAt = +(storageGet(`import_date_${accKey()}`) || 0);
    const due = importedAt && Date.now() - importedAt > 7 * DAY && accKey() !== DEMO_ID;
    setPill(toolbar.querySelector('[data-act="reminder"]'), !!due, due ? `imported ${plural(Math.floor((Date.now() - importedAt) / DAY), 'day')} ago · import again` : '');
  }
  // The tally shares a row with sort and select: on a narrow phone, where
  // "unfollowed today" doesn't fit beside them, it drops the "today" (the
  // pill says so when you hover or long-press it) rather than cutting off.
  function fitCount() {
    const el = toolbar && toolbar.querySelector('[data-act="count"]');
    if (!el || el.classList.contains('pill-hidden')) return;
    const n = getToday();
    const row = el.parentElement;
    const tooWide = () => el.scrollWidth > el.clientWidth + 1;
    row.classList.remove('tight');
    el.textContent = `${n} unfollowed today`;
    if (tooWide()) el.textContent = `${n} unfollowed`;
    // The smallest phones: sort and select drop their little icons too.
    if (tooWide()) row.classList.add('tight');
  }
  // Re-check whenever the row changes size (the window, the font loading,
  // the sort label growing or shrinking).
  window.addEventListener('resize', () => fitCount());
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitCount());
  let fitObserver = null;
  function watchCountFit() {
    if (fitObserver || !window.ResizeObserver || !toolbar) return;
    fitObserver = new ResizeObserver(() => fitCount());
    toolbar.querySelectorAll('.toolbar-row > *').forEach(el => fitObserver.observe(el));
  }
  // Shows/hides a pill with the chips' fade (in) / a quick fade (out).
  function setPill(el, show, text) {
    if (show && el.textContent !== text) el.textContent = text;
    const shown = !el.classList.contains('pill-hidden');
    if (show === shown) return;
    el.classList.toggle('pill-hidden', !show);
    if (show) animateIn(el, 'scale(0.85)');
  }

  // ---------- select several rows ----------
  let selectMode = false;
  let selectBar = null;
  const selected = new Set();
  function setSelectMode(on) {
    selectMode = on;
    selected.clear();
    elements.listUnfollowers.classList.toggle('select-mode', on);
    elements.listUnfollowers.querySelectorAll('.multi-selected').forEach(r => r.classList.remove('multi-selected'));
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
    // Commit its hidden starting state first — on the very first use the bar
    // was created and shown in the same frame, so it just appeared.
    void selectBar.offsetWidth;
    selectBar.classList.toggle('show', on);
    updateSelectCount();
    refreshToolbar();
  }
  // List 3 re-renders (a search, a row leaving, switching accounts) rebuilt
  // the rows without their selected outline, and the count kept usernames
  // that were no longer there.
  function keepSelection() {
    if (!selectMode) return;
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
    const snap = snapshot();
    const acc = accKey();
    const users = state.unfollowers.filter(u => selected.has(u.username));
    if (kind === 'star') {
      const have = new Set(state.starred.map(u => u.username));
      users.forEach(u => { if (!have.has(u.username)) state.starred.unshift({ ...u, account: acc }); });
    } else if (kind === 'unfollow') {
      const have = new Set(state.unfollowed.map(u => u.username));
      users.forEach(u => { if (!have.has(u.username)) state.unfollowed.unshift({ ...u, account: acc }); });
      tallyAdd(users.map(u => u.username));
    }
    const n = users.length;
    setSelectMode(false);
    saveCurrentAccountData();
    calculateUnfollowers({ animate: true }); // they slide out of list 3
    offerUndo(snap, `${plural(n, 'account')} ${kind === 'star' ? 'starred' : 'unfollowed'}`);
  }

  // ---------- notes & tags (long-press / right-click a row) ----------
  let noteOverlay = null;
  let noteFor = null;
  function openNote(username) {
    const user = state.unfollowers.find(u => u.username === username) || { username, originalUsername: username };
    noteFor = user;
    if (!noteOverlay) {
      noteOverlay = document.createElement('div');
      noteOverlay.className = 'modal-overlay hidden';
      noteOverlay.innerHTML = `
        <div class="account-modal-card glass feature-note-card">
          <div class="account-modal-header"><h3 class="feature-note-title"></h3></div>
          <div class="account-modal-input-group">
            <label>note</label>
            <textarea class="feature-note-text" rows="3" placeholder="for example, met at work"></textarea>
          </div>
          <div class="account-modal-input-group">
            <label>tags</label>
            <input type="text" class="feature-note-tags" placeholder="for example, close friend, brand">
          </div>
          <div class="account-modal-actions feature-note-footer">
            <button class="btn btn-secondary" data-note="cancel">cancel</button>
            <button class="btn btn-primary" data-note="save">save</button>
          </div>
        </div>`;
      document.body.appendChild(noteOverlay);
      noteOverlay.addEventListener('click', (e) => {
        if (e.target === noteOverlay) return closeNote();
        const btn = e.target.closest('[data-note]');
        if (!btn) return;
        if (btn.dataset.note === 'cancel') return closeNote();
        if (btn.dataset.note === 'save') return saveNote();
      });
      noteOverlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNote(); });
    }
    const note = getNotes()[username] || {};
    noteOverlay.querySelector('.feature-note-title').textContent = `@${user.originalUsername}`;
    noteOverlay.querySelector('.feature-note-text').value = note.text || '';
    noteOverlay.querySelector('.feature-note-tags').value = (note.tags || []).join(', ');
    showModalOverlay(noteOverlay);
    lockPageScroll();
  }
  function closeNote() {
    if (!noteOverlay) return;
    noteOverlay.classList.remove('show');
    unlockPageScroll();
    scheduleOverlayHide(noteOverlay, () => noteOverlay.classList.add('hidden'));
  }
  function saveNote() {
    const text = noteOverlay.querySelector('.feature-note-text').value.trim();
    const tags = noteOverlay.querySelector('.feature-note-tags').value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean).slice(0, 6);
    const notes = getNotes();
    if (text || tags.length) notes[noteFor.username] = { text, tags }; else delete notes[noteFor.username];
    setNotes(notes);
    closeNote();
    // Redraw just that row's extras, fading them in.
    const row = elements.listUnfollowers.querySelector(`.user-row[data-username="${CSS.escape(noteFor.username)}"]`);
    if (row) {
      const index = +row.dataset.index;
      const tpl = document.createElement('template');
      tpl.innerHTML = renderUnfollowerRowHtml(noteFor, index).trim();
      const fresh = tpl.content.querySelector('.row-extras');
      const old = row.querySelector('.row-extras');
      if (old) old.remove();
      if (fresh) { row.querySelector('.user-details').appendChild(fresh); animateIn(fresh); }
    }
  }
  // Long-press (touch) or right-click (mouse) on a list 3 row.
  let pressTimer = null, pressStart = null, suppressClick = false;
  elements.listUnfollowers.addEventListener('touchstart', (e) => {
    const row = e.target.closest('.user-row');
    if (!row || selectMode || row.classList.contains('username-exit')) return;
    const t = e.touches[0];
    pressStart = { x: t.clientX, y: t.clientY };
    pressTimer = setTimeout(() => {
      suppressClick = true;
      if (navigator.vibrate) navigator.vibrate(15);
      openNote(row.dataset.username);
    }, 500);
  }, { passive: true });
  elements.listUnfollowers.addEventListener('touchmove', (e) => {
    if (!pressTimer || !pressStart) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - pressStart.x, t.clientY - pressStart.y) > 10) { clearTimeout(pressTimer); pressTimer = null; }
  }, { passive: true });
  elements.listUnfollowers.addEventListener('touchend', () => { clearTimeout(pressTimer); pressTimer = null; }, { passive: true });
  elements.listUnfollowers.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  elements.listUnfollowers.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.user-row');
    if (!row || selectMode || row.classList.contains('username-exit')) return;
    e.preventDefault();
    openNote(row.dataset.username);
  });

  // ---------- list 3 views: a tab switcher above list 3's box ----------
  // Same bar and sliding highlight as the instructions window. Switching
  // only swaps what's inside list 3's box: the old view slides out, the new
  // one slides in, in the direction of the tab — together 550ms on the
  // highlight's easing, so the content lands as the highlight does.
  const VIEWS = [
    ['results', 'results'], ['changes', 'changes'], ['mutuals', 'mutuals'], ['fans', 'fans'],
    ['compare', 'compare'], ['stats', 'stats']
  ];
  let viewNav = null;
  let altView = null;
  let currentView = 'results';
  let viewToken = 0;
  function buildViewSwitcher() {
    const box = document.querySelector('#card-unfollowers .results-container');
    if (!box || viewNav) return;
    viewNav = document.createElement('div');
    viewNav.className = 'instructions-steps-nav list3-views';
    viewNav.innerHTML = `<div class="instructions-nav-indicator list3-views-indicator"></div>
      ${VIEWS.map(([id, label]) => `<button class="insights-tab${id === 'results' ? ' active' : ''}" data-view="${id}">${label}</button>`).join('')}`;
    box.parentNode.insertBefore(viewNav, box);
    altView = document.createElement('div');
    altView.className = 'list3-alt-view hidden';
    box.appendChild(altView);
    viewNav.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-view]');
      if (!tab) return;
      e.stopPropagation();
      showView(tab.dataset.view);
    });
    altView.addEventListener('change', (e) => { if (e.target.matches('.compare-select')) renderView(); });
    altView.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-change]');
      if (tab) { e.stopPropagation(); showChangesTab(tab.dataset.change); }
    });
    // Park the highlight under "results" once the bar has a size.
    const place = () => {
      const active = viewNav.querySelector('.insights-tab.active');
      if (!active || !active.offsetWidth) return;
      const indicator = viewNav.querySelector('.list3-views-indicator');
      indicator._pos = null;
      moveInstructionsIndicator(indicator, active);
    };
    requestAnimationFrame(place);
    // Once the font has loaded the tabs have their real widths.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { place(); placeChangesIndicator(); });
    window.addEventListener('resize', place);
    // Searching or jumping to list 3 by keyboard brings the results back.
    elements.searchUnfollowers && elements.searchUnfollowers.addEventListener('focus', () => showView('results'));
    if (window.ResizeObserver) new ResizeObserver(place).observe(viewNav);
  }
  // What's showing in the box for a view.
  const viewEls = (view) => view === 'results'
    ? [elements.listUnfollowers, document.getElementById('unfollowers-empty-state')].filter(el => el && !el.classList.contains('hidden'))
    : [altView];
  function showView(view) {
    if (!viewNav || view === currentView) return;
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
    // A quick second tap: settle whatever the last switch left mid-slide.
    [...viewEls('results'), elements.listUnfollowers, altView].forEach(el => el && el.getAnimations && el.getAnimations().forEach(a => a.cancel()));
    const outgoing = viewEls(currentView).filter(el => el.getClientRects().length);
    currentView = view;
    const token = ++viewToken;
    const swap = () => {
      if (token !== viewToken) return;
      outgoing.forEach(el => { el.getAnimations && el.getAnimations().forEach(a => a.cancel()); });
      const box = altView.parentNode;
      box.classList.toggle('showing-alt', view !== 'results');
      altView.classList.toggle('hidden', view === 'results');
      if (view !== 'results') { renderView(); altView.scrollTop = 0; }
      refreshToolbar();
      if (typeof altView.animate !== 'function') return;
      viewEls(view).forEach(el => el.animate(
        [{ opacity: 0, transform: `translateX(${dir * 28}px)` }, { opacity: 1, transform: 'translateX(0)' }],
        { duration: 350, easing: 'cubic-bezier(0.65, 0, 0.35, 1)' }));
    };
    if (typeof altView.animate !== 'function' || !outgoing.length) return swap();
    let pending = outgoing.length;
    outgoing.forEach(el => el.animate(
      [{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: `translateX(${-dir * 28}px)` }],
      { duration: 200, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', fill: 'forwards' }
    ).finished.then(() => { if (--pending === 0) swap(); }, () => { if (--pending === 0) swap(); }));
  }
  // Keep the open view current as the data changes (imports, account
  // switches, unfollows).
  function refreshView() {
    if (currentView !== 'results' && altView) renderView();
  }

  const followingSet = () => new Set(state.following.map(u => u.username));
  const followersSet = () => new Set(state.followers.map(u => u.username));
  const userRowsHtml = (users, empty, action) => users.length
    ? `<div class="insights-list">${users.slice(0, 500).map(u => `
        <div class="parsed-item insights-row" data-username="${esc(u.username)}">
          <a href="${esc(safeProfileUrl(u))}" target="_blank" rel="noopener" class="parsed-username">@${esc(u.originalUsername || u.username)}</a>
          ${action ? `<button class="insights-row-btn" data-ins="${action.id}" data-username="${esc(u.username)}">${action.label}</button>` : ''}
        </div>`).join('')}${users.length > 500 ? `<div class="insights-more">+ ${users.length - 500} more</div>` : ''}</div>`
    : `<div class="dropdown-empty-message">${empty}</div>`;
  const asUsers = (names) => names.map(n => ({ username: n, originalUsername: n }));
  const stat = (value, label) => `<div class="insights-stat"><div class="insights-stat-value">${value}</div><div class="insights-stat-label">${label}</div></div>`;

  function renderView() {
    const body = altView;
    const key = accKey();
    const who = state.selectedAccountUsername ? `@${esc((state.instagramAccounts.find(a => a.originalUsername.toLowerCase() === key) || {}).username || key)}` : 'this view';
    let html = '';
    if (currentView === 'changes') {
      const d = readJSON(`import_diff_${key}`, null);
      if (!d) html = `<div class="dropdown-empty-message">import your files again later to see who has unfollowed you, who has followed you, and more since last time.</div>`;
      else {
        // Its own switcher, same design as the one above list 3.
        const lists = { lost: d.lostFollowers, new: d.newFollowers, stopped: d.stoppedFollowing, started: d.startedFollowing };
        html = `<div class="insights-sub">${who} · since ${esc(new Date(d.since).toLocaleDateString())}</div>
          <div class="instructions-steps-nav changes-nav">
            <div class="instructions-nav-indicator changes-indicator"></div>
            ${CHANGE_TABS.map(([id, label]) => `<button class="insights-tab${id === changesTab ? ' active' : ''}" data-change="${id}">${label}</button>`).join('')}
          </div>
          ${CHANGE_TABS.map(([id]) => `<div class="changes-pane${id === changesTab ? ' active' : ''}" data-pane="${id}">${userRowsHtml(asUsers(lists[id]), CHANGE_EMPTY[id])}</div>`).join('')}`;
      }
    } else if (currentView === 'stats') {
      const following = state.following.length, followers = state.followers.length;
      const fset = followersSet();
      const mutual = state.following.filter(u => fset.has(u.username)).length;
      const ratio = following ? Math.round((mutual / following) * 100) : 0;
      const history = readJSON(`import_history_${key}`, []);
      const max = Math.max(1, ...history.map(h => h.unfollowers || 0));
      const bars = history.map((h, i) => {
        const hgt = Math.max(3, Math.round(((h.unfollowers || 0) / max) * 70));
        return `<div class="trend-bar" style="height:${hgt}px;animation-delay:${i * 30}ms" title="${esc(new Date(h.date).toLocaleDateString())}: ${h.unfollowers || 0}"></div>`;
      }).join('');
      html = `<div class="insights-sub">${who}</div>
        <div class="insights-stats">
          ${stat(following, 'following')}${stat(followers, 'followers')}${stat(`${ratio}%`, 'follow you back')}
          ${stat(state.unfollowers.length, "don't follow you back")}${stat(state.unfollowed.length, 'unfollowed')}${stat(state.starred.length, 'starred')}
        </div>
        <div class="insights-section-title">accounts that don't follow you back, per import</div>
        ${history.length ? `<div class="trend-chart">${bars}</div>` : `<div class="dropdown-empty-message">import your files to start tracking this</div>`}`;
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
        html = `<div class="compare-pickers"><select class="compare-select">${opts(a)}</select><span>vs</span><select class="compare-select">${opts(b)}</select></div>
          <div class="insights-section"><div class="insights-section-title">follows the first account but not the second account <span>${fa.filter(u => !sb.has(u.username)).length}</span></div>${userRowsHtml(fa.filter(u => !sb.has(u.username)), 'no accounts here')}</div>
          <div class="insights-section"><div class="insights-section-title">follows the second account but not the first account <span>${fb.filter(u => !sa.has(u.username)).length}</span></div>${userRowsHtml(fb.filter(u => !sa.has(u.username)), 'no accounts here')}</div>`;
      }
    }
    body.innerHTML = `<div class="insights-pane">${html}</div>`;
    placeChangesIndicator();
  }

  // ---------- changes view: its own tab switcher ----------
  const CHANGE_TABS = [
    ['lost', 'unfollowed you'], ['new', 'new followers'],
    ['stopped', 'you stopped following'], ['started', 'you started following']
  ];
  // Worded like the unfollowed / starred submenus' empty lines.
  const CHANGE_EMPTY = {
    lost: 'no accounts have unfollowed you', new: 'no new followers',
    stopped: "no accounts you've stopped following", started: "no accounts you've started following"
  };
  let changesTab = 'lost';
  function placeChangesIndicator() {
    const nav = altView && altView.querySelector('.changes-nav');
    if (!nav) return;
    const active = nav.querySelector('.insights-tab.active');
    const indicator = nav.querySelector('.changes-indicator');
    indicator._pos = null;
    moveInstructionsIndicator(indicator, active);
    const left = active.offsetLeft - 12;
    if (left > 0) nav.scrollLeft = left;
  }
  function showChangesTab(id) {
    const nav = altView.querySelector('.changes-nav');
    if (!nav || id === changesTab) return;
    const ids = CHANGE_TABS.map(t => t[0]);
    const dir = ids.indexOf(id) > ids.indexOf(changesTab) ? 1 : -1;
    const oldPane = altView.querySelector(`.changes-pane[data-pane="${changesTab}"]`);
    const newPane = altView.querySelector(`.changes-pane[data-pane="${id}"]`);
    changesTab = id;
    const tabs = [...nav.querySelectorAll('[data-change]')];
    const active = tabs.find(t => t.dataset.change === id);
    tabs.forEach(t => t.classList.toggle('active', t === active));
    moveInstructionsIndicator(nav.querySelector('.changes-indicator'), active);
    const left = active.offsetLeft - 12, right = active.offsetLeft + active.offsetWidth + (active.nextElementSibling ? 38 : 12);
    if (left < nav.scrollLeft) scrollInstructionsNav(nav, Math.max(0, left));
    else if (right > nav.scrollLeft + nav.clientWidth) scrollInstructionsNav(nav, right - nav.clientWidth);
    // Same swap as list 3's views: out, then in, 550ms together.
    altView.querySelectorAll('.changes-pane').forEach(p => p.getAnimations && p.getAnimations().forEach(a => a.cancel()));
    const token = (altView._changesToken = {});
    const swap = () => {
      if (altView._changesToken !== token) return;
      oldPane.getAnimations && oldPane.getAnimations().forEach(a => a.cancel());
      oldPane.classList.remove('active');
      newPane.classList.add('active');
      if (typeof newPane.animate === 'function') newPane.animate(
        [{ opacity: 0, transform: `translateX(${dir * 28}px)` }, { opacity: 1, transform: 'translateX(0)' }],
        { duration: 350, easing: 'cubic-bezier(0.65, 0, 0.35, 1)' });
    };
    if (typeof oldPane.animate !== 'function') return swap();
    oldPane.animate(
      [{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: `translateX(${-dir * 28}px)` }],
      { duration: 200, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', fill: 'forwards' }
    ).finished.then(swap, swap);
  }

  const EXPORT_LISTS = [
    ['list3', "list 3 · don't follow you back"], ['unfollowed', 'unfollowed'], ['starred', 'starred'],
    ['following', 'list 1 · following'], ['followers', 'list 2 · followers'], ['mutuals', 'mutuals'], ['fans', 'fans']
  ];
  function listFor(kind) {
    if (kind === 'following') return state.following;
    if (kind === 'followers') return state.followers;
    if (kind === 'list3') return state.unfollowers;
    if (kind === 'unfollowed') return state.unfollowed;
    if (kind === 'starred') return state.starred;
    if (kind === 'mutuals') { const f = followersSet(); return state.following.filter(u => f.has(u.username)); }
    if (kind === 'fans') { const f = followingSet(); return state.followers.filter(u => !f.has(u.username)); }
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
    const notes = getNotes();
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const multi = kinds.length > 1;
    const head = ['username', 'full name', 'followed', 'profile', 'note', 'tags'];
    const rows = [multi ? ['list'].concat(head) : head];
    kinds.forEach(kind => {
      const name = (EXPORT_LISTS.find(x => x[0] === kind) || [kind, kind])[1];
      listFor(kind).forEach(u => {
        const t = timeOf(u); const n = notes[u.username] || {};
        const row = [u.originalUsername || u.username, u.fullName || '', t ? new Date(t).toISOString().slice(0, 10) : '', safeProfileUrl(u), n.text || '', (n.tags || []).join(' ')];
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
          <div class="insights-sub">choose the lists you want to download as a spreadsheet (csv)</div>
          <div class="export-options"></div>
          <div class="account-modal-actions">
            <button class="btn btn-secondary" data-exp="cancel">cancel</button>
            <button class="btn btn-primary" data-exp="go">export</button>
          </div>
        </div>`;
      document.body.appendChild(exportOverlay);
      exportOverlay.addEventListener('click', (e) => {
        if (e.target === exportOverlay || e.target.closest('[data-exp="cancel"]')) return closeExport();
        if (e.target.closest('[data-exp="go"]')) {
          const kinds = [...exportOverlay.querySelectorAll('.export-option.on')].map(o => o.dataset.kind);
          if (kinds.length) { exportCsv(kinds); closeExport(); }
          return;
        }
        const opt = e.target.closest('.export-option');
        if (opt) { opt.classList.toggle('on'); updateExportButton(); }
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !exportOverlay.classList.contains('hidden')) closeExport(); });
    }
    exportOverlay.querySelector('.export-options').innerHTML = EXPORT_LISTS.map(([kind, label], i) => `
      <button class="export-option${i === 0 ? ' on' : ''}" data-kind="${kind}">
        <span class="export-check"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>
        <span class="export-label">${esc(label)}</span>
        <span class="export-count">${listFor(kind).length}</span>
      </button>`).join('');
    updateExportButton();
    showModalOverlay(exportOverlay);
    lockPageScroll();
  }
  function updateExportButton() {
    const n = exportOverlay.querySelectorAll('.export-option.on').length;
    const go = exportOverlay.querySelector('[data-exp="go"]');
    go.disabled = n === 0;
    go.textContent = n > 1 ? `export ${n} lists` : 'export';
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
      row.appendChild(btn);
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
      if (!animate) btn.classList.add('no-anim');
      btn.classList.toggle('export-off', off);
      btn.tabIndex = off ? -1 : 0;
      if (!animate) { void btn.offsetWidth; btn.classList.remove('no-anim'); }
    });
  }
  // updateListUI runs whenever list 1 or 2 changes (typing, import,
  // switching accounts, clearing).
  const baseUpdateListUI = updateListUI;
  updateListUI = function (type) {
    const result = baseUpdateListUI.call(this, type);
    refreshListExports();
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

  function init() {
    buildToolbar();
    buildViewSwitcher();
    buildExportButtons();
    buildUndoButton();
    arrangeList3Buttons();
    setupInstall();
    refreshToolbar();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // For the rest of the app (and tests).
  window.igFeatures = { showView, showToast, setSelectMode, openNote, refreshToolbar };
})();
