# Sicherheitsupdate vom 22.10.2026

Vorbereitet, nicht veröffentlicht. Ausgangspunkt: GitHub-Commit `b0b4cf4baa69dca99868b43467fd4641d58f85df`.

## Vor Veröffentlichung

- Verifizierte Vollsicherung des aktuellen Volumes erstellen; keine Bestandsdaten aus der Arbeitskopie hochladen.
- `PUBLIC_BASE_URL` muss die tatsächliche HTTPS-Backend-Adresse sein. Für diesen Dienst wurde `https://backend-production-5c8fc.up.railway.app` durch den Hauptagenten bestätigt.
- `ADMIN_KEY` durch einen zufälligen neuen Schlüssel mit mindestens 32 Zufallsbytes ersetzen. Den lokalen DPAPI-Schlüsselspeicher für die Sicherung gleichzeitig aktualisieren. Alte Schlüssel nicht als Fallback akzeptieren.
- Resend-Schlüssel mit ausschließlich Versandberechtigung für die vorhandene Domain ersetzen. Alte kompromittierungsverdächtige Schlüssel beim Anbieter widerrufen, sobald der neue Key aktiv geprüft ist. Keine echte Kundenmail als Test versenden.
- GitHub-Verbindung und Railway-Deploymentfähigkeit nach dem Anbieter-Vorfall prüfen. Ein GitHub-Push allein beweist keine erfolgreiche Veröffentlichung.
- Node.js24.22.1 ist in `package.json` und `.node-version` festgelegt. Die Lockdatei legt die Abhängigkeiten fest; `npm ci --ignore-scripts` verwenden.

## Geänderte Bedienung

- Verwaltung: `/api/admin/orders` öffnen und Schlüssel im Anmeldeformular eingeben. Die Sitzung läuft acht Stunden; ein Serverneustart beendet bestehende Sitzungen. Der Schlüssel wird nicht mehr in URLs, Statistiklinks oder Tagesmails übertragen.
- Bestehende `?key=`-Links melden nicht mehr an. Das neue Lesezeichen ohne Schlüssel speichern.
- Der Abholschein in der Betreiber-Mail benötigt eine angemeldete Browsersitzung oder einen Bearer-Header. Ohne Sitzung führt der Link zur Anmeldung und anschließend unmittelbar zum Abholschein zurück; Rücksprünge sind auf ausdrücklich erlaubte lokale Pfade begrenzt. Kunden erhalten weiterhin unverändert den PDF-Anhang.
- Automationen verwenden weiterhin `Authorization: Bearer …`. Manuelle Bestandskorrektur jetzt ausschließlich `POST /api/admin/adjust-stock` mit `Content-Type: application/json` und `{ "id": "artikel-id", "delta": 1 }`. GET verändert keinen Bestand mehr.
- `ops/backup-live.ps1` ist ein lokaler Begleiter, bisher nicht im öffentlichen Repository. Auch sein Teilsicherungs-Fallback wurde auf Bearer-Authentifizierung umgestellt; diese Datei separat lokal aktualisieren.

## Prüfung und Grenzen

119 synthetische Prüfungen bestanden:32 Sicherheit/Anmeldung,47 Packstatus,17 Storno,20 Abholkalender und3 Tagesübersicht. Alle auf Node.js24.22.1, keine echten Reservierungen oder E-Mails. npm meldete0 bekannte Sicherheitslücken für80 geprüfte Pakete; das ersetzt keine Garantie gegen unbekannte Schwachstellen. Die ältere PDFKit-Abhängigkeitskette enthält nicht mehr gepflegte Pakete; ein getrennt getestetes Upgrade bleibt sinnvoll.

Die vorhandene IP-basierte Begrenzung setzt weiterhin voraus, dass Railway den Forwarded-For-Header zuverlässig bereinigt. Ein widersprüchlicher Supportverlauf ist keine belastbare Garantie; die Proxy-Vertrauensgrenze wurde hier nicht ohne Nachweis umgestellt. Keine Browser-E2E-Prüfung des neuen Anmeldeformulars und keine Prüfung des tatsächlich neu ausgelieferten Node-Runtimes vor Veröffentlichung behauptet.
