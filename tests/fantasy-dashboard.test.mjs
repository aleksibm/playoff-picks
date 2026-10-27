import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as rules from '../dist/fantasy-rules.js';
import { renderTeamRink } from '../dist/fantasy-rink.js';

const source=readFileSync(new URL('../dist/fantasy.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'');
const page=readFileSync(new URL('../dist/fantasy.html',import.meta.url),'utf8');
const lineup=[1,2,3,4,5,6];
const players=Array.from({length:7},(_,i)=>({id:i+1,name:`Player ${i+1}`,position:['LW','C','RW','D','D','G','C'][i],team:'COL',price:1_000_000,lastPoints:100,games:80,seasonPoints:10}));
const scoring={available:true,fetchedAt:'2026-10-22T09:00:00.000Z',gameCount:12,stale:false,error:null};
const market={version:'verified-market',asOf:'2026-10-19T09:00:00.000Z'};
const guest={user:null,entry:null,score:{points:null,players:{},playerGames:{}},scoring,csrfToken:null};
const account=(id=1,{submitted=true,ids=lineup}={})=>({
  user:{id,displayName:`Fan${id}`},csrfToken:`csrf-${id}`,market,scoring,
  entry:{playerIds:[...ids],activePlayerIds:submitted?[...ids]:[],submittedAt:submitted?'2026-10-10T17:00:00.000Z':null,revision:1,cashBalance:34_000_000,transfers:{remaining:2,used:0,month:'2026-10'}},
  score:{points:submitted?14:null,pending:false,players:submitted?{1:10,2:0,6:-2,7:6}:{},playerGames:submitted?{1:[{gameId:2026020001,date:'2026-10-20',startTime:'2026-10-20T18:00:00Z',team:'COL',opponent:'DAL',points:10,pending:false}]}:{}},
});
const rankingBounds={
  current:{start:'2026-10-18T21:00:00.000Z',end:'2026-10-25T22:00:00.000Z'},
  previous:{start:'2026-10-11T21:00:00.000Z',end:'2026-10-18T21:00:00.000Z'},
  month:{start:'2026-09-30T21:00:00.000Z',end:'2026-10-22T10:00:00.000Z'},
  year:{start:'2025-12-31T22:00:00.000Z',end:'2026-10-22T10:00:00.000Z'},
};
const weekly=(key='current',name=`${key} leader`,options={})=>({season:'20262027',week:{key,...rankingBounds[key],timeZone:'Europe/Helsinki'},players:[{...players[0],name,rank:1,points:12.5,games:2,pending:false}],scoring,...options});
const response=(data,status=200)=>({ok:status<400,status,json:async()=>structuredClone(data)});
const settle=async()=>{for(let i=0;i<3;i++)await new Promise(resolve=>setImmediate(resolve));};
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function target(dataset={},id=''){
  return {dataset,id,closest(selector){const name=/^\[data-([\w-]+)\]$/.exec(selector)?.[1]?.replace(/-([a-z])/g,(_,c)=>c.toUpperCase());return name&&Object.hasOwn(dataset,name)?this:null;}};
}

// Execute the shipped module, replacing browser I/O only. Visibility and event
// assertions exercise the real account/editor transitions without a browser.
async function dashboard({session=guest,route}={}){
  const elements=new Map(),listeners=new Map(),calls=[];
  class Element{
    constructor(id){
      this.id=id;this.value='';this.hidden=false;this.disabled=false;this.textContent='';this.dataset={};this.style={};this.attributes={};this.events=new Map();this.html='';this.open=false;this.checked=false;
      const classes=new Set();
      this.classList={toggle(name,force){const enabled=force===undefined?!classes.has(name):force;if(enabled)classes.add(name);else classes.delete(name);return enabled;},add(...names){names.forEach(name=>classes.add(name));},remove(...names){names.forEach(name=>classes.delete(name));},contains:name=>classes.has(name)};
    }
    set innerHTML(value){this.html=value;for(const match of value.matchAll(/\bid="([^"]+)"/g))if(!elements.has(match[1]))elements.set(match[1],new Element(match[1]));}
    get innerHTML(){return this.html;}
    setAttribute(name,value){this.attributes[name]=String(value);}
    removeAttribute(name){delete this.attributes[name];}
    addEventListener(name,callback){this.events.set(name,callback);}
    querySelectorAll(selector){
      if(this.id==='role-filters'&&selector==='button')return ['all','F','D','G'].map(role=>({dataset:{role},setAttribute(){}}));
      if(selector==='details[open]')return [...this.html.matchAll(/<details\b([^>]+)>/g)].filter(match=>/\sopen(?:\s|$)/.test(match[1])).map(match=>({dataset:{contribution:/data-contribution="([^"]+)"/.exec(match[1])?.[1]}}));
      return [];
    }
    querySelector(){return null;}
    showModal(){this.open=true;}
    close(){if(!this.open)return;this.open=false;this.events.get('close')?.({});}
    focus(){this.focused=true;}
    scrollIntoView(){this.scrolled=true;}
  }
  for(const match of page.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)){
    const element=new Element(match[1]);element.hidden=/\shidden(?:\s|>)/.test(match[0]);element.open=/\sopen(?:\s|>)/.test(match[0]);elements.set(match[1],element);
  }
  const nav=new Element('section-nav-link');
  elements.get('player-sort').value='value-desc';
  if(elements.has('weekly-period'))elements.get('weekly-period').value='current';
  const context=vm.createContext({
    ...rules,renderTeamRink,Map,Set,AbortSignal,URL,URLSearchParams,console,
    setTimeout(){return 1;},clearTimeout(){},setInterval(){},
    document:{hidden:false,getElementById:id=>elements.get(id),querySelector:()=>nav,querySelectorAll:()=>[],addEventListener:(name,callback)=>listeners.set(name,callback)},
    window:{addEventListener(){}},
    fetch:async(path,options={})=>{
      calls.push({path,...options,body:options.body?JSON.parse(options.body):undefined});
      const handled=await route?.(path,options);if(handled!==undefined)return handled;
      if(path==='/api/fantasy/players')return response({players,market,scoring});
      if(path==='/api/fantasy/session'||path==='/api/fantasy/login'||path==='/api/fantasy/register')return response(session);
      if(path==='/api/fantasy/leaderboard')return response({locked:!session.entry?.submittedAt,entries:[],scoring});
      if(path.startsWith('/api/fantasy/weekly-players'))return response(weekly(new URL(path,'https://hockey.example').searchParams.get('week')??'current'));
      if(path==='/api/logout')return response({ok:true});
      return response({error:'Unexpected test request'},404);
    },
  });
  vm.runInContext(source,context,{filename:'fantasy.js'});await settle();
  return {elements,calls,run:code=>vm.runInContext(code,context),
    state:()=>JSON.parse(vm.runInContext('JSON.stringify({draft,session})',context)),
    async fire(id,name='click',event={}){assert.ok(elements.get(id)?.events.has(name),`${id} has a ${name} handler`);const result=elements.get(id).events.get(name)({preventDefault(){},target:elements.get(id),...event});await result;await settle();},
  };
}

test('the dashboard and a fresh sign-in keep the market closed until Edit team is clicked',async()=>{
  const signedIn=account(1,{submitted:false,ids:[]});
  const b=await dashboard({route:path=>path==='/api/fantasy/login'?response(signedIn):undefined});
  assert.equal(b.elements.get('fantasy-picker').hidden,true);assert.equal(b.elements.get('market').hidden,true);
  b.elements.get('fantasy-username').value='Fan1';b.elements.get('fantasy-password').value='fantasy-test-password';
  await b.fire('fantasy-auth-form','submit');
  assert.equal(b.elements.get('fantasy-picker').hidden,false);assert.equal(b.elements.get('market').hidden,true);
  await b.fire('edit-team');assert.equal(b.elements.get('market').hidden,false);
  assert.equal(b.elements.get('team-edit-actions').hidden,false);
});

test('rink actions cannot edit a closed dashboard and Done keeps the unfinished draft',async()=>{
  const b=await dashboard({session:account()});
  assert.equal(b.elements.get('market').hidden,true);
  await b.fire('roster-slots','click',{target:target({replace:'1'})});
  await b.fire('roster-slots','click',{target:target({remove:'1'})});
  b.run('choosePlayer(1)');assert.deepEqual(b.state().draft,lineup);
  assert.equal(b.elements.get('market').hidden,true);
  await b.fire('edit-team');
  await b.fire('roster-slots','click',{target:target({remove:'1'})});
  assert.deepEqual(b.state().draft,[2,3,4,5,6]);
  await b.fire('done-editing');
  assert.equal(b.elements.get('market').hidden,true);assert.equal(b.elements.get('team-edit-actions').hidden,true);
  assert.deepEqual(b.state().draft,[2,3,4,5,6]);
  await b.fire('edit-team');assert.deepEqual(b.state().draft,[2,3,4,5,6]);
});

test('a successful confirmed team submission closes the editor',async()=>{
  const draft=account(1,{submitted:false}),submitted=account();
  let current=draft;
  const b=await dashboard({session:draft,route:path=>{
    if(path==='/api/fantasy/submit'){current=submitted;return response(current);}
    if(path==='/api/fantasy/session')return response(current);
    if(path==='/api/fantasy/leaderboard')return response({locked:!current.entry.submittedAt,entries:[],scoring});
  }});
  await b.fire('edit-team');await b.fire('submit-roster');
  assert.equal(b.elements.get('fantasy-submit-dialog').open,true);
  await b.fire('confirm-fantasy-submit');
  assert.equal(b.elements.get('fantasy-submit-dialog').open,false);
  assert.equal(b.elements.get('market').hidden,true);assert.equal(b.state().session.entry.submittedAt,submitted.entry.submittedAt);
  assert.equal(b.calls.filter(call=>call.path==='/api/fantasy/submit').length,1);
});

test('player contributions start collapsed and the score link opens them without opening the market',async()=>{
  const b=await dashboard({session:account()});
  assert.equal(b.elements.get('fantasy-contributions').hidden,false);assert.equal(b.elements.get('fantasy-contributions').open,false);
  await b.fire('view-contributions');
  assert.equal(b.elements.get('fantasy-contributions').open,true);assert.equal(b.elements.get('market').hidden,true);
  assert.match(b.elements.get('contribution-list').innerHTML,/Transferred out/);
});

test('logout and switching accounts close the editor and personal contribution disclosure',async()=>{
  const b=await dashboard({session:account()});
  await b.fire('edit-team');await b.fire('view-contributions');
  await b.fire('fantasy-auth','click',{target:target({},'fantasy-logout')});
  assert.equal(b.elements.get('market').hidden,true);assert.equal(b.elements.get('fantasy-contributions').open,false);
  assert.equal(b.elements.get('fantasy-contributions').hidden,true);assert.equal(b.elements.get('contribution-list').innerHTML,'');
  let next=account(1);
  const switched=await dashboard({route:path=>path==='/api/fantasy/session'?response(next):undefined});
  await switched.fire('edit-team');await switched.fire('view-contributions');
  next=account(2);await switched.run('personal()');
  assert.equal(switched.state().session.user.id,2);assert.equal(switched.elements.get('market').hidden,true);
  assert.equal(switched.elements.get('fantasy-contributions').open,false);
});

test('weekly selection ignores an older response and escapes player names',async()=>{
  const previous=deferred(),current=deferred();let intercept=false;
  const b=await dashboard({route:path=>intercept&&path.startsWith('/api/fantasy/weekly-players')?(path.includes('week=previous')?previous.promise:current.promise):undefined});
  intercept=true;b.elements.get('weekly-period').value='previous';
  const earlier=b.fire('weekly-period','change');await settle();
  b.elements.get('weekly-period').value='current';const latest=b.fire('weekly-period','change');await settle();
  const unsafe='<img src=x onerror=alert(1)>';
  current.resolve(response(weekly('current',unsafe)));await latest;await settle();
  previous.resolve(response(weekly('previous','Old previous leader')));await earlier;await settle();
  const html=b.elements.get('weekly-player-list').innerHTML;
  assert.ok(!html.includes('<img src=x'));assert.match(html,/&lt;img src=x/);assert.doesNotMatch(html,/Old previous leader/);
  assert.equal(b.elements.get('weekly-period').value,'current');
});

test('weekly empty and unavailable results are honest, and failures clear previous player rows',async()=>{
  let result=weekly();
  const b=await dashboard({route:path=>path.startsWith('/api/fantasy/weekly-players')?response(result):undefined});
  assert.match(b.elements.get('weekly-player-list').innerHTML,/current leader/);
  result=weekly('current','',{players:[]});await b.fire('refresh-weekly');
  assert.doesNotMatch(b.elements.get('weekly-player-list').innerHTML,/current leader/);
  assert.match(b.elements.get('weekly-player-list').innerHTML,/no.*(?:game|player|appearance|point)|await/i);
  result=weekly('current','',{players:[],scoring:{available:false,error:'Awaiting verified NHL statistics.'}});await b.fire('refresh-weekly');
  assert.match(b.elements.get('weekly-player-list').innerHTML+' '+b.elements.get('weekly-player-status').textContent,/await|unavailable|not.*available/i);
  const broken=await dashboard({route:path=>path.startsWith('/api/fantasy/weekly-players')?response({error:'<img src=x onerror=alert(1)> Unavailable'},503):undefined});
  assert.ok(!broken.elements.get('weekly-player-list').innerHTML.includes('<img src=x'));
  assert.match(broken.elements.get('weekly-player-list').innerHTML+' '+broken.elements.get('weekly-player-status').textContent,/could not|unavailable|failed/i);
});

test('month and year-to-date options request their period and show clear headings, ranges and season coverage',async()=>{
  assert.match(page,/<option value="month">This month<\/option>/);
  assert.match(page,/<option value="year">Year to date<\/option>/);
  const b=await dashboard();
  b.elements.get('weekly-period').value='month';await b.fire('weekly-period','change');
  assert.ok(b.calls.some(call=>call.path==='/api/fantasy/weekly-players?week=month'));
  assert.equal(b.elements.get('weekly-players-title').textContent,'Players of the month.');
  assert.match(b.elements.get('weekly-week-label').textContent,/1 Oct 2026.*22 Oct 2026.*Month to date.*Helsinki/);
  assert.match(b.elements.get('weekly-description').textContent,/this month so far/);
  assert.match(b.elements.get('weekly-player-list').innerHTML,/month leader/);
  assert.match(b.elements.get('weekly-player-list').innerHTML,/<caption[^>]*>[^<]*this month so far/);
  b.elements.get('weekly-period').value='year';await b.fire('weekly-period','change');
  assert.ok(b.calls.some(call=>call.path==='/api/fantasy/weekly-players?week=year'));
  assert.equal(b.elements.get('weekly-players-title').textContent,'This year’s leaders.');
  assert.match(b.elements.get('weekly-week-label').textContent,/1 Jan 2026.*22 Oct 2026.*Year to date.*Helsinki/);
  assert.match(b.elements.get('weekly-description').textContent,/this year so far.*2026–27 regular-season games only/);
  assert.match(b.elements.get('weekly-player-list').innerHTML,/year leader/);
  assert.doesNotMatch(b.elements.get('weekly-player-list').innerHTML,/selected Helsinki calendar week/);
});

test('a slower monthly response cannot overwrite the selected year-to-date ranking',async()=>{
  const month=deferred(),year=deferred();let intercept=false;
  const b=await dashboard({route:path=>intercept&&path.startsWith('/api/fantasy/weekly-players')?(path.includes('week=month')?month.promise:year.promise):undefined});
  intercept=true;b.elements.get('weekly-period').value='month';await b.fire('weekly-period','change');
  assert.match(b.elements.get('weekly-week-label').textContent,/Month to date/);
  assert.match(b.elements.get('weekly-player-list').innerHTML,/this month so far/);
  b.elements.get('weekly-period').value='year';await b.fire('weekly-period','change');
  assert.match(b.elements.get('weekly-week-label').textContent,/Year to date/);
  assert.match(b.elements.get('weekly-description').textContent,/2026–27 regular-season games only/);
  year.resolve(response(weekly('year','Year leader')));await settle();
  month.resolve(response(weekly('month','Outdated monthly leader')));await settle();
  assert.equal(b.elements.get('weekly-period').value,'year');
  assert.match(b.elements.get('weekly-player-list').innerHTML,/Year leader/);
  assert.doesNotMatch(b.elements.get('weekly-player-list').innerHTML,/Outdated monthly leader/);
  assert.match(b.elements.get('weekly-week-label').textContent,/Year to date/);
});

test('monthly empty results and year-to-date errors keep the selected period without stale rows',async()=>{
  const b=await dashboard({route:path=>{
    if(path.endsWith('week=month'))return response(weekly('month','',{players:[]}));
    if(path.endsWith('week=year'))return response({error:'Ranking cache unavailable'},503);
  }});
  assert.match(b.elements.get('weekly-player-list').innerHTML,/current leader/);
  b.elements.get('weekly-period').value='month';await b.fire('weekly-period','change');
  assert.match(b.elements.get('weekly-player-list').innerHTML,/No completed appearances.*this month so far/);
  assert.doesNotMatch(b.elements.get('weekly-player-list').innerHTML,/current leader/);
  b.elements.get('weekly-period').value='year';await b.fire('weekly-period','change');
  assert.equal(b.elements.get('weekly-period').value,'year');
  assert.match(b.elements.get('weekly-player-list').innerHTML,/this year so far could not be loaded/);
  assert.match(b.elements.get('weekly-player-status').textContent,/Ranking cache unavailable/);
  assert.match(b.elements.get('weekly-description').textContent,/2026–27 regular-season games only/);
  assert.equal(b.elements.get('refresh-weekly').textContent,'Retry players ↻');
});

test('the player market includes new $100k players and excludes unavailable players without losing held lineups or logs',async()=>{
  const pool=players.map(p=>p.id===1?{...p,selectable:false}:p.id===7?{...p,name:'New NHL arrival',price:100_000,lastPoints:0,games:0,newcomer:true}:p);
  pool.push({...players[0],id:8,name:'Former NHL player',selectable:false});
  const b=await dashboard({session:account(),route:path=>{
    if(path==='/api/fantasy/players')return response({players:pool,market,scoring});
    if(path==='/api/fantasy/players/1/games')return response({games:[],seasonPoints:10,scoring});
  }});
  assert.deepEqual(b.state().draft,lineup);
  assert.match(b.elements.get('roster-slots').innerHTML,/Player 1/);
  assert.match(b.elements.get('roster-slots').innerHTML,/Unavailable for new picks/);
  assert.match(b.elements.get('contribution-list').innerHTML,/Player 1/);
  await b.fire('edit-team');
  const html=b.elements.get('player-list').innerHTML;
  assert.match(html,/New NHL arrival/);assert.match(html,/\$100K/);assert.match(html,/New to market/);
  assert.doesNotMatch(html,/Former NHL player|data-player="1"/);
  assert.equal(b.elements.get('player-count').textContent,'6 players');
  b.run('choosePlayer(8)');assert.deepEqual(b.state().draft,lineup);
  assert.match(b.elements.get('fantasy-toast').textContent,/unavailable for new picks/);
  await b.fire('roster-slots','click',{target:target({games:'1'})});
  assert.equal(b.elements.get('player-games-dialog').open,true);assert.equal(b.elements.get('player-games-title').textContent,'Player 1');
  await b.fire('roster-slots','click',{target:target({remove:'1'})});
  b.run('choosePlayer(7)');assert.deepEqual(b.state().draft,[2,3,4,5,6,7]);
});

test('a draft whose unconfirmed player becomes unavailable must replace that player before saving or entering',async()=>{
  const pool=players.map(p=>p.id===1?{...p,selectable:false}:p);
  const b=await dashboard({session:account(1,{submitted:false}),route:path=>path==='/api/fantasy/players'?response({players:pool,market,scoring}):undefined});
  await b.fire('edit-team');
  assert.deepEqual(b.state().draft,lineup);
  assert.equal(b.elements.get('save-roster').disabled,true);assert.equal(b.elements.get('submit-roster').disabled,true);
  assert.match(b.elements.get('roster-guidance').textContent,/Replace them/);
  await b.fire('roster-slots','click',{target:target({remove:'1'})});b.run('choosePlayer(7)');
  assert.equal(b.elements.get('save-roster').disabled,false);assert.equal(b.elements.get('submit-roster').disabled,false);
});

test('player availability refresh errors are shown as text while the last verified market remains usable',async()=>{
  const error='<img src=x onerror=alert(1)> Roster service unavailable';
  const b=await dashboard({session:account(),route:path=>path==='/api/fantasy/players'?response({players,market,scoring,roster:{available:true,fetchedAt:'2026-10-21T09:00:00.000Z',stale:true,error}}):undefined});
  const note=b.elements.get('market-roster-note');
  assert.equal(note.hidden,false);assert.match(note.textContent,/update overdue/);assert.match(note.textContent,/Roster service unavailable/);assert.equal(note.innerHTML,'');
  await b.fire('edit-team');assert.match(b.elements.get('player-list').innerHTML,/Player 7/);
});

test('league managers expand into full-width positional rinks and their game logs remain available',async()=>{
  const entries=[{id:1,displayName:'Fan1',playerIds:lineup,rank:1,points:14,submittedAt:'2026-10-10T17:00:00Z'},{id:2,displayName:'Other <manager>',playerIds:[7,2,3,4,5,6],rank:2,points:10,submittedAt:'2026-10-10T17:00:00Z'}];
  const b=await dashboard({session:account(),route:path=>{
    if(path==='/api/fantasy/leaderboard')return response({locked:false,entries,scoring});
    if(path==='/api/fantasy/players/7/games')return response({games:[],seasonPoints:0,scoring});
  }});
  assert.match(b.elements.get('fantasy-leaderboard').innerHTML,/Other &lt;manager&gt;/);
  assert.match(b.elements.get('fantasy-leaderboard').innerHTML,/id="league-team-2" class="team-detail-row" hidden/);
  await b.fire('fantasy-leaderboard','click',{target:target({manager:'2'})});
  const html=b.elements.get('fantasy-leaderboard').innerHTML;
  assert.match(html,/id="league-team-2" class="team-detail-row"><td colspan="3">/);
  assert.match(html,/aria-expanded="true" aria-controls="league-team-2"/);
  assert.match(html,/class="rink-scene"/);assert.match(html,/Player 7/);
  await b.fire('fantasy-leaderboard','click',{target:target({games:'7'})});
  assert.equal(b.elements.get('player-games-dialog').open,true);assert.equal(b.elements.get('player-games-title').textContent,'Player 7');
  await b.fire('fantasy-leaderboard','click',{target:target({manager:'2'})});
  assert.match(b.elements.get('fantasy-leaderboard').innerHTML,/id="league-team-2" class="team-detail-row" hidden/);
});

test('game logs display compact stats and total points without an expandable scoring breakdown',async()=>{
  const total=5+20/3+.75+5;
  const game={gameId:2026020001,date:'2026-10-20',startTime:'2026-10-20T18:00:00Z',team:'COL',opponent:'DAL',points:total,pending:false,stats:{goals:1,assists:2,shots:3,hits:0,blocks:0,faceoffWins:0,faceoffLosses:0,penaltyMinutes:0,defenseMultiplier:1},breakdown:[{key:'goals',label:'Goals <unsafe>',value:1,points:5},{key:'assists',label:'Assists',value:2,points:20/3},{key:'shots',label:'Shots',value:3,points:.75},{key:'win',label:'Team win',value:true,points:5}]};
  const legacy={...game,gameId:2026020002,stats:null,breakdown:null,points:4};
  const user=account();user.score={points:total,pending:false,players:{1:total},playerGames:{1:[game]}};
  const b=await dashboard({session:user,route:path=>path==='/api/fantasy/players/1/games'?response({games:[game,legacy],seasonPoints:total+4,scoring}):undefined});
  await b.fire('weekly-player-list','click',{target:target({games:'1'})});
  const html=b.elements.get('player-games-content').innerHTML;
  assert.match(html,/GAME STATS/);assert.match(html,/title="Goals">G<\/abbr> <b>1<\/b>/);assert.match(html,/title="Assists">A<\/abbr> <b>2<\/b>/);
  assert.doesNotMatch(html,/How the points add up|game-breakdown|Game total|<unsafe>/);assert.match(html,/17\.42/);
  assert.match(html,/Game stats await a verified refresh/);assert.match(html,/FOR YOU/);
});

test('player popups show signed weekly dollar and percentage changes, including unchanged and unavailable prices',async()=>{
  for(const [amount,percent,label,className] of [[50_000,5,'+$50,000','positive-value'],[-50_000,-5,'-$50,000','negative-points'],[0,0,'$0','']]){
    const b=await dashboard({route:path=>path==='/api/fantasy/players/1/games'?response({player:{...players[0],price:1_000_000+amount},games:[],seasonPoints:0,priceChange:{amount,percent},scoring}):undefined});
    await b.fire('weekly-player-list','click',{target:target({games:'1'})});
    const html=b.elements.get('player-games-summary').innerHTML;
    assert.ok(html.includes(label));assert.ok(html.includes(`${percent>0?'+':''}${percent.toFixed(2)}%`));
    assert.match(html,/CURRENT VALUE/);assert.match(html,/WEEKLY VALUE CHANGE/);
    if(className)assert.ok(html.includes(className));
    assert.doesNotMatch(html,/Available after/);
  }
  const b=await dashboard({route:path=>path==='/api/fantasy/players/1/games'?response({player:players[0],games:[],seasonPoints:0,priceChange:null,scoring}):undefined});
  await b.fire('weekly-player-list','click',{target:target({games:'1'})});
  assert.match(b.elements.get('player-games-summary').innerHTML,/Available after the next weekly update/);
  assert.doesNotMatch(b.elements.get('player-games-summary').innerHTML,/0\.00%/);
});

test('player popups distinguish last-week NHL and fantasy points, show Helsinki dates, and preserve provisional negative totals',async()=>{
  const lastWeek={start:'2026-10-18T21:00:00Z',end:'2026-10-25T22:00:00Z',nhlPoints:4,fantasyPoints:41,pending:false};
  const b=await dashboard({route:path=>path==='/api/fantasy/players/1/games'?response({games:[],seasonPoints:80,lastWeek,scoring}):undefined});
  await b.fire('weekly-player-list','click',{target:target({games:'1'})});
  const html=b.elements.get('player-games-summary').innerHTML;
  assert.match(html,/LAST WEEK · NHL POINTS<\/span><strong>4<\/strong>/);
  assert.match(html,/LAST WEEK · FANTASY POINTS<\/span><strong class="">41<\/strong>/);
  assert.match(html,/Goals \+ assists/);assert.match(html,/19 Oct – 25 Oct · Helsinki time/);
  const pending=await dashboard({route:path=>path==='/api/fantasy/players/6/games'?response({games:[],seasonPoints:-2,lastWeek:{...lastWeek,nhlPoints:0,fantasyPoints:-2,pending:true},scoring}):undefined});
  await pending.fire('roster-slots','click',{target:target({games:'6'})});
  assert.match(pending.elements.get('player-games-summary').innerHTML,/negative-points">-2\*/);
  assert.match(pending.elements.get('player-games-summary').innerHTML,/Provisional GSAx/);
  const missing=await dashboard({route:path=>path==='/api/fantasy/players/1/games'?response({games:[],seasonPoints:80,lastWeek:{...lastWeek,nhlPoints:null,fantasyPoints:null},scoring}):undefined});
  await missing.fire('weekly-player-list','click',{target:target({games:'1'})});
  assert.match(missing.elements.get('player-games-summary').innerHTML,/LAST WEEK · NHL POINTS<\/span><strong>—<\/strong>/);
  assert.match(missing.elements.get('player-games-summary').innerHTML,/Awaiting verified game stats/);
});

test('pending goalie adjustments stay visibly pending and demo snapshots are clearly labeled',async()=>{
  const demoScoring={...scoring,demo:true};
  const game={gameId:2026020001,date:'2026-10-20',startTime:'2026-10-20T18:00:00Z',team:'COL',opponent:'DAL',points:6.25,pending:true,stats:{saves:28,goalsAgainst:3,shutouts:0,gsax:null},breakdown:[{key:'saves',label:'Saves',value:28,points:17.5},{key:'against',label:'Goals conceded',value:3,points:-11.25},{key:'gsax',label:'Goals saved above expected',value:null,points:null,pending:true}]};
  const b=await dashboard({session:account(),route:path=>{
    if(path==='/api/fantasy/players')return response({players,market,scoring:demoScoring});
    if(path==='/api/fantasy/players/6/games')return response({games:[game],seasonPoints:6.25,scoring:demoScoring});
  }});
  assert.equal(b.elements.get('fantasy-demo-note').hidden,false);
  await b.fire('roster-slots','click',{target:target({games:'6'})});
  const html=b.elements.get('player-games-content').innerHTML;
  assert.match(html,/title="Saves">SV<\/abbr> <b>28<\/b>/);assert.match(html,/Pending/);assert.match(html,/6\.25\*/);
  assert.match(b.elements.get('player-games-status').textContent,/Preview test data/);
});
