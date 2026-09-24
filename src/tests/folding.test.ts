// Proof Documents Step B2: folding — sections, hidden lines, fold-to-level, section Issue counts,
// section marking policy, the reading walk over folded sections, and the batch line-mark routes.
// Authorship: Claude Opus 5 (worker proof-fold), 2026-09-18, in the style of line-marks.test.ts.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-folding-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
const shared = await import('../shared/line-marks');
const folding = await import('../shared/folding');
const { ReadingWalk } = await import('../shared/reading-walk');
const serverLines = await import('../../server/line-marks');
const db = await import('../../server/db');
const { apiRoutes } = await import('../../server/routes');
const { agentRoutes } = await import('../../server/agent-routes');

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

// Lines: 0 Title(H1) 1 Intro 2 Goals(H2) 3 g1 4 g2(list) 5 g3(list) 6 Detail(H3) 7 d1 8 Plan(H2) 9 p1 10 Appendix(H1) 11 a1
const doc = `# Title

Intro paragraph.

## Goals

First goal paragraph.

- Goal item one
- Goal item two

### Detail

Detail paragraph.

## Plan

Plan paragraph.

# Appendix

Appendix paragraph.`;

const app = express();
app.use(express.json());
app.use('/api', apiRoutes);
app.use('/api/agent', agentRoutes);
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const clientHeaders = { 'X-Proof-Client-Version': '0.31.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
const call = async (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...clientHeaders, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
};

try {
  const lines = await serverLines.computeServerLines(doc);
  const sections = folding.computeSections(lines);
  const byText = (text: string) => lines.find(line => line.text === text)!.index;
  const TITLE = byText('Title');
  const GOALS = byText('Goals');
  const DETAIL = byText('Detail');
  const PLAN = byText('Plan');
  const APPENDIX = byText('Appendix');

  await test('lines: top-level headings carry their level; other lines do not', () => {
    assert.deepEqual(lines.filter(l => l.level !== undefined).map(l => [l.text, l.level]),
      [['Title', 1], ['Goals', 2], ['Detail', 3], ['Plan', 2], ['Appendix', 1]]);
    assert.equal(lines[1].level, undefined);
  });

  await test('sections nest by heading level: an H2 section ends at the next H1 or H2', () => {
    const get = (i: number) => folding.sectionByHeading(sections, i)!;
    assert.equal(sections.length, 5);
    assert.equal(get(TITLE).lineEnd, APPENDIX, 'H1 runs to the next H1');
    assert.equal(get(GOALS).lineEnd, PLAN, 'H2 stops at the next H2 (H3 inside)');
    assert.equal(get(DETAIL).lineEnd, PLAN);
    assert.equal(get(PLAN).lineEnd, APPENDIX, 'H2 stops at the next H1');
    assert.equal(get(APPENDIX).lineEnd, lines.length);
    assert.equal(get(DETAIL).parent, GOALS);
    assert.equal(get(GOALS).parent, TITLE);
    assert.equal(get(APPENDIX).parent, null);
    assert.deepEqual(folding.sectionLineIndices(get(GOALS)), [GOALS, GOALS + 1, GOALS + 2, GOALS + 3, DETAIL, DETAIL + 1]);
  });

  await test('hidden lines and blocks: bodies of folded sections only; headings of folded sections stay', () => {
    const goals = folding.sectionByHeading(sections, GOALS)!;
    const folded = new Set([goals.key]);
    const hidden = folding.hiddenLineSet(sections, folded);
    assert.deepEqual([...hidden].sort((a, b) => a - b), [GOALS + 1, GOALS + 2, GOALS + 3, DETAIL, DETAIL + 1]);
    assert.ok(!hidden.has(GOALS) && !hidden.has(PLAN));
    const blocks = folding.hiddenBlockRanges(sections, folded);
    assert.deepEqual(blocks, [[goals.block + 1, goals.endBlock]]);
    assert.equal(folding.visibleLineFor(sections, folded, DETAIL + 1), GOALS);
    // Nested: folding Title and Detail merges ranges and the outermost heading stands for hidden lines.
    const both = new Set([folding.sectionByHeading(sections, TITLE)!.key, folding.sectionByHeading(sections, DETAIL)!.key]);
    assert.equal(folding.hiddenBlockRanges(sections, both).length, 1);
    assert.equal(folding.visibleLineFor(sections, both, DETAIL + 1), TITLE);
    assert.deepEqual(folding.foldedAncestors(sections, both, DETAIL + 1).map(s => s.headingIndex), [TITLE, DETAIL]);
  });

  await test('section agreement captures text identities and excludes new or changed lines', () => {
    const section = folding.sectionByHeading(sections, GOALS)!;
    const scope = folding.captureSectionScope(section, lines);
    const inserted = { ...lines[GOALS + 1], text: 'New line', hash: 'new-identity' };
    const now = [...lines.slice(0, GOALS + 1), inserted, ...lines.slice(GOALS + 1)]
      .map((line, index) => ({ ...line, index }));
    const duplicate = [...lines, { ...lines[GOALS + 1], index: lines.length, occurrence: 2 }];
    assert.ok(!folding.resolveSectionScope(scope, duplicate).includes(GOALS + 1), 'ambiguous duplicate text must not gain agreement');
    const resolved = folding.resolveSectionScope(scope, now);
    assert.equal(resolved.length, scope.lines.length);
    assert.ok(!resolved.includes(GOALS + 1), 'concurrent insertion cannot be agreed implicitly');
    now[GOALS + 2] = { ...now[GOALS + 2], text: 'Changed', hash: 'changed' };
    assert.equal(folding.resolveSectionScope(scope, now).length, scope.lines.length - 1);
  });

  await test('section agreement is offered only when every line of the section is visible', () => {
    const goals = folding.sectionByHeading(sections, GOALS)!;
    const detail = folding.sectionByHeading(sections, DETAIL)!;
    const open = folding.sectionAgreementOffer(goals, sections, new Set());
    assert.equal(open.allVisible, true);
    assert.equal(open.lineCount, folding.sectionLineIndices(goals).length);
    assert.deepEqual(open.collapsedHeadings, []);
    const detailFolded = new Set([detail.key]);
    const hiddenDetail = folding.sectionAgreementOffer(goals, sections, detailFolded);
    assert.equal(hiddenDetail.allVisible, false, 'a collapsed subsection hides lines the reader has not seen');
    assert.deepEqual(hiddenDetail.collapsedHeadings, [DETAIL]);
    assert.equal(hiddenDetail.lineCount, open.lineCount, 'the count names every line, including the hidden ones');
    const whole = new Set([goals.key, detail.key]);
    const hiddenGoals = folding.sectionAgreementOffer(goals, sections, whole);
    assert.equal(hiddenGoals.allVisible, false);
    assert.deepEqual(hiddenGoals.collapsedHeadings, [GOALS, DETAIL]);
    const shown = new Set(whole);
    for (const heading of hiddenGoals.collapsedHeadings) {
      const key = folding.sectionByHeading(sections, heading)!.key;
      shown.delete(key);
    }
    assert.equal(folding.sectionAgreementOffer(goals, sections, shown).allVisible, true);
    // The capture still lists hidden lines. The offer is what stops them being agreed unseen.
    const captured = folding.captureSectionScope(goals, lines);
    assert.equal(captured.lines.length, hiddenDetail.lineCount);
  });

  await test('section Issue count: the same Issues as the top bar, restricted to the section (review marks by position)', () => {
    const team = ['human:A'];
    const lineMarks = lines.filter(l => l.index !== GOALS + 1 && l.index !== PLAN + 1)
      .map((l, i) => ({ id: `m${i}`, by: 'human:A', status: 'seen' as const, at: 't', anchor: shared.anchorForLine(l) }));
    const reviewMarks = [{ id: 'c1', kind: 'comment', by: 'human:A', quote: 'Detail', pos: lines[DETAIL + 1].pos + 2, open: true }];
    const summary = shared.computeIssues({ lines, lineMarks, team, reviewMarks });
    const count = (i: number) => folding.sectionIssueCount(folding.sectionByHeading(sections, i)!, lines, summary);
    assert.deepEqual(count(GOALS), { total: 2, lines: 1, reviewMarks: 1, asks: 0, aids: 0 });
    assert.deepEqual(count(DETAIL), { total: 1, lines: 0, reviewMarks: 1, asks: 0, aids: 0 });
    assert.deepEqual(count(PLAN), { total: 1, lines: 1, reviewMarks: 0, asks: 0, aids: 0 });
    assert.deepEqual(count(TITLE), { total: 3, lines: 2, reviewMarks: 1, asks: 0, aids: 0 }, 'a parent counts its sub-sections');
    assert.equal(count(APPENDIX).total, 0, 'resolved section: ✓');
  });

  await test('section mark plan: keeps my rejects, never downgrades, skips same, re-marks stale', () => {
    const mine = new Map<number, { status: any; reason: string | null; current: boolean }>([
      [1, { status: 'rejected', reason: 'no', current: true }],
      [2, { status: 'approved', reason: null, current: true }],
      [3, { status: 'agreed', reason: null, current: true }],
      [4, { status: 'seen', reason: null, current: true }],
      [5, { status: 'approved', reason: null, current: false }],
    ]);
    const plan = folding.planSectionMark([0, 1, 2, 3, 4, 5], 'agreed', i => mine.get(i) ?? null);
    assert.deepEqual(plan.apply, [0, 4, 5]);
    assert.deepEqual(plan.skipped, [{ lineIndex: 1, reason: 'rejected' }, { lineIndex: 2, reason: 'stronger' }, { lineIndex: 3, reason: 'same' }]);
    assert.equal(folding.FOLDING.allowSectionReject, false);
    assert.equal(folding.FOLDING.foldedHeadingScope, 'heading');
    assert.equal(folding.FOLDING.unfoldedHeadingScope, 'heading');
  });

  await test('reading walk: a folded section is one step; scrolling past it reads and passes nothing hidden', () => {
    // 0 heading (folded) 1..3 hidden (2 holds a pending suggestion) 4 visible
    const walkLines = [
      { key: 'h', marks: [] },
      { key: 'a', marks: [], hidden: true },
      { key: 'b', marks: [{ id: 's1', kind: 'suggestion' as const }], hidden: true },
      { key: 'c', marks: [], hidden: true },
      { key: 'd', marks: [] },
    ];
    const walk = new ReadingWalk(walkLines, 0);
    assert.equal(walk.nextVisible(1), 4);
    walk.moveTo(4, 1000, 'scroll', [20, 20, 20, 20, 20]);
    const events = walk.drain();
    assert.deepEqual(events.filter(e => e.type === 'seen').map(e => (e as any).line), [0], 'only the heading was read');
    assert.equal(walk.snapshot().provisional.length, 0, 'a hidden suggestion was not provisionally accepted');
    assert.equal(walk.nextVisible(-1), 0);
  });

  // ---------------- HTTP routes ----------------
  const slug = 'fold-test';
  db.createDocument(slug, doc, {}, 'Folding test', 'owner-1', 'owner-secret-123');
  const editor = db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Claude (COS)', requestedBy: 'test', requestedFrom: '127.0.0.1' });
  const goalsSection = folding.sectionByHeading(sections, GOALS)!;
  const goalLines = folding.sectionLineIndices(goalsSection);

  await test('page batch: marking a section is one request; each line gets the mark', async () => {
    const set = await call(`/api/documents/${slug}/line-marks`, 'POST', {
      by: 'human:Eric', status: 'agreed', section: { heading: 'Goals' },
      lines: goalLines.map(i => ({ anchor: shared.anchorForLine(lines[i]) })),
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.count, goalLines.length);
    const list = await call(`/api/documents/${slug}/line-marks`);
    assert.equal(list.body.lineMarks.length, goalLines.length);
    assert.ok(list.body.lineMarks.every((m: any) => m.status === 'agreed' && m.by === 'guest:Eric'));
    const events = db.getDb().prepare(`SELECT event_type, event_data FROM document_events WHERE document_slug = ? AND event_type = 'line_mark.batch'`).all(slug) as Array<{ event_data: string }>;
    assert.equal(events.length, 1);
    assert.equal(JSON.parse(events[0].event_data).count, goalLines.length);
  });

  await test('page batch: per-line status restores earlier marks (undo); unseen removes', async () => {
    const undo = await call(`/api/documents/${slug}/line-marks`, 'POST', {
      by: 'human:Eric', status: 'unseen',
      lines: goalLines.map((i, n) => ({ anchor: shared.anchorForLine(lines[i]), ...(n === 0 ? { status: 'seen' } : {}) })),
    });
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    const list = await call(`/api/documents/${slug}/line-marks`);
    assert.equal(list.body.lineMarks.length, 1);
    assert.equal(list.body.lineMarks[0].status, 'seen');
  });

  await test('page batch: one invalid entry writes nothing and names its index', async () => {
    const bad = await call(`/api/documents/${slug}/line-marks`, 'POST', {
      by: 'human:Eric', status: 'agreed',
      lines: [{ anchor: shared.anchorForLine(lines[PLAN]) }, { anchor: { hash: '' } }],
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_ANCHOR');
    assert.equal(bad.body.index, 1);
    const reject = await call(`/api/documents/${slug}/line-marks`, 'POST', {
      by: 'human:Eric', status: 'rejected', lines: [{ anchor: shared.anchorForLine(lines[PLAN]) }],
    });
    assert.equal(reject.body.code, 'REASON_REQUIRED');
    const list = await call(`/api/documents/${slug}/line-marks`);
    assert.equal(list.body.lineMarks.length, 1, 'nothing was written');
    const empty = await call(`/api/documents/${slug}/line-marks`, 'POST', { by: 'human:Eric', status: 'seen', lines: [] });
    assert.equal(empty.body.code, 'INVALID_LINES');
  });

  await test('agent section: marks the heading and every line of its section; reject is refused', async () => {
    const headers = { 'x-share-token': editor.secret };
    const set = await call(`/api/agent/${slug}/marks/line`, 'POST', { status: 'seen', section: { quote: 'Goals' } }, headers);
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.count, goalLines.length);
    assert.equal(set.body.section.heading.lineIndex, GOALS);
    const reject = await call(`/api/agent/${slug}/marks/line`, 'POST', { status: 'rejected', reason: 'x', section: { quote: 'Goals' } }, headers);
    assert.equal(reject.status, 400);
    assert.equal(reject.body.code, 'SECTION_REJECT_NOT_ALLOWED');
    const notHeading = await call(`/api/agent/${slug}/marks/line`, 'POST', { status: 'seen', section: { quote: 'Plan paragraph' } }, headers);
    assert.equal(notHeading.body.code, 'NOT_A_HEADING');
  });

  await test('agent lines: a batch of targets, each with an optional status of its own', async () => {
    const headers = { 'x-share-token': editor.secret };
    const set = await call(`/api/agent/${slug}/marks/line`, 'POST', {
      status: 'agreed',
      lines: [{ quote: 'Plan paragraph' }, { lineIndex: APPENDIX }, { quote: 'Intro', status: 'rejected', reason: 'Too short' }],
    }, headers);
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual(set.body.lines.map((l: any) => l.lineIndex), [PLAN + 1, APPENDIX, 1]);
    assert.deepEqual(set.body.lineMarks.map((m: any) => m.status), ['agreed', 'agreed', 'rejected']);
    const missing = await call(`/api/agent/${slug}/marks/line`, 'POST', { status: 'seen', lines: [{ quote: 'Plan paragraph' }, { quote: 'no such text' }] }, headers);
    assert.equal(missing.status, 409);
    assert.equal(missing.body.index, 1);
  });

  await test('/state lists sections with their Issue counts', async () => {
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, { 'x-share-token': editor.secret });
    assert.equal(state.status, 200);
    const outline = state.body.sections as Array<any>;
    assert.deepEqual(outline.map(s => [s.text, s.level]), [['Title', 1], ['Goals', 2], ['Detail', 3], ['Plan', 2], ['Appendix', 1]]);
    assert.ok(outline.every(s => typeof s.issues === 'number' && typeof s.ref === 'string'));
    assert.equal(outline[1].lineEnd, PLAN);
  });

  console.log(`\nfolding tests: ${passed} passed`);
} finally {
  server.close();
  rmSync(temp, { recursive: true, force: true });
}
