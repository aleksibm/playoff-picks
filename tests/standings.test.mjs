import test from 'node:test';
import assert from 'node:assert/strict';
import { TEAMS } from '../dist/game.js';
import {
  TARGET_SEASON, parseStandings, scorePrediction, rankEntries, fetchStandings,
} from '../standings.mjs';

// Deliberately synthetic records for parser/scoring tests, never displayed as
// live standings or seeded into the account database.
function validPayload() {
  return {
    wildCardIndicator: true,
    standings: TEAMS.map(team => ({
      teamAbbrev: { default: team.id },
      seasonId: TARGET_SEASON,
      gameTypeId: 2,
      date: '2026-10-09',
      gamesPlayed: 4,
      wins: 1,
      losses: 2,
      otLosses: 1,
      points: 3,
    })),
  };
}

function setRecord(data, id, wins, losses, otLosses) {
  const row = data.standings.find(team => team.teamAbbrev.default === id);
  Object.assign(row, { wins, losses, otLosses, gamesPlayed: wins + losses + otLosses, points: 2 * wins + otLosses });
}

test('official-style regular-season JSON produces a complete checked snapshot', () => {
  const snapshot = parseStandings(validPayload());
  assert.equal(TARGET_SEASON, 20262027);
  assert.equal(snapshot.season, TARGET_SEASON);
  assert.equal(snapshot.asOf, '2026-10-09');
  assert.equal(Object.keys(snapshot.teams).length, 32);
  assert.deepEqual(snapshot.teams.BOS, { points: 3, gamesPlayed: 4, wins: 1, otLosses: 1 });
  assert.equal(new Date(snapshot.fetchedAt).toISOString(), snapshot.fetchedAt);
});

test('pool points are the sum of selected teams NHL standings points', () => {
  const data = validPayload();
  setRecord(data, 'BOS', 3, 0, 1);
  setRecord(data, 'CAR', 2, 2, 0);
  setRecord(data, 'UTA', 0, 2, 2);
  const snapshot = parseStandings(data);
  assert.equal(scorePrediction(['BOS', 'CAR', 'UTA'], snapshot), 13);
  assert.equal(scorePrediction(['CAR', 'BOS', 'UTA'], snapshot), 13);
  assert.equal(scorePrediction([], snapshot), 0);
  assert.deepEqual(snapshot.teams.BOS, { points: 7, gamesPlayed: 4, wins: 3, otLosses: 1 });
});

test('official points are preserved when an overtime point was forfeited', () => {
  const data = validPayload();
  // Rule 84.2: an OT loss with the goalie pulled can forfeit its standings point.
  data.standings[0].points = 2;
  const snapshot = parseStandings(data);
  assert.equal(snapshot.teams.BOS.otLosses, 1);
  assert.equal(snapshot.teams.BOS.points, 2);
  assert.equal(scorePrediction(['BOS'], snapshot), 2);
});

test('leaderboards assign tied competition ranks, ordered by username', () => {
  const data = validPayload();
  setRecord(data, 'BOS', 3, 0, 1);
  setRecord(data, 'CAR', 2, 2, 0);
  const snapshot = parseStandings(data);
  const entries = [
    { id: 'c', username: 'zoe', displayName: 'Zoe', teamIds: ['BOS'], submittedAt: '2026-10-07T00:00:00.000Z' },
    { id: 'b', username: 'anna', displayName: 'Anna', teamIds: ['BOS'], submittedAt: '2026-10-08T00:00:00.000Z' },
    { id: 'a', username: 'alex', displayName: 'Alex', teamIds: ['CAR'], submittedAt: '2026-10-09T00:00:00.000Z' },
  ];
  const unchanged = structuredClone(entries);
  const ranked = rankEntries(entries, snapshot);
  assert.deepEqual(ranked.map(row => [row.username, row.points, row.rank]), [
    ['anna', 7, 1], ['zoe', 7, 1], ['alex', 4, 3],
  ]);
  assert.deepEqual(entries, unchanged);
  assert.equal(ranked[0].submittedAt, entries[1].submittedAt);
});

test('all-zero official records rank everyone first without inventing an advantage', () => {
  const data = validPayload();
  for (const team of TEAMS) setRecord(data, team.id, 0, 0, 0);
  const snapshot = parseStandings(data);
  assert.deepEqual(rankEntries([
    { username: 'bob', teamIds: ['BOS'] },
    { username: 'alice', teamIds: ['UTA'] },
  ], snapshot).map(row => [row.username, row.points, row.rank]), [['alice', 0, 1], ['bob', 0, 1]]);
});

test('wrong-season and mixed-season responses cannot supply leaderboard points', () => {
  for (const season of [20252026, 20272028, '20262027', undefined]) {
    const data = validPayload();
    data.standings[0].seasonId = season;
    assert.throws(() => parseStandings(data), /2026–27 season/);
  }
  const data = validPayload();
  data.seasonId = 20252026;
  assert.throws(() => parseStandings(data), /2026–27 season/);
});

test('preseason and playoff records are rejected even when the season matches', () => {
  for (const gameTypeId of [1, 3, '2', null]) {
    const data = validPayload();
    data.standings[0].gameTypeId = gameTypeId;
    assert.throws(() => parseStandings(data), /regular-season/);
  }
  const data = validPayload();
  data.gameTypeId = 3;
  assert.throws(() => parseStandings(data), /regular-season/);
});

test('official standings rows may omit game type but must identify the exact season', () => {
  const data = validPayload();
  for (const row of data.standings) delete row.gameTypeId;
  assert.equal(parseStandings(data).season, TARGET_SEASON);
  delete data.standings[0].seasonId;
  assert.throws(() => parseStandings(data), /2026–27 season/);
});

test('incomplete, duplicate, unknown and malformed team records fail as a whole', () => {
  const incomplete = validPayload();
  incomplete.standings.pop();
  assert.throws(() => parseStandings(incomplete), /all 32/);
  const duplicate = validPayload();
  duplicate.standings[31] = structuredClone(duplicate.standings[0]);
  assert.throws(() => parseStandings(duplicate), /duplicate team/);
  const unknown = validPayload();
  unknown.standings[31].teamAbbrev.default = 'ARI';
  assert.throws(() => parseStandings(unknown), /unknown team/);
  const malformed = validPayload();
  malformed.standings[0] = null;
  assert.throws(() => parseStandings(malformed), /malformed/);
  for (const value of [null, [], {}, { standings: {} }]) {
    assert.throws(() => parseStandings(value), /all 32/);
  }
});

test('negative, non-integer and inconsistent standings points are rejected', () => {
  for (const [field, value] of [
    ['points', -1], ['points', 3.5], ['points', '3'], ['points', 4], ['points', 1],
    ['wins', -1], ['gamesPlayed', -1], ['otLosses', -1], ['losses', -1],
    ['wins', 5], ['gamesPlayed', 3], ['otLosses', NaN],
  ]) {
    const data = validPayload();
    data.standings[0][field] = value;
    assert.throws(() => parseStandings(data), /Invalid NHL standings/, `${field}=${value}`);
  }
});

test('the standings date must be valid and identical for all team rows', () => {
  for (const date of [undefined, '2026-02-30', '2026-10-09T00:00:00Z', '2026-10-08']) {
    const data = validPayload();
    data.standings[0].date = date;
    assert.throws(() => parseStandings(data), /date/);
  }
});

test('invalid predictions and stale or incomplete cached snapshots cannot score', () => {
  const snapshot = parseStandings(validPayload());
  assert.throws(() => scorePrediction(['BOS', 'BOS'], snapshot), /duplicate/);
  assert.throws(() => scorePrediction(['FAKE'], snapshot), /unknown/);
  assert.throws(() => scorePrediction('BOS', snapshot), /array/);
  assert.throws(() => scorePrediction(['BOS'], { ...snapshot, season: 20252026 }), /2026–27/);
  const incomplete = structuredClone(snapshot);
  delete incomplete.teams.UTA;
  assert.throws(() => scorePrediction(['BOS'], incomplete), /complete/);
  const corrupt = structuredClone(snapshot);
  corrupt.teams.BOS.points = 100;
  assert.throws(() => scorePrediction(['BOS'], corrupt), /points do not match/);
  assert.throws(() => rankEntries([], null), /complete/);
});

test('fetching uses the official endpoint, rejects redirects, and bounds the request', async () => {
  const snapshot = await fetchStandings(async (url, options) => {
    assert.equal(url, 'https://api-web.nhle.com/v1/standings/now');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Accept, 'application/json');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    return new Response(JSON.stringify(validPayload()), { headers: { 'Content-Type': 'application/json' } });
  });
  assert.equal(snapshot.season, TARGET_SEASON);
});

test('oversized upstream feeds are rejected before parsing, including streamed bodies', async () => {
  await assert.rejects(fetchStandings(async () => new Response('{}', {
    headers: { 'Content-Length': String(1024 * 1024 + 1) },
  })), /too large/);
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(fetchStandings(async () => new Response(body)), /too large/);
  assert.equal(cancelled, true);
});

test('upstream HTTP, JSON, season and network failures propagate without fallback scores', async () => {
  await assert.rejects(fetchStandings(async () => new Response(null, { status: 503 })), /HTTP 503/);
  await assert.rejects(fetchStandings(async () => new Response('not JSON')), SyntaxError);
  const oldSeason = validPayload();
  oldSeason.standings.forEach(row => { row.seasonId = 20252026; });
  await assert.rejects(fetchStandings(async () => new Response(JSON.stringify(oldSeason))), /2026–27/);
  const timeout = new DOMException('Request timed out', 'TimeoutError');
  await assert.rejects(fetchStandings(async () => { throw timeout; }), error => error === timeout);
});
