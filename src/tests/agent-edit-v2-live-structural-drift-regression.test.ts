import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocketServer } from 'ws';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import { getHeadlessMilkdownParser } from '../../server/milkdown-headless.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function normalizeWsBase(collabWsUrl: string): string {
  const raw = collabWsUrl.replace(/\?slug=.*$/, '');
  try {
    const url = new URL(raw);
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    return url.toString();
  } catch {
    return raw.replace('ws://localhost:', 'ws://127.0.0.1:');
  }
}

async function mustJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.34.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

async function run(): Promise<void> {
  const dbName = `proof-agent-edit-v2-live-structural-drift-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';
  process.env.AGENT_EDIT_V2_ENABLED = '1';
  process.env.COLLAB_PERSIST_DEBOUNCE_MS = '5000';

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
    const parser = await getHeadlessMilkdownParser();
    const initialMarkdown = [
      '# Live ref drift',
      '',
      'First paragraph.',
      '',
      'Second paragraph.',
      '',
      'Third paragraph.',
    ].join('\n');
    const liveInserted = 'Inserted by human before the snapped target.';
    const agentReplacement = 'Agent replacement that should never apply.';

    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'agent edit v2 live structural drift regression',
        markdown: initialMarkdown,
        marks: {},
      }),
    });
    const created = await mustJson<{ slug: string; ownerSecret: string }>(createRes, 'create');

    const snapshotRes = await fetch(`${httpBase}/api/agent/${created.slug}/snapshot`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const snapshot = await mustJson<{
      revision: number;
      blocks?: Array<{ ref?: string; markdown?: string }>;
    }>(snapshotRes, 'snapshot');
    const snappedTargetRef = snapshot.blocks?.find((block) => block.markdown?.includes('Second paragraph.'))?.ref;
    assert(typeof snappedTargetRef === 'string' && snappedTargetRef.length > 0, 'Expected snapshot ref for second paragraph');

    const sessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const session = await mustJson<{
      success: boolean;
      session: { collabWsUrl: string; slug: string; token: string; role: string };
    }>(sessionRes, 'collab-session');
    assert(session.success, 'Expected successful collab session');

    provider = new HocuspocusProvider({
      url: normalizeWsBase(session.session.collabWsUrl),
      name: session.session.slug,
      document: ydoc,
      parameters: {
        token: session.session.token,
        role: session.session.role,
      },
      token: session.session.token,
      preserveConnection: false,
      broadcast: false,
    });
    provider.on('status', (event: { status: string }) => {
      if (event.status === 'connected') connected = true;
    });
    provider.on('synced', (event: { state?: boolean }) => {
      if (event.state !== false) synced = true;
    });
    await waitFor(() => connected, 10_000, 'provider connected');
    await waitFor(() => synced, 10_000, 'provider synced');

    const liveMarkdown = [
      '# Live ref drift',
      '',
      'First paragraph.',
      '',
      liveInserted,
      '',
      'Second paragraph.',
      '',
      'Third paragraph.',
    ].join('\n');
    ydoc.transact(() => {
      const markdownText = ydoc.getText('markdown');
      if (markdownText.length > 0) markdownText.delete(0, markdownText.length);
      markdownText.insert(0, liveMarkdown);

      const fragment = ydoc.getXmlFragment('prosemirror');
      if (fragment.length > 0) fragment.delete(0, fragment.length);
      prosemirrorToYXmlFragment(parser.parseMarkdown(liveMarkdown) as never, fragment as never);
    }, 'human-live-structural-drift');

    await waitFor(
      async () => {
        const liveFragmentMarkdown = await collab.getLoadedCollabMarkdownFromFragment(created.slug);
        return liveFragmentMarkdown?.includes(liveInserted) === true
          && db.getDocumentBySlug(created.slug)?.revision === snapshot.revision;
      },
      5_000,
      'live fragment drift before persisted revision bump',
    );
    const persistedBefore = db.getDocumentBySlug(created.slug);
    assert(persistedBefore?.revision === snapshot.revision, 'Expected persisted revision to remain at the snapped revision');

    const editRes = await fetch(`${httpBase}/api/agent/${created.slug}/edit/v2`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'ai:regression-test',
        baseRevision: snapshot.revision,
        operations: [
          { op: 'replace_block', ref: snappedTargetRef, block: { markdown: agentReplacement } },
        ],
      }),
    });
    const edit = await editRes.json() as {
      success?: boolean;
      code?: string;
      error?: string;
      opIndex?: number;
    };
    assert(editRes.status === 409, `Expected 409 on live structural drift, got ${editRes.status}: ${JSON.stringify(edit)}`);
    assert(edit.code === 'FRAGMENT_DIVERGENCE', `Expected FRAGMENT_DIVERGENCE, got ${String(edit.code)}`);
    assert(edit.opIndex === 0, `Expected opIndex 0, got ${String(edit.opIndex)}`);
    assert(
      typeof edit.error === 'string' && edit.error.includes(snappedTargetRef),
      `Expected error to mention drifted ref ${snappedTargetRef}, got ${String(edit.error)}`,
    );

    const liveAfter = await collab.getLoadedCollabMarkdownFromFragment(created.slug);
    assert(liveAfter?.includes(liveInserted) === true, 'Expected human inserted block to remain in the live fragment');
    assert(liveAfter?.includes(agentReplacement) !== true, 'Expected rejected agent replacement to stay out of the live fragment');
    assert(db.getDocumentBySlug(created.slug)?.revision === snapshot.revision, 'Expected persisted revision to remain unchanged after rejection');

    console.log('✓ agent /edit/v2 rejects ref writes when live block topology drifts under the same revision');
  } finally {
    try {
      provider?.disconnect();
      provider?.destroy();
      try {
        (provider as any)?.configuration?.websocketProvider?.destroy?.();
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
    ydoc.destroy();
    await collab.stopCollabRuntime();
    try {
      wss.close();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
