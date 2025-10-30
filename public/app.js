(function(){
  const $ = id => document.getElementById(id);
  const form = $('alertForm');
  const msg  = $('msg');
  const toggle = $('menu-toggle');
  const links  = $('nav-links');
  const radius = $('radius');

  // Mobile menu toggle (works on every page)
  toggle?.addEventListener('click',()=>links?.classList.toggle('open'));
  links?.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>links.classList.remove('open')));

  // numeric-only radius
  radius?.addEventListener('input', e=>{
    e.target.value = e.target.value.replace(/[^0-9]/g,'');
  });

  function showMessage(text, type=''){
    if(!msg) return;
    msg.textContent = '';         // clear
    msg.removeAttribute('style'); // ensure visible
    msg.className = `message-box ${type}`;
    msg.innerHTML = text;
  }

  form?.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const email    = form.email.value.trim();
    const postcode = form.postcode.value.trim();
    const r        = form.radius.value.trim();

    if(!email || !postcode || !r){
      showMessage('⚠ Please fill in all fields, including radius.','warn');
      return;
    }
    const n = parseInt(r,10);
    if(isNaN(n) || n<1 || n>30){
      showMessage('⚠ Please select a radius between 1 and 30 miles.','warn');
      return;
    }

    showMessage('Saving your alert…');

    try{
      const res = await fetch('/api/watch/create',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ email, postcode, radius:r })
      });
      const data = await res.json();

      if(data.ok){
        showMessage('✅ Alert created — check your inbox!','success');
        form.reset();
        return;
      }
      if(data.error==='duplicate'){
        showMessage('⚠ An alert already exists for this postcode.','warn'); return;
      }
      if(data.error==='upgrade_required'){
        const link = data.upgradeLink || '/pricing.html';
        showMessage(`⚡ Free plan supports one postcode. <a href="${link}">Upgrade to Pro</a> to add more.`,'warn'); return;
      }
      if(data.error==='invalid_radius'){
        showMessage('⚠ Please select a valid radius (1–30 miles).','warn'); return;
      }
      showMessage('⚠ Something went wrong. Please try again later.','error');
    }catch(err){
      console.error(err);
      showMessage('⚠ Server unavailable. Please retry.','error');
    }
  });
})();
