/**
 * Proof Documents — line tiers: decision lines and context lines.
 *
 * Authorship: Mike Wolf ruled Yes on 2026-09-19 to "Should each line be either a decision line (it
 * needs your mark) or a context line (your Familiar's read is enough)?", with the recommendation
 * "Most lines are setup, not claims; this cuts the lines you must touch to the number of decisions.
 * The author (or the Familiar) tags lines; you can flip any tag." Idea from Anthropic Fable. The COS
 * (Claude) decided who may tag and how flips are recorded. Built by Claude Opus 5 (worker
 * proof-tiers), 2026-09-19. Every rule below is a named constant, so Mike's later rulings are
 * one-line changes.
 *
 * Terms:
 *   tier          - what a line asks of the people on the team: `decision` (it needs each person's
 *                   own mark, as every line did before) or `context` (setup; an AI's read is enough).
 *   tag / flip    - setting a line's tier. Tiers are per document (shared by the whole team). Every
 *                   tag is kept with who set it and when; the newest one on a line wins.
 *   AI proposal   - a line an AI tagged `context`. It is shown as "AI proposed context" until a
 *                   person confirms it (by tagging it context themselves), unless that AI wrote the
 *                   line. It counts as context meanwhile (TIER_POLICY.aiProposalActsAsContext).
 *   read for you  - a context line some AI on the team (or a Familiar) has read: a current Seen,
 *                   Agreed or Approved with evidence, or a Familiar's proxy Seen / Agreed.
 *
 * Pure code shared by the browser and the server. Tiers are stored beside the document like line
 * marks and point at a line through the same anchor (hash, occurrence, ordinal, text).
 */
import {
  actorKey,
  buildLineStates,
  isAiActor,
  type DocLine,
  type LineAnchor,
  type LineMark,
  type TierIssueInput,
} from './line-marks.js';

export { lineOfReviewMark } from './line-marks.js';

export type LineTier = 'decision' | 'context';
export const LINE_TIERS: readonly LineTier[] = ['decision', 'context'];

export function isLineTier(value: unknown): value is LineTier {
  return value === 'decision' || value === 'context';
}

// ============================================================================
// POLICY (Mike's ruling + the COS's decisions; each a one-line change)
// ============================================================================

export const TIER_POLICY = {
  /** The tier of a line nobody tagged. `decision` keeps today's behaviour for untagged documents. */
  defaultTier: 'decision' as LineTier,
  /** Who may tag or flip: anyone with comment access (COS decision, 2026-09-19). */
  whoMayTag: 'comment-access' as const,
  /** An AI's `context` tag counts as context before a person confirms it (shown "AI proposed context"). */
  aiProposalActsAsContext: true,
  /** An AI's `context` tag on a line that AI wrote needs no confirmation. */
  aiAuthorNeedsNoConfirm: true,
  /** A tag follows its line over a cosmetic edit; a meaning change drops it (the line is untagged again). */
  carryCosmeticEdits: true,
  /** An AI read counts for a context line only with evidence (EVIDENCE_POLICY: "claimed" marks do not). */
  aiReadRequiresEvidence: true,
  /** The AI line-mark statuses that count as having read a line. */
  aiReadStatuses: ['seen', 'agreed', 'approved'] as const,
  /** The Familiar proxy statuses that count as a read (a rejected-suggested proxy is a flag instead). */
  proxyReadStatuses: ['seen', 'agreed'] as const,
  /** A Familiar's rejected-suggested proxy keeps the context line an Issue for its person. */
  proxyRejectIsIssueForItsPerson: true,
  /**
   * What on a context line keeps it an Issue for people (Mike's spec: "someone rejected it, or it has
   * an open objection/ask/suggestion/flag"). Comments are included (COS: an open question is not
   * silence); the others follow the spec.
   */
  openItems: {
    rejection: true,
    objection: true,
    ask: true,
    suggestion: true,
    comment: true,
    uncertainFlag: true,
    alternatives: true,
    expiredTtl: true,
    doAction: true,
  },
  /** The ◆ decision marker shows only once a document has at least one tag (untagged documents look as before). */
  diamondOnlyWhenTagged: true,
  /** "Show only decisions" keeps headings visible (the outline stays readable). */
  foldKeepsHeadings: true,
  /** The reading walk's key that flips the focus line's tier (A R J K Y N T E 1-9 are taken). */
  flipKey: 'd',
  /** Longest reason kept with a tag. */
  maxReason: 300,
  /** Most lines in one tag request. */
  maxLinesPerRequest: 1000,
} as const;

// ============================================================================
// Records and evaluation
// ============================================================================

/** One tag, as stored (append-only: the newest current tag on a line is its tier). */
export interface TierRecord {
  id: string;
  tier: LineTier;
  by: string;
  at: string;
  reason?: string | null;
  anchor: LineAnchor;
  /** Set when the tagger is an AI that wrote the line (its `context` tag needs no confirmation). */
  byAuthor?: boolean;
}

/** An AI read of a line (an AI line mark with evidence, or a Familiar's proxy Seen / Agreed). */
export interface TierRead {
  by: string;
  anchor: LineAnchor;
  /** For a proxy read: the person the Familiar read it for. */
  for?: string | null;
}

/** A Familiar's rejected-suggested proxy: the line stays an Issue for its person. */
export interface TierFlag {
  by: string;
  for: string;
  anchor: LineAnchor;
}

export interface TierView {
  lineIndex: number;
  tier: LineTier;
  /** True when some tag holds the line (false: the default tier). */
  tagged: boolean;
  record: TierRecord | null;
  /** The tag was carried over a cosmetic edit. */
  carried: boolean;
  /** An AI tagged the line context and no person confirmed it (and that AI did not write it). */
  proposed: boolean;
  /** The line counts as context for Issues (context, and not an unconfirmed proposal when those do not count). */
  actsAsContext: boolean;
  /** AIs that read the line (with evidence), in first-read order, de-duplicated. */
  readBy: string[];
  /** People whose Familiar recommends rejecting the line (it stays their Issue). */
  flaggedFor: string[];
}

export interface TierEvaluation {
  views: TierView[];
  /** True when the document has at least one tag. */
  anyTagged: boolean;
}

/** Records resolved against the lines as if they were line marks (same anchor rules, same carry). */
function asMarks<T extends { anchor: LineAnchor; at?: string }>(items: T[], key: (item: T, i: number) => string): { marks: LineMark[]; byId: Map<string, T> } {
  const byId = new Map<string, T>();
  const marks: LineMark[] = items.map((item, i) => {
    const id = `t${i}`;
    byId.set(id, item);
    return { id, by: key(item, i), status: 'seen', at: item.at ?? '', anchor: item.anchor };
  });
  return { marks, byId };
}

export function evaluateTiers(input: {
  lines: DocLine[];
  records: TierRecord[];
  reads?: TierRead[];
  flags?: TierFlag[];
}): TierEvaluation {
  const { lines } = input;
  const views: TierView[] = lines.map(line => ({
    lineIndex: line.index, tier: TIER_POLICY.defaultTier, tagged: false, record: null, carried: false, proposed: false,
    actsAsContext: TIER_POLICY.defaultTier === 'context', readBy: [], flaggedFor: [],
  }));
  // Tags: one pseudo-actor, so the newest current (or carried) tag per line wins.
  const tags = asMarks(input.records, () => 'tier');
  const tagStates = buildLineStates(lines, tags.marks);
  let anyTagged = false;
  for (const state of tagStates) {
    const entry = state.marks.get('tier');
    if (!entry || !entry.current) continue;
    if (entry.carried && !TIER_POLICY.carryCosmeticEdits) continue;
    const record = tags.byId.get(entry.mark.id);
    if (!record) continue;
    const view = views[state.line.index];
    view.tier = record.tier;
    view.tagged = true;
    view.record = record;
    view.carried = Boolean(entry.carried);
    view.proposed = record.tier === 'context' && isAiActor(record.by) && !(TIER_POLICY.aiAuthorNeedsNoConfirm && record.byAuthor === true);
    view.actsAsContext = record.tier === 'context' && (!view.proposed || TIER_POLICY.aiProposalActsAsContext);
    anyTagged = true;
  }
  // Reads: keyed by reader, so each reader counts once per line (current or carried only).
  const reads = asMarks(input.reads ?? [], item => item.by);
  for (const state of buildLineStates(lines, reads.marks)) {
    const view = views[state.line.index];
    for (const entry of state.marks.values()) {
      if (!entry.current) continue;
      const by = entry.mark.by;
      if (!view.readBy.some(existing => actorKey(existing) === actorKey(by))) view.readBy.push(by);
    }
  }
  const flags = asMarks(input.flags ?? [], item => `${item.for}`);
  for (const state of buildLineStates(lines, flags.marks)) {
    const view = views[state.line.index];
    for (const entry of state.marks.values()) {
      if (!entry.current) continue;
      const flag = flags.byId.get(entry.mark.id);
      if (flag && !view.flaggedFor.some(existing => actorKey(existing) === actorKey(flag.for))) view.flaggedFor.push(flag.for);
    }
  }
  return { views, anyTagged };
}

/**
 * The AI reads from a document's line marks: current AI marks whose status counts as a read, with
 * evidence when TIER_POLICY.aiReadRequiresEvidence (a blind placeholder never counts: the server
 * sends its own list for that).
 */
export function aiReadsFromMarks(lineMarks: LineMark[]): TierRead[] {
  const statuses = TIER_POLICY.aiReadStatuses as readonly string[];
  return lineMarks
    .filter(mark => isAiActor(mark.by) && !mark.hidden && statuses.includes(mark.status)
      && (!TIER_POLICY.aiReadRequiresEvidence || Boolean(mark.evidence && String(mark.evidence).trim())))
    .map(mark => ({ by: mark.by, anchor: mark.anchor }));
}

/** The reads and flags from Familiar proxy marks (any shape with familiar / for / status / evidence / anchor). */
export function tierSignalsFromProxies(proxies: Array<{ familiar: string; for: string; status: string; evidence?: string | null; anchor: LineAnchor }>): { reads: TierRead[]; flags: TierFlag[] } {
  const reads: TierRead[] = [];
  const flags: TierFlag[] = [];
  const readStatuses = TIER_POLICY.proxyReadStatuses as readonly string[];
  for (const proxy of proxies) {
    if (readStatuses.includes(proxy.status) && (!TIER_POLICY.aiReadRequiresEvidence || Boolean(proxy.evidence && proxy.evidence.trim()))) {
      reads.push({ by: proxy.familiar, anchor: proxy.anchor, for: proxy.for });
    } else if (proxy.status === 'rejected-suggested' && TIER_POLICY.proxyRejectIsIssueForItsPerson) {
      flags.push({ by: proxy.familiar, for: proxy.for, anchor: proxy.anchor });
    }
  }
  return { reads, flags };
}

// ============================================================================
// Issues
// ============================================================================

/** What computeIssues needs to apply tiers (src/shared/line-marks.ts applies the rule). */
export function tierIssueInput(evaluation: TierEvaluation | null | undefined): TierIssueInput | undefined {
  if (!evaluation) return undefined;
  return { views: evaluation.views, openItems: TIER_POLICY.openItems };
}

/** The human-facing words for a context line's note ("context — read for you by Claude"). */
export function describeContext(view: TierView, name: (actor: string) => string = actor => actor.replace(/^ai:/, '')): string {
  const who = view.readBy.map(name);
  const readers = who.length === 0 ? 'no AI has read it yet, so it still needs you'
    : who.length === 1 ? `read for you by ${who[0]}` : `read for you by ${who.slice(0, -1).join(', ')} and ${who[who.length - 1]}`;
  return `context — ${readers}`;
}

/** The tier a flip gives (decision <-> context). */
export function flippedTier(tier: LineTier): LineTier {
  return tier === 'context' ? 'decision' : 'context';
}

/** Cleans a tag reason (one line, TIER_POLICY.maxReason). */
export function cleanTierReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, TIER_POLICY.maxReason);
  return text || null;
}
