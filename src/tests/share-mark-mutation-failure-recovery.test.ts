import assert from 'node:assert/strict';
import {
  reconcileShareMarkMutationBatch,
  recoverShareMarksAfterMutationFailure,
} from '../editor/share-mark-mutation.js';

async function testNonTransientFailureRestoresMarks(): Promise<void> {
  let bannerMessage = '';
  let appliedMarks: Record<string, unknown> | null = null;
  let fetchCount = 0;

  const result = await recoverShareMarksAfterMutationFailure({
    failure: {
      error: {
        status: 409,
        code: 'ANCHOR_NOT_FOUND',
        message: 'Suggestion anchor quote not found in document',
      },
    },
    fallbackMessage: 'Unable to accept suggestion.',
    fetchOpenContext: async () => {
      fetchCount += 1;
      return {
        success: true,
        collabAvailable: false,
        snapshotUrl: null,
        doc: {
          slug: 'test-doc',
          title: 'Test',
          markdown: 'Hello world',
          marks: {
            'server-mark': {
              kind: 'replace',
              by: 'ai:test',
              quote: 'Hello',
              content: 'Hi',
              status: 'pending',
            },
          },
        },
        capabilities: { canRead: true, canComment: true, canEdit: true },
        links: { webUrl: 'https://example.com', snapshotUrl: null },
      };
    },
    showErrorBanner: (message) => {
      bannerMessage = message;
    },
    applyServerMarks: (marks) => {
      appliedMarks = marks;
    },
  });

  assert.equal(result.refreshed, true, 'Expected failure recovery to refetch authoritative marks');
  assert.equal(fetchCount, 1, 'Expected one open-context refresh after mutation failure');
  assert.equal(bannerMessage, 'Suggestion anchor quote not found in document', 'Expected server error to surface in the banner');
  assert.deepEqual(
    appliedMarks,
    {
      'server-mark': {
        kind: 'replace',
        by: 'ai:test',
        quote: 'Hello',
        content: 'Hi',
        status: 'pending',
      },
    },
    'Expected failure recovery to reapply authoritative server marks',
  );
}

async function testTransientFailureConvergesWithoutBanner(): Promise<void> {
  let bannerMessage = '';
  let appliedMarks: Record<string, unknown> | null = null;
  let fetchCount = 0;
  const pendingMark = {
    kind: 'insert',
    by: 'ai:test',
    content: 'world',
    status: 'pending',
  };

  const result = await recoverShareMarksAfterMutationFailure({
    failure: {
      error: {
        status: 409,
        code: 'COLLAB_SYNC_FAILED',
        message: 'Suggestion did not converge yet',
      },
    },
    fallbackMessage: 'Unable to accept suggestion.',
    expectedResolutions: { 'mark-1': 'accepted' },
    pollDelaysMs: [0],
    sleep: async () => {},
    fetchOpenContext: async () => {
      fetchCount += 1;
      return {
        success: true,
        doc: {
          slug: 'test-doc',
          title: 'Test',
          markdown: 'Hello world',
          marks: fetchCount === 1 ? { 'mark-1': pendingMark } : {},
        },
        capabilities: { canRead: true, canComment: true, canEdit: true },
        links: { webUrl: 'https://example.com', snapshotUrl: null },
      };
    },
    showErrorBanner: (message) => {
      bannerMessage = message;
    },
    applyServerMarks: (marks) => {
      appliedMarks = marks;
    },
  });

  assert.equal(result.converged, true, 'Expected a later resolved server state to converge');
  assert.equal(fetchCount, 2, 'Expected the pending state to be polled once more');
  assert.equal(bannerMessage, '', 'A converged transient failure must not show an error banner');
  assert.deepEqual(appliedMarks, {}, 'Expected authoritative resolved marks to replace the optimistic metadata');
}

async function testPendingAfterBackoffRestoresDocument(): Promise<void> {
  let bannerMessage = '';
  let restoredMarkdown = '';
  let fetchCount = 0;
  const pendingMark = {
    kind: 'insert',
    by: 'ai:test',
    content: 'world',
    status: 'pending',
  };

  const result = await recoverShareMarksAfterMutationFailure({
    failure: {
      error: {
        status: 409,
        code: 'COLLAB_SYNC_FAILED',
        message: 'Suggestion did not converge yet',
      },
    },
    fallbackMessage: 'Unable to reject suggestion.',
    expectedResolutions: { 'mark-1': 'rejected' },
    pollDelaysMs: [0, 0],
    sleep: async () => {},
    fetchOpenContext: async () => {
      fetchCount += 1;
      return {
        success: true,
        doc: {
          slug: 'test-doc',
          title: 'Test',
          markdown: 'Hello world',
          marks: { 'mark-1': pendingMark },
        },
        capabilities: { canRead: true, canComment: true, canEdit: true },
        links: { webUrl: 'https://example.com', snapshotUrl: null },
      };
    },
    showErrorBanner: (message) => {
      bannerMessage = message;
    },
    applyServerMarks: () => {
      assert.fail('A still-pending server state must restore the full document');
    },
    applyServerDocument: (doc) => {
      restoredMarkdown = doc.markdown;
    },
  });

  assert.equal(result.converged, false);
  assert.deepEqual(result.unresolvedIds, ['mark-1']);
  assert.equal(fetchCount, 3, 'Expected all configured backoff polls before restoring');
  assert.match(bannerMessage, /server still reports 1 suggestion as pending/i);
  assert.equal(restoredMarkdown, 'Hello world', 'Expected server markdown and marks to be restored together');
}

async function testRejectAllRetriesFailedSuggestion(): Promise<void> {
  const serverMarks: Record<string, {
    kind: 'insert' | 'delete';
    by: string;
    status: 'pending' | 'rejected';
  }> = {
    insert: { kind: 'insert', by: 'ai:test', status: 'pending' },
    delete: { kind: 'delete', by: 'ai:test', status: 'pending' },
  };
  const mutationCalls = new Map<string, number>();
  let appliedMarks: Record<string, unknown> | null = null;
  let bannerMessage = '';

  const result = await reconcileShareMarkMutationBatch({
    markIds: ['insert', 'delete'],
    finalStatus: 'rejected',
    mutate: async (markId) => {
      const callCount = (mutationCalls.get(markId) ?? 0) + 1;
      mutationCalls.set(markId, callCount);
      if (markId === 'delete' && callCount === 1) {
        return {
          error: {
            status: 409,
            code: 'STALE_BASE',
            message: 'Mutation base is stale',
          },
        };
      }
      serverMarks[markId].status = 'rejected';
      return { success: true, marks: { ...serverMarks } };
    },
    fetchOpenContext: async () => ({
      success: true,
      doc: {
        slug: 'test-doc',
        title: 'Test',
        markdown: 'Bulk A words ready',
        marks: { ...serverMarks },
      },
      capabilities: { canRead: true, canComment: true, canEdit: true },
      links: { webUrl: 'https://example.com', snapshotUrl: null },
    }),
    fallbackMessage: 'Unable to reject every suggestion.',
    showErrorBanner: (message) => {
      bannerMessage = message;
    },
    applyServerMarks: (marks) => {
      appliedMarks = marks;
    },
    applyServerDocument: () => {
      assert.fail('The retried batch should converge without restoring a pending document');
    },
    pollDelaysMs: [0],
    sleep: async () => {},
  });

  assert.equal(result.converged, true);
  assert.deepEqual(result.retriedIds, ['delete']);
  assert.equal(mutationCalls.get('insert'), 1);
  assert.equal(mutationCalls.get('delete'), 2, 'Expected the failed delete rejection to retry with fresh mutation state');
  assert.equal(bannerMessage, '');
  assert.equal((appliedMarks as Record<string, { status: string }> | null)?.delete.status, 'rejected');
}

async function run(): Promise<void> {
  await testNonTransientFailureRestoresMarks();
  await testTransientFailureConvergesWithoutBanner();
  await testPendingAfterBackoffRestoresDocument();
  await testRejectAllRetriesFailedSuggestion();

  console.log('share-mark-mutation-failure-recovery.test.ts passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
