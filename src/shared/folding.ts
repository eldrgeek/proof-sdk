/**
 * Sections change visibility only by disclosure, bulk view commands or navigation.
 * Heading marks always affect the heading.
 * "Agree with this section (N lines)" is offered only when every line of that section is visible.
 * A collapsed section or subsection offers "Show all N lines to agree with this section" instead.
 * That control expands the collapsed sections inside it. Explicit agreement then captures text identity.
 * Mike, 2026-09-23 (usability brief).
 */
import type { DocLine, IssueSummary, LineMarkStatus } from './line-marks.js';

// ============================================================================
// POLICY (the COS's decisions where the spec is silent; each is a one-line change)
// ============================================================================

export const FOLDING = {
  /** Folding never changes the scope of a heading mark. */
  foldedHeadingScope: 'heading' as const,
  /** A mark chosen on an UNFOLDED heading applies to the heading line only. */
  unfoldedHeadingScope: 'heading' as 'section' | 'heading',
  /** Reject needs a specific line: a folded section cannot be rejected as a whole. */
  allowSectionReject: false,
  /** A section-wide mark never overwrites the viewer's own Rejected mark on a line inside. */
  sectionMarkKeepsRejects: true,
  /** A section-wide mark never lowers a stronger mark (an Approved line stays Approved on Agree). */
  sectionMarkNeverDowngrades: true,
  /** How long the "Undo" toast after a section mark stays up. */
  undoToastMs: 8000,
  /** The largest batch the line-mark routes accept in one request. */
  maxBatchLines: 1000,
  /** localStorage key prefix; the value is the list of folded heading keys (hash:occurrence). */
  storagePrefix: 'proof:fold:',
  /** The badge counts the same Issues as the top bar (team-wide), restricted to the section. */
  badgeCounts: 'team' as 'team',
} as const;

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

/**
 * A remote edit can rename a heading, which changes its hash, or shift it.
 * The fold follows that heading: same key, else the mapped position, else the same
 * block and level, else the same ordinal when the heading count did not change.
 * Mike, 2026-09-23 (usability brief).
 */
export function remapFoldedKeys(
  folded: ReadonlySet<string>,
  before: readonly DocLine[],
  after: readonly DocLine[],
  mapPos: (pos: number) => number,
): Set<string> {
  const beforeHeadings = before.filter(line => line.level !== undefined);
  const afterHeadings = after.filter(line => line.level !== undefined);
  // A key whose heading is not in `before` is kept. A document load must not wipe stored folds.
  const next = new Set(folded);
  for (const key of folded) {
    const old = before.find(line => line.level !== undefined && headingKey(line) === key);
    if (!old) continue;
    next.delete(key);
    const mapped = mapPos(old.pos);
    const ordinal = beforeHeadings.findIndex(line => line.index === old.index);
    const heading = afterHeadings.find(line => headingKey(line) === key)
      ?? afterHeadings.find(line => line.level === old.level && line.pos === mapped)
      ?? afterHeadings.find(line => line.level === old.level && line.block === old.block)
      ?? (ordinal >= 0 && beforeHeadings.length === afterHeadings.length && afterHeadings[ordinal]?.level === old.level
        ? afterHeadings[ordinal]
        : undefined);
    if (heading) next.add(headingKey(heading));
  }
  return next;
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

/**
 * Whether "Agree with this section" may be offered.
 * `allVisible` is true only when no line from the heading through the section end is hidden.
 * `collapsedHeadings` are the folded sections inside that range, including this section when it is folded.
 * Mike, 2026-09-23 (usability brief).
 */
export interface SectionAgreementOffer {
  lineCount: number;
  allVisible: boolean;
  collapsedHeadings: number[];
}

export function sectionAgreementOffer(
  section: DocSection,
  sections: readonly DocSection[],
  folded: ReadonlySet<string>,
): SectionAgreementOffer {
  const hidden = hiddenLineSet(sections, folded);
  const indices = sectionLineIndices(section);
  const collapsedHeadings = sections
    .filter(candidate => folded.has(candidate.key)
      && candidate.headingIndex >= section.headingIndex
      && candidate.lineEnd <= section.lineEnd)
    .map(candidate => candidate.headingIndex);
  return {
    lineCount: indices.length,
    allVisible: indices.every(index => !hidden.has(index)),
    collapsedHeadings,
  };
}

/** A displayed section scope is captured by text identity, never recomputed from indices. */
export interface SectionScope { lines: Array<Pick<DocLine, 'hash' | 'occurrence' | 'text'> & { copies: number }>; heading: string }
export function captureSectionScope(section: DocSection, lines: DocLine[]): SectionScope {
  return { heading: lines[section.headingIndex]?.text ?? '',
    lines: lines.slice(section.headingIndex, section.lineEnd).map(({ hash, occurrence, text }) => ({ hash, occurrence, text, copies: lines.filter(line => line.hash === hash && line.text === text).length })) };
}
/** Changed or removed text is skipped; new lines cannot enter a captured scope. */
export function resolveSectionScope(scope: SectionScope, lines: DocLine[]): number[] {
  return scope.lines.flatMap(saved => {
    // A new identical copy makes occurrence-based identity ambiguous: never mark it by accident.
    if (lines.filter(line => line.hash === saved.hash && line.text === saved.text).length !== saved.copies) return [];
    const line = lines.find(line => line.hash === saved.hash && line.occurrence === saved.occurrence && line.text === saved.text);
    return line ? [line.index] : [];
  });
}
