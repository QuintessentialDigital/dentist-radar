// Replace only this inside /api/watch/create in your server.js

app.post('/api/watch/create', async (req, res) => {
  try {
    const emailKey = normEmail(req.body?.email);
    const pc = normalizePostcode(req.body?.postcode || '');
    let rNum = Number(req.body?.radius);

    if (!emailRe.test(emailKey)) return res.status(400).json({ ok:false, error:'invalid_email' });
    if (!looksLikeUkPostcode(pc)) return res.status(400).json({ ok:false, error:'invalid_postcode' });

    // 👇 reject empty or invalid radius
    if (!rNum || isNaN(rNum)) {
      return res.status(400).json({ ok:false, error:'invalid_radius', message:'Please select a radius between 1 and 30 miles.' });
    }

    const r = Math.max(1, Math.min(30, rNum));

    const dup = await watches.findOne({ email: emailKey, postcode: pc });
    if (dup) {
      return res.status(400).json({ ok:false, error:'duplicate', msg:'An alert already exists for this postcode.' });
    }

    const existingCount = await watches.countDocuments({ email: emailKey });
    if (existingCount >= 1) {
      return res.status(402).json({
        ok: false, error: 'upgrade_required',
        message: 'Free plan supports one postcode. Upgrade to Pro to add more alerts.',
        upgradeLink: '/pricing.html'
      });
    }

    await watches.insertOne({ email: emailKey, postcode: pc, radius: r, createdAt: new Date() });
    const subject = `Dentist Radar — alerts enabled for ${pc}`;
    const body = [
      `Thanks for joining Dentist Radar!`,
      ``,
      `We'll email you when NHS dentists within ${r} miles of ${pc} start accepting patients.`,
      ``,
      `You can remove or update your alert anytime.`,
      ``,
      `— Dentist Radar`
    ].join('\n');
    const mail = await sendEmail(emailKey, subject, body);
    try {
      await alerts.insertOne({
        kind: 'welcome', email: emailKey, postcode: pc, radius: r,
        status: mail?.ok ? 'sent' : 'skipped_or_failed', provider: 'postmark', createdAt: new Date()
      });
    } catch {}
    return res.json({ ok:true, msg:'✅ Alert created — check your inbox.' });
  } catch (err) {
    console.error('Create watch error:', err);
    return res.status(500).json({ ok:false, error:'server_error' });
  }
});
