/**
 * Proof Documents — Familiar proxy marks.
 *
 * Authorship: Mike Wolf ruled Yes on 2026-09-19 to "Familiar proxy marks: your Familiar AI
 * pre-marks the lines it is sure you would accept, and you ratify them with one click", with the
 * recommendation "A proxy mark never counts as yours until you ratify it, and every AI mark must
 * show its evidence." Ranked first by Anthropic Fable and OpenAI Astra. Built by Claude Opus 5
 * (worker proof-proxy), 2026-09-19. Every rule below is a named constant, so Mike's later rulings
 * are one-line changes.
 *
 * Terms:
 *   Familiar    - "an AI that has access to enough information to be a trusted advisor to that
 *                 human" (Mike's spec). In a document, a person binds one AI (an agent key's
 *                 identity, ai:<key>) as their Familiar.
 *   proxy mark  - the Familiar's mark on one line for its person: agreed, seen, or
 *                 rejected-suggested, with a confidence (0..1) and one line of evidence. It is
 *                 stored apart from line marks and never counts as the person's mark.
 *   ratify      - the person's one explicit action that turns the proxy-agreed lines they were
 *                 shown into their own Agreed marks (via "proxy"), recording the Familiar, the
 *                 evidence and the confidence on each.
 *   evidence    - one line saying what the AI checked (a paraphrase of the line, or the check it
 *                 ran). An AI mark without evidence is shown as "claimed".
 *
 * Pure code shared by the browser and the server.
 */
import {
  PASSIVE_VIAS,
  actorKey,
  buildLineStates,
  countsAsSeen,
  normalizeLineText,
  type DocLine,
  type LineAnchor,
  type LineMark,
  type LineMarkStatus,
  type LineState,
  type MarkVia,
  type ProofIssue,
} from './line-marks.js';

// ============================================================================
// POLICY (Claude's decisions where the ruling is silent; each a one-line change)
// ============================================================================

export const PROXY_POLICY = {
  /** A proxy Agreed at or above this confidence joins "Ratify all"; below it: "suggest you check". */
  ratifyThreshold: 0.9,
  /** What a Familiar may say for its person. Approve (owner-binding) and Reject are the person's own. */
  statuses: ['agreed', 'seen', 'rejected-suggested'] as const,
  /** Only the Familiar's own agent key may post proxy marks (not the owner credential naming it). */
  requireAgentKey: true,
  /** Only a person signed in to this site (a verified session) binds their own Familiar. Scripts with
   *  the owner credential may bind for a named verified person through the agent API. */
  bindRequiresVerifiedSession: true,
  /** The Familiar must be an AI present in the document (an active agent key). */
  familiarMustBeActiveKey: true,
  /** Lines never included in "Ratify all" (they are listed as "flagged for you" instead). */
  hold: {
    objection: true,     // an open objection covers the line
    ask: true,           // an ask on the line is open (or snoozed) for anyone
    uncertain: true,     // its writer flagged it uncertain and it is open for the person
    do: true,            // a {do} action line (agreeing is not approving the action)
    rejectedByOthers: true, // someone else rejected the line
    pendingSuggestion: true, // a pending suggestion sits on the line
  },
  /** A proxy on a line the person has already marked (Seen or better) is moot and not shown. */
  hideWhenPersonMarked: true,
  /**
   * COS ruling on Q4 (2026-09-19): on a line in "Flagged for you" (rejected-suggested, below the
   * threshold, or held), passive reading (dwell / scroll / folded section) gives at most Seen, never
   * Agreed, and does not make the proxy moot: the line stays in the brief until the person marks it
   * explicitly.
   */
  passiveReadCapsAtSeenWhenFlagged: true,
  /** How a ratified mark was earned (a line mark's `via`). Passive for the ringer list. */
  ratifiedVia: 'proxy' as const,
  /** Undo of a ratification: the person's own, once, within this long (the page offers it for the
   *  session; the server refuses later ones). */
  undoWindowMs: 12 * 60 * 60 * 1000,
  /** Most proxy lines in one request (same cap as a batch of line marks). */
  maxLinesPerRequest: 1000,
  /** The page receives only its viewer's own proxies; /state shows every person's. */
  pageShowsOnlyOwnProxies: true,
} as const;

export const EVIDENCE_POLICY = {
  /** Evidence is at least this long (Fable's rule: AI marks carry evidence). */
  minChars: 12,
  maxChars: 300,
  /** Proxy marks refuse to be written without evidence (400 EVIDENCE_REQUIRED). */
  requiredForProxy: true,
  /** Ordinary AI line marks may omit it for now; they then show as "claimed". */
  requiredForAiLineMarks: false,
  /** What people see beside an AI mark that carries no evidence. */
  claimedLabel: 'claimed',
} as const;

export type ProxyStatus = typeof PROXY_POLICY.statuses[number];

export interface ProxyMark {
  id: string;
  /** The Familiar that wrote it (ai:<key>). */
  familiar: string;
  /** The person it speaks for (human:<email>). */
  for: string;
  status: ProxyStatus;
  confidence: number;
  evidence: string;
  at: string;
  anchor: LineAnchor;
}

export interface FamiliarBinding {
  human: string;
  familiar: string;
  boundAt: string;
  boundBy: string;
}

/** Recorded on a line mark that came from ratifying a proxy. */
export interface ProxyOrigin {
  familiar: string;
  proxyId: string;
  confidence: number;
  evidence: string;
  ratificationId: string;
}

export function isProxyStatus(value: unknown): value is ProxyStatus {
  return typeof value === 'string' && (PROXY_POLICY.statuses as readonly string[]).includes(value);
}

/** One line of evidence, or null when missing or shorter than EVIDENCE_POLICY.minChars. */
export function cleanEvidence(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = normalizeLineText(value.replace(/[\x00-\x1f\x7f]/g, ' ')).slice(0, EVIDENCE_POLICY.maxChars);
  return text.length >= EVIDENCE_POLICY.minChars ? text : null;
}

export function cleanConfidence(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) return null;
  return Math.round(n * 1000) / 1000;
}

/** True when an AI's mark carries no evidence (people see it as "claimed"). */
export function isClaimedMark(mark: Pick<LineMark, 'by' | 'hidden'> & { evidence?: string | null }): boolean {
  return /^ai:/i.test(String(mark.by ?? '').trim()) && !mark.hidden && !(typeof mark.evidence === 'string' && mark.evidence.trim());
}

// ============================================================================
// Held lines: never auto-included in "Ratify all"
// ============================================================================

export type HoldReason = 'objection' | 'ask' | 'uncertain' | 'do' | 'rejected' | 'suggestion';

export const HOLD_LABEL: Record<HoldReason, string> = {
  objection: 'an open objection',
  ask: 'an open ask',
  uncertain: 'flagged uncertain',
  do: 'an action line',
  rejected: 'rejected by someone',
  suggestion: 'a pending suggestion',
};

/**
 * Lines "Ratify all" must leave to the person, with why, from the document's Issues (as the page or
 * /state computes them) and the lines that carry a pending suggestion.
 */
export function heldLines(input: { issues: ProofIssue[]; human: string; suggestionLines?: Iterable<number> }): Map<number, HoldReason[]> {
  const held = new Map<number, HoldReason[]>();
  const me = actorKey(input.human);
  const add = (index: number | null | undefined, reason: HoldReason) => {
    if (typeof index !== 'number' || index < 0) return;
    const list = held.get(index) ?? [];
    if (!list.includes(reason)) list.push(reason);
    held.set(index, list);
  };
  for (const issue of input.issues) {
    if (issue.type === 'objection' && PROXY_POLICY.hold.objection) for (const index of issue.lineIndices) add(index, 'objection');
    else if (issue.type === 'ask' && PROXY_POLICY.hold.ask && (issue.openFor.length > 0 || issue.snoozedFor.length > 0)) add(issue.lineIndex, 'ask');
    else if (issue.type === 'uncertain' && PROXY_POLICY.hold.uncertain && issue.openFor.some(a => actorKey(a) === me)) add(issue.lineIndex, 'uncertain');
    else if (issue.type === 'do' && PROXY_POLICY.hold.do) add(issue.lineIndex, 'do');
    else if (issue.type === 'line' && PROXY_POLICY.hold.rejectedByOthers && issue.rejectedBy.some(r => actorKey(r.by) !== me)) add(issue.lineIndex, 'rejected');
  }
  if (PROXY_POLICY.hold.pendingSuggestion) for (const index of input.suggestionLines ?? []) add(index, 'suggestion');
  return held;
}

/** The line a suggestion or comment quotes (first 60 characters, as "Since you" matches them). */
export function lineOfQuote(lines: DocLine[], quote: string | null | undefined): number {
  const q = normalizeLineText(String(quote ?? ''));
  if (!q) return -1;
  const probe = q.slice(0, 60);
  const hit = lines.find(line => line.text.includes(probe)) ?? lines.find(line => line.text.length > 8 && probe.includes(line.text));
  return hit ? hit.index : -1;
}

// ============================================================================
// The brief
// ============================================================================

/** ratify: in "Ratify all"; check: agreed below the threshold; reject: rejected-suggested;
 *  held: agreed but on a held line; seen: the Familiar read it and takes no position. */
export type ProxyBucket = 'ratify' | 'check' | 'reject' | 'held' | 'seen';

export interface ProxyItem {
  proxy: ProxyMark;
  lineIndex: number;
  bucket: ProxyBucket;
  held: HoldReason[];
  /** The line changed cosmetically since the proxy was written (it still counts). */
  carried: boolean;
}

export interface ProxyBrief {
  human: string;
  familiar: string | null;
  /** Current proxies on lines the person has not marked, in document order. */
  items: ProxyItem[];
  ratify: ProxyItem[];
  /** "Flagged for you": check + reject + held, in document order. */
  flagged: ProxyItem[];
  seen: ProxyItem[];
  /** Proxies whose line changed in meaning (or was deleted) since: reset, shown nowhere. */
  reset: ProxyMark[];
  /** Proxies on lines the person has already marked. */
  moot: number;
  counts: { read: number; agreed: number; flagged: number; needYou: number };
}

const EMPTY_COUNTS = { read: 0, agreed: 0, flagged: 0, needYou: 0 };

/**
 * Evaluates one person's proxies against the current lines. A proxy resolves exactly like a line
 * mark (its hash, else a cosmetic carry-forward); one whose line changed in meaning is reset.
 * `humanIssueLines` are the line Issues open for the person; "need you" is those lines that are
 * neither in "Ratify all" nor flagged.
 */
export function evaluateProxies(input: {
  proxies: ProxyMark[];
  human: string;
  familiar: string | null;
  lines: DocLine[];
  /** Line states built from the (canonical) line marks: the person's own marks are read here. */
  states: LineState[];
  held: Map<number, HoldReason[]>;
  humanIssueLines?: Iterable<number>;
  threshold?: number;
}): ProxyBrief {
  const human = input.human;
  const familiar = input.familiar;
  const brief: ProxyBrief = { human, familiar, items: [], ratify: [], flagged: [], seen: [], reset: [], moot: 0, counts: { ...EMPTY_COUNTS } };
  if (!familiar) return brief;
  const threshold = input.threshold ?? PROXY_POLICY.ratifyThreshold;
  const mine = input.proxies.filter(p => actorKey(p.for) === actorKey(human) && actorKey(p.familiar) === actorKey(familiar));
  // Resolve through the line-mark machinery: one pseudo-actor per proxy row, so each row resolves alone.
  const pseudo: LineMark[] = mine.map(p => ({ id: p.id, by: `proxy:${p.id}`, status: 'seen', at: p.at, anchor: p.anchor }));
  const resolved = buildLineStates(input.lines, pseudo);
  const byLine = new Map<number, { proxy: ProxyMark; carried: boolean }>();
  const placed = new Set<string>();
  for (const state of resolved) {
    for (const entry of state.marks.values()) {
      const proxy = mine.find(p => p.id === entry.mark.id);
      if (!proxy || !entry.current) continue;
      placed.add(proxy.id);
      const existing = byLine.get(state.line.index);
      // Two proxies on one line: the newer wins (the older one is effectively replaced).
      if (!existing || String(proxy.at) > String(existing.proxy.at)) byLine.set(state.line.index, { proxy, carried: Boolean(entry.carried) });
    }
  }
  brief.reset = mine.filter(p => !placed.has(p.id));
  const me = actorKey(human);
  for (const [lineIndex, { proxy, carried }] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    const own = input.states[lineIndex]?.marks.get(me);
    const held = input.held.get(lineIndex) ?? [];
    const bucket: ProxyBucket = proxy.status === 'rejected-suggested' ? 'reject'
      : proxy.status === 'seen' ? 'seen'
      : held.length > 0 ? 'held'
      : proxy.confidence >= threshold ? 'ratify' : 'check';
    if (PROXY_POLICY.hideWhenPersonMarked && own?.current && countsAsSeen(own.mark.status)) {
      // A passive read of a flagged line does not settle it: the line stays in the brief.
      const passive = PASSIVE_VIAS.has((own.mark.via ?? 'api') as MarkVia) && own.mark.via !== 'proxy';
      if (!(PROXY_POLICY.passiveReadCapsAtSeenWhenFlagged && isFlaggedBucket(bucket) && passive)) { brief.moot += 1; continue; }
    }
    const item: ProxyItem = { proxy, lineIndex, bucket, held, carried };
    brief.items.push(item);
    if (bucket === 'ratify') brief.ratify.push(item);
    else if (bucket === 'seen') brief.seen.push(item);
    else brief.flagged.push(item);
  }
  const covered = new Set([...brief.ratify, ...brief.flagged].map(item => item.lineIndex));
  let needYou = 0;
  for (const index of new Set(input.humanIssueLines ?? [])) if (!covered.has(index)) needYou += 1;
  brief.counts = { read: brief.items.length, agreed: brief.ratify.length, flagged: brief.flagged.length, needYou };
  return brief;
}

/** "Flagged for you": below the threshold, a recommended rejection, or held. */
export function isFlaggedBucket(bucket: ProxyBucket): boolean {
  return bucket === 'check' || bucket === 'reject' || bucket === 'held';
}

/**
 * COS ruling on Q4: the most a passive read (dwell) may give on a line, given the status the
 * statement rule would give and the reader's own proxy item there. Flagged lines cap at Seen.
 */
export function capPassiveRead(status: LineMarkStatus | null, item: Pick<ProxyItem, 'bucket'> | null | undefined): LineMarkStatus | null {
  if (!status || !item || !PROXY_POLICY.passiveReadCapsAtSeenWhenFlagged || !isFlaggedBucket(item.bucket)) return status;
  return status === 'agreed' || status === 'approved' ? 'seen' : status;
}

/** Line Issues open for the person (unseen, changed or skimmed by them). */
export function humanIssueLines(issues: ProofIssue[], human: string): number[] {
  const me = actorKey(human);
  const out: number[] = [];
  for (const issue of issues) {
    if (issue.type === 'line' && issue.unseenBy.some(a => actorKey(a) === me)) out.push(issue.lineIndex);
  }
  return out;
}

/** "Claude read 12 lines for you: agreed 8, flagged 2 for you, 5 need you". */
export function briefHeadline(brief: Pick<ProxyBrief, 'counts'>, familiarName: string): string {
  const c = brief.counts;
  return `${familiarName} read ${c.read} ${c.read === 1 ? 'line' : 'lines'} for you: agreed ${c.agreed}, flagged ${c.flagged} for you, ${c.needYou} need you`;
}

/** Why an item is flagged, in words ("confidence 0.7, below 0.9", "an open ask"). */
export function flaggedWhy(item: ProxyItem, threshold: number = PROXY_POLICY.ratifyThreshold): string {
  if (item.bucket === 'reject') return 'recommends rejecting';
  if (item.bucket === 'held') return `agreed, but the line has ${item.held.map(h => HOLD_LABEL[h]).join(' and ')}`;
  if (item.bucket === 'check') return `agreed with confidence ${item.proxy.confidence}, below ${threshold}: suggest you check`;
  if (item.bucket === 'seen') return 'read it; takes no position';
  return `agreed (confidence ${item.proxy.confidence})`;
}

/** The first letter people see on a proxy dot. */
export function familiarInitial(label: string): string {
  const letter = String(label ?? '').replace(/^(ai|human|guest):/i, '').trim().match(/[A-Za-z0-9]/);
  return letter ? letter[0].toUpperCase() : 'F';
}
