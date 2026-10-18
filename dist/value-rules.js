export function rankValues(players, sort='surplus') {
  const metric={surplus:'surplus',percent:'surplusPercent',value:'fantasyValue',contract:'capHit',lowest:'surplus'}[sort]??'surplus';
  return [...players].sort((a,b)=>{
    if(a.capHit===null||b.capHit===null){if(a.capHit!==b.capHit)return a.capHit===null?1:-1;return a.name.localeCompare(b.name);}
    return (sort==='lowest'?1:-1)*(a[metric]-b[metric])||a.name.localeCompare(b.name)||a.id-b.id;
  });
}
export const normalizeSearch=text=>text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
export function filterValues(players,{query='',role='all',team='all',missing=false}={}){
  const search=normalizeSearch(query);
  return players.filter(p=>(missing||p.capHit!==null)&&(team==='all'||p.team===team)&&
    (role==='all'||(role==='F'?!['D','G'].includes(p.position):p.position===role))&&normalizeSearch(`${p.name} ${p.team}`).includes(search));
}
