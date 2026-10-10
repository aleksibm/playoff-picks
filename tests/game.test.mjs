import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TEAMS, DIVISIONS, SEASON, sanitizePicks, getProgress,
  togglePick, createPickSheet, encodePicks, decodePicks,
} from '../dist/game.js';

const teamsIn = division => TEAMS.filter(team => team.division === division).map(team => team.id);
const prediction = (atlantic, metropolitan, central, pacific) => [
  ...teamsIn('Atlantic').slice(0, atlantic),
  ...teamsIn('Metropolitan').slice(0, metropolitan),
  ...teamsIn('Central').slice(0, central),
  ...teamsIn('Pacific').slice(0, pacific),
];

test('all 32 teams have unique IDs and fit the four NHL divisions', () => {
  assert.equal(SEASON, '2026–27');
  assert.equal(TEAMS.length, 32);
  assert.equal(new Set(TEAMS.map(team => team.id)).size, 32);
  assert.equal(DIVISIONS.length, 4);
  for (const division of DIVISIONS) {
    const members = TEAMS.filter(team => team.division === division.id);
    assert.equal(members.length, 8);
    for (const team of members) {
      assert.equal(team.conference, division.conference);
      assert.match(team.color, /^#[a-fA-F0-9]{6}$/);
      assert.ok(team.city && team.name);
    }
  }
  assert.equal(TEAMS.find(team => team.id === 'UTA').name, 'Mammoth');
  assert.ok(!TEAMS.some(team => team.id === 'ARI'));
});

test('empty and corrupt saved values recover to an empty draft', () => {
  for (const value of [undefined, null, 1, 'BOS', {}, { picks: ['BOS'] }]) {
    assert.deepEqual(sanitizePicks(value), []);
    assert.equal(getProgress(value).complete, false);
  }
  assert.deepEqual(getProgress([]), {
    total: 0, east: 0, west: 0,
    divisions: { Atlantic: 0, Metropolitan: 0, Central: 0, Pacific: 0 },
    complete: false,
  });
});

test('recover saved IDs, remove duplicates and retain the first valid order', () => {
  const input = ['BOS', null, 'NOPE', 'CAR', 'BOS', {}, 'NYR', 'bos', 'UTA'];
  const untouched = [...input];
  assert.deepEqual(sanitizePicks(input), ['BOS', 'CAR', 'NYR', 'UTA']);
  assert.deepEqual(input, untouched);
});

test('sanitizing overcounts keeps five in a division and eight in a conference', () => {
  const input = [...teamsIn('Atlantic'), ...teamsIn('Metropolitan'), ...teamsIn('Central'), ...teamsIn('Pacific')];
  const cleaned = sanitizePicks(input);
  assert.deepEqual(cleaned, prediction(5, 3, 5, 3));
  assert.equal(getProgress(cleaned).complete, true);
});

test('every 3+5, 4+4 and 5+3 wildcard allocation completes correctly', () => {
  for (const eastFirst of [3, 4, 5]) {
    for (const westFirst of [3, 4, 5]) {
      const picks = prediction(eastFirst, 8 - eastFirst, westFirst, 8 - westFirst);
      const progress = getProgress(picks);
      assert.equal(progress.total, 16);
      assert.equal(progress.east, 8);
      assert.equal(progress.west, 8);
      assert.equal(progress.complete, true);
      assert.equal(progress.divisions.Atlantic, eastFirst);
      assert.equal(progress.divisions.Central, westFirst);
    }
  }
  assert.equal(getProgress(prediction(4, 4, 4, 3)).complete, false);
  assert.equal(getProgress(prediction(5, 2, 5, 2)).complete, false);
});

test('a sixth division pick is rejected with the existing draft preserved', () => {
  const picks = teamsIn('Atlantic').slice(0, 5);
  const result = togglePick(picks, teamsIn('Atlantic')[5]);
  assert.deepEqual(result.picks, picks);
  assert.match(result.error, /5 teams.*Atlantic/);
  assert.notEqual(result.picks, picks);
});

test('a ninth conference pick is rejected without blocking the other conference', () => {
  const picks = prediction(4, 4, 0, 0);
  const rejected = togglePick(picks, teamsIn('Atlantic')[4]);
  assert.deepEqual(rejected.picks, picks);
  assert.match(rejected.error, /Eastern Conference is full/);
  const accepted = togglePick(picks, 'UTA');
  assert.equal(accepted.error, null);
  assert.deepEqual(accepted.picks, [...picks, 'UTA']);
});

test('selected teams can always be removed, then replaced', () => {
  const picks = prediction(5, 3, 5, 3);
  const removed = togglePick(picks, 'BOS');
  assert.equal(removed.error, null);
  assert.equal(removed.picks.length, 15);
  assert.ok(!removed.picks.includes('BOS'));
  assert.equal(getProgress(removed.picks).complete, false);
  const replacement = togglePick(removed.picks, 'OTT');
  assert.equal(replacement.error, null);
  assert.equal(getProgress(replacement.picks).complete, true);
  assert.equal(picks.length, 16);
  assert.ok(picks.includes('BOS'));
});

test('unknown teams cannot be inserted and corrupt drafts are sanitized', () => {
  assert.deepEqual(togglePick(['BOS', 'BOS', 'FAKE'], 'CAR'), { picks: ['BOS', 'CAR'], error: null });
  const unknown = togglePick(['BOS'], '__proto__');
  assert.deepEqual(unknown.picks, ['BOS']);
  assert.equal(typeof unknown.error, 'string');
});

test('sharing uses a deterministic encoding and preserves complete predictions', () => {
  const picks = prediction(3, 5, 4, 4);
  const encoded = encodePicks(picks);
  assert.equal(encoded, encodePicks([...picks].reverse()));
  assert.deepEqual(decodePicks(encoded), [...picks].sort());
  assert.equal(getProgress(decodePicks(encoded)).complete, true);
  assert.equal(encodePicks([]), '');
  assert.deepEqual(decodePicks(''), []);
  assert.deepEqual(decodePicks('UTA.BOS'), ['UTA', 'BOS']);
});

test('malformed shared predictions fail wholly rather than changing picks', () => {
  const malformed = [undefined, null, {}, [], 42, 'BOS.BOS', 'BOS.FOO', 'bos.CAR',
    ' BOS', 'BOS ', '.BOS', 'BOS.', 'BOS..CAR', 'BOS,CAR', 'BOS%2ECAR',
    '<script>', '__proto__', 'BOS\n', teamsIn('Atlantic').slice(0, 6).join('.'),
    prediction(5, 4, 0, 0).join('.'), TEAMS.map(team => team.id).join('.')];
  for (const encoded of malformed) assert.equal(decodePicks(encoded), null, String(encoded));
});

test('copyable pick sheets use full team names grouped by conference and division', () => {
  const picks = ['NYR', 'BOS', 'UTA', 'LAK'];
  const sheet = createPickSheet(picks);
  assert.match(sheet, /PLAYOFF PICKS · 2026–27/);
  assert.match(sheet, /4\/16 teams picked · Draft prediction/);
  assert.match(sheet, /Eastern Conference \(2\/8\)/);
  assert.match(sheet, /Atlantic Division\n  • Boston Bruins/);
  assert.match(sheet, /Metropolitan Division\n  • New York Rangers/);
  assert.match(sheet, /Central Division\n  • Utah Mammoth/);
  assert.match(sheet, /Pacific Division\n  • Los Angeles Kings/);
  assert.match(createPickSheet(prediction(4, 4, 4, 4)), /Complete prediction/);
  assert.match(createPickSheet([]), /No teams picked yet/);
  assert.equal(sheet, createPickSheet([...picks].reverse()));
});
