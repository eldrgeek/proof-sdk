// ai-block-probe.mjs — can an AI add inline text, a whole paragraph or a table row as an insert suggestion, and
// does Accept apply it exactly once (or Reject remove it cleanly)? A person has the document open in Suggesting
// mode; the AI adds the suggestions through POST /documents/:slug/ops; the script prints what the page shows as
// pending, the blocks after each Accept or Reject, after a reload, and the server's markdown with duplicate and
// table-column checks.
// Document markdown:
//   # Block test\n\nIntro paragraph one.\n\n| Name | Role |\n| --- | --- |\n| Eric | Writer |\n| Diana | Director |\n\nClosing paragraph.\n
// Env: PROOF_DOC_URL (fresh doc, tokenized — never printed); ACTION=accept|reject (default accept).
// Authored 2026-09-14 by Claude Opus 5 (CCc) for Mike Wolf; rebuilt the same day after the scratchpad was wiped.
import { createRequire } from 'module';

const require = createRequire('/Users/mikewolf/Projects/playmaker/package.json');
const { chromium } = require('playwright');

const DOC_URL = process.env.PROOF_DOC_URL;
const ACTION = process.env.ACTION === 'reject' ? 'reject' : 'accept';
if (!DOC_URL) { console.error('need PROOF_DOC_URL'); process.exit(2); }
const u = new globalThis.URL(DOC_URL);
const slug = u.pathname.split('/').pop();
const token = u.searchParams.get('token');
const auth = { Authorization: `Bearer ${token}`, 'X-Agent-Id': 'ai-block-probe' };

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();

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

// Top-level blocks as "type: text"; table rows as "row: cell | cell".
const blocks = () => page.evaluate(() => {
  const v = window.proof.editor.ctx.get('editorView');
  const out = [];
  v.state.doc.forEach((node) => {
    if (node.type.name.startsWith('table')) {
      node.descendants((child) => {
        if (child.type.name === 'table_row' || child.type.name === 'table_header_row') {
          const cells = [];
          child.forEach((cell) => cells.push(cell.textContent));
          out.push(`row: ${cells.join(' | ')}`);
          return false;
        }
        return true;
      });
    } else {
      out.push(`${node.type.name}: ${node.textContent}`);
    }
  });
  return out;
});

const pendingMarks = () => page.evaluate(() => {
  const v = window.proof.editor.ctx.get('editorView');
  return (window.proof.getAllMarks() || [])
    .filter((m) => ['insert', 'delete', 'replace'].includes(m.kind))
    .map((m) => ({ id: m.id, kind: m.kind, covered: m.range ? v.state.doc.textBetween(m.range.from, m.range.to, ' / ') : null, content: m.data?.content ?? null }));
});

await openDoc();
if (!(await page.evaluate(() => window.proof.isSuggestionsEnabled()))) await page.click('.share-pill-suggest-toggle');
console.log('action:', ACTION, '| blocks at start:', JSON.stringify(await blocks()));

const allOps = [
  { key: 'inline', label: 'inline text via insert', kind: 'insert', quote: 'Intro paragraph one.', content: ' AI inline words.', needle: 'AI inline' },
  { key: 'paragraph', label: 'paragraph via insert after a paragraph end', kind: 'insert', quote: 'Closing paragraph.', content: '\n\nAnother AI paragraph.', needle: 'Another AI' },
  { key: 'row', label: 'table row via insert anchored on a cell', kind: 'insert', quote: 'Director', content: '\n| Mike | Producer |', needle: 'Mike' },
];
// ONLY=inline|paragraph|row runs a single kind of insert, to find which one breaks a document.
const ops = process.env.ONLY ? allOps.filter((o) => o.key === process.env.ONLY) : allOps;
for (const o of ops) {
  const res = await fetch(`${u.origin}/documents/${slug}/ops`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'suggestion.add', kind: o.kind, quote: o.quote, content: o.content, by: 'ai:cos-probe' }),
  });
  const body = await res.json().catch(() => ({}));
  o.status = res.status;
  console.log(`AI ${o.label} ->`, res.status, JSON.stringify({ success: body.success, code: body.code, error: body.error }));
}
await page.waitForTimeout(3000);
const marks = await pendingMarks();
for (const m of marks) console.log('mark in page:', JSON.stringify(m));
console.log('blocks with suggestions pending:', JSON.stringify(await blocks()));

for (const o of ops) {
  if (o.status !== 200) continue;
  const m = marks.find((x) => (x.covered || '').includes(o.needle) || (x.content || '').includes(o.needle));
  if (!m) { console.log(`${ACTION} ${o.label}: NO MARK in page`); continue; }
  const returned = await page.evaluate(([id, action]) => (action === 'reject' ? window.proof.markReject(id) : window.proof.markAccept(id)), [m.id, ACTION]);
  await page.waitForTimeout(1500);
  console.log(`${ACTION} ${o.label}: returned ${returned}`);
  console.log('   blocks after:', JSON.stringify(await blocks()));
}

await page.waitForTimeout(3000);
await openDoc();
console.log('blocks after reload:', JSON.stringify(await blocks()));
const st = await (await fetch(`${u.origin}/documents/${slug}/state`, { headers: auth })).json();
const md = st.markdown || '';
const rowCols = md.split('\n').filter((l) => l.trim().startsWith('|')).map((l) => l.split('|').length - 2);
console.log('server:', JSON.stringify({
  readSource: st.readSource, projectionFresh: st.projectionFresh, revision: st.revision,
  pending: Object.values(st.marks || {}).filter((m) => m.status === 'pending').map((m) => m.kind),
  inlineWordsTimes: md.split('AI inline words').length - 1,
  anotherParagraphTimes: md.split('Another AI paragraph').length - 1,
  mikeRowTimes: md.split('| Mike').length - 1,
  tableColumnsPerRow: rowCols,
  markupInText: /data-(id|kind|proof)=/.test(md),
}));
console.log('server markdown:', JSON.stringify(md));
await browser.close();
