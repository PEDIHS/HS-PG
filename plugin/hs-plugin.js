(() => {
  'use strict';

  const VERSION = '0.1.0';
  const NAV_ID = 'hs-plugin-nav';
  const ROOT_ID = 'hs-plugin-root';
  const STYLE_ID = 'hs-plugin-style';
  const HOST_FIELD_ID = 'hs-host-usage-ratio';
  let state = null;
  let ownerAllowed = false;
  let ownerResolved = false;
  let active = false;
  let busy = false;
  let queued = false;

  const css = `
    @keyframes hsGoldSweep{0%{background-position:180% 50%}100%{background-position:-80% 50%}}
    .hs-gold{background:linear-gradient(105deg,#8f650f 0%,#d4a72c 30%,#fff0a8 46%,#d4a72c 62%,#8f650f 100%);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;color:transparent!important;animation:hsGoldSweep 3.8s linear infinite;filter:drop-shadow(0 0 4px rgba(212,167,44,.16))}
    @media(prefers-reduced-motion:reduce){.hs-gold{animation:none;background-position:50% 50%}}
    #${NAV_ID}{position:relative}
    #${NAV_ID} .hs-spark{width:.42rem;height:.42rem;border-radius:999px;background:#d4a72c;box-shadow:0 0 7px rgba(212,167,44,.55);flex:0 0 auto}
    #${ROOT_ID}{width:100%;padding:1rem 1rem 2rem;color:hsl(var(--foreground));font-family:inherit}
    #${ROOT_ID} *{box-sizing:border-box}
    #${ROOT_ID} .hs-hero{border:1px solid rgba(212,167,44,.23);border-radius:calc(var(--radius,.5rem) + .45rem);padding:1.05rem;background:linear-gradient(135deg,rgba(212,167,44,.08),hsl(var(--card)) 55%,rgba(212,167,44,.035));display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}
    #${ROOT_ID} .hs-title{font-size:1.1rem;font-weight:850;margin:0}.hs-sub{font-size:.72rem;color:hsl(var(--muted-foreground));margin-top:.2rem;line-height:1.65}
    #${ROOT_ID} .hs-version{font-size:.66rem;padding:.28rem .48rem;border:1px solid hsl(var(--border));border-radius:.45rem;color:hsl(var(--muted-foreground));background:hsl(var(--background)/.65)}
    #${ROOT_ID} .hs-card{margin-top:1rem;border:1px solid hsl(var(--border));border-radius:calc(var(--radius,.5rem) + .25rem);background:hsl(var(--card));padding:1rem}
    #${ROOT_ID} .hs-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:1rem;flex-wrap:wrap}.hs-card-title{font-size:.92rem;font-weight:800}.hs-note{font-size:.68rem;color:hsl(var(--muted-foreground));line-height:1.7;margin-top:.2rem}
    #${ROOT_ID} .hs-toggle{appearance:none;width:38px;height:21px;border-radius:999px;background:hsl(var(--input));border:1px solid hsl(var(--border));position:relative;cursor:pointer;transition:.18s;flex:0 0 auto}.hs-toggle:after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:999px;background:hsl(var(--foreground)/.65);transition:.18s}.hs-toggle:checked{background:#b8860b;border-color:#b8860b}.hs-toggle:checked:after{left:19px;background:white}
    #${ROOT_ID} .hs-hosts{display:grid;gap:.55rem;margin-top:.9rem}.hs-host{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) 110px auto;gap:.65rem;align-items:center;border:1px solid hsl(var(--border));border-radius:.7rem;padding:.7rem;background:hsl(var(--background)/.35)}
    #${ROOT_ID} .hs-host-name{font-size:.77rem;font-weight:750;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hs-inbound{font-size:.66rem;color:hsl(var(--muted-foreground));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr;text-align:left}
    #${ROOT_ID} input[type=number],#${HOST_FIELD_ID} input{width:100%;height:36px;border:1px solid hsl(var(--border));background:hsl(var(--background));color:hsl(var(--foreground));border-radius:var(--radius,.5rem);padding:0 .65rem;font:inherit;font-size:.78rem;outline:none}#${ROOT_ID} input[type=number]:focus,#${HOST_FIELD_ID} input:focus{border-color:rgba(184,134,11,.7);box-shadow:0 0 0 3px rgba(212,167,44,.09)}
    #${ROOT_ID} button.hs-btn{height:36px;border:1px solid rgba(184,134,11,.35);border-radius:var(--radius,.5rem);padding:0 .72rem;font:inherit;font-size:.72rem;font-weight:750;cursor:pointer;color:hsl(var(--foreground));background:linear-gradient(135deg,rgba(212,167,44,.13),rgba(184,134,11,.06))}.hs-btn:disabled{opacity:.5;cursor:wait}
    #${ROOT_ID} .hs-shared{display:inline-flex;margin-top:.2rem;font-size:.58rem;padding:.15rem .35rem;border-radius:999px;border:1px solid rgba(212,167,44,.25);color:#a8750a;background:rgba(212,167,44,.07)}
    #${ROOT_ID} .hs-status{margin-top:.75rem;font-size:.69rem;color:hsl(var(--muted-foreground));min-height:1.2em}.hs-status.ok{color:#16a34a}.hs-status.err{color:#dc2626}
    #${HOST_FIELD_ID}{margin-top:1rem}.hs-host-label{display:flex;align-items:center;gap:.45rem;margin-bottom:.45rem;font-size:.875rem;font-weight:500}.hs-host-badge{font-size:.55rem;line-height:1;padding:.18rem .34rem;border:1px solid rgba(212,167,44,.28);border-radius:999px;color:#a8750a;background:rgba(212,167,44,.07)}.hs-host-help{font-size:.66rem;line-height:1.55;color:hsl(var(--muted-foreground));margin-top:.35rem}
    @media(max-width:800px){#${ROOT_ID}{padding:.8rem .7rem 1.5rem}#${ROOT_ID} .hs-host{grid-template-columns:1fr 95px auto}#${ROOT_ID} .hs-inbound{grid-column:1/-1;grid-row:2}}
  `;

  function injectStyle(){if(document.getElementById(STYLE_ID))return;const s=document.createElement('style');s.id=STYLE_ID;s.textContent=css;document.head.appendChild(s)}
  function api(path, options={}){return fetch(`/api/hs-plugin${path}`,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(options.headers||{})},...options}).then(async r=>{const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.detail||`HTTP ${r.status}`);return data})}
  function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
  function setStatus(text, kind=''){const el=document.querySelector(`#${ROOT_ID} .hs-status`);if(el){el.textContent=text;el.className=`hs-status ${kind}`}}

  async function refreshState(){try{state=await api('/state');ownerAllowed=true;ownerResolved=true;return state}catch(e){ownerResolved=true;ownerAllowed=false;state=null;return null}}

  function findNodeTopItem(){
    const links=[...document.querySelectorAll('a')].filter(a=>{const h=a.getAttribute('href')||'';return h==='/nodes'||h==='#/nodes'||h.endsWith('#/nodes')});
    const link=links[0]; if(!link)return null;
    let li=link.closest('li');
    while(li?.parentElement?.closest('li')) li=li.parentElement.closest('li');
    return li;
  }

  function ensureNav(){
    if(!ownerAllowed){document.getElementById(NAV_ID)?.remove();return}
    if(document.getElementById(NAV_ID))return;
    const nodeItem=findNodeTopItem(); if(!nodeItem||!nodeItem.parentElement)return;
    const li=document.createElement('li');li.id=NAV_ID;li.className=nodeItem.className||'';
    const btn=document.createElement('button');btn.type='button';btn.className='peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-hidden transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground';
    btn.innerHTML='<span class="hs-spark"></span><span class="hs-gold" style="font-weight:750">HS Plugin</span>';
    btn.addEventListener('click',()=>activate());li.appendChild(btn);nodeItem.after(li);
  }

  function getMain(){return document.querySelector('main') || document.querySelector('[role="main"]')}
  function hideMain(main){[...main.children].forEach(el=>{if(el.id===ROOT_ID)return;if(!el.hasAttribute('data-hs-prev-display'))el.setAttribute('data-hs-prev-display',el.style.display||'');el.style.display='none'})}
  function restoreMain(main){[...main.querySelectorAll(':scope > [data-hs-prev-display]')].forEach(el=>{el.style.display=el.getAttribute('data-hs-prev-display')||'';el.removeAttribute('data-hs-prev-display')})}
  function deactivate(){active=false;const main=getMain();if(main)restoreMain(main);document.getElementById(ROOT_ID)?.remove()}

  function hostRows(){
    if(!state?.hosts?.length)return '<div class="hs-note">No hosts found.</div>';
    return state.hosts.map(h=>`<div class="hs-host" data-host-id="${h.id}"><div><div class="hs-host-name">${esc(h.remark||`Host #${h.id}`)}</div>${h.shared_inbound?'<span class="hs-shared">Shared inbound · same ratio applies</span>':''}</div><div class="hs-inbound">${esc(h.inbound_tag||'—')}</div><input class="hs-ratio" type="number" min="0" max="100" step="0.05" value="${Number(h.usage_ratio??1)}" ${!h.inbound_tag?'disabled':''}><button class="hs-btn hs-save-ratio" ${!h.inbound_tag?'disabled':''}>Save</button></div>`).join('')
  }

  function render(){
    const main=getMain();if(!main)return;hideMain(main);
    let root=document.getElementById(ROOT_ID);if(!root){root=document.createElement('section');root.id=ROOT_ID;main.appendChild(root)}
    const enabled=!!state?.features?.host_usage_ratio?.enabled;
    root.innerHTML=`<div class="hs-hero"><div><h2 class="hs-title hs-gold">HS Plugin</h2><div class="hs-sub">Update-safe extensions for PasarGuard · feature modules are isolated from the core.</div></div><span class="hs-version">v${VERSION}</span></div><div class="hs-card"><div class="hs-card-head"><div><div class="hs-card-title">Host Usage Ratio</div><div class="hs-note">Applies a traffic multiplier per Host/inbound before PasarGuard's native Node Usage Ratio. Hosts sharing one inbound must share the same ratio.</div></div><input id="hs-feature-host-ratio" class="hs-toggle" type="checkbox" ${enabled?'checked':''}></div><div class="hs-hosts">${hostRows()}</div><div class="hs-status"></div></div>`;
    root.querySelector('#hs-feature-host-ratio')?.addEventListener('change',async e=>{
      if(busy)return;busy=true;e.target.disabled=true;setStatus('Applying feature state and syncing nodes…');
      try{await api('/features/host_usage_ratio',{method:'PUT',body:JSON.stringify({enabled:e.target.checked})});await api('/resync',{method:'POST',body:'{}'});await refreshState();render()}catch(err){setStatus(err.message,'err');e.target.checked=!e.target.checked}finally{busy=false;e.target.disabled=false}
    });
    root.querySelectorAll('.hs-save-ratio').forEach(btn=>btn.addEventListener('click',async()=>{
      if(busy)return;const row=btn.closest('.hs-host');const input=row.querySelector('.hs-ratio');const hostId=Number(row.dataset.hostId);const ratio=Number(input.value);if(!Number.isFinite(ratio)||ratio<0||ratio>100){setStatus('Ratio must be between 0 and 100.','err');return}
      busy=true;btn.disabled=true;setStatus(`Saving Host #${hostId} and syncing nodes…`);
      try{await api(`/hosts/${hostId}/usage-ratio`,{method:'PUT',body:JSON.stringify({ratio})});await api('/resync',{method:'POST',body:'{}'});await refreshState();render()}catch(err){setStatus(err.message,'err')}finally{busy=false;btn.disabled=false}
    }));
  }

  async function activate(){active=true;if(!state)await refreshState();if(!ownerAllowed)return;render()}

  function matchEditingHost(dialog){
    if(!state?.hosts?.length)return null;
    const values=[...dialog.querySelectorAll('input')].map(i=>i.value).filter(Boolean);
    const candidates=state.hosts.filter(h=>values.includes(String(h.remark||'')));
    return candidates.length===1?candidates[0]:null;
  }

  function injectHostField(dialog){
    if(!ownerAllowed||!state?.features?.host_usage_ratio?.enabled||dialog.querySelector(`#${HOST_FIELD_ID}`))return;
    const form=dialog.querySelector('form');if(!form)return;
    const scroll=[...form.querySelectorAll('div')].find(el=>el.children.length>1 && /overflow-y-auto/.test(el.className||''));
    const container=scroll||form;const first=container.firstElementChild;if(!first)return;
    const editing=matchEditingHost(dialog);const ratio=Number(editing?.usage_ratio??1);
    const wrap=document.createElement('div');wrap.id=HOST_FIELD_ID;wrap.dataset.hostId=editing?.id||'';
    wrap.innerHTML=`<label class="hs-host-label"><span class="hs-gold">Usage Ratio</span><span class="hs-host-badge">HS</span></label><input type="number" min="0" max="100" step="0.05" value="${ratio}"><div class="hs-host-help">Traffic multiplier for this Host. Final usage = Host Ratio × native Node Ratio.</div>`;
    wrap.querySelector('input').addEventListener('input',()=>wrap.dataset.dirty='1');first.after(wrap);
  }

  function scanHostDialogs(){document.querySelectorAll('[role="dialog"]').forEach(injectHostField)}

  function installHostSaveBridge(){
    if(window.__hsPluginFetchBridge)return;window.__hsPluginFetchBridge=true;const nativeFetch=window.fetch.bind(window);
    window.fetch=async(input,init={})=>{
      const requestUrl=typeof input==='string'?input:(input?.url||'');const method=(init.method||(input?.method)||'GET').toUpperCase();
      const field=document.querySelector(`#${HOST_FIELD_ID}[data-dirty="1"]`);const pending=field?{ratio:Number(field.querySelector('input')?.value),hostId:Number(field.dataset.hostId||0)}:null;
      const response=await nativeFetch(input,init);
      if(response.ok && pending && Number.isFinite(pending.ratio) && ((method==='POST'&&/\/api\/host\/?(?:\?|$)/.test(requestUrl))||(method==='PUT'&&/\/api\/host\/\d+/.test(requestUrl)))){
        try{const payload=await response.clone().json();const hostId=Number(payload?.id||pending.hostId);if(hostId){await nativeFetch(`/api/hs-plugin/hosts/${hostId}/usage-ratio`,{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({ratio:pending.ratio})});await nativeFetch('/api/hs-plugin/resync',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}'});field.dataset.dirty='0';refreshState().catch(()=>{})}}catch(_){}}
      return response;
    };
  }

  function maintain(){queued=false;injectStyle();ensureNav();scanHostDialogs();if(active&&!document.getElementById(ROOT_ID))render()}
  function queueMaintain(){if(queued)return;queued=true;requestAnimationFrame(maintain)}

  async function boot(){injectStyle();installHostSaveBridge();await refreshState();maintain();new MutationObserver(queueMaintain).observe(document.documentElement,{childList:true,subtree:true});document.addEventListener('click',e=>{if(active&&!e.target.closest(`#${NAV_ID}`)&&e.target.closest('a'))deactivate()},true);setInterval(()=>{if(ownerAllowed)refreshState().then(queueMaintain)},60000)}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
