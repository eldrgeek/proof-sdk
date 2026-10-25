/** Only open items beside the folded document (Mike, 2026-09-24, yfbqrau4).
 * Mike, 2026-09-23 (usability brief). Existing selectors keep their machine names.
 */
import { issuesPillTitle } from '../shared/layout-chrome';
import { NAVIGATOR_POLICY, reviewListKey, reviewItemHint, needsYouLabel, type NavigatorTab } from '../shared/layout-panels';
import { isWriting, isInputComposing, letterShortcutsEnabled } from '../editor/editing-guard';
import { REVIEW_LIST_POLICY, reviewCountLabel, reconcileReview, emptyReviewSession,
  clearCompleted, nextReviewRow, anchoredReviewScroll, type ReviewScope } from '../shared/review-list';
import type { LineMarksUI } from './line-marks';
import { convertedDiscussionFor, convertedRowLabel } from '../shared/typed-discussion';
import { PILE_FILTER_POLICY, type PileFilter } from '../shared/dispositions';

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
  /** Multi-party Accords: this reader's piles as mark ids, or null when the Accord is not multi-party. */
  piles?(): Record<PileFilter, string[]> | null;
  /** Multi-party Accords: send these proposals back to this reader's draft. */
  toDraft?(markIds: string[]): void;
  /** Multi-party Accords: "In accord: Mike, claude · Cut: gemini" for a row's changes, or null. */
  stance?(markIds: readonly string[]): string | null;
  /** Multi-party Accords: the reader is an Owner and may overrule. */
  canOverrule?(): boolean;
  /** The Owner's special act: settle these changes now; the disagreement is recorded. */
  overrule?(markIds: string[], outcome: 'common' | 'commonly-cut'): void;
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
  private get session() { return this.sessions[this.pile ? 'all-open' : this.scope]; }
  /** The rows the list shows: every row, or only the open changes in the pile the reader chose. */
  private visibleRows() {
    const ids = this.pile ? this.host.piles?.()?.[this.pile] : null;
    if (!ids) return this.session.rows;
    const wanted = new Set(ids);
    return this.session.rows.filter(row => !row.done && (row.markIds ?? []).some(id => wanted.has(id)));
  }
  private scope: ReviewScope = REVIEW_LIST_POLICY.defaultScope;
  private readonly scopeTools = el('div', 'anv-review-tools');
  private readonly pileTools = el('div', 'anv-pile-tools');
  private readonly ownerTools = el('div', 'anv-owner-tools');
  private readonly overruleAccept = el('button', 'anv-overrule', 'Overrule: put in the Accord');
  private readonly overruleCut = el('button', 'anv-overrule', 'Overrule: cut');
  private pile: PileFilter | null = PILE_FILTER_POLICY.defaultFilter;
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
        if (this.scope === spec.id && !this.pile) return;
        this.scope = spec.id;
        this.pile = null;
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
    this.pileTools.setAttribute('role', 'group');
    this.pileTools.setAttribute('aria-label', 'Your piles');
    this.pileTools.dataset.accordPiles = '';
    this.pileTools.hidden = true;
    for (const spec of PILE_FILTER_POLICY.filters) {
      const button = el('button', 'anv-pile');
      button.type = 'button';
      button.dataset.accordPile = spec.id;
      button.dataset.label = spec.label;
      // A second press on the chosen pile shows everything again.
      button.onclick = () => { this.pile = this.pile === spec.id ? null : spec.id; this.render(); };
      this.pileTools.append(button);
    }
    this.detailEl.setAttribute('aria-label', 'Selected passage discussion and proposals');
    this.ownerTools.setAttribute('role', 'group');
    this.ownerTools.setAttribute('aria-label', 'Owner');
    this.ownerTools.dataset.accordOwnerTools = '';
    this.ownerTools.hidden = true;
    for (const [button, outcome] of [[this.overruleAccept, 'common'], [this.overruleCut, 'commonly-cut']] as const) {
      button.type = 'button';
      button.dataset.accordOverrule = outcome;
      button.title = 'The Owner decides now; everyone who disagreed is recorded with the decision.';
      button.onclick = () => {
        const ids = this.overruleTargets();
        if (!ids.length) { this.keyHint.textContent = 'Select a change first.'; return; }
        this.host.overrule?.(ids, outcome);
      };
      this.ownerTools.append(button);
    }
    this.panes.issues.append(this.pileTools, this.scopeTools, this.ownerTools, this.keyHint, this.detailEl, this.issuesEmpty, this.issuesList);
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

  /**
   * What the Owner's overrule would settle on the selected row: its changes where we differ, or its
   * one change when the row has exactly one. A line with several changes and no single disagreement
   * offers no overrule, so one press never settles more than the Owner meant.
   */
  private overruleTargets(): string[] {
    const piles = this.host.piles?.();
    if (!piles) return [];
    const row = this.sessions['all-open'].rows.find(r => r.key === this.selectedKey && !r.done)
      ?? this.session.rows.find(r => r.key === this.selectedKey && !r.done);
    const ids = [...new Set(row?.markIds ?? [])];
    const open = new Set([...piles.draft, ...piles.accord, ...piles['cutting-room'], ...piles.differ]);
    const proposals = ids.filter(id => open.has(id));
    const differ = proposals.filter(id => piles.differ.includes(id));
    if (differ.length) return differ;
    return proposals.length === 1 ? proposals : [];
  }

  /**
   * U on a line: the changes on it that this reader promoted or cut go back to their draft. They are
   * no longer in Needs you, so this reads All open, and only the reader's own decided changes move.
   */
  toDraftAtLine(line: number): boolean {
    this.render();
    const piles = this.host.piles?.();
    if (!piles || !this.host.toDraft) { this.keyHint.textContent = 'U changes your mind on a multi-party Accord; this one decides by accept and reject.'; return false; }
    const decided = new Set([...piles.accord, ...piles['cutting-room']]);
    const ids = this.sessions['all-open'].rows
      .filter(row => row.line === line && !row.done)
      .flatMap(row => row.markIds ?? [])
      .filter(id => decided.has(id));
    if (!ids.length) { this.keyHint.textContent = 'Nothing on this line is in your accord or your cutting room.'; return false; }
    this.keyHint.textContent = '';
    this.host.toDraft([...new Set(ids)]);
    return true;
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
      const rows = this.visibleRows();
      const at = rows.findIndex(row => row.key === this.selectedKey);
      const candidates = action === 'next' ? rows.slice(at + 1) : (at < 0 ? rows : rows.slice(0, at)).slice().reverse();
      const next = candidates.find(row => !row.done && row.line >= 0);
      if (next) this.selectLine(next.line);
      return;
    }
    if (!selected || selected.line < 0) { this.keyHint.textContent = 'Select an open item with J or K.'; return; }
    if (action === 'document') { this.host.focusDocument(selected.line); return; }
    if (action === 'draft') { this.toDraftAtLine(selected.line); return; }
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
    this.count.title = issuesPillTitle(views['needs-you'].count, views['all-open'].count);
    this.count.dataset.viewerCount = String(views['needs-you'].count);
    this.count.dataset.teamCount = String(views['all-open'].count);
    this.reviewButton.setAttribute('aria-label', `Review (${label})`);
    this.badge.textContent = label;
    this.buttons.get('issues')?.setAttribute('aria-label', `Review (${label})`);
    for (const button of this.scopeTools.querySelectorAll<HTMLElement>('[data-accord-review-scope]')) {
      button.setAttribute('aria-pressed', String(!this.pile && button.dataset.accordReviewScope === this.scope));
    }
    const piles = this.host.piles?.() ?? null;
    if (!piles) this.pile = null;
    // The Owner's overrule shows once a change is selected (a special act, never the default path).
    this.ownerTools.hidden = !(piles && this.host.canOverrule?.() && this.overruleTargets().length > 0);
    this.pileTools.hidden = !piles;
    for (const button of this.pileTools.querySelectorAll<HTMLElement>('[data-accord-pile]')) {
      const id = button.dataset.accordPile as PileFilter;
      const n = piles?.[id].length ?? 0;
      const text = `${button.dataset.label} ${n}`;
      if (button.textContent !== text) button.textContent = text;
      button.setAttribute('aria-pressed', String(this.pile === id));
    }
    if (lm.isLoaded()) for (const scope of ['needs-you', 'all-open'] as const) {
      const session = reconcileReview(this.sessions[scope], views[scope], lm.lineList());
      this.sessions[scope] = this.panelOpen ? session : clearCompleted(session);
    }
    this.nextBtn.disabled = open.count === 0 && !this.session.rows.some(row => row.done);
    this.clearSettledBtn.disabled = !this.session.rows.some(row => row.done);
    const pileLabel = PILE_FILTER_POLICY.filters.find(f => f.id === this.pile)?.label;
    this.issuesEmpty.textContent = pileLabel ? `Nothing in ${pileLabel === 'Where we differ' ? 'where we differ' : `your ${pileLabel.replace(/^My /, '').toLowerCase()}`}.` : 'Nothing is open.';
    this.issuesEmpty.hidden = this.visibleRows().length > 0 || !lm.isLoaded();
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
    const used = new Set<Element>();
    this.visibleRows().forEach((row, index) => {
      const li = existing.get(row.key) ?? el('li');
      li.dataset.key = row.key;
      existing.delete(row.key);
      used.add(li);
      const b = li.querySelector<HTMLButtonElement>('button') ?? el('button', 'anv-issue');
      b.type = 'button';
      b.dataset.line = String(row.line);
      b.dataset.kind = row.kinds[0] ?? 'changed';
      b.dataset.settled = String(row.done);
      b.dataset.new = String(row.fresh);
      if (row.line === cursor) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
      const title = row.text.length > NAVIGATOR_POLICY.titleChars ? `${row.text.slice(0, NAVIGATOR_POLICY.titleChars - 1)}…` : row.text;
      // A row whose passage is gone may be words that became a discussion (step 4): say so (ac-tvq).
      const discussion = row.done && row.line < 0 ? convertedDiscussionFor(row.markIds, lm.allThreads()) : null;
      const label = row.done ? (discussion ? convertedRowLabel(discussion.lineIndex) : row.line < 0 ? 'Done · passage removed' : `Done · line ${row.line + 1}`)
        : `${row.fresh ? 'New · ' : ''}${needsYouLabel(this.scope === 'all-open' ? { ...row, count: 1 } : row, actor => lm.displayName(actor), lm.me())}`;
      const stance = row.done ? null : this.host.stance?.(row.markIds ?? []) ?? null;
      if (b.dataset.label !== title + label + (stance ?? '')) {
        const dot = el('span', 'anv-dot'); dot.setAttribute('aria-hidden', 'true');
        const body = el('span', 'anv-issue-body');
        body.append(el('span', 'anv-issue-title', title), el('small', 'anv-issue-kind', label));
        if (stance) { const s = el('small', 'anv-issue-stance', stance); s.dataset.accordStance = ''; body.append(s); }
        b.replaceChildren(dot, body);
        b.dataset.label = title + label + (stance ?? '');
      }
      b.onclick = () => {
        this.keyHint.textContent = '';
        if (row.line >= 0) this.selectLine(row.line);
        else if (discussion && discussion.lineIndex !== null) this.selectLine(discussion.lineIndex);
      };
      if (b.parentElement !== li) li.append(b);
      // Inserting above a focused button preserves that button's DOM node.
      const at = this.issuesList.children[index];
      if (at !== li) this.issuesList.insertBefore(li, at ?? null);
    });
    // Remove every row this render did not place, not only the ones the key map still holds: a
    // duplicated key kept extra rows out of the map, and they piled up (step 4 review, 2026-09-25).
    for (const node of [...this.issuesList.children]) if (!used.has(node)) node.remove();
    if (anchor?.isConnected && before !== undefined) pane.scrollTop = anchoredReviewScroll(scroll, before, anchor.getBoundingClientRect().top);
    // Moving a node can blur it in older browsers; restore only the exact existing control.
    if (active instanceof HTMLElement && active.isConnected && document.activeElement !== active) active.focus({ preventScroll: true });
  }

  debugState(): Record<string, unknown> {
    return {
      tab: this.tab,
      issues: [...this.issuesList.querySelectorAll<HTMLElement>('.anv-issue')].map(b => ({ line: Number(b.dataset.line), kind: b.dataset.kind, settled: b.dataset.settled === 'true', label: b.querySelector('.anv-issue-kind')?.textContent ?? '' })),
      scope: this.scope,
      pile: this.pile,
      settled: this.session.rows.filter(row => row.done).map(row => row.line),
    };
  }
}
