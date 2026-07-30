// E-Mail-Versand über Resend (https://resend.com), einfache HTTP-API,
// kein zusätzliches npm-Paket nötig (Node 22 hat fetch() eingebaut).
//
// Platzhalter, die noch mit den echten Angaben befüllt werden müssen (siehe
// README.md und .env.example):
//   - ABHOLADRESSE, ABHOLZEITEN: wo/wann Kunden abholen können
//   - KONTAKT: Telefonnummer/E-Mail für Rückfragen
// Diese stehen absichtlich als gut sichtbare Platzhalter im Text, damit man
// sie nicht vergisst, bevor der Shop live geht.

const RESEND_API_URL = "https://api.resend.com/emails";

function formatPrice(n) {
  return n.toFixed(2).replace(".", ",") + " €";
}

function itemsListText(items) {
  return items
    .map((it) => `  - ${it.name} × ${it.qty} = ${formatPrice(it.qty * it.price)}`)
    .join("\n");
}

function itemsListHtml(items) {
  return items
    .map(
      (it) =>
        `<tr><td style="padding:4px 12px 4px 0;">${it.name}</td><td style="padding:4px 12px;">× ${it.qty}</td><td style="padding:4px 0; text-align:right;">${formatPrice(it.qty * it.price)}</td></tr>`
    )
    .join("");
}

/**
 * Sendet eine einzelne E-Mail über die Resend-API.
 * Wirft KEINEN Fehler nach außen, wenn kein API-Key gesetzt ist – dann wird
 * nur eine Warnung geloggt (praktisch für lokales Testen ohne echten Account).
 */
async function sendEmail({ to, subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || "Lindner Fireworks <onboarding@resend.dev>";

  if (!apiKey) {
    console.warn(
      `[email] RESEND_API_KEY nicht gesetzt – E-Mail an ${to} wird NICHT verschickt (nur simuliert).\n` +
        `Betreff: ${subject}\n${text}\n`
    );
    return { ok: false, simulated: true };
  }

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, text, html }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[email] Resend-Fehler (${res.status}) beim Senden an ${to}: ${body}`);
    return { ok: false, status: res.status };
  }

  return { ok: true };
}

async function sendCustomerConfirmation({ customerName, customerEmail, items, total }) {
  const abholadresse = process.env.ABHOL_ADRESSE || "[ABHOLADRESSE HIER EINTRAGEN]";
  const abholzeiten = process.env.ABHOL_ZEITEN || "[ABHOLZEITEN HIER EINTRAGEN]";
  const kontakt = process.env.KONTAKT_INFO || "[TELEFON/E-MAIL FÜR RÜCKFRAGEN HIER EINTRAGEN]";

  const subject = "Deine Bestellung bei Lindner Fireworks – Bestätigung";
  const text = `Hallo ${customerName},

vielen Dank für deine Bestellung bei Lindner Fireworks!

Deine Artikel:
${itemsListText(items)}

Gesamt: ${formatPrice(total)}

Abholung:
Adresse: ${abholadresse}
Abholzeiten: ${abholzeiten}

Bitte bring diese E-Mail (oder deinen Namen) zur Abholung mit.

Fragen? ${kontakt}

Liebe Grüße
Lindner Fireworks`;

  const html = `
    <p>Hallo ${customerName},</p>
    <p>vielen Dank für deine Bestellung bei <strong>Lindner Fireworks</strong>!</p>
    <table style="border-collapse:collapse; margin:16px 0;">${itemsListHtml(items)}</table>
    <p><strong>Gesamt: ${formatPrice(total)}</strong></p>
    <p>
      <strong>Abholung</strong><br>
      Adresse: ${abholadresse}<br>
      Abholzeiten: ${abholzeiten}
    </p>
    <p>Bitte bring diese E-Mail (oder deinen Namen) zur Abholung mit.</p>
    <p>Fragen? ${kontakt}</p>
    <p>Liebe Grüße<br>Lindner Fireworks</p>
  `;

  return sendEmail({ to: customerEmail, subject, text, html });
}

async function sendOwnerNotification({ customerName, customerEmail, items, total }) {
  const ownerEmail = process.env.OWNER_EMAIL || "[LUKAS E-MAIL HIER EINTRAGEN]";

  const subject = `Neue Bestellung – ${customerName}`;
  const text = `Neue Bestellung im Shop eingegangen:

Kunde: ${customerName} (${customerEmail})

Artikel:
${itemsListText(items)}

Gesamt: ${formatPrice(total)}

Zeitpunkt: ${new Date().toLocaleString("de-AT")}`;

  const html = `
    <p><strong>Neue Bestellung im Shop eingegangen</strong></p>
    <p>Kunde: ${customerName} (${customerEmail})</p>
    <table style="border-collapse:collapse; margin:16px 0;">${itemsListHtml(items)}</table>
    <p><strong>Gesamt: ${formatPrice(total)}</strong></p>
    <p>Zeitpunkt: ${new Date().toLocaleString("de-AT")}</p>
  `;

  return sendEmail({ to: ownerEmail, subject, text, html });
}

module.exports = { sendCustomerConfirmation, sendOwnerNotification };
