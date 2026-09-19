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
  computeSections,
  foldToLevel,
  foldedAncestors,
  headingLevels,
  hiddenBlockRanges,
  hiddenLineSet,
  sectionByHeading,
  sectionIssueCount,
  sectionLineIndices,
  visibleLineFor,
  type DocSection,
} from '../shared/folding';
import { hiddenBlocks, setHiddenBlocks } from '../editor/plugins/fold-view';
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
  private hidden = new Set<number>();
  private loadedSlug: string | null = null;
  private started = false;
  private renderQueued = false;
  private applyQueued = false;
  private resizeObserver: ResizeObserver | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private controlsSig = '';

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
    this.unsubscribe = this.host.lineMarks().subscribe(() => this.sync());
    this.sync();
  }

  stop(): void {
    this.started = false;
    document.body.classList.remove('pfold-on');
    window.removeEventListener('resize', this.queueRender);
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

  private loadFolded(): void {
    const slug = this.host.slug();
    if (slug === this.loadedSlug) return;
    this.loadedSlug = slug;
    const key = this.storageKey();
    let saved: unknown = [];
    try { saved = key ? JSON.parse(localStorage.getItem(key) || '[]') : []; } catch { saved = []; }
    this.folded = new Set(Array.isArray(saved) ? saved.filter((k): k is string => typeof k === 'string').slice(0, 2000) : []);
  }

  private saveFolded(): void {
    const key = this.storageKey();
    if (!key) return;
    try {
      if (this.folded.size === 0) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify([...this.folded]));
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

  private recomputeHidden(): boolean {
    const next = hiddenLineSet(this.sections, this.folded);
    const changed = next.size !== this.hidden.size || [...next].some(i => !this.hidden.has(i));
    this.hidden = next;
    return changed;
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
    const ranges = hiddenBlockRanges(this.sections, this.folded);
    const want: number[] = [];
    for (const [from, to] of ranges) for (let i = from; i < Math.min(to, view.state.doc.childCount); i += 1) want.push(i);
    const have = hiddenBlocks(view);
    if (want.length !== have.length || want.some((block, i) => block !== have[i])) {
      setHiddenBlocks(view, ranges);
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

  toggle(headingIndex: number): void {
    const section = sectionByHeading(this.sections, headingIndex);
    if (!section) return;
    if (this.folded.has(section.key)) this.folded.delete(section.key);
    else this.folded.add(section.key);
    this.commit();
  }

  setFolded(headingIndex: number, folded: boolean): void {
    if (this.isFolded(headingIndex) !== folded) this.toggle(headingIndex);
  }

  foldAll(): void {
    this.folded = new Set(this.sections.map(section => section.key));
    this.commit();
  }

  unfoldAll(): void {
    // Only this document's headings are stored under this key, so clearing it is safe.
    this.folded = new Set();
    this.commit();
  }

  foldLevel(level: number): void {
    this.folded = foldToLevel(this.sections, level);
    this.commit();
  }

  /** Unfolds every folded section that hides the line. Returns true when something unfolded. */
  reveal(lineIndex: number): boolean {
    const ancestors = foldedAncestors(this.sections, this.folded, lineIndex);
    if (ancestors.length === 0) return false;
    for (const section of ancestors) this.folded.delete(section.key);
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
      const folded = this.folded.has(section.key);
      const count = sectionIssueCount(section, this.lines, summary);
      const bodyLines = section.lineEnd - section.headingIndex - 1;
      chip.dataset.heading = String(section.headingIndex);
      chip.dataset.folded = String(folded);
      chip.dataset.state = !loaded ? 'loading' : (count.total === 0 ? 'resolved' : 'issues');
      chip.setAttribute('aria-expanded', String(!folded));
      const countText = !loaded ? '…' : (count.total === 0 ? '✓' : String(count.total));
      const sig = `${folded}|${countText}|${bodyLines}`;
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
        : `${count.total} ${count.total === 1 ? 'Issue remains' : 'Issues remain'} (${count.lines} ${count.lines === 1 ? 'line' : 'lines'}, ${count.reviewMarks} open ${count.reviewMarks === 1 ? 'comment or suggestion' : 'comments or suggestions'})`);
      chip.setAttribute('aria-label', `${folded ? 'Unfold' : 'Fold'} section “${line.text.slice(0, 60)}”: ${issuesText}`);
      chip.title = `${folded ? `Folded: ${bodyLines} ${bodyLines === 1 ? 'line' : 'lines'} hidden. Click to unfold.` : 'Click to fold this section.'}\n${issuesText}`;
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
      hidden: [...this.hidden].sort((a, b) => a - b),
      hiddenBlocks: view ? hiddenBlocks(view) : [],
    };
  }
}
