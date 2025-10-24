(function(){
  const $ = (id)=>document.getElementById(id);
  const show=(el,msg)=>{ if(!el)return; (typeof msg==='string'?el.textContent=msg:el.innerHTML=msg); el.hidden=false; };
  const hide=(el)=>{ if(!el)return; el.hidden=true; el.textContent=''; el.innerHTML=''; };

  document.addEventListener('DOMContentLoaded', ()=>{
    const f = $('f'); if (f) f.addEventListener('submit', submitForm);
  });

  async function submitForm(e){
    e && e.preventDefault && e.preventDefault();
    const ok = $('ok'), err = $('err'); hide(ok); hide(err);
    const email = $('email').value.trim();
    const postcode = $('postcode').value.trim();
    const radius = Number($('radius').value || 10);
    if(!email || !postcode){ show(err,'Please enter email and postcode(s).'); return false; }
    try{
      const r = await fetch(apiPath('/api/watch'), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ email, postcode, radius_miles: radius }) });
      const txt = await r.text(); let j; try{ j=JSON.parse(txt);}catch{ j=null; }
      if(!r.ok){ show(err,'HTTP '+r.status+': '+(j?.error||txt||'failed')); return false; }
      if(j?.ok){ show(ok,'✅ Alert created! '+(j.created?.length||1)+' area(s). We will email you on changes.'); $('f').reset(); return false; }
      show(err,'❌ '+(j?.error||'failed'));
    }catch(ex){ show(err,'Network error: '+ex.message); }
    return false;
  }

  window.checkout = async function(plan){
    const email = prompt('Enter your email to continue:'); if(!email) return false;
    try{
      const r = await fetch(apiPath('/api/checkout/session'), { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ email, plan }) });
      const j = await r.json(); if(j.ok && j.url){ window.location=j.url; } else { alert('Checkout error: '+(j.error||'failed')); }
    }catch(e){ alert('Network error: '+e.message); }
    return false;
  };
})();