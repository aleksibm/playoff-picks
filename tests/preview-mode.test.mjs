import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { FANTASY_RATES } from '../fantasy-rates.mjs';
import { priceHistoryCutoff } from '../fantasy-price-history.mjs';
import { initialMarket, previousPriceUpdate } from '../market-prices.mjs';

const now=Date.parse('2026-10-26T12:00:00Z');
const catalog={season:'20262027',usdPerPoint:10000,players:[{id:1,name:'Preview skater',position:'C',team:'COL',price:1_000_000,lastPoints:100,games:82}]};
const snapshot={season:catalog.season,fetchedAt:new Date(now).toISOString(),games:Array.from({length:5},(_,i)=>({id:2026020001+i,startTime:`2026-10-${20+i}T18:00:00Z`,scores:{1:30},pending:[],teams:{1:'COL'}}))};

async function start(t,previewData){
  const app=createApp({dbPath:':memory:',fantasyCatalog:catalog,now:()=>now,previewData,
    allowStandingsFetch:false,allowFantasyFetch:false,allowRosterFetch:false,allowContractFetch:false,
    priceHistorySnapshot:{season:catalog.season,scoringVersion:FANTASY_RATES.version,fetchedAt:new Date(now).toISOString(),from:new Date(priceHistoryCutoff(previousPriceUpdate(now))).toISOString(),playerIds:[1],
      games:Array.from({length:95},(_,i)=>({id:2025020001+i,startTime:new Date(Date.UTC(2026,0,1+i)).toISOString(),scores:{1:100/82},pending:[],teams:{}}))},
    fantasyProvider:async()=>snapshot,setTimer:()=>1,clearTimer:()=>{}});
  t.after(()=>app.close());
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  await app.refreshFantasy();
  const url=`http://127.0.0.1:${app.server.address().port}`;
  return path=>fetch(url+path).then(response=>response.json());
}

test('local preview metadata labels synthetic scores and keeps them from changing market prices',async t=>{
  const get=await start(t,true),players=await get('/api/fantasy/players');
  assert.equal(players.scoring.demo,true);assert.equal(players.scoring.available,true);
  assert.equal(players.players[0].price,catalog.players[0].price);
  assert.equal(players.market.version,initialMarket(catalog).version);
  assert.equal((await get('/api/fantasy/weekly-players?week=month')).scoring.demo,true);
  assert.equal((await get('/api/fantasy/players/1/games')).scoring.demo,true);
});

test('normal verified scoring still updates weekly prices and does not advertise demo data',async t=>{
  const get=await start(t,false),players=await get('/api/fantasy/players');
  assert.equal(players.scoring.demo,undefined);
  assert.equal(players.players[0].price,1_050_000);
  assert.notEqual(players.market.version,initialMarket(catalog).version);
});

test('test-data mode cannot be enabled for a public production origin',()=>{
  assert.throws(()=>createApp({dbPath:':memory:',publicOrigin:'https://picks.example',previewData:true}),/only available in local previews/);
});
