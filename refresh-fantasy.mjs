import { fetchFantasySnapshot } from './fantasy-scoring.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const directory=new URL('./.local-data/fantasy-preview/',import.meta.url);
mkdirSync(directory,{recursive:true});
console.log('Checking live 2026–27 NHL and MoneyPuck fantasy statistics…');
const result=await fetchFantasySnapshot({cacheDir:fileURLToPath(new URL('fantasy-events/',directory))});
writeFileSync(new URL('fantasy-scores.json',directory),JSON.stringify(result),{mode:0o600});
console.log(JSON.stringify({season:result.season,games:result.games.length,fetchedAt:result.fetchedAt,modelError:result.modelError,pendingGames:result.games.filter(g=>g.pending.length).length}));
