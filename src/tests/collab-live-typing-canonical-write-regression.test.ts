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
import {
  initProseMirrorDoc,
  prosemirrorToYXmlFragment,
  updateYFragment,
  yXmlFragmentToProseMirrorRootNode,
} from 'y-prosemirror';

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.34.0',
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
    await sleep(20);
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
        // best-effort cleanup
      }
      doc.destroy();
    },
  };
}

async function createFixture(
  httpBase: string,
  title: string,
  markdown: string,
): Promise<CreatedDocument> {
  return mustJson<CreatedDocument>(
    await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, markdown, marks: {} }),
    }),
    `create ${title}`,
  );
}

function clientText(
  client: ConnectedClient,
  schema: import('@milkdown/kit/prose/model').Schema,
): string {
  return yXmlFragmentToProseMirrorRootNode(
    client.doc.getXmlFragment('prosemirror') as any,
    schema as any,
  ).textContent;
}

function replaceClientMarkdown(
  client: ConnectedClient,
  markdown: string,
  parseMarkdown: (markdown: string) => unknown,
): void {
  const parsed = parseMarkdown(markdown);
  client.doc.transact(() => {
    const fragment = client.doc.getXmlFragment('prosemirror');
    const { meta } = initProseMirrorDoc(fragment as any, (parsed as any).type.schema);
    updateYFragment(client.doc, fragment as any, parsed as any, meta as any);
  }, 'browser-live-typing');
}

async function assertReopensWith(
  context: {
    httpBase: string;
    collab: typeof import('../../server/collab.ts');
    schema: import('@milkdown/kit/prose/model').Schema;
  },
  fixture: CreatedDocument,
  marker: string,
): Promise<void> {
  await context.collab.invalidateLoadedCollabDocumentAndWait(fixture.slug);
  const reopened = await connectClient(context.httpBase, fixture.slug, fixture.ownerSecret);
  try {
    assert(clientText(reopened, context.schema).includes(marker), `Reopened document lost ${marker}`);
  } finally {
    reopened.destroy();
  }
}

async function runMutationAwaitCase(
  kind: 'insert' | 'replace',
  context: {
    httpBase: string;
    collab: typeof import('../../server/collab.ts');
    canonical: typeof import('../../server/canonical-document.ts');
    db: typeof import('../../server/db.ts');
    parseMarkdown: (markdown: string) => unknown;
    schema: import('@milkdown/kit/prose/model').Schema;
  },
): Promise<void> {
  const initialMarkdown = `# Await race ${kind}\n\nKeep anchor text.`;
  const fixture = await createFixture(context.httpBase, `await race ${kind}`, initialMarkdown);
  let client: ConnectedClient | null = await connectClient(
    context.httpBase,
    fixture.slug,
    fixture.ownerSecret,
  );
  const marker = `HumanTyping${kind}${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  let hookCalls = 0;

  try {
    context.canonical.__setBeforeCanonicalCommitHookForTests(async (hookContext) => {
      if (hookContext.slug !== fixture.slug) return;
      hookCalls += 1;
      assert(hookContext.liveRequired, `${kind} mutation must use the connected live document`);
      replaceClientMarkdown(client!, `${initialMarkdown}\n\n${marker}`, context.parseMarkdown);
      await waitFor(
        async () => (await context.collab.getLoadedCollabMarkdownFromFragment(fixture.slug))?.includes(marker) === true,
        10_000,
        `${kind} client update to reach the live server doc after base recheck`,
      );
    });

    const route = kind === 'insert' ? '/marks/suggest-insert' : '/marks/suggest-replace';
    const body = kind === 'insert'
      ? { quote: 'anchor', content: ' AI words', by: 'ai:test' }
      : { quote: 'anchor', content: 'changed', by: 'ai:test' };
    const response = await fetch(`${context.httpBase}/api/agent/${fixture.slug}${route}`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': fixture.ownerSecret,
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as { code?: string; error?: string };
    assert(hookCalls === 1, `Expected one final canonical hook for ${kind}, got ${hookCalls}`);
    if (response.status === 409) {
      assert(payload.code === 'STALE_BASE', `Expected retryable STALE_BASE for ${kind}, got ${JSON.stringify(payload)}`);
    } else {
      assert(response.ok, `${kind} mutation failed unexpectedly: HTTP ${response.status}: ${JSON.stringify(payload)}`);
    }

    await waitFor(
      () => clientText(client!, context.schema).includes(marker),
      1_000,
      `${kind} marker to survive in the connected client`,
    );
    const liveDoc = context.collab.__unsafeGetLoadedDocForTests(fixture.slug);
    assert(liveDoc !== null, `Expected loaded live doc for ${kind}`);
    await context.collab.__unsafePersistDocAwaitForTests(fixture.slug, liveDoc, 'collab');
    assert(
      context.db.getDocumentBySlug(fixture.slug)?.markdown.includes(marker) === true,
      `${kind} marker must survive the next persist`,
    );

    client.destroy();
    client = null;
    await assertReopensWith(context, fixture, marker);
  } finally {
    context.canonical.__setBeforeCanonicalCommitHookForTests(null);
    client?.destroy();
  }
}

async function runCanonicalReconcileCase(
  entrypoint: 'persistDoc' | 'onStoreDocument',
  context: {
    httpBase: string;
    collab: typeof import('../../server/collab.ts');
    db: typeof import('../../server/db.ts');
    parseMarkdown: (markdown: string) => unknown;
    schema: import('@milkdown/kit/prose/model').Schema;
  },
): Promise<void> {
  const initialMarkdown = '# Reconcile race\n\nKeep anchor text.';
  const fixture = await createFixture(context.httpBase, 'canonical reconcile race', initialMarkdown);
  const persistedSeed = new Y.Doc();
  persistedSeed.getText('markdown').insert(0, initialMarkdown);
  prosemirrorToYXmlFragment(
    context.parseMarkdown(initialMarkdown) as any,
    persistedSeed.getXmlFragment('prosemirror') as any,
  );
  const seedUpdate = Y.encodeStateAsUpdate(persistedSeed);
  const seedVersion = context.db.appendYUpdate(fixture.slug, seedUpdate, 'test-seed');
  context.db.saveYSnapshot(fixture.slug, seedVersion, seedUpdate);
  persistedSeed.destroy();
  let client: ConnectedClient | null = await connectClient(
    context.httpBase,
    fixture.slug,
    fixture.ownerSecret,
  );
  const marker = `HumanTypingReconcile${entrypoint}${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const markId = `ai-authored-${randomUUID()}`;
  const nextMarks = {
    [markId]: {
      kind: 'authored',
      by: 'ai:test',
      createdAt: new Date().toISOString(),
      quote: 'anchor',
      range: { from: 24, to: 30 },
      startRel: 'char:22',
      endRel: 'char:28',
    },
  };
  let releaseSync!: () => void;
  const syncRelease = new Promise<void>((resolve) => {
    releaseSync = resolve;
  });
  let syncPaused = false;
  let reconcileReached = false;

  try {
    context.collab.__unsafeSetCanonicalSyncPreviewPauseHookForTests(async (hookContext) => {
      if (
        hookContext.slug !== fixture.slug
        || hookContext.source !== 'rest-put'
        || hookContext.hasMarkdown
        || !hookContext.hasMarks
      ) return;
      syncPaused = true;
      await syncRelease;
    });
    context.collab.__unsafeSetCanonicalReconcileHookForTests((hookContext) => {
      if (hookContext.slug === fixture.slug && hookContext.source === entrypoint) {
        reconcileReached = true;
      }
    });

    const putPromise = fetch(`${context.httpBase}/api/documents/${fixture.slug}`, {
      method: 'PUT',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': fixture.ownerSecret,
      },
      body: JSON.stringify({ marks: nextMarks }),
    });
    await waitFor(() => syncPaused, 10_000, 'marks-only REST mutation to update the row and pause before live apply');
    assert(
      Object.prototype.hasOwnProperty.call(
        JSON.parse(context.db.getDocumentBySlug(fixture.slug)?.marks ?? '{}'),
        markId,
      ),
      'AI marks-only REST mutation must update the row before reconciliation',
    );

    replaceClientMarkdown(client, `${initialMarkdown}\n\n${marker}`, context.parseMarkdown);
    await waitFor(
      async () => (await context.collab.getLoadedCollabMarkdownFromFragment(fixture.slug))?.includes(marker) === true,
      10_000,
      'client typing to reach live fragment before canonical reconcile',
    );
    const liveDoc = context.collab.__unsafeGetLoadedDocForTests(fixture.slug);
    assert(liveDoc !== null, 'Expected loaded live doc for canonical reconcile');
    const reconcilePromise = entrypoint === 'persistDoc'
      ? context.collab.__unsafePersistDocAwaitForTests(fixture.slug, liveDoc, 'collab')
      : context.collab.__unsafePersistOnStoreDocumentForTests(fixture.slug, liveDoc);
    await waitFor(
      () => reconcileReached,
      10_000,
      `${entrypoint} to choose canonical reconcile`,
    );

    releaseSync();
    const putResponse = await putPromise;
    await mustJson<Record<string, unknown>>(putResponse, 'marks-only AI REST mutation');
    await reconcilePromise;

    try {
      await waitFor(
        () => clientText(client!, context.schema).includes(marker),
        1_000,
        `${entrypoint} canonical reconcile marker to survive in connected client`,
      );
    } catch (error) {
      const serverFragment = await context.collab.getLoadedCollabMarkdownFromFragment(fixture.slug);
      const serverYText = context.collab.__unsafeGetLoadedDocForTests(fixture.slug)?.getText('markdown').toString();
      throw new Error(
        `${(error as Error).message}; client=${JSON.stringify(clientText(client, context.schema))}`
        + ` fragment=${JSON.stringify(serverFragment)} ytext=${JSON.stringify(serverYText)}`
        + ` row=${JSON.stringify(context.db.getDocumentBySlug(fixture.slug)?.markdown)}`,
      );
    }
    const reconciledLiveDoc = context.collab.__unsafeGetLoadedDocForTests(fixture.slug);
    assert(reconciledLiveDoc !== null, 'Expected reconciled live doc before the next persist');
    await context.collab.__unsafePersistDocAwaitForTests(fixture.slug, reconciledLiveDoc, 'collab');
    await waitFor(
      () => context.db.getDocumentBySlug(fixture.slug)?.markdown.includes(marker) === true,
      10_000,
      `${entrypoint} canonical reconcile marker to survive the next persist`,
    );
    client.destroy();
    client = null;
    await assertReopensWith(context, fixture, marker);
  } finally {
    releaseSync();
    context.collab.__unsafeSetCanonicalSyncPreviewPauseHookForTests(null);
    context.collab.__unsafeSetCanonicalReconcileHookForTests(null);
    client?.destroy();
  }
}

async function run(): Promise<void> {
  const dbPath = path.join(os.tmpdir(), `proof-live-typing-canonical-${Date.now()}-${randomUUID()}.db`);
  const previousDbPath = process.env.DATABASE_PATH;
  const previousEmbeddedWs = process.env.COLLAB_EMBEDDED_WS;
  const previousPersistDebounce = process.env.COLLAB_PERSIST_DEBOUNCE_MS;
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';
  process.env.COLLAB_PERSIST_DEBOUNCE_MS = '60000';

  const [{ apiRoutes }, { agentRoutes }, { setupWebSocket }, collab, canonical, db, milkdown] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
    import('../../server/canonical-document.js'),
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
  const context = {
    httpBase,
    collab,
    canonical,
    db,
    parseMarkdown: parser.parseMarkdown,
    schema: parser.schema,
  };

  try {
    const failures: string[] = [];
    for (const [label, testCase] of [
      ['insert mutation await', () => runMutationAwaitCase('insert', context)],
      ['replace mutation await', () => runMutationAwaitCase('replace', context)],
      ['persistDoc canonical reconcile', () => runCanonicalReconcileCase('persistDoc', context)],
      ['onStoreDocument canonical reconcile', () => runCanonicalReconcileCase('onStoreDocument', context)],
    ] as const) {
      try {
        await testCase();
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    assert(failures.length === 0, failures.join('\n'));
    console.log('✓ canonical writes preserve typing from a connected live client');
  } finally {
    canonical.__setBeforeCanonicalCommitHookForTests(null);
    collab.__unsafeSetCanonicalSyncPreviewPauseHookForTests(null);
    collab.__unsafeSetCanonicalReconcileHookForTests(null);
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await collab.stopCollabRuntime();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousDbPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDbPath;
    if (previousEmbeddedWs === undefined) delete process.env.COLLAB_EMBEDDED_WS;
    else process.env.COLLAB_EMBEDDED_WS = previousEmbeddedWs;
    if (previousPersistDebounce === undefined) delete process.env.COLLAB_PERSIST_DEBOUNCE_MS;
    else process.env.COLLAB_PERSIST_DEBOUNCE_MS = previousPersistDebounce;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
