(() => {
  'use strict';

  const VERSION = '0.1.6';
  const NAV_ID = 'hs-plugin-nav';
  const SUBMENU_ID = 'hs-plugin-submenu';
  const ROOT_ID = 'hs-plugin-root';
  const STYLE_ID = 'hs-plugin-style';
  const TOP_TABS_ID = 'hs-plugin-top-tabs';
  const HOST_FIELD_ID = 'hs-host-usage-ratio';
  const rawFetch = window.fetch.bind(window);

  let state = null;
  let ownerAllowed = false;
  let active = false;
  let busy = false;
  let queued = false;
  let menuOpen = false;
  let currentSection = null;
  let lastError = null;

  const menuButtonClass = 'peer/menu-button relative flex h-8 w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none ring-sidebar-ring transition-[width,height,padding,background-color] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 group-has-[[data-sidebar=menu-action]]/menu-item:ltr:pr-8 group-has-[[data-sidebar=menu-action]]/menu-item:rtl:pl-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent/70 data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[active=true]:before:bg-primary data-[active=true]:before:absolute data-[active=true]:before:inset-y-1.5 data-[active=true]:before:start-0 data-[active=true]:before:w-0.5 data-[active=true]:before:rounded-full group-data-[collapsible=icon]:!size-8 group-data-[collapsible=icon]:!p-2 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0';
  const subButtonClass = 'text-sidebar-foreground ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground relative flex h-7 min-w-0 w-full items-center gap-2 overflow-hidden rounded-md px-2 text-sm outline-none focus-visible:ring-2 data-[active=true]:bg-sidebar-accent/70 data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[active=true]:before:bg-primary data-[active=true]:before:absolute data-[active=true]:before:inset-y-1 data-[active=true]:before:start-0 data-[active=true]:before:w-0.5 data-[active=true]:before:rounded-full [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0';
  const inputClass = 'border-border bg-input file:text-foreground placeholder:text-input-placeholder focus-visible:ring-ring flex h-9 w-full rounded-lg border px-3 py-2 text-sm file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50';
  const switchClass = 'peer focus-visible:ring-ring focus-visible:ring-offset-background data-[state=checked]:bg-primary data-[state=unchecked]:bg-input inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50';
  const switchThumbClass = 'bg-background pointer-events-none block h-4 w-4 rounded-full shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0';

  const pluginIcon = (className = '') => `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a6 6 0 0 1-12 0V8Z"/></svg>`;
  const slidersIcon = (className = '') => `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>`;
  const shieldIcon = (className = '') => `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 19 6v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6l7-3Z"/><path d="m9.5 12 1.7 1.7 3.5-4"/></svg>`;
  const chevronIcon = () => '<svg class="hs-plugin-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

  const css = `
    @keyframes hsGoldSweep{0%{background-position:180% 50%}100%{background-position:-80% 50%}}
    .hs-gold{background:linear-gradient(105deg,#8f650f 0%,#d4a72c 30%,#fff0a8 46%,#d4a72c 62%,#8f650f 100%);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;color:transparent!important;animation:hsGoldSweep 4.2s linear infinite;filter:drop-shadow(0 0 3px rgba(212,167,44,.12))}
    .hs-nav-icon{color:#d4a72c;filter:drop-shadow(0 0 3px rgba(212,167,44,.28))}
    #${NAV_ID} .hs-plugin-menu-action{color:hsl(var(--sidebar-foreground));position:absolute;top:.375rem;display:flex;aspect-ratio:1/1;width:1.25rem;align-items:center;justify-content:center;border:0;border-radius:.375rem;padding:0;background:transparent;transition:transform .18s,background-color .18s;outline:none;cursor:pointer;z-index:2}
    #${NAV_ID} .hs-plugin-menu-action:hover{background:hsl(var(--sidebar-accent));color:hsl(var(--sidebar-accent-foreground))}
    #${NAV_ID} .hs-plugin-menu-action{right:.25rem} [dir=rtl] #${NAV_ID} .hs-plugin-menu-action{right:auto;left:.25rem}
    #${NAV_ID} .hs-plugin-menu-action svg{width:1rem;height:1rem;transition:transform .18s ease}
    #${NAV_ID}[data-hs-open="true"] .hs-plugin-chevron{transform:rotate(90deg)}
    [dir=rtl] #${NAV_ID}[data-hs-open="true"] .hs-plugin-chevron{transform:rotate(-90deg)}
    #${SUBMENU_ID}[hidden]{display:none!important}
    #${SUBMENU_ID}{border-color:hsl(var(--sidebar-border));margin:.375rem .875rem 0;display:flex;min-width:0;flex-direction:column;gap:.25rem;border-left:1px solid;padding:.125rem .625rem .125rem;list-style:none}
    [dir=rtl] #${SUBMENU_ID}{border-left:0;border-right:1px solid}
    #${SUBMENU_ID} li{min-width:0}
    #${ROOT_ID}{width:100%;color:hsl(var(--foreground));font-family:inherit}
    #${ROOT_ID} *{box-sizing:border-box}
    #${TOP_TABS_ID}{display:flex;align-items:center;gap:.35rem;width:max-content;max-width:100%;padding:.22rem;border:1px solid hsl(var(--border));border-radius:10px;background:hsl(var(--muted)/.35)}
    #${TOP_TABS_ID} button{display:inline-flex;align-items:center;gap:.4rem;border:0;background:transparent;color:hsl(var(--muted-foreground));font:inherit;font-size:.75rem;padding:.42rem .7rem;border-radius:8px;cursor:pointer;transition:background-color .18s,color .18s,box-shadow .18s}
    #${TOP_TABS_ID} button:hover{color:hsl(var(--foreground));background:hsl(var(--background)/.72)}
    #${TOP_TABS_ID} button.hs-active{background:hsl(var(--background));color:hsl(var(--foreground));box-shadow:0 1px 2px rgba(0,0,0,.08)}
    #${TOP_TABS_ID} svg{width:14px;height:14px;color:#d4a72c}
    #${ROOT_ID} .hs-status{min-height:1.25rem;font-size:.75rem;color:hsl(var(--muted-foreground));padding-top:.25rem}
    #${ROOT_ID} .hs-status.ok{color:hsl(142 70% 40%)}
    #${ROOT_ID} .hs-status.err{color:hsl(var(--destructive))}
    #${HOST_FIELD_ID}{margin-top:1rem}
    #${HOST_FIELD_ID} .hs-host-label{display:flex;align-items:center;gap:.45rem;margin-bottom:.45rem;font-size:.875rem;font-weight:500}
    #${HOST_FIELD_ID} .hs-host-badge{font-size:.6rem;line-height:1;padding:.18rem .35rem;border:1px solid rgba(212,167,44,.28);border-radius:999px;color:#a8750a;background:rgba(212,167,44,.07)}
    #${HOST_FIELD_ID} .hs-host-help{font-size:.75rem;line-height:1.5;color:hsl(var(--muted-foreground));margin-top:.4rem}
    @media(prefers-reduced-motion:reduce){.hs-gold{animation:none;background-position:50% 50%}#${NAV_ID} .hs-plugin-menu-action svg{transition:none}}
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

  async function api(path,options={}){
    const {headers,...rest}=options;
    const response=await rawFetch(`/api/hs-plugin${path}`,{credentials:'same-origin',...rest,headers:authHeaders(headers)});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){
      const error=new Error(data.detail||`HTTP ${response.status}`);
      error.status=response.status;
      throw error;
    }
    return data;
  }

  function setStatus(text,kind=''){
    const el=document.querySelector(`#${ROOT_ID} .hs-status`);
    if(!el)return;
    el.textContent=text||'';
    el.className=`hs-status ${kind}`;
  }

  async function refreshState(){
    try{
      state=await api('/state');
      ownerAllowed=true;
      lastError=null;
      return state;
    }catch(error){
      lastError=error;
      ownerAllowed=false;
      state=null;
      console.warn('[HS Plugin] state request failed',error);
      return null;
    }
  }

  function findNodeTopItem(){
    const link=[...document.querySelectorAll('a')].find(a=>{
      const href=a.getAttribute('href')||'';
      return href==='/nodes'||href==='#/nodes'||href.endsWith('#/nodes');
    });
    if(!link)return null;
    let li=link.closest('li');
    if(!li)return null;
    let parent=li.parentElement?.closest('li');
    while(parent){li=parent;parent=li.parentElement?.closest('li')}
    return li;
  }

  function setMenuOpen(next){
    menuOpen=!!next;
    const nav=document.getElementById(NAV_ID);
    const submenu=document.getElementById(SUBMENU_ID);
    const action=nav?.querySelector('.hs-plugin-menu-action');
    if(nav)nav.dataset.hsOpen=menuOpen?'true':'false';
    if(submenu)submenu.hidden=!menuOpen;
    if(action){
      action.dataset.state=menuOpen?'open':'closed';
      action.setAttribute('aria-expanded',menuOpen?'true':'false');
    }
  }

  function suppressNativeActive(){
    document.querySelectorAll('[data-sidebar="menu-button"][data-active="true"]').forEach(button=>{
      if(button.closest(`#${NAV_ID}`))return;
      if(!button.hasAttribute('data-hs-prev-active'))button.setAttribute('data-hs-prev-active',button.dataset.active||'false');
      button.dataset.active='false';
    });
  }

  function restoreNativeActive(){
    document.querySelectorAll('[data-sidebar="menu-button"][data-hs-prev-active]').forEach(button=>{
      button.dataset.active=button.getAttribute('data-hs-prev-active')||'false';
      button.removeAttribute('data-hs-prev-active');
    });
  }

  function updateNavActive(){
    const nav=document.getElementById(NAV_ID);
    if(!nav)return;
    const parent=nav.querySelector('[data-hs-parent]');
    const features=nav.querySelector('[data-hs-sub="features"]');
    const firewall=nav.querySelector('[data-hs-sub="firewall"]');
    const shieldActive=!!document.getElementById('hs-shield-root')||currentSection==='firewall';
    if(parent)parent.dataset.active=(active||shieldActive)?'true':'false';
    if(features)features.dataset.active=active?'true':'false';
    if(firewall)firewall.dataset.active=shieldActive?'true':'false';
    if(active||shieldActive)suppressNativeActive();
  }

  function setSection(section){
    currentSection=section||null;
    updateNavActive();
  }

  function openFirewall(){
    currentSection='firewall';
    updateNavActive();
    if(window.HSShieldDebug?.open){
      window.HSShieldDebug.open();
    }else{
      window.dispatchEvent(new CustomEvent('hs-shield:activate'));
    }
  }

  function ensureNav(){
    if(!ownerAllowed){
      document.getElementById(NAV_ID)?.remove();
      return;
    }

    let existing=document.getElementById(NAV_ID);
    if(existing&&existing.dataset.hsOwned!=='1'){
      existing.remove();
      existing=null;
    }
    if(existing){
      setMenuOpen(menuOpen);
      updateNavActive();
      return;
    }

    const nodeItem=findNodeTopItem();
    if(!nodeItem||!nodeItem.parentElement)return;

    const li=document.createElement('li');
    li.id=NAV_ID;
    li.dataset.hsOwned='1';
    li.dataset.hsOpen='false';
    li.setAttribute('data-sidebar','menu-item');
    li.className='group/menu-item relative';

    const parent=document.createElement('button');
    parent.type='button';
    parent.title='HS Plugin';
    parent.setAttribute('data-sidebar','menu-button');
    parent.setAttribute('data-size','default');
    parent.setAttribute('data-hs-parent','1');
    parent.dataset.active='false';
    parent.className=menuButtonClass;
    parent.innerHTML=`${pluginIcon('hs-nav-icon')}<span class="hs-gold">HS Plugin</span>`;
    parent.addEventListener('click',event=>{
      event.preventDefault();
      event.stopPropagation();
      activate();
    });

    const action=document.createElement('button');
    action.type='button';
    action.title='Toggle HS Plugin menu';
    action.setAttribute('data-sidebar','menu-action');
    action.setAttribute('aria-label','Toggle HS Plugin menu');
    action.setAttribute('aria-expanded','false');
    action.className='hs-plugin-menu-action';
    action.innerHTML=chevronIcon();
    action.addEventListener('click',event=>{
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(!menuOpen);
    });

    const submenu=document.createElement('ul');
    submenu.id=SUBMENU_ID;
    submenu.hidden=true;
    submenu.setAttribute('data-sidebar','menu-sub');

    const featuresItem=document.createElement('li');
    const features=document.createElement('button');
    features.type='button';
    features.setAttribute('data-sidebar','menu-sub-button');
    features.setAttribute('data-hs-sub','features');
    features.dataset.active='false';
    features.className=subButtonClass;
    features.innerHTML=`${slidersIcon()}<span>Features</span>`;
    features.addEventListener('click',event=>{
      event.preventDefault();
      event.stopPropagation();
      activate();
    });
    featuresItem.appendChild(features);

    const firewallItem=document.createElement('li');
    const firewall=document.createElement('button');
    firewall.type='button';
    firewall.setAttribute('data-sidebar','menu-sub-button');
    firewall.setAttribute('data-hs-sub','firewall');
    firewall.dataset.active='false';
    firewall.className=subButtonClass;
    firewall.innerHTML=`${shieldIcon()}<span>Firewall</span>`;
    firewall.addEventListener('click',event=>{
      event.preventDefault();
      event.stopPropagation();
      openFirewall();
    });
    firewallItem.appendChild(firewall);

    submenu.append(featuresItem,firewallItem);
    li.append(parent,action,submenu);
    nodeItem.after(li);
    setMenuOpen(false);
    updateNavActive();
  }

  function isDashboardShell(el){
    return !!el&&el.tagName==='DIV'&&el.classList.contains('flex')&&el.classList.contains('min-h-0')&&el.classList.contains('w-full')&&el.classList.contains('flex-1')&&el.classList.contains('flex-col')&&el.classList.contains('justify-between');
  }

  function isPageTransition(el){
    return !!el&&el.tagName==='DIV'&&el.classList.contains('flex')&&el.classList.contains('min-h-0')&&el.classList.contains('flex-1')&&el.classList.contains('flex-col')&&!el.classList.contains('justify-between');
  }

  function getOutletHost(){
    const inset=document.querySelector('main.dashboard-scroll')||document.querySelector('.dashboard-scroll');
    if(!inset)return null;

    let shell=[...inset.children].find(isDashboardShell)||null;
    if(!shell)shell=[...inset.querySelectorAll(':scope > div')].find(isDashboardShell)||null;
    if(!shell)return null;

    const outlet=[...shell.children].find(isPageTransition)||null;
    if(outlet)return outlet;

    const footer=[...shell.children].find(el=>el.tagName==='FOOTER'||el.querySelector?.('footer'))||null;
    if(footer){
      const previous=footer.previousElementSibling;
      if(previous&&previous.tagName==='DIV')return previous;
    }
    return [...shell.children].find(el=>el.tagName==='DIV'&&el.id!==ROOT_ID)||null;
  }

  function hideOutletContent(outlet){
    [...outlet.children].forEach(el=>{
      if(el.id===ROOT_ID)return;
      if(!el.hasAttribute('data-hs-outlet-display'))el.setAttribute('data-hs-outlet-display',el.style.display||'');
      el.style.display='none';
    });
  }

  function restoreOutletContent(outlet){
    [...outlet.children].forEach(el=>{
      if(!el.hasAttribute('data-hs-outlet-display'))return;
      el.style.display=el.getAttribute('data-hs-outlet-display')||'';
      el.removeAttribute('data-hs-outlet-display');
    });
  }

  function deactivate(){
    active=false;
    const root=document.getElementById(ROOT_ID);
    const outlet=root?.parentElement||getOutletHost();
    if(outlet)restoreOutletContent(outlet);
    root?.remove();
    restoreNativeActive();
    updateNavActive();
  }

  function renderSwitch(enabled){
    const status=enabled?'checked':'unchecked';
    return `<button id="hs-feature-host-ratio" type="button" role="switch" aria-checked="${enabled?'true':'false'}" data-state="${status}" class="${switchClass}"><span data-state="${status}" class="${switchThumbClass}"></span></button>`;
  }

  function setSwitchState(button,enabled){
    const status=enabled?'checked':'unchecked';
    button.setAttribute('aria-checked',enabled?'true':'false');
    button.dataset.state=status;
    const thumb=button.querySelector('span');
    if(thumb)thumb.dataset.state=status;
  }

  function render(){
    const outlet=getOutletHost();
    if(!outlet){
      console.error('[HS Plugin] PasarGuard PageTransition/Outlet host was not found. Dashboard shell was left untouched.');
      return false;
    }

    hideOutletContent(outlet);
    let root=document.getElementById(ROOT_ID);
    if(root&&root.parentElement!==outlet)root.remove();
    root=document.getElementById(ROOT_ID);
    if(!root){
      root=document.createElement('section');
      root.id=ROOT_ID;
      root.className='flex min-h-0 w-full flex-1 flex-col';
      outlet.appendChild(root);
    }

    const enabled=!!state?.features?.host_usage_ratio?.enabled;
    root.innerHTML=`
      <div class="flex min-h-[calc(100vh-200px)] w-full flex-col">
        <div class="flex flex-1 flex-col p-4 sm:py-6 lg:py-8">
          <div class="flex-1 space-y-6 sm:space-y-8 lg:space-y-10">
            <div class="space-y-3">
              <div class="space-y-2">
                <h3 class="text-base font-semibold sm:text-lg">HS Plugin</h3>
                <p class="text-muted-foreground text-xs sm:text-sm">Manage HS extensions for PasarGuard.</p>
              </div>

              <div id="${TOP_TABS_ID}">
                <button type="button" class="hs-active" data-hs-top-tab="features">${slidersIcon()}<span>Features</span></button>
                <button type="button" data-hs-top-tab="firewall">${shieldIcon()}<span>Firewall</span></button>
              </div>

              <div class="bg-card hover:bg-accent/50 flex flex-row items-center justify-between space-y-0 gap-x-3 rounded-lg border p-3 transition-colors sm:p-4">
                <div class="space-y-0.5">
                  <div class="flex items-center gap-2 text-xs font-medium sm:text-sm">
                    ${pluginIcon('hs-nav-icon h-4 w-4')}
                    <span>Host Usage Ratio</span>
                  </div>
                  <p class="text-muted-foreground text-xs sm:text-sm">Enable Usage Ratio controls inside the Host form.</p>
                </div>
                ${renderSwitch(enabled)}
              </div>

              <div class="hs-status"></div>
            </div>
          </div>
        </div>
      </div>`;

    root.querySelector('[data-hs-top-tab="firewall"]')?.addEventListener('click',event=>{
      event.preventDefault();
      event.stopPropagation();
      openFirewall();
    });

    const toggle=root.querySelector('#hs-feature-host-ratio');
    toggle?.addEventListener('click',async()=>{
      if(busy)return;
      const current=toggle.getAttribute('aria-checked')==='true';
      const next=!current;
      busy=true;
      toggle.disabled=true;
      setSwitchState(toggle,next);
      setStatus('Applying changes…');
      try{
        await api('/features/host_usage_ratio',{method:'PUT',body:JSON.stringify({enabled:next})});
        await api('/resync',{method:'POST',body:'{}'});
        await refreshState();
        if(!next)document.querySelectorAll(`#${HOST_FIELD_ID}`).forEach(el=>el.remove());
        setStatus('Changes applied.','ok');
      }catch(error){
        setSwitchState(toggle,current);
        setStatus(error.message,'err');
      }finally{
        busy=false;
        toggle.disabled=false;
      }
    });
    return true;
  }

  async function activate(){
    if(!state)await refreshState();
    if(!ownerAllowed){
      console.warn('[HS Plugin] unavailable',lastError);
      return;
    }

    if(window.HSShieldDebug?.close)window.HSShieldDebug.close();
    currentSection='features';
    active=true;
    updateNavActive();
    if(!render()){
      active=false;
      currentSection=null;
      restoreNativeActive();
      updateNavActive();
    }
  }

  function matchEditingHost(dialog){
    if(!state?.hosts?.length)return null;
    const remark=dialog.querySelector('input[name="remark"]')?.value;
    if(!remark)return null;
    const candidates=state.hosts.filter(h=>String(h.remark||'')===remark);
    return candidates.length===1?candidates[0]:null;
  }

  function injectHostField(dialog){
    if(!ownerAllowed||!state?.features?.host_usage_ratio?.enabled||dialog.querySelector(`#${HOST_FIELD_ID}`))return;
    const form=dialog.querySelector('form');
    if(!form||!form.querySelector('input[name="remark"]'))return;

    const scroll=[...form.querySelectorAll('div')].find(el=>el.children.length>1&&/overflow-y-auto/.test(el.className||''));
    const container=scroll||form;
    const first=container.firstElementChild;
    if(!first)return;

    const editing=matchEditingHost(dialog);
    const ratio=Number(editing?.usage_ratio??editing?.node_usage_ratio??1);
    const nodeRatio=Number(editing?.node_usage_ratio??1);
    const overridden=!!editing?.is_overridden;
    const wrap=document.createElement('div');
    wrap.id=HOST_FIELD_ID;
    wrap.dataset.hostId=editing?.id||'';
    wrap.innerHTML=`
      <label class="hs-host-label"><span class="hs-gold">Usage Ratio</span><span class="hs-host-badge">HS</span></label>
      <input class="${inputClass}" dir="ltr" type="number" min="0" max="100" step="0.05" value="${ratio}">
      <div class="hs-host-help">${overridden?`Current Node ratio: ${nodeRatio}. This Host keeps its configured offset relative to that Node.`:`Inherited from Node Usage Ratio (${nodeRatio}). Change it to add a Host-specific offset.`}</div>`;
    wrap.querySelector('input').addEventListener('input',()=>wrap.dataset.dirty='1');
    first.after(wrap);
  }

  function scanHostDialogs(){
    if(!state?.features?.host_usage_ratio?.enabled){
      document.querySelectorAll(`#${HOST_FIELD_ID}`).forEach(el=>el.remove());
      return;
    }
    document.querySelectorAll('[role="dialog"]').forEach(injectHostField);
  }

  function installHostSaveBridge(){
    if(window.__hsPluginFetchBridge)return;
    window.__hsPluginFetchBridge=true;

    window.fetch=async(input,init={})=>{
      const requestUrl=typeof input==='string'?input:(input?.url||'');
      const method=(init.method||(input?.method)||'GET').toUpperCase();
      const field=document.querySelector(`#${HOST_FIELD_ID}[data-dirty="1"]`);
      const pending=field?{ratio:Number(field.querySelector('input')?.value),hostId:Number(field.dataset.hostId||0)}:null;
      const response=await rawFetch(input,init);

      if(response.ok&&pending&&Number.isFinite(pending.ratio)&&((method==='POST'&&/\/api\/host\/?(?:\?|$)/.test(requestUrl))||(method==='PUT'&&/\/api\/host\/\d+/.test(requestUrl)))){
        try{
          const payload=await response.clone().json();
          const hostId=Number(payload?.id||pending.hostId);
          if(hostId){
            await rawFetch(`/api/hs-plugin/hosts/${hostId}/usage-ratio`,{method:'PUT',credentials:'same-origin',headers:authHeaders(),body:JSON.stringify({ratio:pending.ratio})});
            await rawFetch('/api/hs-plugin/resync',{method:'POST',credentials:'same-origin',headers:authHeaders(),body:'{}'});
            field.dataset.dirty='0';
            refreshState().catch(()=>{});
          }
        }catch(error){
          console.warn('[HS Plugin] Host follow-up failed',error);
        }
      }
      return response;
    };
  }

  function maintain(){
    queued=false;
    injectStyle();
    ensureNav();
    scanHostDialogs();

    if(active){
      updateNavActive();
      const outlet=getOutletHost();
      if(outlet){
        hideOutletContent(outlet);
        const root=document.getElementById(ROOT_ID);
        if(!root||root.parentElement!==outlet)render();
      }
    }else{
      updateNavActive();
    }
  }

  function queueMaintain(){
    if(queued)return;
    queued=true;
    requestAnimationFrame(maintain);
  }

  async function boot(){
    injectStyle();
    installHostSaveBridge();
    await refreshState();
    maintain();

    new MutationObserver(queueMaintain).observe(document.documentElement,{childList:true,subtree:true});
    document.addEventListener('click',event=>{
      if(active&&!event.target.closest(`#${NAV_ID}`)&&event.target.closest('a')){
        currentSection=null;
        deactivate();
      }
    },true);
    window.addEventListener('popstate',()=>{
      if(active){
        currentSection=null;
        deactivate();
      }
    });
    setInterval(()=>refreshState().then(queueMaintain),60000);
  }

  window.HSPluginDebug={
    version:VERSION,
    refresh:refreshState,
    getState:()=>state,
    getError:()=>lastError,
    getOutletHost,
    open:activate,
    close:deactivate,
    openFirewall,
    setSection,
    setMenuOpen,
    getMenuOpen:()=>menuOpen,
    isActive:()=>active
  };

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();