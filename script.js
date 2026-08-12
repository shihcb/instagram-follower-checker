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
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (err) {
    console.error('Failed to initialize Supabase client:', err);
  }
}

const state = {
  following: [],  // Array of { username, originalUsername, fullName, timestamp, profileUrl }
  followers: [],  // Array of { username, originalUsername, fullName, timestamp, profileUrl }
  unfollowers: [], // Array of { username, originalUsername, fullName, timestamp, profileUrl }
  unfollowed: [],  // Array of { username, originalUsername, fullName, timestamp, profileUrl }
  starred: JSON.parse(localStorage.getItem('starred_users') || '[]'), // Array of { username, originalUsername, fullName, timestamp, profileUrl }
  selectedIndex: -1 // Current keyboard selection index (0-indexed) in the filtered list
};

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

  // Following list elements
  inputFollowing: document.getElementById('input-following'),
  fileFollowing: document.getElementById('file-following'),
  dropFollowing: document.getElementById('drop-following'),
  clearFollowing: document.getElementById('clear-following'),
  followingCount: document.getElementById('following-count'),
  togglePreviewFollowing: document.getElementById('toggle-preview-following'),
  listFollowing: document.getElementById('list-following'),

  // Followers list elements
  inputFollowers: document.getElementById('input-followers'),
  fileFollowers: document.getElementById('file-followers'),
  dropFollowers: document.getElementById('drop-followers'),
  clearFollowers: document.getElementById('clear-followers'),
  followersCount: document.getElementById('followers-count'),
  togglePreviewFollowers: document.getElementById('toggle-preview-followers'),
  listFollowers: document.getElementById('list-followers'),

  // Unfollowers (Results) elements
  unfollowersCount: document.getElementById('unfollowers-count'),
  searchUnfollowers: document.getElementById('search-unfollowers'),
  copyUnfollowers: document.getElementById('copy-unfollowers'),
  listUnfollowers: document.getElementById('list-unfollowers'),
  emptyState: document.getElementById('unfollowers-empty-state'),
  togglePreviewUnfollowed: document.getElementById('toggle-preview-unfollowed'),
  listUnfollowed: document.getElementById('list-unfollowed'),
  togglePreviewStarred: document.getElementById('toggle-preview-starred'),
  listStarred: document.getElementById('list-starred'),

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
  authErrorMsg: document.getElementById('auth-error-msg'),
  authSuccessMsg: document.getElementById('auth-success-msg'),
  authUserEmail: document.getElementById('auth-user-email'),
  btnLogout: document.getElementById('btn-logout')
};

// -------------------------------------------------------------
// Theme Management (Light/Dark)
// -------------------------------------------------------------
function initTheme() {
  const savedTheme = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const activeTheme = savedTheme || (prefersDark ? 'dark' : 'light');
  
  setTheme(activeTheme);
  
  // Listen to system changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem('theme')) {
      setTheme(e.matches ? 'dark' : 'light');
    }
  });

  elements.themeToggle.addEventListener('click', () => {
    const currentTheme = elements.html.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('theme', newTheme);
    setTheme(newTheme);
  });
}

function setTheme(theme) {
  elements.html.setAttribute('data-theme', theme);
  document.querySelector('meta[name="color-scheme"]').setAttribute('content', theme);
  
  if (theme === 'dark') {
    elements.sunIcon.classList.remove('hidden');
    elements.moonIcon.classList.add('hidden');
  } else {
    elements.sunIcon.classList.add('hidden');
    elements.moonIcon.classList.remove('hidden');
  }
}

// -------------------------------------------------------------
// Date Formatting Helpers
// -------------------------------------------------------------
function formatDate(date) {
  if (!date) return '';
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
      
      // Look for relationship lists containing string_list_data
      if (Array.isArray(obj.string_list_data)) {
        obj.string_list_data.forEach(item => {
          if (item.value) {
            const username = item.value;
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
  // Simple check to ensure we have HTML content
  if (!text.includes('<a') && !text.includes('<div')) return null;
  
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/html');
    const anchors = doc.querySelectorAll('a');
    const results = [];
    
    if (anchors.length === 0) return null;

    anchors.forEach(a => {
      const href = a.getAttribute('href') || '';
      // Check if URL points to Instagram profile
      if (href.includes('instagram.com/') || href.match(/^\/[a-zA-Z0-9._]+$/) || a.textContent.trim().match(/^[a-zA-Z0-9._]{1,30}$/)) {
        let username = a.textContent.trim();
        
        // Extract from href if text content is blank or contains external label
        if (!username || username.includes(' ') || !isValidUsername(username)) {
          const parts = href.split('/').filter(Boolean);
          const possibleUser = parts[parts.length - 1]?.split('?')[0];
          if (possibleUser && isValidUsername(possibleUser)) {
            username = possibleUser;
          } else {
            return; // Skip invalid
          }
        }
        
        // Skip common UI link endpoints
        if (EXCLUDE_KEYWORDS.has(username.toLowerCase())) return;

        let timestamp = null;
        let fullName = '';
        
        // Find associated timestamp or full name in parent block
        let parent = a.parentElement;
        let searchCount = 0;
        // Search up to 3 levels of parent containers
        while (parent && searchCount < 3) {
          const siblingText = parent.textContent || '';
          
          // Try to extract dates (e.g. Aug 11, 2026 or 2026-08-11 or 11 Aug 2026)
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
          username: normalizeUsername(username),
          originalUsername: username,
          fullName: fullName,
          timestamp: timestamp,
          profileUrl: href.startsWith('/') ? `https://www.instagram.com${href}` : href
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

function calculateUnfollowers() {
  const followersSet = new Set(state.followers.map(user => user.username));
  const unfollowedSet = new Set(state.unfollowed.map(user => user.username));
  const starredSet = new Set(state.starred.map(user => user.username));
  
  // Math difference: filter out any 'following' users that are in the 'followers' set, unfollowed list, or starred list
  state.unfollowers = state.following.filter(user => 
    !followersSet.has(user.username) && 
    !unfollowedSet.has(user.username) &&
    !starredSet.has(user.username)
  );
  
  updateResultsUI();
  updateUnfollowedUI();
  updateStarredUI();

  // Sync state changes with the cloud automatically
  if (!isSyncingFromCloud) {
    pushToCloud();
  }
}

function updateUnfollowedUI() {
  const listData = state.unfollowed;
  const listEl = elements.listUnfollowed;
  const toggleBtn = elements.togglePreviewUnfollowed;

  if (listData.length > 0) {
    toggleBtn.removeAttribute('disabled');
    toggleBtn.querySelector('span').textContent = toggleBtn.classList.contains('active') 
      ? `hide unfollowed users (${listData.length})` 
      : `show unfollowed users (${listData.length})`;
    
    // Render elements (same layout as parsed-list)
    listEl.innerHTML = listData.map(user => `
      <div class="parsed-item">
        <a href="${user.profileUrl}" target="_blank" rel="noopener" class="parsed-username">@${user.originalUsername}</a>
        <span>${user.fullName ? user.fullName : (user.timestamp ? formatDate(user.timestamp) : '')}</span>
      </div>
    `).join('');
  } else {
    toggleBtn.setAttribute('disabled', 'true');
    toggleBtn.querySelector('span').textContent = 'show unfollowed users';
    listEl.innerHTML = '';
    listEl.classList.add('hidden');
    toggleBtn.classList.remove('active');
  }
}

function updateStarredUI() {
  const listData = state.starred;
  const listEl = elements.listStarred;
  const toggleBtn = elements.togglePreviewStarred;

  if (listData.length > 0) {
    toggleBtn.removeAttribute('disabled');
    toggleBtn.querySelector('span').textContent = toggleBtn.classList.contains('active') 
      ? `hide starred users (${listData.length})` 
      : `show starred users (${listData.length})`;
    
    // Render elements (same layout as parsed-list)
    listEl.innerHTML = listData.map(user => `
      <div class="parsed-item">
        <a href="${user.profileUrl}" target="_blank" rel="noopener" class="parsed-username">@${user.originalUsername}</a>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span>${user.fullName ? user.fullName : (user.timestamp ? formatDate(user.timestamp) : '')}</span>
          <button class="unstar-btn" data-username="${user.username}" aria-label="unstar user" style="border: none; background: transparent; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--text-main); padding: 4px;">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="currentColor" stroke-width="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
            </svg>
          </button>
        </div>
      </div>
    `).join('');
  } else {
    toggleBtn.setAttribute('disabled', 'true');
    toggleBtn.querySelector('span').textContent = 'show starred users';
    listEl.innerHTML = '';
    listEl.classList.add('hidden');
    toggleBtn.classList.remove('active');
  }
}

/**
 * Deduplicates parsed user entries (prioritizing entries with timestamps/names).
 */
function deduplicateEntries(entries) {
  const seen = new Map();
  entries.forEach(entry => {
    const existing = seen.get(entry.username);
    if (!existing || (!existing.timestamp && entry.timestamp) || (!existing.fullName && entry.fullName)) {
      seen.set(entry.username, entry);
    }
  });
  return Array.from(seen.values());
}

// -------------------------------------------------------------
// UI Renderers & State Syncing
// -------------------------------------------------------------

function updateListUI(type) {
  const listData = state[type];
  const countBadge = elements[`${type}Count`];
  const listEl = elements[`list${type.charAt(0).toUpperCase() + type.slice(1)}`];
  const toggleBtn = elements[`togglePreview${type.charAt(0).toUpperCase() + type.slice(1)}`];

  countBadge.textContent = `${listData.length} loaded`;
  
  if (listData.length > 0) {
    toggleBtn.removeAttribute('disabled');
    
    // Render preview elements
    listEl.innerHTML = listData.map(user => `
      <div class="parsed-item">
        <a href="${user.profileUrl}" target="_blank" rel="noopener" class="parsed-username">@${user.originalUsername}</a>
        <span>${user.fullName ? user.fullName : (user.timestamp ? formatDate(user.timestamp) : '')}</span>
      </div>
    `).join('');
  } else {
    toggleBtn.setAttribute('disabled', 'true');
    listEl.innerHTML = '';
    listEl.classList.add('hidden');
    toggleBtn.classList.remove('active');
    toggleBtn.querySelector('span').textContent = 'show loaded users';
  }
}

function updateResultsUI() {
  const count = state.unfollowers.length;
  elements.unfollowersCount.textContent = `${count} found`;
  
  if (state.following.length > 0 || state.followers.length > 0) {
    elements.searchUnfollowers.removeAttribute('disabled');
    elements.copyUnfollowers.removeAttribute('disabled');
  } else {
    elements.searchUnfollowers.setAttribute('disabled', 'true');
    elements.copyUnfollowers.setAttribute('disabled', 'true');
  }

  const query = elements.searchUnfollowers.value.toLowerCase().trim();
  const filtered = state.unfollowers.filter(user => 
    user.originalUsername.toLowerCase().includes(query) || 
    (user.fullName && user.fullName.toLowerCase().includes(query))
  );

  if (filtered.length > 0) {
    elements.emptyState.classList.add('hidden');
    elements.listUnfollowers.classList.remove('hidden');
    
    elements.listUnfollowers.innerHTML = filtered.map((user, index) => {
      // Get display initials for profile avatar fallback
      const initials = user.originalUsername.substring(0, 2);
      const isSelected = index === state.selectedIndex;
      
      return `
        <div class="user-row${isSelected ? ' selected' : ''}" data-username="${user.username}" data-index="${index}">
          <div class="user-info">
            <div class="user-avatar">${initials}</div>
            <div class="user-details">
              <a href="${user.profileUrl}" target="_blank" rel="noopener" class="user-link">
                @${user.originalUsername}
              </a>
              ${user.fullName ? `<span class="user-fullname">${user.fullName}</span>` : ''}
            </div>
          </div>
          <div class="user-meta">
            ${user.timestamp ? `
              <span class="follow-date">
                <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="16" y1="2" x2="16" y2="6"></line>
                  <line x1="8" y1="2" x2="8" y2="6"></line>
                  <line x1="3" y1="10" x2="21" y2="10"></line>
                </svg>
                ${formatDate(user.timestamp)}
              </span>
            ` : ''}
            <div class="user-row-actions">
              <button class="action-star" aria-label="star user" title="star/favorite user to separate them from results">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                </svg>
              </button>
              <a href="${user.profileUrl}" target="_blank" rel="noopener" class="action-arrow" aria-label="Visit Instagram Profile">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                  <polyline points="12 5 19 12 12 19"></polyline>
                </svg>
              </a>
            </div>
          </div>
        </div>
      `;
    }).join('');
  } else {
    elements.listUnfollowers.classList.add('hidden');
    elements.emptyState.classList.remove('hidden');
    
    if (state.following.length === 0 && state.followers.length === 0) {
      elements.emptyState.querySelector('.empty-title').textContent = 'waiting for data';
      elements.emptyState.querySelector('.empty-desc').textContent = 'input your following and followers lists on the left to find who doesn\'t follow you back.';
    } else {
      elements.emptyState.querySelector('.empty-title').textContent = 'no results found';
      elements.emptyState.querySelector('.empty-desc').textContent = query ? 'no matching usernames found in the filter.' : 'wow! everyone you follow follows you back.';
    }
  }
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

const handleFollowingInput = debounce(function() {
  const rawText = elements.inputFollowing.value;
  const parsed = parseInput(rawText);
  state.following = deduplicateEntries(parsed);
  updateListUI('following');
  calculateUnfollowers();
}, 250);

const handleFollowersInput = debounce(function() {
  const rawText = elements.inputFollowers.value;
  const parsed = parseInput(rawText);
  state.followers = deduplicateEntries(parsed);
  updateListUI('followers');
  calculateUnfollowers();
}, 250);

function handleFileSelect(file, type) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    const content = e.target.result;
    const inputEl = elements[`input${type.charAt(0).toUpperCase() + type.slice(1)}`];
    inputEl.value = content;
    
    // Dispatch input event to trigger parser
    if (type === 'following') {
      handleFollowingInput();
    } else {
      handleFollowersInput();
    }
  };
  reader.readAsText(file);
}

// Set up drag and drop behaviors
function setupDragAndDrop(dropZone, fileInput, type) {
  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    }, false);
  });

  dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length > 0) {
      handleFileSelect(files[0], type);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileSelect(e.target.files[0], type);
    }
  });
}

// -------------------------------------------------------------
// Interactive Feature Event Listeners
// -------------------------------------------------------------

function setupEventListeners() {
  // Realtime search filtering
  elements.searchUnfollowers.addEventListener('input', () => {
    state.selectedIndex = -1; // Reset keyboard selection on search query change
    updateResultsUI();
  });
  
  // Copy unfollowers list to clipboard
  elements.copyUnfollowers.addEventListener('click', () => {
    if (state.unfollowers.length === 0) return;
    
    const usernames = state.unfollowers.map(user => `@${user.originalUsername}`).join('\n');
    navigator.clipboard.writeText(usernames).then(() => {
      const originalContent = elements.copyUnfollowers.innerHTML;
      elements.copyUnfollowers.classList.add('btn-success');
      elements.copyUnfollowers.innerHTML = `
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>copied!</span>
      `;
      
      setTimeout(() => {
        elements.copyUnfollowers.classList.remove('btn-success');
        elements.copyUnfollowers.innerHTML = originalContent;
      }, 2000);
    }).catch(err => {
      console.error('Failed to copy text: ', err);
    });
  });

  // Action buttons: Clear
  elements.clearFollowing.addEventListener('click', () => {
    elements.inputFollowing.value = '';
    state.following = [];
    state.unfollowed = [];
    state.selectedIndex = -1; // Reset selection index
    updateListUI('following');
    calculateUnfollowers();
  });

  elements.clearFollowers.addEventListener('click', () => {
    elements.inputFollowers.value = '';
    state.followers = [];
    state.unfollowed = [];
    state.selectedIndex = -1; // Reset selection index
    updateListUI('followers');
    calculateUnfollowers();
  });

  // Accordion toggles for source previews
  elements.togglePreviewFollowing.addEventListener('click', () => {
    const isHidden = elements.listFollowing.classList.toggle('hidden');
    elements.togglePreviewFollowing.classList.toggle('active', !isHidden);
    elements.togglePreviewFollowing.querySelector('span').textContent = isHidden ? 'show loaded users' : 'hide loaded users';
  });

  elements.togglePreviewFollowers.addEventListener('click', () => {
    const isHidden = elements.listFollowers.classList.toggle('hidden');
    elements.togglePreviewFollowers.classList.toggle('active', !isHidden);
    elements.togglePreviewFollowers.querySelector('span').textContent = isHidden ? 'show loaded users' : 'hide loaded users';
  });

  // Handle click on username, action arrow, or star button
  elements.listUnfollowers.addEventListener('click', (e) => {
    const userLink = e.target.closest('.user-link');
    const actionArrow = e.target.closest('.action-arrow');
    const actionStar = e.target.closest('.action-star');
    
    if (actionStar) {
      const userRow = e.target.closest('.user-row');
      if (userRow) {
        const username = userRow.getAttribute('data-username');
        const userObj = state.unfollowers.find(u => u.username === username);
        if (userObj) {
          // Move user to Starred (favorite) list
          if (!state.starred.some(u => u.username === username)) {
            state.starred.push(userObj);
            localStorage.setItem('starred_users', JSON.stringify(state.starred));
          }
          calculateUnfollowers();
        }
      }
      return;
    }

    if (userLink || actionArrow) {
      const userRow = e.target.closest('.user-row');
      if (userRow) {
        const username = userRow.getAttribute('data-username');
        const userObj = state.unfollowers.find(u => u.username === username);
        if (userObj) {
          if (!state.unfollowed.some(u => u.username === username)) {
            state.unfollowed.push(userObj);
          }
          calculateUnfollowers();
        }
      }
    }
  });

  // Toggle preview unfollowed list
  elements.togglePreviewUnfollowed.addEventListener('click', () => {
    const isHidden = elements.listUnfollowed.classList.toggle('hidden');
    elements.togglePreviewUnfollowed.classList.toggle('active', !isHidden);
    elements.togglePreviewUnfollowed.querySelector('span').textContent = isHidden 
      ? `show unfollowed users (${state.unfollowed.length})` 
      : `hide unfollowed users (${state.unfollowed.length})`;
  });

  // Toggle preview starred list
  elements.togglePreviewStarred.addEventListener('click', () => {
    const isHidden = elements.listStarred.classList.toggle('hidden');
    elements.togglePreviewStarred.classList.toggle('active', !isHidden);
    elements.togglePreviewStarred.querySelector('span').textContent = isHidden 
      ? `show starred users (${state.starred.length})` 
      : `hide starred users (${state.starred.length})`;
  });

  // Handle click on unstar inside starred list
  elements.listStarred.addEventListener('click', (e) => {
    const unstarBtn = e.target.closest('.unstar-btn');
    if (unstarBtn) {
      const username = unstarBtn.getAttribute('data-username');
      state.starred = state.starred.filter(u => u.username !== username);
      localStorage.setItem('starred_users', JSON.stringify(state.starred));
      calculateUnfollowers();
    }
  });

  // Setup inputs
  elements.inputFollowing.addEventListener('input', handleFollowingInput);
  elements.inputFollowers.addEventListener('input', handleFollowersInput);

  // Setup drag and drop
  setupDragAndDrop(elements.dropFollowing, elements.fileFollowing, 'following');
  setupDragAndDrop(elements.dropFollowers, elements.fileFollowers, 'followers');

  // Keyboard navigation shortcuts (Desktop only)
  document.addEventListener('keydown', (e) => {
    // Only enable if screen layout is desktop sizing
    if (window.innerWidth < 1025) return;

    // Ignore shortcuts if the user is typing in Following or Followers textareas
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active !== elements.searchUnfollowers) {
      return;
    }

    const searchInput = elements.searchUnfollowers;
    const isSearchFocused = active === searchInput;

    // 1. If search filter is active
    if (isSearchFocused) {
      if (e.key === 'Escape') {
        searchInput.blur();
        e.preventDefault();
      } else if (e.key === 'ArrowDown') {
        const rows = elements.listUnfollowers.querySelectorAll('.user-row');
        if (rows.length > 0) {
          state.selectedIndex = 0;
          highlightRow(0);
          searchInput.blur();
          e.preventDefault();
        }
      }
      return;
    }

    // 2. If list navigation is active
    if (e.key === '/') {
      searchInput.focus();
      setTimeout(() => searchInput.select(), 0);
      e.preventDefault();
      return;
    }

    const rows = elements.listUnfollowers.querySelectorAll('.user-row');
    if (rows.length === 0) return;

    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      state.selectedIndex++;
      if (state.selectedIndex >= rows.length) {
        state.selectedIndex = 0; // Wrap back to start
      }
      highlightRow(state.selectedIndex);
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      state.selectedIndex--;
      if (state.selectedIndex < 0) {
        state.selectedIndex = rows.length - 1; // Wrap back to end
      }
      highlightRow(state.selectedIndex);
    } else if (e.key === 'Enter' || e.key === 'o') {
      e.preventDefault();
      if (state.selectedIndex >= 0 && state.selectedIndex < rows.length) {
        const selectedRow = rows[state.selectedIndex];
        const username = selectedRow.getAttribute('data-username');
        const userObj = state.unfollowers.find(u => u.username === username);
        
        if (userObj) {
          // Open Instagram profile
          window.open(userObj.profileUrl, '_blank');
          
          // Move user to Unfollowed list
          if (!state.unfollowed.some(u => u.username === username)) {
            state.unfollowed.push(userObj);
          }
          calculateUnfollowers();
          
          // Selection index remains the same but points to next item. 
          // If out of bounds (reached end of list), clip it.
          const newRows = elements.listUnfollowers.querySelectorAll('.user-row');
          if (newRows.length > 0) {
            if (state.selectedIndex >= newRows.length) {
              state.selectedIndex = newRows.length - 1;
            }
            highlightRow(state.selectedIndex);
          } else {
            state.selectedIndex = -1;
          }
        }
      }
    } else if (e.key === 'Escape') {
      state.selectedIndex = -1;
      highlightRow(-1);
      e.preventDefault();
    }
  });

  function highlightRow(index) {
    const rows = elements.listUnfollowers.querySelectorAll('.user-row');
    rows.forEach((row, i) => {
      if (i === index) {
        row.classList.add('selected');
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      } else {
        row.classList.remove('selected');
      }
    });
  }
}

// -------------------------------------------------------------
// Supabase Cloud Authentication & Data Sync (Option B)
// -------------------------------------------------------------
let currentUser = null;
let isSigningUp = false;

function initAuth() {
  if (!supabaseClient) {
    // Show configuration warning if URL/Anon key are empty
    elements.authConfigWarning.classList.remove('hidden');
    elements.authFormView.classList.add('hidden');
    return;
  }

  // Subscribe to auth state updates
  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    if (session) {
      currentUser = session.user;
      elements.userBadge.classList.remove('hidden');
      elements.authUserEmail.textContent = currentUser.email;
      
      // Update UI panels in modal
      elements.authProfileView.classList.remove('hidden');
      elements.authFormView.classList.add('hidden');

      // Fetch cloud data and merge/sync
      await pullFromCloud();
    } else {
      currentUser = null;
      elements.userBadge.classList.add('hidden');
      
      // Update UI panels in modal
      elements.authProfileView.classList.add('hidden');
      elements.authFormView.classList.remove('hidden');
      
      // Clear all loaded information and input textareas
      state.following = [];
      state.followers = [];
      state.unfollowers = [];
      state.unfollowed = [];
      state.starred = [];
      state.selectedIndex = -1;
      
      localStorage.removeItem('starred_users');
      
      elements.inputFollowing.value = '';
      elements.inputFollowers.value = '';
      elements.searchUnfollowers.value = '';
      
      updateListUI('following');
      updateListUI('followers');
      calculateUnfollowers();
    }
  });

  // Wire up auth layout UI tab triggers with a smooth cross-fade transition
  function switchTab(signup) {
    if (isSigningUp === signup) return;
    
    // Add fade-out state
    elements.authForm.style.opacity = '0';
    elements.authForm.style.transform = 'translateY(6px)';
    
    setTimeout(() => {
      isSigningUp = signup;
      if (signup) {
        elements.tabLogin.classList.remove('active');
        elements.tabSignup.classList.add('active');
        elements.authSubmitBtn.textContent = 'sign up';
      } else {
        elements.tabLogin.classList.add('active');
        elements.tabSignup.classList.remove('active');
        elements.authSubmitBtn.textContent = 'log in';
      }
      clearAuthAlerts();
      
      // Fade back in
      elements.authForm.style.opacity = '1';
      elements.authForm.style.transform = 'translateY(0)';
    }, 150);
  }

  elements.tabLogin.addEventListener('click', () => switchTab(false));
  elements.tabSignup.addEventListener('click', () => switchTab(true));

  // Toggle drop down menu on button click
  elements.authBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    elements.authDropdown.classList.toggle('hidden');
  });

  // Close drop down on clicking outside
  document.addEventListener('click', (e) => {
    if (!elements.authDropdown.classList.contains('hidden')) {
      if (!elements.authDropdown.contains(e.target) && !elements.authBtn.contains(e.target)) {
        elements.authDropdown.classList.add('hidden');
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
        showAuthSuccess('account created! check your email if confirmation is required, or try logging in.');
      }
    } else {
      // Supabase Log In
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      
      if (error) {
        showAuthError(error.message);
      } else {
        showAuthSuccess('login successful!');
        setTimeout(() => {
          elements.authDropdown.classList.add('hidden');
          clearAuthAlerts();
        }, 1200);
      }
    }

    elements.authSubmitBtn.removeAttribute('disabled');
    elements.authSubmitBtn.textContent = isSigningUp ? 'sign up' : 'log in';
  });

  // Handle Log Out
  elements.btnLogout.addEventListener('click', async () => {
    if (supabaseClient) {
      await supabaseClient.auth.signOut();
      elements.authDropdown.classList.add('hidden');
    }
  });
}

function clearAuthAlerts() {
  elements.authErrorMsg.classList.add('hidden');
  elements.authErrorMsg.textContent = '';
  elements.authSuccessMsg.classList.add('hidden');
  elements.authSuccessMsg.textContent = '';
}

function showAuthError(msg) {
  elements.authErrorMsg.textContent = msg.toLowerCase();
  elements.authErrorMsg.classList.remove('hidden');
}

function showAuthSuccess(msg) {
  elements.authSuccessMsg.textContent = msg.toLowerCase();
  elements.authSuccessMsg.classList.remove('hidden');
}

// Sync helpers
async function pullFromCloud() {
  if (!supabaseClient || !currentUser) return;

  isSyncingFromCloud = true;
  try {
    const { data, error } = await supabaseClient
      .from('checker_data')
      .select('starred, unfollowed')
      .eq('user_id', currentUser.id)
      .maybeSingle();

    if (error) throw error;

    if (data) {
      // Pull cloud data into local state
      state.starred = data.starred || [];
      state.unfollowed = data.unfollowed || [];
      
      // Update local storage
      localStorage.setItem('starred_users', JSON.stringify(state.starred));
    } else {
      // Create cloud record with existing local data
      const initialStarred = JSON.parse(localStorage.getItem('starred_users') || '[]');
      
      const { error: insertError } = await supabaseClient
        .from('checker_data')
        .insert({
          user_id: currentUser.id,
          starred: initialStarred,
          unfollowed: []
        });

      if (insertError) throw insertError;
      
      state.starred = initialStarred;
      state.unfollowed = [];
    }

    calculateUnfollowers();
  } catch (err) {
    console.error('Error pulling user data from Supabase:', err);
  } finally {
    isSyncingFromCloud = false;
  }
}

async function pushToCloud() {
  if (!supabaseClient || !currentUser) return;

  try {
    const { error } = await supabaseClient
      .from('checker_data')
      .upsert({
        user_id: currentUser.id,
        starred: state.starred,
        unfollowed: state.unfollowed,
        updated_at: new Date().toISOString()
      });

    if (error) throw error;
  } catch (err) {
    console.error('Error syncing data to Supabase:', err);
  }
}

// -------------------------------------------------------------
// App Initialization
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  setupEventListeners();
  initAuth();
  updateStarredUI();
});
