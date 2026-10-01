import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PRODUCTS, CURRENCY } from './catalog.js';

const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const money = (cents) => `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(now); hits.set(key, recent);
    return true;
  };
}

function messagePage(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} | Fieldstone Oversight</title></head>
<body style="font-family:Inter,system-ui,sans-serif;background:#0F1923;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px">
<main style="max-width:520px"><h1 style="font-size:1.5rem">${esc(title)}</h1><p style="color:rgba(255,255,255,.75);line-height:1.7">${body}</p></main></body></html>`;
}

export function createApp({ stripe, db, mailer, config, log = console }) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' });
    next();
  });

  const linkMs = (config.linkHours ?? 72) * 3600 * 1000;
  const priceOk = new Map();
  const checkoutLimit = limiter(20, 10 * 60 * 1000);
  const recoverIpLimit = limiter(10, 60 * 60 * 1000);
  const recoverEmailLimit = limiter(3, 60 * 60 * 1000);

  const filePath = (slug) => join(config.downloadDir, PRODUCTS[slug].file);
  const isReady = (slug) =>
    Boolean(config.purchasesEnabled && stripe && config.webhookSecret && config.prices[slug] && mailer.configured && existsSync(filePath(slug)));

  function issueToken(orderId) {
    const raw = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO download_tokens (order_id, token_hash, expires_at) VALUES (?, ?, ?)')
      .run(orderId, sha256(raw), new Date(Date.now() + linkMs).toISOString());
    return raw;
  }
  const linkFor = (raw) => `${config.siteUrl}/download/${raw}`;
  const hoursText = () => `${config.linkHours ?? 72} hours`;

  async function sendDownloadEmail(order, links, isRecovery = false) {
    const lines = links.map((l) => `${l.name}: ${l.url}`).join('\n');
    const support = config.supportEmail;
    const text = `${isRecovery ? 'Here are fresh download links for your Fieldstone purchase.' : 'Thank you for your purchase from Fieldstone Oversight.'}\n\n${lines}\n\nEach link works for ${hoursText()}. If a link expires, request a new one at ${config.siteUrl}/order.html\n\nThe download is a ZIP containing editable Excel workbooks, printable PDFs, examples and instructions. Stripe sends your payment receipt separately.\n\nQuestions: ${support}\n`;
    const html = `<p>${isRecovery ? 'Here are fresh download links for your Fieldstone purchase.' : 'Thank you for your purchase from Fieldstone Oversight.'}</p><ul>${links.map((l) => `<li><a href="${esc(l.url)}">${esc(l.name)}</a></li>`).join('')}</ul><p>Each link works for ${hoursText()}. If a link expires, <a href="${esc(config.siteUrl)}/order.html">request a new one</a>.</p><p>The download is a ZIP containing editable Excel workbooks, printable PDFs, examples and instructions. Stripe sends your payment receipt separately.</p><p>Questions: <a href="mailto:${esc(support)}">${esc(support)}</a></p>`;
    await mailer.send({ to: order.email, subject: isRecovery ? 'Your Fieldstone download links' : `Your download: ${PRODUCTS[order.slug].name}`, text, html });
  }

  // Send the purchase email exactly once per order; retries after a failure are safe.
  async function ensurePurchaseEmail(orderId) {
    const claimed = db.prepare("UPDATE orders SET emailed_at = 'sending' WHERE id = ? AND status = 'paid' AND emailed_at IS NULL").run(orderId);
    if (claimed.changes !== 1) return;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    try {
      if (!order.email) throw new Error('no buyer email on order');
      await sendDownloadEmail(order, [{ name: PRODUCTS[order.slug].name, url: linkFor(issueToken(order.id)) }]);
      db.prepare('UPDATE orders SET emailed_at = ? WHERE id = ?').run(new Date().toISOString(), orderId);
    } catch (err) {
      db.prepare('UPDATE orders SET emailed_at = NULL WHERE id = ?').run(orderId);
      throw err;
    }
  }

  async function fulfill(session) {
    const order = db.prepare('SELECT * FROM orders WHERE session_id = ?').get(session.id);
    if (!order) { log.warn(`webhook: unknown checkout session ${session.id}`); return; }
    if (order.status === 'pending') {
      const product = PRODUCTS[order.slug];
      const valid = product && session.currency === CURRENCY && session.amount_subtotal === product.amount && session.metadata?.slug === order.slug;
      if (!valid) {
        db.prepare("UPDATE orders SET status = 'flagged' WHERE id = ? AND status = 'pending'").run(order.id);
        log.error(`webhook: order ${order.id} amount/product mismatch; not fulfilled`);
        return;
      }
      db.prepare("UPDATE orders SET status = 'paid', amount = ?, currency = ?, email = ?, payment_intent = ?, paid_at = ? WHERE id = ? AND status = 'pending'")
        .run(session.amount_total, session.currency, session.customer_details?.email?.toLowerCase() ?? null,
          typeof session.payment_intent === 'string' ? session.payment_intent : null, new Date().toISOString(), order.id);
    }
    await ensurePurchaseEmail(order.id);
  }

  async function handleEvent(event) {
    const s = event.data.object;
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        if (s.payment_status === 'paid') await fulfill(s); // 'unpaid' = delayed method still pending
        break;
      case 'checkout.session.async_payment_failed':
        db.prepare("UPDATE orders SET status = 'failed' WHERE session_id = ? AND status = 'pending'").run(s.id);
        break;
      case 'checkout.session.expired':
        db.prepare("UPDATE orders SET status = 'expired' WHERE session_id = ? AND status = 'pending'").run(s.id);
        break;
    }
  }

  // Raw body is required for signature verification, so this precedes express.json().
  app.post('/api/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), config.webhookSecret);
    } catch {
      return res.status(400).send('Invalid signature');
    }
    try {
      await handleEvent(event);
      res.json({ received: true });
    } catch (err) {
      log.error(`webhook ${event.type} failed: ${err.message}`);
      res.status(500).send('Processing failed'); // Stripe will retry; handlers are idempotent
    }
  });

  app.use(express.json({ limit: '2kb' }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.get('/api/status', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(Object.fromEntries(Object.keys(PRODUCTS).map((s) => [s, isReady(s)])));
  });

  app.post('/api/checkout', async (req, res) => {
    if (!checkoutLimit(req.ip)) return res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    const slug = req.body?.slug;
    if (typeof slug !== 'string' || !Object.hasOwn(PRODUCTS, slug)) return res.status(400).json({ error: 'Unknown product.' });
    if (!isReady(slug)) return res.status(503).json({ error: 'Purchasing is not available yet.' });
    try {
      const priceId = config.prices[slug];
      if (!priceOk.get(slug)) {
        const price = await stripe.prices.retrieve(priceId);
        if (price.unit_amount !== PRODUCTS[slug].amount || price.currency !== CURRENCY || price.type !== 'one_time' || !price.active) {
          log.error(`checkout: Stripe price for ${slug} does not match catalog; refusing`);
          return res.status(503).json({ error: 'Purchasing is not available yet.' });
        }
        priceOk.set(slug, true);
      }
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${config.siteUrl}/order.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${config.siteUrl}/tool-${slug}.html?checkout=canceled`,
        metadata: { slug },
        ...(config.automaticTax ? { automatic_tax: { enabled: true } } : {}),
      });
      db.prepare('INSERT INTO orders (session_id, slug) VALUES (?, ?)').run(session.id, slug);
      res.json({ url: session.url });
    } catch (err) {
      log.error(`checkout failed: ${err.message}`);
      res.status(502).json({ error: 'Could not start checkout. Please try again.' });
    }
  });

  // Status comes only from the database, which only the verified webhook can move to "paid".
  app.get('/api/order', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const id = String(req.query.session_id || '');
    if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(id)) return res.status(400).json({ error: 'Invalid order.' });
    const order = db.prepare('SELECT * FROM orders WHERE session_id = ?').get(id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    const body = { status: order.status === 'flagged' ? 'review' : order.status, product: PRODUCTS[order.slug].name };
    if (order.status === 'paid') {
      body.amount = money(order.amount);
      body.emailSent = Boolean(order.emailed_at && order.emailed_at !== 'sending');
      body.downloadUrl = `/download/${issueToken(order.id)}`;
    }
    res.json(body);
  });

  app.get('/download/:token', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const row = db.prepare(`SELECT t.id, t.expires_at, o.slug FROM download_tokens t JOIN orders o ON o.id = t.order_id
      WHERE t.token_hash = ? AND o.status = 'paid'`).get(sha256(req.params.token));
    if (!row) return res.status(404).send(messagePage('Link not valid', `This download link is not valid. If you purchased a template, <a href="/order.html" style="color:#4d97e8">request a new link</a>.`));
    if (new Date(row.expires_at) < new Date()) return res.status(410).send(messagePage('Link expired', `This download link has expired. <a href="/order.html" style="color:#4d97e8">Request a new link</a> using your purchase email.`));
    const file = filePath(row.slug);
    if (!existsSync(file)) {
      log.error(`download: file for ${row.slug} missing on disk`);
      return res.status(503).send(messagePage('Temporarily unavailable', `Your download could not be prepared. Please email ${esc(config.supportEmail)} and we will send it to you.`));
    }
    db.prepare('UPDATE download_tokens SET downloads = downloads + 1 WHERE id = ?').run(row.id);
    res.download(file, PRODUCTS[row.slug].file);
  });

  app.post('/api/recover', async (req, res) => {
    const generic = { ok: true, message: 'If that email matches a purchase, a new download link is on its way.' };
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!recoverIpLimit(req.ip)) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return res.json(generic);
    if (!recoverEmailLimit(email)) return res.json(generic);
    try {
      const orders = db.prepare("SELECT * FROM orders WHERE email = ? AND status = 'paid' ORDER BY id").all(email);
      if (orders.length && mailer.configured) {
        const links = orders.map((o) => ({ name: PRODUCTS[o.slug].name, url: linkFor(issueToken(o.id)) }));
        await sendDownloadEmail({ ...orders[0], email }, links, true);
      }
    } catch (err) {
      log.error(`recover failed: ${err.message}`);
    }
    res.json(generic); // identical response whether or not a purchase exists
  });

  app.use(express.static(config.publicDir, { extensions: ['html'], dotfiles: 'ignore' }));
  app.use((req, res) => res.status(404).send(messagePage('Page not found', `That page does not exist. <a href="/" style="color:#4d97e8">Return home</a>.`)));
  return app;
}
