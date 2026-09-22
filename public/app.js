(async function browserApp(){
  const $=(s,r=document)=>r.querySelector(s);
  const $$=(s,r=document)=>[...r.querySelectorAll(s)];
  const PAGE=document.body.dataset.page;
  const state={user:null,meta:null,fixture:null,teamPlayers:{HOME:[],AWAY:[]}};
  const IS_NCSF_ANDROID=/\bNCSFAndroid\//i.test(navigator.userAgent||'');
  if(IS_NCSF_ANDROID)document.documentElement.classList.add('is-ncsf-app');

  $$('.js-logo').forEach(img=>img.src='/ncsf-logo.jpg');

  async function api(url,options={}){
    const opts={credentials:'same-origin',...options};
    if(options.body && !(options.body instanceof FormData) && typeof options.body!=='string'){
      opts.headers={...(options.headers||{}),'Content-Type':'application/json'};
      opts.body=JSON.stringify(options.body);
    }
    const res=await fetch(url,opts);
    const type=res.headers.get('content-type')||'';
    const data=type.includes('application/json')?await res.json():await res.text();
    if(!res.ok) throw new Error(data?.error||data||'Request failed');
    return data;
  }
  function esc(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]))}
  function fmtDate(v){
    if(!v)return 'Date TBA';
    const d=new Date(v);
    return d.toLocaleString([], {day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
  }
  function toast(message,error=false){
    const el=$('#toast'); if(!el)return;
    el.textContent=message; el.className='toast'+(error?' error':'');
    clearTimeout(toast.t); toast.t=setTimeout(()=>el.classList.add('hidden'),3500);
  }
  function statusPill(s){return '<span class="pill '+esc(s)+'">'+esc(String(s||'').replaceAll('_',' '))+'</span>'}
  function options(items,valueKey,labelFn,selected,blank='— Select —'){
    return '<option value="">'+esc(blank)+'</option>'+items.map(x=>'<option value="'+esc(x[valueKey])+'" '+(String(x[valueKey])===String(selected)?'selected':'')+'>'+esc(labelFn(x))+'</option>').join('');
  }
  function formObject(form){
    const fd=new FormData(form),o={};
    for(const [k,v] of fd.entries())o[k]=v;
    for(const cb of $$('input[type="checkbox"]',form))o[cb.name]=cb.checked;
    return o;
  }
  async function loadUser(){
    try{state.user=(await api('/api/auth/me')).user}catch{state.user=null}
    renderUserActions();
  }
  function renderUserActions(){
    const box=$('#userActions'); if(!box)return;
    if(!state.user){
      box.innerHTML='<button class="btn light" id="loginBtn">Admin Sign In</button>';
      $('#loginBtn')?.addEventListener('click',()=>{if($('#authModal'))openAuth();else location.href='/?login=1'});
      return;
    }
    let links='';
    if(state.user.role==='NCSF_ADMIN')links+='<a class="btn light small" href="/admin">NCSF Admin</a>';
    if(state.user.role==='CLUB_ADMIN')links+='<a class="btn light small" href="/club-admin">Club Admin</a>';
    links+='<a class="btn light small" href="/team">Match Centre</a>';
    box.innerHTML='<span class="who"><strong>'+esc(state.user.displayName)+'</strong></span>'+links+'<button class="btn light small" id="logoutBtn">Sign out</button>';
    $('#logoutBtn')?.addEventListener('click',async()=>{await api('/api/auth/logout',{method:'POST'});location.href='/'});
  }
  async function openAuth(){
    const modal=$('#authModal'); if(!modal)return;
    modal.classList.remove('hidden');
    const setup=await api('/api/setup/status');
    $('#setupBlock').classList.toggle('hidden',!setup.needsSetup);
    $('#loginBlock').classList.toggle('hidden',setup.needsSetup);
  }
  function requireUser(roles=[]){
    if(!state.user){location.href='/';return false}
    if(roles.length && !roles.includes(state.user.role)){location.href=state.user.role==='NCSF_ADMIN'?'/admin.html':'/team.html';return false}
    return true;
  }
  function bindAuth(){
    $('#closeAuth')?.addEventListener('click',()=>$('#authModal').classList.add('hidden'));
    $('#loginForm')?.addEventListener('submit',async e=>{
      e.preventDefault();
      try{
        const data=await api('/api/auth/login',{method:'POST',body:formObject(e.currentTarget)});
        state.user=data.user; $('#authModal').classList.add('hidden'); renderUserActions(); toast('Signed in');
        if(state.user.role==='NCSF_ADMIN')location.href='/admin';
        else if(state.user.role==='CLUB_ADMIN')location.href='/club-admin';
        else location.href='/team';
      }catch(err){toast(err.message,true)}
    });
    $('#setupForm')?.addEventListener('submit',async e=>{
      e.preventDefault();
      try{
        const data=await api('/api/setup',{method:'POST',body:formObject(e.currentTarget)});
        state.user=data.user; toast('NCSF administrator created'); location.href='/admin';
      }catch(err){toast(err.message,true)}
    });
  }
  function fixtureCards(fixtures,allowOpen=true){
    if(!fixtures.length)return '<div class="empty">No fixtures found.</div>';
    return fixtures.map(f=>`
      <div class="match-card">
        <div><div class="team-name">${esc(f.home_team_name)}</div><div class="match-meta">${esc(fmtDate(f.fixture_date))}</div></div>
        <div class="match-score">${Number(f.home_frames||0)} &ndash; ${Number(f.away_frames||0)}</div>
        <div class="away"><div class="team-name">${esc(f.away_team_name)}</div><div class="match-meta">Round ${esc(f.round_no)} • ${statusPill(f.status)}</div></div>
        <div class="open-cell">${allowOpen && (f.status==='APPROVED' || Boolean(state.user))?`<a class="btn small secondary" href="/scoresheet?id=${f.id}">Open scoresheet</a>`:''}</div>
      </div>`).join('');
  }
  async function initHome(){
    bindAuth();
    if(new URLSearchParams(location.search).get('login')==='1')openAuth();
    state.meta=await api('/api/public/meta');
    const select=$('#divisionSelect');
    select.innerHTML=options(state.meta.divisions,'id',d=>d.season_name+' — '+d.name,null,'Choose division');
    if(state.meta.divisions[0])select.value=state.meta.divisions[0].id;
    select.addEventListener('change',loadPublicDivision);
    $('#refreshPublic')?.addEventListener('click',loadPublicDivision);
    await loadPublicDivision();
  }
  async function loadPublicDivision(){
    const id=Number($('#divisionSelect')?.value||0);
    if(!id){
      $('#standingsTable').innerHTML='<div class="empty">No division configured yet.</div>';
      $('#playerRankings').innerHTML='<div class="empty">No division configured yet.</div>';
      $('#fixtureList').innerHTML='<div class="empty">No fixtures configured yet.</div>';
      return;
    }
    try{
      const [st,pr,fx]=await Promise.all([
        api('/api/divisions/'+id+'/standings'),
        api('/api/divisions/'+id+'/individual-rankings'),
        api('/api/fixtures?divisionId='+id)
      ]);
      $('#standingsTable').innerHTML=st.standings.length?`<div class="table-wrap"><table><thead><tr><th>#</th><th>Team</th><th>P</th><th>W</th><th>Frames Won</th><th>Frames Lost</th><th>+/-</th></tr></thead><tbody>${st.standings.map((r,i)=>`<tr><td class="rank">${i+1}</td><td><strong>${esc(r.team_name)}</strong><br><small class="muted">${esc(r.club_name)}</small></td><td>${r.played}</td><td>${r.wins}</td><td><strong>${r.frames_won}</strong></td><td>${r.frames_lost}</td><td>${Number(r.frame_difference)>0?'+':''}${r.frame_difference}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Rankings appear after approved score sheets.</div>';
      $('#playerRankings').innerHTML=pr.rankings.length?`<div class="table-wrap"><table><thead><tr><th>#</th><th>Player</th><th>Team</th><th>Played</th><th>Won</th><th>Win %</th></tr></thead><tbody>${pr.rankings.map((r,i)=>`<tr><td class="rank">${i+1}</td><td><strong>${esc(r.player_name)}</strong>${r.ncsf_number?`<br><small class="muted">${esc(r.ncsf_number)}</small>`:''}</td><td>${esc(r.team_name)}</td><td>${r.frames_played}</td><td><strong>${r.frames_won}</strong></td><td>${r.win_percentage}%</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Individual rankings appear after approved score sheets.</div>';
      $('#fixtureList').innerHTML=fixtureCards(fx.fixtures,true);
    }catch(err){toast(err.message,true)}
  }
  function userSide(f){
    if(!state.user)return null;
    if(state.user.role==='NCSF_ADMIN')return 'NCSF';
    if(state.user.role==='TEAM_ADMIN'){
      if(state.user.teamId===f.homeTeamId)return 'HOME';
      if(state.user.teamId===f.awayTeamId)return 'AWAY';
    }
    if(state.user.role==='CLUB_ADMIN'){
      if(state.user.clubId===f.homeClubId)return 'HOME';
      if(state.user.clubId===f.awayClubId)return 'AWAY';
    }
    return null;
  }
  function canEditSide(side){
    const f=state.fixture.fixture,u=state.user;
    if(!u)return false;
    if(u.role==='NCSF_ADMIN')return true;
    return userSide(f)===side;
  }
  function lineupFor(side){
    const map=new Map(state.fixture.lineups.filter(x=>x.side===side).map(x=>[x.slot,x]));
    return [1,2,3,4,5].map(slot=>map.get(slot)||null);
  }
  function reservesFor(side){
    const map=new Map((state.fixture.reserves||[]).filter(x=>x.side===side).map(x=>[x.reserve_slot,x]));
    return [1,2].map(slot=>map.get(slot)||null);
  }
  function scorePlayerLabel(p){
    if(!p)return '— Blank —';
    return (p.first_name+' '+p.last_name).trim()+(p.ncsf_number?' • '+p.ncsf_number:'');
  }
  function lineupEditor(side){
    const players=(state.teamPlayers[side]||[]).filter(p=>!p.suspended);
    const lineup=lineupFor(side), reserves=reservesFor(side);
    const editable=canEditSide(side)&&!['SUBMITTED','CONFIRMED','APPROVED'].includes(state.fixture.fixture.status);
    const startLabels=side==='HOME'?['1','2','3','4','5']:['A','B','C','D','E'];
    const reserveLabels=side==='HOME'?['6','7']:['F','G'];
    const selectedIds=new Set([...lineup,...reserves].filter(Boolean).map(x=>x.player_id));
    const playerOptions=(selected)=>{
      const usable=players.filter(p=>p.id===selected||!selectedIds.has(p.id));
      return options(usable,'id',p=>scorePlayerLabel(p),selected,'— Blank —');
    };
    return `<section class="match-roster ${side==='AWAY'?'away':''}">
      <div class="roster-heading">
        <div><span class="eyebrow">${side} TEAM</span><h3>${esc(side==='HOME'?state.fixture.fixture.homeTeamName:state.fixture.fixture.awayTeamName)}</h3></div>
        <span class="roster-note">5 starters + 2 reserves</span>
      </div>
      <div class="roster-grid">
        ${lineup.map((row,i)=>`<label class="roster-slot"><span class="roster-code">${startLabels[i]}</span><span class="roster-role">${i===0?'STARTERS':''}</span>${editable?`<select class="lineup-select" data-side="${side}" data-slot="${i+1}">${playerOptions(row?.player_id)}</select>`:`<span class="roster-name">${esc(scorePlayerLabel(row))}</span>`}</label>`).join('')}
        <div class="reserve-divider">RESERVES</div>
        ${reserves.map((row,i)=>`<label class="roster-slot reserve"><span class="roster-code">${reserveLabels[i]}</span><span class="roster-role">R${i+1}</span>${editable?`<select class="reserve-select" data-side="${side}" data-slot="${i+1}">${playerOptions(row?.player_id)}</select>`:`<span class="roster-name">${esc(scorePlayerLabel(row))}</span>`}</label>`).join('')}
      </div>
      ${editable?`<button class="btn primary save-lineup" data-side="${side}" type="button">Save ${side==='HOME'?'Home':'Away'} Match Roster</button>`:''}
    </section>`;
  }
  function roundHtml(round){
    const frames=state.fixture.frames.filter(f=>f.round_no===round);
    const home=frames.filter(f=>f.winner_side==='HOME').length;
    const away=frames.filter(f=>f.winner_side==='AWAY').length;
    const pHome=state.fixture.frames.filter(f=>f.round_no<=round&&f.winner_side==='HOME').length;
    const pAway=state.fixture.frames.filter(f=>f.round_no<=round&&f.winner_side==='AWAY').length;
    const editable=Boolean(state.user)&&!['SUBMITTED','CONFIRMED','APPROVED'].includes(state.fixture.fixture.status);
    const letters=['A','B','C','D','E'];
    return `<section class="score-round">
      <div class="score-round-title"><span></span><strong>ROUND ${round}</strong><span>${home} — ${away}</span></div>
      <div class="score-grid score-grid-head">
        <div>#</div><div>HOME TEAM</div><div></div><div>VS</div><div></div><div>AWAY TEAM</div><div>#</div>
      </div>
      ${frames.map(fr=>`<div class="score-grid">
        <div class="score-slot-no">${fr.home_slot}</div>
        <div class="score-player">${esc(fr.home_player_name)}</div>
        <button class="score-cell frame-win ${fr.winner_side==='HOME'?'selected':''}" data-frame="${fr.id}" data-winner="HOME" ${editable?'':'disabled'}>${fr.winner_side==='HOME'?'1':'0'}</button>
        <div class="score-vs">vs</div>
        <button class="score-cell frame-win ${fr.winner_side==='AWAY'?'selected':''}" data-frame="${fr.id}" data-winner="AWAY" ${editable?'':'disabled'}>${fr.winner_side==='AWAY'?'1':'0'}</button>
        <div class="score-player away">${esc(fr.away_player_name)}</div>
        <div class="score-slot-no">${letters[(fr.away_slot||1)-1]}</div>
      </div>`).join('')}
      <div class="score-total-row"><strong>TOTAL</strong><strong>${home}</strong><span></span><strong>${away}</strong><strong>TOTAL</strong></div>
      <div class="score-progressive-row"><em>Progressive Total</em><strong>${pHome}</strong><span></span><strong>${pAway}</strong><em>Progressive Total</em></div>
    </section>`;
  }
  function allMatchPlayers(){
    const ids=new Map();
    [...state.teamPlayers.HOME,...state.teamPlayers.AWAY].forEach(p=>ids.set(p.id,p));
    return [...ids.values()];
  }
  function selectedRoster(side){
    return [...lineupFor(side),...reservesFor(side)].filter(Boolean);
  }
  function reserveOptions(side){
    const selected=reservesFor(side).filter(Boolean).map(x=>x.player_id);
    return state.teamPlayers[side].filter(p=>selected.includes(p.id));
  }
  function playerStats(playerId){
    const frames=state.fixture.frames.filter(fr=>fr.home_player_id===playerId||fr.away_player_id===playerId);
    return {
      played:frames.filter(fr=>fr.winner_side).length,
      won:frames.filter(fr=>fr.winner_player_id===playerId).length
    };
  }
  function rosterSummary(side){
    const roster=selectedRoster(side);
    const labels=side==='HOME'?['1','2','3','4','5','6','7']:['A','B','C','D','E','F','G'];
    const rows=[0,1,2,3,4,5,6].map(i=>{
      const p=roster[i], st=p?playerStats(p.player_id):{played:0,won:0};
      return `<tr class="${i===5?'reserve-start':''}"><td>${labels[i]}</td><td>${p?esc((p.first_name+' '+p.last_name).trim()):'—'}</td><td>${st.played}</td><td><strong>${st.won}</strong></td></tr>`;
    }).join('');
    const totalP=roster.reduce((s,p)=>s+playerStats(p.player_id).played,0);
    const totalW=side==='HOME'?state.fixture.totals.home:state.fixture.totals.away;
    return `<div class="roster-summary">
      <table><thead><tr><th colspan="2">${side} TEAM</th><th>P</th><th>W</th></tr></thead>
      <tbody>${rows}<tr class="summary-total"><td colspan="2">TOTAL</td><td>${totalP}</td><td>${totalW}</td></tr></tbody></table>
    </div>`;
  }
  function renderScoresheet(){
    const data=state.fixture,f=data.fixture,t=data.totals;
    $('#sheetStatus').className='pill '+f.status;
    $('#sheetStatus').textContent=f.status.replaceAll('_',' ');
    const progress=Math.round((t.completed/25)*100);
    const players=allMatchPlayers();
    const currentHome=lineupFor('HOME').filter(Boolean);
    const currentAway=lineupFor('AWAY').filter(Boolean);
    const homeRoster=selectedRoster('HOME');
    const awayRoster=selectedRoster('AWAY');
    const side=userSide(f);
    const subSides=state.user?.role==='NCSF_ADMIN'?['HOME','AWAY']:(side&&side!=='NCSF'?[side]:[]);
    const date=f.fixtureDate?new Date(f.fixtureDate):null;
    const dateText=date?date.toLocaleDateString([], {year:'numeric',month:'2-digit',day:'2-digit'}):'TBA';
    const timeText=date?date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'TBA';
    const matchResult=t.completed<25?'IN PROGRESS':t.home>t.away?f.homeTeamName+' WON':t.away>t.home?f.awayTeamName+' WON':'DRAW';
    const matchComplete=t.completed===25;
    const homeCaptain=homeRoster.find(p=>p.player_id===f.homeCaptainId);
    const awayCaptain=awayRoster.find(p=>p.player_id===f.awayCaptainId);
    const hWin=matchComplete&&t.home>t.away?1:0, aWin=matchComplete&&t.away>t.home?1:0, draw=matchComplete&&t.home===t.away?1:0;
    $('#scoreSheetRoot').innerHTML=`
      <section class="official-sheet-head">
        <img class="js-score-logo" src="/ncsf-logo.jpg" alt="NCSF">
        <div><span class="eyebrow">NAMIBIA CUE SPORTS FEDERATION</span><h1>Blackball League Scoresheet</h1><p>${esc(f.seasonName)} • ${esc(f.divisionName)} • Round ${esc(f.roundNo)}</p></div>
        <div class="sheet-meta"><span>STARTING TIME<strong>${esc(timeText)}</strong></span><span>DATE<strong>${esc(dateText)}</strong></span><span>VENUE<strong>${esc(f.venue||'TBA')}</strong></span></div>
      </section>
      <section class="fixture-score-hero">
        <div><span class="eyebrow">HOME TEAM</span><h2>${esc(f.homeTeamName)}</h2><small>${esc(f.homeClubName)}</small></div>
        <div class="fixture-live-score"><strong>${t.home}</strong><span>VS</span><strong>${t.away}</strong><small>${t.completed}/25 frames</small></div>
        <div class="away"><span class="eyebrow">AWAY TEAM</span><h2>${esc(f.awayTeamName)}</h2><small>${esc(f.awayClubName)}</small></div>
      </section>
      <div class="score-progress"><span style="width:${progress}%"></span></div>
      <div class="match-rosters">${lineupEditor('HOME')}${lineupEditor('AWAY')}</div>
      ${data.frames.length===25?[1,2,3,4,5].map(roundHtml).join(''):'<div class="notice warn">Save both starting fives to generate the official 25-frame rotation.</div>'}
      <section class="final-score-card">
        <div><span>FINAL TOTAL</span><strong>${t.home}</strong></div>
        <div class="match-result"><span>MATCH RESULT</span><strong>${esc(matchResult)}</strong></div>
        <div><strong>${t.away}</strong><span>FINAL TOTAL</span></div>
      </section>
      <section class="match-extras-card">
        <form id="extrasForm">
          <label>Player of Match<select name="playerOfMatchId">${options(players,'id',p=>p.first_name+' '+p.last_name,f.playerOfMatchId,'— Select player —')}</select></label>
          <label>Break & Run<select name="breakRunPlayerId">${options(players,'id',p=>p.first_name+' '+p.last_name,f.breakRunPlayerId,'— Blank —')}</select></label>
          <label>Rack & Run<select name="rackRunPlayerId">${options(players,'id',p=>p.first_name+' '+p.last_name,f.rackRunPlayerId,'— Blank —')}</select></label>
          <label>Bonus Point<input name="bonusPoints" type="number" value="${esc(f.bonusPoints||0)}"></label>
          <label>Home Captain<select name="homeCaptainId">${options(homeRoster,'player_id',p=>(p.first_name+' '+p.last_name).trim(),f.homeCaptainId,'— Select captain —')}</select></label>
          <label>Away Captain<select name="awayCaptainId">${options(awayRoster,'player_id',p=>(p.first_name+' '+p.last_name).trim(),f.awayCaptainId,'— Select captain —')}</select></label>
          <label class="wide">Match Notes<textarea name="notes" rows="2">${esc(f.notes||'')}</textarea></label>
          ${state.user?'<button class="btn primary wide" type="submit">Save Match Details</button>':''}
        </form>
      </section>
      <div class="roster-summary-grid">${rosterSummary('HOME')}${rosterSummary('AWAY')}</div>
      <section class="signature-grid">
        <div><span>CAPTAIN SIGNATURE (HOME)</span><strong>${esc(homeCaptain?(homeCaptain.first_name+' '+homeCaptain.last_name).trim():'Selected captain')}</strong><i></i></div>
        <div><span>CAPTAIN SIGNATURE (AWAY)</span><strong>${esc(awayCaptain?(awayCaptain.first_name+' '+awayCaptain.last_name).trim():'Selected captain')}</strong><i></i></div>
      </section>
      <section class="league-calculations">
        <div class="section-head"><div><span class="eyebrow">CURRENT FIXTURE</span><h3>League Calculations</h3></div><small>Official standings update after approval.</small></div>
        <div class="table-wrap"><table><thead><tr><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>For</th><th>Against</th></tr></thead>
        <tbody>
          <tr><td><strong>${esc(f.homeTeamName)}</strong></td><td>${matchComplete?1:0}</td><td>${hWin}</td><td>${draw}</td><td>${matchComplete&&!hWin&&!draw?1:0}</td><td>${t.home}</td><td>${t.away}</td></tr>
          <tr><td><strong>${esc(f.awayTeamName)}</strong></td><td>${matchComplete?1:0}</td><td>${aWin}</td><td>${draw}</td><td>${matchComplete&&!aWin&&!draw?1:0}</td><td>${t.away}</td><td>${t.home}</td></tr>
        </tbody></table></div>
      </section>
      ${subSides.length?`<section class="substitution-card no-print">
        <div class="section-head"><div><span class="eyebrow">RESERVES</span><h3>Record a Substitution</h3></div></div>
        <form id="subForm" class="form-grid">
          <label>Side<select name="side" id="subSide">${subSides.map(s=>`<option value="${s}">${s}</option>`).join('')}</select></label>
          <label>Effective Round<select name="effectiveRound">${[1,2,3,4,5].map(r=>`<option value="${r}">${r}</option>`).join('')}</select></label>
          <label>Player Out<select name="outPlayerId" id="subOut"></select></label>
          <label>Reserve In<select name="inPlayerId" id="subIn"></select></label>
          <button class="btn secondary full" type="submit">Apply Substitution</button>
        </form>
        ${data.substitutions.length?'<div class="card-list">'+data.substitutions.map(s=>`<div class="card-row"><span><strong>${esc(s.side)}: ${esc(s.out_player_name)} → ${esc(s.in_player_name)}</strong><small>From round ${s.effective_round}</small></span></div>`).join('')+'</div>':''}
      </section>`:''}
      <section class="signed-sheet-card">
        <div class="section-head"><div><span class="eyebrow">MATCH RECORD</span><h3>Signed Scoresheet</h3></div></div>
        <div class="upload-box">${data.attachments.length?data.attachments.map(a=>`<div class="uploaded-file"><span><strong>${esc(a.filename)}</strong><br><small>${esc(new Date(a.created_at).toLocaleString())}</small></span><a class="btn small" target="_blank" href="/api/fixtures/${f.id}/attachment/${a.id}">Open</a></div>`).join(''):'<div class="muted">Upload the signed paper sheet or PDF from the toolbar.</div>'}</div>
      </section>
    `;
    bindSheetControls();
    updateActionButtons();
    const uploadLabel=$('#scoreUpload')?.closest('label');
    if(uploadLabel)uploadLabel.classList.toggle('hidden',!state.user||f.status==='APPROVED');
    function fillSubs(){
      const s=$('#subSide')?.value;if(!s)return;
      const starters=s==='HOME'?currentHome:currentAway;
      $('#subOut').innerHTML=options(starters,'player_id',p=>p.first_name+' '+p.last_name,null,'Select player out');
      $('#subIn').innerHTML=options(reserveOptions(s),'id',p=>p.first_name+' '+p.last_name,null,'Select selected reserve');
    }
    $('#subSide')?.addEventListener('change',fillSubs); fillSubs();
  }
  function bindSheetControls(){
    $$('.save-lineup').forEach(btn=>btn.addEventListener('click',async()=>{
      const side=btn.dataset.side;
      const values=$$('.lineup-select[data-side="'+side+'"]').map(s=>Number(s.value)).filter(Boolean);
      const reserveIds=$$('.reserve-select[data-side="'+side+'"]').map(s=>Number(s.value)).filter(Boolean);
      try{
        $('#saveState').textContent='Saving…';
        state.fixture=await api('/api/fixtures/'+state.fixture.fixture.id+'/lineup',{method:'PUT',body:{side,playerIds:values,reserveIds}});
        renderScoresheet(); $('#saveState').textContent='Saved'; toast(side+' lineup saved');
      }catch(err){$('#saveState').textContent='Not saved';toast(err.message,true)}
    }));
    $$('.frame-win').forEach(btn=>btn.addEventListener('click',async()=>{
      const current=state.fixture.frames.find(f=>f.id===Number(btn.dataset.frame));
      const winner=current?.winner_side===btn.dataset.winner?null:btn.dataset.winner;
      try{
        $('#saveState').textContent='Saving…';
        state.fixture=await api('/api/fixtures/'+state.fixture.fixture.id+'/frames/'+btn.dataset.frame,{method:'PUT',body:{winnerSide:winner}});
        renderScoresheet(); $('#saveState').textContent='Saved';
      }catch(err){$('#saveState').textContent='Not saved';toast(err.message,true)}
    }));
    $('#extrasForm')?.addEventListener('submit',async e=>{
      e.preventDefault(); try{
        state.fixture=await api('/api/fixtures/'+state.fixture.fixture.id+'/extras',{method:'PATCH',body:formObject(e.currentTarget)});
        renderScoresheet(); toast('Match details saved');
      }catch(err){toast(err.message,true)}
    });
    $('#subForm')?.addEventListener('submit',async e=>{
      e.preventDefault();try{
        state.fixture=await api('/api/fixtures/'+state.fixture.fixture.id+'/substitutions',{method:'POST',body:formObject(e.currentTarget)});
        renderScoresheet(); toast('Substitution saved');
      }catch(err){toast(err.message,true)}
    });
  }
  function updateActionButtons(){
    const f=state.fixture.fixture,side=userSide(f),u=state.user;
    const submit=$('#submitMatch'),confirm=$('#confirmMatch'),approve=$('#approveMatch');
    if(submit)submit.classList.toggle('hidden',!u||!(u.role==='NCSF_ADMIN'||side==='HOME')||!['SCHEDULED','IN_PROGRESS'].includes(f.status));
    if(confirm)confirm.classList.toggle('hidden',!u||!(u.role==='NCSF_ADMIN'||side==='AWAY')||f.status!=='SUBMITTED');
    if(approve)approve.classList.toggle('hidden',!u||!['NCSF_ADMIN','CLUB_ADMIN'].includes(u.role)||f.status!=='CONFIRMED');
  }

  async function loadPublicMetaIntoSelect(){
    state.meta=await api('/api/public/meta');
    const select=$('#publicDivision');
    if(!select)return null;
    select.innerHTML=options(state.meta.divisions,'id',d=>d.season_name+' — '+d.name,null,'Choose division');
    if(state.meta.divisions[0])select.value=state.meta.divisions[0].id;
    return select;
  }

  async function initFixturesPage(){
    const select=await loadPublicMetaIntoSelect();
    if(!select)return;
    const load=async()=>{
      const id=Number(select.value||0);
      if(!id){$('#publicFixtures').innerHTML='<div class="empty">No division configured yet.</div>';return}
      const status=$('#fixtureStatusFilter')?.value||'SCHEDULED,POSTPONED';
      try{
        const d=await api('/api/fixtures?divisionId='+id+'&status='+encodeURIComponent(status));
        $('#publicFixtures').innerHTML=fixtureCards(d.fixtures,true);
      }catch(err){toast(err.message,true)}
    };
    select.addEventListener('change',load);
    $('#fixtureStatusFilter')?.addEventListener('change',load);
    await load();
  }

  async function initResultsPage(){
    const select=await loadPublicMetaIntoSelect();
    if(!select)return;
    const load=async()=>{
      const id=Number(select.value||0);
      if(!id){$('#publicResults').innerHTML='<div class="empty">No division configured yet.</div>';return}
      try{
        const d=await api('/api/fixtures?divisionId='+id+'&status=APPROVED');
        $('#publicResults').innerHTML=fixtureCards(d.fixtures,true);
      }catch(err){toast(err.message,true)}
    };
    select.addEventListener('change',load);
    await load();
  }

  async function initTeamsPage(){
    const select=await loadPublicMetaIntoSelect();
    if(!select)return;
    const load=async()=>{
      const id=Number(select.value||0);
      if(!id){$('#publicTeams').innerHTML='<div class="empty">No division configured yet.</div>';return}
      try{
        const d=await api('/api/public/teams?divisionId='+id);
        $('#publicTeams').innerHTML=d.teams.length
          ? '<div class="table-wrap"><table><thead><tr><th>Team</th><th>Club</th><th>Division</th><th>Players</th></tr></thead><tbody>'+d.teams.map(t=>`<tr><td><strong>${esc(t.name)}</strong></td><td>${esc(t.club_name)}</td><td>${esc(t.division_name||'—')}</td><td>${t.player_count}</td></tr>`).join('')+'</tbody></table></div>'
          : '<div class="empty">No teams registered in this division.</div>';
      }catch(err){toast(err.message,true)}
    };
    select.addEventListener('change',load);
    await load();
  }

  async function initPlayersPage(){
    const select=await loadPublicMetaIntoSelect();
    if(!select)return;
    let players=[];
    const render=()=>{
      const q=String($('#playerSearch')?.value||'').trim().toLowerCase();
      const rows=!q?players:players.filter(p=>(p.first_name+' '+p.last_name+' '+(p.ncsf_number||'')+' '+p.club_name+' '+p.team_name).toLowerCase().includes(q));
      $('#publicPlayers').innerHTML=rows.length
        ? '<div class="table-wrap"><table><thead><tr><th>Player</th><th>NCSF Number</th><th>Club</th><th>Team</th><th>Frames</th><th>Won</th><th>Win %</th></tr></thead><tbody>'+rows.map(p=>`<tr><td><strong>${esc(p.first_name+' '+p.last_name)}</strong></td><td>${esc(p.ncsf_number||'—')}</td><td>${esc(p.club_name)}</td><td>${esc(p.team_name)}</td><td>${p.frames_played}</td><td><strong>${p.frames_won}</strong></td><td>${p.win_percentage}%</td></tr>`).join('')+'</tbody></table></div>'
        : '<div class="empty">No players found.</div>';
    };
    const load=async()=>{
      const id=Number(select.value||0);
      if(!id){players=[];render();return}
      try{
        players=(await api('/api/public/players?divisionId='+id)).players;
        render();
      }catch(err){toast(err.message,true)}
    };
    select.addEventListener('change',load);
    $('#playerSearch')?.addEventListener('input',render);
    await load();
  }

  async function initRankingsPage(){
    const select=await loadPublicMetaIntoSelect();
    if(!select)return;
    const load=async()=>{
      const id=Number(select.value||0);
      if(!id){
        $('#fullTeamRankings').innerHTML='<div class="empty">No division configured yet.</div>';
        $('#fullPlayerRankings').innerHTML='<div class="empty">No division configured yet.</div>';
        return;
      }
      try{
        const [st,pr]=await Promise.all([
          api('/api/divisions/'+id+'/standings'),
          api('/api/divisions/'+id+'/individual-rankings')
        ]);
        $('#fullTeamRankings').innerHTML=st.standings.length
          ? '<div class="table-wrap"><table><thead><tr><th>#</th><th>Team</th><th>P</th><th>W</th><th>Frames Won</th><th>Lost</th><th>+/-</th></tr></thead><tbody>'+st.standings.map((r,i)=>`<tr><td class="rank">${i+1}</td><td><strong>${esc(r.team_name)}</strong><br><small class="muted">${esc(r.club_name)}</small></td><td>${r.played}</td><td>${r.wins}</td><td><strong>${r.frames_won}</strong></td><td>${r.frames_lost}</td><td>${Number(r.frame_difference)>0?'+':''}${r.frame_difference}</td></tr>`).join('')+'</tbody></table></div>'
          : '<div class="empty">No approved results yet.</div>';
        $('#fullPlayerRankings').innerHTML=pr.rankings.length
          ? '<div class="table-wrap"><table><thead><tr><th>#</th><th>Player</th><th>Team</th><th>Frames</th><th>Won</th><th>Lost</th><th>Win %</th></tr></thead><tbody>'+pr.rankings.map((r,i)=>`<tr><td class="rank">${i+1}</td><td><strong>${esc(r.player_name)}</strong><br><small class="muted">${esc(r.ncsf_number||'—')}</small></td><td>${esc(r.team_name)}</td><td>${r.frames_played}</td><td><strong>${r.frames_won}</strong></td><td>${r.frames_lost}</td><td>${r.win_percentage}%</td></tr>`).join('')+'</tbody></table></div>'
          : '<div class="empty">No approved player results yet.</div>';
      }catch(err){toast(err.message,true)}
    };
    select.addEventListener('change',load);
    await load();
  }

function formatEventDate(value){
    if(!value)return '';
    const d=new Date(value);
    return d.toLocaleString([], {weekday:'short',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
  }
  function renderPublicPosts(posts){
    const events=posts.filter(p=>p.type==='EVENT' && (!p.event_date || new Date(p.event_date)>=new Date(Date.now()-86400000)));
    const updates=posts.filter(p=>p.type!=='EVENT');
    const eventsBox=$('#publicEvents');
    const newsBox=$('#publicNews');
    if(eventsBox)eventsBox.innerHTML=events.length
      ? '<div class="timeline">'+events.map(p=>`<article class="timeline-item ${p.pinned?'pinned':''}"><div class="timeline-date">${esc(formatEventDate(p.event_date))}</div><div><span class="content-type EVENT">EVENT</span><h3>${esc(p.title)}</h3>${p.body?`<p>${esc(p.body)}</p>`:''}</div></article>`).join('')+'</div>'
      : '<div class="empty">No upcoming events published.</div>';
    if(newsBox)newsBox.innerHTML=updates.length
      ? '<div class="news-feed">'+updates.map(p=>`<article class="news-card ${p.pinned?'pinned':''}"><div class="news-meta"><span class="content-type ${p.type}">${esc(p.type)}</span><span>${esc(new Date(p.created_at).toLocaleDateString())}</span></div><h3>${esc(p.title)}</h3>${p.body?`<p>${esc(p.body)}</p>`:''}</article>`).join('')+'</div>'
      : '<div class="empty">No news or announcements published.</div>';
  }
  async function initNewsPage(){
    try{
      const data=await api('/api/public/posts');
      renderPublicPosts(data.posts||[]);
    }catch(err){toast(err.message,true)}
  }
  async function initScoresheet(){
    const id=Number(new URLSearchParams(location.search).get('id'));
    if(!id){$('#scoreSheetRoot').innerHTML='<div class="empty">No fixture selected.</div>';return}
    try{
      state.fixture=await api('/api/fixtures/'+id);
      const f=state.fixture.fixture;
      const [home,away]=await Promise.all([api('/api/teams/'+f.homeTeamId+'/players'),api('/api/teams/'+f.awayTeamId+'/players')]);
      state.teamPlayers.HOME=home.players;state.teamPlayers.AWAY=away.players;
      renderScoresheet();
    }catch(err){$('#scoreSheetRoot').innerHTML='<div class="notice error">'+esc(err.message)+'</div>';return}
    $('#printSheet')?.addEventListener('click',()=>window.print());
    $('#scoreUpload')?.addEventListener('change',async e=>{
      const file=e.target.files[0];if(!file)return;
      const fd=new FormData();fd.append('scoresheet',file);
      try{
        await api('/api/fixtures/'+state.fixture.fixture.id+'/upload',{method:'POST',body:fd});
        state.fixture=await api('/api/fixtures/'+state.fixture.fixture.id);renderScoresheet();toast('Signed score sheet uploaded');
      }catch(err){toast(err.message,true)}
    });
    $('#submitMatch')?.addEventListener('click',()=>transitionMatch('submit','Match submitted for opponent confirmation'));
    $('#confirmMatch')?.addEventListener('click',()=>transitionMatch('confirm','Result confirmed'));
    $('#approveMatch')?.addEventListener('click',()=>transitionMatch('approve','Result approved and rankings updated'));
  }
  async function transitionMatch(action,message){
    try{
      state.fixture=await api('/api/fixtures/'+state.fixture.fixture.id+'/'+action,{method:'POST'});
      renderScoresheet();toast(message);
    }catch(err){toast(err.message,true)}
  }
  async function initTeam(){
    if(!requireUser())return;
    const f=await api('/api/my/fixtures');
    $('#myFixtures').innerHTML=fixtureCards(f.fixtures,true);
    if(state.user.role==='TEAM_ADMIN'){
      $('#teamIdentity').innerHTML='<strong>'+esc(state.user.teamName||'My Team')+'</strong> • '+esc(state.user.clubName||'');
      const squad=await api('/api/teams/'+state.user.teamId+'/players');
      $('#mySquad').innerHTML=squad.players.length?'<div class="card-list">'+squad.players.map(p=>`<div class="card-row"><span><strong>${esc(p.first_name+' '+p.last_name)}</strong><small>${esc(p.ncsf_number||'No NCSF Number')}</small></span>${p.suspended?'<span class="pill FORFEIT">Suspended</span>':'<span class="pill APPROVED">Eligible</span>'}</div>`).join('')+'</div>':'<div class="empty">No players assigned to this team yet.</div>';
    }else{
      $('#teamIdentity').innerHTML=state.user.role==='CLUB_ADMIN'?'<strong>'+esc(state.user.clubName||'Club')+'</strong> • club fixture access':'<strong>NCSF Administration</strong> • all fixtures';
      $('#mySquad').innerHTML='<div class="muted">Squad lists are available inside each team/scoresheet.</div>';
    }
  }
  async function initClubAdmin(){
    if(!requireUser(['CLUB_ADMIN']))return;
    $('#clubIdentity').innerHTML='<strong>'+esc(state.user.clubName||'Club')+'</strong> • manage players and distribute team access';
    await reloadClub();
    $('#playerForm').addEventListener('submit',async e=>{
      e.preventDefault();try{await api('/api/admin/players',{method:'POST',body:formObject(e.currentTarget)});e.currentTarget.reset();await reloadClub();toast('Player added')}catch(err){toast(err.message,true)}
    });
    $('#teamUserForm').addEventListener('submit',async e=>{
      e.preventDefault();try{await api('/api/admin/users',{method:'POST',body:formObject(e.currentTarget)});e.currentTarget.reset();await reloadClub();toast('Team login created')}catch(err){toast(err.message,true)}
    });
  }
  async function reloadClub(){
    state.meta=await api('/api/admin/meta');
    const teams=state.meta.teams;
    $('#playerTeamSelect').innerHTML=options(teams,'id',t=>t.name,null,'Unassigned / reserve pool');
    $('#userTeamSelect').innerHTML=options(teams,'id',t=>t.name,null,'Select team');
    $('#playerCount').textContent=state.meta.players.length;
    $('#clubPlayers').innerHTML=state.meta.players.length?`<div class="table-wrap"><table><thead><tr><th>Player</th><th>NCSF Number</th><th>Team</th><th>Status</th></tr></thead><tbody>${state.meta.players.map(p=>`<tr><td><strong>${esc(p.first_name+' '+p.last_name)}</strong></td><td>${esc(p.ncsf_number||'—')}</td><td><select class="player-team-change" data-player="${p.id}">${options(teams,'id',t=>t.name,p.team_id,'Unassigned')}</select></td><td>${p.suspended?'<span class="pill FORFEIT">Suspended</span>':'<span class="pill APPROVED">Eligible</span>'}<br><button class="btn small player-suspend" data-player="${p.id}" data-suspended="${p.suspended}">${p.suspended?'Reactivate':'Suspend'}</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No players registered.</div>';
    $$('.player-team-change').forEach(sel=>sel.addEventListener('change',async()=>{
      try{await api('/api/admin/players/'+sel.dataset.player,{method:'PATCH',body:{teamId:sel.value||null}});toast('Player assignment updated');await reloadClub()}catch(err){toast(err.message,true)}
    }));
    $$('.player-suspend').forEach(btn=>btn.addEventListener('click',async()=>{
      try{await api('/api/admin/players/'+btn.dataset.player,{method:'PATCH',body:{suspended:btn.dataset.suspended!=='true'}});toast('Player eligibility updated');await reloadClub()}catch(err){toast(err.message,true)}
    }));
    $('#clubTeams').innerHTML=teams.length?'<div class="card-list">'+teams.map(t=>{
      const access=state.meta.users.filter(u=>u.team_id===t.id&&u.role==='TEAM_ADMIN');
      return `<div class="card-row"><span><strong>${esc(t.name)}</strong><small>${esc(t.division_name||'No division')} • ${state.meta.players.filter(p=>p.team_id===t.id).length} players</small></span><span>${access.length?access.map(u=>`<span class="pill ${u.active?'APPROVED':'FORFEIT'}">${esc(u.display_name)}${u.active?'':' (Disabled)'}</span> <button class="btn small club-user-password" data-id="${u.id}">Reset</button> <button class="btn small ${u.active?'danger':''} club-user-active" data-id="${u.id}" data-active="${u.active}">${u.active?'Disable':'Enable'}</button>`).join('<br>'):'<span class="muted">No team login</span>'}</span></div>`;
    }).join('')+'</div>':'<div class="empty">No teams assigned to this club.</div>';
    $$('.club-user-password').forEach(btn=>btn.addEventListener('click',async()=>{
      const password=prompt('Enter a new temporary password (minimum 8 characters):');
      if(password===null)return;
      try{await api('/api/admin/users/'+btn.dataset.id,{method:'PATCH',body:{password}});toast('Team login password reset')}catch(err){toast(err.message,true)}
    }));
    $$('.club-user-active').forEach(btn=>btn.addEventListener('click',async()=>{
      const active=btn.dataset.active!=='true';
      if(!confirm((active?'Enable':'Disable')+' this team login?'))return;
      try{await api('/api/admin/users/'+btn.dataset.id,{method:'PATCH',body:{active}});await reloadClub();toast('Team login updated')}catch(err){toast(err.message,true)}
    }));
  }
  async function initAdmin(){
    if(!requireUser(['NCSF_ADMIN']))return;
    const showPane=(name)=>{
      $$('.admin-tabs button').forEach(b=>b.classList.toggle('active',b.dataset.adminTab===name));
      $$('.admin-pane').forEach(p=>p.classList.toggle('hidden',p.dataset.pane!==name));
    };
    $$('.admin-tabs button').forEach(btn=>btn.addEventListener('click',()=>showPane(btn.dataset.adminTab)));
    showPane($('.admin-tabs button.active')?.dataset.adminTab||'dashboard');
    await reloadAdmin();
    bindAdminForms();
  }
  async function reloadAdmin(){
    state.meta=await api('/api/admin/meta');
    const m=state.meta;
    $('#divisionSeason').innerHTML=options(m.seasons,'id',s=>s.name,null,'Select season');
    ['teamDivision','fixtureDivision','scheduleDivision'].forEach(id=>$('#'+id).innerHTML=options(m.divisions,'id',d=>d.season_name+' — '+d.name,null,'Select division'));
    ['teamClub','adminUserClub','adminPlayerClub'].forEach(id=>$('#'+id).innerHTML=options(m.clubs,'id',c=>c.name,null,'Select club'));
    $('#adminUserTeam').innerHTML=options(m.teams,'id',t=>t.club_name+' — '+t.name,null,'Select team');
    $('#adminPlayerTeam').innerHTML=options(m.teams,'id',t=>t.club_name+' — '+t.name,null,'Unassigned');
    renderAdminLists();
    syncFixtureTeams();
    loadAdminDashboard();
    loadAdminPosts();
  }
  async function loadAdminDashboard(){
    try{
      const d=await api('/api/admin/dashboard');
      if($('#statClubs'))$('#statClubs').textContent=d.counts.clubs||0;
      if($('#statTeams'))$('#statTeams').textContent=d.counts.teams||0;
      if($('#statPlayers'))$('#statPlayers').textContent=d.counts.players||0;
      if($('#pendingCount'))$('#pendingCount').textContent=d.pending.length;
      if($('#missingAccessCount'))$('#missingAccessCount').textContent=d.missingAccess.length;
      if($('#pendingResults'))$('#pendingResults').innerHTML=d.pending.length
        ? '<div class="card-list">'+d.pending.map(f=>`<div class="card-row"><span><strong>${esc(f.home_team_name)} ${f.home_frames} — ${f.away_frames} ${esc(f.away_team_name)}</strong><small>${esc(f.division_name)} • Round ${f.round_no} • ${esc(fmtDate(f.fixture_date))}</small></span><a class="btn small primary" href="/scoresheet?id=${f.id}">${f.status==='CONFIRMED'?'Review / Approve':'Review'}</a></div>`).join('')+'</div>'
        : '<div class="empty">No results waiting for approval.</div>';
      if($('#missingTeamAccess'))$('#missingTeamAccess').innerHTML=d.missingAccess.length
        ? '<div class="card-list">'+d.missingAccess.map(t=>`<div class="card-row"><span><strong>${esc(t.team_name)}</strong><small>${esc(t.club_name)}</small></span><button class="btn small goto-access">Create Login</button></div>`).join('')+'</div>'
        : '<div class="empty">Every team has an active login.</div>';
      $$('.goto-access').forEach(btn=>btn.addEventListener('click',()=>{
        const tab=$('[data-admin-tab="access"]'); if(tab)tab.click();
      }));
      if($('#fixtureStatusSummary')){
        const order=['SCHEDULED','IN_PROGRESS','SUBMITTED','CONFIRMED','APPROVED','POSTPONED','FORFEIT'];
        $('#fixtureStatusSummary').innerHTML=order.filter(k=>d.byStatus[k]).map(k=>`<span class="pill ${k}">${k.replaceAll('_',' ')}: ${d.byStatus[k]}</span>`).join('') || '<span class="muted">No fixtures yet.</span>';
      }
    }catch(err){toast(err.message,true)}
  }

  function renderAdminFixtures(fixtures){
    const box=$('#adminFixtures'); if(!box)return;
    if(!fixtures.length){box.innerHTML='<div class="empty">No fixtures yet.</div>';return}
    box.innerHTML='<div class="table-wrap"><table><thead><tr><th>Date</th><th>Round</th><th>Fixture</th><th>Score</th><th>Status</th><th>Actions</th></tr></thead><tbody>'+
      fixtures.map(f=>`<tr>
        <td>${esc(fmtDate(f.fixture_date))}<br><small class="muted">${esc(f.venue||'Venue TBA')}</small></td>
        <td>${f.round_no}</td>
        <td><strong>${esc(f.home_team_name)}</strong><br><span class="muted">vs</span> ${esc(f.away_team_name)}</td>
        <td><strong>${f.home_frames||0} — ${f.away_frames||0}</strong></td>
        <td>${statusPill(f.status)}</td>
        <td>
          <a class="btn small secondary" href="/scoresheet?id=${f.id}">Open</a>
          <button class="btn small fixture-edit" data-id="${f.id}">Edit</button>
          ${f.status==='POSTPONED'?`<button class="btn small fixture-restore" data-id="${f.id}">Restore</button>`:(!['APPROVED','FORFEIT'].includes(f.status)?`<button class="btn small fixture-postpone" data-id="${f.id}">Postpone</button>`:'')}
          ${['SCHEDULED','POSTPONED'].includes(f.status)?`<button class="btn small danger fixture-delete" data-id="${f.id}">Delete</button>`:''}
        </td>
      </tr>`).join('')+'</tbody></table></div>';

    $$('.fixture-edit').forEach(btn=>btn.addEventListener('click',async()=>{
      const f=fixtures.find(x=>x.id===Number(btn.dataset.id)); if(!f)return;
      const roundNo=prompt('Round number',String(f.round_no)); if(roundNo===null)return;
      const currentDate=f.fixture_date?new Date(f.fixture_date).toISOString().slice(0,16):'';
      const fixtureDate=prompt('Match date/time (YYYY-MM-DDTHH:MM). Leave blank for TBA.',currentDate); if(fixtureDate===null)return;
      const venue=prompt('Venue',f.venue||''); if(venue===null)return;
      try{
        await api('/api/admin/fixtures/'+f.id,{method:'PATCH',body:{roundNo:Number(roundNo),fixtureDate:fixtureDate||null,venue}});
        await reloadAdmin(); toast('Fixture updated');
      }catch(err){toast(err.message,true)}
    }));
    $$('.fixture-postpone').forEach(btn=>btn.addEventListener('click',async()=>{
      if(!confirm('Postpone this fixture?'))return;
      try{await api('/api/admin/fixtures/'+btn.dataset.id+'/postpone',{method:'POST'});await reloadAdmin();toast('Fixture postponed')}catch(err){toast(err.message,true)}
    }));
    $$('.fixture-restore').forEach(btn=>btn.addEventListener('click',async()=>{
      try{await api('/api/admin/fixtures/'+btn.dataset.id+'/restore',{method:'POST'});await reloadAdmin();toast('Fixture restored')}catch(err){toast(err.message,true)}
    }));
    $$('.fixture-delete').forEach(btn=>btn.addEventListener('click',async()=>{
      if(!confirm('Delete this unplayed fixture? This cannot be undone.'))return;
      try{await api('/api/admin/fixtures/'+btn.dataset.id,{method:'DELETE'});await reloadAdmin();toast('Fixture deleted')}catch(err){toast(err.message,true)}
    }));
  }

async function loadAdminPosts(){
    const box=$('#adminPosts'); if(!box)return;
    try{
      const data=await api('/api/admin/posts');
      const posts=data.posts||[];
      box.innerHTML=posts.length?'<div class="card-list">'+posts.map(p=>`<div class="card-row content-admin-row"><span><span class="content-type ${p.type}">${esc(p.type)}</span><strong>${esc(p.title)}</strong><small>${p.type==='EVENT'&&p.event_date?esc(formatEventDate(p.event_date)):esc(new Date(p.created_at).toLocaleDateString())}${p.pinned?' • Pinned':''}${p.published?'':' • Draft'}</small></span><span><button class="btn small content-toggle" data-id="${p.id}" data-published="${p.published}">${p.published?'Unpublish':'Publish'}</button> <button class="btn small danger content-delete" data-id="${p.id}">Delete</button></span></div>`).join('')+'</div>':'<div class="empty">No posts yet.</div>';
      $('.content-toggle').forEach(btn=>btn.addEventListener('click',async()=>{
        try{await api('/api/admin/posts/'+btn.dataset.id,{method:'PATCH',body:{published:btn.dataset.published!=='true'}});await loadAdminPosts();toast('Post updated')}catch(err){toast(err.message,true)}
      }));
      $('.content-delete').forEach(btn=>btn.addEventListener('click',async()=>{
        if(!confirm('Delete this public post?'))return;
        try{await api('/api/admin/posts/'+btn.dataset.id,{method:'DELETE'});await loadAdminPosts();toast('Post deleted')}catch(err){toast(err.message,true)}
      }));
    }catch(err){box.innerHTML='<div class="empty">'+esc(err.message)+'</div>'}
  }
  function renderAdminLists(){
    const m=state.meta;
    $('#adminClubList').innerHTML=m.clubs.length?'<div class="card-list">'+m.clubs.map(c=>`<div class="card-row"><span><strong>${esc(c.name)}</strong><small>${m.teams.filter(t=>t.club_id===c.id).map(t=>t.name).join(', ')||'No teams'}</small></span></div>`).join('')+'</div>':'<div class="empty">No clubs yet.</div>';
    api('/api/fixtures').then(d=>renderAdminFixtures(d.fixtures)).catch(err=>toast(err.message,true));
    $('#adminUsers').innerHTML=m.users.length?'<div class="card-list">'+m.users.map(u=>`<div class="card-row"><span><strong>${esc(u.display_name)}</strong><small>${esc(u.email)} • ${esc(u.role.replaceAll('_',' '))} • ${u.active?'Active':'Disabled'}</small></span><span><span class="muted">${esc(u.team_name||u.club_name||'NCSF')}</span><br><button class="btn small admin-user-password" data-id="${u.id}">Reset Password</button> ${u.id!==state.user.id?`<button class="btn small ${u.active?'danger':''} admin-user-active" data-id="${u.id}" data-active="${u.active}">${u.active?'Disable':'Enable'}</button>`:''}</span></div>`).join('')+'</div>':'<div class="empty">No users.</div>';
    $$('.admin-user-password').forEach(btn=>btn.addEventListener('click',async()=>{
      const password=prompt('Enter a new temporary password (minimum 8 characters):');
      if(password===null)return;
      try{await api('/api/admin/users/'+btn.dataset.id,{method:'PATCH',body:{password}});toast('Password reset')}catch(err){toast(err.message,true)}
    }));
    $$('.admin-user-active').forEach(btn=>btn.addEventListener('click',async()=>{
      const active=btn.dataset.active!=='true';
      if(!confirm((active?'Enable':'Disable')+' this login?'))return;
      try{await api('/api/admin/users/'+btn.dataset.id,{method:'PATCH',body:{active}});await reloadAdmin();toast('Login updated')}catch(err){toast(err.message,true)}
    }));
    $('#adminPlayers').innerHTML=m.players.length?'<div class="table-wrap"><table><thead><tr><th>Player</th><th>Club</th><th>Team</th><th>Frames</th><th>Status</th></tr></thead><tbody>'+m.players.map(p=>`<tr><td><strong>${esc(p.first_name+' '+p.last_name)}</strong><br><small class="muted">${esc(p.ncsf_number||'—')}</small></td><td>${esc(p.club_name)}</td><td>${esc(p.team_name||'Unassigned')}</td><td>—</td><td>${p.suspended?'<span class="pill FORFEIT">Suspended</span>':'<span class="pill APPROVED">Eligible</span>'}<br><button class="btn small admin-player-suspend" data-player="${p.id}" data-suspended="${p.suspended}">${p.suspended?'Reactivate':'Suspend'}</button></td></tr>`).join('')+'</tbody></table></div>':'<div class="empty">No players registered.</div>';
    $$('.admin-player-suspend').forEach(btn=>btn.addEventListener('click',async()=>{try{await api('/api/admin/players/'+btn.dataset.player,{method:'PATCH',body:{suspended:btn.dataset.suspended!=='true'}});toast('Player eligibility updated');await reloadAdmin()}catch(err){toast(err.message,true)}}));
  }
  function syncFixtureTeams(){
    const div=Number($('#fixtureDivision')?.value||0);
    const teams=state.meta.teams.filter(t=>!div||t.division_id===div);
    $('#fixtureHome').innerHTML=options(teams,'id',t=>t.name,null,'Home team');
    $('#fixtureAway').innerHTML=options(teams,'id',t=>t.name,null,'Away team');
  }
  function bindAdminForms(){
    $('#fixtureDivision')?.addEventListener('change',syncFixtureTeams);
    const contentType=$('#contentType'), contentDate=$('#contentEventDate');
    const syncContentType=()=>{if(contentDate){const event=contentType?.value==='EVENT';contentDate.disabled=!event;contentDate.required=event;if(!event)contentDate.value=''}};
    contentType?.addEventListener('change',syncContentType); syncContentType();
    $('#contentPostForm')?.addEventListener('submit',async e=>{
      e.preventDefault();
      const form=e.currentTarget, submit=form.querySelector('[type="submit"]');
      if(submit?.disabled)return;if(submit)submit.disabled=true;
      try{
        await api('/api/admin/posts',{method:'POST',body:formObject(form)});
        form.reset();syncContentType();await loadAdminPosts();toast('Published');
      }catch(err){toast(err.message,true)}
      finally{if(submit)submit.disabled=false}
    });
    const simple=[
      ['seasonForm','/api/admin/seasons','Season created'],
      ['divisionForm','/api/admin/divisions','Division created'],
      ['clubForm','/api/admin/clubs','Club created'],
      ['teamForm','/api/admin/teams','Team created'],
      ['adminPlayerForm','/api/admin/players','Player registered'],
      ['fixtureForm','/api/admin/fixtures','Fixture created'],
      ['adminUserForm','/api/admin/users','Login created']
    ];
    simple.forEach(([id,url,msg])=>$('#'+id)?.addEventListener('submit',async e=>{
      e.preventDefault();
      const form=e.currentTarget;
      const submit=form.querySelector('[type="submit"]');
      if(submit?.disabled)return;
      if(submit)submit.disabled=true;
      try{
        await api(url,{method:'POST',body:formObject(form)});
        form.reset();
        await reloadAdmin();
        toast(msg);
      }catch(err){
        toast(err.message,true);
      }finally{
        if(submit)submit.disabled=false;
      }
    }));
    $('#scheduleForm')?.addEventListener('submit',async e=>{
      e.preventDefault();const o=formObject(e.currentTarget);
      try{
        const d=await api('/api/admin/divisions/'+o.divisionId+'/generate-home-away',{method:'POST',body:{firstDate:o.firstDate}});
        await reloadAdmin();toast(d.created+' home-and-away fixtures created');
      }catch(err){toast(err.message,true)}
    });
  }

  await loadUser();
  try{
    if(PAGE==='home')await initHome();
    if(PAGE==='fixtures-page')await initFixturesPage();
    if(PAGE==='results-page')await initResultsPage();
    if(PAGE==='teams-page')await initTeamsPage();
    if(PAGE==='players-page')await initPlayersPage();
    if(PAGE==='news-page')await initNewsPage();
    if(PAGE==='rankings-page')await initRankingsPage();
    if(PAGE==='scoresheet')await initScoresheet();
    if(PAGE==='team')await initTeam();
    if(PAGE==='club-admin')await initClubAdmin();
    if(PAGE==='admin')await initAdmin();
  }catch(err){toast(err.message,true);console.error(err)}
})();