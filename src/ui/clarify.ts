/**
 * Proof Documents — "typing ? after a sentence means clarify" (Mike, 2026-09-19).
 *
 * A lone `?` typed at the end of a line, after existing text and separated from it by a space, is
 * a request to the document's AIs to explain that sentence — not text, not a rejection, and never
 * an Issue for the asker. On Enter or blur the `?` is taken back out of the text and the existing
 * Explain flow (the E key / the explain thread) is posted on that line, quoting the sentence. The
 * request shows in the rail and in chat like any other explain thread.
 *
 * "Is this right?" keeps its question mark: there is no space before it, so it is prose. Only
 * `… word ?` at the very end of a line converts (src/shared/clarify.ts has the exact rule).
 *
 * In Suggesting mode the `?` is removed as a plain edit, not as a delete suggestion: it was never
 * part of the text the person meant to write (CLARIFY_POLICY.inSuggestMode).
 *
 * Authorship: Mike Wolf's words (2026-09-19); built by Claude Opus 5 (worker proof-ux2).
 */
import type { EditorView } from '@milkdown/kit/prose/view';
import { CLARIFY_POLICY, clarifyQuestion, detectClarify, type ClarifyDetection } from '../shared/clarify';

export interface ClarifyHost {
  view(): EditorView | null;
  /** Posts the explain request on the line (LineMarksUI.explainLine). */
  explain(lineIndex: number, question: string): Promise<boolean>;
  /** The line index of a document position (LineMarksUI.lineAtPos). */
  lineAtPos(pos: number): number;
  /** Meta key that tells the suggestions plugin "this is a direct edit, not a suggestion". */
  directEditMeta(): unknown;
  /** Are we in Suggesting mode? (only for the report; the conversion runs either way) */
  suggesting(): boolean;
  /** Tells the reader what happened. */
  toast(message: string): void;
}

interface Candidate {
  /** Start of the textblock's content. */
  base: number;
  detection: ClarifyDetection;
  lineIndex: number;
}

export class ClarifyUI {
  private started = false;
  /** Test hook: the requests this page converted, newest last. */
  readonly converted: Array<{ line: number; sentence: string; suggesting: boolean }> = [];
  /** Test hook: lines looked at and left alone (a real question mark in prose). */
  readonly kept: string[] = [];

  constructor(private readonly host: ClarifyHost) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    document.addEventListener('keydown', this.onKeyDown, true);
    document.addEventListener('focusout', this.onFocusOut, true);
  }

  stop(): void {
    this.started = false;
    document.removeEventListener('keydown', this.onKeyDown, true);
    document.removeEventListener('focusout', this.onFocusOut, true);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!CLARIFY_POLICY.enabled || !CLARIFY_POLICY.commitOn.includes('enter')) return;
    if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (!target?.isContentEditable) return;
    const candidate = this.candidate();
    if (!candidate) return;
    // The Enter asked the question; it does not also split the paragraph.
    event.preventDefault();
    event.stopPropagation();
    void this.convert(candidate);
  };

  private onFocusOut = (): void => {
    if (!CLARIFY_POLICY.enabled || !CLARIFY_POLICY.commitOn.includes('blur')) return;
    const candidate = this.candidate();
    if (!candidate) return;
    void this.convert(candidate);
  };

  /** The line the caret is on, when it is a clarify request. */
  private candidate(): Candidate | null {
    const view = this.host.view();
    if (!view || !view.hasFocus?.()) {
      // focusout fires after the caret has gone: fall back to the stored selection.
      if (!view) return null;
    }
    const { $from } = view.state.selection;
    const parent = $from.parent;
    if (!parent.isTextblock) return null;
    const base = $from.start();
    const text = parent.textContent;
    const detection = detectClarify(text);
    if (!detection) {
      if (text.trim().endsWith(CLARIFY_POLICY.trigger)) {
        this.kept.push(text.slice(-40));
        if (this.kept.length > 20) this.kept.shift();
      }
      return null;
    }
    const lineIndex = this.host.lineAtPos(base);
    if (lineIndex < 0) return null;
    return { base, detection, lineIndex };
  }

  /** Takes the `?` back out of the text and posts the explain request. */
  private async convert(candidate: Candidate): Promise<void> {
    const view = this.host.view();
    if (!view) return;
    const { base, detection, lineIndex } = candidate;
    const from = base + detection.from;
    const to = base + detection.to;
    if (to <= from || to > view.state.doc.content.size) return;
    // A direct edit, even in Suggesting mode: the `?` was the question, never text.
    const tr = view.state.tr.delete(from, to);
    tr.setMeta(this.host.directEditMeta() as string, { clarify: true });
    view.dispatch(tr);
    const suggesting = this.host.suggesting();
    this.converted.push({ line: lineIndex, sentence: detection.sentence, suggesting });
    if (this.converted.length > 20) this.converted.shift();
    const ok = await this.host.explain(lineIndex, clarifyQuestion(detection));
    this.host.toast(ok
      ? `Asked the document’s AIs to clarify line ${lineIndex + 1}. It is a question, not a rejection.`
      : 'Could not post the clarify request.');
  }

  /** Test hook. */
  debugState(): Record<string, unknown> {
    return { converted: [...this.converted], kept: [...this.kept], started: this.started };
  }
}
