/** The visit's disclosure choices. Mike, 2026-09-24, yfbqrau4 point 9 and P5. */
import type { EditorView } from '@milkdown/kit/prose/view';
import { TextSelection, type Transaction } from '@milkdown/kit/prose/state';
import { extractLines, type DocLine } from '../shared/line-marks';
import { captureSectionScope, computeSections, sectionByHeading, type DocSection, type SectionScope, type SectionAgreementOffer } from '../shared/folding';
import { FOLDED_VIEW_POLICY, foldedCountText, initialShown, mapShown, remapByContent, touchesHidden } from '../shared/folded-view';
import { ySyncPluginKey } from 'y-prosemirror';
import { foldViewKey, setFoldView, hiddenBlocks, transactionTouchesHidden, FOLD_RULE_EVENT, type FoldUpdate } from '../editor/plugins/fold-view';
import type { LineMarksUI } from './line-marks';
import './folding.css';

export interface FoldingHost { slug(): string | null; lineMarks(): LineMarksUI; documentLoaded(): boolean; }
const PHONE_QUERY = '(max-width: 700px)'; // Same breakpoint as the page's phone strip.
function isPhone(): boolean { return window.matchMedia(PHONE_QUERY).matches; }
type Snapshot = Pick<FoldUpdate, 'shown' | 'expanded' | 'context' | 'whole'>;

export class FoldingUI {
  private readonly layer = document.createElement('div');
  private sections: DocSection[] = [];
  private lines: DocLine[] = [];
  private started = false;
  private initialized = false;
  private timedOut = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private renderQueued = false;
  private applyQueued = false;
  private resizeObserver: ResizeObserver | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly snapshots = new Set<Snapshot>();

  constructor(private readonly host: FoldingHost) {
    this.layer.className = 'pfold-layer';
    this.layer.addEventListener('mousedown', e => e.preventDefault());
    this.layer.addEventListener('click', event => {
      if ((event.target as HTMLElement).closest('.accord-move-handle')) { event.preventDefault(); event.stopPropagation(); return; }
      const chip = (event.target as HTMLElement).closest<HTMLElement>('.pfold-chip');
      if (!chip) return;
      event.preventDefault(); event.stopPropagation(); this.toggle(Number(chip.dataset.heading));
    });
  }
  start(): void {
    if (this.started) return;
    this.started = true;
    document.body.classList.add('pfold-on');
    window.addEventListener('resize', this.queueRender);
    document.addEventListener(FOLD_RULE_EVENT, this.onRule);
    document.addEventListener('click', this.onLink, true);
    window.addEventListener('hashchange', this.onHash);
    this.timer = setTimeout(() => {
      if (!this.initialized) { this.timedOut = true; this.initialized = true; this.update({ ready: true, whole: true }); }
    }, FOLDED_VIEW_POLICY.loadTimeoutMs);
    this.unsubscribe = this.host.lineMarks().subscribe(() => this.sync());
    this.sync();
  }
  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    document.body.classList.remove('pfold-on');
    window.removeEventListener('resize', this.queueRender);
    document.removeEventListener(FOLD_RULE_EVENT, this.onRule);
    document.removeEventListener('click', this.onLink, true);
    window.removeEventListener('hashchange', this.onHash);
    this.unsubscribe?.(); this.resizeObserver?.disconnect(); this.layer.remove();
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private view(): EditorView | null { return this.host.lineMarks().editorView(); }
  private state() { const view = this.view(); return view ? foldViewKey.getState(view.state) : undefined; }
  private notify(): void { for (const listener of this.listeners) listener(); }
  private update(update: FoldUpdate): void {
    const view = this.view(); if (!view) return;
    setFoldView(view, update); this.refreshLines(); this.queueRender(); this.notify();
  }
  private refreshLines(): void {
    const view = this.view(); if (!view) return;
    this.lines = extractLines(view.state.doc);
    this.sections = computeSections(this.lines, view.state.doc.childCount);
  }
  private sync(): void {
    if (!this.started) return;
    this.refreshLines();
    const view = this.view(); if (!view) return;
    this.attachLayer(view);
    if (!this.applyQueued) {
      this.applyQueued = true;
      queueMicrotask(() => {
        this.applyQueued = false;
        if (!this.started) return;
        const lm = this.host.lineMarks(), current = this.view(); if (!current) return;
        this.refreshLines();
        const indices = new Set(lm.reviewViews()[FOLDED_VIEW_POLICY.shows].lines);
        const open = new Set(this.lines.filter(l => indices.has(l.index)).map(l => l.pos));
        const state = this.state();
        if (!this.initialized && lm.isLoaded() && this.host.documentLoaded()) {
          this.initialized = true;
          if (this.timer) clearTimeout(this.timer);
          this.update({ ready: true, whole: !FOLDED_VIEW_POLICY.startsFoldedEachVisit, shown: initialShown(current.state.doc, indices), expanded: new Set(), context: new Set(), open });
          this.onHash();
        } else if (state && (open.size !== state.open.size || [...open].some(p => !state.open.has(p)))) {
          this.update({ open, ...(!FOLDED_VIEW_POLICY.holdsStillWhileReading && !state.whole ? { shown: initialShown(current.state.doc, indices) } : {}) });
        } else { this.queueRender(); this.notify(); }
      });
    }
  }
  /** Undo snapshots also follow actual, applied document transactions by position. */
  mapTransaction(tr: Transaction): void {
    if (!tr.docChanged) return;
    // Yjs-origin transactions replace the whole document; see remapByContent.
    const whole = (tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined)?.isChangeOrigin === true || tr.getMeta("proofMove") === true;
    const before = extractLines(tr.before), after = extractLines(tr.doc);
    const remap = (positions: Set<number>) => whole ? remapByContent(positions, tr.before, tr.doc) : mapShown(positions, before, after, tr.mapping);
    for (const snapshot of this.snapshots) {
      if (snapshot.shown) snapshot.shown = remap(snapshot.shown);
      if (snapshot.context) snapshot.context = remap(snapshot.context);
      if (snapshot.expanded) snapshot.expanded = remap(snapshot.expanded);
    }
  }
  private snapshot(): Snapshot {
    const state = this.state();
    const snapshot = { shown: new Set(state?.shown), expanded: new Set(state?.expanded), context: new Set(state?.context), whole: state?.whole ?? false };
    this.snapshots.add(snapshot); return snapshot;
  }
  private action(description: string, update: FoldUpdate, record = true): void {
    const before = this.snapshot();
    this.update(update);
    if (!record) return;
    const after = this.snapshot();
    this.host.lineMarks().undoStack()?.pushSimple('fold', description,
      () => { this.update(before); return { ok: true }; }, () => { this.update(after); return { ok: true }; });
  }
  sectionList(): DocSection[] { return this.sections; }
  sectionIssues(index: number): number {
    const section = sectionByHeading(this.sections, index); if (!section) return 0;
    return this.host.lineMarks().reviewViews()['all-open'].lines.filter(i => i >= index && i < section.lineEnd).length;
  }
  hiddenLines(): ReadonlySet<number> {
    const s = this.state();
    return new Set(!s || s.whole || s.clean ? [] : this.lines.filter(l => !s.visible.has(l.pos)).map(l => l.index));
  }
  isHidden(index: number): boolean { return this.hiddenLines().has(index); }
  isWhole(): boolean { return this.state()?.whole ?? false; }
  toggleLabel(): string { return this.isWhole() ? 'Show only open items' : 'Show the whole Accord'; }
  countText(): string {
    if (!this.initialized) return 'Loading open items…';
    if (this.timedOut && (!this.host.lineMarks().isLoaded() || !this.host.documentLoaded())) return 'Open items did not load. Showing the whole Accord.';
    const views = this.host.lineMarks().reviewViews();
    const text = foldedCountText(this.lines.length, views['needs-you'].lines.length, views['all-open'].lines.length);
    return this.timedOut ? `${text} · Showing the whole Accord because open items loaded late.` : text;
  }
  isFolded(index: number): boolean {
    const s = this.state();
    return Boolean(s && !s.whole && !this.sections.some(section => section.headingIndex <= index && section.lineEnd > index && s.expanded.has(this.lines[section.headingIndex].pos)));
  }
  visibleLineFor(index: number): number {
    if (!this.isHidden(index)) return index;
    const ancestors = this.sections.filter(s => s.headingIndex < index && s.lineEnd > index && !this.isHidden(s.headingIndex));
    return ancestors.at(-1)?.headingIndex ?? this.lines.find(l => !this.isHidden(l.index))?.index ?? index;
  }
  sectionScope(index: number): SectionScope | null {
    const section = sectionByHeading(this.sections, index); return section ? captureSectionScope(section, this.lines) : null;
  }
  sectionAgreement(index: number): (SectionAgreementOffer & { scope: SectionScope | null }) | null {
    const section = sectionByHeading(this.sections, index); if (!section) return null;
    const allVisible = this.lines.slice(index, section.lineEnd).every(l => !this.isHidden(l.index));
    return { lineCount: section.lineEnd - index, allVisible, collapsedHeadings: allVisible ? [] : [index], scope: allVisible ? this.sectionScope(index) : null };
  }
  showSectionLines(index: number): void { this.setFolded(index, false); }
  toggle(index: number, options: { record?: boolean } = {}): void {
    const state = this.state(), line = this.lines[index]; if (!state || !line) return;
    const expanded = new Set(state.expanded), folding = !this.isFolded(index);
    // Leaving whole view through a chip preserves the other expanded sections.
    if (state.whole) for (const s of this.sections) expanded.add(this.lines[s.headingIndex].pos);
    if (folding) {
      // An expanded ancestor must not override this explicit local refold.
      for (const s of this.sections) if (s.headingIndex <= index && s.lineEnd > index) expanded.delete(this.lines[s.headingIndex].pos);
      const section = sectionByHeading(this.sections, index)!;
      for (const s of this.sections) if (s.headingIndex > index && s.headingIndex < section.lineEnd) expanded.delete(this.lines[s.headingIndex].pos);
      const context = new Set(state.context);
      for (const l of this.lines.slice(index, section.lineEnd)) context.delete(l.pos);
      // Preserve context outside the refolded section when its ancestor was expanded.
      for (const l of this.lines) if ((l.index < index || l.index >= section.lineEnd) && !this.isHidden(l.index)) context.add(l.pos);
      this.action(`folded “${line.text}”`, { whole: false, expanded, context }, options.record !== false);
    } else { expanded.add(line.pos); this.action(`unfolded “${line.text}”`, { whole: false, expanded }, options.record !== false); }
  }
  setFolded(index: number, folded: boolean): void { if (this.isFolded(index) !== folded) this.toggle(index); }
  foldAll(options: { record?: boolean } = {}): void {
    const view = this.view(); if (!view) return;
    this.action('showed only open items', { whole: false, shown: initialShown(view.state.doc, new Set(this.host.lineMarks().reviewViews()['all-open'].lines)), expanded: new Set(), context: new Set() }, options.record !== false);
  }
  unfoldAll(options: { record?: boolean } = {}): void { this.action('showed the whole Accord', { whole: true }, options.record !== false); }
  toggleWhole(): void { if (this.isWhole()) this.foldAll(); else this.unfoldAll(); }
  setClean(clean: boolean): void { if (this.state()?.clean !== clean) this.update({ clean }); }
  reveal(index: number): boolean {
    if (!this.isHidden(index)) return false;
    if (!FOLDED_VIEW_POLICY.jumpShowsLineOnly) { this.showSectionLines(this.visibleLineFor(index)); return true; }
    const shown = new Set(this.state()?.shown); shown.add(this.lines[index].pos);
    this.action('showed a passage', { shown }); return true;
  }
  private revealHash(hash: string): void {
    const view = this.view(); if (!view || !hash) return;
    let name: string; try { name = decodeURIComponent(hash.slice(1)); } catch { return; }
    const numbered = /^line-(\d+)$/.exec(name);
    let index = numbered ? Number(numbered[1]) - 1 : -1;
    if (index < 0) {
      const target = document.getElementById(name);
      if (target && view.dom.contains(target)) {
        const pos = view.posAtDOM(target, 0);
        index = this.lines.findIndex(l => pos >= l.pos && pos < l.pos + l.nodeSize);
      }
    }
    if (index < 0 || !this.lines[index]) return;
    this.reveal(index);
    requestAnimationFrame(() => (view.nodeDOM(this.lines[index]?.pos) as HTMLElement | null)?.scrollIntoView({ block: 'center' }));
  }
  private onHash = (): void => { this.revealHash(location.hash); };
  private onLink = (event: MouseEvent): void => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
    if (!link || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const url = new URL(link.href, location.href);
    if (url.origin === location.origin && url.pathname === location.pathname && url.hash) this.revealHash(url.hash);
  };
  private onRule = (event: Event): void => {
    const { from, to } = (event as CustomEvent<{ from: number; to: number }>).detail;
    const section = this.sections.find(s => s.headingIndex + 1 === from && s.lineEnd === to);
    if (section) { this.setFolded(section.headingIndex, false); return; }
    const shown = new Set(this.state()?.shown);
    for (const line of this.lines.slice(from, to)) shown.add(line.pos);
    this.action('showed hidden items', { shown });
  };
  positionHidden(pos: number): boolean {
    const s = this.state(); return Boolean(s && !s.whole && !s.clean && s.hidden.some(h => pos >= h.from && pos < h.to));
  }
  refuses(tr: Transaction): boolean {
    const s = this.state();
    return Boolean(FOLDED_VIEW_POLICY.refuseEditsTouchingHidden && s?.ready && !s.whole && !s.clean && transactionTouchesHidden(tr, s.hidden));
  }
  inputTouchesHidden(input: InputEvent): boolean {
    const view = this.view(), s = this.state();
    if ((input.target as HTMLElement | null)?.closest?.('[data-live-suggestion]')) return false;
    if (!view || !s?.ready || s.whole || s.clean || !FOLDED_VIEW_POLICY.refuseEditsTouchingHidden || input.inputType.startsWith('history')) return false;
    let { from, to } = view.state.selection;
    if (from === to && input.inputType.startsWith('delete')) {
      const at = this.lines.findIndex(l => from >= l.pos && from < l.pos + l.nodeSize);
      const cursor = view.state.selection.$from;
      // List entries have extra wrapper tokens. Test their neighbouring items directly.
      if (input.inputType.endsWith('Backward')) {
        if (cursor.parentOffset === 0 && this.isHidden(at - 1)) return true;
        from = Math.max(0, from - 1);
      } else if (input.inputType.endsWith('Forward')) {
        if (cursor.parentOffset === cursor.parent.content.size && this.isHidden(at + 1)) return true;
        to += 1;
      }
    }
    return touchesHidden(from, to, s.hidden);
  }
  arrow(event: KeyboardEvent): boolean {
    const view = this.view(), s = this.state();
    if (!view || !s?.ready || s.whole || s.clean || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return false;
    const { $head } = view.state.selection;
    const at = this.lines.findIndex(l => $head.pos >= l.pos && $head.pos < l.pos + l.nodeSize);
    if (at < 0) return false;
    const direction = event.key === 'ArrowUp' ? -1 : 1;
    if (!this.isHidden(at + direction)) return false;
    // Only intercept on the first/last visual row, preserving ordinary multiline navigation.
    const edge = direction < 0 ? $head.start() : $head.end();
    if (Math.abs(view.coordsAtPos(edge).top - view.coordsAtPos($head.pos).top) > 2) return false;
    let next = at + direction; while (next >= 0 && next < this.lines.length && this.isHidden(next)) next += direction;
    if (!this.lines[next]) return false;
    const target = this.lines[next];
    const pos = direction < 0 ? target.pos + target.nodeSize - 1 : target.pos + 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos), direction)).scrollIntoView());
    event.preventDefault(); return true;
  }
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
      const stored = this.isFolded(section.headingIndex);

      const folded = stored;
      const total = this.sectionIssues(section.headingIndex);
      const bodyLines = section.lineEnd - section.headingIndex - 1;
      chip.dataset.heading = String(section.headingIndex);
      chip.dataset.folded = String(stored);
      // The handle remains visible on every folded chip, independent of the pointer.
      queueMicrotask(() => {
        const old = chip!.querySelector('.accord-move-handle');
        if (!stored || phone) { old?.remove(); return; }
        const handle = old as HTMLElement ?? document.createElement('span');
        handle.className = 'accord-move-handle'; handle.dataset.moveLine = String(section.headingIndex);
        handle.textContent = '⠿'; handle.title = 'Drag to move this whole section';
        if (!old) chip!.append(handle);
      });
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
        : `${total} open ${total === 1 ? 'item' : 'items'}`;
      chip.setAttribute('aria-label', `${folded ? 'Unfold' : 'Fold'} section “${line.text.slice(0, 60)}”: ${issuesText}`);
      chip.title = `${stored ? `Folded section: ${bodyLines} items in its body. Click to unfold.` : 'Click to collapse this section.'}
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


  debugState(): Record<string, unknown> {
    const s = this.state(), view = this.view();
    return { ready: s?.ready, whole: s?.whole, timedOut: this.timedOut,
      sections: this.sections.map(section => ({ ...section, text: this.lines[section.headingIndex]?.text ?? '', folded: this.isFolded(section.headingIndex) })),
      folded: this.sections.filter(s => this.isFolded(s.headingIndex)).map(s => s.key),
      shown: this.lines.filter(l => !this.isHidden(l.index)).map(l => l.index),
      hidden: [...this.hiddenLines()], hiddenBlocks: view ? hiddenBlocks(view) : [], runs: s?.runs ?? [], count: this.countText() };
  }
}
