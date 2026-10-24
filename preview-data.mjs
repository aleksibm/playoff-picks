// Synthetic fixtures for the localhost preview only. Never use as an NHL feed.
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { createAccountStore } from './accounts.mjs';
import { FANTASY_SEASON, BUDGET, playerRole, validateRoster } from './dist/fantasy-rules.js';
import { scoreGame, validateFantasySnapshot } from './fantasy-scoring.mjs';

const HOUR=60*60*1000,DAY=24*HOUR;
const demoNames=['Demo_North','Demo_Rivals','Demo_Ice'];

/** Three distinct, affordable 3F/2D/1G lineups using real market identities. */
export function previewRosters(catalog){
  const available=catalog.players.filter(player=>player.selectable!==false);
  const pools=Object.fromEntries(['F','D','G'].map(role=>[role,available.filter(player=>playerRole(player)===role&&player.price<=BUDGET/7)
    .sort((a,b)=>b.price-a.price||a.id-b.id)]));
  const sizes={F:3,D:2,G:1};
  return demoNames.map((username,team)=>{
    const ids=['F','D','G'].flatMap(role=>{
      if(pools[role].length<sizes[role]*demoNames.length)throw new Error('The preview needs more affordable players.');
      return pools[role].slice(team*sizes[role],(team+1)*sizes[role]).map(player=>player.id);
    });
    validateRoster(ids,catalog.players,true);
    return {username,playerIds:ids};
  });
}

/** Add demo managers without changing existing accounts, sessions or lineups. */
export async function seedPreviewAccounts({directory,catalog,now=Date.now()}){
  const path=resolve(directory);
  if(basename(path)!=='fantasy-preview'||basename(dirname(path))!=='.local-data')throw new Error('Preview seeding is restricted to .local-data/fantasy-preview.');
  const store=createAccountStore(join(path,'accounts.sqlite'),{fantasyPlayers:catalog.players,now:()=>now-40*DAY});
  try{
    const users=new Set(store.listAccounts().map(user=>user.username.toLowerCase()));
    for(const demo of previewRosters(catalog)){
      // An existing name belongs to the local user; never rewrite it.
      if(users.has(demo.username.toLowerCase()))continue;
      const session=await store.register(demo.username,randomBytes(24).toString('base64url'));
      store.submitFantasy(session.user.id,demo.playerIds,0);
      store.logout(session.token);
    }
    return [...new Set(store.listFantasySubmitted().flatMap(user=>store.getFantasy(user.id).activePlayerIds))];
  }finally{store.close();}
}

function syntheticGame(players,{id,startTime,round,homeTeam,awayTeam}){
  const home={id:1,abbrev:homeTeam,score:3},away={id:2,abbrev:awayTeam,score:2};
  const skaters=players.filter(player=>playerRole(player)!=='G').map(player=>({
    gameId:id,playerId:player.id,skaterFullName:player.name,positionCode:player.position,teamAbbrev:player.team,
    homeRoad:player.team===homeTeam?'H':'R',goals:0,assists:0,ppGoals:0,ppPoints:0,gameWinningGoals:0,
    shots:2+(player.id+round)%5,
  }));
  const plays=[],realtime=new Map(),faceoffs=new Map(),model=new Map();
  const byId=new Map(skaters.map(row=>[row.playerId,row]));
  for(const [side,team] of [[home,homeTeam],[away,awayTeam]]){
    const teammates=skaters.filter(row=>row.teamAbbrev===team);
    for(let index=0;index<side.score;index++){
      const scorer=teammates[(index+round)%Math.max(1,teammates.length)];
      const assister=teammates.length>1?teammates[(index+round+1)%teammates.length]:null;
      const pp=index===0;
      const details={eventOwnerTeamId:side.id,scoringPlayerId:scorer?.playerId??9_000_000+side.id};
      if(assister)details.assist1PlayerId=assister.playerId;
      plays.push({typeDescKey:'goal',periodDescriptor:{periodType:'REG'},situationCode:pp?(side.id===1?'1451':'1541'):'1551',details});
      if(scorer){scorer.goals++;if(pp){scorer.ppGoals++;scorer.ppPoints++;}if(side.id===1&&index===2)scorer.gameWinningGoals=1;}
      if(assister){assister.assists++;if(pp)assister.ppPoints++;}
    }
  }
  for(const player of players){
    const key=`${id}:${player.id}`;
    if(byId.has(player.id)){
      realtime.set(key,{gameId:id,playerId:player.id,hits:(player.id+round)%4,blockedShots:playerRole(player)==='D'?3:1,takeaways:1});
      faceoffs.set(key,{gameId:id,playerId:player.id,totalFaceoffWins:player.position==='C'?8+round:0,totalFaceoffLosses:player.position==='C'?5:0});
      if((player.id+round)%4===0)plays.push({typeDescKey:'penalty',details:{committedByPlayerId:player.id,eventOwnerTeamId:player.team===homeTeam?1:2,duration:2,typeCode:'MIN'}});
    }
  }
  const goalies=players.filter(player=>playerRole(player)==='G').map(player=>{
    const goalsAgainst=player.team===homeTeam?2:3,shotsAgainst=28+(player.id+round)%9;
    if((player.id+round)%3!==0)model.set(`${id}:${player.id}`,{gsax:2.75-goalsAgainst+(round%2)*.5,goals:goalsAgainst});
    return {gameId:id,playerId:player.id,teamAbbrev:player.team,homeRoad:player.team===homeTeam?'H':'R',shotsAgainst,saves:shotsAgainst-goalsAgainst,goalsAgainst,shutouts:0};
  });
  const game=scoreGame({pbp:{id,season:Number(FANTASY_SEASON),gameType:2,gameState:'OFF',startTimeUTC:startTime,gameDate:startTime.slice(0,10),homeTeam:home,awayTeam:away,plays},skaters,goalies,realtime,faceoffs,model});
  return {...game,demo:true};
}

/** Deterministic completed synthetic games relative to the preview's clock. */
export function createPreviewSnapshot(catalog,{playerIds=[],now=Date.now()}={}){
  if(!Number.isFinite(now))throw new Error('Invalid preview clock.');
  const ids=new Set([...playerIds,...previewRosters(catalog).flatMap(team=>team.playerIds)]);
  const players=catalog.players.filter(player=>ids.has(player.id));
  const teams=[...new Set(players.map(player=>player.team))].sort();
  if(teams.length%2)teams.push(['BOS','COL','NYR','DAL','EDM','TOR','OTT','FLA','VGK','TBL','WSH','CAR','BUF','DET','MIN','CHI','STL','NSH','VAN','SEA','CGY','ANA','LAK','SJS','NYI','NJD','PHI','PIT','MTL','WPG','CBJ','UTA'].find(team=>!teams.includes(team)));
  const games=[];
  for(const [round,age] of [4*HOUR,28*HOUR,52*HOUR,8*DAY,16*DAY].entries()){
    const startTime=new Date(now-age).toISOString();
    for(let team=0;team<teams.length;team+=2){
      const homeTeam=teams[team],awayTeam=teams[team+1];
      games.push(syntheticGame(players.filter(player=>player.team===homeTeam||player.team===awayTeam),{
        id:2026020001+round*40+team/2,startTime,round,homeTeam,awayTeam,
      }));
    }
  }
  return validateFantasySnapshot({season:FANTASY_SEASON,fetchedAt:new Date(now).toISOString(),demo:true,
    source:'Synthetic localhost preview data. Not actual NHL results.',games});
}
