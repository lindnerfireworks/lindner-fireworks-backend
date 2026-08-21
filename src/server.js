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
  sendDailyDigest,
  slotForDay,
  isoDay,
  formatGermanDate,
} = require("./email");
const { generateReservationPdf } = require("./invoice");
const { getProduct } = require("./catalog");

const PORT = process.env.PORT || 4000;

// ---------------------------------------------------------------------------
// Verkaufsfenster
//
// Vor diesem Datum nimmt der Shop KEINE Reservierungen an. Die Artikel bleiben
// sichtbar und der Warenkorb lässt sich befüllen – nur das Absenden wird
// blockiert, im Browser (Button gesperrt) UND hier serverseitig, damit es sich
// nicht über die Entwicklerkonsole umgehen lässt.
//
// Umstellen ohne Code-Änderung über die Umgebungsvariable ORDERS_OPEN_FROM
// (Format JJJJ-MM-TT, Ortszeit Österreich). Beispiele:
//   ORDERS_OPEN_FROM=2026-12-01   -> ab 1. Dezember 2026, 00:00 Uhr
//   ORDERS_OPEN_FROM=              -> sofort offen (leerer Wert = keine Sperre)
// Optional lässt sich mit ORDERS_OPEN_UNTIL auch ein Ende setzen, z.B. nach
// Silvester: ORDERS_OPEN_UNTIL=2027-01-01
// ---------------------------------------------------------------------------
const ORDERS_OPEN_FROM = (process.env.ORDERS_OPEN_FROM ?? "2026-12-01").trim();
const ORDERS_OPEN_UNTIL = (process.env.ORDERS_OPEN_UNTIL || "").trim();

/**
 * Wandelt "2026-12-01" in einen Zeitpunkt um, der Mitternacht österreichischer
 * Zeit entspricht. Im Dezember gilt MEZ (UTC+1), deshalb wird eine Stunde
 * abgezogen. Bei ungültiger Eingabe wird null geliefert (= keine Sperre), damit
 * ein Tippfehler in der Variable nie den ganzen Shop lahmlegt.
 */
function parseViennaDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00+01:00`);
  return Number.isNaN(ms) ? null : ms;
}

/** Ist der Shop gerade für Reservierungen offen? */
function shopStatus(now = Date.now()) {
  const from = parseViennaDate(ORDERS_OPEN_FROM);
  const until = parseViennaDate(ORDERS_OPEN_UNTIL);

  if (from !== null && now < from) {
    return { open: false, reason: "not_yet", opensAt: ORDERS_OPEN_FROM };
  }
  if (until !== null && now >= until) {
    return { open: false, reason: "season_over", closedSince: ORDERS_OPEN_UNTIL };
  }
  return { open: true, opensAt: from !== null ? ORDERS_OPEN_FROM : null };
}

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

  // Abholtermin + Reservierungsnummer EINMAL berechnen und in der Reservierung
  // speichern, damit Kunden-Mail, Besitzer-Mail und die (später über den
  // Link abrufbare) Abholschein-PDF garantiert denselben Termin/dieselbe
  // Nummer zeigen – auch wenn der Abholschein erst Tage später abgerufen wird.
  const abholtermin = computeAbholzeit();
  const reservationNumber = await store.nextReservationNumber();
  const reservationDate = new Date().toLocaleDateString("de-AT");

  const order = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    customerName,
    customerEmail,
    customerPhone: customerPhone ? String(customerPhone).slice(0, 40) : "",
    items,
    total,
    abholtermin,
    reservationNumber,
    reservationDate,
  };
  await store.appendOrder(order);

  const publicBaseUrl = process.env.PUBLIC_BASE_URL || "";
  const abholscheinUrl = publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, "")}/api/abholschein/${order.id}` : null;

  // Abholschein als PDF erzeugen, damit er der Kundenmail angehängt werden kann.
  // Schlägt das fehl, wird die Mail trotzdem verschickt – nur eben ohne Anhang.
  let abholscheinPdf = null;
  try {
    abholscheinPdf = await generateReservationPdf(order);
  } catch (err) {
    console.error("[order] Abholschein konnte nicht erzeugt werden, Mail geht ohne Anhang raus:", err);
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
      reservationNumber,
      abholscheinPdf,
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
      abholscheinUrl,
      reservationNumber,
      abholscheinPdf,
    }).catch((err) => {
      console.error("[order] Fehler beim Senden der Besitzer-Mail:", err);
      return { ok: false, error: String(err) };
    }),
  ]);

  sendJson(res, 200, { ok: true, order, emails: { customerMailResult, ownerMailResult } });
}

// Liefert den PDF-Abholschein zu einer gespeicherten Reservierung aus (per
// Bestellungs-ID). Wird aus der internen Besitzer-Benachrichtigung heraus
// verlinkt, damit Lukas sie zu Hause direkt öffnen/ausdrucken kann.
async function handleGetAbholschein(req, res, orderId) {
  const order = await store.getOrderById(orderId);
  if (!order) {
    return sendJson(res, 404, { ok: false, error: "not_found" });
  }

  let pdfBuffer;
  try {
    pdfBuffer = await generateReservationPdf(order);
  } catch (err) {
    console.error("[abholschein] Fehler beim Erzeugen des PDF-Abholscheins:", err);
    return sendJson(res, 500, { ok: false, error: "pdf_generation_failed" });
  }

  res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="Abholschein-${order.reservationNumber || order.id}.pdf"`,
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
// ---------------------------------------------------------------------------
// Reservierungsübersicht fürs Handy
//
// Aufruf mit dem bestehenden ADMIN_KEY, z.B. als Lesezeichen am Handy:
//   /api/admin/orders?key=DEINSCHLUESSEL
//
// Zeigt alle Reservierungen nach Abholtag gruppiert, mit Name, Telefon,
// Artikeln und Summe. Bewusst als fertige HTML-Seite statt JSON, damit sie
// unterwegs ohne Hilfsmittel lesbar ist.
//
// Optional: &tag=2026-12-27 zeigt nur diesen einen Abholtag.
// ---------------------------------------------------------------------------

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function euro(n) {
  return Number(n || 0).toFixed(2).replace(".", ",") + " €";
}

/**
 * Sortierschlüssel aus dem Termin-Text ("Freitag, 04.12.2026, 13:00–16:00 Uhr")
 * -> "2026-12-04". Ohne erkennbares Datum kommt der Eintrag ans Ende.
 */
function terminSortKey(abholtermin) {
  const m = String(abholtermin || "").match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "9999-99-99";
}

function groupOrdersByPickup(orders) {
  const groups = new Map();
  for (const o of orders) {
    const key = terminSortKey(o.abholtermin);
    if (!groups.has(key)) {
      groups.set(key, { key, label: o.abholtermin || "Termin noch offen", orders: [] });
    }
    groups.get(key).orders.push(o);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function renderOrdersPage(groups, { total, umsatz, filterTag }) {
  const heute = new Date().toLocaleDateString("de-AT", { timeZone: "Europe/Vienna" });

  const gruppenHtml = groups
    .map((g) => {
      const zeilen = g.orders
        .map((o) => {
          const artikel = (o.items || [])
            .map((it) => `${esc(it.name)} <b>×${esc(it.qty)}</b>`)
            .join("<br>");
          const tel = o.customerPhone
            ? `<a href="tel:${esc(o.customerPhone.replace(/\s/g, ""))}">${esc(o.customerPhone)}</a>`
            : '<span class="muted">keine Nummer</span>';
          return `<div class="order">
            <div class="order-head">
              <span class="resnr">${esc(o.reservationNumber || "—")}</span>
              <span class="sum">${euro(o.total)}</span>
            </div>
            <div class="name">${esc(o.customerName)}</div>
            <div class="contact">${tel} · <a href="mailto:${esc(o.customerEmail)}">${esc(o.customerEmail)}</a></div>
            <div class="items">${artikel || '<span class="muted">keine Artikel</span>'}</div>
          </div>`;
        })
        .join("");

      const gsum = g.orders.reduce((s, o) => s + Number(o.total || 0), 0);
      return `<section class="day">
        <h2>${esc(g.label)}</h2>
        <p class="daymeta">${g.orders.length} ${g.orders.length === 1 ? "Reservierung" : "Reservierungen"} · ${euro(gsum)}</p>
        ${zeilen}
      </section>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Reservierungen — Lindner Fireworks</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; padding:16px; background:#28418c; color:#eef1fb;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; font-size:16px; }
  h1 { font-size:21px; margin:0 0 2px; }
  .meta { color:#cdd3f2; font-size:14px; margin-bottom:20px; }
  .day { margin-bottom:26px; }
  .day h2 { font-size:17px; margin:0 0 2px; color:#72f2bf; }
  .daymeta { margin:0 0 10px; font-size:13px; color:#cdd3f2; }
  .order { background:#3655a6; border:1px solid rgba(255,255,255,0.16);
           border-radius:12px; padding:13px 15px; margin-bottom:9px; }
  .order-head { display:flex; justify-content:space-between; align-items:baseline; gap:10px; }
  .resnr { font-size:12px; letter-spacing:1px; color:#ffd23d; font-weight:700; }
  .sum { font-weight:700; color:#ff6fc4; }
  .name { font-size:18px; font-weight:600; margin:3px 0 2px; }
  .contact { font-size:14px; margin-bottom:8px; }
  .items { font-size:14px; line-height:1.6; color:#cdd3f2;
           border-top:1px solid rgba(255,255,255,0.13); padding-top:8px; }
  .muted { color:#9aa0b4; }
  a { color:#6adfff; }
  .empty { background:#3655a6; border-radius:12px; padding:22px; text-align:center; color:#cdd3f2; }
</style>
</head>
<body>
  <h1>Reservierungen</h1>
  <p class="meta">
    Stand ${esc(heute)} · ${total} ${total === 1 ? "Reservierung" : "Reservierungen"} · ${euro(umsatz)} gesamt
    ${filterTag ? `<br>Gefiltert auf ${esc(filterTag)}` : ""}
  </p>
  ${gruppenHtml || '<div class="empty">Noch keine Reservierungen.</div>'}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Tagesübersicht am Vorabend
//
// Prüft stündlich, ob es in Österreich gerade nach DIGEST_HOUR Uhr ist und ob
// morgen ein Abholtag mit mindestens einer Reservierung ansteht. Wenn ja, geht
// eine Übersichtsmail an OWNER_EMAIL.
//
// Bewusst kein Cron-Dienst: Der Server läuft ohnehin durch, und ein stündlicher
// Timer ist eine Abhängigkeit weniger. Damit ein Neustart nicht zu einer
// zweiten Mail führt, wird der zuletzt verschickte Tag auf dem Volume vermerkt.
//
//   DIGEST_HOUR=18       Uhrzeit (Ortszeit Österreich), Standard 18
//   DIGEST_ENABLED=false schaltet die Funktion ab
// ---------------------------------------------------------------------------
const fsp = require("fs/promises");
const path = require("path");

const DIGEST_HOUR = Number(process.env.DIGEST_HOUR || 18);
const DIGEST_ENABLED = (process.env.DIGEST_ENABLED || "true") !== "false";
const DIGEST_STATE_FILE = path.join(__dirname, "..", "data", "digest-state.json");

/** Stunde und Datum in österreichischer Zeit. */
function viennaNowParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Vienna",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
  };
}

async function readDigestState() {
  try {
    return JSON.parse(await fsp.readFile(DIGEST_STATE_FILE, "utf8"));
  } catch (err) {
    return { lastSentFor: null };
  }
}

async function writeDigestState(state) {
  try {
    await fsp.mkdir(path.dirname(DIGEST_STATE_FILE), { recursive: true });
    await fsp.writeFile(DIGEST_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.error("[digest] Konnte Status nicht speichern:", err.message);
  }
}

/**
 * Ein Durchlauf. Gibt zurück, was passiert ist – erleichtert das Testen.
 * force=true ignoriert Uhrzeit und Doppelsende-Schutz.
 */
async function runDailyDigest({ now = new Date(), force = false } = {}) {
  if (!DIGEST_ENABLED && !force) return { skipped: "disabled" };

  const { day, hour } = viennaNowParts(now);
  if (!force && hour < DIGEST_HOUR) return { skipped: "zu_frueh" };

  // Der Abholtag von morgen
  const morgen = new Date(`${day}T12:00:00Z`);
  morgen.setUTCDate(morgen.getUTCDate() + 1);
  const morgenIso = isoDay(morgen);

  if (!slotForDay(morgen)) return { skipped: "morgen_kein_abholtag", morgenIso };

  const state = await readDigestState();
  if (!force && state.lastSentFor === morgenIso) return { skipped: "schon_verschickt", morgenIso };

  const alle = await store.getOrders();
  const orders = alle.filter((o) => terminSortKey(o.abholtermin) === morgenIso);
  if (orders.length === 0) {
    await writeDigestState({ lastSentFor: morgenIso });
    return { skipped: "keine_abholungen", morgenIso };
  }

  const adminKey = process.env.ADMIN_KEY;
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const adminUrl =
    base && adminKey ? `${base}/api/admin/orders?key=${encodeURIComponent(adminKey)}&tag=${morgenIso}` : null;

  const result = await sendDailyDigest({
    datumLabel: formatGermanDate(morgen),
    orders,
    adminUrl,
  });

  await writeDigestState({ lastSentFor: morgenIso });
  console.log(`[digest] Tagesübersicht für ${morgenIso} verschickt (${orders.length} Abholungen).`);
  return { sent: true, morgenIso, count: orders.length, result };
}

function scheduleDailyDigest() {
  if (!DIGEST_ENABLED) {
    console.log("[digest] Tagesübersicht ist per DIGEST_ENABLED=false abgeschaltet.");
    return;
  }
  const tick = () => {
    runDailyDigest().catch((err) => console.error("[digest] Fehler:", err));
  };
  tick(); // einmal direkt nach dem Start
  setInterval(tick, 60 * 60 * 1000).unref();
  console.log(`[digest] Tagesübersicht aktiv, Versand ab ${DIGEST_HOUR}:00 Uhr am Vorabend.`);
}

async function handleAdminOrders(req, res, url) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    return sendJson(res, 503, { ok: false, error: "admin_disabled" });
  }
  if (url.searchParams.get("key") !== adminKey) {
    return sendJson(res, 401, { ok: false, error: "unauthorized" });
  }

  let orders = await store.getOrders();
  const filterTag = url.searchParams.get("tag");
  if (filterTag) {
    orders = orders.filter((o) => terminSortKey(o.abholtermin) === filterTag);
  }

  // JSON statt HTML, falls jemand die Daten weiterverarbeiten will
  if (url.searchParams.get("format") === "json") {
    return sendJson(res, 200, { ok: true, count: orders.length, orders });
  }

  const groups = groupOrdersByPickup(orders);
  const umsatz = orders.reduce((s, o) => s + Number(o.total || 0), 0);
  const html = renderOrdersPage(groups, { total: orders.length, umsatz, filterTag });

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
  });
  res.end(html);
}

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

    // Die Website fragt hier ab, ob der Shop schon Reservierungen annimmt,
    // und blendet danach den Hinweis ein bzw. sperrt den Absende-Button.
    if (req.method === "GET" && url.pathname === "/api/shop-status") {
      return sendJson(res, 200, { ok: true, ...shopStatus() });
    }

    if (req.method === "POST" && url.pathname === "/api/order") {
      // Verkaufsfenster prüfen, BEVOR irgendetwas abgebucht oder gemailt wird.
      const status = shopStatus();
      if (!status.open) {
        return sendJson(res, 403, { ok: false, error: "shop_closed", ...status });
      }

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

    if (req.method === "GET" && url.pathname === "/api/admin/orders") {
      return await handleAdminOrders(req, res, url);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/adjust-stock") {
      return await handleAdminAdjustStock(req, res, url);
    }

    const abholscheinMatch = url.pathname.match(/^\/api\/abholschein\/([a-f0-9-]{36})$/i);
    if (req.method === "GET" && abholscheinMatch) {
      return await handleGetAbholschein(req, res, abholscheinMatch[1]);
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
  } catch (err) {
    console.error("[server] Unerwarteter Fehler:", err);
    sendJson(res, 500, { ok: false, error: "internal_error" });
  }
});

server.listen(PORT, () => {
  console.log(`Lindner Fireworks Backend läuft auf Port ${PORT}`);
  scheduleDailyDigest();
});
