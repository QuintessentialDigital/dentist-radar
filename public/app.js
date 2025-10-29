// public/app.js — strict mobile guards + resilient UI↔API binding
(function(){
  const emailRe=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  const $ = id => document.getElementById(id);
  const val = x => (x||'').toString().trim();
  const show = (el, text, ok=true) => { if(el){ el.textContent=text; el.style.color = ok ? '' : '#ffd7d7'; } };

  // Mobile menu open/close + close after tap
  const toggle=$('menu-toggle'), links=$('nav-links');
  toggle?.addEventListener('click',()=>links?.classList.toggle('open'));
  links?.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>links.classList.remove('open')));

  // Elements
  const form = $('alertForm') || document.querySelector('form.alert-form');
  const emailEl=$('email'), pcEl=$('postcode'), rEl=$('radius');
  const msg=$('msg')|| (form && form.nextElementSibling);

  // Radius: digits only; clamp 1–50
  if(rEl){
    rEl.addEventListener('input', ()=>{ rEl.value = (rEl.value||'').replace(/\D+/g,''); });
    rEl.addEventListener('blur', ()=>{
      let n = parseInt(rEl.value||'5',10); if(isNaN(n)) n=5;
      n=Math.max(1,Math.min(50,n)); rEl.value=String(n);
    });
  }

  // Postcode: uppercase + normalise “OUTWARD INWARD”
  function normalizePostcode(raw){
    const t=(raw||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    if(t.length<5) return (raw||'').toUpperCase().trim();
    const head=t.slice(0,t.length-3), tail=t.slice(-3);
    return `${head} ${tail}`.replace(/\s+/g,' ').trim();
  }
  function looksLikeUkPostcode(pc){
    return /^([A-Z]{1,2}\d[A-Z\d]?)\s?\d[A-Z]{2}$/i.test((pc||'').toUpperCase());
  }
  if(pcEl){
    pcEl.addEventListener('input', ()=>{
      pcEl.value = pcEl.value.toUpperCase().replace(/[^A-Z0-9 ]/g,'').replace(/\s+/g,' ');
    });
    pcEl.addEventListener('blur', ()=>{ pcEl.value = normalizePostcode(pcEl.value); });
  }

  // Email: trim and lower-case domain on blur
  if(emailEl){
    emailEl.addEventListener('blur', ()=>{
      const t=(emailEl.value||'').trim();
      const parts=t.split('@');
      emailEl.value = (parts.length===2) ? parts[0]+'@'+parts[1].toLowerCase() : t;
    });
  }

  // Submit
  if(form){
    form.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const email=val(emailEl?.value);
      const postcode=normalizePostcode(val(pcEl?.value));
      const radius=Number(val(rEl?.value||'5'))||5;

      if(!emailRe.test(email)) return show(msg,'Please enter a valid email.',false);
      if(!looksLikeUkPostcode(postcode)) return show(msg,'Please enter a valid UK postcode.',false);
      if(!(radius>=1 && radius<=50)) return show(msg,'Radius must be between 1 and 50 miles.',false);

      show(msg,'Creating alert…',true);

      try{
        const res=await fetch('/api/watch/create',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({email,postcode,radius})
        });
        const j=await res.json().catch(()=>null);

        if(res.status===402 && j?.error==='upgrade_required')
          return show(msg, j.message || 'Free plan supports 1 postcode. Upgrade', false);

        if(res.ok && j?.ok){
          form.reset(); if(rEl) rEl.value='5';
          return show(msg, j.msg || 'Alert created — check your inbox.', true);
        }

        const reason = j?.error==='invalid_postcode' ? 'Please enter a valid UK postcode.' :
                       j?.error==='invalid_email'   ? 'Please enter a valid email.' :
                       j?.error || 'Could not create alert. Please try again.';
        show(msg, reason, false);
      }catch{
        show(msg,'Network error. Please try again.',false);
      }
    });
  }
})();
