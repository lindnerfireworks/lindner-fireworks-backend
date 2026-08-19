// Bewusst OHNE Express/Framework gebaut, nur mit Node.js-Bordmitteln
// (Node 20.6+/22 kann alles Nötige schon selbst: eingebauter http-Server,
// eingebautes fetch() für Resend, eingebautes process.loadEnvFile() statt
// dem "dotenv"-Paket). Vorteil: kein "npm install" nötig, nichts, was beim
// Hosting-Anbieter mal fehlschlagen oder veralten kann – einfach `node
// src/server.js` starten, fertig.

try {
  process.loadEnvFile(); // lädt .env, falls vorhanden; sonst einfach ignorieren
} catch (err) {
  if (err.code !== "ENOENT") throw err;
  console.log("[server] Keine .env-Datei gefunden – laufe mit Standardwerten/Platzhaltern.");
}

const http = require("http");
const crypto = require("crypto");

const store = require("./store");
const {
  sendCustomerConfirmation,
  sendOwnerNotification,
  sendContactNotification,
  sendContactConfirmation,
  sendBookingNotification,
  sendBookingConfirmation,
  computeAbholzeit,
} = require("./email");
const { generateInvoicePdf } = require("./invoice");
const { getProduct } = require("./catalog");

const PORT = process.env.PORT || 4000;

// Nur diese Herkünfte dürfen das Backend aufrufen. Weitere (z.B. eine eigene
// Domain) über die Umgebungsvariable ALLOWED_ORIGINS ergänzen, kommagetrennt.
const DEFAULT_ORIGINS = [
  "https://lindner-fireworks.netlify.app",
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean)
    .concat(DEFAULT_ORIGINS)
);

function setCorsHeaders(req, res) {
  const origin = (req.headers.origin || "").replace(/\/$/, "");
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ---------------------------------------------------------------------------
// Einfaches Rate Limiting im Arbeitsspeicher. Verhindert, dass jemand per
// Skript den ganzen Lagerbestand leerbestellt oder das Kontaktformular als
// Mail-Schleuder missbraucht. Reicht für einen Shop dieser Größe völlig; bei
// einem Neustart des Servers werden die Zähler zurückgesetzt, was unkritisch ist.
// ---------------------------------------------------------------------------
const rateBuckets = new Map();

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unbekannt";
}

/** Gibt true zurück, wenn die Anfrage erlaubt ist. */
function rateLimitOk(req, bucket, maxRequests, windowMs) {
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  const entry = rateBuckets.get(key);

  if (!entry || now > entry.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= maxRequests) return false;
  entry.count += 1;
  return true;
}

// Alte Einträge gelegentlich aufräumen, damit die Map nicht unbegrenzt wächst.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateBuckets) {
    if (now > entry.resetAt) rateBuckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("payload_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

async function handleGetProducts(req, res) {
  const products = await store.getProducts();
  sendJson(res, 200, products);
}

// Erwarteter Body:
// {
//   customerName: "Max Mustermann",
//   customerEmail: "max@example.com",
//   customerPhone: "+43 660 1234567",   // optional
//   ageConfirmed: true,                 // Pflicht (Kategorie F2, ab 16)
//   items: [{ id: "aidos", qty: 2 }, ...]
// }
//
// Preis und Artikelname werden bewusst NICHT vom Frontend übernommen, sondern
// serverseitig aus src/catalog.js nachgeschlagen. Alles andere ließe sich über
// die Entwicklertools des Browsers manipulieren.
async function handlePostOrder(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: "invalid_json" });
  }

  const { customerName, customerEmail, customerPhone, items: rawItems, ageConfirmed } = body || {};

  if (!customerName || !customerEmail || !Array.isArray(rawItems) || rawItems.length === 0) {
    return sendJson(res, 400, { ok: false, error: "invalid_request" });
  }

  if (String(customerName).length > 100 || String(customerEmail).length > 200) {
    return sendJson(res, 400, { ok: false, error: "invalid_request" });
  }

  // Einfache Plausibilitätsprüfung der E-Mail-Adresse.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(customerEmail))) {
    return sendJson(res, 400, { ok: false, error: "invalid_email" });
  }

  // Altersbestätigung (Kategorie F2 darf nicht an unter 16-Jährige überlassen
  // werden, § 30 Abs. 1 PyroTG 2010 iVm § 15 Z 2).
  if (ageConfirmed !== true) {
    return sendJson(res, 400, { ok: false, error: "age_not_confirmed" });
  }

  if (rawItems.length > 50) {
    return sendJson(res, 400, { ok: false, error: "too_many_items" });
  }

  // ---------------------------------------------------------------------
  // Preise und Namen kommen AUSSCHLIESSLICH aus dem Katalog des Servers.
  // Was der Browser mitschickt, wird bis auf id und qty verworfen – sonst
  // könnte jeder über die Entwicklertools seinen eigenen Preis bestimmen.
  // ---------------------------------------------------------------------
  const items = [];
  const seen = new Set();

  for (const raw of rawItems) {
    const id = raw && typeof raw.id === "string" ? raw.id : null;
    const qty = raw ? Number(raw.qty) : NaN;

    if (!id || !Number.isInteger(qty) || qty < 1 || qty > 99) {
      return sendJson(res, 400, { ok: false, error: "invalid_item", productId: id });
    }
    if (seen.has(id)) {
      return sendJson(res, 400, { ok: false, error: "duplicate_item", productId: id });
    }
    seen.add(id);

    const product = getProduct(id);
    if (!product) {
      return sendJson(res, 400, { ok: false, error: "unknown_product", productId: id });
    }

    items.push({ id: product.id, name: product.name, price: product.price, qty });
  }

  const decremented = []; // für Rollback, falls ein späterer Artikel nicht verfügbar ist

  for (const item of items) {
    const result = await store.decrementStock(item.id, item.qty);
    if (!result.ok) {
      for (const done of decremented) {
        await store.incrementStock(done.id, done.qty);
      }
      return sendJson(res, 409, {
        ok: false,
        error: result.reason,
        productId: item.id,
        available: result.available,
      });
    }
    decremented.push({ id: item.id, qty: item.qty });
  }

  const total = items.reduce((sum, it) => sum + it.price * it.qty, 0);

  // Abholtermin + Rechnungsnummer EINMAL berechnen und in der Bestellung
  // speichern, damit Kunden-Mail, Besitzer-Mail und die (später über den
  // Link abrufbare) Rechnungs-PDF garantiert denselben Termin/dieselbe
  // Nummer zeigen – auch wenn die Rechnung erst Tage später abgerufen wird.
  const abholtermin = computeAbholzeit();
  const invoiceNumber = await store.nextInvoiceNumber();
  const invoiceDate = new Date().toLocaleDateString("de-AT");

  const order = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    customerName,
    customerEmail,
    customerPhone: customerPhone ? String(customerPhone).slice(0, 40) : "",
    items,
    total,
    abholtermin,
    invoiceNumber,
    invoiceDate,
  };
  await store.appendOrder(order);

  const publicBaseUrl = process.env.PUBLIC_BASE_URL || "";
  const invoiceUrl = publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, "")}/api/invoice/${order.id}` : null;

  // Rechnung als PDF erzeugen, damit sie der Kundenmail angehängt werden kann.
  // Schlägt das fehl, wird die Mail trotzdem verschickt – nur eben ohne Anhang.
  let invoicePdf = null;
  try {
    invoicePdf = await generateInvoicePdf(order);
  } catch (err) {
    console.error("[order] Rechnung konnte nicht erzeugt werden, Mail geht ohne Anhang raus:", err);
  }

  // E-Mails verschicken – ein Fehler hier soll die Bestellung selbst nicht
  // rückgängig machen (Bestand ist schon korrekt abgezogen und gespeichert).
  const [customerMailResult, ownerMailResult] = await Promise.all([
    sendCustomerConfirmation({
      customerName,
      customerEmail,
      items,
      total,
      abholtermin,
      invoiceNumber,
      invoicePdf,
    }).catch((err) => {
      console.error("[order] Fehler beim Senden der Kunden-Mail:", err);
      return { ok: false, error: String(err) };
    }),
    sendOwnerNotification({
      customerName,
      customerEmail,
      items,
      total,
      abholtermin,
      invoiceUrl,
      invoiceNumber,
    }).catch((err) => {
      console.error("[order] Fehler beim Senden der Besitzer-Mail:", err);
      return { ok: false, error: String(err) };
    }),
  ]);

  sendJson(res, 200, { ok: true, order, emails: { customerMailResult, ownerMailResult } });
}

// Liefert die PDF-Rechnung zu einer gespeicherten Bestellung aus (per
// Bestellungs-ID). Wird aus der internen Besitzer-Benachrichtigung heraus
// verlinkt, damit Lukas sie zu Hause direkt öffnen/ausdrucken kann.
async function handleGetInvoice(req, res, orderId) {
  const order = await store.getOrderById(orderId);
  if (!order) {
    return sendJson(res, 404, { ok: false, error: "not_found" });
  }

  let pdfBuffer;
  try {
    pdfBuffer = await generateInvoicePdf(order);
  } catch (err) {
    console.error("[invoice] Fehler beim Erzeugen der PDF-Rechnung:", err);
    return sendJson(res, 500, { ok: false, error: "invoice_generation_failed" });
  }

  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="Rechnung-${order.invoiceNumber || order.id}.pdf"`,
    "Content-Length": pdfBuffer.length,
  });
  res.end(pdfBuffer);
}

// Erwarteter Body: { name, email, subject, message }
async function handlePostContact(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: "invalid_json" });
  }

  const { name, email, subject, message } = body || {};
  if (!name || !email || !message) {
    return sendJson(res, 400, { ok: false, error: "invalid_request" });
  }

  const [ownerMailResult, customerMailResult] = await Promise.all([
    sendContactNotification({ name, email, subject, message }).catch((err) => {
      console.error("[contact] Fehler beim Senden der Kontakt-Mail:", err);
      return { ok: false, error: String(err) };
    }),
    sendContactConfirmation({ name, email }).catch((err) => {
      console.error("[contact] Fehler beim Senden der Bestätigungs-Mail:", err);
      return { ok: false, error: String(err) };
    }),
  ]);

  sendJson(res, 200, { ok: true, emails: { ownerMailResult, customerMailResult } });
}

// Erwarteter Body: { name, email, phone, occasion, date, location, message }
async function handlePostBooking(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: "invalid_json" });
  }

  const { name, email, phone, occasion, date, location, message } = body || {};
  if (!name || !email) {
    return sendJson(res, 400, { ok: false, error: "invalid_request" });
  }

  const [ownerMailResult, customerMailResult] = await Promise.all([
    sendBookingNotification({ name, email, phone, occasion, date, location, message }).catch((err) => {
      console.error("[booking] Fehler beim Senden der Besitzer-Mail:", err);
      return { ok: false, error: String(err) };
    }),
    sendBookingConfirmation({ name, email, occasion, date }).catch((err) => {
      console.error("[booking] Fehler beim Senden der Kunden-Mail:", err);
      return { ok: false, error: String(err) };
    }),
  ]);

  sendJson(res, 200, { ok: true, emails: { ownerMailResult, customerMailResult } });
}

// ---------- Admin: manuelle Bestandskorrektur (z.B. bei Stornierung) ----------
// Nur per GET aufrufbar (bewusst so gebaut, damit Claude das direkt selbst
// aufrufen kann, ohne dass du erst wieder Dateien hochladen musst) und nur
// mit dem geheimen ADMIN_KEY (als Umgebungsvariable in Railway gesetzt, nicht
// im Code). Ohne gesetzten ADMIN_KEY ist dieser Endpunkt komplett deaktiviert.
async function handleAdminAdjustStock(req, res, url) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    return sendJson(res, 503, { ok: false, error: "admin_disabled" });
  }
  if (url.searchParams.get("key") !== adminKey) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  const id = url.searchParams.get("id");
  const delta = parseInt(url.searchParams.get("delta"), 10);
  if (!id || Number.isNaN(delta) || delta === 0) {
    return sendJson(res, 400, { ok: false, error: "invalid_request" });
  }

  const result =
    delta > 0
      ? await store.incrementStock(id, delta)
      : await store.decrementStock(id, -delta);

  if (!result.ok) return sendJson(res, 409, result);
  sendJson(res, 200, { ok: true, id, remaining: result.remaining });
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    }

    if (req.method === "GET" && url.pathname === "/api/products") {
      return await handleGetProducts(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/order") {
      // Max. 5 Bestellungen pro IP und Stunde.
      if (!rateLimitOk(req, "order", 5, 60 * 60 * 1000)) {
        return sendJson(res, 429, { ok: false, error: "rate_limited" });
      }
      return await handlePostOrder(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/contact") {
      // Max. 3 Nachrichten pro IP und Stunde.
      if (!rateLimitOk(req, "contact", 3, 60 * 60 * 1000)) {
        return sendJson(res, 429, { ok: false, error: "rate_limited" });
      }
      return await handlePostContact(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/booking") {
      // Max. 3 Anfragen pro IP und Stunde.
      if (!rateLimitOk(req, "booking", 3, 60 * 60 * 1000)) {
        return sendJson(res, 429, { ok: false, error: "rate_limited" });
      }
      return await handlePostBooking(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/adjust-stock") {
      return await handleAdminAdjustStock(req, res, url);
    }

    const invoiceMatch = url.pathname.match(/^\/api\/invoice\/([a-f0-9-]{36})$/i);
    if (req.method === "GET" && invoiceMatch) {
      return await handleGetInvoice(req, res, invoiceMatch[1]);
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
  } catch (err) {
    console.error("[server] Unerwarteter Fehler:", err);
    sendJson(res, 500, { ok: false, error: "internal_error" });
  }
});

server.listen(PORT, () => {
  console.log(`Lindner Fireworks Backend läuft auf Port ${PORT}`);
});
