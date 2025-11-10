// emailTemplates.js
// DentistRadar — transactional email templates (v1.2, curated cards with phone, distance & map links)
//
// Usage:
//   import { renderEmail } from "./emailTemplates.js";
//   const { subject, html } = renderEmail("availability", {
//     postcode: "RG41 4UW",
//     radius: 25,
//     practices: [
//       {
//         name: "Woodley Dental Care",
//         address: "123 Reading Rd, Woodley RG41",
//         appointmentUrl: "https://www.nhs.uk/services/dentists/.../appointments",
//         detailUrl: "https://www.nhs.uk/services/dentists/...",
//         phone: "0118 123 4567",
//         distanceMiles: 2.4,
//         lat: 51.444, lon: -0.891,
//         checkedAt: new Date()
//       }
//     ],
//     includeChildOnly: false
//   });
//
//   await sendEmail(recipients, subject, html);

const BRAND = {
  name: "DentistRadar",
  site: process.env.PUBLIC_ORIGIN || "https://www.dentistradar.co.uk",
  logo: process.env.BRAND_LOGO_URL || "", // e.g. "https://www.dentistradar.co.uk/logo.png"
  primary: "#0B6FB7",   // NHS-adjacent blue shade
  lightBg: "#F3F8FC",
  border: "#E5EEF8",
  text: "#222",
  muted: "#667085"
};

/* ────────────────────────────────────────────────────────────────
   Utilities
──────────────────────────────────────────────────────────────── */
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const fmtDate = (d) => {
  try {
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toLocaleString("en-GB", {
      year: "numeric", month: "short", day: "2-digit",
      hour: "2-digit", minute: "2-digit"
    });
  } catch { return ""; }
};

const plural = (n, one, many) => (Number(n) === 1 ? one : many);

// Build a Google Maps link; prefer lat/lon, fallback to address query.
const mapLinkFor = (p) => {
  if (typeof p?.lat === "number" && typeof p?.lon === "number") {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.lat},${p.lon}`)}`;
  }
  if (p?.address) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(String(p.address))}`;
  }
  return "";
};

const milesBadge = (m) => {
  if (m == null || Number.isNaN(Number(m))) return "";
  const v = Number(m).toFixed(1).replace(/\.0$/, "");
  return `<span style="
    display:inline-block;background:${BRAND.lightBg};color:${BRAND.primary};
    border:1px solid ${BRAND.border};border-radius:999px;
    font-size:12px;padding:2px 8px;margin-left:6px;vertical-align:baseline;
  ">${esc(v)} mi</span>`;
};

const telLink = (phone) => {
  if (!phone) return "";
  const raw = String(phone).trim();
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return "";
  return `<a href="tel:${esc(digits)}" style="color:${BRAND.primary};text-decoration:none;">${esc(raw)}</a>`;
};

const baseStyles = {
  container: `font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:${BRAND.text};line-height:1.6;margin:0;padding:0;`,
  h2: `color:${BRAND.primary};margin:0 0 12px 0;letter-spacing:0.2px;`,
  card: `border:1px solid ${BRAND.border};border-radius:8px;padding:12px 14px;margin:12px 0;background:#fff;`,
  tip: `background:${BRAND.lightBg};border-left:4px solid ${BRAND.primary};padding:10px 14px;margin:16px 0;font-size:14px;`,
  footer: `font-size:12px;color:${BRAND.muted};margin-top:16px;`,
  link: `color:${BRAND.primary};text-decoration:none;`,
  hr: `border:0;border-top:1px solid #eee;margin:16px 0;`
};

const headerBlock = () => `
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 12px 0;">
    <tr>
      <td style="vertical-align:middle;">
        ${BRAND.logo ? `<img src="${esc(BRAND.logo)}" alt="${esc(BRAND.name)}" width="96" height="auto" style="display:block;max-width:120px;border:0;margin:0 0 8px 0;">` : ""}
        <div style="font-size:14px;color:${BRAND.muted}">${esc(BRAND.site.replace(/^https?:\/\//,'').replace(/\/$/,''))}</div>
      </td>
    </tr>
  </table>
`;

const footerBlock = (extra = "") => `
  <hr style="${baseStyles.hr}">
  <div style="${baseStyles.footer}">
    ${extra}
    Data source: NHS public website (<a href="https://www.nhs.uk" style="${baseStyles.link}">nhs.uk</a>).<br>
    Curated by ${esc(BRAND.name)} — we parse the official appointments page and summarise changes for you.
    <br><br>
    <span style="color:${BRAND.muted}">You can update your email preferences at any time.</span>
  </div>
`;

const tipBlock = (text) => `<div style="${baseStyles.tip}">💡 <strong>Tip:</strong> ${text}</div>`;

/* ────────────────────────────────────────────────────────────────
   Templates
──────────────────────────────────────────────────────────────── */

function welcomeTemplate({ postcode, radius }) {
  const pc = esc(postcode);
  const rad = esc(radius);
  return {
    subject: `Your ${BRAND.name} watch is live — ${pc} (${rad} miles)`,
    html: `
  <div style="${baseStyles.container}">
    ${headerBlock()}
    <h2 style="${baseStyles.h2}">Your NHS dentist watch is active</h2>
    <p>We’re now monitoring NHS dental practices within <strong>${rad} miles</strong> of <strong>${pc}</strong>.</p>
    <p>You’ll receive an alert as soon as a nearby practice lists availability for new NHS patients.</p>
    ${tipBlock("Availability can change quickly. When you receive an alert, call the practice as soon as you can to confirm before travelling.")}
    <p>Thank you for using ${esc(BRAND.name)}. We’re helping make NHS access a little easier for everyone.</p>
    ${footerBlock()}
  </div>`
  };
}

function availabilityTemplate({ postcode, radius, practices = [], includeChildOnly = false }) {
  const pc = esc(postcode);
  const rad = esc(radius);
  const count = practices.length;

  const cards = practices.map((p) => {
    const name = esc(p.name || "NHS Dental Practice");
    const addr = esc(p.address || "");
    const phone = p.phone ? telLink(p.phone) : "";
    const url  = esc(p.appointmentUrl || p.detailUrl || "#");
    const time = fmtDate(p.checkedAt || Date.now());
    const maps = mapLinkFor(p);
    const dist = p.distanceMiles != null ? milesBadge(p.distanceMiles) : "";

    const mapLine = maps
      ? `🗺️ <a href="${esc(maps)}" style="${baseStyles.link}">Map</a>`
      : "";

    // join meta lines neatly
    const metaParts = []
      .concat(phone ? `📞 ${phone}` : [])
      .concat(mapLine ? mapLine : [])
      .filter(Boolean)
      .join(" &nbsp;&nbsp; ");

    return `
      <div style="${baseStyles.card}">
        <h3 style="margin:0 0 6px 0;color:${BRAND.primary};font-size:16px;">
          ${name}${dist}
        </h3>
        ${addr ? `<div style="margin:0 0 6px 0;font-size:14px;color:#444;">📍 ${addr}</div>` : ""}
        ${metaParts ? `<div style="margin:0 0 6px 0;font-size:14px;color:#444;">${metaParts}</div>` : ""}
        <div style="margin:0 0 6px 0;font-size:14px;">
          🔗 <a href="${url}" style="${baseStyles.link}">View appointments page</a>
        </div>
        <div style="font-size:12px;color:${BRAND.muted};">⏱️ Checked: ${esc(time)}</div>
      </div>`;
  }).join("");

  const subject = `${count ? "🎉 " : ""}NHS availability near ${pc} — ${count} ${plural(count,"practice","practices")} accepting`;

  const childNote = includeChildOnly
    ? `<p style="font-size:14px;color:#444;margin-top:8px;">Includes practices marked as <em>children-only</em> where relevant.</p>`
    : "";

  return {
    subject,
    html: `
  <div style="${baseStyles.container}">
    ${headerBlock()}
    <h2 style="${baseStyles.h2}">NHS dentists now accepting new patients</h2>
    <p>
      Good news — we’ve found <strong>${esc(count)}</strong> ${plural(count,"practice","practices")} within
      <strong>${rad} miles</strong> of <strong>${pc}</strong> currently listing availability for new NHS patients.
    </p>
    ${cards || `<div style="${baseStyles.card}">No curated cards available. Please follow the NHS link provided.</div>`}
    <p style="font-size:14px;color:#444;margin-top:12px;">
      We recommend calling the practice directly to confirm before travelling, as availability can change quickly.
    </p>
    ${childNote}
    ${footerBlock()}
  </div>`
  };
}

/* ────────────────────────────────────────────────────────────────
   Public API
──────────────────────────────────────────────────────────────── */

export function renderEmail(type, data) {
  if (type === "welcome") return welcomeTemplate(data || {});
  if (type === "availability") return availabilityTemplate(data || {});
  return {
    subject: `${BRAND.name} update`,
    html: `
    <div style="${baseStyles.container}">
      ${headerBlock()}
      <h2 style="${baseStyles.h2}">${esc(BRAND.name)} update</h2>
      <p>Hello! This is a notification from ${esc(BRAND.name)}.</p>
      ${footerBlock()}
    </div>`
  };
}

export default { renderEmail };
