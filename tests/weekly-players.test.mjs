import test from 'node:test';
import assert from 'node:assert/strict';
import { fantasyWeek, fantasyPeriod, weeklyTopPlayers } from '../fantasy-scoring.mjs';
import { createApp } from '../server.mjs';

const now=Date.parse('2026-10-22T10:00:00Z');
const players=Array.from({length:13},(_,i)=>({id:i+1,name:`Player ${i+1}`,position:i===1?'G':i===2?'D':'C',team:'COL',price:1_000_000,lastPoints:100,games:60}));
const catalog={season:'20262027',usdPerPoint:10000,players};
const game=(id,startTime,scores,extra={})=>({id,startTime,date:startTime.slice(0,10),scores,pending:[],teams:Object.fromEntries(Object.keys(scores).map(id=>[id,'COL'])),...extra});
const snapshot=games=>({season:catalog.season,fetchedAt:'2026-10-22T09:00:00Z',games});

test('weeks begin at Helsinki Monday midnight and switch at the exact local boundary',()=>{
  const before=fantasyWeek(Date.parse('2026-10-18T20:59:59.999Z'));
  assert.equal(before.start,'2026-10-11T21:00:00.000Z');assert.equal(before.end,'2026-10-18T21:00:00.000Z');
  const after=fantasyWeek(Date.parse('2026-10-18T21:00:00Z'));
  assert.equal(after.start,'2026-10-18T21:00:00.000Z');assert.equal(after.end,'2026-10-25T22:00:00.000Z');
  assert.equal(after.timeZone,'Europe/Helsinki');assert.equal(after.key,'current');
  const previous=fantasyWeek(now,'previous');
  assert.equal(previous.start,before.start);assert.equal(previous.end,before.end);assert.equal(previous.key,'previous');
});

test('Helsinki calendar weeks span 169 or 167 hours across daylight-saving changes',()=>{
  const autumn=fantasyWeek(now),spring=fantasyWeek(Date.parse('2027-03-28T12:00:00Z'));
  assert.equal((Date.parse(autumn.end)-Date.parse(autumn.start))/3600_000,169);
  assert.equal(spring.start,'2027-03-21T22:00:00.000Z');assert.equal(spring.end,'2027-03-28T21:00:00.000Z');
  assert.equal((Date.parse(spring.end)-Date.parse(spring.start))/3600_000,167);
  assert.throws(()=>fantasyWeek(now,'next'));assert.throws(()=>fantasyWeek(NaN));
});

test('month and year-to-date begin at Helsinki calendar midnights and end at the current instant',()=>{
  const month=fantasyPeriod(now,'month'),year=fantasyPeriod(now,'year');
  assert.deepEqual(month,{key:'month',start:'2026-09-30T21:00:00.000Z',end:new Date(now).toISOString(),timeZone:'Europe/Helsinki'});
  assert.equal(year.start,'2025-12-31T22:00:00.000Z');assert.equal(year.end,month.end);
  assert.deepEqual(fantasyPeriod(now),fantasyWeek(now));assert.deepEqual(fantasyPeriod(now,'previous'),fantasyWeek(now,'previous'));
  assert.throws(()=>fantasyPeriod(now,'all'));assert.throws(()=>fantasyPeriod(NaN,'month'));
});

test('calendar period boundaries follow Helsinki at month/year rollover and across DST',()=>{
  const justBefore=Date.parse('2026-12-31T21:59:59.999Z'),newYear=justBefore+1;
  assert.equal(fantasyPeriod(justBefore,'year').start,'2025-12-31T22:00:00.000Z');
  assert.equal(fantasyPeriod(newYear,'year').start,'2026-12-31T22:00:00.000Z');
  assert.equal(fantasyPeriod(newYear,'month').start,'2026-12-31T22:00:00.000Z');
  assert.equal(fantasyPeriod(newYear,'year').end,'2026-12-31T22:00:00.000Z');
  assert.equal(fantasyPeriod(Date.parse('2026-10-31T22:00:00Z'),'month').start,'2026-10-31T22:00:00.000Z');
  assert.equal(fantasyPeriod(Date.parse('2027-03-29T12:00:00Z'),'month').start,'2027-02-28T22:00:00.000Z');
  assert.equal(fantasyPeriod(Date.parse('2027-03-31T21:00:00Z'),'month').start,'2027-03-31T21:00:00.000Z');
});

test('month and year totals include only their current-season interval, preserving fractions and provisional negatives',()=>{
  const feed=snapshot([
    game(2026020001,'2025-12-31T21:59:59.999Z',{1:999}),
    game(2026020002,'2025-12-31T22:00:00.000Z',{1:7}),
    game(2026020003,'2026-09-30T20:59:59.999Z',{1:5}),
    game(2026020004,'2026-09-30T21:00:00.000Z',{1:20/9,2:-3,3:0,4:999},{pending:[2]}),
    game(2026020005,new Date(now-1).toISOString(),{1:10/3,2:-2},{teams:{1:'NJD',2:'DAL'}}),
    game(2026020006,new Date(now).toISOString(),{1:999}),
    game(2026020007,new Date(now+1).toISOString(),{1:999}),
  ]);
  const pool={...catalog,players:catalog.players.map(p=>({...p,selectable:p.id!==4}))};
  const month=weeklyTopPlayers(pool,feed,{week:'month',now}),year=weeklyTopPlayers(pool,feed,{week:'year',now});
  assert.deepEqual(month.players.map(p=>p.id),[1,3,2]);assert.equal(month.players[0].points,20/9+10/3);
  assert.equal(month.players[0].games,2);assert.equal(month.players[0].team,'NJD');
  assert.equal(month.players[1].points,0);assert.equal(month.players[2].points,-5);assert.equal(month.players[2].pending,true);
  assert.equal(year.players[0].points,7+5+20/9+10/3);assert.equal(year.players[0].games,4);
  assert.deepEqual(weeklyTopPlayers(pool,{...feed,season:'20252026'},{week:'year',now}).players,[]);
  assert.deepEqual(weeklyTopPlayers(pool,null,{week:'month',now}).players,[]);
});

test('weekly totals use game start instants with inclusive start and exclusive end',()=>{
  const feed=snapshot([
    game(2026020001,'2026-10-18T20:59:59.999Z',{1:100}),
    game(2026020002,'2026-10-18T21:00:00Z',{1:5}),
    game(2026020003,'2026-10-25T21:59:59.999Z',{1:7}),
    game(2026020004,'2026-10-25T22:00:00Z',{1:1000}),
  ]);
  // NHL game dates do not determine which Helsinki calendar week scores.
  feed.games[1].date='2026-10-18';
  const current=weeklyTopPlayers(catalog,feed,{now}),previous=weeklyTopPlayers(catalog,feed,{now,week:'previous'});
  assert.equal(current.players[0].points,12);assert.equal(current.players[0].games,2);
  assert.equal(previous.players[0].points,100);assert.equal(previous.players[0].games,1);
});

test('rankings preserve fractions, zero and negative appearances, provisional totals and latest weekly team',()=>{
  const feed=snapshot([
    game(2026020002,'2026-10-21T18:00:00Z',{1:5,2:-3},{teams:{1:'NJD',2:'DAL'}}),
    game(2026020001,'2026-10-20T18:00:00Z',{1:20/9,2:-2,3:0,999:999},{pending:[2],teams:{1:'COL',2:'DAL',3:'COL',999:'COL'}}),
  ]);
  const result=weeklyTopPlayers(catalog,feed,{now}).players;
  assert.deepEqual(result.map(p=>p.id),[1,3,2]);assert.deepEqual(result.map(p=>p.rank),[1,2,3]);
  assert.equal(result[0].points,20/9+5);assert.equal(result[0].games,2);assert.equal(result[0].team,'NJD');
  assert.equal(result[1].points,0);assert.equal(result[1].games,1);
  assert.equal(result[2].points,-5);assert.equal(result[2].pending,true);assert.equal(result[2].position,'G');
  assert.equal(result.some(p=>p.id===999),false);
});

test('top ten rows use deterministic ID ordering and competition ranks for ties',()=>{
  const scores=Object.fromEntries(players.map(p=>[p.id,p.id===13?10:p.id<=2?5:3]));
  const feed=snapshot([game(2026020001,'2026-10-20T18:00:00Z',scores)]);
  const ranked=weeklyTopPlayers(catalog,feed,{now}).players;
  assert.equal(ranked.length,10);assert.deepEqual(ranked.map(p=>p.id),[13,1,2,3,4,5,6,7,8,9]);
  assert.deepEqual(ranked.map(p=>p.rank),[1,2,2,4,4,4,4,4,4,4]);
  assert.deepEqual(weeklyTopPlayers({...catalog,players:[...players].reverse()},feed,{now}).players,ranked);
});

const apiFeed=snapshot([
  game(2026020001,'2026-10-18T20:00:00Z',{1:50}),
  game(2026020002,'2026-10-20T18:00:00Z',{1:10,2:0},{pending:[2]}),
]);
async function fixture(t,{data=apiFeed}={}){
  let calls=0;
  const app=createApp({dbPath:':memory:',fantasyCatalog:catalog,now:()=>now,allowStandingsFetch:false,allowFantasyFetch:false,allowContractFetch:false,
    ...(data?{fantasyProvider:async()=>{calls++;return data;}}:{}),setTimer:()=>1,clearTimer:()=>{}});
  t.after(()=>app.close());
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  if(data)await app.refreshFantasy();
  const url=`http://127.0.0.1:${app.server.address().port}`;
  return {calls:()=>calls,async request(query=''){
    const response=await fetch(`${url}/api/fantasy/weekly-players${query}`);
    return {status:response.status,data:await response.json()};
  }};
}

test('public weekly API selects current or previous week and never fetches upstream on reads',async t=>{
  const {request,calls}=await fixture(t),before=calls();
  const current=await request(),previous=await request('?week=previous');
  assert.equal(current.status,200);assert.equal(current.data.season,catalog.season);
  assert.equal(current.data.week.key,'current');assert.equal(current.data.players[0].points,10);
  assert.equal(current.data.players[1].points,0);assert.equal(current.data.players[1].pending,true);
  assert.equal(previous.data.week.key,'previous');assert.equal(previous.data.players[0].points,50);
  assert.equal(calls(),before);assert.equal(current.data.scoring.available,true);
  for(const key of ['user','entry','csrfToken','playerGames','cashBalance'])assert.equal(Object.hasOwn(current.data,key),false);
  for(const query of ['?week=next','?week=','?week=Current','?week=current&week=previous'])assert.equal((await request(query)).status,400);
});

test('public ranking API accepts month and year-to-date without upstream reads or changing weekly compatibility',async t=>{
  const {request,calls}=await fixture(t),before=calls();
  for(const period of ['month','year']){
    const result=await request(`?week=${period}`);
    assert.equal(result.status,200);assert.equal(result.data.week.key,period);
    assert.equal(result.data.week.end,new Date(now).toISOString());assert.equal(result.data.week.timeZone,'Europe/Helsinki');
    assert.equal(result.data.season,catalog.season);assert.equal(result.data.players[0].points,60);
    assert.equal(result.data.players[1].points,0);assert.equal(result.data.players[1].pending,true);
  }
  assert.equal((await request('?week=current')).data.players[0].points,10);
  assert.equal((await request('?week=previous')).data.players[0].points,50);
  for(const query of ['?week=Month','?week=yearly','?week=month&week=year'])assert.equal((await request(query)).status,400);
  assert.equal(calls(),before);
});

test('weekly API distinguishes unavailable scores from verified empty weeks without falling back',async t=>{
  const unavailable=await fixture(t,{data:null}),missing=(await unavailable.request()).data;
  assert.equal(missing.scoring.available,false);assert.deepEqual(missing.players,[]);assert.equal(missing.week.key,'current');
  const staleFeed={...apiFeed,fetchedAt:'2026-10-18T19:00:00Z',games:[apiFeed.games[0]]};
  const stale=await fixture(t,{data:staleFeed}),empty=(await stale.request()).data;
  assert.equal(empty.scoring.available,true);assert.equal(empty.scoring.stale,true);
  assert.equal(empty.week.start,'2026-10-18T21:00:00.000Z');assert.deepEqual(empty.players,[]);
  assert.equal((await stale.request('?week=previous')).data.players[0].points,50);
});
