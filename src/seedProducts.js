// Einmalig ausführen (npm run seed), um data/products.json neu aus den
// Ausgangsdaten in js/shop.js zu erzeugen. ACHTUNG: überschreibt den
// aktuellen (ggf. schon durch echte Bestellungen veränderten) Lagerbestand!
// Nur zum ersten Einrichten oder für einen bewussten Reset verwenden.

const fs = require("fs");
const path = require("path");

// Gleiche Artikel-IDs und Start-Bestand wie in js/shop.js (Stand: Excel-Import
// 2026-08-11, Warenkorb_feuerwerkshop-leicht). Preis/Name/Beschreibung/Bild
// bleiben bewusst im Frontend (shop.js) – der Server kennt nur das, was er
// wirklich braucht: ID und Bestand.
const SEED_PRODUCTS = [
  // Batteriefeuerwerk
  { id: "aidos", name: "Aidos", stock: 36 },
  { id: "gigant-2", name: "Gigant 2", stock: 36 },
  { id: "baron-brokat", name: "Baron Brokat", stock: 24 },
  { id: "gold-blue-batch-2024", name: "Gold-Blue (Batch 2024)", stock: 24 },
  { id: "plasma", name: "Plasma", stock: 8 },
  { id: "opal", name: "Opal", stock: 8 },
  { id: "v-wie-vokuhila", name: "V wie Vokuhila", stock: 16 },
  { id: "signature-range-16sh", name: "Signature range 16sh", stock: 10 },
  { id: "hacker-man", name: "Hacker Man", stock: 12 },
  { id: "pete", name: "Pete", stock: 12 },
  { id: "fiori", name: "Fiori", stock: 6 },
  { id: "edaha", name: "Edaha", stock: 6 },
  { id: "azzurro", name: "Azzurro", stock: 6 },
  { id: "pretty-in-pink", name: "Pretty In Pink", stock: 8 },
  { id: "leuchtnebel", name: "Leuchtnebel", stock: 4 },
  { id: "baywatch", name: "Baywatch", stock: 8 },
  { id: "thunderbolt-1", name: "Thunderbolt 1", stock: 4 },
  { id: "valentin", name: "Valentin", stock: 8 },
  { id: "sakkara", name: "Sakkara", stock: 6 },
  { id: "dragon", name: "Dragon", stock: 4 },
  { id: "monster", name: "Monster", stock: 4 },
  // Verbundfeuerwerk
  { id: "wilk", name: "Wilk", stock: 3 },
  { id: "pyroshow-1000-c-cimelia", name: "Pyroshow 1000-C Cimelia", stock: 2 },
  { id: "okazja", name: "Okazja", stock: 6 },
  { id: "felis-leo", name: "Felis Leo", stock: 2 },
  { id: "panthera", name: "Panthera", stock: 2 },
  { id: "nightshade", name: "Nightshade", stock: 4 },
  { id: "startowac", name: "Startowac", stock: 2 },
  { id: "sky-dance", name: "Sky Dance", stock: 2 },
  { id: "krawallig", name: "Krawallig", stock: 3 },
  { id: "spirit-of-ecstasy", name: "Spirit of Ecstasy", stock: 4 },
  { id: "cyttorak", name: "Cyttorak", stock: 2 },
  { id: "mucho-power", name: "Mucho Power", stock: 2 },
  { id: "dubai", name: "Dubai", stock: 2 },
  { id: "tokyo", name: "Tokyo", stock: 1 },
  { id: "megalomania", name: "Megalomania", stock: 1 },
  // Raketen
  { id: "space-color", name: "Space Color", stock: 24 },
  { id: "fly-owl", name: "Fly Owl", stock: 10 },
  { id: "happy-new-year-f2", name: "Happy New Year F2", stock: 12 },
  // Boden & Leuchtfeuerwerk
  { id: "sonnenvoegel-mittel", name: "Sonnenvögel mittel", stock: 36 },
  { id: "bugano-vulkan-magic-light", name: "Bugano Vulkan Magic Light", stock: 30 },
  { id: "6m-fountain", name: "6m Fountain", stock: 15 },
  // Single Shots & Bombenrohre
  { id: "glamour-shots", name: "Glamour Shots", stock: 24 },
  { id: "carcasa", name: "Carcasa", stock: 16 },
  { id: "brocade-war-3-20mm", name: "Brocade war 3 - 20mm", stock: 20 },
  // Jugendfeuerwerk
  { id: "kids-power-box", name: "Kids Power Box", stock: 20 },
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
