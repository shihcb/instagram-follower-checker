// -------------------------------------------------------------
// Extra features, layered on top of script.js (loaded after it):
//  - changes since your last import (+ a toast after importing)
//  - how long ago you followed each account, and sort by it
//  - insights: mutuals, fans, stats with a trend, compare accounts,
//    export (CSV) and a share card
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
  const DAILY_LIMIT = 150;
  const DAILY_WARN = 100;

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
  const todayKey = () => `unfollow_count_${new Date().toISOString().slice(0, 10)}`;
  const getToday = () => +(storageGet(todayKey()) || 0);

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
    if (d < 30) return `${Math.floor(d)}d`;
    if (d < 365) return `${Math.floor(d / 30)}mo`;
    return `${Math.floor(d / 365)}y`;
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
    const result = baseUpdateResultsUI.call(this, opts);
    refreshToolbar();
    return result;
  };

  // Rows: how long ago you followed them, your note and tags.
  const baseRowHtml = renderUnfollowerRowHtml;
  renderUnfollowerRowHtml = function (user, index) {
    let html = baseRowHtml.call(this, user, index);
    const t = timeOf(user);
    const note = getNotes()[user.username];
    const extras = [];
    if (t !== null) extras.push(`<span class="row-age" title="followed ${esc(new Date(t).toLocaleDateString())}">followed ${ago(t)} ago</span>`);
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
    toastEl.className = `feature-toast ${tone}`;
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
  function offerUndo(snap, message) {
    // After the row has finished sliding (its completion updates the lists).
    setTimeout(() => showToast(message, 'undo', () => restore(snap)), ROW_MOTION_MS + 60);
  }

  const ACTIONS = [
    ['#list-unfollowers .action-star', 'starred'],
    ['#list-unfollowers .action-delete', 'unfollowed'],
    ['#list-unfollowers .action-dismiss', 'removed from list 3'],
    ['#list-unfollowed .star-unfollowed-btn', 'moved to starred'],
    ['#list-unfollowed .remove-unfollowed-btn', 'put back in list 3'],
    ['#list-starred .unstar-btn', 'unstarred'],
    ['#list-starred .unfollow-starred-btn', 'moved to unfollowed'],
    ['#list-starred .remove-unfollowed-btn', 'put back in list 3'],
  ];
  document.addEventListener('click', (e) => {
    if (selectMode || e.target.closest('.row-select-bar')) return;
    for (const [sel, verb] of ACTIONS) {
      const btn = e.target.closest(sel);
      if (btn) {
        const row = btn.closest('[data-username]');
        if (row && row.classList.contains('username-exit')) return;
        const name = row ? row.querySelector('.user-link, .parsed-username') : null;
        offerUndo(snapshot(), `${name ? name.textContent.trim() : 'username'} ${verb}`);
        return;
      }
    }
    // A plain tap on a list 3 row opens the profile and unfollows it.
    const row = e.target.closest('#list-unfollowers .user-row');
    if (row && !row.classList.contains('username-exit') && !e.target.closest('.action-arrow, .user-row-actions')) {
      const name = row.querySelector('.user-link');
      offerUndo(snapshot(), `${name ? name.textContent.trim() : 'username'} unfollowed`);
    }
  }, true);

  // ---------- daily unfollow counter ----------
  const baseUpdateUnfollowedUI = updateUnfollowedUI;
  updateUnfollowedUI = function (enteringUsername) {
    if (enteringUsername && accKey() !== DEMO_ID) {
      const count = getToday() + 1;
      storageSet(todayKey(), String(count));
      if (count === DAILY_WARN || count === DAILY_LIMIT) {
        setTimeout(() => showToast(count >= DAILY_LIMIT
          ? `${count} unfollows today — instagram may limit your account. take a break until tomorrow.`
          : `${count} unfollows today — slow down to stay under instagram's limits`, null, null, { tone: 'warn', duration: 7000 }), ROW_MOTION_MS + 900);
      }
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
        total ? 'view' : null, () => openInsights('changes')), 900);
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
    toolbar.innerHTML = `
      <button class="toolbar-pill" data-act="sort" title="sort list 3">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/></svg>
        <span class="toolbar-pill-text"></span>
      </button>
      <button class="toolbar-pill" data-act="select" title="select several usernames">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        <span class="toolbar-pill-text">select</span>
      </button>
      <span class="toolbar-pill toolbar-count" data-act="count" title="unfollows today"></span>
      <button class="toolbar-pill toolbar-reminder" data-act="reminder" title="re-import your files"></button>`;
    wrapper.parentNode.insertBefore(toolbar, wrapper);
    toolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'sort') {
        sortMode = sortMode === 'default' ? 'oldest' : sortMode === 'oldest' ? 'newest' : 'default';
        try { localStorage.setItem('list3_sort', sortMode); } catch (err) {}
        slideSortLabel(btn);
        // Rows slide to their new order.
        calculateUnfollowers({ animate: true });
      } else if (act === 'select') {
        setSelectMode(!selectMode);
      } else if (act === 'reminder') {
        if (elements.btnAddAccount && !elements.btnAddAccount.disabled) elements.btnAddAccount.click();
      }
    });
    refreshToolbar();
  }

  // The sort pill's label slides to the next option: the old one out to
  // the left, the new one in from the right (list 3's easing), while the
  // pill eases to its new width.
  function slideSortLabel(btn) {
    const text = btn.querySelector('.toolbar-pill-text');
    const label = sortMode === 'default' ? 'sort' : sortMode === 'oldest' ? 'oldest first' : 'newest first';
    if (typeof text.animate !== 'function') { text.textContent = label; return; }
    const startWidth = btn.offsetWidth;
    const old = text.cloneNode(true);
    old.classList.add('toolbar-pill-text-old');
    text.textContent = label;
    const endWidth = btn.offsetWidth;
    btn.appendChild(old);
    btn.animate([{ width: `${startWidth}px` }, { width: `${endWidth}px` }], { duration: 300, easing: EASE });
    old.animate([{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(-14px)' }], { duration: 220, easing: EASE, fill: 'forwards' })
      .finished.then(() => old.remove(), () => old.remove());
    text.animate([{ opacity: 0, transform: 'translateX(14px)' }, { opacity: 1, transform: 'translateX(0)' }], { duration: 300, easing: EASE });
  }

  function refreshToolbar() {
    if (!toolbar) return;
    const sortText = toolbar.querySelector('[data-act="sort"] .toolbar-pill-text');
    const label = sortMode === 'default' ? 'sort' : sortMode === 'oldest' ? 'oldest first' : 'newest first';
    if (sortText.textContent !== label) sortText.textContent = label;
    toolbar.querySelector('[data-act="sort"]').classList.toggle('on', sortMode !== 'default');
    const hasRows = state.unfollowers.length > 0;
    toolbar.querySelector('[data-act="sort"]').disabled = !hasRows;
    toolbar.querySelector('[data-act="select"]').disabled = !hasRows && !selectMode;
    toolbar.querySelector('[data-act="select"]').classList.toggle('on', selectMode);

    const count = getToday();
    const countEl = toolbar.querySelector('[data-act="count"]');
    setPill(countEl, count > 0, `${count}/${DAILY_LIMIT} today`);
    countEl.classList.toggle('warn', count >= DAILY_WARN);

    const importedAt = +(storageGet(`import_date_${accKey()}`) || 0);
    const due = importedAt && Date.now() - importedAt > 7 * DAY && accKey() !== DEMO_ID;
    setPill(toolbar.querySelector('[data-act="reminder"]'), !!due, due ? `imported ${Math.floor((Date.now() - importedAt) / DAY)}d ago · re-import` : '');
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
    selectBar.classList.toggle('show', on);
    updateSelectCount();
    refreshToolbar();
  }
  function updateSelectCount() {
    if (!selectBar) return;
    selectBar.querySelector('.row-select-count').textContent = `${selected.size} selected`;
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
      storageSet(todayKey(), String(getToday() + users.length));
    }
    const n = users.length;
    setSelectMode(false);
    saveCurrentAccountData();
    calculateUnfollowers({ animate: true }); // they slide out of list 3
    offerUndo(snap, `${n} username${n === 1 ? '' : 's'} ${kind === 'star' ? 'starred' : 'unfollowed'}`);
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
            <textarea class="feature-note-text" rows="3" placeholder="e.g. met at work"></textarea>
          </div>
          <div class="account-modal-input-group">
            <label>tags</label>
            <input type="text" class="feature-note-tags" placeholder="close friend, brand">
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
    cancelOverlayHide(noteOverlay);
    noteOverlay.classList.remove('hidden');
    lockPageScroll();
    requestAnimationFrame(() => noteOverlay.classList.add('show'));
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

  // ---------- insights window ----------
  const TABS = [
    ['changes', 'changes'], ['stats', 'stats'], ['mutuals', 'mutuals'], ['fans', 'fans'],
    ['compare', 'compare'], ['export', 'export & share']
  ];
  let insights = null;
  let insightsTab = 'changes';
  function buildInsights() {
    insights = document.createElement('div');
    insights.className = 'modal-overlay hidden';
    insights.id = 'insights-modal-overlay';
    insights.innerHTML = `
      <div class="account-modal-card glass instructions-modal-card insights-card">
        <div class="account-modal-header insights-header">
          <h3>insights</h3>
          <button class="modal-close-btn" data-ins="close" aria-label="close">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
        <div class="instructions-steps-nav insights-nav">
          <div class="instructions-nav-indicator insights-indicator"></div>
          ${TABS.map(([id, label]) => `<button class="insights-tab" data-tab="${id}">${label}</button>`).join('')}
        </div>
        <div class="insights-body"></div>
      </div>`;
    document.body.appendChild(insights);
    insights.addEventListener('click', (e) => {
      if (e.target === insights || e.target.closest('[data-ins="close"]')) return closeInsights();
      const tab = e.target.closest('.insights-tab');
      if (tab) return showTab(tab.dataset.tab);
      const act = e.target.closest('[data-ins]');
      if (act) insightsAction(act);
    });
    insights.addEventListener('change', (e) => { if (e.target.matches('.compare-select')) renderTab(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && insights.classList.contains('show')) closeInsights(); });
  }
  function openInsights(tab = insightsTab) {
    if (!insights) buildInsights();
    insightsTab = tab;
    cancelOverlayHide(insights);
    insights.classList.remove('hidden');
    lockPageScroll();
    const indicator = insights.querySelector('.insights-indicator');
    indicator.classList.add('no-transition');
    requestAnimationFrame(() => {
      insights.classList.add('show');
      showTab(tab, true);
      requestAnimationFrame(() => indicator.classList.remove('no-transition'));
    });
  }
  function closeInsights() {
    insights.classList.remove('show');
    unlockPageScroll();
    scheduleOverlayHide(insights, () => insights.classList.add('hidden'));
  }
  function showTab(tab, instant = false) {
    insightsTab = tab;
    const tabs = [...insights.querySelectorAll('.insights-tab')];
    const active = tabs.find(t => t.dataset.tab === tab);
    tabs.forEach(t => t.classList.toggle('active', t === active));
    const nav = insights.querySelector('.insights-nav');
    const indicator = insights.querySelector('.insights-indicator');
    if (instant) indicator._pos = null;
    moveInstructionsIndicator(indicator, active);
    const left = active.offsetLeft - 12, right = active.offsetLeft + active.offsetWidth + 38;
    if (left < nav.scrollLeft) scrollInstructionsNav(nav, Math.max(0, left));
    else if (right > nav.scrollLeft + nav.clientWidth) scrollInstructionsNav(nav, right - nav.clientWidth);
    renderTab();
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

  function renderTab() {
    const body = insights.querySelector('.insights-body');
    const key = accKey();
    const who = state.selectedAccountUsername ? `@${esc((state.instagramAccounts.find(a => a.originalUsername.toLowerCase() === key) || {}).username || key)}` : 'this view';
    let html = '';
    if (insightsTab === 'changes') {
      const d = readJSON(`import_diff_${key}`, null);
      if (!d) html = `<div class="dropdown-empty-message">import your files again later to see who unfollowed you, who followed you, and more since the last time.</div>`;
      else {
        const section = (title, names) => `<div class="insights-section"><div class="insights-section-title">${title} <span>${names.length}</span></div>${userRowsHtml(asUsers(names), 'nobody')}</div>`;
        html = `<div class="insights-sub">${who} · since ${esc(new Date(d.since).toLocaleDateString())}</div>
          ${section('unfollowed you', d.lostFollowers)}
          ${section('new followers', d.newFollowers)}
          ${section('you stopped following', d.stoppedFollowing)}
          ${section('you started following', d.startedFollowing)}`;
      }
    } else if (insightsTab === 'stats') {
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
          ${stat(state.unfollowers.length, "don't follow back")}${stat(state.unfollowed.length, 'unfollowed')}${stat(state.starred.length, 'starred')}
        </div>
        <div class="insights-section-title">don't follow back, per import</div>
        ${history.length ? `<div class="trend-chart">${bars}</div>` : `<div class="dropdown-empty-message">import your files to start the trend</div>`}`;
    } else if (insightsTab === 'mutuals') {
      const fset = followersSet();
      html = userRowsHtml(state.following.filter(u => fset.has(u.username)), 'no mutuals yet');
    } else if (insightsTab === 'fans') {
      const fset = followingSet();
      html = `<div class="insights-sub">follow you, but you don't follow back</div>${userRowsHtml(state.followers.filter(u => !fset.has(u.username)), 'no fans yet')}`;
    } else if (insightsTab === 'compare') {
      const accounts = state.instagramAccounts.filter(a => !isDemoAccount(a));
      if (accounts.length < 2) html = `<div class="dropdown-empty-message">add a second account to compare who follows each</div>`;
      else {
        const sel = [...insights.querySelectorAll('.compare-select')].map(s => s.value);
        const a = sel[0] || accounts[0].originalUsername.toLowerCase();
        const b = sel[1] || accounts[1].originalUsername.toLowerCase();
        const opts = (v) => accounts.map(x => `<option value="${esc(x.originalUsername.toLowerCase())}"${x.originalUsername.toLowerCase() === v ? ' selected' : ''}>@${esc(x.username)}</option>`).join('');
        const fol = (k) => readJSON(`followers_users_${k}`, []);
        const fa = fol(a), fb = fol(b);
        const sa = new Set(fa.map(u => u.username)), sb = new Set(fb.map(u => u.username));
        html = `<div class="compare-pickers"><select class="compare-select">${opts(a)}</select><span>vs</span><select class="compare-select">${opts(b)}</select></div>
          <div class="insights-section"><div class="insights-section-title">follow the first, not the second <span>${fa.filter(u => !sb.has(u.username)).length}</span></div>${userRowsHtml(fa.filter(u => !sb.has(u.username)), 'nobody')}</div>
          <div class="insights-section"><div class="insights-section-title">follow the second, not the first <span>${fb.filter(u => !sa.has(u.username)).length}</span></div>${userRowsHtml(fb.filter(u => !sa.has(u.username)), 'nobody')}</div>`;
      }
    } else if (insightsTab === 'export') {
      html = `<div class="insights-sub">download a list as a spreadsheet (csv)</div>
        <div class="insights-buttons">
          <button class="btn btn-secondary" data-ins="csv" data-list="list3">list 3</button>
          <button class="btn btn-secondary" data-ins="csv" data-list="unfollowed">unfollowed</button>
          <button class="btn btn-secondary" data-ins="csv" data-list="starred">starred</button>
          <button class="btn btn-secondary" data-ins="csv" data-list="mutuals">mutuals</button>
          <button class="btn btn-secondary" data-ins="csv" data-list="fans">fans</button>
        </div>
        <div class="insights-section-title">share your results</div>
        <button class="btn btn-primary insights-share" data-ins="share">create share card</button>`;
    }
    body.innerHTML = `<div class="insights-pane">${html}</div>`;
  }

  function insightsAction(btn) {
    const act = btn.dataset.ins;
    if (act === 'csv') {
      exportCsv(btn.dataset.list);
    } else if (act === 'share') {
      shareCard();
    }
  }

  function listFor(kind) {
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
  function exportCsv(kind) {
    const notes = getNotes();
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['username', 'full name', 'followed', 'profile', 'note', 'tags']].concat(listFor(kind).map(u => {
      const t = timeOf(u); const n = notes[u.username] || {};
      return [u.originalUsername || u.username, u.fullName || '', t ? new Date(t).toISOString().slice(0, 10) : '', safeProfileUrl(u), n.text || '', (n.tags || []).join(' ')];
    }));
    saveFile(`ig-checker-${kind}.csv`, new Blob([rows.map(r => r.map(cell).join(',')).join('\n')], { type: 'text/csv' }));
    showToast(`${kind === 'list3' ? 'list 3' : kind} exported`);
  }
  function shareCard() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const c = document.createElement('canvas');
    c.width = 1080; c.height = 1080;
    const g = c.getContext('2d');
    g.fillStyle = dark ? '#09090b' : '#fafafa'; g.fillRect(0, 0, 1080, 1080);
    g.fillStyle = dark ? '#18181b' : '#ffffff';
    g.beginPath(); g.roundRect ? g.roundRect(90, 90, 900, 900, 48) : g.rect(90, 90, 900, 900); g.fill();
    const fg = dark ? '#fafafa' : '#09090b', muted = dark ? '#a1a1aa' : '#71717a';
    g.textAlign = 'center';
    g.fillStyle = muted; g.font = '600 44px "Plus Jakarta Sans", system-ui, sans-serif';
    g.fillText('i checked', 540, 330);
    g.fillStyle = fg; g.font = '800 150px "Outfit", system-ui, sans-serif';
    g.fillText(String(state.followers.length || state.following.length), 540, 490);
    g.fillStyle = muted; g.font = '600 44px "Plus Jakarta Sans", system-ui, sans-serif';
    g.fillText(state.followers.length ? 'followers' : 'accounts', 540, 560);
    g.fillStyle = '#10b981'; g.font = '800 92px "Outfit", system-ui, sans-serif';
    g.fillText(`${state.unfollowers.length} don't follow back`, 540, 720);
    g.fillStyle = muted; g.font = '600 36px "Plus Jakarta Sans", system-ui, sans-serif';
    g.fillText('ig checker', 540, 900);
    c.toBlob(blob => { if (blob) saveFile('ig-checker-results.png', blob); }, 'image/png');
  }

  // Insights button, next to list 3's info button (same style).
  function buildInsightsButton() {
    const info = document.getElementById('btn-instructions-info');
    if (!info || document.getElementById('btn-insights')) return;
    const btn = info.cloneNode(false);
    btn.id = 'btn-insights';
    btn.title = 'insights';
    btn.setAttribute('aria-label', 'insights');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>';
    info.parentNode.insertBefore(btn, info);
    btn.addEventListener('click', (e) => { e.stopPropagation(); openInsights(); });
  }

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

  function init() {
    buildToolbar();
    buildInsightsButton();
    setupInstall();
    refreshToolbar();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // For the rest of the app (and tests).
  window.igFeatures = { openInsights, showToast, setSelectMode, openNote, refreshToolbar };
})();
