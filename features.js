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
    // The toolbar first: its reminder pill showing or hiding moves list 3's
    // box, and doing that after the rows were placed left one unanimated.
    safe(refreshToolbar, 'toolbar');
    const result = baseUpdateResultsUI.call(this, opts);
    safe(keepSelection, 'selection');
    safe(refreshToolbar, 'toolbar');
    safe(refreshView, 'view');
    safe(() => renderExtras(true), 'extra lists'); // an account picked: its lists
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
    state.following = snap.following;
    state.unfollowed = snap.unfollowed;
    state.starred = snap.starred;
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
    toolbar.querySelector('[data-act="sort"]').disabled = !hasRows;
    toolbar.querySelector('[data-act="select"]').disabled = !hasRows && !selectMode;
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
      if (box) { setPopped([...box.parentNode.children].indexOf(box)); return; }
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
    elements.searchUnfollowers && elements.searchUnfollowers.addEventListener('focus', () => { showView('results'); showResultsSub('unfollowers'); });
    if (window.ResizeObserver) new ResizeObserver(place).observe(viewNav);
  }
  // What's showing in the box for a view.
  const viewEls = (view) => view === 'results'
    ? [elements.listUnfollowers, document.getElementById('unfollowers-empty-state')].filter(el => el && !el.classList.contains('hidden'))
    : [altView];
  function showView(view) {
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

    if ((view !== 'results' || subTab.results !== 'unfollowers') && selectMode) setSelectMode(false);
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
      .forEach(el => el.animate(MODAL_IN, { duration: 450, easing: MODAL_EASE, delay, fill: 'backwards' }));
  }


  const followingSet = () => new Set(state.following.map(u => u.username));
  const followersSet = () => new Set(state.followers.map(u => u.username));
  const userRowsHtml = (users, empty, action, flagOf) => users.length
    ? `<div class="insights-list">${users.slice(0, 500).map(u => `
        <div class="parsed-item insights-row" data-username="${esc(u.username)}">
          <a href="${esc(safeProfileUrl(u))}" target="_blank" rel="noopener" class="parsed-username">@${esc(u.originalUsername || u.username)}</a>
          ${flagOf && flagOf(u) ? `<span class="insights-row-flag">${flagOf(u)}</span>` : ''}
          ${action ? `<button class="insights-row-btn" data-ins="${action.id}" data-username="${esc(u.username)}">${action.label}</button>` : ''}
        </div>`).join('')}${users.length > 500 ? `<div class="insights-more">+ ${users.length - 500} more</div>` : ''}</div>`
    : `<div class="dropdown-empty-message">${empty}</div>`;
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
  function timelineHtml(key) {
    const hist = key === DEMO_ID ? [] : readJSON(`import_history_${key}`, [])
      .filter(h => h && Number.isFinite(h.date) && Number.isFinite(h.following) && Number.isFinite(h.followers));
    const real = hist.length >= 2;
    const pts = real ? hist.map(h => ({ t: h.date, a: h.following, b: h.followers }))
      : MOCK_TIMELINE.map(([a, b], i) => ({ t: i, a, b }));
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
    return `<div class="timeline${real ? '' : ' timeline-mock'}" data-sig="${sig}">
        <div class="timeline-legend">${series.map(([k, label, c]) => `<span class="timeline-key" style="--c:${c}"><i></i>${label}${real ? `<b>${last[k]}</b>` : ''}</span>`).join('')}</div>
        <div class="timeline-chart"${real ? '' : ' aria-hidden="true"'}>
          <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${series.map(([k, , c]) => `<path class="tl-line" d="${path(k)}" style="--c:${c}"/>`).join('')}</svg>
          ${dots}
        </div>
        <div class="timeline-dates">${real ? `<span>${shortDate(t0)}</span><span>${shortDate(t1)}</span>` : '<span>shows up after your second import</span>'}</div>
      </div>`;
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
        html = `<div class="compare-pickers">${pick(a)}<span>vs</span>${pick(b)}</div>
          <div class="insights-section"><div class="insights-section-title">follows the first account but not the second account</div>${userRowsHtml(fa.filter(u => !sb.has(u.username)), 'no accounts here')}</div>
          <div class="insights-section"><div class="insights-section-title">follows the second account but not the first account</div>${userRowsHtml(fb.filter(u => !sa.has(u.username)), 'no accounts here')}</div>`;
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
    body.innerHTML = `<div class="insights-pane" data-view="${currentView}">${html}</div>`;
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
      else if (oldTl && showing && !pageLoading && typeof oldTl.animate === 'function') {
        // New numbers: the old chart goes like the instructions window
        // closes, the new one comes in like it opens.
        oldTl.classList.add('timeline-leaving');
        tlPane.appendChild(oldTl);
        const drop = () => oldTl.remove();
        oldTl.animate(MODAL_OUT, LEAVE).finished.then(drop, drop);
        setTimeout(drop, LEAVE.duration + 400);
        newTl.animate(MODAL_IN, { duration: 450, easing: MODAL_EASE, delay: LEAVE.duration, fill: 'backwards' });
      } else if (showing) drawTimeline(tlPane);
    }
    applyPopped();
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
    if (kindOf(cur) === kindOf(next)) {
      const newBars = [...next.querySelectorAll('.trend-bar')];
      cur.querySelectorAll('.trend-bar').forEach((bar, i) => {
        const to = newBars[i] && newBars[i].style.height;
        if (!to || to === bar.style.height) return;
        const from = `${bar.getBoundingClientRect().height}px`;
        bar.style.height = to;
        if (typeof bar.animate === 'function') bar.animate([{ height: from }, { height: to }], { duration: 520, easing: GLIDE });
      });
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
  }

  // The switchers inside the changes and stats views.
  function showAltSub(id) {
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
    if (id === 'timeline') drawTimeline(target);
  }

  // ---------- results: its own switcher ----------
  // Unfollowers (list 3 itself) and the export's other lists: requests you
  // sent that are still pending, close friends, blocked, restricted. The
  // switcher sits at the top of list 3's box; the lists slide under it.
  let resultsSubnav = null;
  const extraPanes = {};
  const EXTRA_TEXT = {
    pending: { sub: '', empty: 'no pending follow requests', missing: 'requests you sent that are still pending' },
    closeFriends: { sub: 'your close friends list', empty: 'your close friends list is empty', missing: 'close friends' },
    blocked: { sub: "accounts you've blocked", empty: 'no blocked accounts', missing: 'blocked accounts' },
    restricted: { sub: "accounts you've restricted", empty: 'no restricted accounts', missing: 'restricted accounts' }
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
      const x = e.target.closest('.results-extra[data-sub="pending"] .user-row .action-dismiss');
      if (!x) return;
      e.stopPropagation();
      const row = x.closest('.user-row');
      if (!row || row.classList.contains('username-exit')) return;
      removePending(row.dataset.username, row);
    });
    const nav = resultsSubnav.querySelector('.changes-nav');
    requestAnimationFrame(() => placeSubIndicator(nav));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => placeSubIndicator(nav));
  }
  function showResultsSub(id) {
    if (!resultsSubnav || subTab.results === id || !SUB_TABS.results.some(t => t[0] === id)) return;
    const order = SUB_TABS.results.map(t => t[0]);
    const dir = order.indexOf(id) > order.indexOf(subTab.results) ? 1 : -1;
    subTab.results = id;
    try { localStorage.setItem('results_sub', id); } catch (e) {}
    if (id !== 'unfollowers' && selectMode) setSelectMode(false);
    selectSubTab(resultsSubnav.querySelector('.changes-nav'), id);
    const box = resultsSubnav.parentNode;
    box.classList.toggle('sub-extra', id !== 'unfollowers');
    const targets = id === 'unfollowers' ? mainPanes() : [extraPanes[id]];
    slideSub(box, resultsPanes(), targets, 'sub-on', el => order.indexOf(resultsSubOf(el)), dir);
    refreshToolbar();
  }
  // Pending requests are drawn like list 3's own rows (the avatar, the
  // username, the box), with the arrow (opens the profile, to cancel it
  // there) and the X (takes it off the list once you have).
  const X_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
  const ARROW_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>';
  const pendingRowsHtml = (users, empty) => (users.length
    ? `<div class="pending-list">${users.slice(0, 500).map(u => {
        const href = esc(safeProfileUrl(u));
        const name = u.originalUsername || u.username;
        return `<div class="user-row" data-username="${esc(u.username)}">
          <div class="user-info">
            <a href="${href}" target="_blank" rel="noopener" class="user-avatar-link" title="visit instagram profile"><div class="user-avatar">${esc(name.substring(0, 2))}</div></a>
            <div class="user-details"><a href="${href}" target="_blank" rel="noopener" class="user-link">@${esc(name)}</a></div>
          </div>
          <div class="user-meta"><div class="user-row-actions">
            <a href="${href}" target="_blank" rel="noopener" class="action-arrow" aria-label="visit instagram profile" title="visit instagram profile">${ARROW_ICON}</a>
            <button class="action-dismiss" aria-label="remove from pending requests" title="remove from pending requests">${X_ICON}</button>
          </div></div>
        </div>`;
      }).join('')}</div>`
    : `<div class="dropdown-empty-message">${empty}</div>`);
  function extraContent(id) {
    const text = EXTRA_TEXT[id];
    const list = extraListsNow()[id];
    if (!Array.isArray(list)) {
      return { sub: '', body: `<div class="dropdown-empty-message">import your instagram export folder to see your ${text.missing}</div>` };
    }
    let users = list;
    let flagOf = null;
    if (id === 'closeFriends' && state.followers.length) {
      const f = followersSet();
      users = [...list.filter(u => !f.has(u.username)), ...list.filter(u => f.has(u.username))];
      flagOf = (u) => (f.has(u.username) ? '' : "doesn't follow you back");
    }
    if (id === 'pending') return { sub: text.sub, body: pendingRowsHtml(users, text.empty) };
    return { sub: text.sub, body: userRowsHtml(users, text.empty, null, flagOf) };
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
    const scroll = old.scrollTop;
    old.classList.add('extra-leaving');
    old.scrollTop = scroll;
    const oldSub = old.querySelector(':scope > .insights-sub');
    const keepSub = oldSub && oldSub.textContent === sub;
    if (keepSub) oldSub.style.visibility = 'hidden';
    pane.appendChild(fresh);
    const drop = () => old.remove();
    old.animate(MODAL_OUT, LEAVE).finished.then(drop, drop);
    setTimeout(drop, LEAVE.duration + 400);
    [...fresh.children].filter(el => !(keepSub && el.matches('.insights-sub')))
      .forEach(el => el.animate(MODAL_IN, { duration: 450, easing: MODAL_EASE, delay: LEAVE.duration, fill: 'backwards' }));
  }
  function renderExtras(animate = true) {
    Object.keys(extraPanes).forEach(id => renderExtra(id, animate));
  }
  // Its X tapped (cancelled on Instagram): it slides out like a list 3 row.
  function removePending(name, row) {
    const acc = state.selectedAccountUsername;
    const lists = readExtraLists(acc);
    const before = Array.isArray(lists.pending) ? lists.pending.slice() : [];
    if (!before.some(u => u.username === name)) return;
    lists.pending = before.filter(u => u.username !== name);
    writeExtraLists(acc, lists);
    pushToCloud();
    const done = () => {
      // Still that account on screen: the list is already right (the row
      // has gone), unless it's now empty — then the empty text comes in.
      if ((state.selectedAccountUsername || '') !== (acc || '')) return;
      if (lists.pending.length) extraPanes.pending._sig = (({ sub, body }) => `${sub}|${body}`)(extraContent('pending'));
      else renderExtra('pending', true);
    };
    exitListRow(row, done);
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
          <div class="insights-sub">choose the lists you want to download as a spreadsheet (csv)</div>
          <div class="export-options"></div>
          <button class="export-option export-image" data-exp="image">
            <span class="export-check"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg></span>
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
        if (e.target.closest('[data-exp="image"]')) {
          closeExport();
          safe(() => { statsImage().then(blob => blob && saveFile('ig-stats.png', blob)).catch(err => console.error('[features] stats image failed:', err)); }, 'stats image');
          return;
        }
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
    // The export's other lists only once they've been imported.
    const lists = extraListsNow();
    exportOverlay.querySelector('.export-options').innerHTML = EXPORT_LISTS.filter(([kind]) => !EXTRA_TEXT[kind] || Array.isArray(lists[kind])).map(([kind, label], i) => `
      <button class="export-option${i === 0 ? ' on' : ''}" data-kind="${kind}">
        <span class="export-check"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>
        <span class="export-label">${esc(label)}</span>
        <span class="export-count">${listFor(kind).length}</span>
      </button>`).join('');
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

  function init() {
    // Each part on its own: one failing can't take the rest (or the app)
    // down with it.
    safe(clearOldTally, 'cleanup');
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
  window.igFeatures = { showView, showToast, setSelectMode, refreshToolbar };
})();
