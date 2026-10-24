import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createAccountStore } from './accounts.mjs';
import { createLocalAdmin } from './admin.mjs';
import { TEAMS } from './dist/game.js';
import { UPDATE_TIME_ZONE, UPDATE_TIME, previousDailyUpdate, createDailyScheduler } from './schedule.mjs';
import { TARGET_SEASON, fetchStandings, scorePrediction, rankEntries } from './standings.mjs';
import { hostingConfig, requestContext, createRateLimiter } from './hosting.mjs';
import { fetchFantasySnapshot, validateFantasySnapshot, scoreFantasyHistory, playerGameLogs, weeklyTopPlayers } from './fantasy-scoring.mjs';
import { FANTASY_SEASON, BUDGET } from './dist/fantasy-rules.js';
import { buildPlayerValues } from './player-values.mjs';
import { createContractUpdater, fetchContractSnapshot } from './contract-updates.mjs';
import { MINIMUM_PLAYER_PRICE, applyMinimumPrice, initialMarket, reconcileMarket, pricedPlayers, updateWeeklyPrices, previousPriceUpdate, nextPriceUpdate } from './market-prices.mjs';
import { fetchRosterSnapshot, validateRosterSnapshot, mergeRosterCatalog } from './roster-updates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FANTASY_CATALOG = JSON.parse(readFileSync(join(HERE,'fantasy-players.json'),'utf8'));
const FANTASY_ROSTER = validateRosterSnapshot(JSON.parse(readFileSync(join(HERE,'fantasy-roster.json'),'utf8')));
const PLAYER_CONTRACTS = JSON.parse(readFileSync(join(HERE,'player-contracts.json'),'utf8'));
const MAX_BODY = 8 * 1024;
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const UPDATE_GRACE_MS = 5 * 60 * 1000;
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/game.js', ['game.js', 'text/javascript; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
  ['/fantasy', ['fantasy.html', 'text/html; charset=utf-8']],
  ['/fantasy/', ['fantasy.html', 'text/html; charset=utf-8']],
  ['/fantasy.html', ['fantasy.html', 'text/html; charset=utf-8']],
  ['/fantasy.css', ['fantasy.css', 'text/css; charset=utf-8']],
  ['/fantasy.js', ['fantasy.js', 'text/javascript; charset=utf-8']],
  ['/fantasy-rules.js', ['fantasy-rules.js', 'text/javascript; charset=utf-8']],
  ['/fantasy/value', ['player-value.html', 'text/html; charset=utf-8']],
  ['/fantasy/value/', ['player-value.html', 'text/html; charset=utf-8']],
  ['/player-value.css', ['player-value.css', 'text/css; charset=utf-8']],
  ['/player-value.js', ['player-value.js', 'text/javascript; charset=utf-8']],
  ['/value-rules.js', ['value-rules.js', 'text/javascript; charset=utf-8']],
  ...TEAMS.map(team => [`/logos/${team.id}.svg`, [`logos/${team.id}.svg`, 'image/svg+xml']]),
]);

function failure(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function readJSON(request) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers['content-type'] ?? '')) {
    request.resume();
    return Promise.reject(failure(415, 'Send this request as JSON.'));
  }
  if (Number(request.headers['content-length']) > MAX_BODY) {
    request.resume();
    return Promise.reject(failure(413, 'This request is too large.'));
  }
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    let rejected = false;
    request.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        rejected = true;
        chunks.length = 0;
        rejectBody(failure(413, 'This request is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Not an object');
        resolveBody(body);
      } catch {
        rejectBody(failure(400, 'This request contains invalid JSON.'));
      }
    });
    request.on('error', () => rejectBody(failure(400, 'This request could not be read.')));
    request.on('aborted', () => rejectBody(failure(400, 'This request was interrupted.')));
  });
}

function securityHeaders(response, secure) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self'; connect-src 'self'; font-src 'self' https://fonts.gstatic.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function json(response, status, body) {
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

function cookieToken(request, cookieName) {
  const values = (request.headers.cookie ?? '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${cookieName}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(cookieName.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function setSessionCookie(response, token, hosting) {
  response.setHeader('Set-Cookie', `${hosting.cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}${hosting.secure ? '; Secure' : ''}`);
}

function clearSessionCookie(response, hosting) {
  response.setHeader('Set-Cookie', `${hosting.cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${hosting.secure ? '; Secure' : ''}`);
}

function equalTokens(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function validateSnapshot(snapshot) {
  scorePrediction([], snapshot);
  if (snapshot.season !== TARGET_SEASON || !Number.isFinite(Date.parse(snapshot.fetchedAt))) {
    throw new Error('Invalid standings snapshot');
  }
  return snapshot;
}

function saveSnapshot(path, snapshot) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporaryPath = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

/** Local account-backed site. Network access can be disabled or replaced in tests. */
export function createApp(options = {}) {
  const hosting = hostingConfig(Object.hasOwn(options, 'publicOrigin') ? options.publicOrigin : process.env.PLAYOFF_PICK_PUBLIC_ORIGIN,
    options.proxyMode ?? process.env.PLAYOFF_PICK_PROXY ?? 'caddy');
  if (process.env.NODE_ENV === 'production' && !hosting.secure) {
    throw new Error('Public production hosting requires PLAYOFF_PICK_PUBLIC_ORIGIN and the HTTPS reverse proxy.');
  }
  const directory = resolve(process.env.PLAYOFF_PICK_DATA_DIR ?? join(HERE, '.local-data'));
  const dbPath = options.dbPath ?? join(directory, 'accounts.sqlite');
  const cachePath = options.standingsCachePath ?? (dbPath === ':memory:' ? null : join(dirname(dbPath), 'standings.json'));
  const allowStandingsFetch = options.allowStandingsFetch ?? process.env.PLAYOFF_PICK_FETCH_STANDINGS !== '0';
  const provider = options.standingsProvider ?? fetchStandings;
  const canRefresh = Boolean(options.standingsProvider) || allowStandingsFetch;
  const now = options.now ?? Date.now;
  if (!options.dbPath) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const baseCatalog = options.fantasyCatalog ?? FANTASY_CATALOG;
  const rosterCachePath=options.rosterCachePath??(dbPath===':memory:'?null:join(dirname(dbPath),'fantasy-roster.json'));
  let rosterSnapshot=options.rosterSnapshot?validateRosterSnapshot(options.rosterSnapshot):options.fantasyCatalog?null:FANTASY_ROSTER;
  let rosterError=null,rosterRefreshing=null;
  // The newer source controls availability, while older identities remain for
  // saved teams, their sale values and past points.
  function retainRosterHistory(previous,next){
    if(!previous)return next;
    const players=new Map(previous.players.map(player=>[player.id,{...player,selectable:false}]));
    for(const player of next.players)players.set(player.id,player);
    return validateRosterSnapshot({...next,players:[...players.values()].sort((a,b)=>a.id-b.id)});
  }
  if(rosterCachePath&&existsSync(rosterCachePath)){
    try{
      if(statSync(rosterCachePath).size>2*1024*1024)throw Error();
      const saved=validateRosterSnapshot(JSON.parse(readFileSync(rosterCachePath,'utf8')));
      if(Date.parse(saved.fetchedAt)>now())throw Error();
      rosterSnapshot=!rosterSnapshot||Date.parse(saved.fetchedAt)>=Date.parse(rosterSnapshot.fetchedAt)?retainRosterHistory(rosterSnapshot,saved):retainRosterHistory(saved,rosterSnapshot);
    }catch{rosterError='The saved player roster could not be verified. Using the bundled NHL roster.';}
  }
  let fantasyCatalog=rosterSnapshot?mergeRosterCatalog(baseCatalog,rosterSnapshot):baseCatalog;
  const canRefreshRoster=Boolean(options.rosterProvider)||(options.allowRosterFetch??(options.fantasyCatalog||options.standingsProvider||options.fantasyProvider?false:options.allowStandingsFetch??process.env.PLAYOFF_PICK_FETCH_ROSTER!=='0'));
  const rosterProvider=options.rosterProvider??(previous=>fetchRosterSnapshot({catalog:baseCatalog,previous,now:now()}));
  const marketCachePath=options.marketCachePath??(dbPath===':memory:'?null:join(dirname(dbPath),'market-prices.json'));
  let market=initialMarket(fantasyCatalog);
  let migratedPrices=false;
  if(marketCachePath&&existsSync(marketCachePath)){
    try{if(statSync(marketCachePath).size>1024*1024)throw Error();const original=JSON.parse(readFileSync(marketCachePath,'utf8')),saved=reconcileMarket(fantasyCatalog,original);if(Date.parse(saved.asOf)>now())throw Error();if(Date.parse(saved.asOf)>=Date.parse(market.asOf)){migratedPrices=saved!==original;market=saved;}}catch{throw Error('Saved fantasy prices could not be verified. Restore the matching fantasy-roster.json and market-prices.json backups before trading.');}
  }
  const flooredMarket=applyMinimumPrice(market);
  // Persist the initial identity archive too, including when live fetches are
  // disabled, before recording a price snapshot that references new IDs.
  if(rosterCachePath&&rosterSnapshot)saveSnapshot(rosterCachePath,rosterSnapshot);
  if(marketCachePath&&(migratedPrices||flooredMarket!==market))saveSnapshot(marketCachePath,flooredMarket);
  market=flooredMarket;
  const store = createAccountStore(dbPath,{fantasyPlayers:fantasyCatalog.players,fantasyPrices:()=>({players:pricedPlayers(fantasyCatalog,market),version:market.version}),now});
  const fantasyCachePath = options.fantasyCachePath ?? (dbPath === ':memory:' ? null : join(dirname(dbPath),'fantasy-scores.json'));
  const allowFantasyFetch = options.allowFantasyFetch ?? (options.standingsProvider ? false : options.allowStandingsFetch ?? process.env.PLAYOFF_PICK_FETCH_FANTASY !== '0');
  const canRefreshFantasy = Boolean(options.fantasyProvider) || allowFantasyFetch;
  const fantasyProvider = options.fantasyProvider ?? (()=>fetchFantasySnapshot({now:now(),cacheDir:fantasyCachePath?join(dirname(fantasyCachePath),'fantasy-events'):null}));
  let fantasySnapshot=null,fantasyError=null,fantasyRefreshing=null;
  const startedAt = new Date(now()).toISOString();
  let snapshot = null;
  let refreshError = null;
  let refreshing = null;
  let closed = false;
  const rateLimit = createRateLimiter({ now });
  const contractCachePath=options.contractCachePath??(dbPath===':memory:'?null:join(dirname(dbPath),'contract-values.json'));
  const bundledContracts=options.contracts??PLAYER_CONTRACTS;
  let contractState={snapshot:bundledContracts};
  if(contractCachePath&&existsSync(contractCachePath)){
    try{if(statSync(contractCachePath).size>4*1024*1024)throw Error();const saved=JSON.parse(readFileSync(contractCachePath,'utf8'));buildPlayerValues(fantasyCatalog,saved.snapshot);if(saved.snapshot.asOf>=bundledContracts.asOf)contractState=saved;}catch{}
  }
  const canRefreshContracts=Boolean(options.contractProvider)||(options.allowContractFetch??(options.standingsProvider||options.fantasyProvider?false:options.allowStandingsFetch??process.env.PLAYOFF_PICK_FETCH_CONTRACTS!=='0'));
  const contractUpdater=createContractUpdater({catalog:fantasyCatalog,initial:contractState.snapshot,state:contractState,now,
    run:options.contractProvider??(previous=>fetchContractSnapshot({catalog:fantasyCatalog,previous,now:now()})),
    save:state=>{if(contractCachePath)saveSnapshot(contractCachePath,state);}});

  if(fantasyCachePath&&existsSync(fantasyCachePath)){
    try{if(statSync(fantasyCachePath).size>16*1024*1024)throw new Error('Oversized fantasy cache');fantasySnapshot=validateFantasySnapshot(JSON.parse(readFileSync(fantasyCachePath,'utf8')));}
    catch{fantasyError='Saved fantasy scores could not be verified. Awaiting an update.';}
  }

  function fantasyMetadata(){return {available:Boolean(fantasySnapshot),fetchedAt:fantasySnapshot?.fetchedAt??null,
    gameCount:fantasySnapshot?.games.length??0,stale:Boolean(fantasySnapshot&&Date.parse(fantasySnapshot.fetchedAt)<previousDailyUpdate(now()-UPDATE_GRACE_MS)),
    error:fantasyError??(!fantasySnapshot?(canRefreshFantasy?'Fantasy scores are awaiting a verified 2026–27 update.':'Live fantasy updates are disabled in this preview.'):null),
    modelError:fantasySnapshot?.modelError??null};}
  function rosterMetadata(){return {available:Boolean(rosterSnapshot),fetchedAt:rosterSnapshot?.fetchedAt??null,
    stale:Boolean(rosterSnapshot&&Date.parse(rosterSnapshot.fetchedAt)<previousDailyUpdate(now()-UPDATE_GRACE_MS)),
    error:rosterError,source:rosterSnapshot?.source??null};}
  async function refreshRoster(){
    if(closed||!canRefreshRoster)return rosterMetadata();
    if(rosterRefreshing)return rosterRefreshing;
    rosterRefreshing=(async()=>{
      try{
        const received=validateRosterSnapshot(await rosterProvider(rosterSnapshot));
        if(Date.parse(received.fetchedAt)>now()||rosterSnapshot&&Date.parse(received.fetchedAt)<Date.parse(rosterSnapshot.fetchedAt))throw Error('Outdated NHL roster');
        const next=retainRosterHistory(rosterSnapshot,received),catalog=mergeRosterCatalog(baseCatalog,next),prices=reconcileMarket(catalog,market);
        if(closed)return rosterMetadata();
        // Save identities before prices: an interrupted write can add the new
        // minimum prices on restart without losing an existing player's quote.
        if(rosterCachePath)saveSnapshot(rosterCachePath,next);
        if(marketCachePath&&prices!==market)saveSnapshot(marketCachePath,prices);
        rosterSnapshot=next;fantasyCatalog=catalog;market=prices;rosterError=null;
      }catch{rosterError='The NHL player roster could not be refreshed. The last verified player list remains in use.';}
      return rosterMetadata();
    })();
    try{return await rosterRefreshing;}finally{rosterRefreshing=null;}
  }
  function marketMetadata(){return {version:market.version,asOf:market.asOf,overdue:Date.parse(market.asOf)<previousPriceUpdate(now()),nextUpdate:new Date(nextPriceUpdate(now())).toISOString(),timeZone:'Europe/Helsinki',day:'Monday',time:'12:00',lastSeasonWeight:.75,currentSeasonWeight:.25,weeklyLimit:.05,minimumPrice:MINIMUM_PLAYER_PRICE,minimumGames:5,skaterProjectionGames:82,goalieProjectionGames:55};}
  function refreshMarket(){const next=updateWeeklyPrices(fantasyCatalog,market,fantasySnapshot,now());if(next!==market){if(marketCachePath)saveSnapshot(marketCachePath,next);market=next;}}
  function fantasyBody(session){
    const entry=session?store.getFantasy(session.user.id):null;
    return {user:session?.user??null,csrfToken:session?.csrfToken??null,entry,
      score:entry?.submittedAt?scoreFantasyHistory(store.fantasyHistory(session.user.id),fantasySnapshot):{points:null,pending:false,players:{},playerGames:{}},scoring:fantasyMetadata(),market:marketMetadata(),season:FANTASY_SEASON};
  }
  async function refreshFantasy(){
    if(closed||!canRefreshFantasy)return fantasyMetadata();
    if(fantasyRefreshing)return fantasyRefreshing;
    fantasyRefreshing=(async()=>{
      try{const next=validateFantasySnapshot(await fantasyProvider());if(closed)return fantasyMetadata();if(fantasyCachePath)saveSnapshot(fantasyCachePath,next);fantasySnapshot=next;fantasyError=null;refreshMarket();}
      catch{fantasyError=fantasySnapshot?'Fantasy scores use the last verified update because the latest refresh failed.':'Fantasy statistics could not be verified. Scores will appear after a successful update.';}
      return fantasyMetadata();
    })();
    try{return await fantasyRefreshing;}finally{fantasyRefreshing=null;}
  }

  if (cachePath && existsSync(cachePath)) {
    try {
      if (statSync(cachePath).size > 1024 * 1024) throw new Error('Oversized standings cache');
      snapshot = validateSnapshot(JSON.parse(readFileSync(cachePath, 'utf8')));
      chmodSync(cachePath, 0o600);
    } catch {
      refreshError = 'The saved standings could not be verified. Scores await a verified update.';
    }
  }

  function scoringMetadata() {
    return {
      available: Boolean(snapshot),
      asOf: snapshot?.asOf ?? null,
      fetchedAt: snapshot?.fetchedAt ?? null,
      stale: Boolean(snapshot && Date.parse(snapshot.fetchedAt) < previousDailyUpdate(now() - UPDATE_GRACE_MS)),
      error: refreshError ?? (snapshot ? null : canRefresh
        ? 'Verified 2026–27 NHL standings are not available yet.'
        : 'Live NHL updates are disabled for this local preview. Scores await verified 2026–27 standings.'),
    };
  }

  function predictionScore(prediction) {
    return prediction?.state === 'submitted' && snapshot ? scorePrediction(prediction.teamIds, snapshot) : null;
  }

  function sessionBody(session) {
    const prediction = session ? store.getPrediction(session.user.id) : null;
    return { user: session?.user ?? null, csrfToken: session?.csrfToken ?? null, prediction,
      score: predictionScore(prediction), scoring: scoringMetadata() };
  }

  function requireSession(request) {
    const session = store.getSession(cookieToken(request, hosting.cookieName));
    if (!session) throw failure(401, 'Sign in to save your prediction.');
    if (!equalTokens(request.headers['x-csrf-token'], session.csrfToken)) {
      throw failure(403, 'Your sign-in check expired. Reload the page and try again.');
    }
    return session;
  }

  async function refreshStandings() {
    if (closed || !canRefresh) return scoringMetadata();
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const next = validateSnapshot(await provider());
        if (closed) return scoringMetadata();
        if (cachePath) saveSnapshot(cachePath, next);
        snapshot = next;
        refreshError = null;
      } catch {
        refreshError = snapshot
          ? 'Live NHL standings could not be refreshed. Scores use the last verified update.'
          : 'Live NHL standings could not be verified. Scores will appear after a verified 2026–27 update.';
      }
      return scoringMetadata();
    })();
    try { return await refreshing; } finally { refreshing = null; }
  }

  const updateScheduler = createDailyScheduler({ run: async()=>{await Promise.allSettled([refreshStandings(),refreshFantasy(),refreshRoster()]);}, now,
    setTimer: options.setTimer, clearTimer: options.clearTimer });

  const server = http.createServer({ maxHeaderSize: 8 * 1024 }, async (request, response) => {
    securityHeaders(response, hosting.secure);
    try {
      const { ip } = requestContext(request, hosting);
      if (hosting.secure) rateLimit(`requests:${ip}`, 600);
      if (!request.url.startsWith('/')) throw failure(400, 'Invalid request address.');
      const rawPath = request.url.split('?')[0];
      if (rawPath.includes('%') || rawPath.includes('\\') || rawPath.split('/').some(part => part === '.' || part === '..')) {
        throw failure(404, 'Page not found.');
      }
      const path = rawPath;
      if (path === '/api/health' && request.method === 'GET') {
        return json(response, 200, { ok: true, season: TARGET_SEASON });
      }
      if (path === '/api/session' && request.method === 'GET') {
        return json(response, 200, sessionBody(store.getSession(cookieToken(request, hosting.cookieName))));
      }
      if(path==='/api/fantasy/session'&&request.method==='GET')return json(response,200,fantasyBody(store.getSession(cookieToken(request,hosting.cookieName))));
      if(path==='/api/fantasy/value'&&request.method==='GET')return json(response,200,{...buildPlayerValues({...fantasyCatalog,players:pricedPlayers(fantasyCatalog,market).filter(player=>player.selectable!==false)},contractUpdater.getSnapshot()),roster:rosterMetadata(),market:marketMetadata(),updateSchedule:contractUpdater.metadata()});
      if(path==='/api/fantasy/weekly-players'&&request.method==='GET'){
        const query=new URLSearchParams(request.url.includes('?')?request.url.slice(request.url.indexOf('?')+1):'');
        const week=query.get('week')??'current';
        if(query.getAll('week').length>1||!['current','previous','month','year'].includes(week))throw failure(400,'Choose this week, last week, this month, or year to date.');
        return json(response,200,{season:FANTASY_SEASON,...weeklyTopPlayers(fantasyCatalog,fantasySnapshot,{week,now:now()}),scoring:fantasyMetadata()});
      }
      if(path==='/api/fantasy/players'&&request.method==='GET'){
        const totals=new Map(),currentTeams=new Map(),pending=new Set();
        for(const game of fantasySnapshot?.games??[]){for(const [id,value] of Object.entries(game.scores))totals.set(Number(id),(totals.get(Number(id))??0)+value);for(const [id,team] of Object.entries(game.teams))currentTeams.set(Number(id),team);for(const id of game.pending)pending.add(id);}
        return json(response,200,{...fantasyCatalog,budget:BUDGET,players:pricedPlayers(fantasyCatalog,market).map(p=>({...p,team:rosterSnapshot?p.team:currentTeams.get(p.id)??p.team,seasonPoints:fantasySnapshot?(totals.get(p.id)??0):null,pending:pending.has(p.id)})),roster:rosterMetadata(),scoring:fantasyMetadata(),market:marketMetadata()});
      }
      const playerGamesPath=/^\/api\/fantasy\/players\/([1-9]\d*)\/games$/.exec(path);
      if(playerGamesPath&&request.method==='GET'){
        const player=fantasyCatalog.players.find(p=>p.id===Number(playerGamesPath[1]));
        if(!player)throw failure(404,'This player was not found.');
        const games=playerGameLogs(fantasySnapshot,player.id);
        return json(response,200,{season:FANTASY_SEASON,player:{id:player.id,name:player.name,position:player.position,team:games[0]?.team??player.team},
          games,seasonPoints:fantasySnapshot?games.reduce((total,game)=>total+game.points,0):null,scoring:fantasyMetadata()});
      }
      if(path==='/api/fantasy/leaderboard'&&request.method==='GET'){
        const viewer=store.getSession(cookieToken(request,hosting.cookieName));
        if(!viewer||!store.getFantasy(viewer.user.id)?.submittedAt)return json(response,200,{season:FANTASY_SEASON,locked:true,entries:[],scoring:fantasyMetadata()});
        const entries=store.listFantasySubmitted().map(user=>{
          const history=store.fantasyHistory(user.id);
          const {points,pending,players}=scoreFantasyHistory(history,fantasySnapshot,{includeGameLogs:false});
          return {...user,playerIds:history.at(-1)?.playerIds??[],points,pending,players};
        }).sort((a,b)=>(b.points??-Infinity)-(a.points??-Infinity)||a.submittedAt.localeCompare(b.submittedAt));
        let rank=0;entries.forEach((entry,i)=>{if(entry.points!==null&&(i===0||Math.abs(entry.points-entries[i-1].points)>1e-7))rank=i+1;entry.rank=entry.points===null?null:rank;});
        return json(response,200,{season:FANTASY_SEASON,entries,scoring:fantasyMetadata()});
      }
      if((path==='/api/fantasy/roster'&&request.method==='PUT')||(path==='/api/fantasy/submit'&&request.method==='POST')){
        const session=requireSession(request),body=await readJSON(request);
        if(body.priceVersion!==market.version)throw failure(409,'Player prices changed. Reload the market and review your team.');
        if(path.endsWith('/submit'))store.submitFantasy(session.user.id,body.playerIds,body.revision,body.priceVersion);
        else store.saveFantasyDraft(session.user.id,body.playerIds,body.revision,body.priceVersion);
        return json(response,200,fantasyBody(session));
      }
      if ((['/api/register','/api/login','/api/fantasy/register','/api/fantasy/login'].includes(path)) && request.method === 'POST') {
        rateLimit(`auth:${ip}`, 30);
        if (path.endsWith('/register')) rateLimit(`register:${ip}`, 8);
        const body = await readJSON(request);
        const username = typeof body.username === 'string' ? body.username.toLowerCase() : '';
        if (path.endsWith('/login')) {
          rateLimit(`login:${ip}:${username.slice(0, 24)}`, 10);
          rateLimit(`account:${username.slice(0, 24)}`, 20);
        }
        const session = path.endsWith('/register') ? await store.register(body.username, body.password)
          : await store.login(body.username, body.password);
        // Rotate away a prior session when switching or signing in again.
        store.logout(cookieToken(request, hosting.cookieName));
        setSessionCookie(response, session.token, hosting);
        return json(response, 200, path.startsWith('/api/fantasy/')?fantasyBody(session):sessionBody(session));
      }
      if (path === '/api/logout' && request.method === 'POST') {
        requireSession(request);
        await readJSON(request);
        store.logout(cookieToken(request, hosting.cookieName));
        clearSessionCookie(response, hosting);
        return json(response, 200, { ok: true });
      }
      if ((path === '/api/prediction' && request.method === 'PUT')
        || (path === '/api/prediction/submit' && request.method === 'POST')) {
        const session = requireSession(request);
        const body = await readJSON(request);
        if (!Number.isSafeInteger(body.revision) || body.revision < 0) {
          throw failure(400, 'Reload your prediction before saving it.');
        }
        const prediction = path.endsWith('/submit')
          ? store.submitPrediction(session.user.id, body.teamIds, body.revision)
          : store.saveDraft(session.user.id, body.teamIds, body.revision);
        return json(response, 200, { prediction, score: predictionScore(prediction), scoring: scoringMetadata() });
      }
      if (path === '/api/leaderboard' && request.method === 'GET') {
        const viewer = store.getSession(cookieToken(request, hosting.cookieName));
        if (!viewer || store.getPrediction(viewer.user.id)?.state !== 'submitted') {
          return json(response, 200, { locked:true, entries:[], season:TARGET_SEASON });
        }
        const submitted = store.listSubmitted();
        const entries = snapshot ? rankEntries(submitted, snapshot)
          : submitted.map(entry => ({ ...entry, points: null, rank: null }));
        return json(response, 200, { locked:false, entries, scoring: scoringMetadata(), season: TARGET_SEASON });
      }
      if (path === '/api/standings' && request.method === 'GET') {
        return json(response, 200, { season: TARGET_SEASON, teams: snapshot?.teams ?? null, scoring: scoringMetadata() });
      }
      if (path.startsWith('/api/')) {
        if (['GET', 'POST', 'PUT'].includes(request.method)) throw failure(404, 'This action was not found.');
        response.setHeader('Allow', 'GET, POST, PUT');
        throw failure(405, 'This request method is not supported.');
      }
      const asset = STATIC_FILES.get(path);
      if (!asset) throw failure(404, 'Page not found.');
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        throw failure(405, 'This request method is not supported.');
      }
      const content = readFileSync(join(HERE, 'dist', asset[0]));
      response.statusCode = 200;
      response.setHeader('Content-Type', asset[1]);
      response.setHeader('Cache-Control', 'no-cache');
      response.setHeader('Content-Length', content.length);
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      request.resume();
      if (response.writableEnded || response.destroyed) return;
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 499 ? error.status : error.status === 503 ? 503 : 500;
      if (status === 429) response.setHeader('Retry-After', '600');
      if (status === 503) response.setHeader('Retry-After', '2');
      json(response, status, { error: status === 500 ? 'Something went wrong. Please try again.' : error.message });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  if (hosting.secure) server.maxConnections = 256;
  server.on('listening', () => {
    try{refreshMarket();}catch{}
    if(canRefreshContracts)contractUpdater.start();
    if (canRefresh || canRefreshFantasy || canRefreshRoster) {
      updateScheduler.start();
      // Restore missed noon updates after downtime, while reusing a current cache.
      if (!snapshot || Date.parse(snapshot.fetchedAt) < previousDailyUpdate(now())) void refreshStandings();
      if(!fantasySnapshot||Date.parse(fantasySnapshot.fetchedAt)<previousDailyUpdate(now()))void refreshFantasy();
      if(!rosterSnapshot||Date.parse(rosterSnapshot.fetchedAt)<previousDailyUpdate(now()))void refreshRoster();
    }
  });

  const admin = createLocalAdmin({
    canRefresh,
    refreshStandings,
    async manageAccount(userId, action, body) {
      if (action === 'rename') return store.adminRenameUser(userId, body.username, body.expectedUsername);
      if (action === 'password') return store.adminResetPassword(userId, body.password, body.expectedUsername);
      if (action === 'reset-prediction') return store.adminResetPrediction(userId, body.revision, body.expectedUsername);
      throw failure(404, 'This account action was not found.');
    },
    overview() {
      const accounts = store.listAccounts().map(account => ({ ...account, points: predictionScore(account.prediction) }));
      const submitted = store.listSubmitted();
      const address = server.address();
      return {
        season: TARGET_SEASON,
        summary: {
          accounts: accounts.length,
          drafts: accounts.filter(account => account.prediction?.state === 'draft').length,
          submitted: submitted.length,
        },
        accounts,
        scoring: scoringMetadata(),
        leaderboard: snapshot ? rankEntries(submitted, snapshot)
          : submitted.map(entry => ({ ...entry, points: null, rank: null })),
        teams: snapshot?.teams ?? null,
        server: { startedAt, canRefresh,
          updateSchedule: { time: UPDATE_TIME, timeZone: UPDATE_TIME_ZONE, nextUpdate: updateScheduler.getNextUpdate() },
          playerUrl: hosting.publicOrigin ? `${hosting.publicOrigin}/` : address && typeof address === 'object' ? `http://127.0.0.1:${address.port}/` : null },
      };
    },
  });

  async function close() {
    if (closed) return;
    closed = true;
    updateScheduler.stop();
    await contractUpdater.stop();
    await admin.close();
    if (server.listening) {
      await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
    }
    if (refreshing) await refreshing;
    if (fantasyRefreshing) await fantasyRefreshing;
    if (rosterRefreshing) await rosterRefreshing;
    store.close();
  }

  return { server, close, refreshStandings, refreshFantasy, refreshRoster, startAdmin: port => admin.start(port), publicOrigin: hosting.publicOrigin };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PLAYOFF_PICK_PORT ?? 8765);
  const adminPort = Number(process.env.PLAYOFF_PICK_ADMIN_PORT ?? 8766);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PLAYOFF_PICK_PORT must be between 1 and 65535.');
  if (!Number.isInteger(adminPort) || adminPort < 1 || adminPort > 65535) throw new Error('PLAYOFF_PICK_ADMIN_PORT must be between 1 and 65535.');
  if (port === adminPort) throw new Error('The player and administration pages need different ports.');
  const app = createApp();
  try {
    await new Promise((resolveStart, rejectStart) => {
      app.server.once('error', rejectStart);
      app.server.listen(port, '127.0.0.1', resolveStart);
    });
    const adminUrl = await app.startAdmin(adminPort);
    console.log(`Playoff Pick is ready at ${app.publicOrigin ?? `http://127.0.0.1:${port}`}/`);
    if (app.publicOrigin) console.log(`Backend listens only on 127.0.0.1:${port}; use the configured HTTPS reverse proxy.`);
    console.log(`Administration on this computer only: ${adminUrl}`);
  } catch {
    console.error('The local app could not start. Check whether its player or administration port is already in use.');
    await app.close();
    process.exitCode = 1;
  }
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
