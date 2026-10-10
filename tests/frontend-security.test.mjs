import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as game from '../dist/game.js';

const source = readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '');
const page = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');
const GUEST_KEY = 'playoff-picks-2026-27';
const completePicks = (offset = 0) => game.DIVISIONS.flatMap(d => game.TEAMS.filter(team => team.division === d.id).slice(offset,offset + 4).map(team => team.id));
const anonymous = { user:null, csrfToken:null, prediction:null, score:null };
const account = (id = 1, teamIds = ['BOS'], revision = 1) => ({
  user:{id, displayName:`Fan${id}`}, csrfToken:`csrf-${id}`,
  prediction:{teamIds, revision, state:'draft'}, score:null,
});
const response = (data, status = 200) => ({ok:status < 400, status, json:async () => data});
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; }

// Run the actual browser module with only browser I/O replaced. This checks
// asynchronous session handling without adding test-only hooks to product code.
async function browser({guest = ['BUF'], session = anonymous, route} = {}) {
  const elements = new Map();
  const listeners = new Map();
  const storage = new Map([[GUEST_KEY, JSON.stringify(guest)]]);
  const calls = [];
  let timerId = 0;
  const timers = new Map();
  class Element {
    constructor(id) { this.id = id; this.value = ''; this.hidden = false; this.disabled = false; this.textContent = ''; this.dataset = {}; this.style = {}; this.attributes = {}; this.events = new Map(); this.html = ''; this.open = false; this.classList = {toggle(){}, add(){}, remove(){}}; }
    set innerHTML(value) { this.html = value; for (const match of value.matchAll(/\bid="([^"]+)"/g)) if (!elements.has(match[1])) elements.set(match[1], new Element(match[1])); }
    get innerHTML() { return this.html; }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(event, callback) { this.events.set(event, callback); }
    querySelector(selector) { return selector === 'table' && this.html.includes('<table') ? {} : null; }
    showModal() { this.open = true; }
    close() { this.open = false; this.events.get('close')?.({}); }
    focus() {}
    scrollIntoView() {}
  }
  for (const match of page.matchAll(/\bid="([^"]+)"/g)) elements.set(match[1], new Element(match[1]));
  const location = {href:'https://hockey.example/'};
  const context = vm.createContext({
    ...game, URL, URLSearchParams, AbortController, console,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, {callback, delay}); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval(){},
    document:{hidden:false, getElementById:id => elements.get(id), querySelectorAll:() => [], querySelector:() => null,
      addEventListener:(name, callback) => listeners.set(`document:${name}`, callback)},
    window:{addEventListener:(name, callback) => listeners.set(name, callback)}, location,
    history:{replaceState(_state, _title, url) { location.href = url; }},
    localStorage:{getItem:key => storage.get(key) ?? null, setItem:(key, value) => storage.set(key, value)},
    fetch:async (path, options) => {
      calls.push({path, ...options, body: options.body ? JSON.parse(options.body) : undefined});
      const handled = await route?.(path, options);
      if (handled !== undefined) return handled;
      return response(path === '/api/session' ? session : path === '/api/leaderboard' ? {scoring:{available:false}, entries:[]} : {});
    },
  });
  vm.runInContext(source, context, {filename:'app.js'});
  await settle();
  return {elements, storage, calls, listeners, context,
    run:code => vm.runInContext(code, context),
    state:() => JSON.parse(vm.runInContext('JSON.stringify({picks, session, sessionLoading, sessionUnavailable, recoveryDraft})', context)),
    apply:value => vm.runInContext(`applySession(${JSON.stringify(value)})`, context),
  };
}

test('expired account drafts stay private and the independent guest draft returns', async () => {
  const b = await browser();
  b.apply(account(1, ['BOS']));
  b.run("picks = ['BOS','CAR']; updateSummary()");
  await b.run('reconcileSignIn()');
  assert.deepEqual(b.state().picks, ['BUF']);
  assert.deepEqual(JSON.parse(b.storage.get(GUEST_KEY)), ['BUF']);
  assert.deepEqual(b.state().recoveryDraft, {userId:1, teamIds:['BOS','CAR'], revision:1});
  assert.equal(b.state().session.user, null);
});

test('private in-memory recovery belongs only to the original account and revision', async () => {
  const b = await browser({route:(path) => path === '/api/login' ? response(account()) : undefined});
  b.apply(account());
  b.run("picks = ['BOS','CAR']; updateSummary()");
  await b.run('reconcileSignIn()');
  b.run("setAuthMode('login')");
  b.elements.get('account-username').value = 'Fan1';
  b.elements.get('account-password').value = 'existing-password';
  await b.elements.get('auth-form').events.get('submit')({preventDefault(){}});
  assert.deepEqual(b.state().picks, ['BOS','CAR']);
  assert.deepEqual(JSON.parse(b.storage.get(GUEST_KEY)), ['BUF']);
  assert.equal(b.state().recoveryDraft, null);
});

test('unknown account state blocks edits and offers reconnect without persisting a private draft', async () => {
  let offline = true;
  const b = await browser({route:path => { if (path === '/api/session' && offline) throw new Error('offline'); }});
  assert.equal(b.state().sessionLoading, true);
  assert.equal(b.state().sessionUnavailable, true);
  assert.equal(b.elements.get('retry-session').hidden, false);
  b.run("changePick('BOS')");
  assert.deepEqual(b.state().picks, ['BUF']);
  offline = false;
  await b.elements.get('retry-session').events.get('click')();
  assert.equal(b.state().sessionLoading, false);
  assert.equal(b.elements.get('retry-session').hidden, true);
  b.run("changePick('BOS')");
  assert.deepEqual(b.state().picks, ['BUF','BOS']);
});

test('logout still terminates the session when saving the last edit fails', async () => {
  const b = await browser({session:account(), route:path => path === '/api/prediction' ? response({error:'busy'}, 503) : undefined});
  b.run("picks = ['BOS','CAR']; updateSummary()");
  await b.run('logout()');
  assert.ok(b.calls.some(call => call.path === '/api/logout' && call.method === 'POST'));
  assert.equal(b.state().session.user, null);
  assert.deepEqual(b.state().picks, ['BUF']);
  assert.equal(b.state().recoveryDraft, null);
  assert.match(b.elements.get('toast').textContent, /logged out.*latest changes could not be saved/);
});

test('a stale session read cannot replace a newer sign-in', async () => {
  const read = deferred();
  let intercept = false;
  const b = await browser({session:account(), route:path => path === '/api/session' && intercept ? read.promise : undefined});
  intercept = true;
  const pending = b.run('reconcileSignIn()');
  b.apply(account(2, ['UTA']));
  read.resolve(response(account(1, ['CAR'])));
  await pending;
  assert.equal(b.state().session.user.id, 2);
  assert.deepEqual(b.state().picks, ['UTA']);
});

test('a stale conflict refresh cannot replace a newer account', async () => {
  const read = deferred();
  let intercept = false;
  const b = await browser({session:account(), route:path => path === '/api/prediction' ? response({error:'changed'}, 409) : path === '/api/session' && intercept ? read.promise : undefined});
  intercept = true;
  const pending = b.run('saveAccountDraft()');
  await settle();
  b.apply(account(2, ['UTA']));
  read.resolve(response(account(1, ['CAR'])));
  await pending;
  assert.equal(b.state().session.user.id, 2);
  assert.deepEqual(b.state().picks, ['UTA']);
});

test('cross-tab logout checks the cookie session and restores guest state', async () => {
  let current = account();
  const b = await browser({route:path => path === '/api/session' ? response(current) : undefined});
  current = anonymous;
  b.listeners.get('storage')({key:'playoff-picks-account-change', newValue:'changed'});
  await settle();
  assert.equal(b.state().session.user, null);
  assert.deepEqual(b.state().picks, ['BUF']);
  assert.deepEqual(JSON.parse(b.storage.get(GUEST_KEY)), ['BUF']);
});

test('cancelled and failed sign-in dialogs clear password fields', async () => {
  const b = await browser({route:path => path === '/api/login' ? response({error:'Incorrect username or password.'}, 401) : undefined});
  b.run("openAuth('login')");
  b.elements.get('account-password').value = 'existing-password';
  b.elements.get('auth-dialog').close();
  assert.equal(b.elements.get('account-password').value, '');
  b.elements.get('account-password').value = 'existing-password';
  await b.elements.get('auth-form').events.get('submit')({preventDefault(){}});
  assert.equal(b.elements.get('account-password').value, '');
  assert.equal(b.elements.get('account-password-confirm').value, '');
  assert.match(b.elements.get('auth-error').textContent, /Incorrect/);
});

test('new registrations require 15 characters while existing logins retain 10', async () => {
  const b = await browser();
  b.run("setAuthMode('register')");
  assert.equal(b.elements.get('account-password').minLength, 15);
  b.elements.get('account-password').value = 'twelvechars!';
  b.elements.get('account-password-confirm').value = 'twelvechars!';
  await b.elements.get('auth-form').events.get('submit')({preventDefault(){}});
  assert.ok(!b.calls.some(call => call.path === '/api/register'));
  assert.match(b.elements.get('auth-error').textContent, /15/);
  b.run("setAuthMode('login')");
  assert.equal(b.elements.get('account-password').minLength, 10);
});

test('untrusted account names are escaped in headers and leaderboard HTML', async () => {
  const name = '<img src=x onerror=alert(1)>';
  const state = account(); state.user.displayName = name;
  const b = await browser({session:state, route:path => path === '/api/leaderboard' ? response({scoring:{available:false}, entries:[{id:1,displayName:name, teamIds:['BOS'],points:0,rank:1}]}) : undefined});
  for (const id of ['auth-controls','leaderboard-body']) {
    assert.ok(!b.elements.get(id).innerHTML.includes('<img src=x'));
    assert.ok(b.elements.get(id).innerHTML.includes('&lt;img src=x'));
  }
});

test('an expired session inside the save queue reconciles without awaiting itself', {timeout:1000}, async () => {
  const b = await browser({route:path => path === '/api/prediction' ? response({error:'Session expired'}, 401) : undefined});
  b.apply(account());
  b.run("picks = ['BOS','CAR']; saveChain = saveChain.then(() => saveAccountDraft())");
  await b.run('saveChain');
  assert.equal(b.state().session.user, null);
  assert.deepEqual(b.state().picks, ['BUF']);
  assert.deepEqual(JSON.parse(b.storage.get(GUEST_KEY)), ['BUF']);
});

test('focus waits for an in-flight save revision and preserves subsequent edits', async () => {
  const save = deferred();
  let serverAccount = account();
  const b = await browser({route:path => path === '/api/session' ? response(serverAccount) : path === '/api/prediction' ? save.promise : undefined});
  b.run("picks = ['BOS','CAR']; saveChain = saveChain.then(() => saveAccountDraft())");
  await settle();
  b.run("picks = ['BOS','CAR','NYR']; updateSummary()");
  const pending = b.run('reconcileSignIn({announce:false})');
  serverAccount = account(1, ['BOS','CAR'], 2);
  save.resolve(response({prediction:serverAccount.prediction,score:null}));
  await pending;
  assert.deepEqual(b.state().picks, ['BOS','CAR','NYR']);
  assert.equal(b.state().session.prediction.revision, 2);
});

test('a submission response from an older account cannot lock a new account', async () => {
  const submit = deferred();
  const complete = game.DIVISIONS.flatMap(d => game.TEAMS.filter(team => team.division === d.id).slice(0,4).map(team => team.id));
  const b = await browser({session:account(1, complete), route:path => path === '/api/prediction/submit' ? submit.promise : undefined});
  await b.elements.get('submit-prediction').events.get('click')();
  const pending = b.elements.get('confirm-submit').events.get('click')();
  await settle();
  assert.ok(b.calls.some(call => call.path === '/api/prediction/submit'));
  b.apply(account(2, ['UTA']));
  submit.resolve(response({prediction:{teamIds:complete, revision:2, state:'submitted'}, score:42}));
  await pending;
  assert.equal(b.state().session.user.id, 2);
  assert.equal(b.state().session.prediction.state, 'draft');
  assert.deepEqual(b.state().picks, ['UTA']);
});

test('recovery is never applied to a different user or changed saved revision', async () => {
  for (const restoredAccount of [account(2, ['UTA'], 1), account(1, ['NYR'], 2)]) {
    const b = await browser({route:path => path === '/api/login' ? response(restoredAccount) : undefined});
    b.apply(account());
    b.run("picks = ['BOS','CAR']; updateSummary()");
    await b.run('reconcileSignIn()');
    b.run("setAuthMode('login')");
    b.elements.get('account-password').value = 'existing-password';
    await b.elements.get('auth-form').events.get('submit')({preventDefault(){}});
    assert.deepEqual(b.state().picks, restoredAccount.prediction.teamIds);
    assert.equal(b.state().recoveryDraft, null);
    assert.deepEqual(JSON.parse(b.storage.get(GUEST_KEY)), ['BUF']);
  }
});


test('changing the account invalidates the prediction confirmation already being reviewed', async () => {
  const b = await browser({session:account(1, completePicks())});
  await b.elements.get('submit-prediction').events.get('click')();
  assert.equal(b.elements.get('submit-dialog').open, true);
  b.apply(account(2, completePicks(1)));
  assert.equal(b.elements.get('submit-dialog').open, false);
  await b.elements.get('confirm-submit').events.get('click')();
  assert.ok(!b.calls.some(call => call.path === '/api/prediction/submit'));
  assert.deepEqual(b.state().picks, completePicks(1));
});

test('a changed saved draft or revision invalidates an open prediction confirmation', async () => {
  for (const fresh of [account(1, completePicks(1), 1), account(1, completePicks(), 2)]) {
    const b = await browser({session:account(1, completePicks())});
    await b.elements.get('submit-prediction').events.get('click')();
    b.apply(fresh);
    assert.equal(b.elements.get('submit-dialog').open, false);
    await b.elements.get('confirm-submit').events.get('click')();
    assert.ok(!b.calls.some(call => call.path === '/api/prediction/submit'));
  }
});

test('session reconciliation disables confirmation before a network response arrives', async () => {
  const read = deferred();
  let intercept = false;
  const b = await browser({session:account(1, completePicks()), route:path => path === '/api/session' && intercept ? read.promise : undefined});
  await b.elements.get('submit-prediction').events.get('click')();
  assert.equal(b.elements.get('confirm-submit').disabled, false);
  intercept = true;
  const pending = b.run('reconcileSignIn({announce:false})');
  assert.equal(b.elements.get('confirm-submit').disabled, true);
  await b.elements.get('confirm-submit').events.get('click')();
  assert.ok(!b.calls.some(call => call.path === '/api/prediction/submit'));
  read.resolve(response(account(2, completePicks(1))));
  await pending;
  assert.equal(b.elements.get('submit-dialog').open, false);
});

test('a changed account or draft invalidates the clear-picks confirmation', async () => {
  for (const fresh of [account(2, ['UTA']), account(1, ['CAR'], 2)]) {
    const b = await browser({session:account()});
    b.elements.get('reset').events.get('click')();
    assert.equal(b.elements.get('reset-dialog').open, true);
    b.apply(fresh);
    assert.equal(b.elements.get('reset-dialog').open, false);
    b.elements.get('confirm-reset').events.get('click')();
    assert.deepEqual(b.state().picks, fresh.prediction.teamIds);
  }
});

test('the unchanged reviewed prediction can still be submitted with its bound revision', async () => {
  const chosen = completePicks();
  const b = await browser({session:account(1, chosen, 3), route:path => path === '/api/prediction/submit' ? response({prediction:{teamIds:chosen,revision:4,state:'submitted'},score:12}) : undefined});
  await b.elements.get('submit-prediction').events.get('click')();
  await b.elements.get('confirm-submit').events.get('click')();
  const sent = b.calls.find(call => call.path === '/api/prediction/submit');
  assert.deepEqual(sent.body.teamIds, chosen);
  assert.equal(sent.body.revision, 3);
  assert.equal(b.state().session.prediction.state, 'submitted');
});
