import assert from 'node:assert/strict';

import {
  createShareSuggestionReviewUpdateScheduler,
  shouldUpdateShareSuggestionReviewDisplay,
} from '../editor/share-suggestion-review';

assert.equal(
  shouldUpdateShareSuggestionReviewDisplay({
    docChanged: false,
    marksMeta: undefined,
  }),
  false,
  'Pure selection/cursor transactions should not refresh the suggestion review pill',
);

assert.equal(
  shouldUpdateShareSuggestionReviewDisplay({
    docChanged: true,
    marksMeta: undefined,
  }),
  true,
  'Document edits should refresh the suggestion review pill',
);

assert.equal(
  shouldUpdateShareSuggestionReviewDisplay({
    docChanged: false,
    marksMeta: { type: 'SET_METADATA' },
  }),
  true,
  'Marks metadata updates should refresh the suggestion review pill',
);

const pendingFrames = new Map<number, () => void>();
let nextFrameId = 1;
const cancelledFrames: number[] = [];

const scheduler = createShareSuggestionReviewUpdateScheduler(
  (run: () => void) => {
    const frameId = nextFrameId++;
    pendingFrames.set(frameId, run);
    return frameId;
  },
  (frameId: number) => {
    cancelledFrames.push(frameId);
    pendingFrames.delete(frameId);
  },
);

let invocationCount = 0;
scheduler.schedule(() => { invocationCount += 1; });
scheduler.schedule(() => { invocationCount += 100; });
assert.equal(pendingFrames.size, 1, 'Scheduler should coalesce multiple requests into one frame');
assert.equal(scheduler.isScheduled(), true, 'Scheduler should report a pending frame after scheduling');

const firstFrame = Array.from(pendingFrames.values())[0];
pendingFrames.clear();
firstFrame?.();
assert.equal(invocationCount, 1, 'Only the first coalesced callback should run in the frame');
assert.equal(scheduler.isScheduled(), false, 'Scheduler should clear pending state after the frame runs');

scheduler.schedule(() => { invocationCount += 1; });
const secondFrameId = Array.from(pendingFrames.keys())[0];
assert.ok(secondFrameId, 'Expected a second frame to be scheduled');
scheduler.cancel();
assert.equal(
  cancelledFrames.includes(secondFrameId),
  true,
  'Cancelling should clear the currently scheduled frame',
);
assert.equal(scheduler.isScheduled(), false, 'Scheduler should report no pending frame after cancellation');
assert.equal(invocationCount, 1, 'Cancelled frames should not run callbacks');

console.log('✓ share suggestion review gating and scheduler');
