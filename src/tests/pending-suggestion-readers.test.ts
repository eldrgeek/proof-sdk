import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reviewViews } from '../shared/review-list';
import { suggestionWithStatus } from '../shared/suggestion-status';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-p0-readers-'));
Object.assign(process.env, { DATABASE_PATH: path.join(temp, 'test.db'), PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test' });
const db = await import('../../server/db');
const { buildIssueReport, reviewMarksFromStored, computeServerLines } = await import('../../server/line-marks');
const { reviewMarksForSince } = await import('../../server/alignment');
const { executeDocumentOperation, executeDocumentOperationAsync } = await import('../../server/document-engine');
const { serverSuggestionLocator } = await import('../../server/proof-extras-eval');
const { redactSuggestionDecisions, filterBlindEvents } = await import('../../server/blind-view');
const markdown = 'Original paragraph.\n\nAnother paragraph.\n';
try {
  for (const status of ['pending', 'accepted', 'rejected'] as const) {
    const slug = `readers-${status}`;
    const mark = suggestionWithStatus({ kind: 'replace', by: 'ai:test', quote: 'Original paragraph.', content: 'Changed paragraph.' }, status, 'human:reviewer');
    const marks = { suggestion: mark };
    db.createDocument(slug, markdown, marks, 'Readers', 'owner', 'owner-token');
    const state = executeDocumentOperation(slug, 'GET', '/state');
    assert.equal(state.status, 200);
    assert.equal((state.body.marks as typeof marks).suggestion.status, status, '/state preserves durable status');
    if (status !== 'pending') {
      const route = status === 'accepted' ? '/marks/reject' : '/marks/accept';
      const decision = { markId: 'suggestion', by: 'human:reviewer' };
      assert.equal(executeDocumentOperation(slug, 'POST', route, decision).status, 409);
      assert.equal((await executeDocumentOperationAsync(slug, 'POST', route, decision)).status, 409);
      assert.equal(db.getDocumentBySlug(slug)!.markdown, markdown, 'Opposite REST decision cannot apply text twice');
    }
    assert.equal(reviewMarksFromStored(marks)[0].open, status === 'pending');
    assert.equal(reviewMarksForSince(marks)[0].open, status === 'pending');
    assert.equal(reviewMarksForSince(marks)[0].status, status, 'Since you can name a historical decision without making it open');
    const lines = await computeServerLines(markdown);
    assert.equal(serverSuggestionLocator(slug, lines, marks)('suggestion').state, status);
    const report = await buildIssueReport(slug, markdown, marks, { teamExtra: ['human:reviewer'] });
    assert.equal(report.issues.some(issue => issue.type === 'suggestion'), status === 'pending', 'Line Issues/alignment use pending status only');
    const views = reviewViews({ issues: report.issues.map(issue => issue.type === 'suggestion' ? { ...issue, pos: 0 } : issue), viewer: 'human:reviewer', team: report.team, lineCount: lines.length, lineAtPos: () => 0 });
    for (const scope of ['needs-you', 'all-open'] as const) assert.equal(views[scope].items.some(row => row.kinds.includes('suggestion')), status === 'pending');
    const view = { lines, revealed: new Set<number>(), viewer: 'human:reader', askViews: [] } as any;
    assert.equal(redactSuggestionDecisions(marks, view).suggestion.resolvedBy, undefined);
    assert.equal(redactSuggestionDecisions(marks, view).suggestion.resolvedAt, undefined);
    const event = { event_type: 'suggestion.accepted', event_data: JSON.stringify({ markId: 'suggestion', status: 'accepted', resolvedBy: 'human:reviewer' }), actor: 'human:reviewer' };
    assert.deepEqual(filterBlindEvents(slug, [event], view), []);
    view.revealed.add(0);
    assert.deepEqual(redactSuggestionDecisions(marks, view), marks);
    assert.deepEqual(filterBlindEvents(slug, [event], view), [event]);
    const spanning = { suggestion: { ...mark, quote: 'Original paragraph. Another paragraph.' } };
    assert.equal(redactSuggestionDecisions(spanning, view).suggestion.resolvedBy, undefined, 'Partial span reveal is insufficient');
    view.revealed.add(1);
    assert.deepEqual(redactSuggestionDecisions(spanning, view), spanning);
  }
  console.log('✓ state, line Issues, Review counts, Since you, bundle locator and blind decision fields/events');
} finally { rmSync(temp, { recursive: true, force: true }); }
