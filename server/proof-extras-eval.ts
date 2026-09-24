/**
 * Mike, 2026-09-23 (usability brief): omit unrevealed Issue rows so their existence and ranking cannot disclose hidden choices.
 * Proof Documents Steps B4e + B4f — evaluating bundles, alternatives, blind marking, Explain
 * threads and times-to-live against a document's current lines, on the server (for /state,
 * alignment and the page's poll).
 *
 * Authorship: built by Claude Opus 5 (worker proof-bundles), 2026-09-19.
 * Imports only the store, the db and shared code, so server/line-marks.ts can use it without a cycle.
 */
import { addDocumentEvent, getMarkTombstone } from './db.js';
import {
  actorKey,
  anchorForLine,
  normalizeLineText,
  type DocLine,
  type LineMark,
  type LineState,
  type ProofIssue,
  type ReviewMarkLike,
} from '../src/shared/line-marks.js';
import { bundleIndex, describeBundle, evaluateBundle, type BundleView, type MemberState, type ProofBundle } from '../src/shared/bundles.js';
import { ALT_POLICY, alternativeIssueInputs, altLineIndex, describeAltSet, evaluateAlternatives, type AltPick, type AltSetView, type ProofAlternative } from '../src/shared/alternatives.js';
import { BLIND_POLICY, objectionLinesRevealed, disagreementCounts, disagreementLines, hiddenMark, markLineIndex, redactLineMarks, revealedLines } from '../src/shared/blind.js';
import { EXPLAIN_POLICY, findTerms, firstTermUses } from '../src/shared/explain.js';
import { applyDecay, describeTtl, evaluateTtls, ttlIssueInputs, type ProofTtl, type TtlView } from '../src/shared/ttl.js';
import {
  getProofSettings,
  listAlternatives,
  listBundles,
  listExplains,
  listPicks,
  listTtls,
  noteTtlExpired,
  updateAlternativeAnchor,
  updateTtlAnchor,
  type ProofExplain,
  type ProofSettings,
} from './proof-extras-store.js';

function parseStoredMarks(raw: unknown): Record<string, Record<string, unknown>> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, Record<string, unknown>>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Where each suggestion is and whether it is still pending, from the stored marks (the server has
 * no editor positions: a suggestion is on the first line whose text holds its quote, or its
 * proposed text). A suggestion gone from the marks reads its tombstone (accepted / rejected).
 */
export function serverSuggestionLocator(slug: string, lines: DocLine[], rawMarks: unknown): (markId: string) => { state: MemberState; lineIndex: number | null } {
  const marks = parseStoredMarks(rawMarks);
  return (markId: string) => {
    const mark = marks[markId];
    if (!mark || typeof mark !== 'object') {
      let tomb: { status?: string } | null = null;
      try { tomb = getMarkTombstone(slug, markId); } catch { tomb = null; }
      if (tomb?.status === 'accepted') return { state: 'accepted', lineIndex: null };
      if (tomb?.status === 'rejected') return { state: 'rejected', lineIndex: null };
      return { state: 'missing', lineIndex: null };
    }
    const status = typeof mark.status === 'string' ? mark.status : 'pending';
    if (status === 'accepted') return { state: 'accepted', lineIndex: null };
    if (status === 'rejected') return { state: 'rejected', lineIndex: null };
    const quote = normalizeLineText(String(mark.quote ?? ''));
    const content = normalizeLineText(String(mark.content ?? ''));
    const line = (quote ? lines.find(candidate => candidate.text.includes(quote)) : undefined)
      ?? (content ? lines.find(candidate => candidate.text.includes(content)) : undefined);
    return { state: 'pending', lineIndex: line ? line.index : null };
  };
}

export interface ExtrasPre {
  settings: ProofSettings;
  bundles: ProofBundle[];
  alternatives: ProofAlternative[];
  picks: AltPick[];
  explains: ProofExplain[];
  ttls: Array<ProofTtl & { expiredNotedAt: string | null }>;
  /** Alternative offerers and TTL setters join the team (like askers and flaggers). */
  teamExtra: string[];
}

/** Reads the stored extras (before the team is known). */
export function readExtras(slug: string): ExtrasPre {
  const safe = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };
  const alternatives = safe(() => listAlternatives(slug), []);
  const ttls = safe(() => listTtls(slug), []);
  return {
    settings: getProofSettings(slug),
    bundles: safe(() => listBundles(slug), []),
    alternatives,
    picks: safe(() => listPicks(slug), []),
    explains: safe(() => listExplains(slug), []),
    ttls,
    teamExtra: [...alternatives.map(alt => alt.by), ...ttls.map(ttl => ttl.by)],
  };
}

/** Review marks annotated for Issues: an Explain thread is not an Issue; a suggestion names its bundle. */
export function annotateReviewMarks(reviewMarks: ReviewMarkLike[], pre: Pick<ExtrasPre, 'bundles' | 'explains'>): ReviewMarkLike[] {
  const explainIds = new Set(pre.explains.map(e => e.commentMarkId).filter((id): id is string => Boolean(id)));
  const bundles = bundleIndex(pre.bundles);
  return reviewMarks.map(mark => {
    const explain = !EXPLAIN_POLICY.commentIsIssue && explainIds.has(mark.id);
    const bundleId = bundles.get(mark.id);
    return explain || bundleId ? { ...mark, ...(explain ? { explain: true } : {}), ...(bundleId ? { bundleId } : {}) } : mark;
  });
}

export interface ExtrasEvaluation {
  pre: ExtrasPre;
  bundleViews: BundleView[];
  altViews: AltSetView[];
  ttlViews: TtlView[];
  disagreement: Set<number>;
  countsDisagreement: boolean;
}

/**
 * Evaluates the extras for the team now. Re-anchors alternatives and times-to-live that moved
 * (persisted) and records `ttl.expired` once per period when an expiry is first noticed.
 */
export function evaluateExtras(slug: string, pre: ExtrasPre, input: {
  lines: DocLine[];
  states: LineState[];
  team: string[];
  rawMarks: unknown;
  now?: number;
  persist?: boolean;
}): ExtrasEvaluation {
  const now = input.now ?? Date.now();
  const { lines, states, team } = input;
  const locate = serverSuggestionLocator(slug, lines, input.rawMarks);
  const bundleViews = pre.bundles.map(bundle => evaluateBundle(bundle, lines, locate));
  const altViews = evaluateAlternatives(pre.alternatives, pre.picks, lines, team);
  const ttlViews = evaluateTtls(pre.ttls, lines, states, team, now);
  applyDecay(states, ttlViews);
  if (input.persist !== false) {
    const cache = new Map<string, boolean>();
    for (const alt of pre.alternatives) {
      const index = altLineIndex(alt, lines, cache);
      if (index === null) continue;
      const line = lines[index];
      if (alt.anchor.hash === line.hash && alt.anchor.occurrence === line.occurrence && alt.anchor.ordinal === line.index) continue;
      try { const anchor = anchorForLine(line); updateAlternativeAnchor(slug, alt.id, anchor); alt.anchor = anchor; } catch { /* next read retries */ }
    }
    for (const view of ttlViews) {
      if (view.lineIndex !== null) {
        const line = lines[view.lineIndex];
        const a = view.ttl.anchor;
        if (!(a.hash === line.hash && a.occurrence === line.occurrence && a.ordinal === line.index)) {
          try { const anchor = anchorForLine(line); updateTtlAnchor(slug, view.ttl.id, anchor); view.ttl.anchor = anchor; } catch { /* next read retries */ }
        }
      }
      const stored = pre.ttls.find(t => t.id === view.ttl.id);
      if ((view.expired || view.notTrue) && stored && !stored.expiredNotedAt) {
        try {
          if (noteTtlExpired(slug, view.ttl.id, new Date(now).toISOString())) {
            stored.expiredNotedAt = new Date(now).toISOString();
            addDocumentEvent(slug, 'ttl.expired', {
              ttlId: view.ttl.id, lineIndex: view.lineIndex, excerpt: view.lineIndex === null ? view.ttl.anchor.excerpt : lines[view.lineIndex].text.slice(0, 160),
              expiresAt: view.expiresAt, decayedMarks: view.decayed.length, openFor: view.openFor, reason: view.reason,
              howToAnswer: `POST /api/agent/${slug}/ttl/${view.ttl.id}/check {"stillTrue": true|false, "why": "..."}`,
            }, 'system');
          }
        } catch { /* optional */ }
      }
    }
  }
  const countsDisagreement = disagreementCounts(pre.settings.blind);
  return { pre, bundleViews, altViews, ttlViews, disagreement: countsDisagreement ? disagreementLines(states) : new Set(), countsDisagreement };
}

export function alternativeInputs(evaluation: ExtrasEvaluation, team: string[]) {
  return alternativeIssueInputs(evaluation.altViews, team);
}

export function ttlInputs(evaluation: ExtrasEvaluation) {
  return ttlIssueInputs(evaluation.ttlViews);
}

// ============================================================================
// JSON for AIs
// ============================================================================

export function serializeBundle(view: BundleView, lines: DocLine[]): Record<string, unknown> {
  const b = view.bundle;
  return {
    id: b.id, by: b.by, title: b.title, why: b.why, createdAt: b.createdAt,
    status: view.status, recordedStatus: b.status, closedAt: b.closedAt, closedBy: b.closedBy,
    summary: describeBundle(view), acceptable: view.acceptable, pending: view.pending, stale: view.stale,
    members: view.members.map((m, i) => ({
      markId: m.markId, state: m.state, stale: m.stale, staleReason: m.staleReason,
      lineIndex: m.lineIndex, ref: m.lineIndex === null ? null : `b${lines[m.lineIndex].block + 1}`,
      quote: b.members[i]?.quote ?? '', kind: b.members[i]?.kind ?? null,
    })),
  };
}

export function serializeAltSet(view: AltSetView, lines: DocLine[]): Record<string, unknown> {
  const line = lines[view.lineIndex];
  return {
    lineIndex: view.lineIndex, ref: `b${line.block + 1}`, hash: view.lineHash, summary: describeAltSet(view),
    options: view.options.map((o, i) => ({ ...o, key: String(i + 1) })),
    picks: [...view.picks.values()].map(p => ({ by: p.by, choice: p.hidden ? null : p.choice, at: p.at, ...(p.hidden ? { hidden: true } : {}) })),
    openFor: view.openFor, unanimous: view.unanimous, disagree: view.disagree,
  };
}

export function serializeTtl(view: TtlView, lines: DocLine[], now: number): Record<string, unknown> {
  const line = view.lineIndex === null ? null : lines[view.lineIndex];
  return {
    id: view.ttl.id, by: view.ttl.by, ttl: view.ttl.label, ttlMs: view.ttl.ttlMs, setAt: view.ttl.setAt,
    periodStart: view.ttl.periodStart, expiresAt: view.expiresAt, expired: view.expired, notTrue: view.notTrue,
    changed: view.changed, summary: describeTtl(view, now), decayedMarks: view.decayed, openFor: view.openFor, reason: view.reason,
    checks: view.ttl.checks, lineIndex: view.lineIndex, ref: line ? `b${line.block + 1}` : null, text: line ? line.text.slice(0, 300) : view.ttl.anchor.excerpt,
  };
}

export function serializeExplain(explain: ProofExplain): Record<string, unknown> {
  return { id: explain.id, by: explain.by, commentMarkId: explain.commentMarkId, question: explain.question, excerpt: explain.anchor.excerpt, createdAt: explain.createdAt };
}

/** Terms the document defines and where each is first used (team-neutral; the page links per reader). */
export function termsReport(lines: DocLine[]): Array<Record<string, unknown>> {
  const terms = findTerms(lines);
  const uses = firstTermUses(lines, terms);
  return terms.map(term => {
    const use = uses.find(u => u.term === term.term) ?? null;
    return { term: term.term, definition: term.definition, lineIndex: term.lineIndex, ref: `b${lines[term.lineIndex].block + 1}`, firstUse: use ? { lineIndex: use.lineIndex, from: use.from, to: use.to } : null };
  });
}

// ============================================================================
// Blind marking: what one viewer may see
// ============================================================================

/**
 * The lines revealed to `viewer` (their marks, their ask answers, their picks) and the line marks
 * with everyone else's positions on the other lines replaced by placeholders.
 */
export function blindViewFor(input: {
  lines: DocLine[];
  lineMarks: LineMark[];
  viewer: string;
  answeredLines?: Iterable<number>;
  picks: AltPick[];
}): { revealed: Set<number>; lineMarks: LineMark[]; picks: AltPick[]; hidden: number } {
  const me = actorKey(input.viewer);
  const pickedLines: number[] = [];
  const pickLine = (pick: AltPick): number | null => {
    const line = input.lines.find(l => l.hash === pick.lineHash);
    return line ? line.index : null;
  };
  for (const pick of input.picks) {
    if (actorKey(pick.by) !== me) continue;
    const index = pickLine(pick);
    if (index !== null) pickedLines.push(index);
  }
  const revealed = revealedLines(input.lines, input.lineMarks, input.viewer, [...(input.answeredLines ?? []), ...pickedLines]);
  const redacted = redactLineMarks(input.lines, input.lineMarks, input.viewer, revealed);
  let hiddenPicks = 0;
  const picks = input.picks.map(pick => {
    if (actorKey(pick.by) === me) return pick;
    const index = pickLine(pick);
    if (index !== null && revealed.has(index)) return pick;
    hiddenPicks += 1;
    return { ...pick, choice: ALT_POLICY.originalId, hidden: true };
  });
  return { revealed, lineMarks: redacted.marks, picks, hidden: redacted.hidden + hiddenPicks };
}

/**
 * Mike, 2026-09-23 (usability brief): an unrevealed Issue's existence, priority and counts can
 * disclose its cause. Omit position-dependent rows until their inputs can be shown.
 */
export function redactIssues(issues: ProofIssue[], revealed: ReadonlySet<number>): ProofIssue[] {
  return issues.filter(issue => {
    if (issue.type === 'comment' || issue.type === 'suggestion' || issue.type === 'nomination') return true;
    if (issue.type === 'objection') return objectionLinesRevealed(issue.lineIndices, revealed);
    return 'lineIndex' in issue && issue.lineIndex !== null && revealed.has(issue.lineIndex);
  });
}

export { BLIND_POLICY, hiddenMark, markLineIndex };
