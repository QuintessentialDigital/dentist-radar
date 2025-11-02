// public/app.js — validation + submit (stable)

const form = document.getElementById('alertForm');
const emailEl = document.getElementById('email');
const pcsEl   = document.getElementById('postcodes');
const radiusEl= document.getElementById('radius');
const msgEl   = document.getElementById('message');

const UK_PC_RE = /^(GIR\s?0AA|[A-PR-UWYZ][A-HK-Y]?\d[\dA-Z]?\s?\d[ABD-HJLNP-UW-Z]{2})$/i;

function show(status, text){
  msgEl.className = 'msg ' + status; // 'ok' | 'warn' | 'err'
  msgEl.textContent = text;
  msgEl.style.display = 'block';
}

function validEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((v||'').trim()); }
function parsePCs(v){
  return (v||'').split(/[,;]+/)
    .map(s=>s.trim().toUpperCase().replace(/\s+/g,''))
    .filter(Boolean)
    .map(s => s.length>3 ? (s.slice(0,-3)+' '+s.slice(-3)).toUpperCase() : s);
}
function allValidPCs(list){ return list.every(pc => UK_PC_RE.test(pc)); }

radiusEl.setAttribute('inputmode','numeric');
radiusEl.setAttribute('pattern','\\d*');
radiusEl.setAttribute('min','1');
radiusEl.setAttribute('max','30');

form?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  msgEl.style.display='none';

  const email = (emailEl.value||'').trim();
  const pcs = parsePCs(pcsEl.value);
  const rStr = (radiusEl.value||'').trim();

  if(!validEmail(email)) { show('err','Please enter a valid email address.'); return; }
  if(!pcs.length){ show('err','Please enter at least one UK postcode.'); return; }
  if(!allValidPCs(pcs)) { show('err','One or more postcodes are not valid UK postcodes.'); return; }
  if(!rStr){ show('err','Please choose a radius (1–30 miles).'); return; }
  const r = Number(rStr); if(!(r>=1 && r<=30)){ show('err','Radius must be between 1 and 30 miles.'); return; }

  try{
    const res = await fetch('/api/watch/create',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email, postcode: pcs.join(','), radius: r })
    });
    const j = await res.json();

    if(j.ok){
      form.reset();
      show('ok','Alert created! We’ll email you when availability is found.');
    }else if(j.upgrade){
      show('warn','Free plan allows 1 postcode. Please upgrade to add more.');
    }else{
      show('err', j.error || 'Something went wrong. Please try again.');
    }
  }catch(err){
    show('err','Network error creating alert. Please retry.');
  }
});

// Stripe helper for pricing/upgrade pages (unchanged)
async function startCheckout(plan){
  try{
    const email = (emailEl?.value || '').trim();
    const res = await fetch('/api/checkout',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email: validEmail(email)? email : undefined, plan })
    });
    const j = await res.json();
    if(j.ok && j.url) window.location = j.url;
    else alert(j.error || 'Upgrade failed. Check Stripe keys/prices.');
  }catch(e){ alert('Network error starting checkout.'); }
}
window.startCheckout = startCheckout;
