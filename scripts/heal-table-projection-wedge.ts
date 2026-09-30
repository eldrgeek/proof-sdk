#!/usr/bin/env tsx
// One-time heal for documents wedged by the table-projection bug.
//
// Documents created before the write-time markdown normalization fix store raw
// canonical markdown that never matches the collab fragment's serialization
// (the Milkdown GFM serializer pads table columns and injects `:---` alignment
// markers). Such docs are stuck on readSource=yjs_fallback / mutationReady=false:
// agent mutations return 409 PROJECTION_STALE and browser edits are dropped.
//
// This script rewrites each affected doc's canonical markdown to the fragment
// serialization so the projection converges. It is idempotent — already-canonical
// docs are skipped — so it is safe to re-run.
//
// Usage (run with the server stopped to avoid write contention):
//   DATABASE_PATH=$HOME/.proof/proof-share.db npx tsx scripts/heal-table-projection-wedge.ts
//   DATABASE_PATH=... npx tsx scripts/heal-table-projection-wedge.ts --dry-run

type CliOptions = {
  dryRun: boolean;
  slugs: string[];
};

function parseCliOptions(argv: string[]): CliOptions {
  let dryRun = false;
  const slugs: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--slug') {
      const next = (argv[i + 1] ?? '').trim();
      if (!next || next.startsWith('--')) {
        throw new Error('Missing value for --slug');
      }
      slugs.push(next);
      i += 1;
      continue;
    }
    if (arg.startsWith('--slug=')) {
      const value = arg.slice('--slug='.length).trim();
      if (!value) throw new Error('Missing value for --slug');
      slugs.push(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { dryRun, slugs };
}

const cli = parseCliOptions(process.argv.slice(2));
const dryRun = cli.dryRun;

async function main(): Promise<void> {
  const db = await import('../server/db.ts');
  const collab = await import('../server/collab.ts');

  const targetSlugs = cli.slugs.length > 0
    ? Array.from(new Set(cli.slugs))
    : db.listActiveDocuments().map((doc) => doc.slug);
  console.log(`[heal] scanning ${targetSlugs.length} document(s)${dryRun ? ' (dry run)' : ''}`);

  let healed = 0;
  let skipped = 0;
  let failed = 0;

  for (const slug of targetSlugs) {
    try {
      if (dryRun) {
        const preview = await collab.previewCanonicalMarkdownHealForCollabFragment(slug);
        if (preview.wouldHeal) {
          healed += 1;
          console.log(`[heal] WOULD heal ${slug} reason=${preview.reason} (${preview.before} -> ${preview.after} chars)`);
        } else {
          skipped += 1;
          console.log(`[heal] skip ${slug} reason=${preview.reason}`);
        }
        continue;
      }

      const result = await collab.healCanonicalMarkdownForCollabFragment(slug);
      if (result.healed) {
        healed += 1;
        console.log(`[heal] healed ${slug} reason=${result.reason} (${result.before} -> ${result.after} chars)`);
      } else {
        skipped += 1;
        console.log(`[heal] skip ${slug} reason=${result.reason}`);
      }
    } catch (error) {
      failed += 1;
      console.error(`[heal] FAILED ${slug}:`, error instanceof Error ? error.message : String(error));
    }
  }

  console.log(`[heal] done — ${healed} ${dryRun ? 'would be ' : ''}healed, ${skipped} skipped, ${failed} failed`);
  await collab.stopCollabRuntime();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
