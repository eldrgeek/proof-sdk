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

import { classifyLineChange } from './line-change.js';

/**
 * Step B3b: `skimmed` = the reader's focus passed the line faster than its reading time. It is
 * shown (a hollow dot) but it is not Seen: the line stays an Issue for that reader.
 */
export type LineMarkStatus = 'seen' | 'agreed' | 'approved' | 'rejected' | 'skimmed';
export const LINE_MARK_STATUSES: readonly LineMarkStatus[] = ['seen', 'agreed', 'approved', 'rejected', 'skimmed'];

/**
 * Step B3b: how a mark was earned, so the rail can say "seen by scrolling" vs "marked".
 *   dwell   - the reading walk: the line held the focus for its reading time (or was skimmed);
 *   click   - a button in the mark box, popover or sheet;
 *   key     - a keyboard shortcut (A);
 *   section - a whole folded section marked at once;
 *   ask     - answering the line's ask marked it Seen;
 *   api     - an AI or a script through the agent API (or an older mark with no record).
 *   edit    - (2026-09-19) the TM changed the meaning of another's statement: their Agreed on the new text;
 *   correct - (2026-09-19) the TM corrected another's statement without changing its meaning.
 *   proxy   - (2026-09-19) the TM ratified their Familiar's proxy mark ("Ratify all",
 *             src/shared/proxy-marks.ts). Written only by the server's ratify route.
 */
export type MarkVia = 'dwell' | 'click' | 'key' | 'section' | 'ask' | 'api' | 'edit' | 'correct' | 'proxy';
export const MARK_VIAS: readonly MarkVia[] = ['dwell', 'click', 'key', 'section', 'ask', 'api', 'edit', 'correct', 'proxy'];
/**
 * Earned without a deliberate choice about this one line (the ringer list watches these). A
 * ratified proxy is one click over many lines the person did not each read, so it is passive too.
 */
export const PASSIVE_VIAS: ReadonlySet<MarkVia> = new Set<MarkVia>(['dwell', 'section', 'proxy']);
/** Vias only the server may write (a client that claims one is refused). */
export const SERVER_ONLY_VIAS: ReadonlySet<MarkVia> = new Set<MarkVia>(['proxy']);

export function isMarkVia(value: unknown): value is MarkVia {
  return typeof value === 'string' && (MARK_VIAS as readonly string[]).includes(value);
}

/** Statuses that count as having seen the line. */
export function countsAsSeen(status: LineMarkStatus): boolean {
  return status !== 'skimmed';
}

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
  /**
   * Step B3b: the line's whole normalized text when it was marked (up to LINE_TEXT_MAX), so a
   * later cosmetic edit can carry the mark forward. Older marks have only the excerpt.
   */
  text?: string;
}

/** Step B3b: longest line text stored with a mark (longer lines keep only their excerpt: no carry). */
export const LINE_TEXT_MAX = 4000;

export interface LineMark {
  id: string;
  by: string;
  status: LineMarkStatus;
  reason?: string | null;
  at: string;
  anchor: LineAnchor;
  /** Step B3b: how the mark was earned (absent on older marks: read as "api"). */
  via?: MarkVia | null;
  /** Step B4c: an AI's one-line rationale for its mark (REVIEW_AIDS WHY_POLICY). */
  why?: string | null;
  /**
   * Proxy marks step: what the marker checked (one line). An AI mark without it shows as
   * "claimed" (EVIDENCE_POLICY in src/shared/proxy-marks.ts). A ratified proxy copies the
   * Familiar's evidence here.
   */
  evidence?: string | null;
  /** Proxy marks step: set when the mark came from ratifying a Familiar's proxy (via "proxy"). */
  proxy?: { familiar: string; proxyId: string; confidence: number; evidence: string; ratificationId: string } | null;
  /**
   * Step B4f (blind marking): a placeholder for someone else's mark on a line the viewer has not
   * marked yet. Its status reads as "seen" and its reason and why are removed; the UI shows
   * "marked (hidden until you mark this line)". Never written to storage.
   */
  hidden?: boolean;
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
  /**
   * Step B3b: a mark survives a cosmetic edit of its line (src/shared/line-change.ts), tagged
   * "carried". Off = every edit resets every mark (Step 1 behaviour).
   */
  carryCosmeticEdits: true,
} as const;

/**
 * Mike, 2026-09-19: "When there is a statement in a document proposed by another I can signify
 * my agreement explicitly or acceptance (and agreement) implicitly by scroll behavior. Or I can
 * modify the statement. If the statement is not meaning changing it is treated differently than
 * if it is meaningful."
 *
 * A line is "another's statement" for a viewer when someone other than the viewer wrote it
 * (its authored marks) or someone other than the viewer holds a current mark on it.
 */
export const STATEMENT_POLICY = {
  /** What reading another's statement by scrolling (dwell) gives the reader. */
  dwellOnOthersStatement: 'agreed' as LineMarkStatus,
  /** What reading one's own statement (or a line nobody else touched) by scrolling gives. */
  dwellOnOwnStatement: 'seen' as LineMarkStatus,
  /** A dwell Seen on another's statement is raised to the dwell status above on the next read. */
  upgradeDwellSeen: true,
  /** Editing another's statement: the editor's own mark becomes this (cosmetic or meaning change). */
  editorMarkOnEdit: 'agreed' as LineMarkStatus,
} as const;

/**
 * True when `line` is another's statement for `me` (see STATEMENT_POLICY).
 *   read - someone else wrote it (authored marks), or someone else claimed it deliberately: an
 *          Agreed or Approved they chose (not a passive dwell/section mark), or their edit of it.
 *          Passive reading never makes a line someone's statement, so reading cannot cascade.
 *   edit - someone else wrote it, or anyone else holds a current mark on it (other than skimmed):
 *          "a line others have marked".
 */
export function isOthersStatement(input: {
  /** The viewer's identities (line-mark actor and editor actor); compared by actorKey. */
  me: string[];
  /** Who wrote the line's text (authored marks), when known. */
  authors?: Array<string | null | undefined>;
  /** The line's current state (its marks by actor). */
  state?: Pick<LineState, 'marks'> | null;
  purpose?: 'read' | 'edit';
}): boolean {
  const mine = new Set(input.me.filter(Boolean).map(actorKey));
  for (const author of input.authors ?? []) {
    if (author && !mine.has(actorKey(author))) return true;
  }
  const purpose = input.purpose ?? 'read';
  for (const [key, entry] of input.state?.marks ?? []) {
    if (!entry.current || mine.has(key)) continue;
    const mark = entry.mark;
    if (mark.status === 'skimmed') continue;
    if (purpose === 'edit') return true;
    const via = (mark.via ?? 'api') as MarkVia;
    if (via === 'edit' || via === 'correct') return true;
    if ((mark.status === 'agreed' || mark.status === 'approved') && !PASSIVE_VIAS.has(via) && !mark.hidden) return true;
  }
  return false;
}

/** The status a dwell read gives, and whether to write it over the viewer's current status. */
export function dwellMarkFor(othersStatement: boolean, current: { status: string; via?: MarkVia | null } | null): LineMarkStatus | null {
  const target = othersStatement ? STATEMENT_POLICY.dwellOnOthersStatement : STATEMENT_POLICY.dwellOnOwnStatement;
  if (!current || current.status === 'unseen' || current.status === 'changed' || current.status === 'skimmed') return target;
  if (STATEMENT_POLICY.upgradeDwellSeen && current.status === 'seen' && target !== 'seen'
    && current.via === 'dwell') return target;
  return null;
}

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

/** Step B3c: a short deterministic hash of any text (snapshot fingerprints). */
export function hashText(text: string): string {
  return cyrb53(String(text ?? '')).toString(36);
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
  const anchor: LineAnchor = {
    hash: line.hash,
    occurrence: line.occurrence,
    ordinal: line.index,
    kind: line.kind,
    excerpt: line.text.slice(0, 80),
  };
  if (line.text.length <= LINE_TEXT_MAX) anchor.text = line.text;
  return anchor;
}

/** Step B3b: the full text a mark was made on, when known (an excerpt shorter than 80 is the whole line). */
export function anchorText(anchor: LineAnchor): string | null {
  if (typeof anchor.text === 'string' && anchor.text) return normalizeLineText(anchor.text);
  const excerpt = normalizeLineText(anchor.excerpt ?? '');
  // An excerpt is the first 80 characters: shorter means it is the whole line. Its hash must
  // match, so a trimmed excerpt of a longer line is never mistaken for the line.
  if (excerpt && excerpt.length < 80 && hashLine(anchor.kind, excerpt) === anchor.hash) return excerpt;
  return null;
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

/**
 * Step B6: display names for actors, registered from the server's identity directory (a verified
 * human's actor is their email; people see their Documents profile name instead).
 */
const actorLabels = new Map<string, string>();

export function registerActorLabels(labels: Record<string, string> | null | undefined): void {
  if (!labels) return;
  for (const [key, label] of Object.entries(labels)) {
    if (typeof label === 'string' && label.trim()) actorLabels.set(actorKey(key), label.trim());
  }
}

/**
 * The name people see for an actor. A guest (a typed name, including old "human:<name>" rows)
 * carries a visible " (guest)" suffix: it was not verified. Verified humans show their profile
 * name when known, else their email. AIs show their name.
 */
export function actorLabel(actor: string): string {
  const raw = String(actor ?? '').trim();
  const known = actorLabels.get(actorKey(raw));
  const body = raw.replace(/^(human|ai|guest):/i, '').trim() || raw;
  if (/^ai:/i.test(raw)) return known ?? body;
  const isGuest = /^guest:/i.test(raw) || (/^human:/i.test(raw) && !/^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(body)) || !/^(human|ai|guest):/i.test(raw);
  if (isGuest) return `${known ?? body} (guest)`;
  return known ?? body;
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
  /**
   * Step B4f: an Explain question (src/shared/explain.ts). The caller sets it only when
   * EXPLAIN_POLICY.commentIsIssue is false; such a comment is never an Issue.
   */
  explain?: boolean;
  /** Step B4e: the review bundle of a suggestion. */
  bundleId?: string;
  /** Step B4e: a suggestion's status (pending / accepted / rejected), when the caller knows it. */
  status?: string | null;
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
  /**
   * Step B6: maps actors to one identity per person. `actor` reads who did something (marks,
   * already canonical when they come from the server); `target` reads who is meant (owners,
   * comment authors, the people asked), so a comment typed as "Mike Wolf" counts as the verified
   * member of that name. Both default to identity (Step 1 behaviour).
   */
  identity?: { actor?: (actor: string) => string; target?: (actor: string) => string };
}): string[] {
  const team: string[] = [];
  const keys = new Set<string>();
  const asActor = input.identity?.actor ?? ((actor: string) => actor);
  const asTarget = input.identity?.target ?? ((actor: string) => actor);
  const add = (actor: string | null | undefined, map: (actor: string) => string = asActor) => {
    if (typeof actor !== 'string' || !actor.trim()) return;
    const trimmed = map(actor.trim()).trim();
    if (!trimmed) return;
    if (/^(system|ai:unknown|human:unknown|human:anonymous|guest:anonymous|guest:unknown)$/i.test(trimmed)) return;
    const key = actorKey(trimmed);
    if (keys.has(key)) return;
    keys.add(key);
    team.push(trimmed);
  };
  for (const owner of input.owners ?? []) add(owner, asTarget);
  for (const mark of input.lineMarks ?? []) add(mark.by);
  for (const mark of input.reviewMarks ?? []) {
    add(mark.by, asTarget);
    for (const reply of mark.replies ?? []) add(reply?.by, asTarget);
  }
  for (const actor of input.agentKeyActors ?? []) add(actor);
  for (const actor of input.extra ?? []) add(actor, asTarget);
  return team;
}

// ============================================================================
// Per-line state and Issues
// ============================================================================

export interface LineMarkEntry {
  mark: LineMark;
  /** True when the mark counts for the line's current text (exactly, or carried over a cosmetic edit). */
  current: boolean;
  /** Step B3b: the line changed cosmetically since the mark; the mark was carried forward. */
  carried?: boolean;
  /** Step B3b: for a carried mark, the text it was made on. */
  carriedFrom?: string;
  /**
   * Step B4f (perishable claims): the line's time-to-live expired after this Agreed/Approved mark
   * was made. The mark shows as "stale"; it still counts as Seen (src/shared/ttl.ts).
   */
  decayed?: boolean;
}

export interface LineState {
  line: DocLine;
  /** Keyed by actorKey(by). A current mark wins over a stale one; newer wins over older. */
  marks: Map<string, LineMarkEntry>;
}

/**
 * Step B3b: the line a stale mark carries to, when the marked text changed only cosmetically:
 * the nearest line (to where it was) of the same kind whose text is a cosmetic change of it.
 * Lines whose text some mark still matches exactly are not candidates (they were not edited).
 */
export function findCarryTarget(lines: DocLine[], anchor: LineAnchor, cache?: Map<string, boolean>): DocLine | null {
  if (!LINE_MARK_POLICY.carryCosmeticEdits) return null;
  const before = anchorText(anchor);
  if (!before) return null;
  let best: DocLine | null = null;
  const lo = before.length * 0.8 - 4;
  const hi = before.length * 1.25 + 4;
  for (const line of lines) {
    if (line.kind !== anchor.kind || line.hash === anchor.hash) continue;
    if (line.text.length < lo || line.text.length > hi) continue;
    const key = `${anchor.hash}|${line.hash}`;
    let cosmetic = cache?.get(key);
    if (cosmetic === undefined) {
      cosmetic = classifyLineChange(before, line.text).kind === 'cosmetic';
      cache?.set(key, cosmetic);
    }
    if (!cosmetic) continue;
    if (!best || Math.abs(line.index - anchor.ordinal) < Math.abs(best.index - anchor.ordinal)) best = line;
  }
  return best;
}

export function buildLineStates(lines: DocLine[], lineMarks: LineMark[]): LineState[] {
  const states: LineState[] = lines.map(line => ({ line, marks: new Map() }));
  const cache = new Map<string, boolean>();
  for (const mark of lineMarks) {
    if (!mark?.anchor) continue;
    let resolved: (ResolvedAnchor & { carried?: boolean }) | null = resolveLineAnchor(lines, mark.anchor);
    if (!resolved || !resolved.current) {
      // Step B3b: a cosmetic edit carries the mark to the new text.
      const target = findCarryTarget(lines, mark.anchor, cache);
      if (target) resolved = { lineIndex: target.index, current: true, carried: true };
    }
    if (!resolved) continue;
    const state = states[resolved.lineIndex];
    const key = actorKey(mark.by);
    const existing = state.marks.get(key);
    const candidate: LineMarkEntry = resolved.carried
      ? { mark, current: true, carried: true, carriedFrom: anchorText(mark.anchor) ?? undefined }
      : { mark, current: resolved.current };
    // An exact mark beats a carried one; a carried one beats a stale one.
    const rank = (entry: LineMarkEntry) => (entry.current ? (entry.carried ? 1 : 2) : 0);
    if (
      !existing
      || rank(candidate) > rank(existing)
      || (rank(candidate) === rank(existing) && String(mark.at) > String(existing.mark.at))
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
    /** Step B3b: members whose focus passed the line too fast (they are in unseenBy too). */
    skimmedBy: string[];
    /**
     * Step B4f (blind marking): revealed marks on the line disagree (an Agree or Approve and a
     * Reject). Set only while it counts for priority (BLIND_POLICY in src/shared/blind.ts).
     */
    disagreement?: boolean;
    /** Line tiers: the line is a context line (absent on decision lines). */
    tier?: 'context';
    /** Line tiers: the AIs that read this context line with evidence. */
    readBy?: string[];
    /** Line tiers: people this line would be unseen for, excused because an AI read it. */
    coveredFor?: string[];
  }
  | {
    /**
     * Step B4f: a line with competing wordings still open (src/shared/alternatives.ts). An Issue
     * for everyone who has not picked; when all picked but differ, for everyone (disagree).
     */
    type: 'alternative';
    lineIndex: number;
    pos: number;
    kind: string;
    excerpt: string;
    alternatives: number;
    openFor: string[];
    disagree: boolean;
    disagreement?: boolean;
  }
  | {
    /**
     * Step B4f: a perishable line whose time-to-live ran out (src/shared/ttl.ts). Open for the AI
     * collaborators to re-check ("still true?"), and for people only when the line changed since or
     * an AI said it is no longer true.
     */
    type: 'ttl';
    ttlId: string;
    lineIndex: number;
    pos: number;
    kind: string;
    excerpt: string;
    by: string;
    expiresAt: string;
    reason: 'expired' | 'not-true' | 'changed';
    openFor: string[];
  }
  | {
    /**
     * `{do}` action lines (src/shared/do.ts): an unfinished `{do}` (anything but done or withdrawn).
     * `openFor` is who it waits on now (empty: it waits on nobody, e.g. approved while execution
     * is not enabled, or on the machine).
     */
    type: 'do';
    doId: string;
    lineIndex: number;
    pos: number;
    kind: string;
    excerpt: string;
    by: string;
    state: string;
    label: string;
    openFor: string[];
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
    /**
     * Step B4c: a writer flagged the line uncertain. An Issue for each member (not the flagger)
     * who has not taken a deliberate position on the line since the flag (review-aids.ts).
     */
    type: 'uncertain';
    flagId: string;
    lineIndex: number;
    pos: number;
    kind: string;
    excerpt: string;
    by: string;
    note: string | null;
    openFor: string[];
  }
  | {
    /**
     * Step B4d: an open objection ("I'd agree if…") over one or more lines (objections.ts).
     * An Issue for everyone while open. lineIndex/pos are its first line still found (null when
     * every covered line was deleted).
     */
    type: 'objection';
    objectionId: string;
    lineIndex: number | null;
    lineIndices: number[];
    pos: number | null;
    kind: string;
    excerpt: string;
    by: string;
    reason: string;
    condition: string | null;
    deletedLines: number;
    repairPending: boolean;
  }
  | {
    type: 'comment' | 'suggestion';
    markId: string;
    pos: number | null;
    kind: string;
    by: string | null;
    excerpt: string;
    /** Step B4e: the review bundle this suggestion belongs to (src/shared/bundles.ts). */
    bundleId?: string;
  };

export interface IssueSummary {
  team: string[];
  issues: ProofIssue[];
  aligned: boolean;
  counts: { lines: number; lineIssues: number; reviewMarkIssues: number; askIssues: number; uncertainIssues: number; objectionIssues: number; alternativeIssues: number; ttlIssues: number; doIssues: number; total: number }
    /** Line tiers: present when the caller applied tiers (decision vs context lines and their line Issues). */
    & Partial<TierCounts>;
}

/** A `{do}` not yet done (src/shared/do.ts doIssueInputs; declared here to avoid an import cycle). */
export interface DoIssueInputLike {
  id: string;
  lineIndex: number;
  by: string;
  state: string;
  openFor: string[];
  label: string;
}

/** Step B4f: a line with open alternatives (src/shared/alternatives.ts alternativeIssueInputs). */
export interface AlternativeIssueInput {
  lineIndex: number;
  alternatives: number;
  openFor: string[];
  disagree: boolean;
}

/** Step B4f: an expired time-to-live that is an Issue (src/shared/ttl.ts ttlIssueInputs). */
export interface TtlIssueInput {
  id: string;
  lineIndex: number;
  by: string;
  expiresAt: string;
  reason: 'expired' | 'not-true' | 'changed';
  openFor: string[];
}

/** Step B4c: an uncertain flag that is an Issue (src/shared/review-aids.ts uncertainIssueInputs). */
export interface UncertainIssueInput {
  id: string;
  lineIndex: number;
  by: string;
  note: string | null;
  openFor: string[];
}

/** Step B4d: an open objection (src/shared/objections.ts objectionIssueInputs). */
export interface ObjectionIssueInput {
  id: string;
  lineIndices: number[];
  by: string;
  reason: string;
  condition: string | null;
  deletedLines: number;
  repairPending: boolean;
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

/**
 * Line tiers (src/shared/line-tiers.ts): one view per line, declared here to avoid an import cycle.
 * A line whose view `actsAsContext` is covered for people when an AI read it (readBy), nobody
 * rejected it and nothing open (per `openItems`) sits on it; then people's silence is not an Issue.
 */
export interface TierIssueView {
  lineIndex: number;
  tier: 'decision' | 'context';
  actsAsContext: boolean;
  /** An AI's context tag no person confirmed yet ("AI proposed context"). */
  proposed?: boolean;
  readBy: string[];
  /** People whose Familiar recommends rejecting the line: it stays their Issue. */
  flaggedFor: string[];
}

export interface TierIssueInput {
  views: TierIssueView[];
  openItems: {
    rejection: boolean; objection: boolean; ask: boolean; suggestion: boolean; comment: boolean;
    uncertainFlag: boolean; alternatives: boolean; expiredTtl: boolean; doAction: boolean;
  };
}

/** The line a review mark sits on: by position when the caller has one, else the first line holding its quote. */
export function lineOfReviewMark(lines: DocLine[], mark: Pick<ReviewMarkLike, 'pos' | 'quote'>): number | null {
  if (typeof mark.pos === 'number') {
    for (const line of lines) {
      if (mark.pos >= line.pos && mark.pos <= line.pos + line.nodeSize) return line.index;
    }
  }
  const quote = normalizeLineText(String(mark.quote ?? ''));
  if (!quote) return null;
  const found = lines.find(line => line.text.includes(quote));
  return found ? found.index : null;
}

/** Tier counts for alignment: lines of each tier, and the line Issues on each. */
export interface TierCounts {
  decision: { lines: number; issues: number };
  context: { lines: number; issues: number; readForPeople: number; proposed: number };
}

export function computeIssues(input: {
  lines: DocLine[];
  lineMarks: LineMark[];
  team: string[];
  reviewMarks?: ReviewMarkLike[];
  asks?: AskIssueInput[];
  /** Step B4c: uncertain flags that are Issues. */
  uncertain?: UncertainIssueInput[];
  /** Step B4d: open objections. */
  objections?: ObjectionIssueInput[];
  /** Step B4f: lines with open alternatives. */
  alternatives?: AlternativeIssueInput[];
  /** Step B4f: expired times-to-live. */
  ttl?: TtlIssueInput[];
  /** `{do}` action lines not yet done (src/shared/do.ts doIssueInputs). */
  dos?: DoIssueInputLike[];
  /** Step B4f (blind marking): lines whose revealed marks disagree, when that counts for priority. */
  disagreementLines?: ReadonlySet<number>;
  /** Step B4f: alternatives whose open-for list disagrees get `disagreement` too (blind on). */
  disagreementAlternatives?: boolean;
  /** Line tiers (src/shared/line-tiers.ts tierIssueInput). Absent: every line is a decision line. */
  tiers?: TierIssueInput;
}): IssueSummary {
  const states = buildLineStates(input.lines, input.lineMarks);
  const issues: ProofIssue[] = [];
  const tierView = new Map<number, TierIssueView>();
  for (const view of input.tiers?.views ?? []) tierView.set(view.lineIndex, view);
  // Line tiers: the lines something open sits on (a context line with one still needs people).
  const openLines = new Set<number>();
  if (input.tiers) {
    const open = input.tiers.openItems;
    if (open.ask) for (const ask of input.asks ?? []) if (ask.openFor.length > 0) openLines.add(ask.lineIndex);
    if (open.uncertainFlag) for (const flag of input.uncertain ?? []) if (flag.openFor.length > 0) openLines.add(flag.lineIndex);
    if (open.objection) for (const objection of input.objections ?? []) for (const index of objection.lineIndices) openLines.add(index);
    if (open.alternatives) for (const alt of input.alternatives ?? []) if (alt.openFor.length > 0) openLines.add(alt.lineIndex);
    if (open.expiredTtl) for (const ttl of input.ttl ?? []) if (ttl.openFor.length > 0) openLines.add(ttl.lineIndex);
    if (open.doAction) for (const item of input.dos ?? []) openLines.add(item.lineIndex);
    for (const mark of input.reviewMarks ?? []) {
      if (!mark.open || mark.explain) continue;
      if (mark.kind === 'comment' ? !open.comment : !open.suggestion) continue;
      const index = lineOfReviewMark(input.lines, mark);
      if (index !== null) openLines.add(index);
    }
  }
  const tierCounts: TierCounts = { decision: { lines: 0, issues: 0 }, context: { lines: 0, issues: 0, readForPeople: 0, proposed: 0 } };
  for (const state of states) {
    let unseenBy: string[] = [];
    let changedFor: string[] = [];
    let skimmedBy: string[] = [];
    for (const member of input.team) {
      const entry = state.marks.get(actorKey(member));
      if (!entry || !entry.current || !countsAsSeen(entry.mark.status)) unseenBy.push(member);
      if (entry && !entry.current) changedFor.push(member);
      if (entry && entry.current && entry.mark.status === 'skimmed') skimmedBy.push(member);
    }
    const rejectedBy: Array<{ by: string; reason: string | null }> = [];
    for (const entry of state.marks.values()) {
      if (entry.current && entry.mark.status === 'rejected') {
        rejectedBy.push({ by: entry.mark.by, reason: entry.mark.reason ?? null });
      }
    }
    // Line tiers: a covered context line is not an Issue for people (only for AIs that have not
    // read it, and for a person whose Familiar recommends rejecting it).
    const view = tierView.get(state.line.index);
    const context = Boolean(view?.actsAsContext);
    let coveredFor: string[] = [];
    if (context && view && input.tiers) {
      const rejected = rejectedBy.length > 0 && input.tiers.openItems.rejection;
      const covered = view.readBy.length > 0 && !rejected && !openLines.has(state.line.index);
      if (covered) {
        const flagged = new Set(view.flaggedFor.map(actorKey));
        const excused = (member: string) => !isAiActor(member) && !flagged.has(actorKey(member));
        coveredFor = unseenBy.filter(excused);
        unseenBy = unseenBy.filter(member => !excused(member));
        changedFor = changedFor.filter(member => !excused(member));
        skimmedBy = skimmedBy.filter(member => !excused(member));
        tierCounts.context.readForPeople += 1;
      }
    }
    if (input.tiers) {
      if (context) tierCounts.context.lines += 1; else tierCounts.decision.lines += 1;
      if (context && view?.proposed) tierCounts.context.proposed += 1;
    }
    const reasons: LineIssueReason[] = [];
    if (unseenBy.length > 0) reasons.push('unseen');
    if (changedFor.length > 0) reasons.push('changed');
    if (rejectedBy.length > 0) reasons.push('rejected');
    if (unseenBy.length === 0 && rejectedBy.length === 0) continue;
    if (input.tiers) {
      if (context) tierCounts.context.issues += 1; else tierCounts.decision.issues += 1;
    }
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
      skimmedBy,
      ...(input.disagreementLines?.has(state.line.index) ? { disagreement: true } : {}),
      ...(context ? { tier: 'context' as const, readBy: view?.readBy ?? [], ...(coveredFor.length ? { coveredFor } : {}) } : {}),
    });
  }
  let reviewMarkIssues = 0;
  if (LINE_MARK_POLICY.openReviewMarksAreIssues) {
    for (const mark of input.reviewMarks ?? []) {
      if (!mark.open || mark.explain) continue;
      reviewMarkIssues += 1;
      issues.push({
        type: mark.kind === 'comment' ? 'comment' : 'suggestion',
        markId: mark.id,
        pos: typeof mark.pos === 'number' ? mark.pos : null,
        kind: mark.kind,
        by: mark.by ?? null,
        excerpt: String(mark.quote ?? '').slice(0, 120),
        ...(mark.bundleId ? { bundleId: mark.bundleId } : {}),
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
  let uncertainIssues = 0;
  for (const flag of input.uncertain ?? []) {
    const line = input.lines[flag.lineIndex];
    if (!line || flag.openFor.length === 0) continue;
    uncertainIssues += 1;
    issues.push({
      type: 'uncertain',
      flagId: flag.id,
      lineIndex: line.index,
      pos: line.pos,
      kind: line.kind,
      excerpt: line.text.slice(0, 120),
      by: flag.by,
      note: flag.note,
      openFor: flag.openFor,
    });
  }
  let objectionIssues = 0;
  for (const objection of input.objections ?? []) {
    const found = objection.lineIndices.map(index => input.lines[index]).filter((line): line is DocLine => Boolean(line));
    const first = found[0] ?? null;
    objectionIssues += 1;
    issues.push({
      type: 'objection',
      objectionId: objection.id,
      lineIndex: first ? first.index : null,
      lineIndices: found.map(line => line.index),
      pos: first ? first.pos : null,
      kind: first ? first.kind : 'deleted',
      excerpt: first ? first.text.slice(0, 120) : '(the lines it covered were deleted)',
      by: objection.by,
      reason: objection.reason,
      condition: objection.condition,
      deletedLines: objection.deletedLines,
      repairPending: objection.repairPending,
    });
  }
  let alternativeIssues = 0;
  for (const alt of input.alternatives ?? []) {
    const line = input.lines[alt.lineIndex];
    if (!line || alt.openFor.length === 0) continue;
    alternativeIssues += 1;
    issues.push({
      type: 'alternative',
      lineIndex: line.index,
      pos: line.pos,
      kind: line.kind,
      excerpt: line.text.slice(0, 120),
      alternatives: alt.alternatives,
      openFor: alt.openFor,
      disagree: alt.disagree,
      ...(alt.disagree && input.disagreementAlternatives ? { disagreement: true } : {}),
    });
  }
  let ttlIssues = 0;
  for (const ttl of input.ttl ?? []) {
    const line = input.lines[ttl.lineIndex];
    if (!line || ttl.openFor.length === 0) continue;
    ttlIssues += 1;
    issues.push({
      type: 'ttl',
      ttlId: ttl.id,
      lineIndex: line.index,
      pos: line.pos,
      kind: line.kind,
      excerpt: line.text.slice(0, 120),
      by: ttl.by,
      expiresAt: ttl.expiresAt,
      reason: ttl.reason,
      openFor: ttl.openFor,
    });
  }
  let doIssues = 0;
  for (const item of input.dos ?? []) {
    const line = input.lines[item.lineIndex];
    if (!line) continue;
    doIssues += 1;
    issues.push({
      type: 'do',
      doId: item.id,
      lineIndex: line.index,
      pos: line.pos,
      kind: line.kind,
      excerpt: line.text.slice(0, 120),
      by: item.by,
      state: item.state,
      label: item.label,
      openFor: item.openFor,
    });
  }
  // Document order; review marks without a position go last. At one position an ask comes
  // before the line's own Issue, so Next issue lands on the decision first (then an objection,
  // then open alternatives, then an uncertain flag, then an expired time-to-live).
  const rank = (issue: ProofIssue) => (issue.type === 'ask' || issue.type === 'do' ? 0 : issue.type === 'objection' ? 1 : issue.type === 'alternative' ? 2
    : issue.type === 'uncertain' ? 3 : issue.type === 'ttl' ? 4 : issue.type === 'line' ? 5 : 6);
  issues.sort((a, b) => ((a.pos ?? Number.MAX_SAFE_INTEGER) - (b.pos ?? Number.MAX_SAFE_INTEGER)) || (rank(a) - rank(b)));
  const lineIssues = issues.length - reviewMarkIssues - askIssues - uncertainIssues - objectionIssues - alternativeIssues - ttlIssues - doIssues;
  return {
    team: input.team,
    issues,
    aligned: issues.length === 0,
    counts: {
      lines: input.lines.length, lineIssues, reviewMarkIssues, askIssues, uncertainIssues, objectionIssues, alternativeIssues, ttlIssues, doIssues, total: issues.length,
      ...(input.tiers ? tierCounts : {}),
    },
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
    && (anchor.excerpt === undefined || typeof anchor.excerpt === 'string')
    && (anchor.text === undefined || (typeof anchor.text === 'string' && anchor.text.length <= LINE_TEXT_MAX));
}
