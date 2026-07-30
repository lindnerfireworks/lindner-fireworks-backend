// Einmalig ausführen (npm run seed), um data/products.json neu aus den
// Ausgangsdaten in js/shop.js zu erzeugen. ACHTUNG: überschreibt den
// aktuellen (ggf. schon durch echte Bestellungen veränderten) Lagerbestand!
// Nur zum ersten Einrichten oder für einen bewussten Reset verwenden.

const fs = require("fs");
const path = require("path");

// Gleiche Artikel-IDs und Start-Bestand wie in js/shop.js (Stand: Einkauf 2026).
// Preis/Name/Beschreibung/Bild bleiben bewusst im Frontend (shop.js) – der
// Server kennt nur das, was er wirklich braucht: ID und Bestand.
const SEED_PRODUCTS = [
  // Verbünde
  { id: "big-party-2", name: "Big Party 2", stock: 20 },
  { id: "golddrache-3", name: "Golddrache 3", stock: 4 },
  { id: "dragon-3", name: "Dragon 3", stock: 4 },
  { id: "austrian-fire-4", name: "Austrian Fire 4", stock: 3 },
  // Batterien
  { id: "angeber", name: "Angeber", stock: 60 },
  { id: "airpower-3", name: "Airpower 3", stock: 36 },
  { id: "airpower-5", name: "Airpower 5", stock: 36 },
  { id: "aufwind-2", name: "Aufwind 2", stock: 12 },
  { id: "dicke-dinger", name: "Dicke Dinger", stock: 8 },
  { id: "durchstarter-1", name: "Durchstarter 1", stock: 16 },
  { id: "goldstueck-1", name: "Goldstück 1", stock: 16 },
  { id: "goldstueck-2", name: "Goldstück 2", stock: 12 },
  { id: "ausraster", name: "Ausraster", stock: 8 },
  { id: "color-explosion", name: "Color Explosion", stock: 4 },
  { id: "alpha-01-golden-willow", name: "Alpha 01 Golden Willow", stock: 4 },
  { id: "vampir-4-gold", name: "Vampir 4 Gold", stock: 4 },
  // Raketen & Single Shots
  { id: "iridium", name: "Iridium", stock: 10 },
  { id: "styria-2", name: "Styria 2", stock: 36 },
  { id: "feuertraum", name: "Feuertraum", stock: 20 },
  { id: "zodiac-line", name: "Zodiac Line", stock: 20 },
  // Bodenfeuerwerk & Kindersortiment
  { id: "silbervulkan", name: "Silbervulkan", stock: 24 },
  { id: "fountain-a", name: "Fountain A", stock: 24 },
  { id: "mega-fun-pack", name: "Mega Fun Pack", stock: 8 },
  { id: "roemische-lichter", name: "Römische Lichter", stock: 36 },
  { id: "feuervoegel", name: "Feuervögel", stock: 60 },
];

const dataDir = path.join(__dirname, "..", "data");
const productsFile = path.join(dataDir, "products.json");

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

if (fs.existsSync(productsFile)) {
  console.log(
    "data/products.json existiert schon. Wenn du wirklich neu seeden willst " +
      "(z.B. für einen Test), lösche die Datei zuerst manuell und führe dann " +
      "'npm run seed' erneut aus."
  );
  process.exit(0);
}

fs.writeFileSync(productsFile, JSON.stringify(SEED_PRODUCTS, null, 2), "utf-8");
console.log(`data/products.json erstellt mit ${SEED_PRODUCTS.length} Artikeln.`);
