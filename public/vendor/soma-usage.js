/*!
 * soma-usage.js — SOMA usage standard v1 (2026-09-17)
 * Records that people use a SOMA app, without recording what they do in it.
 * Mike's ruling 2026-09-17: "SOMA apps should record use by users."
 *
 * Embed (same pattern as soma-feedback.js: copy into the site's vendor/ folder, never hotlink):
 *   <script src="/vendor/soma-usage.js" data-app="playmaker"
 *           data-endpoint="https://vps.mike-wolf.com/usage-svc/events" defer></script>
 *
 * API:  SomaUsage.track('play_imported')   named key action (snake_case, at most 40 chars)
 *       SomaUsage.view()                    record a view after an SPA route change
 *       SomaUsage.identify(supabaseUserId)  signed in; the server hashes it with a per-app salt
 *       SomaUsage.optOut() / optIn()        per-browser opt-out
 * Or set window.somaUsageUserId before the script runs.
 *
 * Sent per event: app, kind (session|view|action|error), name, count, uid, signed_in, hour.
 * Never sent: page content, query strings, fragments, titles, referrers, emails.
 * Paths are reduced to a route shape (ids and long tokens become ":id").
 * Do-Not-Track and Global Privacy Control switch it off entirely: nothing is sent.
 * Zero dependencies. Authored 2026-09-17 by Claude Opus 5 (outcomes worker) for Mike Wolf.
 */
(function (root) {
  'use strict';
  var NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
  var APP_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
  var OPT_KEY = 'soma-usage:optout';
  var ANON_KEY = 'soma-usage:anon';
  var SESSION_KEY = 'soma-usage:session';

  function get(kind, k) { try { var s = root[kind]; return s ? s.getItem(k) : null; } catch (e) { return null; } }
  function set(kind, k, v) { try { var s = root[kind]; if (s) { if (v == null) s.removeItem(k); else s.setItem(k, v); } } catch (e) {} }

  // Reduce a URL or path to a route shape: no origin, query, fragment, ids or emails.
  function routeShape(input) {
    var p = String(input || '/');
    p = p.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
    p = p.split('#')[0].split('?')[0] || '/';
    var segs = p.split('/').map(function (s) {
      if (!s) return s;
      try { s = decodeURIComponent(s); } catch (e) {}
      if (/@/.test(s)) return ':id';
      if (/\d{3,}/.test(s) || /^[A-Za-z0-9_-]{20,}$/.test(s) || /^[0-9a-f]{8,}$/i.test(s) || /^[0-9a-f]{8}-/i.test(s)) return ':id';
      if (s.length > 40) return ':id';
      return s.replace(/[^A-Za-z0-9._-]/g, '_');
    });
    var out = segs.join('/');
    if (out.charAt(0) !== '/') out = '/' + out;
    return out.slice(0, 80);
  }

  function coarseHour(date) {
    var d = new Date(date || Date.now());
    d.setUTCMinutes(0, 0, 0);
    return d.toISOString().slice(0, 13) + 'Z';
  }

  function trackingAllowed(nav, win, optedOut) {
    if (optedOut) return false;
    var dnt = (nav && (nav.doNotTrack || nav.msDoNotTrack)) || (win && win.doNotTrack);
    if (dnt === '1' || dnt === 'yes') return false;
    if (nav && nav.globalPrivacyControl === true) return false;
    return true;
  }

  function shapeEvent(app, kind, name, opts) {
    opts = opts || {};
    if (!APP_RE.test(app || '')) return null;
    if (['session', 'view', 'action', 'error'].indexOf(kind) < 0) return null;
    if (kind === 'action' && !NAME_RE.test(name || '')) return null;
    if (kind === 'view') name = routeShape(name);
    if (kind === 'session' || kind === 'error') name = kind;
    var count = kind === 'error' ? Math.max(1, Math.min(1000, Math.floor(opts.count || 1))) : 1;
    var uid = String(opts.userId || opts.anonId || '').slice(0, 64);
    if (uid.length < 8) return null;
    return { app: app, kind: kind, name: name, count: count, uid: uid, signed_in: !!opts.userId, hour: coarseHour(opts.now) };
  }

  var api = { routeShape: routeShape, coarseHour: coarseHour, trackingAllowed: trackingAllowed, shapeEvent: shapeEvent };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  if (!root.document) return;

  var script = root.document.currentScript || root.document.querySelector('script[data-app][src*="soma-usage"]');
  var app = script && script.getAttribute('data-app');
  var endpoint = (script && script.getAttribute('data-endpoint')) || 'https://vps.mike-wolf.com/usage-svc/events';
  var userId = root.somaUsageUserId || null;
  var errors = 0;
  var queue = [];
  var timer = null;

  function allowed() { return trackingAllowed(root.navigator, root, get('localStorage', OPT_KEY) === '1'); }
  function anonId() {
    var id = get('localStorage', ANON_KEY);
    if (!id) {
      id = root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : 'a' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      set('localStorage', ANON_KEY, id);
    }
    return id;
  }
  function flush() {
    timer = null;
    if (!queue.length) return;
    var body = JSON.stringify({ events: queue.splice(0, 20) });
    try {
      // text/plain avoids a CORS preflight; the service parses the JSON body itself.
      if (root.navigator.sendBeacon && root.navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' }))) return;
    } catch (e) {}
    try { root.fetch(endpoint, { method: 'POST', body: body, keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'text/plain' } }).catch(function () {}); } catch (e) {}
  }
  function send(kind, name, opts) {
    if (!app || !allowed()) return false;
    var ev = shapeEvent(app, kind, name, { userId: userId, anonId: anonId(), count: opts && opts.count });
    if (!ev) return false;
    queue.push(ev);
    if (queue.length >= 20) flush(); else if (!timer) timer = setTimeout(flush, 1500);
    return true;
  }

  root.SomaUsage = {
    track: function (name) { return send('action', name); },
    view: function (path) { return send('view', path || root.location.pathname); },
    identify: function (id) { userId = id ? String(id) : null; },
    optOut: function () { set('localStorage', OPT_KEY, '1'); set('localStorage', ANON_KEY, null); queue.length = 0; },
    optIn: function () { set('localStorage', OPT_KEY, null); },
    isEnabled: allowed
  };

  if (!app || !allowed()) return;
  if (!get('sessionStorage', SESSION_KEY)) { set('sessionStorage', SESSION_KEY, '1'); send('session'); }
  send('view', root.location.pathname);
  root.addEventListener('error', function () { errors++; });
  root.addEventListener('unhandledrejection', function () { errors++; });
  root.addEventListener('pagehide', function () {
    if (errors) { send('error', null, { count: errors }); errors = 0; }
    flush();
  });
})(typeof window !== 'undefined' ? window : globalThis);
