import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdateMonitor, safeReason } from '../update-monitor.mjs';

const TOKEN = '123456789:ExampleSecretTokenForTelegram123456789';
const CONFIG = { enabled:true, botToken:TOKEN, chatId:'123456789' };
function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'update-monitor-'));
  let time = Date.parse('2026-11-17T10:00:00Z');
  const messages = [], lines = [];
  const monitor = createUpdateMonitor({ directory, now:() => time, writeLine:line => lines.push(JSON.parse(line)),
    fetchImpl:async (url, options) => { messages.push({ url, ...JSON.parse(options.body) }); return Response.json({ ok:true, result:{} }); }, ...options });
  t.after(async () => { await monitor.close(); rmSync(directory, { recursive:true, force:true }); });
  return { monitor, directory, messages, lines, advance:ms => { time += ms; } };
}

test('failure reasons include HTTP errors and nested network codes while redacting credentials', () => {
  const error = new Error(`fetch failed https://user:pass@example.com/feed?token=private ${TOKEN}`, { cause:Object.assign(new Error('DNS lookup failed'), { code:'ENOTFOUND' }) });
  const reason = safeReason(error, [TOKEN]);
  assert.match(reason, /example.com\/feed.*DNS lookup failed \[ENOTFOUND\]/);
  for (const secret of [TOKEN,'user:pass','token=private']) assert.ok(!reason.includes(secret));
  error.cause = error;
  assert.ok(safeReason(error).length <= 1200);
});

test('logs failures without configuration, then alerts on setup, deduplicates, and reports recovery', async t => {
  const { monitor, messages, directory, advance } = setup(t);
  monitor.fail('fantasy', new Error('NHL HTTP 503'), { lastSuccessAt:'2026-11-16T10:00:00Z' });
  assert.equal(messages.length, 0);
  monitor.saveSettings(CONFIG);
  await monitor.flush();
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /Fantasy scores[\s\S]*NHL HTTP 503[\s\S]*2026-11-16/);
  monitor.fail('fantasy', new Error('NHL HTTP 503'));
  await monitor.flush();
  assert.equal(messages.length, 1);
  advance(6 * 60 * 60 * 1000);
  monitor.fail('fantasy', new Error('Still HTTP 503'));
  await monitor.flush();
  assert.equal(messages.length, 2);
  monitor.success('fantasy');
  await monitor.flush();
  assert.equal(messages.length, 3);
  assert.match(messages[2].text, /update recovered/);
  const logs = readFileSync(join(directory,'update-events.jsonl'),'utf8');
  assert.match(logs, /update.failed/); assert.match(logs, /update.recovered/);
  assert.ok(!logs.includes(TOKEN));
  assert.ok(!JSON.stringify(monitor.status()).includes(TOKEN));
  if (process.platform !== 'win32') assert.equal(statSync(join(directory,'telegram-alerts.json')).mode & 0o777, 0o600);
});

test('a failed Telegram delivery retries with backoff and survives a restart', async t => {
  let tries = 0;
  const fetchImpl = async () => {
    tries++;
    return tries === 1 ? Response.json({ ok:false, description:'Too Many Requests', parameters:{ retry_after:120 } }, { status:429 }) : Response.json({ ok:true, result:{} });
  };
  const context = setup(t, { fetchImpl });
  context.monitor.saveSettings(CONFIG);
  context.monitor.fail('roster', new Error('NHL roster source unavailable (HTTP 403)'));
  await context.monitor.flush();
  assert.equal(tries, 1);
  assert.match(context.monitor.status().telegram.deliveryError, /HTTP 429/);
  await context.monitor.close();
  let now = Date.parse('2026-11-17T10:01:00Z');
  const restored = createUpdateMonitor({ directory:context.directory, now:() => now, fetchImpl, writeLine:() => {} });
  t.after(() => restored.close());
  await restored.flush(); assert.equal(tries, 1);
  now += 60_000;
  await restored.flush(); assert.equal(tries, 2);
  assert.equal(restored.status().telegram.deliveryError, null);
  assert.equal(restored.status().jobs.roster.pending, null);
  restored.fail('roster', new Error('Still blocked'));
  await restored.flush(); assert.equal(tries, 2, 'restart preserves deduplication');
});

test('a feed that recovers before Telegram works does not send an obsolete failure', async t => {
  const context = setup(t, { fetchImpl:async () => { throw Error(`offline ${TOKEN}`); } });
  context.monitor.saveSettings(CONFIG);
  context.monitor.fail('fantasy', new Error('NHL HTTP 500'));
  await context.monitor.flush();
  context.monitor.success('fantasy');
  assert.equal(context.monitor.status().jobs.fantasy.pending, null);
  assert.ok(!JSON.stringify(context.monitor.status()).includes(TOKEN));
});

test('recovery during an in-flight alert queues a matching recovery message', async t => {
  let finish;
  const context = setup(t, { fetchImpl:() => new Promise(resolve => { finish = resolve; }) });
  context.monitor.saveSettings(CONFIG);
  context.monitor.fail('standings', new Error('HTTP 502'));
  context.monitor.success('standings');
  finish(Response.json({ ok:true, result:{} }));
  await context.monitor.flush();
  assert.equal(context.monitor.status().jobs.standings.pending.type, 'recovery');
});

test('missed or stuck daily updates alert after the grace period, ignoring disabled feeds', async t => {
  const { monitor, advance, messages } = setup(t);
  monitor.saveSettings(CONFIG);
  const sources = [ { job:'fantasy', enabled:true, fetchedAt:'2026-11-16T10:00:00Z', running:true }, { job:'roster', enabled:false } ];
  monitor.check(sources);
  assert.equal(messages.length, 0);
  advance(30 * 60_000);
  monitor.check(sources);
  await monitor.flush();
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /still running/);
  assert.equal(monitor.status().jobs.fantasy.incident.stage, 'watchdog');
  assert.equal(monitor.status().jobs.roster, undefined);
});

test('bounded logs rotate, and invalid saved state cannot break subsequent monitoring', async t => {
  const { monitor, directory } = setup(t, { maxLogBytes:200 });
  for (let i = 0; i < 12; i++) monitor.fail('fantasy', new Error('Fixture HTTP 503'));
  const files = readdirSync(directory).filter(name => name.startsWith('update-events'));
  assert.equal(files.length, 3);
  await monitor.close();
  writeFileSync(join(directory,'update-status.json'), '{"jobs":{"fantasy":null},"recent":[]}');
  const restored = createUpdateMonitor({ directory, writeLine:() => {} });
  t.after(() => restored.close());
  restored.fail('fantasy', new Error('Still unavailable'));
  assert.match(restored.status().jobs.fantasy.incident.reason, /Still unavailable/);
});

test('settings preserve the saved token, validate destinations, and can disable alerts', async t => {
  const { monitor, messages } = setup(t);
  monitor.saveSettings(CONFIG);
  monitor.saveSettings({ enabled:false, botToken:'', chatId:CONFIG.chatId });
  assert.equal(monitor.status().telegram.tokenSaved, true);
  monitor.fail('fantasy', new Error('HTTP 500'));
  await monitor.flush(); assert.equal(messages.length, 0);
  for (const body of [{ ...CONFIG, chatId:'https://example.com' }, { ...CONFIG, botToken:'bad' }, { ...CONFIG, endpoint:'https://example.com' }]) assert.throws(() => monitor.saveSettings(body));
  monitor.saveSettings({ enabled:true, botToken:'', chatId:CONFIG.chatId });
  await monitor.flush(); assert.equal(messages.length, 1);
});

test('chat discovery uses only Telegram and never echoes a bot token', async t => {
  const calls = [];
  const { monitor } = setup(t, { fetchImpl:async (url, options) => {
    calls.push({ url, body:JSON.parse(options.body) });
    return Response.json({ ok:true, result:[ { message:{ chat:{ id:12345, type:'private', first_name:'Host' } } }, { message:{ chat:{ id:12345, type:'private', first_name:'Host' } } } ] });
  } });
  const chats = await monitor.findChats({ botToken:TOKEN });
  assert.deepEqual(chats, [{ id:'12345', name:'Host' }]);
  assert.match(calls[0].url, /^https:\/\/api.telegram.org\/bot[^/]+\/getUpdates$/);
  assert.equal(Object.hasOwn(calls[0].body, 'offset'), false, 'discovery must not consume pending updates');
  assert.ok(!JSON.stringify(monitor.status()).includes(TOKEN));
});

test('Telegram test messages report rejection reasons and never leak tokens', async t => {
  const { monitor } = setup(t, { fetchImpl:async () => Response.json({ ok:false, description:`Forbidden ${TOKEN}` }, { status:403 }) });
  monitor.saveSettings(CONFIG);
  await assert.rejects(monitor.test(), error => error.status === 502 && error.message.includes('Forbidden') && !error.message.includes(TOKEN));
});
