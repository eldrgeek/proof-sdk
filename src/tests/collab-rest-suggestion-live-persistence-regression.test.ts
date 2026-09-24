import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { EditorState, Plugin } from '@milkdown/kit/prose/state';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import {
  initProseMirrorDoc,
  prosemirrorToYXmlFragment,
  updateYFragment,
  yXmlFragmentToProseMirrorRootNode,
} from 'y-prosemirror';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import type { StoredMark } from '../formats/marks.js';
import {
  accept as acceptMark,
  applyRemoteMarks,
  getMarkMetadataWithQuotes,
  marksPluginKey,
  reject as rejectMark,
} from '../editor/plugins/marks.js';
import { stripAllProofSpanTags } from '../../server/proof-span-strip.js';

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.32.0',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

type CreatedDocument = {
  slug: string;
  ownerSecret: string;
  accessToken?: string;
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
  markId?: string;
  marks?: Record<string, { kind?: string; status?: string }>;
};

type ConnectedClient = {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  destroy: () => void;
};

function loadChromium(): any {
  const packageJson = process.env.PROOF_PLAYWRIGHT_PACKAGE_JSON;
  const require = createRequire(packageJson || import.meta.url);
  try {
    return require('playwright').chromium;
  } catch {
    throw new Error(
      'Playwright is required. Set PROOF_PLAYWRIGHT_PACKAGE_JSON to a package.json beside an installed playwright package.',
    );
  }
}

async function openBrowserEditor(browser: any, url: string): Promise<any> {
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true',
    null,
    { timeout: 30_000 },
  );
  const nameInput = page.getByPlaceholder('Your name');
  if (await nameInput.isVisible()) {
    await nameInput.fill('Connected accept regression');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await nameInput.waitFor({ state: 'hidden', timeout: 10_000 });
  }
  await page.waitForTimeout(1_000);
  return page;
}

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
    warnings: unknown[][];
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

  const firstClient = await connectClient(
    context.httpBase,
    created.slug,
    created.ownerSecret,
  );
  try {
    const suggestResponse = await postAgent(
      context.httpBase,
      created.slug,
      created.ownerSecret,
      '/marks/suggest-delete',
      { quote: 'TARGET', by: action === 'accept' ? 'human:test' : 'ai:test' },
    );
    const suggested = await mustJson<SuggestionResponse>(suggestResponse, `create ${action} suggestion`);
    const markId = Object.entries(suggested.marks ?? {})
      .find(([, mark]) => mark.kind === 'delete' && mark.status === 'pending')?.[0] ?? '';
    assert(markId.length > 0, `Expected ${action} suggestion id`);
    await waitFor(
      () => firstClient.doc.getMap('marks').has(markId) === true,
      5_000,
      `${action} suggestion in live marks`,
    );
    const staleMark = firstClient.doc.getMap('marks').get(markId);
    assert(staleMark !== undefined, `Expected stale ${action} suggestion payload`);

    const resolutionResponse = await postAgent(
      context.httpBase,
      created.slug,
      created.ownerSecret,
      `/marks/${action}`,
      { markId, by: 'ai:test' },
    );
    await mustJson<Record<string, unknown>>(resolutionResponse, `REST ${action}`);
    await waitFor(
      () => firstClient.doc.getMap('marks').has(markId) === false,
      5_000,
      `${action} resolution removed from live marks`,
    );

    firstClient.doc.transact(() => {
      firstClient.doc.getMap('marks').set(markId, staleMark);
    }, 'browser-stale-marks-write');
    await waitFor(
      () => firstClient.doc.getMap('marks').has(markId) === false,
      5_000,
      `tombstone removed stale ${action} suggestion write`,
    );
    const projectionMarks = context.collab.mergePreservedActionMarks(created.slug, {
      [markId]: staleMark,
    });
    assert(
      !Object.prototype.hasOwnProperty.call(projectionMarks, markId),
      `Projection refresh must drop tombstoned ${action} suggestion`,
    );
    const canonicalSync = await context.collab.syncCanonicalDocumentStateToCollab(created.slug, {
      marks: { [markId]: staleMark },
      source: `test-stale-${action}-canonical-sync`,
    });
    assert(canonicalSync.applied === true, `Expected stale ${action} canonical sync to complete`);
    assert(
      !firstClient.doc.getMap('marks').has(markId),
      `Canonical sync must not restore tombstoned ${action} suggestion`,
    );

    const updateSeqBeforeEdit = getPersistedUpdateRows(context.db, created.slug).at(-1)?.seq ?? 0;

    const marker = `persisted-after-${action}-${randomUUID().slice(0, 8)}`;
    const resolvedMarkdown = action === 'accept'
      ? initialMarkdown.replace('TARGET', '')
      : initialMarkdown;
    const editedMarkdown = `${resolvedMarkdown}\n\n${marker}`;
    await replaceFragmentMarkdown(firstClient.doc, editedMarkdown, context.parseMarkdown);

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
      marks?: Record<string, unknown>;
      projectionFresh?: boolean;
      repairPending?: boolean;
    }>(stateResponse, `${action} state`);
    const stateMarkdown = state.markdown ?? state.content ?? '';
    assert(state.projectionFresh === true, `Expected fresh projection after REST ${action}`);
    assert(state.repairPending !== true, `Expected no pending repair after REST ${action}`);
    assert(stateMarkdown.includes(marker), `Expected /state edit after REST ${action}`);
    assert(
      !Object.prototype.hasOwnProperty.call(state.marks ?? {}, markId),
      `Expected /state to keep REST ${action} suggestion absent after stale client write`,
    );
    const canonicalMarks = JSON.parse(context.db.getDocumentBySlug(created.slug)?.marks ?? '{}') as Record<string, unknown>;
    assert(
      !Object.prototype.hasOwnProperty.call(canonicalMarks, markId),
      `Expected canonical marks to keep REST ${action} suggestion absent`,
    );
    const dropWarnings = context.warnings.filter((args) => {
      if (args[0] !== '[collab] dropped tombstoned mark') return false;
      const details = args[1] as Record<string, unknown> | undefined;
      return details?.slug === created.slug && details?.markId === markId;
    });
    assert(dropWarnings.length === 1, `Expected one tombstone-drop warning for REST ${action}`);
  } finally {
    firstClient.destroy();
  }
}

async function runAiInsertCase(
  context: {
    httpBase: string;
    db: typeof import('../../server/db.ts');
    schema: import('@milkdown/kit/prose/model').Schema;
  },
): Promise<void> {
  const initialMarkdown = '# Live insert\n\nKeep anchor here.';
  const createResponse = await fetch(`${context.httpBase}/api/documents`, {
    method: 'POST',
    headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'AI insert live persistence',
      markdown: initialMarkdown,
      marks: {},
    }),
  });
  const created = await mustJson<CreatedDocument>(createResponse, 'create AI insert document');
  const client = await connectClient(context.httpBase, created.slug, created.ownerSecret);
  const initialEpoch = context.db.getDocumentBySlug(created.slug)?.access_epoch;
  const clientText = () => yXmlFragmentToProseMirrorRootNode(
    client.doc.getXmlFragment('prosemirror') as any,
    context.schema as any,
  ).textContent;

  try {
    const acceptedContent = ' accepted words';
    const suggestAcceptResponse = await postAgent(
      context.httpBase,
      created.slug,
      created.ownerSecret,
      '/marks/suggest-insert',
      { quote: 'anchor', content: acceptedContent, by: 'ai:test' },
    );
    const suggestedAccept = await mustJson<SuggestionResponse>(
      suggestAcceptResponse,
      'create accepted AI insert suggestion',
    );
    const acceptedMarkId = suggestedAccept.markId ?? '';
    assert(acceptedMarkId.length > 0, 'Expected pending AI insert response to return its mark id');
    await waitFor(
      () => clientText().includes(`anchor${acceptedContent}`),
      10_000,
      'AI insert text in connected client',
    );
    await waitFor(
      () => client.doc.getMap('marks').has(acceptedMarkId),
      5_000,
      'AI insert pending mark in connected client',
    );
    const pendingAccept = client.doc.getMap('marks').get(acceptedMarkId) as Record<string, unknown>;
    assert(pendingAccept.kind === 'insert' && pendingAccept.status === 'pending', 'Expected pending insert mark metadata');
    assert(pendingAccept.content === acceptedContent, 'Expected pending insert mark to preserve proposed content');
    assert(pendingAccept.quote === 'accepted words', 'Expected pending insert mark quote to anchor inserted text');
    assert(
      typeof pendingAccept.startRel === 'string' && typeof pendingAccept.endRel === 'string',
      'Expected pending insert mark to carry relative anchors for inserted text',
    );

    const pendingStateResponse = await fetch(`${context.httpBase}/api/agent/${created.slug}/state`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const pendingState = await mustJson<{
      markdown?: string;
      projectionFresh?: boolean;
      repairPending?: boolean;
    }>(pendingStateResponse, 'pending AI insert state');
    assert(pendingState.projectionFresh === true, 'Expected fresh /state projection after AI insert add');
    assert(pendingState.repairPending !== true, 'Expected no projection repair after AI insert add');
    assert(pendingState.markdown?.includes(`anchor${acceptedContent}`) === true, 'Expected /state to include pending insert text');

    const acceptedPayload = await mustJson<{
      marks?: Record<string, { kind?: string; by?: string }>;
    }>(
      await postAgent(
        context.httpBase,
        created.slug,
        created.ownerSecret,
        '/marks/accept',
        { markId: acceptedMarkId, by: 'human:test' },
      ),
      'accept AI insert suggestion',
    );
    assert(
      Object.values(acceptedPayload.marks ?? {}).some(
        (mark) => mark.kind === 'authored' && mark.by === 'ai:test',
      ),
      'Accept should credit retained insert text to the suggester',
    );
    await waitFor(
      () => !client.doc.getMap('marks').has(acceptedMarkId),
      5_000,
      'accepted AI insert removed from marks map',
    );
    assert(clientText().includes(`anchor${acceptedContent}`), 'Accept should keep AI-inserted text');
    assert(
      context.db.getDocumentBySlug(created.slug)?.access_epoch === initialEpoch,
      'Accept should not reseed the connected live document',
    );

    const rejectedContent = ' rejected words';
    const suggestReject = await mustJson<SuggestionResponse>(
      await postAgent(
        context.httpBase,
        created.slug,
        created.ownerSecret,
        '/marks/suggest-insert',
        { quote: 'here', content: rejectedContent, by: 'ai:test' },
      ),
      'create rejected AI insert suggestion',
    );
    const rejectedMarkId = suggestReject.markId ?? '';
    assert(rejectedMarkId.length > 0, 'Expected second pending AI insert response to return its mark id');
    await waitFor(
      () => clientText().includes(`here${rejectedContent}`)
        && client.doc.getMap('marks').has(rejectedMarkId),
      10_000,
      'second AI insert text and pending mark',
    );
    await mustJson<Record<string, unknown>>(
      await postAgent(
        context.httpBase,
        created.slug,
        created.ownerSecret,
        '/marks/reject',
        { markId: rejectedMarkId, by: 'human:test' },
      ),
      'reject AI insert suggestion',
    );
    await waitFor(
      () => !clientText().includes(rejectedContent)
        && !client.doc.getMap('marks').has(rejectedMarkId),
      10_000,
      'rejected AI insert removed without reseed',
    );
    assert(
      context.db.getDocumentBySlug(created.slug)?.access_epoch === initialEpoch,
      'REST reject should not reseed the connected live document',
    );

    const finalStateResponse = await fetch(`${context.httpBase}/api/agent/${created.slug}/state`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const finalState = await mustJson<{
      markdown?: string;
      projectionFresh?: boolean;
      repairPending?: boolean;
    }>(finalStateResponse, 'resolved AI insert state');
    assert(finalState.projectionFresh === true, 'Expected fresh /state projection after AI insert resolutions');
    assert(finalState.repairPending !== true, 'Expected no projection repair after AI insert resolutions');
    assert(finalState.markdown?.includes(acceptedContent) === true, 'Expected accepted AI insert in final state');
    assert(finalState.markdown?.includes(rejectedContent) !== true, 'Expected rejected AI insert absent from final state');
  } finally {
    client.destroy();
  }
}

async function createInsertFixture(
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

function readClientRoot(
  client: ConnectedClient,
  schema: import('@milkdown/kit/prose/model').Schema,
) {
  return yXmlFragmentToProseMirrorRootNode(
    client.doc.getXmlFragment('prosemirror') as any,
    schema as any,
  );
}

function findFirstNode(root: ReturnType<typeof readClientRoot>, typeName: string): ProseMirrorNode | null {
  let found: ProseMirrorNode | null = null;
  root.descendants((node) => {
    if (node.type.name === typeName) {
      found = node;
      return false;
    }
    return found === null;
  });
  return found;
}

function createMarksStatePlugin(): Plugin {
  return new Plugin({
    key: marksPluginKey,
    state: {
      init: () => ({ metadata: {}, activeMarkId: null, composeAnchorRange: null }),
      apply: (tr, value) => {
        const meta = tr.getMeta(marksPluginKey);
        return meta?.type === 'SET_METADATA'
          ? { ...value, metadata: meta.metadata ?? {} }
          : value;
      },
    },
  });
}

function readClientMarks(client: ConnectedClient): Record<string, StoredMark> {
  return Object.fromEntries(client.doc.getMap('marks').entries()) as Record<string, StoredMark>;
}

function resolveSuggestionInConnectedClient(
  client: ConnectedClient,
  schema: import('@milkdown/kit/prose/model').Schema,
  markId: string,
  action: 'accept' | 'reject',
): boolean {
  let state = EditorState.create({
    schema,
    doc: readClientRoot(client, schema),
    plugins: [createMarksStatePlugin()],
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(tr: import('@milkdown/kit/prose/state').Transaction) {
      state = state.apply(tr);
    },
  };
  applyRemoteMarks(view as any, readClientMarks(client), { hydrateAnchors: true });
  const applied = action === 'accept'
    ? acceptMark(view as any, markId)
    : rejectMark(view as any, markId);
  if (!applied) return false;

  const nextMarks = getMarkMetadataWithQuotes(state);
  client.doc.transact(() => {
    const fragment = client.doc.getXmlFragment('prosemirror');
    const { meta } = initProseMirrorDoc(fragment as any, schema as any);
    updateYFragment(client.doc, fragment as any, state.doc as any, meta as any);
  }, `browser-${action}-fragment`);
  client.doc.transact(() => {
    const marks = client.doc.getMap('marks');
    const nextIds = new Set(Object.keys(nextMarks));
    for (const id of Array.from(marks.keys())) {
      if (!nextIds.has(id)) marks.delete(id);
    }
    for (const [id, value] of Object.entries(nextMarks)) {
      marks.set(id, value);
    }
  }, `browser-${action}-marks`);
  return true;
}

const STRUCTURED_INSERT_MARKDOWN = [
  '# Block test',
  '',
  'Intro paragraph one.',
  '',
  '| Name | Role |',
  '| --- | --- |',
  '| Eric | Writer |',
  '| Diana | Director |',
  '',
  'Closing paragraph.',
  '',
].join('\n');

async function runStructuredAiInsertCases(context: {
  httpBase: string;
  schema: import('@milkdown/kit/prose/model').Schema;
}): Promise<void> {
  const play = await createInsertFixture(
    context.httpBase,
    'hard-break AI insert',
    '# Proof E2E\n\nERIC\\\nI think teh play is ready.\n\nDIANA\\\nThe second act needs one more scene.\n',
  );
  const playClient = await connectClient(context.httpBase, play.slug, play.ownerSecret);
  try {
    const inserted = await mustJson<SuggestionResponse>(
      await postAgent(
        context.httpBase,
        play.slug,
        play.ownerSecret,
        '/marks/suggest-insert',
        { quote: 'needs one more scene', content: ' AI insert words', by: 'ai:test' },
      ),
      'hard-break insert suggestion',
    );
    const markId = inserted.markId ?? '';
    assert(markId.length > 0, 'Expected hard-break insert mark id');
    await waitFor(
      () => readClientRoot(playClient, context.schema).textContent.includes('needs one more scene AI insert words')
        && playClient.doc.getMap('marks').has(markId),
      10_000,
      'hard-break insert text and pending mark',
    );
    const state = await mustJson<{ markdown?: string; projectionFresh?: boolean; marks?: Record<string, unknown> }>(
      await fetch(`${context.httpBase}/api/agent/${play.slug}/state`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': play.ownerSecret },
      }),
      'hard-break insert state',
    );
    assert(state.projectionFresh === true, 'Hard-break insert must leave /state projection fresh');
    assert(state.markdown?.includes('needs one more scene AI insert words') === true, 'Hard-break insert must persist');
    assert(Object.prototype.hasOwnProperty.call(state.marks ?? {}, markId), 'Hard-break insert must stay pending');

    const following = await postAgent(
      context.httpBase,
      play.slug,
      play.ownerSecret,
      '/marks/suggest-delete',
      { quote: 'second act', by: 'ai:test' },
    );
    assert(following.status === 200, `Following suggestion.add should succeed, got ${following.status}`);
  } finally {
    playClient.destroy();
  }

  const formatted = await createInsertFixture(
    context.httpBase,
    'formatted anchor AI inserts',
    'A **bold anchor** and a [linked anchor](https://example.com) stay formatted.',
  );
  const formattedClient = await connectClient(context.httpBase, formatted.slug, formatted.ownerSecret);
  try {
    for (const [quote, content] of [
      ['bold anchor', ' after bold'],
      ['linked anchor', ' after link'],
    ] as const) {
      const suggested = await mustJson<SuggestionResponse>(
        await postAgent(
          context.httpBase,
          formatted.slug,
          formatted.ownerSecret,
          '/marks/suggest-insert',
          { quote, content, by: 'ai:test' },
        ),
        `${quote} insert suggestion`,
      );
      const markId = suggested.markId ?? '';
      await waitFor(
        () => readClientRoot(formattedClient, context.schema).textContent.includes(`${quote}${content}`)
          && formattedClient.doc.getMap('marks').has(markId),
        10_000,
        `${quote} inserted with pending mark`,
      );
    }
    const state = await mustJson<{ markdown?: string; projectionFresh?: boolean }>(
      await fetch(`${context.httpBase}/api/agent/${formatted.slug}/state`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': formatted.ownerSecret },
      }),
      'formatted anchor insert state',
    );
    assert(state.markdown?.includes('**bold anchor** after bold') === true, 'Bold anchor formatting must survive insert');
    assert(
      state.markdown?.includes('[linked anchor](https://example.com) after link') === true,
      'Link anchor formatting must survive insert',
    );
    assert(state.projectionFresh === true, 'Formatted anchor inserts must leave projection fresh');
  } finally {
    formattedClient.destroy();
  }

  for (const action of ['accept', 'reject'] as const) {
    const fixture = await createInsertFixture(
      context.httpBase,
      `paragraph insert ${action}`,
      STRUCTURED_INSERT_MARKDOWN,
    );
    const client = await connectClient(context.httpBase, fixture.slug, fixture.ownerSecret);
    try {
      const suggested = await mustJson<SuggestionResponse>(
        await postAgent(
          context.httpBase,
          fixture.slug,
          fixture.ownerSecret,
          '/marks/suggest-insert',
          { quote: 'Closing paragraph.', content: '\n\nAnother AI paragraph.', by: 'ai:test' },
        ),
        `paragraph insert ${action} suggestion`,
      );
      const markId = suggested.markId ?? '';
      await waitFor(
        () => readClientRoot(client, context.schema).textContent.includes('Another AI paragraph.')
          && client.doc.getMap('marks').has(markId),
        10_000,
        `paragraph insert ${action} pending`,
      );
      const pendingState = await mustJson<{
        markdown?: string;
        marks?: Record<string, { status?: string; insertStructure?: string }>;
        projectionFresh?: boolean;
      }>(
        await fetch(`${context.httpBase}/api/agent/${fixture.slug}/state`, {
          headers: { ...CLIENT_HEADERS, 'x-share-token': fixture.ownerSecret },
        }),
        `paragraph insert ${action} pending state`,
      );
      assert(pendingState.markdown?.includes('Another AI paragraph.') === true, 'Pending final paragraph must exist on the server');
      assert(pendingState.marks?.[markId]?.status === 'pending', 'Pending final paragraph mark must exist on the server');
      assert(pendingState.marks?.[markId]?.insertStructure === 'block', 'Pending final paragraph mark must record block structure');
      assert(pendingState.projectionFresh === true, 'Pending final paragraph projection must be fresh');
      await mustJson<Record<string, unknown>>(
        await postAgent(
          context.httpBase,
          fixture.slug,
          fixture.ownerSecret,
          `/marks/${action}`,
          { markId, by: 'human:test' },
        ),
        `paragraph insert ${action}`,
      );
      await waitFor(
        () => !client.doc.getMap('marks').has(markId),
        10_000,
        `paragraph insert ${action} resolution`,
      );
      const state = await mustJson<{ markdown?: string; projectionFresh?: boolean }>(
        await fetch(`${context.httpBase}/api/agent/${fixture.slug}/state`, {
          headers: { ...CLIENT_HEADERS, 'x-share-token': fixture.ownerSecret },
        }),
        `paragraph insert ${action} state`,
      );
      const count = state.markdown?.match(/Another AI paragraph\./g)?.length ?? 0;
      assert(count === (action === 'accept' ? 1 : 0), `Paragraph ${action} should leave ${action === 'accept' ? 1 : 0} copies, got ${count}`);
      assert(state.projectionFresh === true, `Paragraph ${action} must leave projection fresh`);
      assert(!Object.prototype.hasOwnProperty.call(readClientMarks(client), markId), 'Resolved paragraph insert must be absent from the connected marks map');
    } finally {
      client.destroy();
    }
  }

  const tableMarkdown = [
    '| Name | Role |',
    '| --- | --- |',
    '| Eric | Writer |',
    '| Diana | Director |',
  ].join('\n');
  const invalidTable = await createInsertFixture(context.httpBase, 'invalid table row insert', tableMarkdown);
  const invalidResponse = await postAgent(
    context.httpBase,
    invalidTable.slug,
    invalidTable.ownerSecret,
    '/marks/suggest-insert',
    { quote: 'Director', content: '\n| Too | Many | Columns |', by: 'ai:test' },
  );
  assert(invalidResponse.status === 422, `Unrepresentable table insert must be refused, got ${invalidResponse.status}`);
  const invalidState = await mustJson<{ markdown?: string; marks?: Record<string, unknown> }>(
    await fetch(`${context.httpBase}/api/agent/${invalidTable.slug}/state`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': invalidTable.ownerSecret },
    }),
    'invalid table row insert state',
  );
  assert(invalidState.markdown?.includes('Too | Many | Columns') !== true, 'Refused insert must not change text');
  assert(Object.keys(invalidState.marks ?? {}).length === 0, 'Refused insert must not leave partial mark metadata');

  for (const action of ['accept', 'reject'] as const) {
    const fixture = await createInsertFixture(context.httpBase, `table row insert ${action}`, tableMarkdown);
    const client = await connectClient(context.httpBase, fixture.slug, fixture.ownerSecret);
    try {
      const beforeTable = findFirstNode(readClientRoot(client, context.schema), 'table');
      const beforeRows = beforeTable?.childCount ?? 0;
      const suggested = await mustJson<SuggestionResponse>(
        await postAgent(
          context.httpBase,
          fixture.slug,
          fixture.ownerSecret,
          '/marks/suggest-insert',
          { quote: 'Director', content: '\n| Mike | Producer |', by: 'ai:test' },
        ),
        `table row insert ${action} suggestion`,
      );
      const markId = suggested.markId ?? '';
      await waitFor(
        () => readClientRoot(client, context.schema).textContent.includes('MikeProducer')
          && client.doc.getMap('marks').has(markId),
        10_000,
        `table row insert ${action} pending`,
      );
      const pendingTable = findFirstNode(readClientRoot(client, context.schema), 'table');
      const insertedRow = pendingTable?.lastChild;
      assert(pendingTable?.childCount === beforeRows + 1, 'Pending table insert must add exactly one row');
      assert(insertedRow?.childCount === 2, `Pending table insert must preserve two columns, got ${insertedRow?.childCount ?? 0}`);

      await mustJson<Record<string, unknown>>(
        await postAgent(
          context.httpBase,
          fixture.slug,
          fixture.ownerSecret,
          `/marks/${action}`,
          { markId, by: 'human:test' },
        ),
        `table row insert ${action}`,
      );
      await waitFor(
        () => !client.doc.getMap('marks').has(markId),
        10_000,
        `table row insert ${action} resolution`,
      );
      const finalTable = findFirstNode(readClientRoot(client, context.schema), 'table');
      assert(
        finalTable?.childCount === beforeRows + (action === 'accept' ? 1 : 0),
        `Table ${action} left the wrong row count`,
      );
      const state = await mustJson<{ markdown?: string; projectionFresh?: boolean }>(
        await fetch(`${context.httpBase}/api/agent/${fixture.slug}/state`, {
          headers: { ...CLIENT_HEADERS, 'x-share-token': fixture.ownerSecret },
        }),
        `table row insert ${action} state`,
      );
      const rowCount = state.markdown?.match(/Mike\s*\|\s*Producer/g)?.length ?? 0;
      assert(rowCount === (action === 'accept' ? 1 : 0), `Table ${action} should leave the inserted row exactly ${action === 'accept' ? 'once' : 'zero times'}`);
      assert(state.projectionFresh === true, `Table ${action} must leave projection fresh`);
    } finally {
      client.destroy();
    }
  }
}

const EXPECTED_ACCEPTED_TABLE_LINES = [
  '| Name  | Role     |',
  '| :---- | :------- |',
  '| Eric  | Writer   |',
  '| Diana | Director |',
  '| Mike  | Producer |',
];

function assertVisibleTableLayout(markdown: string, label: string): void {
  const visibleMarkdown = stripAllProofSpanTags(markdown);
  const tableLines = visibleMarkdown.split('\n').filter((line) => line.startsWith('|'));
  assert(
    JSON.stringify(tableLines) === JSON.stringify(EXPECTED_ACCEPTED_TABLE_LINES),
    `${label} table must be padded from visible text only, got:\n${tableLines.join('\n')}`,
  );
}

async function runCombinedBrowserAcceptCase(
  context: {
    httpBase: string;
    chromium: any;
    db: typeof import('../../server/db.ts');
    collab: typeof import('../../server/collab.ts');
    warnings: unknown[][];
  },
): Promise<void> {
  const fixture = await createInsertFixture(
    context.httpBase,
    'combined browser insert accept',
    STRUCTURED_INSERT_MARKDOWN,
  );
  assert(typeof fixture.accessToken === 'string' && fixture.accessToken.length > 0, 'Expected browser access token');
  const browser = await context.chromium.launch();
  let page: any = null;
  try {
    const url = `${context.httpBase}/d/${fixture.slug}?token=${encodeURIComponent(fixture.accessToken)}`;
    const suggestions = [
      { quote: 'Intro paragraph one.', content: ' AI inline words.', structure: 'inline' },
      { quote: 'Closing paragraph.', content: '\n\nAnother AI paragraph.', structure: 'block' },
      { quote: 'Director', content: '\n| Mike | Producer |', structure: 'table_row' },
    ] as const;
    const markIds: string[] = [];
    for (const suggestion of suggestions) {
      const response = await mustJson<SuggestionResponse>(
        await postAgent(
          context.httpBase,
          fixture.slug,
          fixture.ownerSecret,
          '/ops',
          {
            type: 'suggestion.add',
            kind: 'insert',
            quote: suggestion.quote,
            content: suggestion.content,
            by: 'ai:test',
          },
        ),
        `browser ${suggestion.structure} insert`,
      );
      const markId = response.markId ?? '';
      assert(markId.length > 0, `Expected browser ${suggestion.structure} mark id`);
      markIds.push(markId);
      await waitFor(async () => {
        const state = await mustJson<{ markdown?: string; marks?: Record<string, unknown> }>(
          await fetch(`${context.httpBase}/api/agent/${fixture.slug}/state`, {
            headers: { ...CLIENT_HEADERS, 'x-share-token': fixture.ownerSecret },
          }),
          `browser ${suggestion.structure} server state`,
        );
        return Object.prototype.hasOwnProperty.call(state.marks ?? {}, markId);
      }, 10_000, `browser ${suggestion.structure} stored before connect`);
      await sleep(1_000);
    }

    page = await openBrowserEditor(browser, url);
    try {
      await page.waitForFunction(
        () => {
          const text = document.querySelector('.ProseMirror')?.textContent ?? '';
          return text.includes('Intro paragraph one. AI inline words.')
            && text.includes('Another AI paragraph.')
            && text.includes('Mike')
            && text.includes('Producer');
        },
        null,
        { timeout: 30_000 },
      );
    } catch (error) {
      const browserState = await page.evaluate(() => ({
        text: document.querySelector('.ProseMirror')?.textContent ?? '',
        marks: (window as any).proof.getAllMarks(),
      }));
      const serverState = await mustJson<Record<string, unknown>>(
        await fetch(`${context.httpBase}/api/agent/${fixture.slug}/state`, {
          headers: { ...CLIENT_HEADERS, 'x-share-token': fixture.ownerSecret },
        }),
        'combined browser diagnostic state',
      );
      throw new Error(`Browser did not receive inserts: ${JSON.stringify({ browserState, serverState, error: String(error) })}`);
    }
    await page.waitForFunction(
      (ids: string[]) => {
        const pendingIds = new Set(
          (window as any).proof.getPendingMarkSuggestions().map((mark: { id?: string }) => String(mark.id)),
        );
        return ids.every((id) => pendingIds.has(id));
      },
      markIds,
      { timeout: 30_000 },
    );
    const pendingState = await mustJson<{
      markdown?: string;
      marks?: Record<string, { status?: string }>;
      projectionFresh?: boolean;
    }>(
      await fetch(`${context.httpBase}/api/agent/${fixture.slug}/state`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': fixture.ownerSecret },
      }),
      'combined browser pending state',
    );
    assert(pendingState.projectionFresh === true, 'Combined browser pending projection must be fresh');
    for (const markId of markIds) {
      assert(pendingState.marks?.[markId]?.status === 'pending', `Pending browser mark ${markId} must reach the server`);
    }
    assertVisibleTableLayout(pendingState.markdown ?? '', 'Pending browser suggestion');

    for (const markId of markIds) {
      const accepted = await page.evaluate((id: string) => (window as any).proof.markAccept(id), markId);
      assert(accepted === true, `Browser markAccept must succeed for ${markId}`);
      await page.waitForTimeout(1_000);
    }

    await waitFor(
      () => {
        const row = context.db.getDocumentBySlug(fixture.slug);
        if (!row) return false;
        const marks = JSON.parse(row.marks ?? '{}') as Record<string, unknown>;
        return markIds.every((markId) => !Object.prototype.hasOwnProperty.call(marks, markId));
      },
      15_000,
      'browser accepts in canonical marks',
    );
    const state = await mustJson<{
      markdown?: string;
      marks?: Record<string, unknown>;
      readSource?: string;
      projectionFresh?: boolean;
      mutationReady?: boolean;
      repairPending?: boolean;
    }>(
      await fetch(`${context.httpBase}/api/agent/${fixture.slug}/state`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': fixture.ownerSecret },
      }),
      'combined browser accepted state',
    );
    const markdown = state.markdown ?? '';
    assert(state.readSource === 'projection', `Browser accepts must read from projection, got ${String(state.readSource)}`);
    assert(state.projectionFresh === true, 'Browser accepts must leave projection fresh');
    assert(state.mutationReady === true, 'Browser accepts must leave mutations ready');
    assert(state.repairPending !== true, 'Browser accepts must not queue projection repair');
    assert((markdown.match(/AI inline words\./g) ?? []).length === 1, 'Browser inline insert must be stored exactly once');
    assert((markdown.match(/Another AI paragraph\./g) ?? []).length === 1, 'Browser paragraph insert must be stored exactly once');
    assert((markdown.match(/Mike\s*\|\s*Producer/g) ?? []).length === 1, 'Browser table row insert must be stored exactly once');
    assertVisibleTableLayout(markdown, 'Accepted browser suggestion');

    const unsafeWarnings = context.warnings.filter((args) => {
      const details = args.find((arg) => arg && typeof arg === 'object') as { slug?: string } | undefined;
      return details?.slug === fixture.slug
        && (args[0] === '[collab] auto quarantined slug'
          || args[0] === '[collab] blocked unsafe projection write; keeping canonical DB projection');
    });
    assert(unsafeWarnings.length === 0, 'Browser accepts must not trip the projection guard or quarantine');
    assert(context.collab.getLiveCollabBlockStatus(fixture.slug).active === false, 'Browser accepts must leave live collab available');

    await page.close();
    page = await openBrowserEditor(browser, url);
    await page.waitForFunction(
      () => {
        const text = document.querySelector('.ProseMirror')?.textContent ?? '';
        return text.includes('Intro paragraph one. AI inline words.')
          && text.includes('Another AI paragraph.')
          && text.includes('Mike')
          && text.includes('Producer');
      },
      null,
      { timeout: 30_000 },
    );
  } finally {
    await page?.close().catch(() => {});
    await browser.close();
  }
}

async function runCombinedConnectedInsertResolutionCase(
  action: 'accept' | 'reject',
  context: {
    httpBase: string;
    db: typeof import('../../server/db.ts');
    collab: typeof import('../../server/collab.ts');
    schema: import('@milkdown/kit/prose/model').Schema;
    warnings: unknown[][];
  },
): Promise<void> {
  const fixture = await createInsertFixture(
    context.httpBase,
    `combined connected insert ${action}`,
    STRUCTURED_INSERT_MARKDOWN,
  );
  let client: ConnectedClient | null = await connectClient(context.httpBase, fixture.slug, fixture.ownerSecret);
  try {
    const initialState = await mustJson<{ markdown?: string }>(
      await fetch(`${context.httpBase}/api/agent/${fixture.slug}/state`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': fixture.ownerSecret },
      }),
      `combined ${action} initial state`,
    );
    const initialCanonicalMarkdown = initialState.markdown ?? '';
    const suggestions = [
      { quote: 'Intro paragraph one.', content: ' AI inline words.', structure: 'inline' },
      { quote: 'Closing paragraph.', content: '\n\nAnother AI paragraph.', structure: 'block' },
      { quote: 'Director', content: '\n| Mike | Producer |', structure: 'table_row' },
    ] as const;
    const markIds: string[] = [];
    for (const suggestion of suggestions) {
      const response = await mustJson<SuggestionResponse>(
        await postAgent(
          context.httpBase,
          fixture.slug,
          fixture.ownerSecret,
          '/marks/suggest-insert',
          { quote: suggestion.quote, content: suggestion.content, by: 'ai:test' },
        ),
        `combined ${action} ${suggestion.structure} insert`,
      );
      const markId = response.markId ?? '';
      assert(markId.length > 0, `Expected ${suggestion.structure} mark id`);
      markIds.push(markId);
      await waitFor(
        () => client !== null
          && client.doc.getMap('marks').has(markId)
          && (client.doc.getMap('marks').get(markId) as { insertStructure?: string } | undefined)?.insertStructure === suggestion.structure,
        10_000,
        `${suggestion.structure} pending mark in connected client`,
      );
    }

    const pendingText = readClientRoot(client, context.schema).textContent;
    assert(pendingText.includes('Intro paragraph one. AI inline words.'), 'Pending inline text must land');
    assert(pendingText.includes('Another AI paragraph.'), 'Pending final paragraph must land');
    assert(pendingText.includes('MikeProducer'), 'Pending table row must land');

    for (const markId of markIds) {
      assert(
        resolveSuggestionInConnectedClient(client, context.schema, markId, action),
        `Connected client ${action} must succeed for ${markId}`,
      );
    }

    await waitFor(
      () => markIds.every((markId) => !client?.doc.getMap('marks').has(markId)),
      10_000,
      `combined ${action} marks removed from connected client`,
    );
    await waitFor(
      () => {
        const row = context.db.getDocumentBySlug(fixture.slug);
        if (!row) return false;
        const marks = JSON.parse(row.marks ?? '{}') as Record<string, unknown>;
        return markIds.every((markId) => !Object.prototype.hasOwnProperty.call(marks, markId));
      },
      10_000,
      `combined ${action} marks removed from canonical row`,
    );

    const state = await mustJson<{
      markdown?: string;
      marks?: Record<string, unknown>;
      readSource?: string;
      projectionFresh?: boolean;
      mutationReady?: boolean;
      repairPending?: boolean;
    }>(
      await fetch(`${context.httpBase}/api/agent/${fixture.slug}/state`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': fixture.ownerSecret },
      }),
      `combined ${action} state`,
    );
    const markdown = state.markdown ?? '';
    assert(state.readSource === 'projection', `Combined ${action} must read from projection, got ${String(state.readSource)}`);
    assert(state.projectionFresh === true, `Combined ${action} projection must be fresh`);
    assert(state.mutationReady === true, `Combined ${action} must remain mutation-ready`);
    assert(state.repairPending !== true, `Combined ${action} must not queue repair`);
    for (const markId of markIds) {
      assert(!Object.prototype.hasOwnProperty.call(state.marks ?? {}, markId), `Resolved mark ${markId} must not remain pending`);
    }

    const expectedCounts = action === 'accept' ? 1 : 0;
    assert((markdown.match(/AI inline words\./g) ?? []).length === expectedCounts, `Combined ${action} inline count mismatch`);
    assert((markdown.match(/Another AI paragraph\./g) ?? []).length === expectedCounts, `Combined ${action} paragraph count mismatch`);
    assert((markdown.match(/Mike\s*\|\s*Producer/g) ?? []).length === expectedCounts, `Combined ${action} table-row count mismatch`);

    const milkdown = await import('../../server/milkdown-headless.js');
    const parser = await milkdown.getHeadlessMilkdownParser();
    const parsed = milkdown.parseMarkdownWithHtmlFallback(parser, markdown).doc;
    assert(parsed !== null, `Combined ${action} markdown must parse`);
    const table = findFirstNode(parsed, 'table');
    assert(table?.childCount === 3 + expectedCounts, `Combined ${action} table row count mismatch`);
    for (let index = 0; index < (table?.childCount ?? 0); index += 1) {
      assert(table?.child(index).childCount === 2, `Combined ${action} table row ${index} must keep two columns`);
    }
    if (action === 'reject') {
      assert(markdown === initialCanonicalMarkdown, 'Reject must restore the original canonical markdown');
      assert(!markdown.includes('AI inline words.'), 'Reject must remove inline insert');
      assert(!markdown.includes('Another AI paragraph.'), 'Reject must remove paragraph insert');
      assert(!markdown.includes('Mike'), 'Reject must remove table row insert');
    }

    const quarantineWarnings = context.warnings.filter((args) => {
      if (args[0] !== '[collab] auto quarantined slug') return false;
      const details = args[1] as { slug?: string } | undefined;
      return details?.slug === fixture.slug;
    });
    assert(quarantineWarnings.length === 0, `Combined ${action} must never auto-quarantine`);
    assert(context.collab.getLiveCollabBlockStatus(fixture.slug).active === false, `Combined ${action} live collab must remain available`);

    client.destroy();
    client = null;
    client = await connectClient(context.httpBase, fixture.slug, fixture.ownerSecret);
    assert(readClientRoot(client, context.schema).textContent === parsed.textContent, `Combined ${action} must reopen with identical text`);
  } finally {
    client?.destroy();
  }
}

async function runDisconnectedInsertCases(httpBase: string): Promise<void> {
  const createResponse = await fetch(`${httpBase}/api/documents`, {
    method: 'POST',
    headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Disconnected AI insert',
      markdown: 'Keep anchor here.',
      marks: {},
    }),
  });
  const created = await mustJson<CreatedDocument>(createResponse, 'create disconnected AI insert document');
  const insertedContent = ' pending words';
  const suggested = await mustJson<SuggestionResponse>(
    await postAgent(
      httpBase,
      created.slug,
      created.ownerSecret,
      '/marks/suggest-insert',
      { quote: 'anchor', content: insertedContent, by: 'ai:test' },
    ),
    'create disconnected AI insert suggestion',
  );
  const markId = suggested.markId ?? '';
  assert(markId.length > 0, 'Expected disconnected insert response to return its mark id');

  const pendingState = await mustJson<{
    markdown?: string;
    marks?: Record<string, { kind?: string; status?: string }>;
    projectionFresh?: boolean;
  }>(
    await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    }),
    'disconnected pending insert state',
  );
  assert(pendingState.markdown?.includes(`anchor${insertedContent}`) === true, 'Disconnected add should insert text');
  assert(pendingState.marks?.[markId]?.status === 'pending', 'Disconnected add should store a pending mark');
  assert(pendingState.projectionFresh === true, 'Disconnected add should leave /state projection fresh');

  await mustJson<Record<string, unknown>>(
    await postAgent(
      httpBase,
      created.slug,
      created.ownerSecret,
      '/marks/reject',
      { markId, by: 'human:test' },
    ),
    'reject disconnected AI insert',
  );
  const rejectedState = await mustJson<{ markdown?: string; projectionFresh?: boolean }>(
    await fetch(`${httpBase}/api/agent/${created.slug}/state`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    }),
    'disconnected rejected insert state',
  );
  assert(rejectedState.markdown === 'Keep anchor here.\n', 'Disconnected reject should remove inserted text');
  assert(rejectedState.projectionFresh === true, 'Disconnected reject should leave /state projection fresh');

  const legacyId = 'legacy-quote-anchored-insert';
  const legacyCreateResponse = await fetch(`${httpBase}/api/documents`, {
    method: 'POST',
    headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Legacy quote-anchored insert',
      markdown: 'Keep anchor here.',
      marks: {
        [legacyId]: {
          kind: 'insert',
          by: 'ai:test',
          createdAt: new Date('2026-09-14T00:00:00.000Z').toISOString(),
          quote: 'anchor',
          content: ' proposed',
          status: 'pending',
          startRel: 'char:5',
          endRel: 'char:11',
        },
      },
    }),
  });
  const legacy = await mustJson<CreatedDocument>(legacyCreateResponse, 'create legacy insert document');
  await mustJson<Record<string, unknown>>(
    await postAgent(
      httpBase,
      legacy.slug,
      legacy.ownerSecret,
      '/marks/accept',
      { markId: legacyId, by: 'human:test' },
    ),
    'accept legacy quote-anchored insert',
  );
  const legacyState = await mustJson<{ markdown?: string }>(
    await fetch(`${httpBase}/api/agent/${legacy.slug}/state`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': legacy.ownerSecret },
    }),
    'accepted legacy insert state',
  );
  assert(
    legacyState.markdown?.includes('Keep anchor proposed here.') === true,
    `Legacy insert accept should keep its anchor and append content, got ${JSON.stringify(legacyState.markdown)}`,
  );
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

  const [
    { apiRoutes },
    { agentRoutes },
    { setupWebSocket },
    collab,
    db,
    milkdown,
    { shareWebRoutes },
    { createBridgeMountRouter },
    { enforceApiClientCompatibility, enforceBridgeClientCompatibility },
  ] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
    import('../../server/db.js'),
    import('../../server/milkdown-headless.js'),
    import('../../server/share-web-routes.js'),
    import('../../server/bridge.js'),
    import('../../server/client-capabilities.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/assets', express.static(path.join(process.cwd(), 'dist', 'assets')));
  app.use(express.static(path.join(process.cwd(), 'public')));
  app.use('/api', enforceApiClientCompatibility, apiRoutes);
  app.use('/api/agent', agentRoutes);
  app.use(apiRoutes);
  app.use('/d', createBridgeMountRouter(enforceBridgeClientCompatibility));
  app.use('/documents', createBridgeMountRouter(enforceBridgeClientCompatibility));
  app.use('/documents', agentRoutes);
  app.use(shareWebRoutes);
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;
  await collab.startCollabRuntimeEmbedded(address.port);
  const parser = await milkdown.getHeadlessMilkdownParser();

  try {
    await runCombinedBrowserAcceptCase({
      httpBase,
      chromium: loadChromium(),
      db,
      collab,
      warnings,
    });
    await runDisconnectedInsertCases(httpBase);
    await runAiInsertCase({
      httpBase,
      db,
      schema: parser.schema,
    });
    await runStructuredAiInsertCases({
      httpBase,
      schema: parser.schema,
    });
    await runCombinedConnectedInsertResolutionCase('accept', {
      httpBase,
      db,
      collab,
      schema: parser.schema,
      warnings,
    });
    await runCombinedConnectedInsertResolutionCase('reject', {
      httpBase,
      db,
      collab,
      schema: parser.schema,
      warnings,
    });
    await runCase('reject', {
      httpBase,
      db,
      collab,
      parseMarkdown: parser.parseMarkdown,
      warnings,
    });
    await runCase('accept', {
      httpBase,
      db,
      collab,
      parseMarkdown: parser.parseMarkdown,
      warnings,
    });
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
