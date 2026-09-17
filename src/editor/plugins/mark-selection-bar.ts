import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

import { flag, suggestReplace } from './marks';
import type { MarkRange } from './marks';
import { openCommentComposer } from './mark-popover';
import { getCurrentActor } from '../actor';
import { shouldKeepCollapsedSelectionBarVisible } from './selection-bar-visibility';
import { isMobileTouch } from './mobile-detect';
import { shouldUseCommentUiV2 } from './comment-ui-mode';
import { canCommentInRuntime } from './share-permissions';

const markSelectionBarKey = new PluginKey('mark-selection-bar');
const CACHED_RANGE_TTL_MS = 12_000;
const BAR_INTERACTION_GRACE_MS = 250;

function getSelectionRange(view: EditorView): MarkRange | null {
  const { from, to } = view.state.selection;
  if (from === to) return null;
  return { from, to };
}

function quoteForRange(view: EditorView, range: MarkRange): string {
  return view.state.doc.textBetween(range.from, range.to, '\n', '\n');
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

const TOP_FIXED_OVERLAY_IDS = ['share-banner', 'readonly-banner', 'review-lock-banner', 'error-banner'] as const;

// Overlays the bar must never sit on top of: the top bars, the PlayMaker Marks panel (it owns the
// right-hand gutter) and the feedback chip.
const BLOCKING_OVERLAY_SELECTORS = [
  '#share-banner', '#readonly-banner', '#review-lock-banner', '#error-banner',
  '.pm-review-panel', '.soma-feedback-root',
] as const;

type Box = { top: number; bottom: number; left: number; right: number };

function getBlockingBoxes(): Box[] {
  const boxes: Box[] = [];
  for (const selector of BLOCKING_OVERLAY_SELECTORS) {
    for (const element of document.querySelectorAll(selector)) {
      if (!(element instanceof HTMLElement)) continue;
      if (element.hidden || element.closest('[hidden]')) continue;
      if (typeof element.getBoundingClientRect !== 'function') continue;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      boxes.push({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right });
    }
  }
  return boxes;
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function getTopViewportInset(margin: number): number {
  let inset = margin;
  for (const id of TOP_FIXED_OVERLAY_IDS) {
    const element = document.getElementById(id);
    if (!element) continue;
    const style = window.getComputedStyle(element);
    if (style.position !== 'fixed' && style.position !== 'sticky') continue;
    if (typeof element.getBoundingClientRect !== 'function') continue;
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0 || rect.bottom <= 0) continue;
    inset = Math.max(inset, Math.ceil(rect.bottom + margin));
  }
  return inset;
}

function getAnchorBox(view: EditorView, range: MarkRange) {
  const from = view.coordsAtPos(range.from);
  const to = view.coordsAtPos(range.to);
  return {
    top: Math.min(from.top, to.top),
    bottom: Math.max(from.bottom, to.bottom),
    left: Math.min(from.left, to.left),
    right: Math.max(from.right, to.right)
  };
}

function positionBar(bar: HTMLElement, view: EditorView, range: MarkRange): void {
  try {
    const anchorBox = getAnchorBox(view, range);
    if (typeof view.dom.getBoundingClientRect !== 'function') return;
    if (typeof bar.getBoundingClientRect !== 'function') return;
    const editorRect = view.dom.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const margin = 12;
    const dockGap = 16;
    const gap = 8;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const safeTop = getTopViewportInset(margin);
    const maxTop = Math.max(safeTop, viewportH - barRect.height - margin);
    const width = barRect.width;
    const height = barRect.height;
    const blocked = getBlockingBoxes();

    const place = (left: number, top: number) => ({
      left: clamp(left, margin, Math.max(margin, viewportW - width - margin)),
      top: clamp(top, safeTop, maxTop),
    });
    // A placement is usable when it stays in the viewport, keeps clear of the overlays, and
    // leaves the selected words themselves visible.
    const usable = (spot: { left: number; top: number }) => {
      const box = { left: spot.left, right: spot.left + width, top: spot.top, bottom: spot.top + height };
      if (box.top < safeTop - 1 || box.bottom > viewportH - margin + 1) return false;
      if (overlaps(box, { ...anchorBox })) return false;
      return !blocked.some(other => overlaps(box, other));
    };

    const center = (anchorBox.left + anchorBox.right) / 2;
    // Above the selection first, then below it, then the side gutters, all near the selection.
    const candidates = [
      place(center - width / 2, anchorBox.top - height - gap),
      place(center - width / 2, anchorBox.bottom + gap),
      place(editorRect.right + dockGap, anchorBox.top - 6),
      place(editorRect.left - dockGap - width, anchorBox.top - 6),
    ];
    const cost = (spot: { left: number; top: number }) => {
      const box = { left: spot.left, right: spot.left + width, top: spot.top, bottom: spot.top + height };
      return [...blocked, { ...anchorBox }].reduce((sum, other) => sum
        + Math.max(0, Math.min(box.right, other.right) - Math.max(box.left, other.left))
        * Math.max(0, Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top)), 0);
    };
    // Nothing fits cleanly on a very small window: take the placement that hides the least.
    const spot = candidates.find(usable) ?? [...candidates].sort((a, b) => cost(a) - cost(b))[0];
    bar.style.left = `${spot.left}px`;
    bar.style.top = `${spot.top}px`;
  } catch {
    // Ignore positioning errors for invalid positions.
  }
}

function isRangeValid(view: EditorView, range: MarkRange | null): range is MarkRange {
  if (!range) return false;
  return range.from >= 0 && range.to > range.from && range.to <= view.state.doc.content.size;
}

class MarkSelectionBarController {
  private view: EditorView;
  private bar: HTMLDivElement;
  private hintEl: HTMLDivElement;
  private lastRange: MarkRange | null = null;
  private cachedRange: MarkRange | null = null;
  private cachedAt = 0;
  private preserveCollapsedUntil = 0;
  private hintTimer: number | null = null;
  // The range whose bar was used already: it stays hidden until a different selection is made.
  private dismissedRange: MarkRange | null = null;

  private handleScroll = () => {
    if (this.lastRange) {
      positionBar(this.bar, this.view, this.lastRange);
    }
  };

  /** True when the browser itself is holding selected text inside the editor. */
  private hasLiveDomSelection(): boolean {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || !selection.toString().trim()) return false;
    const node = selection.anchorNode;
    return Boolean(node && typeof this.view.dom.contains === 'function' && this.view.dom.contains(node));
  }

  // ProseMirror keeps its state selection when the page is clicked outside the editor, so the
  // browser's own selection decides when the bar goes away.
  private handleSelectionChange = () => {
    this.cacheLiveSelection();
    this.update(this.view);
  };

  private handlePointerUp = () => {
    this.cacheLiveSelection();
  };

  private handleKeyUp = () => {
    this.cacheLiveSelection();
  };

  constructor(view: EditorView) {
    this.view = view;
    this.bar = document.createElement('div');
    this.bar.className = 'mark-selection-bar';
    this.bar.style.display = 'none';
    this.bar.addEventListener('pointerdown', event => {
      this.preserveBarDuringInteraction();
      const range = getSelectionRange(this.view);
      if (range) {
        this.rememberRange(range);
      }
      event.preventDefault();
      event.stopPropagation();
    });
    this.bar.addEventListener('touchend', () => {
      const range = getSelectionRange(this.view);
      if (range) {
        this.rememberRange(range);
      }
    });

    this.hintEl = document.createElement('div');
    this.hintEl.className = 'mark-selection-bar-hint';
    this.hintEl.style.display = 'none';

    const container = view.dom.parentElement ?? document.body;
    container.appendChild(this.bar);
    container.appendChild(this.hintEl);

    this.buildButtons();

    document.addEventListener('selectionchange', this.handleSelectionChange);
    view.dom.addEventListener('pointerup', this.handlePointerUp);
    view.dom.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('scroll', this.handleScroll);
    window.addEventListener('resize', this.handleScroll);
  }

  destroy(): void {
    document.removeEventListener('selectionchange', this.handleSelectionChange);
    this.view.dom.removeEventListener('pointerup', this.handlePointerUp);
    this.view.dom.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('scroll', this.handleScroll);
    window.removeEventListener('resize', this.handleScroll);
    if (this.hintTimer !== null) {
      window.clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
    this.hintEl.remove();
    this.bar.remove();
  }

  /** Hides the bar after Comment, Flag or Suggest, so it does not linger over the page. */
  private dismissAfterAction(): void {
    this.dismissedRange = this.lastRange ?? this.cachedRange;
    this.lastRange = null;
    this.cachedRange = null;
    this.cachedAt = 0;
    this.preserveCollapsedUntil = 0;
    this.bar.style.display = 'none';
    this.hintEl.style.display = 'none';
  }

  private isDismissed(range: MarkRange | null): boolean {
    if (!range || !this.dismissedRange) return false;
    return range.from === this.dismissedRange.from && range.to === this.dismissedRange.to;
  }

  update(view: EditorView): void {
    this.view = view;
    if (!canCommentInRuntime()) {
      this.bar.style.display = 'none';
      this.hintEl.style.display = 'none';
      return;
    }
    if (isMobileTouch() && shouldUseCommentUiV2()) {
      this.bar.style.display = 'none';
      this.hintEl.style.display = 'none';
      return;
    }
    const range = getSelectionRange(view);
    if (range && !this.hasLiveDomSelection() && !this.shouldPreserveCollapsedVisibility()) {
      this.bar.style.display = 'none';
      this.hintEl.style.display = 'none';
      return;
    }
    if (this.isDismissed(range)) {
      this.bar.style.display = 'none';
      return;
    }
    if (range) this.dismissedRange = null;
    if (!range) {
      if (this.dismissedRange) {
        this.bar.style.display = 'none';
        return;
      }
      const cachedRange = this.getCachedRange();
      if (
        shouldKeepCollapsedSelectionBarVisible({
          hasCachedRange: Boolean(cachedRange),
          hasLastRange: Boolean(this.lastRange),
          preserveCollapsedVisibility: this.shouldPreserveCollapsedVisibility()
        }) && this.lastRange
      ) {
        if (isRangeValid(view, this.lastRange)) {
          this.rememberRange(this.lastRange);
        }
        this.bar.style.display = 'flex';
        positionBar(this.bar, view, this.lastRange);
        return;
      }
      this.lastRange = null;
      this.bar.style.display = 'none';
      return;
    }

    this.rememberRange(range);
    this.bar.style.display = 'flex';
    positionBar(this.bar, view, range);
  }

  private cacheLiveSelection(): void {
    const range = getSelectionRange(this.view);
    if (!range) return;
    this.rememberRange(range);
  }

  private rememberRange(range: MarkRange): void {
    this.lastRange = range;
    this.cachedRange = range;
    this.cachedAt = Date.now();
  }

  private preserveBarDuringInteraction(): void {
    this.preserveCollapsedUntil = Date.now() + BAR_INTERACTION_GRACE_MS;
  }

  private shouldPreserveCollapsedVisibility(): boolean {
    return Date.now() <= this.preserveCollapsedUntil;
  }

  private getCachedRange(): MarkRange | null {
    if (!this.cachedRange) return null;
    if ((Date.now() - this.cachedAt) > CACHED_RANGE_TTL_MS) {
      this.cachedRange = null;
      this.cachedAt = 0;
      return null;
    }
    if (!isRangeValid(this.view, this.cachedRange)) {
      this.cachedRange = null;
      this.cachedAt = 0;
      return null;
    }
    return this.cachedRange;
  }

  private getActionRange(): MarkRange | null {
    const live = getSelectionRange(this.view);
    if (isRangeValid(this.view, live)) {
      this.rememberRange(live);
      return live;
    }

    const cached = this.getCachedRange();
    if (cached) return cached;

    if (isRangeValid(this.view, this.lastRange)) return this.lastRange;

    this.showHint('Select text first');
    return null;
  }

  private showHint(message: string): void {
    this.hintEl.textContent = message;
    this.hintEl.style.display = 'block';
    if (this.lastRange) {
      positionBar(this.hintEl, this.view, this.lastRange);
      this.hintEl.style.top = `${parseFloat(this.hintEl.style.top || '0') + 44}px`;
    }
    if (this.hintTimer !== null) {
      window.clearTimeout(this.hintTimer);
    }
    this.hintTimer = window.setTimeout(() => {
      this.hintEl.style.display = 'none';
      this.hintTimer = null;
    }, 1200);
  }

  private buildButtons(): void {
    this.bar.innerHTML = '';

    const makeButton = (label: string, onClick: () => void) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('pointerdown', (event) => {
        this.preserveBarDuringInteraction();
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener('click', () => {
        onClick();
      });
      return button;
    };

    const commentButton = makeButton('Comment', () => {
      if (!canCommentInRuntime()) return;
      const range = this.getActionRange();
      if (!range) return;
      openCommentComposer(this.view, range, getCurrentActor());
      this.dismissAfterAction();
    });

    const flagButton = makeButton('Flag', () => {
      if (!canCommentInRuntime()) return;
      const range = this.getActionRange();
      if (!range) return;
      const quote = quoteForRange(this.view, range);
      flag(this.view, quote, getCurrentActor(), undefined, range);
      this.dismissAfterAction();
    });

    const suggestButton = makeButton('Suggest', () => {
      if (!canCommentInRuntime()) return;
      const range = this.getActionRange();
      if (!range) return;
      const original = this.view.state.doc.textBetween(range.from, range.to, '\n', '\n');
      const replacement = window.prompt('Suggest replacement', original);
      if (replacement === null || replacement === original) return;
      const quote = quoteForRange(this.view, range);
      suggestReplace(this.view, quote, getCurrentActor(), replacement, range);
      this.dismissAfterAction();
    });

    this.bar.appendChild(commentButton);
    this.bar.appendChild(flagButton);
    this.bar.appendChild(suggestButton);
  }
}

export const markSelectionBarPlugin = $prose(() => {
  return new Plugin({
    key: markSelectionBarKey,
    view(view) {
      return new MarkSelectionBarController(view);
    }
  });
});
