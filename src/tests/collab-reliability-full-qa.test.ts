import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { AddressInfo } from 'node:net';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import { getHeadlessMilkdownParser } from '../../server/milkdown-headless.js';
import { replaceLiveMarkdown } from '../shared/live-markdown.ts';

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.33.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

const DEFAULT_TIMEOUT_MS = 12_000;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return;
    await sleep(15);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function waitForAsync(fn: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function mustJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  return JSON.parse(text) as T;
}

type ShareCreateResponse = {
  slug: string;
  ownerSecret: string;
};

type CollabSessionPayload = {
  success: boolean;
  session?: {
    slug: string;
    collabWsUrl: string;
    token: string;
    role: 'viewer' | 'commenter' | 'editor' | 'owner_bot';
  };
  collabAvailable?: boolean;
};

type AgentStateResponse = {
  success: boolean;
  updatedAt: string;
  revision?: number;
};

type AgentSnapshotResponse = {
  success: boolean;
  revision: number;
  blocks?: Array<{ ref?: string; markdown?: string }>;
};

function normalizeWsUrl(raw: string): string {
  const cleaned = raw.replace(/\?slug=.*$/, '');
  try {
    const url = new URL(cleaned);
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    return url.toString();
  } catch {
    return cleaned.replace('ws://localhost:', 'ws://127.0.0.1:');
  }
}

async function connectCollab(
  httpBase: string,
  slug: string,
  ownerSecret: string,
): Promise<{ provider: HocuspocusProvider; ydoc: Y.Doc; session: CollabSessionPayload['session'] }> {
  const sessionRes = await fetch(`${httpBase}/api/documents/${slug}/collab-session`, {
    headers: {
      ...CLIENT_HEADERS,
      'x-share-token': ownerSecret,
    },
  });
  const sessionPayload = await mustJson<CollabSessionPayload>(sessionRes);
  assert(sessionPayload.success === true, 'Expected collab-session success');
  assert(sessionPayload.session, 'Expected collab session payload');

  const wsUrl = normalizeWsUrl(sessionPayload.session.collabWsUrl);
  const ydoc = new Y.Doc();
  let connected = false;
  let synced = false;

  const provider = new HocuspocusProvider({
    url: wsUrl,
    name: slug,
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

  await waitFor(() => connected, DEFAULT_TIMEOUT_MS, 'collab provider connected');
  await waitFor(() => synced, DEFAULT_TIMEOUT_MS, 'collab provider synced');

  return { provider, ydoc, session: sessionPayload.session };
}

function safeDisconnect(provider: HocuspocusProvider | null): void {
  if (!provider) return;
  try {
    provider.disconnect();
    provider.destroy();
  } catch {
    // ignore
  }
  try {
    (provider as any)?.configuration?.websocketProvider?.destroy?.();
  } catch {
    // ignore
  }
}

function stripAuthoredSpanTags(markdown: string): string {
  const spanTagRegex = /<\/?span\b[^>]*>/gi;
  const authoredAttrRegex = /data-proof\s*=\s*(?:"authored"|'authored'|authored)/i;
  const authoredStack: boolean[] = [];
  let result = '';
  let lastIndex = 0;

  for (const match of markdown.matchAll(spanTagRegex)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const tag = match[0];

    result += markdown.slice(lastIndex, index);
    lastIndex = index + tag.length;

    const isClosing = tag.startsWith('</');
    if (isClosing) {
      if (authoredStack.length === 0) {
        result += tag;
        continue;
      }
      const authored = authoredStack.pop();
      if (!authored) {
        result += tag;
      }
      continue;
    }

    const isAuthored = authoredAttrRegex.test(tag);
    authoredStack.push(isAuthored);
    if (!isAuthored) {
      result += tag;
    }
  }

  result += markdown.slice(lastIndex);
  return result;
}

async function fetchAgentSnapshot(
  httpBase: string,
  slug: string,
  ownerSecret: string,
): Promise<AgentSnapshotResponse> {
  const response = await fetch(`${httpBase}/api/agent/${slug}/snapshot`, {
    headers: { ...CLIENT_HEADERS, 'x-share-token': ownerSecret },
  });
  return mustJson<AgentSnapshotResponse>(response);
}

function getLastBlockRef(snapshot: AgentSnapshotResponse): string {
  const ref = snapshot.blocks?.at(-1)?.ref;
  assert(typeof ref === 'string' && ref.length > 0, 'Expected snapshot last block ref');
  return ref;
}

async function run(): Promise<void> {
  const dbName = `proof-collab-full-qa-${Date.now()}-${randomUUID()}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);

  const prevDatabasePath = process.env.DATABASE_PATH;
  const prevProofEnv = process.env.PROOF_ENV;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDbEnvInit = process.env.PROOF_DB_ENV_INIT;
  const prevCollabFlag = process.env.PROOF_COLLAB_V2;
  const prevStartupReconcileEnabled = process.env.COLLAB_STARTUP_RECONCILE_ENABLED;
  const prevStartupReconcileDelayMs = process.env.COLLAB_STARTUP_RECONCILE_DELAY_MS;

  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_ENV = 'development';
  process.env.NODE_ENV = 'development';
  process.env.COLLAB_EMBEDDED_WS = '1';
  process.env.COLLAB_STARTUP_RECONCILE_ENABLED = '1';
  process.env.COLLAB_STARTUP_RECONCILE_DELAY_MS = '10';
  delete process.env.PROOF_DB_ENV_INIT;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');

  // Seed a stale projection before collab runtime boots.
  const staleSlug = `startup-stale-${Math.random().toString(36).slice(2, 8)}`;
  const staleMarkdown = '# Stale Projection\n\nOld content.';
  const updatedMarkdown = '# Stale Projection\n\nUpdated content from Yjs.';
  db.createDocument(staleSlug, staleMarkdown, {}, 'Startup reconcile');
  const parser = await getHeadlessMilkdownParser();
  const ydocSeed = new Y.Doc();
  ydocSeed.getText('markdown').insert(0, updatedMarkdown);
  prosemirrorToYXmlFragment(parser.parseMarkdown(updatedMarkdown) as any, ydocSeed.getXmlFragment('prosemirror') as any);
  const seedUpdate = Y.encodeStateAsUpdate(ydocSeed);
  const seedSeq = db.appendYUpdate(staleSlug, seedUpdate, 'seed');
  db.saveYSnapshot(staleSlug, seedSeq, seedUpdate);
  ydocSeed.destroy();

  const [{ apiRoutes }, { agentRoutes }, { setupWebSocket, getActiveCollabClientCount }] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/ws.js'),
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

  const providers: Array<{ provider: HocuspocusProvider; ydoc: Y.Doc }> = [];

  try {
    // Startup reconciliation should advance stale projections.
    await waitFor(
      () => db.getDocumentBySlug(staleSlug)?.markdown.includes('Updated content from Yjs.') === true,
      DEFAULT_TIMEOUT_MS,
      'startup stale projection reconcile',
    );
    const staleDoc = db.getDocumentBySlug(staleSlug);
    assert(staleDoc?.markdown.includes('Updated content from Yjs.'), 'Expected startup reconciliation to update markdown');
    assert((staleDoc?.y_state_version ?? 0) > 0, 'Expected y_state_version to advance on startup reconciliation');

    // DB pragmas.
    const dbHandle = db.getDb();
    const journal = dbHandle.pragma('journal_mode', { simple: true }) as string | undefined;
    const synchronous = dbHandle.pragma('synchronous', { simple: true }) as number | undefined;
    const busyTimeout = dbHandle.pragma('busy_timeout', { simple: true }) as number | undefined;
    assert(String(journal).toLowerCase() === 'wal', `Expected journal_mode=WAL, got ${String(journal)}`);
    assert(typeof synchronous === 'number' && synchronous >= 1, `Expected synchronous pragma, got ${String(synchronous)}`);
    assert(typeof busyTimeout === 'number' && busyTimeout >= 0, `Expected busy_timeout pragma, got ${String(busyTimeout)}`);

    // CRUD operations (create/read/update/delete).
    const crudRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: '# CRUD Doc\n\nSeed.',
        marks: {},
        title: 'CRUD test',
      }),
    });
    const crudDoc = await mustJson<ShareCreateResponse>(crudRes);

    const crudGet = await fetch(`${httpBase}/api/documents/${crudDoc.slug}`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': crudDoc.ownerSecret },
    });
    const crudPayload = await mustJson<{ markdown: string }>(crudGet);
    assert(crudPayload.markdown.includes('CRUD Doc'), 'Expected CRUD doc to be readable');

    const crudPut = await fetch(`${httpBase}/api/documents/${crudDoc.slug}`, {
      method: 'PUT',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: '# CRUD Doc\n\nUpdated.',
        ownerSecret: crudDoc.ownerSecret,
      }),
    });
    assert(crudPut.ok, `Expected CRUD PUT ok, got ${crudPut.status}`);

    const crudDelete = await fetch(`${httpBase}/api/documents/${crudDoc.slug}/delete`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerSecret: crudDoc.ownerSecret }),
    });
    assert(crudDelete.ok, `Expected CRUD delete ok, got ${crudDelete.status}`);

    // Collab doc for integration tests.
    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        markdown: '# Collab Doc\n\nAlpha paragraph.\n\nBeta paragraph.',
        marks: {},
        title: 'Collab QA',
      }),
    });
    const created = await mustJson<ShareCreateResponse>(createRes);
    const createdRow = db.getDocumentBySlug(created.slug);
    const createdProjection = db.getProjectedDocumentBySlug(created.slug);
    assert(Boolean(createdRow), 'Expected created collab document row');
    assert((createdRow?.y_state_version ?? 0) > 0, `Expected create route to seed canonical Yjs baseline, got ${String(createdRow?.y_state_version ?? 0)}`);
    assert(db.getLatestYSnapshot(created.slug) != null, 'Expected create route to persist Yjs snapshot');
    assert(
      (createdProjection?.projection_y_state_version ?? 0) === (createdRow?.y_state_version ?? 0),
      `Expected projection y_state_version to match canonical row after create, got ${String(createdProjection?.projection_y_state_version ?? 0)} vs ${String(createdRow?.y_state_version ?? 0)}`,
    );

    // Connect two live clients (concurrent editing).
    const collabA = await connectCollab(httpBase, created.slug, created.ownerSecret);
    const collabB = await connectCollab(httpBase, created.slug, created.ownerSecret);
    providers.push({ provider: collabA.provider, ydoc: collabA.ydoc });
    providers.push({ provider: collabB.provider, ydoc: collabB.ydoc });

    replaceLiveMarkdown(collabA.ydoc, `${collabA.ydoc.getText('markdown').toString()}\n\nHuman A line.`, parser, 'human-a');
    await waitFor(
      () => collabA.ydoc.getText('markdown').toString().includes('Human A line.')
        && collabB.ydoc.getText('markdown').toString().includes('Human A line.'),
      DEFAULT_TIMEOUT_MS,
      'human A edit propagated',
    );
    await waitForAsync(async () => {
      const stateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
      });
      const state = await mustJson<AgentStateResponse & { markdown?: string; content?: string }>(stateRes);
      const markdown = typeof state.markdown === 'string' ? state.markdown : (state.content ?? '');
      return markdown.includes('Human A line.');
    }, DEFAULT_TIMEOUT_MS, 'human A edit persisted');

    replaceLiveMarkdown(collabB.ydoc, `${collabB.ydoc.getText('markdown').toString()}\n\nHuman B line.`, parser, 'human-b');

    await waitFor(
      () => collabA.ydoc.getText('markdown').toString().includes('Human A line.')
        && collabA.ydoc.getText('markdown').toString().includes('Human B line.'),
      DEFAULT_TIMEOUT_MS,
      'concurrent edits merged on client A',
    );
    await waitFor(
      () => collabB.ydoc.getText('markdown').toString().includes('Human A line.')
        && collabB.ydoc.getText('markdown').toString().includes('Human B line.'),
      DEFAULT_TIMEOUT_MS,
      'concurrent edits merged on client B',
    );
    await waitForAsync(async () => {
      const stateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
      });
      const state = await mustJson<AgentStateResponse & { markdown?: string; content?: string }>(stateRes);
      const markdown = typeof state.markdown === 'string' ? state.markdown : (state.content ?? '');
      return markdown.includes('Human A line.') && markdown.includes('Human B line.');
    }, DEFAULT_TIMEOUT_MS, 'human edits persisted before agent edit');

    // Agent edit with baseUpdatedAt and without (optimistic concurrency).
    const appendText = `AGENT-${randomUUID()}`;
    const snapshot = await fetchAgentSnapshot(httpBase, created.slug, created.ownerSecret);
    const editRes = await fetch(`${httpBase}/api/agent/${created.slug}/edit/v2`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'ai:test',
        baseRevision: snapshot.revision,
        operations: [{ op: 'insert_after', ref: getLastBlockRef(snapshot), blocks: [{ markdown: appendText }] }],
      }),
    });
    const editBodyText = await editRes.text();
    assert(editRes.ok, `Expected agent edit ok, got ${editRes.status}: ${editBodyText.slice(0, 400)}`);

    const missingBase = await fetch(`${httpBase}/api/agent/${created.slug}/edit/v2`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'ai:test',
        operations: [{ op: 'insert_after', ref: getLastBlockRef(snapshot), blocks: [{ markdown: 'MISSING' }] }],
      }),
    });
    assert(missingBase.status === 400, `Expected missing base 400, got ${missingBase.status}`);

    const staleBase = await fetch(`${httpBase}/api/agent/${created.slug}/edit/v2`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'ai:test',
        baseRevision: 1,
        operations: [{ op: 'insert_after', ref: getLastBlockRef(snapshot), blocks: [{ markdown: 'STALE' }] }],
      }),
    });
    assert(staleBase.status === 409, `Expected stale base 409, got ${staleBase.status}`);

    await waitFor(() => {
      const doc = db.getDocumentBySlug(created.slug);
      if (!doc?.markdown) return false;
      const cleaned = stripAuthoredSpanTags(doc.markdown);
      return cleaned.includes(appendText);
    }, DEFAULT_TIMEOUT_MS, 'agent edit stored in db');

    // Comment via API.
    const commentQuote = 'Alpha paragraph';
    const commentRes = await fetch(`${httpBase}/api/agent/${created.slug}/ops`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        type: 'comment.add',
        by: 'human:test',
        quote: commentQuote,
        text: 'Looks good',
      }),
    });
    assert(commentRes.ok, `Expected comment.add ok, got ${commentRes.status}`);

    const commentPayload = await mustJson<{ marks?: Record<string, unknown> }>(commentRes);
    const commentIds = Object.keys(commentPayload.marks ?? {});
    assert(commentIds.length > 0, 'Expected comment mark id returned');

    // Comment via collab (browser-like). Insert mark metadata and ensure persistence.
    const browserCommentId = `comment-${randomUUID()}`;
    const marksMap = collabA.ydoc.getMap('marks');
    marksMap.set(browserCommentId, {
      kind: 'comment',
      by: 'human:browser',
      createdAt: new Date().toISOString(),
      quote: 'Beta paragraph',
      text: 'Browser comment',
      threadId: browserCommentId,
      thread: [],
      resolved: false,
    });

    await waitFor(
      () => Boolean(collabB.ydoc.getMap('marks').get(browserCommentId)),
      DEFAULT_TIMEOUT_MS,
      'browser comment replicated to second client',
    );

    await waitFor(() => {
      const doc = db.getDocumentBySlug(created.slug);
      if (!doc?.marks) return false;
      try {
        const parsed = JSON.parse(doc.marks) as Record<string, unknown>;
        return Boolean(parsed[browserCommentId]);
      } catch {
        return false;
      }
    }, DEFAULT_TIMEOUT_MS, 'browser comment persisted');

    // Suggestions add/accept/reject.
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
        quote: 'Alpha paragraph',
        content: 'Alpha paragraph (suggested)',
      }),
    });
    assert(suggestRes.ok, `Expected suggestion.add ok, got ${suggestRes.status}`);
    const suggestPayload = await mustJson<{ marks?: Record<string, any> }>(suggestRes);
    const suggestionId = Object.keys(suggestPayload.marks ?? {}).find((id) => {
      const mark = (suggestPayload.marks ?? {})[id] as Record<string, unknown> | undefined;
      return mark?.kind === 'replace';
    });
    assert(suggestionId, 'Expected suggestion mark id');

    const acceptRes = await fetch(`${httpBase}/api/agent/${created.slug}/ops`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        type: 'suggestion.accept',
        by: 'human:editor',
        markId: suggestionId,
      }),
    });
    assert(acceptRes.ok, `Expected suggestion.accept ok, got ${acceptRes.status}`);

    const rejectSuggestionRes = await fetch(`${httpBase}/api/agent/${created.slug}/ops`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        type: 'suggestion.add',
        by: 'ai:test',
        kind: 'insert',
        quote: 'Beta paragraph',
        content: 'Inserted suggestion',
      }),
    });
    assert(rejectSuggestionRes.ok, `Expected suggestion.add (insert) ok, got ${rejectSuggestionRes.status}`);
    const rejectPayload = await mustJson<{ marks?: Record<string, any> }>(rejectSuggestionRes);
    const rejectId = Object.keys(rejectPayload.marks ?? {}).find((id) => {
      const mark = (rejectPayload.marks ?? {})[id] as Record<string, unknown> | undefined;
      return mark?.kind === 'insert';
    });
    assert(rejectId, 'Expected reject suggestion id');

    const rejectRes = await fetch(`${httpBase}/api/agent/${created.slug}/ops`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        type: 'suggestion.reject',
        by: 'human:editor',
        markId: rejectId,
      }),
    });
    assert(rejectRes.ok, `Expected suggestion.reject ok, got ${rejectRes.status}`);

    const updatedDoc = db.getDocumentBySlug(created.slug);
    assert(updatedDoc?.markdown.includes('Alpha paragraph (suggested)'), 'Expected accepted suggestion to update markdown');

    // WebSocket reconnection.
    safeDisconnect(collabA.provider);
    const reconnect = await connectCollab(httpBase, created.slug, created.ownerSecret);
    providers.push({ provider: reconnect.provider, ydoc: reconnect.ydoc });
    await waitFor(
      () => reconnect.ydoc.getText('markdown').toString().includes('Alpha paragraph (suggested)'),
      DEFAULT_TIMEOUT_MS,
      'reconnected collab has latest content',
    );

    // Agent + human simultaneous editing.
    replaceLiveMarkdown(
      reconnect.ydoc,
      `${reconnect.ydoc.getText('markdown').toString()}\n\nHuman concurrent line.`,
      parser,
      'human-concurrent',
    );
    await waitForAsync(async () => {
      const stateRes2 = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
      });
      const state2 = await mustJson<AgentStateResponse & { markdown?: string; content?: string }>(stateRes2);
      const markdown = typeof state2.markdown === 'string' ? state2.markdown : (state2.content ?? '');
      return markdown.includes('Human concurrent line.');
    }, DEFAULT_TIMEOUT_MS, 'human concurrent edit persisted before agent edit');

    const snapshot2 = await fetchAgentSnapshot(httpBase, created.slug, created.ownerSecret);
    const agentConcurrent = await fetch(`${httpBase}/api/agent/${created.slug}/edit/v2`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        by: 'ai:test',
        baseRevision: snapshot2.revision,
        operations: [{ op: 'insert_after', ref: getLastBlockRef(snapshot2), blocks: [{ markdown: 'Agent concurrent line.' }] }],
      }),
    });
    const agentConcurrentBodyText = await agentConcurrent.text();
    await waitFor(
      () => reconnect.ydoc.getText('markdown').toString().includes('Human concurrent line.'),
      DEFAULT_TIMEOUT_MS,
      'human concurrent edit propagated to collab',
    );
    if (agentConcurrent.ok) {
      const parsed = JSON.parse(agentConcurrentBodyText) as { success?: boolean; collab?: { status?: string } };
      if (parsed.success === true && parsed.collab?.status === 'pending') {
        const doc = db.getDocumentBySlug(created.slug);
        const cleaned = stripAuthoredSpanTags(doc?.markdown ?? '');
        assert(cleaned.length > 0, 'Expected readable canonical markdown after pending concurrent agent edit');
      } else {
        await waitFor(() => {
          const doc = db.getDocumentBySlug(created.slug);
          if (!doc?.markdown) return false;
          const cleaned = stripAuthoredSpanTags(doc.markdown);
          return cleaned.includes('Agent concurrent line.');
        }, DEFAULT_TIMEOUT_MS, 'agent concurrent edit stored in db');
      }
    } else {
      const parsed = JSON.parse(agentConcurrentBodyText) as { code?: string };
      assert(
        agentConcurrent.status === 409 && parsed.code === 'FRAGMENT_DIVERGENCE',
        `Expected concurrent agent edit to either succeed, return pending, or hard-fail with FRAGMENT_DIVERGENCE, got ${agentConcurrent.status}: ${agentConcurrentBodyText.slice(0, 400)}`,
      );
      const doc = db.getDocumentBySlug(created.slug);
      const cleaned = stripAuthoredSpanTags(doc?.markdown ?? '');
      assert(!cleaned.includes('Agent concurrent line.'), 'Expected hard-failed concurrent agent edit not to persist agent content');
    }

    // Rewrite admission still blocks without force while authenticated live clients are connected.
    const rewriteStateRes = await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const rewriteState = await mustJson<AgentStateResponse>(rewriteStateRes);
    assert(typeof rewriteState.revision === 'number' && Number.isFinite(rewriteState.revision), 'Expected revision before rewrite.apply');
    const rewriteContent = '# Rewrite Title\n\nFresh rewrite content.';
    const blockedRewriteRes = await fetch(`${httpBase}/api/agent/${created.slug}/ops`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        type: 'rewrite.apply',
        by: 'ai:test',
        baseRevision: rewriteState.revision,
        content: rewriteContent,
      }),
    });
    const blockedRewriteBody = await blockedRewriteRes.json() as { code?: string };
    assert(blockedRewriteRes.status === 409, `Expected live-client rewrite block, got ${blockedRewriteRes.status}`);
    assert(blockedRewriteBody.code === 'LIVE_CLIENTS_PRESENT', `Expected LIVE_CLIENTS_PRESENT, got ${String(blockedRewriteBody.code)}`);

    const forcedRewriteRes = await fetch(`${httpBase}/api/agent/${created.slug}/ops`, {
      method: 'POST',
      headers: {
        ...CLIENT_HEADERS,
        'Content-Type': 'application/json',
        'x-share-token': created.ownerSecret,
      },
      body: JSON.stringify({
        type: 'rewrite.apply',
        by: 'ai:test',
        baseRevision: rewriteState.revision,
        content: rewriteContent,
        force: true,
      }),
    });
    const forcedRewriteBody = await mustJson<{
      success?: boolean;
      forceHonored?: boolean;
      forceIgnored?: boolean;
      connectedClients?: number;
    }>(forcedRewriteRes);
    assert(forcedRewriteRes.ok, `Expected forced rewrite.apply ok, got ${forcedRewriteRes.status}`);
    assert(forcedRewriteBody.success === true, 'Expected forced rewrite success payload');
    assert(forcedRewriteBody.forceHonored === true, 'Expected forceHonored=true for forced rewrite');
    assert(forcedRewriteBody.forceIgnored === false, 'Expected forceIgnored=false for forced rewrite');
    assert((forcedRewriteBody.connectedClients ?? 0) > 0, 'Expected forced rewrite to report connected clients');

    for (const entry of providers) {
      safeDisconnect(entry.provider);
    }
    await waitFor(
      () => getActiveCollabClientCount(created.slug) === 0,
      DEFAULT_TIMEOUT_MS,
      'all live collab clients disconnected after forced rewrite',
    );

    await waitForAsync(async () => {
      try {
        const res = await fetch(`${httpBase}/api/documents/${created.slug}`, {
          headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
        });
        if (!res.ok) return false;
        const payload = await mustJson<{ markdown?: string }>(res);
        const cleaned = stripAuthoredSpanTags(payload.markdown ?? '');
        return cleaned.includes('Fresh rewrite content.');
      } catch {
        return false;
      }
    }, DEFAULT_TIMEOUT_MS, 'rewrite stored in db via api');

    // Marks merge: preserve comments when incoming metadata is incomplete.
    const mergeSlug = `merge-${Math.random().toString(36).slice(2, 8)}`;
    const mergeCommentId = `comment-${Math.random().toString(36).slice(2, 8)}`;
    const mergeAuthoredId = `authored-${Math.random().toString(36).slice(2, 8)}`;
    const mergeMarks: Record<string, unknown> = {
      [mergeCommentId]: {
        kind: 'comment',
        by: 'human:test',
        createdAt: new Date().toISOString(),
        quote: 'Merge Target',
        text: 'Preserve me',
        threadId: mergeCommentId,
        thread: [],
        resolved: false,
      },
      [mergeAuthoredId]: {
        kind: 'authored',
        by: 'human:test',
        createdAt: '1970-01-01T00:00:00.000Z',
        quote: 'Merge Target',
        range: { from: 1, to: 12 },
      },
    };
    db.createDocument(mergeSlug, '# Merge Target\n\nHello.', mergeMarks, 'Merge test');

    const instance = collab.__unsafeGetHocuspocusInstanceForTests() as any;
    assert(instance && typeof instance.createDocument === 'function', 'Expected hocuspocus instance for marks merge');
    const loadedDoc = await instance.createDocument(
      mergeSlug,
      {},
      'merge-socket',
      { isAuthenticated: true, readOnly: false, requiresAuthentication: true },
      {},
    );
    loadedDoc.transact(() => {
      const map = loadedDoc.getMap('marks');
      map.forEach((_value: unknown, key: string) => map.delete(key));
      map.set(mergeAuthoredId, mergeMarks[mergeAuthoredId]);
      loadedDoc.getText('markdown').insert(loadedDoc.getText('markdown').length, '\n');
    }, 'merge-authored-only');

    await waitFor(() => {
      const doc = db.getDocumentBySlug(mergeSlug);
      if (!doc?.marks) return false;
      try {
        const parsed = JSON.parse(doc.marks) as Record<string, unknown>;
        return Boolean(parsed[mergeCommentId]);
      } catch {
        return false;
      }
    }, DEFAULT_TIMEOUT_MS, 'merge preserves comment mark');

    // Wipe detection (>80% shrink) emits warning.
    const wipeSlug = `wipe-${Math.random().toString(36).slice(2, 8)}`;
    const largeMarkdown = `# Wipe Test\n\n${'x'.repeat(1000)}`;
    db.createDocument(wipeSlug, largeMarkdown, {}, 'Wipe detection');
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
      originalWarn(...args);
    };

    try {
      await collab.applyCanonicalDocumentToCollab(wipeSlug, { markdown: largeMarkdown, marks: {}, source: 'wipe-seed' });
      await collab.applyCanonicalDocumentToCollab(wipeSlug, { markdown: '# Wipe Test', marks: {}, source: 'wipe-shrink' });
      await waitFor(
        () => warnings.some((entry) => entry.includes('Projection markdown shrank by >80%')),
        DEFAULT_TIMEOUT_MS,
        'wipe detection warning',
      );
    } finally {
      console.warn = originalWarn;
    }

    // Graceful degradation: collab disabled returns snapshot fallback metadata.
    await collab.stopCollabRuntime();
    process.env.PROOF_COLLAB_V2 = '0';
    await collab.startCollabRuntimeEmbedded(address.port);

    const fallbackRes = await fetch(`${httpBase}/api/documents/${created.slug}/open-context`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const fallbackPayload = await mustJson<{ collabAvailable?: boolean; snapshotUrl?: string | null }>(fallbackRes);
    assert(fallbackPayload.collabAvailable === false, 'Expected collabAvailable=false when disabled');
    assert(fallbackPayload.snapshotUrl === null || typeof fallbackPayload.snapshotUrl === 'string', 'Expected snapshotUrl to be string or null when collab disabled');

    console.log('✓ collab reliability full QA integration test');
  } finally {
    for (const entry of providers) {
      safeDisconnect(entry.provider);
      entry.ydoc.destroy();
    }
    try {
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          // ignore
        }
      }
      wss.close();
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await collab.stopCollabRuntime();

    if (prevDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDatabasePath;

    if (prevProofEnv === undefined) delete process.env.PROOF_ENV;
    else process.env.PROOF_ENV = prevProofEnv;

    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;

    if (prevDbEnvInit === undefined) delete process.env.PROOF_DB_ENV_INIT;
    else process.env.PROOF_DB_ENV_INIT = prevDbEnvInit;

    if (prevCollabFlag === undefined) delete process.env.PROOF_COLLAB_V2;
    else process.env.PROOF_COLLAB_V2 = prevCollabFlag;

    if (prevStartupReconcileEnabled === undefined) delete process.env.COLLAB_STARTUP_RECONCILE_ENABLED;
    else process.env.COLLAB_STARTUP_RECONCILE_ENABLED = prevStartupReconcileEnabled;

    if (prevStartupReconcileDelayMs === undefined) delete process.env.COLLAB_STARTUP_RECONCILE_DELAY_MS;
    else process.env.COLLAB_STARTUP_RECONCILE_DELAY_MS = prevStartupReconcileDelayMs;

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
