/**
 * Accord usability S4a — one participant-status computation.
 *
 * Mike, 2026-09-23 (usability brief), acceptance check 9: a person who rejected text is never
 * described as not having read it; Seen is never shown as agreement; Approved is the owner's
 * ruling, apart from agreement. The header and the object /state publishes are this computation.
 */
import assert from 'node:assert/strict';
import { accordHeader } from '../shared/open-view';
import {
  objectionsFromState,
  participantStatus,
  personalCompletionText,
  type StatusObjection,
} from '../shared/participant-status';
import {
  actorKey,
  anchorForLine,
  buildLineStates,
  hashLine,
  normalizeLineText,
  type DocLine,
  type LineMark,
  type LineMarkStatus,
} from '../shared/line-marks';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function makeLines(texts: string[]): DocLine[] {
  const seen = new Map<string, number>();
  let pos = 0;
  return texts.map((raw, index) => {
    const kind = 'paragraph';
    const text = normalizeLineText(raw);
    const hash = hashLine(kind, text);
    const occurrence = seen.get(hash) ?? 0;
    seen.set(hash, occurrence + 1);
    const line: DocLine = { index, kind, text, hash, occurrence, pos, nodeSize: text.length + 2, block: index };
    pos += line.nodeSize;
    return line;
  });
}

function mark(line: DocLine, by: string, status: LineMarkStatus, extra: Partial<LineMark> = {}): LineMark {
  return {
    id: `m-${by}-${line.index}-${status}`,
    by,
    status,
    at: '2026-09-23T10:00:00.000Z',
    anchor: { ...anchorForLine(line), text: line.text },
    via: 'click',
    ...extra,
  };
}

const ME = 'human:mike@x.com';
const ALEX = 'human:alex@x.com';
const JO = 'human:jo@x.com';
const NAMES: Record<string, string> = { [ME]: 'Mike', [ALEX]: 'Alex', [JO]: 'Jo' };
const name = (actor: string) => NAMES[actor] ?? actor;

const LINES = () => makeLines([
  'One line of real words here.',
  'Two lines of real words here.',
  'Three lines of real words.',
]);

test('check 9: a rejecter is not unread, Seen is not agreement, Approved stands apart', () => {
  const lines = LINES();
  const marks: LineMark[] = [
    ...lines.map(line => mark(line, ME, 'approved')),
    ...lines.map(line => mark(line, ALEX, 'seen')),
    mark(lines[0], JO, 'agreed'),
    mark(lines[1], JO, 'rejected', { reason: 'The date is wrong' }),
    mark(lines[2], JO, 'rejected', { reason: 'The price is wrong' }),
  ];
  const states = buildLineStates(lines, marks);
  const status = participantStatus({ states, team: [ME, ALEX, JO] });
  const header = accordHeader({ states, team: [ME, ALEX, JO], viewer: ME, name });

  assert.deepEqual(header.status, status, 'the header and the published status are one computation');
  assert.equal(status.aligned, false, 'Jo rejected, so the document is not aligned');
  assert.equal(status.agreed, false, 'nobody has agreed to every passage');
  assert.equal(status.participants[0].approved, true);
  assert.equal(status.participants[0].agreed, false, 'Approved is not agreement');
  assert.equal(status.participants[1].counts.seen, 3);
  assert.equal(status.participants[1].agreed, false);
  assert.equal(status.participants[1].readingStopsAt, null, 'Alex has read every passage');
  assert.deepEqual(status.participants[2].rejections.map(item => item.reason), ['The date is wrong', 'The price is wrong']);

  assert.deepEqual(header.agreed, []);
  assert.deepEqual(header.approved, [ME]);
  assert.equal(header.settled, false);
  assert.match(header.text, /^Approved by you\. /);
  assert.match(header.text, /Alex has seen it and has not agreed\./);
  assert.match(header.text, /Jo rejected 2 lines\./);
  assert.doesNotMatch(header.text, /Jo has not read/);
  assert.doesNotMatch(header.text, /Alex has not read/);
  assert.doesNotMatch(header.text, /Agreed by/);
  const jo = header.clauses.find(clause => clause.actor === JO);
  assert.deepEqual(jo?.lines, [1, 2], 'the rejection clause points at the lines, for the header link');
});

test('an open objection is Rejected, with its reason and its resolution condition', () => {
  const lines = LINES();
  // Objecting stores Seen on the line (OBJECTION_POLICY.objectorMarksSeen). The rejection is the objection.
  const marks = lines.map(line => mark(line, JO, 'seen'));
  const objections: StatusObjection[] = [{
    by: JO,
    reason: 'The date is wrong',
    condition: 'the date moves to Friday',
    lineIndices: [1],
  }];
  const status = participantStatus({ states: buildLineStates(lines, marks), team: [JO], objections });
  const passage = status.participants[0].passages[1];
  assert.equal(passage.state, 'rejected');
  assert.equal(passage.reason, 'The date is wrong');
  assert.equal(passage.condition, 'the date moves to Friday');
  assert.equal(status.participants[0].passages[0].state, 'seen');
  assert.equal(status.participants[0].finishedOwnReview, false);
  const header = accordHeader({ states: buildLineStates(lines, marks), team: [JO], viewer: JO, name, objections });
  assert.equal(header.text, 'You rejected 1 line.');
  assert.doesNotMatch(header.text, /has not read/);
  assert.equal(header.status.participants[0].counts.rejected, status.participants[0].counts.rejected);
});

test('where reading stops is the first unseen passage, and skimmed is unseen', () => {
  const lines = LINES();
  const marks = [mark(lines[0], ALEX, 'agreed'), mark(lines[1], ALEX, 'skimmed')];
  const status = participantStatus({ states: buildLineStates(lines, marks), team: [ALEX] });
  assert.equal(status.participants[0].readingStopsAt, 1);
  assert.equal(status.participants[0].counts.unseen, 2);
  assert.equal(status.participants[0].counts.agreed, 1);
  assert.equal(status.aligned, false);
  const header = accordHeader({ states: buildLineStates(lines, marks), team: [ALEX], viewer: ME, name });
  assert.equal(header.text, 'Alex has not read from line 2 on.');
});

test('a decayed agreement counts as Seen, not as Agreed', () => {
  const lines = LINES();
  const states = buildLineStates(lines, lines.map(line => mark(line, ME, 'agreed')));
  states[1].marks.get(actorKey(ME))!.decayed = true;
  const status = participantStatus({ states, team: [ME] });
  assert.equal(status.participants[0].passages[1].state, 'seen');
  assert.equal(status.participants[0].agreed, false);
  assert.equal(status.aligned, true, 'Seen still counts as having seen the text, and nobody rejects');
  const header = accordHeader({ states, team: [ME], viewer: ME, name });
  assert.equal(header.text, 'You have seen it and have not agreed.');
  assert.equal(header.settled, false);
});

test('a lapsed agreement is "agreed to an earlier version", and it is not aligned', () => {
  const lines = LINES();
  const states = buildLineStates(lines, lines.map(line => mark(line, ME, 'agreed')));
  const entry = states[0].marks.get(actorKey(ME))!;
  entry.current = false;
  entry.lapsed = true;
  entry.lapsedFrom = 'the older wording';
  const status = participantStatus({ states, team: [ME] });
  assert.equal(status.participants[0].passages[0].state, 'lapsed');
  assert.equal(status.participants[0].passages[0].earlierVersion, 'the older wording');
  assert.equal(status.aligned, false);
  assert.equal(status.agreed, false);
  const header = accordHeader({ states, team: [ME], viewer: ME, name });
  assert.match(header.text, /agreed to an earlier version of line 1/);
  assert.doesNotMatch(header.text, /has not read it/);
});

test('personal completion names who has not finished, and never claims team agreement', () => {
  const lines = LINES();
  const marks = [
    ...lines.map(line => mark(line, ME, 'agreed')),
    mark(lines[0], ALEX, 'rejected', { reason: 'no' }),
    mark(lines[0], JO, 'seen'),
  ];
  const status = participantStatus({ states: buildLineStates(lines, marks), team: [ME, ALEX, JO] });
  assert.equal(status.participants[1].finishedOwnReview, false, 'a rejection of one passage does not finish the rest');
  const waiting = personalCompletionText({ status, viewer: ME, name });
  assert.equal(waiting, 'You have finished reviewing. Waiting for Alex and Jo.');
  assert.doesNotMatch(waiting ?? '', /agree/i);

  const notDone = personalCompletionText({ status, viewer: JO, name });
  assert.equal(notDone, null);

  const bothDecided = lines.flatMap(line => [mark(line, ME, 'agreed'), mark(line, ALEX, 'rejected', { reason: 'no' })]);
  const decided = participantStatus({ states: buildLineStates(lines, bothDecided), team: [ME, ALEX] });
  assert.equal(decided.participants[0].finishedOwnReview, true);
  assert.equal(decided.participants[1].finishedOwnReview, true);
  assert.equal(decided.agreed, false, 'a rejection means the team has not agreed');
  const quiet = personalCompletionText({ status: decided, viewer: ME, name });
  assert.equal(quiet, 'You have finished reviewing.');
  assert.doesNotMatch(quiet ?? '', /agree|team|aligned/i);
});

test('objectionsFromState reads the /state objection list the server serializes', () => {
  const raw = [{
    by: JO,
    reason: 'The date is wrong',
    condition: 'the date moves to Friday',
    open: true,
    lines: [{ lineIndex: 1 }, { lineIndex: null }],
  }, {
    by: ALEX,
    reason: 'closed',
    condition: null,
    open: false,
    lines: [{ lineIndex: 0 }],
  }];
  const objections = objectionsFromState(raw);
  assert.equal(objections.length, 1);
  assert.equal(objections[0].condition, 'the date moves to Friday');
  assert.deepEqual(objections[0].lineIndices, [1, null]);
  const lines = LINES();
  const status = participantStatus({
    states: buildLineStates(lines, [mark(lines[1], JO, 'seen')]),
    team: [JO],
    objections,
  });
  assert.equal(status.participants[0].passages[1].state, 'rejected');
  assert.equal(status.participants[0].rejections[0].condition, 'the date moves to Friday');
});

test('someone who has agreed to nothing, and has not rejected, has not read it', () => {
  const lines = LINES();
  const marks = lines.map(line => mark(line, ME, 'agreed'));
  const header = accordHeader({ states: buildLineStates(lines, marks), team: [ME, ALEX], viewer: ME, name });
  assert.equal(header.text, 'Agreed by you. Alex has not read it.');
  assert.equal(header.status.participants[1].readingStopsAt, 0);
  assert.equal(header.readers[1].nothing, true);
});

console.log(`\nparticipant-status tests: ${passed} passed`);
