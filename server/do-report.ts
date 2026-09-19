/**
 * Proof Documents `{do}` action lines — evaluation for /state, alignment and the page's poll
 * (safe slice, 2026-09-18). Authorship: Claude Opus 5 (worker proof-do).
 * Imports only the store and shared code, so server/line-marks.ts can use it without a cycle.
 */
import { updateDoAnchor, listDos } from './do-store.js';
import { anchorForLine, type DocLine } from '../src/shared/line-marks.js';
import { DO_POLICY, DO_STATE_LABEL, describeDo, doIssueInputs, evaluateDo, evaluateDos, type DoView, type ProofDo } from '../src/shared/do.js';

/** Re-anchors `{do}` lines that moved or whose text changed, like asks. */
function reanchor(slug: string, records: ProofDo[], lines: DocLine[]): void {
  for (const record of records) {
    const view = evaluateDo(record, lines, slug);
    if (view.lineIndex === null) continue;
    const line = lines[view.lineIndex];
    const a = record.anchor;
    if (a.hash === line.hash && a.occurrence === line.occurrence && a.ordinal === line.index) continue;
    // Follows the line like an ask. An approval stays void after a text change regardless: the
    // digest binds the line's text as it was approved, not the anchor.
    try { const anchor = anchorForLine(line); updateDoAnchor(slug, record.id, anchor); record.anchor = anchor; } catch { /* next read retries */ }
  }
}

/** The JSON shape of one `{do}` for AIs and the page. */
export function serializeDoView(view: DoView, lines: DocLine[]): Record<string, unknown> {
  const line = view.lineIndex === null ? null : lines[view.lineIndex];
  const r = view.record;
  return {
    id: r.id,
    by: r.by,
    to: r.to,
    title: line ? line.text : r.anchor.excerpt,
    lineIndex: view.lineIndex,
    ref: line ? `b${line.block + 1}` : null,
    orphaned: view.lineIndex === null,
    state: view.state,
    stateLabel: DO_STATE_LABEL[view.state],
    summary: describeDo(view),
    consequence: view.consequence,
    verifiedPredicate: view.predicate,
    account: view.account,
    blastRadius: view.blastRadius,
    digest: view.digest,
    approval: view.approval ? { ...view.approval, current: view.approvalCurrent } : null,
    approvals: r.approvals,
    presser: r.presser,
    retryBudget: r.retryBudget,
    openFor: view.openFor,
    action: r.action,
    runs: r.runs,
    createdAt: r.createdAt,
    executionEnabled: DO_POLICY.executionEnabled,
  };
}

export interface DoReport {
  dos: Array<Record<string, unknown>>;
  views: DoView[];
  issueInputs: ReturnType<typeof doIssueInputs>;
}

export function buildDoReport(slug: string, lines: DocLine[], now: number = Date.now()): DoReport {
  let records: ProofDo[] = [];
  try { records = listDos(slug); } catch { records = []; }
  reanchor(slug, records, lines);
  const views = evaluateDos(records, lines, slug, now);
  return { dos: views.map(view => serializeDoView(view, lines)), views, issueInputs: doIssueInputs(views) };
}

