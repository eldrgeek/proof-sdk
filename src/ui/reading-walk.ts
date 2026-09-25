import { REVIEW_SURFACE_POLICY, viewerLabel } from '../shared/review-surface';
/**
 * The reading layout and reading walk.
 * Mike, 2026-09-24, Accord yfbqrau4: clicking text edits it as a live proposal.
 * S and Suggest change put the caret in the selected passage. Hover changes nothing.
 * Scrolling records Seen only; it never accepts a proposal or changes the selected passage.
 *
 * Authorship: requirements by Mike Wolf ("Reading and marking", 2026-09-18) with the COS's
 * decisions for the gaps; built by Claude Opus 5 (worker reading-walk), 2026-09-18.
 *
 * Layout (desktop): a left rail, the document in a readable centre column, and a right rail
 * that holds the selected passage's one answer group. Review holds its discussion and proposals.
 * Phones (<= 700 px): one column; the rails open as bottom sheets from the ⋯ menu, and a margin
 * dot opens the same answer group in the Margin sheet.
 *
 * Review owns A, J, K and Delete only while its list has focus. In the text those keys edit.
 * Escape leaves the text. Outside text and fields, S edits the selected passage and E explains.
 *
 * Accord layout stage 3 (Ren's proposal, Mike ruled 2026-09-21; decisions 4, 6, 7, 8, 11;
 * policies in src/shared/layout-panels.ts): the left rail is the Navigator (Outline · Issues ·
 * Since you, src/ui/navigator.ts), the right rail is the Margin (Line N · Room).
 * Phones: a position strip opens the one answer group in the Margin sheet.
 */
import { TextSelection } from '@milkdown/kit/prose/state';
import { productIdentity } from '../shared/product-identity';
import type { Mark, CommentData, ReplaceData } from '../formats/marks';
import { getActorName, getMarkColor } from '../formats/marks';
import { actorKey, isAiActor, type DocLine } from '../shared/line-marks';
import { UNCERTAIN_POLICY, WHY_POLICY } from '../shared/review-aids';
import { BUNDLE_POLICY, describeBundle, type BundleView } from '../shared/bundles';
import { EXPLAIN_POLICY } from '../shared/explain';
import { ASK_POLICY, type AskChoice } from '../shared/asks';
import { READING_WALK, ReadingWalk, countWords, dwellMsFor, type WalkLine, type WalkMark, type WalkSnapshot } from '../shared/reading-walk';
import type { LineMarksUI, MarkBox } from './line-marks';
import { isOpenReviewMark, type PlayMakerReview, type ReviewAction } from './playmaker-review';
import { editingGuardDebug, editingRemainingMs, installEditingGuard, isInputComposing, isReadingOwned, isWriting, keyTargetOf, letterShortcutsEnabled, onEditingActivity, onWritingChange, setLetterShortcutsEnabled } from '../editor/editing-guard';
import { EDIT_SESSION_POLICY, postedNoticeText } from '../shared/edit-session';
import { READING_MODE_POLICY } from '../shared/reading-keys';
// Accord round 2, stage D: the discussion on a line lives in the document, in the Line tab.
import { ThreadsPanel } from './threads';
import { THREAD_POLICY, type ThreadAsks, type ThreadStatus } from '../shared/threads';
import { ProxyMarksUI } from './proxy-marks';
import { ReadingSettingsUI } from './reading-settings';
import { SETTINGS_POLICY } from '../shared/layout-chrome';
import { ScrollFollower, containRailWheel } from './rail-follow';
import { setReadingAnchor } from '../editor/caret-anchor';
import { SCROLL_CAMERA_POLICY, anchoredScroll, bandFractionFor, cameraScroll, deadZone, type CameraView } from '../shared/scroll-camera';
import { HIGHLIGHT_POLICY, MARKED_UP_TO_POLICY, formatAgo, issuesLeftText } from '../shared/layout-status';
import { ACCORDS_LIST_POLICY, BOTTOM_CHAT_POLICY, OPEN_ITEMS_POLICY, MARGIN_POLICY, NAVIGATOR_POLICY, PHONE_STRIP_POLICY, parseRailState, reviewListKey, type MarginTab, type RailState } from '../shared/layout-panels';
import { NavigatorUI } from './navigator';
import { personalCompletionText } from '../shared/participant-status';
import { reviewStorageKey } from '../shared/review-list';
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

} as const;

/**
 * Touch focus (Mike, 2026-09-19): "On a touch surface, there should be some other way to indicate
 * what the current mark or the current item being looked at is." The focus line is the reading
 * line; it gets a strong band and a left bar, and a strip docked at the bottom shows its mark and
 * one control that opens the answer sheet. Tapping text selects a passage.
 */
export const TOUCH_FOCUS_POLICY = {
  enabled: true,
  query: '(pointer: coarse)',
  /** Height the page reserves for the strip (px, plus the safe area). */
  stripHeightPx: PHONE_STRIP_POLICY.heightPx,
  /** While the caret is in the text (keyboard up), the strip steps aside so it never covers the text being edited. */
  hideWhileEditing: true,
} as const;

export interface ReadingWalkHost {
  slug(): string | null;
  newDocument(): void;
  suggestChange(line: number): boolean;
  canSuggest(): boolean;
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
  directEditing?(): boolean;
  /** Step B2: lines inside folded sections (the walk steps over them). */
  hiddenLines?(): ReadonlySet<number>;
  /** Step B2: the visible line that stands for a hidden one (its folded heading). */
  visibleLineFor?(lineIndex: number): number;
  /** The selected passage changed; dependent displays may update without moving focus. */
  focusChanged?(lineIndex: number): void;
  /** Accord layout stage 3: the folding owner, for the Navigator's Outline. */
  folding?(): FoldingUI | null;
}

const PHONE_QUERY = '(max-width: 700px)';
/** Step B3b: the reader's reading rate (words per second), per browser. */
const RATE_KEY = 'proof:reading-rate';

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
    if (node.closest('.accord-draft')) return true;
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
  /** Step B3b: the reading-rate setting. */
  private readonly rateEl = el('label', 'prw-rate');
  private readonly boxHost = el('section', 'prw-linebox');
  private readonly changesHost = el('section', 'prw-changes');
  /** Accord stage D: the threads anchored to the line the Margin shows. */
  private threads: ThreadsPanel | null = null;
  private readonly dockHost = el('div', 'prw-dock');
  /** Mike, 2026-09-24, yfbqrau4: the same chat at the foot of the centre column. */
  readonly chatSlot = el('div', 'prw-chat prw-chat-bottom');
  readonly documentsToggle = el('button', 'prw-documents-toggle');
  private readonly docsBody = el('div', 'prw-rail-body prw-documents-body');
  private docsSig = '';
  private chatExpanded = BOTTOM_CHAT_POLICY.initiallyExpanded as boolean;
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
  private readonly guestNotice = el('div', 'prw-guest-notice');
  private guestNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly sbNotice = el('span', 'pst-notice');
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Accord layout stage 1: the status bar fixed under the page (Line N of M · You marked up to
   * line K · Issues left · Reading / Writing), and the "You marked up to
   * here" rule inside the page after the viewer's last explicit mark.
   */
  private readonly statusBar = el('div', 'pst-bar');
  private readonly sbLine = el('span', 'pst-line');
  private readonly sbMarked = el('span', 'pst-marked');
  private readonly completionEl = el('span', 'pst-completion');
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
  private seenQueue: string[] = [];
  private seenBusy = false;
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

  /** Touch focus: the strip docked at the bottom. */
  private readonly strip = el('div', 'prw-strip');
  private stripSig = '';
  private stripTouch: { y: number; at: number } | null = null;

  /** Review, Outline and Since you, now on the right (Mike, 2026-09-24, yfbqrau4). */
  readonly navigator: NavigatorUI;
  /** Phones: the one Undo sits at the top of Review (desktop: the toolbar). */
  private readonly lineTools = el('div', 'amg-tools');
  /** The Familiar's note (folded) and everyone's marks on the line, after the line's changes. */
  private readonly tailHost = el('div', 'amg-tail');
  /** Who the viewer's marks name, and My Familiar: the Line tab's footer. */
  private tailSig = '';
  /** Familiar proxy marks: My Familiar (header), the brief (top of the rail), the phone pill. */
  readonly proxy: ProxyMarksUI;
  /** Accord layout stage 2 (decision 10): reading speed and This sitting live in View › Reading settings. */
  readonly settings = new ReadingSettingsUI();

  constructor(private readonly host: ReadingWalkHost) {
    this.proxy = new ProxyMarksUI({
      lineMarks: () => this.host.lineMarks(),
      focusLine: (index) => { this.host.lineMarks().revealLine(index); this.focusLine(index); if (isPhone()) this.closeSheets(); },
      openBrief: () => { if (isPhone()) this.openSheet('right'); else this.setCollapsed('right', false); this.proxy.briefEl.scrollIntoView({ block: 'nearest' }); },
    });
    this.left.setAttribute('aria-label', `${productIdentity().documentNounPlural} list`);
    this.left.id = 'prw-documents-panel';
    this.right.id = 'anv-panel';
    this.right.setAttribute('aria-label', 'Review panel');
    this.focusEl.setAttribute('aria-hidden', 'true');
    this.styleEl.id = 'prw-dynamic-style';
    const saved = this.railState();
    this.navigator = new NavigatorUI({
      lineMarks: () => this.host.lineMarks(),
      cursor: () => this.cursorLine(),
      go: (index) => { this.host.lineMarks().revealLine(index); this.focusLine(index); },
      toggle: () => this.toggleRailFromMenu('right'),
      tabChanged: (tab) => this.saveRailState({ reviewTab: tab }),
      decide: (line, action) => this.decideReviewLine(line, action),
      focusDocument: (line) => this.focusDocument(line),
    }, saved.reviewTab ?? saved.leftTab);
    this.buildRails();
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;
    setReadingAnchor({
      position: () => this.lines[this.cursorLine()]?.pos ?? null,
      mapped: pos => {
        // lineAtPos falls through to the last line when its list is still the pre-edit one.
        // Follow the mapped position only when it still lands inside the selected passage.
        const lines = this.host.lineMarks().lineList();
        const line = lines.find(candidate => pos >= candidate.pos && pos < candidate.pos + candidate.nodeSize);
        if (line && `${line.hash}:${line.occurrence}` === this.selectedKey) this.selectPassage(line.index);
        this.rememberViewport();
      },
    });
    document.body.classList.add('prw-on');
    this.applyRailState();
    document.head.append(this.styleEl);
    document.body.append(this.left, this.right, this.chatSlot);
    document.body.style.setProperty('--prw-left-size', `${ACCORDS_LIST_POLICY.widthPx}px`);
    document.body.style.setProperty('--prw-right-size', `${NAVIGATOR_POLICY.widthPx}px`);
    document.body.style.setProperty('--prw-chat-compact', `${BOTTOM_CHAT_POLICY.compactHeightPx}px`);
    document.body.style.setProperty('--prw-chat-expanded', `${BOTTOM_CHAT_POLICY.expandedHeightShare * 100}dvh`);
    // Rail scrolling: a wheel over a rail scrolls that rail's lists only, never the page.
    this.railWheelCleanups.push(containRailWheel(this.left), containRailWheel(this.right));
    window.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('resize', this.onResize);
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('click', this.onDocClick, true);
    document.addEventListener('beforeinput', this.guestEditAttempt, true);
    document.addEventListener('keydown', this.guestEditAttempt, true);
    document.addEventListener('visibilitychange', this.onVisibility);
    document.addEventListener('focusin', this.onFocusChange);
    document.addEventListener('focusout', this.onFocusChange);
    window.addEventListener('proof:follow-in-page-link', this.onInPageLink as EventListener);
    document.body.append(this.strip, this.statusBar);
    document.body.classList.add('pst-on');
    // Accord layout stage 1: highlights the proposal removed come back only by policy.
    document.body.classList.toggle('phl-context-dim', HIGHLIGHT_POLICY.contextDimming);
    this.agoTimer = setInterval(() => { this.statusSig = ''; this.renderStatusBar(); }, MARKED_UP_TO_POLICY.refreshMs);
    try { window.matchMedia(PHONE_QUERY).addEventListener('change', this.onResize); } catch { /* old browsers */ }
    try { window.matchMedia(TOUCH_FOCUS_POLICY.query).addEventListener('change', this.onResize); } catch { /* old browsers */ }
    // Step B4c: "This sitting" (the budget setting and its status) sits under the reading speed,
    // both in View › Reading settings since Accord layout stage 2 (decision 10).
    const budget = this.host.lineMarks().budgetEl;
    if (SETTINGS_POLICY.readingSettingsInView) this.settings.mount(budget);
    else { this.rightHeadEl?.append(this.rateEl); if (budget.parentElement !== this.rightBody) this.rightBody.insertBefore(budget, this.boxHost); }
    // The Accord rules retire reader tier controls. Stored tags remain available to the API.
    // Keep proxy state available, but the retired Line tab and its brief render nowhere.
    this.proxy.start();
    (window as unknown as { __proofProxy?: ProxyMarksUI }).__proofProxy = this.proxy;
    this.unsubscribe = this.host.lineMarks().subscribe(() => this.sync());
    installEditingGuard();
    (window as unknown as { __proofEditingGuard?: typeof editingGuardDebug }).__proofEditingGuard = editingGuardDebug;
    this.unsubscribeWriting = onWritingChange(() => { this.renderMode(); this.queueRender(); });
    this.renderMode();
    this.unsubscribeEditing = onEditingActivity(() => {
      // The press that places the caret lands before focus moves: check on the next frame.
      requestAnimationFrame(() => { if (isWriting()) { this.rebaseAfterEdit = true; this.queueFollowCaret(); } });
    });
    this.sync();
    void this.loadDocuments();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    setReadingAnchor(null);
    document.body.classList.remove('prw-on', 'prw-left-collapsed', 'prw-right-collapsed');
    window.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('click', this.onDocClick, true);
    document.removeEventListener('beforeinput', this.guestEditAttempt, true);
    document.removeEventListener('keydown', this.guestEditAttempt, true);
    document.removeEventListener('visibilitychange', this.onVisibility);
    document.removeEventListener('focusin', this.onFocusChange);
    document.removeEventListener('focusout', this.onFocusChange);
    window.removeEventListener('proof:follow-in-page-link', this.onInPageLink as EventListener);
    this.strip.remove();
    if (this.guestNoticeTimer) { clearTimeout(this.guestNoticeTimer); this.guestNoticeTimer = null; }
    this.guestNotice.remove();
    this.statusBar.remove();
    this.ruleEl.remove();
    if (this.agoTimer) clearInterval(this.agoTimer);
    this.agoTimer = null;
    document.body.classList.remove('prw-touch', 'prw-strip-on', 'pst-on', 'phl-context-dim', 'prw-margin-sheet');
    this.unsubscribe?.();
    this.proxy.stop();
    this.unsubscribeEditing?.();
    this.unsubscribeEditing = null;
    this.unsubscribeWriting?.();
    this.unsubscribeWriting = null;
    for (const cleanup of this.railWheelCleanups.splice(0)) cleanup();
    this.resizeObserver?.disconnect();
    this.host.playmaker()?.dock(null);
    this.left.remove(); this.right.remove(); this.chatSlot.remove(); this.documentsToggle.remove(); this.focusEl.remove(); this.styleEl.remove();
    this.settings.remove();
  }

  /** Step B2: a section folded or unfolded. Rebuild the walk's hidden lines and the rail box. */
  onFoldChange(): void {
    if (!this.started) return;
    this.boxSig = '';
    this.sync();
  }

  /** The one Undo control stays available on the phone. */
  mountTool(node: HTMLElement, _options: { first?: boolean } = {}): void {
    if (node.parentElement !== this.lineTools) this.lineTools.prepend(node);
  }


  /** The editor view updated (cursor, marks, text): re-read pending marks if they changed. */
  notifyViewUpdate(): void {
    if (!this.started) return;
    if (isWriting()) this.queueFollowCaret();
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
    const selected = this.lines.findIndex(line => `${line.hash}:${line.occurrence}` === this.selectedKey);
    this.selectPassage(selected >= 0 ? selected : Math.min(this.selectedIndex, Math.max(0, this.lines.length - 1)));
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
      // Tier metadata never removes a visible passage from J / K navigation.
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
    if (this.walk.isHidden(this.cursorLine())) this.selectPassage(this.host.visibleLineFor?.(this.cursorLine()) ?? 0);
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

  private queueFollowCaret(): void {
    if (!READING_EDIT_POLICY.focusFollowsCaret || this.followQueued) return;
    this.followQueued = true;
    requestAnimationFrame(() => { this.followQueued = false; this.followCaret(); });
  }

  /** Editing first: the focus line is the caret's line (a jump: nothing read, nothing passed, no scroll). */
  private followCaret(): void {
    const walk = this.walk;
    const view = this.view();
    if (!walk || !view || !this.started || !isWriting()) return;
    const line = this.host.lineMarks().lineAtPos(view.state.selection.head);
    if (line < 0 || walk.isHidden(line)) return;
    this.selectPassage(line);
    if (line === walk.focus) return;
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
      this.resizeObserver = new ResizeObserver(() => {
        this.restoreViewport(); this.measure(); this.queueRender();
      });
      this.resizeObserver.observe(view.dom);
      this.resizeObserver.observe(document.body);
    }
  }

  private viewportAnchor: { key: string; top: number; scrollY: number } | null = null;
  private passageTop(): number | null {
    const line = this.lines[this.cursorLine()];
    const node = line && this.view()?.nodeDOM(line.pos);
    if (!(node instanceof HTMLElement) || !node.isConnected) return null;
    const rect = node.getBoundingClientRect();
    return rect.height > 0 ? rect.top : null;
  }
  private rememberViewport(): void {
    const top = this.passageTop();
    this.viewportAnchor = top !== null && this.selectedKey
      ? { key: this.selectedKey, top, scrollY: window.scrollY } : null;
  }
  private restoreViewport(): void {
    const before = this.viewportAnchor;
    const top = this.passageTop();
    if (before && before.key === this.selectedKey && top !== null && !isWriting()) {
      const target = anchoredScroll(before, { top, scrollY: window.scrollY }, document.documentElement.scrollHeight - window.innerHeight);
      if (Math.abs(target - window.scrollY) >= 1) {
        this.cameraAt = target;
        window.scrollTo({ top: target, behavior: 'instant' });
      }
    }
    this.rememberViewport();
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
      bottomInset: height - Math.max(chrome + 1, Math.min(
        window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : height,
        this.chatSlot.isConnected ? this.chatSlot.getBoundingClientRect().top : height,
        isPhone() && this.right.classList.contains('prw-sheet-open') ? this.right.getBoundingClientRect().top : height)),
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

  // --------------------------------------------------------------------------
  // Input
  // --------------------------------------------------------------------------

  private onScroll = (): void => {
    const walk = this.walk;
    if (!walk || this.tops.length === 0) return;
    // Editing first: while the person edits, scrolling moves nothing and snaps nothing.
    if (isWriting()) { this.rebaseAfterEdit = true; this.queueRender(); return; }
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
    if (target !== walk.focus) {
      walk.moveTo(target, performance.now(), 'scroll', this.heights);
      this.afterChange();
    } else {
      this.queueRender();
    }
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    // The editing guard prevents a reading key's default when the text holds the keyboard without
    // the person writing (so it never types): that key is still ours to run.
    if (!this.walk || (event.defaultPrevented && !isReadingOwned(event)) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (isWriting() || isTypingTarget(event.target) || event.isComposing || event.keyCode === 229 || isInputComposing()) return;
    if (/^[a-z]$/i.test(event.key) && (!letterShortcutsEnabled() || this.host.directEditing?.())) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('[role="dialog"], .pm-review-dialog, .mark-popover, .plm-menu, .proof-share-overflow-menu, [role="menu"]')) return;
    const key = event.key;
    if (key === 'Escape' && this.host.lineMarks().selectionLines().length) { this.host.lineMarks().clearSelection(); return; }
    if (key.toLowerCase() === 's') {
      event.preventDefault(); this.host.suggestChange(this.cursorLine()); return;
    }
    // Mike, 2026-09-25: "I can navigate using J/K but I can't accept without moving my mouse to
    // the sidebar and clicking. I'd often like to accept and then make a change." A accepts and
    // Delete rejects the open item on the line J and K reached, by the Review list's own rules
    // (yfbqrau4 point 4), and the focus stays on it; Enter then starts editing it. R stays retired.
    const reviewKey = reviewListKey({ key, listFocused: true, typing: false, letterShortcuts: letterShortcutsEnabled() });
    if (reviewKey === 'accept' || reviewKey === 'reject') {
      event.preventDefault(); this.navigator.decideAtLine(this.cursorLine(), reviewKey); return;
    }
    if (reviewKey === 'document' && keyTargetOf(event.target) === 'other') {
      event.preventDefault(); this.focusDocument(this.cursorLine()); return;
    }
    if (/^r$/i.test(key)) { event.preventDefault(); return; }
    if (key.toLowerCase() === 'j' || key === 'ArrowDown') { event.preventDefault(); this.next(); return; }
    if (key.toLowerCase() === 'k' || key === 'ArrowUp') { event.preventDefault(); this.previous(); return; }
    // Step B4f: E asks the AI collaborators to explain the focus line (never a rejection).
    if (key.toLowerCase() === EXPLAIN_POLICY.key) { event.preventDefault(); this.explainFocus(); return; }
    const focus = this.targetLine();
    // Step B3: Y / N / T answer the ask on the focus line (only when the line carries one).
    const choice = (Object.keys(ASK_POLICY.keys) as AskChoice[]).find(c => ASK_POLICY.keys[c] === key.toLowerCase());
    if (choice && this.host.lineMarks().askForLine(focus)) {
      event.preventDefault();
      this.answerFocus(choice);
      return;
    }
    // Accord stage D: T starts a thread on the selection, or on the cursor line when nothing is
    // selected. T's older meaning — "Not yet" to an ask — is kept above and wins on a line that
    // carries an ask (THREAD_POLICY.askAnswerWins); on every other line T was doing nothing.
    if (key.toLowerCase() === THREAD_POLICY.key) {
      event.preventDefault();
      this.startThreadHere();
      return;
    }
  };

  /** T or Discuss opens the Review composer for the selected passage or phrase. */
  startThreadHere(fromSelection = false): boolean {
    if (!this.threads) return false;
    this.openReviewItem(this.cursorLine());
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
      proposalCardElsewhere: view => {
        if (!view.open || view.thread.kind !== 'proposal' || !view.thread.markId) return false;
        const bundle = lm().bundleForMark(view.thread.markId);
        return !bundle || bundle.stale.length > 0;
      },
      proposalDecisionElsewhere: view => Boolean(view.open && view.thread.markId && lm().bundleForMark(view.thread.markId)?.stale.length === 0),
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

  /** Step B3: Y / N / T on the focus line's ask. */
  private answerFocus(choice: AskChoice): void {
    if (isPhone()) this.closeSheets();
    this.host.lineMarks().answerInlineAsk(this.targetLine(), choice);
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

  /** Step B4d: the cursor (shift-click ranges in the margin start here; the chat's 📍 points here). */
  letterShortcutsEnabled(): boolean { return letterShortcutsEnabled(); }
  toggleLetterShortcuts(): void { setLetterShortcutsEnabled(!letterShortcutsEnabled()); }

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
    if (isPhone()) { if ((side === 'left' ? this.left : this.right).classList.contains('prw-sheet-open')) this.closeSheets(); else this.openSheet(side); return; }
    this.setCollapsed(side, !document.body.classList.contains(`prw-${side}-collapsed`));
  }

  railShown(side: 'left' | 'right'): boolean {
    if (isPhone()) return (side === 'left' ? this.left : this.right).classList.contains('prw-sheet-open');
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

  private guestEditAttempt = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest('.ProseMirror') || target.closest('button, a[href], input, textarea') || this.host.canSuggest()) return;
    if (event instanceof KeyboardEvent && (event.ctrlKey || event.metaKey || event.altKey || (event.key.length !== 1 && !['Backspace', 'Delete', 'Enter'].includes(event.key)))) return;
    const me = this.host.lineMarks().viewerIdentity();
    if (me.trust !== 'guest' && !me.attestedBy) return;
    event.preventDefault();
    this.guestNotice.textContent = REVIEW_SURFACE_POLICY.guestEditNotice;
    this.guestNotice.setAttribute('role', 'status');
    document.body.append(this.guestNotice);
    if (me.signInUrl) {
      const link = el('a', 'prw-guest-signin', 'Sign in');
      link.href = me.signInUrl;
      this.guestNotice.replaceChildren('You can comment as a guest. ', link, ' to edit.');
    }
    // The notice answers the attempt; it goes away on its own so it never covers the text for good.
    if (this.guestNoticeTimer) clearTimeout(this.guestNoticeTimer);
    this.guestNoticeTimer = setTimeout(() => { this.guestNoticeTimer = null; this.guestNotice.remove(); }, REVIEW_SURFACE_POLICY.guestEditNoticeMs);
  };

  /** A click places the caret for editors and names the passage for guests. */
  private onDocClick = (event: MouseEvent): void => {
    this.guestEditAttempt(event);
    if (isWriting()) return;
    const view = this.view();
    const target = event.target as HTMLElement | null;
    if (!view || !this.walk || !target || !view.dom.contains(target) || target.closest('button, input, textarea, a[href], .accord-draft')) return;
    const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
    if (!pos) return;
    const line = this.host.lineMarks().lineAtPos(pos.inside >= 0 ? pos.inside + 1 : pos.pos);
    if (line < 0) return;
    this.selectPassage(line);
    this.walk.moveTo(line, performance.now(), 'jump');
    this.afterChange();
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

  private touchMode(): boolean {
    if (!TOUCH_FOCUS_POLICY.enabled) return false;
    try { return window.matchMedia(TOUCH_FOCUS_POLICY.query).matches; } catch { return false; }
  }

  /**
   * The selected passage is one line. A click sets it, and J / K move it. Scrolling records Seen
   * and does not move it. Mike, 2026-09-23 (usability brief).
   */
  private selectedIndex = 0;
  private selectedKey: string | null = null;
  cursorLine(): number { return this.selectedIndex; }
  private selectPassage(index: number): void {
    const previousIndex = this.selectedIndex;
    const previousKey = this.selectedKey;
    this.selectedIndex = index;
    const line = this.lines[index];
    this.selectedKey = line ? `${line.hash}:${line.occurrence}` : null;
    if (this.selectedKey !== previousKey) this.rememberViewport();
    // Listeners (the chat) follow the selected passage even when no render follows.
    if (index !== previousIndex || this.selectedKey !== previousKey) this.host.focusChanged?.(index);
  }

  /** The selected passage. Hover never changes it. Mike, 2026-09-23 (usability brief). */
  targetLine(): number { return this.cursorLine(); }


  private onFocusChange = (): void => { this.renderMode(); this.queueRender(); };

  /**
   * The mode chip: what the next letter key will do, and — the point of Accord round 2 stage A —
   * whether an edit is open and which line it is on. Mike, 2026-09-22: "there should be some
   * better indication that we are in editing mode. Not clear how to get out of editing mode."
   */
  private renderMode(): void {
    const writing = isWriting();
    this.modeEl.dataset.mode = writing ? 'editing' : 'reading';
    this.modeEl.textContent = writing ? 'Writing' : 'Reading';
    this.modeEl.title = writing ? 'Typing proposes changes. Escape returns to Review.' : 'Click text to edit it.';
    this.modeEl.setAttribute('aria-label', this.modeEl.textContent);
    document.body.classList.toggle('prw-editing', writing);
    const suggest = this.boxHost.querySelector<HTMLButtonElement>('.plm-suggest');
    if (suggest) suggest.disabled = !this.host.canSuggest() || writing;
    this.renderFocus();
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

  /** The touch strip names the passage and opens its one answer sheet. */
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
    // Mike, 2026-09-24, yfbqrau4: position and an open-item count, no line-mark controls.
    const index = this.cursorLine();
    const count = lm.reviewViews()['needs-you'].count;
    const sheetOpen = this.right.classList.contains('prw-sheet-open');
    const sig = `${index}|${this.lines.length}|${count}|${sheetOpen}`;
    if (sig === this.stripSig) return;
    this.stripSig = sig;
    this.strip.dataset.line = String(index);
    this.strip.setAttribute('role', 'region');
    this.strip.setAttribute('aria-label', 'Reading position and Review');
    const where = el('span', 'prw-strip-where', `Line ${index + 1} of ${this.lines.length}`);
    const review = el('button', 'prw-strip-review', `${count} open ${count === 1 ? 'item' : 'items'}`);
    review.type = 'button';
    review.setAttribute('aria-controls', 'anv-panel');
    review.setAttribute('aria-expanded', String(sheetOpen));
    review.onclick = () => { this.navigator.select('issues'); this.toggleRailFromMenu('right'); };
    this.strip.replaceChildren(where, review);
  }

  // --------------------------------------------------------------------------
  // Actions
  // --------------------------------------------------------------------------

  /** J / ↓: the next visible passage. */
  next(): void {
    const walk = this.walk;
    if (!walk) return;
    // A collapsed section is one stop: its heading.
    const to = walk.nextVisible(1, this.cursorLine());
    if (to === null) return;
    walk.moveTo(to, performance.now(), 'scroll', this.heights);
    this.selectPassage(walk.focus);
    this.cameraTo(walk.focus);
    this.rememberViewport();
    this.afterChange();
  }

  /** K / ↑: the previous visible passage. */
  previous(): void {
    const walk = this.walk;
    if (!walk) return;
    const to = walk.nextVisible(-1, this.cursorLine());
    if (to === null) return;
    walk.moveTo(to, performance.now(), 'scroll', this.heights);
    this.selectPassage(walk.focus);
    this.cameraTo(walk.focus);
    this.rememberViewport();
    this.afterChange();
  }

  /** Moves the focus to a line without reading the lines on the way (Next issue, a dot). */
  focusLine(index: number): boolean {
    const walk = this.walk;
    if (!walk || this.tops[index] === undefined) return false;
    if (walk.isHidden(index)) index = this.host.visibleLineFor?.(index) ?? index;
    this.measure();
    walk.moveTo(index, performance.now(), 'jump', this.heights);
    this.selectPassage(index);
    this.cameraTo(index);
    this.rememberViewport();
    this.afterChange();
    return true;
  }

  /** Mike, 2026-09-24, yfbqrau4: an amber dot selects the passage in Review. */
  activateDot(index: number): boolean {
    if (!this.walk) return false;
    this.openReviewItem(index);
    return true;
  }

  focusDocument(index: number): void {
    if (isPhone()) this.closeSheets();
    this.host.lineMarks().revealLine(index);
    this.focusLine(index);
    const view = this.view();
    const line = this.lines[index];
    if (!view || !line) return;
    const pos = Math.min(line.pos + 1, view.state.doc.content.size);
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));
    view.focus(); // Step 3: the next key proposes a change at this caret.
  }

  /** Exactly the card's call, including bundle preflight and the existing undo entry. */
  private decideReviewLine(index: number, action: 'accept' | 'reject'): void {
    const pending = new Map(this.pendingMarks().map(mark => [mark.id, mark]));
    const item = this.walk?.marksOn(index).find(item => {
      const mark = pending.get(item.id);
      return mark && ['insert', 'replace', 'delete'].includes(mark.kind);
    });
    const mark = item && pending.get(item.id);
    if (!mark) { this.lastError = 'This proposal is no longer pending.'; this.renderNow(); return; }
    const bundle = this.host.lineMarks().bundleForMark(mark.id);
    if (bundle) this.decideBundle(bundle.bundle.id, action);
    else this.decide(mark, action);
  }

  private decide(mark: Mark, action: ReviewAction, text?: string): void {
    const walk = this.walk;
    if (!walk) return;
    try {
      this.host.decide([mark.id], action, text);
      this.lastError = '';
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Could not save the decision.';
    }
    this.afterChange();
  }

  // --------------------------------------------------------------------------
  // After every change
  // --------------------------------------------------------------------------

  private afterChange(): void {
    const walk = this.walk;
    if (!walk) return;
    for (const event of walk.drain()) {
      if (event.type === 'seen') this.enqueueSeen(event.key);
    }
    this.scheduleTick();
    this.scheduleSave();
    this.renderNow();
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

  private enqueueSeen(_key: string): void {
    if (REVIEW_SURFACE_POLICY.seenByDwell) { this.seenQueue.push(_key); void this.drainSeen(); }
  }

  private async drainSeen(): Promise<void> {
    if (this.seenBusy) return;
    this.seenBusy = true;
    try {
      const lm = this.host.lineMarks();
      while (this.seenQueue.length) {
        const key = this.seenQueue.shift()!;
        if (!lm.isLoaded()) continue;
        const passage = lm.lineList().find(line => `${line.hash}:${line.occurrence}` === key);
        if (!passage) continue;
        const line = passage.index;
        // Seen never replaces a decision, and delayed writes still refer to the text read.
        const status = lm.dwellStatusFor(line);
        if (!status || status === 'skimmed') continue;
        this.seenWrites.push(line);
        await lm.setLineStatus(line, 'seen', undefined, 'dwell');
      }
    } finally {
      this.seenBusy = false;
    }
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
      try { sessionStorage.setItem(key, JSON.stringify({ ...this.walk.snapshot(), focus: this.cursorLine() })); } catch { /* optional */ }
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
    this.selectPassage(this.walk.focus);
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

  /**
   * A button in the margin, named so a rebuild can focus the same control again. A remote
   * comment redraws the box; the reader's focus stays on the control they were on.
   * Mike, 2026-09-23 (usability brief): nothing moves unless the reader does it.
   */
  private marginControlKey(active: HTMLElement): string | null {
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return null;
    const status = active.dataset.status;
    if (status && active.classList.contains('plm-choice')) {
      const where = active.closest('.plm-more-marks') ? 'more' : active.closest('.plm-actions') ? 'primary' : 'other';
      return `choice:${where}:${status}`;
    }
    const label = active.getAttribute('aria-label');
    return label ? `label:${label}` : null;
  }

  /** Puts focus back on the control a margin rebuild replaced. */
  private restoreMarginControl(key: string): void {
    let next: HTMLElement | null = null;
    if (key.startsWith('choice:')) {
      const [, where, status] = key.split(':');
      const sel = `.plm-choice[data-status="${status}"]`;
      if (where === 'more') next = this.right.querySelector(`.plm-more-marks ${sel}`);
      else if (where === 'primary') next = this.right.querySelector(`.plm-actions:not(.plm-more-marks) ${sel}`);
      else next = this.right.querySelector(sel);
    } else if (key.startsWith('label:')) {
      const label = key.slice('label:'.length);
      next = [...this.right.querySelectorAll<HTMLElement>('[aria-label]')].find(el => el.getAttribute('aria-label') === label) ?? null;
    }
    if (next && document.activeElement !== next) next.focus({ preventScroll: true });
  }

  private renderNow(): void {
    const walk = this.walk;
    if (!walk || !this.started) return;
    const active = document.activeElement;
    const detailControl = active instanceof HTMLElement && this.navigator.detailEl.contains(active) ? active : null;
    const detailCard = detailControl?.closest<HTMLElement>('[data-thread], [data-mark-id], [data-bundle-id]');
    const detailKey = detailCard && detailControl ? {
      thread: detailCard.dataset.thread, mark: detailCard.dataset.markId, bundle: detailCard.dataset.bundleId,
      label: detailControl.getAttribute('aria-label') ?? detailControl.textContent,
      tag: detailControl.tagName, cls: detailControl.className,
    } : null;
    const held = active instanceof HTMLElement
      && (this.boxHost.contains(active) || this.tailHost.contains(active) || this.changesHost.contains(active))
      ? active : null;
    const heldKey = held ? this.marginControlKey(held) : null;
    const identity = reviewStorageKey(this.host.slug() ?? 'local', this.host.lineMarks().me());
    if (this.reviewIdentity !== identity) { this.reviewIdentity = identity; this.navigator.resetSession(); this.applyRailState(); }
    this.dockPanel();
    this.renderFocus();
    this.renderDynamicStyle();
    this.renderStatus();
    this.renderMe();
    const restoreDetailAnchor = Number(this.boxHost.dataset.line) === this.targetLine() ? this.navigator.holdDetailAnchor() : () => {};
    const railSig = `${this.boxSig}\n${this.changesSig}`;
    if (MARGIN_POLICY.renderLineTab) this.renderBox();
    this.renderChanges();
    this.threads?.render();
    // The focus line changed, or its box or changes did: keep them in view at the rail's bottom.
    if (`${this.boxSig}\n${this.changesSig}` !== railSig && !this.typingInRail()) this.railFollow?.follow();
    this.renderRate();
    this.renderStrip();
    this.renderStatusBar();
    this.renderRule();
    this.renderMarginTabs();
    if (MARGIN_POLICY.renderLineTab) this.renderTail();
    this.renderDocuments();
    this.navigator.render();
    restoreDetailAnchor();
    this.host.focusChanged?.(this.cursorLine());
    this.restoreViewport();
    if (heldKey && held && !held.isConnected) this.restoreMarginControl(heldKey);
    if (detailKey && detailControl && !detailControl.isConnected) {
      const cards = [...this.navigator.detailEl.querySelectorAll<HTMLElement>('[data-thread], [data-mark-id], [data-bundle-id]')];
      const card = cards.find(node => node.dataset.thread === detailKey.thread && node.dataset.markId === detailKey.mark && node.dataset.bundleId === detailKey.bundle);
      const replacement = card && [...card.querySelectorAll<HTMLElement>('button, input, textarea')].find(node =>
        node.tagName === detailKey.tag && node.className === detailKey.cls && (node.getAttribute('aria-label') ?? node.textContent) === detailKey.label);
      replacement?.focus({ preventScroll: true });
    }
  }

  /**
   * The PlayMaker Marks panel (every open mark, Accept all / Reject all) is a whole-document list,
   * so it docks under the Navigator's Issues list (Accord layout stage 3; View › Marks panel).
   */
  private dockPanel(): void {
    const review = this.host.playmaker();
    if (!review) return;
    if (this.dockHost.parentElement !== this.navigator.panes.issues) this.navigator.panes.issues.append(this.dockHost);
    review.dock(this.dockHost);
  }

  /** Marker, Review row or Discuss: an explicit navigation opens the same detail surface. */
  openReviewItem(index: number): void {
    this.host.lineMarks().revealLine(index);
    this.focusLine(index);
    this.navigator.select('issues');
    if (isPhone()) this.openSheet('right');
    else this.setCollapsed('right', false);
    this.renderNow();
    this.navigator.selectLine(index);
  }

  /** View › Marks panel: shows the Navigator on its Issues tab, where the panel lives. */
  showMarksPanel(): void {
    if (isPhone()) return;
    this.navigator.select('issues');
    if (document.body.classList.contains('prw-right-collapsed')) this.setCollapsed('right', false);
  }

  private renderFocus(): void {
    const walk = this.walk!;
    const view = this.view();
    // The blue bar belongs to the selected passage.
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
    this.focusEl.dataset.source = isWriting() ? 'caret' : 'reading';
    // Accord round 2 stage A: the "you are here" look intensified (same hue, no third colour) on
    // the line an edit is open on, so the edit has a visible edge.
    if (isWriting()) this.focusEl.dataset.editing = 'true'; else delete this.focusEl.dataset.editing;
    void walk;
    this.focusEl.style.top = `${Math.round(r.top - c.top - 3)}px`;
    this.focusEl.style.height = `${Math.round(r.height + 6)}px`;
    this.focusEl.style.left = `${Math.round(text.left - c.left - 10)}px`;
    this.focusEl.style.width = `${Math.round(text.width + 20)}px`;
  }

  private renderDynamicStyle(): void {
    const walk = this.walk!;
    const rules: string[] = [];
    const current = walk.marksOn(this.cursorLine())[0];
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
  identityLabel(): string {
    return viewerLabel(this.host.lineMarks().viewerIdentity());
  }

  private renderMe(): void {
    const toolbar = document.querySelector('#share-banner .share-pill-center');
    if (toolbar && this.meEl.parentElement !== toolbar) toolbar.append(this.meEl);
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
      this.meEl.append(badge, el('span', 'prw-me-label', 'Signed in as '), who, el('span', 'prw-me-verified', ' (verified)'));
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
      ? 'You can comment as a guest. Sign in to edit.'
      : 'You are not signed in: your marks show your typed name as a guest, and do not answer asks addressed to a signed-in person.';
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
    this.provisionalEl.hidden = !this.lastError;
    const sig = this.lastError;
    if (this.provisionalEl.dataset.sig === sig) return;
    this.provisionalEl.dataset.sig = sig;
    this.provisionalEl.replaceChildren();
    this.provisionalEl.dataset.state = 'error';
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
    // Keep the box while the reader types in it. A focused button must not freeze the box:
    // Seen, Confirm, and Clear are drawn from the mark that the click just wrote.
    const active = document.activeElement;
    const typing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    if (typing && this.box && (this.boxHost.contains(active) || this.tailHost.contains(active)) && Number(this.boxHost.dataset.line) === focus) return;
    this.boxSig = sig;
    this.boxHost.dataset.line = String(focus);
    // Accord layout stage 3 (decision 8): the Margin's layout — the quote, Agree and Reject, ⋯ More.
    const box = lm.buildMarkBox(line, {
      layout: 'margin',
      canSuggest: this.host.canSuggest() && !isWriting(),
      suggest: () => { if (isPhone()) this.closeSheets(); this.host.suggestChange(focus); },
      discuss: () => this.startThreadHere(),
    });
    const hasAsk = Boolean(lm.askForLine(focus));
    const alts = lm.altSetFor(focus);
    const keys = el('p', 'prw-keys', hasAsk ? 'Y yes · N no · T not yet' : alts ? `1–${alts.options.length} pick · A agree · E explain` : 'A agree · S suggest · T discuss · R reject · J/K move');
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
    const all = new Map(this.pendingMarks().map(mark => [mark.id, mark]));
    // Accord round 2 stage C (a loose end from stage D): "Changes on this line" carries only
    // PROPOSALS. A comment is a thread and it shows once, in Discussion; before this it showed
    // twice on any line that had one, which made the same unsettled thing look like two.
    const onLine = walk.marksOn(focus).filter(item => (all.get(item.id)?.kind ?? 'comment') !== 'comment');
    const lm = this.host.lineMarks();
    const sig = JSON.stringify([focus, onLine.map(m => m.id),
      onLine.map(m => { const mk = all.get(m.id); return mk ? [mk.at, mk.data] : null; }),
      onLine.map(m => lm.notesForMark(m.id).map(n => n.why)),
      onLine.map(m => { const b = lm.bundleForMark(m.id); return b ? [b.bundle.id, b.pending.length, b.stale.join(','), b.status] : null; }),
      this.bundleDecisions.length, this.lastError]);
    if (sig === this.changesSig) return;
    const changesFocus = document.activeElement;
    if ((changesFocus instanceof HTMLInputElement || changesFocus instanceof HTMLTextAreaElement) && this.changesHost.contains(changesFocus)) return;
    this.changesSig = sig;
    this.changesHost.replaceChildren();
    this.changesHost.hidden = onLine.length === 0;
    if (onLine.length === 0) return;
    const head = el('div', 'prw-changes-head');
    head.append(el('strong', undefined, 'Changes on this line'), el('span', 'prw-step', String(onLine.length)));
    this.changesHost.append(head);
    // Step B4e: a bundle on this line shows as one card (title, why, every passage, one decision).
    const shownBundles = new Set<string>();
    for (const item of onLine) {
      const bundle = lm.bundleForMark(item.id);
      if (!bundle || shownBundles.has(bundle.bundle.id)) continue;
      shownBundles.add(bundle.bundle.id);
      this.changesHost.append(this.bundleCard(bundle, all));
    }
    for (const item of onLine) {
      const mark = all.get(item.id);
      if (!mark) continue;
      // Bundled changes are decided on the bundle card (unless it is stale: then one by one).
      const bundle = lm.bundleForMark(item.id);
      if (bundle && bundle.stale.length === 0) continue;
      this.changesHost.append(this.changeCard(mark, {
        current: false,
        passed: false,
      }));
    }
    this.changesHost.append(el('p', 'prw-hint', 'Accept or Reject decides a proposal. Scrolling only records reading.'));
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
      this.changesSig = '';
      this.afterChange();
      return false;
    }
    const ids = view.pending;
    try {
      this.host.decide(ids, action);
      this.lastError = '';
      this.bundleDecisions.push({ id, action, ok: true });
      void lm.recordBundleDecision(id, action === 'accept' ? 'accepted' : 'rejected');
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Could not save the bundle.';
      this.bundleDecisions.push({ id, action, ok: false, error: this.lastError });
    }
    this.changesSig = '';
    this.afterChange();
    return true;
  }

  private changeCard(mark: Mark, flags: { current: boolean; passed: boolean }): HTMLElement {
    const card = el('article', 'prw-card');
    card.dataset.markId = mark.id;
    card.dataset.kind = mark.kind;
    if (flags.current) card.dataset.current = 'true';
    card.style.setProperty('--review-author', getMarkColor(mark.by));
    const who = el('div', 'prw-card-who');
    who.append(el('strong', undefined, this.host.lineMarks().proposalAuthor(mark.by ?? '')), el('span', undefined, mark.kind === 'comment' ? 'Comment' : 'Suggestion'));
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
    const thread = this.host.lineMarks().allThreads().find(view => view.thread.markId === mark.id || view.thread.id === mark.id);
    if (thread) for (const reply of thread.thread.replies) body.append(el('p', 'prw-reply', `${getActorName(reply.by)}: ${reply.text}`));
    if (mark.kind !== 'comment') card.append(el('p', 'amg-thread-closes', 'Closes when: accept or reject'));
    if (thread?.detached) card.append(el('p', 'amg-thread-detached', `The passage was removed. It was about: ${thread.originalQuote}`));
    else if (thread?.changed) card.append(el('p', 'amg-thread-changed', 'The line this is about has been edited since.'));
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

  // --------------------------------------------------------------------------
  // Rails
  // --------------------------------------------------------------------------

  private buildRails(): void {
    // Mike, 2026-09-24, yfbqrau4: documents left, Review right, conversation below the page.
    const noun = productIdentity().documentNounPlural;
    const leftHead = el('div', 'prw-rail-head prw-documents-head');
    const newButton = el('button', 'prw-new', 'New');
    newButton.type = 'button';
    newButton.onclick = () => this.host.newDocument();
    const leftToggle = el('button', 'prw-collapse');
    leftToggle.type = 'button';
    leftToggle.onclick = () => this.toggleRail('left');
    leftHead.append(el('strong', undefined, noun));
    if (ACCORDS_LIST_POLICY.showNew) leftHead.append(newButton);
    leftHead.append(leftToggle);
    const all = el('a', 'prw-all', `All ${noun}`);
    all.href = ACCORDS_LIST_POLICY.allHref;
    this.left.append(leftHead, this.docsBody);
    if (ACCORDS_LIST_POLICY.showAll) this.left.append(all);
    this.documentsToggle.type = 'button';
    this.documentsToggle.textContent = '☰';
    this.documentsToggle.setAttribute('aria-label', `${noun} list`);
    this.documentsToggle.setAttribute('aria-controls', this.left.id);
    this.documentsToggle.onclick = () => this.toggleRailFromMenu('left');

    const rightHead = el('div', 'prw-rail-head anv-head');
    const rightToggle = el('button', 'prw-collapse');
    rightToggle.type = 'button';
    rightToggle.onclick = () => this.toggleRail('right');
    rightHead.append(this.navigator.tabsEl, rightToggle);
    this.rightHeadEl = rightHead;
    this.provisionalEl.hidden = true;
    this.provisionalEl.setAttribute('aria-live', 'polite');
    this.buildRate();
    this.buildStatusBar();
    this.threads = this.buildThreads();
    this.navigator.detailEl.append(this.changesHost, this.threads.element);
    this.right.append(rightHead, this.lineTools, this.provisionalEl, ...Object.values(this.navigator.panes));
    this.right.setAttribute('role', 'complementary');
    this.left.setAttribute('role', 'navigation');
    this.chatSlot.dataset.expanded = String(this.chatExpanded);
    this.buildStripGestures();
    this.renderDocuments();
  }

  private renderDocuments(): void {
    const data = this.documentsList();
    const sig = JSON.stringify(data);
    if (sig === this.docsSig) return;
    this.docsSig = sig;
    const list = el('ul', 'prw-docs');
    for (const doc of data.docs ?? []) {
      const row = el('li');
      const link = el('a', 'prw-doc');
      link.href = `/d/${encodeURIComponent(doc.slug)}`;
      if (doc.current) link.setAttribute('aria-current', 'page');
      link.append(el('span', 'prw-doc-title', doc.title), el('span', 'prw-doc-count', String(doc.count)));
      row.append(link);
      list.append(row);
    }
    this.docsBody.replaceChildren(data.docs?.length ? list : el('p', 'prw-empty', data.message));
  }

  private roomShownListener: (() => void) | null = null;
  onRoomShown(listener: () => void): void { this.roomShownListener = listener; }
  isRoomVisible(): boolean { return this.chatExpanded; }
  openRoom(): void { if (isPhone()) this.closeSheets(); this.setRoomExpanded(true); }
  closeRoom(): void { this.setRoomExpanded(false); }
  private setRoomExpanded(expanded: boolean): void {
    this.chatExpanded = expanded;
    this.chatSlot.dataset.expanded = String(expanded);
    this.roomShownListener?.();
  }

  /** Compatibility for explicit callers: Room expands the conversation; Line opens Review. */
  selectMarginTab(tab: MarginTab): void {
    if (tab === 'room') this.openRoom();
    else this.openReviewItem(this.cursorLine());
  }
  marginTabShown(): MarginTab { return this.chatExpanded ? 'room' : 'line'; }
  private renderMarginTabs(): void { /* The Line and Room tabs no longer render. */ }

  /** After the line's changes: the Familiar's note (folded) and everyone's marks on the line. */
  private renderTail(): void {
    const parts = this.box?.tail ?? [];
    const sig = `${this.boxSig}|${parts.length}`;
    if (sig !== this.tailSig) {
      this.tailSig = sig;
      this.tailHost.replaceChildren(...parts);
      this.tailHost.hidden = parts.length === 0;
    }
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
    this.sbLine.setAttribute('aria-live', 'polite');
    this.sbProvisional.hidden = true;
    const sep = () => { const s = el('span', 'pst-sep'); s.setAttribute('aria-hidden', 'true'); return s; };
    this.sbNotice.hidden = true;
    this.sbNotice.setAttribute('role', 'status');
    this.completionEl.dataset.accordReviewCompleteStatus = '';
    this.completionEl.setAttribute('role', 'status');
    bar.append(this.sbLine, sep(), ...(EDIT_SESSION_POLICY.showMarkProgress ? [this.sbMarked, sep()] : []), this.sbIssues, this.completionEl, this.sbProvisional, this.sbNotice, this.modeEl);
    this.ruleEl.setAttribute('aria-hidden', 'true');
    this.ruleEl.hidden = true;
  }

  private renderStatusBar(): void {
    const walk = this.walk;
    if (!walk) return;
    const lm = this.host.lineMarks();
    const completion = EDIT_SESSION_POLICY.showMarkProgress ? personalCompletionText({ status: lm.participantStatus(), viewer: lm.me(), name: actor => lm.displayName(actor) }) : null;
    this.completionEl.textContent = completion ?? '';
    this.completionEl.hidden = !completion;
    const completionHost = this.touchMode() ? this.strip : this.statusBar;
    if (this.completionEl.parentElement !== completionHost) completionHost.append(this.completionEl);
    const target = this.cursorLine();
    const marked = EDIT_SESSION_POLICY.showMarkProgress && lm.isLoaded() ? lm.markedUpTo() : null;
    const needs = lm.isLoaded() ? lm.needsYouLines().length : null;
    const ago = marked ? formatAgo(marked.at, Date.now()) : '';
    const sig = JSON.stringify([target, walk.lineCount, marked?.line ?? null, ago, needs]);
    if (sig === this.statusSig || this.sbMarked.contains(document.activeElement)) return;
    this.statusSig = sig;
    this.statusBar.dataset.line = String(target);
    const strong = el('b', undefined, `Line ${target + 1}`);
    this.sbLine.replaceChildren(strong, ` of ${walk.lineCount}`);
    this.sbLine.dataset.line = String(target);
    if (!EDIT_SESSION_POLICY.showMarkProgress) { this.sbMarked.replaceChildren(); }
    else if (marked) {
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
    this.sbProvisional.hidden = true;
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
    const marked = EDIT_SESSION_POLICY.showMarkProgress && lm.isLoaded() ? lm.markedUpTo() : null;
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
    this.rateEl.title = 'A line counts as Seen once it has been the focus line for its reading time: its words at this speed (at least 0.25 s, at most 6 s). Lines you scroll past faster stay unmarked.';
  }

  /** Remembered per browser: each rail open or closed, and the tab each shows (layout-panels.ts). */
  private reviewIdentity = '';

  private railState(): RailState {
    try { return parseRailState(localStorage.getItem(reviewStorageKey(this.host.slug() ?? 'local', this.host.lineMarks().me()))); } catch { return {}; }
  }

  private saveRailState(patch: RailState): void {
    const saved = { ...this.railState(), ...patch };
    try { localStorage.setItem(reviewStorageKey(this.host.slug() ?? 'local', this.host.lineMarks().me()), JSON.stringify(saved)); } catch { /* optional */ }
  }

  private applyRailState(): void {
    const saved = this.railState();
    this.navigator.select(saved.reviewTab ?? saved.leftTab ?? NAVIGATOR_POLICY.defaultTab, false);
    // Mike, 2026-09-24: the documents list defaults closed below 1100; Review defaults open.
    const wide = window.innerWidth >= ACCORDS_LIST_POLICY.closedBelowPx;
    const leftCollapsed = saved.left ?? !wide;
    const rightCollapsed = saved.right ?? !OPEN_ITEMS_POLICY.defaultOpen;
    document.body.classList.toggle('prw-left-collapsed', leftCollapsed);
    document.body.classList.toggle('prw-right-collapsed', rightCollapsed);
    this.navigator.setPanelOpen((!rightCollapsed && !isPhone()) || this.right.classList.contains('prw-sheet-open'));
    this.updateToggleLabels();
  }

  private setCollapsed(side: 'left' | 'right', collapsed: boolean): void {
    this.saveRailState({ [side]: collapsed } as RailState);
    if (side === 'right') this.navigator.setPanelOpen(!collapsed);
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
    this.documentsToggle.setAttribute('aria-expanded', String(this.railShown('left')));
    for (const [side, rail] of [['left', this.left], ['right', this.right]] as const) {
      const btn = rail.querySelector('.prw-collapse') as HTMLButtonElement | null;
      if (!btn) continue;
      const collapsed = document.body.classList.contains(`prw-${side}-collapsed`);
      const name = side === 'left' ? `${productIdentity().documentNounPlural} list` : 'Review panel';
      if (phone) { btn.textContent = '×'; btn.setAttribute('aria-label', `Close the ${name}`); btn.removeAttribute('aria-expanded'); continue; }
      btn.textContent = side === 'left' ? (collapsed ? '»' : '«') : (collapsed ? '«' : '»');
      btn.setAttribute('aria-label', `${collapsed ? 'Show' : 'Hide'} the ${name}`);
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
    this.saveRailState({ [side]: false });
    if (side === 'right') this.navigator.setPanelOpen(true);
    this.updateToggleLabels();
    this.renderNow();
    if (options.more) this.box?.openMore?.();
    else (rail.querySelector('.prw-collapse') as HTMLButtonElement | null)?.focus({ preventScroll: true });
  }

  closeSheets(): void {
    for (const [side, rail] of [['left', this.left], ['right', this.right]] as const) {
      if (rail.classList.contains('prw-sheet-open')) this.saveRailState({ [side]: true });
    }
    if (this.right.classList.contains('prw-sheet-open')) this.navigator.setPanelOpen(false);
    this.left.classList.remove('prw-sheet-open');
    this.right.classList.remove('prw-sheet-open');
    document.body.classList.remove('prw-margin-sheet');
    if (this.strip.parentElement !== document.body && this.started) document.body.append(this.strip);
    this.updateToggleLabels();
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
    this.renderDocuments();
  }

  // --------------------------------------------------------------------------
  // Test hook
  // --------------------------------------------------------------------------

  debugState(): Record<string, unknown> {
    const walk = this.walk;
    return {
      ready: Boolean(walk && this.tops.length),
      focus: walk ? this.cursorLine() : -1,
      readingFocus: walk?.focus ?? -1,
      target: walk ? this.targetLine() : -1,
      cursor: walk ? this.cursorLine() : -1,
      chatExpanded: this.chatExpanded,
      navigator: this.navigator.debugState(),
      replies: [],
      sheet: this.right.classList.contains('prw-sheet-open') ? 'review' : this.left.classList.contains('prw-sheet-open') ? 'documents' : null,
      touch: this.touchMode(),
      strip: this.strip.hidden ? null : { line: Number(this.strip.dataset.line), status: this.strip.dataset.status ?? '' },
      lines: walk?.lineCount ?? 0,
      step: 0,
      current: walk?.marksOn(this.cursorLine())[0]?.id ?? null,
      marksOnFocus: walk?.marksOn(this.cursorLine()).map(m => m.id) ?? [],
      seenWrites: [...this.seenWrites],
      skimmed: [],
      rate: walk?.readingRate ?? null,
      dwellMs: walk ? walk.dwellFor(walk.focus) : null,
      flagged: [...this.host.lineMarks().flaggedLineSet()],
      whyAsked: [...this.whyAsked],
      explained: [...this.explained],
      bundleDecisions: [...this.bundleDecisions],
      readingY: this.readingY(),
      // Stage B: the scroll camera. `band` is the dead zone in viewport y; `offset` is null while
      // the reading line is still the default (the first line's place).
      camera: { view: this.cameraView(), band: deadZone(this.cameraView()), offset: this.readingOffset },
      tops: [...this.tops],
      heights: [...this.heights],
      constants: READING_WALK,
      error: this.lastError,
      writing: isWriting(),
      mode: this.modeEl.dataset.mode ?? null,
      modeText: this.modeEl.textContent ?? '',
      editing: isWriting(),
      notice: this.sbNotice.hidden ? '' : (this.sbNotice.textContent ?? ''),
      doneVisible: Boolean(this.boxHost.querySelector('.plm-suggest')),
      statusBar: { line: this.sbLine.textContent, marked: this.sbMarked.textContent, issues: this.sbIssues.dataset.count === '' ? null : Number(this.sbIssues.dataset.count), provisional: 0 },
      rule: this.ruleEl.hidden ? null : Number(this.ruleEl.dataset.line),
      rail: this.railFollow?.debugState() ?? null,
    };
  }
}
