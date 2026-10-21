import { createHash } from 'node:crypto';
import { previousDailyUpdate, nextDailyUpdate } from './schedule.mjs';

const localDay=new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Helsinki',weekday:'short'});
export const MINIMUM_PLAYER_PRICE=100_000;
export function applyMinimumPrice(market){
  if(Object.values(market.prices).every(price=>price>=MINIMUM_PLAYER_PRICE))return market;
  const snapshot={...market,prices:Object.fromEntries(Object.entries(market.prices).map(([id,price])=>[id,Math.max(MINIMUM_PLAYER_PRICE,price)]))};
  return {...snapshot,version:priceVersion(snapshot)};
}
export function previousPriceUpdate(now=Date.now()){
  let day=previousDailyUpdate(now);
  while(localDay.format(day)!=='Mon')day=previousDailyUpdate(day-1);
  return day;
}
export function nextPriceUpdate(now=Date.now()){let day=nextDailyUpdate(now);while(localDay.format(day)!=='Mon')day=nextDailyUpdate(day);return day;}
export function priceVersion(snapshot){return createHash('sha256').update(JSON.stringify([snapshot.asOf,snapshot.prices])).digest('hex').slice(0,20);}
export function initialMarket(catalog){const snapshot={season:catalog.season,asOf:'2026-10-18T00:00:00.000Z',prices:Object.fromEntries(catalog.players.map(p=>[p.id,p.price]))};return applyMinimumPrice({...snapshot,version:priceVersion(snapshot)});}
export function validateMarket(catalog,snapshot){
  if(snapshot?.season!==catalog.season||!Number.isFinite(Date.parse(snapshot.asOf))||!snapshot.prices||Object.keys(snapshot.prices).length!==catalog.players.length||catalog.players.some(p=>!Number.isSafeInteger(snapshot.prices[p.id])||snapshot.prices[p.id]<=0)||snapshot.version!==priceVersion(snapshot))throw Error('Invalid fantasy price snapshot');
  return snapshot;
}
export function pricedPlayers(catalog,market){return catalog.players.map(p=>({...p,price:market.prices[p.id],basePrice:p.price}));}
export function updateWeeklyPrices(catalog,market,stats,now=Date.now()){
  market=applyMinimumPrice(market);
  const due=previousPriceUpdate(now);
  if(Date.parse(market.asOf)>=due)return market;
  // A failed daily stats refresh cannot move market prices on stale statistics.
  if(!stats||stats.season!==catalog.season||Date.parse(stats.fetchedAt)<due)return market;
  const totals=new Map(),played=new Map(),pending=new Set();
  for(const game of stats.games){
    if(Date.parse(game.startTime)>due)continue;
    for(const [key,score] of Object.entries(game.scores)){const id=Number(key);totals.set(id,(totals.get(id)??0)+score);played.set(id,(played.get(id)??0)+1);}
    for(const id of game.pending)pending.add(id);
  }
  const prices={...market.prices};
  for(const player of catalog.players){
    const games=played.get(player.id)??0;
    // Regress to last season until there is a meaningful current-season sample.
    // Goalies keep their verified price while any GSAx adjustment is pending.
    if(games<5||pending.has(player.id))continue;
    const fullSeason=player.position==='G'?55:82;
    const projected=(totals.get(player.id)??0)/games*fullSeason;
    const target=Math.round((.75*player.lastPoints+.25*projected)*catalog.usdPerPoint);
    const previous=market.prices[player.id];
    const minimum=Math.max(MINIMUM_PLAYER_PRICE,Math.ceil(previous*.95)),maximum=Math.max(minimum,Math.floor(previous*1.05));
    prices[player.id]=Math.min(maximum,Math.max(minimum,target));
  }
  // A missed week causes one capped adjustment with the latest verified stats,
  // never multiple compounded increases on a single restart.
  const next={season:catalog.season,asOf:new Date(due).toISOString(),prices};
  return {...next,version:priceVersion(next)};
}
