(async function browserApp(){
  const $=(s,r=document)=>r.querySelector(s);
  const $$=(s,r=document)=>[...r.querySelectorAll(s)];
  const PAGE=document.body.dataset.page;
  const state={user:null,meta:null,fixture:null,teamPlayers:{HOME:[],AWAY:[]}};

  $$('.js-logo').forEach(img=>img.src='/ncsf-logo.svg');

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
      $('#loginBtn')?.addEventListener('click',openAuth);
      return;
    }
    let links='';
    if(state.user.role==='NCSF_ADMIN')links+='<a class="btn light small" href="/admin.html">NCSF Admin</a>';
    if(state.user.role==='CLUB_ADMIN')links+='<a class="btn light small" href="/club-admin.html">Club Admin</a>';
    links+='<a class="btn light small" href="/team.html">Match Centre</a>';
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
        if(state.user.role==='NCSF_ADMIN')location.href='/admin.html';
        else if(state.user.role==='CLUB_ADMIN')location.href='/club-admin.html';
        else location.href='/team.html';
      }catch(err){toast(err.message,true)}
    });
    $('#setupForm')?.addEventListener('submit',async e=>{
      e.preventDefault();
      try{
        const data=await api('/api/setup',{method:'POST',body:formObject(e.currentTarget)});
        state.user=data.user; toast('NCSF administrator created'); location.href='/admin.html';
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
        <div class="open-cell">${allowOpen && (PAGE!=='home' || f.status==='APPROVED' || Boolean(state.user))?`<a class="btn small secondary" href="/scoresheet.html?id=${f.id}">Open scoresheet</a>`:''}</div>
      </div>`).join('');
  }
  async function initHome(){
    bindAuth();
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
  function lineupEditor(side){
    const players=(state.teamPlayers[side]||[]).filter(p=>!p.suspended), lineup=lineupFor(side);
    const editable=canEditSide(side)&&!['SUBMITTED','CONFIRMED','APPROVED'].includes(state.fixture.fixture.status);
    return `<div class="sheet-team ${side==='AWAY'?'away':''}">
      <div class="kicker">${side} TEAM — STARTING FIVE</div>
      <h2>${esc(side==='HOME'?state.fixture.fixture.homeTeamName:state.fixture.fixture.awayTeamName)}</h2>
      <div class="lineup-list" style="margin-top:12px">
        ${lineup.map((row,i)=>`<div class="lineup-row"><span class="slot">${i+1}</span>${editable?`<select class="lineup-select" data-side="${side}" data-slot="${i+1}">${options(players,'id',p=>p.first_name+' '+p.last_name+(p.ncsf_number?' ('+p.ncsf_number+')':''),row?.player_id,'Select player')}</select>`:`<div><strong>${esc(row?row.first_name+' '+row.last_name:'Not selected')}</strong></div>`}</div>`).join('')}
      </div>
      ${editable?`<button class="btn primary small save-lineup" data-side="${side}" style="margin-top:12px">Save ${side.toLowerCase()} lineup</button>`:''}
    </div>`;
  }
  function roundHtml(round){
    const frames=state.fixture.frames.filter(f=>f.round_no===round);
    const home=frames.filter(f=>f.winner_side==='HOME').length;
    const away=frames.filter(f=>f.winner_side==='AWAY').length;
    const editable=Boolean(state.user)&&!['SUBMITTED','CONFIRMED','APPROVED'].includes(state.fixture.fixture.status);
    return `<section class="round">
      <div class="round-title">ROUND ${round}</div>
      ${frames.map(fr=>`<div class="frame-row">
        <div class="frame-num">${fr.board_no}</div>
        <div class="frame-player">${esc(fr.home_player_name)}</div>
        <button class="win-btn frame-win ${fr.winner_side==='HOME'?'selected':''}" data-frame="${fr.id}" data-winner="HOME" ${editable?'':'disabled'}>${fr.winner_side==='HOME'?'1':'0'}</button>
        <div class="frame-vs">vs</div>
        <button class="win-btn frame-win ${fr.winner_side==='AWAY'?'selected':''}" data-frame="${fr.id}" data-winner="AWAY" ${editable?'':'disabled'}>${fr.winner_side==='AWAY'?'1':'0'}</button>
        <div class="frame-player away">${esc(fr.away_player_name)}</div>
      </div>`).join('')}
      <div class="round-total"><div>TOTAL ${home}</div><div>${home} — ${away}</div><div>${away} TOTAL</div></div>
      <div class="round-total"><div>Progressive Total ${state.fixture.frames.filter(f=>f.round_no<=round&&f.winner_side==='HOME').length}</div><div>${state.fixture.frames.filter(f=>f.round_no<=round&&f.winner_side==='HOME').length} — ${state.fixture.frames.filter(f=>f.round_no<=round&&f.winner_side==='AWAY').length}</div><div>${state.fixture.frames.filter(f=>f.round_no<=round&&f.winner_side==='AWAY').length} Progressive Total</div></div>
    </section>`;
  }
  function allMatchPlayers(){
    const ids=new Map();
    [...state.teamPlayers.HOME,...state.teamPlayers.AWAY].forEach(p=>ids.set(p.id,p));
    return [...ids.values()];
  }
  function reserveOptions(side){
    const starters=new Set(lineupFor(side).filter(Boolean).map(x=>x.player_id));
    return state.teamPlayers[side].filter(p=>!p.suspended&&!starters.has(p.id));
  }
  function renderScoresheet(){
    const data=state.fixture,f=data.fixture,t=data.totals;
    $('#sheetStatus').className='pill '+f.status;
    $('#sheetStatus').textContent=f.status.replaceAll('_',' ');
    const progress=Math.round((t.completed/25)*100);
    const players=allMatchPlayers();
    const currentHome=lineupFor('HOME').filter(Boolean);
    const currentAway=lineupFor('AWAY').filter(Boolean);
    const side=userSide(f);
    const subSides=state.user?.role==='NCSF_ADMIN'?['HOME','AWAY']:(side&&side!=='NCSF'?[side]:[]);
    $('#scoreSheetRoot').innerHTML=`
      <div class="sheet-header">
        <div class="sheet-team"><div class="kicker">HOME</div><h2>${esc(f.homeTeamName)}</h2><div class="muted">${esc(f.homeClubName)}</div></div>
        <div style="text-align:center"><div class="big-score">${t.home} — ${t.away}</div><div class="muted">${t.completed}/25 frames</div></div>
        <div class="sheet-team away"><div class="kicker">AWAY</div><h2>${esc(f.awayTeamName)}</h2><div class="muted">${esc(f.awayClubName)}</div></div>
      </div>
      <div class="panel">
        <div class="panel-head"><div><div class="kicker">${esc(f.seasonName)} • ${esc(f.divisionName)}</div><h3>Round ${esc(f.roundNo)} • ${esc(fmtDate(f.fixtureDate))}</h3></div>${statusPill(f.status)}</div>
        <div class="muted">${esc(f.venue||'Venue TBA')}</div>
        <div class="progress-bar"><span style="width:${progress}%"></span></div>
      </div>
      <div class="lineup-boxes" style="margin-top:16px">${lineupEditor('HOME')}${lineupEditor('AWAY')}</div>
      ${data.frames.length===25?[1,2,3,4,5].map(roundHtml).join(''):'<div class="notice warn" style="margin-top:18px">Both teams must save five starting players before the 25-frame sheet is generated.</div>'}
      <div class="sheet-bottom">
        <section class="panel">
          <div class="panel-head"><div><div class="kicker">Signed match sheet</div><h3>Uploads</h3></div></div>
          <div class="upload-box">
            ${data.attachments.length?data.attachments.map(a=>`<div class="uploaded-file"><span><strong>${esc(a.filename)}</strong><br><small class="muted">${esc(new Date(a.created_at).toLocaleString())}</small></span><a class="btn small" target="_blank" href="/api/fixtures/${f.id}/attachment/${a.id}">Open</a></div>`).join(''):'<div class="muted">Upload a photo or PDF of the signed score sheet from the toolbar.</div>'}
          </div>
        </section>
        <section class="panel">
          <div class="kicker">Match details</div><h3>Extras</h3>
          <form id="extrasForm" class="form-grid">
            <label class="full">Player of Match<select name="playerOfMatchId">${options(players,'id',p=>p.first_name+' '+p.last_name,f.playerOfMatchId,'— Blank —')}</select></label>
            <label class="full">Break & Run<select name="breakRunPlayerId">${options(players,'id',p=>p.first_name+' '+p.last_name,f.breakRunPlayerId,'— Blank —')}</select></label>
            <label class="full">Rack & Run<select name="rackRunPlayerId">${options(players,'id',p=>p.first_name+' '+p.last_name,f.rackRunPlayerId,'— Blank —')}</select></label>
            <label>Bonus point<input name="bonusPoints" type="number" value="${esc(f.bonusPoints||0)}"></label>
            <label class="full">Notes<textarea name="notes" rows="2">${esc(f.notes||'')}</textarea></label>
            ${state.user?'<button class="btn secondary full" type="submit">Save Match Details</button>':''}
          </form>
        </section>
      </div>
      ${subSides.length?`<section class="panel no-print" style="margin-top:16px">
        <div class="kicker">Reserves</div><h3>Substitution</h3>
        <form id="subForm" class="form-grid">
          <label>Side<select name="side" id="subSide">${subSides.map(s=>`<option value="${s}">${s}</option>`).join('')}</select></label>
          <label>Effective round<select name="effectiveRound">${[1,2,3,4,5].map(r=>`<option value="${r}">${r}</option>`).join('')}</select></label>
          <label>Player out<select name="outPlayerId" id="subOut"></select></label>
          <label>Reserve in<select name="inPlayerId" id="subIn"></select></label>
          <button class="btn secondary full" type="submit">Apply substitution</button>
        </form>
        ${data.substitutions.length?'<div class="card-list" style="margin-top:14px">'+data.substitutions.map(s=>`<div class="card-row"><span><strong>${esc(s.side)}: ${esc(s.out_player_name)} → ${esc(s.in_player_name)}</strong><small>From round ${s.effective_round}</small></span></div>`).join('')+'</div>':''}
      </section>`:''}
    `;
    bindSheetControls();
    updateActionButtons();
    const uploadLabel=$('#scoreUpload')?.closest('label');
    if(uploadLabel)uploadLabel.classList.toggle('hidden',!state.user||f.status==='APPROVED');
    function fillSubs(){
      const s=$('#subSide')?.value;if(!s)return;
      const starters=s==='HOME'?currentHome:currentAway;
      $('#subOut').innerHTML=options(starters,'player_id',p=>p.first_name+' '+p.last_name,null,'Select player out');
      $('#subIn').innerHTML=options(reserveOptions(s),'id',p=>p.first_name+' '+p.last_name,null,'Select reserve');
    }
    $('#subSide')?.addEventListener('change',fillSubs); fillSubs();
  }
  function bindSheetControls(){
    $$('.save-lineup').forEach(btn=>btn.addEventListener('click',async()=>{
      const side=btn.dataset.side;
      const values=$$('.lineup-select[data-side="'+side+'"]').map(s=>Number(s.value)).filter(Boolean);
      try{
        $('#saveState').textContent='Saving…';
        state.fixture=await api('/api/fixtures/'+state.fixture.fixture.id+'/lineup',{method:'PUT',body:{side,playerIds:values}});
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
      $('#mySquad').innerHTML=squad.players.length?'<div class="card-list">'+squad.players.map(p=>`<div class="card-row"><span><strong>${esc(p.first_name+' '+p.last_name)}</strong><small>${esc(p.ncsf_number||'No NCSF number')}</small></span>${p.suspended?'<span class="pill FORFEIT">Suspended</span>':'<span class="pill APPROVED">Eligible</span>'}</div>`).join('')+'</div>':'<div class="empty">No players assigned to this team yet.</div>';
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
    $('#clubPlayers').innerHTML=state.meta.players.length?`<div class="table-wrap"><table><thead><tr><th>Player</th><th>NCSF #</th><th>Team</th><th>Status</th></tr></thead><tbody>${state.meta.players.map(p=>`<tr><td><strong>${esc(p.first_name+' '+p.last_name)}</strong></td><td>${esc(p.ncsf_number||'—')}</td><td><select class="player-team-change" data-player="${p.id}">${options(teams,'id',t=>t.name,p.team_id,'Unassigned')}</select></td><td>${p.suspended?'<span class="pill FORFEIT">Suspended</span>':'<span class="pill APPROVED">Eligible</span>'}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No players registered.</div>';
    $$('.player-team-change').forEach(sel=>sel.addEventListener('change',async()=>{
      try{await api('/api/admin/players/'+sel.dataset.player,{method:'PATCH',body:{teamId:sel.value||null}});toast('Player assignment updated');await reloadClub()}catch(err){toast(err.message,true)}
    }));
    $('#clubTeams').innerHTML=teams.length?'<div class="card-list">'+teams.map(t=>{
      const access=state.meta.users.filter(u=>u.team_id===t.id&&u.role==='TEAM_ADMIN');
      return `<div class="card-row"><span><strong>${esc(t.name)}</strong><small>${esc(t.division_name||'No division')} • ${state.meta.players.filter(p=>p.team_id===t.id).length} players</small></span><span>${access.length?access.map(u=>'<span class="pill">'+esc(u.display_name)+'</span>').join(' '):'<span class="muted">No team login</span>'}</span></div>`;
    }).join('')+'</div>':'<div class="empty">No teams assigned to this club.</div>';
  }
  async function initAdmin(){
    if(!requireUser(['NCSF_ADMIN']))return;
    $$('.admin-tabs button').forEach(btn=>btn.addEventListener('click',()=>{
      $$('.admin-tabs button').forEach(b=>b.classList.toggle('active',b===btn));
      $$('.admin-pane').forEach(p=>p.classList.toggle('hidden',p.dataset.pane!==btn.dataset.adminTab));
    }));
    await reloadAdmin();
    bindAdminForms();
  }
  async function reloadAdmin(){
    state.meta=await api('/api/admin/meta');
    const m=state.meta;
    $('#divisionSeason').innerHTML=options(m.seasons,'id',s=>s.name,null,'Select season');
    ['teamDivision','fixtureDivision','scheduleDivision'].forEach(id=>$('#'+id).innerHTML=options(m.divisions,'id',d=>d.season_name+' — '+d.name,null,'Select division'));
    ['teamClub','adminUserClub'].forEach(id=>$('#'+id).innerHTML=options(m.clubs,'id',c=>c.name,null,'Select club'));
    $('#adminUserTeam').innerHTML=options(m.teams,'id',t=>t.club_name+' — '+t.name,null,'Select team');
    renderAdminLists();
    syncFixtureTeams();
  }
  function renderAdminLists(){
    const m=state.meta;
    $('#adminClubList').innerHTML=m.clubs.length?'<div class="card-list">'+m.clubs.map(c=>`<div class="card-row"><span><strong>${esc(c.name)}</strong><small>${m.teams.filter(t=>t.club_id===c.id).map(t=>t.name).join(', ')||'No teams'}</small></span></div>`).join('')+'</div>':'<div class="empty">No clubs yet.</div>';
    api('/api/fixtures').then(d=>{$('#adminFixtures').innerHTML=fixtureCards(d.fixtures,true)}).catch(()=>{});
    $('#adminUsers').innerHTML=m.users.length?'<div class="card-list">'+m.users.map(u=>`<div class="card-row"><span><strong>${esc(u.display_name)}</strong><small>${esc(u.email)} • ${esc(u.role.replaceAll('_',' '))}</small></span><span class="muted">${esc(u.team_name||u.club_name||'NCSF')}</span></div>`).join('')+'</div>':'<div class="empty">No users.</div>';
  }
  function syncFixtureTeams(){
    const div=Number($('#fixtureDivision')?.value||0);
    const teams=state.meta.teams.filter(t=>!div||t.division_id===div);
    $('#fixtureHome').innerHTML=options(teams,'id',t=>t.name,null,'Home team');
    $('#fixtureAway').innerHTML=options(teams,'id',t=>t.name,null,'Away team');
  }
  function bindAdminForms(){
    $('#fixtureDivision')?.addEventListener('change',syncFixtureTeams);
    const simple=[
      ['seasonForm','/api/admin/seasons','Season created'],
      ['divisionForm','/api/admin/divisions','Division created'],
      ['clubForm','/api/admin/clubs','Club created'],
      ['teamForm','/api/admin/teams','Team created'],
      ['fixtureForm','/api/admin/fixtures','Fixture created'],
      ['adminUserForm','/api/admin/users','Login created']
    ];
    simple.forEach(([id,url,msg])=>$('#'+id)?.addEventListener('submit',async e=>{
      e.preventDefault();try{await api(url,{method:'POST',body:formObject(e.currentTarget)});e.currentTarget.reset();await reloadAdmin();toast(msg)}catch(err){toast(err.message,true)}
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
    if(PAGE==='scoresheet')await initScoresheet();
    if(PAGE==='team')await initTeam();
    if(PAGE==='club-admin')await initClubAdmin();
    if(PAGE==='admin')await initAdmin();
  }catch(err){toast(err.message,true);console.error(err)}
})();