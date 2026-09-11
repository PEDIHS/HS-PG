(() => {
  'use strict';
  const STYLE_ID='hs-firewall-charts-style';
  const MAX=36;
  const history={pps:[],mbps:[],syn_recv:[],established:[]};
  let timer=null;

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

  function tick(){style();push();draw();}
  function boot(){tick();timer=setInterval(()=>{if(!document.hidden)tick();},3000);new MutationObserver(()=>requestAnimationFrame(draw)).observe(document.documentElement,{childList:true,subtree:true});window.addEventListener('beforeunload',()=>clearInterval(timer),{once:true});}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
