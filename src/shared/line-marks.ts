/**
 * Proof Documents — Step 1: per-TM, per-line status marks and Issues.
 *
 * Authorship: spec by Mike Wolf ("Proof Documents" draft, 2026-09-18); built by
 * Claude Opus 5 (worker proof-line-marks), 2026-09-18. The rules marked POLICY below
 * are Claude's proposals pending Mike's ruling, kept in one place so they are easy to change.
 *
 * Pure code shared by the browser and the server. It never touches the document text:
 * a line mark is stored beside the document and points at a line through an anchor
 * (a hash of the line's text plus fallbacks). A mark whose hash no longer matches its
 * line's current text is "stale" and counts as unseen. That is how an edit resets marks
 * without edit hooks.
 */

export type LineMarkStatus = 'seen' | 'agreed' | 'approved' | 'rejected';
export const LINE_MARK_STATUSES: readonly LineMarkStatus[] = ['seen', 'agreed', 'approved', 'rejected'];

export interface LineAnchor {
  /** Hash of the line's kind and normalized text when it was marked. */
  hash: string;
  /** 0-based index among lines with the same hash (disambiguates duplicate lines). */
  occurrence: number;
  /** 0-based index of the line among all lines when it was marked (fallback for stale marks). */
  ordinal: number;
  kind: string;
  /** Up to 80 characters of the line, for humans and AIs reading the raw data. */
  excerpt: string;
}

export interface LineMark {
  id: string;
  by: string;
  status: LineMarkStatus;
  reason?: string | null;
  at: string;
  anchor: LineAnchor;
}

export interface DocLine {
  index: number;
  kind: string;
  text: string;
  hash: string;
  occurrence: number;
  /** ProseMirror position before the line's node. */
  pos: number;
  nodeSize: number;
  /** 0-based index of the top-level block that holds the line (agent snapshot ref b<block+1>). */
  block: number;
  /** Heading level (1-6) for a top-level heading; absent for every other line (Step B2 folding). */
  level?: number;
}

/** The subset of a ProseMirror Node this module reads (works for client and headless server docs). */
export interface LineSourceNode {
  type: { name: string };
  isTextblock: boolean;
  isAtom?: boolean;
  textContent: string;
  childCount: number;
  child(index: number): LineSourceNode;
  nodeSize: number;
  attrs?: Record<string, unknown>;
}

// ============================================================================
// POLICY (Claude's proposals, pending Mike's ruling)
// ============================================================================

export const LINE_MARK_POLICY = {
  /** Only an Owner may set Approved. */
  approveRequiresOwner: true,
  /** A Rejected mark must carry a reason. */
  rejectRequiresReason: true,
  /** An open comment or a pending suggestion is also an Issue. */
  openReviewMarksAreIssues: true,
  /** When a TM edits a line they had marked, their own mark follows the new text. */
  changerKeepsMark: true,
} as const;

// ============================================================================
// Lines
// ============================================================================

const TABLE_ROW_TYPES = new Set(['table_row', 'table_header_row']);

export function normalizeLineText(text: string): string {
  return String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** cyrb53: small, fast, deterministic 53-bit string hash (identical in browser and Node). */
function cyrb53(input: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function hashLine(kind: string, text: string): string {
  return cyrb53(`${kind}|${normalizeLineText(text)}`).toString(36);
}

/**
 * A "line" is a paragraph, heading, code block or list item (its text blocks), or a table row.
 * Lines with no visible text (blank paragraphs, image-only paragraphs, rules) are skipped.
 */
export function extractLines(doc: LineSourceNode): DocLine[] {
  const lines: DocLine[] = [];
  const seen = new Map<string, number>();
  let block = 0;
  const push = (kind: string, text: string, pos: number, nodeSize: number, level?: number) => {
    const normalized = normalizeLineText(text);
    if (!normalized) return;
    const hash = hashLine(kind, normalized);
    const occurrence = seen.get(hash) ?? 0;
    seen.set(hash, occurrence + 1);
    const line: DocLine = { index: lines.length, kind, text: normalized, hash, occurrence, pos, nodeSize, block };
    if (level !== undefined) line.level = level;
    lines.push(line);
  };
  const walk = (node: LineSourceNode, contentStart: number, parentName: string) => {
    let pos = contentStart;
    for (let i = 0; i < node.childCount; i += 1) {
      const child = node.child(i);
      const name = child.type.name;
      if (parentName === 'doc') block = i;
      if (TABLE_ROW_TYPES.has(name)) {
        const cells: string[] = [];
        for (let c = 0; c < child.childCount; c += 1) cells.push(normalizeLineText(child.child(c).textContent));
        push('table_row', cells.join(' | '), pos, child.nodeSize);
      } else if (child.isTextblock) {
        const kind = parentName === 'list_item' ? 'list_item' : name;
        const rawLevel = Number(child.attrs?.level);
        const level = name === 'heading' && parentName === 'doc'
          ? (Number.isInteger(rawLevel) && rawLevel >= 1 && rawLevel <= 6 ? rawLevel : 1)
          : undefined;
        push(kind, child.textContent, pos, child.nodeSize, level);
      } else if (child.childCount > 0 && !child.isAtom) {
        walk(child, pos + 1, name);
      }
      pos += child.nodeSize;
    }
  };
  walk(doc, 0, 'doc');
  return lines;
}

export function anchorForLine(line: DocLine): LineAnchor {
  return {
    hash: line.hash,
    occurrence: line.occurrence,
    ordinal: line.index,
    kind: line.kind,
    excerpt: line.text.slice(0, 80),
  };
}

export interface ResolvedAnchor {
  lineIndex: number;
  /** True when the line's text still matches the text that was marked. */
  current: boolean;
}

export function resolveLineAnchor(lines: DocLine[], anchor: LineAnchor): ResolvedAnchor | null {
  const candidates = lines.filter(line => line.hash === anchor.hash);
  if (candidates.length > 0) {
    const exact = candidates.find(line => line.occurrence === anchor.occurrence);
    if (exact) return { lineIndex: exact.index, current: true };
    let best = candidates[0];
    for (const line of candidates) {
      if (Math.abs(line.index - anchor.ordinal) < Math.abs(best.index - anchor.ordinal)) best = line;
    }
    return { lineIndex: best.index, current: true };
  }
  // Stale: the marked text is gone. Attach to the line now at the same place, only so
  // the UI can say "changed since you marked it". A stale mark counts as unseen.
  const atOrdinal = lines[anchor.ordinal];
  if (atOrdinal && atOrdinal.kind === anchor.kind) return { lineIndex: atOrdinal.index, current: false };
  return null;
}

// ============================================================================
// Identity and the team
// ============================================================================

export function actorKey(actor: string): string {
  return String(actor ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function actorLabel(actor: string): string {
  return String(actor ?? '').replace(/^(human|ai):/i, '').trim() || actor;
}

export function isAiActor(actor: string): boolean {
  return /^ai:/i.test(String(actor ?? '').trim());
}

/** The actor an agent key's AI marks as when it does not say who it is. */
export function agentKeyActor(label: string): string {
  const slug = String(label ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `ai:${slug || 'agent'}`;
}

export interface ReviewMarkLike {
  id: string;
  kind: string;
  by?: string | null;
  quote?: string | null;
  pos?: number | null;
  open: boolean;
  replies?: Array<{ by?: string | null }>;
}

/**
 * STEP 1 TEAM (isolated so Step 4 can replace it): the owner(s), plus every identity that has
 * line-marked, commented, replied or suggested in the document, plus active agent keys.
 * Returns actors in first-seen order, de-duplicated by actorKey.
 */
export function computeStep1Team(input: {
  owners?: string[];
  lineMarks?: Array<Pick<LineMark, 'by'>>;
  reviewMarks?: Array<Pick<ReviewMarkLike, 'by' | 'replies'>>;
  agentKeyActors?: string[];
  extra?: string[];
}): string[] {
  const team: string[] = [];
  const keys = new Set<string>();
  const add = (actor: string | null | undefined) => {
    if (typeof actor !== 'string' || !actor.trim()) return;
    const trimmed = actor.trim();
    if (/^(system|ai:unknown|human:unknown|human:anonymous)$/i.test(trimmed)) return;
    const key = actorKey(trimmed);
    if (keys.has(key)) return;
    keys.add(key);
    team.push(trimmed);
  };
  for (const owner of input.owners ?? []) add(owner);
  for (const mark of input.lineMarks ?? []) add(mark.by);
  for (const mark of input.reviewMarks ?? []) {
    add(mark.by);
    for (const reply of mark.replies ?? []) add(reply?.by);
  }
  for (const actor of input.agentKeyActors ?? []) add(actor);
  for (const actor of input.extra ?? []) add(actor);
  return team;
}

// ============================================================================
// Per-line state and Issues
// ============================================================================

export interface LineMarkEntry {
  mark: LineMark;
  current: boolean;
}

export interface LineState {
  line: DocLine;
  /** Keyed by actorKey(by). A current mark wins over a stale one; newer wins over older. */
  marks: Map<string, LineMarkEntry>;
}

export function buildLineStates(lines: DocLine[], lineMarks: LineMark[]): LineState[] {
  const states: LineState[] = lines.map(line => ({ line, marks: new Map() }));
  for (const mark of lineMarks) {
    if (!mark?.anchor) continue;
    const resolved = resolveLineAnchor(lines, mark.anchor);
    if (!resolved) continue;
    const state = states[resolved.lineIndex];
    const key = actorKey(mark.by);
    const existing = state.marks.get(key);
    const candidate = { mark, current: resolved.current };
    if (
      !existing
      || (candidate.current && !existing.current)
      || (candidate.current === existing.current && String(mark.at) > String(existing.mark.at))
    ) {
      state.marks.set(key, candidate);
    }
  }
  return states;
}

export type LineIssueReason = 'unseen' | 'rejected' | 'changed';

export type ProofIssue =
  | {
    type: 'line';
    lineIndex: number;
    pos: number;
    kind: string;
    excerpt: string;
    hash: string;
    reasons: LineIssueReason[];
    unseenBy: string[];
    changedFor: string[];
    rejectedBy: Array<{ by: string; reason: string | null }>;
  }
  | {
    /** Step B3: an ask on this line that someone it was asked of has not answered. */
    type: 'ask';
    askId: string;
    lineIndex: number;
    pos: number;
    kind: string;
    excerpt: string;
    by: string;
    recommend: string;
    openFor: string[];
    snoozedFor: string[];
  }
  | {
    type: 'comment' | 'suggestion';
    markId: string;
    pos: number | null;
    kind: string;
    by: string | null;
    excerpt: string;
  };

export interface IssueSummary {
  team: string[];
  issues: ProofIssue[];
  aligned: boolean;
  counts: { lines: number; lineIssues: number; reviewMarkIssues: number; askIssues: number; total: number };
}

/** Step B3: an open ask, already evaluated (src/shared/asks.ts askIssueInputs). */
export interface AskIssueInput {
  id: string;
  lineIndex: number;
  by: string;
  recommend: string;
  openFor: string[];
  snoozedFor: string[];
}

export function computeIssues(input: {
  lines: DocLine[];
  lineMarks: LineMark[];
  team: string[];
  reviewMarks?: ReviewMarkLike[];
  asks?: AskIssueInput[];
}): IssueSummary {
  const states = buildLineStates(input.lines, input.lineMarks);
  const issues: ProofIssue[] = [];
  for (const state of states) {
    const unseenBy: string[] = [];
    const changedFor: string[] = [];
    for (const member of input.team) {
      const entry = state.marks.get(actorKey(member));
      if (!entry || !entry.current) unseenBy.push(member);
      if (entry && !entry.current) changedFor.push(member);
    }
    const rejectedBy: Array<{ by: string; reason: string | null }> = [];
    for (const entry of state.marks.values()) {
      if (entry.current && entry.mark.status === 'rejected') {
        rejectedBy.push({ by: entry.mark.by, reason: entry.mark.reason ?? null });
      }
    }
    const reasons: LineIssueReason[] = [];
    if (unseenBy.length > 0) reasons.push('unseen');
    if (changedFor.length > 0) reasons.push('changed');
    if (rejectedBy.length > 0) reasons.push('rejected');
    if (unseenBy.length === 0 && rejectedBy.length === 0) continue;
    issues.push({
      type: 'line',
      lineIndex: state.line.index,
      pos: state.line.pos,
      kind: state.line.kind,
      excerpt: state.line.text.slice(0, 120),
      hash: state.line.hash,
      reasons,
      unseenBy,
      changedFor,
      rejectedBy,
    });
  }
  let reviewMarkIssues = 0;
  if (LINE_MARK_POLICY.openReviewMarksAreIssues) {
    for (const mark of input.reviewMarks ?? []) {
      if (!mark.open) continue;
      reviewMarkIssues += 1;
      issues.push({
        type: mark.kind === 'comment' ? 'comment' : 'suggestion',
        markId: mark.id,
        pos: typeof mark.pos === 'number' ? mark.pos : null,
        kind: mark.kind,
        by: mark.by ?? null,
        excerpt: String(mark.quote ?? '').slice(0, 120),
      });
    }
  }
  let askIssues = 0;
  for (const ask of input.asks ?? []) {
    const line = input.lines[ask.lineIndex];
    if (!line || ask.openFor.length === 0) continue;
    askIssues += 1;
    issues.push({
      type: 'ask',
      askId: ask.id,
      lineIndex: line.index,
      pos: line.pos,
      kind: line.kind,
      excerpt: line.text.slice(0, 120),
      by: ask.by,
      recommend: ask.recommend,
      openFor: ask.openFor,
      snoozedFor: ask.snoozedFor,
    });
  }
  // Document order; review marks without a position go last. At one position an ask comes
  // before the line's own Issue, so Next issue lands on the decision first.
  const rank = (issue: ProofIssue) => (issue.type === 'ask' ? 0 : issue.type === 'line' ? 1 : 2);
  issues.sort((a, b) => ((a.pos ?? Number.MAX_SAFE_INTEGER) - (b.pos ?? Number.MAX_SAFE_INTEGER)) || (rank(a) - rank(b)));
  const lineIssues = issues.length - reviewMarkIssues - askIssues;
  return {
    team: input.team,
    issues,
    aligned: issues.length === 0,
    counts: { lines: input.lines.length, lineIssues, reviewMarkIssues, askIssues, total: issues.length },
  };
}

export function isLineMarkStatus(value: unknown): value is LineMarkStatus {
  return typeof value === 'string' && (LINE_MARK_STATUSES as readonly string[]).includes(value);
}

export function isLineAnchor(value: unknown): value is LineAnchor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const anchor = value as Record<string, unknown>;
  return typeof anchor.hash === 'string' && anchor.hash.length > 0 && anchor.hash.length <= 32
    && Number.isInteger(anchor.occurrence) && Number(anchor.occurrence) >= 0
    && Number.isInteger(anchor.ordinal) && Number(anchor.ordinal) >= 0
    && typeof anchor.kind === 'string' && anchor.kind.length <= 40
    && (anchor.excerpt === undefined || typeof anchor.excerpt === 'string');
}
