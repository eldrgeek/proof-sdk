/**
 * Remote updates preserve focused controls; resolving stays expanded until explicit navigation.
 * Mike, 2026-09-23 (usability brief).
 * The selected passage discussion lives only in Review; Discuss opens the composer.
 *
 * Mike, 2026-09-22: discussion happens in the document, not in the chat. This is where it shows:
 * under the line's marks and its changes, the threads anchored to the line the cursor is on. Every
 * thread's head says what would close it. A thread whose text was deleted says so and quotes what
 * it was about. A resolved thread folds to a mark; clicking the mark opens its history.
 *
 * It renders what src/shared/threads.ts computes and never decides anything itself.
 *
 * Authorship: Mike Wolf (rulings), built by Claude Opus 5 (worker accord-threads), 2026-09-22.
 */
import {
  THREAD_ASK_CHOICES,
  THREAD_ASK_HELP,
  THREAD_ASK_LABEL,
  canResolveThread,
  defaultAsksFor,
  detachedNotice,
  foldedThreadSummary,
  resolutionsFor,
  threadFoldsFor,
  threadOpenFor,
  type ThreadAsks,
  type ThreadStatus,
  type ThreadView,
} from '../shared/threads';
import { actorLabel } from '../shared/line-marks';
import { TYPED_DISCUSSION_POLICY } from '../shared/typed-discussion';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface ThreadsHost {
  /** The selected passage in Review. */
  focusLine(): number;
  /** The document's lines, for the subject of a new thread. */
  lineText(index: number): string;
  /** The threads on that line now. */
  threadsOnLine(index: number): ThreadView[];
  proposalCardElsewhere?(view: ThreadView): boolean;
  proposalDecisionElsewhere?(view: ThreadView): boolean;
  /**
   * The lines the person has selected, in document order (empty when nothing is selected). A
   * selection the cursor has moved away from does not count, unless `force` (the selection bar's
   * Thread button, pressed on a selection the person is looking at).
   */
  selectedLines(force?: boolean): number[];
  /** Exactly what is selected inside one line, when that is what was selected. */
  selectionText(): string | null;
  /** The viewer. */
  me(): string;
  /** Sponsored AI attribution uses the same label as proposals. */
  authorLabel?(actor: string): string;
  isOwner(): boolean;
  canComment(): boolean;
  team(): string[];
  /** Starts a thread. Resolves with its id, or null when it could not be made. */
  start(input: { lines: number[]; text: string; asks: ThreadAsks; selection: string | null }): Promise<string | null>;
  close(id: string, status: ThreadStatus): Promise<boolean>;
  reopen(id: string): Promise<boolean>;
  reply(id: string, text: string): boolean;
  canTurnBack?(id: string): boolean;
  turnBack?(id: string): Promise<boolean>;
  /** Re-renders Review (after a write). */
  refresh(): void;
}

/** The Review panel’s discussion section. */
export class ThreadsPanel {
  readonly element = el('section', 'amg-threads');
  private readonly head = el('div', 'amg-threads-head');
  private readonly list = el('div', 'amg-threads-list');
  private readonly composer = el('form', 'amg-thread-new');
  private readonly composerText = el('textarea', 'amg-thread-text-input');
  private readonly composerSubject = el('p', 'amg-thread-subject');
  private readonly composerAsks = el('fieldset', 'amg-thread-asks');
  private asks: ThreadAsks = defaultAsksFor('discussion');
  private composerLines: number[] = [];
  private composerSelection: string | null = null;
  /** Threads the viewer opened out of their fold, by id. */
  private readonly unfolded = new Set<string>();
  private sig = '';
  /** Test hook: what this panel has done, newest last. */
  readonly log: Array<{ action: string; id?: string }> = [];

  constructor(private readonly host: ThreadsHost) {
    this.list.addEventListener('focusout', () => queueMicrotask(() => this.render()));
    this.element.hidden = true;
    this.head.append(el('strong', undefined, 'Discussion'));
    this.buildComposer();
    this.element.append(this.head, this.composer, this.list);
  }

  // --------------------------------------------------------------------------
  // Starting one
  // --------------------------------------------------------------------------

  private buildComposer(): void {
    this.composer.hidden = true;
    this.composerText.rows = 3;
    this.composerText.maxLength = 4000;
    this.composerText.placeholder = 'What is the discussion?';
    this.composerText.setAttribute('aria-label', 'What is the discussion?');
    this.composerAsks.append(el('legend', undefined, 'This closes when…'));
    for (const asks of THREAD_ASK_CHOICES) {
      const row = el('label', 'amg-thread-ask');
      row.dataset.asks = asks;
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'amg-thread-asks';
      radio.value = asks;
      radio.checked = asks === this.asks;
      radio.onchange = () => { if (radio.checked) this.asks = asks; };
      row.append(radio, el('span', 'amg-thread-ask-label', THREAD_ASK_LABEL[asks]), el('span', 'amg-thread-ask-help', THREAD_ASK_HELP[asks]));
      this.composerAsks.append(row);
    }
    const actions = el('div', 'amg-thread-new-actions');
    const send = el('button', 'amg-thread-send', 'Start');
    send.type = 'submit';
    const cancel = el('button', 'amg-thread-cancel', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = () => this.closeComposer();
    actions.append(send, cancel);
    this.composer.append(this.composerSubject, this.composerText, this.composerAsks, actions);
    this.composerText.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.closeComposer(); return; }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); this.composer.requestSubmit(); }
    });
    this.composer.onsubmit = (event) => { event.preventDefault(); void this.submit(); };
  }

  /**
   * T (or the button): the subject is the selection, or the cursor line when nothing is selected.
   * The closing condition starts at the sensible default and the person can change it before they
   * start; it is never empty.
   */
  openComposer(fromSelection = false): boolean {
    if (!this.host.canComment()) return false;
    const selected = this.host.selectedLines(fromSelection);
    const lines = selected.length ? selected : [this.host.focusLine()];
    if (lines.some(index => index < 0)) return false;
    this.composerLines = lines;
    this.composerSelection = selected.length === 1 ? this.host.selectionText() : null;
    this.asks = defaultAsksFor('discussion');
    for (const radio of Array.from(this.composerAsks.querySelectorAll('input[type=radio]')) as HTMLInputElement[]) {
      radio.checked = radio.value === this.asks;
    }
    const subject = this.composerSelection
      ?? (lines.length === 1
        ? this.host.lineText(lines[0])
        : `${lines.length} lines, from line ${lines[0] + 1} to line ${lines[lines.length - 1] + 1}`);
    this.composerSubject.textContent = lines.length === 1 && !this.composerSelection
      ? `On line ${lines[0] + 1}: “${subject.slice(0, 120)}”`
      : `On ${this.composerSelection ? `“${subject.slice(0, 120)}”` : subject}`;
    this.composer.hidden = false;
    this.element.hidden = false;
    this.composerText.value = '';
    this.composerText.focus({ preventScroll: true });
    this.log.push({ action: 'composer-open' });
    return true;
  }

  closeComposer(): void {
    this.composer.hidden = true;
    this.composerText.value = '';
    this.log.push({ action: 'composer-close' });
    this.host.refresh();
  }

  composerOpen(): boolean { return !this.composer.hidden; }

  private async submit(): Promise<void> {
    const text = this.composerText.value.trim();
    if (!text) { this.composerText.focus(); return; }
    const id = await this.host.start({ lines: this.composerLines, text, asks: this.asks, selection: this.composerSelection });
    this.log.push({ action: 'started', id: id ?? undefined });
    if (id) this.closeComposer();
  }

  // --------------------------------------------------------------------------
  // Showing them
  // --------------------------------------------------------------------------

  private shownLine = -1;
  private readonly shownOpen = new Set<string>();
  render(force = false): void {
    const line = this.host.focusLine();
    const me = this.host.me();
    const lineChanged = line !== this.shownLine;
    if (lineChanged) { this.shownLine = line; this.shownOpen.clear(); }
    const views = line >= 0 ? this.host.threadsOnLine(line) : [];
    for (const view of views) if (view.thread.status === 'open') this.shownOpen.add(view.thread.id);
    // Whether "Turn back into text" is offered is part of what is drawn: after a reload the first
    // render can come before the editor wires that answer, and a cached card then never gains it.
    const sig = JSON.stringify([line, me, this.composer.hidden, [...this.unfolded].sort(), views.map(view => [
      view.thread.id, view.thread.status, view.thread.asks, view.thread.replies.length, view.detached, view.changed,
      this.host.authorLabel?.(view.thread.by), view.thread.replies.map(reply => this.host.authorLabel?.(reply.by)),
      Boolean(this.host.canTurnBack?.(view.thread.id)),
    ])]);
    // A focused reply stays put while this same line updates. Moving to another passage redraws.
    const threadFocus = document.activeElement;
    const threadTyping = threadFocus instanceof HTMLInputElement || threadFocus instanceof HTMLTextAreaElement;
    if (sig === this.sig || (!force && !lineChanged && threadTyping && this.list.contains(threadFocus))) return;
    this.sig = sig;
    const shown = views.filter(view => !this.host.proposalCardElsewhere?.(view));
    this.element.hidden = shown.length === 0 && this.composer.hidden;
    (this.head.querySelector('strong') as HTMLElement).textContent = shown.length
      ? `Discussion (${shown.length})`
      : 'Discussion';
    // Mike, 2026-09-23 (usability brief): resolution stays expanded until the reader leaves.
    this.list.replaceChildren();
    for (const view of shown) {
      const folded = !this.shownOpen.has(view.thread.id) && view.thread.status !== 'open' && threadFoldsFor(view, me) && !this.unfolded.has(view.thread.id);
      this.list.append(folded ? this.foldedMark(view) : this.card(view));
    }
  }

  /** A resolved thread folds to one mark on its line; clicking it opens the history. */
  private foldedMark(view: ThreadView): HTMLElement {
    const mark = el('button', 'amg-thread-mark', foldedThreadSummary(view));
    mark.type = 'button';
    mark.dataset.thread = view.thread.id;
    mark.dataset.folded = 'true';
    mark.setAttribute('aria-label', `${foldedThreadSummary(view)} — open the history`);
    mark.onclick = () => {
      this.unfolded.add(view.thread.id);
      this.log.push({ action: 'unfold', id: view.thread.id });
      this.sig = '';
      this.render(true);
    };
    return mark;
  }

  private card(view: ThreadView): HTMLElement {
    const thread = view.thread;
    const me = this.host.me();
    const card = el('article', 'amg-thread');
    card.dataset.thread = thread.id;
    card.dataset.asks = thread.asks;
    card.dataset.status = thread.status;
    card.dataset.kind = thread.kind;
    card.dataset.source = thread.source;
    if (view.detached) card.dataset.detached = 'true';

    // Every thread states what would close it, at its head.
    const head = el('header', 'amg-thread-head');
    const closes = el('span', 'amg-thread-closes', `Closes when: ${THREAD_ASK_LABEL[thread.asks]}`);
    closes.dataset.closes = thread.asks;
    head.append(closes, el('span', 'amg-thread-by', this.host.authorLabel?.(thread.by) ?? actorLabel(thread.by)));
    card.append(head);

    // Deleting the text never deletes the disagreement: it says so, and quotes what it was about.
    if (view.detached) {
      const notice = el('p', 'amg-thread-detached', detachedNotice(view));
      notice.setAttribute('role', 'note');
      card.append(notice);
    } else if (view.changed) {
      card.append(el('p', 'amg-thread-changed', 'The line this is about has been edited since.'));
    }

    if (thread.text) card.append(el('p', 'amg-thread-text', thread.text));
    if (thread.diff) {
      const diff = el('p', 'amg-thread-diff');
      diff.dataset.diff = thread.diff.kind;
      diff.textContent = thread.diff.kind === 'delete'
        ? `Proposes deleting: “${thread.diff.quote.slice(0, 200)}”`
        : `Proposes: “${String(thread.diff.content ?? '').slice(0, 200)}”`;
      card.append(diff);
    }

    if (thread.replies.length) {
      const replies = el('ol', 'amg-thread-replies');
      for (const reply of thread.replies) {
        const item = el('li', 'amg-thread-reply');
        item.append(el('span', 'amg-thread-reply-by', this.host.authorLabel?.(reply.by) ?? actorLabel(reply.by)), el('span', 'amg-thread-reply-text', reply.text));
        replies.append(item);
      }
      card.append(replies);
    }

    const openness = threadOpenFor(view, me, { team: this.host.team() });
    const why = el('p', 'amg-thread-why', openness.because);
    why.dataset.open = String(openness.open);
    if (openness.why) why.dataset.why = openness.why;
    card.append(why);

    const actions = el('div', 'amg-thread-actions');
    if (this.host.canTurnBack?.(thread.id)) {
      const back = el('button', 'amg-thread-turn-back', TYPED_DISCUSSION_POLICY.turnBackLabel);
      back.type = 'button';
      back.onclick = () => {
        back.disabled = true;
        void this.host.turnBack?.(thread.id).finally(() => { this.sig = ''; this.host.refresh(); });
      };
      actions.append(back);
    }
    if (thread.status === 'open') {
      const replyForm = el('form', 'amg-thread-reply-form');
      const input = el('input', 'amg-thread-reply-input');
      input.type = 'text';
      input.maxLength = 4000;
      input.placeholder = 'Reply on this thread…';
      input.setAttribute('aria-label', 'Reply on this thread');
      const send = el('button', 'amg-thread-reply-send', 'Reply');
      send.type = 'submit';
      replyForm.append(input, send);
      replyForm.onsubmit = (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) { input.focus(); return; }
        this.host.reply(thread.id, text);
        this.log.push({ action: 'reply', id: thread.id });
        input.value = '';
        this.sig = '';
        this.host.refresh();
      };
      card.append(replyForm);
      if (!this.host.proposalDecisionElsewhere?.(view) && canResolveThread(view, me, { isOwner: this.host.isOwner(), team: this.host.team() })) {
        for (const resolution of resolutionsFor(thread)) {
          const button = el('button', 'amg-thread-resolve', resolution.label);
          button.type = 'button';
          button.dataset.resolve = resolution.status;
          button.onclick = () => {
            this.log.push({ action: `close:${resolution.status}`, id: thread.id });
            void this.host.close(thread.id, resolution.status).then(() => { this.sig = ''; this.host.refresh(); });
          };
          actions.append(button);
        }
      }
    } else {
      const reopen = el('button', 'amg-thread-reopen', 'Reopen');
      reopen.type = 'button';
      reopen.onclick = () => {
        this.log.push({ action: 'reopen', id: thread.id });
        void this.host.reopen(thread.id).then(() => { this.unfolded.delete(thread.id); this.sig = ''; this.host.refresh(); });
      };
      actions.append(reopen);
      const fold = el('button', 'amg-thread-fold', 'Fold');
      fold.type = 'button';
      fold.onclick = () => { this.unfolded.delete(thread.id); this.shownOpen.delete(thread.id); this.sig = ''; this.render(true); };
      if (threadFoldsFor(view, me)) actions.append(fold);
    }
    if (actions.childElementCount) card.append(actions);
    return card;
  }

  /** Test hook. */
  debugState(): Record<string, unknown> {
    const line = this.host.focusLine();
    const views = line >= 0 ? this.host.threadsOnLine(line) : [];
    return {
      line,
      composerOpen: this.composerOpen(),
      asks: this.asks,
      threads: views.map(view => ({
        id: view.thread.id,
        asks: view.thread.asks,
        closes: THREAD_ASK_LABEL[view.thread.asks],
        status: view.thread.status,
        source: view.thread.source,
        kind: view.thread.kind,
        detached: view.detached,
        changed: view.changed,
        replies: view.thread.replies.length,
        openForMe: threadOpenFor(view, this.host.me(), { team: this.host.team() }).open,
        because: threadOpenFor(view, this.host.me(), { team: this.host.team() }).because,
        folded: !this.shownOpen.has(view.thread.id) && view.thread.status !== 'open' && threadFoldsFor(view, this.host.me()) && !this.unfolded.has(view.thread.id),
      })),
      log: this.log.slice(-20),
    };
  }
}
