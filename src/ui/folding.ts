/**
 * Sections stay as the reader left them. Hover and Issue closure never fold text.
 * Badges count pending changes only (the Accord rules, 2026-09-24).
 * Stored section-mark APIs remain available for compatibility.
 */
import { sectionPendingChanges } from '../shared/review-surface';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Transaction } from '@milkdown/kit/prose/state';
import { actorKey, extractLines, type DocLine } from '../shared/line-marks';
import {
  FOLDING,
  captureSectionScope,
  remapFoldedKeys,
  type SectionScope,
  computeSections,
  foldedAncestors,
  hiddenBlockRanges,
  hiddenLineSet,
  sectionAgreementOffer,
  sectionByHeading,
  visibleLineFor,
  type DocSection,
  type SectionAgreementOffer,
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
  /** Expand all / Collapse all buttons; the host mounts it (the right rail). */
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
    return slug ? `${FOLDING.storagePrefix}${slug}:${actorKey(this.host.lineMarks().me())}` : null;
  }

  private loadFolded(): void {
    const key = this.storageKey();
    if (key === this.loadedSlug) return;
    this.loadedSlug = key;
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

  /** Preserve disclosure choices when an edit renames or shifts their heading. */
  mapTransaction(tr: Transaction): void {
    if (!tr.docChanged || !this.folded.size) return;
    const beforeLines = extractLines(tr.before);
    const nextLines = extractLines(tr.doc);
    this.folded = remapFoldedKeys(this.folded, beforeLines, nextLines, pos => tr.mapping.map(pos, -1));
    this.saveFolded();
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
    const ranges = hiddenBlockRanges(this.sections, this.folded)
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
    if (want.length !== have.length || want.some((block, i) => block !== have[i])) {
      setHiddenBlocks(view, merged);
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
    const lm = this.host.lineMarks();
    return sectionPendingChanges(section.headingIndex, section.lineEnd,
      this.lines.flatMap(line => lm.suggestionsOnLine(line.index).map(() => line.index)));
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

  /** The explicit section action captures these identities when its control is rendered. */
  sectionScope(lineIndex: number): SectionScope | null {
    const section = sectionByHeading(this.sections, lineIndex);
    return section ? captureSectionScope(section, this.lines) : null;
  }

  /**
   * Agree is offered only when every line is visible. Otherwise the control expands first.
   * The scope is captured here, at render, so a later insertion cannot join it.
   */
  sectionAgreement(lineIndex: number): (SectionAgreementOffer & { scope: SectionScope | null }) | null {
    const section = sectionByHeading(this.sections, lineIndex);
    if (!section) return null;
    const offer = sectionAgreementOffer(section, this.sections, this.folded);
    return { ...offer, scope: offer.allVisible ? captureSectionScope(section, this.lines) : null };
  }

  /** Expands this section and every collapsed section inside it. One Undo restores the folds. */
  showSectionLines(lineIndex: number): void {
    const section = sectionByHeading(this.sections, lineIndex);
    if (!section) return;
    const offer = sectionAgreementOffer(section, this.sections, this.folded);
    if (offer.allVisible || offer.collapsedHeadings.length === 0) return;
    const before = { folded: [...this.folded] };
    this.record('showed the section', () => { this.folded = new Set(before.folded); this.commit(); });
    for (const heading of offer.collapsedHeadings) {
      const collapsed = sectionByHeading(this.sections, heading);
      if (collapsed) this.folded.delete(collapsed.key);
    }
    this.commit();
  }

  toggle(headingIndex: number, options: { record?: boolean } = {}): void {
    const section = sectionByHeading(this.sections, headingIndex);
    if (!section) return;
    const wasFolded = this.folded.has(section.key);
    if (wasFolded) this.folded.delete(section.key); else this.folded.add(section.key);
    this.commit();
    if (options.record !== false) {
      const name = this.lines[section.headingIndex]?.text ?? 'section';
      const short = name.length > 40 ? `${name.slice(0, 40)}…` : name;
      this.record(`${wasFolded ? 'expanded' : 'collapsed'} “${short}”`, () => this.toggle(headingIndex, { record: false }));
    }
  }

  /** Puts a fold change on the one Undo stack (a fold is a person's action like any other). */
  private record(description: string, inverse: () => void): void {
    const stack = this.host.lineMarks().undoStack?.();
    if (!stack) return;
    let snapshot: { folded: string[] } | null = null;
    stack.pushSimple('fold', description, () => {
      snapshot = { folded: [...this.folded] };
      inverse();
      return { ok: true };
    }, () => {
      if (!snapshot) return { ok: false, reason: 'Could not redo that fold.' };
      this.folded = new Set(snapshot.folded);

      this.commit();
      return { ok: true };
    });
  }

  setFolded(headingIndex: number, folded: boolean): void {
    if (this.isFolded(headingIndex) !== folded) this.toggle(headingIndex);
  }

  /** Explicitly collapse every section. */
  foldAll(options: { record?: boolean } = {}): void {
    const before = { folded: [...this.folded] };
    if (options.record !== false) {
      this.record('folded every section', () => { this.folded = new Set(before.folded); this.commit(); });
    }
    this.folded = new Set(this.sections.map(section => section.key));

    this.commit();
  }

  /** Explicitly expand every section. */
  unfoldAll(options: { record?: boolean } = {}): void {
    const before = { folded: [...this.folded] };
    if (options.record !== false) {
      this.record('unfolded every section', () => { this.folded = new Set(before.folded); this.commit(); });
    }
    // Only this document's headings are stored under this key, so clearing it is safe.
    this.folded = new Set();

    this.commit();
  }

  /** Unfolds every folded section that hides the line. Returns true when something unfolded. */
  reveal(lineIndex: number): boolean {
    const ancestors = foldedAncestors(this.sections, this.folded, lineIndex);
    if (ancestors.length === 0) return false;
    // Revealing a line to go to it is the person asking for it: rule 1 makes it stick.
    for (const section of ancestors) { this.folded.delete(section.key); }

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

      const folded = stored;
      const total = this.sectionIssues(section.headingIndex);
      const bodyLines = section.lineEnd - section.headingIndex - 1;
      chip.dataset.heading = String(section.headingIndex);
      chip.dataset.folded = String(stored);
      chip.dataset.state = !loaded ? 'loading' : (total === 0 ? 'resolved' : 'issues');
      chip.setAttribute('aria-expanded', String(!folded));
      const countText = !loaded ? '…' : (total === 0 ? '✓' : String(total));
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
      const issuesText = !loaded ? 'Issues loading' : total === 0 ? 'no Issues: resolved'
        : `${total} open ${total === 1 ? 'change' : 'changes'}`;
      chip.setAttribute('aria-label', `${folded ? 'Unfold' : 'Fold'} section “${line.text.slice(0, 60)}”: ${issuesText}`);
      chip.title = `${stored ? `Collapsed: ${bodyLines} lines hidden. Click to expand.` : 'Click to collapse this section.'}
${issuesText}`;
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
    const foldedCount = this.sections.filter(section => this.folded.has(section.key)).length;
    const sig = `${foldedCount}|${this.sections.length}`;
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
      button('Collapse all sections', 'Collapse all sections', () => this.foldAll(), foldedCount === this.sections.length),
      button('Expand all sections', 'Expand all sections', () => this.unfoldAll(), foldedCount === 0),
    );
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
