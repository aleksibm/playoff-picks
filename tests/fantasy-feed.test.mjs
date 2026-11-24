import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchFantasySnapshot, playerGameLogs } from '../fantasy-scoring.mjs';

function fixture(t,{corrected=true}={}){
  const cacheDir=mkdtempSync(join(tmpdir(),'fantasy-events-'));
  t.after(()=>rmSync(cacheDir,{recursive:true,force:true}));
  const id=2026020001,now=Date.parse('2026-10-26T10:00:00Z');
  const pbp={id,season:20262027,gameType:2,gameState:'OFF',gameDate:'2026-10-01',startTimeUTC:'2026-10-01T18:00:00Z',homeTeam:{id:1,abbrev:'COL',score:1},awayTeam:{id:2,abbrev:'DAL',score:0},plays:[
    {typeDescKey:'goal',periodDescriptor:{periodType:'REG'},situationCode:'1551',details:{eventOwnerTeamId:1,scoringPlayerId:1}},
  ]};
  const path=join(cacheDir,`${id}.json`);
  writeFileSync(path,JSON.stringify(pbp));
  const current=structuredClone(pbp);
  if(corrected)current.plays[0].details.assist1PlayerId=2;
  const row={gameId:id,gameDate:pbp.gameDate,homeRoad:'H',teamAbbrev:'COL'};
  const reports={
    'team/summary':[{...row}],
    'skater/summary':[
      {...row,playerId:1,positionCode:'C',goals:1,assists:0,ppGoals:0,ppPoints:0,gameWinningGoals:1,shots:1},
      {...row,playerId:2,positionCode:'D',goals:0,assists:1,ppGoals:0,ppPoints:0,gameWinningGoals:0,shots:0},
    ],
    'skater/realtime':[1,2].map(playerId=>({...row,playerId,hits:0,blockedShots:0,takeaways:0})),
    'skater/faceoffwins':[1,2].map(playerId=>({...row,playerId,totalFaceoffWins:0,totalFaceoffLosses:0})),
    'goalie/summary':[{...row,playerId:6,saves:1,goalsAgainst:0,shotsAgainst:1,shutouts:1}],
  };
  let eventReads=0;
  const fetchImpl=async url=>{
    const {pathname}=new URL(url);
    if(pathname.endsWith('/play-by-play')){eventReads++;return Response.json(current);}
    if(pathname.endsWith('.zip'))return new Response(null,{status:404});
    const data=reports[pathname.replace('/stats/rest/en/','')];
    assert.ok(data,`Unexpected feed: ${url}`);
    return Response.json({data,total:data.length});
  };
  return {cacheDir,now,path,pbp,current,fetchImpl,eventReads:()=>eventReads};
}

test('an official assist correction refreshes an old cached game and keeps the corrected points',async t=>{
  const f=fixture(t);
  const snapshot=await fetchFantasySnapshot(f);
  assert.equal(f.eventReads(),1);
  assert.equal(snapshot.games.length,1);
  assert.equal(playerGameLogs(snapshot,2)[0].stats.assists,1);
  assert.equal(snapshot.games[0].scores[2],12);
  assert.deepEqual(JSON.parse(readFileSync(f.path,'utf8')),f.current);
  const again=await fetchFantasySnapshot(f);
  assert.equal(f.eventReads(),1);
  assert.deepEqual(again.games,snapshot.games);
});

test('a disagreement in fresh events still rejects the refresh and preserves the old cache',async t=>{
  const f=fixture(t,{corrected:false});
  await assert.rejects(fetchFantasySnapshot(f),/Goal event and official reports disagree/);
  assert.equal(f.eventReads(),1);
  assert.deepEqual(JSON.parse(readFileSync(f.path,'utf8')),f.pbp);
});

test('MoneyPuck failures retain private HTTP diagnostics without serializing them into public scores',async t=>{
  const snapshot=await fetchFantasySnapshot(fixture(t));
  assert.match(snapshot.modelFailureReason.message,/HTTP 404/);
  assert.match(snapshot.modelFailureReason.message,/2026.zip/);
  assert.match(snapshot.modelError,/provisional/);
  assert.ok(!JSON.stringify(snapshot).includes('modelFailureReason'));
  assert.ok(!JSON.stringify(snapshot).includes('HTTP 404'));
});


test('historical feeds use their own season and select actual player windows with the current scoring rules',async t=>{
  const f=fixture(t),requests=[];
  const fetchImpl=async url=>{
    requests.push(String(url));
    const response=await f.fetchImpl(url);if(!response.ok)return response;
    const body=await response.json();
    if(String(url).endsWith('/play-by-play'))return Response.json({...body,id:2025020001,season:20252026,gameDate:'2025-10-01',startTimeUTC:'2025-10-01T18:00:00Z'});
    return Response.json({...body,data:body.data.map(row=>({...row,gameId:2025020001,gameDate:'2025-10-01'}))});
  };
  const result=await fetchFantasySnapshot({fetchImpl,now:f.now,season:'20252026',since:Date.parse('2023-10-26T10:00:00Z'),playerWindows:new Map([[2,1]])});
  assert.equal(result.season,'20252026');assert.equal(result.games[0].id,2025020001);
  assert.deepEqual(Object.keys(result.games[0].scores),['2']);assert.equal(result.games[0].scores[2],12);
  assert.deepEqual(result.games[0].pending,[]);
  assert.ok(requests.some(url=>url.includes('/2025.zip')));
  const query=new URL(requests.find(url=>url.includes('/team/summary'))).searchParams;
  assert.match(query.get('cayenneExp'),/seasonId=20252026/);assert.match(query.get('cayenneExp'),/gameDate>="2023-10-26"/);
  assert.equal(query.get('limit'),'-1');
});
