# Dentist Radar — Pro Plus (v1.1.1)
All-in micro‑SaaS: clean UI, Stripe (Pro + Quick Find), scheduler, admin, SQLite (easy Postgres upgrade), Postmark email.

## Deploy on Render
- **Root directory**: repo root (contains `package.json`, `src/`, `public/`)
- **Build Command**: `npm install`
- **Start Command**: `npm run start`
- **Environment**: copy from `.env.example`

### Stripe
- Create a monthly **Pro** price and one-time **Quick Find** price
- Set webhook URL: `https://YOUR-DOMAIN/webhook` with event: `checkout.session.completed`
- Put signing secret into `STRIPE_WEBHOOK_SECRET`

### Admin
- Set `ADMIN_PASSWORD` env var (required)
- Visit `/admin.html` → it will prompt for password → list watches → "Run now"

### Notes for free/Starter plan (~1,000 users)
- Free plan may sleep after inactivity; consider **Starter** to keep "always on"
- Scheduler runs every 20 min by default; tune via `CRON_SCHEDULE`
- Email is mocked until you set `POSTMARK_TOKEN`
