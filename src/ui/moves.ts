/** Desktop-only pointer moves. No native ProseMirror text drag, hover action or view persistence. */
import type { EditorView } from '@milkdown/kit/prose/view';
import { MOVE_POLICY, movingUnit, isValidDrop, dropTargets, placePosition, type MovePlace } from '../shared/moves';
import { extractLines, type DocLine } from '../shared/line-marks';
import { isWriting } from '../editor/editing-guard';
import './moves.css';

export interface MovesHost {
  view(): EditorView | null; focus(): number; folded(line: number): boolean; canMove(): boolean;
  propose(line: DocLine, place: MovePlace, section: boolean): void;
  navigate(line: number): void; notice(message: string): void;
}
export class MovesUI {
  private outline: HTMLElement | null = null;
  private line = document.createElement('div');
  private active: { source: DocLine; section: boolean; x: number; y: number; doc: unknown; started: boolean; place: MovePlace | null } | null = null;
  private frame = 0;
  private pointerY = 0;
  private pointerX = 0;
  private scrollHost: HTMLElement | null = null;
  constructor(private host: MovesHost) {
    this.line.className = 'accord-drop-line'; this.line.hidden = true; document.body.append(this.line);
    document.addEventListener('pointerdown', this.down, true);
    document.addEventListener('pointermove', this.move, true);
    document.addEventListener('pointerup', this.up, true);
    document.addEventListener('pointercancel', this.cancel, true);
    document.addEventListener('keydown', this.key, true);
    window.addEventListener('blur', this.cancel);
  }
  isOutline(): boolean { return this.outline !== null; }
  toggleOutline(): void {
    if (this.outline) { this.outline.remove(); this.outline = null; document.body.classList.remove('accord-outline-on'); return; }
    const view = this.host.view(); if (!view) return;
    this.outline = document.createElement('div'); this.outline.className = 'accord-item-outline';
    this.outline.setAttribute('aria-label', 'Document outline');
    view.dom.parentElement!.append(this.outline); document.body.classList.add('accord-outline-on'); this.refresh();
  }
  refresh(): void {
    if (!this.outline) return;
    const view = this.host.view(); if (!view) return;
    const used = new Set<number>();
    let headingLevel = 0;
    const rows = extractLines(view.state.doc).flatMap(l => {
      const unit = movingUnit(view.state.doc, l); if (!unit || used.has(unit.from)) return [];
      used.add(unit.from);
      if (l.level) headingLevel = l.level;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'accord-outline-item';
      b.dataset.moveLine = String(l.index); b.dataset.moveSurface = 'outline';
      b.style.paddingLeft = `${12 + (unit.depth - 1 + (l.level ? l.level - 1 : headingLevel)) * MOVE_POLICY.outlineIndentPx}px`;
      b.textContent = l.text || '(empty item)'; b.title = l.text;
      b.onclick = () => { this.toggleOutline(); this.host.navigate(l.index); };
      return [b];
    });
    this.outline.replaceChildren(...rows);
  }
  private desktop(): boolean { return window.innerWidth >= MOVE_POLICY.desktopMinWidth; }
  private down = (e: PointerEvent): void => {
    if (!this.desktop() || !this.host.canMove() || e.button !== 0 || e.pointerType === 'touch') return;
    const target = e.target as HTMLElement;
    const control = target.closest<HTMLElement>('[data-move-line], .anv-issue[data-line]');
    if (!control) return;
    const view = this.host.view(); if (!view) return;
    const index = Number(control.dataset.moveLine ?? control.dataset.line), source = extractLines(view.state.doc)[index];
    if (!source) return;
    const section = source.kind === 'heading' && (control.matches('.anv-issue') || this.host.folded(index));
    this.active = { source, section, x: e.clientX, y: e.clientY, doc: view.state.doc, started: false, place: null };
    this.pointerY = e.clientY; this.pointerX = e.clientX;
    this.scrollHost = view.dom.parentElement;
    while (this.scrollHost && this.scrollHost.scrollHeight <= this.scrollHost.clientHeight) this.scrollHost = this.scrollHost.parentElement;
    // Handles do not set the text caret or toggle their containing fold chip.
    if (target.closest('.accord-move-handle')) { e.preventDefault(); e.stopImmediatePropagation(); }
  };
  private move = (e: PointerEvent): void => {
    const active = this.active; if (!active) return;
    if (!active.started && Math.hypot(e.clientX - active.x, e.clientY - active.y) < MOVE_POLICY.dragThresholdPx) return;
    active.started = true; this.pointerY = e.clientY; this.pointerX = e.clientX;
    e.preventDefault(); e.stopImmediatePropagation();
    document.body.classList.add('accord-moving');
    if (!this.frame) this.frame = requestAnimationFrame(this.scroll);
    this.locate(e.clientX, e.clientY);
  };
  private locate(x: number, y: number): void {
    const active = this.active, view = this.host.view(); if (!active || !view) return;
    active.place = null; this.line.hidden = true;
    if (view.state.doc !== active.doc) return;
    const unit = movingUnit(view.state.doc, active.source, active.section); if (!unit) return;
    const lines = extractLines(view.state.doc);
    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>('.anv-issue, .accord-outline-item');
    let candidates: { place: MovePlace; rect: DOMRect; y: number; distance: number }[] = [];
    if (hit) {
      const line = lines[Number(hit.dataset.line ?? hit.dataset.moveLine)];
      if (line) {
        const rect = hit.getBoundingClientRect(), side = y < (rect.top + rect.bottom) / 2 ? 'before' : 'after';
        const section = line.kind === 'heading' && (hit.matches('.anv-issue') || this.host.folded(line.index));
        candidates.push({ place: { line, side, section }, rect, y: side === 'before' ? rect.top : rect.bottom, distance: 0 });
      }
    } else if (!this.outline) {
      for (const line of lines) {
        const target = movingUnit(view.state.doc, line, this.host.folded(line.index));
        const dom = target ? view.nodeDOM(target.from) as HTMLElement | null : null;
        if (!dom?.getBoundingClientRect) continue;
        const rect = dom.getBoundingClientRect(); if (!rect.height || x < rect.left - 60 || x > rect.right + 60) continue;
        for (const side of ['before', 'after'] as const) {
          const edge = side === 'before' ? rect.top : rect.bottom;
          candidates.push({ place: { line, side, section: line.kind === 'heading' && this.host.folded(line.index) }, rect, y: edge, distance: Math.abs(edge - y) });
        }
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    const c = candidates[0]; if (!c || c.distance > MOVE_POLICY.maxDropDistancePx) return;
    const pos = placePosition(view.state.doc, c.place);
    if (pos === null || !isValidDrop(view.state.doc, unit, pos)) return;
    active.place = c.place;
    Object.assign(this.line.style, { top: `${c.y}px`, left: `${c.rect.left}px`, width: `${c.rect.width}px` });
    this.line.hidden = false;
  }
  private scroll = (): void => {
    this.frame = 0;
    if (!this.active?.started) return;
    const rect = this.scrollHost?.getBoundingClientRect();
    const top = Math.max(0, rect?.top ?? 0), bottom = Math.min(innerHeight, rect?.bottom ?? innerHeight);
    const delta = this.pointerY < top + MOVE_POLICY.edgeScrollPx ? -MOVE_POLICY.edgeScrollSpeedPx
      : this.pointerY > bottom - MOVE_POLICY.edgeScrollPx ? MOVE_POLICY.edgeScrollSpeedPx : 0;
    if (delta) { if (this.scrollHost) this.scrollHost.scrollTop += delta; else window.scrollBy(0, delta); this.locate(this.pointerX, this.pointerY); }
    this.frame = requestAnimationFrame(this.scroll);
  };
  private up = (e: PointerEvent): void => {
    const a = this.active; if (!a) return;
    if (a.started) {
      e.preventDefault(); e.stopImmediatePropagation();
      // Suppress the synthetic click that would open a fold or enter writing after dropping.
      const suppress = (event: MouseEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
      document.addEventListener('click', suppress, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', suppress, true), 0);
      if (a.place) this.propose(a.source, a.place, a.section);
    }
    this.cancel();
  };
  private propose(source: DocLine, place: MovePlace, section: boolean): void {
    try { this.host.propose(source, place, section); this.refresh(); }
    catch (e) { this.host.notice(e instanceof Error ? e.message : 'The move could not be proposed.'); }
  }
  private cancel = (): void => {
    this.active = null; this.line.hidden = true; document.body.classList.remove('accord-moving');
    cancelAnimationFrame(this.frame); this.frame = 0;
  };
  private key = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && (this.active || this.outline)) {
      e.preventDefault(); e.stopImmediatePropagation(); this.cancel(); if (this.outline) this.toggleOutline(); return;
    }
    if (!this.desktop() || !this.host.canMove() || !e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey || e.isComposing
      || ![MOVE_POLICY.keyboard.up, MOVE_POLICY.keyboard.down].includes(e.key as any)) return;
    if ((e.target as HTMLElement)?.closest('input, textarea, select, .accord-draft') || isWriting()) return;
    const view = this.host.view(); if (!view) return;
    const control = (e.target as HTMLElement)?.closest<HTMLElement>('.accord-outline-item, .anv-issue');
    const focus = control ? Number(control.dataset.moveLine ?? control.dataset.line) : this.host.focus();
    const lines = extractLines(view.state.doc), source = lines[focus]; if (!source) return;
    const section = source.kind === 'heading' && (control?.matches('.anv-issue') || this.host.folded(source.index));
    const unit = movingUnit(view.state.doc, source, section); if (!unit) return;
    const targets = dropTargets(view.state.doc, unit);
    const pos = e.key === MOVE_POLICY.keyboard.up ? targets.filter(p => p < unit.from).at(-1) : targets.find(p => p > unit.to);
    e.preventDefault(); e.stopImmediatePropagation();
    if (pos === undefined) return;
    for (const line of lines) for (const side of ['before', 'after'] as const) {
      const place = { line, side };
      if (placePosition(view.state.doc, place) === pos) { this.propose(source, place, section); return; }
    }
  };
  destroy(): void {
    this.cancel(); this.outline?.remove(); this.line.remove(); document.body.classList.remove('accord-outline-on');
    document.removeEventListener('pointerdown', this.down, true); document.removeEventListener('pointermove', this.move, true);
    document.removeEventListener('pointerup', this.up, true); document.removeEventListener('pointercancel', this.cancel, true);
    document.removeEventListener('keydown', this.key, true); window.removeEventListener('blur', this.cancel);
  }
}
