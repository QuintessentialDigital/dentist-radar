/* ───────── Replace from here … ───────── */

async function collectDetailLinksOnPage(page) {
  return await page.evaluate(() => {
    const out = new Set();
    document.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      try {
        const abs = new URL(href, location.href).toString();
        if (/^https:\/\/www\.nhs\.uk\/services\/dentists\//i.test(abs) && !/\/appointments(\b|\/|\?|#)/i.test(abs)) {
          out.add(abs.split("#")[0]);
        }
      } catch {}
    });
    return Array.from(out);
  });
}

async function acceptCookiesIfShown(page) {
  // NHS cookie banners vary; try a few common buttons/texts
  const selectors = [
    'button#nhsuk-cookie-banner__link_accept',
    'button#accept-additional-cookies',
    'button:has-text("Accept additional cookies")',
    'button:has-text("Accept all cookies")',
    'button:has-text("I agree")'
  ];
  for (const sel of selectors) {
    const h = await page.locator(sel);
    if ((await h.count()) > 0) {
      await h.first().click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(300);
      break;
    }
  }
}

async function performSearch(page, postcode, radiusMiles) {
  // Go to the generic dentist finder
  await page.goto("https://www.nhs.uk/service-search/find-a-dentist", {
    waitUntil: "domcontentloaded",
    timeout: 20000
  });

  await acceptCookiesIfShown(page);

  // Fill postcode
  const pcField = page.locator(
    [
      'input[name="search"]',
      'input[name="postcode"]',
      'input#postcode',
      'input#location',
      'input[type="search"]'
    ].join(",")
  ).first();
  await pcField.fill(postcode, { timeout: 8000 }).catch(() => {});
  // Some forms need a small pause for onChange hooks
  await page.waitForTimeout(150);

  // Set radius if a select exists (fallback to default if not present)
  const radius = Math.max(1, Math.min(30, Math.round(Number(radiusMiles) || 10)));
  const radiusSelect = page.locator('select[name="distance"], select#distance').first();
  if ((await radiusSelect.count()) > 0) {
    // Try exact value; if not available, pick the closest option >= requested
    const options = await radiusSelect.locator('option').allTextContents();
    let target = String(radius);
    if (!options.some(o => o.includes(target))) {
      const nums = options
        .map(o => Number((o.match(/\d+/) || [])[0] || 0))
        .filter(n => n > 0)
        .sort((a,b)=>a-b);
      const picked = nums.find(n => n >= radius) || nums[nums.length - 1];
      if (picked) target = String(picked);
    }
    await radiusSelect.selectOption({ label: new RegExp(`\\b${target}\\b`) }).catch(async () => {
      await radiusSelect.selectOption({ value: target }).catch(() => {});
    });
    await page.waitForTimeout(100);
  }

  // Submit search
  const submit = page.locator(
    [
      'button[type="submit"]',
      'button:has-text("Search")',
      'input[type="submit"]'
    ].join(",")
  ).first();
  if ((await submit.count()) > 0) {
    await submit.click().catch(() => {});
  } else {
    // fallback: press Enter in postcode box
    await pcField.press("Enter").catch(() => {});
  }

  // Wait for a signal that results have rendered:
  // either any dentist detail link, or a known results container
  await Promise.race([
    page.waitForSelector('a[href*="/services/dentists/"]', { timeout: 15000 }),
    page.waitForSelector(".nhsuk-results, .nhsuk-u-reading-width, main", { timeout: 15000 })
  ]).catch(() => {});
}

async function discoverDetailUrlsWithPlaywright(postcode, radiusMiles) {
  await ensureChromiumInstalled(); // self-heal install if missing

  const browser = await chromium.launch({
    headless: String(process.env.HEADLESS || "true").toLowerCase() !== "false",
    slowMo: Math.max(0, Number(process.env.PW_SLOWMO || "0") || 0)
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
    locale: "en-GB",
    viewport: { width: 1366, height: 900 }
  });
  const page = await context.newPage();

  const urls = new Set();
  try {
    await performSearch(page, postcode, radiusMiles);

    // First page
    let batch = await collectDetailLinksOnPage(page);
    batch.forEach(u => urls.add(u));

    // Try to paginate via visible “Next” controls a few times
    for (let i = 0; i < 8; i++) {
      const next = page.locator(
        [
          'a[rel="next"]',
          'a[aria-label="Next"]',
          'a:has-text("Next")',
          'nav .nhsuk-pagination__link--next',
        ].join(",")
      ).first();

      if ((await next.count()) === 0) break;

      const prevCount = urls.size;
      await next.click({ timeout: 5000 }).catch(() => {});
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(800);

      batch = await collectDetailLinksOnPage(page);
      batch.forEach(u => urls.add(u));

      if (urls.size === prevCount) break; // no progress
    }
  } catch (e) {
    console.log("[PW] discovery error:", e?.message || e);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  console.log(`[DISCOVERY] Playwright collected ${urls.size} detail URL(s).`);
  return Array.from(urls);
}

/* ───────── … to here. ───────── */
