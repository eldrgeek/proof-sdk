/**
 * Proof Documents — Step B6: marks and answers name a verified person or a named AI.
 *
 * Authorship: direction by Mike Wolf (Proof Documents spec, "identity tied to sign-in");
 * brief by the COS; built by Claude Opus 5 (worker proof-identity), 2026-09-18. Rules marked
 * POLICY are Claude's decisions where the brief is silent, each a one-line change.
 *
 * Pure code shared by the browser and the server. Three kinds of actor:
 *   human:<email>   a person the server verified through a SOMA Auth / Documents library session;
 *   ai:<key-name>   an AI that presented an "Add agent" key (the key's name, slugged);
 *   guest:<name>    a share-link viewer who typed a name. Shown as unverified everywhere.
 *
 * Stored rows are never rewritten. Old rows keep the typed names they were written with
 * ("human:Mike"); reading them goes through canonicalActor, which treats a typed human name as
 * the guest it always was, then applies explicit merges (made by the COS with
 * `server/library/cli.ts merge-identity`). So one person is one team member once merged.
 */
import { actorKey, type LineMark } from './line-marks.js';
import type { ProofAsk } from './asks.js';

// ============================================================================
// POLICY (Claude's decisions where the brief is silent)
// ============================================================================

export const IDENTITY_POLICY = {
  /**
   * A request made with an agent key always acts as that key's AI. A "by" naming anyone else is
   * rejected with 403 ACTOR_MISMATCH ('reject'), not silently replaced ('ignore'), so the AI
   * learns who it is instead of believing it wrote as someone it did not.
   */
  agentKeyConflictingBy: 'reject' as 'reject' | 'ignore',
  /** A token that is not an agent key (a share link token) may only act as an AI it names, and
   *  never as an AI that owns an active agent key in this document. */
  shareTokenMayNotClaimKeyAi: true,
  /** The document owner's credential (scripts) may act as any actor it names, humans included. */
  ownerCredentialMayActAsAnyone: true,
  /** A typed human name in stored data ("human:Mike") is read as the guest it was ("guest:Mike"). */
  legacyTypedHumanIsGuest: true,
  /**
   * An ask addressed to a bare name that no Documents member holds ("Ada") can be answered by a
   * guest who typed that name. A name a member holds ("Mike Wolf") resolves to that member's
   * verified identity and a guest typing it does not count.
   */
  guestsMayAnswerUnreservedNames: true,
  /** An ask with an empty "to" (any human but the asker) is closed by verified humans and by
   *  guests alike until teams exist; guest answers carry the guest badge. */
  emptyToCountsGuests: true,
  /** A signed-in session is honoured on a write only when the request's Origin (if any) is this
   *  server's public origin: sibling apps on the same site cannot write as the signed-in person. */
  sessionWritesRequireSameOrigin: true,
  /** Documents admins have Owner rights (Approve, re-ask, withdraw) on every document ... */
  adminsHaveOwnerRights: true,
  /** ... but only the creator joins every document's team (admins join when they take part). */
  adminsJoinTeam: false,
  /** Suffix shown after a guest's name wherever names are shown. */
  guestSuffix: ' (guest)',
  maxGuestName: 48,
} as const;

// ============================================================================
// Actor strings
// ============================================================================

export type ActorTrust = 'verified' | 'ai' | 'guest';

const EMAIL_RE = /^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/;

export function isEmailAddress(value: string): boolean {
  return EMAIL_RE.test(String(value ?? '').trim());
}

function collapse(value: string): string {
  return String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** The typed part of an actor (no human: / guest: / ai: prefix). */
export function actorBody(actor: string): string {
  return collapse(String(actor ?? '').replace(/^(human|ai|guest):/i, ''));
}

export function guestActor(name: string): string {
  const clean = collapse(String(name ?? '').replace(/^(human|ai|guest):/i, '')).slice(0, IDENTITY_POLICY.maxGuestName);
  return `guest:${clean || 'Anonymous'}`;
}

export function verifiedHumanActor(email: string): string {
  return `human:${collapse(email).toLowerCase()}`;
}

export function isGuestActor(actor: string): boolean {
  return /^guest:/i.test(String(actor ?? '').trim());
}

export function isVerifiedHumanActor(actor: string): boolean {
  const trimmed = String(actor ?? '').trim();
  return /^human:/i.test(trimmed) && isEmailAddress(trimmed.slice(6));
}

/** verified: human:<email>; ai: ai:*; guest: everything else (typed names, old rows). */
export function actorTrust(actor: string): ActorTrust {
  const trimmed = String(actor ?? '').trim();
  if (/^ai:/i.test(trimmed)) return 'ai';
  if (isVerifiedHumanActor(trimmed)) return 'verified';
  return 'guest';
}

/**
 * The form an actor string is stored and compared in, before merges:
 * human:<email> is lower-cased; a typed human name becomes guest:<name> (policy); a bare name is
 * a guest; ai: and guest: keep their text.
 */
export function normalizeActorString(actor: string): string {
  const trimmed = collapse(actor);
  if (!trimmed) return trimmed;
  if (/^ai:/i.test(trimmed)) return `ai:${trimmed.slice(3).trim()}`;
  if (/^guest:/i.test(trimmed)) return guestActor(trimmed.slice(6));
  if (/^human:/i.test(trimmed)) {
    const body = trimmed.slice(6).trim();
    if (isEmailAddress(body)) return verifiedHumanActor(body);
    return IDENTITY_POLICY.legacyTypedHumanIsGuest ? guestActor(body) : `human:${body}`;
  }
  if (isEmailAddress(trimmed)) return verifiedHumanActor(trimmed);
  return guestActor(trimmed);
}

// ============================================================================
// The directory: merges, name targets and labels for one document
// ============================================================================

export interface IdentityDirectory {
  /**
   * actorKey(normalized actor) -> the verified actor it was merged into (explicit merges only),
   * and the merge's time. A merge covers what that actor wrote up to the merge, never later:
   * a guest who types the same name afterwards is still a guest.
   */
  merges: Record<string, { into: string; before: string }>;
  /**
   * Lower-cased display name or email -> the verified actor that holds it. Used only to resolve
   * who an ask is for, who owns a document and who wrote a comment (team membership), never to
   * attribute a mark or an answer. A name two members share maps to "" (reserved, nobody).
   */
  names: Record<string, string>;
  /** actorKey(actor) -> display name (verified humans: their Documents profile name). */
  labels: Record<string, string>;
}

export const EMPTY_DIRECTORY: IdentityDirectory = Object.freeze({ merges: {}, names: {}, labels: {} }) as IdentityDirectory;

/**
 * Who did it: normalized, then explicit merges. Never resolves a typed name by itself.
 * `at` is when the row was written: a merge applies only to rows written up to the merge.
 * Leave `at` out only where no attribution depends on it (team membership, listings).
 */
export function canonicalActor(actor: string, dir: IdentityDirectory = EMPTY_DIRECTORY, at?: string): string {
  const normalized = normalizeActorString(actor);
  if (!normalized) return normalized;
  const merge = dir.merges[actorKey(normalized)];
  if (!merge) return normalized;
  if (at !== undefined && String(at) > String(merge.before)) return normalized;
  return merge.into;
}

/**
 * Who is meant: an entry in an ask's "to", an owner, or a comment author for team membership.
 * A name or email a Documents member holds resolves to that member's verified identity;
 * otherwise the entry is read like an actor (an unreserved name is the guest who types it).
 */
export function resolveTargetActor(entry: string, dir: IdentityDirectory = EMPTY_DIRECTORY): string {
  const trimmed = collapse(entry);
  if (!trimmed || /^ai:/i.test(trimmed)) return canonicalActor(trimmed, dir);
  if (isVerifiedHumanActor(trimmed) || isEmailAddress(trimmed)) return canonicalActor(trimmed, dir);
  const body = actorBody(trimmed).toLowerCase();
  const held = dir.names[body];
  if (held !== undefined) {
    // Reserved: a member's name. "" (two members share it) matches nobody.
    return held || `human:${actorBody(trimmed)}`;
  }
  const actor = canonicalActor(trimmed, dir);
  if (!IDENTITY_POLICY.guestsMayAnswerUnreservedNames && isGuestActor(actor)) return `human:${actorBody(trimmed)}`;
  return actor;
}

/** Display name without the trust suffix. */
export function actorDisplayName(actor: string, dir: IdentityDirectory = EMPTY_DIRECTORY): string {
  const label = dir.labels[actorKey(actor)];
  if (label) return label;
  return actorBody(actor) || String(actor ?? '');
}

// ============================================================================
// Reading stored data through the directory (never rewrites rows)
// ============================================================================

export function canonicalizeLineMarks(marks: LineMark[], dir: IdentityDirectory = EMPTY_DIRECTORY): Array<LineMark & { originalBy?: string }> {
  return marks.map(mark => {
    const by = canonicalActor(mark.by, dir, mark.at);
    return by === mark.by ? mark : { ...mark, by, originalBy: mark.by };
  });
}

export function canonicalizeAsks(asks: ProofAsk[], dir: IdentityDirectory = EMPTY_DIRECTORY): Array<ProofAsk & { toRaw?: string[]; originalBy?: string }> {
  return asks.map(ask => {
    const by = canonicalActor(ask.by, dir, ask.createdAt);
    const seen = new Set<string>();
    const to: string[] = [];
    for (const entry of ask.to) {
      const resolved = resolveTargetActor(entry, dir);
      const key = actorKey(resolved);
      if (!resolved || seen.has(key)) continue;
      seen.add(key);
      to.push(resolved);
    }
    const answers = ask.answers.map(answer => {
      const answerBy = canonicalActor(answer.by, dir, answer.at);
      return answerBy === answer.by ? answer : { ...answer, by: answerBy, originalBy: answer.by };
    });
    const changedTo = to.length !== ask.to.length || to.some((actor, i) => actor !== ask.to[i]);
    return {
      ...ask,
      by,
      to,
      answers,
      ...(changedTo ? { toRaw: ask.to } : {}),
      ...(by !== ask.by ? { originalBy: ask.by } : {}),
    };
  });
}

/** Every actor string that appears in these marks and asks (for building a directory). */
export function actorsIn(marks: Array<Pick<LineMark, 'by'>>, asks: ProofAsk[], extra: Array<string | null | undefined> = []): string[] {
  const out: string[] = [];
  for (const mark of marks) out.push(mark.by);
  for (const ask of asks) {
    out.push(ask.by, ...ask.to);
    for (const answer of ask.answers) out.push(answer.by);
  }
  for (const actor of extra) if (typeof actor === 'string') out.push(actor);
  return out.filter(actor => typeof actor === 'string' && actor.trim().length > 0);
}

/** What the page shows in the right rail header and uses for every new mark and answer. */
export interface ViewerIdentity {
  actor: string;
  trust: ActorTrust;
  name: string;
  /** Present for a verified human. */
  email?: string;
  /** Where a guest signs in (null when this server has no sign-in). */
  signInUrl: string | null;
  /** Invite person: this guest can read, comment and chat, but marks need signing in. */
  markNeedsSignIn?: boolean;
}
