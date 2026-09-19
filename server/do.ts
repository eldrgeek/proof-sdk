/**
 * Proof Documents `{do}` action lines — server side (safe slice, 2026-09-18).
 *
 * Authorship: direction by Mike Wolf; design do-design.md (Claude, Fable 5.1); critique
 * do-critique-astra.md (Astra), which wins; built by Claude Opus 5 (worker proof-do).
 *
 * What this does: AIs (and verified people) propose `{do}` lines; a signed-in person named in
 * `to` with Owner rights approves one, binding the canonical action digest; approvals can be
 * revoked; any change to the action or its line voids them. What it never does: run anything.
 * The run route answers 409 EXECUTION_NOT_ENABLED (DO_POLICY.executionEnabled is false) and,
 * behind that switch, hands only to the NullExecutor (server/do-executor.ts), which refuses.
 * Nothing here writes a line mark: a receipt is not agreement (critique 6).
 */
import { randomUUID } from 'crypto';
import { addDocumentEvent } from './db.js';
import { broadcastToRoom } from './ws.js';
import { buildDirectory } from './identity.js';
import { computeServerLines, documentOwnerActors, resolveAgentLineTarget } from './line-marks.js';
import { getDo, insertDo, insertDoApproval, listDos, revokeDoApprovals, updateDoFields, withdrawDoRow } from './do-store.js';
import { buildDoReport, serializeDoView } from './do-report.js';
export { buildDoReport, serializeDoView };
import { getDoExecutor } from './do-executor.js';
import { resolveTargetActor, isVerifiedHumanActor, actorTrust } from '../src/shared/identity.js';
import { actorKey, anchorForLine, normalizeLineText, type DocLine } from '../src/shared/line-marks.js';
import {
  DO_OPERATIONS,
  DO_POLICY,
  authorizeRun,
  checkApprover,
  doActionErrors,
  evaluateDo,
  evaluateDos,
  parseRetryBudget,
  type DoAction,
  type DoApproval,
  type ProofDo,
} from '../src/shared/do.js';

export type DoResult = { status: number; body: Record<string, unknown> };

function fail(status: number, code: string, error: string, extra: Record<string, unknown> = {}): DoResult {
  return { status, body: { success: false, code, error, ...extra } };
}

function event(slug: string, type: string, data: Record<string, unknown>, actor: string): void {
  try { addDocumentEvent(slug, type, data, actor); } catch (error) { console.warn('[do] failed to record event', { slug, type, error: String(error) }); }
}

function tellPages(slug: string, by: string): void {
  broadcastToRoom(slug, { type: 'line-marks.updated', by, timestamp: new Date().toISOString() });
}

// ============================================================================
// Create, revise, withdraw
// ============================================================================

/** `to`: verified people only (human:<email>, an email, or a Documents member's name). Default: the owners. */
function parseTo(raw: unknown, slug: string): { ok: true; to: string[] } | { ok: false; result: DoResult } {
  const dir = buildDirectory(slug);
  const list = raw === undefined || raw === null ? documentOwnerActors(slug) : (typeof raw === 'string' ? [raw] : raw);
  if (!Array.isArray(list)) return { ok: false, result: fail(400, 'INVALID_TO', '"to" must be a list of people, for example ["human:mw@mike-wolf.com"]') };
  if (list.length > DO_POLICY.maxTo) return { ok: false, result: fail(400, 'INVALID_TO', `At most ${DO_POLICY.maxTo} approvers`) };
  const out: string[] = [];
  for (const entry of list) {
    const actor = typeof entry === 'string' ? resolveTargetActor(entry, dir) : '';
    if (!actor || !isVerifiedHumanActor(actor)) {
      return { ok: false, result: fail(400, 'APPROVER_MUST_BE_VERIFIED', `Approvers are people who sign in: ${JSON.stringify(entry)} is not one (use human:<email>)`) };
    }
    if (!out.some(existing => actorKey(existing) === actorKey(actor))) out.push(actor);
  }
  if (!out.length) return { ok: false, result: fail(400, 'TO_REQUIRED', 'Name who may approve ("to": ["human:<email>"]); this document has no signed-in owner to default to') };
  return { ok: true, to: out };
}

function parsePresser(raw: unknown, slug: string): string | null {
  if (raw === undefined || raw === null || raw === 'approver') return DO_POLICY.defaultPresser;
  if (typeof raw !== 'string') return null;
  const actor = resolveTargetActor(raw, buildDirectory(slug));
  // Pressing needs a signed-in person too (AI press is a question for Mike).
  return isVerifiedHumanActor(actor) ? actor : null;
}

export function createDoOnLine(slug: string, line: DocLine, lines: DocLine[], input: {
  by: string; to: unknown; action: unknown; presser?: unknown; retryBudget?: unknown; source: 'agent' | 'page';
}): DoResult {
  const trust = actorTrust(input.by);
  if (trust === 'guest' && !DO_POLICY.guestsMayPropose) return fail(403, 'GUEST_CANNOT_PROPOSE', 'A guest cannot propose a {do}; an AI or a signed-in person can');
  const errors = doActionErrors(input.action);
  if (errors.length) return fail(400, 'INVALID_ACTION', errors.join('; '), { errors });
  const to = parseTo(input.to, slug);
  if (!to.ok) return to.result;
  const presser = parsePresser(input.presser, slug);
  if (!presser) return fail(400, 'INVALID_PRESSER', '"presser" is "approver" (default) or a signed-in person (human:<email>)');
  const retryBudget = parseRetryBudget(input.retryBudget);
  if (retryBudget === null) return fail(400, 'INVALID_RETRY_BUDGET', `"retryBudget" is an integer from 0 to ${DO_POLICY.maxRetryBudget}`);
  const existing = listDos(slug);
  if (DO_POLICY.oneDoPerLine) {
    const onLine = evaluateDos(existing, lines, slug).find(view => view.lineIndex === line.index);
    if (onLine) return fail(409, 'DO_EXISTS', 'This line already carries a {do}. Revise it (POST /dos/:id/revise) or withdraw it first.', { do: serializeDoView(onLine, lines) });
  }
  const anchor = anchorForLine(line);
  const record: ProofDo = {
    id: randomUUID(),
    by: input.by,
    to: to.to,
    presser,
    retryBudget,
    action: input.action as DoAction,
    anchor: { ...anchor, excerpt: normalizeLineText(anchor.excerpt).slice(0, 80) },
    createdAt: new Date().toISOString(),
    withdrawnAt: null,
    approvals: [],
    runs: [],
  };
  insertDo(slug, record);
  const view = evaluateDo(record, lines, slug);
  event(slug, 'do.created', { doId: record.id, title: line.text.slice(0, 200), operation: `${record.action.executor}/${record.action.operation}`, consequence: view.consequence, to: record.to, lineIndex: line.index, source: input.source }, input.by);
  tellPages(slug, input.by);
  return { status: 200, body: { success: true, do: serializeDoView(view, lines) } };
}

/** The proposer (or the owner credential) changes the action: a new revision voids approvals. */
export function reviseDo(slug: string, lines: DocLine[], input: { id: string; by: string; isOwner: boolean; action?: unknown; presser?: unknown; retryBudget?: unknown; to?: unknown }): DoResult {
  const record = getDo(slug, input.id);
  if (!record || record.withdrawnAt) return fail(404, 'DO_NOT_FOUND', 'No such {do}');
  if (!input.isOwner && actorKey(record.by) !== actorKey(input.by)) return fail(403, 'PROPOSER_REQUIRED', 'Only whoever proposed it (or the owner credential) can revise a {do}');
  const fields: Parameters<typeof updateDoFields>[2] = {};
  if (input.action !== undefined) {
    const errors = doActionErrors(input.action);
    if (errors.length) return fail(400, 'INVALID_ACTION', errors.join('; '), { errors });
    const next = input.action as DoAction;
    if (next.revision <= record.action.revision) return fail(409, 'REVISION_REQUIRED', `A changed action needs a higher revision than ${record.action.revision}`);
    fields.action = next;
  }
  if (input.presser !== undefined) {
    const presser = parsePresser(input.presser, slug);
    if (!presser) return fail(400, 'INVALID_PRESSER', '"presser" is "approver" or a signed-in person');
    fields.presser = presser;
  }
  if (input.retryBudget !== undefined) {
    const budget = parseRetryBudget(input.retryBudget);
    if (budget === null) return fail(400, 'INVALID_RETRY_BUDGET', `"retryBudget" is an integer from 0 to ${DO_POLICY.maxRetryBudget}`);
    fields.retryBudget = budget;
  }
  if (input.to !== undefined) {
    const to = parseTo(input.to, slug);
    if (!to.ok) return to.result;
    fields.to = to.to;
  }
  updateDoFields(slug, record.id, fields);
  const after = getDo(slug, record.id)!;
  const view = evaluateDo(after, lines, slug);
  event(slug, 'do.revised', { doId: record.id, revision: after.action.revision, approvalVoided: Boolean(view.approval && !view.approvalCurrent) }, input.by);
  tellPages(slug, input.by);
  return { status: 200, body: { success: true, do: serializeDoView(view, lines) } };
}

export function withdrawDo(slug: string, lines: DocLine[], input: { id: string; by: string; isOwner: boolean }): DoResult {
  const record = getDo(slug, input.id);
  if (!record || record.withdrawnAt) return fail(404, 'DO_NOT_FOUND', 'No such {do}');
  if (!input.isOwner && actorKey(record.by) !== actorKey(input.by)) return fail(403, 'PROPOSER_REQUIRED', 'Only whoever proposed it (or an Owner) can withdraw a {do}');
  const view = evaluateDo(record, lines, slug);
  if (view.state === 'queued' || view.state === 'running' || view.state === 'needs-finger' || view.state === 'verifying' || view.state === 'stalled') {
    return fail(409, 'RUN_UNRESOLVED', 'A run is in progress or unresolved; it cannot be withdrawn now');
  }
  const at = new Date().toISOString();
  withdrawDoRow(slug, record.id, at);
  revokeDoApprovals(slug, record.id, input.by, at);
  event(slug, 'do.withdrawn', { doId: record.id }, input.by);
  tellPages(slug, input.by);
  return { status: 200, body: { success: true, doId: record.id } };
}

// ============================================================================
// Approve, revoke, run
// ============================================================================

/**
 * Records an approval. The routes establish `actor` and `source` (only 'session' passes) and
 * `isOwner`; `digest` is what the page showed the person: it must equal the digest now.
 */
export function approveDo(slug: string, lines: DocLine[], input: { id: string; actor: string; source: string; isOwner: boolean; digest: unknown }): DoResult {
  const record = getDo(slug, input.id);
  if (!record || record.withdrawnAt) return fail(404, 'DO_NOT_FOUND', 'No such {do}');
  const view = evaluateDo(record, lines, slug);
  const allowed = checkApprover(view, { actor: input.actor, source: input.source, isOwner: input.isOwner });
  if (!allowed.ok) return fail(allowed.status, allowed.code, allowed.error);
  if (typeof input.digest !== 'string' || input.digest !== view.digest) {
    return fail(409, 'DIGEST_MISMATCH', 'The {do} changed since this page showed it; reload and read it again before approving', { digest: view.digest });
  }
  const approval: DoApproval = { id: randomUUID(), by: input.actor, at: new Date().toISOString(), digest: view.digest, source: input.source, revokedAt: null, revokedBy: null };
  // One live approval at a time: an older one (for an older digest) is revoked by this one.
  revokeDoApprovals(slug, record.id, input.actor, approval.at);
  insertDoApproval(slug, record.id, approval);
  const after = evaluateDo(getDo(slug, record.id)!, lines, slug);
  event(slug, 'do.approved', { doId: record.id, digest: view.digest, singleUse: DO_POLICY.approvalSingleUse, retryBudget: record.retryBudget, executionEnabled: DO_POLICY.executionEnabled }, input.actor);
  tellPages(slug, input.actor);
  return { status: 200, body: { success: true, do: serializeDoView(after, lines), queued: false } };
}

/** Revokes the live approval: the approver, an Owner, or whoever proposed it. Always safe. */
export function revokeDo(slug: string, lines: DocLine[], input: { id: string; actor: string; isOwner: boolean }): DoResult {
  const record = getDo(slug, input.id);
  if (!record || record.withdrawnAt) return fail(404, 'DO_NOT_FOUND', 'No such {do}');
  const live = record.approvals.filter(a => !a.revokedAt);
  const mayRevoke = input.isOwner || actorKey(record.by) === actorKey(input.actor) || live.some(a => actorKey(a.by) === actorKey(input.actor));
  if (!mayRevoke) return fail(403, 'NOT_PERMITTED', 'The approver, an Owner, or whoever proposed it can revoke an approval');
  if (!live.length) return fail(409, 'NOT_APPROVED', 'There is no live approval to revoke');
  revokeDoApprovals(slug, record.id, input.actor, new Date().toISOString());
  const after = evaluateDo(getDo(slug, record.id)!, lines, slug);
  event(slug, 'do.revoked', { doId: record.id }, input.actor);
  tellPages(slug, input.actor);
  return { status: 200, body: { success: true, do: serializeDoView(after, lines) } };
}

/**
 * Run. In this build it always refuses: authorizeRun answers EXECUTION_NOT_ENABLED first, and
 * behind that switch the only executor is the NullExecutor. No run row is ever written here.
 */
export async function runDo(slug: string, lines: DocLine[], input: { id: string; actor: string; source: string }): Promise<DoResult> {
  const record = getDo(slug, input.id);
  if (!record || record.withdrawnAt) return fail(404, 'DO_NOT_FOUND', 'No such {do}');
  const view = evaluateDo(record, lines, slug);
  const allowed = authorizeRun(view, { presser: input.actor, source: input.source });
  if (!allowed.ok) {
    event(slug, 'do.run_refused', { doId: record.id, code: allowed.code }, input.actor);
    return fail(allowed.status, allowed.code, allowed.error);
  }
  const result = await getDoExecutor().enqueue({
    slug, doId: record.id, runId: randomUUID(), attempt: allowed.attempt, approvalId: allowed.approval.id, digest: view.digest,
    action: record.action, presser: input.actor, idempotencyKey: `proof:${slug}:${record.id}:r${record.action.revision}:a${allowed.attempt}`,
  });
  if (!result.ok) {
    event(slug, 'do.run_refused', { doId: record.id, code: result.code }, input.actor);
    return fail(409, result.code, result.error);
  }
  // Unreachable in this build (NullExecutor). Recording runs is part of the attended enablement.
  return fail(500, 'NOT_IMPLEMENTED', 'Run bookkeeping is not built');
}

// ============================================================================
// Agent helpers
// ============================================================================

export async function createAgentDo(slug: string, markdown: string, body: Record<string, unknown>, by: string): Promise<DoResult> {
  const lines = await computeServerLines(markdown);
  const target = resolveAgentLineTarget(lines, body);
  if (!target.ok) return fail(target.status, target.code, target.error, target.candidates ? { candidates: target.candidates } : {});
  return createDoOnLine(slug, target.line, lines, { by, to: body.to, action: body.action, presser: body.presser, retryBudget: body.retryBudget, source: 'agent' });
}

export async function listAgentDos(slug: string, markdown: string): Promise<DoResult> {
  const lines = await computeServerLines(markdown);
  const report = buildDoReport(slug, lines);
  return {
    status: 200,
    body: {
      success: true,
      dos: report.dos,
      policy: { ...DO_POLICY, macPrincipals: undefined },
      operations: DO_OPERATIONS,
    },
  };
}
