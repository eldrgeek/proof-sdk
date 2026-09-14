// agent-live-probe.mjs — does an AI suggestion added through the REST API disturb a person editing live?
// A browser tab (the person) has the document open in Suggesting mode. Node (the AI) adds an insert
// suggestion with POST /documents/:slug/ops suggestion.add. The person then types; after a reload with
// empty storage, the person's text and the AI suggestion must both still be there and the server must
// stay fresh. Then the person accepts the AI suggestion and types again; reload and check once more.
// Document markdown: # Proof E2E\n\nERIC\\\nI think teh play is ready.\n\nDIANA\\\nThe second act needs one more scene.\n
// Env: PROOF_DOC_URL (fresh doc, tokenized — never printed).
// Authored 2026-09-14 by Claude Opus 5 (CCc) for Mike Wolf; rebuilt the same day after the scratchpad was wiped.
import { createRequire } from 'module';

const require = createRequire('/Users/mikewolf/Projects/playmaker/package.json');
const { chromium } = require('playwright');

const DOC_URL = process.env.PROOF_DOC_URL;
if (!DOC_URL) { console.error('need PROOF_DOC_URL'); process.exit(2); }
const u = new globalThis.URL(DOC_URL);
const slug = u.pathname.split('/').pop();
const token = u.searchParams.get('token');
const auth = { Authorization: `Bearer ${token}`, 'X-Agent-Id': 'agent-live-probe' };

async function serverState() {
  const st = await (await fetch(`${u.origin}/documents/${slug}/state`, { headers: auth })).json();
  const md = st.markdown || '';
  const marks = Object.values(st.marks || {});
  return {
    readSource: st.readSource,
    projectionFresh: st.projectionFresh,
    repairPending: st.repairPending,
    revision: st.revision,
    aiText: md.includes('AI probe words'),
    human1: md.includes('human after AI'),
    human2: md.includes('second human edit'),
    markupInText: /data-(id|kind|proof)=/.test(md),
    pending: marks.filter((m) => m.status === 'pending').map((m) => `${m.kind}:${m.by}`),
  };
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1100, height: 640 } })).newPage();

async function openDoc() {
  // Empty storage first, so a reload shows what the server kept, not the tab's own replay.
  if (page.url().startsWith('http')) await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} }).catch(() => {});
  await page.goto(DOC_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true', null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const nameInput = page.getByPlaceholder('Your name');
  if (await nameInput.isVisible()) {
    await nameInput.fill('Claude Person');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await nameInput.waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForTimeout(500);
  }
}

async function typeAtEnd(text) {
  await page.evaluate(() => {
    const v = window.proof.editor.ctx.get('editorView');
    let end = 1;
    v.state.doc.descendants((node, pos) => { if (node.isTextblock) end = pos + node.nodeSize - 1; });
    const Sel = v.state.selection.constructor;
    v.dispatch(v.state.tr.setSelection(Sel.near(v.state.doc.resolve(end), -1)));
    v.focus();
  });
  await page.keyboard.type(text, { delay: 40 });
}

const pageView = () => page.evaluate(() => {
  const v = window.proof.editor.ctx.get('editorView');
  const text = v.state.doc.textContent;
  const pending = (window.proof.getAllMarks() || [])
    .filter((m) => ['insert', 'delete', 'replace'].includes(m.kind) && m.range)
    .map((m) => `${m.kind}:${m.by}`);
  return {
    aiText: text.includes('AI probe words'),
    human1: text.includes('human after AI'),
    human2: text.includes('second human edit'),
    pending,
  };
});

await openDoc();
if (!(await page.evaluate(() => window.proof.isSuggestionsEnabled()))) await page.click('.share-pill-suggest-toggle');
console.log('1 person has the document open in Suggesting mode');

const opRes = await fetch(`${u.origin}/documents/${slug}/ops`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'suggestion.add', kind: 'insert', quote: 'needs one more scene', content: ' AI probe words', by: 'ai:cos-probe' }),
});
const opBody = await opRes.json().catch(() => ({}));
console.log('2 AI suggestion.add ->', opRes.status, JSON.stringify({ success: opBody.success, code: opBody.code, error: opBody.error }));
await page.waitForTimeout(3000);
console.log('3 person sees:', JSON.stringify(await pageView()));

await typeAtEnd(' human after AI');
await page.waitForTimeout(3000);
console.log('4 person typed; server:', JSON.stringify(await serverState()));
await openDoc();
console.log('5 after reload, person sees:', JSON.stringify(await pageView()));

const aiId = await page.evaluate(() => (window.proof.getAllMarks() || []).find((m) => m.kind === 'insert' && String(m.by).startsWith('ai:'))?.id ?? null);
const acceptedAi = aiId ? await page.evaluate((id) => window.proof.markAccept(id), aiId) : null;
console.log('6 person accepts the AI suggestion:', aiId ? 'found' : 'NOT FOUND', 'returned', acceptedAi);
await page.waitForTimeout(2000);
await typeAtEnd(' second human edit');
await page.waitForTimeout(3000);
await openDoc();
console.log('7 after reload, person sees:', JSON.stringify(await pageView()));
console.log('8 server:', JSON.stringify(await serverState()));
await browser.close();
