import test from 'node:test';
import assert from 'node:assert/strict';
import { hostingConfig, requestContext, createRateLimiter } from '../hosting.mjs';

const publicSite = hostingConfig('https://picks.example.com');
const request = (headers = {}, extra = {}) => ({ method: 'GET', url: '/api/session',
  socket: { remoteAddress: '127.0.0.1', localPort: 8765 }, headers: { host: 'picks.example.com',
    'x-forwarded-proto': 'https', 'x-playoff-client-ip': '203.0.113.9', ...headers }, ...extra });

test('public hosting accepts only an explicit HTTPS origin and host-only secure cookie', () => {
  assert.deepEqual(publicSite, { publicOrigin: 'https://picks.example.com', host: 'picks.example.com',
    secure: true, cookieName: '__Host-playoff_pick_session', proxyMode: 'caddy' });
  assert.equal(hostingConfig('https://PICKS.example.com/').publicOrigin, publicSite.publicOrigin);
  assert.equal(hostingConfig('https://picks.example.com:8443').host, 'picks.example.com:8443');
  assert.equal(hostingConfig(undefined).secure, false);
  for (const origin of ['', 'http://picks.example.com', 'https://user:password@picks.example.com',
    'https://picks.example.com/path', 'https://picks.example.com?secret=1', 'https://picks.example.com#hash',
    ' https://picks.example.com', 'https://localhost', 'https://127.0.0.1', {}]) {
    assert.throws(() => hostingConfig(origin), /HTTPS origin/);
  }
});

test('public requests need exact Host, trusted loopback hop and secure proxy metadata', () => {
  assert.deepEqual(requestContext(request(), publicSite), { origin: publicSite.publicOrigin, ip: '203.0.113.9' });
  for (const headers of [{ host: 'attacker.example' }, { host: '127.0.0.1:8765' },
    { 'x-forwarded-proto': 'http' }, { 'x-forwarded-proto': 'https, http' },
    { 'x-playoff-client-ip': undefined }, { 'x-playoff-client-ip': '203.0.113.9, 203.0.113.10' },
    { 'x-playoff-client-ip': 'attacker.example' }]) {
    assert.throws(() => requestContext(request(headers), publicSite), { status: 403 });
  }
  assert.throws(() => requestContext(request({}, { socket: { remoteAddress: '203.0.113.9', localPort: 8765 } }), publicSite), { status: 403 });
  assert.equal(requestContext(request({ 'x-playoff-client-ip': '::ffff:203.0.113.9' }), publicSite).ip, '203.0.113.9');
  assert.equal(requestContext(request({ 'x-forwarded-for': '192.0.2.111', 'x-real-ip': '192.0.2.222' }), publicSite).ip, '203.0.113.9');
});

test('public mutations and API reads reject foreign Origin and cross-site fetches', () => {
  assert.doesNotThrow(() => requestContext(request({ origin: publicSite.publicOrigin }, { method: 'POST' }), publicSite));
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.throws(() => requestContext(request({}, { method }), publicSite), { status: 403 });
    assert.throws(() => requestContext(request({ origin: 'https://attacker.example' }, { method }), publicSite), { status: 403 });
  }
  for (const site of ['same-site', 'cross-site']) {
    assert.throws(() => requestContext(request({ 'sec-fetch-site': site }), publicSite), { status: 403 });
  }
  assert.throws(() => requestContext(request({ origin: 'null' }), publicSite), { status: 403 });
  assert.doesNotThrow(() => requestContext(request({ 'sec-fetch-site': 'cross-site' }, { url: '/' }), publicSite));
});

test('local preview refuses accidental public proxy forwarding', () => {
  const local = hostingConfig();
  const localRequest = { method: 'GET', url: '/', socket: { remoteAddress: '127.0.0.1', localPort: 8765 },
    headers: { host: '127.0.0.1:8765' } };
  assert.equal(requestContext(localRequest, local).origin, 'http://127.0.0.1:8765');
  for (const header of ['forwarded', 'x-forwarded-for', 'x-forwarded-proto', 'x-playoff-client-ip', 'via', 'x-real-ip']) {
    assert.throws(() => requestContext({ ...localRequest, headers: { ...localRequest.headers, [header]: '127.0.0.1' } }, local), { status: 403 });
  }
});

test('Cloudflare Tunnel mode trusts only its single edge visitor-IP header', () => {
  const tunnel = hostingConfig('https://picks.aleksi.net', 'cloudflare-tunnel');
  const tunnelRequest = headers => request({ host: 'picks.aleksi.net', 'cf-connecting-ip': '198.51.100.9', ...headers });
  assert.equal(requestContext(tunnelRequest({ 'x-playoff-client-ip': '192.0.2.200', 'x-forwarded-for': '192.0.2.222' }), tunnel).ip, '198.51.100.9');
  for (const headers of [{ 'cf-connecting-ip': undefined }, { 'cf-connecting-ip': '198.51.100.9, 192.0.2.1' },
    { 'cf-connecting-ip': 'fake' }, { 'x-forwarded-proto': 'http' }]) {
    assert.throws(() => requestContext(tunnelRequest(headers), tunnel), { status: 403 });
  }
  assert.throws(() => hostingConfig('https://picks.aleksi.net', 'any-proxy'), /PLAYOFF_PICK_PROXY/);
  const local = { method: 'GET', url: '/', socket: { remoteAddress: '127.0.0.1', localPort: 8765 },
    headers: { host: '127.0.0.1:8765', 'cf-connecting-ip': '198.51.100.9' } };
  assert.throws(() => requestContext(local, hostingConfig()), { status: 403 });
});

test('rate limits remain bounded and recover after expiry, including full capacity', () => {
  let now = 0;
  const limit = createRateLimiter({ now: () => now, capacity: 2, windowMs: 1000 });
  limit('a', 2); limit('a', 2);
  assert.throws(() => limit('a', 2), { status: 429 });
  limit('b', 2);
  assert.throws(() => limit('c', 2), { status: 429 });
  now = 1000;
  assert.doesNotThrow(() => limit('c', 2));
  assert.doesNotThrow(() => limit('a', 2));
});
