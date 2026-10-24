import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';

// Compaction (server/collab.ts) used to snapshot cloneAuthoritativeDocState(ydoc),
// which allocates a new Y.Doc clientID. The update just appended at that same seq
// is a self-contained state of a different lineage. Loaders then call
// getYUpdatesAtOrAfter(snapshot.version), so the update is applied on top of the
// unrelated snapshot and the text doubles. The seed baseline saves a snapshot at
// version 1 with no update row; the first later edit can land at seq 1 and must
// still be replayed. This file fails on the clone snapshot and passes once the
// snapshot shares the update's lineage.

const COMPACTION_MAX_BYTES = 4_096;
const temp = mkdtempSync(path.join(tmpdir(), 'proof-compaction-lineage-'));
Object.assign(process.env, {
  DATABASE_PATH: path.join(temp, 'test.db'),
  PROOF_ENV: 'test',
  PROOF_DB_ENV_INIT: 'test',
  COLLAB_COMPACTION_MAX_BYTES: String(COMPACTION_MAX_BYTES),
  COLLAB_COMPACTION_EVERY: '100000',
  // Prime attaches a debounced persist listener. Keep it from racing the explicit persists.
  COLLAB_PERSIST_DEBOUNCE_MS: '120000',
});

const db = await import('../../server/db.ts');
const collab = await import('../../server/collab.ts');
const { getHeadlessMilkdownParser, parseMarkdownWithHtmlFallback } = await import('../../server/milkdown-headless.ts');

function assertSameText(actual: string, expected: string, label: string): void {
  assert.equal(
    actual.length,
    expected.length,
    `${label}: replay length ${actual.length} vs row length ${expected.length}`,
  );
  assert.equal(actual, expected, label);
}

function markdownFromUpdate(snapshot: Uint8Array | null, updates: Array<{ update: Uint8Array }>): string {
  const doc = new Y.Doc();
  try {
    if (snapshot && snapshot.byteLength > 0) Y.applyUpdate(doc, snapshot);
    for (const entry of updates) Y.applyUpdate(doc, entry.update);
    return doc.getText('markdown').toString();
  } finally {
    doc.destroy();
  }
}

function loaderMarkdown(slug: string): string {
  const persisted = collab.__unsafeReadPersistedDocStateSyncForTests(slug);
  assert.equal(persisted.degradedReason, null, `${slug} replay degraded: ${String(persisted.degradedReason)}`);
  return persisted.ydoc.getText('markdown').toString();
}

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

function appendMarkdown(ydoc: Y.Doc, marker: string): void {
  // A markdown-mirror edit, the same shape as a persisted collab delta. Persist
  // derives the fragment from this text; the Y.Text is what replay compares.
  ydoc.transact(() => {
    const text = ydoc.getText('markdown');
    const prefix = text.toString().endsWith('\n') ? '\n' : '\n\n';
    text.insert(text.length, `${prefix}${marker}\n`);
  }, 'test-small-delta');
}

try {
  const seedSlug = 'seed-snapshot-lineage';
  const seedMarker = 'seed-edit-marker-q7';
  const seedDoc = await buildMatchingDoc('Seed baseline paragraph.\n\nSecond seed paragraph.');
  db.createDocument(seedSlug, seedDoc.markdown, {}, 'seed snapshot lineage');
  seedDoc.ydoc.destroy();
  const seeded = await collab.ensureCanonicalYjsBaselineForDocument(seedSlug);
  assert.equal(seeded, true, 'expected a legacy row with no Yjs history to seed a snapshot');
  const seedSnapshot = db.getLatestYSnapshot(seedSlug);
  assert.ok(seedSnapshot, 'expected the seed snapshot');
  assert.equal(seedSnapshot.version, 1, 'seed baseline is stored at snapshot version 1');
  assert.equal(db.getYUpdatesAfter(seedSlug, 0).length, 0, 'seeding must not write an update row');

  const loadedSeed = await collab.loadCanonicalYDoc(seedSlug, { preferPersisted: true });
  assert.ok(loadedSeed, 'expected the seeded doc to hydrate');
  appendMarkdown(loadedSeed.ydoc, seedMarker);
  await collab.__unsafePersistDocAwaitForTests(seedSlug, loadedSeed.ydoc, 'collab');

  const seedUpdatesAtSnapshot = db.getYUpdatesAtOrAfter(seedSlug, seedSnapshot.version);
  assert.ok(seedUpdatesAtSnapshot.some((entry) => entry.seq === seedSnapshot.version), 'first edit collides with seed snapshot version');
  assert.equal(
    db.getYUpdatesAfter(seedSlug, seedSnapshot.version).some((entry) => entry.seq === seedSnapshot.version),
    false,
    'strictly-after the seed version drops the colliding edit',
  );
  const seedRow = db.getDocumentBySlug(seedSlug);
  assert.ok(seedRow, 'expected the seed row');
  assert.ok(seedRow.markdown.includes(seedMarker), 'seed edit must reach the row');
  const seedReplay = loaderMarkdown(seedSlug);
  assert.ok(seedReplay.includes(seedMarker), 'seed replay must include the edit stored at the snapshot version');
  assertSameText(seedReplay, seedRow.markdown, 'seed snapshot plus at-or-after updates');
  const seedAsync = await collab.__unsafeReadPersistedDocStateAsyncForTests(seedSlug);
  assertSameText(seedAsync.ydoc.getText('markdown').toString(), seedRow.markdown, 'async seed replay');
  console.log('✓ seed snapshot version collides with the first update seq and replay keeps the edit');

  const slug = 'compaction-snapshot-lineage';
  const paragraphs: string[] = [];
  for (let i = 0; i < 80; i += 1) {
    paragraphs.push(`Paragraph ${i} carries unique compaction text ${'x'.repeat(80)} ${i}.`);
  }
  const built = await buildMatchingDoc(paragraphs.join('\n\n'));
  db.createDocument(slug, built.markdown, {}, 'compaction snapshot lineage');
  // Prime an empty loaded doc so the authoritative baseline has no content, then
  // apply the full document. Persist encodes that as one self-contained update,
  // the same shape as the 870KB collab update that tripped compaction.
  const live = new Y.Doc();
  collab.__unsafePrimeLoadedDocForTests(slug, live);
  Y.applyUpdate(live, Y.encodeStateAsUpdate(built.ydoc));
  built.ydoc.destroy();
  await collab.__unsafePersistDocAwaitForTests(slug, live, 'collab');

  const updates = db.getYUpdatesAfter(slug, 0);
  assert.equal(updates.length, 1, `expected one self-contained collab update, saw ${updates.length}`);
  const compacted = updates[0];
  assert.ok(
    compacted.update.byteLength >= COMPACTION_MAX_BYTES,
    `expected the update to cross the compaction threshold, bytes=${compacted.update.byteLength}`,
  );
  const snapshot = db.getLatestYSnapshot(slug);
  assert.ok(snapshot, 'expected compaction to write a snapshot');
  assert.equal(snapshot.version, compacted.seq, 'compaction snapshot version is the update seq');
  const loadedForReplay = db.getYUpdatesAtOrAfter(slug, snapshot.version);
  assert.equal(loadedForReplay.length, 1, 'loader at-or-after includes the compacted update');
  assert.equal(loadedForReplay[0].seq, snapshot.version);

  const row = db.getDocumentBySlug(slug);
  assert.ok(row, 'expected the compacted row');
  assert.equal(row.markdown.length, built.markdown.length, 'row keeps the single copy written by persist');
  const snapshotOnly = markdownFromUpdate(snapshot.snapshot, []);
  const updateOnly = markdownFromUpdate(null, [compacted]);
  assertSameText(snapshotOnly, row.markdown, 'snapshot alone');
  assertSameText(updateOnly, row.markdown, 'compacted update alone');
  assertSameText(loaderMarkdown(slug), row.markdown, 'snapshot plus the updates the loader fetches');
  const asyncReplay = await collab.__unsafeReadPersistedDocStateAsyncForTests(slug);
  assertSameText(asyncReplay.ydoc.getText('markdown').toString(), row.markdown, 'async loader replay');
  console.log('✓ large self-contained update replays once from the compaction snapshot');

  const tailMarker = 'tail-after-snapshot-m4';
  // A later edit must stay an update after the snapshot. Fragment sync can
  // rewrite the whole fragment, so lift the byte threshold before this persist;
  // the case under test is replay of that later update, not a second compaction.
  process.env.COLLAB_COMPACTION_MAX_BYTES = '50000000';
  appendMarkdown(live, tailMarker);
  await collab.__unsafePersistDocAwaitForTests(slug, live, 'collab');

  const snapshotAfterTail = db.getLatestYSnapshot(slug);
  assert.ok(snapshotAfterTail, 'expected the compaction snapshot to remain');
  assert.equal(snapshotAfterTail.version, snapshot.version, 'a later edit below the compaction threshold must not replace the snapshot');
  const afterTail = db.getYUpdatesAfter(slug, snapshot.version);
  assert.equal(afterTail.length, 1, 'expected one delta strictly after the snapshot');
  const snapshotWithoutTail = markdownFromUpdate(snapshotAfterTail.snapshot, []);
  assert.equal(snapshotWithoutTail.includes(tailMarker), false, 'the compaction snapshot does not contain the later edit');
  const tailRow = db.getDocumentBySlug(slug);
  assert.ok(tailRow, 'expected the row after the small delta');
  assert.equal(tailRow.markdown.split(tailMarker).length - 1, 1, 'row contains the tail once');
  const tailReplay = loaderMarkdown(slug);
  assert.equal(tailReplay.split(tailMarker).length - 1, 1, 'replay contains the tail once');
  assertSameText(tailReplay, tailRow.markdown, 'small delta after a compaction snapshot');
  console.log('✓ small delta after a compaction snapshot replays onto the same lineage');
} finally {
  await collab.stopCollabRuntime();
  try {
    db.getDb().close();
  } catch {
    // ignore close races during teardown
  }
  rmSync(temp, { recursive: true, force: true });
}
