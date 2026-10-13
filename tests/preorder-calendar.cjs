// Runs only against a temporary data directory and an intercepted mail service.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const backend = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lindner-preorders-"));
const checks = [];
function check(name, fn) { fn(); checks.push(name); }
const pickup = require("../src/pickup");
const cases = [
  ["2026-10-13T12:00:00+02:00", "2026-11-06"],
  ["2026-11-04T23:59:59+01:00", "2026-11-06"],
  ["2026-11-05T00:00:00+01:00", "2026-11-13"],
  ["2026-11-11T10:00:00+01:00", "2026-11-13"],
  ["2026-11-12T10:00:00+01:00", "2026-11-20"],
];
for (const [now, first] of cases) check("Requested boundary " + now, () => {
  const options = pickup.pickupOptions(new Date(now));
  assert.equal(options[0].date, first);
  assert.equal(options[0].timeWindow, "13:00–16:00 Uhr");
  assert.equal(options[1].timeWindow, "09:00–12:00 Uhr");
});
check("Invalid dates and hard November lower bound", () => {
  assert.equal(pickup.calendarDate("2026-02-30"), null);
  assert.equal(pickup.slotForDay(new Date("2026-10-30T12:00Z")), null);
});
check("Daily December lead, closed days, end of season", () => {
  const options = pickup.pickupOptions(new Date("2026-12-25T10:00:00+01:00"));
  assert.deepEqual(options.map(option => option.date), ["2026-12-27", "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31"]);
  assert(options.every(option => option.kind === "daily" && option.timeWindow === "08:00–12:00 Uhr"));
  assert.deepEqual(pickup.pickupOptions(new Date("2026-12-29T10:00:00+01:00")).map(option => option.date), ["2026-12-31"]);
  assert.deepEqual(pickup.pickupOptions(new Date("2026-12-30T00:00:00+01:00")), []);
  for (const day of ["2026-12-24", "2026-12-25", "2026-12-26", "2027-01-01"]) assert.equal(pickup.slotForDay(new Date(day + "T12:00Z")), null);
});
for (const zone of ["UTC", "Europe/Vienna", "America/Los_Angeles", "Pacific/Auckland"]) check("Host timezone independent " + zone, () => {
  const result = spawnSync(process.execPath, ["-e", `const p=require(${JSON.stringify(path.join(backend, "src/pickup.js"))});process.stdout.write(JSON.stringify(${JSON.stringify(cases)}.map(([now])=>p.pickupOptions(new Date(now))[0].date)))`], {
    env: { ...process.env, TZ: zone }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), cases.map(row => row[1]));
});
const clockFile = path.join(temp, "clock.cjs");
fs.writeFileSync(clockFile, `const RealDate=Date;global.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[process.env.TEST_CLOCK]));}static now(){return RealDate.parse(process.env.TEST_CLOCK);}};`);
const data = path.join(temp, "data"); fs.mkdirSync(data);
const old = { id: crypto.randomUUID(), reservationNumber: "RES-2026-0001", createdAt: "2026-09-01T10:00:00.000Z",
  customerName: "Historical Fixture", customerEmail: "old@example.invalid", abholtermin: "Freitag, 30.10.2026, 13:00–16:00 Uhr",
  pickupDate: "2026-10-30", status: "reserved", items: [{ id: "aidos", qty: 1, price: 1 }], total: 1 };
const write = (name, value) => fs.writeFileSync(path.join(data, name), JSON.stringify(value));
const read = name => JSON.parse(fs.readFileSync(path.join(data, name), "utf8"));
write("products.json", [{ id: "aidos", name: "Aidos", stock: 7 }]); write("orders.json", [old]); write("invoiceCounter.json", { 2026: 1 });
fs.writeFileSync(path.join(data, "mail.jsonl"), "");
let running;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start(clock) {
  const port = 48000 + Math.floor(Math.random() * 4000);
  let logs = "";
  const child = spawn(process.execPath, ["--require", clockFile, "--require", path.join(__dirname, "mock-resend.cjs"), path.join(backend, "src/server.js")], {
    cwd: temp, env: { ...process.env, PORT: String(port), TEST_CLOCK: clock, DATA_DIR: data,
      DIGEST_ENABLED: "false", ORDERS_OPEN_FROM: "", ORDERS_OPEN_UNTIL: "2027-01-01",
      ORDER_LEAD_DAYS: "2", PICKUP_FIRST_DAY: "2026-11-01", PICKUP_LAST_DAY: "2026-12-31",
      PICKUP_DAILY_FROM: "2026-12-27", PICKUP_DAILY_UNTIL: "2026-12-31", PICKUP_CLOSED: "2026-12-24,2026-12-25,2026-12-26",
      RESEND_API_KEY: "fake-isolated-key", RESEND_FROM: "Test <test@example.invalid>", OWNER_EMAIL: "owner@example.invalid",
      ABHOL_ADRESSE: "Private Fixture", ABHOL_ANFAHRT_URL: "https://maps.app.goo.gl/test-route", MAIL_LOG: path.join(data, "mail.jsonl") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => { logs += chunk; }); child.stderr.on("data", chunk => { logs += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + "/api/health")).ok) { running = {child,base}; return; } } catch {}
    if (child.exitCode !== null) throw Error(logs);
    await delay(40);
  }
  child.kill(); throw Error("No test server: " + logs);
}
async function stop() { if (running?.child.exitCode === null) { running.child.kill(); await new Promise(resolve => running.child.once("exit", resolve)); } }
async function post(body) {
  const response = await fetch(running.base + "/api/order", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(body) });
  return {status:response.status,body:await response.json()};
}
function request(date, qty = 1) { return { requestId: crypto.randomUUID(), customerName:"Isolated Buyer",customerEmail:"test@example.invalid",ageConfirmed:true,pickupDate:date,items:[{id:"shaolin-6",qty}] }; }
(async () => {
  await start("2026-11-04T23:59:59+01:00");
  check("Additive startup preserves historical order and other stock", () => {
    assert.deepEqual(read("orders.json"), [old]);
    assert.deepEqual(read("products.json").find(product => product.id === "aidos"), {id:"aidos",name:"Aidos",stock:7});
    assert.equal(read("products.json").find(product => product.id === "shaolin-6").stock, 3);
  });
  const apiOptions = await (await fetch(running.base + "/api/pickup-options")).json();
  check("Server-owned public API options and timezone", () => {assert.equal(apiOptions.timeZone,"Europe/Vienna");assert.equal(apiOptions.options[0].date,"2026-11-06");assert.equal(apiOptions.open,true);});
  const invalid = await post(request("2026-10-30"));
  check("Direct API earlier pickup rejected without stock change", () => {assert.equal(invalid.status,400);assert.equal(invalid.body.error,"invalid_pickup_date");assert.equal(read("products.json").find(p=>p.id==="shaolin-6").stock,3);});
  const selectedRequest = request("2026-11-07", 2);
  const created = await post(selectedRequest);
  check("Chosen Saturday stored consistently and price from catalog", () => {
    assert.equal(created.status,200);assert.equal(created.body.order.pickupDate,"2026-11-07");
    assert.equal(created.body.order.pickupTimeWindow,"09:00–12:00 Uhr");assert.equal(created.body.order.abholtermin,"Samstag, 07.11.2026, 09:00–12:00 Uhr");
    assert.equal(created.body.order.items[0].price,109.9);assert.equal(created.body.order.total,219.8);
    const mails=fs.readFileSync(path.join(data,"mail.jsonl"),"utf8").trim().split("\n").map(JSON.parse);
    assert.equal(mails.length,2);assert(mails.every(mail=>mail.text.includes(created.body.order.abholtermin)));assert(mails[0].attachments[0].content.length>100);
    assert(mails[0].text.includes("erst nach vorheriger Verständigung per E-Mail"));
  });
  await stop(); await start("2026-11-05T00:00:00+01:00");
  const retry = await post(selectedRequest);
  check("Retry after cutoff keeps date/id and never reinitializes stock", () => {
    assert.equal(retry.status,200);assert.equal(retry.body.duplicate,true);assert.equal(retry.body.order.id,created.body.order.id);
    assert.equal(retry.body.order.abholtermin,created.body.order.abholtermin);assert.equal(read("products.json").find(p=>p.id==="shaolin-6").stock,1);
  });
  const tooEarly = await post({...request("2026-11-06"),createdAt:"2026-11-04T20:00Z",serverTime:"2026-11-04T20:00Z"});
  check("Thursday cutoff cannot be bypassed with client time",()=>{assert.equal(tooEarly.status,400);assert.equal(tooEarly.body.error,"invalid_pickup_date");});
  const changed = await post({...selectedRequest,pickupDate:"2026-11-14"});
  check("Reused request ID with another date conflicts",()=>{assert.equal(changed.status,409);assert.equal(changed.body.error,"request_conflict");});
  await stop();await start("2026-11-05T00:00:00+01:00");
  const concurrent = await Promise.all([post(request("2026-11-13")),post(request("2026-11-14"))]);
  check("Parallel final unit has one winner and no oversell",()=>{
    assert.deepEqual(concurrent.map(result=>result.status).sort(),[200,409]);assert.equal(read("products.json").find(p=>p.id==="shaolin-6").stock,0);
    assert.equal(read("orders.json").filter(order=>order.items.some(item=>item.id==="shaolin-6")).length,2);
    assert.deepEqual(read("orders.json").find(order=>order.id===old.id),old);assert.equal(read("products.json").find(p=>p.id==="aidos").stock,7);
  });
  await stop();await start("2026-11-05T00:00:00+01:00");
  check("Restart preserves sold-out stock",()=>assert.equal(read("products.json").find(p=>p.id==="shaolin-6").stock,0));
  await stop();
  console.log(JSON.stringify({ok:true,checks,tempDirectory:temp},null,2));
})().catch(async error => {await stop();console.error(error);process.exitCode=1;});
