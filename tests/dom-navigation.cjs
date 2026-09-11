const {JSDOM}=require('jsdom');
const fs=require('fs');const path=require('path');const assert=require('node:assert/strict');
(async()=>{
 const dom=new JSDOM('<!doctype html><html><head></head><body><aside><ul><li><a href="/nodes" data-sidebar="menu-button">Nodes</a></li></ul></aside><main class="dashboard-scroll"><div class="flex min-h-0 w-full flex-1 flex-col justify-between"><div class="flex min-h-0 flex-1 flex-col"><div id="native-page">Native page</div></div><footer>PasarGuard</footer></div></main></body></html>',{url:'http://hs.test/nodes',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window;const observers=[];const Observer=w.MutationObserver;w.MutationObserver=class extends Observer{constructor(cb){super(cb);observers.push(this);}};w.Headers=Headers;Object.defineProperty(w.crypto,'randomUUID',{value:undefined});const errors=[];w.addEventListener('error',e=>errors.push(e.message));w.console={...console,info:()=>{}};
 const state={features:{host_usage_ratio:{enabled:true},node_pro:{enabled:true}},hosts:[{id:1,remark:'Host 1'}]};
 const shield={status:{mode:'observe',stage:'normal',updated_at:new Date().toISOString(),enforcement:{active:false,pending:null,error:null},metrics:{pps:12,mbps:2},layers:{}},config:{enabled:true,telemetry_enabled:true,low_cpu_mode:true,integration_guard_enabled:true,auto_stage:true,mode:'observe',policy:{management_ports:[22],rules:[],syn_ports:[],syn_rate:100}},events:[]};
 const inventory={targets:[{id:'panel',name:'Main panel',online:true,certificates:[{id:'example.com',domains:['example.com'],provider:'certbot',renewable:true,expires_at:Date.now()/1000+86400*20,starts_at:Date.now()/1000-86400*70}],proxies:[]}],node_trust:[],jobs:[]};
 const requests=[];w.fetch=async(url,options={})=>{requests.push(url);let data={};if(url==='/api/hs-plugin/state')data=state;else if(url==='/api/hs-shield/status')data=shield;else if(url==='/api/hs-services/inventory')data=inventory;else if(url==='/api/hs-services/fair-use')data={policies:{},blocker:'Rate adapter required'};else if(url==='/api/cores')data={cores:[]};else if(url==='/api/hs-shield/config'){Object.assign(shield.config,JSON.parse(options.body));data={ok:true,config:shield.config};}else if(url==='/api/hs-shield/confirm'){const body=JSON.parse(options.body);assert.equal(body.token,'confirm-token');shield.status.enforcement={active:true,pending:null,error:null};data={ok:true};}return {ok:true,status:200,json:async()=>structuredClone(data)};};
 for(const file of ['hs-plugin.js','hs-tab-fix.js','hs-shield.js','hs-services.js','hs-firewall-charts.js'])w.eval(fs.readFileSync(path.join(__dirname,'../plugin',file),'utf8'));
 w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
 const tick=()=>new Promise(r=>setTimeout(r,35));await tick();await tick();
 const q=s=>{const el=w.document.querySelector(s);assert(el,'Missing '+s);return el;};
 const click=async s=>{q(s).click();await tick();};
 assert(q('#hs-plugin-submenu').hidden);await click('.hs-plugin-menu-action');assert(!q('#hs-plugin-submenu').hidden);await click('.hs-plugin-menu-action');assert(q('#hs-plugin-submenu').hidden);
 await click('[data-hs-parent]');q('#hs-plugin-root');q('#hs-plugin-top-tabs [data-service-tab=firewall]');
 await click('[data-service-tab=firewall]');q('#hs-shield-root');assert(!w.document.querySelector('#hs-plugin-root'));
 await tick();q('#hs-shield-power-controls');assert.equal(w.document.querySelectorAll('#hs-shield-power-controls').length,1);
 await w.HSShieldDebug.refresh();await tick();await w.HSShieldDebug.refresh();await tick();q('#hs-shield-power-controls');assert.equal(w.document.querySelectorAll('#hs-shield-power-controls').length,1);

 // The four controls must mutate real config, not just their visual state.
 assert.equal(q('[data-hs-power=firewall]').getAttribute('aria-checked'),'false');
 await click('[data-hs-power=firewall]');assert.equal(shield.config.mode,'enforce');assert.equal(shield.config.enabled,true);assert.equal(q('[data-hs-power=firewall]').getAttribute('aria-checked'),'true');
 shield.status.enforcement={active:true,pending:{token:'confirm-token',deadline:Date.now()/1000+45},error:null};await w.HSShieldDebug.refresh();await tick();q('[data-hs-confirm]');await click('[data-hs-confirm]');assert.equal(shield.status.enforcement.active,true);
 await click('[data-hs-power=telemetry_enabled]');assert.equal(shield.config.telemetry_enabled,false);assert.equal(q('[data-hs-power=telemetry_enabled]').getAttribute('aria-checked'),'false');
 await click('[data-hs-power=low_cpu_mode]');assert.equal(shield.config.low_cpu_mode,false);assert.equal(q('[data-hs-power=low_cpu_mode]').getAttribute('aria-checked'),'false');
 await click('[data-hs-power=integration_guard_enabled]');assert.equal(shield.config.integration_guard_enabled,false);assert.equal(q('[data-hs-power=integration_guard_enabled]').getAttribute('aria-checked'),'false');
 await click('[data-hs-power=firewall]');assert.equal(shield.config.mode,'observe');assert.equal(shield.config.enabled,false);assert.equal(q('[data-hs-power=firewall]').getAttribute('aria-checked'),'false');

 await click('[data-shield-section=rules]');q('input[name=source]').value='192.0.2.0/24';await w.HSShieldDebug.refresh();assert.equal(q('input[name=source]').value,'192.0.2.0/24');
 q('[data-add]').dispatchEvent(new w.Event('submit',{cancelable:true,bubbles:true}));await tick();await click('[data-save]');assert.equal(shield.config.policy.rules[0].source,'192.0.2.0/24');
 await click('[data-service-tab=certificates]');assert(!q('[data-renew]').disabled);assert(!w.document.querySelector('#hs-shield-root'));await click('[data-renew]');assert(requests.includes('/api/hs-services/targets/panel/renew'));
 await click('[data-service-tab=features]');q('#hs-plugin-root');assert(!w.document.querySelector('#hs-services-root'));
 await click('[data-hs-sub=firewall]');q('#hs-shield-root');await click('[data-service-tab=fair]');q('[data-preview-user]');await click('[data-service-tab=mtproxy]');q('input[name=metrics_port]');
 w.HSServices.close();assert.equal(q('#native-page').style.display,'');assert.deepEqual(errors,[]);
 observers.forEach(o=>o.disconnect());await tick();dom.window.close();console.log('DOM regression: stable Firewall controls perform real config actions, form persistence, renewal and native restore passed');
})().catch(e=>{console.error(e);process.exit(1);});
