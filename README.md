# Dentist Radar — v1.1.2 (Polished)

**What’s new**
- Fix: Home and Admin now use a **configurable API base** so they work on any domain setup.
- UI polish: improved typography, spacing, and alignment (clean & professional).

## Deploy on Render
- Build: `npm install`
- Start: `npm run start`
- Env: copy `.env.example` (at least set `ADMIN_PASSWORD`)
- If your static UI is hosted on a **different domain** than the API, set in each page:
  ```html
  <script>window.DR_API_BASE='https://YOUR-API.onrender.com';</script>
  ```
  (If UI and API share a domain, leave it empty.)

## Test
- `/health?token=YOUR_HEALTH_TOKEN` → `{ ok: true }`
- `/api/watches` → `{ items: [] }`
- `/admin.html` → Create test watch → Refresh list → Run now
