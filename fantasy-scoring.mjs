import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { FANTASY_SEASON } from './dist/fantasy-rules.js';
import { FANTASY_RATES, LEGACY_FANTASY_RATES } from './fantasy-rates.mjs';

const SEASON=Number(FANTASY_SEASON);
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const count=(x,label)=>{if(!Number.isSafeInteger(x)||x<0)throw new Error(`Invalid fantasy feed: ${label}`);return x;};
const n=(x)=>x??0;
const key=r=>`${r.gameId}:${r.playerId}`;
const index=rows=>new Map(rows.map(r=>[key(r),r]));
// Compact tuples keep a full-season ledger comfortably inside the cache limit.
// Human-readable stat names and score explanations are expanded only for logs.
const commonStats=['goals','assists','powerPlayGoals','powerPlayAssists','gameWinningGoals','gameWinningPowerPlayGoals','teamWin','penaltyMinutes','minorPenalties','majorPenalties','misconductPenalties'];
const detailFields={skater:[...commonStats,'shots','hits','blocks','takeaways','faceoffWins','faceoffLosses','defenseMultiplier'],goalie:[...commonStats,'saves','shotsAgainst','goalsAgainst','shutouts','gsax']};
function packedDetails(kind,stats){return {kind,stats:detailFields[kind].map(field=>stats[field])};}
function expandedDetails(detail,rates=FANTASY_RATES){
  if(!detail)return {stats:null,breakdown:null};
  const stats=Object.fromEntries(detailFields[detail.kind].map((field,i)=>[field,detail.stats[i]])),breakdown=[];
  const add=(key,label,value,points)=>breakdown.push({key,label,value,points});
  const mult=detail.kind==='skater'?stats.defenseMultiplier:1;
  add('goals','Goals outside power play',stats.goals-stats.powerPlayGoals,(stats.goals-stats.powerPlayGoals)*rates.goal*mult);
  add('powerPlayGoals','Power-play goals',stats.powerPlayGoals,stats.powerPlayGoals*rates.powerPlayGoal*mult);
  add('assists','Assists outside power play',stats.assists-stats.powerPlayAssists,(stats.assists-stats.powerPlayAssists)*rates.assist*mult);
  add('powerPlayAssists','Power-play assists',stats.powerPlayAssists,stats.powerPlayAssists*rates.powerPlayAssist*mult);
  add('gameWinningGoals','Game-winning goal bonus',stats.gameWinningGoals,(stats.gameWinningGoals*(rates.gameWinningGoal-rates.goal)+stats.gameWinningPowerPlayGoals*(rates.goal-rates.powerPlayGoal))*mult);
  if(detail.kind==='skater'){
    for(const [key,label] of [['shots','Shots'],['hits','Hits'],['blocks','Blocked shots'],['takeaways','Takeaways']])add(key,label,stats[key],stats[key]*.25);
    add('faceoffWins','Faceoffs won',stats.faceoffWins,stats.faceoffWins*rates.faceoff);
    add('faceoffLosses','Faceoffs lost',stats.faceoffLosses,-stats.faceoffLosses*rates.faceoff);
  }else{
    add('saves','Saves',stats.saves,stats.saves*.625);
    add('shutouts','Shutout save bonus',stats.shutouts,stats.shutouts?stats.saves*.625*.5:0);
    add('goalsAgainst','Goals conceded',stats.goalsAgainst,-stats.goalsAgainst*3.75);
    if(stats.gsax===null)breakdown.push({key:'gsax',label:'Goals saved above expected',value:null,points:null,pending:true});
    else add('gsax','Goals saved above expected',stats.gsax,stats.gsax*5);
  }
  add('teamWin','Team win',stats.teamWin?1:0,stats.teamWin?(detail.kind==='goalie'?rates.goalieWin:rates.skaterWin):0);
  add('minorPenalties','Minor / double-minor penalties',stats.minorPenalties,-stats.minorPenalties*5/3);
  add('majorPenalties','Major penalties',stats.majorPenalties,-stats.majorPenalties*10/3);
  add('misconductPenalties','Misconduct / match penalties',stats.misconductPenalties,-stats.misconductPenalties*5);
  return {stats,breakdown};
}
export function powerPlay(play,homeId) {
  if(!/^\d{4}$/.test(play.situationCode))throw new Error('Missing manpower information.');
  const [ag,as,hs,hg]=[...play.situationCode].map(Number);
  return play.details.eventOwnerTeamId===homeId?hs+hg>as+ag:as+ag>hs+hg;
}
export function penaltyScore(details) {
  const {duration,typeCode}=details;
  if(!details.committedByPlayerId)return 0;
  if(['MIS','GAM','MAT'].includes(typeCode)||duration>=10)return -5;
  if(duration===0)return 0;
  if(duration===5)return -10/3;
  if(duration===2||duration===4)return -5/3;
  throw new Error('Unsupported penalty duration.');
}
export function parseCsv(text) {
  const rows=[];let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
    else if(c===','&&!quoted){row.push(field);field='';}
    else if(c==='\n'&&!quoted){row.push(field.replace(/\r$/,''));if(row.some(Boolean))rows.push(row);row=[];field='';}
    else field+=c;
  }
  if(quoted)throw new Error('Invalid CSV quotes.');
  if(field||row.length){row.push(field.replace(/\r$/,''));rows.push(row);}
  const header=rows.shift();if(!header)return [];
  return rows.map(r=>{if(r.length!==header.length)throw new Error('Invalid CSV row.');return Object.fromEntries(header.map((h,i)=>[h,r[i]]));});
}
export function unzipCsv(buffer) {
  // Read the central directory: no extraction or filesystem paths from ZIP.
  let end=-1;
  for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--)if(buffer.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0)throw new Error('Invalid goalie ZIP.');
  let at=buffer.readUInt32LE(end+16);
  const files=buffer.readUInt16LE(end+10);
  if(files<1||files>10)throw new Error('Unexpected goalie ZIP entries.');
  for(let i=0;i<files;i++){
    if(at+46>buffer.length||buffer.readUInt32LE(at)!==0x02014b50)throw new Error('Invalid ZIP directory.');
    const method=buffer.readUInt16LE(at+10),size=buffer.readUInt32LE(at+20),expanded=buffer.readUInt32LE(at+24);
    const nameSize=buffer.readUInt16LE(at+28),extra=buffer.readUInt16LE(at+30),comment=buffer.readUInt16LE(at+32),offset=buffer.readUInt32LE(at+42);
    const name=buffer.toString('utf8',at+46,at+46+nameSize);at+=46+nameSize+extra+comment;
    if(!name.endsWith('.csv'))continue;
    if(expanded>25*1024*1024||offset+30>buffer.length||buffer.readUInt32LE(offset)!==0x04034b50)throw new Error('Invalid goalie ZIP size.');
    const begin=offset+30+buffer.readUInt16LE(offset+26)+buffer.readUInt16LE(offset+28);
    if(begin+size>buffer.length)throw new Error('Truncated goalie ZIP.');
    const compressed=buffer.subarray(begin,begin+size);
    const body=method===0?compressed:method===8?inflateRawSync(compressed,{maxOutputLength:25*1024*1024}):null;
    if(!body||body.length!==expanded)throw new Error('Unsupported goalie ZIP.');
    return body.toString('utf8').replace(/^\uFEFF/,'');
  }
  throw new Error('Goalie CSV not found.');
}
export function goalieModel(rows) {
  const map=new Map();
  for(const row of rows){
    if(row.situation!=='all')continue;
    if(Number(row.season)!==2026)throw new Error('Wrong MoneyPuck season.');
    const id=Number(row.playerId),gameId=Number(row.gameId),x=Number(row.xGoals),goals=Number(row.goals);
    if(!Number.isSafeInteger(id)||!String(gameId).startsWith('202602')||!Number.isFinite(x)||x<0||!Number.isFinite(goals)||goals<0)throw new Error('Invalid goalie model row.');
    if(map.has(`${gameId}:${id}`))throw new Error('Duplicate goalie model row.');
    map.set(`${gameId}:${id}`,{gsax:x-goals,goals});
  }
  return map;
}

/** Score one completed game using official appearance/stat rows and event types. */
export function scoreGame({pbp,skaters,goalies,realtime,faceoffs,model},rates=FANTASY_RATES) {
  if(pbp.season!==SEASON||pbp.gameType!==2||!['FINAL','OFF'].includes(pbp.gameState)||!Number.isFinite(Date.parse(pbp.startTimeUTC)))throw new Error('Fantasy game is not a completed 2026–27 regular-season game.');
  const home=pbp.homeTeam,away=pbp.awayTeam;
  if(home.score===away.score)throw new Error('No game winner.');
  const winner=home.score>away.score?home.id:away.id;
  const homeWon=winner===home.id;
  const goals=pbp.plays.filter(p=>p.typeDescKey==='goal'&&p.periodDescriptor.periodType!=='SO');
  const winnerGoals=goals.filter(p=>p.details.eventOwnerTeamId===winner);
  const gw=winnerGoals[Math.min(home.score,away.score)]??null;
  const gwPlayer=gw?.details.scoringPlayerId;
  const scoringRows=new Map(skaters.map(r=>[r.playerId,r]));
  function goalIsPP(play){
    const row=scoringRows.get(play.details.scoringPlayerId);
    // Some live event feeds contain placeholder manpower codes (e.g. 1010).
    // Official per-game totals determine strength whenever all that scorer's
    // goals have the same classification; only mixed games need event splits.
    if(row?.ppGoals===0)return false;
    if(row&&row.ppGoals===row.goals)return true;
    return powerPlay(play,home.id);
  }
  const penalties=new Map(),offense=new Map(),events=new Map();
  const add=(map,id,value)=>map.set(id,(map.get(id)??0)+value);
  function eventStats(id){
    if(!events.has(id))events.set(id,Object.fromEntries(commonStats.map(field=>[field,0])));
    return events.get(id);
  }
  for(const p of pbp.plays)if(p.typeDescKey==='penalty'){
    const d=p.details,value=penaltyScore(d);add(penalties,d.committedByPlayerId,value);
    if(d.committedByPlayerId){
      const stats=eventStats(d.committedByPlayerId);stats.penaltyMinutes+=count(d.duration,'penalty minutes');
      if(value===-5)stats.misconductPenalties++;
      else if(value===-10/3)stats.majorPenalties++;
      else if(value===-5/3)stats.minorPenalties++;
    }
  }
  for(const p of goals){
    const pp=goalIsPP(p),d=p.details;
    add(offense,d.scoringPlayerId,p===gw?rates.gameWinningGoal:pp?rates.powerPlayGoal:rates.goal);
    const scorer=eventStats(d.scoringPlayerId);scorer.goals++;if(pp)scorer.powerPlayGoals++;
    if(p===gw){scorer.gameWinningGoals++;if(pp)scorer.gameWinningPowerPlayGoals++;}
    for(const aid of [d.assist1PlayerId,d.assist2PlayerId])if(aid){
      add(offense,aid,pp?rates.powerPlayAssist:rates.assist);const assistant=eventStats(aid);assistant.assists++;if(pp)assistant.powerPlayAssists++;
    }
  }
  const scores={},pending=[],teams={},details={};
  for(const r of skaters){
    const rt=realtime.get(key(r)),fo=faceoffs.get(key(r));
    if(!rt||!fo)throw new Error('Incomplete skater game reports.');
    const ppg=count(r.ppGoals,'power-play goals'),ppa=count(r.ppPoints,'power-play points')-ppg;
    if(ppa<0||ppa>r.assists||ppg>r.goals)throw new Error('Invalid power-play scoring.');
    let attack=(count(r.goals,'goals')-ppg)*rates.goal+ppg*rates.powerPlayGoal+(count(r.assists,'assists')-ppa)*rates.assist+ppa*rates.powerPlayAssist;
    if(r.gameWinningGoals){
      if(gwPlayer!==r.playerId)throw new Error('Game-winning goal reports disagree.');
      attack+=rates.gameWinningGoal-(goalIsPP(gw)?rates.powerPlayGoal:rates.goal);
    }
    if(Math.abs(attack-(offense.get(r.playerId)??0))>1e-7)throw new Error(`Goal event and official reports disagree: game ${pbp.id}, ${r.skaterFullName}, report ${attack}, events ${offense.get(r.playerId)??0}.`);
    const mult=r.positionCode==='D'?1.5:1;
    const peripherals=(count(r.shots,'shots')+count(rt.hits,'hits')+count(rt.blockedShots,'blocks')+count(rt.takeaways,'takeaways'))*.25;
    const win=(r.homeRoad==='H')===homeWon?rates.skaterWin:0;
    scores[r.playerId]=attack*mult+(count(fo.totalFaceoffWins,'faceoff wins')-count(fo.totalFaceoffLosses,'faceoff losses'))*rates.faceoff+peripherals+win+(penalties.get(r.playerId)??0);
    teams[r.playerId]=r.teamAbbrev;
    details[r.playerId]=packedDetails('skater',{...eventStats(r.playerId),goals:r.goals,assists:r.assists,powerPlayGoals:ppg,powerPlayAssists:ppa,
      gameWinningGoals:r.gameWinningGoals??0,teamWin:win>0,shots:r.shots,hits:rt.hits,blocks:rt.blockedShots,takeaways:rt.takeaways,
      faceoffWins:fo.totalFaceoffWins,faceoffLosses:fo.totalFaceoffLosses,defenseMultiplier:mult});
  }
  for(const r of goalies){
    const gsax=model.get(key(r));
    if(gsax&&gsax.goals!==r.goalsAgainst)throw new Error('NHL and MoneyPuck goalie goals disagree.');
    // No model contribution is required for a genuine zero-shot appearance.
    if(!gsax&&r.shotsAgainst>0)pending.push(r.playerId);
    const saves=count(r.saves,'saves')*.625*(r.shutouts?1.5:1);
    const win=(r.homeRoad==='H')===homeWon?rates.goalieWin:0;
    scores[r.playerId]=saves-count(r.goalsAgainst,'goals conceded')*3.75+(gsax?.gsax??0)*5+win+(offense.get(r.playerId)??0)+(penalties.get(r.playerId)??0);
    teams[r.playerId]=r.teamAbbrev;
    details[r.playerId]=packedDetails('goalie',{...eventStats(r.playerId),teamWin:win>0,saves:r.saves,shotsAgainst:r.shotsAgainst,
      goalsAgainst:r.goalsAgainst,shutouts:r.shutouts??0,gsax:gsax?.gsax??(r.shotsAgainst===0?0:null)});
  }
  return {id:pbp.id,startTime:pbp.startTimeUTC,date:pbp.gameDate,homeTeam:home.abbrev??null,awayTeam:away.abbrev??null,scores,pending,teams,details};
}

export function validateFantasySnapshot(snapshot,rates=FANTASY_RATES) {
  if(!record(snapshot)||snapshot.season!==FANTASY_SEASON||!Number.isFinite(Date.parse(snapshot.fetchedAt))||!Array.isArray(snapshot.games)||snapshot.games.length>1312)throw new Error('Invalid fantasy snapshot.');
  if(snapshot.scoringVersion!==undefined&&snapshot.scoringVersion!==rates.version)throw new Error('Incompatible fantasy scoring version.');
  const seen=new Set();
  for(const g of snapshot.games){
    if(!Number.isSafeInteger(g.id)||!String(g.id).startsWith('202602')||seen.has(g.id)||!Number.isFinite(Date.parse(g.startTime))||!record(g.scores)||!Array.isArray(g.pending)||!record(g.teams))throw new Error('Invalid fantasy game ledger.');
    seen.add(g.id);
    if(Object.values(g.scores).some(x=>!Number.isFinite(x)||Math.abs(x)>1000))throw new Error('Invalid fantasy score.');
    if(g.pending.some(id=>!Number.isSafeInteger(id)||!Object.hasOwn(g.scores,id)))throw new Error('Invalid pending score.');
    if([g.homeTeam,g.awayTeam].some(team=>team!=null&&(typeof team!=='string'||!/^[A-Z]{2,4}$/.test(team))))throw new Error('Invalid fantasy matchup.');
    if(Object.hasOwn(g,'details')){
      if(!record(g.details)||Object.keys(g.details).length!==Object.keys(g.scores).length||Object.keys(g.details).length>80||new Set(g.pending).size!==g.pending.length)throw new Error('Invalid fantasy game details.');
      for(const [id,detail] of Object.entries(g.details)){
        if(!/^[1-9]\d*$/.test(id)||!Number.isSafeInteger(Number(id))||!Object.hasOwn(g.scores,id)||!record(detail)||Object.keys(detail).length!==2||!Object.hasOwn(detail,'kind')||!Object.hasOwn(detail,'stats')||!Object.hasOwn(detailFields,detail.kind)||!Array.isArray(detail.stats)||detail.stats.length!==detailFields[detail.kind].length)throw new Error('Invalid fantasy player details.');
        const {stats,breakdown}=expandedDetails(detail,rates);
        for(const [field,value] of Object.entries(stats)){
          if(field==='teamWin'){if(typeof value!=='boolean')throw new Error('Invalid fantasy win detail.');}
          else if(field==='defenseMultiplier'){if(value!==1&&value!==1.5)throw new Error('Invalid fantasy defense multiplier.');}
          else if(field==='gsax'){if(value!==null&&(!Number.isFinite(value)||Math.abs(value)>100))throw new Error('Invalid fantasy GSAx detail.');}
          else if(!Number.isSafeInteger(value)||value<0||value>200)throw new Error('Invalid fantasy stat count.');
        }
        if(stats.powerPlayGoals>stats.goals||stats.powerPlayAssists>stats.assists||stats.gameWinningGoals>1||stats.gameWinningGoals>stats.goals||stats.gameWinningPowerPlayGoals>stats.gameWinningGoals||stats.gameWinningPowerPlayGoals>stats.powerPlayGoals)throw new Error('Inconsistent fantasy scoring details.');
        const isPending=detail.kind==='goalie'&&stats.gsax===null;
        if(isPending!==g.pending.includes(Number(id)))throw new Error('Inconsistent fantasy provisional details.');
        // NHL reports can disagree on shots versus saves + goals against, even
        // across both official feeds. Keep the published scoring counts rather
        // than rejecting every game's update or deriving saves from shots.
        if(detail.kind==='goalie'&&(stats.saves>stats.shotsAgainst||stats.shutouts>1||(stats.shutouts&&stats.goalsAgainst!==0)||(isPending&&stats.shotsAgainst===0)))throw new Error('Inconsistent fantasy goalie details.');
        const total=breakdown.reduce((sum,component)=>sum+(component.points??0),0);
        if(!Number.isFinite(total)||Math.abs(total-g.scores[id])>1e-7)throw new Error('Fantasy score details do not add up.');
      }
    }
  }
  return snapshot;
}

/** Re-score verified old detail tuples without downloading or discarding data. */
export function upgradeFantasySnapshot(snapshot){
  if(snapshot?.scoringVersion===FANTASY_RATES.version)return validateFantasySnapshot(snapshot);
  validateFantasySnapshot(snapshot,LEGACY_FANTASY_RATES);
  if(snapshot.games.some(game=>!game.details&&Object.keys(game.scores).length))throw new Error('Legacy fantasy scores need a verified statistics refresh.');
  const games=snapshot.games.map(game=>({...game,scores:Object.fromEntries(Object.entries(game.details??{}).map(([id,detail])=>
    [id,expandedDetails(detail).breakdown.reduce((total,part)=>total+(part.points??0),0)]))}));
  return validateFantasySnapshot({...snapshot,scoringVersion:FANTASY_RATES.version,games});
}

function playerGame(g,id){
  const team=g.teams?.[id]??null;
  const homeAway=team&&team===g.homeTeam?'home':team&&team===g.awayTeam?'away':null;
  const opponents=[...new Set(Object.values(g.teams??{}))].filter(value=>value!==team);
  const opponent=homeAway==='home'?g.awayTeam:homeAway==='away'?g.homeTeam:team&&opponents.length===1?opponents[0]:null;
  return {gameId:g.id,startTime:g.startTime,date:g.date??g.startTime.slice(0,10),team,opponent:opponent??null,homeAway,
    points:g.scores[id],pending:g.pending.includes(id),...expandedDetails(g.details?.[id])};
}

/** All completed appearances, regardless of whether a manager owned the player. */
export function playerGameLogs(snapshot,playerId){
  if(!snapshot)return [];
  return snapshot.games.filter(g=>Object.hasOwn(g.scores,playerId)).map(g=>playerGame(g,playerId))
    .sort((a,b)=>Date.parse(b.startTime)-Date.parse(a.startTime)||b.gameId-a.gameId);
}

export function scoreFantasyHistory(history,snapshot,{includeGameLogs=true}={}) {
  if(!snapshot)return {points:null,pending:false,players:{},playerGames:{}};
  const sorted=history.map(h=>({...h,at:Date.parse(h.effectiveAt)})).sort((a,b)=>a.at-b.at);
  const players={},playerGames={};let total=0,pending=false;
  for(const g of snapshot.games){
    const startedAt=Date.parse(g.startTime);
    let lineup=null;
    for(const h of sorted){if(h.at>startedAt)break;lineup=h;}
    if(!lineup)continue;
    for(const id of lineup.playerIds){
      const value=g.scores[id]??0;total+=value;players[id]=(players[id]??0)+value;if(g.pending.includes(id))pending=true;
      if(includeGameLogs&&Object.hasOwn(g.scores,id))(playerGames[id]??=[]).push(playerGame(g,id));
    }
  }
  for(const games of Object.values(playerGames))games.sort((a,b)=>Date.parse(b.startTime)-Date.parse(a.startTime)||b.gameId-a.gameId);
  return {points:total,pending,players,playerGames};
}

const weekTimeZone='Europe/Helsinki';
const weekClock=new Intl.DateTimeFormat('en-GB',{timeZone:weekTimeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function weekDateParts(time){
  return Object.fromEntries(weekClock.formatToParts(time).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));
}
function helsinkiMidnight(calendar){
  const target=calendar.getTime();let candidate=target;
  // Calendar-period midnights are unambiguous in Helsinki, but the UTC offset
  // can differ at the end of a period containing a daylight-saving change.
  for(let attempt=0;attempt<3;attempt++){
    const p=weekDateParts(candidate),local=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);
    const corrected=candidate+target-local;
    if(corrected===candidate)return candidate;
    candidate=corrected;
  }
  return candidate;
}
export function fantasyWeek(now=Date.now(),key='current'){
  if(!['current','previous'].includes(key)||!Number.isFinite(now))throw new RangeError('Invalid fantasy week.');
  const p=weekDateParts(now),calendar=new Date(Date.UTC(p.year,p.month-1,p.day));
  calendar.setUTCDate(calendar.getUTCDate()-(calendar.getUTCDay()+6)%7-(key==='previous'?7:0));
  const start=helsinkiMidnight(calendar);
  calendar.setUTCDate(calendar.getUTCDate()+7);
  return {key,start:new Date(start).toISOString(),end:new Date(helsinkiMidnight(calendar)).toISOString(),timeZone:weekTimeZone};
}

export function fantasyPeriod(now=Date.now(),key='current'){
  if(key==='current'||key==='previous')return fantasyWeek(now,key);
  if(!['month','year'].includes(key)||!Number.isFinite(now))throw new RangeError('Invalid fantasy ranking period.');
  const p=weekDateParts(now),calendar=new Date(Date.UTC(p.year,key==='month'?p.month-1:0,1));
  return {key,start:new Date(helsinkiMidnight(calendar)).toISOString(),end:new Date(now).toISOString(),timeZone:weekTimeZone};
}

/** Period totals use only selectable players and completed cached appearances. */
export function weeklyTopPlayers(catalog,snapshot,{week='current',now=Date.now()}={}){
  const bounds=fantasyPeriod(now,week),start=Date.parse(bounds.start),end=Date.parse(bounds.end);
  if(!snapshot||snapshot.season!==catalog.season)return {week:bounds,players:[]};
  const selectable=new Map(catalog.players.filter(player=>player.selectable!==false).map(player=>[player.id,player])),totals=new Map();
  const games=snapshot.games.filter(game=>{const time=Date.parse(game.startTime);return time>=start&&time<end;})
    .sort((a,b)=>Date.parse(a.startTime)-Date.parse(b.startTime)||a.id-b.id);
  for(const game of games){
    const pending=new Set(game.pending);
    for(const [key,points] of Object.entries(game.scores)){
      const id=Number(key),player=selectable.get(id);if(!player)continue;
      if(!totals.has(id))totals.set(id,{id,name:player.name,position:player.position,team:player.team,points:0,games:0,pending:false});
      const total=totals.get(id);total.points+=points;total.games++;total.pending=total.pending||pending.has(id);total.team=game.teams[id]??total.team;
    }
  }
  const players=[...totals.values()].sort((a,b)=>b.points-a.points||a.id-b.id).slice(0,10);
  let rank=0;players.forEach((player,index)=>{if(index===0||Math.abs(player.points-players[index-1].points)>1e-7)rank=index+1;player.rank=rank;});
  return {week:bounds,players};
}

async function mapLimit(items,limit,fn){
  let next=0;const results=new Array(items.length);
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;results[i]=await fn(items[i],i);}}));
  return results;
}

export async function fetchFantasySnapshot({fetchImpl=fetch,now=Date.now(),cacheDir=null}={}) {
  async function bytes(url,max=30*1024*1024){
    let response;
    for(let attempt=0;attempt<3;attempt++){
      try{response=await fetchImpl(url,{signal:AbortSignal.timeout(30_000),headers:{'User-Agent':'PlayoffPickFantasy/1.0'}});if(response.ok)break;if(response.status<500&&response.status!==429)break;}
      catch(error){if(attempt===2)throw new Error(`Fantasy feed timed out: ${new URL(url).pathname}`,{cause:error});}
      if(attempt<2)await new Promise(resolve=>setTimeout(resolve,(attempt+1)*700));
    }
    if(!response)throw new Error('Fantasy statistics provider is unavailable.');
    if(!response.ok)throw new Error('Fantasy statistics provider is unavailable.');
    if(Number(response.headers.get('content-length'))>max)throw new Error('Oversized fantasy statistics feed.');
    const chunks=[];let length=0;
    for await(const chunk of response.body){length+=chunk.length;if(length>max){await response.body.cancel().catch(()=>{});throw new Error('Oversized fantasy statistics feed.');}chunks.push(chunk);}
    return Buffer.concat(chunks);
  }
  async function report(kind,name,extra=''){
    const q=new URLSearchParams({isAggregate:'false',isGame:'true',start:'0',limit:'-1',cayenneExp:`seasonId=${SEASON} and gameTypeId=2${extra?' and '+extra:''}`});
    const obj=JSON.parse((await bytes(`https://api.nhle.com/stats/rest/en/${kind}/${name}?${q}`)).toString('utf8'));
    if(!Array.isArray(obj.data)||obj.data.length!==obj.total||obj.data.some(r=>!String(r.gameId).startsWith('202602')))throw new Error('Incomplete fantasy statistics report.');
    return obj.data;
  }
  const teamRows=await report('team','summary');
  if(!teamRows.length)throw new Error('2026–27 fantasy statistics are not available yet.');
  const ids=[...new Set(teamRows.map(r=>r.gameId))].sort();
  const dates=[...new Set(teamRows.map(r=>r.gameDate.slice(0,7)))];
  const specs=[['skater','summary'],['skater','realtime'],['skater','faceoffwins'],['goalie','summary']];
  const reports=await mapLimit(specs,4,async([kind,name])=>(await mapLimit(dates,2,async month=>{
    const next=new Date(`${month}-01T00:00:00Z`);next.setUTCMonth(next.getUTCMonth()+1);
    return report(kind,name,`gameDate>="${month}-01" and gameDate<"${next.toISOString().slice(0,10)}"`);
  })).flat());
  const [skaters,realtime,faceoffs,goalies]=reports;
  const rt=index(realtime),fo=index(faceoffs);
  let model=new Map(),modelError=null;
  try{model=goalieModel(parseCsv(unzipCsv(await bytes('https://peter-tanner.com/moneypuck/downloads/seasonPlayersSummary/goalies/2026.zip',8*1024*1024))));}
  catch{modelError='Goals saved above expected are awaiting MoneyPuck data. Scores marked provisional exclude the pending adjustment.';}
  const groups=rows=>{const m=new Map();for(const r of rows){if(!m.has(r.gameId))m.set(r.gameId,[]);m.get(r.gameId).push(r);}return m;};
  const sk=groups(skaters),gl=groups(goalies);
  if(cacheDir)mkdirSync(cacheDir,{recursive:true,mode:0o700});
  const games=await mapLimit(ids,4,async id=>{
    const path=cacheDir?join(cacheDir,`${id}.json`):null;
    let pbp=null;
    if(path&&existsSync(path)){
      try{const saved=JSON.parse(readFileSync(path,'utf8'));if(now-Date.parse(saved.gameDate)>7*86400000)pbp=saved;}catch{/* Replace a corrupt event cache. */}
    }
    if(!sk.has(id)||!gl.has(id))throw new Error('Missing fantasy game appearances.');
    const score=()=>scoreGame({pbp,skaters:sk.get(id),goalies:gl.get(id),realtime:rt,faceoffs:fo,model});
    if(pbp){
      try{return score();}
      catch{/* Official stat corrections can outlive the seven-day event cache. */}
    }
    pbp=JSON.parse((await bytes(`https://api-web.nhle.com/v1/gamecenter/${id}/play-by-play`,2*1024*1024)).toString('utf8'));
    const game=score();
    if(path){const temp=`${path}.tmp`;writeFileSync(temp,JSON.stringify(pbp),{mode:0o600});renameSync(temp,path);}
    return game;
  });
  return validateFantasySnapshot({season:FANTASY_SEASON,scoringVersion:FANTASY_RATES.version,fetchedAt:new Date(now).toISOString(),games,modelError});
}
