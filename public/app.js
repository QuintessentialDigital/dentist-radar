(function () {
  const $ = (id) => document.getElementById(id);
  const form = $("alertForm");
  const msg = $("msg");
  const toggle = $("menu-toggle");
  const links = $("nav-links");
  const radius = $("radius");

  // Mobile menu toggle
  toggle?.addEventListener("click", () => links?.classList.toggle("open"));
  links
    ?.querySelectorAll("a")
    .forEach((a) =>
      a.addEventListener("click", () => links.classList.remove("open"))
    );

  // Numeric-only radius (desktop & mobile)
  radius?.addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/[^0-9]/g, "");
  });

  function showMessage(html, type = "") {
    if (!msg) return;
    msg.className = `message-box show ${type}`;
    msg.innerHTML = html;
  }

  function hideMessage() {
    if (!msg) return;
    msg.className = "message-box";
    msg.innerHTML = "";
  }

  hideMessage();

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    const postcode = form.postcode.value.trim().toUpperCase(); // <- small tweak
    const r = form.radius.value.trim();

    if (!email || !postcode || !r) {
      showMessage(
        "⚠ Please fill in all fields, including radius.",
        "warn"
      );
      return;
    }
    const n = parseInt(r, 10);
    if (isNaN(n) || n < 1 || n > 30) {
      showMessage(
        "⚠ Please select a radius between 1 and 30 miles.",
        "warn"
      );
      return;
    }

    showMessage("Saving your alert…");

    try {
      const res = await fetch("/api/watch/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, postcode, radius: r }),
      });
      const data = await res.json();

      if (data.ok) {
        showMessage("✅ Alert created — check your inbox!", "success");
        form.reset();
        return;
      }

      // 🔒 New: handle non-England postcodes nicely
      if (data.error === "unsupported_region") {
        const text =
          data.message ||
          "DentistRadar currently supports NHS dentist searches in England only. Support for Scotland, Wales and Northern Ireland will be added in future.";
        showMessage(`⚠ ${text}`, "warn");
        return;
      }

      if (data.error === "invalid_postcode") {
        showMessage(
          "❌ Please enter a valid UK postcode (e.g. RG1 2AB).",
          "error"
        );
        return;
      }
      if (data.error === "invalid_email") {
        showMessage(
          "❌ Please enter a valid email address.",
          "error"
        );
        return;
      }
      if (data.error === "invalid_radius") {
        showMessage(
          "⚠ Please select a valid radius (1–30 miles).",
          "warn"
        );
        return;
      }
      if (data.error === "duplicate") {
        showMessage(
          "⚠ An alert already exists for this postcode.",
          "warn"
        );
        return;
      }
      if (data.error === "upgrade_required") {
        const link = data.upgradeLink || "/pricing.html";
        const safeMessage =
          data.message || "You’ve reached your current plan limit.";
        showMessage(
          `⚡ ${safeMessage} <a href="${link}">View plans</a>.`,
          "warn"
        );
        return;
      }

      showMessage(
        "⚠ Something went wrong. Please try again later.",
        "error"
      );
    } catch (err) {
      console.error(err);
      showMessage(
        "⚠ Server unavailable. Please retry.",
        "error"
      );
    }
  });
})();
