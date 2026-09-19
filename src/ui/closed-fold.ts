/**
 * Proof Documents — closed Issues fold for the person who closed them (the page side).
 * State and policy: src/shared/closed-fold.ts. Decorations: src/editor/plugins/closed-fold-view.ts.
 *
 * - Per viewer: localStorage, keyed by the document and the viewer's actor.
 * - A folded line is one thin summary row ("✓ agreed — first words…"). A click or tap on it opens
 *   it (the click does not place a caret: the row is not text to edit until it is open).
 * - "Unfold closed" / "Fold closed" in the right rail (phones: the "This line" sheet).
 *
 * Authorship: Claude Opus 5 (worker proof-hover), 2026-09-19, from Mike's words that day.
 */
import type { EditorView } from '@milkdown/kit/prose/view';
import { actorKey } from '../shared/line-marks';
import { CLOSED_FOLD_POLICY, ClosedFoldState, type ClosedLineInput, type ClosureKind, type FoldedLine } from '../shared/closed-fold';
import { closedFoldViewKey, setClosedFoldDecorations, type ClosedFoldSpec } from '../editor/plugins/closed-fold-view';
import type { LineMarksUI } from './line-marks';
import './closed-fold.css';

export interface ClosedFoldHost {
  slug(): string | null;
  lineMarks(): LineMarksUI;
  /** Called right after the folds changed the page's layout (the reading walk re-measures). */
  onApplied?(): void;
}

export class ClosedFoldUI {
  /** The rail control ("Unfold closed (N)" / "Fold closed"). */
  readonly controlsEl = document.createElement('div');
  private state = new ClosedFoldState();
  private loadedKey: string | null = null;
  private inputs: ClosedLineInput[] = [];
  private foldedNow: FoldedLine[] = [];
  private appliedSig = '';
  private applyQueued = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeClosure: (() => void) | null = null;
  private swallowUntil = 0;
  /** The reader's focus line (CLOSED_FOLD_POLICY.deferWhileFocused). */
  private focus = -1;
  /** Lines folded on the page now (a new fold waits until its line is out of view). */
  private shown = new Set<number>();
  /** Closures made after this page opened wait until their line is out of view. */
  private readonly pageStart = Date.now();
  private controlsSig = '';
  /** Test hook: closures this page recorded. */
  private readonly closures: Array<{ index: number; kind: ClosureKind }> = [];

  constructor(private readonly host: ClosedFoldHost) {
    this.controlsEl.className = 'pclose-controls';
    this.controlsEl.hidden = true;
  }

  start(): void {
    if (this.started || !CLOSED_FOLD_POLICY.enabled) return;
    this.started = true;
    const lm = this.host.lineMarks();
    this.unsubscribe = lm.subscribe(() => this.sync());
    this.unsubscribeClosure = lm.onClosure((index, kind) => this.onClosure(index, kind));
    // Window capture runs before the editor's and the editing guard's document listeners.
    window.addEventListener('pointerdown', this.onPointerDown, true);
    window.addEventListener('mousedown', this.onSwallow, true);
    window.addEventListener('click', this.onSwallow, true);
    window.addEventListener('touchend', this.onSwallow, true);
    window.addEventListener('scroll', this.onScroll, { passive: true });
    this.sync();
  }

  stop(): void {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribeClosure?.();
    window.removeEventListener('pointerdown', this.onPointerDown, true);
    window.removeEventListener('mousedown', this.onSwallow, true);
    window.removeEventListener('click', this.onSwallow, true);
    window.removeEventListener('touchend', this.onSwallow, true);
    window.removeEventListener('scroll', this.onScroll);
    if (this.settleTimer) clearTimeout(this.settleTimer);
  }

  private view(): EditorView | null { return this.host.lineMarks().editorView(); }

  private storageKey(): string | null {
    const slug = this.host.slug();
    return slug ? `${CLOSED_FOLD_POLICY.storagePrefix}${slug}:${actorKey(this.host.lineMarks().me())}` : null;
  }

  private load(): void {
    const key = this.storageKey();
    if (key === this.loadedKey) return;
    this.loadedKey = key;
    let raw: unknown = null;
    try { raw = key ? JSON.parse(localStorage.getItem(key) || 'null') : null; } catch { raw = null; }
    this.state = ClosedFoldState.fromJSON(raw);
  }

  private save(): void {
    const key = this.storageKey();
    if (!key) return;
    try {
      const json = this.state.toJSON();
      if (json.records.length === 0 && !json.showAll) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(json));
    } catch { /* optional */ }
  }

  private readInputs(): ClosedLineInput[] {
    const lm = this.host.lineMarks();
    return lm.lineList().map(line => ({
      index: line.index,
      key: `${line.hash}:${line.occurrence}`,
      kind: line.kind,
      text: line.text,
      open: lm.openItemsOnLine(line.index),
    }));
  }

  private onClosure(index: number, kind: ClosureKind): void {
    this.load();
    const line = this.host.lineMarks().lineList()[index];
    if (!line) return;
    this.closures.push({ index, kind });
    this.state.note(index, `${line.hash}:${line.occurrence}`, kind, Date.now());
    this.save();
    this.scheduleSettle();
  }

  private scheduleSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    const wait = this.state.nextSettleIn(Date.now());
    if (wait === null) return;
    this.settleTimer = setTimeout(() => { this.settleTimer = null; this.sync(); }, wait + 20);
  }

  /** Lines or marks changed (or a closure settled): settle, reopen, and re-apply the fold. */
  sync(): void {
    if (!this.started) return;
    const lm = this.host.lineMarks();
    if (!lm.isLoaded() || !this.view()) return;
    this.load();
    this.inputs = this.readInputs();
    if (this.state.sync(this.inputs, Date.now())) this.save();
    this.foldedNow = this.foldable();
    this.scheduleSettle();
    this.queueApply();
    this.renderControls();
  }

  private foldable(): FoldedLine[] {
    let all = this.state.folded(this.inputs);
    // A line already folded stays folded when the reader comes back to it (click to open).
    if (CLOSED_FOLD_POLICY.deferWhileFocused) all = all.filter(f => f.index !== this.focus || this.shown.has(f.index));
    if (CLOSED_FOLD_POLICY.foldOnlyOutOfView) {
      const fresh = new Set(this.state.list().filter(r => r.closedAt >= this.pageStart).map(r => r.key));
      const idle = !this.scrolling();
      all = all.filter(f => !fresh.has(f.key) || this.shown.has(f.index) || (idle && !this.inView(f.index)));
    }
    return all;
  }

  /** The line's block intersects the viewport. */
  private inView(index: number): boolean {
    const view = this.view();
    const line = this.host.lineMarks().lineList()[index];
    if (!view || !line) return false;
    const dom = view.nodeDOM(line.pos) as HTMLElement | null;
    if (!dom || typeof dom.getBoundingClientRect !== 'function') return false;
    const r = dom.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  }

  private lastScrollAt = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private scrolling(): boolean { return performance.now() - this.lastScrollAt < CLOSED_FOLD_POLICY.foldIdleMs; }

  /** New folds wait for scrolling to pause (CLOSED_FOLD_POLICY.foldIdleMs), then apply out of view. */
  private onScroll = (): void => {
    if (!this.started) return;
    this.lastScrollAt = performance.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const before = this.foldedNow.map(f => f.index).join(',');
      this.foldedNow = this.foldable();
      if (this.foldedNow.map(f => f.index).join(',') !== before) { this.queueApply(); this.renderControls(); }
    }, CLOSED_FOLD_POLICY.foldIdleMs + 20);
  };

  /** The reading walk's focus line moved (hover, caret, scroll, keys). */
  setFocusLine(index: number): void {
    if (index === this.focus) return;
    this.focus = index;
    if (!this.started) return;
    const before = this.foldedNow.map(f => f.index).join(',');
    this.foldedNow = this.foldable();
    if (this.foldedNow.map(f => f.index).join(',') !== before) { this.queueApply(); this.renderControls(); }
  }

  private queueApply(): void {
    if (this.applyQueued) return;
    this.applyQueued = true;
    // This can run inside the editor's view update: dispatch the decorations afterwards.
    queueMicrotask(() => { this.applyQueued = false; this.apply(); });
  }

  private apply(): void {
    const view = this.view();
    if (!view) return;
    const lines = this.host.lineMarks().lineList();
    const specs: ClosedFoldSpec[] = [];
    for (const folded of this.foldedNow) {
      const line = lines[folded.index];
      if (!line) continue;
      specs.push({ lineIndex: line.index, pos: line.pos, nodeSize: line.nodeSize, summary: folded.summary });
    }
    this.shown = new Set(specs.map(s => s.lineIndex));
    const sig = specs.map(s => `${s.lineIndex}@${s.pos}+${s.nodeSize}:${s.summary}`).join('|');
    const present = closedFoldViewKey.getState(view.state)?.find().length ?? 0;
    if (sig === this.appliedSig && present === specs.length) return;
    this.appliedSig = sig;
    setClosedFoldDecorations(view, specs);
    this.host.onApplied?.();
  }

  // --------------------------------------------------------------------------
  // Opening a folded line
  // --------------------------------------------------------------------------

  private foldedTarget(target: EventTarget | null): HTMLElement | null {
    const node = target as HTMLElement | null;
    if (!node || typeof node.closest !== 'function') return (target as Node | null)?.parentElement?.closest?.('.ProseMirror .pclose-folded') ?? null;
    return node.closest('.ProseMirror .pclose-folded');
  }

  private onPointerDown = (event: PointerEvent): void => {
    const row = this.foldedTarget(event.target);
    if (!row) return;
    event.preventDefault();
    event.stopPropagation();
    this.swallowUntil = performance.now() + 450;
    this.expandLine(Number(row.dataset.pcloseLine));
  };

  /** The compatibility mouse / click / touchend of the press that opened a line: no caret, no popover. */
  private onSwallow = (event: Event): void => {
    if (performance.now() > this.swallowUntil) return;
    const node = event.target as HTMLElement | null;
    if (!node?.closest?.('.ProseMirror')) return;
    event.preventDefault();
    event.stopPropagation();
    // A cancelled touchend means no click follows: the press is over either way.
    if (event.type === 'click' || event.type === 'touchend') this.swallowUntil = 0;
  };

  /** Opens one folded line (by its line index). */
  expandLine(index: number): boolean {
    const folded = this.foldedNow.find(f => f.index === index);
    if (!folded || !this.state.expand(folded.key)) return false;
    this.save();
    this.sync();
    this.apply();
    return true;
  }

  unfoldAll(): void { this.state.unfoldAll(); this.save(); this.sync(); this.apply(); }
  foldAll(): void {
    this.state.foldAll();
    this.save();
    // Asked for by the reader: every closed line folds now, in view or not.
    this.shown = new Set(this.state.folded(this.inputs).map(f => f.index));
    this.sync();
    this.apply();
  }

  private renderControls(): void {
    const folded = this.foldedNow.length;
    const open = this.state.expandedCount();
    const sig = `${folded}|${open}|${this.state.showAll}`;
    if (sig === this.controlsSig) return;
    this.controlsSig = sig;
    this.controlsEl.replaceChildren();
    this.controlsEl.hidden = folded === 0 && open === 0;
    if (this.controlsEl.hidden) return;
    const label = document.createElement('span');
    label.className = 'pclose-controls-label';
    label.textContent = folded ? `${folded} closed ${folded === 1 ? 'line' : 'lines'} folded` : `${open} closed ${open === 1 ? 'line' : 'lines'} open`;
    this.controlsEl.append(label);
    if (folded) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'pclose-unfold'; b.textContent = 'Unfold closed';
      b.title = 'Show every line you closed in full (Fold closed puts them back).';
      b.onclick = () => this.unfoldAll();
      this.controlsEl.append(b);
    }
    if (open) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'pclose-refold'; b.textContent = 'Fold closed';
      b.title = 'Fold every line you closed again.';
      b.onclick = () => this.foldAll();
      this.controlsEl.append(b);
    }
  }

  debugState(): Record<string, unknown> {
    return {
      folded: this.foldedNow.map(f => ({ index: f.index, summary: f.summary, kind: f.kind })),
      records: this.state.list(),
      showAll: this.state.showAll,
      closures: [...this.closures],
      policy: CLOSED_FOLD_POLICY,
    };
  }
}
