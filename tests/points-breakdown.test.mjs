import test from 'node:test';
import assert from 'node:assert/strict';
import { playerGameLogs, scoreFantasyHistory, scoreGame, validateFantasySnapshot } from '../fantasy-scoring.mjs';

const game=(id,startTime,scores,extra={})=>({id,startTime,date:startTime.slice(0,10),scores,pending:[],teams:{1:'COL',7:'DAL'},...extra});
const snapshot=games=>({season:'20262027',fetchedAt:'2026-10-22T09:00:00Z',games});

test('earned breakdown includes former players and preserves entry and transfer eligibility',()=>{
  const feed=snapshot([
    game(2026020003,'2026-10-11T20:00:00Z',{1:80,7:0},{pending:[7]}),
    game(2026020001,'2026-10-10T18:00:00Z',{1:100,7:100}),
    game(2026020004,'2026-10-12T20:00:00Z',{1:90,7:20/9}),
    game(2026020002,'2026-10-10T20:00:00Z',{1:-5/3,7:90}),
  ]);
  const history=[{effectiveAt:'2026-10-10T20:30:00Z',playerIds:[7]},{effectiveAt:'2026-10-10T19:00:00Z',playerIds:[1]}];
  const result=scoreFantasyHistory(history,feed);
  assert.equal(result.players[1],-5/3);assert.equal(result.players[7],20/9);
  assert.equal(result.points,-5/3+20/9);assert.equal(result.pending,true);
  assert.deepEqual(result.playerGames[1].map(g=>g.gameId),[2026020002]);
  assert.deepEqual(result.playerGames[7].map(g=>g.gameId),[2026020004,2026020003]);
  assert.equal(result.playerGames[7][1].points,0);assert.equal(result.playerGames[7][1].pending,true);
  for(const [id,games] of Object.entries(result.playerGames))assert.equal(games.reduce((sum,g)=>sum+g.points,0),result.players[id]);
});

test('a zero-point appearance is listed but an absent player does not get a fabricated game',()=>{
  const feed=snapshot([game(2026020001,'2026-10-10T20:00:00Z',{1:0}),game(2026020002,'2026-10-11T20:00:00Z',{7:5})]);
  const result=scoreFantasyHistory([{effectiveAt:'2026-10-09T20:00:00Z',playerIds:[1]}],feed);
  assert.equal(result.points,0);assert.equal(result.players[1],0);
  assert.equal(result.playerGames[1].length,1);assert.equal(result.playerGames[1][0].points,0);
  assert.deepEqual(playerGameLogs(feed,999),[]);
});

test('all-player game logs include unowned games, negative and fractional points without changing the feed',()=>{
  const feed=snapshot([game(2026020001,'2026-10-10T20:00:00Z',{1:20/9}),game(2026020002,'2026-10-11T20:00:00Z',{1:-5/3},{pending:[1]})]);
  const original=JSON.stringify(feed),logs=playerGameLogs(feed,1);
  assert.deepEqual(logs.map(g=>g.gameId),[2026020002,2026020001]);
  assert.deepEqual(logs.map(g=>g.points),[-5/3,20/9]);assert.equal(logs[0].pending,true);
  assert.equal(scoreFantasyHistory([],feed).points,0);assert.deepEqual(scoreFantasyHistory([],feed).playerGames,{});
  assert.equal(JSON.stringify(feed),original);
});

test('game logs identify home and away matchups and fall back safely for older score caches',()=>{
  const current=game(2026020001,'2026-10-10T20:00:00Z',{1:5,7:3},{homeTeam:'COL',awayTeam:'DAL'});
  const home=playerGameLogs(snapshot([current]),1)[0],away=playerGameLogs(snapshot([current]),7)[0];
  assert.equal(home.team,'COL');assert.equal(home.opponent,'DAL');assert.equal(home.homeAway,'home');
  assert.equal(away.opponent,'COL');assert.equal(away.homeAway,'away');
  const older=playerGameLogs(snapshot([game(2026020001,'2026-10-10T20:00:00Z',{1:5})]),1)[0];
  assert.equal(older.opponent,'DAL');assert.equal(older.homeAway,null);
  const partial=playerGameLogs(snapshot([game(2026020001,'2026-10-10T20:00:00Z',{1:5},{teams:{1:'COL'}})]),1)[0];
  assert.equal(partial.opponent,null);assert.equal(partial.homeAway,null);
});

test('breakdown respects the exact game starting instant, including fractional transfer timestamps',()=>{
  const feed=snapshot([game(2026020001,'2026-10-10T20:00:00Z',{1:8,7:99})]);
  const result=scoreFantasyHistory([{effectiveAt:'2026-10-10T19:00:00Z',playerIds:[1]},{effectiveAt:'2026-10-10T20:00:00.500Z',playerIds:[7]}],feed);
  assert.equal(result.playerGames[1][0].points,8);assert.equal(result.playerGames[7],undefined);
  assert.deepEqual(scoreFantasyHistory([{effectiveAt:'2026-10-10T20:00:00.500Z',playerIds:[7]}],feed).playerGames,{});
  assert.equal(scoreFantasyHistory([{effectiveAt:'2026-10-10T20:00:00Z',playerIds:[7]}],feed).playerGames[7][0].points,99);
});

test('unavailable statistics remain unavailable rather than showing a fabricated zero',()=>{
  assert.deepEqual(scoreFantasyHistory([],null),{points:null,pending:false,players:{},playerGames:{}});
  assert.deepEqual(playerGameLogs(null,1),[]);
});

test('compact scoring preserves totals and provisional state without constructing player game logs',()=>{
  const feed=snapshot([game(2026020001,'2026-10-10T20:00:00Z',{1:20/9},{pending:[1]})]);
  const history=[{effectiveAt:'2026-10-09T20:00:00Z',playerIds:[1]}];
  const full=scoreFantasyHistory(history,feed),compact=scoreFantasyHistory(history,feed,{includeGameLogs:false});
  assert.equal(compact.points,full.points);assert.equal(compact.pending,full.pending);assert.deepEqual(compact.players,full.players);
  assert.deepEqual(compact.playerGames,{});assert.equal(full.playerGames[1].length,1);
});

test('new game ledgers retain matchup abbreviations and old caches remain valid',()=>{
  const pbp={id:2026020001,season:20262027,gameType:2,gameState:'OFF',gameDate:'2026-10-10',startTimeUTC:'2026-10-10T20:00:00Z',homeTeam:{id:2,abbrev:'COL',score:1},awayTeam:{id:1,abbrev:'DAL',score:0},plays:[]};
  const scored=scoreGame({pbp,skaters:[],goalies:[],realtime:new Map(),faceoffs:new Map(),model:new Map()});
  assert.equal(scored.homeTeam,'COL');assert.equal(scored.awayTeam,'DAL');
  assert.equal(validateFantasySnapshot(snapshot([scored])).games[0],scored);
  const older=snapshot([game(2026020001,'2026-10-10T20:00:00Z',{1:5})]);
  assert.equal(validateFantasySnapshot(older),older);
  assert.throws(()=>validateFantasySnapshot(snapshot([{...scored,homeTeam:'<script>'}])));
});
