// Erzeugt den PDF-Abholschein zu einer Reservierung direkt im Server – kein
// externer Dienst nötig. Nutzt "pdfkit", die einzige externe Abhängigkeit in
// diesem Projekt (bewusste Ausnahme von der "keine externen Pakete"-Regel,
// siehe package.json/README: für PDF-Erzeugung hat Node kein Bordmittel).
//
// WICHTIG (Kleinunternehmerregelung): Es wird KEINE Umsatzsteuer ausgewiesen,
// stattdessen der gesetzlich vorgeschriebene Hinweistext
// (§ 6 Abs. 1 Z 27 UStG).

const path = require("path");
const PDFDocument = require("pdfkit");

const PINK = "#e10586";
const GRAY = "#6b7086";
const DARK = "#24273a";

const LOGO_PATH = path.join(__dirname, "..", "..", "assets", "logo.png");

function formatPrice(n) {
  return Number(n).toFixed(2).replace(".", ",") + " €";
}

/**
 * Erzeugt den Abholschein als PDF (Buffer) für eine gespeicherte Reservierung.
 * Erwartet: { reservationNumber, reservationDate, customerName, items, total, abholtermin }
 * (items: [{ name, qty, price }, ...])
 */
function generateReservationPdf(order) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const abholadresse = process.env.ABHOL_ADRESSE?.trim() || "Abholort noch nicht eingerichtet";
      const anfahrtUrl = process.env.ABHOL_ANFAHRT_URL?.trim() || "";
      const kontaktTelefon = process.env.KONTAKT_TELEFON || "+43 650 3015730";
      const kontaktEmail = process.env.KONTAKT_EMAIL || "lindner.fireworks@gmail.com";
      const reservationDate = order.reservationDate || new Date().toLocaleDateString("de-AT");
      const reservationNumber = order.reservationNumber || "—";
      const abholtermin = order.abholtermin || "—";

      // ---- Kopf: Logo + Überschrift ----
      try {
        doc.image(LOGO_PATH, 50, 45, { height: 46 });
      } catch (err) {
        // Falls das Logo mal nicht gefunden wird, Abholschein trotzdem ohne Logo erzeugen.
      }
      doc.fontSize(22).fillColor(PINK).font("Helvetica-Bold").text("ABHOLSCHEIN", 0, 58, { align: "right" });

      doc.moveTo(50, 110).lineTo(545, 110).strokeColor("#e3e5f0").lineWidth(1).stroke();

      // ---- Anbieter / Reservierung für ----
      const topY = 125;
      doc
        .fontSize(9)
        .fillColor(GRAY)
        .font("Helvetica-Bold")
        .text("ANBIETER", 50, topY)
        .font("Helvetica")
        .fillColor(DARK)
        .fontSize(10)
        .text("Lukas Lindner", 50, topY + 14)
        .text("Sandleiten 32", 50, topY + 28)
        .text("4230 Pregarten, Österreich", 50, topY + 42)
        .text(kontaktTelefon, 50, topY + 56)
        .text(kontaktEmail, 50, topY + 70);

      doc
        .fontSize(9)
        .fillColor(GRAY)
        .font("Helvetica-Bold")
        .text("RESERVIERT FÜR", 300, topY)
        .font("Helvetica")
        .fillColor(DARK)
        .fontSize(10)
        .text(order.customerName || "-", 300, topY + 14);

      // ---- Meta: Reservierungsnummer / Datum ----
      const metaY = topY + 100;
      doc
        .fontSize(10)
        .fillColor(DARK)
        .font("Helvetica-Bold")
        .text("Reservierungsnummer: ", 50, metaY, { continued: true })
        .font("Helvetica")
        .text(reservationNumber);
      doc.font("Helvetica-Bold").text("Datum: ", 300, metaY, { continued: true }).font("Helvetica").text(reservationDate);

      // ---- Abholung (Adresse, Termin – automatisch generiert wie in der Bestätigungs-Mail) ----
      const abholY = metaY + 26;
      doc.rect(50, abholY, 495, 72).fillColor("#f5f6fb").fill();
      doc
        .fillColor(PINK)
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("ABHOLUNG", 65, abholY + 10)
        .fillColor(DARK)
        .font("Helvetica")
        .text(`Abholort: ${abholadresse}`, 65, abholY + 25)
        .text(`Termin: ${abholtermin}`, 65, abholY + 39)
        .fillColor(PINK)
        .text("Anfahrt öffnen", 65, abholY + 53, { link: anfahrtUrl, underline: true });

      // ---- Artikeltabelle ----
      let y = abholY + 96;
      doc
        .fontSize(9)
        .fillColor(GRAY)
        .font("Helvetica-Bold")
        .text("ARTIKEL", 50, y)
        .text("MENGE", 350, y, { width: 60, align: "center" })
        .text("PREIS", 470, y, { width: 75, align: "right" });
      y += 14;
      doc.moveTo(50, y).lineTo(545, y).strokeColor("#e3e5f0").stroke();
      y += 8;

      doc.font("Helvetica").fillColor(DARK).fontSize(10);
      for (const item of order.items || []) {
        if (y > 650) { doc.addPage(); y = 50; }
        doc.text(item.name, 50, y, { width: 280 });
        doc.text(`× ${item.qty}`, 350, y, { width: 60, align: "center" });
        doc.text(formatPrice(item.price * item.qty), 470, y, { width: 75, align: "right" });
        y += 20;
      }

      y += 4;
      if (y > 590) { doc.addPage(); y = 50; }
      doc.moveTo(50, y).lineTo(545, y).strokeColor("#e3e5f0").stroke();
      y += 10;

      doc.font("Helvetica-Bold").fontSize(13).fillColor(DARK).text("Gesamtbetrag", 50, y, { width: 350 });
      doc.fillColor(PINK).fontSize(15).text(formatPrice(order.total || 0), 470, y - 1, { width: 75, align: "right" });

      // ---- Zahlungs-/Dankeshinweis ----
      y += 42;
      doc
        .font("Helvetica-Bold")
        .fontSize(13)
        .fillColor(PINK)
        .text("Zahlung bar bei Abholung.", 50, y, { width: 495, align: "center" })
        .text("Unverbindliche Reservierung – Kauf erst vor Ort.", 50, y + 18, { width: 495, align: "center" });

      // ---- Kleinunternehmer-Hinweis (kein Umsatzsteuerausweis) ----
      y += 56;
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor(GRAY)
        .text(
          "Kein Umsatzsteuerausweis aufgrund Anwendung der Kleinunternehmerregelung gemäß § 6 Abs. 1 Z 27 UStG.",
          50,
          y,
          { width: 495, align: "center" }
        );

      // ---- Footer ----
      doc
        .fontSize(8)
        .fillColor(GRAY)
        .text(`LINDNER FEUERWERK · ${abholadresse} · ${kontaktTelefon} · ${kontaktEmail}`, 50, 770, {
          width: 495,
          align: "center",
        });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateReservationPdf };
