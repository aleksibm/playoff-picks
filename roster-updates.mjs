import { TEAMS } from './dist/game.js';
import { FANTASY_SEASON } from './dist/fantasy-rules.js';

const source='NHL current team rosters and active-player index';
const teamIds=new Set(TEAMS.map(team=>team.id));
const positions=new Set(['C','LW','RW','D','G']);
const indexUrl='https://search.d3.nhle.com/api/v1/search/player?culture=en-us&limit=10000&q=*&active=true';
const validId=id=>Number.isSafeInteger(id)&&id>0;
const validName=name=>typeof name==='string'&&name.trim().length>0&&name.length<=120&&!/[\u0000-\u001f\u007f]/.test(name);
const position=code=>({L:'LW',R:'RW',LW:'LW',RW:'RW',C:'C',D:'D',G:'G'})[code];
const record=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);

/** A full verified pool is required before an update can mark anyone unavailable. */
export function validateRosterSnapshot(snapshot){
  if(!record(snapshot)||snapshot.season!==FANTASY_SEASON||snapshot.source!==source||typeof snapshot.fetchedAt!=='string'||!Number.isFinite(Date.parse(snapshot.fetchedAt))||!Array.isArray(snapshot.players)||snapshot.players.length>10000)throw Error('Invalid NHL roster snapshot.');
  const seen=new Set(),teams=new Set();let active=0;
  for(const player of snapshot.players){
    if(!record(player)||!validId(player.id)||seen.has(player.id)||!validName(player.name)||!positions.has(player.position)||!teamIds.has(player.team)||typeof player.selectable!=='boolean')throw Error('Invalid NHL roster player.');
    seen.add(player.id);if(player.selectable){active++;teams.add(player.team);}
  }
  if(active<480||teams.size!==32)throw Error('Incomplete NHL roster snapshot.');
  return snapshot;
}

async function jsonBody(response,maxBytes){
  if(!response.ok||response.redirected||Number(response.headers.get('content-length'))>maxBytes||!response.body)throw Error('NHL roster source unavailable.');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes)throw Error('Oversized NHL roster source.');chunks.push(value);}
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const requestOptions=redirect=>({signal:AbortSignal.timeout(20000),redirect,headers:{Accept:'application/json','User-Agent':'PlayoffPickFantasy/1.0'}});
async function currentRoster(team,fetchImpl){
  const current=`https://api-web.nhle.com/v1/roster/${team}/current`,expected=`https://api-web.nhle.com/v1/roster/${team}/${FANTASY_SEASON}`;
  const response=await fetchImpl(current,requestOptions('manual'));
  // The current route redirects to the season route. Never follow a different
  // host or season: the fantasy competition has one explicitly configured year.
  if(![301,302,303,307,308].includes(response.status)||new URL(response.headers.get('location')??'',current).href!==expected)throw Error('NHL current roster does not match the fantasy season.');
  const data=await jsonBody(await fetchImpl(expected,requestOptions('error')),128*1024);
  if(!record(data)||!['forwards','defensemen','goalies'].every(role=>Array.isArray(data[role])))throw Error('Invalid NHL team roster.');
  if(data.forwards.length<8||data.defensemen.length<3||data.goalies.length<1)throw Error('Incomplete NHL team roster.');
  const players=[...data.forwards,...data.defensemen,...data.goalies];
  if(players.length<15||players.length>80)throw Error('Incomplete NHL team roster.');
  const seen=new Set();
  return players.map(player=>{
    const name=`${player.firstName?.default??''} ${player.lastName?.default??''}`.trim(),role=position(player.positionCode);
    if(!validId(player.id)||seen.has(player.id)||!validName(name)||!role)throw Error('Invalid NHL team roster player.');
    seen.add(player.id);return {id:player.id,name,position:role,team};
  });
}
async function mapLimit(items,limit,run){
  let next=0;const result=new Array(items.length);
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;result[i]=await run(items[i]);}}));
  return result;
}
async function activeIndex(fetchImpl){
  const rows=await jsonBody(await fetchImpl(indexUrl,requestOptions('error')),4*1024*1024);
  if(!Array.isArray(rows)||rows.length<800||rows.length>=10000)throw Error('Incomplete NHL active-player index.');
  const players=new Map(),seen=new Set(),teams=new Set();
  for(const row of rows){
    const id=Number(row.playerId);
    if(!validId(id)||seen.has(id)||typeof row.active!=='boolean')throw Error('Invalid NHL active-player index.');
    seen.add(id);
    if(!row.active||!teamIds.has(row.teamAbbrev))continue;
    const role=position(row.positionCode);
    if(!validName(row.name)||!role)throw Error('Invalid NHL active-player identity.');
    players.set(id,{id,name:row.name.trim(),position:role,team:row.teamAbbrev});teams.add(row.teamAbbrev);
  }
  if(players.size<800||teams.size!==32)throw Error('Incomplete NHL active-player index.');
  return players;
}

/** New identities need a current NHL roster; known NHL players retain eligibility
 * while the NHL still marks them active and affiliated, including IR/LTIR and
 * temporary minor-league assignments. A failed source never supplies a new pool. */
export async function fetchRosterSnapshot({catalog=null,previous=null,fetchImpl=fetch,now=Date.now()}={}){
  if(previous)validateRosterSnapshot(previous);
  if(catalog&&(catalog.season!==FANTASY_SEASON||!Array.isArray(catalog.players)))throw Error('Invalid base player catalog.');
  if(!Number.isFinite(now))throw Error('Invalid NHL roster update time.');
  const [index,rosters]=await Promise.all([activeIndex(fetchImpl),mapLimit(TEAMS,4,team=>currentRoster(team.id,fetchImpl))]);
  const prior=new Map((previous?.players??[]).map(player=>[player.id,player]));
  const known=new Set([...(catalog?.players??[]).map(player=>player.id),...prior.keys()]);
  const rosterIds=new Set(rosters.flat().map(player=>player.id)),players=new Map();
  if([...rosterIds].filter(id=>index.has(id)).length<rosterIds.size*.98)throw Error('The active-player index does not cover the current NHL rosters.');
  for(const [id,current] of index){
    if(!rosterIds.has(id)&&!known.has(id))continue;
    players.set(id,{...current,position:prior.get(id)?.position??current.position,selectable:true});
  }
  // Previously added rookies remain resolvable after retirement or departure so
  // existing lineups, transfer ledgers, and historical points keep their IDs.
  for(const [id,player] of prior)if(!players.has(id))players.set(id,{id,name:player.name,position:player.position,team:player.team,selectable:false});
  if(previous&&[...players.values()].filter(player=>player.selectable).length<previous.players.filter(player=>player.selectable).length*.8)throw Error('The NHL player pool changed too sharply to verify.');
  return validateRosterSnapshot({season:FANTASY_SEASON,fetchedAt:new Date(now).toISOString(),source,players:[...players.values()].sort((a,b)=>a.id-b.id)});
}

export function mergeRosterCatalog(baseCatalog,snapshot){
  validateRosterSnapshot(snapshot);
  if(!record(baseCatalog)||baseCatalog.season!==FANTASY_SEASON||!Array.isArray(baseCatalog.players))throw Error('Invalid base player catalog.');
  const roster=new Map(snapshot.players.map(player=>[player.id,player])),players=new Map();
  for(const player of baseCatalog.players){
    const current=roster.get(player.id);
    players.set(player.id,{...player,...(current?{name:current.name,team:current.team}:{}),selectable:current?.selectable===true});
  }
  for(const player of snapshot.players)if(!players.has(player.id))players.set(player.id,{...player,price:100000,lastPoints:0,games:0,newcomer:true});
  return {...baseCatalog,note:'Player availability follows current NHL rosters and the NHL active-player index. Previously valued NHL-affiliated players remain available during injuries or temporary assignments. New players start at $100,000; prices update using verified fantasy scoring.',players:[...players.values()].sort((a,b)=>a.id-b.id)};
}
