// public/app.js — resilient UI↔API binding + mobile nav
(function(){
  const emailRe=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const $ = id => document.getElementById(id);
  const val = x => (x||'').toString().trim();
  const show = (el, text, ok=true) => { if(el){ el.textContent=text; el.style.color = ok ? '' : '#ffd7d7'; } };

  // Menu
  const t=$('menu-toggle'), n=$('nav-links');
  t?.addEventListener('click',()=>n?.classList.toggle('open'));

  // Alert form
  const form = $('alertForm') || document.querySelector('form.alert-form');
  if(form){
    const get = (id,sel)=>$(id)||form.querySelector(sel);
    const emailEl=get('email','input[type="email"],[name="email"]');
    const pcEl=get('postcode','input[name="postcode"]');
    const rEl=get('radius','input[type="number"],[name="radius"]');
    const msg=$('msg')||form.nextElementSibling;

    form.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const email=val(emailEl?.value), postcode=val(pcEl?.value), radius=Number(val(rEl?.value||'5'))||5;

      if(!emailRe.test(email)) return show(msg,'Please enter a valid email.',false);
      if(!postcode) return show(msg,'Please enter a UK postcode.',false);

      show(msg,'Creating alert…',true);
      try{
        const res=await fetch('/api/watch/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,postcode,radius})});
        const j=await res.json().catch(()=>null);

        if(res.status===402 && j?.error==='upgrade_required') return show(msg, j.message || 'Free plan supports 1 postcode. Upgrade', false);
        if(res.ok && j?.ok){ form.reset(); return show(msg, j.msg || 'Alert created — check your inbox.', true); }

        const reason = j?.error==='invalid_postcode' ? 'Please enter a valid UK postcode.' :
                       j?.error==='invalid_email'   ? 'Please enter a valid email.' :
                       j?.error || 'Could not create alert. Please try again.';
        show(msg, reason, false);
      }catch{ show(msg,'Network error. Please try again.',false); }
    });
  }
})();
