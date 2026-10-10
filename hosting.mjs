import { isIP } from 'node:net';
import { isLoopbackAddress } from './admin.mjs';

function failure(message) {
  const error = new Error(message);
  error.status = 403;
  return error;
}

/** Public traffic must pass through the same-host HTTPS reverse proxy. */
export function hostingConfig(publicOrigin, proxyMode = 'caddy') {
  if (!['caddy', 'cloudflare-tunnel'].includes(proxyMode)) {
    throw new Error('PLAYOFF_PICK_PROXY must be caddy or cloudflare-tunnel.');
  }
  if (publicOrigin === undefined || publicOrigin === null) {
    return { publicOrigin: null, host: null, secure: false, cookieName: 'playoff_pick_session', proxyMode };
  }
  let url;
  try { url = new URL(publicOrigin); } catch { /* Rejected below. */ }
  if (typeof publicOrigin !== 'string' || publicOrigin !== publicOrigin.trim()
      || !url || url.protocol !== 'https:' || url.username || url.password
      || url.search || url.hash || url.pathname !== '/' || !url.hostname
      || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('PLAYOFF_PICK_PUBLIC_ORIGIN must be a complete HTTPS origin, such as https://picks.example.com, without credentials, a path, or a query.');
  }
  return { publicOrigin: url.origin, host: url.host, secure: true, cookieName: '__Host-playoff_pick_session', proxyMode };
}

export function requestContext(request, config) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw failure('The application accepts requests only from its local reverse proxy.');
  }
  let origin;
  let ip = request.socket.remoteAddress;
  if (config.secure) {
    if (request.headers.host !== config.host || request.headers['x-forwarded-proto'] !== 'https') {
      throw failure('Use the configured HTTPS site address.');
    }
    // The selected ingress overwrites its client-IP field. A tunnel is trusted
    // only on loopback; arbitrary X-Forwarded-For values never identify fans.
    const clientIP = request.headers[config.proxyMode === 'cloudflare-tunnel' ? 'cf-connecting-ip' : 'x-playoff-client-ip'];
    if (typeof clientIP !== 'string' || !isIP(clientIP)) {
      throw failure('The HTTPS reverse proxy must provide the visitor address.');
    }
    ip = clientIP.startsWith('::ffff:') && isIP(clientIP.slice(7)) === 4 ? clientIP.slice(7) : clientIP;
    origin = config.publicOrigin;
  } else {
    const port = request.socket.localPort;
    if (![ `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}` ].includes(request.headers.host)) {
      throw failure('This local site only accepts local requests.');
    }
    if (Object.keys(request.headers).some(name => name.startsWith('x-forwarded-') || name.startsWith('cf-')
        || ['forwarded', 'via', 'x-real-ip', 'x-playoff-client-ip'].includes(name))) {
      throw failure('Configure the HTTPS public origin before using a reverse proxy.');
    }
    origin = `http://${request.headers.host}`;
  }
  if (request.headers.origin !== undefined && request.headers.origin !== origin) {
    throw failure('This request must come from this site.');
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && request.headers.origin !== origin) {
    throw failure('This request must come from this site.');
  }
  if (request.url?.startsWith('/api/') && request.headers['sec-fetch-site'] !== undefined
      && !['none', 'same-origin'].includes(request.headers['sec-fetch-site'])) {
    throw failure('This action must come from this site.');
  }
  return { origin, ip };
}

/** A bounded in-memory limiter; exceeding capacity fails closed until expiry. */
export function createRateLimiter({ now = Date.now, windowMs = 600_000, capacity = 4096 } = {}) {
  const entries = new Map();
  let lastCleanup = -Infinity;
  return (key, maximum) => {
    const time = now();
    if (time - lastCleanup >= 60_000 || entries.size >= capacity) {
      for (const [savedKey, saved] of entries) if (saved.until <= time) entries.delete(savedKey);
      lastCleanup = time;
    }
    let entry = entries.get(key);
    if (!entry || entry.until <= time) {
      if (!entry && entries.size >= capacity) {
        const error = new Error('The site is receiving too many requests. Please try again later.');
        error.status = 429;
        throw error;
      }
      entry = { count: 0, until: time + windowMs };
      entries.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > maximum) {
      const error = new Error('Too many attempts. Please try again in 10 minutes.');
      error.status = 429;
      throw error;
    }
  };
}
