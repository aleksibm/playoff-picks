import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { TEAMS } from '../dist/game.js';

const ORIGIN = 'https://picks.example.com';
const PASSWORD = 'Public-Hockey-Test-Password-2026';
const PICKS = ['Atlantic', 'Metropolitan', 'Central', 'Pacific']
  .flatMap(division => TEAMS.filter(team => team.division === division).slice(0, 4).map(team => team.id));

async function setup(t, options = {}) {
  const app = createApp({ dbPath: ':memory:', allowStandingsFetch: false, publicOrigin: ORIGIN, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const backend = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());
  const send = (path, { method = 'GET', body, headers = {}, ip = '203.0.113.1' } = {}) => new Promise((resolve, reject) => {
    const outgoing = http.request(new URL(path, backend), { method, agent: false, headers: {
      Host: 'picks.example.com', 'X-Forwarded-Proto': 'https',
      [options.proxyMode === 'cloudflare-tunnel' ? 'CF-Connecting-IP' : 'X-Playoff-Client-IP']: ip,
      ...(body !== undefined ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}), ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: response.statusCode, headers: response.headers,
          data: response.headers['content-type']?.includes('json') ? JSON.parse(text) : text });
      });
    });
    outgoing.on('error', reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { app, backend, send };
}

test('public HTTPS account flow has secure cookies, CSRF, ownership and permanently locked picks', async t => {
  const { send } = await setup(t);
  const fan = await send('/api/register', { method: 'POST', body: { username: 'PublicFan', password: PASSWORD } });
  assert.equal(fan.status, 200);
  const setCookie = fan.headers['set-cookie'][0];
  assert.match(setCookie, /^__Host-playoff_pick_session=/);
  assert.match(setCookie, /HttpOnly; SameSite=Strict; Path=\//);
  assert.match(setCookie, /; Secure$/);
  assert.ok(!/Domain=/i.test(setCookie));
  const headers = { Cookie: setCookie.split(';')[0], 'X-CSRF-Token': fan.data.csrfToken };
  assert.equal((await send('/api/session', { headers })).data.user.username, 'publicfan');
  assert.equal((await send('/api/session', { headers: { Cookie: `${headers.Cookie}; ${headers.Cookie}` } })).data.user, null);
  const legacyCookie = headers.Cookie.replace('__Host-playoff_pick_session', 'playoff_pick_session');
  assert.equal((await send('/api/session', { headers: { Cookie: legacyCookie } })).data.user, null);
  assert.equal((await send('/api/prediction', { method: 'PUT', body: { teamIds: PICKS, revision: 0 }, headers: { ...headers, 'X-CSRF-Token': 'forged' } })).status, 403);
  assert.equal((await send('/api/prediction', { method: 'PUT', body: { teamIds: PICKS, revision: 0 }, headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  const saved = await send('/api/prediction', { method: 'PUT', body: { teamIds: PICKS, revision: 0 }, headers });
  assert.equal(saved.status, 200);
  const locked = await send('/api/prediction/submit', { method: 'POST', body: { teamIds: PICKS, revision: saved.data.prediction.revision }, headers });
  assert.equal(locked.status, 200);
  assert.equal(locked.data.prediction.state, 'submitted');
  assert.equal((await send('/api/prediction', { method: 'PUT', body: { teamIds: ['BOS'], revision: locked.data.prediction.revision }, headers })).status, 409);
  const stranger = await send('/api/register', { method: 'POST', body: { username: 'OtherPublicFan', password: PASSWORD }, ip: '203.0.113.2' });
  assert.equal(stranger.status, 200);
  assert.equal((await send('/api/session', { headers: { Cookie: stranger.headers['set-cookie'][0].split(';')[0] } })).data.prediction, null);
  const leaderboard = await send('/api/leaderboard');
  assert.equal(leaderboard.data.entries.length, 1);
  assert.equal(leaderboard.data.entries[0].username, 'publicfan');
  for (const secret of [PASSWORD, fan.data.csrfToken, headers.Cookie.split('=')[1]]) {
    assert.ok(!JSON.stringify(leaderboard.data).includes(secret));
  }
  const logout = await send('/api/logout', { method: 'POST', body: {}, headers });
  assert.equal(logout.status, 200);
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0; Secure$/);
  assert.equal((await send('/api/session', { headers })).data.user, null);
});

test('public logout requires the same origin and CSRF token before revoking a session', async t => {
  const { send } = await setup(t);
  const fan = await send('/api/register', { method: 'POST', body: { username: 'LogoutFan', password: PASSWORD } });
  const headers = { Cookie: fan.headers['set-cookie'][0].split(';')[0], 'X-CSRF-Token': fan.data.csrfToken };
  for (const overrides of [{ Origin: '' }, { Origin: 'https://evil.example' }, { 'X-CSRF-Token': '' }]) {
    assert.equal((await send('/api/logout', { method: 'POST', body: {}, headers: { ...headers, ...overrides } })).status, 403);
    assert.equal((await send('/api/session', { headers })).data.user.username, 'logoutfan');
  }
});

test('public authentication overload responds with 503 and short Retry-After rather than queuing hashes', async t => {
  const { send } = await setup(t);
  const responses = await Promise.all([1, 2, 3].map(index => send('/api/register', { method: 'POST',
    ip: `192.0.2.${index}`, body: { username: `ConcurrentFan${index}`, password: PASSWORD } })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 200, 503]);
  assert.equal(responses.find(response => response.status === 503).headers['retry-after'], '2');
});

test('public assets carry hardened headers and never expose admin, database or deployment sources', async t => {
  const { send } = await setup(t);
  const home = await send('/');
  assert.equal(home.status, 200);
  assert.equal(home.headers['strict-transport-security'], 'max-age=31536000');
  assert.equal(home.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(home.headers['x-frame-options'], 'DENY');
  assert.match(home.headers['content-security-policy'], /object-src 'none'/);
  assert.ok(!/id="(?:share|download)"/.test(home.data));
  for (const path of ['/admin', '/admin.html', '/admin.js', '/api/admin/overview', '/accounts.mjs',
    '/hosting.mjs', '/.local-data/accounts.sqlite', '/deployment/playoff-picks.env.example', '/.env', '/package.json']) {
    assert.equal((await send(path)).status, 404, path);
  }
  assert.deepEqual((await send('/api/health')).data, { ok: true, season: 20262027 });
});

test('public server rejects direct HTTP and forged proxy requests and cross-site API reads', async t => {
  const { backend, send } = await setup(t);
  assert.equal((await fetch(`${backend}/api/health`)).status, 403);
  for (const headers of [{ Host: 'evil.example' }, { 'X-Forwarded-Proto': 'http' },
    { 'X-Playoff-Client-IP': '' }, { 'X-Playoff-Client-IP': '203.0.113.1, 203.0.113.2' },
    { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await send('/api/session', { headers })).status, 403);
  }
  assert.equal((await send('/api/register', { method: 'POST', body: { username: 'Fan', password: PASSWORD }, headers: { Origin: '' } })).status, 403);
});

test('proxy visitor addresses receive independent limits; forged forwarding cannot bypass them', async t => {
  const { send } = await setup(t);
  const attempt = (ip, username, headers = {}) => send('/api/login', { method: 'POST', ip, headers,
    body: { username, password: PASSWORD } });
  for (let index = 0; index < 10; index += 1) assert.equal((await attempt('203.0.113.1', 'AbsentFan')).status, 401);
  const limited = await attempt('203.0.113.1', 'AbsentFan', { 'X-Forwarded-For': '192.0.2.100', 'X-Real-IP': '192.0.2.101' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '600');
  assert.equal((await attempt('203.0.113.2', 'AnotherFan')).status, 401);
  for (let index = 2; index < 12; index += 1) assert.equal((await attempt(`203.0.113.${index}`, 'AbsentFan')).status, 401);
  assert.equal((await attempt('203.0.113.200', 'AbsentFan')).status, 429);
});

test('production process refuses missing HTTPS origin before opening account storage', () => {
  const old = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { assert.throws(() => createApp({ publicOrigin: null, dbPath: ':memory:', allowStandingsFetch: false }), /HTTPS reverse proxy/); }
  finally { if (old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old; }
});

test('Cloudflare Tunnel accounts use HTTPS sessions and the edge IP despite forged forwarding', async t => {
  const { app, send } = await setup(t, { proxyMode: 'cloudflare-tunnel' });
  assert.equal(app.publicOrigin, ORIGIN);
  const fan = await send('/api/register', { method: 'POST', body: { username: 'TunnelFan', password: PASSWORD } });
  assert.equal(fan.status, 200);
  assert.match(fan.headers['set-cookie'][0], /^__Host-playoff_pick_session=.*; Secure$/);
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await send('/api/login', { method: 'POST', headers: { 'X-Forwarded-For': `192.0.2.${index}`, 'X-Playoff-Client-IP': `198.51.100.${index}` },
      body: { username: 'MissingTunnelFan', password: PASSWORD } })).status, 401);
  }
  assert.equal((await send('/api/login', { method: 'POST', body: { username: 'MissingTunnelFan', password: PASSWORD },
    headers: { 'X-Playoff-Client-IP': '198.51.100.99' } })).status, 429);
  assert.equal((await send('/api/session', { headers: { 'CF-Connecting-IP': '' } })).status, 403);
  assert.equal((await send('/api/session', { headers: { 'X-Forwarded-Proto': 'http' } })).status, 403);
  assert.equal((await send('/api/admin/overview')).status, 404);
});
