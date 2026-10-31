/*!
 * soma-usage.js — SOMA usage standard v1.1 (2026-09-17)
 * Records that people use a SOMA app, without recording what they do in it.
 * Mike's ruling 2026-09-17: "SOMA apps should record use by users."
 *
 * Embed (same pattern as soma-feedback.js: copy into the site's vendor/ folder, never hotlink):
 *   <script src="/vendor/soma-usage.js" data-app="playmaker"
 *           data-endpoint="https://vps.mike-wolf.com/usage-svc/events" defer></script>
 *
 * API:  SomaUsage.track('play_imported')   named key action (snake_case, at most 40 chars)
 *       SomaUsage.view()                    count a view after an SPA route change (no path is sent)
 *       SomaUsage.identify(supabaseUserId)  signed in; the server hashes it with a per-app salt
 *       SomaUsage.optOut() / optIn()        per-browser opt-out
 *       SomaUsage.renderNotice(container)   render the notice line with its off/on toggle into container
 *                                           (nothing is rendered unless the app calls this; put it next to
 *                                           the feedback chip or in the footer)
 *   Or, with no script of your own (strict CSP): <div data-soma-usage-notice></div> is filled on load.
 * Or set window.somaUsageUserId before the script runs.
 *
 * Sent per event: app, kind (session|view|action|error), name, count, uid, signed_in, hour.
 * Never sent: page content, page paths, query strings, fragments, titles, referrers, emails.
 * A view is counted as the name "view"; the page it happened on is not sent (v1.1, Locke review).
 * A user id containing "@" is refused, so nothing is sent for it.
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

  var NOTICE_TEXT = "This site counts visits and a few actions to see whether it's useful. We don't record what you write, your email or your IP address.";

  // What the notice line says in each state. Pure, so it can be tested without a DOM.
  function noticeModel(nav, win, optedOut) {
    if (!trackingAllowed(nav, win, false)) return { text: "Your browser asks sites not to track you, so this site counts nothing.", toggle: null };
    if (optedOut) return { text: 'Usage counting is off in this browser.', toggle: 'Turn it back on.' };
    return { text: NOTICE_TEXT, toggle: 'Turn it off.' };
  }

  function shapeEvent(app, kind, name, opts) {
    opts = opts || {};
    if (!APP_RE.test(app || '')) return null;
    if (['session', 'view', 'action', 'error'].indexOf(kind) < 0) return null;
    if (kind === 'action' && !NAME_RE.test(name || '')) return null;
    if (kind === 'session' || kind === 'error' || kind === 'view') name = kind;
    var count = kind === 'error' ? Math.max(1, Math.min(1000, Math.floor(opts.count || 1))) : 1;
    var uid = String(opts.userId || opts.anonId || '').slice(0, 64);
    if (uid.length < 8) return null;
    if (/@/.test(uid)) return null; // an email is never an id
    return { app: app, kind: kind, name: name, count: count, uid: uid, signed_in: !!opts.userId, hour: coarseHour(opts.now) };
  }

  var api = { coarseHour: coarseHour, trackingAllowed: trackingAllowed, shapeEvent: shapeEvent, noticeModel: noticeModel, NOTICE_TEXT: NOTICE_TEXT };
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

  var notices = [];
  function paintNotice(el) {
    var doc = root.document;
    var m = noticeModel(root.navigator, root, get('localStorage', OPT_KEY) === '1');
    while (el.firstChild) el.removeChild(el.firstChild);
    el.appendChild(doc.createTextNode(m.text));
    if (!m.toggle) return;
    el.appendChild(doc.createTextNode(' '));
    var b = doc.createElement('button');
    b.type = 'button';
    b.className = 'soma-usage-toggle';
    b.textContent = m.toggle;
    b.setAttribute('style', 'font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;text-decoration:underline;cursor:pointer');
    b.addEventListener('click', function () {
      if (get('localStorage', OPT_KEY) === '1') root.SomaUsage.optIn(); else root.SomaUsage.optOut();
      var btn = el.querySelector('.soma-usage-toggle');
      if (btn) btn.focus();
    });
    el.appendChild(b);
  }
  function repaintNotices() { for (var i = 0; i < notices.length; i++) paintNotice(notices[i]); }

  root.SomaUsage = {
    track: function (name) { return send('action', name); },
    view: function () { return send('view'); },
    identify: function (id) { userId = id ? String(id) : null; },
    optOut: function () {
      set('localStorage', OPT_KEY, '1'); set('localStorage', ANON_KEY, null);
      queue.length = 0; if (timer) { clearTimeout(timer); timer = null; }
      repaintNotices();
    },
    optIn: function () { set('localStorage', OPT_KEY, null); repaintNotices(); },
    isEnabled: allowed,
    // Render the notice line into container (an element or a CSS selector). Returns the line, or null.
    renderNotice: function (container) {
      var doc = root.document;
      var host = typeof container === 'string' ? doc.querySelector(container) : container;
      if (!host) return null;
      var el = doc.createElement('p');
      el.className = 'soma-usage-notice';
      el.setAttribute('style', 'margin:0;font-size:12px;line-height:1.4;opacity:.75');
      notices.push(el);
      paintNotice(el);
      host.appendChild(el);
      return el;
    }
  };

  // Declarative form for pages whose CSP forbids inline scripts. The notice renders even when counting is off,
  // so the switch to turn it back on stays reachable.
  function mountDeclared() {
    var els = root.document.querySelectorAll('[data-soma-usage-notice]');
    for (var i = 0; i < els.length; i++) {
      if (els[i].getAttribute('data-soma-usage-mounted')) continue;
      els[i].setAttribute('data-soma-usage-mounted', '1');
      root.SomaUsage.renderNotice(els[i]);
    }
  }
  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', mountDeclared); else mountDeclared();

  if (!app || !allowed()) return;
  if (!get('sessionStorage', SESSION_KEY)) { set('sessionStorage', SESSION_KEY, '1'); send('session'); }
  send('view');
  root.addEventListener('error', function () { errors++; });
  root.addEventListener('unhandledrejection', function () { errors++; });
  root.addEventListener('pagehide', function () {
    if (errors) { send('error', null, { count: errors }); errors = 0; }
    flush();
  });
})(typeof window !== 'undefined' ? window : globalThis);
