(() => {
  const $ = id => document.getElementById(id);
  let mode = 'login';
  function setMode(m) {
    mode = m;
    const signup = m === 'signup';
    $('lede').textContent = signup ? 'Create your journal. Use at least 10 characters for the password.' : 'Sign in to your journal.';
    $('submitBtn').textContent = signup ? 'Create account' : 'Sign in';
    $('switchText').textContent = signup ? 'Already have an account?' : 'New here?';
    $('switchBtn').textContent = signup ? 'Sign in' : 'Create an account';
    $('password').autocomplete = signup ? 'new-password' : 'current-password';
    $('err').textContent = '';
  }
  $('switchBtn').addEventListener('click', () => setMode(mode === 'login' ? 'signup' : 'login'));
  fetch('/api/auth/config').then(r => r.json()).then(c => { if (!c.signups) $('switchRow').hidden = true; }).catch(() => {});

  $('authForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('submitBtn');
    btn.disabled = true; $('err').textContent = '';
    try {
      const res = await fetch(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify({ email: $('email').value, password: $('password').value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
      location.href = '/app';
    } catch (err) {
      $('err').textContent = err.message;
    } finally { btn.disabled = false; }
  });
})();
