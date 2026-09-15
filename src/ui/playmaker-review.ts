import { getActorName, getMarkColor, type Mark, type CommentData, type ReplaceData } from '../formats/marks';
import { getReviewStyle, setReviewStyle, getReviewWalk, setReviewWalk, REVIEW_STYLE_EVENT } from '../editor/review-style';
import './playmaker-review.css';

export type ReviewAction = 'accept' | 'reject' | 'resolve' | 'reply';
export type VersoProposal = { kind: 'suggestion'; quote: string; replacement: string } | { kind: 'comment'; quote: string; text: string };
export interface ReviewBridge {
  ask?(messages: { role: 'user' | 'assistant'; content: string }[], mark: Mark | null): Promise<{ reply: string; proposals: VersoProposal[] }>;
  propose?(proposal: VersoProposal): void;
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
  private readonly panel = document.createElement('aside');
  private readonly toggle = document.createElement('button');
  private readonly chat = document.createElement('aside');
  private readonly chatToggle = document.createElement('button');
  private readonly conversation = document.createElement('div');
  private readonly slot = document.createElement('div');
  private readonly message = document.createElement('textarea');
  private readonly known = new Map<string, Mark>();
  private authorFilter = '';
  private dwellTimer: ReturnType<typeof setTimeout> | null = null;
  private programmaticUntil = 0;
  private transient = false;
  private deciding = false;
  private sending = false;
  private readonly messages: { role: 'user' | 'assistant'; content: string }[] = [];
  private desktop = innerWidth >= 1024;
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
    try { this.settled = new Set(JSON.parse(localStorage.getItem(this.settledKey) || '[]'));
      for (const mark of JSON.parse(localStorage.getItem(this.settledKey + ':marks') || '[]')) if (mark?.id && mark?.kind) this.known.set(mark.id, mark);
    } catch { /* optional cache */ }
    this.control.className = 'review-style-control';
    this.control.append('Review style ', this.select);
    this.select.setAttribute('aria-label', 'Review style');
    for (const [value, label] of [['proof', 'Proof'], ['playmaker', 'PlayMaker']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = label;
      this.select.append(option);
    }
    this.select.onchange = () => setReviewStyle(this.select.value === 'playmaker' ? 'playmaker' : 'proof');
    this.toggle.type = 'button'; this.toggle.className = 'pm-review-toggle'; this.toggle.textContent = 'Marks';
    this.toggle.onclick = () => this.setPanel('marks', this.panel.hidden);
    this.control.append(this.toggle);
    this.panel.className = 'pm-review-panel'; this.panel.setAttribute('aria-label', 'Marks');
    this.historyNotice.className = 'review-history-notice';
    this.historyNotice.setAttribute('role', 'alert');
    this.historyNotice.hidden = true;
    this.chat.className = 'pm-chat'; this.chat.setAttribute('aria-label', 'Verso chat');
    this.chatToggle.type = 'button'; this.chatToggle.className = 'pm-review-toggle'; this.chatToggle.textContent = 'Verso';
    this.chatToggle.onclick = () => this.setPanel('chat', this.chat.hidden);
    this.control.append(this.chatToggle);
    const chatHeading = document.createElement('h2'); chatHeading.textContent = 'Verso';
    this.conversation.className = 'pm-chat-conversation'; this.conversation.setAttribute('aria-live', 'polite');
    this.slot.className = 'pm-chat-current';
    this.message.setAttribute('aria-label', 'Message Verso'); this.message.placeholder = 'Ask Verso about this document…';
    this.message.onkeydown = event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (!this.message.value.trim()) this.slot.querySelector<HTMLButtonElement>('[data-default-choice]')?.click();
        else this.sendMessage();
      }
      event.stopPropagation();
    };
    this.chat.addEventListener('keydown', event => event.stopPropagation());
    this.chat.append(chatHeading, this.button('Close Verso', () => this.setPanel('chat', false)), this.conversation, this.slot, this.message, this.button('Send', () => this.sendMessage()));
    document.body.append(this.panel, this.chat, this.historyNotice);
    window.addEventListener('resize', this.layout);
    window.addEventListener('wheel', this.readerScrolled, { passive: true, capture: true });
    window.addEventListener('touchmove', this.readerScrolled, { passive: true, capture: true });
    document.addEventListener('scroll', this.scrolled, true);
    window.addEventListener(REVIEW_STYLE_EVENT, this.styleChanged);
    document.addEventListener('pointerdown', this.pointerDown, true);
    document.addEventListener('click', this.click, true);
    document.addEventListener('keydown', this.keydown, true);
    this.styleChanged();
  }

  private styleChanged = (): void => {
    this.cancelWalk(); this.close();
    const style = getReviewStyle(); this.select.value = style;
    document.body.dataset.reviewStyle = style;
    this.panel.hidden = style !== 'playmaker' || innerWidth < 1024; this.toggle.hidden = style !== 'playmaker';
    this.chat.hidden = style !== 'playmaker' || innerWidth < 1024 || this.chatWasCollapsed(); this.chatToggle.hidden = style !== 'playmaker'; this.layout();
    this.toggle.setAttribute('aria-expanded', String(!this.panel.hidden));
    this.bridge.changed(); this.update();
  };
  private openMarks(): Mark[] {
    return this.bridge.marks().filter(isOpenReviewMark).sort((a, b) => (a.range?.from ?? Infinity) - (b.range?.from ?? Infinity));
  }
  update(): void {
    if (this.deciding) return;
    this.historyNotice.textContent = this.historyMessage;
    this.historyNotice.hidden = !this.historyMessage || getReviewStyle() === 'playmaker';
    if (getReviewStyle() !== 'playmaker') return;
    const marks = this.openMarks();
    for (const mark of this.bridge.marks()) if (['comment', 'insert', 'delete', 'replace'].includes(mark.kind)) this.known.set(mark.id, structuredClone(mark));
    this.toggle.textContent = `Marks (${marks.length})`;
    const openIds = new Set(marks.map(mark => mark.id));
    for (const id of this.previousOpen) if (!openIds.has(id)) this.settled.add(id);
    this.previousOpen = openIds;
    for (const mark of this.bridge.marks()) {
      if (isOpenReviewMark(mark)) this.settled.delete(mark.id);
      else if (['comment', 'insert', 'delete', 'replace'].includes(mark.kind)) this.settled.add(mark.id);
    }
    try { localStorage.setItem(this.settledKey, JSON.stringify([...this.settled])); localStorage.setItem(this.settledKey + ':marks', JSON.stringify([...this.known.values()].filter(m => this.settled.has(m.id)))); } catch { /* optional cache */ }
    if (this.activeId && this.markSignature(this.bridge.marks().find(mark => mark.id === this.activeId)) !== this.displayedSignature) {
      this.refreshActive();
    }
    const signature = JSON.stringify([marks, [...this.settled], this.walk, [...this.failedIds], this.historyMessage, this.authorFilter, this.activeId, this.chat.hidden]);
    if (signature === this.panelSignature) return;
    this.panelSignature = signature;
    const focusId = (document.activeElement as HTMLElement)?.dataset.reviewRow;
    this.panel.replaceChildren();
    const heading = document.createElement('h2'); heading.textContent = 'Marks';
    const counts = document.createElement('p'); counts.className = 'pm-review-counts'; counts.setAttribute('aria-live', 'polite');
    counts.textContent = `${marks.length} open · ${this.settled.size} settled`;
    this.panel.append(heading, this.button('Close Marks', () => this.setPanel('marks', false)), counts, this.button('Start review', () => { if (marks[0]) this.open(marks[0].id); }, !marks.length));
    const walkLabel = document.createElement('label'); walkLabel.className = 'pm-review-walk';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = this.walk;
    checkbox.onchange = () => { this.walk = checkbox.checked; setReviewWalk(this.walk); if (!this.walk) this.cancelWalk(); };
    walkLabel.append(checkbox, 'Go to the next mark after I decide'); this.chat.querySelector('.pm-review-walk')?.remove(); (this.chat.hidden ? this.panel : this.chat).append(walkLabel);
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
    const all = [...this.known.values()].sort((a, b) => (a.range?.from ?? Infinity) - (b.range?.from ?? Infinity));
    const kinds = document.createElement('p'); kinds.textContent = `${all.filter(m => m.kind !== 'comment').length} edits · ${all.filter(m => m.kind === 'comment').length} comments`; this.panel.append(kinds);
    const filters = document.createElement('div'); filters.className = 'pm-review-filters';
    for (const author of ['', 'People', 'AIs', ...new Set(all.map(m => m.by))]) {
      const chip = this.button(author || 'Everyone', () => { this.authorFilter = author; this.update(); }); chip.setAttribute('aria-pressed', String(this.authorFilter === author)); filters.append(chip);
    }
    this.panel.append(filters);
    for (const mark of all.filter(m => !this.authorFilter || (this.authorFilter === 'People' ? !m.by.startsWith('ai:') : this.authorFilter === 'AIs' ? m.by.startsWith('ai:') : m.by === this.authorFilter))) {
      const row = this.button('', () => this.open(mark.id)); row.className = 'pm-review-row'; row.dataset.reviewRow = mark.id;
      row.classList.toggle('pm-settled', this.settled.has(mark.id)); row.classList.toggle('pm-current', this.activeId === mark.id);
      if (this.failedIds.has(mark.id)) { row.setAttribute('aria-invalid', 'true'); row.title = 'This suggestion changed. Review it before deciding.'; }
      row.style.setProperty('--review-author', getMarkColor(mark.by));
      const author = document.createElement('strong'); author.textContent = getActorName(mark.by);
      const snippet = document.createElement('span'); snippet.textContent = `${mark.kind === 'comment' ? '◆' : '↺'} ${this.settled.has(mark.id) ? 'settled' : 'open'} · ${(mark.quote || (mark.data as ReplaceData)?.content || 'Unanchored mark').slice(0, 100)}`;
      row.append(author, snippet); list.append(row);
    }
    this.panel.append(list);
    if (this.historyMessage) {
      const message = document.createElement('p'); message.setAttribute('role', 'alert');
      message.textContent = this.historyMessage; this.panel.append(message);
    }
    if (focusId) this.panel.querySelector<HTMLElement>(`[data-review-row="${CSS.escape(focusId)}"]`)?.focus();
  }
  private chatWasCollapsed(): boolean { try { return localStorage.getItem('proof:verso-open') === '0'; } catch { return false; } }
  private layout = (): void => {
    const desktop = innerWidth >= 1024;
    if (desktop !== this.desktop) { this.chat.hidden = !desktop || this.chatWasCollapsed(); this.panel.hidden = !desktop; this.desktop = desktop; }
    document.body.style.setProperty('--pm-left', !this.chat.hidden && innerWidth >= 1024 ? '360px' : '0px');
    document.body.style.setProperty('--pm-right', !this.panel.hidden && innerWidth >= 1024 ? '18rem' : '0px');
    const bar = document.getElementById('share-banner');
    document.body.style.setProperty('--pm-top', `${Math.max(100, (bar?.getBoundingClientRect().bottom ?? 80) + 12)}px`);
    this.chatToggle.setAttribute('aria-expanded', String(!this.chat.hidden));
    this.toggle.setAttribute('aria-expanded', String(!this.panel.hidden));
  };
  private setPanel(which: 'chat' | 'marks', open: boolean): void {
    const selected = this.activeId;
    if (which === 'chat') { try { localStorage.setItem('proof:verso-open', open ? '1' : '0'); } catch { /* optional preference */ } }
    const panel = which === 'chat' ? this.chat : this.panel; panel.hidden = !open;
    if (open && innerWidth < 1024) (which === 'chat' ? this.panel : this.chat).hidden = true;
    this.close(false); this.layout();
    if (which === 'chat' && open && selected) this.open(selected);
    this.update();
  }
  private highlight(): void {
    document.querySelectorAll('.pm-current-mark').forEach(el => el.classList.remove('pm-current-mark'));
    if (this.activeId) document.querySelectorAll(`.ProseMirror [data-mark-id="${CSS.escape(this.activeId)}"]`).forEach(el => el.classList.add('pm-current-mark'));
    this.panel.querySelectorAll<HTMLElement>('[data-review-row]').forEach(el => el.classList.toggle('pm-current', el.dataset.reviewRow === this.activeId));
  }
  private jump(id: string): void {
    this.programmaticUntil = Date.now() + 1200;
    if (this.dwellTimer) clearTimeout(this.dwellTimer);
    this.bridge.jump(id);
    let el = document.querySelector<HTMLElement>(`.ProseMirror [data-mark-id="${CSS.escape(id)}"]`);
    if (!el) { const mark = this.known.get(id); const text = (mark?.data as ReplaceData)?.content || mark?.quote;
      if (text) el = [...document.querySelectorAll<HTMLElement>('.ProseMirror p')].find(p => p.textContent?.includes(text)) ?? null;
      el?.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
    if (this.settled.has(id) && el) { el.classList.remove('pm-mark-flash'); void el.offsetWidth; el.classList.add('pm-mark-flash'); }
  }
  private blockedDwell(): boolean {
    const focus = document.activeElement as HTMLElement;
    return getReviewStyle() !== 'playmaker' || this.chat.hidden || Date.now() < this.programmaticUntil
      || Boolean(focus?.isContentEditable || focus?.matches('input, textarea, select') || document.querySelector('[role="dialog"],dialog[open],[data-proof-name-prompt="overlay"]'));
  }
  private visible(id: string): boolean {
    const elements = [...document.querySelectorAll<HTMLElement>(`.ProseMirror [data-mark-id="${CSS.escape(id)}"]`)];
    const top = parseFloat(document.body.style.getPropertyValue('--pm-top')) || 100;
    return elements.length > 0 && elements.every(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.top >= top && r.bottom <= innerHeight; });
  }
  private scrolled = (): void => {
    if (this.transient && this.activeId && !this.visible(this.activeId)) this.close(false);
  };
  private readerScrolled = (event: Event): void => {
    if (event.target instanceof Element && event.target.closest('.pm-chat,.pm-review-panel')) return;
    if (this.dwellTimer) clearTimeout(this.dwellTimer);
    if (this.blockedDwell()) return;
    this.dwellTimer = setTimeout(() => {
      if (this.blockedDwell()) return;
      const mark = this.openMarks().find(m => this.visible(m.id));
      if (!mark || this.activeId === mark.id) return;
      const focus = document.activeElement as HTMLElement;
      this.open(mark.id, { x: 0, y: 0 }); this.transient = true;
      if (focus && focus !== document.body) focus.focus({ preventScroll: true });
      (document.activeElement as HTMLElement)?.blur();
    }, 1000);
  };
  private seal(action?: string): void {
    if (!this.dialog || this.chat.hidden) return;
    const saved = this.dialog.cloneNode(true) as HTMLElement; saved.removeAttribute('data-mark-id');
    saved.querySelectorAll('button,textarea').forEach(el => el.remove());
    if (action) { const note = document.createElement('p'); note.textContent = action; saved.append(note); }
    this.conversation.append(saved); this.transient = false;
  }
  private async sendMessage(): Promise<void> {
    const text = this.message.value.trim(); if (!text || this.sending) return;
    const mark = this.activeId ? this.bridge.marks().find(m => m.id === this.activeId) ?? null : null;
    this.seal(); this.close(false);
    const entry = document.createElement('p'); entry.textContent = text; this.conversation.append(entry); this.message.value = '';
    this.messages.push({ role: 'user', content: text });
    const reply = document.createElement('p'); reply.textContent = 'Verso is thinking…'; this.conversation.append(reply);
    this.sending = true; this.message.disabled = true;
    try {
      if (!this.bridge.ask) throw new Error('Verso is not available right now.');
      const response = await this.bridge.ask(this.messages.slice(-20), mark);
      reply.textContent = response.reply; this.messages.push({ role: 'assistant', content: response.reply });
      for (const proposal of response.proposals) {
        const card = document.createElement('section'); card.className = 'pm-verso-proposal pm-chat-card';
        const author = document.createElement('strong'); author.textContent = 'VERSO';
        const quote = document.createElement(proposal.kind === 'suggestion' ? 'del' : 'blockquote'); quote.textContent = proposal.quote;
        const after = document.createElement(proposal.kind === 'suggestion' ? 'ins' : 'p'); after.textContent = proposal.kind === 'suggestion' ? proposal.replacement : proposal.text;
        const status = document.createElement('p'); status.setAttribute('role', 'status');
        const apply = this.button(proposal.kind === 'suggestion' ? 'Suggest this change' : 'Add this comment', () => {
          try {
            if (!this.bridge.propose) throw new Error('The editor is not ready.');
            this.bridge.propose(proposal); apply.disabled = true; status.textContent = 'Added to the marks for review.';
          } catch (error) { status.textContent = error instanceof Error ? error.message : 'Unable to add this mark.'; }
        });
        card.append(author, quote, after, apply, status); this.conversation.append(card);
      }
    } catch (error) { reply.textContent = error instanceof Error ? error.message : 'Verso is not available right now.'; }
    finally { this.sending = false; this.message.disabled = false; this.message.focus({ preventScroll: true }); }
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
    if (!changed && this.settled.has(id)) { this.jump(id); return; }
    const mark = current ?? (changed && this.displayedMark?.id === id ? this.displayedMark : null);
    this.cancelWalk(); this.close(false);
    if (!mark || (!changed && !isOpenReviewMark(mark))) return;
    this.displayedMark = structuredClone(mark);
    this.displayedSignature = this.markSignature(current);
    this.refreshPending = changed;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : this.toggle;
    if (!point) {
      this.jump(id);
      const rect = document.querySelector(`.ProseMirror [data-mark-id="${CSS.escape(id)}"]`)?.getBoundingClientRect();
      point = { x: rect?.left ?? 24, y: rect?.bottom ?? 120 };
    }
    this.activeId = id;
    if (innerWidth < 1024) { this.panel.hidden = true; this.layout(); }
    const dialog = document.createElement('div'); this.dialog = dialog;
    dialog.className = this.chat.hidden ? 'pm-review-dialog' : 'pm-chat-card'; dialog.dataset.markId = id;
    dialog.setAttribute('role', this.chat.hidden ? 'dialog' : 'group'); dialog.setAttribute('aria-labelledby', 'pm-review-title'); dialog.tabIndex = -1;
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
      const button = this.button(`${label} (${key.toUpperCase()})`, action, unavailable && key !== 'l'); button.dataset.reviewKey = key;
      if (!this.chat.hidden) { const at = label.toLowerCase().indexOf(key); if (at >= 0) { const u = document.createElement('u'); u.textContent = label[at]; button.replaceChildren(label.slice(0, at), u, `${label.slice(at + 1)} (${key.toUpperCase()})`); } }
      if (action && (label === 'Accept' || label === 'Resolve')) button.dataset.defaultChoice = 'true'; actions.append(button);
    };
    if (mark.kind !== 'comment') {
      add('Accept', 'a', () => this.perform([id], 'accept'));
      add('Reject', 'r', () => this.perform([id], 'reject'));
    }
    if (mark.kind === 'comment') add('Resolve', this.chat.hidden ? 'e' : 'r', () => this.perform([id], 'resolve'));
    add('Reply', this.chat.hidden ? 'c' : (mark.kind === 'comment' ? 'e' : 'e'), () => this.composeReply(id));
    add('Later', 'l', () => this.later(id));
    const question = document.createElement('p'); question.textContent = mark.kind === 'comment' ? 'Resolve it?' : 'Accept it?';
    dialog.append(question, actions);
    if (this.chat.hidden) { document.body.append(dialog); this.position(point.x, point.y); }
    else this.slot.replaceChildren(dialog);
    this.highlight(); this.update();
    header.onpointerdown = event => {
      if ((event.target as Element).closest('button') || innerWidth <= 480) return;
      event.preventDefault(); header.setPointerCapture(event.pointerId);
      const rect = dialog.getBoundingClientRect(); const dx = event.clientX - rect.left, dy = event.clientY - rect.top;
      header.onpointermove = move => this.position(move.clientX - dx, move.clientY - dy);
      header.onpointerup = () => { header.onpointermove = null; };
    };
    if (!this.transient) actions.querySelector('button')?.focus({ preventScroll: true });
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
      this.deciding = true;
      try { this.bridge.decide(ids, action, text); } finally { this.deciding = false; }
      this.seal(({ accept: 'Accepted', reject: 'Rejected', resolve: 'Resolved', reply: 'Replied' })[action]);
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
  private later(id: string): void { const order = this.openMarks().map(mark => mark.id); this.seal('Later'); this.close(); this.advance(order, id); }
  private advance(order: string[], id: string): void {
    this.cancelWalk(); if (!this.walk) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (getReviewStyle() !== 'playmaker' || (document.activeElement as HTMLElement)?.isContentEditable) return;
      const open = this.openMarks(); const index = order.indexOf(id);
      const next = [...order.slice(index + 1), ...order.slice(0, index)].find(candidate => open.some(mark => mark.id === candidate));
      if (next) this.open(next);
    }, 950);
  }
  private cancelWalk(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private close(restoreFocus = true): void {
    this.dialog?.remove(); this.dialog = null; this.activeId = null; this.transient = false; this.highlight();
    if (restoreFocus) {
      // Keep decision undo outside the text; a click on the page resumes editing.
      const target = this.returnFocus?.isConnected && !this.returnFocus.isContentEditable ? this.returnFocus : this.toggle;
      target.focus({ preventScroll: true });
    }
  }
  private keydown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement;
    if (getReviewStyle() === 'playmaker' && event.key === 'Escape' && !document.querySelector('[role="menu"],dialog[open]')) {
      event.preventDefault(); event.stopImmediatePropagation(); this.cancelWalk();
      if (this.dialog?.classList.contains('pm-review-dialog')) this.close();
      else if (this.panel.contains(target) || this.chat.hidden) this.setPanel('marks', false);
      else this.setPanel('chat', false);
      return;
    }
    if (['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', ' '].includes(event.key)) this.readerScrolled(event);
    const typing = target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && (!['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || (target === this.message && !this.message.value))) {
      event.preventDefault(); event.stopImmediatePropagation(); this.cancelWalk(); this.close(!typing);
      try { this.historyMessage = ''; this.bridge.history(event.shiftKey); this.update(); } catch (error) {
        this.historyMessage = error instanceof Error ? error.message : 'Unable to restore decision.';
        this.update();
      }
      return;
    }
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
