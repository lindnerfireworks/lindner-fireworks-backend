# Vorbestellungen und Abholung 2026

Stand 13.10.2026. Online wird unverbindlich reserviert; Kaufabschluss und Zahlung erfolgen vor Ort.

- `ORDERS_OPEN_FROM=` (bewusst leer) erlaubt Reservierungen sofort; diese Einstellung ist unabhängig vom Abholkalender. `ORDERS_OPEN_UNTIL=2027-01-01` bleibt erhalten.
- Erste mögliche Abholung: Freitag 06.11.2026 13–16 Uhr oder Samstag 07.11.2026 09–12 Uhr.
- Für reguläre Freitag-/Samstagstermine zählt der Eingang am Server in Europe/Vienna: bis Mittwoch Tagesende dasselbe Wochenende; ab Donnerstag das Wochenende der Folgewoche. Spätere Termine sind wählbar.
- Sondertermine 27.–31.12. täglich 08–12 Uhr verwenden weiterhin `ORDER_LEAD_DAYS` (Standard zwei Kalendertage). 24.–26.12. geschlossen; letzte Abholung 31.12. Keine reservierbare Abholung nach Saisonende.
- `GET /api/pickup-options` liefert die maßgebliche Terminliste samt Serverzeit. `POST /api/order` prüft `pickupDate` erneut. Clientzeit ist ohne Bedeutung. Alte Clients ohne Termin erhalten den ersten gültigen Termin.
- Bestehende Reservierungen behalten `abholtermin` und `pickupDate`. Erneute E-Mails/PDFs berechnen den Termin nicht neu. Wiederholungen verwenden dieselbe Request-ID und denselben Payload.
- Shaolin 6 kostet 109,90 €. Beim Start wird unter dem bestehenden Speicherlock ausschließlich eine fehlende `shaolin-6`-Zeile mit 3 Stück ergänzt. Vorhandene Stückzahlen werden nicht überschrieben. Alle anderen Produktzeilen und Reservierungen bleiben erhalten. `npm run seed` ist KEIN Deploymentbefehl.

## Prüfung

`node tests/preorder-calendar.cjs`: getrennte temporäre Testdaten, kontrollierte Zeit, abgefangener Mailversand. Kein echter Versand. Zusätzlich bestehen unabhängige HTTP-/Parallelitätsprüfungen im lokalen Auditordner. Produktionsstart bleibt `npm start`, eine Instanz mit persistentem `/app/data`.

## Rückweg

Bei Problemen zunächst neue Annahmen gezielt sperren (`ORDERS_OPEN_FROM=2026-11-01`, soweit dieses Datum noch in der Zukunft liegt) und einen geprüften Korrektur-/Revertcommit neu deployen. Frontend kann als neue Veröffentlichung aus dem gesicherten vorherigen Paket wiederhergestellt werden. Geschäftsdaten nicht pauschal aus einer alten Sicherung ersetzen: seit Freigabe könnten neue echte Reservierungen eingegangen sein. Vor jeder Reparatur aktuelle Vollsicherung erstellen und Vorgänge einzeln abgleichen. Der hinzugefügte Lagerdatensatz darf erhalten bleiben; früherer Katalog blendet ihn aus.
