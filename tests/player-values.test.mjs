import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPlayerValues } from '../player-values.mjs';
import { rankValues, filterValues } from '../dist/value-rules.js';
import { contractUpdateWindow, createContractUpdater, parseContractPage } from '../contract-updates.mjs';
import { createApp } from '../server.mjs';

const catalog={season:'20262027',valuationSeason:'2025–26',usdPerPoint:10000,players:[
  {id:1,name:'Big Difference',position:'C',team:'COL',price:10_000_000,lastPoints:1000,games:82},
  {id:2,name:'Cheap Percentage',position:'D',team:'TOR',price:3_000_000,lastPoints:300,games:75},
  {id:3,name:'Below Contract',position:'G',team:'DAL',price:2_000_000,lastPoints:200,games:50},
  {id:4,name:'Unknown Contract',position:'LW',team:'TOR',price:12_000_000,lastPoints:1200,games:82},
]};
const initial={season:'20262027',asOf:'2026-10-18',currency:'USD',source:'PuckPedia',sourceUrl:'https://puckpedia.com/',players:[
  {id:1,team:'COL',capHit:4_000_000,sourceUrl:'https://puckpedia.com/player/big-difference'},
  {id:2,team:'TOR',capHit:850_000,sourceUrl:'https://puckpedia.com/player/cheap-percentage'},
  {id:3,team:'DAL',capHit:5_000_000,sourceUrl:'https://puckpedia.com/player/below-contract'},
]};
test('contract comparison uses the existing fantasy price, signed differences and full precision percentages',()=>{
  const result=buildPlayerValues(catalog,initial);
  assert.deepEqual(result.players.map(p=>p.id),[1,2,3,4]);
  assert.equal(result.players[0].surplus,6_000_000);assert.equal(result.players[0].surplusPercent,150);
  assert.equal(result.players[2].surplus,-3_000_000);assert.equal(result.players[2].surplusPercent,-60);
  assert.equal(result.players[3].capHit,null);assert.equal(result.players[3].surplus,null);assert.equal(result.players[3].surplusPercent,null);
  assert.deepEqual(result.coverage,{matched:3,total:4,missing:1,aboveContract:2});
});
test('dollar and percentage rankings differ, negative differences sort correctly and unknown contracts stay last',()=>{
  const rows=buildPlayerValues(catalog,initial).players;
  assert.deepEqual(rankValues(rows,'percent').map(p=>p.id),[2,1,3,4]);
  assert.deepEqual(rankValues(rows,'lowest').map(p=>p.id),[3,2,1,4]);
  assert.deepEqual(filterValues(rows,{role:'D',team:'TOR'}).map(p=>p.id),[2]);
  assert.equal(filterValues(rows,{query:'unknown'}).length,0);assert.equal(filterValues(rows,{query:'unknown',missing:true}).length,1);
  assert.equal(filterValues([{...rows[0],name:'Néčas'}],{query:'necas'}).length,1);
});
test('duplicate, wrong-season, missing and unsafe contract records fail rather than inventing prices',()=>{
  for(const data of [{...initial,season:'20252026'},{...initial,players:[initial.players[0],initial.players[0]]},{...initial,players:[{...initial.players[0],capHit:0}]},{...initial,players:[{...initial.players[0],sourceUrl:'javascript:alert(1)'}]}])assert.throws(()=>buildPlayerValues(catalog,data));
});
test('shipped salary snapshot has safe NHL identities and includes complete contracts before retained salary',()=>{
  const realCatalog=JSON.parse(readFileSync(new URL('../fantasy-players.json',import.meta.url)));
  const contracts=JSON.parse(readFileSync(new URL('../player-contracts.json',import.meta.url)));
  const result=buildPlayerValues(realCatalog,contracts);
  assert.equal(result.coverage.matched,939);assert.equal(new Set(contracts.players.map(p=>p.team)).size,32);
  const named=name=>result.players.find(p=>p.name===name);
  assert.equal(named('Seth Jones').capHit,9_500_000);assert.equal(named('Erik Karlsson').capHit,11_500_000);assert.equal(named('Tomas Hertl').capHit,8_137_500);
  const petterssons=result.players.filter(p=>p.name==='Elias Pettersson');assert.equal(petterssons.length,2);
  assert.equal(petterssons.find(p=>p.position==='D').capHit,913333);assert.equal(petterssons.find(p=>p.position==='C').capHit,11_600_000);
});
test('salary update dates use Helsinki noon, including 25 October on the autumn DST change',()=>{
  assert.deepEqual(contractUpdateWindow(Date.parse('2026-09-25T08:59:59Z')),{previous:'2025-10-25',next:'2026-09-25'});
  assert.deepEqual(contractUpdateWindow(Date.parse('2026-09-25T09:00:00Z')),{previous:'2026-09-25',next:'2026-10-25'});
  assert.deepEqual(contractUpdateWindow(Date.parse('2026-10-25T09:59:59Z')),{previous:'2026-09-25',next:'2026-10-25'});
  assert.deepEqual(contractUpdateWindow(Date.parse('2026-10-25T10:00:00Z')),{previous:'2026-10-25',next:'2027-09-25'});
  assert.equal(contractUpdateWindow(Date.parse('2027-01-01T00:00:00Z')).next,'2027-09-25');
});
test('salaries refresh once in the scheduled period, persist and catch up after downtime',async()=>{
  let time=Date.parse('2026-10-18T12:00:00Z'),calls=0,saved,timer;
  const opts={catalog,initial,now:()=>time,setTimer:(fn,delay)=>{timer={fn,delay};return 1;},clearTimer:()=>{},save:state=>{saved=structuredClone(state);},run:async()=>{calls++;return {...initial,asOf:'2026-10-25'};}};
  const updater=createContractUpdater(opts);updater.start();await updater.refreshIfDue();assert.equal(calls,0);
  time=Date.parse('2026-10-25T10:00:00Z');await updater.refreshIfDue();await updater.refreshIfDue();assert.equal(calls,1);assert.equal(saved.snapshot.asOf,'2026-10-25');
  await updater.stop();time=Date.parse('2026-11-10T10:00:00Z');
  const restarted=createContractUpdater({...opts,initial:saved.snapshot,state:saved});restarted.start();await restarted.refreshIfDue();assert.equal(calls,1);await restarted.stop();
  const missed=createContractUpdater({...opts,run:async()=>{calls++;return {...initial,asOf:'2026-11-10'};}});missed.start();await missed.refreshIfDue();assert.equal(calls,2);await missed.stop();
});
test('a blocked salary source retains the verified snapshot and does not retry on every day or restart',async()=>{
  let time=Date.parse('2026-10-25T10:00:00Z'),calls=0,saved;
  const opts={catalog,initial,now:()=>time,setTimer:()=>1,clearTimer:()=>{},save:s=>{saved=structuredClone(s);},run:async()=>{calls++;throw Error('Source blocked');}};
  const updater=createContractUpdater(opts);updater.start();await updater.refreshIfDue();time+=86400000;await updater.refreshIfDue();assert.equal(calls,1);assert.equal(updater.getSnapshot(),initial);assert.match(updater.metadata().error,/last verified/);await updater.stop();
  const restarted=createContractUpdater({...opts,initial:saved.snapshot,state:saved});restarted.start();await restarted.refreshIfDue();assert.equal(calls,1);await restarted.stop();
});
function table(section,rows){return `<div id="capby_${section}"></div><table class="pp_table-roster"><thead><tr><th>Player</th><th>2026-27</th><th>2027-28</th></tr></thead><tbody>${rows}</tbody></table>`;}
test('contract parser reads the current season cap hit, not bonus-inclusive AAV, future deals or buyouts',()=>{
  const row=(id,cap)=>`<tr><td><a href="/player/test-${id}">Test</a></td><td data-js="capcol" data-ch="$${cap}" data-aav="$5,000,000"><span>$${cap}</span></td><td data-ch="$20,000,000"></td></tr>`;
  const source=['forwards','defence','goaltenders'].map((s,i)=>table(s,Array.from({length:5},(_,j)=>row(i*5+j,'850,000')).join(''))).join('')+table('buyout',row(999,'8,000,000'));
  const rows=parseContractPage(source,'20262027');assert.equal(rows.length,15);assert.equal(rows[0].cap,850000);assert.equal(rows.some(r=>r.url.endsWith('999')),false);
  assert.throws(()=>parseContractPage(source,'20252026'));assert.throws(()=>parseContractPage('<title>Just a moment...</title>','20262027'));
});
test('value page is public, does not reveal accounts and API reads never trigger contract refreshes',async t=>{
  let calls=0;
  const app=createApp({dbPath:':memory:',allowStandingsFetch:false,allowFantasyFetch:false,fantasyCatalog:catalog,contracts:initial,now:()=>Date.parse('2026-10-18T12:00:00Z'),contractProvider:async()=>{calls++;return initial;}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());const base=`http://127.0.0.1:${app.server.address().port}`;
  for(const path of ['/fantasy/value','/player-value.css','/player-value.js','/value-rules.js'])assert.equal((await fetch(base+path)).status,200);
  const response=await fetch(base+'/api/fantasy/value');assert.equal(response.status,200);const body=await response.json();assert.equal(body.players[0].surplus,6_000_000);assert.equal(body.coverage.matched,3);assert.equal(Object.hasOwn(body,'user'),false);assert.equal(calls,0);
  assert.equal((await fetch(base+'/player-contracts.json')).status,404);assert.equal((await fetch(base+'/contract-updates.mjs')).status,404);
});
