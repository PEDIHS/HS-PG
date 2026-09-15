(() => {
 'use strict';
 const ID='hs-host-fair-use';let raw=window.fetch.bind(window),listEnabled=false;
 let state=null,settings=null,hosts=[],loading=false;const users=new Map();
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const headers=()=>{const h={'Content-Type':'application/json'},t=localStorage.getItem('token');if(t)h.Authorization='Bearer '+t;return h;};
 async function api(path,body,method){const r=await raw(path,{credentials:'same-origin',headers:headers(),method:method||(body?'PUT':'GET'),...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok)throw Error(typeof data.detail==='string'?data.detail:JSON.stringify(data.detail));return data;}
 const input='flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
 function error(message){let e=document.getElementById('hs-fair-error');if(!e){e=document.createElement('div');e.id='hs-fair-error';e.setAttribute('role','alert');e.className='bg-card text-destructive fixed bottom-4 right-4 z-50 max-w-md rounded-lg border p-4 shadow';document.body.appendChild(e);}e.textContent=message;}
 async function load(){if(loading)return;loading=true;listEnabled=false;try{[state,settings]=await Promise.all([api('/api/hs-plugin/state'),api('/api/hs-services/fair-use')]);hosts=state.hosts||[];if(!state.features?.fair_use?.enabled&&selected())clearFilter();}catch{}finally{loading=false;scan();}}
 function identify(dialog){const id=dialog.querySelector('#hs-host-usage-ratio')?.dataset.hostId;if(Number(id)>0)return id;const remark=dialog.querySelector('[name=remark]')?.value;const matches=hosts.filter(h=>h.remark===remark);return matches.length===1?String(matches[0].id):'';}
 function data(field){const f=name=>field.querySelector('[data-fair='+name+']');if(!f('enabled').checked)return null;const value={threshold_bytes:Math.round(Number(f('gb').value)*1e9),baseline_mbps:Number(f('base').value),speed_percent:Number(f('percent').value)};if(value.threshold_bytes<=0||!Number.isSafeInteger(value.threshold_bytes)||!Number.isFinite(value.baseline_mbps)||!Number.isFinite(value.speed_percent)||value.baseline_mbps<.1||value.baseline_mbps>100000||value.speed_percent<1||value.speed_percent>100)throw Error('Enter a positive threshold, baseline speed and percentage between 1 and 100.');return value;}
 async function save(field,id){const body=data(field);await api('/api/hs-services/hosts/'+id+'/fair-use',body,body?'PUT':'DELETE');field.dataset.dirty='0';if(body)(settings.policies ||= {})[id]=body;else delete settings.policies[id];field.querySelector('[data-result]').textContent='Saved. The connected node will synchronize the policy.';}
 function hostField(dialog){if(dialog.querySelector('#'+ID))return;const form=dialog.querySelector('form');if(!form?.querySelector('[name=remark]'))return;
  const id=identify(dialog),p=settings?.policies?.[id];const field=document.createElement('details');field.id=ID;field.dataset.hostId=id;field.className='rounded-sm border px-4';
  field.innerHTML=`<summary class="flex cursor-pointer items-center gap-2 py-4 text-sm font-medium">Fair Use <span class="hs-gold text-xs">HS</span><span style="margin-inline-start:auto">⌄</span></summary><div class="space-y-4 pb-4"><label class="flex items-center gap-2 text-sm"><input type="checkbox" data-fair="enabled" ${p?'checked':''}> Enable fair use for this Host</label><div class="grid gap-3 sm:grid-cols-3"><label class="space-y-2 text-xs">Threshold (GB)<input class="${input}" type="number" min="0.001" step="0.001" data-fair="gb" value="${p?p.threshold_bytes/1e9:100}"></label><label class="space-y-2 text-xs">Full speed (Mbps)<input class="${input}" type="number" min="0.1" max="100000" step="0.1" data-fair="base" value="${p?.baseline_mbps||100}"></label><label class="space-y-2 text-xs">Speed after threshold (%)<input class="${input}" type="number" min="1" max="100" data-fair="percent" value="${p?.speed_percent||20}"></label></div><label class="flex items-center gap-2 text-sm" style="color:#ea580c"><input type="checkbox" disabled data-fair="eligible" ${p?'checked':''}> Fair limited</label><p class="text-muted-foreground text-xs" data-rate></p><p class="text-muted-foreground text-xs">Requires a dedicated inbound on one node for this Host. Uses each user's own total charged traffic in the current quota cycle. A traffic reset restores full speed.</p><p class="text-muted-foreground text-xs">${settings?.enforcement_available?'HS rate adapter connected.':'Node setup required: HS-enabled Xray core and HS service agent.'}</p><button type="button" class="${input} w-auto" data-save-fair ${id?'':'disabled'}>Save Fair Use</button><p role="status" class="text-xs" data-result>${id?'':'Save this Host to create its policy.'}</p></div>`;
  const target=[...form.querySelectorAll('div')].find(e=>e.children.length>1&&String(e.className).includes('overflow-y-auto'))||form;target.appendChild(field);
  const update=()=>{const f=n=>field.querySelector('[data-fair='+n+']');f('eligible').checked=f('enabled').checked;field.querySelector('[data-rate]').textContent=`${Number(f('base').value)} Mbps × ${Number(f('percent').value)}% = ${(Number(f('base').value)*Number(f('percent').value)/100).toFixed(2)} Mbps`;};update();
  field.addEventListener('input',event=>{field.dataset.dirty='1';if(event.target.dataset.fair==='gb'&&Number(event.target.value)>0)field.querySelector('[data-fair=enabled]').checked=true;update();});field.querySelector('[data-save-fair]').onclick=async e=>{e.currentTarget.disabled=true;try{await save(field,id);}catch(err){field.querySelector('[data-result]').textContent=err.message;}finally{field.querySelector('[data-save-fair]').disabled=false;}};
 }
 function badges(){for(const row of document.querySelectorAll('tbody tr')){const u=[...users.values()].find(u=>[...row.querySelectorAll('span')].some(s=>s.textContent===u.username));if(!u)continue;const badge=row.querySelector('.pointer-events-none.rounded-full');if(!badge)continue;const previous=row.querySelector('[data-hs-fair-badge]');if(u.hs_status==='fair_limited'){if(!badge.hasAttribute('data-hs-original-display'))badge.dataset.hsOriginalDisplay=badge.style.display;badge.style.display='none';if(!previous){const b=document.createElement('span');b.dataset.hsFairBadge='1';b.textContent='Fair limited';b.style.cssText='display:inline-flex;align-items:center;border-radius:999px;padding:3px 9px;font-size:12px;color:#ea580c;background:rgba(234,88,12,.1);border:1px solid rgba(234,88,12,.25)';badge.after(b);}}else{badge.style.display=badge.dataset.hsOriginalDisplay||'';delete badge.dataset.hsOriginalDisplay;previous?.remove();}}}
 function selected(){return new URL(location.href).searchParams.has('hs_fair_limited');}
 function clearFilter(){const url=new URL(location.href);url.searchParams.delete('hs_fair_limited');history.replaceState(history.state,'',url.href);document.getElementById('hs-fair-filter')?.setAttribute('aria-pressed','false');}
 function filter(){
  const existing=document.getElementById('hs-fair-filter');if(existing){existing.setAttribute('aria-pressed',String(selected()));return;}
  const active=[...document.querySelectorAll('button')].find(b=>/^(Active|فعال)$/i.test(b.textContent.trim())&&b.parentElement.querySelectorAll(':scope>button').length>=5);if(!active)return;
  const group=active.parentElement,b=document.createElement('button');b.id='hs-fair-filter';b.type='button';b.className=active.className;b.textContent='Fair limited';b.style.color='#ea580c';b.setAttribute('aria-pressed',String(selected()));
  b.onclick=()=>{const url=new URL(location.href);if(selected())url.searchParams.delete('hs_fair_limited');else url.searchParams.set('hs_fair_limited','1');
   if(url.hash.startsWith('#/')){const route=new URL(url.hash.slice(1),url.origin);for(const key of ['status','offset','page'])route.searchParams.delete(key);url.hash=route.pathname+route.search;}
   else for(const key of ['status','offset','page'])url.searchParams.delete(key);
   location.assign(url.href);
  };
  if(!group.dataset.hsFairCapture){group.dataset.hsFairCapture='1';group.addEventListener('click',event=>{const button=event.target.closest('button');if(button&&button.parentElement===group&&button.id!=='hs-fair-filter')clearFilter();},true);}
  group.appendChild(b);
 }
 function scan(){if(state?.features?.fair_use?.enabled)document.querySelectorAll('[role=dialog]').forEach(hostField);if(listEnabled||state?.features?.fair_use?.enabled){badges();filter();}else{
  document.querySelectorAll('[data-hs-original-display]').forEach(e=>{e.style.display=e.dataset.hsOriginalDisplay;delete e.dataset.hsOriginalDisplay;});
  document.querySelectorAll('#'+ID+',#hs-fair-filter,[data-hs-fair-badge]').forEach(e=>e.remove());
 }}
 function boot(){raw=window.fetch.bind(window);
 window.fetch=async(input,init={})=>{let url=new URL(typeof input==='string'?input:input.url,location.origin);const method=(init.method||input.method||'GET').toUpperCase();let pending=null;
  if(url.origin===location.origin&&/\/api\/host(?:\/\d+|\/)?$/.test(url.pathname)&&['POST','PUT'].includes(method)){const field=document.querySelector('#'+ID+'[data-dirty="1"]');if(field){try{pending={field,body:data(field)};}catch(e){error(e.message);throw e;}}}
  if(url.origin===location.origin&&url.pathname==='/api/users'&&selected()){url.searchParams.set('hs_fair_limited','true');url.searchParams.delete('status');input=typeof input==='string'?url.href:new Request(url.href,input);}
  const response=await raw(input,init);
  if(response.ok&&url.origin===location.origin){
   if(pending){const result=await response.clone().json();try{if(!result.id)throw Error('Host ID missing from save response');await api('/api/hs-services/hosts/'+result.id+'/fair-use',pending.body,pending.body?'PUT':'DELETE');pending.field.dataset.dirty='0';load();}catch(e){error('Host saved, but Fair Use failed: '+e.message);}}
   if(url.pathname==='/api/users'){const payload=await response.clone().json();listEnabled=payload.hs_fair_use_enabled===true;users.clear();for(const u of payload.users||[])users.set(u.username,u);requestAnimationFrame(scan);}
  }
  return response;
 };
 let queued=false;new MutationObserver(()=>{if(!queued){queued=true;requestAnimationFrame(()=>{queued=false;scan();});}}).observe(document.body,{childList:true,subtree:true});
 window.addEventListener('hs-plugin-feature-changed',load);load();
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
