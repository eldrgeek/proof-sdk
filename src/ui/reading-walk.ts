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
 *
 * Accord layout stage 3 (Ren's proposal, Mike ruled 2026-09-21; decisions 4, 6, 7, 8, 11;
 * policies in src/shared/layout-panels.ts): the left rail is the Navigator (Outline · Issues ·
 * Since you, src/ui/navigator.ts), the right rail is the Margin (Line N · Room). The reading focus
 * and the focus line are one cursor (walk.focus); hovering another line previews it in the Margin
 * and a key or a Margin click commits the preview. Phones: a bottom strip (Line N of M, Agree,
 * Reject, ⋯) and the Margin as a sheet under it.
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
import { editSession, editingGuardDebug, editingRemainingMs, endWriting, installEditingGuard, isEditing, isReadingOwned, isWriting, onEditSessionChange, onEditingActivity, onWritingChange, startWriting, syncEditSession } from '../editor/editing-guard';
import { EDIT_SESSION_POLICY, editingHelpText, editingStatusText, postedNoticeText } from '../shared/edit-session';
import { READING_MODE_POLICY } from '../shared/reading-keys';
// Accord round 2, stage D: the discussion on a line lives in the document, in the Line tab.
import { ThreadsPanel } from './threads';
import { THREAD_POLICY, type ThreadAsks, type ThreadStatus } from '../shared/threads';
import { Selection } from '@milkdown/kit/prose/state';
import { ProxyMarksUI } from './proxy-marks';
import { ReadingSettingsUI } from './reading-settings';
import { SETTINGS_POLICY } from '../shared/layout-chrome';
import { ScrollFollower, containRailWheel } from './rail-follow';
import { SCROLL_CAMERA_POLICY, bandFractionFor, cameraScroll, deadZone, type CameraView } from '../shared/scroll-camera';
import { TIER_POLICY } from '../shared/line-tiers';
import { HIGHLIGHT_POLICY, MARKED_UP_TO_POLICY, STATUS_BAR_POLICY, formatAgo, issuesLeftText } from '../shared/layout-status';
import { CURSOR_POLICY, MARGIN_POLICY, NAVIGATOR_POLICY, PHONE_STRIP_POLICY, parseRailState, type MarginTab, type RailState } from '../shared/layout-panels';
import { NavigatorUI } from './navigator';
import type { FoldingUI } from './folding';
import './reading-walk.css';
import './layout-panels.css';

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

/**
 * Hover focus (Mike, 2026-09-19): "Hovering over a line puts its decision mark in the chat; having
 * to click is extra work." On a desktop pointer, resting the mouse on a line for `delayMs` previews
 * it in the Margin's Line tab (Accord layout stage 3, CURSOR_POLICY): the cursor, the blue bar and
 * the status bar stay put, and the first key (A, R, …) or click in the Margin moves the cursor to
 * the previewed line and acts there, so no extra click is needed. Hover is not reading: the walk's
 * reading position, dwell (Seen / Agreed) and scroll are untouched. While the person edits, the
 * caret owns the cursor.
 */
export const HOVER_FOCUS_POLICY = {
  enabled: true,
  /** Rest this long on a line before it becomes the focus (passing the mouse across does not thrash). */
  delayMs: 150,
  /** Pointers that hover precisely (a mouse or trackpad). */
  query: '(hover: hover) and (pointer: fine)',
  /** A pointer event closer than this to the last one is not a move (synthetic events after scroll or layout). */
  minMovePx: 3,
  /** A move of the reading position (scroll, J / K, Next issue, a jump) hands the focus back to it. */
  walkMoveClearsHover: true,
} as const;

/**
 * Touch focus (Mike, 2026-09-19): "On a touch surface, there should be some other way to indicate
 * what the current mark or the current item being looked at is." The focus line is the reading
 * line; it gets a strong band and a left bar, and a strip docked at the bottom shows its mark and
 * three big buttons (Agree / Reject / More…). Tapping text still edits (editing first).
 */
export const TOUCH_FOCUS_POLICY = {
  enabled: true,
  query: '(pointer: coarse)',
  /** Height the page reserves for the strip (px, plus the safe area). */
  stripHeightPx: PHONE_STRIP_POLICY.heightPx,
  /** While the caret is in the text (keyboard up), the strip steps aside so it never covers the text being edited. */
  hideWhileEditing: true,
} as const;

const STATUS_WORDS: Record<string, string> = {
  unseen: 'Not marked yet', seen: 'Seen', agreed: 'Agreed', approved: 'Approved', rejected: 'Rejected',
  skimmed: 'Skimmed', changed: 'Changed since you marked it', stale: 'Marked long ago',
};

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
  /** The focus line changed (closed-Issue folding waits until the reader leaves a line). */
  focusChanged?(lineIndex: number): void;
  /** Accord layout stage 3: the folding owner, for the Navigator's Outline. */
  folding?(): FoldingUI | null;
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

/**
 * Keys go to the text or field instead of the reading commands. The document's own text counts
 * only while the person is writing (src/shared/reading-keys.ts): a caret the person did not put
 * there is reading, and the editing guard has already stopped the key from typing.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  const typing = (node: HTMLElement | null): boolean => {
    if (!node || typeof node.closest !== 'function') return false;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)) return true;
    if (!node.isContentEditable) return false;
    return node.closest('.ProseMirror') ? isWriting() : true;
  };
  return typing(target as HTMLElement | null) || typing(document.activeElement as HTMLElement | null);
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
  private readonly rightBody = el('div', 'prw-rail-body');
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
  /** Accord stage D: the threads anchored to the line the Margin shows. */
  private threads: ThreadsPanel | null = null;
  private readonly dockHost = el('div', 'prw-dock');
  /** Step B7: the chat pane's place in the right rail (below the line's box and changes). */
  readonly chatSlot = el('div', 'prw-chat');
  private rightHeadEl: HTMLElement | null = null;
  /** Step B7: unread @mentions of the viewer in the chat (a badge on the rail toggle). */
  private chatUnread = 0;
  private readonly focusEl = el('div', 'prw-focus');
  /**
   * The mode, shown as state in the status bar (Accord layout stage 1): "Reading" or, while an
   * edit is open, "Editing line N" (Accord round 2 stage A). It is not a switch
   * (STATUS_BAR_POLICY.modeIsSwitch).
   */
  private readonly modeEl = el('span', 'prw-mode pst-mode');
  /** Accord round 2 stage A: "Proposed — Undo" after a leave posts, then it goes quiet. */
  private readonly sbNotice = el('span', 'pst-notice');
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeSession: (() => void) | null = null;
  /** Phones: the visible Done control while editing (there is no Cmd+Enter on a phone). */
  private readonly doneBtn = el('button', 'prw-edit-done', EDIT_SESSION_POLICY.phoneDoneLabel);
  /**
   * Accord layout stage 1: the status bar fixed under the page (Line N of M · You marked up to
   * line K · Issues left · scroll-accepts to save · Reading / Writing), and the "You marked up to
   * here" rule inside the page after the viewer's last explicit mark.
   */
  private readonly statusBar = el('div', 'pst-bar');
  private readonly sbLine = el('span', 'pst-line');
  private readonly sbMarked = el('span', 'pst-marked');
  private readonly sbIssues = el('span', 'pst-issues');
  private readonly sbProvisional = el('span', 'pst-provisional');
  private readonly ruleEl = el('div', 'pst-rule');
  private statusSig = '';
  private agoTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeWriting: (() => void) | null = null;
  /** Rail scrolling (2026-09-21): the right rail's body keeps the focus line's box and changes in view. */
  private railFollow: ScrollFollower | null = null;
  private readonly railWheelCleanups: Array<() => void> = [];
  private readonly styleEl = el('style');
  private readonly gate = new GestureGate();
  private box: MarkBox | null = null;
  private boxSig = '';
  private changesSig = '';
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
  /**
   * Accord round 2 stage B: the reading line — the viewport y the cursor line sits at. null means
   * the default (the first line's place, with the page at the top). The camera
   * (src/shared/scroll-camera.ts) sets it on a cursor move the person caused; scrolling by hand
   * then walks the cursor line by line from there, so the camera and the reader never fight.
   */
  private readingOffset: number | null = null;
  /** The offset the camera last scrolled to: its own scroll event must not move the cursor. */
  private cameraAt: number | null = null;
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

  /** Hover focus: the line the mouse rests on (null: the reading line is the focus). */
  private hoverLine: number | null = null;
  private hoverCandidate: number | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPointer: { x: number; y: number } | null = null;
  private lastWalkFocus = -1;
  /** Touch focus: the strip docked at the bottom. */
  private readonly strip = el('div', 'prw-strip');
  private stripSig = '';
  private stripTouch: { y: number; at: number } | null = null;

  /** Accord layout stage 3 (decision 7): the Navigator, the left side's three tabs. */
  readonly navigator: NavigatorUI;
  /** Accord layout stage 3 (decision 6): the Margin's two tabs, Line N and Room. */
  private readonly marginTabs = el('div', 'amg-tabs');
  private readonly lineTabBtn = el('button', 'amg-tab');
  private readonly roomTabBtn = el('button', 'amg-tab');
  private readonly roomBadge = el('span', 'amg-badge');
  private readonly linePane = el('div', 'amg-pane');
  private readonly roomPane = el('div', 'amg-pane');
  /** Phones: the one Undo sits at the top of the Line tab (desktop: the toolbar). */
  private readonly lineTools = el('div', 'amg-tools');
  /** The Familiar's note (folded) and everyone's marks on the line, after the line's changes. */
  private readonly tailHost = el('div', 'amg-tail');
  private readonly replyHost = el('form', 'amg-reply');
  /** Who the viewer's marks name, and My Familiar: the Line tab's footer. */
  private readonly meRow = el('div', 'amg-me');
  private marginTab: MarginTab = MARGIN_POLICY.defaultTab;
  private tailSig = '';
  private lineTabSig = '';
  /** Test hook: preview commits (the line the preview moved the cursor to, and what did it). */
  private readonly previewCommits: Array<{ line: number; via: 'key' | 'margin' }> = [];

  /** Familiar proxy marks: My Familiar (header), the brief (top of the rail), the phone pill. */
  readonly proxy: ProxyMarksUI;
  /** Accord layout stage 2 (decision 10): reading speed and This sitting live in View › Reading settings. */
  readonly settings = new ReadingSettingsUI();

  constructor(private readonly host: ReadingWalkHost) {
    this.proxy = new ProxyMarksUI({
      lineMarks: () => this.host.lineMarks(),
      // Ratify is an explicit action: the provisional (scroll) accepts are committed first.
      beforeRatify: () => { const ids = this.walk?.commitAll() ?? []; if (ids.length) this.commit(ids); },
      focusLine: (index) => { this.host.lineMarks().revealLine(index); this.focusLine(index); if (isPhone()) this.closeSheets(); },
      openBrief: () => { if (isPhone()) this.openSheet('right'); else this.setCollapsed('right', false); this.proxy.briefEl.scrollIntoView({ block: 'nearest' }); },
    });
    this.left.setAttribute('aria-label', 'Navigator');
    this.right.setAttribute('aria-label', 'Margin: this line, and the room');
    this.focusEl.setAttribute('aria-hidden', 'true');
    this.styleEl.id = 'prw-dynamic-style';
    const saved = this.railState();
    if (saved.rightTab) this.marginTab = saved.rightTab;
    this.navigator = new NavigatorUI({
      lineMarks: () => this.host.lineMarks(),
      folding: () => this.host.folding?.() ?? null,
      cursor: () => this.cursorLine(),
      go: (index) => { this.host.lineMarks().revealLine(index); this.focusLine(index); if (isPhone()) this.closeSheets(); },
      tabChanged: (tab) => this.saveRailState({ leftTab: tab }),
    }, saved.leftTab, this.sinceHost);
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
    // Rail scrolling: a wheel over a rail scrolls that rail's lists only, never the page.
    this.railWheelCleanups.push(containRailWheel(this.left), containRailWheel(this.right));
    window.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('touchstart', this.onTouchStart, { passive: true });
    window.addEventListener('touchmove', this.onTouchMove, { passive: false });
    window.addEventListener('touchend', this.onTouchEnd, { passive: true });
    window.addEventListener('resize', this.onResize);
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('click', this.onDocClick, true);
    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('pointermove', this.onPointerMove, { passive: true });
    document.addEventListener('pointerdown', this.onPointerDownHover, true);
    document.addEventListener('focusin', this.onFocusChange);
    document.addEventListener('focusout', this.onFocusChange);
    // One cursor: a click (or a field taking focus) in the Margin commits a hover preview first.
    document.addEventListener('click', this.onMarginPointer, true);
    document.addEventListener('focusin', this.onMarginPointer, true);
    window.addEventListener('proof:follow-in-page-link', this.onInPageLink as EventListener);
    document.body.append(this.strip, this.statusBar);
    document.body.classList.add('pst-on');
    // Accord layout stage 1: highlights the proposal removed come back only by policy.
    document.body.classList.toggle('phl-context-dim', HIGHLIGHT_POLICY.contextDimming);
    document.body.classList.toggle('phl-hover-band', HIGHLIGHT_POLICY.hoverBand);
    this.agoTimer = setInterval(() => { this.statusSig = ''; this.renderStatusBar(); }, MARKED_UP_TO_POLICY.refreshMs);
    try { window.matchMedia(PHONE_QUERY).addEventListener('change', this.onResize); } catch { /* old browsers */ }
    try { window.matchMedia(TOUCH_FOCUS_POLICY.query).addEventListener('change', this.onResize); } catch { /* old browsers */ }
    // Step B4c: "This sitting" (the budget setting and its status) sits under the reading speed,
    // both in View › Reading settings since Accord layout stage 2 (decision 10).
    const budget = this.host.lineMarks().budgetEl;
    if (SETTINGS_POLICY.readingSettingsInView) this.settings.mount(this.rateEl, budget);
    else { this.rightHeadEl?.append(this.rateEl); if (budget.parentElement !== this.rightBody) this.rightBody.insertBefore(budget, this.boxHost); }
    // Step B4f: blind marking (an Owner's switch for the whole document) moved to the Share dialog's
    // Link tab (Accord layout stage 3, COS): the editor mounts lineMarks().blindEl there.
    // Line tiers: decision / context counts and "Show only decisions" sit with the Outline's tools.
    const tiers = this.host.lineMarks().tierEl;
    if (tiers.parentElement !== this.navigator.toolsEl) this.navigator.toolsEl.append(tiers);
    // Familiar proxy marks: the brief is the first thing in the Line tab (folded to its headline).
    this.rightBody.prepend(this.proxy.briefEl);
    this.proxy.start();
    (window as unknown as { __proofProxy?: ProxyMarksUI }).__proofProxy = this.proxy;
    this.unsubscribe = this.host.lineMarks().subscribe(() => this.sync());
    installEditingGuard();
    (window as unknown as { __proofEditingGuard?: typeof editingGuardDebug }).__proofEditingGuard = editingGuardDebug;
    this.unsubscribeWriting = onWritingChange(() => { this.renderMode(); this.queueRender(); });
    this.unsubscribeSession = onEditSessionChange(() => { this.renderMode(); this.queueRender(); });
    this.renderMode();
    this.unsubscribeEditing = onEditingActivity(() => {
      // The press that places the caret lands before focus moves: check on the next frame.
      requestAnimationFrame(() => { if (isEditing()) { this.rebaseAfterEdit = true; this.clearHover(); this.queueFollowCaret(); } });
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
    document.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerdown', this.onPointerDownHover, true);
    document.removeEventListener('focusin', this.onFocusChange);
    document.removeEventListener('focusout', this.onFocusChange);
    document.removeEventListener('click', this.onMarginPointer, true);
    document.removeEventListener('focusin', this.onMarginPointer, true);
    window.removeEventListener('proof:follow-in-page-link', this.onInPageLink as EventListener);
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.strip.remove();
    this.statusBar.remove();
    this.ruleEl.remove();
    if (this.agoTimer) clearInterval(this.agoTimer);
    this.agoTimer = null;
    document.body.classList.remove('prw-touch', 'prw-strip-on', 'pst-on', 'phl-context-dim', 'phl-hover-band', 'prw-margin-sheet');
    this.unsubscribe?.();
    this.proxy.stop();
    this.unsubscribeEditing?.();
    this.unsubscribeEditing = null;
    this.unsubscribeWriting?.();
    this.unsubscribeWriting = null;
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    for (const cleanup of this.railWheelCleanups.splice(0)) cleanup();
    this.resizeObserver?.disconnect();
    this.host.playmaker()?.dock(null);
    this.left.remove(); this.right.remove(); this.focusEl.remove(); this.styleEl.remove();
    this.settings.remove();
  }

  /** Step B2: a section folded or unfolded. Rebuild the walk's hidden lines and the rail box. */
  onFoldChange(): void {
    if (!this.started) return;
    this.boxSig = '';
    this.sync();
  }

  /**
   * Step B2: a tool (the outline fold controls) at the top of the right rail. `first` puts it
   * above the other tools — the one Undo sits there, so it is always the first thing in reach.
   */
  mountTool(node: HTMLElement, options: { first?: boolean } = {}): void {
    // Accord layout stage 3: the outline tools live on the Navigator's Outline tab. `first` is the
    // one Undo on a phone: it sits at the top of the Margin's Line tab.
    if (options.first) {
      if (node.parentElement !== this.lineTools) this.lineTools.prepend(node);
      return;
    }
    const tools = this.navigator.toolsEl;
    const tiers = this.host.lineMarks().tierEl;
    if (node.parentElement !== tools) {
      if (tiers.parentElement === tools) tools.insertBefore(node, tiers); else tools.append(node);
    }
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

  /** Is the caret's line off screen (above the top bar or below the window)? */
  private caretOutOfView(): boolean {
    const view = this.view();
    if (!view) return false;
    try {
      const at = view.coordsAtPos(view.state.selection.head);
      const top = parseFloat(getComputedStyle(document.body).getPropertyValue('--prw-top')) || 0;
      return at.bottom < top || at.top > window.innerHeight;
    } catch { return false; }
  }

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
    if (container && this.ruleEl.parentElement !== container) container.append(this.ruleEl);
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
    // Accord layout stage 3: the Navigator and the Margin sit flush under the toolbar (the mockup).
    document.body.style.setProperty('--prw-chrome', `${Math.max(0, bannerBottom)}px`);
  }

  /**
   * Where (viewport y) the cursor line sits. Without the camera that is the first line's place with
   * the page at the top (Step 1b's reading line); after a cursor move the camera has put the cursor
   * in the middle band and left its y here, and scrolling walks the cursor from there.
   */
  private readingY(): number {
    const base = Math.max(0, this.tops[0] ?? 0);
    return this.readingOffset === null ? base : Math.max(0, this.readingOffset);
  }

  /** The viewport as the camera sees it: the reading area under the chrome, and what is left to scroll. */
  private cameraView(): CameraView {
    const chrome = Number.parseFloat(document.body.style.getPropertyValue('--prw-chrome')) || 0;
    const height = window.innerHeight;
    const doc = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0);
    return {
      viewportHeight: height,
      topInset: Math.min(Math.max(0, chrome), Math.max(0, height - 1)),
      scrollY: window.scrollY,
      maxScroll: Math.max(0, doc - height),
      bandFraction: bandFractionFor(isPhone()),
    };
  }

  /**
   * The camera: put the cursor line in the middle band, immediately (never an animated scroll), and
   * remember where the cursor now sits so a later hand-scroll starts from there. Only ever called
   * for a cursor move the person caused.
   */
  private cameraTo(index: number): void {
    // Measure first: the camera places a real box, so a stale cache would put the cursor a few px
    // out of the band — and a cursor that is only partly visible is the bug this stage fixes.
    this.measure();
    const top = this.tops[index];
    if (top === undefined) return;
    const view = this.cameraView();
    const line = { top, height: this.heights[index] ?? 0 };
    const offset = cameraScroll(line, view);
    this.readingOffset = Math.max(0, top - offset);
    if (Math.abs(offset - view.scrollY) > 0.5) {
      this.cameraAt = offset;
      window.scrollTo({ top: offset, behavior: SCROLL_CAMERA_POLICY.behavior as ScrollBehavior });
    }
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

  /**
   * Holds the page so `index` sits on the reading line — the barrier snap. It does NOT move the
   * reading line: the camera owns that, and a barrier is the page refusing to go further, not a
   * cursor move.
   */
  private pinLine(index: number): void {
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
    // Writing mode: once typing has paused, scrolling the caret's line out of view is reading.
    if (READING_MODE_POLICY.caretOutOfViewEndsWriting && isWriting() && !isEditing() && this.caretOutOfView()) endWriting('scrolled-away');
    // Editing first: while the person edits, scrolling moves nothing and snaps nothing.
    if (isEditing()) { this.rebaseAfterEdit = true; this.queueRender(); return; }
    // Stage B: the camera's own scroll is not the person scrolling. It has already put the cursor
    // where it belongs, so this event reads nothing and moves nothing.
    if (this.cameraAt !== null) {
      const mine = Math.abs(window.scrollY - this.cameraAt) <= 1;
      this.cameraAt = null;
      if (mine) { this.queueRender(); return; }
    }
    // At the very top of the document the reading line returns to the first line's place: the page
    // has nothing left to give, so the line under the top of the page is the cursor again.
    if (window.scrollY <= 0) this.readingOffset = null;
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
        this.pinLine(barrier);
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
        if (window.scrollY < max) this.pinLine(barrier);
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
    // The editing guard prevents a reading key's default when the text holds the keyboard without
    // the person writing (so it never types): that key is still ours to run.
    if (!this.walk || (event.defaultPrevented && !isReadingOwned(event)) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('[role="dialog"], .pm-review-dialog, .mark-popover, .plm-menu, .proof-share-overflow-menu, [role="menu"]')) return;
    const key = event.key;
    if (key === 'Escape' && this.host.lineMarks().selectionLines().length) { this.host.lineMarks().clearSelection(); return; }
    // Enter while reading: write at the end of the focus line (not on a button, which Enter presses).
    if (key === 'Enter') {
      if (!READING_MODE_POLICY.enterStartsWriting || target?.closest?.('button, a[href], summary, [role="button"]')) return;
      event.preventDefault();
      this.writeAtFocus();
      return;
    }
    // One cursor (Accord layout stage 3): a mark key on a previewed line commits the preview first,
    // so the key acts on the line the Margin shows (CURSOR_POLICY.keyCommitsPreview).
    if (key === 'a' || key === 'A') { event.preventDefault(); this.commitPreview('key'); this.markFocus('agreed'); return; }
    if (key === 'r' || key === 'R') { event.preventDefault(); this.commitPreview('key'); this.openReason(); return; }
    if (key === 'j' || key === 'J' || key === 'ArrowDown') { event.preventDefault(); this.clearHover(); this.next(); return; }
    if (key === 'k' || key === 'K' || key === 'ArrowUp') { event.preventDefault(); this.clearHover(); this.previous(); return; }
    // Line tiers: D flips the focus line between decision and context (an explicit action).
    if (key.toLowerCase() === TIER_POLICY.flipKey) { event.preventDefault(); this.commitPreview('key'); this.flipFocusTier(); return; }
    // Step B4f: E asks the AI collaborators to explain the focus line (never a rejection).
    if (key.toLowerCase() === EXPLAIN_POLICY.key) { event.preventDefault(); this.commitPreview('key'); this.explainFocus(); return; }
    // Step B4f: 1-9 pick among the focus line's competing wordings (1 is the original).
    const focus = this.targetLine();
    if (/^[1-9]$/.test(key) && this.host.lineMarks().altSetFor(focus)) {
      event.preventDefault();
      this.commitPreview('key');
      this.explicit(focus);
      void this.host.lineMarks().pickAlternative(focus, key);
      return;
    }
    // Step B3: Y / N / T answer the ask on the focus line (only when the line carries one).
    const choice = (Object.keys(ASK_POLICY.keys) as AskChoice[]).find(c => ASK_POLICY.keys[c] === key.toLowerCase());
    if (choice && this.host.lineMarks().askForLine(focus)) {
      event.preventDefault();
      this.commitPreview('key');
      this.answerFocus(choice);
      return;
    }
    // Accord stage D: T starts a thread on the selection, or on the cursor line when nothing is
    // selected. T's older meaning — "Not yet" to an ask — is kept above and wins on a line that
    // carries an ask (THREAD_POLICY.askAnswerWins); on every other line T was doing nothing.
    if (key.toLowerCase() === THREAD_POLICY.key) {
      event.preventDefault();
      this.commitPreview('key');
      this.startThreadHere();
      return;
    }
  };

  /** T: open the thread composer in the Margin's Line tab, on the selection or the cursor line. */
  startThreadHere(fromSelection = false): boolean {
    if (!this.threads) return false;
    this.selectMarginTab('line');
    if (isPhone()) this.openSheet('right');
    else if (document.body.classList.contains('prw-right-collapsed')) this.setCollapsed('right', false);
    const opened = this.threads.openComposer(fromSelection);
    if (opened) this.threads.element.scrollIntoView({ block: 'nearest' });
    return opened;
  }

  /** Accord stage D: the discussion panel in the Line tab. */
  private buildThreads(): ThreadsPanel {
    const lm = () => this.host.lineMarks();
    return new ThreadsPanel({
      focusLine: () => this.targetLine(),
      lineText: (index) => this.lines[index]?.text ?? '',
      threadsOnLine: (index) => lm().threadsOnLine(index),
      // The subject of a thread: a selected range of the document (line-selected or text-selected),
      // else the line in focus.
      selectedLines: (force) => {
        const selected = lm().selectionLines();
        if (selected.length) return selected;
        const view = this.view();
        const selection = view?.state.selection;
        if (!view || !selection || selection.empty) return [];
        const from = lm().lineAtPos(selection.from);
        const to = lm().lineAtPos(Math.max(selection.from, selection.to - 1));
        if (from < 0 || to < 0) return [];
        // A selection the cursor has left is not what T is about: an old highlight the person is no
        // longer standing in must never quietly become the subject of their thread. The selection
        // bar's Thread button passes `force`, because there the selection IS what they just made.
        const focus = this.targetLine();
        if (!force && (focus < from || focus > to)) return [];
        return Array.from({ length: Math.max(0, to - from) + 1 }, (_, i) => from + i);
      },
      selectionText: () => {
        const view = this.view();
        const selection = view?.state.selection;
        if (!view || !selection || selection.empty) return null;
        const text = view.state.doc.textBetween(selection.from, selection.to, ' ', ' ').trim();
        return text || null;
      },
      me: () => lm().me(),
      isOwner: () => lm().canApproveHere?.() === true,
      canComment: () => lm().canCommentHere(),
      team: () => lm().issueSummary()?.team ?? [],
      start: (input) => lm().startThread(input as { lines: number[]; text: string; asks: ThreadAsks; selection: string | null }),
      close: (id, status) => lm().closeThread(id, status as ThreadStatus),
      reopen: (id) => lm().reopenThread(id),
      reply: (id, text) => lm().replyOnThread(id, text),
      refresh: () => this.renderNow(),
    });
  }

  /** Test hook: the Line tab's discussion panel. */
  threadsPanel(): ThreadsPanel | null { return this.threads; }

  /**
   * One cursor: the previewed line becomes the cursor (a jump: no scroll, nothing read on the way).
   * `render` false: the caller is inside a click on the Margin, whose box already shows this line;
   * re-rendering now would replace the button being clicked before its click runs.
   */
  private commitPreview(via: 'key' | 'margin', render = true): boolean {
    const walk = this.walk;
    const line = this.hoverLine;
    if (!walk || line === null) return false;
    if ((via === 'key' && !CURSOR_POLICY.keyCommitsPreview) || (via === 'margin' && !CURSOR_POLICY.marginClickCommitsPreview)) return false;
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    this.hoverCandidate = null;
    this.hoverLine = null;
    this.previewCommits.push({ line, via });
    if (line === walk.focus || line >= walk.lineCount || walk.isHidden(line)) { if (render) this.renderNow(); return false; }
    this.measure();
    walk.moveTo(line, performance.now(), 'jump', this.heights);
    // The walk moved on purpose: afterChange must not treat it as a move that clears a hover.
    this.lastWalkFocus = walk.focus;
    for (const event of walk.drain()) {
      if (event.type === 'seen') this.enqueueSeen(event.line);
      else if (event.type === 'skimmed') this.enqueueSkim(event.line);
    }
    this.scheduleTick();
    this.scheduleSave();
    if (render) this.renderNow(); else this.queueRender();
    return true;
  }

  /** A click inside the Margin while a line is previewed commits the preview (capture phase, before the click runs). */
  private onMarginPointer = (event: Event): void => {
    if (this.hoverLine === null) return;
    const target = event.target as Node | null;
    if (!target || !this.linePane.contains(target)) return;
    this.commitPreview('margin', false);
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
    const focus = this.targetLine();
    this.explained.push(focus);
    void this.host.lineMarks().explainLine(focus);
  }

  /** The person is typing in a field in the right rail (a reason, a reply): the rail holds still. */
  private typingInRail(): boolean {
    const active = document.activeElement as HTMLElement | null;
    return Boolean(active && this.right.contains(active) && (['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) || active.isContentEditable));
  }

  /**
   * The rail body's scrollTop that puts the end of the focus line's material (its box, then its
   * changes) at the bottom of the rail: the newest thing about the line is in view.
   */
  private railEndTop(): number {
    const body = this.rightBody;
    const last = !this.changesHost.hidden && this.changesHost.childElementCount ? this.changesHost : this.boxHost;
    if (!last.isConnected || !last.childElementCount) return body.scrollHeight;
    const bottom = last.getBoundingClientRect().bottom - body.getBoundingClientRect().top + body.scrollTop;
    const pad = parseFloat(getComputedStyle(body).paddingBottom) || 0;
    return bottom + pad - body.clientHeight;
  }

  /** Enter while reading, or the mode chip: the caret goes to the end of the focus line and the person writes. */
  writeAtFocus(): boolean {
    const walk = this.walk;
    const view = this.view();
    if (!walk || !view || !view.editable) return false;
    this.commitPreview('key');
    const line = this.lines[this.targetLine()];
    if (!line) return false;
    const end = Math.max(1, Math.min(view.state.doc.content.size - 1, line.pos + line.nodeSize - 1));
    try {
      view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(end), -1)));
    } catch { /* keep the selection */ }
    view.focus();
    startWriting();
    // Accord round 2 stage A: the caret is in a line on purpose, so the edit session opens here
    // too, not only on a press (the guard opens it after a press or a focusin).
    syncEditSession();
    this.clearHover();
    this.queueRender();
    this.renderMode();
    return true;
  }

  /**
   * Accord round 2 stage A: the margin's pencil. Moves the cursor to the line and opens the edit
   * there. Option+click on the words is the same thing without an affordance; this is the
   * affordance. Returns false when the document is not editable.
   */
  editLine(lineIndex: number): boolean {
    if (!this.walk || lineIndex < 0 || lineIndex >= this.walk.lineCount) return false;
    if (lineIndex !== this.cursorLine()) this.focusLine(lineIndex);
    return this.writeAtFocus();
  }

  /** Step B4d: the cursor (shift-click ranges in the margin start here; the chat's 📍 points here). */
  focusIndex(): number { return this.cursorLine(); }

  /** Step B4c: Next issue hit the sitting budget: show the rail's "This sitting" status. */
  budgetReached(): void {
    const el = this.host.lineMarks().budgetEl;
    if (SETTINGS_POLICY.budgetReachedOpensSettings && this.settings.el.contains(el)) {
      this.settings.open(false);
    } else if (isPhone()) this.openSheet('right');
    else if (document.body.classList.contains('prw-right-collapsed')) this.setCollapsed('right', false);
    el.scrollIntoView({ block: 'nearest' });
    (el.querySelector('.plm-budget-stop') as HTMLButtonElement | null)?.focus({ preventScroll: true });
  }

  /** Accord layout stage 2: View › Reading settings. */
  openReadingSettings(): void {
    if (isPhone()) this.closeSheets();
    this.settings.open();
  }

  /** Accord layout stage 2: View › Navigator / Margin show or hide a rail (phones: open its sheet). */
  toggleRailFromMenu(side: 'left' | 'right'): void {
    if (isPhone()) { this.openSheet(side); return; }
    this.setCollapsed(side, !document.body.classList.contains(`prw-${side}-collapsed`));
  }

  railShown(side: 'left' | 'right'): boolean {
    return !document.body.classList.contains(`prw-${side}-collapsed`);
  }

  /** Accord layout stage 2: File › Open lists the same documents as the left rail. */
  documentsList(): { docs: Array<{ slug: string; title: string; current: boolean; count: number }> | null; message: string } {
    const slug = this.host.slug();
    const issues = this.host.lineMarks().needsYouLines().length;
    if (!this.docs) return { docs: null, message: this.docsMessage };
    return {
      docs: this.docs.map(doc => ({
        slug: doc.slug,
        title: doc.title || 'Untitled document',
        current: doc.slug === slug,
        count: doc.slug === slug ? issues : (doc.pendingSuggestions ?? 0) + (doc.openComments ?? 0),
      })),
      message: this.docsMessage,
    };
  }

  /** Re-reads the documents list (File › Open does before it shows it). */
  reloadDocuments(): Promise<void> { return this.loadDocuments(); }

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

  /** A `#heading` link in the text was clicked: its heading becomes the focus line (a jump). */
  private onInPageLink = (event: CustomEvent<{ pos: number; handled: boolean }>): void => {
    const pos = event.detail?.pos ?? -1;
    if (!this.walk || pos < 0) return;
    const line = this.host.lineMarks().lineAtPos(pos);
    if (line < 0) return;
    this.host.lineMarks().revealLine?.(line);
    if (this.focusLine(line)) event.detail.handled = true;
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
  // Hover focus (desktop) and touch focus (phones, tablets)
  // --------------------------------------------------------------------------

  private hoverCapable(): boolean {
    if (!HOVER_FOCUS_POLICY.enabled || !CURSOR_POLICY.hoverPreviews) return false;
    try { return window.matchMedia(HOVER_FOCUS_POLICY.query).matches; } catch { return false; }
  }

  private touchMode(): boolean {
    if (!TOUCH_FOCUS_POLICY.enabled) return false;
    try { return window.matchMedia(TOUCH_FOCUS_POLICY.query).matches; } catch { return false; }
  }

  /**
   * One cursor (Accord layout stage 3, decision 4): the reading focus and the focus line are one
   * line. Scrolling moves it, a click sets it (the caret's line, a dot, a list item), J / K move it.
   * The blue bar, the status bar and the reading position name it.
   */
  cursorLine(): number { return this.walk?.focus ?? 0; }

  /**
   * The line the Margin shows: the cursor, or the line the mouse rests on (a hover preview,
   * CURSOR_POLICY). A key or a click in the Margin commits a preview before it acts, so what the
   * Margin shows is what A and R hit. While writing, the caret's line (the cursor) owns it.
   */
  targetLine(): number {
    const walk = this.walk;
    if (!walk) return 0;
    const hover = this.hoverLine;
    // While writing, the caret's line owns the focus: the keys type there.
    if (hover === null || isWriting() || isEditing() || hover >= walk.lineCount || walk.isHidden(hover)) return walk.focus;
    return hover;
  }

  private clearHover(): void {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    this.hoverCandidate = null;
    if (this.hoverLine === null) return;
    this.hoverLine = null;
    this.queueRender();
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.walk || event.pointerType !== 'mouse' || !this.hoverCapable()) return;
    // A scroll, or the page changing under a still mouse, makes the browser send a pointer event
    // at (about) the same place: not a hover. Only a real move counts.
    const last = this.lastPointer;
    if (last && Math.abs(last.x - event.clientX) < HOVER_FOCUS_POLICY.minMovePx && Math.abs(last.y - event.clientY) < HOVER_FOCUS_POLICY.minMovePx) return;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    // Read what is under the pointer now: a click can scroll the page before a later frame.
    this.hoverAt(event.clientX, event.clientY);
  };

  /** A press is an explicit act: a hover still waiting for its delay is dropped. */
  private onPointerDownHover = (): void => {
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    this.hoverCandidate = null;
  };

  /** The line under a viewport point: the text, its margin dot, or a folded closed line; else null. */
  private lineAtPoint(x: number, y: number): number | null {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!hit) return null;
    const dot = hit.closest?.('.plm-dot[data-line]') as HTMLElement | null;
    if (dot) return Number(dot.dataset.line);
    const folded = hit.closest?.('.ProseMirror .pclose-folded[data-pclose-line]') as HTMLElement | null;
    if (folded) return Number(folded.dataset.pcloseLine);
    const view = this.view();
    if (!view || !view.dom.contains(hit)) return null;
    const pos = view.posAtCoords({ left: x, top: y });
    if (!pos) return null;
    const line = this.host.lineMarks().lineAtPos(pos.inside >= 0 ? pos.inside + 1 : pos.pos);
    return line >= 0 ? line : null;
  }

  private hoverAt(x: number, y: number): void {
    const walk = this.walk;
    if (!walk) return;
    if (isEditing()) { this.clearHover(); return; }
    // Typing a reason or a reply in the rail: the focus stays on that line.
    const active = document.activeElement as HTMLElement | null;
    if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) && this.right.contains(active)) return;
    const line = this.lineAtPoint(x, y);
    this.hoverLog.push({ x: Math.round(x), y: Math.round(y), line }); if (this.hoverLog.length > 8) this.hoverLog.shift();
    // Off the text: the preview stays (the mouse can travel to the Margin), except over the chrome
    // or the Navigator, where it ends (CURSOR_POLICY.endPreviewOver).
    if (line === null || !Number.isFinite(line)) {
      if (this.hoverTimer) clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
      this.hoverCandidate = null;
      const over = document.elementFromPoint(x, y) as HTMLElement | null;
      if (this.hoverLine !== null && over?.closest?.(CURSOR_POLICY.endPreviewOver.join(', '))) this.clearHover();
      return;
    }
    if (line === this.hoverCandidate) return;
    this.hoverCandidate = line;
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    if (line === this.targetLine()) return;
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null;
      if (!this.walk || isEditing() || this.hoverCandidate !== line) return;
      // Writing mode: resting on another line after typing paused returns to reading, so the keys
      // act on the line the rail now shows (src/shared/reading-keys.ts).
      if (isWriting()) {
        if (!READING_MODE_POLICY.hoverEndsWriting) return;
        // A door like any other: it posts what was typed, it does not drop it.
        endWriting('hover');
      }
      this.setHoverFocus(line);
    }, HOVER_FOCUS_POLICY.delayMs);
  }

  /**
   * A hover preview: the Margin shows `line` without moving the cursor, reading, or scrolling.
   * A key or a click in the Margin commits it (commitPreview).
   */
  setHoverFocus(line: number): void {
    const walk = this.walk;
    if (!walk || line < 0 || line >= walk.lineCount || walk.isHidden(line)) return;
    this.hoverLine = line === walk.focus ? null : line;
    this.hoverWrites += 1;
    this.renderNow();
  }

  /** Test hook: hover focus changes, and the last points hover looked at. */
  private hoverWrites = 0;
  private readonly hoverLog: Array<{ x: number; y: number; line: number | null }> = [];

  private onFocusChange = (): void => { this.renderMode(); this.queueRender(); };

  /**
   * The mode chip: what the next letter key will do, and — the point of Accord round 2 stage A —
   * whether an edit is open and which line it is on. Mike, 2026-09-22: "there should be some
   * better indication that we are in editing mode. Not clear how to get out of editing mode."
   */
  private renderMode(): void {
    const writing = isWriting();
    const session = editSession();
    const phone = this.touchMode();
    const mode = !writing ? 'reading' : session ? 'editing' : 'writing';
    const line = session ? session.lineIndex : -1;
    const sig = `${mode}|${line}|${phone}`;
    if (this.modeEl.dataset.sig === sig) return;
    this.modeEl.dataset.sig = sig;
    this.modeEl.dataset.mode = mode;
    if (session) this.modeEl.dataset.line = String(line); else delete this.modeEl.dataset.line;
    const help = editingHelpText(phone);
    this.modeEl.textContent = session ? editingStatusText(session.lineIndex) : writing ? 'Writing' : 'Reading';
    this.modeEl.title = session ? help
      : writing
        ? 'Writing: the caret is in the text and keys type. Esc, or a click outside the text, returns to reading.'
        : 'Reading: keys are commands (A agree, R reject, J/K next/previous). Click the text, or press Enter, to write.';
    this.modeEl.setAttribute('aria-label', session
      ? `${editingStatusText(session.lineIndex)}. ${help}`
      : writing ? 'Writing: keys type into the text. Esc returns to reading.' : 'Reading: keys are commands. Click the text or press Enter to write.');
    // The line's edge, the toolbar's indicator and the phone's Done control read this one flag.
    document.body.classList.toggle('prw-editing', Boolean(session));
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.share-pill-suggest-toggle'))) {
      if (session) el.dataset.editingLine = String(session.lineIndex + 1); else delete el.dataset.editingLine;
    }
    this.renderToolbarEditingState(session ? session.lineIndex : null);
    const showDone = Boolean(session) && phone && EDIT_SESSION_POLICY.phoneDoneControl;
    this.doneBtn.hidden = !showDone;
    // The phone's Margin sheet sits over the status bar, so an open sheet would hide the one door
    // a phone has. Editing closes it — the same reason the touch strip stands down while editing
    // (TOUCH_FOCUS_POLICY.hideWhileEditing): you cannot mark a line and rewrite it at once.
    if (showDone && this.right.classList.contains('prw-sheet-open')) this.closeSheets();
    this.renderFocus();
  }

  /**
   * The toolbar's mode indicator, beside the Suggesting | Editing switch. It says "Editing line N"
   * — the same words as the status bar — so the transient state is never confused with the switch's
   * standing Editing setting.
   */
  private renderToolbarEditingState(line: number | null): void {
    const switchEl = document.querySelector<HTMLElement>('.share-pill-suggest-toggle');
    const group = switchEl?.parentElement;
    if (!group) return;
    let pill = group.querySelector<HTMLElement>('.share-pill-editing-state');
    if (line === null) { pill?.remove(); return; }
    if (!pill) {
      pill = el('span', 'share-pill-editing-state');
      pill.setAttribute('role', 'status');
      switchEl!.after(pill);
    }
    pill.textContent = editingStatusText(line);
    pill.title = editingHelpText(this.touchMode());
  }

  /** Accord round 2 stage A: a proposal posted on this line. The bar says so, briefly. */
  showEditProposed(lineIndex: number): void {
    this.showEditNotice(postedNoticeText(lineIndex, this.touchMode()));
  }

  /** Accord round 2 stage A: a line in the status bar after a leave. No modal, no focus steal. */
  showEditNotice(text: string): void {
    this.sbNotice.textContent = text;
    this.sbNotice.hidden = false;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.sbNotice.hidden = true;
      this.sbNotice.textContent = '';
      this.noticeTimer = null;
    }, EDIT_SESSION_POLICY.noticeMs);
  }

  /** The touch strip: the focus line's own mark and Agree / Reject / More…. */
  private renderStrip(): void {
    const touch = this.touchMode();
    const lm = this.host.lineMarks();
    const active = document.activeElement as HTMLElement | null;
    const editingText = Boolean(active?.isContentEditable && active.closest?.('.ProseMirror'));
    const show = touch && lm.isLoaded() && !(TOUCH_FOCUS_POLICY.hideWhileEditing && editingText);
    document.body.classList.toggle('prw-touch', touch);
    document.body.classList.toggle('prw-strip-on', show);
    document.body.style.setProperty('--prw-strip-h', `${TOUCH_FOCUS_POLICY.stripHeightPx}px`);
    this.strip.hidden = !show;
    if (!show) return;
    // Accord layout stage 3 (decision 11): the strip is the position (Line N of M, "Marked up to line
    // K ↑"), Agree, Reject and ⋯ More; the status bar folds into it (PHONE_STRIP_POLICY).
    const index = this.cursorLine();
    const line = this.lines[index];
    const status = lm.myStatus(index);
    const marked = lm.markedUpTo();
    const sheetOpen = this.right.classList.contains('prw-sheet-open');
    const sig = `${index}|${this.lines.length}|${line?.hash ?? ''}|${status}|${Boolean(lm.askForLine(index))}|${marked?.line ?? ''}|${sheetOpen}`;
    if (sig === this.stripSig) return;
    this.stripSig = sig;
    this.strip.dataset.line = String(index);
    this.strip.dataset.status = status;
    this.strip.setAttribute('role', 'region');
    this.strip.setAttribute('aria-label', `Current line ${index + 1}`);
    const grab = el('button', 'prw-strip-grab');
    grab.type = 'button';
    grab.setAttribute('aria-label', sheetOpen ? 'Close the Margin' : 'Open the Margin (this line and the room)');
    grab.setAttribute('aria-expanded', String(sheetOpen));
    grab.onclick = () => { if (this.right.classList.contains('prw-sheet-open')) this.closeSheets(); else this.openSheet('right'); };
    const info = el('div', 'prw-strip-info');
    const where = el('button', 'prw-strip-where');
    where.type = 'button';
    where.append(el('b', undefined, `Line ${index + 1}`), ` of ${this.lines.length}`);
    where.setAttribute('aria-label', `Line ${index + 1} of ${this.lines.length}: ${sheetOpen ? 'close' : 'open'} the Margin`);
    where.onclick = grab.onclick;
    info.append(where);
    if (marked) {
      const back = el('button', 'prw-strip-marked', `Marked up to line ${marked.line + 1} ↑`);
      back.type = 'button';
      back.setAttribute('aria-label', `Go to line ${marked.line + 1}, the last line you marked`);
      back.onclick = () => this.gotoMarkedUpTo();
      info.append(back);
    } else {
      const state = el('span', 'prw-strip-status', STATUS_WORDS[status] ?? status);
      state.dataset.status = status;
      info.append(state);
    }
    const buttons = el('div', 'prw-strip-actions');
    const agree = el('button', 'prw-strip-agree', status === 'agreed' ? 'Agreed ✓' : 'Agree');
    agree.type = 'button';
    agree.onclick = () => { this.renderNow(); this.box?.choose('agreed', 'click'); };
    const reject = el('button', 'prw-strip-reject', 'Reject');
    reject.type = 'button';
    reject.onclick = () => this.openReason();
    const more = el('button', 'prw-strip-more', '⋯');
    more.type = 'button';
    more.setAttribute('aria-label', `More marks for line ${index + 1}`);
    // ⋯ More opens the Margin sheet on the Line tab with the line's More marks shown.
    more.onclick = () => {
      if (this.right.classList.contains('prw-sheet-open') && this.marginTab === 'line') { this.box?.toggleMore?.(); return; }
      this.selectMarginTab('line');
      this.openSheet('right', { more: true });
    };
    buttons.append(agree, reject, more);
    this.strip.replaceChildren(grab, info, buttons);
  }

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
    this.cameraTo(walk.focus);
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
    this.cameraTo(walk.focus);
    this.afterChange();
  }

  /** Moves the focus to a line without reading the lines on the way (Next issue, a dot). */
  focusLine(index: number): boolean {
    const walk = this.walk;
    if (!walk || this.tops[index] === undefined) return false;
    if (walk.isHidden(index)) index = this.host.visibleLineFor?.(index) ?? index;
    this.measure();
    walk.moveTo(index, performance.now(), 'jump', this.heights);
    this.cameraTo(index);
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
    if (ids.length === 0) { this.renderNow(); return; }
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
      // Scroll-accepts are passive: committing them never folds their lines (closed-fold policy).
      lm.withoutClosures(() => this.host.decide(ids, 'accept'));
      this.lastError = '';
      this.commits.push({ ids: ids.slice(), ok: true });
    } catch (error) {
      // A batch accept is all or nothing. A change that was edited after it was proposed can never
      // be accepted as it stands: putting it back as "accepted by scrolling" left the same notice
      // and the same button, so the next click did nothing (Mike, 2026-09-21). Drop those from the
      // scroll-accepts (they stay open for an explicit decision), save the rest, and say so.
      const failed = (error as { failedIds?: string[] })?.failedIds ?? [];
      const rest = ids.filter(id => !failed.includes(id));
      this.commits.push({ ids: ids.slice(), ok: false, error: error instanceof Error ? error.message : String(error) });
      if (failed.length && rest.length) {
        try {
          lm.withoutClosures(() => this.host.decide(rest, 'accept'));
          this.commits.push({ ids: rest.slice(), ok: true });
        } catch (retry) {
          walk.restoreProvisional(rest);
          this.lastError = retry instanceof Error ? retry.message : 'Could not save the accepts.';
          this.afterChange();
          return;
        }
      } else if (!failed.length) {
        walk.restoreProvisional(ids);
        this.lastError = error instanceof Error ? error.message : 'Could not save the accepts.';
        this.afterChange();
        return;
      }
      const lines = failed.map(id => this.lineOfMark(id)).filter(n => n >= 0).map(n => n + 1);
      const where = lines.length ? ` (line ${[...new Set(lines)].join(', ')})` : '';
      this.lastError = `${failed.length === 1 ? '1 change was' : `${failed.length} changes were`} edited after being proposed, so ${failed.length === 1 ? 'it' : 'they'} could not be accepted as ${failed.length === 1 ? 'it stands' : 'they stand'}${where}. ${failed.length === 1 ? 'It is' : 'They are'} still open: accept or reject ${failed.length === 1 ? 'it' : 'them'} there.`;
    }
    this.afterChange();
  }

  /** Test hook: every commit of scroll-accepts (the ids, and whether the accept bridge took them). */
  private readonly commits: Array<{ ids: string[]; ok: boolean; error?: string }> = [];

  private lineOfMark(id: string): number {
    const mark = this.pendingMarks().find(m => m.id === id);
    return mark?.range ? this.host.lineMarks().lineAtPos(mark.range.from) : -1;
  }

  private decide(mark: Mark, action: ReviewAction, text?: string): void {
    const walk = this.walk;
    if (!walk) return;
    const line = this.host.lineMarks().lineAtPos(mark.range?.from ?? -1);
    // Explicit on this line: first commit the provisional accepts at or above it.
    const ids = walk.explicitAction(line).filter(id => id !== mark.id);
    try {
      if (ids.length) this.host.lineMarks().withoutClosures(() => this.host.decide(ids, 'accept'));
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
    if (walk.focus !== this.lastWalkFocus) {
      if (this.lastWalkFocus !== -1 && HOVER_FOCUS_POLICY.walkMoveClearsHover) this.clearHover();
      this.lastWalkFocus = walk.focus;
    }
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
    if (this.walk.focus > 0) this.cameraTo(this.walk.focus);
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
    const railSig = `${this.boxSig}\n${this.changesSig}`;
    this.renderBox();
    this.renderChanges();
    this.threads?.render();
    // The focus line changed, or its box or changes did: keep them in view at the rail's bottom.
    if (`${this.boxSig}\n${this.changesSig}` !== railSig && !this.typingInRail()) this.railFollow?.follow();
    this.renderRate();
    this.renderStrip();
    this.renderStatusBar();
    this.renderRule();
    this.renderMarginTabs();
    this.renderTail();
    this.renderPreviewDot();
    this.navigator.render();
    this.host.focusChanged?.(this.cursorLine());
  }

  /**
   * The PlayMaker Marks panel (every open mark, Accept all / Reject all) is a whole-document list,
   * so it docks under the Navigator's Issues list (Accord layout stage 3; View › Marks panel).
   */
  private dockPanel(): void {
    const review = this.host.playmaker();
    if (!review) return;
    if (this.dockHost.parentElement !== this.navigator.panes.issues) this.navigator.panes.issues.append(this.dockHost);
    review.dock(isPhone() ? null : this.dockHost);
  }

  /** View › Marks panel: shows the Navigator on its Issues tab, where the panel lives. */
  showMarksPanel(): void {
    if (isPhone()) return;
    this.navigator.select('issues');
    if (document.body.classList.contains('prw-left-collapsed')) this.setCollapsed('left', false);
  }

  private renderFocus(): void {
    const walk = this.walk!;
    const view = this.view();
    // One cursor: the blue bar is the cursor's; a hover preview never moves it (the text never changes on hover).
    const focus = this.cursorLine();
    const line = this.lines[focus];
    const container = this.focusEl.parentElement;
    if (!view || !line || !container) { this.focusEl.hidden = true; return; }
    const dom = view.nodeDOM(line.pos) as HTMLElement | null;
    if (!dom || typeof dom.getBoundingClientRect !== 'function') { this.focusEl.hidden = true; return; }
    const c = container.getBoundingClientRect();
    const r = dom.getBoundingClientRect();
    const text = view.dom.getBoundingClientRect();
    this.focusEl.hidden = false;
    this.focusEl.dataset.line = String(focus);
    this.focusEl.dataset.source = isEditing() ? 'caret' : 'reading';
    // Accord round 2 stage A: the "you are here" look intensified (same hue, no third colour) on
    // the line an edit is open on, so the edit has a visible edge.
    const session = editSession();
    if (session && session.lineIndex === focus) this.focusEl.dataset.editing = 'true'; else delete this.focusEl.dataset.editing;
    void walk;
    this.focusEl.style.top = `${Math.round(r.top - c.top - 3)}px`;
    this.focusEl.style.height = `${Math.round(r.height + 6)}px`;
    this.focusEl.style.left = `${Math.round(text.left - c.left - 10)}px`;
    this.focusEl.style.width = `${Math.round(text.width + 20)}px`;
  }

  private renderDynamicStyle(): void {
    const walk = this.walk!;
    const rules: string[] = [];
    // Accord layout stage 1: scroll-accepted changes render as ordinary insert / delete (the status
    // bar and the rail list them with Save); HIGHLIGHT_POLICY.provisionalDashed brings the old look back.
    for (const id of HIGHLIGHT_POLICY.provisionalDashed ? walk.provisionalIds() : []) {
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
    const sig = JSON.stringify([me.actor, me.trust, me.name, me.email ?? '', me.signInUrl ?? '', me.markNeedsSignIn === true, me.attestedBy?.actor ?? '']);
    if (this.meEl.dataset.sig === sig) return;
    this.meEl.dataset.sig = sig;
    this.meEl.dataset.trust = me.trust;
    this.meEl.replaceChildren();
    // Cross invitation (2026-09-19): an AI vouched for this signed-in person. They read and
    // comment; nothing they mark counts until a person invites them, so the rail names the AI
    // instead of calling them verified or asking them to sign in again.
    if (me.attestedBy) {
      this.meEl.dataset.attestedBy = me.attestedBy.actor;
      this.meEl.append(
        el('span', 'prw-me-name', me.name || 'You'),
        el('span', 'prw-me-guest', `vouched for by ${me.attestedBy.name}`),
      );
      this.meEl.title = `${me.attestedBy.name} states this is you: “${me.attestedBy.basis}”. You can read and comment. Marks, answers, picks and approvals need a person to invite you.`;
      return;
    }
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
    // Invite person (2026-09-19): under the default guest setting a guest reads, comments and
    // chats; marks, answers, picks and approvals need signing in.
    this.meEl.title = me.markNeedsSignIn
      ? 'You are not signed in: you can read, comment and chat. Sign in to mark lines and answer.'
      : 'You are not signed in: your marks show your typed name as a guest, and do not answer asks addressed to a signed-in person.';
    if (me.signInUrl) {
      const link = el('a', 'prw-me-signin', me.markNeedsSignIn ? 'Sign in to mark' : 'Sign in');
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
    const n = walk.provisionalCount;
    this.provisionalEl.hidden = n === 0 && !this.lastError;
    const sig = `${n}|${this.lastError}`;
    if (this.provisionalEl.dataset.sig === sig) return;
    this.provisionalEl.dataset.sig = sig;
    this.provisionalEl.replaceChildren();
    if (n > 0) {
      const one = n === 1;
      const text = el('p', 'prw-provisional-text',
        `You scrolled past ${n} ${one ? 'change' : 'changes'}, so ${one ? 'it counts' : 'they count'} as accepted by scrolling. ${one ? 'It is' : 'They are'} not saved yet: scroll back up to take ${one ? 'it' : 'them'} back, or save now.`);
      const commit = el('button', 'prw-commit', `Save ${n} accepted ${one ? 'change' : 'changes'}`);
      commit.type = 'button';
      // The press must not move the keyboard (or the rail) before the release: the click is the act.
      commit.addEventListener('mousedown', event => event.preventDefault());
      commit.onclick = () => this.commit(this.walk?.commitAll() ?? []);
      this.provisionalEl.append(text, commit);
    }
    this.provisionalEl.dataset.state = n > 0 ? 'pending' : 'error';
    if (this.lastError) {
      const err = el('p', 'prw-error', this.lastError);
      err.setAttribute('role', 'alert');
      const dismiss = el('button', 'prw-link prw-error-dismiss', 'OK');
      dismiss.type = 'button';
      dismiss.setAttribute('aria-label', 'Dismiss this message');
      dismiss.onclick = () => { this.lastError = ''; this.renderNow(); };
      err.append(' ', dismiss);
      this.provisionalEl.append(err);
    }
  }

  private renderBox(): void {
    const lm = this.host.lineMarks();
    const focus = this.targetLine();
    const line = this.lines[focus];
    if (!line) { this.boxHost.replaceChildren(); this.box = null; this.boxSig = ''; return; }
    const state = lm.lineState(focus);
    const summary = lm.issueSummary();
    const marks = state ? [...state.marks.values()].map(e => `${e.mark.id}:${e.mark.status}:${e.current}:${e.mark.reason ?? ''}`).join(',') : '';
    const sig = `${focus}|${line.hash}|${line.occurrence}|${marks}|${summary?.team.join(',') ?? ''}|${lm.isLoaded()}|${lm.askSignature(focus)}|${lm.aidsSignature(focus)}`;
    if (sig === this.boxSig && this.box) return;
    // Keep the box while the reader types a reason for this same line.
    const active = document.activeElement;
    if (this.box && this.boxHost.contains(active) && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) return;
    this.boxSig = sig;
    // Accord layout stage 3 (decision 8): the Margin's layout — the quote, Agree and Reject, ⋯ More.
    const box = lm.buildMarkBox(line, {
      onExplicit: () => this.explicit(focus),
      layout: 'margin',
    });
    const hasAsk = Boolean(lm.askForLine(focus));
    const alts = lm.altSetFor(focus);
    const keys = el('p', 'prw-keys', hasAsk ? 'Y yes · N no · T not yet' : alts ? `1–${alts.options.length} pick · A agree · E explain` : 'A agree · R reject · T thread · E explain · D tier · J/K move');
    // Editing first (2026-09-19): who changed this line, and whether the meaning changed.
    const note = lm.editNoteFor(focus);
    if (note) {
      const edited = el('p', 'prw-edit-note', note.text);
      edited.dataset.kind = note.kind;
      this.boxHost.replaceChildren(edited, box.root, keys);
    } else {
      this.boxHost.replaceChildren(box.root, keys);
    }
    this.box = box;
  }

  private renderChanges(): void {
    const walk = this.walk!;
    const focus = this.targetLine();
    // Hover focus: another line's changes show without the walk's stepping (that is the reading line's).
    const onFocus = focus === walk.focus;
    const all = new Map(this.pendingMarks().map(mark => [mark.id, mark]));
    // Accord round 2 stage C (a loose end from stage D): "Changes on this line" carries only
    // PROPOSALS. A comment is a thread and it shows once, in Discussion; before this it showed
    // twice on any line that had one, which made the same unsettled thing look like two.
    // The walk itself still steps every review mark (scroll-accept is unchanged): this is what the
    // Margin draws, not what the reader passes.
    const onLine = walk.marksOn(focus).filter(item => (all.get(item.id)?.kind ?? 'comment') !== 'comment');
    const current = onFocus ? walk.currentMark() : null;
    const lm = this.host.lineMarks();
    const sig = JSON.stringify([focus, onFocus, onLine.map(m => [m.id, walk.isPassed(m.id), walk.isProvisional(m.id)]), current?.id,
      onLine.map(m => { const mk = all.get(m.id); return mk ? [mk.at, mk.data] : null; }),
      onLine.map(m => lm.notesForMark(m.id).map(n => n.why)),
      onLine.map(m => { const b = lm.bundleForMark(m.id); return b ? [b.bundle.id, b.pending.length, b.stale.join(','), b.status] : null; }),
      this.bundleDecisions.length, this.lastError]);
    if (sig === this.changesSig) return;
    this.changesSig = sig;
    this.changesHost.replaceChildren();
    this.changesHost.hidden = onLine.length === 0;
    if (onLine.length === 0) return;
    // The step counter counts the proposals shown, not every review mark the walk steps.
    const passedHere = onLine.filter(item => walk.isPassed(item.id)).length;
    const index = onFocus ? Math.min(passedHere, onLine.length) : -1;
    const head = el('div', 'prw-changes-head');
    head.append(el('strong', undefined, `Changes on this line`),
      el('span', 'prw-step', !onFocus ? `${onLine.length}` : index < onLine.length ? `${index + 1} of ${onLine.length}` : `all ${onLine.length} passed`));
    this.changesHost.append(head);
    // Step B4e: a bundle on this line shows as one card (title, why, every passage, one decision).
    const shownBundles = new Set<string>();
    for (const item of onLine) {
      const bundle = lm.bundleForMark(item.id);
      if (!bundle || shownBundles.has(bundle.bundle.id)) continue;
      shownBundles.add(bundle.bundle.id);
      this.changesHost.append(this.bundleCard(bundle, all));
    }
    if (onFocus) {
      const nav = el('div', 'prw-step-nav');
      const back = el('button', undefined, '‹ Back'); back.type = 'button'; back.disabled = !walk.canStepBack();
      back.onclick = () => this.previous();
      const fwd = el('button', undefined, index < onLine.length ? 'Next ›' : 'Next line ›'); fwd.type = 'button';
      fwd.onclick = () => this.next();
      nav.append(back, fwd);
      this.changesHost.append(nav);
    }
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
    if (onFocus) {
      const hint = el('p', 'prw-hint', 'Scroll down to step through the changes; scrolling past a change accepts it until you scroll back up.');
      this.changesHost.append(hint);
    }
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
      if (earlier.length) lm.withoutClosures(() => this.host.decide(earlier, 'accept'));
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
      const note = el('p', 'prw-card-note', 'Accepted by scrolling, not saved yet');
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
    // Accord layout stage 3 (decision 7): the Navigator (Outline · Issues · Since you) and its
    // collapse button. The documents list moved to File › Open (stage 2).
    const leftHead = el('div', 'prw-rail-head anv-head');
    const leftToggle = el('button', 'prw-collapse');
    leftToggle.type = 'button';
    leftToggle.onclick = () => this.toggleRail('left');
    leftHead.append(this.navigator.tabsEl, leftToggle);
    this.left.append(leftHead, ...Object.values(this.navigator.panes));

    // Accord layout stage 3 (decision 6): the Margin, Line N and Room, no third tab.
    const rightHead = el('div', 'prw-rail-head amg-head');
    const rightToggle = el('button', 'prw-collapse');
    rightToggle.type = 'button';
    rightToggle.onclick = () => this.toggleRail('right');
    this.marginTabs.setAttribute('role', 'tablist');
    this.marginTabs.setAttribute('aria-label', 'Margin');
    const specs: Array<[MarginTab, HTMLButtonElement, HTMLElement]> = [['line', this.lineTabBtn, this.linePane], ['room', this.roomTabBtn, this.roomPane]];
    for (const [tab, btn, pane] of specs) {
      btn.type = 'button';
      btn.id = `amg-tab-${tab}`;
      btn.dataset.tab = tab;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-controls', `amg-pane-${tab}`);
      btn.onclick = () => this.selectMarginTab(tab);
      btn.onkeydown = (event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        const to: MarginTab = tab === 'line' ? 'room' : 'line';
        this.selectMarginTab(to);
        (to === 'line' ? this.lineTabBtn : this.roomTabBtn).focus();
      };
      pane.id = `amg-pane-${tab}`;
      pane.dataset.tab = tab;
      pane.setAttribute('role', 'tabpanel');
      pane.setAttribute('aria-labelledby', btn.id);
      this.marginTabs.append(btn);
    }
    this.lineTabBtn.textContent = 'Line 1';
    this.roomTabBtn.append(el('span', 'amg-tab-label', 'Room'), this.roomBadge);
    this.roomBadge.setAttribute('aria-hidden', 'true');
    this.roomBadge.hidden = true;
    // Accord layout stage 1: "Line N of M" and Reading / Writing moved to the status bar.
    this.buildStatusBar();
    rightHead.append(this.marginTabs, rightToggle);
    this.rightHeadEl = rightHead;
    this.meEl.setAttribute('aria-live', 'polite');
    this.meRow.append(this.meEl, this.proxy.familiarEl);
    this.provisionalEl.hidden = true;
    this.provisionalEl.setAttribute('aria-live', 'polite');
    this.sinceHost.hidden = true;
    this.sinceHost.setAttribute('aria-label', 'Since you last marked');
    this.buildRate();
    this.buildReply();
    // The Line tab: the line's quote and marks, its changes, the Familiar's note and everyone's
    // marks, a reply box, then who the viewer's marks name.
    this.threads = this.buildThreads();
    this.rightBody.append(this.lineTools, this.boxHost, this.changesHost, this.threads.element, this.tailHost, this.replyHost, this.meRow);
    // The scroll-accepts notice sits under the tabs, outside the scrolling body: it stays in view and
    // does not move when the pane scrolls or the line's box changes size (2026-09-21).
    this.linePane.append(this.provisionalEl, this.rightBody);
    // The Room tab: the document chat, full height (it pushes nothing off screen).
    this.roomPane.append(this.chatSlot);
    this.right.append(rightHead, this.linePane, this.roomPane);
    this.railFollow = new ScrollFollower({ scroller: this.rightBody, endTop: () => this.railEndTop(), name: 'rail' });
    this.rightBody.append(this.railFollow.pillElement);
    this.right.setAttribute('role', 'complementary');
    this.left.setAttribute('role', 'navigation');
    this.applyMarginTab();
    this.buildStripGestures();
  }

  /** "Reply on this line…": a reply to the line's newest open comment, else a new comment on the line. */
  private buildReply(): void {
    const form = this.replyHost;
    const input = el('input', 'amg-reply-input');
    input.type = 'text';
    input.maxLength = 2000;
    input.placeholder = 'Reply on this line…';
    input.setAttribute('aria-label', 'Reply on this line');
    const send = el('button', 'amg-reply-send', 'Send');
    send.type = 'submit';
    const note = el('p', 'amg-resolve-note', 'Resolve this thread when every item above is answered.');
    form.append(input, send, note);
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      input.value = '';
      input.blur();
    });
    form.onsubmit = (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      const line = this.targetLine();
      const lm = this.host.lineMarks();
      const comment = MARGIN_POLICY.replyToNewestComment
        ? [...this.pendingMarks()].reverse().find(mark => mark.kind === 'comment' && lm.lineAtPos(mark.range!.from) === line)
        : undefined;
      if (comment) {
        this.decide(comment, 'reply', text);
      } else {
        this.explicit(line);
        const id = lm.commentLine(line, text);
        if (!id) { this.lastError = 'Could not place your reply on this line.'; this.renderNow(); return; }
        this.replies.push({ line, id });
      }
      input.value = '';
      this.changesSig = '';
      this.renderNow();
    };
  }

  /** Test hook: replies that opened a new thread on a line. */
  private readonly replies: Array<{ line: number; id: string }> = [];

  /** The Margin's tab (the viewer's choice; it never switches itself). */
  selectMarginTab(tab: MarginTab, remember = true): void {
    if (tab === this.marginTab && this.right.dataset.tab === tab) return;
    this.marginTab = tab;
    if (remember) this.saveRailState({ rightTab: tab });
    this.applyMarginTab();
    this.renderNow();
  }

  marginTabShown(): MarginTab { return this.marginTab; }

  private applyMarginTab(): void {
    const line = this.marginTab === 'line';
    this.right.dataset.tab = this.marginTab;
    this.lineTabBtn.setAttribute('aria-selected', String(line));
    this.roomTabBtn.setAttribute('aria-selected', String(!line));
    this.lineTabBtn.tabIndex = line ? 0 : -1;
    this.roomTabBtn.tabIndex = line ? -1 : 0;
    this.linePane.hidden = !line;
    this.roomPane.hidden = line;
    // The chat marks @mentions read when it is on screen: tell it.
    this.roomShownListener?.();
  }

  private roomShownListener: (() => void) | null = null;
  /** The chat asks to hear when the Room tab may have come on screen (it marks @mentions read then). */
  onRoomShown(listener: () => void): void { this.roomShownListener = listener; }

  /** The Room tab is on screen (desktop: the Margin open on Room; phones: the Margin sheet on Room). */
  isRoomVisible(): boolean {
    if (this.marginTab !== 'room') return false;
    if (isPhone()) return this.right.classList.contains('prw-sheet-open');
    return !document.body.classList.contains('prw-right-collapsed');
  }

  /** Opens the Margin on its Room tab (an explicit act: a speech bubble, the ⋯ menu's Room). */
  openRoom(): void {
    if (MARGIN_POLICY.explicitChatOpensRoom) this.selectMarginTab('room');
    if (isPhone()) { if (!this.right.classList.contains('prw-sheet-open')) this.openSheet('right'); }
    else if (document.body.classList.contains('prw-right-collapsed')) this.setCollapsed('right', false);
    this.roomShownListener?.();
  }

  /** The Line tab's label names the line A and R hit ("Line 41"; "Line 44 · preview" while hovering). */
  private renderMarginTabs(): void {
    const walk = this.walk;
    if (!walk) return;
    const shown = this.targetLine();
    const preview = shown !== walk.focus;
    const sig = `${shown}|${preview}|${this.chatUnread}`;
    if (sig === this.lineTabSig) return;
    this.lineTabSig = sig;
    this.lineTabBtn.replaceChildren(el('span', 'amg-tab-label', `Line ${shown + 1}`));
    if (preview) this.lineTabBtn.append(el('span', 'amg-preview', 'preview'));
    this.lineTabBtn.dataset.line = String(shown);
    this.lineTabBtn.dataset.preview = String(preview);
    this.right.dataset.preview = String(preview);
    this.lineTabBtn.title = preview
      ? `Previewing line ${shown + 1} (the mouse is on it). A key or a click here moves the cursor to it; the cursor is on line ${walk.focus + 1}.`
      : `Line ${shown + 1}: the cursor's line. A and R act on it.`;
    this.roomBadge.textContent = this.chatUnread > 0 ? String(this.chatUnread) : '';
    this.roomBadge.hidden = this.chatUnread <= 0;
    this.roomTabBtn.setAttribute('aria-label', this.chatUnread > 0 ? `Room (${this.chatUnread} unread chat ${this.chatUnread === 1 ? 'mention' : 'mentions'})` : 'Room');
  }

  /** The small margin preview: a ring on the previewed line's dot (the text never changes on hover). */
  private renderPreviewDot(): void {
    const walk = this.walk;
    const preview = walk && this.hoverLine !== null && this.hoverLine !== walk.focus ? this.hoverLine : null;
    for (const dot of document.querySelectorAll<HTMLElement>('.plm-dot[data-preview="true"]')) {
      if (preview === null || Number(dot.dataset.line) !== preview) delete dot.dataset.preview;
    }
    if (preview === null || !CURSOR_POLICY.ringPreviewDot) return;
    const dot = document.querySelector<HTMLElement>(`.plm-dot[data-line="${preview}"]`);
    if (dot) dot.dataset.preview = 'true';
  }

  /** After the line's changes: the Familiar's note (folded) and everyone's marks on the line. */
  private renderTail(): void {
    const parts = this.box?.tail ?? [];
    const sig = `${this.boxSig}|${parts.length}`;
    if (sig !== this.tailSig) {
      this.tailSig = sig;
      this.tailHost.replaceChildren(...parts);
      this.tailHost.hidden = parts.length === 0;
    }
    this.replyHost.hidden = !this.host.lineMarks().canCommentHere();
  }

  // --------------------------------------------------------------------------
  // Accord layout stage 1: the status bar and the "You marked up to here" rule
  // --------------------------------------------------------------------------

  private buildStatusBar(): void {
    const bar = this.statusBar;
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Status');
    this.modeEl.setAttribute('role', 'status');
    this.modeEl.hidden = !READING_MODE_POLICY.showModeChip;
    if (STATUS_BAR_POLICY.modeIsSwitch) {
      // Ruled off (2026-09-21, proposal decision 9); kept as one switch should a later ruling want it.
      this.modeEl.tabIndex = 0;
      this.modeEl.addEventListener('mousedown', event => event.preventDefault());
      this.modeEl.onclick = () => { if (isWriting()) endWriting('click-outside'); else this.writeAtFocus(); this.renderMode(); };
    }
    this.sbLine.setAttribute('aria-live', 'polite');
    this.sbProvisional.hidden = true;
    const sep = () => { const s = el('span', 'pst-sep'); s.setAttribute('aria-hidden', 'true'); return s; };
    this.sbNotice.hidden = true;
    this.sbNotice.setAttribute('role', 'status');
    // The phone's door: there is no Cmd+Enter on a phone, so the way out is a control it can see.
    this.doneBtn.hidden = true;
    this.doneBtn.setAttribute('type', 'button');
    this.doneBtn.setAttribute('aria-label', `${EDIT_SESSION_POLICY.phoneDoneLabel}: post this change as a proposal`);
    this.doneBtn.addEventListener('mousedown', event => event.preventDefault());
    this.doneBtn.onclick = () => { endWriting('click-outside'); this.renderMode(); };
    bar.append(this.sbLine, sep(), this.sbMarked, sep(), this.sbIssues, this.sbProvisional, this.sbNotice, this.doneBtn, this.modeEl);
    this.ruleEl.setAttribute('aria-hidden', 'true');
    this.ruleEl.hidden = true;
  }

  private renderStatusBar(): void {
    const walk = this.walk;
    if (!walk) return;
    const lm = this.host.lineMarks();
    const target = this.cursorLine();
    const marked = lm.isLoaded() ? lm.markedUpTo() : null;
    const needs = lm.isLoaded() ? lm.needsYouLines().length : null;
    const provisional = STATUS_BAR_POLICY.listProvisional ? walk.provisionalCount : 0;
    const ago = marked ? formatAgo(marked.at, Date.now()) : '';
    const sig = JSON.stringify([target, walk.lineCount, marked?.line ?? null, ago, needs, provisional]);
    if (sig === this.statusSig) return;
    this.statusSig = sig;
    this.statusBar.dataset.line = String(target);
    const strong = el('b', undefined, `Line ${target + 1}`);
    this.sbLine.replaceChildren(strong, ` of ${walk.lineCount}`);
    this.sbLine.dataset.line = String(target);
    if (marked) {
      const link = el('button', 'pst-marked-link', `line ${marked.line + 1}`);
      link.type = 'button';
      link.title = `Go to line ${marked.line + 1}, the last line you marked`;
      // The press must not end writing or move the keyboard before the click is the act.
      link.addEventListener('mousedown', event => event.preventDefault());
      link.onclick = () => this.gotoMarkedUpTo();
      this.sbMarked.replaceChildren(el('span', 'pst-marked-label', 'You marked up to '), link, el('span', 'pst-ago', ` · ${ago}`));
      this.sbMarked.dataset.line = String(marked.line);
      delete this.sbMarked.dataset.empty;
    } else {
      this.sbMarked.dataset.empty = 'true';
      this.sbMarked.replaceChildren(el('span', 'pst-marked-label', lm.isLoaded() ? 'No marks from you yet' : '…'));
      delete this.sbMarked.dataset.line;
    }
    this.sbIssues.textContent = needs === null ? '…' : issuesLeftText(needs);
    this.sbIssues.dataset.count = needs === null ? '' : String(needs);
    this.sbIssues.title = 'Lines that need you: an ask to answer or a change to decide. Each has an amber dot in the margin.';
    this.sbProvisional.hidden = provisional === 0;
    this.sbProvisional.replaceChildren();
    if (provisional > 0) {
      const one = provisional === 1;
      const save = el('button', 'pst-save', 'Save');
      save.type = 'button';
      save.setAttribute('aria-label', `Save ${provisional} accepted ${one ? 'change' : 'changes'}`);
      save.addEventListener('mousedown', event => event.preventDefault());
      save.onclick = () => this.commit(this.walk?.commitAll() ?? []);
      this.sbProvisional.append(el('span', 'pst-sep'), el('span', undefined, `${provisional} accepted by scrolling, not saved `), save);
    }
  }

  /** "line K" in the status bar: the last line the viewer marked becomes the focus line (a jump). */
  gotoMarkedUpTo(): boolean {
    const marked = this.host.lineMarks().markedUpTo();
    if (!marked) return false;
    this.host.lineMarks().revealLine(marked.line);
    return this.focusLine(marked.line);
  }

  /** The Slack-style rule after the viewer's last explicit mark (an overlay: nothing moves). */
  private renderRule(): void {
    const view = this.view();
    const container = this.ruleEl.parentElement;
    const lm = this.host.lineMarks();
    const marked = lm.isLoaded() ? lm.markedUpTo() : null;
    const line = marked ? this.lines[marked.line] : null;
    const dom = line && view ? view.nodeDOM(line.pos) as HTMLElement | null : null;
    if (!marked || !container || !view || !dom || typeof dom.getBoundingClientRect !== 'function' || dom.getBoundingClientRect().height === 0) {
      this.ruleEl.hidden = true;
      return;
    }
    const c = container.getBoundingClientRect();
    const r = dom.getBoundingClientRect();
    // The next visible line's top: the rule sits in the gap between the two.
    let nextTop: number | null = null;
    for (let i = marked.line + 1; i < this.lines.length; i += 1) {
      const next = view.nodeDOM(this.lines[i].pos) as HTMLElement | null;
      const nr = next && typeof next.getBoundingClientRect === 'function' ? next.getBoundingClientRect() : null;
      if (nr && nr.height > 0) { nextTop = nr.top; break; }
    }
    const gapMid = nextTop !== null && nextTop > r.bottom ? (r.bottom + nextTop) / 2 : r.bottom + 8;
    const text = view.dom.getBoundingClientRect();
    this.ruleEl.hidden = false;
    this.ruleEl.dataset.line = String(marked.line);
    const label = `You marked up to here · ${formatAgo(marked.at, Date.now())}`;
    if (this.ruleEl.textContent !== label) {
      this.ruleEl.replaceChildren(el('span', 'pst-rule-label', label));
    }
    this.ruleEl.style.top = `${Math.round(gapMid - c.top)}px`;
    this.ruleEl.style.left = `${Math.round(text.left - c.left)}px`;
    this.ruleEl.style.width = `${Math.round(text.width)}px`;
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

  /** Remembered per browser: each rail open or closed, and the tab each shows (layout-panels.ts). */
  private railState(): RailState {
    try { return parseRailState(localStorage.getItem(RAIL_STATE_KEY)); } catch { return {}; }
  }

  private saveRailState(patch: RailState): void {
    const saved = { ...this.railState(), ...patch };
    try { localStorage.setItem(RAIL_STATE_KEY, JSON.stringify(saved)); } catch { /* optional */ }
  }

  private applyRailState(): void {
    const saved = this.railState();
    // Default: both open when the window has room; the Navigator starts closed on narrower
    // desktops so the text keeps a readable width (NAVIGATOR_POLICY.closedBelowPx).
    const wide = window.innerWidth >= NAVIGATOR_POLICY.closedBelowPx;
    const leftCollapsed = saved.left ?? !wide;
    const rightCollapsed = saved.right ?? false;
    document.body.classList.toggle('prw-left-collapsed', leftCollapsed);
    document.body.classList.toggle('prw-right-collapsed', rightCollapsed);
    this.updateToggleLabels();
  }

  private setCollapsed(side: 'left' | 'right', collapsed: boolean): void {
    this.saveRailState({ [side]: collapsed } as RailState);
    document.body.classList.toggle(`prw-${side}-collapsed`, collapsed);
    this.updateToggleLabels();
    if (side === 'right') this.roomShownListener?.();
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
      const name = side === 'left' ? 'Navigator' : 'Margin';
      if (phone) { btn.textContent = '×'; btn.setAttribute('aria-label', `Close the ${name}`); btn.removeAttribute('aria-expanded'); continue; }
      btn.textContent = side === 'left' ? (collapsed ? '»' : '«') : (collapsed ? '«' : '»');
      btn.setAttribute('aria-label', `${collapsed ? 'Show' : 'Hide'} the ${name}${side === 'right' && this.chatUnread > 0 ? ` (${this.chatUnread} unread chat ${this.chatUnread === 1 ? 'mention' : 'mentions'})` : ''}`);
      // Collapsed, the Margin's toggle carries the Room's unread badge (its tab is out of sight).
      if (side === 'right' && this.chatUnread > 0 && collapsed) {
        const badge = el('span', 'prw-badge', String(this.chatUnread));
        badge.setAttribute('aria-hidden', 'true');
        btn.append(badge);
      }
      btn.setAttribute('aria-expanded', String(!collapsed));
      rail.dataset.collapsed = String(collapsed);
    }
  }

  /** Step B7: the chat's unread @mention count: a badge on the Room tab (and on the collapsed Margin's toggle). */
  setChatUnread(count: number): void {
    if (count === this.chatUnread) return;
    this.chatUnread = count;
    this.updateToggleLabels();
    this.renderMarginTabs();
  }

  /** Step B7: desktop — the right rail is open (not collapsed). */
  isRightRailOpen(): boolean { return !document.body.classList.contains('prw-right-collapsed'); }

  /** Step B7: desktop — opens the right rail (the chat lives there). */
  openRightRail(): void { if (!isPhone()) this.setCollapsed('right', false); }

  /**
   * Phones: a rail opens as a bottom sheet. The Margin's sheet carries the bottom strip at its top
   * (proposal: "Swipe up on the strip opens a sheet with the same Line · Room tabs").
   */
  openSheet(side: 'left' | 'right', options: { more?: boolean } = {}): void {
    this.closeSheets();
    const rail = side === 'left' ? this.left : this.right;
    rail.classList.add('prw-sheet-open');
    if (side === 'right' && this.touchMode()) {
      this.right.prepend(this.strip);
      document.body.classList.add('prw-margin-sheet');
    }
    this.updateToggleLabels();
    this.renderNow();
    if (side === 'right') this.roomShownListener?.();
    if (options.more) this.box?.openMore?.();
    else (rail.querySelector('.prw-collapse') as HTMLButtonElement | null)?.focus({ preventScroll: true });
  }

  closeSheets(): void {
    this.left.classList.remove('prw-sheet-open');
    this.right.classList.remove('prw-sheet-open');
    document.body.classList.remove('prw-margin-sheet');
    if (this.strip.parentElement !== document.body && this.started) document.body.append(this.strip);
  }

  /** Phones: a swipe up on the strip opens the Margin sheet; a swipe down closes it (PHONE_STRIP_POLICY). */
  private buildStripGestures(): void {
    this.strip.addEventListener('touchstart', (event) => {
      if (event.touches.length !== 1) { this.stripTouch = null; return; }
      this.stripTouch = { y: event.touches[0].clientY, at: performance.now() };
    }, { passive: true });
    this.strip.addEventListener('touchend', (event) => {
      const start = this.stripTouch;
      this.stripTouch = null;
      const touch = event.changedTouches[0];
      if (!start || !touch) return;
      const dy = touch.clientY - start.y;
      if (dy <= -PHONE_STRIP_POLICY.swipePx && !this.right.classList.contains('prw-sheet-open')) this.openSheet('right');
      else if (dy >= PHONE_STRIP_POLICY.swipePx && this.right.classList.contains('prw-sheet-open')) this.closeSheets();
    }, { passive: true });
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
  }

  // --------------------------------------------------------------------------
  // Test hook
  // --------------------------------------------------------------------------

  debugState(): Record<string, unknown> {
    const walk = this.walk;
    return {
      ready: Boolean(walk && this.tops.length),
      focus: walk?.focus ?? -1,
      target: walk ? this.targetLine() : -1,
      cursor: walk ? this.cursorLine() : -1,
      preview: walk && this.hoverLine !== null && this.hoverLine !== walk.focus ? this.hoverLine : null,
      previewCommits: this.previewCommits.map(c => ({ ...c })),
      marginTab: this.marginTab,
      navigator: this.navigator.debugState(),
      replies: this.replies.map(r => ({ ...r })),
      sheet: this.right.classList.contains('prw-sheet-open') ? 'margin' : this.left.classList.contains('prw-sheet-open') ? 'navigator' : null,
      hover: this.hoverLine,
      hoverWrites: this.hoverWrites,
      hoverLog: [...this.hoverLog],
      touch: this.touchMode(),
      strip: this.strip.hidden ? null : { line: Number(this.strip.dataset.line), status: this.strip.dataset.status ?? '' },
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
      // Stage B: the scroll camera. `band` is the dead zone in viewport y; `offset` is null while
      // the reading line is still the default (the first line's place).
      camera: { view: this.cameraView(), band: deadZone(this.cameraView()), offset: this.readingOffset },
      tops: [...this.tops],
      heights: [...this.heights],
      constants: READING_WALK,
      error: this.lastError,
      commits: this.commits.map(c => ({ ...c, ids: [...c.ids] })),
      writing: isWriting(),
      mode: this.modeEl.dataset.mode ?? null,
      modeText: this.modeEl.textContent ?? '',
      editing: editSession(),
      notice: this.sbNotice.hidden ? '' : (this.sbNotice.textContent ?? ''),
      doneVisible: !this.doneBtn.hidden,
      statusBar: { line: this.sbLine.textContent, marked: this.sbMarked.textContent, issues: this.sbIssues.dataset.count === '' ? null : Number(this.sbIssues.dataset.count), provisional: this.sbProvisional.hidden ? 0 : (this.walk?.provisionalCount ?? 0) },
      rule: this.ruleEl.hidden ? null : Number(this.ruleEl.dataset.line),
      rail: this.railFollow?.debugState() ?? null,
    };
  }
}
