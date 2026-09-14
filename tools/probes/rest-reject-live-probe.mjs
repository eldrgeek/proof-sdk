// rest-reject-live-probe.mjs — does an AI's REST reject lose a live editor's later edits, and does it stick?
// A person has the document open in Suggesting mode. The AI adds a replace suggestion ("teh" -> "the")
// through POST /documents/:slug/ops; the person types; the AI rejects its suggestion through the same API;
// the person types again. After a reload with empty storage, both typed passages must be there, "teh" must
// be unchanged, the AI's suggestion must be gone, and the server must be fresh.
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
const auth = { Authorization: `Bearer ${token}`, 'X-Agent-Id': 'rest-reject-live-probe' };

async function op(body) {
  const res = await fetch(`${u.origin}/documents/${slug}/ops`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, success: json.success, code: json.code, error: json.error };
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1100, height: 640 } })).newPage();

async function openDoc() {
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

const view = () => page.evaluate(() => {
  const v = window.proof.editor.ctx.get('editorView');
  const text = v.state.doc.textContent;
  return {
    beforeReject: text.includes('typed before reject'),
    afterReject: text.includes('typed after reject'),
    tehKept: text.includes('teh play'),
    pending: (window.proof.getAllMarks() || []).filter((m) => ['insert', 'delete', 'replace'].includes(m.kind) && m.range).map((m) => `${m.kind}:${m.by}`),
  };
});

await openDoc();
if (!(await page.evaluate(() => window.proof.isSuggestionsEnabled()))) await page.click('.share-pill-suggest-toggle');
console.log('1 AI suggestion.add replace ->', JSON.stringify(await op({ type: 'suggestion.add', kind: 'replace', quote: 'teh', content: 'the', by: 'ai:cos-probe' })));
await page.waitForTimeout(3000);
const aiId = await page.evaluate(() => (window.proof.getAllMarks() || []).find((m) => m.kind === 'replace' && String(m.by).startsWith('ai:'))?.id ?? null);
console.log('2 person sees the AI suggestion:', Boolean(aiId));

await typeAtEnd(' typed before reject');
await page.waitForTimeout(3000);
console.log('3 AI suggestion.reject ->', JSON.stringify(aiId ? await op({ type: 'suggestion.reject', markId: aiId, by: 'ai:cos-probe' }) : 'no id'));
await page.waitForTimeout(3000);
await typeAtEnd(' typed after reject');
await page.waitForTimeout(4000);
console.log('4 before reload, person sees:', JSON.stringify(await view()));

await openDoc();
console.log('5 after reload, person sees:', JSON.stringify(await view()));
const st = await (await fetch(`${u.origin}/documents/${slug}/state`, { headers: auth })).json();
const md = st.markdown || '';
console.log('6 server:', JSON.stringify({
  readSource: st.readSource, projectionFresh: st.projectionFresh, repairPending: st.repairPending, revision: st.revision,
  beforeReject: md.includes('typed before reject'), afterReject: md.includes('typed after reject'), tehKept: md.includes('teh play'),
  markupInText: /data-(id|kind|proof)=/.test(md),
  pending: Object.values(st.marks || {}).filter((m) => m.status === 'pending').map((m) => `${m.kind}:${m.by}`),
}));
await browser.close();
