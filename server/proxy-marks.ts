/**
 * Proof Documents — Familiar proxy marks, server side (storage, binding, proxy writes, the brief,
 * ratify and undo). Rules live in src/shared/proxy-marks.ts (PROXY_POLICY, EVIDENCE_POLICY).
 *
 * Authorship: Mike Wolf ruled Yes on 2026-09-19 ("A proxy mark never counts as yours until you
 * ratify it, and every AI mark must show its evidence"); built by Claude Opus 5 (worker
 * proof-proxy), 2026-09-19.
 *
 * Proxy marks live in their own table (document_proxy_marks), never in document_line_marks, so the
 * Issue count, alignment and aligned snapshots cannot count them by accident. Ratifying writes the
 * person's own line marks (via "proxy") in one transaction and records what each line held before,
 * so Undo restores it in one request.
 */
import { randomUUID } from 'crypto';
import { addDocumentEvent, assertWritesAllowed, getDb, listDocumentLineMarks, type DocumentLineMarkRow } from './db.js';
import { broadcastToRoom } from './ws.js';
import {
  activeAgentKeyActors,
  buildIssueReport,
  computeServerLines,
  resolveAgentLineTarget,
  reviewMarksFromStored,
  writeLineMarksBatch,
  type IssueReport,
  type LineMarkResult,
} from './line-marks.js';
import { buildAskReport, listCanonicalAsks } from './asks.js';
import { askTeamActors } from '../src/shared/asks.js';
import { buildDirectory } from './identity.js';
import { isEmailAddress, normalizeActorString, resolveTargetActor, verifiedHumanActor } from '../src/shared/identity.js';
import {
  actorKey,
  anchorForLine,
  buildLineStates,
  normalizeLineText,
  type DocLine,
  type LineAnchor,
} from '../src/shared/line-marks.js';
import {
  EVIDENCE_POLICY,
  PROXY_POLICY,
  cleanConfidence,
  cleanEvidence,
  evaluateProxies,
  heldLines,
  humanIssueLines,
  isProxyStatus,
  lineOfQuote,
  type FamiliarBinding,
  type ProxyBrief,
  type ProxyItem,
  type ProxyMark,
  type ProxyStatus,
} from '../src/shared/proxy-marks.js';

type Result = LineMarkResult;
const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Result =>
  ({ status, body: { success: false, code, error, ...extra } });

// ============================================================================
// Storage
// ============================================================================

interface FamiliarRow { document_slug: string; human_key: string; human_actor: string; familiar_actor: string; bound_at: string; bound_by: string }

export function listFamiliars(slug: string): FamiliarBinding[] {
  try {
    const rows = getDb().prepare(`SELECT * FROM document_familiars WHERE document_slug = ? ORDER BY bound_at ASC`).all(slug) as FamiliarRow[];
    return rows.map(row => ({ human: row.human_actor, familiar: row.familiar_actor, boundAt: row.bound_at, boundBy: row.bound_by }));
  } catch {
    return [];
  }
}

export function familiarOf(slug: string, human: string): FamiliarBinding | null {
  return listFamiliars(slug).find(binding => actorKey(binding.human) === actorKey(human)) ?? null;
}

interface ProxyRow {
  id: string; document_slug: string; familiar_actor: string; familiar_key: string; for_actor: string; for_key: string;
  status: string; confidence: number; evidence: string; line_hash: string; line_occurrence: number; line_ordinal: number;
  line_kind: string; line_excerpt: string; line_text: string | null; at: string;
}

function rowToProxy(row: ProxyRow): ProxyMark {
  const anchor: LineAnchor = { hash: row.line_hash, occurrence: row.line_occurrence, ordinal: row.line_ordinal, kind: row.line_kind, excerpt: row.line_excerpt ?? '' };
  if (row.line_text) anchor.text = row.line_text;
  return {
    id: row.id,
    familiar: row.familiar_actor,
    for: row.for_actor,
    status: (isProxyStatus(row.status) ? row.status : 'seen') as ProxyStatus,
    confidence: Number(row.confidence) || 0,
    evidence: row.evidence,
    at: row.at,
    anchor,
  };
}

export function listProxyMarks(slug: string, options: { for?: string } = {}): ProxyMark[] {
  try {
    const rows = (options.for
      ? getDb().prepare(`SELECT * FROM document_proxy_marks WHERE document_slug = ? AND for_key = ? ORDER BY at ASC, id ASC`).all(slug, actorKey(options.for))
      : getDb().prepare(`SELECT * FROM document_proxy_marks WHERE document_slug = ? ORDER BY at ASC, id ASC`).all(slug)) as ProxyRow[];
    return rows.map(rowToProxy);
  } catch {
    return [];
  }
}

export interface RatificationEntry {
  proxyId: string;
  lineMarkId: string;
  anchor: { hash: string; occurrence: number; excerpt: string };
  /** The person's rows on this line that the ratified mark replaced (restored by Undo). */
  previous: DocumentLineMarkRow[];
}

export interface Ratification {
  id: string;
  human: string;
  familiar: string;
  at: string;
  entries: RatificationEntry[];
  undoneAt: string | null;
}

interface RatificationRow { id: string; document_slug: string; human_actor: string; human_key: string; familiar_actor: string; at: string; entries_json: string; undone_at: string | null }

function rowToRatification(row: RatificationRow): Ratification {
  let entries: RatificationEntry[] = [];
  try { entries = JSON.parse(row.entries_json) as RatificationEntry[]; } catch { entries = []; }
  return { id: row.id, human: row.human_actor, familiar: row.familiar_actor, at: row.at, entries, undoneAt: row.undone_at };
}

export function getRatification(slug: string, id: string): Ratification | null {
  const row = getDb().prepare(`SELECT * FROM document_proxy_ratifications WHERE document_slug = ? AND id = ?`).get(slug, id) as RatificationRow | undefined;
  return row ? rowToRatification(row) : null;
}

/** The person's ratifications that can still be undone (newest first). */
export function undoableRatifications(slug: string, human: string, now = Date.now()): Array<{ id: string; at: string; count: number; familiar: string }> {
  try {
    const rows = getDb().prepare(`
      SELECT * FROM document_proxy_ratifications WHERE document_slug = ? AND human_key = ? AND undone_at IS NULL ORDER BY at DESC LIMIT 10
    `).all(slug, actorKey(human)) as RatificationRow[];
    return rows.map(rowToRatification)
      .filter(r => now - Date.parse(r.at) <= PROXY_POLICY.undoWindowMs)
      .map(r => ({ id: r.id, at: r.at, count: r.entries.length, familiar: r.familiar }));
  } catch {
    return [];
  }
}

// ============================================================================
// Binding a Familiar
// ============================================================================

/** The person a "for" names: human:<email>, or an email, or a member's name (read as human:<email>). */
export function resolveHuman(slug: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  if (isEmailAddress(raw)) return verifiedHumanActor(raw);
  const actor = resolveTargetActor(normalizeActorString(raw), buildDirectory(slug));
  return /^human:/i.test(actor) && isEmailAddress(actor.slice(6)) ? verifiedHumanActor(actor.slice(6)) : null;
}

/**
 * Binds (or, with familiar null, unbinds) a person's Familiar in this document. The route decides
 * who may call it (a verified session for oneself; the owner credential for a named person).
 */
export function bindFamiliar(slug: string, input: { human: string; familiar: unknown; by: string; source: 'page' | 'agent' }): Result {
  const human = input.human;
  if (!/^human:/i.test(human) || !isEmailAddress(human.slice(6))) {
    return fail(403, 'VERIFIED_PERSON_REQUIRED', 'Only a signed-in (verified) person has a Familiar: human:<email>');
  }
  const present = activeAgentKeyActors(slug);
  if (input.familiar === null || input.familiar === '' || input.familiar === 'none') {
    assertWritesAllowed('unbindFamiliar');
    const removed = getDb().prepare(`DELETE FROM document_familiars WHERE document_slug = ? AND human_key = ?`).run(slug, actorKey(human)).changes > 0;
    try { addDocumentEvent(slug, 'familiar.unbound', { human, source: input.source }, input.by); } catch { /* events are best effort */ }
    broadcastToRoom(slug, { type: 'line-marks.updated', by: input.by, timestamp: new Date().toISOString() });
    return { status: 200, body: { success: true, familiar: null, removed } };
  }
  if (typeof input.familiar !== 'string') return fail(400, 'INVALID_FAMILIAR', '"familiar" must be an AI present in this document (ai:<key-name>) or null');
  const familiar = normalizeActorString(input.familiar.trim());
  if (!/^ai:/i.test(familiar)) return fail(400, 'INVALID_FAMILIAR', 'A Familiar is an AI: "familiar" must start with "ai:"');
  const match = present.find(actor => actorKey(actor) === actorKey(familiar));
  if (PROXY_POLICY.familiarMustBeActiveKey && !match) {
    return fail(400, 'FAMILIAR_NOT_PRESENT', `${familiar} is not an AI present in this document (add it with "Add agent" first)`, { present });
  }
  const at = new Date().toISOString();
  assertWritesAllowed('bindFamiliar');
  getDb().prepare(`
    INSERT INTO document_familiars (document_slug, human_key, human_actor, familiar_actor, bound_at, bound_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(document_slug, human_key) DO UPDATE SET human_actor = excluded.human_actor, familiar_actor = excluded.familiar_actor,
      bound_at = excluded.bound_at, bound_by = excluded.bound_by
  `).run(slug, actorKey(human), human, match ?? familiar, at, input.by);
  const binding: FamiliarBinding = { human, familiar: match ?? familiar, boundAt: at, boundBy: input.by };
  try { addDocumentEvent(slug, 'familiar.bound', { human, familiar: binding.familiar, source: input.source }, input.by); } catch { /* best effort */ }
  broadcastToRoom(slug, { type: 'line-marks.updated', by: input.by, timestamp: at });
  return { status: 200, body: { success: true, familiar: binding } };
}

// ============================================================================
// Proxy writes (the bound Familiar, through its agent key)
// ============================================================================

interface ValidProxyEntry { line: DocLine; status: ProxyStatus | null; confidence: number; evidence: string }

/**
 * POST /api/agent/:slug/marks/proxy
 * Body: { for: "human:<email>", lines: [{ target: <line target>, status, confidence, evidence }] }
 * (the target's fields may also sit on the entry itself). All lines are checked first; one bad
 * entry writes nothing and names its index. `status: "unseen"` withdraws the proxy on that line.
 */
export async function writeAgentProxyMarks(slug: string, markdown: string, body: Record<string, unknown>, options: {
  actor: string;
  viaAgentKey: boolean;
}): Promise<Result> {
  if (PROXY_POLICY.requireAgentKey && !options.viaAgentKey) {
    return fail(403, 'AGENT_KEY_REQUIRED', 'Proxy marks come only from the Familiar itself: send its "Add agent" key (x-share-token)');
  }
  const human = resolveHuman(slug, body.for);
  if (!human) return fail(400, 'INVALID_FOR', '"for" must name a verified person: "human:<email>"');
  const binding = familiarOf(slug, human);
  if (!binding) return fail(403, 'NOT_BOUND', `${human} has not chosen a Familiar in this document`);
  if (actorKey(binding.familiar) !== actorKey(options.actor)) {
    return fail(403, 'NOT_THIS_PERSONS_FAMILIAR', `${options.actor} is not the Familiar of ${human} in this document; only ${binding.familiar} may mark for them`);
  }
  if (!Array.isArray(body.lines) || body.lines.length === 0) return fail(400, 'INVALID_LINES', '"lines" must be a non-empty array');
  if (body.lines.length > PROXY_POLICY.maxLinesPerRequest) return fail(400, 'BATCH_TOO_LARGE', `At most ${PROXY_POLICY.maxLinesPerRequest} lines per request`);
  const lines = await computeServerLines(markdown);
  const entries: ValidProxyEntry[] = [];
  for (let i = 0; i < body.lines.length; i += 1) {
    const raw = body.lines[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(400, 'INVALID_LINES', `lines[${i}] is not an object`, { index: i });
    const item = raw as Record<string, unknown>;
    const status = item.status;
    if (status === 'approved') return fail(403, 'PROXY_CANNOT_APPROVE', 'A Familiar cannot Approve for its person: Approve binds the owner and is theirs alone', { index: i });
    if (status === 'rejected') return fail(400, 'PROXY_REJECT_IS_SUGGESTED', 'A Familiar recommends a rejection: use "rejected-suggested" (the person rejects it themselves)', { index: i });
    const clearing = status === 'unseen';
    if (!clearing && !isProxyStatus(status)) return fail(400, 'INVALID_STATUS', `lines[${i}]: status must be one of ${PROXY_POLICY.statuses.join(', ')} (or unseen to withdraw)`, { index: i });
    const targetRaw = item.target && typeof item.target === 'object' && !Array.isArray(item.target) ? item.target as Record<string, unknown> : item;
    const target = resolveAgentLineTarget(lines, targetRaw);
    if (!target.ok) return fail(target.status, target.code, `lines[${i}]: ${target.error}`, { index: i, ...(target.candidates ? { candidates: target.candidates } : {}) });
    if (clearing) { entries.push({ line: target.line, status: null, confidence: 0, evidence: '' }); continue; }
    const evidence = cleanEvidence(item.evidence);
    if (!evidence && EVIDENCE_POLICY.requiredForProxy) {
      return fail(400, 'EVIDENCE_REQUIRED', `lines[${i}]: every proxy mark needs "evidence": one line (at least ${EVIDENCE_POLICY.minChars} characters) paraphrasing the line or naming the check you ran`, { index: i });
    }
    const confidence = cleanConfidence(item.confidence);
    if (confidence === null) return fail(400, 'CONFIDENCE_REQUIRED', `lines[${i}]: "confidence" must be a number from 0 to 1`, { index: i });
    entries.push({ line: target.line, status: status as ProxyStatus, confidence, evidence: evidence ?? '' });
  }
  const familiar = binding.familiar;
  const at = new Date().toISOString();
  const hashes = new Set(lines.map(line => line.hash));
  const written: ProxyMark[] = [];
  let removed = 0;
  assertWritesAllowed('writeProxyMarks');
  const d = getDb();
  d.transaction(() => {
    const existing = d.prepare(`SELECT * FROM document_proxy_marks WHERE document_slug = ? AND familiar_key = ? AND for_key = ?`)
      .all(slug, actorKey(familiar), actorKey(human)) as ProxyRow[];
    const del = d.prepare(`DELETE FROM document_proxy_marks WHERE id = ?`);
    const ins = d.prepare(`
      INSERT INTO document_proxy_marks (id, document_slug, familiar_actor, familiar_key, for_actor, for_key, status, confidence, evidence,
        line_hash, line_occurrence, line_ordinal, line_kind, line_excerpt, line_text, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const gone = new Set<string>();
    for (const entry of entries) {
      const anchor = anchorForLine(entry.line);
      // Replace this Familiar's earlier proxy on the line (the same text, or a stale one in its slot).
      for (const row of existing) {
        if (gone.has(row.id)) continue;
        const same = row.line_hash === anchor.hash && row.line_occurrence === anchor.occurrence;
        const staleHere = !hashes.has(row.line_hash) && row.line_ordinal === entry.line.index;
        if (same || staleHere) { del.run(row.id); gone.add(row.id); removed += 1; }
      }
      if (!entry.status) continue;
      const id = randomUUID();
      const excerpt = normalizeLineText(anchor.excerpt).slice(0, 80);
      ins.run(id, slug, familiar, actorKey(familiar), human, actorKey(human), entry.status, entry.confidence, entry.evidence,
        anchor.hash, anchor.occurrence, anchor.ordinal, anchor.kind, excerpt, anchor.text ?? null, at);
      written.push({ id, familiar, for: human, status: entry.status, confidence: entry.confidence, evidence: entry.evidence, at, anchor });
    }
  })();
  try {
    addDocumentEvent(slug, 'proxy.marked', {
      for: human,
      familiar,
      count: written.length,
      withdrawn: entries.filter(e => !e.status).length,
      statuses: [...new Set(written.map(p => p.status))],
      lines: entries.slice(0, 50).map(e => ({ lineIndex: e.line.index, status: e.status ?? 'unseen', confidence: e.confidence, excerpt: e.line.text.slice(0, 80) })),
    }, familiar);
  } catch (error) {
    console.warn('[proxy-marks] failed to record event', { slug, error: String(error) });
  }
  broadcastToRoom(slug, { type: 'line-marks.updated', by: familiar, timestamp: at });
  return {
    status: 200,
    body: {
      success: true,
      for: human,
      familiar,
      count: written.length,
      replaced: removed,
      proxies: written.map(p => ({ ...p, lineIndex: entries.find(e => e.line.hash === p.anchor.hash && e.line.occurrence === p.anchor.occurrence)?.line.index ?? null })),
      note: 'Proxy marks never count as the person\'s marks until they ratify them.',
    },
  };
}

// ============================================================================
// The brief (server evaluation, for /state and for ratify)
// ============================================================================

export async function issueReportFor(slug: string, markdown: string, rawMarks: unknown): Promise<IssueReport> {
  return buildIssueReport(slug, markdown, rawMarks, {
    asks: (lines) => buildAskReport(slug, lines).issueInputs,
    teamExtra: askTeamActors(listCanonicalAsks(slug)),
  });
}

/** Lines that carry a pending suggestion (from the stored marks' quotes). */
function suggestionLines(lines: DocLine[], rawMarks: unknown): number[] {
  const out: number[] = [];
  for (const mark of reviewMarksFromStored(rawMarks)) {
    if (!mark.open || mark.kind === 'comment') continue;
    const index = lineOfQuote(lines, mark.quote);
    if (index >= 0) out.push(index);
  }
  return out;
}

export function briefFor(slug: string, human: string, report: IssueReport, rawMarks: unknown, proxies?: ProxyMark[]): ProxyBrief {
  const lines = report.docLines ?? [];
  const binding = familiarOf(slug, human);
  const states = buildLineStates(lines, report.lineMarks);
  return evaluateProxies({
    proxies: proxies ?? listProxyMarks(slug, { for: human }),
    human,
    familiar: binding?.familiar ?? null,
    lines,
    states,
    held: heldLines({ issues: report.issues, human, suggestionLines: suggestionLines(lines, rawMarks) }),
    humanIssueLines: humanIssueLines(report.issues, human),
  });
}

function serializeItem(item: ProxyItem): Record<string, unknown> {
  return {
    proxyId: item.proxy.id,
    lineIndex: item.lineIndex,
    status: item.proxy.status,
    confidence: item.proxy.confidence,
    evidence: item.proxy.evidence,
    bucket: item.bucket,
    held: item.held,
    carried: item.carried,
    at: item.proxy.at,
    excerpt: item.proxy.anchor.excerpt,
  };
}

export function serializeBrief(brief: ProxyBrief): Record<string, unknown> {
  return {
    for: brief.human,
    familiar: brief.familiar,
    counts: brief.counts,
    threshold: PROXY_POLICY.ratifyThreshold,
    items: brief.items.map(serializeItem),
    reset: brief.reset.map(p => ({ proxyId: p.id, status: p.status, excerpt: p.anchor.excerpt, at: p.at })),
    moot: brief.moot,
  };
}

/** /state: every binding and, per person, their Familiar's current proxies (never counted). */
export function proxyStateReport(slug: string, report: IssueReport, rawMarks: unknown, options: { viewer?: string } = {}): {
  familiars: FamiliarBinding[];
  proxies: Record<string, Record<string, unknown>>;
  unratified: number;
} {
  const familiars = listFamiliars(slug);
  const all = listProxyMarks(slug);
  const proxies: Record<string, Record<string, unknown>> = {};
  let unratified = 0;
  for (const binding of familiars) {
    // Blind marking: a viewer sees a person's proxies only when it is that person or their Familiar.
    if (options.viewer !== undefined && actorKey(options.viewer) !== actorKey(binding.human) && actorKey(options.viewer) !== actorKey(binding.familiar)) continue;
    const brief = briefFor(slug, binding.human, report, rawMarks, all.filter(p => actorKey(p.for) === actorKey(binding.human)));
    unratified += brief.items.length;
    proxies[binding.human] = serializeBrief(brief);
  }
  return { familiars, proxies, unratified };
}

// ============================================================================
// Ratify and Undo (the person, from the page)
// ============================================================================

/**
 * The person ratifies the proxy-agreed lines they were shown ("Ratify all"). Only items that are
 * still in the ratify set now (current, at or above the threshold, not held, not yet marked by the
 * person) are written; the rest come back in `skipped`. One transaction, one event.
 */
export async function ratifyProxies(slug: string, input: { human: string; proxyIds: unknown; markdown: string; rawMarks: unknown }): Promise<Result> {
  const human = input.human;
  const binding = familiarOf(slug, human);
  if (!binding) return fail(409, 'NOT_BOUND', 'Choose your Familiar first');
  if (!Array.isArray(input.proxyIds) || input.proxyIds.length === 0) return fail(400, 'INVALID_PROXIES', '"proxyIds" must list the proxy marks you were shown');
  const wanted = new Set(input.proxyIds.filter((id): id is string => typeof id === 'string' && id.length <= 64).slice(0, PROXY_POLICY.maxLinesPerRequest));
  const report = await issueReportFor(slug, input.markdown, input.rawMarks);
  const brief = briefFor(slug, human, report, input.rawMarks);
  const lines = report.docLines ?? [];
  const eligible = brief.ratify.filter(item => wanted.has(item.proxy.id));
  const skipped: Array<{ proxyId: string; reason: string }> = [];
  for (const id of wanted) {
    if (eligible.some(item => item.proxy.id === id)) continue;
    const item = brief.items.find(i => i.proxy.id === id);
    skipped.push({ proxyId: id, reason: item ? `not in Ratify all now (${item.bucket}${item.held.length ? `: ${item.held.join(', ')}` : ''})` : 'reset, already marked by you, or not yours' });
  }
  if (eligible.length === 0) return fail(409, 'NOTHING_TO_RATIFY', 'None of these proxy marks can be ratified now', { skipped });
  const me = actorKey(human);
  const before = listDocumentLineMarks(slug).filter(row => row.actor_key === me);
  const ratificationId = randomUUID();
  const hashes = new Set(lines.map(line => line.hash));
  const plan = eligible.map(item => {
    const line = lines[item.lineIndex];
    const anchor = anchorForLine(line);
    // The person's earlier rows on this line: the same text, or a stale mark in the line's slot.
    const previous = before.filter(row => (row.line_hash === anchor.hash && row.line_occurrence === anchor.occurrence)
      || (!hashes.has(row.line_hash) && row.line_ordinal === line.index));
    return { item, line, anchor, previous };
  });
  const result = writeLineMarksBatch(slug, {
    by: human,
    status: 'agreed',
    via: PROXY_POLICY.ratifiedVia,
    allowServerVias: true,
    canApprove: false,
    source: 'page',
    lines: plan.map(({ item, anchor, previous }) => ({
      anchor,
      replaceIds: previous.map(row => row.id),
      evidence: item.proxy.evidence,
      proxy: { familiar: binding.familiar, proxyId: item.proxy.id, confidence: item.proxy.confidence, evidence: item.proxy.evidence, ratificationId },
    })),
    context: { ratificationId, familiar: binding.familiar },
  });
  if (result.status !== 200) return result;
  const marks = (result.body.lineMarks as Array<{ id: string } | null>) ?? [];
  const entries: RatificationEntry[] = plan.map(({ item, anchor, previous }, i) => ({
    proxyId: item.proxy.id,
    lineMarkId: marks[i]?.id ?? '',
    anchor: { hash: anchor.hash, occurrence: anchor.occurrence, excerpt: anchor.excerpt },
    previous,
  }));
  const at = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO document_proxy_ratifications (id, document_slug, human_actor, human_key, familiar_actor, at, entries_json, undone_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(ratificationId, slug, human, me, binding.familiar, at, JSON.stringify(entries));
  try {
    addDocumentEvent(slug, 'proxy.ratified', {
      ratificationId,
      for: human,
      familiar: binding.familiar,
      count: entries.length,
      threshold: PROXY_POLICY.ratifyThreshold,
      // The ringer list: name every line the one click covered, with the Familiar's evidence.
      lines: eligible.map(item => ({ lineIndex: item.lineIndex, excerpt: lines[item.lineIndex]?.text.slice(0, 120) ?? '', confidence: item.proxy.confidence, evidence: item.proxy.evidence })),
      skipped: skipped.length,
    }, human);
  } catch (error) {
    console.warn('[proxy-marks] failed to record ratify event', { slug, error: String(error) });
  }
  return {
    status: 200,
    body: {
      success: true,
      ratification: {
        id: ratificationId,
        at,
        familiar: binding.familiar,
        count: entries.length,
        lines: eligible.map(item => ({ proxyId: item.proxy.id, lineIndex: item.lineIndex, confidence: item.proxy.confidence, evidence: item.proxy.evidence })),
      },
      skipped,
    },
  };
}

/** Undo one ratification: each line gets back exactly what it held before, in one transaction. */
export function undoRatification(slug: string, input: { human: string; id: string }): Result {
  const ratification = getRatification(slug, input.id);
  if (!ratification || actorKey(ratification.human) !== actorKey(input.human)) return fail(404, 'RATIFICATION_NOT_FOUND', 'No such ratification of yours');
  if (ratification.undoneAt) return fail(409, 'ALREADY_UNDONE', 'This ratification was already undone');
  if (Date.now() - Date.parse(ratification.at) > PROXY_POLICY.undoWindowMs) return fail(409, 'UNDO_EXPIRED', 'This ratification is too old to undo; mark the lines yourself');
  const me = actorKey(input.human);
  const restored: string[] = [];
  const skipped: Array<{ proxyId: string; reason: string }> = [];
  const at = new Date().toISOString();
  assertWritesAllowed('undoRatification');
  const d = getDb();
  d.transaction(() => {
    const exists = d.prepare(`SELECT id FROM document_line_marks WHERE document_slug = ? AND actor_key = ? AND id = ?`);
    const del = d.prepare(`DELETE FROM document_line_marks WHERE document_slug = ? AND actor_key = ? AND id = ?`);
    const ins = d.prepare(`
      INSERT OR REPLACE INTO document_line_marks (id, document_slug, by_actor, actor_key, status, reason, line_hash, line_occurrence,
        line_ordinal, line_kind, line_excerpt, created_at, updated_at, via, line_text, why, evidence, proxy_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of ratification.entries) {
      // The person marked the line again since: keep their newer mark.
      if (!entry.lineMarkId || !exists.get(slug, me, entry.lineMarkId)) { skipped.push({ proxyId: entry.proxyId, reason: 'you marked this line again since' }); continue; }
      del.run(slug, me, entry.lineMarkId);
      for (const row of entry.previous) {
        ins.run(row.id, slug, row.by_actor, row.actor_key, row.status, row.reason, row.line_hash, row.line_occurrence, row.line_ordinal,
          row.line_kind, row.line_excerpt, row.created_at, row.updated_at, row.via ?? null, row.line_text ?? null, row.why ?? null,
          row.evidence ?? null, row.proxy_json ?? null);
      }
      restored.push(entry.proxyId);
    }
    d.prepare(`UPDATE document_proxy_ratifications SET undone_at = ? WHERE document_slug = ? AND id = ?`).run(at, slug, ratification.id);
  })();
  try {
    addDocumentEvent(slug, 'proxy.ratify_undone', { ratificationId: ratification.id, for: ratification.human, familiar: ratification.familiar, restored: restored.length, skipped: skipped.length }, input.human);
  } catch { /* best effort */ }
  broadcastToRoom(slug, { type: 'line-marks.updated', by: input.human, timestamp: at });
  return { status: 200, body: { success: true, id: ratification.id, restored: restored.length, skipped } };
}
