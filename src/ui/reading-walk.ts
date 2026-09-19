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
import { actorKey, type DocLine } from '../shared/line-marks';
import { ASK_POLICY, type AskChoice } from '../shared/asks';
import { GestureGate, READING_WALK, ReadingWalk, type WalkLine, type WalkMark, type WalkSnapshot } from '../shared/reading-walk';
import type { LineMarksUI, MarkBox } from './line-marks';
import { isOpenReviewMark, type PlayMakerReview, type ReviewAction } from './playmaker-review';
import './reading-walk.css';

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
  private readonly provisionalEl = el('div', 'prw-provisional');
  private readonly boxHost = el('section', 'prw-linebox');
  private readonly changesHost = el('section', 'prw-changes');
  private readonly dockHost = el('div', 'prw-dock');
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
  private docs: LibraryDoc[] | null = null;
  private docsMessage = 'Loading…';
  private readonly seenWrites: number[] = [];
  private lastError = '';

  constructor(private readonly host: ReadingWalkHost) {
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
    this.unsubscribe = this.host.lineMarks().subscribe(() => this.sync());
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
  }

  /** The editor view updated (cursor, marks, text): re-read pending marks if they changed. */
  notifyViewUpdate(): void {
    if (!this.started) return;
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
    return this.pendingMarks().map(mark => `${mark.id}@${mark.range!.from}`).join(',') + `|${this.host.lineMarks().lineList().length}`;
  }

  private sync(): void {
    const lm = this.host.lineMarks();
    this.lines = lm.lineList();
    const pending = this.pendingMarks();
    this.marksSig = pending.map(mark => `${mark.id}@${mark.range!.from}`).join(',') + `|${this.lines.length}`;
    const hidden = this.host.hiddenLines?.() ?? new Set<number>();
    const walkLines: WalkLine[] = this.lines.map(line => ({
      key: `${line.hash}:${line.occurrence}`,
      marks: [] as WalkMark[],
      ...(hidden.has(line.index) ? { hidden: true } : {}),
    }));
    for (const mark of pending) {
      const index = lm.lineAtPos(mark.range!.from);
      if (index < 0 || !walkLines[index]) continue;
      walkLines[index].marks.push({ id: mark.id, kind: mark.kind === 'comment' ? 'comment' : 'suggestion' });
    }
    const now = performance.now();
    if (!this.walk) {
      if (walkLines.length === 0) return;
      this.walk = new ReadingWalk(walkLines, now);
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
    this.afterChange();
  }

  private view() { return this.host.lineMarks().editorView(); }

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
    let target = this.lineAtReadingLine();
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
    if (key === 'a' || key === 'A') { event.preventDefault(); this.markFocus('agreed'); return; }
    if (key === 'r' || key === 'R') { event.preventDefault(); this.openReason(); return; }
    if (key === 'j' || key === 'J' || key === 'ArrowDown') { event.preventDefault(); this.next(); return; }
    if (key === 'k' || key === 'K' || key === 'ArrowUp') { event.preventDefault(); this.previous(); return; }
    // Step B3: Y / N / T answer the ask on the focus line (only when the line carries one).
    const choice = (Object.keys(ASK_POLICY.keys) as AskChoice[]).find(c => ASK_POLICY.keys[c] === key.toLowerCase());
    if (choice && this.host.lineMarks().askForLine(this.walk.focus)) {
      event.preventDefault();
      this.answerFocus(choice);
    }
  };

  /** Step B3: Y / N / T on the focus line's ask. */
  private answerFocus(choice: AskChoice): void {
    if (ASK_POLICY.reasonRequired[choice]) {
      if (isPhone()) this.openSheet('right');
      else if (document.body.classList.contains('prw-right-collapsed')) this.setCollapsed('right', false);
    }
    this.renderNow();
    this.box?.ask?.choose(choice);
  }

  /** Step B3: the viewer answered the ask on `line` (from any control): an explicit action. */
  askAnswered(line: number): void {
    if (!ASK_POLICY.answerIsExplicitReadingAction) return;
    this.explicit(line);
  }

  /** A click on a review mark in the text is an explicit action on its line. */
  private onDocClick = (event: MouseEvent): void => {
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
    // Step B2: a folded section is one step.
    const to = walk.nextVisible(1);
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
    const to = walk.nextVisible(-1);
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
    this.box?.choose(status);
  }

  private openReason(): void {
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
        const status = lm.myStatus(line);
        if (status !== 'unseen' && status !== 'changed') continue; // never downgrade a mark
        this.seenWrites.push(line);
        await lm.setLineStatus(line, 'seen');
      }
    } finally {
      this.seenBusy = false;
    }
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
    this.renderBox();
    this.renderChanges();
    this.renderDocuments();
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
    const sig = `${walk.focus}|${line.hash}|${line.occurrence}|${marks}|${summary?.team.join(',') ?? ''}|${lm.isLoaded()}|${lm.askSignature(walk.focus)}`;
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
    head.append(el('strong', undefined, 'Mark this line'),
      el('span', 'prw-keys', hasAsk ? 'Y yes · N no · T not yet' : 'A agree · R reject · J/K move'));
    this.boxHost.replaceChildren(head, box.root);
    this.box = box;
  }

  private renderChanges(): void {
    const walk = this.walk!;
    const onLine = walk.marksOn(walk.focus);
    const all = new Map(this.pendingMarks().map(mark => [mark.id, mark]));
    const current = walk.currentMark();
    const sig = JSON.stringify([walk.focus, onLine.map(m => [m.id, walk.isPassed(m.id), walk.isProvisional(m.id)]), current?.id,
      onLine.map(m => { const mk = all.get(m.id); return mk ? [mk.at, mk.data] : null; })]);
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
      this.changesHost.append(this.changeCard(mark, {
        current: current?.id === mark.id,
        provisional: walk.isProvisional(mark.id),
        passed: walk.isPassed(mark.id),
      }));
    }
    const hint = el('p', 'prw-hint', 'Scroll down to step through the changes; scrolling past a change accepts it until you scroll back up.');
    this.changesHost.append(hint);
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
    rightHead.append(rightTitle, this.statusEl, rightToggle);
    this.provisionalEl.hidden = true;
    this.provisionalEl.setAttribute('aria-live', 'polite');
    this.rightBody.append(this.provisionalEl, this.boxHost, this.changesHost, this.dockHost);
    this.right.append(rightHead, this.rightBody);
    this.right.setAttribute('role', 'complementary');
    this.left.setAttribute('role', 'navigation');
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
      btn.setAttribute('aria-label', `${collapsed ? 'Show' : 'Hide'} ${name}`);
      btn.setAttribute('aria-expanded', String(!collapsed));
      rail.dataset.collapsed = String(collapsed);
    }
  }

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
      readingY: this.readingY(),
      tops: [...this.tops],
      constants: READING_WALK,
      error: this.lastError,
    };
  }
}
