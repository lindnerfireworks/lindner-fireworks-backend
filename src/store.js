// Dateibasierter Datenspeicher fuer Lagerbestand, Reservierungen und Statistik.
//
// Reservierungen werden als kleine, wiederanlaufbare Transaktion geschrieben:
// Zuerst landet der komplette Sollzustand in reservation-transaction.json,
// danach werden Bestand, Reservierungen und Nummernzaehler atomar ersetzt. Bleibt
// der Prozess dazwischen stehen, spielt initialize() das Journal beim Neustart
// zu Ende. Ein dateibasierter Lock verhindert ausserdem ueberlappende
// Mutationen. Das Railway-Volume muss gemaess Plattformvorgabe an genau einer
// aktiven Instanz haengen; initialize() entfernt deshalb einen Crash-Lock vor
// dem Start. Mehrere gleichzeitig startende Instanzen werden nicht unterstuetzt.

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "data");
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const INVOICE_COUNTER_FILE = path.join(DATA_DIR, "invoiceCounter.json");
const STATS_FILE = path.join(DATA_DIR, "stats.json");
const DIGEST_STATE_FILE = path.join(DATA_DIR, "digest-state.json");
const INQUIRIES_FILE = path.join(DATA_DIR, "inquiries.json");
const TRANSACTION_FILE = path.join(DATA_DIR, "reservation-transaction.json");
const LOCK_FILE = path.join(DATA_DIR, "reservation.lock");

let queue = Promise.resolve();
function runExclusive(fn) {
  const result = queue.then(fn, fn);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function syncDirectory() {
  try {
    const handle = await fs.open(DATA_DIR, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (err) {
    // Windows kann Verzeichnisse nicht in jeder Konstellation oeffnen. Die
    // Datei selbst wurde davor trotzdem synchronisiert und atomar umbenannt.
    if (process.platform !== "win32" || !["EACCES", "EPERM", "EISDIR", "EINVAL"].includes(err.code)) throw err;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const handle = await fs.open(tmp, "wx");
  try {
    await handle.writeFile(JSON.stringify(data, null, 2), "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
  await syncDirectory();
}

async function removeFile(file) {
  try {
    await fs.unlink(file);
    await syncDirectory();
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

async function withStorageLock(fn, { timeoutMs = 10000 } = {}) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const started = Date.now();
  const token = crypto.randomUUID();
  const owner = { token, pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() };
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(LOCK_FILE, "wx");
      await handle.writeFile(JSON.stringify(owner));
      await handle.sync();
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (Date.now() - started >= timeoutMs) throw new Error("storage_lock_timeout");
      await delay(40 + Math.floor(Math.random() * 40));
    }
  }

  try {
    return await fn();
  } finally {
    try { await handle.close(); } catch {}
    try {
      const current = JSON.parse(await fs.readFile(LOCK_FILE, "utf8"));
      if (current.token === token) await removeFile(LOCK_FILE);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
}

function maybeFail(point) {
  const configured = process.env.STORE_FAILPOINT;
  if (configured !== point && configured !== `crash:${point}`) return;
  if (configured.startsWith("crash:")) process.exit(97);
  throw new Error(`store_failpoint:${point}`);
}

function assertJournal(journal) {
  if (!journal || journal.schemaVersion !== 1 || !journal.after) throw new Error("invalid_transaction_journal");
  if (!Array.isArray(journal.after.products) || !Array.isArray(journal.after.orders)) throw new Error("invalid_transaction_journal");
  if (!journal.after.invoiceCounter || typeof journal.after.invoiceCounter !== "object") throw new Error("invalid_transaction_journal");
}

async function applyJournal(journal, { allowFailpoints = false } = {}) {
  assertJournal(journal);
  await writeJson(PRODUCTS_FILE, journal.after.products);
  if (allowFailpoints) maybeFail("after_products");
  await writeJson(ORDERS_FILE, journal.after.orders);
  if (allowFailpoints) maybeFail("after_orders");
  await writeJson(INVOICE_COUNTER_FILE, journal.after.invoiceCounter);
  if (allowFailpoints) maybeFail("after_counter");
  await removeFile(TRANSACTION_FILE);
}

async function recoverPendingLocked() {
  const pending = await readJson(TRANSACTION_FILE, null);
  if (pending) await applyJournal(pending);
}

async function initialize() {
  // Railway erlaubt fuer Services mit Volume keine Replikate und verhindert
  // zwei gleichzeitig gemountete Deployments. Unter genau dieser belegten
  // Einprozess-Annahme ist ein vorhandener Lock beim Prozessstart ein
  // Crash-Ueberrest. Ein zweiter paralleler Starter waere nicht sicher.
  await fs.mkdir(DATA_DIR, { recursive: true });
  await removeFile(LOCK_FILE);
  return runExclusive(() => withStorageLock(async () => {
    const journal = await readJson(TRANSACTION_FILE, null);
    if (!journal) return { recovered: false };
    await applyJournal(journal);
    return { recovered: true, transactionId: journal.transactionId || null };
  }));
}

function isValidQty(qty) {
  return Number.isInteger(qty) && qty > 0 && qty <= 999;
}

async function getProducts() {
  return readJson(PRODUCTS_FILE, []);
}

async function getOrders() {
  return readJson(ORDERS_FILE, []);
}

async function getInquiries() {
  return readJson(INQUIRIES_FILE, []);
}

async function createInquiry({ requestId, requestHash, kind, payload, testMode = false }) {
  return runExclusive(() => withStorageLock(async () => {
    await recoverPendingLocked();
    const inquiries = await readJson(INQUIRIES_FILE, []);
    const previous = inquiries.find((entry) => entry.requestId === requestId);
    if (previous) {
      if (previous.requestHash !== requestHash || previous.kind !== kind) {
        return { ok: false, reason: "request_conflict" };
      }
      return { ok: true, duplicate: true, inquiry: previous };
    }
    const inquiry = {
      id: requestId,
      requestId,
      requestHash,
      kind,
      createdAt: new Date().toISOString(),
      testMode: testMode === true,
      payload,
      emails: {
        ownerMailResult: { ok: false, state: "pending", idempotencyKey: `${kind}/owner/${requestId}` },
        customerMailResult: { ok: false, state: "pending", idempotencyKey: `${kind}/customer/${requestId}` },
      },
    };
    inquiries.push(inquiry);
    await writeJson(INQUIRIES_FILE, inquiries);
    return { ok: true, duplicate: false, inquiry };
  }));
}

async function updateInquiry(id, changes) {
  return runExclusive(() => withStorageLock(async () => {
    await recoverPendingLocked();
    const inquiries = await readJson(INQUIRIES_FILE, []);
    const inquiry = inquiries.find((entry) => entry.id === id);
    if (!inquiry) throw new Error("inquiry_not_found");
    Object.assign(inquiry, changes, { updatedAt: new Date().toISOString() });
    await writeJson(INQUIRIES_FILE, inquiries);
    return inquiry;
  }));
}

async function getOrderById(id) {
  const orders = await getOrders();
  return orders.find((order) => order.id === id) || null;
}

async function decrementStock(id, qty) {
  if (!isValidQty(qty)) return { ok: false, reason: "invalid_qty", id };
  return runExclusive(() => withStorageLock(async () => {
    await recoverPendingLocked();
    const products = await readJson(PRODUCTS_FILE, []);
    const product = products.find((entry) => entry.id === id);
    if (!product) return { ok: false, reason: "unknown_product", id };
    if (product.stock < qty) return { ok: false, reason: "out_of_stock", id, available: product.stock };
    product.stock -= qty;
    await writeJson(PRODUCTS_FILE, products);
    return { ok: true, id, remaining: product.stock };
  }));
}

async function incrementStock(id, qty) {
  if (!isValidQty(qty)) return { ok: false, reason: "invalid_qty", id };
  return runExclusive(() => withStorageLock(async () => {
    await recoverPendingLocked();
    const products = await readJson(PRODUCTS_FILE, []);
    const product = products.find((entry) => entry.id === id);
    if (!product) return { ok: false, reason: "unknown_product", id };
    product.stock += qty;
    await writeJson(PRODUCTS_FILE, products);
    return { ok: true, id, remaining: product.stock };
  }));
}

async function appendOrder(order) {
  return runExclusive(() => withStorageLock(async () => {
    await recoverPendingLocked();
    const orders = await readJson(ORDERS_FILE, []);
    orders.push(order);
    await writeJson(ORDERS_FILE, orders);
    return order;
  }));
}

async function updateOrder(id, changes) {
  return runExclusive(() => withStorageLock(async () => {
    await recoverPendingLocked();
    const orders = await readJson(ORDERS_FILE, []);
    const order = orders.find((entry) => entry.id === id);
    if (!order) throw new Error("order_not_found");
    Object.assign(order, changes, { updatedAt: new Date().toISOString() });
    await writeJson(ORDERS_FILE, orders);
    return order;
  }));
}

async function createReservation({ requestId, requestHash, items, orderBase, date = new Date() }) {
  return runExclusive(() => withStorageLock(async () => {
    await recoverPendingLocked();

    const [products, orders, counters] = await Promise.all([
      readJson(PRODUCTS_FILE, []),
      readJson(ORDERS_FILE, []),
      readJson(INVOICE_COUNTER_FILE, {}),
    ]);

    const previous = orders.find((entry) => entry.requestId === requestId);
    if (previous) {
      if (previous.requestHash !== requestHash) return { ok: false, reason: "request_conflict" };
      return { ok: true, duplicate: true, order: previous };
    }

    const seen = new Set();
    for (const item of items) {
      if (!isValidQty(item.qty)) return { ok: false, reason: "invalid_qty", id: item.id };
      if (seen.has(item.id)) return { ok: false, reason: "duplicate_item", id: item.id };
      seen.add(item.id);
      const product = products.find((entry) => entry.id === item.id);
      if (!product) return { ok: false, reason: "unknown_product", id: item.id };
      if (product.stock < item.qty) {
        return { ok: false, reason: "out_of_stock", id: item.id, available: product.stock };
      }
    }

    for (const item of items) products.find((entry) => entry.id === item.id).stock -= item.qty;

    const year = date.getFullYear();
    const next = (counters[year] || 0) + 1;
    counters[year] = next;
    const order = {
      ...orderBase,
      requestId,
      requestHash,
      reservationNumber: `RES-${year}-${String(next).padStart(4, "0")}`,
      status: orderBase.status || "reserved",
      purchaseCompletedAt: orderBase.purchaseCompletedAt || null,
      emails: orderBase.emails || {
        customerMailResult: { ok: false, state: "pending", idempotencyKey: `reservation/customer/${orderBase.id}` },
        ownerMailResult: { ok: false, state: "pending", idempotencyKey: `reservation/owner/${orderBase.id}` },
      },
    };
    orders.push(order);

    const journal = {
      schemaVersion: 1,
      transactionId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      requestId,
      after: { products, orders, invoiceCounter: counters },
    };
    await writeJson(TRANSACTION_FILE, journal);
    maybeFail("after_journal");
    await applyJournal(journal, { allowFailpoints: true });
    return { ok: true, duplicate: false, order };
  }));
}

async function nextReservationNumber(date = new Date()) {
  return runExclusive(() => withStorageLock(async () => {
    await recoverPendingLocked();
    const year = date.getFullYear();
    const counters = await readJson(INVOICE_COUNTER_FILE, {});
    const next = (counters[year] || 0) + 1;
    counters[year] = next;
    await writeJson(INVOICE_COUNTER_FILE, counters);
    return `RES-${year}-${String(next).padStart(4, "0")}`;
  }));
}

async function trackEvent(produktId, art, tag) {
  return runExclusive(() => withStorageLock(async () => {
    await recoverPendingLocked();
    const stats = await readJson(STATS_FILE, {});
    if (!stats[tag]) stats[tag] = {};
    if (!stats[tag][produktId]) stats[tag][produktId] = { view: 0, cart: 0 };
    stats[tag][produktId][art] = (stats[tag][produktId][art] || 0) + 1;
    await writeJson(STATS_FILE, stats);
    return true;
  }));
}

async function getStats() {
  return readJson(STATS_FILE, {});
}

async function getDigestState() {
  return readJson(DIGEST_STATE_FILE, { lastSentFor: null });
}

async function updateDigestState(state) {
  return runExclusive(() => withStorageLock(async () => {
    await recoverPendingLocked();
    await writeJson(DIGEST_STATE_FILE, state);
    return state;
  }));
}

async function createBackupSnapshot(runtimeConfig = null) {
  return runExclusive(() => withStorageLock(async () => {
    await recoverPendingLocked();
    const [products, orders, inquiries, invoiceCounter, stats, digestState] = await Promise.all([
      readJson(PRODUCTS_FILE, []),
      readJson(ORDERS_FILE, []),
      readJson(INQUIRIES_FILE, []),
      readJson(INVOICE_COUNTER_FILE, {}),
      readJson(STATS_FILE, {}),
      readJson(DIGEST_STATE_FILE, {}),
    ]);
    if (!runtimeConfig || typeof runtimeConfig !== "object" || Array.isArray(runtimeConfig)) {
      throw new Error("runtime_config_required");
    }
    const data = { products, orders, inquiries, invoiceCounter, stats, digestState, runtimeConfig };
    const hashes = Object.fromEntries(Object.entries(data).map(([name, value]) => [
      name,
      crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    ]));
    return {
      schemaVersion: 3,
      completeness: "full",
      createdAt: new Date().toISOString(),
      data,
      hashes,
    };
  }));
}

async function removeOrdersByIds(ids) {
  const wanted = new Set(ids);
  return runExclusive(() => withStorageLock(async () => {
    await recoverPendingLocked();
    const orders = await readJson(ORDERS_FILE, []);
    const kept = orders.filter((order) => !wanted.has(order.id));
    await writeJson(ORDERS_FILE, kept);
    return { removed: orders.length - kept.length, remaining: kept.length };
  }));
}

function retentionExpiry(order) {
  const status = order.status || "reserved";
  if (status === "purchased") {
    const purchased = new Date(order.purchaseCompletedAt || order.createdAt);
    if (Number.isNaN(purchased.valueOf())) return null;
    return new Date(Date.UTC(purchased.getUTCFullYear() + 8, 0, 1));
  }
  const source = order.cancelledAt || order.pickupDate || order.createdAt;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(source))
    ? new Date(`${source}T23:59:59Z`)
    : new Date(source);
  if (Number.isNaN(date.valueOf())) return null;
  date.setUTCDate(date.getUTCDate() + 365);
  return date;
}

async function privacyCleanup({ now = new Date(), apply = false } = {}) {
  return runExclusive(() => withStorageLock(async () => {
    await recoverPendingLocked();
    const orders = await readJson(ORDERS_FILE, []);
    const inquiries = await readJson(INQUIRIES_FILE, []);
    const candidates = [];
    const inquiryCandidates = [];
    let holds = 0;
    let invalidDates = 0;
    for (const order of orders) {
      if (order.retentionHold === true) {
        holds += 1;
        continue;
      }
      const expiry = retentionExpiry(order);
      if (!expiry) {
        invalidDates += 1;
        continue;
      }
      if (expiry <= now) candidates.push({
        id: order.id,
        reference: String(order.id || "").slice(-8),
        status: order.status || "reserved",
        expiry: expiry.toISOString(),
      });
    }
    for (const inquiry of inquiries) {
      if (inquiry.retentionHold === true) {
        holds += 1;
        continue;
      }
      const created = new Date(inquiry.createdAt);
      if (Number.isNaN(created.valueOf())) {
        invalidDates += 1;
        continue;
      }
      created.setUTCDate(created.getUTCDate() + 365);
      if (created <= now) inquiryCandidates.push({
        id: inquiry.id,
        reference: String(inquiry.id || "").slice(-8),
        status: inquiry.kind || "inquiry",
        expiry: created.toISOString(),
      });
    }
    if (apply && candidates.length) {
      const ids = new Set(candidates.map((entry) => entry.id));
      await writeJson(ORDERS_FILE, orders.filter((order) => !ids.has(order.id)));
    }
    if (apply && inquiryCandidates.length) {
      const ids = new Set(inquiryCandidates.map((entry) => entry.id));
      await writeJson(INQUIRIES_FILE, inquiries.filter((inquiry) => !ids.has(inquiry.id)));
    }
    const allCandidates = candidates.concat(inquiryCandidates);
    return {
      mode: apply ? "apply" : "dry-run",
      now: now.toISOString(),
      counts: {
        examined: orders.length + inquiries.length,
        candidates: allCandidates.length,
        orderCandidates: candidates.length,
        inquiryCandidates: inquiryCandidates.length,
        retentionHolds: holds,
        invalidDates,
        removed: apply ? allCandidates.length : 0,
      },
      candidates: allCandidates.map(({ reference, status, expiry }) => ({ reference, status, expiry })),
    };
  }));
}

function cancellationReference(order) {
  return order.reservationNumber || order.id;
}

function hasFulfilmentEvidence(order) {
  const directFlags = [
    order.partiallyFulfilled,
    order.fulfilled,
    order.pickedUp,
  ];
  if (directFlags.some((value) => value === true)) return true;

  const directDates = [
    order.partiallyFulfilledAt,
    order.fulfilledAt,
    order.pickupCompletedAt,
  ];
  if (directDates.some((value) => typeof value === "string" && value.trim())) return true;

  if (typeof order.fulfillmentStatus === "string"
    && !["", "unfulfilled", "reserved", "pending"].includes(order.fulfillmentStatus.trim().toLowerCase())) {
    return true;
  }

  return Array.isArray(order.items) && order.items.some((item) =>
    [item.fulfilledQty, item.pickedUpQty, item.soldQty]
      .some((value) => Number.isFinite(Number(value)) && Number(value) > 0));
}

function validateStockReleaseMarker(order) {
  const marker = order.stockRelease;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
  if (marker.reason !== "reservation_cancelled" || typeof marker.transactionId !== "string") return false;
  if (typeof marker.releasedAt !== "string" || !Array.isArray(marker.items) || marker.items.length === 0) return false;
  return marker.items.every((item) => typeof item.id === "string" && isValidQty(item.qty));
}

async function cancelReservation({ id, reservationNumber, apply = false, confirm, when = new Date() } = {}) {
  return runExclusive(() => withStorageLock(async () => {
    if (apply) {
      await recoverPendingLocked();
    } else if (await readJson(TRANSACTION_FILE, null)) {
      throw new Error("pending_transaction");
    }

    const [products, orders, counters] = await Promise.all([
      readJson(PRODUCTS_FILE, []),
      readJson(ORDERS_FILE, []),
      readJson(INVOICE_COUNTER_FILE, {}),
    ]);

    const normalizedNumber = typeof reservationNumber === "string"
      ? reservationNumber.trim().toUpperCase()
      : null;
    const matches = orders.filter((order) => id
      ? order.id === id
      : String(order.reservationNumber || "").trim().toUpperCase() === normalizedNumber);
    if (matches.length === 0) throw new Error("order_not_found");
    if (matches.length !== 1) throw new Error("ambiguous_reservation_reference");

    const order = matches[0];
    const status = order.status || "reserved";
    const hasReleaseMarker = order.stockRelease !== undefined && order.stockRelease !== null;
    if (status === "cancelled") {
      if (!hasReleaseMarker) throw new Error("legacy_cancelled_without_stock_release");
      if (!validateStockReleaseMarker(order)) throw new Error("invalid_stock_release_marker");
      return {
        ok: true,
        mode: apply ? "apply" : "preview",
        alreadyCancelled: true,
        addedTotal: 0,
        order,
        items: order.stockRelease.items.map((item) => ({ id: item.id, qty: item.qty })),
        stockRelease: order.stockRelease,
      };
    }
    if (hasReleaseMarker) throw new Error("stock_release_state_conflict");
    if (status === "purchased" || order.purchaseCompletedAt) throw new Error("purchased_reservation");
    if (status !== "reserved") throw new Error("invalid_reservation_status");
    if (hasFulfilmentEvidence(order)) throw new Error("partially_fulfilled_reservation");
    if (!Array.isArray(order.items) || order.items.length === 0) throw new Error("invalid_order_items");

    const seen = new Set();
    const releaseItems = [];
    for (const item of order.items) {
      if (!item || typeof item.id !== "string" || !item.id || !isValidQty(item.qty)) {
        throw new Error("invalid_order_items");
      }
      if (seen.has(item.id)) throw new Error("duplicate_order_item");
      seen.add(item.id);
      const productMatches = products.filter((entry) => entry.id === item.id);
      if (productMatches.length === 0) throw new Error("missing_product");
      if (productMatches.length !== 1) throw new Error("ambiguous_product");
      const product = productMatches[0];
      if (!Number.isSafeInteger(product.stock) || product.stock < 0) throw new Error("invalid_product_stock");
      const afterStock = product.stock + item.qty;
      if (!Number.isSafeInteger(afterStock)) throw new Error("invalid_product_stock");
      releaseItems.push({ id: item.id, qty: item.qty, beforeStock: product.stock, afterStock });
    }

    const requiredConfirmation = `CANCEL ${cancellationReference(order)}`;
    if (!apply) {
      return {
        ok: true,
        mode: "preview",
        alreadyCancelled: false,
        addedTotal: 0,
        requiredConfirmation,
        order: {
          id: order.id,
          reservationNumber: order.reservationNumber || null,
          status,
        },
        items: releaseItems,
        stockRelease: null,
      };
    }
    if (confirm !== requiredConfirmation) throw new Error("confirmation_required");

    for (const item of releaseItems) {
      products.find((entry) => entry.id === item.id).stock = item.afterStock;
    }
    const transactionId = crypto.randomUUID();
    const timestamp = when.toISOString();
    order.status = "cancelled";
    order.cancelledAt = timestamp;
    order.updatedAt = timestamp;
    order.stockRelease = {
      reason: "reservation_cancelled",
      transactionId,
      releasedAt: timestamp,
      items: releaseItems.map(({ id: productId, qty }) => ({ id: productId, qty })),
      totalQuantity: releaseItems.reduce((sum, item) => sum + item.qty, 0),
    };

    const journal = {
      schemaVersion: 1,
      transactionId,
      createdAt: timestamp,
      operation: "cancel_reservation",
      orderId: order.id,
      after: { products, orders, invoiceCounter: counters },
    };
    await writeJson(TRANSACTION_FILE, journal);
    maybeFail("after_journal");
    await applyJournal(journal, { allowFailpoints: true });

    return {
      ok: true,
      mode: "apply",
      alreadyCancelled: false,
      addedTotal: order.stockRelease.totalQuantity,
      order,
      items: releaseItems,
      stockRelease: order.stockRelease,
    };
  }));
}

async function setOrderStatus(id, status, when = new Date()) {
  if (!["reserved", "purchased", "cancelled"].includes(status)) throw new Error("invalid_order_status");
  if (status === "cancelled") throw new Error("use_cancel_reservation_endpoint");
  return runExclusive(() => withStorageLock(async () => {
    await recoverPendingLocked();
    const orders = await readJson(ORDERS_FILE, []);
    const order = orders.find((entry) => entry.id === id);
    if (!order) throw new Error("order_not_found");
    if ((order.status || "reserved") === "cancelled" || order.stockRelease) {
      throw new Error("cancelled_reservation_locked");
    }
    order.status = status;
    if (status === "purchased") order.purchaseCompletedAt = when.toISOString();
    order.updatedAt = new Date().toISOString();
    await writeJson(ORDERS_FILE, orders);
    return order;
  }));
}

module.exports = {
  DATA_DIR,
  initialize,
  updateOrder,
  trackEvent,
  getStats,
  getDigestState,
  updateDigestState,
  getProducts,
  decrementStock,
  incrementStock,
  appendOrder,
  getOrders,
  getInquiries,
  createInquiry,
  updateInquiry,
  getOrderById,
  nextReservationNumber,
  createReservation,
  createBackupSnapshot,
  removeOrdersByIds,
  privacyCleanup,
  cancelReservation,
  setOrderStatus,
};
