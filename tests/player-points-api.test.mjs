import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

const players=Array.from({length:7},(_,i)=>({id:i+1,name:`Player ${i+1}`,position:i<3||i===6?'C':i<5?'D':'G',team:'COL',price:1_000_000,lastPoints:100,games:60}));
const catalog={season:'20262027',usdPerPoint:10000,players};
const lineup=[1,2,3,4,5,6];
const snapshot={season:catalog.season,fetchedAt:'2026-10-22T09:00:00Z',games:[
  {id:2026020001,date:'2026-10-19',startTime:'2026-10-19T18:00:00Z',homeTeam:'COL',awayTeam:'DAL',scores:{1:30,6:20},pending:[],teams:{1:'COL',6:'DAL'}},
  {id:2026020002,date:'2026-10-20',startTime:'2026-10-20T18:00:00Z',homeTeam:'COL',awayTeam:'DAL',scores:{1:10,2:0,6:-2},pending:[6],teams:{1:'COL',2:'COL',6:'DAL'}},
  {id:2026020003,date:'2026-10-21',startTime:'2026-10-21T18:00:00Z',homeTeam:'DAL',awayTeam:'COL',scores:{1:90,7:4,6:2},pending:[],teams:{1:'COL',7:'COL',6:'DAL'}},
]};

async function fixture(t,{data=snapshot}={}){
  let time=Date.parse('2026-10-20T16:00:00Z'),calls=0;
  const app=createApp({dbPath:':memory:',fantasyCatalog:catalog,now:()=>time,allowStandingsFetch:false,allowFantasyFetch:false,allowContractFetch:false,
    ...(data?{fantasyProvider:async()=>{calls++;return data;}}:{}),setTimer:()=>1,clearTimer:()=>{}});
  t.after(()=>app.close());
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  if(data)await app.refreshFantasy();
  const url=`http://127.0.0.1:${app.server.address().port}`;
  async function request(path,{method='GET',body,cookie,csrf}={}){
    const response=await fetch(url+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json',Origin:url}:{}),...(csrf?{'X-CSRF-Token':csrf}:{})},body:body?JSON.stringify(body):undefined});
    return {status:response.status,cookie:response.headers.get('set-cookie')?.split(';')[0],data:await response.json()};
  }
  return {request,setTime:value=>{time=Date.parse(value);},calls:()=>calls};
}

test('public player logs include every appearance in date order without fetching upstream or exposing accounts',async t=>{
  const {request,calls}=await fixture(t),before=calls();
  const result=await request('/api/fantasy/players/1/games');
  assert.equal(result.status,200);assert.equal(result.data.player.name,'Player 1');assert.equal(result.data.seasonPoints,130);
  assert.deepEqual(result.data.games.map(g=>g.gameId),[2026020003,2026020002,2026020001]);
  assert.equal(result.data.games[0].opponent,'DAL');assert.equal(result.data.games[0].homeAway,'away');
  const goalie=await request('/api/fantasy/players/6/games');
  assert.deepEqual(goalie.data.games.map(g=>g.points),[2,-2,20]);assert.equal(goalie.data.games[1].pending,true);
  const zero=await request('/api/fantasy/players/2/games');assert.equal(zero.data.games[0].points,0);
  for(const key of ['user','entry','csrfToken','players','playerGames'])assert.equal(Object.hasOwn(result.data,key),false);
  assert.equal(calls(),before);
  assert.equal((await request('/api/fantasy/players/999/games')).status,404);
  assert.equal((await request('/api/fantasy/players/1.5/games')).status,404);
});

test('personal player contributions and game ledgers respect entry and transfers, and stay in the signed-in session',async t=>{
  const {request,setTime}=await fixture(t);
  const reg=await request('/api/fantasy/register',{method:'POST',body:{username:'PointsFan',password:'points-fantasy-test'}});
  const auth={cookie:reg.cookie,csrf:reg.data.csrfToken};
  const submit=await request('/api/fantasy/submit',{...auth,method:'POST',body:{playerIds:lineup,revision:0,priceVersion:reg.data.market.version}});
  assert.equal(submit.status,200);
  setTime('2026-10-21T17:00:00Z');
  const transfer=await request('/api/fantasy/submit',{...auth,method:'POST',body:{playerIds:[7,2,3,4,5,6],revision:submit.data.entry.revision,priceVersion:submit.data.market.version}});
  assert.equal(transfer.status,200);
  const own=(await request('/api/fantasy/session',auth)).data;
  assert.equal(own.score.points,14);assert.equal(own.score.players[1],10);assert.equal(own.score.players[7],4);
  assert.equal(own.score.pending,true);assert.equal(own.score.playerGames[1].length,1);
  assert.equal(own.score.playerGames[1][0].gameId,2026020002);
  assert.equal(own.score.playerGames[7][0].gameId,2026020003);
  assert.deepEqual(own.score.playerGames[6].map(g=>g.points),[2,-2]);
  assert.equal(Object.values(own.score.players).reduce((a,b)=>a+b,0),own.score.points);
  assert.equal(own.entry.activePlayerIds.includes(1),false);
  const guest=(await request('/api/fantasy/session')).data;assert.deepEqual(guest.score.playerGames,{});assert.deepEqual(guest.score.players,{});
  const other=await request('/api/fantasy/register',{method:'POST',body:{username:'DifferentFan',password:'different-fantasy-test'}});
  assert.deepEqual(other.data.score.playerGames,{});
  const league=(await request('/api/fantasy/leaderboard',auth)).data;assert.equal(Object.hasOwn(league.entries[0],'playerGames'),false);
});

test('player logs distinguish unavailable statistics from a verified season with no appearances',async t=>{
  const unavailable=await fixture(t,{data:null});
  const missing=(await unavailable.request('/api/fantasy/players/1/games')).data;
  assert.equal(missing.seasonPoints,null);assert.equal(missing.scoring.available,false);assert.deepEqual(missing.games,[]);
  const empty=await fixture(t,{data:{season:catalog.season,fetchedAt:snapshot.fetchedAt,games:[]}});
  const noAppearances=(await empty.request('/api/fantasy/players/1/games')).data;
  assert.equal(noAppearances.seasonPoints,0);assert.equal(noAppearances.scoring.available,true);assert.deepEqual(noAppearances.games,[]);
});
