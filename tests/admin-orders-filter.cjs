"use strict";

// Synthetic UI-only checks; no credentials, persistent stores or live requests.
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { renderOrdersPage } = require("../src/admin-orders-page");
const checks = [];
const check = (name, fn) => { fn(); checks.push(name); };
const order = (id, total, extra = {}) => ({ id, total, status: "reserved", customerName: "Synthetic " + id,
  customerEmail: "fixture@example.invalid", items: [{ name: "Synthetic item", qty: 1 }], ...extra });
const groups = [
  { label: "Mixed day", orders: [order("open", 100), order("cancelled", 200, { status: "cancelled" })] },
  { label: "Cancelled-only day", orders: [order("legacy", 300, { cancelledAt: "2026-11-14T10:00:00Z" })] },
  { label: "Collected day", orders: [order("purchased", 400, { status: "purchased" })] },
];
const before = JSON.stringify(groups);
const html = renderOrdersPage(groups, { total: 4, umsatz: 1000, filterTag: "2026-11-14" });
const attrs = text => Object.fromEntries([...text.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
const dataset = tag => Object.fromEntries(Object.entries(attrs(tag)).filter(([key]) => key.startsWith("data-"))
  .map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
function client(rendered) {
  const allRows = [];
  const days = [...rendered.matchAll(/<section class="day"([^>]*)>([\s\S]*?)<\/section>/g)].map(match => {
    const rows = [...match[2].matchAll(/<article class="order [^"]*"([^>]*)>([\s\S]*?)<\/article>/g)].map(item => {
      const inputTag = item[2].match(/<input[^>]*class="packed-input"[^>]*>/)[0];
      const input = { dataset: dataset(inputTag), disabled: true, addEventListener() {} };
      const elements = { ".packed-input": input, details: {}, ".packing-feedback": { dataset: {} }, ".packed-at": {}, ".packing-updated-at": {} };
      const row = { dataset: dataset(item[1]), hidden: /\shidden(?:\s|$)/.test(item[1]), querySelector: selector => elements[selector] };
      allRows.push(row);
      return row;
    });
    const meta = { textContent: match[2].match(/<p class="daymeta">([^<]*)<\/p>/)[1] };
    return { dataset: dataset(match[1]), hidden: /\shidden(?:\s|$)/.test(match[1]), querySelectorAll: () => rows,
      querySelector: () => meta, rows, meta };
  });
  const toggle = rendered.includes('id="show-cancelled"')
    ? { checked: true, disabled: true, addEventListener(event, fn) { this.change = fn; } } : null;
  const summary = { textContent: rendered.match(/<span id="orders-summary"[^>]*>([^<]*)<\/span>/)[1] };
  const emptyTag = rendered.match(/<div class="empty" id="orders-empty"([^>]*)>([^<]*)<\/div>/);
  const empty = { hidden: /\shidden(?:\s|$)/.test(emptyTag[1]), textContent: emptyTag[2] };
  const document = {
    querySelector: selector => ({ "#show-cancelled": toggle, "#orders-summary": summary, "#orders-empty": empty })[selector],
    querySelectorAll: selector => selector === ".day" ? days : allRows,
  };
  const script = rendered.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, { document, AbortController, setTimeout, clearTimeout,
    fetch() { throw new Error("Filtering must not make any network request"); } });
  return { days, allRows, toggle, summary, empty, setFilter(value) { toggle.checked = value; toggle.change(); } };
}

check("Initial HTML hides cancelled orders and their otherwise empty day before JavaScript runs", () => {
  assert.match(html, /data-cancelled="true" hidden/);
  assert.match(html, /data-all-count="1" data-all-sum="300" data-active-count="0" data-active-sum="0" hidden/);
  assert.match(html, /2 Reservierungen · 500,00 € gesamt/);
  assert.match(html, /Stornierte anzeigen \(2\)/);
});
const ui = client(html);
check("Initial client state keeps only non-cancelled orders, including purchased orders", () => {
  assert.equal(ui.toggle.checked, false);
  assert.equal(ui.toggle.disabled, false);
  assert.deepEqual(ui.allRows.map(row => row.hidden), [false, true, true, false]);
  assert.deepEqual(ui.days.map(day => day.hidden), [false, true, false]);
  assert.equal(ui.summary.textContent, "2 Reservierungen · 500,00 € gesamt");
  assert.equal(ui.days[0].meta.textContent, "1 Reservierung · 100,00 €");
});
check("Showing cancelled orders restores rows, days, counts and sums without network writes", () => {
  ui.setFilter(true);
  assert(ui.allRows.every(row => !row.hidden));
  assert(ui.days.every(day => !day.hidden));
  assert.equal(ui.summary.textContent, "4 Reservierungen · 1000,00 € gesamt");
  assert.equal(ui.days[0].meta.textContent, "2 Reservierungen · 300,00 €");
  assert.equal(ui.empty.hidden, true);
});
check("Hiding them again restores compact counts and cancelled packing controls stay locked", () => {
  ui.setFilter(false);
  assert.deepEqual(ui.allRows.map(row => row.hidden), [false, true, true, false]);
  assert.equal(ui.summary.textContent, "2 Reservierungen · 500,00 € gesamt");
  assert(ui.allRows.slice(1).every(row => row.querySelector(".packed-input").disabled));
  assert.equal(ui.allRows[0].querySelector(".packed-input").disabled, false);
});
check("Only cancelled orders produce an informative empty state and can still be shown", () => {
  const only = client(renderOrdersPage([groups[1]], { total: 1, umsatz: 300 }));
  assert.equal(only.empty.hidden, false);
  assert.equal(only.empty.textContent, "Keine nicht stornierten Reservierungen vorhanden.");
  assert.equal(only.summary.textContent, "0 Reservierungen · 0,00 € gesamt");
  only.setFilter(true);
  assert.equal(only.empty.hidden, true);
  assert.equal(only.summary.textContent, "1 Reservierung · 300,00 € gesamt");
});
check("An empty list and a list without cancellations do not render an unnecessary toggle", () => {
  const empty = client(renderOrdersPage([], { total: 0, umsatz: 0 }));
  assert.equal(empty.toggle, null);
  assert.equal(empty.empty.hidden, false);
  assert.equal(empty.empty.textContent, "Noch keine Reservierungen.");
  const active = client(renderOrdersPage([groups[2]], { total: 1, umsatz: 400 }));
  assert.equal(active.toggle, null);
  assert.equal(active.empty.hidden, true);
});
check("Customer data stays escaped; filtering does not mutate the source groups", () => {
  const hostile = renderOrdersPage([{ label: '<script>bad()</script>', orders: [order('x', 1, { customerName: '<img src=x onerror=bad()>' })] }], { total: 1, umsatz: 1, filterTag: '<iframe src=x>' });
  assert(!hostile.includes('<img src=x'));
  assert(!hostile.includes('<iframe src=x>'));
  assert(hostile.includes('&lt;script&gt;bad()&lt;/script&gt;'));
  assert.equal(JSON.stringify(groups), before);
});
console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
