/**
 * DentistRadar — emailTemplates.js (vS2)
 * Exports: renderEmail(type, payload)
 * Types:
 *   - "welcome": { email, postcode, radius }
 *   - "availability": { postcode, radius, practices:[{name,phone,appointmentUrl,detailUrl,source}], includeChildOnly, scannedAt }
 */

function baseShell(inner) {
  return `
  <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; color:#111; line-height:1.5">
    <div style="max-width:640px;margin:0 auto;padding:16px">
      ${inner}
      <hr style="border:0;border-top:1px solid #eee;margin:16px 0">
      <div style="font-size:12px;color:#666">
        DentistRadar scans the NHS website and reads the text on each practice’s <b>Appointments</b> or <b>Practice</b> page.
        Always call the practice to confirm before travelling. This is not official NHS communication.
      </div>
    </div>
  </div>`;
}

function renderWelcome({ email, postcode, radius }) {
  const body = `
    <h2 style="margin:0 0 8px">Alert set for ${postcode} (${radius} miles)</h2>
    <p style="margin:0 0 12px">
      Thanks for using <b>DentistRadar</b>. We’ll scan local NHS practice pages and notify you when we
      detect <b>clear wording</b> that they’re <b>accepting new NHS patients</b>.
    </p>

    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:12px;margin:12px 0">
      <div style="font-weight:600;margin-bottom:6px">What we look for</div>
      <ul style="margin:0 0 0 18px;padding:0">
        <li>Explicit phrases like “Currently accepts new NHS patients”.</li>
        <li>We <b>exclude</b> “not confirmed”, “waiting list”, and “private only”.</li>
      </ul>
    </div>

    <p style="margin:12px 0 0">You can change your postcode/radius any time from the site.</p>
  `;
  return {
    subject: `DentistRadar — alert active for ${postcode}`,
    html: baseShell(body)
  };
}

function practiceCard(p) {
  const rows = [];

  // Name (link to detail)
  if (p.name || p.detailUrl) {
    const title = p.name ? escapeHtml(p.name) : "View practice";
    const href = p.detailUrl ? ` href="${p.detailUrl}"` : "";
    rows.push(
      `<div style="font-weight:600;font-size:16px;margin:0 0 4px"><a${href} style="color:#0b69c7;text-decoration:none">${title}</a></div>`
    );
  }

  // Phone
  if (p.phone) {
    const tel = p.phone.replace(/\s+/g, "");
    rows.push(`<div style="color:#111">📞 <a href="tel:${encodeHtml(tel)}" style="color:#111;text-decoration:none">${escapeHtml(p.phone)}</a></div>`);
  }

  // Links row
  const links = [];
  if (p.appointmentUrl) links.push(`<a href="${p.appointmentUrl}" style="color:#0b69c7;text-decoration:none">Appointments page</a>`);
  if (p.detailUrl)     links.push(`<a href="${p.detailUrl}" style="color:#0b69c7;text-decoration:none">Practice page</a>`);
  if (links.length) rows.push(`<div style="margin-top:6px">${links.join(' &nbsp;•&nbsp; ')}</div>`);

  // Source tag
  if (p.source) {
    const label = p.source === "appointments" ? "Source: Appointments page" : "Source: Practice page";
    rows.push(`<div style="font-size:12px;color:#666;margin-top:6px">${label}</div>`);
  }

  return `
    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin:10px 0">
      ${rows.join("")}
    </div>`;
}

function renderAvailability({ postcode, radius, practices, includeChildOnly, scannedAt }) {
  const header = `
    <h2 style="margin:0 0 6px">NHS availability near ${postcode}</h2>
    <div style="color:#555;margin:0 0 12px">
      Radius: <b>${radius} miles</b> &nbsp;•&nbsp; Checked: ${new Date(scannedAt || Date.now()).toLocaleString("en-GB")}
    </div>
    <p style="margin:0 0 10px">We found the following practices explicitly stating they’re accepting new NHS patients:</p>
  `;

  const cards = practices.map(practiceCard).join("");

  const footer = `
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:10px;margin-top:10px">
      <div style="font-weight:600;margin-bottom:6px">Tip</div>
      <div>Call shortly after the practice opens. If phone lines are busy, ask when they last updated their NHS acceptance status.</div>
    </div>
  `;

  return {
    subject: `DentistRadar — ${postcode} (${radius} mi): ${practices.length} accepting`,
    html: baseShell(header + cards + footer)
  };
}

/* ───────── Utilities ───────── */
function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function encodeHtml(s) {
  return escapeHtml(s);
}

/* ───────── Export ───────── */
export function renderEmail(type, payload) {
  if (type === "welcome") return renderWelcome(payload || {});
  if (type === "availability") return renderAvailability(payload || {});
  // Fallback
  return {
    subject: "DentistRadar",
    html: baseShell("<p>Notification</p>")
  };
}

export default { renderEmail };
