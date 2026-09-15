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
