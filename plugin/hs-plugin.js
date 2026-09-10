(() => {
  'use strict';

  const VERSION = '0.1.3';
  const NAV_ID = 'hs-plugin-nav';
  const ROOT_ID = 'hs-plugin-root';
  const STYLE_ID = 'hs-plugin-style';
  const HOST_FIELD_ID = 'hs-host-usage-ratio';
  const rawFetch = window.fetch.bind(window);

  let state = null;
  let ownerAllowed = false;
  let active = false;
  let busy = false;
  let queued = false;
  let lastError = null;

  const menuButtonClass = 'peer/menu-button relative flex h-8 w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none ring-sidebar-ring transition-[width,height,padding,background-color] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 group-has-[[data-sidebar=menu-action]]/menu-item:ltr:pr-8 group-has-[[data-sidebar=menu-action]]/menu-item:rtl:pl-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent/70 data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[active=true]:before:bg-primary data-[active=true]:before:absolute data-[active=true]:before:inset-y-1.5 data-[active=true]:before:start-0 data-[active=true]:before:w-0.5 data-[active=true]:before:rounded-full group-data-[collapsible=icon]:!size-8 group-data-[collapsible=icon]:!p-2 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0';
  const inputClass = 'border-border bg-input file:text-foreground placeholder:text-input-placeholder focus-visible:ring-ring flex h-9 w-full rounded-lg border px-3 py-2 text-sm file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50';
  const switchClass = 'peer focus-visible:ring-ring focus-visible:ring-offset-background data-[state=checked]:bg-primary data-[state=unchecked]:bg-input inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50';
  const switchThumbClass = 'bg-background pointer-events-none block h-4 w-4 rounded-full shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0';

  const pluginIcon = (className = '') => `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a6 6 0 0 1-12 0V8Z"/></svg>`;

  const css = `
    @keyframes hsGoldSweep{0%{background-position:180% 50%}100%{background-position:-80% 50%}}
    .hs-gold{background:linear-gradient(105deg,#8f650f 0%,#d4a72c 30%,#fff0a8 46%,#d4a72c 62%,#8f650f 100%);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;color:transparent!important;animation:hsGoldSweep 4.2s linear infinite;filter:drop-shadow(0 0 3px rgba(212,167,44,.12))}
    .hs-nav-icon{color:#d4a72c;filter:drop-shadow(0 0 3px rgba(212,167,44,.28))}
    @media(prefers-reduced-motion:reduce){.hs-gold{animation:none;background-position:50% 50%}}
    #${ROOT_ID}{width:100%;color:hsl(var(--foreground));font-family:inherit}
    #${ROOT_ID} *{box-sizing:border-box}
    #${ROOT_ID} .hs-status{min-height:1.25rem;font-size:.75rem;color:hsl(var(--muted-foreground));padding-top:.25rem}
    #${ROOT_ID} .hs-status.ok{color:hsl(142 70% 40%)}
    #${ROOT_ID} .hs-status.err{color:hsl(var(--destructive))}
    #${HOST_FIELD_ID}{margin-top:1rem}
    #${HOST_FIELD_ID} .hs-host-label{display:flex;align-items:center;gap:.45rem;margin-bottom:.45rem;font-size:.875rem;font-weight:500}
    #${HOST_FIELD_ID} .hs-host-badge{font-size:.6rem;line-height:1;padding:.18rem .35rem;border:1px solid rgba(212,167,44,.28);border-radius:999px;color:#a8750a;background:rgba(212,167,44,.07)}
    #${HOST_FIELD_ID} .hs-host-help{font-size:.75rem;line-height:1.5;color:hsl(var(--muted-foreground));margin-top:.4rem}
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
    const button=document.querySelector(`#${NAV_ID} [data-sidebar="menu-button"]`);
    if(button)button.dataset.active=active?'true':'false';
    if(active)suppressNativeActive();
  }

  function ensureNav(){
    if(!ownerAllowed){document.getElementById(NAV_ID)?.remove();return}
    if(document.getElementById(NAV_ID)){updateNavActive();return}
    const nodeItem=findNodeTopItem();
    if(!nodeItem||!nodeItem.parentElement)return;

    const li=document.createElement('li');
    li.id=NAV_ID;
    li.setAttribute('data-sidebar','menu-item');
    li.className='group/menu-item relative';

    const button=document.createElement('button');
    button.type='button';
    button.title='HS Plugin';
    button.setAttribute('data-sidebar','menu-button');
    button.setAttribute('data-size','default');
    button.dataset.active=active?'true':'false';
    button.className=menuButtonClass;
    button.innerHTML=`${pluginIcon('hs-nav-icon')}<span class="hs-gold">HS Plugin</span>`;
    button.addEventListener('click',activate);

    li.appendChild(button);
    nodeItem.after(li);
    updateNavActive();
  }

  function getOutletHost(){
    const inset=document.querySelector('main.dashboard-scroll')||document.querySelector('main');
    if(!inset)return null;

    const shell=[...inset.children].find(el=>
      el.tagName==='DIV'&&
      el.classList.contains('flex')&&
      el.classList.contains('min-h-0')&&
      el.classList.contains('w-full')&&
      el.classList.contains('flex-1')&&
      el.classList.contains('flex-col')&&
      el.classList.contains('justify-between')
    );
    if(!shell)return null;

    return [...shell.children].find(el=>
      el.tagName==='DIV'&&
      el.classList.contains('w-full')&&
      el.classList.contains('flex')&&
      el.classList.contains('min-h-0')&&
      el.classList.contains('flex-1')&&
      el.classList.contains('flex-col')&&
      !el.classList.contains('justify-between')
    )||null;
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
    const outlet=getOutletHost();
    if(outlet)restoreOutletContent(outlet);
    document.getElementById(ROOT_ID)?.remove();
    restoreNativeActive();
    const button=document.querySelector(`#${NAV_ID} [data-sidebar="menu-button"]`);
    if(button)button.dataset.active='false';
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
      console.warn('[HS Plugin] PasarGuard Outlet host was not found; dashboard shell was left untouched.');
      return;
    }

    hideOutletContent(outlet);
    let root=document.getElementById(ROOT_ID);
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
  }

  async function activate(){
    if(!state)await refreshState();
    if(!ownerAllowed){
      console.warn('[HS Plugin] unavailable',lastError);
      return;
    }
    active=true;
    updateNavActive();
    render();
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
    const ratio=Number(editing?.usage_ratio??1);
    const wrap=document.createElement('div');
    wrap.id=HOST_FIELD_ID;
    wrap.dataset.hostId=editing?.id||'';
    wrap.innerHTML=`
      <label class="hs-host-label"><span class="hs-gold">Usage Ratio</span><span class="hs-host-badge">HS</span></label>
      <input class="${inputClass}" dir="ltr" type="number" min="0" max="100" step="0.05" value="${ratio}">
      <div class="hs-host-help">Traffic multiplier for this Host. Final usage = Host Ratio × native Node Ratio.</div>`;
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
        if(!document.getElementById(ROOT_ID))render();
      }
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
      if(active&&!event.target.closest(`#${NAV_ID}`)&&event.target.closest('a'))deactivate();
    },true);
    setInterval(()=>refreshState().then(queueMaintain),60000);
  }

  window.HSPluginDebug={version:VERSION,refresh:refreshState,getState:()=>state,getError:()=>lastError,getOutletHost};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();