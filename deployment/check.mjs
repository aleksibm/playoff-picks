import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
let failed = false;

function check(condition, message) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`);
  if (!condition) failed = true;
}

check(Number(process.versions.node.split('.')[0]) === 24,
  'Node.js 24 LTS runtime (keep its security patches current).');

try {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(':memory:');
  check(database.prepare('SELECT 1 AS ready').get().ready === 1, 'Built-in SQLite is available.');
  database.close();
} catch {
  check(false, 'Built-in SQLite is available.');
}

try {
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki' });
  check(formatter.resolvedOptions().timeZone === 'Europe/Helsinki', 'Helsinki timezone data is available.');
} catch {
  check(false, 'Helsinki timezone data is available.');
}

const required = ['server.mjs', 'accounts.mjs', 'admin.mjs', 'hosting.mjs', 'schedule.mjs',
  'standings.mjs', 'fantasy-scoring.mjs', 'fantasy-players.json', 'player-values.mjs', 'market-prices.mjs', 'contract-updates.mjs', 'player-contracts.json', 'dist/player-value.html', 'dist/player-value.css', 'dist/player-value.js', 'dist/value-rules.js', 'dist/fantasy.html', 'dist/fantasy.css', 'dist/fantasy.js', 'dist/fantasy-rules.js',
  'dist/index.html', 'dist/styles.css', 'dist/app.js', 'dist/game.js', 'dist/icon.svg'];
const absent = required.filter(name => !existsSync(join(appDirectory, name)));
check(absent.length === 0, absent.length ? `Required app files missing: ${absent.join(', ')}` : 'Required app files are present.');

const logoDirectory = join(appDirectory, 'dist/logos');
const logoCount = existsSync(logoDirectory)
  ? readdirSync(logoDirectory).filter(name => /^[A-Z]{3}\.svg$/.test(name)).length : 0;
check(logoCount === 32, 'All 32 local team logos are present.');

const scripts = required.filter(name => /\.(?:mjs|js)$/.test(name) && existsSync(join(appDirectory, name)));
const invalidScripts = scripts.filter(name => spawnSync(process.execPath,
  ['--check', join(appDirectory, name)], { stdio: 'ignore' }).status !== 0);
check(invalidScripts.length === 0, invalidScripts.length
  ? `JavaScript syntax errors: ${invalidScripts.join(', ')}` : 'App JavaScript syntax is valid.');

const playerPort = Number(process.env.PLAYOFF_PICK_PORT ?? 8765);
const adminPort = Number(process.env.PLAYOFF_PICK_ADMIN_PORT ?? 8766);
const validPort = value => Number.isInteger(value) && value >= 1 && value <= 65535;
check(validPort(playerPort) && validPort(adminPort) && playerPort !== adminPort,
  'Player and local admin use different valid ports.');

const rawOrigin = process.env.PLAYOFF_PICK_PUBLIC_ORIGIN;
const proxy = process.env.PLAYOFF_PICK_PROXY ?? 'caddy';
check(['caddy', 'cloudflare-tunnel'].includes(proxy), 'Proxy mode is caddy or cloudflare-tunnel.');
if (production || rawOrigin) {
  let validOrigin = false;
  try {
    const origin = new URL(rawOrigin);
    validOrigin = origin.protocol === 'https:' && rawOrigin === origin.origin
      && !origin.username && !origin.password && !isIP(origin.hostname)
      && origin.hostname.includes('.') && !/(?:^|\.)(?:localhost|local|internal)$/.test(origin.hostname)
      && !origin.hostname.endsWith('.home.arpa') && !origin.port;
  } catch { /* Report an invalid origin without echoing its value. */ }
  check(validOrigin, 'Production origin is one HTTPS domain on standard port 443, without a path or credentials.');
}

if (production) {
  const dataDirectory = process.env.PLAYOFF_PICK_DATA_DIR;
  check(Boolean(dataDirectory && isAbsolute(dataDirectory)
    && resolve(dataDirectory) !== appDirectory && !resolve(dataDirectory).startsWith(`${appDirectory}/`)),
  'Production data directory is explicit, absolute, and outside the code directory.');
  if (dataDirectory && existsSync(dataDirectory)) {
    const dataStat = statSync(dataDirectory);
    check(dataStat.isDirectory() && (dataStat.mode & 0o077) === 0,
      'Production data directory has no group or other-user permissions.');
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      check(dataStat.uid === process.getuid(), 'The running service account owns the data directory.');
    }
  }
  check(playerPort === 8765 && adminPort === 8766,
    'Ports match the supplied tunnel and systemd deployment templates.');
  check(process.env.PLAYOFF_PICK_FETCH_STANDINGS !== '0', 'Scheduled NHL standings updates are enabled.');
}

if (failed) process.exitCode = 1;
else console.log('Preflight passed. Public DNS, TLS, firewall, and live signup still need checks on the hosting laptop.');
