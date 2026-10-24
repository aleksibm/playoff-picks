import { createApp } from './server.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateRosterSnapshot, mergeRosterCatalog } from './roster-updates.mjs';
import { seedPreviewAccounts, createPreviewSnapshot } from './preview-data.mjs';
const directory=fileURLToPath(new URL('./.local-data/fantasy-preview/',import.meta.url));
const baseCatalog=JSON.parse(readFileSync(new URL('./fantasy-players.json',import.meta.url),'utf8'));
let roster=validateRosterSnapshot(JSON.parse(readFileSync(new URL('./fantasy-roster.json',import.meta.url),'utf8')));
if(existsSync(`${directory}/fantasy-roster.json`)){
  const saved=validateRosterSnapshot(JSON.parse(readFileSync(`${directory}/fantasy-roster.json`,'utf8')));
  if(Date.parse(saved.fetchedAt)>Date.parse(roster.fetchedAt))roster=saved;
}
const catalog=mergeRosterCatalog(baseCatalog,roster);
const playerIds=await seedPreviewAccounts({directory,catalog});
const app=createApp({dbPath:`${directory}/accounts.sqlite`,standingsCachePath:`${directory}/standings.json`,
  fantasyCachePath:`${directory}/demo-fantasy-scores.json`,
  fantasyCatalog:baseCatalog,rosterSnapshot:roster,
  fantasyProvider:()=>createPreviewSnapshot(catalog,{playerIds}),previewData:true,
  allowStandingsFetch:false,allowFantasyFetch:false,allowRosterFetch:false,allowContractFetch:false,publicOrigin:null});
await app.refreshFantasy();
await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(8770,'127.0.0.1',resolve);});
console.log('Fantasy preview ready at http://127.0.0.1:8770/fantasy');
console.log('TEST DATA: synthetic scores and three demo managers. Existing local accounts and lineups are preserved.');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();process.exit(0);});
