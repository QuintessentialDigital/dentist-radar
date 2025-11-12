// emailTemplates.js — v2.2 (Professional templates + summary header)
// Single named export: renderEmail(type, data)

function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatDistance(mi) {
  if (mi == null || Number.isNaN(mi)) return "";
  const n = Number(mi);
  if (!Number.isFinite(n)) return "";
  return n < 10 ? `${n.toFixed(1)} miles` : `${Math.round(n)} miles`;
}

function renderHeaderSummary({ postcode = "", radius = 0, practices = [] }) {
  // Compute totals + distance buckets (0–2, 2–5, 5–10, 10–25, 25+)
  const nums = practices
    .map(p => (typeof p.distanceMiles === "number" ? p.distanceMiles : null))
  ;
  const total = practices.length;

  const bucket = (from, to) =>
    nums.filter(v => v != null && v >= from && v < to).length;

  const b0_2   = bucket(0, 2);
  const b2_5   = bucket(2, 5);
  const b5_10  = bucket(5, 10);
  const b10_25 = bucket(10, 25);
  const b25p   = nums.filter(v => v != null && v >= 25).length;
  const unknown= nums.filter(v => v == null).length;

  return `
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;border:1px solid #eaeaea;border-radius:10px;overflow:hidden;margin:8px 0 14px;">
    <thead>
      <tr style="background:#f7f9fb;">
        <th align="left" style="font:600 13px system-ui,Arial;padding:10px 12px;color:#0b5cab;">Postcode</th>
        <th align="left" style="font:600 13px system-ui,Arial;padding:10px 12px;color:#0b5cab;">Radius</th>
        <th align="left" style="font:600 13px system-ui,Arial;padding:10px 12px;color:#0b5cab;">Found</th>
        <th align="left" style="font:600 13px system-ui,Arial;padding:10px 12px;color:#0b5cab;">0–2</th>
        <th align="left" style="font:600 13px system-ui,Arial;padding:10px 12px;color:#0b5cab;">2–5</th>
        <th align="left" style="font:600 13px system-ui,Arial;padding:10px 12px;color:#0b5cab;">5–10</th>
        <th align="left" style="font:600 13px system-ui,Arial;padding:10px 12px;color:#0b5cab;">10–25</th>
        <th align="left" style="font:600 13px system-ui,Arial;padding:10px 12px;color:#0b5cab;">25+</th>
        <th align="left" style="font:600 13px system-ui,Arial;padding:10px 12px;color:#0b5cab;">Unknown</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font:500 13px system-ui,Arial;padding:10px 12px;color:#1a1a1a;">${escapeHtml(postcode)}</td>
        <td style="font:500 13px system-ui,Arial;padding:10px 12px;color:#1a1a1a;">${radius} miles</td>
        <td style="font:600 13px system-ui,Arial;padding:10px 12px;color:#1a1a1a;">${total}</td>
        <td style="font:500 13px system-ui,Arial;padding:10px 12px;color:#1a1a1a;">${b0_2}</td>
        <td style="font:500 13px system-ui,Arial;padding:10px 12px;color:#1a1a1a;">${b2_5}</td>
        <td style="font:500 13px system-ui,Arial;padding:10px 12px;color:#1a1a1a;">${b5_10}</td>
        <td style="font:500 13px system-ui,Arial;padding:10px 12px;color:#1a1a1a;">${b10_25}</td>
        <td style="font:500 13px system-ui,Arial;padding:10px 12px;color:#1a1a1a;">${b25p}</td>
        <td style="font:500 13px system-ui,Arial;padding:10px 12px;color:#1a1a1a;">${unknown}</td>
      </tr>
    </tbody>
  </table>`;
}

export function renderEmail(type, data) {
  if (type === "welcome") {
    const subject = "Welcome to DentistRadar – NHS Dentist Alerts";
    const html = `
    <div style="font-family:system-ui,Arial,sans-serif;color:#1a1a1a;line-height:1.6;">
      <h2 style="color:#0b5cab;margin:0 0 8px;">Welcome to DentistRadar</h2>
      <p>Thanks for subscribing. We’ll email you when NHS dental practices near your postcode start accepting new patients.</p>
      <ul style="margin:0 0 16px 18px;padding:0;">
        <li>We check NHS practice pages every hour.</li>
        <li>Alerts include practice name, phone, distance and map/appointments links.</li>
        <li>You can manage or unsubscribe any time.</li>
      </ul>
      <p style="margin:16px 0 8px;">Manage alerts: <a href="https://www.dentistradar.co.uk" style="color:#0b5cab;">dentistradar.co.uk</a></p>
      <p style="font-size:12px;color:#666;margin:10px 0 0;">Please call the practice to confirm before travelling.</p>
    </div>`;
    return { subject, html };
  }

  if (type === "availability") {
    const postcode  = data?.postcode || "";
    const radius    = data?.radius ?? "";
    const practices = Array.isArray(data?.practices) ? data.practices : [];

    const subject = `NHS Dentist Availability – ${postcode} (${radius} miles)`;

    const header = renderHeaderSummary({ postcode, radius, practices });

    const cards = practices.map(p => {
      const name   = p.name || "NHS Dental Practice";
      const phone  = p.phone ? `<p style="margin:4px 0;">📞 <a href="tel:${p.phone}" style="color:#0b5cab;text-decoration:none;">${p.phone}</a></p>` : "";
      const distMI = (typeof p.distanceMiles === "number") ? formatDistance(p.distanceMiles) : "";
      const dist   = distMI ? `<p style="margin:4px 0;">📍 ${distMI} from ${escapeHtml(postcode)}</p>` :
                    (p.distanceText ? `<p style="margin:4px 0;">📍 ${escapeHtml(p.distanceText)} from ${escapeHtml(postcode)}</p>` : "");
      const addr   = p.address ? `<p style="margin:4px 0;">🏠 ${escapeHtml(p.address)}</p>` : "";
      const links  = [
        p.appointmentUrl ? `<a href="${p.appointmentUrl}" style="color:#0b5cab;text-decoration:none;">Appointments</a>` : "",
        p.mapUrl ? `<a href="${p.mapUrl}" style="color:#0b5cab;text-decoration:none;">Google Maps</a>` : "",
        p.detailUrl ? `<a href="${p.detailUrl}" style="color:#0b5cab;text-decoration:none;">NHS Profile</a>` : "",
      ].filter(Boolean).join(" &middot; ");

      return `
        <div style="margin:14px 0; padding:12px; border:1px solid #e6e6e6; border-radius:10px;">
          <h3 style="margin:0 0 6px; color:#0b5cab;">${escapeHtml(name)}</h3>
          ${dist}${phone}${addr}
          <p style="margin:6px 0 0;">${links}</p>
        </div>`;
    }).join("");

    const html = `
    <div style="font-family:system-ui,Arial,sans-serif;color:#1a1a1a;line-height:1.6;">
      <h2 style="color:#0b5cab;margin:0 0 8px;">New NHS Dentist Availability Near You</h2>
      <p style="margin:0 0 10px;">We’ve found practices currently accepting new NHS patients within ${radius} miles of <b>${escapeHtml(postcode)}</b>.</p>
      ${header}
      ${cards || `<p>No eligible practices found in this run.</p>`}
      <p style="margin-top:14px;">Please call the practice to confirm availability before visiting.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
      <p style="font-size:12px;color:#666;margin:0;">DentistRadar checks NHS pages hourly. Manage alerts at <a href="https://www.dentistradar.co.uk" style="color:#0b5cab;">dentistradar.co.uk</a>.</p>
    </div>`;
    return { subject, html };
  }

  return { subject: "DentistRadar Update", html: "<div style='font-family:system-ui'>No content.</div>" };
}
