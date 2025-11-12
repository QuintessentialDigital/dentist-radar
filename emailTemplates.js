// emailTemplates.js — professional templates (welcome + availability)

const css = `
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;-webkit-font-smoothing:antialiased;color:#111;margin:0;padding:0}
  .wrap{max-width:760px;margin:0 auto;padding:20px}
  h1,h2,h3{margin:0 0 12px}
  .meta{color:#666;font-size:13px;margin-bottom:12px}
  .card{border:1px solid #eee;border-radius:10px;padding:14px 16px;margin:10px 0}
  .row{display:flex;gap:10px;flex-wrap:wrap}
  .k{color:#555;width:110px}
  .v{flex:1}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th,td{border-top:1px solid #eee;padding:10px 8px;text-align:left;vertical-align:top}
  th{background:#fafafa;font-weight:600}
  .pill{display:inline-block;background:#eef6ff;border:1px solid #d8e8ff;color:#16437e;padding:2px 8px;border-radius:999px;font-size:12px}
  .footer{color:#777;font-size:12px;margin-top:16px}
  .links a{margin-right:10px}
`;

function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}

function welcomeTemplate({ email, postcode, radius, createdAt }) {
  return {
    subject: `DentistRadar — alert set for ${postcode} (${radius} miles)`,
    html: `
    <html><head><meta charset="utf-8"><style>${css}</style></head><body>
    <div class="wrap">
      <h2>You're set — we’ll watch NHS dentist availability for you</h2>
      <div class="meta">Postcode: <b>${esc(postcode)}</b> • Radius: <b>${radius} miles</b> • Created: ${new Date(createdAt||Date.now()).toLocaleString()}</div>

      <div class="card">
        <div class="row"><div class="k">What we do</div><div class="v">We check the NHS <b>Appointments</b> pages of practices within your radius and alert you when wording indicates they are <b>accepting new NHS patients</b>.</div></div>
        <div class="row"><div class="k">How to use</div><div class="v">When you receive an alert, <b>call the practice</b> promptly to confirm before travelling. Availability changes quickly.</div></div>
        <div class="row"><div class="k">Tips</div><div class="v">Consider nearby postcodes (e.g., work or school), try different radii, and keep your phone handy.</div></div>
      </div>

      <div class="footer">You’re receiving this because you created an alert at DentistRadar. To stop alerts, reply “STOP” or remove your watch in the app.</div>
    </div></body></html>`,
  };
}

function availabilityTemplate({ postcode, radius, practices = [], includeChildOnly = false, scannedAt }) {
  const accepting = practices; // already filtered upstream
  const count = accepting.length;

  const header = `
    <div class="card">
      <div class="row"><div class="k">Summary</div>
        <div class="v">
          <span class="pill">${count} practice${count!==1?"s":""} accepting</span>
          &nbsp;within <b>${radius} miles</b> of <b>${esc(postcode)}</b>
          <div class="meta">Scanned: ${new Date(scannedAt||Date.now()).toLocaleString()}</div>
        </div>
      </div>
    </div>`;

  const rows = accepting.map(p => {
    const phone = p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : "—";
    const dist  = p.distanceText ? esc(p.distanceText) : "—";
    const name  = p.name ? esc(p.name) : "NHS dental practice";
    const appt  = p.appointmentUrl ? `<a href="${esc(p.appointmentUrl)}">Appointments</a>` : "";
    const det   = p.detailUrl ? `<a href="${esc(p.detailUrl)}">NHS details</a>` : "";
    const map   = p.mapUrl ? `<a href="${esc(p.mapUrl)}">Map</a>` : "";
    const links = [appt, det, map].filter(Boolean).join(" · ");

    return `<tr>
      <td><div style="font-weight:600">${name}</div>${p.address ? `<div style="color:#555">${esc(p.address)}</div>`:""}</td>
      <td>${dist}</td>
      <td>${phone}</td>
      <td class="links">${links || "—"}</td>
    </tr>`;
  }).join("");

  const html = `
  <html><head><meta charset="utf-8"><style>${css}</style></head><body>
    <div class="wrap">
      <h2>Good news — NHS practices accepting near ${esc(postcode)}</h2>
      <div class="meta">We found practices indicating they are accepting new NHS patients. Please phone to confirm before travelling.</div>

      ${header}

      <table>
        <thead><tr><th>Practice</th><th>Distance</th><th>Phone</th><th>Quick links</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>

      <div class="footer">
        DentistRadar reads the “Appointments” wording on NHS practice pages. Availability changes quickly; please confirm with the practice.
      </div>
    </div>
  </body></html>`;

  return {
    subject: `DentistRadar — ${count} accepting near ${postcode} (${radius} mi)`,
    html,
  };
}

export function renderEmail(kind, data) {
  if (kind === "welcome") return welcomeTemplate(data || {});
  if (kind === "availability") return availabilityTemplate(data || {});
  throw new Error(`Unknown email kind: ${kind}`);
}
