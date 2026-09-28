const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const backend = path.resolve(__dirname, "..");
const serverFile = path.join(backend, "src", "server.js");
const mailMock = path.join(__dirname, "mock-resend.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lindner-cancel-test-"));
const stubModules = path.join(root, "node_modules");
fs.mkdirSync(path.join(stubModules, "pdfkit"), { recursive: true });
fs.writeFileSync(path.join(stubModules, "pdfkit", "index.js"), "module.exports = class PDFDocument {};\n");
let port = 47800 + Math.floor(Math.random() * 1000);
const checks = [];

function check(label, fn) {
  fn();
  checks.push(label);
}

function makeOrder(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    reservationNumber: "RES-2026-0042",
    status: "reserved",
    createdAt: "2026-09-28T08:00:00.000Z",
    items: [{ id: "rocket", name: "Testartikel", price: 10, qty: 3 }],
    total: 30,
    ...overrides,
  };
}

function seed(name, { products, orders }) {
  const dataDir = path.join(root, name);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "products.json"), JSON.stringify(products, null, 2));
  fs.writeFileSync(path.join(dataDir, "orders.json"), JSON.stringify(orders, null, 2));
  fs.writeFileSync(path.join(dataDir, "invoiceCounter.json"), "{}\n");
  fs.writeFileSync(path.join(dataDir, "stats.json"), "{}\n");
  fs.writeFileSync(path.join(dataDir, "digest-state.json"), "{}\n");
  return dataDir;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function start(dataDir, overrides = {}) {
  const selectedPort = ++port;
  const mailLog = path.join(dataDir, "mail.jsonl");
  if (!fs.existsSync(mailLog)) fs.writeFileSync(mailLog, "");
  const child = spawn(process.execPath, ["--require", mailMock, serverFile], {
    cwd: dataDir,
    env: {
      ...process.env,
      PORT: String(selectedPort),
      DATA_DIR: dataDir,
      DIGEST_ENABLED: "false",
      ADMIN_KEY: "isolated-cancel-key",
      ORDERS_OPEN_FROM: "",
      ORDERS_OPEN_UNTIL: "",
      ABHOL_ADRESSE: "Isolierter Test-Abholpunkt",
      ABHOL_ANFAHRT_URL: "https://maps.app.goo.gl/isolated-test",
      RESEND_API_KEY: "isolated-fake-key",
      RESEND_FROM: "Test <test@example.com>",
      OWNER_EMAIL: "owner@example.com",
      MAIL_LOG: mailLog,
      NODE_PATH: [stubModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  const base = `http://127.0.0.1:${selectedPort}`;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(base + "/api/health")).ok) return { child, base, log: () => log };
    } catch {}
    await delay(40);
  }
  throw new Error(`Server not ready: ${log}`);
}

async function stop(run) {
  if (run.child.exitCode !== null) return;
  run.child.kill();
  await new Promise((resolve) => run.child.once("exit", resolve));
}

async function post(run, route, body) {
  const response = await fetch(run.base + route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer isolated-cancel-key",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

async function postWithoutAuth(run, route, body) {
  const response = await fetch(run.base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

async function adjustStock(run, id, delta) {
  const response = await fetch(`${run.base}/api/admin/adjust-stock?id=${encodeURIComponent(id)}&delta=${delta}`, {
    headers: { Authorization: "Bearer isolated-cancel-key" },
  });
  return { status: response.status, data: await response.json() };
}

function read(dataDir, file) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf8"));
}

async function withServer(dataDir, fn, overrides = {}) {
  const run = await start(dataDir, overrides);
  try { return await fn(run); } finally { await stop(run); }
}

(async () => {
  {
    const order = makeOrder();
    const dataDir = seed("current-stock", {
      products: [{ id: "rocket", stock: 8 }],
      orders: [order],
    });
    await withServer(dataDir, async (run) => {
      const preview = await post(run, "/api/admin/cancel-reservation", {
        reservationNumber: order.reservationNumber,
      });
      check("Preview shows current stock 8 plus reserved 3 without writing", () => {
        assert.equal(preview.status, 200);
        assert.equal(preview.data.mode, "preview");
        assert.equal(preview.data.items[0].beforeStock, 8);
        assert.equal(preview.data.items[0].afterStock, 11);
        assert.equal(read(dataDir, "products.json")[0].stock, 8);
        assert.equal(read(dataDir, "orders.json")[0].status, "reserved");
      });

      const applied = await post(run, "/api/admin/cancel-reservation", {
        reservationNumber: order.reservationNumber,
        apply: true,
        confirm: preview.data.requiredConfirmation,
      });
      check("Cancellation adds reserved 3 to current stock 8 and stores release marker", () => {
        assert.equal(applied.status, 200);
        assert.equal(applied.data.addedTotal, 3);
        assert.equal(read(dataDir, "products.json")[0].stock, 11);
        const saved = read(dataDir, "orders.json")[0];
        assert.equal(saved.status, "cancelled");
        assert.equal(saved.stockRelease.reason, "reservation_cancelled");
        assert.equal(saved.stockRelease.totalQuantity, 3);
        assert.equal(applied.data.stockRelease.transactionId, saved.stockRelease.transactionId);
      });

      const duplicate = await post(run, "/api/admin/cancel-reservation", {
        id: order.id,
        apply: true,
        confirm: preview.data.requiredConfirmation,
      });
      check("Second call is idempotent and adds zero", () => {
        assert.equal(duplicate.status, 200);
        assert.equal(duplicate.data.alreadyCancelled, true);
        assert.equal(duplicate.data.addedTotal, 0);
        assert.equal(duplicate.data.stockRelease.totalQuantity, 3);
        assert.equal(read(dataDir, "products.json")[0].stock, 11);
      });

      const genericCancel = await post(run, "/api/admin/order-status", {
        id: order.id,
        status: "cancelled",
      });
      const reactivate = await post(run, "/api/admin/order-status", {
        id: order.id,
        status: "reserved",
      });
      check("Generic order-status cannot cancel or reactivate a cancelled reservation", () => {
        assert.equal(genericCancel.status, 409);
        assert.equal(genericCancel.data.error, "use_cancel_reservation_endpoint");
        assert.equal(reactivate.status, 409);
        assert.equal(reactivate.data.error, "cancelled_reservation_locked");
      });
    });
  }

  {
    const order = makeOrder({ reservationNumber: "RES-2026-0051" });
    const dataDir = seed("preview-then-stock-change", {
      products: [{ id: "rocket", stock: 8 }],
      orders: [order],
    });
    await withServer(dataDir, async (run) => {
      const preview = await post(run, "/api/admin/cancel-reservation", { id: order.id });
      const unauthorized = await postWithoutAuth(run, "/api/admin/cancel-reservation", {
        id: order.id,
        apply: true,
        confirm: preview.data.requiredConfirmation,
      });
      const wrongConfirmation = await post(run, "/api/admin/cancel-reservation", {
        id: order.id,
        apply: true,
        confirm: "CANCEL WRONG-RESERVATION",
      });
      check("Unauthorized apply and wrong confirmation leave the reservation and stock unchanged", () => {
        assert.equal(unauthorized.status, 401);
        assert.equal(wrongConfirmation.status, 400);
        assert.equal(wrongConfirmation.data.error, "confirmation_required");
        assert.equal(read(dataDir, "products.json")[0].stock, 8);
        assert.equal(read(dataDir, "orders.json")[0].status, "reserved");
      });

      const stockChange = await adjustStock(run, "rocket", -2);
      assert.equal(stockChange.status, 200);
      const applied = await post(run, "/api/admin/cancel-reservation", {
        id: order.id,
        apply: true,
        confirm: preview.data.requiredConfirmation,
      });
      check("Apply recalculates after a post-preview stock change: 8 preview, 6 current, plus 3 equals 9", () => {
        assert.equal(applied.status, 200);
        assert.equal(applied.data.items[0].beforeStock, 6);
        assert.equal(applied.data.items[0].afterStock, 9);
        assert.equal(read(dataDir, "products.json")[0].stock, 9);
      });
    });
  }

  {
    const order = makeOrder({
      reservationNumber: "RES-2026-0052",
      items: [{ id: "aidos", qty: 3 }],
    });
    const dataDir = seed("reserve-and-cancel-concurrently", {
      products: [{ id: "aidos", stock: 8 }],
      orders: [order],
    });
    await withServer(dataDir, async (run) => {
      const reserveBody = {
        requestId: crypto.randomUUID(),
        customerName: "Isolierter Paralleltest",
        customerEmail: "parallel@example.com",
        ageConfirmed: true,
        items: [{ id: "aidos", qty: 2 }],
      };
      const [cancelled, reserved] = await Promise.all([
        post(run, "/api/admin/cancel-reservation", {
          id: order.id,
          apply: true,
          confirm: `CANCEL ${order.reservationNumber}`,
        }),
        postWithoutAuth(run, "/api/order", reserveBody),
      ]);
      check("A real local reservation and cancellation serialize to 8 minus 2 plus 3 equals 9", () => {
        assert.equal(cancelled.status, 200);
        assert.equal(reserved.status, 200);
        assert.equal(read(dataDir, "products.json")[0].stock, 9);
        const orders = read(dataDir, "orders.json");
        assert.equal(orders.length, 2);
        assert.equal(orders.find((entry) => entry.id === order.id).status, "cancelled");
      });
    });
  }

  {
    const dataDir = seed("cancelled-order-retry", {
      products: [{ id: "aidos", stock: 10 }],
      orders: [],
    });
    await withServer(dataDir, async (run) => {
      const body = {
        requestId: crypto.randomUUID(),
        customerName: "Isolierter Retrytest",
        customerEmail: "retry@example.com",
        ageConfirmed: true,
        items: [{ id: "aidos", qty: 3 }],
      };
      const first = await postWithoutAuth(run, "/api/order", body);
      assert.equal(first.status, 200);
      const preview = await post(run, "/api/admin/cancel-reservation", { id: first.data.order.id });
      const cancelled = await post(run, "/api/admin/cancel-reservation", {
        id: first.data.order.id,
        apply: true,
        confirm: preview.data.requiredConfirmation,
      });
      assert.equal(cancelled.status, 200);
      const mailLog = path.join(dataDir, "mail.jsonl");
      fs.writeFileSync(mailLog, "");

      const retry = await postWithoutAuth(run, "/api/order", body);
      check("Retry of a cancelled reservation returns conflict without mail or stock mutation", () => {
        assert.equal(retry.status, 409);
        assert.equal(retry.data.error, "reservation_cancelled");
        assert.equal(retry.data.order.status, "cancelled");
        assert.equal(retry.data.stockRelease.totalQuantity, 3);
        assert.equal(read(dataDir, "products.json")[0].stock, 10);
        assert.equal(fs.readFileSync(mailLog, "utf8"), "");
      });
    }, { TEST_MAIL_FAIL: "true" });
  }

  {
    const order = makeOrder({ reservationNumber: "RES-2026-0050" });
    const dataDir = seed("readonly-pending", {
      products: [{ id: "rocket", stock: 8 }],
      orders: [order],
    });
    await withServer(dataDir, async (run) => {
      const transaction = {
        schemaVersion: 1,
        transactionId: crypto.randomUUID(),
        createdAt: "2026-09-28T09:00:00.000Z",
        after: {
          products: [{ id: "rocket", stock: 99 }],
          orders: [{ ...order, status: "cancelled" }],
          invoiceCounter: {},
        },
      };
      const transactionFile = path.join(dataDir, "reservation-transaction.json");
      fs.writeFileSync(transactionFile, JSON.stringify(transaction, null, 2));
      const before = Object.fromEntries(["products.json", "orders.json", "invoiceCounter.json", "reservation-transaction.json"]
        .map((file) => [file, fs.readFileSync(path.join(dataDir, file))]));
      const preview = await post(run, "/api/admin/cancel-reservation", { id: order.id });
      check("Preview refuses a pending transaction and leaves every store byte unchanged", () => {
        assert.equal(preview.status, 409);
        assert.equal(preview.data.error, "pending_transaction");
        for (const [file, content] of Object.entries(before)) {
          assert.equal(Buffer.compare(fs.readFileSync(path.join(dataDir, file)), content), 0, file);
        }
      });
      fs.unlinkSync(transactionFile);
    });
  }

  {
    const order = makeOrder({ reservationNumber: "RES-2026-0043" });
    const dataDir = seed("parallel", {
      products: [{ id: "rocket", stock: 8 }],
      orders: [order],
    });
    await withServer(dataDir, async (run) => {
      const body = {
        id: order.id,
        apply: true,
        confirm: `CANCEL ${order.reservationNumber}`,
      };
      const results = await Promise.all([
        post(run, "/api/admin/cancel-reservation", body),
        post(run, "/api/admin/cancel-reservation", body),
      ]);
      check("Parallel duplicate cancellation releases stock exactly once", () => {
        assert.deepEqual(results.map((result) => result.status), [200, 200]);
        assert.deepEqual(results.map((result) => result.data.addedTotal).sort((a, b) => a - b), [0, 3]);
        assert.equal(read(dataDir, "products.json")[0].stock, 11);
      });
    });
  }

  {
    const order = makeOrder({
      reservationNumber: "RES-2026-0044",
      items: [{ id: "rocket", qty: 2 }, { id: "missing", qty: 1 }],
    });
    const dataDir = seed("all-or-nothing", {
      products: [{ id: "rocket", stock: 8 }],
      orders: [order],
    });
    const beforeProducts = fs.readFileSync(path.join(dataDir, "products.json"), "utf8");
    const beforeOrders = fs.readFileSync(path.join(dataDir, "orders.json"), "utf8");
    await withServer(dataDir, async (run) => {
      const result = await post(run, "/api/admin/cancel-reservation", {
        id: order.id,
        apply: true,
        confirm: `CANCEL ${order.reservationNumber}`,
      });
      check("Missing product rejects multi-product cancellation without partial writes", () => {
        assert.equal(result.status, 409);
        assert.equal(result.data.error, "missing_product");
        assert.equal(fs.readFileSync(path.join(dataDir, "products.json"), "utf8"), beforeProducts);
        assert.equal(fs.readFileSync(path.join(dataDir, "orders.json"), "utf8"), beforeOrders);
        assert.equal(fs.existsSync(path.join(dataDir, "reservation-transaction.json")), false);
      });
    });
  }

  for (const [name, order, expected] of [
    ["purchased", makeOrder({ reservationNumber: "RES-2026-0045", status: "purchased", purchaseCompletedAt: "2026-09-28T08:30:00Z" }), "purchased_reservation"],
    ["legacy-cancelled", makeOrder({ reservationNumber: "RES-2026-0046", status: "cancelled", cancelledAt: "2026-09-28T08:30:00Z" }), "legacy_cancelled_without_stock_release"],
    ["partially-fulfilled", makeOrder({ reservationNumber: "RES-2026-0047", items: [{ id: "rocket", qty: 3, fulfilledQty: 1 }] }), "partially_fulfilled_reservation"],
  ]) {
    const dataDir = seed(name, { products: [{ id: "rocket", stock: 8 }], orders: [order] });
    await withServer(dataDir, async (run) => {
      const result = await post(run, "/api/admin/cancel-reservation", { id: order.id });
      check(`${name} reservation is rejected without stock change`, () => {
        assert.equal(result.status, 409);
        assert.equal(result.data.error, expected);
        assert.equal(read(dataDir, "products.json")[0].stock, 8);
      });
    });
  }

  {
    const duplicateNumber = "RES-2026-0048";
    const dataDir = seed("ambiguous", {
      products: [{ id: "rocket", stock: 8 }],
      orders: [makeOrder({ reservationNumber: duplicateNumber }), makeOrder({ reservationNumber: duplicateNumber })],
    });
    await withServer(dataDir, async (run) => {
      const result = await post(run, "/api/admin/cancel-reservation", { reservationNumber: duplicateNumber });
      check("Ambiguous reservation number is rejected", () => {
        assert.equal(result.status, 409);
        assert.equal(result.data.error, "ambiguous_reservation_reference");
        assert.equal(read(dataDir, "products.json")[0].stock, 8);
      });
    });
  }

  {
    const order = makeOrder({ reservationNumber: "RES-2026-0049" });
    const dataDir = seed("crash-recovery", {
      products: [{ id: "rocket", stock: 8 }],
      orders: [order],
    });
    const crashed = await start(dataDir, { STORE_FAILPOINT: "crash:after_journal" });
    try {
      await post(crashed, "/api/admin/cancel-reservation", {
        id: order.id,
        apply: true,
        confirm: `CANCEL ${order.reservationNumber}`,
      });
    } catch {}
    await new Promise((resolve) => {
      if (crashed.child.exitCode !== null) resolve();
      else crashed.child.once("exit", resolve);
    });
    check("Cancellation journal remains after simulated process crash", () => {
      assert.equal(fs.existsSync(path.join(dataDir, "reservation-transaction.json")), true);
    });

    await withServer(dataDir, async (recovered) => {
      const retry = await post(recovered, "/api/admin/cancel-reservation", {
        id: order.id,
        apply: true,
        confirm: `CANCEL ${order.reservationNumber}`,
      });
      check("Restart completes journal and retry releases zero additional stock", () => {
        assert.equal(retry.status, 200);
        assert.equal(retry.data.alreadyCancelled, true);
        assert.equal(retry.data.addedTotal, 0);
        assert.equal(read(dataDir, "products.json")[0].stock, 11);
        assert.equal(read(dataDir, "orders.json")[0].stockRelease.totalQuantity, 3);
        assert.equal(fs.existsSync(path.join(dataDir, "reservation-transaction.json")), false);
      });
    });
  }

  console.log(JSON.stringify({ passed: checks.length, checks, isolatedRoot: root }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
