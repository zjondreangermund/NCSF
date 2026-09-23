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
        <div class="open-cell">
          ${f.stream_active&&f.stream_url?`<a class="btn small live-btn" href="/live?id=${f.id}"><span class="live-dot"></span>LIVE</a>`:''}
          ${allowOpen && (f.status==='APPROVED' || Boolean(state.user))?`<a class="btn small secondary" href="/scoresheet?id=${f.id}">Open scoresheet</a>`:''}
        </div>
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
  function printablePlayerName(playerId){
    if(!playerId)return '—';
    const p=allMatchPlayers().find(x=>x.id===Number(playerId));
    return p?((p.first_name+' '+p.last_name).trim()):'—';
  }
  function compactPrintRoster(side){
    const roster=selectedRoster(side);
    const labels=side==='HOME'?['1','2','3','4','5','6','7']:['A','B','C','D','E','F','G'];
    return `<div class="print-roster">
      <div class="print-roster-title">${side==='HOME'?'HOME':'AWAY'} ROSTER</div>
      <div class="print-roster-grid">
        ${labels.map((label,i)=>{
          const p=roster[i];
          return `<div><b>${label}</b><span>${p?esc((p.first_name+' '+p.last_name).trim()):'—'}</span>${i===5?'<em>RESERVES</em>':''}</div>`;
        }).join('')}
      </div>
    </div>`;
  }
  function compactPrintRound(round){
    const frames=state.fixture.frames.filter(f=>f.round_no===round);
    const home=frames.filter(f=>f.winner_side==='HOME').length;
    const away=frames.filter(f=>f.winner_side==='AWAY').length;
    const letters=['A','B','C','D','E'];
    return `<section class="print-round">
      <div class="print-round-head"><strong>ROUND ${round}</strong><span>${home} - ${away}</span></div>
      <table>
        <thead><tr><th>#</th><th>Home</th><th>H</th><th>A</th><th>Away</th><th>#</th></tr></thead>
        <tbody>
          ${frames.map(fr=>`<tr>
            <td>${fr.home_slot}</td>
            <td>${esc(fr.home_player_name)}</td>
            <td class="print-score">${fr.winner_side==='HOME'?'1':'0'}</td>
            <td class="print-score">${fr.winner_side==='AWAY'?'1':'0'}</td>
            <td>${esc(fr.away_player_name)}</td>
            <td>${letters[(fr.away_slot||1)-1]}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </section>`;
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
    const playerNameById=id=>{
      const p=players.find(x=>Number(x.id)===Number(id));
      return p?((p.first_name+' '+p.last_name).trim()):'';
    };
    const autoPlayerIds=Array.isArray(f.playerOfMatchIds)?f.playerOfMatchIds:[f.playerOfMatchId].filter(Boolean);
    const autoPlayerNames=autoPlayerIds.map(playerNameById).filter(Boolean);
    const breakRunIds=new Set((Array.isArray(f.breakRunPlayerIds)?f.breakRunPlayerIds:[f.breakRunPlayerId]).filter(Boolean).map(Number));
    const awardsEditable=Boolean(state.user)&&f.status!=='APPROVED';
    const bonusText=f.bonusTeamName?(f.bonusTeamName+' • +1 bonus point'):'No bonus yet • requires 18+ frames';
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
      ${data.frames.length===25?'<div class="score-rounds-grid">'+[1,2,3,4,5].map(roundHtml).join('')+'</div>':'<div class="notice warn">Save both starting fives to generate the official 25-frame rotation.</div>'}
      <section class="final-score-card">
        <div><span>FINAL TOTAL</span><strong>${t.home}</strong></div>
        <div class="match-result"><span>MATCH RESULT</span><strong>${esc(matchResult)}</strong></div>
        <div><strong>${t.away}</strong><span>FINAL TOTAL</span></div>
      </section>
      <section class="match-extras-card">
        <form id="extrasForm">
          <div class="auto-award-field">
            <span>Player/s of Tournament <em>AUTO</em></span>
            <strong>${autoPlayerNames.length?esc(autoPlayerNames.join(', ')):'Appears automatically from frame wins'}</strong>
            ${f.playerOfMatchMaxWins?'<small>Highest individual frame wins: '+esc(f.playerOfMatchMaxWins)+'</small>':''}
          </div>

          <fieldset class="award-multi-field">
            <legend>Break & Run <small>Select every player who achieved it</small></legend>
            <div class="award-choice-list">
              ${players.map(p=>{
                const id=Number(p.id);
                const name=(p.first_name+' '+p.last_name).trim();
                return '<label class="award-choice"><input type="checkbox" name="breakRunPlayerIds" value="'+esc(id)+'" '+(breakRunIds.has(id)?'checked':'')+' '+(awardsEditable?'':'disabled')+'><span>'+esc(name)+(p.ncsf_number?'<small>'+esc(p.ncsf_number)+'</small>':'')+'</span></label>';
              }).join('')}
            </div>
          </fieldset>

          <label>Rack & Run<select name="rackRunPlayerId" ${awardsEditable?'':'disabled'}>${options(players,'id',p=>p.first_name+' '+p.last_name,f.rackRunPlayerId,'— Blank —')}</select></label>

          <div class="auto-award-field bonus">
            <span>Bonus Team <em>AUTO</em></span>
            <strong>${esc(bonusText)}</strong>
          </div>

          <label>Home Captain<select name="homeCaptainId" ${awardsEditable?'':'disabled'}>${options(homeRoster,'player_id',p=>(p.first_name+' '+p.last_name).trim(),f.homeCaptainId,'— Select captain —')}</select></label>
          <label>Away Captain<select name="awayCaptainId" ${awardsEditable?'':'disabled'}>${options(awayRoster,'player_id',p=>(p.first_name+' '+p.last_name).trim(),f.awayCaptainId,'— Select captain —')}</select></label>
          <label class="wide">Match Notes<textarea name="notes" rows="2" ${awardsEditable?'':'disabled'}>${esc(f.notes||'')}</textarea></label>
          ${awardsEditable?'<button class="btn primary wide" type="submit">Save Match Details</button>':''}
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
      <section class="compact-print-sheet print-only">
        <header class="print-head">
          <img src="/ncsf-logo.jpg" alt="NCSF">
          <div>
            <h1>NAMIBIA CUE SPORTS FEDERATION</h1>
            <h2>Blackball League Scoresheet</h2>
            <p>${esc(f.seasonName)} • ${esc(f.divisionName)} • Round ${esc(f.roundNo)}</p>
          </div>
          <div class="print-meta">
            <span><b>Date</b>${esc(dateText)}</span>
            <span><b>Time</b>${esc(timeText)}</span>
            <span><b>Venue</b>${esc(f.venue||'TBA')}</span>
          </div>
        </header>

        <div class="print-match">
          <div><small>HOME</small><strong>${esc(f.homeTeamName)}</strong></div>
          <div class="print-final"><b>${t.home}</b><span>FINAL</span><b>${t.away}</b></div>
          <div class="away"><small>AWAY</small><strong>${esc(f.awayTeamName)}</strong></div>
        </div>

        <div class="print-rounds">
          ${data.frames.length===25?[1,2,3,4,5].map(compactPrintRound).join(''):'<div class="print-no-frames">Lineups not complete.</div>'}
        </div>

        <div class="print-summary">
          <div><span>Match Result</span><strong>${esc(matchResult)}</strong></div>
          <div><span>Player of Match</span><strong>${esc(printablePlayerName(f.playerOfMatchId))}</strong></div>
          <div><span>Break & Run</span><strong>${esc(printablePlayerName(f.breakRunPlayerId))}</strong></div>
          <div><span>Rack & Run</span><strong>${esc(printablePlayerName(f.rackRunPlayerId))}</strong></div>
          <div><span>Bonus Point</span><strong>${esc(f.bonusPoints||0)}</strong></div>
          <div><span>Status</span><strong>${esc(f.status.replaceAll('_',' '))}</strong></div>
        </div>

        <div class="print-signatures">
          <div><span>HOME CAPTAIN: ${esc(homeCaptain?(homeCaptain.first_name+' '+homeCaptain.last_name).trim():'—')}</span><i></i><small>Signature</small></div>
          <div><span>AWAY CAPTAIN: ${esc(awayCaptain?(awayCaptain.first_name+' '+awayCaptain.last_name).trim():'—')}</span><i></i><small>Signature</small></div>
        </div>
      </section>

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
        const body=formObject(e.currentTarget);
        body.breakRunPlayerIds=$('input[name="breakRunPlayerIds"]:checked',e.currentTarget).map(cb=>Number(cb.value)).filter(Boolean);
        state.fixture=await api('/api/fixtures/'+state.fixture.fixture.id+'/extras',{method:'PATCH',body});
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
    const submit=$('#submitMatch'),confirm=$('#confirmMatch'),approve=$('#approveMatch'),broadcast=$('#broadcastMatch');
    const isParticipatingSide=side==='HOME'||side==='AWAY';
    const canSubmit=Boolean(u)&&isParticipatingSide&&['SCHEDULED','IN_PROGRESS'].includes(f.status);
    const canConfirm=Boolean(u)&&isParticipatingSide&&f.status==='SUBMITTED'&&Boolean(f.submittedSide)&&side!==f.submittedSide;
    const canApprove=Boolean(u)&&u.role==='NCSF_ADMIN'&&f.status==='CONFIRMED';
    const canBroadcast=Boolean(u)&&(u.role==='NCSF_ADMIN'||isParticipatingSide)&&f.status!=='APPROVED';
    if(submit)submit.classList.toggle('hidden',!canSubmit);
    if(confirm)confirm.classList.toggle('hidden',!canConfirm);
    if(approve)approve.classList.toggle('hidden',!canApprove);
    if(broadcast){
      broadcast.classList.toggle('hidden',!canBroadcast);
      if(canBroadcast)broadcast.href='/broadcast?id='+f.id;
    }
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

    const loadActive=async()=>{
      const box=$('#activeFixtures');
      if(!box)return;
      try{
        const d=await api('/api/fixtures?status='+encodeURIComponent('SCHEDULED,IN_PROGRESS'));
        const active=(d.fixtures||[])
          .filter(f=>Boolean(f.stream_active)||f.status==='IN_PROGRESS')
          .sort((x,y)=>{
            const liveDiff=Number(Boolean(y.stream_active))-Number(Boolean(x.stream_active));
            if(liveDiff)return liveDiff;
            const statusDiff=Number(y.status==='IN_PROGRESS')-Number(x.status==='IN_PROGRESS');
            if(statusDiff)return statusDiff;
            return new Date(x.fixture_date||0)-new Date(y.fixture_date||0);
          });
        box.innerHTML=active.length
          ? fixtureCards(active,true)
          : '<div class="empty">No matches are live or in progress right now.</div>';
      }catch(err){
        box.innerHTML='<div class="empty">Could not load current matches.</div>';
      }
    };

    const load=async()=>{
      const id=Number(select.value||0);
      if(!id){$('#publicFixtures').innerHTML='<div class="empty">No division configured yet.</div>';return}
      const status=$('#fixtureStatusFilter')?.value||'IN_PROGRESS,SCHEDULED,POSTPONED';
      try{
        const d=await api('/api/fixtures?divisionId='+id+'&status='+encodeURIComponent(status));
        const fixtures=(d.fixtures||[]).sort((x,y)=>{
          const liveDiff=Number(Boolean(y.stream_active))-Number(Boolean(x.stream_active));
          if(liveDiff)return liveDiff;
          const statusDiff=Number(y.status==='IN_PROGRESS')-Number(x.status==='IN_PROGRESS');
          if(statusDiff)return statusDiff;
          return new Date(x.fixture_date||0)-new Date(y.fixture_date||0);
        });
        $('#publicFixtures').innerHTML=fixtureCards(fixtures,true);
      }catch(err){toast(err.message,true)}
    };
    select.addEventListener('change',load);
    $('#fixtureStatusFilter')?.addEventListener('change',load);
    await Promise.all([loadActive(),load()]);
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
  function youtubeEmbedUrl(url){
    try{
      const u=new URL(url,location.origin);
      if(u.hostname.includes('youtu.be'))return 'https://www.youtube.com/embed/'+u.pathname.replace(/^\//,'');
      if(u.hostname.includes('youtube.com')){
        if(u.pathname.startsWith('/embed/'))return u.href;
        const id=u.searchParams.get('v');
        if(id)return 'https://www.youtube.com/embed/'+id;
        const parts=u.pathname.split('/').filter(Boolean);
        if(parts[0]==='live'&&parts[1])return 'https://www.youtube.com/embed/'+parts[1];
      }
    }catch(_e){}
    return null;
  }
  function renderLivePlayer(live){
    const box=$('#livePlayer');
    const title=$('#liveTitle');
    const meta=$('#liveMeta');
    if(title)title.textContent=live.title||'Live Match';
    if(meta)meta.textContent=(live.homeTeamName+' vs '+live.awayTeamName)+(live.venue?' • '+live.venue:'');
    if(!box)return;
    if(String(live.streamUrl||'').startsWith('internal://')){
      startInternalLiveViewer(live.fixtureId);
      return;
    }
    const yt=youtubeEmbedUrl(live.streamUrl);
    if(yt){
      box.innerHTML='<div class="video-frame"><iframe src="'+esc(yt)+'?autoplay=1" title="'+esc(live.title||'NCSF Live')+'" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>';
      return;
    }
    if(/\.(m3u8|mp4)(\?|#|$)/i.test(live.streamUrl)){
      box.innerHTML='<div class="video-frame"><video controls autoplay playsinline src="'+esc(live.streamUrl)+'"></video></div><p class="live-help">If this device cannot play the stream format, use Open Stream.</p><a class="btn secondary" target="_blank" rel="noopener" href="'+esc(live.streamUrl)+'">Open Stream</a>';
      return;
    }
    box.innerHTML='<div class="live-external"><p>This stream opens from its provider.</p><a class="btn primary" target="_blank" rel="noopener" href="'+esc(live.streamUrl)+'">Open Live Stream</a></div>';
  }

  function liveSocketUrl(params){
    const protocol=location.protocol==='https:'?'wss:':'ws:';
    return protocol+'//'+location.host+'/live-socket?'+new URLSearchParams(params).toString();
  }

  const LIVE_RTC_CONFIG={
    iceServers:[
      {urls:'stun:stun.l.google.com:19302'},
      {urls:'stun:stun1.l.google.com:19302'}
    ]
  };

  let ncsfFullscreenStage=null;
  let ncsfFullscreenChatHome=null;
  let ncsfFullscreenScrollY=0;

  function moveLiveChatForFullscreen(stage,active){
    const drawer=$('#liveChatDrawer');
    const host=$('#liveChatInlineHost');
    if(!drawer)return;

    if(active){
      if(!ncsfFullscreenChatHome){
        ncsfFullscreenChatHome={
          parent:drawer.parentNode,
          next:drawer.nextSibling
        };
      }
      stage?.appendChild(drawer);
      drawer.classList.add('fullscreen-chat');
      drawer.classList.remove('open');
      drawer.setAttribute('data-fullscreen-chat','true');
      drawer.dispatchEvent(new CustomEvent('ncsf-chat-mode',{detail:{fullscreen:true}}));
    }else{
      drawer.classList.remove('fullscreen-chat');
      drawer.removeAttribute('data-fullscreen-chat');
      const home=ncsfFullscreenChatHome;
      if(home?.parent){
        if(home.next&&home.next.parentNode===home.parent)home.parent.insertBefore(drawer,home.next);
        else home.parent.appendChild(drawer);
      }else if(host){
        host.appendChild(drawer);
      }
      ncsfFullscreenChatHome=null;
      drawer.classList.add('open');
      drawer.dispatchEvent(new CustomEvent('ncsf-chat-mode',{detail:{fullscreen:false}}));
    }
  }

  function liveControlIcon(kind){
    if(kind==='volume')return '<span class="live-volume-icon"><i></i><b></b></span>';
    if(kind==='muted')return '<span class="live-volume-icon muted"><i></i><b></b></span>';
    return '<span class="live-fullscreen-icon"><i></i><i></i><i></i><i></i></span>';
  }

  function enterNcsfLiveFullscreen(stage){
    if(!stage)return;
    ncsfFullscreenScrollY=window.scrollY||document.documentElement.scrollTop||0;
    ncsfFullscreenStage=stage;
    stage.classList.add('ncsf-live-fullscreen');
    document.documentElement.classList.add('ncsf-live-fullscreen-active');
    document.body.classList.add('ncsf-live-fullscreen-active');
    moveLiveChatForFullscreen(stage,true);
    window.dispatchEvent(new Event('resize'));
  }

  function exitNcsfLiveFullscreen(){
    const stage=ncsfFullscreenStage||$('.ncsf-live-fullscreen');
    stage?.classList.remove('ncsf-live-fullscreen','ncsf-chat-open');
    document.documentElement.classList.remove('ncsf-live-fullscreen-active');
    document.body.classList.remove('ncsf-live-fullscreen-active');
    moveLiveChatForFullscreen(stage,false);
    ncsfFullscreenStage=null;
    requestAnimationFrame(()=>window.scrollTo(0,ncsfFullscreenScrollY||0));
    setTimeout(()=>window.scrollTo(0,ncsfFullscreenScrollY||0),220);
    window.dispatchEvent(new Event('resize'));
  }

  window.exitNcsfLiveFullscreen=exitNcsfLiveFullscreen;
  window.__ncsfRestoreLivePage=()=>{
    if(!ncsfFullscreenStage){
      document.documentElement.classList.remove('ncsf-live-fullscreen-active');
      document.body.classList.remove('ncsf-live-fullscreen-active');
      document.documentElement.style.removeProperty('overflow');
      document.body.style.removeProperty('overflow');
      document.body.style.removeProperty('position');
    }
    window.dispatchEvent(new Event('resize'));
  };
  window.addEventListener('pageshow',()=>window.__ncsfRestoreLivePage?.());
  window.addEventListener('orientationchange',()=>{
    if(!ncsfFullscreenStage)setTimeout(()=>window.__ncsfRestoreLivePage?.(),160);
  });

  function ensureLiveScoreOverlay(stage){
    if(!stage)return null;
    let overlay=stage.querySelector('.live-match-overlay');
    if(overlay)return overlay;
    overlay=document.createElement('div');
    overlay.className='live-match-overlay';
    overlay.innerHTML=
      '<div class="live-scorebar">'+
        '<div class="live-score-team home"><span class="team-name">HOME</span><strong class="team-score">0</strong></div>'+
        '<div class="live-score-frame"><small>WAITING FOR LINEUPS</small><strong>Match not started</strong><span></span></div>'+
        '<div class="live-score-team away"><strong class="team-score">0</strong><span class="team-name">AWAY</span></div>'+
      '</div>'+
      '<div class="live-next-frame hidden"><span>NEXT</span><strong></strong></div>'+
      '<div class="live-round-summary hidden">'+
        '<div class="round-line"></div>'+
        '<small>ROUND COMPLETE</small>'+
        '<strong class="round-result"></strong>'+
        '<span class="round-progressive"></span>'+
        '<div class="round-line"></div>'+
      '</div>';
    stage.appendChild(overlay);
    return overlay;
  }

  function renderLiveMatchState(stage,match){
    if(!stage||!match)return;
    const overlay=ensureLiveScoreOverlay(stage);
    const homeName=overlay.querySelector('.live-score-team.home .team-name');
    const awayName=overlay.querySelector('.live-score-team.away .team-name');
    const homeScore=overlay.querySelector('.live-score-team.home .team-score');
    const awayScore=overlay.querySelector('.live-score-team.away .team-score');
    const frame=overlay.querySelector('.live-score-frame');
    const nextBox=overlay.querySelector('.live-next-frame');
    const roundBox=overlay.querySelector('.live-round-summary');

    homeName.textContent=match.homeTeamName||'HOME';
    awayName.textContent=match.awayTeamName||'AWAY';
    homeScore.textContent=String(match.homeScore||0);
    awayScore.textContent=String(match.awayScore||0);

    const previousCompleted=stage.dataset.liveCompleted===''||stage.dataset.liveCompleted===undefined
      ? null
      : Number(stage.dataset.liveCompleted);
    stage.dataset.liveCompleted=String(match.completed||0);

    if(!match.lineupsReady){
      frame.innerHTML='<small>WAITING FOR LINEUPS</small><strong>Teams still selecting players</strong><span>Live pairings will appear automatically</span>';
      nextBox.classList.add('hidden');
      overlay.classList.remove('is-final');
      return;
    }

    if(match.final){
      const result=Number(match.homeScore)>Number(match.awayScore)
        ? (match.homeTeamName+' WIN')
        : Number(match.awayScore)>Number(match.homeScore)
          ? (match.awayTeamName+' WIN')
          : 'DRAW';
      frame.innerHTML='<small>FINAL • 25/25 FRAMES</small><strong>'+esc(result)+'</strong><span>Official scoresheet result</span>';
      nextBox.classList.add('hidden');
      overlay.classList.add('is-final');
    }else{
      overlay.classList.remove('is-final');
      const current=match.current;
      if(current){
        frame.innerHTML=
          '<small>ROUND '+esc(current.roundNo)+' • FRAME '+esc(current.boardNo)+' • '+esc(match.completed+1)+'/25</small>'+
          '<strong>'+esc(current.homePlayerName)+' <b>vs</b> '+esc(current.awayPlayerName)+'</strong>'+
          '<span>Current frame</span>';
      }

      if(match.next){
        nextBox.querySelector('strong').textContent=match.next.homePlayerName+' vs '+match.next.awayPlayerName;
        nextBox.classList.remove('hidden');
      }else{
        nextBox.classList.add('hidden');
      }
    }

    if(
      roundBox &&
      previousCompleted!==null &&
      Number(match.completed)>previousCompleted &&
      Number(match.completed)%5===0 &&
      match.roundSummary
    ){
      clearTimeout(stage.__roundSummaryTimer);
      const r=match.roundSummary;
      roundBox.querySelector('small').textContent='ROUND '+r.roundNo+' COMPLETE';
      roundBox.querySelector('.round-result').textContent=
        match.homeTeamName+' '+r.home+' — '+r.away+' '+match.awayTeamName;
      roundBox.querySelector('.round-progressive').textContent=
        'Progressive Total  '+r.progressiveHome+' — '+r.progressiveAway;
      overlay.classList.add('round-summary-active');
      roundBox.classList.remove('hidden');
      requestAnimationFrame(()=>roundBox.classList.add('show'));
      stage.__roundSummaryTimer=setTimeout(()=>{
        roundBox.classList.remove('show');
        overlay.classList.remove('round-summary-active');
        setTimeout(()=>roundBox.classList.add('hidden'),350);
      },5000);
    }
  }

  function installLiveVideoControls(video,stage,{allowAudio=true}={}){
    if(!video||!stage||stage.querySelector('.ncsf-live-controls'))return;
    video.controls=false;
    const controls=document.createElement('div');
    controls.className='ncsf-live-controls';
    controls.innerHTML=
      '<div class="ncsf-live-controls-left">'+
        '<span class="ncsf-live-word"><i></i>LIVE</span>'+
        (allowAudio?'<button class="ncsf-video-control ncsf-mute-control" type="button" aria-label="Unmute">'+liveControlIcon(video.muted?'muted':'volume')+'</button><span class="ncsf-sound-hint">Tap for sound</span>':'')+
      '</div>'+
      '<button class="ncsf-video-control ncsf-fullscreen-control" type="button" aria-label="Landscape view">'+liveControlIcon('fullscreen')+'<span class="ncsf-landscape-label">Landscape</span></button>';
    stage.appendChild(controls);

    const mute=controls.querySelector('.ncsf-mute-control');
    const soundHint=controls.querySelector('.ncsf-sound-hint');
    mute?.addEventListener('click',e=>{
      e.stopPropagation();
      video.muted=!video.muted;
      mute.setAttribute('aria-label',video.muted?'Unmute':'Mute');
      mute.innerHTML=liveControlIcon(video.muted?'muted':'volume');
      soundHint?.classList.toggle('hidden',!video.muted);
      if(!video.muted)video.play().catch(()=>{});
    });

    const landscapeBtn=controls.querySelector('.ncsf-fullscreen-control');
    landscapeBtn?.addEventListener('click',e=>{
      e.stopPropagation();
      if(stage.classList.contains('ncsf-live-fullscreen'))exitNcsfLiveFullscreen();
      else enterNcsfLiveFullscreen(stage);
      const active=stage.classList.contains('ncsf-live-fullscreen');
      landscapeBtn.setAttribute('aria-label',active?'Exit landscape view':'Landscape view');
      const label=landscapeBtn.querySelector('.ncsf-landscape-label');
      if(label)label.textContent=active?'Exit':'Landscape';
    });

    video.addEventListener('click',()=>video.play().catch(()=>{}));
  }

  function startInternalLiveViewer(fixtureId){
    const box=$('#livePlayer');
    if(!box)return;
    if(!window.RTCPeerConnection){
      box.innerHTML='<div class="empty">Live playback is not supported on this device.</div>';
      return;
    }

    box.innerHTML='<div class="video-frame internal-live" id="internalLiveFrame"><video id="internalLiveVideo" muted autoplay playsinline></video><div class="live-waiting" id="liveWaiting">Connecting to live camera…</div></div>';
    const frame=$('#internalLiveFrame');
    const video=$('#internalLiveVideo');
    const waiting=$('#liveWaiting');
    installLiveVideoControls(video,frame,{allowAudio:true});
    ensureLiveScoreOverlay(frame);
    let socket=null,pc=null,retryTimer=null,offerTimer=null,ended=false,pendingIce=[];

    const closePeer=()=>{
      try{pc?.close()}catch(_e){}
      pc=null;
      pendingIce=[];
      if(video.srcObject){
        try{video.srcObject.getTracks().forEach(t=>t.stop())}catch(_e){}
        video.srcObject=null;
      }
    };

    const connect=()=>{
      if(ended)return;
      closePeer();
      socket=new WebSocket(liveSocketUrl({
        fixtureId:String(fixtureId),
        mode:'viewer',
        viewerName:state.user?.displayName||'Guest viewer'
      }));

      socket.onopen=()=>{
        waiting.textContent='Connected. Waiting for camera…';
      };

      socket.onmessage=async e=>{
        if(typeof e.data!=='string')return;
        let msg;try{msg=JSON.parse(e.data)}catch{return}

        if(msg.type==='match-state'&&msg.match){
          renderLiveMatchState(frame,msg.match);
          return;
        }

        if(msg.type==='viewer-ready'){
          waiting.textContent='Waiting for live video…';
          clearTimeout(offerTimer);
          offerTimer=setTimeout(()=>{
            if(!pc&&!ended&&socket?.readyState===WebSocket.OPEN){
              waiting.textContent='Refreshing live connection…';
              socket.close();
            }
          },5000);
          return;
        }

        if(msg.type==='webrtc-offer'&&msg.sdp){
          clearTimeout(offerTimer);
          try{
            closePeer();
            pc=new RTCPeerConnection(LIVE_RTC_CONFIG);

            pc.ontrack=event=>{
              const remote=event.streams&&event.streams[0];
              if(remote){
                video.srcObject=remote;
                video.play().catch(()=>{});
                waiting.textContent='LIVE';
                waiting.classList.add('is-live');
              }
            };

            pc.onicecandidate=event=>{
              if(event.candidate&&socket?.readyState===WebSocket.OPEN){
                socket.send(JSON.stringify({type:'webrtc-ice',candidate:event.candidate}));
              }
            };

            pc.onconnectionstatechange=()=>{
              if(!pc)return;
              if(pc.connectionState==='connected'){
                waiting.textContent='LIVE';
                waiting.classList.add('is-live');
              }else if(['failed','disconnected'].includes(pc.connectionState)){
                waiting.textContent='Reconnecting live video…';
                waiting.classList.remove('is-live');
              }
            };

            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            for(const candidate of pendingIce.splice(0)){
              try{await pc.addIceCandidate(candidate)}catch(_e){}
            }
            const answer=await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.send(JSON.stringify({type:'webrtc-answer',sdp:pc.localDescription}));
          }catch(err){
            console.error('Live viewer WebRTC error',err);
            waiting.textContent='Unable to start live video. Retrying…';
          }
          return;
        }

        if(msg.type==='webrtc-ice'&&msg.candidate){
          const candidate=new RTCIceCandidate(msg.candidate);
          if(pc?.remoteDescription){
            try{await pc.addIceCandidate(candidate)}catch(_e){}
          }else{
            pendingIce.push(candidate);
          }
          return;
        }

        if(msg.type==='ended'){
          ended=true;
          closePeer();
          waiting.textContent='Live broadcast ended';
          waiting.classList.remove('is-live');
        }else if(msg.type==='reconnecting'){
          waiting.textContent='Live camera reconnecting…';
          waiting.classList.remove('is-live');
          closePeer();
        }else if(msg.type==='waiting'){
          waiting.textContent='Camera connected. Starting video…';
        }else if(msg.type==='offline'){
          waiting.textContent='This fixture is not live.';
        }
      };

      socket.onclose=()=>{
        clearTimeout(offerTimer);
        closePeer();
        if(!ended){
          waiting.textContent='Reconnecting to live stream…';
          waiting.classList.remove('is-live');
          clearTimeout(retryTimer);
          retryTimer=setTimeout(connect,1800);
        }
      };
    };

    connect();
  }

  function supportedBroadcastMime(withAudio=true){
    const types=withAudio
      ? ['video/webm;codecs=vp8,opus','video/webm;codecs=vp9,opus','video/webm']
      : ['video/webm;codecs=vp8','video/webm;codecs=vp9','video/webm'];
    return types.find(t=>window.MediaRecorder&&MediaRecorder.isTypeSupported(t))||'';
  }

  async function initBroadcastPage(){
    if(!requireUser())return;
    const id=Number(new URLSearchParams(location.search).get('id')||0);
    if(!id){$('#broadcastMeta').textContent='No fixture selected.';return}

    let fixture;
    try{
      const data=await api('/api/fixtures/'+id);
      fixture=data.fixture;
    }catch(err){
      $('#broadcastMeta').textContent=err.message;
      return;
    }

    $('#broadcastTitle').textContent=fixture.homeTeamName+' vs '+fixture.awayTeamName;
    $('#broadcastMeta').textContent=(fixture.divisionName||'')+(fixture.venue?' • '+fixture.venue:'');
    const preview=$('#broadcastPreview'),viewerPreview=$('#broadcastViewerPreview');
    const startBtn=$('#startBroadcast'),stopBtn=$('#stopBroadcast'),switchBtn=$('#switchCamera');
    const micBtn=$('#broadcastMic'),permissionBtn=$('#broadcastPermissions'),viewerPreviewBtn=$('#viewerPreviewBtn');
    const stage=$('#broadcastStage'),stateLabel=$('#broadcastState'),viewerLabel=$('#broadcastViewers');
    const viewerList=$('#broadcastViewerList');
    let facing='environment',stream=null,socket=null,starting=false,withAudio=true,chatStarted=false,viewerPreviewOn=false;
    let manualStop=false,reconnectTimer=null,reconnectAttempt=0,connectingPublisher=false;
    const peers=new Map();
    const pendingIce=new Map();
    const viewerNames=new Map();
    let mediaPermissionResolver=null;

    window.onNcsfMediaPermissionResult=(cameraGranted,audioGranted)=>{
      if(mediaPermissionResolver){
        const resolve=mediaPermissionResolver;
        mediaPermissionResolver=null;
        resolve({cameraGranted:Boolean(cameraGranted),audioGranted:Boolean(audioGranted)});
      }
      if(permissionBtn)permissionBtn.classList.toggle('hidden',Boolean(cameraGranted));
    };

    const requestNativeMediaPermissions=async()=>{
      if(!(window.NCSFApp&&typeof window.NCSFApp.requestBroadcastPermissions==='function')){
        return {cameraGranted:true,audioGranted:true};
      }
      return await new Promise(resolve=>{
        let finished=false;
        const finish=result=>{
          if(finished)return;
          finished=true;
          clearTimeout(timeout);
          mediaPermissionResolver=null;
          resolve(result);
        };
        const timeout=setTimeout(()=>{
          finish({
            cameraGranted:typeof window.NCSFApp.hasCameraPermission==='function'?Boolean(window.NCSFApp.hasCameraPermission()):false,
            audioGranted:typeof window.NCSFApp.hasMicrophonePermission==='function'?Boolean(window.NCSFApp.hasMicrophonePermission()):false
          });
        },12000);
        mediaPermissionResolver=finish;
        try{window.NCSFApp.requestBroadcastPermissions()}
        catch(_e){finish({cameraGranted:false,audioGranted:false})}
      });
    };

    const showPermissionRecovery=()=>{
      permissionBtn?.classList.remove('hidden');
      if(permissionBtn)permissionBtn.textContent='Allow Camera & Mic';
    };

    permissionBtn?.addEventListener('click',()=>{
      try{
        if(window.NCSFApp&&typeof window.NCSFApp.openAppPermissionSettings==='function'){
          window.NCSFApp.openAppPermissionSettings();
          toast('Opening NCSF phone permissions…');
        }else{
          toast('Open Phone Settings > Apps > NCSF > Permissions and allow Camera and Microphone.',true);
        }
      }catch(_e){
        toast('Open Phone Settings > Apps > NCSF > Permissions and allow Camera and Microphone.',true);
      }
    });

    const renderViewerList=()=>{
      if(!viewerList)return;
      const names=[...viewerNames.values()];
      viewerList.innerHTML=names.length
        ? '<strong>Watching now</strong>'+names.map(name=>'<span>'+esc(name)+'</span>').join('')
        : '<span>No viewers yet</span>';
    };

    viewerLabel?.addEventListener('click',()=>viewerList?.classList.toggle('hidden'));
    document.addEventListener('click',e=>{
      if(viewerList&&!viewerList.classList.contains('hidden')&&!viewerList.contains(e.target)&&e.target!==viewerLabel){
        viewerList.classList.add('hidden');
      }
    });

    const toggleViewerPreview=()=>{
      viewerPreviewOn=!viewerPreviewOn;
      viewerPreview?.classList.toggle('hidden',!viewerPreviewOn);
      preview?.classList.toggle('broadcast-camera-dimmed',viewerPreviewOn);
      if(viewerPreview){
        viewerPreview.srcObject=viewerPreviewOn?stream:null;
        if(viewerPreviewOn)viewerPreview.play().catch(()=>{});
      }
      if(viewerPreviewBtn)viewerPreviewBtn.textContent=viewerPreviewOn?'Camera View':'Viewer View';
    };

    viewerPreviewBtn?.addEventListener('click',toggleViewerPreview);
    installLiveVideoControls(preview,stage,{allowAudio:false});
    ensureLiveScoreOverlay(stage);

    const updateMicButton=()=>{
      if(!micBtn)return;
      const track=stream?.getAudioTracks?.()[0]||null;
      if(!track){
        micBtn.textContent='Mic: Add';
        micBtn.classList.remove('success');
        return;
      }
      micBtn.textContent=track.enabled?'Mic: On':'Mic: Off';
      micBtn.classList.toggle('success',track.enabled);
    };

    const addMicrophone=async()=>{
      if(!stream)throw new Error('Start the live stream first.');
      const existing=stream.getAudioTracks()[0];
      if(existing){
        existing.enabled=true;
        withAudio=true;
        updateMicButton();
        return;
      }
      const audioStream=await navigator.mediaDevices.getUserMedia({
        video:false,
        audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}
      });
      const track=audioStream.getAudioTracks()[0];
      if(!track)throw new Error('No microphone source was found.');
      stream.addTrack(track);
      withAudio=true;
      updateMicButton();
      setUi(true);
      for(const viewerId of [...viewerNames.keys()]){
        await createPeerForViewer(viewerId);
      }
    };

    micBtn?.addEventListener('click',async()=>{
      if(!stream){toast('Start Live first',true);return}
      const track=stream.getAudioTracks()[0];
      if(!track){
        try{
          micBtn.disabled=true;
          await addMicrophone();
          toast('Microphone added to the live stream');
        }catch(err){
          toast(err.message||'Could not start microphone.',true);
        }finally{
          micBtn.disabled=false;
        }
        return;
      }
      track.enabled=!track.enabled;
      withAudio=track.enabled;
      updateMicButton();
      setUi(true);
      toast(track.enabled?'Microphone on':'Microphone muted');
    });

    const closePeer=viewerId=>{
      const pc=peers.get(viewerId);
      if(pc){try{pc.close()}catch(_e){}}
      peers.delete(viewerId);
      pendingIce.delete(viewerId);
    };

    const closeAllPeers=()=>{
      for(const viewerId of [...peers.keys()])closePeer(viewerId);
    };

    const setBroadcastAwake=async active=>{
      try{
        if(window.NCSFApp&&typeof window.NCSFApp.setBroadcastActive==='function'){
          window.NCSFApp.setBroadcastActive(Boolean(active));
        }
        if(window.NCSFApp){
          if(typeof window.NCSFApp.setBroadcastLandscape==='function'){
            window.NCSFApp.setBroadcastLandscape(Boolean(active));
          }else{
            if(active&&typeof window.NCSFApp.enterLiveFullscreen==='function')window.NCSFApp.enterLiveFullscreen();
            if(!active&&typeof window.NCSFApp.exitLiveFullscreen==='function')window.NCSFApp.exitLiveFullscreen();
          }
        }else if(active&&screen.orientation?.lock){
          await screen.orientation.lock('landscape').catch(()=>{});
        }
      }catch(_e){}
      try{
        if(active&&navigator.wakeLock?.request){
          window.__ncsfWakeLock=await navigator.wakeLock.request('screen');
        }else if(!active&&window.__ncsfWakeLock){
          await window.__ncsfWakeLock.release().catch(()=>{});
          window.__ncsfWakeLock=null;
        }
      }catch(_e){}
    };

    const setUi=live=>{
      startBtn.classList.toggle('hidden',live);
      stopBtn.classList.toggle('hidden',!live);
      stateLabel.textContent=live?(withAudio?'LIVE':'LIVE • VIDEO ONLY'):'OFFLINE';
      stateLabel.classList.toggle('is-live',live);
    };

    const stopTracks=()=>{
      if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}
      preview.srcObject=null;
    };

    const stop=()=>{
      manualStop=true;
      clearTimeout(reconnectTimer);
      reconnectTimer=null;
      closeAllPeers();
      const oldSocket=socket;
      socket=null;
      try{
        if(oldSocket&&oldSocket.readyState===WebSocket.OPEN){
          oldSocket.send(JSON.stringify({type:'publisher-stop'}));
        }
        if(oldSocket&&oldSocket.readyState<=1)oldSocket.close();
      }catch(_e){}
      stopTracks();
      setBroadcastAwake(false);
      setUi(false);
      viewerNames.clear();
      renderViewerList();
      if(viewerLabel)viewerLabel.textContent='0 viewers';
      if(viewerPreviewOn)toggleViewerPreview();
      updateMicButton();
    };

    const createPeerForViewer=async viewerId=>{
      if(!stream||!socket||socket.readyState!==WebSocket.OPEN)return;
      closePeer(viewerId);
      try{
        const pc=new RTCPeerConnection(LIVE_RTC_CONFIG);
        peers.set(viewerId,pc);
        pendingIce.set(viewerId,[]);

        stream.getTracks().forEach(track=>pc.addTrack(track,stream));

        pc.onicecandidate=event=>{
          if(event.candidate&&socket?.readyState===WebSocket.OPEN){
            socket.send(JSON.stringify({type:'webrtc-ice',viewerId,candidate:event.candidate}));
          }
        };

        pc.onconnectionstatechange=()=>{
          if(['failed','closed'].includes(pc.connectionState))closePeer(viewerId);
        };

        const offer=await pc.createOffer({offerToReceiveAudio:false,offerToReceiveVideo:false});
        await pc.setLocalDescription(offer);
        socket.send(JSON.stringify({type:'webrtc-offer',viewerId,sdp:pc.localDescription}));
      }catch(err){
        console.error('Broadcaster WebRTC error',err);
        closePeer(viewerId);
      }
    };

    const handlePublisherMessage=async e=>{
      if(typeof e.data!=='string')return;
      let msg;try{msg=JSON.parse(e.data)}catch{return}

      if(msg.type==='match-state'&&msg.match){
        renderLiveMatchState(stage,msg.match);
      }else if(msg.type==='viewerCount'){
        if(viewerLabel)viewerLabel.textContent=msg.count+' viewer'+(msg.count===1?'':'s');
        if(Array.isArray(msg.viewers)){
          viewerNames.clear();
          msg.viewers.forEach(v=>viewerNames.set(String(v.id),v.name||'Viewer'));
          renderViewerList();
        }
      }else if(msg.type==='viewer-joined'&&msg.viewerId){
        viewerNames.set(String(msg.viewerId),msg.viewerName||'Viewer');
        renderViewerList();
        await createPeerForViewer(msg.viewerId);
      }else if(msg.type==='viewer-left'&&msg.viewerId){
        viewerNames.delete(String(msg.viewerId));
        renderViewerList();
        closePeer(msg.viewerId);
      }else if(msg.type==='webrtc-answer'&&msg.viewerId&&msg.sdp){
        const pc=peers.get(msg.viewerId);
        if(pc){
          try{
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            const queued=pendingIce.get(msg.viewerId)||[];
            pendingIce.set(msg.viewerId,[]);
            for(const candidate of queued){
              try{await pc.addIceCandidate(candidate)}catch(_e){}
            }
          }catch(err){console.error('Answer error',err)}
        }
      }else if(msg.type==='webrtc-ice'&&msg.viewerId&&msg.candidate){
        const pc=peers.get(msg.viewerId);
        if(pc?.remoteDescription){
          try{await pc.addIceCandidate(new RTCIceCandidate(msg.candidate))}catch(_e){}
        }else{
          const queue=pendingIce.get(msg.viewerId)||[];
          queue.push(new RTCIceCandidate(msg.candidate));
          pendingIce.set(msg.viewerId,queue);
        }
      }
    };

    const schedulePublisherReconnect=()=>{
      if(manualStop||!stream||reconnectTimer)return;
      closeAllPeers();
      const delay=Math.min(10000,1000*Math.pow(2,Math.min(reconnectAttempt,3)));
      reconnectAttempt++;
      stateLabel.textContent='RECONNECTING…';
      stateLabel.classList.add('is-live');
      reconnectTimer=setTimeout(()=>{
        reconnectTimer=null;
        connectPublisher().catch(()=>{});
      },delay);
    };

    const connectPublisher=async()=>{
      if(manualStop||!stream||connectingPublisher)return false;
      connectingPublisher=true;
      let ws=null;
      try{
        const tokenData=await api('/api/fixtures/'+id+'/broadcast-token',{method:'POST'});
        ws=new WebSocket(liveSocketUrl({fixtureId:String(id),mode:'publisher',token:tokenData.token}));
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(new Error('Live server connection timed out.')),10000);
          ws.onopen=()=>{clearTimeout(timer);resolve()};
          ws.onerror=()=>{clearTimeout(timer);reject(new Error('Could not connect to the NCSF live server.'))};
        });

        if(manualStop||!stream){
          try{ws.close()}catch(_e){}
          return false;
        }

        socket=ws;
        reconnectAttempt=0;
        ws.onmessage=handlePublisherMessage;
        ws.onclose=e=>{
          if(socket===ws)socket=null;
          if(manualStop||!stream)return;
          schedulePublisherReconnect();
        };
        ws.onerror=()=>{};
        setUi(true);
        return true;
      }catch(err){
        if(ws){try{ws.close()}catch(_e){}}
        if(!manualStop&&stream)schedulePublisherReconnect();
        return false;
      }finally{
        connectingPublisher=false;
      }
    };

    const start=async()=>{
      if(starting||stream)return;
      starting=true;
      manualStop=false;
      clearTimeout(reconnectTimer);
      reconnectTimer=null;
      startBtn.disabled=true;

      try{
        if(!navigator.mediaDevices?.getUserMedia||!window.RTCPeerConnection){
          throw new Error('Live camera streaming is not supported on this device.');
        }

        if(window.NCSFApp&&typeof window.NCSFApp.hasCameraPermission==='function'&&!window.NCSFApp.hasCameraPermission()){
          const permissionResult=await requestNativeMediaPermissions();
          if(!permissionResult.cameraGranted){
            showPermissionRecovery();
            try{window.NCSFApp?.openAppPermissionSettings?.()}catch(_e){}
            throw new Error('Camera permission denied. Allow Camera and Microphone in the NCSF phone permissions screen.');
          }
        }

        await setBroadcastAwake(true);
        await new Promise(resolve=>setTimeout(resolve,350));

        const videoConstraints={
          facingMode:{ideal:facing},
          width:{ideal:1920},
          height:{ideal:1080},
          aspectRatio:{ideal:16/9},
          frameRate:{ideal:30,max:30}
        };

        stream=await navigator.mediaDevices.getUserMedia({video:videoConstraints,audio:false});
        withAudio=false;
        try{
          const audioStream=await navigator.mediaDevices.getUserMedia({
            video:false,
            audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}
          });
          const audioTrack=audioStream.getAudioTracks()[0];
          if(audioTrack){
            stream.addTrack(audioTrack);
            withAudio=true;
          }
        }catch(audioErr){
          withAudio=false;
          toast('Microphone unavailable — live video will continue. Tap Mic: Add to retry.');
        }
        updateMicButton();

        preview.srcObject=stream;
        await preview.play().catch(()=>{});
        stateLabel.textContent=withAudio?'CONNECTING':'CONNECTING • VIDEO ONLY';

        manualStop=false;
        reconnectAttempt=0;
        const connected=await connectPublisher();
        if(!connected){
          stateLabel.textContent='RECONNECTING…';
          stateLabel.classList.add('is-live');
        }
        if(!chatStarted){
          initLiveChat(id);
          chatStarted=true;
        }
        if(viewerPreviewOn&&viewerPreview){
          viewerPreview.srcObject=stream;
          viewerPreview.play().catch(()=>{});
        }
        toast(withAudio?'You are live':'You are live — video only');
      }catch(err){
        const name=String(err?.name||'');
        const msg=String(err?.message||'');
        const denied=name==='NotAllowedError'||/permission|denied|not allowed/i.test(msg);
        if(denied){
          showPermissionRecovery();
          try{window.NCSFApp?.openAppPermissionSettings?.()}catch(_e){}
        }
        stop();
        toast(denied?'Camera permission denied. Enable Camera and Microphone in NCSF phone permissions.':(msg||'Could not start live stream.'),true);
      }finally{
        starting=false;
        startBtn.disabled=false;
      }
    };

    startBtn.addEventListener('click',start);
    stopBtn.addEventListener('click',()=>{stop();toast('Live broadcast stopped')});
    switchBtn.addEventListener('click',async()=>{
      facing=facing==='environment'?'user':'environment';
      if(stream){
        const wasChatStarted=chatStarted;
        stop();
        chatStarted=wasChatStarted;
        await start();
      }else{
        toast('Camera set to '+(facing==='environment'?'rear':'front'));
      }
    });
    window.addEventListener('beforeunload',stop);
    setUi(false);
    updateMicButton();
    try{
      if(window.NCSFApp&&typeof window.NCSFApp.hasCameraPermission==='function'){
        permissionBtn?.classList.toggle('hidden',Boolean(window.NCSFApp.hasCameraPermission()));
      }
    }catch(_e){}
  }

  function formatChatTime(value){
    try{
      return new Date(value).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    }catch(_e){return ''}
  }

  function liveChatRoleLabel(role){
    if(role==='NCSF_ADMIN')return 'NCSF';
    if(role==='CLUB_ADMIN')return 'Club';
    if(role==='TEAM_ADMIN')return 'Team';
    return '';
  }

  function initLiveChat(fixtureId){
    const drawer=$('#liveChatDrawer'),handle=$('#liveChatHandle'),closeBtn=$('#liveChatClose');
    const messages=$('#liveChatMessages'),form=$('#liveChatForm'),input=$('#liveChatInput');
    const signIn=$('#liveChatSignin'),badge=$('#liveChatBadge');
    if(!drawer||!handle||!messages)return;

    let open=false,unread=0,socket=null,retryTimer=null,chatOffline=false;
    const seen=new Set();

    const setOpen=value=>{
      const fullscreen=drawer.classList.contains('fullscreen-chat');
      open=fullscreen?Boolean(value):true;
      drawer.classList.toggle('open',open);
      const stage=drawer.closest('.ncsf-live-fullscreen');
      stage?.classList.toggle('ncsf-chat-open',fullscreen&&open);
      handle.setAttribute('aria-expanded',open?'true':'false');
      const chevron=$('.live-chat-chevron',handle);
      if(chevron)chevron.textContent=open?'⌄':'⌃';
      if(open){
        unread=0;
        badge?.classList.add('hidden');
        if(badge)badge.textContent='0';
        requestAnimationFrame(()=>{messages.scrollTop=messages.scrollHeight});
      }
    };

    const updateUnread=()=>{
      if(open)return;
      unread++;
      if(badge){
        badge.textContent=String(Math.min(unread,99));
        badge.classList.remove('hidden');
      }
    };

    const renderMessage=msg=>{
      const id=String(msg.id||'');
      if(id&&seen.has(id))return;
      if(id)seen.add(id);
      const mine=Boolean(state.user&&Number(msg.user_id)===Number(state.user.id));
      const role=liveChatRoleLabel(msg.role);
      const row=document.createElement('div');
      row.className='live-chat-message'+(mine?' mine':'');
      row.dataset.messageId=id;
      row.innerHTML='<div class="live-chat-message-meta"><strong>'+esc(msg.display_name||'Viewer')+'</strong>'+
        (role?'<span>'+esc(role)+'</span>':'')+'<time>'+esc(formatChatTime(msg.created_at))+'</time></div>'+
        '<div class="live-chat-message-text">'+esc(msg.message||'')+'</div>';
      messages.appendChild(row);
      messages.scrollTop=messages.scrollHeight;
    };

    const loadHistory=async()=>{
      try{
        const data=await api('/api/live/'+fixtureId+'/chat');
        messages.innerHTML='';
        (data.messages||[]).forEach(renderMessage);
        if(!(data.messages||[]).length)messages.innerHTML='<div class="live-chat-empty">No messages yet. Start the match chat.</div>';
        messages.scrollTop=messages.scrollHeight;
      }catch(err){
        messages.innerHTML='<div class="live-chat-empty">'+esc(err.message)+'</div>';
      }
    };

    const connectChat=()=>{
      if(chatOffline)return;
      clearTimeout(retryTimer);
      socket=new WebSocket(liveSocketUrl({fixtureId:String(fixtureId),mode:'chat'}));
      socket.onmessage=e=>{
        if(typeof e.data!=='string')return;
        let msg;try{msg=JSON.parse(e.data)}catch{return}
        if(msg.type==='chat-message'&&msg.message){
          const empty=$('.live-chat-empty',messages);
          if(empty)empty.remove();
          renderMessage(msg.message);
          updateUnread();
        }else if(msg.type==='chat-offline'){
          chatOffline=false;
          retryTimer=setTimeout(connectChat,1800);
        }
      };
      socket.onclose=()=>{
        if(!chatOffline){
          clearTimeout(retryTimer);
          retryTimer=setTimeout(connectChat,1800);
        }
      };
    };

    handle.addEventListener('click',()=>setOpen(!open));
    closeBtn?.addEventListener('click',()=>setOpen(false));
    drawer.addEventListener('ncsf-chat-mode',e=>{
      const fullscreen=Boolean(e.detail?.fullscreen);
      setOpen(fullscreen?false:true);
      requestAnimationFrame(()=>{messages.scrollTop=messages.scrollHeight});
    });

    let gestureStartX=0,gestureStartY=0,gestureActive=false;
    const beginGesture=e=>{
      if(e.target.closest('input,button,a'))return;
      gestureActive=true;
      gestureStartX=e.clientX;
      gestureStartY=e.clientY;
    };
    const endGesture=e=>{
      if(!gestureActive)return;
      gestureActive=false;
      const dx=e.clientX-gestureStartX;
      const dy=e.clientY-gestureStartY;
      const mobile=window.matchMedia('(max-width:760px)').matches;
      if(mobile){
        if(dy<-35)setOpen(true);
        else if(dy>45)setOpen(false);
      }else{
        if(dx<-35)setOpen(true);
        else if(dx>45)setOpen(false);
      }
    };
    drawer.addEventListener('pointerdown',beginGesture);
    drawer.addEventListener('pointerup',endGesture);
    drawer.addEventListener('pointercancel',()=>{gestureActive=false});

    let touchStartX=0,touchStartY=0;
    drawer.addEventListener('touchstart',e=>{
      if(!e.touches?.length||e.target.closest('input,button,a'))return;
      touchStartX=e.touches[0].clientX;
      touchStartY=e.touches[0].clientY;
    },{passive:true});
    drawer.addEventListener('touchend',e=>{
      if(!e.changedTouches?.length||(!touchStartX&&!touchStartY))return;
      const dx=e.changedTouches[0].clientX-touchStartX;
      const dy=e.changedTouches[0].clientY-touchStartY;
      touchStartX=0;touchStartY=0;
      const mobile=window.matchMedia('(max-width:760px)').matches;
      if(mobile&&Math.abs(dy)>Math.abs(dx)){
        if(dy>55)setOpen(false);
        else if(dy<-55)setOpen(true);
      }else if(!mobile&&Math.abs(dx)>Math.abs(dy)){
        if(dx>55)setOpen(false);
        else if(dx<-55)setOpen(true);
      }
    },{passive:true});

    if(state.user){
      form?.classList.remove('hidden');
      signIn?.classList.add('hidden');
      form?.addEventListener('submit',async e=>{
        e.preventDefault();
        const message=String(input?.value||'').trim();
        if(!message)return;
        const submit=form.querySelector('button[type="submit"]');
        if(submit)submit.disabled=true;
        try{
          const data=await api('/api/live/'+fixtureId+'/chat',{method:'POST',body:{message}});
          const empty=$('.live-chat-empty',messages);
          if(empty)empty.remove();
          renderMessage(data.message);
          if(input)input.value='';
          setOpen(true);
        }catch(err){toast(err.message,true)}
        finally{if(submit)submit.disabled=false}
      });
    }else{
      form?.classList.add('hidden');
      signIn?.classList.remove('hidden');
      if(signIn){
        signIn.innerHTML='Sign in to send messages. <a href="/?login=1">Sign in</a>';
      }
    }

    loadHistory();
    connectChat();
    setOpen(drawer.classList.contains('fullscreen-chat')?false:true);
  }

  async function initLivePage(){
    const id=Number(new URLSearchParams(location.search).get('id')||0);
    if(!id){$('#livePlayer').innerHTML='<div class="empty">No fixture selected.</div>';return}
    try{
      const data=await api('/api/live/'+id);
      renderLivePlayer(data.live);
      initLiveChat(id);
    }catch(err){
      $('#livePlayer').innerHTML='<div class="empty">'+esc(err.message)+'</div>';
    }
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
    $('#printSheet')?.addEventListener('click',printScoresheet);
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
  function printScoresheet(){
    const id=state.fixture?.fixture?.id;
    if(!id){toast('No scoresheet selected.',true);return}
    const a=document.createElement('a');
    a.href='/api/fixtures/'+id+'/pdf';
    a.download='';
    document.body.appendChild(a);
    a.click();
    a.remove();
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
          ${f.stream_active&&f.stream_url?`<a class="btn small live-btn" href="/live?id=${f.id}"><span class="live-dot"></span>LIVE</a>`:''}
          ${f.status!=='APPROVED'?`<a class="btn small" href="/broadcast?id=${f.id}">Broadcast</a>`:''}
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
    if(PAGE==='live-page')await initLivePage();
    if(PAGE==='broadcast-page')await initBroadcastPage();
    if(PAGE==='news-page')await initNewsPage();
    if(PAGE==='rankings-page')await initRankingsPage();
    if(PAGE==='scoresheet')await initScoresheet();
    if(PAGE==='team')await initTeam();
    if(PAGE==='club-admin')await initClubAdmin();
    if(PAGE==='admin')await initAdmin();
  }catch(err){toast(err.message,true);console.error(err)}
})();