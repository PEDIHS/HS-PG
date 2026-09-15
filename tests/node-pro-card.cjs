const {chromium}=require('playwright'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
(async()=>{
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1080,height:720}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  let nodeRequests=0,statsRequests=0;
  await page.route('http://hs.test/**',async route=>{
    const u=new URL(route.request().url()); let data={};
    if(u.pathname==='/api/hs-plugin/state') data={features:{node_pro:{enabled:true}}};
    else if(u.pathname==='/api/nodes'){nodeRequests++;data={nodes:[{id:7,name:'TR',address:'1.2.3.4',port:62050}]};}
    else if(u.pathname==='/api/nodes/realtime_stats'){statsRequests++;data={'7':{mem_total:4101693440,mem_used:1460288880,cpu_cores:2,cpu_usage:32,incoming_bandwidth_speed:5600000,outgoing_bandwidth_speed:1100000,uptime:5000}};}
    else return route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:20px;font-family:Arial}.relative{position:relative}.overflow-hidden{overflow:hidden}.border{border:1px solid #333}.rounded-lg{border-radius:12px}.p-3{padding:12px}.min-w-0{min-width:0}.flex-1{flex:1}#card{width:420px;background:#111;color:#eee;--card:#111;--border:#333;--foreground:#eee;--muted:#20242a;--muted-foreground:#9aa4b2;--primary:#fff}</style></head><body><div id="card" class="relative overflow-hidden border rounded-lg"><div class="p-3"><div class="min-w-0 flex-1"><h3>TR</h3><span dir="ltr">1.2.3.4:62050</span></div></div></div></body></html>'});
    await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto('http://hs.test/nodes');
  await page.evaluate(()=>localStorage.setItem('token','test'));
  await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../plugin/hs-node-pro.js'),'utf8')});
  await page.waitForSelector('.hs-node-pro [data-hs-network="rx"]');
  const block=page.locator('.hs-node-pro'),rx=page.locator('[data-hs-network="rx"]'),tx=page.locator('[data-hs-network="tx"]');
  assert.match(await rx.innerText(),/RX[\s\S]*42\.7 Mbps[\s\S]*RECEIVE/);
  assert.match(await tx.innerText(),/TX[\s\S]*8\.4 Mbps[\s\S]*SEND/);
  assert.equal(await rx.locator('svg').count(),1); assert.equal(await tx.locator('svg').count(),1);
  const sizes=await block.evaluate(el=>({rx:el.querySelector('[data-hs-network=\"rx\"]')?.getBoundingClientRect().height||0,block:el.getBoundingClientRect().height}));
  assert(sizes.rx>0&&sizes.rx<=52,`live metric height out of bounds: ${sizes.rx}`);
  assert(sizes.block>0&&sizes.block<=132,`Node PRO block height out of bounds: ${sizes.block}`);
  assert(await page.locator('#card').evaluate(el=>el.classList.contains('hs-node-pro-card')));
  await page.waitForTimeout(2200);
  assert(statsRequests>=2,`expected realtime refresh, got ${statsRequests}`);
  assert.equal(nodeRequests,1,'node inventory must stay cached while realtime stats refresh');
  assert.deepEqual(errors,[]);
  console.log('Node PRO compact live RX/TX card regression passed');
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
