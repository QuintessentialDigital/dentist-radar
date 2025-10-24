# Dentist Radar — v1.4.2 (fresh DB)
Production-ready micro‑SaaS for NHS dentist availability alerts.

## What’s included
- Modern, mobile-first UI and logo
- Canonical HTTPS/domain redirect (set PRIMARY_DOMAIN)
- Duplicate alert protection (unique (email, postcode))
- Postmark emails (welcome, test, simulated availability)
- Stripe Checkout (Quick one‑time + Pro subscription)
- Admin tools (list watches, send test, simulate availability)
- Fresh database (no data.sqlite included)

## Quick start (local)
```bash
npm install
cp .env.example .env
npm start              # http://localhost:8787
```

## Required env
```
ADMIN_PASSWORD=Change-Me
PRIMARY_DOMAIN=www.dentistradar.co.uk   # or your chosen canonical
```

## Optional (recommended)
```
POSTMARK_TOKEN=your-postmark-server-token
POSTMARK_FROM=no-reply@dentistradar.co.uk
SENDER_NAME=Dentist Radar Team

STRIPE_SECRET=sk_test_or_live_...
STRIPE_PRICE_PRO=price_...        # Stripe Price ID (subscription)
STRIPE_PRICE_QUICK=price_...      # Stripe Price ID (one‑time)
STRIPE_WEBHOOK_SECRET=whsec_...

PUBLIC_BASE_URL=https://www.dentistradar.co.uk
STRIPE_SUCCESS_URL=https://www.dentistradar.co.uk/?success=1
STRIPE_CANCEL_URL=https://www.dentistradar.co.uk/pricing.html?canceled=1
```
