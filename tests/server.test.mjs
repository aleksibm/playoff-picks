import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { TEAMS } from '../dist/game.js';
import { previousDailyUpdate } from '../schedule.mjs';

const PASSWORD = 'Hockey-Test-Password-2026';
const picks = (offset = 0) => ['Atlantic', 'Metropolitan', 'Central', 'Pacific']
  .flatMap(division => TEAMS.filter(team => team.division === division).slice(offset, offset + 4).map(team => team.id));

function snapshot(fetchedAt = new Date().toISOString()) {
  return {
    season: 20262027, asOf: '2026-10-09', fetchedAt,
    teams: Object.fromEntries(TEAMS.map((team, index) => [team.id, {
      points: (index + 1) * 2 + index % 2, wins: index + 1, otLosses: index % 2, gamesPlayed: index + 3,
    }])),
  };
}

async function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'playoff-http-'));
  const paths = { dbPath: join(directory, 'accounts.sqlite'), standingsCachePath: join(directory, 'standings.json') };
  const app = createApp({ ...paths, allowStandingsFetch: false, ...options });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  await app.refreshStandings();
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { app, url, directory, ...paths };
}

function client(url) {
  let cookie = '';
  let csrfToken = null;
  return {
    get cookie() { return cookie; },
    get csrfToken() { return csrfToken; },
    async request(path, method = 'GET', body, overrides = {}) {
      const headers = { ...(cookie ? { Cookie: cookie } : {}), ...overrides };
      if (method === 'POST' || method === 'PUT') {
        if (!Object.hasOwn(headers, 'Origin')) headers.Origin = url;
        if (!Object.hasOwn(headers, 'Content-Type')) headers['Content-Type'] = 'application/json';
        if (csrfToken && !Object.hasOwn(headers, 'X-CSRF-Token')) headers['X-CSRF-Token'] = csrfToken;
      }
      const response = await fetch(`${url}${path}`, { method, headers,
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const contentType = response.headers.get('content-type');
      const data = contentType?.includes('json') ? await response.json() : await response.text();
      if (data?.csrfToken) csrfToken = data.csrfToken;
      return { status: response.status, headers: response.headers, data };
    },
    register(username = 'FanAlpha') { return this.request('/api/register', 'POST', { username, password: PASSWORD }); },
    login(username = 'FanAlpha', password = PASSWORD) { return this.request('/api/login', 'POST', { username, password }); },
  };
}

test('register creates a persistent real session with private cookies and no credential response', async t => {
  const context = await setup(t);
  const fan = client(context.url);
  const response = await fan.register();
  assert.equal(response.status, 200);
  assert.equal(response.data.user.username, 'fanalpha');
  assert.equal(response.data.user.displayName, 'FanAlpha');
  assert.equal(response.data.prediction, null);
  assert.equal(response.data.score, null);
  assert.match(response.data.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await fan.request('/api/session')).data.user.id, response.data.user.id);
  assert.ok(!JSON.stringify(response.data).includes(PASSWORD));
  assert.ok(!readFileSync(context.dbPath).includes(Buffer.from(PASSWORD)));
  assert.equal(statSync(context.dbPath).mode & 0o777, 0o600);
  assert.equal(statSync(context.directory).mode & 0o777, 0o700);
});

test('login is case insensitive, rejects wrong passwords, and rotates prior sessions', async t => {
  const { url } = await setup(t);
  const fan = client(url);
  await fan.register();
  const oldCookie = fan.cookie;
  assert.equal((await fan.login('FANALPHA', 'a-wrong-password')).status, 401);
  assert.equal((await fan.login('FANALPHA')).status, 200);
  assert.notEqual(fan.cookie, oldCookie);
  const old = await fetch(`${url}/api/session`, { headers: { Cookie: oldCookie } });
  assert.equal((await old.json()).user, null);
});

test('authentication validates format and protects usernames case insensitively', async t => {
  const { url } = await setup(t);
  const fan = client(url);
  assert.equal((await fan.request('/api/register', 'POST', { username: '<script>', password: PASSWORD })).status, 400);
  assert.equal((await fan.request('/api/register', 'POST', { username: 'ShortPass', password: 'short' })).status, 400);
  assert.equal((await fan.register()).status, 200);
  assert.equal((await client(url).register('FANALPHA')).status, 409);
});

test('anonymous accounts cannot save or submit predictions', async t => {
  const { url } = await setup(t);
  const visitor = client(url);
  assert.equal((await visitor.request('/api/session')).data.user, null);
  for (const [path, method] of [['/api/prediction', 'PUT'], ['/api/prediction/submit', 'POST'], ['/api/logout', 'POST']]) {
    assert.equal((await visitor.request(path, method, { teamIds: picks(), revision: 0 })).status, 401);
  }
});

test('cross-origin and missing-origin authentication requests are denied', async t => {
  const { url } = await setup(t);
  const visitor = client(url);
  for (const path of ['/api/register', '/api/login']) {
    assert.equal((await visitor.request(path, 'POST', { username: 'OriginFan', password: PASSWORD }, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await visitor.request(path, 'POST', { username: 'OriginFan', password: PASSWORD }, { Origin: '' })).status, 403);
  }
});

test('CSRF checks reject missing and wrong tokens while allowing the current session', async t => {
  const { url } = await setup(t);
  const fan = client(url);
  await fan.register();
  assert.equal((await fan.request('/api/prediction', 'PUT', { teamIds: ['BOS'], revision: 0 }, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await fan.request('/api/prediction', 'PUT', { teamIds: ['BOS'], revision: 0 }, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await fan.request('/api/prediction', 'PUT', { teamIds: ['BOS'], revision: 0 }, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await fan.request('/api/prediction', 'PUT', { teamIds: ['BOS'], revision: 0 })).status, 200);
});

test('draft revisions prevent concurrent browser overwrites and invalid team payloads', async t => {
  const { url } = await setup(t);
  const fan = client(url);
  await fan.register();
  assert.equal((await fan.request('/api/prediction', 'PUT', { teamIds: ['BOS'] })).status, 400);
  const saved = await fan.request('/api/prediction', 'PUT', { teamIds: ['BOS'], revision: 0 });
  assert.equal(saved.data.prediction.revision, 1);
  assert.equal(saved.data.prediction.state, 'draft');
  assert.equal(saved.data.score, null);
  assert.equal((await fan.request('/api/prediction', 'PUT', { teamIds: ['CAR'], revision: 0 })).status, 409);
  for (const teamIds of [['FAKE'], ['BOS', 'BOS'], TEAMS.slice(0, 6).map(team => team.id)]) {
    assert.equal((await fan.request('/api/prediction', 'PUT', { teamIds, revision: 1 })).status, 400);
  }
  assert.deepEqual((await fan.request('/api/session')).data.prediction.teamIds, ['BOS']);
  assert.deepEqual((await fan.request('/api/leaderboard')).data.entries, []);
});

test('only complete valid predictions submit, then remain immutable and retry idempotently', async t => {
  const { url } = await setup(t, { standingsProvider: async () => snapshot() });
  const fan = client(url);
  await fan.register();
  assert.equal((await fan.request('/api/prediction/submit', 'POST', { teamIds: ['BOS'], revision: 0 })).status, 400);
  const submitted = await fan.request('/api/prediction/submit', 'POST', { teamIds: picks(), revision: 0 });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.data.prediction.state, 'submitted');
  assert.ok(submitted.data.prediction.submittedAt);
  assert.equal(submitted.data.score, picks().reduce((sum, id) => sum + snapshot().teams[id].points, 0));
  assert.equal((await fan.request('/api/prediction', 'PUT', { teamIds: [], revision: 1 })).status, 409);
  assert.equal((await fan.request('/api/prediction/submit', 'POST', { teamIds: picks(1), revision: 1 })).status, 409);
  const retry = await fan.request('/api/prediction/submit', 'POST', { teamIds: [...picks()].reverse(), revision: 0 });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data.prediction, submitted.data.prediction);
});

test('leaderboard scores actual standings totals publicly and isolates each account prediction', async t => {
  const verified = snapshot();
  const { url } = await setup(t, { standingsProvider: async () => verified });
  const alpha = client(url);
  const beta = client(url);
  const gamma = client(url);
  await alpha.register('AlphaFan');
  await beta.register('BetaFan');
  await gamma.register('GammaFan');
  await alpha.request('/api/prediction/submit', 'POST', { teamIds: picks(), revision: 0 });
  await beta.request('/api/prediction/submit', 'POST', { teamIds: picks(1), revision: 0 });
  await gamma.request('/api/prediction/submit', 'POST', { teamIds: picks(), revision: 0 });
  const leaderboard = await client(url).request('/api/leaderboard');
  assert.equal(leaderboard.data.season, 20262027);
  assert.deepEqual(leaderboard.data.entries.map(entry => entry.username), ['betafan', 'alphafan', 'gammafan']);
  assert.deepEqual(leaderboard.data.entries.map(entry => entry.rank), [1, 2, 2]);
  for (const entry of leaderboard.data.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['displayName', 'id', 'points', 'rank', 'submittedAt', 'teamIds', 'username']);
    assert.equal(entry.points, entry.teamIds.reduce((sum, id) => sum + verified.teams[id].points, 0));
  }
  assert.deepEqual((await alpha.request('/api/session')).data.prediction.teamIds, picks());
  assert.deepEqual((await beta.request('/api/session')).data.prediction.teamIds, picks(1));
});

test('logout revokes the server session and clears the private cookie', async t => {
  const { url } = await setup(t);
  const fan = client(url);
  await fan.register();
  const previousCookie = fan.cookie;
  const logout = await fan.request('/api/logout', 'POST', {});
  assert.equal(logout.status, 200);
  assert.deepEqual(logout.data, { ok: true });
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  const old = await fetch(`${url}/api/session`, { headers: { Cookie: previousCookie } });
  assert.equal((await old.json()).user, null);
});

test('content type, malformed JSON, and oversized bodies are rejected', async t => {
  const { url } = await setup(t);
  const fan = client(url);
  assert.equal((await fan.request('/api/register', 'POST', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fan.request('/api/register', 'POST', '{bad json')).status, 400);
  assert.equal((await fan.request('/api/register', 'POST', [] )).status, 400);
  assert.equal((await fan.request('/api/register', 'POST', { username: 'BigFan', password: 'a'.repeat(9000) })).status, 413);
});

test('repeated registration and login attempts receive a bounded rate limit', async t => {
  const { url } = await setup(t);
  const fan = client(url);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    assert.equal((await fan.request('/api/register', 'POST', { username: '?', password: 'short' })).status, 400);
  }
  const registration = await fan.request('/api/register', 'POST', { username: 'RateFan', password: PASSWORD });
  assert.equal(registration.status, 429);
  assert.equal(registration.headers.get('retry-after'), '600');
  for (let attempt = 0; attempt < 10; attempt += 1) assert.equal((await fan.login('UnknownFan')).status, 401);
  assert.equal((await fan.login('UnknownFan')).status, 429);
});

test('static server serves only allowed dist assets and prevents account data exposure', async t => {
  const { url, directory } = await setup(t);
  writeFileSync(join(directory, 'secret.txt'), 'private local content');
  const home = await client(url).request('/');
  assert.equal(home.status, 200);
  assert.match(home.data, /<!doctype html>/i);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
  for (const path of ['/server.mjs', '/accounts.mjs', '/.local-data/accounts.sqlite', '/secret.txt', '/dist/index.html', '/..%2faccounts.mjs', '/%2e%2e/accounts.mjs', '/icon.svg%00']) {
    assert.equal((await client(url).request(path)).status, 404, path);
  }
  const hostile = await new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { Host: 'attacker.example' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
  assert.equal(hostile, 403);
});

test('all NHL logos are served locally while unknown assets and private files stay inaccessible', async t => {
  const { url } = await setup(t);
  await Promise.all(TEAMS.map(async team => {
    const logo = await client(url).request(`/logos/${team.id}.svg`);
    assert.equal(logo.status, 200, team.id);
    assert.equal(logo.headers.get('content-type'), 'image/svg+xml');
    assert.match(logo.data, /<svg\b/);
    assert.doesNotMatch(logo.data, /<script\b/i);
  }));
  const head = await fetch(`${url}/logos/BOS.svg`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.ok(Number(head.headers.get('content-length')) > 0);
  assert.equal(await head.text(), '');
  for (const path of ['/logos/FAKE.svg', '/logos/README.txt', '/logos/accounts.sqlite', '/logos/..%2faccounts.mjs']) {
    assert.equal((await client(url).request(path)).status, 404, path);
  }
});

test('no verified standings means honest unavailable scores, never a fake zero leaderboard', async t => {
  const { url } = await setup(t);
  const fan = client(url);
  await fan.register();
  const submitted = await fan.request('/api/prediction/submit', 'POST', { teamIds: picks(), revision: 0 });
  assert.equal(submitted.data.score, null);
  assert.equal(submitted.data.scoring.available, false);
  const leaderboard = await client(url).request('/api/leaderboard');
  assert.equal(leaderboard.data.entries[0].points, null);
  assert.equal(leaderboard.data.entries[0].rank, null);
  assert.match(leaderboard.data.scoring.error, /disabled/);
  assert.equal((await client(url).request('/api/standings')).data.teams, null);
});

test('verified cache persists privately, rejected season preserves prior scores with a refresh error', async t => {
  let next = snapshot(new Date(previousDailyUpdate(Date.now() - 5 * 60 * 1000) - 60_000).toISOString());
  const { url, app, standingsCachePath } = await setup(t, { standingsProvider: async () => next });
  assert.equal(statSync(standingsCachePath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(standingsCachePath, 'utf8')).season, 20262027);
  const before = await client(url).request('/api/standings');
  assert.equal(before.data.scoring.available, true);
  assert.equal(before.data.scoring.stale, true);
  next = { ...snapshot(), season: 20252026 };
  const metadata = await app.refreshStandings();
  assert.equal(metadata.available, true);
  assert.match(metadata.error, /last verified/);
  assert.deepEqual((await client(url).request('/api/standings')).data.teams, before.data.teams);
  assert.equal(JSON.parse(readFileSync(standingsCachePath, 'utf8')).season, 20262027);
});

test('saved accounts, sessions, submitted predictions, and verified scoring survive a server restart', async t => {
  const context = await setup(t, { standingsProvider: async () => snapshot() });
  const fan = client(context.url);
  await fan.register();
  const submitted = await fan.request('/api/prediction/submit', 'POST', { teamIds: picks(), revision: 0 });
  const cookie = fan.cookie;
  await context.app.close();
  const restarted = createApp({ dbPath: context.dbPath, standingsCachePath: context.standingsCachePath, allowStandingsFetch: false });
  await new Promise(resolve => restarted.server.listen(0, '127.0.0.1', resolve));
  t.after(() => restarted.close());
  const url = `http://127.0.0.1:${restarted.server.address().port}`;
  const response = await fetch(`${url}/api/session`, { headers: { Cookie: cookie } });
  const data = await response.json();
  assert.equal(data.user.username, 'fanalpha');
  assert.deepEqual(data.prediction, submitted.data.prediction);
  assert.equal(data.score, submitted.data.score);
  assert.equal(data.scoring.available, true);
});
