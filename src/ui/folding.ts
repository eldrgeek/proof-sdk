/**
 * Proof Documents Step B2 — folding in the Proof Editor.
 *
 * Authorship: spec by Mike Wolf (Proof Documents draft, 2026-09-18); section marking and the
 * policy in src/shared/folding.ts are the COS's decisions; built by Claude Opus 5 (worker
 * proof-fold), 2026-09-18.
 *
 * - Every top-level heading gets a chip at its right edge: a caret (▾ open, ▸ folded) and the
 *   section's Issue count, or ✓ when it has none. The chip folds and unfolds the section.
 * - Folding hides the section's body with view-only decorations (src/editor/plugins/fold-view.ts):
 *   the document text, its marks and its Yjs state never change.
 * - Fold state is per viewer: localStorage, keyed by the document and each heading's text hash.
 * - Fold all, Unfold all and "fold to level" sit at the top of the right rail (phones: the
 *   "This line" sheet, and Fold all / Unfold all in the ⋯ menu).
 */
import type { EditorView } from '@milkdown/kit/prose/view';
import type { DocLine } from '../shared/line-marks';
import {
  FOLDING,
  SECTION_AUTOCLOSE,
  computeSections,
  foldToLevelRespectingSticky,
  foldedAncestors,
  planAutoClose,
  headingLevels,
  hiddenBlockRanges,
  hiddenLineSet,
  sectionByHeading,
  sectionIssueCount,
  sectionLineIndices,
  visibleLineFor,
  type DocSection,
} from '../shared/folding';
import { hiddenBlocks, setHiddenBlocks, type FoldRule } from '../editor/plugins/fold-view';
import type { LineMarksUI } from './line-marks';
import './folding.css';

export interface FoldingHost {
  slug(): string | null;
  lineMarks(): LineMarksUI;
}

const PHONE_QUERY = '(max-width: 700px)';

function isPhone(): boolean {
  try { return window.matchMedia(PHONE_QUERY).matches; } catch { return window.innerWidth <= 700; }
}

export class FoldingUI {
  /** Fold all / Unfold all / level buttons; the host mounts it (the right rail). */
  readonly controlsEl = document.createElement('div');
  private readonly layer = document.createElement('div');
  private sections: DocSection[] = [];
  private lines: DocLine[] = [];
  private folded = new Set<string>();
  /**
   * Item 6 (Mike, 2026-09-19: "When a folded item below an H level is unfolded it does not
   * refold"): sections the person unfolded by hand. Rule 1 of the model — an explicit action beats
   * any automatic one — so nothing automatic (auto-close, fold-to-level, a later fold pass) folds
   * these again. Only an explicit fold takes the stickiness off.
   */
  private sticky = new Set<string>();
  /** Item 4: the folded heading the pointer is resting on (a peek, not a change to the state). */
  private peeked: string | null = null;
  private peekTimer: ReturnType<typeof setTimeout> | null = null;
  private peekCandidate: string | null = null;
  private autoCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private focusLine = -1;
  /** Test hooks. */
  private autoClosed: string[] = [];
  private peekLog: string[] = [];
  private hidden = new Set<number>();
  /**
   * Accord round 2 stage C: the Open view's filter. When set, only these lines are shown; every
   * other line is hidden on top of the section folds, and each collapsed run draws a thin rule.
   * Null means no filter (the Accord view and the ordinary document).
   */
  private openFilter: { shown: ReadonlySet<number>; rules: FoldRule[]; settled: ReadonlySet<number> } | null = null;
  private loadedSlug: string | null = null;
  private started = false;
  private renderQueued = false;
  private applyQueued = false;
  private resizeObserver: ResizeObserver | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private controlsSig = '';
  private extraSig = '';

  constructor(private readonly host: FoldingHost) {
    this.layer.className = 'pfold-layer';
    this.controlsEl.className = 'pfold-controls';
    this.controlsEl.setAttribute('role', 'group');
    this.controlsEl.setAttribute('aria-label', 'Outline folding');
    this.layer.addEventListener('click', this.onLayerClick);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    document.body.classList.add('pfold-on');
    window.addEventListener('resize', this.queueRender);
    window.addEventListener('scroll', this.onScroll, { passive: true });
    document.addEventListener('pointermove', this.onPointerMove, { passive: true });
    this.unsubscribe = this.host.lineMarks().subscribe(() => this.sync());
    this.sync();
  }

  stop(): void {
    this.started = false;
    document.body.classList.remove('pfold-on');
    window.removeEventListener('resize', this.queueRender);
    window.removeEventListener('scroll', this.onScroll);
    document.removeEventListener('pointermove', this.onPointerMove);
    if (this.peekTimer) clearTimeout(this.peekTimer);
    if (this.autoCloseTimer) clearTimeout(this.autoCloseTimer);
    this.unsubscribe?.();
    this.resizeObserver?.disconnect();
    this.layer.remove();
  }

  /** Called after the fold state or the hidden lines change. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // --------------------------------------------------------------------------
  // State
  // --------------------------------------------------------------------------

  private view(): EditorView | null { return this.host.lineMarks().editorView(); }

  private storageKey(): string | null {
    const slug = this.host.slug();
    return slug ? `${FOLDING.storagePrefix}${slug}` : null;
  }

  private stickyKey(): string | null {
    const slug = this.host.slug();
    return slug ? `${SECTION_AUTOCLOSE.stickyPrefix}${slug}` : null;
  }

  private loadFolded(): void {
    const slug = this.host.slug();
    if (slug === this.loadedSlug) return;
    this.loadedSlug = slug;
    const key = this.storageKey();
    let saved: unknown = [];
    try { saved = key ? JSON.parse(localStorage.getItem(key) || '[]') : []; } catch { saved = []; }
    this.folded = new Set(Array.isArray(saved) ? saved.filter((k): k is string => typeof k === 'string').slice(0, 2000) : []);
    let sticky: unknown = [];
    const stickyKey = this.stickyKey();
    try { sticky = stickyKey ? JSON.parse(localStorage.getItem(stickyKey) || '[]') : []; } catch { sticky = []; }
    this.sticky = new Set(Array.isArray(sticky) ? sticky.filter((k): k is string => typeof k === 'string').slice(0, 2000) : []);
  }

  private saveFolded(): void {
    const key = this.storageKey();
    if (!key) return;
    try {
      if (this.folded.size === 0) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify([...this.folded]));
    } catch { /* optional */ }
    const stickyKey = this.stickyKey();
    if (!stickyKey) return;
    try {
      if (this.sticky.size === 0) localStorage.removeItem(stickyKey);
      else localStorage.setItem(stickyKey, JSON.stringify([...this.sticky]));
    } catch { /* optional */ }
  }

  /** Lines, marks or the document changed: recompute sections and re-apply the fold. */
  private sync(): void {
    const lm = this.host.lineMarks();
    const view = this.view();
    if (!view) return;
    this.loadFolded();
    this.attachLayer(view);
    this.lines = lm.lineList();
    this.sections = computeSections(this.lines, view.state.doc.childCount);
    this.recomputeHidden();
    // This runs inside the editor's view update: dispatch the decorations afterwards.
    this.queueApply();
    this.queueRender();
  }

  /** The fold state as the reader SEES it: the stored set minus the one section being peeked. */
  private visibleFolded(): Set<string> {
    const set = new Set(this.folded);
    if (this.peeked) set.delete(this.peeked);
    return set;
  }

  private recomputeHidden(): boolean {
    const next = hiddenLineSet(this.sections, this.visibleFolded());
    // The Open view hides everything it is not showing, on top of the section folds.
    const filter = this.openFilter;
    if (filter) for (const line of this.lines) if (!filter.shown.has(line.index)) next.add(line.index);
    const changed = next.size !== this.hidden.size || [...next].some(i => !this.hidden.has(i));
    this.hidden = next;
    return changed;
  }

  /**
   * Accord round 2 stage C: the Open view sets which lines are shown; everything else collapses.
   * Passing null takes the filter off (the Accord view, and the ordinary document).
   */
  setOpenFilter(filter: { shown: ReadonlySet<number>; rules: FoldRule[]; settled: ReadonlySet<number> } | null): void {
    const before = JSON.stringify(this.openFilterSignature());
    this.openFilter = filter;
    if (JSON.stringify(this.openFilterSignature()) === before) return;
    this.recomputeHidden();
    this.apply();
    this.renderNow();
  }

  private openFilterSignature(): unknown {
    const filter = this.openFilter;
    if (!filter) return null;
    return [[...filter.shown].sort((a, b) => a - b), filter.rules, [...filter.settled].sort((a, b) => a - b)];
  }

  /** The block indices every one of whose lines the Open view hides (a block is the fold's unit). */
  private openFilterBlocks(): Array<[number, number]> {
    const filter = this.openFilter;
    if (!filter) return [];
    const byBlock = new Map<number, DocLine[]>();
    for (const line of this.lines) {
      const list = byBlock.get(line.block) ?? [];
      list.push(line);
      byBlock.set(line.block, list);
    }
    const hidden = [...byBlock.entries()]
      .filter(([, lines]) => lines.every(line => !filter.shown.has(line.index)))
      .map(([block]) => block)
      .sort((a, b) => a - b);
    const ranges: Array<[number, number]> = [];
    for (const block of hidden) {
      const last = ranges[ranges.length - 1];
      if (last && block === last[1]) last[1] = block + 1;
      else ranges.push([block, block + 1]);
    }
    return ranges;
  }

  /** The blocks a settled line sits in (they stay visible, greyed and struck through). */
  private settledBlocks(): number[] {
    const filter = this.openFilter;
    if (!filter) return [];
    const blocks = new Set<number>();
    for (const line of this.lines) if (filter.settled.has(line.index)) blocks.add(line.block);
    return [...blocks].sort((a, b) => a - b);
  }

  /** The rules, mapped from line ranges to the block each is drawn before. */
  private ruleDecorations(): FoldRule[] {
    const filter = this.openFilter;
    if (!filter) return [];
    const blockOf = new Map<number, number>();
    for (const line of this.lines) if (!blockOf.has(line.index)) blockOf.set(line.index, line.block);
    return filter.rules
      .map(rule => ({ ...rule, at: blockOf.get(rule.from) ?? -1 }))
      .filter(rule => rule.at >= 0);
  }

  private queueApply(): void {
    if (this.applyQueued) return;
    this.applyQueued = true;
    queueMicrotask(() => {
      this.applyQueued = false;
      this.apply();
    });
  }

  /** Makes the editor's decorations match the fold state (no-op when they already do). */
  private apply(): void {
    const view = this.view();
    if (!view) return;
    const ranges = [...hiddenBlockRanges(this.sections, this.visibleFolded()), ...this.openFilterBlocks()]
      .sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([range[0], range[1]]);
    }
    const want: number[] = [];
    for (const [from, to] of merged) for (let i = from; i < Math.min(to, view.state.doc.childCount); i += 1) want.push(i);
    const have = hiddenBlocks(view);
    const rules = this.ruleDecorations();
    const settled = this.settledBlocks();
    const extraSig = JSON.stringify([rules, settled]);
    if (want.length !== have.length || want.some((block, i) => block !== have[i]) || extraSig !== this.extraSig) {
      this.extraSig = extraSig;
      setHiddenBlocks(view, merged, { rules, settled });
    }
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { console.warn('[fold] listener failed', error); }
    }
  }

  /** A user action changed the fold state: store it, apply it now, re-render. */
  private commit(): void {
    this.saveFolded();
    this.recomputeHidden();
    this.apply();
    this.renderNow();
  }

  // --------------------------------------------------------------------------
  // Public API (reading walk, line marks, tests)
  // --------------------------------------------------------------------------

  sectionList(): DocSection[] { return this.sections; }
  /** Accord layout stage 3: the Issues left in a section (the Outline's count, same as its chip). */
  sectionIssues(headingIndex: number): number {
    const section = sectionByHeading(this.sections, headingIndex);
    if (!section) return 0;
    return sectionIssueCount(section, this.lines, this.host.lineMarks().issueSummary()).total;
  }
  hiddenLines(): ReadonlySet<number> { return this.hidden; }
  isHidden(lineIndex: number): boolean { return this.hidden.has(lineIndex); }

  isFolded(headingIndex: number): boolean {
    const section = sectionByHeading(this.sections, headingIndex);
    return Boolean(section && this.folded.has(section.key));
  }

  /** The visible line that stands for a line (the heading of its outermost folded section). */
  visibleLineFor(lineIndex: number): number {
    return visibleLineFor(this.sections, this.folded, lineIndex);
  }

  /**
   * Marking scope for a line: when it is a FOLDED heading and the policy says so, the line
   * indices of its whole section; otherwise null (mark the line alone).
   */
  markScope(lineIndex: number): { lines: number[]; heading: string } | null {
    const section = sectionByHeading(this.sections, lineIndex);
    if (!section) return null;
    const scope = this.folded.has(section.key) ? FOLDING.foldedHeadingScope : FOLDING.unfoldedHeadingScope;
    if (scope !== 'section') return null;
    return { lines: sectionLineIndices(section), heading: this.lines[lineIndex]?.text ?? '' };
  }

  /**
   * An explicit fold or unfold by the person (the chip, the keyboard, the sheet). Rule 1: unfolding
   * makes the section sticky (nothing automatic refolds it); folding takes that back, because
   * "it stays unfolded until they fold it again" (Mike).
   */
  toggle(headingIndex: number, options: { record?: boolean } = {}): void {
    const section = sectionByHeading(this.sections, headingIndex);
    if (!section) return;
    // A peek is not a state change: clicking commits it, so the peek ends here either way.
    if (this.peeked === section.key) this.peeked = null;
    const wasFolded = this.folded.has(section.key);
    if (wasFolded) {
      this.folded.delete(section.key);
      this.sticky.add(section.key);
    } else {
      this.folded.add(section.key);
      this.sticky.delete(section.key);
    }
    this.commit();
    if (options.record !== false) {
      const heading = this.lines[headingIndex]?.text.slice(0, 40) ?? 'a section';
      this.record(`${wasFolded ? 'unfolded' : 'folded'} “${heading}”`, () => this.toggle(headingIndex, { record: false }));
    }
  }

  /** Puts a fold change on the one Undo stack (a fold is a person's action like any other). */
  private record(description: string, inverse: () => void): void {
    const stack = this.host.lineMarks().undoStack?.();
    if (!stack) return;
    let snapshot: { folded: string[]; sticky: string[] } | null = null;
    stack.pushSimple('fold', description, () => {
      snapshot = { folded: [...this.folded], sticky: [...this.sticky] };
      inverse();
      return { ok: true };
    }, () => {
      if (!snapshot) return { ok: false, reason: 'Could not redo that fold.' };
      this.folded = new Set(snapshot.folded);
      this.sticky = new Set(snapshot.sticky);
      this.peeked = null;
      this.commit();
      return { ok: true };
    });
  }

  setFolded(headingIndex: number, folded: boolean): void {
    if (this.isFolded(headingIndex) !== folded) this.toggle(headingIndex);
  }

  /** Fold all is the person folding everything again: it clears every sticky unfold. */
  foldAll(options: { record?: boolean } = {}): void {
    const before = { folded: [...this.folded], sticky: [...this.sticky] };
    if (options.record !== false) {
      this.record('folded every section', () => { this.folded = new Set(before.folded); this.sticky = new Set(before.sticky); this.peeked = null; this.commit(); });
    }
    this.folded = new Set(this.sections.map(section => section.key));
    this.sticky = new Set();
    this.peeked = null;
    this.commit();
  }

  /** Unfold all is an explicit unfold of everything: every section becomes sticky. */
  unfoldAll(options: { record?: boolean } = {}): void {
    const before = { folded: [...this.folded], sticky: [...this.sticky] };
    if (options.record !== false) {
      this.record('unfolded every section', () => { this.folded = new Set(before.folded); this.sticky = new Set(before.sticky); this.peeked = null; this.commit(); });
    }
    // Only this document's headings are stored under this key, so clearing it is safe.
    this.folded = new Set();
    this.sticky = new Set(this.sections.map(section => section.key));
    this.peeked = null;
    this.commit();
  }

  /**
   * Item 6: fold-to-level leaves the sections the person unfolded by hand alone. Before this, H2
   * refolded them and the person's work was undone by a button they pressed for other sections.
   */
  foldLevel(level: number, options: { record?: boolean } = {}): void {
    const before = { folded: [...this.folded], sticky: [...this.sticky] };
    if (options.record !== false) {
      this.record(`showed headings down to level ${level}`, () => { this.folded = new Set(before.folded); this.sticky = new Set(before.sticky); this.peeked = null; this.commit(); });
    }
    this.folded = foldToLevelRespectingSticky(this.sections, level, this.sticky);
    this.peeked = null;
    this.commit();
  }

  /** The sections the person unfolded by hand (test hook and rule-1 checks). */
  stickyKeys(): string[] { return [...this.sticky]; }

  /** Unfolds every folded section that hides the line. Returns true when something unfolded. */
  reveal(lineIndex: number): boolean {
    const ancestors = foldedAncestors(this.sections, this.folded, lineIndex);
    if (ancestors.length === 0) return false;
    // Revealing a line to go to it is the person asking for it: rule 1 makes it stick.
    for (const section of ancestors) { this.folded.delete(section.key); this.sticky.add(section.key); }
    this.peeked = null;
    this.commit();
    return true;
  }

  // --------------------------------------------------------------------------
  // Rendering: one chip per heading, plus the controls
  // --------------------------------------------------------------------------

  private attachLayer(view: EditorView): void {
    const container = (view.dom.closest('#editor-container') as HTMLElement | null) ?? view.dom.parentElement;
    if (!container) return;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    if (this.layer.parentElement !== container) container.append(this.layer);
    if (!this.resizeObserver) {
      this.resizeObserver = new ResizeObserver(this.queueRender);
      this.resizeObserver.observe(view.dom);
    }
  }

  queueRender = (): void => {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderNow();
    });
  };

  private renderNow(): void {
    this.renderChips();
    this.renderControls();
  }

  private renderChips(): void {
    const view = this.view();
    if (!view || !this.layer.isConnected) return;
    const lm = this.host.lineMarks();
    const summary = lm.issueSummary();
    const loaded = lm.isLoaded();
    const container = this.layer.parentElement!.getBoundingClientRect();
    const phone = isPhone();
    const existing = new Map<string, HTMLButtonElement>();
    for (const chip of Array.from(this.layer.children) as HTMLButtonElement[]) existing.set(chip.dataset.key ?? '', chip);
    const used = new Set<string>();
    for (const section of this.sections) {
      const line = this.lines[section.headingIndex];
      if (!line) continue;
      const dom = view.nodeDOM(line.pos) as HTMLElement | null;
      if (!dom || typeof dom.getBoundingClientRect !== 'function') continue;
      const rect = dom.getBoundingClientRect();
      if (rect.height === 0) continue; // inside a folded parent
      used.add(section.key);
      let chip = existing.get(section.key);
      if (!chip) {
        chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'pfold-chip';
        chip.dataset.key = section.key;
        this.layer.append(chip);
      }
      const stored = this.folded.has(section.key);
      const peeking = this.peeked === section.key;
      // While peeking, the body is open but the state is still folded: the caret says so.
      const folded = stored && !peeking;
      const count = sectionIssueCount(section, this.lines, summary);
      const bodyLines = section.lineEnd - section.headingIndex - 1;
      chip.dataset.heading = String(section.headingIndex);
      chip.dataset.folded = String(stored);
      chip.dataset.peek = String(peeking);
      chip.dataset.state = !loaded ? 'loading' : (count.total === 0 ? 'resolved' : 'issues');
      chip.setAttribute('aria-expanded', String(!folded));
      const countText = !loaded ? '…' : (count.total === 0 ? '✓' : String(count.total));
      const sig = `${folded}|${peeking}|${countText}|${bodyLines}`;
      if (chip.dataset.sig !== sig) {
        chip.dataset.sig = sig;
        const caret = document.createElement('span');
        caret.className = 'pfold-caret';
        caret.textContent = folded ? '▸' : '▾';
        const badge = document.createElement('span');
        badge.className = 'pfold-badge';
        badge.textContent = countText;
        chip.replaceChildren(caret, badge);
      }
      const issuesText = !loaded ? 'Issues loading' : (count.total === 0
        ? 'no Issues: resolved'
        : `${count.total} ${count.total === 1 ? 'Issue remains' : 'Issues remain'} (${count.lines} ${count.lines === 1 ? 'line' : 'lines'}, ${count.reviewMarks} open ${count.reviewMarks === 1 ? 'comment or suggestion' : 'comments or suggestions'}${count.asks ? `, ${count.asks} open ${count.asks === 1 ? 'ask' : 'asks'}` : ''})`);
      chip.setAttribute('aria-label', `${folded ? 'Unfold' : 'Fold'} section “${line.text.slice(0, 60)}”: ${issuesText}`);
      chip.title = `${peeking ? 'Peeking: still folded. Click to keep it open.' : stored ? `Folded: ${bodyLines} ${bodyLines === 1 ? 'line' : 'lines'} hidden. Hover to peek, click to unfold.` : 'Click to fold this section.'}\n${issuesText}`;
      const size = phone ? 36 : 24;
      const lineHeight = parseFloat(getComputedStyle(dom).lineHeight) || size;
      const top = rect.top - container.top + Math.max(0, (Math.min(lineHeight, rect.height) - size) / 2);
      chip.style.top = `${Math.round(top)}px`;
      chip.style.right = `${Math.round(Math.max(0, container.right - rect.right))}px`;
      chip.style.height = `${size}px`;
    }
    for (const [key, chip] of existing) if (!used.has(key)) chip.remove();
  }

  private renderControls(): void {
    const levels = headingLevels(this.sections);
    const foldedCount = this.sections.filter(section => this.folded.has(section.key)).length;
    const sig = `${levels.join(',')}|${foldedCount}|${this.sections.length}`;
    if (sig === this.controlsSig) return;
    this.controlsSig = sig;
    this.controlsEl.replaceChildren();
    this.controlsEl.hidden = this.sections.length === 0;
    if (this.sections.length === 0) return;
    const label = document.createElement('span');
    label.className = 'pfold-controls-label';
    label.textContent = 'Outline';
    const button = (text: string, aria: string, action: () => void, disabled = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.setAttribute('aria-label', aria);
      b.disabled = disabled;
      b.onclick = action;
      return b;
    };
    this.controlsEl.append(
      label,
      button('Fold all', 'Fold every section', () => this.foldAll(), foldedCount === this.sections.length),
      button('Unfold all', 'Unfold every section', () => this.unfoldAll(), foldedCount === 0),
    );
    if (levels.length > 1) {
      const group = document.createElement('span');
      group.className = 'pfold-levels';
      for (const level of levels) {
        group.append(button(`H${level}`, `Show headings down to level ${level}`, () => this.foldLevel(level)));
      }
      this.controlsEl.append(group);
    }
  }

  // --------------------------------------------------------------------------
  // Item 4: a section with no Issues closes itself once the reader leaves it;
  //         hovering a folded heading peeks it open.
  // --------------------------------------------------------------------------

  /** The reading / hover focus moved (the reading walk tells us). */
  setFocusLine(lineIndex: number): void {
    if (lineIndex === this.focusLine) return;
    this.focusLine = lineIndex;
    this.queueAutoClose();
  }

  private onScroll = (): void => { this.queueAutoClose(); };

  /**
   * Rule 2 of the model: nothing folds under the reader's eyes. The close waits until scrolling
   * has been still for SECTION_AUTOCLOSE.idleMs and the section is off screen.
   */
  private queueAutoClose(): void {
    if (!SECTION_AUTOCLOSE.enabled || !this.started) return;
    if (this.autoCloseTimer) clearTimeout(this.autoCloseTimer);
    this.autoCloseTimer = setTimeout(() => {
      this.autoCloseTimer = null;
      this.runAutoClose();
    }, SECTION_AUTOCLOSE.idleMs);
  }

  /** Is any part of the section on screen? */
  private sectionInView(section: DocSection): boolean {
    const view = this.view();
    const line = this.lines[section.headingIndex];
    if (!view || !line) return true; // cannot tell: never fold blind
    const dom = view.nodeDOM(line.pos) as HTMLElement | null;
    if (!dom || typeof dom.getBoundingClientRect !== 'function') return true;
    const top = dom.getBoundingClientRect().top;
    const endLine = section.lineEnd < this.lines.length ? this.lines[section.lineEnd] : null;
    const endDom = endLine ? view.nodeDOM(endLine.pos) as HTMLElement | null : null;
    const bottom = endDom && typeof endDom.getBoundingClientRect === 'function'
      ? endDom.getBoundingClientRect().top
      : view.dom.getBoundingClientRect().bottom;
    return bottom > 0 && top < window.innerHeight;
  }

  private runAutoClose(): void {
    if (!SECTION_AUTOCLOSE.enabled || this.sections.length === 0) return;
    const lm = this.host.lineMarks();
    if (!lm.isLoaded()) return; // Issue counts unknown: never close on a guess
    const summary = lm.issueSummary();
    const mine = SECTION_AUTOCLOSE.countIssues === 'viewer' ? (lm.myIssueLineSet?.() ?? null) : null;
    const issueTotal = (section: DocSection): number => {
      if (!mine) return sectionIssueCount(section, this.lines, summary).total;
      let count = 0;
      for (const index of mine) if (index >= section.headingIndex && index < section.lineEnd) count += 1;
      return count;
    };
    const keys = planAutoClose({
      sections: this.sections,
      folded: this.folded,
      sticky: this.sticky,
      focusLine: this.focusLine,
      issueTotal,
      inView: section => this.sectionInView(section),
    });
    if (keys.length === 0) return;
    for (const key of keys) { this.folded.add(key); this.autoClosed.push(key); }
    if (this.autoClosed.length > 50) this.autoClosed.splice(0, this.autoClosed.length - 50);
    this.commit();
  }

  /**
   * Rule 3: hover previews, click commits. Resting the pointer on a folded heading's chip or its
   * heading text opens the body for as long as the pointer stays; leaving re-folds it. The stored
   * fold state is untouched, so nothing is persisted by looking.
   */
  private onPointerMove = (event: PointerEvent): void => {
    if (!SECTION_AUTOCLOSE.hoverPeek || !this.started || event.pointerType !== 'mouse') return;
    const key = this.foldedKeyAt(event.clientX, event.clientY);
    if (key === this.peekCandidate && (key === null ? this.peeked === null : this.peeked === key)) return;
    this.peekCandidate = key;
    if (this.peekTimer) clearTimeout(this.peekTimer);
    if (key === null) {
      // Off a folded heading: re-fold after a short grace, unless the person clicked it open.
      if (this.peeked === null) return;
      this.peekTimer = setTimeout(() => {
        this.peekTimer = null;
        if (this.peekCandidate !== null || this.peeked === null) return;
        this.peekLog.push(`leave:${this.peeked}`);
        this.peeked = null;
        this.recomputeHidden();
        this.apply();
        this.queueRender();
      }, SECTION_AUTOCLOSE.hoverPeekLeaveMs);
      return;
    }
    this.peekTimer = setTimeout(() => {
      this.peekTimer = null;
      if (this.peekCandidate !== key || !this.folded.has(key)) return;
      this.peeked = key;
      this.peekLog.push(`peek:${key}`);
      if (this.peekLog.length > 20) this.peekLog.shift();
      this.recomputeHidden();
      this.apply();
      this.queueRender();
    }, SECTION_AUTOCLOSE.hoverPeekDelayMs);
  };

  /** The folded section whose heading (text or chip) is under this point, or null. */
  private foldedKeyAt(x: number, y: number): string | null {
    const element = document.elementFromPoint(x, y);
    if (!element) return null;
    const chip = element.closest('.pfold-chip') as HTMLElement | null;
    if (chip) {
      const key = chip.dataset.key ?? null;
      return key && this.folded.has(key) ? key : null;
    }
    const view = this.view();
    if (!view || !view.dom.contains(element)) return null;
    for (const section of this.sections) {
      if (!this.folded.has(section.key)) continue;
      const line = this.lines[section.headingIndex];
      const dom = line ? view.nodeDOM(line.pos) as HTMLElement | null : null;
      if (dom && (dom === element || dom.contains(element))) return section.key;
    }
    return null;
  }

  /** The section being peeked (shown open without changing the stored fold state). */
  peekedKey(): string | null { return this.peeked; }

  private onLayerClick = (event: MouseEvent): void => {
    const chip = (event.target as HTMLElement).closest('.pfold-chip') as HTMLButtonElement | null;
    if (!chip) return;
    event.preventDefault();
    event.stopPropagation();
    this.toggle(Number(chip.dataset.heading));
  };

  /** Test hook. */
  debugState(): Record<string, unknown> {
    const view = this.view();
    return {
      sections: this.sections.map(section => ({ ...section, text: this.lines[section.headingIndex]?.text ?? '', folded: this.folded.has(section.key) })),
      folded: [...this.folded],
      sticky: [...this.sticky],
      peeked: this.peeked,
      peekLog: [...this.peekLog],
      autoClosed: [...this.autoClosed],
      focusLine: this.focusLine,
      hidden: [...this.hidden].sort((a, b) => a - b),
      hiddenBlocks: view ? hiddenBlocks(view) : [],
    };
  }
}
