// Usage: node revalue-fantasy.mjs path/to/verified/legacy-rankings.json
// The original positive, verified catalog defines the population and price pool.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { rebalanceFantasyCatalog } from './fantasy-valuation.mjs';

if(process.argv.length!==3)throw Error('Usage: node revalue-fantasy.mjs path/to/verified/legacy-rankings.json');
const path=new URL('./fantasy-players.json',import.meta.url);
const catalog=JSON.parse(readFileSync(path,'utf8'));
const next=rebalanceFantasyCatalog(catalog,JSON.parse(readFileSync(process.argv[2],'utf8')));
if(next!==catalog){const temporary=new URL('./fantasy-players.json.tmp',import.meta.url);writeFileSync(temporary,JSON.stringify(next)+'\n');renameSync(temporary,path);}
console.log(JSON.stringify({players:next.players.length,usdPerPoint:next.usdPerPoint,...next.valuation}));
