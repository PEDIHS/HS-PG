const {chromium}=require('playwright');
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1100,height:820}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  let saved=null, deleted=false, nativeSaves=0, fair=false;
  await page.route('http://hs-user.test/**',async route=>{
    const u=new URL(route.request().url()); let data={};
    if(u.pathname==='/api/hs-plugin/state') data={features:{fair_use:{enabled:true}},hosts:[]};
    else if(u.pathname==='/api/hs-services/fair-use') data={policies:{},group_policies:{},user_policies:saved?{'1':saved}:{},fair_status_hosts:[],shared_hosts:{},groups:[],enforcement_available:true};
    else if(u.pathname==='/api/groups') data={groups:[]};
    else if(u.pathname==='/api/users') data={users:[{id:1,username:'alice',status:'active',hs_status:'active',hs_fair_configured:fair}],hs_fair_use_enabled:true};
    else if(u.pathname==='/api/user/alice' && route.request().method()==='GET'){data={id:1,username:'alice',status:'active'};}
    else if(u.pathname==='/api/user/alice' && route.request().method()==='PUT'){nativeSaves++;data={id:1,username:'alice',status:'active'};}
    else if(u.pathname==='/api/hs-services/users/1/fair-use' && route.request().method()==='PUT'){
      saved=route.request().postDataJSON();fair=true;data={user_id:1,policy:{...saved,mode:'always',threshold_bytes:0}};
    } else if(u.pathname==='/api/hs-services/users/1/fair-use' && route.request().method()==='DELETE'){
      saved=null;fair=false;deleted=true;data={ok:true,user_id:1};
    } else if(!u.pathname.startsWith('/api/')) return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body><div id="root"></div></body></html>'});
    return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });  await page.goto('http://hs-user.test/dashboard/#/users');
  await page.evaluate(()=>localStorage.setItem('token','test'));
  await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../plugin/hs-host-fair.js'),'utf8')});
  // Do not pre-load /api/users: Edit User must resolve its ID directly from native /api/user/{username}.
  await page.evaluate(()=>{
    const d=document.createElement('div');d.setAttribute('role','dialog');
    d.innerHTML='<form><div class="-mr-4 max-h-[80dvh] overflow-y-auto px-2 pr-4"><input name="username" value="alice" disabled><div>Native User fields</div></div><div class="native-footer"><button type="submit">Save</button></div></form>';
    d.querySelector('form').addEventListener('submit',e=>{e.preventDefault();fetch('/api/user/alice',{method:'PUT',headers:{'Content-Type':'application/json'},body:'{}'});});
    document.body.appendChild(d);
  });
  await page.waitForSelector('#hs-user-fair-use');
  assert.equal(await page.locator('#hs-user-fair-use .hs-fair-hs-tag').first().innerText(),'HS');
  assert(await page.locator('.overflow-y-auto').evaluate((scroll,fair)=>scroll.contains(fair),await page.locator('#hs-user-fair-use').elementHandle()));
  await page.locator('#hs-user-fair-use summary').click();
  assert((await page.locator('#hs-user-fair-use').innerText()).includes('this User'));
  await page.locator('#hs-user-fair-use [data-fair-switch]').click();
  assert.equal(await page.locator('#hs-user-fair-use').getAttribute('data-enabled'),'1');
  await page.locator('#hs-user-fair-use [data-fair=base]').fill('120');
  await page.locator('#hs-user-fair-use [data-fair=percent]').fill('25');
  await Promise.all([page.waitForResponse(r=>r.url().endsWith('/users/1/fair-use')&&r.request().method()==='PUT'),page.locator('form button[type=submit]').click()]);
  assert.equal(nativeSaves,1); assert.deepEqual(saved,{mode:'always',threshold_bytes:0,baseline_mbps:120,speed_percent:25});
  await page.evaluate(()=>{const table=document.createElement('table');table.innerHTML='<tbody><tr><td><span>alice</span></td><td><span class="pointer-events-none rounded-full bg-emerald-500/10 text-emerald-700">Active</span></td></tr></tbody>';document.body.appendChild(table);return fetch('/api/users');});
  await page.waitForSelector('[data-hs-fair-badge]');
  assert((await page.locator('[data-hs-fair-badge]').innerText()).includes('Fair Use'));
  assert.equal(await page.locator('[data-hs-fair-badge] .hs-fair-split-native').innerText(),'Active');
  await page.waitForTimeout(80);
  await page.locator('#hs-user-fair-use [data-fair-switch]').click();
  assert.equal(await page.locator('#hs-user-fair-use').getAttribute('data-enabled'),'0');
  await Promise.all([page.waitForResponse(r=>r.url().endsWith('/users/1/fair-use')&&r.request().method()==='DELETE'),page.locator('form button[type=submit]').click()]);
  assert.equal(deleted,true);
  await page.evaluate(()=>{document.querySelector('[role=dialog]').remove();const d=document.createElement('div');d.setAttribute('role','dialog');d.innerHTML='<form><div class="max-h-[80dvh] overflow-y-auto"><input name="username" value="newuser"><div>Native create fields</div></div><button type="submit">Create</button></form>';document.body.appendChild(d);});
  await page.waitForTimeout(80);
  assert.equal(await page.locator('#hs-user-fair-use').count(),0);
  assert.deepEqual(errors,[]);
  console.log('User Fair Use settings regression passed');
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
