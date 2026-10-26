/**
 * persistDoc's derive-failure skip writes the Yjs update and advances
 * documents.y_state_version, but it does not quarantine the projection and
 * it does not write projection content. The projection y_state_version must
 * stay behind so isProjectionFresh does not treat the lagging markdown as current.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-derive-failure-version-'));
Object.assign(process.env, {
  DATABASE_PATH: path.join(temp, 'test.db'),
  PROOF_ENV: 'test',
  PROOF_DB_ENV_INIT: 'test',
  COLLAB_PERSIST_DEBOUNCE_MS: '120000',
  COLLAB_PROJECTION_REPAIR_RETRY_SCHEDULE_MS: '120000',
});

const db = await import('../../server/db.ts');
const collab = await import('../../server/collab.ts');
const { getHeadlessMilkdownParser, parseMarkdownWithHtmlFallback } = await import('../../server/milkdown-headless.ts');

const SLUG = 'derive-failure-projection-version';
const SOURCE_MARKDOWN = 'Derive failure keeps the projection version behind.';

async function buildMatchingDoc(sourceMarkdown: string): Promise<{ ydoc: Y.Doc; markdown: string }> {
  const parser = await getHeadlessMilkdownParser();
  const parsed = parseMarkdownWithHtmlFallback(parser, sourceMarkdown);
  assert.ok(parsed.doc, 'expected the headless parser to accept the fixture markdown');
  const canonical = await collab.deriveCanonicalMarkdownFromProseMirrorDoc(parsed.doc);
  assert.equal(typeof canonical, 'string', 'expected canonical markdown from the fixture fragment');
  const ydoc = new Y.Doc();
  ydoc.transact(() => {
    prosemirrorToYXmlFragment(parsed.doc as any, ydoc.getXmlFragment('prosemirror') as any);
    ydoc.getText('markdown').insert(0, canonical as string);
  }, 'test-seed');
  return { ydoc, markdown: canonical as string };
}

try {
  const built = await buildMatchingDoc(SOURCE_MARKDOWN);
  db.createDocument(SLUG, built.markdown, {}, 'Derive failure version');
  built.ydoc.destroy();
  const seeded = await collab.ensureCanonicalYjsBaselineForDocument(SLUG);
  assert.equal(seeded, true, 'expected a Yjs baseline so persist has a delta to append');

  const loaded = await collab.loadCanonicalYDoc(SLUG, { preferPersisted: true });
  assert.ok(loaded, 'expected the seeded doc to hydrate');

  const firstMarker = 'first-edit-lands-in-projection';
  const secondMarker = 'second-edit-must-not-advance-projection-version';
  loaded.ydoc.transact(() => {
    const text = loaded.ydoc.getText('markdown');
    text.insert(text.length, `\n\n${firstMarker}`);
  }, 'test-first-delta');
  await collab.__unsafePersistDocAwaitForTests(SLUG, loaded.ydoc, 'collab');

  const afterFirst = db.getDocumentProjectionBySlug(SLUG);
  const documentAfterFirst = db.getDocumentBySlug(SLUG);
  assert.ok(afterFirst && documentAfterFirst, 'expected a projection after the successful persist');
  assert.equal(afterFirst.health, 'healthy', `Expected the first persist to leave the projection healthy, got ${afterFirst.health}`);
  assert.equal(afterFirst.markdown.includes(firstMarker), true, 'Expected the first persist to write projection content');
  assert.equal(
    afterFirst.y_state_version,
    documentAfterFirst.y_state_version,
    'Expected the first persist to keep projection and document versions aligned',
  );
  const projectionVersionBeforeFailure = afterFirst.y_state_version;
  const markdownBeforeFailure = afterFirst.markdown;

  loaded.ydoc.transact(() => {
    const text = loaded.ydoc.getText('markdown');
    text.insert(text.length, `\n\n${secondMarker}`);
  }, 'test-derive-failure-delta');

  process.env.COLLAB_FORCE_DERIVE_FRAGMENT_MARKDOWN_FAILURE = '1';
  try {
    await collab.__unsafePersistDocAwaitForTests(SLUG, loaded.ydoc, 'collab');
  } finally {
    delete process.env.COLLAB_FORCE_DERIVE_FRAGMENT_MARKDOWN_FAILURE;
  }

  const document = db.getDocumentBySlug(SLUG);
  const projection = db.getDocumentProjectionBySlug(SLUG);
  assert.ok(document && projection, 'expected the document and projection after persist');
  assert.ok(
    document.y_state_version > projectionVersionBeforeFailure,
    `Expected documents.y_state_version to advance past ${projectionVersionBeforeFailure}, got ${document.y_state_version}`,
  );
  assert.equal(
    projection.y_state_version,
    projectionVersionBeforeFailure,
    `Expected derive failure to leave projection y_state_version at ${projectionVersionBeforeFailure}, got ${projection.y_state_version}`,
  );
  assert.notEqual(
    projection.y_state_version,
    document.y_state_version,
    'Expected the projection version to lag the document after a content-less derive failure',
  );
  assert.equal(projection.markdown, markdownBeforeFailure, 'Expected derive failure to leave projection markdown unchanged');
  assert.equal(projection.markdown.includes(secondMarker), false, 'Expected the failed derive not to write the new edit into the projection');
  assert.equal(projection.health, 'projection_stale', `Expected derive failure to mark the projection stale, got ${projection.health}`);
  assert.notEqual(projection.health, 'quarantined', 'Derive failure does not quarantine the row before the version bump');
  assert.equal(
    collab.isProjectionFresh(db.getProjectedDocumentBySlug(SLUG)),
    false,
    'Expected the lagging projection to stay not fresh',
  );

  console.log('✓ derive-failure persist advances documents.y_state_version without the projection version');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
