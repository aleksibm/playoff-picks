import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyMinimumPrice, priceVersion, initialMarket, updateWeeklyPrices, validateMarket, playerPriceChange, previousPriceUpdate, nextPriceUpdate } from '../market-prices.mjs';
import { createAccountStore } from '../accounts.mjs';
import { createApp } from '../server.mjs';
const players=[
  {id:1,name:'Rising Center',position:'C',team:'COL',price:12_000_000,lastPoints:1200,games:82},
  {id:2,name:'Wing',position:'RW',team:'TBL',price:12_000_000,lastPoints:1200,games:82},
  {id:3,name:'Cheap Wing',position:'LW',team:'DAL',price:1_000_000,lastPoints:100,games:80},
  {id:4,name:'Defense One',position:'D',team:'COL',price:4_000_000,lastPoints:400,games:82},
  {id:5,name:'Defense Two',position:'D',team:'TOR',price:4_000_000,lastPoints:400,games:82},
  {id:6,name:'Goalie',position:'G',team:'DAL',price:4_000_000,lastPoints:400,games:55},
  {id:7,name:'Replacement',position:'C',team:'EDM',price:18_000_000,lastPoints:1800,games:82},
];
const catalog={season:'20262027',usdPerPoint:10000,players};
const lineup=[1,2,3,4,5,6];
const monday=Date.parse('2026-10-19T09:00:00Z');
function stats(scores,pending=[]){return {season:'20262027',fetchedAt:new Date(monday).toISOString(),games:Array.from({length:5},(_,i)=>({startTime:`2026-10-${String(10+i).padStart(2,'0')}T20:00:00Z`,scores,pending}))};}

test('new and verified existing markets floor player prices at $100,000 and invalidate old quotes',()=>{
  const cheapCatalog={...catalog,players:players.map(p=>({...p,price:p.id===3?40_000:p.price}))};
  const initial=initialMarket(cheapCatalog);
  assert.equal(initial.prices[3],100_000);
  const snapshot={...initial,prices:{...initial.prices,3:40_000}};
  snapshot.version=priceVersion(snapshot);
  const migrated=applyMinimumPrice(validateMarket(cheapCatalog,snapshot));
  assert.equal(migrated.prices[3],100_000);assert.equal(migrated.prices[1],snapshot.prices[1]);
  assert.equal(migrated.asOf,snapshot.asOf);assert.notEqual(migrated.version,snapshot.version);
  assert.equal(validateMarket(cheapCatalog,migrated),migrated);assert.equal(applyMinimumPrice(migrated),migrated);
  assert.equal(updateWeeklyPrices(cheapCatalog,snapshot,null,monday).prices[3],100_000);
  assert.throws(()=>validateMarket(cheapCatalog,{...snapshot,prices:{...snapshot.prices,3:1}}));
});

test('weekly decreases stop at $100,000 while increases still respect the 5% cap',()=>{
  const cheapCatalog={...catalog,players:players.map(p=>p.id===3?{...p,price:102_000,lastPoints:1}:p)};
  const base=initialMarket(cheapCatalog),next=updateWeeklyPrices(cheapCatalog,base,stats({3:-10}),monday);
  assert.equal(next.prices[3],100_000);
  const following=Date.parse('2026-10-26T10:00:00Z');
  assert.equal(updateWeeklyPrices(cheapCatalog,next,{...stats({3:-10}),fetchedAt:new Date(following).toISOString()},following).prices[3],100_000);
  assert.equal(updateWeeklyPrices(cheapCatalog,next,{...stats({3:100}),fetchedAt:new Date(following).toISOString()},following).prices[3],105_000);
});

test('startup persists the floor for verified saved prices and both public markets use it',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'fantasy-floor-')),marketCachePath=join(directory,'market-prices.json');
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const snapshot={...initialMarket(catalog),asOf:new Date(monday).toISOString(),prices:Object.fromEntries(players.map(p=>[p.id,p.id===3?40_000:p.price]))};
  snapshot.version=priceVersion(snapshot);writeFileSync(marketCachePath,JSON.stringify(snapshot));
  const app=createApp({dbPath:':memory:',fantasyCatalog:catalog,marketCachePath,now:()=>monday,allowStandingsFetch:false,allowFantasyFetch:false,allowContractFetch:false});
  t.after(()=>app.close());
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${app.server.address().port}`;
  const picker=await (await fetch(url+'/api/fantasy/players')).json();
  const values=await (await fetch(url+'/api/fantasy/value')).json();
  const saved=validateMarket(catalog,JSON.parse(readFileSync(marketCachePath,'utf8')));
  assert.equal(picker.players.find(p=>p.id===3).price,100_000);
  assert.equal(values.players.find(p=>p.id===3).fantasyValue,100_000);
  assert.equal(picker.market.minimumPrice,100_000);assert.equal(saved.prices[3],100_000);
  assert.notEqual(saved.version,snapshot.version);assert.equal(picker.market.version,saved.version);
});
test('weekly prices blend 75/25, cap both directions at 5% and apply only once per Monday',()=>{
  const base=initialMarket(catalog),next=updateWeeklyPrices(catalog,base,stats({1:100,2:-10,3:2,6:20}),monday);
  assert.equal(next.prices[1],12_600_000);assert.equal(next.prices[2],11_400_000);
  assert.equal(next.prices[3],1_050_000);assert.equal(next.prices[6],4_200_000);
  assert.equal(next.prices[4],base.prices[4]);assert.equal(updateWeeklyPrices(catalog,next,stats({1:1000}),monday+3600000),next);
  assert.equal(validateMarket(catalog,next),next);assert.throws(()=>validateMarket(catalog,{...next,prices:{...next.prices,1:1}}));
});
test('weekly value changes survive serialization and measure the latest update rather than the catalog baseline',()=>{
  const base=initialMarket(catalog),next=updateWeeklyPrices(catalog,base,stats({1:100,2:-10}),monday);
  assert.equal(playerPriceChange(base,1),null);
  const saved=validateMarket(catalog,JSON.parse(JSON.stringify(next)));
  assert.deepEqual(saved.previousPrices,base.prices);
  assert.equal(playerPriceChange(saved,1).amount,600_000);
  assert.ok(Math.abs(playerPriceChange(saved,1).percent-5)<1e-9);
  assert.equal(playerPriceChange(saved,2).amount,-600_000);
  assert.equal(playerPriceChange(saved,4).amount,0);
  assert.equal(playerPriceChange(saved,999),null);
  const following=Date.parse('2026-10-26T10:00:00Z');
  const later=updateWeeklyPrices(catalog,saved,{...stats({1:100}),fetchedAt:new Date(following).toISOString()},following);
  assert.equal(playerPriceChange(later,1).previousPrice,saved.prices[1]);
  assert.equal(playerPriceChange(later,1).amount,630_000);
  assert.equal(playerPriceChange(later,1).asOf,new Date(following).toISOString());
  assert.deepEqual(base.prices,initialMarket(catalog).prices);
  assert.throws(()=>validateMarket(catalog,{...saved,previousPrices:{...saved.previousPrices,1:1}}));
  for(const previousPrices of [{1:0},{999:1},[],null]){
    const invalid={...saved,previousPrices};invalid.version=priceVersion(invalid);
    assert.throws(()=>validateMarket(catalog,invalid));
  }
});

test('weekly target uses current-season pace and preserves prices for short samples, stale feeds and provisional GSAx',()=>{
  const base=initialMarket(catalog),next=updateWeeklyPrices(catalog,base,stats({1:1200/82,6:10},[6]),monday);
  assert.equal(next.prices[1],12_000_000);assert.equal(next.prices[6],4_000_000);
  assert.equal(updateWeeklyPrices(catalog,base,{...stats({1:100}),games:stats({1:100}).games.slice(0,4)},monday).prices[1],12_000_000);
  assert.equal(updateWeeklyPrices(catalog,base,{...stats({1:100}),fetchedAt:new Date(monday-1).toISOString()},monday),base);
  assert.equal(updateWeeklyPrices(catalog,base,null,monday),base);
});
test('pricing respects Helsinki Monday noon across daylight saving and a missed week adjusts only once',()=>{
  assert.equal(nextPriceUpdate(Date.parse('2026-10-18T12:00:00Z')),monday);
  assert.equal(previousPriceUpdate(monday),monday);assert.equal(previousPriceUpdate(monday-1),Date.parse('2026-10-12T09:00:00Z'));
  assert.equal(nextPriceUpdate(monday),Date.parse('2026-10-26T10:00:00Z'));
  const later=Date.parse('2026-11-02T10:00:00Z'),base=initialMarket(catalog);
  assert.equal(updateWeeklyPrices(catalog,base,{...stats({1:100}),fetchedAt:new Date(later).toISOString()},later).prices[1],12_600_000);
});
async function cashFixture(t){
  const directory=mkdtempSync(join(tmpdir(),'fantasy-cash-')),dbPath=join(directory,'accounts.sqlite');
  let priced=players.map(p=>({...p})),version='first';
  const priceProvider=()=>({players:priced,version});
  const store=createAccountStore(dbPath,{fantasyPlayers:players,fantasyPrices:priceProvider});
  const user=(await store.register('PriceFan','fantasy-price-password')).user;
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,user,dbPath,priceProvider,reprice(values){priced=priced.map(p=>({...p,price:values[p.id]??p.price}));version='second';}};
}
test('selling credits current value, held gains do not change cash and teams can grow above 40m',async t=>{
  const {store,user,reprice}=await cashFixture(t);
  let entry=store.submitFantasy(user.id,lineup,0,'first');assert.equal(entry.cashBalance,3_000_000);
  reprice({1:20_000_000});assert.equal(store.getFantasy(user.id).cashBalance,3_000_000);
  const unchanged=store.submitFantasy(user.id,lineup,entry.revision,'second');assert.equal(unchanged.cashBalance,3_000_000);assert.equal(unchanged.transfers.used,0);
  entry=store.submitFantasy(user.id,[7,2,3,4,5,6],unchanged.revision,'second');
  assert.equal(entry.cashBalance,5_000_000);assert.equal(entry.transfers.used,1);
  assert.equal(players.filter(p=>entry.activePlayerIds.includes(p.id)).reduce((n,p)=>n+p.price,0),43_000_000);
});
test('draft sales do not spend cash, lower sale prices cannot overspend, and stale quotes cannot transact',async t=>{
  const {store,user,reprice}=await cashFixture(t);const entry=store.submitFantasy(user.id,lineup,0,'first');
  reprice({1:20_000_000});const draft=store.saveFantasyDraft(user.id,[7,2,3,4,5,6],entry.revision,'second');assert.equal(draft.cashBalance,3_000_000);assert.deepEqual(draft.activePlayerIds,lineup);
  assert.throws(()=>store.submitFantasy(user.id,[7,2,3,4,5,6],draft.revision,'first'),/prices changed/);
  reprice({1:2_000_000});assert.throws(()=>store.submitFantasy(user.id,[7,2,3,4,5,6],draft.revision,'second'),/available funds/);
  assert.equal(store.getFantasy(user.id).cashBalance,3_000_000);assert.equal(store.getFantasy(user.id).transfers.used,0);
});
test('cash survives restart and schema 3 teams retain their original unused cash when prices have grown',async t=>{
  const {store,user,dbPath,priceProvider,reprice}=await cashFixture(t);store.submitFantasy(user.id,lineup,0,'first');
  reprice({1:20_000_000});const other=createAccountStore(dbPath,{fantasyPlayers:players,fantasyPrices:priceProvider});assert.equal(other.getFantasy(user.id).cashBalance,3_000_000);other.close();
  const db=new DatabaseSync(dbPath);db.exec('ALTER TABLE fantasy_entries DROP COLUMN cash_balance;DROP TABLE fantasy_trades;PRAGMA user_version=3;');db.close();
  const migrated=createAccountStore(dbPath,{fantasyPlayers:players,fantasyPrices:priceProvider});assert.equal(migrated.getFantasy(user.id).cashBalance,3_000_000);assert.deepEqual(migrated.getFantasy(user.id).activePlayerIds,lineup);migrated.close();
});
