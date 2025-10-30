(function(){
  const $ = id => document.getElementById(id);
  const form = $('alertForm');
  const msg = $('msg');
  const radiusInput = $('radius');
  const postcodeInput = $('postcode');
  const emailInput = $('email');

  // mobile menu
  const toggle=$('menu-toggle'), links=$('nav-links');
  toggle?.addEventListener('click',()=>links?.classList.toggle('open'));
  links?.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>links.classList.remove('open')));

  function showMessage(text, type=''){ msg.innerHTML = text; msg.className = `message ${type}`; }

  // guard: radius max 30 (front-end)
  radiusInput?.addEventListener('input', () => {
    const n = parseInt(radiusInput.value || '0', 10);
    if (n > 30) {
      radiusInput.value = 30;
      showMessage('Maximum radius is 30 miles.', 'warn');
    } else if (n < 0) {
      radiusInput.value = '';
    }
  });

  // basic normalisers
  postcodeInput?.addEventListener('blur', ()=>{
    const raw = (postcodeInput.value||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    if(raw.length>=5){
      const head = raw.slice(0, raw.length-3);
      const tail = raw.slice(-3);
      postcodeInput.value = `${head} ${tail}`.replace(/\s+/g,' ').trim();
    } else {
      postcodeInput.value = (postcodeInput.value||'').toUpperCase().trim();
    }
  });
  emailInput?.addEventListener('blur', ()=>{
    const t=(emailInput.value||'').trim();
    const parts=t.split('@');
    emailInput.value = (parts.length===2) ? parts[0]+'@'+parts[1].toLowerCase() : t;
  });

  form?.addEventListener('submit', async (e)=>{
    e.preventDefault();
    showMessage('Saving your alert…');

    const payload = {
      email: emailInput.value.trim(),
      postcode: postcodeInput.value.trim(),
      radius: radiusInput.value.trim()
    };

    try{
      const res = await fetch('/api/watch/create', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (data.ok) {
        showMessage('✅ Alert created — check your inbox!', 'success');
        form.reset(); // leaves radius blank again
        return;
      }
      if (data.error === 'duplicate') {
        showMessage('⚠ An alert already exists for this postcode.', 'warn');
        return;
      }
      if (data.error === 'upgrade_required') {
        const link = data.upgradeLink || '/pricing.html';
        showMessage(`⚡ Free plan supports one postcode only. <a href="${link}">Upgrade to Pro</a> to add more.`, 'warn');
        return;
      }
      if (data.error === 'invalid_email') {
        showMessage('❌ Please enter a valid email address.', 'error'); return;
      }
      if (data.error === 'invalid_postcode') {
        showMessage('❌ Please enter a valid UK postcode.', 'error'); return;
      }
      if (data.error === 'invalid_radius') {
        showMessage('❌ Please enter a radius between 1 and 30 miles.', 'error'); return;
      }
      showMessage('⚠ Something went wrong. Please try again later.', 'error');
    }catch(err){
      console.error(err);
      showMessage('⚠ Server unavailable. Please retry.', 'error');
    }
  });
})();
