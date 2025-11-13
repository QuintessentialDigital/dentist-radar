// emailTemplates.js — polished templates with professional look & feel

function esc(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[c]));
}

/* ───────── Shared bits ───────── */

function headerSummary({ postcode, radius, count }) {
  return `
    <table role="presentation" width="100%" style="border-collapse:collapse;margin:12px 0 18px">
      <tr>
        <td style="padding:10px 12px;background:#f5f7fa;border:1px solid #e0e4ec;border-right:0;font-weight:600">Postcode</td>
        <td style="padding:10px 12px;background:#f5f7fa;border:1px solid #e0e4ec;border-left:0">${esc(postcode)}</td>
        <td style="padding:10px 12px;background:#f5f7fa;border:1px solid #e0e4ec;border-right:0;font-weight:600">Radius</td>
        <td style="padding:10px 12px;background:#f5f7fa;border:1px solid #e0e4ec;border-left:0">${radius} miles</td>
        <td style="padding:10px 12px;background:#f5f7fa;border:1px solid #e0e4ec;border-right:0;font-weight:600">Accepting</td>
        <td style="padding:10px 12px;background:#f5f7fa;border:1px solid #e0e4ec;border-left:0">${count}</td>
      </tr>
    </table>
  `;
}

function rowPractice(p, idx) {
  const name = p.name ? esc(p.name) : "Dental practice";
  const phone = p.phone
    ? `<a href="tel:${esc(p.phone)}" style="text-decoration:none;color:#0b57d0">${esc(p.phone)}</a>`
    : "—";
  const dist = p.distanceText ? esc(p.distanceText) : "—";
  const addr = p.address ? esc(p.address) : "—";

  const actions = [
    p.appointmentUrl ? `<a href="${esc(p.appointmentUrl)}" style="color:#0b57d0;text-decoration:none">Appointments</a>` : "",
    p.detailUrl ? `<a href="${esc(p.detailUrl)}" style="color:#0b57d0;text-decoration:none">NHS page</a>` : "",
    p.mapUrl ? `<a href="${esc(p.mapUrl)}" style="color:#0b57d0;text-decoration:none">Map</a>` : "",
  ]
    .filter(Boolean)
    .join(" • ");

  return `
    <tr>
      <td style="padding:9px 10px;border-bottom:1px solid #edf0f5;white-space:nowrap;color:#111">${idx}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #edf0f5;color:#0b0c0c;font-weight:600">${name}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #edf0f5;color:#111">${addr}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #edf0f5;color:#111">${phone}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #edf0f5;color:#111">${dist}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #edf0f5;color:#0b57d0;white-space:nowrap">${actions}</td>
    </tr>
  `;
}

/* ───────── Availability email ───────── */

function availabilityEmail({ postcode, radius, practices, scannedAt }) {
  const count = practices.length;
  const when = new Date(scannedAt || Date.now()).toLocaleString("en-GB", { hour12: false });

  const rows = practices.map((p, i) => rowPractice(p, i + 1)).join("");

  const html = `
  <div style="background:#f3f5f9;padding:16px 0">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #dde2ec;overflow:hidden;font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;-webkit-font-smoothing:antialiased">
      
      <!-- Top bar / brand -->
      <div style="background:#0b57d0;color:#ffffff;padding:12px 18px;border-bottom:1px solid #0a4cbc">
        <div style="font-size:16px;font-weight:600;">DentistRadar</div>
        <div style="font-size:12px;opacity:0.9;">NHS dentist availability alerts</div>
      </div>

      <div style="padding:16px 18px 18px">
        <div style="margin-bottom:10px;">
          <h2 style="margin:0 0 4px;font-size:18px;">NHS dentists currently accepting patients</h2>
          <div style="color:#646A73;font-size:13px;">
            Search area: <b>${esc(postcode)}</b> within <b>${radius} miles</b> • Checked on ${esc(when)}
          </div>
        </div>

        ${headerSummary({ postcode, radius, count })}

        <table role="presentation" width="100%" style="border-collapse:collapse;border:1px solid #edf0f5;border-radius:6px;overflow:hidden">
          <thead>
            <tr style="background:#fafbff">
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid #edf0f5;width:42px;font-size:12px;color:#555;">#</th>
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid #edf0f5;font-size:12px;color:#555;">Practice</th>
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid #edf0f5;font-size:12px;color:#555;">Address</th>
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid #edf0f5;font-size:12px;color:#555;">Phone</th>
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid #edf0f5;font-size:12px;color:#555;">Distance</th>
              <th style="text-align:left;padding:9px 10px;border-bottom:1px solid #edf0f5;font-size:12px;color:#555;">Links</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>

        <p style="margin:14px 0 4px;color:#444;font-size:13px;">
          We scan the NHS practice pages (Appointments / Opening times) and include practices where the wording clearly states they are
          <b>currently accepting NHS patients</b>.
        </p>
        <p style="margin:4px 0 0;color:#666;font-size:12px;">
          Availability can change quickly. Please always call the practice before travelling, and confirm that NHS registrations are still open.
        </p>

        <hr style="border:0;border-top:1px solid #edf0f5;margin:16px 0 10px">

        <p style="margin:0 0 4px;color:#858b93;font-size:11px;">
          You’re receiving this alert because you set up an NHS dentist watch for <b>${esc(postcode)}</b> on DentistRadar.
        </p>
      </div>
    </div>
  </div>`;
  const subject = `DentistRadar — ${postcode} (${radius} mi): ${count} accepting`;
  return { subject, html };
}

/* ───────── Welcome email ───────── */

function welcomeEmail({ postcode, radius }) {
  const html = `
  <div style="background:#f3f5f9;padding:16px 0">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #dde2ec;overflow:hidden;font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111;-webkit-font-smoothing:antialiased">
      
      <!-- Top bar / brand -->
      <div style="background:#0b57d0;color:#ffffff;padding:12px 18px;border-bottom:1px solid #0a4cbc">
        <div style="font-size:16px;font-weight:600;">DentistRadar</div>
        <div style="font-size:12px;opacity:0.9;">NHS dentist availability alerts</div>
      </div>

      <div style="padding:18px 18px 20px">
        <h2 style="margin:0 0 6px;font-size:18px;">Your NHS dentist alert is now active</h2>
        <p style="margin:0 0 10px;color:#444;font-size:13px;">
          Thanks for setting up an alert with DentistRadar. We’ll watch NHS practice pages for you and let you know when they are
          clearly accepting new NHS patients near your area.
        </p>

        <table role="presentation" style="border-collapse:collapse;margin:8px 0 14px;">
          <tr>
            <td style="padding:6px 10px 6px 0;font-size:13px;color:#555;">Postcode</td>
            <td style="padding:6px 0;font-size:13px;color:#111;"><b>${esc(postcode)}</b></td>
          </tr>
          <tr>
            <td style="padding:6px 10px 6px 0;font-size:13px;color:#555;">Radius</td>
            <td style="padding:6px 0;font-size:13px;color:#111;"><b>${radius} miles</b></td>
          </tr>
          <tr>
            <td style="padding:6px 10px 6px 0;font-size:13px;color:#555;">Alert type</td>
            <td style="padding:6px 0;font-size:13px;color:#111;">NHS practices currently accepting new patients</td>
          </tr>
        </table>

        <h3 style="margin:4px 0 4px;font-size:14px;">How DentistRadar works</h3>
        <ol style="margin:4px 0 12px 20px;padding:0;font-size:13px;color:#444;">
          <li style="margin:2px 0;">
            We scan NHS dentist pages for your postcode area (within ${radius} miles).
          </li>
          <li style="margin:2px 0;">
            We focus on the <b>Appointments / Opening times</b> sections and look for clear wording that the practice is accepting NHS patients.
          </li>
          <li style="margin:2px 0;">
            When we detect clear availability, you’ll receive an email with practice names, contact numbers, distances and quick links.
          </li>
        </ol>

        <h3 style="margin:6px 0 4px;font-size:14px;">What to do when you receive an alert</h3>
        <ol style="margin:4px 0 10px 20px;padding:0;font-size:13px;color:#444;">
          <li style="margin:2px 0;">Review the list of practices and choose a few that are convenient for you.</li>
          <li style="margin:2px 0;">Call the practice directly to confirm they are still accepting NHS patients.</li>
          <li style="margin:2px 0;">Arrange your registration or appointment according to their guidance.</li>
        </ol>

        <p style="margin:10px 0 0;color:#666;font-size:12px;">
          Availability can change quickly and we rely on the wording shown on the NHS site. Always confirm directly with the practice
          before travelling.
        </p>

        <hr style="border:0;border-top:1px solid #edf0f5;margin:16px 0 8px">

        <p style="margin:0 0 4px;color:#858b93;font-size:11px;">
          You’re receiving this email because you created an NHS dentist alert on DentistRadar for <b>${esc(postcode)}</b>.
        </p>
      </div>
    </div>
  </div>`;
  const subject = `DentistRadar — alert active for ${postcode}`;
  return { subject, html };
}

/* ───────── Public API ───────── */

function renderEmail(kind, data) {
  if (kind === "availability") return availabilityEmail(data);
  if (kind === "welcome") return welcomeEmail(data);
  return { subject: "DentistRadar", html: "<div>DentistRadar</div>" };
}

export { renderEmail };
export default { renderEmail };
