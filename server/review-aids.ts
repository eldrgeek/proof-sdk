/**
 * Proof Documents Steps B4c + B4d — server side of review aids and objections.
 *
 * Authorship: brief by the COS (Claude), 2026-09-19, from the overnight research round
 * (Anthropic Fable, OpenAI Astra); built by Claude Opus 5 (worker proof-aids), 2026-09-19.
 *
 * B4c: review notes (an AI's `why`, reject hints and explicit priority on a suggestion or a line)
 *      and uncertain flags. B4d: objections ("I'd agree if…") over one or more lines.
 * Every write records a document event (so a Familiar can follow along) and tells open pages
 * through the same room broadcast line marks use.
 */
import { randomUUID } from 'crypto';
import { addDocumentEvent } from './db.js';
import { broadcastToRoom } from './ws.js';
import { computeServerLines, reviewMarksFromStored, resolveAgentLineTarget, writeLineMarksBatch } from './line-marks.js';
import {
  clearFlagRow,
  closeObjectionRow,
  findOwnFlag,
  getFlag,
  getObjection,
  insertFlag,
  insertObjection,
  keepObjectionRow,
  listObjections,
  updateFlagNote,
  upsertReviewNote,
} from './review-aids-store.js';
import { evaluateAids, serializeFlag, serializeNote, serializeObjection, serverSuggestionsOnLine } from './review-aids-eval.js';
import { actorKey, anchorForLine, isAiActor, isLineAnchor, normalizeLineText, LINE_TEXT_MAX, type DocLine, type LineAnchor } from '../src/shared/line-marks.js';
import { isGuestActor } from '../src/shared/identity.js';
import {
  ISSUE_PRIORITY,
  UNCERTAIN_POLICY,
  WHY_POLICY,
  clampPriority,
  cleanRejectHints,
  cleanWhy,
  oneLineText,
  whyExpectation,
  type ReviewNote,
} from '../src/shared/review-aids.js';
import { OBJECTION_POLICY, ackFor, evaluateObjection, refindLine, slotOf, type ObjectionAck, type ProofObjection } from '../src/shared/objections.js';

export type AidResult = { status: number; body: Record<string, unknown> };

function fail(status: number, code: string, error: string, extra: Record<string, unknown> = {}): AidResult {
  return { status, body: { success: false, code, error, ...extra } };
}

function touch(slug: string, by: string): void {
  broadcastToRoom(slug, { type: 'line-marks.updated', by, timestamp: new Date().toISOString() });
}

function event(slug: string, type: string, data: Record<string, unknown>, by: string): void {
  try { addDocumentEvent(slug, type, data, by); } catch (error) { console.warn('[review-aids] event failed', { slug, type, error: String(error) }); }
}

function cleanAnchor(anchor: LineAnchor): LineAnchor {
  const out: LineAnchor = {
    hash: anchor.hash,
    occurrence: anchor.occurrence,
    ordinal: anchor.ordinal,
    kind: anchor.kind,
    excerpt: normalizeLineText(String(anchor.excerpt ?? '')).slice(0, 80),
  };
  if (typeof anchor.text === 'string' && anchor.text) out.text = normalizeLineText(anchor.text).slice(0, LINE_TEXT_MAX);
  return out;
}

// ============================================================================
// B4c: why on AI suggestions (agent API)
// ============================================================================

export interface SuggestionNoteFields {
  why: string | null;
  rejectHints: string[];
  priority: number | null;
  priorityReason: string | null;
}

/** Reads the B4c fields a suggestion request may carry (why, rejectHints, priority, priorityReason). */
export function suggestionNoteFields(payload: Record<string, unknown>): SuggestionNoteFields | { error: AidResult } {
  const priority = payload.priority === undefined || payload.priority === null ? null : clampPriority(payload.priority);
  if (payload.priority !== undefined && payload.priority !== null && priority === null) {
    return { error: fail(400, 'INVALID_PRIORITY', `"priority" must be an integer ${ISSUE_PRIORITY.explicitMin}-${ISSUE_PRIORITY.explicitMax} (1 is the most urgent)`) };
  }
  const priorityReason = oneLineText(payload.priorityReason, ISSUE_PRIORITY.maxReason) || null;
  if (priority !== null && !priorityReason) {
    return { error: fail(400, 'PRIORITY_REASON_REQUIRED', 'An explicit priority needs a one-line "priorityReason"') };
  }
  return { why: cleanWhy(payload.why), rejectHints: cleanRejectHints(payload.rejectHints), priority, priorityReason };
}

/**
 * Checks the `why` rule before an AI's suggestion is added. Returns a refusal (400 WHY_REQUIRED),
 * or `warn: true` when the suggestion goes through without one (WHY_POLICY.enforce).
 */
export function checkSuggestionWhy(input: { by: string; viaAgentKey: boolean; fields: SuggestionNoteFields }): { refuse: AidResult | null; warn: boolean } {
  if (input.fields.why) return { refuse: null, warn: false };
  const expected = whyExpectation({ by: input.by, viaAgentKey: input.viaAgentKey });
  if (expected === true) {
    return {
      refuse: fail(400, 'WHY_REQUIRED', 'An AI\'s suggestion carries a one-line "why" (the reason for the change); readers see it beside the change.', { policy: { enforce: WHY_POLICY.enforce } }),
      warn: false,
    };
  }
  return { refuse: null, warn: expected === 'warn' };
}

/** After a suggestion was added: stores its note (why / hints / priority) when it has any. */
export function recordSuggestionNote(slug: string, markId: string, by: string, fields: SuggestionNoteFields): ReviewNote | null {
  if (!markId || (!fields.why && fields.rejectHints.length === 0 && fields.priority === null)) return null;
  const note = upsertReviewNote(slug, {
    id: randomUUID(),
    by,
    target: { kind: 'suggestion', markId },
    why: fields.why,
    rejectHints: fields.rejectHints,
    priority: fields.priority,
    priorityReason: fields.priorityReason,
    now: new Date().toISOString(),
  });
  event(slug, 'review_note.set', { target: { markId }, why: note.why, rejectHints: note.rejectHints, priority: note.priority, priorityReason: note.priorityReason }, by);
  touch(slug, by);
  return note;
}

/**
 * POST /notes: an AI sets (or updates) its note on a suggestion ({ markId }) or a line (a line
 * target). Fields: why, rejectHints, priority (1-5, with priorityReason; null clears).
 */
export async function writeAgentNote(slug: string, markdown: string, body: Record<string, unknown>, by: string): Promise<AidResult> {
  if (!isAiActor(by)) return fail(403, 'AI_ONLY', 'Review notes (why, reject hints, priority) are an AI\'s; a person rejects with a reason');
  const hasWhy = body.why !== undefined;
  const hasHints = body.rejectHints !== undefined;
  const hasPriority = body.priority !== undefined;
  if (!hasWhy && !hasHints && !hasPriority) return fail(400, 'NOTHING_TO_SET', 'Send at least one of "why", "rejectHints", "priority"');
  let priority: number | null | undefined;
  let priorityReason: string | null | undefined;
  if (hasPriority) {
    if (body.priority === null) { priority = null; priorityReason = null; }
    else {
      priority = clampPriority(body.priority);
      if (priority === null) return fail(400, 'INVALID_PRIORITY', `"priority" must be an integer ${ISSUE_PRIORITY.explicitMin}-${ISSUE_PRIORITY.explicitMax} (1 is the most urgent), or null to clear`);
      priorityReason = oneLineText(body.priorityReason, ISSUE_PRIORITY.maxReason) || null;
      if (!priorityReason) return fail(400, 'PRIORITY_REASON_REQUIRED', 'An explicit priority needs a one-line "priorityReason"');
    }
  }
  const lines = await computeServerLines(markdown);
  let target: ReviewNote['target'];
  let line: DocLine | null = null;
  if (typeof body.markId === 'string' && body.markId.trim()) {
    target = { kind: 'suggestion', markId: body.markId.trim().slice(0, 100) };
  } else {
    const found = resolveAgentLineTarget(lines, body);
    if (!found.ok) return fail(found.status, found.code, found.error, found.candidates ? { candidates: found.candidates } : {});
    line = found.line;
    target = { kind: 'line', anchor: anchorForLine(line) };
  }
  const note = upsertReviewNote(slug, {
    id: randomUUID(),
    by,
    target,
    ...(hasWhy ? { why: body.why === null ? null : cleanWhy(body.why) } : {}),
    ...(hasHints ? { rejectHints: cleanRejectHints(body.rejectHints) } : {}),
    ...(priority !== undefined ? { priority, priorityReason } : {}),
    now: new Date().toISOString(),
  });
  event(slug, 'review_note.set', {
    target: target.kind === 'suggestion' ? { markId: target.markId } : { lineIndex: line?.index ?? null, excerpt: line?.text.slice(0, 120) ?? null },
    why: note.why, rejectHints: note.rejectHints, priority: note.priority, priorityReason: note.priorityReason,
  }, by);
  touch(slug, by);
  return { status: 200, body: { success: true, note: serializeNote(note, lines) } };
}

// ============================================================================
// B4c: uncertain flags
// ============================================================================

/** Flags a line uncertain (or updates this person's note on their open flag there). */
export function writeFlag(slug: string, input: { by: string; anchor: unknown; note?: unknown; source: 'page' | 'agent'; line?: DocLine | null }): AidResult {
  if (!isLineAnchor(input.anchor)) return fail(400, 'INVALID_ANCHOR', 'Missing or invalid line anchor');
  const anchor = cleanAnchor(input.anchor as LineAnchor);
  const note = oneLineText(input.note, UNCERTAIN_POLICY.maxNote) || null;
  const now = new Date().toISOString();
  const own = UNCERTAIN_POLICY.onePerPersonPerLine ? findOwnFlag(slug, input.by, anchor) : null;
  if (own) {
    updateFlagNote(slug, own.id, note);
    event(slug, 'line_flag.updated', { flagId: own.id, note, excerpt: anchor.excerpt, source: input.source }, input.by);
    touch(slug, input.by);
    return { status: 200, body: { success: true, flag: { ...own, note }, updated: true } };
  }
  const flag = { id: randomUUID(), by: input.by, note, anchor, createdAt: now };
  insertFlag(slug, flag);
  event(slug, 'line_flag.set', { flagId: flag.id, note, excerpt: anchor.excerpt, lineIndex: input.line?.index ?? null, source: input.source }, input.by);
  touch(slug, input.by);
  return { status: 200, body: { success: true, flag } };
}

export function clearFlag(slug: string, input: { id: string; by: string; isOwner: boolean; source: 'page' | 'agent' }): AidResult {
  const flag = getFlag(slug, input.id);
  if (!flag || flag.cleared) return fail(404, 'FLAG_NOT_FOUND', 'No open flag with that id');
  if (actorKey(flag.by) !== actorKey(input.by) && !input.isOwner) {
    return fail(403, 'FLAGGER_REQUIRED', 'Only the person who flagged the line (or an Owner) can clear the flag');
  }
  clearFlagRow(slug, flag.id, input.by, new Date().toISOString());
  event(slug, 'line_flag.cleared', { flagId: flag.id, flaggedBy: flag.by, excerpt: flag.anchor.excerpt, source: input.source }, input.by);
  touch(slug, input.by);
  return { status: 200, body: { success: true, flagId: flag.id } };
}

/** Agent flag: { lineIndex | hash | ref | quote, note? }. */
export async function writeAgentFlag(slug: string, markdown: string, body: Record<string, unknown>, by: string): Promise<AidResult> {
  const lines = await computeServerLines(markdown);
  const target = resolveAgentLineTarget(lines, body);
  if (!target.ok) return fail(target.status, target.code, target.error, target.candidates ? { candidates: target.candidates } : {});
  const result = writeFlag(slug, { by, anchor: anchorForLine(target.line), note: body.note, source: 'agent', line: target.line });
  if (result.status === 200) result.body.line = { lineIndex: target.line.index, ref: `b${target.line.block + 1}`, text: target.line.text.slice(0, 200) };
  return result;
}

// ============================================================================
// Reports for agents (GET /flags, /notes, /objections)
// ============================================================================

export async function aidsReport(slug: string, markdown: string, rawMarks: unknown): Promise<{ lines: DocLine[]; flags: unknown[]; notes: unknown[]; objections: unknown[]; closedObjections: unknown[] }> {
  const lines = await computeServerLines(markdown);
  const reviewMarks = reviewMarksFromStored(rawMarks);
  const aids = evaluateAids(slug, lines, reviewMarks);
  const closed = listObjections(slug, { includeClosed: true }).filter(o => o.status !== 'open')
    .map(o => serializeObjection(evaluateObjection(o, lines, serverSuggestionsOnLine(lines, reviewMarks)), lines));
  return {
    lines,
    flags: aids.flagViews.map(view => serializeFlag(view, lines)),
    notes: aids.notes.map(note => serializeNote(note, lines)),
    objections: aids.objectionViews.map(view => serializeObjection(view, lines)),
    closedObjections: closed,
  };
}

// ============================================================================
// B4d: objections
// ============================================================================

/**
 * Creates an objection over `anchors` (lines as the objector sees them now). The objector's own
 * marks on those lines become Seen (OBJECTION_POLICY.objectorMarksSeen). `suggestions` are the
 * pending suggestions on the covered lines now (already seen, so not a "repair").
 */
export function createObjection(slug: string, input: {
  by: string;
  anchors: unknown;
  reason: unknown;
  condition?: unknown;
  suggestions?: string[];
  /** The document's lines now (to record each covered line's slot: its neighbours). */
  lines?: DocLine[];
  source: 'page' | 'agent';
  canMark: boolean;
}): AidResult {
  if (isGuestActor(input.by) && !OBJECTION_POLICY.guestsMayObject) {
    return fail(403, 'VERIFIED_IDENTITY_REQUIRED', 'Sign in to object: only a verified identity can later clear an objection. You can still Reject a single line.');
  }
  if (!Array.isArray(input.anchors) || input.anchors.length === 0) return fail(400, 'INVALID_LINES', 'An objection covers one or more lines');
  if (input.anchors.length > OBJECTION_POLICY.maxLines) return fail(400, 'TOO_MANY_LINES', `At most ${OBJECTION_POLICY.maxLines} lines per objection`);
  const anchors: LineAnchor[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < input.anchors.length; i += 1) {
    if (!isLineAnchor(input.anchors[i])) return fail(400, 'INVALID_ANCHOR', `lines[${i}] is not a line anchor`, { index: i });
    const anchor = cleanAnchor(input.anchors[i] as LineAnchor);
    const key = `${anchor.hash}:${anchor.occurrence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push(anchor);
  }
  anchors.sort((a, b) => a.ordinal - b.ordinal);
  const reason = oneLineText(input.reason, OBJECTION_POLICY.maxReason);
  if (OBJECTION_POLICY.reasonRequired && !reason) return fail(400, 'REASON_REQUIRED', 'An objection needs a one-line reason');
  const condition = oneLineText(input.condition, OBJECTION_POLICY.maxCondition) || null;
  if (OBJECTION_POLICY.conditionRequired && !condition) return fail(400, 'CONDITION_REQUIRED', 'Say what would change your mind ("I\'d agree if…")');
  const now = new Date().toISOString();
  const objection: ProofObjection = {
    id: randomUUID(),
    by: input.by,
    reason,
    condition,
    lines: anchors.map(anchor => {
      const found = input.lines ? refindLine(input.lines.filter(line => line.hash === anchor.hash), anchor) : null;
      return { original: anchor, current: anchor, deletedAt: null, ...(found && input.lines ? slotOf(input.lines, found.lineIndex) : {}) };
    }),
    createdAt: now,
    status: 'open',
    closedAt: null,
    closedBy: null,
    overrideReason: null,
    ack: { hashes: anchors.map(anchor => anchor.hash), suggestions: [...new Set(input.suggestions ?? [])].slice(0, 200) },
    keptAt: null,
  };
  insertObjection(slug, objection);
  let marked = 0;
  if (OBJECTION_POLICY.objectorMarksSeen && input.canMark) {
    const result = writeLineMarksBatch(slug, {
      by: input.by, status: 'seen', via: input.source === 'page' ? 'click' : 'api',
      lines: anchors.map(anchor => ({ anchor })), canApprove: false, source: input.source,
    });
    if (result.status === 200) marked = Number(result.body.count ?? 0);
  }
  event(slug, 'objection.created', {
    objectionId: objection.id,
    reason,
    condition,
    lines: anchors.map(anchor => ({ excerpt: anchor.excerpt, text: anchor.text ?? null, hash: anchor.hash, ordinal: anchor.ordinal })),
    source: input.source,
    howToRepair: 'Propose a suggestion on these lines that meets the condition; the objector sees it as "a repair was proposed" and clears or keeps the objection.',
  }, input.by);
  touch(slug, input.by);
  return { status: 200, body: { success: true, objection: { ...objection }, lineMarksSeen: marked } };
}

/** The objector clears it; an Owner may override it with a reason (recorded). */
export function clearObjection(slug: string, input: { id: string; by: string; isOwner: boolean; reason?: unknown; source: 'page' | 'agent' }): AidResult {
  const objection = getObjection(slug, input.id);
  if (!objection) return fail(404, 'OBJECTION_NOT_FOUND', 'No such objection');
  if (objection.status !== 'open') return fail(409, 'OBJECTION_CLOSED', `This objection was already ${objection.status}`);
  const now = new Date().toISOString();
  if (actorKey(objection.by) === actorKey(input.by) && !isGuestActor(input.by)) {
    closeObjectionRow(slug, objection.id, { status: 'cleared', by: input.by, at: now });
    event(slug, 'objection.cleared', { objectionId: objection.id, objector: objection.by, reason: objection.reason, condition: objection.condition, note: oneLineText(input.reason, OBJECTION_POLICY.maxReason) || null, source: input.source }, input.by);
    touch(slug, input.by);
    return { status: 200, body: { success: true, objectionId: objection.id, status: 'cleared' } };
  }
  if (!input.isOwner || !OBJECTION_POLICY.ownerMayOverride) {
    return fail(403, 'OBJECTOR_REQUIRED', 'Only the person who objected can clear an objection (an Owner can override it, with a reason)');
  }
  const reason = oneLineText(input.reason, OBJECTION_POLICY.maxReason);
  if (OBJECTION_POLICY.overrideReasonRequired && !reason) return fail(400, 'OVERRIDE_REASON_REQUIRED', 'Overriding someone\'s objection needs a one-line reason; it is recorded');
  closeObjectionRow(slug, objection.id, { status: 'overridden', by: input.by, at: now, overrideReason: reason });
  event(slug, 'objection.overridden', { objectionId: objection.id, objector: objection.by, reason: objection.reason, condition: objection.condition, overrideReason: reason, source: input.source }, input.by);
  touch(slug, input.by);
  return { status: 200, body: { success: true, objectionId: objection.id, status: 'overridden', overrideReason: reason } };
}

/**
 * "Keep": the objector looked at the proposed repair and still objects. Records what they saw
 * (`ack`, from the page; unioned with what the server sees), so only later changes are a repair.
 */
export async function keepObjection(slug: string, input: { id: string; by: string; ack?: unknown; markdown: string; rawMarks: unknown; source: 'page' | 'agent' }): Promise<AidResult> {
  const objection = getObjection(slug, input.id);
  if (!objection) return fail(404, 'OBJECTION_NOT_FOUND', 'No such objection');
  if (objection.status !== 'open') return fail(409, 'OBJECTION_CLOSED', `This objection was already ${objection.status}`);
  if (actorKey(objection.by) !== actorKey(input.by)) return fail(403, 'OBJECTOR_REQUIRED', 'Only the person who objected can keep it');
  const lines = await computeServerLines(input.markdown);
  const view = evaluateObjection(objection, lines, serverSuggestionsOnLine(lines, reviewMarksFromStored(input.rawMarks)));
  const serverAck = ackFor(view);
  const pageAck = input.ack && typeof input.ack === 'object' ? input.ack as Partial<ObjectionAck> : null;
  const ack: ObjectionAck = {
    hashes: serverAck.hashes.map((hash, i) => {
      // The page saw the line as it is on screen now; trust it when it names a line (it knows
      // its own unsaved edits), else the server's view.
      const fromPage = Array.isArray(pageAck?.hashes) && typeof pageAck!.hashes[i] === 'string' ? pageAck!.hashes[i] : null;
      return fromPage && fromPage.length <= 32 ? fromPage : hash;
    }),
    suggestions: [...new Set([...serverAck.suggestions, ...(Array.isArray(pageAck?.suggestions) ? pageAck!.suggestions.filter((s): s is string => typeof s === 'string' && s.length <= 100) : [])])].slice(0, 400),
  };
  keepObjectionRow(slug, objection.id, ack, new Date().toISOString());
  event(slug, 'objection.kept', { objectionId: objection.id, condition: objection.condition, source: input.source }, input.by);
  touch(slug, input.by);
  return { status: 200, body: { success: true, objectionId: objection.id, status: 'open', kept: true } };
}

/** Agent create: { lines: [target, ...] } (or one target inline), reason, condition?. */
export async function createAgentObjection(slug: string, markdown: string, rawMarks: unknown, body: Record<string, unknown>, by: string): Promise<AidResult> {
  const lines = await computeServerLines(markdown);
  const targets: Array<Record<string, unknown>> = Array.isArray(body.lines)
    ? body.lines.filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === 'object' && !Array.isArray(t))
    : [body];
  if (Array.isArray(body.lines) && targets.length !== body.lines.length) return fail(400, 'INVALID_LINES', '"lines" must be a list of line targets');
  const found: DocLine[] = [];
  for (let i = 0; i < targets.length; i += 1) {
    const target = resolveAgentLineTarget(lines, targets[i]);
    if (!target.ok) return fail(target.status, target.code, Array.isArray(body.lines) ? `lines[${i}]: ${target.error}` : target.error, { index: i, ...(target.candidates ? { candidates: target.candidates } : {}) });
    found.push(target.line);
  }
  const onLine = serverSuggestionsOnLine(lines, reviewMarksFromStored(rawMarks));
  const result = createObjection(slug, {
    by,
    anchors: found.map(anchorForLine),
    reason: body.reason,
    condition: body.condition,
    suggestions: found.flatMap(line => onLine(line.index)),
    lines,
    source: 'agent',
    canMark: true,
  });
  if (result.status === 200) {
    const objection = result.body.objection as ProofObjection;
    result.body.objection = serializeObjection(evaluateObjection(objection, lines, onLine), lines);
  }
  return result;
}

/** The objections this actor raised (for "Since you": a repair was proposed). */
export function ownObjections(slug: string, actor: string): ProofObjection[] {
  const me = actorKey(actor);
  return listObjections(slug).filter(o => actorKey(o.by) === me);
}

