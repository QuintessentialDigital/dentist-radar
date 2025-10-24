(function(){
  function byId(id){ return document.getElementById(id); }
  function show(el, msg){ if(typeof msg==='string') el.textContent = msg; else el.innerHTML = msg; el.style.display='block'; }
  function hide(el){ el.style.display='none'; el.textContent=''; el.innerHTML=''; }

  function bind(){ const f = byId('f'); if (f) f.addEventListener('submit', DR_submit); }
  document.addEventListener('DOMContentLoaded', bind);

  window.DR_submit = async function(e){
    if (e && e.preventDefault) e.preventDefault();
    const ok = byId('ok'); const err = byId('err'); const upsell = byId('upsell');
    [ok,err,upsell].forEach(x=> x && hide(x));
    const email = byId('email').value.trim();
    const postcode = byId('postcode').value.trim();
    const radius = Number(byId('radius').value||10);
    if(!email || !postcode){ show(err,'Please enter email and postcode(s).'); return false; }
    try{
      console.log('[DR] POST', apiPath('/api/watch'));
      const r = await fetch(apiPath('/api/watch'), {
        method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ email, postcode, radius_miles: radius })
      });
      const txt = await r.text(); let j; try{ j = JSON.parse(txt);}catch(e){ j=null; }
      if(!r.ok){ show(err, 'HTTP '+r.status+': '+(j?.error || txt || 'failed')); return false; }
      if(j && j.ok){
        show(ok, '✅ Alert created! '+(j.created?.length||1)+' area(s). We’ll email you on changes.');
        if (upsell && j.upgrade_needed){ show(upsell, 'Add more areas with <a href="/pricing.html">Pro</a>.'); }
        byId('f').reset(); return false;
      }
      show(err, '❌ ' + (j?.error || 'failed'));
    }catch(ex){ show(err, 'Network error: ' + ex.message); }
    return false;
  };

  window.checkout = async function(plan){
    const email = prompt('Enter your email to continue:');
    if(!email) return false;
    try{
      const r = await fetch(apiPath('/api/checkout/session'), {
        method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ email, plan })
      });
      const j = await r.json();
      if (j.ok && j.url) { window.location = j.url; }
      else { alert('Could not start checkout: ' + (j.error || 'failed')); }
    }catch(e){ alert('Network error: ' + e.message); }
    return false;
  };
})();