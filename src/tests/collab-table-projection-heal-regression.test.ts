// Regression: healCanonicalMarkdownForCollabFragment un-wedges an EXISTING doc
// that was created (before the write-time fix) with a raw GFM table. Such a doc
// stores raw canonical markdown that never matches the fragment serialization
// (the Milkdown GFM serializer pads columns and injects `:---` markers), so its
// projection is permanently stale and every agent mutation returns 409
// PROJECTION_STALE. The heal rewrites canonical to the fragment serialization so
// the two converge.
//
// The wedge condition is: markdown derived from the seeded Yjs fragment != the
// stored canonical markdown. That is exactly what the projection-repair and
// snapshot paths compare, so this test asserts on that derived form.

import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import * as Y from 'yjs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const dbName = `proof-collab-table-heal-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  const previousDbPath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = dbPath;

  const db = await import('../../server/db.ts');
  const collab = await import('../../server/collab.ts');
  const { getHeadlessMilkdownParser, serializeMarkdown } = await import('../../server/milkdown-headless.ts');
  const parser = await getHeadlessMilkdownParser();

  async function fragmentDerivedMarkdown(slug: string): Promise<string> {
    const handle = await collab.loadCanonicalYDoc(slug, {
      preferPersisted: true,
      allowFragmentRecovery: false,
    });
    assert(Boolean(handle), `Expected canonical Yjs handle for ${slug}`);
    const root = yXmlFragmentToProseMirrorRootNode(
      handle!.ydoc.getXmlFragment('prosemirror') as any,
      parser.schema as any,
    );
    try {
      return await serializeMarkdown(root as any);
    } finally {
      await handle?.cleanup?.();
    }
  }

  function parseMarks(raw: string): Record<string, unknown> {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  }

  function stableJson(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
      return `{${entries.join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function buildRestPutUpdate(markdown: string, marks: Record<string, unknown>): Uint8Array {
    const ydoc = new Y.Doc();
    try {
      ydoc.transact(() => {
        ydoc.getText('markdown').insert(0, markdown);
        const map = ydoc.getMap('marks');
        for (const [key, value] of Object.entries(marks)) {
          map.set(key, value);
        }
        const parsed = parser.parseMarkdown(markdown);
        prosemirrorToYXmlFragment(parsed as any, ydoc.getXmlFragment('prosemirror') as any);
      }, 'rest-put');
      return Y.encodeStateAsUpdate(ydoc);
    } finally {
      ydoc.destroy();
    }
  }

  try {
    // Case 1: persisted REST-style update exists, but fragment already equals the
    // normalized canonical form -> heal is safe and must preserve Yjs state.
    const slugEquivalent = `table-heal-equivalent-${Math.random().toString(36).slice(2, 8)}`;
    const equivalentRaw = [
      '# Heal Equivalent',
      '',
      '| A | B |',
      '| --- | --- |',
      '| one | two |',
      '| three | four |',
      '',
    ].join('\n');
    const equivalentMarks = {
      'c-1': { kind: 'comment', text: 'keep this mark', resolved: false },
      's-1': { kind: 'insert', status: 'pending', actor: 'agent' },
    };
    db.createDocument(slugEquivalent, equivalentRaw, equivalentMarks, 'table projection heal equivalent');
    const equivalentUpdate = buildRestPutUpdate(equivalentRaw, equivalentMarks);
    const equivalentSeq = db.appendYUpdate(slugEquivalent, equivalentUpdate, 'rest-put');
    db.saveYSnapshot(slugEquivalent, 1, equivalentUpdate);
    assert(
      db.updateDocument(slugEquivalent, equivalentRaw, equivalentMarks, equivalentSeq),
      'Precondition: expected canonical row y_state_version to advance for persisted REST-style update',
    );
    const equivalentUpdateMeta = db.getYUpdateMetaPage(slugEquivalent, null, 5);
    const equivalentUpdateSeqsBefore = db.getYUpdatesAfter(slugEquivalent, 0).map((entry) => entry.seq);
    assert(
      equivalentUpdateMeta.length === 1 && equivalentUpdateMeta[0]?.source_actor === 'rest-put',
      'Precondition: expected one persisted REST-style Yjs update',
    );

    const equivalentDerivedBefore = await fragmentDerivedMarkdown(slugEquivalent);
    const equivalentCanonicalBefore = db.getDocumentBySlug(slugEquivalent)?.markdown ?? '';
    assert(
      equivalentDerivedBefore !== equivalentCanonicalBefore,
      'Precondition: persisted-equivalent doc should start wedged (fragment serialization != canonical)',
    );

    const equivalentResult = await collab.healCanonicalMarkdownForCollabFragment(slugEquivalent);
    assert(equivalentResult.healed, `Expected persisted-equivalent heal to run, got reason=${equivalentResult.reason}`);
    assert(
      equivalentResult.reason === 'normalized_persisted_equivalent',
      `Expected persisted-equivalent heal reason, got ${equivalentResult.reason}`,
    );

    const equivalentDerivedAfter = await fragmentDerivedMarkdown(slugEquivalent);
    const equivalentRowAfter = db.getDocumentBySlug(slugEquivalent);
    assert(Boolean(equivalentRowAfter), 'Expected persisted-equivalent row after heal');
    const equivalentCanonicalAfter = equivalentRowAfter?.markdown ?? '';
    assert(
      equivalentDerivedAfter === equivalentCanonicalAfter,
      `Persisted-equivalent heal must converge canonical and fragment.\nCanonical:\n${JSON.stringify(equivalentCanonicalAfter)}\n\nDerived:\n${JSON.stringify(equivalentDerivedAfter)}`,
    );
    assert(
      equivalentCanonicalAfter.includes('one') && equivalentCanonicalAfter.includes('four'),
      'Persisted-equivalent heal must preserve table content',
    );
    assert(
      stableJson(parseMarks(equivalentRowAfter?.marks ?? '{}')) === stableJson(equivalentMarks),
      'Persisted-equivalent heal must preserve canonical marks exactly',
    );
    const equivalentProjection = db.getDocumentProjectionBySlug(slugEquivalent);
    assert(Boolean(equivalentProjection), 'Expected persisted-equivalent projection row after heal');
    assert(
      stableJson(parseMarks(equivalentProjection?.marks_json ?? '{}')) === stableJson(equivalentMarks),
      'Persisted-equivalent heal must preserve projection marks exactly',
    );
    const equivalentUpdatesAfter = db.getYUpdatesAfter(slugEquivalent, 0);
    const equivalentSnapshotAfter = db.getLatestYSnapshot(slugEquivalent);
    assert(
      equivalentUpdatesAfter.length >= equivalentUpdateSeqsBefore.length
        && equivalentUpdateSeqsBefore.every((seq) => equivalentUpdatesAfter.some((update) => update.seq === seq))
        && equivalentUpdatesAfter.some((update) => update.seq === equivalentSeq),
      'Persisted-equivalent heal must preserve existing persisted Yjs updates',
    );
    assert(
      equivalentSnapshotAfter?.version === 1,
      'Persisted-equivalent heal must not clear persisted Yjs snapshots',
    );
    const equivalentReadable = collab.getCanonicalReadableDocumentSync(slugEquivalent, 'snapshot');
    assert(Boolean(equivalentReadable), 'Expected a readable persisted-equivalent document post-heal');
    assert(
      (equivalentReadable as any).read_source === 'projection' && (equivalentReadable as any).mutation_ready === true,
      `Persisted-equivalent post-heal read must be fresh + writable. read_source=${(equivalentReadable as any)?.read_source} mutation_ready=${(equivalentReadable as any)?.mutation_ready}`,
    );

    // Case 2: persisted update contains real edits not reflected in canonical ->
    // skip with fragment_differs and change nothing.
    const slugDiffers = `table-heal-differs-${Math.random().toString(36).slice(2, 8)}`;
    const differsRaw = [
      '# Heal Differs',
      '',
      '| K | V |',
      '| --- | --- |',
      '| base | row |',
      '',
    ].join('\n');
    const differsMarks = { 'c-2': { kind: 'comment', text: 'mark to preserve', resolved: false } };
    db.createDocument(slugDiffers, differsRaw, differsMarks, 'table projection heal differs');
    const differsCanonicalBefore = db.getDocumentBySlug(slugDiffers)?.markdown ?? '';
    const differsProjectionBefore = db.getDocumentProjectionBySlug(slugDiffers);
    const differsUpdate = buildRestPutUpdate(
      `${differsRaw}\nReal live edit line.\n`,
      differsMarks,
    );
    const differsSeq = db.appendYUpdate(slugDiffers, differsUpdate, 'rest-put');
    db.saveYSnapshot(slugDiffers, 1, differsUpdate);
    assert(
      db.updateDocument(slugDiffers, differsRaw, differsMarks, differsSeq),
      'Precondition: expected differing canonical row y_state_version to advance for persisted update',
    );

    const differsResult = await collab.healCanonicalMarkdownForCollabFragment(slugDiffers);
    assert(!differsResult.healed, 'Expected differing-fragment doc to be skipped');
    assert(
      differsResult.reason === 'fragment_differs',
      `Expected differing-fragment skip reason=fragment_differs, got ${differsResult.reason}`,
    );
    const differsRowAfter = db.getDocumentBySlug(slugDiffers);
    const differsProjectionAfter = db.getDocumentProjectionBySlug(slugDiffers);
    assert(
      (differsRowAfter?.markdown ?? '') === differsCanonicalBefore,
      'Differing-fragment skip must not rewrite canonical markdown',
    );
    assert(
      (differsProjectionAfter?.markdown ?? '') === (differsProjectionBefore?.markdown ?? ''),
      'Differing-fragment skip must not rewrite projection markdown',
    );
    assert(
      stableJson(parseMarks(differsRowAfter?.marks ?? '{}')) === stableJson(differsMarks),
      'Differing-fragment skip must preserve canonical marks',
    );

    // Case 3: seed-only wedged doc still heals (legacy path unchanged).
    const slugSeedOnly = `table-heal-seed-only-${Math.random().toString(36).slice(2, 8)}`;
    const seedOnlyRaw = [
      '# Heal Seed Only',
      '',
      '| A | B |',
      '| --- | --- |',
      '| left | right |',
      '',
    ].join('\n');
    db.createDocument(slugSeedOnly, seedOnlyRaw, {}, 'table projection heal seed only');
    const seedOnlyDerivedBefore = await fragmentDerivedMarkdown(slugSeedOnly);
    const seedOnlyCanonicalBefore = db.getDocumentBySlug(slugSeedOnly)?.markdown ?? '';
    assert(
      seedOnlyDerivedBefore !== seedOnlyCanonicalBefore,
      'Precondition: seed-only raw-table doc should start wedged',
    );
    assert(
      db.getYUpdatesAfter(slugSeedOnly, 0).length === 0,
      'Precondition: seed-only case should have no persisted incremental updates',
    );

    const seedOnlyResult = await collab.healCanonicalMarkdownForCollabFragment(slugSeedOnly);
    assert(seedOnlyResult.healed, `Expected seed-only heal to run, got reason=${seedOnlyResult.reason}`);
    assert(
      seedOnlyResult.reason === 'normalized_seed_only',
      `Expected seed-only heal reason, got ${seedOnlyResult.reason}`,
    );
    const seedOnlyDerivedAfter = await fragmentDerivedMarkdown(slugSeedOnly);
    const seedOnlyCanonicalAfter = db.getDocumentBySlug(slugSeedOnly)?.markdown ?? '';
    assert(
      seedOnlyDerivedAfter === seedOnlyCanonicalAfter,
      'Seed-only heal must converge canonical and fragment serialization',
    );
    const seedOnlyReadable = collab.getCanonicalReadableDocumentSync(slugSeedOnly, 'snapshot');
    assert(Boolean(seedOnlyReadable), 'Expected readable seed-only document post-heal');
    assert(
      (seedOnlyReadable as any).read_source === 'projection' && (seedOnlyReadable as any).mutation_ready === true,
      `Seed-only post-heal read must be fresh + writable. read_source=${(seedOnlyReadable as any)?.read_source} mutation_ready=${(seedOnlyReadable as any)?.mutation_ready}`,
    );
    const seedOnlySecond = await collab.healCanonicalMarkdownForCollabFragment(slugSeedOnly);
    assert(!seedOnlySecond.healed && seedOnlySecond.reason === 'already_canonical', 'Seed-only second heal should be a no-op');

    console.log('✓ heal handles persisted-equivalent, persisted-different, and seed-only wedge cases');
  } finally {
    if (previousDbPath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDbPath;
    }
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
