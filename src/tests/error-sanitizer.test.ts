import assert from 'node:assert/strict';
import { sanitizeErrorText } from '../../public/js/proof-error-sanitizer.js';

const cases = [
  ['Index 9 out of range for <"CONFIDENTIAL document sentence">', 'Index 9 out of range for [text]'],
  ["TypeError: Cannot read properties of undefined (reading 'selection')", 'TypeError: Cannot read properties of undefined (reading [text])'],
  ['Failed https://site.test/app.js?token=SECRET#private', 'Failed https://site.test/app.js'],
  ['RangeError: Position 9 out of range', 'RangeError: Position 9 out of range'],
  ['Error: `private words` “private words” [private words] "private words"', 'Error: [text] [text] [text] [text]'],
  ['Error: These confidential words form a passage longer than forty letters', 'Error: [text]'],
  ['Error: ' + 'a'.repeat(40), 'Error: ' + 'a'.repeat(40)],
  ['Error: ' + 'a'.repeat(41), 'Error: [text]'],
  ['Error: <node <nested> confidential tail> [node [nested] confidential tail]', 'Error: [text] [text]'],
  ['TypeError: failed\n    at applyTransaction (https://site.test/app.js?token=SECRET:12:34)\nupdate@https://site.test/editor.js?token=SECRET:56:78',
    'TypeError: failed\n    at applyTransaction (https://site.test/app.js:12:34)\nupdate@https://site.test/editor.js:56:78'],
  ['    at veryLongFunctionNameThatMustSurviveIntactForDiagnosis (/assets/veryLongFileNameThatMustSurviveIntactForDiagnosis.js:1:2)',
    '    at veryLongFunctionNameThatMustSurviveIntactForDiagnosis (/assets/veryLongFileNameThatMustSurviveIntactForDiagnosis.js:1:2)'],
];
for (const [input, expected] of cases) {
  assert.equal(sanitizeErrorText(input), expected);
  assert.equal(sanitizeErrorText(expected), expected, 'browser/server double sanitization must be stable');
}
console.log('Shared error sanitizer tests passed');
