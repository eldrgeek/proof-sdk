/**
 * Proof Documents — one Undo for every change a person makes (pure state, no DOM).
 *
 * Mike, 2026-09-19: "Undo is needed for every user change." Not only text editing: line marks,
 * ask answers, accepting or rejecting a suggestion, resolving a comment, picking a wording, tier
 * flips, folds, clearing an objection, ratifying a Familiar's proxy, committing scroll-accepts.
 *
 * The model: one ordered stack per person and document. Every action that changes something for
 * anyone pushes an entry carrying (a) a short description the person reads ("agreed line 12") and
 * (b) the inverse, as a closure. An undo is just another action, so it goes through the same routes
 * and the same permission checks; there is no privileged rewind path.
 *
 * Conflict: an entry captures what it expects to find. If someone else has acted on the same thing
 * since, the entry's inverse refuses with a sentence the person reads, and the entry stays on the
 * stack (nothing is clobbered). UNDO_POLICY.refuseOnConflict is the one-line switch.
 *
 * Authorship: Mike Wolf's requirement (2026-09-19); policy and design by Claude Opus 5
 * (worker proof-ux2), 2026-09-19.
 */

export const UNDO_POLICY = {
  enabled: true,
  /** Entries kept per person and document (oldest dropped first). */
  maxEntries: 60,
  /**
   * An entry older than this is no longer offered: undoing a mark from yesterday by reflex is a
   * surprise, not a repair.
   */
  maxAgeMs: 12 * 60 * 60 * 1000,
  /** Redo (Cmd/Ctrl+Shift+Z, Ctrl+Y) is offered for entries that carry a redo. */
  redo: true,
  /** How long the "Undid: …" line stays in the rail. */
  noticeMs: 8000,
  /**
   * An undo never overwrites a later action by someone else: it refuses and says so. Set false to
   * let an undo win over other people's later actions (not what anyone asked for).
   */
  refuseOnConflict: true,
  /** The keys. Cmd on a Mac, Ctrl elsewhere; both are accepted. */
  undoKey: 'z',
  redoKey: 'y',
} as const;

/** Every kind of person action that can be undone. One label per kind, for the rail's list. */
export const UNDO_KINDS = {
  'line-mark': 'line mark',
  'section-mark': 'section mark',
  'ask-answer': 'answer',
  suggestion: 'change',
  comment: 'comment',
  alternative: 'wording',
  tier: 'tier',
  fold: 'fold',
  objection: 'objection',
  flag: 'flag',
  ratify: 'ratification',
  'scroll-accept': 'scroll-accepted changes',
  clarify: 'clarify request',
  ttl: 'review-by date',
} as const;

export type UndoKind = keyof typeof UNDO_KINDS;

export type UndoOutcome = { ok: true; description?: string } | { ok: false; reason: string };

export interface UndoEntry {
  id: string;
  kind: UndoKind;
  /** What the person did, in their words: "agreed line 12". The rail says "Undid: <this>". */
  description: string;
  at: number;
  /** Runs the inverse. Resolves ok, or refuses with a sentence the person reads. */
  undo: () => Promise<UndoOutcome> | UndoOutcome;
  /** Re-does the original action. Absent: the entry cannot be redone and Redo stops at it. */
  redo?: () => Promise<UndoOutcome> | UndoOutcome;
}

export type UndoInput = Omit<UndoEntry, 'id' | 'at'> & { id?: string; at?: number };

export interface UndoRunResult {
  ok: boolean;
  /** "Undid: agreed line 12" or the refusal. */
  message: string;
  entry: UndoEntry | null;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `u${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * One ordered per-person stack. `push` records an action; `undo` runs the newest entry's inverse
 * and moves it to the redo stack; `redo` runs the original again.
 */
export class UndoStack {
  private entries: UndoEntry[] = [];
  private redone: UndoEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private running = false;
  private lastMessage = '';
  /** Test hook: every message this stack produced, newest last. */
  readonly log: string[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { console.warn('[undo] listener failed', error); }
    }
  }

  /** Drops entries past the cap or the age limit. */
  private prune(): void {
    const cutoff = this.now() - UNDO_POLICY.maxAgeMs;
    this.entries = this.entries.filter(entry => entry.at >= cutoff);
    if (this.entries.length > UNDO_POLICY.maxEntries) {
      this.entries.splice(0, this.entries.length - UNDO_POLICY.maxEntries);
    }
    this.redone = this.redone.filter(entry => entry.at >= cutoff);
  }

  /** Records an action. A new action clears the redo stack (the ordinary editor rule). */
  push(input: UndoInput): UndoEntry | null {
    if (!UNDO_POLICY.enabled) return null;
    const entry: UndoEntry = { ...input, id: input.id ?? nextId(), at: input.at ?? this.now() };
    this.entries.push(entry);
    this.redone = [];
    this.prune();
    this.notify();
    return entry;
  }

  /** Records an action whose inverse is one plain function (the common case). */
  pushSimple(kind: UndoKind, description: string, undo: () => Promise<UndoOutcome> | UndoOutcome, redo?: () => Promise<UndoOutcome> | UndoOutcome): UndoEntry | null {
    return this.push({ kind, description, undo, redo });
  }

  list(): UndoEntry[] { this.prune(); return this.entries.slice(); }
  depth(): number { this.prune(); return this.entries.length; }
  redoDepth(): number { this.prune(); return this.redone.length; }
  isRunning(): boolean { return this.running; }
  message(): string { return this.lastMessage; }

  /** The action Undo would reverse, or null. */
  next(): UndoEntry | null {
    this.prune();
    return this.entries.length ? this.entries[this.entries.length - 1] : null;
  }

  /** The action Redo would repeat, or null (an entry with no redo stops the chain). */
  nextRedo(): UndoEntry | null {
    if (!UNDO_POLICY.redo) return null;
    this.prune();
    const entry = this.redone.length ? this.redone[this.redone.length - 1] : null;
    return entry && entry.redo ? entry : null;
  }

  private async run(entry: UndoEntry, action: 'undo' | 'redo'): Promise<UndoOutcome> {
    const fn = action === 'undo' ? entry.undo : entry.redo;
    if (!fn) return { ok: false, reason: 'There is nothing to redo here.' };
    try {
      return await fn();
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : `Could not ${action} that.` };
    }
  }

  /** Reverses the newest action. Refuses (and keeps the entry) when the thing changed under it. */
  async undo(): Promise<UndoRunResult> {
    if (this.running) return this.record(false, 'One undo is already running.', null);
    const entry = this.next();
    if (!entry) return this.record(false, 'There is nothing to undo.', null);
    this.running = true;
    this.notify();
    try {
      const outcome = await this.run(entry, 'undo');
      if (!outcome.ok) return this.record(false, outcome.reason, entry);
      this.entries = this.entries.filter(candidate => candidate.id !== entry.id);
      if (entry.redo) this.redone.push(entry);
      return this.record(true, `Undid: ${outcome.description ?? entry.description}`, entry);
    } finally {
      this.running = false;
      this.notify();
    }
  }

  /** Repeats the action the last Undo reversed. */
  async redo(): Promise<UndoRunResult> {
    if (!UNDO_POLICY.redo) return this.record(false, 'Redo is off.', null);
    if (this.running) return this.record(false, 'One undo is already running.', null);
    const entry = this.nextRedo();
    if (!entry) return this.record(false, 'There is nothing to redo.', null);
    this.running = true;
    this.notify();
    try {
      const outcome = await this.run(entry, 'redo');
      if (!outcome.ok) return this.record(false, outcome.reason, entry);
      this.redone = this.redone.filter(candidate => candidate.id !== entry.id);
      this.entries.push({ ...entry, at: this.now() });
      return this.record(true, `Redid: ${outcome.description ?? entry.description}`, entry);
    } finally {
      this.running = false;
      this.notify();
    }
  }

  private record(ok: boolean, message: string, entry: UndoEntry | null): UndoRunResult {
    this.lastMessage = message;
    this.log.push(message);
    if (this.log.length > 100) this.log.shift();
    this.notify();
    return { ok, message, entry };
  }

  clear(): void {
    this.entries = [];
    this.redone = [];
    this.lastMessage = '';
    this.notify();
  }
}

/**
 * The refusal an inverse returns when someone else acted on the same thing first. One sentence,
 * naming who, so the person knows why nothing moved.
 */
export function conflictRefusal(what: string, who?: string | null): UndoOutcome {
  return {
    ok: false,
    reason: who
      ? `Not undone: ${who} changed ${what} after you did. Nothing was overwritten.`
      : `Not undone: ${what} changed after you did. Nothing was overwritten.`,
  };
}

/** "agreed line 12" / "rejected line 3" — the description a line-mark entry carries. */
export function describeLineMark(status: string, lineIndex: number): string {
  const words: Record<string, string> = {
    seen: 'marked line %s Seen', agreed: 'agreed line %s', approved: 'approved line %s',
    rejected: 'rejected line %s', skimmed: 'skimmed line %s', unseen: 'cleared your mark on line %s',
  };
  return (words[status] ?? `marked line %s ${status}`).replace('%s', String(lineIndex + 1));
}
