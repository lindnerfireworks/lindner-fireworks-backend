// Synthetic, local-only storage/API checks. No real mail, data or credentials.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const backend = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lindner-packing-"));
const files = ["products.json", "orders.json", "invoiceCounter.json", "stats.json", "digest-state.json", "inquiries.json"];
const checks = [];
const check = (name, fn) => { fn(); checks.push(name); };
const baseOrder = overrides => ({ id: crypto.randomUUID(), reservationNumber: "RES-2026-0100", status: "reserved",
  createdAt: "2026-10-13T12:00:00.000Z", customerName: "Synthetic Fixture", customerEmail: "test@example.invalid",
  customerPhone: "fixture-only", abholtermin: "Freitag, 06.11.2026, 13:00–16:00 Uhr", pickupDate: "2026-11-06",
  items: [{ id: "aidos", name: "Aidos", qty: 2, price: 10 }], total: 20,
  emails: { customerMailResult: {state:"accepted",providerId:"synthetic-only"} }, customLegacyField: {keep:true}, ...overrides });
const fixtureOrder = baseOrder();
const blocked = [
  baseOrder({status:"cancelled"}), baseOrder({status:"purchased"}), baseOrder({status:"collected"}),
  baseOrder({purchaseCompletedAt:"2026-10-12T12:00:00Z"}), baseOrder({pickupCompletedAt:"2026-10-12T12:00:00Z"}),
  baseOrder({stockRelease:{reason:"reservation_cancelled"}}), baseOrder({cancelledAt:"2026-10-12T12:00:00Z"}),
  baseOrder({pickedUp:true}), baseOrder({fulfilled:true}), baseOrder({partiallyFulfilled:true}),
  baseOrder({fulfillmentStatus:"fulfilled"}), baseOrder({items:[{id:"aidos",qty:2,fulfilledQty:1}]}),
];
function seed(dir, orders) {
  fs.mkdirSync(dir,{recursive:true});
  const values = [ [{id:"aidos",stock:7},{id:"shaolin-6",name:"Shaolin 6",stock:3}], orders,
    {2026:100}, {"2026-10-13":{aidos:{view:2,cart:1}}}, {lastSentFor:"2026-10-12"}, [{id:"synthetic-inquiry",kind:"contact"}] ];
  files.forEach((file,index)=>fs.writeFileSync(path.join(dir,file),JSON.stringify(values[index],null,2)));
}
const read = (dir,file) => JSON.parse(fs.readFileSync(path.join(dir,file),"utf8"));
const bytes = dir => Object.fromEntries(files.map(file=>[file,fs.readFileSync(path.join(dir,file),"utf8")]));
const packingKeys = new Set(["packed","packedAt","packingUpdatedAt","packingVersion"]);
const unrelated = order => Object.fromEntries(Object.entries(order).filter(([key])=>!packingKeys.has(key)));
const apiData = path.join(temp,"api-data"); seed(apiData,[fixtureOrder,...blocked]);
const initial = bytes(apiData);
const preload = path.join(temp,"no-external.cjs");
fs.writeFileSync(preload, `global.fetch=async()=>{throw Error('External requests blocked by packing test');};
if(process.env.TEST_PACKING_WRITE_FAIL==='true'){const fs=require('node:fs/promises');const original=fs.rename;let failed=false;fs.rename=async(from,to)=>{if(!failed&&String(to).endsWith('orders.json')){failed=true;const e=new Error('simulated atomic rename failure');e.code='EACCES';throw e;}return original(from,to);};}`);
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
let run;
async function start(extra={}) {
  const port=47000+Math.floor(Math.random()*3000);let logs="";
  const child=spawn(process.execPath,["--require",preload,path.join(backend,"src/server.js")],{
    cwd:temp,env:{...process.env,PORT:String(port),DATA_DIR:apiData,DIGEST_ENABLED:"false",ADMIN_KEY:"isolated-packing-key",
      ORDERS_OPEN_FROM:"",ORDERS_OPEN_UNTIL:"2027-01-01",RESEND_API_KEY:"",RESEND_FROM:"",OWNER_EMAIL:"",...extra},
    stdio:["ignore","pipe","pipe"],
  });
  child.stdout.on("data",d=>{logs+=d;});child.stderr.on("data",d=>{logs+=d;});
  const base=`http://127.0.0.1:${port}`;
  for(let i=0;i<150;i++){
    try{if((await fetch(base+"/api/health")).ok){run={child,base};return;}}catch{}
    if(child.exitCode!==null)throw Error(logs);
    await delay(40);
  }
  child.kill();throw Error("Local test server unavailable: "+logs);
}
async function stop(){if(run?.child.exitCode===null){run.child.kill();await new Promise(resolve=>run.child.once("exit",resolve));}}
async function post(body,options={}) {
  const response=await fetch(run.base+(options.route||"/api/admin/order-packed"),{method:"POST",
    headers:{"Content-Type":"application/json",Authorization:"Bearer isolated-packing-key",...options.headers},
    body:options.raw!==undefined?options.raw:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
}
const request = (packed,expectedVersion,id=fixtureOrder.id)=>({id,packed,expectedVersion});
function assertPublicState(result) {
  assert.deepEqual(Object.keys(result).sort(),["ok","id","packed","packedAt","packingUpdatedAt","packingVersion"].sort());
}
(async()=>{
  await start();
  check("Startup does not eagerly migrate or rewrite legacy orders",()=>assert.deepEqual(bytes(apiData),initial));
  for(const [name,options] of [
    ["missing auth",{headers:{Authorization:""}}], ["wrong auth",{headers:{Authorization:"Bearer wrong"}}],
    ["URL key does not authorize mutation",{route:"/api/admin/order-packed?key=isolated-packing-key",headers:{Authorization:""}}],
  ]) {const result=await post(request(true,0),options);check(name,()=>{assert.equal(result.status,401);assert.deepEqual(bytes(apiData),initial);});}
  const malformed=await post(null,{raw:"{"});check("Malformed JSON is a controlled 400",()=>assert.equal(malformed.status,400));
  const wrongType=await post(request(true,0),{headers:{"Content-Type":"text/plain"}});check("Non-JSON media type rejected",()=>assert.equal(wrongType.status,415));
  const invalidBodies=[null,[],"text",{},request("true",0),request(1,0),request(true,"0"),request(true,-1),request(true,0.5),request(true,Number.MAX_SAFE_INTEGER+1),
    {packed:true,expectedVersion:0},request(true,0,"bad"),{...request(true,0),customerName:"overwrite"},{...request(true,0),packedAt:"forged"}];
  for(let i=0;i<invalidBodies.length;i++){const result=await post(invalidBodies[i]);check("Strict body rejected "+i,()=>{assert.equal(result.status,400);assert.deepEqual(bytes(apiData),initial);});}
  const missing=await post(request(true,0,crypto.randomUUID()));check("Unknown valid ID is 404",()=>{assert.equal(missing.status,404);assert.equal(missing.body.error,"order_not_found");});
  const falseReplay=await post(request(false,0));check("Legacy false no-op returns defaults without writing",()=>{
    assert.equal(falseReplay.status,200);assertPublicState(falseReplay.body);assert.equal(falseReplay.body.packingVersion,0);assert.equal(falseReplay.body.packedAt,null);
    assert.equal(falseReplay.body.packingUpdatedAt,null);assert.deepEqual(bytes(apiData),initial);
  });
  for(let i=0;i<blocked.length;i++){const result=await post(request(true,0,blocked[i].id));check("Lifecycle/evidence guard "+i,()=>{assert.equal(result.status,409);assert.equal(result.body.error,"order_not_packable");assert.deepEqual(bytes(apiData),initial);});}
  const marked=await post(request(true,0));
  check("Mark packed updates only four fields on target order",()=>{
    assert.equal(marked.status,200);assertPublicState(marked.body);assert.equal(marked.body.packed,true);assert.equal(marked.body.packingVersion,1);
    assert.equal(marked.body.packedAt,marked.body.packingUpdatedAt);assert(!Number.isNaN(Date.parse(marked.body.packedAt)));
    const orders=read(apiData,"orders.json");assert.deepEqual(unrelated(orders[0]),fixtureOrder);assert.deepEqual(orders.slice(1),blocked);
    const changed=bytes(apiData);for(const file of files.filter(file=>file!=="orders.json"))assert.equal(changed[file],initial[file]);
  });
  const packedBytes=bytes(apiData);
  const repeated=await post(request(true,0));check("Repeated setting with stale version is idempotent",()=>{assert.equal(repeated.status,200);assert.deepEqual(repeated.body,marked.body);assert.deepEqual(bytes(apiData),packedBytes);});
  const stale=await post(request(false,0));check("Stale opposite state returns conflict/current state without writing",()=>{
    assert.equal(stale.status,409);assert.equal(stale.body.error,"packing_conflict");assert.equal(stale.body.packed,true);assert.equal(stale.body.packingVersion,1);assert.deepEqual(bytes(apiData),packedBytes);
    assert(!("customerName" in stale.body));
  });
  const unchecked=await post(request(false,1));check("Uncheck clears packedAt and increases version exactly once",()=>{
    assert.equal(unchecked.status,200);assert.equal(unchecked.body.packed,false);assert.equal(unchecked.body.packedAt,null);assert.equal(unchecked.body.packingVersion,2);
    assert.deepEqual(unrelated(read(apiData,"orders.json")[0]),fixtureOrder);
  });
  const beforeRestart=bytes(apiData);await stop();await start();
  check("Restart preserves saved status and all store bytes",()=>assert.deepEqual(bytes(apiData),beforeRestart));
  const repeatUnchecked=await post(request(false,0));check("Restarted no-op returns saved version/timestamp",()=>assert.deepEqual(repeatUnchecked.body,unchecked.body));
  await stop();await start({TEST_PACKING_WRITE_FAIL:"true"});
  const beforeFailure=bytes(apiData);const failed=await post(request(true,2));
  check("Failed atomic save is HTTP 500 and leaves every persistent store unchanged",()=>{assert.equal(failed.status,500);assert.deepEqual(bytes(apiData),beforeFailure);});
  const retry=await post(request(true,2));check("Retry after failed save succeeds without skipped version",()=>{assert.equal(retry.status,200);assert.equal(retry.body.packingVersion,3);});
  await stop();

  const storeData=path.join(temp,"concurrency-data");const a=baseOrder(),b=baseOrder(),c=baseOrder(),d=baseOrder();
  seed(storeData,[a,b,c,d]);process.env.DATA_DIR=storeData;
  const store=require("../src/store");await store.initialize();
  const beforeConcurrent=bytes(storeData);
  await Promise.all([store.setOrderPacked({id:a.id,packed:true,expectedVersion:0}),store.setOrderStatus(b.id,"purchased"),
    store.updateOrder(a.id,{emails:{customerMailResult:{state:"unknown",providerId:"new-synthetic"}}})]);
  check("Concurrent packing, other order status and mail update do not clobber each other",()=>{
    const orders=read(storeData,"orders.json");assert.equal(orders[0].packed,true);assert.equal(orders[0].emails.customerMailResult.state,"unknown");assert.equal(orders[1].status,"purchased");
    for(const file of files.filter(file=>file!=="orders.json"))assert.equal(bytes(storeData)[file],beforeConcurrent[file]);
  });
  await Promise.all([store.setOrderPacked({id:a.id,packed:false,expectedVersion:1}),store.setOrderStatus(a.id,"purchased")]);
  check("Same-order status after packing retains packing fields",()=>{const order=read(storeData,"orders.json")[0];assert.equal(order.status,"purchased");assert.equal(order.packed,false);assert.equal(order.packingVersion,2);});
  const statusFirst=await Promise.all([store.setOrderStatus(c.id,"purchased"),store.setOrderPacked({id:c.id,packed:true,expectedVersion:0})]);
  check("Same-order fulfilment before packing prevents packing",()=>{assert.equal(statusFirst[1].reason,"order_not_packable");assert.equal(read(storeData,"orders.json")[2].status,"purchased");assert(!("packed" in read(storeData,"orders.json")[2]));});
  await Promise.all([store.setOrderPacked({id:d.id,packed:true,expectedVersion:0}),store.cancelReservation({id:d.id,apply:true,confirm:"CANCEL "+d.reservationNumber})]);
  check("Concurrent cancellation preserves packing and completes stock release once",()=>{
    const order=read(storeData,"orders.json")[3];assert.equal(order.status,"cancelled");assert.equal(order.packed,true);assert.equal(order.packingVersion,1);
    assert.equal(order.stockRelease.totalQuantity,2);assert.equal(read(storeData,"products.json")[0].stock,9);
  });
  const afterCancellation=bytes(storeData);const refused=await store.setOrderPacked({id:d.id,packed:true,expectedVersion:0});
  check("Cancelled identical-state replay remains lifecycle-blocked and writes nothing",()=>{assert.equal(refused.reason,"order_not_packable");assert.deepEqual(bytes(storeData),afterCancellation);});
  console.log(JSON.stringify({passed:checks.length,checks,isolatedRoot:temp},null,2));
})().catch(async error=>{await stop();console.error(error);process.exitCode=1;});
