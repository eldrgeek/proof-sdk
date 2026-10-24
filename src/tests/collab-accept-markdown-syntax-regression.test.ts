import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EditorState, Plugin } from '@milkdown/kit/prose/state';
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import * as Y from 'yjs';

import { getHeadlessMilkdownParser, serializeMarkdown } from '../../server/milkdown-headless.js';
import { setCurrentActor } from '../editor/actor.js';
import { createAuthoredTrackerPlugin } from '../editor/plugins/authored-tracker.js';
import {
  getMarkMetadataWithQuotes,
  marksPluginKey,
} from '../editor/plugins/marks.js';
import { wrapTransactionForSuggestions } from '../editor/plugins/suggestions.js';

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

async function buildPendingInsert(
  baseMarkdown: string,
  content: string,
): Promise<{
  markdown: string;
  marks: Record<string, unknown>;
  markId: string;
  doc: ProseMirrorNode;
}> {
  const parser = await getHeadlessMilkdownParser();
  const authoredPlugin = createAuthoredTrackerPlugin();
  let state = EditorState.create({
    schema: parser.schema,
    doc: parser.parseMarkdown(baseMarkdown),
    plugins: [authoredPlugin, createMarksStatePlugin()],
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(tr: import('@milkdown/kit/prose/state').Transaction) {
      state = state.applyTransaction(tr).state;
    },
  };
  let cursor = state.doc.content.size - 1;
  for (const character of content) {
    (authoredPlugin.props.handleTextInput as any)?.(view, cursor, cursor, character);
    const wrapped = wrapTransactionForSuggestions(
      state.tr.insertText(character, cursor),
      state,
      true,
    );
    state = state.applyTransaction(wrapped).state;
    cursor += character.length;
  }

  const marks = getMarkMetadataWithQuotes(state);
  const markId = Object.keys(marks).find((id) => marks[id]?.kind === 'insert');
  assert(markId, 'Expected key-by-key typing to create an insert suggestion');
  return {
    markdown: await serializeMarkdown(state.doc),
    marks,
    markId,
    doc: state.doc,
  };
}

async function serializeFragment(
  ydoc: import('yjs').Doc,
  schema: import('@milkdown/kit/prose/model').Schema,
): Promise<string> {
  const root = yXmlFragmentToProseMirrorRootNode(
    ydoc.getXmlFragment('prosemirror') as any,
    schema as any,
  ) as ProseMirrorNode;
  return serializeMarkdown(root);
}

async function run(): Promise<void> {
  const dbName = `proof-collab-accept-markdown-syntax-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  const previousDbPath = process.env.DATABASE_PATH;
  const previousProofEnv = process.env.PROOF_ENV;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousDbEnvInit = process.env.PROOF_DB_ENV_INIT;

  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_ENV = 'development';
  process.env.NODE_ENV = 'development';
  delete process.env.PROOF_DB_ENV_INIT;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');
  const { executeDocumentOperationAsync } = await import('../../server/document-engine.ts');

  const actor = `human:markdown-syntax-${Date.now()}`;
  const baseMarkdown = 'The second act needs one more scene.';
  const acceptedText = ' [bracketed *text*]';
  setCurrentActor(actor);

  try {
    const liveStoredShape = `${baseMarkdown} <span data-proof="authored" data-proof-id="authored:${actor}:36-54" data-by="${actor}">[bracketed *text*]</span>\n`;
    const liveStoredFixedPoint = await collab.deriveCanonicalMarkdownForStorage(liveStoredShape);
    assert(
      liveStoredFixedPoint !== liveStoredShape,
      `Precondition: the accepted authored-span serialization must differ from the fragment fixed point.\nStored shape: ${JSON.stringify(liveStoredShape)}\nFixed point: ${JSON.stringify(liveStoredFixedPoint)}`,
    );

    const pending = await buildPendingInsert(baseMarkdown, acceptedText);
    const visibleAcceptedText = '[bracketed text]';
    const visibleStart = baseMarkdown.length;
    pending.marks[pending.markId] = {
      ...(pending.marks[pending.markId] as Record<string, unknown>),
      quote: visibleAcceptedText,
      range: { from: visibleStart + 1, to: visibleStart + 1 + visibleAcceptedText.length + 1 },
      startRel: `char:${visibleStart}`,
      endRel: `char:${visibleStart + visibleAcceptedText.length + 1}`,
    };
    const slug = `accept-markdown-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(slug, pending.markdown, pending.marks, 'accept markdown syntax');

    const liveYDoc = new Y.Doc();
    liveYDoc.transact(() => {
      liveYDoc.getText('markdown').insert(0, pending.markdown);
      for (const [id, mark] of Object.entries(pending.marks)) {
        liveYDoc.getMap('marks').set(id, mark);
      }
      prosemirrorToYXmlFragment(pending.doc as any, liveYDoc.getXmlFragment('prosemirror') as any);
    }, 'test-pending-suggestion');
    const pendingUpdate = Y.encodeStateAsUpdate(liveYDoc);
    const pendingVersion = db.appendYUpdate(slug, pendingUpdate, 'test-pending-suggestion');
    db.saveYSnapshot(slug, pendingVersion, pendingUpdate);
    db.getDb().prepare('UPDATE documents SET y_state_version = ? WHERE slug = ?')
      .run(pendingVersion, slug);
    db.getDb().prepare('UPDATE document_projections SET y_state_version = ? WHERE document_slug = ?')
      .run(pendingVersion, slug);

    const parser = await getHeadlessMilkdownParser();
    const locallyAccepted = parser.parseMarkdown(
      `${baseMarkdown} \\[bracketed *text*\\]\n`,
    );
    liveYDoc.transact(() => {
      const fragment = liveYDoc.getXmlFragment('prosemirror');
      if (fragment.length > 0) fragment.delete(0, fragment.length);
      prosemirrorToYXmlFragment(locallyAccepted as any, fragment as any);
    }, 'test-local-first-accept');
    collab.__unsafePrimeLoadedDocForTests(slug, liveYDoc);

    const pendingRow = db.getDocumentBySlug(slug);
    assert(pendingRow, 'Expected pending suggestion row');

    const accepted = await executeDocumentOperationAsync(slug, 'POST', '/marks/accept', {
      markId: pending.markId,
      by: actor,
    }, {
      doc: {
        ...pendingRow,
        plain_text: pendingRow.markdown,
      },
      mutationBase: {
        token: 'test-pending-suggestion-base',
        source: 'canonical_row',
        schemaVersion: collab.MUTATION_BASE_SCHEMA_VERSION,
        markdown: pendingRow.markdown,
        marks: pending.marks,
        accessEpoch: pendingRow.access_epoch,
      },
      precondition: {
        mode: 'revision',
        baseRevision: pendingRow.revision,
      },
    });
    assert(
      accepted.status === 200,
      `Expected markdown-syntax accept to succeed, got ${accepted.status}: ${JSON.stringify(accepted.body)}\nPending markdown: ${JSON.stringify(pending.markdown)}\nPending marks: ${JSON.stringify(pending.marks)}`,
    );

    const persistedHandle = await collab.loadCanonicalYDoc(slug, {
      preferPersisted: true,
      allowFragmentRecovery: false,
    });
    assert(persistedHandle, 'Expected persisted canonical Yjs document after accept');
    const storedAfterAccept = db.getDocumentBySlug(slug)?.markdown ?? '';
    const fragmentAfterAccept = await serializeFragment(persistedHandle.ydoc, parser.schema);
    assert(
      storedAfterAccept === fragmentAfterAccept,
      `Accepted markdown must equal the fragment serialization.\nStored: ${JSON.stringify(storedAfterAccept)}\nFragment: ${JSON.stringify(fragmentAfterAccept)}`,
    );
    assert(
      storedAfterAccept === await serializeFragment(liveYDoc, parser.schema),
      'Accepted markdown must also equal the locally finalized live fragment',
    );
    assert(
      storedAfterAccept.includes('\\[bracketed *text*]'),
      `Expected literal brackets to be escaped in canonical markdown, got ${JSON.stringify(storedAfterAccept)}`,
    );
    assert(
      !storedAfterAccept.includes('data-proof="authored"'),
      'Expected storage to preserve the local fragment shape instead of replacing it with server-authored HTML',
    );
    const marksAfterAccept = JSON.parse(db.getDocumentBySlug(slug)?.marks ?? '{}') as Record<string, { kind?: string }>;
    assert(
      Object.values(marksAfterAccept).some((mark) => mark.kind === 'authored'),
      'Expected accepted authorship metadata to remain stored even when the local fragment has no authored HTML span',
    );

    const readableAfterAccept = await collab.getCanonicalReadableDocument(slug, 'state');
    assert(
      readableAfterAccept?.read_source === 'projection'
        && readableAfterAccept.projection_fresh === true
        && readableAfterAccept.mutation_ready === true,
      `Accept must leave the document fresh and writable; got ${JSON.stringify({
        readSource: readableAfterAccept?.read_source,
        projectionFresh: readableAfterAccept?.projection_fresh,
        mutationReady: readableAfterAccept?.mutation_ready,
        fallbackReason: readableAfterAccept?.read_fallback_reason,
      })}`,
    );

    const laterEdit = ' Later edit persisted.';
    const root = yXmlFragmentToProseMirrorRootNode(
      liveYDoc.getXmlFragment('prosemirror') as any,
      parser.schema as any,
    ) as ProseMirrorNode;
    const lastTextPosition = root.content.size - 1;
    const editedRoot = root.type.create(
      root.attrs,
      root.content,
      root.marks,
    );
    const transactionState = EditorState.create({ schema: parser.schema, doc: editedRoot });
    const editedDoc = transactionState.tr.insertText(laterEdit, lastTextPosition).doc;
    liveYDoc.transact(() => {
      const fragment = liveYDoc.getXmlFragment('prosemirror');
      if (fragment.length > 0) fragment.delete(0, fragment.length);
      // The collab persistence test helper consumes the same fragment shape as a browser edit.
      void fragment;
    }, 'test-clear-fragment');
    liveYDoc.transact(() => {
      prosemirrorToYXmlFragment(editedDoc as any, liveYDoc.getXmlFragment('prosemirror') as any);
    }, 'test-later-browser-edit');
    const liveAfterLaterEdit = await serializeFragment(liveYDoc, parser.schema);
    assert(
      liveAfterLaterEdit.includes(laterEdit),
      `Expected the test browser edit in the live fragment, got ${JSON.stringify(liveAfterLaterEdit)}`,
    );
    await collab.__unsafePersistDocAwaitForTests(slug, liveYDoc, 'collab');

    const storedAfterLaterEdit = db.getDocumentBySlug(slug)?.markdown ?? '';
    assert(
      storedAfterLaterEdit.includes(laterEdit),
      `Expected a later fragment edit to persist to canonical markdown, got ${JSON.stringify(storedAfterLaterEdit)}`,
    );
    assert(
      storedAfterLaterEdit === await serializeFragment(liveYDoc, parser.schema),
      'Expected the later persisted edit to keep canonical markdown equal to the fragment',
    );

    await persistedHandle.cleanup?.();
    console.log('✓ accepting markdown syntax stays fragment-canonical and later edits persist');
  } finally {
    if (previousDbPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDbPath;
    if (previousProofEnv === undefined) delete process.env.PROOF_ENV;
    else process.env.PROOF_ENV = previousProofEnv;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousDbEnvInit === undefined) delete process.env.PROOF_DB_ENV_INIT;
    else process.env.PROOF_DB_ENV_INIT = previousDbEnvInit;

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

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
