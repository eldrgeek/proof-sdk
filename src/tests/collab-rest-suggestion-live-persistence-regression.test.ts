import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.2',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

type CreatedDocument = {
  slug: string;
  ownerSecret: string;
};

type CollabSession = {
  success: boolean;
  session: {
    collabWsUrl: string;
    slug: string;
    token: string;
    role: string;
  };
};

type SuggestionResponse = {
  marks?: Record<string, { kind?: string; status?: string }>;
};

type ConnectedClient = {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  destroy: () => void;
};

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function mustJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(`${label}: HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text) as T;
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

async function connectClient(
  httpBase: string,
  slug: string,
  ownerSecret: string,
): Promise<ConnectedClient> {
  const response = await fetch(`${httpBase}/api/documents/${slug}/collab-session`, {
    headers: { ...CLIENT_HEADERS, 'x-share-token': ownerSecret },
  });
  const payload = await mustJson<CollabSession>(response, 'collab session');
  assert(payload.success, 'Expected collab session success');

  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: normalizeWsBase(payload.session.collabWsUrl),
    name: payload.session.slug,
    document: doc,
    parameters: {
      token: payload.session.token,
      role: payload.session.role,
    },
    token: payload.session.token,
    preserveConnection: false,
    broadcast: false,
  });
  let connected = false;
  let synced = false;
  provider.on('status', (event: { status: string }) => {
    connected = event.status === 'connected';
  });
  provider.on('synced', (event: { state?: boolean }) => {
    if (event.state !== false) synced = true;
  });
  await waitFor(() => connected && synced, 10_000, `client ${slug} connected and synced`);

  return {
    doc,
    provider,
    destroy: () => {
      try {
        provider.disconnect();
        provider.destroy();
        (provider as any)?.configuration?.websocketProvider?.destroy?.();
      } catch {
        // best-effort test cleanup
      }
      doc.destroy();
    },
  };
}

async function postAgent(
  httpBase: string,
  slug: string,
  ownerSecret: string,
  route: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${httpBase}/api/agent/${slug}${route}`, {
    method: 'POST',
    headers: {
      ...CLIENT_HEADERS,
      'Content-Type': 'application/json',
      'x-share-token': ownerSecret,
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify(body),
  });
}

async function replaceFragmentMarkdown(
  ydoc: Y.Doc,
  markdown: string,
  parseMarkdown: (markdown: string) => unknown,
): Promise<void> {
  const parsed = parseMarkdown(markdown);
  ydoc.transact(() => {
    const fragment = ydoc.getXmlFragment('prosemirror');
    if (fragment.length > 0) fragment.delete(0, fragment.length);
    prosemirrorToYXmlFragment(parsed as any, fragment as any);
  }, 'browser-regression-edit');
}

function getPersistedUpdateRows(
  db: typeof import('../../server/db.ts'),
  slug: string,
): Array<{ seq: number; source_actor: string | null }> {
  return db.getDb().prepare(`
    SELECT seq, source_actor
    FROM document_y_updates
    WHERE document_slug = ?
    ORDER BY seq ASC
  `).all(slug) as Array<{ seq: number; source_actor: string | null }>;
}

async function runCase(
  action: 'accept' | 'reject',
  context: {
    httpBase: string;
    db: typeof import('../../server/db.ts');
    collab: typeof import('../../server/collab.ts');
    parseMarkdown: (markdown: string) => unknown;
  },
): Promise<void> {
  const initialMarkdown = `# Live ${action}\n\nKeep this sentence and resolve TARGET.`;
  const createResponse = await fetch(`${context.httpBase}/api/documents`, {
    method: 'POST',
    headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: `REST ${action} live persistence`,
      markdown: initialMarkdown,
      marks: {},
    }),
  });
  const created = await mustJson<CreatedDocument>(createResponse, `create ${action} document`);

  let firstClient: ConnectedClient | null = await connectClient(
    context.httpBase,
    created.slug,
    created.ownerSecret,
  );
  let reconnectedClient: ConnectedClient | null = null;
  try {
    const suggestResponse = await postAgent(
      context.httpBase,
      created.slug,
      created.ownerSecret,
      '/marks/suggest-delete',
      { quote: 'TARGET', by: 'ai:test' },
    );
    const suggested = await mustJson<SuggestionResponse>(suggestResponse, `create ${action} suggestion`);
    const markId = Object.entries(suggested.marks ?? {})
      .find(([, mark]) => mark.kind === 'delete' && mark.status === 'pending')?.[0] ?? '';
    assert(markId.length > 0, `Expected ${action} suggestion id`);
    await waitFor(
      () => firstClient?.doc.getMap('marks').has(markId) === true,
      5_000,
      `${action} suggestion in live marks`,
    );

    const resolutionResponse = await postAgent(
      context.httpBase,
      created.slug,
      created.ownerSecret,
      `/marks/${action}`,
      { markId, by: 'human:test' },
    );
    await mustJson<Record<string, unknown>>(resolutionResponse, `REST ${action}`);
    firstClient.destroy();
    firstClient = null;
    reconnectedClient = await connectClient(context.httpBase, created.slug, created.ownerSecret);
    await sleep(300);
    const updateSeqBeforeEdit = getPersistedUpdateRows(context.db, created.slug).at(-1)?.seq ?? 0;

    const marker = `persisted-after-${action}-${randomUUID().slice(0, 8)}`;
    const resolvedMarkdown = action === 'accept'
      ? initialMarkdown.replace('TARGET', '')
      : initialMarkdown;
    const editedMarkdown = `${resolvedMarkdown}\n\n${marker}`;
    await replaceFragmentMarkdown(reconnectedClient.doc, editedMarkdown, context.parseMarkdown);

    await waitFor(
      async () => (await context.collab.getLoadedCollabMarkdownFromFragment(created.slug))?.includes(marker) === true,
      10_000,
      `live fragment edit after REST ${action}`,
    );
    await waitFor(
      () => getPersistedUpdateRows(context.db, created.slug)
        .some((update) => update.seq > updateSeqBeforeEdit && update.source_actor === 'collab'),
      10_000,
      `new Yjs update after REST ${action}`,
    );
    await waitFor(
      () => context.db.getDocumentBySlug(created.slug)?.markdown.includes(marker) === true,
      10_000,
      `canonical marker after REST ${action}`,
    );

    const stateResponse = await fetch(`${context.httpBase}/api/agent/${created.slug}/state`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const state = await mustJson<{
      markdown?: string;
      content?: string;
      projectionFresh?: boolean;
      repairPending?: boolean;
    }>(stateResponse, `${action} state`);
    const stateMarkdown = state.markdown ?? state.content ?? '';
    assert(state.projectionFresh === true, `Expected fresh projection after REST ${action}`);
    assert(state.repairPending !== true, `Expected no pending repair after REST ${action}`);
    assert(stateMarkdown.includes(marker), `Expected /state edit after REST ${action}`);
  } finally {
    firstClient?.destroy();
    reconnectedClient?.destroy();
  }
}

async function assertDroppedUpdateWarns(
  collab: typeof import('../../server/collab.ts'),
  db: typeof import('../../server/db.ts'),
  warnings: unknown[][],
): Promise<void> {
  const slug = `dropped-write-warning-${randomUUID().slice(0, 8)}`;
  db.createDocument(slug, '# Warning fixture', {}, 'dropped live update warning');
  const staleDoc = new Y.Doc();
  collab.__unsafePrimeLoadedDocForTests(slug, staleDoc);
  await collab.invalidateLoadedCollabDocumentAndWait(slug);
  await collab.__unsafePersistOnStoreDocumentForTests(slug, staleDoc);
  assert(
    warnings.some((args) => {
      const details = args.find((arg) => arg && typeof arg === 'object') as Record<string, unknown> | undefined;
      return details?.slug === slug && details?.reason === 'invalidated_doc_reference';
    }),
    'Expected a dropped live update warning with slug and reason',
  );
  staleDoc.destroy();
}

async function assertReconnectDuringClearingInvalidatePersists(
  context: {
    httpBase: string;
    db: typeof import('../../server/db.ts');
    collab: typeof import('../../server/collab.ts');
    parseMarkdown: (markdown: string) => unknown;
  },
): Promise<void> {
  const createResponse = await fetch(`${context.httpBase}/api/documents`, {
    method: 'POST',
    headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Clearing invalidate reconnect',
      markdown: '# Clearing invalidate\n\nReconnect safely.',
      marks: {},
    }),
  });
  const created = await mustJson<CreatedDocument>(createResponse, 'create clearing invalidate document');
  const firstClient = await connectClient(context.httpBase, created.slug, created.ownerSecret);
  let reconnectedClient: ConnectedClient | null = null;
  try {
    context.db.bumpDocumentAccessEpoch(created.slug);
    const invalidation = context.collab.invalidateCollabDocumentAndWait(created.slug);
    const reconnect = connectClient(context.httpBase, created.slug, created.ownerSecret);
    await invalidation;
    firstClient.destroy();
    reconnectedClient = await reconnect;

    const updateSeqBeforeEdit = getPersistedUpdateRows(context.db, created.slug).at(-1)?.seq ?? 0;
    const marker = `persisted-after-clearing-invalidate-${randomUUID().slice(0, 8)}`;
    await replaceFragmentMarkdown(
      reconnectedClient.doc,
      `# Clearing invalidate\n\nReconnect safely.\n\n${marker}`,
      context.parseMarkdown,
    );
    await waitFor(
      () => getPersistedUpdateRows(context.db, created.slug)
        .some((update) => update.seq > updateSeqBeforeEdit && update.source_actor === 'collab'),
      10_000,
      'Yjs update after reconnect during clearing invalidate',
    );
    await waitFor(
      () => context.db.getDocumentBySlug(created.slug)?.markdown.includes(marker) === true,
      10_000,
      'canonical edit after reconnect during clearing invalidate',
    );
  } finally {
    firstClient.destroy();
    reconnectedClient?.destroy();
  }
}

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `proof-rest-live-suggestion-${Date.now()}-${randomUUID()}.db`);
  const previousDbPath = process.env.DATABASE_PATH;
  const previousEmbeddedWs = process.env.COLLAB_EMBEDDED_WS;
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
    originalWarn(...args);
  };

  const [{ apiRoutes }, { agentRoutes }, { setupWebSocket }, collab, db, milkdown] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
    import('../../server/db.js'),
    import('../../server/milkdown-headless.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);
  app.use('/api/agent', agentRoutes);
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;
  await collab.startCollabRuntimeEmbedded(address.port);
  const parser = await milkdown.getHeadlessMilkdownParser();

  try {
    await runCase('reject', { httpBase, db, collab, parseMarkdown: parser.parseMarkdown });
    await runCase('accept', { httpBase, db, collab, parseMarkdown: parser.parseMarkdown });
    await assertReconnectDuringClearingInvalidatePersists({
      httpBase,
      db,
      collab,
      parseMarkdown: parser.parseMarkdown,
    });
    await assertDroppedUpdateWarns(collab, db, warnings);
    console.log('✓ REST suggestion resolution preserves later live persistence');
  } finally {
    console.warn = originalWarn;
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
        // best-effort test cleanup
      }
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await sleep(50);
    await collab.stopCollabRuntime();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousDbPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDbPath;
    if (previousEmbeddedWs === undefined) delete process.env.COLLAB_EMBEDDED_WS;
    else process.env.COLLAB_EMBEDDED_WS = previousEmbeddedWs;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // best-effort test cleanup
      }
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
