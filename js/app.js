// ========== STATE ==========
// Directory the app is served from (e.g. "/vta-qs-lms") - computed once so nothing
// hardcodes the XAMPP subfolder name, and this keeps working unchanged if the app is
// ever moved to a vhost root (where it just resolves to '').
const BASE_PATH = location.pathname.replace(/\/[^/]*$/, '');
const API = BASE_PATH + '/api';
let currentUser = JSON.parse(localStorage.getItem('vta_user') || 'null');
let courseCache = [];
let studentCache = [];
let currentThreadId = null;
let adminDashRotateTimer = null;

// Prefixes a DB-stored "/uploads/...""-style path with BASE_PATH so it resolves
// correctly when the app is served from a subfolder instead of the domain root.
function assetUrl(path) {
  return path ? BASE_PATH + path : path;
}

// ========== API HELPER ==========
async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  let fetchMethod = method;
  let fetchBody;
  if (body instanceof FormData) {
    // PHP doesn't populate $_FILES/$_POST for native PUT/PATCH requests, so file
    // uploads are always sent as POST with a _method override field the backend
    // reads to determine the real verb.
    if (method !== 'GET' && method !== 'POST') {
      body.append('_method', method);
      fetchMethod = 'POST';
    }
    fetchBody = body; // let the browser set Content-Type with the multipart boundary
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(body);
  }
  const res = await fetch(API + path, { method: fetchMethod, headers, body: fetchBody, credentials: 'same-origin' });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty response body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ========== BUTTON LOADING STATE ==========
// Wraps a button's click handler so it shows a spinner + disables itself while its async work runs
// (mainly an api() call) - without this, a click that hits the database now has to cross the
// internet, not localhost, and just looks like nothing happened until the response lands. Also
// doubles as a guard against duplicate submissions from an impatient extra click.
function withLoadingClick(btnOrId, fn) {
  const btn = typeof btnOrId === 'string' ? document.getElementById(btnOrId) : btnOrId;
  if (!btn) return;
  btn.addEventListener('click', async (...args) => {
    if (btn.classList.contains('btn-loading')) return;
    // lock the button's current size before its content is removed, so it doesn't collapse
    // down to just its padding while the spinner is the only thing left inside it
    const rect = btn.getBoundingClientRect();
    btn.style.width = rect.width + 'px';
    btn.style.height = rect.height + 'px';
    // button content is often a bare text node next to an <svg> icon - CSS can't target a text
    // node directly, so wrap everything in one <span> the first time so it can be hidden as a unit
    if (!btn.querySelector(':scope > .btn-label')) {
      const label = document.createElement('span');
      label.className = 'btn-label';
      while (btn.firstChild) label.appendChild(btn.firstChild);
      btn.appendChild(label);
    }
    btn.classList.add('btn-loading');
    btn.disabled = true;
    try {
      await fn(...args);
    } finally {
      btn.classList.remove('btn-loading');
      btn.disabled = false;
      btn.style.width = '';
      btn.style.height = '';
    }
  });
}

// ========== TOAST ==========
function toast(message, type = '') {
  const wrap = document.getElementById('toastWrap');
  const el = document.createElement('div');
  el.className = `toast ${type}`.trim();
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ========== AUTH ==========
// Authorization is enforced server-side by the PHP session cookie; the cached user
// here is only for painting the UI without an extra round trip on load.
function saveSession(user) {
  currentUser = user;
  localStorage.setItem('vta_user', JSON.stringify(user));
}
function clearSession() {
  currentUser = null;
  localStorage.removeItem('vta_user');
}

// Every cached list/flag below is scoped to whichever user was last logged in - stale data leaks
// across logins in this SPA (no full page reload) unless cleared here on every fresh enterApp().
function resetSessionCaches() {
  courseCache = [];
  studentCache = [];
  diaryEntriesCache = [];
  myLecturerRowsCache = null;
  eventsCache = [];
  batchOptionsCache = null;
  searchCache = null;
  closeSearchResults();
  if (adminDashRotateTimer) { clearInterval(adminDashRotateTimer); adminDashRotateTimer = null; }
  ['asgFilterCourse', 'exmFilterCourse', 'noteFilterCourse', 'ppFilterCourse', 'resFilterCourse', 'stuFilterCourse', 'attFilterCourse'].forEach(id => {
    const el = document.getElementById(id);
    if (el) delete el.dataset.loaded;
  });
  ['stuFilterBatch', 'attFilterBatch', 'dyBatch'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  currentDiaryBatch = '';
}

document.getElementById('loginPassToggle').addEventListener('click', () => {
  const input = document.getElementById('loginPass');
  const btn = document.getElementById('loginPassToggle');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  btn.querySelector('use').setAttribute('href', showing ? '#i-eye' : '#i-eye-off');
  btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
});

withLoadingClick('loginBtn', async () => {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPass').value;
  const errBox = document.getElementById('loginError');
  errBox.style.display = 'none';
  try {
    const data = await api('/auth/login', { method: 'POST', body: { email, password } });
    saveSession(data.user);
    enterApp();
  } catch (e) {
    errBox.textContent = e.message;
    errBox.style.display = 'block';
  }
});

function doLogout() {
  api('/auth/logout', { method: 'POST' }).catch(() => {});
  clearSession();
  document.getElementById('app').style.display = 'none';
  document.getElementById('loginPage').classList.add('open');
}
document.getElementById('logoutBtn').addEventListener('click', doLogout);
document.getElementById('sidebarLogoutBtn').addEventListener('click', doLogout);

function enterApp() {
  resetSessionCaches();
  document.getElementById('loginPage').classList.remove('open');
  document.getElementById('app').style.display = 'flex';
  const name = currentUser.name;
  const roleMap = { student: 'Student', instructor: 'Instructor', admin: 'Admin' };
  document.getElementById('userName').textContent = name;
  document.getElementById('userAvatar').textContent = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  document.getElementById('userRole').textContent = roleMap[currentUser.role] || 'Student';

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  document.getElementById('greeting').textContent = `${greet}, ${name}`;
  document.getElementById('welcomeMsg').textContent = currentUser.role === 'student'
    ? 'Enroll in courses, track progress, earn certificates.'
    : 'Manage students, courses, and system.';

  document.querySelectorAll('[data-roles]').forEach(el => {
    const allowed = el.dataset.roles.split(',');
    el.style.display = allowed.includes(currentUser.role) ? '' : 'none';
  });

  const isAdmin = currentUser.role === 'admin';
  document.getElementById('navMyCourses').innerHTML = isAdmin
    ? '<svg class="icon"><use href="#i-cap"/></svg> All Courses'
    : '<svg class="icon"><use href="#i-cap"/></svg> My Courses';
  document.getElementById('myCoursesHeading').textContent = isAdmin ? 'All Courses' : 'My Courses';
  document.getElementById('myCoursesSub').textContent = isAdmin ? 'Every course on the platform' : 'Enroll, learn, and earn certificates';

  document.getElementById('lecturesHeading').textContent = 'Lecturers';
  document.getElementById('lecturesSub').textContent = isAdmin ? 'Manage instructor accounts' : 'Lecturers teaching your course';

  const isStudent = currentUser.role === 'student';
  document.getElementById('studentsHeading').textContent = isStudent ? 'Classmates' : 'Student Management';
  document.getElementById('studentsSub').textContent = isStudent
    ? 'Students in your course and batch'
    : currentUser.role === 'instructor' ? 'Students in your course(s)' : 'All enrolled students';
  document.getElementById('attendanceHeading').textContent = isStudent ? 'My Attendance' : 'Attendance Sheet';
  document.getElementById('resultsHeading').textContent = isStudent ? 'My Results' : 'Results';

  go('dashboard');
}

// ========== NAVIGATION ==========
const pages = [...document.querySelectorAll('.page')];
const navLinks = [...document.querySelectorAll('.nav a')];

// ========== SKELETON LOADING ==========
// Shown the instant a page opens, replaced once its data arrives - the app now runs over the
// internet (not localhost) so requests have real latency worth covering with a placeholder.
function skelBar(w, h, style = '') {
  return `<span class="skeleton" style="display:block;width:${w};height:${h};border-radius:6px;${style}"></span>`;
}
function skeletonCards(containerId, count, wrapClass) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = Array.from({ length: count }, () => `
    <div class="${wrapClass}" aria-hidden="true">
      ${skelBar('44px', '44px', 'border-radius:50%;margin-bottom:12px')}
      ${skelBar('70%', '15px', 'margin-bottom:10px')}
      ${skelBar('95%', '11px', 'margin-bottom:6px')}
      ${skelBar('60%', '11px')}
    </div>`).join('');
}
function skeletonRows(containerId, count) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = Array.from({ length: count }, () => `
    <div class="assignment-item" aria-hidden="true">
      ${skelBar('45%', '15px', 'margin-bottom:10px')}
      ${skelBar('90%', '11px', 'margin-bottom:6px')}
      ${skelBar('65%', '11px')}
    </div>`).join('');
}
function skeletonMyCourseRows(containerId, count) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = Array.from({ length: count }, () => `
    <div class="my-course-item" aria-hidden="true">
      <div class="info">${skelBar('140px', '13px', 'margin-bottom:6px')}${skelBar('90px', '10px')}</div>
      ${skelBar('50px', '18px', 'border-radius:20px')}
    </div>`).join('');
}
function skeletonThreadRows(containerId, count) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = Array.from({ length: count }, () => `
    <div class="thread" aria-hidden="true">
      ${skelBar('55%', '14px', 'margin-bottom:8px')}
      ${skelBar('35%', '11px')}
    </div>`).join('');
}
function skeletonTableBody(containerId, rows, cols) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const cells = Array.from({ length: cols }, () => `<td>${skelBar('80%', '11px')}</td>`).join('');
  el.innerHTML = Array.from({ length: rows }, () => `<tr aria-hidden="true">${cells}</tr>`).join('');
}
function skeletonFullTable(containerId, rows, cols) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const headCells = Array.from({ length: cols }, () => `<th>${skelBar('70%', '10px')}</th>`).join('');
  const bodyCells = Array.from({ length: cols }, () => `<td>${skelBar('80%', '11px')}</td>`).join('');
  el.innerHTML = `<thead><tr>${headCells}</tr></thead><tbody>${Array.from({ length: rows }, () => `<tr aria-hidden="true">${bodyCells}</tr>`).join('')}</tbody>`;
}
const PAGE_SKELETONS = {
  dashboard: () => { skeletonMyCourseRows('dashMyCourses', 3); skeletonMyCourseRows('dashAnnouncements', 3); },
  mycourses: () => skeletonCards('myCourseList', 6, 'course'),
  courses: () => skeletonCards('courseList', 6, 'course'),
  students: () => skeletonCards('studentList', 6, 'student-card'),
  lectures: () => skeletonCards('lectureList', 6, 'student-card'),
  attendance: () => skeletonFullTable('attendanceTable', 6, 6),
  assignments: () => skeletonRows('assignmentList', 4),
  exams: () => skeletonRows('examList', 4),
  results: () => skeletonTableBody('resultsModuleBody', 4, 4),
  timetable: () => skeletonTableBody('timetableBody', 5, 5),
  notes: () => skeletonRows('noteList', 4),
  pastpapers: () => skeletonRows('pastPaperList', 4),
  certificates: () => skeletonCards('myCertificatesList', 3, 'certificate-card'),
  forum: () => skeletonThreadRows('forumThreads', 4),
  career: () => skeletonCards('careerList', 3, 'job'),
  events: () => skeletonCards('eventList', 6, 'event-card'),
};

const pageRenderers = {
  dashboard: renderDashboard,
  mycourses: renderMyCourses,
  courses: renderCourseCatalogue,
  students: () => (currentUser.role === 'student' ? renderStudentClassmates() : renderStudents()),
  lectures: () => {
    if (currentUser.role === 'admin') return renderAdminLecturers();
    if (currentUser.role === 'instructor') return renderInstructorLecturerDirectory();
    return renderStudentLecturerDirectory();
  },
  attendance: () => (currentUser.role === 'student' ? renderStudentAttendance() : renderAttendance()),
  diary: () => (currentUser.role === 'student' ? renderStudentDiary() : renderDiary()),
  assignments: renderAssignments,
  exams: renderExams,
  results: renderResultsModule,
  timetable: renderTimetable,
  notes: () => renderResourceList('notes'),
  pastpapers: () => renderResourceList('past_paper'),
  certificates: renderCertificates,
  forum: renderForum,
  career: renderCareer,
  events: renderEvents,
  profile: renderProfile,
};

function go(id) {
  pages.forEach(p => p.classList.toggle('active', p.id === id));
  navLinks.forEach(a => a.classList.toggle('active', a.dataset.page === id));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (window.innerWidth < 760) document.getElementById('sidebar').classList.remove('open');
  if (PAGE_SKELETONS[id]) PAGE_SKELETONS[id]();
  const renderer = pageRenderers[id];
  if (renderer) renderer().catch(e => toast(e.message, 'error'));
}
navLinks.forEach(a => a.addEventListener('click', () => go(a.dataset.page)));
document.querySelectorAll('[data-go]').forEach(el => el.addEventListener('click', () => go(el.dataset.go)));

document.getElementById('sidebarToggle').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));
document.getElementById('sidebarCloseBtn').addEventListener('click', () => document.getElementById('sidebar').classList.remove('open'));
document.getElementById('profileBtn').addEventListener('click', () => go('profile'));
document.getElementById('profileMiniBtn').addEventListener('click', () => go('profile'));
document.getElementById('notifBtn').addEventListener('click', () => toast('You have no new notifications.'));

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.close').forEach(btn => btn.addEventListener('click', () => btn.closest('.modal').classList.remove('open')));

// ========== CUSTOM DROPDOWN POPUP ==========
// Native <select> popups are drawn by the OS and don't reliably accept CSS (esp. on Windows), so the
// open state of every <select> in the app is replaced with a themed absolutely-positioned list here.
// The closed <select> box is left completely alone - it's already styled correctly - and every existing
// .value read/write, 'change' listener, .innerHTML population, and .disabled toggle throughout the app
// keeps working unchanged: this only intercepts the moment the popup would open and, on picking an
// option, sets the real <select>'s value and dispatches a real 'change' event so nothing else has to
// know this exists. Delegated at the document level, so it covers every select on every page/modal,
// including ones populated dynamically later, with zero per-select wiring.
let openSelectPopup = null;

function closeSelectPopup() {
  if (!openSelectPopup) return;
  openSelectPopup.popup.remove();
  openSelectPopup = null;
}

function positionSelectPopup(select, popup) {
  const r = select.getBoundingClientRect();
  popup.style.minWidth = `${r.width}px`;
  const spaceBelow = window.innerHeight - r.bottom;
  const openUpward = spaceBelow < 160 && r.top > spaceBelow;
  popup.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - popup.offsetWidth - 4))}px`;
  if (openUpward) popup.style.top = `${Math.max(4, r.top - popup.offsetHeight - 4)}px`;
  else popup.style.top = `${Math.min(r.bottom + 4, window.innerHeight - popup.offsetHeight - 4)}px`;
}

function openSelectPopupFor(select) {
  if (select.disabled || select.multiple || select.size > 1) return;
  closeSelectPopup();

  const popup = document.createElement('div');
  popup.className = 'select-popup';
  [...select.options].forEach((opt, i) => {
    const item = document.createElement('div');
    item.className = 'select-option' + (opt.disabled ? ' is-disabled' : '') + (i === select.selectedIndex ? ' is-selected' : '');
    item.textContent = opt.textContent;
    if (!opt.disabled) {
      item.addEventListener('click', () => {
        select.selectedIndex = i;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        select.dispatchEvent(new Event('input', { bubbles: true }));
        closeSelectPopup();
        select.focus();
      });
    }
    popup.appendChild(item);
  });

  document.body.appendChild(popup);
  positionSelectPopup(select, popup);
  openSelectPopup = { select, popup };
}

document.addEventListener('mousedown', e => {
  if (e.target.tagName === 'SELECT') {
    if (e.target.disabled || e.target.multiple || e.target.size > 1) return;
    e.preventDefault();
    if (openSelectPopup && openSelectPopup.select === e.target) closeSelectPopup();
    else openSelectPopupFor(e.target);
    e.target.focus();
    return;
  }
  if (openSelectPopup && !openSelectPopup.popup.contains(e.target)) closeSelectPopup();
});

document.addEventListener('keydown', e => {
  const el = document.activeElement;
  if (el && el.tagName === 'SELECT' && !el.disabled && !el.multiple && el.size <= 1) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (openSelectPopup && openSelectPopup.select === el) closeSelectPopup();
      else openSelectPopupFor(el);
      return;
    }
  }
  if (e.key === 'Escape') closeSelectPopup();
});

window.addEventListener('scroll', () => closeSelectPopup(), true);
window.addEventListener('resize', () => closeSelectPopup());

// ========== CONFIRM DIALOG ==========
function confirmDialog(message, { title = 'Please confirm', confirmText = 'Confirm' } = {}) {
  return new Promise(resolve => {
    document.getElementById('confirmModalTitle').textContent = title;
    document.getElementById('confirmModalMessage').textContent = message;
    const okBtn = document.getElementById('confirmModalOk');
    const cancelBtn = document.getElementById('confirmModalCancel');
    okBtn.textContent = confirmText;

    function cleanup(result) {
      closeModal('confirmModal');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    openModal('confirmModal');
  });
}

// ========== DARK MODE ==========
function applyDarkMode(on) {
  document.body.classList.toggle('dark-mode', on);
  localStorage.setItem('vta_dark_mode', on ? '1' : '0');
}
document.getElementById('darkToggle').addEventListener('click', () => applyDarkMode(!document.body.classList.contains('dark-mode')));
applyDarkMode(localStorage.getItem('vta_dark_mode') === '1');

// ========== SEARCH ==========
// Global autocomplete over assignments + exams. Data is fetched once per session (role-scoped by
// the API already) and cached, so keystrokes filter instantly instead of round-tripping every time.
let searchCache = null;
let searchDebounceTimer = null;
let searchCurrentResults = [];
let searchActiveIndex = 0;

async function ensureSearchCache() {
  if (searchCache) return searchCache;
  const [a, e] = await Promise.all([api('/assignments'), api('/exams')]);
  searchCache = { assignments: a.assignments, exams: e.exams };
  return searchCache;
}

function highlightMatch(text, q) {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx)) + '<mark>' + escapeHtml(text.slice(idx, idx + q.length)) + '</mark>' + escapeHtml(text.slice(idx + q.length));
}

function matchSearchItems(cache, q) {
  const needle = q.toLowerCase();
  const rank = item => {
    const t = item.title.toLowerCase();
    if (t.startsWith(needle)) return 0;
    if (t.includes(needle)) return 1;
    return 2;
  };
  const collect = (list, type) => list
    .filter(item => item.title.toLowerCase().includes(needle)
      || (item.course_name || '').toLowerCase().includes(needle)
      || (item.module || '').toLowerCase().includes(needle))
    .map(item => ({ type, item, rank: rank(item) }));
  return [...collect(cache.assignments, 'assignment'), ...collect(cache.exams, 'exam')]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 8);
}

function closeSearchResults() {
  const box = document.getElementById('searchResults');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  searchCurrentResults = [];
  searchActiveIndex = 0;
}

function updateActiveSearchResult() {
  document.querySelectorAll('.search-result-item').forEach((el, i) => el.classList.toggle('active', i === searchActiveIndex));
}

function renderSearchResults(results, q) {
  const box = document.getElementById('searchResults');
  if (!results.length) {
    box.innerHTML = `<div class="search-state">No assignments or exams match &ldquo;${escapeHtml(q)}&rdquo;</div>`;
    box.style.display = 'block';
    return;
  }
  box.innerHTML = results.map((r, i) => {
    const meta = [r.item.course_name, r.item.module].filter(Boolean).map(escapeHtml).join(' &middot; ');
    return `
      <div class="search-result-item${i === 0 ? ' active' : ''}" data-result-index="${i}">
        <div class="search-result-icon ${r.type}"><svg class="icon sm"><use href="#${r.type === 'assignment' ? 'i-list' : 'i-flag'}"/></svg></div>
        <div class="search-result-info">
          <b>${highlightMatch(r.item.title, q)}</b>
          <small>${r.type === 'assignment' ? 'Assignment' : 'Exam'}${meta ? ' &middot; ' + meta : ''}</small>
        </div>
      </div>`;
  }).join('');
  box.style.display = 'block';
  box.querySelectorAll('.search-result-item').forEach((el, i) => {
    el.addEventListener('click', () => selectSearchResult(results[i]));
  });
}

async function runSearch(q) {
  const box = document.getElementById('searchResults');
  box.innerHTML = '<div class="search-state">Searching&hellip;</div>';
  box.style.display = 'block';
  try {
    const cache = await ensureSearchCache();
    // the input may have changed (or been cleared) while that first fetch was in flight
    if (document.getElementById('search').value.trim().toLowerCase() !== q) return;
    searchCurrentResults = matchSearchItems(cache, q);
    searchActiveIndex = 0;
    renderSearchResults(searchCurrentResults, q);
  } catch (e) {
    box.innerHTML = `<div class="search-state">${escapeHtml(e.message)}</div>`;
  }
}

function resetListFilters(courseSelId, moduleSelId, batchSelId) {
  const courseSel = document.getElementById(courseSelId);
  if (courseSel && courseSel.dataset.loaded && !courseSel.disabled) courseSel.value = '';
  const moduleSel = document.getElementById(moduleSelId);
  if (moduleSel && !moduleSel.disabled) moduleSel.value = '';
  const batchSel = document.getElementById(batchSelId);
  if (batchSel && !batchSel.disabled) batchSel.value = '';
}

function waitForElement(selector, timeoutMs = 5000) {
  return new Promise(resolve => {
    const start = Date.now();
    (function poll() {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(poll, 100);
    })();
  });
}

async function navigateAndHighlight(pageId, courseSelId, moduleSelId, batchSelId, dataAttr, itemId) {
  resetListFilters(courseSelId, moduleSelId, batchSelId);
  go(pageId);
  const el = await waitForElement(`[${dataAttr}="${itemId}"]`);
  if (!el) { toast('Could not locate that item - it may have been removed', 'error'); return; }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('search-highlight-flash');
  setTimeout(() => el.classList.remove('search-highlight-flash'), 1800);
}

function selectSearchResult(result) {
  closeSearchResults();
  const input = document.getElementById('search');
  input.value = '';
  input.blur();
  if (result.type === 'assignment') {
    navigateAndHighlight('assignments', 'asgFilterCourse', 'asgFilterModule', 'asgFilterBatch', 'data-assignment-id', result.item.id);
  } else {
    navigateAndHighlight('exams', 'exmFilterCourse', 'exmFilterModule', 'exmFilterBatch', 'data-exam-id', result.item.id);
  }
}

document.getElementById('search').addEventListener('input', e => {
  const q = e.target.value.trim().toLowerCase();
  clearTimeout(searchDebounceTimer);
  if (!q) { closeSearchResults(); return; }
  searchDebounceTimer = setTimeout(() => runSearch(q), 150);
});
document.getElementById('search').addEventListener('keydown', e => {
  const box = document.getElementById('searchResults');
  if (box.style.display !== 'block' || !searchCurrentResults.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    searchActiveIndex = Math.min(searchActiveIndex + 1, searchCurrentResults.length - 1);
    updateActiveSearchResult();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    searchActiveIndex = Math.max(searchActiveIndex - 1, 0);
    updateActiveSearchResult();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    selectSearchResult(searchCurrentResults[searchActiveIndex]);
  } else if (e.key === 'Escape') {
    closeSearchResults();
  }
});
document.addEventListener('click', e => {
  if (!document.getElementById('searchWrap').contains(e.target)) closeSearchResults();
});

// ========== DASHBOARD ==========
function setDashStat(n, icon, label, value, sub) {
  document.getElementById(`dashIcon${n}`).querySelector('use').setAttribute('href', `#${icon}`);
  document.getElementById(`dashLabel${n}`).textContent = label;
  document.getElementById(`dashSub${n}`).textContent = sub;
  const valueIds = { 1: 'dashEnrolled', 2: 'dashCompleted', 3: 'dashCertificates', 4: 'dashProgress' };
  document.getElementById(valueIds[n]).textContent = value;
}

async function renderDashboardAnnouncements() {
  try {
    const { threads } = await api('/forum/threads');
    const box = document.getElementById('dashAnnouncements');
    if (!threads.length) {
      box.innerHTML = '<p style="color:var(--muted);font-size:12px;">No announcements yet.</p>';
      return;
    }
    box.innerHTML = threads.slice(0, 5).map(t => `
      <div class="my-course-item">
        <div class="info"><h4>${escapeHtml(t.title)}</h4><small>${escapeHtml(t.author_name)} &middot; ${new Date(t.created_at).toLocaleDateString()}</small></div>
        <span class="badge blue">Announcement</span>
      </div>
    `).join('');
  } catch (e) { /* non-critical dashboard widget */ }
}

function renderRecentUploads(assignments, exams, subtextFn) {
  document.getElementById('dashCoursesHeading').textContent = 'Recent Uploads';
  const uploads = [
    ...assignments.map(a => ({ ...a, kind: 'Assignment' })),
    ...exams.map(e => ({ ...e, kind: 'Exam' })),
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 5);

  const box = document.getElementById('dashMyCourses');
  box.innerHTML = uploads.length ? uploads.map(u => `
    <div class="my-course-item" style="cursor:pointer" data-upload-kind="${u.kind}">
      <div class="info"><h4>${escapeHtml(u.title)}</h4><small>${escapeHtml(subtextFn(u))}</small></div>
      <span class="badge ${u.kind === 'Assignment' ? 'blue' : 'gold'}">${u.kind}</span>
    </div>
  `).join('') : '<p style="color:var(--muted);font-size:12px;">No assignments or exams uploaded yet.</p>';

  box.querySelectorAll('[data-upload-kind]').forEach(item => {
    item.addEventListener('click', () => go(item.dataset.uploadKind === 'Assignment' ? 'assignments' : 'exams'));
  });
}

async function renderDashboard() {
  renderDashboardAnnouncements();
  if (currentUser.role === 'admin') return renderAdminHomeDashboard();
  if (currentUser.role === 'instructor') return renderInstructorDashboard();

  const { courses: mine } = await api('/courses/mine');
  const course = mine[0] || null;

  if (!course) {
    setDashStat(1, 'i-book', 'My Courses', 'Not enrolled', '');
    setDashStat(2, 'i-users', 'Total Students', 0, 'In your course');
    setDashStat(3, 'i-board', 'Lecturers', 0, 'Teaching staff');
    setDashStat(4, 'i-clip', 'Attendance', '0%', 'This month');
    document.getElementById('dashCoursesHeading').textContent = 'Recent Uploads';
    document.getElementById('dashMyCourses').innerHTML = '<p style="color:var(--muted);font-size:12px;">No course enrolled yet.</p>';
    return;
  }

  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const [summary, { attendance }, { assignments }, { exams }] = await Promise.all([
    api(`/courses/${course.id}/summary`),
    api(`/attendance/mine?month=${monthKey}`),
    api(`/assignments?course_id=${course.id}`),
    api(`/exams?course_id=${course.id}`),
  ]);

  const presentCount = attendance.filter(a => a.status === 'P').length;
  const attendancePct = attendance.length ? Math.round((presentCount / attendance.length) * 100) : 0;

  setDashStat(1, 'i-book', 'My Courses', course.name, 'Enrolled');
  setDashStat(2, 'i-users', 'Total Students', summary.studentCount, 'In your batch');
  setDashStat(3, 'i-board', 'Lecturers', summary.lecturerCount, 'Teaching staff');
  setDashStat(4, 'i-clip', 'Attendance', attendancePct + '%', 'This month');

  renderRecentUploads(assignments, exams, u => `${u.course_name || 'No course'} · ${new Date(u.created_at).toLocaleDateString()}`);
}

// Highest-numbered batch value per course id, e.g. Map { 3 => '2026' } - same "highest number = latest
// year" rule used for the Assignments/Exams/Results batch filters. Courses with no students yet are absent.
function latestBatchPerCourse(students) {
  const byCourse = new Map();
  students.forEach(s => {
    if (!s.course_id || !s.batch) return;
    if (!byCourse.has(s.course_id)) byCourse.set(s.course_id, []);
    byCourse.get(s.course_id).push(s.batch);
  });
  const result = new Map();
  byCourse.forEach((batchList, courseId) => {
    const unique = [...new Set(batchList)];
    const numeric = unique.filter(b => !isNaN(Number(b))).sort((a, b) => Number(b) - Number(a));
    const nonNumeric = unique.filter(b => isNaN(Number(b))).sort();
    result.set(courseId, numeric[0] || nonNumeric[0]);
  });
  return result;
}

async function renderInstructorDashboard() {
  const [{ lecturers }, { students }, { assignments }, { exams }] = await Promise.all([
    api('/lecturers'), api('/students'), api('/assignments'), api('/exams'),
  ]);

  const myCourseIds = [...new Set(
    lecturers.filter(l => l.user_id === currentUser.id).map(l => l.course_id).filter(id => id != null)
  )];
  const latestByCourse = latestBatchPerCourse(students.filter(s => myCourseIds.includes(s.course_id)));
  // "Untagged" assignments/exams (batch = NULL) apply to everyone, same rule used to show them to students.
  const currentStudentCount = students.filter(s => myCourseIds.includes(s.course_id) && s.batch === latestByCourse.get(s.course_id)).length;
  const currentAssignments = assignments.filter(a => !a.batch || a.batch === latestByCourse.get(a.course_id));
  const currentExams = exams.filter(e => !e.batch || e.batch === latestByCourse.get(e.course_id));
  const peerLecturerCount = lecturers.filter(l => myCourseIds.includes(l.course_id)).length;

  setDashStat(1, 'i-users', 'Total Students', currentStudentCount, 'Current batch');
  setDashStat(2, 'i-pen', 'Assignments', currentAssignments.length, 'Current batch');
  setDashStat(3, 'i-board', 'Total Lecturers', peerLecturerCount, 'Same course');
  setDashStat(4, 'i-cal', 'Exams', currentExams.length, 'Current batch');

  renderRecentUploads(assignments, exams, u => `${u.course_name || 'No course'} · ${new Date(u.created_at).toLocaleDateString()}`);
}

// Admin "Total Student" stat rotates every 10s through each course, showing that course's own
// latest-batch student count (not a system-wide total across every course and every intake year).
function computeCourseBatchStats(students, courses) {
  const latestByCourse = latestBatchPerCourse(students);
  const courseNameById = new Map(courses.map(c => [c.id, c.name]));
  const stats = [];
  latestByCourse.forEach((batch, courseId) => {
    const count = students.filter(s => s.course_id === courseId && s.batch === batch).length;
    stats.push({ courseName: courseNameById.get(courseId) || 'Unknown Course', batch, count });
  });
  return stats;
}

async function renderAdminHomeDashboard() {
  const [{ students }, { courses }, { lecturers }, { events }, { assignments }, { exams }] = await Promise.all([
    api('/students'), api('/courses'), api('/lecturers'), api('/events'), api('/assignments'), api('/exams'),
  ]);

  const courseBatchStats = computeCourseBatchStats(students, courses);
  let rotateIndex = 0;
  function showRotatingStudentStat() {
    if (!courseBatchStats.length) { setDashStat(1, 'i-users', 'Total Student', 0, 'Registered'); return; }
    const s = courseBatchStats[rotateIndex % courseBatchStats.length];
    rotateIndex++;
    setDashStat(1, 'i-users', 'Total Student', s.count, `${s.courseName} · ${s.batch} batch`);
  }
  clearInterval(adminDashRotateTimer);
  showRotatingStudentStat();
  adminDashRotateTimer = setInterval(showRotatingStudentStat, 5000);

  setDashStat(2, 'i-board', 'Total Lectures', lecturers.length, 'Instructors');
  setDashStat(3, 'i-book', 'Total Course', courses.length, 'Available');
  setDashStat(4, 'i-calcheck', 'Total Events', events.length, 'Scheduled');

  const lecturerNames = {};
  lecturers.forEach(l => { if (l.user_id) lecturerNames[l.user_id] = l.name; });

  renderRecentUploads(assignments, exams, u => `${u.course_name || 'No course'} · ${lecturerNames[u.instructor_id] || 'Admin'} · ${new Date(u.created_at).toLocaleDateString()}`);
}

// ========== MY COURSES ==========
async function renderMyCourses() {
  if (currentUser.role === 'admin') return renderAllCoursesAdmin();
  if (currentUser.role === 'instructor') return renderInstructorCourses();
  return renderStudentCourses();
}

function renderCourseCatalogueSplit(courses, myCourseIds) {
  const courseCard = (c, assigned) => `
    <div class="course" data-course-id="${c.id}" style="cursor:pointer">
      <div class="course-icon">${courseIconHtml(c)}</div>
      <h3>${escapeHtml(c.name)}</h3>
      <span class="badge ${assigned ? 'green' : 'blue'}">${assigned ? 'Your Course' : escapeHtml(c.study_mode || 'Full Time')}</span>
      <span class="badge gold">${escapeHtml(c.qualification_type || 'NVQ-05')}</span>
      <p>${escapeHtml(c.description || 'No description provided.')}</p>
      <div class="course-foot">
        <span><svg class="icon sm"><use href="#i-clock"/></svg> ${formatDuration(c.duration)}</span>
        <span><svg class="icon sm"><use href="#i-board"/></svg> ${escapeHtml(c.instructor || 'Unassigned')}</span>
      </div>
    </div>
  `;

  const myCourses = courses.filter(c => myCourseIds.has(c.id));
  const otherCourses = courses.filter(c => !myCourseIds.has(c.id));

  let html = '';
  if (myCourses.length) {
    html += `<h3 style="grid-column:1/-1;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:0.6px">Your Course</h3>`;
    html += myCourses.map(c => courseCard(c, true)).join('');
  }
  html += `<h3 style="grid-column:1/-1;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:0.6px;margin-top:${myCourses.length ? '8px' : '0'}">Other Courses</h3>`;
  html += otherCourses.length
    ? otherCourses.map(c => courseCard(c, false)).join('')
    : '<p style="grid-column:1/-1;color:var(--muted);font-size:12px">No other courses yet.</p>';

  const container = document.getElementById('myCourseList');
  container.innerHTML = html;
  container.querySelectorAll('[data-course-id]').forEach(card => {
    card.addEventListener('click', () => openCourseDetailsModal(Number(card.dataset.courseId)));
  });
}

// ========== MY COURSES (Instructor) ==========
async function renderInstructorCourses() {
  const [{ courses }, { lecturers }] = await Promise.all([api('/courses'), api('/lecturers')]);
  courseCache = courses;

  document.getElementById('myCoursesHeading').textContent = 'My Courses';
  document.getElementById('myCoursesSub').textContent = 'The course you teach, plus the full course catalogue';

  const myCourseIds = new Set(lecturers.filter(l => l.user_id === currentUser.id).map(l => l.course_id));
  renderCourseCatalogueSplit(courses, myCourseIds);
}

// ========== MY COURSES (Student) ==========
async function renderStudentCourses() {
  const [{ courses }, { courses: mine }] = await Promise.all([api('/courses'), api('/courses/mine')]);
  courseCache = courses;

  document.getElementById('myCoursesHeading').textContent = 'My Courses';
  document.getElementById('myCoursesSub').textContent = 'Your enrolled course, plus the full course catalogue';

  renderCourseCatalogueSplit(courses, new Set(mine.map(c => c.id)));
}

async function openCourseDetailsModal(courseId) {
  const course = courseCache.find(c => c.id === courseId);
  if (!course) return;
  const { lecturers: courseLecturers } = await api(`/courses/${courseId}/lecturers`);

  const modulesHtml = course.qualification_type === 'Non-NVQ'
    ? `<p style="font-size:12px;margin-top:8px"><b>Modules:</b> ${formatModuleList(course.modules, false)}</p>`
    : `<p style="font-size:12px;margin-top:8px"><b>Semester 1:</b> ${formatModuleList(course.sem1_modules)}</p>
       <p style="font-size:12px;margin-top:4px"><b>Semester 2:</b> ${formatModuleList(course.sem2_modules)}</p>`;

  document.getElementById('courseDetailsBody').innerHTML = `
    <div class="course-icon" style="width:56px;height:56px;font-size:22px">
      ${courseIconHtml(course)}
    </div>
    <h2 style="margin-top:14px;font-size:19px">${escapeHtml(course.name)}</h2>
    <div style="display:flex;gap:8px;margin:10px 0;flex-wrap:wrap">
      <span class="badge blue">${escapeHtml(course.study_mode || 'Full Time')}</span>
      <span class="badge gold">${escapeHtml(course.qualification_type || 'NVQ-05')}</span>
      <span class="badge green"><svg class="icon sm"><use href="#i-clock"/></svg> ${formatDuration(course.duration)}</span>
    </div>
    <p style="color:var(--muted);font-size:13px">${escapeHtml(course.description || 'No description provided.')}</p>
    ${modulesHtml}
    <h3 style="font-size:13px;margin-top:18px;margin-bottom:10px">Lecturers in this Course</h3>
    ${courseLecturers.length ? `<div class="my-courses-grid">${courseLecturers.map(l => `
      <div class="my-course-item">
        <div class="info"><h4>${escapeHtml(l.name)}</h4><small>${formatModuleList(l.modules, false)}</small></div>
      </div>
    `).join('')}</div>` : '<p style="color:var(--muted);font-size:12px">No lecturers assigned yet.</p>'}
  `;
  openModal('courseDetailsModal');
}

// ========== ALL COURSES (Admin) ==========
async function renderAllCoursesAdmin() {
  const { courses } = await api('/courses');
  courseCache = courses;
  const container = document.getElementById('myCourseList');
  if (!courses.length) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <svg class="icon"><use href="#i-book"/></svg>
      <p>No courses added yet.</p>
    </div>`;
    return;
  }
  container.innerHTML = courses.map(c => `
    <div class="course">
      <div class="course-icon">${courseIconHtml(c)}</div>
      <h3>${escapeHtml(c.name)}</h3>
      <span class="badge blue">${escapeHtml(c.study_mode || 'Full Time')}</span>
      <span class="badge gold">${escapeHtml(c.qualification_type || 'NVQ-05')}</span>
      ${c.qualification_type === 'Non-NVQ'
        ? `<p><b>Modules:</b> ${formatModuleList(c.modules, false)}</p>`
        : `<p><b>Sem 1:</b> ${formatModuleList(c.sem1_modules)}<br><b>Sem 2:</b> ${formatModuleList(c.sem2_modules)}</p>`}
      <div class="course-foot">
        <span><svg class="icon sm"><use href="#i-clock"/></svg> ${formatDuration(c.duration)}</span>
        <span><svg class="icon sm"><use href="#i-board"/></svg> ${escapeHtml(c.instructor || 'Unassigned')}</span>
      </div>
      <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;">
        <button class="btn btn-outline-dark btn-sm" data-edit-course="${c.id}"><svg class="icon sm"><use href="#i-edit"/></svg> Edit</button>
        <button class="btn btn-red btn-sm" data-del-course="${c.id}"><svg class="icon sm"><use href="#i-trash"/></svg> Remove</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-edit-course]').forEach(btn => {
    btn.addEventListener('click', () => {
      const course = courses.find(x => x.id == btn.dataset.editCourse);
      if (course) openCourseModal(course);
    });
  });
  container.querySelectorAll('[data-del-course]').forEach(btn => {
    withLoadingClick(btn, async () => {
      const course = courses.find(x => x.id == btn.dataset.delCourse);
      const ok = await confirmDialog(
        `Remove "${course ? course.name : 'this course'}"? This also removes its enrollments and certificates.`,
        { title: 'Remove course?', confirmText: 'Remove' }
      );
      if (!ok) return;
      try {
        await api(`/courses/${btn.dataset.delCourse}`, { method: 'DELETE' });
        toast('Course removed', 'success');
        renderAllCoursesAdmin();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

function formatModuleList(json, withCode = true) {
  let list = [];
  try { list = JSON.parse(json || '[]'); } catch (e) { list = []; }
  if (!list.length) return '<span style="color:var(--muted)">None</span>';
  return list.map(m => escapeHtml(m.module) + (withCode && m.code ? ` (${escapeHtml(m.code)})` : '')).join(', ');
}

function courseIconHtml(course) {
  if (course.logo_url) return `<img src="${assetUrl(course.logo_url)}" alt="${escapeHtml(course.name)}" style="width:100%;height:100%;object-fit:cover;border-radius:12px">`;
  const initials = (course.name || '').split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  return escapeHtml(initials || 'QS');
}

function formatDuration(months) {
  if (!months) return 'Duration not set';
  return `${months} month${months === 1 ? '' : 's'}`;
}

function toggleCourseQualificationFields() {
  const isNvq = document.getElementById('crsQualification').value === 'NVQ-05';
  document.getElementById('crsNvqWrap').style.display = isNvq ? 'block' : 'none';
  document.getElementById('crsModulesWrap').style.display = isNvq ? 'none' : 'block';
}
document.getElementById('crsQualification').addEventListener('change', toggleCourseQualificationFields);

function addModuleRow(listId, module = '', code = '', withCode = true) {
  const row = document.createElement('div');
  row.className = 'module-row';
  row.innerHTML = `
    <input class="mod-name" placeholder="Module name" value="${escapeHtml(module)}">
    ${withCode ? `<input class="mod-code" placeholder="Code" value="${escapeHtml(code)}">` : ''}
    <button type="button" class="remove-module" title="Remove"><svg class="icon sm"><use href="#i-x"/></svg></button>
  `;
  row.querySelector('.remove-module').addEventListener('click', () => row.remove());
  document.getElementById(listId).appendChild(row);
}

function readModuleRows(listId) {
  return [...document.getElementById(listId).querySelectorAll('.module-row')].map(row => ({
    module: row.querySelector('.mod-name').value.trim(),
    code: row.querySelector('.mod-code') ? row.querySelector('.mod-code').value.trim() : '',
  }));
}

document.getElementById('crsSem1AddBtn').addEventListener('click', () => addModuleRow('crsSem1List'));
document.getElementById('crsSem2AddBtn').addEventListener('click', () => addModuleRow('crsSem2List'));
document.getElementById('crsModulesAddBtn').addEventListener('click', () => addModuleRow('crsModulesList', '', '', false));

function parseModuleJson(json) {
  try { const list = JSON.parse(json || '[]'); return Array.isArray(list) ? list : []; } catch (e) { return []; }
}

function openCourseModal(course = null) {
  document.getElementById('courseModalTitle').textContent = course ? 'Edit Course' : 'Add Course';
  document.getElementById('crsId').value = course ? course.id : '';
  document.getElementById('crsName').value = course ? course.name : '';
  document.getElementById('crsMode').value = course ? (course.study_mode || 'Full Time') : 'Full Time';
  document.getElementById('crsQualification').value = course ? (course.qualification_type || 'NVQ-05') : 'NVQ-05';
  document.getElementById('crsDuration').value = course && course.duration ? course.duration : '';
  document.getElementById('crsInstructor').value = course ? (course.instructor || '') : '';

  document.getElementById('crsLogo').value = '';
  const logoPreview = document.getElementById('crsLogoPreview');
  if (course && course.logo_url) { logoPreview.src = assetUrl(course.logo_url); logoPreview.style.display = 'block'; } else { logoPreview.style.display = 'none'; }

  document.getElementById('crsSem1List').innerHTML = '';
  document.getElementById('crsSem2List').innerHTML = '';
  document.getElementById('crsModulesList').innerHTML = '';

  const sem1 = course ? parseModuleJson(course.sem1_modules) : [];
  const sem2 = course ? parseModuleJson(course.sem2_modules) : [];
  const mods = course ? parseModuleJson(course.modules) : [];

  (sem1.length ? sem1 : [{ module: '', code: '' }]).forEach(m => addModuleRow('crsSem1List', m.module, m.code));
  (sem2.length ? sem2 : [{ module: '', code: '' }]).forEach(m => addModuleRow('crsSem2List', m.module, m.code));
  (mods.length ? mods : [{ module: '' }]).forEach(m => addModuleRow('crsModulesList', m.module, '', false));

  toggleCourseQualificationFields();
  openModal('courseModal');
}

document.getElementById('addCourseBtn').addEventListener('click', () => openCourseModal());

withLoadingClick('saveCourseBtn', async () => {
  const name = document.getElementById('crsName').value.trim();
  if (!name) { toast('Course name is required', 'error'); return; }

  const id = document.getElementById('crsId').value;
  const formData = new FormData();
  formData.append('name', name);
  formData.append('study_mode', document.getElementById('crsMode').value);
  formData.append('qualification_type', document.getElementById('crsQualification').value);
  formData.append('duration', document.getElementById('crsDuration').value);
  formData.append('sem1_modules', JSON.stringify(readModuleRows('crsSem1List')));
  formData.append('sem2_modules', JSON.stringify(readModuleRows('crsSem2List')));
  formData.append('modules', JSON.stringify(readModuleRows('crsModulesList')));
  formData.append('instructor', document.getElementById('crsInstructor').value.trim());
  const logoFile = document.getElementById('crsLogo').files[0];
  if (logoFile) formData.append('logo', logoFile);

  try {
    if (id) await api(`/courses/${id}`, { method: 'PUT', body: formData });
    else await api('/courses', { method: 'POST', body: formData });
    closeModal('courseModal');
    toast(id ? 'Course updated' : 'Course added', 'success');
    renderAllCoursesAdmin();
  } catch (e) { toast(e.message, 'error'); }
});

// ========== COURSE CATALOGUE ==========
async function renderCourseCatalogue() {
  const { courses } = await api('/courses');
  courseCache = courses;
  const container = document.getElementById('courseList');
  container.innerHTML = courses.map(c => `
    <div class="course">
      <div class="course-icon">${courseIconHtml(c)}</div>
      <h3>${escapeHtml(c.name)}</h3>
      <p>${escapeHtml(c.description || '')}</p>
      <div class="course-foot">
        <span>${formatDuration(c.duration)}</span>
        <span class="badge ${c.enrolled ? 'green' : 'gold'}">${c.enrolled ? 'Enrolled' : 'Available'}</span>
      </div>
      ${c.enrolled
        ? `<button class="btn btn-outline-dark" data-course="${c.id}" data-enrolled="true" style="margin-top:10px;width:100%;">Go to Course</button>`
        : currentUser.role === 'student'
          ? `<p style="margin-top:10px;font-size:11px;color:var(--muted);text-align:center">Ask an admin to assign you to this course.</p>`
          : `<button class="btn btn-gold" data-course="${c.id}" data-enrolled="false" style="margin-top:10px;width:100%;">Enroll Now</button>`}
    </div>
  `).join('');
  container.querySelectorAll('[data-course]').forEach(btn => {
    withLoadingClick(btn, async () => {
      if (btn.dataset.enrolled === 'true') { go('mycourses'); return; }
      try {
        await api(`/courses/${btn.dataset.course}/enroll`, { method: 'POST' });
        toast('Enrolled successfully!', 'success');
        renderCourseCatalogue();
      } catch (e) { toast(e.message, 'error'); }
    });
  });

  // populate assignment-course dropdown while we have fresh course data
  const asgCourse = document.getElementById('asgCourse');
  if (asgCourse) asgCourse.innerHTML = courses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

// ========== CERTIFICATES ==========
async function renderCertificates() {
  const { certificates } = await api('/certificates/mine');
  const container = document.getElementById('myCertificatesList');
  if (!certificates.length) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <svg class="icon"><use href="#i-cert"/></svg>
      <p>Complete a course to earn a certificate!</p>
    </div>`;
    return;
  }
  container.innerHTML = certificates.map(cert => `
    <div class="certificate-card">
      <div class="qr"></div>
      <span class="badge green">Verified</span>
      <h3 style="font-size:16px;margin-top:10px;">${escapeHtml(cert.course_name)}</h3>
      <p style="font-size:11px;color:var(--muted);">Issued to: <b>${escapeHtml(cert.student_name)}</b></p>
      <p style="font-size:11px;color:var(--muted);">Date: ${cert.issued_at.slice(0, 10)}</p>
      <p class="cert-id">Certificate ID: ${cert.cert_code}</p>
      <button class="btn btn-gold btn-sm" style="margin-top:10px;" onclick="window.print()"><svg class="icon sm"><use href="#i-print"/></svg> Print</button>
    </div>
  `).join('');
}

// ========== STUDENTS ==========
async function populateStudentFilterBar() {
  if (!courseCache.length) { const r = await api('/courses'); courseCache = r.courses; }
  const courseSel = document.getElementById('stuFilterCourse');
  const batchSel = document.getElementById('stuFilterBatch');

  const { batches, latest } = await getBatchOptions();
  populateBatchSelect(batchSel, batches, latest, batchSel.value);

  let availableCourses = courseCache;
  if (currentUser.role === 'instructor') {
    const myRows = await getMyLecturerRows();
    const myCourseIds = new Set(myRows.map(l => l.course_id));
    availableCourses = courseCache.filter(c => myCourseIds.has(c.id));
  }

  if (currentUser.role !== 'admin' && availableCourses.length === 1) {
    courseSel.innerHTML = `<option value="${availableCourses[0].id}">${escapeHtml(availableCourses[0].name)}</option>`;
    courseSel.disabled = true;
    return;
  }

  courseSel.disabled = false;
  courseSel.innerHTML = '<option value="">All Courses</option>' +
    availableCourses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}
document.getElementById('stuFilterCourse').addEventListener('change', renderStudents);
document.getElementById('stuFilterBatch').addEventListener('change', renderStudents);

async function renderStudents() {
  const filterBar = document.getElementById('stuFilterCourse');
  if (!filterBar.dataset.loaded) {
    await populateStudentFilterBar();
    filterBar.dataset.loaded = 'true';
  }
  const params = new URLSearchParams();
  if (filterBar.value) params.set('course_id', filterBar.value);
  const batchValue = document.getElementById('stuFilterBatch').value;
  if (batchValue) params.set('batch', batchValue);

  const { students } = await api(`/students?${params.toString()}`);
  studentCache = students;
  if (!students.length) {
    document.getElementById('studentList').innerHTML = '<p style="color:var(--muted);font-size:12px;grid-column:1/-1">No students match this filter.</p>';
    return;
  }
  document.getElementById('studentList').innerHTML = students.map(s => `
    <div class="student-card">
      <div class="row">
        ${s.photo_url
          ? `<img class="avatar-lg" src="${assetUrl(s.photo_url)}" alt="${escapeHtml(s.name)}">`
          : `<div class="avatar-lg">${s.name.split(' ').map(w => w[0]).join('').slice(0, 2)}</div>`}
        <div>
          <b>${escapeHtml(s.name)}</b><br>
          <small style="color:var(--muted)">${escapeHtml(s.batch)}${s.mis_no ? ' &middot; MIS: ' + escapeHtml(s.mis_no) : ''}</small><br>
          <small style="color:var(--muted)">${s.course_name ? '<svg class="icon sm"><use href="#i-book"/></svg> ' + escapeHtml(s.course_name) : 'Not enrolled'}</small>
        </div>
      </div>
      ${currentUser.role === 'admin' ? `
      <div class="actions">
        <button class="btn btn-outline-dark btn-sm" data-edit="${s.id}"><svg class="icon sm"><use href="#i-edit"/></svg> Edit</button>
        <button class="btn btn-red btn-sm" data-del="${s.id}"><svg class="icon sm"><use href="#i-trash"/></svg> Remove</button>
      </div>` : ''}
    </div>
  `).join('');

  document.querySelectorAll('#studentList [data-edit]').forEach(btn => {
    withLoadingClick(btn, async () => {
      const s = students.find(x => x.id == btn.dataset.edit);
      document.getElementById('studentModalTitle').textContent = 'Edit Student';
      document.getElementById('stId').value = s.id;
      document.getElementById('stName').value = s.name;
      document.getElementById('stMis').value = s.mis_no || '';
      document.getElementById('stNic').value = s.nic || '';
      document.getElementById('stBatch').value = s.batch;
      document.getElementById('stPhoto').value = '';
      const preview = document.getElementById('stPhotoPreview');
      if (s.photo_url) { preview.src = assetUrl(s.photo_url); preview.style.display = 'block'; } else { preview.style.display = 'none'; }
      document.getElementById('stCredentialsWrap').style.display = 'none';
      if (currentUser.role === 'admin') {
        if (!courseCache.length) { const r = await api('/courses'); courseCache = r.courses; }
        document.getElementById('stCourse').innerHTML = courseCache.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
        if (s.course_id) document.getElementById('stCourse').value = s.course_id;
        document.getElementById('stCourseWrap').style.display = 'block';
      } else {
        document.getElementById('stCourseWrap').style.display = 'none';
      }
      openModal('studentModal');
    });
  });
  document.querySelectorAll('#studentList [data-del]').forEach(btn => {
    withLoadingClick(btn, async () => {
      if (!(await confirmDialog('Remove this student?', { title: 'Remove student?', confirmText: 'Remove' }))) return;
      try { await api(`/students/${btn.dataset.del}`, { method: 'DELETE' }); renderStudents(); } catch (e) { toast(e.message, 'error'); }
    });
  });
}

// ========== STUDENTS (Classmates view, view-only) ==========
async function renderStudentClassmates() {
  const { courses: mine } = await api('/courses/mine');
  const course = mine[0] || null;
  const container = document.getElementById('studentList');

  if (!course) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <svg class="icon sm"><use href="#i-users"/></svg>
      <p>No course enrolled yet.</p>
    </div>`;
    return;
  }

  const { students } = await api(`/courses/${course.id}/students`);
  if (!students.length) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <svg class="icon sm"><use href="#i-users"/></svg>
      <p>No other students found for your course and batch.</p>
    </div>`;
    return;
  }
  container.innerHTML = students.map(s => `
    <div class="student-card">
      <div class="row">
        ${s.photo_url
          ? `<img class="avatar-lg" src="${assetUrl(s.photo_url)}" alt="${escapeHtml(s.name)}">`
          : `<div class="avatar-lg">${s.name.split(' ').map(w => w[0]).join('').slice(0, 2)}</div>`}
        <div>
          <b>${escapeHtml(s.name)}</b><br>
          <small style="color:var(--muted)">${escapeHtml(s.batch)}${s.mis_no ? ' &middot; MIS: ' + escapeHtml(s.mis_no) : ''}</small><br>
          <small style="color:var(--muted)"><svg class="icon sm"><use href="#i-book"/></svg> ${escapeHtml(course.name)}</small>
        </div>
      </div>
    </div>
  `).join('');
}

withLoadingClick('addStudentBtn', async () => {
  if (!courseCache.length) { const r = await api('/courses'); courseCache = r.courses; }
  document.getElementById('stCourse').innerHTML = courseCache.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');

  document.getElementById('studentModalTitle').textContent = 'Add Student';
  document.getElementById('stId').value = '';
  document.getElementById('stName').value = '';
  document.getElementById('stMis').value = '';
  document.getElementById('stNic').value = '';
  document.getElementById('stBatch').value = '';
  document.getElementById('stEmail').value = '';
  document.getElementById('stPassword').value = '';
  document.getElementById('stPhoto').value = '';
  document.getElementById('stPhotoPreview').style.display = 'none';
  document.getElementById('stCourseWrap').style.display = 'block';
  document.getElementById('stCredentialsWrap').style.display = 'block';
  openModal('studentModal');
});

withLoadingClick('saveStudentBtn', async () => {
  const id = document.getElementById('stId').value;
  const name = document.getElementById('stName').value.trim();
  if (!name) { toast('Name is required', 'error'); return; }

  const formData = new FormData();
  formData.append('name', name);
  formData.append('mis_no', document.getElementById('stMis').value.trim());
  formData.append('nic', document.getElementById('stNic').value.trim());
  formData.append('batch', document.getElementById('stBatch').value);
  const photoFile = document.getElementById('stPhoto').files[0];
  if (photoFile) formData.append('photo', photoFile);

  if (!id) {
    const email = document.getElementById('stEmail').value.trim();
    const password = document.getElementById('stPassword').value;
    if (!email || !password) { toast('Username/email and password are required for a new student', 'error'); return; }
    formData.append('course_id', document.getElementById('stCourse').value);
    formData.append('email', email);
    formData.append('password', password);
  } else if (currentUser.role === 'admin' && document.getElementById('stCourseWrap').style.display !== 'none') {
    formData.append('course_id', document.getElementById('stCourse').value);
  }

  try {
    if (id) await api(`/students/${id}`, { method: 'PUT', body: formData });
    else await api('/students', { method: 'POST', body: formData });
    closeModal('studentModal');
    toast('Student saved', 'success');
    renderStudents();
  } catch (e) { toast(e.message, 'error'); }
});

// ========== LECTURERS (Student: view-only, same course) ==========
async function renderStudentLecturerDirectory() {
  const { courses: mine } = await api('/courses/mine');
  const course = mine[0] || null;
  const container = document.getElementById('lectureList');

  if (!course) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <svg class="icon sm"><use href="#i-board"/></svg>
      <p>No course enrolled yet.</p>
    </div>`;
    return;
  }

  const { lecturers } = await api(`/courses/${course.id}/lecturers`);
  if (!lecturers.length) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <svg class="icon sm"><use href="#i-board"/></svg>
      <p>No lecturers found for your course.</p>
    </div>`;
    return;
  }
  container.innerHTML = lecturers.map(l => `
    <div class="student-card">
      <div class="row">
        <div class="avatar-lg">${l.name.split(' ').map(w => w[0]).join('').slice(0, 2)}</div>
        <div>
          <b>${escapeHtml(l.name)}</b><br>
          <small style="color:var(--muted)">${escapeHtml(course.name)}</small><br>
          <small style="color:var(--muted)">${formatModuleList(l.modules, true)}</small>
        </div>
      </div>
    </div>
  `).join('');
}

// ========== LECTURERS (Instructor: view-only, same course) ==========
async function renderInstructorLecturerDirectory() {
  const { lecturers } = await api('/lecturers');
  const myCourseIds = new Set(lecturers.filter(l => l.user_id === currentUser.id).map(l => l.course_id));
  const peers = lecturers.filter(l => myCourseIds.has(l.course_id));

  const container = document.getElementById('lectureList');
  if (!peers.length) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <svg class="icon sm"><use href="#i-board"/></svg>
      <p>No lecturers found for your course.</p>
    </div>`;
    return;
  }
  container.innerHTML = peers.map(l => `
    <div class="student-card">
      <div class="row">
        ${l.photo_url
          ? `<img class="avatar-lg" src="${assetUrl(l.photo_url)}" alt="${escapeHtml(l.name)}">`
          : `<div class="avatar-lg">${l.name.split(' ').map(w => w[0]).join('').slice(0, 2)}</div>`}
        <div>
          <b>${escapeHtml(l.name)}</b><br>
          <small style="color:var(--muted)">${l.lecturer_id ? escapeHtml(l.lecturer_id) : 'No ID'}${l.course_name ? ' &middot; ' + escapeHtml(l.course_name) : ''}</small><br>
          <small style="color:var(--muted)">${formatModuleList(l.modules, true)}</small>
        </div>
      </div>
    </div>
  `).join('');
}

// ========== LECTURERS (Admin) ==========
let currentLecturerModuleOptions = [];

function computeCourseModuleOptions(course) {
  if (!course) return [];
  if (course.qualification_type === 'Non-NVQ') {
    return parseModuleJson(course.modules).map(m => ({ label: m.module, module: m.module, code: '' }));
  }
  const sem1 = parseModuleJson(course.sem1_modules).map(m => ({ label: `Sem 1: ${m.module}${m.code ? ' (' + m.code + ')' : ''}`, module: m.module, code: m.code }));
  const sem2 = parseModuleJson(course.sem2_modules).map(m => ({ label: `Sem 2: ${m.module}${m.code ? ' (' + m.code + ')' : ''}`, module: m.module, code: m.code }));
  return [...sem1, ...sem2];
}

function lecturerModuleSelectHtml(selectedIndex = -1) {
  if (!currentLecturerModuleOptions.length) {
    return `<option value="">No modules available for this course</option>`;
  }
  return currentLecturerModuleOptions.map((opt, i) =>
    `<option value="${i}" ${i === selectedIndex ? 'selected' : ''}>${escapeHtml(opt.label)}</option>`
  ).join('');
}

function addLecturerModuleRow(selectedModule = null) {
  let selectedIndex = -1;
  if (selectedModule) {
    selectedIndex = currentLecturerModuleOptions.findIndex(o => o.module === selectedModule.module && o.code === (selectedModule.code || ''));
  }
  const row = document.createElement('div');
  row.className = 'module-row';
  row.innerHTML = `
    <select class="lcr-mod-select" style="flex:1">${lecturerModuleSelectHtml(selectedIndex)}</select>
    <button type="button" class="remove-module" title="Remove"><svg class="icon sm"><use href="#i-x"/></svg></button>
  `;
  row.querySelector('.remove-module').addEventListener('click', () => row.remove());
  document.getElementById('lcrModulesList').appendChild(row);
}

function readLecturerModules() {
  return [...document.querySelectorAll('#lcrModulesList .lcr-mod-select')]
    .map(sel => currentLecturerModuleOptions[Number(sel.value)])
    .filter(Boolean);
}

document.getElementById('lcrCourse').addEventListener('change', () => {
  const courseId = document.getElementById('lcrCourse').value;
  const course = courseCache.find(c => c.id == courseId);
  currentLecturerModuleOptions = computeCourseModuleOptions(course);
  document.getElementById('lcrModulesList').innerHTML = '';
  addLecturerModuleRow();
});

document.getElementById('lcrModulesAddBtn').addEventListener('click', () => addLecturerModuleRow());

withLoadingClick('addLecturerBtn', async () => {
  if (!courseCache.length) { const r = await api('/courses'); courseCache = r.courses; }
  document.getElementById('lcrCourse').innerHTML = '<option value="">-- Select course --</option>' +
    courseCache.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');

  document.getElementById('lecturerModalTitle').textContent = 'Add Lecturer';
  document.getElementById('lcrId').value = '';
  document.getElementById('lcrName').value = '';
  document.getElementById('lcrLecId').value = '';
  document.getElementById('lcrCourse').value = '';
  currentLecturerModuleOptions = [];
  document.getElementById('lcrModulesList').innerHTML = '';
  document.getElementById('lcrEmail').value = '';
  document.getElementById('lcrPassword').value = '';
  document.getElementById('lcrPhoto').value = '';
  document.getElementById('lcrPhotoPreview').style.display = 'none';
  document.getElementById('lcrNewFieldsWrap').style.display = 'block';
  openModal('lecturerModal');
});

withLoadingClick('saveLecturerBtn', async () => {
  const id = document.getElementById('lcrId').value;
  const name = document.getElementById('lcrName').value.trim();
  if (!name) { toast('Name is required', 'error'); return; }

  const formData = new FormData();
  formData.append('name', name);
  formData.append('lecturer_id', document.getElementById('lcrLecId').value.trim());
  formData.append('course_id', document.getElementById('lcrCourse').value);
  formData.append('modules', JSON.stringify(readLecturerModules()));
  const photoFile = document.getElementById('lcrPhoto').files[0];
  if (photoFile) formData.append('photo', photoFile);

  if (!id) {
    const email = document.getElementById('lcrEmail').value.trim();
    const password = document.getElementById('lcrPassword').value;
    if (!email || !password) { toast('Username/email and password are required for a new lecturer', 'error'); return; }
    formData.append('email', email);
    formData.append('password', password);
  }

  try {
    if (id) await api(`/lecturers/${id}`, { method: 'PUT', body: formData });
    else await api('/lecturers', { method: 'POST', body: formData });
    closeModal('lecturerModal');
    toast(id ? 'Lecturer updated' : 'Lecturer added', 'success');
    renderAdminLecturers();
  } catch (e) { toast(e.message, 'error'); }
});

async function renderAdminLecturers() {
  if (!courseCache.length) { const r = await api('/courses'); courseCache = r.courses; }
  const { lecturers } = await api('/lecturers');
  const container = document.getElementById('lectureList');
  if (!lecturers.length) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <svg class="icon sm"><use href="#i-board"/></svg>
      <p>No lecturers added yet.</p>
    </div>`;
    return;
  }
  container.innerHTML = lecturers.map(l => `
    <div class="student-card">
      <div class="row">
        ${l.photo_url
          ? `<img class="avatar-lg" src="${assetUrl(l.photo_url)}" alt="${escapeHtml(l.name)}">`
          : `<div class="avatar-lg">${l.name.split(' ').map(w => w[0]).join('').slice(0, 2)}</div>`}
        <div>
          <b>${escapeHtml(l.name)}</b><br>
          <small style="color:var(--muted)">${l.lecturer_id ? escapeHtml(l.lecturer_id) : 'No ID'}${l.course_name ? ' &middot; ' + escapeHtml(l.course_name) : ''}</small><br>
          <small style="color:var(--muted)">${formatModuleList(l.modules, true)}</small>
        </div>
      </div>
      <div class="actions">
        <button class="btn btn-outline-dark btn-sm" data-edit-lecturer="${l.id}"><svg class="icon sm"><use href="#i-edit"/></svg> Edit</button>
        <button class="btn btn-red btn-sm" data-del-lecturer="${l.id}"><svg class="icon sm"><use href="#i-trash"/></svg> Remove</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-edit-lecturer]').forEach(btn => {
    btn.addEventListener('click', () => {
      const l = lecturers.find(x => x.id == btn.dataset.editLecturer);
      if (l) openLecturerEditModal(l);
    });
  });
  container.querySelectorAll('[data-del-lecturer]').forEach(btn => {
    withLoadingClick(btn, async () => {
      const l = lecturers.find(x => x.id == btn.dataset.delLecturer);
      const ok = await confirmDialog(
        `Remove "${l ? l.name : 'this lecturer'}"? Their login account stays but the lecturer profile is deleted.`,
        { title: 'Remove lecturer?', confirmText: 'Remove' }
      );
      if (!ok) return;
      try {
        await api(`/lecturers/${btn.dataset.delLecturer}`, { method: 'DELETE' });
        toast('Lecturer removed', 'success');
        renderAdminLecturers();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

function openLecturerEditModal(l) {
  document.getElementById('lcrCourse').innerHTML = '<option value="">-- Select course --</option>' +
    courseCache.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');

  document.getElementById('lecturerModalTitle').textContent = 'Edit Lecturer';
  document.getElementById('lcrId').value = l.id;
  document.getElementById('lcrName').value = l.name;
  document.getElementById('lcrLecId').value = l.lecturer_id || '';
  document.getElementById('lcrCourse').value = l.course_id || '';

  const course = courseCache.find(c => c.id == l.course_id);
  currentLecturerModuleOptions = computeCourseModuleOptions(course);
  document.getElementById('lcrModulesList').innerHTML = '';
  const existingModules = parseModuleJson(l.modules);
  if (existingModules.length) existingModules.forEach(m => addLecturerModuleRow(m));
  else addLecturerModuleRow();

  document.getElementById('lcrPhoto').value = '';
  const preview = document.getElementById('lcrPhotoPreview');
  if (l.photo_url) { preview.src = assetUrl(l.photo_url); preview.style.display = 'block'; } else { preview.style.display = 'none'; }
  document.getElementById('lcrNewFieldsWrap').style.display = 'none';
  openModal('lecturerModal');
}

// ========== ATTENDANCE ==========
const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayNames = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
let attCurrentMonth = new Date().getMonth();
let attCurrentYear = new Date().getFullYear();
let attData = {};

function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
function monthKey(y, m) { return `${y}-${String(m + 1).padStart(2, '0')}`; }
function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
document.getElementById('attToday').textContent = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

document.getElementById('attMonth').innerHTML = monthNames.map((m, i) => `<option value="${i}">${m} ${attCurrentYear}</option>`).join('');
document.getElementById('attMonth').value = attCurrentMonth;
document.getElementById('attMonth').addEventListener('change', () => {
  attCurrentMonth = Number(document.getElementById('attMonth').value);
  if (currentUser.role === 'student') renderStudentAttendance(); else renderAttendance();
});
function updateMarkAllPresentBtnState() {
  const btn = document.getElementById('markAllPresentBtn');
  const now = new Date();
  const isFuture = attCurrentYear > now.getFullYear() || (attCurrentYear === now.getFullYear() && attCurrentMonth > now.getMonth());
  const isCurrent = attCurrentYear === now.getFullYear() && attCurrentMonth === now.getMonth();
  btn.disabled = isCurrent || isFuture;
  btn.title = isCurrent
    ? "You can't mark all present for the current month"
    : isFuture
      ? "You can't mark all present for a future month"
      : '';
}

withLoadingClick('markAllPresentBtn', async () => {
  const ok = await confirmDialog(
    `Mark every student present for all weekdays in ${monthNames[attCurrentMonth]} ${attCurrentYear}?`,
    { title: 'Mark whole month present?', confirmText: 'Mark Present' }
  );
  if (!ok) return;
  try { await api('/attendance/mark-all-present', { method: 'POST', body: { month: monthKey(attCurrentYear, attCurrentMonth) } }); renderAttendance(); } catch (e) { toast(e.message, 'error'); }
});
document.getElementById('printAttBtn').addEventListener('click', () => {
  try { exportAttendanceToExcel(); } catch (e) { toast('Could not generate Excel file: ' + e.message, 'error'); }
});

// Admin-only filter bar: Course defaults to "All Courses", Batch defaults to the latest year.
async function populateAttendanceFilterBar() {
  if (!courseCache.length) { const r = await api('/courses'); courseCache = r.courses; }
  const courseSel = document.getElementById('attFilterCourse');
  const batchSel = document.getElementById('attFilterBatch');

  const { batches, latest } = await getBatchOptions();
  populateBatchSelect(batchSel, batches, latest, batchSel.value);

  courseSel.innerHTML = '<option value="">All Courses</option>' +
    courseCache.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}
document.getElementById('attFilterCourse').addEventListener('change', renderAttendance);
document.getElementById('attFilterBatch').addEventListener('change', renderAttendance);

async function renderAttendance() {
  const filterBar = document.getElementById('attFilterCourse');
  if (!filterBar.dataset.loaded) {
    await populateAttendanceFilterBar();
    filterBar.dataset.loaded = 'true';
  }
  const params = new URLSearchParams();
  if (filterBar.value) params.set('course_id', filterBar.value);
  const filterBatch = document.getElementById('attFilterBatch').value;
  if (filterBatch) params.set('batch', filterBatch);
  const { students } = await api(`/students?${params.toString()}`);
  studentCache = students;
  const mk = monthKey(attCurrentYear, attCurrentMonth);
  const { attendance } = await api(`/attendance?month=${mk}`);
  attData = {};
  attendance.forEach(r => { attData[`${r.student_id}_${r.date}`] = r.status; });

  document.getElementById('attMonth').value = attCurrentMonth;
  updateMarkAllPresentBtnState();
  document.getElementById('monthTabs').innerHTML = monthNames.map((m, i) =>
    `<button class="month-tab ${i === attCurrentMonth ? 'active' : ''}" data-month="${i}">${m.slice(0, 3)}</button>`
  ).join('');
  document.querySelectorAll('.month-tab').forEach(b => b.addEventListener('click', () => { attCurrentMonth = Number(b.dataset.month); renderAttendance(); }));

  const n = daysInMonth(attCurrentYear, attCurrentMonth);
  const first = new Date(attCurrentYear, attCurrentMonth, 1).getDay();
  let h = `<thead><tr><th class='sticky'>No</th><th class='sticky2'>Name</th>`;
  for (let d = 1; d <= n; d++) {
    const date = `${mk}-${String(d).padStart(2, '0')}`;
    const isFuture = date > todayDateStr();
    h += `<th class="att-day-head${isFuture ? '' : ' clickable'}" ${isFuture ? '' : `data-date="${date}"`} title="${isFuture ? '' : 'Click to mark the whole day'}">${dayNames[(first + d - 1) % 7]}<br>${d}</th>`;
  }
  h += '<th>Present</th><th>Absent</th><th>Rate</th></tr></thead><tbody>';

  let P = 0, A = 0, L = 0, total = 0;
  studentCache.forEach((s, i) => {
    let sp = 0, sa = 0, sl = 0;
    h += `<tr><td class="sticky">${i + 1}</td><td class="sticky2"><b>${escapeHtml(s.name)}</b></td>`;
    for (let d = 1; d <= n; d++) {
      const date = `${mk}-${String(d).padStart(2, '0')}`;
      const v = attData[`${s.id}_${date}`] || '';
      const isFuture = date > todayDateStr();
      if (v === 'P') sp++; if (v === 'A') sa++; if (v === 'L') sl++;
      if (v) { if (v === 'P') P++; if (v === 'A') A++; if (v === 'L') L++; total++; }
      h += `<td><div class="att-cell ${isFuture ? 'future' : (v || 'N')}" data-student="${s.id}" data-date="${date}" ${isFuture ? 'data-future="true"' : ''}>${isFuture ? '' : (v || '&middot;')}</div></td>`;
    }
    const marked = sp + sa + sl, rate = marked ? Math.round(sp / marked * 100) : 0;
    h += `<td><b>${sp}</b></td><td>${sa}</td><td><span class="badge ${rate >= 75 ? 'green' : rate >= 50 ? 'gold' : 'red'}">${rate}%</span></td></tr>`;
  });
  h += '</tbody>';
  document.getElementById('attendanceTable').innerHTML = h;
  document.getElementById('attPresent').textContent = P;
  document.getElementById('attAbsent').textContent = A;
  document.getElementById('attLeave').textContent = L;
  document.getElementById('attRate').textContent = total ? Math.round(P / total * 100) + '%' : '0%';

  document.querySelectorAll('.att-cell').forEach(cell => {
    cell.addEventListener('click', async () => {
      if (cell.dataset.future) { toast('Cannot mark attendance for a future date', 'error'); return; }
      const cur = cell.classList.contains('P') ? 'P' : cell.classList.contains('A') ? 'A' : cell.classList.contains('L') ? 'L' : '';
      const next = cur === '' ? 'P' : cur === 'P' ? 'A' : cur === 'A' ? 'L' : '';
      try {
        await api('/attendance', { method: 'PUT', body: { student_id: Number(cell.dataset.student), date: cell.dataset.date, status: next || null } });
        renderAttendance();
      } catch (e) { toast(e.message, 'error'); }
    });
  });

  document.querySelectorAll('.att-day-head.clickable').forEach(th => {
    th.addEventListener('click', () => openDayActionModal(th.dataset.date));
  });
}

// ========== ATTENDANCE (Student: same grid as admin, read-only, own row highlighted) ==========
async function renderStudentAttendance() {
  const attendanceTable = document.getElementById('attendanceTable');
  attendanceTable.classList.add('readonly');
  document.getElementById('attLegendClickHint').style.display = 'none';

  const { courses: mine } = await api('/courses/mine');
  const course = mine[0] || null;
  if (!course) {
    attendanceTable.innerHTML = '<tbody><tr><td style="color:var(--muted)">No course enrolled yet.</td></tr></tbody>';
    return;
  }
  const { students: classmates } = await api(`/courses/${course.id}/students`);

  const mk = monthKey(attCurrentYear, attCurrentMonth);
  const { attendance } = await api(`/attendance?month=${mk}`);
  const attData = {};
  attendance.forEach(r => { attData[`${r.student_id}_${r.date}`] = r.status; });

  document.getElementById('attMonth').value = attCurrentMonth;
  document.getElementById('monthTabs').innerHTML = monthNames.map((m, i) =>
    `<button class="month-tab ${i === attCurrentMonth ? 'active' : ''}" data-month="${i}">${m.slice(0, 3)}</button>`
  ).join('');
  document.querySelectorAll('.month-tab').forEach(b => b.addEventListener('click', () => { attCurrentMonth = Number(b.dataset.month); renderStudentAttendance(); }));

  const n = daysInMonth(attCurrentYear, attCurrentMonth);
  const first = new Date(attCurrentYear, attCurrentMonth, 1).getDay();
  let h = `<thead><tr><th class='sticky'>No</th><th class='sticky2'>Name</th>`;
  for (let d = 1; d <= n; d++) {
    const date = `${mk}-${String(d).padStart(2, '0')}`;
    h += `<th class="att-day-head">${dayNames[(first + d - 1) % 7]}<br>${d}</th>`;
  }
  h += '<th>P</th><th>A</th><th>Rate</th></tr></thead><tbody>';

  let myP = 0, myA = 0, myL = 0, myTotal = 0;
  classmates.forEach((s, i) => {
    let sp = 0, sa = 0, sl = 0;
    h += `<tr class="${s.is_me ? 'att-row-mine' : ''}"><td class="sticky">${i + 1}</td><td class="sticky2"><b>${escapeHtml(s.name)}</b>${s.is_me ? ' <span class="badge gold">You</span>' : ''}</td>`;
    for (let d = 1; d <= n; d++) {
      const date = `${mk}-${String(d).padStart(2, '0')}`;
      const v = attData[`${s.id}_${date}`] || '';
      const isFuture = date > todayDateStr();
      if (v === 'P') sp++; if (v === 'A') sa++; if (v === 'L') sl++;
      if (s.is_me && v) { if (v === 'P') myP++; if (v === 'A') myA++; if (v === 'L') myL++; myTotal++; }
      h += `<td><div class="att-cell ${isFuture ? 'future' : (v || 'N')}">${isFuture ? '' : (v || '&middot;')}</div></td>`;
    }
    const marked = sp + sa + sl, rate = marked ? Math.round(sp / marked * 100) : 0;
    h += `<td><b>${sp}</b></td><td>${sa}</td><td><span class="badge ${rate >= 75 ? 'green' : rate >= 50 ? 'gold' : 'red'}">${rate}%</span></td></tr>`;
  });
  h += '</tbody>';
  attendanceTable.innerHTML = h;
  document.getElementById('attPresent').textContent = myP;
  document.getElementById('attAbsent').textContent = myA;
  document.getElementById('attLeave').textContent = myL;
  document.getElementById('attRate').textContent = myTotal ? Math.round((myP / myTotal) * 100) + '%' : '0%';
}

function openDayActionModal(date) {
  document.getElementById('dayActionDate').textContent = new Date(date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  document.getElementById('dayActionModal').dataset.date = date;
  openModal('dayActionModal');
}

async function markWholeDay(status) {
  const date = document.getElementById('dayActionModal').dataset.date;
  try {
    await api('/attendance/mark-day', { method: 'POST', body: { date, status } });
    closeModal('dayActionModal');
    toast('Attendance updated for everyone', 'success');
    renderAttendance();
  } catch (e) { toast(e.message, 'error'); }
}
document.getElementById('dayActionPresent').addEventListener('click', () => markWholeDay('P'));
document.getElementById('dayActionAbsent').addEventListener('click', () => markWholeDay('A'));
document.getElementById('dayActionLeave').addEventListener('click', () => markWholeDay('L'));

// ========== ATTENDANCE EXCEL EXPORT ==========
// Minimal, dependency-free .xlsx writer: builds a real ZIP (STORED/uncompressed entries, so no
// deflate implementation is needed) containing the small set of OOXML parts Excel/Sheets/LibreOffice
// need for a single styled worksheet. Cell text is written as inline strings so no sharedStrings
// table is required either. This intentionally reuses none of renderAttendance()'s internals - it
// reads the already-rendered #attendanceTable DOM, so it works unchanged for whichever role/view
// (admin, instructor, or read-only student) happens to be on screen when export is triggered.
function crc32(bytes) {
  if (!crc32.table) {
    crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crc32.table[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = crc32.table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function zipStore(files) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  files.forEach(f => {
    const nameBytes = encoder.encode(f.name);
    const data = typeof f.data === 'string' ? encoder.encode(f.data) : f.data;
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);

    const centralHeader = new DataView(new ArrayBuffer(46));
    centralHeader.setUint32(0, 0x02014b50, true);
    centralHeader.setUint16(4, 20, true);
    centralHeader.setUint16(6, 20, true);
    centralHeader.setUint16(8, 0, true);
    centralHeader.setUint16(10, 0, true);
    centralHeader.setUint16(12, 0, true);
    centralHeader.setUint16(14, 0, true);
    centralHeader.setUint32(16, crc, true);
    centralHeader.setUint32(20, data.length, true);
    centralHeader.setUint32(24, data.length, true);
    centralHeader.setUint16(28, nameBytes.length, true);
    centralHeader.setUint16(30, 0, true);
    centralHeader.setUint16(32, 0, true);
    centralHeader.setUint16(34, 0, true);
    centralHeader.setUint16(36, 0, true);
    centralHeader.setUint32(38, 0, true);
    centralHeader.setUint32(42, offset, true);
    central.push(new Uint8Array(centralHeader.buffer), nameBytes);

    offset += 30 + nameBytes.length + data.length;
  });

  const centralStart = offset;
  let centralSize = 0;
  central.forEach(c => { centralSize += c.length; });

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralStart, true);
  eocd.setUint16(20, 0, true);

  const all = [...parts, ...central, new Uint8Array(eocd.buffer)];
  const totalLen = all.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(totalLen);
  let p = 0;
  all.forEach(a => { out.set(a, p); p += a.length; });
  return out;
}

function xlsxColLetter(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// rows: array of arrays of {v, s (styleIndex), n (numeric flag)}. merges: array of "A1:B2" refs.
function attendanceSheetXml(rows, merges, colWidths) {
  const colsXml = colWidths.length
    ? `<cols>${colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1" />`).join('')}</cols>`
    : '';
  const rowsXml = rows.map((row, ri) => {
    const cellsXml = row.map((cell, ci) => {
      if (cell == null || cell.v === undefined || cell.v === null || cell.v === '') {
        return cell && cell.s ? `<c r="${xlsxColLetter(ci + 1)}${ri + 1}" s="${cell.s}" />` : '';
      }
      const ref = `${xlsxColLetter(ci + 1)}${ri + 1}`;
      const sAttr = cell.s ? ` s="${cell.s}"` : '';
      if (cell.n) return `<c r="${ref}"${sAttr}><v>${cell.v}</v></c>`;
      return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${escapeHtml(String(cell.v))}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cellsXml}</row>`;
  }).join('');
  const mergesXml = merges.length ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}" />`).join('')}</mergeCells>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1" /></sheetPr>${colsXml}<sheetData>${rowsXml}</sheetData>${mergesXml}<pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4" header="0.2" footer="0.2" /><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0" /></worksheet>`;
}

function attendanceXlsxStyles() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="6">
<font><sz val="10" /><name val="Calibri" /></font>
<font><b /><sz val="10" /><name val="Calibri" /></font>
<font><b /><sz val="16" /><name val="Calibri" /></font>
<font><b /><sz val="12" /><name val="Calibri" /></font>
<font><b /><sz val="9" /><name val="Calibri" /></font>
<font><sz val="9" /><name val="Calibri" /></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none" /></fill>
<fill><patternFill patternType="gray125" /></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFBE9EE" /><bgColor indexed="64" /></patternFill></fill>
</fills>
<borders count="3">
<border><left /><right /><top /><bottom /><diagonal /></border>
<border><left style="thin"><color indexed="64" /></left><right style="thin"><color indexed="64" /></right><top style="thin"><color indexed="64" /></top><bottom style="thin"><color indexed="64" /></bottom><diagonal /></border>
<border><left /><right /><top /><bottom style="thin"><color indexed="64" /></bottom><diagonal /></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" /></cellStyleXfs>
<cellXfs count="13">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" />
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" /></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" /></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" />
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" />
<xf numFmtId="0" fontId="4" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1" /></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" /></xf>
<xf numFmtId="0" fontId="5" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" /></xf>
<xf numFmtId="0" fontId="5" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" /></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" /></xf>
<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1" />
<xf numFmtId="0" fontId="5" fillId="0" borderId="2" xfId="0" applyFont="1" applyBorder="1" />
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" />
</cellXfs>
</styleSheet>`;
}

function buildAttendanceXlsxBlob() {
  const table = document.getElementById('attendanceTable');
  const headThs = [...table.querySelectorAll('thead th')];
  const dayCount = headThs.length - 5; // No, Name, ...days..., Present/P, Absent/A, Rate
  const dayHeaders = headThs.slice(2, 2 + dayCount).map(th => {
    const [dow, num] = th.innerHTML.split('<br>');
    return { dow: (dow || '').trim(), num: (num || '').trim() };
  });

  const bodyRows = [...table.querySelectorAll('tbody tr')].map(tr => {
    const tds = [...tr.querySelectorAll('td')];
    const name = tds[1].querySelector('b')?.textContent.trim() || tds[1].textContent.trim();
    const days = tds.slice(2, 2 + dayCount).map(td => {
      const cell = td.querySelector('.att-cell');
      if (!cell || cell.classList.contains('future') || cell.classList.contains('N')) return '';
      if (cell.classList.contains('P')) return 1;
      if (cell.classList.contains('A')) return 0;
      if (cell.classList.contains('L')) return 'L';
      return '';
    });
    const rateText = tds[4 + dayCount].querySelector('.badge')?.textContent.trim() || tds[4 + dayCount].textContent.trim();
    return { name, days, present: tds[2 + dayCount].textContent.trim(), rate: rateText };
  });

  const courseSel = document.getElementById('attFilterCourse');
  const courseName = courseSel && courseSel.value ? courseSel.options[courseSel.selectedIndex].textContent : 'All Courses';
  const batchSel = document.getElementById('attFilterBatch');
  const batchLabel = batchSel && batchSel.value ? batchSel.value : '';
  const monthLabel = `${monthNames[attCurrentMonth]} ${attCurrentYear}`;
  const instructorName = currentUser.role === 'instructor' ? currentUser.name : '';

  const rows = [];
  const merges = [];
  const lastCol = 2 + dayCount + 2; // No, Name, ...days..., Total, Percentage

  rows.push([{ v: 'VOCATIONAL TRAINING AUTHORITY OF SRI LANKA', s: 1 }]);
  merges.push(`A1:${xlsxColLetter(lastCol)}1`);
  rows.push([{ v: 'TRAINEES ATTENDANCE SHEET', s: 2 }]);
  merges.push(`A2:${xlsxColLetter(lastCol)}2`);
  rows.push([{ v: `Name of Centre - Ninthavur${batchLabel ? ` · Batch ${batchLabel}` : ''}`, s: 3 }, ...Array(lastCol - 1).fill(null)]);
  merges.push(`A3:${xlsxColLetter(lastCol)}3`);
  rows.push([{ v: `Course - ${courseName}`, s: 3 }, ...Array(lastCol - 1).fill(null)]);
  merges.push(`A4:${xlsxColLetter(lastCol)}4`);
  rows.push([{ v: `Month - ${monthLabel}`, s: 3 }, ...Array(lastCol - 1).fill(null)]);
  merges.push(`A5:${xlsxColLetter(lastCol)}5`);
  rows.push([]);

  const headerRowIdx = rows.length;
  const dowRow = [{ v: 'No', s: 5 }, { v: 'Name With Initials', s: 5 }];
  const numRow = [{ v: '', s: 5 }, { v: '', s: 5 }];
  dayHeaders.forEach(d => { dowRow.push({ v: d.dow, s: 5 }); numRow.push({ v: d.num, s: 5 }); });
  dowRow.push({ v: 'Total', s: 5 }, { v: 'Percentage', s: 5 });
  numRow.push({ v: '', s: 5 }, { v: '', s: 5 });
  rows.push(dowRow, numRow);
  merges.push(`A${headerRowIdx + 1}:A${headerRowIdx + 2}`, `B${headerRowIdx + 1}:B${headerRowIdx + 2}`);
  merges.push(`${xlsxColLetter(lastCol - 1)}${headerRowIdx + 1}:${xlsxColLetter(lastCol - 1)}${headerRowIdx + 2}`);
  merges.push(`${xlsxColLetter(lastCol)}${headerRowIdx + 1}:${xlsxColLetter(lastCol)}${headerRowIdx + 2}`);

  const rateNums = [];
  bodyRows.forEach((r, i) => {
    const row = [{ v: i + 1, s: 7, n: true }, { v: r.name, s: 8 }];
    r.days.forEach(d => row.push({ v: d, s: 7, n: typeof d === 'number' }));
    row.push({ v: r.present, s: 9, n: true }, { v: r.rate, s: 9 });
    rows.push(row);
    const rn = parseFloat(r.rate);
    if (!isNaN(rn)) rateNums.push(rn);
  });

  const avgRate = rateNums.length ? (rateNums.reduce((a, b) => a + b, 0) / rateNums.length).toFixed(1) + '%' : '0%';
  const avgRow = [{ v: '', s: 9 }, { v: 'TOTAL Avg. Percentage', s: 9 }];
  for (let i = 0; i < dayCount; i++) avgRow.push({ v: '', s: 7 });
  avgRow.push({ v: '', s: 9 }, { v: avgRate, s: 9 });
  rows.push(avgRow);

  rows.push([]);
  const wdRowIdx = rows.length + 1;
  rows.push([{ v: `No of working days : ${dayCount}`, s: 3 }]);
  rows.push([]);
  const mid = Math.max(4, Math.floor(lastCol / 2));
  function signatureRow(leftLabel, rightLabel) {
    const row = new Array(lastCol).fill(null);
    row[0] = { v: leftLabel, s: 10 };
    row[1] = { v: '', s: 11 };
    row[mid] = { v: rightLabel, s: 10 };
    row[mid + 1] = { v: '', s: 11 };
    return row;
  }
  const sigRowIdx = rows.length + 1;
  rows.push(signatureRow('Prepared By (Instructor): ____________________________', 'Checked By (OIC):________________________________________'));
  rows[rows.length - 1][1] = { v: instructorName, s: 11 };
  merges.push(`B${sigRowIdx}:${xlsxColLetter(mid - 1)}${sigRowIdx}`);
  merges.push(`${xlsxColLetter(mid + 1)}${sigRowIdx}:${xlsxColLetter(lastCol)}${sigRowIdx}`);
  rows.push([]);
  const dateRowIdx = rows.length + 1;
  rows.push(signatureRow('Date:', 'Date:'));
  merges.push(`B${dateRowIdx}:${xlsxColLetter(mid - 1)}${dateRowIdx}`);
  merges.push(`${xlsxColLetter(mid + 1)}${dateRowIdx}:${xlsxColLetter(lastCol)}${dateRowIdx}`);

  const colWidths = [5, 24, ...dayHeaders.map(() => 4), 8, 11];
  const sheetXml = attendanceSheetXml(rows, merges, colWidths);

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" /><Default Extension="xml" ContentType="application/xml" /><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" /><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml" /><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml" /></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml" /></Relationships>`;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Attendance" sheetId="1" r:id="rId1" /></sheets></workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml" /><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml" /></Relationships>`;

  const zipBytes = zipStore([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: attendanceXlsxStyles() },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml },
  ]);
  return new Blob([zipBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function exportAttendanceToExcel() {
  const blob = buildAttendanceXlsxBlob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const monthLabel = `${monthNames[attCurrentMonth]}-${attCurrentYear}`;
  a.href = url;
  a.download = `Attendance-${monthLabel}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ========== DAILY DIARY ==========
const DIARY_DEFAULT_ROWS = [
  { time: '8.30 AM - 10.30 AM', module: '', task: '', subject: '', signature: '' },
  { time: '10.45 AM - 12.15 PM', module: '', task: '', subject: '', signature: '' },
  { time: '12.45 PM - 2.45 PM', module: '', task: '', subject: '', signature: '' },
  { time: '2.45 PM - 4.15 PM', module: '', task: '', subject: '', signature: '' },
];
const DIARY_BLOCKS = [
  { bodyId: 'diaryBlock1Body', slotIndexes: [0, 1] },
  { bodyId: 'diaryBlock2Body', slotIndexes: [2, 3] },
];
let diaryEntriesCache = [];
let currentDiaryModuleOptions = [];
let currentDiaryBatch = '';

function updateDiaryBatchHeadline() {
  document.getElementById('dyBatchHeadline').textContent = `DVTC - NINTAVUR - ${currentDiaryBatch || '----'} BATCH`;
}

function updateDiaryModuleOptions() {
  const courseId = document.getElementById('dyCourse').value;
  const course = courseCache.find(c => c.id == courseId);
  currentDiaryModuleOptions = computeCourseModuleOptions(course);
}

function diaryModuleSelectHtml(selectedModule) {
  let matched = false;
  let html = '<option value="">-- Select module --</option>' + currentDiaryModuleOptions.map(o => {
    const sel = o.module === selectedModule;
    if (sel) matched = true;
    return `<option value="${escapeHtml(o.module)}" ${sel ? 'selected' : ''}>${escapeHtml(o.label)}</option>`;
  }).join('');
  if (selectedModule && !matched) html += `<option value="${escapeHtml(selectedModule)}" selected>${escapeHtml(selectedModule)}</option>`;
  return html;
}

// Renders one 2-row block: Module and Task are shared across both rows (rowspan), Time/Subject/Signature stay per-row.
function buildDiaryBlock(bodyId, blockRows) {
  const body = document.getElementById(bodyId);
  const [row1, row2] = blockRows;
  body.innerHTML = `
    <tr class="diary-data-row">
      <td class="col-time"><div class="diary-vertical-text">${escapeHtml(row1.time || '')}</div></td>
      <td class="col-module" rowspan="2"><select class="dy-module">${diaryModuleSelectHtml(row1.module || '')}</select></td>
      <td class="col-task" rowspan="2"><textarea class="dy-task" placeholder="Enter your task here...">${escapeHtml(row1.task || '')}</textarea></td>
      <td class="col-subject"><textarea class="dy-subject" rows="4" placeholder="Enter subject here...">${escapeHtml(row1.subject || '')}</textarea></td>
      <td class="col-sign"><input class="dy-signature" value="${escapeHtml(row1.signature || '')}"></td>
    </tr>
    <tr class="diary-data-row">
      <td class="col-time"><div class="diary-vertical-text">${escapeHtml(row2.time || '')}</div></td>
      <td class="col-subject"><textarea class="dy-subject" rows="4">${escapeHtml(row2.subject || '')}</textarea></td>
      <td class="col-sign"><input class="dy-signature" value="${escapeHtml(row2.signature || '')}"></td>
    </tr>
  `;
}

// Maps whatever was saved onto the fixed 4-slot structure positionally (old entries may have had a
// different row count from before rows became fixed) - the time label always comes from the fixed default.
function rebuildDiaryTable(rows) {
  const source = Array.isArray(rows) ? rows : [];
  const list = DIARY_DEFAULT_ROWS.map((def, i) => ({ ...def, ...(source[i] || {}), time: def.time }));
  DIARY_BLOCKS.forEach(block => {
    buildDiaryBlock(block.bodyId, block.slotIndexes.map(i => list[i]));
  });
}

function readDiaryRows() {
  const slots = [];
  DIARY_BLOCKS.forEach(block => {
    const trs = document.querySelectorAll(`#${block.bodyId} .diary-data-row`);
    const module = trs[0].querySelector('.dy-module').value.trim();
    const task = trs[0].querySelector('.dy-task').value.trim();
    trs.forEach(tr => {
      slots.push({
        time: tr.querySelector('.diary-vertical-text').textContent.trim(),
        module,
        task,
        subject: tr.querySelector('.dy-subject').value.trim(),
        signature: tr.querySelector('.dy-signature').value.trim(),
      });
    });
  });
  return slots;
}

function formatDateSlash(dateStr) {
  return dateStr ? dateStr.replaceAll('-', '/') : '-';
}
function monthNameFromDate(dateStr) {
  if (!dateStr) return '';
  return monthNames[Number(dateStr.slice(5, 7)) - 1];
}

function updateDiaryQualBadge() {
  const courseId = document.getElementById('dyCourse').value;
  const course = courseCache.find(c => c.id == courseId);
  document.getElementById('dyQualBadge').textContent = course
    ? `${course.name.toUpperCase()} (${(course.qualification_type || 'NVQ-05').toUpperCase()})`
    : '';
}

async function populateDiaryCourseOptions() {
  const sel = document.getElementById('dyCourse');

  let availableCourses = courseCache;
  if (currentUser.role === 'instructor') {
    const myRows = await getMyLecturerRows();
    const myCourseIds = new Set(myRows.map(l => l.course_id));
    availableCourses = courseCache.filter(c => myCourseIds.has(c.id));
  } else if (currentUser.role === 'student') {
    const { courses: mine } = await api('/courses/mine');
    const myCourseIds = new Set(mine.map(c => c.id));
    availableCourses = courseCache.filter(c => myCourseIds.has(c.id));
  }

  if (currentUser.role !== 'admin' && availableCourses.length === 1) {
    sel.innerHTML = `<option value="${availableCourses[0].id}">${escapeHtml(availableCourses[0].name)}</option>`;
    sel.disabled = true;
    return;
  }

  sel.disabled = false;
  sel.innerHTML = availableCourses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

function setDiarySheetReadOnly(readOnly) {
  document.querySelectorAll('#diarySheet input, #diarySheet select, #diarySheet textarea').forEach(el => {
    if (el.tagName === 'SELECT') el.disabled = readOnly;
    else el.readOnly = readOnly;
  });
  document.getElementById('saveDiaryBtn').style.display = readOnly ? 'none' : '';
  document.getElementById('clearDiaryBtn').style.display = readOnly ? 'none' : '';
}

function resetDiaryForm() {
  const date = document.getElementById('dyDate').value;
  document.getElementById('dyId').value = '';
  document.getElementById('dyWeek').value = '';
  document.getElementById('dyMonthText').value = monthNameFromDate(date);
  document.getElementById('dyMetaDate').textContent = formatDateSlash(date);
  document.getElementById('dyInstructorRemarks').value = '';
  document.getElementById('dyToRemarks').value = '';
  document.getElementById('dyToSignature').value = '';
  rebuildDiaryTable(DIARY_DEFAULT_ROWS);
}

function loadDiaryEntryIntoForm(entry) {
  document.getElementById('dyId').value = entry.id;
  document.getElementById('dyCourse').value = entry.course_id || '';
  document.getElementById('dyDate').value = entry.date;
  document.getElementById('dyWeek').value = entry.week || '';
  document.getElementById('dyMonthText').value = entry.month || monthNameFromDate(entry.date);
  document.getElementById('dyMetaDate').textContent = formatDateSlash(entry.date);
  document.getElementById('dyInstructorRemarks').value = entry.instructor_remarks || '';
  document.getElementById('dyToRemarks').value = entry.to_remarks || '';
  document.getElementById('dyToSignature').value = entry.to_signature || '';
  rebuildDiaryTable(entry.slots);
  updateDiaryQualBadge();
}

function tryAutoLoadDiaryEntry() {
  const courseId = document.getElementById('dyCourse').value;
  const date = document.getElementById('dyDate').value;
  const existing = diaryEntriesCache.find(e => String(e.course_id) === String(courseId) && e.date === date);
  if (existing) loadDiaryEntryIntoForm(existing);
  else resetDiaryForm();
}

document.getElementById('dyCourse').addEventListener('change', async () => {
  updateDiaryQualBadge();
  updateDiaryModuleOptions();
  await loadDiaryEntriesForCourse();
  tryAutoLoadDiaryEntry();
});
document.getElementById('dyDate').addEventListener('change', () => {
  tryAutoLoadDiaryEntry();
  if (currentUser.role === 'student') setDiarySheetReadOnly(true);
});
document.getElementById('dyBatch').addEventListener('change', async () => {
  currentDiaryBatch = document.getElementById('dyBatch').value;
  updateDiaryBatchHeadline();
  await loadDiaryEntriesForCourse();
  tryAutoLoadDiaryEntry();
});

document.getElementById('clearDiaryBtn').addEventListener('click', resetDiaryForm);

document.getElementById('printDiaryBtn').addEventListener('click', () => {
  if (!document.getElementById('dyCourse').value) { toast('Please select a course', 'error'); return; }
  const currentDate = document.getElementById('dyDate').value || new Date().toISOString().slice(0, 10);
  document.getElementById('dyPrintStart').value = currentDate;
  document.getElementById('dyPrintEnd').value = currentDate;
  openModal('diaryPrintRangeModal');
});

// Builds one static (non-interactive) A4 diary sheet for a single date, reusing the same
// .diary-sheet markup/CSS as the live editable form so print output matches it exactly.
function buildDiaryPrintPage(course, dateStr, entry) {
  const slots = DIARY_DEFAULT_ROWS.map((def, i) => ({ ...def, ...((entry && entry.slots && entry.slots[i]) || {}), time: def.time }));
  const week = (entry && entry.week) || '';
  const month = (entry && entry.month) || monthNameFromDate(dateStr);
  const qual = course ? `${escapeHtml(course.name.toUpperCase())} (${escapeHtml((course.qualification_type || 'NVQ-05').toUpperCase())})` : '';
  const batchLabel = (entry && entry.batch) || currentDiaryBatch || '----';

  const blockHtml = (rows) => `
    <div class="diary-table-wrap"><table class="diary-block-table">
      <thead><tr><th class="col-time">Time</th><th class="col-module">Module</th><th class="col-task">Task</th><th class="col-subject">Subject Covered</th><th class="col-sign">Instructor Signature</th></tr></thead>
      <tbody>
        <tr>
          <td class="col-time"><div class="diary-vertical-text">${escapeHtml(rows[0].time || '')}</div></td>
          <td class="col-module" rowspan="2"><div class="diary-vertical-text">${escapeHtml(rows[0].module || '')}</div></td>
          <td class="col-task" rowspan="2"><div class="diary-vertical-text">${escapeHtml(rows[0].task || '')}</div></td>
          <td class="col-subject">${escapeHtml(rows[0].subject || '')}</td>
          <td class="col-sign">${escapeHtml(rows[0].signature || '')}</td>
        </tr>
        <tr>
          <td class="col-time"><div class="diary-vertical-text">${escapeHtml(rows[1].time || '')}</div></td>
          <td class="col-subject">${escapeHtml(rows[1].subject || '')}</td>
          <td class="col-sign">${escapeHtml(rows[1].signature || '')}</td>
        </tr>
      </tbody>
    </table></div>`;

  return `
    <div class="panel diary-sheet diary-print-page">
      <div class="diary-sheet-head">
        <h3 class="diary-sheet-kicker">INSTRUCTOR'S DAILY DIARY</h3>
        <h2>DVTC - NINTAVUR - ${escapeHtml(batchLabel)} BATCH</h2>
        <p>${qual}</p>
      </div>
      <div class="diary-meta-row"><div><label>Date:</label> ${formatDateSlash(dateStr)}</div><div><label>Week:</label> ${escapeHtml(week)}</div><div><label>Month:</label> ${escapeHtml(month)}</div></div>
      ${blockHtml([slots[0], slots[1]])}
      <div class="diary-lunch-divider">Lunch Time: 12.15 PM - 12.45 PM</div>
      ${blockHtml([slots[2], slots[3]])}
      <div class="diary-footer">
        <div><label>Instructor Remarks :</label><span class="diary-footer-line">${escapeHtml((entry && entry.instructor_remarks) || '')}</span></div>
        <div><label>T/O Remarks :</label><span class="diary-footer-line">${escapeHtml((entry && entry.to_remarks) || '')}</span></div>
        <div><label>T/O Signature :</label><span class="diary-footer-line">${escapeHtml((entry && entry.to_signature) || '')}</span></div>
      </div>
    </div>`;
}

async function generateDiaryRangePrint(startDate, endDate) {
  const courseId = document.getElementById('dyCourse').value;
  if (!courseId) { toast('Please select a course', 'error'); return; }
  if (!startDate || !endDate) { toast('Please select both dates', 'error'); return; }
  if (startDate > endDate) { toast('Start date must be before end date', 'error'); return; }

  const dates = [];
  let d = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  if (dates.length > 62) {
    const ok = await confirmDialog(`This will generate ${dates.length} pages. Continue?`, { title: 'Large print range', confirmText: 'Continue' });
    if (!ok) return;
  }

  await loadDiaryEntriesForCourse();
  const course = courseCache.find(c => c.id == courseId);
  const pagesHtml = dates.map(dateStr => {
    const entry = diaryEntriesCache.find(e => String(e.course_id) === String(courseId) && e.date === dateStr);
    return buildDiaryPrintPage(course, dateStr, entry);
  }).join('');

  document.getElementById('diaryPrintArea').innerHTML = pagesHtml;
  document.body.classList.add('printing-diary-range');
  window.print();
}

window.addEventListener('afterprint', () => {
  document.body.classList.remove('printing-diary-range');
  document.getElementById('diaryPrintArea').innerHTML = '';
});

withLoadingClick('dyPrintGenerateBtn', async () => {
  const start = document.getElementById('dyPrintStart').value;
  const end = document.getElementById('dyPrintEnd').value;
  closeModal('diaryPrintRangeModal');
  await generateDiaryRangePrint(start, end);
});

withLoadingClick('saveDiaryBtn', async () => {
  const courseId = document.getElementById('dyCourse').value;
  const date = document.getElementById('dyDate').value;
  if (!courseId) { toast('Please select a course', 'error'); return; }
  if (!date) { toast('Please select a date', 'error'); return; }

  const id = document.getElementById('dyId').value;
  const body = {
    course_id: Number(courseId),
    date,
    week: document.getElementById('dyWeek').value.trim(),
    month: document.getElementById('dyMonthText').value.trim(),
    slots: readDiaryRows(),
    instructor_remarks: document.getElementById('dyInstructorRemarks').value.trim(),
    to_remarks: document.getElementById('dyToRemarks').value.trim(),
    to_signature: document.getElementById('dyToSignature').value.trim(),
    batch: document.getElementById('dyBatch').value || null,
  };

  try {
    if (id) await api(`/diary/${id}`, { method: 'PUT', body });
    else await api('/diary', { method: 'POST', body });
    toast('Diary entry saved', 'success');
    await loadDiaryEntriesForCourse();
    tryAutoLoadDiaryEntry();
  } catch (e) { toast(e.message, 'error'); }
});

async function loadDiaryEntriesForCourse() {
  const courseId = document.getElementById('dyCourse').value;
  const params = new URLSearchParams();
  if (courseId) params.set('course_id', courseId);
  if (currentUser.role === 'admin' && currentDiaryBatch) params.set('batch', currentDiaryBatch);
  const { entries } = await api(`/diary?${params.toString()}`);
  diaryEntriesCache = entries;
}

async function renderDiary() {
  if (!courseCache.length) { const r = await api('/courses'); courseCache = r.courses; }
  await populateDiaryCourseOptions();
  if (!document.getElementById('dyDate').value) document.getElementById('dyDate').value = new Date().toISOString().slice(0, 10);
  const batchSel = document.getElementById('dyBatch');
  const { batches, latest } = await getBatchOptions();
  populateBatchSelect(batchSel, batches, latest, batchSel.value);
  currentDiaryBatch = batchSel.value;
  updateDiaryBatchHeadline();
  updateDiaryQualBadge();
  updateDiaryModuleOptions();
  await loadDiaryEntriesForCourse();
  tryAutoLoadDiaryEntry();
}

// ========== DAILY DIARY (Student: view-only) ==========
async function renderStudentDiary() {
  if (!courseCache.length) { const r = await api('/courses'); courseCache = r.courses; }
  await populateDiaryCourseOptions();
  if (!document.getElementById('dyDate').value) document.getElementById('dyDate').value = new Date().toISOString().slice(0, 10);
  const { user } = await api('/auth/profile');
  currentDiaryBatch = (user.studentProfile && user.studentProfile.batch) || '';
  updateDiaryBatchHeadline();
  updateDiaryQualBadge();
  updateDiaryModuleOptions();
  await loadDiaryEntriesForCourse();
  tryAutoLoadDiaryEntry();
  setDiarySheetReadOnly(true);
}

// ========== ASSIGNMENTS ==========
function formatDateTime(dt) {
  if (!dt) return null;
  return new Date(dt.replace(' ', 'T')).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function assignmentStatus(a) {
  const now = new Date();
  const start = a.start_at ? new Date(a.start_at.replace(' ', 'T')) : null;
  const end = a.end_at ? new Date(a.end_at.replace(' ', 'T')) : null;
  if (start && now < start) return { label: 'Upcoming', cls: 'blue' };
  if (end && now > end) return { label: 'Closed', cls: 'red' };
  return { label: 'Open', cls: 'green' };
}

function openFilePreview(fileUrl, fileName, title) {
  document.getElementById('filePreviewTitle').textContent = title || fileName || 'Preview';
  const body = document.getElementById('filePreviewBody');
  const downloadLink = document.getElementById('filePreviewDownload');
  if (!fileUrl) {
    body.innerHTML = '<div class="no-file">No file attached.</div>';
    downloadLink.style.display = 'none';
  } else {
    const isPdf = /\.pdf($|\?)/i.test(fileUrl) || (fileName && /\.pdf$/i.test(fileName));
    body.innerHTML = isPdf
      ? `<iframe src="${fileUrl}"></iframe>`
      : `<img src="${fileUrl}" alt="${escapeHtml(fileName || 'preview')}">`;
    downloadLink.href = fileUrl;
    downloadLink.setAttribute('download', fileName || '');
    downloadLink.style.display = 'inline-flex';
  }
  openModal('filePreviewModal');
}

let myLecturerRowsCache = null;
async function getMyLecturerRows() {
  if (currentUser.role !== 'instructor') return [];
  if (myLecturerRowsCache) return myLecturerRowsCache;
  const { lecturers } = await api('/lecturers');
  myLecturerRowsCache = lecturers.filter(l => l.user_id === currentUser.id);
  return myLecturerRowsCache;
}

// Distinct student batch/year values, highest number first (that's "latest"). Admin/instructor only.
let batchOptionsCache = null;
async function getBatchOptions() {
  if (currentUser.role === 'student') return { batches: [], latest: null };
  if (batchOptionsCache) return batchOptionsCache;
  batchOptionsCache = await api('/students/batches');
  return batchOptionsCache;
}

// Populates a <select> with batch options, defaulting to the latest year unless a value is preserved.
function populateBatchSelect(sel, batches, latest, preserve) {
  sel.innerHTML = batches.map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
  if (preserve && batches.includes(preserve)) sel.value = preserve;
  else if (latest) sel.value = latest;
}

// For an instructor, only the modules they're actually assigned to teach for this course; admins see all of the course's modules.
async function allowedModuleOptions(courseId) {
  const course = courseCache.find(c => c.id == courseId);
  let options = computeCourseModuleOptions(course);
  if (currentUser.role === 'instructor') {
    const myRows = await getMyLecturerRows();
    const lecturerRow = myRows.find(l => l.course_id == courseId);
    const allowed = lecturerRow ? parseModuleJson(lecturerRow.modules).map(m => m.module) : [];
    options = options.filter(o => allowed.includes(o.module));
  }
  return options;
}

async function populateAssignmentModuleOptions() {
  const courseId = document.getElementById('asgCourse').value;
  const options = await allowedModuleOptions(courseId);
  document.getElementById('asgModule').innerHTML = '<option value="">-- No specific module --</option>' +
    options.map(o => `<option value="${escapeHtml(o.module)}">${escapeHtml(o.label)}</option>`).join('');
}
document.getElementById('asgCourse').addEventListener('change', populateAssignmentModuleOptions);

withLoadingClick('addAssignmentBtn', async () => {
  if (!courseCache.length) { const r = await api('/courses'); courseCache = r.courses; }
  let availableCourses = courseCache;
  if (currentUser.role === 'instructor') {
    const myRows = await getMyLecturerRows();
    const myCourseIds = new Set(myRows.map(l => l.course_id));
    availableCourses = courseCache.filter(c => myCourseIds.has(c.id));
    if (!availableCourses.length) { toast('You are not assigned to teach any course/module yet. Ask an admin to assign you first.', 'error'); return; }
  }
  document.getElementById('asgCourse').innerHTML = availableCourses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  await populateAssignmentModuleOptions();
  const { batches, latest } = await getBatchOptions();
  populateBatchSelect(document.getElementById('asgBatch'), batches, latest);
  document.getElementById('asgTitle').value = '';
  document.getElementById('asgStart').value = '';
  document.getElementById('asgEnd').value = '';
  document.getElementById('asgInstructions').value = '';
  document.getElementById('asgFile').value = '';
  openModal('assignmentModal');
});

withLoadingClick('createAssignmentBtn', async () => {
  const title = document.getElementById('asgTitle').value.trim();
  if (!title) { toast('Assignment name is required', 'error'); return; }
  const start = document.getElementById('asgStart').value;
  const end = document.getElementById('asgEnd').value;
  if (start && end && new Date(end) <= new Date(start)) { toast('End date/time must be after the start', 'error'); return; }

  const formData = new FormData();
  formData.append('title', title);
  formData.append('course_id', document.getElementById('asgCourse').value);
  formData.append('module', document.getElementById('asgModule').value);
  formData.append('batch', document.getElementById('asgBatch').value);
  if (start) formData.append('start_at', start.replace('T', ' ') + ':00');
  if (end) formData.append('end_at', end.replace('T', ' ') + ':00');
  formData.append('instructions', document.getElementById('asgInstructions').value.trim());
  const file = document.getElementById('asgFile').files[0];
  if (file) formData.append('file', file);

  try {
    await api('/assignments', { method: 'POST', body: formData });
    closeModal('assignmentModal');
    toast('Assignment created', 'success');
    renderAssignments();
  } catch (e) { toast(e.message, 'error'); }
});

withLoadingClick('saveDeadlineBtn', async () => {
  const id = document.getElementById('eddAssignmentId').value;
  const end = document.getElementById('eddEnd').value;
  if (!end) { toast('Please choose a new end date/time', 'error'); return; }
  try {
    await api(`/assignments/${id}/deadline`, { method: 'PUT', body: { end_at: end.replace('T', ' ') + ':00' } });
    closeModal('editDeadlineModal');
    toast('Deadline updated', 'success');
    renderAssignments();
  } catch (e) { toast(e.message, 'error'); }
});

withLoadingClick('confirmSubmitBtn', async () => {
  const id = document.getElementById('subAssignmentId').value;
  const file = document.getElementById('subFile').files[0];
  if (!file) { toast('Please attach your PDF or image', 'error'); return; }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('note', document.getElementById('subNote').value.trim());

  try {
    await api(`/assignments/${id}/submit`, { method: 'POST', body: formData });
    closeModal('submitModal');
    toast('Submission recorded', 'success');
    renderAssignments();
  } catch (e) { toast(e.message, 'error'); }
});

async function openSubmissionsModal(assignmentId, title) {
  document.getElementById('submissionsModalTitle').textContent = `Submissions: ${title}`;
  const box = document.getElementById('submissionsList');
  box.innerHTML = '<p style="color:var(--muted);font-size:12px">Loading...</p>';
  openModal('submissionsModal');
  try {
    const { assignment, submissions } = await api(`/assignments/${assignmentId}/submissions`);
    document.getElementById('submissionsModalMeta').textContent = assignment.end_at
      ? `${assignment.course_name || ''} &middot; Deadline: ${formatDateTime(assignment.end_at)}`.replace(/^ &middot; /, '')
      : (assignment.course_name || 'No deadline set');

    if (!submissions.length) { box.innerHTML = '<p style="color:var(--muted);font-size:12px">No submissions yet.</p>'; return; }

    box.innerHTML = submissions.map(s => `
      <div class="submission-row">
        <div class="row-top">
          <div><b>${escapeHtml(s.student_name)}</b></div>
          <small>${formatDateTime(s.submitted_at)}</small>
        </div>
        ${s.note ? `<p style="font-size:11px;color:var(--muted);margin-top:6px">${escapeHtml(s.note)}</p>` : ''}
        <div class="grade-row">
          <button class="btn btn-outline-dark btn-sm" data-preview-file="${assetUrl(s.file_path) || ''}" data-preview-name="${escapeHtml(s.file_name || '')}" data-preview-title="${escapeHtml(s.student_name)}'s Submission"><svg class="icon sm"><use href="#i-eye"/></svg> Preview</button>
          <a class="btn btn-outline-dark btn-sm" href="${assetUrl(s.file_path) || ''}" download="${escapeHtml(s.file_name || '')}"><svg class="icon sm"><use href="#i-download"/></svg> Download</a>
          <input class="grade-input" placeholder="Grade" value="${escapeHtml(s.grade || '')}" data-grade-for="${s.id}">
          <input class="feedback-input" placeholder="Feedback" value="${escapeHtml(s.feedback || '')}" data-feedback-for="${s.id}">
          <button class="btn btn-gold btn-sm" data-save-grade="${s.id}"><svg class="icon sm"><use href="#i-check"/></svg> Save</button>
        </div>
      </div>
    `).join('');

    box.querySelectorAll('[data-preview-file]').forEach(btn => {
      btn.addEventListener('click', () => openFilePreview(btn.dataset.previewFile, btn.dataset.previewName, btn.dataset.previewTitle));
    });
    box.querySelectorAll('[data-save-grade]').forEach(btn => {
      withLoadingClick(btn, async () => {
        const subId = btn.dataset.saveGrade;
        const grade = box.querySelector(`[data-grade-for="${subId}"]`).value.trim();
        const feedback = box.querySelector(`[data-feedback-for="${subId}"]`).value.trim();
        try {
          await api(`/assignments/${assignmentId}/submissions/${subId}/grade`, { method: 'PUT', body: { grade, feedback } });
          toast('Grade saved', 'success');
          renderAssignments();
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  } catch (e) {
    box.innerHTML = `<p style="color:var(--red);font-size:12px">${escapeHtml(e.message)}</p>`;
  }
}

async function populateAssignmentFilterModuleOptions() {
  const sel = document.getElementById('asgFilterModule');
  const courseId = document.getElementById('asgFilterCourse').value;
  if (!courseId) { sel.innerHTML = '<option value="">All Modules</option>'; sel.disabled = true; return; }
  sel.disabled = false;
  const options = await allowedModuleOptions(courseId);
  sel.innerHTML = '<option value="">All Modules</option>' +
    options.map(o => `<option value="${escapeHtml(o.module)}">${escapeHtml(o.label)}</option>`).join('');
}

async function populateAssignmentFilterBar() {
  if (!courseCache.length) { const r = await api('/courses'); courseCache = r.courses; }
  const courseSel = document.getElementById('asgFilterCourse');
  const moduleSel = document.getElementById('asgFilterModule');
  const batchSel = document.getElementById('asgFilterBatch');

  if (currentUser.role !== 'student') {
    const { batches, latest } = await getBatchOptions();
    populateBatchSelect(batchSel, batches, latest, batchSel.value);
  }

  let availableCourses = courseCache;
  if (currentUser.role === 'instructor') {
    const myRows = await getMyLecturerRows();
    const myCourseIds = new Set(myRows.map(l => l.course_id));
    availableCourses = courseCache.filter(c => myCourseIds.has(c.id));
  } else if (currentUser.role === 'student') {
    const { courses: mine } = await api('/courses/mine');
    const myCourseIds = new Set(mine.map(c => c.id));
    availableCourses = courseCache.filter(c => myCourseIds.has(c.id));
  }

  if (currentUser.role !== 'admin' && availableCourses.length === 1) {
    const course = availableCourses[0];
    const options = await allowedModuleOptions(course.id);

    courseSel.innerHTML = `<option value="${course.id}">${escapeHtml(course.name)}</option>`;
    courseSel.disabled = true;

    if (options.length <= 1) {
      moduleSel.innerHTML = options.length === 1
        ? `<option value="${escapeHtml(options[0].module)}">${escapeHtml(options[0].label)}</option>`
        : '<option value="">All Modules</option>';
      moduleSel.disabled = true;
    } else {
      moduleSel.disabled = false;
      moduleSel.innerHTML = '<option value="">All Modules</option>' +
        options.map(o => `<option value="${escapeHtml(o.module)}">${escapeHtml(o.label)}</option>`).join('');
    }
    return;
  }

  courseSel.disabled = false;
  courseSel.innerHTML = '<option value="">All Courses</option>' +
    availableCourses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  await populateAssignmentFilterModuleOptions();
}
document.getElementById('asgFilterCourse').addEventListener('change', async () => {
  await populateAssignmentFilterModuleOptions();
  renderAssignments();
});
document.getElementById('asgFilterModule').addEventListener('change', renderAssignments);
document.getElementById('asgFilterBatch').addEventListener('change', renderAssignments);

async function renderAssignments() {
  if (!courseCache.length) { const r = await api('/courses'); courseCache = r.courses; }
  const filterBar = document.getElementById('asgFilterCourse');
  if (!filterBar.dataset.loaded) {
    await populateAssignmentFilterBar();
    filterBar.dataset.loaded = 'true';
  }
  const params = new URLSearchParams();
  if (filterBar.value) params.set('course_id', filterBar.value);
  const filterModule = document.getElementById('asgFilterModule').value;
  if (filterModule) params.set('module', filterModule);
  if (currentUser.role !== 'student') {
    const filterBatch = document.getElementById('asgFilterBatch').value;
    if (filterBatch) params.set('batch', filterBatch);
  }
  const { assignments } = await api(`/assignments?${params.toString()}`);
  const container = document.getElementById('assignmentList');
  if (!assignments.length) { container.innerHTML = '<p style="color:var(--muted);font-size:12px">No assignments yet.</p>'; return; }

  container.innerHTML = assignments.map(a => {
    const status = assignmentStatus(a);
    const startText = formatDateTime(a.start_at);
    const endText = formatDateTime(a.end_at);

    let actionParts = [];
    if (currentUser.role === 'student') {
      const closed = status.label === 'Closed';
      if (a.file_path) actionParts.push(`<button class="btn btn-outline-dark btn-sm" data-preview-file="${assetUrl(a.file_path)}" data-preview-name="${escapeHtml(a.file_name || '')}" data-preview-title="${escapeHtml(a.title)}"><svg class="icon sm"><use href="#i-eye"/></svg> Preview Attachment</button>`);
      if (a.my_submission) {
        actionParts.push(`<span class="badge green">Submitted${a.my_grade ? ' &middot; Grade: ' + escapeHtml(a.my_grade) : ''}</span>`);
        actionParts.push(`<button class="btn btn-outline-dark btn-sm" data-preview-file="${assetUrl(a.my_submission_file)}" data-preview-name="${escapeHtml(a.my_submission_file_name || '')}" data-preview-title="My Submission"><svg class="icon sm"><use href="#i-eye"/></svg> View My Submission</button>`);
        if (!closed) actionParts.push(`<button class="btn btn-gold btn-sm" data-submit="${a.id}" data-title="${escapeHtml(a.title)}"><svg class="icon sm"><use href="#i-rotate"/></svg> Resubmit</button>`);
      } else if (closed) {
        actionParts.push(`<span class="badge red">Submission Closed</span>`);
      } else {
        actionParts.push(`<button class="btn btn-gold btn-sm" data-submit="${a.id}" data-title="${escapeHtml(a.title)}"><svg class="icon sm"><use href="#i-send"/></svg> Submit</button>`);
      }
    } else {
      actionParts.push(`<button class="btn btn-outline-dark btn-sm" data-view-subs="${a.id}" data-title="${escapeHtml(a.title)}"><svg class="icon sm"><use href="#i-list"/></svg> View Submissions (${a.submission_count})</button>`);
      if (a.file_path) actionParts.push(`<button class="btn btn-outline-dark btn-sm" data-preview-file="${assetUrl(a.file_path)}" data-preview-name="${escapeHtml(a.file_name || '')}" data-preview-title="${escapeHtml(a.title)}"><svg class="icon sm"><use href="#i-eye"/></svg> Preview Attachment</button>`);
      if (a.can_edit_deadline) actionParts.push(`<button class="btn btn-outline-dark btn-sm" data-edit-deadline="${a.id}" data-title="${escapeHtml(a.title)}" data-end="${a.end_at || ''}"><svg class="icon sm"><use href="#i-clock"/></svg> Edit End Date</button>`);
    }

    return `<div class="assignment-item" data-assignment-id="${a.id}">
      <b>${escapeHtml(a.title)}</b>
      ${a.course_name ? `<span class="badge blue">${escapeHtml(a.course_name)}</span>` : ''}
      ${a.module ? `<span class="badge gold">${escapeHtml(a.module)}</span>` : ''}
      ${a.batch ? `<span class="badge green">Batch ${escapeHtml(a.batch)}</span>` : ''}
      <span class="badge ${status.cls}">${status.label}</span>
      <div class="meta">
        ${startText ? `<svg class="icon sm"><use href="#i-play"/></svg> Start: ${startText} &middot; ` : ''}${endText ? `<svg class="icon sm"><use href="#i-flag"/></svg> End: ${endText}` : 'No deadline set'}
        &middot; <svg class="icon sm"><use href="#i-users"/></svg> ${a.submission_count} submission${a.submission_count === 1 ? '' : 's'}
      </div>
      ${a.instructions ? `<p style="font-size:11px;color:var(--muted);margin-top:6px">${escapeHtml(a.instructions)}</p>` : ''}
      <div class="actions">${actionParts.join(' ')}</div>
    </div>`;
  }).join('');

  container.querySelectorAll('[data-preview-file]').forEach(btn => {
    btn.addEventListener('click', () => openFilePreview(btn.dataset.previewFile, btn.dataset.previewName, btn.dataset.previewTitle));
  });
  container.querySelectorAll('[data-submit]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('submitModalTitle').textContent = `Submit: ${btn.dataset.title}`;
      document.getElementById('subAssignmentId').value = btn.dataset.submit;
      document.getElementById('subFile').value = '';
      document.getElementById('subNote').value = '';
      openModal('submitModal');
    });
  });
  container.querySelectorAll('[data-edit-deadline]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('eddAssignmentId').value = btn.dataset.editDeadline;
      document.getElementById('eddAssignmentTitle').textContent = btn.dataset.title;
      document.getElementById('eddEnd').value = btn.dataset.end ? btn.dataset.end.replace(' ', 'T').slice(0, 16) : '';
      openModal('editDeadlineModal');
    });
  });
  container.querySelectorAll('[data-view-subs]').forEach(btn => {
    btn.addEventListener('click', () => openSubmissionsModal(btn.dataset.viewSubs, btn.dataset.title));
  });
}

// ========== EXAMS ==========
async function populateExamModuleOptions() {
  const courseId = document.getElementById('exmCourse').value;
  const options = await allowedModuleOptions(courseId);
  document.getElementById('exmModule').innerHTML = '<option value="">-- No specific module --</option>' +
    options.map(o => `<option value="${escapeHtml(o.module)}">${escapeHtml(o.label)}</option>`).join('');
}
document.getElementById('exmCourse').addEventListener('change', populateExamModuleOptions);

withLoadingClick('addExamBtn', async () => {
  if (!courseCache.length) { const r = await api('/courses'); courseCache = r.courses; }
  let availableCourses = courseCache;
  if (currentUser.role === 'instructor') {
    const myRows = await getMyLecturerRows();
    const myCourseIds = new Set(myRows.map(l => l.course_id));
    availableCourses = courseCache.filter(c => myCourseIds.has(c.id));
    if (!availableCourses.length) { toast('You are not assigned to teach any course/module yet. Ask an admin to assign you first.', 'error'); return; }
  }
  document.getElementById('exmCourse').innerHTML = availableCourses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  await populateExamModuleOptions();
  const { batches, latest } = await getBatchOptions();
  populateBatchSelect(document.getElementById('exmBatch'), batches, latest);
  document.getElementById('exmTitle').value = '';
  document.getElementById('exmStart').value = '';
  document.getElementById('exmEnd').value = '';
  openModal('examModal');
});

withLoadingClick('createExamBtn', async () => {
  const title = document.getElementById('exmTitle').value.trim();
  if (!title) { toast('Exam title is required', 'error'); return; }
  const start = document.getElementById('exmStart').value;
  const end = document.getElementById('exmEnd').value;
  if (start && end && new Date(end) <= new Date(start)) { toast('End date/time must be after the start', 'error'); return; }

  const body = {
    title,
    course_id: document.getElementById('exmCourse').value,
    module: document.getElementById('exmModule').value,
    batch: document.getElementById('exmBatch').value,
  };
  if (start) body.start_at = start.replace('T', ' ') + ':00';
  if (end) body.end_at = end.replace('T', ' ') + ':00';

  try {
    await api('/exams', { method: 'POST', body });
    closeModal('examModal');
    toast('Exam portal opened', 'success');
    renderExams();
  } catch (e) { toast(e.message, 'error'); }
});

withLoadingClick('saveExamDeadlineBtn', async () => {
  const id = document.getElementById('eexExamId').value;
  const end = document.getElementById('eexEnd').value;
  if (!end) { toast('Please choose a new end date/time', 'error'); return; }
  try {
    await api(`/exams/${id}/deadline`, { method: 'PUT', body: { end_at: end.replace('T', ' ') + ':00' } });
    closeModal('examEditDeadlineModal');
    toast('Deadline updated', 'success');
    renderExams();
  } catch (e) { toast(e.message, 'error'); }
});

withLoadingClick('confirmExamSubmitBtn', async () => {
  const id = document.getElementById('exsExamId').value;
  const file = document.getElementById('exsFile').files[0];
  if (!file) { toast('Please attach your exam paper', 'error'); return; }

  const formData = new FormData();
  formData.append('file', file);

  try {
    await api(`/exams/${id}/submit`, { method: 'POST', body: formData });
    closeModal('examSubmitModal');
    toast('Exam paper submitted', 'success');
    renderExams();
  } catch (e) { toast(e.message, 'error'); }
});

async function openExamSubmissionsModal(examId, title) {
  document.getElementById('examSubmissionsModalTitle').textContent = `Exam Papers: ${title}`;
  const box = document.getElementById('examSubmissionsList');
  box.innerHTML = '<p style="color:var(--muted);font-size:12px">Loading...</p>';
  openModal('examSubmissionsModal');
  try {
    const { exam, submissions } = await api(`/exams/${examId}/submissions`);
    document.getElementById('examSubmissionsModalMeta').textContent = exam.end_at
      ? `${exam.course_name || ''} &middot; Closes: ${formatDateTime(exam.end_at)}`.replace(/^ &middot; /, '')
      : (exam.course_name || 'No end time set');

    if (!submissions.length) { box.innerHTML = '<p style="color:var(--muted);font-size:12px">No exam papers uploaded yet.</p>'; return; }

    box.innerHTML = submissions.map(s => `
      <div class="submission-row">
        <div class="row-top">
          <div><b>${escapeHtml(s.student_name)}</b></div>
          <small>${formatDateTime(s.submitted_at)}</small>
        </div>
        <div class="grade-row">
          <button class="btn btn-outline-dark btn-sm" data-preview-file="${assetUrl(s.file_path) || ''}" data-preview-name="${escapeHtml(s.file_name || '')}" data-preview-title="${escapeHtml(s.student_name)}'s Exam Paper"><svg class="icon sm"><use href="#i-eye"/></svg> Preview</button>
          <a class="btn btn-outline-dark btn-sm" href="${assetUrl(s.file_path) || ''}" download="${escapeHtml(s.file_name || '')}"><svg class="icon sm"><use href="#i-download"/></svg> Download</a>
          <input class="grade-input" placeholder="Grade" value="${escapeHtml(s.grade || '')}" data-grade-for="${s.id}">
          <input class="feedback-input" placeholder="Feedback" value="${escapeHtml(s.feedback || '')}" data-feedback-for="${s.id}">
          <button class="btn btn-gold btn-sm" data-save-grade="${s.id}"><svg class="icon sm"><use href="#i-check"/></svg> Save</button>
        </div>
      </div>
    `).join('');

    box.querySelectorAll('[data-preview-file]').forEach(btn => {
      btn.addEventListener('click', () => openFilePreview(btn.dataset.previewFile, btn.dataset.previewName, btn.dataset.previewTitle));
    });
    box.querySelectorAll('[data-save-grade]').forEach(btn => {
      withLoadingClick(btn, async () => {
        const subId = btn.dataset.saveGrade;
        const grade = box.querySelector(`[data-grade-for="${subId}"]`).value.trim();
        const feedback = box.querySelector(`[data-feedback-for="${subId}"]`).value.trim();
        try {
          await api(`/exams/${examId}/submissions/${subId}/grade`, { method: 'PUT', body: { grade, feedback } });
          toast('Grade saved', 'success');
          renderExams();
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  } catch (e) {
    box.innerHTML = `<p style="color:var(--red);font-size:12px">${escapeHtml(e.message)}</p>`;
  }
}

async function populateExamFilterModuleOptions() {
  const sel = document.getElementById('exmFilterModule');
  const courseId = document.getElementById('exmFilterCourse').value;
  if (!courseId) { sel.innerHTML = '<option value="">All Modules</option>'; sel.disabled = true; return; }
  sel.disabled = false;
  const options = await allowedModuleOptions(courseId);
  sel.innerHTML = '<option value="">All Modules</option>' +
    options.map(o => `<option value="${escapeHtml(o.module)}">${escapeHtml(o.label)}</option>`).join('');
}

async function populateExamFilterBar() {
  if (!courseCache.length) { const r = await api('/courses'); courseCache = r.courses; }
  const courseSel = document.getElementById('exmFilterCourse');
  const moduleSel = document.getElementById('exmFilterModule');
  const batchSel = document.getElementById('exmFilterBatch');

  if (currentUser.role !== 'student') {
    const { batches, latest } = await getBatchOptions();
    populateBatchSelect(batchSel, batches, latest, batchSel.value);
  }

  let availableCourses = courseCache;
  if (currentUser.role === 'instructor') {
    const myRows = await getMyLecturerRows();
    const myCourseIds = new Set(myRows.map(l => l.course_id));
    availableCourses = courseCache.filter(c => myCourseIds.has(c.id));
  } else if (currentUser.role === 'student') {
    const { courses: mine } = await api('/courses/mine');
    const myCourseIds = new Set(mine.map(c => c.id));
    availableCourses = courseCache.filter(c => myCourseIds.has(c.id));
  }

  if (currentUser.role !== 'admin' && availableCourses.length === 1) {
    const course = availableCourses[0];
    const options = await allowedModuleOptions(course.id);

    courseSel.innerHTML = `<option value="${course.id}">${escapeHtml(course.name)}</option>`;
    courseSel.disabled = true;

    if (options.length <= 1) {
      moduleSel.innerHTML = options.length === 1
        ? `<option value="${escapeHtml(options[0].module)}">${escapeHtml(options[0].label)}</option>`
        : '<option value="">All Modules</option>';
      moduleSel.disabled = true;
    } else {
      moduleSel.disabled = false;
      moduleSel.innerHTML = '<option value="">All Modules</option>' +
        options.map(o => `<option value="${escapeHtml(o.module)}">${escapeHtml(o.label)}</option>`).join('');
    }
    return;
  }

  courseSel.disabled = false;
  courseSel.innerHTML = '<option value="">All Courses</option>' +
    availableCourses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  await populateExamFilterModuleOptions();
}
document.getElementById('exmFilterCourse').addEventListener('change', async () => {
  await populateExamFilterModuleOptions();
  renderExams();
});
document.getElementById('exmFilterModule').addEventListener('change', renderExams);
document.getElementById('exmFilterBatch').addEventListener('change', renderExams);

async function renderExams() {
  if (!courseCache.length) { const r = await api('/courses'); courseCache = r.courses; }
  const filterBar = document.getElementById('exmFilterCourse');
  if (!filterBar.dataset.loaded) {
    await populateExamFilterBar();
    filterBar.dataset.loaded = 'true';
  }
  const params = new URLSearchParams();
  if (filterBar.value) params.set('course_id', filterBar.value);
  const filterModule = document.getElementById('exmFilterModule').value;
  if (filterModule) params.set('module', filterModule);
  if (currentUser.role !== 'student') {
    const filterBatch = document.getElementById('exmFilterBatch').value;
    if (filterBatch) params.set('batch', filterBatch);
  }
  const { exams } = await api(`/exams?${params.toString()}`);
  const container = document.getElementById('examList');
  if (!exams.length) { container.innerHTML = '<p style="color:var(--muted);font-size:12px">No exams scheduled yet.</p>'; return; }

  container.innerHTML = exams.map(a => {
    const status = assignmentStatus(a);
    const startText = formatDateTime(a.start_at);
    const endText = formatDateTime(a.end_at);

    let actionParts = [];
    if (currentUser.role === 'student') {
      const closed = status.label === 'Closed';
      if (a.my_submission) {
        actionParts.push(`<span class="badge green">Submitted${a.my_grade ? ' &middot; Grade: ' + escapeHtml(a.my_grade) : ''}</span>`);
        actionParts.push(`<button class="btn btn-outline-dark btn-sm" data-preview-file="${assetUrl(a.my_submission_file)}" data-preview-name="${escapeHtml(a.my_submission_file_name || '')}" data-preview-title="My Exam Paper"><svg class="icon sm"><use href="#i-eye"/></svg> View My Upload</button>`);
        if (!closed) actionParts.push(`<button class="btn btn-gold btn-sm" data-exam-submit="${a.id}" data-title="${escapeHtml(a.title)}"><svg class="icon sm"><use href="#i-rotate"/></svg> Re-upload</button>`);
      } else if (closed) {
        actionParts.push(`<span class="badge red">Submission Closed</span>`);
      } else {
        actionParts.push(`<button class="btn btn-gold btn-sm" data-exam-submit="${a.id}" data-title="${escapeHtml(a.title)}"><svg class="icon sm"><use href="#i-upload"/></svg> Upload Exam Paper</button>`);
      }
    } else {
      actionParts.push(`<button class="btn btn-outline-dark btn-sm" data-exam-view-subs="${a.id}" data-title="${escapeHtml(a.title)}"><svg class="icon sm"><use href="#i-list"/></svg> View Papers (${a.submission_count})</button>`);
      if (a.can_edit_deadline) actionParts.push(`<button class="btn btn-outline-dark btn-sm" data-exam-edit-deadline="${a.id}" data-title="${escapeHtml(a.title)}" data-end="${a.end_at || ''}"><svg class="icon sm"><use href="#i-clock"/></svg> Edit End Time</button>`);
    }

    return `<div class="assignment-item" data-exam-id="${a.id}">
      <b>${escapeHtml(a.title)}</b>
      ${a.course_name ? `<span class="badge blue">${escapeHtml(a.course_name)}</span>` : ''}
      ${a.module ? `<span class="badge gold">${escapeHtml(a.module)}</span>` : ''}
      ${a.batch ? `<span class="badge green">Batch ${escapeHtml(a.batch)}</span>` : ''}
      <span class="badge ${status.cls}">${status.label}</span>
      <div class="meta">
        ${startText ? `<svg class="icon sm"><use href="#i-play"/></svg> Start: ${startText} &middot; ` : ''}${endText ? `<svg class="icon sm"><use href="#i-flag"/></svg> End: ${endText}` : 'No end time set'}
        &middot; <svg class="icon sm"><use href="#i-users"/></svg> ${a.submission_count} upload${a.submission_count === 1 ? '' : 's'}
      </div>
      <div class="actions">${actionParts.join(' ')}</div>
    </div>`;
  }).join('');

  container.querySelectorAll('[data-preview-file]').forEach(btn => {
    btn.addEventListener('click', () => openFilePreview(btn.dataset.previewFile, btn.dataset.previewName, btn.dataset.previewTitle));
  });
  container.querySelectorAll('[data-exam-submit]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('examSubmitModalTitle').textContent = `Upload: ${btn.dataset.title}`;
      document.getElementById('exsExamId').value = btn.dataset.examSubmit;
      document.getElementById('exsFile').value = '';
      openModal('examSubmitModal');
    });
  });
  container.querySelectorAll('[data-exam-edit-deadline]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('eexExamId').value = btn.dataset.examEditDeadline;
      document.getElementById('eexExamTitle').textContent = btn.dataset.title;
      document.getElementById('eexEnd').value = btn.dataset.end ? btn.dataset.end.replace(' ', 'T').slice(0, 16) : '';
      openModal('examEditDeadlineModal');
    });
  });
  container.querySelectorAll('[data-exam-view-subs]').forEach(btn => {
    btn.addEventListener('click', () => openExamSubmissionsModal(btn.dataset.examViewSubs, btn.dataset.title));
  });
}

// ========== TIMETABLE ==========
const TIMETABLE_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const TIMETABLE_ROWS = [
  { type: 'module', slot: 0, time: '8.30 AM - 10.30 AM' },
  { type: 'break', time: '10.30 AM - 10.45 AM', label: 'Breakfast' },
  { type: 'module', slot: 1, time: '10.45 AM - 12.15 PM' },
  { type: 'break', time: '12.15 PM - 12.45 PM', label: 'Lunch' },
  { type: 'module', slot: 2, time: '12.45 PM - 2.45 PM' },
  { type: 'module', slot: 3, time: '2.45 PM - 4.15 PM' },
];
let currentTimetableModuleOptions = [];

async function populateTimetableCourseOptions() {
  if (!courseCache.length) { const r = await api('/courses'); courseCache = r.courses; }
  const sel = document.getElementById('ttCourse');

  let availableCourses = courseCache;
  if (currentUser.role === 'instructor') {
    const myRows = await getMyLecturerRows();
    const myCourseIds = new Set(myRows.map(l => l.course_id));
    availableCourses = courseCache.filter(c => myCourseIds.has(c.id));
  } else if (currentUser.role === 'student') {
    const { courses: mine } = await api('/courses/mine');
    const myCourseIds = new Set(mine.map(c => c.id));
    availableCourses = courseCache.filter(c => myCourseIds.has(c.id));
  }

  if (currentUser.role !== 'admin' && availableCourses.length === 1) {
    sel.innerHTML = `<option value="${availableCourses[0].id}">${escapeHtml(availableCourses[0].name)}</option>`;
    sel.disabled = true;
    return;
  }

  sel.disabled = false;
  const previous = sel.value;
  sel.innerHTML = '<option value="">-- Select course --</option>' +
    availableCourses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if (previous) sel.value = previous;
}

function timetableModuleSelectHtml(selectedModule) {
  let matched = false;
  let html = '<option value="">-- Free --</option>' + currentTimetableModuleOptions.map(o => {
    const sel = o.module === selectedModule;
    if (sel) matched = true;
    const label = o.module + (o.code ? ` (${o.code})` : '');
    return `<option value="${escapeHtml(o.module)}" ${sel ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
  if (selectedModule && !matched) html += `<option value="${escapeHtml(selectedModule)}" selected>${escapeHtml(selectedModule)}</option>`;
  return html;
}

function renderTimetableTable(schedule, isAdmin) {
  const body = document.getElementById('timetableBody');
  body.innerHTML = TIMETABLE_ROWS.map(row => {
    if (row.type === 'break') {
      return `<tr class="tt-break-row"><td>${row.time}</td><td colspan="5">${escapeHtml(row.label)}</td></tr>`;
    }
    const cells = TIMETABLE_DAYS.map(day => {
      const value = (schedule[day] && schedule[day][row.slot]) || '';
      if (isAdmin) {
        return `<td><select class="tt-cell" data-day="${day}" data-slot="${row.slot}">${timetableModuleSelectHtml(value)}</select></td>`;
      }
      return `<td>${value ? escapeHtml(value) : '<span style="color:var(--muted)">-</span>'}</td>`;
    }).join('');
    return `<tr><td>${row.time}</td>${cells}</tr>`;
  }).join('');
}

async function renderTimetable() {
  await populateTimetableCourseOptions();
  const isAdmin = currentUser.role === 'admin';
  const saveBtn = document.getElementById('saveTimetableBtn');
  saveBtn.style.display = 'none';
  const courseId = document.getElementById('ttCourse').value;
  if (!courseId) {
    document.getElementById('timetableBody').innerHTML = '<tr><td style="color:var(--muted)">Select a course to view its timetable.</td></tr>';
    return;
  }
  const course = courseCache.find(c => c.id == courseId);
  currentTimetableModuleOptions = computeCourseModuleOptions(course);
  const { schedule } = await api(`/timetable?course_id=${courseId}`);
  renderTimetableTable(schedule, isAdmin);
  if (isAdmin) saveBtn.style.display = 'inline-flex';
}
document.getElementById('ttCourse').addEventListener('change', renderTimetable);

withLoadingClick('saveTimetableBtn', async () => {
  const courseId = document.getElementById('ttCourse').value;
  if (!courseId) return;
  const schedule = {};
  TIMETABLE_DAYS.forEach(d => { schedule[d] = new Array(4).fill(''); });
  document.querySelectorAll('#timetableBody .tt-cell').forEach(sel => {
    schedule[sel.dataset.day][Number(sel.dataset.slot)] = sel.value;
  });
  try {
    await api('/timetable', { method: 'PUT', body: { course_id: Number(courseId), schedule } });
    toast('Timetable saved', 'success');
  } catch (e) { toast(e.message, 'error'); }
});

// ========== RESOURCES (Notes & Past Papers) ==========
function resourceConfig(type) {
  return type === 'notes'
    ? { filterCourseId: 'noteFilterCourse', filterModuleId: 'noteFilterModule', listId: 'noteList', label: 'Notes' }
    : { filterCourseId: 'ppFilterCourse', filterModuleId: 'ppFilterModule', listId: 'pastPaperList', label: 'Past Paper' };
}

async function populateResourceFilterModuleOptions(type) {
  const cfg = resourceConfig(type);
  const sel = document.getElementById(cfg.filterModuleId);
  const courseId = document.getElementById(cfg.filterCourseId).value;
  if (!courseId) { sel.innerHTML = '<option value="">All Modules</option>'; sel.disabled = true; return; }
  sel.disabled = false;
  const options = await allowedModuleOptions(courseId);
  sel.innerHTML = '<option value="">All Modules</option>' +
    options.map(o => `<option value="${escapeHtml(o.module)}">${escapeHtml(o.label)}</option>`).join('');
}

async function populateResourceFilterBar(type) {
  const cfg = resourceConfig(type);
  if (!courseCache.length) { const r = await api('/courses'); courseCache = r.courses; }
  const courseSel = document.getElementById(cfg.filterCourseId);
  const moduleSel = document.getElementById(cfg.filterModuleId);

  let availableCourses = courseCache;
  if (currentUser.role === 'instructor') {
    const myRows = await getMyLecturerRows();
    const myCourseIds = new Set(myRows.map(l => l.course_id));
    availableCourses = courseCache.filter(c => myCourseIds.has(c.id));
  } else if (currentUser.role === 'student') {
    const { courses: mine } = await api('/courses/mine');
    const myCourseIds = new Set(mine.map(c => c.id));
    availableCourses = courseCache.filter(c => myCourseIds.has(c.id));
  }

  if (currentUser.role !== 'admin' && availableCourses.length === 1) {
    const course = availableCourses[0];
    const options = await allowedModuleOptions(course.id);

    courseSel.innerHTML = `<option value="${course.id}">${escapeHtml(course.name)}</option>`;
    courseSel.disabled = true;

    if (options.length <= 1) {
      moduleSel.innerHTML = options.length === 1
        ? `<option value="${escapeHtml(options[0].module)}">${escapeHtml(options[0].label)}</option>`
        : '<option value="">All Modules</option>';
      moduleSel.disabled = true;
    } else {
      moduleSel.disabled = false;
      moduleSel.innerHTML = '<option value="">All Modules</option>' +
        options.map(o => `<option value="${escapeHtml(o.module)}">${escapeHtml(o.label)}</option>`).join('');
    }
    return;
  }

  courseSel.disabled = false;
  courseSel.innerHTML = '<option value="">All Courses</option>' +
    availableCourses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  await populateResourceFilterModuleOptions(type);
}

document.getElementById('noteFilterCourse').addEventListener('change', async () => {
  await populateResourceFilterModuleOptions('notes');
  renderResourceList('notes');
});
document.getElementById('noteFilterModule').addEventListener('change', () => renderResourceList('notes'));
document.getElementById('ppFilterCourse').addEventListener('change', async () => {
  await populateResourceFilterModuleOptions('past_paper');
  renderResourceList('past_paper');
});
document.getElementById('ppFilterModule').addEventListener('change', () => renderResourceList('past_paper'));

async function populateResourceModuleOptions() {
  const courseId = document.getElementById('resCourse').value;
  const options = await allowedModuleOptions(courseId);
  document.getElementById('resModule').innerHTML = '<option value="">-- No specific module --</option>' +
    options.map(o => `<option value="${escapeHtml(o.module)}">${escapeHtml(o.label)}</option>`).join('');
}
document.getElementById('resCourse').addEventListener('change', populateResourceModuleOptions);

async function openResourceUploadModal(type) {
  if (!courseCache.length) { const r = await api('/courses'); courseCache = r.courses; }
  let availableCourses = courseCache;
  if (currentUser.role === 'instructor') {
    const myRows = await getMyLecturerRows();
    const myCourseIds = new Set(myRows.map(l => l.course_id));
    availableCourses = courseCache.filter(c => myCourseIds.has(c.id));
    if (!availableCourses.length) { toast('You are not assigned to teach any course/module yet. Ask an admin to assign you first.', 'error'); return; }
  }
  document.getElementById('resCourse').innerHTML = availableCourses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  document.getElementById('resTypeField').value = type;
  document.getElementById('resourceModalTitle').textContent = type === 'notes' ? 'Upload Notes' : 'Upload Past Paper';
  await populateResourceModuleOptions();
  document.getElementById('resUnitName').value = '';
  document.getElementById('resFile').value = '';
  openModal('resourceModal');
}
document.getElementById('addNoteBtn').addEventListener('click', () => openResourceUploadModal('notes'));
document.getElementById('addPastPaperBtn').addEventListener('click', () => openResourceUploadModal('past_paper'));

withLoadingClick('saveResourceBtn', async () => {
  const type = document.getElementById('resTypeField').value;
  const unitName = document.getElementById('resUnitName').value.trim();
  if (!unitName) { toast('Unit name is required', 'error'); return; }
  const file = document.getElementById('resFile').files[0];
  if (!file) { toast('Please attach a PDF', 'error'); return; }

  const formData = new FormData();
  formData.append('type', type);
  formData.append('course_id', document.getElementById('resCourse').value);
  formData.append('module', document.getElementById('resModule').value);
  formData.append('unit_name', unitName);
  formData.append('file', file);

  try {
    await api('/resources', { method: 'POST', body: formData });
    closeModal('resourceModal');
    toast('Uploaded successfully', 'success');
    renderResourceList(type);
  } catch (e) { toast(e.message, 'error'); }
});

async function renderResourceList(type) {
  const cfg = resourceConfig(type);
  const filterBar = document.getElementById(cfg.filterCourseId);
  if (!filterBar.dataset.loaded) {
    await populateResourceFilterBar(type);
    filterBar.dataset.loaded = 'true';
  }
  const params = new URLSearchParams({ type });
  if (filterBar.value) params.set('course_id', filterBar.value);
  const filterModule = document.getElementById(cfg.filterModuleId).value;
  if (filterModule) params.set('module', filterModule);

  const { resources } = await api(`/resources?${params.toString()}`);
  const container = document.getElementById(cfg.listId);
  if (!resources.length) {
    container.innerHTML = `<p style="color:var(--muted);font-size:12px">No ${cfg.label.toLowerCase()} uploaded yet.</p>`;
    return;
  }

  container.innerHTML = resources.map(r => `
    <div class="assignment-item">
      <b>${escapeHtml(r.unit_name)}</b>
      ${r.course_name ? `<span class="badge blue">${escapeHtml(r.course_name)}</span>` : ''}
      ${r.module ? `<span class="badge gold">${escapeHtml(r.module)}</span>` : ''}
      <div class="meta"><svg class="icon sm"><use href="#i-user"/></svg> ${escapeHtml(r.uploaded_by_name || '')} &middot; <svg class="icon sm"><use href="#i-cal"/></svg> ${formatDateTime(r.created_at)}</div>
      <div class="actions">
        <button class="btn btn-outline-dark btn-sm" data-preview-file="${assetUrl(r.file_path)}" data-preview-name="${escapeHtml(r.file_name)}" data-preview-title="${escapeHtml(r.unit_name)}"><svg class="icon sm"><use href="#i-eye"/></svg> Preview</button>
        <a class="btn btn-outline-dark btn-sm" href="${assetUrl(r.file_path)}" download="${escapeHtml(r.file_name)}"><svg class="icon sm"><use href="#i-download"/></svg> Download</a>
        ${r.can_delete ? `<button class="btn btn-red btn-sm" data-del-resource="${r.id}"><svg class="icon sm"><use href="#i-trash"/></svg> Remove</button>` : ''}
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-preview-file]').forEach(btn => {
    btn.addEventListener('click', () => openFilePreview(btn.dataset.previewFile, btn.dataset.previewName, btn.dataset.previewTitle));
  });
  container.querySelectorAll('[data-del-resource]').forEach(btn => {
    withLoadingClick(btn, async () => {
      if (!(await confirmDialog('Remove this file?', { title: 'Remove file?', confirmText: 'Remove' }))) return;
      try {
        await api(`/resources/${btn.dataset.delResource}`, { method: 'DELETE' });
        toast('File removed', 'success');
        renderResourceList(type);
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

// ========== RESULTS ==========
async function populateResultsFilterBar() {
  if (!courseCache.length) { const r = await api('/courses'); courseCache = r.courses; }
  const courseSel = document.getElementById('resFilterCourse');
  const moduleSel = document.getElementById('resFilterModule');
  const batchSel = document.getElementById('resFilterBatch');

  if (currentUser.role !== 'student') {
    const { batches, latest } = await getBatchOptions();
    populateBatchSelect(batchSel, batches, latest, batchSel.value);
  }

  let availableCourses = courseCache;
  if (currentUser.role === 'instructor') {
    const myRows = await getMyLecturerRows();
    const myCourseIds = new Set(myRows.map(l => l.course_id));
    availableCourses = courseCache.filter(c => myCourseIds.has(c.id));
  } else if (currentUser.role === 'student') {
    const { courses: mine } = await api('/courses/mine');
    const myCourseIds = new Set(mine.map(c => c.id));
    availableCourses = courseCache.filter(c => myCourseIds.has(c.id));
  }

  if (currentUser.role !== 'admin' && availableCourses.length === 1) {
    const course = availableCourses[0];
    const options = await allowedModuleOptions(course.id);

    courseSel.innerHTML = `<option value="${course.id}">${escapeHtml(course.name)}</option>`;
    courseSel.disabled = true;

    if (options.length <= 1) {
      moduleSel.innerHTML = options.length === 1
        ? `<option value="${escapeHtml(options[0].module)}">${escapeHtml(options[0].label)}</option>`
        : '<option value="">All Modules</option>';
      moduleSel.disabled = true;
    } else {
      moduleSel.disabled = false;
      moduleSel.innerHTML = '<option value="">All Modules</option>' +
        options.map(o => `<option value="${escapeHtml(o.module)}">${escapeHtml(o.label)}</option>`).join('');
    }
    return;
  }

  courseSel.disabled = false;
  courseSel.innerHTML = '<option value="">-- Select course --</option>' +
    availableCourses.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  await populateResultsFilterModuleOptions();
}

async function populateResultsFilterModuleOptions() {
  const sel = document.getElementById('resFilterModule');
  const courseId = document.getElementById('resFilterCourse').value;
  if (!courseId) { sel.innerHTML = '<option value="">All Modules</option>'; sel.disabled = true; return; }
  sel.disabled = false;
  const options = await allowedModuleOptions(courseId);
  sel.innerHTML = '<option value="">All Modules</option>' +
    options.map(o => `<option value="${escapeHtml(o.module)}">${escapeHtml(o.label)}</option>`).join('');
}
document.getElementById('resFilterCourse').addEventListener('change', async () => {
  await populateResultsFilterModuleOptions();
  renderResultsModule();
});
document.getElementById('resFilterModule').addEventListener('change', renderResultsModule);
document.getElementById('resFilterBatch').addEventListener('change', renderResultsModule);

function formatMarkCell(cell) {
  if (!cell || !cell.submitted) return '<span class="badge red">Absent</span>';
  if (cell.grade === null || cell.grade === '' || cell.grade === undefined) return '<span class="badge gold">Pending</span>';
  const num = parseFloat(cell.grade);
  if (!isNaN(num) && num < 40) return `<span class="badge red">${escapeHtml(String(cell.grade))} &middot; Fail</span>`;
  return escapeHtml(String(cell.grade));
}

function isFailingCell(cell) {
  if (!cell || !cell.submitted || cell.grade === null || cell.grade === '' || cell.grade === undefined) return false;
  const num = parseFloat(cell.grade);
  return !isNaN(num) && num < 40;
}
function isAbsentCell(cell) {
  return !cell || !cell.submitted;
}

async function renderResultsModule() {
  const filterBar = document.getElementById('resFilterCourse');
  if (!filterBar.dataset.loaded) {
    await populateResultsFilterBar();
    filterBar.dataset.loaded = 'true';
  }
  const courseId = filterBar.value;
  const module = document.getElementById('resFilterModule').value;
  const head = document.getElementById('resultsModuleHead');
  const body = document.getElementById('resultsModuleBody');
  const foot = document.getElementById('resultsModuleFoot');
  foot.innerHTML = '';

  if (!courseId) {
    head.innerHTML = '<th>Student</th>';
    body.innerHTML = '<tr><td style="color:var(--muted)">Select a course to view results.</td></tr>';
    return;
  }

  const params = new URLSearchParams({ course_id: courseId });
  if (module) params.set('module', module);
  if (currentUser.role !== 'student') {
    const filterBatch = document.getElementById('resFilterBatch').value;
    if (filterBatch) params.set('batch', filterBatch);
  }

  let data;
  try {
    data = await api(`/results/module?${params.toString()}`);
  } catch (e) {
    head.innerHTML = '<th>Student</th>';
    body.innerHTML = `<tr><td style="color:var(--red)">${escapeHtml(e.message)}</td></tr>`;
    return;
  }
  const { assignments, exams, students } = data;
  const colCount = 2 + assignments.length + exams.length;

  head.innerHTML = '<th>Student</th>' +
    assignments.map(a => `<th>${escapeHtml(a.title)}<br><small style="font-weight:400;color:var(--muted)">Assignment</small></th>`).join('') +
    exams.map(e => `<th>${escapeHtml(e.title)}<br><small style="font-weight:400;color:var(--muted)">Exam</small></th>`).join('') +
    '<th>Fail/Absent Count<br><small style="font-weight:400;color:var(--muted)">Absent counts as Fail</small></th>';

  if (!students.length) {
    body.innerHTML = `<tr><td colspan="${colCount}" style="color:var(--muted)">No students enrolled in this course.</td></tr>`;
    return;
  }

  // Show the full roster even if this course/module has no assignments or exams yet.
  const studentFailAbsentCount = s => {
    const cells = [...assignments.map(a => s.assignments[a.id]), ...exams.map(e => s.exams[e.id])];
    return cells.filter(c => isAbsentCell(c) || isFailingCell(c)).length;
  };
  body.innerHTML = students.map(s => {
    const count = studentFailAbsentCount(s);
    return `
    <tr>
      <td><b>${escapeHtml(s.student_name)}</b></td>
      ${assignments.map(a => `<td>${formatMarkCell(s.assignments[a.id])}</td>`).join('')}
      ${exams.map(e => `<td>${formatMarkCell(s.exams[e.id])}</td>`).join('')}
      <td><span class="badge ${count > 0 ? 'red' : 'green'}">${count}</span></td>
    </tr>
  `;
  }).join('');

  if (!assignments.length && !exams.length) {
    body.insertAdjacentHTML('beforeend', `<tr><td colspan="${colCount}" style="color:var(--muted)">No assignments or exams found yet.</td></tr>`);
    return;
  }

  const countFor = (key, id) => {
    const cells = students.map(s => s[key][id]);
    return { absent: cells.filter(isAbsentCell).length, fail: cells.filter(isFailingCell).length };
  };
  const totalFailAbsent = students.reduce((sum, s) => sum + studentFailAbsentCount(s), 0);
  foot.innerHTML = `<tr>
    <td>${students.length} student${students.length === 1 ? '' : 's'}</td>
    ${assignments.map(a => { const c = countFor('assignments', a.id); return `<td>Absent: ${c.absent} &middot; Fail: ${c.fail}</td>`; }).join('')}
    ${exams.map(e => { const c = countFor('exams', e.id); return `<td>Absent: ${c.absent} &middot; Fail: ${c.fail}</td>`; }).join('')}
    <td>${totalFailAbsent} total</td>
  </tr>`;
}

// ========== ANNOUNCEMENTS (formerly Forum) ==========
async function renderForum() {
  document.getElementById('threadDetail').style.display = 'none';
  document.getElementById('forumThreads').style.display = 'grid';
  const { threads } = await api('/forum/threads');
  const box = document.getElementById('forumThreads');
  if (!threads.length) { box.innerHTML = '<p style="color:var(--muted);font-size:12px">No announcements yet.</p>'; return; }
  box.innerHTML = threads.map(t => `
    <div class="thread" data-thread="${t.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <b>${escapeHtml(t.title)}</b>
        ${t.can_edit ? `<button class="btn btn-outline-dark btn-sm" data-edit-thread="${t.id}" style="flex:0 0 auto"><svg class="icon sm"><use href="#i-edit"/></svg> Edit</button>` : ''}
      </div>
      <p>Posted by ${escapeHtml(t.author_name)} &middot; ${t.reply_count} replies</p>
    </div>
  `).join('');
  box.querySelectorAll('[data-thread]').forEach(el => el.addEventListener('click', () => openThread(el.dataset.thread)));
  box.querySelectorAll('[data-edit-thread]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = threads.find(x => x.id == btn.dataset.editThread);
      document.getElementById('threadModalTitle').textContent = 'Edit Announcement';
      document.getElementById('threadIdInput').value = t.id;
      document.getElementById('threadTitleInput').value = t.title;
      document.getElementById('threadBodyInput').value = t.body || '';
      openModal('threadModal');
    });
  });
}

document.getElementById('newThreadBtn').addEventListener('click', () => {
  document.getElementById('threadModalTitle').textContent = 'New Announcement';
  document.getElementById('threadIdInput').value = '';
  document.getElementById('threadTitleInput').value = '';
  document.getElementById('threadBodyInput').value = '';
  openModal('threadModal');
});
withLoadingClick('createThreadBtn', async () => {
  const id = document.getElementById('threadIdInput').value;
  const title = document.getElementById('threadTitleInput').value.trim();
  const body = document.getElementById('threadBodyInput').value.trim();
  if (!title) { toast('Title is required', 'error'); return; }
  try {
    if (id) await api(`/forum/threads/${id}`, { method: 'PUT', body: { title, body } });
    else await api('/forum/threads', { method: 'POST', body: { title, body } });
    closeModal('threadModal');
    toast(id ? 'Announcement updated' : 'Announcement posted', 'success');
    renderForum();
  } catch (e) { toast(e.message, 'error'); }
});

document.getElementById('backToThreadsBtn').addEventListener('click', () => {
  document.getElementById('threadDetail').style.display = 'none';
  document.getElementById('forumThreads').style.display = 'grid';
});

async function openThread(id) {
  currentThreadId = id;
  const { threads } = await api('/forum/threads');
  const thread = threads.find(t => t.id == id);
  document.getElementById('threadTitle').textContent = thread.title;
  document.getElementById('threadBody').textContent = thread.body || '';
  document.getElementById('forumThreads').style.display = 'none';
  document.getElementById('threadDetail').style.display = 'block';
  await renderReplies();
}

async function renderReplies() {
  const { replies } = await api(`/forum/threads/${currentThreadId}/replies`);
  document.getElementById('threadReplies').innerHTML = replies.map(r => `
    <div class="reply"><b>${escapeHtml(r.author_name)}</b> <small>${new Date(r.created_at).toLocaleString()}</small><br>${escapeHtml(r.body)}</div>
  `).join('') || '<p style="color:var(--muted);font-size:12px">No replies yet.</p>';
}

withLoadingClick('sendReplyBtn', async () => {
  const input = document.getElementById('replyInput');
  const body = input.value.trim();
  if (!body) return;
  try {
    await api(`/forum/threads/${currentThreadId}/replies`, { method: 'POST', body: { body } });
    input.value = '';
    renderReplies();
    renderForum().then(() => { /* keep list counts fresh in the background */ });
  } catch (e) { toast(e.message, 'error'); }
});

// ========== CAREER ==========
async function renderCareer() {
  const { jobs } = await api('/career');
  const canManage = currentUser.role === 'instructor' || currentUser.role === 'admin';
  document.getElementById('careerList').innerHTML = jobs.map(j => `
    <div class="job">
      <span class="badge ${j.type === 'Internship' ? 'green' : 'gold'}">${j.type}</span>
      <b style="display:block;margin-top:6px">${escapeHtml(j.title)}</b>
      <p>${escapeHtml(j.location || '')} ${j.closes_at ? '&middot; Closes ' + new Date(j.closes_at).toDateString() : ''}</p>
      <p>${escapeHtml(j.description || '')}</p>
      ${canManage ? `<button class="btn btn-red btn-sm" data-del-job="${j.id}" style="margin-top:8px"><svg class="icon sm"><use href="#i-trash"/></svg> Remove</button>` : ''}
    </div>
  `).join('') || '<p style="color:var(--muted);font-size:12px">No openings posted yet.</p>';

  document.querySelectorAll('[data-del-job]').forEach(btn => {
    withLoadingClick(btn, async () => {
      try { await api(`/career/${btn.dataset.delJob}`, { method: 'DELETE' }); renderCareer(); } catch (e) { toast(e.message, 'error'); }
    });
  });
}
document.getElementById('addJobBtn').addEventListener('click', () => {
  document.getElementById('jobTitle').value = '';
  document.getElementById('jobType').value = 'Vacancy';
  document.getElementById('jobLocation').value = '';
  document.getElementById('jobCloses').value = '';
  document.getElementById('jobDescription').value = '';
  openModal('jobModal');
});
withLoadingClick('postJobBtn', async () => {
  const body = {
    title: document.getElementById('jobTitle').value.trim(),
    type: document.getElementById('jobType').value,
    location: document.getElementById('jobLocation').value.trim(),
    closes_at: document.getElementById('jobCloses').value || null,
    description: document.getElementById('jobDescription').value.trim(),
  };
  if (!body.title) { toast('Title is required', 'error'); return; }
  try {
    await api('/career', { method: 'POST', body });
    closeModal('jobModal');
    toast('Job posted', 'success');
    renderCareer();
  } catch (e) { toast(e.message, 'error'); }
});

// ========== EVENTS ==========
let eventsCache = [];
async function renderEvents() {
  const { events } = await api('/events');
  eventsCache = events;
  const isAdmin = currentUser.role === 'admin';
  const container = document.getElementById('eventList');

  if (!events.length) {
    container.innerHTML = '<p style="color:var(--muted);font-size:12px">No events yet.</p>';
    return;
  }

  container.innerHTML = events.map(ev => `
    <div class="event-card">
      <h3 style="font-size:14px">${escapeHtml(ev.name)}</h3>
      <div class="meta" style="font-size:11px;color:var(--muted);margin-top:6px">
        ${ev.location ? `<svg class="icon sm"><use href="#i-pin"/></svg> ${escapeHtml(ev.location)}<br>` : ''}
        ${ev.incharge ? `<svg class="icon sm"><use href="#i-user"/></svg> ${escapeHtml(ev.incharge)}<br>` : ''}
        <svg class="icon sm"><use href="#i-cal"/></svg> ${ev.event_at ? new Date(ev.event_at).toLocaleString() : 'No date set'}
      </div>
      ${ev.photos.length ? `<div class="event-photo-grid">${ev.photos.map(p => `
        <img class="event-thumb" src="${assetUrl(p.photo_path)}" data-preview-file="${assetUrl(p.photo_path)}" data-preview-title="${escapeHtml(ev.name)}">
      `).join('')}</div>` : ''}
      <div class="actions" style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        ${ev.pdf_path ? `
          <button class="btn btn-outline-dark btn-sm" data-preview-file="${assetUrl(ev.pdf_path)}" data-preview-name="${escapeHtml(ev.pdf_name || '')}" data-preview-title="${escapeHtml(ev.name)}"><svg class="icon sm"><use href="#i-eye"/></svg> View PDF</button>
          <a class="btn btn-outline-dark btn-sm" href="${assetUrl(ev.pdf_path)}" download="${escapeHtml(ev.pdf_name || '')}"><svg class="icon sm"><use href="#i-download"/></svg> Download</a>
        ` : ''}
        ${isAdmin ? `
          <button class="btn btn-outline-dark btn-sm" data-edit-event="${ev.id}"><svg class="icon sm"><use href="#i-edit"/></svg> Edit</button>
          <button class="btn btn-red btn-sm" data-del-event="${ev.id}"><svg class="icon sm"><use href="#i-trash"/></svg> Remove</button>
        ` : ''}
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-preview-file]').forEach(el => {
    el.addEventListener('click', () => openFilePreview(el.dataset.previewFile, el.dataset.previewName || '', el.dataset.previewTitle));
  });
  container.querySelectorAll('[data-edit-event]').forEach(btn => {
    btn.addEventListener('click', () => {
      const ev = eventsCache.find(e => e.id === Number(btn.dataset.editEvent));
      openEventModal(ev);
    });
  });
  container.querySelectorAll('[data-del-event]').forEach(btn => {
    withLoadingClick(btn, async () => {
      if (!(await confirmDialog('Remove this event and all its photos/PDF? This cannot be undone.', { title: 'Remove event?', confirmText: 'Remove' }))) return;
      try {
        await api(`/events/${btn.dataset.delEvent}`, { method: 'DELETE' });
        toast('Event removed', 'success');
        renderEvents();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

function openEventModal(ev) {
  document.getElementById('eventModalTitle').textContent = ev ? 'Edit Event' : 'New Event';
  document.getElementById('evtId').value = ev ? ev.id : '';
  document.getElementById('evtName').value = ev ? ev.name : '';
  document.getElementById('evtLocation').value = ev ? (ev.location || '') : '';
  document.getElementById('evtIncharge').value = ev ? (ev.incharge || '') : '';
  document.getElementById('evtDate').value = ev && ev.event_at ? new Date(ev.event_at).toISOString().slice(0, 16) : '';
  document.getElementById('evtPhotos').value = '';
  document.getElementById('evtPdf').value = '';
  openModal('eventModal');
}

document.getElementById('addEventBtn').addEventListener('click', () => openEventModal(null));

withLoadingClick('saveEventBtn', async () => {
  const id = document.getElementById('evtId').value;
  const name = document.getElementById('evtName').value.trim();
  if (!name) { toast('Event name is required', 'error'); return; }

  const formData = new FormData();
  formData.append('name', name);
  formData.append('location', document.getElementById('evtLocation').value.trim());
  formData.append('incharge', document.getElementById('evtIncharge').value.trim());
  const date = document.getElementById('evtDate').value;
  formData.append('event_at', date ? date.replace('T', ' ') + ':00' : '');
  const pdfFile = document.getElementById('evtPdf').files[0];
  if (pdfFile) formData.append('pdf', pdfFile);
  Array.from(document.getElementById('evtPhotos').files).forEach(f => formData.append('photos[]', f));

  try {
    if (id) await api(`/events/${id}`, { method: 'PUT', body: formData });
    else await api('/events', { method: 'POST', body: formData });
    closeModal('eventModal');
    toast(id ? 'Event updated' : 'Event created', 'success');
    renderEvents();
  } catch (e) { toast(e.message, 'error'); }
});

// ========== PROFILE ==========
function setProfileFieldVisible(wrapId, labelId, labelText, valueId, value) {
  document.getElementById(wrapId).style.display = 'block';
  if (labelId) document.getElementById(labelId).textContent = labelText;
  document.getElementById(valueId).value = value;
}

async function renderProfile() {
  const { user } = await api('/auth/profile');

  document.getElementById('pfName').value = user.name;
  document.getElementById('pfEmail').value = user.email;

  const initials = user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  document.getElementById('pfPhotoInitials').textContent = initials;
  document.getElementById('pfPhotoInput').value = '';

  document.getElementById('pfCourseWrap').style.display = 'none';
  document.getElementById('pfIdWrap').style.display = 'none';
  document.getElementById('pfModulesWrap').style.display = 'none';
  document.getElementById('pfNicWrap').style.display = 'none';

  let photoUrl = null;

  if (user.role === 'student' && user.studentProfile) {
    const p = user.studentProfile;
    photoUrl = p.photo_url;
    setProfileFieldVisible('pfCourseWrap', 'pfCourseLabel', 'Course', 'pfCourse', p.course_name || 'Not enrolled');
    setProfileFieldVisible('pfIdWrap', 'pfIdLabel', 'MIS Number', 'pfIdValue', p.mis_no || '-');
    setProfileFieldVisible('pfNicWrap', null, '', 'pfNic', p.nic || '-');
  } else if (user.role === 'instructor' && user.lecturerProfiles && user.lecturerProfiles.length) {
    const rows = user.lecturerProfiles;
    photoUrl = rows.find(r => r.photo_url)?.photo_url || null;
    const courseNames = [...new Set(rows.map(r => r.course_name).filter(Boolean))].join(', ');
    const allModules = rows.flatMap(r => parseModuleJson(r.modules)).map(m => m.module).filter(Boolean);
    setProfileFieldVisible('pfCourseWrap', 'pfCourseLabel', 'Course', 'pfCourse', courseNames || 'Not assigned');
    setProfileFieldVisible('pfIdWrap', 'pfIdLabel', 'Lecturer ID', 'pfIdValue', rows[0].lecturer_id || '-');
    setProfileFieldVisible('pfModulesWrap', null, '', 'pfModules', allModules.length ? allModules.join(', ') : 'None assigned');
  }

  const photoImg = document.getElementById('pfPhotoImg');
  const photoInitials = document.getElementById('pfPhotoInitials');
  if (photoUrl) { photoImg.src = assetUrl(photoUrl); photoImg.style.display = 'block'; photoInitials.style.display = 'none'; }
  else { photoImg.style.display = 'none'; photoInitials.style.display = 'grid'; }

  document.getElementById('pfCurrentPass').value = '';
  document.getElementById('pfNewPass').value = '';
  document.getElementById('pfConfirmPass').value = '';
}

withLoadingClick('pfSaveBtn', async () => {
  const name = document.getElementById('pfName').value.trim();
  if (!name) { toast('Name is required', 'error'); return; }

  const formData = new FormData();
  formData.append('name', name);
  const photoFile = document.getElementById('pfPhotoInput').files[0];
  if (photoFile) formData.append('photo', photoFile);

  try {
    await api('/auth/profile', { method: 'PUT', body: formData });
    const { user } = await api('/auth/me');
    currentUser = user;
    localStorage.setItem('vta_user', JSON.stringify(user));
    document.getElementById('userName').textContent = user.name;
    document.getElementById('userAvatar').textContent = user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    toast('Profile updated', 'success');
    renderProfile();
  } catch (e) { toast(e.message, 'error'); }
});

withLoadingClick('pfChangePassBtn', async () => {
  const current = document.getElementById('pfCurrentPass').value;
  const next = document.getElementById('pfNewPass').value;
  const confirm = document.getElementById('pfConfirmPass').value;
  if (!current || !next) { toast('Please fill in both password fields', 'error'); return; }
  if (next !== confirm) { toast('New passwords do not match', 'error'); return; }

  try {
    await api('/auth/password', { method: 'PUT', body: { current_password: current, new_password: next } });
    toast('Password updated successfully', 'success');
    document.getElementById('pfCurrentPass').value = '';
    document.getElementById('pfNewPass').value = '';
    document.getElementById('pfConfirmPass').value = '';
  } catch (e) { toast(e.message, 'error'); }
});

// ========== UTIL ==========
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// ========== INIT ==========
(async function init() {
  // No local token to check anymore - the PHP session cookie is what actually
  // authorizes requests, so just ask the server whether we're logged in.
  try {
    const { user } = await api('/auth/me');
    saveSession(user);
    enterApp();
    return;
  } catch (e) {
    clearSession();
  }
  document.getElementById('loginPage').classList.add('open');
})();
