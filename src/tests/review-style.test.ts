import assert from 'node:assert/strict';
import { getReviewStyle, setReviewStyle, getReviewWalk, setReviewWalk, normalizeReviewStyle, REVIEW_STYLE_EVENT } from '../editor/review-style';

const values = new Map<string, string>();
const target = new EventTarget() as EventTarget & { localStorage: unknown; __PROOF_CONFIG__: { defaultReviewStyle?: string } };
target.localStorage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
target.__PROOF_CONFIG__ = {};
Object.assign(globalThis, { window: target });
assert.equal(getReviewStyle(), 'proof');
assert.equal(normalizeReviewStyle(undefined), 'proof');
assert.equal(normalizeReviewStyle('PLAYMAKER'), 'playmaker');
target.__PROOF_CONFIG__.defaultReviewStyle = 'playmaker';
assert.equal(getReviewStyle(), 'playmaker');
let changes = 0; target.addEventListener(REVIEW_STYLE_EVENT, () => changes++);
setReviewStyle('proof'); assert.equal(getReviewStyle(), 'proof');
setReviewStyle('playmaker'); assert.equal(getReviewStyle(), 'playmaker');
assert.equal(changes, 2, 'Switching takes effect by event, without navigation');
assert.equal(getReviewWalk(), true); setReviewWalk(false); assert.equal(getReviewWalk(), false);
console.log('✓ review settings and immediate switching');
