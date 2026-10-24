import test from 'node:test';
import assert from 'node:assert/strict';
import { TEAMS } from '../dist/game.js';
import { fetchRosterSnapshot, validateRosterSnapshot, mergeRosterCatalog } from '../roster-updates.mjs';

const season='20262027',now=Date.parse('2026-10-22T12:00:00Z');
function fixture(){
  const rosters=new Map(),index=[];
  for(const [teamIndex,team] of TEAMS.entries()){
    const roster={forwards:[],defensemen:[],goalies:[]};
    for(let i=0;i<26;i++){
      const id=teamIndex*26+i+1,code=i<10?['C','L','R'][i%3]:i<14?'D':i===14?'G':'C';
      index.push({playerId:String(id),name:`Player ${id}`,positionCode:code,teamAbbrev:team.id,active:true});
      if(i<15)roster[i<10?'forwards':i<14?'defensemen':'goalies'].push({id,firstName:{default:'Player'},lastName:{default:String(id)},positionCode:code});
    }
    rosters.set(team.id,roster);
  }
  const calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push({url,options});
    if(url.startsWith('https://search.d3.nhle.com/'))return Response.json(index);
    const match=/^https:\/\/api-web\.nhle\.com\/v1\/roster\/([A-Z]{3})\/(current|20262027)$/.exec(url);
    assert.ok(match,`unexpected source ${url}`);
    if(match[2]==='current')return new Response(null,{status:307,headers:{location:`https://api-web.nhle.com/v1/roster/${match[1]}/${season}`}});
    return Response.json(rosters.get(match[1]));
  };
  const catalog={season,usdPerPoint:10000,note:'Rookies without last-season statistics are unavailable.',players:[
    {id:1,name:'Old identity',position:'RW',team:'ANA',price:1234567,lastPoints:123.4567,games:70},
    {id:16,name:'Known injured player',position:'C',team:'BOS',price:500000,lastPoints:50,games:20},
    {id:9000,name:'Retired player',position:'G',team:'COL',price:800000,lastPoints:80,games:25},
  ]};
  return {rosters,index,calls,fetchImpl,catalog};
}

test('complete current rosters add rookies, retain affiliated injured veterans, and exclude unrostered prospects',async()=>{
  const {fetchImpl,catalog,calls}=fixture(),snapshot=await fetchRosterSnapshot({fetchImpl,catalog,now});
  assert.equal(snapshot.players.filter(player=>player.selectable).length,481);
  assert.equal(snapshot.season,season);assert.equal(snapshot.fetchedAt,new Date(now).toISOString());
  assert.equal(snapshot.players.find(player=>player.id===2).position,'LW');
  assert.equal(snapshot.players.find(player=>player.id===3).position,'RW');
  assert.equal(snapshot.players.find(player=>player.id===16).selectable,true,'IR/LTIR or temporary assignment is not retirement');
  assert.equal(snapshot.players.some(player=>player.id===17),false,'never-rostered prospects do not enter the pool');
  assert.equal(snapshot.players.some(player=>player.id===9000),false);
  assert.equal(calls.length,65);assert.equal(calls.filter(call=>call.options.redirect==='manual').length,32);
  assert.ok(calls.every(call=>call.options.signal instanceof AbortSignal));
});

test('catalog merge keeps old prices, roles and history while pricing rookies at 100k',async()=>{
  const {fetchImpl,catalog}=fixture(),snapshot=await fetchRosterSnapshot({fetchImpl,catalog,now});
  const before=structuredClone(catalog),merged=mergeRosterCatalog(catalog,snapshot),byId=new Map(merged.players.map(player=>[player.id,player]));
  assert.deepEqual(catalog,before);
  assert.deepEqual(byId.get(1),{...catalog.players[0],name:'Player 1',team:'BOS',selectable:true});
  assert.deepEqual(byId.get(9000),{...catalog.players[2],selectable:false});
  assert.equal(byId.get(2).price,100000);assert.equal(byId.get(2).lastPoints,0);assert.equal(byId.get(2).games,0);assert.equal(byId.get(2).newcomer,true);
  assert.equal(merged.usdPerPoint,catalog.usdPerPoint);
  assert.match(merged.note,/New players start at \$100,000/);assert.equal(merged.note.includes('unavailable'),false);
});

test('the active index resolves trades and explicitly inactive or unaffiliated players cannot be bought',async()=>{
  const data=fixture();
  data.rosters.get('BOS').forwards.push({id:17,firstName:{default:'Player'},lastName:{default:'17'},positionCode:'C'});
  data.index[0].teamAbbrev='BUF';
  data.index[1].active=false;
  data.index[15].teamAbbrev=null;
  const snapshot=await fetchRosterSnapshot({...data,now});
  const merged=mergeRosterCatalog(data.catalog,snapshot);
  assert.equal(snapshot.players.find(player=>player.id===1).team,'BUF');
  assert.equal(snapshot.players.some(player=>player.id===2),false);
  assert.equal(merged.players.find(player=>player.id===16).selectable,false);
});

test('departed rookie identities are archived across updates and preserve their original fantasy role',async()=>{
  const first=fixture(),previous=await fetchRosterSnapshot({...first,now});
  const next=fixture();next.index[1].active=false;next.index[2].positionCode='D';
  const snapshot=await fetchRosterSnapshot({...next,previous,now:now+1000});
  assert.deepEqual(snapshot.players.find(player=>player.id===2),{...previous.players.find(player=>player.id===2),selectable:false});
  assert.equal(snapshot.players.find(player=>player.id===3).position,'RW');
  const restored=mergeRosterCatalog(next.catalog,JSON.parse(JSON.stringify(snapshot)));
  assert.equal(restored.players.find(player=>player.id===2).name,'Player 2');
  assert.equal(restored.players.find(player=>player.id===2).price,100000);
  assert.equal(restored.players.find(player=>player.id===2).selectable,false);
  assert.deepEqual(previous.players.find(player=>player.id===2).selectable,true);
});

test('a missing team, truncated index or ambiguous identities cannot replace the verified pool',async()=>{
  for(const mutate of [
    data=>data.rosters.get('TOR').forwards.splice(0,10),
    data=>data.index.splice(10),
    data=>data.index.push({...data.index[0]}),
    data=>data.rosters.get('TOR').forwards.push({...data.rosters.get('TOR').forwards[0]}),
  ]){
    const data=fixture();mutate(data);
    await assert.rejects(fetchRosterSnapshot({...data,now}));
  }
  const data=fixture(),snapshot=await fetchRosterSnapshot({...data,now});
  for(const patch of [
    {season:'20252026'},
    {fetchedAt:'invalid'},
    {players:snapshot.players.slice(0,479)},
    {players:snapshot.players.filter(player=>player.team!=='TOR')},
    {players:[...snapshot.players,snapshot.players[0]]},
    {players:snapshot.players.map((player,i)=>i?player:{...player,selectable:'yes'})},
  ])assert.throws(()=>validateRosterSnapshot({...snapshot,...patch}));
});

test('apparently large feeds still require near-complete current roster coverage',async()=>{
  const data=fixture();
  const missing=new Set(TEAMS.slice(0,10).map((team,i)=>i*26+1));
  data.index.splice(0,data.index.length,...data.index.filter(player=>!missing.has(Number(player.playerId))));
  assert.ok(data.index.length>=800);
  await assert.rejects(fetchRosterSnapshot({...data,now}),/cover the current NHL rosters/);
});

test('an update losing more than a fifth of the verified pool is rejected without changing the prior snapshot',async()=>{
  const data=fixture(),previous=await fetchRosterSnapshot({...data,now});
  for(let i=0;i<200;i++)previous.players.push({id:2000+i,name:`Known NHL player ${i}`,position:'C',team:TEAMS[i%32].id,selectable:true});
  const before=structuredClone(previous);
  await assert.rejects(fetchRosterSnapshot({...data,previous,now:now+1000}),/changed too sharply/);
  assert.deepEqual(previous,before);
});

test('roster updates reject unexpected redirects, failed sources, and oversized streamed JSON',async()=>{
  for(const location of ['https://evil.example/roster/BOS/20262027','https://api-web.nhle.com/v1/roster/BOS/20272028']){
    const data=fixture(),baseFetch=data.fetchImpl;
    data.fetchImpl=async(url,options)=>url.endsWith('/BOS/current')?new Response(null,{status:307,headers:{location}}):baseFetch(url,options);
    await assert.rejects(fetchRosterSnapshot({...data,now}),/season/);
  }
  for(const replacement of [
    ()=>new Response('offline',{status:503}),
    ()=>new Response('[]',{headers:{'content-length':String(4*1024*1024+1)}}),
    ()=>new Response(new Uint8Array(4*1024*1024+1)),
  ]){
    const data=fixture(),baseFetch=data.fetchImpl;
    data.fetchImpl=async(url,options)=>url.startsWith('https://search.')?replacement():baseFetch(url,options);
    await assert.rejects(fetchRosterSnapshot({...data,now}));
  }
});
