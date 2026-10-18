import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, chmodSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createAccountStore } from '../accounts.mjs';
import { TEAMS } from '../dist/game.js';

const PASSWORD = 'test-only-passphrase-482!';
const completePicks = ['Atlantic', 'Metropolitan', 'Central', 'Pacific'].flatMap(division =>
  TEAMS.filter(team => team.division === division).slice(0, 4).map(team => team.id));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'playoff-account-test-'));
  const path = join(directory, 'accounts.sqlite');
  const store = createAccountStore(path);
  t.after(() => {
    try { store.close(); } catch { /* A persistence test may already have closed it. */ }
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, path };
}

function inspect(path, action) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return action(db); } finally { db.close(); }
}

test('registration uses canonical unique names while keeping display capitalization', async t => {
  const { store } = fixture(t);
  const registration = await store.register('HockeyFan_42', PASSWORD);
  assert.deepEqual(registration.user, { id: 1, username: 'hockeyfan_42', displayName: 'HockeyFan_42' });
  assert.match(registration.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(registration.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(registration.token, registration.csrfToken);
  assert.deepEqual(Object.keys(registration).sort(), ['csrfToken', 'token', 'user']);
  await assert.rejects(store.register('HOCKEYFAN_42', PASSWORD), { status: 409 });
  await assert.rejects(store.register('hockeyfan_42', PASSWORD), { status: 409 });
});

test('invalid usernames and passwords are rejected before account creation', async t => {
  const { store } = fixture(t);
  for (const username of [undefined, null, 42, '', 'ab', 'a'.repeat(25), 'abc def', 'abc-def', 'åäö', ' abc', 'abc ']) {
    await assert.rejects(store.register(username, PASSWORD), { status: 400 });
  }
  for (const password of [undefined, null, 42, '', 'short', 'a'.repeat(6), 'a'.repeat(129), 'a'.repeat(100000)]) {
    await assert.rejects(store.register('ValidFan', password), { status: 400 });
  }
  const registration = await store.register('ValidFan', 'a'.repeat(7));
  assert.equal((await store.login('ValidFan', 'a'.repeat(7))).user.id, registration.user.id);
  assert.equal(registration.user.id, 1);
  assert.equal(store.getPrediction(1), null);
});

test('passwords are salted scrypt hashes and opaque session tokens are hashed in SQLite', async t => {
  const { store, path } = fixture(t);
  const first = await store.register('FirstFan', PASSWORD);
  await store.register('SecondFan', PASSWORD);
  const rows = inspect(path, db => db.prepare('SELECT password_hash, password_salt, password_scheme FROM users ORDER BY id').all());
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.match(row.password_hash, /^[a-f0-9]{128}$/);
    assert.match(row.password_salt, /^[a-f0-9]{64}$/);
    assert.notEqual(row.password_hash, PASSWORD);
    assert.equal(row.password_scheme, 'scrypt-32768-8-3');
    assert.equal(scryptSync(PASSWORD, Buffer.from(row.password_salt, 'hex'), 64,
      { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString('hex'), row.password_hash);
  }
  assert.notEqual(rows[0].password_hash, rows[1].password_hash);
  assert.notEqual(rows[0].password_salt, rows[1].password_salt);
  const session = inspect(path, db => db.prepare('SELECT token_hash, expires_at FROM sessions WHERE user_id = ?').get(first.user.id));
  assert.equal(session.token_hash, createHash('sha256').update(first.token).digest('hex'));
  assert.notEqual(session.token_hash, first.token);
  assert.ok(session.expires_at > Date.now() + 6.9 * 24 * 60 * 60 * 1000);
  assert.ok(session.expires_at <= Date.now() + 7 * 24 * 60 * 60 * 1000);
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  for (const filename of [path, `${path}-wal`, `${path}-shm`].filter(existsSync)) {
    if (process.platform !== 'win32') assert.equal(statSync(filename).mode & 0o777, 0o600);
    const bytes = readFileSync(filename);
    assert.equal(bytes.includes(Buffer.from(PASSWORD)), false);
    assert.equal(bytes.includes(Buffer.from(first.token)), false);
  }
});

test('login ignores username capitalization and never exposes credential fields', async t => {
  const { store } = fixture(t);
  const registered = await store.register('IceFan', PASSWORD);
  const login = await store.login('ICEFAN', PASSWORD);
  assert.deepEqual(login.user, registered.user);
  assert.notEqual(login.token, registered.token);
  assert.notEqual(login.csrfToken, registered.csrfToken);
  assert.deepEqual(store.getSession(login.token), { user: registered.user, csrfToken: login.csrfToken });
  assert.equal(JSON.stringify(login).includes(PASSWORD), false);
  assert.equal(JSON.stringify(store.getSession(login.token)).includes('password'), false);
});

test('unknown accounts, bad passwords and malformed credentials fail with one generic error', async t => {
  const { store } = fixture(t);
  await store.register('IceFan', PASSWORD);
  for (const [username, password] of [
    ['IceFan', 'incorrect-password'], ['Nobody', PASSWORD], ['IceFan', 'short'],
    ['IceFan', null], [null, PASSWORD], ['a'.repeat(25), PASSWORD], ['IceFan', 'a'.repeat(129)],
  ]) {
    await assert.rejects(store.login(username, password), { status: 401, message: 'Incorrect username or password.' });
  }
});

test('logout revokes only its token and malformed sessions cannot authenticate', async t => {
  const { store } = fixture(t);
  const first = await store.register('IceFan', PASSWORD);
  const second = await store.login('IceFan', PASSWORD);
  store.logout(first.token);
  assert.equal(store.getSession(first.token), null);
  assert.equal(store.getSession(second.token).user.id, first.user.id);
  for (const token of [undefined, null, 123, '', 'invalid', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(43)]) {
    assert.equal(store.getSession(token), null);
    assert.doesNotThrow(() => store.logout(token));
  }
  store.logout(first.token);
  store.logout(second.token);
  assert.equal(store.getSession(second.token), null);
});

test('expired sessions are removed instead of authenticating their owner', async t => {
  const { store, path } = fixture(t);
  const registration = await store.register('IceFan', PASSWORD);
  const db = new DatabaseSync(path);
  try {
    db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1, registration.user.id);
  } finally { db.close(); }
  assert.equal(store.getSession(registration.token), null);
  assert.equal(inspect(path, db => db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count), 0);
});

test('drafts are tied to their owner, start absent, and stay private from the leaderboard', async t => {
  const { store } = fixture(t);
  const first = await store.register('FirstFan', PASSWORD);
  const second = await store.register('SecondFan', PASSWORD);
  assert.equal(store.getPrediction(first.user.id), null);
  assert.equal(store.getPrediction(second.user.id), null);
  const saved = store.saveDraft(first.user.id, ['BOS', 'CAR', 'UTA'], 0);
  assert.deepEqual(saved.teamIds, ['BOS', 'CAR', 'UTA']);
  assert.equal(saved.state, 'draft');
  assert.equal(saved.submittedAt, null);
  assert.equal(saved.revision, 1);
  assert.ok(Number.isFinite(Date.parse(saved.updatedAt)));
  assert.equal(store.getPrediction(second.user.id), null);
  assert.deepEqual(store.listSubmitted(), []);
  saved.teamIds.push('LAK');
  assert.deepEqual(store.getPrediction(first.user.id).teamIds, ['BOS', 'CAR', 'UTA']);
  const empty = store.saveDraft(second.user.id, [], 0);
  assert.deepEqual(empty.teamIds, []);
  assert.deepEqual(store.getPrediction(first.user.id).teamIds, ['BOS', 'CAR', 'UTA']);
});

test('invalid picks are rejected wholly and cannot erase an existing draft', async t => {
  const { store } = fixture(t);
  const { user } = await store.register('IceFan', PASSWORD);
  const original = store.saveDraft(user.id, ['BOS', 'CAR'], 0);
  const atlantic = TEAMS.filter(team => team.division === 'Atlantic').map(team => team.id);
  const metropolitan = TEAMS.filter(team => team.division === 'Metropolitan').map(team => team.id);
  for (const picks of [null, {}, 'BOS', [null], ['BOS', 'BOS'], ['bos'], ['BOS', 'FAKE'],
    atlantic.slice(0, 6), [...atlantic.slice(0, 5), ...metropolitan.slice(0, 4)], TEAMS.map(team => team.id)]) {
    assert.throws(() => store.saveDraft(user.id, picks, original.revision), { status: 400 });
    assert.deepEqual(store.getPrediction(user.id), original);
  }
  for (const picks of [[], ['BOS', 'CAR'], completePicks.slice(0, 15)]) {
    assert.throws(() => store.submitPrediction(user.id, picks, original.revision), { status: 400 });
  }
});

test('unknown users cannot read, create, or submit predictions', t => {
  const { store } = fixture(t);
  for (const id of [null, '1', 1, -1, 0, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => store.getPrediction(id), { status: 404 });
    assert.throws(() => store.saveDraft(id, [], 0), { status: 404 });
    assert.throws(() => store.submitPrediction(id, completePicks, 0), { status: 404 });
  }
});

test('submissions are permanently locked, and retrying the same prediction is idempotent', async t => {
  const { store } = fixture(t);
  const { user } = await store.register('IceFan', PASSWORD);
  const draft = store.saveDraft(user.id, completePicks, 0);
  const submitted = store.submitPrediction(user.id, completePicks, draft.revision);
  assert.equal(submitted.state, 'submitted');
  assert.equal(submitted.revision, 2);
  assert.ok(Number.isFinite(Date.parse(submitted.submittedAt)));
  assert.deepEqual(store.submitPrediction(user.id, [...completePicks].reverse(), 1), submitted);
  const changed = completePicks.map(id => id === 'BOS' ? 'MTL' : id);
  assert.throws(() => store.submitPrediction(user.id, changed, 2), { status: 409 });
  assert.throws(() => store.saveDraft(user.id, completePicks, 2), { status: 409 });
  assert.throws(() => store.saveDraft(user.id, ['BOS'], 1), { status: 409 });
  assert.deepEqual(store.getPrediction(user.id), submitted);
  assert.deepEqual(store.listSubmitted(), [{ ...user, teamIds: completePicks, submittedAt: submitted.submittedAt }]);
  assert.deepEqual(Object.keys(store.listSubmitted()[0]).sort(), ['displayName', 'id', 'submittedAt', 'teamIds', 'username']);
});

test('optimistic revisions reject stale writes and stale submissions without changing saved picks', async t => {
  const { store } = fixture(t);
  const { user } = await store.register('IceFan', PASSWORD);
  assert.throws(() => store.saveDraft(user.id, ['BOS'], 1), { status: 409 });
  const first = store.saveDraft(user.id, ['BOS'], 0);
  const second = store.saveDraft(user.id, ['BOS', 'CAR'], first.revision);
  assert.throws(() => store.saveDraft(user.id, ['UTA'], first.revision), { status: 409 });
  assert.throws(() => store.submitPrediction(user.id, completePicks, first.revision), { status: 409 });
  assert.deepEqual(store.getPrediction(user.id), second);
  for (const revision of [-1, 0.5, '2', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => store.saveDraft(user.id, ['BOS'], revision), { status: 400 });
  }
  const submitted = store.submitPrediction(user.id, completePicks, second.revision);
  assert.equal(submitted.revision, 3);
});

test('accounts, sessions, drafts and submissions survive reopening the database', async t => {
  const { store, path } = fixture(t);
  const first = await store.register('FirstFan', PASSWORD);
  const second = await store.register('SecondFan', PASSWORD);
  const draft = store.saveDraft(first.user.id, ['BOS', 'UTA'], 0);
  const submitted = store.submitPrediction(second.user.id, completePicks, 0);
  store.close();
  const reopened = createAccountStore(path);
  try {
    assert.deepEqual(reopened.getSession(first.token), { user: first.user, csrfToken: first.csrfToken });
    assert.deepEqual(reopened.getPrediction(first.user.id), draft);
    assert.deepEqual(reopened.getPrediction(second.user.id), submitted);
    assert.deepEqual(reopened.listSubmitted(), [{ ...second.user, teamIds: completePicks, submittedAt: submitted.submittedAt }]);
    assert.deepEqual((await reopened.login('FIRSTFAN', PASSWORD)).user, first.user);
    await assert.rejects(reopened.register('firstfan', PASSWORD), { status: 409 });
    assert.throws(() => reopened.saveDraft(second.user.id, ['BOS'], submitted.revision), { status: 409 });
    assert.equal(inspect(path, db => db.prepare('PRAGMA user_version').get().user_version), 3);
    assert.equal(inspect(path, db => db.prepare('PRAGMA journal_mode').get().journal_mode), 'wal');
  } finally { reopened.close(); }
});

test('separate SQLite connections cannot overwrite a newer revision or a locked submission', async t => {
  const { store, path } = fixture(t);
  const { user } = await store.register('IceFan', PASSWORD);
  const peer = createAccountStore(path);
  try {
    const first = store.saveDraft(user.id, ['BOS'], 0);
    const second = peer.saveDraft(user.id, ['CAR'], first.revision);
    assert.throws(() => store.saveDraft(user.id, ['UTA'], first.revision), { status: 409 });
    const submitted = peer.submitPrediction(user.id, completePicks, second.revision);
    assert.throws(() => store.saveDraft(user.id, ['BOS'], second.revision), { status: 409 });
    assert.deepEqual(store.getPrediction(user.id), submitted);
  } finally { peer.close(); }
});

test('concurrent authentication is bounded across stores and capacity recovers after completion', async t => {
  const first = fixture(t);
  const second = fixture(t);
  const alpha = first.store.register('ParallelAlpha', PASSWORD);
  const beta = second.store.register('ParallelBeta', PASSWORD);
  await assert.rejects(first.store.register('ParallelGamma', PASSWORD), {
    status: 503, message: 'Sign-in is busy. Please try again in a moment.',
  });
  await assert.rejects(second.store.login('UnknownFan', PASSWORD), { status: 503 });
  const registrations = await Promise.all([alpha, beta]);
  assert.equal(registrations.length, 2);
  await assert.rejects(first.store.login('ParallelAlpha', 'wrong-password-value'), { status: 401 });
  assert.equal((await first.store.login('ParallelAlpha', PASSWORD)).user.username, 'parallelalpha');
  assert.equal(first.store.listAccounts().length, 1);
  assert.equal(second.store.listAccounts().length, 1);
});

test('only the ten most recent sessions remain active for each account', async t => {
  const { store, path } = fixture(t);
  const first = await store.register('SessionFan', PASSWORD);
  const unrelated = await store.register('OtherSessionFan', PASSWORD);
  const tokens = [first.token];
  for (let index = 0; index < 11; index += 1) tokens.push((await store.login('SessionFan', PASSWORD)).token);
  assert.equal(inspect(path, db => db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(first.user.id).count), 10);
  assert.equal(store.getSession(tokens[0]), null);
  assert.equal(store.getSession(tokens[1]), null);
  for (const token of tokens.slice(2)) assert.equal(store.getSession(token).user.id, first.user.id);
  assert.equal(store.getSession(unrelated.token).user.id, unrelated.user.id);
});

test('opening the store removes expired sessions without waiting for another login', async t => {
  const { store, path } = fixture(t);
  const expired = await store.register('ExpiredFan', PASSWORD);
  const valid = await store.register('CurrentFan', PASSWORD);
  store.close();
  const db = new DatabaseSync(path);
  try { db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1, expired.user.id); }
  finally { db.close(); }
  const reopened = createAccountStore(path);
  try {
    assert.equal(inspect(path, db => db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count), 1);
    assert.equal(reopened.getSession(valid.token).user.id, valid.user.id);
    assert.equal(reopened.getSession(expired.token), null);
  } finally { reopened.close(); }
});

test('normal session reads periodically prune expired sessions belonging to other users', async t => {
  const { store, path } = fixture(t);
  const expired = await store.register('PrunedFan', PASSWORD);
  const valid = await store.register('ReadingFan', PASSWORD);
  const now = Date.now();
  const db = new DatabaseSync(path);
  try { db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(now - 1, expired.user.id); }
  finally { db.close(); }
  t.mock.method(Date, 'now', () => now + 60 * 60 * 1000 + 1);
  assert.equal(store.getSession(valid.token).user.id, valid.user.id);
  assert.equal(inspect(path, db => db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count), 1);
  assert.equal(store.getSession(expired.token), null);
});

test('password boundaries count Unicode code points and preserve the complete password', async t => {
  const { store } = fixture(t);
  const password = '🏒'.repeat(128);
  const registration = await store.register('UnicodeFan', password);
  assert.equal((await store.login('UnicodeFan', password)).user.id, registration.user.id);
  await assert.rejects(store.login('UnicodeFan', `${password.slice(0, -2)}🏆`), { status: 401 });
  await assert.rejects(store.register('TooLongUnicode', '🏒'.repeat(129)), { status: 400 });
});

test('existing database permissions are tightened and symbolic-link database paths are refused', { skip: process.platform === 'win32' ? 'POSIX modes and unprivileged file symlinks require the Linux deployment host.' : false }, async t => {
  const { store, path } = fixture(t);
  await store.register('PermissionFan', PASSWORD);
  store.close();
  chmodSync(path, 0o644);
  const reopened = createAccountStore(path);
  try {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const linked = join(dirname(path), 'linked.sqlite');
    symlinkSync(path, linked);
    assert.throws(() => createAccountStore(linked), /regular file/);
  } finally { reopened.close(); }
});

test('version one accounts migrate without losing sessions or locked picks and upgrade only after a correct login', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'playoff-account-migration-'));
  const path = join(directory, 'accounts.sqlite');
  const oldPassword = 'oldpass_10';
  const salt = randomBytes(32).toString('hex');
  const hash = scryptSync(oldPassword, Buffer.from(salt, 'hex'), 64,
    { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX sessions_by_expiry ON sessions(expires_at);
      CREATE TABLE predictions (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        season TEXT NOT NULL, team_ids TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('draft', 'submitted')),
        submitted_at TEXT, updated_at TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
        PRIMARY KEY (user_id, season),
        CHECK ((state = 'draft' AND submitted_at IS NULL) OR (state = 'submitted' AND submitted_at IS NOT NULL)));
      PRAGMA user_version = 1;
    `);
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)').run(1, 'legacyfan', 'LegacyFan', salt, hash, now);
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(createHash('sha256').update(token).digest('hex'), 1, csrf, Date.now() + 60000, now);
    db.prepare('INSERT INTO predictions VALUES (?, ?, ?, ?, ?, ?, ?)').run(1, '20262027', JSON.stringify(completePicks), 'submitted', now, now, 1);
  } finally { db.close(); }
  const store = createAccountStore(path);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(inspect(path, db => db.prepare('PRAGMA user_version').get().user_version), 3);
  assert.deepEqual(store.getSession(token), { user: { id: 1, username: 'legacyfan', displayName: 'LegacyFan' }, csrfToken: csrf });
  assert.equal(store.getPrediction(1).state, 'submitted');
  assert.deepEqual(store.getPrediction(1).teamIds, completePicks);
  await assert.rejects(store.login('LegacyFan', 'wrong-old-password'), { status: 401 });
  assert.equal(inspect(path, db => db.prepare('SELECT password_hash FROM users WHERE id = 1').get().password_hash), hash);
  const loggedIn = await store.login('LegacyFan', oldPassword);
  assert.equal(loggedIn.user.id, 1);
  const upgraded = inspect(path, db => db.prepare('SELECT password_hash, password_salt, password_scheme FROM users WHERE id = 1').get());
  assert.equal(upgraded.password_scheme, 'scrypt-32768-8-3');
  assert.notEqual(upgraded.password_hash, hash);
  assert.notEqual(upgraded.password_salt, salt);
  assert.equal((await store.login('legacyfan', oldPassword)).user.id, 1);
  assert.throws(() => store.saveDraft(1, ['BOS'], 1), { status: 409 });
  for (const projection of [loggedIn.user, store.getSession(loggedIn.token).user, store.listSubmitted(), store.listAccounts()]) {
    assert.equal(/password|scrypt|csrf_token|token_hash/.test(JSON.stringify(projection)), false);
  }
});
