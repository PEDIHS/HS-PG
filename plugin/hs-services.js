(() => {
  'use strict';
  const sections={features:'Features',certificates:'Certificates'};
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
    .hs-services-surface{padding:1rem;width:100%;color:hsl(var(--foreground));font-family:inherit}
    .hs-services-surface *{box-sizing:border-box}
    .hs-service-tabs{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:20px}
    .hs-service-tabs button,.hs-services-surface button{font:inherit;font-size:.78rem;cursor:pointer;padding:8px 12px;border:1px solid hsl(var(--border));border-radius:9px;color:inherit;background:hsl(var(--background))}
    .hs-service-tabs button[aria-current=page]{border-color:#cba64d;background:rgba(203,166,77,.10);color:#af862c}
    .hs-services-surface button:disabled{opacity:.5;cursor:not-allowed}
    .hs-services-surface .hs-s-head{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:16px 0}
    .hs-services-surface h2{font-size:1.2rem;font-weight:650;margin:0}
    .hs-services-surface h3{font-size:.9rem;font-weight:600;margin:0 0 10px}
    .hs-services-surface p{font-size:.8rem;color:hsl(var(--muted-foreground));line-height:1.6}
    .hs-services-surface .hs-s-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
    .hs-services-surface .hs-s-card{border:1px solid hsl(var(--border));border-radius:14px;padding:18px;background:hsl(var(--card));min-width:0}
    .hs-services-surface .hs-s-badge{display:inline-block;color:#b88c28;background:rgba(203,166,77,.1);padding:3px 8px;border-radius:20px;font-size:.65rem;border:1px solid rgba(203,166,77,.3)}
    .hs-services-surface .hs-s-status{font-size:.76rem;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}
    .hs-services-surface label{display:grid;gap:5px;font-size:.78rem;margin-bottom:12px}
    .hs-services-surface input,.hs-services-surface select,.hs-services-surface textarea{font:inherit;font-size:.8rem;width:100%;padding:9px;border:1px solid hsl(var(--border));border-radius:8px;background:hsl(var(--background));color:inherit}
    .hs-services-surface input[type=checkbox]{width:auto}
    .hs-services-surface textarea{min-height:140px;direction:ltr}
    .hs-services-surface .hs-s-meter{height:5px;border-radius:5px;background:hsl(var(--muted));overflow:hidden;margin:12px 0}
    .hs-services-surface .hs-s-meter i{display:block;height:100%;border-radius:5px}
    .hs-services-surface .hs-s-table{width:100%;border-collapse:collapse;font-size:.75rem}
    .hs-services-surface td,.hs-services-surface th{text-align:start;padding:10px;border-bottom:1px solid hsl(var(--border))}
    .hs-services-surface .hs-s-actions{display:flex;gap:6px;flex-wrap:wrap}
    .hs-services-surface button:focus-visible,.hs-service-tabs button:focus-visible{outline:2px solid #cba64d;outline-offset:3px}
    
    .hs-cert-summary{display:flex;align-items:center;gap:28px;border:1px solid hsl(var(--border));border-radius:14px;padding:20px;margin:0 0 16px;background:linear-gradient(120deg,rgba(203,166,77,.07),transparent)}
    .hs-cert-summary>div:first-child{flex:1}.hs-cert-summary strong{display:block;font-size:1.5rem;font-variant-numeric:tabular-nums}.hs-cert-summary span:not(.hs-s-badge){font-size:.7rem;color:hsl(var(--muted-foreground))}
    .hs-cert-top{display:flex;align-items:center;gap:8px;margin-bottom:18px}.hs-cert-icon{font-size:1.5rem}.hs-cert-online{margin-inline-start:auto;font-size:.65rem;color:hsl(var(--muted-foreground))}
    .hs-cert-card{position:relative;overflow:hidden}.hs-cert-card h3{overflow-wrap:anywhere}.hs-cert-domains{min-height:1.3em}.hs-cert-count{display:flex;gap:8px;align-items:baseline}.hs-cert-count strong{font-size:2.3rem;letter-spacing:-1px;font-variant-numeric:tabular-nums}.hs-cert-count>span{font-size:.75rem}.hs-cert-count .hs-s-badge{margin-inline-start:auto}
    .hs-cert-dates{display:flex;justify-content:space-between;font-size:.7rem;color:hsl(var(--muted-foreground));margin:18px 0}.hs-cert-dates strong{display:block;color:hsl(var(--foreground));margin-top:4px}.hs-cert-card [data-renew]{width:100%}
    @media(max-width:640px){.hs-cert-summary{flex-wrap:wrap;gap:16px}.hs-cert-summary>div:first-child{flex-basis:100%}}
`;document.head.appendChild(style);
  }
  function route(section){
    if(section==='features'){close();window.HSPluginDebug?.open();}
    else open(section);
  }
  function mountTabs(root,current){
    let tabs=root.querySelector('#hs-plugin-top-tabs,#hs-shield-top-tabs,.hs-service-tabs');
    if(!tabs){tabs=document.createElement('nav');tabs.className='hs-service-tabs';root.querySelector('.space-y-3')?.prepend(tabs);if(!tabs.isConnected)root.prepend(tabs);}
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
      const labels={certificate_manager:['Certificate Manager','Manage Certbot certificates and renew them on panel and node servers.'],warp:['WARP / WireGuard','Add WARP tools to the native Core Outbounds editor.'],mtproxy:['Telegram Proxy','Manage Telegram proxies from the native Core Inbounds section.'],fair_use:['Fair Use','Configure per-user traffic thresholds and speed limits inside each Host.']};
      for(const [key,[label,description]] of Object.entries(labels)){
        const kit=window.HSPluginTabFix;if(!kit)continue;
        block.insertAdjacentHTML('beforeend',kit.featureCard(label+' <small class="hs-gold">HS</small>',description,'hs-feature-slot-'+key));
        const slot=block.querySelector('#hs-feature-slot-'+key);slot.classList.remove('opacity-60');
        slot.innerHTML=kit.switchMarkup('hs-feature-'+key,!!state.features?.[key]?.enabled);
        const button=slot.querySelector('button');button.setAttribute('aria-label',label);
        button.onclick=async()=>{button.disabled=true;const next=button.getAttribute('aria-checked')!=='true';try{await request('/api/hs-plugin/features/'+key,{enabled:next},'PUT');kit.syncSwitch(button,next);window.dispatchEvent(new CustomEvent('hs-plugin-feature-changed',{detail:{feature:key,enabled:next}}));}catch(e){let msg=block.querySelector('[role=status]');if(!msg){msg=document.createElement('p');msg.setAttribute('role','status');block.appendChild(msg);}msg.textContent=e.message;}finally{button.disabled=false;}};
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
    close();window.HSPluginDebug?.close();
    outlet=window.HSPluginDebug?.getOutletHost?.();if(!outlet)return;
    active=section;window.HSPluginDebug?.setSection?.(section);hidden=[...outlet.children].map(el=>[el,el.style.display]);hidden.forEach(([el])=>el.style.display='none');
    const root=document.createElement('section');root.id='hs-services-root';root.className='hs-services-surface';root.innerHTML=`<nav class="hs-service-tabs"></nav><div class="hs-s-head"><div><span class="hs-s-badge">HS PLUGIN</span><h2>${sections[section]}</h2></div><button data-refresh type="button">Refresh</button></div><div class="hs-s-status" role="status" data-message></div><div data-body></div>`;outlet.appendChild(root);mountTabs(root,section);
    root.querySelector('[data-refresh]').onclick=()=>render(root);
    document.querySelectorAll('[data-hs-service-nav]').forEach(b=>b.dataset.active=String(b.dataset.hsServiceNav===section));
    await render(root);
    timer=setInterval(()=>{if(!document.hidden&&active==='certificates'&&!loading)render(root);},15000);
  }
  async function action(button,fn){
    button.disabled=true;const msg=button.closest('.hs-services-surface')?.querySelector('[data-message]');
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
      
    }catch(e){root.querySelector('[data-message]').textContent=e.message;}
    finally{loading=false;}
  }
  function jobs(data){return `<div style="overflow:auto;margin-top:18px"><h3>Recent operations</h3><table class="hs-s-table"><thead><tr><th>Operation</th><th>Target</th><th>Status</th><th>Result</th></tr></thead><tbody>${data.jobs.slice(0,15).map(j=>`<tr><td>${esc(j.action)}</td><td>${esc(j.target)}</td><td>${esc(j.state)}</td><td>${esc(j.error||j.result?.activation||'')}</td></tr>`).join('')}</tbody></table></div>`;}
  function certificates(body,data){
    const cards=[];
    for(const target of data.targets)for(const cert of target.certificates||[])cards.push({...cert,target:target.id,targetName:target.name,online:target.online});
    const managed=cards.filter(c=>c.provider==='certbot');cards.splice(0,cards.length,...managed);
    const days=c=>Number.isFinite(c.expires_at)?Math.ceil((c.expires_at*1000-Date.now())/86400000):null;
    const due=cards.filter(c=>days(c)!==null&&days(c)<=30).length;
    const busy=new Set(data.jobs.filter(j=>['queued','running'].includes(j.state)&&j.action==='renew').map(j=>j.target+':'+j.resource));
    body.innerHTML=`<div class="hs-cert-summary"><div><span class="hs-s-badge">CERTBOT · ACME</span><h3>Domain certificates</h3><p>Panel and node HTTPS certificates · last checked ${esc(new Date().toLocaleTimeString())}</p></div><div><strong>${cards.length}</strong><span>Certificates</span></div><div><strong style="color:${due?'#ea580c':'inherit'}">${due}</strong><span>Due within 30 days</span></div><div><strong>${data.targets.filter(t=>t.online).length}/${data.targets.length}</strong><span>Agents online</span></div></div><div class="hs-s-grid">${cards.map((c,index)=>{
      const remaining=days(c);const color=remaining===null?'#64748b':remaining<=0?'#ef4444':remaining<=30?'#ea580c':'#10b981';
      const progress=c.expires_at&&c.starts_at?Math.max(0,Math.min(100,(c.expires_at-Date.now()/1000)/(c.expires_at-c.starts_at)*100)):0;
      const renewing=busy.has(c.target+':'+c.id);
      return `<article class="hs-s-card hs-cert-card"><div class="hs-cert-top"><span class="hs-cert-icon" style="color:${color}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7z"/><path d="m8 12 3 3 5-6"/></svg></span><span class="hs-s-badge">${esc(c.targetName)}</span><span class="hs-cert-online">${c.online?'● Online':'○ Offline'}</span></div><h3>${esc(c.domains?.[0]||c.id)}</h3><p class="hs-cert-domains">${esc(c.domains?.slice(1).join(' · ')||'Certbot managed certificate')}</p><div class="hs-cert-count" style="color:${color}"><strong>${remaining===null?'—':Math.max(0,remaining)}</strong><span>${remaining!==null&&remaining<=0?'Expired':'days remaining'}</span><span class="hs-s-badge">${renewing?'Renewing':remaining===null?'Unavailable':remaining<=0?'Expired':remaining<=30?'Renew soon':'Valid'}</span></div><div class="hs-s-meter"><i style="width:${progress}%;background:${color}"></i></div><div class="hs-cert-dates"><span>Issued<strong>${c.starts_at?esc(new Date(c.starts_at*1000).toLocaleDateString()):'—'}</strong></span><span>Expires<strong>${c.expires_at?esc(new Date(c.expires_at*1000).toLocaleDateString()):'—'}</strong></span></div>${c.error?`<p role="alert">${esc(c.error)}</p>`:''}<button data-renew="${index}" ${!c.online||!c.renewable||renewing?'disabled':''}>${renewing?'Renewal in progress…':'↻ Renew now'}</button></article>`;
    }).join('')||'<div class="hs-s-card"><h3>No Certbot certificates reported</h3><p>Install or connect the HS agent on the certificate server. It reads Certbot lineages from /etc/letsencrypt/live and their renewal configuration.</p></div>'}</div><details style="margin-top:18px"><summary>Server connections</summary>${data.targets.map(t=>`<div class="hs-s-head"><span>${esc(t.name)} · ${t.online?'Online':'Offline'}${t.capabilities?.certbot?' · Certbot ready':' · Certbot not reported'}</span>${t.id!=='panel'?`<button data-enroll="${esc(t.id)}">Connect agent</button>`:''}</div>`).join('')}<div data-token class="hs-s-status"></div></details>${jobs({...data,jobs:data.jobs.filter(j=>j.action==='renew')})}`;
    body.querySelectorAll('[data-renew]').forEach(b=>b.onclick=()=>{const c=cards[Number(b.dataset.renew)];action(b,()=>request(`/api/hs-services/targets/${encodeURIComponent(c.target)}/renew`,{certificate_id:c.id}));});
    body.querySelectorAll('[data-enroll]').forEach(b=>b.onclick=async()=>{const r=await action(b,()=>request(`/api/hs-services/agents/${b.dataset.enroll}/enroll`,{}));if(r){body.querySelector('[data-token]').textContent=`Target ${r.target}\nToken (shown once): ${r.token}\nStore this in /etc/hs-pg/agent-token on the node with mode 600.`;clearInterval(timer);}});
  }
  async function outbounds(body,nativeCore){
    const data=await request('/api/cores');const cores=(data.cores||[]).filter(c=>!nativeCore||Number(c.id)===nativeCore);
    body.innerHTML=`<div class="hs-s-grid"><form class="hs-s-card"><h3>WARP outbound <span class="hs-s-badge">HS</span></h3><p>Import your WARP WireGuard profile. Select the domains or inbounds that should use it.</p><label>Core<select name="core" required>${cores.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label><label>Tag<input name="tag" value="hs-warp-main" required pattern="hs-warp-[a-zA-Z0-9_-]{1,48}"></label><label>WireGuard profile<textarea name="profile" required autocomplete="off" spellcheck="false" placeholder="[Interface]&#10;PrivateKey = …&#10;Address = …&#10;[Peer]&#10;PublicKey = …&#10;Endpoint = …"></textarea></label><label>Domains, one per line<textarea name="domains" style="min-height:60px" placeholder="domain:example.com"></textarea></label><label>Inbound tags, comma separated<input name="inbounds"></label><label>Reserved bytes (optional)<input name="reserved" placeholder="0,0,0"></label><button type="submit">Preview routing</button></form><section class="hs-s-card"><h3>Preview & apply</h3><div data-preview class="hs-s-status">Choose a Core and preview your changes.</div><label style="margin-top:16px"><span><input type="checkbox" data-restart> Restart affected nodes after saving</span></label><button data-apply disabled>Apply WARP</button><p>Core changes are checked against the preview revision. Existing outbounds remain in place.</p><div data-existing></div></section></div>`;
    const form=body.querySelector('form');let pending=null;const apply=body.querySelector('[data-apply]');
    form.oninput=()=>{pending=null;apply.disabled=true;};
    const showExisting=()=>{const c=cores.find(c=>String(c.id)===form.elements.core.value);body.querySelector('[data-existing]').innerHTML='<h3>Current outbounds</h3>'+((c?.config?.outbounds)||[]).map(o=>`<p>${esc(o.tag||'(default)')} · ${esc(o.protocol)}</p>`).join('');};form.elements.core.onchange=showExisting;showExisting();
    form.onsubmit=async e=>{e.preventDefault();const f=new FormData(form);const payload={profile:f.get('profile'),tag:f.get('tag'),domains:String(f.get('domains')).split('\n').map(x=>x.trim()).filter(Boolean),inbounds:String(f.get('inbounds')).split(',').map(x=>x.trim()).filter(Boolean),reserved:f.get('reserved')?String(f.get('reserved')).split(',').map(Number):null};const core=f.get('core');const r=await action(form.querySelector('button'),()=>request(`/api/hs-services/cores/${core}/warp`,payload));if(r){pending={core,payload:{...payload,expected_revision:r.revision}};body.querySelector('[data-preview]').textContent=JSON.stringify(r.rules,null,2);apply.disabled=false;}};
    apply.onclick=async()=>{if(!pending)return;if(nativeCore){try{assertNativeSaved();}catch(e){body.closest('.hs-services-surface').querySelector('[data-message]').textContent=e.message;return;}}const r=await action(apply,()=>request(`/api/hs-services/cores/${pending.core}/warp`,{...pending.payload,apply:true,restart_nodes:body.querySelector('[data-restart]').checked}));if(r){pending=null;apply.disabled=true;form.elements.profile.value='';if(nativeCore)location.reload();}};
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
  let nativeKey='',nativeBusy=false,nativeState=null;
  function nativeContext(){
    const match=location.pathname.match(/\/nodes\/cores\/(\d+)\/?$/);if(!match)return null;
    const tabs=[...document.querySelectorAll('[role=tablist]')].find(t=>t.querySelector('.lucide-arrow-up-from-line'));
    const selected=tabs?.querySelector('[role=tab][aria-selected=true]');
    const section=selected?.querySelector('.lucide-arrow-up-from-line')?'outbounds':selected?.querySelector('.lucide-arrow-down-to-line')?'inbounds':null;
    if(!section)return null;
    const container=tabs.nextElementSibling;if(!container)return null;
    return {core:Number(match[1]),section,container};
  }
  function assertNativeSaved(){
    const bar=document.querySelector('#restart-nodes')?.closest('.sticky');
    const save=bar?.querySelector('button:last-child');
    if(!save||!save.disabled)throw Error('Save or discard the native Core changes before applying HS changes.');
  }
  async function nativeTools(){
    const context=nativeContext();const key=context?context.core+':'+context.section:'';
    if(key===nativeKey&&document.getElementById('hs-core-tools'))return;
    document.getElementById('hs-core-tools')?.remove();nativeKey='';
    if(!context||nativeBusy)return;nativeBusy=true;
    try{
      nativeState=nativeState||await request('/api/hs-plugin/state');
      const feature=context.section==='outbounds'?'warp':'mtproxy';if(!nativeState.features?.[feature]?.enabled)return;
      if(nativeContext()?.core!==context.core||nativeContext()?.section!==context.section)return;
      const root=document.createElement('details');root.id='hs-core-tools';root.className='hs-services-surface rounded-sm border px-4';
      root.innerHTML=`<summary style="padding:12px 0;cursor:pointer;font-size:.85rem;font-weight:500">${context.section==='outbounds'?'WARP / WireGuard':'Telegram MTProxy'} <span class="hs-s-badge">HS</span></summary><p role="status" data-message></p><div data-body></div>`;
      context.container.prepend(root);nativeKey=key;
      root.addEventListener('toggle',async()=>{if(!root.open||root.dataset.loaded)return;root.dataset.loaded='1';try{
        if(context.section==='outbounds')await outbounds(root.querySelector('[data-body]'),context.core);
        else{const data=await request('/api/hs-services/inventory');data.targets=data.targets.filter(t=>Number(t.core_id)===context.core);mtproxy(root.querySelector('[data-body]'),data);}
      }catch(e){root.querySelector('[data-message]').textContent=e.message;delete root.dataset.loaded;}});
    }finally{nativeBusy=false;}
  }

  function maintain(){
    nativeTools().catch(()=>{});
    const nav=document.getElementById('hs-plugin-submenu');if(nav&&!nav.querySelector('[data-hs-service-nav]')){
      for(const section of ['certificates']){const li=document.createElement('li');const b=document.createElement('button');const reference=nav.querySelector('button');b.type='button';b.className=reference?.className||'';b.dataset.sidebar='menu-sub-button';b.dataset.hsServiceNav=section;b.textContent=sections[section];b.onclick=()=>route(section);li.appendChild(b);nav.appendChild(li);}
    }
    if(active&&!document.getElementById('hs-services-root')?.isConnected)close();
  }
  function boot(){installStyle();maintain();window.addEventListener('hs-plugin-feature-changed',()=>{nativeState=null;nativeKey='';document.getElementById('hs-core-tools')?.remove();maintain();});let queued=false;new MutationObserver(()=>{if(!queued){queued=true;requestAnimationFrame(()=>{queued=false;maintain();});}}).observe(document.body,{childList:true,subtree:true});
    document.addEventListener('click',e=>{if(active&&e.target.closest('a')&&!e.target.closest('#hs-services-root,#hs-plugin-nav'))close();},true);window.addEventListener('popstate',close);
  }
  window.HSServices={open,close,mountTabs,isActive:()=>!!active};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
