import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Stripe from 'stripe';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { PRODUCTS } from '../server/catalog.js';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SECRET = 'whsec_test_secret';
const quiet = { warn() {}, error() {}, log() {} };
const realStripe = new Stripe('sk_test_dummy');

function harness({ purchasesEnabled = true, linkHours = 72, priceAmount } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fs-'));
  for (const p of Object.values(PRODUCTS)) writeFileSync(join(dir, p.file), `ZIP:${p.file}`);
  const pub = mkdtempSync(join(tmpdir(), 'fs-pub-'));
  writeFileSync(join(pub, 'index.html'), 'ok');
  const sent = [];
  const created = [];
  const stripe = {
    webhooks: realStripe.webhooks,
    prices: { retrieve: async (id) => ({ unit_amount: priceAmount ?? Object.values(PRODUCTS).find((p) => `price_${p.priceEnv}` === id).amount, currency: 'usd', type: 'one_time', active: true }) },
    checkout: { sessions: { create: async (args) => { created.push(args); return { id: `cs_test_${created.length}xxxxxxxxxx`, url: 'https://checkout.stripe.test/x' }; } } },
  };
  const flags = { failMail: false };
  const mailer = { configured: true, send: async (m) => { if (flags.failMail) throw new Error('smtp down'); sent.push(m); } };
  const config = {
    publicDir: pub, siteUrl: 'https://site.test', downloadDir: dir, purchasesEnabled, webhookSecret: SECRET,
    supportEmail: 's@test', linkHours,
    prices: Object.fromEntries(Object.entries(PRODUCTS).map(([s, p]) => [s, `price_${p.priceEnv}`])),
  };
  const db = openDb(':memory:');
  const app = createApp({ stripe, db, mailer, config, log: quiet });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ base: `http://127.0.0.1:${server.address().port}`, server, db, sent, created, flags, close: () => { server.close(); server.closeAllConnections(); } }));
  });
}

const post = (h, path, body) => fetch(h.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function checkout(h, slug) {
  const res = await post(h, '/api/checkout', { slug });
  assert.equal(res.status, 200);
  return `cs_test_${h.created.length}xxxxxxxxxx`;
}

function webhook(h, type, session, { secret = SECRET, id = `evt_${Math.random()}` } = {}) {
  const payload = JSON.stringify({ id, object: 'event', type, data: { object: session } });
  const header = realStripe.webhooks.generateTestHeaderString({ payload, secret });
  return fetch(h.base + '/api/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': header }, body: payload });
}
const paidSession = (id, slug, over = {}) => ({ id, payment_status: 'paid', currency: 'usd', amount_subtotal: PRODUCTS[slug].amount, amount_total: PRODUCTS[slug].amount, metadata: { slug }, customer_details: { email: 'Buyer@Example.com' }, payment_intent: 'pi_1', ...over });
const tokenFromEmail = (m) => m.text.match(/\/download\/([\w-]+)/)[1];

test('checkout uses the server-side price and ignores client-supplied amount, price and path', async () => {
  const h = await harness();
  const res = await post(h, '/api/checkout', { slug: 'bid-leveling-matrix', amount: 1, price: 'price_evil', file: '../../etc/passwd' });
  assert.equal(res.status, 200);
  assert.deepEqual(h.created[0].line_items, [{ price: 'price_STRIPE_PRICE_BID_LEVELING_MATRIX', quantity: 1 }]);
  assert.equal((await post(h, '/api/checkout', { slug: '../x' })).status, 400);
  assert.equal((await post(h, '/api/checkout', {})).status, 400);
  h.close();
});

test('checkout refuses when the Stripe price does not match the catalog', async () => {
  const h = await harness({ priceAmount: 1 });
  assert.equal((await post(h, '/api/checkout', { slug: '3-week-look-ahead' })).status, 503);
  h.close();
});

test('purchasing stays unavailable when not enabled', async () => {
  const h = await harness({ purchasesEnabled: false });
  const status = await (await fetch(h.base + '/api/status')).json();
  assert.ok(Object.values(status).every((v) => v === false));
  assert.equal((await post(h, '/api/checkout', { slug: '3-week-look-ahead' })).status, 503);
  h.close();
});

test('webhook rejects a bad signature', async () => {
  const h = await harness();
  const id = await checkout(h, '3-week-look-ahead');
  const res = await webhook(h, 'checkout.session.completed', paidSession(id, '3-week-look-ahead'), { secret: 'whsec_wrong' });
  assert.equal(res.status, 400);
  assert.equal(h.db.prepare('SELECT status FROM orders').get().status, 'pending');
  h.close();
});

test('forged success URL does not unlock anything; only the verified webhook does', async () => {
  const h = await harness();
  const id = await checkout(h, '3-week-look-ahead');
  const before = await (await fetch(`${h.base}/api/order?session_id=${id}`)).json();
  assert.equal(before.status, 'pending');
  assert.equal(before.downloadUrl, undefined);
  h.close();
});

test('paid event fulfills once: one order, one email, correct product; replays are safe', async () => {
  const h = await harness();
  const id = await checkout(h, 'superintendent-project-toolkit');
  const s = paidSession(id, 'superintendent-project-toolkit');
  for (let i = 0; i < 3; i++) assert.equal((await webhook(h, 'checkout.session.completed', s)).status, 200);
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM orders').get().c, 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].to, 'buyer@example.com');
  assert.match(h.sent[0].subject, /Superintendent Project Toolkit/);
  const dl = await fetch(`${h.base}/download/${tokenFromEmail(h.sent[0])}`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /Fieldstone_Superintendent_Project_Toolkit_v1_0\.zip/);
  assert.equal(await dl.text(), 'ZIP:Fieldstone_Superintendent_Project_Toolkit_v1_0.zip');
  const conf = await (await fetch(`${h.base}/api/order?session_id=${id}`)).json();
  assert.equal(conf.status, 'paid');
  assert.equal(conf.amount, '$69');
  h.close();
});

test('every product, including the bundle, delivers only its own ZIP', async () => {
  const h = await harness();
  for (const [slug, p] of Object.entries(PRODUCTS)) {
    const id = await checkout(h, slug);
    await webhook(h, 'checkout.session.completed', paidSession(id, slug));
    const dl = await fetch(`${h.base}/download/${tokenFromEmail(h.sent.at(-1))}`);
    assert.equal(await dl.text(), `ZIP:${p.file}`);
  }
  h.close();
});

test('delayed payment: unpaid completion grants nothing until async success; failure never grants', async () => {
  const h = await harness();
  const id = await checkout(h, '3-week-look-ahead');
  await webhook(h, 'checkout.session.completed', paidSession(id, '3-week-look-ahead', { payment_status: 'unpaid' }));
  assert.equal(h.sent.length, 0);
  assert.equal((await (await fetch(`${h.base}/api/order?session_id=${id}`)).json()).status, 'pending');
  await webhook(h, 'checkout.session.async_payment_succeeded', paidSession(id, '3-week-look-ahead'));
  assert.equal(h.sent.length, 1);

  const id2 = await checkout(h, 'bid-leveling-matrix');
  await webhook(h, 'checkout.session.async_payment_failed', { id: id2 });
  assert.equal((await (await fetch(`${h.base}/api/order?session_id=${id2}`)).json()).status, 'failed');
  await webhook(h, 'checkout.session.completed', paidSession(id2, 'bid-leveling-matrix', { payment_status: 'unpaid' }));
  assert.equal(h.sent.length, 1);
  h.close();
});

test('expired checkout is recorded and never fulfilled', async () => {
  const h = await harness();
  const id = await checkout(h, '3-week-look-ahead');
  await webhook(h, 'checkout.session.expired', { id });
  await webhook(h, 'checkout.session.completed', paidSession(id, '3-week-look-ahead'));
  assert.equal(h.sent.length, 0);
  assert.equal(h.db.prepare('SELECT status FROM orders').get().status, 'expired');
  h.close();
});

test('altered amount or currency is flagged, not fulfilled', async () => {
  const h = await harness();
  const id = await checkout(h, 'construction-management-bundle');
  await webhook(h, 'checkout.session.completed', paidSession(id, 'construction-management-bundle', { amount_subtotal: 2900 }));
  assert.equal(h.sent.length, 0);
  assert.equal(h.db.prepare('SELECT status FROM orders').get().status, 'flagged');
  h.close();
});

test('session not created by our checkout is ignored', async () => {
  const h = await harness();
  assert.equal((await webhook(h, 'checkout.session.completed', paidSession('cs_test_unknownxxxxxx', '3-week-look-ahead'))).status, 200);
  assert.equal(h.sent.length, 0);
  h.close();
});

test('email failure returns 500 so Stripe retries, and the retry sends exactly once', async () => {
  const h = await harness();
  const id = await checkout(h, '3-week-look-ahead');
  const s = paidSession(id, '3-week-look-ahead');
  h.flags.failMail = true;
  assert.equal((await webhook(h, 'checkout.session.completed', s)).status, 500);
  assert.equal(h.db.prepare('SELECT status, emailed_at FROM orders').get().status, 'paid');
  assert.equal(h.sent.length, 0);
  h.flags.failMail = false;
  assert.equal((await webhook(h, 'checkout.session.completed', s)).status, 200);
  assert.equal((await webhook(h, 'checkout.session.completed', s)).status, 200);
  assert.equal(h.sent.length, 1);
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM orders').get().c, 1);
  h.close();
});

test('downloads: no token, bad token, unpaid order and expired token are all denied', async () => {
  const h = await harness({ linkHours: 0.0000001 });
  assert.equal((await fetch(`${h.base}/download/nope`)).status, 404);
  const id = await checkout(h, '3-week-look-ahead');
  h.db.prepare("INSERT INTO download_tokens (order_id, token_hash, expires_at) VALUES (1, 'x', '2999-01-01')").run();
  assert.equal((await fetch(`${h.base}/download/x`)).status, 404); // pending order, hash mismatch
  await webhook(h, 'checkout.session.completed', paidSession(id, '3-week-look-ahead'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await fetch(`${h.base}/download/${tokenFromEmail(h.sent[0])}`)).status, 410);
  h.close();
});

test('token for an unpaid order cannot download', async () => {
  const h = await harness();
  const id = await checkout(h, '3-week-look-ahead');
  await webhook(h, 'checkout.session.completed', paidSession(id, '3-week-look-ahead'));
  const tok = tokenFromEmail(h.sent[0]);
  h.db.prepare("UPDATE orders SET status = 'failed'").run();
  assert.equal((await fetch(`${h.base}/download/${tok}`)).status, 404);
  h.close();
});

test('recovery: matching email gets fresh links, unknown email gets identical response and no mail', async () => {
  const h = await harness();
  const id = await checkout(h, 'bid-leveling-matrix');
  await webhook(h, 'checkout.session.completed', paidSession(id, 'bid-leveling-matrix'));
  const a = await (await post(h, '/api/recover', { email: 'BUYER@example.com' })).json();
  const b = await (await post(h, '/api/recover', { email: 'stranger@example.com' })).json();
  assert.deepEqual(a, b);
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].to, 'buyer@example.com');
  assert.equal((await fetch(`${h.base}/download/${tokenFromEmail(h.sent[1])}`)).status, 200);
  h.close();
});

test('private files and server code are not served statically', async () => {
  const h = await harness();
  for (const p of ['/Fieldstone_3_Week_Look_Ahead_v1_0.zip', '/orders.db', '/../server/app.js', '/.env']) {
    assert.notEqual((await fetch(h.base + p)).status, 200, p);
  }
  h.close();
});

test('the real public/ folder contains no ZIPs, databases or server files', () => {
  const pub = fileURLToPath(new URL('../public/', import.meta.url));
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  const bad = walk(pub).filter((f) => /\.(zip|xlsx|db|js|json|env)$/i.test(f) && !f.endsWith('tools.js'));
  assert.deepEqual(bad, []);
});
