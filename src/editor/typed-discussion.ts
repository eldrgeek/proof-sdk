import type { EditorView } from '@milkdown/kit/prose/view';
import { getMarks } from './plugins/marks';
import { getCurrentActor } from './actor';
import { isInputComposing } from './editing-guard';
import { actorKey } from '../shared/line-marks';
import type { MentionCandidate } from '../shared/chat';
import { classifyTypedRun, isRunAtItemEnd, typedItemAt, TYPED_DISCUSSION_POLICY } from '../shared/typed-discussion';

export interface TypedDiscussionRun {
  id: string; text: string; from: number; to: number; waitingOn: string[];
}
export interface TypedDiscussionHost {
  enabled(): boolean;
  candidates(): MentionCandidate[];
  convert(run: TypedDiscussionRun): Promise<void>;
  notice(message: string): void;
}

/** Watches actual local input, never API suggestions, hover or a typing timer. */
export class TypedDiscussionController {
  private active: string | null = null;
  private readonly keptText = new Set<string>();
  private pending = false;
  private queued = false;
  private localInput = false;
  private stopped = false;
  private readonly hint = document.createElement('span');
  constructor(private readonly view: EditorView, private readonly host: TypedDiscussionHost) {
    this.hint.className = 'accord-typed-discussion-hint';
    this.hint.textContent = TYPED_DISCUSSION_POLICY.hint;
    this.hint.setAttribute('role', 'status');
    this.hint.hidden = true;
    this.hint.style.cssText = 'position:fixed;z-index:40;pointer-events:none;font:12px sans-serif;padding:3px 7px;border-radius:4px;background:var(--bg-color,#fff);color:var(--text-color,#555);box-shadow:0 1px 4px #0002;max-width:calc(100vw - 20px)';
    document.body.append(this.hint);
    view.dom.addEventListener('keydown', this.key, true);
    view.dom.addEventListener('beforeinput', this.beforeInput, true);
    view.dom.addEventListener('focusout', this.blur);
    document.addEventListener('visibilitychange', this.visibility);
    document.addEventListener('scroll', this.positionHint, true);
  }
  update(localInput = false): void {
    this.localInput ||= localInput;
    if (this.queued || this.stopped) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      const local = this.localInput; this.localInput = false;
      if (this.stopped || !this.host.enabled()) return;
      if (this.pending) { this.localInput ||= local; return; }
      const selection = this.view.state.selection;
      const old = this.run();
      if (old) {
        const item = typedItemAt(this.view.state.doc, old.from);
        if (item && (selection.head <= item.from || selection.head >= item.to)) { this.finish(); return; }
      }
      if (local) {
        const mark = getMarks(this.view.state).find(m => m.kind === 'insert' && m.range
          && actorKey(m.by) === actorKey(getCurrentActor())
          && ((m.data as { status?: string }).status ?? 'pending') === 'pending'
          && selection.head >= m.range.from && selection.head <= m.range.to);
        this.active = mark?.id ?? null;
      }
      this.positionHint();
      if (!this.view.hasFocus()) this.finish();
    });
  }
  /** Words a person turned back into text stay text, as Shift+Enter keeps them. */
  keepAsText(id: string): void {
    this.keptText.add(id);
    if (this.active === id) this.active = null;
    this.positionHint();
  }
  private run(): TypedDiscussionRun | null {
    if (!this.active || this.keptText.has(this.active) || !this.host.enabled()) return null;
    const mark = getMarks(this.view.state).find(m => m.id === this.active);
    if (!mark?.range || mark.kind !== 'insert' || actorKey(mark.by) !== actorKey(getCurrentActor())
      || ((mark.data as { status?: string }).status ?? 'pending') !== 'pending'
      || !isRunAtItemEnd(this.view.state.doc, mark.range)) return null;
    const text = this.view.state.doc.textBetween(mark.range.from, mark.range.to, '\n', '\ufffc');
    const classified = classifyTypedRun(text, this.host.candidates());
    return classified.discussion ? { id: mark.id, text, ...mark.range, waitingOn: classified.waitingOn } : null;
  }
  private key = (event: KeyboardEvent): void => {
    if (event.isComposing || isInputComposing() || event.keyCode === 229) return;
    if (event.key === 'Enter' && event.shiftKey) {
      if (this.active) this.keptText.add(this.active);
      this.active = null; this.positionHint(); return;
    }
    const run = this.run();
    if (event.key === 'Enter' && run && this.view.state.selection.empty && this.view.state.selection.head === run.to) {
      event.preventDefault(); event.stopImmediatePropagation(); this.finish();
    }
    // Escape is captured by editing-guard at document level; its blur reaches us below.
  };
  private beforeInput = (event: InputEvent): void => {
    if (event.inputType !== 'insertParagraph' || event.isComposing || isInputComposing()) return;
    const run = this.run();
    if (run && this.view.state.selection.empty && this.view.state.selection.head === run.to) {
      event.preventDefault(); event.stopImmediatePropagation(); this.finish();
    }
  };
  private blur = (event: FocusEvent): void => {
    if (!this.view.dom.contains(event.relatedTarget as Node | null)) this.finish();
  };
  private visibility = (): void => { if (document.hidden) this.finish(); };
  private finish(): void {
    if (this.pending || isInputComposing()) return;
    const run = this.run();
    this.active = null; this.hint.hidden = true;
    if (!run) return;
    this.pending = true;
    void this.host.convert(run).catch(error => this.host.notice(error instanceof Error ? error.message : 'Could not send the discussion.'))
      .finally(() => { this.pending = false; this.update(); });
  }
  private positionHint = (): void => {
    const run = this.run();
    this.hint.hidden = !run || this.pending;
    if (!run || this.pending) return;
    const rect = this.view.coordsAtPos(run.to);
    this.hint.style.left = `${Math.max(8, Math.min(rect.right + 8, window.innerWidth - 240))}px`;
    this.hint.style.top = `${Math.max(0, rect.top - 23)}px`;
  };
  stop(): void {
    this.stopped = true;
    this.hint.remove();
    this.view.dom.removeEventListener('keydown', this.key, true);
    this.view.dom.removeEventListener('beforeinput', this.beforeInput, true);
    this.view.dom.removeEventListener('focusout', this.blur);
    document.removeEventListener('visibilitychange', this.visibility);
    document.removeEventListener('scroll', this.positionHint, true);
  }
}
