// emailTemplates.js — exports renderEmail()
// Availability cards show per-practice distance/phone; no global/duplicate distance.

export function renderEmail(kind, data) {
  if (kind === "availability") {
    const { postcode, radius, practices, includeChildOnly = false, scannedAt } = data;

    const cards = (practices || [])
      .map((p) => {
        const name = p.name || "NHS dental practice";
        const phone = p.phone ? row("📞", esc(p.phone)) : "";
        const distance = p.distanceText ? row("📏", esc(p.distanceText)) : "";
        const address = p.address ? row("📍", esc(p.address)) : "";

        const apptBtn = p.appointmentUrl
          ? `<a href="${attr(p.appointmentUrl)}" style="display:inline-block;background:#005eb8;color:#fff;padding:8px 10px;border-radius:6px;text-decoration:none;margin-right:8px">Appointments</a>`
          : "";

        const mapBtn = p.mapUrl
          ? `<a href="${attr(p.mapUrl)}" style="display:inline-block;background:#e8f1fb;color:#005eb8;padding:8px 10px;border-radius:6px;text-decoration:none;border:1px solid #cfe0f5">Open map</a>`
          : "";

        return `
          <div style="border:1px solid #e8e8e8;border-radius:10px;padding:12px;margin:10px 0">
            <div style="font-weight:600;font-size:15px;margin-bottom:6px">${esc(name)}</div>
            ${address}
            ${distance}
            ${phone}
            <div style="margin-top:8px">
              ${apptBtn}
              ${mapBtn}
            </div>
          </div>`;
      })
      .join("");

    const subject = `NHS dentists near ${postcode} — ${practices.length} match${practices.length === 1 ? "" : "es"}`;
    const html = `
      <div style="font:14px system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;color:#111;-webkit-font-smoothing:antialiased">
        <h2 style="margin:0 0 6px">Dentist availability near ${esc(postcode)}</h2>
        <div style="color:#555;margin:0 0 12px">Radius: ${radius} miles • ${new Date(
      scannedAt || Date.now()
    ).toLocaleString()}</div>

        ${cards || "<div>No practices matched right now.</div>"}

        <hr style="border:0;border-top:1px solid #eee;margin:14px 0">
        <div style="font-size:12px;color:#666">
          We read the NHS <b>Appointments</b> page to infer availability. Always call the practice to confirm before travelling.
        </div>
      </div>
    `;
    return { subject, html };
  }

  // Default / welcome template (keep minimal; customize as you like)
  if (kind === "welcome") {
    const { postcode, radius } = data || {};
    return {
      subject: `DentistRadar — alert active for ${postcode}`,
      html: `
        <div style="font:14px system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;color:#111">
          <h2 style="margin:0 0 6px">You're set!</h2>
          <p>We’ll email you when NHS practices within <b>${radius} miles</b> of <b>${esc(
        postcode || ""
      )}</b> start accepting new patients.</p>
          <p style="color:#666">Tip: add this address to your contacts so alerts never land in spam.</p>
        </div>`,
    };
  }

  // Fallback
  return { subject: "DentistRadar", html: "<div>OK</div>" };
}

/* helpers */
function esc(s = "") {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function attr(s = "") {
  return String(s).replace(/"/g, "&quot;");
}
function row(emoji, text) {
  return `<div style="margin:4px 0"><b>${emoji}</b> ${text}</div>`;
}

export default { renderEmail };
