// Rejecting a pending block insert removes only the insert, never the text it was anchored to
// (bead ac-1kf). On 2026-09-28 an AI's suggest-insert with content "\n\n10. **…**", anchored on
// item 9 of a numbered list, was nested under item 9's paragraph. Markdown cannot start a list
// numbered 10 inside a paragraph, so the save turned it into an escaped "10\." continuation line
// of item 9, and the reject deleted item 9's whole paragraph. Now a list insert joins the list
// as a sibling item, every block insert must survive the save as its own blocks, and a reject
// removes a block only when the suggestion covers all of its text.
// Authorship: Claude Opus 5.5 (CCc, seat ccc-adhoc), 2026-09-28, for Mike Wolf's Proof fork.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-reject-insert-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
Object.assign(process.env, { PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test' });
delete process.env.PROOF_SOMA_AUTH_ENABLED;
delete process.env.PROOF_PUBLIC_ORIGIN;

const db = await import('../../server/db');
const { agentRoutes } = await import('../../server/agent-routes');
const { Schema } = await import('@milkdown/kit/prose/model');
const { EditorState, Plugin } = await import('@milkdown/kit/prose/state');
const { marksPluginKey, reject: rejectMark } = await import('../editor/plugins/marks');

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    ordered_list: { content: 'list_item+', group: 'block' },
    list_item: { content: 'paragraph block*' },
    image: { inline: true, group: 'inline', attrs: { src: { default: '' } } },
    text: { group: 'inline' },
  },
  marks: {
    proofSuggestion: {
      attrs: { id: { default: null }, kind: { default: 'replace' }, by: { default: 'unknown' } },
      inclusive: false,
      spanning: true,
    },
  },
});
const MARK_ID = 'editor-block-insert';
const insertMark = () => schema.marks.proofSuggestion.create({ id: MARK_ID, kind: 'insert', by: 'ai:tester' });
function editorView(doc: any): any {
  const metadata = {
    [MARK_ID]: {
      kind: 'insert', by: 'ai:tester', createdAt: '2026-09-28T02:00:00.000Z',
      quote: 'inserted', content: '\n\ninserted', status: 'pending', insertStructure: 'block',
    },
  };
  const plugin = new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata, activeMarkId: null }),
      apply: (tr: any, value: any) => {
        const meta = tr.getMeta(marksPluginKey);
        return meta?.type === 'SET_METADATA' ? { ...value, metadata: meta.metadata } : value;
      },
    },
  });
  let state = EditorState.create({ schema, doc, plugins: [plugin] });
  return {
    get state() { return state; },
    dispatch(tr: any) { state = state.apply(tr); },
  };
}

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const app = express();
app.use(express.json());
app.use('/api/agent', agentRoutes);
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const clientHeaders = { 'X-Proof-Client-Version': '0.34.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
const call = async (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...clientHeaders, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
};

const SECRET = 'owner-secret-123';
const OWNER = { 'x-share-token': SECRET };
const by = 'ai:tester';
const ITEM_8 = '8. **Who owns the domain?** Mike does.';
const ITEM_9 = '9. **Which company collects the money?** Not decided.';
const QUESTIONS = ['# Questions', '', ITEM_8, ITEM_9, '', 'Closing paragraph.'].join('\n');

let docCount = 0;
function newDoc(markdown: string, marks: Record<string, unknown> = {}): string {
  docCount += 1;
  const slug = `reject-insert-${docCount}`;
  db.createDocument(slug, markdown, marks, 'Reject insert', `owner-${docCount}`, SECRET);
  return slug;
}
const markdownOf = (slug: string): string => db.getDocumentBySlug(slug)!.markdown;
const lines = (markdown: string): string[] => markdown.split('\n').map(line => line.trimEnd()).filter(Boolean);

async function suggestInsert(slug: string, quote: string, content: string) {
  const added = await call(`/api/agent/${slug}/marks/suggest-insert`, 'POST', { quote, content, by }, OWNER);
  assert.equal(added.status, 200, JSON.stringify(added.body).slice(0, 400));
  return added.body as { markId: string; marks: Record<string, any> };
}
async function decide(slug: string, markId: string, action: 'accept' | 'reject') {
  const r = await call(`/api/agent/${slug}/marks/${action}`, 'POST', { markId, by: 'human:tester' }, OWNER);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
}

try {
  await test('incident shape: a "10. …" insert anchored on item 9 is a sibling item 10, not an escaped line in item 9', async () => {
    const slug = newDoc(QUESTIONS);
    const added = await suggestInsert(slug, 'Which company collects the money?', '\n\n10. **New question?** Some detail.');
    assert.equal(added.marks[added.markId].insertStructure, 'block');
    const pending = markdownOf(slug);
    assert.ok(!pending.includes('10\\.'), `the marker must not be escaped into text:\n${pending}`);
    assert.deepEqual(lines(pending).slice(1, 4), [ITEM_8, ITEM_9, '10. **New question?** Some detail.'], pending);
  });

  await test('incident shape: rejecting it leaves item 9 exactly as it was', async () => {
    const slug = newDoc(QUESTIONS);
    const before = lines(markdownOf(slug));
    const added = await suggestInsert(slug, 'Which company collects the money?', '\n\n10. **New question?** Some detail.');
    await decide(slug, added.markId, 'reject');
    const after = markdownOf(slug);
    assert.ok(after.includes(ITEM_9), `item 9 must keep its question:\n${after}`);
    assert.ok(!after.includes('New question'), after);
    assert.deepEqual(lines(after), before);
  });

  await test('accepting it keeps item 9 and the new item 10 as separate items', async () => {
    const slug = newDoc(QUESTIONS);
    const added = await suggestInsert(slug, 'Which company collects the money?', '\n\n10. **New question?** Some detail.');
    await decide(slug, added.markId, 'accept');
    assert.deepEqual(lines(markdownOf(slug)).slice(1, 4), [ITEM_8, ITEM_9, '10. **New question?** Some detail.']);
  });

  await test('an item inserted mid-list goes after its anchor item; rejecting it restores the list', async () => {
    const slug = newDoc(QUESTIONS);
    const before = lines(markdownOf(slug));
    const added = await suggestInsert(slug, 'Who owns the domain?', '\n\n9. **Where is DNS hosted?** GoDaddy.');
    const pending = lines(markdownOf(slug));
    assert.equal(pending[2], '9. **Where is DNS hosted?** GoDaddy.', pending.join('\n'));
    assert.ok(pending[3].includes('Which company collects the money?'), pending.join('\n'));
    await decide(slug, added.markId, 'reject');
    assert.deepEqual(lines(markdownOf(slug)), before);
  });

  await test('a bullet insert joins a bullet list; rejecting it restores the list', async () => {
    // The serializer writes bullets as "*", so the source uses "*" to compare line for line.
    const slug = newDoc(['Intro.', '', '* first point', '* second point', '', 'After.'].join('\n'));
    const before = lines(markdownOf(slug));
    const added = await suggestInsert(slug, 'first point', '\n\n- inserted point');
    assert.deepEqual(lines(markdownOf(slug)).slice(1, 4), ['* first point', '* inserted point', '* second point']);
    await decide(slug, added.markId, 'reject');
    assert.deepEqual(lines(markdownOf(slug)), before);
  });

  await test('a plain paragraph insert on a list item still nests under it and rejects cleanly', async () => {
    const slug = newDoc(QUESTIONS);
    const added = await suggestInsert(slug, 'Which company collects the money?', '\n\nA plain new paragraph.');
    assert.ok(markdownOf(slug).includes('A plain new paragraph.'));
    await decide(slug, added.markId, 'reject');
    const after = markdownOf(slug);
    assert.ok(after.includes(ITEM_9), after);
    assert.ok(!after.includes('A plain new paragraph.'), after);
  });

  await test('a top-level paragraph insert still rejects to the original document', async () => {
    const slug = newDoc(['First paragraph.', '', 'Second paragraph.'].join('\n'));
    const before = lines(markdownOf(slug));
    const added = await suggestInsert(slug, 'First paragraph.', '\n\nInserted paragraph.');
    assert.deepEqual(lines(markdownOf(slug)), ['First paragraph.', 'Inserted paragraph.', 'Second paragraph.']);
    await decide(slug, added.markId, 'reject');
    assert.deepEqual(lines(markdownOf(slug)), before);
  });

  await test('legacy shape: a pending block insert already folded into its anchor item is rejected without touching the anchor', async () => {
    // What a document saved before this fix holds: the insert's text is a continuation line of item 9.
    const markId = 'legacy-folded-insert';
    const slug = newDoc(
      ['# Questions', '', ITEM_8, ITEM_9, '   10\\. **New question?** Some detail.', '', 'Closing paragraph.'].join('\n'),
      {
        [markId]: {
          kind: 'insert',
          by,
          createdAt: '2026-09-28T02:00:00.000Z',
          quote: 'New question? Some detail.',
          content: '\n\n10. **New question?** Some detail.',
          status: 'pending',
          insertStructure: 'block',
        },
      },
    );
    await decide(slug, markId, 'reject');
    const after = markdownOf(slug);
    assert.ok(after.includes(ITEM_9), `item 9 must keep its question:\n${after}`);
    assert.ok(after.includes(ITEM_8), after);
    assert.ok(!after.includes('New question'), after);
    assert.ok(after.includes('Closing paragraph.'), after);
  });

  // Editor level: the same reject() runs on the page's Reject button and inside the server.
  await test('editor: an image sharing the block with a folded insert survives the reject', () => {
    const view = editorView(schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('Intro paragraph.')]),
      schema.node('paragraph', null, [
        schema.node('image', { src: 'https://example.com/logo.png' }),
        schema.text('Folded insert text.', [insertMark()]),
      ]),
    ]));
    assert.equal(rejectMark(view, MARK_ID), true);
    const images: string[] = [];
    view.state.doc.descendants((node: any) => { if (node.type.name === 'image') images.push(node.attrs.src); });
    assert.deepEqual(images, ['https://example.com/logo.png'], 'the image must stay');
    assert.equal(view.state.doc.textContent, 'Intro paragraph.');
  });

  await test('editor: anchor text sharing the block with a folded insert survives the reject', () => {
    const view = editorView(schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Which company collects the money? Not decided. '),
        schema.text('New question? Some detail.', [insertMark()]),
      ]),
    ]));
    assert.equal(rejectMark(view, MARK_ID), true);
    assert.equal(view.state.doc.textContent, 'Which company collects the money? Not decided. ');
  });

  await test('editor: rejecting an inserted list item removes the item, not an empty shell', () => {
    const view = editorView(schema.node('doc', null, [
      schema.node('ordered_list', null, [
        schema.node('list_item', null, [schema.node('paragraph', null, [schema.text('Item nine')])]),
        schema.node('list_item', null, [schema.node('paragraph', null, [schema.text('Item ten', [insertMark()])])]),
      ]),
    ]));
    assert.equal(rejectMark(view, MARK_ID), true);
    const list = view.state.doc.firstChild!;
    assert.equal(list.type.name, 'ordered_list');
    assert.equal(list.childCount, 1, view.state.doc.toString());
    assert.equal(list.textContent, 'Item nine');
  });

  await test('editor: rejecting a list that is all insert removes the whole list', () => {
    const view = editorView(schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('Before.')]),
      schema.node('ordered_list', null, [
        schema.node('list_item', null, [schema.node('paragraph', null, [schema.text('Only item', [insertMark()])])]),
      ]),
    ]));
    assert.equal(rejectMark(view, MARK_ID), true);
    assert.equal(view.state.doc.childCount, 1, view.state.doc.toString());
    assert.equal(view.state.doc.textContent, 'Before.');
  });

  console.log(`\n${passed} reject-block-insert tests passed`);
} finally {
  server.close();
  rmSync(temp, { recursive: true, force: true });
}
process.exit(0);
