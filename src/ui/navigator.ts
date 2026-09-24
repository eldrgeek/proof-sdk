/**
 * Accord layout stage 3 — the Navigator (Ren's proposal, decision 7): the left side, three tabs of
 * whole-document lists.
 *   - Outline: the headings, each with its fold chip (▾ / ▸ and the section's Issues) and the
 *     fold controls (Fold all, Unfold all, H1 / H2, Unfold closed, decision / context).
 *   - Issues: the viewer's own Issues, one row per line (title, kind, line). The same lines as the
 *     amber dots and the Issues pill. A row moves the cursor there. A settled row keeps the
 *     passage's text identity from the moment it settled, so a remote insert cannot re-label it.
 *     Mike, 2026-09-23 (usability brief).
 *   - Since you: what changed since the viewer last marked (the reading walk's Since-you list).
 * The documents list moved to File › Open (stage 2), so the Navigator carries no documents.
 *
 * Authorship: Mike Wolf (rulings), Ren (SOMA UI, the proposal), built by Claude Opus 5 (worker
 * accord-layout3), 2026-09-21.
 */
import { NAVIGATOR_POLICY, stableReviewOrder, needsYouLabel, outlineRows, resolveSettledIndex, type NavigatorTab, type SettledIdentity } from '../shared/layout-panels';
import type { LineMarksUI } from './line-marks';
import type { FoldingUI } from './folding';

export interface NavigatorHost {
  lineMarks(): LineMarksUI;
  folding(): FoldingUI | null;
  /** The one cursor's line. */
  cursor(): number;
  /** Moves the cursor to a line (a jump; unfolds what hides it). */
  go(index: number): void;
  /** The tab changed (the host remembers it). */
  tabChanged(tab: NavigatorTab): void;
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
    outline: el('div', 'anv-pane prw-rail-body'),
    issues: el('div', 'anv-pane prw-rail-body'),
    since: el('div', 'anv-pane prw-rail-body'),
  };
  /** Fold all / Unfold all / level buttons and the other outline tools sit at the top of Outline. */
  readonly toolsEl = el('div', 'anv-tools');
  private readonly outlineList = el('ul', 'anv-outline');
  private readonly issuesList = el('ul', 'anv-issues');
  /**
   * Accord round 2 stage C (brief 4): nothing vanishes under the cursor. A row the viewer settles
   * greys out with a strikethrough and STAYS IN PLACE; it leaves on "Clear settled", or when they
   * leave the tab. A list that collapses as you work it makes you lose your place.
   */
  private readonly settled = new Map<string, SettledIdentity & { kinds: string[]; label: string; text: string }>();
  private tracked = new Set<string>();
  private readonly settledTools = el('div', 'anv-settled-tools');
  private readonly settledLabel = el('span', 'anv-settled-count');
  private readonly clearSettledBtn = el('button', 'anv-clear-settled', 'Clear settled');
  private readonly issuesEmpty = el('p', 'prw-empty anv-empty', 'Nothing needs you.');
  private readonly sinceEmpty = el('p', 'prw-empty anv-empty', 'Nothing yet: this list fills in once you have marked lines and others change them.');
  private readonly buttons = new Map<NavigatorTab, HTMLButtonElement>();
  private readonly badge = el('span', 'anv-badge');
  private tab: NavigatorTab;
  private outlineSig = '';
  private issueOrder: string[] = [];
  private issuesSig = '';
  /** The last row drawn for each passage, so a settled row keeps the identity it had. */
  private lastRows = new Map<string, SettledIdentity & { kinds: string[]; label: string; text: string }>();

  constructor(private readonly host: NavigatorHost, initial: NavigatorTab | undefined, sinceHost: HTMLElement) {
    this.tab = initial ?? NAVIGATOR_POLICY.defaultTab;
    this.tabsEl.setAttribute('role', 'tablist');
    this.tabsEl.setAttribute('aria-label', 'Navigator');
    for (const spec of NAVIGATOR_POLICY.tabs) {
      const b = el('button', 'anv-tab', spec.label);
      b.type = 'button';
      b.id = `anv-tab-${spec.id}`;
      b.dataset.tab = spec.id;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', `anv-pane-${spec.id}`);
      if (spec.id === 'issues') { this.badge.setAttribute('aria-hidden', 'true'); b.append(this.badge); }
      b.onclick = () => this.select(spec.id);
      b.onkeydown = (event) => this.onTabKey(event);
      this.buttons.set(spec.id, b);
      this.tabsEl.append(b);
      const pane = this.panes[spec.id];
      pane.id = `anv-pane-${spec.id}`;
      pane.dataset.tab = spec.id;
      pane.setAttribute('role', 'tabpanel');
      pane.setAttribute('aria-labelledby', b.id);
    }
    this.outlineList.setAttribute('aria-label', 'Headings');
    this.issuesList.setAttribute('aria-label', 'Lines that need you');
    this.panes.outline.append(this.toolsEl, this.outlineList);
    this.clearSettledBtn.type = 'button';
    this.clearSettledBtn.title = 'Take the settled rows out of this list. Nothing about the document changes.';
    this.clearSettledBtn.addEventListener('mousedown', event => event.preventDefault());
    this.clearSettledBtn.onclick = () => { this.settled.clear(); this.issuesSig = ''; this.render(); };
    this.settledTools.append(this.settledLabel, this.clearSettledBtn);
    this.settledTools.hidden = true;
    this.panes.issues.append(this.issuesEmpty, this.settledTools, this.issuesList);
    this.panes.since.append(this.sinceEmpty, sinceHost);
    this.outlineList.addEventListener('focusout', () => queueMicrotask(() => this.render()));
    this.issuesList.addEventListener('focusout', () => queueMicrotask(() => this.render()));
    this.applyTab();
  }

  current(): NavigatorTab { return this.tab; }

  select(tab: NavigatorTab, remember = true): void {
    if (tab === this.tab) return;
    // Leaving the Issues tab is the other way a settled row goes (OPEN_VIEW_POLICY.keepSettled).
    if (this.tab === 'issues') { this.settled.clear(); this.tracked.clear(); this.issueOrder = []; }
    this.tab = tab;
    this.applyTab();
    if (remember) this.host.tabChanged(tab);
    this.render(true);
  }

  private onTabKey(event: KeyboardEvent): void {
    const ids = NAVIGATOR_POLICY.tabs.map(t => t.id);
    const at = ids.indexOf(this.tab);
    const to = event.key === 'ArrowRight' ? ids[(at + 1) % ids.length] : event.key === 'ArrowLeft' ? ids[(at - 1 + ids.length) % ids.length] : null;
    if (!to) return;
    event.preventDefault();
    this.select(to);
    this.buttons.get(to)?.focus();
  }

  private applyTab(): void {
    for (const [id, b] of this.buttons) {
      const on = id === this.tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      this.panes[id].hidden = !on;
    }
  }

  /** Re-renders the visible lists (cheap: each list has a signature). */
  render(force = false): void {
    if (force) { this.outlineSig = ''; this.issuesSig = ''; }
    const items = this.host.lineMarks().needsYouItems();
    this.badge.textContent = items.length ? String(items.length) : '';
    this.badge.hidden = items.length === 0;
    this.buttons.get('issues')?.setAttribute('aria-label', items.length ? `Issues (${items.length} lines need you)` : 'Issues (nothing needs you)');
    const sinceShown = this.panes.since.querySelector('.prw-since:not([hidden])');
    this.sinceEmpty.hidden = Boolean(sinceShown);
    if (this.tab === 'issues') this.renderIssues(items);
    if (this.tab === 'outline') this.renderOutline(force);
  }

  private passageKey(lineIndex: number, lines: ReturnType<LineMarksUI['lineList']>): string | null {
    const passage = lines[lineIndex];
    return passage ? `${passage.hash}:${passage.occurrence}` : null;
  }

  private renderIssues(items: ReturnType<LineMarksUI['needsYouItems']>): void {
    const lm = this.host.lineMarks();
    const lines = lm.lineList();
    const cursor = this.host.cursor();
    // A passage that was on this list and is not any more has SETTLED. Its identity is the
    // hash and occurrence it had while it was open, not the index it happens to occupy now.
    if (lm.isLoaded()) {
      const now = new Set<string>();
      for (const item of items) {
        const key = this.passageKey(item.line, lines);
        if (key) now.add(key);
      }
      for (const key of this.tracked) {
        if (now.has(key) || this.settled.has(key)) continue;
        const was = this.lastRows.get(key);
        if (was) this.settled.set(key, was);
      }
      for (const key of now) this.settled.delete(key);
      this.tracked = now;
      const remembered = new Map<string, SettledIdentity & { kinds: string[]; label: string; text: string }>();
      for (const item of items) {
        const passage = lines[item.line];
        if (!passage) continue;
        remembered.set(`${passage.hash}:${passage.occurrence}`, {
          hash: passage.hash,
          occurrence: passage.occurrence,
          kinds: item.kinds as string[],
          label: needsYouLabel(item, actor => lm.displayName(actor), lm.me()),
          text: passage.text,
        });
      }
      this.lastRows = remembered;
    }
    const openRows = items.flatMap(item => {
      const passage = lines[item.line];
      if (!passage) return [];
      return [{
        key: `${passage.hash}:${passage.occurrence}`,
        line: item.line,
        settled: false,
        kinds: item.kinds as string[],
        label: needsYouLabel(item, actor => lm.displayName(actor), lm.me()),
        text: passage.text,
      }];
    });
    const settledRows = [...this.settled.values()].map(item => {
      const line = resolveSettledIndex(item, lines);
      const current = line === null ? null : lines[line];
      return {
        key: `${item.hash}:${item.occurrence}`,
        line: line ?? -1,
        settled: true,
        kinds: item.kinds,
        label: item.label,
        text: current?.text ?? item.text,
      };
    });
    const rows = [...openRows, ...settledRows];
    this.issueOrder = stableReviewOrder(this.issueOrder, rows.map(row => row.key));
    rows.sort((a, b) => this.issueOrder.indexOf(a.key) - this.issueOrder.indexOf(b.key));
    const sig = JSON.stringify([rows.map(r => [r.key, r.line, r.settled, r.kinds, r.label, r.text]), cursor]);
    const issuesFocus = document.activeElement;
    const issuesTyping = issuesFocus instanceof HTMLInputElement || issuesFocus instanceof HTMLTextAreaElement;
    if (sig === this.issuesSig || (issuesTyping && this.issuesList.contains(issuesFocus))) return;
    this.issuesSig = sig;
    this.issuesEmpty.hidden = rows.length > 0 || !lm.isLoaded();
    const n = this.settled.size;
    this.settledTools.hidden = n === 0;
    this.settledLabel.textContent = n ? `${n} settled ${n === 1 ? 'row' : 'rows'}` : '';
    const existing = new Map([...this.issuesList.children].map(node => [(node as HTMLElement).dataset.key, node as HTMLElement]));
    for (const row of rows) {
      const li = existing.get(row.key) ?? el('li');
      li.dataset.key = row.key;
      existing.delete(row.key);
      const b = li.querySelector<HTMLButtonElement>('button') ?? el('button', 'anv-issue');
      b.type = 'button';
      if (row.line >= 0) b.dataset.line = String(row.line); else delete b.dataset.line;
      b.dataset.kind = row.kinds[0] ?? 'changed';
      b.dataset.settled = String(row.settled);
      if (row.line >= 0 && row.line === cursor) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
      const dot = el('span', 'anv-dot');
      dot.setAttribute('aria-hidden', 'true');
      const title = row.text.length > NAVIGATOR_POLICY.titleChars ? `${row.text.slice(0, NAVIGATOR_POLICY.titleChars - 1)}…` : row.text;
      const body = el('span', 'anv-issue-body');
      body.append(
        el('span', 'anv-issue-title', title || (row.line >= 0 ? `Line ${row.line + 1}` : 'Removed line')),
        el('small', 'anv-issue-kind', row.settled ? (row.line >= 0 ? `Settled · line ${row.line + 1}` : 'Settled · line removed') : row.label),
      );
      b.replaceChildren(dot, body);
      b.onclick = () => { if (row.line >= 0) this.host.go(row.line); };
      if (b.parentElement !== li) li.append(b);
      if (li.parentElement !== this.issuesList) this.issuesList.append(li);
    }
    for (const node of existing.values()) node.remove();
  }

  private renderOutline(force = false): void {
    const folding = this.host.folding();
    const lm = this.host.lineMarks();
    const lines = lm.lineList();
    const sections = folding?.sectionList() ?? [];
    const cursor = this.host.cursor();
    const rows = folding ? outlineRows(sections, i => lines[i]?.text ?? '', i => folding.isFolded(i), i => folding.sectionIssues(i)) : [];
    // The section the cursor is in: the last heading at or above it.
    let here = -1;
    for (const row of rows) if (row.headingIndex <= cursor) here = row.headingIndex;
    const sig = JSON.stringify([rows, here, lm.isLoaded()]);
    const outlineFocus = document.activeElement;
    const outlineTyping = outlineFocus instanceof HTMLInputElement || outlineFocus instanceof HTMLTextAreaElement;
    if (sig === this.outlineSig || (!force && outlineTyping && this.outlineList.contains(outlineFocus))) return;
    this.outlineSig = sig;
    this.outlineList.replaceChildren();
    if (rows.length === 0) {
      this.outlineList.append(el('li', 'prw-empty anv-empty', 'No headings in this document.'));
      return;
    }
    for (const row of rows) {
      if (row.hidden) continue;
      const li = el('li', 'anv-row');
      li.dataset.heading = String(row.headingIndex);
      li.dataset.level = String(row.level);
      li.style.paddingLeft = `${8 + row.depth * NAVIGATOR_POLICY.indentPx}px`;
      if (row.headingIndex === here) li.setAttribute('aria-current', 'true');
      const chip = el('button', 'anv-fold');
      chip.type = 'button';
      chip.dataset.folded = String(row.folded);
      chip.dataset.state = !lm.isLoaded() ? 'loading' : row.issues === 0 ? 'resolved' : 'issues';
      chip.setAttribute('aria-expanded', String(!row.folded));
      chip.setAttribute('aria-label', `${row.folded ? 'Unfold' : 'Fold'} “${row.text.slice(0, 60)}”: ${row.issues === 0 ? 'no Issues' : `${row.issues} ${row.issues === 1 ? 'Issue' : 'Issues'}`}`);
      chip.append(el('span', 'anv-caret', row.folded ? '▸' : '▾'), el('span', 'anv-count', !lm.isLoaded() ? '…' : row.issues === 0 ? '✓' : String(row.issues)));
      chip.onclick = () => { folding?.toggle(row.headingIndex); this.render(true); };
      const heading = el('button', 'anv-heading', row.text || `Line ${row.headingIndex + 1}`);
      heading.type = 'button';
      heading.dataset.line = String(row.headingIndex);
      heading.onclick = () => this.host.go(row.headingIndex);
      li.append(chip, heading);
      this.outlineList.append(li);
    }
  }

  debugState(): Record<string, unknown> {
    return {
      tab: this.tab,
      issues: [...this.issuesList.querySelectorAll<HTMLElement>('.anv-issue')].map(b => ({ line: Number(b.dataset.line), kind: b.dataset.kind, settled: b.dataset.settled === 'true', label: b.querySelector('.anv-issue-kind')?.textContent ?? '' })),
      settled: [...this.settled.values()]
        .map(item => resolveSettledIndex(item, this.host.lineMarks().lineList()))
        .filter((index): index is number => index !== null)
        .sort((a, b) => a - b),
      outline: [...this.outlineList.querySelectorAll<HTMLElement>('.anv-row')].map(r => ({ heading: Number(r.dataset.heading), folded: r.querySelector<HTMLElement>('.anv-fold')?.dataset.folded === 'true' })),
    };
  }
}
