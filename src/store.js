// Sehr einfacher, dateibasierter Datenspeicher für Lagerbestand + Bestellungen.
//
// WICHTIG (bewusste Design-Entscheidung, siehe README): Für die Größe dieses
// Shops (kleine Stückzahlen, saisonal) reicht eine JSON-Datei völlig aus –
// eine "richtige" Datenbank wäre hier over-engineered. Damit trotzdem nichts
// durcheinanderkommt, wenn zwei Bestellungen fast gleichzeitig reinkommen,
// laufen ALLE lesenden+schreibenden Zugriffe auf den Lagerbestand nacheinander
// durch eine einzige Warteschlange (runExclusive). So kann es nie passieren,
// dass zwei Bestellungen gleichzeitig den letzten Artikel "gewinnen".
//
// Hosting-Hinweis: Auf manchen kostenlosen Hosting-Plänen (z.B. Render Free)
// wird die Festplatte bei jedem Neu-Deploy zurückgesetzt. Für den echten
// Betrieb braucht data/ entweder eine "Persistent Disk" (kleine Zusatzkosten)
// oder es wird später auf eine echte Cloud-Datenbank umgezogen. Der Code hier
// ist bewusst so geschrieben (alles über diese eine Datei), dass genau dieser
// Umzug später leicht möglich ist, ohne den Rest des Servers anzufassen.

const fs = require("fs/promises");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");
const INVOICE_COUNTER_FILE = path.join(DATA_DIR, "invoiceCounter.json");

// ---- Warteschlange, damit Lese-/Schreibvorgänge nie überlappen ----
let queue = Promise.resolve();
function runExclusive(fn) {
  const result = queue.then(fn, fn);
  // Falls fn() einen Fehler wirft, darf die Warteschlange trotzdem weiterlaufen.
  queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  // In eine Temp-Datei schreiben und dann umbenennen, damit bei einem Absturz
  // mitten im Schreiben nie eine halb geschriebene / kaputte Datei übrig bleibt.
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmp, file);
}

async function getProducts() {
  return readJson(PRODUCTS_FILE, []);
}

/**
 * Zieht `qty` von Produkt `id` ab, aber nur wenn genug Bestand da ist.
 * Läuft exklusiv (keine zwei Bestellungen können sich hier überschneiden).
 */
/**
 * Prüft, dass eine Stückzahl eine echte positive Ganzzahl ist.
 * Ohne diese Prüfung würde eine negative Menge den Bestand ERHÖHEN
 * (`stock -= -10`), weil auch der Vergleich `stock < qty` dann nicht greift.
 */
function isValidQty(qty) {
  return Number.isInteger(qty) && qty > 0 && qty <= 999;
}

async function decrementStock(id, qty) {
  if (!isValidQty(qty)) {
    return { ok: false, reason: "invalid_qty", id };
  }
  return runExclusive(async () => {
    const products = await readJson(PRODUCTS_FILE, []);
    const product = products.find((p) => p.id === id);
    if (!product) {
      return { ok: false, reason: "unknown_product", id };
    }
    if (product.stock < qty) {
      return { ok: false, reason: "out_of_stock", id, available: product.stock };
    }
    product.stock -= qty;
    await writeJson(PRODUCTS_FILE, products);
    return { ok: true, id, remaining: product.stock };
  });
}

/**
 * Gibt `qty` von Produkt `id` wieder zurück (Rollback, falls eine Bestellung
 * mit mehreren Artikeln nur teilweise durchgeht).
 */
async function incrementStock(id, qty) {
  if (!isValidQty(qty)) {
    return { ok: false, reason: "invalid_qty", id };
  }
  return runExclusive(async () => {
    const products = await readJson(PRODUCTS_FILE, []);
    const product = products.find((p) => p.id === id);
    if (!product) return { ok: false, reason: "unknown_product", id };
    product.stock += qty;
    await writeJson(PRODUCTS_FILE, products);
    return { ok: true, id, remaining: product.stock };
  });
}

async function appendOrder(order) {
  return runExclusive(async () => {
    const orders = await readJson(ORDERS_FILE, []);
    orders.push(order);
    await writeJson(ORDERS_FILE, orders);
    return order;
  });
}

async function getOrders() {
  return readJson(ORDERS_FILE, []);
}

async function getOrderById(id) {
  const orders = await readJson(ORDERS_FILE, []);
  return orders.find((o) => o.id === id) || null;
}

/**
 * Vergibt die nächste fortlaufende Rechnungsnummer im Format "R-JAHR-0001".
 * Die Zählung startet jedes Jahr wieder bei 1 (Zähler liegt pro Jahr in
 * data/invoiceCounter.json). Läuft exklusiv, damit auch bei zwei fast
 * gleichzeitigen Bestellungen nie zweimal dieselbe Nummer vergeben wird.
 */
async function nextInvoiceNumber(date = new Date()) {
  return runExclusive(async () => {
    const year = date.getFullYear();
    const counters = await readJson(INVOICE_COUNTER_FILE, {});
    const next = (counters[year] || 0) + 1;
    counters[year] = next;
    await writeJson(INVOICE_COUNTER_FILE, counters);
    return `R-${year}-${String(next).padStart(4, "0")}`;
  });
}

module.exports = {
  getProducts,
  decrementStock,
  incrementStock,
  appendOrder,
  getOrders,
  getOrderById,
  nextInvoiceNumber,
};
