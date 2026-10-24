(function () {
  var message = document.getElementById('soma-message');
  var switchAccount = document.getElementById('soma-switch');
  var signedOut = new URLSearchParams(location.search).has('signedout');
  var exchanging = false;
  var refreshTimer;
  function scheduleRefresh(delay) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async function () {
      try {
        var result = await SomaAuth.getSession();
        await exchange(result.data && result.data.session);
      } catch (_) { scheduleRefresh(60000); }
    }, Math.max(1000, delay));
  }
  function say(text) { if (message) message.textContent = text; }
  // A same-site document path saved in the last 30 minutes, used once.
  function returnPath() {
    try {
      var saved = JSON.parse(localStorage.getItem('proof:return-to') || 'null');
      localStorage.removeItem('proof:return-to');
      if (!saved || typeof saved.path !== 'string' || Date.now() - Number(saved.at) > 30 * 60 * 1000) return null;
      return /^\/d\/[A-Za-z0-9_-]+(?:[?#][^\s]*)?$/.test(saved.path) ? saved.path : null;
    } catch (_) { return null; }
  }
  async function exchange(session) {
    if (!session || exchanging || signedOut) return;
    exchanging = true;
    try {
      var response = await fetch('/library/api/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: session.access_token })
      });
      var result = await response.json();
      if (!response.ok) {
        say(result.message || 'Could not sign you in. Please try again.');
        if (switchAccount) switchAccount.hidden = false;
        if (response.status >= 500 || response.status === 429) scheduleRefresh(60000);
        return;
      }
      scheduleRefresh(result.refreshAfterMs || 24 * 60 * 60 * 1000);
      // A document page re-reads what the renewed session may do (Owner rights come from it).
      try { window.dispatchEvent(new CustomEvent('proof:soma-session', { detail: { isAdmin: Boolean(result.isAdmin) } })); } catch (_) {}
      // Proof Documents Step B6: a document page's "Sign in" link stores where to come back to.
      var back = message ? returnPath() : null;
      if (back && message) { location.replace(back); return; }
      if (message || (document.body.dataset.soma === '1' &&
          (document.body.dataset.owner === '1') !== result.isAdmin)) location.replace('/');
    } catch (_) { say('Sign-in is unavailable. Please try again later.'); scheduleRefresh(60000); }
    finally { exchanging = false; }
  }
  if (!window.SomaAuth) { say('Sign-in is unavailable. Please reload to try again.'); return; }
  SomaAuth.onAuthStateChange(function (event, session) {
    if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
      // Leave the Supabase auth callback before making asynchronous auth calls.
      setTimeout(function () { exchange(session); }, 0);
    }
  });
  SomaAuth.init();
  if (!window.supabase || !window.SOMA_AUTH_CONFIG.url || !window.SOMA_AUTH_CONFIG.anonKey) say('Sign-in is unavailable. Please try again later.');
  if (signedOut) say('You’re signed out.');
  var google = document.getElementById('soma-google');
  if (google) google.addEventListener('click', async function () {
    var result = await SomaAuth.signInWithOAuth('google', { redirectTo: location.origin + '/' });
    if (result.error) say(result.error.message);
  });
  var form = document.getElementById('soma-email-form');
  if (form) form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var result = await SomaAuth.signInWithOtp(document.getElementById('soma-email').value, { emailRedirectTo: location.origin + '/' });
    say(result.error ? result.error.message : 'Check your email for your sign-in link.');
  });
  if (switchAccount) switchAccount.addEventListener('click', async function () {
    await SomaAuth.signOut(); location.replace('/?signedout=1');
  });
})();
