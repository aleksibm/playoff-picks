import { FANTASY_RATES, LEGACY_FANTASY_RATES } from './fantasy-rates.mjs';
import { MINIMUM_PLAYER_PRICE } from './market-prices.mjs';

/** Revalue verified historical results while preserving the existing market size. */
export function rebalanceFantasyCatalog(catalog,rankings){
  if(catalog.scoringVersion===FANTASY_RATES.version)return catalog;
  if(catalog.scoringVersion&&catalog.scoringVersion!==LEGACY_FANTASY_RATES.version)throw Error('Unknown catalog scoring version.');
  const source=new Map(rankings.map(row=>[row.playerId,row]));
  if(source.size!==rankings.length)throw Error('Duplicate historical fantasy result.');
  const offenseScale=FANTASY_RATES.goal/LEGACY_FANTASY_RATES.goal;
  if(['assist','powerPlayGoal','powerPlayAssist','gameWinningGoal'].some(key=>Math.abs(FANTASY_RATES[key]/LEGACY_FANTASY_RATES[key]-offenseScale)>1e-10))throw Error('Historical offense needs a new event-level calculation.');
  const players=catalog.players.map(player=>{
    const row=source.get(player.id),b=row?.breakdown;
    if(!row||!b||row.position!==player.position||Math.abs(row.total-player.lastPoints)>.001||!Number.isFinite(row.total)||Object.values(b).some(value=>!Number.isFinite(value))||Math.abs(Object.values(b).reduce((sum,value)=>sum+value,0)-row.total)>1e-7)throw Error(`Unverified historical fantasy result: ${player.id}`);
    const offense=(b.goals??0)+(b.assists??0)+(b.gameWinningBonus??0);
    const lastPoints=row.total+(offenseScale-1)*offense+(player.position==='G'?0:
      (FANTASY_RATES.skaterWin/LEGACY_FANTASY_RATES.skaterWin-1)*(b.teamWins??0)+(FANTASY_RATES.faceoff/LEGACY_FANTASY_RATES.faceoff-1)*(b.faceoffs??0));
    return {...player,lastPoints};
  });
  const target=catalog.players.reduce((sum,player)=>sum+Math.max(MINIMUM_PLAYER_PRICE,player.price),0);
  if(!Number.isSafeInteger(target)||players.every(player=>player.lastPoints<=0)||target<players.length*MINIMUM_PLAYER_PRICE)throw Error('Invalid fantasy market calibration.');
  const value=rate=>players.reduce((sum,player)=>sum+Math.max(MINIMUM_PLAYER_PRICE,player.lastPoints*rate),0);
  let lower=0,upper=catalog.usdPerPoint;
  if(!Number.isFinite(upper)||upper<=0)throw Error('Invalid dollars per fantasy point.');
  while(value(upper)<target){upper*=2;if(!Number.isFinite(upper))throw Error('Fantasy price calibration overflow.');}
  for(let i=0;i<100;i++){const middle=(lower+upper)/2;if(value(middle)>target)upper=middle;else lower=middle;}
  const usdPerPoint=(lower+upper)/2;
  const amounts=players.map(player=>Math.max(MINIMUM_PLAYER_PRICE,player.lastPoints*usdPerPoint));
  const prices=amounts.map(Math.floor);
  const remaining=target-prices.reduce((sum,price)=>sum+price,0);
  const rounded=amounts.map((amount,index)=>({index,remainder:amount-prices[index],id:players[index].id}))
    .filter(row=>amounts[row.index]>MINIMUM_PLAYER_PRICE).sort((a,b)=>b.remainder-a.remainder||a.id-b.id);
  if(remaining<0||remaining>rounded.length)throw Error('Fantasy price rounding did not reconcile.');
  for(let i=0;i<remaining;i++)prices[rounded[i].index]++;
  return {...catalog,scoringVersion:FANTASY_RATES.version,usdPerPoint,
    note:'2025–26 results recalculated with the current scoring rules. The dollars-per-point rate preserves the previous total starting market value, including the $100,000 minimum. Live prices move at most 5% per week.',
    valuation:{method:'constant-market-value',previousScoringVersion:catalog.scoringVersion??LEGACY_FANTASY_RATES.version,previousUsdPerPoint:catalog.usdPerPoint,previousMarketValueUsd:target,marketValueUsd:prices.reduce((sum,price)=>sum+price,0)},
    players:players.map((player,index)=>({...player,price:prices[index]}))};
}
