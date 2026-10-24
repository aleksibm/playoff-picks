import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountStore } from '../accounts.mjs';
import { initialMarket, priceVersion, reconcileMarket, validateMarket } from '../market-prices.mjs';

const players=[
  {id:1,name:'Former NHL Center',position:'C',team:'COL',price:12_000_000,lastPoints:1200,games:82},
  {id:2,name:'Wing',position:'RW',team:'TBL',price:12_000_000,lastPoints:1200,games:82},
  {id:3,name:'Cheap Wing',position:'LW',team:'DAL',price:1_000_000,lastPoints:100,games:80},
  {id:4,name:'Defense One',position:'D',team:'COL',price:4_000_000,lastPoints:400,games:82},
  {id:5,name:'Defense Two',position:'D',team:'TOR',price:4_000_000,lastPoints:400,games:82},
  {id:6,name:'Goalie',position:'G',team:'DAL',price:4_000_000,lastPoints:400,games:55},
];
const rookie={id:7,name:'Debuting Rookie',position:'C',team:'TOR',price:100_000,lastPoints:0,games:0,newcomer:true,selectable:true};
const catalog={season:'20262027',usdPerPoint:10000,players};
const expanded={...catalog,players:[...players.map(player=>({...player,selectable:player.id!==1})),rookie]};
const lineup=players.map(player=>player.id);
const withPrices=prices=>{const snapshot={...initialMarket(catalog),asOf:'2026-10-19T09:00:00.000Z',prices};return {...snapshot,version:priceVersion(snapshot)};};

test('catalog expansion gives debutants $100k without resetting verified prices or the weekly date',()=>{
  const saved=withPrices({...initialMarket(catalog).prices,1:12_600_000,2:11_400_000});
  const original=structuredClone(saved),next=reconcileMarket(expanded,saved);
  assert.equal(next.prices[rookie.id],100_000);
  for(const player of players)assert.equal(next.prices[player.id],saved.prices[player.id]);
  assert.equal(next.asOf,saved.asOf);assert.equal(next.season,saved.season);
  assert.notEqual(next.version,saved.version);assert.equal(next.version,priceVersion(next));
  assert.deepEqual(saved,original);assert.equal(validateMarket(expanded,next),next);
  assert.equal(reconcileMarket(expanded,next),next);
  assert.throws(()=>validateMarket(expanded,saved),/Invalid fantasy price snapshot/);
});

test('catalog expansion rejects missing original prices, unknown IDs and damaged snapshots',()=>{
  const base=initialMarket(catalog),missing={...base.prices};delete missing[1];
  assert.throws(()=>reconcileMarket(expanded,withPrices(missing)),/Invalid fantasy price snapshot/);
  assert.throws(()=>reconcileMarket(expanded,withPrices({...base.prices,999:100_000})),/Invalid fantasy price snapshot/);
  assert.throws(()=>reconcileMarket(expanded,{...base,prices:{...base.prices,1:1}}),/Invalid fantasy price snapshot/);
  assert.throws(()=>reconcileMarket(expanded,withPrices({...base.prices,1:0})),/Invalid fantasy price snapshot/);
  assert.throws(()=>reconcileMarket(expanded,{...base,season:'20252026'}),/Invalid fantasy price snapshot/);
  assert.throws(()=>reconcileMarket(expanded,{...base,asOf:'invalid'}),/Invalid fantasy price snapshot/);
});

test('an available debutant can be drafted and entered at the $100k starting price',async t=>{
  const market=reconcileMarket(expanded,initialMarket(catalog));
  const priced=expanded.players.map(player=>({...player,price:market.prices[player.id]}));
  const store=createAccountStore(':memory:',{fantasyPlayers:expanded.players,fantasyPrices:()=>({players:priced,version:market.version})});
  t.after(()=>store.close());
  const user=(await store.register('RookieFan','fantasy-rookie-password')).user;
  const ids=[rookie.id,2,3,4,5,6];
  const draft=store.saveFantasyDraft(user.id,ids,0,market.version);
  const entered=store.submitFantasy(user.id,ids,draft.revision,market.version);
  assert.deepEqual(entered.activePlayerIds,ids);
  assert.equal(entered.cashBalance,14_900_000);assert.equal(entered.transfers.used,0);
});

test('inactive players cannot be purchased but existing owners can retain or sell them without losing cash or history',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'fantasy-eligibility-')),dbPath=join(directory,'accounts.sqlite');
  let priced=[...players,rookie].map(player=>({...player,selectable:true})),version='original';
  const priceProvider=()=>({players:priced,version});
  let store=createAccountStore(dbPath,{fantasyPlayers:[...players,rookie],fantasyPrices:priceProvider});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const owner=(await store.register('ExistingOwner','fantasy-owner-password')).user;
  const buyer=(await store.register('NewBuyer','fantasy-buyer-password')).user;
  let entry=store.submitFantasy(owner.id,lineup,0,version);
  assert.equal(entry.cashBalance,3_000_000);
  priced=priced.map(player=>player.id===1?{...player,selectable:false,price:12_600_000}:player);version='updated';
  assert.throws(()=>store.saveFantasyDraft(buyer.id,[1],0,version),/no longer available/);
  assert.throws(()=>store.submitFantasy(buyer.id,lineup,0,version),/no longer available/);
  assert.equal(store.getFantasy(buyer.id).revision,0);
  entry=store.submitFantasy(owner.id,lineup,entry.revision,version);
  assert.equal(entry.cashBalance,3_000_000);assert.equal(entry.transfers.used,0);
  const updated=[rookie.id,2,3,4,5,6];
  const draft=store.saveFantasyDraft(owner.id,updated,entry.revision,version);
  assert.equal(draft.cashBalance,3_000_000);assert.deepEqual(draft.activePlayerIds,lineup);
  entry=store.submitFantasy(owner.id,updated,draft.revision,version);
  assert.equal(entry.cashBalance,15_500_000);assert.equal(entry.transfers.used,1);
  assert.deepEqual(store.fantasyHistory(owner.id).map(row=>row.playerIds),[lineup,updated]);
  assert.throws(()=>store.submitFantasy(owner.id,lineup,entry.revision,version),/no longer available/);
  store.close();
  store=createAccountStore(dbPath,{fantasyPlayers:expanded.players,fantasyPrices:priceProvider});
  assert.equal(store.getFantasy(owner.id).cashBalance,15_500_000);
  assert.deepEqual(store.getFantasy(owner.id).activePlayerIds,updated);
  assert.equal(store.fantasyHistory(owner.id).length,2);
});
