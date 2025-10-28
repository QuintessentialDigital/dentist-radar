// public/app.js — UI↔API compatibility shim for Dentist Radar
(function(){
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function $(id){ return document.getElementById(id); }
  function val(x){ return (x || '').toString().trim(); }
  function show(msgEl, text, ok=true){ if(msgEl){ msgEl.textContent = text; msgEl.style.color = ok ? '' : '#ffd7d7'; } }

  // Find the alert form by id OR by attributes
  const form = $('alertForm') || document.querySelector('form.alert-form, form[data-role="alert"]');
  if(!form) return;

  // Support both IDs and name= fallbacks
  const getField = (id, altSel) => $(id) || form.querySelector(altSel);

  const emailEl    = getField('email',    'input[name="email"], input[type="email"]');
  const postcodeEl = getField('postcode', 'input[name="postcode"]');
  const radiusEl   = getField('radius',   'input[name="radius"], input[type="number"]');
  const msgEl      = $('msg') || form.nextElementSibling;

  form.addEventListener('submit', async (e)=>{
    e.preventDefault();

    const email    = val(emailEl && emailEl.value);
    const postcode = val(postcodeEl && postcodeEl.value);
    const radius   = Number(val((radiusEl && radiusEl.value) || '5')) || 5;

    if(!emailRe.test(email))  return show(msgEl, 'Please enter a valid email.', false);
    if(!postcode)             return show(msgEl, 'Please enter a UK postcode.', false);

    show(msgEl, 'Creating alert…', true);

    try{
      const res = await fetch('/api/watch/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, postcode, radius })
      });
      const j = await res.json().catch(()=>null);

      if(res.status === 402 && j?.error === 'upgrade_required'){
        return show(msgEl, j.message || 'Free plan supports 1 postcode. Upgrade', false);
      }
      if(res.ok && j?.ok){
        form.reset();
        return show(msgEl, j.msg || 'Alert created', true);
      }

      const reason =
        j?.error === 'invalid_postcode' ? 'Please enter a valid UK postcode.' :
        j?.error === 'invalid_email'   ? 'Please enter a valid email.' :
        j?.error || 'Could not create alert. Please try again.';
      show(msgEl, reason, false);

    }catch(err){
      show(msgEl, 'Network error. Please try again.', false);
    }
  });
})();
