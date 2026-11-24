import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';

const TOKEN = '123456789:ExampleSecretTokenForTelegram123456789';
async function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(),'admin-notifications-'));
  const messages = [];
  const app = createApp({ dbPath:join(directory,'accounts.sqlite'), allowStandingsFetch:false, updateLog:() => {},
    telegramFetch:async (url, request) => {
      messages.push({ url, ...JSON.parse(request.body) });
      return Response.json({ ok:true, result:{} });
    }, ...options });
  t.after(async () => { await app.close(); rmSync(directory, { recursive:true, force:true }); });
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  const player = `http://127.0.0.1:${app.server.address().port}`;
  const admin = new URL(await app.startAdmin(0)).origin;
  const overview = await (await fetch(`${admin}/api/admin/overview`)).json();
  const send = async (action, body, headers = {}) => fetch(`${admin}/api/admin/notifications/${action}`, {
    method:'POST', headers:{ Origin:admin, 'Content-Type':'application/json', 'X-CSRF-Token':overview.csrfToken, ...headers }, body:JSON.stringify(body),
  });
  return { app, directory, messages, player, admin, send };
}

test('Telegram setup and tests work through local admin, remain private, and survive restart', async t => {
  const { send, messages, directory, app, admin, player } = await setup(t);
  const saved = await send('settings', { enabled:true, botToken:TOKEN, chatId:'123456789' });
  assert.equal(saved.status, 200);
  const data = await saved.json();
  assert.equal(data.server.updates.telegram.enabled, true);
  assert.equal(data.server.updates.telegram.tokenSaved, true);
  assert.ok(!JSON.stringify(data).includes(TOKEN));
  assert.equal((await send('test', {})).status, 200);
  assert.match(messages[0].text, /test notification/);
  assert.equal(JSON.parse(readFileSync(join(directory,'telegram-alerts.json'),'utf8')).botToken, TOKEN);
  for (const path of ['/api/admin/notifications/settings','/api/admin/notifications/test','/api/admin/notifications/chats','/telegram-alerts.json','/update-status.json','/update-events.jsonl']) assert.equal((await fetch(`${player}${path}`)).status,404);
  for (const path of ['/telegram-alerts.json','/update-status.json','/update-events.jsonl']) assert.equal((await fetch(`${admin}${path}`)).status,404);
  await app.close();
  const restored = createApp({ dbPath:join(directory,'accounts.sqlite'), allowStandingsFetch:false, updateLog:() => {} });
  t.after(() => restored.close());
  const restoredAdmin = await restored.startAdmin(0);
  const again = await (await fetch(`${restoredAdmin}api/admin/overview`)).json();
  assert.equal(again.server.updates.telegram.enabled, true);
  assert.ok(!JSON.stringify(again).includes(TOKEN));
  await restored.close();
});

test('notification writes require local Origin, CSRF, bounded JSON, and an allowed action', async t => {
  const { send, admin } = await setup(t);
  const body = { enabled:true, botToken:TOKEN, chatId:'123456789' };
  for (const action of ['settings','test','chats']) {
    for (const headers of [{ Origin:'' }, { Origin:'https://attacker.example' }, { 'X-CSRF-Token':'' }, { 'X-Forwarded-For':'127.0.0.1' }]) assert.equal((await send(action,body,headers)).status,403);
    assert.equal((await fetch(`${admin}/api/admin/notifications/${action}`)).status,405);
  }
  assert.equal((await send('settings',{ ...body, chatId:'https://attacker.example' })).status,400);
  assert.equal((await send('settings',{ ...body, extra:'x'.repeat(4096) })).status,413);
  assert.equal((await send('settings',body,{ 'Content-Type':'text/plain' })).status,415);
  assert.equal((await send('test',{ url:'https://attacker.example' })).status,400);
  assert.equal((await send('test',{})).status,409);
});

test('a real refresh failure records its root cause privately while public errors remain generic', async t => {
  let broken = false;
  const now = Date.parse('2026-11-17T11:00:00Z');
  const { app, admin, player, send, messages } = await setup(t, { now:() => now,
    fantasyProvider:async () => {
      if (broken) throw new Error('NHL request failed', { cause:Object.assign(new Error('upstream timeout'), { code:'ETIMEDOUT' }) });
      return { season:'20262027', fetchedAt:new Date(now).toISOString(), games:[], modelError:null };
    },
  });
  await app.refreshFantasy();
  await send('settings',{ enabled:true, botToken:TOKEN, chatId:'123456789' });
  broken = true;
  const result = await app.refreshFantasy();
  assert.equal(result.available, true);
  await new Promise(resolve => setImmediate(resolve));
  const overview = await (await fetch(`${admin}/api/admin/overview`)).json();
  assert.match(overview.server.updates.jobs.fantasy.incident.reason, /ETIMEDOUT/);
  assert.ok(messages.some(message => /ETIMEDOUT/.test(message.text)));
  const publicData = await (await fetch(`${player}/api/fantasy/players`)).json();
  assert.ok(!JSON.stringify(publicData).includes('ETIMEDOUT'));
  assert.ok(!JSON.stringify(publicData).includes(TOKEN));
  broken = false;
  await app.refreshFantasy();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(messages.some(message => /update recovered/.test(message.text)));
});
