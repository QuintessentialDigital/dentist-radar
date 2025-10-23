# Dentist Radar — Option A (Launch-Ready Basic)

**Target domain:** https://dentistradar.co.uk

## What this is
Minimal production-ready Dentist Radar:
- Watches public NHS dentist pages
- Emails when a nearby practice flips to **accepting new patients**
- Landing, pricing, privacy pages + a tiny admin

## Deploy (Render)
1. Create Web Service from this repo.
2. Build: `npm install`
3. Start: `npm run start`
4. Environment variables:
```
PORT=8787
BRAND_NAME=Dentist Radar
PUBLIC_BASE_URL=https://dentistradar.co.uk
POSTMARK_TOKEN= (from postmarkapp.com)
POSTMARK_FROM=no-reply@dentistradar.co.uk
SENDER_NAME=Dentist Radar Team
ADMIN_PASSWORD=Change-This-Password-Now
SCHEDULER_ENABLED=true
CRON_SCHEDULE=*/20 * * * *
MAX_CONCURRENT_FETCHES=3
PER_HOST_DELAY_MS=1000
PRACTICE_CACHE_TTL_MS=600000
HEALTH_TOKEN=Change-Health-Token
```
5. Open `/` and test. Use `/admin.html` to run scans.

## Notes
- Be polite to NHS servers (already rate-limited).
- This build ships **email only** via Postmark.
- Stripe and other channels can be added later.
