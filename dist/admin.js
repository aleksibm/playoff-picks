import { TEAMS, SEASON } from '/game.js';

const byId = new Map(TEAMS.map(team => [team.id, team]));
const el = id => document.getElementById(id);
let overview = null;
let selectedAccountId = null;
let busy = false;
let accountAction = null;
let telegramBusy = false;
let telegramDirty = false;

function renderAccountActions() {
  const account = overview?.accounts.find(item => item.id === selectedAccountId);
  el('rename-account').disabled = busy || !account;
  el('change-password').disabled = busy || !account;
  el('reset-selections').disabled = busy || !account?.prediction?.teamIds.length;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function date(value, options = {}) {
  if (!value) return '—';
  const parsed = new Date(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...options });
}

function dateTime(value, timeZone) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
}

function accountName(account) { return account.displayName || account.username; }
function points(value) { return Number.isFinite(value) ? String(value) : '—'; }
function predictionState(prediction) { return !prediction ? 'No prediction' : prediction.state === 'submitted' ? 'Locked' : 'Draft'; }
function badge(prediction) { return node('span', `state-badge${prediction ? prediction.state === 'submitted' ? ' locked' : ' draft' : ''}`, predictionState(prediction)); }

function renderAccounts() {
  if (!overview) return;
  const search = el('account-search').value.trim().toLowerCase();
  const accounts = overview.accounts.filter(account => `${account.username} ${accountName(account)}`.toLowerCase().includes(search));
  el('account-count').textContent = search ? `${accounts.length} of ${overview.accounts.length}` : `${accounts.length} account${accounts.length === 1 ? '' : 's'}`;
  const rows = accounts.map(account => {
    const row = node('tr', String(account.id) === String(selectedAccountId) ? 'selected' : '');
    const player = node('td');
    const button = node('button', 'account-button');
    button.type = 'button';
    button.setAttribute('aria-label', `Inspect ${accountName(account)}'s prediction`);
    button.setAttribute('aria-pressed', String(String(account.id) === String(selectedAccountId)));
    const avatar = node('span', 'account-avatar', String(accountName(account)).slice(0, 1).toUpperCase());
    avatar.setAttribute('aria-hidden', 'true');
    button.append(avatar, node('span', 'account-name', accountName(account)));
    button.addEventListener('click', () => {
      selectedAccountId = account.id;
      el('account-action-status').textContent = '';
      renderAccounts();
      renderInspector();
      if (window.matchMedia('(max-width: 850px)').matches) {
        el('prediction-inspector').focus({ preventScroll: true });
        el('prediction-inspector').scrollIntoView({ behavior: 'auto', block: 'start' });
      }
    });
    player.append(button);
    const status = node('td');
    status.append(badge(account.prediction));
    const score = node('td', 'points-number', points(account.points));
    score.setAttribute('aria-label', Number.isFinite(account.points) ? `${account.points} points` : 'Not scored');
    row.append(player, status, score, node('td', 'joined-date', date(account.createdAt)));
    return row;
  });
  el('accounts-body').replaceChildren(...rows);
  el('accounts-empty').hidden = accounts.length > 0;
  el('accounts-empty').textContent = search ? 'No accounts match your search.' : 'Accounts will appear here when players join.';
}

function renderInspector() {
  renderAccountActions();
  const account = overview?.accounts.find(item => String(item.id) === String(selectedAccountId));
  el('inspector-empty').hidden = Boolean(account);
  el('inspector-content').hidden = !account;
  el('inspector-badge').hidden = !account;
  if (!account) return;
  const prediction = account.prediction;
  el('inspector-name').textContent = accountName(account);
  const username = accountName(account) === account.username ? '' : `@${account.username} · `;
  el('inspector-meta').textContent = `${username}${prediction?.state === 'submitted' ? `Submitted ${dateTime(prediction.submittedAt)}` : prediction ? `Draft updated ${dateTime(prediction.updatedAt)}` : `Joined ${dateTime(account.createdAt)}`}`;
  const state = badge(prediction);
  el('inspector-badge').className = state.className;
  el('inspector-badge').textContent = state.textContent;
  el('inspector-points').textContent = points(account.points);
  el('inspector-score-label').textContent = prediction?.state === 'submitted' ? 'NHL points' : 'Not on the board';
  const teamIds = Array.isArray(prediction?.teamIds) ? prediction.teamIds : [];
  el('inspector-teams').replaceChildren(...['East', 'West'].map(conference => {
    const section = node('section', 'conference-picks');
    const teams = teamIds.map(id => byId.get(id)).filter(team => team?.conference === conference);
    section.append(node('h4', '', `${conference === 'East' ? 'Eastern' : 'Western'} · ${teams.length}/8`));
    if (!teams.length) section.append(node('p', 'conference-empty', 'No teams selected.'));
    for (const team of teams) {
      const row = node('div', 'team-row');
      const code = node('span', 'team-code', team.id);
      code.style.color = team.color;
      row.append(code, node('span', 'team-name', `${team.city} ${team.name}`), node('span', 'team-points', `${points(overview.teams?.[team.id]?.points)} pts`));
      section.append(row);
    }
    return section;
  }));
  el('inspector-note').textContent = !prediction ? 'This account has not saved a prediction yet.' : prediction.state === 'submitted' ? 'This prediction is locked. Its score uses the selected teams’ full season standings points.' : 'Drafts remain private and can be changed by the player. They enter the leaderboard after submission.';
}

function renderFeed() {
  const scoring = overview.scoring;
  el('standings-date').textContent = scoring.available ? date(scoring.asOf) : 'Unavailable';
  el('standings-summary').textContent = scoring.available ? scoring.stale ? 'Using the last verified update' : 'Verified NHL points' : 'Scores are waiting for the feed';
  const state = el('feed-state');
  state.classList.toggle('warning', !scoring.available || scoring.stale || Boolean(scoring.error));
  state.textContent = scoring.error ? `${scoring.available ? 'Cached standings' : 'Standings unavailable'} · ${scoring.error}` : scoring.available ? scoring.stale ? 'Cached standings · update due' : 'Standings are up to date' : 'Standings unavailable';
  el('feed-as-of').textContent = date(scoring.asOf, { year: 'numeric' });
  el('feed-fetched').textContent = dateTime(scoring.fetchedAt);
  const schedule = overview.server.updateSchedule;
  el('feed-interval').textContent = overview.server.canRefresh ? `Daily at ${schedule.time} · Helsinki` : 'Updates disabled';
  el('feed-next').textContent = overview.server.canRefresh ? dateTime(schedule.nextUpdate, schedule.timeZone) : '—';
  el('refresh-standings').disabled = busy || !overview.server.canRefresh || !overview.csrfToken;
}

function renderLeaders() {
  const leaders = overview.leaderboard.slice(0, 5);
  el('leaders-list').replaceChildren(...leaders.map(account => {
    const row = node('li');
    const score = node('span', 'leader-points', points(account.points));
    score.append(node('small', '', 'pts'));
    row.append(node('span', 'leader-rank', points(account.rank)), node('span', 'leader-name', accountName(account)), score);
    return row;
  }));
  el('leaders-empty').hidden = leaders.length > 0;
}

const updateNames = { standings:'NHL standings', fantasy:'Fantasy scores', roster:'Player roster', history:'Price history', model:'Goalie data', contracts:'Player salaries', market:'Weekly prices' };
function renderUpdates() {
  const updates = overview?.server.updates;
  if (!updates) return;
  const telegram = updates.telegram;
  el('telegram-state').textContent = telegram.enabled ? 'Telegram enabled' : telegram.configured ? 'Alerts disabled' : 'Not configured';
  if (!telegramDirty) {
    el('telegram-chat').value = telegram.chatId;
    el('telegram-enabled').checked = telegram.enabled;
  }
  el('telegram-token').placeholder = telegram.tokenSaved ? 'Token saved · leave blank to keep it' : 'Paste the token from BotFather';
  el('telegram-save').disabled = telegramBusy || !telegram.storageAvailable;
  el('telegram-find').disabled = telegramBusy || !telegram.storageAvailable;
  el('telegram-test').disabled = telegramBusy || telegramDirty || !telegram.configured;
  el('telegram-token').disabled = telegramBusy || !telegram.storageAvailable;
  el('telegram-chat').disabled = telegramBusy || !telegram.storageAvailable;
  el('telegram-enabled').disabled = telegramBusy || !telegram.storageAvailable;
  el('telegram-choices').disabled = telegramBusy;
  el('telegram-delivery').textContent = !telegram.storageAvailable ? 'Telegram settings are available when this app uses a persistent private data directory.'
    : telegram.deliveryError ? `Delivery issue: ${telegram.deliveryError}`
      : telegram.deliveredAt ? `Last message delivered: ${dateTime(telegram.deliveredAt, 'Europe/Helsinki')} · Helsinki` : 'No messages sent yet.';
  el('update-jobs').replaceChildren(...Object.entries(updates.jobs).map(([job, saved]) => {
    const item = node('li', saved.incident ? 'update-job warning' : 'update-job');
    item.append(node('strong', '', updateNames[job] || job), node('span', '', saved.incident ? 'Needs attention' : saved.lastSuccessAt ? 'Verified' : 'Waiting'));
    item.append(node('p', 'field-hint', saved.incident?.reason || `Last verified: ${dateTime(saved.lastSuccessAt, 'Europe/Helsinki')} · Helsinki`));
    return item;
  }));
  const events = updates.recent.filter(entry => entry.event !== 'update.started').slice(0, 12);
  el('updates-empty').hidden = events.length > 0;
  el('update-events').replaceChildren(...events.map(entry => {
    const item = node('li');
    const names = { 'update.failed':'Update failed', 'update.succeeded':'Update verified', 'update.recovered':'Feed recovered', 'telegram.delivered':'Telegram delivered', 'telegram.failed':'Telegram delivery failed', 'telegram.test_delivered':'Test message delivered', 'telegram.test_failed':'Test message failed', 'telegram.configured':'Telegram settings saved' };
    item.append(node('time', '', `${dateTime(entry.time, 'Europe/Helsinki')} · Helsinki`), node('strong', '', `${names[entry.event] || entry.event}${entry.job ? ` · ${updateNames[entry.job] || entry.job}` : ''}`));
    if (entry.reason) item.append(node('p', '', entry.reason));
    return item;
  }));
}

async function telegramAction(action, body) {
  if (telegramBusy || !overview?.csrfToken) return;
  telegramBusy = true;
  el('telegram-status').classList.remove('error');
  el('telegram-status').textContent = action === 'chats' ? 'Looking for messages sent to your bot…' : action === 'test' ? 'Sending a test message…' : 'Saving settings…';
  renderUpdates();
  try {
    const response = await fetch(`/api/admin/notifications/${action}`, {
      method:'POST', headers:{ 'Content-Type':'application/json', 'X-CSRF-Token':overview.csrfToken }, body:JSON.stringify(body), cache:'no-store',
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Telegram setup failed.');
    if (action === 'chats') {
      if (!data.chats.length) throw new Error('No chats found. Open your new bot in Telegram, send /start, then try again.');
      el('telegram-choices').replaceChildren(node('option', '', 'Choose your chat'), ...data.chats.map(chat => {
        const option = node('option', '', `${chat.name} (${chat.id})`); option.value = chat.id; return option;
      }));
      el('telegram-choices').firstElementChild.value = '';
      el('telegram-choices').hidden = data.chats.length === 1;
      el('telegram-choices-label').hidden = data.chats.length === 1;
      if (data.chats.length === 1) { el('telegram-chat').value = data.chats[0].id; telegramDirty = true; }
      el('telegram-status').textContent = data.chats.length === 1 ? 'Chat found. Enable alerts and save your settings.' : 'Select your chat, then save your settings.';
    } else {
      overview = data;
      if (action === 'settings') { telegramDirty = false; el('telegram-token').value = ''; }
      renderUpdates();
      el('telegram-status').textContent = action === 'test' ? 'Test message delivered. Check Telegram.' : overview.server.updates.telegram.enabled ? 'Settings saved. Failure and recovery alerts are enabled.' : 'Settings saved. Notifications are disabled.';
    }
  } catch (error) {
    el('telegram-status').classList.add('error');
    el('telegram-status').textContent = error instanceof TypeError ? 'Cannot reach the local server. Reload the dashboard and try again.' : error.message;
  } finally { delete body.botToken; telegramBusy = false; renderUpdates(); }
}

el('telegram-form').addEventListener('input', () => { telegramDirty = true; renderUpdates(); });
el('telegram-form').addEventListener('submit', event => {
  event.preventDefault();
  void telegramAction('settings', { enabled:el('telegram-enabled').checked, botToken:el('telegram-token').value, chatId:el('telegram-chat').value });
});
el('telegram-find').addEventListener('click', () => telegramAction('chats', { botToken:el('telegram-token').value }));
el('telegram-test').addEventListener('click', () => telegramAction('test', {}));
el('telegram-choices').addEventListener('change', () => { if (el('telegram-choices').value) el('telegram-chat').value = el('telegram-choices').value; telegramDirty = true; renderUpdates(); });

function render() {
  el('season-label').textContent = `${SEASON} SEASON`;
  el('total-accounts').textContent = overview.summary.accounts;
  el('total-drafts').textContent = overview.summary.drafts;
  el('total-submitted').textContent = overview.summary.submitted;
  if (overview.server.playerUrl) {
    try {
      const url = new URL(overview.server.playerUrl);
      if (['http:', 'https:'].includes(url.protocol)) el('player-link').href = url.href;
    } catch { /* Leave the local default when the server URL is unavailable. */ }
  }
  el('server-started').textContent = `Server started ${dateTime(overview.server.startedAt)}`;
  renderAccounts();
  renderFeed();
  renderLeaders();
  renderInspector();
  renderUpdates();
}

async function load(refresh = false) {
  if (busy) return;
  busy = true;
  renderAccountActions();
  el('dashboard').setAttribute('aria-busy', 'true');
  el('reload-overview').disabled = true;
  el('refresh-standings').disabled = true;
  el('load-error').hidden = true;
  el('page-status').textContent = refresh ? 'Checking the NHL standings…' : 'Loading your dashboard…';
  if (refresh) {
    el('refresh-status').textContent = 'Checking the NHL feed…';
    el('refresh-status').classList.remove('error');
  }
  try {
    const response = await fetch(refresh ? '/api/admin/standings/refresh' : '/api/admin/overview', refresh ? {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': overview.csrfToken }, body: '{}', cache: 'no-store',
    } : { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The dashboard could not be loaded.');
    overview = data;
    render();
    el('page-status').textContent = `Dashboard updated at ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.`;
    if (refresh) el('refresh-status').textContent = data.scoring.error ? `Feed check completed. ${data.scoring.error}`
      : data.scoring.stale ? 'Feed check completed. Scores use the last verified update.'
        : data.scoring.available ? 'Standings checked. Scores are up to date.' : 'Feed checked. Verified standings are not available yet.';
  } catch (error) {
    const message = error instanceof TypeError ? 'Cannot reach the local server. Make sure it is running, then reload the dashboard.' : error.message;
    el('load-error').textContent = message;
    el('load-error').hidden = false;
    el('page-status').textContent = overview ? 'Showing the last loaded dashboard.' : 'Dashboard unavailable.';
    if (refresh) {
      el('refresh-status').textContent = 'Refresh failed. The last loaded scores remain visible.';
      el('refresh-status').classList.add('error');
    }
  } finally {
    busy = false;
    el('dashboard').setAttribute('aria-busy', 'false');
    el('reload-overview').disabled = false;
    el('refresh-standings').disabled = !overview?.server.canRefresh || !overview?.csrfToken;
    renderAccountActions();
  }
}

function openAccountAction(action) {
  const account = overview?.accounts.find(item => item.id === selectedAccountId);
  if (busy || !account) return;
  accountAction = {action, id:account.id, username:account.username, revision:account.prediction?.revision ?? 0};
  el('account-action-form').reset();
  el('account-dialog-error').textContent = '';
  el('account-dialog-target').textContent = `Selected player: ${accountName(account)}`;
  el('rename-fields').hidden = action !== 'rename';
  el('password-fields').hidden = action !== 'password';
  el('new-account-name').required = action === 'rename';
  el('new-account-password').required = action === 'password';
  el('confirm-account-password').required = action === 'password';
  el('new-account-name').value = account.displayName;
  const settings = {
    rename:['Change account name', 'This updates the displayed name and the username used to log in. Their password and selections stay saved.', 'Save name'],
    password:['Reset account password', 'Set a new password for this player. All their existing sign-in sessions will be ended.', 'Set password'],
    'reset-prediction':['Reset selections?', 'This permanently clears all selected teams, unlocks the prediction, and removes this player from the leaderboard. They can then choose and submit a new prediction.', 'Reset selections'],
  }[action];
  el('account-dialog-title').textContent = settings[0];
  el('account-dialog-description').textContent = settings[1];
  el('confirm-account-action').textContent = settings[2];
  el('confirm-account-action').classList.toggle('button-danger', action === 'reset-prediction');
  el('account-dialog').showModal();
  (action === 'rename' ? el('new-account-name') : action === 'password' ? el('new-account-password') : el('cancel-account-action')).focus();
}

el('rename-account').addEventListener('click', () => openAccountAction('rename'));
el('change-password').addEventListener('click', () => openAccountAction('password'));
el('reset-selections').addEventListener('click', () => openAccountAction('reset-prediction'));
for (const id of ['close-account-dialog', 'cancel-account-action']) el(id).addEventListener('click', () => {
  if (!busy) el('account-dialog').close();
});
el('account-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
el('account-dialog').addEventListener('close', () => {
  accountAction = null;
  el('new-account-password').value = '';
  el('confirm-account-password').value = '';
  el('account-dialog-error').textContent = '';
});
el('account-action-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !accountAction || !el('account-dialog').open) return;
  const selected = {...accountAction};
  const body = {expectedUsername:selected.username};
  if (selected.action === 'rename') body.username = el('new-account-name').value;
  if (selected.action === 'reset-prediction') body.revision = selected.revision;
  if (selected.action === 'password') {
    const password = el('new-account-password').value;
    if (Array.from(password).length < 7 || Array.from(password).length > 128) {
      el('account-dialog-error').textContent = 'Use a password with 7–128 characters.'; return;
    }
    if (password !== el('confirm-account-password').value) {
      el('account-dialog-error').textContent = 'The passwords do not match.'; return;
    }
    body.password = password;
    el('new-account-password').value = '';
    el('confirm-account-password').value = '';
  }
  busy = true;
  renderAccountActions();
  el('confirm-account-action').disabled = true;
  el('cancel-account-action').disabled = true;
  el('close-account-dialog').disabled = true;
  el('reload-overview').disabled = true;
  el('refresh-standings').disabled = true;
  el('account-dialog-error').textContent = '';
  try {
    const response = await fetch(`/api/admin/accounts/${selected.id}/${selected.action}`, {
      method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':overview.csrfToken},
      body:JSON.stringify(body), cache:'no-store',
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The account could not be updated.');
    overview = data;
    render();
    el('account-dialog').close();
    el('account-action-status').textContent = selected.action === 'rename' ? 'Account name updated.'
      : selected.action === 'password' ? 'Password updated. The player must log in again.'
        : 'Selections reset. The player can make a new prediction.';
  } catch (error) {
    el('account-dialog-error').textContent = error instanceof TypeError ? 'Cannot reach the local server. Reload the dashboard to check whether the change completed.' : error.message;
  } finally {
    delete body.password;
    busy = false;
    el('confirm-account-action').disabled = false;
    el('cancel-account-action').disabled = false;
    el('close-account-dialog').disabled = false;
    el('reload-overview').disabled = false;
    el('refresh-standings').disabled = !overview?.server.canRefresh || !overview?.csrfToken;
    renderAccountActions();
  }
});

el('account-search').addEventListener('input', renderAccounts);
el('reload-overview').addEventListener('click', () => load());
el('refresh-standings').addEventListener('click', () => load(true));
load();
