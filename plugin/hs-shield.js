(() => {
  'use strict';

  const VERSION = '0.1.1';
  const NAV_ID = 'hs-shield-nav';
  const ROOT_ID = 'hs-shield-root';
  const STYLE_ID = 'hs-shield-style';
  const PLUGIN_TABBAR_ID = 'hs-shield-plugin-tabbar';
  const rawFetch = window.fetch.bind(window);

  let active = false;
  let allowed = false;
  let pollTimer = null;
  let navTimer = null;
  let latest = null;
  let statusError = null;

  const menuButtonClass = 'peer/menu-button relative flex h-8 w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none ring-sidebar-ring transition-[width,height,padding,background-color] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 group-has-[[data-sidebar=menu-action]]/menu-item:ltr:pr-8 group-has-[[data-sidebar=menu-action]]/menu-item:rtl:pl-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent/70 data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[active=true]:before:bg-primary data-[active=true]:before:absolute data-[active=true]:before:inset-y-1.5 data-[active=true]:before:start-0 data-[active=true]:before:w-0.5 data-[active=true]:before:rounded-full group-data-[collapsible=icon]:!size-8 group-data-[collapsible=icon]:!p-2 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0';

  const shieldIcon = (className='') => `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 19 6v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6l7-3Z"/><path d="m9.5 12 1.7 1.7 3.5-4"/></svg>`;

  const css = `
    @keyframes hsShieldPulse{0%,100%{transform:scale(.98);opacity:.72}50%{transform:scale(1.035);opacity:1}}
    @keyframes hsShieldSweep{0%{transform:translateX(-130%) rotate(18deg)}100%{transform:translateX(340%) rotate(18deg)}}
    @keyframes hsShieldFlow{0%{background-position:0 50%}100%{background-position:200% 50%}}
    @keyframes hsShieldBlink{0%,100%{opacity:.45}50%{opacity:1}}
    #${ROOT_ID}{width:100%;color:hsl(var(--foreground));font-family:inherit}
    #${ROOT_ID} *{box-sizing:border-box}
    .hs-shield-nav-icon{color:#d9b34c;filter:drop-shadow(0 0 4px rgba(217,179,76,.24))}
    .hs-shield-nav-dot{margin-inline-start:auto;width:6px;height:6px;border-radius:999px;background:#64748b;box-shadow:0 0 0 2px rgba(100,116,139,.12)}
    .hs-shield-nav-dot.ok{background:#22c55e;box-shadow:0 0 8px rgba(34,197,94,.6)}
    .hs-shield-nav-dot.warn{background:#f59e0b;box-shadow:0 0 8px rgba(245,158,11,.6)}
    .hs-shield-nav-dot.attack{background:#ef4444;box-shadow:0 0 10px rgba(239,68,68,.72);animation:hsShieldBlink 1s ease-in-out infinite}
    #${PLUGIN_TABBAR_ID}{display:flex;align-items:center;gap:.35rem;padding:.22rem;border:1px solid hsl(var(--border));border-radius:10px;background:hsl(var(--muted)/.35);width:max-content;max-width:100%}
    #${PLUGIN_TABBAR_ID} button{display:inline-flex;align-items:center;gap:.4rem;border:0;background:transparent;color:hsl(var(--muted-foreground));font:inherit;font-size:.75rem;padding:.42rem .7rem;border-radius:8px;cursor:pointer;transition:background-color .18s,color .18s,box-shadow .18s}
    #${PLUGIN_TABBAR_ID} button.hs-active{background:hsl(var(--background));color:hsl(var(--foreground));box-shadow:0 1px 2px rgba(0,0,0,.08)}
    #${PLUGIN_TABBAR_ID} button:hover{color:hsl(var(--foreground));background:hsl(var(--background)/.72)}
    #${PLUGIN_TABBAR_ID} svg{width:14px;height:14px;color:#d9b34c}
    #${PLUGIN_TABBAR_ID} .hs-inline-dot{width:6px;height:6px;border-radius:999px;background:#64748b;margin-left:.1rem}
    #${PLUGIN_TABBAR_ID} .hs-inline-dot.ok{background:#22c55e;box-shadow:0 0 7px rgba(34,197,94,.5)}
    #${PLUGIN_TABBAR_ID} .hs-inline-dot.warn{background:#f59e0b;box-shadow:0 0 7px rgba(245,158,11,.5)}
    #${PLUGIN_TABBAR_ID} .hs-inline-dot.attack{background:#ef4444;box-shadow:0 0 9px rgba(239,68,68,.65);animation:hsShieldBlink 1s ease-in-out infinite}
    #${ROOT_ID} .hs-wrap{padding:1rem;display:flex;flex-direction:column;gap:1rem}
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
    #${ROOT_ID} .hs-layer-name{font-size:.7rem;font-weight:650;margin-bottom:.35rem}
    #${ROOT_ID} .hs-layer-state{display:inline-flex;align-items:center;gap:.35rem;font-size:.67rem;color:hsl(var(--muted-foreground))}
    #${ROOT_ID} .hs-dot{width:7px;height:7px;border-radius:999px;background:#64748b}
    #${ROOT_ID} .hs-dot.on{background:#22c55e;box-shadow:0 0 7px rgba(34,197,94,.45)}
    #${ROOT_ID} .hs-main{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(280px,.75fr);gap:.75rem}
    #${ROOT_ID} .hs-event{display:grid;grid-template-columns:72px 9px 1fr;gap:.55rem;padding:.7rem 1rem;border-bottom:1px solid hsl(var(--border));align-items:start}
    #${ROOT_ID} .hs-event:last-child{border-bottom:0}
    #${ROOT_ID} .hs-event-time{font-size:.64rem;color:hsl(var(--muted-foreground));font-variant-numeric:tabular-nums}
    #${ROOT_ID} .hs-event-dot{width:8px;height:8px;border-radius:999px;margin-top:.18rem;background:#64748b}
    #${ROOT_ID} .hs-event-dot.stage{background:#d9b34c} #${ROOT_ID} .hs-event-dot.agent{background:#22c55e}
    #${ROOT_ID} .hs-event-title{font-size:.7rem;line-height:1.45}
    #${ROOT_ID} .hs-side{padding:.9rem 1rem}
    #${ROOT_ID} .hs-safe{padding:.75rem;border-radius:12px;background:rgba(34,197,94,.06);border:1px solid rgba(34,197,94,.16);font-size:.69rem;line-height:1.5}
    #${ROOT_ID} .hs-safe strong{display:block;margin-bottom:.2rem;color:hsl(var(--foreground))}
    #${ROOT_ID} .hs-row{display:flex;align-items:center;justify-content:space-between;gap:.7rem;padding:.55rem 0;border-bottom:1px dashed hsl(var(--border));font-size:.69rem}
    #${ROOT_ID} .hs-row:last-child{border-bottom:0}
    #${ROOT_ID} .hs-row span:first-child{color:hsl(var(--muted-foreground))}
    #${ROOT_ID} .hs-good{color:#22c55e} #${ROOT_ID} .hs-warn{color:#f59e0b} #${ROOT_ID} .hs-bad{color:#ef4444}
    #${ROOT_ID} .hs-refresh{border:1px solid hsl(var(--border));background:hsl(var(--background));color:hsl(var(--foreground));border-radius:9px;padding:.35rem .6rem;font-size:.67rem;cursor:pointer}
    #${ROOT_ID} .hs-empty{padding:1rem;color:hsl(var(--muted-foreground));font-size:.7rem}
    @media(max-width:1100px){#${ROOT_ID} .hs-grid{grid-template-columns:repeat(2,1fr)}#${ROOT_ID} .hs-layers{grid-template-columns:repeat(3,1fr)}#${ROOT_ID} .hs-main{grid-template-columns:1fr}}
    @media(max-width:640px){#${ROOT_ID} .hs-wrap{padding:.75rem}#${ROOT_ID} .hs-hero-grid{grid-template-columns:1fr}#${ROOT_ID} .hs-orb{width:62px;height:62px;border-radius:20px}#${ROOT_ID} .hs-stagebar{grid-template-columns:1fr 1fr}#${ROOT_ID} .hs-grid{grid-template-columns:1fr 1fr}#${ROOT_ID} .hs-layers{grid-template-columns:1fr 1fr}#${ROOT_ID} .hs-event{grid-template-columns:58px 8px 1fr;padding:.65rem .75rem}}
    @media(prefers-reduced-motion:reduce){#${ROOT_ID} .hs-orb,#${ROOT_ID} .hs-hero:before,#${ROOT_ID} .hs-stage.active:after,.hs-shield-nav-dot.attack,#${PLUGIN_TABBAR_ID} .hs-inline-dot.attack{animation:none}}
  `;

  function injectStyle(){
    if(document.getElementById(STYLE_ID))return;
    const style=document.createElement('style');
    style.id=STYLE_ID;
    style.textContent=css;
    document.head.appendChild(style);
  }

  function authHeaders(extra){
    const headers=new Headers(extra||{});
    if(!headers.has('Content-Type'))headers.set('Content-Type','application/json');
    const token=localStorage.getItem('token');
    if(token&&!headers.has('Authorization'))headers.set('Authorization',`Bearer ${token}`);
    return headers;
  }

  async function shieldApi(path){
    const response=await rawFetch(`/api/hs-shield${path}`,{credentials:'same-origin',headers:authHeaders()});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){const err=new Error(data.detail||`HTTP ${response.status}`);err.status=response.status;throw err}
    return data;
  }

  async function probeOwner(){
    try{
      const response=await rawFetch('/api/hs-plugin/state',{credentials:'same-origin',headers:authHeaders()});
      if(response.ok){allowed=true;return true}
      if(response.status===401||response.status===403)allowed=false;
    }catch(_error){}
    return false;
  }

  function placeholderData(message='Telemetry API is waiting for backend activation'){
    return {status:{stage:'starting',updated_at:null,metrics:{pps:0,mbps:0,syn_recv:0,established:0},baseline:{pps:0},layers:{hs_detector:{active:true,role:'observe-only detector'}},layers_ready:1,layers_total:5,origin:{state:'unknown',public_bindings:[]},stage_reasons:[message],api_pending:true},events:[]};
  }

  function isDashboardShell(el){return !!el&&el.tagName==='DIV'&&el.classList.contains('flex')&&el.classList.contains('min-h-0')&&el.classList.contains('w-full')&&el.classList.contains('flex-1')&&el.classList.contains('flex-col')&&el.classList.contains('justify-between')}
  function isPageTransition(el){return !!el&&el.tagName==='DIV'&&el.classList.contains('flex')&&el.classList.contains('min-h-0')&&el.classList.contains('flex-1')&&el.classList.contains('flex-col')&&!el.classList.contains('justify-between')}
  function getOutletHost(){
    const inset=document.querySelector('main.dashboard-scroll')||document.querySelector('.dashboard-scroll');
    if(!inset)return null;
    const shell=[...inset.children].find(isDashboardShell)||[...inset.querySelectorAll(':scope > div')].find(isDashboardShell)||null;
    if(!shell)return null;
    const outlet=[...shell.children].find(isPageTransition)||null;
    if(outlet)return outlet;
    const footer=[...shell.children].find(el=>el.tagName==='FOOTER'||el.querySelector?.('footer'))||null;
    return footer?.previousElementSibling||[...shell.children].find(el=>el.tagName==='DIV'&&el.id!==ROOT_ID)||null;
  }

  function hideOutlet(outlet){
    [...outlet.children].forEach(el=>{if(el.id===ROOT_ID)return;if(!el.hasAttribute('data-hs-shield-display'))el.setAttribute('data-hs-shield-display',el.style.display||'');el.style.display='none'});
  }
  function restoreOutlet(outlet){
    [...outlet.children].forEach(el=>{if(!el.hasAttribute('data-hs-shield-display'))return;el.style.display=el.getAttribute('data-hs-shield-display')||'';el.removeAttribute('data-hs-shield-display')});
  }
  function suppressNativeActive(){document.querySelectorAll('[data-sidebar="menu-button"][data-active="true"]').forEach(button=>{if(button.closest(`#${NAV_ID}`))return;if(!button.hasAttribute('data-hs-shield-prev'))button.setAttribute('data-hs-shield-prev',button.dataset.active||'false');button.dataset.active='false'})}
  function restoreNativeActive(){document.querySelectorAll('[data-sidebar="menu-button"][data-hs-shield-prev]').forEach(button=>{button.dataset.active=button.getAttribute('data-hs-shield-prev')||'false';button.removeAttribute('data-hs-shield-prev')})}

  function deactivate(){
    if(!active)return;
    active=false;
    stopPolling();
    const root=document.getElementById(ROOT_ID);
    const outlet=root?.parentElement||getOutletHost();
    if(outlet)restoreOutlet(outlet);
    root?.remove();
    restoreNativeActive();
    updateIndicators(latest?.status?.stage||'unknown');
  }

  function navAnchor(){
    const hs=document.getElementById('hs-plugin-nav');
    if(hs)return hs;
    const link=[...document.querySelectorAll('a')].find(a=>{const href=a.getAttribute('href')||'';return href==='/nodes'||href==='#/nodes'||href.endsWith('#/nodes')});
    if(!link)return null;
    let li=link.closest('li');if(!li)return null;let parent=li.parentElement?.closest('li');while(parent){li=parent;parent=li.parentElement?.closest('li')}return li;
  }

  function dotClass(stage,base){return `${base} ${stage==='attack'||stage==='lockdown'?'attack':stage==='elevated'?'warn':['normal','standby'].includes(stage)?'ok':''}`}
  function updateIndicators(stage='unknown'){
    const navDot=document.querySelector(`#${NAV_ID} .hs-shield-nav-dot`);if(navDot)navDot.className=dotClass(stage,'hs-shield-nav-dot');
    const inlineDot=document.querySelector(`#${PLUGIN_TABBAR_ID} .hs-inline-dot`);if(inlineDot)inlineDot.className=dotClass(stage,'hs-inline-dot');
    const button=document.querySelector(`#${NAV_ID} [data-sidebar="menu-button"]`);if(button)button.dataset.active=active?'true':'false';
  }

  function ensurePluginTab(){
    if(!allowed)return;
    const root=document.getElementById('hs-plugin-root');
    if(!root||document.getElementById(PLUGIN_TABBAR_ID))return;
    const heading=root.querySelector('h3');
    const header=heading?.parentElement;
    if(!header)return;
    const bar=document.createElement('div');
    bar.id=PLUGIN_TABBAR_ID;
    bar.innerHTML=`<button type="button" class="hs-active" data-hs-plugin-tab="features">Features</button><button type="button" data-hs-plugin-tab="firewall">${shieldIcon()}<span>Firewall</span><i class="hs-inline-dot"></i></button>`;
    const firewall=bar.querySelector('[data-hs-plugin-tab="firewall"]');
    firewall?.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();activate()});
    header.insertAdjacentElement('afterend',bar);
    updateIndicators(latest?.status?.stage||'unknown');
  }

  function ensureNav(){
    if(!allowed){document.getElementById(NAV_ID)?.remove();return}
    if(document.getElementById(NAV_ID)){updateIndicators(latest?.status?.stage);return}
    const anchor=navAnchor();if(!anchor||!anchor.parentElement)return;
    const li=document.createElement('li');li.id=NAV_ID;li.setAttribute('data-sidebar','menu-item');li.className='group/menu-item relative';
    const button=document.createElement('button');button.type='button';button.title='HS Firewall';button.setAttribute('data-sidebar','menu-button');button.setAttribute('data-size','default');button.dataset.active='false';button.className=menuButtonClass;
    button.innerHTML=`${shieldIcon('hs-shield-nav-icon')}<span>HS Firewall</span><i class="hs-shield-nav-dot"></i>`;
    button.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();activate()});
    li.appendChild(button);anchor.after(li);updateIndicators(latest?.status?.stage);
  }

  function fmtRate(value){const n=Number(value)||0;if(n>=1e6)return `${(n/1e6).toFixed(1)}M`;if(n>=1e3)return `${(n/1e3).toFixed(1)}K`;return Math.round(n).toString()}
  function fmtTime(iso){if(!iso)return '--:--';const d=new Date(iso);if(Number.isNaN(d.getTime()))return '--:--';return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}
  function esc(value){return String(value??'').replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]))}
  function stageLabel(stage){return ({starting:'Starting',standby:'Standby',normal:'Normal',elevated:'Elevated',attack:'Attack',lockdown:'Lockdown'})[stage]||'Unknown'}
  function layerName(key){return ({cloudflare_tunnel:'Cloudflare Tunnel',haproxy:'HAProxy',nftables:'nftables',fastnetmon:'FastNetMon',hs_detector:'HS Detector'})[key]||key}

  function render(data){
    latest=data||placeholderData();
    const s=latest.status||{};const m=s.metrics||{};const layers=s.layers||{};const events=Array.isArray(latest.events)?latest.events:[];const stage=s.stage||'starting';const origin=s.origin||{};
    const outlet=getOutletHost();if(!outlet)return false;
    hideOutlet(outlet);
    let root=document.getElementById(ROOT_ID);if(root&&root.parentElement!==outlet)root.remove();root=document.getElementById(ROOT_ID);
    if(!root){root=document.createElement('section');root.id=ROOT_ID;root.className='flex min-h-0 w-full flex-1 flex-col';outlet.appendChild(root)}
    const reason=(Array.isArray(s.stage_reasons)&&s.stage_reasons[0])||statusError||'Waiting for telemetry';
    const originClass=origin.state==='hidden'?'hs-good':origin.state==='public'?'hs-bad':'hs-warn';
    const stages=['standby','normal','elevated','attack','lockdown'];
    const pending=!!s.api_pending;
    root.innerHTML=`<div class="hs-wrap">
      <section class="hs-hero"><div class="hs-hero-grid"><div><div class="hs-kicker">HS Shield • v${VERSION}</div><h2>Panel Firewall Control Plane</h2><div class="hs-muted">Multi-stage protection telemetry with a fail-open rollout. Observe mode never changes panel traffic.</div><div class="hs-chip-row"><span class="hs-chip">Stage <strong>${esc(stageLabel(stage))}</strong></span><span class="hs-chip">Mode <strong>Observe</strong></span><span class="hs-chip">Origin <strong>${esc(origin.state||'unknown')}</strong></span><span class="hs-chip">Layers <strong>${Number(s.layers_ready)||0}/${Number(s.layers_total)||0}</strong></span>${pending?'<span class="hs-chip">Backend <strong>Pending activation</strong></span>':''}</div></div><div class="hs-orb">${shieldIcon()}</div></div></section>
      <div class="hs-stagebar">${stages.map(x=>`<div class="hs-stage ${x===stage?'active':''} ${stage==='attack'&&x===stage?'attack':''}"><span>${x==='standby'?'00':x==='normal'?'01':x==='elevated'?'02':x==='attack'?'03':'04'}</span><b>${stageLabel(x)}</b></div>`).join('')}</div>
      <div class="hs-grid"><div class="hs-card"><div class="hs-label">Incoming packet rate</div><div class="hs-value">${fmtRate(m.pps)} <small style="font-size:.62em;font-weight:600">pps</small></div><div class="hs-sub">Adaptive baseline ${fmtRate(s.baseline?.pps||0)} pps</div></div><div class="hs-card"><div class="hs-label">Network throughput</div><div class="hs-value">${Number(m.mbps||0).toFixed(1)} <small style="font-size:.62em;font-weight:600">Mbps</small></div><div class="hs-sub">Host-wide observation, no packet interception</div></div><div class="hs-card"><div class="hs-label">TCP SYN-RECV</div><div class="hs-value">${Math.round(Number(m.syn_recv)||0)}</div><div class="hs-sub">Connection-flood pressure signal</div></div><div class="hs-card"><div class="hs-label">Established TCP</div><div class="hs-value">${Math.round(Number(m.established)||0)}</div><div class="hs-sub">Current host connection pressure</div></div></div>
      <section class="hs-section"><div class="hs-section-head"><h3>Protection layers</h3><span class="hs-pill">live health</span></div><div class="hs-layers">${Object.keys(layers).length?Object.entries(layers).map(([key,val])=>`<div class="hs-layer"><div class="hs-layer-name">${esc(layerName(key))}</div><div class="hs-layer-state"><i class="hs-dot ${val?.active?'on':''}"></i>${val?.active?'Active':'Not active'}</div><div class="hs-sub">${esc(val?.role||'layer')}</div></div>`).join(''):'<div class="hs-empty">Waiting for layer discovery…</div>'}</div></section>
      <div class="hs-main"><section class="hs-section"><div class="hs-section-head"><h3>Security timeline</h3><button class="hs-refresh" id="hs-shield-refresh">Refresh</button></div>${events.length?events.map(ev=>`<div class="hs-event"><div class="hs-event-time">${esc(fmtTime(ev.at))}</div><i class="hs-event-dot ${esc(ev.kind||'')}"></i><div><div class="hs-event-title">${esc(ev.message||ev.kind||'Event')}</div><div class="hs-sub">Stage: ${esc(stageLabel(ev.stage||'unknown'))}</div></div></div>`).join(''):'<div class="hs-empty">No security events recorded yet.</div>'}</section><section class="hs-section"><div class="hs-section-head"><h3>Safety & exposure</h3><span class="hs-pill">fail-open</span></div><div class="hs-side"><div class="hs-safe"><strong>Traffic is untouched</strong>${pending?'Firewall UI is installed, but the new read-only backend telemetry route has not entered the running PasarGuard process yet.':'Observe mode cannot add firewall rules, restart PasarGuard, or change Docker networking.'}</div><div class="hs-row"><span>Current reason</span><b>${esc(reason)}</b></div><div class="hs-row"><span>Origin exposure</span><b class="${originClass}">${esc(origin.state||'unknown')}</b></div><div class="hs-row"><span>Public bindings</span><b>${Array.isArray(origin.public_bindings)?origin.public_bindings.length:0}</b></div><div class="hs-row"><span>Traffic modified</span><b class="hs-good">No</b></div><div class="hs-row"><span>Fail-open</span><b class="hs-good">Enabled</b></div><div class="hs-row"><span>Last telemetry</span><b>${esc(fmtTime(s.updated_at))}</b></div></div></section></div>
    </div>`;
    root.querySelector('#hs-shield-refresh')?.addEventListener('click',()=>refresh(true));
    updateIndicators(stage);
    return true;
  }

  async function refresh(force=false){
    try{
      const data=await shieldApi('/status');
      allowed=true;statusError=null;latest=data;ensureNav();ensurePluginTab();if(active||force)render(data);
    }catch(error){
      statusError=error.message||'Shield telemetry unavailable';
      if(error.status===401||error.status===403){allowed=false;deactivate();document.getElementById(NAV_ID)?.remove();return}
      if(!allowed)await probeOwner();
      if(allowed){latest=placeholderData(statusError);ensureNav();ensurePluginTab();if(active||force)render(latest)}
    }
  }
  function startPolling(){stopPolling();pollTimer=setInterval(()=>refresh(false),2000)}
  function stopPolling(){if(pollTimer){clearInterval(pollTimer);pollTimer=null}}

  async function activate(){
    if(!allowed)await probeOwner();
    if(!allowed)return;
    if(!latest)await refresh(false);
    if(!latest)latest=placeholderData(statusError||undefined);
    const other=document.getElementById('hs-plugin-root');
    if(other){const outlet=other.parentElement;[...outlet.children].forEach(el=>{if(el.hasAttribute('data-hs-outlet-display')){el.style.display=el.getAttribute('data-hs-outlet-display')||'';el.removeAttribute('data-hs-outlet-display')}});other.remove()}
    active=true;suppressNativeActive();updateIndicators(latest?.status?.stage);if(render(latest))startPolling();else active=false;
  }

  function watchNavigation(){
    document.addEventListener('click',event=>{if(!active)return;const target=event.target instanceof Element?event.target.closest('a,[data-sidebar="menu-button"]'):null;if(!target||target.closest(`#${NAV_ID}`))return;setTimeout(()=>{if(document.getElementById(ROOT_ID))deactivate()},0)},true);
  }

  async function boot(){
    injectStyle();watchNavigation();
    window.addEventListener('hs-shield:activate',()=>activate());
    await probeOwner();
    ensurePluginTab();ensureNav();
    await refresh(false);
    const observer=new MutationObserver(()=>{ensurePluginTab();ensureNav()});
    observer.observe(document.documentElement,{childList:true,subtree:true});
    navTimer=setInterval(()=>refresh(false),10000);
    console.info(`[HS Shield] ${VERSION} loaded`);
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
