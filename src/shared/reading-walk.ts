/**
 * Reading records Seen after dwell and nothing for a fast pass. It never accepts
 * proposals or records agreement. Navigation and review decisions are independent.
 * Mike, 2026-09-23 (usability brief).
 */

export const READING_WALK = {
  /** Step B3b: the reading time of a line is its word count at this rate (words per second)... */
  WORDS_PER_SECOND: 8, // COS 2026-09-19: 4 left most of a fast reader's lines "skimmed"; Mike reads fast
  /** ...but never less than this (a one-word heading still needs a real look)... */
  MIN_DWELL_MS: 250,
  /** ...and never more than this (a very long paragraph is not a 30-second wait). */
  MAX_DWELL_MS: 6000,
  /** The shortest dwell (Step 1b's flat dwell; kept for older callers). */
  DWELL_MS: 250,
  /** Rates a reader can choose in the rail (words per second); 0 = no length rule (MIN_DWELL_MS only). */
  RATE_CHOICES: [2, 3, 4, 6, 8, 12, 0] as readonly number[],
} as const;

export type WalkMarkKind = 'suggestion' | 'comment';

export interface WalkMark {
  id: string;
  kind: WalkMarkKind;
  /** Bundle identity; grouping never changes reading or decisions. */
  group?: string;
}

export interface WalkLine {
  /** Stable identity of the line's current text (for example `${hash}:${occurrence}`). */
  key: string;
  /** Step B3b: the line's word count (its reading time). Absent = the shortest dwell. */
  words?: number;
  /** Pending suggestions and open comments on the line, in document order. */
  marks: WalkMark[];
  /**
   * Step B4c: multiplies the line's reading time (an uncertain-flagged line reads slower:
   * UNCERTAIN_POLICY.dwellFactor). Absent = 1.
   */
  dwellFactor?: number;
  /**
   * Step B2: the line sits in a folded section. The focus never lands on it, scrolling past it
   * does not read it, and its marks neither hold the page nor get passed (you cannot read what
   * is hidden).
   */
  hidden?: boolean;
  /**
   * Line tiers: a context line that is not an Issue for the reader. It remains a J / K stop whenever visible.
   */
  skipStep?: boolean;
}

export type WalkEvent =
  | { type: 'seen'; line: number; key: string }
  | { type: 'focus'; line: number };

export type MoveMode = 'scroll' | 'jump';

/** Step B3b: words in a line of text (its reading time). */
export function countWords(text: string): number {
  return (String(text ?? '').match(/[\p{L}\p{N}]+(?:['’.\-][\p{L}\p{N}]+)*/gu) ?? []).length;
}

/**
 * Step B3b: how long a line must hold the focus to count as read, at `rate` words per second
 * (0 or less = no length rule). Clamped to [MIN_DWELL_MS, MAX_DWELL_MS].
 */
export function dwellMsFor(words: number | undefined, rate: number = READING_WALK.WORDS_PER_SECOND): number {
  if (!(typeof words === 'number' && words > 0) || !(rate > 0)) return READING_WALK.MIN_DWELL_MS;
  const ms = (words / rate) * 1000;
  return Math.round(Math.min(READING_WALK.MAX_DWELL_MS, Math.max(READING_WALK.MIN_DWELL_MS, ms)));
}

export interface WalkSnapshot {
  focus: number;
  /** Legacy snapshot fields remain empty for stored-format compatibility. */
  passed: string[];
  provisional: Array<[string, number]>;
}

export class ReadingWalk {
  private lines: WalkLine[];
  private focusLine = 0;
  private enteredAt: number;
  /** The focus line's key when the focus arrived. Dwell counts only for that text: a line
   * changed by someone else while it is the focus is not "read" until the reader comes back. */
  private dwellKey: string | null;
  /** Line keys already reported as read in this session. */
  private readonly readKeys = new Set<string>();
  /** Step B3b: this reader's rate (words per second; 0 = no length rule). */
  private rate: number = READING_WALK.WORDS_PER_SECOND;
  private events: WalkEvent[] = [];

  constructor(lines: WalkLine[], now: number) {
    this.lines = lines.slice();
    this.enteredAt = now;
    this.dwellKey = this.lines[0]?.key ?? null;
  }

  get focus(): number { return this.focusLine; }

  /** Step B3b: the reader's reading rate (words per second; 0 = the shortest dwell for every line). */
  setRate(rate: number): void { this.rate = Number.isFinite(rate) && rate >= 0 ? rate : READING_WALK.WORDS_PER_SECOND; }
  get readingRate(): number { return this.rate; }

  /** Step B3b: how long this line must hold the focus to be read. */
  dwellFor(line: number): number {
    const factor = this.lines[line]?.dwellFactor;
    const base = dwellMsFor(this.lines[line]?.words, this.rate);
    return typeof factor === 'number' && factor > 0 && factor !== 1 ? Math.round(base * factor) : base;
  }
  get lineCount(): number { return this.lines.length; }

  /** Takes the events produced since the last call. */
  drain(): WalkEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  /** The document changed: new line list and pending marks. Keeps the focus index (clamped). */
  setLines(lines: WalkLine[], now: number): void {
    const previousKey = this.lines[this.focusLine]?.key;
    const moved = lines.findIndex(line => line.key === previousKey);
    if (moved >= 0) this.focusLine = moved;
    this.lines = lines.slice();
    if (this.focusLine > Math.max(0, lines.length - 1)) {
      this.focusLine = Math.max(0, lines.length - 1);
      this.enteredAt = now;
      this.dwellKey = this.lines[this.focusLine]?.key ?? null;
    }
    if (this.dwellKey === null) this.dwellKey = this.lines[this.focusLine]?.key ?? null;
  }

  marksOn(line: number): WalkMark[] {
    return this.lines[line]?.marks ?? [];
  }

  hasRead(key: string): boolean { return this.readKeys.has(key); }

  /** Scroll observations measure dwell; explicit jumps read no intervening text. */
  moveTo(target: number, now: number, mode: MoveMode = 'scroll', _heights?: ArrayLike<number>): void {
    const to = Math.max(0, Math.min(this.lines.length - 1, Math.round(target)));
    if (this.lines.length === 0 || to === this.focusLine) return;
    if (to > this.focusLine) {
      if (mode === 'scroll') {
        for (let line = this.focusLine; line < to; line += 1) {
          if (this.lines[line]?.hidden) continue;
          const time = line === this.focusLine && this.lines[line]?.key === this.dwellKey ? now - this.enteredAt : 0;
          if (time >= this.dwellFor(line)) this.markRead(line);
        }
      }
    }
    this.focusLine = to;
    this.enteredAt = now;
    this.dwellKey = this.lines[to]?.key ?? null;
    this.events.push({ type: 'focus', line: to });
  }

  /** Step B2: the nearest line after (dir 1) or before (dir -1) the focus that is not hidden. */
  nextVisible(dir: 1 | -1, from = this.focusLine): number | null {
    for (let line = from + dir; line >= 0 && line < this.lines.length; line += dir) {
      if (!this.lines[line]?.hidden) return line;
    }
    return null;
  }

  isHidden(line: number): boolean { return Boolean(this.lines[line]?.hidden); }

  /** Every visible passage is a keyboard stop, including context. */
  nextStop(dir: 1 | -1, from = this.focusLine): number | null {
    for (let line = from + dir; line >= 0 && line < this.lines.length; line += dir) {
      const l = this.lines[line];
      if (!l?.hidden) return line;
    }
    return null;
  }

  /** Called on a timer: the focus line becomes read once it has held the focus long enough. */
  tick(now: number): void {
    if (this.lines.length === 0) return;
    if (this.lines[this.focusLine]?.hidden) return;
    if (this.lines[this.focusLine]?.key !== this.dwellKey) return;
    if (now - this.enteredAt >= this.dwellFor(this.focusLine)) this.markRead(this.focusLine);
  }

  /** How long until tick() could mark the focus line read (0 when it already is). */
  msUntilRead(now: number): number {
    const line = this.lines[this.focusLine];
    if (!line || this.readKeys.has(line.key) || line.key !== this.dwellKey) return 0;
    return Math.max(0, this.dwellFor(this.focusLine) - (now - this.enteredAt));
  }

  snapshot(): WalkSnapshot {
    return { focus: this.focusLine, passed: [], provisional: [] };
  }

  /** Restore position only. Old passed/provisional data never becomes a decision. */
  restore(snapshot: WalkSnapshot | null | undefined, now: number): void {
    if (!snapshot) return;
    const focus = Math.max(0, Math.min(this.lines.length - 1, Number(snapshot.focus) || 0));
    this.focusLine = focus;
    this.enteredAt = now;
    this.dwellKey = this.lines[focus]?.key ?? null;
  }

  private markRead(line: number): void {
    const entry = this.lines[line];
    if (!entry || this.readKeys.has(entry.key)) return;
    this.readKeys.add(entry.key);
    this.events.push({ type: 'seen', line, key: entry.key });
  }

}
