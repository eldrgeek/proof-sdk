// e2e-suggest.mjs — end-to-end evidence run for Proof suggesting mode on the self-hosted instance.
// Headless Chromium (Playwright from ~/Projects/playmaker). Use a FRESH document per run, created from
//   # Proof E2E\n\nERIC\\\nI think teh play is ready.\n\nDIANA\\\nThe second act needs one more scene.\n
// Every step saves a screenshot to OUT_DIR; the run writes OUT_DIR/summary.json with pass/fail per step,
// page console errors, crash status, and the server's own /state view at the end.
// Env: PROOF_DOC_URL (tokenized share URL — never printed), OUT_DIR,
//      TEXT=plain|brackets (default plain; brackets types markdown-sensitive text such as "[E2E insert]").
// Suggestions are located through the editor's marks API and data-mark-id, because the green highlight
// is split into one element per character (each typed character carries its own authored mark).
// Authored 2026-09-14 by Claude Opus 5 (CCc) for Mike Wolf; rebuilt the same day after the scratchpad was wiped.
import { createRequire } from 'module';
import fs from 'fs';

const require = createRequire('/Users/mikewolf/Projects/playmaker/package.json');
const { chromium } = require('playwright');

const URL = process.env.PROOF_DOC_URL;
const OUT = process.env.OUT_DIR;
if (!URL || !OUT) { console.error('need PROOF_DOC_URL and OUT_DIR'); process.exit(2); }
const T = process.env.TEXT === 'brackets'
  ? { insert: ' [E2E insert]', insertCheck: '[E2E insert]', bulkA: ' [bulk A]', bulkACheck: '[bulk A]', bulkB: ' [bulk B]', bulkBCheck: '[bulk B]' }
  : { insert: ' E2E insert words', insertCheck: 'E2E insert words', bulkA: ' bulk A words', bulkACheck: 'bulk A words', bulkB: ' bulk B words', bulkBCheck: 'bulk B words' };
fs.mkdirSync(OUT, { recursive: true });
const u = new globalThis.URL(URL);
const slug = u.pathname.split('/').pop();
const token = u.searchParams.get('token');

const results = [];
const consoleErrors = [];
let crashed = false;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1100, height: 640 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('dialog', (d) => d.accept());
page.on('crash', () => { crashed = true; });
page.on('console', (m) => { if (m.type() === 'error' && !/status of 404/.test(m.text())) consoleErrors.push(m.text().slice(0, 300)); });

let n = 0;
const shot = (name) => page.screenshot({ path: `${OUT}/${String(++n).padStart(2, '0')}-${name}.png` });
async function step(name, fn) {
  if (crashed) { results.push({ step: name, ok: false, error: 'page crashed earlier' }); console.log(`SKIP ${name} (crashed)`); return; }
  try {
    const detail = await fn();
    results.push({ step: name, ok: true, detail: detail ?? null });
    console.log(`PASS ${name}${detail ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`);
  } catch (e) {
    results.push({ step: name, ok: false, error: String(e?.message || e).slice(0, 600) });
    console.log(`FAIL ${name} — ${String(e?.message || e).slice(0, 400)}`);
    await shot(`FAIL-${name.replace(/[^a-z0-9]+/gi, '-')}`).catch(() => {});
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

async function openDoc() {
  // Clear local storage first: the collab client replays unsent updates from localStorage on reload,
  // which would hide a server that dropped them. Reload checks must reflect the server.
  if (page.url().startsWith('http')) await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} }).catch(() => {});
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.share-pill-suggest-toggle', { state: 'visible', timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true', null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const nameInput = page.getByPlaceholder('Your name');
  if (await nameInput.isVisible()) {
    await nameInput.fill('Claude E2E');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await nameInput.waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForTimeout(500);
  }
}

const pageFns = {
  caretToEnd: () => {
    const v = window.proof.editor.ctx.get('editorView');
    let end = 1;
    v.state.doc.descendants((node, pos) => { if (node.isTextblock) end = pos + node.nodeSize - 1; });
    const Sel = v.state.selection.constructor;
    v.dispatch(v.state.tr.setSelection(Sel.near(v.state.doc.resolve(end), -1)));
    v.focus();
  },
  selectWord: (word) => {
    const v = window.proof.editor.ctx.get('editorView');
    let from = -1;
    v.state.doc.descendants((node, pos) => {
      if (from >= 0 || !node.isText) return;
      const i = node.text.indexOf(word);
      if (i >= 0) from = pos + i;
    });
    if (from < 0) return false;
    const Sel = v.state.selection.constructor;
    v.dispatch(v.state.tr.setSelection(Sel.create(v.state.doc, from, from + word.length)));
    v.focus();
    return true;
  },
  // Pending suggestions as the editor sees them, with the text each one covers and how it is drawn.
  state: () => {
    const v = window.proof.editor.ctx.get('editorView');
    const doc = v.state.doc;
    const drawn = {};
    for (const el of document.querySelectorAll('[data-mark-id][data-mark-kind]')) {
      const id = el.getAttribute('data-mark-id');
      drawn[id] = drawn[id] || { text: '', title: el.title, cls: el.className.replace(/\s*proof-mark-new/, '') };
      drawn[id].text += el.textContent;
    }
    const pending = (window.proof.getAllMarks() || [])
      .filter((m) => ['insert', 'delete', 'replace'].includes(m.kind) && m.range)
      .map((m) => ({ id: m.id, kind: m.kind, by: m.by, text: doc.textBetween(m.range.from, m.range.to), content: m.data?.content ?? null, drawn: drawn[m.id] || null }));
    const pill = document.querySelector('.share-pill-suggestion-review');
    return {
      suggesting: window.proof.isSuggestionsEnabled(),
      text: doc.textContent,
      pending,
      pill: pill && getComputedStyle(pill).display !== 'none' ? pill.textContent : null,
    };
  },
};
const S = () => page.evaluate(pageFns.state);
const findPending = (s, kind, needle) => s.pending.find((p) => p.kind === kind && p.text.includes(needle));
const actionButton = (re) => page.getByRole('button', { name: re });
let insertId = null;
let deleteId = null;

await step('open a fresh document in Suggesting mode', async () => {
  await openDoc();
  const s = await S();
  if (!s.suggesting) await page.click('.share-pill-suggest-toggle');
  await shot('loaded');
  return { suggesting: (await S()).suggesting, pending: s.pending.length };
});

await step('type an insertion key by key: drawn green, attributed', async () => {
  await page.evaluate(pageFns.caretToEnd);
  await page.keyboard.type(T.insert, { delay: 40 });
  await page.waitForTimeout(2000);
  const s = await S();
  const ins = findPending(s, 'insert', T.insertCheck);
  assert(ins, `no pending insert covering the typed text; pending=${JSON.stringify(s.pending)}`);
  assert(ins.drawn && ins.drawn.text.includes(T.insertCheck) && /mark-insert/.test(ins.drawn.cls), `insert not drawn green: ${JSON.stringify(ins)}`);
  assert(ins.drawn.title === 'Suggested by Claude E2E', `author title: ${ins.drawn.title}`);
  insertId = ins.id;
  await shot('insert-typed');
  return ins;
});

await step('suggest a deletion: drawn red', async () => {
  assert(await page.evaluate(pageFns.selectWord, 'teh'), 'word "teh" not found');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(2000);
  const s = await S();
  const del = findPending(s, 'delete', 'teh');
  assert(del && del.drawn && /mark-delete/.test(del.drawn.cls), `no red deletion on "teh": ${JSON.stringify(s.pending)}`);
  deleteId = del.id;
  await shot('delete-suggested');
  return del;
});

await step('reload: both suggestions persist and are drawn', async () => {
  await page.waitForTimeout(2500);
  await openDoc();
  const s = await S();
  const ins = s.pending.find((p) => p.id === insertId);
  const del = s.pending.find((p) => p.id === deleteId);
  assert(ins && ins.drawn && ins.text.includes(T.insertCheck), `insert lost after reload: ${JSON.stringify(s.pending)}`);
  assert(del && del.drawn && del.text.includes('teh'), `delete lost after reload: ${JSON.stringify(s.pending)}`);
  await shot('after-reload');
  return { insert: ins, delete: del, pill: s.pill };
});

await step('click the insertion: card shows author and change', async () => {
  await page.locator(`[data-mark-id="${insertId}"]`).first().click();
  await actionButton(/^(Accept|Apply)$/).first().waitFor({ timeout: 5000 });
  const card = await page.evaluate(() => ({
    header: document.querySelector('.mark-popover-header')?.textContent ?? null,
    meta: document.querySelector('.mark-popover-meta')?.textContent ?? null,
    body: document.querySelector('.mark-popover-body')?.textContent ?? null,
  }));
  await shot('insert-card');
  return card;
});

await step('accept the insertion', async () => {
  await actionButton(/^(Accept|Apply)$/).first().click();
  await page.waitForTimeout(2500);
  const s = await S();
  assert(s.text.includes(T.insertCheck), 'accepted text disappeared');
  assert(!s.pending.some((p) => p.id === insertId), `insert still pending after accept: ${JSON.stringify(s.pending)}`);
  await shot('insert-accepted');
  return { pending: s.pending.length };
});

await step('reject the deletion', async () => {
  await page.locator(`[data-mark-id="${deleteId}"]`).first().click();
  await actionButton(/^Reject$/).first().waitFor({ timeout: 5000 });
  await shot('delete-card');
  await actionButton(/^Reject$/).first().click();
  await page.waitForTimeout(2500);
  const s = await S();
  assert(!s.pending.some((p) => p.id === deleteId), `delete still pending after reject: ${JSON.stringify(s.pending)}`);
  assert(s.text.includes('teh'), 'rejected deletion removed the text');
  await shot('delete-rejected');
  return { pending: s.pending.length };
});

await step('reload: accept and reject persisted', async () => {
  await page.waitForTimeout(2500);
  await openDoc();
  const s = await S();
  assert(s.text.includes(T.insertCheck) && s.text.includes('teh'), `text after reload: ${s.text.slice(-120)}`);
  assert(!s.pending.some((p) => p.id === insertId || p.id === deleteId), `resolved suggestions returned: ${JSON.stringify(s.pending)}`);
  await shot('after-reload-resolved');
  return { pending: s.pending.length };
});

await step('accept a deletion: text removed exactly once', async () => {
  assert(await page.evaluate(pageFns.selectWord, 'one more '), 'phrase "one more " not found');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(2000);
  let s = await S();
  const del = findPending(s, 'delete', 'one more');
  assert(del && del.drawn, `no red deletion on "one more ": ${JSON.stringify(s.pending)}`);
  await page.locator(`[data-mark-id="${del.id}"]`).first().click();
  await actionButton(/^(Accept|Apply)$/).first().waitFor({ timeout: 5000 });
  await actionButton(/^(Accept|Apply)$/).first().click();
  await page.waitForTimeout(3000);
  s = await S();
  assert(s.text.includes('The second act needs scene.'), `after accept: ${s.text.slice(-80)}`);
  assert(!s.pending.some((p) => p.id === del.id), 'deletion still pending after accept');
  await page.waitForTimeout(2000);
  await openDoc();
  s = await S();
  assert(s.text.includes('The second act needs scene.'), `after reload (double-apply check): ${s.text.slice(-80)}`);
  await shot('delete-accepted');
  return { tail: s.text.slice(-60) };
});

await step('review pill counts two new suggestions', async () => {
  await page.evaluate(pageFns.caretToEnd);
  await page.keyboard.type(T.bulkA, { delay: 40 });
  await page.waitForTimeout(800);
  assert(await page.evaluate(pageFns.selectWord, 'ready'), 'word "ready" not found');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(2500);
  const s = await S();
  assert(s.pill && /2 suggestions/.test(s.pill), `pill text: ${s.pill}; pending=${s.pending.length}`);
  await page.click('.share-pill-suggestion-review');
  await page.getByRole('menuitem', { name: /Reject all/ }).waitFor({ timeout: 5000 });
  await shot('review-menu');
  return s.pill;
});

await step('reject all', async () => {
  await page.getByRole('menuitem', { name: /Reject all/ }).click();
  await page.waitForTimeout(3000);
  const s = await S();
  assert(!s.text.includes(T.bulkACheck), 'rejected insertion text remains');
  assert(s.text.includes('ready'), 'rejected deletion removed text');
  assert(s.pending.length === 0, `pending after reject all: ${JSON.stringify(s.pending)}`);
  await shot('rejected-all');
  return { pill: s.pill };
});

await step('accept all', async () => {
  await page.evaluate(pageFns.caretToEnd);
  await page.keyboard.type(T.bulkB, { delay: 40 });
  await page.waitForTimeout(2500);
  await page.click('.share-pill-suggestion-review');
  await page.getByRole('menuitem', { name: /Accept all/ }).click();
  await page.waitForTimeout(3000);
  const s = await S();
  assert(s.text.includes(T.bulkBCheck), 'accepted text missing');
  assert(s.pending.length === 0, `pending after accept all: ${JSON.stringify(s.pending)}`);
  await shot('accepted-all');
  return { pill: s.pill };
});

await step('final reload', async () => {
  await page.waitForTimeout(2500);
  await openDoc();
  const s = await S();
  assert(s.text.includes(T.bulkBCheck) && !s.text.includes(T.bulkACheck) && s.text.includes(T.insertCheck), `final text: ${s.text.slice(-140)}`);
  assert(s.pending.length === 0, `pending after final reload: ${JSON.stringify(s.pending)}`);
  await shot('final-reload');
  return { tail: s.text.slice(-90) };
});

let server = null;
try {
  const r = await fetch(`${u.origin}/documents/${slug}/state`, { headers: { Authorization: `Bearer ${token}`, 'X-Agent-Id': 'e2e-check' } });
  const st = await r.json();
  const marks = Object.values(st.marks || {});
  server = {
    projectionFresh: st.projectionFresh, readSource: st.readSource, revision: st.revision,
    markdownTail: (st.markdown || '').slice(-160),
    pendingSuggestions: marks.filter((m) => m.status === 'pending' && ['insert', 'delete', 'replace'].includes(m.kind)).length,
  };
} catch (e) {
  server = { error: String(e?.message || e) };
}
console.log(`server /state: ${JSON.stringify(server)}`);
fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify({ at: new Date().toISOString(), slug, text: process.env.TEXT || 'plain', crashed, results, consoleErrors, server }, null, 1));
console.log(`${results.filter((r) => r.ok).length}/${results.length} steps passed; crashed=${crashed}; console errors: ${consoleErrors.length}`);
await browser.close();
