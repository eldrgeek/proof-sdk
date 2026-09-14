// close-tab-probe.mjs — does an Accept survive the reviewer closing the tab right after clicking it?
// Types an insertion in Suggesting mode, accepts it, closes the tab CLOSE_DELAY_MS later, then checks
// the server's /state and what a fresh reader sees. Also counts REST /marks/accept|reject calls
// (a live, connected session should make none after B7).
// Document markdown: # Proof E2E\n\nERIC\\\nI think teh play is ready.\n\nDIANA\\\nThe second act needs one more scene.\n
// Env: PROOF_DOC_URL (fresh doc, tokenized — never printed), CLOSE_DELAY_MS (default 300).
// Authored 2026-09-14 by Claude Opus 5 (CCc) for Mike Wolf; rebuilt the same day after the scratchpad was wiped.
import { createRequire } from 'module';

const require = createRequire('/Users/mikewolf/Projects/playmaker/package.json');
const { chromium } = require('playwright');

const DOC_URL = process.env.PROOF_DOC_URL;
const CLOSE_DELAY_MS = Number(process.env.CLOSE_DELAY_MS ?? 300);
if (!DOC_URL) { console.error('need PROOF_DOC_URL'); process.exit(2); }
const u = new globalThis.URL(DOC_URL);
const slug = u.pathname.split('/').pop();
const token = u.searchParams.get('token');
const WORDS = ' closetab words';

const browser = await chromium.launch();

async function open(ctx) {
  const page = await ctx.newPage();
  await page.goto(DOC_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true', null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const nameInput = page.getByPlaceholder('Your name');
  if (await nameInput.isVisible()) {
    await nameInput.fill('Claude CloseTab');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await nameInput.waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForTimeout(500);
  }
  return page;
}

// 1. Reviewer tab: type an insertion, accept it, close the tab shortly after.
const ctxA = await browser.newContext({ viewport: { width: 1100, height: 640 } });
const pageA = await open(ctxA);
if (!(await pageA.evaluate(() => window.proof.isSuggestionsEnabled()))) await pageA.click('.share-pill-suggest-toggle');
await pageA.evaluate(() => {
  const v = window.proof.editor.ctx.get('editorView');
  let end = 1;
  v.state.doc.descendants((node, pos) => { if (node.isTextblock) end = pos + node.nodeSize - 1; });
  const Sel = v.state.selection.constructor;
  v.dispatch(v.state.tr.setSelection(Sel.near(v.state.doc.resolve(end), -1)));
  v.focus();
});
await pageA.keyboard.type(WORDS, { delay: 40 });
await pageA.waitForTimeout(2500);

let restCalls = 0;
pageA.on('request', (r) => { if (/\/marks\/(accept|reject)/.test(r.url())) restCalls += 1; });

const accepted = await pageA.evaluate((needle) => {
  const v = window.proof.editor.ctx.get('editorView');
  const mark = (window.proof.getAllMarks() || []).find((m) => m.kind === 'insert' && m.range
    && v.state.doc.textBetween(m.range.from, m.range.to).includes(needle));
  if (!mark) return { found: false };
  const returned = window.proof.markAccept(mark.id);
  let stillMarked = false;
  v.state.doc.descendants((node) => {
    if (stillMarked || !node.isText) return;
    if (node.marks.some((m) => m.type.name === 'proofSuggestion' && m.attrs.id === mark.id)) stillMarked = true;
  });
  return { found: true, id: mark.id, returned, stillMarkedSameTick: stillMarked };
}, WORDS.trim());
console.log('accept:', JSON.stringify(accepted));
await pageA.waitForTimeout(CLOSE_DELAY_MS);
await ctxA.close();
console.log(`tab closed ${CLOSE_DELAY_MS} ms after Accept; REST accept/reject calls from the tab: ${restCalls}`);

// 2. Server view, 3 s later.
await new Promise((r) => setTimeout(r, 3000));
const res = await fetch(`${u.origin}/documents/${slug}/state`, { headers: { Authorization: `Bearer ${token}`, 'X-Agent-Id': 'close-tab-probe' } });
const st = await res.json();
const md = st.markdown || '';
const marks = Object.values(st.marks || {});
console.log('server:', JSON.stringify({
  readSource: st.readSource,
  projectionFresh: st.projectionFresh,
  mutationReady: st.mutationReady,
  repairPending: st.repairPending,
  wordsStoredTimes: md.split(WORDS.trim()).length - 1,
  markupInText: /data-(id|kind|proof)=/.test(md),
  pending: marks.filter((m) => m.status === 'pending').map((m) => m.kind),
}));

// 3. A fresh reader (new context, empty storage).
const ctxB = await browser.newContext({ viewport: { width: 1100, height: 640 } });
const pageB = await open(ctxB);
const reader = await pageB.evaluate((needle) => {
  const v = window.proof.editor.ctx.get('editorView');
  const text = v.state.doc.textContent;
  const pending = (window.proof.getAllMarks() || []).filter((m) => ['insert', 'delete', 'replace'].includes(m.kind) && m.range);
  return { wordsShownTimes: text.split(needle).length - 1, pendingShown: pending.length };
}, WORDS.trim());
console.log('fresh reader:', JSON.stringify(reader));
await browser.close();
