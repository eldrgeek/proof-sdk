import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.34.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

const DEFAULT_TIMEOUT_MS = 10_000;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function run(): Promise<void> {
  const dbName = `proof-collab-no-zombie-suggestions-${Date.now()}-${randomUUID()}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';

  const [{ apiRoutes }, { agentRoutes }, { setupWebSocket }, collab, db] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
    import('../../server/db.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);
  app.use('/api/agent', agentRoutes);

  const server = createServer(app);
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;

  await collab.startCollabRuntimeEmbedded(address.port);

  const ydoc = new Y.Doc();
  let provider: HocuspocusProvider | null = null;
  let connected = false;
  let synced = false;

  try {
    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: '# Suggestion delete\n\nPrep Proof for open source',
        marks: {},
        title: 'Suggestion resurrection regression test',
      }),
    });
    assert(createRes.ok, `Expected doc create ok, got HTTP ${createRes.status}`);
    const created = await createRes.json() as { slug: string; ownerSecret: string };
    assert(typeof created.slug === 'string' && created.slug.length > 0, 'Expected create response slug');
    assert(typeof created.ownerSecret === 'string' && created.ownerSecret.length > 0, 'Expected create response ownerSecret');

    const suggestRes = await fetch(`${httpBase}/api/agent/${created.slug}/ops`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        type: 'suggestion.add',
        by: 'ai:test',
        kind: 'replace',
        quote: 'open source',
        content: 'OSS',
      }),
    });
    assert(suggestRes.ok, `Expected suggestion.add ok, got HTTP ${suggestRes.status}`);

    const sessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    assert(sessionRes.ok, `Expected collab-session ok, got HTTP ${sessionRes.status}`);
    const sessionPayload = await sessionRes.json() as { success: boolean; session: { collabWsUrl: string; token: string; role: string } };
    assert(sessionPayload.success === true, 'Expected collab-session success');

    const wsUrl = (() => {
      const raw = sessionPayload.session.collabWsUrl.replace(/\?slug=.*$/, '');
      try {
        const url = new URL(raw);
        if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
        return url.toString();
      } catch {
        return raw.replace('ws://localhost:', 'ws://127.0.0.1:');
      }
    })();

    provider = new HocuspocusProvider({
      url: wsUrl,
      name: created.slug,
      document: ydoc,
      parameters: { token: sessionPayload.session.token, role: sessionPayload.session.role },
      token: sessionPayload.session.token,
      preserveConnection: false,
      broadcast: false,
    });

    provider.on('status', (event: { status: string }) => {
      if (event.status === 'connected') connected = true;
    });
    provider.on('synced', (event: { state?: boolean }) => {
      const state = event?.state;
      if (state !== false) synced = true;
    });

    await waitFor(() => connected, DEFAULT_TIMEOUT_MS, 'provider connected');
    await waitFor(() => synced, DEFAULT_TIMEOUT_MS, 'provider synced');

    const marksMap = ydoc.getMap('marks');
    await waitFor(() => marksMap.size > 0, DEFAULT_TIMEOUT_MS, 'suggestion mark synced to collab client');
    const suggestionId = Array.from(marksMap.keys())[0] as string;
    assert(typeof suggestionId === 'string' && suggestionId.length > 0, 'Expected suggestion id from marks map');
    const projectionMarksWithoutSuggestion = collab.mergePreservedActionMarks(created.slug, {});
    assert(
      !Object.prototype.hasOwnProperty.call(projectionMarksWithoutSuggestion, suggestionId),
      'Projection materialization must not restore a suggestion omitted from incoming Yjs marks',
    );

    // Simulate accept/reject in UI: remove the suggestion mark from collaborative metadata.
    ydoc.transact(() => {
      marksMap.delete(suggestionId);
    }, 'test-delete-suggestion');

    await waitFor(async () => {
      const stateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
        headers: {
          ...CLIENT_HEADERS,
          'x-share-token': created.ownerSecret,
        },
      });
      if (!stateRes.ok) return false;
      const statePayload = await stateRes.json() as { marks?: Record<string, unknown> };
      const marks = statePayload.marks ?? {};
      return !Object.prototype.hasOwnProperty.call(marks, suggestionId);
    }, DEFAULT_TIMEOUT_MS, 'deleted suggestion removed from persisted server marks');

    const readState = async (): Promise<{
      marks?: Record<string, unknown>;
      readSource?: string;
      projectionFresh?: boolean;
      repairPending?: boolean;
    }> => {
      const stateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
        headers: {
          ...CLIENT_HEADERS,
          'x-share-token': created.ownerSecret,
        },
      });
      assert(stateRes.ok, `Expected state read ok, got HTTP ${stateRes.status}`);
      return stateRes.json();
    };

    const resolvedState = await readState();
    assert(!Object.prototype.hasOwnProperty.call(resolvedState.marks ?? {}, suggestionId), 'Expected no pending resolved suggestion');
    assert(resolvedState.readSource === 'projection', `Expected projection read source, got ${resolvedState.readSource}`);
    assert(resolvedState.projectionFresh === true, 'Expected collab-driven resolution to leave a fresh projection');
    assert(resolvedState.repairPending === false, 'Expected no projection repair after collab-driven resolution');

    const canonicalSync = await collab.syncCanonicalDocumentStateToCollab(created.slug, {
      marks: resolvedState.marks ?? {},
      source: 'test-canonical-sync-after-collab-resolution',
    });
    assert(canonicalSync.applied === true, `Expected canonical sync to apply, got ${JSON.stringify(canonicalSync)}`);
    await waitFor(
      () => !marksMap.has(suggestionId),
      DEFAULT_TIMEOUT_MS,
      'canonical sync keeps resolved suggestion absent from live marks',
    );
    const stateAfterCanonicalSync = await readState();
    assert(
      !Object.prototype.hasOwnProperty.call(stateAfterCanonicalSync.marks ?? {}, suggestionId),
      'Canonical sync must not resurrect a collab-resolved suggestion',
    );
    assert(stateAfterCanonicalSync.projectionFresh === true, 'Expected projection to remain fresh after canonical sync');

    const tombstoneCount = db.getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM mark_tombstones
      WHERE document_slug = ? AND mark_id = ?
    `).get(created.slug, suggestionId) as { count: number };
    assert(tombstoneCount.count === 0, 'Pure collab resolution should not require a server REST tombstone');
    const resolutionEventCount = db.getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM document_events
      WHERE document_slug = ? AND event_type IN ('suggestion.accepted', 'suggestion.rejected')
    `).get(created.slug) as { count: number };
    assert(resolutionEventCount.count === 0, 'Pure collab resolution should not require a REST resolution event');

    console.log('✓ collab projection keeps deleted suggestions final and fresh across canonical sync');
  } finally {
    try {
      provider?.disconnect();
      provider?.destroy();
      try {
        (provider as any)?.configuration?.websocketProvider?.destroy?.();
      } catch {
        // ignore provider internals cleanup errors
      }
    } catch {
      // ignore provider cleanup errors
    }
    ydoc.destroy();
    try {
      wss.close();
    } catch {
      // ignore ws cleanup errors
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await collab.stopCollabRuntime();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
