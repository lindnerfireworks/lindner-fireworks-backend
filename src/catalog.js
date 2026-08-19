// Verbindlicher Produktkatalog des Backends.
//
// WICHTIG: Preise und Namen fuer Bestellungen kommen AUSSCHLIESSLICH aus dieser
// Datei – niemals aus den Daten, die der Browser mitschickt. Sonst koennte
// jeder ueber die Entwicklertools seinen eigenen Preis bestimmen.
//
// Der Lagerbestand steht weiterhin in data/products.json auf dem Volume, weil
// er sich staendig aendert. Preise aendern sich selten und gehoeren deshalb
// versioniert ins Repo.
//
// Bei Preisaenderungen: hier UND in js/shop.js anpassen, dann neu deployen.
// Stand: 2026-08-19

const CATALOG = [
  { id: "aidos", name: "Aidos", price: 4.20 },
  { id: "gigant-2", name: "Gigant 2", price: 4.70 },
  { id: "baron-brokat", name: "Baron Brokat", price: 12.00 },
  { id: "gold-blue-batch-2024", name: "Gold-Blue (Batch 2024)", price: 12.00 },
  { id: "armor", name: "Armor", price: 16.90 },
  { id: "plasma", name: "Plasma", price: 19.90 },
  { id: "opal", name: "Opal", price: 19.90 },
  { id: "v-wie-vokuhila", name: "V wie Vokuhila", price: 23.50 },
  { id: "signature-range-16sh", name: "Signature range 16sh", price: 23.50 },
  { id: "hacker-man", name: "Hacker Man", price: 28.50 },
  { id: "pete", name: "Pete", price: 33.50 },
  { id: "fiori", name: "Fiori", price: 34.90 },
  { id: "edaha", name: "Edaha", price: 34.90 },
  { id: "azzurro", name: "Azzurro", price: 34.90 },
  { id: "pretty-in-pink", name: "Pretty In Pink", price: 38.90 },
  { id: "leuchtnebel", name: "Leuchtnebel", price: 38.90 },
  { id: "baywatch", name: "Baywatch", price: 39.90 },
  { id: "thunderbolt-1", name: "Thunderbolt 1", price: 42.90 },
  { id: "valentin", name: "Valentin", price: 42.90 },
  { id: "sakkara", name: "Sakkara", price: 46.90 },
  { id: "dragon", name: "Dragon", price: 49.90 },
  { id: "monster", name: "Monster", price: 50.90 },
  { id: "wilk", name: "Wilk", price: 80.90 },
  { id: "pyroshow-1000-c-cimelia", name: "Pyroshow 1000-C Cimelia", price: 82.90 },
  { id: "okazja", name: "Okazja", price: 84.90 },
  { id: "felis-leo", name: "Felis Leo", price: 94.50 },
  { id: "panthera", name: "Panthera", price: 94.90 },
  { id: "nightshade", name: "Nightshade", price: 109.98 },
  { id: "startowac", name: "Startowac", price: 132.90 },
  { id: "sky-dance", name: "Sky Dance", price: 133.50 },
  { id: "krawallig", name: "Krawallig", price: 158.50 },
  { id: "platzhirsch-130-gold", name: "Platzhirsch 130 Gold", price: 159.00 },
  { id: "spirit-of-ecstasy", name: "Spirit of Ecstasy", price: 173.90 },
  { id: "4in1-showbox-nucleon", name: "4in1 Showbox Nucleon", price: 175.90 },
  { id: "cyttorak", name: "Cyttorak", price: 189.90 },
  { id: "vengeance", name: "Vengeance", price: 189.90 },
  { id: "mucho-power", name: "Mucho Power", price: 205.90 },
  { id: "dubai", name: "Dubai", price: 205.90 },
  { id: "tokyo", name: "Tokyo", price: 209.90 },
  { id: "megalomania", name: "Megalomania", price: 389.90 },
  { id: "space-color", name: "Space Color", price: 18.90 },
  { id: "fly-owl", name: "Fly Owl", price: 29.90 },
  { id: "happy-new-year-f2", name: "Happy New Year F2", price: 34.90 },
  { id: "sonnenvoegel-mittel", name: "Sonnenvögel mittel", price: 11.90 },
  { id: "bugano-vulkan-magic-light", name: "Bugano Vulkan Magic Light", price: 12.90 },
  { id: "6m-fountain", name: "6m Fountain", price: 19.90 },
  { id: "glamour-shots", name: "Glamour Shots", price: 9.50 },
  { id: "carcasa", name: "Carcasa", price: 10.50 },
  { id: "brocade-war-3-20mm", name: "Brocade war 3 - 20mm", price: 11.50 },
  { id: "kids-power-box", name: "Kids Power Box", price: 11.50 },
];

const BY_ID = new Map(CATALOG.map((p) => [p.id, p]));

/** Liefert den Katalogeintrag zu einer Produkt-ID, oder undefined. */
function getProduct(id) {
  return BY_ID.get(id);
}

module.exports = { CATALOG, getProduct };
