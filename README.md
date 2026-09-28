# Lindner Feuerwerk – Backend

Stand 28.09.2026. Dieser Ordner ist der aktuelle Quellstand. Ob genau derselbe Commit auf Railway läuft, muss nach jedem Deployment anhand von Deployment-ID, Commit und Liveprüfung belegt werden.

## Ablauf und Daten

- `src/server.js`: Node-HTTP-Server ohne Express. `GET /api/products` liefert den Bestand, `GET /api/shop-status` das Verkaufsfenster und `POST /api/order` legt eine Reservierung an.
- `src/catalog.js`: verbindliche Produktnamen und Preise. Vom Browser übermittelte Preise werden nicht vertraut.
- `src/store.js`: Produkte, Reservierungen, Zähler, Statistik und Digest-Zustand in `data/*.json` auf dem Railway-Volume.
- `src/email.js`: Kunden- und Betreiberbestätigung über Resend als HTML und Klartext. `src/invoice.js` erzeugt einen Abholschein, keine Rechnung.
- Kontakt- und Showformulare werden nicht im Store abgelegt; das Backend übermittelt sie an Resend.

## Konsistenz und Wiederanlauf

Eine Prozesswarteschlange und eine Dateisperre serialisieren Änderungen. Eine Reservierung wird als Transaktion über Produktbestand, Bestellliste und Nummernzähler geführt: Zuerst wird ein Journal mit dem vollständigen Zielzustand dauerhaft geschrieben, anschließend werden die drei Dateien atomar ersetzt. Bleibt das Journal nach einem Prozessabbruch liegen, stellt `store.initialize()` den Zielzustand beim nächsten Start fertig.

Dasselbe Journal schützt eine vollständige Reservierungsstornierung: Der Status `cancelled`, der dauerhafte `stockRelease`-Marker und die Addition der reservierten Mengen zum **aktuell gelesenen** Bestand werden gemeinsam geschrieben. Ein Wiederholungsaufruf gibt `addedTotal: 0` zurück und bucht nicht doppelt.

Wichtige Grenzen:

- Die Lösung ist für **einen aktiven Backend-Prozess auf einem einzelnen Railway-Volume** ausgelegt. Mehrere Replikate oder parallel startende Prozesse auf demselben Volume werden nicht unterstützt.
- Die Dateisperre wird zur Laufzeit nicht nach Zeitablauf übernommen. Nur der kontrollierte Start entfernt eine nach einem Absturz übrig gebliebene Sperre.
- Wiederholte Reservierungsanfragen mit demselben Vorgangsschlüssel sind idempotent; widersprüchliche Wiederholungen werden abgewiesen.

## E-Mail-Zustand

Kunden- und Betreiber-Mail erhalten stabile Resend-Idempotenzschlüssel. Der gespeicherte Zustand unterscheidet:

- `accepted`: Resend hat die Nachricht angenommen.
- `failed`: Resend hat die Nachricht ausdrücklich abgewiesen; ein späterer Versuch ist möglich.
- `unknown`: Timeout oder Verbindungsabbruch; die tatsächliche Annahme ist unbekannt. Eine Wiederholung verwendet denselben Idempotenzschlüssel.

`accepted` belegt keine Zustellung im Postfach. Ein Mailfehler rollt die bereits gespeicherte Reservierung nicht zurück. Die Website zeigt deshalb immer die Reservierungsnummer an und weist den Mailzustand gesondert aus.

Ein Retry einer inzwischen stornierten Reservierung wird mit `409 reservation_cancelled` abgewiesen und löst keinen erneuten Mailversand aus. Vor Kunden- und Betreiber-Mail wird der aktuelle Reservierungsstatus erneut gelesen. Eine bereits laufende Übergabe an Resend lässt sich technisch nicht zurückrufen; der gespeicherte Storno- und Bestandszustand bleibt dennoch maßgeblich.

## Private Abholdaten

Der genaue Abholort kommt ausschließlich aus `ABHOL_ADRESSE`, der private Google-Maps-Link aus `ABHOL_ANFAHRT_URL` und der Apple-Karten-Link zum selben Punkt aus `ABHOL_ANFAHRT_APPLE_URL`. Diese Werte gehören nur in die Backend-Umgebung. Ohne eigene Apple-URL fällt die Kundenmail auf eine Suche nach der Abholbeschreibung zurück. Die Website nennt nur „in der Nähe von Pregarten“ sowie die Abholzeiten.

Keine `.env`, Zugangsdaten, privaten Kartenlinks oder echten `data/*.json` in GitHub- oder Netlify-Pakete aufnehmen.

## Administration

Die neuen Admin-Endpunkte erwarten `Authorization: Bearer …`; der ältere Query-Key bleibt für die bestehenden Verwaltungsseiten vorläufig kompatibel.

- `GET /api/admin/backup`: vollständiger Sicherungssnapshot mit Hashes.
- `POST /api/admin/privacy-cleanup`: Vorschau standardmäßig; Ausführung nur mit der exakten Bestätigung `APPLY-PRIVACY-CLEANUP`.
- `POST /api/admin/order-status`: Statusverwaltung für weiterhin aktive Vorgänge; ein Storno ist hier gesperrt und kann eine stornierte Reservierung nicht reaktivieren.
- `POST /api/admin/cancel-reservation`: zunächst strikt lesende Vorschau per UUID oder Reservierungsnummer, danach bestätigte atomare Stornierung mit einmaliger Bestandsrückbuchung. Vollständiger Vertrag: [CANCELLATION-API.md](CANCELLATION-API.md).
- `GET /api/admin/adjust-stock`: unabhängige manuelle Bestandskorrektur; nicht für Reservierungsstornos verwenden.

Reservierungen ohne Kauf werden spätestens zwölf Monate nach Abholtermin oder Absage zur Löschung vorgeschlagen. Gekaufte Vorgänge bleiben bis zum 1. Jänner nach sieben vollständigen Kalenderjahren erhalten. Die Bereinigung läuft nicht automatisch im Server; sie muss regelmäßig erst als Dry-Run geprüft und anschließend bewusst ausgelöst werden.

## Sicherung und Wiederherstellung

Siehe `ops/README.md`.

Kurzfassung: `ops/backup-live.ps1` exportiert den Admin-Snapshot einschließlich einer erlaubten Liste der wirksamen Laufzeitkonfiguration, verschlüsselt ihn mit Windows-DPAPI außerhalb von Vault und Projekt und hält 35 Tage vor. Zugangsschlüssel bleiben absichtlich in einem getrennten Secret-Store. Solange der ältere Railway-Stand den Vollsicherungsendpunkt nicht anbietet, erzeugt das Skript nur eine ausdrücklich als **partial** markierte Diagnosesicherung und beendet sich mit Code 2. Eine Teilsicherung wird nie als erfolgreiche Vollsicherung gemeldet. Ein Restore bleibt bis zur Konfigurationsprüfung, Wiederherstellung der Secrets und Datenschutz-Dry-Run ausdrücklich noch nicht startbereit.

## Lokale Prüfung

- `node tests/review.cjs`: bestehende Funktionsprüfung.
- `node tests/resilience.cjs`: Absturz-Wiederanlauf, Konkurrenz, Idempotenz, Mailzustände, Adminzugriff und Datenschutz-Dry-Run.
- `node tests/cancel-reservation.cjs`: Stornovorschau, aktueller Bestand, Authentifizierung, exakte Bestätigung, Wiederholung, Parallelität, Alles-oder-nichts und Crash-Wiederanlauf.
- `powershell -File tests/restore-tests.ps1`: Wiederherstellung mit leeren, einzelnen und mehreren Datensätzen sowie Ablehnung unvollständiger Sicherungen.
- `node tests/privacy-cleanup-readonly.cjs`: belegt bytegenau, dass ein Dry-Run mit offenem Transaktionsjournal sowie ein unbestätigter Apply abbrechen, ohne das Journal anzuwenden oder Dateien zu verändern.

Alle Tests verwenden isolierte Verzeichnisse außerhalb des produktiven Datenordners und einen lokalen Resend-Ersatz. Sie versenden keine E-Mails und verändern keine echten Reservierungen oder Bestände.

## Vor dem Verkaufsstart offen

1. Aktuellen Backend-Ordner kontrolliert zu GitHub/Railway deployen und die neue Version anhand der Admin- und Backup-Endpunkte belegen.
2. Railway-Dienst auf genau eine aktive Replik begrenzen und das persistente Volume dem richtigen Mountpunkt zuordnen.
3. Resend-Absenderdomain sowie echte Zustellung an freigegebene Testpostfächer prüfen. Providerannahme allein genügt nicht.
4. Railway-DPA kontobezogen abschließen beziehungsweise vorhandenen Abschluss dokumentieren; auch Netlify- und Resend-Vertragsstand dokumentieren.
5. Nach dem Deployment eine vollständige verschlüsselte Sicherung erstellen und in einem isolierten Ziel wiederherstellen. Erst dann gilt der Backup-Pfad als vollständig betriebsbereit.
6. Datenschutzbereinigung zunächst als Dry-Run prüfen, Kaufstatus der Vorgänge pflegen und die Ausführung dokumentieren.
7. Einen vorhandenen Railway-Predeploy-Befehl mit altem Seedbestand entfernen oder so absichern, dass ein Deployment niemals den aktuellen Lagerstand überschreibt.
