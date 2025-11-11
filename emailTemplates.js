// emailTemplates.js — professional, trustworthy templates
// Export: renderEmail(type, payload)

function shell(inner) {
  return `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;color:#111;line-height:1.55">
    <div style="max-width:680px;margin:0 auto;padding:16px">
      ${inner}
      <hr style="border:0;border-top:1px solid #eee;margin:16px 0">
      <div style="font-size:12px;color:#666">
        DentistRadar scans NHS practice pages and reads the text on the <b>Appointments</b> or <b>Practice</b> page.
        Always call the practice to confirm before travelling. This is not official NHS communication.
      </div>
    </div>
  </div>`;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function welcomeTemplate({ postcode, radius }) {
  const body = `
    <h2 style="margin:0 0 8px">Your alert is active — ${escapeHtml(postcode)} (${radius} miles)</h2>
    <p style="margin:0 0 12px">
      Thanks for using <b>DentistRadar</b>. We’ll notify you when a nearby practice clearly states
      they’re <b>accepting new NHS patients</b>.
    </p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin:12px 0">
      <div style="font-weight:600;margin-bottom:6px">How we decide</div>
      <ul style="margin:0 0 0 18px;padding:0">
        <li>We look for explicit phrases like “Currently accepts new NHS patients”.</li>
        <li>We <b>exclude</b> “not confirmed”, “waiting list”, and “private only”.</li>
      </ul>
    </div>
    <p style="margin:12px 0 0">You can adjust your postcode or radius any time from the website.</p>
  `;
  return {
    subject: `DentistRadar — alert active for ${postcode}`,
    html: shell(body)
  };
}

function practiceCard(p) {
  const name = p.name ? escapeHtml(p.name) : "View practice";
  const title = p.detailUrl
    ? `<a href="${p.detailUrl}" style="color:#0b69c7;text-decoration:none">${name}</a>`
    : name;

  const lines = [`<div style="font-weight:600;font-size:16px;margin:0 0 4px">${title}</div>`];

  if (p.phone) {
    const tel = String(p.phone).replace(/\s+/g, "");
    lines.push(
      `<div style="color:#111">📞 <a href="tel:${tel}" style="color:#111;text-decoration:none">${escapeHtml(p.phone)}</a></div>`
    );
  }

  const links = [];
  if (p.appointmentUrl) links.push(`<a href="${p.appointmentUrl}" style="color:#0b69c7;text-decoration:none">Appointments page</a>`);
  if (p.detailUrl)     links.push(`<a href="${p.detailUrl}" style="color:#0b69c7;text-decoration:none">Practice page</a>`);
  if (links.length) lines.push(`<div style="margin-top:6px">${links.join(" &nbsp;•&nbsp; ")}</div>`);

  if (p.source) {
    const label = p.source === "appointments" ? "Source: Appointments page" : "Source: Practice page";
    lines.push(`<div style="font-size:12px;color:#666;margin-top:6px">${label}</div>`);
  }

  return `<div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin:10px 0">${lines.join("")}</div>`;
}

function availabilityTemplate({ postcode, radius, practices, scannedAt }) {
  const header = `
    <h2 style="margin:0 0 6px">NHS availability near ${escapeHtml(postcode)}</h2>
    <div style="color:#555;margin:0 0 12px">
      Radius: <b>${radius} miles</b> &nbsp;•&nbsp; Checked: ${new Date(scannedAt || Date.now()).toLocaleString("en-GB")}
    </div>
    <p style="margin:0 0 10px">The following practices explicitly state they’re accepting new NHS patients:</p>
  `;
  const cards = practices.map(practiceCard).join("");
  const footer = `
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;padding:10px;margin-top:10px">
      <div style="font-weight:600;margin-bottom:6px">Tip</div>
      <div>Call just after opening hours. If the line is busy, ask when they last updated their acceptance status.</div>
    </div>
  `;
  return {
    subject: `DentistRadar — ${postcode} (${radius} mi): ${practices.length} accepting`,
    html: shell(header + cards + footer)
  };
}

export function renderEmail(type, payload) {
  if (type === "welcome") return welcomeTemplate(payload || {});
  if (type === "availability") return availabilityTemplate(payload || {});
  return { subject: "DentistRadar", html: shell("<p>Notification</p>") };
}

export default { renderEmail };
