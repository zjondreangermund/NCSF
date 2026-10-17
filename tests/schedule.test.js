const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildSchedule,applyEdits,isNamibianHolidayWeek}=require('../schedule');
const teams=n=>Array.from({length:n},(_,i)=>({id:i+1,name:'Team '+(i+1)}));
const division={id:1,name:'Central'},opponent={id:2,name:'Coastal'};
const edits=p=>[...p.fixtures,...p.playoffs].map(f=>({key:f.key,fixtureDate:f.fixtureDate,venue:f.venue}));
test('double round robin: every ordered pairing exactly once, two starts per day, no team overlaps',()=>{
  for(const n of [2,3,4,7,8,15,16]){
    const p=buildSchedule(teams(n),division,'2027-02-06','league');
    assert.equal(p.fixtures.length,n*(n-1));
    assert.equal(new Set(p.fixtures.map(f=>f.homeTeamId+'-'+f.awayTeamId)).size,n*(n-1));
    for(const f of p.fixtures){assert.notEqual(f.homeTeamId,f.awayTeamId);assert.ok(!isNamibianHolidayWeek(new Date(f.fixtureDate)));assert.ok(['08:30','13:00'].includes(f.fixtureDate.slice(11,16)))}
    assert.doesNotThrow(()=>applyEdits(p,edits(p),'2027-01-01','2028-12-31'));
  }
});
test('current format preserves Top 8 qualifiers, cross-zone quarters, semis and final, all race to 13',()=>{
  const p=buildSchedule(teams(16),division,'2027-01-09','central-coastal',opponent);
  assert.equal(p.playoffs.length,11);
  assert.deepEqual(p.playoffs.filter(f=>f.stage==='Top 8 play-off').map(f=>[f.home.rank,f.away.rank]),[[1,8],[2,7],[3,6],[4,5]]);
  assert.equal(p.playoffs.filter(f=>f.stage==='Quarter-final').length,4);
  assert.ok(p.playoffs.filter(f=>f.stage==='Quarter-final').every(f=>f.away.divisionId===2));
  assert.equal(p.playoffs.filter(f=>f.stage==='Semi-final').length,2);
  assert.ok(p.playoffs.every(f=>f.raceTo===13));
  assert.doesNotThrow(()=>applyEdits(p,edits(p),'2027-01-01','2028-12-31'));
});
test('single division Top 8 produces seven knockout slots; under eight requires league only',()=>{
  assert.equal(buildSchedule(teams(8),division,'2027-02-06','top8').playoffs.length,7);
  assert.throws(()=>buildSchedule(teams(7),division,'2027-02-06','top8'),/eight/);
  assert.throws(()=>buildSchedule(teams(8),division,'2027-02-06','central-coastal'),/opposing/);
});
test('editable draft preserves the exact pairings and accepts venue edits',()=>{
  const p=buildSchedule(teams(8),division,'2027-02-06','top8'),e=edits(p);e[0].venue='King Cues';e[0].homeTeamId=999;
  const result=applyEdits(p,e,'2027-01-01','2028-12-31');assert.equal(result.fixtures[0].venue,'King Cues');assert.equal(result.fixtures[0].homeTeamId,p.fixtures[0].homeTeamId);assert.equal(p.fixtures[0].venue,'');
});
test('rejects missing or repeated rows, invalid dates, season overflow, holiday weeks and overlapping games',()=>{
  const p=buildSchedule(teams(8),division,'2027-02-06','top8');
  assert.throws(()=>applyEdits(p,edits(p).slice(1)),/rows/);
  const repeated=edits(p);repeated[1]=repeated[0];assert.throws(()=>applyEdits(p,repeated),/rows/);
  const invalid=edits(p);invalid[0].fixtureDate='no';assert.throws(()=>applyEdits(p,invalid),/valid/);
  assert.throws(()=>applyEdits(p,edits(p),'2027-01-01','2027-02-07'),/season/);
  const holiday=edits(p);holiday[0].fixtureDate='2027-03-20T10:30:00+02:00';assert.throws(()=>applyEdits(p,holiday),/holiday/);
  const overlap=edits(p),f=p.fixtures[0],other=p.fixtures.find(g=>g.roundNo===2&&[g.homeTeamId,g.awayTeamId].includes(f.homeTeamId));overlap.find(e=>e.key===other.key).fixtureDate=f.fixtureDate;assert.throws(()=>applyEdits(p,overlap),/overlapping/);
});
test('rejects knockout rounds before their feeders and before league completion',()=>{
  const p=buildSchedule(teams(8),division,'2027-02-06','top8');
  const early=edits(p);early.find(e=>e.key==='FINAL').fixtureDate=p.fixtures[0].fixtureDate;assert.throws(()=>applyEdits(p,early),/after the league/);
  const tight=edits(p);tight.find(e=>e.key==='FINAL').fixtureDate=p.playoffs.find(f=>f.key==='SF1').fixtureDate;assert.throws(()=>applyEdits(p,tight),/4½/);
});
test('first match dates are validated and selected weekday is retained',()=>{
  assert.throws(()=>buildSchedule(teams(4),division,'2027-02-30','league'),/valid/);
  const p=buildSchedule(teams(4),division,'2027-04-26','league');assert.ok(p.matchDates.every(d=>new Date(d).getUTCDay()===1));assert.ok(p.skippedHolidayWeeks>0);
});
