// emailTemplates.js — executive-grade templates with summary header, full practice cards

function esc(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function headerSummary({ postcode, radius, count }) {
  return `
    <table role="presentation" width="100%" style="border-collapse:collapse;margin:12px 0 16px">
      <tr>
        <td style="padding:10px 12px;background:#f5f7fa;border:1px solid #e8ebf1;border-right:0"><b>Postcode</b></td>
        <td style="padding:10px 12px;background:#f5f7fa;border:1px solid #e8ebf1;border-left:0">${esc(postcode)}</td>
        <td style="padding:10px 12px;background:#f5f7fa;border:1px solid #e8ebf1;border-right:0"><b>Radius</b></td>
        <td style="padding:10px 12px;background:#f5f7fa;border:1px solid #e8ebf1;border-left:0">${radius} miles</td>
        <td style="padding:10px 12px;background:#f5f7fa;border:1px solid #e8ebf1;border-right:0"><b>Accepting</b></td>
        <td style="padding:10px 12px;background:#f5f7fa;border:1px solid #e8ebf1;border-left:0">${count}</td>
      </tr>
    </table>
  `;
}

function rowPractice(p, idx) {
  const name = p.name ? esc(p.name) : "Dental practice";
  const phone = p.phone ? `<a href="tel:${esc(p.phone)}" style="text-decoration:none;color:#0b57d0">${esc(p.phone)}</a>` : "—";
  const dist = p.distanceText ? esc(p.distanceText) : "—";
  const addr = p.address ? esc(p.address) : "—";

  const actions = [
    p.appointmentUrl ? `<a href="${esc(p.appointmentUrl)}" style="color:#0b57d0">Appointments</a>` : "",
    p.detailUrl ? `<a href="${esc(p.detailUrl)}" style="color:#0b57d0">NHS page</a>` : "",
    p.mapUrl ? `<a href="${esc(p.mapUrl)}" style="color:#0b57d0">Map</a>` : "",
  ]
    .filter(Boolean)
    .join(" • ");

  return `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;white-space:nowrap;color:#111">${idx}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#0b0c0c;font-weight:600">${name}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#111">${addr}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#111">${phone}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#111">${dist}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #eee;color:#0b57d0;white-space:nowrap">${actions}</td>
    </tr>
  `;
}

/* Availability email */
function availabilityEmail({ postcode, radius, practices, scannedAt }) {
  const count = practices.length;
  const when = new Date(scannedAt || Date.now()).toLocaleString("en-GB", { hour12: false });

  const rows = practices.map((p, i) => rowPractice(p, i + 1)).join("");

  const html = `
  <div style="font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;-webkit-font-smoothing:antialiased">
    <div style="padding:12px 0 8px">
      <h2 style="margin:0 0 4px">NHS dentists currently accepting patients</h2>
      <div style="color:#646A73">${esc(postcode)} • within ${radius} miles • ${esc(when)}</div>
    </div>

    ${headerSummary({ postcode, radius, count })}

    <table role="presentation" width="100%" style="border-collapse:collapse;border:1px solid #eee">
      <thead>
        <tr style="background:#fafafa">
          <th style="text-align:left;padding:10px 12px;border-bottom:1px solid #eee;width:48px">#</th>
          <th style="text-align:left;padding:10px 12px;border-bottom:1px solid #eee">Practice</th>
          <th style="text-align:left;padding:10px 12px;border-bottom:1px solid #eee">Address</th>
          <th style="text-align:left;padding:10px 12px;border-bottom:1px solid #eee">Phone</th>
          <th style="text-align:left;padding:10px 12px;border-bottom:1px solid #eee">Distance</th>
          <th style="text-align:left;padding:10px 12px;border-bottom:1px solid #eee">Links</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <p style="margin:14px 0 0;color:#666">
      We scan the NHS practice pages (Appointments/Openings) and include practices with clear, current wording that they are accepting NHS patients.
      Availability can change — please call the practice to confirm before travelling.
    </p>

    <p style="margin:8px 0 0;color:#9aa0a6;font-size:12px">
      You’re receiving this alert because you set up an NHS dentist watch for ${esc(postcode)} on DentistRadar.
    </p>
  </div>`;
  const subject = `DentistRadar — ${postcode} (${radius} mi): ${count} accepting`;
  return { subject, html };
}

/* Welcome email */
function welcomeEmail({ postcode, radius }) {
  const html = `
  <div style="font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;-webkit-font-smoothing:antialiased">
    <div style="padding:12px 0 8px">
      <h2 style="margin:0 0 4px">Your NHS dentist alert is live</h2>
      <div style="color:#646A73">We’ll watch for availability near <b>${esc(postcode)}</b> within <b>${radius} miles</b>.</div>
    </div>

    <ol style="margin:6px 0 12px 18px;padding:0;color:#111">
      <li>We scan NHS practice pages (Appointments/Openings) for clear acceptance wording.</li>
      <li>When we find openings, you’ll get practice names, phone numbers, distances and quick links.</li>
      <li>Availability changes — always call the practice to confirm before travelling.</li>
    </ol>

    <p style="margin:12px 0 0;color:#666">Thank you for using DentistRadar.</p>
    <p style="margin:6px 0 0;color:#9aa0a6;font-size:12px">You can add more postcodes or update your radius any time.</p>
  </div>`;
  const subject = `DentistRadar — alert active for ${postcode}`;
  return { subject, html };
}

/* Public API */
function renderEmail(kind, data) {
  if (kind === "availability") return availabilityEmail(data);
  if (kind === "welcome") return welcomeEmail(data);
  return { subject: "DentistRadar", html: "<div>DentistRadar</div>" };
}

export { renderEmail };
export default { renderEmail };
