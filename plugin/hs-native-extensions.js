(() => {
  'use strict';

  const STYLE_ID='hs-native-ext-style';
  const FAIR_ID='hs-host-fair-use';
  const OUTBOUND_ID='hs-native-outbounds';
  const CERT_SUMMARY_ID='hs-cert-summary';
  const rawFetch=window.fetch.bind(window);
  let fairSnapshot=null;
  let limitedUsers=new Map();
  let pollTimer=null;

  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const tokenHeaders=()=>{const h=new Headers({'Content-Type':'application/json'});const t=localStorage.getItem('token');if(t)h.set('Authorization','Bearer '+t);return h;};
  async function api(path,options={}){
    const res=await rawFetch(path,{credentials:'same-origin',headers:tokenHeaders(),...options});
    const data=await res.json().catch(()=>({}));
    if(!res.ok)throw Error(typeof data.detail==='string'?data.detail:`HTTP ${res.status}`);
    return data;
  }

  function style(){
    if(document.getElementById(STYLE_ID))return;
    const node=document.createElement('style');node.id=STYLE_ID;node.textContent=`
      .hs-native-badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;border:1px solid rgba(217,179,76,.42);background:rgba(217,179,76,.08);color:#c69d2f;font-size:10px;font-weight:760;letter-spacing:.04em}
      .hs-native-card{border:1px solid hsl(var(--border));border-radius:12px;background:hsl(var(--card));padding:14px}
      .hs-native-title{display:flex;align-items:center;gap:7px;font-size:.84rem;font-weight:650}
      .hs-native-help{font-size:.72rem;line-height:1.55;color:hsl(var(--muted-foreground));margin-top:4px}
      .hs-native-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:12px}
      .hs-native-field{display:grid;gap:5px;font-size:.72rem;color:hsl(var(--muted-foreground))}
      .hs-native-field input,.hs-native-field select,.hs-native-field textarea{width:100%;border:1px solid hsl(var(--border));border-radius:8px;background:hsl(var(--background));color:hsl(var(--foreground));padding:8px 9px;font:inherit}
      .hs-native-field textarea{min-height:78px;resize:vertical}
      .hs-native-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}
      .hs-native-button{border:1px solid hsl(var(--border));border-radius:8px;background:hsl(var(--background));color:hsl(var(--foreground));padding:7px 10px;font-size:.72rem;cursor:pointer}
      .hs-native-button:hover{background:hsl(var(--accent))}.hs-native-button:disabled{opacity:.45;cursor:not-allowed}
      .hs-native-switch{position:relative;width:36px;height:20px;border-radius:999px;border:1px solid hsl(var(--border));background:hsl(var(--muted));cursor:pointer;padding:0}
      .hs-native-switch:before{content:'';position:absolute;width:14px;height:14px;border-radius:50%;top:2px;left:2px;background:hsl(var(--background));box-shadow:0 1px 3px rgba(0,0,0,.18);transition:transform .16s}
      .hs-native-switch[aria-checked=true]{background:#c8a23f;border-color:#c8a23f}.hs-native-switch[aria-checked=true]:before{transform:translateX(16px)}
      .hs-fair-state{display:inline-flex;align-items:center;gap:5px;border:1px solid rgba(249,115,22,.32);background:rgba(249,115,22,.09);color:#f97316;border-radius:999px;padding:2px 7px;font-size:10px;font-weight:700}
      .hs-fair-state:before{content:'';width:6px;height:6px;border-radius:50%;background:#f97316;box-shadow:0 0 7px rgba(249,115,22,.45)}
      #${OUTBOUND_ID}{margin-top:14px}.hs-outbound-tabs{display:flex;gap:4px;padding:3px;width:max-content;border-radius:9px;border:1px solid hsl(var(--border));background:hsl(var(--muted)/.35)}
      .hs-outbound-tabs button{border:0;background:transparent;padding:6px 9px;border-radius:7px;font-size:.7rem;color:hsl(var(--muted-foreground));cursor:pointer}.hs-outbound-tabs button[data-active=true]{background:hsl(var(--background));color:hsl(var(--foreground));box-shadow:0 1px 2px rgba(0,0,0,.08)}
      .hs-outbound-row{display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid hsl(var(--border));padding:8px 0;font-size:.71rem}.hs-outbound-row:first-child{border-top:0}
      #${CERT_SUMMARY_ID}{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:12px}.hs-cert-stat{border:1px solid hsl(var(--border));border-radius:12px;background:hsl(var(--card));padding:11px}.hs-cert-stat span{display:block;font-size:.65rem;color:hsl(var(--muted-foreground))}.hs-cert-stat b{display:block;margin-top:3px;font-size:1rem}
      #hs-services-root .hs-s-card{box-shadow:none!important;border-radius:12px!important;padding:14px!important}#hs-services-root .hs-s-card h3{font-size:.82rem!important}#hs-services-root .hs-s-meter{height:4px!important}
      #hs-services-root [data-services-features]>.bg-card{border-radius:12px!important;padding:12px 14px!important;min-height:66px}#hs-services-root [data-services-features] button[role=switch]{width:36px!important;height:20px!important;padding:0!important;font-size:0!important;border-radius:999px!important;position:relative!important;background:hsl(var(--muted))!important;border:1px solid hsl(var(--border))!important}#hs-services-root [data-services-features] button[role=switch]:before{content:'';position:absolute;width:14px;height:14px;border-radius:50%;top:2px;left:2px;background:hsl(var(--background));transition:.16s}#hs-services-root [data-services-features] button[role=switch][aria-checked=true]{background:#c8a23f!important;border-color:#c8a23f!important}#hs-services-root [data-services-features] button[role=switch][aria-checked=true]:before{transform:translateX(16px)}
      @media(max-width:760px){.hs-native-grid{grid-template-columns:1fr}#${CERT_SUMMARY_ID}{grid-template-columns:1fr 1fr}}
    `;document.head.appendChild(node);
  }

  function findEditingHost(dialog){
    const remark=dialog.querySelector('input[name="remark"]')?.value;
    const hosts=window.HSPluginDebug?.getState?.()?.hosts||[];
    if(!remark)return null;
    const matches=hosts.filter(h=>String(h.remark||'')===remark);
    return matches.length===1?matches[0]:null;
  }

  async function refreshFair(){
    try{fairSnapshot=await api('/api/hs-ext/fair-use/hosts');}
    catch(_){fairSnapshot=null;}
  }

  function fairByHost(id){return fairSnapshot?.hosts?.find(h=>Number(h.id)===Number(id))||null;}

  function injectFair(dialog){
    if(dialog.querySelector('#'+FAIR_ID))return;
    const form=dialog.querySelector('form');
    if(!form||!form.querySelector('input[name="remark"]'))return;
    const usage=document.getElementById('hs-host-usage-ratio');
    const editing=findEditingHost(dialog);
    const item=editing?fairByHost(editing.id):null;
    const p=item?.policy||{};
    const enabled=!!item?.enabled;
    const wrap=document.createElement('section');wrap.id=FAIR_ID;wrap.className='hs-native-card';wrap.dataset.hostId=editing?.id||'';wrap.dataset.dirty='0';wrap.dataset.enabled=String(enabled);
    wrap.innerHTML=`
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center">
        <div><div class="hs-native-title"><span>Fair Use</span><span class="hs-native-badge">HS</span></div><div class="hs-native-help">Per-user traffic policy. After this user reaches the threshold, only Fair Use Hosts remain visible and this Host is rate-limited for that user.</div></div>
        <button type="button" class="hs-native-switch" role="switch" aria-label="Fair Use" aria-checked="${enabled}"></button>
      </div>
      <div class="hs-native-grid" data-fields style="${enabled?'':'display:none'}">
        <label class="hs-native-field"><span>Traffic threshold · GB</span><input name="hsFairThreshold" type="number" min="1" step="1" value="${p.threshold_bytes?Math.round(p.threshold_bytes/1e9):100}"></label>
        <label class="hs-native-field"><span>Base bandwidth · Mbps</span><input name="hsFairBaseline" type="number" min="1" step="1" value="${p.baseline_mbps||100}"></label>
        <label class="hs-native-field"><span>Speed after threshold · %</span><input name="hsFairPercent" type="number" min="1" max="100" step="1" value="${p.speed_percent||20}"></label>
      </div>
      <div class="hs-native-actions" data-fair-note style="${enabled?'':'display:none'}"><span class="hs-fair-state">Fair limited eligible</span><span class="hs-native-help">Eligibility is automatic while a threshold is configured.</span></div>`;
    const sw=wrap.querySelector('[role=switch]');const fields=wrap.querySelector('[data-fields]');const note=wrap.querySelector('[data-fair-note]');
    sw.onclick=()=>{const next=sw.getAttribute('aria-checked')!=='true';sw.setAttribute('aria-checked',String(next));wrap.dataset.enabled=String(next);wrap.dataset.dirty='1';fields.style.display=next?'':'none';note.style.display=next?'':'none';};
    wrap.querySelectorAll('input').forEach(input=>input.addEventListener('input',()=>wrap.dataset.dirty='1'));
    if(usage?.parentElement===form||usage?.isConnected)usage.after(wrap);else{
      const target=[...form.querySelectorAll('div')].find(el=>/overflow-y-auto/.test(el.className||''))||form;
      target.appendChild(wrap);
    }
  }

  function fairPayload(field){
    const gb=Number(field.querySelector('[name=hsFairThreshold]')?.value);
    const baseline=Number(field.querySelector('[name=hsFairBaseline]')?.value);
    const percent=Number(field.querySelector('[name=hsFairPercent]')?.value);
    if(!Number.isFinite(gb)||gb<=0||!Number.isFinite(baseline)||baseline<=0||!Number.isFinite(percent)||percent<1||percent>100)throw Error('Invalid Fair Use values');
    return {threshold_bytes:Math.round(gb*1e9),baseline_mbps:baseline,speed_percent:percent};
  }

  function installHostBridge(){
    if(window.__hsFairHostBridge)return;window.__hsFairHostBridge=true;
    const previous=window.fetch.bind(window);
    window.fetch=async(input,init={})=>{
      const url=typeof input==='string'?input:(input?.url||'');const method=(init.method||(input?.method)||'GET').toUpperCase();
      const field=document.querySelector(`#${FAIR_ID}[data-dirty="1"]`);
      const pending=field?{hostId:Number(field.dataset.hostId||0),enabled:field.dataset.enabled==='true',payload:field.dataset.enabled==='true'?fairPayload(field):null}:null;
      const response=await previous(input,init);
      if(response.ok&&pending&&((method==='POST'&&/\/api\/host\/?(?:\?|$)/.test(url))||(method==='PUT'&&/\/api\/host\/\d+/.test(url)))){
        try{
          const data=await response.clone().json();const hostId=Number(data?.id||pending.hostId);
          if(hostId){
            if(pending.enabled)await api(`/api/hs-ext/fair-use/hosts/${hostId}`,{method:'PUT',body:JSON.stringify(pending.payload)});
            else await api(`/api/hs-ext/fair-use/hosts/${hostId}`,{method:'DELETE'});
            field.dataset.dirty='0';await refreshFair();
          }
        }catch(error){console.warn('[HS Fair Use] Host follow-up failed',error);}
      }
      return response;
    };
  }

  function removeStandaloneFair(){
    document.querySelectorAll('[data-service-tab="fair"]').forEach(el=>el.remove());
    document.querySelectorAll('button[aria-label="Fair Use"]').forEach(button=>{
      if(button.closest(`#${FAIR_ID}`))return;
      const row=button.closest('[data-services-features] > div')||button.parentElement;
      row?.remove();
    });
  }

  async function refreshLimited(){
    try{const data=await api('/api/hs-ext/fair-use/users');limitedUsers=new Map((data.users||[]).map(u=>[String(u.username),u]));enhanceUserStatuses();}
    catch(_){limitedUsers=new Map();}
  }

  function enhanceUserStatuses(){
    if(!limitedUsers.size)return;
    document.querySelectorAll('tr,[role=row],.rounded-lg.border').forEach(row=>{
      const text=(row.textContent||'').trim();
      const match=[...limitedUsers.keys()].find(username=>username&&text.includes(username));
      if(!match)return;
      if(row.querySelector('[data-hs-fair-status]'))return;
      const active=[...row.querySelectorAll('span,div')].find(el=>/^active$/i.test((el.textContent||'').trim())&&el.children.length===0);
      if(!active)return;
      const badge=document.createElement('span');badge.dataset.hsFairStatus='1';badge.className='hs-fair-state';badge.textContent='Fair limited';active.replaceWith(badge);
    });
  }

  function coreId(){const m=location.pathname.match(/\/nodes\/cores\/(\d+)/);return m?Number(m[1]):null;}
  function findOutboundsArea(){
    if(!coreId())return null;
    const candidates=[...document.querySelectorAll('h1,h2,h3,[role=heading],button')].filter(el=>/^outbounds$/i.test((el.textContent||'').trim()));
    for(const heading of candidates){
      const section=heading.closest('section,[data-slot=card],.space-y-4,.space-y-6')||heading.parentElement?.parentElement;
      if(section&&section.offsetParent!==null)return section;
    }
    return null;
  }

  function inboundChecks(inbounds){return (inbounds||[]).map(i=>`<label style="display:flex;gap:6px;align-items:center;font-size:.7rem"><input type="checkbox" name="inbound" value="${esc(i.tag)}"> <span>${esc(i.tag)}${i.protocol?' · '+esc(i.protocol):''}</span></label>`).join('')||'<span class="hs-native-help">No inbound detected in this Core.</span>';}

  async function injectOutbounds(){
    const area=findOutboundsArea();const id=coreId();if(!area||!id||area.querySelector('#'+OUTBOUND_ID))return;
    let data;try{data=await api(`/api/hs-ext/outbounds/${id}`);}catch(_){return;}
    if(data.type&&String(data.type).toLowerCase()!=='xray')return;
    const root=document.createElement('section');root.id=OUTBOUND_ID;root.className='hs-native-card';root.innerHTML=`
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px"><div><div class="hs-native-title">Upstream Outbounds <span class="hs-native-badge">HS</span></div><div class="hs-native-help">Add Proxy or WireGuard directly to this PasarGuard Core. Routing can follow selected inbound tags.</div></div><div class="hs-outbound-tabs"><button type="button" data-mode="proxy" data-active="true">Proxy</button><button type="button" data-mode="wireguard">WireGuard</button></div></div>
      <form data-form style="margin-top:10px"></form><div data-result class="hs-native-help"></div><div data-list style="margin-top:12px"></div>`;
    area.appendChild(root);
    let mode='proxy';
    const renderForm=()=>{
      const form=root.querySelector('[data-form]');
      form.innerHTML=mode==='proxy'?`
        <div class="hs-native-grid"><label class="hs-native-field"><span>Tag</span><input name="tag" value="hs-proxy-main" required></label><label class="hs-native-field"><span>Protocol</span><select name="protocol"><option value="socks">SOCKS</option><option value="http">HTTP</option></select></label><label class="hs-native-field"><span>Address</span><input name="address" placeholder="127.0.0.1" required></label><label class="hs-native-field"><span>Port</span><input name="port" type="number" min="1" max="65535" required></label><label class="hs-native-field"><span>Username · optional</span><input name="username"></label><label class="hs-native-field"><span>Password · optional</span><input name="password" type="password"></label></div><div class="hs-native-field" style="margin-top:10px"><span>Use for inbounds</span><div style="display:flex;gap:10px;flex-wrap:wrap">${inboundChecks(data.inbounds)}</div></div><div class="hs-native-actions"><button class="hs-native-button" type="submit">Add Proxy outbound</button></div>`:`
        <div class="hs-native-grid"><label class="hs-native-field"><span>Tag</span><input name="tag" value="hs-wg-main" required></label><label class="hs-native-field"><span>Private key</span><input name="private_key" required></label><label class="hs-native-field"><span>Interface address</span><input name="address" placeholder="172.16.0.2/32" required></label><label class="hs-native-field"><span>Peer public key</span><input name="peer_public_key" required></label><label class="hs-native-field"><span>Endpoint</span><input name="endpoint" placeholder="engage.cloudflareclient.com:2408" required></label><label class="hs-native-field"><span>MTU</span><input name="mtu" type="number" min="1280" max="1500" value="1280"></label><label class="hs-native-field"><span>Allowed IPs</span><input name="allowed_ips" value="0.0.0.0/0, ::/0"></label><label class="hs-native-field"><span>Reserved · optional</span><input name="reserved" placeholder="0,0,0"></label></div><div class="hs-native-field" style="margin-top:10px"><span>Use for inbounds</span><div style="display:flex;gap:10px;flex-wrap:wrap">${inboundChecks(data.inbounds)}</div></div><div class="hs-native-actions"><button class="hs-native-button" type="submit">Add WireGuard outbound</button></div>`;
      form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;const fd=new FormData(form);const inbound_tags=fd.getAll('inbound').map(String);let payload;
        try{
          if(mode==='proxy')payload={tag:String(fd.get('tag')),protocol:String(fd.get('protocol')),address:String(fd.get('address')),port:Number(fd.get('port')),username:String(fd.get('username')||'')||null,password:String(fd.get('password')||'')||null,inbound_tags};
          else payload={tag:String(fd.get('tag')),private_key:String(fd.get('private_key')),address:String(fd.get('address')).split(',').map(x=>x.trim()).filter(Boolean),peer_public_key:String(fd.get('peer_public_key')),endpoint:String(fd.get('endpoint')),allowed_ips:String(fd.get('allowed_ips')).split(',').map(x=>x.trim()).filter(Boolean),reserved:String(fd.get('reserved')||'').trim()?String(fd.get('reserved')).split(',').map(Number):null,mtu:Number(fd.get('mtu')),inbound_tags};
          await api(`/api/hs-ext/outbounds/${id}/${mode==='proxy'?'proxy':'wireguard'}`,{method:'POST',body:JSON.stringify(payload)});root.querySelector('[data-result]').textContent='Saved to PasarGuard Core.';root.remove();setTimeout(injectOutbounds,100);
        }catch(error){root.querySelector('[data-result]').textContent=error.message;}finally{if(button.isConnected)button.disabled=false;}
      };
    };
    root.querySelectorAll('[data-mode]').forEach(button=>button.onclick=()=>{mode=button.dataset.mode;root.querySelectorAll('[data-mode]').forEach(b=>b.dataset.active=String(b===button));renderForm();});
    const list=root.querySelector('[data-list]');list.innerHTML='<div class="hs-native-title" style="font-size:.75rem">Current outbounds</div>'+((data.outbounds||[]).filter(o=>!String(o.tag||'').startsWith('hs-fair-')).map(o=>`<div class="hs-outbound-row"><span><b>${esc(o.tag||'(default)')}</b> · ${esc(o.protocol||'unknown')}</span>${String(o.tag||'').startsWith('hs-')?`<button class="hs-native-button" data-remove="${esc(o.tag)}" type="button">Remove</button>`:''}</div>`).join('')||'<div class="hs-native-help">No outbounds.</div>');
    list.querySelectorAll('[data-remove]').forEach(button=>button.onclick=async()=>{button.disabled=true;try{await api(`/api/hs-ext/outbounds/${id}/${encodeURIComponent(button.dataset.remove)}`,{method:'DELETE'});root.remove();setTimeout(injectOutbounds,100);}catch(error){root.querySelector('[data-result]').textContent=error.message;button.disabled=false;}});
    renderForm();
  }

  function enhanceCertificates(){
    const root=document.getElementById('hs-services-root');if(!root||!/^Certificates$/i.test(root.querySelector('h2')?.textContent||'')||root.querySelector('#'+CERT_SUMMARY_ID))return;
    const body=root.querySelector('[data-body]');if(!body)return;const cards=[...body.querySelectorAll('.hs-s-card')];if(!cards.length)return;
    let healthy=0,expiring=0,expired=0,certbot=0;
    cards.forEach(card=>{const text=(card.textContent||'').toLowerCase();if(text.includes('certbot'))certbot++;const m=text.match(/(-?\d+)\s+days remaining/);if(m){const d=Number(m[1]);if(d<=0)expired++;else if(d<=30)expiring++;else healthy++;}else if(text.includes('expired'))expired++;});
    const summary=document.createElement('div');summary.id=CERT_SUMMARY_ID;summary.innerHTML=`<div class="hs-cert-stat"><span>Healthy</span><b>${healthy}</b></div><div class="hs-cert-stat"><span>Expiring ≤ 30d</span><b>${expiring}</b></div><div class="hs-cert-stat"><span>Expired</span><b>${expired}</b></div><div class="hs-cert-stat"><span>Certbot managed</span><b>${certbot}</b></div>`;body.prepend(summary);
  }

  function maintain(){
    style();removeStandaloneFair();
    document.querySelectorAll('[role="dialog"]').forEach(injectFair);
    enhanceUserStatuses();injectOutbounds();enhanceCertificates();
  }

  async function boot(){
    style();installHostBridge();await Promise.all([refreshFair(),refreshLimited()]);maintain();
    new MutationObserver(()=>requestAnimationFrame(maintain)).observe(document.documentElement,{subtree:true,childList:true});
    pollTimer=setInterval(()=>{if(document.hidden)return;refreshFair();refreshLimited();},30000);
    window.addEventListener('beforeunload',()=>clearInterval(pollTimer),{once:true});
  }

  window.HSNativeExtensions={refreshFair,refreshLimited,version:'0.3.0'};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
