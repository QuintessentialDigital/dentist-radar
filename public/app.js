const form = document.getElementById('alert-form');
const msg = document.getElementById('message');
const menuToggle = document.getElementById('menu-toggle');
const navLinks = document.getElementById('nav-links');

menuToggle?.addEventListener('click', ()=> navLinks.classList.toggle('open'));

form?.addEventListener('submit', async (e)=>{
  e.preventDefault();
  msg.textContent = 'Submitting...';
  const email = document.getElementById('email').value.trim();
  const postcodes = document.getElementById('postcodes').value.trim();
  const radius = document.getElementById('radius').value.trim();

  const res = await fetch('/api/watch/create', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ email, postcodes, radius })
  });
  const data = await res.json();
  if (data.ok) {
    msg.textContent = '✅ Alert created successfully!';
    form.reset();
  } else if (data.error === 'invalid_email') {
    msg.textContent = '❌ Please enter a valid email.';
  } else if (data.error === 'invalid_postcode') {
    msg.textContent = '❌ Invalid postcode format.';
  } else if (data.error === 'upgrade_required') {
    msg.textContent = '⚡ Free plan allows one postcode. Upgrade for more.';
  } else if (data.error === 'duplicate') {
    msg.textContent = 'ℹ️ Alert already exists.';
  } else {
    msg.textContent = '❌ Error creating alert. Try again.';
  }
});
