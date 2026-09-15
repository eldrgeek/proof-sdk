// Only diagnostic fields are read. Never serialize errors, events, editor state,
// DOM text, Yjs updates, or console argument lists into an error report.
(function () {
  var config = window.PROOF_CLIENT_ERRORS;
  if (!config) return;
  var sent = 0;
  var pending = new Map();
  function clean(text) {
    return String(text || '').replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s<>"'`]+/gi, function (url) { return url.split(/[?#]/)[0]; });
  }
  function report(message, stack) {
    message = clean(message).slice(0, 500);
    // Omit the stack's duplicated message and retain only actual stack frames.
    stack = clean(stack).split('\n').filter(function (line) { return /^\s*at\s|@(?:https?:|\/)/.test(line); }).join('\n').slice(0, 4096);
    var key = message + '\n' + stack;
    if (pending.has(key)) return pending.get(key);
    if (sent >= 5) return Promise.resolve(false);
    sent++;
    var promise = fetch('/api/client-error', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message, stack: stack, url: location.origin + location.pathname,
        page: location.pathname, build: config.build, userAgent: navigator.userAgent, area: config.area }),
      keepalive: true
    }).then(function (response) {
      return response.json().then(function (body) { return response.ok && body.accepted === true; });
    }).catch(function () { return false; });
    pending.set(key, promise);
    return promise;
  }
  window.proofReportClientError = report;
  window.addEventListener('error', function (event) {
    if (event.message) report(event.message, event.error && event.error.stack);
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    report(reason && typeof reason.message === 'string' ? reason.message : typeof reason === 'string' ? reason : 'Unhandled promise rejection', reason && reason.stack);
  });
  var originalError = console.error;
  console.error = function () {
    originalError.apply(console, arguments);
    if (arguments[0] !== 'Caught error while handling a Yjs update') return;
    var error = arguments[1];
    var message = 'Caught error while handling a Yjs update' + (error && typeof error.message === 'string' ? ': ' + error.message : '');
    var banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:red;color:white;padding:10px;z-index:999999;font-family:monospace;font-size:12px;cursor:pointer;';
    banner.textContent = 'JS Error: ' + message + ' (click to dismiss)';
    banner.onclick = function () { banner.remove(); };
    if (document.body) document.body.appendChild(banner);
    report(message, error && error.stack).then(function (accepted) {
      if (accepted) banner.append(' Reported to the builder.');
    });
  };
})();
