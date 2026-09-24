/**
 * Accord round 2, stage C — the Open / Accord toggle, the honest header and the zero moment.
 *
 * Mike, 2026-09-22: "Users should have a view where they see only open issues — which would be new
 * text or text or decisions about which there is not yet agreement — or else see a finished
 * document that has been agreed on."
 *
 * Two views of ONE document, never two documents:
 *   - OPEN collapses everything settled to a thin rule and leaves the unsettled material with a
 *     line of context either side (src/shared/open-view.ts openLayout). It is the same document,
 *     the same cursor and the same keys — so J / K / A / R / T / E already work in it, because
 *     the reading walk steps over hidden lines (src/shared/reading-walk.ts nextVisible). No second
 *     keymap was invented for the list; the list IS the document, filtered.
 *   - ACCORD takes the filter off and hides the chrome: no margin dots, no rail, no thread marks.
 *     It carries the honest header, which must never let the page imply the document is settled
 *     when it is not.
 *
 * Nothing moves under the reader. A row that settles while they work greys out with a strikethrough
 * and STAYS where it is; it leaves on "Clear settled", or when they leave the view.
 *
 * Authorship: Mike Wolf (rulings), built by Claude Opus 5 (worker accord-open), 2026-09-22.
 */
import {
  OPEN_VIEW_POLICY,
  ZERO_POLICY,
  accordHeader,
  emptyAccordHeader,
  openLayout,
  openView,
  zeroMoment,
  type AccordHeader,
  type AccordView,
  type OpenView,
} from '../shared/open-view';
import { FOLD_RULE_EVENT } from '../editor/plugins/fold-view';
import type { LineMarksUI } from './line-marks';
import type { FoldingUI } from './folding';
import './open-view.css';

export const OPEN_VIEW_UI_POLICY = {
  /**
   * Where the toggle lives. On desktop and on the phone it sits in the toolbar's right group,
   * immediately LEFT of the Issues pill — because the pill is the count of what Open contains, so
   * "3 Issues" and the control that shows those three read as one thing.
   */
  place: 'toolbar-right-before-pill',
  /**
   * The view a first visit opens on. Accord — but UNCHOSEN, which is the document exactly as it
   * read before this stage: the margin, the dots and the rail are all still there, with the honest
   * header added above the text. The clean read arrives only when the person presses Accord.
   */
  defaultView: 'accord' as AccordView,
  /** localStorage key prefix; the value is the chosen view for that document. */
  storagePrefix: 'proof:accord-view:',
} as const;

export interface OpenViewHost {
  lineMarks(): LineMarksUI;
  folding(): FoldingUI | null;
  slug(): string | null;
  /** Moves the cursor to a line (a jump; unfolds what hides it). */
  go(index: number): void;
  /** The view changed: the page re-renders. */
  changed(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class OpenViewUI {
  /** The toggle: the host mounts it in the toolbar, left of the Issues pill. */
  readonly toggleEl = el('div', 'aov-toggle');
  /** The honest header and the zero band: the host mounts it above the text. */
  readonly headerEl = el('div', 'aov-header');

  private readonly openBtn = el('button', 'aov-seg');
  private readonly accordBtn = el('button', 'aov-seg');
  private readonly openCount = el('span', 'aov-seg-count');
  private readonly headerText = el('p', 'aov-header-text');
  private readonly zeroText = el('p', 'aov-zero');
  private readonly emptyText = el('p', 'aov-empty');
  private readonly tools = el('div', 'aov-tools');
  private readonly settledLabel = el('span', 'aov-settled-count');
  private readonly clearBtn = el('button', 'aov-clear', 'Clear settled');

  private view: AccordView = OPEN_VIEW_UI_POLICY.defaultView;
  /** Has the person pressed Open or Accord for this document? Until they do, nothing is stripped. */
  private chosen = false;
  private loadedSlug: string | null = null;
  private started = false;
  /** Lines that were open during this visit to the Open view and are not any more. */
  private settled = new Set<number>();
  /** Lines open at the last render, so a line that settles is noticed exactly once. */
  private tracked = new Set<number>();
  /** Runs the reader expanded by clicking their rule (explicit beats automatic). */
  private expanded = new Set<number>();
  private lastOpen: OpenView = { items: [], lines: [], count: 0 };
  private lastHeader: AccordHeader = emptyAccordHeader();
  private unsubscribe: (() => void) | null = null;
  private renderSig = '';
  /** Test hook: every view change, newest last. */
  readonly changes: AccordView[] = [];

  constructor(private readonly host: OpenViewHost) {
    this.toggleEl.setAttribute('role', 'group');
    this.toggleEl.setAttribute('aria-label', 'Open or Accord');
    for (const [button, id, label, title] of [
      [this.openBtn, 'open', 'Open', 'Show only what is unsettled for you'],
      [this.accordBtn, 'accord', 'Accord', 'Show the agreed document, reading clean'],
    ] as const) {
      button.type = 'button';
      button.dataset.view = id;
      button.title = title;
      // The accessible name is the word, never "Open4": the count is decoration on the word.
      button.setAttribute('aria-label', label);
      button.append(el('span', 'aov-seg-label', label));
      button.addEventListener('mousedown', event => event.preventDefault());
      button.onclick = () => this.setView(id);
    }
    this.openCount.setAttribute('aria-hidden', 'true');
    this.openBtn.append(this.openCount);
    this.toggleEl.append(this.openBtn, this.accordBtn);

    this.headerEl.setAttribute('role', 'status');
    this.clearBtn.type = 'button';
    this.clearBtn.title = 'Take the settled rows out of this list. Nothing about the document changes.';
    this.clearBtn.addEventListener('mousedown', event => event.preventDefault());
    this.clearBtn.onclick = () => this.clearSettled();
    this.tools.append(this.settledLabel, this.clearBtn);
    this.headerEl.append(this.zeroText, this.headerText, this.emptyText, this.tools);
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.host.lineMarks().subscribe(() => this.sync());
    document.addEventListener(FOLD_RULE_EVENT, this.onRuleExpand as EventListener);
    // The toggle's home differs between the phone and the desktop bar, so a resize re-homes it.
    window.addEventListener('resize', this.onResize);
    this.sync();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.unsubscribe?.();
    document.removeEventListener(FOLD_RULE_EVENT, this.onRuleExpand as EventListener);
    window.removeEventListener('resize', this.onResize);
    document.body.classList.remove('aov-on', 'aov-in-open', 'aov-in-accord');
    this.host.folding()?.setOpenFilter(null);
    this.toggleEl.remove();
    this.headerEl.remove();
  }

  // --------------------------------------------------------------------------
  // The view
  // --------------------------------------------------------------------------

  current(): AccordView { return this.view; }

  private storageKey(): string | null {
    const slug = this.host.slug();
    return slug ? `${OPEN_VIEW_UI_POLICY.storagePrefix}${slug}` : null;
  }

  private loadView(): void {
    const slug = this.host.slug();
    if (slug === this.loadedSlug) return;
    this.loadedSlug = slug;
    const key = this.storageKey();
    let saved: string | null = null;
    try { saved = key ? localStorage.getItem(key) : null; } catch { saved = null; }
    this.view = saved === 'open' || saved === 'accord' ? saved : OPEN_VIEW_UI_POLICY.defaultView;
    this.chosen = saved === 'open' || saved === 'accord';
    this.settled.clear();
    this.tracked.clear();
    this.expanded.clear();
  }

  setView(view: AccordView): void {
    if (view === this.view && this.chosen) return;
    this.view = view;
    this.chosen = true;
    // Leaving the view clears the settled rows: they are a record of this visit, not of the
    // document (OPEN_VIEW_POLICY.keepSettled says they stay UNTIL the reader leaves or clears).
    this.settled.clear();
    this.tracked.clear();
    this.expanded.clear();
    const key = this.storageKey();
    try { if (key) localStorage.setItem(key, view); } catch { /* optional */ }
    this.changes.push(view);
    this.renderSig = '';
    this.sync();
    this.host.changed();
  }

  clearSettled(): void {
    if (this.settled.size === 0) return;
    this.settled.clear();
    this.renderSig = '';
    this.sync();
  }

  private onResize = (): void => { this.mount(); };

  private onRuleExpand = (event: CustomEvent<{ from: number; to: number }>): void => {
    const { from, to } = event.detail ?? { from: -1, to: -1 };
    if (from < 0) return;
    for (let i = from; i <= to; i += 1) this.expanded.add(i);
    this.renderSig = '';
    this.sync();
  };

  // --------------------------------------------------------------------------
  // Rendering
  // --------------------------------------------------------------------------

  /** The viewer's Open set, and the honest header, recomputed from the one definition. */
  private compute(): { open: OpenView; header: AccordHeader } {
    const lm = this.host.lineMarks();
    const summary = lm.issueSummary();
    const lines = lm.lineList();
    if (!summary || !lm.isLoaded()) {
      return { open: { items: [], lines: [], count: 0 }, header: emptyAccordHeader() };
    }
    const open = openView({
      issues: summary.issues,
      viewer: lm.me(),
      aliases: lm.viewerAliases(),
      lineAtPos: pos => lm.lineAtPos(pos),
      threads: lm.allThreads(),
      team: summary.team,
      states: lm.lineStates(),
      lineCount: lines.length,
    });
    const header = accordHeader({
      states: lm.lineStates(),
      team: summary.team,
      viewer: lm.me(),
      name: actor => lm.displayName(actor),
      objections: summary.issues.flatMap(issue => (issue.type === 'objection'
        ? [{ by: issue.by, reason: issue.reason, condition: issue.condition, lineIndices: issue.lineIndices }]
        : [])),
    });
    return { open, header };
  }

  /**
   * Puts the toggle and the header where they belong, every render. The toolbar and the page column
   * are both rebuilt by other code (a re-share, a document swap, a responsive relayout), and a
   * control that mounts once is a control that quietly disappears. This is idempotent and cheap.
   */
  private mount(): void {
    // Desktop: immediately LEFT of the Issues pill, because the pill counts what Open holds.
    // Phone: immediately RIGHT of the title instead. On a 375-390 px bar the space beside the pill
    // IS the middle of the screen, and a control that changes what the whole page shows must not
    // sit where a thumb aiming at the document lands. Same control, same bar, the other end.
    const phone = (() => { try { return window.matchMedia('(max-width: 700px)').matches; } catch { return window.innerWidth <= 700; } })();
    const title = document.querySelector('#share-banner .share-pill-title');
    const pill = document.querySelector('#share-banner .share-pill-right .plm-issues')
      ?? document.querySelector('#share-banner .plm-issues');
    if (phone && title) {
      if (title.nextElementSibling !== this.toggleEl) title.parentElement?.insertBefore(this.toggleEl, title.nextSibling);
    } else if (pill && this.toggleEl.nextElementSibling !== pill) {
      pill.parentElement?.insertBefore(this.toggleEl, pill);
    }
    const host = document.getElementById('editor') ?? document.getElementById('editor-container');
    if (host && (this.headerEl.parentElement !== host || host.firstElementChild !== this.headerEl)) host.prepend(this.headerEl);
  }

  sync(): void {
    if (!this.started) return;
    this.mount();
    this.loadView();
    const { open, header } = this.compute();
    this.lastOpen = open;
    this.lastHeader = header;
    const zero = zeroMoment(open, header, this.view, this.chosen);

    // Nothing vanishes under the cursor: a line that was open and is not any more stays in the
    // list, greyed, until the reader clears it or leaves the view.
    if (zero.view === 'open') {
      const now = new Set(open.lines);
      for (const line of this.tracked) if (!now.has(line)) this.settled.add(line);
      for (const line of now) this.settled.delete(line);
      this.tracked = now;
    } else if (this.tracked.size || this.settled.size) {
      this.tracked.clear();
      this.settled.clear();
    }

    const lm = this.host.lineMarks();
    const lineCount = lm.lineList().length;
    const layout = zero.view === 'open'
      ? openLayout(lineCount, [...open.lines, ...this.settled].sort((a, b) => a - b), this.expanded)
      : null;

    const sig = JSON.stringify([
      zero.view, zero.clean, zero.text, this.chosen, header.text, header.viewerRow?.nothing ?? null, open.count, [...this.settled].sort((a, b) => a - b),
      layout ? [...layout.shown].sort((a, b) => a - b) : null, layout?.runs ?? null,
    ]);
    if (sig === this.renderSig) return;
    this.renderSig = sig;

    this.host.folding()?.setOpenFilter(layout
      ? { shown: layout.shown, rules: layout.runs.map(run => ({ at: run.from, label: run.label, from: run.from, to: run.to })), settled: this.settled }
      : null);

    document.body.classList.add('aov-on');
    document.body.classList.toggle('aov-in-open', zero.view === 'open');
    // Only a chosen Accord reads clean (ZERO_POLICY.zeroNeverStripsChrome): reaching zero must not
    // take the margin and the rail away from under the reader.
    document.body.classList.toggle('aov-in-accord', zero.clean);

    // The zero moment: the toggle goes away, quietly. It is a state change, not confetti.
    this.toggleEl.hidden = zero.forViewer;
    this.toggleEl.dataset.view = zero.view;
    this.toggleEl.dataset.chosen = String(this.chosen);
    // Until the person picks one, NEITHER is pressed. A control that says "Accord" is selected
    // while the document still carries every mark and the whole rail is telling them something
    // that is not true. The toggle is an offer until they take it.
    this.openBtn.setAttribute('aria-pressed', String(this.chosen && zero.view === 'open'));
    this.accordBtn.setAttribute('aria-pressed', String(this.chosen && zero.view === 'accord'));
    this.openCount.textContent = open.count ? String(open.count) : '';
    this.openCount.hidden = open.count === 0;

    this.zeroText.textContent = zero.text;
    this.zeroText.hidden = !zero.forViewer;
    this.zeroText.dataset.scope = zero.forEveryone ? 'everyone' : zero.forViewer ? 'you' : '';
    // When it is zero for EVERYONE the header goes too, and what is left is a clean document.
    this.paintHeader(header);
    // The honest header belongs to the ACCORD VIEW, and to the zero moment — not to every load.
    // It is a band above the text, so showing and hiding it moves the document; on a default load
    // it appeared and disappeared while the reader typed, and the page moved under them by 18 px.
    // It shows when they have asked for the Accord, and when they reach zero (which is exactly when
    // a page must not be allowed to imply the document is settled).
    const showHeader = (this.chosen && this.view === 'accord') || zero.forViewer;
    this.headerText.hidden = header.settled || !header.text || !showHeader;
    // The Open view with nothing in it must say why, or it reads as an empty document.
    const emptyOpen = zero.view === 'open' && open.count === 0 && this.settled.size === 0;
    this.emptyText.hidden = !emptyOpen;
    this.emptyText.textContent = emptyOpen
      ? (header.viewerRow?.nothing
        ? 'Nothing is open for you. You have not marked any of this yet — read it in the Accord and mark as you go.'
        : 'Nothing is open for you here.')
      : '';
    this.tools.hidden = zero.view !== 'open' || this.settled.size === 0;
    const n = this.settled.size;
    this.settledLabel.textContent = n ? `${n} settled ${n === 1 ? 'row' : 'rows'}` : '';
    this.headerEl.hidden = this.zeroText.hidden && this.headerText.hidden && this.tools.hidden && this.emptyText.hidden;
    this.headerEl.dataset.view = zero.view;
  }

  /**
   * The header string stays `header.text` (tests read that). A clause that names rejected or
   * lapsed lines is a link to the first of them; `data-lines` lists the rest, 0-based.
   */
  private paintHeader(header: AccordHeader): void {
    this.headerText.replaceChildren();
    if (header.clauses.length === 0) {
      this.headerText.textContent = header.text;
      return;
    }
    header.clauses.forEach((clause, index) => {
      if (index > 0) this.headerText.append(' ');
      if (clause.lines.length === 0) {
        this.headerText.append(clause.text);
        return;
      }
      const link = document.createElement('a');
      link.className = 'aov-header-link';
      link.href = `#line-${clause.lines[0] + 1}`;
      link.dataset.lines = clause.lines.join(',');
      link.textContent = clause.text;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        const line = clause.lines[0];
        this.host.lineMarks().revealLine(line);
        const walk = (window as unknown as { __proofReadingWalk?: { focusLine?: (index: number) => boolean } }).__proofReadingWalk;
        if (walk?.focusLine) walk.focusLine(line);
        else document.querySelector<HTMLElement>(`.plm-dot[data-line="${line}"]`)?.scrollIntoView({ block: 'center' });
      });
      this.headerText.append(link);
    });
  }

  // --------------------------------------------------------------------------
  // Test hooks
  // --------------------------------------------------------------------------

  openItems(): OpenView { return this.lastOpen; }
  header(): AccordHeader { return this.lastHeader; }
  settledLines(): number[] { return [...this.settled].sort((a, b) => a - b); }

  debugState(): Record<string, unknown> {
    const lm = this.host.lineMarks();
    const zero = zeroMoment(this.lastOpen, this.lastHeader, this.view, this.chosen);
    return {
      view: zero.view,
      clean: zero.clean,
      chosen: this.chosen ? this.view : null,
      toggleHidden: this.toggleEl.hidden,
      open: { count: this.lastOpen.count, lines: this.lastOpen.lines, items: this.lastOpen.items.map(i => ({ line: i.line, kinds: i.kinds, because: i.because, detached: i.detached, agreedTo: i.agreedTo ?? null })) },
      // The three surfaces, read from where each of them actually gets its number.
      pill: Number(document.querySelector<HTMLElement>('.plm-issues-count')?.dataset.viewerCount ?? -1),
      dots: [...document.querySelectorAll<HTMLElement>('.plm-dot[data-needs-you="true"]')].map(d => Number(d.dataset.line)).sort((a, b) => a - b),
      navigator: [...document.querySelectorAll<HTMLElement>('.anv-issue')].map(b => Number(b.dataset.line)).sort((a, b) => a - b),
      amberFromLineMarks: [...lm.needsYouLines()],
      header: { text: this.lastHeader.text, settled: this.lastHeader.settled, hidden: this.headerText.hidden },
      zero: { forViewer: zero.forViewer, forEveryone: zero.forEveryone, text: zero.text, shown: !this.zeroText.hidden },
      settled: this.settledLines(),
      hiddenLines: [...(this.host.folding()?.hiddenLines() ?? [])].sort((a, b) => a - b),
      rules: [...document.querySelectorAll<HTMLElement>('.aov-rule')].map(r => ({ from: Number(r.dataset.from), to: Number(r.dataset.to), label: r.querySelector('.aov-rule-label')?.textContent ?? '' })),
      policy: { contextLines: OPEN_VIEW_POLICY.contextLines, minCollapseRun: OPEN_VIEW_POLICY.minCollapseRun, unreadLinesAreOpen: OPEN_VIEW_POLICY.unreadLinesAreOpen, zeroText: ZERO_POLICY.forYou },
    };
  }
}
