# Lindner Fireworks – Backend

Stand 26.09.2026. Dieser Ordner ist der lokale Quellstand. Was auf Railway läuft, muss nach jedem Upload gesondert geprüft werden.

## Ablauf und Daten

- `src/server.js`: Node-HTTP-Server ohne Express. Die Website liest über `GET /api/products` den verbindlichen Bestand und über `GET /api/shop-status` das Verkaufsfenster. Eine Reservierung geht an `POST /api/order`.
- `src/catalog.js`: verbindliche Produktnamen und Preise. Browserpreise werden beim Reservieren ignoriert.
- `src/store.js`: Produkte, Reservierungen und Zähler in `data/*.json` auf einem persistenten Railway-Volume. Eine Warteschlange serialisiert Änderungen in **einem** Serverprozess. Nicht mehrere Instanzen auf dasselbe Volume setzen.
- `src/email.js`: Kunden- und Betreiberbestätigung über Resend, jeweils als HTML und Klartext. `src/invoice.js` erstellt einen **Abholschein**, keine Rechnung.
- Der genaue Abholort kommt ausschließlich aus `ABHOL_ADRESSE` in Railway; der private HTTPS-Kartenlink aus `ABHOL_ANFAHRT_URL`. Beides wird nur in individuellen Kundenunterlagen und internen Abläufen verwendet. Die öffentliche Firmenanschrift im Impressum ist nicht automatisch der Abholort. Solange keine bestätigte Postadresse vorliegt, darf `ABHOL_ADRESSE` nur eine zutreffende Ortsbeschreibung enthalten; keine Adresse erfinden.
- `src/seedProducts.js` dient nur dem **Erstbestand**. Auf einem bestehenden Railway-Volume nie erneut seeden: Das würde Bestandsänderungen überschreiben.

## Lokale Prüfung

`tests/README.md` beschreibt den isolierten Test unter einem Verzeichnis **außerhalb** dieses Vaults. Der Test fängt Resend-Aufrufe ab, verwendet Testdaten und verändert keine echten Bestände oder Reservierungen.

Ohne konfigurierten Abholort, privaten Anfahrtslink, verifizierten Absender, Resend-Key und Betreiberadresse weist der aktuelle Code neue Reservierungen mit `service_not_ready` ab. Die Werte in `.env.example` sind Platzhalter, keine Zugangsdaten.

## Reservierungsbestätigung und Abholregel

Der Server berechnet einen vorgeschlagenen Abholtermin, speichert ihn einmalig mit der Reservierung und verwendet denselben Termin in Kundenmail, Betreibermail und Abholschein. Die Kundenmail nennt Abholort, Anfahrtslink, Zeitfenster, Reservierungsnummer, Artikel und den Abholschein. Die Artikel bleiben für den Termin zurückgelegt. Kann der Kunde nicht kommen, soll er sich melden; eine Freigabe wegen Nichterscheinens erfolgt erst nach vorheriger Verständigung per E-Mail. Es gibt **keine automatische Ablauffrist**.

Die API-Antwort `emails.*.ok` bedeutet nur, dass Resend die Nachricht angenommen hat; sie beweist keine Zustellung im Kundenpostfach. Die Betreiber-Mail nennt daher den tatsächlichen Übergabestatus der Kundenmail. Ein Mailfehler löscht die bereits gespeicherte Reservierung nicht. Bei fehlgeschlagener Kundenmail zeigt der Checkout einen Fehlerhinweis mit Reservierungsnummer; eine automatische Nachsendewarteschlange fehlt.

## Vor dem Verkaufsstart offen

1. Railway muss den **aktuellen** Backend-Quellstand erhalten; öffentliche Erreichbarkeit allein belegt nicht, dass lokale Idempotenz, private Routenkonfiguration und Mailstatus online sind. Version nach Deployment erneut vergleichen.
2. Eigene Versanddomain bei Resend verifizieren, `RESEND_FROM` darauf setzen und echte Zustellung an freigegebene Testpostfächer prüfen. Providerannahme ist kein Zustellnachweis.
3. `ABHOL_ADRESSE`, `ABHOL_ANFAHRT_URL`, Kontaktangaben, `OWNER_EMAIL`, `PUBLIC_BASE_URL`, CORS-Herkünfte und Abholzeiten auf Railway gegen den echten Betrieb prüfen. Private Abholdaten nie in öffentliche HTML-Dateien oder das GitHub-Repository schreiben.
4. Railway-Volume auf Persistenz, Backups und Wiederanlauf prüfen. Bestand und Reservierung sind mehrere Dateischreibvorgänge, keine gemeinsame Transaktion; Crash-Recovery fehlt.
5. Die in `datenschutz.html` genannte Löschfrist mit einem tatsächlichen manuellen oder automatisierten Prozess abgleichen. Der Code kennt derzeit keinen Kaufstatus und löscht keine Altreservierungen.
6. Den Railway-Predeploy-Befehl entfernen oder absichern: Er enthält einen vollständigen alten Lagerstand und darf bei einem künftigen Deployment nicht das Volume überschreiben.

Die lokale Website hat keinen Git-Ordner. `GITHUB-UPLOAD-backend` ist eine separate Upload-Kopie und kann älter als `backend/src` sein. Zugangsdaten, `.env` und `data/*.json` gehören weder ins GitHub- noch ins Netlify-Paket.
