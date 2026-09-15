import type { Request, Response } from 'express';
import { getLibrarySession } from './auth.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const sharedHead = `
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Documents · Proof</title>
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png?v=20260310r">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png?v=20260310r">
  <link rel="shortcut icon" href="/favicon.ico?v=20260310r">
  <script>
    try { if (localStorage.getItem('proof-theme') === 'dark') document.documentElement.dataset.theme = 'dark'; } catch {}
  </script>
  <style>
    :root{color-scheme:light;--bg:#fff;--text:#111;--muted:#6b6b6b;--soft:#f4f4f2;--line:#e7e7e4;--hover:#fafaf8;--shadow:0 18px 60px rgba(0,0,0,.13);--font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
    @media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#111;--text:#f5f5f5;--muted:#aaa;--soft:#202020;--line:#303030;--hover:#181818;--shadow:0 18px 60px rgba(0,0,0,.5)}}
    :root[data-theme="dark"]{color-scheme:dark;--bg:#111;--text:#f5f5f5;--muted:#aaa;--soft:#202020;--line:#303030;--hover:#181818;--shadow:0 18px 60px rgba(0,0,0,.5)}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);-webkit-font-smoothing:antialiased}button,input,textarea,select{font:inherit;color:inherit}button,a{touch-action:manipulation}
    .shell{width:min(920px,calc(100% - 48px));margin:0 auto}.topbar{position:sticky;top:16px;z-index:20;margin:16px auto 72px;min-height:58px;padding:7px 9px 7px 20px;border:1px solid var(--line);border-radius:999px;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(16px);display:flex;align-items:center;justify-content:space-between;box-shadow:0 4px 18px rgba(0,0,0,.05)}.wordmark{font-size:15px;font-weight:700;letter-spacing:-.3px}.header-actions{display:flex;align-items:center;gap:8px}
    .btn{border:1px solid var(--line);background:var(--bg);border-radius:999px;min-height:44px;padding:0 17px;cursor:pointer;font-weight:600}.btn:hover{background:var(--soft)}.btn.primary{border-color:#111;background:#111;color:#fff}.btn.primary:hover{background:#333}.btn.quiet{border-color:transparent;background:transparent}.icon-btn{width:44px;height:44px;padding:0;display:grid;place-items:center}.avatar{border:0;background:#e7ff69;color:#111;font-weight:750}.menu-wrap{position:relative}.menu{position:absolute;right:0;top:52px;width:250px;padding:8px;border:1px solid var(--line);border-radius:16px;background:var(--bg);box-shadow:var(--shadow)}.menu[hidden]{display:none}.menu-name{padding:10px 12px;color:var(--muted);font-size:13px}.menu button{display:block;width:100%;min-height:44px;padding:0 12px;border:0;border-radius:10px;background:none;text-align:left;cursor:pointer}.menu button:hover{background:var(--soft)}
    .title-row{display:flex;align-items:baseline;gap:10px;margin-bottom:28px}.title-row h1{font-size:38px;line-height:1;letter-spacing:-1.5px;margin:0}.count{color:var(--muted)}.controls{display:grid;gap:16px;margin-bottom:22px}.search-sort{display:flex;gap:12px}.search{flex:1;min-height:48px;border:1px solid var(--line);border-radius:14px;background:var(--bg);padding:0 16px;outline:none}.search:focus{border-color:var(--text)}select{min-height:48px;border:1px solid var(--line);border-radius:14px;background:var(--bg);padding:0 38px 0 14px}.chips{display:flex;gap:8px;overflow:auto;padding-bottom:2px}.chip{white-space:nowrap;border:1px solid var(--line);background:var(--bg);border-radius:999px;min-height:38px;padding:0 13px;cursor:pointer}.chip[aria-pressed="true"]{background:var(--text);border-color:var(--text);color:var(--bg)}
    .document-list{list-style:none;padding:0;margin:0;border-top:1px solid var(--line)}.document-row{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:20px;align-items:center;min-height:96px;padding:17px 4px;border-bottom:1px solid var(--line);cursor:pointer}.document-row:hover{background:var(--hover)}.document-row.keyboard-focus{outline:2px solid #7c3aed;outline-offset:3px;border-radius:10px}.doc-title{display:inline;color:inherit;text-decoration:none;font-size:16px;font-weight:550;line-height:1.35}.doc-title.unread{font-weight:750}.changed-dot{display:inline-block;width:7px;height:7px;margin-left:7px;border-radius:50%;background:#7c3aed;vertical-align:middle}.metadata{display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin-top:6px;color:var(--muted);font-size:13px}.signal{display:inline-flex;align-items:center;min-height:24px;padding:0 8px;border-radius:999px;background:var(--soft);color:var(--text);font-size:12px}.snippet{margin:8px 0 0;color:var(--muted);font-size:13px;line-height:1.45}.snippet mark{background:#fff17a;color:#111;border-radius:2px}.row-actions{display:flex;align-items:center;gap:4px}.row-menu{position:relative}.row-menu summary{list-style:none}.row-menu summary::-webkit-details-marker{display:none}.row-menu-popover{position:absolute;right:0;top:48px;z-index:10;width:190px;padding:7px;border:1px solid var(--line);border-radius:14px;background:var(--bg);box-shadow:var(--shadow)}.row-menu-popover button,.row-menu-popover a{display:flex;align-items:center;width:100%;min-height:44px;padding:0 11px;border:0;border-radius:9px;background:none;color:inherit;text-decoration:none;cursor:pointer}.row-menu-popover button:hover,.row-menu-popover a:hover{background:var(--soft)}
    .empty{padding:72px 16px;text-align:center;color:var(--muted)}.empty h2{color:var(--text);font-size:20px;margin:0 0 9px}.empty p{line-height:1.5}.footer{display:flex;justify-content:center;padding:54px 0;color:var(--muted);font-size:13px}.footer a{color:inherit}
    dialog{width:min(540px,calc(100% - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:0;border:1px solid var(--line);border-radius:22px;background:var(--bg);color:var(--text);box-shadow:var(--shadow)}dialog::backdrop{background:rgba(0,0,0,.35);backdrop-filter:blur(3px)}.dialog-body{padding:26px}.dialog-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}.dialog-head h2{font-size:22px;margin:0}.field{display:grid;gap:7px;margin:14px 0}.field label{font-size:13px;font-weight:650}.field input,.field textarea{width:100%;border:1px solid var(--line);border-radius:12px;background:var(--bg);padding:12px 13px;outline:none}.field input{min-height:46px}.field textarea{min-height:200px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.field input:focus,.field textarea:focus{border-color:var(--text)}.segments{display:grid;grid-template-columns:repeat(3,1fr);padding:3px;border-radius:12px;background:var(--soft)}.segments button{min-height:40px;border:0;border-radius:9px;background:transparent;cursor:pointer;font-size:13px}.segments button[aria-pressed="true"]{background:var(--bg);box-shadow:0 1px 5px rgba(0,0,0,.09)}.upload-box{display:grid;place-items:center;min-height:150px;border:1px dashed var(--line);border-radius:14px;text-align:center;color:var(--muted)}.help,.error{font-size:13px;line-height:1.45}.help{color:var(--muted)}.error{color:#b42318;min-height:18px}.dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}.people-list{list-style:none;padding:0;margin:0 0 24px}.person{display:grid;grid-template-columns:1fr auto;gap:12px;padding:13px 0;border-bottom:1px solid var(--line)}.person-name{font-weight:650}.person-meta{margin-top:3px;color:var(--muted);font-size:12px;line-height:1.45}.owner-tag{padding:2px 6px;border-radius:999px;background:var(--soft);font-size:11px}.link-result{display:flex;gap:8px}.link-result input{min-width:0;flex:1}.toast-region{position:fixed;left:50%;bottom:24px;z-index:50;transform:translateX(-50%);display:grid;gap:8px;width:min(560px,calc(100% - 32px))}.toast{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;border-radius:14px;background:#111;color:#fff;box-shadow:var(--shadow);font-size:14px}.toast button{min-height:36px;border:0;border-radius:999px;padding:0 12px;background:#fff;color:#111;font-weight:650;cursor:pointer}
    :focus-visible{outline:3px solid #8b5cf6;outline-offset:2px}@media(max-width:640px){.shell{width:min(100% - 24px,920px)}.topbar{top:8px;margin:8px auto 48px;padding-left:15px}.new-label{display:none}.title-row h1{font-size:32px}.search-sort{display:grid}.document-row{grid-template-columns:minmax(0,1fr) auto;gap:8px}.copy-visible{display:none}.metadata{padding-right:4px}.segments{grid-template-columns:1fr}.dialog-body{padding:20px}}@media(pointer:coarse){.copy-visible{display:none}}
  </style>`;

function signedOutPage(): string {
  return `<!doctype html><html lang="en"><head>${sharedHead}</head><body>
    <header class="topbar shell"><span class="wordmark">Proof</span></header>
    <main class="shell" style="max-width:680px;padding:48px 0 80px">
      <h1 style="font-size:42px;letter-spacing:-1.6px;margin:0 0 24px">Your team’s documents</h1>
      <p style="font-size:18px;line-height:1.6;color:var(--muted)">To sign in, open the sign-in link a teammate sent you. Lost it? Ask a teammate for a new one.</p>
      <p style="font-size:16px;line-height:1.6;color:var(--muted)">You don’t need to sign in to open a document from its own link.</p>
    </main>
    <footer class="footer shell"><a href="/developers">Developer API</a></footer>
  </body></html>`;
}

function signedInPage(name: string, isOwner: boolean): string {
  const initials = name.split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase();
  return `<!doctype html><html lang="en"><head>${sharedHead}</head><body data-member-name="${escapeHtml(name)}" data-owner="${isOwner ? '1' : '0'}">
    <header class="topbar shell">
      <span class="wordmark">Proof</span>
      <div class="header-actions">
        <button class="btn primary" id="new-document"><span class="new-label">New document</span><span aria-hidden="true"> +</span></button>
        <div class="menu-wrap">
          <button class="btn icon-btn avatar" id="avatar" aria-label="Open account menu" aria-expanded="false">${escapeHtml(initials)}</button>
          <div class="menu" id="account-menu" hidden>
            <div class="menu-name">${escapeHtml(name)}</div>
            <button id="people-button">People</button>
            <button id="device-button">Sign in on another device</button>
            <button id="signout-button">Sign out</button>
          </div>
        </div>
      </div>
    </header>
    <main class="shell">
      <div class="title-row"><h1>Documents</h1><span class="count" id="document-count">0</span></div>
      <section class="controls" aria-label="Document controls">
        <div class="search-sort">
          <input class="search" id="search" type="search" placeholder="Search titles and text" aria-label="Search titles and text">
          <select id="sort" aria-label="Sort documents"><option value="edited">Last edited</option><option value="title">Title</option><option value="created">Created</option></select>
        </div>
        <div class="chips" role="group" aria-label="Filter documents">
          <button class="chip" data-filter="all" aria-pressed="true">All <span>0</span></button>
          <button class="chip" data-filter="review" aria-pressed="false">Needs review <span>0</span></button>
          <button class="chip" data-filter="mine" aria-pressed="false">Created by me <span>0</span></button>
          <button class="chip" data-filter="archived" aria-pressed="false">Archived <span>0</span></button>
        </div>
      </section>
      <ul class="document-list" id="document-list" aria-label="Documents"></ul>
      <div class="empty" id="empty" hidden></div>
    </main>
    <footer class="footer shell"><a href="/developers">Developer API</a></footer>
    ${dialogs()}
    <div class="toast-region" id="toasts" aria-live="polite"></div>
    <script src="/library/client.js" defer></script>
  </body></html>`;
}

function dialogs(): string {
  return `
    <dialog id="new-dialog" role="dialog" aria-modal="true" aria-labelledby="new-title-heading"><form method="dialog" class="dialog-body" id="new-form">
      <div class="dialog-head"><h2 id="new-title-heading">New document</h2><button type="button" class="btn icon-btn quiet" value="cancel" aria-label="Close">×</button></div>
      <div class="field"><label for="new-title">Title</label><input id="new-title" placeholder="Untitled document" autocomplete="off"></div>
      <div class="segments" role="group" aria-label="Document source"><button type="button" data-mode="blank" aria-pressed="true">Blank</button><button type="button" data-mode="paste" aria-pressed="false">Paste markdown</button><button type="button" data-mode="upload" aria-pressed="false">Upload a file</button></div>
      <div id="paste-panel" class="field" hidden><label for="markdown">Markdown</label><textarea id="markdown" spellcheck="false"></textarea></div>
      <div id="upload-panel" class="field" hidden><label class="upload-box" for="file-input"><span><strong>Choose a Markdown or text file</strong><br><small>.md, .markdown or .txt</small></span></label><input id="file-input" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden><div id="file-name" class="help"></div></div>
      <p class="help">Tip: in Google Docs, File → Download → Markdown gives you a file you can upload here.</p><p class="error" id="new-error" role="alert"></p>
      <div class="dialog-actions"><button type="button" class="btn" value="cancel">Cancel</button><button class="btn primary" id="create-button" value="default">Create</button></div>
    </form></dialog>
    <dialog id="rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-heading"><form method="dialog" class="dialog-body" id="rename-form"><div class="dialog-head"><h2 id="rename-heading">Rename document</h2><button type="button" class="btn icon-btn quiet" value="cancel" aria-label="Close">×</button></div><div class="field"><label for="rename-title">Title</label><input id="rename-title"></div><p class="error" id="rename-error"></p><div class="dialog-actions"><button type="button" class="btn" value="cancel">Cancel</button><button class="btn primary" value="default">Save</button></div></form></dialog>
    <dialog id="people-dialog" role="dialog" aria-modal="true" aria-labelledby="people-heading"><div class="dialog-body"><div class="dialog-head"><h2 id="people-heading">People</h2><button class="btn icon-btn quiet" data-close aria-label="Close">×</button></div><ul class="people-list" id="people-list"></ul><form id="invite-form"><h3>Invite someone</h3><div class="field"><label for="invite-name">Name</label><input id="invite-name" required autocomplete="name"></div><div class="field"><label for="invite-email">Email</label><input id="invite-email" type="email" required autocomplete="email"></div><p class="error" id="invite-error"></p><button class="btn primary">Create sign-in link</button></form><div id="invite-result" hidden><p id="invite-help"></p><div class="link-result"><input id="invite-link" readonly aria-label="One-time invite link"><button class="btn" id="copy-invite">Copy</button></div></div></div></dialog>
    <dialog id="device-dialog" role="dialog" aria-modal="true" aria-labelledby="device-heading"><div class="dialog-body"><div class="dialog-head"><h2 id="device-heading">Sign in on another device</h2><button class="btn icon-btn quiet" data-close aria-label="Close">×</button></div><p>This one-time link works once and expires in 30 minutes.</p><div class="link-result"><input id="device-link" readonly aria-label="One-time device link"><button class="btn" id="copy-device">Copy</button></div><p class="error" id="device-error"></p></div></dialog>`;
}

export function renderLibraryHome(req: Request, res: Response): void {
  const session = getLibrarySession(req, res);
  res.type('html').send(session ? signedInPage(session.member.name, session.member.isOwner) : signedOutPage());
}
