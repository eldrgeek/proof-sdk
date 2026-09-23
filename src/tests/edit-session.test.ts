/**
 * Accord round 2, stage A — the one rule with three doors, proved before the feature was built.
 *
 * The property this file exists for: leaving an edit NEVER loses a character. Whatever the person
 * typed, whichever door they left by, the proposal carries their text exactly.
 *
 * Authorship: Mike Wolf (rulings), built by Claude Opus 5 (worker accord-edit), 2026-09-22.
 */
import assert from 'node:assert/strict';
import {
  EDIT_SESSION_POLICY, POSTED_NOTICE_TEXT, beginEditSession, describeEditProposal, editingHelpText,
  editingStatusText, endEditSession, type EditDoor,
} from '../shared/edit-session';
import { smallestEdit } from '../ui/edit-gesture';
import { READING_MODE_POLICY } from '../shared/reading-keys';
import { UNDO_KINDS } from '../shared/undo';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const session = (original: string, suggesting = false, lineIndex = 13) =>
  beginEditSession({ lineIndex, original, suggesting, now: 1000 });

test('policy: leaving posts, nothing discards, and Cmd+Enter is the advertised door', () => {
  assert.equal(EDIT_SESSION_POLICY.leavingPosts, true);
  assert.equal(EDIT_SESSION_POLICY.undoIsTheOnlyRemoval, true);
  assert.equal(EDIT_SESSION_POLICY.undoEntriesPerPost, 1);
  assert.equal(EDIT_SESSION_POLICY.advertisedDoor, 'cmd-enter');
  assert.deepEqual([...EDIT_SESSION_POLICY.deliberateDoors], ['cmd-enter', 'click-outside', 'escape'],
    'the three doors a person opens on purpose');
  for (const door of EDIT_SESSION_POLICY.deliberateDoors) {
    assert.ok(EDIT_SESSION_POLICY.doors.includes(door), `${door} is a door`);
  }
  assert.equal(EDIT_SESSION_POLICY.phoneDoneControl, true, 'a phone has no Cmd+Enter, so it shows Done');
});

test('THE PROPERTY: a leave with text never loses a character, through any door', () => {
  // Awkward text on purpose: emoji, combining marks, tabs, trailing space, a lone surrogate pair,
  // markdown syntax, and a string that differs from the original only in whitespace.
  const originals = ['', 'a', 'The line as it stood.', '  leading and trailing  ', '# A heading'];
  const typed = [
    '', 'a', 'The line as it stood.', 'The line as it stood. ', 'The line as it stood.​',
    'x', 'ürgen 👨‍👩‍👧‍👦 é́ ok', '\ttabbed\t', 'one\ntwo', '**bold** and `code`',
    'a'.repeat(5000), '  leading and trailing  ', 'The line as it stood!', '🙂', '𝔘𝔫𝔦𝔠𝔬𝔡𝔢',
  ];
  let posts = 0;
  let silences = 0;
  for (const original of originals) {
    for (const current of typed) {
      for (const door of EDIT_SESSION_POLICY.doors) {
        for (const suggesting of [false, true]) {
          const leave = endEditSession(session(original, suggesting), current, door);
          if (current === original) {
            silences += 1;
            assert.equal(leave.posted, false, `unchanged text must be silent (${door})`);
            continue;
          }
          posts += 1;
          assert.equal(leave.posted, true, `changed text must post (${door}, ${JSON.stringify(current)})`);
          if (!leave.posted) continue;
          // Character for character. Not trimmed, not normalised, not shortened.
          assert.equal(leave.proposal.proposed, current, 'the proposal is exactly what was typed');
          assert.equal(leave.proposal.proposed.length, current.length, 'no characters were dropped');
          assert.equal([...leave.proposal.proposed].length, [...current].length, 'no code points were dropped');
          assert.equal(leave.proposal.original, original, 'the original stays readable underneath');
          assert.equal(leave.proposal.lineIndex, 13);
          assert.equal(leave.door, door);
          assert.equal(leave.alreadyTracked, suggesting);
        }
      }
    }
  }
  assert.ok(posts > 500 && silences > 0, `covered ${posts} posts and ${silences} silent leaves`);
});

test('the three doors are one action: same text in, same proposal out', () => {
  const original = 'Greg hosts Legends.';
  const current = 'Greg hosts Legends, with Bill.';
  const results = (['cmd-enter', 'click-outside', 'escape'] as EditDoor[])
    .map(door => endEditSession(session(original), current, door));
  for (const leave of results) {
    assert.equal(leave.posted, true);
    if (!leave.posted) return;
    assert.deepEqual(leave.proposal, results[0].posted ? results[0].proposal : null,
      'every door produces the same proposal');
    assert.equal(leave.undoDescription, describeEditProposal(13));
  }
});

test('the accidental paths post too: hover away and scrolling the caret out of view', () => {
  for (const door of ['hover', 'scrolled-away', 'blur'] as EditDoor[]) {
    const leave = endEditSession(session('before'), 'before and after', door);
    assert.equal(leave.posted, true, `${door} must post, not drop the text`);
    if (leave.posted) assert.equal(leave.proposal.proposed, 'before and after');
  }
  assert.equal(READING_MODE_POLICY.hoverEndsWriting, true, 'hover still ends the edit');
  assert.equal(READING_MODE_POLICY.caretOutOfViewEndsWriting, true, 'scrolling away still ends it');
  assert.equal(READING_MODE_POLICY.escapeEndsWriting, true, 'Esc still ends it');
  assert.equal(READING_MODE_POLICY.leavingPostsTheEdit, true,
    'and every one of those paths now posts what was typed');
});

test('nothing changed: leaving posts nothing and says nothing', () => {
  for (const door of EDIT_SESSION_POLICY.doors) {
    const leave = endEditSession(session('unchanged text'), 'unchanged text', door);
    assert.equal(leave.posted, false);
    assert.equal(leave.posted === false && leave.reason, 'unchanged');
  }
  // A caret moved through a line without typing is the common case, and it must be silent.
  const leave = endEditSession(session(''), '', 'cmd-enter');
  assert.equal(leave.posted, false);
});

test('one Undo entry per posted proposal, in the words the person reads', () => {
  assert.equal(describeEditProposal(0), 'proposed a change to line 1');
  assert.equal(describeEditProposal(13), 'proposed a change to line 14');
  assert.ok('suggestion' in UNDO_KINDS, 'the Undo entry is a change (src/shared/undo.ts)');
  assert.equal(UNDO_KINDS.suggestion, 'change');
});

test('what the person is told: the state, and the way out', () => {
  assert.equal(editingStatusText(13), 'Editing line 14');
  assert.equal(editingStatusText(0), 'Editing line 1');
  assert.equal(POSTED_NOTICE_TEXT, 'Proposed');
  assert.match(editingHelpText(false), /Cmd\+Enter/, 'the desktop names the advertised gesture');
  assert.match(editingHelpText(false), /Esc/, 'and says Esc is safe');
  assert.match(editingHelpText(true), /Done/, 'the phone names its visible control');
  assert.doesNotMatch(editingHelpText(true), /Cmd\+Enter/, 'a phone has no Cmd+Enter');
});

test('a session carries the mode it began in, so the poster never writes a second proposal', () => {
  const tracked = endEditSession(session('a', true), 'ab', 'cmd-enter');
  assert.equal(tracked.posted && tracked.alreadyTracked, true, 'Suggesting mode already made the proposal');
  const direct = endEditSession(session('a', false), 'ab', 'cmd-enter');
  assert.equal(direct.posted && direct.alreadyTracked, false, 'Editing mode: the poster converts it');
});

test('smallestEdit: the revert touches only the characters that differ, and is exact', () => {
  // The leave puts the line back before it posts the proposal. If that replacement is off by a
  // character the line reads twice (it did, on 2026-09-22, before the live-document read).
  const cases: Array<[string, string]> = [
    ['', ''], ['a', 'a'], ['', 'abc'], ['abc', ''],
    ['The line as it stood.', 'The line as it stood.'],
    ['The line as it stood.', 'The line as it stZZood.'],
    ['The line as it stood.', 'The line as it stood. And more.'],
    ['prefix middle suffix', 'prefix suffix'],
    ['aaaa', 'aa'], ['aa', 'aaaa'],
    ['🙂 text', '🙂 other text'],
    ['one\ntwo', 'one\ntwo\nthree'],
    ['abc', 'xyz'],
  ];
  for (const [before, after] of cases) {
    const edit = smallestEdit(before, after);
    if (before === after) { assert.equal(edit, null, `${JSON.stringify(before)} is unchanged`); continue; }
    assert.ok(edit, `${JSON.stringify([before, after])} should produce an edit`);
    // Applying it must reproduce `after` exactly — this is the whole contract.
    const applied = before.slice(0, edit!.from) + edit!.text + before.slice(edit!.to);
    assert.equal(applied, after, `applying the edit gave ${JSON.stringify(applied)}`);
    assert.ok(edit!.from >= 0 && edit!.to >= edit!.from && edit!.to <= before.length, `range ${JSON.stringify(edit)}`);
  }
  // It is minimal: a one-character change replaces one character.
  const one = smallestEdit('abcdef', 'abXdef');
  assert.deepEqual(one, { from: 2, to: 3, text: 'X' });
  // An insertion replaces nothing.
  assert.deepEqual(smallestEdit('abcdef', 'abcXdef'), { from: 3, to: 3, text: 'X' });
  // A deletion inserts nothing.
  assert.deepEqual(smallestEdit('abcXdef', 'abcdef'), { from: 3, to: 4, text: '' });
});

console.log(`\n${passed} edit-session tests passed`);
