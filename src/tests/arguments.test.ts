/**
 * Accord — arguments on a proposal (src/shared/arguments.ts).
 *
 * Mike, 2026-10-24: an argument is advocacy for or against a change; observers can argue; arguments
 * retire once the change is agreed and stay in the log for replay.
 */
import assert from 'node:assert/strict';
import {
  ARGUMENT_POLICY,
  activeArguments,
  argumentLine,
  argumentsOn,
  argumentsText,
  changeLabel,
  findDuplicateArgument,
  parseArgumentText,
  parseStance,
  retiredCount,
  type Argument,
} from '../shared/arguments.js';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const args: Argument[] = [
  { id: 1, markId: 'm1', by: 'human:ada', stance: 'for', text: 'Shorter.', at: '2026-10-25T10:00:00Z' },
  { id: 2, markId: 'm1', by: 'ai:claude', stance: 'against', text: 'Loses the date.', at: '2026-10-25T10:01:00Z' },
  { id: 3, markId: 'm2', by: 'ai:claude', stance: 'for', text: 'Agreed already.', at: '2026-10-25T09:00:00Z' },
  { id: 4, markId: 'm1', by: 'human:bo', stance: 'for', text: 'Reads better.', at: '2026-10-25T10:02:00Z' },
];

test('observers may argue, and arguments retire when settled', () => {
  assert.equal(ARGUMENT_POLICY.observersMayArgue, true);
  assert.equal(ARGUMENT_POLICY.retireWhenSettled, true);
});

test('a stance is for or against; the words are trimmed and bounded', () => {
  assert.equal(parseStance('for'), 'for');
  assert.equal(parseStance('against'), 'against');
  assert.equal(parseStance('maybe'), null);
  assert.equal(parseArgumentText('  yes  '), 'yes');
  assert.equal(parseArgumentText('   '), null);
  assert.equal(parseArgumentText(42), null);
  assert.equal(parseArgumentText('x'.repeat(ARGUMENT_POLICY.maxText + 1)), null);
});

test('only arguments on open proposals are active; the rest are retired, not deleted', () => {
  assert.deepEqual(activeArguments(args, ['m1']).map(a => a.id), [1, 2, 4]);
  assert.equal(retiredCount(args, ['m1']), 1);
  assert.deepEqual(activeArguments(args, []), []);
  assert.equal(retiredCount(args, []), args.length);
});

test('the Review row counts arguments by stance', () => {
  assert.equal(argumentsText(args, ['m1']), '2 for · 1 against');
  assert.equal(argumentsText(args, ['m2']), '1 for');
  assert.equal(argumentsText(args, ['m9']), null);
  assert.deepEqual(argumentsOn(args, ['m1']).against.map(a => a.id), [2]);
});

test('one argument reads as its stance, who made it, and its words', () => {
  assert.equal(argumentLine(args[1], a => a.replace(/^ai:/, '').replace(/^./, c => c.toUpperCase())), 'Against, Claude: Loses the date.');
});

test('the same argument twice from the same person is one argument', () => {
  assert.equal(findDuplicateArgument(args, { markId: 'm1', by: 'human:ada', stance: 'for', text: 'Shorter.' })?.id, 1);
  assert.equal(findDuplicateArgument(args, { markId: 'm1', by: 'human:ada', stance: 'against', text: 'Shorter.' }), undefined);
  assert.equal(findDuplicateArgument(args, { markId: 'm1', by: 'human:bo', stance: 'for', text: 'Shorter.' }), undefined);
});

test('a change is named by what it does, short enough for a button', () => {
  assert.equal(changeLabel({ kind: 'replace', quote: 'in Boston', content: 'in Denver' }), '"in Boston" → "in Denver"');
  assert.equal(changeLabel({ kind: 'insert', content: 'every' }), 'Adds "every"');
  assert.equal(changeLabel({ kind: 'delete', quote: 'the same' }), 'Removes "the same"');
  assert.equal(changeLabel({ kind: 'delete', quote: 'x'.repeat(60) }, 10), `Removes "${'x'.repeat(9)}…"`);
});

console.log(`\narguments tests: ${passed} passed`);
