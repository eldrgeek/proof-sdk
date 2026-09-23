/**
 * Accord layout stage 3 — the Navigator (Ren's proposal, decision 7): the left side, three tabs of
 * whole-document lists.
 *   - Outline: the headings, each with its fold chip (▾ / ▸ and the section's Issues) and the
 *     fold controls (Fold all, Unfold all, H1 / H2, Unfold closed, decision / context).
 *   - Issues: the viewer's own Issues, one row per line (title, kind, line). The same lines as the
 *     amber dots and the Issues pill. A row moves the cursor there.
 *   - Since you: what changed since the viewer last marked (the reading walk's Since-you list).
 * The documents list moved to File › Open (stage 2), so the Navigator carries no documents.
 *
 * Authorship: Mike Wolf (rulings), Ren (SOMA UI, the proposal), built by Claude Opus 5 (worker
 * accord-layout3), 2026-09-21.
 */
import { NAVIGATOR_POLICY, needsYouLabel, outlineRows, type NavigatorTab } from '../shared/layout-panels';
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
  private readonly settled = new Map<number, { kinds: string[]; label: string }>();
  private tracked = new Set<number>();
  private readonly settledTools = el('div', 'anv-settled-tools');
  private readonly settledLabel = el('span', 'anv-settled-count');
  private readonly clearSettledBtn = el('button', 'anv-clear-settled', 'Clear settled');
  private readonly issuesEmpty = el('p', 'prw-empty anv-empty', 'Nothing needs you.');
  private readonly sinceEmpty = el('p', 'prw-empty anv-empty', 'Nothing yet: this list fills in once you have marked lines and others change them.');
  private readonly buttons = new Map<NavigatorTab, HTMLButtonElement>();
  private readonly badge = el('span', 'anv-badge');
  private tab: NavigatorTab;
  private outlineSig = '';
  private issuesSig = '';
  /** The last row drawn for each line, so a settled row keeps the words it had. */
  private lastRows = new Map<number, { kinds: string[]; label: string }>();

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
    this.applyTab();
  }

  current(): NavigatorTab { return this.tab; }

  select(tab: NavigatorTab, remember = true): void {
    if (tab === this.tab) return;
    // Leaving the Issues tab is the other way a settled row goes (OPEN_VIEW_POLICY.keepSettled).
    if (this.tab === 'issues') { this.settled.clear(); this.tracked.clear(); }
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
    if (this.tab === 'outline') this.renderOutline();
  }

  private renderIssues(items: ReturnType<LineMarksUI['needsYouItems']>): void {
    const lm = this.host.lineMarks();
    const lines = lm.lineList();
    const cursor = this.host.cursor();
    // A line that was on this list and is not any more has SETTLED: remember it, in place.
    if (lm.isLoaded()) {
      const now = new Set(items.map(item => item.line));
      for (const line of this.tracked) {
        if (now.has(line) || this.settled.has(line)) continue;
        const was = this.lastRows.get(line);
        this.settled.set(line, was ?? { kinds: ['changed'], label: 'Settled' });
      }
      for (const line of now) this.settled.delete(line);
      this.tracked = now;
      this.lastRows = new Map(items.map(item => [item.line, { kinds: item.kinds as string[], label: needsYouLabel(item, actor => lm.displayName(actor), lm.me()) }]));
    }
    const settledLines = [...this.settled.keys()];
    const rows = [
      ...items.map(item => ({ line: item.line, settled: false, kinds: item.kinds as string[], label: needsYouLabel(item, actor => lm.displayName(actor), lm.me()) })),
      ...settledLines.map(line => ({ line, settled: true, kinds: this.settled.get(line)!.kinds, label: this.settled.get(line)!.label })),
    ].sort((a, b) => a.line - b.line);
    const sig = JSON.stringify([rows.map(r => [r.line, r.settled, r.kinds, r.label, lines[r.line]?.hash]), cursor]);
    if (sig === this.issuesSig) return;
    this.issuesSig = sig;
    this.issuesEmpty.hidden = rows.length > 0 || !lm.isLoaded();
    const n = this.settled.size;
    this.settledTools.hidden = n === 0;
    this.settledLabel.textContent = n ? `${n} settled ${n === 1 ? 'row' : 'rows'}` : '';
    this.issuesList.replaceChildren();
    for (const row of rows) {
      const li = el('li');
      const b = el('button', 'anv-issue');
      b.type = 'button';
      b.dataset.line = String(row.line);
      b.dataset.kind = row.kinds[0] ?? 'changed';
      if (row.settled) b.dataset.settled = 'true';
      if (row.line === cursor) b.setAttribute('aria-current', 'true');
      const dot = el('span', 'anv-dot');
      dot.setAttribute('aria-hidden', 'true');
      const text = lines[row.line]?.text ?? '';
      const title = text.length > NAVIGATOR_POLICY.titleChars ? `${text.slice(0, NAVIGATOR_POLICY.titleChars - 1)}…` : text;
      const body = el('span', 'anv-issue-body');
      body.append(
        el('span', 'anv-issue-title', title || `Line ${row.line + 1}`),
        el('small', 'anv-issue-kind', row.settled ? `Settled · line ${row.line + 1}` : row.label),
      );
      b.append(dot, body);
      b.onclick = () => this.host.go(row.line);
      li.append(b);
      this.issuesList.append(li);
    }
  }

  private renderOutline(): void {
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
    if (sig === this.outlineSig) return;
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
      settled: [...this.settled.keys()].sort((a, b) => a - b),
      outline: [...this.outlineList.querySelectorAll<HTMLElement>('.anv-row')].map(r => ({ heading: Number(r.dataset.heading), folded: r.querySelector<HTMLElement>('.anv-fold')?.dataset.folded === 'true' })),
    };
  }
}
