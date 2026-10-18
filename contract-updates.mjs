import { createDailyScheduler, previousDailyUpdate, UPDATE_TIME_ZONE } from './schedule.mjs';
import { buildPlayerValues } from './player-values.mjs';

export const CONTRACT_UPDATE_DATES=['09-25','10-25'];
const dateFormat=new Intl.DateTimeFormat('en-CA',{timeZone:UPDATE_TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'});
export function contractDate(now=Date.now()){
  const parts=Object.fromEntries(dateFormat.formatToParts(now).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function contractUpdateWindow(now=Date.now()){
  const today=contractDate(now),year=Number(today.slice(0,4));
  const dates=[year-1,year,year+1].flatMap(y=>CONTRACT_UPDATE_DATES.map(d=>`${y}-${d}`)).sort();
  // UTC noon is always after Helsinki noon, including the October DST change.
  const cutoff=date=>previousDailyUpdate(Date.parse(`${date}T12:00:00Z`));
  return {previous:dates.filter(d=>cutoff(d)<=now).at(-1),next:dates.find(d=>cutoff(d)>now)};
}
export function createContractUpdater({catalog,initial,state={},run,save=()=>{},now=Date.now,setTimer,clearTimer}){
  buildPlayerValues(catalog,initial);
  let snapshot=initial,attempted=state.attempted??null,error=state.error??null,running=null,active=false;
  function metadata(){return {dates:['25 September','25 October'],time:'12:00',timeZone:UPDATE_TIME_ZONE,nextDate:contractUpdateWindow(now()).next,lastAttempt:attempted,error};}
  async function refreshIfDue(){
    if(!active)return;
    if(running)return running;
    const due=contractUpdateWindow(now()).previous;
    if(!due||snapshot.asOf>=due||attempted===due)return;
    running=(async()=>{
      attempted=due;error=null;
      // Persist the attempted period, even on failure, so restarts never turn
      // this twice-yearly source refresh into repeated upstream requests.
      try{save({snapshot,attempted,error});}catch{error='The salary refresh state could not be saved. Keeping the verified snapshot.';return;}
      try{
        const next=await run(snapshot);buildPlayerValues(catalog,next);
        if(next.asOf<due||next.asOf>contractDate(now())||next.players.length<Math.ceil(snapshot.players.length*.8))throw Error('Incomplete contract update');
        save({snapshot:next,attempted,error:null});snapshot=next;error=null;
      }catch{error='The scheduled salary update could not be verified. The last verified salary snapshot is still in use.';try{save({snapshot,attempted,error});}catch{}}
    })();
    try{await running;}finally{running=null;}
  }
  const scheduler=createDailyScheduler({run:refreshIfDue,now,...(setTimer?{setTimer}:{}),...(clearTimer?{clearTimer}:{})});
  return {getSnapshot:()=>snapshot,metadata,refreshIfDue,start(){active=true;scheduler.start();void refreshIfDue();},async stop(){active=false;scheduler.stop();if(running)await running;}};
}

const decode=s=>(s??'').replace(/&quot;/g,'"').replace(/&#0*39;|&apos;/g,"'").replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
const attr=(tag,name)=>decode(new RegExp(`\\b${name}=["']([^"']*)["']`,'i').exec(tag)?.[1]??'');
const text=s=>decode(s.replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
const money=s=>/^\$[\d,]+$/.test(s)?Number(s.replace(/[$,]/g,'')):null;
export function parseContractPage(html,season){
  if(typeof html!=='string'||html.length>4*1024*1024)throw Error('Invalid contract page');
  const label=`${season.slice(0,4)}-${season.slice(6)}`,rows=[],sections=new Set();
  for(const table of html.matchAll(/<table\b[^>]*class=["'][^"']*\bpp_table-roster\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/gi)){
    const headers=[...table[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(m=>text(m[1]));
    if(headers[0]?.toLowerCase()!=='player'||headers[1]!==label)continue;
    const section=[...html.slice(0,table.index).matchAll(/\bid=["']capby_([a-z_]+)["']/g)].at(-1)?.[1];
    if(!section)throw Error('Missing contract section');
    if(!['forwards','defence','goaltenders','nonroster_forwards','nonroster_defence','nonroster_goaltenders','retained'].includes(section))continue;
    sections.add(section);
    for(const row of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
      const cells=[...row[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)];
      if(cells.length<2)continue;
      const playerLink=/<a\b[^>]*href=["'](\/player\/[a-z0-9-]+)["'][^>]*>/i.exec(cells[0][2]);
      if(!playerLink)continue;
      const cap=money(attr(cells[1][1],'data-ch'));
      if(cap===null)continue; // unsigned RFA/UFA is unknown, never a zero price
      rows.push({url:`https://puckpedia.com${playerLink[1]}`,cap,section,retained:/data-title=["']Retained Salary["']/i.test(cells[1][2])});
    }
  }
  if(!['forwards','defence','goaltenders'].every(s=>sections.has(s))||rows.length<15)throw Error('Contract source missing current-season roster tables');
  return rows;
}
async function pageText(response){
  if(!response.ok||response.redirected||Number(response.headers.get('content-length'))>4*1024*1024)throw Error('Contract source unavailable');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4*1024*1024)throw Error('Oversized contract source');chunks.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}
  return Buffer.concat(chunks).toString('utf8');
}
export async function fetchContractSnapshot({catalog,previous,now=Date.now(),fetchImpl=fetch}){
  const urls=new Map(previous.players.map(p=>[p.team,p.teamSourceUrl]));
  if(urls.size!==32)throw Error('All 32 contract source teams are required');
  const pages=[];
  for(const [team,url] of urls){
    if(!/^https:\/\/puckpedia\.com\/team\/[a-z-]+$/.test(url))throw Error('Invalid contract source');
    const response=await fetchImpl(url,{signal:AbortSignal.timeout(15000),redirect:'error',headers:{Accept:'text/html'}});
    pages.push({team,url,rows:parseContractPage(await pageText(response),catalog.season)});
  }
  const retained=new Map();
  for(const page of pages)for(const row of page.rows.filter(r=>r.section==='retained')){const prev=retained.get(row.url)??{amount:0,sources:[]};prev.amount+=row.cap;prev.sources.push(page.url);retained.set(row.url,prev);}
  const identities=new Map(previous.players.map(p=>[p.sourceUrl.toLowerCase(),p.id])),players=new Map();
  for(const page of pages)for(const row of page.rows.filter(r=>r.section!=='retained')){
    const id=identities.get(row.url.toLowerCase());if(!id)continue;
    const kept=retained.get(row.url);if(row.retained&&!kept)throw Error('Missing retained salary source');
    const record={id,capHit:row.cap+(row.retained?kept.amount:0),team:page.team,sourceUrl:row.url,teamSourceUrl:page.url,...(row.retained?{retainedSources:kept.sources}:{})};
    if(players.has(id)&&JSON.stringify(players.get(id))!==JSON.stringify(record))throw Error('Ambiguous contract identity');
    players.set(id,record);
  }
  const snapshot={...previous,asOf:contractDate(now),players:[...players.values()].sort((a,b)=>a.id-b.id)};
  buildPlayerValues(catalog,snapshot);return snapshot;
}
