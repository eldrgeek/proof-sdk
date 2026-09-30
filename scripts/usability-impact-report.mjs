#!/usr/bin/env node
/**
 * Mike, 2026-09-23 (usability brief), ac-o3l: count S5's read-time impact without
 * changing stored consent. Run: node scripts/usability-impact-report.mjs COPY.sqlite
 * Counts stored rows, not deduplicated participant states; includes every document.
 * The frozen old classifier is byte-for-byte from 7b5c574.
 */
import Database from 'better-sqlite3';
import { register } from 'tsx/esm/api';

register();

const empty = () => ({
  documents: 0, marks: 0, old_only: 0,
  old_only_seen: 0, old_only_agreed: 0, old_only_approved: 0,
  old_only_rejected: 0, old_only_skimmed: 0,
  carried_both: 0, exact_both: 0, stale_both: 0, new_only: 0,
  missing_anchor_text: 0, invalid_status: 0,
  projection_missing: 0, projection_unhealthy: 0, projection_version_mismatch: 0,
  projection_text_mismatch: 0,
  parse_fallback: 0, parse_failed: 0,
});

async function report(filename) {
  // Do not import server/db or server/line-marks: their application dependency graph
  // can initialize a writable database. Reuse only the parser and pure domain code.
  const [shared, old, current, parserModule, spans] = await Promise.all([
    import('../src/shared/line-marks.ts'),
    import('./impact/line-change-old.ts'),
    import('../src/shared/line-change.ts'),
    import('../server/milkdown-headless.ts'),
    import('../server/proof-span-strip.ts'),
  ]);
  const parser = await parserModule.getHeadlessMilkdownParser();
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    // One consistent read snapshot, including WAL content in a complete SQLite copy.
    db.exec('BEGIN');
    // Same markdown selection as getProjectedDocumentBySlug in server/db.ts.
    const documents = db.prepare(`
      SELECT d.slug, COALESCE(p.markdown, d.markdown) AS markdown,
        p.document_slug IS NULL AS projection_missing,
        p.markdown IS NOT NULL AND p.markdown != d.markdown AS projection_text_mismatch,
        p.health AS health, d.revision, d.y_state_version,
        p.revision AS projection_revision, p.y_state_version AS projection_y_state_version
      FROM documents d LEFT JOIN document_projections p ON p.document_slug = d.slug
      ORDER BY d.slug
    `);
    const marks = db.prepare(`SELECT status, line_hash, line_occurrence, line_ordinal,
      line_kind, line_excerpt, line_text FROM document_line_marks WHERE document_slug = ?
      ORDER BY updated_at ASC, id ASC`);
    const total = empty();
    const output = [];
    for (const doc of documents.iterate()) {
      const counts = empty();
      counts.documents = 1;
      counts.projection_missing = Number(doc.projection_missing);
      counts.projection_text_mismatch = Number(doc.projection_text_mismatch);
      counts.projection_unhealthy = Number(!doc.projection_missing && doc.health !== 'healthy');
      counts.projection_version_mismatch = Number(!doc.projection_missing
        && (doc.revision !== doc.projection_revision || doc.y_state_version !== doc.projection_y_state_version));
      // Same parse/strip/extract sequence as computeServerLines in server/line-marks.ts.
      const parsed = parserModule.parseMarkdownWithHtmlFallback(parser, spans.stripAllProofSpanTags(doc.markdown ?? ''));
      const lines = parsed.doc ? shared.extractLines(parsed.doc) : [];
      counts.parse_failed = Number(!parsed.doc);
      counts.parse_fallback = Number(parsed.mode !== 'original' && parsed.mode !== 'failed');
      const oldCache = new Map();
      const newCache = new Map();
      for (const row of marks.iterate(doc.slug)) {
        counts.marks += 1;
        const anchor = { hash: row.line_hash, occurrence: row.line_occurrence,
          ordinal: row.line_ordinal, kind: row.line_kind, excerpt: row.line_excerpt,
          ...(row.line_text ? { text: row.line_text } : {}) };
        // Same status fallback as rowToLineMark; flag unexpected stored values too.
        const valid = shared.isLineMarkStatus(row.status);
        const status = valid ? row.status : 'seen';
        counts.invalid_status += Number(!valid);
        if (shared.resolveLineAnchor(lines, anchor)?.current) {
          counts.exact_both += 1;
          continue;
        }
        if (!shared.anchorText(anchor)) counts.missing_anchor_text += 1;
        const before = findCarryTarget(lines, anchor, oldCache, old.classifyLineChange, shared);
        const after = findCarryTarget(lines, anchor, newCache, current.classifyLineChange, shared);
        if (before && after) counts.carried_both += 1;
        else if (before) {
          counts.old_only += 1;
          counts[`old_only_${status}`] += 1;
        } else if (after) counts.new_only += 1;
        else counts.stale_both += 1;
      }
      for (const key of Object.keys(total)) total[key] += counts[key];
      output.push(`doc ${total.documents} ${JSON.stringify(counts)}`);
    }
    db.exec('ROLLBACK');
    output.push(`total ${JSON.stringify(total)}`);
    return output.join('\n');
  } finally {
    db.close();
  }
}

/** Mirrors shared findCarryTarget, with only the classifier injected. */
function findCarryTarget(lines, anchor, cache, classifyLineChange, shared) {
  if (!shared.LINE_MARK_POLICY.carryCosmeticEdits) return null;
  const before = shared.anchorText(anchor);
  if (!before) return null;
  let best = null;
  const lo = before.length * 0.8 - 4;
  const hi = before.length * 1.25 + 4;
  for (const line of lines) {
    if (line.kind !== anchor.kind || line.hash === anchor.hash) continue;
    if (line.text.length < lo || line.text.length > hi) continue;
    const key = `${anchor.hash}|${line.hash}`;
    let cosmetic = cache.get(key);
    if (cosmetic === undefined) {
      cosmetic = classifyLineChange(before, line.text).kind === 'cosmetic';
      cache.set(key, cosmetic);
    }
    if (!cosmetic) continue;
    if (!best || Math.abs(line.index - anchor.ordinal) < Math.abs(best.index - anchor.ordinal)) best = line;
  }
  return best;
}

if (process.argv.length !== 3) {
  process.stderr.write('Usage: node scripts/usability-impact-report.mjs COPY.sqlite\n');
  process.exitCode = 1;
} else {
  try {
    process.stdout.write(`${await report(process.argv[2])}\n`);
  } catch {
    // SQLite and parser errors may contain private values or paths. Never print them.
    process.stderr.write('Impact report failed; check the database copy and its schema.\n');
    process.exitCode = 1;
  }
}
