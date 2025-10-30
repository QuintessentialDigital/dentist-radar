(function(){
const $=id=>document.getElementById(id);
const form=$('alertForm'),msgBox=$('msg');

function showMessage(t,type=''){msgBox.innerHTML=t;msgBox.className=`message-box ${type}`;}

form?.addEventListener('submit',async e=>{
 e.preventDefault();
 const email=form.email.value.trim();
 const postcode=form.postcode.value.trim();
 const radius=form.radius.value.trim();

 if(!email||!postcode||!radius){showMessage('⚠ Please fill in all fields, including radius.','warn');return;}
 const n=parseInt(radius,10);
 if(isNaN(n)||n<1||n>30){showMessage('⚠ Please select a radius between 1 and 30 miles.','warn');return;}

 showMessage('Saving your alert…');

 try{
   const r=await fetch('/api/watch/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,postcode,radius})});
   const d=await r.json();
   if(d.ok){showMessage('✅ Alert created — check your inbox!','success');form.reset();return;}
   if(d.error==='duplicate'){showMessage('⚠ An alert already exists for this postcode.','warn');return;}
   if(d.error==='upgrade_required'){showMessage(`⚡ Free plan supports one postcode. <a href="${d.upgradeLink||'/pricing.html'}">Upgrade to Pro</a> to add more.`,'warn');return;}
   if(d.error==='invalid_radius'){showMessage('⚠ Please select a valid radius (1–30 miles).','warn');return;}
   showMessage('⚠ Something went wrong. Please try again later.','error');
 }catch(err){console.error(err);showMessage('⚠ Server unavailable. Please retry.','error');}
});
})();
