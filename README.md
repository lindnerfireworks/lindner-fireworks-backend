# Lindner Fireworks – Backend

Kleiner Bestell-Server: echter Lagerbestand (zählt bei jeder Bestellung sofort
runter, keine Überbestellung möglich), plus automatischer E-Mail-Versand
(Bestätigung an Kunde + Benachrichtigung an Lukas).

## Was hier drin ist

- `src/server.js` – der eigentliche Server (Express). Zwei Endpunkte:
  `GET /api/products` (aktueller Bestand) und `POST /api/order` (Bestellung
  aufgeben).
- `src/store.js` – speichert Bestand & Bestellungen in `data/*.json`. Alle
  Zugriffe laufen nacheinander durch eine Warteschlange, damit zwei
  gleichzeitige Bestellungen sich nie in die Quere kommen.
- `src/email.js` – verschickt die zwei E-Mails über Resend.
- `src/seedProducts.js` – erzeugt einmalig `data/products.json` mit den
  Start-Bestandszahlen aus `js/shop.js`.

## Lokal testen

```bash
cd backend
npm install
npm run seed        # legt data/products.json einmalig an
npm start            # startet den Server auf http://localhost:4000
```

Dann in einem zweiten Terminal testen:

```bash
curl http://localhost:4000/api/products

curl -X POST http://localhost:4000/api/order \
  -H "Content-Type: application/json" \
  -d '{"customerName":"Test Kunde","customerEmail":"test@example.com","items":[{"id":"airpower-3","name":"Airpower 3","price":4.5,"qty":2}]}'
```

Ohne `.env`-Datei (bzw. ohne `RESEND_API_KEY`) werden die E-Mails nicht
wirklich verschickt, sondern nur in der Konsole ausgegeben – praktisch zum
Testen, ohne gleich einen Resend-Account zu brauchen.

## Was noch fehlt, bevor der Shop live gehen kann

1. **`.env` ausfüllen** (siehe `.env.example`): Resend-API-Key, Absenderadresse,
   Lukas' E-Mail-Adresse, Abholadresse/-zeiten, Kontaktinfo.
2. **Hosting**: der Server muss irgendwo dauerhaft laufen (z.B. Render oder
   Railway, ca. 0–10€/Monat für diese Größe). Wichtig: auf einem kostenlosen
   Hosting-Plan wird die Festplatte bei jedem Neu-Deploy oft zurückgesetzt –
   für echten Betrieb braucht `data/` entweder eine "Persistent Disk" oder es
   müsste später auf eine kleine Cloud-Datenbank umgezogen werden.
3. **Frontend verbinden**: `js/shop.js` muss die Server-Adresse kennen (siehe
   `API_BASE` ganz oben in der Datei) und ruft dann `/api/products` und
   `/api/order` auf, statt den Bestand nur im Browser vorzutäuschen. Ohne
   gesetzte `API_BASE` funktioniert die Website weiterhin wie bisher als reine
   Vorschau (kein Absturz, einfach kein echter Server dahinter).
4. **CORS einschränken**: aktuell erlaubt der Server Anfragen von jeder
   Website (praktisch zum Testen). Vor dem Live-Gang sollte das in
   `src/server.js` auf die echte Domain der Website eingeschränkt werden.

## Bewusste Vereinfachungen (für diese Shop-Größe okay)

- JSON-Dateien statt einer "richtigen" Datenbank – bei ein paar Dutzend
  Bestellungen pro Saison völlig ausreichend.
- Preis pro Artikel kommt von der Website, nicht aus einer serverseitigen
  Preisliste – unkritisch, weil hier nicht online bezahlt wird (nur Abholung).
  Falls das Projekt mal echtes Online-Bezahlen bekommt, muss der Preis
  stattdessen serverseitig aus `data/products.json` kommen.
