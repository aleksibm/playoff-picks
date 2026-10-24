import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fetchRosterSnapshot, mergeRosterCatalog, validateRosterSnapshot } from './roster-updates.mjs';

const catalog=JSON.parse(readFileSync(new URL('./fantasy-players.json',import.meta.url),'utf8'));
const destination=new URL('./fantasy-roster.json',import.meta.url);
const previous=existsSync(destination)?validateRosterSnapshot(JSON.parse(readFileSync(destination,'utf8'))):null;
console.log('Checking all 32 NHL rosters and the active-player index…');
const snapshot=await fetchRosterSnapshot({catalog,previous});
const temporary=new URL('./fantasy-roster.json.tmp',import.meta.url);
writeFileSync(temporary,JSON.stringify(snapshot,null,2)+'\n');
renameSync(temporary,destination);
const players=mergeRosterCatalog(catalog,snapshot).players;
console.log(JSON.stringify({fetchedAt:snapshot.fetchedAt,available:players.filter(p=>p.selectable).length,
  newcomers:players.filter(p=>p.newcomer&&p.selectable).length,unavailable:players.filter(p=>!p.selectable).length}));
