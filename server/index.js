import Stripe from 'stripe';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { createMailer } from './mailer.js';
import { PRODUCTS } from './catalog.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const dataDir = env.DATA_DIR || join(root, 'data');

const config = {
  publicDir: join(root, 'public'),
  siteUrl: (env.SITE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  downloadDir: env.DOWNLOAD_DIR || join(dataDir, 'downloads'),
  purchasesEnabled: env.PURCHASES_ENABLED === 'true',
  webhookSecret: env.STRIPE_WEBHOOK_SECRET,
  automaticTax: env.STRIPE_AUTOMATIC_TAX === 'true',
  linkHours: Number(env.DOWNLOAD_LINK_HOURS) || 72,
  supportEmail: env.SUPPORT_EMAIL || 'brennan@fieldstoneoversight.com',
  prices: Object.fromEntries(Object.entries(PRODUCTS).map(([slug, p]) => [slug, env[p.priceEnv]])),
};

const stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;
const mailer = createMailer({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM });
const db = openDb(join(dataDir, 'orders.db'));
const app = createApp({ stripe, db, mailer, config });

const port = Number(env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Fieldstone site listening on ${port}`);
  console.log(`Purchases ${config.purchasesEnabled ? 'ENABLED' : 'disabled'}; stripe=${Boolean(stripe)} webhook=${Boolean(config.webhookSecret)} email=${mailer.configured}`);
  for (const [slug, p] of Object.entries(PRODUCTS)) {
    console.log(`  ${slug}: price=${Boolean(config.prices[slug])} file=${existsSync(join(config.downloadDir, p.file))}`);
  }
});
