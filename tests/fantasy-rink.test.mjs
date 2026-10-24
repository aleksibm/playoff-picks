import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderTeamRink } from '../dist/fantasy-rink.js';

const player = (id, position, name = `Player ${id}`) => ({ id, position, name, team: 'NHL', price: 100_000 });
const names = html => [...html.matchAll(/<strong>(.*?)<\/strong>/g)].map(match => match[1]);

test('read-only rink places shuffled players by primary NHL position in the 3-2-1 formation', () => {
  const html = renderTeamRink([player(1, 'G', 'Goalie'), player(2, 'D', 'Defense 1'), player(3, 'RW', 'Right wing'), player(4, 'C', 'Centre'), player(5, 'D', 'Defense 2'), player(6, 'LW', 'Left wing')]);
  assert.deepEqual(names(html), ['Left wing', 'Centre', 'Right wing', 'Defense 1', 'Defense 2', 'Goalie']);
  assert.equal((html.match(/class="roster-slot"/g) ?? []).length, 6);
  assert.equal((html.match(/data-games=/g) ?? []).length, 6);
  assert.doesNotMatch(html, /data-replace=|data-remove=|\sid=/);
});

test('duplicate forward positions fill the remaining attacking spots and missing roles stay empty', () => {
  const html = renderTeamRink([player(1, 'C', 'Centre 1'), player(2, 'C', 'Centre 2'), player(3, 'C', 'Centre 3'), player(4, 'D', 'Defense')]);
  assert.deepEqual(names(html), ['Centre 2', 'Centre 1', 'Centre 3', 'Defense', 'No defenseman selected', 'No goalie selected']);
  assert.equal((html.match(/data-games=/g) ?? []).length, 4);
  assert.equal(names(renderTeamRink(undefined)).length, 6);
});

test('rink renderer escapes names and team text and only emits safe player IDs', () => {
  const html = renderTeamRink([{ ...player(1, 'C'), name: '<img src=x onerror="attack()">', team: '<script>attack()</script>' }, { ...player('" onclick="attack()', 'D'), name: "O'Brien & Co" }]);
  assert.doesNotMatch(html, /<img|<script|onclick=/);
  assert.match(html, /&lt;img src=x onerror=&quot;attack\(\)&quot;&gt;/);
  assert.match(html, /&lt;script&gt;attack\(\)&lt;\/script&gt;/);
  assert.match(html, /O&#39;Brien &amp; Co/);
  assert.equal((html.match(/data-games=/g) ?? []).length, 1);
});

test('main and read-only rinks use the same scene wrapper and preserve SVG proportions', async () => {
  const html = await readFile(new URL('../dist/fantasy.html', import.meta.url), 'utf8');
  const rendered = renderTeamRink([]);
  for (const scene of [html, rendered]) {
    assert.match(scene, /class="rink-scene"><svg class="half-rink-lines" viewBox="0 0 400 360" preserveAspectRatio="xMidYMid meet"/);
    assert.doesNotMatch(scene, /preserveAspectRatio="none"/);
  }
  assert.match(html, /id="roster-slots" class="roster-slots"/);
});
