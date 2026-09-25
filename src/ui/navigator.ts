/** Only open items beside the folded document (Mike, 2026-09-24, yfbqrau4).
 * Mike, 2026-09-23 (usability brief). Existing selectors keep their machine names.
 */
import { NAVIGATOR_POLICY, reviewListKey, reviewItemHint, needsYouLabel, type NavigatorTab } from '../shared/layout-panels';
import { isWriting, isInputComposing, letterShortcutsEnabled } from '../editor/editing-guard';
import { REVIEW_LIST_POLICY, reviewCountLabel, reconcileReview, emptyReviewSession,
  clearCompleted, nextReviewRow, anchoredReviewScroll, type ReviewScope } from '../shared/review-list';
import type { LineMarksUI } from './line-marks';

export interface NavigatorHost {
  lineMarks(): LineMarksUI;
  /** The one cursor's line. */
  cursor(): number;
  /** Moves the cursor to a line (a jump; shows only that item and its path). */
  go(index: number): void;
  /** The tab changed (the host remembers it). */
  tabChanged(tab: NavigatorTab): void;
  toggle?(): void;
  decide(line: number, action: 'accept' | 'reject'): void;
  focusDocument(line: number): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class NavigatorUI {
  readonly tabsEl = el('div', 'anv-tabs');
  readonly panes: Record<NavigatorTab, HTMLElement> = {
    issues: el('div', 'anv-pane prw-rail-body'),
  };
  /** Selected open item cards remain beside the list. */
  readonly detailEl = el('section', 'anv-detail');
  private readonly issuesList = el('ul', 'anv-issues');
  private sessions = { 'needs-you': emptyReviewSession(), 'all-open': emptyReviewSession() };
  private get session() { return this.sessions[this.scope]; }
  private scope: ReviewScope = REVIEW_LIST_POLICY.defaultScope;
  private readonly scopeTools = el('div', 'anv-review-tools');
  private readonly clearSettledBtn = el('button', 'anv-clear-settled', 'Clear completed');
  private readonly nextBtn = el('button', 'anv-next', 'Next');
  private readonly issuesEmpty = el('p', 'prw-empty anv-empty');
  private readonly buttons = new Map<NavigatorTab, HTMLButtonElement>();
  private readonly badge = el('span', 'anv-badge');
  readonly reviewButton = el('button', 'plm-issues anv-review-toggle');
  private readonly count = el('span', 'plm-issues-count');
  private tab: NavigatorTab;
  private reader = '';
  private panelOpen = false;
  private selectedKey: string | null = null;
  private readonly keyHint = el('p', 'anv-key-hint');

  constructor(private readonly host: NavigatorHost, initial: NavigatorTab | undefined) {
    this.tab = initial ?? NAVIGATOR_POLICY.defaultTab;
    this.tabsEl.setAttribute('role', 'tablist');
    this.tabsEl.setAttribute('aria-label', 'Review panel');
    for (const spec of NAVIGATOR_POLICY.tabs) {
      const b = el('button', 'anv-tab', spec.label);
      b.type = 'button';
      b.id = `anv-tab-${spec.id}`;
      b.dataset.tab = spec.id;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', `anv-pane-${spec.id}`);
      if (spec.id === 'issues') { this.badge.setAttribute('aria-hidden', 'true'); b.append(this.badge); }
      b.onclick = () => this.select(spec.id);
      this.buttons.set(spec.id, b);
      this.tabsEl.append(b);
      const pane = this.panes[spec.id];
      pane.id = `anv-pane-${spec.id}`;
      pane.dataset.tab = spec.id;
      pane.setAttribute('role', 'tabpanel');
      pane.setAttribute('aria-labelledby', b.id);
    }
    this.issuesList.setAttribute('aria-label', 'Review items');
    this.issuesList.dataset.accordReviewList = '';
    this.issuesList.tabIndex = 0;
    this.issuesList.addEventListener('keydown', this.onListKey);
    this.keyHint.setAttribute('role', 'status');
    this.keyHint.setAttribute('aria-live', 'polite');
    this.reviewButton.type = 'button';
    this.reviewButton.dataset.accordReviewToggle = '';
    this.reviewButton.setAttribute('aria-controls', 'anv-panel');
    this.count.setAttribute('role', 'status');
    this.count.setAttribute('aria-live', 'polite');
    this.reviewButton.append('Review ', this.count);
    this.reviewButton.onclick = () => this.host.toggle?.();
    for (const spec of REVIEW_LIST_POLICY.scopes) {
      const button = el('button', 'anv-scope', spec.label);
      button.type = 'button';
      button.dataset.accordReviewScope = spec.id;
      button.onclick = () => {
        if (this.scope === spec.id) return;
        this.scope = spec.id;
        this.render();
      };
      this.scopeTools.append(button);
    }
    this.clearSettledBtn.type = 'button';
    this.clearSettledBtn.dataset.accordReviewClearCompleted = '';
    this.clearSettledBtn.onclick = () => { this.clearDone(); this.render(); };
    this.nextBtn.type = 'button';
    this.nextBtn.onclick = () => this.next();
    this.scopeTools.append(this.nextBtn, this.clearSettledBtn);
    this.detailEl.setAttribute('aria-label', 'Selected passage discussion and proposals');
    this.panes.issues.append(this.scopeTools, this.keyHint, this.detailEl, this.issuesEmpty, this.issuesList);
    this.applyTab();
  }

  current(): NavigatorTab { return this.tab; }

  select(tab: NavigatorTab, remember = true): void {
    if (tab === this.tab) return;
    this.tab = tab;
    this.applyTab();
    if (remember) this.host.tabChanged(tab);
    this.render(true);
  }

  private applyTab(): void {
    for (const [id, b] of this.buttons) {
      const on = id === this.tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      this.panes[id].hidden = !on;
    }
  }

  resetSession(): void { this.sessions = { 'needs-you': emptyReviewSession(), 'all-open': emptyReviewSession() }; }

  setPanelOpen(open: boolean): void {
    if (!open) {
      this.clearDone();
      if (this.tabsEl.closest('.prw-right')?.contains(document.activeElement)) this.reviewButton.focus({ preventScroll: true });
    }
    this.panelOpen = open;
    this.reviewButton.setAttribute('aria-expanded', String(open));
    this.render();
  }

  private clearDone(): void {
    for (const scope of ['needs-you', 'all-open'] as const) this.sessions[scope] = clearCompleted(this.sessions[scope]);
  }

  /** A selected row keeps the keyboard even when the document scrolls or the row settles. */
  selectLine(line: number): void {
    this.render();
    const row = this.session.rows.find(row => row.line === line && !row.done)
      ?? this.session.rows.find(row => row.line === line);
    if (!row) { this.issuesList.focus({ preventScroll: true }); return; }
    this.selectedKey = row.key;
    row.fresh = false;
    this.host.go(row.line);
    this.render();
    this.focusSelected();
  }

  /** A or Delete pressed in the document, on the line J and K reached (Mike, 2026-09-25: "I can
   * navigate using J/K but I can't accept without moving my mouse to the sidebar and clicking").
   * The list's own rules apply: a hint for anything that is not a proposal, and no advance after,
   * so the reader can go on to change the text just decided. The keyboard stays in the document. */
  decideAtLine(line: number, action: 'accept' | 'reject'): boolean {
    this.render();
    const open = this.session.rows.filter(row => row.line === line && !row.done);
    const row = open.find(candidate => candidate.key === this.selectedKey) ?? open[0];
    if (!row) { this.keyHint.textContent = 'Nothing is open on this line. Move to an open item with J or K.'; return false; }
    this.selectedKey = row.key;
    const hint = reviewItemHint(row.kinds[0]);
    this.keyHint.textContent = hint ?? '';
    if (!hint) this.host.decide(row.line, action);
    this.render();
    return !hint;
  }

  private focusSelected(): void {
    const li = [...this.issuesList.children].find(node => (node as HTMLElement).dataset.key === this.selectedKey);
    const button = li?.querySelector('button');
    (button ?? this.issuesList).focus({ preventScroll: true });
    button?.scrollIntoView({ block: 'nearest' });
  }

  private onListKey = (event: KeyboardEvent): void => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const active = document.activeElement;
    const typing = (node: Element | null) => Boolean(node?.closest('input, textarea, select, .accord-draft, .ProseMirror, [contenteditable="true"]'));
    const action = reviewListKey({ ...event, key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
      altKey: event.altKey, isComposing: event.isComposing || event.keyCode === 229 || isInputComposing(),
      listFocused: this.issuesList.contains(active) && this.issuesList.contains(target),
      typing: isWriting() || typing(target) || typing(active), letterShortcuts: letterShortcutsEnabled() });
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    this.render(); // Re-check current pending state, including any just-arrived remote decision.
    const focused = target?.closest('li[data-key]') as HTMLElement | null;
    if (focused) this.selectedKey = focused.dataset.key ?? null;
    const selected = this.session.rows.find(row => row.key === this.selectedKey);
    if (action === 'next' || action === 'previous') {
      const rows = this.session.rows;
      const at = rows.findIndex(row => row.key === this.selectedKey);
      const candidates = action === 'next' ? rows.slice(at + 1) : (at < 0 ? rows : rows.slice(0, at)).slice().reverse();
      const next = candidates.find(row => !row.done && row.line >= 0);
      if (next) this.selectLine(next.line);
      return;
    }
    if (!selected || selected.line < 0) { this.keyHint.textContent = 'Select an open item with J or K.'; return; }
    if (action === 'document') { this.host.focusDocument(selected.line); return; }
    if (selected.done) { this.keyHint.textContent = 'This item is done. Select an open item with J or K.'; return; }
    const hint = reviewItemHint(selected.kinds[0]);
    this.keyHint.textContent = hint ?? '';
    if (hint) return;
    this.host.decide(selected.line, action);
    this.render();
    // Do not advance automatically: completed rows stay until the reader chooses to move.
    this.focusSelected();
  };

  next(): void {
    const next = nextReviewRow(this.session, this.host.cursor());
    this.clearDone();
    if (next && this.host.lineMarks().visitReviewItem(next.key, next.line)) this.selectLine(next.line);
    this.render();
  }

  render(_force = false): void {
    const lm = this.host.lineMarks();
    if (this.reader !== lm.me()) { this.reader = lm.me(); this.sessions = { 'needs-you': emptyReviewSession(), 'all-open': emptyReviewSession() }; }
    const views = lm.reviewViews();
    const open = views[this.scope];
    const label = reviewCountLabel(this.scope, open.count);
    this.count.textContent = label;
    this.count.title = `${views['needs-you'].count} need you; ${views['all-open'].count} open for the team.`;
    this.count.dataset.viewerCount = String(views['needs-you'].count);
    this.count.dataset.teamCount = String(views['all-open'].count);
    this.reviewButton.setAttribute('aria-label', `Review (${label})`);
    this.badge.textContent = label;
    this.buttons.get('issues')?.setAttribute('aria-label', `Review (${label})`);
    for (const button of this.scopeTools.querySelectorAll<HTMLElement>('[data-accord-review-scope]')) {
      button.setAttribute('aria-pressed', String(button.dataset.accordReviewScope === this.scope));
    }
    if (lm.isLoaded()) for (const scope of ['needs-you', 'all-open'] as const) {
      const session = reconcileReview(this.sessions[scope], views[scope], lm.lineList());
      this.sessions[scope] = this.panelOpen ? session : clearCompleted(session);
    }
    this.nextBtn.disabled = open.count === 0 && !this.session.rows.some(row => row.done);
    this.clearSettledBtn.disabled = !this.session.rows.some(row => row.done);
    this.issuesEmpty.textContent = this.scope === 'needs-you' ? 'Nothing needs you.' : 'Nothing is open.';
    this.issuesEmpty.hidden = this.session.rows.length > 0 || !lm.isLoaded();
    this.renderIssues();
  }

  /** Keep the selected row in place when its detail receives a remote update above the list. */
  holdDetailAnchor(): () => void {
    const pane = this.panes.issues;
    const anchor = this.issuesList.querySelector<HTMLElement>(`[data-line="${this.host.cursor()}"]`);
    if (!this.panelOpen || this.tab !== 'issues' || !anchor) return () => {};
    const before = anchor.getBoundingClientRect().top;
    return () => {
      if (anchor.isConnected) pane.scrollTop = anchoredReviewScroll(pane.scrollTop, before, anchor.getBoundingClientRect().top);
    };
  }

  private renderIssues(): void {
    const lm = this.host.lineMarks();
    const cursor = this.host.cursor();
    const pane = this.panes.issues;
    const active = document.activeElement;
    const anchor = this.issuesList.querySelector<HTMLElement>(`[data-line="${cursor}"]`)
      ?? (active instanceof HTMLElement && this.issuesList.contains(active) ? active : null);
    const before = anchor?.getBoundingClientRect().top;
    const scroll = pane.scrollTop;
    // Reserve room below short lists so an insertion above can still be compensated.
    this.issuesList.style.paddingBottom = `${pane.clientHeight}px`;
    const existing = new Map([...this.issuesList.children].map(node => [(node as HTMLElement).dataset.key, node as HTMLElement]));
    this.session.rows.forEach((row, index) => {
      const li = existing.get(row.key) ?? el('li');
      li.dataset.key = row.key;
      existing.delete(row.key);
      const b = li.querySelector<HTMLButtonElement>('button') ?? el('button', 'anv-issue');
      b.type = 'button';
      b.dataset.line = String(row.line);
      b.dataset.kind = row.kinds[0] ?? 'changed';
      b.dataset.settled = String(row.done);
      b.dataset.new = String(row.fresh);
      if (row.line === cursor) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
      const title = row.text.length > NAVIGATOR_POLICY.titleChars ? `${row.text.slice(0, NAVIGATOR_POLICY.titleChars - 1)}…` : row.text;
      const label = row.done ? (row.line < 0 ? 'Done · passage removed' : `Done · line ${row.line + 1}`)
        : `${row.fresh ? 'New · ' : ''}${needsYouLabel(this.scope === 'all-open' ? { ...row, count: 1 } : row, actor => lm.displayName(actor), lm.me())}`;
      if (b.dataset.label !== title + label) {
        const dot = el('span', 'anv-dot'); dot.setAttribute('aria-hidden', 'true');
        const body = el('span', 'anv-issue-body');
        body.append(el('span', 'anv-issue-title', title), el('small', 'anv-issue-kind', label));
        b.replaceChildren(dot, body);
        b.dataset.label = title + label;
      }
      b.onclick = () => {
        this.keyHint.textContent = '';
        if (row.line >= 0) this.selectLine(row.line);
      };
      if (b.parentElement !== li) li.append(b);
      // Inserting above a focused button preserves that button's DOM node.
      const at = this.issuesList.children[index];
      if (at !== li) this.issuesList.insertBefore(li, at ?? null);
    });
    for (const node of existing.values()) node.remove();
    if (anchor?.isConnected && before !== undefined) pane.scrollTop = anchoredReviewScroll(scroll, before, anchor.getBoundingClientRect().top);
    // Moving a node can blur it in older browsers; restore only the exact existing control.
    if (active instanceof HTMLElement && active.isConnected && document.activeElement !== active) active.focus({ preventScroll: true });
  }

  debugState(): Record<string, unknown> {
    return {
      tab: this.tab,
      issues: [...this.issuesList.querySelectorAll<HTMLElement>('.anv-issue')].map(b => ({ line: Number(b.dataset.line), kind: b.dataset.kind, settled: b.dataset.settled === 'true', label: b.querySelector('.anv-issue-kind')?.textContent ?? '' })),
      scope: this.scope,
      settled: this.session.rows.filter(row => row.done).map(row => row.line),
    };
  }
}
