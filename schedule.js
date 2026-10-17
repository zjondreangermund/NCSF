const crypto = require('crypto');
function easterSundayUtc(year){
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3);
  const h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451);
  return new Date(Date.UTC(year,Math.floor((h+l-7*m+114)/31)-1,((h+l-7*m+114)%31)+1));
}
function namibiaPublicHolidays(year){
  const dates=new Set(),add=(m,d)=>dates.add(`${year}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
  [[1,1],[3,21],[5,1],[5,4],[5,25],[5,28],[8,26],[12,10],[12,25],[12,26]].forEach(([m,d])=>add(m,d));
  for(const offset of [-2,1,39]){const d=easterSundayUtc(year);d.setUTCDate(d.getUTCDate()+offset);add(d.getUTCMonth()+1,d.getUTCDate())}
  for(const v of [...dates]){const d=new Date(v+'T00:00:00Z');if(d.getUTCDay()===0){d.setUTCDate(d.getUTCDate()+1);dates.add(d.toISOString().slice(0,10))}}
  return dates;
}
function isNamibianHolidayWeek(date){
  const monday=new Date(date);monday.setUTCDate(monday.getUTCDate()-(monday.getUTCDay()+6)%7);monday.setUTCHours(0,0,0,0);
  const holidays=new Set([...namibiaPublicHolidays(monday.getUTCFullYear()),...namibiaPublicHolidays(monday.getUTCFullYear()+1)]);
  for(let i=0;i<7;i++){const d=new Date(monday);d.setUTCDate(d.getUTCDate()+i);if(holidays.has(d.toISOString().slice(0,10)))return true}return false;
}
function buildSchedule(teams,division,firstDate,format='top8',opponent=null){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(firstDate)||!Number.isFinite(Date.parse(firstDate))||new Date(firstDate).toISOString().slice(0,10)!==firstDate)throw Error('Choose a valid first match date.');
  if(teams.length<2)throw Error('At least two active teams are required.');
  if(!['league','top8','central-coastal'].includes(format))throw Error('Choose a valid playoff format.');
  if(format!=='league'&&teams.length<8)throw Error('Top 8 playoffs require at least eight active teams. Choose league only for a smaller test division.');
  if(format==='central-coastal'&&!opponent)throw Error('Choose the Coastal / opposing division for the quarter-finals.');
  const ids=teams.map(t=>t.id);if(ids.length%2)ids.push(null);
  const rounds=ids.length-1,days=[],cursor=new Date(firstDate+'T12:00:00Z');let skipped=0;
  const nextDay=()=>{while(isNamibianHolidayWeek(cursor)){cursor.setUTCDate(cursor.getUTCDate()+7);skipped++}const d=new Date(cursor);cursor.setUTCDate(cursor.getUTCDate()+7);return d};
  for(let i=0;i<rounds;i++)days.push(nextDay());
  const at=(date,afternoon=false)=>{const d=new Date(date);d.setUTCHours(afternoon?13:8,afternoon?0:30,0,0);return d.toISOString()};
  const fixtures=[];let rotating=[...ids];
  for(let r=0;r<rounds;r++){
    for(let i=0;i<ids.length/2;i++){
      const a=rotating[i],b=rotating[ids.length-1-i];if(!a||!b)continue;
      for(const second of [false,true]){const index=r+(second?rounds:0),home=r%2?b:a,away=r%2?a:b;
        fixtures.push({key:`league-${index+1}-${i+1}`,roundNo:index+1,homeTeamId:second?away:home,awayTeamId:second?home:away,fixtureDate:at(days[Math.floor(index/2)],index%2===1),venue:''});}
    }rotating=[rotating[0],rotating.at(-1),...rotating.slice(1,-1)];
  }
  fixtures.sort((a,b)=>a.roundNo-b.roundNo||a.key.localeCompare(b.key));
  const playoffs=[];
  const rank=(d,n)=>({divisionId:d.id,rank:n,label:`${d.name} position ${n}`});
  const winner=key=>({winner:key,label:`Winner of ${key}`});
  const add=(key,stage,roundNo,home,away,date)=>playoffs.push({key,stage,roundNo,home,away,fixtureDate:date,venue:'',raceTo:13});
  if(format!=='league'){
    const first=nextDay();
    for(let i=0;i<4;i++)add(`${format==='central-coastal'?'T8':'QF'}${i+1}`,format==='central-coastal'?'Top 8 play-off':'Quarter-final',format==='central-coastal'?1:2,rank(division,i+1),rank(division,8-i),at(first));
    if(format==='central-coastal'){
      const quarters=nextDay();for(let i=0;i<4;i++)add(`QF${i+1}`,'Quarter-final',2,winner(`T8${i+1}`),rank(opponent,4-i),at(quarters));
      add('SF1','Semi-final',3,winner('QF1'),winner('QF4'),at(quarters,true));add('SF2','Semi-final',3,winner('QF2'),winner('QF3'),at(quarters,true));
    }else{const semis=nextDay();add('SF1','Semi-final',3,winner('QF1'),winner('QF4'),at(semis));add('SF2','Semi-final',3,winner('QF2'),winner('QF3'),at(semis));}
    add('FINAL','Final',4,winner('SF1'),winner('SF2'),at(nextDay(),true));
  }
  return {divisionId:division.id,divisionName:division.name,format,opponentDivisionId:opponent?.id||null,teams,fixtures,playoffs,matchDates:days.map(d=>d.toISOString().slice(0,10)),skippedHolidayWeeks:skipped};
}
function applyEdits(plan,edits,startDate,endDate){
  const copy=JSON.parse(JSON.stringify(plan));const all=[...copy.fixtures,...copy.playoffs],byKey=new Map(all.map(f=>[f.key,f]));
  if(!Array.isArray(edits)||edits.length!==all.length||new Set(edits.map(e=>e.key)).size!==all.length)throw Error('Preview rows changed. Preview the schedule again.');
  for(const e of edits){const row=byKey.get(e.key);if(!row)throw Error('Unknown preview fixture.');
    if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{3})?)?(?:Z|\+02:00)$/.test(e.fixtureDate)||!Number.isFinite(Date.parse(e.fixtureDate)))throw Error('Every fixture needs a valid Namibia date and time.');
    row.fixtureDate=new Date(e.fixtureDate).toISOString();row.venue=String(e.venue||'').trim().slice(0,200);
    const local=new Date(Date.parse(row.fixtureDate)+7200000).toISOString().slice(0,10);
    if((startDate&&local<startDate)||(endDate&&local>endDate))throw Error('Fixtures must fall within the season start and end dates. Edit the season dates or the preview.');
    if(isNamibianHolidayWeek(new Date(local+'T12:00:00Z')))throw Error('A fixture falls in a Namibian holiday week. Choose another date.');
  }
  const bookings=new Map();for(const f of copy.fixtures)for(const id of [f.homeTeamId,f.awayTeamId]){
    const day=new Date(Date.parse(f.fixtureDate)+7200000).toISOString().slice(0,10),key=`${id}-${day}`,list=bookings.get(key)||[];
    if(list.length>=2||list.some(d=>Math.abs(d-Date.parse(f.fixtureDate))<4.5*3600000))throw Error('A team has overlapping fixtures or more than two games in one day. Allow at least 4½ hours between starts.');
    list.push(Date.parse(f.fixtureDate));bookings.set(key,list);
  }
  const lastLeague=Math.max(...copy.fixtures.map(f=>Date.parse(f.fixtureDate)));
  for(const f of copy.playoffs){if(Date.parse(f.fixtureDate)<=lastLeague)throw Error('Playoffs must start after the league fixtures.');for(const source of [f.home,f.away])if(source.winner){const previous=byKey.get(source.winner);if(Date.parse(f.fixtureDate)-Date.parse(previous.fixtureDate)<4.5*3600000)throw Error('Allow at least 4½ hours before the next knockout stage.')}}
  return copy;
}
const fingerprint=teams=>crypto.createHash('sha256').update(JSON.stringify(teams)).digest('hex');
module.exports={buildSchedule,applyEdits,fingerprint,isNamibianHolidayWeek,namibiaPublicHolidays};
