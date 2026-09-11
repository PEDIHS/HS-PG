(() => {
  'use strict';

  const VERSION = '0.2.2';
  const ROOT_ID = 'hs-shield-root';
  const STYLE_ID = 'hs-shield-style';
  const TOP_TABS_ID = 'hs-shield-top-tabs';
  const rawFetch = window.fetch.bind(window);

  let active = false;
  let allowed = false;
  let pollTimer = null;
  let latest = null;
  let statusError = null;
  let section = 'overview';
  let refreshing = false;

  const shieldIcon = (className='') => `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 19 6v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6l7-3Z"/><path d="m9.5 12 1.7 1.7 3.5-4"/></svg>`;
  const slidersIcon = (className='') => `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>`;

  const css = `
    @keyframes hsShieldPulse{0%,100%{transform:scale(.98);opacity:.72}50%{transform:scale(1.035);opacity:1}}
    @keyframes hsShieldSweep{0%{transform:translateX(-130%) rotate(18deg)}100%{transform:translateX(340%) rotate(18deg)}}
    @keyframes hsShieldFlow{0%{background-position:0 50%}100%{background-position:200% 50%}}
    #${ROOT_ID}{width:100%;color:hsl(var(--foreground));font-family:inherit}
    #${ROOT_ID} *{box-sizing:border-box}
    #${ROOT_ID} .hs-wrap{padding:1rem;display:flex;flex-direction:column;gap:1rem}
    #${TOP_TABS_ID}{display:flex;align-items:center;gap:.35rem;width:max-content;max-width:100%;padding:.22rem;border:1px solid hsl(var(--border));border-radius:10px;background:hsl(var(--muted)/.35)}
    #${TOP_TABS_ID} button{display:inline-flex;align-items:center;gap:.4rem;border:0;background:transparent;color:hsl(var(--muted-foreground));font:inherit;font-size:.75rem;padding:.42rem .7rem;border-radius:8px;cursor:pointer;transition:background-color .18s,color .18s,box-shadow .18s}
    #${TOP_TABS_ID} button:hover{color:hsl(var(--foreground));background:hsl(var(--background)/.72)}
    #${TOP_TABS_ID} button.hs-active{background:hsl(var(--background));color:hsl(var(--foreground));box-shadow:0 1px 2px rgba(0,0,0,.08)}
    #${TOP_TABS_ID} svg{width:14px;height:14px;color:#d9b34c}
    #${ROOT_ID} .hs-hero{position:relative;overflow:hidden;border:1px solid rgba(217,179,76,.22);border-radius:18px;background:linear-gradient(135deg,rgba(18,24,20,.96),rgba(17,31,27,.92));padding:1.1rem;color:#f8fafc;box-shadow:0 12px 38px rgba(0,0,0,.16)}
    #${ROOT_ID} .hs-hero:before{content:'';position:absolute;inset:-80% auto -80% -25%;width:22%;background:linear-gradient(90deg,transparent,rgba(255,238,170,.08),transparent);animation:hsShieldSweep 7s linear infinite;pointer-events:none}
    #${ROOT_ID} .hs-hero-grid{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1rem;align-items:center}
    #${ROOT_ID} .hs-kicker{font-size:.7rem;letter-spacing:.16em;text-transform:uppercase;color:#d9b34c;font-weight:700}
    #${ROOT_ID} h2{margin:.25rem 0 .25rem;font-size:1.35rem;line-height:1.2;font-weight:760;letter-spacing:-.02em}
    #${ROOT_ID} .hs-muted{color:rgba(226,232,240,.68);font-size:.78rem;line-height:1.5}
    #${ROOT_ID} .hs-orb{width:78px;height:78px;border-radius:24px;display:grid;place-items:center;position:relative;background:radial-gradient(circle at 50% 42%,rgba(34,197,94,.24),rgba(8,25,20,.72) 60%,rgba(5,15,12,.92));border:1px solid rgba(217,179,76,.3);box-shadow:inset 0 0 24px rgba(34,197,94,.08),0 0 28px rgba(34,197,94,.09);animation:hsShieldPulse 3.2s ease-in-out infinite}
    #${ROOT_ID} .hs-orb svg{width:34px;height:34px;color:#e8ca6a;filter:drop-shadow(0 0 8px rgba(232,202,106,.25))}
    #${ROOT_ID} .hs-chip-row{display:flex;flex-wrap:wrap;gap:.45rem;margin-top:.85rem}
    #${ROOT_ID} .hs-chip{display:inline-flex;align-items:center;gap:.35rem;padding:.3rem .52rem;border-radius:999px;font-size:.68rem;border:1px solid rgba(148,163,184,.18);background:rgba(15,23,42,.3);color:#dbe4ee}
    #${ROOT_ID} .hs-chip strong{font-weight:700;color:#fff}
    #${ROOT_ID} .hs-stagebar{display:grid;grid-template-columns:repeat(5,1fr);gap:.4rem}
    #${ROOT_ID} .hs-stage{position:relative;padding:.65rem .6rem;border-radius:12px;border:1px solid hsl(var(--border));background:hsl(var(--card));font-size:.68rem;color:hsl(var(--muted-foreground));overflow:hidden}
    #${ROOT_ID} .hs-stage b{display:block;color:hsl(var(--foreground));font-size:.74rem;margin-top:.15rem}
    #${ROOT_ID} .hs-stage.active{border-color:rgba(217,179,76,.42);box-shadow:0 0 0 1px rgba(217,179,76,.08)}
    #${ROOT_ID} .hs-stage.active:after{content:'';position:absolute;inset:auto 0 0;height:2px;background:linear-gradient(90deg,#8f650f,#f2d77d,#8f650f);background-size:200% 100%;animation:hsShieldFlow 2.4s linear infinite}
    #${ROOT_ID} .hs-stage.attack{border-color:rgba(239,68,68,.5);background:rgba(127,29,29,.08)}
    #${ROOT_ID} .hs-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.75rem}
    #${ROOT_ID} .hs-card{border:1px solid hsl(var(--border));border-radius:14px;background:hsl(var(--card));padding:.9rem;min-height:104px}
    #${ROOT_ID} .hs-label{font-size:.68rem;color:hsl(var(--muted-foreground));margin-bottom:.35rem}
    #${ROOT_ID} .hs-value{font-size:1.18rem;font-weight:750;letter-spacing:-.02em}
    #${ROOT_ID} .hs-sub{font-size:.67rem;color:hsl(var(--muted-foreground));margin-top:.25rem;line-height:1.4}
    #${ROOT_ID} .hs-section{border:1px solid hsl(var(--border));border-radius:16px;background:hsl(var(--card));overflow:hidden}
    #${ROOT_ID} .hs-section-head{display:flex;align-items:center;justify-content:space-between;gap:.8rem;padding:.85rem 1rem;border-bottom:1px solid hsl(var(--border))}
    #${ROOT_ID} .hs-section-head h3{font-size:.83rem;font-weight:700;margin:0}
    #${ROOT_ID} .hs-pill{font-size:.64rem;padding:.23rem .45rem;border-radius:999px;border:1px solid hsl(var(--border));color:hsl(var(--muted-foreground))}
    #${ROOT_ID} .hs-layers{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0}
    #${ROOT_ID} .hs-layer{padding:.85rem;border-right:1px solid hsl(var(--border));min-height:88px}
    #${ROOT_ID} .hs-layer:last-child{border-right:0}
    #${ROOT_ID} .hs-layer-name{font-size:.7rem;font-weight:650;margin-bottom:.35rem;text-transform:capitalize}
    #${ROOT_ID} .hs-layer-state{display:inline-flex;align-items:center;gap:.35rem;font-size:.67rem;color:hsl(var(--muted-foreground))}
    #${ROOT_ID} .hs-dot{width:7px;height:7px;border-radius:999px;background:#64748b}
    #${ROOT_ID} .hs-dot.on{background:#22c55e;box-shadow:0 0 7px rgba(34,197,94,.45)}
    #${ROOT_ID} .hs-main{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(280px,.75fr);gap:.75rem}
    #${ROOT_ID} .hs-event{display:grid;grid-template-columns:72px 9px 1fr;gap:.55rem;padding:.7rem 1rem;border-bottom:1px solid hsl(var(--border));align-items:start}
    #${ROOT_ID} .hs-event:last-child{border-bottom:0}
    #${ROOT_ID} .hs-event-time{font-size:.64rem;color:hsl(var(--muted-foreground));font-variant-numeric:tabular-nums}
    #${ROOT_ID} .hs-event-dot{width:8px;height:8px;border-radius:999px;margin-top:.18rem;background:#64748b}
    #${ROOT_ID} .hs-event-dot.stage{background:#d9b34c}
    #${ROOT_ID} .hs-event-dot.agent{background:#22c55e}
    #${ROOT_ID} .hs-event-title{font-size:.7rem;line-height:1.45}
    #${ROOT_ID} .hs-side{padding:.9rem 1rem}
    #${ROOT_ID} .hs-safe{padding:.75rem;border-radius:12px;background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.16);font-size:.69rem;line-height:1.5}
    #${ROOT_ID} .hs-safe strong{display:block;margin-bottom:.2rem;color:hsl(var(--foreground))}
    #${ROOT_ID} .hs-row{display:flex;align-items:center;justify-content:space-between;gap:.7rem;padding:.55rem 0;border-bottom:1px dashed hsl(var(--border));font-size:.69rem}
    #${ROOT_ID} .hs-row:last-child{border-bottom:0}
    #${ROOT_ID} .hs-row span:first-child{color:hsl(var(--muted-foreground))}
    #${ROOT_ID} .hs-good{color:#22c55e}
    #${ROOT_ID} .hs-warn{color:#f59e0b}
    #${ROOT_ID} .hs-bad{color:#ef4444}
    #${ROOT_ID} input,#${ROOT_ID} select{font:inherit;padding:8px;border:1px solid hsl(var(--border));border-radius:8px;background:hsl(var(--background));color:hsl(var(--foreground))}
    #${ROOT_ID} button:focus-visible{outline:2px solid #d9b34c;outline-offset:2px}
    #${ROOT_ID} .hs-refresh{border:1px solid hsl(var(--border));background:hsl(var(--background));color:hsl(var(--foreground));border-radius:9px;padding:.35rem .6rem;font-size:.67rem;cursor:pointer}
    #${ROOT_ID} .hs-empty{padding:1rem;color:hsl(var(--muted-foreground));font-size:.7rem}
    @media(max-width:1100px){#${ROOT_ID} .hs-grid{grid-template-columns:repeat(2,1fr)}#${ROOT_ID} .hs-layers{grid-template-columns:repeat(3,1fr)}#${ROOT_ID} .hs-main{grid-template-columns:1fr}}
    @media(max-width:640px){#${ROOT_ID} .hs-wrap{padding:.75rem}#${ROOT_ID} .hs-hero-grid{grid-template-columns:1fr}#${ROOT_ID} .hs-orb{width:62px;height:62px;border-radius:20px}#${ROOT_ID} .hs-stagebar{grid-template-columns:1fr 1fr}#${ROOT_ID} .hs-grid{grid-template-columns:1fr 1fr}#${ROOT_ID} .hs-layers{grid-template-columns:1fr 1fr}#${ROOT_ID} .hs-event{grid-template-columns:58px 8px 1fr;padding:.65rem .75rem}}
    @media(prefers-reduced-motion:reduce){#${ROOT_ID} .hs-orb,#${ROOT_ID} .hs-hero:before,#${ROOT_ID} .hs-stage.active:after{animation:none}}
  `;

  function injectStyle(){
    if(document.getElementById(STYLE_ID))return;
    const style=document.createElement('style');
    style.id=STYLE_ID;
    style.textContent=css;
    document.head.appendChild(style);
  }

  function authHeaders(){
    const headers=new Headers({'Content-Type':'application/json'});
    const token=localStorage.getItem('token');
    if(token)headers.set('Authorization',`Bearer ${token}`);
    return headers;
  }

  async function probeOwner(){
    try{
      const response=await rawFetch('/api/hs-plugin/state',{credentials:'same-origin',headers:authHeaders()});
      allowed=response.ok;
      return allowed;
    }catch(_error){
      allowed=false;
      return false;
    }
  }

  async function shieldApi(){
    const response=await rawFetch('/api/hs-shield/status',{credentials:'same-origin',headers:authHeaders()});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){
      const error=new Error(data.detail||`HTTP ${response.status}`);
      error.status=response.status;
      throw error;
    }
    return data;
  }

  function placeholderData(message='Telemetry backend pending activation'){
    return {
      status:{
        stage:'starting',
        updated_at:null,
        metrics:{pps:0,mbps:0,syn_recv:0,established:0},
        baseline:{pps:0},
        layers:{},
        layers_ready:0,
        layers_total:5,
        origin:{state:'unknown',public_bindings:[]},
        stage_reasons:[message],
        api_pending:true
      },
      events:[]
    };
  }

  function getOutletHost(){
    const fromPlugin=window.HSPluginDebug?.getOutletHost?.();
    if(fromPlugin)return fromPlugin;

    const inset=document.querySelector('main.dashboard-scroll')||document.querySelector('.dashboard-scroll');
    if(!inset)return null;
    const shell=[...inset.children].find(el=>el.tagName==='DIV'&&el.classList.contains('justify-between'))||[...inset.querySelectorAll(':scope > div')].find(el=>el.classList.contains('justify-between'))||null;
    if(!shell)return null;
    return [...shell.children].find(el=>el.tagName==='DIV'&&el.classList.contains('flex-1')&&!el.classList.contains('justify-between'))||[...shell.children].find(el=>el.tagName==='DIV')||null;
  }

  function hideOutlet(outlet){
    [...outlet.children].forEach(el=>{
      if(el.id===ROOT_ID)return;
      if(!el.hasAttribute('data-hs-shield-display'))el.setAttribute('data-hs-shield-display',el.style.display||'');
      el.style.display='none';
    });
  }

  function restoreOutlet(outlet){
    [...outlet.children].forEach(el=>{
      if(!el.hasAttribute('data-hs-shield-display'))return;
      el.style.display=el.getAttribute('data-hs-shield-display')||'';
      el.removeAttribute('data-hs-shield-display');
    });
  }

  function suppressNativeActive(){
    document.querySelectorAll('[data-sidebar="menu-button"][data-active="true"],[data-sidebar="menu-sub-button"][data-active="true"]').forEach(button=>{
      if(button.closest('#hs-plugin-nav'))return;
      if(!button.hasAttribute('data-hs-shield-prev'))button.setAttribute('data-hs-shield-prev',button.dataset.active||'false');
      button.dataset.active='false';
    });
  }

  function restoreNativeActive(){
    document.querySelectorAll('[data-hs-shield-prev]').forEach(button=>{
      button.dataset.active=button.getAttribute('data-hs-shield-prev')||'false';
      button.removeAttribute('data-hs-shield-prev');
    });
  }

  function fmtRate(value){
    const n=Number(value)||0;
    if(n>=1e6)return `${(n/1e6).toFixed(1)}M`;
    if(n>=1e3)return `${(n/1e3).toFixed(1)}K`;
    return Math.round(n).toString();
  }

  function fmtTime(iso){
    if(!iso)return '--:--';
    const date=new Date(iso);
    if(Number.isNaN(date.getTime()))return '--:--';
    return date.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }

  function esc(value){
    return String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
  }

  function stageLabel(stage){
    return ({starting:'Starting',standby:'Standby',normal:'Normal',elevated:'Elevated',attack:'Attack',lockdown:'Lockdown'})[stage]||'Unknown';
  }

  function layerName(key){
    return ({cloudflare_tunnel:'Cloudflare Tunnel',haproxy:'HAProxy',nftables:'nftables',fastnetmon:'FastNetMon',hs_detector:'HS Detector'})[key]||key.replaceAll('_',' ');
  }

  function render(data){
    latest=data||placeholderData();
    const status=latest.status||{};
    const metrics=status.metrics||{};
    const layers=status.layers||{};
    const events=Array.isArray(latest.events)?latest.events:[];
    const stage=status.stage||'starting';
    const origin=status.origin||{};
    const outlet=getOutletHost();
    if(!outlet)return false;

    hideOutlet(outlet);
    let root=document.getElementById(ROOT_ID);
    if(root&&root.parentElement!==outlet)root.remove();
    root=document.getElementById(ROOT_ID);
    if(!root){
      root=document.createElement('section');
      root.id=ROOT_ID;
      root.className='flex min-h-0 w-full flex-1 flex-col';
      outlet.appendChild(root);
    }

    if(section!=='overview'){
      renderSection(root);
      return true;
    }
    delete root.dataset.editSection;
    const reason=(Array.isArray(status.stage_reasons)&&status.stage_reasons[0])||statusError||'Waiting for telemetry';
    const originClass=origin.state==='hidden'?'hs-good':origin.state==='public'?'hs-bad':'hs-warn';
    const stages=['standby','normal','elevated','attack','lockdown'];
    const pending=!!status.api_pending;

    root.innerHTML=`<div class="hs-wrap">
      <div id="${TOP_TABS_ID}">
        <button type="button" data-hs-shield-tab="features">${slidersIcon()}<span>Features</span></button>
        <button type="button" class="hs-active" data-hs-shield-tab="firewall">${shieldIcon()}<span>Firewall</span></button>
      </div>

      ${sectionTabs()}
      <section class="hs-hero">
        <div class="hs-hero-grid">
          <div>
            <div class="hs-kicker">HS Shield • v${VERSION}</div>
            <h2>Panel Firewall Control Plane</h2>
            <div class="hs-muted">Live traffic, explicit access rules and adaptive SYN protection.</div>
            <div class="hs-chip-row">
              <span class="hs-chip">Stage <strong>${esc(stageLabel(stage))}</strong></span>
              <span class="hs-chip">Mode <strong>${esc(status.mode||'observe')}</strong></span>
              <span class="hs-chip">Origin <strong>${esc(origin.state||'unknown')}</strong></span>
              <span class="hs-chip">Layers <strong>${Number(status.layers_ready)||0}/${Number(status.layers_total)||0}</strong></span>
              ${pending?'<span class="hs-chip">Backend <strong>Pending activation</strong></span>':''}
            </div>
          </div>
          <div class="hs-orb">${shieldIcon()}</div>
        </div>
      </section>

      <div class="hs-stagebar">${stages.map((item,index)=>`<div class="hs-stage ${item===stage?'active':''} ${stage==='attack'&&item===stage?'attack':''}"><span>0${index}</span><b>${stageLabel(item)}</b></div>`).join('')}</div>

      <div class="hs-grid">
        <div class="hs-card"><div class="hs-label">Host packet rate (RX + TX)</div><div class="hs-value">${fmtRate(metrics.pps)} <small style="font-size:.62em;font-weight:600">pps</small></div><div class="hs-sub">Adaptive baseline ${fmtRate(status.baseline?.pps||0)} pps</div></div>
        <div class="hs-card"><div class="hs-label">Network throughput</div><div class="hs-value">${Number(metrics.mbps||0).toFixed(1)} <small style="font-size:.62em;font-weight:600">Mbps</small></div><div class="hs-sub">Host interfaces; virtual interfaces may count forwarded traffic twice</div></div>
        <div class="hs-card"><div class="hs-label">TCP SYN-RECV</div><div class="hs-value">${Math.round(Number(metrics.syn_recv)||0)}</div><div class="hs-sub">Connection-flood pressure signal</div></div>
        <div class="hs-card"><div class="hs-label">Established TCP</div><div class="hs-value">${Math.round(Number(metrics.established)||0)}</div><div class="hs-sub">Current host connection pressure</div></div>
      </div>

      <section class="hs-section">
        <div class="hs-section-head"><h3>Protection layers</h3><span class="hs-pill">live health</span></div>
        <div class="hs-layers">${Object.keys(layers).length?Object.entries(layers).map(([key,value])=>`<div class="hs-layer"><div class="hs-layer-name">${esc(layerName(key))}</div><div class="hs-layer-state"><i class="hs-dot ${value?.active?'on':''}"></i>${value?.active?'Active':'Not active'}</div><div class="hs-sub">${esc(value?.role||'layer')}</div></div>`).join(''):'<div class="hs-empty">Waiting for layer discovery…</div>'}</div>
      </section>

      <div class="hs-main">
        <section class="hs-section">
          <div class="hs-section-head"><h3>Security timeline</h3><button class="hs-refresh" id="hs-shield-refresh">Refresh</button></div>
          ${events.length?events.slice(0,20).map(event=>`<div class="hs-event"><div class="hs-event-time">${esc(fmtTime(event.at))}</div><i class="hs-event-dot ${esc(event.kind||'')}"></i><div><div class="hs-event-title">${esc(event.message||event.kind||'Event')}</div><div class="hs-sub">Stage: ${esc(stageLabel(event.stage||'unknown'))}</div></div></div>`).join(''):'<div class="hs-empty">No security events recorded yet.</div>'}
        </section>
        <section class="hs-section">
          <div class="hs-section-head"><h3>Safety & exposure</h3><span class="hs-pill">fail-open</span></div>
          <div class="hs-side">
            <div class="hs-safe"><strong>${status.enforcement?.active?'Firewall rules are active':'Observe mode'}</strong>${pending?'Firewall UI is installed, but the read-only telemetry backend has not entered the running PasarGuard process yet.':esc(status.enforcement?.error||'HS manages its own host INPUT rules. Forwarded Docker traffic is outside this policy.')}</div>
            <div class="hs-row"><span>Current reason</span><b>${esc(reason)}</b></div>
            <div class="hs-row"><span>Origin exposure</span><b class="${originClass}">${esc(origin.state||'unknown')}</b></div>
            <div class="hs-row"><span>Public bindings</span><b>${Array.isArray(origin.public_bindings)?origin.public_bindings.length:0}</b></div>
            <div class="hs-row"><span>Traffic modified</span><b>${status.enforcement?.traffic_modified?'Yes':'No'}</b></div>
            <div class="hs-row"><span>Fail-open</span><b class="hs-good">Enabled</b></div>
            <div class="hs-row"><span>Last telemetry</span><b>${esc(fmtTime(status.updated_at))}</b></div>
          </div>
        </section>
      </div>
    </div>`;

    root.querySelector('.hs-wrap')?.insertAdjacentHTML('afterbegin', enforcementNotice(status));
    bindSections(root);
    window.HSServices?.mountTabs?.(root, 'firewall');
    root.querySelector('[data-hs-shield-tab="features"]')?.addEventListener('click',event=>{
      event.preventDefault();
      event.stopPropagation();
      close();
      window.HSPluginDebug?.open?.();
    });
    root.querySelector('#hs-shield-refresh')?.addEventListener('click',()=>refresh(true));
    return true;
  }

  async function refresh(force=false){
    try{
      latest=await shieldApi();
      allowed=true;
      statusError=null;
    }catch(error){
      statusError=error.message||'Shield telemetry unavailable';
      if(error.status===401||error.status===403){
        allowed=false;
        close();
        return;
      }
      if(!allowed)await probeOwner();
      if(allowed)latest=placeholderData(statusError);
    }

    if(active){
      if(!render(latest))console.warn('[HS Shield] render skipped because dashboard outlet was not available');
    }
  }

  function startPolling(){
    stopPolling();
    pollTimer=setInterval(()=>{if(!document.hidden&&!refreshing){refreshing=true;refresh(false).finally(()=>refreshing=false);}},3000);
  }

  function stopPolling(){
    if(pollTimer){
      clearInterval(pollTimer);
      pollTimer=null;
    }
  }

  function close(){
    if(!active){
      window.HSPluginDebug?.setSection?.(null);
      return;
    }
    active=false;
    stopPolling();
    const root=document.getElementById(ROOT_ID);
    const outlet=root?.parentElement||getOutletHost();
    if(outlet)restoreOutlet(outlet);
    root?.remove();
    restoreNativeActive();
    window.HSPluginDebug?.setSection?.(null);
  }

  async function show(){
    if(!allowed)await probeOwner();
    if(!allowed)return;

    const before=getOutletHost();
    if(!before){
      console.warn('[HS Shield] dashboard outlet is not ready; preserving current page');
      return;
    }

    if(!latest)await refresh(false);
    if(!latest)latest=placeholderData(statusError||undefined);

    window.HSServices?.close?.();
    window.HSPluginDebug?.close?.();
    const outlet=getOutletHost();
    if(!outlet){
      window.HSPluginDebug?.open?.();
      return;
    }

    active=true;
    suppressNativeActive();
    window.HSPluginDebug?.setSection?.('firewall');

    if(!render(latest)){
      active=false;
      restoreNativeActive();
      window.HSPluginDebug?.setSection?.(null);
      window.HSPluginDebug?.open?.();
      return;
    }

    startPolling();
  }

  function watchNavigation(){
    document.addEventListener('click',event=>{
      if(!active)return;
      const target=event.target instanceof Element?event.target.closest('a,[data-sidebar="menu-button"],[data-sidebar="menu-sub-button"]'):null;
      if(!target||target.closest('#hs-plugin-nav'))return;
      setTimeout(()=>{
        if(active)close();
      },0);
    },true);
  }


  function sectionTabs(){
    return `<nav aria-label="Firewall sections" style="display:flex;gap:8px;flex-wrap:wrap">${['overview','rules','events','settings'].map(name=>`<button class="hs-refresh" type="button" data-shield-section="${name}" aria-current="${section===name?'page':'false'}" style="${section===name?'border-color:#d9b34c;color:#b58a25':''}">${name[0].toUpperCase()+name.slice(1)}</button>`).join('')}</nav>`;
  }
  function enforcementNotice(status){
    const pending=status.enforcement?.pending;
    if(status.stale)return '<div class="hs-safe hs-bad" role="alert">Agent heartbeat is stale. Live protection status is unavailable.</div>';
    if(!pending)return status.enforcement?.error?`<div class="hs-safe hs-bad" role="alert">${esc(status.enforcement.error)}</div>`:'';
    return `<div class="hs-safe" role="alert">New policy is awaiting confirmation. Automatic rollback at ${esc(new Date(pending.deadline*1000).toLocaleTimeString())}. <button class="hs-refresh" data-shield-confirm="${esc(pending.token)}">Keep this policy</button></div>`;
  }
  async function writeShield(path,body){
    const res=await rawFetch('/api/hs-shield/'+path,{method:path==='confirm'?'POST':'PUT',headers:authHeaders(),body:JSON.stringify(body)});
    const data=await res.json();if(!res.ok)throw Error(typeof data.detail==='string'?data.detail:JSON.stringify(data.detail));
    await refresh(false);return data;
  }
  function bindSections(root){
    root.querySelectorAll('[data-shield-section]').forEach(button=>button.onclick=()=>{section=button.dataset.shieldSection;render(latest);});
    root.querySelector('[data-shield-confirm]')?.addEventListener('click',async event=>{
      const b=event.currentTarget;b.disabled=true;
      try{await writeShield('confirm',{token:b.dataset.shieldConfirm});}catch(e){b.textContent=e.message;b.disabled=false;}
    });
  }
  function renderSection(root){
    // Polling must not replace forms while the administrator is editing.
    if(root.dataset.editSection===section){
      const notice=root.querySelector('[data-notice]');if(notice){notice.innerHTML=enforcementNotice(latest?.status||{});bindSections(root);}
      return;
    }
    root.dataset.editSection=section;
    const config=latest?.config||{};const policy=config.policy||{management_ports:[22],rules:[],syn_ports:[],syn_rate:100};
    root.innerHTML=`<div class="hs-wrap"><div id="${TOP_TABS_ID}"><button data-features>Features</button><button class="hs-active">Firewall</button></div>${sectionTabs()}<div data-notice>${enforcementNotice(latest?.status||{})}</div><section class="hs-section"><div class="hs-section-head"><h3>${esc(section[0].toUpperCase()+section.slice(1))}</h3><span class="hs-pill">HS Shield</span></div><div class="hs-side" data-content></div></section><p data-result role="status"></p></div>`;
    const content=root.querySelector('[data-content]');
    const message=root.querySelector('[data-result]');
    const save=async(body)=>{try{await writeShield('config',body);message.textContent='Saved. The agent will apply the requested state.';}catch(e){message.textContent=e.message;}};
    if(section==='rules'){
      content.innerHTML=`<p class="hs-sub">Explicit allow rules take priority. Established connections and protected management ports remain reachable. Applies to host INPUT.</p><div data-rules></div><form data-add style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px"><select name="action" aria-label="Action"><option value="block">Block</option><option value="allow">Allow</option></select><input name="source" placeholder="IP or CIDR" aria-label="Source network" required><select name="protocol" aria-label="Protocol"><option value="any">Any protocol</option><option>tcp</option><option>udp</option></select><input name="port" type="number" min="1" max="65535" placeholder="Optional port" aria-label="Destination port"><button class="hs-refresh">Add rule</button></form><button class="hs-refresh" data-save style="margin-top:16px">Save rules</button>`;
      const rows=JSON.parse(JSON.stringify(policy.rules));
      const draw=()=>{const list=content.querySelector('[data-rules]');list.innerHTML=rows.map((r,i)=>`<div class="hs-row"><span>${esc(r.action)} · ${esc(r.source)} · ${esc(r.protocol)} ${esc(r.port||'')}</span><button class="hs-refresh" data-remove="${i}">Remove</button></div>`).join('')||'<p>No custom rules.</p>';list.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{rows.splice(Number(b.dataset.remove),1);draw();});};draw();
      content.querySelector('form').onsubmit=e=>{e.preventDefault();const f=new FormData(e.currentTarget);rows.push({id:Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join(''),action:f.get('action'),source:f.get('source'),protocol:f.get('protocol'),port:f.get('port')?Number(f.get('port')):null,enabled:true});draw();e.currentTarget.reset();};
      content.querySelector('[data-save]').onclick=()=>save({policy:{...policy,rules:rows}});
    }else if(section==='settings'){
      content.innerHTML=`<form style="display:grid;gap:14px;max-width:560px"><label>Mode <select name="mode"><option value="observe">Observe</option><option value="enforce">Enforce</option></select></label><label><input type="checkbox" name="enabled" ${config.enabled?'checked':''}> Enable firewall feature</label><label><input type="checkbox" name="auto" ${config.auto_stage?'checked':''}> Activate SYN protection on elevated / attack stages</label><label>Protected management TCP ports <input required name="management" value="${esc(policy.management_ports.join(','))}"></label><label>SYN protection TCP ports <input name="syn" value="${esc(policy.syn_ports.join(','))}"></label><label>SYN rate per source / second <input name="rate" type="number" min="10" max="100000" value="${policy.syn_rate}"></label><p class="hs-sub">An enforcement change must be confirmed within 45 seconds. Start in Observe to inspect traffic.</p><button class="hs-refresh">Apply settings</button></form>`;
      const form=content.querySelector('form');form.elements.mode.value=config.mode||'observe';
      form.onsubmit=e=>{e.preventDefault();const f=new FormData(form);const ports=name=>String(f.get(name)||'').split(',').map(v=>v.trim()).filter(Boolean).map(Number);save({enabled:f.has('enabled'),auto_stage:f.has('auto'),mode:f.get('mode'),policy:{...policy,management_ports:ports('management'),syn_ports:ports('syn'),syn_rate:Number(f.get('rate'))}});};
    }else{
      content.innerHTML=(latest?.events||[]).map(e=>`<div class="hs-row"><span>${esc(e.at)}</span><span>${esc(e.message)}</span></div>`).join('')||'<p>No events recorded.</p>';
    }
    bindSections(root);window.HSServices?.mountTabs?.(root,'firewall');
    root.querySelector('[data-features]')?.addEventListener('click',()=>window.HSPluginDebug?.open?.());
  }
  async function boot(){
    injectStyle();
    watchNavigation();
    window.addEventListener('hs-shield:activate',()=>show());
    await probeOwner();
    await refresh(false);
    document.addEventListener('visibilitychange',()=>{if(active&&!document.hidden)refresh(false);});
    console.info(`[HS Shield] ${VERSION} loaded`);
  }

  window.HSShieldDebug={
    version:VERSION,
    open:show,
    close,
    refresh:()=>refresh(true),
    getState:()=>latest,
    isActive:()=>active
  };

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();