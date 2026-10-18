import { createApp } from './server.mjs';
import { fileURLToPath } from 'node:url';
const directory=fileURLToPath(new URL('./.local-data/fantasy-preview/',import.meta.url));
const app=createApp({dbPath:`${directory}/accounts.sqlite`,standingsCachePath:`${directory}/standings.json`,allowStandingsFetch:false,allowFantasyFetch:false,publicOrigin:null});
await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(8770,'127.0.0.1',resolve);});
console.log('Fantasy preview ready at http://127.0.0.1:8770/fantasy');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();process.exit(0);});
