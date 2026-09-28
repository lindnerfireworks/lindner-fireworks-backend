# Reservierungen sicher stornieren

Stand 28.09.2026. Dieser Vertrag beschreibt den lokalen Backendstand. Er gilt für das Railway-Backend erst nach einem kontrollierten Deployment dieses Stands.

## Endpunkt und Authentifizierung

`POST /api/admin/cancel-reservation`

Header:

```http
Authorization: Bearer <ADMIN_KEY>
Content-Type: application/json
```

Der Schlüssel gehört nur in den vorhandenen Secret-Store beziehungsweise die Railway-Umgebung. Er darf weder in einen Skillaufruf noch in ein Protokoll, GitHub-Paket oder eine Obsidian-Notiz kopiert werden.

Genau eine Referenz ist erlaubt:

- `id`: interne UUID der Reservierung, zum Beispiel aus einem maschinenlesbaren Abholschein;
- `reservationNumber`: sichtbare Reservierungsnummer im Format `RES-JJJJ-NNNN`.

Die Reservierungsnummer wird ohne Beachtung der Groß-/Kleinschreibung gesucht. Kein Treffer ergibt `404`; mehrere Treffer ergeben einen Konflikt. Das Backend storniert nie anhand von Kundennamen oder E-Mail-Adressen.

## Sicherer Ablauf

### 1. Vorschau

Ohne `apply` bleibt der Aufruf lesend:

```json
{
  "reservationNumber": "RES-2026-0001"
}
```

Die Antwort enthält Reservierungs-ID und -nummer, den Status, die zurückzubuchenden Positionen, den aktuellen und den daraus berechneten Bestand sowie `requiredConfirmation`:

```json
{
  "ok": true,
  "mode": "preview",
  "alreadyCancelled": false,
  "addedTotal": 0,
  "requiredConfirmation": "CANCEL RES-2026-0001",
  "order": {
    "id": "00000000-0000-4000-8000-000000000000",
    "reservationNumber": "RES-2026-0001",
    "status": "reserved",
    "cancelledAt": null
  },
  "items": [
    { "id": "aidos", "qty": 3, "beforeStock": 8, "afterStock": 11 }
  ],
  "stockRelease": null
}
```

Bei einer offenen Speichertransaktion antwortet die Vorschau mit `409 pending_transaction`; sie spielt das Journal nicht ein und ändert keine Datendatei.

### 2. Ausführung

Für die Ausführung müssen dieselbe Referenz, `apply: true` und der unverändert aus der Vorschau übernommene Bestätigungstext gesendet werden:

```json
{
  "reservationNumber": "RES-2026-0001",
  "apply": true,
  "confirm": "CANCEL RES-2026-0001"
}
```

Das Backend liest den Bestand nach Erwerb der exklusiven Sperre erneut. Änderungen zwischen Vorschau und Ausführung werden damit berücksichtigt. Beispiel: Vorschau bei 8, danach eine andere Reservierung mit 2 Stück, dann Storno von 3 Stück ergibt `6 + 3 = 9`.

Statusänderung und Rückbuchung laufen in einer gemeinsamen wiederanlaufbaren Journaltransaktion. Der Vorgang speichert folgenden Marker bei der Reservierung und gibt ihn ohne Kundendaten zurück:

```json
{
  "reason": "reservation_cancelled",
  "transactionId": "00000000-0000-4000-8000-000000000000",
  "releasedAt": "2026-09-28T12:00:00.000Z",
  "items": [{ "id": "aidos", "qty": 3 }],
  "totalQuantity": 3
}
```

Ein identischer Wiederholungsaufruf nach Timeout oder Neustart antwortet erfolgreich mit `alreadyCancelled: true`, `addedTotal: 0` und demselben `stockRelease`-Marker. Auch zwei parallele Aufrufe können den Bestand nur einmal erhöhen.

## Zulässige Reservierungen

Automatisch stornierbar ist nur eine vollständig offene Reservierung mit Status `reserved` (bei Altbestand auch ein fehlendes Statusfeld), gültigen positiven Ganzzahlmengen und eindeutig vorhandenen Produkt-IDs. Gekaufte oder teilweise erfüllte Vorgänge werden abgewiesen.

Alte Datensätze mit Status `cancelled`, aber ohne `stockRelease`-Marker, werden absichtlich nicht automatisch zurückgebucht. Bei ihnen ist nicht beweisbar, ob der Bestand früher schon manuell korrigiert wurde.

Der allgemeine Endpunkt `/api/admin/order-status` darf keinen Stornostatus mehr setzen und kann stornierte Reservierungen nicht reaktivieren. `/api/admin/adjust-stock` bleibt für unabhängige manuelle Bestandskorrekturen; er darf nicht als Teil dieses Stornoablaufs verwendet werden.

## Antworten und Fehler

| HTTP | `error` | Bedeutung / sichere Reaktion |
|---:|---|---|
| 200 | – | Vorschau, erfolgreiche Stornierung oder idempotente Wiederholung; `alreadyCancelled` und `addedTotal` prüfen. |
| 400 | `exactly_one_reference_required` | Genau `id` oder `reservationNumber` senden. |
| 400 | `invalid_order_id`, `invalid_reservation_number`, `invalid_apply` | Anfrage lokal korrigieren; nichts wurde gebucht. |
| 400 | `confirmation_required` | Neue Vorschau lesen und deren `requiredConfirmation` exakt übernehmen. |
| 401 | `unauthorized` | Admin-Schlüssel fehlt oder ist falsch; keine automatische Wiederholung mit erratenen Werten. |
| 404 | `order_not_found` | Keine passende Reservierung. Referenz mit Lukas klären. |
| 409 | `ambiguous_reservation_reference` | Mehrere Treffer; nicht automatisch fortfahren. |
| 409 | `pending_transaction` | Nur Vorschau: laufende/liegengebliebene Transaktion zuerst betrieblich klären. |
| 409 | `purchased_reservation`, `partially_fulfilled_reservation` | Kein automatisches Storno und keine Bestandsrückbuchung. |
| 409 | `legacy_cancelled_without_stock_release` | Historisches Storno ohne Nachweis; manuell prüfen. |
| 409 | `invalid_stock_release_marker`, `stock_release_state_conflict`, `invalid_reservation_status` | Inkonsistenter Zustand; stoppen und Datensatz prüfen. |
| 409 | `invalid_order_items`, `duplicate_order_item`, `missing_product`, `ambiguous_product`, `invalid_product_stock` | Artikel-/Bestandsdaten sind nicht sicher buchbar; keine Teiländerung. |
| 503 | `admin_disabled` | `ADMIN_KEY` fehlt in der Backend-Umgebung. |
| 500 | `internal_error` | Ergebnis zunächst als unbekannt behandeln und denselben Stornoaufruf wiederholen; der Marker verhindert doppelte Rückbuchung. |

Der Endpunkt versendet keine E-Mail. Er löscht weder Reservierungs- noch Kundendaten und löst keine weitere Bestandskorrektur aus.

Ein späterer Retry des ursprünglichen `POST /api/order` erkennt den gespeicherten Stornostatus, antwortet mit `409 reservation_cancelled` und versendet keine neue Reservierungsbestätigung. Unmittelbar vor Kunden- und Betreiber-Mail liest das Backend den Reservierungsstatus erneut; ist der Vorgang inzwischen storniert, wird der noch nicht begonnene Versand unterdrückt. Eine Anfrage, die bereits an den E-Mail-Anbieter übergeben wird, kann technisch nicht zurückgerufen werden. Der dauerhafte Reservierungs- und Rückbuchungszustand bleibt davon unberührt.

## Lokale Prüfung

```powershell
node tests/cancel-reservation.cjs
```

Die Tests verwenden ausschließlich temporäre Datendateien, einen lokalen Mail-Ersatz und lokale HTTP-Aufrufe. Sie greifen weder auf Railway noch auf echte Reservierungen oder den produktiven Resend-Versand zu.
