// -------------------------------------------------------------
// localStorage with change detection
// -------------------------------------------------------------
// Saving rewrites whole lists (thousands of usernames) on every delete,
// star or account switch, and localStorage writes of big strings are slow —
// ~30ms per delete and ~300ms per account switch with real-sized accounts,
// blocking the page (and every animation) meanwhile. Most of those writes
// store exactly what's already there, so skip them: remember what each key
// holds (from our own reads/writes) and only write when it changes.
const storageMirror = new Map();
function storageGet(key) {
  const value = localStorage.getItem(key);
  storageMirror.set(key, value);
  return value;
}
function storageSet(key, value) {
  const str = String(value);
  if (storageMirror.get(key) === str) return;
  localStorage.setItem(key, str);
  storageMirror.set(key, str);
}
function storageRemove(key) {
  localStorage.removeItem(key);
  storageMirror.set(key, null);
}
// Another tab changed storage: forget what we thought those keys held.
window.addEventListener('storage', (e) => {
  if (e.key === null) storageMirror.clear();
  else storageMirror.delete(e.key);
});

// -------------------------------------------------------------
// App State Configuration
// -------------------------------------------------------------
// -------------------------------------------------------------
// Supabase Configuration (Option B Cloud Sync Settings)
// -------------------------------------------------------------
// To enable automatic cloud sync:
// 1. Create a free project at https://supabase.com
// 2. Go to Project Settings -> API and copy your URL and Anon Key.
// 3. Paste them below.
const SUPABASE_URL = 'https://umwgulwrmdlleqzkfumm.supabase.co'; 
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVtd2d1bHdybWRsbGVxemtmdW1tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY0OTI2ODYsImV4cCI6MjEwMjA2ODY4Nn0.qVROwKLelVOW2-Si_nXl0UAK5Fd1x2HHC9W0QKeogJQ'; 

let supabaseClient = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  try {
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        // Keep the user signed in indefinitely across reloads/restarts:
        // persist the session to localStorage and silently refresh the
        // access token in the background for as long as the refresh
        // token remains valid (Supabase refresh tokens don't expire from
        // inactivity by default), instead of relying on implicit defaults.
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: window.localStorage,
      },
    });
  } catch (err) {
    console.error('Failed to initialize Supabase client:', err);
  }
}

const state = {
  following: [],  // Array of { username, originalUsername, fullName, timestamp, profileUrl }
  followers: [],  // Array of { username, originalUsername, fullName, timestamp, profileUrl }
  unfollowers: [], // Array of { username, originalUsername, fullName, timestamp, profileUrl }
  unfollowed: JSON.parse(storageGet('unfollowed_users') || '[]'),  // Array of { username, originalUsername, fullName, timestamp, profileUrl }
  starred: JSON.parse(storageGet('starred_users') || '[]'), // Array of { username, originalUsername, fullName, timestamp, profileUrl }
  instagramAccounts: JSON.parse(storageGet('instagram_accounts') || '[]'), // Saved account usernames
  selectedAccountUsername: storageGet('last_active_instagram_account') || storageGet('selected_instagram_account') || null, // Currently active Instagram account
  selectedUsername: storageGet('selected_username') || null, // Currently selected username
  editingAccountIndex: -1, // Current index of account being edited (-1 for new)
  selectedIndex: -1, // Current keyboard selection index (0-indexed) in the filtered list
  pendingAutoOpen: false, // Flag to track when a return to the tab should trigger opening the next user
  autoOpenCount: 0 // Counter of profiles opened in the current auto-open sequence
};

function normalizeInstagramAccounts() {
  if (!state.instagramAccounts) {
    state.instagramAccounts = [];
    return;
  }
  state.instagramAccounts = state.instagramAccounts.map(acc => {
    if (typeof acc === 'string') {
      return { username: acc, originalUsername: acc };
    }
    return acc;
  });
}

// Action / Noise keywords to filter out of raw text lists
const EXCLUDE_KEYWORDS = new Set([
  'following', 'follow', 'followers', 'message', 'remove', 'requested', 
  'verified', 'close friends', 'mutual', 'blocked', 'suggested', 'posts',
  'search', 'log in', 'sign up', 'profile picture'
]);

// -------------------------------------------------------------
// DOM Elements Selection
// -------------------------------------------------------------
const elements = {
  html: document.documentElement,
  themeToggle: document.getElementById('theme-toggle'),
  sunIcon: document.getElementById('sun-icon'),
  moonIcon: document.getElementById('moon-icon'),
  themeToggleInMenu: document.getElementById('theme-toggle-in-menu'),
  menuSunIcon: document.getElementById('menu-sun-icon'),
  menuMoonIcon: document.getElementById('menu-moon-icon'),
  menuThemeText: document.getElementById('menu-theme-text'),
  landingThemeToggle: document.getElementById('landing-theme-toggle'),
  landingSunIcon: document.getElementById('landing-sun-icon'),
  landingMoonIcon: document.getElementById('landing-moon-icon'),
  landingThemeText: document.getElementById('landing-theme-text'),

  // Following list elements
  inputFollowing: document.getElementById('input-following'),
  clearFollowing: document.getElementById('clear-following'),
  followingCount: document.getElementById('following-count'),

  // Followers list elements
  inputFollowers: document.getElementById('input-followers'),
  clearFollowers: document.getElementById('clear-followers'),
  followersCount: document.getElementById('followers-count'),

  // Unfollowers (Results) elements
  unfollowersCount: document.getElementById('unfollowers-count'),
  searchUnfollowers: document.getElementById('search-unfollowers'),
  listUnfollowers: document.getElementById('list-unfollowers'),
  emptyState: document.getElementById('unfollowers-empty-state'),
  togglePreviewUnfollowed: document.getElementById('toggle-preview-unfollowed'),
  listUnfollowed: document.getElementById('list-unfollowed'),
  togglePreviewStarred: document.getElementById('toggle-preview-starred'),
  listStarred: document.getElementById('list-starred'),

  // Instagram Account Management elements
  accountMgmtRow: document.getElementById('account-mgmt-row'),
  accountChipsList: document.getElementById('account-chips-list'),
  btnAddAccount: document.getElementById('btn-add-account'),
  accountModalOverlay: document.getElementById('account-modal-overlay'),
  accountModalTitle: document.getElementById('account-modal-title'),
  accountUsernameInput: document.getElementById('account-username-input'),
  btnModalDelete: document.getElementById('btn-modal-delete'),
  btnModalSave: document.getElementById('btn-modal-save'),
  btnModalClose: document.getElementById('btn-modal-close'),
  accountModalOriginalCaption: document.getElementById('account-modal-original-caption'),

  // Auth & Cloud Sync DOM elements
  authBtn: document.getElementById('auth-btn'),
  userBadge: document.getElementById('user-badge'),
  authDropdown: document.getElementById('auth-dropdown'),
  authConfigWarning: document.getElementById('auth-config-warning'),
  authProfileView: document.getElementById('auth-profile-view'),
  authFormView: document.getElementById('auth-form-view'),
  tabLogin: document.getElementById('tab-login'),
  tabSignup: document.getElementById('tab-signup'),
  authForm: document.getElementById('auth-form'),
  authEmail: document.getElementById('auth-email'),
  authPassword: document.getElementById('auth-password'),
  authSubmitBtn: document.getElementById('btn-auth-submit'),
  btnForgotPassword: document.getElementById('btn-forgot-password'),
  authErrorMsg: document.getElementById('auth-error-msg'),
  authSuccessMsg: document.getElementById('auth-success-msg'),
  authUserEmail: document.getElementById('auth-user-email'),
  btnLogout: document.getElementById('btn-logout'),
  importFilesInput: document.getElementById('import-files-input'),
  importFolderInput: document.getElementById('import-folder-input'),
  addAccountDropdownMenu: document.getElementById('add-account-dropdown-menu'),
  btnUploadFiles: document.getElementById('btn-upload-files'),
  btnUploadFolder: document.getElementById('btn-upload-folder'),
  btnInstructionsInfo: document.getElementById('btn-instructions-info'),
  btnEmptyInstructions: document.getElementById('btn-empty-instructions'),
  instructionsModalOverlay: document.getElementById('instructions-modal-overlay'),
  btnInstructionsModalClose: document.getElementById('btn-instructions-modal-close'),
  btnInstructionsPrev: document.getElementById('btn-instructions-prev'),
  btnInstructionsNext: document.getElementById('btn-instructions-next'),
  btnInstructionsBack: document.getElementById('btn-instructions-back'),
  instructionsNavIndicator: document.getElementById('instructions-nav-indicator'),

  appGrid: document.querySelector('.app-grid'),
  appContainer: document.querySelector('.app-container')
};

// Original home of the live app grid inside the landing page's preview
// section, so it can be moved back there when the user logs out.
const appGridLandingHome = elements.appGrid ? elements.appGrid.parentElement : null;

// -------------------------------------------------------------
// Theme Management (Light/Dark)
// -------------------------------------------------------------
function initTheme() {
  const savedTheme = storageGet('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const activeTheme = savedTheme || (prefersDark ? 'dark' : 'light');
  
  setTheme(activeTheme);
  
  // Listen to system changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!storageGet('theme')) {
      setTheme(e.matches ? 'dark' : 'light');
    }
  });

  const toggleTheme = () => {
    const currentTheme = elements.html.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    storageSet('theme', newTheme);
    setTheme(newTheme);
  };

  if (elements.themeToggle) {
    elements.themeToggle.addEventListener('click', toggleTheme);
  }
  if (elements.themeToggleInMenu) {
    elements.themeToggleInMenu.addEventListener('click', toggleTheme);
  }
  if (elements.landingThemeToggle) {
    elements.landingThemeToggle.addEventListener('click', toggleTheme);
  }
}

function setTheme(theme) {
  elements.html.setAttribute('data-theme', theme);
  document.querySelector('meta[name="color-scheme"]').setAttribute('content', theme);
  
  let themeColorMeta = document.getElementById('theme-color-meta');
  if (!themeColorMeta) {
    themeColorMeta = document.createElement('meta');
    themeColorMeta.name = 'theme-color';
    themeColorMeta.id = 'theme-color-meta';
    document.head.appendChild(themeColorMeta);
  }
  themeColorMeta.setAttribute('content', theme === 'dark' ? '#09090b' : '#fafafa');
}

// Custom Site Pop-up Confirm & Alert Modal Helpers
// Popups fade out over 600ms and only then get .hidden (and any reset).
// Reopening one inside that window used to let the old close's timer fire
// afterwards and hide the freshly opened popup (and, for the account
// modal, forget which account was being edited). Opening now cancels any
// pending hide for that popup.
const pendingOverlayHides = new WeakMap();
function scheduleOverlayHide(overlay, fn, delay = 600) {
  cancelOverlayHide(overlay);
  overlay._showToken = null; // closed before it finished opening: stay closed
  pendingOverlayHides.set(overlay, setTimeout(() => {
    pendingOverlayHides.delete(overlay);
    fn();
  }, delay));
}
function cancelOverlayHide(overlay) {
  const timer = pendingOverlayHides.get(overlay);
  if (timer) {
    clearTimeout(timer);
    pendingOverlayHides.delete(overlay);
  }
}

// Shows a pop-up (.modal-overlay) with the same enter animation as the
// submenus. Its hidden starting state is committed first: showing it and
// starting the animation in the same frame let Safari skip straight to the
// end, so pop-ups often just appeared.
// Every tab switcher in the app (list 3's views, the changes tabs, the
// instructions steps, log in / sign up) moves its content the same way: a
// sideways slide on the instructions window's opening timing (600ms, fast
// then settling) with a soft fade on its own gentler timing.
// The instructions window's own timing: what leaves goes like the window
// closing (450ms, an even ease), what arrives comes like it opening
// (600ms, fast then settling gently). Slide and fade share each timing so
// they move as one.
// A page slide: both pages stay (nearly) solid and move edge to edge on an
// even ease, so the slide itself is what you see. (Fading them out
// and in, on a fast-start curve, read as the new page snapping in.) Only a
// light dim on the way out and back up on the way in.
const TAB_MOTION = {
  in: { duration: 720, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }
};
TAB_MOTION.out = TAB_MOTION.in;
TAB_MOTION.slide = TAB_MOTION.in; // (older name, kept for callers)
function tabSlideOut(el, dx) {
  return el.animate([
    { transform: 'translateX(0)', opacity: 1 },
    { transform: `translateX(${dx}px)`, opacity: 0.35 }
  ], { ...TAB_MOTION.in, fill: 'forwards' });
}
function tabSlideIn(el, dx) {
  return el.animate([
    { transform: `translateX(${dx}px)`, opacity: 0.35 },
    { transform: 'translateX(0)', opacity: 1 }
  ], TAB_MOTION.in);
}
window.TAB_MOTION = TAB_MOTION;
window.tabSlideOut = tabSlideOut;
window.tabSlideIn = tabSlideIn;

// "1 day", "3 days": words spelled out, never "3d".
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function showModalOverlay(overlay) {
  cancelOverlayHide(overlay);
  overlay.classList.remove('hidden');
  void overlay.offsetWidth;
  // Drawn once invisible first, then faded in: a first open (building the
  // window, its pictures, the blur) used to eat the fade's first frames,
  // so it looked like a snap.
  const token = (overlay._showToken = {});
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (overlay._showToken === token && !overlay.classList.contains('hidden')) overlay.classList.add('show');
  }));
}

function showSiteConfirm(title, message, confirmText = 'confirm', cancelText = 'cancel') {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-modal-overlay');
    const titleEl = document.getElementById('confirm-modal-title');
    const msgEl = document.getElementById('confirm-modal-msg');
    const cancelBtn = document.getElementById('btn-confirm-cancel');
    const okBtn = document.getElementById('btn-confirm-ok');
    const closeBtn = document.getElementById('btn-confirm-close');

    if (!overlay || !titleEl || !msgEl || !okBtn) {
      resolve(window.confirm(message));
      return;
    }

    titleEl.textContent = title.toLowerCase();
    msgEl.textContent = message.toLowerCase();
    okBtn.textContent = confirmText.toLowerCase();

    if (cancelText) {
      cancelBtn.style.display = 'inline-flex';
      cancelBtn.textContent = cancelText.toLowerCase();
    } else {
      cancelBtn.style.display = 'none';
    }

    overlay.classList.remove('fade-out-bounce');
    showModalOverlay(overlay);

    function cleanup() {
      overlay.classList.add('fade-out-bounce');
      overlay.classList.remove('show');
      scheduleOverlayHide(overlay, () => {
        overlay.classList.add('hidden');
        overlay.classList.remove('fade-out-bounce');
      });
      okBtn.removeEventListener('click', onOk);
      if (cancelBtn) cancelBtn.removeEventListener('click', onCancel);
      if (closeBtn) closeBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
    }

    function onOk() {
      cleanup();
      resolve(true);
    }

    function onCancel() {
      cleanup();
      resolve(false);
    }

    function onOverlayClick(e) {
      if (e.target === overlay) {
        onCancel();
      }
    }

    okBtn.addEventListener('click', onOk);
    if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
    if (closeBtn) closeBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
  });
}

function showSiteAlert(title, message) {
  return showSiteConfirm(title, message, 'ok', null);
}

// -------------------------------------------------------------
// Date Formatting Helpers
// -------------------------------------------------------------
function formatDate(dateVal) {
  if (!dateVal) return '';
  
  let date = dateVal;
  if (typeof dateVal === 'string' || typeof dateVal === 'number') {
    date = new Date(dateVal);
  }
  
  if (isNaN(date.getTime())) {
    return '';
  }

  const formatted = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date);
  return formatted.toLowerCase();
}

// -------------------------------------------------------------
// Parsing Core Logic
// -------------------------------------------------------------

/**
 * Normalizes a username for accurate set comparisons.
 */
// Usernames, names and profile links come from imported files (and from
// cloud/localStorage copies of them), so they're untrusted: always escape
// them before putting them in HTML, and only ever link/open real Instagram
// profile URLs. A crafted "export" could otherwise inject markup that runs
// as script (e.g. a username like <img onerror=...>) or a javascript: link.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const INSTAGRAM_URL_PATTERN = /^https?:\/\/(www\.)?instagram\.com\/[^\s"'<>]*$/i;

function safeProfileUrl(user) {
  const url = user && typeof user.profileUrl === 'string' ? user.profileUrl.trim() : '';
  if (INSTAGRAM_URL_PATTERN.test(url)) return url;
  const name = String((user && (user.originalUsername || user.username)) || '').replace(/^@+/, '');
  return `https://www.instagram.com/${encodeURIComponent(name)}/`;
}

function normalizeUsername(username) {
  if (!username) return '';
  return username.replace(/^@/, '').trim().toLowerCase();
}

/**
 * Validates whether a token matches Instagram's username criteria.
 */
function isValidUsername(str) {
  // Instagram usernames: 1-30 chars, letters, numbers, underscores, periods.
  return /^[a-zA-Z0-9._]{1,30}$/.test(str);
}

/**
 * Attempts to parse text content as JSON and extract user entries recursively.
 */
// "https://www.instagram.com/_u/name/" or "/name" -> "name" (null if none).
function usernameFromProfileHref(href) {
  if (typeof href !== 'string' || !href) return null;
  let path = href;
  try { path = new URL(href, 'https://www.instagram.com').pathname; } catch (e) { /* use as-is */ }
  const parts = path.split('/').filter(Boolean).filter(part => part !== '_u');
  const name = parts[0] || '';
  return /^[A-Za-z0-9._]{1,30}$/.test(name) ? name : null;
}

function parseJSON(text) {
  try {
    const data = JSON.parse(text);
    const results = [];
    
    // Recursive scanner to find objects matching Instagram relationships structure
    function scan(obj) {
      if (!obj || typeof obj !== 'object') return;
      
      // Look for entries containing values like href and value
      if (obj.value && obj.href && (obj.href.includes('instagram.com') || obj.href.startsWith('/'))) {
        const username = obj.value;
        const timestamp = obj.timestamp ? new Date(obj.timestamp * 1000) : null;
        results.push({
          username: normalizeUsername(username),
          originalUsername: username,
          fullName: '',
          timestamp: timestamp,
          profileUrl: obj.href.startsWith('/') ? `https://www.instagram.com${obj.href}` : obj.href
        });
        return;
      }
      
      // Look for relationship lists containing string_list_data. Older
      // exports put the username in each item's `value`; newer ones (e.g.
      // following.json) leave it out and give it as the entry's `title`,
      // or only in the profile link.
      if (Array.isArray(obj.string_list_data)) {
        obj.string_list_data.forEach(item => {
          const username = (item && item.value) || (typeof obj.title === 'string' && obj.title.trim()) || usernameFromProfileHref(item && item.href);
          if (username) {
            const timestamp = item.timestamp ? new Date(item.timestamp * 1000) : null;
            results.push({
              username: normalizeUsername(username),
              originalUsername: username,
              fullName: '',
              timestamp: timestamp,
              profileUrl: item.href || `https://www.instagram.com/${username}/`
            });
          }
        });
        return;
      }

      // Recurse down arrays or nested objects
      if (Array.isArray(obj)) {
        obj.forEach(item => scan(item));
      } else {
        Object.keys(obj).forEach(key => scan(obj[key]));
      }
    }
    
    scan(data);
    return results.length > 0 ? results : null;
  } catch (e) {
    return null; // Not valid JSON
  }
}

/**
 * Parses text content as HTML and extracts user elements.
 */
function parseHTML(text) {
  if (!text || (!text.includes('<a') && !text.includes('<div') && !text.includes('<table'))) return null;
  
  const isPendingDoc = text.toLowerCase().includes('pending follow request') || text.toLowerCase().includes('pending_follow_requests');

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/html');
    const results = [];
    const seenUsernames = new Set();

    // 1. Try Meta HTML table format (like pending_follow_requests.html where usernames are in <td>)
    const tables = doc.querySelectorAll('table');
    tables.forEach(table => {
      let username = '';
      let fullName = '';
      const rows = table.querySelectorAll('tr');
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
          const labelText = cells[0].textContent.trim().toLowerCase();
          const valText = cells[1].textContent.trim();
          if (labelText === 'username' || labelText.includes('username')) {
            username = valText;
          } else if (labelText === 'name' || labelText.includes('name')) {
            fullName = valText;
          }
        }
      });

      if (username && isValidUsername(username) && !EXCLUDE_KEYWORDS.has(username.toLowerCase())) {
        const norm = normalizeUsername(username);
        if (!seenUsernames.has(norm)) {
          seenUsernames.add(norm);

          let timestamp = null;
          let parent = table.parentElement;
          let searchCount = 0;
          while (parent && searchCount < 4) {
            const siblingText = parent.textContent || '';
            const dateMatch = siblingText.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/i) || 
                              siblingText.match(/\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}/i);
            if (dateMatch && !timestamp) {
              const parsedDate = Date.parse(dateMatch[0]);
              if (!isNaN(parsedDate)) {
                timestamp = new Date(parsedDate);
              }
            }
            parent = parent.parentElement;
            searchCount++;
          }

          results.push({
            username: norm,
            originalUsername: username,
            fullName: fullName,
            timestamp: timestamp,
            profileUrl: `https://www.instagram.com/${username}`,
            isPendingRequest: isPendingDoc
          });
        }
      }
    });

    // 2. Try anchor-based HTML format (traditional Instagram HTML exports)
    const anchors = doc.querySelectorAll('a');
    anchors.forEach(a => {
      const href = a.getAttribute('href') || '';
      if (href.includes('instagram.com/') || href.match(/^\/[a-zA-Z0-9._]+$/) || a.textContent.trim().match(/^[a-zA-Z0-9._]{1,30}$/)) {
        let username = a.textContent.trim();
        
        if (!username || username.includes(' ') || !isValidUsername(username)) {
          const parts = href.split('/').filter(Boolean);
          const possibleUser = parts[parts.length - 1]?.split('?')[0];
          if (possibleUser && isValidUsername(possibleUser)) {
            username = possibleUser;
          } else {
            return;
          }
        }
        
        if (EXCLUDE_KEYWORDS.has(username.toLowerCase())) return;
        const norm = normalizeUsername(username);
        if (seenUsernames.has(norm)) return;
        seenUsernames.add(norm);

        let timestamp = null;
        let parent = a.parentElement;
        let searchCount = 0;
        while (parent && searchCount < 3) {
          const siblingText = parent.textContent || '';
          const dateMatch = siblingText.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}/i) || 
                            siblingText.match(/\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}/i);
          if (dateMatch && !timestamp) {
            const parsedDate = Date.parse(dateMatch[0]);
            if (!isNaN(parsedDate)) {
              timestamp = new Date(parsedDate);
            }
          }
          parent = parent.parentElement;
          searchCount++;
        }

        results.push({
          username: norm,
          originalUsername: username,
          fullName: '',
          timestamp: timestamp,
          profileUrl: href.startsWith('/') ? `https://www.instagram.com${href}` : (href.includes('instagram.com') ? href : `https://www.instagram.com/${username}`),
          isPendingRequest: isPendingDoc
        });
      }
    });

    return results.length > 0 ? results : null;
  } catch (e) {
    return null;
  }
}

/**
 * Parses raw text line-by-line using a state-machine looking for username structures.
 */
function parseRawText(text) {
  const lines = text.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  const results = [];
  let i = 0;
  
  while (i < lines.length) {
    let line = lines[i];

    // Clean lines like "@username" or "username's profile picture"
    if (line.startsWith('@')) {
      line = line.substring(1);
    }
    if (line.toLowerCase().endsWith("'s profile picture")) {
      line = line.substring(0, line.length - 18).trim();
    }

    const cleanLower = line.toLowerCase();
    
    // Check if line looks like a valid username
    if (isValidUsername(line) && !EXCLUDE_KEYWORDS.has(cleanLower)) {
      let fullName = '';
      let timestamp = null;
      let advance = 1;

      // Lookahead at next 1-2 lines for names, dates, or buttons
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        const nextLower = nextLine.toLowerCase();

        // If next line is not a valid username and not a standard button action, it's likely a Full Name
        if (!isValidUsername(nextLine) && !EXCLUDE_KEYWORDS.has(nextLower) && !nextLine.includes('/') && !nextLine.includes('@')) {
          fullName = nextLine;
          advance = 2;

          // Look at second next line for action/dates
          if (i + 2 < lines.length) {
            const thirdLine = lines[i + 2];
            const thirdLower = thirdLine.toLowerCase();
            if (EXCLUDE_KEYWORDS.has(thirdLower)) {
              advance = 3;
            }
          }
        } else if (EXCLUDE_KEYWORDS.has(nextLower)) {
          advance = 2; // Skip buttons like "Following"
        }
      }

      results.push({
        username: normalizeUsername(line),
        originalUsername: line,
        fullName: fullName,
        timestamp: null, // Text copies rarely contain dates
        profileUrl: `https://www.instagram.com/${line}/`
      });

      i += advance;
    } else {
      i++;
    }
  }

  return results;
}

/**
 * Universal Entry Parser - automatically routes text to JSON, HTML, or raw text parser.
 */
function parseInput(text) {
  if (!text || text.trim() === '') return [];

  // 1. Try parsing JSON
  const jsonResults = parseJSON(text);
  if (jsonResults) return jsonResults;

  // 2. Try parsing HTML
  const htmlResults = parseHTML(text);
  if (htmlResults) return htmlResults;

  // 3. Fallback to smart line-by-line raw text parsing
  return parseRawText(text);
}

// -------------------------------------------------------------
// Comparison Mathematics & State Updates
// -------------------------------------------------------------

/**
 * Performs the core set difference math: NotFollowingBack = Following - Followers.
 */
let isSyncingFromCloud = false;

// { animate: true } when list 1/2 were just edited or cleared by the user,
// so list 3's rows slide out/in/along instead of snapping (see
// updateResultsUI). Loads, imports and cloud syncs stay instant.
function calculateUnfollowers({ animate = false, matchRenames = false } = {}) {
  const followersSet = new Set(state.followers.map(user => user.username));
  const unfollowedSet = new Set(state.unfollowed.map(user => user.username));
  const starredSet = new Set(state.starred.map(user => user.username));
  
  // Math difference: filter out any 'following' users that are in the 'followers' set, unfollowed list, or starred list
  state.unfollowers = state.following.filter(user => 
    !followersSet.has(user.username) && 
    !unfollowedSet.has(user.username) &&
    !starredSet.has(user.username)
  );
  
  updateResultsUI({ animate, matchRenames });
  updateUnfollowedUI();
  updateStarredUI();

  // Sync state changes with the cloud automatically
  if (!isSyncingFromCloud) {
    pushToCloud();
  }
}

// Every empty text ("no …") leaves the same way: a copy of it fades out
// right where it was (0.32s), laid over its box, while whatever replaces
// it comes in — instead of vanishing. (One fade for all of them; they
// come in with the same fade.)
const EMPTY_FADE = { duration: 320, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' };
function fadeGhostOut(el) {
  const play = captureGhost(el);
  if (play) play();
}
// The copy, measured now (before anything around it changes); the
// returned function lays it over its old spot and fades it out — for a
// caller that redraws the host first (which would wipe a copy added now).
function captureGhost(el) {
  if (!el || !el.getClientRects().length || typeof el.animate !== 'function') return null;
  const host = el.closest('.results-container, .dropdown-menu, .saved-imports-list') || document.body;
  const hr = host.getBoundingClientRect(), r = el.getBoundingClientRect();
  const k = host.offsetWidth ? hr.width / host.offsetWidth : 1;
  const ghost = el.cloneNode(true);
  ghost.classList.remove('empty-enter');
  Object.assign(ghost.style, {
    position: 'absolute', inset: 'auto', margin: '0', transform: 'none', animation: 'none',
    top: `${(r.top - hr.top) / k - host.clientTop + host.scrollTop}px`, left: `${(r.left - hr.left) / k - host.clientLeft}px`,
    width: `${r.width / k}px`, height: `${r.height / k}px`, boxSizing: 'border-box',
    display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', pointerEvents: 'none', zIndex: '3'
  });
  ghost.style.setProperty('padding', getComputedStyle(el).padding, 'important');
  return () => {
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(ghost);
    const drop = () => ghost.remove();
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], { ...EMPTY_FADE, fill: 'forwards' }).finished.then(drop, drop);
    setTimeout(drop, 800);
  };
}
function fadeEmptyIn(el, delay = 0) {
  if (el && typeof el.animate === 'function') el.animate([{ opacity: 0 }, { opacity: 1 }], { ...EMPTY_FADE, delay, fill: 'backwards' });
}

// The unfollowed/starred panels' rows on screen (before a redraw), and the
// ones gone after it slid out like a removed row — pinned where they were
// drawn, over the redrawn list (an undo taking usernames away, say).
function capturePanelRows(listEl) {
  const rows = new Map();
  listEl.querySelectorAll('.parsed-item:not(.username-exit)').forEach(row => {
    if (!row.dataset.username) return;
    rows.set(row.dataset.username, { row, rect: row.getBoundingClientRect(), pitch: row.offsetHeight + (parseFloat(getComputedStyle(row).marginBottom) || 0) });
  });
  return rows;
}
function slidePanelRowsOut(container, before, stillThere) {
  if (!container || !before.size) return;
  const cr = container.getBoundingClientRect();
  const k = container.offsetWidth ? cr.width / container.offsetWidth : 1;
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  let any = false;
  before.forEach(({ row, rect, pitch }, name) => {
    if (stillThere.has(name) || rect.bottom <= cr.top || rect.top >= cr.bottom + pitch) return;
    stopRowMotion(row);
    row.classList.add('username-exit');
    Object.assign(row.style, {
      position: 'absolute', top: `${(rect.top - cr.top) / k - container.clientTop + container.scrollTop}px`,
      left: `${(rect.left - cr.left) / k - container.clientLeft}px`, width: `${rect.width / k}px`, margin: '0', zIndex: '1'
    });
    container.appendChild(row);
    slideRowOut(row, pitch, ROW_MOTION_MS, () => row.remove());
    any = true;
  });
  if (any) stepRowMotion();
}

// The panel's empty text, when its first username comes in: it fades out
// where it was (captureGhost, measured before the redraw) instead of
// vanishing — the same fade it came in with.
// The first username back in an open, empty panel (an undo, say): the
// reverse of removing the last one — there the row slides out and then
// the empty text fades in; here the empty text fades out first (the
// panel holding its size), and only then does the row slide in, the
// panel easing to its new height with it.
const pendingPanelEntries = new WeakMap();
function cancelPanelEntry(listEl) {
  const cancel = pendingPanelEntries.get(listEl);
  if (cancel) cancel();
}
function enterAfterEmptyFades(listEl, scrollItems, startHeight) {
  listEl.style.height = `${startHeight}px`;
  scrollItems.style.visibility = 'hidden';
  const reveal = () => {
    pendingPanelEntries.delete(listEl);
    clearTimeout(timer);
    listEl.style.height = '';
    scrollItems.style.visibility = '';
  };
  const timer = setTimeout(() => {
    reveal();
    if (!scrollItems.isConnected) return;
    animatePanelHeightChange(listEl, listEl.classList.contains('show'), startHeight);
    animateResultsReentry(scrollItems, new Map(), new Map(), { rowSelector: '.parsed-item' });
  }, EMPTY_FADE.duration);
  pendingPanelEntries.set(listEl, reveal);
}

// `animate` adds the slow bouncy fade-in (.empty-enter, see style.css) —
// used when the panel is open and the user just removed its last row, so
// the message eases into the space that row left behind.
function getUnfollowedEmptyHtml(animate) {
  return `
      <div class="dropdown-header-bar">0 unfollowed accounts</div>
      <div class="dropdown-empty-message${animate ? ' empty-enter' : ''}">no accounts unfollowed yet</div>
    `;
}

// The unfollowed/starred toggle's empty / not-empty status: enabled with
// the green dot, or dimmed. Both change with an animation (style.css:
// .preview-toggle's opacity transition, .occupied-dot.on) — the label used
// to be rebuilt on every change, so the dot just appeared or vanished.
function setToggleOccupied(toggleBtn, occupied) {
  // Dimmed via .is-empty rather than `disabled`: a disabled button ignores
  // taps, so an open empty panel couldn't be closed from its own button.
  toggleBtn.classList.toggle('is-empty', !occupied);
  toggleBtn.setAttribute('aria-disabled', occupied ? 'false' : 'true');
  const labelEl = toggleBtn.querySelector('.btn-label-content');
  if (!labelEl) return;
  let dot = labelEl.querySelector('.occupied-dot');
  if (!dot) {
    dot = document.createElement('span');
    dot.className = 'occupied-dot';
    labelEl.appendChild(dot);
  }
  dot.classList.toggle('on', occupied);
}

function updateUnfollowedUI(enteringUsername) {
  // Only the no-account view saves from here (to its own key — see
  // saveCurrentAccountData). This used to overwrite the merged all-accounts
  // list with just the current account's usernames on every redraw.
  if (!state.selectedAccountUsername) {
    storageSet('unfollowed_users__global_', JSON.stringify(state.unfollowed));
  }
  const listData = state.unfollowed;
  const listEl = elements.listUnfollowed;
  const toggleBtn = elements.togglePreviewUnfollowed;

  const wasShown = listEl.classList.contains('show');
  const startHeight = wasShown ? listEl.offsetHeight : null;
  // A first username still waiting for the empty text to fade: show it now.
  cancelPanelEntry(listEl);
  // Measured while the panel still holds its size (unpinning below changes
  // the text's padding — measured after, its fade-out copy sat a few px off).
  const oldEmpty = wasShown ? listEl.querySelector('.dropdown-empty-message') : null;
  const fadeOldEmpty = listData.length > 0 ? captureGhost(oldEmpty) : null;
  // Items are back after the panel was held at its old size for the empty
  // state (see pinPanelHeight) — let it size to its content again;
  // animatePanelHeightChange below eases it there from startHeight.
  if (listData.length > 0) unpinPanelHeight(listEl);

  // A username added while the panel is open slides in (the same clipped
  // slide as list 3) and the rows below slide down to make room — capture
  // where they are now. Added while closed, nothing animates: it's just
  // there when the panel opens.
  // Open: every change animates (an undo can bring usernames back or take
  // them away) — rows remembered here to slide from.
  const previousRowTops = new Map();
  const previousRows = wasShown ? capturePanelRows(listEl) : new Map();
  previousRows.forEach((r, name) => previousRowTops.set(name, r.rect.top));
  // The empty state's bounce is for the moment the last username leaves,
  // not for every later redraw while the panel stays open and empty.
  const wasAlreadyEmpty = !!listEl.querySelector('.dropdown-empty-message');

  if (listData.length > 0) {
    setToggleOccupied(toggleBtn, true);

    // Render elements with a scroll container below
    listEl.innerHTML = `
      <div class="dropdown-header-bar">
        ${listData.length} ${listData.length === 1 ? 'unfollowed account' : 'unfollowed accounts'}
      </div>
      <div class="dropdown-scroll-items" style="display: flex; flex-direction: column; max-height: 440px; overflow-y: auto; width: 100%;">
        ${listData.map(user => `
          <div class="parsed-item" data-username="${escapeHtml(user.username)}" style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
            <a href="${escapeHtml(safeProfileUrl(user))}" target="_blank" rel="noopener" class="parsed-username">@${escapeHtml(user.originalUsername)}</a>
            <div style="display: flex; align-items: center; gap: 6px;">
              <div class="dropdown-actions-group">
                <button class="star-unfollowed-btn" data-username="${escapeHtml(user.username)}" aria-label="star this account" style="border: none; background: transparent; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--text-main); padding: 2px;" title="move to the starred list">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                  </svg>
                </button>
                <button class="remove-unfollowed-btn" data-username="${escapeHtml(user.username)}" aria-label="remove from the unfollowed list" style="border: none; background: transparent; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 2px;" title="remove and put back in list 3">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
    if (fadeOldEmpty) fadeOldEmpty();
    const scrollItems = listEl.querySelector('.dropdown-scroll-items');
    if (fadeOldEmpty && scrollItems) {
      enterAfterEmptyFades(listEl, scrollItems, startHeight);
    } else {
      animatePanelHeightChange(listEl, wasShown, startHeight);
      if (wasShown && scrollItems) {
        animateResultsReentry(scrollItems, previousRowTops, new Map(), { rowSelector: '.parsed-item' });
        slidePanelRowsOut(scrollItems, previousRows, new Set(listData.map(u => u.username)));
      }
    }
  } else {
    setToggleOccupied(toggleBtn, false);
    // Used to force-close the panel here the instant the list emptied
    // out, even if the user still had it open and was looking at it —
    // surprising and unwanted. Now it just shows an empty state and
    // leaves .show/.active exactly as they already were: still open if
    // it was open (closable by clicking outside, same as any other
    // dropdown), still closed if it was closed.
    listEl.innerHTML = getUnfollowedEmptyHtml(wasShown && !wasAlreadyEmpty);
    animatePanelHeightChange(listEl, wasShown, startHeight);
    slidePanelRowsOut(listEl, previousRows, new Set());
  }

  const resetUnfollowedBtn = document.getElementById('settings-reset-unfollowed-btn');
  if (resetUnfollowedBtn) {
    if (state.unfollowed.length > 0) {
      resetUnfollowedBtn.removeAttribute('disabled');
    } else {
      resetUnfollowedBtn.setAttribute('disabled', 'true');
    }
    updateResetReminderUI();
  }

  // After the label update above, since the occupied-dot indicator it can
  // add/remove changes the button's own rendered width.
  syncDropdownWidthToButton(listEl, toggleBtn);
}

// See getUnfollowedEmptyHtml's comment — same, for the starred submenu.
function getStarredEmptyHtml(animate) {
  return `
      <div class="dropdown-header-bar">0 starred accounts</div>
      <div class="dropdown-empty-message${animate ? ' empty-enter' : ''}">no accounts starred yet</div>
    `;
}

function updateStarredUI(enteringUsername) {
  const listData = state.starred;
  const listEl = elements.listStarred;
  const toggleBtn = elements.togglePreviewStarred;

  const wasShown = listEl.classList.contains('show');
  const startHeight = wasShown ? listEl.offsetHeight : null;
  // A first username still waiting for the empty text to fade: show it now.
  cancelPanelEntry(listEl);
  // Measured while the panel still holds its size (unpinning below changes
  // the text's padding — measured after, its fade-out copy sat a few px off).
  const oldEmpty = wasShown ? listEl.querySelector('.dropdown-empty-message') : null;
  const fadeOldEmpty = listData.length > 0 ? captureGhost(oldEmpty) : null;
  // Items are back after the panel was held at its old size for the empty
  // state (see pinPanelHeight) — let it size to its content again;
  // animatePanelHeightChange below eases it there from startHeight.
  if (listData.length > 0) unpinPanelHeight(listEl);

  // A username added while the panel is open slides in (the same clipped
  // slide as list 3) and the rows below slide down to make room — capture
  // where they are now. Added while closed, nothing animates: it's just
  // there when the panel opens.
  // Open: every change animates (an undo can bring usernames back or take
  // them away) — rows remembered here to slide from.
  const previousRowTops = new Map();
  const previousRows = wasShown ? capturePanelRows(listEl) : new Map();
  previousRows.forEach((r, name) => previousRowTops.set(name, r.rect.top));
  // The empty state's bounce is for the moment the last username leaves,
  // not for every later redraw while the panel stays open and empty.
  const wasAlreadyEmpty = !!listEl.querySelector('.dropdown-empty-message');

  if (listData.length > 0) {
    setToggleOccupied(toggleBtn, true);

    // Render elements (same layout as parsed-list)
    listEl.innerHTML = `
      <div class="dropdown-header-bar">
        ${listData.length} ${listData.length === 1 ? 'starred account' : 'starred accounts'}
      </div>
      <div class="dropdown-scroll-items" style="display: flex; flex-direction: column; max-height: 440px; overflow-y: auto; width: 100%;">
        ${listData.map(user => `
          <div class="parsed-item" data-username="${escapeHtml(user.username)}" style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
            <a href="${escapeHtml(safeProfileUrl(user))}" target="_blank" rel="noopener" class="parsed-username">@${escapeHtml(user.originalUsername)}</a>
            <div style="display: flex; align-items: center; gap: 6px;">
              <div class="dropdown-actions-group">
                <button class="unstar-btn" data-username="${escapeHtml(user.username)}" aria-label="unstar this account" style="border: none; background: transparent; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 2px;" title="unstar this account">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                  </svg>
                </button>
                <button class="unfollow-starred-btn" data-username="${escapeHtml(user.username)}" aria-label="move to the unfollowed list" style="border: none; background: transparent; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 2px;" title="move to the unfollowed list">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                  </svg>
                </button>
                <button class="remove-unfollowed-btn" data-username="${escapeHtml(user.username)}" aria-label="remove from the starred list" style="border: none; background: transparent; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 2px;" title="remove and put back in list 3">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
    if (fadeOldEmpty) fadeOldEmpty();
    const scrollItems = listEl.querySelector('.dropdown-scroll-items');
    if (fadeOldEmpty && scrollItems) {
      enterAfterEmptyFades(listEl, scrollItems, startHeight);
    } else {
      animatePanelHeightChange(listEl, wasShown, startHeight);
      if (wasShown && scrollItems) {
        animateResultsReentry(scrollItems, previousRowTops, new Map(), { rowSelector: '.parsed-item' });
        slidePanelRowsOut(scrollItems, previousRows, new Set(listData.map(u => u.username)));
      }
    }
  } else {
    setToggleOccupied(toggleBtn, false);
    // Used to force-close the panel here the instant the list emptied
    // out, even if the user still had it open and was looking at it —
    // surprising and unwanted. Now it just shows an empty state and
    // leaves .show/.active exactly as they already were: still open if
    // it was open (closable by clicking outside, same as any other
    // dropdown), still closed if it was closed.
    listEl.innerHTML = getStarredEmptyHtml(wasShown && !wasAlreadyEmpty);
    animatePanelHeightChange(listEl, wasShown, startHeight);
    slidePanelRowsOut(listEl, previousRows, new Set());
  }

  const resetStarredBtn = document.getElementById('settings-reset-starred-btn');
  if (resetStarredBtn) {
    if (state.starred.length > 0) {
      resetStarredBtn.removeAttribute('disabled');
    } else {
      resetStarredBtn.setAttribute('disabled', 'true');
    }
    updateResetReminderUI();
  }

  // After the label update above, since the occupied-dot indicator it can
  // add/remove changes the button's own rendered width.
  syncDropdownWidthToButton(listEl, toggleBtn);
}

/**
 * Deduplicates parsed user entries (prioritizing entries with timestamps/names).
 */
function deduplicateEntries(entries) {
  const seen = new Map();
  entries.forEach(entry => {
    const existing = seen.get(entry.username);
    if (!existing) {
      seen.set(entry.username, { ...entry });
    } else {
      seen.set(entry.username, {
        ...existing,
        ...entry,
        timestamp: entry.timestamp || existing.timestamp,
        fullName: entry.fullName || existing.fullName,
        isPendingRequest: Boolean(existing.isPendingRequest || entry.isPendingRequest)
      });
    }
  });
  return Array.from(seen.values());
}

// -------------------------------------------------------------
// UI Renderers & State Syncing
// -------------------------------------------------------------

// The lists' count badges ("N loaded" / "N found"): the number counts from
// the old to the new exactly like the timeline legend and the stat boxes
// (650ms, easing out, every number in between shows), and the pill eases
// to its new width on the same curve instead of snapping.
const COUNT_MS = 650;
function setCountBadge(el, n, word) {
  if (!el) return;
  const text = `${n} ${word}`;
  if (el._countRaf) { cancelAnimationFrame(el._countRaf); el._countRaf = null; }
  const shown = parseInt(el.textContent, 10);
  const from = Number.isFinite(el._countNow) ? el._countNow : shown;
  const startWidth = el.getBoundingClientRect().width;
  el.style.transition = 'none';
  el.style.width = '';
  el.textContent = text;
  const endWidth = el.getBoundingClientRect().width;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reset = () => {
    el._countNow = undefined;
    el._countRaf = null;
    ['transition', 'width', 'boxSizing'].forEach(p => { el.style[p] = ''; });
  };
  if (!Number.isFinite(from) || from === n || !startWidth || !endWidth || reduced) { reset(); return; }
  el.style.boxSizing = 'border-box';
  el.style.width = `${startWidth}px`;
  void el.offsetWidth;
  el.style.transition = `width ${ROW_MOTION_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`; // the list 3 slide
  el.style.width = `${endWidth}px`;
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / COUNT_MS);
    el._countNow = Math.round(from + (n - from) * (1 - Math.pow(1 - t, 3)));
    el.textContent = `${el._countNow} ${word}`;
    if (t < 1 && el.isConnected) el._countRaf = requestAnimationFrame(step);
    else { el.textContent = text; reset(); }
  };
  el.textContent = `${from} ${word}`;
  el._countRaf = requestAnimationFrame(step);
}

function updateListUI(type) {
  const listData = state[type];
  const countBadge = elements[`${type}Count`];
  setCountBadge(countBadge, listData.length, 'loaded');

  // Dynamically show or hide the actions container (Clear button)
  const textarea = type === 'following' ? elements.inputFollowing : elements.inputFollowers;
  const actionsContainer = document.getElementById(`actions-${type}`);
  if (actionsContainer) {
    if (textarea.value.trim() === '') {
      actionsContainer.classList.remove('show');
    } else {
      actionsContainer.classList.add('show');
    }
  }
}

function renderUnfollowerRowHtml(user, index) {
  // Get display initials for profile avatar fallback
  const initials = escapeHtml(user.originalUsername.substring(0, 2));
  const profileHref = escapeHtml(safeProfileUrl(user));
  const isSelected = index === state.selectedIndex;
  
  return `
    <div class="user-row${isSelected ? ' selected' : ''}" data-username="${escapeHtml(user.username)}" data-index="${index}">
      <div class="user-info">
        <a href="${profileHref}" target="_blank" rel="noopener" class="user-avatar-link" title="visit instagram profile">
          <div class="user-avatar">${initials}</div>
        </a>
        <div class="user-details">
          <a href="${profileHref}" target="_blank" rel="noopener" class="user-link">
            @${escapeHtml(user.originalUsername)}
          </a>
          ${user.fullName ? `<span class="user-fullname">${escapeHtml(user.fullName)}</span>` : ''}
        </div>
      </div>
      <div class="user-meta">
        <div class="user-row-actions">
          <button class="action-star" aria-label="star this account" title="star this account to keep it out of the results">
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
            </svg>
          </button>
          <button class="action-delete" aria-label="unfollow this account" title="unfollow without opening the profile">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
          <a href="${profileHref}" target="_blank" rel="noopener" class="action-arrow" aria-label="visit instagram profile" title="visit instagram profile">
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <line x1="5" y1="12" x2="19" y2="12"></line>
              <polyline points="12 5 19 12 12 19"></polyline>
            </svg>
          </a>
          <button class="action-dismiss" aria-label="remove from list 3" title="remove from the list without adding it to unfollowed or starred">
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>
    </div>
  `;
}

// Pass { animate: true } when list 3's contents change because of something
// the user just did elsewhere (a username removed from the unfollowed/
// starred submenus, list 1/2 edited or cleared): rows that weren't there
// before slide into existence, rows that are gone slide out exactly like
// a deleted row does (slideRowOut), and rows in both slide to their new
// positions instead of jumping. Plain re-renders (search, loads) stay
// instant.
// `matchRenames`: list 1/2 are being typed in, so a username that just
// extends or shortens one already shown (@co -> @coo) is the same row
// being edited — it updates in place instead of sliding out and back in
// after every pause in typing.
// List 3 with nothing in it says so ("no unfollowers", or "no matches"
// while searching), centered in the box; `fade`: it fades in, once the last
// rows have slid out.
function showResultsEmpty(fade) {
  const el = elements.emptyState;
  const text = elements.searchUnfollowers.value.trim() ? 'no matches' : 'no unfollowers';
  if (el.textContent.trim() !== text) el.innerHTML = `<div class="dropdown-empty-message">${text}</div>`;
  const was = !el.classList.contains('hidden');
  el.classList.remove('hidden');
  if (window.igFeatures && window.igFeatures.centerEmpties) window.igFeatures.centerEmpties();
  if (fade && !was) fadeEmptyIn(el);
}

// Opens someone's Instagram profile: on a phone straight in the Instagram
// app (a profile opened from code, rather than a tapped link, went through
// the website in the browser first); on a computer the website, in a new
// tab. No app on the phone: the website after a moment.
const IS_PHONE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function openInstagramProfile(username, webUrl) {
  const url = webUrl || `https://www.instagram.com/${encodeURIComponent(username || '')}/`;
  const native = window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform();
  if (!IS_PHONE || native || !username) { window.open(url, '_blank'); return; }
  let left = false;
  const onHide = () => { if (document.hidden) left = true; };
  document.addEventListener('visibilitychange', onHide);
  window.location.href = `instagram://user?username=${encodeURIComponent(username)}`;
  setTimeout(() => {
    document.removeEventListener('visibilitychange', onHide);
    if (!left && !document.hidden) window.location.href = url;
  }, 1600);
}

// The version at the bottom of the settings panel: the sum of the app's
// three files' version tags (index.html), which goes up with every update
// — so it shows whether this device has the latest.
// (Worked out once the page has loaded: features.js comes after this file,
// and counting before it was there left its number out.)
function showAppVersion() {
  const el = document.getElementById('app-version');
  if (!el) return;
  const total = ['style.css', 'script.js', 'features.js'].reduce((sum, file) => {
    const tag = document.querySelector(`link[href*="${file}"], script[src*="${file}"]`);
    const v = tag && /[?&]v=(\d+)/.exec(tag.getAttribute('href') || tag.getAttribute('src'));
    return sum + (v ? +v[1] : 0);
  }, 0);
  if (total) el.textContent = `version ${total}`;
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showAppVersion);
else showAppVersion();

// Tapping the version reloads the whole page from scratch — in the browser,
// the installed web app and the phone app alike: the offline copies (the
// service worker and its cache) are dropped first, so nothing stale can
// answer the reload.
async function forceReload() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch (_) { /* reload anyway */ }
  window.location.reload();
}
(() => {
  const el = document.getElementById('app-version');
  if (!el) return;
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.title = 'reload the app';
  el.addEventListener('click', forceReload);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); forceReload(); }
  });
})();

function updateResultsUI({ animate = false, matchRenames = false } = {}) {
  const listEl = elements.listUnfollowers;
  listEl._rowTailToken = null; // this render decides the rows now

  // A chip picked or files imported: a new list, so every username slides
  // in together. A username that was already on screen (in both accounts,
  // say) used to just stay put, the one row not animating while the rest
  // came in. The rows on screen are set apart so they leave like the rest.
  if (state.freshRows) {
    state.freshRows = false;
    if (animate) listEl.querySelectorAll('.user-row:not(.username-exit)').forEach(row => { row.dataset.username = `\u0000${row.dataset.username}`; });
  }

  // Rows still sliding out from an earlier change survive this re-render
  // instead of being wiped mid-slide:
  //  - ones the user removed (exitListRow: star/delete/dismiss/click) are
  //    only dropped from state once their slide ends, so until then they're
  //    also kept out of the new render — otherwise the username was drawn
  //    again as a normal row and stuck around after state dropped it.
  //  - ones leaving because the list changed (animateResultsExits,
  //    data-render-exit) keep sliding out, unless their username is back
  //    in the new render, in which case it reverses from where it is.
  const exitingRows = Array.from(listEl.querySelectorAll('.user-row.username-exit'));
  const pendingRemoval = new Set(exitingRows.filter(r => !r.dataset.renderExit).map(r => r.dataset.username));
  const resumeTops = new Map();
  exitingRows.filter(r => r.dataset.renderExit).forEach(r => {
    resumeTops.set(r.dataset.username, r.getBoundingClientRect().top);
  });
  // With a removal mid-slide, the rows around it are mid-slide too, so
  // carry them over smoothly even on an otherwise instant re-render.
  const flip = animate || exitingRows.length > 0;

  const previousTops = new Map();
  const previousRows = new Map(); // row element -> its on-screen box before the re-render
  const renamedFrom = new Map(); // new username -> row element it's an edit of
  const listWasHidden = listEl.classList.contains('hidden');
  // Screen boxes are only needed if the list is about to empty out (its
  // rows then slide out from exactly where they are — see
  // animateResultsExits); measuring every row otherwise cost a noticeable
  // chunk of each update with a few hundred rows.
  // true/false when it's cheap to tell; null (so: measure) with a search
  // filter active, where it depends on what matches.
  const willEmpty = elements.searchUnfollowers.value.trim()
    ? null
    : state.unfollowers.every(u => pendingRemoval.has(u.username));
  if (flip && !listWasHidden) {
    const liveRows = listEl.querySelectorAll('.user-row:not(.username-exit)');
    const firstRow = liveRows[0];
    const rowGap = firstRow ? (parseFloat(getComputedStyle(firstRow).marginBottom) || 0) : 0;
    liveRows.forEach(row => {
      previousTops.set(row.dataset.username, null);
      previousRows.set(row, null);
    });
    if (willEmpty !== false) {
      liveRows.forEach(row => {
        const rect = row.getBoundingClientRect();
        previousTops.set(row.dataset.username, rect.top);
        previousRows.set(row, {
          top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width,
          pitch: row.offsetHeight + rowGap
        });
      });
    }
  }

  const count = state.unfollowers.length;
  setCountBadge(elements.unfollowersCount, count, 'found');

  const query = elements.searchUnfollowers.value.toLowerCase().trim();
  const filtered = state.unfollowers.filter(user => 
    !pendingRemoval.has(user.username) && (
    user.originalUsername.toLowerCase().includes(query) || 
    (user.fullName && user.fullName.toLowerCase().includes(query)))
  );

  if (matchRenames && animate) {
    const newNames = new Set(filtered.map(u => u.username));
    const gone = [...previousRows.keys()].filter(row => !newNames.has(row.dataset.username));
    filtered.forEach(user => {
      const name = user.username;
      if (previousTops.has(name)) return;
      const match = gone.find(row => {
        const old = row.dataset.username;
        return name.startsWith(old) || old.startsWith(name);
      });
      if (!match) return;
      previousTops.set(name, previousTops.get(match.dataset.username));
      renamedFrom.set(name, match);
      previousRows.delete(match); // edited, not leaving
      gone.splice(gone.indexOf(match), 1);
    });
  }
  const keptExits = exitingRows.filter(r => !r.dataset.renderExit || !filtered.some(u => u.username === r.dataset.username));

  // Restore saved selected username state on page reload / filter update
  const savedSelectedUsername = state.selectedUsername || storageGet('selected_username');
  if (savedSelectedUsername && filtered.length > 0) {
    // Not in the list (removed, filtered out, another account's list):
    // nothing is selected — the old index used to stay and outline
    // whichever unrelated row now sat at that position.
    state.selectedIndex = filtered.findIndex(u => u.username === savedSelectedUsername);
  } else if (!savedSelectedUsername) {
    state.selectedIndex = -1;
  }

  if (filtered.length > 0) {
    if (!elements.emptyState.classList.contains('hidden')) fadeGhostOut(elements.emptyState.querySelector('.dropdown-empty-message'));
    elements.emptyState.classList.add('hidden');
    elements.listUnfollowers.classList.remove('hidden');
    
    // Only the rows that can be on screen are built now; the rest are
    // added in small batches once the slide has played (appendRowTail).
    // Building every row of a big account at once (hundreds) stalled the
    // page before the first frame of the slide could paint, so the list
    // appeared already in place instead of sliding in.
    if (flip && !listWasHidden) {
      const tail = reconcileUnfollowerRows(listEl, filtered, { animate, resumeTops, renamedFrom, keptExits });
      appendRowTail(listEl, filtered, tail, ROW_TAIL_DELAY);
    } else {
      const cut = Math.min(filtered.length, initialRowBudget(listEl));
      listEl.innerHTML = filtered.slice(0, cut).map(renderUnfollowerRowHtml).join('');
      keptExits.forEach(row => listEl.appendChild(row));
      if (flip) animateResultsReentry(listEl, previousTops, resumeTops, { enter: animate });
      appendRowTail(listEl, filtered, cut, flip ? ROW_TAIL_DELAY : 0);
    }
  } else if ((animate && previousRows.size > 0) || keptExits.length > 0) {
    // Emptied out: keep the list visible just long enough for its rows to
    // slide out, then hide it as usual (unless something refilled it).
    listEl.innerHTML = '';
    elements.emptyState.classList.add('hidden');
    keptExits.forEach(row => listEl.appendChild(row));
    if (animate) animateResultsExits(listEl, previousRows);
    const hideWhenDone = () => {
      // Rows still sliding out (their slides start on the next frame, so
      // they can finish a little after 800ms): check again shortly.
      if (listEl.querySelector('.user-row.username-exit')) {
        setTimeout(hideWhenDone, 100);
        return;
      }
      // Nothing was put back in the meantime (by any render, including a
      // search that simply matches nothing).
      if (!listEl.querySelector('.user-row:not(.username-exit)')) {
        listEl.classList.add('hidden');
        showResultsEmpty(true);
      }
    };
    setTimeout(hideWhenDone, ROW_MOTION_MS);
  } else {
    // Empty the hidden list too: rows left in it still counted for the
    // keyboard shortcuts (pressing 1 opened and unfollowed an invisible,
    // stale username — e.g. the guest demo's after logging in).
    listEl.querySelectorAll('.user-row').forEach(stopRowMotion);
    listEl.innerHTML = '';
    elements.listUnfollowers.classList.add('hidden');
    showResultsEmpty(false);
  }
}

// How many of list 3's rows to build straight away: enough to fill what
// can be on screen (the list's own scrolled view, or the window when the
// list grows with the page), plus a margin. Rows are ~62px apart; 44 is
// a safe underestimate.
const ROW_TAIL_DELAY = 600; // after list 3's slide (ROW_MOTION_MS)
function initialRowBudget(listEl) {
  const view = Math.min(listEl.clientHeight || Infinity, window.innerHeight);
  return Math.ceil((listEl.scrollTop + view) / 44) + 20;
}

// Builds list 3's rows from `from` onwards in batches, one per frame,
// after `delay` — so they never compete with the slide. A newer render
// cancels it (it builds its own).
// Long lists load in pages: LIST_PAGE usernames at first, and scrolling
// to the end shows a small loading sign, then the next LIST_PAGE come in.
// (Every row of a big account at once slowed the whole page down.)
const LIST_PAGE = 60;
const ROWS_MORE_MS = 350; // how long the loading sign shows
let rowsMoreObserver = null;
// A loading sign at the end of a list; loadNext runs once it has been
// scrolled into view (and shown for a moment). It removes itself first.
function makeRowsMore(loadNext) {
  const el = document.createElement('div');
  el.className = 'rows-more';
  el.innerHTML = '<span class="rows-more-spinner" aria-hidden="true"></span>';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-label', 'loading more');
  el._loadMore = loadNext;
  watchRowsMore(el);
  return el;
}
function watchRowsMore(el) {
  if (typeof IntersectionObserver !== 'function') { requestAnimationFrame(() => fireRowsMore(el)); return; }
  if (!rowsMoreObserver) {
    rowsMoreObserver = new IntersectionObserver(entries => entries.forEach(e => { if (e.isIntersecting) fireRowsMore(e.target); }), { rootMargin: '0px 0px 80px 0px' });
  }
  rowsMoreObserver.observe(el);
}
function fireRowsMore(el) {
  if (el._firing || !el.isConnected) return;
  el._firing = true;
  if (rowsMoreObserver) rowsMoreObserver.unobserve(el);
  el.classList.add('loading');
  setTimeout(() => {
    if (!el.isConnected) return;
    const load = el._loadMore;
    el.remove();
    if (load) load();
  }, ROWS_MORE_MS);
}

function appendRowTail(listEl, filtered, from, delay) {
  listEl.querySelectorAll(':scope > .rows-more').forEach(el => el.remove());
  if (from >= filtered.length) return;
  const token = (listEl._rowTailToken = {});
  let index = from;
  // This page: up to LIST_PAGE rows in the list (at least one batch).
  let pageEnd = Math.min(filtered.length, Math.max(LIST_PAGE, from));
  const run = () => {
    if (listEl._rowTailToken !== token) return;
    const end = Math.min(pageEnd, index + 150);
    listEl.insertAdjacentHTML('beforeend', filtered.slice(index, end)
      .map((user, i) => renderUnfollowerRowHtml(user, index + i).replace('class="user-row', 'class="user-row row-tail'))
      .join(''));
    index = end;
    if (index < pageEnd) { requestAnimationFrame(run); return; }
    reindexUnfollowerRows();
    if (index >= filtered.length) { listEl._rowTailToken = null; return; }
    listEl.appendChild(makeRowsMore(() => {
      if (listEl._rowTailToken !== token) return;
      pageEnd = Math.min(filtered.length, index + LIST_PAGE);
      requestAnimationFrame(run);
    }));
  };
  setTimeout(() => requestAnimationFrame(run), delay);
}

// Updates list 3 in place for an animated change, keeping each row that
// stays as the SAME element. A full innerHTML re-render replaced every row,
// throwing away the motion each was in the middle of (including the clip
// that tucks a row sliding in behind the one above it) — rows restarted
// from wherever they were, unclipped, so rapid changes (e.g. usernames
// coming back from the submenus one after another) looked choppy, with
// rows overlapping. Kept rows are just moved into their new order and get
// an extra shift (see the row motion engine) for how far that moved them,
// on top of whatever they were already doing.
function reconcileUnfollowerRows(listEl, filtered, { animate, resumeTops, renamedFrom, keptExits }) {
  // Reads and writes are kept in separate passes: interleaving them (read a
  // row's position, change its style, read the next…) forces a full layout
  // per row — ~100ms for a few hundred rows, all of it before the first
  // frame of the animation can paint.
  const DURATION = ROW_MOTION_MS;
  const live = new Map();
  listEl.querySelectorAll('.user-row:not(.username-exit)').forEach(row => live.set(row.dataset.username, row));
  // Rows' offsetTop is measured against the list, so it must be their
  // offset parent before the first read (not only before the writes, which
  // measured the first-ever update against a different parent).
  if (getComputedStyle(listEl).position === 'static') listEl.style.position = 'relative';

  // Build only up to what can be on screen (+ margin) now: past that, the
  // first username without a row yet is where the rest is left to
  // appendRowTail. Rows already there before it are kept as usual.
  const viewBottomEstimate = listEl.scrollTop + Math.min(listEl.clientHeight || Infinity, window.innerHeight);
  let onScreenRows = 0;
  live.forEach(row => { if (row.offsetTop < viewBottomEstimate) onScreenRows++; });
  const budget = Math.max(initialRowBudget(listEl), onScreenRows + 20);
  let cut = filtered.length;
  for (let i = budget; i < filtered.length; i++) {
    if (!live.has(filtered[i].username)) { cut = i; break; }
  }
  filtered = filtered.slice(0, cut);

  const wanted = new Set(filtered.map(u => u.username));
  const renamedEls = new Set(renamedFrom.values());

  // --- READ: where everything is before the change. Layout numbers only
  // (offsetTop/offsetHeight — cheap once laid out); per-row
  // getBoundingClientRect / getComputedStyle calls cost most of this
  // function with a few hundred rows. Visibility is judged in the list's
  // own scrolled viewport, in the same layout px.
  const listRect = listEl.getBoundingClientRect();
  const visualScale = (listRect.height / listEl.offsetHeight) || 1;
  // "On screen" is generous — a screen's height either side of the list's
  // view: the page's layout can still move right after this (a pill above
  // the list hiding, the phone's toolbar), and a row judged just out of
  // sight then showed up in place while the rest slid in.
  const margin = window.innerHeight || 800;
  const viewTop = listEl.scrollTop - margin;
  const viewBottom = listEl.scrollTop + listEl.clientHeight + margin;
  const offScreen = (top, height) => top + height <= viewTop || top >= viewBottom;
  const anyRow = live.values().next().value || listEl.querySelector('.user-row');
  const rowGap = anyRow ? (parseFloat(getComputedStyle(anyRow).marginBottom) || 0) : 0;
  const before = new Map(); // row -> { top, height, left, width }
  live.forEach(row => {
    before.set(row, { top: row.offsetTop, height: row.offsetHeight, left: row.offsetLeft, width: row.offsetWidth });
  });

  // --- WRITE: remove / pin / reorder / create.
  // A row still sliding out because of an earlier change whose username is
  // back: drop it — a fresh row reverses in from where it was (resumeTops).
  listEl.querySelectorAll('.user-row.username-exit').forEach(row => {
    if (row.dataset.renderExit && wanted.has(row.dataset.username)) {
      stopRowMotion(row);
      row.remove();
    }
  });
  // Rows leaving: pinned out of flow at their layout slot (their motion
  // keeps going), then slid out like a deleted row. Rows edited into a new
  // username (typing), or off screen, just go.
  const leaving = [];
  live.forEach((row, name) => {
    if (wanted.has(name)) return;
    const b = before.get(row);
    if (!animate || renamedEls.has(row) || offScreen(b.top, b.height)) {
      stopRowMotion(row);
      row.remove();
      return;
    }
    row.classList.remove('selected');
    row.classList.add('username-exit');
    row.dataset.renderExit = '1';
    row.style.position = 'absolute';
    row.style.top = `${b.top}px`;
    row.style.left = `${b.left}px`;
    row.style.width = `${b.width}px`;
    row.style.margin = '0';
    row.style.zIndex = '1';
    leaving.push(row);
  });
  const template = document.createElement('template');
  const ordered = filtered.map((user, index) => {
    const existing = live.get(user.username);
    if (existing) {
      existing.classList.toggle('selected', index === state.selectedIndex);
      return existing;
    }
    template.innerHTML = renderUnfollowerRowHtml(user, index).trim();
    return template.content.firstElementChild;
  });
  const fragment = document.createDocumentFragment();
  ordered.forEach(row => fragment.appendChild(row));
  listEl.insertBefore(fragment, listEl.firstChild);
  // Still-sliding-out rows stay (out of flow, so order doesn't matter).
  keptExits.forEach(row => { if (row.parentElement !== listEl) listEl.appendChild(row); });
  reindexUnfollowerRows();

  // --- READ: where everything is after it.
  const after = ordered.map(row => ({ row, top: row.offsetTop, height: row.offsetHeight }));

  // --- MOTION (queued; written on the next motion step, not here).
  after.forEach(({ row, top, height }) => {
    const name = row.dataset.username;
    const was = live.has(name) ? before.get(live.get(name))
      : (renamedFrom.has(name) ? before.get(renamedFrom.get(name)) : null);
    if (was) {
      // Kept (or edited) row: shift by how far it moved — unless it's off
      // screen both before and after, where nobody would see it.
      if (offScreen(was.top, was.height) && offScreen(top, height)) return;
      addRowShift(row, was.top - top, DURATION);
      return;
    }
    const resumeTop = resumeTops.get(name);
    if (resumeTop !== undefined) {
      // Was mid-slide out and is back: reverse from exactly where it is.
      const dy = (resumeTop - row.getBoundingClientRect().top) / visualScale;
      if (dy < 0) slideRowIn(row, -dy, DURATION);
      else addRowShift(row, dy, DURATION);
      return;
    }
    if (!animate || offScreen(top, height)) return;
    slideRowIn(row, height + rowGap, DURATION);
  });
  leaving.forEach(row => {
    slideRowOut(row, before.get(row).height + rowGap, DURATION, () => row.remove());
  });
  stepRowMotion();
  return cut; // where the rest of the rows start (appendRowTail)
}

// Rows the re-render above just replaced: any whose username is no longer
// in the list (and that was on screen) is put back, pinned out of flow at
// exactly where it was, and slides out with the same slide a deleted row
// gets. Off-screen ones are just dropped — nobody would see them move,
// and a cleared list can hold hundreds.
function animateResultsExits(listEl, previousRows) {
  if (previousRows.size === 0) return;
  const DURATION = ROW_MOTION_MS;
  const stillHere = new Set(Array.from(listEl.querySelectorAll('.user-row:not(.username-exit)')).map(r => r.dataset.username));
  const leaving = Array.from(previousRows.keys()).filter(row => !stillHere.has(row.dataset.username));
  if (leaving.length === 0) return;

  const listRect = listEl.getBoundingClientRect();
  const visualScale = (listRect.height / listEl.offsetHeight) || 1;
  if (getComputedStyle(listEl).position === 'static') listEl.style.position = 'relative';

  leaving.forEach(row => {
    const rect = previousRows.get(row);
    if (!rect || rect.bottom <= listRect.top || rect.top >= listRect.bottom) return;
    stopRowMotion(row);
    row.classList.remove('selected');
    row.classList.add('username-exit');
    row.dataset.renderExit = '1';
    row.style.position = 'absolute';
    row.style.top = `${(rect.top - listRect.top) / visualScale + listEl.scrollTop}px`;
    row.style.left = `${(rect.left - listRect.left) / visualScale + listEl.scrollLeft}px`;
    row.style.width = `${rect.width / visualScale}px`;
    row.style.margin = '0';
    row.style.zIndex = '1';
    listEl.appendChild(row);
    slideRowOut(row, rect.pitch, DURATION, () => row.remove());
  });
  stepRowMotion();
}

function animateResultsReentry(listEl, previousTops, resumeTops = new Map(), { enter = true, rowSelector = '.user-row' } = {}) {
  const DURATION = ROW_MOTION_MS;
  const rows = Array.from(listEl.querySelectorAll(`${rowSelector}:not(.username-exit)`));
  if (rows.length === 0) return;

  // getBoundingClientRect is in visual px, inline translateY in layout px —
  // they differ inside the guest preview's scaled-down grid, so convert
  // (same reasoning as exitListRow's visualScale).
  const visualScale = (listEl.getBoundingClientRect().height / listEl.offsetHeight) || 1;

  const listRect = listEl.getBoundingClientRect();
  // Generous (see reconcileUnfollowerRows): a row just past the list's
  // edge right now can be in view a moment later.
  const margin = window.innerHeight || 800;
  const offScreen = (top, height) => top + height <= listRect.top - margin || top >= listRect.bottom + margin;
  rows.forEach(row => {
    const previousTop = previousTops.get(row.dataset.username);
    const resumeTop = resumeTops.get(row.dataset.username);
    if (previousTop === undefined && resumeTop !== undefined) {
      // Was mid-slide out and is back: reverse from exactly where it is.
      const dy = (resumeTop - row.getBoundingClientRect().top) / visualScale;
      if (dy < 0) {
        slideRowIn(row, -dy, DURATION);
      } else if (dy > 0) {
        addRowShift(row, dy, DURATION);
      }
      return;
    }
    if (previousTop === undefined) {
      if (!enter) return;
      // Only rows actually on screen — pasting a whole list can add hundreds.
      const rect = row.getBoundingClientRect();
      if (offScreen(rect.top, rect.height)) return;
      // New to the list: slide down into place from one row pitch above,
      // emerging from its own slot's top edge (see slideRowIn).
      const marginBottom = parseFloat(getComputedStyle(row).marginBottom) || 0;
      slideRowIn(row, row.offsetHeight + marginBottom, DURATION);
      return;
    }
    // Already here: FLIP from where it was to where it is now (skipping
    // rows that are off screen both before and after — nobody sees them).
    const rect = row.getBoundingClientRect();
    if (offScreen(previousTop, rect.height) && offScreen(rect.top, rect.height)) return;
    addRowShift(row, (previousTop - rect.top) / visualScale, DURATION);
  });
  stepRowMotion();
}

// -------------------------------------------------------------
// Input Handlers & File Reading
// -------------------------------------------------------------

// Debounce helper to prevent lags on massive lists
function debounce(fn, delay) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), delay);
  };
}

// Where list 1 ('following') / list 2 ('followers') are saved for whatever
// is selected — the account's own key, or '_global_' with no account. Edits
// used to go to one shared 'following_users' key whichever account was
// selected, and logging in loaded that key over the selected account's own
// list — showing (and then saving) another account's usernames in it.
function listStorageKey(type) {
  const acc = state.selectedAccountUsername ? state.selectedAccountUsername.toLowerCase() : '_global_';
  return `${type}_users_${acc}`;
}

const handleFollowingInput = debounce(function() {
  const searchFollowingInput = document.getElementById('search-following');
  if (searchFollowingInput && searchFollowingInput.value.trim() !== '') {
    return;
  }
  const rawText = elements.inputFollowing.value;
  const existingPendingMap = new Map();
  state.following.forEach(user => {
    if (user.isPendingRequest) existingPendingMap.set(user.username, true);
  });
  const parsed = parseInput(rawText).map(user => {
    if (existingPendingMap.has(user.username)) {
      return { ...user, isPendingRequest: true };
    }
    return user;
  });
  state.following = deduplicateEntries(parsed);
  storageSet(listStorageKey('following'), JSON.stringify(state.following));
  updateListUI('following');
  calculateUnfollowers({ animate: true, matchRenames: true });
}, 250);

const handleFollowersInput = debounce(function() {
  const searchFollowersInput = document.getElementById('search-followers');
  if (searchFollowersInput && searchFollowersInput.value.trim() !== '') {
    return;
  }
  const rawText = elements.inputFollowers.value;
  const parsed = parseInput(rawText);
  state.followers = deduplicateEntries(parsed);
  storageSet(listStorageKey('followers'), JSON.stringify(state.followers));
  updateListUI('followers');
  calculateUnfollowers({ animate: true, matchRenames: true });
}, 250);

// `render: false` (imports): list 3 isn't redrawn per file — the import
// redraws it once, animated, when every file is in (processImportFiles).
function readAndProcessFile(file, type, append = false, isPending = false, { render = true } = {}) {
  return new Promise((resolve) => {
    if (!file) {
      resolve();
      return;
    }
    const reader = new FileReader();
    reader.onload = function(e) {
      const content = e.target.result;
      let parsed = parseInput(content);
      if (isPending) {
        parsed = parsed.map(user => ({ ...user, isPendingRequest: true }));
      }
      const combined = append ? [...state[type], ...parsed] : parsed;
      const deduplicated = deduplicateEntries(combined);
      
      // Store complete parsed data directly in state to preserve dates & full names
      state[type] = deduplicated;

      // Save to the correct localStorage key (account-scoped if an account is selected)
      storageSet(listStorageKey(type), JSON.stringify(deduplicated));
      
      // Format clean list of usernames for visual display inside the textarea
      const usernamesText = deduplicated.map(user => `@${user.originalUsername}`).join('\n');
      const inputEl = elements[`input${type.charAt(0).toUpperCase() + type.slice(1)}`];
      inputEl.value = usernamesText;
      
      updateListUI(type);
      if (!render) {
        resolve();
        return;
      }
      calculateUnfollowers();
      // Debounce delay buffer to ensure recalculation finishes before next file
      setTimeout(resolve, 300);
    };
    reader.readAsText(file);
  });
}

function smoothClearTextarea(textareaEl, callback) {
  if (!textareaEl) {
    if (callback) callback();
    return;
  }

  if (textareaEl.value.trim() !== '') {
    textareaEl.classList.add('textarea-fade-out');
    setTimeout(() => {
      textareaEl.value = '';
      textareaEl.classList.remove('textarea-fade-out');
      if (callback) callback();
    }, 280);
  } else {
    textareaEl.value = '';
    if (callback) callback();
  }
}

async function clearAllLists(animate = true, { render = true } = {}) {
  if (animate) {
    const promises = [];
    if (elements.inputFollowing && elements.inputFollowing.value.trim() !== '') {
      promises.push(new Promise(res => smoothClearTextarea(elements.inputFollowing, res)));
    } else if (elements.inputFollowing) {
      elements.inputFollowing.value = '';
    }

    if (elements.inputFollowers && elements.inputFollowers.value.trim() !== '') {
      promises.push(new Promise(res => smoothClearTextarea(elements.inputFollowers, res)));
    } else if (elements.inputFollowers) {
      elements.inputFollowers.value = '';
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }
  } else {
    if (elements.inputFollowing) elements.inputFollowing.value = '';
    if (elements.inputFollowers) elements.inputFollowers.value = '';
  }

  state.following = [];
  storageSet(listStorageKey('following'), '[]');
  state.followers = [];
  storageSet(listStorageKey('followers'), '[]');

  state.selectedIndex = -1;
  updateListUI('following');
  updateListUI('followers');
  if (render) calculateUnfollowers();
}

/**
 * Reads a file's text content and looks for "Generated by <username> on ..." to extract the Instagram username.
 * Returns a Promise that resolves with the username string or null if not found.
 */
function extractUsernameFromFile(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = function(e) {
      const content = e.target.result;
      // Match "Generated by <username> on" (case-insensitive)
      const match = content.match(/Generated\s+by\s+(\S+)\s+on\s/i);
      resolve(match ? match[1].trim() : null);
    };
    reader.onerror = function() {
      resolve(null);
    };
    reader.readAsText(file);
  });
}

// At most this many account chips (the demo counts as one). Accounts saved
// before the limit stay; only adding a new one past it is refused.
const MAX_ACCOUNTS = 3;
function isNewAccountOverLimit(username) {
  normalizeInstagramAccounts();
  const lower = String(username || '').toLowerCase();
  const accounts = state.instagramAccounts || [];
  const exists = accounts.some(acc => acc.originalUsername.toLowerCase() === lower
    || (isDemoAccount(acc) && acc.username.toLowerCase() === lower));
  return !exists && accounts.length >= MAX_ACCOUNTS;
}
function showAccountLimitAlert() {
  return showSiteAlert('account limit reached', `you can have up to ${MAX_ACCOUNTS} accounts. delete one to add another.`);
}

/**
 * Ensures an Instagram account exists and is selected. If the account doesn't exist,
 * it creates it. Then selects it and loads its data so imports go to the right account.
 */
function ensureAccountSelected(username, { renderResults = true } = {}) {
  if (!username) return;

  const usernameLower = username.toLowerCase();

  normalizeInstagramAccounts();

  // Real files for the demo chip's name turn the demo into that real
  // account (same spot in the chips), unless a real one already exists.
  const demoIndex = state.instagramAccounts.findIndex(acc => isDemoAccount(acc) && acc.username.toLowerCase() === usernameLower);
  const realExists = state.instagramAccounts.some(acc => !isDemoAccount(acc) && acc.originalUsername.toLowerCase() === usernameLower);
  if (demoIndex >= 0 && !realExists) {
    const demoSelected = state.selectedAccountUsername && state.selectedAccountUsername.toLowerCase() === DEMO_ID;
    state.instagramAccounts[demoIndex] = { username, originalUsername: username };
    if (demoSelected) state.selectedAccountUsername = null; // nothing of the demo is saved over
    clearDemoData();
    saveAccountsList();
  }

  // Check if account already exists by matching originalUsername (case-insensitive)
  const existingIndex = state.instagramAccounts.findIndex(
    acc => acc.originalUsername.toLowerCase() === usernameLower
  );

  if (existingIndex >= 0) {
    // Account exists — select it if it's not already selected
    const originalName = state.instagramAccounts[existingIndex].originalUsername;
    if (!state.selectedAccountUsername || state.selectedAccountUsername.toLowerCase() !== usernameLower) {
      if (state.selectedAccountUsername) {
        saveCurrentAccountData();
      }
      state.selectedAccountUsername = originalName;
      storageSet('selected_instagram_account', state.selectedAccountUsername);
      loadAccountData(state.selectedAccountUsername, true, true, { renderResults }); // like selecting its chip
    }
  } else {
    // Account doesn't exist — create it and select it
    if (state.selectedAccountUsername) {
      saveCurrentAccountData();
    }
    const newAcc = { username: username, originalUsername: username };
    state.instagramAccounts.push(newAcc);
    saveAccountsList();
    state.selectedAccountUsername = username;
    storageSet('selected_instagram_account', username);
    loadAccountData(username, true, true, { renderResults }); // its chip fades in, like adding one by hand
  }

  renderAccountChips();
}

// The export's other relationship lists (requests you sent that are still
// pending, close friends, blocked, restricted) are kept per account, apart
// from lists 1 and 2: shown in list 3's results tab (features.js). A list
// that's null was never imported; [] was imported and is empty.
const EXTRA_LIST_KINDS = ['pending', 'closeFriends', 'blocked', 'restricted'];
function extraListKind(nameLower) {
  if (!/\.(html|json|txt)$/.test(nameLower)) return null;
  if (nameLower.startsWith('pending_follow_requests')) return 'pending';
  if (nameLower.startsWith('close_friends')) return 'closeFriends';
  if (/^blocked_(profiles|accounts|users)/.test(nameLower)) return 'blocked';
  if (/^restricted_(profiles|accounts|users)/.test(nameLower)) return 'restricted';
  return null;
}
function extraListsKey(acc) {
  return `extra_lists_${acc ? String(acc).toLowerCase() : '_global_'}`;
}
function readExtraLists(acc) {
  try {
    const v = JSON.parse(storageGet(extraListsKey(acc)) || 'null');
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    return {};
  }
}
function writeExtraLists(acc, lists) {
  storageSet(extraListsKey(acc), JSON.stringify(lists));
}
// Replaced by features.js: redraws what shows these lists.
function extraListsChanged() {}
// Just the account fields (a pending request was marked as one when it used
// to be merged into list 1).
function cleanExtraEntry(user) {
  const { isPendingRequest, ...rest } = user;
  return rest;
}
function readFileText(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result || '');
    reader.onerror = () => resolve('');
    reader.readAsText(file);
  });
}

// Instagram sends the export as a .zip. It's opened right here: only the
// files the app reads are taken out of it, each read on its own from the
// zip (an export with photos can be huge — it's never loaded whole).
const ZIP_WANTED = (name) => /^following\.(html|json)$/.test(name) || /^followers(_\d+)?\.(html|json)$/.test(name)
  || /^personal_information\.json$/.test(name) || !!extraListKind(name);
async function unzipImportFiles(zip) {
  const size = zip.size;
  const read = async (start, len) => new DataView(await zip.slice(start, start + len).arrayBuffer());
  // End of the central directory (the zip's table of contents), from the tail.
  const tailLen = Math.min(size, 65557 + 20);
  const tail = await read(size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) { if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) return [];
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOff = tail.getUint32(eocd + 16, true);
  // Big zips (zip64) keep the real numbers in another record.
  if ((count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) && eocd >= 20 && tail.getUint32(eocd - 20, true) === 0x07064b50) {
    const z64 = await read(Number(tail.getBigUint64(eocd - 12, true)), 56);
    count = Number(z64.getBigUint64(32, true));
    cdSize = Number(z64.getBigUint64(40, true));
    cdOff = Number(z64.getBigUint64(48, true));
  }
  const cd = await read(cdOff, cdSize);
  const utf8 = new TextDecoder();
  const out = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true);
    let csize = cd.getUint32(p + 20, true);
    let usize = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
    let local = cd.getUint32(p + 42, true);
    const name = utf8.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) {
      for (let e = p + 46 + nameLen, end = e + extraLen; e + 4 <= end;) {
        const id = cd.getUint16(e, true), len = cd.getUint16(e + 2, true);
        if (id === 1) {
          let q = e + 4;
          if (usize === 0xffffffff) { usize = Number(cd.getBigUint64(q, true)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.getBigUint64(q, true)); q += 8; }
          if (local === 0xffffffff) local = Number(cd.getBigUint64(q, true));
        }
        e += 4 + len;
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
    const base = name.split('/').pop();
    if (!base || name.startsWith('__MACOSX/') || !ZIP_WANTED(base.toLowerCase())) continue;
    const head = await read(local, 30);
    const start = local + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    const raw = zip.slice(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    else continue;
    out.push(new File([data], base, { type: /\.html$/i.test(base) ? 'text/html' : 'application/json' }));
  }
  return out;
}
// The account's username, from the export's own profile file (JSON exports
// have no "Generated by" line to read it from).
async function usernameFromPersonalInfo(file) {
  try {
    let found = null;
    const scan = (o) => {
      if (found || !o || typeof o !== 'object') return;
      if (o.Username && typeof o.Username.value === 'string' && o.Username.value.trim()) { found = o.Username.value.trim(); return; }
      Object.values(o).forEach(scan);
    };
    scan(JSON.parse(await readFileText(file)));
    return found;
  } catch (e) {
    return null;
  }
}

// The files of the import that just finished (features.js saves them).
let lastImportFiles = [];

async function processImportFiles(files, isFolderUpload = false) {
  if (!files || files.length === 0) return false;

  // A .zip (what Instagram sends): its files are used as if the folder
  // inside it was picked.
  let knownUsername = null;
  const zips = Array.from(files).filter(f => /\.zip$/i.test(f.name));
  if (zips.length) {
    if (typeof DecompressionStream === 'undefined') {
      await showSiteAlert("couldn't open the zip", "this browser can't open zip files. unzip it first, then upload the folder or its files.");
      return false;
    }
    let inner = [];
    for (const zip of zips) {
      try { inner = inner.concat(await unzipImportFiles(zip)); } catch (err) { console.error('Could not read zip:', err); }
    }
    const info = inner.find(f => f.name.toLowerCase() === 'personal_information.json');
    if (info) knownUsername = await usernameFromPersonalInfo(info);
    files = Array.from(files).filter(f => !zips.includes(f)).concat(inner.filter(f => f !== info));
    if (inner.length) isFolderUpload = true; // the whole export
  }

  let importedFollowing = false;
  let importedFollowers = false;
  let invalidFiles = [];
  let validFilesToProcess = [];

  for (const file of files) {
    const nameLower = file.name.toLowerCase();
    const extraKind = extraListKind(nameLower);
    if (extraKind) {
      validFilesToProcess.push({ file, type: 'extra', kind: extraKind });
      continue;
    }

    if (isFolderUpload) {
      // Folder upload: only the export's own relationship files, in either
      // of Instagram's export formats (HTML or JSON). Followers are split
      // across followers_1, followers_2, … for large accounts — take them
      // all (only followers_1.html used to be read, and .json never was).
      if (/^following\.(html|json)$/.test(nameLower)) {
        validFilesToProcess.push({ file, type: 'following', isPending: false });
      } else if (/^followers(_\d+)?\.(html|json)$/.test(nameLower)) {
        validFilesToProcess.push({ file, type: 'followers', isPending: false });
      }
    } else {
      // Individual upload (following.json used to be rejected, so a JSON
      // export only ever loaded its followers).
      if (/^following\.(html|txt|json)$/.test(nameLower) || nameLower.startsWith('following_')) {
        validFilesToProcess.push({ file, type: 'following', isPending: false });
      } else if (nameLower === 'followers_1.html' || nameLower === 'followers.html' || nameLower === 'followers_1.txt' || nameLower === 'followers.txt' || nameLower.startsWith('followers_') || nameLower.startsWith('followers')) {
        validFilesToProcess.push({ file, type: 'followers', isPending: false });
      } else {
        invalidFiles.push(file.name);
      }
    }
  }

  if (validFilesToProcess.length > 0) {
    // Lists 1 and 2 first, then the extra lists.
    const mainFiles = validFilesToProcess.filter(item => item.type !== 'extra');
    const extraFiles = validFilesToProcess.filter(item => item.type === 'extra');
    // The username from a file's "Generated by X on ..." header (JSON
    // files don't have one, so look through them all).
    let extractedUsername = knownUsername;
    for (const item of extractedUsername ? [] : [...mainFiles, ...extraFiles]) {
      extractedUsername = await extractUsernameFromFile(item.file);
      if (extractedUsername) break;
    }
    if (!extractedUsername) {
      const fallback = prompt("we couldn't find your username in the file. please enter your instagram username:");
      if (fallback && fallback.trim() !== '') {
        extractedUsername = fallback.trim();
      }
    }
    if (extractedUsername && isNewAccountOverLimit(extractedUsername)) {
      await showAccountLimitAlert();
      return false;
    }
    if (extractedUsername) {
      // List 3 isn't redrawn with the account's old data first: it goes
      // straight to the imported result below, with each username's
      // unfollowed/starred choice already applied.
      ensureAccountSelected(extractedUsername, { renderResults: false });
    }

    // Clear List 1 and List 2 smoothly, read every file, then update list 3
    // once, with list 3's slide: usernames that stay stay put, new ones
    // slide in, gone ones slide out. It used to redraw list 3 without
    // animation after the clear and after every file (with a 0.3s pause
    // each), so it snapped from one state to the next.
    // Only the extra lists (say, just close_friends.json): lists 1 and 2
    // are left as they are.
    if (mainFiles.length) {
      await clearAllLists(true, { render: false });

      for (const item of mainFiles) {
        if (item.type === 'following') {
          await readAndProcessFile(item.file, 'following', importedFollowing, item.isPending, { render: false });
          importedFollowing = true;
        } else if (item.type === 'followers') {
          await readAndProcessFile(item.file, 'followers', importedFollowers, item.isPending, { render: false });
          importedFollowers = true;
        }
      }
    }

    const found = {};
    for (const item of extraFiles) {
      const parsed = parseInput(await readFileText(item.file)) || [];
      found[item.kind] = (found[item.kind] || []).concat(parsed);
    }
    const lists = readExtraLists(state.selectedAccountUsername);
    // A whole export folder is the full picture: a list it doesn't have is
    // empty now. Single files only replace their own list.
    if (isFolderUpload && mainFiles.length) EXTRA_LIST_KINDS.forEach(kind => { lists[kind] = []; });
    Object.keys(found).forEach(kind => { lists[kind] = deduplicateEntries(found[kind]).map(cleanExtraEntry); });
    const extrasChanged = extraFiles.length > 0 || (isFolderUpload && mainFiles.length > 0);
    if (extrasChanged) writeExtraLists(state.selectedAccountUsername, lists);

    if (mainFiles.length) {
      state.freshRows = true; // imported files: the list comes in whole
      calculateUnfollowers({ animate: true });
      // Restart the weekly reset reminder from this fresh import.
      lastImportFiles = validFilesToProcess.map(item => item.file); // kept by features.js (saved imports)
      recordImportDate(state.selectedAccountUsername);
      saveCurrentAccountData();
    } else {
      pushToCloud();
    }
    if (extrasChanged) extraListsChanged();
  }

  // Also when a whole folder had nothing usable (that used to fail silently).
  if (validFilesToProcess.length === 0 && (invalidFiles.length > 0 || isFolderUpload)) {
    await showSiteAlert('no valid files found', 'no followers or following files (html, json, or txt) were found in what you uploaded.');
  }

  return importedFollowing || importedFollowers || validFilesToProcess.some(item => item.type === 'extra');
}


// -------------------------------------------------------------
// Instagram Accounts Management & Modal Logic
// -------------------------------------------------------------

function saveCurrentAccountData() {
  const currentAcc = state.selectedAccountUsername ? state.selectedAccountUsername.toLowerCase() : '_global_';

  // Tag entries with current account context
  state.starred = (state.starred || []).map(u => ({ ...u, account: u.account || currentAcc }));
  state.unfollowed = (state.unfollowed || []).map(u => ({ ...u, account: u.account || currentAcc }));

  if (state.selectedAccountUsername) {
    storageSet(`following_users_${currentAcc}`, JSON.stringify(state.following));
    storageSet(`followers_users_${currentAcc}`, JSON.stringify(state.followers));
    storageSet(`unfollowed_users_${currentAcc}`, JSON.stringify(state.unfollowed));
    storageSet(`starred_users_${currentAcc}`, JSON.stringify(state.starred));
  } else {
    storageSet('following_users__global_', JSON.stringify(state.following));
    storageSet('followers_users__global_', JSON.stringify(state.followers));
    // No account selected: its unfollowed/starred go under their own
    // '_global_' keys, like an account's. Writing them into the merged
    // all-accounts lists instead meant cloud sync — which rebuilds those
    // lists from the per-account keys — dropped them the next time it ran
    // with an account selected.
    storageSet('unfollowed_users__global_', JSON.stringify(state.unfollowed));
    storageSet('starred_users__global_', JSON.stringify(state.starred));
  }

  pushToCloud();
}

// `animateResults`: the user just switched accounts by selecting/unselecting
// a chip, so list 3's usernames slide out/in/along as they change (see
// updateResultsUI) instead of the whole list snapping to the new account.
// `renderResults: false` (imports): lists and submenus load, but list 3 is
// left as it is — the import redraws it once, animated, with the new files
// (processImportFiles), instead of first showing the account's old list 3.
function loadAccountData(username, animate = false, animateResults = false, { renderResults = true } = {}) {
  if (username) {
    state.selectedAccountUsername = username;
    storageSet('selected_instagram_account', username);
    storageSet('last_active_instagram_account', username);
    const acc = username.toLowerCase();

    // Load account-specific following and followers lists
    state.following = JSON.parse(storageGet(`following_users_${acc}`) || '[]');
    state.followers = JSON.parse(storageGet(`followers_users_${acc}`) || '[]');

    // The account's own saved lists are authoritative — they're written on
    // every change. The merged all-accounts lists ('unfollowed_users' /
    // 'starred_users') are only rebuilt by cloud sync, which is batched, so
    // they can briefly still hold a username just removed here; merging them
    // in would bring it back. They're only a fallback for older data that
    // has no per-account list yet.
    const accUnfollowedRaw = storageGet(`unfollowed_users_${acc}`);
    const accStarredRaw = storageGet(`starred_users_${acc}`);
    const accUnfollowed = JSON.parse(accUnfollowedRaw || '[]');
    const accStarred = JSON.parse(accStarredRaw || '[]');
    const mainUnfollowed = accUnfollowedRaw === null ? JSON.parse(storageGet('unfollowed_users') || '[]') : [];
    const mainStarred = accStarredRaw === null ? JSON.parse(storageGet('starred_users') || '[]') : [];

    // Combine account-scoped and main lists, filtering strictly for items matching this account
    const combinedUnfollowed = [...accUnfollowed, ...mainUnfollowed];
    const combinedStarred = [...accStarred, ...mainStarred];

    const unfollowedMap = new Map();
    combinedUnfollowed.forEach(u => {
      if (u.account && u.account.toLowerCase() === acc) {
        unfollowedMap.set(u.username, u);
      }
    });

    const starredMap = new Map();
    combinedStarred.forEach(u => {
      if (u.account && u.account.toLowerCase() === acc) {
        starredMap.set(u.username, u);
      }
    });

    state.unfollowed = Array.from(unfollowedMap.values());
    state.starred = Array.from(starredMap.values());

    // Restore List 1 and List 2 input textareas for this active account
    if (elements.inputFollowing) {
      elements.inputFollowing.value = state.following.map(u => `@${u.originalUsername}`).join('\n');
    }
    if (elements.inputFollowers) {
      elements.inputFollowers.value = state.followers.map(u => `@${u.originalUsername}`).join('\n');
    }
  } else {
    // Lists 1/2 as last left with no account selected (they used to be
    // saved but never read back, so they vanished on reload).
    // Data saved before these keys existed is in the old shared keys.
    const ownFollowing = storageGet('following_users__global_');
    const ownFollowers = storageGet('followers_users__global_');
    state.following = JSON.parse((ownFollowing !== null ? ownFollowing : storageGet('following_users')) || '[]')
      .filter(u => u && u.username !== GUEST_PREVIEW_USERNAME);
    state.followers = JSON.parse((ownFollowers !== null ? ownFollowers : storageGet('followers_users')) || '[]');
    state.unfollowers = [];

    // Own '_global_' keys first (see saveCurrentAccountData); the merged
    // lists only for data saved before those existed.
    const ownUnfollowed = storageGet('unfollowed_users__global_');
    const ownStarred = storageGet('starred_users__global_');
    const mainUnfollowed = JSON.parse((ownUnfollowed !== null ? ownUnfollowed : storageGet('unfollowed_users')) || '[]');
    const mainStarred = JSON.parse((ownStarred !== null ? ownStarred : storageGet('starred_users')) || '[]');

    state.unfollowed = mainUnfollowed.filter(u => !u.account || u.account === '_global_');
    state.starred = mainStarred.filter(u => !u.account || u.account === '_global_');

    if (elements.inputFollowing) elements.inputFollowing.value = state.following.map(u => `@${u.originalUsername}`).join('\n');
    if (elements.inputFollowers) elements.inputFollowers.value = state.followers.map(u => `@${u.originalUsername}`).join('\n');
  }

  updateListUI('following');
  updateListUI('followers');
  if (renderResults) {
    if (animateResults) state.freshRows = true; // another account: its list comes in whole
    calculateUnfollowers({ animate: animateResults });
  }
  renderAccountChips(animate);
  updateStorageProgressBar();
  updateResetReminderUI();
}

// 'last_active_instagram_account' remembers the selection across reloads
// and logins. It used to keep naming an account after it was unselected —
// or deleted — so the next reload selected it again. '' records "none on
// purpose", as opposed to a missing key ("nothing known on this device").
function rememberNoAccountSelected() {
  storageSet('last_active_instagram_account', '');
}

function selectAccount(username) {
  // Only an account that still exists — a tap on a chip just before it was
  // deleted fires after (single taps wait for a possible double tap), and
  // would select an account with no chip.
  if (!username || !(state.instagramAccounts || []).some(acc => acc.originalUsername.toLowerCase() === username.toLowerCase())) return;
  if (state.selectedAccountUsername && state.selectedAccountUsername.toLowerCase() === username.toLowerCase()) {
    // Clicked the currently active username chip -> UNSELECT IT!
    saveCurrentAccountData();
    state.selectedAccountUsername = null;
    storageRemove('selected_instagram_account');
    rememberNoAccountSelected();
    loadAccountData(null, false, true);
  } else {
    // Select the clicked username chip!
    if (state.selectedAccountUsername) {
      saveCurrentAccountData();
    }
    state.selectedAccountUsername = username;
    storageSet('selected_instagram_account', username);
    loadAccountData(username, false, true);
  }
}

let chipClickTimer = null;

// FLIP for account chips after a full re-render: each chip that existed
// before starts at its old position and slides to its new one.
function slideChipsFromPreviousRects(previousRects) {
  if (previousRects.size === 0) return;
  const chips = Array.from(elements.accountChipsList.querySelectorAll('.account-chip'));
  const moved = [];
  chips.forEach(chip => {
    const before = previousRects.get(chip.getAttribute('data-account-name'));
    if (!before) return;
    const after = chip.getBoundingClientRect();
    // Visual -> layout px (the guest preview's grid is scaled down).
    const scale = (after.width / chip.offsetWidth) || 1;
    const dx = (before.left - after.left) / scale;
    const dy = (before.top - after.top) / scale;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    moved.push([chip, dx, dy]);
  });
  if (moved.length === 0 || typeof moved[0][0].animate !== 'function') return;
  moved.forEach(([chip, dx, dy]) => {
    chip.animate([
      { transform: `translate(${dx}px, ${dy}px)` },
      { transform: 'translate(0, 0)' }
    ], { duration: CHIP_EXIT_MS, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }); // as when a chip is deleted
  });
}

// One account chip. Its handlers look the account up when tapped (by the
// chip's data-account-name), not from when the chip was made — chips are
// kept across renders while accounts are added, removed or renamed.
function createAccountChip(name) {
  const chip = document.createElement('div');
  chip.className = 'account-chip';
  chip.setAttribute('data-account-name', name);
  const textSpan = document.createElement('span');
  textSpan.className = 'chip-text';
  chip.appendChild(textSpan);

  const current = () => {
    const index = (state.instagramAccounts || []).findIndex(a => a.originalUsername.toLowerCase() === name);
    return index >= 0 ? { acc: state.instagramAccounts[index], index } : null;
  };
  const isSelected = () => !!state.selectedAccountUsername && state.selectedAccountUsername.toLowerCase() === name;
  const openEditor = () => {
    const found = current();
    if (!found) return;
    if (!isSelected()) selectAccount(found.acc.originalUsername);
    openAccountModal(found.index);
  };

  let lastChipTapTime = 0;
  function handleChipInteraction(e) {
    e.stopPropagation();
    const now = Date.now();
    const timeDiff = now - lastChipTapTime;

    if (timeDiff > 0 && timeDiff < 350) {
      chip.classList.add('no-active');
      if (chipClickTimer) {
        clearTimeout(chipClickTimer);
        chipClickTimer = null;
      }
      openEditor();
      lastChipTapTime = 0;
      return;
    }

    lastChipTapTime = now;

    if (chipClickTimer) {
      clearTimeout(chipClickTimer);
      chipClickTimer = null;
    }

    chipClickTimer = setTimeout(() => {
      const found = current();
      if (found) selectAccount(found.acc.originalUsername);
      chipClickTimer = null;
      lastChipTapTime = 0;
    }, 240);
  }

  // The entrance only ever plays once (moving a chip would replay it).
  chip.addEventListener('animationend', (e) => {
    if (e.animationName === 'chip-fade-in') chip.classList.remove('fade-in', 'after-row');
  });
  chip.addEventListener('touchend', (e) => handleChipInteraction(e));
  chip.addEventListener('click', (e) => {
    if (Date.now() - lastChipTapTime < 50) return;
    handleChipInteraction(e);
  });
  chip.addEventListener('dblclick', (e) => {
    chip.classList.add('no-active');
    e.stopPropagation();
    e.preventDefault();
    if (chipClickTimer) {
      clearTimeout(chipClickTimer);
      chipClickTimer = null;
    }
    openEditor();
  });
  return chip;
}

// Once the chip row has finished opening, it goes back to sizing itself
// (the measured --chip-row-height is only for the open/close animation).
(() => {
  const row = document.getElementById('account-mgmt-row');
  if (!row) return;
  row.addEventListener('transitionend', (e) => {
    if (e.target === row && e.propertyName === 'max-height' && !row.classList.contains('empty-chips')) {
      row.style.removeProperty('--chip-row-height');
    }
  });
})();

function renderAccountChips(animate = false, { force = false } = {}) {
  if (!elements.accountChipsList || !elements.btnAddAccount) return;
  if (chipRenderHolds > 0 && !force) return; // a chip is animating out (deleteAccountFromModal)

  normalizeInstagramAccounts();

  const accounts = state.instagramAccounts || [];
  const accountMgmtRow = document.getElementById('account-mgmt-row');
  if (accountMgmtRow) {
    // Closing: it animates down from the height it has now (style.css,
    // --chip-row-height). Opening: from 0 to its height with the new chips,
    // set further down once they're rendered.
    if (accounts.length === 0 && !accountMgmtRow.classList.contains('empty-chips') && accountMgmtRow.offsetHeight > 0) {
      accountMgmtRow.style.setProperty('--chip-row-height', `${accountMgmtRow.offsetHeight}px`);
    }
    accountMgmtRow.classList.toggle('empty-chips', accounts.length === 0);
  }
  const rowOpening = !!accountMgmtRow && accountMgmtRow.classList.contains('empty-chips') && accounts.length > 0;

  // Updated in place: chips that stay keep their element — only the chips
  // that are new are created (and fade in), gone ones are removed, and a
  // change of selection just moves the .active highlight, which fades.
  // Rebuilding every chip whenever the list changed (e.g. the first "try a
  // demo") made the previously selected chip lose its highlight instantly.
  const list = elements.accountChipsList;
  const existing = new Map();
  Array.from(list.querySelectorAll('.account-chip')).forEach(c => existing.set(c.getAttribute('data-account-name'), c));
  const previousChipRects = new Map();
  existing.forEach((c, name) => previousChipRects.set(name, c.getBoundingClientRect()));

  const wanted = new Set(accounts.map(acc => acc.originalUsername.toLowerCase()));
  existing.forEach((c, name) => { if (!wanted.has(name)) c.remove(); });

  const selected = state.selectedAccountUsername ? state.selectedAccountUsername.toLowerCase() : null;
  accounts.forEach((acc, index) => {
    const name = acc.originalUsername.toLowerCase();
    let chip = existing.get(name);
    if (!chip) {
      chip = createAccountChip(name);
      if (animate) {
        chip.classList.add('fade-in');
        if (rowOpening) chip.classList.add('after-row');
      }
    }
    chip.setAttribute('data-index', index);
    const text = chip.querySelector('.chip-text');
    if (text.textContent !== `@${acc.username}`) {
      // Renamed: the chip eases from its old width to the new name's
      // instead of snapping (the other chips slide along, below).
      const oldWidth = chip.isConnected ? chip.getBoundingClientRect().width : 0;
      text.textContent = `@${acc.username}`;
      if (oldWidth && typeof chip.animate === 'function') {
        const newWidth = chip.getBoundingClientRect().width;
        if (Math.abs(newWidth - oldWidth) > 0.5) {
          // While it resizes the name sits still at the left and the chip
          // opens/closes over it (no "…" and no re-centering each frame).
          chip.classList.add('chip-resizing');
          const anim = chip.animate([{ width: `${oldWidth}px` }, { width: `${newWidth}px` }],
            { duration: ROW_MOTION_MS, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }); // the list 3 slide
          const done = () => chip.classList.remove('chip-resizing');
          anim.onfinish = done;
          anim.oncancel = done;
        }
      }
    }
    chip.title = `@${acc.username}`; // the full name when it's cut off with "…"
    chip.classList.toggle('active', name === selected);
    // In order; only moved when it isn't already in place (moving an
    // element restarts its animations and transitions).
    if (list.children[index] !== chip) {
      list.insertBefore(chip, list.children[index] || null);
    }
  });

  // Chips that ended up somewhere else (a rename changed a width, one was
  // removed or reordered) slide there instead of jumping. (Only ones that
  // actually moved are animated.)
  slideChipsFromPreviousRects(previousChipRects);

  if (accountMgmtRow && accounts.length > 0) {
    // Opening: animate to the height of the row with these chips. Only
    // while it opens — the measured cap is dropped once it's open (see the
    // transitionend handler below), and never set from a measurement taken
    // while the app isn't laid out (0 — e.g. still inside the hidden login
    // page while a reload logs back in), which left the row clamped to its
    // padding with the chips cut off.
    const chipsHeight = elements.accountChipsList.offsetHeight;
    if (rowOpening && chipsHeight > 0) {
      accountMgmtRow.style.setProperty('--chip-row-height', `${chipsHeight + 8}px`); // + its 4px top/bottom padding
    } else if (!rowOpening) {
      accountMgmtRow.style.removeProperty('--chip-row-height');
    }
  }

  if (accounts.length > 0) {
    elements.btnAddAccount.classList.add('compact');
  } else {
    elements.btnAddAccount.classList.remove('compact');
  }
}

function openAccountModal(index = -1) {
  if (!elements.accountModalOverlay) return;

  state.editingAccountIndex = index;
  const accounts = state.instagramAccounts || [];

  if (index >= 0 && index < accounts.length) {
    const acc = accounts[index];
    if (elements.accountModalTitle) elements.accountModalTitle.textContent = 'edit instagram account';
    if (elements.accountUsernameInput) elements.accountUsernameInput.value = acc.username;
    if (elements.btnModalDelete) elements.btnModalDelete.style.display = 'inline-block';

    // Show original username caption if it has been edited
    if (elements.accountModalOriginalCaption) {
      if (!isDemoAccount(acc) && acc.username.toLowerCase() !== acc.originalUsername.toLowerCase()) {
        elements.accountModalOriginalCaption.textContent = `original: @${acc.originalUsername.toLowerCase()}`;
        elements.accountModalOriginalCaption.classList.remove('hidden');
      } else {
        elements.accountModalOriginalCaption.classList.add('hidden');
        elements.accountModalOriginalCaption.textContent = '';
      }
    }
  } else {
    if (elements.accountModalTitle) elements.accountModalTitle.textContent = 'add instagram account';
    if (elements.accountUsernameInput) elements.accountUsernameInput.value = '';
    if (elements.btnModalDelete) elements.btnModalDelete.style.display = 'none';
    if (elements.accountModalOriginalCaption) {
      elements.accountModalOriginalCaption.classList.add('hidden');
      elements.accountModalOriginalCaption.textContent = '';
    }
  }

  showModalOverlay(elements.accountModalOverlay);
  requestAnimationFrame(() => {
    if (elements.accountUsernameInput) elements.accountUsernameInput.focus();
  });
}

function closeAccountModal() {
  if (!elements.accountModalOverlay) return;

  elements.accountModalOverlay.classList.remove('show');
  // 600ms, matching .modal-overlay/.account-modal-card's own CSS transition
  // duration (style.css) — this used to fire at 350ms, cutting .hidden's
  // display:none in partway through the fade/scale-out and snapping the
  // rest of it away instead of letting it finish closing smoothly.
  scheduleOverlayHide(elements.accountModalOverlay, () => {
    elements.accountModalOverlay.classList.add('hidden');
    if (elements.accountModalOriginalCaption) {
      elements.accountModalOriginalCaption.classList.add('hidden');
      elements.accountModalOriginalCaption.textContent = '';
    }
    // Clean up double-click active suppression state
    document.querySelectorAll('.account-chip').forEach(c => c.classList.remove('no-active'));
    state.editingAccountIndex = -1;
  });
}

function saveAccountFromModal() {
  if (!elements.accountUsernameInput) return;

  let username = elements.accountUsernameInput.value.trim().replace(/^@+/, '');
  if (!username) return;

  normalizeInstagramAccounts();

  if (state.editingAccountIndex < 0 && isNewAccountOverLimit(username)) {
    closeAccountModal();
    setTimeout(showAccountLimitAlert, OVERLAY_CLEAR_MS);
    return;
  }

  // The window closes first; the chip changes once it has cleared (it
  // covers the chip row while fading), so a new chip's entrance is seen.
  const index = state.editingAccountIndex;
  closeAccountModal();
  setTimeout(() => applyAccountFromModal(username, index), OVERLAY_CLEAR_MS);
}

function applyAccountFromModal(username, index) {
  if (index >= 0 && index < state.instagramAccounts.length) {
    // Only update the display username, leaving the originalUsername untouched!
    state.instagramAccounts[index].username = username;
  } else {
    // Adding manually: create an object with identical username and originalUsername
    const newAcc = { username: username, originalUsername: username };
    if (!state.instagramAccounts.some(acc => acc.originalUsername.toLowerCase() === username.toLowerCase())) {
      state.instagramAccounts.push(newAcc);
    }
    // Auto-select newly added account!
    state.selectedAccountUsername = username;
    storageSet('selected_instagram_account', username);
    loadAccountData(username, true, true); // its new chip fades in; switching to it animates list 3, like selecting its chip
  }

  saveAccountsList();
  renderAccountChips(true);
  pushToCloud();
}

// Deleting a chip, in three calm steps rather than all at once: the edit
// window closes right away; as it clears, the chip fades and shrinks away
// while the chips after it glide over (transform/opacity only, so they
// stay smooth even while the data work runs); the chip row is only
// rebuilt once they've settled, where nothing moves any more. It used to
// bounce the chip out behind the still-open window, then switch list 3,
// rebuild and re-slide every chip and close the window in one go.
// A menu or window fading out over the chip row has mostly cleared by now.
const OVERLAY_CLEAR_MS = 220; // pop-ups close with an even 450ms fade: ~70% gone by now
const CHIP_EXIT_DELAY = OVERLAY_CLEAR_MS;
const CHIP_EXIT_MS = 380;
let chipRenderHolds = 0; // chips still animating out (the row waits for all of them)

function animateChipExit(chip) {
  const list = elements.accountChipsList;
  if (!chip || !list || typeof chip.animate !== 'function') return;
  const others = Array.from(list.querySelectorAll('.account-chip')).filter(c => c !== chip);
  const before = others.map(c => c.getBoundingClientRect().left);
  if (getComputedStyle(list).position === 'static') list.style.position = 'relative';
  const listRect = list.getBoundingClientRect();
  const scale = (listRect.width / list.offsetWidth) || 1; // the guest preview is scaled down
  // Keep the row its height while the chip leaves: with no other chip
  // holding it open, taking this one out of the row collapsed it at once
  // and everything below jumped up. It closes smoothly afterwards.
  list.style.minHeight = `${list.offsetHeight}px`;
  // Out of the row, pinned where it is, so the others can close the gap.
  const { offsetLeft: left, offsetTop: top, offsetWidth: width } = chip;
  // (important: chips are `position: relative !important` in style.css)
  chip.style.setProperty('position', 'absolute', 'important');
  chip.style.setProperty('transition', 'none', 'important');
  Object.assign(chip.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, margin: '0', pointerEvents: 'none' });
  const ease = 'cubic-bezier(0.4, 0, 0.2, 1)'; // list 3's row easing
  others.forEach((c, i) => {
    const dx = (before[i] - c.getBoundingClientRect().left) / scale;
    if (Math.abs(dx) > 0.5) {
      c.animate([{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }], { duration: CHIP_EXIT_MS, easing: ease });
    }
  });
  // `scale`, not `transform` (forced by the hover/pressed styles).
  chip.animate([
    { opacity: 1, scale: 1 },
    { opacity: 0, scale: 0.85 }
  ], { duration: CHIP_EXIT_MS, easing: ease, fill: 'forwards' });
}

function deleteAccountFromModal() {
  const index = state.editingAccountIndex;
  if (!(index >= 0 && index < (state.instagramAccounts || []).length)) return;
  // One delete per opening: a second tap while the window closes finds
  // nothing to delete (it could otherwise have hit the next account).
  state.editingAccountIndex = -1;
  const deletedAccount = state.instagramAccounts[index];
  const acc = deletedAccount.originalUsername.toLowerCase();
  const chipEl = elements.accountChipsList
    ? elements.accountChipsList.querySelector(`.account-chip[data-account-name="${CSS.escape(acc)}"]`)
    : null;

  const performDelete = () => {
    if (isDemoAccount(deletedAccount)) clearDemoData(); // nothing of the demo is kept
    // Its latest unfollowed/starred first, if it's the one on screen.
    if (!isDemoAccount(deletedAccount) && state.selectedAccountUsername && state.selectedAccountUsername.toLowerCase() === acc) {
      saveCurrentAccountData();
    }
    // 1. Drop the account's imported lists (they come back with the next
    //    import). Its unfollowed/starred history is KEPT — on this device
    //    and in the cloud (pushToCloudNow saves every account that has
    //    one) — and loads back in when the same username returns, by
    //    importing its files again or adding it by hand (loadAccountData
    //    reads it). Deleting a chip used to erase that history for good.
    storageRemove(`following_users_${acc}`);
    storageRemove(`followers_users_${acc}`);
    storageRemove(`import_date_${acc}`);

    // 2. Remove from current state arrays
    state.starred = (state.starred || []).filter(u => !u.account || u.account.toLowerCase() !== acc);
    state.unfollowed = (state.unfollowed || []).filter(u => !u.account || u.account.toLowerCase() !== acc);

    // 3. Remove account from accounts registry
    const at = state.instagramAccounts.indexOf(deletedAccount);
    if (at >= 0) state.instagramAccounts.splice(at, 1);
    saveAccountsList();

    // 4. Reset selection if the deleted account was selected
    if (state.selectedAccountUsername && state.selectedAccountUsername.toLowerCase() === acc) {
      state.selectedAccountUsername = null;
      storageRemove('selected_instagram_account');
      rememberNoAccountSelected();
      loadAccountData(null, false, true); // its usernames slide out of list 3, like unselecting its chip
    }

    pushToCloud();
  };

  closeAccountModal();
  setTimeout(() => {
    if (chipEl && chipEl.isConnected) {
      // The chip row waits until the exit has played out — every exit, if
      // a second chip is deleted while the first is still leaving.
      chipRenderHolds++;
      animateChipExit(chipEl);
      requestAnimationFrame(() => {
        try { performDelete(); } catch (err) { console.error('Error deleting account:', err); }
        setTimeout(() => {
          chipRenderHolds = Math.max(0, chipRenderHolds - 1);
          chipEl.remove();
          if (chipRenderHolds > 0) return; // the last exit to finish rebuilds the row
          // Rebuilt (renumbered: each chip's shortcut badge and the account
          // its double-tap opens), with every chip already in place. If it
          // was the last chip, the row now closes — still held at its
          // height (minHeight) so it eases shut instead of snapping.
          renderAccountChips(false, { force: true });
          setTimeout(() => { elements.accountChipsList.style.minHeight = ''; }, 420); // the row's 0.38s close
        }, CHIP_EXIT_MS);
      });
    } else {
      performDelete();
      renderAccountChips(true);
    }
  }, CHIP_EXIT_DELAY);
}

function closeAllSubMenusAndPopups() {
  let closedSomething = false;

  // 1. Close Auth Dropdown (Account Menu) — only while actually logged in.
  // While logged out, #auth-dropdown IS the fullscreen landing page/login
  // form (see body.auth-logged-out .auth-dropdown in style.css), not a
  // dismissible menu — removing its .show class there doesn't close
  // anything, it blanks the entire page (visibility: hidden kicks in
  // after the 0.6s close transition, per .auth-dropdown's base rule).
  if (document.documentElement.classList.contains('is-logged-in') &&
      elements.authDropdown && elements.authDropdown.classList.contains('show')) {
    elements.authDropdown.classList.remove('show');
    closedSomething = true;
  }

  // 2. Close Add Account Submenu Dropdown
  if (elements.addAccountDropdownMenu && elements.addAccountDropdownMenu.classList.contains('show')) {
    elements.addAccountDropdownMenu.classList.remove('show');
    if (elements.btnAddAccount) elements.btnAddAccount.classList.remove('active');
    closedSomething = true;
  }

  // 3. Close List 3 Unfollowed Preview Dropdown
  if (elements.listUnfollowed && elements.listUnfollowed.classList.contains('show')) {
    elements.listUnfollowed.classList.remove('show');
    if (elements.togglePreviewUnfollowed) elements.togglePreviewUnfollowed.classList.remove('active');
    closedSomething = true;
  }

  // 4. Close List 3 Starred Preview Dropdown
  if (elements.listStarred && elements.listStarred.classList.contains('show')) {
    elements.listStarred.classList.remove('show');
    if (elements.togglePreviewStarred) elements.togglePreviewStarred.classList.remove('active');
    closedSomething = true;
  }

  // 5. Close the add/edit account modal (this used to look for an
  // #account-select-modal that doesn't exist, so Escape only closed it
  // while its text input had focus).
  if (elements.accountModalOverlay && !elements.accountModalOverlay.classList.contains('hidden')) {
    closeAccountModal();
    closedSomething = true;
  }

  // 6. Close Instructions / Guide Modal (defined inside setupEventListeners,
  // hence reached through window — calling it directly threw a
  // ReferenceError that aborted the rest of this cleanup).
  if (elements.instructionsModalOverlay && !elements.instructionsModalOverlay.classList.contains('hidden')) {
    if (typeof window.closeInstructionsModal === 'function') window.closeInstructionsModal();
    closedSomething = true;
  }

  // 7. Blur active focused element (button or input)
  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
    closedSomething = true;
  }

  return closedSomething;
}

// Slide-up exit for a username row leaving a list — shared by every
// action that removes one, in list 3 itself (clicking the row, starring,
// dismissing, deleting) and in the unfollowed/starred preview submenus
// (unstarring, removing, moving between them), so they all animate
// identically no matter which control triggered it or which list it's in.
//
// Uses a FLIP (First-Last-Invert-Play) animation rather than animating
// max-height/margin/padding directly. Those box-model properties force a
// full synchronous layout recalculation on *every animation frame*, for
// the exiting row and every sibling below it — cheap enough with a
// handful of rows, but with real lists (unfollowed histories routinely
// have 50+ entries) that per-frame reflow cost is what actually caused
// the visible "chops up then snaps" jank on real phones, even though it
// looked perfectly smooth here with a handful of test rows. Removing the
// row from flow (position: absolute, pinned to its current visual spot)
// forces exactly one reflow up front instead of one per frame, then the
// siblings that need to shift up are animated purely with `transform`
// (GPU-composited, no further layout cost) from where they used to be
// back to their natural position. The exiting row itself just slides via
// .username-exit (transform only — already out of flow, so no collapse
// animation is needed on it at all) — a fixed 44px in the submenus, where
// every row is that same height, or the row's own just-measured height
// for list 3's rows, which vary (see exitDistance below).
// The unfollowed/starred submenus are auto-height popup panels
// (.dropdown-menu) that hug their content up to a 10-item cap, and their
// inner .dropdown-scroll-items (rowEl's own parent) does too, one level
// in. Pass the panel as `shrinkBox` and both it and that inner container
// get their new (shorter) natural height animated to over the same
// DURATION as the row's own fade — instead of snapping to the smaller
// size the instant the row leaves flow, well before the row itself has
// visibly finished fading, which for the inner container specifically
// also used to clip the bottom-most row (translated back to its old,
// now out-of-bounds position by the FLIP inversion below) until the
// animation caught back up, reading as that row flickering. Past the
// 10-item cap both are no-ops (heights don't change either way, already
// pinned at their caps).
//
// When removing a submenu's very last row, its caller pins the panel at
// its current height first (pinPanelHeight) and passes that as
// `finalBoxHeight`, so the panel holds exactly the same size through the
// row's exit and the re-render to its empty state — no shrink at all —
// with the "no … accounts yet" message fading into the space instead.
// Returns the height to hold: what the panel measures with just this last
// row in it (rows already sliding out are out of flow), not its current
// height. After deleting several quickly, the current height is still
// mid-shrink — much taller — and holding that left an empty panel sized
// as if usernames were still inside. exitListRow animates to this height.
function pinPanelHeight(panelEl) {
  const container = panelEl.querySelector('.dropdown-scroll-items');
  let height = panelEl.offsetHeight;
  if (container) {
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    // Panel chrome (header, padding) + the list hugging just this row.
    height = panelEl.offsetHeight - container.offsetHeight + naturalContentHeight(container);
  }
  panelEl.dataset.heightPinned = '1';
  return height;
}

function unpinPanelHeight(panelEl) {
  if (!panelEl.dataset.heightPinned) return;
  delete panelEl.dataset.heightPinned;
  panelEl.style.height = '';
}

// Hold that size only while the panel stays open — once its close
// transition finishes, drop back to natural sizing so the next open fits
// its (empty-state) content.
[elements.listUnfollowed, elements.listStarred].forEach(panelEl => {
  if (!panelEl) return;
  panelEl.addEventListener('transitionend', (e) => {
    if (e.target === panelEl && e.propertyName === 'opacity' && !panelEl.classList.contains('show')) {
      unpinPanelHeight(panelEl);
    }
  });
});

// iOS/WebKit's momentum scrolling (-webkit-overflow-scrolling: touch, set
// on .dropdown-scroll-items for mobile — see the max-width:1024px rule)
// has a long-documented bug where a scrollable region can get "stuck"
// showing its content clipped to roughly its pre-transition size — here,
// the panel's own opening transform/opacity transition — until something
// forces the browser to recomposite it. Any later star/delete already
// does that incidentally (exitListRow/animatePanelHeightChange both read
// offsetHeight and touch inline styles, forcing a reflow), which is
// exactly why the panel only ever "snapped" to its correct, full size
// after the first edit — nothing forced that same fix on open itself.
// Nudging scrollTop is the standard fix for this class of bug: it forces
// WebKit to recompute the scrollable area's real content bounds
// immediately, rather than leaving it to chance.
function forceDropdownScrollRepaint(listEl) {
  const scrollItems = listEl.querySelector('.dropdown-scroll-items');
  if (!scrollItems) return;
  requestAnimationFrame(() => {
    scrollItems.scrollTop += 1;
    scrollItems.scrollTop -= 1;
  });
}

// Whether rowEl is the only row left on screen in its list. Rows already
// sliding out don't count: state (state.unfollowed/state.starred) isn't
// updated until a row's exit animation finishes, so checking its length
// instead made a quick second delete right after the first miss that it
// was actually removing the last row.
function isLastVisibleRow(rowEl) {
  const container = rowEl.parentElement;
  if (!container) return false;
  return Array.from(container.children)
    .filter(el => el !== rowEl && !el.classList.contains('username-exit')).length === 0;
}

// How many exitListRow animations are currently using each shrinkBox /
// scroll container. Overlapping removals (a second click before the
// first row's exit finishes) each lock and animate the same elements'
// heights, so only the last one to finish may clear those locks — the
// first one clearing them mid-way snapped the panel to its intermediate
// natural height while the second was still animating.
const exitLockCounts = new WeakMap();
function acquireExitLock(el) {
  exitLockCounts.set(el, (exitLockCounts.get(el) || 0) + 1);
}
function releaseExitLock(el) {
  const remaining = (exitLockCounts.get(el) || 1) - 1;
  if (remaining > 0) {
    exitLockCounts.set(el, remaining);
  } else {
    exitLockCounts.delete(el);
  }
  return remaining === 0;
}

// List 3's rows that are actually in the list — excluding ones sliding
// out, which stay in the DOM for their exit animation (and would
// otherwise shift every index-based lookup, e.g. keyboard shortcuts).
function getLiveUnfollowerRows() {
  return Array.from(elements.listUnfollowers.querySelectorAll('.user-row:not(.username-exit)'));
}

function reindexUnfollowerRows() {
  getLiveUnfollowerRows().forEach((row, i) => {
    row.setAttribute('data-index', i);
  });
}


// The row slide used for list 3 and the unfollowed/starred submenus, in
// both directions. Driven by the Web Animations API rather than CSS
// @keyframes: list 3's rows vary in height, so the distance has to come
// from JS, and a CSS variable inside @keyframes (what this used to do)
// doesn't animate in WebKit — on iOS the deleted row just sat still while
// the row below slid up through it.
// The row is also clipped at its own slot's top edge as it moves, so it
// disappears into / emerges from that line instead of sliding over the
// row above it. Row backgrounds are translucent (fully transparent in
// dark mode), so any overlap showed both usernames' text on top of each
// other.
const ROW_SLIDE_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';

// Row motion engine. Every row slide (out, in, and the shifts rows get when
// a row above them leaves or arrives) and every list-height change is a
// "piece" of motion with its own start time; one requestAnimationFrame loop
// sums the active pieces for each element and writes the result as inline
// transform / clip-path / height. Rapid deletes and stars therefore layer
// cleanly: each click adds a piece, nothing in flight is cancelled or
// restarted, and a leaving row keeps moving with its neighbours.
// Done in JS rather than with layered Web Animations (composite: 'add'),
// whose support/behaviour isn't reliable across Safari versions — on iOS
// leaving rows lost their motion and lingered as fragments between the
// rows sliding past them.
function cubicBezierEasing(x1, y1, x2, y2) {
  const sample = (a1, a2, t) => ((1 - 3 * a2 + 3 * a1) * t + (3 * a2 - 6 * a1)) * t * t + 3 * a1 * t;
  const slope = (a1, a2, t) => 3 * (1 - 3 * a2 + 3 * a1) * t * t + 2 * (3 * a2 - 6 * a1) * t + 3 * a1;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sample(x1, x2, t) - x;
      const d = slope(x1, x2, t);
      if (Math.abs(err) < 1e-5 || Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    t = Math.min(1, Math.max(0, t));
    return sample(y1, y2, t);
  };
}
const rowEase = cubicBezierEasing(0.4, 0, 0.2, 1);
// How long every row slide takes — list 3 and the submenus, in and out,
// and the shifts around them. (Was 800ms; shorter feels snappier.)
const ROW_MOTION_MS = 520;

const rowMotion = new Map(); // element -> its active motion pieces
let rowMotionFrame = null;
let rowMotionFlushQueued = false;

// Applies newly added motion before the next paint (so nothing shows a
// frame at its unshifted spot), batched: a re-render that shifts hundreds
// of rows applies them all once, not once per row.
function queueRowMotionFlush() {
  if (rowMotionFlushQueued) return;
  rowMotionFlushQueued = true;
  queueMicrotask(() => {
    rowMotionFlushQueued = false;
    stepRowMotion();
  });
}

// `kind`: what the engine will drive on el — 'transform' (row position +
// clip) or 'height'. A stylesheet transition on that property (list 3's
// rows have `transition: all`) would lag every frame's value behind, so
// it's turned off while moving and restored after. Only for the driven
// property: the submenu panel's own opacity/transform open-close fade must
// keep working while the engine animates its height.
function motionOf(el, kind = 'transform') {
  let m = rowMotion.get(el);
  if (!m) {
    m = { shifts: [], heightShifts: [], heightTarget: null, heightExtra: 0, slide: null, savedTransition: null };
    rowMotion.set(el, m);
  }
  if (!m.suppressTransition) {
    // Only read here; the write happens in stepRowMotion. Callers add
    // motion to many rows in a row between layout reads, and a style write
    // per row would force a fresh layout for each of them.
    const tp = getComputedStyle(el).transitionProperty || '';
    const driven = kind === 'height' ? /\b(all|height)\b/ : /\b(all|transform|clip-path)\b/;
    if (driven.test(tp)) m.suppressTransition = true;
  }
  return m;
}

// A piece's clock starts on the first frame after it's added, not when it's
// added: the code adding motion can be followed by a lot of other work
// (switching accounts loads lists, redraws chips, …) before anything can be
// painted, and counting that time skipped the start of every slide — the
// motion looked faster and jumpier than the same slide elsewhere.
function motionProgress(piece, now) {
  if (piece.start === null) return 0;
  return Math.min(1, Math.max(0, (now - piece.start) / piece.duration));
}

function stepRowMotion(fromFrame = false) {
  if (fromFrame) rowMotionFrame = null;
  const now = performance.now();
  const finished = [];
  rowMotion.forEach((m, el) => {
    if (fromFrame) {
      m.shifts.forEach(p => { if (p.start === null) p.start = now; });
      m.heightShifts.forEach(p => { if (p.start === null) p.start = now; });
      if (m.slide && m.slide.start === null) m.slide.start = now;
    }
    if (m.suppressTransition && m.savedTransition === null) {
      m.savedTransition = el.style.transition;
      el.style.transition = 'none';
    }
    m.shifts = m.shifts.filter(p => motionProgress(p, now) < 1);
    m.heightShifts = m.heightShifts.filter(p => motionProgress(p, now) < 1);

    let ty = 0;
    m.shifts.forEach(p => { ty += p.offset * (1 - rowEase(motionProgress(p, now))); });
    let clip = 0;
    let slideActive = false;
    if (m.slide) {
      const raw = motionProgress(m.slide, now);
      const e = rowEase(raw);
      if (m.slide.dir === 'out') {
        ty -= m.slide.distance * e;
        clip = m.slide.distance * e;
        if (raw >= 1 && m.slide.onDone) {
          finished.push(m.slide.onDone);
          m.slide.onDone = null;
        }
        // Stays applied (fully slid out) until the row is removed.
        slideActive = el.isConnected || raw < 1;
      } else {
        ty -= m.slide.distance * (1 - e);
        clip = m.slide.distance * (1 - e);
        slideActive = raw < 1;
        if (!slideActive) m.slide = null;
      }
    }

    el.style.transform = Math.abs(ty) > 0.01 ? `translateY(${ty}px)` : '';
    const clipValue = clip > 0.01 ? `inset(${clip}px 0px 0px 0px)` : '';
    el.style.clipPath = clipValue;
    el.style.webkitClipPath = clipValue;

    if (m.heightTarget !== null) {
      let dh = 0;
      m.heightShifts.forEach(p => { dh += p.offset * (1 - rowEase(motionProgress(p, now))); });
      el.style.height = `${m.heightTarget + dh - m.heightExtra}px`;
    }

    if (!m.shifts.length && !m.heightShifts.length && !slideActive) {
      if (m.savedTransition !== null) el.style.transition = m.savedTransition;
      rowMotion.delete(el);
    }
  });
  // Run slide-out completions (removing the row, updating state) after the
  // loop, since they may add or remove motion themselves.
  finished.forEach(fn => fn());
  // One frame callback at a time; an immediate apply (queueRowMotionFlush)
  // leaves an already-scheduled one in place.
  if (rowMotion.size > 0 && rowMotionFrame === null) {
    rowMotionFrame = requestAnimationFrame(() => stepRowMotion(true));
  }
}

// `onDone` runs once the slide has actually played out (see motionProgress).
function slideRowOut(rowEl, distance, duration, onDone = null) {
  const slide = { dir: 'out', distance, start: null, duration, onDone };
  motionOf(rowEl).slide = slide;
  // Frames don't run in a background tab — make sure the completion (which
  // saves state) still happens if the page never paints again. But not the
  // moment you come back: tapping a row opens instagram, the page sleeps,
  // and this timer used to fire the instant it woke, before the slide got
  // a single frame — the row just vanished. While the page is hidden it
  // waits for it to show again (and lets the slide play); it only steps in
  // if the page is closed, or frames really aren't coming.
  if (onDone) {
    const finish = () => {
      if (slide.onDone) {
        const fn = slide.onDone;
        slide.onDone = null;
        fn();
      }
    };
    const check = () => {
      if (!slide.onDone) return;
      if (document.visibilityState === 'hidden') {
        document.addEventListener('visibilitychange', () => setTimeout(check, duration + 1000), { once: true });
        window.addEventListener('pagehide', finish, { once: true });
        return;
      }
      if (slide.start !== null && performance.now() - slide.start < duration + 500) {
        setTimeout(check, duration + 1000); // it's playing: let it finish
        return;
      }
      finish();
    };
    setTimeout(check, duration + 1000);
  }
  queueRowMotionFlush();
}

function slideRowIn(rowEl, distance, duration) {
  motionOf(rowEl).slide = { dir: 'in', distance, start: null, duration };
  queueRowMotionFlush();
}

// Drops all motion from el and clears what it wrote.
function stopRowMotion(el) {
  const m = rowMotion.get(el);
  if (!m) return;
  if (m.savedTransition !== null) el.style.transition = m.savedTransition;
  if (m.slide && m.slide.onDone) m.slide.onDone();
  el.style.transform = '';
  el.style.clipPath = '';
  el.style.webkitClipPath = '';
  rowMotion.delete(el);
}

// A list 3 row that starts leaving stops counting straight away: the
// remaining rows' 1-9/0 badges renumber now (not once its slide ends, which
// left a row showing "2" while key 1 opened it), and it drops its
// selection ring so it can't look selected next to the newly selected row.
function onRowExitStarted(rowEl) {
  if (!rowEl.classList.contains('user-row')) return;
  rowEl.classList.remove('selected');
  reindexUnfollowerRows();
}

// Slides el from `offset` px back to where it is, on top of anything it's
// already doing (see the row motion engine above).
function addRowShift(el, offset, duration) {
  if (Math.abs(offset) < 0.5) return;
  // A row that's out of sight for the whole slide just takes its new spot:
  // animating hundreds of off-screen rows meant restyling every one of them
  // on every frame, and the visible slide stuttered on long lists.
  const box = el.parentElement && el.parentElement.getBoundingClientRect();
  if (box && !rowMotion.has(el)) {
    const r = el.getBoundingClientRect();
    const reach = Math.abs(offset) + 80;
    const top = Math.max(box.top, 0), bottom = Math.min(box.bottom, window.innerHeight);
    if (r.bottom + reach < top || r.top - reach > bottom) return;
  }
  motionOf(el).shifts.push({ offset, start: null, duration });
  queueRowMotionFlush();
}

// Sets el's height to `targetPx` (border-box) and animates the change from
// `targetPx + offset`, likewise on top of any height change in flight.
function setHeightWithShift(el, targetPx, offset, duration) {
  const cs = getComputedStyle(el);
  const extra = cs.boxSizing === 'border-box' ? 0
    : parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const m = motionOf(el, 'height');
  m.heightTarget = targetPx;
  m.heightExtra = extra;
  if (Math.abs(offset) >= 0.5) {
    m.heightShifts.push({ offset, start: null, duration });
  }
  queueRowMotionFlush();
}

// The height (border-box) a row container takes when it just hugs the rows
// still in its flow, up to its own max-height — computed from layout
// positions, so height/transform animations running on it or its rows
// don't affect the answer. The container must be positioned (offsetTop is
// relative to it).
function naturalContentHeight(container) {
  const cs = getComputedStyle(container);
  const borders = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const rows = Array.from(container.children).filter(el => getComputedStyle(el).position !== 'absolute');
  let height;
  if (rows.length === 0) {
    height = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + borders;
  } else {
    const last = rows[rows.length - 1];
    height = last.offsetTop + last.offsetHeight + (parseFloat(getComputedStyle(last).marginBottom) || 0)
      + parseFloat(cs.paddingBottom) + borders;
  }
  const cap = parseFloat(cs.maxHeight);
  return Number.isFinite(cap) ? Math.min(height, cap) : height;
}

function exitListRow(rowEl, onComplete, { shrinkBox, finalBoxHeight } = {}) {
  // A row already sliding out ignores any further attempt to remove it
  // again (rapid repeat clicks on the same button used to stack a second
  // exit and a second onComplete on top of the first).
  if (rowEl.classList.contains('username-exit')) {
    return;
  }

  // Stop a slide-in still running on it (a username removed again right
  // after sliding back in). Shifts it's doing because of *other* rows'
  // removals are layered animations and keep running, so it stays exactly
  // in step with its neighbours while it leaves.
  const motion = rowMotion.get(rowEl);
  if (motion && motion.slide && motion.slide.dir === 'in') {
    const now = performance.now();
    const left = motion.slide.distance * (1 - rowEase(motionProgress(motion.slide, now)));
    motion.slide = null;
    if (left > 0.5) motion.shifts.push({ offset: -left, start: null, duration: ROW_MOTION_MS });
  }

  // Slide distance: one full row pitch (its height plus the gap below it),
  // exactly how far the rows below it move up to close the gap. Works for
  // both list 3 rows (which vary in height) and the submenus' fixed rows.
  const exitDistance = rowEl.offsetHeight + (parseFloat(getComputedStyle(rowEl).marginBottom) || 0);

  const DURATION = ROW_MOTION_MS;
  const container = rowEl.parentElement;

  if (!container) {
    rowEl.classList.add('username-exit');
    slideRowOut(rowEl, exitDistance, DURATION, () => {
      rowEl.remove();
      onComplete();
    });
    onRowExitStarted(rowEl);
    return;
  }

  if (getComputedStyle(container).position === 'static') {
    container.style.position = 'relative';
  }

  // Rows still in the list (ones already sliding out are out of flow).
  const siblings = Array.from(container.children)
    .filter(el => el !== rowEl && !el.classList.contains('username-exit'));

  // BEFORE: layout positions/heights (unaffected by the transforms and
  // height animations earlier removals may still be running).
  const topsBefore = siblings.map(el => el.offsetTop);
  const containerBefore = shrinkBox ? naturalContentHeight(container) : null;
  const boxNow = shrinkBox ? shrinkBox.offsetHeight : null;

  // Take the row out of flow, pinned at its layout slot — the layered
  // shifts it's still doing keep it visually where it was.
  const rowTop = rowEl.offsetTop;
  const rowLeft = rowEl.offsetLeft;
  const rowWidth = rowEl.offsetWidth;
  rowEl.style.position = 'absolute';
  rowEl.style.top = `${rowTop}px`;
  rowEl.style.left = `${rowLeft}px`;
  rowEl.style.width = `${rowWidth}px`;
  rowEl.style.margin = '0';
  rowEl.style.zIndex = '1';

  // AFTER: every row below moved up in layout by this removal alone; add
  // exactly that as a new slide on top of whatever each is already doing.
  siblings.forEach((el, i) => addRowShift(el, topsBefore[i] - el.offsetTop, DURATION));

  if (shrinkBox) {
    // The list's own height (it hugs its rows below its 10-row cap) shrinks
    // by the same amount, layered the same way; the panel's height follows
    // it. Without this the list's clipping edge would jump up at once and
    // cut off the bottom row while it's still sliding up.
    const containerAfter = naturalContentHeight(container);
    setHeightWithShift(container, containerAfter, containerBefore - containerAfter, DURATION);
    // Last row: the panel instead holds the one-row size (pinPanelHeight),
    // easing there from wherever it is now — after rapid deletes that can
    // still be well above it, mid-shrink.
    if (finalBoxHeight != null) {
      setHeightWithShift(shrinkBox, finalBoxHeight, boxNow - finalBoxHeight, DURATION);
    }
    acquireExitLock(container);
  }

  rowEl.classList.add('username-exit');
  slideRowOut(rowEl, exitDistance, DURATION, () => {
    rowEl.remove();
    // Only the last overlapping removal to finish hands the list its
    // natural height back — by then every layered shrink has played out.
    if (shrinkBox && releaseExitLock(container)) {
      // Stop driving its height first, so the next frame doesn't write a
      // fixed height back over 'auto'.
      const containerMotion = rowMotion.get(container);
      if (containerMotion) {
        containerMotion.heightShifts = [];
        containerMotion.heightTarget = null;
      }
      container.style.height = '';
    }
    onComplete();
  });
  onRowExitStarted(rowEl);
  stepRowMotion(); // apply now, so anything measuring right after sees it
}

// Animates the unfollowed/starred panel's own height settling to match a
// fresh render of its content, so it visibly grows/shrinks to fit 1-10
// items (and down to the small empty-state message once the list runs
// out entirely — the panel no longer force-closes itself at 0, see
// updateUnfollowedUI/updateStarredUI) instead of snapping to its new
// size. Below 10 items .dropdown-scroll-items hugs its actual content
// (see its own max-height cap in updateUnfollowedUI/updateStarredUI); at
// 10 or more it's already pinned at the cap, so startHeight === endHeight
// there and this is a harmless no-op. Call with the panel's shown/height
// state read *before* re-rendering it.
const panelResizeTimers = new WeakMap();
function animatePanelHeightChange(listEl, startedShown, startHeight) {
  if (!startedShown || startHeight === null) return;
  const endHeight = listEl.offsetHeight;
  if (endHeight === startHeight) return;

  const DURATION = 420;
  listEl.style.height = `${startHeight}px`;
  void listEl.offsetHeight; // commit the locked starting height before animating away from it
  // Combined with (not replacing) the panel's own opacity/transform
  // .show-class transition from CSS — an inline `transition` overrides
  // the stylesheet's outright, and losing that mid-resize would make the
  // panel snap instantly if the user closes it before this finishes.
  listEl.style.transition = `height ${DURATION}ms cubic-bezier(0.16, 1, 0.3, 1), opacity 0.6s cubic-bezier(0.16, 1, 0.3, 1), transform 0.6s cubic-bezier(0.16, 1, 0.3, 1)`;
  listEl.style.height = `${endHeight}px`;

  // A newer resize takes over: an older one's cleanup used to fire in the
  // middle of it and snap the panel to its final size.
  clearTimeout(panelResizeTimers.get(listEl));
  panelResizeTimers.set(listEl, setTimeout(() => {
    panelResizeTimers.delete(listEl);
    listEl.style.transition = '';
    listEl.style.height = '';
  }, DURATION));
}

// Matches the unfollowed/starred panel's width to its own toggle button's
// rendered width, not the wrapper around it — the button is
// width: fit-content (hugs its label) inside a flex: 1 1 0 wrapper that's
// usually noticeably wider, so a plain CSS width: 100% on the panel (which
// resolves against the wrapper) leaves the dropdown visibly wider than the
// control that opened it. Only JS can read the button's actual box, so
// this sets it as an inline style; style.css leaves width unset for this
// case specifically so it doesn't fight the JS value.
function syncDropdownWidthToButton(listEl, toggleBtn) {
  if (!listEl || !toggleBtn) return;
  const width = toggleBtn.offsetWidth;
  if (width > 0) {
    listEl.style.width = `${width}px`;
  }
}

// The toggle buttons' own width can change across the app's responsive
// breakpoints (font-size/padding/label-abbreviation all shift with
// viewport width) without state.unfollowed/state.starred ever changing,
// so updateUnfollowedUI/updateStarredUI's own sync call never re-runs on
// its own — re-sync on resize too, so the panel doesn't end up stuck at
// whatever width its button happened to be the last time its list changed.
let dropdownWidthResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(dropdownWidthResizeTimer);
  dropdownWidthResizeTimer = setTimeout(() => {
    syncDropdownWidthToButton(elements.listUnfollowed, elements.togglePreviewUnfollowed);
    syncDropdownWidthToButton(elements.listStarred, elements.togglePreviewStarred);
  }, 150);
});

// Freezes the page behind a modal. overflow: hidden alone doesn't stop
// iOS Safari from scrolling the page underneath, so the body is pinned in
// place (position: fixed at the current scroll offset) and put back where
// it was afterwards. Logged out, the scrolling page is the login overlay.
let pageScrollLock = null;
function lockPageScroll() {
  if (pageScrollLock) return;
  const body = document.body;
  const overlay = body.classList.contains('auth-logged-out') ? elements.authDropdown : null;
  pageScrollLock = {
    y: window.scrollY,
    overlay,
    saved: { position: body.style.position, top: body.style.top, left: body.style.left, right: body.style.right, width: body.style.width, overflow: body.style.overflow },
    overlayOverflow: overlay ? overlay.style.overflow : null
  };
  body.style.position = 'fixed';
  body.style.top = `-${pageScrollLock.y}px`;
  body.style.left = '0';
  body.style.right = '0';
  body.style.width = '100%';
  body.style.overflow = 'hidden';
  if (overlay) overlay.style.setProperty('overflow', 'hidden', 'important');
}
function unlockPageScroll() {
  if (!pageScrollLock) return;
  const { y, saved, overlay, overlayOverflow } = pageScrollLock;
  pageScrollLock = null;
  Object.assign(document.body.style, saved);
  if (overlay) {
    overlay.style.removeProperty('overflow');
    if (overlayOverflow) overlay.style.overflow = overlayOverflow;
  }
  window.scrollTo(0, y);
}

// "try a demo" (import files menu): a demo account chip shown as @shihcb,
// with two test usernames in list 3 to try unfollowing, starring and so on.
// It's a different account from any real @shihcb: its internal id
// (originalUsername, which every account's saved data is keyed by) is
// DEMO_ID and it's marked `demo: true`. Nothing about it is kept — it's
// left out of the saved account list and the cloud (saveAccountsList,
// pushToCloudNow), its data is wiped on every "try a demo" and on reload,
// and importing real files for @shihcb turns it into that real account
// (ensureAccountSelected).
const DEMO_ID = '__demo__';
const DEMO_NAME = 'shihcb';
const DEMO_FOLLOWING = ['shihcb', 'cloudyandhazel'];

function isDemoAccount(acc) {
  return !!acc && (acc.demo === true || String(acc.originalUsername).toLowerCase() === DEMO_ID);
}

// The saved account list: everything except the demo chip.
function saveAccountsList() {
  storageSet('instagram_accounts', JSON.stringify((state.instagramAccounts || []).filter(acc => !isDemoAccount(acc))));
}

// Removes every trace of the demo's data from this device.
function clearDemoData() {
  ['following', 'followers', 'unfollowed', 'starred', 'hidden'].forEach(type => storageRemove(`${type}_users_${DEMO_ID}`));
  ['import_date_', 'import_history_', 'import_diff_', 'extra_lists_'].forEach(prefix => storageRemove(`${prefix}${DEMO_ID}`));
  ['last_active_instagram_account', 'selected_instagram_account'].forEach(key => {
    if (storageGet(key) === DEMO_ID) storageRemove(key);
  });
}

function startDemo() {
  normalizeInstagramAccounts();
  if (!(state.instagramAccounts || []).some(isDemoAccount) && state.instagramAccounts.length >= MAX_ACCOUNTS) {
    showAccountLimitAlert();
    return;
  }
  normalizeInstagramAccounts();
  if (state.selectedAccountUsername && state.selectedAccountUsername.toLowerCase() !== DEMO_ID) {
    saveCurrentAccountData();
  }
  // A fresh demo every time: both usernames back, nothing unfollowed or
  // starred from an earlier try.
  clearDemoData();
  const users = DEMO_FOLLOWING.map(name => ({
    username: name, originalUsername: name, fullName: '', timestamp: null,
    profileUrl: `https://www.instagram.com/${name}/`
  }));
  storageSet(`following_users_${DEMO_ID}`, JSON.stringify(users));
  storageSet(`followers_users_${DEMO_ID}`, '[]');
  storageSet(`unfollowed_users_${DEMO_ID}`, '[]');
  storageSet(`starred_users_${DEMO_ID}`, '[]');
  // The results tab's other lists, as if the whole export was imported:
  // one close friend who doesn't follow back, the rest empty.
  writeExtraLists(DEMO_ID, { pending: [], closeFriends: [users[1]], blocked: [], restricted: [] });
  if (!state.instagramAccounts.some(isDemoAccount)) {
    state.instagramAccounts.push({ username: DEMO_NAME, originalUsername: DEMO_ID, demo: true });
  }
  state.selectedAccountUsername = DEMO_ID;
  // Its chip fades in and list 3's usernames slide in, like adding an account.
  loadAccountData(DEMO_ID, true, true);
}

function setupEventListeners() {
  // Instagram Account Management Event Listeners
  if (elements.btnAddAccount) {
    elements.btnAddAccount.addEventListener('click', (e) => {
      e.stopPropagation();
      const isShown = elements.addAccountDropdownMenu.classList.toggle('show');
      elements.btnAddAccount.classList.toggle('active', isShown);

      // Close other dropdowns
      elements.listUnfollowed.classList.remove('show');
      elements.togglePreviewUnfollowed.classList.remove('active');
      elements.listStarred.classList.remove('show');
      elements.togglePreviewStarred.classList.remove('active');
    });
  }

  // The import files menu drops down over the chip row (nearly full width
  // on phones): anything it starts closes the menu first, and a new chip
  // comes in once the menu has cleared — it used to play its whole
  // entrance hidden under the menu, so it seemed to just snap in.
  const closeImportMenu = () => {
    if (elements.addAccountDropdownMenu) elements.addAccountDropdownMenu.classList.remove('show');
    if (elements.btnAddAccount) elements.btnAddAccount.classList.remove('active');
  };
  const btnTryDemo = document.getElementById('btn-try-demo');
  if (btnTryDemo) {
    btnTryDemo.addEventListener('click', () => {
      closeImportMenu();
      setTimeout(startDemo, OVERLAY_CLEAR_MS);
    });
  }

  // Upload zip: the same file picker and import as "upload files", showing
  // only .zip files (Instagram's export as it arrives).
  const btnUploadZip = document.getElementById('btn-upload-zip');
  if (btnUploadZip && elements.importFilesInput) {
    const input = elements.importFilesInput;
    const allFiles = input.getAttribute('accept');
    const restore = () => input.setAttribute('accept', allFiles);
    input.addEventListener('change', restore);
    window.addEventListener('focus', () => setTimeout(restore, 500)); // picker closed without a choice
    btnUploadZip.addEventListener('click', () => {
      closeImportMenu();
      input.setAttribute('accept', '.zip,application/zip');
      input.click();
    });
  }

  if (elements.btnUploadFiles) {
    elements.btnUploadFiles.addEventListener('click', () => {
      closeImportMenu(); // gone by the time the files come back
      if (elements.importFilesInput) {
        elements.importFilesInput.click();
      }
    });
  }

  if (elements.btnUploadFolder) {
    elements.btnUploadFolder.addEventListener('click', () => {
      closeImportMenu();
      if (elements.importFolderInput) {
        elements.importFolderInput.click();
      }
    });
  }
  if (elements.btnModalSave) {
    elements.btnModalSave.addEventListener('click', saveAccountFromModal);
  }
  if (elements.btnModalDelete) {
    elements.btnModalDelete.addEventListener('click', deleteAccountFromModal);
  }
  if (elements.btnModalClose) {
    elements.btnModalClose.addEventListener('click', closeAccountModal);
  }
  if (elements.accountModalOverlay) {
    elements.accountModalOverlay.addEventListener('click', (e) => {
      if (e.target === elements.accountModalOverlay) closeAccountModal();
    });
  }
  if (elements.accountUsernameInput) {
    elements.accountUsernameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveAccountFromModal();
      else if (e.key === 'Escape') closeAccountModal();
    });
  }

  // Instructions Modal Event Listeners
  if (elements.btnInstructionsInfo) {
    elements.btnInstructionsInfo.addEventListener('click', (e) => {
      e.stopPropagation();
      openInstructionsModal(1);
    });
  }
  if (elements.btnEmptyInstructions) {
    elements.btnEmptyInstructions.addEventListener('click', (e) => {
      e.stopPropagation();
      openInstructionsModal(1);
    });
  }
  if (elements.btnInstructionsModalClose) {
    elements.btnInstructionsModalClose.addEventListener('click', closeInstructionsModal);
  }
  if (elements.instructionsModalOverlay) {
    elements.instructionsModalOverlay.addEventListener('click', (e) => {
      if (e.target === elements.instructionsModalOverlay) closeInstructionsModal();
    });
  }
  if (elements.btnInstructionsPrev) {
    elements.btnInstructionsPrev.addEventListener('click', () => {
      if (currentInstructionStep > 1) {
        currentInstructionStep--;
        updateInstructionsStepUI();
      }
    });
  }
  if (elements.btnInstructionsNext) {
    elements.btnInstructionsNext.addEventListener('click', () => {
      if (currentInstructionStep < 5) {
        currentInstructionStep++;
        updateInstructionsStepUI();
      } else {
        closeInstructionsModal();
      }
    });
  }
  if (elements.btnInstructionsBack) {
    elements.btnInstructionsBack.addEventListener('click', () => {
      if (currentInstructionStep > 1) {
        currentInstructionStep--;
        updateInstructionsStepUI();
      }
    });
  }

  // Instructions step tabs & dots click handlers
  document.querySelectorAll('.instructions-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const s = parseInt(tab.getAttribute('data-step'), 10);
      if (s) {
        currentInstructionStep = s;
        updateInstructionsStepUI();
      }
    });
  });
  document.querySelectorAll('.instructions-step-dots .dot').forEach((dot) => {
    dot.addEventListener('click', () => {
      const s = parseInt(dot.getAttribute('data-step'), 10);
      if (s) {
        currentInstructionStep = s;
        updateInstructionsStepUI();
      }
    });
  });

  // Instructions Modal Keyboard Shortcuts (Esc, Left/Right Arrows, Enter)
  window.addEventListener('keydown', (e) => {
    // Not while it's closing either (arrows kept flipping steps as it faded).
    if (!elements.instructionsModalOverlay || !elements.instructionsModalOverlay.classList.contains('show')) {
      return;
    }

    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      closeInstructionsModal();
    } else if (e.key === 'ArrowLeft' || e.key === 'Left') {
      e.preventDefault();
      if (currentInstructionStep > 1) {
        currentInstructionStep--;
        updateInstructionsStepUI();
      }
    } else if (e.key === 'ArrowRight' || e.key === 'Right') {
      e.preventDefault();
      if (currentInstructionStep < 5) {
        currentInstructionStep++;
        updateInstructionsStepUI();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (currentInstructionStep < 5) {
        currentInstructionStep++;
        updateInstructionsStepUI();
      } else {
        closeInstructionsModal();
      }
    }
  });

// -------------------------------------------------------------
// Instructions / How-To-Use Modal Logic
// -------------------------------------------------------------
let currentInstructionStep = 1;

function openInstructionsModal(step = 1) {
  if (!elements.instructionsModalOverlay) return;
  const overlay = elements.instructionsModalOverlay;
  currentInstructionStep = step;

  const indicator = elements.instructionsNavIndicator || document.getElementById('instructions-nav-indicator');
  // Everything inside is put in place before the window starts to fade in
  // (it used to be done a frame into the animation: the step, the tab
  // highlight and the tab bar's scroll all jumped while the window was
  // appearing, which read as a snap). Laid out but still invisible here.
  cancelOverlayHide(overlay);
  overlay.classList.remove('hidden');
  overlay.classList.add('opening');
  if (indicator) {
    indicator.classList.add('no-transition');
    indicator._pos = null;
  }
  instructionsInstant = true;
  updateInstructionsStepUI();
  instructionsInstant = false;
  if (indicator) indicator.classList.remove('no-transition');
  showModalOverlay(overlay);
  lockPageScroll();
  setTimeout(() => overlay.classList.remove('opening'), 600);
}

function closeInstructionsModal() {
  if (!elements.instructionsModalOverlay) return;
  elements.instructionsModalOverlay.classList.remove('show');
  unlockPageScroll();
  // 600ms, matching .modal-overlay/.account-modal-card's own CSS transition
  // duration (style.css) — see closeAccountModal for why this can't be 350.
  scheduleOverlayHide(elements.instructionsModalOverlay, () => {
    elements.instructionsModalOverlay.classList.add('hidden');
  });
}
window.closeInstructionsModal = closeInstructionsModal;
// Decode the step pictures ahead of time, while nothing's happening, so the
// first open doesn't stall on them mid-animation.
(window.requestIdleCallback || ((fn) => setTimeout(fn, 1500)))(() => {
  document.querySelectorAll('#instructions-modal-overlay img').forEach(img => {
    if (typeof img.decode === 'function') img.decode().catch(() => {});
  });
});
// Shared with the insights window (features.js): same tab highlight/scroll.
window.moveInstructionsIndicator = moveInstructionsIndicator;
window.scrollInstructionsNav = scrollInstructionsNav;

// Slides the highlight to `tab` like the log in / sign up switch does:
// same duration and easing, transform only (FLIP: it takes its new size at
// once, then is scaled back from its old spot and size), so the whole move
// stays on the GPU and in one piece. A switch mid-slide starts from where
// the highlight actually is.
// Scrolls the tab bar in step with the highlight: same duration and
// easing. The browser's own smooth scroll starts much faster than the
// highlight's ease-in, so the highlight was first dragged back with the
// tabs and then swung forward — the choppy part of the switch.
const instructionsEase = cubicBezierEasing(0.4, 0, 0.2, 1); // the highlight's (IND_EASE)
let instructionsInstant = false; // opening: jump straight there
function scrollInstructionsNav(nav, target) {
  const max = nav.scrollWidth - nav.clientWidth;
  const end = Math.max(0, Math.min(max, target));
  nav._scrollToken = {};
  // Where the tabs are drawn right now: the scroll position plus whatever
  // is left of a scroll still gliding.
  let residual = 0;
  if (nav._scrollAnims) {
    const first = nav._scrollAnims[0] && nav._scrollAnims[0].effect && nav._scrollAnims[0].effect.target;
    if (first) residual = new DOMMatrixReadOnly(getComputedStyle(first).transform).m41 || 0;
    nav._scrollAnims.forEach(an => an.cancel());
    nav._scrollAnims = null;
  }
  const visual = nav.scrollLeft - residual;
  if (instructionsInstant) { nav.scrollLeft = end; return; }
  if (Math.abs(end - visual) < 0.5) { nav.scrollLeft = end; return; }
  // The scroll jumps to where it ends, and the tabs and highlight glide
  // there from where they were drawn — by transform only, on the GPU.
  // Animating scrollLeft frame by frame ran on the main thread and was
  // choppy on phones.
  nav.scrollLeft = end;
  const delta = nav.scrollLeft - visual;
  if (typeof nav.animate !== 'function') return;
  nav._scrollAnims = [...nav.children].map(el => el.animate(
    [{ transform: `translateX(${delta}px)` }, { transform: 'translateX(0)' }],
    { duration: IND_MS, easing: IND_EASE }));
}

// The highlight is an outline, and animating its width ran on the main
// thread (it stuttered on phones); scaling it would stretch its border.
// So it's drawn as three pieces that only ever move by transform (on the
// GPU): a left cap, a middle that stretches (only its top and bottom
// edges, which don't distort when stretched sideways) and a right cap.
// All three share one timing, so they stay joined the whole way.
const IND_CAP = 9;       // cap width (a little over the corner radius)
const IND_MID_BASE = 100; // the middle's unscaled width
const IND_MS = 560;
// A gentle glide that starts softly: the window's fast-start curve covered
// most of the distance in the first few frames, which read as a snap.
const IND_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';
function indicatorParts(indicator) {
  if (indicator._parts) return indicator._parts;
  indicator.classList.add('ind-split');
  indicator.innerHTML = '<span class="ind-l"></span><span class="ind-m"></span><span class="ind-r"></span>';
  const [l, m, r] = indicator.children;
  indicator._parts = { l, m, r };
  return indicator._parts;
}
function indicatorFrames(x, w) {
  const mid = Math.max(0, w - IND_CAP * 2) / IND_MID_BASE;
  return {
    l: `translateX(${x}px)`,
    m: `translateX(${x + IND_CAP}px) scaleX(${mid})`,
    r: `translateX(${x + w - IND_CAP}px)`
  };
}
function moveInstructionsIndicator(indicator, tab) {
  const x = tab.offsetLeft;
  const w = tab.offsetWidth;
  // A tab with no size yet (not laid out, fonts still loading): drawing the
  // outline from it left only its left end. Whoever placed it retries.
  if (!w) return;
  const parts = indicatorParts(indicator);
  let from = indicator._pos || null;
  // Mid-slide: start from where the pieces are right now.
  if (indicator._anims && indicator._anims.some(an => an.playState === 'running') && from) {
    const tx = (el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41;
    const lx = tx(parts.l), rx = tx(parts.r);
    from = { x: lx, w: rx - lx + IND_CAP };
  }
  if (indicator._anims) indicator._anims.forEach(an => an.cancel());
  indicator._anims = null;
  const to = indicatorFrames(x, w);
  parts.l.style.transform = to.l;
  parts.m.style.transform = to.m;
  parts.r.style.transform = to.r;
  indicator._pos = { x, w };
  const moved = from && (Math.abs(from.x - x) > 0.5 || Math.abs(from.w - w) > 0.5);
  if (!moved || indicator.classList.contains('no-transition') || typeof parts.l.animate !== 'function') return;
  const f = indicatorFrames(from.x, from.w);
  const timing = { duration: IND_MS, easing: IND_EASE };
  indicator._anims = ['l', 'm', 'r'].map(k => parts[k].animate([{ transform: f[k] }, { transform: to[k] }], timing));
}

function settleStepOut(pane) {
  pane.getAnimations && pane.getAnimations().forEach(an => an.cancel());
  pane.classList.remove('pane-out');
}

function updateInstructionsStepUI() {
  const tabs = document.querySelectorAll('.instructions-tab');
  const panes = document.querySelectorAll('.instructions-step-pane');
  const dots = document.querySelectorAll('.instructions-step-dots .dot');

  let activeTab = null;
  tabs.forEach((tab) => {
    const s = parseInt(tab.getAttribute('data-step'), 10);
    const isActive = (s === currentInstructionStep);
    tab.classList.toggle('active', isActive);
    if (isActive) {
      activeTab = tab;
    }
  });

  if (activeTab) {
    // Its own bar (list 3's switcher shares the class and comes first).
    const nav = activeTab.closest('.instructions-steps-nav');
    if (nav) {
      const nextTab = document.querySelector(`.instructions-tab[data-step="${currentInstructionStep + 1}"]`);
      const peekOffset = nextTab ? 38 : 12;

      const tabLeft = activeTab.offsetLeft - 12;
      const tabRight = activeTab.offsetLeft + activeTab.offsetWidth + peekOffset;
      const navScrollLeft = nav.scrollLeft;
      const navWidth = nav.clientWidth;

      if (tabLeft < navScrollLeft) {
        scrollInstructionsNav(nav, Math.max(0, tabLeft));
      } else if (tabRight > navScrollLeft + navWidth) {
        scrollInstructionsNav(nav, tabRight - navWidth);
      }
    }
  }

  const indicator = elements.instructionsNavIndicator || document.getElementById('instructions-nav-indicator');
  if (indicator && activeTab) moveInstructionsIndicator(indicator, activeTab);

  // Changing steps: every step sits in the same spot (stacked), always laid
  // out, and only the current one shows — so switching never changes the
  // layout. The step you leave slides away while the new one slides in; a
  // tap mid-slide carries on from where each step is drawn.
  const newPane = [...panes].find(p => parseInt(p.id.replace('instructions-step-', ''), 10) === currentInstructionStep);
  const shown = [...panes].filter(p => p.classList.contains('active') || p.classList.contains('pane-out'));
  const prevActive = [...panes].find(p => p.classList.contains('active'));
  const at = new Map(shown.map(p => { const cs = getComputedStyle(p); return [p, { x: new DOMMatrixReadOnly(cs.transform).m41 || 0, o: +cs.opacity }]; }));
  shown.forEach(p => p.getAnimations().forEach(an => an.cancel()));
  clearTimeout(updateInstructionsStepUI._timer);
  panes.forEach(p => { p.classList.toggle('active', p === newPane); p.classList.toggle('pane-out', p !== newPane && shown.includes(p)); });
  if (prevActive && newPane && prevActive !== newPane && !instructionsInstant && typeof newPane.animate === 'function') {
    const oldStep = parseInt(prevActive.id.replace('instructions-step-', ''), 10);
    const dir = currentInstructionStep > oldStep ? 1 : -1;
    const w = newPane.parentElement.clientWidth;
    const D = TAB_MOTION.in.duration;
    const timing = (dist) => ({ duration: Math.round(D * Math.min(1, Math.max(0.35, Math.abs(dist) / w))), easing: TAB_MOTION.in.easing });
    let longest = 0;
    const from = at.get(newPane) || { x: dir * w, o: 0.35 };
    const tIn = timing(from.x); longest = tIn.duration;
    newPane.animate([{ transform: `translateX(${from.x}px)`, opacity: from.o }, { transform: 'translateX(0)', opacity: 1 }], tIn);
    const stepOf = (p) => parseInt(p.id.replace('instructions-step-', ''), 10);
    shown.filter(p => p !== newPane).forEach(p => {
      const f = at.get(p) || { x: 0, o: 1 };
      const to = stepOf(p) < currentInstructionStep ? -w : w; // carousel order
      if (Math.sign(f.x) === -Math.sign(to) && Math.abs(f.x) > 0.4 * w) {
        p.animate([{ transform: `translateX(${f.x}px)`, opacity: f.o }, { transform: `translateX(${f.x}px)`, opacity: 0 }], { duration: 90, fill: 'forwards' });
        return;
      }
      const t = timing(to - f.x); longest = Math.max(longest, t.duration);
      p.animate([{ transform: `translateX(${f.x}px)`, opacity: f.o }, { transform: `translateX(${to}px)`, opacity: 0.35 }], { ...t, fill: 'forwards' });
    });
    updateInstructionsStepUI._timer = setTimeout(() => panes.forEach(p => { if (p !== [...panes].find(q => q.classList.contains('active'))) settleStepOut(p); }), longest + 30);
  } else {
    panes.forEach(p => { if (p !== newPane) settleStepOut(p); });
  }

  dots.forEach((dot) => {
    const s = parseInt(dot.getAttribute('data-step'), 10);
    dot.classList.toggle('active', s === currentInstructionStep);
  });

  // The arrows: back is dimmed on the first step; on the last step the
  // next arrow widens into a "close" button (and back into an arrow).
  if (elements.btnInstructionsBack) elements.btnInstructionsBack.disabled = currentInstructionStep <= 1;
  if (elements.btnInstructionsNext) {
    const btn = elements.btnInstructionsNext;
    const toClose = currentInstructionStep === 5;
    btn.setAttribute('aria-label', toClose ? 'close' : 'next step');
    if (btn.classList.contains('is-close') !== toClose) {
      const from = btn.getBoundingClientRect().width;
      btn.classList.toggle('is-close', toClose);
      btn.style.width = '';
      const to = btn.getBoundingClientRect().width;
      if (!instructionsInstant && typeof btn.animate === 'function' && from && Math.abs(from - to) > 0.5) {
        btn.animate([{ width: `${from}px` }, { width: `${to}px` }], TAB_MOTION.slide);
      }
    }
  }
}

  // Realtime search filtering
  elements.searchUnfollowers.addEventListener('input', () => {
    state.selectedIndex = -1; // Reset keyboard selection on search query change
    updateResultsUI();
  });


  // Action buttons: Clear
  elements.clearFollowing.addEventListener('click', () => {
    const searchFollowingInput = document.getElementById('search-following');
    if (searchFollowingInput) searchFollowingInput.value = '';
    smoothClearTextarea(elements.inputFollowing, () => {
      state.following = [];
      storageSet(listStorageKey('following'), '[]');
      state.selectedIndex = -1; // Reset selection index
      updateListUI('following');
      calculateUnfollowers({ animate: true });
    });
  });

  elements.clearFollowers.addEventListener('click', () => {
    const searchFollowersInput = document.getElementById('search-followers');
    if (searchFollowersInput) searchFollowersInput.value = '';
    smoothClearTextarea(elements.inputFollowers, () => {
      state.followers = [];
      storageSet(listStorageKey('followers'), '[]');
      state.selectedIndex = -1; // Reset selection index
      updateListUI('followers');
      calculateUnfollowers({ animate: true });
    });
  });

  // Accordion toggles for source previews


  // Handle click on username, action arrow, star or delete button
  elements.listUnfollowers.addEventListener('click', (e) => {
    const userRow = e.target.closest('.user-row');
    if (!userRow) return;

    // A row already sliding out is on its way out — ignore further clicks.
    if (userRow.classList.contains('username-exit')) return;

    const username = userRow.getAttribute('data-username');
    const rowIndex = getLiveUnfollowerRows().indexOf(userRow);
    const userObj = state.unfollowers.find(u => u.username === username);
    if (!userObj) return;

    const actionArrow = e.target.closest('.action-arrow');
    if (actionArrow) {
      // Bypasses the unfollow/move logic entirely; let the browser naturally open the profileUrl anchor link.
      return;
    }

    // From the star icon rightwards is the buttons' area: a click there that
    // doesn't land exactly on a button (the gaps between/around them, the
    // row's right padding) does nothing, instead of counting as a click on
    // the row — which opened the profile on Instagram, easy to trigger by
    // just missing the star / delete / X button.
    const onButton = e.target.closest('.action-star, .action-delete, .action-dismiss');
    const starBtn = userRow.querySelector('.action-star');
    if (!onButton && starBtn && e.clientX >= starBtn.getBoundingClientRect().left) {
      return;
    }

    const actionStar = e.target.closest('.action-star');
    const currentAcc = (state.selectedAccountUsername || '_global_').toLowerCase();
    const taggedObj = { ...userObj, account: currentAcc };

    if (actionStar) {
      // Move user to Starred (favorite) list
      if (!state.starred.some(u => u.username === username)) {
        state.starred.unshift(taggedObj);
        saveCurrentAccountData();
      }

      exitListRow(userRow, () => {
        state.unfollowers = state.unfollowers.filter(u => u.username !== username);
        state.selectedIndex = -1;
        setCountBadge(elements.unfollowersCount, state.unfollowers.length, 'found');
        updateStarredUI(username);

        if (getLiveUnfollowerRows().length === 0) {
          updateResultsUI();
        } else {
          reindexUnfollowerRows();
        }
      });
      return;
    }

    const actionDismiss = e.target.closest('.action-dismiss');
    if (actionDismiss) {
      exitListRow(userRow, () => {
        state.unfollowers = state.unfollowers.filter(u => u.username !== username);
        state.selectedIndex = -1;
        setCountBadge(elements.unfollowersCount, state.unfollowers.length, 'found');

        if (getLiveUnfollowerRows().length === 0) {
          updateResultsUI();
        } else {
          reindexUnfollowerRows();
        }
      });
      return;
    }

    const actionDelete = e.target.closest('.action-delete');
    if (!actionStar && !actionDismiss && !actionDelete) {
      if (state.selectedIndex === rowIndex) {
        state.selectedIndex = -1;
        highlightRow(-1, { scroll: false });
      } else {
        state.selectedIndex = rowIndex;
        highlightRow(rowIndex, { scroll: false });
      }
    }

    // Clicking anywhere on the row (username, avatar, link, or delete button) automatically moves user to Unfollowed list!
    // Open Instagram link in new tab if the user clicked the row background or action arrow (not a direct link anchor or trash/delete button)
    const clickedLink = e.target.closest('a');
    const clickedDelete = e.target.closest('.action-delete');
    unfollowAndExitRow(userRow, { openProfile: !clickedLink && !clickedDelete });
  });

  // Toggle preview unfollowed list dropdown
  elements.togglePreviewUnfollowed.addEventListener('click', (e) => {
    // Empty list: nothing to open — a tap only closes its panel if open.
    if (elements.togglePreviewUnfollowed.classList.contains('is-empty') &&
        !elements.listUnfollowed.classList.contains('show')) return;
    e.stopPropagation();
    const isShown = elements.listUnfollowed.classList.toggle('show');
    elements.togglePreviewUnfollowed.classList.toggle('active', isShown);
    if (isShown) forceDropdownScrollRepaint(elements.listUnfollowed);

    // Close starred dropdown if open
    elements.listStarred.classList.remove('show');
    elements.togglePreviewStarred.classList.remove('active');

    // Close import files dropdown if open
    if (elements.addAccountDropdownMenu) elements.addAccountDropdownMenu.classList.remove('show');
    if (elements.btnAddAccount) elements.btnAddAccount.classList.remove('active');
  });

  // Toggle preview starred list dropdown
  elements.togglePreviewStarred.addEventListener('click', (e) => {
    if (elements.togglePreviewStarred.classList.contains('is-empty') &&
        !elements.listStarred.classList.contains('show')) return;
    e.stopPropagation();
    const isShown = elements.listStarred.classList.toggle('show');
    elements.togglePreviewStarred.classList.toggle('active', isShown);
    if (isShown) forceDropdownScrollRepaint(elements.listStarred);

    // Close unfollowed dropdown if open
    elements.listUnfollowed.classList.remove('show');
    elements.togglePreviewUnfollowed.classList.remove('active');

    // Close import files dropdown if open
    if (elements.addAccountDropdownMenu) elements.addAccountDropdownMenu.classList.remove('show');
    if (elements.btnAddAccount) elements.btnAddAccount.classList.remove('active');
  });

  // Close dropdowns on outside clicks
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#toggle-preview-unfollowed') && !e.target.closest('#list-unfollowed')) {
      elements.listUnfollowed.classList.remove('show');
      elements.togglePreviewUnfollowed.classList.remove('active');
    }
    if (!e.target.closest('#toggle-preview-starred') && !e.target.closest('#list-starred')) {
      elements.listStarred.classList.remove('show');
      elements.togglePreviewStarred.classList.remove('active');
    }
    if (!e.target.closest('#btn-add-account') && !e.target.closest('#add-account-dropdown-menu')) {
      if (elements.addAccountDropdownMenu) {
        elements.addAccountDropdownMenu.classList.remove('show');
      }
      if (elements.btnAddAccount) {
        elements.btnAddAccount.classList.remove('active');
      }
    }
  });

  // Handle click on unstar or remove inside starred list
  elements.listStarred.addEventListener('click', (e) => {
    e.stopPropagation();

    // Trash: move the username from starred to the unfollowed list (the ✕
    // just drops it from starred, putting it back in list 3). It's in
    // neither list 3 before nor after, so only the two submenus change.
    const unfollowBtn = e.target.closest('.unfollow-starred-btn');
    if (unfollowBtn) {
      const username = unfollowBtn.getAttribute('data-username');
      const userObj = state.starred.find(u => u.username === username);
      const itemEl = unfollowBtn.closest('.parsed-item');
      if (!itemEl) return;

      const menuEl = itemEl.closest('.dropdown-menu');
      const finalBoxHeight = (menuEl && isLastVisibleRow(itemEl))
        ? pinPanelHeight(menuEl)
        : null;

      exitListRow(itemEl, async () => {
        state.starred = state.starred.filter(u => u.username !== username);
        if (userObj && !state.unfollowed.some(u => u.username === username)) {
          const currentAcc = (state.selectedAccountUsername || '_global_').toLowerCase();
          state.unfollowed.unshift({ ...userObj, account: userObj.account || currentAcc });
        }
        saveCurrentAccountData();

        const headerBar = elements.listStarred.querySelector('.dropdown-header-bar');
        const resetStarredBtn = document.getElementById('settings-reset-starred-btn');
        if (state.starred.length === 0) {
          updateStarredUI();
        } else {
          if (headerBar) {
            headerBar.textContent = `${state.starred.length} ${state.starred.length === 1 ? 'starred account' : 'starred accounts'}`;
          }
          if (resetStarredBtn) resetStarredBtn.removeAttribute('disabled');
        }
        updateUnfollowedUI(username);
        await pushToCloud();
      }, { shrinkBox: menuEl, finalBoxHeight });
      return;
    }

    const unstarBtn = e.target.closest('.unstar-btn');
    const removeBtn = e.target.closest('.remove-unfollowed-btn');
    
    if (unstarBtn || removeBtn) {
      const targetBtn = unstarBtn || removeBtn;
      const username = targetBtn.getAttribute('data-username');
      const itemEl = targetBtn.closest('.parsed-item');
      if (!itemEl) return;

      const menuEl = itemEl.closest('.dropdown-menu');
      const finalBoxHeight = (menuEl && isLastVisibleRow(itemEl))
        ? pinPanelHeight(menuEl)
        : null;

      // The username goes back into list 3 right away — the same moment a
      // chip switch updates it — sliding in there while its row slides out
      // of this submenu, rather than only once that slide has finished.
      state.starred = state.starred.filter(u => u.username !== username);
      const followersSet = new Set(state.followers.map(user => user.username));
      const unfollowedSet = new Set(state.unfollowed.map(user => user.username));
      const starredSet = new Set(state.starred.map(user => user.username));
      state.unfollowers = state.following.filter(user => 
        !followersSet.has(user.username) && 
        !unfollowedSet.has(user.username) &&
        !starredSet.has(user.username)
      );
      updateResultsUI({ animate: true });
      saveCurrentAccountData();

      exitListRow(itemEl, async () => {
        const listEl = elements.listStarred;
        const headerBar = listEl.querySelector('.dropdown-header-bar');
        const resetStarredBtn = document.getElementById('settings-reset-starred-btn');

        if (state.starred.length === 0) {
          updateStarredUI();
        } else {
          if (headerBar) {
            headerBar.textContent = `${state.starred.length} ${state.starred.length === 1 ? 'starred account' : 'starred accounts'}`;
          }
          if (resetStarredBtn) {
            resetStarredBtn.removeAttribute('disabled');
          }
        }
        await pushToCloud();
      }, { shrinkBox: menuEl, finalBoxHeight });
    }
  });

  // Handle click on elements inside unfollowed list (remove or star)
  elements.listUnfollowed.addEventListener('click', (e) => {
    e.stopPropagation();

    const starBtn = e.target.closest('.star-unfollowed-btn');
    if (starBtn) {
      const username = starBtn.getAttribute('data-username');
      const userObj = state.unfollowed.find(u => u.username === username);
      const itemEl = starBtn.closest('.parsed-item');
      if (!itemEl) return;

      const menuEl = itemEl.closest('.dropdown-menu');
      const finalBoxHeight = (menuEl && isLastVisibleRow(itemEl))
        ? pinPanelHeight(menuEl)
        : null;

      exitListRow(itemEl, async () => {
        if (userObj) {
          state.unfollowed = state.unfollowed.filter(u => u.username !== username);
          if (!state.starred.some(u => u.username === username)) {
            state.starred.unshift(userObj);
          }

          const followersSet = new Set(state.followers.map(user => user.username));
          const unfollowedSet = new Set(state.unfollowed.map(user => user.username));
          const starredSet = new Set(state.starred.map(user => user.username));
          state.unfollowers = state.following.filter(user => 
            !followersSet.has(user.username) && 
            !unfollowedSet.has(user.username) &&
            !starredSet.has(user.username)
          );
          updateResultsUI();

          saveCurrentAccountData();

          const listEl = elements.listUnfollowed;
          const headerBar = listEl.querySelector('.dropdown-header-bar');
          const resetUnfollowedBtn = document.getElementById('settings-reset-unfollowed-btn');

          if (state.unfollowed.length === 0) {
            updateUnfollowedUI();
          } else {
            if (headerBar) {
              headerBar.textContent = `${state.unfollowed.length} ${state.unfollowed.length === 1 ? 'unfollowed account' : 'unfollowed accounts'}`;
            }
            if (resetUnfollowedBtn) {
              resetUnfollowedBtn.removeAttribute('disabled');
            }
          }

          updateStarredUI(username);
          await pushToCloud();
        }
      }, { shrinkBox: menuEl, finalBoxHeight });
      return;
    }

    const removeBtn = e.target.closest('.remove-unfollowed-btn');
    if (removeBtn) {
      const username = removeBtn.getAttribute('data-username');
      const itemEl = removeBtn.closest('.parsed-item');
      if (!itemEl) return;

      const menuEl = itemEl.closest('.dropdown-menu');
      const finalBoxHeight = (menuEl && isLastVisibleRow(itemEl))
        ? pinPanelHeight(menuEl)
        : null;

      // The username goes back into list 3 right away — the same moment a
      // chip switch updates it — sliding in there while its row slides out
      // of this submenu, rather than only once that slide has finished.
      state.unfollowed = state.unfollowed.filter(u => u.username !== username);

      const followersSet = new Set(state.followers.map(user => user.username));
      const unfollowedSet = new Set(state.unfollowed.map(user => user.username));
      const starredSet = new Set(state.starred.map(user => user.username));
      state.unfollowers = state.following.filter(user => 
        !followersSet.has(user.username) && 
        !unfollowedSet.has(user.username) &&
        !starredSet.has(user.username)
      );
      updateResultsUI({ animate: true });

      saveCurrentAccountData();

      exitListRow(itemEl, async () => {
        const listEl = elements.listUnfollowed;
        const headerBar = listEl.querySelector('.dropdown-header-bar');
        const resetUnfollowedBtn = document.getElementById('settings-reset-unfollowed-btn');

        if (state.unfollowed.length === 0) {
          updateUnfollowedUI();
        } else {
          if (headerBar) {
            headerBar.textContent = `${state.unfollowed.length} ${state.unfollowed.length === 1 ? 'unfollowed account' : 'unfollowed accounts'}`;
          }
          if (resetUnfollowedBtn) {
            resetUnfollowedBtn.removeAttribute('disabled');
          }
        }

        await pushToCloud();
      }, { shrinkBox: menuEl, finalBoxHeight });
    }
  });

  // Secret Romantic Easter Egg (shihab logo double click)
  const headerLogo = document.querySelector('.header-logo');
  const loveOverlay = document.getElementById('love-overlay');
  const loveCloseBtn = document.getElementById('love-close-btn');
  const loveHeartsContainer = document.querySelector('.love-hearts-container');
  let heartInterval = null;

  function spawnFloatHeart() {
    if (!loveHeartsContainer) return;
    const heart = document.createElement('div');
    heart.className = 'love-heart-float';
    heart.innerHTML = `
      <svg viewBox="0 0 24 24" width="${Math.random() * 16 + 10}" height="${Math.random() * 16 + 10}" fill="currentColor">
        <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"></path>
      </svg>
    `;
    heart.style.left = `${Math.random() * 100}%`;
    heart.style.animationDuration = `${Math.random() * 2 + 3}s`;
    loveHeartsContainer.appendChild(heart);

    setTimeout(() => {
      heart.remove();
    }, 5000);
  }

  function showLoveOverlay() {
    // Already open: don't start a second spawner — its interval handle
    // would be overwritten and never cleared, so hearts kept spawning
    // forever after closing.
    if (loveOverlay.classList.contains('show')) return;
    loveOverlay.classList.add('show');
    // Periodically spawn floating hearts
    heartInterval = setInterval(spawnFloatHeart, 300);
    // Spawn initial bunch of hearts immediately
    for (let i = 0; i < 8; i++) {
      setTimeout(spawnFloatHeart, i * 150);
    }
  }

  function hideLoveOverlay() {
    loveOverlay.classList.remove('show');
    if (heartInterval) {
      clearInterval(heartInterval);
      heartInterval = null;
    }
    setTimeout(() => {
      if (!loveOverlay.classList.contains('show')) {
        loveHeartsContainer.innerHTML = '';
      }
    }, 450);
  }

  let lastLogoTap = 0;
  let lastLogoTouch = 0;
  if (headerLogo && loveOverlay) {
    const detectDoubleTap = (e) => {
      const now = Date.now();
      // A touch fires touchstart and then a synthetic click for the same
      // tap — counted as two taps, a single tap opened the overlay on
      // phones. Ignore clicks that follow a touch.
      if (e.type === 'touchstart') {
        lastLogoTouch = now;
      } else if (now - lastLogoTouch < 800) {
        return;
      }
      const DOUBLE_PRESS_DELAY = 300; // ms
      if (now - lastLogoTap < DOUBLE_PRESS_DELAY) {
        e.preventDefault();
        showLoveOverlay();
        lastLogoTap = 0; // Reset
      } else {
        lastLogoTap = now;
      }
    };

    headerLogo.addEventListener('click', detectDoubleTap);
    headerLogo.addEventListener('touchstart', detectDoubleTap, { passive: false });
    
    loveCloseBtn.addEventListener('click', hideLoveOverlay);
    loveOverlay.addEventListener('click', (e) => {
      if (e.target === loveOverlay) {
        hideLoveOverlay();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !loveOverlay.classList.contains('hidden')) {
        hideLoveOverlay();
      }
    });
  }

  // Sync Folder Feature using File System Access API
  async function scanLocalDirectory() {
    if (typeof window.showDirectoryPicker !== 'function') {
      await showSiteAlert("warning", "your browser does not support folder selection. please use a modern desktop browser like chrome, edge, or opera.");
      return;
    }

    try {
      const dirHandle = await window.showDirectoryPicker();
      // Same import as the upload buttons (account detection, JSON and
      // HTML, every followers_N file, one file at a time). This used to
      // start clearing the lists without waiting, so a file read in the
      // meantime could be wiped, and read the files in parallel, so the
      // pending-requests file could overwrite the following list.
      const files = [];
      for await (const entry of dirHandle.values()) {
        if (entry.kind === 'file') files.push(await entry.getFile());
      }
      const importedAny = await processImportFiles(files, true);
      if (importedAny) await showSiteAlert("synced", "successfully synced files from your local folder!");
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error(err);
        await showSiteAlert("error", "couldn't read the folder: " + err.message);
      }
    }
  }

  // Bind double-click handler to Card 1 & Card 2 headers
  const cardHeaders = document.querySelectorAll('.card-header');
  cardHeaders.forEach(header => {
    const card = header.closest('.card');
    if (card && card.id !== 'card-unfollowers') {
      header.style.cursor = 'pointer';
      header.title = 'double-click the header to sync files from a folder automatically';
      header.addEventListener('dblclick', scanLocalDirectory);
    }
  });

  // Setup inputs
  elements.inputFollowing.addEventListener('input', handleFollowingInput);
  elements.inputFollowers.addEventListener('input', handleFollowersInput);

  // Bind double-click username helper on Following and Followers textareas
  const bindDblClickInstagram = (textareaEl) => {
    textareaEl.addEventListener('dblclick', (e) => {
      const text = textareaEl.value;
      const caretPos = textareaEl.selectionStart;
      
      // Find word boundaries around the caret position
      let start = caretPos;
      while (start > 0 && !/\s/.test(text[start - 1])) {
        start--;
      }
      let end = caretPos;
      while (end < text.length && !/\s/.test(text[end])) {
        end++;
      }
      
      let clickedWord = text.substring(start, end).trim();
      if (clickedWord.startsWith('@')) {
        clickedWord = clickedWord.substring(1);
      }
      
      // Trim surrounding punctuation only — '.' and '_' are valid inside
      // Instagram usernames (stripping them everywhere opened the wrong
      // profile for e.g. @danielle.lefleur), but a username can't end
      // with '.', so a trailing sentence period is still dropped.
      clickedWord = clickedWord.replace(/^[^a-zA-Z0-9._]+/, '').replace(/[^a-zA-Z0-9_]+$/, '');
      
      if (clickedWord && /^[a-zA-Z0-9._]+$/.test(clickedWord)) {
        openInstagramProfile(clickedWord, `https://instagram.com/${clickedWord}`);
      }
    });
  };
  
  bindDblClickInstagram(elements.inputFollowing);
  bindDblClickInstagram(elements.inputFollowers);

  // Global Escape key shortcut to close sub-menus, dropdowns, popups, modals, and button focus
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Esc') {
      const closed = closeAllSubMenusAndPopups();
      if (closed) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  });

  // Settings: Reset Unfollowed and Reset Starred Lists
  const settingsResetUnfollowedBtn = document.getElementById('settings-reset-unfollowed-btn');
  if (settingsResetUnfollowedBtn) {
    settingsResetUnfollowedBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (settingsResetUnfollowedBtn.disabled || state.unfollowed.length === 0) return;
      const currentAcc = state.selectedAccountUsername ? state.selectedAccountUsername.toLowerCase() : '';
      const listName = currentAcc ? `@${currentAcc}'s unfollowed list` : 'your global unfollowed list';
      const confirmed = await showSiteConfirm('reset list', `are you sure you want to reset ${listName}?`, 'reset', 'cancel');
      if (confirmed) {
        state.unfollowed = [];
        storageSet(listResetKey('unfollowed'), String(Date.now()));
        if (currentAcc) {
          storageSet(`unfollowed_users_${currentAcc}`, JSON.stringify([]));
          // Clean global shared list matching this account
          const globalList = JSON.parse(storageGet('unfollowed_users') || '[]');
          const filtered = globalList.filter(u => !u.account || u.account.toLowerCase() !== currentAcc);
          storageSet('unfollowed_users', JSON.stringify(filtered));
        } else {
          // Only the no-account entries (this used to wipe every account's).
          const globalList = JSON.parse(storageGet('unfollowed_users') || '[]');
          storageSet('unfollowed_users', JSON.stringify(globalList.filter(u => u.account && u.account !== '_global_')));
        }
        saveCurrentAccountData();
        calculateUnfollowers({ animate: true }); // usernames return to list 3 — slide them in
        updateUnfollowedUI();
        updateResetReminderUI();
        await pushToCloud();
      }
    });
  }

  const settingsResetStarredBtn = document.getElementById('settings-reset-starred-btn');
  if (settingsResetStarredBtn) {
    settingsResetStarredBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (settingsResetStarredBtn.disabled || state.starred.length === 0) return;
      const currentAcc = state.selectedAccountUsername ? state.selectedAccountUsername.toLowerCase() : '';
      const listName = currentAcc ? `@${currentAcc}'s starred list` : 'your global starred list';
      const confirmed = await showSiteConfirm('reset list', `are you sure you want to reset ${listName}?`, 'reset', 'cancel');
      if (confirmed) {
        state.starred = [];
        storageSet(listResetKey('starred'), String(Date.now()));
        if (currentAcc) {
          storageSet(`starred_users_${currentAcc}`, JSON.stringify([]));
          // Clean global shared list matching this account
          const globalList = JSON.parse(storageGet('starred_users') || '[]');
          const filtered = globalList.filter(u => !u.account || u.account.toLowerCase() !== currentAcc);
          storageSet('starred_users', JSON.stringify(filtered));
        } else {
          const globalList = JSON.parse(storageGet('starred_users') || '[]');
          storageSet('starred_users', JSON.stringify(globalList.filter(u => u.account && u.account !== '_global_')));
        }
        saveCurrentAccountData();
        calculateUnfollowers({ animate: true }); // usernames return to list 3 — slide them in
        updateStarredUI();
        updateResetReminderUI();
        await pushToCloud();
      }
    });
  }

  // Realtime search filtering for List 1 (Following)
  const searchFollowingInput = document.getElementById('search-following');
  if (searchFollowingInput) {
    searchFollowingInput.addEventListener('input', () => {
      const searchTerm = searchFollowingInput.value.trim().toLowerCase();
      if (!searchTerm) {
        elements.inputFollowing.placeholder = 'enter usernames';
        elements.inputFollowing.value = state.following.map(u => `@${u.originalUsername}`).join('\n');
      } else {
        const filtered = state.following.filter(u => 
          u.originalUsername.toLowerCase().includes(searchTerm) ||
          (u.fullName && u.fullName.toLowerCase().includes(searchTerm))
        );
        if (filtered.length === 0) {
          elements.inputFollowing.value = '';
          elements.inputFollowing.placeholder = state.following.length > 0 ? 'no matching usernames' : 'enter usernames';
        } else {
          elements.inputFollowing.placeholder = 'enter usernames';
          elements.inputFollowing.value = filtered.map(u => `@${u.originalUsername}`).join('\n');
        }
      }
    });
  }

  // Realtime search filtering for List 2 (Followers)
  const searchFollowersInput = document.getElementById('search-followers');
  if (searchFollowersInput) {
    searchFollowersInput.addEventListener('input', () => {
      const searchTerm = searchFollowersInput.value.trim().toLowerCase();
      if (!searchTerm) {
        elements.inputFollowers.placeholder = 'enter usernames';
        elements.inputFollowers.value = state.followers.map(u => `@${u.originalUsername}`).join('\n');
      } else {
        const filtered = state.followers.filter(u => 
          u.originalUsername.toLowerCase().includes(searchTerm) ||
          (u.fullName && u.fullName.toLowerCase().includes(searchTerm))
        );
        if (filtered.length === 0) {
          elements.inputFollowers.value = '';
          elements.inputFollowers.placeholder = state.followers.length > 0 ? 'no matching usernames' : 'enter usernames';
        } else {
          elements.inputFollowers.placeholder = 'enter usernames';
          elements.inputFollowers.value = filtered.map(u => `@${u.originalUsername}`).join('\n');
        }
      }
    });
  }

  // Restore full lists on textarea focus to prevent data loss when editing
  if (elements.inputFollowing) {
    elements.inputFollowing.addEventListener('focus', () => {
      if (searchFollowingInput && searchFollowingInput.value) {
        searchFollowingInput.value = '';
        elements.inputFollowing.placeholder = 'enter usernames';
        elements.inputFollowing.value = state.following.map(u => `@${u.originalUsername}`).join('\n');
      }
    });

    elements.inputFollowing.addEventListener('blur', () => {
      if (searchFollowingInput && searchFollowingInput.value.trim() !== '') {
        return;
      }
      const lines = elements.inputFollowing.value.split('\n');
      const formatted = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
      });
      elements.inputFollowing.value = formatted.filter(l => l !== '').join('\n');
      elements.inputFollowing.dispatchEvent(new Event('input'));
    });
  }

  if (elements.inputFollowers) {
    elements.inputFollowers.addEventListener('focus', () => {
      if (searchFollowersInput && searchFollowersInput.value) {
        searchFollowersInput.value = '';
        elements.inputFollowers.placeholder = 'enter usernames';
        elements.inputFollowers.value = state.followers.map(u => `@${u.originalUsername}`).join('\n');
      }
    });

    elements.inputFollowers.addEventListener('blur', () => {
      if (searchFollowersInput && searchFollowersInput.value.trim() !== '') {
        return;
      }
      const lines = elements.inputFollowers.value.split('\n');
      const formatted = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
      });
      elements.inputFollowers.value = formatted.filter(l => l !== '').join('\n');
      elements.inputFollowers.dispatchEvent(new Event('input'));
    });
  }

  // A row leaving list 3 via exitListRow is removed as a single surgical
  // DOM node (no full re-render), so every row after it keeps its old
  // data-index attribute instead of shifting down to match its new visual
  // position. The next click on one of those rows then reads that stale
  // index, and highlightRow ends up outlining the wrong row (or none at
  // all, if the stale index no longer exists). Call this right after
  // filtering a removed user out of state.unfollowers to keep data-index in
  // sync with what's actually still in the DOM.
  // Opens a list 3 username's profile (optionally) and moves it to the
  // unfollowed list, sliding its row out — shared by clicking a row and by
  // the keyboard shortcuts (1-9/0, Enter/o), which used to drop the row
  // instantly with no animation.
  function unfollowAndExitRow(userRow, { openProfile = true, keepSelection = false, fromAutoOpen = false } = {}) {
    if (!userRow || userRow.classList.contains('username-exit')) return;
    const username = userRow.getAttribute('data-username');
    const userObj = state.unfollowers.find(u => u.username === username);
    if (!userObj) return;

    const autoOpenToggle = document.getElementById('auto-open-toggle');
    if (!fromAutoOpen && autoOpenToggle && autoOpenToggle.checked) {
      state.pendingAutoOpen = true;
      state.autoOpenCount = 1;
    }

    if (openProfile) {
      openInstagramProfile(userObj.originalUsername || userObj.username, safeProfileUrl(userObj));
    }

    const currentAcc = (state.selectedAccountUsername || '_global_').toLowerCase();
    if (userObj.isPendingRequest) {
      state.following = state.following.filter(u => u.username !== username);
      elements.inputFollowing.value = state.following.map(u => `@${u.originalUsername}`).join('\n');
      updateListUI('following');
    } else if (!state.unfollowed.some(u => u.username === username)) {
      state.unfollowed.unshift({ ...userObj, account: currentAcc });
    }

    saveCurrentAccountData();

    exitListRow(userRow, () => {
      state.unfollowers = state.unfollowers.filter(u => u.username !== username);
      if (!keepSelection) state.selectedIndex = -1;
      setCountBadge(elements.unfollowersCount, state.unfollowers.length, 'found');
      updateUnfollowedUI(username);

      if (getLiveUnfollowerRows().length === 0) {
        updateResultsUI();
      } else {
        reindexUnfollowerRows();
      }
    });
  }

  // scrollIntoView is only needed when selection moves via keyboard (the
  // target row can be off-screen). A direct click already means the row is
  // visible — scrolling it "into view" there was a smooth (i.e. slow,
  // animated) scroll still in flight a moment after the click, so a fast
  // next tap could land on whatever row had scrolled underneath it in the
  // meantime instead of the one actually intended. Callers driven by a
  // click pass { scroll: false } to skip that.
  function highlightRow(index, { scroll = true } = {}) {
    const rows = getLiveUnfollowerRows();
    let selectedFound = false;
    rows.forEach((row, i) => {
      if (i === index) {
        row.classList.add('selected');
        if (scroll) {
          row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        const username = row.getAttribute('data-username');
        if (username) {
          state.selectedUsername = username;
          storageSet('selected_username', username);
          selectedFound = true;
        }
      } else {
        row.classList.remove('selected');
      }
    });

    if (!selectedFound || index === -1) {
      state.selectedUsername = null;
      storageSet('selected_username', '');
    }
  }

  // Handle tab focus for auto-opening the next user
  window.addEventListener('focus', async () => {
    const autoOpenToggle = document.getElementById('auto-open-toggle');
    if (autoOpenToggle && autoOpenToggle.checked && state.pendingAutoOpen) {
      state.pendingAutoOpen = false; // Reset to avoid double execution

      // Check if we've already automatically opened 5 profiles
      if (state.autoOpenCount >= 5) {
        const proceed = await showSiteConfirm('auto open', '5 profiles have been opened automatically. do you want to open the next 5?', 'continue', 'stop');
        if (!proceed) {
          autoOpenToggle.checked = false;
          state.pendingAutoOpen = false;
          state.autoOpenCount = 0;
          return;
        }
        state.autoOpenCount = 0; // Reset counter for the next batch
      }

      // Wait a tiny bit for the page focus layout to stabilise
      setTimeout(() => {
        // The first row actually showing (and not already sliding out) —
        // not state.unfollowers[0], which differs whenever a search filter
        // is active and would open one profile while removing another row.
        const firstRow = getLiveUnfollowerRows()[0];
        if (!firstRow) return;

        unfollowAndExitRow(firstRow, { fromAutoOpen: true });
        // Re-arm for the next return to this tab, and count towards the
        // batch-of-5 confirmation above.
        state.pendingAutoOpen = true;
        state.autoOpenCount++;
        pushToCloud();
      }, 100);
    }
  });

  // Enable toggling the switch via its text label click
  const autoOpenLabel = document.getElementById('auto-open-label');
  const autoOpenToggle = document.getElementById('auto-open-toggle');
  if (autoOpenLabel && autoOpenToggle) {
    autoOpenLabel.addEventListener('click', () => {
      autoOpenToggle.checked = !autoOpenToggle.checked;
      autoOpenToggle.dispatchEvent(new Event('change'));
    });
  }
}

// -------------------------------------------------------------
// Supabase Cloud Authentication & Data Sync (Option B)
// -------------------------------------------------------------
let currentUser = null;
// Set while the user's own "log out" is in progress — any other report of
// no session is treated as temporary (see handleAuthChange).
let userRequestedLogout = false;

// The sign-in Supabase keeps on the device (persistSession), if any.
function storedAuthSession() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !/^sb-.+-auth-token$/.test(key)) continue;
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      const session = value && (value.currentSession || value);
      if (session && session.refresh_token && session.user && session.user.id) return session;
    }
  } catch (e) { /* unreadable: treat as none */ }
  return null;
}

// Keeps retrying the token refresh (with backoff, and whenever the phone
// comes back online or the app is reopened) until it works — Supabase then
// reports the session again — or Supabase discards the sign-in for good
// (it then reports a sign-out, with nothing left on the device).
let sessionRetryActive = false;
function keepSessionThroughOutage() {
  if (sessionRetryActive || !supabaseClient) return;
  sessionRetryActive = true;
  let delay = 3000;
  let timer = null;
  const stop = () => {
    sessionRetryActive = false;
    clearTimeout(timer);
    window.removeEventListener('online', attempt);
    document.removeEventListener('visibilitychange', onVisible);
  };
  async function attempt() {
    clearTimeout(timer);
    if (!storedAuthSession() || userRequestedLogout) return stop();
    try {
      const { data } = await supabaseClient.auth.refreshSession();
      if (data && data.session) return stop();
    } catch (err) { /* network — try again */ }
    if (!storedAuthSession()) return stop();
    timer = setTimeout(attempt, delay);
    delay = Math.min(delay * 2, 60000);
  }
  const onVisible = () => { if (document.visibilityState === 'visible') attempt(); };
  window.addEventListener('online', attempt);
  document.addEventListener('visibilitychange', onVisible);
  timer = setTimeout(attempt, 1000);
}
let isSigningUp = false;
let isInitialAuthCheck = true;

// Username shown in the logged-out preview so visitors can see the checker
// working without being able to test it with their own account.
const GUEST_PREVIEW_USERNAME = 'shihcb';

// Lock List 1 (followers) & List 2 (following) to a fixed demo username
// while logged out, so guests can only preview the checker and must log in
// to test it with their own account. List 3 (the results card) is left
// fully interactive — same markup, same exitListRow/CSS animations as the
// logged-in app, nothing here special-cases it — so starring, deleting,
// dismissing, and the unfollowed/starred submenus all behave and animate
// identically whether or not the visitor is logged in.
function applyGuestPreviewLock(isLoggedIn) {
  if (!elements.inputFollowing || !elements.inputFollowers) return;

  elements.inputFollowing.readOnly = !isLoggedIn;
  elements.inputFollowers.readOnly = !isLoggedIn;
  if (elements.clearFollowing) elements.clearFollowing.disabled = !isLoggedIn;
  if (elements.clearFollowers) elements.clearFollowers.disabled = !isLoggedIn;
  if (elements.btnAddAccount) elements.btnAddAccount.disabled = !isLoggedIn;

  if (isLoggedIn) {
    // Always drop the guest demo on login — not only when this device has
    // saved accounts to replace it with. A brand-new user has none, so the
    // demo @account (its chip, selected, and @username in list 2 / list 3)
    // used to carry over into their real session and get saved to their
    // cloud data. Their real accounts/lists load right after from the cloud.
    let accounts = [];
    try {
      // (Old saves stored plain strings — normalize them.) The guest demo's
      // chip only ever lives in memory, never in saved accounts, so a saved
      // @shihcb is a real one (e.g. from "try a demo") and stays.
      accounts = JSON.parse(storageGet('instagram_accounts') || '[]')
        .map(acc => typeof acc === 'string' ? { username: acc, originalUsername: acc } : acc)
        .filter(acc => acc && acc.originalUsername);
    } catch (e) {}
    state.instagramAccounts = accounts;
    const demoSelected = state.selectedAccountUsername
      && state.selectedAccountUsername.toLowerCase() === GUEST_PREVIEW_USERNAME.toLowerCase();
    if (demoSelected) {
      state.selectedAccountUsername = null;
      state.following = [];
      state.followers = [];
      elements.inputFollowing.value = '';
      elements.inputFollowers.value = '';
      updateListUI('following');
      updateListUI('followers');
      calculateUnfollowers();
    }
    renderAccountChips(false);
    return;
  }

  state.instagramAccounts = [{ username: GUEST_PREVIEW_USERNAME, originalUsername: GUEST_PREVIEW_USERNAME }];
  state.selectedAccountUsername = GUEST_PREVIEW_USERNAME;
  elements.inputFollowing.value = `@${GUEST_PREVIEW_USERNAME}`;
  elements.inputFollowers.value = '';
  state.following = deduplicateEntries(parseInput(elements.inputFollowing.value));
  state.followers = [];
  updateListUI('following');
  updateListUI('followers');
  calculateUnfollowers();
  renderAccountChips(false);

  // Hide the clear button entirely while logged out (updateListUI shows it
  // whenever the textarea has content, which the demo username always does)
  const actionsFollowing = document.getElementById('actions-following');
  const actionsFollowers = document.getElementById('actions-followers');
  if (actionsFollowing) actionsFollowing.classList.remove('show');
  if (actionsFollowers) actionsFollowers.classList.remove('show');
}

// The app coming in right after logging in, built from animations it
// already uses so it feels like the same app: the header title/badge fade
// in (style.css, .login-entering), the grid rises into place
// with the logout's motion in reverse (minus its blur, which is costly on
// phones for a layer this big), the account chips
// get the fade a newly added chip gets, and list 3's usernames slide in
// with list 3's own slide (the one switching accounts uses).
function playAppEntrance() {
  const ease = 'cubic-bezier(0.16, 1, 0.3, 1)';
  const grid = elements.appGrid;
  document.body.classList.add('login-entering');
  setTimeout(() => document.body.classList.remove('login-entering'), 700);
  if (grid && typeof grid.animate === 'function') {
    grid.animate([
      { opacity: 0, transform: 'translateY(16px) scale(0.97)' },
      { opacity: 1, transform: 'none' }
    ], { duration: 600, easing: ease });
  }
  if (elements.accountChipsList) {
    elements.accountChipsList.querySelectorAll('.account-chip').forEach(chip => {
      chip.classList.remove('fade-in');
      void chip.offsetWidth; // restart the animation if it already ran
      chip.classList.add('fade-in');
    });
  }
  if (elements.listUnfollowers && !elements.listUnfollowers.classList.contains('hidden')) {
    animateResultsReentry(elements.listUnfollowers, new Map(), new Map(), { enter: true });
  }
}

// Logging out: playAppEntrance in reverse, over the same time the login
// page takes to fade out when logging in.
const APP_EXIT_MS = 450;
let appExitAnimations = [];
function playAppExit() {
  const grid = elements.appGrid;
  const easing = 'cubic-bezier(0.4, 0, 0.2, 1)';
  document.body.classList.add('logout-leaving');
  if (grid && typeof grid.animate === 'function') {
    appExitAnimations.push(grid.animate([
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'translateY(16px) scale(0.97)' }
    ], { duration: APP_EXIT_MS, easing, fill: 'forwards' }));
  }
  // The profile menu (where "log out" was tapped) fades out quickly ahead
  // of the app instead of closing at its own slower pace on top of it — it's
  // see-through, and the two half-faded layers' text showed through each
  // other.
  const menu = elements.authDropdown;
  if (menu && menu.classList.contains('show') && typeof menu.animate === 'function') {
    appExitAnimations.push(menu.animate([{ opacity: 1 }, { opacity: 0 }],
      { duration: 250, easing, fill: 'forwards' }));
  } else if (menu) {
    menu.classList.remove('show');
  }
}
// Drops the exit's end state (hidden grid, hidden header) — once the
// login page is up, or if signing out failed. `headerDelay`: keep the
// app's header title/profile button hidden until the login page has faded
// back in over them, so the two headers never show on top of each other.
function cancelAppExit(headerDelay = 0) {
  clearTimeout(cancelAppExit.timer);
  const showHeader = () => document.body.classList.remove('logout-leaving');
  if (headerDelay > 0) cancelAppExit.timer = setTimeout(showHeader, headerDelay);
  else showHeader();
  appExitAnimations.forEach(animation => animation.cancel());
  appExitAnimations = [];
}

// Physically relocate the live app grid so it isn't trapped inside
// #landing-page-container (which is display:none once logged in).
function relocateAppGridForAuthState(isLoggedIn) {
  const appGrid = document.querySelector('.app-grid');
  const appContainer = document.querySelector('.app-container');
  const landingHome = document.getElementById('app-grid-landing-home');
  if (!appGrid) return;

  if (isLoggedIn) {
    if (appContainer && appGrid.parentElement !== appContainer) {
      appContainer.appendChild(appGrid);
    }
  } else {
    if (landingHome && appGrid.parentElement !== landingHome) {
      landingHome.appendChild(appGrid);
    }
  }
  fitGuestPreviewGrid();
}

// The guest preview is the logged-in app's own grid, so to look identical
// it has to be laid out at the logged-in app's own size — the landing
// section is narrower (and, on desktop, has no viewport-height app shell
// for the cards' height:100% to fill), which used to squeeze the preview
// into abbreviated button labels, truncated usernames and a shorter card.
// Size it exactly as .app-container would (content width; on desktop, the
// height left after the header), then scale the whole grid down to fit.
// transform: scale() rather than CSS zoom: a transform never touches
// layout, so #card-unfollowers' @container label queries, flex sizing and
// text measurement all see the real app-sized card in every browser
// (Safari evaluates container queries against the zoomed size, which
// brought back "unflwd" and the shrink-wrapped buttons). A transform
// doesn't shrink the grid's layout box, so the landing wrapper is given
// the scaled height explicitly instead.
function fitGuestPreviewGrid() {
  const appGrid = document.querySelector('.app-grid');
  const appContainer = document.querySelector('.app-container');
  const landingHome = document.getElementById('app-grid-landing-home');
  if (!appGrid || !appContainer || !landingHome) return;

  if (appGrid.parentElement !== landingHome) {
    appGrid.style.width = '';
    appGrid.style.height = '';
    appGrid.style.transform = '';
    appGrid.style.transformOrigin = '';
    landingHome.style.height = '';
    return;
  }

  const cs = getComputedStyle(appContainer);
  const width = appContainer.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const available = landingHome.clientWidth;
  if (!(width > 0) || !(available > 0)) return;

  // Desktop (min-width:1025px) stretches the grid to fill the fixed-height
  // app shell below the header; narrower layouts size each card on its own.
  let height = null;
  if (window.matchMedia('(min-width: 1025px)').matches) {
    const gap = parseFloat(cs.rowGap) || 0;
    const siblingsHeight = Array.from(appContainer.children)
      .filter(el => el !== appGrid && getComputedStyle(el).display !== 'none')
      .reduce((sum, el) => sum + el.offsetHeight + gap, 0);
    height = appContainer.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - siblingsHeight;
  }

  const scale = Math.min(1, available / width);
  appGrid.style.width = `${width}px`;
  appGrid.style.height = height > 0 ? `${height}px` : '';
  appGrid.style.transformOrigin = 'top left';
  appGrid.style.transform = scale < 1 ? `scale(${scale})` : '';
  landingHome.style.height = `${appGrid.offsetHeight * scale}px`;
}

window.addEventListener('resize', () => requestAnimationFrame(fitGuestPreviewGrid));

// Refit whenever the landing section or the app shell changes size — this
// also covers the landing page first becoming visible (0 width → real
// width), fonts loading, and the grid's own height changing, none of
// which fire a window resize.
if (typeof ResizeObserver !== 'undefined') {
  const guestPreviewObserver = new ResizeObserver(() => requestAnimationFrame(fitGuestPreviewGrid));
  ['app-grid-landing-home'].forEach(id => {
    const el = document.getElementById(id);
    if (el) guestPreviewObserver.observe(el);
  });
  document.querySelectorAll('.app-container, .app-grid').forEach(el => guestPreviewObserver.observe(el));
}

function initAuth() {
  // Show the locked guest preview immediately, before the async session
  // check resolves, so visitors never see blank/editable lists flash by.
  applyGuestPreviewLock(false);

  if (!supabaseClient) {
    // Show configuration warning if URL/Anon key are empty
    if (elements.authConfigWarning) elements.authConfigWarning.classList.remove('hidden');
    document.body.classList.add('auth-logged-out');
    if (elements.authDropdown) elements.authDropdown.classList.add('show');
    relocateAppGridForAuthState(false);
    return;
  }

  // Subscribe to auth state updates
  // Handled outside Supabase's callback, one event at a time: the callback
  // can run while Supabase holds its auth lock, and cloud calls made from
  // inside it (downloading the user's data) wait for that same lock —
  // Supabase's docs warn this can deadlock, stalling token refreshes.
  let authQueue = Promise.resolve();
  supabaseClient.auth.onAuthStateChange((event, session) => {
    setTimeout(() => {
      authQueue = authQueue.then(() => handleAuthChange(event, session));
    }, 0);
  });

  async function handleAuthChange(event, session) {
    try {
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
      const isSameUser = session && currentUser && session.user.id === currentUser.id;

      if (session) {
        currentUser = session.user;
        elements.userBadge.classList.remove('hidden');
        elements.authUserEmail.textContent = currentUser.email;

        const importAccountWarning = document.getElementById('import-account-warning');
        if (importAccountWarning) importAccountWarning.classList.add('hidden-warning');
        
        const showProfileView = () => {
          elements.authProfileView.classList.remove('hidden');
          elements.authFormView.classList.add('hidden');
        };

        if (isInitialAuthCheck) {
          showProfileView();
        }

        // Avoid list and layout flickering on focus/token refresh by skipping re-renders for the same user
        if (isSameUser && !isInitialAuthCheck) {
          // A token refresh after a failed start (see keepSessionThroughOutage):
          // finish loading the cloud data / upload what was saved meanwhile.
          if (!cloudReady && pendingCloudRetry) pendingCloudRetry();
          else if (cloudReady && storageGet(CLOUD_DIRTY_KEY) === currentUser.id) pushToCloud();
          return;
        }

        // No uploads until this user's cloud data is loaded (see cloudReady).
        cloudReady = false;
        clearTimeout(cloudPushTimer);
        cloudPushTimer = null;
        cloudPushWaiters.splice(0).forEach(resolve => resolve());

        // Unlock List 1 & 2 from the guest demo now that a real account is active
        applyGuestPreviewLock(true);

        // Another user's data left on this device (e.g. their upload failed
        // at logout, so it was kept): never show or upload it as this user's.
        // Only data this device already held for this same user (a reload
        // while logged in, or kept after an offline logout) may be uploaded
        // before the download.
        const owner = storageGet(LOCAL_DATA_OWNER_KEY);
        const localIsThisUsers = owner === currentUser.id;
        if (owner && owner !== currentUser.id) clearLocalAccountData();
        storageSet(LOCAL_DATA_OWNER_KEY, currentUser.id);

        // Fetch cloud data and merge/sync. pullFromCloud loads the selected
        // account's lists itself. (A shared 'following_users' copy used to
        // be loaded over them here — another account's list.) If the cloud
        // can't be reached (offline), carry on with this device's copy —
        // this used to abort the login, leaving the landing page up.
        try {
          await pullFromCloud(localIsThisUsers);
          cloudReady = true;
        } catch (err) {
          console.error('Error loading cloud data:', err);
          // The account last chosen on this device ('' = none on purpose).
          const lastRaw = storageGet('last_active_instagram_account');
          const acc = (lastRaw !== null ? lastRaw : storageGet('selected_instagram_account')) || null;
          const exists = acc && state.instagramAccounts.some(a => a.originalUsername.toLowerCase() === acc.toLowerCase());
          try { loadAccountData(exists ? acc : null); } catch (loadErr) { console.error('Error loading account data:', loadErr); }
          if (localIsThisUsers) {
            // This device's copy is this user's latest: keep saving it.
            cloudReady = true;
          } else {
            // Nothing of this user's here — uploading now would replace
            // their saved data with an empty copy. Load it once back online.
            retryCloudLoadWhenOnline();
          }
        }

        // Always render chips instantly under the login screen before it fades out.
        // Nothing here may stop the app from being revealed below: a failure
        // used to leave the page blank (logged-in header, nothing under it).
        try { renderAccountChips(false); } catch (chipErr) { console.error('Error rendering account chips:', chipErr); }

        // Smoothly fade out login page if there are accounts, otherwise hide instantly
        const finalizeLogin = () => {
          if (!isInitialAuthCheck) {
            // 1. The whole login page fades out while the card sinks away
            //    (.login-leaving, style.css). This used to blur only the
            //    card, then cut straight to the app at 750ms.
            document.body.classList.add('login-leaving');
            if (elements.authFormView) {
              elements.authFormView.classList.add('smooth-exit');
            }
            // 2. Once it's gone, switch to the app and bring it in.
            setTimeout(() => {
              document.documentElement.classList.add('is-logged-in');
              document.body.classList.remove('auth-logged-out');
              document.body.classList.remove('login-leaving');
              relocateAppGridForAuthState(true);
              if (elements.authDropdown) {
                elements.authDropdown.classList.remove('show');
              }
              if (elements.authFormView) {
                elements.authFormView.classList.remove('smooth-exit');
              }
              showProfileView();
              playAppEntrance();
            }, 450);
          } else {
            document.documentElement.classList.add('is-logged-in');
            document.body.classList.remove('auth-logged-out');
            relocateAppGridForAuthState(true);
            if (elements.authDropdown) {
              elements.authDropdown.classList.remove('show');
            }
            showProfileView();
          }
        };

        // (List 3 used to get its own opacity fade-in here, but that ran
        // while the list was still hidden inside the login page, so it was
        // never seen — playAppEntrance brings its rows in instead.)
        finalizeLogin();
      } else {
        // No session reported, but the user didn't log out and their saved
        // sign-in is still on the device: Supabase couldn't refresh it just
        // now (offline, or the phone just woke up), and says so this way at
        // startup. That used to log the user out — and clear their data on
        // the device. Stay logged in with it and keep retrying; only a
        // sign-in Supabase itself has discarded (really expired or revoked)
        // ends the session.
        const stored = userRequestedLogout ? null : storedAuthSession();
        if (stored) {
          keepSessionThroughOutage();
          if (!currentUser) await handleAuthChange(event, stored);
          return;
        }
        userRequestedLogout = false;
        currentUser = null;
        cloudReady = false;
        document.documentElement.classList.remove('is-logged-in');
        document.body.classList.add('auth-logged-out');
        relocateAppGridForAuthState(false);
        elements.authDropdown.classList.add('show');
        elements.userBadge.classList.add('hidden');

        const importAccountWarning = document.getElementById('import-account-warning');
        if (importAccountWarning) importAccountWarning.classList.remove('hidden-warning');
        
        // Update UI panels in modal
        elements.authProfileView.classList.add('hidden');
        elements.authFormView.classList.remove('hidden');

        const clearData = () => {
          // Clear all loaded information, Instagram accounts, and input textareas
          state.following = [];
          state.followers = [];
          state.unfollowers = [];
          state.unfollowed = [];
          state.starred = [];
          state.instagramAccounts = [];
          state.selectedAccountUsername = null;
          state.selectedIndex = -1;
          
          // Unless the last upload never made it (offline at logout): then
          // keep it for that user's next login here, which uploads it first
          // (see pullFromCloud). Anyone else logging in clears it first.
          if (!storageGet(CLOUD_DIRTY_KEY)) clearLocalAccountData();

          elements.inputFollowing.value = '';
          elements.inputFollowers.value = '';
          elements.searchUnfollowers.value = '';
          
          updateListUI('following');
          updateListUI('followers');
          calculateUnfollowers();
          renderAccountChips(false);
        };

        if (!isInitialAuthCheck) {
          // The app has already faded out (playAppExit). Swap in the guest
          // demo right away — the preview used to show the user's own
          // chips and usernames on the login page for a moment, then
          // swap — and fade the login page in (the reverse of the login's
          // fade-out); its card rises in with its usual entrance.
          clearData();
          applyGuestPreviewLock(false);
          cancelAppExit(500);
          if (elements.authPassword) elements.authPassword.value = '';
          // The login's fade-out played backwards: same length, same even
          // ease. (This used the login page's own opacity transition, whose
          // very fast ease-out is ~80% done in the first tenth of a second —
          // it read as the page snapping back in.) Animated on the page's
          // content: the overlay itself has a forced opacity that would
          // override an animation.
          const landing = document.getElementById('landing-page-container');
          if (landing && typeof landing.animate === 'function') {
            landing.animate([{ opacity: 0 }, { opacity: 1 }],
              { duration: 500, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' });
          }
        } else {
          clearData();
          applyGuestPreviewLock(false);
        }
      }
    } catch (err) {
      console.error('Error in onAuthStateChange handler:', err);
    } finally {
      isInitialAuthCheck = false;
    }
  }

  // Wire up auth layout UI tab triggers with a smooth cross-fade transition
  // The tab a click asked for most recently — isSigningUp itself only
  // flips once the form has slid out, so comparing against it let a quick second click
  // (sign up, then straight back to log in) get ignored and leave the
  // wrong tab showing.
  let requestedSigningUp = null;

  // The auth card's natural height with the given tab's content in it
  // (forgot-password link only on log in, alerts cleared as the switch
  // does), measured by applying that state for a moment and undoing it.
  function measureAuthCardHeightFor(signup) {
    const card = elements.authFormView;
    const forgot = elements.btnForgotPassword;
    const alerts = [elements.authErrorMsg, elements.authSuccessMsg].filter(Boolean);
    const saved = {
      forgotHidden: forgot ? forgot.classList.contains('hidden') : null,
      text: elements.authSubmitBtn.textContent,
      alertsHidden: alerts.map(el => el.classList.contains('hidden')),
      height: card.style.height,
    };
    if (forgot) forgot.classList.toggle('hidden', signup);
    elements.authSubmitBtn.textContent = signup ? 'sign up' : 'log in';
    alerts.forEach(el => el.classList.add('hidden'));
    card.style.height = 'auto';
    const height = card.offsetHeight;
    if (forgot) forgot.classList.toggle('hidden', saved.forgotHidden);
    elements.authSubmitBtn.textContent = saved.text;
    alerts.forEach((el, i) => el.classList.toggle('hidden', saved.alertsHidden[i]));
    card.style.height = saved.height;
    return height;
  }

  // Slides the auth card from one height to another, then hands it back to
  // its natural (auto) height. A newer resize takes over from an older one.
  function resizeAuthCard(fromHeight, toHeight, transition = 'height 0.55s cubic-bezier(0.65, 0, 0.35, 1)') {
    const card = elements.authFormView;
    const token = (card._resizeToken = {});
    const unlock = () => {
      if (card._resizeToken !== token) return; // a newer switch owns it now
      card.style.height = '';
      card.style.overflow = '';
      card.style.transition = '';
    };
    // Same height: nothing to animate, and no transitionend would ever fire
    // — which once left the card pinned with overflow hidden, clipping
    // anything that appeared later (e.g. an error message).
    if (Math.abs(toHeight - fromHeight) < 0.5) {
      unlock();
      return;
    }
    card.style.transition = 'none';
    card.style.height = fromHeight + 'px';
    card.style.overflow = 'hidden';
    void card.offsetHeight; // commit the start height before animating from it
    card.style.transition = transition;
    card.style.height = toHeight + 'px';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      card.removeEventListener('transitionend', onCardResized);
      unlock();
    };
    function onCardResized(e) {
      if (e.target === card && e.propertyName === 'height') finish();
    }
    card.addEventListener('transitionend', onCardResized);
    setTimeout(finish, 650); // in case the transition gets interrupted
  }

  function switchTab(signup) {
    const current = requestedSigningUp === null ? isSigningUp : requestedSigningUp;
    if (current === signup) return;
    requestedSigningUp = signup;

    // The card slides to its new height rather than snapping (the log-in
    // form is taller — it has the forgot-password link). Work out that
    // height now, by briefly applying the new tab's differences and
    // measuring: when the card has to GROW it starts right away, while the
    // old form slides out, so the taller form never appears inside a card
    // still too short for it (its bottom — the log-in button — used to be
    // cut off until the card caught up). When it SHRINKS it waits for the
    // swap, so the outgoing, taller form isn't cut off either.
    const card = elements.authFormView;
    let fromHeight = null;
    let endHeight = null;
    if (card) {
      fromHeight = card.offsetHeight; // mid-resize if a previous switch is still animating
      endHeight = measureAuthCardHeightFor(signup);
      // Only the card resizes: its container keeps the taller tab's height,
      // so the page below doesn't slide up and down with it (it used to).
      const holder = card.parentElement;
      if (holder) {
        const tallest = Math.max(endHeight, measureAuthCardHeightFor(!signup));
        holder.style.minHeight = `${tallest}px`;
      }
      card.style.transition = 'none';
      card.style.height = fromHeight + 'px';
      card.style.overflow = 'hidden';
      // Growing uses the site's fast-start ease-out, so the card is ~90% of
      // the way there by the time the taller form starts fading in (0.26s).
      if (endHeight > fromHeight + 0.5) {
        resizeAuthCard(fromHeight, endHeight, 'height 0.5s cubic-bezier(0.16, 1, 0.3, 1)');
      }
    }

    // The tab switcher's pill and the tab labels move right away — the pill
    // glides across (see .auth-tab-indicator in style.css).
    elements.tabLogin.classList.toggle('active', !signup);
    elements.tabSignup.classList.toggle('active', signup);
    const tabsBar = elements.tabLogin.parentElement;
    if (tabsBar) tabsBar.classList.toggle('signup-active', signup);

    // The form slides out towards the side the pill is leaving from, and
    // the other form slides in from the opposite side — a slow sideways
    // slide in the same direction as the pill, with the site's easing.
    const form = elements.authForm;
    const SLIDE = 28;
    const outX = signup ? -SLIDE : SLIDE;
    form.style.transition = 'opacity 0.26s cubic-bezier(0.4, 0, 0.2, 1), transform 0.26s cubic-bezier(0.4, 0, 0.2, 1)';
    form.style.opacity = '0';
    form.style.transform = `translateX(${outX}px)`;

    setTimeout(() => {
      // A later click already asked for the other tab — let it win.
      if (requestedSigningUp !== signup) return;
      requestedSigningUp = null;
      isSigningUp = signup;
      if (signup) {
        elements.authSubmitBtn.textContent = 'sign up';
        if (elements.btnForgotPassword) elements.btnForgotPassword.classList.add('hidden');
      } else {
        elements.authSubmitBtn.textContent = 'log in';
        if (elements.btnForgotPassword) elements.btnForgotPassword.classList.remove('hidden');
      }
      clearAuthAlerts();

      // Slide the new form in from the other side.
      form.style.transition = 'none';
      form.style.transform = `translateX(${-outX}px)`;
      void form.offsetWidth; // commit the start position before sliding from it
      // The tab switchers' motion (TAB_MOTION): 600ms slide, softer fade.
      form.style.transition = 'opacity 0.56s cubic-bezier(0.4, 0, 0.2, 1), transform 0.6s cubic-bezier(0.16, 1, 0.3, 1)';
      form.style.opacity = '1';
      form.style.transform = 'translateX(0)';
      setTimeout(() => {
        if (requestedSigningUp === null) {
          form.style.transition = '';
          form.style.transform = '';
          form.style.opacity = '';
        }
      }, 620);

      // Shrinking (or unchanged): resize now that the smaller form is in.
      if (card && endHeight !== null && endHeight <= fromHeight + 0.5) {
        resizeAuthCard(card.offsetHeight, endHeight);
      }
    }, 260);
  }

  // Heights change with the width, so re-measure on the next switch.
  window.addEventListener('resize', () => {
    const holder = elements.authFormView && elements.authFormView.parentElement;
    if (holder) holder.style.minHeight = '';
  });

  elements.tabLogin.addEventListener('click', (e) => {
    e.preventDefault();
    switchTab(false);
  });
  elements.tabSignup.addEventListener('click', (e) => {
    e.preventDefault();
    switchTab(true);
  });

  const landingCtaBtn = document.getElementById('landing-cta-btn');
  if (landingCtaBtn) {
    landingCtaBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const authFormCard = document.getElementById('auth-form-card');
      if (authFormCard) {
        authFormCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      if (elements.authEmail) {
        elements.authEmail.focus({ preventScroll: true });
      }
    });
  }

  // Toggle drop down menu on button click
  elements.authBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!currentUser) return; // Disable drop down toggle if logged out (always full-screen)
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    // Opening: drawn once (still invisible) before it fades in, like the
    // pop-ups, so a first open can't eat the start of the animation.
    const dd = elements.authDropdown;
    if (dd.classList.contains('show') || dd._opening) {
      dd._opening = null;
      dd.classList.remove('show');
    } else {
      updateResetReminderUI();
      const token = (dd._opening = {});
      dd.style.visibility = 'visible';
      void dd.offsetWidth;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        dd.style.visibility = '';
        if (dd._opening === token) { dd._opening = null; dd.classList.add('show'); }
      }));
    }
  });

  // Close drop down on clicking outside
  document.addEventListener('click', (e) => {
    if (currentUser && elements.authDropdown.classList.contains('show')) {
      if (!e.target.closest('#auth-dropdown') && !e.target.closest('#auth-btn')) {
        elements.authDropdown.classList.remove('show');
        clearAuthAlerts();
      }
    }
  });

  // Handle Form Submission (Sign In or Sign Up)
  elements.authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthAlerts();
    
    const email = elements.authEmail.value.trim();
    const password = elements.authPassword.value;
    
    elements.authSubmitBtn.setAttribute('disabled', 'true');
    elements.authSubmitBtn.textContent = isSigningUp ? 'signing up...' : 'logging in...';

    if (isSigningUp) {
      // Supabase Sign Up
      const { data, error } = await supabaseClient.auth.signUp({ email, password });
      
      if (error) {
        showAuthError(error.message);
      } else {
        showAuthSuccess('account created! check your email to confirm it, or try logging in.');
      }
    } else {
      // Supabase Log In
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      
      if (error) {
        showAuthError(error.message);
      } else {
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
          document.activeElement.blur();
        }
        setTimeout(() => {
          elements.authDropdown.classList.remove('show');
          clearAuthAlerts();
        }, 1200);
      }
    }

    elements.authSubmitBtn.removeAttribute('disabled');
    elements.authSubmitBtn.textContent = isSigningUp ? 'sign up' : 'log in';
  });

  // Handle "forgot password?" click
  if (elements.btnForgotPassword) {
    elements.btnForgotPassword.addEventListener('click', async () => {
      clearAuthAlerts();

      const email = elements.authEmail.value.trim();
      if (!email) {
        showAuthError('enter your email address first');
        return;
      }

      elements.btnForgotPassword.setAttribute('disabled', 'true');
      const { error } = await supabaseClient.auth.resetPasswordForEmail(email);
      elements.btnForgotPassword.removeAttribute('disabled');

      if (error) {
        showAuthError(error.message);
      } else {
        showAuthSuccess('check your email for a password reset link');
      }
    });
  }

  // Handle Log Out with smooth slow fade-out of the main app grid
  elements.btnLogout.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    
    // The login transition in reverse (see playAppEntrance): the app sinks
    // and fades out, and the header title/profile button fade with it;
    // then the login page fades in (the SIGNED_OUT branch of
    // onAuthStateChange). This used to blur the app away while the header
    // stayed, then cut to the login page.
    playAppExit();
    // Upload any batched changes while still signed in — alongside the
    // animation rather than after it.
    const upload = flushCloudPush().catch(err => console.error('Error syncing before sign out:', err));

    setTimeout(async () => {
      await upload;
      if (supabaseClient) {
        try {
          userRequestedLogout = true;
          // Only this device: the default ('global') also signed the user
          // out everywhere else they were logged in.
          await supabaseClient.auth.signOut({ scope: 'local' });
        } catch (err) {
          console.error('Error signing out:', err);
          userRequestedLogout = false;
          cancelAppExit(); // still signed in: bring the app back
          if (elements.authDropdown) elements.authDropdown.classList.remove('show');
        }
      }
    }, APP_EXIT_MS);
  });

  // Handle Import Files Selection
  if (elements.importFilesInput) {
    elements.importFilesInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files);
      const isFolder = files.some(f => f.webkitRelativePath && f.webkitRelativePath.includes('/'));
      const importedAny = await processImportFiles(files, isFolder);

      if (importedAny) {
        // Close dropdown after successful import
        if (elements.addAccountDropdownMenu) {
          elements.addAccountDropdownMenu.classList.remove('show');
        }
        if (elements.btnAddAccount) {
          elements.btnAddAccount.classList.remove('active');
        }
        elements.authDropdown.classList.remove('show');
        clearAuthAlerts();
      }

      // Reset input value
      elements.importFilesInput.value = '';
    });
  }

  // Handle Import Folder Selection
  if (elements.importFolderInput) {
    elements.importFolderInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files);
      const importedAny = await processImportFiles(files, true);

      if (importedAny) {
        // Close dropdown after successful import
        if (elements.addAccountDropdownMenu) {
          elements.addAccountDropdownMenu.classList.remove('show');
        }
        if (elements.btnAddAccount) {
          elements.btnAddAccount.classList.remove('active');
        }
        elements.authDropdown.classList.remove('show');
        clearAuthAlerts();
      }

      // Reset input value
      elements.importFolderInput.value = '';
    });
  }

  // Helper to recursively traverse entries and extract files
  async function getFilesFromEntry(entry) {
    let files = [];
    if (entry.isFile) {
      const file = await new Promise((resolve) => entry.file(resolve));
      files.push(file);
    } else if (entry.isDirectory) {
      const dirReader = entry.createReader();
      const entries = await new Promise((resolve) => {
        dirReader.readEntries(resolve);
      });
      for (const subEntry of entries) {
        const subFiles = await getFilesFromEntry(subEntry);
        files = files.concat(subFiles);
      }
    }
    return files;
  }

  // Handle Drag & Drop files anywhere on document
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      const items = Array.from(e.dataTransfer.items);
      let files = [];
      for (const item of items) {
        const entry = item.webkitGetAsEntry();
        if (entry) {
          const entryFiles = await getFilesFromEntry(entry);
          files = files.concat(entryFiles);
        }
      }
      await processImportFiles(files);
    } else if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const files = Array.from(e.dataTransfer.files);
      await processImportFiles(files);
    }
  });

  // Sit button back down automatically after clicking on mobile by removing focus
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button, .account-chip, .btn, [role="button"]');
    if (btn && window.innerWidth <= 1024) {
      btn.blur();
    }
  });
}

function clearAuthAlerts() {
  elements.authErrorMsg.classList.add('hidden');
  elements.authErrorMsg.textContent = '';
  elements.authSuccessMsg.classList.add('hidden');
  elements.authSuccessMsg.textContent = '';
}

function restartAlertAnimation(el) {
  el.style.animation = 'none';
  void el.offsetWidth; // force a reflow so the browser forgets the old run
  el.style.animation = '';
}

function showAuthError(msg) {
  elements.authErrorMsg.textContent = msg.toLowerCase();
  elements.authErrorMsg.classList.remove('hidden');
  restartAlertAnimation(elements.authErrorMsg);
}

function showAuthSuccess(msg) {
  elements.authSuccessMsg.textContent = msg.toLowerCase();
  elements.authSuccessMsg.classList.remove('hidden');
  restartAlertAnimation(elements.authSuccessMsg);
}

// Sync helpers
// Loading the cloud data failed at login (offline) with nothing of this
// user's on the device: try again when the connection is back or the app
// is reopened.
let pendingCloudRetry = null;
function retryCloudLoadWhenOnline() {
  const retry = async () => {
    if (!currentUser || cloudReady) return cleanup();
    try {
      await pullFromCloud(false);
      cloudReady = true;
      cleanup();
    } catch (err) {
      console.error('Error loading cloud data:', err);
    }
  };
  const onVisible = () => { if (document.visibilityState === 'visible') retry(); };
  const cleanup = () => {
    pendingCloudRetry = null;
    window.removeEventListener('online', retry);
    document.removeEventListener('visibilitychange', onVisible);
  };
  pendingCloudRetry = retry;
  window.addEventListener('online', retry);
  document.addEventListener('visibilitychange', onVisible);
}

// `uploadLocalFirst`: this device's data is this user's own (see the login
// handler) — changes of theirs that never made it to the cloud (tab closed
// or offline before the batched upload) go up first, or the download would
// overwrite them with the older cloud copy.
async function pullFromCloud(uploadLocalFirst = false) {
  if (!supabaseClient || !currentUser) return;
  if (uploadLocalFirst && storageGet(CLOUD_DIRTY_KEY) === currentUser.id) {
    cloudReady = true;
    try { await pushToCloudNow(); } finally { cloudReady = false; }
  }

  isSyncingFromCloud = true;
  try {
    const { data, error } = await supabaseClient
      .from('checker_data')
      .select('starred, unfollowed')
      .eq('user_id', currentUser.id)
      .maybeSingle();

    if (error) throw error;

    if (data) {
      let rawStarred = data.starred || [];
      const metaItem = rawStarred.find(item => item && item.__meta);

      if (metaItem) {
        state.instagramAccounts = metaItem.instagram_accounts || [];
        normalizeInstagramAccounts();
        // This device's last choice first ('' = no account, on purpose),
        // then the one saved with the cloud data (null = no account). Only
        // an account that still exists; the first account only when
        // nothing says otherwise. This used to pick the first account
        // whenever none was selected, so "no account" never survived a
        // reload, and an unselected/deleted account came back.
        const findAccount = (name) => name
          ? state.instagramAccounts.find(acc => acc.originalUsername.toLowerCase() === name.toLowerCase())
          : null;
        const localRaw = storageGet('last_active_instagram_account');
        const localChoice = localRaw !== null ? localRaw : storageGet('selected_instagram_account');
        if (localChoice !== null && (localChoice === '' || findAccount(localChoice))) {
          state.selectedAccountUsername = localChoice === '' ? null : findAccount(localChoice).originalUsername;
        } else if ('selected_account' in metaItem && (metaItem.selected_account === null || findAccount(metaItem.selected_account))) {
          state.selectedAccountUsername = metaItem.selected_account ? findAccount(metaItem.selected_account).originalUsername : null;
        } else {
          state.selectedAccountUsername = state.instagramAccounts.length > 0 ? state.instagramAccounts[0].originalUsername : null;
        }

        saveAccountsList();
        if (state.selectedAccountUsername) {
          storageSet('selected_instagram_account', state.selectedAccountUsername);
        } else {
          storageRemove('selected_instagram_account');
        }

        if (metaItem.accounts_data) {
          Object.keys(metaItem.accounts_data).forEach(key => {
            const itemData = metaItem.accounts_data[key];
            if (itemData.following) storageSet(`following_users_${key}`, JSON.stringify(itemData.following));
            if (itemData.followers) storageSet(`followers_users_${key}`, JSON.stringify(itemData.followers));
            if (itemData.unfollowed) storageSet(`unfollowed_users_${key}`, JSON.stringify(itemData.unfollowed));
            if (itemData.starred) storageSet(`starred_users_${key}`, JSON.stringify(itemData.starred));
            // Restore the weekly reset reminder's anchor date so it reflects real elapsed time on login.
            if (itemData.importDate) storageSet(`import_date_${key}`, itemData.importDate);
            if (itemData.history) storageSet(`import_history_${key}`, JSON.stringify(itemData.history));
            if (itemData.diff) storageSet(`import_diff_${key}`, JSON.stringify(itemData.diff));
            // The saved imports list (features.js). Only the list and each
            // import's changes travel; the uploaded files stay on the device
            // that imported them.
            if (Array.isArray(itemData.imports)) storageSet(`import_log_${key}`, JSON.stringify(itemData.imports));
            if (itemData.extras) writeExtraLists(key, itemData.extras);
          });
        }

        // Clean meta header from raw starred list
        rawStarred = rawStarred.filter(item => !item.__meta);
      }

      // Save stripped starred list and unfollowed list to localStorage
      storageSet('starred_users', JSON.stringify(rawStarred));
      storageSet('unfollowed_users', JSON.stringify(data.unfollowed || []));

      // Restore account dataset if an account is selected, or default view if none
      if (state.selectedAccountUsername && !state.instagramAccounts.some(acc =>
        acc.originalUsername.toLowerCase() === state.selectedAccountUsername.toLowerCase())) {
        state.selectedAccountUsername = null;
      }
      if (state.selectedAccountUsername) {
        loadAccountData(state.selectedAccountUsername);
      } else {
        loadAccountData(null);
      }
    } else {
      const initialStarred = JSON.parse(storageGet('starred_users') || '[]');
      const initialAccounts = JSON.parse(storageGet('instagram_accounts') || '[]');

      const metaHeader = {
        __meta: true,
        instagram_accounts: initialAccounts,
        selected_account: state.selectedAccountUsername || null,
        accounts_data: {}
      };

      const { error: insertError } = await supabaseClient
        .from('checker_data')
        .insert({
          user_id: currentUser.id,
          starred: [metaHeader, ...initialStarred],
          unfollowed: []
        });

      if (insertError) throw insertError;

      const acc = state.selectedAccountUsername;
      const exists = acc && state.instagramAccounts.some(a => a.originalUsername.toLowerCase() === acc.toLowerCase());
      loadAccountData(exists ? acc : null);
    }
  } finally {
    isSyncingFromCloud = false;
    updateStorageProgressBar();
  }
}

// Cloud sync is batched: pushToCloud() schedules one upload for when
// activity settles (CLOUD_PUSH_DELAY after the last change) instead of
// running the whole sync — re-reading every account's lists, rebuilding the
// merged lists, uploading — on every single delete/star/switch. Rapid
// changes then cost one sync, after their animations, instead of one each,
// mid-slide. Anything pending is sent right away when the page is hidden or
// closed, before logging out, and before pulling from the cloud.
const CLOUD_PUSH_DELAY = 1500;
let cloudPushTimer = null;
let cloudPushWaiters = [];

// Marks this device as holding changes the cloud doesn't have yet (for this
// user), until an upload succeeds. If the tab closes before the batched
// upload goes out, the next login uploads these first instead of pulling
// the older cloud copy over them.
const CLOUD_DIRTY_KEY = 'cloud_unsynced_user';

// Which user the account data on this device belongs to.
const LOCAL_DATA_OWNER_KEY = 'local_data_owner';

// Removes every saved account's lists, the no-account lists, the merged
// lists and the selection from this device. Logging out used to leave the
// per-account unfollowed/starred lists, the no-account lists and the
// remembered selection behind, so the next person to log in on the device
// could see (and upload into their own cloud data) the previous user's.
function clearLocalAccountData() {
  const prefixes = ['following_users', 'followers_users', 'unfollowed_users', 'starred_users', 'import_date_',
    'hidden_users_', 'import_history_', 'import_diff_', 'extra_lists_', 'user_notes', 'unfollow_count_', 'unfollow_tally'];
  Object.keys(localStorage).forEach(key => {
    if (prefixes.some(prefix => key.startsWith(prefix))) storageRemove(key);
  });
  ['instagram_accounts', 'selected_instagram_account', 'last_active_instagram_account',
   'selected_username', CLOUD_DIRTY_KEY, LOCAL_DATA_OWNER_KEY].forEach(storageRemove);
}

// Nothing is uploaded until this login's data has been downloaded. Logging
// in resets the page to an empty state first (dropping the guest demo),
// and that redraw asked for an upload — which the download then sent
// before reading, overwriting the user's saved accounts and lists with
// nothing.
let cloudReady = false;

function pushToCloud() {
  if (!supabaseClient || !currentUser || !cloudReady) return Promise.resolve();
  storageSet(CLOUD_DIRTY_KEY, currentUser.id);
  return new Promise((resolve) => {
    cloudPushWaiters.push(resolve);
    clearTimeout(cloudPushTimer);
    cloudPushTimer = setTimeout(flushCloudPush, CLOUD_PUSH_DELAY);
  });
}

function hasPendingCloudPush() {
  return cloudPushTimer !== null;
}

async function flushCloudPush() {
  if (cloudPushTimer === null) return;
  clearTimeout(cloudPushTimer);
  cloudPushTimer = null;
  const waiters = cloudPushWaiters;
  cloudPushWaiters = [];
  try {
    await pushToCloudNow();
  } finally {
    waiters.forEach(resolve => resolve());
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushCloudPush();
});
window.addEventListener('pagehide', () => { flushCloudPush(); });

async function pushToCloudNow() {
  if (!supabaseClient || !currentUser || !cloudReady) return;

  try {
    const accountDataMap = {};
    const allStarredMap = new Map();
    const allUnfollowedMap = new Map();

    // Every account with saved data — including deleted chips, whose
    // unfollowed/starred history is kept for when they're added back.
    const accountSet = new Set([...(state.instagramAccounts || []).map(a => a.originalUsername.toLowerCase()), '_global_']);
    Object.keys(localStorage).forEach(key => {
      const match = /^(?:unfollowed|starred)_users_(.+)$/.exec(key);
      if (match) accountSet.add(match[1]);
    });
    accountSet.delete(DEMO_ID); // the demo chip is never saved
    const accounts = [...accountSet];

    // Include current active state in accountDataMap
    if (state.selectedAccountUsername && state.selectedAccountUsername.toLowerCase() !== DEMO_ID) {
      const currentKey = state.selectedAccountUsername.toLowerCase();
      storageSet(`following_users_${currentKey}`, JSON.stringify(state.following));
      storageSet(`followers_users_${currentKey}`, JSON.stringify(state.followers));
      storageSet(`unfollowed_users_${currentKey}`, JSON.stringify(state.unfollowed));
      storageSet(`starred_users_${currentKey}`, JSON.stringify(state.starred));
    }

    accounts.forEach(key => {
      const following = JSON.parse(storageGet(`following_users_${key}`) || '[]');
      const followers = JSON.parse(storageGet(`followers_users_${key}`) || '[]');
      const unfollowed = JSON.parse(storageGet(`unfollowed_users_${key}`) || '[]');
      const starred = JSON.parse(storageGet(`starred_users_${key}`) || '[]');
      const importDate = storageGet(`import_date_${key}`) || null;
      // Extras (features.js): import history and the changes since the
      // last import.
      const history = JSON.parse(storageGet(`import_history_${key}`) || '[]');
      const diff = JSON.parse(storageGet(`import_diff_${key}`) || 'null');
      const extras = readExtraLists(key);
      const imports = JSON.parse(storageGet(`import_log_${key}`) || '[]').slice(-100);

      accountDataMap[key] = { following, followers, unfollowed, starred, importDate, history, diff, extras, imports };

      unfollowed.forEach(u => {
        const itemAcc = u.account || key;
        allUnfollowedMap.set(`${itemAcc}_${u.username}`, { ...u, account: itemAcc });
      });

      starred.forEach(u => {
        const itemAcc = u.account || key;
        allStarredMap.set(`${itemAcc}_${u.username}`, { ...u, account: itemAcc });
      });
    });

    const activeAcc = state.selectedAccountUsername ? state.selectedAccountUsername.toLowerCase() : '_global_';
    (state.starred || []).forEach(u => {
      if (!u.__meta) {
        const itemAcc = u.account || activeAcc;
        if (itemAcc !== DEMO_ID) allStarredMap.set(`${itemAcc}_${u.username}`, { ...u, account: itemAcc });
      }
    });
    (state.unfollowed || []).forEach(u => {
      const itemAcc = u.account || activeAcc;
      if (itemAcc !== DEMO_ID) allUnfollowedMap.set(`${itemAcc}_${u.username}`, { ...u, account: itemAcc });
    });

    const allStarredArray = Array.from(allStarredMap.values());
    const allUnfollowedArray = Array.from(allUnfollowedMap.values());

    storageSet('starred_users', JSON.stringify(allStarredArray));
    storageSet('unfollowed_users', JSON.stringify(allUnfollowedArray));

    const metaHeader = {
      __meta: true,
      instagram_accounts: (state.instagramAccounts || []).filter(acc => !isDemoAccount(acc)),
      selected_account: (state.selectedAccountUsername && state.selectedAccountUsername.toLowerCase() !== DEMO_ID) ? state.selectedAccountUsername : null,
      accounts_data: accountDataMap
    };

    const cloudStarred = [metaHeader, ...allStarredArray];

    const { error } = await supabaseClient
      .from('checker_data')
      .upsert({
        user_id: currentUser.id,
        starred: cloudStarred,
        unfollowed: allUnfollowedArray,
        updated_at: new Date().toISOString()
      });

    if (error) throw error;
    if (storageGet(CLOUD_DIRTY_KEY) === currentUser.id && !hasPendingCloudPush()) {
      storageRemove(CLOUD_DIRTY_KEY);
    }
  } catch (err) {
    console.error('Error syncing data to Supabase:', err);
  } finally {
    updateStorageProgressBar();
  }
}

function updateStorageProgressBar() {
  const keysToMeasure = [
    'instagram_accounts',
    'selected_instagram_account',
    'unfollowed_users',
    'starred_users',
    'following_users__global_',
    'followers_users__global_',
    'unfollowed_users__global_',
    'starred_users__global_'
  ];
  
  const accounts = JSON.parse(storageGet('instagram_accounts') || '[]');
  accounts.forEach(acc => {
    // If acc is an object (new schema), get originalUsername. Otherwise fallback to acc as string.
    const username = typeof acc === 'object' && acc !== null ? acc.originalUsername : acc;
    if (username) {
      const key = username.toLowerCase();
      keysToMeasure.push(`following_users_${key}`);
      keysToMeasure.push(`followers_users_${key}`);
      keysToMeasure.push(`unfollowed_users_${key}`);
      keysToMeasure.push(`starred_users_${key}`);
    }
  });

  let totalBytes = 0;
  keysToMeasure.forEach(key => {
    const val = storageGet(key);
    if (val) {
      totalBytes += key.length + val.length;
    }
  });

  const quotaBytes = 5 * 1024 * 1024; // 5 MB LocalStorage / DB safe limit
  const percentage = (totalBytes / quotaBytes) * 100;
  
  const percentageText = `${percentage.toFixed(2)}%`;
  const usedText = totalBytes > 1024 ? `${(totalBytes / 1024).toFixed(1)} kb` : `${totalBytes} bytes`;

  const percentageEl = document.getElementById('storage-percentage');
  const fillEl = document.getElementById('storage-progress-fill');
  const usedEl = document.getElementById('storage-used-bytes');

  if (percentageEl) percentageEl.textContent = percentageText;
  if (fillEl) fillEl.style.width = `${Math.min(percentage, 100)}%`;
  if (usedEl) usedEl.textContent = `${usedText} used`;
}

// -------------------------------------------------------------
// Settings Management (Inline in Auth Dropdown)
// -------------------------------------------------------------
function initSettings() {
  storageRemove('show_keyboard'); // the keyboard shortcuts setting was removed
  applySettings();
  updateResetReminderUI();
}

function applySettings() {
  // Clean up temporary early settings styles block
  const earlyStyle = document.getElementById('early-settings-style');
  if (earlyStyle) earlyStyle.remove();
}

// -------------------------------------------------------------
// Weekly List Reset Reminder
//
// Anchored to wall-clock time (not a running session timer), so it keeps
// counting down while the user is logged out and reflects the true elapsed
// time whenever they next open the app. The import timestamp is stored per
// Instagram account in localStorage and round-trips through Supabase's
// `accounts_data` meta block (see pushToCloud/pullFromCloud), so it survives
// logout and is restored exactly on the next login.
// -------------------------------------------------------------
const RESET_REMINDER_DAYS = 7;
const RESET_REMINDER_MS = RESET_REMINDER_DAYS * 24 * 60 * 60 * 1000;

function getImportDateKey(accountUsername) {
  const acc = accountUsername ? accountUsername.toLowerCase() : '_global_';
  return `import_date_${acc}`;
}

function recordImportDate(accountUsername) {
  storageSet(getImportDateKey(accountUsername), String(Date.now()));
  updateResetReminderUI();
}

// When the weekly reset is due, each reset button in settings says so (and
// its row turns red) until that list has been reset — or is empty.
const RESET_LISTS = [['unfollowed', 'settings-reset-unfollowed-btn'], ['starred', 'settings-reset-starred-btn']];
const listResetKey = (type) => `list_reset_${type}_${state.selectedAccountUsername ? state.selectedAccountUsername.toLowerCase() : '_global_'}`;
function listNeedsReset(type, dueAt) {
  if (!dueAt || Date.now() < dueAt || !(state[type] || []).length) return false;
  return (parseInt(storageGet(listResetKey(type)) || '0', 10) || 0) < dueAt;
}
function resetStillDue(dueAt) {
  return RESET_LISTS.some(([type]) => listNeedsReset(type, dueAt));
}
function applyResetDue(dueAt) {
  RESET_LISTS.forEach(([type, id]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    const due = listNeedsReset(type, dueAt);
    btn.classList.toggle('reset-due', due);
    const text = due ? 'reset due' : 'reset';
    if (btn.textContent !== text) btn.textContent = text;
    const row = btn.closest('.setting-item-row');
    if (row) row.classList.toggle('reset-due', due);
  });
}

function updateResetReminderUI() {
  const box = document.getElementById('reset-reminder-box');
  const valueEl = document.getElementById('reset-reminder-value');
  const detailEl = document.getElementById('reset-reminder-detail');
  const fillEl = document.getElementById('reset-reminder-progress-fill');
  if (!box || !valueEl || !detailEl || !fillEl) return;

  const importedAtRaw = storageGet(getImportDateKey(state.selectedAccountUsername));

  applyResetDue(importedAtRaw ? parseInt(importedAtRaw, 10) + RESET_REMINDER_MS : null);

  if (!importedAtRaw) {
    box.classList.remove('overdue');
    valueEl.textContent = 'not started';
    detailEl.textContent = 'import your files to start the weekly reminder';
    fillEl.style.width = '0%';
    return;
  }

  const importedAt = parseInt(importedAtRaw, 10);
  const now = Date.now();
  const remainingMs = (importedAt + RESET_REMINDER_MS) - now;
  const importedDateText = new Date(importedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const dayMs = 24 * 60 * 60 * 1000;

  if (remainingMs <= 0 && !resetStillDue(importedAt + RESET_REMINDER_MS)) {
    // Both lists have been reset since it came due: done until the next import.
    box.classList.remove('overdue');
    valueEl.textContent = 'lists reset';
    detailEl.textContent = `imported ${importedDateText}`;
    fillEl.style.width = '100%';
  } else if (remainingMs <= 0) {
    const overdueDays = Math.floor(-remainingMs / dayMs);
    box.classList.add('overdue');
    valueEl.textContent = overdueDays > 0 ? `overdue by ${plural(overdueDays, 'day')}` : 'overdue';
    detailEl.textContent = `imported ${importedDateText}`;
    fillEl.style.width = '100%';
  } else {
    box.classList.remove('overdue');
    const remainingDays = Math.floor(remainingMs / dayMs);
    const remainingHours = Math.floor((remainingMs % dayMs) / (60 * 60 * 1000));
    const remainingText = remainingDays > 0 ? plural(remainingDays, 'day') : plural(remainingHours, 'hour');
    valueEl.textContent = `${remainingText} left`;
    detailEl.textContent = `imported ${importedDateText}`;
    fillEl.style.width = `${Math.min(100, Math.max(0, ((now - importedAt) / RESET_REMINDER_MS) * 100))}%`;
  }
}

// -------------------------------------------------------------
// App Initialization
// -------------------------------------------------------------
// The demo chip never outlives the page (see startDemo).
clearDemoData();
if (state.selectedAccountUsername && state.selectedAccountUsername.toLowerCase() === DEMO_ID) state.selectedAccountUsername = null;

document.addEventListener('DOMContentLoaded', () => {
  if ((window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform()) || window.matchMedia('(display-mode: standalone)').matches) {
    document.body.classList.add('is-capacitor');
  }
  normalizeInstagramAccounts();
  initTheme();
  initSettings();
  setupEventListeners();
  initAuth();
  updateStarredUI();
  // initAuth() -> applyGuestPreviewLock() already set up the guest demo
  // account (and rendered it) when logged out; loadAccountData would
  // immediately overwrite that with the (empty) localStorage data for
  // that username, wiping out the demo unfollower before it's ever seen.
  if (state.selectedAccountUsername === GUEST_PREVIEW_USERNAME) {
    // already loaded by applyGuestPreviewLock; nothing to do
  } else if (state.selectedAccountUsername) {
    loadAccountData(state.selectedAccountUsername);
  } else {
    renderAccountChips();
  }
  updateStorageProgressBar();
});

// Prevent wheel pinch-to-zoom and keyboard zoom scaling — except on a Mac,
// where trackpad pinch and Cmd +/-/0 zoom the page as usual. (An iPad also
// reports "Mac" but has touch points; its zoom is the viewport tag's call.)
const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent) && !(navigator.maxTouchPoints > 1);
if (!IS_MAC) {
  window.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
    }
  }, { passive: false });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0')) {
      e.preventDefault();
    }
  });
}

// -------------------------------------------------------------
// Haptic Feedback (mobile only)
// -------------------------------------------------------------
// navigator.vibrate() only exists on touch-capable browsers (Android Chrome
// and friends) — iOS Safari has no web API for haptics/vibration at all,
// that's an Apple platform restriction with no workaround from a website,
// so this silently no-ops there instead of erroring.
(function initHapticFeedback() {
  const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  if (!isTouchDevice || typeof navigator.vibrate !== 'function') return;

  const BUTTON_SELECTOR = 'button, [class*="btn"], .account-chip, .switch, .user-row';

  document.addEventListener('click', (e) => {
    const target = e.target.closest(BUTTON_SELECTOR);
    if (!target || target.disabled) return;
    navigator.vibrate(10);
  }, { passive: true });
})();
