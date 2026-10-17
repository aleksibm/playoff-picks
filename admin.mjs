import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = new Map([
  ['/', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin/', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin.css', ['admin.css', 'text/css; charset=utf-8']],
  ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']],
  ['/game.js', ['game.js', 'text/javascript; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);

function failure(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export const isLoopbackAddress = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);

function requireLocalRequest(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw failure(403, 'Administration is only available on the hosting computer.');
  }
  const hosts = [`127.0.0.1:${request.socket.localPort}`, `localhost:${request.socket.localPort}`];
  if (!hosts.includes(request.headers.host)) throw failure(403, 'Use the local administration address.');
  if (Object.keys(request.headers).some(name => name.startsWith('x-forwarded-') || name.startsWith('cf-')
    || ['forwarded', 'via', 'x-real-ip', 'x-playoff-client-ip'].includes(name))) {
    throw failure(403, 'Administration cannot be accessed through a proxy.');
  }
  const origin = `http://${request.headers.host}`;
  if (request.headers.origin !== undefined && request.headers.origin !== origin) {
    throw failure(403, 'This request must come from the local administration page.');
  }
  const site = request.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'none' && site !== 'same-origin') {
    throw failure(403, 'Open the administration address directly on this computer.');
  }
  return origin;
}

function equalTokens(received, expected) {
  if (typeof received !== 'string') return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

function readAdminJSON(request) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? '')) {
    throw failure(415, 'Send this request as JSON.');
  }
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    let rejected = false;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > 4096) {
        if (!rejected) rejectBody(failure(413, 'This request is too large.'));
        rejected = true;
        chunks.length = 0;
      } else if (!rejected) chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolveBody(body);
      } catch { rejectBody(failure(400, 'Send a JSON object with the account action.')); }
    });
    request.on('error', () => rejectBody(failure(400, 'This request could not be read.')));
    request.on('aborted', () => rejectBody(failure(400, 'This request was interrupted.')));
  });
}

/** A separate listener that can only bind to this computer's IPv4 loopback. */
export function createLocalAdmin({ overview, refreshStandings, canRefresh, manageAccount }) {
  const csrfToken = randomBytes(32).toString('base64url');
  const responseBody = () => ({ ...overview(), csrfToken });
  let closed = false;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; img-src 'self'; connect-src 'self'; font-src 'self' https://fonts.gstatic.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    try {
      const origin = requireLocalRequest(request);
      if (!request.url?.startsWith('/')) throw failure(400, 'Invalid request address.');
      const path = request.url.split('?')[0];
      if (path.includes('%') || path.includes('\\') || path.split('/').some(part => part === '.' || part === '..')) {
        throw failure(404, 'Page not found.');
      }
      if (path === '/api/admin/overview') {
        if (request.method !== 'GET') {
          response.setHeader('Allow', 'GET');
          throw failure(405, 'This request method is not supported.');
        }
        return json(response, 200, responseBody());
      }
      const accountAction = /^\/api\/admin\/accounts\/([1-9]\d*)\/(rename|password|reset-prediction)$/.exec(path);
      if (accountAction && manageAccount) {
        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST');
          throw failure(405, 'This request method is not supported.');
        }
        if (request.headers.origin !== origin || !equalTokens(request.headers['x-csrf-token'], csrfToken)) {
          throw failure(403, 'Reload the local administration page before changing an account.');
        }
        const userId = Number(accountAction[1]);
        if (!Number.isSafeInteger(userId)) throw failure(404, 'Account not found.');
        const body = await readAdminJSON(request);
        const field = {rename:'username', password:'password', 'reset-prediction':'revision'}[accountAction[2]];
        if (Object.keys(body).some(key => key !== field && key !== 'expectedUsername')
            || !Object.hasOwn(body, field) || !Object.hasOwn(body, 'expectedUsername')) {
          throw failure(400, 'Send the selected account action only.');
        }
        await manageAccount(userId, accountAction[2], body);
        if (closed) throw failure(503, 'The local app is shutting down.');
        return json(response, 200, responseBody());
      }
      if (path === '/api/admin/standings/refresh') {
        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST');
          throw failure(405, 'This request method is not supported.');
        }
        if (request.headers.origin !== origin || !equalTokens(request.headers['x-csrf-token'], csrfToken)) {
          throw failure(403, 'Reload the local administration page before refreshing.');
        }
        if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? '')) {
          throw failure(415, 'Send this request as JSON.');
        }
        // This action accepts an empty object only; no user data or feed URL is accepted.
        const body = await new Promise((resolveBody, rejectBody) => {
          let size = 0;
          const chunks = [];
          let rejected = false;
          request.on('data', chunk => {
            size += chunk.length;
            if (size > 1024) {
              if (!rejected) rejectBody(failure(413, 'This request is too large.'));
              rejected = true;
              chunks.length = 0;
            } else if (!rejected) chunks.push(chunk);
          });
          request.on('end', () => {
            if (rejected) return;
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new Error();
              resolveBody(value);
            } catch { rejectBody(failure(400, 'Send an empty JSON object to refresh standings.')); }
          });
          request.on('error', () => rejectBody(failure(400, 'This request could not be read.')));
          request.on('aborted', () => rejectBody(failure(400, 'This request was interrupted.')));
        });
        if (!body || !canRefresh) throw failure(409, 'NHL standings updates are disabled for this app.');
        await refreshStandings();
        if (closed) return json(response, 503, { error: 'The local app is shutting down.' });
        return json(response, 200, responseBody());
      }
      const asset = ASSETS.get(path);
      if (!asset) throw failure(404, 'Page not found.');
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        throw failure(405, 'This request method is not supported.');
      }
      const content = readFileSync(join(HERE, 'dist', asset[0]));
      response.statusCode = 200;
      response.setHeader('Content-Type', asset[1]);
      response.setHeader('Content-Length', content.length);
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      request.resume();
      if (response.writableEnded || response.destroyed) return;
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : error.status === 503 ? 503 : 500;
      if (status === 503) response.setHeader('Retry-After', '2');
      json(response, status, { error: status === 500 ? 'The local administration page could not load. Try again.' : error.message });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  return {
    async start(port = 8766) {
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('The administration port must be between 0 and 65535.');
      if (closed) throw new Error('The administration server is closed.');
      if (server.listening) return `http://127.0.0.1:${server.address().port}/`;
      await new Promise((resolveStart, rejectStart) => {
        const onError = error => { server.off('listening', onListening); rejectStart(error); };
        const onListening = () => { server.off('error', onError); resolveStart(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return `http://127.0.0.1:${server.address().port}/`;
    },
    address() { return server.address(); },
    async close() {
      closed = true;
      if (server.listening) await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
    },
  };
}
