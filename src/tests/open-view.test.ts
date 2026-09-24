/**
 * Accord round 2, stage C — Open and Accord.
 *
 * The load-bearing test is the first one: the Issues pill, the amber dots and the Open list must
 * count exactly the same set, and they must be UNABLE to disagree. Not "they agree on these six
 * fixtures" — a thousand random documents, under both settings of the one policy flag that changes
 * what Open means, with every consumer read through the function the product actually calls.
 *
 * Authorship: Mike Wolf (rulings), built by Claude Opus 5 (worker accord-open), 2026-09-22.
 */
import assert from 'node:assert/strict';
import {
  OPEN_VIEW_POLICY,
  ZERO_POLICY,
  accordHeader,
  openLayout,
  openView,
  zeroMoment,
} from '../shared/open-view';
import { needsYouLines } from '../shared/layout-status';
import { needsYouItems } from '../shared/layout-panels';
import { participantStatus, personalCompletionText } from '../shared/participant-status';
import {
  LINE_MARK_POLICY,
  anchorForLine,
  buildLineStates,
  computeIssues,
  findLapseTarget,
  hashLine,
  normalizeLineText,
  type DocLine,
  type LineMark,
  type LineMarkStatus,
  type ProofIssue,
} from '../shared/line-marks';
import { evaluateThreads, startThread, type Thread, type ThreadMeta, type ThreadView } from '../shared/threads';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

// ---------------------------------------------------------------- fixtures

function makeLines(texts: string[], kinds: string[] = []): DocLine[] {
  const seen = new Map<string, number>();
  let pos = 0;
  return texts.map((raw, index) => {
    const kind = kinds[index] ?? 'paragraph';
    const text = normalizeLineText(raw);
    const hash = hashLine(kind, text);
    const occurrence = seen.get(hash) ?? 0;
    seen.set(hash, occurrence + 1);
    const line: DocLine = { index, kind, text, hash, occurrence, pos, nodeSize: text.length + 2, block: index };
    pos += line.nodeSize;
    return line;
  });
}

function mark(line: DocLine, by: string, status: LineMarkStatus, at = '2026-09-22T10:00:00.000Z'): LineMark {
  return { id: `m-${by}-${line.index}-${at}`, by, status, at, anchor: { ...anchorForLine(line), text: line.text }, via: 'click' };
}

const ME = 'human:mike@x.com';
const ERIC = 'human:eric@x.com';
const IZZY = 'ai:izzy';

// ============================================================================
// 1. The three cannot disagree
// ============================================================================

/** A small deterministic PRNG, so a failure is reproducible from its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
}

function randomIssues(random: () => number, lineCount: number): ProofIssue[] {
  const issues: ProofIssue[] = [];
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const n = Math.floor(random() * 9);
  for (let i = 0; i < n; i += 1) {
    const lineIndex = Math.floor(random() * lineCount);
    const pos = lineIndex * 10;
    const base = { lineIndex, pos, kind: 'paragraph', excerpt: `line ${lineIndex}` };
    switch (pick(['line', 'ask', 'comment', 'suggestion', 'objection', 'uncertain', 'alternative', 'ttl', 'do', 'nomination'] as const)) {
      case 'line':
        issues.push({
          type: 'line', ...base, hash: 'h',
          reasons: pick([['unseen'], ['changed'], ['unseen', 'changed'], ['rejected']] as const).slice(),
          unseenBy: random() < 0.5 ? [ME] : [ERIC],
          changedFor: random() < 0.5 ? [ME] : [],
          rejectedBy: random() < 0.3 ? [{ by: ERIC, reason: 'no' }] : [],
          skimmedBy: [],
        });
        break;
      case 'ask':
        issues.push({ type: 'ask', askId: `a${i}`, ...base, by: ERIC, recommend: 'yes', openFor: random() < 0.6 ? [ME] : [ERIC], snoozedFor: random() < 0.2 ? [ME] : [] });
        break;
      case 'comment':
        issues.push({ type: 'comment', markId: `c${i}`, pos, kind: 'comment', by: random() < 0.5 ? ME : ERIC, excerpt: 'x' });
        break;
      case 'suggestion':
        issues.push({ type: 'suggestion', markId: `s${i}`, pos, kind: 'replace', by: random() < 0.5 ? ME : IZZY, excerpt: 'x' });
        break;
      case 'objection':
        issues.push({ type: 'objection', objectionId: `o${i}`, lineIndex, lineIndices: [lineIndex], pos, kind: 'paragraph', excerpt: 'x', by: random() < 0.5 ? ME : ERIC, reason: 'r', condition: null, deletedLines: 0, repairPending: false });
        break;
      case 'uncertain':
        issues.push({ type: 'uncertain', flagId: `u${i}`, ...base, by: ERIC, note: null, openFor: random() < 0.6 ? [ME] : [] });
        break;
      case 'alternative':
        issues.push({ type: 'alternative', ...base, alternatives: 2, openFor: random() < 0.6 ? [ME] : [], disagree: false });
        break;
      case 'ttl':
        issues.push({ type: 'ttl', ttlId: `t${i}`, ...base, by: ERIC, expiresAt: '', reason: 'expired', openFor: random() < 0.5 ? [ME] : [] });
        break;
      case 'do':
        issues.push({ type: 'do', doId: `d${i}`, ...base, by: ERIC, state: 'proposed', label: 'go', openFor: random() < 0.6 ? [ME] : [] });
        break;
      default:
        // A nomination sits on no line: it must never produce a dot, a row or a count.
        issues.push({ type: 'nomination', nominationId: `n${i}`, lineIndex: null, pos: null, kind: 'nomination', excerpt: 'x', by: IZZY, email: 'a@b.c', name: null, why: 'w', openFor: [ME] });
        break;
    }
  }
  return issues;
}

function invariant(label: string, issues: ProofIssue[], lines: DocLine[], states: ReturnType<typeof buildLineStates>, threads: ThreadView[]): void {
  const lineAtPos = (pos: number) => (pos % 10 === 0 ? pos / 10 : -1);
  const full = openView({ issues, viewer: ME, lineAtPos, threads, team: [ME, ERIC, IZZY], states, lineCount: lines.length });

  // The three surfaces, each read through the function the product calls for it.
  const pill = full.count;                 // toolbar: openView(...).count
  const dots = full.lines;                 // margin:  openView(...).lines
  const rows = full.items.map(i => i.line); // Open list / Navigator: openView(...).items

  assert.deepEqual(dots, rows, `${label}: the amber dots and the Open list name different lines`);
  assert.equal(pill, rows.length, `${label}: the Issues pill and the Open list count differently`);
  assert.deepEqual([...dots].sort((a, b) => a - b), dots, `${label}: the dots are not in document order`);
  assert.equal(new Set(dots).size, dots.length, `${label}: a line got two rows`);
  for (const line of dots) assert.ok(line >= 0 && line < lines.length, `${label}: a row points off the document`);

  // ...and the two older entry points, which now delegate, must agree with them exactly.
  const viaStatus = needsYouLines(issues, ME, lineAtPos);
  const viaPanels = needsYouItems(issues, ME, lineAtPos).map(i => i.line);
  const withoutThreads = openView({ issues, viewer: ME, lineAtPos, lineCount: lines.length }).lines;
  assert.deepEqual(viaStatus, withoutThreads, `${label}: needsYouLines drifted from openView`);
  assert.deepEqual(viaPanels, withoutThreads, `${label}: needsYouItems drifted from openView`);

  // The header and the status module are one computation. A later surface that publishes the
  // same object (the server's /state participantStatus) cannot disagree with the header.
  const team = [ME, ERIC, IZZY];
  const status = participantStatus({ states, team });
  const h = accordHeader({ states, team, viewer: ME, name: actor => actor });
  assert.deepEqual(h.status, status, `${label}: the header did not read the shared status`);
  assert.deepEqual(h.agreed, status.participants.filter(person => person.agreed).map(person => person.actor));
  for (const person of status.participants) {
    const who = person.actor === ME ? 'You' : person.actor;
    if (!person.agreed) assert.ok(!h.agreed.includes(person.actor), `${label}: ${who} shown as agreed`);
    if (person.approved) {
      assert.ok(h.approved.includes(person.actor), `${label}: Approved missing for ${who}`);
      assert.ok(!h.agreed.includes(person.actor), `${label}: Approved shown as agreement`);
    } else {
      assert.ok(!h.approved.includes(person.actor), `${label}: ${who} listed as Approved`);
    }
    if (person.counts.rejected > 0) {
      const clause = h.clauses.find(item => item.actor === person.actor);
      assert.ok(clause, `${label}: no header clause for rejecter ${who}`);
      assert.match(clause?.text ?? '', new RegExp(`rejected ${person.counts.rejected} line`));
      assert.doesNotMatch(clause?.text ?? '', /has not read/, `${label}: ${who} rejected text and was called unread`);
    }
    if (person.counts.seen > 0 && !person.agreed) {
      assert.ok(!h.text.startsWith(`Agreed by ${who === 'You' ? 'you' : who}`), `${label}: Seen shown as agreement`);
    }
  }
}

test('the Issues pill, the amber dots and the Open list cannot disagree (1000 random documents, both policy settings)', () => {
  const lines = makeLines(Array.from({ length: 12 }, (_, i) => `Line ${i} carries some words worth reading here.`));
  const flag = OPEN_VIEW_POLICY as unknown as { unreadLinesAreOpen: boolean };
  const original = flag.unreadLinesAreOpen;
  try {
    for (const unread of [false, true]) {
      flag.unreadLinesAreOpen = unread;
      for (let seed = 1; seed <= 500; seed += 1) {
        const random = rng(seed * (unread ? 7919 : 104729));
        const issues = randomIssues(random, lines.length);
        const marks: LineMark[] = [];
        for (const line of lines) {
          if (random() < 0.4) marks.push(mark(line, ME, random() < 0.5 ? 'agreed' : 'seen'));
          if (random() < 0.3) marks.push(mark(line, ERIC, 'agreed'));
          // A later Rejected or Approved mark wins the line, so the shared status is exercised.
          if (random() < 0.2) marks.push({ ...mark(line, ERIC, 'rejected', '2026-09-23T11:00:00.000Z'), reason: 'no' });
          if (random() < 0.08) marks.push(mark(line, IZZY, 'approved', '2026-09-23T11:30:00.000Z'));
          if (random() < 0.15) marks.push(mark(line, ME, 'seen', '2026-09-23T11:45:00.000Z'));
        }
        const states = buildLineStates(lines, marks);
        invariant(`seed ${seed} unread=${unread}`, issues, lines, states, []);
      }
    }
  } finally {
    flag.unreadLinesAreOpen = original;
  }
});

test('unreadLinesAreOpen flips all three together, never one of them', () => {
  const lines = makeLines(['A first line of real words.', 'A second line of real words.', 'A third line of real words.']);
  const states = buildLineStates(lines, []);
  const flag = OPEN_VIEW_POLICY as unknown as { unreadLinesAreOpen: boolean };
  const original = flag.unreadLinesAreOpen;
  try {
    flag.unreadLinesAreOpen = false;
    const off = openView({ issues: [], viewer: ME, lineAtPos: () => -1, states, lineCount: 3 });
    assert.deepEqual(off.lines, []);
    assert.equal(off.count, 0);
    flag.unreadLinesAreOpen = true;
    const on = openView({ issues: [], viewer: ME, lineAtPos: () => -1, states, lineCount: 3 });
    assert.deepEqual(on.lines, [0, 1, 2], 'every unread line is open');
    assert.equal(on.count, on.items.length);
    assert.deepEqual(on.items.map(i => i.line), on.lines, 'the list still equals the dots');
    assert.deepEqual(on.items.map(i => i.kinds), [['unread'], ['unread'], ['unread']]);
  } finally {
    flag.unreadLinesAreOpen = original;
  }
});

// ============================================================================
// 2. Threads: threadOpenFor decides, and one unsettled thing is one row
// ============================================================================

function threadViewsOf(threads: Thread[], lines: DocLine[]): ThreadView[] {
  const meta: ThreadMeta[] = threads.map(thread => ({
    id: thread.id, markId: thread.markId, by: thread.by, asks: thread.asks, text: thread.text,
    anchor: thread.anchor, selection: thread.selection, waitingOn: thread.waitingOn,
    status: thread.status, createdAt: thread.createdAt, closedAt: null, closedBy: null, replies: thread.replies,
  }));
  return evaluateThreads({ meta, lines });
}

test('an open thread with no review mark gets a row, and its own `because` is the words shown', () => {
  const lines = makeLines(['One line at the top of it.', 'The team met on Tuesday to review the plan.', 'A last line at the bottom.']);
  const thread = startThread({ by: ERIC, lines: [lines[1]], doc: lines, asks: 'yes-no', text: 'Do we still meet Tuesdays?', at: '2026-09-22T11:00:00.000Z' });
  const views = threadViewsOf([thread], lines);
  const open = openView({ issues: [], viewer: ME, lineAtPos: () => -1, threads: views, team: [ME, ERIC], lineCount: 3 });
  assert.deepEqual(open.lines, [1]);
  assert.equal(open.count, 1);
  assert.deepEqual(open.items[0].kinds, ['thread']);
  assert.equal(open.items[0].because, 'This asks you for a yes or a no.', 'the thread wrote the sentence, not the Open view');
  assert.deepEqual(open.items[0].threadIds, [thread.id]);
  // ...and it is not open for the person who asked it.
  assert.equal(openView({ issues: [], viewer: ERIC, lineAtPos: () => -1, threads: views, team: [ME, ERIC], lineCount: 3 }).count, 0);
});

test('a comment mark and the thread read from it are ONE row, never two', () => {
  const lines = makeLines(['One line at the top of it.', 'The team met on Tuesday to review the plan.', 'A last line at the bottom.']);
  const views = evaluateThreads({
    marks: [{ id: 'c1', kind: 'comment', by: ERIC, text: 'Is this right?', pos: 10, quote: lines[1].text }],
    lines,
    lineOf: () => 1,
  });
  const issues: ProofIssue[] = [{ type: 'comment', markId: 'c1', pos: 10, kind: 'comment', by: ERIC, excerpt: 'x' }];
  const open = openView({ issues, viewer: ME, lineAtPos: pos => (pos === 10 ? 1 : -1), threads: views, team: [ME, ERIC], lineCount: 3 });
  assert.deepEqual(open.lines, [1]);
  assert.equal(open.items[0].count, 1, 'the comment was counted once, not once as an Issue and again as a thread');
  assert.deepEqual(open.items[0].kinds, ['comment']);
});

test('a detached thread is still open, still on a line, and says the text is gone', () => {
  const lines = makeLines(['One line at the top of it.', 'This sentence exists only to be deleted.', 'A last line at the bottom.']);
  const thread = startThread({ by: ERIC, lines: [lines[1]], doc: lines, asks: 'yes-no', text: 'Keep it?', at: '2026-09-22T11:00:00.000Z' });
  const after = makeLines(['One line at the top of it.', 'A last line at the bottom.']);
  const views = threadViewsOf([thread], after);
  const open = openView({ issues: [], viewer: ME, lineAtPos: () => -1, threads: views, team: [ME, ERIC], lineCount: after.length });
  assert.equal(open.count, 1, 'deleting the text must not delete the unsettled question');
  assert.equal(open.items[0].detached, true);
  assert.ok(open.items[0].because.includes('the text this was about has changed'), open.items[0].because);
});

// ============================================================================
// 3. The lapse (brief 5)
// ============================================================================

const BEFORE = 'We will ship the product on Monday next week.';
const SUBSTANTIVE = 'We will ship the product on Friday next month.';
const COSMETIC = 'We will ship the Product on Monday next week';
const A = 'Alpha line one is here for company.';
const C = 'Gamma line three is here for company.';

function lapseCase(after: DocLine[]): { entry: ReturnType<typeof buildLineStates>[number]['marks'] extends Map<string, infer V> ? V | undefined : never; line: number | null; issue: Extract<ProofIssue, { type: 'line' }> | undefined; open: ReturnType<typeof openView> } {
  const before = makeLines([A, BEFORE, C]);
  const marks = [mark(before[1], ME, 'agreed')];
  const states = buildLineStates(after, marks);
  let entry; let line: number | null = null;
  for (const state of states) {
    const found = state.marks.get(ME);
    if (found) { entry = found; line = state.line.index; }
  }
  const summary = computeIssues({ lines: after, lineMarks: marks, team: [ME, ERIC] });
  const issue = summary.issues.find(i => i.type === 'line' && i.lineIndex === line) as Extract<ProofIssue, { type: 'line' }> | undefined;
  const open = openView({ issues: summary.issues, viewer: ME, lineAtPos: () => -1, states, lineCount: after.length });
  return { entry: entry as never, line, issue, open };
}

test('lapse: a substantive edit re-opens the agreement, on the line the text became', () => {
  const { entry, line, issue, open } = lapseCase(makeLines([A, SUBSTANTIVE, C]));
  assert.equal(line, 1);
  assert.equal((entry as { current: boolean }).current, false);
  assert.equal((entry as { lapsed?: boolean }).lapsed, true);
  assert.equal((entry as { lapsedFrom?: string }).lapsedFrom, BEFORE, 'the margin needs the wording that was agreed to');
  assert.deepEqual(issue?.lapsedFor, [ME]);
  assert.deepEqual(open.lines, [1]);
  assert.deepEqual(open.items[0].kinds, ['lapsed']);
  assert.equal(open.items[0].agreedTo, BEFORE);
});

test('lapse: a cosmetic edit carries the agreement forward, exactly as it did before', () => {
  const { entry, open } = lapseCase(makeLines([A, COSMETIC, C]));
  assert.equal((entry as { current: boolean }).current, true);
  assert.equal((entry as { carried?: boolean }).carried, true);
  assert.equal((entry as { lapsed?: boolean }).lapsed, undefined);
  assert.deepEqual(open.lines, [], 'a spelling fix must not send the line back to the Open list');
});

test('lapse: a line inserted above no longer pins the lapse to an untouched line', () => {
  const { line, issue } = lapseCase(makeLines(['A brand new opening line here.', A, SUBSTANTIVE, C]));
  assert.equal(line, 2, 'before this stage the ordinal fallback put it on line 1, which nobody had touched');
  assert.deepEqual(issue?.lapsedFor, [ME]);
});

test('lapse: a line deleted above no longer pins the lapse to a different line', () => {
  const { line, issue } = lapseCase(makeLines([SUBSTANTIVE, C]));
  assert.equal(line, 0);
  assert.deepEqual(issue?.lapsedFor, [ME]);
});

test('lapse: promoting the line to a heading re-opens it instead of dropping the mark silently', () => {
  const { line, issue, open } = lapseCase(makeLines([A, SUBSTANTIVE, C], ['paragraph', 'heading', 'paragraph']));
  assert.equal(line, 1, 'the mark used to vanish: kind changed, so the ordinal fallback refused it');
  assert.deepEqual(issue?.lapsedFor, [ME]);
  assert.deepEqual(open.lines, [1], 'the line must not leave the Open list while nobody has agreed to what it says');
});

test('lapse: an unrelated line never steals a mark (the similarity floor)', () => {
  const lines = makeLines([A, BEFORE, C]);
  const gone = makeLines([A, C]);
  assert.equal(findLapseTarget(gone, { ...anchorForLine(lines[1]), text: lines[1].text }), null);
  assert.equal(LINE_MARK_POLICY.lapseSubstantiveEdits, true);
});

test('lapse: only an Agreed or Approved mark lapses; a Seen one is merely out of date', () => {
  const before = makeLines([A, BEFORE, C]);
  const after = makeLines([A, SUBSTANTIVE, C]);
  const seen = computeIssues({ lines: after, lineMarks: [mark(before[1], ME, 'seen')], team: [ME] });
  const issue = seen.issues.find(i => i.type === 'line' && i.lineIndex === 1) as Extract<ProofIssue, { type: 'line' }>;
  assert.deepEqual(issue.changedFor, [ME]);
  assert.equal(issue.lapsedFor, undefined);
});

// ============================================================================
// 4. The Open view's layout: context, collapsed runs, expansion
// ============================================================================

test('openLayout keeps a line of context either side and collapses the rest to runs', () => {
  const layout = openLayout(12, [5]);
  assert.deepEqual([...layout.shown].sort((a, b) => a - b), [4, 5, 6]);
  assert.deepEqual(layout.runs.map(r => [r.from, r.to, r.lines]), [[0, 3, 4], [7, 11, 5]]);
  assert.equal(layout.runs[0].label, '4 lines settled');
});

test('openLayout shows a run too short to be worth a control instead of collapsing it', () => {
  // Lines 0-2 and 4-6 are shown; line 3 alone is left between them and is not worth a rule.
  const layout = openLayout(8, [1, 5]);
  assert.ok(layout.shown.has(3), 'one line behind a control costs the reader more than showing it');
  assert.deepEqual(layout.runs.map(r => [r.from, r.to]), [[7, 7]].filter(() => false).concat(layout.runs.map(r => [r.from, r.to])));
  assert.ok(layout.runs.every(run => run.lines >= OPEN_VIEW_POLICY.minCollapseRun));
});

test('openLayout: a run the reader expanded stays open (explicit beats automatic)', () => {
  const closed = openLayout(12, [5]);
  assert.equal(closed.shown.has(0), false);
  const opened = openLayout(12, [5], new Set([0, 1, 2, 3]));
  assert.equal(opened.shown.has(0), true);
  assert.deepEqual(opened.runs.map(r => [r.from, r.to]), [[7, 11]]);
});

test('openLayout with nothing open collapses the whole document to one rule', () => {
  const layout = openLayout(9, []);
  assert.deepEqual(layout.runs.map(r => [r.from, r.to, r.lines]), [[0, 8, 9]]);
});

// ============================================================================
// 5. The honest header
// ============================================================================

const NAME: Record<string, string> = { [ERIC]: 'Eric', [IZZY]: 'Izzy', [ME]: 'Mike' };
const header = (states: ReturnType<typeof buildLineStates>, team: string[], viewer = ME) =>
  accordHeader({ states, team, viewer, name: actor => NAME[actor] ?? actor });

test('the honest header names who agreed and where each other reader stops', () => {
  const lines = makeLines(Array.from({ length: 5 }, (_, i) => `Line ${i} carries some words worth reading.`));
  const marks: LineMark[] = [];
  for (const line of lines) { marks.push(mark(line, ME, 'agreed')); marks.push(mark(line, IZZY, 'agreed')); }
  for (const line of lines.slice(0, 3)) marks.push(mark(line, ERIC, 'agreed'));
  const h = header(buildLineStates(lines, marks), [ME, IZZY, ERIC]);
  assert.equal(h.text, 'Agreed by you and Izzy. Eric has not read from line 4 on.');
  assert.equal(h.settled, false);
  assert.deepEqual(h.behind.map(r => r.actor), [ERIC]);
  assert.equal(h.viewerRow?.agreed, true);
});

test('the honest header says "has not read it" for someone who has agreed to nothing', () => {
  const lines = makeLines(['One line of real words here.', 'Two lines of real words here.']);
  const marks = lines.map(line => mark(line, ME, 'agreed'));
  const h = header(buildLineStates(lines, marks), [ME, ERIC]);
  assert.equal(h.text, 'Agreed by you. Eric has not read it.');
});

test('the honest header goes away only when EVERYONE has agreed to every line', () => {
  const lines = makeLines(['One line of real words here.', 'Two lines of real words here.']);
  const all: LineMark[] = [];
  for (const line of lines) for (const who of [ME, ERIC, IZZY]) all.push(mark(line, who, 'agreed'));
  const h = header(buildLineStates(lines, all), [ME, ERIC, IZZY]);
  assert.equal(h.settled, true);
  assert.equal(h.text, '');
});

test('the honest header never counts a lapsed agreement as agreement', () => {
  const before = makeLines([A, BEFORE, C]);
  const after = makeLines([A, SUBSTANTIVE, C]);
  const marks = [mark(before[0], ME, 'agreed'), mark(before[1], ME, 'agreed'), mark(before[2], ME, 'agreed')];
  const h = header(buildLineStates(after, marks), [ME]);
  assert.equal(h.settled, false, 'the document must not read as settled when the meaning moved under the agreement');
  assert.equal(h.viewerRow?.fromLine, 1);
  assert.equal(h.text, 'You agreed to an earlier version of line 2.');
  assert.doesNotMatch(h.text, /has not read/);
});

test('a Rejected mark is never described as not having read the text', () => {
  const lines = makeLines(['One line of real words here.', 'Two lines of real words here.', 'Three lines of real words.']);
  const marks = [
    mark(lines[0], ME, 'agreed'),
    mark(lines[1], ME, 'agreed'),
    mark(lines[2], ME, 'agreed'),
    { ...mark(lines[0], ERIC, 'rejected'), reason: 'The date is wrong' },
    { ...mark(lines[2], ERIC, 'rejected'), reason: 'The price is wrong' },
  ];
  const states = buildLineStates(lines, marks);
  const status = participantStatus({ states, team: [ME, ERIC] });
  const h = header(states, [ME, ERIC]);
  assert.deepEqual(h.status, status);
  assert.equal(h.text, 'Agreed by you. Eric rejected 2 lines.');
  assert.deepEqual(h.clauses.find(clause => clause.actor === ERIC)?.lines, [0, 2]);
  assert.equal(status.participants[1].rejections[0].reason, 'The date is wrong');
  assert.equal(status.aligned, false);
  assert.equal(status.agreed, false);
});

test('Seen is never shown as agreement, and Approved is the owner ruling apart from it', () => {
  const lines = makeLines(['One line of real words here.', 'Two lines of real words here.']);
  const seen = lines.map(line => mark(line, ERIC, 'seen'));
  const approved = lines.map(line => mark(line, ME, 'approved'));
  const states = buildLineStates(lines, [...seen, ...approved]);
  const status = participantStatus({ states, team: [ME, ERIC] });
  const h = header(states, [ME, ERIC]);
  assert.equal(status.aligned, true, 'everyone has seen the text and nobody rejects it');
  assert.equal(status.agreed, false, 'Seen and Approved are not agreement');
  assert.equal(h.settled, false);
  assert.deepEqual(h.agreed, []);
  assert.deepEqual(h.approved, [ME]);
  assert.equal(h.text, 'Approved by you. Eric has seen it and has not agreed.');
  assert.doesNotMatch(h.text, /Agreed by/);
  assert.doesNotMatch(h.text, /has not read/);
});

test('finishing a personal review waits for the others and does not claim team agreement', () => {
  const lines = makeLines(['One line of real words here.', 'Two lines of real words here.']);
  const marks = [
    ...lines.map(line => mark(line, ME, 'agreed')),
    mark(lines[0], ERIC, 'seen'),
    mark(lines[0], IZZY, 'agreed'),
  ];
  const status = participantStatus({ states: buildLineStates(lines, marks), team: [ME, ERIC, IZZY] });
  const text = personalCompletionText({ status, viewer: ME, name: actor => ({ [ERIC]: 'Alex', [IZZY]: 'Jo' }[actor] ?? actor) });
  assert.equal(text, 'You have finished reviewing. Waiting for Alex and Jo.');
  assert.doesNotMatch(text ?? '', /agree/i);
  const done = lines.flatMap(line => [mark(line, ME, 'agreed'), mark(line, ERIC, 'agreed'), mark(line, IZZY, 'agreed')]);
  const all = participantStatus({ states: buildLineStates(lines, done), team: [ME, ERIC, IZZY] });
  assert.equal(all.agreed, true);
  const finished = personalCompletionText({ status: all, viewer: ME, name: actor => actor });
  assert.equal(finished, 'You have finished reviewing.');
  assert.doesNotMatch(finished ?? '', /team|everyone|agreed/i);
});

test('the honest header counts a mark carried over a cosmetic edit', () => {
  const before = makeLines([A, BEFORE, C]);
  const after = makeLines([A, COSMETIC, C]);
  const marks = [mark(before[0], ME, 'agreed'), mark(before[1], ME, 'agreed'), mark(before[2], ME, 'agreed')];
  assert.equal(header(buildLineStates(after, marks), [ME]).settled, true);
});

// ============================================================================
// 6. The zero moment
// ============================================================================

const EMPTY = { items: [], lines: [], count: 0 };

test('the zero moment needs the viewer to have AGREED, not merely to have no Issues', () => {
  const lines = makeLines(['One line of real words here.', 'Two lines of real words here.']);
  const unread = header(buildLineStates(lines, []), [ME, ERIC]);
  const cold = zeroMoment(EMPTY, unread, 'accord');
  assert.equal(cold.forViewer, false, '"Nothing is open for you" above "You have not read it" is two truths making a lie');
  assert.equal(cold.text, '');

  const mine = lines.map(line => mark(line, ME, 'agreed'));
  const done = header(buildLineStates(lines, mine), [ME, ERIC]);
  const zero = zeroMoment(EMPTY, done, 'accord');
  assert.equal(zero.forViewer, true);
  assert.equal(zero.forEveryone, false);
  assert.equal(zero.text, ZERO_POLICY.forYou);
  assert.equal(done.text, 'Agreed by you. Eric has not read it.', 'the header still names who has not read');
});

test('zero for everyone takes the header away too', () => {
  const lines = makeLines(['One line of real words here.', 'Two lines of real words here.']);
  const all: LineMark[] = [];
  for (const line of lines) for (const who of [ME, ERIC]) all.push(mark(line, who, 'agreed'));
  const h = header(buildLineStates(lines, all), [ME, ERIC]);
  const zero = zeroMoment(EMPTY, h, 'accord');
  assert.equal(zero.forEveryone, true);
  assert.equal(zero.text, ZERO_POLICY.forEveryone);
  assert.equal(h.text, '', 'and what is left is a clean document');
});

test('a count above zero is never the zero moment, whatever the header says', () => {
  const lines = makeLines(['One line of real words here.', 'Two lines of real words here.']);
  const all: LineMark[] = [];
  for (const line of lines) for (const who of [ME, ERIC]) all.push(mark(line, who, 'agreed'));
  const h = header(buildLineStates(lines, all), [ME, ERIC]);
  const zero = zeroMoment({ items: [{ key: 'k', line: 0, kinds: ['ask'], by: ERIC, count: 1, because: 'x', detached: false, threadIds: [] }], lines: [0], count: 1 }, h, 'open');
  assert.equal(zero.forViewer, false);
  assert.equal(zero.view, 'open');
});

test('reaching zero puts the document in the Accord but never strips the reader controls', () => {
  const lines = makeLines(['One line of real words here.', 'Two lines of real words here.']);
  const mine = lines.map(line => mark(line, ME, 'agreed'));
  const h = header(buildLineStates(lines, mine), [ME, ERIC]);
  const unchosen = zeroMoment(EMPTY, h, 'open', false);
  assert.equal(unchosen.view, 'accord', 'at zero the document IS the Accord');
  assert.equal(unchosen.clean, false, 'but the margin and the rail stay: a page must not take the Agree button away');
  assert.equal(ZERO_POLICY.zeroNeverStripsChrome, true);
  const chosen = zeroMoment(EMPTY, h, 'accord', true);
  assert.equal(chosen.clean, true, 'the clean read arrives when the person asks for it');
});

console.log(`\nopen-view tests: ${passed} passed`);
