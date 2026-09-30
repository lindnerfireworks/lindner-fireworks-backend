// Local-only regression: removing a product must not destroy stock/history.
// Set NODE_PATH to installed backend dependencies if they live outside this tree.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { CATALOG, getProduct } = require('../src/catalog');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lindner-retirement-test-'));
const backend = path.resolve(__dirname, '..');
const checks = [];
function check(label, fn) { fn(); checks.push(label); }
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const write = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let child;
(async () => {
  check('Nightshade absent from active catalog; 49 active products remain', () => {
    assert.equal(getProduct('nightshade'), undefined);
    assert.equal(CATALOG.length, 49);
  });
  const seedRoot = path.join(root, 'seed-backend');
  fs.mkdirSync(path.join(seedRoot, 'src'), { recursive: true });
  fs.copyFileSync(path.join(backend, 'src/seedProducts.js'), path.join(seedRoot, 'src/seedProducts.js'));
  const seedRun = () => spawnSync(process.execPath, [path.join(seedRoot, 'src/seedProducts.js')], { cwd: seedRoot });
  assert.equal(seedRun().status, 0);
  const seedFile = path.join(seedRoot, 'data/products.json');
  check('Fresh seed contains 49 products, no retired product', () => {
    const products = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
    assert.equal(products.length, 49);
    assert(!products.some(p => p.id === 'nightshade'));
  });
  fs.writeFileSync(seedFile, '[{"id":"nightshade","stock":7}]');
  assert.equal(seedRun().status, 0);
  check('Seed does not overwrite an existing store', () => assert.equal(fs.readFileSync(seedFile, 'utf8'), '[{"id":"nightshade","stock":7}]'));
  const products = CATALOG.map(p => ({ id: p.id, name: p.name, stock: 10 }));
  products.push({ id: 'nightshade', name: 'Nightshade', stock: 4 });
  const historical = {
    id: crypto.randomUUID(), reservationNumber: 'RES-2026-0099', status: 'reserved',
    createdAt: '2026-09-01T10:00:00.000Z', customerName: 'Isolated Example',
    customerEmail: 'nobody@example.invalid', abholtermin: 'Freitag, 06.11.2026, 13:00–16:00 Uhr',
    items: [{ id: 'nightshade', name: 'Nightshade', price: 109.98, qty: 2 }], total: 219.96,
  };
  write('products.json', products); write('orders.json', [historical]);
  write('invoiceCounter.json', {}); write('stats.json', {}); write('digest-state.json', {});
  fs.writeFileSync(path.join(root, 'mail.jsonl'), '');
  let logs = '';
  const port = 49000 + Math.floor(Math.random() * 1000);
  child = spawn(process.execPath, ['--require', path.join(__dirname, 'mock-resend.cjs'), path.join(backend, 'src/server.js')], {
    cwd: root, env: { ...process.env, PORT: String(port), DATA_DIR: root, DIGEST_ENABLED: 'false',
      ORDERS_OPEN_FROM: '', ORDERS_OPEN_UNTIL: '', ADMIN_KEY: 'isolated-retirement-key',
      ABHOL_ADRESSE: 'Isolierter Testpunkt', ABHOL_ANFAHRT_URL: 'https://maps.app.goo.gl/isolated-test',
      RESEND_API_KEY: 'isolated-fake-key', RESEND_FROM: 'Test <test@example.invalid>',
      OWNER_EMAIL: 'owner@example.invalid', MAIL_LOG: path.join(root, 'mail.jsonl') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => { logs += d; }); child.stderr.on('data', d => { logs += d; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 600; i++) {
    try { if ((await fetch(base + '/api/health')).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await delay(100);
  }
  assert(ready, logs);
  const post = async (route, body) => {
    const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer isolated-retirement-key' }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const list = await (await fetch(base + '/api/products')).json();
  check('Public API hides retired volume record; all other fields unchanged', () => assert.deepEqual(list, products.filter(p => p.id !== 'nightshade')));
  const before = ['products.json', 'orders.json', 'invoiceCounter.json'].map(read);
  const request = items => ({ requestId: crypto.randomUUID(), customerName: 'Isolated Example', customerEmail: 'nobody@example.invalid', ageConfirmed: true, items });
  for (const items of [[{ id: 'nightshade', qty: 1 }], [{ id: 'aidos', qty: 1 }, { id: 'nightshade', qty: 1 }]]) {
    const result = await post('/api/order', request(items));
    check(`Retired product rejected with ${items.length} cart item(s), no writes or mail`, () => {
      assert.equal(result.status, 400); assert.equal(result.data.error, 'unknown_product'); assert.equal(result.data.productId, 'nightshade');
      assert.deepEqual(['products.json', 'orders.json', 'invoiceCounter.json'].map(read), before);
      assert.equal(read('mail.jsonl'), '');
    });
  }
  const pdf = await fetch(base + '/api/abholschein/' + historical.id);
  const pdfBytes = Buffer.from(await pdf.arrayBuffer());
  check('Historical reservation PDF remains accessible', () => { assert.equal(pdf.status, 200); assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-'); });
  const preview = await post('/api/admin/cancel-reservation', { id: historical.id });
  check('Historical cancellation preview remains read-only', () => { assert.equal(preview.status, 200); assert.equal(preview.data.items[0].afterStock, 6); assert.deepEqual(['products.json', 'orders.json', 'invoiceCounter.json'].map(read), before); });
  const cancel = await post('/api/admin/cancel-reservation', { id: historical.id, apply: true, confirm: preview.data.requiredConfirmation });
  const retry = await post('/api/admin/cancel-reservation', { id: historical.id, apply: true, confirm: preview.data.requiredConfirmation });
  check('Historical cancellation restores stock once without reactivating product', () => {
    assert.equal(cancel.status, 200); assert.equal(cancel.data.addedTotal, 2);
    assert.equal(retry.data.addedTotal, 0);
    assert.equal(JSON.parse(read('products.json')).find(p => p.id === 'nightshade').stock, 6);
    assert.equal(read('mail.jsonl'), '');
  });
  check('Cancelled retired product stays absent from API', () => assert.equal(getProduct('nightshade'), undefined));
  assert(!(await (await fetch(base + '/api/products')).json()).some(p => p.id === 'nightshade'));
  const valid = await post('/api/order', request([{ id: 'aidos', qty: 1 }]));
  check('Active product can still be reserved; two mails captured locally', () => {
    assert.equal(valid.status, 200);
    assert.equal(JSON.parse(read('products.json')).find(p => p.id === 'aidos').stock, 9);
    assert.equal(read('mail.jsonl').trim().split('\n').length, 2);
  });
  console.log(JSON.stringify({ passed: checks.length, checks, isolatedRoot: root }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
});
