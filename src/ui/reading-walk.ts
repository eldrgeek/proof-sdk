/**
 * Proof Documents Step 1b — the reading layout and the reading walk.
 *
 * Authorship: requirements by Mike Wolf ("Reading and marking", 2026-09-18) with the COS's
 * decisions for the gaps; built by Claude Opus 5 (worker reading-walk), 2026-09-18.
 *
 * Layout (desktop): a left rail with the team's documents, the document in a readable centre
 * column, and a right rail that holds the focus line's mark box, the changes on that line, and
 * (PlayMaker style) the Marks panel. Both rails collapse. Phones (<= 700 px): one column; the
 * rails open as bottom sheets from the ⋯ menu, and a margin dot opens Step 1's mark sheet.
 *
 * The walk (state in src/shared/reading-walk.ts): the focus line is the line under the reading
 * line (where the first line sits when the page is at the top). Scrolling moves it; a line the
 * reader dwelt on is marked Seen; a line with pending marks holds the page while each scroll
 * gesture steps to the next mark; scrolling past a suggestion accepts it provisionally (only in
 * this browser tab and its session storage) until an explicit action commits it.
 * Keys, only while nobody is typing: A agree, R reject (reason field), J / ↓ next, K / ↑ back.
 * Step B3: on a line that carries an ask, Y answers Yes, N No and T Not yet (N and T open the
 * reason field first). Answering an ask is an explicit action (it commits scroll-accepts above).
 */
import type { Mark, CommentData, ReplaceData } from '../formats/marks';
import { getActorName, getMarkColor } from '../formats/marks';
import { actorKey, isAiActor, type DocLine } from '../shared/line-marks';
import { UNCERTAIN_POLICY, WHY_POLICY } from '../shared/review-aids';
import { BUNDLE_POLICY, describeBundle, type BundleView } from '../shared/bundles';
import { EXPLAIN_POLICY } from '../shared/explain';
import { ASK_POLICY, type AskChoice } from '../shared/asks';
import { GestureGate, READING_WALK, ReadingWalk, countWords, dwellMsFor, type WalkLine, type WalkMark, type WalkSnapshot } from '../shared/reading-walk';
import type { SinceItem, SinceYouReport, RingerItem } from '../shared/alignment';
import type { LineMarksUI, MarkBox } from './line-marks';
import { isOpenReviewMark, type PlayMakerReview, type ReviewAction } from './playmaker-review';
import { editingRemainingMs, installEditingGuard, isEditing, onEditingActivity } from '../editor/editing-guard';
import { ProxyMarksUI } from './proxy-marks';
import { TIER_POLICY } from '../shared/line-tiers';
import './reading-walk.css';

/**
 * Editing first (Mike, 2026-09-19). While the person edits (src/editor/editing-guard.ts), the
 * walk never moves the view: no scroll-driven focus, stepping, barrier snap or scroll-accept.
 * The focus line follows the caret instead, so the rail shows the line being edited.
 */
export const READING_EDIT_POLICY = {
  /** The focus line follows the caret while the person edits. */
  focusFollowsCaret: true,
  /**
   * A click in the text on a comment or suggestion counts as an explicit reading action (it
   * commits the scroll-accepts above it). Off: a click in the text is for editing only.
   */
  textClickIsExplicitAction: false,
} as const;

export interface ReadingWalkHost {
  slug(): string | null;
  actor(): string;
  lineMarks(): LineMarksUI;
  /** Every review mark in the document (the editor's marks state). */
  marks(): Mark[];
  /** The editor's accept / reject / reply / resolve bridge (throws with a message on failure). */
  decide(ids: string[], action: ReviewAction, text?: string): void;
  /** The PlayMaker Marks panel owner, when the page has one. */
  playmaker(): PlayMakerReview | null;
  /** Current review style ('proof' | 'playmaker'). */
  reviewStyle(): string;
  /** Step B2: lines inside folded sections (the walk steps over them). */
  hiddenLines?(): ReadonlySet<number>;
  /** Step B2: the visible line that stands for a hidden one (its folded heading). */
  visibleLineFor?(lineIndex: number): number;
}

const PHONE_QUERY = '(max-width: 700px)';
const RAIL_STATE_KEY = 'proof:reading-rails';
/** Step B3b: the reader's reading rate (words per second), per browser. */
const RATE_KEY = 'proof:reading-rate';
/** Step B3b: skims are batched: one request per this long of scrolling. */
const SKIM_FLUSH_MS = 400;

function savedRate(): number {
  try {
    const raw = localStorage.getItem(RATE_KEY);
    if (raw === null) return READING_WALK.WORDS_PER_SECOND;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : READING_WALK.WORDS_PER_SECOND;
  } catch {
    return READING_WALK.WORDS_PER_SECOND;
  }
}
/** Visible gap kept between the reading line and the top bar. */
const READING_LINE_SLACK_PX = 2;

function isPhone(): boolean {
  try { return window.matchMedia(PHONE_QUERY).matches; } catch { return window.innerWidth <= 700; }
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.isContentEditable) return true;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return true;
  const active = document.activeElement as HTMLElement | null;
  return Boolean(active && (active.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

interface LibraryDoc { slug: string; title: string; pendingSuggestions?: number; openComments?: number; updatedSinceYouLooked?: boolean }

export class ReadingWalkUI {
  private walk: ReadingWalk | null = null;
  private readonly left = el('aside', 'prw-rail prw-left');
  private readonly right = el('aside', 'prw-rail prw-right');
  private readonly leftBody = el('div', 'prw-rail-body');
  private readonly rightBody = el('div', 'prw-rail-body');
  private readonly statusEl = el('p', 'prw-status');
  /** Step B6: who you are (signed-in name, an agent key's AI, or "guest — sign in"). */
  private readonly meEl = el('div', 'prw-me');
  private readonly provisionalEl = el('div', 'prw-provisional');
  /** Step B3c: "Since you last marked" (collapsible) and the ringer list. */
  private readonly sinceHost = el('section', 'prw-since');
  /** Step B3b: the reading-rate setting. */
  private readonly rateEl = el('label', 'prw-rate');
  private sinceReport: SinceYouReport | null = null;
  private sinceLoaded = false;
  private sinceOpen = true;
  private skimQueue: number[] = [];
  private skimTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly skimmedLines: number[] = [];
  private readonly boxHost = el('section', 'prw-linebox');
  private readonly changesHost = el('section', 'prw-changes');
  private readonly dockHost = el('div', 'prw-dock');
  /** Step B7: the chat pane's place in the right rail (below the line's box and changes). */
  readonly chatSlot = el('div', 'prw-chat');
  /** Step B7: unread @mentions of the viewer in the chat (a badge on the rail toggle). */
  private chatUnread = 0;
  private readonly focusEl = el('div', 'prw-focus');
  private readonly styleEl = el('style');
  private readonly gate = new GestureGate();
  private box: MarkBox | null = null;
  private boxSig = '';
  private changesSig = '';
  private docsSig = '';
  private tops: number[] = [];
  private heights: number[] = [];
  private lines: DocLine[] = [];
  private marksSig = '';
  private started = false;
  private restored = false;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private renderQueued = false;
  private seenQueue: number[] = [];
  private seenBusy = false;
  private touchY: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeEditing: (() => void) | null = null;
  /** Set while the person edits: the next scroll after editing re-bases the focus (no snap). */
  private rebaseAfterEdit = false;
  private followQueued = false;
  private docs: LibraryDoc[] | null = null;
  private docsMessage = 'Loading…';
  private readonly seenWrites: number[] = [];
  private lastError = '';
  /** Step B4c test hook: changes whose author was asked why. */
  private readonly whyAsked: string[] = [];
  /** Step B4f test hook: lines explained with E. Step B4e: bundle decisions made here. */
  private readonly explained: number[] = [];
  private bundleErrorId: string | null = null;
  private readonly bundleDecisions: Array<{ id: string; action: string; ok: boolean; error?: string }> = [];

  /** Familiar proxy marks: My Familiar (header), the brief (top of the rail), the phone pill. */
  readonly proxy: ProxyMarksUI;

  constructor(private readonly host: ReadingWalkHost) {
    this.proxy = new ProxyMarksUI({
      lineMarks: () => this.host.lineMarks(),
      // Ratify is an explicit action: the provisional (scroll) accepts are committed first.
      beforeRatify: () => { const ids = this.walk?.commitAll() ?? []; if (ids.length) this.commit(ids); },
      focusLine: (index) => { this.host.lineMarks().revealLine(index); this.focusLine(index); if (isPhone()) this.closeSheets(); },
      openBrief: () => { if (isPhone()) this.openSheet('right'); else this.setCollapsed('right', false); },
    });
    this.left.setAttribute('aria-label', 'Documents');
    this.right.setAttribute('aria-label', 'Reading: this line and its changes');
    this.focusEl.setAttribute('aria-hidden', 'true');
    this.styleEl.id = 'prw-dynamic-style';
    this.buildRails();
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;
    document.body.classList.add('prw-on');
    this.applyRailState();
    document.head.append(this.styleEl);
    document.body.append(this.left, this.right);
    window.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('touchstart', this.onTouchStart, { passive: true });
    window.addEventListener('touchmove', this.onTouchMove, { passive: false });
    window.addEventListener('touchend', this.onTouchEnd, { passive: true });
    window.addEventListener('resize', this.onResize);
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('click', this.onDocClick, true);
    document.addEventListener('visibilitychange', this.onVisibility);
    try { window.matchMedia(PHONE_QUERY).addEventListener('change', this.onResize); } catch { /* old browsers */ }
    // Step B4c: "This sitting" (the budget setting and its status) sits under the reading speed.
    const budget = this.host.lineMarks().budgetEl;
    if (budget.parentElement !== this.rightBody) this.rightBody.insertBefore(budget, this.sinceHost);
    // Step B4f: blind marking (an Owner's switch) sits under "This sitting".
    const blind = this.host.lineMarks().blindEl;
    if (blind.parentElement !== this.rightBody) this.rightBody.insertBefore(blind, this.sinceHost);
    // Line tiers: decision / context counts and "Show only decisions".
    const tiers = this.host.lineMarks().tierEl;
    if (tiers.parentElement !== this.rightBody) this.rightBody.insertBefore(tiers, budget);
    // Familiar proxy marks: the brief is the first thing in the rail.
    this.rightBody.prepend(this.proxy.briefEl);
    this.proxy.start();
    (window as unknown as { __proofProxy?: ProxyMarksUI }).__proofProxy = this.proxy;
    this.unsubscribe = this.host.lineMarks().subscribe(() => this.sync());
    installEditingGuard();
    this.unsubscribeEditing = onEditingActivity(() => {
      // The press that places the caret lands before focus moves: check on the next frame.
      requestAnimationFrame(() => { if (isEditing()) { this.rebaseAfterEdit = true; this.queueFollowCaret(); } });
    });
    this.sync();
    void this.loadDocuments();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    document.body.classList.remove('prw-on', 'prw-left-collapsed', 'prw-right-collapsed');
    window.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('touchstart', this.onTouchStart);
    window.removeEventListener('touchmove', this.onTouchMove);
    window.removeEventListener('touchend', this.onTouchEnd);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('click', this.onDocClick, true);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.unsubscribe?.();
    this.proxy.stop();
    this.unsubscribeEditing?.();
    this.unsubscribeEditing = null;
    this.resizeObserver?.disconnect();
    this.host.playmaker()?.dock(null);
    this.left.remove(); this.right.remove(); this.focusEl.remove(); this.styleEl.remove();
  }

  /** Step B2: a section folded or unfolded. Rebuild the walk's hidden lines and the rail box. */
  onFoldChange(): void {
    if (!this.started) return;
    this.boxSig = '';
    this.sync();
  }

  /** Step B2: a tool (the outline fold controls) at the top of the right rail. */
  mountTool(node: HTMLElement): void {
    if (node.parentElement !== this.rightBody) this.rightBody.prepend(node);
    // The Familiar's brief stays at the very top.
    if (this.proxy.briefEl.parentElement === this.rightBody) this.rightBody.prepend(this.proxy.briefEl);
  }

  /** The editor view updated (cursor, marks, text): re-read pending marks if they changed. */
  notifyViewUpdate(): void {
    if (!this.started) return;
    if (isEditing()) this.queueFollowCaret();
    const sig = this.pendingSignature();
    if (sig !== this.marksSig) this.sync();
    else this.queueRender();
  }

  // --------------------------------------------------------------------------
  // Model sync
  // --------------------------------------------------------------------------

  private pendingMarks(): Mark[] {
    let marks: Mark[] = [];
    try { marks = this.host.marks(); } catch { marks = []; }
    return marks.filter(isOpenReviewMark).filter(mark => typeof mark.range?.from === 'number')
      .sort((a, b) => (a.range!.from - b.range!.from) || a.id.localeCompare(b.id));
  }

  private pendingSignature(): string {
    const lm = this.host.lineMarks();
    return this.pendingMarks().map(mark => `${mark.id}@${mark.range!.from}${lm.bundleForMark(mark.id) ? '+b' : ''}`).join(',') + `|${lm.lineList().length}`;
  }

  private sync(): void {
    const lm = this.host.lineMarks();
    this.lines = lm.lineList();
    // Step B4e: a bundle's refusal message goes once that bundle is decided or gone.
    if (this.bundleErrorId && !lm.bundleList().some(v => v.bundle.id === this.bundleErrorId && v.status === 'open')) {
      if (this.lastError) this.lastError = '';
      this.bundleErrorId = null;
    }
    const pending = this.pendingMarks();
    this.marksSig = pending.map(mark => `${mark.id}@${mark.range!.from}${lm.bundleForMark(mark.id) ? '+b' : ''}`).join(',') + `|${this.lines.length}`;
    const hidden = this.host.hiddenLines?.() ?? new Set<number>();
    // Step B4c: a line its writer flagged uncertain takes UNCERTAIN_POLICY.dwellFactor × as long.
    const flagged = lm.flaggedLineSet();
    const walkLines: WalkLine[] = this.lines.map(line => ({
      key: `${line.hash}:${line.occurrence}`,
      words: countWords(line.text),
      marks: [] as WalkMark[],
      ...(hidden.has(line.index) ? { hidden: true } : {}),
      ...(flagged.has(line.index) ? { dwellFactor: UNCERTAIN_POLICY.dwellFactor } : {}),
      // Line tiers: J / K step over context lines that are not Issues for this reader.
      ...(lm.tierSkippable(line.index) ? { skipStep: true } : {}),
    }));
    for (const mark of pending) {
      const index = lm.lineAtPos(mark.range!.from);
      if (index < 0 || !walkLines[index]) continue;
      // Step B4e: a bundle's suggestions step as one unit (BUNDLE_POLICY.walkStepsAsUnit).
      const bundle = mark.kind !== 'comment' && BUNDLE_POLICY.walkStepsAsUnit ? lm.bundleForMark(mark.id) : null;
      walkLines[index].marks.push({ id: mark.id, kind: mark.kind === 'comment' ? 'comment' : 'suggestion', ...(bundle ? { group: bundle.bundle.id } : {}) });
    }
    const now = performance.now();
    if (!this.walk) {
      if (walkLines.length === 0) return;
      this.walk = new ReadingWalk(walkLines, now);
      this.walk.setRate(savedRate());
    } else {
      this.walk.setLines(walkLines, now);
    }
    // Step B2: the focus line was folded away: it moves up to the folded heading.
    if (this.walk.isHidden(this.walk.focus)) {
      const visible = this.host.visibleLineFor?.(this.walk.focus) ?? this.walk.nextVisible(-1) ?? 0;
      this.walk.moveTo(visible, now, 'jump');
    }
    if (!this.view()) return;
    this.attachOverlay();
    this.measure();
    if (!this.restored && lm.isLoaded()) {
      this.restored = true;
      this.restoreSession();
    }
    if (!this.sinceLoaded && lm.isLoaded()) {
      this.sinceLoaded = true;
      void this.loadSinceYou();
    }
    this.afterChange();
  }

  private view() { return this.host.lineMarks().editorView(); }

  private queueFollowCaret(): void {
    if (!READING_EDIT_POLICY.focusFollowsCaret || this.followQueued) return;
    this.followQueued = true;
    requestAnimationFrame(() => { this.followQueued = false; this.followCaret(); });
  }

  /** Editing first: the focus line is the caret's line (a jump: nothing read, nothing passed, no scroll). */
  private followCaret(): void {
    const walk = this.walk;
    const view = this.view();
    if (!walk || !view || !this.started || !isEditing()) return;
    const line = this.host.lineMarks().lineAtPos(view.state.selection.head);
    if (line < 0 || line === walk.focus || walk.isHidden(line)) return;
    this.measure();
    walk.moveTo(line, performance.now(), 'jump', this.heights);
    this.afterChange();
  }

  private attachOverlay(): void {
    const view = this.view();
    if (!view) return;
    const container = (view.dom.closest('#editor-container') as HTMLElement | null) ?? view.dom.parentElement;
    if (container && this.focusEl.parentElement !== container) container.append(this.focusEl);
    if (!this.resizeObserver) {
      this.resizeObserver = new ResizeObserver(() => { this.measure(); this.queueRender(); });
      this.resizeObserver.observe(view.dom);
    }
  }

  /** Caches each line's top (document coordinates) and height. */
  private measure(): void {
    const view = this.view();
    if (!view) return;
    const scrollY = window.scrollY;
    this.tops = [];
    this.heights = [];
    for (const line of this.lines) {
      const dom = view.nodeDOM(line.pos) as HTMLElement | null;
      const rect = dom && typeof dom.getBoundingClientRect === 'function' ? dom.getBoundingClientRect() : null;
      const top = rect && rect.height > 0 ? rect.top + scrollY : (this.tops[this.tops.length - 1] ?? 0);
      this.tops.push(top);
      this.heights.push(rect?.height ?? 0);
    }
    const banner = document.getElementById('share-banner');
    const bannerBottom = banner ? Math.round(banner.getBoundingClientRect().bottom) : 0;
    document.body.style.setProperty('--prw-top', `${Math.max(12, bannerBottom + 8)}px`);
  }

  /** Where (viewport y) the focus line sits: the first line's place with the page at the top. */
  private readingY(): number {
    return Math.max(0, (this.tops[0] ?? 0));
  }

  private lineAtReadingLine(): number {
    const y = window.scrollY + this.readingY() + READING_LINE_SLACK_PX;
    let lo = 0;
    let hi = this.tops.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.tops[mid] <= y) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    // Step B2: hidden lines share their folded heading's top; the heading is the line there.
    while (found > 0 && this.walk?.isHidden(found)) found -= 1;
    return found;
  }

  private scrollToLine(index: number): void {
    const top = this.tops[index];
    if (top === undefined) return;
    window.scrollTo({ top: Math.max(0, top - this.readingY()), behavior: 'instant' as ScrollBehavior });
  }

  // --------------------------------------------------------------------------
  // Input
  // --------------------------------------------------------------------------

  private onScroll = (): void => {
    const walk = this.walk;
    if (!walk || this.tops.length === 0) return;
    // Editing first: while the person edits, scrolling moves nothing and snaps nothing.
    if (isEditing()) { this.rebaseAfterEdit = true; this.queueRender(); return; }
    let target = this.lineAtReadingLine();
    if (this.rebaseAfterEdit) {
      // The first scroll after editing starts reading from here: no barrier snap back.
      this.rebaseAfterEdit = false;
      if (target !== walk.focus) { walk.moveTo(target, performance.now(), 'jump', this.heights); this.afterChange(); }
      return;
    }
    if (target > walk.focus) {
      // A line with marks not yet stepped holds the page (scrollbar, keys, touch inertia).
      const barrier = walk.barrier(walk.focus);
      if (barrier !== null && barrier < target) {
        target = barrier;
        this.scrollToLine(barrier);
      }
    }
    if (target !== walk.focus) {
      walk.moveTo(target, performance.now(), 'scroll', this.heights);
      this.afterChange();
    } else {
      this.queueRender();
    }
  };

  private startMode = (direction: 1 | -1): 'step' | 'native' => {
    const walk = this.walk;
    if (!walk) return 'native';
    if (direction > 0 && walk.canStepForward()) return 'step';
    if (direction < 0 && walk.canStepBack()) return 'step';
    return 'native';
  };

  private isDocumentTarget(target: EventTarget | null): boolean {
    const node = target as HTMLElement | null;
    if (!node || node === document.body || node === document.documentElement) return true;
    if (typeof node.closest !== 'function') return false;
    return Boolean(node.closest('#app')) && !node.closest('.plm-menu, .mark-popover, .pm-review-dialog');
  }

  private onWheel = (event: WheelEvent): void => {
    const walk = this.walk;
    if (!walk || event.ctrlKey || !this.isDocumentTarget(event.target)) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    const dy = event.deltaY * unit;
    if (Math.abs(dy) < Math.abs(event.deltaX * unit)) return;
    this.handleDelta(dy, event.timeStamp || performance.now(), () => event.preventDefault());
  };

  private handleDelta(dy: number, at: number, prevent: () => void): void {
    const walk = this.walk!;
    // Editing first: native scrolling while the person edits (no stepping, no barrier).
    if (isEditing()) { this.gate.reset(); return; }
    const result = this.gate.feed(dy, at, this.startMode);
    if (result.prevent) prevent();
    if (result.step === 1) { walk.stepForward(); this.afterChange(true); return; }
    if (result.step === -1) { walk.stepBack(); this.afterChange(true); return; }
    if (this.gate.mode === 'native' && dy > 0) {
      const barrier = walk.barrier(walk.focus);
      if (barrier === null) return;
      const max = this.tops[barrier] - this.readingY();
      if (window.scrollY + dy > max + 1) {
        prevent();
        this.gate.block();
        if (window.scrollY < max) this.scrollToLine(barrier);
        if (barrier !== walk.focus) {
          walk.moveTo(barrier, performance.now(), 'scroll', this.heights);
          this.afterChange();
        }
      }
    }
  }

  private onTouchStart = (event: TouchEvent): void => {
    this.touchY = event.touches.length === 1 && this.isDocumentTarget(event.target) ? event.touches[0].clientY : null;
    this.gate.reset();
  };

  private onTouchMove = (event: TouchEvent): void => {
    if (this.touchY === null || !this.walk || event.touches.length !== 1) return;
    const y = event.touches[0].clientY;
    const dy = this.touchY - y;
    this.touchY = y;
    this.handleDelta(dy, performance.now(), () => { if (event.cancelable) event.preventDefault(); });
  };

  private onTouchEnd = (): void => {
    this.touchY = null;
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.walk || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('[role="dialog"], .pm-review-dialog, .mark-popover, .plm-menu, .proof-share-overflow-menu, [role="menu"]')) return;
    const key = event.key;
    if (key === 'Escape' && this.host.lineMarks().selectionLines().length) { this.host.lineMarks().clearSelection(); return; }
    if (key === 'a' || key === 'A') { event.preventDefault(); this.markFocus('agreed'); return; }
    if (key === 'r' || key === 'R') { event.preventDefault(); this.openReason(); return; }
    if (key === 'j' || key === 'J' || key === 'ArrowDown') { event.preventDefault(); this.next(); return; }
    if (key === 'k' || key === 'K' || key === 'ArrowUp') { event.preventDefault(); this.previous(); return; }
    // Line tiers: D flips the focus line between decision and context (an explicit action).
    if (key.toLowerCase() === TIER_POLICY.flipKey) { event.preventDefault(); this.flipFocusTier(); return; }
    // Step B4f: E asks the AI collaborators to explain the focus line (never a rejection).
    if (key.toLowerCase() === EXPLAIN_POLICY.key) { event.preventDefault(); this.explainFocus(); return; }
    // Step B4f: 1-9 pick among the focus line's competing wordings (1 is the original).
    if (/^[1-9]$/.test(key) && this.host.lineMarks().altSetFor(this.walk.focus)) {
      event.preventDefault();
      this.explicit(this.walk.focus);
      void this.host.lineMarks().pickAlternative(this.walk.focus, key);
      return;
    }
    // Step B3: Y / N / T answer the ask on the focus line (only when the line carries one).
    const choice = (Object.keys(ASK_POLICY.keys) as AskChoice[]).find(c => ASK_POLICY.keys[c] === key.toLowerCase());
    if (choice && this.host.lineMarks().askForLine(this.walk.focus)) {
      event.preventDefault();
      this.answerFocus(choice);
    }
  };

  /** Line tiers: D on the focus line. */
  private flipFocusTier(): void {
    this.renderNow();
    this.box?.flipTier?.();
  }

  /** Step B3: Y / N / T on the focus line's ask. */
  private answerFocus(choice: AskChoice): void {
    if (ASK_POLICY.reasonRequired[choice]) {
      if (isPhone()) this.openSheet('right');
      else if (document.body.classList.contains('prw-right-collapsed')) this.setCollapsed('right', false);
    }
    this.renderNow();
    this.box?.ask?.choose(choice);
  }

  /** Step B4f: E on the focus line posts the default question to the AI collaborators. */
  private explainFocus(): void {
    const walk = this.walk;
    if (!walk) return;
    this.explained.push(walk.focus);
    void this.host.lineMarks().explainLine(walk.focus);
  }

  /** Step B4d: the focus line (shift-click ranges in the margin start here). */
  focusIndex(): number { return this.walk?.focus ?? 0; }

  /** Step B4c: Next issue hit the sitting budget: show the rail's "This sitting" status. */
  budgetReached(): void {
    if (isPhone()) this.openSheet('right');
    else if (document.body.classList.contains('prw-right-collapsed')) this.setCollapsed('right', false);
    const el = this.host.lineMarks().budgetEl;
    el.scrollIntoView({ block: 'nearest' });
    (el.querySelector('.plm-budget-stop') as HTMLButtonElement | null)?.focus({ preventScroll: true });
  }

  /** Step B3: the viewer answered the ask on `line` (from any control): an explicit action. */
  askAnswered(line: number): void {
    if (!ASK_POLICY.answerIsExplicitReadingAction) return;
    this.explicit(line);
  }

  /** A click on a review mark in the text is an explicit action on its line. */
  private onDocClick = (event: MouseEvent): void => {
    if (!READING_EDIT_POLICY.textClickIsExplicitAction) return;
    const target = event.target as HTMLElement | null;
    const markEl = target?.closest?.('.ProseMirror [data-mark-id]') as HTMLElement | null;
    if (!markEl || !this.walk) return;
    const id = markEl.getAttribute('data-mark-id');
    const mark = this.pendingMarks().find(m => m.id === id);
    if (!mark) return;
    this.explicit(this.host.lineMarks().lineAtPos(mark.range!.from));
  };

  private onResize = (): void => {
    this.measure();
    this.applyRailState();
    this.queueRender();
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') this.scheduleTick();
  };

  // --------------------------------------------------------------------------
  // Actions
  // --------------------------------------------------------------------------

  /** J / ↓: the next mark on this line, else the next line. */
  next(): void {
    const walk = this.walk;
    if (!walk) return;
    if (walk.stepForward()) { this.afterChange(true); return; }
    // Step B2: a folded section is one step. Line tiers: skippable context lines are passed over.
    const to = walk.nextStop(1) ?? walk.nextVisible(1);
    if (to === null) return;
    walk.moveTo(to, performance.now(), 'scroll', this.heights);
    this.scrollToLine(walk.focus);
    this.afterChange();
  }

  /** K / ↑: back one mark on this line, else the previous line. */
  previous(): void {
    const walk = this.walk;
    if (!walk) return;
    if (walk.stepBack()) { this.afterChange(true); return; }
    const to = walk.nextStop(-1) ?? walk.nextVisible(-1);
    if (to === null) return;
    walk.moveTo(to, performance.now(), 'scroll', this.heights);
    this.scrollToLine(walk.focus);
    this.afterChange();
  }

  /** Moves the focus to a line without reading the lines on the way (Next issue, a dot). */
  focusLine(index: number): boolean {
    const walk = this.walk;
    if (!walk || this.tops[index] === undefined) return false;
    if (walk.isHidden(index)) index = this.host.visibleLineFor?.(index) ?? index;
    this.measure();
    walk.moveTo(index, performance.now(), 'jump', this.heights);
    this.scrollToLine(index);
    this.afterChange();
    return true;
  }

  /** A margin dot on desktop: focus that line and put the keyboard in its box. */
  activateDot(index: number): boolean {
    if (isPhone() || !this.walk) return false;
    if (document.body.classList.contains('prw-right-collapsed')) this.setCollapsed('right', false);
    this.focusLine(index);
    this.renderNow();
    (this.boxHost.querySelector('.plm-actions button:not(:disabled)') as HTMLButtonElement | null)?.focus({ preventScroll: true });
    return true;
  }

  private markFocus(status: 'agreed' | 'seen'): void {
    this.renderNow();
    this.box?.choose(status, 'key');
  }

  private openReason(): void {
    // Step B4d: a text selection across several lines makes the Reject cover them.
    if (this.host.lineMarks().selectFromEditor()) this.boxSig = '';
    if (isPhone()) this.openSheet('right');
    else if (document.body.classList.contains('prw-right-collapsed')) this.setCollapsed('right', false);
    this.renderNow();
    this.box?.openReason();
  }

  /** An explicit action on `line`: commit the provisional accepts at or above it. */
  private explicit(line: number): void {
    const walk = this.walk;
    if (!walk || line < 0) return;
    const ids = walk.explicitAction(line);
    this.commit(ids);
  }

  private commit(ids: string[]): void {
    if (ids.length === 0) return;
    const walk = this.walk!;
    // Step B4e: scroll-accepted bundle members commit only while their bundle still matches.
    const lm = this.host.lineMarks();
    const stale = new Set<string>();
    for (const id of ids) {
      const bundle = lm.bundleForMark(id);
      if (bundle && bundle.stale.length) for (const member of bundle.bundle.members) stale.add(member.markId);
    }
    if (stale.size) {
      for (const id of ids) if (stale.has(id)) walk.dropProvisional(id);
      ids = ids.filter(id => !stale.has(id));
      this.lastError = 'A bundle changed since it was made: its changes were not accepted. Review them one by one.';
      if (ids.length === 0) { this.afterChange(); return; }
    }
    try {
      this.host.decide(ids, 'accept');
      this.lastError = '';
    } catch (error) {
      walk.restoreProvisional(ids);
      this.lastError = error instanceof Error ? error.message : 'Could not save the accepts.';
    }
    this.afterChange();
  }

  private decide(mark: Mark, action: ReviewAction, text?: string): void {
    const walk = this.walk;
    if (!walk) return;
    const line = this.host.lineMarks().lineAtPos(mark.range?.from ?? -1);
    // Explicit on this line: first commit the provisional accepts at or above it.
    const ids = walk.explicitAction(line).filter(id => id !== mark.id);
    try {
      if (ids.length) this.host.decide(ids, 'accept');
      this.host.decide([mark.id], action, text);
      if (action === 'accept' || action === 'reject') walk.decided(mark.id);
      this.lastError = '';
    } catch (error) {
      walk.restoreProvisional(ids);
      this.lastError = error instanceof Error ? error.message : 'Could not save the decision.';
    }
    this.afterChange();
  }

  // --------------------------------------------------------------------------
  // After every change
  // --------------------------------------------------------------------------

  private afterChange(stepped = false): void {
    const walk = this.walk;
    if (!walk) return;
    for (const event of walk.drain()) {
      if (event.type === 'seen') this.enqueueSeen(event.line);
      else if (event.type === 'skimmed') this.enqueueSkim(event.line);
    }
    this.scheduleTick();
    this.scheduleSave();
    this.renderNow();
    if (stepped) this.revealCurrentMark();
  }

  private scheduleTick(): void {
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = null;
    const walk = this.walk;
    if (!walk || document.visibilityState !== 'visible') return;
    const wait = walk.msUntilRead(performance.now());
    if (wait <= 0) return;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      // Editing first: the line being edited is not read by dwell until editing pauses.
      const editing = editingRemainingMs();
      if (editing > 0) { this.tickTimer = setTimeout(() => { this.tickTimer = null; this.scheduleTick(); }, editing + 5); return; }
      walk.tick(performance.now());
      this.afterChange();
    }, wait + 5);
  }

  private enqueueSeen(line: number): void {
    this.seenQueue.push(line);
    void this.drainSeen();
  }

  private async drainSeen(): Promise<void> {
    if (this.seenBusy) return;
    this.seenBusy = true;
    try {
      const lm = this.host.lineMarks();
      while (this.seenQueue.length) {
        const line = this.seenQueue.shift()!;
        if (!lm.isLoaded()) continue;
        // Never downgrade a mark. A skimmed line read properly now becomes Seen, or Agreed when
        // it is another's statement (STATEMENT_POLICY, Mike 2026-09-19: scrolling past another's
        // statement is acceptance and agreement; still a passive mark for the ringer list).
        const status = lm.dwellStatusFor(line);
        if (!status || status === 'skimmed') continue;
        this.seenWrites.push(line);
        await lm.setLineStatus(line, status as 'seen' | 'agreed', undefined, 'dwell');
      }
    } finally {
      this.seenBusy = false;
    }
  }

  /** Step B3b: lines scrolled past too fast, written together (one request per SKIM_FLUSH_MS). */
  private enqueueSkim(line: number): void {
    this.skimQueue.push(line);
    if (this.skimTimer) return;
    this.skimTimer = setTimeout(() => {
      this.skimTimer = null;
      const lines = this.skimQueue.splice(0);
      const lm = this.host.lineMarks();
      if (!lm.isLoaded() || lines.length === 0) return;
      this.skimmedLines.push(...lines);
      void lm.markSkimmed(lines);
    }, SKIM_FLUSH_MS);
  }

  /** Step B3b: the reader chose a reading rate (words per second; 0 = no length rule). */
  setReadingRate(rate: number): void {
    try { localStorage.setItem(RATE_KEY, String(rate)); } catch { /* optional */ }
    this.walk?.setRate(rate);
    this.renderRate(true);
    this.scheduleTick();
  }

  private renderRate(force = false): void {
    const walk = this.walk;
    if (!walk) return;
    const rate = walk.readingRate;
    const line = this.lines[walk.focus];
    const need = dwellMsFor(line ? countWords(line.text) : undefined, rate);
    const sig = `${rate}|${need}`;
    if (!force && this.rateEl.dataset.sig === sig) return;
    this.rateEl.dataset.sig = sig;
    const select = this.rateEl.querySelector('select') as HTMLSelectElement | null;
    if (select && select.value !== String(rate)) select.value = String(rate);
    const hint = this.rateEl.querySelector('.prw-rate-need') as HTMLElement | null;
    if (hint) hint.textContent = `this line: ${(need / 1000).toFixed(need < 1000 ? 2 : 1)} s`;
  }

  // --------------------------------------------------------------------------
  // Step B3c: Since you
  // --------------------------------------------------------------------------

  private async loadSinceYou(): Promise<void> {
    const report = await this.host.lineMarks().fetchSinceYou();
    this.sinceReport = report;
    this.renderSince();
  }

  private renderSince(): void {
    const report = this.sinceReport;
    this.sinceHost.replaceChildren();
    this.sinceHost.hidden = !report || !report.hasHistory;
    if (!report || !report.hasHistory) return;
    const details = el('details', 'prw-since-details');
    details.open = this.sinceOpen && report.counts.total > 0;
    details.addEventListener('toggle', () => { this.sinceOpen = details.open; });
    const summary = el('summary', 'prw-since-summary');
    const when = report.baseline.at ? new Date(report.baseline.at) : null;
    const whenText = when ? when.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const title = report.baseline.source === 'snapshot' ? `Since the aligned version (${whenText})` : `Since you last marked (${whenText})`;
    summary.append(el('strong', undefined, title));
    const count = el('span', 'prw-since-count', report.counts.total === 0 ? 'nothing new' : String(report.counts.total));
    count.dataset.count = String(report.counts.total);
    summary.append(count);
    details.append(summary);
    const refresh = el('button', 'prw-link prw-since-refresh', 'Refresh');
    refresh.type = 'button';
    refresh.onclick = () => { void this.loadSinceYou(); };
    const groups: Array<[string, SinceItem[], number, string]> = [
      // Step B4d: a repair was proposed to one of your objections (Clear / Keep in the line's box).
      ['A repair was proposed', report.repairs ?? [], report.counts.repairs ?? 0, 'repairs'],
      ['Lines edited since', report.edited, report.counts.edited, 'edited'],
      ['New asks', report.asks, report.counts.asks, 'asks'],
      ['Rejected by others', report.rejections, report.counts.rejections, 'rejections'],
      ['Suggestions added', report.suggestions, report.counts.suggestions, 'suggestions'],
      ['Comments added', report.comments, report.counts.comments, 'comments'],
    ];
    for (const [label, items, total, kind] of groups) {
      if (items.length === 0) continue;
      const group = el('div', 'prw-since-group');
      group.dataset.kind = kind;
      group.append(el('h4', undefined, `${label} (${total})`));
      const list = el('ul');
      for (const item of items) list.append(this.sinceItem(item));
      group.append(list);
      details.append(group);
    }
    if (report.ringers.length) {
      const group = el('div', 'prw-since-group prw-ringers');
      group.dataset.kind = 'ringers';
      group.append(el('h4', undefined, `Ringer list (${report.counts.ringers})`));
      group.append(el('p', 'prw-since-note', 'These count as seen for you only because you scrolled past them or marked their section, and they changed or gained something since.'));
      const list = el('ul');
      for (const item of report.ringers) list.append(this.ringerItem(item));
      group.append(list);
      details.append(group);
    }
    details.append(refresh);
    this.sinceHost.append(details);
  }

  private sinceItem(item: SinceItem): HTMLElement {
    const li = el('li');
    const button = el('button', 'prw-since-item');
    button.type = 'button';
    button.dataset.type = item.type;
    if (item.lineIndex !== null) button.dataset.line = String(item.lineIndex);
    const head = item.type === 'edited'
      ? (item.change === 'cosmetic' ? 'Small fix' : item.change === 'new-since-snapshot' ? 'New or changed' : 'Changed')
      : item.type === 'ask' ? `Ask from ${getActorName(item.by ?? '')}`
      : item.type === 'rejection' ? `${getActorName(item.by ?? '')} rejected`
      : item.type === 'suggestion' ? `Suggestion by ${getActorName(item.by ?? '')}`
      : item.type === 'repair' ? `Your objection: ${item.reason ?? ''}`
      : item.type === 'reply' ? `Reply by ${getActorName(item.by ?? '')}`
      : `Comment by ${getActorName(item.by ?? '')}`;
    button.append(el('span', 'prw-since-head', head));
    button.append(el('span', 'prw-since-text', item.excerpt || '(line not found)'));
    const detail = item.type === 'rejection' ? (item.reason ? `Reason: ${item.reason}` : '')
      : item.type === 'edited' ? (item.from ? `Was: ${item.from}` : '')
      : (item.detail ?? '');
    if (detail) button.append(el('span', 'prw-since-detail', detail.length > 160 ? `${detail.slice(0, 160)}…` : detail));
    button.onclick = () => this.gotoSince(item.hash, item.occurrence, item.lineIndex, item.markId);
    li.append(button);
    return li;
  }

  private ringerItem(item: RingerItem): HTMLElement {
    const li = el('li');
    const button = el('button', 'prw-since-item');
    button.type = 'button';
    button.dataset.type = 'ringer';
    button.dataset.line = String(item.lineIndex);
    button.append(el('span', 'prw-since-head', item.via === 'section' ? 'Seen with its section' : 'Seen by scrolling'));
    button.append(el('span', 'prw-since-text', item.excerpt));
    button.append(el('span', 'prw-since-detail', item.why));
    button.onclick = () => this.gotoSince(item.hash, item.occurrence, item.lineIndex);
    li.append(button);
    return li;
  }

  /** Moves the focus line to a Since-you item: by its mark, else its line text, else its index. */
  private gotoSince(hash: string | null, occurrence: number | null, lineIndex: number | null, markId?: string): void {
    const lm = this.host.lineMarks();
    let index = -1;
    if (markId) {
      const mark = (() => { try { return this.host.marks().find(m => m.id === markId); } catch { return undefined; } })();
      if (mark?.range && typeof mark.range.from === 'number') index = lm.lineAtPos(mark.range.from);
    }
    if (index < 0 && hash) {
      const lines = lm.lineList();
      const exact = lines.find(line => line.hash === hash && line.occurrence === (occurrence ?? 0)) ?? lines.find(line => line.hash === hash);
      if (exact) index = exact.index;
    }
    if (index < 0 && lineIndex !== null && lineIndex < lm.lineList().length) index = lineIndex;
    if (index < 0) return;
    lm.revealLine(index);
    this.focusLine(index);
    if (isPhone()) this.closeSheets();
  }

  private sessionKey(): string | null {
    const slug = this.host.slug();
    return slug ? `proof:reading-walk:${slug}:${actorKey(this.host.actor())}` : null;
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const key = this.sessionKey();
      if (!key || !this.walk) return;
      try { sessionStorage.setItem(key, JSON.stringify(this.walk.snapshot())); } catch { /* optional */ }
    }, 200);
  }

  private restoreSession(): void {
    const key = this.sessionKey();
    if (!key || !this.walk) return;
    let snapshot: WalkSnapshot | null = null;
    try { snapshot = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { snapshot = null; }
    if (!snapshot) return;
    this.walk.restore(snapshot, performance.now());
    if (this.walk.isHidden(this.walk.focus)) {
      this.walk.moveTo(this.host.visibleLineFor?.(this.walk.focus) ?? 0, performance.now(), 'jump');
    }
    if (this.walk.focus > 0) this.scrollToLine(this.walk.focus);
  }

  // --------------------------------------------------------------------------
  // Rendering
  // --------------------------------------------------------------------------

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderNow();
    });
  }

  private renderNow(): void {
    const walk = this.walk;
    if (!walk || !this.started) return;
    this.dockPanel();
    this.renderFocus();
    this.renderDynamicStyle();
    this.renderStatus();
    this.renderMe();
    this.renderBox();
    this.renderChanges();
    this.renderDocuments();
    this.renderRate();
  }

  private dockPanel(): void {
    const review = this.host.playmaker();
    if (!review) return;
    review.dock(isPhone() ? null : this.dockHost);
  }

  private renderFocus(): void {
    const walk = this.walk!;
    const view = this.view();
    const line = this.lines[walk.focus];
    const container = this.focusEl.parentElement;
    if (!view || !line || !container) { this.focusEl.hidden = true; return; }
    const dom = view.nodeDOM(line.pos) as HTMLElement | null;
    if (!dom || typeof dom.getBoundingClientRect !== 'function') { this.focusEl.hidden = true; return; }
    const c = container.getBoundingClientRect();
    const r = dom.getBoundingClientRect();
    const text = view.dom.getBoundingClientRect();
    this.focusEl.hidden = false;
    this.focusEl.dataset.line = String(walk.focus);
    this.focusEl.style.top = `${Math.round(r.top - c.top - 3)}px`;
    this.focusEl.style.height = `${Math.round(r.height + 6)}px`;
    this.focusEl.style.left = `${Math.round(text.left - c.left - 10)}px`;
    this.focusEl.style.width = `${Math.round(text.width + 20)}px`;
  }

  private renderDynamicStyle(): void {
    const walk = this.walk!;
    const rules: string[] = [];
    for (const id of walk.provisionalIds()) {
      const sel = `html body .ProseMirror [data-mark-id="${CSS.escape(id)}"]`;
      rules.push(`${sel}.mark-delete{display:none!important}`);
      rules.push(`${sel}.mark-insert{background:rgba(22,163,74,.08)!important;color:inherit!important;text-decoration:none!important;border-bottom:2px dashed #16a34a!important}`);
    }
    const current = walk.currentMark();
    if (current) {
      rules.push(`html body .ProseMirror [data-mark-id="${CSS.escape(current.id)}"]{outline:2px solid #2563eb!important;outline-offset:1px;border-radius:2px}`);
    }
    const css = rules.join('\n');
    if (this.styleEl.textContent !== css) this.styleEl.textContent = css;
  }

  /**
   * Step B6: the right rail header says who the viewer's marks and answers will name. A guest's
   * name is shown as unverified, with a sign-in link when this server has sign-in.
   */
  private renderMe(): void {
    const me = this.host.lineMarks().viewerIdentity();
    const sig = JSON.stringify([me.actor, me.trust, me.name, me.email ?? '', me.signInUrl ?? '']);
    if (this.meEl.dataset.sig === sig) return;
    this.meEl.dataset.sig = sig;
    this.meEl.dataset.trust = me.trust;
    this.meEl.replaceChildren();
    if (me.trust === 'verified') {
      const badge = el('span', 'prw-me-badge', '✓');
      badge.setAttribute('aria-hidden', 'true');
      const who = el('span', 'prw-me-name', me.name);
      this.meEl.append(badge, el('span', 'prw-me-label', 'Signed in as '), who);
      this.meEl.title = `Your marks and answers are recorded as ${me.email ?? me.actor}`;
      return;
    }
    if (me.trust === 'ai') {
      this.meEl.append(el('span', 'prw-me-label', 'AI: '), el('span', 'prw-me-name', me.name));
      this.meEl.title = `Marks and answers are recorded as ${me.actor}`;
      return;
    }
    this.meEl.append(el('span', 'prw-me-name', me.name || 'Anonymous'), el('span', 'prw-me-guest', 'guest, unverified'));
    this.meEl.title = 'You are not signed in: your marks show your typed name as a guest, and do not answer asks addressed to a signed-in person.';
    if (me.signInUrl) {
      const link = el('a', 'prw-me-signin', 'Sign in');
      link.href = me.signInUrl;
      link.onclick = () => {
        // Come back here after signing in (read by public/vendor/soma-auth/proof-session.js).
        try { localStorage.setItem('proof:return-to', JSON.stringify({ path: location.pathname + location.search + location.hash, at: Date.now() })); } catch { /* optional */ }
      };
      this.meEl.append(el('span', 'prw-me-sep', ' — '), link);
    }
  }

  private renderStatus(): void {
    const walk = this.walk!;
    this.statusEl.textContent = `Line ${walk.focus + 1} of ${walk.lineCount}`;
    const n = walk.provisionalCount;
    this.provisionalEl.hidden = n === 0 && !this.lastError;
    const sig = `${n}|${this.lastError}`;
    if (this.provisionalEl.dataset.sig === sig) return;
    this.provisionalEl.dataset.sig = sig;
    this.provisionalEl.replaceChildren();
    if (n > 0) {
      const text = el('p', 'prw-provisional-text', `${n} ${n === 1 ? 'change' : 'changes'} accepted by scrolling, not saved yet. Scroll back up to undo.`);
      const commit = el('button', 'prw-commit', `Commit ${n} accepted`);
      commit.type = 'button';
      commit.onclick = () => this.commit(this.walk?.commitAll() ?? []);
      this.provisionalEl.append(text, commit);
    }
    if (this.lastError) {
      const err = el('p', 'prw-error', this.lastError);
      err.setAttribute('role', 'alert');
      this.provisionalEl.append(err);
    }
  }

  private renderBox(): void {
    const walk = this.walk!;
    const lm = this.host.lineMarks();
    const line = this.lines[walk.focus];
    if (!line) { this.boxHost.replaceChildren(); this.box = null; this.boxSig = ''; return; }
    const state = lm.lineState(walk.focus);
    const summary = lm.issueSummary();
    const marks = state ? [...state.marks.values()].map(e => `${e.mark.id}:${e.mark.status}:${e.current}:${e.mark.reason ?? ''}`).join(',') : '';
    const sig = `${walk.focus}|${line.hash}|${line.occurrence}|${marks}|${summary?.team.join(',') ?? ''}|${lm.isLoaded()}|${lm.askSignature(walk.focus)}|${lm.aidsSignature(walk.focus)}`;
    if (sig === this.boxSig && this.box) return;
    // Keep the box while the reader types a reason for this same line.
    const active = document.activeElement;
    if (this.box && this.boxHost.contains(active) && active instanceof HTMLInputElement && this.boxHost.querySelector('.plm-box')?.getAttribute('data-line') === String(walk.focus)) return;
    this.boxSig = sig;
    const box = lm.buildMarkBox(line, {
      onExplicit: () => this.explicit(walk.focus),
    });
    const head = el('div', 'prw-box-head');
    const hasAsk = Boolean(lm.askForLine(walk.focus));
    const alts = lm.altSetFor(walk.focus);
    head.append(el('strong', undefined, 'Mark this line'),
      el('span', 'prw-keys', hasAsk ? 'Y yes · N no · T not yet' : alts ? `1–${alts.options.length} pick · A agree · E explain` : 'A agree · R reject · E explain · D tier · J/K move'));
    // Editing first (2026-09-19): who changed this line, and whether the meaning changed.
    const note = lm.editNoteFor(walk.focus);
    if (note) {
      const edited = el('p', 'prw-edit-note', note.text);
      edited.dataset.kind = note.kind;
      this.boxHost.replaceChildren(head, edited, box.root);
    } else {
      this.boxHost.replaceChildren(head, box.root);
    }
    this.box = box;
  }

  private renderChanges(): void {
    const walk = this.walk!;
    const onLine = walk.marksOn(walk.focus);
    const all = new Map(this.pendingMarks().map(mark => [mark.id, mark]));
    const current = walk.currentMark();
    const lm = this.host.lineMarks();
    const sig = JSON.stringify([walk.focus, onLine.map(m => [m.id, walk.isPassed(m.id), walk.isProvisional(m.id)]), current?.id,
      onLine.map(m => { const mk = all.get(m.id); return mk ? [mk.at, mk.data] : null; }),
      onLine.map(m => lm.notesForMark(m.id).map(n => n.why)),
      onLine.map(m => { const b = lm.bundleForMark(m.id); return b ? [b.bundle.id, b.pending.length, b.stale.join(','), b.status] : null; }),
      this.bundleDecisions.length, this.lastError]);
    if (sig === this.changesSig) return;
    this.changesSig = sig;
    this.changesHost.replaceChildren();
    this.changesHost.hidden = onLine.length === 0;
    if (onLine.length === 0) return;
    const index = walk.stepIndex();
    const head = el('div', 'prw-changes-head');
    head.append(el('strong', undefined, `Changes on this line`),
      el('span', 'prw-step', index < onLine.length ? `${index + 1} of ${onLine.length}` : `all ${onLine.length} passed`));
    this.changesHost.append(head);
    // Step B4e: a bundle on this line shows as one card (title, why, every passage, one decision).
    const shownBundles = new Set<string>();
    for (const item of onLine) {
      const bundle = lm.bundleForMark(item.id);
      if (!bundle || shownBundles.has(bundle.bundle.id)) continue;
      shownBundles.add(bundle.bundle.id);
      this.changesHost.append(this.bundleCard(bundle, all));
    }
    const nav = el('div', 'prw-step-nav');
    const back = el('button', undefined, '‹ Back'); back.type = 'button'; back.disabled = !walk.canStepBack();
    back.onclick = () => this.previous();
    const fwd = el('button', undefined, index < onLine.length ? 'Next ›' : 'Next line ›'); fwd.type = 'button';
    fwd.onclick = () => this.next();
    nav.append(back, fwd);
    this.changesHost.append(nav);
    for (const item of onLine) {
      const mark = all.get(item.id);
      if (!mark) continue;
      // Bundled changes are decided on the bundle card (unless it is stale: then one by one).
      const bundle = lm.bundleForMark(item.id);
      if (bundle && bundle.stale.length === 0) continue;
      this.changesHost.append(this.changeCard(mark, {
        current: current?.id === mark.id,
        provisional: walk.isProvisional(mark.id),
        passed: walk.isPassed(mark.id),
      }));
    }
    const hint = el('p', 'prw-hint', 'Scroll down to step through the changes; scrolling past a change accepts it until you scroll back up.');
    this.changesHost.append(hint);
  }

  /** Step B4e: one card for a review bundle (title, why, every passage with its result, one decision). */
  private bundleCard(view: BundleView, all: Map<string, Mark>): HTMLElement {
    const b = view.bundle;
    const card = el('article', 'prw-bundle');
    card.dataset.bundleId = b.id;
    card.dataset.stale = String(view.stale.length > 0);
    card.style.setProperty('--review-author', getMarkColor(b.by));
    const head = el('div', 'prw-bundle-head');
    head.append(el('span', 'prw-bundle-tag', 'Bundle'), el('strong', 'prw-bundle-title', b.title), el('span', 'prw-bundle-by', getActorName(b.by)));
    card.append(head);
    if (b.why) {
      const why = el('p', 'prw-why');
      why.append(el('span', 'prw-why-label', 'Why: '), b.why);
      card.append(why);
    }
    const list = el('ol', 'prw-bundle-passages');
    const ids = new Set(b.members.map(m => m.markId));
    for (const member of view.members) {
      const li = el('li', 'prw-bundle-passage');
      li.dataset.markId = member.markId;
      li.dataset.state = member.state;
      if (member.stale) li.dataset.stale = 'true';
      const mark = all.get(member.markId);
      li.append(el('span', 'prw-bundle-where', member.lineIndex === null ? 'Line ?' : `Line ${member.lineIndex + 1}`));
      const change = el('span', 'prw-bundle-change');
      if (mark && (mark.kind === 'replace' || mark.kind === 'delete')) change.append(el('del', undefined, mark.quote));
      if (mark && mark.kind === 'replace') change.append(' → ');
      if (mark && (mark.kind === 'replace' || mark.kind === 'insert')) change.append(el('ins', undefined, (mark.data as ReplaceData)?.content || mark.quote));
      if (!mark) change.append(el('span', undefined, member.state === 'pending' ? '(not on this page yet)' : `(${member.state})`));
      li.append(change);
      if (member.lineIndex !== null && member.state === 'pending') {
        li.append(el('span', 'prw-bundle-result', `Result: ${this.resultingText(member.lineIndex, ids)}`));
      }
      if (member.stale) li.append(el('span', 'prw-bundle-stale', member.staleReason === 'rejected' ? 'rejected on its own' : member.staleReason === 'missing' ? 'no longer here' : 'changed since bundled'));
      list.append(li);
    }
    card.append(list);
    card.append(el('p', 'prw-bundle-note', BUNDLE_POLICY.acceptNote));
    const status = el('p', 'prw-bundle-status', describeBundle(view));
    status.setAttribute('role', 'status');
    card.append(status);
    const actions = el('div', 'prw-card-actions');
    const accept = el('button', 'prw-accept prw-bundle-accept', `Accept bundle (${view.pending.length})`);
    accept.type = 'button';
    accept.disabled = view.status !== 'open' || view.pending.length === 0;
    accept.onclick = () => this.decideBundle(b.id, 'accept');
    const reject = el('button', 'prw-reject prw-bundle-reject', 'Reject bundle');
    reject.type = 'button';
    reject.disabled = view.status !== 'open' || view.pending.length === 0;
    reject.onclick = () => this.decideBundle(b.id, 'reject');
    actions.append(accept, reject);
    card.append(actions);
    if (view.stale.length) card.append(el('p', 'prw-bundle-fallback', 'Some changes no longer match the text they were bundled on, so the bundle cannot be accepted whole. Review the changes below one by one.'));
    return card;
  }

  /** The line's text with the bundle's changes applied, as this page renders them. */
  private resultingText(lineIndex: number, ids: ReadonlySet<string>): string {
    const view = this.host.lineMarks().editorView();
    const line = this.lines[lineIndex];
    const dom = view && line ? view.nodeDOM(line.pos) as HTMLElement | null : null;
    if (!dom) return line?.text ?? '';
    const clone = dom.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.pask, .pdx-alts, .pask-tag').forEach(node => node.remove());
    clone.querySelectorAll('[data-mark-id]').forEach(node => {
      const id = node.getAttribute('data-mark-id') ?? '';
      const insertWidget = node.classList.contains('mark-replace-insert');
      const insert = insertWidget || (node.classList.contains('mark-insert') && !node.classList.contains('mark-delete'));
      const del = node.classList.contains('mark-delete');
      // This bundle's changes are applied; any other pending change is shown as the text stands now.
      if (ids.has(id) ? del : insert) node.remove();
    });
    return (clone.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  }

  /**
   * Step B4e: Accept or Reject a whole bundle. Accept first re-checks every member against its
   * target hash (this page's lines): a stale bundle refuses, marks the stale changes, and falls
   * back to one-by-one review. The editor applies all members in one step (all or nothing), then
   * the server records the decision.
   */
  decideBundle(id: string, action: 'accept' | 'reject'): boolean {
    const lm = this.host.lineMarks();
    const view = lm.bundleList().find(v => v.bundle.id === id);
    const walk = this.walk;
    if (!view || !walk) return false;
    if (action === 'accept' && !view.acceptable) {
      this.lastError = view.stale.length
        ? `${view.stale.length} of ${view.bundle.members.length} changes in “${view.bundle.title}” changed since they were bundled. Nothing was accepted: review them one by one.`
        : 'Nothing in this bundle can be accepted now.';
      this.bundleDecisions.push({ id, action, ok: false, error: this.lastError });
      this.bundleErrorId = id;
      for (const markId of view.bundle.members.map(m => m.markId)) walk.dropProvisional(markId);
      this.changesSig = '';
      this.afterChange();
      return false;
    }
    const ids = view.pending;
    const first = this.pendingMarks().find(m => ids.includes(m.id));
    const line = first ? lm.lineAtPos(first.range!.from) : walk.focus;
    // An explicit action: first commit the provisional accepts at or above it (not this bundle's).
    const earlier = walk.explicitAction(Math.max(line, walk.focus)).filter(markId => !ids.includes(markId));
    try {
      if (earlier.length) this.host.decide(earlier, 'accept');
      this.host.decide(ids, action);
      for (const markId of ids) walk.decided(markId);
      this.lastError = '';
      this.bundleDecisions.push({ id, action, ok: true });
      void lm.recordBundleDecision(id, action === 'accept' ? 'accepted' : 'rejected');
    } catch (error) {
      walk.restoreProvisional(earlier);
      this.lastError = error instanceof Error ? error.message : 'Could not save the bundle.';
      this.bundleDecisions.push({ id, action, ok: false, error: this.lastError });
    }
    this.changesSig = '';
    this.afterChange();
    return true;
  }

  private changeCard(mark: Mark, flags: { current: boolean; provisional: boolean; passed: boolean }): HTMLElement {
    const card = el('article', 'prw-card');
    card.dataset.markId = mark.id;
    card.dataset.kind = mark.kind;
    if (flags.current) card.dataset.current = 'true';
    if (flags.provisional) card.dataset.provisional = 'true';
    card.style.setProperty('--review-author', getMarkColor(mark.by));
    const who = el('div', 'prw-card-who');
    who.append(el('strong', undefined, getActorName(mark.by)), el('span', undefined, mark.kind === 'comment' ? 'Comment' : 'Suggestion'));
    card.append(who);
    const body = el('div', 'prw-card-body');
    if (mark.kind === 'replace' || mark.kind === 'delete') body.append(el('del', undefined, mark.quote));
    if (mark.kind === 'replace') body.append(' → ');
    if (mark.kind === 'replace' || mark.kind === 'insert') body.append(el('ins', undefined, (mark.data as ReplaceData)?.content || mark.quote));
    if (mark.kind === 'comment') {
      body.append(el('blockquote', undefined, mark.quote));
      body.append(el('p', undefined, (mark.data as CommentData)?.text || ''));
      for (const reply of (mark.data as CommentData)?.replies ?? []) body.append(el('p', 'prw-reply', `${getActorName(reply.by)}: ${reply.text}`));
    }
    card.append(body);
    // Step B4c: the author's one-line rationale, and "Ask why" for an AI's change.
    if (mark.kind !== 'comment') {
      const notes = this.host.lineMarks().notesForMark(mark.id).filter(note => note.why);
      for (const note of notes) {
        const why = el('p', 'prw-why');
        why.append(el('span', 'prw-why-label', 'Why: '), note.why ?? '');
        if (note.by !== mark.by) why.append(el('span', 'prw-why-by', ` (${getActorName(note.by)})`));
        card.append(why);
      }
      if (WHY_POLICY.askWhyFor === 'everyone' || isAiActor(mark.by ?? '')) {
        const ask = el('button', 'prw-link prw-ask-why', 'Ask why');
        ask.type = 'button';
        ask.title = `Posts “${WHY_POLICY.askWhyText}” to ${getActorName(mark.by)} on this change`;
        ask.onclick = () => {
          this.decide(mark, 'reply', `@${getActorName(mark.by)} ${WHY_POLICY.askWhyText}`);
          this.host.lineMarks().noteWhyAsked(mark.id, mark.by ?? null, typeof mark.range?.from === 'number' ? this.host.lineMarks().lineAtPos(mark.range.from) : undefined);
          ask.disabled = true;
          ask.textContent = 'Asked';
          this.whyAsked.push(mark.id);
        };
        card.append(ask);
      }
    }
    if (flags.provisional) {
      const note = el('p', 'prw-card-note', 'Accepted by scrolling · not saved yet');
      const undo = el('button', 'prw-link', 'Undo'); undo.type = 'button';
      undo.onclick = () => { this.walk?.dropProvisional(mark.id); this.afterChange(); };
      note.append(' ', undo);
      card.append(note);
    }
    const actions = el('div', 'prw-card-actions');
    const button = (label: string, action: () => void, cls = '') => {
      const b = el('button', cls, label); b.type = 'button'; b.onclick = action; actions.append(b); return b;
    };
    if (mark.kind !== 'comment') {
      button('Accept', () => this.decide(mark, 'accept'), 'prw-accept');
      button('Reject', () => this.decide(mark, 'reject'), 'prw-reject');
    } else {
      button('Resolve', () => this.decide(mark, 'resolve'));
    }
    button('Reply', () => {
      if (card.querySelector('textarea')) return;
      const field = el('textarea'); field.setAttribute('aria-label', 'Reply'); field.placeholder = 'Write a reply…';
      const send = el('button', undefined, 'Send reply'); send.type = 'button';
      send.onclick = () => { const text = field.value.trim(); if (text) this.decide(mark, 'reply', text); };
      card.append(field, send);
      field.focus();
    });
    card.append(actions);
    return card;
  }

  /** After a step, keep the current mark visible without leaving the line. */
  private revealCurrentMark(): void {
    const current = this.walk?.currentMark();
    if (!current) return;
    const target = document.querySelector(`.ProseMirror [data-mark-id="${CSS.escape(current.id)}"]`) as HTMLElement | null;
    if (!target) return;
    const r = target.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 24) window.scrollBy({ top: r.bottom - window.innerHeight + 48, behavior: 'instant' as ScrollBehavior });
  }

  // --------------------------------------------------------------------------
  // Rails
  // --------------------------------------------------------------------------

  private buildRails(): void {
    const leftHead = el('div', 'prw-rail-head');
    const leftTitle = el('strong', undefined, 'Documents');
    const leftToggle = el('button', 'prw-collapse');
    leftToggle.type = 'button';
    leftToggle.onclick = () => this.toggleRail('left');
    const leftAll = el('a', 'prw-all', 'All');
    leftAll.href = '/';
    leftHead.append(leftTitle, leftAll, leftToggle);
    this.left.append(leftHead, this.leftBody);

    const rightHead = el('div', 'prw-rail-head');
    const rightTitle = el('strong', undefined, 'Reading');
    const rightToggle = el('button', 'prw-collapse');
    rightToggle.type = 'button';
    rightToggle.onclick = () => this.toggleRail('right');
    rightHead.append(rightTitle, this.statusEl, rightToggle, this.meEl, this.proxy.familiarEl, this.rateEl);
    this.meEl.setAttribute('aria-live', 'polite');
    this.provisionalEl.hidden = true;
    this.provisionalEl.setAttribute('aria-live', 'polite');
    this.sinceHost.hidden = true;
    this.sinceHost.setAttribute('aria-label', 'Since you last marked');
    this.buildRate();
    this.rightBody.append(this.sinceHost, this.provisionalEl, this.boxHost, this.changesHost, this.dockHost);
    // Step B7: the chat is a pane at the bottom of the rail, below the line's box: it keeps its
    // composer in view while the rail body above it scrolls.
    this.right.append(rightHead, this.rightBody, this.chatSlot);
    this.right.setAttribute('role', 'complementary');
    this.left.setAttribute('role', 'navigation');
  }

  /** Step B3b: "Reading speed" select (per browser). A line counts as read after its words at this rate. */
  private buildRate(): void {
    const label = el('span', 'prw-rate-label', 'Reading speed');
    const select = el('select');
    select.setAttribute('aria-label', 'Reading speed: how long a line must stay the focus line to count as read');
    for (const rate of READING_WALK.RATE_CHOICES) {
      const option = el('option', undefined, rate > 0 ? `${rate} words/s${rate === READING_WALK.WORDS_PER_SECOND ? ' (default)' : ''}` : `any (${READING_WALK.MIN_DWELL_MS} ms per line)`);
      option.value = String(rate);
      select.append(option);
    }
    select.value = String(savedRate());
    select.onchange = () => this.setReadingRate(Number(select.value));
    const need = el('span', 'prw-rate-need');
    this.rateEl.append(label, select, need);
    this.rateEl.title = 'A line counts as Seen once it has been the focus line for its reading time: its words at this speed (at least 0.25 s, at most 6 s). Lines you scroll past faster are marked skimmed, not Seen.';
  }

  private railState(): { left?: boolean; right?: boolean } {
    try { return JSON.parse(localStorage.getItem(RAIL_STATE_KEY) || '{}'); } catch { return {}; }
  }

  private applyRailState(): void {
    const saved = this.railState();
    // Default: both open when the window has room (>= 1100 px); the documents rail starts
    // collapsed on narrower desktops so the text keeps a readable width.
    const wide = window.innerWidth >= 1100;
    const leftCollapsed = saved.left ?? !wide;
    const rightCollapsed = saved.right ?? false;
    document.body.classList.toggle('prw-left-collapsed', leftCollapsed);
    document.body.classList.toggle('prw-right-collapsed', rightCollapsed);
    this.updateToggleLabels();
  }

  private setCollapsed(side: 'left' | 'right', collapsed: boolean): void {
    const saved = this.railState();
    saved[side] = collapsed;
    try { localStorage.setItem(RAIL_STATE_KEY, JSON.stringify(saved)); } catch { /* optional */ }
    document.body.classList.toggle(`prw-${side}-collapsed`, collapsed);
    this.updateToggleLabels();
    requestAnimationFrame(() => { this.measure(); this.queueRender(); });
  }

  private toggleRail(side: 'left' | 'right'): void {
    if (isPhone()) { this.closeSheets(); return; }
    this.setCollapsed(side, !document.body.classList.contains(`prw-${side}-collapsed`));
  }

  private updateToggleLabels(): void {
    const phone = isPhone();
    for (const [side, rail] of [['left', this.left], ['right', this.right]] as const) {
      const btn = rail.querySelector('.prw-collapse') as HTMLButtonElement | null;
      if (!btn) continue;
      const collapsed = document.body.classList.contains(`prw-${side}-collapsed`);
      const name = side === 'left' ? 'documents' : 'reading panel';
      if (phone) { btn.textContent = '×'; btn.setAttribute('aria-label', `Close ${name}`); btn.removeAttribute('aria-expanded'); continue; }
      btn.textContent = side === 'left' ? (collapsed ? '»' : '«') : (collapsed ? '«' : '»');
      btn.setAttribute('aria-label', `${collapsed ? 'Show' : 'Hide'} ${name}${side === 'right' && this.chatUnread > 0 ? ` (${this.chatUnread} unread chat ${this.chatUnread === 1 ? 'mention' : 'mentions'})` : ''}`);
      if (side === 'right' && this.chatUnread > 0) {
        const badge = el('span', 'prw-badge', String(this.chatUnread));
        badge.setAttribute('aria-hidden', 'true');
        btn.append(badge);
      }
      btn.setAttribute('aria-expanded', String(!collapsed));
      rail.dataset.collapsed = String(collapsed);
    }
  }

  /** Step B7: the chat's unread @mention count, shown as a badge on the right rail's toggle. */
  setChatUnread(count: number): void {
    if (count === this.chatUnread) return;
    this.chatUnread = count;
    this.updateToggleLabels();
  }

  /** Step B7: desktop — the right rail is open (not collapsed). */
  isRightRailOpen(): boolean { return !document.body.classList.contains('prw-right-collapsed'); }

  /** Step B7: desktop — opens the right rail (the chat lives there). */
  openRightRail(): void { if (!isPhone()) this.setCollapsed('right', false); }

  /** Phones: a rail opens as a bottom sheet (from the ⋯ menu). */
  openSheet(side: 'left' | 'right'): void {
    this.closeSheets();
    const rail = side === 'left' ? this.left : this.right;
    rail.classList.add('prw-sheet-open');
    this.updateToggleLabels();
    this.renderNow();
    (rail.querySelector('.prw-collapse') as HTMLButtonElement | null)?.focus({ preventScroll: true });
  }

  closeSheets(): void {
    this.left.classList.remove('prw-sheet-open');
    this.right.classList.remove('prw-sheet-open');
  }

  private async loadDocuments(): Promise<void> {
    try {
      const response = await fetch('/library/api/documents?sort=edited', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (response.status === 401) { this.docsMessage = 'Sign in to see your team’s documents.'; this.docs = null; }
      else if (!response.ok) { this.docsMessage = 'The documents list is not available on this server.'; this.docs = null; }
      else {
        const body = await response.json() as { documents?: LibraryDoc[] };
        this.docs = Array.isArray(body.documents) ? body.documents.slice(0, 60) : [];
        this.docsMessage = this.docs.length ? '' : 'No documents yet.';
      }
    } catch {
      this.docsMessage = 'Could not load the documents list.';
    }
    this.docsSig = '';
    this.renderDocuments();
  }

  private renderDocuments(): void {
    const slug = this.host.slug();
    const issues = this.host.lineMarks().issueSummary()?.counts.total ?? null;
    const sig = JSON.stringify([this.docs?.map(d => [d.slug, d.title, d.pendingSuggestions, d.openComments]), this.docsMessage, slug, issues]);
    if (sig === this.docsSig) return;
    this.docsSig = sig;
    this.leftBody.replaceChildren();
    if (!this.docs) {
      const p = el('p', 'prw-empty', this.docsMessage);
      if (this.docsMessage.startsWith('Sign in')) {
        const a = el('a', undefined, 'Sign in'); a.href = '/';
        p.append(' ', a);
      }
      this.leftBody.append(p);
      return;
    }
    const list = el('ul', 'prw-docs');
    for (const doc of this.docs) {
      const li = el('li');
      const a = el('a', 'prw-doc');
      a.href = `/d/${encodeURIComponent(doc.slug)}`;
      a.dataset.slug = doc.slug;
      if (doc.slug === slug) a.setAttribute('aria-current', 'page');
      a.append(el('span', 'prw-doc-title', doc.title || 'Untitled document'));
      // The current document shows the viewer's live Issue count; the others show their open
      // suggestions and comments (the per-viewer Issue count per document is a later hook).
      const count = doc.slug === slug && issues !== null ? issues : (doc.pendingSuggestions ?? 0) + (doc.openComments ?? 0);
      if (count > 0) {
        const badge = el('span', 'prw-doc-count', String(count));
        badge.title = doc.slug === slug ? `${count} issues for you` : `${count} open suggestions and comments`;
        badge.dataset.kind = doc.slug === slug ? 'issues' : 'open';
        a.append(badge);
      }
      li.append(a);
      list.append(li);
    }
    if (this.docsMessage) this.leftBody.append(el('p', 'prw-empty', this.docsMessage));
    this.leftBody.append(list);
  }

  // --------------------------------------------------------------------------
  // Test hook
  // --------------------------------------------------------------------------

  debugState(): Record<string, unknown> {
    const walk = this.walk;
    return {
      ready: Boolean(walk && this.tops.length),
      focus: walk?.focus ?? -1,
      lines: walk?.lineCount ?? 0,
      step: walk?.stepIndex() ?? 0,
      current: walk?.currentMark()?.id ?? null,
      marksOnFocus: walk?.marksOn(walk.focus).map(m => m.id) ?? [],
      provisional: walk?.provisionalIds() ?? [],
      seenWrites: [...this.seenWrites],
      skimmed: [...this.skimmedLines],
      rate: walk?.readingRate ?? null,
      dwellMs: walk ? walk.dwellFor(walk.focus) : null,
      flagged: [...this.host.lineMarks().flaggedLineSet()],
      whyAsked: [...this.whyAsked],
      explained: [...this.explained],
      bundleDecisions: [...this.bundleDecisions],
      since: this.sinceReport ? { hasHistory: this.sinceReport.hasHistory, counts: this.sinceReport.counts, baseline: this.sinceReport.baseline } : null,
      readingY: this.readingY(),
      tops: [...this.tops],
      constants: READING_WALK,
      error: this.lastError,
    };
  }
}
