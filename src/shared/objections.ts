/**
 * Proof Documents — Step B4d: objections with a resolution condition (pure code, shared by the
 * browser and the server).
 *
 * Authorship: idea from OpenAI Astra (research round 1, idea 5, after IETF rough consensus,
 * RFC 7282); brief by the COS (Claude), 2026-09-19; built by Claude Opus 5 (worker proof-aids),
 * 2026-09-19. POLICY rules are Claude's decisions where the brief is silent.
 *
 * An objection is a Reject that says "I'd agree if…" and may cover several lines. It is stored
 * independently of the text (its own table), so edits cannot erase it:
 *   - each covered line keeps the anchor it had when objected to, and a "current" anchor that is
 *     re-found after every edit (exact text anywhere, else the most similar line of the same kind);
 *   - a covered line that cannot be re-found is "deleted": the objection stays open and says so;
 *   - only the objector (a verified identity) clears it, or an Owner overrides it with a reason;
 *   - while open it is an Issue for everyone;
 *   - when a covered line changes, is deleted, or gains a pending suggestion, "a repair was
 *     proposed": the objector sees it in Since you and the rail offers Clear / Keep.
 */
import { actorKey, type DocLine, type LineAnchor, type ObjectionIssueInput } from './line-marks.js';

export const OBJECTION_POLICY = {
  /** An objection needs a reason, like any Reject. */
  reasonRequired: true,
  /** "I'd agree if…" is optional (a multi-line Reject without one is still an objection). */
  conditionRequired: false,
  /** A Reject becomes an objection when it has a condition or covers more than one line. */
  becomesObjection: 'condition-or-several-lines' as const,
  maxLines: 50,
  maxReason: 500,
  maxCondition: 500,
  /**
   * Re-finding a changed line: the most similar line of the same kind (word overlap, Dice
   * coefficient) at or above this is the same line, edited. Below it, the line counts as deleted.
   */
  refindMinSimilarity: 0.5,
  /**
   * A rewritten line is also re-found by its slot: a line of the same kind whose neighbours are
   * the covered line's last-known neighbours (both: any similarity; one: at least this much).
   */
  refindSlotMinSimilarity: 0.2,
  /** Guests (a typed name, not verified) cannot object: only a verified identity can clear it. */
  guestsMayObject: false,
  /** An Owner can override (clear) someone else's objection, and must give a reason. */
  ownerMayOverride: true,
  overrideReasonRequired: true,
  /** Objecting sets the objector's marks on the covered lines to Seen (decision: they read them). */
  objectorMarksSeen: true,
  /** Rail and page keys are not bound for objections (R opens the Reject form). */
} as const;

export type ObjectionStatus = 'open' | 'cleared' | 'overridden';

export interface ObjectionLine {
  /** The line when it was objected to. */
  original: LineAnchor;
  /** Where the line was last found (re-anchored on server reads). */
  current: LineAnchor;
  /** Null until the line is first found deleted; the time it was noticed. */
  deletedAt?: string | null;
  /** Hashes of the lines just before and after it when last found (its slot). */
  before?: string | null;
  after?: string | null;
}

export interface ObjectionAck {
  /** Per covered line: the hash the objector last saw ("deleted" for a deleted line). */
  hashes: string[];
  /** Pending suggestions on the covered lines the objector already saw. */
  suggestions: string[];
}

export interface ProofObjection {
  id: string;
  by: string;
  reason: string;
  condition: string | null;
  lines: ObjectionLine[];
  createdAt: string;
  status: ObjectionStatus;
  closedAt: string | null;
  closedBy: string | null;
  overrideReason: string | null;
  /** What the objector has already seen (created, or "Keep"): later changes are a repair. */
  ack: ObjectionAck;
  keptAt: string | null;
}

export const DELETED = 'deleted';

// ============================================================================
// Re-finding lines
// ============================================================================

function words(text: string): string[] {
  return String(text ?? '').toLowerCase().normalize('NFC').split(/[^\p{L}\p{N}']+/u).filter(Boolean);
}

/** Dice coefficient over word multisets (0..1). */
export function similarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 && wb.length === 0) return 1;
  if (wa.length === 0 || wb.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const w of wa) counts.set(w, (counts.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of wb) {
    const n = counts.get(w) ?? 0;
    if (n > 0) { common += 1; counts.set(w, n - 1); }
  }
  return (2 * common) / (wa.length + wb.length);
}

function anchorTextOf(anchor: LineAnchor): string {
  return typeof anchor.text === 'string' && anchor.text ? anchor.text : String(anchor.excerpt ?? '');
}

export interface RefoundLine { lineIndex: number; exact: boolean; score: number }

/**
 * Finds the line an anchor now names: its exact text (same occurrence, else the nearest copy),
 * else the most similar unclaimed line of the same kind. Null when none is similar enough.
 */
export function refindLine(lines: DocLine[], anchor: LineAnchor, claimed: ReadonlySet<number> = new Set(), slot: { before?: string | null; after?: string | null } = {}): RefoundLine | null {
  const exact = lines.filter(line => line.hash === anchor.hash && !claimed.has(line.index));
  if (exact.length > 0) {
    const same = exact.find(line => line.occurrence === anchor.occurrence);
    const best = same ?? exact.reduce((a, b) => (Math.abs(b.index - anchor.ordinal) < Math.abs(a.index - anchor.ordinal) ? b : a));
    return { lineIndex: best.index, exact: true, score: 1 };
  }
  const before = anchorTextOf(anchor);
  if (!before) return null;
  let best: RefoundLine | null = null;
  for (const line of lines) {
    if (line.kind !== anchor.kind || claimed.has(line.index)) continue;
    const score = similarity(before, line.text);
    // The slot: the same neighbours as when the line was last found (a rewrite in place).
    const prevOk = Boolean(slot.before) && lines[line.index - 1]?.hash === slot.before;
    const nextOk = Boolean(slot.after) && lines[line.index + 1]?.hash === slot.after;
    const slotScore = prevOk && nextOk ? 0.99 : (prevOk || nextOk) && score >= OBJECTION_POLICY.refindSlotMinSimilarity ? Math.max(score, 0.5) : 0;
    if (Math.max(score, slotScore) < OBJECTION_POLICY.refindMinSimilarity) continue;
    const effective = Math.max(score, slotScore);
    if (!best || effective > best.score
      || (effective === best.score && Math.abs(line.index - anchor.ordinal) < Math.abs(best.lineIndex - anchor.ordinal))) {
      best = { lineIndex: line.index, exact: false, score: effective };
    }
  }
  return best;
}

// ============================================================================
// Evaluation
// ============================================================================

export interface ObjectionView {
  objection: ProofObjection;
  /** Per covered line: its index now, or null when deleted. */
  lineIndices: Array<number | null>;
  /** Per covered line: its hash now (DELETED when deleted). */
  hashes: string[];
  /** Covered lines whose text differs from what the objector last saw. */
  changed: boolean[];
  deletedLines: number;
  /** Pending suggestions on covered lines now. */
  suggestions: string[];
  /** Something changed since the objector's last look (edit, deletion, or a new suggestion). */
  repairPending: boolean;
  open: boolean;
}

/**
 * Evaluates an objection against the current lines. `suggestionsOnLine` names the pending
 * suggestions that sit on a line (the page knows positions; the server matches quotes).
 */
export function evaluateObjection(objection: ProofObjection, lines: DocLine[], suggestionsOnLine: (lineIndex: number) => string[] = () => []): ObjectionView {
  const claimed = new Set<number>();
  const lineIndices: Array<number | null> = [];
  // Exact matches first, so a rewritten line cannot claim a line another covered line still is.
  const found: Array<number | null> = objection.lines.map(() => null);
  objection.lines.forEach((covered, i) => {
    const exact = refindLine(lines.filter(line => line.hash === covered.current.hash), covered.current, claimed);
    if (exact) { found[i] = exact.lineIndex; claimed.add(exact.lineIndex); }
  });
  objection.lines.forEach((covered, i) => {
    if (found[i] !== null) return;
    const slot = { before: covered.before ?? null, after: covered.after ?? null };
    const hit = refindLine(lines, covered.current, claimed, slot) ?? (covered.current.hash !== covered.original.hash ? refindLine(lines, covered.original, claimed, slot) : null);
    if (hit) { found[i] = hit.lineIndex; claimed.add(hit.lineIndex); }
  });
  lineIndices.push(...found);
  const hashes = lineIndices.map(index => (index === null ? DELETED : lines[index].hash));
  const changed = hashes.map((hash, i) => hash !== (objection.ack.hashes[i] ?? objection.lines[i].original.hash));
  const suggestions = [...new Set(lineIndices.flatMap(index => (index === null ? [] : suggestionsOnLine(index))))];
  const seen = new Set(objection.ack.suggestions);
  const repairPending = objection.status === 'open' && (changed.some(Boolean) || suggestions.some(id => !seen.has(id)));
  return {
    objection,
    lineIndices,
    hashes,
    changed,
    deletedLines: lineIndices.filter(index => index === null).length,
    suggestions,
    repairPending,
    open: objection.status === 'open',
  };
}

export function evaluateObjections(objections: ProofObjection[], lines: DocLine[], suggestionsOnLine?: (lineIndex: number) => string[]): ObjectionView[] {
  return objections.map(objection => evaluateObjection(objection, lines, suggestionsOnLine));
}

/** Open objections as Issue inputs (an Issue for everyone while open). */
export function objectionIssueInputs(views: ObjectionView[]): ObjectionIssueInput[] {
  return views.filter(view => view.open).map(view => ({
    id: view.objection.id,
    lineIndices: view.lineIndices.filter((index): index is number => index !== null),
    by: view.objection.by,
    reason: view.objection.reason,
    condition: view.objection.condition,
    deletedLines: view.deletedLines,
    repairPending: view.repairPending,
  }));
}

/** The slot (neighbour hashes) of a line now. */
export function slotOf(lines: DocLine[], index: number): { before: string | null; after: string | null } {
  return { before: lines[index - 1]?.hash ?? null, after: lines[index + 1]?.hash ?? null };
}

/** The ack a "Keep" records: everything the objector sees now. */
export function ackFor(view: ObjectionView): ObjectionAck {
  return { hashes: [...view.hashes], suggestions: [...new Set([...view.objection.ack.suggestions, ...view.suggestions])] };
}

/** Lines (index) covered by an open objection, with the objections on each. */
export function objectedLines(views: ObjectionView[]): Map<number, ObjectionView[]> {
  const out = new Map<number, ObjectionView[]>();
  for (const view of views) {
    if (!view.open) continue;
    for (const index of view.lineIndices) {
      if (index === null) continue;
      const list = out.get(index) ?? [];
      list.push(view);
      out.set(index, list);
    }
  }
  return out;
}

export function isObjector(objection: ProofObjection, actor: string): boolean {
  return actorKey(objection.by) === actorKey(actor);
}

/** Plain-language status for the rail and for AIs. */
export function describeObjection(view: ObjectionView): string {
  const parts: string[] = [];
  if (!view.open) return view.objection.status === 'overridden' ? 'Overridden by an Owner' : 'Cleared by the objector';
  parts.push(`Open, ${view.objection.lines.length === 1 ? '1 line' : `${view.objection.lines.length} lines`}`);
  if (view.deletedLines > 0) parts.push(`${view.deletedLines} of them deleted`);
  if (view.repairPending) parts.push('a repair was proposed');
  return parts.join('; ');
}
