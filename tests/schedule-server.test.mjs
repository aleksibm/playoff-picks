import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { previousDailyUpdate } from '../schedule.mjs';
import { TEAMS } from '../dist/game.js';

const NOON = '2026-10-10T09:00:00.000Z';
const NEXT_NOON = '2026-10-11T09:00:00.000Z';
const picks = ['Atlantic', 'Metropolitan', 'Central', 'Pacific']
  .flatMap(division => TEAMS.filter(team => team.division === division).slice(0, 4).map(team => team.id));

function snapshot(fetchedAt, extraWins = 0) {
  return {
    season: 20262027, asOf: '2026-10-10', fetchedAt,
    teams: Object.fromEntries(TEAMS.map((team, index) => [team.id, {
      points: (index + 1 + extraWins) * 2, wins: index + 1 + extraWins,
      otLosses: 0, gamesPlayed: index + 3 + extraWins,
    }])),
  };
}

function fakeClock(initial) {
  let time = Date.parse(initial);
  const timers = new Set();
  const cleared = [];
  return {
    now: () => time,
    setTimer(callback, delay) {
      const timer = { callback, due: time + delay, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) { timers.delete(timer); cleared.push(timer); },
    timers,
    cleared,
    async advanceTo(target) {
      time = Date.parse(target);
      const due = [...timers].filter(timer => timer.due <= time).sort((a, b) => a.due - b.due);
      for (const timer of due) {
        if (!timers.delete(timer)) continue;
        await timer.callback();
      }
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

function request(url, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(new URL(path, url), { method, headers, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode,
        headers: response.headers, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    outgoing.on('error', reject);
    outgoing.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function setup(t, { initial, cached, provider, enabled = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'playoff-daily-update-'));
  const cachePath = join(directory, 'standings.json');
  if (cached) writeFileSync(cachePath, JSON.stringify(cached));
  const clock = fakeClock(initial);
  const app = createApp({ dbPath: join(directory, 'accounts.sqlite'), standingsCachePath: cachePath,
    allowStandingsFetch: enabled, ...(provider ? { standingsProvider: provider } : {}),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  await new Promise(resolve => setImmediate(resolve));
  const playerUrl = `http://127.0.0.1:${app.server.address().port}`;
  const adminUrl = new URL(await app.startAdmin(0)).origin;
  return { app, clock, playerUrl, adminUrl, cachePath };
}

const overview = async context => (await request(context.adminUrl, '/api/admin/overview')).data;

test('a verified cache from this local noon skips a startup fetch and stays fresh after thirty minutes', async t => {
  let calls = 0;
  const context = await setup(t, { initial: '2026-10-10T10:00:00.000Z', cached: snapshot(NOON),
    provider: async () => { calls += 1; return snapshot(NOON); } });
  assert.equal(calls, 0);
  const data = await overview(context);
  assert.equal(data.scoring.available, true);
  assert.equal(data.scoring.stale, false);
  assert.deepEqual(data.server.updateSchedule, { time: '12:00', timeZone: 'Europe/Helsinki', nextUpdate: NEXT_NOON });
  assert.equal(Object.hasOwn(data.server, 'refreshIntervalMinutes'), false);
  assert.equal(context.clock.timers.size, 1);
  assert.equal([...context.clock.timers][0].due, Date.parse(NEXT_NOON));
});

test('missing standings are fetched once at startup before noon, with the next update at noon', async t => {
  let calls = 0;
  const initial = '2026-10-10T08:00:00.000Z';
  const context = await setup(t, { initial,
    provider: async () => { calls += 1; return snapshot(initial); } });
  assert.equal(calls, 1);
  const data = await overview(context);
  assert.equal(data.scoring.available, true);
  assert.equal(data.scoring.stale, false);
  assert.equal(data.server.updateSchedule.nextUpdate, NOON);
  assert.equal(JSON.parse(readFileSync(context.cachePath, 'utf8')).fetchedAt, initial);
});

test('starting after a missed noon catches up once and schedules the next day', async t => {
  let calls = 0;
  const initial = '2026-10-10T09:30:00.000Z';
  const cached = snapshot(new Date(previousDailyUpdate(Date.parse(initial)) - 1).toISOString());
  const context = await setup(t, { initial, cached,
    provider: async () => { calls += 1; return snapshot(initial, 1); } });
  assert.equal(calls, 1);
  const data = await overview(context);
  assert.equal(data.scoring.fetchedAt, initial);
  assert.equal(data.scoring.stale, false);
  assert.equal(data.server.updateSchedule.nextUpdate, NEXT_NOON);
  await context.clock.advanceTo('2026-10-10T10:00:00.000Z');
  assert.equal(calls, 1);
});

test('the scheduled local noon update changes leaderboard points without changing the locked prediction', async t => {
  let calls = 0;
  let clock;
  const context = await setup(t, { initial: '2026-10-10T08:59:00.000Z',
    cached: snapshot('2026-10-09T09:00:00.000Z'),
    provider: async () => { calls += 1; return snapshot(new Date(clock.now()).toISOString(), 1); } });
  clock = context.clock;
  assert.equal(calls, 0);
  const registration = await request(context.playerUrl, '/api/register', { method: 'POST',
    body: { username: 'DailyNoonFan', password: 'Daily-Noon-Test-Password' },
    headers: { Origin: context.playerUrl, 'Content-Type': 'application/json' } });
  assert.equal(registration.status, 200);
  const submitted = await request(context.playerUrl, '/api/prediction/submit', { method: 'POST',
    body: { teamIds: picks, revision: 0 }, headers: { Origin: context.playerUrl,
      'Content-Type': 'application/json', 'X-CSRF-Token': registration.data.csrfToken,
      Cookie: registration.headers['set-cookie'][0].split(';')[0] } });
  assert.equal(submitted.status, 200);
  const before = await overview(context);
  await clock.advanceTo(NOON);
  assert.equal(calls, 1);
  const after = await overview(context);
  assert.equal(after.leaderboard[0].points, before.leaderboard[0].points + picks.length * 2);
  assert.deepEqual(after.accounts[0].prediction, submitted.data.prediction);
  assert.equal(after.scoring.fetchedAt, NOON);
  assert.equal(after.scoring.stale, false);
  assert.equal(after.server.updateSchedule.nextUpdate, NEXT_NOON);
});

test('a missed daily update becomes stale after its five-minute grace period, retaining verified scores', async t => {
  let calls = 0;
  const cached = snapshot('2026-10-09T09:00:00.000Z');
  const context = await setup(t, { initial: '2026-10-10T08:59:00.000Z', cached,
    provider: async () => { calls += 1; throw new Error('Fixture feed is unavailable'); } });
  assert.equal((await overview(context)).scoring.stale, false);
  await context.clock.advanceTo('2026-10-10T09:04:59.999Z');
  assert.equal(calls, 1);
  const withinGrace = await overview(context);
  assert.equal(withinGrace.scoring.stale, false);
  assert.match(withinGrace.scoring.error, /last verified/);
  await context.clock.advanceTo('2026-10-10T09:05:00.000Z');
  const overdue = await overview(context);
  assert.equal(overdue.scoring.stale, true);
  assert.deepEqual(overdue.teams, cached.teams);
  assert.equal(overdue.server.updateSchedule.nextUpdate, NEXT_NOON);
  assert.equal(calls, 1);
});

test('manual refresh updates points while leaving the next noon schedule unchanged', async t => {
  let calls = 0;
  const initial = '2026-10-10T10:00:00.000Z';
  const context = await setup(t, { initial, cached: snapshot(NOON),
    provider: async () => { calls += 1; return snapshot(initial, 1); } });
  const before = await overview(context);
  const refreshed = await request(context.adminUrl, '/api/admin/standings/refresh', { method: 'POST', body: {},
    headers: { Origin: context.adminUrl, 'Content-Type': 'application/json', 'X-CSRF-Token': before.csrfToken } });
  assert.equal(refreshed.status, 200);
  assert.equal(calls, 1);
  assert.equal(refreshed.data.scoring.fetchedAt, initial);
  assert.deepEqual(refreshed.data.server.updateSchedule, before.server.updateSchedule);
  assert.equal(context.clock.timers.size, 1);
  assert.equal([...context.clock.timers][0].due, Date.parse(NEXT_NOON));
});

test('disabled feed updates never create a noon timer or next-update promise', async t => {
  const context = await setup(t, { initial: '2026-10-10T10:00:00.000Z', cached: snapshot(NOON), enabled: false });
  const data = await overview(context);
  assert.equal(data.server.canRefresh, false);
  assert.deepEqual(data.server.updateSchedule, { time: '12:00', timeZone: 'Europe/Helsinki', nextUpdate: null });
  assert.equal(data.scoring.available, true);
  assert.equal(data.scoring.stale, false);
  assert.equal(context.clock.timers.size, 0);
  await context.clock.advanceTo(NEXT_NOON);
  assert.equal(context.clock.timers.size, 0);
});

test('closing the backend clears the scheduled noon timer and prevents subsequent fetching', async t => {
  let calls = 0;
  const context = await setup(t, { initial: '2026-10-10T10:00:00.000Z', cached: snapshot(NOON),
    provider: async () => { calls += 1; return snapshot(NEXT_NOON, 1); } });
  assert.equal(context.clock.timers.size, 1);
  await context.app.close();
  assert.equal(context.clock.timers.size, 0);
  assert.equal(context.clock.cleared.length, 1);
  await context.clock.advanceTo(NEXT_NOON);
  assert.equal(calls, 0);
});
