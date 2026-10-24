/**
 * Proof Documents — Step B4f: perishable claims `{ttl}` (pure code, shared by the browser and the
 * server).
 *
 * Authorship: idea from Anthropic Fable (research round 2, idea 4); brief by the COS (Claude),
 * 2026-09-19; built by Claude Opus 5 (worker proof-bundles), 2026-09-19. POLICY rules are
 * Claude's decisions where the brief is silent.
 *
 * An author sets a time-to-live on a line ("7d"). When it runs out, the Agreed and Approved marks
 * made on the line before then decay to "stale" (shown; they still count as Seen). The line then
 * becomes an Issue for the AI collaborators first (low priority: "still true?"). It becomes an
 * Issue for people only when the line changed since, or an AI answers "still true: no". An AI's
 * "still true: yes" starts a new period and the stale marks count again.
 * Expiry is lazy: it is worked out whenever the document is read (no timer). Stored beside the
 * document (document_line_ttls), never in its text.
 */
import {
  PASSIVE_VIAS,
  actorKey,
  findCarryTarget,
  isAiActor,
  resolveLineAnchor,
  type DocLine,
  type LineAnchor,
  type LineState,
} from './line-marks.js';

export const TTL_POLICY = {
  /** Units a time-to-live may use: "90s", "30m", "12h", "7d", "2w". */
  units: { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as Record<string, number>,
  minMs: 1000,
  maxMs: 366 * 86_400_000,
  /** Choices the rail offers (anything valid can be typed through the API). */
  presets: ['1d', '7d', '30d'] as readonly string[],
  /** Mark statuses that decay to "stale" when the line expires (brief: Agreed and Approved). */
  decays: ['agreed', 'approved'] as readonly string[],
  /** Anyone with comment access may set one (the author is whoever writes the line). */
  whoMaySet: 'commenter' as const,
  /** The person who set it, or an Owner, may change or remove it. */
  clearBy: 'setter-or-owner' as const,
  /** One time-to-live per line: setting again replaces it. */
  onePerLine: true,
  /** "Still true?" checks come from AIs; people answer by marking the line again. */
  checksFromAiOnly: true,
  /** A "yes" check starts a new period from the time of the check. */
  yesRenews: true,
  /** People see the expired line as an Issue only in these cases (brief). */
  humansWhen: ['changed', 'not-true'] as readonly string[],
  /** A person settles it by a deliberate Agree, Approve or Reject after the trigger. */
  settledBy: ['agreed', 'approved', 'rejected'] as readonly string[],
  maxWhy: 300,
} as const;

export interface TtlCheck { by: string; stillTrue: boolean; at: string; why: string | null }

export interface ProofTtl {
  id: string;
  by: string;
  /** The length of one period, in ms, and how it was written ("7d"). */
  ttlMs: number;
  label: string;
  /** The line as it was when the time-to-live was set (re-anchored as the line moves). */
  anchor: LineAnchor;
  setAt: string;
  /** Start of the current period (setAt, or the last "still true: yes"). */
  periodStart: string;
  /** Hash of the line at the start of the period (a later edit = "changed since"). */
  periodHash: string;
  checks: TtlCheck[];
}

export interface TtlView {
  ttl: ProofTtl;
  lineIndex: number | null;
  expiresAt: string;
  expired: boolean;
  /** The latest check in this period said "no longer true". */
  notTrue: boolean;
  /** The line's text changed since the period started. */
  changed: boolean;
  /** When the marks started to decay (expiry, or an earlier "no" check), or null. */
  decayFrom: string | null;
  /** Mark ids that decayed to stale. */
  decayed: string[];
  openFor: string[];
  reason: 'expired' | 'not-true' | 'changed';
}

/** "7d" -> { ms, label }; null when it is not a valid time-to-live. */
export function parseTtl(value: unknown): { ms: number; label: string } | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = Math.round(value);
    return ms >= TTL_POLICY.minMs && ms <= TTL_POLICY.maxMs ? { ms, label: `${Math.round(ms / 1000)}s` } : null;
  }
  const match = String(value ?? '').trim().toLowerCase().match(/^(\d{1,6})\s*([smhdw])$/);
  if (!match) return null;
  const ms = Number(match[1]) * TTL_POLICY.units[match[2]];
  if (!(ms >= TTL_POLICY.minMs && ms <= TTL_POLICY.maxMs)) return null;
  return { ms, label: `${Number(match[1])}${match[2]}` };
}

export function ttlLineIndex(ttl: ProofTtl, lines: DocLine[], cache?: Map<string, boolean>): number | null {
  const resolved = resolveLineAnchor(lines, ttl.anchor);
  if (resolved?.current) return resolved.lineIndex;
  const carried = findCarryTarget(lines, ttl.anchor, cache);
  if (carried) return carried.index;
  return resolved ? resolved.lineIndex : null;
}

function deliberateSince(state: LineState | undefined, member: string, since: string): boolean {
  const entry = state?.marks.get(actorKey(member));
  if (!entry || !entry.current) return false;
  if (!TTL_POLICY.settledBy.includes(entry.mark.status)) return false;
  if (entry.mark.via && PASSIVE_VIAS.has(entry.mark.via)) return false;
  return String(entry.mark.at) >= since;
}

/**
 * Evaluates every time-to-live at `now` (lazy expiry). `states` are the line states (from
 * buildLineStates) used for decay and for who has re-affirmed since.
 */
export function evaluateTtls(ttls: ProofTtl[], lines: DocLine[], states: LineState[], team: string[], now: number): TtlView[] {
  const cache = new Map<string, boolean>();
  return ttls.map(ttl => {
    const lineIndex = ttlLineIndex(ttl, lines, cache);
    const start = Date.parse(ttl.periodStart);
    const expiresMs = (Number.isFinite(start) ? start : 0) + ttl.ttlMs;
    const expiresAt = new Date(expiresMs).toISOString();
    const expired = now >= expiresMs;
    const inPeriod = ttl.checks.filter(check => check.at >= ttl.periodStart);
    const last = inPeriod[inPeriod.length - 1] ?? null;
    const notTrue = Boolean(last && !last.stillTrue);
    const line = lineIndex === null ? null : lines[lineIndex];
    const changed = Boolean(line && line.hash !== ttl.periodHash);
    const decayFrom = notTrue && (!expired || last!.at < expiresAt) ? last!.at : (expired ? expiresAt : null);
    const decayed: string[] = [];
    const state = lineIndex === null ? undefined : states[lineIndex];
    if (decayFrom && state) {
      for (const entry of state.marks.values()) {
        if (entry.current && TTL_POLICY.decays.includes(entry.mark.status) && String(entry.mark.at) < decayFrom) decayed.push(entry.mark.id);
      }
    }
    let openFor: string[] = [];
    let reason: TtlView['reason'] = 'expired';
    if (lineIndex !== null && (expired || notTrue)) {
      const trigger = decayFrom ?? expiresAt;
      if (notTrue || (changed && TTL_POLICY.humansWhen.includes('changed'))) {
        reason = notTrue ? 'not-true' : 'changed';
        openFor = team.filter(member => !isAiActor(member) && !deliberateSince(state, member, trigger));
      } else {
        // The AI collaborators check first: open for each AI that has not answered since expiry.
        openFor = team.filter(member => isAiActor(member)
          && !ttl.checks.some(check => actorKey(check.by) === actorKey(member) && check.at >= expiresAt));
      }
    }
    return { ttl, lineIndex, expiresAt, expired, notTrue, changed, decayFrom, decayed, openFor, reason };
  });
}

/** Input for computeIssues (src/shared/line-marks.ts). */
export function ttlIssueInputs(views: TtlView[]): Array<{ id: string; lineIndex: number; by: string; expiresAt: string; reason: TtlView['reason']; openFor: string[] }> {
  return views.filter(v => v.lineIndex !== null && v.openFor.length > 0)
    .map(v => ({ id: v.ttl.id, lineIndex: v.lineIndex as number, by: v.ttl.by, expiresAt: v.expiresAt, reason: v.reason, openFor: v.openFor }));
}

/** Marks every decayed entry on the line states (the UI shows them as stale). */
export function applyDecay(states: LineState[], views: TtlView[]): void {
  const ids = new Set(views.flatMap(v => v.decayed));
  if (ids.size === 0) return;
  for (const state of states) for (const entry of state.marks.values()) if (ids.has(entry.mark.id)) entry.decayed = true;
}

/** "in 6 days" / "expired 2 hours ago", for the rail. */
export function describeTtl(view: TtlView, now: number): string {
  const ms = Date.parse(view.expiresAt) - now;
  const abs = Math.abs(ms);
  const unit = abs >= 86_400_000 ? ['day', 86_400_000] : abs >= 3_600_000 ? ['hour', 3_600_000] : abs >= 60_000 ? ['minute', 60_000] : ['second', 1000];
  const n = Math.max(1, Math.round(abs / (unit[1] as number)));
  const span = `${n} ${unit[0]}${n === 1 ? '' : 's'}`;
  if (view.notTrue) return 'An AI says this may no longer be true';
  return view.expired ? `Expired ${span} ago` : `Expires in ${span}`;
}
