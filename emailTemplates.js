// emailTemplates.js
// Clean, professional HTML for "welcome" and "availability" emails.
// Renders per-practice cards with address, distance, phone, appointments link, map link.

export function renderEmail(kind, data) {
  if (kind === "welcome") {
    const { postcode, radius } = data || {};
    const subject = `Dentist Radar — your alert is active for ${safe(postcode)}`;
    const html = `
      <div style="font:14px system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;color:#0b0c0c;-webkit-font-smoothing:antialiased">
        <div style="max-width:640px;margin:0 auto;padding:18px">
          <h1 style="font-size:20px;margin:0 0 8px">Your NHS dentist alert is live ✅</h1>
          <p style="margin:8px 0">
            We’ll email you when NHS practices within <b>${Number(radius) || 10} miles</b> of <b>${safe(
              postcode || ""
            )}</b> start accepting new patients.
          </p>
          <div style="background:#f5f7fa;border:1px solid #e3e8ef;border-radius:8px;padding:12px;margin:14px 0">
            <div style="font-weight:600;margin-bottom:6px">What happens next</div>
            <ul style="margin:0 0 0 20px;padding:0;line-height:1.5">
              <li>We read the NHS <b>Appointments</b> page for nearby practices.</li>
              <li>If we detect acceptance, you’ll receive an alert with practice details and links.</li>
              <li>Please call the practice to confirm before travelling.</li>
            </ul>
          </div>
          <p style="margin:14px 0 0;color:#6b7280;font-size:12px">
            Tip: add this address to your contacts so alerts never land in spam.<br>
            — Dentist Radar
          </p>
        </div>
      </div>`;
    return { subject, html };
  }

  if (kind === "availability") {
    const { postcode, radius, practices = [], scannedAt } = data || {};
    const subject = `NHS dentists near ${safe(postcode)} — ${practices.length} match${practices.length === 1 ? "" : "es"}`;

    const cards = practices.map(cardHtml).join("");

    const html = `
      <div style="font:14px system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;color:#0b0c0c;-webkit-font-smoothing:antialiased">
        <div style="max-width:640px;margin:0 auto;padding:18px">
          <h1 style="font-size:20px;margin:0 0 4px">Dentist availability near ${safe(postcode)}</h1>
          <div style="color:#6b7280;margin:0 0 12px">Radius: ${Number(radius) || 10} miles • ${new Date(
            scannedAt || Date.now()
          ).toLocaleString()}</div>

          ${cards || emptyState()}

          <hr style="border:0;border-top:1px solid #e5e7eb;margin:16px 0">
          <p style="margin:0;color:#6b7280;font-size:12px">
            We read the NHS <b>Appointments</b> page to infer availability. Always call the practice to confirm before travelling.
          </p>
        </div>
      </div>`;
    return { subject, html };
  }

  return { subject: "Dentist Radar", html: "<div>OK</div>" };
}

/* helpers */
function cardHtml(p) {
  const name = p.name || "NHS dental practice";
  const address = p.address ? row("📍", p.address) : "";
  const distance = p.distanceText ? row("📏", p.distanceText) : "";
  const phone = p.phone ? row("📞", p.phone) : "";

  const apptBtn = p.appointmentUrl
    ? `<a href="${attr(p.appointmentUrl)}" style="display:inline-block;background:#005eb8;color:#fff;padding:8px 12px;border-radius:8px;text-decoration:none;margin-right:8px">Appointments</a>`
    : "";

  const mapBtn = p.mapUrl
    ? `<a href="${attr(p.mapUrl)}" style="display:inline-block;background:#eef5ff;color:#005eb8;padding:8px 12px;border:1px solid #cfe0ff;border-radius:8px;text-decoration:none">Open map</a>`
    : "";

  return `
    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin:12px 0">
      <div style="font-weight:600;font-size:15px;margin-bottom:6px">${safe(name)}</div>
      ${address}
      ${distance}
      ${phone}
      <div style="margin-top:8px">
        ${apptBtn}
        ${mapBtn}
      </div>
    </div>`;
}

function row(icon, text) {
  return `<div style="margin:4px 0">${icon} ${safe(text)}</div>`;
}
function emptyState() {
  return `
    <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:12px;margin:12px 0">
      <div style="font-weight:600;margin-bottom:4px">No practices matched right now</div>
      <div style="color:#6b7280">We’ll keep checking and email you as soon as we detect acceptance.</div>
    </div>`;
}
function safe(s = "") {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function attr(s = "") {
  return String(s).replace(/"/g, "&quot;");
}
