/**
 * Proof Documents Step B6 — server side of identity: who a request acts as, and the directory
 * (merges, member names, display labels) that reads stored marks and answers.
 *
 * Authorship: brief by the COS (Mike Wolf's Proof Documents spec); built by Claude Opus 5
 * (worker proof-identity), 2026-09-18.
 *
 * Trust order for a write (first match wins):
 *   1. an "Add agent" key (a labelled document_access token)  -> ai:<key-name>
 *   2. a Documents library session cookie (proof_library_session; with SOMA Auth on, only a
 *      session the server verified against SOMA Auth)            -> human:<email>
 *   3. the document owner's credential (scripts)                  -> the "by" it names
 *   4. agent API with a share token that is not a key             -> the "ai:" it names
 *   5. anyone else on the page (share-link viewer)                -> guest:<typed name>
 * The "by" a client sends never raises trust: it is ignored under a session and must match
 * the key's AI under an agent key.
 */
import { getDb } from './db.js';
import { actorKey, agentKeyActor, registerActorLabels } from '../src/shared/line-marks.js';
import {
  IDENTITY_POLICY,
  actorBody,
  canonicalActor,
  guestActor,
  isEmailAddress,
  normalizeActorString,
  resolveTargetActor,
  verifiedHumanActor,
  type ActorTrust,
  type IdentityDirectory,
} from '../src/shared/identity.js';

export type ActorSource = 'agent-key' | 'session' | 'owner-credential' | 'share-token' | 'guest';

export type ActorDecision =
  | { ok: true; actor: string; trust: ActorTrust; source: ActorSource }
  | { ok: false; status: number; body: Record<string, unknown> };

export interface SessionIdentity {
  memberId: string;
  name: string;
  email: string | null;
}

const MAX_ACTOR = 120;

function typedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.length > MAX_ACTOR || /[\x00-\x1f\x7f]/.test(trimmed)) return null;
  return trimmed;
}

function deny(status: number, code: string, error: string, extra: Record<string, unknown> = {}): ActorDecision {
  return { ok: false, status, body: { success: false, code, error, ...extra } };
}

/** Decides who a request acts as. Pure: the routes gather the credentials and pass them in. */
export function decideActor(input: {
  mode: 'page' | 'agent';
  typedBy: unknown;
  agentKeyLabel?: string | null;
  session?: SessionIdentity | null;
  /** False when a session request came from another origin (see IDENTITY_POLICY). */
  sessionOriginOk?: boolean;
  ownerCredential?: boolean;
  /** AIs that own an active agent key in this document. */
  activeKeyActors?: string[];
}): ActorDecision {
  const typed = typedString(input.typedBy);
  if (input.agentKeyLabel) {
    const keyActor = agentKeyActor(input.agentKeyLabel);
    if (typed && actorKey(normalizeActorString(typed)) !== actorKey(keyActor) && IDENTITY_POLICY.agentKeyConflictingBy === 'reject') {
      return deny(403, 'ACTOR_MISMATCH', `This agent key acts as "${keyActor}". Leave out "by", or send "by": "${keyActor}".`, { actor: keyActor });
    }
    return { ok: true, actor: keyActor, trust: 'ai', source: 'agent-key' };
  }
  if (input.session && input.session.email && isEmailAddress(input.session.email)) {
    if (input.sessionOriginOk === false && IDENTITY_POLICY.sessionWritesRequireSameOrigin) {
      return deny(403, 'CROSS_ORIGIN', 'A signed-in write must come from this site');
    }
    return { ok: true, actor: verifiedHumanActor(input.session.email), trust: 'verified', source: 'session' };
  }
  if (input.ownerCredential && IDENTITY_POLICY.ownerCredentialMayActAsAnyone) {
    if (!typed) return deny(400, 'INVALID_ACTOR', 'Pass "by" (for example "human:mw@mike-wolf.com" or "ai:claude")');
    const actor = normalizeActorString(typed);
    return { ok: true, actor, trust: actorTrustOf(actor), source: 'owner-credential' };
  }
  if (input.mode === 'agent') {
    if (!typed) return deny(400, 'INVALID_ACTOR', 'Pass "by", for example "ai:claude"');
    const actor = normalizeActorString(typed);
    if (!/^ai:/i.test(actor)) {
      return deny(403, 'AI_ACTOR_REQUIRED', 'An agent key acts as an AI: "by" must start with "ai:"');
    }
    if (IDENTITY_POLICY.shareTokenMayNotClaimKeyAi && (input.activeKeyActors ?? []).some(a => actorKey(a) === actorKey(actor))) {
      return deny(403, 'ACTOR_RESERVED', `"${actor}" belongs to an agent key in this document; use that key`);
    }
    return { ok: true, actor, trust: 'ai', source: 'share-token' };
  }
  return { ok: true, actor: guestActor(typed ?? ''), trust: 'guest', source: 'guest' };
}

function actorTrustOf(actor: string): ActorTrust {
  if (/^ai:/i.test(actor)) return 'ai';
  if (/^human:/i.test(actor) && isEmailAddress(actor.slice(6))) return 'verified';
  return 'guest';
}

// ============================================================================
// Directory
// ============================================================================

type MemberRow = { id: string; name: string; email: string | null };

function listActiveMembers(): MemberRow[] {
  try {
    return getDb().prepare(`SELECT id, name, email FROM library_members WHERE removed_at IS NULL`).all() as MemberRow[];
  } catch {
    return []; // Library tables are optional in bare SDK deployments.
  }
}

export function listMerges(slug: string | null): Array<{ scope: string; fromKey: string; intoActor: string; createdAt: string; createdBy: string | null; note: string | null }> {
  try {
    const rows = (slug
      ? getDb().prepare(`SELECT * FROM identity_merges WHERE scope IN (?, '*') ORDER BY created_at`).all(slug)
      : getDb().prepare(`SELECT * FROM identity_merges ORDER BY scope, created_at`).all()) as Array<{
        scope: string; from_key: string; into_actor: string; created_at: string; created_by: string | null; note: string | null;
      }>;
    return rows.map(row => ({ scope: row.scope, fromKey: row.from_key, intoActor: row.into_actor, createdAt: row.created_at, createdBy: row.created_by, note: row.note }));
  } catch {
    return [];
  }
}

/** The full directory for one document (server use). */
export function buildDirectory(slug: string): IdentityDirectory {
  const names: Record<string, string> = {};
  const labels: Record<string, string> = {};
  for (const member of listActiveMembers()) {
    if (!member.email || !isEmailAddress(member.email)) continue;
    const actor = verifiedHumanActor(member.email);
    labels[actorKey(actor)] = member.name;
    const nameKey = member.name.replace(/\s+/g, ' ').trim().toLowerCase();
    // A name two members share is reserved for nobody ("").
    if (nameKey) names[nameKey] = nameKey in names && names[nameKey] !== actor ? '' : actor;
    names[member.email.trim().toLowerCase()] = actor;
  }
  const merges: IdentityDirectory['merges'] = {};
  // Document-scoped merges win over global ones (ordered after them).
  for (const merge of listMerges(slug).sort((a, b) => (a.scope === '*' ? 0 : 1) - (b.scope === '*' ? 0 : 1))) {
    merges[merge.fromKey] = { into: merge.intoActor, before: merge.createdAt };
  }
  const dir = { merges, names, labels };
  registerActorLabels(labels);
  return dir;
}

/**
 * The part of the directory a page needs for the actors it will meet: nothing about members
 * who have no part in this document is sent to a share-link viewer.
 */
export function clientDirectory(dir: IdentityDirectory, actors: string[]): IdentityDirectory {
  const out: IdentityDirectory = { merges: {}, names: {}, labels: {} };
  for (const raw of actors) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const normalizedKey = actorKey(normalizeActorString(raw));
    if (dir.merges[normalizedKey]) out.merges[normalizedKey] = dir.merges[normalizedKey];
    const body = actorBody(raw).toLowerCase();
    if (body in dir.names) out.names[body] = dir.names[body];
    for (const actor of [canonicalActor(raw, dir), resolveTargetActor(raw, dir)]) {
      const label = dir.labels[actorKey(actor)];
      if (label) out.labels[actorKey(actor)] = label;
    }
  }
  return out;
}

export function sessionIdentity(member: { id: string; name: string; email: string | null } | null | undefined): SessionIdentity | null {
  if (!member) return null;
  return { memberId: member.id, name: member.name, email: member.email };
}

// ============================================================================
// Merges (COS only, on explicit request)
// ============================================================================

export function mergeIdentity(input: { from: string; into: string; scope: string; createdBy?: string | null; note?: string | null }):
  { fromKey: string; intoActor: string; scope: string } {
  const from = normalizeActorString(input.from);
  const into = normalizeActorString(input.into);
  if (!from) throw new Error('--from is required');
  if (!/^guest:/i.test(from)) throw new Error(`Only a typed-name actor can be merged (got "${from}"); verified people and AIs keep their identity`);
  if (!/^human:/i.test(into) || !isEmailAddress(into.slice(6))) throw new Error(`--into must be a verified person, human:<email> (got "${into}")`);
  const scope = input.scope.trim() || '*';
  getDb().prepare(`
    INSERT INTO identity_merges (scope, from_key, into_actor, created_at, created_by, note)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, from_key) DO UPDATE SET into_actor = excluded.into_actor,
      created_at = excluded.created_at, created_by = excluded.created_by, note = excluded.note
  `).run(scope, actorKey(from), into, new Date().toISOString(), input.createdBy ?? null, input.note ?? null);
  return { fromKey: actorKey(from), intoActor: into, scope };
}

export function unmergeIdentity(input: { from: string; scope: string }): boolean {
  const from = normalizeActorString(input.from);
  const result = getDb().prepare(`DELETE FROM identity_merges WHERE scope = ? AND from_key = ?`).run(input.scope.trim() || '*', actorKey(from));
  return result.changes > 0;
}

/** Every actor string stored for a document (marks, asks, answers), with counts: for the COS. */
export function listDocumentActors(slug: string): Array<{ actor: string; normalized: string; canonical: string; lineMarks: number; asks: number; answers: number }> {
  const dir = buildDirectory(slug);
  const counts = new Map<string, { lineMarks: number; asks: number; answers: number }>();
  const bump = (actor: string, field: 'lineMarks' | 'asks' | 'answers') => {
    const entry = counts.get(actor) ?? { lineMarks: 0, asks: 0, answers: 0 };
    entry[field] += 1;
    counts.set(actor, entry);
  };
  const db = getDb();
  for (const row of db.prepare(`SELECT by_actor FROM document_line_marks WHERE document_slug = ?`).all(slug) as Array<{ by_actor: string }>) bump(row.by_actor, 'lineMarks');
  for (const row of db.prepare(`SELECT by_actor FROM document_asks WHERE document_slug = ? AND withdrawn_at IS NULL`).all(slug) as Array<{ by_actor: string }>) bump(row.by_actor, 'asks');
  for (const row of db.prepare(`SELECT by_actor FROM document_ask_answers WHERE document_slug = ?`).all(slug) as Array<{ by_actor: string }>) bump(row.by_actor, 'answers');
  return [...counts.entries()].map(([actor, c]) => ({ actor, normalized: normalizeActorString(actor), canonical: canonicalActor(actor, dir), ...c }));
}

export { guestActor };
