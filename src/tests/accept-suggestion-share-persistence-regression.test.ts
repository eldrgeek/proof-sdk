import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sliceBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `Missing block start: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `Missing block end after: ${startNeedle}`);
  return source.slice(start, end);
}

async function run(): Promise<void> {
  const editorSource = readFileSync(path.resolve(process.cwd(), 'src/editor/index.ts'), 'utf8');
  const markAcceptBlock = sliceBetween(
    editorSource,
    '  markAccept(markId: string): boolean {',
    '\n  /**\n   * Reject a suggestion without changing the document',
  );
  const markAcceptShareBlock = sliceBetween(
    markAcceptBlock,
    '    if (this.isShareMode) {',
    '\n    let success = false;',
  );
  assert(
    markAcceptShareBlock.indexOf('accepted = acceptMark(view, markId, parser);')
      < markAcceptShareBlock.indexOf('shareClient.acceptSuggestion(markId, actor)'),
    'Share accept must apply the suggestion to the local editor before persisting it',
  );
  assert(
    markAcceptShareBlock.includes('this.dropSuggestionIdsFromServerMarkCache([markId])')
      && markAcceptShareBlock.indexOf('this.dropSuggestionIdsFromServerMarkCache([markId])')
        < markAcceptShareBlock.indexOf('accepted = acceptMark(view, markId, parser);'),
    'Share accept must drop stale cached server metadata before the local dispatch',
  );
  assert.match(markAcceptShareBlock, /this\.suppressMarksSync = true;[\s\S]*accepted = acceptMark\(view, markId, parser\);[\s\S]*this\.suppressMarksSync = false;/);
  assert(markAcceptShareBlock.includes('this.applyAuthoritativeShareMarks(serverMarks);'));
  assert(markAcceptShareBlock.includes('this.recoverAuthoritativeShareMarks('));
  assert(
    editorSource.includes("collabConnected: this.collabEnabled && this.collabConnectionStatus === 'connected'"),
    'Failed optimistic accepts must preserve Yjs-authoritative text while live collaboration is connected',
  );

  const markAcceptAllBlock = sliceBetween(
    editorSource,
    '  markAcceptAll(): number {',
    '\n  /**\n   * Reject all pending suggestions',
  );
  const markAcceptAllShareBlock = sliceBetween(
    markAcceptAllBlock,
    '    if (this.isShareMode) {',
    '\n    let count = 0;',
  );
  assert(
    markAcceptAllShareBlock.indexOf('if (acceptMark(view, id, parser))')
      < markAcceptAllShareBlock.indexOf("this.reconcileShareSuggestionBatch(acceptedIds, 'accepted', actor)"),
    'Share accept-all must apply mutually pending suggestions locally before persisting their ids',
  );
  assert(markAcceptAllShareBlock.includes('this.isSuggestionPendingOnServer(id)'));
  assert(markAcceptAllShareBlock.includes('!this.shareRejectedSuggestionIdsBlockedFromAcceptAll.has(id)'));
  assert(
    markAcceptAllShareBlock.includes('this.dropSuggestionIdsFromServerMarkCache(pendingIds)')
      && markAcceptAllShareBlock.indexOf('this.dropSuggestionIdsFromServerMarkCache(pendingIds)')
        < markAcceptAllShareBlock.indexOf('if (acceptMark(view, id, parser))'),
    'Share accept-all must drop cached server metadata before local dispatches',
  );
  assert(markAcceptAllShareBlock.includes("this.reconcileShareSuggestionBatch(acceptedIds, 'accepted', actor)"));
  assert(markAcceptAllShareBlock.includes('this.recoverAuthoritativeShareMarks('));

  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as { window?: unknown }).window;
  const requests: string[] = [];

  (globalThis as { window: Record<string, unknown> }).window = {
    location: new URL('https://example.com/d/local-first?token=share-token'),
    __PROOF_CONFIG__: {
      proofClientVersion: '0.31.2',
      proofClientBuild: 'test',
      proofClientProtocol: '3',
    },
  };

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    requests.push(url.pathname);
    if (url.pathname === '/api/agent/local-first/state') {
      return jsonResponse({ revision: 7, updatedAt: '2026-09-14T18:00:00.000Z' });
    }
    if (url.pathname === '/api/agent/local-first/marks/accept') {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { markId?: string }
        : {};
      if (body.markId === 'already-local') {
        return jsonResponse({
          success: false,
          code: 'MARK_NOT_HYDRATED',
          error: 'Target Proof mark could not be rehydrated from stored anchors',
        }, 409);
      }
      return jsonResponse({
        success: false,
        code: 'COLLAB_SYNC_FAILED',
        error: 'Suggestion acceptance did not converge to live collaboration state',
        retryWithState: '/api/agent/local-first/state',
      }, 409);
    }
    if (url.pathname === '/api/documents/local-first/open-context') {
      return jsonResponse({
        success: true,
        collabAvailable: true,
        doc: {
          slug: 'local-first',
          title: 'Local first',
          markdown: 'Accepted text',
          marks: {},
        },
        capabilities: { canRead: true, canComment: true, canEdit: true },
        links: { webUrl: 'https://example.com/d/local-first', snapshotUrl: null },
      });
    }
    throw new Error(`Unexpected request path: ${url.pathname}`);
  };

  try {
    const { shareClient } = await import('../bridge/share-client.js');
    const result = await shareClient.acceptSuggestion('accepted-mark', 'human:editor');
    assert(result && !('error' in result) && result.success === true, 'Resolved server state should recover the 409 as success');
    assert.deepEqual(result.marks, {}, 'Recovered success should return authoritative resolved marks');
    assert.equal(
      requests.filter((requestPath) => requestPath === '/api/agent/local-first/marks/accept').length,
      1,
      'A resolved mark should not be submitted a second time after the 409',
    );
    assert(requests.includes('/api/documents/local-first/open-context'), 'Recovery should fetch authoritative document state');

    const hydrationResult = await shareClient.acceptSuggestion('already-local', 'human:editor');
    assert(
      hydrationResult && !('error' in hydrationResult) && hydrationResult.success === true,
      'A local accept that leaves no server mark should recover MARK_NOT_HYDRATED as success',
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  }

  console.log('accept-suggestion-share-persistence-regression.test.ts passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
