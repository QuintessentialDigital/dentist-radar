import fetch from "node-fetch";

export async function runScanSimulation(postcode = "SW1A 2AA") {
  const apiKey = process.env.NHS_API_KEY;
  const nhsBase = process.env.NHS_BASE || "https://api.nhs.uk/service-search";

  const result = {
    ok: true,
    checked: 0,
    found: 0,
    alertsSent: 0,
    meta: { flags: { usedApi: false, suspectedCookieWall: false } },
  };

  try {
    // Step 1 — Get lat/lon for postcode
    const geoRes = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
    const geoJson = await geoRes.json();
    if (!geoJson.result) throw new Error("Invalid postcode");

    const { latitude, longitude } = geoJson.result;

    // Step 2 — Query NHS API
    const nhsUrl = `${nhsBase}/organisations?api-version=2&serviceType=dentist&latitude=${latitude}&longitude=${longitude}&top=10`;

    const nhsRes = await fetch(nhsUrl, {
      headers: {
        "subscription-key": apiKey,
        Accept: "application/json",
      },
    });

    const data = await nhsRes.json();
    result.meta.flags.usedApi = true;

    if (Array.isArray(data?.value)) {
      result.found = data.value.length;
      result.cards = data.value.map((d) => ({
        name: d.organisationName,
        addr: d.address1 || d.address,
        link: d.orgLink || d.website || "",
      }));
    } else {
      result.cards = [];
    }

    result.checked = 1;
    return result;
  } catch (err) {
    console.error("scan error:", err.message);
    result.ok = false;
    result.error = err.message;
    return result;
  }
}
