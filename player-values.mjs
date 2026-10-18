import { TEAMS } from './dist/game.js';
import { rankValues } from './dist/value-rules.js';

const teamIds=new Set(TEAMS.map(t=>t.id));
export function buildPlayerValues(catalog, contracts) {
  if(contracts.season!==catalog.season||contracts.currency!=='USD'||!/^\d{4}-\d{2}-\d{2}$/.test(contracts.asOf??'')||!Number.isFinite(Date.parse(contracts.asOf))||!Array.isArray(contracts.players))throw new Error('Invalid contract snapshot');
  const byId=new Map();
  for(const row of contracts.players){
    if(!Number.isSafeInteger(row.id)||row.id<=0||byId.has(row.id)||!Number.isSafeInteger(row.capHit)||row.capHit<=0||row.capHit>50_000_000||!teamIds.has(row.team)||!/^https:\/\/puckpedia\.com\/player\/[a-z0-9-]+$/i.test(row.sourceUrl))throw new Error('Invalid player contract');
    byId.set(row.id,row);
  }
  const players=catalog.players.map(player=>{
    const contract=byId.get(player.id);
    const capHit=contract?.capHit??null;
    return {id:player.id,name:player.name,position:player.position,team:contract?.team??player.team,games:player.games,
      fantasyPoints:player.lastPoints,fantasyValue:player.price,capHit,surplus:capHit===null?null:player.price-capHit,
      surplusPercent:capHit===null?null:(player.price/capHit-1)*100,sourceUrl:contract?.sourceUrl??null};
  });
  const ranked=rankValues(players.filter(p=>p.capHit!==null));
  return {season:catalog.season,valuationSeason:catalog.valuationSeason,contractAsOf:contracts.asOf,currency:'USD',
    usdPerPoint:catalog.usdPerPoint,source:contracts.source,sourceUrl:contracts.sourceUrl,
    coverage:{matched:ranked.length,total:players.length,missing:players.length-ranked.length,aboveContract:ranked.filter(p=>p.surplus>0).length},
    players:rankValues(players)};
}
