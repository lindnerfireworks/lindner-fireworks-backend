// E-Mail-Versand über Resend (https://resend.com), einfache HTTP-API,
// kein zusätzliches npm-Paket nötig (Node 22 hat fetch() eingebaut).
//
// Die HTML-Vorlagen entsprechen den Entwürfen in /email-vorlagen. Das Logo
// wird per absoluter URL geladen – relative Pfade funktionieren in E-Mails
// grundsätzlich nicht.
//
// Konfiguration über Umgebungsvariablen:
//   RESEND_API_KEY   – API-Key von resend.com
//   RESEND_FROM      – Absender, z.B. "Lindner Fireworks <bestellung@domain.at>"
//   OWNER_EMAIL      – wohin interne Benachrichtigungen gehen
//   SITE_BASE_URL    – öffentliche Adresse der Website (für das Logo)
//   PUBLIC_BASE_URL  – öffentliche Adresse DIESES Servers (für den Abholschein-Link)
//   ABHOL_ADRESSE, KONTAKT_TELEFON, KONTAKT_EMAIL – Angaben in den Mails

const RESEND_API_URL = "https://api.resend.com/emails";

const SITE_BASE_URL = (process.env.SITE_BASE_URL || "https://lindner-fireworks.netlify.app").replace(/\/$/, "");
const LOGO_URL = `${SITE_BASE_URL}/assets/logo-email.png`;

const ABSENDER_NAME = "Lindner Fireworks";
const ADRESSE = process.env.ABHOL_ADRESSE || "Sandleiten 32, 4230 Pregarten, Österreich";
const TELEFON = process.env.KONTAKT_TELEFON || "+43 650 3015730";
const EMAIL_KONTAKT = process.env.KONTAKT_EMAIL || "lindner.fireworks@gmail.com";

// Farbschema je Mail-Typ (entspricht den Vorlagen in /email-vorlagen)
const THEME = {
  bestellung: { line: "#ff45b4", head: "#e10586", soft: "#fdf1f8" },
  intern:     { line: "#ed6b00", head: "#c0580d", soft: "#fff5eb" },
  kontakt:    { line: "#15a679", head: "#10875e", soft: "#eafaf4" },
  buchung:    { line: "#169ccc", head: "#007eb6", soft: "#eaf6fb" },
};

/** Schützt vor kaputtem Layout und HTML-Injection durch Formulareingaben. */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function nl2br(value) {
  return escapeHtml(value).replace(/\r?\n/g, "<br>");
}

function formatPrice(n) {
  return n.toFixed(2).replace(".", ",") + " €";
}

function itemsListText(items) {
  return items
    .map((it) => `  - ${it.name} × ${it.qty} = ${formatPrice(it.qty * it.price)}`)
    .join("\n");
}

/**
 * Berechnet den nächsten möglichen Abholtermin: nur freitags (13-16 Uhr)
 * oder samstags (9-12 Uhr), und erst wenn mindestens 5 Tage Zeit zum
 * Abpacken der Ware vergangen sind.
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

// ---------------------------------------------------------------------------
// Layout-Bausteine
// ---------------------------------------------------------------------------

/**
 * Rahmen für alle Mails: grauer Hintergrund, weiße Karte, Logo, farbige
 * Trennlinie, Titel, Inhalt, Fußzeile.
 *
 * Bewusst mit <table> und Inline-Styles gebaut – Outlook und die meisten
 * Mailclients unterstützen weder Flexbox noch <style>-Blöcke zuverlässig.
 */
function layout({ theme, title, kicker, content, footer }) {
  const t = THEME[theme] || THEME.bestellung;
  const fuss =
    footer ||
    `<strong style="color:#24273a;">LINDNER FIREWORKS</strong><br>
     ${escapeHtml(ADRESSE)}<br>
     ${escapeHtml(TELEFON)} · ${escapeHtml(EMAIL_KONTAKT)}<br>
     <span style="color:#9aa0b4;">Pyrotechnik &amp; Show-Feuerwerke</span>`;

  return `<!DOCTYPE html>
<html lang="de">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0; padding:0; background:#f5f6fb; font-family:Arial, Helvetica, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6fb; padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px; max-width:100%; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 6px 28px rgba(36,39,58,0.08);">

        <tr>
          <td style="padding:28px 40px; text-align:center; border-bottom:3px solid ${t.line};">
            <img src="${LOGO_URL}" alt="Lindner Fireworks" width="220" style="display:block; margin:0 auto; border:0; max-width:220px; height:auto;">
          </td>
        </tr>

        <tr>
          <td style="padding:32px 40px 4px;">
            <h1 style="margin:0 0 4px; font-family:Arial, sans-serif; font-size:22px; font-weight:800; color:${t.head};">${title}</h1>
            <p style="margin:0; font-size:13px; letter-spacing:1px; color:#9aa0b4; text-transform:uppercase;">${escapeHtml(kicker)}</p>
          </td>
        </tr>

        ${content}

        <tr>
          <td style="padding:24px 40px; background:#f5f6fb; text-align:center; font-size:12px; color:#6b7086; border-top:1px solid #e3e5f0;">
            ${fuss}
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/** Absatzblock im Standardabstand. */
function block(inner, padding = "16px 40px 0") {
  return `<tr><td style="padding:${padding}; font-size:15px; line-height:1.6; color:#24273a;">${inner}</td></tr>`;
}

/** Hervorgehobener Kasten (z.B. Abholung, Kundendaten). */
function box(inner, theme, dashed = false) {
  const t = THEME[theme] || THEME.bestellung;
  const border = dashed ? `border:1.5px dashed ${t.line};` : "";
  return `<tr><td style="padding:20px 40px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t.soft}; border-radius:10px; ${border}">
      <tr><td style="padding:16px 18px; font-size:14px; line-height:1.7; color:#24273a;">${inner}</td></tr>
    </table>
  </td></tr>`;
}

/** Artikeltabelle mit Summenzeile. */
function itemsTable(items, total, theme) {
  const t = THEME[theme] || THEME.bestellung;
  const th = 'style="padding:8px 0; font-weight:700; color:#6b7086; font-size:12px; text-transform:uppercase;"';
  const rows = items
    .map(
      (it) => `<tr style="border-bottom:1px solid #e3e5f0;">
        <td style="padding:10px 0;">${escapeHtml(it.name)}</td>
        <td style="padding:10px 0;" align="center">× ${escapeHtml(it.qty)}</td>
        <td style="padding:10px 0;" align="right">${formatPrice(it.qty * it.price)}</td>
      </tr>`
    )
    .join("");

  return `<tr><td style="padding:20px 40px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse; font-size:14px; color:#24273a;">
      <tr style="border-bottom:2px solid #e3e5f0;">
        <td ${th}>Artikel</td><td ${th} align="center">Menge</td><td ${th} align="right">Preis</td>
      </tr>
      ${rows}
      <tr>
        <td style="padding:14px 0 4px;" colspan="2"><strong>Gesamt</strong></td>
        <td style="padding:14px 0 4px;" align="right"><strong style="font-size:17px; color:${t.head};">${formatPrice(total)}</strong></td>
      </tr>
    </table>
  </td></tr>`;
}

function kontaktBlock() {
  return block(
    `<p style="margin:0 0 4px;">Fragen?<br><strong>${escapeHtml(TELEFON)}</strong><br><strong>${escapeHtml(EMAIL_KONTAKT)}</strong></p>
     <p style="margin:16px 0 0;">Liebe Grüße<br><strong>Lindner Fireworks</strong></p>`,
    "24px 40px 32px"
  );
}

function zeitstempel(text) {
  return `<tr><td style="padding:20px 40px 32px; font-size:13px; color:#6b7086;">${escapeHtml(text)}</td></tr>`;
}

// ---------------------------------------------------------------------------
// Versand
// ---------------------------------------------------------------------------

/**
 * Sendet eine einzelne E-Mail über die Resend-API.
 * Wirft KEINEN Fehler nach außen, wenn kein API-Key gesetzt ist – dann wird
 * nur eine Warnung geloggt (praktisch für lokales Testen ohne echten Account).
 */
async function sendEmail({ to, subject, text, html, attachments }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || `${ABSENDER_NAME} <onboarding@resend.dev>`;

  if (!apiKey) {
    console.warn(
      `[email] RESEND_API_KEY nicht gesetzt – E-Mail an ${to} wird NICHT verschickt (nur simuliert).\n` +
        `Betreff: ${subject}\n${text}\n`
    );
    return { ok: false, simulated: true };
  }

  const payload = { from, to, subject, text, html };
  if (attachments && attachments.length) payload.attachments = attachments;

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[email] Resend-Fehler (${res.status}) beim Senden an ${to}: ${body}`);
    return { ok: false, status: res.status };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 01 – Bestellbestätigung an den Kunden
// ---------------------------------------------------------------------------

async function sendCustomerConfirmation({
  customerName,
  customerEmail,
  items,
  total,
  abholtermin,
  reservationNumber,
  abholscheinPdf,
}) {
  const termin = abholtermin || computeAbholzeit();
  const subject = "Deine Reservierung bei Lindner Fireworks – Bestätigung";

  const rechnungHinweis = abholscheinPdf
    ? box(
        `📎 <strong>Abholschein im Anhang</strong> (PDF)${reservationNumber ? ` — Reservierungsnr. ${escapeHtml(reservationNumber)}` : ""}`,
        "bestellung",
        true
      )
    : "";

  const html = layout({
    theme: "bestellung",
    title: "RESERVIERUNG BESTÄTIGT ✔",
    kicker: "Silvester-Shop",
    content:
      block(
        `<p style="margin:0 0 16px;">Hallo ${escapeHtml(customerName)},</p>
         <p style="margin:0 0 4px;">vielen Dank für deine Reservierung bei <strong>Lindner Fireworks</strong>! Hier deine Bestätigung:</p>`
      ) +
      itemsTable(items, total, "bestellung") +
      rechnungHinweis +
      box(
        `<strong style="color:#007eb6;">ABHOLUNG</strong><br>
         Adresse: ${escapeHtml(ADRESSE)}<br>
         Abholtermin: ${escapeHtml(termin)}<br>
         <span style="color:#6b7086; font-size:13px;">Bitte diese E-Mail oder deinen Namen zur Abholung mitbringen.</span>`,
        "kontakt"
      ) +
      kontaktBlock(),
  });

  const text = `Hallo ${customerName},

vielen Dank für deine Reservierung bei Lindner Fireworks!

Deine Artikel:
${itemsListText(items)}

Gesamt: ${formatPrice(total)}
${reservationNumber ? `Reservierungsnummer: ${reservationNumber}\n` : ""}
Abholung:
Adresse: ${ADRESSE}
Abholtermin: ${termin}

Bitte bring diese E-Mail (oder deinen Namen) zur Abholung mit.

Fragen?
${TELEFON}
${EMAIL_KONTAKT}

Liebe Grüße
Lindner Fireworks`;

  const attachments = abholscheinPdf
    ? [
        {
          filename: `Abholschein-${reservationNumber || "Lindner-Fireworks"}.pdf`,
          content: Buffer.isBuffer(abholscheinPdf) ? abholscheinPdf.toString("base64") : abholscheinPdf,
        },
      ]
    : undefined;

  return sendEmail({ to: customerEmail, subject, text, html, attachments });
}

// ---------------------------------------------------------------------------
// 02 – Neue Bestellung an Lukas
// ---------------------------------------------------------------------------

async function sendOwnerNotification({
  customerName,
  customerEmail,
  items,
  total,
  abholtermin,
  abholscheinUrl,
  reservationNumber,
  abholscheinPdf,
}) {
  const ownerEmail = process.env.OWNER_EMAIL || "[LUKAS E-MAIL HIER EINTRAGEN]";
  const termin = abholtermin || computeAbholzeit();
  const zeitpunkt = new Date().toLocaleString("de-AT");
  const subject = `Neue Reservierung – ${customerName}`;

  const rechnungBlock = (abholscheinPdf || abholscheinUrl)
    ? box(
        `📎 <strong>Abholschein im Anhang</strong> (PDF) zum Ausdrucken und Mitnehmen` +
          `${reservationNumber ? ` — Reservierungsnr. ${escapeHtml(reservationNumber)}` : ""}` +
          `${abholscheinUrl ? `<br><span style="font-size:13px;">Oder <a href="${escapeHtml(abholscheinUrl)}" style="color:#e10586; font-weight:700; text-decoration:none;">online öffnen</a></span>` : ""}`,
        "bestellung",
        true
      )
    : "";

  const html = layout({
    theme: "intern",
    title: "🔔 NEUE RESERVIERUNG",
    kicker: "Interne Benachrichtigung",
    content:
      box(
        `<strong>Kunde:</strong> ${escapeHtml(customerName)}<br>
         <strong>E-Mail:</strong> <a href="mailto:${escapeHtml(customerEmail)}" style="color:#c0580d;">${escapeHtml(customerEmail)}</a>`,
        "intern"
      ) +
      itemsTable(items, total, "intern") +
      box(
        `<strong style="color:#c0580d;">ABHOLTERMIN (Kunde wurde bereits informiert)</strong><br>${escapeHtml(termin)}`,
        "intern",
        true
      ) +
      rechnungBlock +
      zeitstempel(`Eingegangen am ${zeitpunkt} · Bestand wurde automatisch reserviert.`),
    footer: `<strong style="color:#24273a;">LINDNER FIREWORKS</strong> — Backend-Benachrichtigung`,
  });

  const text = `Neue Reservierung im Shop eingegangen:

Kunde: ${customerName} (${customerEmail})

Artikel:
${itemsListText(items)}

Gesamt: ${formatPrice(total)}

Abholtermin (Kunde wurde bereits informiert): ${termin}
${abholscheinPdf ? "\nAbholschein: siehe Anhang (PDF)\n" : ""}${abholscheinUrl ? `Online: ${abholscheinUrl}\n` : ""}
Zeitpunkt: ${zeitpunkt}`;

  const attachments = abholscheinPdf
    ? [
        {
          filename: `Abholschein-${reservationNumber || "Lindner-Fireworks"}.pdf`,
          content: Buffer.isBuffer(abholscheinPdf) ? abholscheinPdf.toString("base64") : abholscheinPdf,
        },
      ]
    : undefined;

  return sendEmail({ to: ownerEmail, subject, text, html, attachments });
}

// ---------------------------------------------------------------------------
// 03 – Kontaktanfrage: Bestätigung an den Kunden
// ---------------------------------------------------------------------------

async function sendContactConfirmation({ name, email }) {
  const subject = "Deine Nachricht bei Lindner Fireworks ist angekommen";

  const html = layout({
    theme: "kontakt",
    title: "NACHRICHT ANGEKOMMEN ✔",
    kicker: "Kontakt",
    content:
      block(
        `<p style="margin:0 0 16px;">Hallo ${escapeHtml(name)},</p>
         <p style="margin:0;">danke für deine Nachricht! Wir haben sie erhalten und melden uns so schnell wie möglich bei dir zurück.</p>`
      ) +
      block(
        `<p style="margin:0 0 4px;">Fragen in der Zwischenzeit?<br><strong>${escapeHtml(TELEFON)}</strong><br><strong>${escapeHtml(EMAIL_KONTAKT)}</strong></p>
         <p style="margin:20px 0 0;">Liebe Grüße<br><strong>Lindner Fireworks</strong></p>`,
        "20px 40px 40px"
      ),
  });

  const text = `Hallo ${name},

danke für deine Nachricht! Wir haben sie erhalten und melden uns so schnell wie möglich bei dir zurück.

Fragen in der Zwischenzeit?
${TELEFON}
${EMAIL_KONTAKT}

Liebe Grüße
Lindner Fireworks`;

  return sendEmail({ to: email, subject, text, html });
}

// ---------------------------------------------------------------------------
// 03b – Kontaktanfrage: Benachrichtigung an Lukas
// ---------------------------------------------------------------------------

async function sendContactNotification({ name, email, subject, message }) {
  const ownerEmail = process.env.OWNER_EMAIL || "[LUKAS E-MAIL HIER EINTRAGEN]";
  const zeitpunkt = new Date().toLocaleString("de-AT");
  const mailSubject = `Neue Kontaktanfrage${subject ? `: ${subject}` : ""} – ${name}`;

  const html = layout({
    theme: "intern",
    title: "✉️ NEUE KONTAKTANFRAGE",
    kicker: "Interne Benachrichtigung",
    content:
      box(
        `<strong>Von:</strong> ${escapeHtml(name)}<br>
         <strong>E-Mail:</strong> <a href="mailto:${escapeHtml(email)}" style="color:#c0580d;">${escapeHtml(email)}</a><br>
         <strong>Betreff:</strong> ${escapeHtml(subject || "(kein Betreff)")}`,
        "intern"
      ) +
      block(
        `<p style="margin:0 0 6px; font-weight:700; color:#6b7086; font-size:12px; text-transform:uppercase;">Nachricht</p>
         <p style="margin:0;">${nl2br(message)}</p>`,
        "20px 40px 0"
      ) +
      zeitstempel(`Eingegangen am ${zeitpunkt}`),
    footer: `<strong style="color:#24273a;">LINDNER FIREWORKS</strong> — Backend-Benachrichtigung`,
  });

  const text = `Neue Nachricht über das Kontaktformular:

Von: ${name} (${email})
Betreff: ${subject || "(kein Betreff)"}

Nachricht:
${message}

Zeitpunkt: ${zeitpunkt}`;

  return sendEmail({ to: ownerEmail, subject: mailSubject, text, html });
}

// ---------------------------------------------------------------------------
// 04 – Show-Buchungsanfrage an Lukas
// ---------------------------------------------------------------------------

async function sendBookingNotification({ name, email, phone, occasion, date, location, message }) {
  const ownerEmail = process.env.OWNER_EMAIL || "[LUKAS E-MAIL HIER EINTRAGEN]";
  const zeitpunkt = new Date().toLocaleString("de-AT");
  const mailSubject = `Neue Show-Buchungsanfrage – ${name} (${occasion || "kein Anlass angegeben"})`;

  const html = layout({
    theme: "intern",
    title: "🎆 NEUE SHOW-ANFRAGE",
    kicker: "Interne Benachrichtigung",
    content:
      box(
        `<strong>Name:</strong> ${escapeHtml(name)}<br>
         <strong>E-Mail:</strong> <a href="mailto:${escapeHtml(email)}" style="color:#c0580d;">${escapeHtml(email)}</a><br>
         <strong>Telefon:</strong> ${escapeHtml(phone || "–")}<br>
         <strong>Anlass:</strong> ${escapeHtml(occasion || "–")}<br>
         <strong>Gewünschtes Datum:</strong> ${escapeHtml(date || "–")}<br>
         <strong>Veranstaltungsort:</strong> ${escapeHtml(location || "–")}`,
        "intern"
      ) +
      block(
        `<p style="margin:0 0 6px; font-weight:700; color:#6b7086; font-size:12px; text-transform:uppercase;">Nachricht</p>
         <p style="margin:0;">${nl2br(message || "–")}</p>`,
        "20px 40px 0"
      ) +
      zeitstempel(`Eingegangen am ${zeitpunkt}`),
    footer: `<strong style="color:#24273a;">LINDNER FIREWORKS</strong> — Backend-Benachrichtigung`,
  });

  const text = `Neue Anfrage über "Show buchen":

Name: ${name}
E-Mail: ${email}
Telefon: ${phone || "-"}
Anlass: ${occasion || "-"}
Gewünschtes Datum: ${date || "-"}
Veranstaltungsort: ${location || "-"}

Nachricht:
${message || "-"}

Zeitpunkt: ${zeitpunkt}`;

  return sendEmail({ to: ownerEmail, subject: mailSubject, text, html });
}

// ---------------------------------------------------------------------------
// 05 – Show-Buchungsanfrage: Bestätigung an den Kunden
// ---------------------------------------------------------------------------

async function sendBookingConfirmation({ name, email, occasion, date }) {
  const subject = "Deine Show-Anfrage bei Lindner Fireworks";

  const anlassText = occasion
    ? ` für <strong>„${escapeHtml(occasion)}"</strong>`
    : "";
  const datumText = date ? ` am <strong>${escapeHtml(date)}</strong>` : "";

  const html = layout({
    theme: "buchung",
    title: "ANFRAGE ERHALTEN ✔",
    kicker: "Show-Feuerwerke",
    content:
      block(
        `<p style="margin:0 0 16px;">Hallo ${escapeHtml(name)},</p>
         <p style="margin:0 0 16px;">danke für deine Anfrage${anlassText}${datumText}!</p>
         <p style="margin:0;">Wir melden uns zeitnah bei dir, um alles Weitere persönlich zu besprechen.</p>`
      ) +
      block(
        `<p style="margin:0 0 4px;">Fragen?<br><strong>${escapeHtml(TELEFON)}</strong><br><strong>${escapeHtml(EMAIL_KONTAKT)}</strong></p>
         <p style="margin:20px 0 0;">Liebe Grüße<br><strong>Lindner Fireworks</strong></p>`,
        "20px 40px 40px"
      ),
  });

  const text = `Hallo ${name},

danke für deine Anfrage${occasion ? ` für "${occasion}"` : ""}${date ? ` am ${date}` : ""}!

Wir melden uns zeitnah bei dir, um alles Weitere persönlich zu besprechen.

Fragen?
${TELEFON}
${EMAIL_KONTAKT}

Liebe Grüße
Lindner Fireworks`;

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
