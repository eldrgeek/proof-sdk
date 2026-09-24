// Proof Documents Steps B3b + B3c: honest reading (cosmetic-edit carry-forward, skimmed, how a
// mark was earned), "Since you" and aligned snapshots.
// Authorship: Claude Opus 5 (worker proof-honest), 2026-09-18.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-honest-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
const change = await import('../shared/line-change');
const { COMMON_MISSPELLINGS } = await import('../shared/common-misspellings');
const shared = await import('../shared/line-marks');
const alignment = await import('../shared/alignment');
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

const kind = (a: string, b: string) => change.classifyLineChange(a, b).kind;

// ---------------------------------------------------------------------------
// The classifier (src/shared/line-change.ts): server and page call the same function.
// ---------------------------------------------------------------------------

await test('classifier: identical text (any whitespace) is "same"', () => {
  assert.equal(kind('We ship on Friday.', '  We  ship on Friday. '), 'same');
});

await test('classifier: whitespace, case and punctuation only are cosmetic', () => {
  assert.equal(kind('We ship on friday', 'We ship on Friday.'), 'cosmetic');
  assert.equal(kind('Hello, world', 'Hello, world.'), 'cosmetic');
  assert.equal(kind('the plan is final', 'The plan is final.'), 'cosmetic');
});

// Round 3: invisible symbols and uncertain punctuation must never carry agreement.
const surfaceChanges: Array<[string, string, string]> = [
  ['I agree with the delivery schedule for tomorrow 👍', 'I agree with the delivery schedule for tomorrow 👎', 'a symbol changed'],
  ['The approved condition is x < y for every delivery.', 'The approved condition is x > y for every delivery.', 'a symbol changed'],
  ['I agree with the delivery schedule for tomorrow 👍🏻', 'I agree with the delivery schedule for tomorrow 👍🏽', 'a symbol changed'],
  ['The delivery instructions show this worker 👩‍💻 today.', 'The delivery instructions show this worker 👩💻 today.', 'a symbol changed'],
  ['The delivery instructions include this symbol ♥ today.', 'The delivery instructions include this symbol ♥️ today.', 'a symbol changed'],
  ["Let's eat, Grandma before we review the delivery schedule.", "Let's eat Grandma before we review the delivery schedule.", 'punctuation changed'],
  ['The delivery instructions are clear: leave the gate open.', 'The delivery instructions are clear leave the gate open.', 'punctuation changed'],
  ['The delivery team (including the driver) agreed today.', 'The delivery team including the driver agreed today.', 'punctuation changed'],
  ['The delivery instructions say "leave the gate open" today.', 'The delivery instructions say leave the gate open today.', 'punctuation changed'],
  ['The delivery team is ready; the driver is waiting.', 'The delivery team is ready the driver is waiting.', 'punctuation changed'],
  ['The delivery team [including the driver] agreed today.', 'The delivery team including the driver agreed today.', 'punctuation changed'],
  ['The delivery team, including the driver agreed today.', 'The delivery team including the driver, agreed today.', 'punctuation changed'],
  ['The delivery team reviews the long-term schedule today.', 'The delivery team reviews the long—term schedule today.', 'punctuation changed'],
  ['The delivery team is ready... Please start the engine.', 'The delivery team is ready. Please start the engine.', 'punctuation changed'],
];
for (const [before, after, why] of surfaceChanges) {
  await test(`classifier: surface change requires review: ${before} -> ${after}`, () => {
    for (const text of [before, after]) assert.ok((text.match(/\p{L}/gu) ?? []).length >= 25);
    for (const [a, b] of [[before, after], [after, before]]) {
      assert.deepEqual(change.classifyLineChange(a, b), { kind: 'substantive', why });
    }
  });
}

const typographyChanges: Array<[string, string]> = [
  ["The driver's delivery schedule is ready for tomorrow.", 'The driver’s delivery schedule is ready for tomorrow.'],
  ['The delivery instructions say "leave the gate open" today.', 'The delivery instructions say “leave the gate open” today.'],
  ['The delivery team is ready -- the driver is waiting.', 'The delivery team is ready — the driver is waiting.'],
  ['The delivery team is ready - the driver is waiting.', 'The delivery team is ready – the driver is waiting.'],
  ['The delivery team is ready--the driver is waiting!', 'The delivery team is ready—the driver is waiting!'],
  ['The delivery team is ready... Please start the engine.', 'The delivery team is ready… Please start the engine.'],
  ['The delivery team is ready for the shipment', 'The delivery team is ready for the shipment.'],
  ['The delivery instructions say "leave the gate open"', 'The delivery instructions say "leave the gate open."'],
];
for (const [before, after] of typographyChanges) {
  await test(`classifier: typography is cosmetic: ${before} -> ${after}`, () => {
    for (const text of [before, after]) assert.ok((text.match(/\p{L}/gu) ?? []).length >= 25);
    assert.equal(kind(before, after), 'cosmetic');
    assert.equal(kind(after, before), 'cosmetic');
  });
}

await test('classifier: 20,000 characters and 3,000 exclamations take under 200 ms', () => {
  const before = 'word! '.repeat(3000) + 'x'.repeat(2000);
  const after = before.replace('word', 'Word');
  assert.equal(before.length, 20_000);
  assert.equal((before.match(/!/gu) ?? []).length, 3000);
  const started = performance.now();
  const result = change.classifyLineChange(before, after);
  const elapsed = performance.now() - started;
  assert.equal(result.kind, 'cosmetic', 'exercise the full classifier, not the identical-text shortcut');
  assert.ok(elapsed < 200, `classification took ${elapsed.toFixed(1)} ms`);
  console.log(`  20,000 characters / 3,000 exclamations: ${elapsed.toFixed(1)} ms`);
});

await test('classifier: a listed spelling correction is cosmetic', () => {
  assert.equal(kind('We will review teh budget with the whole team next week.', 'We will review the budget with the whole team next week.'), 'cosmetic');
  assert.equal(kind('The recieved documents are filed in the shared folder today.', 'The received documents are filed in the shared folder today.'), 'cosmetic');
  const fix = change.classifyLineChange('Please review teh draft and the notes carefully.', 'Please review the draft and the notes carefully.');
  assert.deepEqual(fix.fixes, [{ from: 'teh', to: 'the' }]);
});

await test('classifier: "will" -> "will not" is substantive (a word added, and a negation)', () => {
  assert.equal(kind('We will ship the release on Friday afternoon.', 'We will not ship the release on Friday afternoon.'), 'substantive');
});

await test('classifier: negations and meaning words are substantive even at one letter', () => {
  assert.equal(kind('This is not the final version of the plan.', 'This is now the final version of the plan.'), 'substantive');
  assert.equal(kind('Approve all the requests from the finance team.', 'Approve any the requests from the finance team.'), 'substantive');
  assert.equal(kind('You can edit this section of the document.', "You can't edit this section of the document."), 'substantive');
  assert.equal(kind('Do it before the meeting on the ninth.', 'Do it after the meeting on the ninth.'), 'substantive');
});

await test('classifier: numbers, amounts and percentages changing are substantive', () => {
  assert.equal(kind('The fee is $10 per seat for every team.', 'The fee is $100 per seat for every team.'), 'substantive');
  assert.equal(kind('Growth was 1.5 percent in the quarter.', 'Growth was 15 percent in the quarter.'), 'substantive');
  assert.equal(kind('Discount of 10% for early signups this month.', 'Discount of 10 for early signups this month.'), 'substantive');
  assert.equal(kind('Meet at 3:30 in the main room.', 'Meet at 3:00 in the main room.'), 'substantive');
  assert.equal(kind('Owe -5 dollars to the fund.', 'Owe 5 dollars to the fund.'), 'substantive');
});

await test('classifier: reordering words is substantive', () => {
  assert.equal(kind('Mike approves the budget before Eric signs it.', 'Eric approves the budget before Mike signs it.'), 'substantive');
  assert.equal(kind('red green blue yellow orange purple', 'green red blue yellow orange purple'), 'substantive');
  assert.equal(kind('The team says it is ready for launch next week.', 'The team says is it ready for launch next week.'), 'substantive');
});

await test('classifier: capitalised words (names) changing are substantive; a sentence-start fix is not', () => {
  assert.equal(kind('Send the contract to Marc before the call tomorrow.', 'Send the contract to Mark before the call tomorrow.'), 'substantive');
  assert.equal(kind('Teh contract goes out before the call tomorrow morning.', 'The contract goes out before the call tomorrow morning.'), 'cosmetic');
});

await test('classifier: unlisted changes are substantive regardless of distance or line length', () => {
  assert.equal(kind('recieve', 'receive'), 'cosmetic', 'listed corrections no longer depend on line length');
  assert.equal(kind('The cat sat on the mat by the door today.', 'The dog sat on the mat by the door today.'), 'substantive', 'cat -> dog is 3 edits');
  assert.equal(kind('We reviewd bugdet plna with care.', 'We reviewed budget plan with care.'), 'substantive', 'these corrections are not listed');
  assert.equal(kind('It is fine to merge this change after review today.', 'It it fine to merge this change after review today.'), 'substantive', 'two-letter words: any change matters');
});

// S5 regressions use ordinary sentences with at least 25 letters: a long line must
// never turn these meaning changes into spelling fixes. Check both directions.
const substantivePairs: Array<[string, string]> = [
  ['The committee will fund the project before winter.', 'The committee will find the project before winter.'],
  ['The team needs a causal explanation for the delay.', 'The team needs a casual explanation for the delay.'],
  ['The instructions say form a group before delivery.', 'The instructions say from a group before delivery.'],
  ['The trial begins near the loading dock this morning.', 'The trail begins near the loading dock this morning.'],
  ['The instructions say lose the rope before delivery.', 'The instructions say loose the rope before delivery.'],
  ['The team will file the report before the meeting.', 'The team will fire the report before the meeting.'],
  ['The team selected the colour for the loading dock.', 'The team selected the color for the loading dock.'],
  ['The team will organise the delivery before winter.', 'The team will organize the delivery before winter.'],
  ['The delivery team reviewed its schedule this morning.', 'The delivery team reviewed it’s schedule this morning.'],
  ['The updated rules affect the entire delivery team.', 'The updated rules effect the entire delivery team.'],
  ['The instructions say then proceed with the delivery.', 'The instructions say than proceed with the delivery.'],
  ['The team will reviewd the shipment this afternoon.', 'The team will reviewed the shipment this afternoon.'],

  ['The loading dock is safe for night deliveries.', 'The loading dock is unsafe for night deliveries.'],
  ['The invoice is paid for the delivery this morning.', 'The invoice is unpaid for the delivery this morning.'],
  ['This arrangement is legal for the delivery team.', 'This arrangement is illegal for the delivery team.'],
  ['The crew is able to finish the delivery today.', 'The crew is unable to finish the delivery today.'],
  ['The team expects orders to increase during this month.', 'The team expects orders to decrease during this month.'],
  ['The company plans to hire the delivery manager.', 'The company plans to fire the delivery manager.'],
  ['The instructions say accept the delivery today.', 'The instructions say except the delivery today.'],
  ['The male patient is waiting for the appointment.', 'The female patient is waiting for the appointment.'],
  ['The delivery fee is $10 for the entire shipment.', 'The delivery fee is $100 for the entire shipment.'],
  ['The team shall deliver the order this afternoon.', 'The team may deliver the order this afternoon.'],
  ['We ship Friday. The delivery team is ready.', 'We ship Friday? The delivery team is ready.'],
  ['The delivery team is ready for the shipment.', 'The delivery team is ready for the shipment!'],
  ['We ship Friday? The delivery team is ready.', 'We ship Friday. The delivery team is ready?'],
  ['The typical schedule suits the delivery team.', 'The atypical schedule suits the delivery team.'],
  ['The moral argument concerns the entire team.', 'The amoral argument concerns the entire team.'],
  ['The shipment includes a gift for the entire team.', 'The shipment includes a git for the entire team.'],
  ['The team will seperete the shipments this afternoon.', 'The team will separate the shipments this afternoon.'],
];
for (const [before, after] of substantivePairs) {
  await test(`classifier: substantive in both directions: ${before} -> ${after}`, () => {
    for (const text of [before, after]) assert.ok((text.match(/\p{L}/gu) ?? []).length >= 25);
    assert.equal(kind(before, after), 'substantive');
    assert.equal(kind(after, before), 'substantive');
  });
}

const cosmeticPairs: Array<[string, string]> = [
  ['The team will review teh budget before delivery.', 'The team will review the budget before delivery.'],
  ['The team will definately review the delivery today.', 'The team will definitely review the delivery today.'],

  ['The team will recieve the shipment this afternoon.', 'The team will receive the shipment this afternoon.'],
  ['The team will seperate the shipments this afternoon.', 'The team will separate the shipments this afternoon.'],
  ['The team can accomodate the shipment this afternoon.', 'The team can accommodate the shipment this afternoon.'],
];
for (const [before, after] of cosmeticPairs) {
  await test(`classifier: listed correction carries only forward: ${before} -> ${after}`, () => {
    for (const text of [before, after]) assert.ok((text.match(/\p{L}/gu) ?? []).length >= 25);
    assert.equal(kind(before, after), 'cosmetic');
    assert.equal(kind(after, before), 'substantive', 'introducing a misspelling is not a listed correction');
  });
}
await test('classifier: case and punctuation remain cosmetic in both directions', () => {
  const before = 'the delivery team is ready for the shipment';
  const after = 'The delivery team is ready for the shipment.';
  assert.equal(kind(before, after), 'cosmetic');
  assert.equal(kind(after, before), 'cosmetic');
});

await test('correction list: fixed lower-case pairs exclude real-word confusions and regional variants', () => {
  assert.ok(COMMON_MISSPELLINGS.size >= 150 && COMMON_MISSPELLINGS.size <= 300);
  for (const word of ['fund', 'causal', 'form', 'trial', 'lose', 'loose', 'file', 'then', 'its', 'affect', 'colour', 'color', 'organise', 'organize', 'calender', 'untill', 'miniscule']) {
    assert.equal(COMMON_MISSPELLINGS.has(word), false, word);
  }
  for (const [from, to] of COMMON_MISSPELLINGS) {
    assert.match(from, /^[a-z]+$/u);
    assert.match(to, /^[a-z]+$/u);
    assert.notEqual(from, to);
    assert.equal(COMMON_MISSPELLINGS.has(to), false, 'a correction cannot itself be a listed misspelling');
    // Every listed pair works in ordinary lower-case prose, and never in reverse.
    const before = `The proofreader replaced the word ${from} in the printed instructions.`;
    const after = `The proofreader replaced the word ${to} in the printed instructions.`;
    const result = change.classifyLineChange(before, after);
    assert.equal(result.kind, 'cosmetic', `${from} -> ${to}`);
    assert.deepEqual(result.fixes, [{ from, to }]);
    assert.equal(kind(after, before), 'substantive', `${to} -> ${from}`);
  }
});

await test('classifier: all changed words must be listed, and fixes retain their original case and order', () => {
  const before = 'Teh team will definately recieve the shipment this afternoon.';
  const after = 'The team will definitely receive the shipment this afternoon.';
  const result = change.classifyLineChange(before, after);
  assert.equal(result.kind, 'cosmetic');
  assert.deepEqual(result.fixes, [
    { from: 'Teh', to: 'The' }, { from: 'definately', to: 'definitely' }, { from: 'recieve', to: 'receive' },
  ]);
  assert.equal(kind(before, after.replace('shipment', 'payment')), 'substantive');
  assert.equal(kind('Send the instructions to Freind before the meeting.', 'Send the instructions to Friend before the meeting.'), 'substantive', 'the name guard wins over the list');
  assert.equal(kind(before, after.replace('afternoon.', 'afternoon?')), 'substantive');
});

await test('classifier: whitespace in a long sentence remains unchanged for carry purposes', () => {
  assert.equal(kind('The delivery team is ready for the shipment.', '  The delivery  team is ready for the shipment.  '), 'same');
});

await test('classifier: edge cases (empty lines, word removed, editDistance)', () => {
  assert.equal(kind('', 'Something'), 'substantive');
  assert.equal(kind('Keep this line exactly as it is now please.', 'Keep this line exactly as it is please.'), 'substantive');
  assert.equal(change.editDistance('teh', 'the'), 1, 'a swap of neighbours is one edit');
  assert.equal(change.editDistance('kitten', 'sitting'), 3);
  assert.equal(change.isCosmeticChange('Ship it on Monday.', 'ship it on monday'), true);
});

// ---------------------------------------------------------------------------
// Carry-forward and skimmed in the shared Issue computation.
// ---------------------------------------------------------------------------

const before = `# Plan

We will review teh budget with the whole team next week.

We will ship the release on Friday afternoon.

The fee is $10 per seat for every team.`;
const after = before
  .replace('review teh budget', 'review the budget')
  .replace('will ship', 'will not ship')
  .replace('$10', '$100');
const oldLines = await serverLines.computeServerLines(before);
const newLines = await serverLines.computeServerLines(after);
const mk = (by: string, line: typeof oldLines[number], status: 'seen' | 'agreed' | 'skimmed', via: 'dwell' | 'click' = 'click', at = '2026-09-18T10:00:00.000Z') => ({
  id: `${by}-${line.index}-${status}`, by, status, reason: null, at, anchor: shared.anchorForLine(line), via,
});

await test('carry: a cosmetic edit carries every mark (tagged carried); a substantive edit resets', () => {
  const marks = oldLines.flatMap(line => [mk('human:mike@x.com', line, 'agreed'), mk('ai:claude', line, 'seen', 'dwell')]);
  const states = shared.buildLineStates(newLines, marks);
  const spelling = states[1];
  assert.equal(spelling.marks.get('human:mike@x.com')?.current, true, 'teh -> the carried');
  assert.equal(spelling.marks.get('human:mike@x.com')?.carried, true);
  assert.equal(spelling.marks.get('human:mike@x.com')?.carriedFrom, oldLines[1].text);
  assert.equal(spelling.marks.get('ai:claude')?.carried, true);
  assert.equal(states[2].marks.get('human:mike@x.com')?.current, false, '"will" -> "will not" resets');
  assert.equal(states[3].marks.get('human:mike@x.com')?.current, false, '$10 -> $100 resets');
  assert.equal(states[0].marks.get('human:mike@x.com')?.carried, undefined, 'an untouched line is exact, not carried');
  const issues = shared.computeIssues({ lines: newLines, lineMarks: marks, team: ['human:mike@x.com', 'ai:claude'] });
  assert.deepEqual(issues.issues.map(i => (i.type === 'line' ? i.lineIndex : -1)), [2, 3], 'only the substantive edits are Issues');
});

await test('carry: meaning changes lapse agreement at read time without changing the stored mark', async () => {
  for (const [before, after] of substantivePairs) {
    const old = (await serverLines.computeServerLines(before))[0];
    const lines = await serverLines.computeServerLines(after);
    const mark = mk('human:reader', old, 'agreed');
    const stored = JSON.stringify(mark);
    assert.equal(shared.findCarryTarget(lines, mark.anchor), null, after);
    const entry = shared.buildLineStates(lines, [mark])[0].marks.get('human:reader');
    assert.equal(entry?.current, false, after);
    assert.equal(entry?.carried, undefined, after);
    assert.equal(entry?.mark.status, 'agreed');
    assert.equal(JSON.stringify(mark), stored, 'reading must preserve the historical mark');
  }
});

await test('carry: listed corrections carry agreement without rewriting it; reversed corrections lapse', async () => {
  for (const [before, after] of cosmeticPairs) {
    const old = (await serverLines.computeServerLines(before))[0];
    const lines = await serverLines.computeServerLines(after);
    const mark = mk('human:reader', old, 'agreed');
    const stored = JSON.stringify(mark);
    const entry = shared.buildLineStates(lines, [mark])[0].marks.get('human:reader');
    assert.equal(entry?.current, true, after);
    assert.equal(entry?.carried, true, after);
    assert.equal(entry?.carriedFrom, before);
    assert.equal(JSON.stringify(mark), stored);
    const reverseMark = mk('human:reader', lines[0], 'agreed');
    const reversed = shared.buildLineStates([old], [reverseMark])[0].marks.get('human:reader');
    assert.equal(reversed?.current, false, before);
    assert.equal(reversed?.carried, undefined, before);
  }
});

await test('carry: an exact mark wins over a carried one; carry can be switched off by policy', () => {
  const carried = mk('human:a', oldLines[1], 'seen', 'click', '2026-09-18T09:00:00.000Z');
  const exact = { ...mk('human:a', newLines[1], 'agreed', 'click', '2026-09-18T08:00:00.000Z'), id: 'exact' };
  const states = shared.buildLineStates(newLines, [carried, exact]);
  assert.equal(states[1].marks.get('human:a')?.mark.id, 'exact');
  assert.equal(states[1].marks.get('human:a')?.carried, undefined);
  assert.equal(shared.LINE_MARK_POLICY.carryCosmeticEdits, true);
});

await test('carry: an older mark with only its excerpt carries when the excerpt is the whole line', () => {
  const short = 'Ship teh build on Monday morning for the whole team.';
  const anchor = { ...shared.anchorForLine({ index: 0, kind: 'paragraph', text: short, hash: shared.hashLine('paragraph', short), occurrence: 0, pos: 0, nodeSize: 1, block: 0 }) };
  delete (anchor as { text?: string }).text;
  assert.equal(shared.anchorText(anchor), short);
  const target = shared.findCarryTarget([{ index: 0, kind: 'paragraph', text: short.replace('teh', 'the'), hash: 'h2', occurrence: 0, pos: 0, nodeSize: 1, block: 0 }], anchor);
  assert.equal(target?.index, 0);
  const long = 'x'.repeat(120);
  const longAnchor = { hash: shared.hashLine('paragraph', long), occurrence: 0, ordinal: 0, kind: 'paragraph', excerpt: long.slice(0, 80) };
  assert.equal(shared.anchorText(longAnchor), null, 'a trimmed excerpt is never taken as the line');
});

await test('skimmed: shown as a mark but not Seen: still an Issue, listed in skimmedBy', () => {
  const marks = oldLines.map(line => mk('human:a', line, line.index === 2 ? 'skimmed' : 'seen', 'dwell'));
  const issues = shared.computeIssues({ lines: oldLines, lineMarks: marks, team: ['human:a'] });
  assert.equal(issues.counts.total, 1);
  const issue = issues.issues[0];
  assert.ok(issue.type === 'line' && issue.lineIndex === 2 && issue.unseenBy[0] === 'human:a' && issue.skimmedBy[0] === 'human:a');
  assert.equal(shared.countsAsSeen('skimmed'), false);
  assert.equal(shared.isLineMarkStatus('skimmed'), true);
});

// ---------------------------------------------------------------------------
// Since you (pure) and the snapshot ledger.
// ---------------------------------------------------------------------------

await test('since you: baseline is your last explicit mark; lists edits, asks, rejections, suggestions, comments', () => {
  const me = 'human:mike@x.com';
  const t0 = '2026-09-18T10:00:00.000Z';
  const t1 = '2026-09-18T11:00:00.000Z';
  const marks = [
    mk(me, oldLines[0], 'agreed', 'click', t0),
    mk(me, oldLines[1], 'seen', 'dwell', '2026-09-18T09:00:00.000Z'),
    mk(me, oldLines[2], 'agreed', 'click', '2026-09-18T09:30:00.000Z'),
    { ...mk('human:eric@x.com', newLines[3], 'seen', 'click', t1), status: 'rejected' as const, reason: 'Too expensive', id: 'rej' },
  ];
  const report = alignment.computeSinceYou({
    actor: me,
    lines: newLines,
    lineMarks: marks as never,
    asks: [{ id: 'ask1', by: 'ai:claude', to: [me], recommend: 'Ship Friday', ifYes: null, anchor: shared.anchorForLine(newLines[2]), createdAt: t1, askedAt: t1, answers: [] }],
    reviewMarks: [
      { id: 's1', kind: 'replace', by: 'ai:claude', quote: 'whole team', content: 'entire team', createdAt: t1, open: true, replies: [] },
      { id: 'c1', kind: 'comment', by: 'Mike Wolf', quote: 'Friday afternoon', createdAt: t1, open: true, text: 'my own comment', replies: [{ by: 'Eric', at: t1, text: 'Agree' }] },
      { id: 'old', kind: 'comment', by: 'Eric', quote: 'Plan', createdAt: '2026-09-18T08:00:00.000Z', open: true, replies: [] },
    ],
    isMe: by => by === 'Mike Wolf' || by === me,
  });
  assert.equal(report.hasHistory, true);
  assert.equal(report.lastMarkedAt, t0, 'a scroll (dwell) Seen is not an explicit mark');
  assert.equal(report.baseline.source, 'mark');
  assert.deepEqual(report.edited.map(item => [item.lineIndex, item.change]), [[1, 'cosmetic'], [2, 'substantive']]);
  assert.equal(report.edited[1].from, oldLines[2].text);
  assert.deepEqual(report.asks.map(item => [item.askId, item.lineIndex]), [['ask1', 2]]);
  assert.deepEqual(report.rejections.map(item => [item.lineIndex, item.by, item.reason]), [[3, 'human:eric@x.com', 'Too expensive']]);
  assert.deepEqual(report.suggestions.map(item => [item.markId, item.lineIndex]), [['s1', 1]]);
  assert.deepEqual(report.comments.map(item => [item.type, item.by]), [['reply', 'Eric']], 'your own comment and old comments are not listed');
  // Ringers: line 1 is Seen only by scrolling, and it changed (carried) and gained a suggestion since.
  assert.deepEqual(report.ringers.map(item => item.lineIndex), [1]);
  assert.match(report.ringers[0].why, /small wording fix/);
  assert.match(report.ringers[0].why, /suggestion/);
});

await test('since you: no explicit marks and no snapshot = no history; a later snapshot moves the baseline', () => {
  const none = alignment.computeSinceYou({ actor: 'human:new@x.com', lines: newLines, lineMarks: [], asks: [], reviewMarks: [] });
  assert.equal(none.hasHistory, false);
  const snap = { id: 'snap_1', createdAt: '2026-09-18T12:00:00.000Z', team: ['human:a'], lines: oldLines.map(l => ({ hash: l.hash, occurrence: l.occurrence, text: l.text })) };
  const report = alignment.computeSinceYou({ actor: 'human:a', lines: newLines, lineMarks: [mk('human:a', oldLines[0], 'agreed', 'click', '2026-09-18T10:00:00.000Z')], asks: [], reviewMarks: [], snapshot: snap });
  assert.equal(report.baseline.source, 'snapshot');
  assert.deepEqual(report.edited.map(item => [item.lineIndex, item.change]), [[1, 'new-since-snapshot'], [2, 'new-since-snapshot'], [3, 'new-since-snapshot']]);
});

await test('ledger: fingerprint ignores mark ids and times; the ledger holds text, marks, asks and team', () => {
  const marks = oldLines.map(line => mk('human:a', line, 'agreed'));
  const payload = alignment.buildSnapshotPayload({ slug: 's', title: 'Plan', createdAt: 't', team: ['human:a'], lines: oldLines, lineMarks: marks, asks: [] });
  const again = alignment.buildSnapshotPayload({ slug: 's', title: 'Plan', createdAt: 't2', team: ['human:a'], lines: oldLines, lineMarks: marks.map(m => ({ ...m, id: `${m.id}-x`, at: 'later' })), asks: [] });
  assert.equal(alignment.snapshotFingerprint(before, payload), alignment.snapshotFingerprint(before, again));
  assert.notEqual(alignment.snapshotFingerprint(before, payload), alignment.snapshotFingerprint(after, payload));
  const ledger = alignment.renderSnapshotLedger('snap_x', 'Code: ```js```\n\n' + before, payload);
  assert.match(ledger, /^# Aligned snapshot: Plan/);
  assert.match(ledger, /\| 2 \| We will review teh budget/);
  assert.match(ledger, /````markdown/, 'the fence is longer than any backtick run in the document');
});

// ---------------------------------------------------------------------------
// HTTP: via, carried marks in /state, since-you, snapshots.
// ---------------------------------------------------------------------------

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
  const text = await response.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { json = { text }; }
  return { status: response.status, body: json, text };
};

try {
  // The document already carries the edits; the marks are made on the old text (as if the
  // readers marked before the edit).
  const slug = 'honest-test';
  db.createDocument(slug, after, {}, 'Honest reading test', 'owner-1', 'owner-secret-123');
  const editor = db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Claude (COS)', requestedBy: 'test', requestedFrom: '127.0.0.1' });
  const agent = { 'x-share-token': editor.secret };
  const owner = { 'x-share-token': 'owner-secret-123' };

  await test('page route: "via" is stored (dwell, key, click default); a skim batch writes skimmed', async () => {
    const r1 = await call(`/api/documents/${slug}/line-marks`, 'POST', { by: 'Pat', status: 'seen', via: 'dwell', anchor: shared.anchorForLine(oldLines[1]) });
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.lineMark.via, 'dwell');
    assert.equal(r1.body.lineMark.anchor.text, oldLines[1].text, 'the whole line text is stored for carry-forward');
    const r2 = await call(`/api/documents/${slug}/line-marks`, 'POST', { by: 'Pat', status: 'agreed', anchor: shared.anchorForLine(newLines[0]) });
    assert.equal(r2.body.lineMark.via, 'click');
    const skim = await call(`/api/documents/${slug}/line-marks`, 'POST', { by: 'Pat', status: 'skimmed', via: 'dwell', lines: [{ anchor: shared.anchorForLine(newLines[3]) }] });
    assert.equal(skim.status, 200, JSON.stringify(skim.body));
    const list = await call(`/api/documents/${slug}/line-marks`);
    const byLine = new Map(list.body.lineMarks.map((m: any) => [m.anchor.hash, m]));
    assert.equal((byLine.get(newLines[3].hash) as any).status, 'skimmed');
    assert.equal((byLine.get(newLines[3].hash) as any).via, 'dwell');
    assert.equal((byLine.get(newLines[0].hash) as any).via, 'click');
  });

  await test('/state: the carried mark counts; its line is no Issue for that reader; carriedMarks names it', async () => {
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, agent);
    assert.equal(state.status, 200);
    const carried = state.body.carriedMarks as Array<any>;
    assert.equal(carried.length, 1, JSON.stringify(carried));
    assert.equal(carried[0].by, 'guest:Pat');
    assert.equal(carried[0].lineIndex, 1);
    assert.equal(carried[0].from, oldLines[1].text);
    const issueForLine1 = (state.body.issues as Array<any>).find(i => i.type === 'line' && i.lineIndex === 1);
    assert.ok(!issueForLine1 || !issueForLine1.unseenBy.includes('guest:Pat'));
    const skimmedIssue = (state.body.issues as Array<any>).find(i => i.type === 'line' && i.lineIndex === 3);
    assert.deepEqual(skimmedIssue.skimmedBy, ['guest:Pat']);
    assert.equal(state.body._links?.snapshots?.href, `/api/agent/${slug}/snapshots`);
    assert.equal(state.body._links?.sinceYou?.href, `/api/agent/${slug}/since-you`);
  });

  await test('agent marks are "api"; a section mark is "section"; an ask answer\'s Seen is "ask"', async () => {
    const one = await call(`/api/agent/${slug}/marks/line`, 'POST', { status: 'seen', lineIndex: 2 }, agent);
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.equal(one.body.lineMark.via, 'api');
    const section = await call(`/api/agent/${slug}/marks/line`, 'POST', { status: 'seen', section: { quote: 'Plan' } }, agent);
    assert.equal(section.status, 200, JSON.stringify(section.body));
    assert.ok(section.body.lineMarks.every((m: any) => m.via === 'section'));
    const ask = await call(`/api/agent/${slug}/asks`, 'POST', { lineIndex: 3, recommend: 'Keep $100', to: ['guest:Pat'] }, agent);
    assert.equal(ask.status, 200, JSON.stringify(ask.body));
    const askId = ask.body.ask?.id ?? ask.body.askId;
    const answer = await call(`/api/documents/${slug}/asks/${askId}/answer`, 'POST', { by: 'Pat', choice: 'yes', anchor: shared.anchorForLine(newLines[3]) });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.lineMarked, true, 'a skimmed line is marked Seen by answering');
    const list = await call(`/api/documents/${slug}/line-marks`);
    const pat3 = list.body.lineMarks.find((m: any) => m.by === 'guest:Pat' && m.anchor.hash === newLines[3].hash);
    assert.equal(pat3.status, 'seen');
    assert.equal(pat3.via, 'ask');
  });

  await test('since-you route: a guest (by ?by=) gets their report; an agent key gets its own', async () => {
    const guest = await call(`/api/documents/${slug}/since-you?by=${encodeURIComponent('Pat')}`);
    assert.equal(guest.status, 200, JSON.stringify(guest.body));
    assert.equal(guest.body.actor, 'guest:Pat');
    assert.equal(guest.body.hasHistory, true);
    assert.ok(guest.body.edited.some((item: any) => item.lineIndex === 1 && item.change === 'cosmetic'));
    const ai = await call(`/api/agent/${slug}/since-you`, 'GET', undefined, agent);
    assert.equal(ai.status, 200, JSON.stringify(ai.body));
    assert.equal(ai.body.actor, 'ai:claude-cos');
  });

  await test('aligned snapshot: the report reaching 0 Issues freezes one snapshot (not two); ledger and list', async () => {
    let snaps = await call(`/api/agent/${slug}/snapshots`, 'GET', undefined, agent);
    assert.deepEqual(snaps.body.snapshots, [], 'not aligned yet');
    // Everyone on the team marks every line.
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, agent);
    const team: string[] = state.body.alignment.team;
    for (const member of team) {
      if (member.startsWith('ai:claude-cos')) {
        await call(`/api/agent/${slug}/marks/line`, 'POST', { status: 'agreed', lines: newLines.map(line => ({ lineIndex: line.index })) }, agent);
      } else {
        const r = await call(`/api/agent/${slug}/marks/line`, 'POST', { by: member, status: 'seen', lines: newLines.map(line => ({ lineIndex: line.index })) }, owner);
        assert.equal(r.status, 200, `${member}: ${JSON.stringify(r.body)}`);
      }
    }
    const aligned = await call(`/api/agent/${slug}/state`, 'GET', undefined, agent);
    assert.equal(aligned.body.alignment.aligned, true, JSON.stringify(aligned.body.issues));
    const snapshot = aligned.body.alignment.lastSnapshot;
    assert.ok(snapshot && /^snap_/.test(snapshot.id), JSON.stringify(aligned.body.alignment));
    const again = await call(`/api/agent/${slug}/state`, 'GET', undefined, agent);
    assert.equal(again.body.alignment.lastSnapshot.id, snapshot.id, 'the same aligned state does not freeze twice');
    const check = await call(`/api/documents/${slug}/alignment-check`, 'POST', {});
    assert.equal(check.status, 200, JSON.stringify(check.body));
    assert.equal(check.body.aligned, true);
    assert.equal(check.body.created, false);
    snaps = await call(`/api/agent/${slug}/snapshots`, 'GET', undefined, agent);
    assert.equal(snaps.body.snapshots.length, 1);
    assert.equal(snaps.body.snapshots[0].ledger, `/api/agent/${slug}/snapshots/${snapshot.id}.md`);
    const ledger = await call(`/api/agent/${slug}/snapshots/${snapshot.id}.md`, 'GET', undefined, agent);
    assert.equal(ledger.status, 200);
    assert.match(ledger.text, /# Aligned snapshot: Honest reading test/);
    assert.match(ledger.text, /We will not ship the release/);
    assert.match(ledger.text, /Keep \$100/, 'the ask and its answer are in the ledger');
    const json = await call(`/api/agent/${slug}/snapshots/${snapshot.id}`, 'GET', undefined, agent);
    assert.equal(json.body.snapshot.markdown.includes('$100'), true);
    const page = await call(`/api/documents/${slug}/line-marks`);
    assert.equal(page.body.alignedSnapshot.id, snapshot.id, 'the page learns the snapshot from its poll');
    const pageLedger = await call(`/api/documents/${slug}/snapshots/${snapshot.id}.md`);
    assert.equal(pageLedger.status, 200);
    const missing = await call(`/api/documents/${slug}/snapshots/snap_nope.md`);
    assert.equal(missing.status, 404);
    // A guest who was on the team: "Since you" now starts from the snapshot when it is later.
    const since = await call(`/api/documents/${slug}/since-you?by=Pat`);
    assert.equal(since.body.baseline.source, 'snapshot');
    assert.equal(since.body.baseline.snapshotId, snapshot.id);
  });

  await test('aligned snapshot: a later change starts a new round (not aligned; the old snapshot stays)', async () => {
    const r = await call(`/api/agent/${slug}/marks/line`, 'POST', { status: 'rejected', reason: 'Wrong price', lineIndex: 3 }, agent);
    assert.equal(r.status, 200);
    const state = await call(`/api/agent/${slug}/state`, 'GET', undefined, agent);
    assert.equal(state.body.alignment.aligned, false);
    assert.ok(state.body.alignment.lastSnapshot, 'the last snapshot is still reported');
    const since = await call(`/api/documents/${slug}/since-you?by=Pat`);
    assert.ok(since.body.rejections.some((item: any) => item.reason === 'Wrong price'));
  });
} finally {
  server.close();
}

console.log(`\nhonest-reading tests: ${passed} passed`);
process.exit(0);
