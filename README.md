# Dentist Radar — v1.5.1

Production-ready micro-SaaS for NHS dentist availability alerts.

- Modern, mobile-first UI and logo (auto dark/light)
- Canonical HTTPS/domain redirect (PRIMARY_DOMAIN)
- Duplicate alert protection (unique on email, postcode)
- Postmark emails (welcome, test, simulated availability)
- Stripe Checkout (Quick one-time + Pro subscription)
- Admin tools (list watches, send test, simulate availability)
- Health endpoint: /health?token=...
- SQLite (auto-created). No DB file committed.

## Quick start (local)

```bash
npm install
cp .env.example .env
npm start   # http://localhost:8787
```

## Required ENV

```
ADMIN_PASSWORD=Change-Me
PRIMARY_DOMAIN=www.dentistradar.co.uk
HEALTH_TOKEN=Change-Health-Token
```

## Optional (recommended)

```
POSTMARK_TOKEN=your-postmark-server-token
POSTMARK_FROM=no-reply@dentistradar.co.uk
SENDER_NAME=Dentist Radar Team

STRIPE_SECRET=sk_test_or_live_...
STRIPE_PRICE_PRO=price_...        # Stripe Price ID (subscription)
STRIPE_PRICE_QUICK=price_...      # Stripe Price ID (one-time)
STRIPE_WEBHOOK_SECRET=whsec_...   # if using webhook
PUBLIC_BASE_URL=https://www.dentistradar.co.uk
STRIPE_SUCCESS_URL=https://www.dentistradar.co.uk/?success=1
STRIPE_CANCEL_URL=https://www.dentistradar.co.uk/pricing.html?canceled=1
```

## Render (Web Service) settings

- Build command: npm install
- Start command: npm run start
- Root Directory: (blank)
- Type: Web Service (Node)
- Custom Domains: add and ensure SSL is Active
- DNS at registrar must be pure DNS (no Web Forwarding)
  - www -> CNAME -> yourapp.onrender.com
  - @ (apex) -> A/ALIAS per Render
