/**
 * Proof Documents — Step 1b: the reading walk (pure state, no DOM).
 *
 * Authorship: requirements by Mike Wolf ("Reading and marking", 2026-09-18) with the COS's
 * decisions for the gaps; built by Claude Opus 5 (worker reading-walk), 2026-09-18.
 *
 * The reader has one focus line. Scrolling down moves the focus down line by line.
 * - A line the focus leaves after a real look is reported as read ("seen"). Step B3b: a real look
 *   scales with the line's length: READING_WALK.WORDS_PER_SECOND (a per-reader setting), at least
 *   MIN_DWELL_MS, at most MAX_DWELL_MS. A line scrolled past faster than that is reported as
 *   "skimmed": shown, never Seen, still an Issue. A fling reads nothing and skims what it passes.
 * - A line with pending marks (suggestions, open comments) holds the focus: each scroll gesture
 *   steps to the next mark on the line, and only after the last one does the focus move on.
 * - Stepping past a suggestion, or scrolling past it, accepts it PROVISIONALLY: the reader sees
 *   it as accepted, but nothing is written. Moving back above it reverts it. An explicit action
 *   on a later line (or "Commit") turns the provisional accepts at or above that line into real
 *   accepts. Explicit accepts and rejects never pass through here, so scrolling never undoes them.
 * Invariant: every provisional accept sits on the focus line or above it.
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
  /** Wheel or touch events closer together than this are one gesture (trackpad inertia included). */
  GESTURE_GAP_MS: 180,
  /** A gesture must travel this far (px) before it takes its one step. */
  STEP_THRESHOLD_PX: 24,
} as const;

export type WalkMarkKind = 'suggestion' | 'comment';

export interface WalkMark {
  id: string;
  kind: WalkMarkKind;
}

export interface WalkLine {
  /** Stable identity of the line's current text (for example `${hash}:${occurrence}`). */
  key: string;
  /** Step B3b: the line's word count (its reading time). Absent = the shortest dwell. */
  words?: number;
  /** Pending suggestions and open comments on the line, in document order. */
  marks: WalkMark[];
  /**
   * Step B2: the line sits in a folded section. The focus never lands on it, scrolling past it
   * does not read it, and its marks neither hold the page nor get passed (you cannot read what
   * is hidden).
   */
  hidden?: boolean;
}

export type WalkEvent =
  | { type: 'seen'; line: number; key: string }
  /** Step B3b: scrolled past faster than its reading time (reported once per line text). */
  | { type: 'skimmed'; line: number; key: string }
  | { type: 'provisional'; id: string; line: number }
  | { type: 'revert'; id: string; line: number }
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
  /** Marks the reader has stepped or scrolled past (suggestions and comments). */
  private readonly passed = new Set<string>();
  /** Suggestion id -> line index of provisional (scroll) accepts. */
  private readonly provisional = new Map<string, number>();
  /** Line keys already reported as read in this session. */
  private readonly readKeys = new Set<string>();
  /** Step B3b: line keys already reported as skimmed in this session. */
  private readonly skimKeys = new Set<string>();
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
  dwellFor(line: number): number { return dwellMsFor(this.lines[line]?.words, this.rate); }
  hasSkimmed(key: string): boolean { return this.skimKeys.has(key) && !this.readKeys.has(key); }
  get lineCount(): number { return this.lines.length; }

  /** Takes the events produced since the last call. */
  drain(): WalkEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  /** The document changed: new line list and pending marks. Keeps the focus index (clamped). */
  setLines(lines: WalkLine[], now: number): void {
    this.lines = lines.slice();
    const pending = new Map<string, number>();
    lines.forEach((line, index) => line.marks.forEach(mark => pending.set(mark.id, index)));
    for (const [id] of [...this.provisional]) {
      const at = pending.get(id);
      if (at === undefined) this.provisional.delete(id); // accepted, rejected or removed elsewhere
      else this.provisional.set(id, at);
    }
    for (const id of [...this.passed]) if (!pending.has(id)) this.passed.delete(id);
    if (this.focusLine > Math.max(0, lines.length - 1)) {
      this.focusLine = Math.max(0, lines.length - 1);
      this.enteredAt = now;
      this.dwellKey = this.lines[this.focusLine]?.key ?? null;
    }
    if (this.dwellKey === null) this.dwellKey = this.lines[this.focusLine]?.key ?? null;
    // Keep the invariant: provisional accepts sit on the focus line or above it.
    for (const [id, line] of [...this.provisional]) {
      if (line > this.focusLine) this.revert(id, line);
    }
  }

  marksOn(line: number): WalkMark[] {
    return this.lines[line]?.marks ?? [];
  }

  /** Index on the focus line of the first mark not yet passed (= count when all are passed). */
  stepIndex(): number {
    const marks = this.marksOn(this.focusLine);
    const index = marks.findIndex(mark => !this.passed.has(mark.id));
    return index === -1 ? marks.length : index;
  }

  /** The mark the reader is on now (the next one a step passes), or null. */
  currentMark(): WalkMark | null {
    return this.marksOn(this.focusLine)[this.stepIndex()] ?? null;
  }

  canStepForward(): boolean { return this.currentMark() !== null; }
  canStepBack(): boolean { return this.marksOn(this.focusLine).some(mark => this.passed.has(mark.id)); }

  isPassed(id: string): boolean { return this.passed.has(id); }
  isProvisional(id: string): boolean { return this.provisional.has(id); }
  provisionalIds(): string[] { return [...this.provisional.keys()]; }
  get provisionalCount(): number { return this.provisional.size; }
  hasRead(key: string): boolean { return this.readKeys.has(key); }

  /**
   * The first line at or after `from` that holds the focus (it has marks not yet passed).
   * Scrolling down may bring the focus to this line but not past it.
   */
  barrier(from = this.focusLine): number | null {
    for (let line = Math.max(0, from); line < this.lines.length; line += 1) {
      if (this.lines[line]?.hidden) continue;
      if (this.marksOn(line).some(mark => !this.passed.has(mark.id))) return line;
    }
    return null;
  }

  /** One step down within the focus line. Returns false when there is nothing left to step. */
  stepForward(): boolean {
    const mark = this.currentMark();
    if (!mark) return false;
    this.pass(mark, this.focusLine);
    return true;
  }

  /** One step back up within the focus line (reverts that mark's provisional accept). */
  stepBack(): boolean {
    const marks = this.marksOn(this.focusLine);
    for (let i = marks.length - 1; i >= 0; i -= 1) {
      const mark = marks[i];
      if (!this.passed.has(mark.id)) continue;
      this.passed.delete(mark.id);
      if (this.provisional.has(mark.id)) this.revert(mark.id, this.focusLine);
      return true;
    }
    return false;
  }

  /**
   * Moves the focus. `scroll` is reading: lines left behind are judged read or not, and their
   * marks are passed (suggestions accepted provisionally). `jump` (Next issue, a click) reads
   * and passes nothing on the way down. Moving up, by either mode, reverts every provisional
   * accept below the new focus line and forgets that its marks were passed.
   * `heights` is accepted for older callers and ignored (Step B3b: reading time is by words).
   */
  moveTo(target: number, now: number, mode: MoveMode = 'scroll', _heights?: ArrayLike<number>): void {
    const to = Math.max(0, Math.min(this.lines.length - 1, Math.round(target)));
    if (this.lines.length === 0 || to === this.focusLine) return;
    if (to > this.focusLine) {
      if (mode === 'scroll') {
        for (let line = this.focusLine; line < to; line += 1) {
          if (this.lines[line]?.hidden) continue;
          const time = line === this.focusLine && this.lines[line]?.key === this.dwellKey ? now - this.enteredAt : 0;
          if (time >= this.dwellFor(line)) this.markRead(line);
          else this.markSkimmed(line);
          for (const mark of this.marksOn(line)) this.pass(mark, line);
        }
      }
    } else {
      for (const [id, line] of [...this.provisional]) if (line > to) this.revert(id, line);
      for (let line = to + 1; line < this.lines.length; line += 1) {
        for (const mark of this.marksOn(line)) this.passed.delete(mark.id);
      }
      // Arriving from below on a line whose marks were all passed: they stay passed, so the
      // next upward gesture steps back through them one at a time.
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

  /**
   * The reader acted explicitly on `line` (A, R, a click on a mark, an accept or reject).
   * Returns the provisional accepts at or above that line, which the caller now commits as
   * real accepts. They leave the provisional set (they stay passed).
   */
  explicitAction(line: number): string[] {
    const ids: string[] = [];
    for (const [id, at] of [...this.provisional]) {
      if (at <= line) { ids.push(id); this.provisional.delete(id); }
    }
    return ids;
  }

  /** "Commit N accepted": every provisional accept. */
  commitAll(): string[] {
    const ids = [...this.provisional.keys()];
    this.provisional.clear();
    return ids;
  }

  /** A commit failed: put these back as provisional. */
  restoreProvisional(ids: string[]): void {
    for (const id of ids) {
      const line = this.lines.findIndex(entry => entry.marks.some(mark => mark.id === id));
      if (line !== -1 && line <= this.focusLine) this.provisional.set(id, line);
    }
  }

  /** The reader decided this mark explicitly: it is no longer provisional. */
  decided(id: string): void {
    this.provisional.delete(id);
    this.passed.add(id);
  }

  /** The reader undid one provisional accept from the rail: the suggestion stays pending. */
  dropProvisional(id: string): void {
    const line = this.provisional.get(id);
    if (line === undefined) return;
    this.revert(id, line);
  }

  snapshot(): WalkSnapshot {
    return { focus: this.focusLine, passed: [...this.passed], provisional: [...this.provisional] };
  }

  /** Restores a session snapshot, keeping only marks that are still pending. */
  restore(snapshot: WalkSnapshot | null | undefined, now: number): void {
    if (!snapshot) return;
    const pending = new Map<string, { line: number; kind: WalkMarkKind }>();
    this.lines.forEach((line, index) => line.marks.forEach(mark => pending.set(mark.id, { line: index, kind: mark.kind })));
    const focus = Math.max(0, Math.min(this.lines.length - 1, Number(snapshot.focus) || 0));
    this.focusLine = focus;
    this.enteredAt = now;
    this.dwellKey = this.lines[focus]?.key ?? null;
    for (const id of snapshot.passed ?? []) {
      const at = pending.get(id);
      if (at && at.line <= focus) this.passed.add(id);
    }
    for (const [id] of snapshot.provisional ?? []) {
      const at = pending.get(id);
      if (at && at.kind === 'suggestion' && at.line <= focus) {
        this.provisional.set(id, at.line);
        this.passed.add(id);
      }
    }
  }

  private markSkimmed(line: number): void {
    const entry = this.lines[line];
    if (!entry || this.readKeys.has(entry.key) || this.skimKeys.has(entry.key)) return;
    this.skimKeys.add(entry.key);
    this.events.push({ type: 'skimmed', line, key: entry.key });
  }

  private markRead(line: number): void {
    const entry = this.lines[line];
    if (!entry || this.readKeys.has(entry.key)) return;
    this.readKeys.add(entry.key);
    this.events.push({ type: 'seen', line, key: entry.key });
  }

  private pass(mark: WalkMark, line: number): void {
    if (this.passed.has(mark.id)) return;
    this.passed.add(mark.id);
    if (mark.kind === 'suggestion') {
      this.provisional.set(mark.id, line);
      this.events.push({ type: 'provisional', id: mark.id, line });
    }
  }

  private revert(id: string, line: number): void {
    this.provisional.delete(id);
    this.passed.delete(id);
    this.events.push({ type: 'revert', id, line });
  }
}

export type GestureMode = 'native' | 'step' | 'blocked';

/**
 * Turns a stream of wheel (or touch) deltas into gestures. Events closer together than
 * READING_WALK.GESTURE_GAP_MS, in one direction, are one gesture, so a trackpad's inertia
 * tail belongs to the gesture that started it. A gesture in `step` mode fires once, after it
 * has travelled READING_WALK.STEP_THRESHOLD_PX, and never again however long it lasts.
 */
export class GestureGate {
  private lastAt = Number.NEGATIVE_INFINITY;
  private direction = 0;
  private travelled = 0;
  private fired = false;
  mode: GestureMode = 'native';

  constructor(
    private readonly gapMs: number = READING_WALK.GESTURE_GAP_MS,
    private readonly thresholdPx: number = READING_WALK.STEP_THRESHOLD_PX,
  ) {}

  /**
   * Feeds one event. `startMode` is asked for the mode when this event starts a new gesture.
   * Returns whether it started one, whether the caller must cancel the native scroll, and the
   * step to take (1 down, -1 up, 0 none).
   */
  feed(deltaY: number, at: number, startMode: (direction: 1 | -1) => GestureMode): { started: boolean; prevent: boolean; step: 0 | 1 | -1 } {
    const direction = deltaY > 0 ? 1 : deltaY < 0 ? -1 : 0;
    const started = at - this.lastAt > this.gapMs || (direction !== 0 && this.direction !== 0 && direction !== this.direction);
    this.lastAt = at;
    if (started) {
      this.travelled = 0;
      this.fired = false;
      this.direction = direction;
      this.mode = direction === 0 ? 'native' : startMode(direction as 1 | -1);
    } else if (this.direction === 0 && direction !== 0) {
      this.direction = direction;
    }
    this.travelled += Math.abs(deltaY);
    let step: 0 | 1 | -1 = 0;
    if (this.mode === 'step' && !this.fired && this.travelled >= this.thresholdPx && this.direction !== 0) {
      this.fired = true;
      step = this.direction as 1 | -1;
    }
    return { started, prevent: this.mode !== 'native', step };
  }

  /** The rest of the current gesture (inertia included) must not scroll. */
  block(): void {
    this.mode = 'blocked';
    this.fired = true;
  }

  /** Ends the current gesture now (for example on touchend). */
  reset(): void {
    this.lastAt = Number.NEGATIVE_INFINITY;
    this.direction = 0;
    this.mode = 'native';
  }
}
