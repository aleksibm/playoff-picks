import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchPriceHistory, priceHistoryCutoff, validatePriceHistory } from '../fantasy-price-history.mjs';
import { FANTASY_RATES } from '../fantasy-rates.mjs';
import { createApp } from '../server.mjs';

const asOf=Date.parse('2026-10-26T10:00:00Z');
const catalog={season:'20262027',scoringVersion:FANTASY_RATES.version,usdPerPoint:1000,players:[{id:1,name:'Rolling skater',team:'COL',position:'C',price:820_000,lastPoints:1000,games:82}]};
const game=(id,date,points=10)=>({id,startTime:date,scores:{1:points},pending:[],teams:{}});
const snapshot=(season,games)=>({season,scoringVersion:FANTASY_RATES.version,fetchedAt:new Date(asOf).toISOString(),games});
const current=snapshot(catalog.season,Array.from({length:5},(_,i)=>game(2026020001+i,new Date(Date.UTC(2026,9,1+i)).toISOString())));
const history=(games=[])=>({season:catalog.season,scoringVersion:FANTASY_RATES.version,fetchedAt:new Date(asOf).toISOString(),from:new Date(priceHistoryCutoff(asOf)).toISOString(),playerIds:[1],games});

test('backfill crosses seasons, fetches only the missing appearances and reuses verified history',async()=>{
  const requests=[];
  const fetchSnapshot=async options=>{
    requests.push({...options,playerWindows:new Map(options.playerWindows)});
    const year=Number(options.season.slice(0,4)),count=year===2025?60:35;
    return snapshot(options.season,Array.from({length:count},(_,i)=>game(Number(String(year)+'020001')+i,new Date(Date.UTC(year,9,1+i)).toISOString())));
  };
  const result=await fetchPriceHistory({catalog,stats:current,asOf,now:asOf,fetchSnapshot});
  assert.deepEqual(requests.map(r=>r.season),['20252026','20242025']);
  assert.deepEqual(requests.map(r=>r.playerWindows.get(1)),[95,35]);
  assert.ok(requests.every(r=>r.since===priceHistoryCutoff(asOf)));
  assert.equal(result.games.length,95);
  assert.equal(validatePriceHistory(JSON.parse(JSON.stringify(result)),catalog.season).games.length,95);
  assert.equal(await fetchPriceHistory({catalog,stats:current,asOf,now:asOf,previous:result,fetchSnapshot:()=>{throw Error('Unexpected fetch');}}),result);
});

test('backfill stops at three years, keeps shorter histories and discards old or future games',async()=>{
  const seasons=[],cutoff=priceHistoryCutoff(asOf);
  const result=await fetchPriceHistory({catalog,stats:current,asOf,now:asOf,fetchSnapshot:async({season})=>{
    seasons.push(season);
    return snapshot(season,season==='20232024'?[
      game(2023020001,new Date(cutoff-1).toISOString(),999),game(2023020002,new Date(cutoff).toISOString()),
      game(2023020003,new Date(asOf+1).toISOString(),999),
    ]:[]);
  }});
  assert.deepEqual(seasons,['20252026','20242025','20232024']);
  assert.deepEqual(result.games.map(g=>g.id),[2023020002]);
  assert.equal(priceHistoryCutoff(Date.parse('2027-10-26T10:00:00Z')),Date.parse('2024-10-26T10:00:00Z'));
});

test('new eligible players require coverage and a pending historical adjustment retries the history',async()=>{
  let calls=0;
  const saved=history();saved.playerIds=[];
  const fetchSnapshot=async({season})=>{calls++;return snapshot(season,[]);};
  const result=await fetchPriceHistory({catalog,stats:current,asOf,now:asOf,previous:saved,fetchSnapshot});
  assert.deepEqual(result.playerIds,[1]);assert.equal(calls,3);
  calls=0;
  const pending=history([game(2025020001,'2025-10-01T18:00:00Z')]);pending.games[0].pending=[1];
  await fetchPriceHistory({catalog,stats:current,asOf,now:asOf,previous:pending,fetchSnapshot});
  assert.equal(calls,3);
});

test('history validation rejects mismatched scoring, unknown players and duplicate games',()=>{
  assert.throws(()=>validatePriceHistory({...history(),scoringVersion:'legacy'},catalog.season));
  assert.throws(()=>validatePriceHistory({...history(),season:'20252026'},catalog.season));
  assert.throws(()=>validatePriceHistory({...history([game(2025020001,'2025-10-01T18:00:00Z')]),playerIds:[]},catalog.season));
  const g=game(2025020001,'2025-10-01T18:00:00Z');
  assert.throws(()=>validatePriceHistory(history([g,g]),catalog.season));
  assert.throws(()=>validatePriceHistory(history(current.games),catalog.season));
});

test('server persists the historical cache, exposes the new weights and protects prices after a failed history refresh',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'fantasy-history-')),marketCachePath=join(directory,'market-prices.json'),priceHistoryCachePath=join(directory,'fantasy-price-history.json');
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let fail=false,calls=0;
  const app=createApp({dbPath:':memory:',fantasyCatalog:catalog,marketCachePath,priceHistoryCachePath,now:()=>asOf,allowStandingsFetch:false,allowRosterFetch:false,allowContractFetch:false,
    fantasyProvider:async()=>current,priceHistoryProvider:async()=>{calls++;if(fail)throw Error('History unavailable');return history();}});
  t.after(()=>app.close());
  await app.refreshFantasy();
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+app.server.address().port;
  const body=await(await fetch(url+'/api/fantasy/players')).json();
  assert.equal(body.market.last100GamesWeight,.5);assert.equal(body.market.currentSeasonWeight,.25);assert.equal(body.market.last25GamesWeight,.25);
  assert.equal(body.market.maxHistoryYears,3);assert.equal(body.market.lastSeasonWeight,undefined);
  assert.equal(body.market.historyAvailable,true);assert.equal(body.players[0].price,820_000);
  assert.deepEqual(JSON.parse(readFileSync(priceHistoryCachePath,'utf8')),history());
  const savedMarket=readFileSync(marketCachePath,'utf8');
  fail=true;await app.refreshFantasy();
  assert.ok(calls>=2);assert.equal(readFileSync(marketCachePath,'utf8'),savedMarket);
});

test('server keeps prices unchanged when historical backfill has never succeeded',async t=>{
  const app=createApp({dbPath:':memory:',fantasyCatalog:catalog,now:()=>asOf,allowStandingsFetch:false,allowRosterFetch:false,allowContractFetch:false,
    fantasyProvider:async()=>current,priceHistoryProvider:async()=>{throw Error('No history');}});
  t.after(()=>app.close());await app.refreshFantasy();
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const body=await(await fetch('http://127.0.0.1:'+app.server.address().port+'/api/fantasy/players')).json();
  assert.equal(body.players[0].price,820_000);assert.equal(body.market.overdue,true);assert.equal(body.market.historyAvailable,false);assert.match(body.market.historyError,/Historical appearances/);
});
