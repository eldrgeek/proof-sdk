/**
 * Proof Documents — the one Undo in the right rail (Mike, 2026-09-19:
 * "Undo is needed for every user change").
 *
 * One button, one keystroke, one ordered per-person stack (src/shared/undo.ts). It covers every
 * action a person takes in the document that is not typing: line marks, section marks, ask
 * answers, accepting or rejecting a change, resolving a comment, picking a wording, tier flips,
 * folds, clearing an objection or a flag, ratifying a Familiar's proxy, committing scroll-accepts.
 *
 * Typing keeps its own undo (ProseMirror / Yjs), because that is what a writer expects from
 * Cmd+Z mid-sentence. The two are ordered by recency: Cmd/Ctrl+Z reverses whichever happened
 * last, so from the person's side there is one undo. UNDO_UI_POLICY.textEditWins is the switch.
 *
 * Authorship: Mike Wolf's requirement (2026-09-19); built by Claude Opus 5 (worker proof-ux2).
 */
import { UNDO_POLICY, type UndoStack } from '../shared/undo';
import './undo.css';

export const UNDO_UI_POLICY = {
  /**
   * Cmd/Ctrl+Z reverses whichever happened last — a typed edit or a Proof action. With this off,
   * the keystroke always runs the Proof stack and typing keeps only the editor's own menu undo.
   */
  textEditWins: true,
  /** A typed edit this recent counts as "the last thing I did" even against a newer mark. */
  textEditGraceMs: 0,
  /** The rail names what Undo would reverse, so nothing is undone blind. */
  showNextAction: true,
  /** The result line ("Undid: agreed line 12") stays this long. */
  noticeMs: UNDO_POLICY.noticeMs,
} as const;

export interface UndoHost {
  stack(): UndoStack;
  /** Date.now() of the person's own newest text edit, or 0. Left out, the UI watches for typing. */
  lastTextEditAt?(): number;
}

export class UndoUI {
  /** The host mounts this at the top of the right rail (with the fold controls). */
  readonly controlsEl = document.createElement('div');
  private readonly undoButton = document.createElement('button');
  private readonly redoButton = document.createElement('button');
  private readonly noticeEl = document.createElement('p');
  private unsubscribe: (() => void) | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private sig = '';
  /** Accord layout stage 3: the toolbar's button says just "Undo" (the description is its tooltip). */
  private compact = false;
  /** Test hook: every run this page made, newest last. */
  readonly runs: Array<{ action: 'undo' | 'redo'; ok: boolean; message: string }> = [];

  constructor(private readonly host: UndoHost) {
    this.controlsEl.className = 'pundo';
    this.controlsEl.setAttribute('role', 'group');
    this.controlsEl.setAttribute('aria-label', 'Undo');
    this.undoButton.type = 'button';
    this.undoButton.className = 'pundo-btn';
    this.undoButton.onclick = () => { void this.undo(); };
    this.redoButton.type = 'button';
    this.redoButton.className = 'pundo-btn pundo-redo';
    this.redoButton.textContent = 'Redo';
    this.redoButton.onclick = () => { void this.redo(); };
    this.noticeEl.className = 'pundo-notice';
    this.noticeEl.setAttribute('role', 'status');
    this.noticeEl.hidden = true;
    this.controlsEl.append(this.undoButton, this.redoButton, this.noticeEl);
    this.render();
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.host.stack().subscribe(() => this.render());
    document.addEventListener('beforeinput', this.onBeforeInput, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    this.render();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    document.removeEventListener('beforeinput', this.onBeforeInput, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
  }

  /**
   * Cmd/Ctrl+Z anywhere on the page. The review panel also routes its own history keystroke here
   * (ReviewBridge.proofUndo), so whichever listener sees the event first, one Undo runs and only
   * one: handleKey hands the keystroke back (returns false) when typing is the newer action.
   */
  private onKeyDown = (event: KeyboardEvent): void => {
    if (!UNDO_POLICY.enabled) return;
    const target = event.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key !== UNDO_POLICY.undoKey && key !== UNDO_POLICY.redoKey) return;
    const redo = key === UNDO_POLICY.redoKey || event.shiftKey;
    if (!this.handleKey(redo)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  /** Typing in the document: the text history owns Cmd+Z until that edit is undone. */
  private typedAt = 0;
  private onBeforeInput = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (!target?.isContentEditable) return;
    const type = (event as InputEvent).inputType;
    if (type === 'historyUndo' || type === 'historyRedo') return;
    this.typedAt = Date.now();
  };

  private textEditAt(): number {
    return Math.max(this.typedAt, this.host.lastTextEditAt?.() ?? 0);
  }

  /**
   * Cmd/Ctrl+Z (and Shift / Y for redo) reached the page. Returns true when the Proof stack took
   * it, false to leave it to the editor's own text history.
   */
  handleKey(redo: boolean): boolean {
    if (!UNDO_POLICY.enabled) return false;
    const stack = this.host.stack();
    const entry = redo ? stack.nextRedo() : stack.next();
    if (!entry) return false;
    if (UNDO_UI_POLICY.textEditWins && !redo) {
      const textAt = this.textEditAt();
      // A typed edit after this action: typing owns Cmd+Z until that edit is undone.
      if (textAt > 0 && textAt + UNDO_UI_POLICY.textEditGraceMs > entry.at) return false;
    }
    void (redo ? this.redo() : this.undo());
    return true;
  }

  async undo(): Promise<void> {
    const result = await this.host.stack().undo();
    this.runs.push({ action: 'undo', ok: result.ok, message: result.message });
    this.notice(result.message, result.ok);
  }

  async redo(): Promise<void> {
    const result = await this.host.stack().redo();
    this.runs.push({ action: 'redo', ok: result.ok, message: result.message });
    this.notice(result.message, result.ok);
  }

  private notice(message: string, ok: boolean): void {
    this.noticeEl.textContent = message;
    this.noticeEl.dataset.ok = String(ok);
    this.noticeEl.hidden = !message;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => { this.noticeEl.hidden = true; this.noticeEl.textContent = ''; }, UNDO_UI_POLICY.noticeMs);
    this.render();
  }

  private render(): void {
    const stack = this.host.stack();
    const next = stack.next();
    const nextRedo = stack.nextRedo();
    const running = stack.isRunning();
    const sig = `${next?.id ?? ''}|${nextRedo?.id ?? ''}|${running}|${this.compact}`;
    if (sig === this.sig) return;
    this.sig = sig;
    const label = next && UNDO_UI_POLICY.showNextAction && !this.compact ? `Undo ${next.description}` : 'Undo';
    this.undoButton.textContent = label.length > 46 ? `${label.slice(0, 45)}…` : label;
    this.undoButton.disabled = !next || running;
    this.undoButton.title = next ? `Undo: ${next.description} (⌘Z / Ctrl+Z)` : 'Nothing to undo';
    this.undoButton.setAttribute('aria-label', next ? `Undo ${next.description}` : 'Nothing to undo');
    this.undoButton.dataset.kind = next?.kind ?? '';
    this.redoButton.hidden = !UNDO_POLICY.redo || !nextRedo;
    this.redoButton.disabled = !nextRedo || running;
    this.redoButton.title = nextRedo ? `Redo: ${nextRedo.description}` : '';
    this.controlsEl.hidden = !next && !nextRedo;
  }

  /** Toolbar placement: the button says just "Undo"; its tooltip and the Edit menu name what it reverses. */
  setCompact(compact: boolean): void {
    if (compact === this.compact) return;
    this.compact = compact;
    this.controlsEl.dataset.compact = String(compact);
    this.render();
  }

  /** Test hook. */
  debugState(): Record<string, unknown> {
    const stack = this.host.stack();
    return {
      depth: stack.depth(),
      redoDepth: stack.redoDepth(),
      next: stack.next() ? { kind: stack.next()!.kind, description: stack.next()!.description } : null,
      nextRedo: stack.nextRedo() ? { kind: stack.nextRedo()!.kind, description: stack.nextRedo()!.description } : null,
      message: stack.message(),
      log: stack.log.slice(-10),
      runs: this.runs.slice(-10),
      label: this.undoButton.textContent,
      lastTextEditAt: this.textEditAt(),
    };
  }
}
