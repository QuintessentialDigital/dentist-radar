/**
 * DentistRadar — emailTemplates.js
 * Exposes: renderEmail(type, data)
 *  - type: "welcome" | "availability"
 */

import dayjs from "dayjs";

const BRAND = {
  name: "DentistRadar",
  accent: "#0078d4",
  text: "#1f2937",
  subtext: "#6b7280",
  border: "#e5e7eb",
  bg: "#ffffff",
};

function esc(s = "") {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] || c));
}

function card(pr) {
  const name = pr.name ? esc(pr.name) : "NHS Dental Practice";
  const addr = pr.address ? esc(pr.address) : null;
  const phone = pr.phone ? esc(pr.phone) : null;
  const dist = pr.distanceText ? esc(pr.distanceText.replace(/^this organisation is\s*/i, "")) : null;
  const appt = pr.appointmentUrl ? esc(pr.appointmentUrl) : "#";
  const map = pr.mapUrl ? esc(pr.mapUrl) : null;

  return `
  <div style="margin:0 0 14px;padding:14px;border:1px solid ${BRAND.border};border-radius:10px;background:${BRAND.bg}">
    <h3 style="margin:0 0 6px;color:${BRAND.accent};font:600 16px/1.2 system-ui">${name}</h3>
    <p style="margin:0 0 8px;color:${BRAND.text};font:14px/1.45 system-ui">
      ${addr ? `📍 ${addr}<br>` : ""}
      ${phone ? `📞 <a href="tel:${encodeURIComponent(pr.phone)}" style="color:${BRAND.accent};text-decoration:none">${esc(pr.phone)}</a><br>` : ""}
      ${dist ? `📏 ${dist}<br>` : ""}
    </p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <a href="${appt}" style="display:inline-block;padding:8px 12px;background:${BRAND.accent};color:#fff;border-radius:6px;text-decoration:none;font:600 14px system-ui">Appointments page →</a>
      ${map ? `<a href="${map}" style="display:inline-block;padding:8px 12px;background:#111827;color:#fff;border-radius:6px;text-decoration:none;font:600 14px system-ui">Open map →</a>` : ""}
    </div>
  </div>`;
}

function wrap(bodyHtml, heading, subheading) {
  return `
  <div style="background:#f8fafc;padding:20px 0">
    <div style="max-width:620px;margin:0 auto;padding:16px">
      <div style="padding:16px 14px;border:1px solid ${BRAND.border};border-radius:12px;background:${BRAND.bg}">
        <h2 style="margin:4px 0 6px;color:${BRAND.text};font:700 18px/1.2 system-ui">${esc(heading)}</h2>
        ${subheading ? `<div style="margin:0 0 10px;color:${BRAND.subtext};font:13px system-ui">${esc(subheading)}</div>` : ""}
        ${bodyHtml}
        <hr style="border:0;border-top:1px solid ${BRAND.border};margin:12px 0">
        <p style="margin:10px 0 0;color:${BRAND.subtext};font:12px system-ui">
          We monitor official NHS listings hourly. Please call the practice to confirm availability before travelling.
        </p>
        <p style="margin:6px 0 0;color:${BRAND.subtext};font:12px system-ui">
          Manage your alerts anytime from the website.
        </p>
      </div>
      <div style="text-align:center;margin:12px 0 0;color:${BRAND.subtext};font:11px system-ui">
        © ${new Date().getFullYear()} ${BRAND.name}
      </div>
    </div>
  </div>`;
}

/** Public API */
export function renderEmail(type, data) {
  if (type === "welcome") {
    const { postcode, radius, includeChildOnly } = data || {};
    const heading = `Alert set for ${postcode} (${radius} miles)`;
    const sub = `We’ll email you as soon as we detect NHS practices accepting new patients within your chosen radius.`;
    const body = `
      <p style="margin:0 0 10px;color:${BRAND.text};font:14px/1.6 system-ui">
        Thanks for using ${BRAND.name}! We read the NHS “Appointments” pages directly and only alert when a practice is
        clearly listed as accepting new NHS patients${includeChildOnly ? " (or children only, if enabled)" : ""}.
      </p>
      <ul style="margin:0 0 12px 18px;color:${BRAND.text};font:14px/1.6 system-ui">
        <li>Hourly checks</li>
        <li>Direct links to each practice</li>
        <li>Phone number and map in every alert</li>
      </ul>
    `;
    return { subject: `${BRAND.name} — alert active for ${postcode}`, html: wrap(body, heading, sub) };
  }

  if (type === "availability") {
    const { postcode, radius, practices = [], includeChildOnly = false, scannedAt } = data || {};
    const ts = scannedAt ? dayjs(scannedAt).format("DD MMM YYYY HH:mm") : dayjs().format("DD MMM YYYY HH:mm");
    const acceptingCount = practices.length;

    const heading = acceptingCount
      ? `🎉 ${acceptingCount} practice${acceptingCount > 1 ? "s" : ""} accepting near ${postcode}`
      : `Update for ${postcode}`;

    const sub = `${ts} • Radius: ${radius} miles${includeChildOnly ? " • includes children-only" : ""}`;
    const cards = practices.map(card).join("");

    const body =
      cards ||
      `<p style="margin:0;color:${BRAND.text};font:14px/1.6 system-ui">
        No accepting practices found this round. We’ll keep watching and notify you as soon as something changes.
      </p>`;

    return { subject: `${BRAND.name} — ${acceptingCount} accepting near ${postcode}`, html: wrap(body, heading, sub) };
  }

  return { subject: `${BRAND.name}`, html: wrap("<p style='margin:0'>Hello!</p>", BRAND.name, "") };
}

export default { renderEmail };
