import assert from 'node:assert/strict';
import { reconcileAuthoritativeShareDocument } from '../editor/share-document-recovery.js';
import type { StoredMark } from '../editor/plugins/marks.js';

const serverMarks: Record<string, StoredMark> = {
  suggestion: {
    kind: 'insert',
    by: 'ai:test',
    quote: 'inserted',
    content: 'inserted',
    status: 'pending',
  },
};

function testConnectedCollabNeverReloadsDocumentText(): void {
  let loadCalls = 0;
  let appliedMarks: Record<string, StoredMark> | null = null;

  reconcileAuthoritativeShareDocument({
    collabConnected: true,
    markdown: 'Before <span data-proof="suggestion" data-id="suggestion" data-by="ai:test" data-kind="insert">inserted</span> after',
    serverMarks,
    loadDocument: () => {
      loadCalls += 1;
    },
    applyServerMarks: (marks) => {
      appliedMarks = marks;
    },
  });

  assert.equal(loadCalls, 0, 'Connected collaboration recovery must leave Yjs-authoritative text untouched');
  assert.deepEqual(appliedMarks, serverMarks, 'Connected collaboration recovery must still reconcile marks');
}

function testDisconnectedFallbackStripsProofSpansBeforeReload(): void {
  let loadedMarkdown = '';

  reconcileAuthoritativeShareDocument({
    collabConnected: false,
    markdown: 'Before <span data-proof="suggestion" data-id="suggestion" data-by="ai:test" data-kind="insert">inserted</span> after',
    serverMarks,
    loadDocument: (markdown) => {
      loadedMarkdown = markdown;
    },
    applyServerMarks: () => {},
  });

  assert(!loadedMarkdown.includes('<span data-proof='), 'Disconnected recovery must strip existing Proof spans');
  assert(!loadedMarkdown.includes('suggestion" data-id='), 'Disconnected recovery must not expose Proof attributes as text');
  assert(loadedMarkdown.includes('Before inserted after'), 'Disconnected recovery must preserve visible document text');
}

testConnectedCollabNeverReloadsDocumentText();
testDisconnectedFallbackStripsProofSpansBeforeReload();

console.log('share-document-recovery.test.ts passed');
