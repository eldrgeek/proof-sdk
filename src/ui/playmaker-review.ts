import { getActorName, getMarkColor, type Mark, type CommentData, type ReplaceData } from '../formats/marks';
import { getReviewStyle, setReviewStyle, getReviewWalk, setReviewWalk, REVIEW_STYLE_EVENT } from '../editor/review-style';
import './playmaker-review.css';

export type ReviewAction = 'accept' | 'reject' | 'resolve' | 'reply';
export interface ReviewBridge {
  marks(): Mark[];
  decide(ids: string[], action: ReviewAction, text?: string): void;
  history(redo: boolean): boolean;
  jump(id: string): void;
  changed(): void;
}
export function isOpenReviewMark(mark: Mark): boolean {
  if (mark.kind === 'comment') return !(mark.data as CommentData)?.resolved;
  return ['insert', 'delete', 'replace'].includes(mark.kind)
    && !['accepted', 'rejected'].includes((mark.data as ReplaceData)?.status);
}

/** Presentation only: all operations are supplied by the editor's mark bridge. */
export class PlayMakerReview {
  readonly control = document.createElement('label');
  private readonly select = document.createElement('select');
  private readonly panel = document.createElement('section');
  private readonly toggle = document.createElement('button');
  private dialog: HTMLDivElement | null = null;
  private activeId: string | null = null;
  private displayedMark: Mark | null = null;
  private displayedSignature = '';
  private refreshPending = false;
  private returnFocus: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private walk = getReviewWalk();
  private settled = new Set<string>();
  private panelSignature = '';
  private previousOpen = new Set<string>();
  private failedIds = new Set<string>();
  private historyMessage = '';
  private readonly historyNotice = document.createElement('p');
  private readonly settledKey = `proof:review-settled:${location.pathname}`;

  constructor(private readonly bridge: ReviewBridge) {
    try { this.settled = new Set(JSON.parse(localStorage.getItem(this.settledKey) || '[]')); } catch { /* optional cache */ }
    this.control.className = 'review-style-control';
    this.control.append('Review style ', this.select);
    this.select.setAttribute('aria-label', 'Review style');
    for (const [value, label] of [['proof', 'Proof'], ['playmaker', 'PlayMaker']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = label;
      this.select.append(option);
    }
    this.select.onchange = () => setReviewStyle(this.select.value === 'playmaker' ? 'playmaker' : 'proof');
    this.toggle.type = 'button'; this.toggle.className = 'pm-review-toggle'; this.toggle.textContent = 'Marks';
    this.toggle.onclick = () => { this.panel.hidden = !this.panel.hidden; this.toggle.setAttribute('aria-expanded', String(!this.panel.hidden)); };
    this.control.append(this.toggle);
    this.panel.className = 'pm-review-panel'; this.panel.setAttribute('aria-label', 'Marks');
    this.historyNotice.className = 'review-history-notice';
    this.historyNotice.setAttribute('role', 'alert');
    this.historyNotice.hidden = true;
    document.body.append(this.panel, this.historyNotice);
    window.addEventListener(REVIEW_STYLE_EVENT, this.styleChanged);
    document.addEventListener('pointerdown', this.pointerDown, true);
    document.addEventListener('click', this.click, true);
    document.addEventListener('keydown', this.keydown, true);
    document.addEventListener('beforeinput', this.beforeinput, true);
    this.styleChanged();
  }

  private styleChanged = (): void => {
    this.cancelWalk(); this.close();
    const style = getReviewStyle(); this.select.value = style;
    document.body.dataset.reviewStyle = style;
    this.panel.hidden = style !== 'playmaker'; this.toggle.hidden = style !== 'playmaker';
    this.toggle.setAttribute('aria-expanded', String(!this.panel.hidden));
    this.bridge.changed(); this.update();
  };
  private openMarks(): Mark[] {
    return this.bridge.marks().filter(isOpenReviewMark).sort((a, b) => (a.range?.from ?? Infinity) - (b.range?.from ?? Infinity));
  }
  update(): void {
    this.historyNotice.textContent = this.historyMessage;
    this.historyNotice.hidden = !this.historyMessage || getReviewStyle() === 'playmaker';
    if (getReviewStyle() !== 'playmaker') return;
    const marks = this.openMarks();
    const openIds = new Set(marks.map(mark => mark.id));
    for (const id of this.previousOpen) if (!openIds.has(id)) this.settled.add(id);
    this.previousOpen = openIds;
    for (const mark of this.bridge.marks()) {
      if (isOpenReviewMark(mark)) this.settled.delete(mark.id);
      else if (['comment', 'insert', 'delete', 'replace'].includes(mark.kind)) this.settled.add(mark.id);
    }
    try { localStorage.setItem(this.settledKey, JSON.stringify([...this.settled])); } catch { /* optional cache */ }
    if (this.activeId && this.markSignature(this.bridge.marks().find(mark => mark.id === this.activeId)) !== this.displayedSignature) {
      this.refreshActive();
    }
    const signature = JSON.stringify([marks, [...this.settled], this.walk, [...this.failedIds], this.historyMessage]);
    if (signature === this.panelSignature) return;
    this.panelSignature = signature;
    const focusId = (document.activeElement as HTMLElement)?.dataset.reviewRow;
    this.panel.replaceChildren();
    const heading = document.createElement('h2'); heading.textContent = 'Marks';
    const counts = document.createElement('p'); counts.className = 'pm-review-counts'; counts.setAttribute('aria-live', 'polite');
    counts.textContent = `${marks.length} open · ${this.settled.size} settled`;
    this.panel.append(heading, counts, this.button('Start review', () => { if (marks[0]) this.open(marks[0].id); }, !marks.length));
    const walkLabel = document.createElement('label'); walkLabel.className = 'pm-review-walk';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = this.walk;
    checkbox.onchange = () => { this.walk = checkbox.checked; setReviewWalk(this.walk); if (!this.walk) this.cancelWalk(); };
    walkLabel.append(checkbox, 'Go to the next mark after I decide'); this.panel.append(walkLabel);
    const bulk = document.createElement('div'); bulk.className = 'pm-review-actions';
    for (const action of ['accept', 'reject'] as const) {
      const suggestions = marks.filter(mark => mark.kind !== 'comment');
      bulk.append(this.button(`${action === 'accept' ? 'Accept' : 'Reject'} all`, () => {
        if (suggestions.length > 10 && !confirm(`${action === 'accept' ? 'Accept' : 'Reject'} all ${suggestions.length} suggestions?`)) return;
        this.perform(suggestions.map(mark => mark.id), action);
      }, !suggestions.length));
    }
    this.panel.append(bulk);
    const list = document.createElement('div'); list.className = 'pm-review-list';
    for (const mark of marks) {
      const row = this.button('', () => this.open(mark.id)); row.className = 'pm-review-row'; row.dataset.reviewRow = mark.id;
      if (this.failedIds.has(mark.id)) { row.setAttribute('aria-invalid', 'true'); row.title = 'This suggestion changed. Review it before deciding.'; }
      row.style.setProperty('--review-author', getMarkColor(mark.by));
      const author = document.createElement('strong'); author.textContent = getActorName(mark.by);
      const snippet = document.createElement('span'); snippet.textContent = `${mark.kind === 'comment' ? 'Comment' : 'Suggestion'} · ${(mark.quote || (mark.data as ReplaceData)?.content || 'Unanchored mark').slice(0, 100)}`;
      row.append(author, snippet); list.append(row);
    }
    this.panel.append(list);
    if (this.historyMessage) {
      const message = document.createElement('p'); message.setAttribute('role', 'alert');
      message.textContent = this.historyMessage; this.panel.append(message);
    }
    if (focusId) this.panel.querySelector<HTMLElement>(`[data-review-row="${CSS.escape(focusId)}"]`)?.focus();
  }
  private button(label: string, action: () => void, disabled = false): HTMLButtonElement {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.disabled = disabled; button.onclick = action; return button;
  }
  private markAt(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    const element = target.closest('.ProseMirror [data-mark-id]');
    const id = element?.getAttribute('data-mark-id');
    return id && this.openMarks().some(mark => mark.id === id) ? id : null;
  }
  private pointerDown = (event: PointerEvent): void => {
    if (getReviewStyle() !== 'playmaker') return;
    const id = this.markAt(event.target);
    if (id) { event.preventDefault(); event.stopImmediatePropagation(); }
    else if (event.target instanceof Element && event.target.closest('.ProseMirror')) {
      // An explicit click on the live page returns the pencil to the writer.
      this.cancelWalk(); this.close(false);
    }
  };
  private click = (event: MouseEvent): void => {
    if (getReviewStyle() !== 'playmaker') return;
    const id = this.markAt(event.target);
    if (!id) return;
    event.preventDefault(); event.stopImmediatePropagation();
    this.open(id, { x: event.clientX, y: event.clientY });
  };
  private markSignature(mark?: Mark): string {
    return JSON.stringify(mark ? [mark.id, mark.kind, mark.by, mark.at, mark.quote, mark.data] : null);
  }
  private refreshActive(needsAcknowledgment = true): void {
    if (!this.activeId || !this.dialog) return;
    const rect = this.dialog.getBoundingClientRect(), returnFocus = this.returnFocus;
    this.open(this.activeId, { x: rect.x, y: rect.y }, true);
    this.returnFocus = returnFocus;
    this.refreshPending = needsAcknowledgment;
  }
  open(id: string, point?: { x: number; y: number }, changed = false): void {
    const current = this.bridge.marks().find(mark => mark.id === id);
    const mark = current ?? (changed && this.displayedMark?.id === id ? this.displayedMark : null);
    this.cancelWalk(); this.close(false);
    if (!mark || (!changed && !isOpenReviewMark(mark))) return;
    this.displayedMark = structuredClone(mark);
    this.displayedSignature = this.markSignature(current);
    this.refreshPending = changed;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : this.toggle;
    if (!point) {
      this.bridge.jump(id);
      const rect = document.querySelector(`.ProseMirror [data-mark-id="${CSS.escape(id)}"]`)?.getBoundingClientRect();
      point = { x: rect?.left ?? 24, y: rect?.bottom ?? 120 };
    }
    this.activeId = id;
    const dialog = document.createElement('div'); this.dialog = dialog;
    dialog.className = 'pm-review-dialog'; dialog.dataset.markId = id;
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-labelledby', 'pm-review-title'); dialog.tabIndex = -1;
    dialog.style.setProperty('--review-author', getMarkColor(mark.by));
    const header = document.createElement('div'); header.className = 'pm-review-drag';
    const title = document.createElement('strong'); title.id = 'pm-review-title'; title.textContent = getActorName(mark.by);
    header.append(title, this.button('Close (Esc)', () => { this.cancelWalk(); this.close(); }));
    dialog.append(header);
    const when = document.createElement('time'); when.dateTime = mark.at; when.textContent = new Date(mark.at).toLocaleString(); dialog.append(when);
    const changes = document.createElement('div'); changes.className = 'pm-review-change';
    if (mark.kind === 'replace' || mark.kind === 'delete') {
      const before = document.createElement('del'); before.textContent = mark.quote; changes.append(before);
    } else if (mark.kind === 'comment') {
      const quote = document.createElement('blockquote'); quote.textContent = mark.quote; changes.append(quote);
      const comment = document.createElement('p'); comment.textContent = (mark.data as CommentData)?.text || ''; changes.append(comment);
    }
    if (mark.kind === 'replace') changes.append(' → ');
    if (mark.kind === 'replace' || mark.kind === 'insert') {
      const after = document.createElement('ins'); after.textContent = (mark.data as ReplaceData)?.content || mark.quote; changes.append(after);
    }
    const replies = (mark.data as CommentData)?.replies;
    if (Array.isArray(replies)) for (const reply of replies) {
      const line = document.createElement('p'); line.textContent = `${getActorName(reply.by)}: ${reply.text}`; changes.append(line);
    }
    dialog.append(changes);
    if (changed) {
      const notice = document.createElement('p'); notice.setAttribute('role', 'status');
      notice.textContent = 'This suggestion changed while it was open.';
      if (!current) notice.textContent += ' It was removed.';
      else if (!isOpenReviewMark(current)) notice.textContent += ' It was resolved.';
      dialog.append(notice);
    }
    const unavailable = !current || !isOpenReviewMark(current);
    const actions = document.createElement('div'); actions.className = 'pm-review-actions';
    const add = (label: string, key: string, action: () => void) => {
      const button = this.button(`${label} (${key.toUpperCase()})`, action, unavailable && key !== 'l'); button.dataset.reviewKey = key; actions.append(button);
    };
    if (mark.kind !== 'comment') {
      add('Accept', 'a', () => this.perform([id], 'accept'));
      add('Reject', 'r', () => this.perform([id], 'reject'));
    }
    add('Reply', 'c', () => this.composeReply(id));
    if (mark.kind === 'comment') add('Resolve', 'e', () => this.perform([id], 'resolve'));
    add('Later', 'l', () => this.later(id));
    dialog.append(actions); document.body.append(dialog);
    this.position(point.x, point.y);
    header.onpointerdown = event => {
      if ((event.target as Element).closest('button') || innerWidth <= 480) return;
      event.preventDefault(); header.setPointerCapture(event.pointerId);
      const rect = dialog.getBoundingClientRect(); const dx = event.clientX - rect.left, dy = event.clientY - rect.top;
      header.onpointermove = move => this.position(move.clientX - dx, move.clientY - dy);
      header.onpointerup = () => { header.onpointermove = null; };
    };
    actions.querySelector('button')?.focus();
  }
  private position(x: number, y: number): void {
    if (!this.dialog) return;
    const rect = this.dialog.getBoundingClientRect();
    this.dialog.style.left = `${Math.max(8, Math.min(x, innerWidth - rect.width - 8))}px`;
    this.dialog.style.top = `${Math.max(8, Math.min(y, innerHeight - rect.height - 8))}px`;
  }
  private composeReply(id: string): void {
    if (!this.dialog || this.dialog.querySelector('textarea')) return;
    const field = document.createElement('textarea'); field.setAttribute('aria-label', 'Reply'); field.placeholder = 'Write a reply…';
    const send = this.button('Send reply', () => { if (field.value.trim()) this.perform([id], 'reply', field.value.trim()); });
    this.dialog.append(field, send); field.focus();
  }
  private perform(ids: string[], action: ReviewAction, text?: string): void {
    if (ids.length === 1 && ids[0] === this.activeId) {
      const current = this.bridge.marks().find(mark => mark.id === ids[0]);
      if (this.refreshPending || this.markSignature(current) !== this.displayedSignature) {
        this.refreshActive(false); return;
      }
      if (!current || !isOpenReviewMark(current)) return;
    }
    const order = this.openMarks().map(mark => mark.id); const last = ids[ids.length - 1];
    try {
      this.failedIds.clear(); this.historyMessage = '';
      this.bridge.decide(ids, action, text);
      if (action !== 'reply') ids.forEach(id => this.settled.add(id));
      this.close(); this.update(); this.advance(order, last);
    } catch (error) {
      this.failedIds = new Set((error as { failedIds?: string[] })?.failedIds || []);
      if (!this.dialog) {
        this.historyMessage = error instanceof Error ? error.message : 'Unable to save decision.';
        this.update(); return;
      }
      this.update();
      const message = document.createElement('p'); message.setAttribute('role', 'alert'); message.textContent = error instanceof Error ? error.message : 'Unable to save decision.';
      (this.dialog || this.panel).append(message);
    }
  }
  private later(id: string): void { const order = this.openMarks().map(mark => mark.id); this.close(); this.advance(order, id); }
  private advance(order: string[], id: string): void {
    this.cancelWalk(); if (!this.walk) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (getReviewStyle() !== 'playmaker' || (document.activeElement as HTMLElement)?.isContentEditable) return;
      const open = this.openMarks(); const index = order.indexOf(id);
      const next = [...order.slice(index + 1), ...order.slice(0, index)].find(candidate => open.some(mark => mark.id === candidate));
      if (next) this.open(next);
    }, 900);
  }
  private cancelWalk(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private close(restoreFocus = true): void {
    this.dialog?.remove(); this.dialog = null; this.activeId = null;
    if (restoreFocus) {
      // Keep decision undo outside the text; a click on the page resumes editing.
      const target = this.returnFocus?.isConnected && !this.returnFocus.isContentEditable ? this.returnFocus : this.toggle;
      target.focus({ preventScroll: true });
    }
  }
  /** Shared by the document capture listener and the editor's direct props,
   * which take precedence over both Milkdown history keymaps in either style. */
  handleHistoryInput(event: KeyboardEvent | InputEvent): boolean {
    const target = event.target as HTMLElement | null;
    if (!target || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return false;
    let redo: boolean;
    if ('inputType' in event) {
      if (!['historyUndo', 'historyRedo'].includes(event.inputType)) return false;
      redo = event.inputType === 'historyRedo';
    } else {
      const key = event.key.toLowerCase();
      if (!(event.metaKey || event.ctrlKey) || event.altKey || !['z', 'y'].includes(key)) return false;
      redo = key === 'y' || event.shiftKey;
    }
    event.preventDefault(); event.stopImmediatePropagation();
    this.cancelWalk(); this.close(!target.isContentEditable);
    try { this.historyMessage = ''; this.bridge.history(redo); }
    catch (error) { this.historyMessage = error instanceof Error ? error.message : 'Unable to restore decision.'; }
    this.update();
    return true;
  }
  private beforeinput = (event: Event): void => { this.handleHistoryInput(event as InputEvent); };
  private keydown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement;
    const typing = target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    if (this.handleHistoryInput(event)) return;
    if (getReviewStyle() !== 'playmaker' || !this.dialog?.contains(target)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); this.cancelWalk(); this.close(); return; }
    if (event.key === 'Tab') {
      const focusable = [...this.dialog.querySelectorAll<HTMLElement>('button:not(:disabled),textarea,input')];
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index + 1) % focusable.length;
      event.preventDefault(); focusable[next]?.focus(); return;
    }
    if (!typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const button = this.dialog.querySelector<HTMLButtonElement>(`[data-review-key="${CSS.escape(event.key.toLowerCase())}"]`);
      if (button) { event.preventDefault(); event.stopImmediatePropagation(); button.click(); }
    }
  };
}
