import { rankValues, filterValues } from './value-rules.js';
import { TEAMS } from './game.js';
const $=id=>document.getElementById(id);
const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dollars=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0});
const compact=value=>`$${(value/1e6).toFixed(2)}M`;
const signed=value=>`${value<0?'−':value>0?'+':''}${compact(Math.abs(value))}`;
let players=[],role='all',limit=50,ready=false;
for(const team of [...TEAMS].sort((a,b)=>a.id.localeCompare(b.id))){const option=document.createElement('option');option.value=team.id;option.textContent=team.id;$('value-team').append(option);}
function render(){
  if(!ready)return;
  const query=$('value-search').value,team=$('value-team').value,missing=$('show-missing').checked,sort=$('value-sort').value;
  const rows=rankValues(filterValues(players,{query,role,team,missing}),sort);
  $('value-status').textContent=`${rows.length.toLocaleString()} ${rows.length===1?'player':'players'}${query?' matching your search':''} · Showing ${Math.min(rows.length,limit)}${missing?' · Unmatched contracts appear last.':''}`;
  if(!rows.length){$('value-list').innerHTML='<div class="value-empty">No players match these filters.<br><button type="button" id="reset-value-filters">Reset filters</button></div>';$('reset-value-filters').addEventListener('click',reset);}
  else $('value-list').innerHTML=`<table class="value-table ${sort==='percent'?'show-percent':''}"><caption class="sr-only">Player fantasy valuations compared with annual NHL contract cap hits. ${escape($('value-sort').selectedOptions[0].textContent)}.</caption><thead><tr><th scope="col">#</th><th scope="col">PLAYER</th><th scope="col" class="points-column">LAST SEASON PTS</th><th scope="col">FANTASY VALUE</th><th scope="col">CONTRACT</th><th scope="col" class="difference-column">DIFFERENCE</th><th scope="col" class="percent-column">DIFFERENCE %</th></tr></thead><tbody>${rows.slice(0,limit).map((p,i)=>`<tr><td>${p.capHit===null?'—':i+1}</td><td><div class="value-player"><img src="/logos/${escape(p.team)}.svg" alt="" width="31" height="31"><div><strong>${escape(p.name)}</strong><small>${escape(p.team)} · ${escape(p.position)} · ${p.games} GP</small></div></div></td><td class="points-column">${p.fantasyPoints.toFixed(2)}</td><td title="${dollars.format(p.fantasyValue)}">${compact(p.fantasyValue)}</td><td>${p.capHit===null?'<span title="No matched 2026–27 contract">Unmatched</span>':`<a class="contract-link" href="${escape(p.sourceUrl)}" target="_blank" rel="noopener noreferrer" aria-label="${escape(p.name)} contract on PuckPedia, ${dollars.format(p.capHit)}" title="${dollars.format(p.capHit)} · View on PuckPedia">${compact(p.capHit)}</a>`}</td><td class="value-surplus difference-column ${p.surplus<0?'negative':''}" title="${p.surplus===null?'Contract unavailable':dollars.format(p.surplus)}">${p.surplus===null?'—':signed(p.surplus)}</td><td class="value-percent percent-column">${p.surplusPercent===null?'—':`${p.surplusPercent>0?'+':''}${p.surplusPercent.toFixed(1)}%`}</td></tr>`).join('')}</tbody></table>`;
  $('more-values').hidden=rows.length<=limit;
}
function reset(){role='all';$('value-search').value='';$('value-team').value='all';$('show-missing').checked=false;$('value-sort').value='surplus';limit=50;syncRole();render();}
function syncRole(){document.querySelectorAll('[data-role]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.role===role)));}
for(const id of ['value-search','value-team','value-sort','show-missing'])$(id).addEventListener(id==='value-search'?'input':'change',()=>{limit=50;render();});
document.querySelectorAll('[data-role]').forEach(b=>b.addEventListener('click',()=>{role=b.dataset.role;limit=50;syncRole();render();}));
$('more-values').addEventListener('click',()=>{limit+=50;render();});$('retry-values').addEventListener('click',load);
async function load(){
  $('retry-values').hidden=true;$('value-status').textContent='Loading player values…';$('value-list').setAttribute('aria-busy','true');
  try{
    const response=await fetch('/api/fantasy/value',{headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error();const data=await response.json();players=data.players;ready=true;
    $('covered-count').textContent=data.coverage.matched.toLocaleString();$('above-count').textContent=data.coverage.aboveContract.toLocaleString();
    const best=rankValues(players.filter(p=>p.capHit!==null))[0];$('best-surplus').textContent=best?signed(best.surplus):'—';$('best-player').textContent=best?`${best.name.toUpperCase()} · LARGEST DIFFERENCE`:'NO MATCHED CONTRACTS';
    $('conversion-note').textContent=`Starting valuation = last-season fantasy points × ${data.usdPerPoint.toLocaleString('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2})} per point, with a $100,000 minimum. The displayed rate is rounded; starting valuations use the full conversion rate. This board uses the current team-picker price, including the weekly 75% / 25% adjustment, ±5% limit and $100,000 floor.`;
    const asOf=new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'Europe/Helsinki'}).format(new Date(`${data.contractAsOf}T12:00:00Z`));
    $('contract-source').innerHTML=`Contract figures: <a href="https://puckpedia.com/" target="_blank" rel="noopener noreferrer">PuckPedia</a> · Snapshot as of ${escape(asOf)}. Contract links open the published player details.`;
    $('coverage-note').textContent=`${data.coverage.matched} of ${data.coverage.total} fantasy players have matched contracts. The remaining ${data.coverage.missing} may have unsigned, expired or unmatched contracts. They have no calculated difference and are excluded by default. Salaries refresh on 25 September and 25 October at noon Helsinki time. Next scheduled update: ${data.updateSchedule.nextDate}. ${data.updateSchedule.error??''}`;
    render();
  }catch{$('value-status').textContent='Player values could not be loaded. Please try again.';$('retry-values').hidden=false;}
  finally{$('value-list').setAttribute('aria-busy','false');}
}
void load();
