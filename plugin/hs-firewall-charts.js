(() => {
  'use strict';
  const STYLE_ID='hs-firewall-charts-style';
  const CONTROL_ID='hs-shield-power-controls';
  const MAX=36;
  const history={pps:[],mbps:[],syn_recv:[],established:[]};
  let timer=null;
  let saving=false;
  let observedRoot=null;
  let rootObserver=null;
  let mountQueued=false;

  function authHeaders(){
    const headers=new Headers({'Content-Type':'application/json'});
    const token=localStorage.getItem('token');
    if(token)headers.set('Authorization',`Bearer ${token}`);
    return headers;
  }

  function style(){
    if(document.getElementById(STYLE_ID))return;
    const s=document.createElement('style');s.id=STYLE_ID;s.textContent=`
      #hs-shield-root .hs-card{position:relative;overflow:hidden;min-height:118px!important}
      #hs-shield-root .hs-mini-chart{height:34px;margin-top:9px;opacity:.88}
      #hs-shield-root .hs-mini-chart svg{width:100%;height:34px;display:block;overflow:visible}
      #hs-shield-root .hs-mini-chart path{fill:none;stroke:currentColor;stroke-width:1.7;vector-effect:non-scaling-stroke}
      #hs-shield-root .hs-mini-chart .area{fill:currentColor;stroke:none;opacity:.055}
      #hs-shield-root .hs-mini-chart .base{stroke:hsl(var(--border));stroke-width:1;opacity:.7}
      #hs-shield-root .hs-card:nth-child(1) .hs-mini-chart{color:#d9b34c}
      #hs-shield-root .hs-card:nth-child(2) .hs-mini-chart{color:#38bdf8}
      #hs-shield-root .hs-card:nth-child(3) .hs-mini-chart{color:#f59e0b}
      #hs-shield-root .hs-card:nth-child(4) .hs-mini-chart{color:#22c55e}
      #${CONTROL_ID}{border:1px solid hsl(var(--border));border-radius:14px;background:hsl(var(--card));padding:.72rem .8rem;min-height:96px}
      #${CONTROL_ID} .hs-power-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:.55rem}
      #${CONTROL_ID} .hs-power-title{font-size:.75rem;font-weight:750;display:flex;align-items:center;gap:.45rem}
      #${CONTROL_ID} .hs-power-title i{width:7px;height:7px;border-radius:99px;background:#d9b34c;box-shadow:0 0 8px rgba(217,179,76,.45)}
      #${CONTROL_ID} .hs-power-note{font-size:.62rem;color:hsl(var(--muted-foreground))}
      #${CONTROL_ID} .hs-power-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.5rem}
      #${CONTROL_ID} .hs-power-item{display:flex;align-items:center;justify-content:space-between;gap:.65rem;min-width:0;padding:.55rem .62rem;border:1px solid hsl(var(--border));border-radius:11px;background:hsl(var(--background)/.45)}
      #${CONTROL_ID} .hs-power-copy{min-width:0}
      #${CONTROL_ID} .hs-power-name{font-size:.68rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #${CONTROL_ID} .hs-power-desc{font-size:.59rem;line-height:1.35;color:hsl(var(--muted-foreground));margin-top:.12rem}
      #${CONTROL_ID} .hs-switch{position:relative;width:34px;height:19px;border:0;border-radius:99px;background:hsl(var(--muted));padding:0;cursor:pointer;flex:0 0 auto;transition:.18s}
      #${CONTROL_ID} .hs-switch:after{content:'';position:absolute;width:15px;height:15px;left:2px;top:2px;border-radius:50%;background:white;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:.18s}
      #${CONTROL_ID} .hs-switch[aria-checked="true"]{background:linear-gradient(90deg,#8f650f,#d9b34c)}
      #${CONTROL_ID} .hs-switch[aria-checked="true"]:after{transform:translateX(15px)}
      #${CONTROL_ID} .hs-switch:disabled{opacity:.55;cursor:wait}
      #${CONTROL_ID} .hs-power-result{font-size:.6rem;color:hsl(var(--muted-foreground));min-height:.8rem;margin-top:.4rem}
      @media(max-width:1100px){#${CONTROL_ID} .hs-power-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media(max-width:640px){#${CONTROL_ID} .hs-power-grid{grid-template-columns:1fr}}
    `;document.head.appendChild(s);
  }

  function point(values){
    if(!values.length)return {line:'',area:''};
    const width=100,height=30,min=Math.min(...values),max=Math.max(...values),span=Math.max(max-min,1e-9);
    const coords=values.map((value,index)=>{
      const x=values.length===1?100:(index/(values.length-1))*width;
      const y=height-((value-min)/span)*(height-4)-2;
      return [Number(x.toFixed(2)),Number(y.toFixed(2))];
    });
    const line=coords.map((p,i)=>(i?'L':'M')+p[0]+' '+p[1]).join(' ');
    const area=line+` L ${coords.at(-1)[0]} ${height} L ${coords[0][0]} ${height} Z`;
    return {line,area};
  }

  function push(){
    const state=window.HSShieldDebug?.getState?.()?.status;
    const metrics=state?.metrics;if(!metrics)return;
    for(const key of Object.keys(history)){
      const value=Number(metrics[key]||0);history[key].push(Number.isFinite(value)?value:0);if(history[key].length>MAX)history[key].shift();
    }
  }

  function draw(){
    const root=document.getElementById('hs-shield-root');if(!root)return;
    const cards=[...root.querySelectorAll('.hs-grid .hs-card')];
    const keys=['pps','mbps','syn_recv','established'];
    cards.slice(0,4).forEach((card,index)=>{
      let chart=card.querySelector('.hs-mini-chart');if(!chart){chart=document.createElement('div');chart.className='hs-mini-chart';card.appendChild(chart);}
      const {line,area}=point(history[keys[index]]);
      chart.innerHTML=`<svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><path class="base" d="M0 29.5 L100 29.5"/><path class="area" d="${area}"/><path d="${line}"/></svg>`;
    });
  }

  async function setConfig(key,value,result){
    if(saving)return;
    saving=true;
    document.querySelectorAll(`#${CONTROL_ID} .hs-switch`).forEach(button=>button.disabled=true);
    result.textContent='Applying…';
    try{
      const response=await fetch('/api/hs-shield/config',{method:'PUT',credentials:'same-origin',headers:authHeaders(),body:JSON.stringify({[key]:value})});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.detail||`HTTP ${response.status}`);
      result.textContent=key==='enabled'&&!value?'Firewall disabled; HS nftables rules will be removed.':'Saved.';
      await window.HSShieldDebug?.refresh?.();
    }catch(error){
      result.textContent=error.message||'Unable to update control.';
    }finally{
      saving=false;
      scheduleMount();
    }
  }

  function controls(){
    const root=document.getElementById('hs-shield-root');if(!root)return;
    const wrap=root.querySelector('.hs-wrap');if(!wrap)return;
    const config=window.HSShieldDebug?.getState?.()?.config||{};
    let panel=document.getElementById(CONTROL_ID);
    if(panel&&!root.contains(panel))panel.remove();
    panel=document.getElementById(CONTROL_ID);
    if(!panel){
      panel=document.createElement('section');
      panel.id=CONTROL_ID;
      const anchor=wrap.querySelector('.hs-hero')||wrap.querySelector('.hs-section')||wrap.children[2]||null;
      if(anchor)wrap.insertBefore(panel,anchor);else wrap.appendChild(panel);
    }
    const entries=[
      ['enabled','Firewall','HS nftables enforcement',config.enabled!==false],
      ['telemetry_enabled','Live Monitor','Traffic & connection telemetry',config.telemetry_enabled!==false],
      ['low_cpu_mode','Low CPU','12s sampling + cached health',config.low_cpu_mode!==false],
      ['integration_guard_enabled','Auto Repair','Re-apply HS after panel updates',config.integration_guard_enabled!==false]
    ];
    if(!panel.dataset.ready){
      panel.innerHTML=`<div class="hs-power-head"><div class="hs-power-title"><i></i>Shield controls</div><div class="hs-power-note">Independent controls • no PasarGuard restart</div></div><div class="hs-power-grid">${entries.map(([key,name,desc])=>`<div class="hs-power-item"><div class="hs-power-copy"><div class="hs-power-name">${name}</div><div class="hs-power-desc">${desc}</div></div><button type="button" class="hs-switch" role="switch" aria-label="${name}" aria-checked="false" data-hs-power="${key}"></button></div>`).join('')}</div><div class="hs-power-result" role="status"></div>`;
      panel.dataset.ready='1';
      panel.addEventListener('click',event=>{
        const button=event.target instanceof Element?event.target.closest('[data-hs-power]'):null;
        if(!button||saving)return;
        setConfig(button.dataset.hsPower,button.getAttribute('aria-checked')!=='true',panel.querySelector('.hs-power-result'));
      });
    }
    const stateByKey=Object.fromEntries(entries.map(([key,,,on])=>[key,on]));
    panel.querySelectorAll('[data-hs-power]').forEach(button=>{
      button.setAttribute('aria-checked',stateByKey[button.dataset.hsPower]?'true':'false');
      button.disabled=saving;
    });
  }

  function scheduleMount(){
    if(mountQueued)return;
    mountQueued=true;
    queueMicrotask(()=>{
      mountQueued=false;
      controls();
      draw();
    });
  }

  function watchRoot(){
    const root=document.getElementById('hs-shield-root');
    if(!root){
      if(rootObserver){rootObserver.disconnect();rootObserver=null;}
      observedRoot=null;
      return;
    }
    if(observedRoot===root&&rootObserver)return;
    if(rootObserver)rootObserver.disconnect();
    observedRoot=root;
    rootObserver=new MutationObserver(mutations=>{
      if(mutations.some(mutation=>mutation.type==='childList'))scheduleMount();
    });
    rootObserver.observe(root,{childList:true});
    scheduleMount();
  }

  function tick(){style();watchRoot();push();draw();controls();}
  function boot(){
    tick();
    timer=setInterval(()=>{if(!document.hidden)tick();},5000);
    window.addEventListener('hs-shield:activate',()=>{
      setTimeout(()=>{watchRoot();scheduleMount();},0);
      setTimeout(()=>{watchRoot();scheduleMount();},100);
    });
    window.addEventListener('beforeunload',()=>{
      clearInterval(timer);
      rootObserver?.disconnect();
    },{once:true});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
