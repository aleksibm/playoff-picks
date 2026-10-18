import { BUDGET, SLOTS, money, points, playerRole, rosterProgress } from './fantasy-rules.js';

const $=id=>document.getElementById(id);
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const STORAGE='playoff-fantasy-guest-20262027';
let catalog=[],byId=new Map(),draft=[],session={user:null,entry:null,score:{points:null},csrfToken:null},loaded=false,busy=false,role='all',replacing=null,limit=12,authMode='login',confirmation=null,toastTimer,league=[];
let feed=null,marketError=null,authGeneration=0;
const same=(a,b)=>a.length===b.length&&a.every(id=>b.includes(id));
const active=()=>session.entry?.activePlayerIds??[];
const changes=()=>active().length?draft.filter(id=>!active().includes(id)).length:0;
const dirty=()=>!same(draft,session.entry?.playerIds??[]);
const initials=name=>name.split(' ').map(x=>x[0]).slice(0,2).join('');
function toast(message){$('fantasy-toast').textContent=message;$('fantasy-toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('fantasy-toast').hidden=true,5500);}
async function api(path,method='GET',body){
  const response=await fetch(path,{method,credentials:'same-origin',headers:{...(body?{'Content-Type':'application/json'}:{}),...(session.csrfToken?{'X-CSRF-Token':session.csrfToken}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
  const data=await response.json();
  if(!response.ok){const error=new Error(data.error??'The request could not be completed.');error.status=response.status;throw error;}
  return data;
}
function rememberGuest(){if(session.user)return;try{localStorage.setItem(STORAGE,JSON.stringify(draft));}catch{/* The in-memory draft still works. */}}
function choosePlayer(id){
  if(busy||!loaded)return;
  const p=byId.get(id);if(!p)return;
  if(draft.includes(id)){draft=draft.filter(x=>x!==id);if(replacing===id)replacing=null;rememberGuest();render();return;}
  let next=draft.filter(x=>x!==replacing);next.push(id);
  const progress=rosterProgress(next,byId);
  if(!progress.valid){toast('That selection exceeds your budget or the available position spots.');return;}
  draft=next;replacing=null;rememberGuest();render();
}
function renderMarket(){
  const term=$('player-search').value.trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const sort=$('player-sort').value,progress=rosterProgress(draft,byId);
  $('market-points-heading').textContent=sort==='current'?'THIS SEASON':'LAST SEASON';
  const available=progress.remaining+(byId.get(replacing)?.price??0);
  let filtered=catalog.filter(p=>(role==='all'||playerRole(p)===role)&&(!term||`${p.name} ${p.team}`.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().includes(term))&&(!$('affordable').checked||p.price<=available||draft.includes(p.id)));
  filtered.sort(sort==='name'?(a,b)=>a.name.localeCompare(b.name):sort==='value-asc'?(a,b)=>a.price-b.price:sort==='current'?(a,b)=>(b.seasonPoints??-Infinity)-(a.seasonPoints??-Infinity)||b.price-a.price:(a,b)=>b.price-a.price);
  $('player-count').textContent=`${filtered.length.toLocaleString()} player${filtered.length===1?'':'s'}`;
  $('market-model-note').hidden=sort!=='current'||!filtered.some(p=>p.pending);
  $('role-filters').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.role===role)));
  $('player-list').setAttribute('aria-busy',String(!loaded));
  $('player-list').innerHTML=filtered.slice(0,limit).map(p=>{
    const selected=draft.includes(p.id),valid=rosterProgress([...draft.filter(x=>x!==replacing),p.id],byId).valid;
    const disabled=busy||(!selected&&!valid);
    const why=selected?'Remove':p.price>available?'Over budget:':'Position full:';
    return `<div class="player-row${selected?' selected':''}"><div class="player-identity"><span class="player-avatar" aria-hidden="true">${esc(initials(p.name))}</span><div><strong>${esc(p.name)}</strong><small>${esc(p.team)} · ${esc(p.position)} · ${p.games} GP</small></div></div><span class="player-stat" title="${sort==='current'?'2026–27':'2025–26'} fantasy points${sort==='current'&&p.pending?' · Provisional GSAx':''}">${points(sort==='current'?p.seasonPoints:p.lastPoints)}${sort==='current'&&p.pending?'*':''}</span><span class="player-price">${money(p.price)}</span><button class="add-player" type="button" data-player="${p.id}" aria-pressed="${selected}" aria-label="${selected?'Remove':valid?'Add':why} ${esc(p.name)}${replacing&&!selected?' as replacement':''}" title="${selected?'Remove player':valid?'Add player':p.price>available?'Over budget':'Replace a player in this position first'}"${disabled?' disabled':''}>${selected?'✓':'+'}</button></div>`;
  }).join('')||`<p class="market-empty">${marketError?'The player market could not be loaded. Reload the page to retry.':'No players match. Try another search or turn off “Within budget”.'}</p>`;
  $('load-more').hidden=filtered.length<=limit;$('load-more').disabled=busy;
  $('replacement-note').hidden=!replacing;
  $('replacement-note').textContent=replacing?`Replacing ${byId.get(replacing)?.name}. Choose another ${playerRole(byId.get(replacing))==='F'?'attacker':playerRole(byId.get(replacing))==='D'?'defenseman':'goalie'} from the market.`:'';
}
function renderRoster(){
  const progress=rosterProgress(draft,byId),pools={F:[],D:[],G:[]};
  for(const id of draft){const p=byId.get(id);if(p)pools[playerRole(p)].push(p);}
  const attackers=[null,null,null],overflow=[];
  for(const p of pools.F){const spot=p.position==='LW'?0:p.position==='RW'?2:1;if(!attackers[spot])attackers[spot]=p;else overflow.push(p);}
  for(const p of overflow)attackers[attackers.indexOf(null)]=p;
  pools.F=attackers;
  $('roster-slots').innerHTML=SLOTS.map(slot=>{
    const p=pools[slot.role].shift();
    return `<div class="roster-slot"><div class="slot-role">${slot.role==='F'?'ATTACK':slot.role==='D'?'DEFENSE':'GOALIE'}</div><button type="button" class="slot-main${p?' filled':''}${p?.id===replacing?' replacing':''}" ${p?`data-replace="${p.id}"`:`data-empty-role="${slot.role}"`} aria-label="${p?`Replace ${esc(p.name)}`:`Choose ${slot.label.toLowerCase()}`}"${busy?' disabled':''}>${p?`<span aria-hidden="true">${esc(p.team)}</span><strong>${esc(p.name)}</strong><small>${money(p.price)}</small>`:`<span class="slot-plus" aria-hidden="true">+</span><strong>${slot.label}</strong><small>CHOOSE PLAYER</small>`}</button>${p?`<button class="slot-remove" type="button" data-remove="${p.id}" aria-label="Remove ${esc(p.name)}"${busy?' disabled':''}>×</button>`:''}</div>`;
  }).join('');
  $('budget-left').textContent=money(progress.remaining);$('budget-spent').textContent=`${money(progress.cost)} spent`;
  $('budget-bar').style.width=`${Math.min(100,progress.cost/BUDGET*100)}%`;
  $('roster-count').textContent=`${draft.length} of 6 selected`;
  const entered=Boolean(session.entry?.submittedAt),transfers=session.entry?.transfers;
  $('draft-state').textContent=entered?(same(draft,active())?'In competition':'Changes pending'):dirty()?'Unsaved draft':'Draft';
  $('reset-roster').textContent=entered?'Reset changes':'Clear draft';$('reset-roster').disabled=busy||!draft.length&&!active().length;
  $('transfer-status').textContent=entered?`${transfers.remaining} of 2 transfers available · ${transfers.month} · Resets monthly in Helsinki. No rollover.`:'First team selection is free. Then two transfers each calendar month, with no rollover.';
  const overTransfers=entered&&changes()>(transfers?.remaining??0);
  let guidance=!loaded?'Loading your team…':progress.complete?entered?changes()?`${changes()} player replacement${changes()===1?'':'s'} ready to confirm.`:'Your team is in the competition. Replace a player to plan a transfer.':'Your six are ready. Enter the competition to start earning points.':`Still to choose: ${3-progress.counts.F} attacker${3-progress.counts.F===1?'':'s'}, ${2-progress.counts.D} ${2-progress.counts.D===1?'defenseman':'defensemen'}, ${1-progress.counts.G} goalie.`;
  if(overTransfers)guidance=`This change needs ${changes()} transfers. You have ${transfers.remaining} left this month.`;
  $('roster-guidance').textContent=guidance;$('roster-guidance').classList.toggle('error',overTransfers);
  $('save-roster').disabled=!session.user||!dirty()||busy||!loaded;
  $('save-roster').textContent=busy?'Please wait…':'Save draft';
  $('submit-roster').disabled=busy||!loaded||!progress.complete||overTransfers||entered&&!changes();
  $('submit-roster').textContent=entered?changes()?`Confirm ${changes()} transfer${changes()===1?'':'s'} ↗`:'Team entered ✓':session.user?'Enter competition ↗':'Sign in to enter ↗';
  $('reload-team').disabled=busy||!session.user;
  $('own-fantasy-points').textContent=points(session.score?.points);
  $('own-score-note').textContent=!entered?'Your points start with games beginning after you enter.':session.score?.pending?'Provisional total. A goals-saved-above-expected adjustment is pending.':session.score?.points===null?'Awaiting verified NHL statistics. Your entry is saved.':'Includes points earned by every lineup you have fielded, including players you transferred out.';
}
function render(){
  if(confirmation&&(confirmation.userId!==session.user?.id||confirmation.revision!==session.entry?.revision||!same(confirmation.ids,draft))){confirmation=null;$('fantasy-submit-dialog').close();}
  $('fantasy-auth').innerHTML=session.user?`<span title="${esc(session.user.displayName)}">${esc(session.user.displayName)}</span><button class="login-button" id="fantasy-logout" type="button"${busy?' disabled':''}>Log out</button>`:`<button class="login-button" id="login" type="button"${busy?' disabled':''}>Log in</button>`;
  $('fantasy-message').textContent=marketError??(session.user?`${session.user.displayName}, this is your Fantasy desk. ${dirty()?'Your latest changes are not saved yet.':'Your saved roster is connected to your account.'}`:'Explore the market and build your six. Log in with your Playoff Pick account, or create one to enter Fantasy.');
  $('fantasy-message').classList.toggle('error',Boolean(marketError));
  renderRoster();renderMarket();
}
function openAuth(mode='login'){
  if(busy)return;
  authMode=mode;$('fantasy-auth-title').textContent=mode==='login'?'Welcome back.':'Make your first call.';
  $('fantasy-login-tab').setAttribute('aria-pressed',String(mode==='login'));$('fantasy-register-tab').setAttribute('aria-pressed',String(mode==='register'));
  $('fantasy-auth-submit').textContent=mode==='login'?'Log in':'Create account';$('fantasy-confirm-row').hidden=mode!=='register';$('fantasy-password-confirm').required=mode==='register';$('fantasy-password').autocomplete=mode==='login'?'current-password':'new-password';$('fantasy-auth-error').textContent='';
  if(!$('fantasy-auth-dialog').open)$('fantasy-auth-dialog').showModal();
}
async function personal({replace=true}={}){
  const generation=authGeneration;
  const next=await api('/api/fantasy/session');
  if(generation!==authGeneration)return;
  if(!replace&&session.user?.id===next.user?.id&&dirty()){
    if(next.entry&&session.entry&&next.entry.revision===session.entry.revision)session.entry.transfers=next.entry.transfers;
    session.score=next.score;render();return;
  }
  if(next.user?.id!==session.user?.id)authGeneration++;
  session=next;feed=next.scoring;
  if(next.user)draft=next.entry.playerIds.filter(id=>byId.has(id));
  else if(replace)draft=[];
  replacing=null;render();
}
async function saveDraft(){
  if(!session.user||busy)return;
  busy=true;render();
  try{session=await api('/api/fantasy/roster','PUT',{playerIds:[...draft],revision:session.entry.revision});toast('Your Fantasy draft is saved.');}
  catch(error){toast(error.message);}
  finally{busy=false;render();}
}
function review(){
  if(!session.user){openAuth('register');return;}
  if(!rosterProgress(draft,byId).complete)return;
  const ids=[...draft],out=active().filter(id=>!ids.includes(id)),incoming=ids.filter(id=>!active().includes(id));
  confirmation={userId:session.user.id,revision:session.entry.revision,ids};
  $('fantasy-submit-title').textContent=active().length?'Make your changes?':'Ready for the ice?';
  $('fantasy-confirm-summary').innerHTML=`<p><b>${money(rosterProgress(ids,byId).cost)} of $40M</b> · 1 goalie · 2 defensemen · 3 attackers.</p>${active().length?`<p>This uses <b>${incoming.length} of your ${session.entry.transfers.remaining} remaining transfers</b> this month.</p><p>Out: ${out.map(id=>esc(byId.get(id)?.name)).join(', ')}<br>In: ${incoming.map(id=>esc(byId.get(id)?.name)).join(', ')}</p>`:`<ul class="fantasy-confirm-list">${ids.map(id=>`<li>${esc(byId.get(id).name)} · ${money(byId.get(id).price)}</li>`).join('')}</ul><p>Your initial selection uses no transfers.</p>`}`;
  $('fantasy-submit-error').textContent='';$('confirm-fantasy-submit').textContent=active().length?'Confirm transfers':'Enter competition';$('fantasy-submit-dialog').showModal();
}
async function confirmTeam(){
  const c=confirmation;
  if(busy||!c||c.userId!==session.user?.id||c.revision!==session.entry?.revision||!same(c.ids,draft))return;
  busy=true;$('confirm-fantasy-submit').disabled=true;render();
  try{
    const next=await api('/api/fantasy/submit','POST',{playerIds:c.ids,revision:c.revision});
    confirmation=null;$('fantasy-submit-dialog').close();session=next;draft=[...next.entry.playerIds];toast('Your team is in. Good luck on the ice.');await refreshLeague();
  }catch(error){$('fantasy-submit-error').textContent=error.message;}
  finally{busy=false;$('confirm-fantasy-submit').disabled=false;render();}
}
function renderLeague(){
  $('fantasy-leaderboard').innerHTML=league.length?`<table class="fantasy-league-table"><thead><tr><th scope="col">RANK</th><th scope="col">MANAGER & TEAM</th><th scope="col">FANTASY PTS</th></tr></thead><tbody>${league.map(e=>`<tr${e.id===session.user?.id?' class="mine"':''}><td>${e.rank??'—'}</td><td><details><summary>${esc(e.displayName)}${e.id===session.user?.id?' · You':''}</summary><div class="league-roster">${e.playerIds.map(id=>{const p=byId.get(id);return `${esc(p?.name??'Player unavailable')} (${esc(p?.position??'')})`;}).join(' · ')}<br>Entered ${new Date(e.submittedAt).toLocaleDateString('en-GB',{timeZone:'Europe/Helsinki',day:'numeric',month:'short'})}. Score includes earlier lineups.</div></details></td><td>${points(e.points)}${e.pending?'*':''}</td></tr>`).join('')}</tbody></table>`:'<div class="market-empty"><strong>The ice is yours.</strong><br>No teams have entered Fantasy yet. Build your six and make the first call.</div>';
  const fetched=feed?.fetchedAt?new Date(feed.fetchedAt).toLocaleString('en-GB',{timeZone:'Europe/Helsinki',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):null;
  $('fantasy-feed-status').textContent=[feed?.error,feed?.modelError,feed?.stale?'Update overdue; showing the last verified scores.':null,fetched?`${feed.gameCount} completed NHL games · Updated ${fetched} Helsinki time.`:null,'NHL statistics · GSAx by MoneyPuck.com · * Provisional GSAx adjustment pending.'].filter(Boolean).join(' ');
}
async function refreshLeague(updateMarket=true){
  $('refresh-fantasy').disabled=true;
  try{
    const [data,market]=await Promise.all([api('/api/fantasy/leaderboard'),updateMarket?api('/api/fantasy/players'):null]);
    league=data.entries;feed=data.scoring;
    if(market){catalog=market.players;byId=new Map(catalog.map(p=>[p.id,p]));render();}
    renderLeague();
  }
  catch(error){$('fantasy-feed-status').textContent=`The Fantasy leaderboard could not be refreshed. ${error.message}`;}
  finally{$('refresh-fantasy').disabled=false;}
}

$('player-list').addEventListener('click',e=>{const b=e.target.closest('[data-player]');if(b)choosePlayer(Number(b.dataset.player));});
$('roster-slots').addEventListener('click',e=>{
  const remove=e.target.closest('[data-remove]');if(remove){choosePlayer(Number(remove.dataset.remove));return;}
  const replace=e.target.closest('[data-replace]'),empty=e.target.closest('[data-empty-role]');
  if(replace){replacing=Number(replace.dataset.replace);role=playerRole(byId.get(replacing));}
  else if(empty){replacing=null;role=empty.dataset.emptyRole;}else return;
  $('player-search').value='';limit=12;renderMarket();renderRoster();$('market').scrollIntoView({behavior:'smooth',block:'start'});$('player-search').focus({preventScroll:true});
});
$('role-filters').addEventListener('click',e=>{const b=e.target.closest('[data-role]');if(b){role=b.dataset.role;if(replacing&&playerRole(byId.get(replacing))!==role)replacing=null;limit=12;renderMarket();renderRoster();}});
for(const id of ['player-search','player-sort','affordable'])$(id).addEventListener(id==='player-search'?'input':'change',()=>{limit=12;renderMarket();});
$('load-more').addEventListener('click',()=>{limit+=12;renderMarket();});
$('reset-roster').addEventListener('click',()=>{if(busy)return;draft=[...active()];replacing=null;rememberGuest();render();});
$('save-roster').addEventListener('click',saveDraft);$('submit-roster').addEventListener('click',review);
$('reload-team').addEventListener('click',()=>personal().then(()=>toast('Loaded your saved team.')).catch(e=>toast(e.message)));
$('confirm-fantasy-submit').addEventListener('click',confirmTeam);$('cancel-fantasy-submit').addEventListener('click',()=>$('fantasy-submit-dialog').close());
$('fantasy-submit-dialog').addEventListener('close',()=>{confirmation=null;});
$('fantasy-auth').addEventListener('click',async e=>{
  if(e.target.id==='login')openAuth();
  if(e.target.id!=='fantasy-logout'||busy)return;
  authGeneration++;busy=true;render();
  try{await api('/api/logout','POST',{});session={user:null,entry:null,score:{points:null},csrfToken:null};draft=[];replacing=null;confirmation=null;toast('Logged out of your shared account.');}
  catch(error){toast(error.message);}finally{busy=false;render();renderLeague();}
});
$('fantasy-login-tab').addEventListener('click',()=>openAuth('login'));$('fantasy-register-tab').addEventListener('click',()=>openAuth('register'));
$('fantasy-auth-form').addEventListener('submit',async e=>{
  e.preventDefault();if(busy)return;
  if(authMode==='register'&&$('fantasy-password').value!==$('fantasy-password-confirm').value){$('fantasy-auth-error').textContent='The passwords do not match.';return;}
  const guest=[...draft];authGeneration++;busy=true;$('fantasy-auth-submit').disabled=true;render();
  try{
    const next=await api(`/api/fantasy/${authMode}`,'POST',{username:$('fantasy-username').value,password:$('fantasy-password').value});session=next;
    draft=next.entry.revision?next.entry.playerIds:guest;
    replacing=null;$('fantasy-password').value='';$('fantasy-password-confirm').value='';$('fantasy-auth-dialog').close();toast(next.entry.revision?'Welcome back. Your saved Fantasy team is loaded.':'You’re signed in. Review your six, then enter the competition.');renderLeague();
  }catch(error){$('fantasy-auth-error').textContent=error.message;}
  finally{busy=false;$('fantasy-auth-submit').disabled=false;render();}
});
$('refresh-fantasy').addEventListener('click',async()=>{await refreshLeague();if(!busy)await personal({replace:false}).catch(e=>toast(e.message));});
async function boot(){
  try{
    const [data,account]=await Promise.all([api('/api/fantasy/players'),api('/api/fantasy/session')]);
    catalog=data.players;byId=new Map(catalog.map(p=>[p.id,p]));session=account;feed=data.scoring;
    if(account.user)draft=account.entry.playerIds;
    else{try{const saved=JSON.parse(localStorage.getItem(STORAGE)??'[]');if(Array.isArray(saved)&&rosterProgress(saved,byId).valid)draft=saved;}catch{/* Ignore an invalid device draft. */}}
    loaded=true;render();await refreshLeague(false);
  }catch{marketError='The Fantasy service could not be reached. Reload this page to reconnect.';loaded=false;render();}
}
void boot();
$('fantasy-auth-dialog').addEventListener('close',()=>{$('fantasy-password').value='';$('fantasy-password-confirm').value='';$('fantasy-auth-error').textContent='';});
// Statistics are a daily snapshot. Read it once a day rather than polling.
setInterval(()=>{if(!document.hidden&&!busy){void refreshLeague();void personal({replace:false}).catch(()=>{});}},24*60*60*1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&loaded&&!busy)void personal({replace:false}).catch(()=>{});});
