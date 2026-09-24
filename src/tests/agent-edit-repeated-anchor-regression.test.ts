import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor < haystack.length) {
    const idx = haystack.indexOf(needle, cursor);
    if (idx < 0) return count;
    count += 1;
    cursor = idx + needle.length;
  }
  return count;
}

async function waitFor(fn: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
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

type CreateResponse = { slug: string; ownerSecret: string };
type StateResponse = { updatedAt: string; markdown?: string; content?: string };
type EditResponse = { success?: boolean; code?: string; recommendedEndpoint?: string };
type SnapshotResponse = {
  revision: number;
  blocks?: Array<{ ref?: string; markdown?: string }>;
};
type CollabSessionResponse = {
  success: boolean;
  session: {
    slug: string;
    collabWsUrl: string;
    token: string;
    role: 'viewer' | 'commenter' | 'editor' | 'owner_bot';
  };
};

async function mustJson<T>(res: Response, label: string): Promise<T> {
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.32.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

const ANCHOR = "Process Lucas's stakeholder synthesis dashboard";

const FIXTURE = [
  '# Daily Plan',
  '',
  '## Thursday, Feb 26, 2026',
  '',
  '**📅 Planning**',
  '',
  '* [ ] Figure out calendar and scheduling for Proof / Sheriff / Claw launches',
  '',
  `* [ ] ${ANCHOR}`,
  '',
  '## Wednesday, Feb 25, 2026',
  '',
  '**📅 Planning**',
  '',
  '* [ ] Figure out calendar and scheduling for Proof / Sheriff / Claw launches',
  '',
  `* [ ] ${ANCHOR}`,
  '',
].join('\n');

async function run(): Promise<void> {
  const dbName = `proof-agent-edit-repeated-anchor-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';

  const [{ apiRoutes }, { agentRoutes }, ws, collab] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);
  app.use('/api/agent', agentRoutes);

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  ws.setupWebSocket(wss);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;

  await collab.startCollabRuntimeEmbedded(address.port);

  let provider: HocuspocusProvider | null = null;
  const ydoc = new Y.Doc();

  try {
    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Agent repeated anchor regression',
        markdown: FIXTURE,
        marks: {},
      }),
    });
    const created = await mustJson<CreateResponse>(createRes, 'create');

    const collabSessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const collabSession = await mustJson<CollabSessionResponse>(collabSessionRes, 'collab-session');
    assert(collabSession.success === true, 'Expected successful collab session');

    provider = new HocuspocusProvider({
      url: normalizeWsBase(collabSession.session.collabWsUrl),
      name: collabSession.session.slug,
      document: ydoc,
      parameters: {
        token: collabSession.session.token,
        role: collabSession.session.role,
      },
      token: collabSession.session.token,
      preserveConnection: false,
      broadcast: false,
    });

    let connected = provider.isConnected;
    let synced = provider.synced;
    provider.on('status', (event: { status: string }) => {
      if (event.status === 'connected') connected = true;
    });
    provider.on('synced', (event: { state?: boolean }) => {
      if (event.state !== false) synced = true;
    });
    await waitFor(() => connected && synced, 10_000, 'collab provider connect/sync');

    const stateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const state = await mustJson<StateResponse>(stateRes, 'state-before');

    const marker = `REPROMARKER${Date.now()}`;
    const editRes = await fetch(`${httpBase}/api/agent/${created.slug}/edit`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'ai:test',
        baseUpdatedAt: state.updatedAt,
        operations: [
          { op: 'insert', after: ANCHOR, content: `\n\n* [ ] ${marker}` },
        ],
      }),
    });
    assert(editRes.status === 409, `Expected legacy /edit to be blocked, got ${editRes.status}`);
    const edit = await editRes.json() as EditResponse;
    assert(edit.code === 'LEGACY_EDIT_UNSAFE', `Expected LEGACY_EDIT_UNSAFE, got ${String(edit.code)}`);
    assert(
      edit.recommendedEndpoint === `/api/agent/${created.slug}/edit/v2`,
      `Expected /edit/v2 guidance, got ${String(edit.recommendedEndpoint)}`,
    );

    provider.disconnect();
    provider.destroy();
    provider = null;
    ydoc.destroy();

    const snapshotRes = await fetch(`${httpBase}/api/agent/${created.slug}/snapshot`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const snapshot = await mustJson<SnapshotResponse>(snapshotRes, 'snapshot');
    const anchorRefs = (snapshot.blocks ?? [])
      .filter((block) => typeof block.markdown === 'string' && block.markdown.includes(ANCHOR))
      .map((block) => block.ref)
      .filter((ref): ref is string => typeof ref === 'string' && ref.length > 0);
    assert(anchorRefs.length >= 2, `Expected two repeated anchor refs, got ${anchorRefs.length}`);

    const editV2Res = await fetch(`${httpBase}/api/agent/${created.slug}/edit/v2`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'ai:test',
        baseRevision: snapshot.revision,
        operations: [
          { op: 'insert_after', ref: anchorRefs[0], blocks: [{ markdown: `* [ ] ${marker}` }] },
        ],
      }),
    });
    const editV2 = await mustJson<{ success: boolean; collab?: { status?: string } }>(editV2Res, 'edit/v2');
    assert(editV2.success === true, 'Expected /edit/v2 success');
    assert(editV2.collab?.status === 'confirmed', `Expected confirmed collab status, got ${String(editV2.collab?.status)}`);

    const stateAfterRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: {
        ...CLIENT_HEADERS,
        'x-share-token': created.ownerSecret,
      },
    });
    const stateAfter = await mustJson<StateResponse>(stateAfterRes, 'state-after');
    const markdown = typeof stateAfter.markdown === 'string' ? stateAfter.markdown : (stateAfter.content || '');

    assert(countOccurrences(markdown, marker) === 1, 'Expected marker exactly once in canonical markdown');
    const firstAnchor = markdown.indexOf(ANCHOR);
    const secondAnchor = markdown.indexOf(ANCHOR, firstAnchor + 1);
    const markerIndex = markdown.indexOf(marker);
    assert(firstAnchor >= 0 && secondAnchor > firstAnchor, 'Expected repeated anchor occurrences in canonical markdown');
    assert(markerIndex > firstAnchor, 'Expected marker after first anchor');
    assert(markerIndex < secondAnchor, 'Expected marker before second anchor');

    const sectionThursdayStart = markdown.indexOf('## Thursday, Feb 26, 2026');
    const sectionWednesdayStart = markdown.indexOf('## Wednesday, Feb 25, 2026');
    assert(sectionThursdayStart >= 0 && sectionWednesdayStart > sectionThursdayStart, 'Expected Thursday and Wednesday sections');
    assert(markerIndex > sectionThursdayStart && markerIndex < sectionWednesdayStart, 'Expected marker inserted in Thursday section');

    console.log('✓ repeated anchor edits use /edit/v2 block refs and remain deterministic');
  } finally {
    try {
      provider?.disconnect();
      provider?.destroy();
    } catch {
      // ignore
    }
    ydoc.destroy();
    try {
      wss.close();
    } catch {
      // ignore
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

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
