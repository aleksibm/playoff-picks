import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { FANTASY_SEASON } from './dist/fantasy-rules.js';

const SEASON=Number(FANTASY_SEASON);
const record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const count=(x,label)=>{if(!Number.isSafeInteger(x)||x<0)throw new Error(`Invalid fantasy feed: ${label}`);return x;};
const n=(x)=>x??0;
const key=r=>`${r.gameId}:${r.playerId}`;
const index=rows=>new Map(rows.map(r=>[key(r),r]));
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
export function scoreGame({pbp,skaters,goalies,realtime,faceoffs,model}) {
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
  const penalties=new Map(),offense=new Map();
  const add=(map,id,value)=>map.set(id,(map.get(id)??0)+value);
  for(const p of pbp.plays)if(p.typeDescKey==='penalty')add(penalties,p.details.committedByPlayerId,penaltyScore(p.details));
  for(const p of goals){
    const pp=goalIsPP(p),d=p.details;
    add(offense,d.scoringPlayerId,p===gw?6.25:pp?10/3:5);
    for(const aid of [d.assist1PlayerId,d.assist2PlayerId])if(aid)add(offense,aid,pp?20/9:10/3);
  }
  const scores={},pending=[],teams={};
  for(const r of skaters){
    const rt=realtime.get(key(r)),fo=faceoffs.get(key(r));
    if(!rt||!fo)throw new Error('Incomplete skater game reports.');
    const ppg=count(r.ppGoals,'power-play goals'),ppa=count(r.ppPoints,'power-play points')-ppg;
    if(ppa<0||ppa>r.assists||ppg>r.goals)throw new Error('Invalid power-play scoring.');
    let attack=(count(r.goals,'goals')-ppg)*5+ppg*10/3+(count(r.assists,'assists')-ppa)*10/3+ppa*20/9;
    if(r.gameWinningGoals){
      if(gwPlayer!==r.playerId)throw new Error('Game-winning goal reports disagree.');
      attack+=6.25-(goalIsPP(gw)?10/3:5);
    }
    if(Math.abs(attack-(offense.get(r.playerId)??0))>1e-7)throw new Error(`Goal event and official reports disagree: game ${pbp.id}, ${r.skaterFullName}, report ${attack}, events ${offense.get(r.playerId)??0}.`);
    const mult=r.positionCode==='D'?1.5:1;
    const peripherals=(count(r.shots,'shots')+count(rt.hits,'hits')+count(rt.blockedShots,'blocks')+count(rt.takeaways,'takeaways'))*.25;
    const win=(r.homeRoad==='H')===homeWon?5:0;
    scores[r.playerId]=attack*mult+count(fo.totalFaceoffWins,'faceoff wins')-count(fo.totalFaceoffLosses,'faceoff losses')+peripherals+win+(penalties.get(r.playerId)??0);
    teams[r.playerId]=r.teamAbbrev;
  }
  for(const r of goalies){
    const gsax=model.get(key(r));
    if(gsax&&gsax.goals!==r.goalsAgainst)throw new Error('NHL and MoneyPuck goalie goals disagree.');
    // No model contribution is required for a genuine zero-shot appearance.
    if(!gsax&&r.shotsAgainst>0)pending.push(r.playerId);
    const saves=count(r.saves,'saves')*.625*(r.shutouts?1.5:1);
    const win=(r.homeRoad==='H')===homeWon?5:0;
    scores[r.playerId]=saves-count(r.goalsAgainst,'goals conceded')*3.75+(gsax?.gsax??0)*5+win+(offense.get(r.playerId)??0)+(penalties.get(r.playerId)??0);
    teams[r.playerId]=r.teamAbbrev;
  }
  return {id:pbp.id,startTime:pbp.startTimeUTC,date:pbp.gameDate,scores,pending,teams};
}

export function validateFantasySnapshot(snapshot) {
  if(!record(snapshot)||snapshot.season!==FANTASY_SEASON||!Number.isFinite(Date.parse(snapshot.fetchedAt))||!Array.isArray(snapshot.games)||snapshot.games.length>1312)throw new Error('Invalid fantasy snapshot.');
  const seen=new Set();
  for(const g of snapshot.games){
    if(!Number.isSafeInteger(g.id)||!String(g.id).startsWith('202602')||seen.has(g.id)||!Number.isFinite(Date.parse(g.startTime))||!record(g.scores)||!Array.isArray(g.pending)||!record(g.teams))throw new Error('Invalid fantasy game ledger.');
    seen.add(g.id);
    if(Object.values(g.scores).some(x=>!Number.isFinite(x)||Math.abs(x)>1000))throw new Error('Invalid fantasy score.');
    if(g.pending.some(id=>!Number.isSafeInteger(id)||!Object.hasOwn(g.scores,id)))throw new Error('Invalid pending score.');
  }
  return snapshot;
}

export function scoreFantasyHistory(history,snapshot) {
  if(!snapshot)return {points:null,pending:false,players:{}};
  const sorted=history.map(h=>({...h,at:Date.parse(h.effectiveAt)})).sort((a,b)=>a.at-b.at);
  const players={};let total=0,pending=false;
  for(const g of snapshot.games){
    const startedAt=Date.parse(g.startTime);
    let lineup=null;
    for(const h of sorted){if(h.at>startedAt)break;lineup=h;}
    if(!lineup)continue;
    for(const id of lineup.playerIds){const value=g.scores[id]??0;total+=value;players[id]=(players[id]??0)+value;if(g.pending.includes(id))pending=true;}
  }
  return {points:total,pending,players};
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
    if(!pbp){
      pbp=JSON.parse((await bytes(`https://api-web.nhle.com/v1/gamecenter/${id}/play-by-play`,2*1024*1024)).toString('utf8'));
      if(path&&['OFF','FINAL'].includes(pbp.gameState)){const temp=`${path}.tmp`;writeFileSync(temp,JSON.stringify(pbp),{mode:0o600});renameSync(temp,path);}
    }
    if(!sk.has(id)||!gl.has(id))throw new Error('Missing fantasy game appearances.');
    return scoreGame({pbp,skaters:sk.get(id),goalies:gl.get(id),realtime:rt,faceoffs:fo,model});
  });
  return validateFantasySnapshot({season:FANTASY_SEASON,fetchedAt:new Date(now).toISOString(),games,modelError});
}
