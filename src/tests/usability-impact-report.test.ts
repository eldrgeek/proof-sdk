// Mike, 2026-09-23 (usability brief), ac-o3l: synthetic-only impact report coverage.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anchorForLine, type LineAnchor, type LineMarkStatus } from '../shared/line-marks';

const temp = mkdtempSync(path.join(tmpdir(), 'accord-impact-synthetic-'));
const filename = path.join(temp, 'synthetic.sqlite');
process.env.DATABASE_PATH = filename;
const db = await import('../../server/db');
const { computeServerLines } = await import('../../server/line-marks');
const root = fileURLToPath(new URL('../../', import.meta.url));
const script = path.join(root, 'scripts/usability-impact-report.mjs');
let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}
function run(file = filename) {
  return spawnSync(process.execPath, [script, file], { cwd: root, encoding: 'utf8' });
}
function report() {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const lines = result.stdout.trim().split('\n');
  return lines.map((line, index) => {
    const prefix = index === lines.length - 1 ? 'total ' : `doc ${index + 1} `;
    assert.ok(line.startsWith(prefix), line);
    const counts = JSON.parse(line.slice(prefix.length)) as Record<string, number>;
    assert.ok(Object.values(counts).every(n => Number.isInteger(n) && n >= 0));
    assert.equal(counts.marks, counts.old_only + counts.carried_both + counts.exact_both + counts.stale_both + counts.new_only);
    return counts;
  });
}
function mark(slug: string, anchor: LineAnchor, status: LineMarkStatus, id: string) {
  db.replaceDocumentLineMark({ slug, actorKey: id, replaceIds: [], anchor, next: {
    id, by_actor: `human:private-${id}@example.test`, status, reason: null,
    line_hash: anchor.hash, line_occurrence: anchor.occurrence, line_ordinal: anchor.ordinal,
    line_kind: anchor.kind, line_excerpt: anchor.excerpt, line_text: anchor.text ?? null,
    at: '2026-09-23T00:00:00Z',
  } });
}
try {
  const slug = 'private-synthetic-slug';
  const before = 'The equipment is safe during normal operation.\n\nWe recieve the complete delivery tomorrow.';
  db.createDocument(slug, before, {}, 'Private title');
  const lines = await computeServerLines(before);
  mark(slug, anchorForLine(lines[0]), 'agreed', 'safety');
  mark(slug, anchorForLine(lines[1]), 'approved', 'spelling');
  db.updateDocument(slug, before.replace('safe', 'unsafe').replace('recieve', 'receive'));

  await test('safe → unsafe loses one carry; recieve → receive carries under both', () => {
    const [doc, total] = report();
    assert.equal(doc.old_only, 1);
    assert.equal(doc.old_only_agreed, 1);
    assert.equal(doc.carried_both, 1);
    assert.equal(doc.marks, 2);
    assert.deepEqual(total, doc);
  });
  await test('every status is counted and projection text takes precedence', () => {
    for (const status of ['seen', 'approved', 'rejected', 'skimmed'] as const) {
      mark(slug, anchorForLine(lines[0]), status, status);
    }
    // Canonical text is deliberately older: using it would incorrectly report exact marks.
    db.getDb().prepare('UPDATE documents SET markdown = ? WHERE slug = ?').run(before, slug);
    const [doc] = report();
    assert.equal(doc.old_only, 5);
    for (const status of ['seen', 'agreed', 'approved', 'rejected', 'skimmed']) assert.equal(doc[`old_only_${status}`], 1);
    assert.equal(doc.carried_both, 1);
    assert.equal(doc.projection_text_mismatch, 1);
  });
  await test('canonical fallback, exact duplicate fallback, stale anchors and new-only carry', async () => {
    const other = 'second-private-slug';
    const oldText = 'Same passage.\n\nSame passage.\n\nThe old price is 100 dollars.\n\nrecieve';
    db.createDocument(other, oldText, {});
    const oldLines = await computeServerLines(oldText);
    mark(other, anchorForLine(oldLines[1]), 'seen', 'duplicate');
    mark(other, anchorForLine(oldLines[2]), 'agreed', 'number');
    mark(other, anchorForLine(oldLines[3]), 'agreed', 'short-spelling');
    const legacyText = 'This legacy anchor contains a long passage whose full text was never saved and cannot be reconstructed from its truncated excerpt.';
    const legacyLine = (await computeServerLines(legacyText))[0];
    const legacyAnchor = anchorForLine(legacyLine);
    delete legacyAnchor.text;
    mark(other, legacyAnchor, 'agreed', 'legacy');
    db.updateDocument(other, 'Same passage.\n\nThe old price is 200 dollars.\n\nreceive');
    db.getDb().prepare('DELETE FROM document_projections WHERE document_slug = ?').run(other);
    const counts = report();
    const doc = counts[1];
    assert.equal(doc.projection_missing, 1);
    assert.equal(doc.exact_both, 1);
    assert.equal(doc.stale_both, 2);
    assert.equal(doc.missing_anchor_text, 1);
    assert.equal(doc.new_only, 1);
    assert.equal(counts[2].marks, 10);
  });
  await test('report output contains only counts and leaves database bytes unchanged', () => {
    db.getDb().pragma('wal_checkpoint(TRUNCATE)');
    const bytes = readFileSync(filename);
    const wal = readFileSync(`${filename}-wal`);
    const result = run();
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /private|example|equipment|delivery|passage|recieve|receive|sqlite/);
    assert.deepEqual(readFileSync(filename), bytes);
    assert.deepEqual(readFileSync(`${filename}-wal`), wal);
  });
  await test('missing file fails privately without creating a database', () => {
    const missing = path.join(temp, 'private-missing.sqlite');
    const result = run(missing);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Impact report failed; check the database copy and its schema.\n');
    assert.equal(existsSync(missing), false);
  });
  console.log(`\n${passed} usability impact report tests passed.`);
} finally {
  db.getDb().close();
  rmSync(temp, { recursive: true, force: true });
}
