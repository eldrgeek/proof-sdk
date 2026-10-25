/**
 * Accord — multi-party dispositions on the server: storage, the roster, and the gate that the
 * accept and reject routes pass through. The rules are in src/shared/dispositions.ts.
 *
 * A document opts in (`document_multiparty_settings.enabled`). On a document that has not opted
 * in, the gate does nothing and accept and reject behave exactly as before.
 *
 * On a document that has opted in, accept records a promote and reject records a cut. The
 * suggestion is applied (accepted) only when every participant has promoted it, and rejected only
 * when every participant has cut it. Otherwise the disposition is recorded, the suggestion stays
 * pending, and the route answers 200 with the proposal's piles.
 */
import { addDocumentEvent, assertWritesAllowed, getDb } from './db.js';
import { documentOwnerActors } from './line-marks.js';
import { currentTeam } from './proof-extras.js';
import { actorKey } from '../src/shared/line-marks.js';
import {
  DISPOSITION_POLICY,
  dispositionRefusal,
  evaluateProposal,
  evaluateProposals,
  finalizeAction,
  isFullAccord,
  whereWeDiffer,
  type Disposition,
  type DispositionRecord,
  type ProposalRef,
  type ProposalView,
  type RosterEntry,
} from '../src/shared/dispositions.js';

export interface MultiPartySettings {
  enabled: boolean;
  observers: string[];
  setBy: string | null;
  setAt: string | null;
}

export function getMultiPartySettings(slug: string): MultiPartySettings {
  try {
    const row = getDb().prepare(`SELECT enabled, observers_json, set_by, set_at FROM document_multiparty_settings WHERE document_slug = ?`)
      .get(slug) as { enabled: number; observers_json: string; set_by: string | null; set_at: string | null } | undefined;
    if (!row) return { enabled: DISPOSITION_POLICY.multiPartyDefault, observers: [], setBy: null, setAt: null };
    let observers: string[] = [];
    try {
      const parsed = JSON.parse(row.observers_json) as unknown;
      if (Array.isArray(parsed)) observers = parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    } catch { /* keep none */ }
    return { enabled: row.enabled === 1, observers, setBy: row.set_by, setAt: row.set_at };
  } catch {
    return { enabled: DISPOSITION_POLICY.multiPartyDefault, observers: [], setBy: null, setAt: null };
  }
}

export function setMultiPartySettings(slug: string, input: { enabled?: unknown; observers?: unknown; by: string }): MultiPartySettings {
  assertWritesAllowed('setMultiPartySettings');
  const current = getMultiPartySettings(slug);
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : current.enabled;
  const observers = Array.isArray(input.observers)
    ? [...new Set(input.observers.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim()))]
    : current.observers;
  const at = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO document_multiparty_settings (document_slug, enabled, observers_json, set_by, set_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(document_slug) DO UPDATE SET enabled = excluded.enabled, observers_json = excluded.observers_json, set_by = excluded.set_by, set_at = excluded.set_at
  `).run(slug, enabled ? 1 : 0, JSON.stringify(observers), input.by, at);
  addDocumentEvent(slug, 'multiparty.settings', { enabled, observers }, input.by);
  return { enabled, observers, setBy: input.by, setAt: at };
}

export function listDispositions(slug: string): DispositionRecord[] {
  const rows = getDb().prepare(`SELECT mark_id, by_actor, disposition, at FROM document_mark_dispositions WHERE document_slug = ? ORDER BY at ASC, id ASC`)
    .all(slug) as Array<{ mark_id: string; by_actor: string; disposition: Disposition; at: string }>;
  return rows.map(row => ({ markId: row.mark_id, by: row.by_actor, disposition: row.disposition, at: row.at }));
}

export function recordDisposition(slug: string, record: DispositionRecord, source: 'page' | 'agent'): void {
  assertWritesAllowed('recordDisposition');
  getDb().prepare(`
    INSERT INTO document_mark_dispositions (document_slug, mark_id, by_actor, actor_key, disposition, source, at) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(slug, record.markId, record.by, actorKey(record.by), record.disposition, source, record.at);
  addDocumentEvent(slug, 'disposition.recorded', { markId: record.markId, disposition: record.disposition, by: record.by }, record.by);
}

/**
 * The roster: the document's Owner, everyone the team computation already counts (people who
 * marked, commented, proposed or asked, and active agent keys), everyone who has disposed of a
 * proposal, and the actor deciding now.
 * Settings name observers, who argue but do not dispose.
 */
export function rosterFor(slug: string, rawMarks: unknown, extra: string[] = []): RosterEntry[] {
  const settings = getMultiPartySettings(slug);
  const observerKeys = new Set(settings.observers.map(actorKey));
  const ownerKeys = new Set(documentOwnerActors(slug).map(actorKey));
  const seen = new Set<string>();
  const roster: RosterEntry[] = [];
  const add = (actor: string) => {
    const key = actorKey(actor);
    if (!key || seen.has(key)) return;
    seen.add(key);
    roster.push({ actor, role: ownerKeys.has(key) ? 'owner' : observerKeys.has(key) ? 'observer' : 'participant' });
  };
  for (const owner of documentOwnerActors(slug)) add(owner);
  for (const member of currentTeam(slug, rawMarks)) add(member);
  for (const member of extra) add(member);
  // Anyone who has promoted or cut before is a participant from then on.
  for (const record of listDispositions(slug)) add(record.by);
  for (const observer of settings.observers) add(observer);
  return roster;
}

function pendingSuggestions(rawMarks: unknown): ProposalRef[] {
  if (!rawMarks || typeof rawMarks !== 'object' || Array.isArray(rawMarks)) return [];
  const out: ProposalRef[] = [];
  for (const [markId, mark] of Object.entries(rawMarks as Record<string, unknown>)) {
    if (!mark || typeof mark !== 'object') continue;
    const m = mark as { kind?: unknown; by?: unknown; status?: unknown };
    if (m.kind !== 'insert' && m.kind !== 'delete' && m.kind !== 'replace') continue;
    if (m.status !== 'pending') continue;
    out.push({ markId, by: typeof m.by === 'string' && m.by.trim() ? m.by.trim() : 'owner' });
  }
  return out;
}

export function serializeProposalView(view: ProposalView): Record<string, unknown> {
  return {
    markId: view.markId,
    proposer: view.proposer,
    status: view.status,
    openFor: view.openFor,
    promotedBy: view.promotedBy,
    cutBy: view.cutBy,
    disagree: view.disagree,
  };
}

/** GET /dispositions: the roster, every open proposal's piles, where we differ, and full accord. */
export function dispositionsReport(slug: string, rawMarks: unknown): Record<string, unknown> {
  const settings = getMultiPartySettings(slug);
  const roster = rosterFor(slug, rawMarks);
  const views = evaluateProposals(pendingSuggestions(rawMarks), roster, listDispositions(slug));
  return {
    multiParty: settings.enabled,
    observers: settings.observers,
    roster,
    proposals: views.map(serializeProposalView),
    whereWeDiffer: whereWeDiffer(views).map(view => view.markId),
    fullAccord: isFullAccord(views),
    policy: DISPOSITION_POLICY,
  };
}

export type DispositionOutcome =
  | { kind: 'off' }
  | { kind: 'not-pending' }
  | { kind: 'refused'; status: number; body: Record<string, unknown> }
  | { kind: 'recorded'; record: DispositionRecord; view: ProposalView; action: 'accept' | 'reject' | 'hold' };

/** Records one person's disposition on a pending suggestion and evaluates the proposal. */
export function applyDisposition(slug: string, input: {
  markId: unknown;
  by: string;
  disposition: Disposition;
  rawMarks: unknown;
  source: 'page' | 'agent';
}): DispositionOutcome {
  if (!getMultiPartySettings(slug).enabled) return { kind: 'off' };
  const markId = typeof input.markId === 'string' ? input.markId : '';
  const proposal = markId ? pendingSuggestions(input.rawMarks).find(p => p.markId === markId) : undefined;
  if (!proposal) return { kind: 'not-pending' };
  const roster = rosterFor(slug, input.rawMarks, [input.by]);
  const refusal = dispositionRefusal(roster, input.by);
  if (refusal) return { kind: 'refused', status: 403, body: { success: false, ...refusal } };
  const record: DispositionRecord = { markId, by: input.by, disposition: input.disposition, at: new Date().toISOString() };
  recordDisposition(slug, record, input.source);
  const view = evaluateProposal(proposal, roster, listDispositions(slug));
  return { kind: 'recorded', record, view, action: finalizeAction(view) };
}

export type GateResult =
  | { handled: false }
  | { handled: true; status: number; body: Record<string, unknown> };

/**
 * Called by POST /marks/accept (promote) and POST /marks/reject (cut) before the engine runs.
 * `handled: false` lets the route finalize the suggestion as before: either the document has not
 * opted in, or this disposition completed unanimity in the same direction.
 */
export function dispositionGate(slug: string, input: {
  markId: unknown;
  by: string;
  disposition: 'promote' | 'cut';
  rawMarks: unknown;
  source: 'page' | 'agent';
}): GateResult {
  const outcome = applyDisposition(slug, input);
  if (outcome.kind === 'off' || outcome.kind === 'not-pending') return { handled: false };
  if (outcome.kind === 'refused') return { handled: true, status: outcome.status, body: outcome.body };
  const { record, view, action } = outcome;
  if ((action === 'accept' && input.disposition === 'promote') || (action === 'reject' && input.disposition === 'cut')) {
    return { handled: false };
  }
  return {
    handled: true,
    status: 200,
    body: {
      success: true,
      multiParty: true,
      disposition: { markId: record.markId, by: record.by, disposition: record.disposition, at: record.at },
      proposal: serializeProposalView(view),
      marks: input.rawMarks,
    },
  };
}
