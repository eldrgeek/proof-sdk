/**
 * Proof Documents — Step B3c: "Since you" and the aligned snapshot (pure code, shared).
 *
 * Authorship: direction by Mike Wolf (Proof Documents, 2026-09-18; the ringer list is his MDP
 * ruling of 2026-09-03); ideas from the overnight research round (Anthropic Fable and OpenAI
 * Astra); built by Claude Opus 5 (worker proof-honest), 2026-09-18.
 *
 * Since you: when a reader comes back, the right rail lists what happened since they last marked
 * a line on purpose (or since the last aligned snapshot, when that is later and they were on its
 * team): lines edited, new asks, other people's rejections with reasons, suggestions and
 * comments added. The ringer list names the lines that count as seen for the reader only because
 * of passive reading (scrolling, a folded section) and that changed or gained something since.
 *
 * Aligned snapshot: when the Issue count reaches 0 the server freezes the document, every line
 * mark, the asks with answers and the team. A snapshot is a baseline for the next round.
 */
import {
  PASSIVE_VIAS,
  actorKey,
  actorLabel,
  anchorText,
  buildLineStates,
  hashText,
  normalizeLineText,
  resolveLineAnchor,
  type DocLine,
  type LineMark,
  type MarkVia,
} from './line-marks.js';
import { ASK_CHOICE_LABEL, type ProofAsk } from './asks.js';

export const SINCE_YOU = {
  /** At most this many items per list (the response says how many there were). */
  maxItemsPerList: 50,
  /** A later aligned snapshot the reader was on the team of moves the baseline forward. */
  snapshotMovesBaseline: true,
} as const;

export const ALIGNED_SNAPSHOT = {
  /** Snapshots kept per document (oldest dropped). */
  keepPerDocument: 50,
  /** A document with no lines or no team is never "aligned" for a snapshot. */
  requireLinesAndTeam: true,
} as const;

// ============================================================================
// Since you
// ============================================================================

export interface SinceReviewMark {
  id: string;
  kind: string;
  by: string | null;
  quote: string;
  createdAt: string | null;
  open: boolean;
  status?: string | null;
  text?: string | null;
  content?: string | null;
  replies: Array<{ by: string | null; at: string | null; text: string | null }>;
}

export interface SinceSnapshotBaseline {
  id: string;
  createdAt: string;
  team: string[];
  lines: Array<{ hash: string; occurrence: number; text: string }>;
}

export type SinceItemType = 'edited' | 'ask' | 'rejection' | 'suggestion' | 'comment' | 'reply' | 'repair';

export interface SinceItem {
  type: SinceItemType;
  lineIndex: number | null;
  hash: string | null;
  occurrence: number | null;
  excerpt: string;
  by?: string | null;
  at?: string | null;
  /** edited: the text you marked (when known), "cosmetic" for a carried mark. */
  from?: string | null;
  change?: 'substantive' | 'cosmetic' | 'new-since-snapshot';
  reason?: string | null;
  markId?: string;
  askId?: string;
  /** Step B4d: a repair was proposed to your objection. */
  objectionId?: string;
  detail?: string | null;
}

export interface RingerItem {
  lineIndex: number;
  hash: string;
  occurrence: number;
  excerpt: string;
  /** How your Seen was earned (dwell = scrolling, section = a folded section). */
  via: MarkVia;
  markedAt: string;
  why: string;
  from?: string | null;
}

export interface SinceYouReport {
  actor: string;
  /** False when the reader has never marked a line on purpose and was on no aligned snapshot. */
  hasHistory: boolean;
  lastMarkedAt: string | null;
  baseline: { at: string | null; source: 'mark' | 'snapshot' | 'none'; snapshotId?: string };
  edited: SinceItem[];
  asks: SinceItem[];
  rejections: SinceItem[];
  suggestions: SinceItem[];
  comments: SinceItem[];
  ringers: RingerItem[];
  /** Step B4d: your open objections whose lines changed or gained a suggestion since you looked. */
  repairs: SinceItem[];
  counts: { edited: number; asks: number; rejections: number; suggestions: number; comments: number; ringers: number; repairs: number; total: number };
}

/** An explicit mark: chosen for this one line (not a scroll, not a folded section, not a skim). */
export function isExplicitMark(mark: LineMark): boolean {
  if (mark.status === 'skimmed') return false;
  if (mark.status === 'agreed' || mark.status === 'approved' || mark.status === 'rejected') return true;
  return !PASSIVE_VIAS.has((mark.via ?? 'api') as MarkVia);
}

function lineOfQuote(lines: DocLine[], quote: string): DocLine | null {
  const q = normalizeLineText(quote);
  if (!q) return null;
  const probe = q.slice(0, 60);
  return lines.find(line => line.text.includes(probe)) ?? lines.find(line => probe.includes(line.text) && line.text.length > 8) ?? null;
}

const after = (at: string | null | undefined, baseline: string | null) => Boolean(at) && (!baseline || String(at) > baseline);

export function computeSinceYou(input: {
  actor: string;
  lines: DocLine[];
  /** Canonical line marks (identity merges applied). */
  lineMarks: LineMark[];
  /** Canonical asks. */
  asks: ProofAsk[];
  reviewMarks: SinceReviewMark[];
  /** The latest aligned snapshot, if any. */
  snapshot?: SinceSnapshotBaseline | null;
  /** Is this review-mark author (a typed name or an actor) the reader? */
  isMe?: (by: string | null) => boolean;
}): SinceYouReport {
  const me = actorKey(input.actor);
  const isMe = input.isMe ?? ((by: string | null) => Boolean(by) && actorKey(String(by)) === me);
  const mine = input.lineMarks.filter(mark => actorKey(mark.by) === me);
  const explicit = mine.filter(isExplicitMark);
  const lastMarkedAt = explicit.reduce<string | null>((max, mark) => (!max || mark.at > max ? mark.at : max), null);
  const snap = input.snapshot ?? null;
  const onSnapshotTeam = Boolean(snap && snap.team.some(member => actorKey(member) === me));
  let baseline: SinceYouReport['baseline'] = { at: lastMarkedAt, source: lastMarkedAt ? 'mark' : 'none' };
  if (SINCE_YOU.snapshotMovesBaseline && snap && onSnapshotTeam && (!lastMarkedAt || snap.createdAt > lastMarkedAt)) {
    baseline = { at: snap.createdAt, source: 'snapshot', snapshotId: snap.id };
  }
  const hasHistory = Boolean(lastMarkedAt) || onSnapshotTeam;
  const since = baseline.at;
  const states = buildLineStates(input.lines, input.lineMarks);
  const describe = (line: DocLine | null | undefined) => ({
    lineIndex: line ? line.index : null,
    hash: line ? line.hash : null,
    occurrence: line ? line.occurrence : null,
    excerpt: line ? line.text.slice(0, 160) : '',
  });

  // Lines edited since: your mark went out of date (substantive) or was carried (cosmetic).
  const edited: SinceItem[] = [];
  const editedLines = new Set<number>();
  for (const state of states) {
    const entry = state.marks.get(me);
    if (!entry) continue;
    if (!entry.current) {
      edited.push({ type: 'edited', ...describe(state.line), change: 'substantive', from: anchorText(entry.mark.anchor) ?? entry.mark.anchor.excerpt, at: entry.mark.at });
      editedLines.add(state.line.index);
    } else if (entry.carried) {
      edited.push({ type: 'edited', ...describe(state.line), change: 'cosmetic', from: entry.carriedFrom ?? null, at: entry.mark.at });
      editedLines.add(state.line.index);
    }
  }
  // Since the snapshot: lines whose text the snapshot did not have (new or changed lines).
  if (baseline.source === 'snapshot' && snap) {
    const had = new Set(snap.lines.map(line => `${line.hash}:${line.occurrence}`));
    for (const line of input.lines) {
      if (editedLines.has(line.index) || had.has(`${line.hash}:${line.occurrence}`)) continue;
      edited.push({ type: 'edited', ...describe(line), change: 'new-since-snapshot', from: null });
      editedLines.add(line.index);
    }
  }

  // New asks (not yours).
  const asks: SinceItem[] = [];
  for (const ask of input.asks) {
    if (actorKey(ask.by) === me || !after(ask.askedAt, since)) continue;
    const resolved = resolveLineAnchor(input.lines, ask.anchor);
    const line = resolved ? input.lines[resolved.lineIndex] : null;
    asks.push({ type: 'ask', ...describe(line), excerpt: line?.text.slice(0, 160) ?? ask.anchor.excerpt, askId: ask.id, by: ask.by, at: ask.askedAt, detail: `Recommends: ${ask.recommend}` });
  }

  // Rejections by others, with reasons (current marks only: a rejection of old text is moot).
  const rejections: SinceItem[] = [];
  for (const state of states) {
    for (const [key, entry] of state.marks) {
      if (key === me || !entry.current || entry.mark.status !== 'rejected' || !after(entry.mark.at, since)) continue;
      rejections.push({ type: 'rejection', ...describe(state.line), by: entry.mark.by, at: entry.mark.at, reason: entry.mark.reason ?? null });
    }
  }

  // Suggestions and comments added (and replies), not yours.
  const suggestions: SinceItem[] = [];
  const comments: SinceItem[] = [];
  for (const mark of input.reviewMarks) {
    const line = lineOfQuote(input.lines, mark.quote);
    if (mark.kind === 'comment') {
      if (!isMe(mark.by) && after(mark.createdAt, since)) {
        comments.push({ type: 'comment', ...describe(line), markId: mark.id, by: mark.by, at: mark.createdAt, detail: mark.text ?? null, reason: mark.open ? null : 'resolved' });
      }
      for (const reply of mark.replies) {
        if (isMe(reply.by) || !after(reply.at, since)) continue;
        comments.push({ type: 'reply', ...describe(line), markId: mark.id, by: reply.by, at: reply.at, detail: reply.text ?? null });
      }
    } else if (!isMe(mark.by) && after(mark.createdAt, since)) {
      const what = mark.kind === 'insert' ? `insert “${mark.content ?? ''}”` : mark.kind === 'delete' ? `delete “${mark.quote}”` : `“${mark.quote}” → “${mark.content ?? ''}”`;
      suggestions.push({ type: 'suggestion', ...describe(line), markId: mark.id, by: mark.by, at: mark.createdAt, detail: what, reason: mark.status && mark.status !== 'pending' ? mark.status : null });
    }
  }

  // The ringer list: seen only passively, and something changed or arrived on the line since.
  const ringers: RingerItem[] = [];
  const reviewByLine = new Map<number, SinceReviewMark[]>();
  for (const mark of input.reviewMarks) {
    const line = lineOfQuote(input.lines, mark.quote);
    if (!line) continue;
    const list = reviewByLine.get(line.index) ?? [];
    list.push(mark);
    reviewByLine.set(line.index, list);
  }
  for (const state of states) {
    const entry = state.marks.get(me);
    if (!entry || !entry.current || entry.mark.status !== 'seen') continue;
    const via = (entry.mark.via ?? 'api') as MarkVia;
    if (!PASSIVE_VIAS.has(via)) continue;
    const reasons: string[] = [];
    if (entry.carried) reasons.push('edited (small wording fix) after you scrolled past it');
    const newer = (reviewByLine.get(state.line.index) ?? []).filter(mark => !isMe(mark.by) && after(mark.createdAt, entry.mark.at));
    if (newer.some(mark => mark.kind === 'comment')) reasons.push('a comment was added after');
    if (newer.some(mark => mark.kind !== 'comment')) reasons.push('a suggestion was added after');
    for (const [key, other] of state.marks) {
      if (key !== me && other.current && other.mark.status === 'rejected' && other.mark.at > entry.mark.at) {
        reasons.push(`${actorLabel(other.mark.by)} rejected it after`);
      }
    }
    for (const ask of input.asks) {
      const resolved = resolveLineAnchor(input.lines, ask.anchor);
      if (resolved?.lineIndex === state.line.index && ask.askedAt > entry.mark.at) reasons.push('an ask was put on it after');
    }
    if (reasons.length === 0) continue;
    ringers.push({
      lineIndex: state.line.index,
      hash: state.line.hash,
      occurrence: state.line.occurrence,
      excerpt: state.line.text.slice(0, 160),
      via,
      markedAt: entry.mark.at,
      why: reasons.join('; '),
      ...(entry.carried ? { from: entry.carriedFrom ?? null } : {}),
    });
  }

  const cap = <T>(list: T[]) => list.slice(0, SINCE_YOU.maxItemsPerList);
  const byTime = (a: SinceItem, b: SinceItem) => String(b.at ?? '').localeCompare(String(a.at ?? ''));
  const counts = {
    edited: edited.length,
    asks: asks.length,
    rejections: rejections.length,
    suggestions: suggestions.length,
    comments: comments.length,
    ringers: ringers.length,
    repairs: 0,
    total: 0,
  };
  counts.total = counts.edited + counts.asks + counts.rejections + counts.suggestions + counts.comments + counts.ringers;
  return {
    actor: input.actor,
    hasHistory,
    lastMarkedAt,
    baseline,
    edited: cap(edited.sort((a, b) => (a.lineIndex ?? 0) - (b.lineIndex ?? 0))),
    asks: cap(asks.sort(byTime)),
    rejections: cap(rejections.sort(byTime)),
    suggestions: cap(suggestions.sort(byTime)),
    comments: cap(comments.sort(byTime)),
    ringers: cap(ringers),
    repairs: [],
    counts,
  };
}

// ============================================================================
// Aligned snapshot
// ============================================================================

export interface SnapshotLineMark {
  lineIndex: number;
  hash: string;
  text: string;
  by: string;
  status: string;
  via: string;
  reason: string | null;
  at: string;
  carried: boolean;
}

export interface SnapshotPayload {
  version: 1;
  slug: string;
  title: string | null;
  createdAt: string;
  team: string[];
  teamLabels: Record<string, string>;
  lines: Array<{ index: number; hash: string; occurrence: number; kind: string; text: string }>;
  lineMarks: SnapshotLineMark[];
  asks: Array<{ id: string; by: string; to: string[]; recommend: string; question: string; askedAt: string; answers: Array<{ by: string; choice: string; words: string; at: string }> }>;
  counts: { lines: number; lineMarks: number; asks: number; team: number };
}

export function buildSnapshotPayload(input: {
  slug: string;
  title?: string | null;
  createdAt: string;
  team: string[];
  lines: DocLine[];
  lineMarks: LineMark[];
  asks: ProofAsk[];
}): SnapshotPayload {
  const states = buildLineStates(input.lines, input.lineMarks);
  const lineMarks: SnapshotLineMark[] = [];
  for (const state of states) {
    for (const entry of state.marks.values()) {
      if (!entry.current) continue;
      lineMarks.push({
        lineIndex: state.line.index,
        hash: state.line.hash,
        text: state.line.text.slice(0, 200),
        by: entry.mark.by,
        status: entry.mark.status,
        via: entry.mark.via ?? 'api',
        reason: entry.mark.reason ?? null,
        at: entry.mark.at,
        carried: Boolean(entry.carried),
      });
    }
  }
  const teamLabels: Record<string, string> = {};
  for (const member of input.team) teamLabels[member] = actorLabel(member);
  const asks = input.asks.map(ask => {
    const resolved = resolveLineAnchor(input.lines, ask.anchor);
    return {
      id: ask.id,
      by: ask.by,
      to: ask.to,
      recommend: ask.recommend,
      question: resolved ? input.lines[resolved.lineIndex].text.slice(0, 300) : ask.anchor.excerpt,
      askedAt: ask.askedAt,
      answers: ask.answers.map(answer => ({ by: answer.by, choice: answer.choice, words: answer.words, at: answer.at })),
    };
  });
  return {
    version: 1,
    slug: input.slug,
    title: input.title ?? null,
    createdAt: input.createdAt,
    team: input.team,
    teamLabels,
    lines: input.lines.map(line => ({ index: line.index, hash: line.hash, occurrence: line.occurrence, kind: line.kind, text: line.text })),
    lineMarks,
    asks,
    counts: { lines: input.lines.length, lineMarks: lineMarks.length, asks: asks.length, team: input.team.length },
  };
}

/**
 * What makes two aligned states the same (no new snapshot): the text, the team, every counted
 * mark (actor, line, status) and every ask answer. Mark ids and times do not matter.
 */
export function snapshotFingerprint(markdown: string, payload: SnapshotPayload): string {
  const marks = payload.lineMarks.map(mark => `${actorKey(mark.by)}@${mark.hash}:${mark.status}`).sort();
  const asks = payload.asks.map(ask => `${ask.id}:${ask.answers.map(a => `${actorKey(a.by)}=${a.choice}`).sort().join(',')}`).sort();
  const team = payload.team.map(actorKey).sort();
  return hashText(JSON.stringify([markdown, team, marks, asks]));
}

function fenceFor(markdown: string): string {
  let longest = 0;
  for (const match of markdown.match(/`+/g) ?? []) longest = Math.max(longest, match.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

const cell = (text: unknown) => String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** The ledger: a markdown record of one aligned snapshot, readable by people and AIs. */
export function renderSnapshotLedger(id: string, markdown: string, payload: SnapshotPayload): string {
  const label = (actor: string) => payload.teamLabels[actor] ?? actorLabel(actor);
  const out: string[] = [];
  out.push(`# Aligned snapshot${payload.title ? `: ${payload.title}` : ''}`);
  out.push('');
  out.push(`- Document: \`${payload.slug}\``);
  out.push(`- Snapshot: \`${id}\``);
  out.push(`- Aligned at: ${payload.createdAt}`);
  out.push(`- Team (${payload.team.length}): ${payload.team.map(member => `${label(member)} (\`${member}\`)`).join(', ')}`);
  out.push(`- Lines: ${payload.counts.lines} · line marks: ${payload.counts.lineMarks} · asks: ${payload.counts.asks}`);
  out.push('');
  out.push('Aligned means: every team member had seen every line, no one had rejected a line, and no ask, comment or suggestion was open.');
  out.push('');
  out.push('## Line marks');
  out.push('');
  out.push('| Line | Text | Who | Mark | How | Hash | When |');
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const mark of payload.lineMarks) {
    const how = `${mark.via}${mark.carried ? ', carried over a small edit' : ''}`;
    out.push(`| ${mark.lineIndex + 1} | ${cell(mark.text.slice(0, 80))} | ${cell(label(mark.by))} | ${mark.status}${mark.reason ? `: ${cell(mark.reason)}` : ''} | ${how} | \`${mark.hash}\` | ${mark.at} |`);
  }
  out.push('');
  out.push('## Asks');
  out.push('');
  if (payload.asks.length === 0) out.push('No asks.');
  for (const ask of payload.asks) {
    out.push(`- **${cell(ask.question)}** — asked by ${label(ask.by)}${ask.to.length ? ` of ${ask.to.map(label).join(', ')}` : ''} at ${ask.askedAt}; recommends: ${cell(ask.recommend)}`);
    for (const answer of ask.answers) {
      out.push(`  - ${label(answer.by)}: ${ASK_CHOICE_LABEL[answer.choice as keyof typeof ASK_CHOICE_LABEL] ?? answer.choice}${answer.words ? ` — “${cell(answer.words)}”` : ''} (${answer.at})`);
    }
  }
  out.push('');
  out.push('## Document');
  out.push('');
  const fence = fenceFor(markdown);
  out.push(`${fence}markdown`);
  out.push(markdown);
  out.push(fence);
  out.push('');
  return out.join('\n');
}
