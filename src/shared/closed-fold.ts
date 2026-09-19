/**
 * Proof Documents — closed Issues fold for the person who closed them (pure state, no DOM).
 *
 * Mike, 2026-09-19: "When an issue is closed by a user, it should be folded for that user."
 *
 * When the viewer explicitly closes their Issue on a line (Agree / Approve / Reject with a reason,
 * answers an ask, accepts or rejects a suggestion, resolves a comment, clears an objection, picks a
 * wording), the line collapses FOR THAT VIEWER into a thin one-line summary. It unfolds by itself
 * when the line becomes an Issue again for them: its text changes (an edit), or something new
 * lands on it (a suggestion, a comment, a reply, an ask, an objection).
 *
 * Passive reads (dwell, section marks, a Familiar's proxy) never fold a line (CLOSED_FOLD_POLICY.
 * passiveReadsFold, a question for Mike: default no).
 *
 * Authorship: Claude Opus 5 (worker proof-hover), 2026-09-19, from Mike's words that day.
 */

export type ClosureKind =
  | 'agreed' | 'approved' | 'rejected'
  | 'accepted' | 'suggestion-rejected' | 'resolved'
  | 'answered' | 'objection-cleared' | 'picked';

export const CLOSED_FOLD_POLICY = {
  /** Master switch. */
  enabled: true,
  /** Mike's open question: should a line read passively (dwell) fold too? Default no. */
  passiveReadsFold: false,
  /** Line statuses whose explicit (click / key) mark closes the viewer's Issue on the line. */
  closingStatuses: ['agreed', 'approved', 'rejected'] as readonly string[],
  /**
   * After a closure the line stays open this long (the reader sees what they did), and the
   * closure's own effects (an accepted suggestion rewrites the line) settle before the line's
   * "what is open on it" is frozen for the reopen test.
   */
  settleMs: 1200,
  /**
   * The line the reader is on (the focus line) does not fold under their eyes: it folds once the
   * focus moves to another line.
   */
  deferWhileFocused: true,
  /**
   * A newly closed line folds only once it is out of view (scrolled away), so text the reader can
   * see never jumps (the editing-first rule: nothing moves the view). Lines already folded when
   * the page opens fold at once. false: fold as soon as the focus leaves the line.
   */
  foldOnlyOutOfView: true,
  /** ...and only once scrolling has paused this long (a fold never lands mid-gesture). */
  foldIdleMs: 700,
  /** A closure whose line still carries something open for the viewer after the settle does not fold. */
  foldOnlyWhenNothingOpen: true,
  /** Line kinds that fold (headings and code keep the page's structure readable). */
  foldableKinds: ['paragraph', 'list_item'] as readonly string[],
  /** The summary shows this many of the line's first words. */
  summaryWords: 8,
  /** The summary's lead-in per closure kind. */
  labels: {
    agreed: '✓ agreed',
    approved: '✓ approved',
    rejected: '✗ rejected',
    accepted: '✓ change accepted',
    'suggestion-rejected': '✗ change rejected',
    resolved: '✓ comment resolved',
    answered: '✓ answered',
    'objection-cleared': '✓ objection cleared',
    picked: '✓ wording picked',
  } as Record<ClosureKind, string>,
  /** Records kept per document and viewer (oldest dropped first). */
  maxRecords: 2000,
  /** localStorage key prefix (+ slug + ':' + actor key). */
  storagePrefix: 'proof:closed-fold:',
} as const;

export interface ClosedLineInput {
  index: number;
  /** `${hash}:${occurrence}` — the line's text identity. */
  key: string;
  kind: string;
  text: string;
  /** Everything open for the viewer on the line (ids, with reply counts), sorted or not. */
  open: string[];
}

export interface ClosedRecord {
  key: string;
  kind: ClosureKind;
  closedAt: number;
  /** Line index at closure (used until the record settles). */
  index: number;
  /** Set once settled: what was open on the line then (sorted, joined). */
  frozen?: string;
  /** The viewer expanded this folded line by hand. */
  expanded?: boolean;
}

export interface FoldedLine {
  index: number;
  key: string;
  summary: string;
  kind: ClosureKind;
}

export function summaryFor(kind: ClosureKind, text: string, words = CLOSED_FOLD_POLICY.summaryWords): string {
  const all = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  const head = all.slice(0, words).join(' ');
  const label = CLOSED_FOLD_POLICY.labels[kind] ?? '✓ closed';
  return head ? `${label} — ${head}${all.length > words ? '…' : ''}` : label;
}

function openSig(open: string[]): string {
  return [...open].sort().join(',');
}

export class ClosedFoldState {
  private records: ClosedRecord[] = [];
  /** All folded lines shown open at once ("Unfold closed"); restorable with foldAll(). */
  showAll = false;

  constructor(records: ClosedRecord[] = [], showAll = false) {
    this.records = records.slice(-CLOSED_FOLD_POLICY.maxRecords);
    this.showAll = showAll;
  }

  list(): ClosedRecord[] { return this.records.slice(); }

  /** The viewer explicitly closed their Issue on line `index` (text identity `key`). */
  note(index: number, key: string, kind: ClosureKind, now: number): void {
    if (!CLOSED_FOLD_POLICY.enabled || index < 0) return;
    this.records = this.records.filter(r => r.key !== key && !(r.frozen === undefined && r.index === index));
    this.records.push({ key, kind, closedAt: now, index });
    if (this.records.length > CLOSED_FOLD_POLICY.maxRecords) this.records.splice(0, this.records.length - CLOSED_FOLD_POLICY.maxRecords);
  }

  /**
   * Brings the records up to date with the lines now. Returns true when a record changed
   * (settled, reopened or dropped), so the caller can persist.
   */
  sync(lines: ClosedLineInput[], now: number): boolean {
    let changed = false;
    const byKey = new Map(lines.map(line => [line.key, line]));
    const next: ClosedRecord[] = [];
    for (const record of this.records) {
      if (record.frozen === undefined) {
        const line = lines[record.index];
        if (!line) { changed = true; continue; }
        // The closure's own effect (an accepted change) may rewrite the line: follow it by index.
        if (line.key !== record.key) { record.key = line.key; changed = true; }
        if (now - record.closedAt >= CLOSED_FOLD_POLICY.settleMs) {
          if (CLOSED_FOLD_POLICY.foldOnlyWhenNothingOpen && line.open.length > 0) { changed = true; continue; }
          record.frozen = openSig(line.open);
          changed = true;
        }
        next.push(record);
        continue;
      }
      const line = byKey.get(record.key);
      // The text changed (an edit): the line unfolds. The record stays, dormant (it cannot be told
      // apart from a page still loading its text); it only folds again if this exact text returns.
      if (!line) { next.push(record); continue; }
      // Something new is open on it (suggestion, comment, reply, ask, objection): unfold.
      if (openSig(line.open) !== record.frozen) { changed = true; continue; }
      record.index = line.index;
      next.push(record);
    }
    this.records = next;
    return changed;
  }

  /** Lines folded now (settled, not expanded, of a foldable kind). */
  folded(lines: ClosedLineInput[]): FoldedLine[] {
    if (!CLOSED_FOLD_POLICY.enabled || this.showAll) return [];
    const byKey = new Map(lines.map(line => [line.key, line]));
    const out: FoldedLine[] = [];
    for (const record of this.records) {
      if (record.frozen === undefined || record.expanded) continue;
      const line = byKey.get(record.key);
      if (!line || !CLOSED_FOLD_POLICY.foldableKinds.includes(line.kind)) continue;
      out.push({ index: line.index, key: line.key, summary: summaryFor(record.kind, line.text), kind: record.kind });
    }
    return out.sort((a, b) => a.index - b.index);
  }

  /** Settled records whose lines are shown open (by hand or by "Unfold closed"). */
  expandedCount(): number {
    return this.records.filter(r => r.frozen !== undefined && (r.expanded || this.showAll)).length;
  }

  /** Ms until the next unsettled record settles (null when none). */
  nextSettleIn(now: number): number | null {
    let best: number | null = null;
    for (const r of this.records) {
      if (r.frozen !== undefined) continue;
      const wait = Math.max(0, CLOSED_FOLD_POLICY.settleMs - (now - r.closedAt));
      best = best === null ? wait : Math.min(best, wait);
    }
    return best;
  }

  /** The viewer opened one folded line. */
  expand(key: string): boolean {
    const record = this.records.find(r => r.key === key && r.frozen !== undefined);
    if (!record || record.expanded) return false;
    record.expanded = true;
    return true;
  }

  /** "Unfold closed": every closed line shows open (restorable). */
  unfoldAll(): void { this.showAll = true; }

  /** "Fold closed": fold every closed line again, including ones opened by hand. */
  foldAll(): void {
    this.showAll = false;
    for (const r of this.records) delete r.expanded;
  }

  toJSON(): { records: ClosedRecord[]; showAll: boolean } {
    return { records: this.records, showAll: this.showAll };
  }

  static fromJSON(raw: unknown): ClosedFoldState {
    const value = raw as { records?: unknown; showAll?: unknown } | null;
    const records = Array.isArray(value?.records) ? value!.records.filter((r): r is ClosedRecord => {
      const rec = r as ClosedRecord;
      return Boolean(rec) && typeof rec.key === 'string' && typeof rec.kind === 'string' && typeof rec.closedAt === 'number' && typeof rec.index === 'number';
    }) : [];
    return new ClosedFoldState(records, value?.showAll === true);
  }
}
