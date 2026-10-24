import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountStore } from '../accounts.mjs';
import { mergeRosterCatalog } from '../roster-updates.mjs';
import { previewRosters, seedPreviewAccounts, createPreviewSnapshot } from '../preview-data.mjs';
import { playerGameLogs, scoreFantasyHistory, weeklyTopPlayers } from '../fantasy-scoring.mjs';
import { validateRoster } from '../dist/fantasy-rules.js';

const base=JSON.parse(await readFile(new URL('../fantasy-players.json',import.meta.url),'utf8'));
const roster=JSON.parse(await readFile(new URL('../fantasy-roster.json',import.meta.url),'utf8'));
const catalog=mergeRosterCatalog(base,roster);
const now=Date.parse('2026-10-24T15:00:00+03:00');

test('synthetic preview games populate each ranking period and internally consistent game breakdowns',()=>{
  const teams=previewRosters(catalog);
  for(const team of teams)assert.equal(validateRoster(team.playerIds,catalog.players,true).length,6);
  assert.equal(new Set(teams.flatMap(team=>team.playerIds)).size,18);
  const snapshot=createPreviewSnapshot(catalog,{now});
  assert.deepEqual(createPreviewSnapshot(catalog,{now}),snapshot);
  assert.equal(snapshot.demo,true);
  assert.match(snapshot.source,/Synthetic/);
  for(const key of ['current','previous','month','year']){
    assert.equal(weeklyTopPlayers(catalog,snapshot,{week:key,now}).players.length,10);
  }
  for(const team of teams){
    for(const id of team.playerIds){
      const games=playerGameLogs(snapshot,id);
      assert.equal(games.length,5);
      for(const game of games){
        assert.ok(game.stats);
        assert.ok(game.breakdown.length);
        assert.ok(Math.abs(game.breakdown.reduce((sum,row)=>sum+(row.points??0),0)-game.points)<1e-7);
      }
    }
  }
  assert.equal(new Set(teams.map(team=>scoreFantasyHistory([{playerIds:team.playerIds,effectiveAt:'2026-10-01T00:00:00.000Z'}],snapshot).points)).size,3);
  assert.ok(snapshot.games.some(game=>game.pending.length));
});

test('additive demo seeding preserves an existing account, session, cash and lineup',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'fantasy-preview-test-'));
  const directory=join(temporary,'.local-data','fantasy-preview'),dbPath=join(directory,'accounts.sqlite');
  let store=createAccountStore(dbPath,{fantasyPlayers:catalog.players,now:()=>now-36*60*60*1000});
  try{
    const own=await store.register('Existing_Manager','OnlyForThisLocalTest123');
    const original=store.submitFantasy(own.user.id,previewRosters(catalog)[0].playerIds,0);
    const history=store.fantasyHistory(own.user.id);
    store.close();store=null;
    const ids=await seedPreviewAccounts({directory,catalog,now});
    await seedPreviewAccounts({directory,catalog,now});
    store=createAccountStore(dbPath,{fantasyPlayers:catalog.players,now:()=>now-36*60*60*1000});
    assert.deepEqual(store.getFantasy(own.user.id),original);
    assert.deepEqual(store.fantasyHistory(own.user.id),history);
    assert.equal(store.getSession(own.token).user.id,own.user.id);
    assert.equal(store.listFantasySubmitted().length,4);
    for(const id of original.activePlayerIds)assert.ok(ids.includes(id));
    assert.ok(scoreFantasyHistory(history,createPreviewSnapshot(catalog,{playerIds:ids,now})).points>0);
  }finally{store?.close();await rm(temporary,{recursive:true,force:true});}
});

test('demo seeding rejects a path outside the dedicated preview directory',async()=>{
  await assert.rejects(seedPreviewAccounts({directory:tmpdir(),catalog,now}),/restricted/);
});
