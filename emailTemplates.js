// emailTemplates.js — v2.0 Professional Edition

export function renderEmail(type, data) {
  if (type === "welcome") {
    const subject = "Welcome to DentistRadar – NHS Dentist Alerts";
    const html = `
    <div style="font-family: system-ui, Arial, sans-serif; color: #1a1a1a; line-height: 1.6;">
      <h2 style="color: #0078D4;">Welcome to DentistRadar</h2>
      <p>
        Thank you for subscribing to <b>DentistRadar</b>. You’ll now receive instant alerts when NHS dental practices near your postcode start accepting new patients.
      </p>
      <ul>
        <li>We scan NHS websites hourly for updates.</li>
        <li>You’ll be notified when nearby practices open for NHS patients.</li>
        <li>Each alert includes contact details, map links, and appointment pages.</li>
      </ul>
      <p style="margin-top: 20px;">You can manage or unsubscribe anytime at <a href="https://www.dentistradar.co.uk" style="color:#0078D4;">dentistradar.co.uk</a>.</p>
      <p style="margin-top: 20px; color:#555;">— The DentistRadar Team</p>
    </div>`;
    return { subject, html };
  }

  if (type === "availability") {
    const { postcode, radius, practices } = data;
    const subject = `NHS Dentist Availability – ${postcode} (${radius} miles)`;
    const html = `
    <div style="font-family: system-ui, Arial, sans-serif; color: #1a1a1a; line-height: 1.6;">
      <h2 style="color: #0078D4;">New NHS Dentist Availability Near You</h2>
      <p>We’ve found NHS dental practices <b>accepting new patients</b> within ${radius} miles of <b>${postcode}</b>.</p>
      ${practices.map(p => `
        <div style="margin:16px 0; padding:12px; border:1px solid #ddd; border-radius:8px;">
          <h3 style="margin:0; color:#0078D4;">${p.name || 'Unnamed Practice'}</h3>
          ${p.distanceText ? `<p>📍 ${p.distanceText} from ${postcode}</p>` : ""}
          ${p.phone ? `<p>📞 <a href="tel:${p.phone}" style="color:#0078D4;">${p.phone}</a></p>` : ""}
          ${p.address ? `<p>🏠 ${p.address}</p>` : ""}
          <p>
            ${p.appointmentUrl ? `<a href="${p.appointmentUrl}" style="color:#0078D4;">View appointments</a>` : ""}
            ${p.mapUrl ? ` | <a href="${p.mapUrl}" style="color:#0078D4;">Google Maps</a>` : ""}
          </p>
        </div>`).join("")}
      <p>Please call the practice directly to confirm availability before visiting.</p>
      <hr style="border:none; border-top:1px solid #ddd; margin:20px 0;">
      <p style="font-size:13px; color:#555;">DentistRadar automatically checks NHS websites every hour for new availability.<br>
      Manage your alerts at <a href="https://www.dentistradar.co.uk" style="color:#0078D4;">dentistradar.co.uk</a>.</p>
    </div>`;
    return { subject, html };
  }

  return { subject: "DentistRadar Update", html: "No content available" };
}
