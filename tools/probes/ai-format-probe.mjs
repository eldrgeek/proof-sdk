// ai-format-probe.mjs — how must an AI quote text that carries formatting (bold, links) for a replace suggestion
// to anchor exactly, and does Accept keep the formatting? Three sets of cases, each on its own fresh document:
//   SET=1 (default) document: # Format test\n\nThe **Format** line sets the style for the play.\n\nRead [the guide](https://example.com/guide) before you start.\n\nPlain closing line.\n
//     A plain quote that starts before a bold word (duplicated "The The" before C5); B markdown-form link quote
//     (never anchors, vanishes before C5); C plain quote next to a link (works).
//   SET=2 document: # Format test 2\n\nThe **Format** line sets the style for the play.\n\nEach **Scene** heading starts a new scene in the play.\n\nThe **Cue** name comes before the speech.\n\nA plain paragraph with no formatting.\n
//     D plain run after bold (works); E last plain words + new paragraph (refused on Accept before C5);
//     F quote starting inside bold (works, drops bold unless the content repeats it); G whole plain paragraph + new paragraph (works).
//   SET=3 document: # Format test 3\n\n**Today:** the editor keeps line breaks after a name.\n\n**Fixed on 14 September.** The caret lands in the **new** line after Enter.\n\n**Note:** plain words after the label.\n
//     H1 whole paragraph from its bold label + new paragraph; H2 the same with bold in the middle; H3 plain words after a label (all work).
// Prints which suggestions anchor in the page and on the server, then the paragraphs (bold as **x**, links as
// [x](href)) after each Accept, after a reload, and the server's markdown.
// Env: PROOF_DOC_URL (fresh doc made from the set's markdown, tokenized — never printed); SET=1|2|3.
// Authored 2026-09-14 by Claude Opus 5 (CCc) for Mike Wolf; rebuilt the same day after the scratchpad was wiped.
import { createRequire } from 'module';

const require = createRequire('/Users/mikewolf/Projects/playmaker/package.json');
const { chromium } = require('playwright');

const DOC_URL = process.env.PROOF_DOC_URL;
const SET = process.env.SET || '1';
if (!DOC_URL) { console.error('need PROOF_DOC_URL'); process.exit(2); }
const u = new globalThis.URL(DOC_URL);
const slug = u.pathname.split('/').pop();
const token = u.searchParams.get('token');
const auth = { Authorization: `Bearer ${token}`, 'X-Agent-Id': 'ai-format-probe' };

const SETS = {
  1: [
    { label: 'A plain quote across bold', quote: 'The Format line sets the style', content: 'The **Format** line sets the house style', needle: 'Format line' },
    { label: 'B markdown link quote', quote: '[the guide](https://example.com/guide)', content: '[the full guide](https://example.com/guide)', needle: 'the guide' },
    { label: 'C plain quote next to link', quote: 'before you start', content: 'before you begin', needle: 'before you start' },
  ],
  2: [
    { label: 'D plain run after bold', quote: 'line sets the style', content: 'line sets the house style', needle: 'line sets' },
    { label: 'E last plain words + new paragraph', quote: 'a new scene in the play.', content: 'a new scene in the play.\n\nA new AI paragraph.', needle: 'new scene' },
    { label: 'F starts inside bold', quote: 'Cue name comes', content: 'Cue name always comes', needle: 'name comes' },
    { label: 'G whole plain paragraph + new paragraph', quote: 'A plain paragraph with no formatting.', content: 'A plain paragraph with no formatting.\n\nSecond new AI paragraph.', needle: 'plain paragraph' },
  ],
  3: [
    { label: 'H1 whole paragraph from its bold label + new paragraph', quote: 'Today: the editor keeps line breaks after a name.', content: '**Today:** the editor keeps line breaks after a name.\n\nA new AI paragraph after a bold label.', needle: 'editor keeps' },
    { label: 'H2 same with bold in the middle', quote: 'Fixed on 14 September. The caret lands in the new line after Enter.', content: '**Fixed on 14 September.** The caret lands in the **new** line after Enter.\n\nSecond new AI paragraph.', needle: 'caret lands' },
    { label: 'H3 plain words after the label to the end', quote: 'plain words after the label.', content: 'plain words after the label, reworded.', needle: 'plain words' },
  ],
};
const ops = SETS[SET] || SETS[1];

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

// Paragraphs with bold shown as **x** and links as [x](href), so formatting loss is visible.
const paragraphs = () => page.evaluate(() => {
  const v = window.proof.editor.ctx.get('editorView');
  const out = [];
  v.state.doc.forEach((node) => {
    if (!node.isTextblock || node.type.name === 'heading') return;
    let s = '';
    node.forEach((child) => {
      if (!child.isText) return;
      let t = child.text;
      const names = child.marks.map((m) => m.type.name);
      if (names.includes('strong')) t = `**${t}**`;
      const link = child.marks.find((m) => m.type.name === 'link');
      if (link) t = `[${t}](${link.attrs.href})`;
      s += t;
    });
    out.push(s);
  });
  return out;
});

await openDoc();
if (!(await page.evaluate(() => window.proof.isSuggestionsEnabled()))) await page.click('.share-pill-suggest-toggle');
console.log('set', SET, '| paragraphs at start:', JSON.stringify(await paragraphs()));

for (const o of ops) {
  const res = await fetch(`${u.origin}/documents/${slug}/ops`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'suggestion.add', kind: 'replace', quote: o.quote, content: o.content, by: 'ai:cos-probe' }),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`AI ${o.label} ->`, res.status, JSON.stringify({ success: body.success, code: body.code, error: body.error }));
}
await page.waitForTimeout(3000);

const marks = await page.evaluate(() => {
  const v = window.proof.editor.ctx.get('editorView');
  return (window.proof.getAllMarks() || [])
    .filter((m) => ['insert', 'delete', 'replace'].includes(m.kind))
    .map((m) => ({ id: m.id, kind: m.kind, covered: m.range ? v.state.doc.textBetween(m.range.from, m.range.to) : null, content: m.data?.content ?? null }));
});
for (const m of marks) console.log('mark in page:', JSON.stringify(m));
const st0 = await (await fetch(`${u.origin}/documents/${slug}/state`, { headers: auth })).json();
console.log('server pending before accepting:', JSON.stringify(Object.values(st0.marks || {}).filter((m) => m.status === 'pending').map((m) => m.quote)));

for (const o of ops) {
  const m = marks.find((x) => (x.covered || '').includes(o.needle));
  if (!m) { console.log(`accept ${o.label}: NO MARK in page`); continue; }
  const returned = await page.evaluate((id) => window.proof.markAccept(id), m.id);
  await page.waitForTimeout(1500);
  console.log(`accept ${o.label}: returned ${returned}; paragraphs: ${JSON.stringify(await paragraphs())}`);
}

await page.waitForTimeout(3000);
await openDoc();
console.log('paragraphs after reload:', JSON.stringify(await paragraphs()));
const st = await (await fetch(`${u.origin}/documents/${slug}/state`, { headers: auth })).json();
console.log('server:', JSON.stringify({
  readSource: st.readSource, projectionFresh: st.projectionFresh, revision: st.revision,
  pending: Object.values(st.marks || {}).filter((m) => m.status === 'pending').map((m) => m.quote),
  markdown: st.markdown,
}));
await browser.close();
