import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountStore } from '../accounts.mjs';
import { createApp } from '../server.mjs';
import { transferMonth, rosterProgress, BUDGET } from '../dist/fantasy-rules.js';
import { penaltyScore, powerPlay, scoreGame, scoreFantasyHistory, parseCsv, goalieModel, validateFantasySnapshot } from '../fantasy-scoring.mjs';

const players=[
  {id:1,name:'Star Forward',position:'C',team:'COL',price:12_000_000,lastPoints:700,games:80},
  {id:2,name:'Star Wing',position:'RW',team:'TBL',price:12_000_000,lastPoints:700,games:80},
  {id:3,name:'Cheap Wing',position:'LW',team:'DAL',price:1_000_000,lastPoints:60,games:60},
  {id:4,name:'First Defenseman',position:'D',team:'COL',price:4_000_000,lastPoints:250,games:80},
  {id:5,name:'Second Defenseman',position:'D',team:'TOR',price:4_000_000,lastPoints:250,games:80},
  {id:6,name:'Goalie One',position:'G',team:'DAL',price:4_000_000,lastPoints:250,games:50},
  {id:7,name:'Replacement Forward',position:'C',team:'TOR',price:1_500_000,lastPoints:90,games:60},
  {id:8,name:'Replacement Defenseman',position:'D',team:'NJD',price:4_500_000,lastPoints:280,games:60},
  {id:9,name:'Replacement Goalie',position:'G',team:'NYI',price:4_500_000,lastPoints:280,games:45},
  {id:10,name:'Expensive Forward',position:'C',team:'COL',price:20_000_000,lastPoints:1000,games:80},
];
const initial=[1,2,3,4,5,6];
const catalog={players,season:'20262027',budget:BUDGET};
async function fixture(t){
  let time=Date.parse('2026-10-31T20:00:00Z');
  const path=mkdtempSync(join(tmpdir(),'fantasy-store-'));
  const dbPath=join(path,'accounts.sqlite');
  const store=createAccountStore(dbPath,{fantasyPlayers:players,now:()=>time});
  const user=await store.register('FantasyFan','hockey-fantasy-test');
  t.after(()=>{store.close();rmSync(path,{recursive:true,force:true});});
  return {store,user:user.user,dbPath,setTime:value=>{time=Date.parse(value);}};
}

test('fantasy roster validates all positions, duplicate IDs, unknown players and exact budget',()=>{
  assert.equal(rosterProgress(initial,players).complete,true);
  assert.equal(rosterProgress([1,2,3,4,5,6],players).cost,37_000_000);
  assert.equal(rosterProgress([1,2,3,4,5,9],players).valid,true);
  assert.equal(rosterProgress([1,2,10,4,5,6],players).valid,false);
  assert.equal(rosterProgress([1,1,3,4,5,6],players).valid,false);
  assert.equal(rosterProgress([1,2,3,4,5,999],players).valid,false);
  assert.equal(rosterProgress([1,2,3,4,6,9],players).valid,false);
});
test('transfer month uses Helsinki calendar, including DST boundary',()=>{
  assert.equal(transferMonth(Date.parse('2026-10-31T21:59:59Z')),'2026-10');
  assert.equal(transferMonth(Date.parse('2026-10-31T22:00:00Z')),'2026-11');
  assert.equal(transferMonth(Date.parse('2026-06-30T21:00:00Z')),'2026-07');
});
test('first submission is free, persists history and does not enter Playoff Pick',async t=>{
  const {store,user}=await fixture(t);
  const draft=store.saveFantasyDraft(user.id,initial,0);
  const entry=store.submitFantasy(user.id,initial,draft.revision);
  assert.equal(entry.state,'submitted');assert.equal(entry.transfers.remaining,2);
  assert.equal(store.getPrediction(user.id),null);
  assert.equal(store.listSubmitted().length,0);
  assert.equal(store.listFantasySubmitted().length,1);
  assert.equal(store.fantasyHistory(user.id).length,1);
});
test('two replacements use the full allowance; a third is rejected atomically',async t=>{
  const {store,user}=await fixture(t);
  let e=store.submitFantasy(user.id,initial,0);
  e=store.submitFantasy(user.id,[1,2,7,4,8,6],e.revision);
  assert.equal(e.transfers.used,2);assert.equal(e.transfers.remaining,0);
  assert.throws(()=>store.submitFantasy(user.id,[1,2,7,4,8,9],e.revision),/0 transfers left/);
  assert.deepEqual(store.getFantasy(user.id).activePlayerIds,[1,2,7,4,8,6]);
  assert.equal(store.fantasyHistory(user.id).length,2);
});
test('monthly allowance resets to two with no rollover and includes reversals',async t=>{
  const {store,user,setTime}=await fixture(t);
  let e=store.submitFantasy(user.id,initial,0);
  e=store.submitFantasy(user.id,[1,2,7,4,5,6],e.revision);
  assert.equal(e.transfers.remaining,1);
  setTime('2026-10-31T22:00:00Z');
  assert.equal(store.getFantasy(user.id).transfers.remaining,2);
  e=store.submitFantasy(user.id,initial,e.revision);
  assert.equal(e.transfers.remaining,1);
  e=store.submitFantasy(user.id,[1,2,7,4,5,6],e.revision);
  assert.equal(e.transfers.remaining,0);
});
test('saving planned transfers does not change active roster or spend transfers',async t=>{
  const {store,user}=await fixture(t);
  const submitted=store.submitFantasy(user.id,initial,0);
  const draft=store.saveFantasyDraft(user.id,[1,2,7,4,5,6],submitted.revision);
  assert.deepEqual(draft.activePlayerIds,initial);assert.equal(draft.transfers.remaining,2);
  assert.equal(store.fantasyHistory(user.id).length,1);
  assert.throws(()=>store.submitFantasy(user.id,initial,submitted.revision),/another tab/);
  const unchanged=store.submitFantasy(user.id,[...initial].reverse(),draft.revision);
  assert.equal(unchanged.transfers.remaining,2);assert.equal(store.fantasyHistory(user.id).length,1);
});
test('invalid transfer roster or budget cannot be saved through backend',async t=>{
  const {store,user}=await fixture(t);
  for(const ids of [[1,2,3,4,6,9],[1,2,10,4,5,6],[1,2,3,4,5,777],[1,1,3,4,5,6]])assert.throws(()=>store.submitFantasy(user.id,ids,0));
  assert.throws(()=>store.submitFantasy(user.id,[1,2],0),/Complete your team/);
  assert.equal(store.getFantasy(user.id).revision,0);
});
test('fantasy records survive restart and usernames use the common account',async t=>{
  const {store,user,dbPath}=await fixture(t);
  store.submitFantasy(user.id,initial,0);
  const second=createAccountStore(dbPath,{fantasyPlayers:players});
  try{assert.deepEqual(second.getFantasy(user.id).activePlayerIds,initial);assert.equal(second.listFantasySubmitted()[0].username,'fantasyfan');}
  finally{second.close();}
});
test('historical lineups keep past points; transfers and late entry cannot capture already-started games',()=>{
  const snapshot={games:[
    {startTime:'2026-10-10T18:00:00Z',scores:{1:100},pending:[]},
    {startTime:'2026-10-10T20:00:00Z',scores:{1:10,7:90},pending:[]},
    {startTime:'2026-10-11T20:00:00Z',scores:{1:80,7:20},pending:[7]},
  ]};
  const history=[{effectiveAt:'2026-10-10T19:00:00Z',playerIds:[1]},{effectiveAt:'2026-10-10T20:30:00Z',playerIds:[7]}];
  const result=scoreFantasyHistory(history,snapshot);
  assert.equal(result.points,30);assert.equal(result.players[1],10);assert.equal(result.players[7],20);assert.equal(result.pending,true);
  assert.equal(scoreFantasyHistory(history,null).points,null);
});
test('penalty tiers score double minors once and never charge bench penalties to a server',()=>{
  const d=(duration,typeCode='MIN')=>({duration,typeCode,committedByPlayerId:1});
  assert.equal(penaltyScore(d(2)),-5/3);assert.equal(penaltyScore(d(4)),-5/3);
  assert.equal(penaltyScore(d(5,'MAJ')),-10/3);assert.equal(penaltyScore(d(10,'MIS')),-5);
  assert.equal(penaltyScore(d(0,'GAM')),-5);assert.equal(penaltyScore(d(5,'MAT')),-5);
  assert.equal(penaltyScore({duration:2,typeCode:'BEN',servedByPlayerId:1}),0);
});
test('a transfer after the starting second cannot capture a game without fractional timestamp formatting',()=>{
  const snapshot={games:[{startTime:'2026-10-10T20:00:00Z',scores:{1:8,7:99},pending:[]}]};
  const history=[{effectiveAt:'2026-10-10T19:00:00.000Z',playerIds:[1]},{effectiveAt:'2026-10-10T20:00:00.500Z',playerIds:[7]}];
  assert.equal(scoreFantasyHistory(history,snapshot).points,8);
  assert.equal(scoreFantasyHistory([{effectiveAt:'2026-10-10T20:00:00.500Z',playerIds:[7]}],snapshot).points,0);
});
test('extra attacker alone is even strength, and actual manpower advantage counts as PP',()=>{
  assert.equal(powerPlay({situationCode:'1551',details:{eventOwnerTeamId:2}},2),false);
  assert.equal(powerPlay({situationCode:'1560',details:{eventOwnerTeamId:2}},2),false);
  assert.equal(powerPlay({situationCode:'1451',details:{eventOwnerTeamId:2}},2),true);
});
test('game scoring applies full PP game-winner, defense multiplier, team win and shutout saves only',()=>{
  const pbp={id:2026020001,season:20262027,gameType:2,gameState:'OFF',gameDate:'2026-10-10',startTimeUTC:'2026-10-10T20:00:00Z',homeTeam:{id:2,score:1},awayTeam:{id:1,score:0},plays:[
    {typeDescKey:'goal',periodDescriptor:{periodType:'REG'},situationCode:'1451',details:{eventOwnerTeamId:2,scoringPlayerId:4,assist1PlayerId:1}},
  ]};
  const row={gameId:pbp.id,homeRoad:'H',teamAbbrev:'COL'};
  const skaters=[{...row,playerId:4,positionCode:'D',goals:1,assists:0,ppGoals:1,ppPoints:1,gameWinningGoals:1,shots:2},{...row,playerId:1,positionCode:'C',goals:0,assists:1,ppGoals:0,ppPoints:1,gameWinningGoals:0,shots:0}];
  const rt=new Map(skaters.map(r=>[`${r.gameId}:${r.playerId}`,{hits:0,blockedShots:0,takeaways:0}]));
  const fo=new Map(skaters.map(r=>[`${r.gameId}:${r.playerId}`,{totalFaceoffWins:0,totalFaceoffLosses:0}]));
  const result=scoreGame({pbp,skaters,goalies:[{...row,playerId:6,saves:32,goalsAgainst:0,shotsAgainst:32,shutouts:1}],realtime:rt,faceoffs:fo,model:new Map([[`${pbp.id}:6`,{gsax:2,goals:0}]])});
  assert.equal(result.scores[4],6.25*1.5+.5+5);assert.equal(result.scores[1],20/9+5);
  assert.equal(result.scores[6],32*.625*1.5+5+10);assert.deepEqual(result.pending,[]);
  const pending=scoreGame({pbp,skaters,goalies:[{...row,playerId:6,saves:32,goalsAgainst:0,shotsAgainst:32,shutouts:0}],realtime:rt,faceoffs:fo,model:new Map()});
  assert.equal(pending.scores[6],25);assert.deepEqual(pending.pending,[6]);
});
test('MoneyPuck parser preserves quoted names, signed GSAx and rejects wrong season/duplicates',()=>{
  const text='playerId,gameId,season,situation,xGoals,goals,name\n6,2026020001,2026,all,1.5,3,"Doe, John"\n';
  const parsed=parseCsv(text);assert.equal(parsed[0].name,'Doe, John');assert.equal(goalieModel(parsed).get('2026020001:6').gsax,-1.5);
  assert.throws(()=>goalieModel([...parsed,...parsed]),/Duplicate/);
  assert.throws(()=>goalieModel([{...parsed[0],season:'2025'}]),/Wrong/);
  assert.throws(()=>validateFantasySnapshot({season:'20252026',fetchedAt:new Date().toISOString(),games:[]}),/Invalid/);
});

test('HTTP fantasy uses shared accounts but independent rosters, scoreboards and CSRF checks',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'fantasy-http-'));
  const snapshot={season:'20262027',fetchedAt:new Date().toISOString(),games:[{id:2026020001,startTime:'2026-10-01T20:00:00Z',date:'2026-10-01',scores:{6:12.5},pending:[6],teams:{6:'DAL'}}]};
  const app=createApp({dbPath:join(directory,'accounts.sqlite'),allowStandingsFetch:false,allowFantasyFetch:false,fantasyCatalog:catalog,fantasyProvider:async()=>snapshot});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));await app.refreshFantasy();
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${app.server.address().port}`;
  const request=async(path,{method='GET',body,cookie,csrf}={})=>{
    const response=await fetch(url+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json',Origin:url}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},body:body?JSON.stringify(body):undefined});
    return {response,data:await response.json()};
  };
  const guest=await request('/api/fantasy/submit',{method:'POST',body:{playerIds:initial,revision:0}});assert.equal(guest.response.status,401);
  const reg=await request('/api/fantasy/register',{method:'POST',body:{username:'OneAccount',password:'fantasy-password-test'}});
  assert.equal(reg.response.status,200);assert.equal(Object.hasOwn(reg.data,'prediction'),false);
  const cookie=reg.response.headers.get('set-cookie').split(';')[0],csrf=reg.data.csrfToken;
  const denied=await request('/api/fantasy/submit',{method:'POST',cookie,body:{playerIds:initial,revision:0}});assert.equal(denied.response.status,403);
  const stalePrice=await request('/api/fantasy/submit',{method:'POST',cookie,csrf,body:{playerIds:initial,revision:0,priceVersion:'stale'}});assert.equal(stalePrice.response.status,409);
  const submit=await request('/api/fantasy/submit',{method:'POST',cookie,csrf,body:{playerIds:initial,revision:0,priceVersion:reg.data.market.version,cost:0,transfers:0}});assert.equal(submit.response.status,200);assert.equal(submit.data.score.points,0);
  const playoff=await request('/api/session',{cookie});assert.equal(playoff.data.prediction,null);assert.equal(playoff.data.user.id,reg.data.user.id);
  const guestLeague=await request('/api/fantasy/leaderboard');assert.equal(guestLeague.data.locked,true);assert.deepEqual(guestLeague.data.entries,[]);
  const league=await request('/api/fantasy/leaderboard',{cookie});assert.equal(league.data.entries.length,1);
  const publicCatalog=await request('/api/fantasy/players');assert.equal(publicCatalog.data.players.length,players.length);
  assert.equal(publicCatalog.data.players.find(p=>p.id===6).pending,true);
  assert.equal(publicCatalog.data.players.find(p=>p.id===6).seasonPoints,12.5);
  const playoffLeague=await request('/api/leaderboard',{cookie});assert.equal(playoffLeague.data.locked,true);
  const attacker=await request('/api/fantasy/register',{method:'POST',body:{username:'OtherFan',password:'another-password-test'}});
  const otherCookie=attacker.response.headers.get('set-cookie').split(';')[0];
  const otherLeague=await request('/api/fantasy/leaderboard',{cookie:otherCookie});assert.equal(otherLeague.data.locked,true);assert.deepEqual(otherLeague.data.entries,[]);
  const other=await request('/api/fantasy/session',{cookie:otherCookie});assert.deepEqual(other.data.entry.activePlayerIds,[]);
});

test('fresh Fantasy cache is reused at startup and page reads never fetch upstream; noon refreshes once',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'fantasy-daily-'));
  let time=Date.parse('2026-10-18T10:00:00Z'),calls=0,timer;
  const cache=join(directory,'fantasy-scores.json');
  writeFileSync(cache,JSON.stringify({season:'20262027',fetchedAt:new Date(time).toISOString(),games:[]}));
  const app=createApp({dbPath:join(directory,'accounts.sqlite'),allowStandingsFetch:false,fantasyCatalog:catalog,now:()=>time,
    fantasyProvider:async()=>{calls++;return {season:'20262027',fetchedAt:new Date(time).toISOString(),games:[]};},
    setTimer:(fn,delay)=>{timer={fn,delay};return 1;},clearTimer:()=>{}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${app.server.address().port}`;
  for(const path of ['/api/fantasy/players','/api/fantasy/leaderboard','/api/fantasy/session'])assert.equal((await fetch(url+path)).status,200);
  assert.equal(calls,0);
  time+=timer.delay;timer.fn();await new Promise(setImmediate);await new Promise(setImmediate);
  assert.equal(calls,1);
  await fetch(url+'/api/fantasy/players');assert.equal(calls,1);
});
