import {TEAMS, DIVISIONS, getProgress, sanitizePicks, togglePick, encodePicks, decodePicks} from './game.js';

const $ = id => document.getElementById(id);
const STORAGE_KEY = 'playoff-picks-2026-27';
const AUTH_CHANGE_KEY = 'playoff-picks-account-change';
const teamById = new Map(TEAMS.map(team => [team.id, team]));
let picks = [], filter = 'All', search = '', shared = false, toastTimer;
let storedDraft = [];
let session = {user:null, csrfToken:null, prediction:null, score:null};
let sessionLoading = true, accountBusy = false, submitting = false;
let saveTimer, saveChain = Promise.resolve(), authMode = 'login', authGeneration = 0;
let saveLabel = 'Checking account…';
let leaderboardLoading = false;
let recoveryDraft = null;
let sessionUnavailable = false, checkingSession = false, pendingSessionCheck = false;
let submissionContext = null, resetContext = null;
const isLocked = () => session.prediction?.state === 'submitted';
const canViewLeaderboard = () => Boolean(session.user) && isLocked() && !sessionLoading && !accountBusy;
const isReadOnly = () => shared || isLocked() || sessionLoading || accountBusy || submitting;
function predictionContext() {
  return {generation:authGeneration, userId:session.user?.id ?? null,
    revision:session.prediction?.revision || 0, teamIds:encodePicks(picks), shared};
}
function matchesPredictionContext(expected) {
  if (!expected) return false;
  const current = predictionContext();
  return Object.keys(current).every(key => current[key] === expected[key]);
}
function invalidateContextDialogs() {
  if (submissionContext && !matchesPredictionContext(submissionContext)) {
    const changed = submissionContext.userId !== (session.user?.id ?? null)
      || submissionContext.revision !== (session.prediction?.revision || 0)
      || submissionContext.teamIds !== encodePicks(picks) || submissionContext.shared !== shared;
    submissionContext = null;
    $('submit-dialog').close();
    showToast(changed ? 'Your account or picks changed. Review your prediction before submitting.' : 'Your account was refreshed. Review your prediction before submitting.');
  }
  if (resetContext && !matchesPredictionContext(resetContext)) {
    resetContext = null;
    $('reset-dialog').close();
  }
}

try { storedDraft = sanitizePicks(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')); } catch { /* A corrupt draft starts fresh. */ }
picks = [...storedDraft];

const tick = '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2 6l2.5 2.5L10 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const accent = color => ['#FFB81C','#FCB514','#A2AAAD','#69B3E7','#99D9D9'].includes(color) ? ({'#FFB81C':'#987400','#FCB514':'#987400','#A2AAAD':'#596160','#69B3E7':'#377490','#99D9D9':'#2c7a80'}[color]) : color;
function showToast(text) {
  clearTimeout(toastTimer);
  $('toast').textContent = text;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
}
function persist() {
  if (shared) { $('storage-note').textContent = 'Shared snapshot · read only'; return; }
  storedDraft = [...picks];
  if (sessionLoading) { $('storage-note').textContent = sessionUnavailable ? 'Account connection unavailable' : 'Checking account…'; return; }
  if (session.user) { $('storage-note').textContent = saveLabel; return; }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(picks));
    $('storage-note').innerHTML = '<span class="storage-dot"></span> Saved on this device';
    $('storage-note').removeAttribute('title');
  } catch {
    $('storage-note').textContent = 'Saving unavailable';
    $('storage-note').title = 'Keep this page open, or log in to save your picks to an account.';
  }
}
function matchingTeams(division) {
  const query = search.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return TEAMS.filter(team => team.division === division.id && (!query || `${team.city} ${team.name} ${team.id}`.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(query)));
}
function renderBoard() {
  let html = '';
  for (const conf of ['East', 'West']) {
    if (filter !== 'All' && filter !== conf) continue;
    const divisions = DIVISIONS.filter(d => d.conference === conf && matchingTeams(d).length);
    if (!divisions.length) continue;
    html += `<section class="conference-block" aria-labelledby="${conf}-title"><div class="conference-heading"><h3 class="conference-title" id="${conf}-title"><span>${conf === 'East' ? 'E' : 'W'}</span>${conf === 'East' ? 'Eastern' : 'Western'} Conference</h3><span class="conference-meta" data-conference="${conf}"></span></div>`;
    for (const d of divisions) {
      html += `<div class="division-header"><h4 class="division-name" id="${d.id}-title">${d.name} Division</h4><div class="division-meta"><span>Choose 3–5</span><span class="division-count" data-division="${d.id}">0 picked</span></div></div><div class="team-grid" role="group" aria-labelledby="${d.id}-title">`;
      for (const team of matchingTeams(d)) {
        html += `<button type="button" class="team-card" data-team="${team.id}" aria-pressed="false" aria-label="${team.city} ${team.name}"><span class="team-check">${tick}</span><span class="team-emblem" aria-hidden="true"><img class="team-logo" src="logos/${team.id}.svg" width="96" height="64" alt="" decoding="async"></span><span class="team-city">${team.city}</span><span class="team-name">${team.name}</span><span class="team-selected-label" aria-hidden="true">In your playoff field</span></button>`;
      }
      html += '</div>';
    }
    html += '</section>';
  }
  $('teams').innerHTML = html || '<div class="no-results">No teams found. Try a different name or conference.</div>';
  updateBoard();
}
function updateBoard() {
  const progress = getProgress(picks);
  document.querySelectorAll('[data-team]').forEach(button => {
    const selected = picks.includes(button.dataset.team);
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.disabled = isReadOnly();
  });
  document.querySelectorAll('[data-division]').forEach(label => {
    const count = progress.divisions[label.dataset.division];
    label.textContent = `${count} picked`;
    label.classList.toggle('ready', count >= 3);
  });
  document.querySelectorAll('[data-conference]').forEach(label => {
    label.textContent = `${progress[label.dataset.conference === 'East' ? 'east' : 'west']} / 8 selected`;
  });
}
function guidance(progress) {
  if (shared) return isLocked() ? 'You are viewing a public prediction. Your own season prediction stays locked.' : 'You are viewing a public prediction. Use these picks to start a draft, or return to your own picks.';
  if (isLocked() && !shared) return 'Your prediction is locked for the season. Every standings point your teams earn counts toward your score.';
  if (progress.complete) return session.user ? 'Your field is set. Submit it to lock your picks and join the leaderboard.' : 'Your field is set. Create an account or log in to submit your prediction.';
  if (!progress.total) return "Start with the teams you believe in. We'll keep track of the rest.";
  const eastLeft = 8 - progress.east, westLeft = 8 - progress.west;
  const needs = DIVISIONS.filter(d => progress.divisions[d.id] < 3).map(d => `${d.name}: ${3 - progress.divisions[d.id]} more`);
  return `${eastLeft + westLeft} spots to fill${eastLeft === 0 ? ' — Eastern complete' : westLeft === 0 ? ' — Western complete' : ` (${eastLeft} east, ${westLeft} west)`}.${needs.length ? '\nDivision minimums — ' + needs.join('; ') + '.' : '\nDivision minimums met. Choose your remaining wild cards.'}`;
}
function updateSummary() {
  invalidateContextDialogs();
  if (!canViewLeaderboard()) renderLeaderboardLock();
  const showPicker = Boolean(session.user) || shared;
  $('board-layout').classList.toggle('guest', !showPicker);
  $('picker-content').hidden = !showPicker;
  $('prediction').hidden = !showPicker;
  $('board-description').hidden = !showPicker;
  $('board-note').hidden = !showPicker;
  $('mobile-progress').hidden = !showPicker;
  $('choose-teams').hidden = showPicker;
  $('choose-teams').disabled = accountBusy || sessionLoading;
  const progress = getProgress(picks);
  $('total').textContent = String(progress.total).padStart(2, '0');
  $('mobile-count').textContent = `${progress.total} / 16`;
  $('east-count').textContent = `${progress.east} / 8`;
  $('west-count').textContent = `${progress.west} / 8`;
  $('east-bar').style.width = `${progress.east / 8 * 100}%`;
  $('west-bar').style.width = `${progress.west / 8 * 100}%`;
  $('ring').style.strokeDashoffset = 125.66 * (1 - progress.total / 16);
  $('save-status').textContent = shared ? 'Shared' : isLocked() ? 'Locked' : progress.complete ? 'Ready' : 'Draft';
  $('save-status').classList.toggle('locked', isLocked() && !shared);
  $('save-status').classList.toggle('complete', progress.complete);
  $('guidance').textContent = guidance(progress);
  $('guidance').classList.toggle('ready', progress.complete);
  $('reset').disabled = isReadOnly() || !progress.total;
  $('retry-save').hidden = !session.user || isLocked() || shared || !saveLabel.startsWith('Not saved');
  $('retry-session').hidden = !sessionUnavailable;
  $('submit-prediction').disabled = !progress.complete || isReadOnly();
  $('confirm-submit').disabled = isReadOnly() || !progress.complete || !matchesPredictionContext(submissionContext);
  $('confirm-reset').disabled = isReadOnly() || !matchesPredictionContext(resetContext);
  $('submit-prediction').textContent = submitting ? 'Submitting…' : isLocked() && !shared ? 'Prediction locked ✓' : session.user ? 'Submit prediction ↗' : 'Log in to submit ↗';
  $('account-score').hidden = !session.user || !isLocked() || shared;
  $('account-points').textContent = Number.isInteger(session.score) ? `${session.score} pts` : '—';
  $('adopt-picks').disabled = isLocked() || accountBusy || submitting || sessionLoading;
  $('adopt-picks').title = isLocked() ? 'Your submitted prediction is already locked for this season.' : '';

  $('shared-banner').hidden = !shared;
  $('shared-description').textContent = `${progress.complete ? 'Complete prediction' : 'Draft prediction'} · ${progress.total} of 16 teams. ${session.user ? 'Your own prediction stays saved to your account.' : 'Your own draft is still saved on this device.'}`;
  if (!picks.length) {
    $('selected-teams').innerHTML = '<div class="empty-state"><svg viewBox="0 0 36 36" fill="none" aria-hidden="true"><rect x="5" y="7" width="26" height="22" rx="9" stroke="currentColor"/><path d="M18 7v22M12 7v22M24 7v22" stroke="currentColor" stroke-dasharray="2 2"/><circle cx="18" cy="18" r="4" stroke="currentColor"/></svg><strong>A blank sheet of ice.</strong><p>Your playoff field starts with one pick.<br>Who’s your first contender?</p></div>';
  } else {
    $('selected-teams').innerHTML = ['East','West'].map(conf => {
      const selected = TEAMS.filter(team => team.conference === conf && picks.includes(team.id));
      if (!selected.length) return '';
      return `<div class="selected-group"><div class="selected-group-title"><span>${conf === 'East' ? 'Eastern' : 'Western'} picks</span><span>${selected.length} / 8</span></div>${selected.map(team => `<div class="selected-row"><span class="selected-code" style="--team-color:${accent(team.color)}">${team.id}</span><span>${team.city} ${team.name}</span>${shared || isLocked() ? '' : `<button type="button" class="remove-pick" data-remove="${team.id}" aria-label="Remove ${team.city} ${team.name}">×</button>`}</div>`).join('')}</div>`;
    }).join('');
  }
  persist();
}
function changePick(id) {
  if (isReadOnly()) return;
  const result = togglePick(picks, id);
  if (result.error) { showToast(result.error); return; }
  const wasComplete = getProgress(picks).complete;
  picks = result.picks;
  scheduleAccountSave();
  updateBoard();
  updateSummary();
  const team = teamById.get(id);
  if (!wasComplete && getProgress(picks).complete) showToast('All 16 picked. Your playoff prediction is ready!');
  else showToast(`${team.city} ${team.name} ${picks.includes(id) ? 'added to' : 'removed from'} your field.`);
}
function clearShareHash() {
  const url = new URL(location.href);
  url.searchParams.delete('picks');
  if (url.hash.startsWith('#picks=')) url.hash = '';
  history.replaceState(null, '', url.href);
}
function readShared() {
  const url = new URL(location.href);
  const legacy = !url.searchParams.has('picks') && url.hash.startsWith('#picks=');
  const params = legacy ? new URLSearchParams(url.hash.slice(1)) : url.searchParams;
  if (!params.has('picks')) return false;
  const result = params.getAll('picks').length === 1 ? decodePicks(params.get('picks')) : null;
  if (result === null) {
    showToast('This prediction link is invalid. Your saved draft has been restored.');
    shared = false;
    picks = [...storedDraft];
    clearShareHash();
    return false;
  }
  if (!canViewLeaderboard()) {
    shared = false;
    picks = [...storedDraft];
    return false;
  }
  picks = result;
  shared = true;
  if (legacy) {
    url.searchParams.set('picks', encodePicks(result));
    url.hash = '';
    history.replaceState(null, '', url.href);
  }
  return true;
}
$('teams').addEventListener('click', event => {
  const button = event.target.closest('[data-team]');
  if (button) changePick(button.dataset.team);
});
$('selected-teams').addEventListener('click', event => {
  const button = event.target.closest('[data-remove]');
  if (!button) return;
  const id = button.dataset.remove;
  const next = button.closest('.selected-row').nextElementSibling?.querySelector('button')?.dataset.remove;
  changePick(id);
  const boardButton = document.querySelector(`[data-team="${id}"]`);
  const summaryButton = next ? document.querySelector(`[data-remove="${next}"]`) : null;
  (summaryButton || boardButton || $('prediction')).focus({preventScroll:true});
});
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  filter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(b => { const active = b === button; b.classList.toggle('active',active); b.setAttribute('aria-pressed',String(active)); });
  renderBoard();
}));
$('search').addEventListener('input', event => { search = event.target.value; renderBoard(); });
$('reset').addEventListener('click', () => { if (!isReadOnly() && picks.length) { resetContext = predictionContext(); $('reset-dialog').showModal(); updateSummary(); } });
$('reset-dialog').addEventListener('close', () => { if (!$('reset-dialog').open) resetContext = null; });
$('cancel-reset').addEventListener('click', () => $('reset-dialog').close());
$('confirm-reset').addEventListener('click', () => {
  if (isReadOnly() || !$('reset-dialog').open || !matchesPredictionContext(resetContext)) return;
  picks = [];
  scheduleAccountSave();
  $('reset-dialog').close();
  updateBoard();
  updateSummary();
  document.querySelector('[data-team]')?.focus({preventScroll:true});
  showToast('A fresh sheet of ice. Your draft has been cleared.');
});
$('adopt-picks').addEventListener('click', () => {
  if (isLocked() || accountBusy || submitting || sessionLoading) return;
  shared = false;
  scheduleAccountSave();
  clearShareHash();
  updateBoard();
  updateSummary();
  $('team-board').focus({preventScroll:true});
  showToast('These picks are now your draft. Make them your own.');
});
$('own-picks').addEventListener('click', () => {
  shared = false;
  picks = [...storedDraft];
  clearShareHash();
  updateBoard();
  updateSummary();
  $('team-board').focus({preventScroll:true});
  showToast('Back to your saved draft.');
});
function syncRoute() {
  if (!readShared() && shared) { shared = false; picks = [...storedDraft]; }
  updateBoard();
  updateSummary();
}
window.addEventListener('hashchange', syncRoute);
window.addEventListener('popstate', syncRoute);
window.addEventListener('storage', event => {
  if (event.key === AUTH_CHANGE_KEY) { reconcileSignIn({announce:false}); return; }
  if (session.user || event.key !== STORAGE_KEY) return;
  try { storedDraft = sanitizePicks(JSON.parse(event.newValue || '[]')); } catch { storedDraft = []; }
  if (!shared) { picks = [...storedDraft]; updateBoard(); updateSummary(); }
});
window.addEventListener('focus', () => { if (!document.hidden) reconcileSignIn({announce:false}); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) reconcileSignIn({announce:false}); });
readShared();
renderBoard();
updateSummary();
initializeAccounts();
loadLeaderboard();
setInterval(() => { if (!document.hidden) loadLeaderboard(); }, 60000);

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
async function api(path, options = {}) {
  const headers = {...options.headers};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (session.csrfToken) headers['X-CSRF-Token'] = session.csrfToken;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    let response;
    try { response = await fetch(path, {...options, headers, credentials:'same-origin', cache:'no-store', body: options.body === undefined ? undefined : JSON.stringify(options.body), signal:controller.signal}); }
    catch { throw new Error('The connection failed. Please try again.'); }
    let data;
    try { data = await response.json(); } catch { throw new Error('The account service is unavailable. Please try again.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The account service is unavailable. Please try again.');
    if (!response.ok) { const error = new Error(response.status === 503 ? 'The account service is busy. Please wait a few seconds and try again.' : data.error || 'Something went wrong. Please try again.'); error.status = response.status; throw error; }
    return data;
  } finally { clearTimeout(timeout); }
}
function renderAccountControls() {
  $('auth-submit').disabled = accountBusy || sessionLoading;
  if (session.user) {
    $('auth-controls').innerHTML = `<span class="account-header-name"><span class="account-avatar" aria-hidden="true">${htmlEscape(session.user.displayName.slice(0,1).toUpperCase())}</span>${htmlEscape(session.user.displayName)}</span><button type="button" id="logout" class="text-button">Log out</button>`;
    $('logout').disabled = accountBusy || submitting;
    $('logout').addEventListener('click', logout);
  } else {
    $('auth-controls').innerHTML = '<button type="button" id="open-login" class="login-button">Log in</button>';
    $('open-login').disabled = accountBusy || sessionLoading;
    $('open-login').addEventListener('click', () => openAuth('login'));
  }
}
function applySession(data, {initialPicks = []} = {}) {
  authGeneration++;
  session = data;
  sessionLoading = false;
  sessionUnavailable = false;
  accountBusy = false;
  clearTimeout(saveTimer);
  storedDraft = session.user ? [...(session.prediction?.teamIds || initialPicks)] : readGuestDraft();
  shared = false;
  picks = [...storedDraft];
  readShared();
  saveLabel = session.user ? session.prediction ? 'Saved to your account' : 'Account draft ready' : '';
  renderAccountControls();
  updateBoard();
  updateSummary();
  void loadLeaderboard();
}
function readGuestDraft() {
  try { return sanitizePicks(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')); } catch { return []; }
}
function initializeAccounts() { return reconcileSignIn({announce:false}); }
function scheduleAccountSave() {
  if (!session.user || shared || isLocked() || submitting) return;
  clearTimeout(saveTimer);
  saveLabel = 'Saving to your account…';
  const generation = authGeneration;
  saveTimer = setTimeout(() => {
    saveChain = saveChain.then(() => saveAccountDraft(generation));
  }, 600);
}
async function saveAccountDraft(generation = authGeneration) {
  if (generation !== authGeneration || !session.user || shared || isLocked()) return true;
  if (sessionLoading) return false;
  const current = [...picks];
  try {
    const data = await api('/api/prediction', {method:'PUT', body:{teamIds:current, revision:session.prediction?.revision || 0}});
    if (generation !== authGeneration) return false;
    session.prediction = data.prediction;
    session.score = data.score;
    invalidateContextDialogs();
    saveLabel = encodePicks(picks) === encodePicks(current) ? 'Saved to your account' : 'Saving to your account…';
    $('storage-note').textContent = saveLabel;
    $('retry-save').hidden = true;
    return true;
  } catch (error) {
    if (generation !== authGeneration) return false;
    saveLabel = 'Not saved — retry your changes';
    $('storage-note').textContent = saveLabel;
    $('retry-save').hidden = false;
    if (error.status === 401 || error.status === 403) { await reconcileSignIn({waitForSave:false}); }
    else if (error.status === 409) {
      try { const fresh = await api('/api/session'); if (generation !== authGeneration) return false; applySession(fresh); showToast('Your account changed in another tab. The latest prediction has been loaded.'); } catch { showToast(error.message); }
    } else showToast(`Your picks couldn't be saved. ${error.message}`);
    return false;
  }
}
$('choose-teams').addEventListener('click', () => openAuth('register'));
function openAuth(mode = 'login') {
  if (accountBusy || submitting || sessionLoading || session.user) return;
  setAuthMode(mode);
  $('auth-dialog').showModal();
  $('account-username').focus();
}
function setAuthMode(mode) {
  authMode = mode;
  const register = mode === 'register';
  $('auth-title').textContent = register ? 'Make your call count.' : 'Welcome back.';
  $('auth-description').textContent = register ? 'Create an account to keep your prediction and compete on the leaderboard.' : 'Log in to return to your saved prediction.';
  $('auth-login-tab').setAttribute('aria-pressed', String(!register));
  $('auth-register-tab').setAttribute('aria-pressed', String(register));
  $('password-confirm-row').hidden = !register;
  $('account-password-confirm').required = register;
  $('account-password').autocomplete = register ? 'new-password' : 'current-password';
  $('account-password').minLength = 7;
  $('account-password-confirm').minLength = 7;
  $('password-hint').textContent = register ? 'Use 7–128 characters. A unique passphrase works well.' : 'Use the password you created for this account.';
  $('auth-submit').textContent = register ? 'Create account' : 'Log in';
  $('auth-error').textContent = '';
  $('account-password').value = '';
  $('account-password-confirm').value = '';
}
$('auth-login-tab').addEventListener('click', () => setAuthMode('login'));
$('auth-register-tab').addEventListener('click', () => setAuthMode('register'));
$('auth-dialog').addEventListener('close', () => {
  $('account-password').value = '';
  $('account-password-confirm').value = '';
});
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (accountBusy || sessionLoading || session.user) return;
  const password = $('account-password').value;
  const passwordLength = Array.from(password).length;
  if (passwordLength < 7 || passwordLength > 128) { $('auth-error').textContent = 'Use a password with 7–128 characters.'; return; }
  if (authMode === 'register' && password !== $('account-password-confirm').value) { $('auth-error').textContent = 'The passwords do not match.'; return; }
  const guestPicks = !shared && !session.user ? [...picks] : [];
  accountBusy = true;
  $('auth-submit').disabled = true;
  $('auth-login-tab').disabled = true;
  $('auth-register-tab').disabled = true;
  $('auth-error').textContent = '';
  updateBoard();
  try {
    const mode = authMode;
    const data = await api(mode === 'register' ? '/api/register' : '/api/login', {method:'POST', body:{username:$('account-username').value, password}});
    const restored = recoveryDraft?.userId === data.user.id && data.prediction?.state !== 'submitted'
      && (data.prediction?.revision || 0) === recoveryDraft.revision ? recoveryDraft.teamIds : null;
    const imported = !data.prediction ? guestPicks : [];
    applySession(data, {initialPicks:imported});
    if (restored) { picks = [...restored]; storedDraft = [...restored]; updateBoard(); updateSummary(); }
    recoveryDraft = null;
    notifyAccountChange();
    $('auth-dialog').close();
    $('account-password').value = '';
    $('account-password-confirm').value = '';
    if ((imported.length || restored) && !shared && !isLocked()) scheduleAccountSave();
    showToast(mode === 'register' ? 'Your account is ready. Your picks will be saved to it.' : `Welcome back, ${session.user.displayName}.`);
    loadLeaderboard();
  } catch (error) {
    accountBusy = false;
    $('account-password').value = '';
    $('account-password-confirm').value = '';
    $('auth-error').textContent = error.message;
    updateBoard();
    updateSummary();
  } finally {
    $('auth-submit').disabled = false;
    $('auth-login-tab').disabled = false;
    $('auth-register-tab').disabled = false;
    if (pendingSessionCheck) { pendingSessionCheck = false; reconcileSignIn({announce:false}); }
  }
});
async function logout() {
  if (accountBusy || submitting) return;
  accountBusy = true;
  renderLeaderboardLock();
  renderAccountControls();
  updateBoard();
  clearTimeout(saveTimer);
  try {
    await saveChain;
    const saved = isLocked() || shared || await saveAccountDraft();
    await api('/api/logout', {method:'POST', body:{}});
    recoveryDraft = null;
    shared = false;
    clearShareHash();
    applySession({user:null,csrfToken:null,prediction:null,score:null});
    notifyAccountChange();
    showToast(saved ? 'You are logged out. Your account prediction stays saved.' : 'You are logged out. Your last saved account prediction is safe; the latest changes could not be saved.');
    loadLeaderboard();
  } catch (error) { accountBusy = false; if (error.status === 401 || error.status === 403) await reconcileSignIn(); else { renderAccountControls(); updateBoard(); showToast(error.message); } }
  finally { if (pendingSessionCheck) { pendingSessionCheck = false; reconcileSignIn({announce:false}); } }
}
$('submit-prediction').addEventListener('click', async () => {
  if (!getProgress(picks).complete || isReadOnly()) return;
  if (!session.user) { openAuth('login'); return; }
  clearTimeout(saveTimer);
  const opening = predictionContext();
  await saveChain;
  if (isReadOnly() || !session.user || opening.generation !== authGeneration || opening.userId !== session.user.id || opening.teamIds !== encodePicks(picks)) return;
  submissionContext = predictionContext();
  $('submit-error').textContent = '';
  $('submit-dialog').showModal();
  updateSummary();
});
$('submit-dialog').addEventListener('close', () => {
  if ($('submit-dialog').open) return;
  const cancelled = !submitting && matchesPredictionContext(submissionContext);
  submissionContext = null;
  if (cancelled && !isReadOnly() && session.user) scheduleAccountSave();
});
$('cancel-submit').addEventListener('click', () => { if (!submitting) $('submit-dialog').close(); });
$('confirm-submit').addEventListener('click', async () => {
  if (isReadOnly() || !session.user || !$('submit-dialog').open || !matchesPredictionContext(submissionContext)) return;
  const confirmed = submissionContext;
  submitting = true;
  clearTimeout(saveTimer);
  $('confirm-submit').disabled = true;
  $('cancel-submit').disabled = true;
  $('submit-error').textContent = '';
  updateBoard();
  updateSummary();
  const generation = authGeneration;
  try {
    await saveChain;
    if (generation !== authGeneration || sessionLoading || accountBusy || !matchesPredictionContext(confirmed) || !getProgress(picks).complete) throw new Error('Your account changed. Review your picks before submitting.');
    const data = await api('/api/prediction/submit', {method:'POST', body:{teamIds:[...picks],revision:confirmed.revision}});
    if (generation !== authGeneration) return;
    session.prediction = data.prediction;
    session.score = data.score;
    saveLabel = 'Submitted · saved to your account';
    $('submit-dialog').close();
    showToast('Your prediction is locked. You are on the leaderboard!');
    await loadLeaderboard();
  } catch (error) {
    if (generation !== authGeneration) return;
    $('submit-error').textContent = error.message;
    if (error.status === 401 || error.status === 403) await reconcileSignIn();
    else if (error.status === 409) {
      try { const fresh = await api('/api/session'); if (generation === authGeneration) applySession(fresh); } catch { /* Keep the local view for a retry. */ }
    }
  } finally {
    submitting = false;
    $('confirm-submit').disabled = false;
    $('cancel-submit').disabled = false;
    renderAccountControls();
    updateBoard();
    updateSummary();
    if (pendingSessionCheck) { pendingSessionCheck = false; reconcileSignIn({announce:false}); }
  }
});
function readableDate(value) {
  if (!value) return '';
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-GB', {timeZone:'Europe/Helsinki',day:'numeric',month:'short',year:'numeric'});
}
function renderLeaderboardLock() {
  $('score-source').classList.remove('available');
  $('score-source').textContent = 'Unlocks after you submit your prediction';
  $('leaderboard-status').textContent = '';
  $('refresh-leaderboard').hidden = true;
  $('refresh-leaderboard').disabled = true;
  $('leaderboard-body').innerHTML = '<div class="leaderboard-empty"><strong>Make your prediction first.</strong>Submit and lock your 16 teams to reveal the leaderboard and other players’ picks.<br><button type="button" id="leaderboard-unlock" class="small-button">'+(session.user ? 'Finish my prediction ↗' : 'Choose your teams ↗')+'</button></div>';
  $('leaderboard-unlock').disabled = sessionLoading || accountBusy;
  $('leaderboard-unlock').addEventListener('click', () => {
    if (session.user) { $('team-board').scrollIntoView({behavior:'smooth'}); $('team-board').focus({preventScroll:true}); }
    else openAuth('register');
  });
}
async function loadLeaderboard() {
  if (!canViewLeaderboard()) { renderLeaderboardLock(); return; }
  if (leaderboardLoading) return;
  const generation = authGeneration;
  leaderboardLoading = true;
  $('refresh-leaderboard').hidden = false;
  $('refresh-leaderboard').disabled = true;
  try {
    const data = await api('/api/leaderboard');
    if (generation !== authGeneration || !canViewLeaderboard()) return;
    if (data.locked) { renderLeaderboardLock(); await reconcileSignIn({announce:false}); return; }
    const scoring = data.scoring;
    $('score-source').classList.toggle('available', Boolean(scoring.available && !scoring.stale && !scoring.error));
    $('score-source').textContent = scoring.available ? `${scoring.stale || scoring.error ? 'Last verified' : 'NHL standings'} · ${readableDate(scoring.asOf)}` : 'Waiting for verified 2026–27 NHL points';
    $('leaderboard-status').textContent = !scoring.available ? 'Live NHL points are unavailable. Predictions are saved; scores and ranks will appear once verified season data is available.' : scoring.stale || scoring.error ? 'The NHL feed is unavailable. These are the last verified scores; they will update when the connection returns.' : '';
    if (!data.entries.length) {
      $('leaderboard-body').innerHTML = '<div class="leaderboard-empty"><strong>The first place is yours to chase.</strong>Submit a complete prediction to put your name on the board.<br><button type="button" id="leaderboard-join" class="small-button">'+(session.user ? 'Make my prediction ↗' : 'Create an account ↗')+'</button></div>';
      $('leaderboard-join').addEventListener('click', () => { if (session.user) $('team-board').scrollIntoView({behavior:'smooth'}); else openAuth('register'); });
    } else {
      $('leaderboard-body').innerHTML = '<table class="leaderboard-table"><thead><tr><th scope="col">Rank</th><th scope="col">Account</th><th scope="col">Prediction</th><th scope="col">Points</th></tr></thead><tbody>'+data.entries.map(entry=>`<tr class="${entry.id === session.user?.id ? 'own-row' : ''}"><td><span class="rank-number">${Number.isInteger(entry.rank) ? entry.rank : '—'}</span></td><td><span class="leaderboard-account"><span class="account-avatar" aria-hidden="true">${htmlEscape(entry.displayName.slice(0,1).toUpperCase())}</span><span>${htmlEscape(entry.displayName)}${entry.id === session.user?.id ? '<span class="you-label">YOU</span>' : ''}</span></span></td><td><a class="leaderboard-picks-link" href="?picks=${encodePicks(entry.teamIds)}#team-board">View 16 picks ↗</a></td><td><strong class="points-number">${Number.isInteger(entry.points) ? entry.points : '—'}<small>PTS</small></strong></td></tr>`).join('')+'</tbody></table>';
    }
    const own = data.entries.find(entry => entry.id === session.user?.id);
    if (own && isLocked()) { session.score = own.points; $('account-points').textContent = Number.isInteger(own.points) ? `${own.points} pts` : '—'; }
  } catch {
    if (generation !== authGeneration || !canViewLeaderboard()) return;
    $('score-source').textContent = 'Leaderboard unavailable';
    $('score-source').classList.remove('available');
    $('leaderboard-status').textContent = 'The leaderboard could not be loaded. Try refreshing the table.';
    if (!$('leaderboard-body').querySelector('table')) $('leaderboard-body').innerHTML = '<p class="leaderboard-empty">The season leaderboard will appear here when the connection returns.</p>';
  } finally {
    leaderboardLoading = false;
    $('refresh-leaderboard').disabled = !canViewLeaderboard();
    if (!canViewLeaderboard()) renderLeaderboardLock();
    else if (generation !== authGeneration) void loadLeaderboard();
  }
}
$('refresh-leaderboard').addEventListener('click', loadLeaderboard);

function notifyAccountChange() {
  try { localStorage.setItem(AUTH_CHANGE_KEY, `${Date.now()}-${Math.random()}`); } catch { /* Focus and visibility checks also reconcile sign-in. */ }
}
async function reconcileSignIn({announce = true, waitForSave = true} = {}) {
  if (checkingSession) return;
  if (accountBusy || submitting) { pendingSessionCheck = true; return; }
  checkingSession = true;
  const generation = authGeneration;
  const previousId = session.user?.id;
  const unsaved = !shared && !isLocked() ? [...picks] : null;
  sessionLoading = true;
  sessionUnavailable = false;
  clearTimeout(saveTimer);
  renderAccountControls();
  updateBoard();
  updateSummary();
  try {
    // Let an already-running save finish before comparing revisions. Editing
    // stays paused so a focus check cannot discard the next unsaved change.
    if (waitForSave) await saveChain;
    if (generation !== authGeneration) return;
    const previousRevision = session.prediction?.revision || 0;
    const fresh = await api('/api/session');
    if (generation !== authGeneration) return;
    const sameAccount = fresh.user?.id === previousId;
    const canRestore = Boolean(previousId) && sameAccount && fresh.prediction?.state !== 'submitted'
      && (fresh.prediction?.revision || 0) === previousRevision;
    if (!fresh.user && previousId && unsaved) recoveryDraft = {userId:previousId,teamIds:unsaved,revision:previousRevision};
    applySession(fresh);
    if (unsaved && canRestore) {
      picks = [...unsaved];
      storedDraft = [...unsaved];
      updateBoard();
      updateSummary();
      if (encodePicks(unsaved) !== encodePicks(fresh.prediction?.teamIds || [])) scheduleAccountSave();
    }
    if (previousId && !fresh.user) showToast('Your session ended. Log in again to recover your unsaved account draft.');
    else if (previousId && !sameAccount) showToast('Your sign-in changed. The current account and prediction have been loaded.');
    else if (unsaved && previousId && !canRestore && encodePicks(unsaved) !== encodePicks(fresh.prediction?.teamIds || [])) showToast('Your prediction changed in another tab. The latest saved picks have been loaded.');
    else if (announce && previousId) showToast('Your account connection has been checked.');
  } catch {
    if (generation !== authGeneration) return;
    accountBusy = false;
    sessionUnavailable = true;
    renderAccountControls();
    updateBoard();
    updateSummary();
    if (announce) showToast('Your sign-in could not be checked. Reconnect before editing or submitting.');
  } finally { checkingSession = false; }
}
$('retry-session').addEventListener('click', () => reconcileSignIn());
$('retry-save').addEventListener('click', () => {
  if (!session.user || isReadOnly()) return;
  clearTimeout(saveTimer);
  saveLabel = 'Saving to your account…';
  $('storage-note').textContent = saveLabel;
  const generation = authGeneration;
  saveChain = saveChain.then(() => saveAccountDraft(generation));
});
