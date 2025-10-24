# Dentist Radar — v1.1.2 (Polished UI, API base pre-configured)

This is the **nicer previous layout** you preferred. I only added a tiny config file (`public/assets/config.js`) to point the front-end to your API so alerts create properly.

Change the API URL in one place if needed:
```
public/assets/config.js
  window.DR_API_BASE = 'https://dentist-radar.onrender.com';
```

## Deploy
- Upload to GitHub (top level: `package.json`, `src/`, `public/`)
- Render → Build: `npm install` → Start: `npm run start`
- Env (Render): `ADMIN_PASSWORD`, `CORS_ORIGIN=*`, `HEALTH_TOKEN`
- Test: `/health?token=...` → `{ ok:true }`, Home form → shows green “Alert created” banner.
