(() => {
  'use strict';
  const sections={features:'Features',firewall:'Firewall',certificates:'Certificates',outbounds:'Outbounds',mtproxy:'Telegram Proxy',fair:'Fair Use'};
  let active=null, outlet=null, hidden=[], timer=null, loading=false, snapshot=null;
  const fetcher=window.fetch.bind(window);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function request(path,body,method){
    const headers={'Content-Type':'application/json'};const token=localStorage.getItem('token');if(token)headers.Authorization='Bearer '+token;
    const res=await fetcher(path,{headers,credentials:'same-origin',method:method||(body?'POST':'GET'),...(body?{body:JSON.stringify(body)}:{})});
    const data=await res.json().catch(()=>({}));if(!res.ok)throw Error(typeof data.detail==='string'?data.detail:JSON.stringify(data.detail||res.status));return data;
  }
  function installStyle(){
    if(document.getElementById('hs-services-style'))return;
    const style=document.createElement('style');style.id='hs-services-style';style.textContent=`
    #hs-services-root{padding:1rem;width:100%;color:hsl(var(--foreground));font-family:inherit}
    #hs-services-root *{box-sizing:border-box}
    .hs-service-tabs{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:20px}
    .hs-service-tabs button,#hs-services-root button{font:inherit;font-size:.78rem;cursor:pointer;padding:8px 12px;border:1px solid hsl(var(--border));border-radius:9px;color:inherit;background:hsl(var(--background))}
    .hs-service-tabs button[aria-current=page]{border-color:#cba64d;background:rgba(203,166,77,.10);color:#af862c}
    #hs-services-root button:disabled{opacity:.5;cursor:not-allowed}
    #hs-services-root .hs-s-head{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:16px 0}
    #hs-services-root h2{font-size:1.2rem;font-weight:650;margin:0}
    #hs-services-root h3{font-size:.9rem;font-weight:600;margin:0 0 10px}
    #hs-services-root p{font-size:.8rem;color:hsl(var(--muted-foreground));line-height:1.6}
    #hs-services-root .hs-s-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
    #hs-services-root .hs-s-card{border:1px solid hsl(var(--border));border-radius:14px;padding:18px;background:hsl(var(--card));min-width:0}
    #hs-services-root .hs-s-badge{display:inline-block;color:#b88c28;background:rgba(203,166,77,.1);padding:3px 8px;border-radius:20px;font-size:.65rem;border:1px solid rgba(203,166,77,.3)}
    #hs-services-root .hs-s-status{font-size:.76rem;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
    #hs-services-root label{display:grid;gap:5px;font-size:.78rem;margin-bottom:12px}
    #hs-services-root input,#hs-services-root select,#hs-services-root textarea{font:inherit;font-size:.8rem;width:100%;padding:9px;border:1px solid hsl(var(--border));border-radius:8px;background:hsl(var(--background));color:inherit}
    #hs-services-root input[type=checkbox]{width:auto}
    #hs-services-root textarea{min-height:140px;direction:ltr}
    #hs-services-root .hs-s-meter{height:5px;border-radius:5px;background:hsl(var(--muted));overflow:hidden;margin:12px 0}
    #hs-services-root .hs-s-meter i{display:block;height:100%;border-radius:5px}
    #hs-services-root .hs-s-table{width:100%;border-collapse:collapse;font-size:.75rem}
    #hs-services-root td,#hs-services-root th{text-align:start;padding:10px;border-bottom:1px solid hsl(var(--border))}
    #hs-services-root .hs-s-actions{display:flex;gap:6px;flex-wrap:wrap}
    #hs-services-root button:focus-visible,.hs-service-tabs button:focus-visible{outline:2px solid #cba64d;outline-offset:3px}
    `;document.head.appendChild(style);
  }
  function route(section){
    if(section==='features'){close();window.HSShieldDebug?.close();window.HSPluginDebug?.open();}
    else if(section==='firewall'){close();window.HSShieldDebug?.open();}
    else open(section);
  }
  function mountTabs(root,current){
    let tabs=root.querySelector('#hs-plugin-top-tabs,#hs-shield-top-tabs,.hs-service-tabs');
    if(!tabs)return;
    if(tabs.dataset.servicesTabs===current)return;
    tabs.dataset.servicesTabs=current;tabs.classList.add('hs-service-tabs');tabs.setAttribute('aria-label','HS Plugin sections');
    tabs.innerHTML=Object.entries(sections).map(([key,label])=>`<button type="button" data-service-tab="${key}" aria-current="${key===current?'page':'false'}">${label}</button>`).join('');
    tabs.querySelectorAll('button').forEach(b=>b.onclick=()=>route(b.dataset.serviceTab));
    if(current==='features')mountFeatures(root);
  }
  async function mountFeatures(root){
    if(root.querySelector('[data-services-features]'))return;
    const block=document.createElement('div');block.dataset.servicesFeatures='1';block.className='space-y-2';tabsAfter(root).appendChild(block);
    try{
      const state=await request('/api/hs-plugin/state');
      for(const [key,label] of Object.entries({certificate_manager:'Certificate Manager',warp:'WARP Outbounds',mtproxy:'Telegram MTProxy',fair_use:'Fair Use'})){
        const row=document.createElement('div');row.className='bg-card flex items-center justify-between gap-3 rounded-lg border p-4';
        row.innerHTML=`<div><span>${label}</span> <small class="hs-gold">HS</small>${key==='fair_use'?'<p class="text-muted-foreground text-xs">Draft policies · node rate adapter required</p>':''}</div><button type="button" role="switch" aria-label="${label}" aria-checked="${!!state.features?.[key]?.enabled}" style="border:1px solid #b69a51;border-radius:12px;padding:4px 10px">${state.features?.[key]?.enabled?'On':'Off'}</button><span role="status"></span>`;
        const button=row.querySelector('button');button.onclick=async()=>{button.disabled=true;const next=button.getAttribute('aria-checked')!=='true';try{await request('/api/hs-plugin/features/'+key,{enabled:next},'PUT');button.setAttribute('aria-checked',String(next));button.textContent=next?'On':'Off';}catch(e){row.querySelector('[role=status]').textContent=e.message;}finally{button.disabled=false;}};
        block.appendChild(row);
      }
    }catch(e){block.textContent=e.message;}
  }
  function tabsAfter(root){return root.querySelector('.space-y-3')||root;}
  function close(){
    active=null;clearInterval(timer);timer=null;
    window.HSPluginDebug?.setSection?.(null);
    for(const [el,display] of hidden)if(el.isConnected)el.style.display=display;
    hidden=[];document.getElementById('hs-services-root')?.remove();
    document.querySelectorAll('[data-hs-service-nav]').forEach(b=>b.dataset.active='false');
  }
  async function open(section){
    if(!sections[section])return;
    const state=await request('/api/hs-plugin/state').catch(()=>null);if(!state)return;
    close();window.HSShieldDebug?.close();window.HSPluginDebug?.close();
    outlet=window.HSPluginDebug?.getOutletHost?.();if(!outlet)return;
    active=section;window.HSPluginDebug?.setSection?.(section);hidden=[...outlet.children].map(el=>[el,el.style.display]);hidden.forEach(([el])=>el.style.display='none');
    const root=document.createElement('section');root.id='hs-services-root';root.innerHTML=`<nav class="hs-service-tabs"></nav><div class="hs-s-head"><div><span class="hs-s-badge">HS PLUGIN</span><h2>${sections[section]}</h2></div><button data-refresh type="button">Refresh</button></div><div class="hs-s-status" role="status" data-message></div><div data-body></div>`;outlet.appendChild(root);mountTabs(root,section);
    root.querySelector('[data-refresh]').onclick=()=>render(root);
    document.querySelectorAll('[data-hs-service-nav]').forEach(b=>b.dataset.active=String(b.dataset.hsServiceNav===section));
    await render(root);
    timer=setInterval(()=>{if(!document.hidden&&active==='certificates'&&!loading)render(root);},15000);
  }
  async function action(button,fn){
    button.disabled=true;const msg=document.querySelector('#hs-services-root [data-message]');
    try{const data=await fn();if(msg)msg.textContent=data?.id?`Job ${data.id.slice(0,8)} · ${data.state}. Refresh to see the result.`:'Saved.';return data;}
    catch(e){if(msg)msg.textContent=e.message;return null;}finally{if(button.isConnected)button.disabled=false;}
  }
  function targetOptions(data){return data.targets.map(t=>`<option value="${esc(t.id)}">${esc(t.name)} · ${t.online?'Online':'Offline'}</option>`).join('');}
  async function render(root){
    if(loading||!root.isConnected)return;loading=true;
    const body=root.querySelector('[data-body]');
    try{
      const data=await request('/api/hs-services/inventory');snapshot=data;
      if(!root.isConnected)return;
      if(active==='certificates')certificates(body,data);
      if(active==='outbounds')await outbounds(body);
      if(active==='mtproxy')mtproxy(body,data);
      if(active==='fair')await fair(body);
    }catch(e){root.querySelector('[data-message]').textContent=e.message;}
    finally{loading=false;}
  }
  function jobs(data){return `<div style="overflow:auto;margin-top:18px"><h3>Recent operations</h3><table class="hs-s-table"><thead><tr><th>Operation</th><th>Target</th><th>Status</th><th>Result</th></tr></thead><tbody>${data.jobs.slice(0,15).map(j=>`<tr><td>${esc(j.action)}</td><td>${esc(j.target)}</td><td>${esc(j.state)}</td><td>${esc(j.error||j.result?.activation||'')}</td></tr>`).join('')}</tbody></table></div>`;}
  function certificates(body,data){
    const cards=[];
    for(const target of data.targets)for(const cert of target.certificates||[])cards.push({...cert,target:target.id,targetName:target.name,online:target.online});
    for(const cert of data.node_trust)cards.push({...cert,targetName:cert.name,online:false});
    body.innerHTML=`<div class="hs-s-grid">${cards.map((c,index)=>{
      const days=c.expires_at?Math.ceil((c.expires_at*1000-Date.now())/86400000):null;
      const color=days===null?'#64748b':days<=0?'#ef4444':days<=30?'#ea580c':'#16a34a';
      const progress=c.expires_at&&c.starts_at?Math.max(0,Math.min(100,(c.expires_at-Date.now()/1000)/(c.expires_at-c.starts_at)*100)):0;
      return `<article class="hs-s-card"><span class="hs-s-badge">${esc(c.targetName)}</span><h3 style="margin-top:12px">${esc((c.domains||[]).join(', ')||c.id)}</h3><strong style="color:${color}">${days===null?'Unknown expiry':days<=0?'Expired':days+' days remaining'}</strong><div class="hs-s-meter"><i style="width:${progress}%;background:${color}"></i></div><p>${c.expires_at?esc(new Date(c.expires_at*1000).toLocaleString()):esc(c.error)}<br>${esc(c.provider)}<br>${esc(c.note||'')}</p><button data-renew="${index}" ${!c.online||!c.renewable?'disabled':''}>Renew now</button></article>`;
    }).join('')||'<p>No certificates reported yet. Connect the server agent to discover its certificates.</p>'}</div><details style="margin-top:18px"><summary>Node agents</summary><p>Enrollment creates a scoped token for this node. Install the HS service agent on the node to report certificates and execute renewal.</p>${data.targets.filter(t=>t.id!=='panel').map(t=>`<div class="hs-s-head"><span>${esc(t.name)} · ${t.online?'Online':'Offline'}</span><button data-enroll="${esc(t.id)}">Generate agent token</button></div>`).join('')}<div data-token class="hs-s-status"></div></details>${jobs(data)}`;
    body.querySelectorAll('[data-renew]').forEach(b=>b.onclick=()=>{const c=cards[Number(b.dataset.renew)];action(b,()=>request(`/api/hs-services/targets/${encodeURIComponent(c.target)}/renew`,{certificate_id:c.id}));});
    body.querySelectorAll('[data-enroll]').forEach(b=>b.onclick=async()=>{const r=await action(b,()=>request(`/api/hs-services/agents/${b.dataset.enroll}/enroll`,{}));if(r){body.querySelector('[data-token]').textContent=`Target ${r.target}\nToken (shown once): ${r.token}\nStore this in /etc/hs-pg/agent-token on the node with mode 600.`;clearInterval(timer);}});
  }
  async function outbounds(body){
    const data=await request('/api/cores');const cores=data.cores||[];
    body.innerHTML=`<div class="hs-s-grid"><form class="hs-s-card"><h3>WARP outbound <span class="hs-s-badge">HS</span></h3><p>Import your WARP WireGuard profile. Select the domains or inbounds that should use it.</p><label>Core<select name="core" required>${cores.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label><label>Tag<input name="tag" value="hs-warp-main" required pattern="hs-warp-[a-zA-Z0-9_-]{1,48}"></label><label>WireGuard profile<textarea name="profile" required autocomplete="off" spellcheck="false" placeholder="[Interface]&#10;PrivateKey = …&#10;Address = …&#10;[Peer]&#10;PublicKey = …&#10;Endpoint = …"></textarea></label><label>Domains, one per line<textarea name="domains" style="min-height:60px" placeholder="domain:example.com"></textarea></label><label>Inbound tags, comma separated<input name="inbounds"></label><label>Reserved bytes (optional)<input name="reserved" placeholder="0,0,0"></label><button type="submit">Preview routing</button></form><section class="hs-s-card"><h3>Preview & apply</h3><div data-preview class="hs-s-status">Choose a Core and preview your changes.</div><label style="margin-top:16px"><span><input type="checkbox" data-restart> Restart affected nodes after saving</span></label><button data-apply disabled>Apply WARP</button><p>Core changes are checked against the preview revision. Existing outbounds remain in place.</p><div data-existing></div></section></div>`;
    const form=body.querySelector('form');let pending=null;const apply=body.querySelector('[data-apply]');
    form.oninput=()=>{pending=null;apply.disabled=true;};
    const showExisting=()=>{const c=cores.find(c=>String(c.id)===form.elements.core.value);body.querySelector('[data-existing]').innerHTML='<h3>Current outbounds</h3>'+((c?.config?.outbounds)||[]).map(o=>`<p>${esc(o.tag||'(default)')} · ${esc(o.protocol)}</p>`).join('');};form.elements.core.onchange=showExisting;showExisting();
    form.onsubmit=async e=>{e.preventDefault();const f=new FormData(form);const payload={profile:f.get('profile'),tag:f.get('tag'),domains:String(f.get('domains')).split('\n').map(x=>x.trim()).filter(Boolean),inbounds:String(f.get('inbounds')).split(',').map(x=>x.trim()).filter(Boolean),reserved:f.get('reserved')?String(f.get('reserved')).split(',').map(Number):null};const core=f.get('core');const r=await action(form.querySelector('button'),()=>request(`/api/hs-services/cores/${core}/warp`,payload));if(r){pending={core,payload:{...payload,expected_revision:r.revision}};body.querySelector('[data-preview]').textContent=JSON.stringify(r.rules,null,2);apply.disabled=false;}};
    apply.onclick=async()=>{if(!pending)return;const r=await action(apply,()=>request(`/api/hs-services/cores/${pending.core}/warp`,{...pending.payload,apply:true,restart_nodes:body.querySelector('[data-restart]').checked}));if(r){pending=null;apply.disabled=true;form.elements.profile.value='';}};
  }
  function mtproxy(body,data){
    body.innerHTML=`<div class="hs-s-grid"><form class="hs-s-card"><h3>Create Telegram proxy <span class="hs-s-badge">HS</span></h3><label>Server<select name="target">${targetOptions(data)}</select></label><label>Public address<input name="host" required placeholder="proxy.example.com"></label><label>Client port<input name="port" type="number" min="1024" max="65535" value="8443" required></label><label>Local statistics port<input name="metrics_port" type="number" min="1024" max="65535" value="18888" required></label><label>Advertising tag (optional)<input name="ad_tag" pattern="[a-fA-F0-9]{32}"></label><button>Create proxy</button><p>Requires the official MTProxy binary on the target. Link uses random-padding mode.</p></form>${data.targets.flatMap(t=>(t.proxies||[]).map(p=>{
      const host=p.host.includes(':')?'['+p.host+']':p.host;const url='tg://proxy?'+new URLSearchParams({server:host,port:p.port,secret:'dd'+p.secret});
      return `<article class="hs-s-card"><span class="hs-s-badge">${esc(t.name)}</span><h3 style="margin-top:12px">${esc(p.host)}:${p.port}</h3><p>${p.active?'Running':'Stopped'}${t.online?'':' · Agent offline'}</p><input readonly aria-label="Telegram proxy link" value="${esc(url)}"><div class="hs-s-actions" style="margin-top:12px"><button data-copy>Copy link</button>${['start','stop','delete'].map(a=>`<button data-proxy-action="${a}" data-target="${esc(t.id)}" data-id="${esc(p.id)}" ${t.online?'':'disabled'}>${a}</button>`).join('')}</div></article>`;
    })).join('')}</div>${jobs(data)}`;
    body.querySelector('form').onsubmit=e=>{e.preventDefault();const f=new FormData(e.currentTarget);action(e.currentTarget.querySelector('button'),()=>request(`/api/hs-services/targets/${f.get('target')}/mtproxy`,{host:f.get('host'),port:Number(f.get('port')),metrics_port:Number(f.get('metrics_port')),ad_tag:f.get('ad_tag')}));};
    body.querySelectorAll('[data-copy]').forEach(b=>b.onclick=()=>action(b,()=>navigator.clipboard.writeText(b.closest('article').querySelector('input').value)));
    body.querySelectorAll('[data-proxy-action]').forEach(b=>b.onclick=()=>action(b,()=>request(`/api/hs-services/targets/${b.dataset.target}/mtproxy/${b.dataset.id}/${b.dataset.proxyAction}`,{})));
  }
  async function fair(body){
    const [state,policies]=await Promise.all([request('/api/hs-plugin/state'),request('/api/hs-services/fair-use')]);const hosts=state.hosts||[];
    body.innerHTML=`<p>${esc(policies.blocker)}</p><div class="hs-s-grid"><form class="hs-s-card"><h3>Host fair-use policy <span class="hs-s-badge">DRAFT</span></h3><label>Host<select name="host">${hosts.map(h=>`<option value="${h.id}">${esc(h.remark||h.id)}</option>`).join('')}</select></label><label>Threshold (GB, decimal)<input type="number" name="gb" min="0.001" step="0.001" value="100" required></label><label>Baseline speed (Mbps)<input type="number" name="baseline" min="0.1" step="0.1" value="100" required></label><label>Speed after threshold (%)<input type="number" name="percent" min="1" max="100" value="20" required></label><label><span><input type="checkbox" checked disabled> Fair limited eligibility</span></label><button>Save draft policy</button><p>100 Mbps × 20% = 20 Mbps. Threshold uses each user's charged traffic in the current quota cycle.</p></form><section class="hs-s-card"><h3>Per-user preview</h3><label>User ID<input data-user type="number" min="1"></label><button data-preview-user>Evaluate user</button><div class="hs-s-status" data-evaluation></div><p>Native expired, disabled and limited statuses keep priority. Preview does not change subscriptions or throttle traffic.</p></section></div>`;
    const form=body.querySelector('form');const hydrate=()=>{const p=policies.policies[form.elements.host.value];form.elements.gb.value=p?p.threshold_bytes/1e9:100;form.elements.baseline.value=p?.baseline_mbps||100;form.elements.percent.value=p?.speed_percent||20;};form.elements.host.onchange=hydrate;hydrate();
    form.onsubmit=e=>{e.preventDefault();const f=new FormData(form);action(form.querySelector('button'),()=>request(`/api/hs-services/hosts/${f.get('host')}/fair-use`,{threshold_bytes:Math.round(Number(f.get('gb'))*1e9),baseline_mbps:Number(f.get('baseline')),speed_percent:Number(f.get('percent'))},'PUT'));};
    body.querySelector('[data-preview-user]').onclick=async e=>{const id=body.querySelector('[data-user]').value;if(!/^\d+$/.test(id))return;const r=await action(e.currentTarget,()=>request(`/api/hs-services/users/${id}/fair-use-preview`));if(r){const target=body.querySelector('[data-evaluation]');target.textContent=`Preview: ${r.preview_status}\nApplied: ${r.enforced?'Yes':'No'}\nRates: ${JSON.stringify(r.rates_mbps)} Mbps`;target.style.color=r.color||'inherit';}};
  }
  function maintain(){
    const nav=document.getElementById('hs-plugin-submenu');if(nav&&!nav.querySelector('[data-hs-service-nav]')){
      for(const section of ['certificates','outbounds','mtproxy','fair']){const li=document.createElement('li');const b=document.createElement('button');const reference=nav.querySelector('button');b.type='button';b.className=reference?.className||'';b.dataset.sidebar='menu-sub-button';b.dataset.hsServiceNav=section;b.textContent=sections[section];b.onclick=()=>route(section);li.appendChild(b);nav.appendChild(li);}
    }
    if(active&&!document.getElementById('hs-services-root')?.isConnected)close();
  }
  function boot(){installStyle();maintain();let queued=false;new MutationObserver(()=>{if(!queued){queued=true;requestAnimationFrame(()=>{queued=false;maintain();});}}).observe(document.body,{childList:true,subtree:true});
    document.addEventListener('click',e=>{if(active&&e.target.closest('a')&&!e.target.closest('#hs-services-root,#hs-plugin-nav'))close();},true);window.addEventListener('popstate',close);
  }
  window.HSServices={open,close,mountTabs,isActive:()=>!!active};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
