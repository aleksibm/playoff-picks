import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreGame, playerGameLogs, scoreFantasyHistory, validateFantasySnapshot } from '../fantasy-scoring.mjs';
import { createApp } from '../server.mjs';

const snapshot=games=>({season:'20262027',fetchedAt:'2026-10-24T09:00:00Z',games});
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);
const component=(game,key)=>game.breakdown.find(row=>row.key===key);
const sum=game=>game.breakdown.reduce((total,row)=>total+(row.points??0),0);
function fixture(){
  const id=2026020001;
  const goal=(team,player,assists=[],situationCode='1551')=>({typeDescKey:'goal',periodDescriptor:{periodType:'REG'},situationCode,details:{eventOwnerTeamId:team,scoringPlayerId:player,assist1PlayerId:assists[0],assist2PlayerId:assists[1]}});
  const penalty=(player,duration,typeCode='MIN')=>({typeDescKey:'penalty',details:{committedByPlayerId:player,duration,typeCode}});
  const pbp={id,season:20262027,gameType:2,gameState:'OFF',gameDate:'2026-10-23',startTimeUTC:'2026-10-23T18:00:00Z',homeTeam:{id:1,abbrev:'COL',score:3},awayTeam:{id:2,abbrev:'DAL',score:1},plays:[
    goal(2,8),goal(1,1,[2],'1451'),goal(1,2,[1,6]),goal(1,1,[2]),
    penalty(1,4),penalty(1,5,'MAJ'),penalty(1,10,'MIS'),penalty(2,2),
    {typeDescKey:'penalty',details:{duration:2,typeCode:'BEN',servedByPlayerId:1}},
  ]};
  const row={gameId:id,homeRoad:'H',teamAbbrev:'COL',shots:4,gameWinningGoals:0};
  const skaters=[
    {...row,playerId:1,positionCode:'C',goals:2,assists:1,ppGoals:1,ppPoints:1},
    {...row,playerId:2,positionCode:'D',goals:1,assists:2,ppGoals:0,ppPoints:1,gameWinningGoals:1},
    {...row,playerId:8,homeRoad:'R',teamAbbrev:'DAL',positionCode:'C',goals:1,assists:0,ppGoals:0,ppPoints:0},
  ];
  return {pbp,skaters,goalies:[
    {...row,playerId:6,saves:30,goalsAgainst:1,shotsAgainst:31,shutouts:0},
    {...row,playerId:7,homeRoad:'R',teamAbbrev:'DAL',saves:28,goalsAgainst:3,shotsAgainst:31,shutouts:0},
  ],realtime:new Map(skaters.map(r=>[`${id}:${r.playerId}`,{hits:2,blockedShots:3,takeaways:1}])),
  faceoffs:new Map(skaters.map(r=>[`${id}:${r.playerId}`,{totalFaceoffWins:7,totalFaceoffLosses:4}])),
  model:new Map([[`${id}:6`,{gsax:-.75,goals:1}]])};
}

test('game logs show verified skater counts and exact fractional scoring without double-counting the game winner',()=>{
  const scored=scoreGame(fixture()),feed=snapshot([scored]);validateFantasySnapshot(feed);
  const attacker=playerGameLogs(feed,1)[0],defender=playerGameLogs(feed,2)[0];
  assert.deepEqual(attacker.stats,{goals:2,assists:1,powerPlayGoals:1,powerPlayAssists:0,gameWinningGoals:0,gameWinningPowerPlayGoals:0,teamWin:true,penaltyMinutes:19,minorPenalties:1,majorPenalties:1,misconductPenalties:1,shots:4,hits:2,blocks:3,takeaways:1,faceoffWins:7,faceoffLosses:4,defenseMultiplier:1});
  close(attacker.points,5+10/3+10/3+7-4+2.5+5-5/3-10/3-5);
  close(component(attacker,'powerPlayGoals').points,10/3);
  close(component(attacker,'minorPenalties').points,-5/3);
  close(component(attacker,'majorPenalties').points,-10/3);
  assert.equal(component(attacker,'misconductPenalties').points,-5);
  assert.equal(defender.stats.defenseMultiplier,1.5);
  close(component(defender,'goals').points+component(defender,'gameWinningGoals').points,6.25*1.5);
  close(component(defender,'powerPlayAssists').points,20/9*1.5);
  for(const game of [attacker,defender]){close(sum(game),game.points);assert.equal(new Set(game.breakdown.map(row=>row.key)).size,game.breakdown.length);}
  assert.ok(Array.isArray(scored.details[1].stats));assert.equal(Object.hasOwn(scored.details[1],'breakdown'),false);
});

test('a power-play game-winning goal totals 6.25 before the defense multiplier',()=>{
  const input=fixture();input.pbp.homeTeam.score=1;input.pbp.awayTeam.score=0;input.pbp.plays=input.pbp.plays.slice(1,2);
  input.skaters=[{...input.skaters[0],positionCode:'D',goals:1,assists:0,ppGoals:1,ppPoints:1,gameWinningGoals:1}];input.goalies=[];
  // Remove the assist as this fixture only checks the scorer.
  delete input.pbp.plays[0].details.assist1PlayerId;
  const game=playerGameLogs(snapshot([scoreGame(input)]),1)[0];
  assert.equal(game.stats.gameWinningPowerPlayGoals,1);
  close(component(game,'powerPlayGoals').points+component(game,'gameWinningGoals').points,6.25*1.5);
  close(sum(game),game.points);
});

test('goalie logs retain signed GSAx, offensive points and explicitly pending adjustments',()=>{
  const feed=snapshot([scoreGame(fixture())]);validateFantasySnapshot(feed);
  const verified=playerGameLogs(feed,6)[0],pending=playerGameLogs(feed,7)[0];
  assert.equal(verified.stats.gsax,-.75);assert.equal(verified.stats.saves,30);assert.equal(verified.stats.assists,1);
  assert.equal(component(verified,'gsax').points,-3.75);
  close(verified.points,30*.625-3.75-.75*5+5+10/3);close(sum(verified),verified.points);
  assert.equal(pending.pending,true);assert.equal(pending.stats.gsax,null);
  assert.deepEqual(component(pending,'gsax'),{key:'gsax',label:'Goals saved above expected',value:null,points:null,pending:true});
  close(sum(pending),pending.points);
});

test('shutout save bonus and verified zero-shot appearances are explained accurately',()=>{
  const input=fixture();input.pbp.homeTeam.score=1;input.pbp.awayTeam.score=0;input.pbp.plays=[];input.skaters=[];
  input.goalies=[{...input.goalies[0],saves:32,goalsAgainst:0,shotsAgainst:32,shutouts:1},{...input.goalies[1],saves:0,goalsAgainst:0,shotsAgainst:0,shutouts:0}];
  input.model=new Map([[`${input.pbp.id}:6`,{gsax:2,goals:0}]]);
  const feed=snapshot([scoreGame(input)]);validateFantasySnapshot(feed);
  const shutout=playerGameLogs(feed,6)[0],zero=playerGameLogs(feed,7)[0];
  assert.equal(component(shutout,'saves').points,20);assert.equal(component(shutout,'shutouts').points,10);assert.equal(shutout.points,45);
  assert.equal(zero.pending,false);assert.equal(zero.stats.gsax,0);assert.equal(component(zero,'gsax').points,0);
});

test('counted contribution games expose the same details and legacy caches explicitly have no details',()=>{
  const current=scoreGame(fixture()),legacy=structuredClone(current);delete legacy.details;legacy.id++;
  const feed=snapshot([current,legacy]);validateFantasySnapshot(feed);
  const logs=playerGameLogs(feed,1),result=scoreFantasyHistory([{effectiveAt:'2026-10-22T18:00:00Z',playerIds:[1]}],feed);
  assert.deepEqual(result.playerGames[1],logs);
  assert.equal(logs[0].stats,null);assert.equal(logs[0].breakdown,null);
  assert.equal(logs[1].stats.goals,2);close(sum(logs[1]),logs[1].points);
});

test('snapshot validation rejects malformed, contradictory and forged detail tuples while allowing legacy ledgers',()=>{
  const valid=snapshot([scoreGame(fixture())]);
  const invalid=[
    g=>{g.details=null;},g=>{g.details[1].kind='other';},g=>{g.details[1].stats.pop();},
    g=>{g.details[1].stats[0]=-1;},g=>{g.details[1].stats[0]=.5;},g=>{g.details[1].stats[0]=201;},
    g=>{g.details[1].stats[6]=1;},g=>{g.details[1].stats[17]=2;},g=>{g.details[1].stats[2]=3;},
    g=>{g.details[1].stats[4]=2;},g=>{g.details[1].stats[5]=1;},g=>{g.scores[1]+=1;},
    g=>{g.details[6].stats[15]=NaN;},g=>{g.details[6].stats[15]=101;},g=>{g.details[6].stats[15]=false;},
    g=>{g.details[6].stats[12]=30;},g=>{g.details[6].stats[14]=1;},
    g=>{g.pending=[];},g=>{g.pending.push(1);},g=>{g.pending.push(7);},g=>{g.details[1].breakdown=[];},
    g=>{delete g.details[1];},g=>{g.details[999]=g.details[1];delete g.details[1];},
  ];
  for(const mutate of invalid){const feed=structuredClone(valid);mutate(feed.games[0]);assert.throws(()=>validateFantasySnapshot(feed));}
  const legacy=structuredClone(valid);delete legacy.games[0].details;assert.equal(validateFantasySnapshot(legacy),legacy);
});

test('public and personal APIs return verified details from cache without fetching on read',async t=>{
  const data=snapshot([scoreGame(fixture())]);let calls=0;
  const players=[1,2,3,4,5,6,7,8].map((id,i)=>({id,name:`Player ${id}`,position:i<3?'C':i<5?'D':'G',team:'COL',price:100_000,lastPoints:0,games:1}));
  const app=createApp({dbPath:':memory:',fantasyCatalog:{season:'20262027',usdPerPoint:10_000,players},now:()=>Date.parse('2026-10-23T16:00:00Z'),allowStandingsFetch:false,allowFantasyFetch:false,allowContractFetch:false,fantasyProvider:async()=>{calls++;return data;},setTimer:()=>1,clearTimer:()=>{}});
  t.after(()=>app.close());await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));await app.refreshFantasy();
  const origin=`http://127.0.0.1:${app.server.address().port}`;
  const publicResponse=await fetch(`${origin}/api/fantasy/players/1/games`),body=await publicResponse.json();
  assert.equal(publicResponse.status,200);assert.equal(body.games[0].stats.goals,2);close(sum(body.games[0]),body.games[0].points);
  const registration=await fetch(`${origin}/api/fantasy/register`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'StatDetailFan',password:'test-details-password'})});
  const account=await registration.json(),cookie=registration.headers.get('set-cookie').split(';')[0];
  const submit=await fetch(`${origin}/api/fantasy/submit`,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookie,'X-CSRF-Token':account.csrfToken},body:JSON.stringify({playerIds:[1,2,3,4,5,6],revision:0,priceVersion:account.market.version})});
  const own=await submit.json();assert.equal(submit.status,200);assert.equal(own.score.playerGames[1][0].stats.goals,2);
  assert.deepEqual(own.score.playerGames[1][0].breakdown,body.games[0].breakdown);assert.equal(calls,1);
});
