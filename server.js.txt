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
const { sendCustomerConfirmation, sendOwnerNotification } = require("./email");

const PORT = process.env.PORT || 4000;

function setCorsHeaders(res) {
  // TODO vor Live-Betrieb: statt "*" die echte Website-Domain eintragen.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

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
//   items: [{ id: "big-party-2", name: "Big Party 2", price: 75.8, qty: 2 }, ...]
// }
//
// Hinweis: Name/Preis pro Artikel kommen hier vom Frontend, nicht aus einer
// serverseitigen Preisliste. Für einen Shop ohne Online-Bezahlung (nur
// Abholung/Barzahlung, wie hier) ist das unkritisch. Käme hier später mal
// echtes Online-Bezahlen dazu, müsste der Preis stattdessen serverseitig aus
// data/products.json nachgeschlagen werden, damit niemand den Preis im
// Browser manipulieren kann.
async function handlePostOrder(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: "invalid_json" });
  }

  const { customerName, customerEmail, items } = body || {};

  if (!customerName || !customerEmail || !Array.isArray(items) || items.length === 0) {
    return sendJson(res, 400, { ok: false, error: "invalid_request" });
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

  const order = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    customerName,
    customerEmail,
    items,
    total,
  };
  await store.appendOrder(order);

  // E-Mails verschicken – ein Fehler hier soll die Bestellung selbst nicht
  // rückgängig machen (Bestand ist schon korrekt abgezogen und gespeichert).
  const [customerMailResult, ownerMailResult] = await Promise.all([
    sendCustomerConfirmation({ customerName, customerEmail, items, total }).catch((err) => {
      console.error("[order] Fehler beim Senden der Kunden-Mail:", err);
      return { ok: false, error: String(err) };
    }),
    sendOwnerNotification({ customerName, customerEmail, items, total }).catch((err) => {
      console.error("[order] Fehler beim Senden der Besitzer-Mail:", err);
      return { ok: false, error: String(err) };
    }),
  ]);

  sendJson(res, 200, { ok: true, order, emails: { customerMailResult, ownerMailResult } });
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
  setCorsHeaders(res);

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
      return await handlePostOrder(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/adjust-stock") {
      return await handleAdminAdjustStock(req, res, url);
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
