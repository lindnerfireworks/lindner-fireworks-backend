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
 * Berechnet den nächsten möglichen Abholtermin: nur freitags (13-16 Uhr)
 * oder samstags (9-12 Uhr), und erst wenn mindestens 5 Tage Zeit zum
 * Abpacken der Ware vergangen sind. Bestellt jemand z.B. am Mittwoch oder
 * Donnerstag, rutscht der Termin dadurch automatisch auf die Folgewoche.
 */
function computeAbholzeit(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() + 5);
  d.setHours(0, 0, 0, 0);
  while (d.getDay() !== 5 && d.getDay() !== 6) {
    d.setDate(d.getDate() + 1);
  }
  const zeitfenster = d.getDay() === 5 ? "13:00–16:00 Uhr" : "09:00–12:00 Uhr";
  const datum = d.toLocaleDateString("de-AT", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  return `${datum}, ${zeitfenster}`;
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

async function sendCustomerConfirmation({ customerName, customerEmail, items, total, abholtermin }) {
  const abholadresse = process.env.ABHOL_ADRESSE || "Sandleiten 32, 4230 Pregarten, Österreich";
  const termin = abholtermin || computeAbholzeit();
  const kontaktTelefon = process.env.KONTAKT_TELEFON || "+43 650 3015730";
  const kontaktEmail = process.env.KONTAKT_EMAIL || "lindner.fireworks@gmail.com";

  const subject = "Deine Bestellung bei Lindner Fireworks – Bestätigung";
  const text = `Hallo ${customerName},

vielen Dank für deine Bestellung bei Lindner Fireworks!

Deine Artikel:
${itemsListText(items)}

Gesamt: ${formatPrice(total)}

Abholung:
Adresse: ${abholadresse}
Abholtermin: ${termin}

Bitte bring diese E-Mail (oder deinen Namen) zur Abholung mit.

Fragen?
${kontaktTelefon}
${kontaktEmail}

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
      Abholtermin: ${termin}
    </p>
    <p>Bitte bring diese E-Mail (oder deinen Namen) zur Abholung mit.</p>
    <p>Fragen?<br>${kontaktTelefon}<br>${kontaktEmail}</p>
    <p>Liebe Grüße<br>Lindner Fireworks</p>
  `;

  return sendEmail({ to: customerEmail, subject, text, html });
}

async function sendOwnerNotification({ customerName, customerEmail, items, total, abholtermin, invoiceUrl }) {
  const ownerEmail = process.env.OWNER_EMAIL || "[LUKAS E-MAIL HIER EINTRAGEN]";
  const termin = abholtermin || computeAbholzeit();

  const subject = `Neue Bestellung – ${customerName}`;
  const text = `Neue Bestellung im Shop eingegangen:

Kunde: ${customerName} (${customerEmail})

Artikel:
${itemsListText(items)}

Gesamt: ${formatPrice(total)}

Abholtermin (Kunde wurde bereits informiert): ${termin}
${invoiceUrl ? `\nRechnung (PDF, zum Ansehen/Ausdrucken): ${invoiceUrl}\n` : ""}
Zeitpunkt: ${new Date().toLocaleString("de-AT")}`;

  const html = `
    <p><strong>Neue Bestellung im Shop eingegangen</strong></p>
    <p>Kunde: ${customerName} (${customerEmail})</p>
    <table style="border-collapse:collapse; margin:16px 0;">${itemsListHtml(items)}</table>
    <p><strong>Gesamt: ${formatPrice(total)}</strong></p>
    <p><strong>Abholtermin (Kunde wurde bereits informiert):</strong> ${termin}</p>
    ${invoiceUrl ? `<p>📎 <a href="${invoiceUrl}"><strong>Rechnung ansehen / ausdrucken (PDF)</strong></a></p>` : ""}
    <p>Zeitpunkt: ${new Date().toLocaleString("de-AT")}</p>
  `;

  return sendEmail({ to: ownerEmail, subject, text, html });
}

async function sendContactNotification({ name, email, subject, message }) {
  const ownerEmail = process.env.OWNER_EMAIL || "[LUKAS E-MAIL HIER EINTRAGEN]";

  const mailSubject = `Neue Kontaktanfrage${subject ? `: ${subject}` : ""} – ${name}`;
  const text = `Neue Nachricht über das Kontaktformular:

Von: ${name} (${email})
Betreff: ${subject || "(kein Betreff)"}

Nachricht:
${message}

Zeitpunkt: ${new Date().toLocaleString("de-AT")}`;

  const html = `
    <p><strong>Neue Nachricht über das Kontaktformular</strong></p>
    <p>Von: ${name} (${email})</p>
    <p>Betreff: ${subject || "(kein Betreff)"}</p>
    <p>Nachricht:<br>${String(message).replace(/\n/g, "<br>")}</p>
    <p>Zeitpunkt: ${new Date().toLocaleString("de-AT")}</p>
  `;

  return sendEmail({ to: ownerEmail, subject: mailSubject, text, html });
}

async function sendContactConfirmation({ name, email }) {
  const kontaktTelefon = process.env.KONTAKT_TELEFON || "+43 650 3015730";
  const kontaktEmail = process.env.KONTAKT_EMAIL || "lindner.fireworks@gmail.com";

  const subject = "Deine Nachricht bei Lindner Fireworks ist angekommen";
  const text = `Hallo ${name},

danke für deine Nachricht! Wir haben sie erhalten und melden uns so schnell wie möglich bei dir zurück.

Fragen in der Zwischenzeit?
${kontaktTelefon}
${kontaktEmail}

Liebe Grüße
Lindner Fireworks`;

  const html = `
    <p>Hallo ${name},</p>
    <p>danke für deine Nachricht! Wir haben sie erhalten und melden uns so schnell wie möglich bei dir zurück.</p>
    <p>Fragen in der Zwischenzeit?<br>${kontaktTelefon}<br>${kontaktEmail}</p>
    <p>Liebe Grüße<br>Lindner Fireworks</p>
  `;

  return sendEmail({ to: email, subject, text, html });
}

async function sendBookingNotification({ name, email, phone, occasion, date, location, message }) {
  const ownerEmail = process.env.OWNER_EMAIL || "[LUKAS E-MAIL HIER EINTRAGEN]";

  const mailSubject = `Neue Show-Buchungsanfrage – ${name} (${occasion || "kein Anlass angegeben"})`;
  const text = `Neue Anfrage über "Show buchen":

Name: ${name}
E-Mail: ${email}
Telefon: ${phone || "-"}
Anlass: ${occasion || "-"}
Gewünschtes Datum: ${date || "-"}
Veranstaltungsort: ${location || "-"}

Nachricht:
${message || "-"}

Zeitpunkt: ${new Date().toLocaleString("de-AT")}`;

  const html = `
    <p><strong>Neue Anfrage über "Show buchen"</strong></p>
    <p>
      Name: ${name}<br>
      E-Mail: ${email}<br>
      Telefon: ${phone || "-"}<br>
      Anlass: ${occasion || "-"}<br>
      Gewünschtes Datum: ${date || "-"}<br>
      Veranstaltungsort: ${location || "-"}
    </p>
    <p>Nachricht:<br>${String(message || "-").replace(/\n/g, "<br>")}</p>
    <p>Zeitpunkt: ${new Date().toLocaleString("de-AT")}</p>
  `;

  return sendEmail({ to: ownerEmail, subject: mailSubject, text, html });
}

async function sendBookingConfirmation({ name, email, occasion, date }) {
  const kontaktTelefon = process.env.KONTAKT_TELEFON || "+43 650 3015730";
  const kontaktEmail = process.env.KONTAKT_EMAIL || "lindner.fireworks@gmail.com";

  const subject = "Deine Show-Anfrage bei Lindner Fireworks";
  const text = `Hallo ${name},

danke für deine Anfrage${occasion ? ` für "${occasion}"` : ""}${date ? ` am ${date}` : ""}!

Wir melden uns zeitnah bei dir, um alles Weitere persönlich zu besprechen.

Fragen?
${kontaktTelefon}
${kontaktEmail}

Liebe Grüße
Lindner Fireworks`;

  const html = `
    <p>Hallo ${name},</p>
    <p>danke für deine Anfrage${occasion ? ` für "${occasion}"` : ""}${date ? ` am ${date}` : ""}!</p>
    <p>Wir melden uns zeitnah bei dir, um alles Weitere persönlich zu besprechen.</p>
    <p>Fragen?<br>${kontaktTelefon}<br>${kontaktEmail}</p>
    <p>Liebe Grüße<br>Lindner Fireworks</p>
  `;

  return sendEmail({ to: email, subject, text, html });
}

module.exports = {
  sendCustomerConfirmation,
  sendOwnerNotification,
  sendContactNotification,
  sendContactConfirmation,
  sendBookingNotification,
  sendBookingConfirmation,
  computeAbholzeit,
};
