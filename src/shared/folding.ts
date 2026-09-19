/**
 * Proof Documents — Step B2: folding (pure code, shared by the browser and the server).
 *
 * Authorship: spec by Mike Wolf ("A Proof Document typically has a hierarchical outline and can
 * be folded and unfolded in the Proof Editor"; "A folded section carries one or two marks: one
 * indicates 'issues remain' the other 'issues resolved'"); section marking and the policy below
 * are the COS's decisions; built by Claude Opus 5 (worker proof-fold), 2026-09-18.
 *
 * A section is a top-level heading plus everything after it until the next top-level heading of
 * the same or a higher level (an H2 section ends at the next H1 or H2). Folding is a view state
 * only: it never changes the document's text, its marks or its Yjs state.
 */
import type { DocLine, IssueSummary, LineMarkStatus } from './line-marks.js';

// ============================================================================
// POLICY (the COS's decisions where the spec is silent; each is a one-line change)
// ============================================================================

export const FOLDING = {
  /** A mark chosen on a FOLDED heading applies to every line in its section (COS decision). */
  foldedHeadingScope: 'section' as 'section' | 'heading',
  /** A mark chosen on an UNFOLDED heading applies to the heading line only. */
  unfoldedHeadingScope: 'heading' as 'section' | 'heading',
  /** Reject needs a specific line: a folded section cannot be rejected as a whole. */
  allowSectionReject: false,
  /** A section-wide mark never overwrites the viewer's own Rejected mark on a line inside. */
  sectionMarkKeepsRejects: true,
  /** A section-wide mark never lowers a stronger mark (an Approved line stays Approved on Agree). */
  sectionMarkNeverDowngrades: true,
  /** "Clear my mark" on a folded heading clears the heading line only, never the whole section. */
  sectionClearAllowed: false,
  /** How long the "Undo" toast after a section mark stays up. */
  undoToastMs: 8000,
  /** The largest batch the line-mark routes accept in one request. */
  maxBatchLines: 1000,
  /** localStorage key prefix; the value is the list of folded heading keys (hash:occurrence). */
  storagePrefix: 'proof:fold:',
  /** The badge counts the same Issues as the top bar (team-wide), restricted to the section. */
  badgeCounts: 'team' as 'team',
} as const;

/**
 * Mike, 2026-09-19: "Leaving a group with no issues closes the group. Hovering over a closed group
 * opens it." and "When a folded item below an H level is unfolded it does not refold."
 *
 * The one model every folding and focus path in Proof follows:
 *   1. An explicit person action beats any automatic one. A section the person unfolded by hand
 *      stays unfolded (`sticky`): no auto-close, no fold-to-level and no later fold pass refolds
 *      it. Only another explicit fold (its chip, Fold all, fold-to-level used again on it after a
 *      deliberate fold) takes the stickiness off.
 *   2. Nothing folds or moves under the reader's eyes. An automatic fold waits until the section
 *      is out of view and scrolling has settled (the same rule closed-Issue folding already uses).
 *   3. Hover previews; click commits. Hovering a folded heading peeks its body open without
 *      changing the stored fold state; moving away re-folds it. A click changes the state.
 */
export const SECTION_AUTOCLOSE = {
  enabled: true,
  /** Only a section with no Issues for the viewer closes itself. */
  requireZeroIssues: true,
  /**
   * Whose Issues count. Mike's words are "a group with no issues" from the reader's side, so this
   * is the viewer's own open Issues (an unread line of theirs, a rejection, an open comment or
   * suggestion on it) — not the team-wide count the fold chip's badge shows, which would keep a
   * section open because a teammate has not read it yet.
   */
  countIssues: 'viewer' as 'viewer' | 'team',
  /** ...and only one with at least this many body lines (folding a one-line section is noise). */
  minBodyLines: 2,
  /** The reading focus must have left the section, and the section must be out of view... */
  requireOutOfView: true,
  /** ...and scrolling must have been still this long (rule 2: nothing folds under the reader). */
  idleMs: 700,
  /** Rule 1: a section the person unfolded by hand never auto-closes. */
  respectStickyUnfold: true,
  /** Rule 3: hovering a folded heading peeks it open. */
  hoverPeek: true,
  /** Rest this long on the folded heading before it peeks. */
  hoverPeekDelayMs: 150,
  /** Re-fold this long after the pointer leaves (a peek that flickers is worse than no peek). */
  hoverPeekLeaveMs: 260,
  /** localStorage key prefix for the set of sections the person unfolded by hand. */
  stickyPrefix: 'proof:fold-sticky:',
} as const;

export interface AutoCloseInput {
  sections: DocSection[];
  folded: ReadonlySet<string>;
  /** Sections the person unfolded by hand (rule 1). */
  sticky: ReadonlySet<string>;
  /** The reading / hover focus line, or -1. */
  focusLine: number;
  /** Issues in the section for the viewer. */
  issueTotal: (section: DocSection) => number;
  /** Is any part of the section on screen? (rule 2) */
  inView: (section: DocSection) => boolean;
}

/**
 * The sections that should close themselves now: zero Issues, the focus has left them, they are
 * out of view, and the person has not unfolded them by hand. Pure: the caller folds the keys.
 */
export function planAutoClose(input: AutoCloseInput): string[] {
  if (!SECTION_AUTOCLOSE.enabled) return [];
  const out: string[] = [];
  for (const section of input.sections) {
    if (input.folded.has(section.key)) continue;
    if (SECTION_AUTOCLOSE.respectStickyUnfold && input.sticky.has(section.key)) continue;
    const bodyLines = section.lineEnd - section.headingIndex - 1;
    if (bodyLines < SECTION_AUTOCLOSE.minBodyLines) continue;
    // The focus is still inside it: leaving is the trigger, so it has not been left yet.
    if (input.focusLine >= section.headingIndex && input.focusLine < section.lineEnd) continue;
    if (SECTION_AUTOCLOSE.requireZeroIssues && input.issueTotal(section) > 0) continue;
    if (SECTION_AUTOCLOSE.requireOutOfView && input.inView(section)) continue;
    out.push(section.key);
  }
  return out;
}

/**
 * Fold to level N while keeping rule 1: sections the person unfolded by hand stay unfolded.
 * (`foldToLevel` is the raw shape; this is what a person's "H2" button does.)
 */
export function foldToLevelRespectingSticky(sections: DocSection[], level: number, sticky: ReadonlySet<string>): Set<string> {
  const folded = foldToLevel(sections, level);
  for (const key of sticky) folded.delete(key);
  return folded;
}

const STATUS_RANK: Record<LineMarkStatus, number> = { skimmed: 0, seen: 1, agreed: 2, approved: 3, rejected: 0 };

// ============================================================================
// Sections
// ============================================================================

export interface DocSection {
  /** Line index of the heading. */
  headingIndex: number;
  level: number;
  /** Stable view key of the heading: `${hash}:${occurrence}` (what fold state is stored under). */
  key: string;
  /** Top-level block index of the heading. */
  block: number;
  /** First top-level block after the section (exclusive); blockCount for the last section. */
  endBlock: number;
  /** First line after the section (exclusive). Lines headingIndex+1 .. lineEnd-1 are its body. */
  lineEnd: number;
  /** Heading line index of the enclosing section, or null. */
  parent: number | null;
}

export function headingKey(line: Pick<DocLine, 'hash' | 'occurrence'>): string {
  return `${line.hash}:${line.occurrence}`;
}

/** Every section of the document, in document order (nested sections included). */
export function computeSections(lines: DocLine[], blockCount = Number.MAX_SAFE_INTEGER): DocSection[] {
  const headings = lines.filter(line => typeof line.level === 'number');
  const sections: DocSection[] = [];
  const stack: DocSection[] = [];
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    const level = heading.level as number;
    let end: DocLine | undefined;
    for (let j = i + 1; j < headings.length; j += 1) {
      if ((headings[j].level as number) <= level) { end = headings[j]; break; }
    }
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const section: DocSection = {
      headingIndex: heading.index,
      level,
      key: headingKey(heading),
      block: heading.block,
      endBlock: end ? end.block : blockCount,
      lineEnd: end ? end.index : lines.length,
      parent: stack.length ? stack[stack.length - 1].headingIndex : null,
    };
    sections.push(section);
    stack.push(section);
  }
  return sections;
}

/** Line indices in the section: the heading and its body. */
export function sectionLineIndices(section: DocSection): number[] {
  const out: number[] = [];
  for (let i = section.headingIndex; i < section.lineEnd; i += 1) out.push(i);
  return out;
}

export function sectionByHeading(sections: DocSection[], headingIndex: number): DocSection | undefined {
  return sections.find(section => section.headingIndex === headingIndex);
}

/** Folded sections, keeping only keys that still name a heading. */
export function foldedSections(sections: DocSection[], folded: ReadonlySet<string>): DocSection[] {
  return sections.filter(section => folded.has(section.key));
}

/** Lines the reader cannot see: the bodies of folded sections. */
export function hiddenLineSet(sections: DocSection[], folded: ReadonlySet<string>): Set<number> {
  const hidden = new Set<number>();
  for (const section of foldedSections(sections, folded)) {
    for (let i = section.headingIndex + 1; i < section.lineEnd; i += 1) hidden.add(i);
  }
  return hidden;
}

/** Top-level block ranges [from, to) to hide, merged and sorted. */
export function hiddenBlockRanges(sections: DocSection[], folded: ReadonlySet<string>): Array<[number, number]> {
  const ranges = foldedSections(sections, folded)
    .map(section => [section.block + 1, section.endBlock] as [number, number])
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/** The folded sections that hide a line, outermost first (empty when it is visible). */
export function foldedAncestors(sections: DocSection[], folded: ReadonlySet<string>, lineIndex: number): DocSection[] {
  return foldedSections(sections, folded)
    .filter(section => lineIndex > section.headingIndex && lineIndex < section.lineEnd)
    .sort((a, b) => a.headingIndex - b.headingIndex);
}

/** The visible line that stands for a hidden one: the heading of its outermost folded section. */
export function visibleLineFor(sections: DocSection[], folded: ReadonlySet<string>, lineIndex: number): number {
  const ancestors = foldedAncestors(sections, folded, lineIndex);
  return ancestors.length ? ancestors[0].headingIndex : lineIndex;
}

/**
 * Fold to level N: every heading of level N or deeper whose enclosing sections are all shallower
 * than N is folded; everything else is unfolded. So level 1 shows only the H1s, level 2 shows the
 * H1s and H2s, and so on.
 */
export function foldToLevel(sections: DocSection[], level: number): Set<string> {
  const byHeading = new Map(sections.map(section => [section.headingIndex, section]));
  const folded = new Set<string>();
  for (const section of sections) {
    if (section.level < level) continue;
    const parent = section.parent === null ? null : byHeading.get(section.parent);
    if (!parent || parent.level < level) folded.add(section.key);
  }
  return folded;
}

/** Heading levels present in the document (for the fold-to-level control). */
export function headingLevels(sections: DocSection[]): number[] {
  return [...new Set(sections.map(section => section.level))].sort((a, b) => a - b);
}

// ============================================================================
// Issue counts per section
// ============================================================================

export interface SectionIssueCount {
  total: number;
  lines: number;
  reviewMarks: number;
  /** Step B3: open asks in the section. */
  asks: number;
  /** Step B4c/B4d: uncertain flags and objections in the section. */
  aids: number;
}

/** The Issues (same computation as the top bar) that sit inside the section, heading included. */
export function sectionIssueCount(section: DocSection, lines: DocLine[], summary: IssueSummary | null): SectionIssueCount {
  const count: SectionIssueCount = { total: 0, lines: 0, reviewMarks: 0, asks: 0, aids: 0 };
  if (!summary) return count;
  const from = lines[section.headingIndex]?.pos ?? 0;
  const to = section.lineEnd < lines.length ? lines[section.lineEnd].pos : Number.POSITIVE_INFINITY;
  for (const issue of summary.issues) {
    if (issue.type === 'line') {
      if (issue.lineIndex >= section.headingIndex && issue.lineIndex < section.lineEnd) count.lines += 1;
    } else if (issue.type === 'ask' || issue.type === 'do') {
      if (issue.lineIndex >= section.headingIndex && issue.lineIndex < section.lineEnd) count.asks += 1;
    } else if (issue.type === 'uncertain' || issue.type === 'objection' || issue.type === 'alternative' || issue.type === 'ttl') {
      if (issue.lineIndex !== null && issue.lineIndex >= section.headingIndex && issue.lineIndex < section.lineEnd) count.aids += 1;
    } else if (typeof issue.pos === 'number' && issue.pos >= from && issue.pos < to) {
      count.reviewMarks += 1;
    }
  }
  count.total = count.lines + count.reviewMarks + count.asks + count.aids;
  return count;
}

// ============================================================================
// Marking a whole section
// ============================================================================

export interface MyLineMark {
  status: LineMarkStatus;
  reason: string | null;
  /** False when the line changed since the mark was set (the mark no longer counts). */
  current: boolean;
}

export type SectionSkipReason = 'rejected' | 'stronger' | 'same';

export interface SectionMarkPlan {
  /** Lines the section mark writes. */
  apply: number[];
  skipped: Array<{ lineIndex: number; reason: SectionSkipReason }>;
}

/** Which lines of a section a section-wide mark changes, under the FOLDING policy. */
export function planSectionMark(lineIndices: number[], status: LineMarkStatus, mine: (lineIndex: number) => MyLineMark | null): SectionMarkPlan {
  const plan: SectionMarkPlan = { apply: [], skipped: [] };
  for (const lineIndex of lineIndices) {
    const mark = mine(lineIndex);
    if (!mark || !mark.current) { plan.apply.push(lineIndex); continue; }
    if (mark.status === status) { plan.skipped.push({ lineIndex, reason: 'same' }); continue; }
    if (mark.status === 'rejected' && FOLDING.sectionMarkKeepsRejects) { plan.skipped.push({ lineIndex, reason: 'rejected' }); continue; }
    if (FOLDING.sectionMarkNeverDowngrades && STATUS_RANK[mark.status] > STATUS_RANK[status]) {
      plan.skipped.push({ lineIndex, reason: 'stronger' });
      continue;
    }
    plan.apply.push(lineIndex);
  }
  return plan;
}
