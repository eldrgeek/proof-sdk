import assert from 'node:assert/strict';
import { REVIEW_STYLE_POLICY, getReviewStyle, setReviewStyle, getReviewWalk, setReviewWalk, normalizeReviewStyle, REVIEW_STYLE_EVENT } from '../editor/review-style';

const values = new Map<string, string>();
const target = new EventTarget() as EventTarget & { localStorage: unknown; __PROOF_CONFIG__: { defaultReviewStyle?: string } };
target.localStorage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
target.__PROOF_CONFIG__ = {};
Object.assign(globalThis, { window: target });
// Mike 2026-09-19: Proof Documents is the only review behaviour (the style is locked).
assert.equal(REVIEW_STYLE_POLICY.locked, 'playmaker');
assert.equal(getReviewStyle(), 'playmaker', 'Locked: no stored or configured value brings back the Proof review UI');
setReviewStyle('proof'); assert.equal(getReviewStyle(), 'playmaker', 'Locked: switching has no effect');
// The unlocked machinery still works when the lock is lifted.
REVIEW_STYLE_POLICY.locked = null;
values.clear(); target.__PROOF_CONFIG__ = {};
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
target.localStorage = { getItem: () => 'playmaker', setItem: () => { throw new Error('Quota exceeded'); } };
setReviewStyle('proof'); assert.equal(getReviewStyle(), 'proof', 'A storage write failure cannot prevent immediate switching');
console.log('✓ review settings and immediate switching');
