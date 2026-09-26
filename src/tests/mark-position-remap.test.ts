// Stored mark positions follow the text, and marks-only writes reach the collaborative state.
// 1. An AI edit above pending suggestions and comments (/edit/v2 replace_block, several ops at once,
//    a new suggest-insert, an accepted replacement) maps every stored range / startRel / endRel
//    through the change, so Accept still applies to the words the person marked, even when the
//    quote occurs twice.
// 2. A marks-only write with no route context (the dialect import's patchStoredMarksAsync) on a
//    document that already has persisted Yjs state reaches the Yjs marks map, which is what a page
//    loads; before, it reached only the documents row and the first page open dropped it.
// Authorship: Claude Opus 5 (worker fix/suggestion-positions), 2026-09-19, for Mike Wolf's Proof fork.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-remap-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
Object.assign(process.env, { PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test' });
delete process.env.PROOF_SOMA_AUTH_ENABLED;
delete process.env.PROOF_PUBLIC_ORIGIN;

const db = await import('../../server/db');
const { agentRoutes } = await import('../../server/agent-routes');
const remap = await import('../../server/mark-position-remap');
const { getHeadlessMilkdownParser, parseMarkdownWithHtmlFallback } = await import('../../server/milkdown-headless');
const { buildTextIndex } = await import('../editor/utils/text-range');
const engine = await import('../../server/document-engine');
const collab = await import('../../server/collab');
const { stripAllProofSpanTags } = await import('../../server/proof-span-strip');

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

const parser = await getHeadlessMilkdownParser();
const parse = (markdown: string) => {
  const parsed = parseMarkdownWithHtmlFallback(parser, markdown);
  assert.ok(parsed.doc, 'markdown parses');
  return parsed.doc as any;
};

/** Where the page would anchor `needle` (the nth occurrence): PM range and char offsets. */
function locate(markdown: string, needle: string, occurrence = 1) {
  const doc = parse(markdown);
  const index = buildTextIndex(doc)!;
  let at = -1;
  for (let i = 0; i < occurrence; i += 1) {
    at = index.text.indexOf(needle, at + 1);
    assert.ok(at >= 0, `"${needle}" #${occurrence} is in the text`);
  }
  const from = index.positions[at] as number;
  const to = (index.positions[at + needle.length - 1] as number) + 1;
  return { range: { from, to }, startRel: `char:${at}`, endRel: `char:${at + needle.length}` };
}

/** The text a stored mark's range and its char offsets point at, in the current document. */
function anchoredText(markdown: string, mark: Record<string, any>) {
  const doc = parse(markdown);
  const index = buildTextIndex(doc)!;
  const s = Number(String(mark.startRel).slice(5));
  const e = Number(String(mark.endRel).slice(5));
  return {
    byRange: mark.range ? doc.textBetween(mark.range.from, mark.range.to, '\n', '\n') : null,
    byChars: index.text.slice(s, e),
  };
}

const by = 'human:Mike';
const now = '2026-09-19T20:00:00.000Z';
const marksOf = (slug: string) => JSON.parse(db.getDocumentBySlug(slug)!.marks) as Record<string, any>;
const markdownOf = (slug: string) => db.getDocumentBySlug(slug)!.markdown;
const visibleOf = (slug: string) => stripAllProofSpanTags(markdownOf(slug));

function seedDoc(slug: string, token: string, markdown: string, marks: Record<string, unknown>) {
  db.createDocument(slug, markdown, marks as any, slug, `owner-${slug}`, token);
  return { 'x-share-token': token };
}

const revisionOf = async (slug: string, headers: Record<string, string>) => {
  const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, headers);
  assert.equal(state.status, 200, JSON.stringify(state.body).slice(0, 300));
  return state.body.revision as number;
};

try {
  await test('diff: hunks rebuild the new token list from the old one (randomized)', () => {
    for (let t = 0; t < 3000; t += 1) {
      const pick = () => Array.from({ length: Math.floor(Math.random() * 14) }, () => 'abc'[Math.floor(Math.random() * 3)]);
      const a = pick();
      const b = pick();
      for (const maxD of [2, 100]) {
        const hunks = remap.diffTokenHunks(a, b, maxD);
        const out: string[] = [];
        let pos = 0;
        for (const h of hunks) {
          assert.ok(h.oldStart >= pos);
          out.push(...a.slice(pos, h.oldStart), ...b.slice(h.newStart, h.newEnd));
          pos = h.oldEnd;
        }
        out.push(...a.slice(pos));
        assert.equal(out.join(''), b.join(''), `${a.join('')} -> ${b.join('')}`);
      }
    }
  });

  await test('map: a change above shifts later positions; one below leaves them', () => {
    const before = parse('Intro.\n\nThe mat is here.');
    const after = parse('Intro grown longer.\n\nThe mat is here.');
    const { map } = remap.buildDocumentChangeMap(before, after);
    const oldMat = locate('Intro.\n\nThe mat is here.', 'mat');
    const newMat = locate('Intro grown longer.\n\nThe mat is here.', 'mat');
    assert.equal(map.map(oldMat.range.from, 1), newMat.range.from);
    assert.equal(map.map(1, 1), 1, 'a position before the change is unchanged');
  });

  // Paragraphs: b1 heading, b2 intro, b3 "The mat is red.", b4 "The mat is blue X.", b5 middle, b6 tail.
  const docA = [
    '# Remap',
    '',
    'Intro line.',
    '',
    'The mat is red.',
    '',
    'The mat is blue X.',
    '',
    'Middle words stay.',
    '',
    'Tail words end with the mat.',
  ].join('\n');
  const insertAt = locate(docA, ' X');
  const replaceAt = locate(docA, 'The mat', 2);
  const commentAt = locate(docA, 'is blue');
  const tailAt = locate(docA, 'the mat', 1);
  const marksA = {
    'ins-1': { kind: 'insert', by, createdAt: now, status: 'pending', content: ' X', quote: 'X', ...insertAt },
    'rep-1': { kind: 'replace', by, createdAt: now, status: 'pending', content: 'The rug', quote: 'The mat', ...replaceAt },
    'com-1': { kind: 'comment', by, createdAt: now, quote: 'is blue', text: 'Why blue?', threadId: 'com-1', thread: [], replies: [], resolved: false, ...commentAt },
    'del-1': { kind: 'delete', by, createdAt: now, status: 'pending', quote: 'the mat', ...tailAt },
  };
  const OWNER_A = seedDoc('remap-a', 'secret-a-123', docA, marksA);
  const expectedText: Record<string, string> = { 'ins-1': ' X', 'rep-1': 'The mat', 'com-1': 'is blue', 'del-1': 'the mat' };

  await test('setup: every stored mark points at its words', () => {
    const marks = marksOf('remap-a');
    for (const [id, text] of Object.entries(expectedText)) {
      const got = anchoredText(markdownOf('remap-a'), marks[id]);
      assert.equal(got.byRange, text, `${id} range`);
      assert.equal(got.byChars, text, `${id} chars`);
    }
  });

  await test('/edit/v2 replace_block above N marks: every range and char offset shifts with the text', async () => {
    const r = await call('/api/agent/remap-a/edit/v2', 'POST', {
      by: 'ai:claude', baseRevision: await revisionOf('remap-a', OWNER_A),
      operations: [{ op: 'replace_block', ref: 'b2', block: { markdown: 'Intro line, now 11 longer.' } }],
    }, OWNER_A);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
    const markdown = markdownOf('remap-a');
    assert.ok(markdown.includes('Intro line, now 11 longer.'));
    const marks = marksOf('remap-a');
    for (const [id, text] of Object.entries(expectedText)) {
      assert.equal(marks[id]?.status ?? 'pending', 'pending', `${id} still pending`);
      const got = anchoredText(markdown, marks[id]);
      assert.equal(got.byRange, text, `${id} range points at its words (${JSON.stringify(marks[id].range)})`);
      assert.equal(got.byChars, text, `${id} char offsets point at its words (${marks[id].startRel})`);
    }
    assert.equal(marks['ins-1'].range.from - marksA['ins-1'].range.from, 15, 'shifted by the growth of the intro');
  });

  await test('several ops at once (above and between marks) shift each mark by the change before it', async () => {
    const r = await call('/api/agent/remap-a/edit/v2', 'POST', {
      by: 'ai:claude', baseRevision: await revisionOf('remap-a', OWNER_A),
      operations: [
        { op: 'replace_block', ref: 'b2', block: { markdown: 'Short.' } },
        { op: 'replace_block', ref: 'b5', block: { markdown: 'The middle paragraph is now considerably longer than it was.' } },
        { op: 'insert_after', ref: 'b3', blocks: [{ markdown: 'A brand new paragraph between.' }] },
      ],
    }, OWNER_A);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
    const markdown = markdownOf('remap-a');
    const marks = marksOf('remap-a');
    for (const [id, text] of Object.entries(expectedText)) {
      const got = anchoredText(markdown, marks[id]);
      assert.equal(got.byRange, text, `${id} range`);
      assert.equal(got.byChars, text, `${id} chars`);
    }
  });

  await test('Accept of a replace whose quote occurs twice applies to the marked (second) occurrence', async () => {
    const r = await call('/api/agent/remap-a/marks/accept', 'POST', { markId: 'rep-1', by }, OWNER_A);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
    const markdown = visibleOf('remap-a');
    assert.ok(markdown.includes('The mat is red.'), `the first "The mat" is untouched:\n${markdown}`);
    assert.ok(markdown.includes('The rug is blue'), `the second became "The rug":\n${markdown}`);
    const marks = marksOf('remap-a');
    for (const id of ['ins-1', 'com-1', 'del-1']) {
      const got = anchoredText(markdown, marks[id]);
      assert.equal(got.byRange, expectedText[id], `${id} still points at its words after the accept`);
    }
  });

  await test('an AI suggest-insert above (it inserts text) shifts the marks below it', async () => {
    const r = await call('/api/agent/remap-a/marks/suggest-insert', 'POST', { quote: 'Short.', content: ' An inserted clause.', by: 'ai:claude' }, OWNER_A);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
    const markdown = markdownOf('remap-a');
    assert.ok(markdown.includes('An inserted clause.'));
    const marks = marksOf('remap-a');
    for (const id of ['ins-1', 'com-1', 'del-1']) {
      const got = anchoredText(markdown, marks[id]);
      assert.equal(got.byRange, expectedText[id], `${id} range after the insert above`);
      assert.equal(got.byChars, expectedText[id], `${id} chars after the insert above`);
    }
  });

  await test('Accept of the delete lands on its own words (the tail), not an earlier "the mat"', async () => {
    const r = await call('/api/agent/remap-a/marks/accept', 'POST', { markId: 'del-1', by }, OWNER_A);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
    const markdown = visibleOf('remap-a');
    assert.ok(/Tail words end with\s*\./.test(markdown), `the tail lost "the mat":\n${markdown}`);
    assert.ok(markdown.includes('The mat is red.'));
  });

  await test('a mark whose words the edit rewrote is kept (listed as orphaned), never dropped', async () => {
    const r = await call('/api/agent/remap-a/edit/v2', 'POST', {
      by: 'ai:claude', baseRevision: await revisionOf('remap-a', OWNER_A),
      operations: [{ op: 'replace_block', ref: 'b5', block: { markdown: 'Nothing of the old line is left here.' } }],
    }, OWNER_A);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
    const marks = marksOf('remap-a');
    assert.ok(marks['ins-1'], 'the insert is still stored');
    assert.equal(marks['ins-1'].status, 'pending');
    assert.ok(marks['com-1'], 'the comment is still stored');
    const state = await call('/api/agent/remap-a/state', 'GET', undefined, OWNER_A);
    assert.ok(state.body.orphanedMarks.some((m: any) => m.id === 'ins-1'), JSON.stringify(state.body.orphanedMarks));
  });

  await test('a marks-only write with no route context reaches the persisted Yjs marks map', async () => {
    const OWNER_B = seedDoc('remap-b', 'secret-b-123', 'First old phrase here.\n\nSecond old words here.', {});
    const first = await call('/api/agent/remap-b/marks/suggest-replace', 'POST', { quote: 'old phrase', content: 'new phrase', by: 'ai:claude' }, OWNER_B);
    assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 300));
    assert.ok((db.getDocumentBySlug('remap-b')!.y_state_version ?? 0) > 0, 'the document has persisted Yjs state');
    const patched = await engine.patchStoredMarksAsync('remap-b', (marks) => ({
      ...marks,
      'stored-only': { kind: 'replace', by: 'ai:claude', createdAt: now, status: 'pending', quote: 'old words', content: 'new words' } as any,
    }), 'ai:import');
    assert.equal(patched.status, 200, JSON.stringify(patched.body).slice(0, 300));
    collab.invalidateCollabDocument('remap-b');
    const handle = await collab.loadCanonicalYDoc('remap-b', { preferPersisted: true });
    assert.ok(handle, 'the canonical Yjs document loads');
    const yMarks = handle!.ydoc.getMap('marks').toJSON() as Record<string, unknown>;
    await handle!.cleanup?.();
    assert.ok(yMarks['stored-only'], `the Yjs marks map carries the stored-only suggestion: ${Object.keys(yMarks)}`);
    assert.ok(yMarks[first.body.markId], 'and the earlier one');
    const accepted = await call('/api/agent/remap-b/marks/accept', 'POST', { markId: 'stored-only', by }, OWNER_B);
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body).slice(0, 300));
    assert.ok(visibleOf('remap-b').includes('Second new words here.'), visibleOf('remap-b'));
  });

  console.log(`\n${passed} mark-position-remap tests passed`);
} finally {
  server.close();
  rmSync(temp, { recursive: true, force: true });
}
process.exit(0);
