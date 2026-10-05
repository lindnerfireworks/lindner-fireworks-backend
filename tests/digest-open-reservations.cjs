// Exercise the actual digest function in isolation. There is no server start,
// filesystem write, real data store, network access or external mail transport.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const sources = [
  path.resolve(__dirname, "../src/server.js"),
  ...process.argv.slice(2).map((sourcePath) => path.resolve(sourcePath)),
];

function loadDigest(sourcePath, orders) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const start = source.indexOf("async function runDailyDigest(");
  const end = source.indexOf("function scheduleDailyDigest()", start);
  assert(start >= 0 && end > start, "Actual digest function must be present");
  const calls = [];
  const writes = [];
  const context = {
    DIGEST_ENABLED: true,
    DIGEST_HOUR: 18,
    viennaNowParts: () => ({ day: "2026-11-05", hour: 19 }),
    isoDay: (date) => date.toISOString().slice(0, 10),
    slotForDay: () => "13:00–16:00 Uhr",
    readDigestState: async () => ({}),
    writeDigestState: async (state) => { writes.push(state); },
    store: { getOrders: async () => orders },
    terminSortKey: (value) => {
      const match = String(value || "").match(/(\d{2})\.(\d{2})\.(\d{4})/);
      return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
    },
    formatGermanDate: () => "Freitag, 06.11.2026",
    sendDailyDigest: async (payload) => {
      calls.push(payload);
      return { ok: true };
    },
    process: { env: {} },
    console: { log() {} },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { run: context.runDailyDigest, calls, writes };
}

async function checkSource(sourcePath) {
  const base = { abholtermin: "Freitag, 06.11.2026, 13:00–16:00 Uhr", total: 4.2 };
  const excluded = [
    { ...base, id: "controlled-test", status: "reserved", testMode: true },
    { ...base, id: "cancelled-test", status: "cancelled", testMode: true, stockRelease: {} },
    { ...base, id: "cancelled-real", status: "cancelled" },
    { ...base, id: "released-real", status: "reserved", stockRelease: {} },
    { ...base, id: "purchased-real", status: "purchased" },
    { ...base, id: "non-open", status: "partially_fulfilled" },
    { ...base, id: "different-day", status: "reserved", abholtermin: "Samstag, 07.11.2026" },
  ];

  const mixed = loadDigest(sourcePath, [
    { ...base, id: "real-open", status: "reserved", testMode: false },
    ...excluded,
  ]);
  const sent = await mixed.run();
  assert.equal(sent.sent, true);
  assert.equal(sent.count, 1);
  assert.equal(mixed.calls.length, 1, "Exactly one mocked digest for a real open reservation");
  assert.deepEqual(Array.from(mixed.calls[0].orders, (order) => order.id), ["real-open"]);
  assert.equal(mixed.calls[0].orders.reduce((sum, order) => sum + order.total, 0), 4.2);
  assert.equal(mixed.writes[0].lastSentFor, "2026-11-06");

  const excludedOnly = loadDigest(sourcePath, excluded);
  const skipped = await excludedOnly.run();
  assert.equal(skipped.skipped, "keine_abholungen");
  assert.equal(excludedOnly.calls.length, 0, "Tests, stornos and non-open orders must trigger no mail");
  assert.equal(excludedOnly.writes[0].lastSentFor, "2026-11-06");

  const legacy = loadDigest(sourcePath, [{ ...base, id: "legacy-open" }]);
  const legacyResult = await legacy.run();
  assert.equal(legacyResult.sent, true, "Existing reservations without a status remain open");
  assert.deepEqual(Array.from(legacy.calls[0].orders, (order) => order.id), ["legacy-open"]);

  return { source: path.relative(path.resolve(__dirname, "../.."), sourcePath),
    scenarios: 3, passed: true, realMailCalls: 0 };
}

(async () => {
  const results = [];
  for (const sourcePath of sources) results.push(await checkSource(sourcePath));
  console.log(JSON.stringify({ passed: true, realMailCalls: 0, results }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
