# Deploying fieldstoneoversight.com on Railway

The whole site is one Railway service: `public/` (static pages) plus `server/` (Stripe checkout, webhook, protected downloads). Run locally with `npm install && npm start`; tests with `npm test` (Node 24+).

## 1. Railway service
1. New project → deploy from the GitHub repo `BrenTheBuilder/Fieldstone-Oversight`.
2. Add a **Volume** mounted at `/data`. Order records (`/data/orders.db`) and paid ZIPs (`/data/downloads`) live here and survive deploys.
3. Add the custom domain `fieldstoneoversight.com` (and `www`) in Railway, then update DNS at the registrar as Railway instructs. GitHub Pages (and the `CNAME` file) can be retired after cutover.
4. The paid ZIPs are **not in git**. Copy the four files from `private-assets/downloads/` into `/data/downloads/` on the volume (for example `railway ssh`, then `curl -o` from a short-lived private link). Startup logs show `file=true` per product once they are present.

## 2. Environment variables
| Variable | Value |
| --- | --- |
| `DATA_DIR` | `/data` |
| `SITE_URL` | `https://fieldstoneoversight.com` |
| `STRIPE_SECRET_KEY` | test key first (`sk_test_...`), live key at launch |
| `STRIPE_WEBHOOK_SECRET` | signing secret of the webhook endpoint below |
| `STRIPE_PRICE_3_WEEK_LOOK_AHEAD` | Stripe Price id, $29 one-time USD |
| `STRIPE_PRICE_BID_LEVELING_MATRIX` | Price id, $29 |
| `STRIPE_PRICE_SUPERINTENDENT_PROJECT_TOOLKIT` | Price id, $69 |
| `STRIPE_PRICE_CONSTRUCTION_MANAGEMENT_BUNDLE` | Price id, $99 |
| `RESEND_API_KEY`, `MAIL_FROM` | Resend key and a sender on a verified domain, e.g. `Fieldstone Oversight <orders@fieldstoneoversight.com>` |
| `SUPPORT_EMAIL` | optional, defaults to brennan@fieldstoneoversight.com |
| `DOWNLOAD_LINK_HOURS` | optional, default 72 |
| `STRIPE_AUTOMATIC_TAX` | `true` only after Stripe Tax is set up |
| `PURCHASES_ENABLED` | `true` to allow checkout. Leave unset/false and every button stays "Coming soon" |

A product's Buy button goes live only when purchases are enabled, Stripe key, webhook secret, that product's price id, Resend, and its ZIP on the volume are all present. The server also refuses checkout if a Stripe Price's amount/currency differs from `server/catalog.js`.

## 3. Stripe (test mode first)
- Create four one-time USD Prices ($29, $29, $69, $99) and put their ids in the variables above.
- Webhook endpoint: `https://fieldstoneoversight.com/api/webhook`, events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`.
- Enable the Stripe receipt email (Settings → Emails → successful payments).
- Local testing: `stripe listen --forward-to localhost:3000/api/webhook`.

## 4. Test-mode acceptance
Buy each product and the bundle with card `4242 4242 4242 4242`; confirm the confirmation page, Resend email, correct ZIP filename/contents, and `Lost your download link?` recovery on `/order.html`. Try a canceled checkout and a declined card (`4000 0000 0000 0002`). Do not switch to live keys or make a real charge until the owner approves and the license, refund policy and tax decisions are made.

## Notes
- Sales are never unlocked by the success URL: only the signature-verified webhook marks an order paid.
- Download links are random, stored hashed, expire (default 72 h), and can be re-issued via `/order.html`.
- Back up `/data/orders.db` periodically (Railway volume backups).
