// public/app.js — non-UI patch: robust binding + validation + submit
// ✅ No HTML/CSS changes required

(function () {
  // Helper: find element by ID first, else by name
  const $ = (id, name) =>
    document.getElementById(id) || document.querySelector(`[name="${name}"]`);

  // Try common hooks without requiring HTML edits
  const form     = document.getElementById('alertForm') || document.querySelector('form');
  const emailEl  = $('#email', 'email');
  const pcsEl    = $('#postcodes', 'postcodes') || $('#postcode', 'postcode');
  const radiusEl = $('#radius', 'radius');
  const msgEl    = document.getElementById('message');

  // If we can’t bind, surface a console hint (no UI change)
  if (!form || !emailEl || !pcsEl || !radiusEl) {
    console.error('DentistRadar: missing form/fields. Expected IDs or names: alertForm, email, postcodes, radius');
    return;
  }

  // Mobile-friendly numeric input (no visual change)
  radiusEl.setAttribute('inputmode','numeric');
  radiusEl.setAttribute('pattern','\\d*');
  if (!radiusEl.getAttribute('min')) radiusEl.setAttribute('min','1');
  if (!radiusEl.getAttribute('max')) radiusEl.setAttribute('max','30');

  const UK_PC_RE = /^(GIR\s?0AA|[A-PR-UWYZ][A-HK-Y]?\d[\dA-Z]?\s?\d[ABD-HJLNP-UW-Z]{2})$/i;
  const validEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v||'').trim());

  const parsePCs = v => (v||'')
    .split(/[,;]+/)
    .map(s=>s.trim().toUpperCase().replace(/\s+/g,''))
    .filter(Boolean)
    .map(s => s.length>3 ? (s.slice(0,-3)+' '+s.slice(-3)).toUpperCase() : s);

  const allValidPCs = list => list.every(pc => UK_PC_RE.test(pc));

  function show(status, text){
    if (msgEl) {
      msgEl.className = 'msg ' + status; // ok | warn | err
      msgEl.textContent = text;
      msgEl.style.display = 'block';
    } else {
      // fallback without UI change
      if (status === 'ok') console.log(text);
      else alert(text);
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (msgEl) msgEl.style.display = 'none';

    const email = (emailEl.value||'').trim();
    const pcs   = parsePCs(pcsEl.value);
    const rStr  = (radiusEl.value||'').trim();

    if(!validEmail(email))                return show('err','Please enter a valid email address.');
    if(!pcs.length)                       return show('err','Please enter at least one UK postcode.');
    if(!allValidPCs(pcs))                 return show('err','One or more postcodes are not valid UK postcodes.');
    if(!rStr)                             return show('err','Please choose a radius (1–30 miles).');
    const r = Number(rStr);
    if(!(r>=1 && r<=30))                  return show('err','Radius must be between 1 and 30 miles.');

    try {
      const res = await fetch('/api/watch/create', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ email, postcode: pcs.join(','), radius: r })
      });

      let j = {};
      try { j = await res.json(); } catch { j = { ok:false, error:'Unexpected server response' }; }

      if (j.ok) {
        form.reset();
        show('ok','Alert created! We’ll email you when availability is found.');
      } else if (j.upgrade) {
        show('warn','Free plan allows 1 postcode. Please upgrade to add more.');
      } else {
        show('err', j.error || 'Something went wrong. Please try again.');
      }
    } catch (err) {
      console.error('submit error', err);
      show('err','Network error creating alert. Please retry.');
    }
  });

  // Catch silent JS errors so submit never "does nothing"
  window.addEventListener('error', e => console.error('JS error:', e.message));
  window.addEventListener('unhandledrejection', e => console.error('Promise rejection:', e.reason));
})();
