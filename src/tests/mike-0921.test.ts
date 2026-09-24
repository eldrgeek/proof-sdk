/**
 * Mike, 2026-09-21 (Waiting on Mike Accord): the reading keys never type (writing mode), and the
 * pure parts of the rail scrolling and the top bar.
 * Authorship: Claude Opus 5 (worker proof-bugs6), 2026-09-21.
 */
import assert from 'node:assert/strict';
import {
  READING_MODE_POLICY, isReadingCommandKey, isTextChangingKey, routeKey, type KeyTarget,
} from '../shared/reading-keys';
import {
  EDITING_GUARD_POLICY, isEditing, isWriting, keyTargetOf, noteEditingActivity,
  resetEditingGuardForTests, setDirectEditing,
} from '../editor/editing-guard';
import { RAIL_FOLLOW_POLICY } from '../ui/rail-follow';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const route = (key: string, target: KeyTarget, writing: boolean, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean } = {}) =>
  routeKey({ key, target, writing, ...mods });

test('policy: the rule Mike reads is the rule the code follows', () => {
  assert.equal(READING_MODE_POLICY.hideCaretWhileReading, true);
  assert.equal(READING_MODE_POLICY.showModeChip, true);
  for (const key of ['a', 'A', 'r', 'y', 'n', 't', 'd', 'e', 'j', 'k', '1', '9', 'ArrowUp', 'ArrowDown']) {
    assert.equal(isReadingCommandKey(key), true, key);
  }
  for (const key of ['x', 'z', ' ', 'Escape', 'Tab', 'ArrowLeft', '0']) assert.equal(isReadingCommandKey(key), false, key);
});

test('writing: every key types into the text, the reading keys included', () => {
  for (const key of ['a', 'r', 'j', 'x', ' ', 'Backspace', 'Enter', '1']) assert.equal(route(key, 'editor', true), 'type', key);
});

test('reading with the keyboard in the text (a caret the person did not put there): a key acts or does nothing, never both', () => {
  for (const key of ['a', 'A', 'r', 'y', 'n', 't', 'd', 'e', 'j', 'k', '1', '5', 'ArrowDown']) {
    assert.equal(route(key, 'editor', false), 'command', key);
  }
  for (const key of ['x', 'z', 'Q', ' ', 'Backspace', 'Delete', '0', '?', 'Enter']) assert.equal(route(key, 'editor', false), 'swallow', key);
  for (const key of ['Escape', 'Tab', 'ArrowLeft', 'Shift', 'Home']) assert.equal(route(key, 'editor', false), 'pass', key);
  // Option+A types "å" on a Mac: not a command, and not typed while reading.
  assert.equal(route('å', 'editor', false, { altKey: true }), 'swallow');
  assert.equal(route('å', 'editor', true, { altKey: true }), 'type');
});

test('shortcuts and composition are never reading commands', () => {
  assert.equal(route('z', 'editor', false, { metaKey: true }), 'pass', 'Cmd+Z is the one Undo');
  assert.equal(route('z', 'editor', true, { ctrlKey: true }), 'type');
  assert.equal(route('a', 'other', false, { metaKey: true }), 'pass', 'Cmd+A is select all');
  assert.equal(route('a', 'editor', false, { isComposing: true }), 'pass');
  assert.equal(route('Process', 'editor', false), 'pass');
});

test('fields and controls: typing in a field always types; Enter and Space belong to a button', () => {
  for (const key of ['a', 'j', 'Enter', ' ']) assert.equal(route(key, 'field', false), 'type', key);
  assert.equal(route('a', 'control', false), 'command', 'A on a focused rail button still agrees');
  assert.equal(route('Enter', 'control', false), 'pass', 'Enter presses the button');
  assert.equal(route(' ', 'control', false), 'pass');
  assert.equal(route('a', 'other', false), 'command');
  assert.equal(route('Enter', 'other', false), 'pass', 'Enter no longer starts writing');
  assert.equal(route('x', 'other', false), 'pass');
});

test('text-changing keys', () => {
  assert.equal(isTextChangingKey('x'), true);
  assert.equal(isTextChangingKey('Backspace'), true);
  assert.equal(isTextChangingKey('ArrowLeft'), false);
  assert.equal(isTextChangingKey('Escape'), false);
});

// A small fake DOM: an element that answers closest() for the selectors the guard asks about.
function fakeEl(opts: { tag?: string; editable?: boolean; inEditor?: boolean; link?: boolean; widget?: boolean; button?: boolean } = {}) {
  return {
    tagName: (opts.tag ?? 'P').toUpperCase(),
    isContentEditable: Boolean(opts.editable),
    closest(selector: string) {
      if (selector === '.ProseMirror') return opts.inEditor ? {} : null;
      if (selector === 'a[href]') return opts.link ? {} : null;
      if (selector.startsWith('button, input')) return opts.widget ? {} : null;
      if (selector.startsWith('button, a[href], summary')) return opts.button || opts.link ? {} : null;
      return null;
    },
  };
}

test('where a key is aimed', () => {
  assert.equal(keyTargetOf(fakeEl({ tag: 'input' }) as unknown as EventTarget), 'field');
  assert.equal(keyTargetOf(fakeEl({ editable: true, inEditor: true }) as unknown as EventTarget), 'editor');
  assert.equal(keyTargetOf(fakeEl({ editable: true, inEditor: false }) as unknown as EventTarget), 'field', 'the chat composer or the title');
  assert.equal(keyTargetOf(fakeEl({ tag: 'button', button: true }) as unknown as EventTarget), 'control');
  assert.equal(keyTargetOf(fakeEl({ tag: 'button', button: true, inEditor: true }) as unknown as EventTarget), 'control', 'an ask button inside the text');
  assert.equal(keyTargetOf(fakeEl({ tag: 'input', inEditor: true }) as unknown as EventTarget), 'field', "an ask's words field inside the text");
  assert.equal(keyTargetOf(fakeEl({ tag: 'body' }) as unknown as EventTarget), 'other');
  assert.equal(keyTargetOf(null), 'other');
});



test('direct Editing survives blur; the viewport guard requires focus and recent activity', () => {
  const g = globalThis as unknown as { document?: unknown };
  const previous = g.document;
  const editorEl = { isContentEditable: true, closest: (sel: string) => (sel === '.ProseMirror' ? {} : null), blur() { doc.activeElement = bodyEl; } };
  const bodyEl = { isContentEditable: false, closest: () => null };
  const doc: { activeElement: unknown; body: { classList: { toggle: () => void } } } = { activeElement: editorEl, body: { classList: { toggle: () => {} } } };
  g.document = doc;
  try {
    resetEditingGuardForTests();
    assert.equal(isWriting(), false, 'focus handed to the text by code is not writing');
    assert.equal(isEditing(), false);
    setDirectEditing(true);
    assert.equal(isWriting(), true, 'the labelled control starts Editing');
    setDirectEditing(false);
    assert.equal(isWriting(), false, 'the labelled control ends Editing');
    assert.equal(doc.activeElement, editorEl, 'the labelled control changes mode without moving selection');
    doc.activeElement = editorEl;
    setDirectEditing(true);
    noteEditingActivity(1000);
    assert.equal(isWriting(), true, 'typing in the text is writing');
    assert.equal(isEditing(1000 + EDITING_GUARD_POLICY.graceMs - 1), true);
    assert.equal(isEditing(1000 + EDITING_GUARD_POLICY.graceMs), false, 'the grace period ended (still writing)');
    assert.equal(isWriting(), true);
    doc.activeElement = bodyEl;
    assert.equal(isWriting(), true, 'blur never leaves direct Editing');
  } finally {
    resetEditingGuardForTests();
    g.document = previous;
  }
});

test('rail follow policy: following within a small slack of the end; the pill names what is new', () => {
  assert.equal(RAIL_FOLLOW_POLICY.enabled, true);
  assert.ok(RAIL_FOLLOW_POLICY.slackPx > 0 && RAIL_FOLLOW_POLICY.slackPx <= 40);
  assert.equal(RAIL_FOLLOW_POLICY.pillLabel, 'New below ↓');
  assert.equal(RAIL_FOLLOW_POLICY.containWheel, true);
});


test('letter shortcuts can be disabled without enabling text changes or losing named keys', () => {
  for (const key of ['a', 'R', 'j', 'E']) {
    assert.equal(routeKey({ key, target: 'other', writing: false, letterShortcuts: false }), 'pass');
    assert.equal(routeKey({ key, target: 'editor', writing: false, letterShortcuts: false }), 'swallow');
    assert.equal(routeKey({ key, target: 'field', writing: false, letterShortcuts: true }), 'type');
    assert.notEqual(routeKey({ key, target: 'other', writing: false, isComposing: true }), 'command');
  }
  assert.equal(routeKey({ key: 'ArrowDown', target: 'other', writing: false, letterShortcuts: false }), 'command');
});

console.log(`\nmike-0921 tests: ${passed} passed`);
