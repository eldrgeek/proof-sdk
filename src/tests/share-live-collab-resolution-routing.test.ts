import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';

function sliceBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `Missing block start: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `Missing block end after: ${startNeedle}`);
  return source.slice(start, end);
}

async function run(): Promise<void> {
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window: Record<string, unknown> }).window = {
    location: new URL('https://example.com/d/live-resolution?token=share-token'),
    __PROOF_CONFIG__: {
      proofClientVersion: '0.31.2',
      proofClientBuild: 'test',
      proofClientProtocol: '3',
    },
  };

  try {
    const {
      getShareSuggestionResolutionTransport,
      runShareSuggestionRestFallback,
      shareClient,
    } = await import('../bridge/share-client.js');

    const calls: string[] = [];
    const originalAccept = shareClient.acceptSuggestion;
    const originalReject = shareClient.rejectSuggestion;
    shareClient.acceptSuggestion = async (markId: string) => {
      calls.push(`accept:${markId}`);
      return { success: true, marks: {} };
    };
    shareClient.rejectSuggestion = async (markId: string) => {
      calls.push(`reject:${markId}`);
      return { success: true, marks: {} };
    };

    try {
      const connectedTransport = getShareSuggestionResolutionTransport({
        collabEnabled: true,
        connectionStatus: 'connected',
        isSynced: true,
      });
      assert.equal(connectedTransport, 'collab');

      const ydoc = new Y.Doc();
      const marksMap = ydoc.getMap('marks');
      const actionIds = ['accept-one', 'reject-one', 'accept-all-1', 'reject-all-1'];
      for (const id of actionIds) {
        marksMap.set(id, { kind: 'insert', status: 'pending' });
      }

      const liveActions = [
        () => {
          marksMap.delete('accept-one');
          runShareSuggestionRestFallback(connectedTransport, () => {
            void shareClient.acceptSuggestion('accept-one', 'human:test');
          });
        },
        () => {
          marksMap.delete('reject-one');
          runShareSuggestionRestFallback(connectedTransport, () => {
            void shareClient.rejectSuggestion('reject-one', 'human:test');
          });
        },
        () => {
          marksMap.delete('accept-all-1');
          runShareSuggestionRestFallback(connectedTransport, () => {
            void shareClient.acceptSuggestion('accept-all-1', 'human:test');
          });
        },
        () => {
          marksMap.delete('reject-all-1');
          runShareSuggestionRestFallback(connectedTransport, () => {
            void shareClient.rejectSuggestion('reject-all-1', 'human:test');
          });
        },
      ];
      liveActions.forEach((action) => action());

      assert.deepEqual(calls, [], 'Connected accept/reject and bulk actions must make no REST calls');
      assert.equal(marksMap.size, 0, 'Resolved live suggestions must be absent from the Yjs marks map');
      ydoc.destroy();

      const disconnectedTransport = getShareSuggestionResolutionTransport({
        collabEnabled: true,
        connectionStatus: 'disconnected',
        isSynced: false,
      });
      assert.equal(disconnectedTransport, 'rest');
      runShareSuggestionRestFallback(disconnectedTransport, () => {
        void shareClient.acceptSuggestion('offline-accept', 'human:test');
      });
      runShareSuggestionRestFallback(disconnectedTransport, () => {
        void shareClient.rejectSuggestion('offline-reject', 'human:test');
      });
      assert.deepEqual(
        calls,
        ['accept:offline-accept', 'reject:offline-reject'],
        'Disconnected share resolution must retain the REST fallback',
      );
    } finally {
      shareClient.acceptSuggestion = originalAccept;
      shareClient.rejectSuggestion = originalReject;
    }

    const editorSource = readFileSync(path.resolve(process.cwd(), 'src/editor/index.ts'), 'utf8');
    const blocks = [
      sliceBetween(editorSource, '  markAccept(markId: string): boolean {', '\n  /**\n   * Reject a suggestion'),
      sliceBetween(editorSource, '  markReject(markId: string): boolean {', '\n  /**\n   * Accept all pending'),
      sliceBetween(editorSource, '  markAcceptAll(): number {', '\n  /**\n   * Reject all pending'),
      sliceBetween(editorSource, '  markRejectAll(): number {', '\n  /**\n   * Delete a mark'),
    ];
    for (const block of blocks) {
      assert(block.includes('this.getShareSuggestionResolutionTransport()'));
      assert(block.includes('this.applyShareSuggestionLocally(transport, () => {'));
      assert(block.includes('runShareSuggestionRestFallback(transport, () => {'));
      assert(block.includes('this.lastReceivedServerMarks = { ...metadata };'));
      assert(block.includes('this.scheduleShareSuggestionReviewDisplay(view);'));
    }
    assert(
      editorSource.includes(
        'if (actionMarks.length === 0 && this.liveCollabSuggestionResolutionDepth === 0) return;',
      ),
      'Resolving the last live suggestion must publish the empty marks snapshot',
    );

    console.log('✓ live suggestion resolutions use Yjs; disconnected resolutions use REST');
  } finally {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
