import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rebalanceFantasyCatalog } from '../fantasy-valuation.mjs';
import { FANTASY_RATES } from '../fantasy-rates.mjs';
import { BUDGET } from '../dist/fantasy-rules.js';
import { initialMarket, updateWeeklyPrices } from '../market-prices.mjs';

const player=(id,points,position='C')=>({id,name:`Player ${id}`,position,team:'COL',price:points*10_000,lastPoints:points,games:82});
const result=(p,breakdown)=>({playerId:p.id,position:p.position,total:p.lastPoints,breakdown});
const catalog=players=>({season:'20262027',usdPerPoint:10_000,budget:BUDGET,players});
const sum=players=>players.reduce((total,p)=>total+p.price,0);

test('a uniform increase in scoring changes the conversion rate rather than inflating player prices',()=>{
  const old=catalog([player(1,100),player(2,200)]);
  const next=rebalanceFantasyCatalog(old,old.players.map(p=>result(p,{goals:p.lastPoints})));
  assert.deepEqual(next.players.map(p=>p.price),old.players.map(p=>p.price));
  assert.deepEqual(next.players.map(p=>p.lastPoints),[180,360]);
  assert.ok(Math.abs(next.usdPerPoint-old.usdPerPoint/1.8)<1e-9);
  assert.equal(next.budget,BUDGET);assert.equal(next.scoringVersion,FANTASY_RATES.version);
  assert.equal(rebalanceFantasyCatalog(next,[]),next);
  assert.deepEqual(old.players.map(p=>p.lastPoints),[100,200]);
});

test('offensive contributions change relative values while the exact dollar pool and price floor are preserved',()=>{
  const old=catalog([player(1,100),player(2,100),player(3,100,'G'),player(4,4)]);
  const rows=old.players.map((p,i)=>result(p,i===0?{goals:100}:i===1?{teamWins:100}:i===2?{saves:100}:{teamWins:4}));
  const next=rebalanceFantasyCatalog(old,rows);
  assert.equal(sum(next.players),3_100_000);
  assert.equal(next.valuation.marketValueUsd,next.valuation.previousMarketValueUsd);
  assert.equal(next.players[3].price,100_000);
  assert.deepEqual(next.players.slice(0,3).map(p=>p.lastPoints),[180,60,100]);
  assert.ok(next.players[0].price>next.players[2].price);
  assert.ok(next.players[2].price>next.players[1].price);
  assert.ok(next.players.every(p=>Number.isSafeInteger(p.price)&&p.price>=100_000));
});

test('historical revaluation rejects mismatched, duplicate and forged source results',()=>{
  const old=catalog([player(1,100)]),row=result(old.players[0],{goals:100});
  for(const rows of [[],[row,row],[{...row,total:101}],[{...row,position:'G'}],[{...row,breakdown:{goals:99}}],[{...row,breakdown:{goals:NaN}}]])assert.throws(()=>rebalanceFantasyCatalog(old,rows));
  assert.throws(()=>rebalanceFantasyCatalog({...old,scoringVersion:'unknown'},[row]));
});

test('recalibrated weekly targets stay at baseline for unchanged performance and reject an old scoring scale',()=>{
  const old=catalog([player(1,100),player(2,200)]);
  const next=rebalanceFantasyCatalog(old,old.players.map(p=>result(p,{goals:p.lastPoints})));
  const market=initialMarket(next),monday=Date.parse('2026-10-19T09:00:00Z');
  const stats={season:next.season,scoringVersion:next.scoringVersion,fetchedAt:new Date(monday).toISOString(),games:Array.from({length:5},(_,i)=>({startTime:`2026-10-${10+i}T18:00:00Z`,pending:[],scores:{1:180/82,2:360/82}}))};
  assert.deepEqual(updateWeeklyPrices(next,market,stats,monday).prices,market.prices);
  assert.equal(updateWeeklyPrices(next,market,{...stats,scoringVersion:'legacy'},monday),market);
  assert.equal(updateWeeklyPrices(next,market,{...stats,scoringVersion:undefined},monday),market);
  const extreme={...stats,games:stats.games.map(g=>({...g,scores:{1:1000,2:-1000}}))};
  const capped=updateWeeklyPrices(next,market,extreme,monday);
  assert.equal(capped.prices[1],market.prices[1]*1.05);
  assert.equal(capped.prices[2],market.prices[2]*.95);
});

test('the shipped revalued catalog preserves the original market size and the $40M game budget',()=>{
  const shipped=JSON.parse(readFileSync(new URL('../fantasy-players.json',import.meta.url)));
  assert.equal(shipped.scoringVersion,FANTASY_RATES.version);
  assert.equal(shipped.budget,BUDGET);
  assert.equal(sum(shipped.players),shipped.valuation.previousMarketValueUsd);
  assert.equal(sum(shipped.players),shipped.valuation.marketValueUsd);
  assert.ok(shipped.usdPerPoint<shipped.valuation.previousUsdPerPoint);
  assert.ok(Math.max(...shipped.players.map(p=>p.price))<BUDGET/2);
  assert.ok(shipped.players.every(p=>Number.isSafeInteger(p.price)&&p.price>=100_000));
});
