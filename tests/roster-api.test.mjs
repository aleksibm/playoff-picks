import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEAMS } from '../dist/game.js';
import { createApp } from '../server.mjs';
import { initialMarket, priceVersion, validateMarket } from '../market-prices.mjs';
import { mergeRosterCatalog, validateRosterSnapshot } from '../roster-updates.mjs';

const now=Date.parse('2026-10-22T12:00:00Z');
const source='NHL current team rosters and active-player index';
const pool=TEAMS.flatMap((team,teamIndex)=>Array.from({length:20},(_,index)=>({
  id:1000+teamIndex*20+index,name:`${team.id} Player ${index+1}`,
  position:['C','RW','LW','D','D','G'][index%6],team:team.id,selectable:true,
})));
const catalog={season:'20262027',valuationSeason:'2025–26',usdPerPoint:10000,players:pool.slice(0,6).map((player,index)=>({
  id:player.id,name:player.name,position:player.position,team:player.team,
  price:[12_000_000,12_000_000,1_000_000,4_000_000,4_000_000,4_000_000][index],lastPoints:100,games:60,
}))};
const roster=(players=pool,fetchedAt='2026-10-22T10:00:00Z')=>validateRosterSnapshot({season:catalog.season,source,fetchedAt,players});
const newcomer=pool[6],newIdentity={id:99999,name:'New NHL Debut',position:'C',team:TEAMS[0].id,selectable:true};
const nextRoster=()=>roster([...pool.filter(player=>![pool[0].id,newcomer.id].includes(player.id)),newIdentity],'2026-10-22T11:00:00Z');
const options={dbPath:':memory:',fantasyCatalog:catalog,now:()=>now,allowStandingsFetch:false,allowFantasyFetch:false,allowContractFetch:false,allowRosterFetch:false,setTimer:()=>1,clearTimer:()=>{}};
async function listen(app){
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${app.server.address().port}`;
  return async path=>{const response=await fetch(url+path);assert.equal(response.status,200);return response.json();};
}
async function fixture(t,extra={}){
  const app=createApp({...options,rosterSnapshot:roster(),...extra});
  t.after(()=>app.close());
  return {app,request:await listen(app)};
}
function directory(t){const path=mkdtempSync(join(tmpdir(),'fantasy-roster-api-'));t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}
function verifiedPrices(base,overrides={}){
  const market={...initialMarket(base),asOf:'2026-10-19T09:00:00.000Z'};
  market.prices={...market.prices,...overrides};market.version=priceVersion(market);return market;
}

test('public player APIs add $100k debutants, retain unavailable identities and never refresh rosters on reads',async t=>{
  let calls=0;
  const unavailable=pool[0].id;
  const {request}=await fixture(t,{rosterSnapshot:roster(pool.filter(player=>player.id!==unavailable)),rosterProvider:async previous=>{calls++;return previous;}});
  const players=await request('/api/fantasy/players');
  assert.equal(calls,0);assert.equal(players.roster.available,true);assert.equal(players.roster.source,source);
  const rookie=players.players.find(player=>player.id===newcomer.id);
  assert.equal(rookie.price,100_000);assert.equal(rookie.newcomer,true);assert.equal(rookie.lastPoints,0);assert.equal(rookie.games,0);assert.equal(rookie.selectable,true);
  assert.equal(players.players.find(player=>player.id===unavailable).selectable,false);
  const values=await request('/api/fantasy/value');
  assert.equal(values.players.some(player=>player.id===unavailable),false);
  assert.equal(values.players.find(player=>player.id===newcomer.id).fantasyValue,100_000);
  assert.equal(values.coverage.total,639);
  await request('/api/fantasy/session');await request('/api/fantasy/weekly-players');
  assert.equal(calls,0);
});

test('custom test catalogs remain independent of the bundled production roster',async t=>{
  const app=createApp(options);t.after(()=>app.close());
  const request=await listen(app),data=await request('/api/fantasy/players');
  assert.equal(data.players.length,catalog.players.length);assert.equal(data.roster.available,false);
  assert.deepEqual(data.players.map(player=>player.id),catalog.players.map(player=>player.id));
});

test('startup expands saved market prices without changing old quotes or the last weekly update',async t=>{
  const path=directory(t),marketCachePath=join(path,'market-prices.json');
  const saved=verifiedPrices(catalog,{[pool[0].id]:12_600_000,[pool[1].id]:11_400_000});
  writeFileSync(marketCachePath,JSON.stringify(saved));
  const {request}=await fixture(t,{marketCachePath});
  const data=await request('/api/fantasy/players'),persisted=JSON.parse(readFileSync(marketCachePath,'utf8'));
  assert.equal(data.market.asOf,saved.asOf);assert.equal(persisted.asOf,saved.asOf);
  assert.notEqual(data.market.version,saved.version);assert.equal(persisted.version,data.market.version);
  for(const player of catalog.players){assert.equal(persisted.prices[player.id],saved.prices[player.id]);assert.equal(data.players.find(row=>row.id===player.id).price,saved.prices[player.id]);}
  assert.equal(persisted.prices[newcomer.id],100_000);
  assert.equal(validateMarket(mergeRosterCatalog(catalog,roster()),persisted),persisted);
});

test('a later roster update archives departed players at their old prices and adds a new identity',async t=>{
  const path=directory(t),marketCachePath=join(path,'market-prices.json'),initial=roster();
  const saved=verifiedPrices(mergeRosterCatalog(catalog,initial),{[newcomer.id]:175_000});writeFileSync(marketCachePath,JSON.stringify(saved));
  let calls=0,receivedPrevious;
  const {app,request}=await fixture(t,{marketCachePath,rosterProvider:async previous=>{calls++;receivedPrevious=previous;return nextRoster();}});
  const metadata=await app.refreshRoster(),data=await request('/api/fantasy/players');
  assert.equal(calls,1);assert.equal(receivedPrevious.fetchedAt,initial.fetchedAt);assert.equal(metadata.error,null);
  assert.equal(data.roster.fetchedAt,'2026-10-22T11:00:00Z');
  const archived=data.players.find(player=>player.id===newcomer.id),added=data.players.find(player=>player.id===newIdentity.id);
  assert.equal(archived.name,newcomer.name);assert.equal(archived.selectable,false);assert.equal(archived.price,175_000);
  assert.equal(data.players.find(player=>player.id===pool[0].id).selectable,false);
  assert.equal(added.price,100_000);assert.equal(added.selectable,true);assert.equal(added.newcomer,true);
  assert.equal(data.market.asOf,saved.asOf);assert.notEqual(data.market.version,saved.version);
  const values=await request('/api/fantasy/value');assert.equal(values.players.some(player=>player.id===newcomer.id),false);
});

test('partial, stale, future and failed roster updates preserve the last verified pool and report the error',async t=>{
  let update=()=>({...roster(),players:pool.slice(0,10)});
  const {app,request}=await fixture(t,{rosterProvider:async()=>update()});
  const original=await request('/api/fantasy/players');
  for(const attempt of [
    ()=>({...roster(),players:pool.slice(0,10)}),
    ()=>roster(pool,'2026-10-21T10:00:00Z'),
    ()=>roster(pool,'2026-10-23T10:00:00Z'),
    ()=>{throw Error('NHL service is unavailable');},
  ]){
    update=attempt;const metadata=await app.refreshRoster(),current=await request('/api/fantasy/players');
    assert.match(metadata.error,/last verified player list/);
    assert.deepEqual(current.players,original.players);assert.equal(current.roster.fetchedAt,original.roster.fetchedAt);
    assert.equal(current.market.version,original.market.version);
  }
  update=nextRoster;await app.refreshRoster();
  assert.equal((await request('/api/fantasy/players')).roster.error,null);
});

test('private roster and market caches retain added then departed identities and sale values after restart',async t=>{
  const path=mkdtempSync(join(tmpdir(),'fantasy-roster-restart-')),dbPath=join(path,'accounts.sqlite'),marketCachePath=join(path,'market-prices.json'),initial=roster();
  const saved=verifiedPrices(mergeRosterCatalog(catalog,initial),{[newcomer.id]:175_000});writeFileSync(marketCachePath,JSON.stringify(saved));
  let app=createApp({...options,dbPath,rosterSnapshot:initial,rosterProvider:async()=>nextRoster()});
  t.after(async()=>{await app.close();rmSync(path,{recursive:true,force:true});});
  let request=await listen(app);await app.refreshRoster();
  const before=await request('/api/fantasy/players');await app.close();
  const cached=JSON.parse(readFileSync(join(path,'fantasy-roster.json'),'utf8'));
  assert.equal(cached.players.find(player=>player.id===newcomer.id).selectable,false);
  app=createApp({...options,dbPath,rosterSnapshot:initial});request=await listen(app);
  const after=await request('/api/fantasy/players');
  assert.deepEqual(after.players,before.players);assert.equal(after.market.version,before.market.version);
  assert.equal(after.players.find(player=>player.id===newcomer.id).price,175_000);
  assert.equal(after.players.find(player=>player.id===newIdentity.id).price,100_000);
  assert.equal(after.roster.fetchedAt,cached.fetchedAt);
});

test('startup refreshes an overdue roster once and serves the saved pool while that update is pending',async t=>{
  let calls=0,finish;
  const pending=new Promise(resolve=>{finish=resolve;});
  const stale=roster(pool,'2026-10-21T10:00:00Z');
  const {app,request}=await fixture(t,{rosterSnapshot:stale,rosterProvider:async previous=>{calls++;assert.equal(previous.fetchedAt,stale.fetchedAt);return pending;}});
  assert.equal(calls,1);
  const during=await request('/api/fantasy/players');
  assert.equal(during.roster.fetchedAt,stale.fetchedAt);assert.equal(during.roster.stale,true);assert.equal(calls,1);
  const completing=app.refreshRoster();finish(nextRoster());await completing;
  const after=await request('/api/fantasy/players');
  assert.equal(calls,1);assert.equal(after.roster.stale,false);
  assert.equal(after.players.find(player=>player.id===newIdentity.id).price,100_000);
});

test('the shared Helsinki noon scheduler refreshes the roster and schedules the following day',async t=>{
  let time=Date.parse('2026-10-22T08:59:00Z'),calls=0,timer;
  const app=createApp({...options,now:()=>time,rosterSnapshot:roster(pool,'2026-10-22T08:00:00Z'),
    rosterProvider:async()=>{calls++;return roster(pool,new Date(time).toISOString());},
    setTimer:(callback,delay)=>{timer={callback,delay};return 1;}});
  t.after(()=>app.close());
  const request=await listen(app);
  assert.equal(calls,0);assert.equal(timer.delay,60_000);
  time=Date.parse('2026-10-22T09:00:00Z');await timer.callback();
  assert.equal(calls,1);assert.equal(timer.delay,24*60*60*1000);
  const data=await request('/api/fantasy/players');assert.equal(data.roster.fetchedAt,'2026-10-22T09:00:00.000Z');
});
