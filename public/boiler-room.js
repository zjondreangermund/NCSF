(() => {
  const $ = (selector, root=document) => root.querySelector(selector);
  const $$ = (selector, root=document) => Array.from(root.querySelectorAll(selector));
  const state = { stockItems: [], players: [] };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  }

  function localDate(value, withTime=true) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, withTime
      ? { dateStyle:'medium', timeStyle:'short' }
      : { dateStyle:'medium' }).format(date);
  }

  function localToIso(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : '';
  }

  async function request(url, options={}) {
    const init = { credentials:'same-origin', ...options, headers:{ ...(options.headers||{}) } };
    if (init.body && typeof init.body !== 'string' && !(init.body instanceof FormData)) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(init.body);
    }
    const response = await fetch(url, init);
    let payload={};
    try { payload=await response.json(); } catch (_error) {}
    if (!response.ok) throw new Error(payload.error || 'Could not complete that request.');
    return payload;
  }

  function toast(message, isError=false) {
    const node=$('#toast');
    if (!node) return;
    node.textContent=message;
    node.classList.toggle('error',Boolean(isError));
    node.classList.remove('hidden');
    clearTimeout(node.__brTimer);
    node.__brTimer=setTimeout(()=>node.classList.add('hidden'),3800);
  }

  function gameLabel(value) {
    return ({BLACKBALL:'Blackball','8_BALL':'8-ball','9_BALL':'9-ball'})[value] || 'Pool';
  }

  function challengeStateLabel(value) {
    return ({OPEN:'CALL OUT',SCHEDULED:'SCHEDULED',IN_PROGRESS:'ON TABLE',COMPLETED:'FINAL',CANCELED:'CANCELED'})[value] || value;
  }

  function challengeCard(challenge) {
    const statusClass=challenge.status==='IN_PROGRESS'?'IN_PROGRESS':challenge.status==='COMPLETED'?'APPROVED':challenge.status==='SCHEDULED'?'CONFIRMED':'SUBMITTED';
    const hasScore=['IN_PROGRESS','COMPLETED'].includes(challenge.status);
    const time=challenge.scheduled_at?localDate(challenge.scheduled_at):'Time to be set';
    return `<article class="br-challenge-card">
      <div class="br-challenge-card-head"><span class="pill ${statusClass}">${escapeHtml(challengeStateLabel(challenge.status))}</span><span class="br-challenge-meta"><b>${escapeHtml(gameLabel(challenge.game_type))}</b> · Race to ${Number(challenge.race_to)||5}</span></div>
      <div class="br-challenge-names"><strong>${escapeHtml(challenge.player_one_name)}</strong><span>VS</span><strong>${escapeHtml(challenge.player_two_name)}</strong></div>
      <div class="br-challenge-meta"><span>${escapeHtml(time)}</span>${hasScore?`<span class="br-challenge-score">${Number(challenge.score_one)||0} <i>—</i> ${Number(challenge.score_two)||0}</span>`:''}</div>
    </article>`;
  }

  function renderChallenges(target, challenges, emptyText) {
    if (!target) return;
    if (!challenges?.length) {
      target.classList.add('empty');
      target.innerHTML=`<div class="empty">${escapeHtml(emptyText)}</div>`;
      return;
    }
    target.classList.remove('empty');
    target.innerHTML=challenges.map(challengeCard).join('');
  }

  async function loadHomeChallenges() {
    const target=$('#challengePreview');
    if (!target) return;
    try {
      const {challenges=[]}=await request('/api/public/challenges');
      const current=challenges.filter(challenge=>challenge.status!=='COMPLETED').slice(0,2);
      target.innerHTML='<span class="br-kicker">CHALLENGE BOARD</span>';
      if (!current.length) {
        target.innerHTML+='<div class="empty">No challenges on the board yet. Call someone out and start the first one.</div>';
        return;
      }
      target.innerHTML+=current.map(challengeCard).join('')+'<a class="br-mini-link" href="/challenges">See the full board ↗</a>';
    } catch (_error) {
      target.innerHTML='<span class="br-kicker">CHALLENGE BOARD</span><div class="empty">The challenge board is unavailable right now.</div>';
    }
  }

  async function loadPublicChallenges() {
    const target=$('#publicChallengeList');
    if (!target) return;
    try {
      const {challenges=[]}=await request('/api/public/challenges');
      renderChallenges(target,challenges,'No challenges on the board yet. Send in a callout and we’ll get the first one going.');
    } catch (_error) {
      target.innerHTML='<div class="empty">The challenge board is unavailable right now. Try again in a moment.</div>';
    }
  }

  function initChallengeRequest() {
    const form=$('#challengeRequestForm');
    const message=$('#challengeRequestStatus');
    if (!form || !message) return;
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      const data=Object.fromEntries(new FormData(form).entries());
      data.preferredAt=localToIso(data.preferredAt);
      const button=$('button[type="submit"]',form);
      button.disabled=true;
      try {
        await request('/api/public/challenge-requests',{method:'POST',body:data});
        form.reset();
        message.className='notice success br-request-success';
        message.textContent='Callout received. The Boiler Room team will confirm it before it appears on the board.';
        message.classList.remove('hidden');
      } catch (error) {
        message.className='notice error br-request-success';
        message.textContent=error.message;
        message.classList.remove('hidden');
      } finally {
        button.disabled=false;
      }
    });
  }

  function stockState(item) {
    const quantity=Number(item.quantity)||0;
    const alert=Number(item.reorder_level)||0;
    if (quantity<=0) return {label:'OUT',className:'out'};
    if (quantity<=alert) return {label:'LOW',className:'low'};
    return {label:'IN STOCK',className:''};
  }

  function renderStock(items, movements) {
    state.stockItems=items||[];
    const low=state.stockItems.filter(item=>Number(item.quantity)<=Number(item.reorder_level)).length;
    const out=state.stockItems.filter(item=>Number(item.quantity)<=0).length;
    if ($('#stockItemCount')) $('#stockItemCount').textContent=state.stockItems.length;
    if ($('#stockLowCount')) $('#stockLowCount').textContent=low;
    if ($('#stockOutCount')) $('#stockOutCount').textContent=out;

    const list=$('#stockItemList');
    if (list) {
      if (!state.stockItems.length) { list.classList.add('empty');list.innerHTML='Add the lounge’s first item to start tracking stock.'; }
      else { list.classList.remove('empty');list.innerHTML=`<div class="table-wrap"><table><thead><tr><th>Item</th><th>Group</th><th>On hand</th><th>Alert at</th><th>Status</th><th>Update</th></tr></thead><tbody>${state.stockItems.map(item=>{
        const stateValue=stockState(item);
        return `<tr><td><strong>${escapeHtml(item.name)}</strong></td><td>${escapeHtml(item.category)}</td><td><strong>${Number(item.quantity).toLocaleString(undefined,{maximumFractionDigits:2})}</strong> ${escapeHtml(item.unit)}</td><td>${Number(item.reorder_level).toLocaleString(undefined,{maximumFractionDigits:2})} ${escapeHtml(item.unit)}</td><td><span class="br-stock-status ${stateValue.className}">${stateValue.label}</span></td><td><div class="br-stock-actions"><button class="btn br-btn-blue" type="button" data-stock-action="IN" data-item="${item.id}">Add</button><button class="btn" type="button" data-stock-action="OUT" data-item="${item.id}">Use</button><button class="btn" type="button" data-stock-action="COUNT" data-item="${item.id}">Count</button><button class="btn" type="button" data-stock-alert="${item.id}">Alert</button></div></td></tr>`;
      }).join('')}</tbody></table></div>`; }
    }

    const movementList=$('#stockMovementList');
    if (movementList) {
      if (!movements?.length) { movementList.classList.add('empty');movementList.innerHTML='No stock movements yet.'; }
      else { movementList.classList.remove('empty');movementList.innerHTML=`<div class="table-wrap"><table><thead><tr><th>Item</th><th>Change</th><th>Now</th><th>When</th></tr></thead><tbody>${movements.map(movement=>{
        const label=movement.movement_type==='IN'?'Added':movement.movement_type==='OUT'?'Used':'Count';
        return `<tr><td><strong>${escapeHtml(movement.item_name)}</strong>${movement.note?`<br><small class="muted">${escapeHtml(movement.note)}</small>`:''}</td><td>${label} ${Number(movement.quantity).toLocaleString(undefined,{maximumFractionDigits:2})} ${escapeHtml(movement.unit)}</td><td>${Number(movement.quantity_after).toLocaleString(undefined,{maximumFractionDigits:2})} ${escapeHtml(movement.unit)}</td><td>${escapeHtml(localDate(movement.created_at))}</td></tr>`;
      }).join('')}</tbody></table></div>`; }
    }
  }

  async function loadStock() {
    const list=$('#stockItemList');
    if (list && !state.stockItems.length) list.innerHTML='<div class="empty">Loading stock…</div>';
    try {
      const data=await request('/api/admin/stock');
      renderStock(data.items,data.movements);
    } catch (error) {
      if (list) list.innerHTML=`<div class="empty">${escapeHtml(error.message||'Stock could not be loaded.')}</div>`;
    }
  }

  function openStockMove(itemId, movementType) {
    const item=state.stockItems.find(row=>Number(row.id)===Number(itemId));
    const dialog=$('#stockMoveDialog');
    const form=$('#stockMovementForm');
    if (!item || !dialog || !form) return;
    const title=movementType==='IN'?'Add stock':movementType==='OUT'?'Record stock used':'Count stock on hand';
    $('#stockMoveAction').textContent=title.toUpperCase();
    $('#stockMoveTitle').textContent=`${title}: ${item.name}`;
    form.elements.itemId.value=item.id;
    form.elements.movementType.value=movementType;
    form.elements.quantity.value=movementType==='COUNT'?Number(item.quantity):'';
    form.elements.quantity.max=movementType==='OUT'?Number(item.quantity):1000000;
    form.elements.quantity.step='0.01';
    form.elements.note.value='';
    dialog.showModal();
    form.elements.quantity.focus();
  }

  async function loadAdminChallenges() {
    const list=$('#adminChallengeList');
    const requestsBox=$('#adminChallengeRequests');
    if (list && !list.dataset.loaded) list.innerHTML='<div class="empty">Loading challenges…</div>';
    try {
      const [challengeData,requestData]=await Promise.all([
        request('/api/admin/challenges'),
        request('/api/admin/challenge-requests')
      ]);
      if (list) {
        const challenges=challengeData.challenges||[];
        list.dataset.loaded='true';
        if (!challenges.length) { list.classList.add('empty');list.innerHTML='No challenges yet. Create one above or approve a player callout.'; }
        else { list.classList.remove('empty');list.innerHTML=`<div class="table-wrap"><table><thead><tr><th>Players</th><th>Game</th><th>Time</th><th>Status</th><th>Score</th><th>Save</th></tr></thead><tbody>${challenges.map(challenge=>{
          const dateValue=challenge.scheduled_at?new Date(new Date(challenge.scheduled_at).getTime()-new Date(challenge.scheduled_at).getTimezoneOffset()*60000).toISOString().slice(0,16):'';
          return `<tr data-admin-challenge="${challenge.id}"><td><strong>${escapeHtml(challenge.player_one_name)}</strong><br><span class="muted">vs ${escapeHtml(challenge.player_two_name)}</span></td><td>${escapeHtml(gameLabel(challenge.game_type))}<br><small class="muted">Race to ${Number(challenge.race_to)}</small></td><td><input aria-label="Challenge date and time" type="datetime-local" data-br-scheduled value="${dateValue}"></td><td><select aria-label="Challenge status" data-br-status><option value="OPEN" ${challenge.status==='OPEN'?'selected':''}>Open</option><option value="SCHEDULED" ${challenge.status==='SCHEDULED'?'selected':''}>Scheduled</option><option value="IN_PROGRESS" ${challenge.status==='IN_PROGRESS'?'selected':''}>On table</option><option value="COMPLETED" ${challenge.status==='COMPLETED'?'selected':''}>Final</option><option value="CANCELED" ${challenge.status==='CANCELED'?'selected':''}>Canceled</option></select></td><td><div class="br-stock-actions"><input aria-label="${escapeHtml(challenge.player_one_name)} score" type="number" min="0" max="${Number(challenge.race_to)}" data-br-score-one value="${Number(challenge.score_one)||0}"><span>—</span><input aria-label="${escapeHtml(challenge.player_two_name)} score" type="number" min="0" max="${Number(challenge.race_to)}" data-br-score-two value="${Number(challenge.score_two)||0}"></div></td><td><button class="btn br-btn-blue" type="button" data-br-save-challenge="${challenge.id}">Save</button></td></tr>`;
        }).join('')}</tbody></table></div>`; }
      }
      if (requestsBox) {
        const requests=requestData.requests||[];
        $('#challengeRequestCount').textContent=requests.length;
        if (!requests.length) { requestsBox.classList.add('empty');requestsBox.innerHTML='No new challenge requests.'; }
        else { requestsBox.classList.remove('empty');requestsBox.innerHTML='<div class="card-list">'+requests.map(row=>`<div class="card-row br-request-row"><span><strong>${escapeHtml(row.challenger_name)} vs ${escapeHtml(row.opponent_name)}</strong><small>${escapeHtml(gameLabel(row.game_type))} · Race to ${Number(row.race_to)}${row.preferred_at?` · ${escapeHtml(localDate(row.preferred_at))}`:''}<br>${escapeHtml(row.contact)}${row.notes?` · ${escapeHtml(row.notes)}`:''}</small></span><span class="br-stock-actions"><button class="btn br-btn-blue" type="button" data-br-review="APPROVED" data-request="${row.id}">Approve</button><button class="btn" type="button" data-br-review="DECLINED" data-request="${row.id}">Decline</button></span></div>`).join('')+'</div>'; }
      }
    } catch (error) {
      if (list) list.innerHTML=`<div class="empty">${escapeHtml(error.message||'Challenges could not be loaded.')}</div>`;
    }
  }

  async function loadAdmin() {
    try {
      const auth=await request('/api/auth/me');
      if (!auth.user || auth.user.role!=='NCSF_ADMIN') return;
      const meta=await request('/api/admin/meta');
      state.players=(meta.players||[]).filter(player=>player.active!==false);
      const options='<option value="">Choose player</option>'+state.players.map(player=>`<option value="${player.id}">${escapeHtml(`${player.first_name} ${player.last_name}`.trim())}${player.team_name?` · ${escapeHtml(player.team_name)}`:''}</option>`).join('');
      if ($('#challengePlayerOne')) $('#challengePlayerOne').innerHTML=options;
      if ($('#challengePlayerTwo')) $('#challengePlayerTwo').innerHTML=options;
      await Promise.all([loadStock(),loadAdminChallenges()]);

      $('#stockItemForm')?.addEventListener('submit',async event=>{
        event.preventDefault();
        const form=event.currentTarget;
        const data=Object.fromEntries(new FormData(form).entries());
        data.quantity=Number(data.quantity);data.reorderLevel=Number(data.reorderLevel);
        const button=$('button[type="submit"]',form);button.disabled=true;
        try {
          await request('/api/admin/stock/items',{method:'POST',body:data});
          form.reset();
          await loadStock();
          toast('Stock item added.');
        } catch(error) { toast(error.message,true); }
        finally { button.disabled=false; }
      });

      $('#stockMovementForm')?.addEventListener('submit',async event=>{
        event.preventDefault();
        const form=event.currentTarget;
        const itemId=form.elements.itemId.value;
        const button=$('button[type="submit"]',form);button.disabled=true;
        try {
          await request(`/api/admin/stock/items/${itemId}/movements`,{method:'POST',body:{movementType:form.elements.movementType.value,quantity:Number(form.elements.quantity.value),note:form.elements.note.value}});
          $('#stockMoveDialog').close();
          await loadStock();
          toast('Stock updated.');
        } catch(error) { toast(error.message,true); }
        finally { button.disabled=false; }
      });

      $('#closeStockMove')?.addEventListener('click',()=>$('#stockMoveDialog')?.close());
      $('#stockItemList')?.addEventListener('click',async event=>{
        const action=event.target.closest('[data-stock-action]');
        if (action) return openStockMove(action.dataset.item,action.dataset.stockAction);
        const alertButton=event.target.closest('[data-stock-alert]');
        if (!alertButton) return;
        const item=state.stockItems.find(row=>Number(row.id)===Number(alertButton.dataset.stockAlert));
        if (!item) return;
        const answer=prompt(`Show a low-stock alert for ${item.name} when quantity reaches:`,String(item.reorder_level));
        if (answer===null) return;
        const reorderLevel=Number(answer);
        if (!Number.isFinite(reorderLevel)||reorderLevel<0) return toast('Enter a quantity of zero or higher.',true);
        try { await request(`/api/admin/stock/items/${item.id}`,{method:'PATCH',body:{reorderLevel}});await loadStock();toast('Low-stock alert updated.'); }
        catch(error) { toast(error.message,true); }
      });

      $('#challengeCreateForm')?.addEventListener('submit',async event=>{
        event.preventDefault();
        const form=event.currentTarget;
        const data=Object.fromEntries(new FormData(form).entries());
        data.playerOneId=Number(data.playerOneId);data.playerTwoId=Number(data.playerTwoId);data.raceTo=Number(data.raceTo);data.scheduledAt=localToIso(data.scheduledAt);
        const button=$('button[type="submit"]',form);button.disabled=true;
        try {
          await request('/api/admin/challenges',{method:'POST',body:data});
          form.reset();
          form.elements.raceTo.value=5;
          await loadAdminChallenges();
          toast('Challenge added to the board.');
        } catch(error) { toast(error.message,true); }
        finally { button.disabled=false; }
      });

      $('#adminChallengeList')?.addEventListener('click',async event=>{
        const button=event.target.closest('[data-br-save-challenge]');
        if (!button) return;
        const row=button.closest('[data-admin-challenge]');
        const body={status:$('[data-br-status]',row).value,scoreOne:Number($('[data-br-score-one]',row).value),scoreTwo:Number($('[data-br-score-two]',row).value),scheduledAt:localToIso($('[data-br-scheduled]',row).value)};
        button.disabled=true;
        try { await request(`/api/admin/challenges/${button.dataset.brSaveChallenge}`,{method:'PATCH',body});await loadAdminChallenges();toast('Challenge updated.'); }
        catch(error) { toast(error.message,true); }
        finally { button.disabled=false; }
      });

      $('#adminChallengeRequests')?.addEventListener('click',async event=>{
        const button=event.target.closest('[data-br-review]');
        if (!button) return;
        button.disabled=true;
        try {
          await request(`/api/admin/challenge-requests/${button.dataset.request}/review`,{method:'POST',body:{decision:button.dataset.brReview}});
          await loadAdminChallenges();
          toast(button.dataset.brReview==='APPROVED'?'Callout approved and added to the board.':'Callout declined.');
        } catch(error) { toast(error.message,true);button.disabled=false; }
      });

      document.addEventListener('click',event=>{
        const tab=event.target.closest('[data-admin-tab]');
        if (!tab) return;
        if (tab.dataset.adminTab==='stock') loadStock();
        if (tab.dataset.adminTab==='challenges') loadAdminChallenges();
      });
      window.addEventListener('hashchange',()=>{
        const name=location.hash.replace(/^#/,'');
        if (['stock','challenges'].includes(name)) $(`[data-admin-tab="${name}"]`)?.click();
      });
    } catch (_error) {
      // The main app handles sign-in and permissions. Keep the added tools quiet for signed-out visitors.
    }
  }

  const page=document.body?.dataset.page;
  if (page==='home') loadHomeChallenges();
  if (page==='challenges-page') { loadPublicChallenges();initChallengeRequest(); }
  if (page==='admin') loadAdmin();
})();
