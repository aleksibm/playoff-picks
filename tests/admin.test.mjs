import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { createLocalAdmin, isLoopbackAddress } from '../admin.mjs';
import { TEAMS } from '../dist/game.js';

const PASSWORD = 'Admin-Test-Hockey-2026';
const completePicks = ['Atlantic', 'Metropolitan', 'Central', 'Pacific']
  .flatMap(division => TEAMS.filter(team => team.division === division).slice(0, 4).map(team => team.id));

function standings(extraPoints = 0) {
  return {
    season: 20262027, asOf: '2026-10-09', fetchedAt: new Date().toISOString(),
    teams: Object.fromEntries(TEAMS.map((team, index) => [team.id, {
      points: (index + 1 + extraPoints) * 2, wins: index + 1 + extraPoints,
      otLosses: 0, gamesPlayed: index + 3 + extraPoints,
    }])),
  };
}

async function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'playoff-admin-'));
  const app = createApp({ dbPath: join(directory, 'accounts.sqlite'),
    standingsCachePath: join(directory, 'standings.json'), allowStandingsFetch: false, ...options });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  await app.refreshStandings();
  const playerUrl = `http://127.0.0.1:${app.server.address().port}`;
  const adminUrl = new URL(await app.startAdmin(0)).origin;
  return { app, playerUrl, adminUrl, directory };
}

function request(url, path, { method = 'GET', body, headers = {} } = {}) {
  const target = new URL(path, url);
  const encoded = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const outgoing = http.request(target, { method, headers, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const data = response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : text;
        resolve({ status: response.statusCode, headers: response.headers, data });
      });
    });
    outgoing.on('error', reject);
    outgoing.end(encoded);
  });
}

function player(url) {
  let cookie = '';
  let csrfToken = '';
  return {
    get cookie() { return cookie; },
    get csrfToken() { return csrfToken; },
    async send(path, method = 'GET', body) {
      const result = await request(url, path, { method, body, headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(method === 'GET' ? {} : { Origin: url, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }),
      } });
      if (result.headers['set-cookie']) cookie = result.headers['set-cookie'][0].split(';')[0];
      if (result.data.csrfToken) csrfToken = result.data.csrfToken;
      return result;
    },
    register(username) { return this.send('/api/register', 'POST', { username, password: PASSWORD }); },
  };
}

function refresh(adminUrl, csrfToken, overrides = {}) {
  return request(adminUrl, '/api/admin/standings/refresh', { method: 'POST', body: {},
    headers: { Origin: adminUrl, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, ...overrides } });
}

test('admin access recognizes exact socket loopback addresses, not similar or forwarded strings', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(address), true, address);
  for (const address of [undefined, null, '', '127.0.0.2', '127.0.0.1:8766', '127.0.0.1.attacker.example',
    '192.168.1.2', '10.0.0.1', '0.0.0.0', '::', '::ffff:192.168.1.2', '::ffff:7f00:1',
    '127.0.0.1, 192.168.1.2', 'for=127.0.0.1']) assert.equal(isLoopbackAddress(address), false, String(address));
});

test('the administration listener binds only to IPv4 loopback', async t => {
  const admin = createLocalAdmin({ overview: () => ({}), refreshStandings: async () => {}, canRefresh: false });
  t.after(() => admin.close());
  const url = await admin.start(0);
  assert.equal(admin.address().address, '127.0.0.1');
  assert.equal(admin.address().family, 'IPv4');
  assert.equal(Number(new URL(url).port), admin.address().port);
});

test('admin uses a separate local port and the player server exposes no admin routes or assets', async t => {
  const { playerUrl, adminUrl } = await setup(t);
  assert.match(adminUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(new URL(adminUrl).port, new URL(playerUrl).port);
  for (const path of ['/', '/admin']) {
    const result = await request(adminUrl, path);
    assert.equal(result.status, 200, path);
    assert.match(result.data, /<!doctype html>/i);
  }
  for (const path of ['/admin.css', '/admin.js', '/game.js', '/icon.svg']) {
    assert.equal((await request(adminUrl, path)).status, 200, path);
  }
  for (const path of ['/admin', '/admin/', '/admin.css', '/admin.js', '/api/admin/overview', '/api/admin/standings/refresh']) {
    assert.equal((await request(playerUrl, path)).status, 404, path);
  }
});

test('an empty admin overview reports unavailable points without exposing account internals', async t => {
  const { adminUrl, playerUrl } = await setup(t);
  const result = await request(adminUrl, '/api/admin/overview');
  assert.equal(result.status, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['x-content-type-options'], 'nosniff');
  assert.equal(result.headers['x-frame-options'], 'DENY');
  assert.match(result.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(Object.keys(result.data).sort(), ['accounts', 'csrfToken', 'leaderboard', 'scoring', 'season', 'server', 'summary', 'teams']);
  assert.equal(result.data.season, 20262027);
  assert.deepEqual(result.data.summary, { accounts: 0, drafts: 0, submitted: 0 });
  assert.deepEqual(result.data.accounts, []);
  assert.equal(result.data.scoring.available, false);
  assert.equal(result.data.server.canRefresh, false);
  assert.equal(result.data.server.updateSchedule.time, '12:00');
  assert.equal(result.data.server.updateSchedule.timeZone, 'Europe/Helsinki');
  assert.equal(new URL(result.data.server.playerUrl).origin, playerUrl);
  assert.ok(Number.isFinite(Date.parse(result.data.server.startedAt)));
  assert.match(result.data.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.data.teams, null);
  assert.deepEqual(result.data.leaderboard, []);
});

test('admin lists unsaved accounts, private drafts and submitted predictions with verified scores', async t => {
  const verified = standings();
  const { adminUrl, playerUrl } = await setup(t, { standingsProvider: async () => verified });
  const noPicks = player(playerUrl);
  const draft = player(playerUrl);
  const submitted = player(playerUrl);
  await noPicks.register('UnpickedFan');
  await draft.register('DraftFan');
  await submitted.register('SubmittedFan');
  const saved = await draft.send('/api/prediction', 'PUT', { teamIds: ['BOS'], revision: 0 });
  const locked = await submitted.send('/api/prediction/submit', 'POST', { teamIds: completePicks, revision: 0 });
  assert.equal(saved.status, 200);
  assert.equal(locked.status, 200);
  const overview = (await request(adminUrl, '/api/admin/overview')).data;
  assert.deepEqual(overview.summary, { accounts: 3, drafts: 1, submitted: 1 });
  assert.equal(overview.accounts.length, 3);
  assert.deepEqual(overview.teams, verified.teams);
  assert.deepEqual(overview.leaderboard.map(entry => entry.username), ['submittedfan']);
  assert.equal(overview.leaderboard[0].rank, 1);
  const byName = Object.fromEntries(overview.accounts.map(account => [account.username, account]));
  assert.equal(byName.unpickedfan.prediction, null);
  assert.equal(byName.unpickedfan.points, null);
  assert.deepEqual(byName.draftfan.prediction, saved.data.prediction);
  assert.equal(byName.draftfan.points, null);
  assert.deepEqual(byName.submittedfan.prediction, locked.data.prediction);
  assert.equal(byName.submittedfan.points, completePicks.reduce((sum, id) => sum + verified.teams[id].points, 0));
  for (const account of overview.accounts) {
    assert.deepEqual(Object.keys(account).sort(), ['createdAt', 'displayName', 'id', 'points', 'prediction', 'username']);
    assert.ok(Number.isFinite(Date.parse(account.createdAt)));
  }
  const encoded = JSON.stringify(overview);
  for (const secret of [PASSWORD, noPicks.csrfToken, draft.csrfToken, submitted.csrfToken,
    noPicks.cookie.split('=')[1], draft.cookie.split('=')[1], submitted.cookie.split('=')[1]]) {
    assert.ok(!encoded.includes(secret), 'Account credentials or session tokens leaked');
  }
  assert.ok(!/password|salt|sessionHash|sessionToken|tokenHash/i.test(encoded));
  assert.deepEqual((await submitted.send('/api/session')).data.prediction, locked.data.prediction);
});

test('admin rejects nonlocal Hosts, foreign Origins and browser requests from other sites', async t => {
  const { adminUrl } = await setup(t);
  const port = new URL(adminUrl).port;
  assert.equal((await request(adminUrl, '/api/admin/overview', { headers: { Host: `localhost:${port}` } })).status, 200);
  for (const host of ['attacker.example', '127.0.0.1', `127.0.0.1:${Number(port) + 1}`, `[::1]:${port}`, `127.0.0.1.attacker.example:${port}`]) {
    assert.equal((await request(adminUrl, '/api/admin/overview', { headers: { Host: host } })).status, 403, host);
  }
  for (const origin of ['https://attacker.example', 'null', 'http://127.0.0.1:8765']) {
    assert.equal((await request(adminUrl, '/api/admin/overview', { headers: { Origin: origin } })).status, 403, origin);
  }
  for (const site of ['cross-site', 'same-site']) {
    for (const path of ['/', '/admin.js', '/api/admin/overview']) {
      assert.equal((await request(adminUrl, path, { headers: { 'Sec-Fetch-Site': site } })).status, 403, `${site} ${path}`);
    }
  }
  assert.equal((await request(adminUrl, '/api/admin/overview', { headers: { Origin: adminUrl, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
});

test('admin refuses proxy and address forwarding headers even when they claim localhost', async t => {
  const { adminUrl } = await setup(t);
  for (const [header, value] of [['Forwarded', 'for=127.0.0.1'], ['X-Forwarded-For', '127.0.0.1'],
    ['X-Forwarded-Host', new URL(adminUrl).host], ['X-Forwarded-Proto', 'http'], ['X-Forwarded-Port', new URL(adminUrl).port],
    ['Via', '1.1 localhost'], ['X-Real-IP', '127.0.0.1'], ['X-Forwarded-Custom', 'localhost'], ['X-Playoff-Client-IP', '127.0.0.1'],
    ['CF-Connecting-IP', '127.0.0.1'], ['CF-Visitor', '{"scheme":"https"}'], ['CF-Ray', 'test']]) {
    assert.equal((await request(adminUrl, '/api/admin/overview', { headers: { [header]: value } })).status, 403, header);
  }
});

test('manual refresh requires the admin Origin and CSRF token, not a player session token', async t => {
  let calls = 0;
  const { adminUrl, playerUrl } = await setup(t, { standingsProvider: async () => { calls += 1; return standings(); } });
  const before = calls;
  const fan = player(playerUrl);
  await fan.register('CsrfFan');
  const overview = (await request(adminUrl, '/api/admin/overview')).data;
  for (const overrides of [{ Origin: '' }, { Origin: playerUrl }, { 'X-CSRF-Token': '' },
    { 'X-CSRF-Token': 'wrong' }, { 'X-CSRF-Token': fan.csrfToken }]) {
    assert.equal((await refresh(adminUrl, overview.csrfToken, overrides)).status, 403);
  }
  assert.equal(calls, before);
  const accepted = await refresh(adminUrl, overview.csrfToken);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.scoring.available, true);
  assert.equal(calls, before + 1);
});

test('admin refresh changes real team points while submitted fields remain locked', async t => {
  let next = standings();
  const { adminUrl, playerUrl } = await setup(t, { standingsProvider: async () => next });
  const fan = player(playerUrl);
  await fan.register('RefreshFan');
  const locked = await fan.send('/api/prediction/submit', 'POST', { teamIds: completePicks, revision: 0 });
  const before = (await request(adminUrl, '/api/admin/overview')).data;
  next = standings(1);
  const refreshed = await refresh(adminUrl, before.csrfToken);
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.data.accounts[0].points, before.accounts[0].points + completePicks.length * 2);
  assert.deepEqual(refreshed.data.accounts[0].prediction, locked.data.prediction);
  assert.deepEqual((await fan.send('/api/session')).data.prediction, locked.data.prediction);
  assert.equal((await fan.send('/api/prediction', 'PUT', { teamIds: ['BOS'], revision: 1 })).status, 409);
});

test('failed admin refresh preserves the last verified score and reports the failure', async t => {
  let shouldFail = false;
  const { adminUrl, playerUrl } = await setup(t, { standingsProvider: async () => {
    if (shouldFail) throw new Error('Test feed is unreachable');
    return standings();
  } });
  const fan = player(playerUrl);
  await fan.register('CachedFan');
  await fan.send('/api/prediction/submit', 'POST', { teamIds: completePicks, revision: 0 });
  const before = (await request(adminUrl, '/api/admin/overview')).data;
  shouldFail = true;
  const result = await refresh(adminUrl, before.csrfToken);
  assert.equal(result.status, 200);
  assert.equal(result.data.accounts[0].points, before.accounts[0].points);
  assert.deepEqual(result.data.accounts[0].prediction, before.accounts[0].prediction);
  assert.equal(result.data.scoring.available, true);
  assert.match(result.data.scoring.error, /last verified/);
});

test('disabled standings refresh returns a conflict without inventing points', async t => {
  const { adminUrl } = await setup(t);
  const before = (await request(adminUrl, '/api/admin/overview')).data;
  const result = await refresh(adminUrl, before.csrfToken);
  assert.equal(result.status, 409);
  const after = (await request(adminUrl, '/api/admin/overview')).data;
  assert.equal(after.scoring.available, false);
  assert.deepEqual(after.summary, before.summary);
});

test('admin refresh accepts only a bounded empty JSON body and never an arbitrary feed URL', async t => {
  let calls = 0;
  const { adminUrl } = await setup(t, { standingsProvider: async () => { calls += 1; return standings(); } });
  const before = calls;
  const csrfToken = (await request(adminUrl, '/api/admin/overview')).data.csrfToken;
  const send = (body, contentType = 'application/json') => request(adminUrl, '/api/admin/standings/refresh', {
    method: 'POST', body, headers: { Origin: adminUrl, 'X-CSRF-Token': csrfToken, 'Content-Type': contentType },
  });
  assert.equal((await send('{}', 'text/plain')).status, 415);
  for (const body of ['{bad json', '[]', 'null', '{"url":"https://attacker.example"}', '{"teamIds":["BOS"]}']) {
    assert.equal((await send(body)).status, 400, body);
  }
  assert.equal((await send(JSON.stringify({ padding: 'x'.repeat(1100) }))).status, 413);
  assert.equal(calls, before);
});

test('admin method handling and asset allowlist prevent writes and private file exposure', async t => {
  const { adminUrl } = await setup(t);
  const csrfToken = (await request(adminUrl, '/api/admin/overview')).data.csrfToken;
  for (const path of ['/', '/admin', '/admin.js', '/admin.css', '/game.js', '/icon.svg', '/api/admin/overview']) {
    assert.equal((await request(adminUrl, path, { method: 'POST', body: {},
      headers: { Origin: adminUrl, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken } })).status, 405, path);
  }
  assert.equal((await request(adminUrl, '/api/admin/standings/refresh')).status, 405);
  for (const path of ['/server.mjs', '/admin.mjs', '/accounts.mjs', '/.local-data/accounts.sqlite', '/standings.json',
    '/index.html', '/app.js', '/styles.css', '/dist/admin.html', '/..%2faccounts.mjs', '/api/session', '/api/admin/accounts/delete']) {
    assert.equal((await request(adminUrl, path)).status, 404, path);
  }
});

test('closing the app closes both local listeners', async t => {
  const { app, adminUrl, playerUrl } = await setup(t);
  assert.equal((await request(adminUrl, '/api/admin/overview')).status, 200);
  assert.equal((await request(playerUrl, '/api/session')).status, 200);
  await app.close();
  for (const url of [adminUrl, playerUrl]) {
    await assert.rejects(request(url, '/'), error => error.code === 'ECONNREFUSED');
  }
});
