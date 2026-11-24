import { fetchFantasySnapshot, validateFantasySnapshot } from './fantasy-scoring.mjs';
import { FANTASY_RATES } from './fantasy-rates.mjs';

export function priceHistoryCutoff(asOf){
  const date=new Date(asOf);date.setUTCFullYear(date.getUTCFullYear()-3);
  return date.getTime();
}

export function validatePriceHistory(history,season){
  if(!history||history.season!==season||history.scoringVersion!==FANTASY_RATES.version||!Number.isFinite(Date.parse(history.fetchedAt))||
    !Number.isFinite(Date.parse(history.from))||Date.parse(history.from)>Date.parse(history.fetchedAt)||!Array.isArray(history.playerIds)||
    history.playerIds.some(id=>!Number.isSafeInteger(id)||id<=0)||new Set(history.playerIds).size!==history.playerIds.length||
    !Array.isArray(history.games)||history.games.length>4200)throw Error('Invalid fantasy price history.');
  const covered=new Set(history.playerIds),seasons=new Map();
  for(const game of history.games){
    const year=String(game.id).slice(0,4),gameSeason=year+String(Number(year)+1);
    if(Number(gameSeason)>=Number(season)||Object.keys(game.scores??{}).some(id=>!covered.has(Number(id))))throw Error('Invalid fantasy price history game.');
    if(!seasons.has(gameSeason))seasons.set(gameSeason,[]);
    seasons.get(gameSeason).push(game);
  }
  for(const [gameSeason,games] of seasons)validateFantasySnapshot({...history,season:gameSeason,games},FANTASY_RATES,gameSeason);
  return history;
}

export function currentPriceAppearances(catalog,stats,asOf){
  const counts=new Map();
  for(const game of stats?.games??[]){
    if(Date.parse(game.startTime)>asOf||Date.parse(game.startTime)<priceHistoryCutoff(asOf))continue;
    for(const id of Object.keys(game.scores))counts.set(Number(id),(counts.get(Number(id))??0)+1);
  }
  return new Map(catalog.players.filter(player=>(counts.get(player.id)??0)>=5).map(player=>[player.id,counts.get(player.id)]));
}

/** Backfill actual appearances, including prior seasons, once per eligible player. */
export async function fetchPriceHistory({catalog,stats,asOf,now=Date.now(),previous=null,cacheDir=null,fetchSnapshot=fetchFantasySnapshot}={}){
  const cutoff=priceHistoryCutoff(asOf),current=currentPriceAppearances(catalog,stats,asOf);
  if(previous){
    validatePriceHistory(previous,catalog.season);
    if(Date.parse(previous.from)<=cutoff&&current.keys().every(id=>previous.playerIds.includes(id))&&
      !previous.games.some(game=>game.pending.length))return previous;
  }
  const playerIds=[...current.keys()],games=[];
  const remaining=new Map([...current].map(([id,count])=>[id,Math.max(0,100-count)]));
  for(let year=Number(catalog.season.slice(0,4))-1;Date.UTC(year+1,6,1)>cutoff&&[...remaining.values()].some(count=>count>0);year--){
    const season=String(year)+String(year+1);
    const snapshot=validateFantasySnapshot(await fetchSnapshot({season,since:cutoff,playerWindows:remaining,cacheDir,now}),FANTASY_RATES,season);
    // Keep only requested, recent appearances. Another player's selected game
    // must not fill a gap in this player's chronological window.
    const selected=new Map();
    for(const id of playerIds){
      const appearances=snapshot.games.filter(game=>Date.parse(game.startTime)>=cutoff&&Date.parse(game.startTime)<=asOf&&Object.hasOwn(game.scores,id))
        .sort((a,b)=>Date.parse(b.startTime)-Date.parse(a.startTime)||b.id-a.id).slice(0,remaining.get(id));
      selected.set(id,new Set(appearances.map(game=>game.id)));
      remaining.set(id,remaining.get(id)-appearances.length);
    }
    for(const game of snapshot.games){
      const entries=Object.entries(game.scores).filter(([id])=>selected.get(Number(id))?.has(game.id));
      if(entries.length)games.push({id:game.id,startTime:game.startTime,scores:Object.fromEntries(entries),pending:game.pending.filter(id=>selected.get(id)?.has(game.id)),teams:{}});
    }
  }
  return validatePriceHistory({season:catalog.season,scoringVersion:FANTASY_RATES.version,fetchedAt:new Date(now).toISOString(),from:new Date(cutoff).toISOString(),playerIds,games},catalog.season);
}
