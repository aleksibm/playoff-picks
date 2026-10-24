import { BUDGET, FANTASY_SEASON, SLOTS, money, points, playerRole, rosterProgress } from './fantasy-rules.js';

const $=id=>document.getElementById(id);
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let catalog=[],byId=new Map(),draft=[],session={user:null,entry:null,score:{points:null},csrfToken:null},loaded=false,busy=false,role='all',replacing=null,limit=12,authMode='login',confirmation=null,toastTimer,league=[];
let feed=null,marketError=null,authGeneration=0,priceMarket=null;
let gameLogContext=null,gameLogRequest=0;
let editMode=false,viewUserId=null;
let weeklySelection='current',weeklyRequest=0,weeklyData=null,weeklyLoading=false,weeklyError=null,weeklyLastRead=0;
const rankingPeriods={
  current:{label:'This week',title:'Players of the week.',time:'this week',calendar:'Monday to Sunday'},
  previous:{label:'Last week',title:'Players of the week.',time:'last week',calendar:'Monday to Sunday'},
  month:{label:'This month',title:'Players of the month.',time:'this month so far',calendar:'Month to date'},
  year:{label:'Year to date',title:'This year’s leaders.',time:'this year so far',calendar:'Year to date'},
};
const fantasySeasonLabel=`${FANTASY_SEASON.slice(0,4)}–${FANTASY_SEASON.slice(6)}`;
const same=(a,b)=>a.length===b.length&&a.every(id=>b.includes(id));
const active=()=>session.entry?.activePlayerIds??[];
const funds=()=>active().length?(session.entry.cashBalance??0)+active().reduce((n,id)=>n+(byId.get(id)?.price??0),0):BUDGET;
const progressFor=ids=>rosterProgress(ids,byId,funds());
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
function choosePlayer(id){
  if(busy||!loaded||!editMode)return;
  if(!session.user){openAuth('register');return;}
  const p=byId.get(id);if(!p)return;
  if(draft.includes(id)){draft=draft.filter(x=>x!==id);if(replacing===id)replacing=null;render();return;}
  if(p.selectable===false&&!active().includes(id)){toast('This player is unavailable for new picks. Choose a current NHL player.');return;}
  let next=draft.filter(x=>x!==replacing);next.push(id);
  const progress=progressFor(next);
  if(!progress.valid){toast('That selection exceeds your available cash or position spots. Sell a player first to fund a replacement.');return;}
  draft=next;replacing=null;render();
}
function renderMarket(){
  const term=$('player-search').value.trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  const sort=$('player-sort').value,progress=progressFor(draft);
  $('market-points-heading').textContent=sort==='current'?'THIS SEASON':'LAST SEASON';
  const available=progress.remaining+(byId.get(replacing)?.price??0);
  let filtered=catalog.filter(p=>p.selectable!==false&&(role==='all'||playerRole(p)===role)&&(!term||`${p.name} ${p.team}`.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().includes(term))&&(!$('affordable').checked||p.price<=available||draft.includes(p.id)));
  filtered.sort(sort==='name'?(a,b)=>a.name.localeCompare(b.name):sort==='value-asc'?(a,b)=>a.price-b.price:sort==='current'?(a,b)=>(b.seasonPoints??-Infinity)-(a.seasonPoints??-Infinity)||b.price-a.price:(a,b)=>b.price-a.price);
  $('player-count').textContent=`${filtered.length.toLocaleString()} player${filtered.length===1?'':'s'}`;
  $('market-model-note').hidden=sort!=='current'||!filtered.some(p=>p.pending);
  $('role-filters').querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.role===role)));
  $('player-list').setAttribute('aria-busy',String(!loaded));
  $('player-list').innerHTML=filtered.slice(0,limit).map(p=>{
    const selected=draft.includes(p.id),valid=progressFor([...draft.filter(x=>x!==replacing),p.id]).valid;
    const disabled=busy||!editMode||(!selected&&!valid);
    const why=selected?'Remove':p.price>available?'Over budget:':'Position full:';
    return `<div class="player-row${selected?' selected':''}"><div class="player-identity"><span class="player-avatar" aria-hidden="true">${esc(initials(p.name))}</span><div><button type="button" class="player-game-link" data-games="${p.id}" aria-label="View game-by-game points for ${esc(p.name)}"><strong>${esc(p.name)}</strong><span class="game-log-hint">Game log ↗</span></button><small>${esc(p.team)} · ${esc(p.position)} · ${p.games} GP${p.newcomer?' · New to market':''}</small></div></div><span class="player-stat" title="${sort==='current'?'2026–27':'2025–26'} fantasy points${sort==='current'&&p.pending?' · Provisional GSAx':''}">${points(sort==='current'?p.seasonPoints:p.lastPoints)}${sort==='current'&&p.pending?'*':''}</span><span class="player-price">${money(p.price)}</span><button class="add-player" type="button" data-player="${p.id}" aria-pressed="${selected}" aria-label="${selected?'Remove':valid?'Add':why} ${esc(p.name)}${replacing&&!selected?' as replacement':''}" title="${selected?'Remove player':valid?'Add player':p.price>available?'Over budget':'Replace a player in this position first'}"${disabled?' disabled':''}>${selected?'✓':'+'}</button></div>`;
  }).join('')||`<p class="market-empty">${marketError?'The player market could not be loaded. Reload the page to retry.':'No players match. Try another search or turn off “Within budget”.'}</p>`;
  $('load-more').hidden=filtered.length<=limit;$('load-more').disabled=busy;
  $('replacement-note').hidden=!replacing;
  $('replacement-note').textContent=replacing?`Replacing ${byId.get(replacing)?.name}. Choose another ${playerRole(byId.get(replacing))==='F'?'attacker':playerRole(byId.get(replacing))==='D'?'defenseman':'goalie'} from the market.`:'';
}
function renderRoster(){
  const progress=progressFor(draft),pools={F:[],D:[],G:[]};
  for(const id of draft){const p=byId.get(id);if(p)pools[playerRole(p)].push(p);}
  const attackers=[null,null,null],overflow=[];
  for(const p of pools.F){const spot=p.position==='LW'?0:p.position==='RW'?2:1;if(!attackers[spot])attackers[spot]=p;else overflow.push(p);}
  for(const p of overflow)attackers[attackers.indexOf(null)]=p;
  pools.F=attackers;
  $('roster-slots').innerHTML=SLOTS.map(slot=>{
    const p=pools[slot.role].shift();
    return `<div class="roster-slot"><div class="slot-role">${slot.role==='F'?'ATTACK':slot.role==='D'?'DEFENSE':'GOALIE'}</div><button type="button" class="slot-main${p?' filled':''}${p?.id===replacing?' replacing':''}" ${p?`data-replace="${p.id}"`:`data-empty-role="${slot.role}"`} aria-label="${p?`${editMode?'Replace':'Selected player:'} ${esc(p.name)}${p.selectable===false?' · Unavailable for new picks':''}`:`${editMode?'Choose':'Empty spot:'} ${slot.label.toLowerCase()}`}"${busy||!editMode?' disabled':''}>${p?`<span aria-hidden="true">${esc(p.team)}</span><strong>${esc(p.name)}</strong><small>${money(p.price)}${p.selectable===false?' · Unavailable':''}</small>`:`<span class="slot-plus" aria-hidden="true">+</span><strong>${slot.label}</strong><small>${editMode?'CHOOSE PLAYER':'EDIT TEAM TO CHOOSE'}</small>`}</button>${p?`${editMode?`<button class="slot-remove" type="button" data-remove="${p.id}" aria-label="Remove ${esc(p.name)}"${busy?' disabled':''}>×</button>`:''}<button type="button" class="slot-game-link" data-games="${p.id}" aria-label="View game-by-game points for ${esc(p.name)}">Game log</button>`:''}</div>`;
  }).join('');
  $('budget-left').textContent=money(progress.remaining);$('budget-spent').textContent=`${money(progress.cost)} team value`;
  $('portfolio-value').textContent=`Team + cash: ${money(funds())}${active().length&&!same(draft,active())?' · Cash shown after planned sales and purchases.':''}`;
  $('budget-bar').style.width=`${Math.min(100,progress.cost/Math.max(1,funds())*100)}%`;
  $('roster-count').textContent=`${draft.length} of 6 selected`;
  const entered=Boolean(session.entry?.submittedAt),transfers=session.entry?.transfers;
  const planned=entered&&!same(draft,active());
  $('draft-state').textContent=dirty()?'Unsaved draft':planned||!entered&&draft.length?'Saved draft':entered?'In competition':'Not entered';
  $('reset-roster').textContent=entered?'Reset changes':'Clear draft';$('reset-roster').disabled=busy||!editMode||!draft.length&&!active().length;$('reset-roster').hidden=!editMode;
  $('edit-team').disabled=busy||!loaded;$('edit-team').textContent=editMode?'Done editing ✓':'Edit team ↗';$('edit-team').setAttribute('aria-expanded',String(editMode));
  $('done-editing').disabled=busy;$('team-edit-actions').hidden=!editMode;$('reload-team').hidden=!editMode;
  $('closed-draft-note').hidden=editMode;
  $('closed-draft-note').textContent=dirty()||planned?`You’re viewing ${dirty()?'an unsaved':'a saved'} draft. ${entered?'Your entered lineup stays active until you confirm the changes.':'Confirm your six players to enter the competition.'}`:entered?'Your confirmed lineup is in the competition. Edit your team to plan transfers.':draft.length?'Your draft is saved. Edit your team to finish and enter.':'Press Edit team to choose your six players.';
  $('transfer-status').textContent=entered?`${transfers.remaining} of 2 transfers available · ${transfers.month} · Resets monthly in Helsinki. No rollover.`:'First team selection is free. Then two transfers each calendar month, with no rollover.';
  const overTransfers=entered&&changes()>(transfers?.remaining??0);
  const unavailablePick=draft.some(id=>byId.get(id)?.selectable===false&&!active().includes(id));
  let guidance=!loaded?'Loading your team…':progress.complete?entered?changes()?`${changes()} player replacement${changes()===1?'':'s'} ready to confirm.`:'Your team is in the competition. Replace a player to plan a transfer.':'Your six are ready. Enter the competition to start earning points.':`Still to choose: ${3-progress.counts.F} attacker${3-progress.counts.F===1?'':'s'}, ${2-progress.counts.D} ${2-progress.counts.D===1?'defenseman':'defensemen'}, ${1-progress.counts.G} goalie.`;
  if(overTransfers)guidance=`This change needs ${changes()} transfers. You have ${transfers.remaining} left this month.`;
  if(progress.remaining<0)guidance=`Sell another player or choose a cheaper replacement. You need ${money(-progress.remaining)} more cash.`;
  if(unavailablePick)guidance='A player in this draft is unavailable for new picks. Replace them with a current NHL player before saving or entering.';
  else if(draft.some(id=>byId.get(id)?.selectable===false))guidance+=' Unavailable players can stay in your confirmed lineup or be transferred out.';
  $('roster-guidance').textContent=guidance;$('roster-guidance').classList.toggle('error',overTransfers||unavailablePick);$('roster-guidance').hidden=!editMode;
  $('save-roster').disabled=!session.user||!editMode||!dirty()||busy||!loaded||!progress.valid||unavailablePick;
  $('save-roster').textContent=busy?'Please wait…':'Save draft';
  $('submit-roster').disabled=busy||!editMode||!loaded||!progress.complete||overTransfers||unavailablePick||entered&&!changes();
  $('submit-roster').textContent=entered?changes()?`Confirm ${changes()} transfer${changes()===1?'':'s'} ↗`:'Team entered ✓':session.user?'Enter competition ↗':'Sign in to enter ↗';
  $('reload-team').disabled=busy||!session.user;
  $('own-fantasy-points').textContent=points(session.score?.points);
  $('view-contributions').hidden=!entered;
  $('own-score-note').textContent=!entered?'Your points start with games beginning after you enter.':session.score?.pending?'Provisional total. A goals-saved-above-expected adjustment is pending.':session.score?.points===null?'Awaiting verified NHL statistics. Your entry is saved.':'Includes points earned by every lineup you have fielded, including players you transferred out.';
}
function scoreStatus(metadata){
  const updated=metadata?.fetchedAt?new Date(metadata.fetchedAt).toLocaleString('en-GB',{timeZone:'Europe/Helsinki',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):null;
  return [metadata?.error,metadata?.stale?'Update overdue; showing the last verified scores.':null,updated?`Updated ${updated} Helsinki time.`:null,'* Provisional: a GSAx adjustment is pending.'].filter(Boolean).join(' ');
}
function gameDate(game){
  const date=new Date(/^\d{4}-\d{2}-\d{2}$/.test(game.date??'')?`${game.date}T12:00:00Z`:game.startTime);
  return Number.isFinite(date.getTime())?date.toLocaleDateString('en-GB',{timeZone:'UTC',day:'numeric',month:'short'}):'Date unavailable';
}
function gameMatchup(game){
  if(game.opponent)return `${game.team??''} ${game.homeAway==='away'?'@':game.homeAway==='home'?'vs':'·'} ${game.opponent}`.trim();
  return game.team?`${game.team} · Opponent unavailable`:`Game ${game.gameId}`;
}
function gameRows(games,{earnedGames=null}={}){
  const earned=earnedGames===null?null:new Set(earnedGames.map(game=>game.gameId));
  return `<div class="points-table-wrap"><table class="player-points-table"><caption class="sr-only">Game-by-game fantasy points. Dates follow the NHL game date.</caption><thead><tr><th scope="col">DATE</th><th scope="col">MATCHUP</th><th scope="col">FANTASY PTS</th>${earned?'<th scope="col">FOR YOU</th>':''}</tr></thead><tbody>${games.map(game=>`<tr><td><time datetime="${esc(game.startTime)}">${esc(gameDate(game))}</time></td><td>${esc(gameMatchup(game))}</td><td class="${game.points<0?'negative-points':''}"${game.pending?' title="Provisional: GSAx adjustment pending"':''}>${points(game.points)}${game.pending?'*':''}</td>${earned?`<td${earned.has(game.gameId)&&game.points<0?' class="negative-points"':''}>${earned.has(game.gameId)?`${points(game.points)}${game.pending?'*':''}`:'<span class="unearned-points" title="This game did not count for your team">—</span>'}</td>`:''}</tr>`).join('')}</tbody></table></div>`;
}
function renderContributions(){
  const section=$('fantasy-contributions'),list=$('contribution-list');
  section.hidden=!session.user||!session.entry?.submittedAt;
  if(section.hidden){list.innerHTML='';$('contribution-total').textContent='—';$('contribution-status').textContent='';return;}
  const opened=new Set([...list.querySelectorAll('details[open]')].map(detail=>detail.dataset.contribution));
  const score=session.score??{},ids=[...new Set([...active(),...Object.keys(score.players??{}).map(Number)])];
  $('contribution-total').textContent=`${points(score.points)}${score.pending?'*':''}`;
  const totalsAvailable=score.points!==null&&score.points!==undefined;
  ids.sort((a,b)=>(score.players?.[b]??0)-(score.players?.[a]??0)||(byId.get(a)?.name??'').localeCompare(byId.get(b)?.name??''));
  list.innerHTML=ids.map(id=>{
    const player=byId.get(id),games=score.playerGames?.[id]??[],total=totalsAvailable?(score.players?.[id]??0):null;
    const pending=games.some(game=>game.pending),current=active().includes(id);
    return `<details class="player-contribution" data-contribution="${id}"${opened.has(String(id))?' open':''}><summary><span class="contribution-player"><strong>${esc(player?.name??'Player unavailable')}</strong><small>${esc(player?.position??'')} <span class="contribution-roster-state${current?' current':''}">${current?'Current team':'Transferred out'}</span></small></span><span class="contribution-value${total<0?' negative-points':''}"><strong>${points(total)}${pending?'*':''}</strong><small>${games.length} counted ${games.length===1?'game':'games'}</small></span><span class="contribution-chevron" aria-hidden="true">＋</span></summary><div class="contribution-games">${games.length?gameRows(games):`<p class="points-empty">${totalsAvailable?'No completed appearances have counted for your team yet.':'Awaiting verified NHL statistics. Your confirmed lineup is saved.'}</p>`}<button type="button" class="text-button contribution-game-link" data-games="${id}">View all season games ↗</button></div></details>`;
  }).join('')||'<p class="points-empty">Your player contributions will appear after a completed game is scored.</p>';
  $('contribution-status').textContent=scoreStatus(feed);
}
function closeGameLog(){
  gameLogRequest++;gameLogContext=null;
  if($('player-games-dialog').open)$('player-games-dialog').close();
  $('player-games-summary').innerHTML='';$('player-games-content').innerHTML='';$('player-games-status').textContent='';
  $('player-games-content').setAttribute('aria-busy','false');
}
async function openGameLog(id){
  const player=byId.get(id)??weeklyData?.players?.find(item=>item.id===id);if(!player)return;
  const request=++gameLogRequest,generation=authGeneration,userId=session.user?.id;
  gameLogContext={id,request,generation,userId};
  $('player-games-title').textContent=player.name;
  $('player-games-description').textContent=`${player.team} · ${player.position} · Fantasy points from every completed 2026–27 regular-season appearance.`;
  $('player-games-summary').innerHTML='';$('player-games-content').innerHTML='<p class="points-empty">Loading game-by-game points…</p>';
  $('player-games-content').setAttribute('aria-busy','true');$('player-games-status').textContent='';
  if(!$('player-games-dialog').open)$('player-games-dialog').showModal();
  try{
    const data=await api(`/api/fantasy/players/${id}/games`);
    if(request!==gameLogRequest||generation!==authGeneration||userId!==session.user?.id||!$('player-games-dialog').open)return;
    if(session.user&&session.entry?.submittedAt&&session.scoring?.fetchedAt!==data.scoring?.fetchedAt)await personal({replace:false});
    if(request!==gameLogRequest||generation!==authGeneration||userId!==session.user?.id||!$('player-games-dialog').open)return;
    const games=data.games??[],hasTeam=Boolean(session.user&&session.entry?.submittedAt),ownScoresCurrent=hasTeam&&session.scoring?.fetchedAt===data.scoring?.fetchedAt;
    const earned=ownScoresCurrent?session.score?.playerGames?.[id]??[]:null;
    const earnedTotal=ownScoresCurrent&&Number.isFinite(session.score?.points)?(session.score?.players?.[id]??0):null;
    $('player-games-summary').innerHTML=`<div><span>SEASON FANTASY POINTS</span><strong>${points(data.seasonPoints)}${games.some(game=>game.pending)?'*':''}</strong></div>${hasTeam?`<div><span>EARNED FOR YOUR TEAM</span><strong class="${earnedTotal<0?'negative-points':''}">${points(earnedTotal)}${earned?.some(game=>game.pending)?'*':''}</strong></div>`:''}`;
    const explanation=ownScoresCurrent?'<p class="game-log-explanation">“For you” includes only games that began while this player was in your confirmed lineup. A dash means the game did not count for your team.</p>':hasTeam?'<p class="game-log-explanation">Your team’s contribution totals are updating. Reopen this log in a moment to compare the points earned for your team.</p>':'';
    $('player-games-content').innerHTML=games.length?`${explanation}${gameRows(games,{earnedGames:earned})}`:`<p class="points-empty">${data.scoring?.available?'No completed appearances are recorded for this player yet.':'Game-by-game points are awaiting verified NHL statistics.'}</p>`;
    $('player-games-status').textContent=scoreStatus(data.scoring);
  }catch(error){
    if(request!==gameLogRequest||generation!==authGeneration||userId!==session.user?.id)return;
    $('player-games-content').innerHTML='<p class="points-empty">The player’s game log could not be loaded. Close this window and try again.</p>';
    $('player-games-status').textContent=error.message;
  }finally{if(request===gameLogRequest)$('player-games-content').setAttribute('aria-busy','false');}
}
function setEditing(open){
  if(busy||!loaded||!session.user)return;
  editMode=Boolean(open);replacing=null;render();
  if(editMode){$('market').scrollIntoView({behavior:'smooth',block:'start'});$('player-search').focus({preventScroll:true});}
  else{$('team-sheet').scrollIntoView({behavior:'smooth',block:'start'});$('edit-team').focus({preventScroll:true});}
}
function resetAccountView(){
  editMode=false;replacing=null;$('fantasy-contributions').open=false;$('contribution-list').innerHTML='';
}
function render(){
  if(viewUserId!==session.user?.id){resetAccountView();viewUserId=session.user?.id;}
  if(gameLogContext&&(gameLogContext.generation!==authGeneration||gameLogContext.userId!==session.user?.id))closeGameLog();
  const showPicker=Boolean(session.user);
  document.querySelector('.fantasy-section-nav a').setAttribute('href',showPicker?'#team-sheet':'#fantasy-guest');
  document.querySelector('.skip-link').setAttribute('href',showPicker?'#team-sheet':'#fantasy-guest');
  $('fantasy-picker').hidden=!showPicker;$('fantasy-guest').hidden=showPicker;$('choose-players').disabled=busy||!loaded;
  $('market').hidden=!showPicker||!editMode;$('fantasy-picker').classList.toggle('team-view',!editMode);
  $('fantasy-dashboard').classList.toggle('team-overview',showPicker&&!editMode);
  if(confirmation&&(confirmation.userId!==session.user?.id||confirmation.revision!==session.entry?.revision||confirmation.priceVersion!==priceMarket?.version||!same(confirmation.ids,draft))){confirmation=null;$('fantasy-submit-dialog').close();}
  $('fantasy-auth').innerHTML=session.user?`<span title="${esc(session.user.displayName)}">${esc(session.user.displayName)}</span><button class="login-button" id="fantasy-logout" type="button"${busy?' disabled':''}>Log out</button>`:`<button class="login-button" id="login" type="button"${busy?' disabled':''}>Log in</button>`;
  $('fantasy-message').textContent=marketError??(session.user?`${session.user.displayName}, this is your Fantasy desk. ${dirty()?'Your latest changes are not saved yet.':'Your saved roster is connected to your account.'}`:'Create an account or log in to choose your players and enter Fantasy.');
  $('fantasy-message').classList.toggle('error',Boolean(marketError));
  renderRoster();renderMarket();renderContributions();if(!session.entry?.submittedAt)renderLeague();
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
    session.score=next.score;session.scoring=next.scoring;feed=next.scoring;render();return;
  }
  const changedAccount=next.user?.id!==session.user?.id;
  if(changedAccount){authGeneration++;league=[];}
  session=next;feed=next.scoring;
  if(next.user)draft=next.entry.playerIds.filter(id=>byId.has(id));
  else if(replace)draft=[];
  replacing=null;render();if(changedAccount)void refreshLeague(false);
}
async function saveDraft(){
  if(!session.user||busy||!editMode)return;
  busy=true;render();
  try{session=await api('/api/fantasy/roster','PUT',{playerIds:[...draft],revision:session.entry.revision,priceVersion:priceMarket?.version});toast('Your Fantasy draft is saved.');}
  catch(error){if(error.status===409)await loadMarket().catch(()=>{});toast(error.message);}
  finally{busy=false;render();}
}
function review(){
  if(!editMode)return;
  if(!session.user){openAuth('register');return;}
  if(!progressFor(draft).complete)return;
  const ids=[...draft],out=active().filter(id=>!ids.includes(id)),incoming=ids.filter(id=>!active().includes(id));
  confirmation={userId:session.user.id,revision:session.entry.revision,priceVersion:priceMarket?.version,ids};
  $('fantasy-submit-title').textContent=active().length?'Make your changes?':'Ready for the ice?';
  $('fantasy-confirm-summary').innerHTML=`<p><b>${money(progressFor(ids).cost)} team value</b> · 1 goalie · 2 defensemen · 3 attackers.<br><b>${money(progressFor(ids).remaining)} cash remaining</b>.</p>${active().length?`<p>This uses <b>${incoming.length} of your ${session.entry.transfers.remaining} remaining transfers</b> this month.</p><p>Sell: ${out.map(id=>`${esc(byId.get(id)?.name)} · ${money(byId.get(id).price)}`).join(', ')}<br>Buy: ${incoming.map(id=>`${esc(byId.get(id)?.name)} · ${money(byId.get(id).price)}`).join(', ')}</p>`:`<ul class="fantasy-confirm-list">${ids.map(id=>`<li>${esc(byId.get(id).name)} · ${money(byId.get(id).price)}</li>`).join('')}</ul><p>Your initial selection uses no transfers.</p>`}`;
  $('fantasy-submit-error').textContent='';$('confirm-fantasy-submit').textContent=active().length?'Confirm transfers':'Enter competition';$('fantasy-submit-dialog').showModal();
}
async function confirmTeam(){
  const c=confirmation;
  if(busy||!editMode||!c||c.userId!==session.user?.id||c.revision!==session.entry?.revision||c.priceVersion!==priceMarket?.version||!same(c.ids,draft))return;
  busy=true;$('confirm-fantasy-submit').disabled=true;render();
  try{
    const next=await api('/api/fantasy/submit','POST',{playerIds:c.ids,revision:c.revision,priceVersion:c.priceVersion});
    confirmation=null;$('fantasy-submit-dialog').close();session=next;draft=[...next.entry.playerIds];editMode=false;replacing=null;toast('Your team is in. Good luck on the ice.');await refreshLeague();
  }catch(error){if(error.status===409)await loadMarket().catch(()=>{});$('fantasy-submit-error').textContent=error.message;toast(error.message);}
  finally{busy=false;$('confirm-fantasy-submit').disabled=false;render();if(!editMode&&session.entry?.submittedAt)$('edit-team').focus({preventScroll:true});}
}
function renderLeague(){
  if(!session.user||!session.entry?.submittedAt){
    league=[];$('refresh-fantasy').hidden=true;$('fantasy-feed-status').textContent='';
    $('fantasy-leaderboard').innerHTML=`<div class="market-empty"><strong>Enter your team first.</strong><br>Submit your six players to reveal the Fantasy leaderboard and other teams.<br><button id="unlock-fantasy-league" type="button" class="primary-button">${session.user?'Finish my team ↗':'Choose your players ↗'}</button></div>`;
    $('unlock-fantasy-league').addEventListener('click',()=>{if(session.user){$('team-sheet').scrollIntoView({behavior:'smooth'});$('edit-team').focus({preventScroll:true});}else openAuth('register');});return;
  }
  $('refresh-fantasy').hidden=false;
  $('fantasy-leaderboard').innerHTML=league.length?`<table class="fantasy-league-table"><thead><tr><th scope="col">RANK</th><th scope="col">MANAGER & TEAM</th><th scope="col">FANTASY PTS</th></tr></thead><tbody>${league.map(e=>`<tr${e.id===session.user?.id?' class="mine"':''}><td>${e.rank??'—'}</td><td><details><summary>${esc(e.displayName)}${e.id===session.user?.id?' · You':''}</summary><div class="league-roster">${e.playerIds.map(id=>{const p=byId.get(id);return `${esc(p?.name??'Player unavailable')} (${esc(p?.position??'')})`;}).join(' · ')}<br>Entered ${new Date(e.submittedAt).toLocaleDateString('en-GB',{timeZone:'Europe/Helsinki',day:'numeric',month:'short'})}. Score includes earlier lineups.</div></details></td><td>${points(e.points)}${e.pending?'*':''}</td></tr>`).join('')}</tbody></table>`:'<div class="market-empty"><strong>The ice is yours.</strong><br>No teams have entered Fantasy yet. Build your six and make the first call.</div>';
  const fetched=feed?.fetchedAt?new Date(feed.fetchedAt).toLocaleString('en-GB',{timeZone:'Europe/Helsinki',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):null;
  $('fantasy-feed-status').textContent=[feed?.error,feed?.modelError,feed?.stale?'Update overdue; showing the last verified scores.':null,fetched?`${feed.gameCount} completed NHL games · Updated ${fetched} Helsinki time.`:null,'NHL statistics · GSAx by MoneyPuck.com · * Provisional GSAx adjustment pending.'].filter(Boolean).join(' ');
}
async function refreshLeague(updateMarket=true){
  if(!session.user||!session.entry?.submittedAt){if(updateMarket)await loadMarket().catch(()=>{});renderLeague();return;}
  const generation=authGeneration,userId=session.user.id;
  $('refresh-fantasy').disabled=true;
  try{
    const [data,market]=await Promise.all([api('/api/fantasy/leaderboard'),updateMarket?api('/api/fantasy/players'):null]);
    if(generation!==authGeneration||userId!==session.user?.id)return;
    if(data.locked){league=[];await personal({replace:false});renderLeague();return;}
    league=data.entries;feed=data.scoring;
    if(market){receiveMarket(market);render();}
    renderLeague();
  }
  catch(error){if(generation===authGeneration&&userId===session.user?.id){league=[];$('fantasy-leaderboard').innerHTML='<p class="market-empty">The Fantasy leaderboard could not be loaded.</p>';$('fantasy-feed-status').textContent=`The Fantasy leaderboard could not be refreshed. ${error.message}`;}}
  finally{$('refresh-fantasy').disabled=false;}
}
function renderWeeklyPlayers(){
  const period=rankingPeriods[weeklySelection],toDate=weeklySelection==='month'||weeklySelection==='year';
  const list=$('weekly-player-list');list.setAttribute('aria-busy',String(weeklyLoading));
  $('weekly-players-title').textContent=period.title;
  $('weekly-description').textContent=`The top ten available fantasy players by total points ${period.time}, across all positions.${weeklySelection==='year'?` ${fantasySeasonLabel} regular-season games only.`:''}`;
  $('weekly-period').value=weeklySelection;$('refresh-weekly').disabled=weeklyLoading;
  $('refresh-weekly').textContent=weeklyError?'Retry players ↻':'Refresh players ↻';
  if(weeklyLoading){$('weekly-week-label').textContent=`${period.label} · ${period.calendar}, Helsinki time`;list.innerHTML=`<p class="points-empty">Loading the top point getters for ${period.time}…</p>`;$('weekly-player-status').textContent='';return;}
  if(weeklyError){list.innerHTML=`<p class="points-empty">The player rankings for ${period.time} could not be loaded.</p>`;$('weekly-player-status').textContent=weeklyError;return;}
  if(!weeklyData)return;
  const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Helsinki',day:'numeric',month:'short',year:'numeric'});
  const start=new Date(weeklyData.week.start),end=new Date(Date.parse(weeklyData.week.end)-(toDate?0:1));
  $('weekly-week-label').textContent=`${formatter.format(start)} – ${formatter.format(end)} · ${toDate?`${period.calendar} · `:''}Helsinki time`;
  const players=weeklyData.players??[];
  list.innerHTML=players.length?`<div class="points-table-wrap"><table class="weekly-player-table"><caption class="sr-only">Top ten available fantasy players ranked by total points ${period.time}, using Helsinki time.</caption><thead><tr><th scope="col">RANK</th><th scope="col">PLAYER</th><th scope="col">GP</th><th scope="col">FANTASY PTS</th></tr></thead><tbody>${players.map(player=>`<tr><td>${player.rank}</td><td><button type="button" class="player-game-link" data-games="${player.id}" aria-label="View game-by-game points for ${esc(player.name)}"><strong>${esc(player.name)}</strong><span class="weekly-player-meta">${esc(player.team)} · ${esc(player.position)} · Game log ↗</span></button></td><td>${player.games}</td><td class="${player.points<0?'negative-points':''}">${points(player.points)}${player.pending?'*':''}</td></tr>`).join('')}</tbody></table></div>`:`<p class="points-empty">${weeklyData.scoring?.available?`No completed appearances have been scored for ${period.time}.`:'Player rankings are awaiting verified NHL statistics.'}</p>`;
  $('weekly-player-status').textContent=scoreStatus(weeklyData.scoring);
}
async function refreshWeeklyPlayers(){
  const selection=weeklySelection,request=++weeklyRequest;
  weeklyLoading=true;weeklyError=null;weeklyData=null;renderWeeklyPlayers();
  try{
    const data=await api(`/api/fantasy/weekly-players?week=${selection}`);
    if(request!==weeklyRequest||selection!==weeklySelection)return;
    weeklyData=data;weeklyLastRead=Date.now();
  }catch(error){if(request===weeklyRequest&&selection===weeklySelection)weeklyError=error.message;}
  finally{if(request===weeklyRequest&&selection===weeklySelection){weeklyLoading=false;renderWeeklyPlayers();}}
}

$('player-list').addEventListener('click',e=>{const log=e.target.closest('[data-games]');if(log){void openGameLog(Number(log.dataset.games));return;}const b=e.target.closest('[data-player]');if(b)choosePlayer(Number(b.dataset.player));});
$('roster-slots').addEventListener('click',e=>{
  const log=e.target.closest('[data-games]');if(log){void openGameLog(Number(log.dataset.games));return;}
  if(!editMode||busy)return;
  const remove=e.target.closest('[data-remove]');if(remove){choosePlayer(Number(remove.dataset.remove));return;}
  const replace=e.target.closest('[data-replace]'),empty=e.target.closest('[data-empty-role]');
  if(replace){replacing=Number(replace.dataset.replace);role=playerRole(byId.get(replacing));}
  else if(empty){replacing=null;role=empty.dataset.emptyRole;}else return;
  $('player-search').value='';limit=12;renderMarket();renderRoster();$('market').scrollIntoView({behavior:'smooth',block:'start'});$('player-search').focus({preventScroll:true});
});
$('role-filters').addEventListener('click',e=>{const b=e.target.closest('[data-role]');if(b){role=b.dataset.role;if(replacing&&playerRole(byId.get(replacing))!==role)replacing=null;limit=12;renderMarket();renderRoster();}});
for(const id of ['player-search','player-sort','affordable'])$(id).addEventListener(id==='player-search'?'input':'change',()=>{limit=12;renderMarket();});
$('load-more').addEventListener('click',()=>{limit+=12;renderMarket();});
$('reset-roster').addEventListener('click',()=>{if(busy||!editMode)return;draft=[...active()];replacing=null;render();});
$('edit-team').addEventListener('click',()=>setEditing(!editMode));$('done-editing').addEventListener('click',()=>setEditing(false));
$('view-contributions').addEventListener('click',()=>{if(session.user&&session.entry?.submittedAt)$('fantasy-contributions').open=true;});
$('weekly-period').addEventListener('change',()=>{weeklySelection=Object.hasOwn(rankingPeriods,$('weekly-period').value)?$('weekly-period').value:'current';void refreshWeeklyPlayers();});
$('refresh-weekly').addEventListener('click',()=>void refreshWeeklyPlayers());
$('weekly-player-list').addEventListener('click',e=>{const button=e.target.closest('[data-games]');if(button)void openGameLog(Number(button.dataset.games));});
$('choose-players').addEventListener('click',()=>openAuth('register'));
$('save-roster').addEventListener('click',saveDraft);$('submit-roster').addEventListener('click',review);
$('reload-team').addEventListener('click',()=>{if(editMode&&!busy)void loadMarket().then(()=>personal()).then(()=>toast('Loaded your saved team and current prices.')).catch(e=>toast(e.message));});
$('confirm-fantasy-submit').addEventListener('click',confirmTeam);$('cancel-fantasy-submit').addEventListener('click',()=>$('fantasy-submit-dialog').close());
$('fantasy-submit-dialog').addEventListener('close',()=>{confirmation=null;});
$('fantasy-auth').addEventListener('click',async e=>{
  if(e.target.id==='login')openAuth();
  if(e.target.id!=='fantasy-logout'||busy)return;
  authGeneration++;resetAccountView();busy=true;render();
  try{await api('/api/logout','POST',{});session={user:null,entry:null,score:{points:null},csrfToken:null};draft=[];league=[];replacing=null;confirmation=null;toast('Logged out of your shared account.');}
  catch(error){toast(error.message);}finally{busy=false;render();renderLeague();}
});
$('fantasy-login-tab').addEventListener('click',()=>openAuth('login'));$('fantasy-register-tab').addEventListener('click',()=>openAuth('register'));
$('fantasy-auth-form').addEventListener('submit',async e=>{
  e.preventDefault();if(busy)return;
  if(authMode==='register'&&$('fantasy-password').value!==$('fantasy-password-confirm').value){$('fantasy-auth-error').textContent='The passwords do not match.';return;}
  const guest=[...draft];authGeneration++;resetAccountView();busy=true;$('fantasy-auth-submit').disabled=true;render();
  try{
    const next=await api(`/api/fantasy/${authMode}`,'POST',{username:$('fantasy-username').value,password:$('fantasy-password').value});session=next;
    draft=next.entry.revision?next.entry.playerIds:guest;
    replacing=null;league=[];$('fantasy-password').value='';$('fantasy-password-confirm').value='';$('fantasy-auth-dialog').close();toast(next.entry.revision?'Welcome back. Your saved Fantasy team is loaded.':'You’re signed in. Choose your six, then enter the competition.');await refreshLeague(false);
  }catch(error){$('fantasy-auth-error').textContent=error.message;}
  finally{busy=false;$('fantasy-auth-submit').disabled=false;render();}
});
$('refresh-fantasy').addEventListener('click',async()=>{void refreshWeeklyPlayers();await refreshLeague();if(!busy)await personal({replace:false}).catch(e=>toast(e.message));});
async function boot(){
  void refreshWeeklyPlayers();
  try{
    const [data,account]=await Promise.all([api('/api/fantasy/players'),api('/api/fantasy/session')]);
    receiveMarket(data);session=account;feed=data.scoring;
    if(account.user)draft=account.entry.playerIds;
    else draft=[];
    loaded=true;render();await refreshLeague(false);
  }catch{marketError='The Fantasy service could not be reached. Reload this page to reconnect.';loaded=false;render();}
}
function receiveMarket(data){catalog=data.players;byId=new Map(catalog.map(p=>[p.id,p]));priceMarket=data.market;
  const asOf=priceMarket?new Date(priceMarket.asOf).toLocaleDateString('en-GB',{timeZone:'Europe/Helsinki',day:'numeric',month:'short'}):'unavailable';
  $('market-price-note').textContent=`Prices as of ${asOf}. ${priceMarket?.overdue?'The weekly update is awaiting verified statistics. ':''}Prices update Mondays at noon Helsinki time: 75% last-season value + 25% current-season full-season pace, limited to ±5% each week. Prices stay unchanged until five appearances; goalies awaiting verified GSAx stay at their previous price.`;
  const roster=data.roster,note=$('market-roster-note');
  if(note){
    const updated=roster?.fetchedAt?new Date(roster.fetchedAt).toLocaleString('en-GB',{timeZone:'Europe/Helsinki',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):null;
    note.hidden=!roster;
    note.textContent=roster?[roster.error,roster.stale?'Player availability update overdue; showing the last verified NHL player list.':null,!roster.available?'Player availability is awaiting verified NHL roster data.':null,updated?`Player list updated ${updated} Helsinki time.`:null].filter(Boolean).join(' '):'';
  }
}
async function loadMarket(){receiveMarket(await api('/api/fantasy/players'));render();}
void boot();
$('fantasy-auth-dialog').addEventListener('close',()=>{$('fantasy-password').value='';$('fantasy-password-confirm').value='';$('fantasy-auth-error').textContent='';});
$('contribution-list').addEventListener('click',e=>{const button=e.target.closest('[data-games]');if(button)void openGameLog(Number(button.dataset.games));});
$('player-games-dialog').addEventListener('close',()=>{if(!$('player-games-dialog').open)closeGameLog();});
// Statistics are a daily snapshot. Read it once a day rather than polling.
setInterval(()=>{if(!document.hidden&&!busy){void refreshWeeklyPlayers();void refreshLeague();void personal({replace:false}).catch(()=>{});}},24*60*60*1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden){if(!weeklyLoading&&Date.now()-weeklyLastRead>5*60*1000)void refreshWeeklyPlayers();if(loaded&&!busy)void loadMarket().then(()=>personal({replace:false})).catch(()=>{});}});
