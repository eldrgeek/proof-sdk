/**
 * Line marks target the selected passage. Explicit section agreement captures text identities,
 * and it is offered only when every line of the section is visible.
 * Mike, 2026-09-23 (usability brief).
 *
 * Authorship: spec by Mike Wolf (2026-09-18); built by Claude Opus 5 (worker proof-line-marks).
 *
 * - A dot in the left margin of every line shows the viewer's own mark; small pips beside it
 *   show other team members' marks. Click (or tap) the dot to mark the line.
 * - Desktop: a small menu next to the dot. Phones (< 700 px): a bottom sheet.
 * - The top bar shows "N issues" (or "Aligned") and a Next issue button.
 * The overlay sits outside ProseMirror's DOM, so it never enters the text or the Yjs document.
 */
import type { EditorView } from '@milkdown/kit/prose/view';
import type { EditorState } from '@milkdown/kit/prose/state';
import {
  LINE_MARK_POLICY,
  STATEMENT_POLICY,
  dwellMarkFor,
  isOthersStatement,
  actorKey,
  actorLabel,
  anchorForLine,
  buildLineStates,
  computeIssues,
  computeStep1Team,
  extractLines,
  isAiActor,
  PASSIVE_VIAS,
  registerActorLabels,
  type DocLine,
  type IssueSummary,
  type LineMark,
  type LineMarkStatus,
  type LineSourceNode,
  type LineState,
  type MarkVia,
  type ProofIssue,
  type ReviewMarkLike,
} from '../shared/line-marks';
import { classifyLineChange } from '../shared/line-change';
import type { SinceYouReport } from '../shared/alignment';
import { FOLDING, planSectionMark, resolveSectionScope, type SectionAgreementOffer, type SectionScope } from '../shared/folding';
import { UndoStack, conflictRefusal, describeLineMark, type UndoOutcome } from '../shared/undo';
import { ANYONE, askIssueInputs, askTeamActors, evaluateAsks, type AskChoice, type AskView, type ProofAsk } from '../shared/asks';
import { askViewKey, setAskDecorations, type AskDecorationSpec } from '../editor/plugins/ask-view';
import { askControlSignature, buildAskControl, buildAskTag, type AskControl } from './asks';
import { doIssueInputs, doTeamActors, evaluateDos, type DoView, type ProofDo } from '../shared/do';
import { doViewKey, setDoDecorations, type DoDecorationSpec } from '../editor/plugins/do-view';
import { buildDoControl, buildDoTag, doControlSignature } from './do';
import { setLineMarksViewListener, peekPendingLocalLineEdits, takePendingLocalLineEdits } from '../editor/plugins/line-marks-view';
import { EMPTY_DIRECTORY, actorTrust, isGuestActor, normalizeActorString, resolveTargetActor, type IdentityDirectory, type ViewerIdentity } from '../shared/identity';
import {
  PRIORITY_LABEL,
  REJECT_CHIPS,
  SITTING_BUDGET,
  UNCERTAIN_POLICY,
  evaluateFlags,
  explicitPriorityLookup,
  flaggedLines,
  nextRankedIssue,
  noteLineIndex,
  rankIssues,
  rejectChipsFor,
  sittingSummary,
  uncertainIssueInputs,
  type FlagView,
  type RankedIssue,
  type ReviewNote,
  type SittingSummary,
  type UncertainFlag,
} from '../shared/review-aids';
import {
  OBJECTION_POLICY,
  ackFor,
  describeObjection,
  evaluateObjections,
  objectedLines,
  objectionIssueInputs,
  type ObjectionView,
  type ProofObjection,
} from '../shared/objections';
import { bundleIndex, describeBundle, evaluateBundle, type BundleView, type MemberState, type ProofBundle } from '../shared/bundles';
import { ALT_POLICY, altLineIndex, alternativeIssueInputs, describeAltSet, evaluateAlternatives, pickOf, type AltPick, type AltSetView, type ProofAlternative } from '../shared/alternatives';
import { disagreementCounts, disagreementLines } from '../shared/blind';
import { EXPLAIN_POLICY, explainCommentText, termLinksFor, type TermUse } from '../shared/explain';
import { TTL_POLICY, applyDecay, describeTtl, evaluateTtls, ttlIssueInputs, type ProofTtl, type TtlView } from '../shared/ttl';
import { proofExtrasViewKey, setProofExtrasDecorations, termRange, type AltStackSpec, type TermLinkSpec } from '../editor/plugins/proof-extras-view';
// Accord round 2, stage D: threads. A thread, a comment, a suggestion and the `?` clarify request
// are ONE object; src/shared/threads.ts reads the ones already on a document without a migration.
import {
  THREAD_ASK_LABEL, anchorsForThread, evaluateThreads, openThreadsFor, threadsByLine,
  type ThreadAsks, type ThreadMeta, type ThreadSourceMark, type ThreadStatus, type ThreadView,
} from '../shared/threads';
import {
  PROXY_POLICY,
  evaluateProxies,
  familiarInitial,
  flaggedWhy,
  heldLines,
  humanIssueLines,
  isClaimedMark,
  capPassiveRead,
  EVIDENCE_POLICY,
  type FamiliarBinding,
  type ProxyBrief,
  type ProxyItem,
  type ProxyMark,
} from '../shared/proxy-marks';
import {
  TIER_POLICY,
  aiReadsFromMarks,
  evaluateTiers,
  flippedTier,
  tierIssueInput,
  type LineTier,
  type TierEvaluation,
  type TierFlag,
  type TierRead,
  type TierRecord,
  type TierView,
} from '../shared/line-tiers';
import { tierViewKey, setTierDecorations, tierDecorationCount, type TierLineSpec } from '../editor/plugins/tier-view';
import { buildTierRow, loadOnlyDecisions, renderTierControl, saveOnlyDecisions } from './line-tiers';
import { HIGHLIGHT_POLICY, issueNeedsViewer, markedUpTo, type MarkedUpTo } from '../shared/layout-status';
import { openView, type OpenView } from '../shared/open-view';
import { MARGIN_POLICY, MARKED_BY_POLICY, markedByFold, type NeedsYouItem } from '../shared/layout-panels';
import { READING_MODE_POLICY } from '../shared/reading-keys';
import { ISSUES_PILL_POLICY, NEXT_ISSUE_POLICY, issuesPillText, issuesPillTitle } from '../shared/layout-chrome';
import './line-marks.css';

export interface LineMarksHost {
  /** Review navigation follows the panel scope and document order. */
  nextReview?(): void;
  slug(): string | null;
  apiBase(): string;
  authHeaders(): Record<string, string>;
  actor(): string;
  canComment(): boolean;
  reviewMarks(view: EditorView): ReviewMarkLike[];
  /** Step 1b: a click on a margin dot. Return true when the reading walk took it (no popover). */
  onDotActivate?(lineIndex: number): boolean;
  /** Step 1b: Next issue moves the focus line. Return true when the reading walk scrolled there. */
  focusLine?(lineIndex: number): boolean;
  /** Step 1b: every editor view update (cursor, marks, text), after this UI has handled it. */
  viewUpdated?(): void;
  /** Text identities listed by the explicit section agreement action. */
  sectionScope?(lineIndex: number): SectionScope | null;
  /**
   * Agree is present only when `allVisible`. Otherwise the button expands the collapsed
   * sections inside this one. `scope` is captured at render time. Mike, 2026-09-23 (usability brief).
   */
  sectionAgreement?(lineIndex: number): (SectionAgreementOffer & { scope: SectionScope | null }) | null;
  /** Expands the collapsed sections inside this heading so the reader can see every line. */
  showSectionLines?(lineIndex: number): void;
  /** Step B2: unfold whatever hides a line. Returns true when something unfolded. */
  revealLine?(lineIndex: number): boolean;
  /** Step B4d: the line a shift-click range starts from (the reading walk's focus line). */
  anchorLine?(): number;
  /** Step B4c: the sitting budget was used when the reader asked for the next issue. */
  onBudgetReached?(summary: SittingSummary): void;
  /**
   * Step B4f: posts a comment thread on a line (Explain) through the editor. Returns the new
   * comment's id, or null when the editor could not place it.
   */
  commentOnLine?(line: DocLine, text: string): string | null;
  /** Step B7: how many chat messages point at each line (the margin's speech bubbles). */
  chatCounts?(): Map<number, number>;
  /** Step B7: a speech bubble in the margin was clicked. */
  onChatBubble?(lineIndex: number): void;
  /** Editing first (2026-09-19): who wrote the text in [from, to) (the editor's authored marks). */
  authorsOfRange?(from: number, to: number): string[];
  /** Editing first: true while the editor is in Suggesting mode (edits become suggestions). */
  isSuggesting?(): boolean;
  /**
   * Accord round 2 stage A: the margin's pencil. Puts the caret in the line and starts editing.
   * Option+click still works as the shortcut; this is the affordance it never had.
   */
  startEditingLine?(lineIndex: number): boolean;
  /** The line the cursor is on (the pencil shows there only). */
  cursorLine?(): number;
}

export interface MarkBoxOptions {
  /** Called after the viewer chose a mark (the popover closes itself; the rail stays). */
  onChosen?(status: StatusChoice): void;
  /**
   * Accord layout stage 3 (decision 8): 'margin' is the Margin's Line tab — the quote, Agree and
   * Reject as the two primary buttons, and ⋯ More holding Approve, Seen, Clear my mark, Flag
   * uncertain, Offer another wording, Explain, Time-to-live and the tier. The Familiar's note and
   * everyone's marks come back separately in `tail`. 'full' (the default) is the popover and the
   * phone's dot sheet, unchanged.
   */
  layout?: 'full' | 'margin';
}

export interface MarkBox {
  root: HTMLElement;
  /** Shows the one-line reason field (R). */
  openReason(): void;
  /** Sets a status as if its button was pressed (A). Returns false when marking is not allowed. */
  choose(status: StatusChoice, via?: MarkVia): boolean;
  /** Step B3: the line's ask control, when the line carries an ask (Y / N / T). */
  ask?: AskControl;
  /** Step B4d: the lines a Reject from this box covers (the selection, or the line). */
  scope?: number[];
  /** Line tiers: flips the line's tier (D). Returns false when tagging is not allowed. */
  flipTier?(): boolean;
  /** Margin layout: what goes after the line's changes (the Familiar's note, folded; everyone's marks). */
  tail?: HTMLElement[];
  /** Margin layout: shows ⋯ More. */
  openMore?(): void;
  /** Margin layout: shows or hides ⋯ More (the phone strip's ⋯ while the sheet is open). */
  toggleMore?(): void;
}

export type StatusChoice = LineMarkStatus | 'unseen';

/** Step B4f: statuses the page shows that are not stored (hidden = blind; stale = TTL ran out). */
type ShownStatus = StatusChoice | 'changed' | 'hidden' | 'stale';

const STATUS_LABEL: Record<StatusChoice, string> = {
  unseen: 'Unseen',
  seen: 'Seen',
  agreed: 'Agreed',
  approved: 'Approved',
  rejected: 'Rejected',
  skimmed: 'Skimmed',
};
const STATUS_GLYPH: Record<StatusChoice | 'changed', string> = {
  unseen: '',
  seen: '•',
  agreed: '✓',
  approved: '★',
  rejected: '✕',
  changed: '!',
  // Step B3b: a hollow dot (drawn by CSS: the ring, no fill).
  skimmed: '',
};
/** Step B3b: how a mark was earned, as the rail says it. */
const VIA_LABEL: Record<MarkVia, string> = {
  dwell: 'by scrolling',
  click: 'marked',
  key: 'marked with a key',
  section: 'with its section',
  ask: 'by answering the ask',
  api: 'through the API',
  edit: 'by changing it',
  correct: 'by correcting it',
  proxy: 'ratified from your Familiar',
};
const POLL_MS = 4000;
/** Step B3c: while the page stays aligned with nothing new, re-ask the server at most this often. */
const ALIGN_RECHECK_MS = 15000;
const RESTAMP_IDLE_MS = 1200;
const PHONE_QUERY = '(max-width: 700px)';

function isPhone(): boolean {
  try { return window.matchMedia(PHONE_QUERY).matches; } catch { return window.innerWidth <= 700; }
}

export class LineMarksUI {
  readonly bannerEl = document.createElement('span');
  private readonly countEl = document.createElement('span');
  private readonly nextBtn = document.createElement('button');
  /** Step B3c: "Aligned as of <time>" / "Last aligned <time>", a link to the snapshot's ledger. */
  private readonly alignedEl = document.createElement('button');
  private readonly gutter = document.createElement('div');
  private view: EditorView | null = null;
  private lines: DocLine[] = [];
  private linesDoc: unknown = null;
  private serverMarks: LineMark[] = [];
  /** Step B3: asks from the server (with every answer) and their evaluation against the lines. */
  private serverAsks: ProofAsk[] = [];
  private askViews: AskView[] = [];
  private askDecoSig = '';
  private askDecoQueued = false;
  /** `{do}` action lines from the server (approvals, runs) and their evaluation against the lines. */
  private serverDos: ProofDo[] = [];
  private doViews: DoView[] = [];
  private doDecoSig = '';
  private doDecoQueued = false;
  /** Test hook: approvals / revocations this page saved. */
  private doWrites = 0;
  private owners: string[] = [];
  private agentKeyActors: string[] = [];
  /** Step B4c/B4d: flags, AI review notes and open objections from the server, evaluated here. */
  private serverFlags: UncertainFlag[] = [];
  private serverNotes: ReviewNote[] = [];
  private serverObjections: ProofObjection[] = [];
  private flagViews: FlagView[] = [];
  private flagsByLine = new Map<number, UncertainFlag[]>();
  private objectionViews: ObjectionView[] = [];
  private objectionsByLine = new Map<number, ObjectionView[]>();
  /** Polish pass: the viewer's own open / close of a line's "Marked by N" fold, by line index. */
  private teamFoldChoice = new Map<number, boolean>();
  private reviewMarkCache: ReviewMarkLike[] = [];
  /** Step B4c: this viewer's Issues in priority order (then document order). */
  private ranked: RankedIssue[] = [];
  /** Step B4d: lines selected in the margin (shift-click) for a Reject that covers several lines. */
  private selection: number[] = [];
  /** Step B4c: the sitting (Issues visited with Next issue) and its budget. */
  private sittingVisited = new Set<string>();
  private sittingStopped = false;
  private budget = loadBudget();
  private lastIssueKey: string | null = null;
  private lastIssuePlace: { priority: number; pos: number } | null = null;
  /** Step B4c: the "This sitting" setting and its status, shown in the reading rail. */
  readonly budgetEl = document.createElement('div');
  /** Step B4f: blind marking (an Owner's switch, everyone's notice), shown in the reading rail. */
  readonly blindEl = document.createElement('div');
  /** Steps B4e + B4f: bundles, alternatives and picks, settings, Explain threads, times-to-live. */
  private serverBundles: ProofBundle[] = [];
  private serverAlternatives: ProofAlternative[] = [];
  private serverAltHistory: ProofAlternative[] = [];
  private serverPicks: AltPick[] = [];
  private serverExplains: Array<{ id: string; by: string; commentMarkId: string | null; question: string; createdAt: string }> = [];
  /** Accord stage D: thread rows stored beside the document (what would close each, and its anchor). */
  private serverThreads: ThreadMeta[] = [];
  private threadViews: ThreadView[] = [];
  private threadsAtLine = new Map<number, ThreadView[]>();
  /** Test hook: threads this page started, newest last. */
  readonly startedThreads: Array<{ id: string; lines: number[]; asks: ThreadAsks }> = [];
  private serverTtls: ProofTtl[] = [];
  private blind = false;
  private blindInfo: { revealedLines?: number[]; hiddenPositions?: number } | null = null;
  /** Server clock minus this browser's clock (expiry is judged on the server's clock). */
  private clockSkewMs = 0;
  private bundleViews: BundleView[] = [];
  private altViews: AltSetView[] = [];
  private altsByLine = new Map<number, AltSetView>();
  private ttlViews: TtlView[] = [];
  private ttlByLine = new Map<number, TtlView>();
  private disagreement = new Set<number>();
  private termLinks: TermUse[] = [];
  private extrasDecoSig = '';
  private extrasDecoQueued = false;
  private extrasWrites = 0;
  /** Familiar proxy marks: my binding, my Familiar's proxies, my undoable ratifications. */
  private serverFamiliar: FamiliarBinding | null = null;
  private serverProxies: ProxyMark[] = [];
  private serverRatifications: Array<{ id: string; at: string; count: number; familiar: string }> = [];
  /** The names people gave the AIs present ("Add agent"): ai:<slug> -> "Claude COS". */
  private agentKeyLabels: Record<string, string> = {};
  /** Cross invitation: who added each AI and what runs it: ai:<slug> -> { sponsorName, runtime }. */
  private agentSponsors: Record<string, { label: string; sponsorName: string | null; runtime: string | null; suspended: boolean }> = {};
  private brief: ProxyBrief | null = null;
  private briefByLine = new Map<number, ProxyItem>();
  /** "Review the F flagged": Next issue walks only these lines (document order) until done. */
  private walkOnly: { lines: number[]; visited: number[] } | null = null;
  /** Test hook: familiar / ratify / undo requests this page made. */
  private proxyWrites: Array<{ kind: string; ok: boolean; status: number }> = [];
  /** Line tiers: every tag (history; newest wins), the AI reads and Familiar flags that cover context lines. */
  private serverTiers: TierRecord[] = [];
  private serverTierSignals: { reads: TierRead[]; flags: TierFlag[] } = { reads: [], flags: [] };
  private tierEval: TierEvaluation | null = null;
  /** Lines with an Issue that concerns this viewer (a context line outside this set is skippable). */
  private myIssueLines = new Set<number>();
  /** "Show only decisions" (per browser, view only). */
  private onlyDecisions = loadOnlyDecisions();
  private tierFolded = new Set<number>();
  private tierDecoSig = '';
  private tierDecoQueued = false;
  /** Test hook: tier requests this page made. */
  private tierWrites: Array<{ tier: LineTier; lines: number[]; ok: boolean }> = [];
  /** Line tiers: the rail control (counts and "Show only decisions"). */
  readonly tierEl = document.createElement('div');
  /** Step B6: who the server says this viewer is, and the directory that reads names. */
  private serverMe: ViewerIdentity | null = null;
  private directory: IdentityDirectory = EMPTY_DIRECTORY;
  private canApprove = false;
  private canMark = true;
  private loaded = false;
  private summary: IssueSummary | null = null;
  /** Accord layout stage 1: the lines that need the viewer (one amber dot each), in document order. */
  private needsYou: readonly number[] = [];
  /** Accord round 2 stage C: the one definition of Open, computed once per recompute. */
  private open: OpenView = { items: [], lines: [], count: 0 };
  private needsYouSet = new Set<number>();
  private states: LineState[] = [];
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private renderQueued = false;
  private restampTimer: ReturnType<typeof setTimeout> | null = null;
  private fetchSeq = 0;
  private writesInFlight = 0;
  private menu: HTMLElement | null = null;
  private menuCleanup: (() => void) | null = null;
  private started = false;
  private resizeObserver: ResizeObserver | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly host: LineMarksHost) {
    this.bannerEl.className = 'plm-issues';
    this.countEl.className = 'plm-issues-count';
    this.countEl.setAttribute('role', 'status');
    this.countEl.setAttribute('aria-live', 'polite');
    this.nextBtn.type = 'button';
    this.nextBtn.className = 'plm-next';
    const long = document.createElement('span'); long.className = 'plm-next-long'; long.textContent = 'Next issue';
    const short = document.createElement('span'); short.className = 'plm-next-short'; short.textContent = '…';
    this.nextBtn.append(long, short);
    this.nextBtn.onclick = () => this.gotoNextIssue();
    this.alignedEl.type = 'button';
    this.alignedEl.className = 'plm-aligned-at';
    this.alignedEl.hidden = true;
    this.alignedEl.onclick = () => { if (this.snapshot) void this.openLedger(this.snapshot.id); };
    this.bannerEl.append(this.countEl, this.nextBtn, this.alignedEl);
    this.gutter.className = 'plm-gutter';
    this.gutter.setAttribute('aria-label', 'Line marks');
    this.gutter.addEventListener('click', this.onGutterClick);
    this.budgetEl.className = 'plm-budget';
    this.renderBanner();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    setLineMarksViewListener({
      update: (view, prevState) => this.onViewUpdate(view, prevState),
    });
    document.body.classList.add('plm-on');
    this.loadSitting();
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('resize', this.queueRender);
    document.addEventListener('click', this.onTermClick);
    void this.refresh();
    this.schedulePoll();
  }

  stop(): void {
    this.started = false;
    document.body.classList.remove('plm-on');
    setLineMarksViewListener(null);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('resize', this.queueRender);
    document.removeEventListener('click', this.onTermClick);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.closeMenu();
    this.resizeObserver?.disconnect();
    this.gutter.remove();
  }

  /** Step B7: chat messages arrived or were sent (the margin's speech bubbles follow them). */
  notifyChatChanged(): void {
    this.queueRender();
  }

  /** A room broadcast or event said line marks changed somewhere. */
  notifyRemoteChange(): void {
    void this.refresh();
  }

  // --------------------------------------------------------------------------
  // Data
  // --------------------------------------------------------------------------

  async refresh(): Promise<void> {
    const slug = this.host.slug();
    if (!slug) return;
    const seq = ++this.fetchSeq;
    try {
      // Step B4f: a guest names itself so blind marking can reveal its own lines.
      const guest = this.serverMe?.actor ? '' : `?by=${encodeURIComponent(this.me())}`;
      const response = await fetch(`${this.host.apiBase()}/documents/${encodeURIComponent(slug)}/line-marks${guest}`, {
        headers: this.host.authHeaders(),
        credentials: 'same-origin',
      });
      if (!response.ok) return;
      const body = await response.json() as {
        lineMarks?: LineMark[]; owners?: string[]; agentKeyActors?: string[]; asks?: ProofAsk[];
        flags?: UncertainFlag[]; reviewNotes?: ReviewNote[]; objections?: ProofObjection[];
        bundles?: ProofBundle[]; alternatives?: ProofAlternative[]; alternativeHistory?: ProofAlternative[]; picks?: AltPick[];
        settings?: { blind?: boolean }; explains?: LineMarksUI['serverExplains']; ttls?: ProofTtl[]; serverNow?: string; dos?: ProofDo[];
        threads?: ThreadMeta[];
        blind?: { revealedLines?: number[]; hiddenPositions?: number };
        viewer?: { canApprove?: boolean; canMark?: boolean };
        identity?: { me?: ViewerIdentity; directory?: IdentityDirectory };
        alignedSnapshot?: { id: string; createdAt: string } | null;
        familiar?: FamiliarBinding | null; proxies?: ProxyMark[]; ratifications?: LineMarksUI['serverRatifications'];
        agentKeyLabels?: Record<string, string>;
        agentSponsors?: Record<string, { label: string; sponsorName: string | null; runtime: string | null; suspended: boolean }>;
        tiers?: TierRecord[]; tierSignals?: { reads?: TierRead[]; flags?: TierFlag[] };
      };
      // A newer fetch or a local write superseded this answer.
      if (seq !== this.fetchSeq || this.writesInFlight > 0) return;
      this.serverMarks = Array.isArray(body.lineMarks) ? body.lineMarks : [];
      this.serverAsks = Array.isArray(body.asks) ? body.asks : [];
      this.serverFlags = Array.isArray(body.flags) ? body.flags : [];
      this.serverNotes = Array.isArray(body.reviewNotes) ? body.reviewNotes : [];
      this.serverObjections = Array.isArray(body.objections) ? body.objections : [];
      this.serverBundles = Array.isArray(body.bundles) ? body.bundles : [];
      this.serverAlternatives = Array.isArray(body.alternatives) ? body.alternatives : [];
      this.serverAltHistory = Array.isArray(body.alternativeHistory) ? body.alternativeHistory : [];
      this.serverPicks = Array.isArray(body.picks) ? body.picks : [];
      this.serverExplains = Array.isArray(body.explains) ? body.explains : [];
      this.serverThreads = Array.isArray(body.threads) ? body.threads : [];
      this.serverTtls = Array.isArray(body.ttls) ? body.ttls : [];
      this.serverDos = Array.isArray(body.dos) ? body.dos : [];
      this.blind = body.settings?.blind === true;
      this.blindInfo = body.blind ?? null;
      const serverNow = body.serverNow ? Date.parse(body.serverNow) : NaN;
      if (Number.isFinite(serverNow)) this.clockSkewMs = serverNow - Date.now();
      this.owners = Array.isArray(body.owners) ? body.owners : [];
      this.agentKeyActors = Array.isArray(body.agentKeyActors) ? body.agentKeyActors : [];
      this.canApprove = body.viewer?.canApprove === true;
      this.canMark = body.viewer?.canMark !== false;
      const directory = body.identity?.directory;
      this.directory = directory && typeof directory === 'object'
        ? { merges: directory.merges ?? {}, names: directory.names ?? {}, labels: directory.labels ?? {} }
        : EMPTY_DIRECTORY;
      registerActorLabels(this.directory.labels);
      this.serverMe = body.identity?.me ?? null;
      this.serverFamiliar = body.familiar && typeof body.familiar.familiar === 'string' ? body.familiar : null;
      this.serverProxies = Array.isArray(body.proxies) ? body.proxies : [];
      this.serverRatifications = Array.isArray(body.ratifications) ? body.ratifications : [];
      this.agentKeyLabels = body.agentKeyLabels && typeof body.agentKeyLabels === 'object' ? body.agentKeyLabels : {};
      this.agentSponsors = body.agentSponsors && typeof body.agentSponsors === 'object' ? body.agentSponsors : {};
      this.serverTiers = Array.isArray(body.tiers) ? body.tiers : [];
      this.serverTierSignals = {
        reads: Array.isArray(body.tierSignals?.reads) ? body.tierSignals!.reads! : [],
        flags: Array.isArray(body.tierSignals?.flags) ? body.tierSignals!.flags! : [],
      };
      this.snapshot = body.alignedSnapshot && typeof body.alignedSnapshot.id === 'string' ? body.alignedSnapshot : null;
      this.loaded = true;
      this.recompute();
    } catch {
      // Offline or server restarting: the next poll retries.
    }
  }

  private schedulePoll(): void {
    if (!this.started) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (document.visibilityState === 'visible') void this.refresh();
      this.schedulePoll();
    }, POLL_MS);
  }

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') void this.refresh();
  };

  private async writeMark(line: DocLine, status: StatusChoice, reason?: string, via: MarkVia = 'click'): Promise<boolean> {
    const slug = this.host.slug();
    if (!slug) return false;
    // The one Undo (Mike, 2026-09-19): every deliberate mark is undoable. Passive reads (dwell,
    // a section sweep, a Familiar's proxy) and marks carried over an edit are not actions.
    if (!PASSIVE_VIAS.has(via) && via !== 'edit' && via !== 'correct') this.recordMarkUndo(line, status, reason, via);
    const by = this.me();
    const me = actorKey(by);
    const state = this.states[line.index];
    const replaceIds = state ? [...state.marks.values()].filter(e => actorKey(e.mark.by) === me).map(e => e.mark.id) : [];
    const anchor = anchorForLine(line);
    // Optimistic: show the new mark at once.
    const previous = this.serverMarks;
    this.serverMarks = this.serverMarks.filter(mark => !replaceIds.includes(mark.id)
      && !(actorKey(mark.by) === me && mark.anchor.hash === anchor.hash && mark.anchor.occurrence === anchor.occurrence));
    if (status !== 'unseen') {
      this.serverMarks.push({ id: `local-${Date.now()}`, by, status, reason: reason ?? null, at: new Date().toISOString(), anchor, via });
    }
    this.recompute();
    this.writesInFlight += 1;
    try {
      const response = await fetch(`${this.host.apiBase()}/documents/${encodeURIComponent(slug)}/line-marks`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...this.host.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ by, status, reason, via, anchor, replaceIds: replaceIds.filter(id => !id.startsWith('local-')) }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        this.serverMarks = previous;
        this.recompute();
        this.toast(body.error || 'Could not save the mark');
        return false;
      }
      return true;
    } catch {
      this.serverMarks = previous;
      this.recompute();
      this.toast('Could not save the mark (offline?)');
      return false;
    } finally {
      this.writesInFlight -= 1;
      this.fetchSeq += 1;
      void this.refresh();
    }
  }

  // --------------------------------------------------------------------------
  // Editor updates and computation
  // --------------------------------------------------------------------------

  private onViewUpdate(view: EditorView, prevState: EditorState | null): void {
    if (this.view !== view) {
      this.view = view;
      this.attachGutter();
    }
    if (!prevState || prevState.doc !== view.state.doc || this.linesDoc !== view.state.doc) {
      this.recompute();
    } else {
      this.queueRender();
    }
    // Debounce on document changes only: cursor and presence updates also reach here and
    // must not keep postponing the restamp.
    const docChanged = !prevState || prevState.doc !== view.state.doc;
    if (LINE_MARK_POLICY.changerKeepsMark && peekPendingLocalLineEdits().length > 0 && (docChanged || !this.restampTimer)) {
      if (this.restampTimer) clearTimeout(this.restampTimer);
      this.restampTimer = setTimeout(() => this.restampOwnEdits(), RESTAMP_IDLE_MS);
    }
    this.host.viewUpdated?.();
  }

  private attachGutter(): void {
    const view = this.view;
    if (!view) return;
    const container = (view.dom.closest('#editor-container') as HTMLElement | null)
      ?? (view.dom.closest('#editor') as HTMLElement | null)?.parentElement
      ?? view.dom.parentElement;
    if (!container) return;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    if (this.gutter.parentElement !== container) container.append(this.gutter);
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(this.queueRender);
    this.resizeObserver.observe(view.dom);
  }

  private recompute(): void {
    const view = this.view;
    if (view) {
      if (this.linesDoc !== view.state.doc) {
        this.lines = extractLines(view.state.doc as unknown as LineSourceNode);
        this.linesDoc = view.state.doc;
      }
      // Steps B4e + B4f: an Explain thread is not an Issue; a bundled suggestion names its bundle.
      const explainIds = new Set(this.serverExplains.map(e => e.commentMarkId).filter((id): id is string => Boolean(id)));
      const bundleOf = bundleIndex(this.serverBundles);
      const reviewMarks = this.host.reviewMarks(view).map(mark => {
        const explain = !EXPLAIN_POLICY.commentIsIssue && explainIds.has(mark.id);
        const bundleId = bundleOf.get(mark.id);
        return explain || bundleId ? { ...mark, ...(explain ? { explain: true } : {}), ...(bundleId ? { bundleId } : {}) } : mark;
      });
      this.reviewMarkCache = reviewMarks;
      const team = computeStep1Team({
        owners: this.owners,
        lineMarks: this.serverMarks,
        reviewMarks,
        agentKeyActors: this.agentKeyActors,
        extra: [this.me(), ...askTeamActors(this.serverAsks), ...this.serverFlags.map(f => f.by), ...this.serverObjections.map(o => o.by),
          ...this.serverAlternatives.map(a => a.by), ...this.serverTtls.map(t => t.by), ...doTeamActors(this.serverDos)],
        identity: { target: actor => resolveTargetActor(actor, this.directory) },
      });
      this.states = buildLineStates(this.lines, this.serverMarks);
      // Step B4f: alternatives, times-to-live (judged on the server's clock), disagreement.
      this.altViews = evaluateAlternatives(this.serverAlternatives, this.serverPicks, this.lines, team);
      this.altsByLine = new Map(this.altViews.map(v => [v.lineIndex, v]));
      this.ttlViews = evaluateTtls(this.serverTtls, this.lines, this.states, team, Date.now() + this.clockSkewMs);
      this.ttlByLine = new Map(this.ttlViews.filter(v => v.lineIndex !== null).map(v => [v.lineIndex as number, v]));
      applyDecay(this.states, this.ttlViews);
      this.disagreement = disagreementCounts(this.blind) ? disagreementLines(this.states) : new Set();
      this.bundleViews = this.serverBundles.map(bundle => evaluateBundle(bundle, this.lines, markId => this.locateSuggestion(markId)));
      // Accord stage D: every thread on the document — the rows stored as threads PLUS every
      // comment and suggestion read as one, so nothing already here is orphaned.
      this.threadViews = evaluateThreads({
        marks: reviewMarks as unknown as ThreadSourceMark[],
        meta: this.serverThreads,
        explains: this.serverExplains,
        lines: this.lines,
        lineOf: mark => (typeof mark.pos === 'number' ? this.lineAtPos(mark.pos) : null),
      });
      this.threadsAtLine = threadsByLine(this.threadViews);
      // A thread whose mark went with the deleted text is still open, and still an Issue: it joins
      // the review marks so the counts, the rail and the Navigator all keep seeing it.
      const markIds = new Set(reviewMarks.map(mark => mark.id));
      const orphanThreads: ReviewMarkLike[] = this.threadViews
        .filter(view => view.open && view.thread.asks !== 'comment' && (!view.thread.markId || !markIds.has(view.thread.markId)))
        .map(view => ({
          id: view.thread.id,
          kind: 'comment',
          by: view.thread.by,
          quote: view.originalQuote,
          pos: view.pos,
          open: true,
          replies: view.thread.replies,
        }));
      if (orphanThreads.length) reviewMarks.push(...orphanThreads);
      this.termLinks = termLinksFor(this.lines, this.states, this.me());
      this.askViews = evaluateAsks(this.serverAsks, this.lines);
      this.doViews = evaluateDos(this.serverDos, this.lines, this.host.slug() ?? '', Date.now() + this.clockSkewMs);
      // Step B4c/B4d: flags and objections, evaluated against this page's lines and positions.
      this.flagViews = evaluateFlags(this.serverFlags, this.lines);
      this.flagsByLine = flaggedLines(this.flagViews);
      this.objectionViews = evaluateObjections(this.serverObjections, this.lines, index => this.suggestionsOnLine(index));
      this.objectionsByLine = objectedLines(this.objectionViews);
      // Line tiers: the server's reads (unredacted, with Familiars' proxies) plus any AI marks this
      // page knows (an AI viewer's own marks show before the next poll).
      this.tierEval = evaluateTiers({
        lines: this.lines,
        records: this.serverTiers,
        reads: [...this.serverTierSignals.reads, ...aiReadsFromMarks(this.serverMarks)],
        flags: this.serverTierSignals.flags,
      });
      this.summary = computeIssues({
        lines: this.lines, lineMarks: this.serverMarks, team, reviewMarks, asks: askIssueInputs(this.askViews),
        uncertain: uncertainIssueInputs(this.flagViews, this.states, team),
        objections: objectionIssueInputs(this.objectionViews),
        alternatives: alternativeIssueInputs(this.altViews, team),
        ttl: ttlIssueInputs(this.ttlViews),
        dos: doIssueInputs(this.doViews),
        disagreementLines: this.disagreement,
        disagreementAlternatives: disagreementCounts(this.blind),
        tiers: tierIssueInput(this.tierEval),
      });
      this.computeTierFold();
      // Accord round 2 stage C: ONE call, three surfaces. The amber dots, the Issues pill and the
      // Navigator's Issues tab all read this one answer (src/shared/open-view.ts), so they cannot
      // disagree on the page any more than they can in the pure code. The threads are passed here
      // and nowhere else, which is why a thread with no review mark is counted in all three.
      this.open = openView({
        issues: this.summary.issues,
        viewer: this.me(),
        aliases: this.viewerAliases(),
        lineAtPos: pos => this.lineAtPos(pos),
        threads: this.threadViews,
        team: this.summary.team,
        states: this.states,
        lineCount: this.lines.length,
      });
      this.needsYou = this.open.lines;
      this.needsYouSet = new Set(this.needsYou);
      this.ranked = rankIssues(this.summary.issues, { viewer: this.me(), explicitFor: explicitPriorityLookup(this.serverNotes, this.lines) });
      this.computeBrief(reviewMarks);
      this.selection = this.selection.filter(index => index < this.lines.length);
      this.queueAskDecorations();
      this.queueDoDecorations();
      this.queueExtrasDecorations();
      this.queueTierDecorations();
      this.maybeCheckAlignment();
    }
    this.renderTierControl();
    this.renderBanner();
    this.renderBudget();
    this.renderBlind();
    this.queueRender();
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { console.warn('[plm] listener failed', error); }
    }
  }

  // --------------------------------------------------------------------------
  // Step 1b: the reading walk reads lines and marks through these
  // --------------------------------------------------------------------------

  /** Called after every recomputation (marks loaded or changed, document changed). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Step B6: the actor this viewer marks and answers as. A signed-in person is their verified
   * identity (human:<email>) and an agent key is its AI, both as the server says; anyone else is
   * the guest who typed their name (guest:<name>), which is also what the server records.
   */
  me(): string {
    const server = this.serverMe?.actor;
    if (server) return server;
    return normalizeActorString(this.host.actor()) || 'guest:Anonymous';
  }

  /** Step B6: what the right rail header shows about the viewer. */
  viewerIdentity(): ViewerIdentity {
    const actor = this.me();
    // Cross invitation: an attested person is signed in but is not verified here, so the server's
    // own answer decides — never the actor the page guessed from the signed-in name.
    const attestedBy = this.serverMe?.attestedBy;
    const trust = this.serverMe?.actor || attestedBy ? this.serverMe!.trust : actorTrust(actor);
    return {
      actor: attestedBy ? (this.serverMe?.actor ?? '') : actor,
      trust,
      name: this.serverMe?.name || actor.replace(/^(human|ai|guest):/i, ''),
      ...(this.serverMe?.email ? { email: this.serverMe.email } : {}),
      signInUrl: this.serverMe?.signInUrl ?? null,
      ...(this.serverMe?.markNeedsSignIn ? { markNeedsSignIn: true } : {}),
      ...(attestedBy ? { attestedBy } : {}),
    };
  }

  isLoaded(): boolean { return this.loaded; }
  /** Step B3c: unfold whatever hides a line (a Since-you item was clicked). */
  revealLine(index: number): boolean { return this.host.revealLine?.(index) ?? false; }
  lineList(): DocLine[] { return this.lines; }
  lineState(index: number): LineState | undefined { return this.states[index]; }
  issueSummary(): IssueSummary | null { return this.summary; }
  /** Accord layout: the lines with an amber "needs you" dot (the status bar's Issues left). */
  needsYouLines(): readonly number[] { return this.needsYou; }
  /**
   * Accord layout stage 3: the Navigator's Issues list. Accord round 2 stage C: it is the SAME
   * object the amber dots and the Issues pill read — `openView` decided once, in `recompute`.
   */
  needsYouItems(): NeedsYouItem[] {
    return this.open.items.map(({ line, kinds, by, count }) => ({ line, kinds, by, count }));
  }
  /** Accord round 2 stage C: the one definition of Open, for this viewer, as last computed. */
  openView(): OpenView { return this.open; }
  /** Every line's marks as last built (the honest header and the lapse rule read these). */
  lineStates(): readonly LineState[] { return this.states; }
  /** The viewer's other actor strings (the editor writes a guest's comments under another name). */
  viewerAliases(): string[] { return [this.host.actor()]; }
  /** A display name for an actor (an AI by its name, a person by their label). */
  displayName(actor: string): string { return isAiActor(actor) ? this.aiName(actor) : actorLabel(actor); }
  /** Readers who can comment (guests read and comment). */
  canCommentHere(): boolean { return this.host.canComment?.() !== false; }
  /** Accord stage D: an Owner may close anyone's thread. */
  canApproveHere(): boolean { return this.canApprove; }
  /**
   * Accord layout stage 3, "Reply on this line…": a new comment thread on the whole line. Returns the
   * new comment's id, or null when it could not be placed.
   */
  commentLine(index: number, text: string): string | null {
    const line = this.lines[index];
    if (!line || !text.trim() || !this.canCommentHere()) return null;
    return this.host.commentOnLine?.(line, text.trim()) ?? null;
  }
  /** Accord layout: the viewer's last explicit mark ("You marked up to line K"). */
  markedUpTo(): MarkedUpTo | null { return markedUpTo(this.states, this.me()); }
  editorView(): EditorView | null { return this.view; }

  /** The viewer's own status on a line ('changed' when their mark is out of date). */
  /** STATEMENT_POLICY: the line is another's statement for this viewer (someone else wrote or marked it). */
  isOthersStatement(index: number): boolean {
    const line = this.lines[index];
    if (!line) return false;
    const authors = this.host.authorsOfRange?.(line.pos, line.pos + line.nodeSize) ?? [];
    return isOthersStatement({ me: [this.me(), this.host.actor()], authors, state: this.states[index] });
  }

  /** STATEMENT_POLICY: what a dwell read of this line writes for the viewer (null: nothing). */
  dwellStatusFor(index: number): LineMarkStatus | null {
    const mine = this.states[index]?.marks.get(actorKey(this.me()));
    const current = !mine ? null : { status: mine.current ? mine.mark.status : 'changed', via: mine.mark.via ?? null };
    // COS ruling (Q4): a line my Familiar flagged for me is never Agreed by passive reading.
    const flagged = this.briefByLine.get(index);
    const others = this.isOthersStatement(index) && !(flagged && capPassiveRead('agreed', flagged) !== 'agreed');
    return capPassiveRead(dwellMarkFor(others, current), flagged);
  }

  myStatus(index: number): StatusChoice | 'changed' {
    const mine = this.states[index]?.marks.get(actorKey(this.me()));
    return !mine ? 'unseen' : (mine.current ? mine.mark.status : 'changed');
  }

  /**
   * One Undo for every change (Mike, 2026-09-19). Every action site pushes an entry here; the
   * rail's Undo button and Cmd/Ctrl+Z run the newest one's inverse. See src/shared/undo.ts.
   */
  private readonly undo = new UndoStack();
  /** While > 0, actions do not record themselves (an undo or redo IS the recorded action). */
  private undoSuppress = 0;

  undoStack(): UndoStack { return this.undo; }

  /** Records an action, unless we are already inside an undo or a redo of one. */
  private pushUndo(kind: Parameters<UndoStack['pushSimple']>[0], description: string, undo: () => Promise<UndoOutcome> | UndoOutcome, redo?: () => Promise<UndoOutcome> | UndoOutcome): void {
    if (this.undoSuppress > 0) return;
    this.undo.pushSimple(kind, description, undo, redo);
  }

  /** Runs `fn` without it recording itself (used by every inverse and every redo). */
  async withoutUndo<T>(fn: () => Promise<T> | T): Promise<T> {
    this.undoSuppress += 1;
    try { return await fn(); } finally { this.undoSuppress -= 1; }
  }

  /** The viewer's own mark on a line now, for an undo entry's conflict check. */
  private myMarkSnapshot(index: number): { status: StatusChoice; reason: string | null } {
    const mine = this.states[index]?.marks.get(actorKey(this.me()));
    if (!mine || !mine.current) return { status: 'unseen', reason: null };
    return { status: mine.mark.status as StatusChoice, reason: mine.mark.reason ?? null };
  }

  /** Puts one line mark on the undo stack, with the mark it replaces as the inverse. */
  private recordMarkUndo(line: DocLine, status: StatusChoice, reason: string | undefined, via: MarkVia): void {
    if (this.undoSuppress > 0) return;
    const index = line.index;
    const before = this.myMarkSnapshot(index);
    if (before.status === status && (before.reason ?? undefined) === reason) return;
    const key = `${line.hash}:${line.occurrence}`;
    const find = (): number => this.lines.findIndex(l => `${l.hash}:${l.occurrence}` === key);
    this.pushUndo('line-mark', describeLineMark(status, index), async () => {
      const at = find();
      // The line's text changed since: the mark no longer means the same thing.
      if (at < 0) return conflictRefusal('that line');
      const now = this.myMarkSnapshot(at);
      if (now.status !== status) return conflictRefusal('your mark on that line');
      const ok = await this.withoutUndo(() => this.writeMark(this.lines[at], before.status, before.reason ?? undefined, 'click'));
      return ok ? { ok: true } : { ok: false, reason: 'Could not undo the mark.' };
    }, async () => {
      const at = find();
      if (at < 0) return { ok: false, reason: 'That line is not in the document any more.' };
      const ok = await this.withoutUndo(() => this.writeMark(this.lines[at], status, reason, via));
      return ok ? { ok: true } : { ok: false, reason: 'Could not redo the mark.' };
    });
  }

  /** Writes the viewer's mark on a line. */
  setLineStatus(index: number, status: StatusChoice, reason?: string, via: MarkVia = 'click'): Promise<boolean> {
    const line = this.lines[index];
    if (line && !this.canMark && via !== 'dwell' && this.serverMe?.markNeedsSignIn) {
      // Invite person: a deliberate mark by a guest where guests' marks do not count.
      this.toast('Sign in to mark. Without signing in you can read, comment and chat.');
    }
    if (!line || !this.canMark) return Promise.resolve(false);
    return this.writeMark(line, status, reason, via);
  }

  // --------------------------------------------------------------------------
  // Step B3c: "Since you" and the aligned snapshot
  // --------------------------------------------------------------------------

  /** The latest aligned snapshot (from the line-marks poll). */
  alignedSnapshot(): { id: string; createdAt: string } | null { return this.snapshot; }

  /** What changed since the viewer last marked a line on purpose (null when it failed). */
  async fetchSinceYou(): Promise<SinceYouReport | null> {
    const slug = this.host.slug();
    if (!slug) return null;
    const guest = this.serverMe?.actor ? '' : `?by=${encodeURIComponent(this.me())}`;
    try {
      const response = await fetch(`${this.host.apiBase()}/documents/${encodeURIComponent(slug)}/since-you${guest}`, {
        headers: this.host.authHeaders(),
        credentials: 'same-origin',
      });
      if (!response.ok) return null;
      return await response.json() as SinceYouReport;
    } catch {
      return null;
    }
  }

  /** Opens the snapshot's markdown ledger in a new tab (fetched with this page's credentials). */
  async openLedger(id: string): Promise<void> {
    const slug = this.host.slug();
    if (!slug) return;
    const tab = window.open('', '_blank');
    try {
      const response = await fetch(`${this.host.apiBase()}/documents/${encodeURIComponent(slug)}/snapshots/${encodeURIComponent(id)}.md`, {
        headers: this.host.authHeaders(),
        credentials: 'same-origin',
      });
      const text = response.ok ? await response.text() : `Could not load the ledger (${response.status}).`;
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      if (tab) tab.location.href = url; else window.location.href = url;
    } catch {
      tab?.close();
      this.toast('Could not load the ledger (offline?)');
    }
  }

  private snapshot: { id: string; createdAt: string } | null = null;
  private alignCheckAt = 0;
  private alignCheckSig = '';

  /** The page's own count reached 0: ask the server to check and freeze (it decides). */
  private maybeCheckAlignment(): void {
    const slug = this.host.slug();
    const summary = this.summary;
    if (!slug || !summary || !summary.aligned || !this.loaded || summary.counts.lines === 0) return;
    const sig = `${this.lines.map(line => line.hash).join(',')}|${this.serverMarks.map(mark => `${mark.id}:${mark.status}`).join(',')}`;
    const now = Date.now();
    if (sig === this.alignCheckSig && now - this.alignCheckAt < ALIGN_RECHECK_MS) return;
    this.alignCheckSig = sig;
    this.alignCheckAt = now;
    void fetch(`${this.host.apiBase()}/documents/${encodeURIComponent(slug)}/alignment-check`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { ...this.host.authHeaders(), 'Content-Type': 'application/json' },
      body: '{}',
    }).then(async response => {
      if (!response.ok) return;
      const body = await response.json() as { snapshot?: { id: string; createdAt: string } | null };
      if (body.snapshot && body.snapshot.id !== this.snapshot?.id) { this.snapshot = body.snapshot; this.renderBanner(); }
    }).catch(() => { /* the next change retries */ });
  }

  /** The line (index) that holds a document position, or -1. */
  lineAtPos(pos: number): number {
    for (const line of this.lines) {
      if (pos >= line.pos && pos < line.pos + line.nodeSize) return line.index;
    }
    let best = -1;
    for (const line of this.lines) if (line.pos <= pos) best = line.index;
    return best;
  }

  // --------------------------------------------------------------------------
  // Step B3: asks
  // --------------------------------------------------------------------------

  /** The ask on a line (evaluated against the current text), or null. */
  askForLine(index: number): AskView | null {
    return this.askViews.find(view => view.lineIndex === index) ?? null;
  }

  askList(): AskView[] { return this.askViews; }

  /** Changes whenever the line's ask control would look different (for the rail's box). */
  askSignature(index: number): string {
    const view = this.askForLine(index);
    const doView = this.doForLine(index);
    return (view ? askControlSignature(view, this.me(), this.canMark) : '')
      + (doView ? `|do:${doControlSignature(doView, this.me(), this.canApprove)}` : '');
  }

  /** Records the viewer's answer: Yes / Not yet / No in their own words. */
  async answerAsk(askId: string, choice: AskChoice, words: string): Promise<boolean> {
    const slug = this.host.slug();
    const view = this.askViews.find(v => v.ask.id === askId);
    if (!slug || !view || view.lineIndex === null || !this.canMark) return false;
    const line = this.lines[view.lineIndex] ?? null;
    if (!line) return false;
    const by = this.me();
    const anchor = anchorForLine(line);
    // Optimistic: the answer shows at once.
    const previous = this.serverAsks;
    const at = new Date().toISOString();
    this.serverAsks = this.serverAsks.map(ask => ask.id !== askId ? ask
      : { ...ask, answers: [...ask.answers, { id: `local-${Date.now()}`, by, choice, words, at, lineHash: line.hash }] });
    this.recompute();
    this.writesInFlight += 1;
    try {
      const response = await fetch(`${this.host.apiBase()}/documents/${encodeURIComponent(slug)}/asks/${encodeURIComponent(askId)}/answer`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...this.host.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ by, choice, words, anchor }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        this.serverAsks = previous;
        this.recompute();
        this.toast(body.error || 'Could not save the answer');
        return false;
      }
      this.askAnswers += 1;
      // Undo: take the answer back (the route refuses when someone answered after you).
      this.pushUndo('ask-answer', `answered “${choice === 'not_yet' ? 'Not yet' : choice === 'no' ? 'No' : 'Yes'}” on line ${view.lineIndex + 1}`,
        () => this.withdrawAnswer(askId),
        async () => {
          const ok = await this.withoutUndo(() => this.answerAsk(askId, choice, words));
          return ok ? { ok: true } : { ok: false, reason: 'Could not answer again.' };
        });
      return true;
    } catch {
      this.serverAsks = previous;
      this.recompute();
      this.toast('Could not save the answer (offline?)');
      return false;
    } finally {
      this.writesInFlight -= 1;
      this.fetchSeq += 1;
      void this.refresh();
    }
  }

  /**
   * Undo of an answer: takes back the viewer's own newest answer on an ask. The route refuses
   * (409) when someone else answered after them or the ask was re-asked — nothing is overwritten.
   */
  async withdrawAnswer(askId: string): Promise<UndoOutcome> {
    const slug = this.host.slug();
    if (!slug) return { ok: false, reason: 'The document is not open.' };
    this.writesInFlight += 1;
    try {
      const response = await fetch(`${this.host.apiBase()}/documents/${encodeURIComponent(slug)}/asks/${encodeURIComponent(askId)}/answer`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { ...this.host.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ by: this.me() }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) return { ok: false, reason: body.error || 'Could not take the answer back.' };
      return { ok: true };
    } catch {
      return { ok: false, reason: 'Could not take the answer back (offline?).' };
    } finally {
      this.writesInFlight -= 1;
      this.fetchSeq += 1;
      void this.refresh();
    }
  }

  /** Test hook: answers this page has saved. */
  private askAnswers = 0;

  private buildAskControlFor(view: AskView, place: 'inline' | 'box'): AskControl {
    return buildAskControl(view, {
      actor: this.me(),
      canAnswer: this.canMark && this.loaded,
      place,
      answer: (choice, words) => this.answerAsk(view.ask.id, choice, words),
    });
  }

  // --------------------------------------------------------------------------
  // {do} action lines (safe slice: approve and revoke; Run is disabled)
  // --------------------------------------------------------------------------

  /** The `{do}` on a line (evaluated against the current text), or null. */
  doForLine(index: number): DoView | null {
    return this.doViews.find(view => view.lineIndex === index) ?? null;
  }

  doList(): DoView[] { return this.doViews; }

  /** Approve or revoke from the page. The server decides who may; the page only asks. */
  private async writeDo(doId: string, action: 'approve' | 'revoke'): Promise<boolean> {
    const slug = this.host.slug();
    const view = this.doViews.find(v => v.record.id === doId);
    if (!slug || !view) return false;
    this.writesInFlight += 1;
    try {
      const response = await fetch(`${this.host.apiBase()}/documents/${encodeURIComponent(slug)}/dos/${encodeURIComponent(doId)}/${action}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...this.host.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'approve' ? { digest: view.digest } : {}),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        this.toast(body.error || (action === 'approve' ? 'Could not approve' : 'Could not revoke the approval'));
        return false;
      }
      this.doWrites += 1;
      return true;
    } catch {
      this.toast('Could not reach the server (offline?)');
      return false;
    } finally {
      this.writesInFlight -= 1;
      this.fetchSeq += 1;
      void this.refresh();
    }
  }

  private buildDoControlFor(view: DoView, place: 'inline' | 'box'): HTMLElement {
    return buildDoControl(view, {
      actor: this.me(),
      isOwner: this.canApprove,
      place,
      approve: () => this.writeDo(view.record.id, 'approve'),
      revoke: () => this.writeDo(view.record.id, 'revoke'),
    });
  }

  /** Puts the inline `{do}` widgets in the text (view-only decorations), when they changed or went missing. */
  private queueDoDecorations(): void {
    if (this.doDecoQueued) return;
    this.doDecoQueued = true;
    requestAnimationFrame(() => {
      this.doDecoQueued = false;
      const view = this.view;
      if (!view) return;
      const specs: DoDecorationSpec[] = [];
      const sigs: string[] = [];
      for (const doView of this.doViews) {
        if (doView.lineIndex === null || doView.state === 'withdrawn') continue;
        const line = this.lines[doView.lineIndex];
        if (!line || line.kind === 'table_row') continue; // table rows: the rail and sheet only
        const sig = doControlSignature(doView, this.me(), this.canApprove);
        sigs.push(`${doView.record.id}@${line.pos}:${line.nodeSize}:${sig}`);
        specs.push({
          doId: doView.record.id,
          pos: line.pos,
          nodeSize: line.nodeSize,
          sig: String(hashSig(sig)),
          tag: () => buildDoTag(doView),
          control: () => this.buildDoControlFor(doView, 'inline'),
        });
      }
      const signature = sigs.join('|');
      // A remote Yjs update replaces the whole document and drops mapped decorations (see the
      // ask widgets): rebuild whenever fewer are present than expected (a tag and a control each).
      const expected = 2 * specs.filter(spec => view.state.doc.nodeAt(spec.pos)?.isTextblock).length;
      const present = doViewKey.getState(view.state)?.find().length ?? 0;
      if (signature === this.doDecoSig && present >= expected) return;
      this.doDecoSig = signature;
      try { setDoDecorations(view, specs); } catch (error) { console.warn('[plm] do decorations failed', error); }
    });
  }

  /** Puts the inline ask widgets in the text (view-only decorations), when they changed. */
  private queueAskDecorations(): void {
    if (this.askDecoQueued) return;
    this.askDecoQueued = true;
    // Never dispatch from inside a view update: wait for the next frame.
    requestAnimationFrame(() => {
      this.askDecoQueued = false;
      const view = this.view;
      if (!view) return;
      const specs: AskDecorationSpec[] = [];
      const sigs: string[] = [];
      for (const askView of this.askViews) {
        if (askView.lineIndex === null) continue;
        const line = this.lines[askView.lineIndex];
        if (!line || line.kind === 'table_row') continue; // table rows: the rail and sheet only
        const sig = askControlSignature(askView, this.me(), this.canMark && this.loaded);
        sigs.push(`${askView.ask.id}@${line.pos}:${line.nodeSize}:${sig}`);
        specs.push({
          askId: askView.ask.id,
          pos: line.pos,
          nodeSize: line.nodeSize,
          sig: String(hashSig(sig)),
          tag: () => buildAskTag(askView, this.me()),
          control: () => this.buildAskControlFor(askView, 'inline').root,
        });
      }
      const signature = sigs.join('|');
      // A remote Yjs update replaces the whole document, which drops mapped decorations even when
      // every position is unchanged (an edit below the asks): rebuild whenever some are missing.
      // Each ask on a text block has two widgets, its tag and its control.
      const expected = 2 * specs.filter(spec => view.state.doc.nodeAt(spec.pos)?.isTextblock).length;
      const present = askViewKey.getState(view.state)?.find().length ?? 0;
      if (signature === this.askDecoSig && present >= expected) return;
      this.askDecoSig = signature;
      try { setAskDecorations(view, specs); } catch (error) { console.warn('[plm] ask decorations failed', error); }
    });
  }

  /** The viewer edited lines they had marked: their mark follows the new text (policy). */
  private restampOwnEdits(): void {
    this.restampTimer = null;
    const view = this.view;
    if (!view || !this.loaded) return;
    const edits = takePendingLocalLineEdits();
    const me = actorKey(this.me());
    const lines = extractLines(view.state.doc as unknown as LineSourceNode);
    const done = new Set<number>();
    for (const edit of edits) {
      const mine = this.serverMarks.find(mark => actorKey(mark.by) === me
        && mark.anchor.hash === edit.hash && mark.anchor.occurrence === edit.occurrence);
      // The edited line is the one whose text is what this user last typed.
      const candidates = lines.filter(line => line.hash === edit.currentHash);
      if (candidates.length === 0) continue; // someone else changed it since: their edit resets it
      // Editing first (Mike, 2026-09-19): editing another's statement. Others' marks on the text
      // before the edit (or someone else's authorship) make it another's statement.
      const others = this.serverMarks.filter(mark => actorKey(mark.by) !== me
        && mark.anchor.hash === edit.hash && mark.anchor.occurrence === edit.occurrence);
      const near = mine?.anchor.ordinal ?? others[0]?.anchor.ordinal ?? candidates[0].index;
      const line = candidates.reduce((best, next) =>
        Math.abs(next.index - near) < Math.abs(best.index - near) ? next : best);
      if (done.has(line.index)) continue;
      const othersState = { marks: new Map(others.map(mark => [actorKey(mark.by), { mark, current: true }] as const)) };
      const authors = this.host.authorsOfRange?.(line.pos, line.pos + line.nodeSize) ?? [];
      const othersStatement = isOthersStatement({ me: [this.me(), this.host.actor()], authors, state: othersState, purpose: 'edit' });
      if (othersStatement && STATEMENT_POLICY.editorMarkOnEdit && !this.host.isSuggesting?.()) {
        const kind = edit.text ? classifyLineChange(edit.text, line.text).kind : 'substantive';
        if (kind !== 'same') {
          done.add(line.index);
          const via: MarkVia = kind === 'cosmetic' ? 'correct' : 'edit';
          const status = STATEMENT_POLICY.editorMarkOnEdit as StatusChoice;
          if (mine) void this.writeMarkReplacing(line, mine, { status: status as LineMarkStatus, via, reason: null });
          else void this.writeMark(line, status, undefined, via);
          continue;
        }
      }
      if (!mine) continue;
      // Still current somewhere (for example a duplicate line)? Then nothing went stale.
      if (lines.some(l => l.hash === mine.anchor.hash && l.occurrence === mine.anchor.occurrence)) continue;
      done.add(line.index);
      void this.writeMarkReplacing(line, mine);
    }
  }

  /**
   * Editing first: who last edited a line, as the rail says it ("changed by Mike — meaning
   * changed" / "corrected by Mike — meaning unchanged"), from the newest current edit/correct mark.
   */
  editNoteFor(index: number): { by: string; kind: 'edit' | 'correct'; text: string } | null {
    const state = this.states[index];
    if (!state) return null;
    let best: LineMark | null = null;
    for (const entry of state.marks.values()) {
      const via = entry.mark.via;
      if (!entry.current || entry.carried || (via !== 'edit' && via !== 'correct') || entry.mark.hidden) continue;
      if (!best || String(entry.mark.at) > String(best.at)) best = entry.mark;
    }
    if (!best) return null;
    const kind = best.via as 'edit' | 'correct';
    const who = actorLabel(best.by);
    return { by: best.by, kind, text: kind === 'edit' ? `changed by ${who} — meaning changed` : `corrected by ${who} — meaning unchanged` };
  }

  private async writeMarkReplacing(line: DocLine, previous: LineMark, change?: Partial<Pick<LineMark, 'status' | 'via' | 'reason'>>): Promise<void> {
    const slug = this.host.slug();
    if (!slug) return;
    const anchor = anchorForLine(line);
    const old = { ...previous, ...(change ?? {}), id: previous.id, anchor: previous.anchor };
    this.serverMarks = this.serverMarks.filter(mark => mark.id !== old.id);
    this.serverMarks.push({ ...old, id: `local-${Date.now()}`, at: new Date().toISOString(), anchor });
    this.recompute();
    this.writesInFlight += 1;
    try {
      await fetch(`${this.host.apiBase()}/documents/${encodeURIComponent(slug)}/line-marks`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...this.host.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          by: old.by, status: old.status, reason: old.reason ?? undefined, via: old.via ?? undefined, anchor,
          replaceIds: old.id.startsWith('local-') ? [] : [old.id],
          replaceAnchors: [{ hash: old.anchor.hash, occurrence: old.anchor.occurrence }],
        }),
      });
    } catch {
      // The next refresh shows the server's truth.
    } finally {
      this.writesInFlight -= 1;
      this.fetchSeq += 1;
      void this.refresh();
    }
  }

  // --------------------------------------------------------------------------
  // Rendering
  // --------------------------------------------------------------------------

  private queueRender = (): void => {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderGutter();
    });
  };

  private renderBanner(): void {
    const summary = this.summary;
    if (!summary || !this.loaded) {
      this.countEl.textContent = '…';
      this.bannerEl.dataset.state = 'loading';
      this.nextBtn.disabled = true;
      this.nextBtn.setAttribute('aria-label', 'Next issue');
      this.setShort('…');
      return;
    }
    const n = summary.counts.total;
    // Accord layout stage 2 (COS, 2026-09-21): the pill counts the viewer's own Issues (the amber
    // dots, the status bar's "Issues left"); the team's count is in the title and People › Who is here.
    const mine = this.needsYou.length;
    const shown = ISSUES_PILL_POLICY.counts === 'viewer' ? mine : n;
    this.bannerEl.dataset.state = n === 0 ? 'aligned' : shown === 0 ? 'clear' : 'issues';
    this.countEl.dataset.teamCount = String(n);
    this.countEl.dataset.viewerCount = String(mine);
    this.countEl.textContent = ISSUES_PILL_POLICY.counts === 'viewer' ? issuesPillText(mine, n) : (n === 0 ? 'Aligned' : `${n} ${n === 1 ? 'issue' : 'issues'}`);
    const lead = ISSUES_PILL_POLICY.teamCountInTitle ? `${issuesPillTitle(mine, n)} ` : '';
    this.countEl.title = n === 0
      ? `${lead}Every team member has seen every line and no one has rejected anything. Team: ${summary.team.map(actorLabel).join(', ')}`
      : `${lead}${summary.counts.lineIssues} lines not yet seen by everyone or rejected; ${summary.counts.reviewMarkIssues} open comments or suggestions; ${summary.counts.askIssues} unanswered ${summary.counts.askIssues === 1 ? 'ask' : 'asks'}; ${summary.counts.uncertainIssues} uncertain ${summary.counts.uncertainIssues === 1 ? 'line' : 'lines'}; ${summary.counts.objectionIssues} open ${summary.counts.objectionIssues === 1 ? 'objection' : 'objections'}; ${summary.counts.alternativeIssues} ${summary.counts.alternativeIssues === 1 ? 'line' : 'lines'} with competing wordings; ${summary.counts.ttlIssues} expired ${summary.counts.ttlIssues === 1 ? 'claim' : 'claims'}; ${summary.counts.doIssues} unfinished ${summary.counts.doIssues === 1 ? 'action' : 'actions'}${this.blind ? '; blind marking is on' : ''}. Next issue goes by stakes: ${this.ranked.filter(r => r.urgent).length} urgent. Team: ${summary.team.map(actorLabel).join(', ')}`;
    this.nextBtn.disabled = n === 0;
    // Polish pass (COS, 2026-09-21): the phone pill reads as the mockup's "12 Issues".
    this.setShort(n === 0 ? '✓ Aligned' : issuesPillText(shown, n));
    this.nextBtn.setAttribute('aria-label', n === 0 ? 'No issues: aligned' : `Next issue (${shown} ${shown === 1 ? 'issue needs' : 'issues need'} you; the team has ${n})`);
    this.renderAlignedAt(n === 0);
  }

  /** Step B3c: the snapshot link beside the Issue count. */
  /**
   * Polish pass (COS, 2026-09-21): the Line tab folds everyone's marks into "Marked by N"
   * (MARKED_BY_POLICY). Open by default for a Reject or an open objection; a person's own open or
   * close is kept for the line across re-renders.
   */
  private markedByFoldEl(index: number, list: HTMLElement, statuses: string[]): HTMLElement {
    const fold = markedByFold(statuses, this.objectionsByLine.has(index));
    const details = document.createElement('details');
    details.className = 'plm-team-fold';
    details.dataset.line = String(index);
    details.dataset.count = String(fold.count);
    details.dataset.auto = fold.open ? 'open' : 'closed';
    // A click is a choice and stays. The first render is not a choice, so a later Reject still opens it.
    const chosen = this.teamFoldChoice.get(index);
    details.open = chosen === undefined ? fold.open : chosen;
    const summary = document.createElement('summary');
    summary.className = 'plm-team-sum';
    const label = document.createElement('span');
    label.className = 'plm-team-label';
    label.textContent = fold.label;
    summary.append(label);
    if (fold.detail) {
      const detail = document.createElement('span');
      detail.className = 'plm-team-detail';
      detail.textContent = fold.detail;
      summary.append(detail);
    }
    summary.title = `${fold.count} of ${fold.total} ${fold.total === 1 ? 'person has' : 'people have'} marked this line. Show who marked what.`;
    details.append(summary, list);
    // A person's click (or Enter / Space) on the row records a choice; setting the default does not.
    summary.addEventListener('click', () => { this.teamFoldChoice.set(index, !details.open); });
    return details;
  }

  private renderAlignedAt(aligned: boolean): void {
    const snap = this.snapshot;
    this.alignedEl.hidden = !snap;
    if (!snap) return;
    const when = formatWhen(snap.createdAt);
    this.alignedEl.textContent = aligned ? `Aligned as of ${when}` : `Last aligned ${when}`;
    this.alignedEl.dataset.state = aligned ? 'aligned' : 'since';
    this.alignedEl.title = aligned
      ? `Everyone agreed on this version at ${new Date(snap.createdAt).toLocaleString()}. Open the ledger: the text, every mark and every answer.`
      : `The last aligned version was frozen at ${new Date(snap.createdAt).toLocaleString()}; changes since then start a new round. Open its ledger.`;
    this.alignedEl.setAttribute('aria-label', `${this.alignedEl.textContent}: open the ledger`);
  }

  private setShort(text: string): void {
    const short = this.nextBtn.querySelector('.plm-next-short');
    if (short) short.textContent = text;
  }

  private renderGutter(): void {
    const view = this.view;
    if (!view || !this.gutter.isConnected) return;
    const containerRect = this.gutter.parentElement!.getBoundingClientRect();
    const editorRect = view.dom.getBoundingClientRect();
    const me = actorKey(this.me());
    const phone = isPhone();
    const dotSize = phone ? 36 : 28;
    const leftEdge = editorRect.left - containerRect.left - dotSize - (phone ? 1 : 8);
    const existing = new Map<string, HTMLButtonElement>();
    for (const el of Array.from(this.gutter.children) as HTMLButtonElement[]) existing.set(el.dataset.key ?? '', el);
    const used = new Set<string>();
    const issueLines = new Set<number>();
    for (const issue of this.summary?.issues ?? []) if ('lineIndex' in issue && issue.lineIndex !== null) issueLines.add(issue.lineIndex);
    let chatCounts = new Map<number, number>();
    try { chatCounts = this.host.chatCounts?.() ?? chatCounts; } catch { /* chat is optional */ }
    for (const state of this.states) {
      const line = state.line;
      const dom = view.nodeDOM(line.pos) as HTMLElement | null;
      if (!dom || typeof dom.getBoundingClientRect !== 'function') continue;
      const rect = dom.getBoundingClientRect();
      if (rect.height === 0) continue;
      const key = `${line.hash}:${line.occurrence}`;
      used.add(key);
      // Step B7: a speech bubble with the number of chat messages that point at this line.
      const chatCount = chatCounts.get(line.index) ?? 0;
      if (chatCount > 0) {
        const bubbleKey = `chat:${key}`;
        used.add(bubbleKey);
        let bubble = existing.get(bubbleKey);
        if (!bubble) {
          bubble = document.createElement('button');
          bubble.type = 'button';
          bubble.className = 'plm-chat-bubble';
          bubble.dataset.key = bubbleKey;
          this.gutter.append(bubble);
        }
        bubble.dataset.line = String(line.index);
        bubble.textContent = String(chatCount);
        bubble.setAttribute('aria-label', `${chatCount} chat ${chatCount === 1 ? 'message' : 'messages'} about line ${line.index + 1}`);
        bubble.title = `${chatCount} chat ${chatCount === 1 ? 'message points' : 'messages point'} at this line`;
        const lh = parseFloat(getComputedStyle(dom).lineHeight) || 24;
        bubble.style.top = `${Math.round(rect.top - containerRect.top + Math.max(0, (Math.min(lh, rect.height) - dotSize) / 2) - (phone ? 8 : 6))}px`;
        bubble.style.left = `${Math.round(Math.max(0, leftEdge) + dotSize - (phone ? 12 : 8))}px`;
      }
      let dot = existing.get(key);
      if (!dot) {
        dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'plm-dot';
        dot.dataset.key = key;
        this.gutter.append(dot);
      }
      dot.dataset.line = String(line.index);
      const mine = state.marks.get(me);
      const myStatus: ShownStatus = !mine ? 'unseen' : (!mine.current ? 'changed' : mine.decayed ? 'stale' : mine.mark.status);
      dot.dataset.status = myStatus;
      // Step B4f: disagreement (blind reveal), competing wordings, a time-to-live on the line.
      if (this.disagreement.has(line.index)) dot.dataset.disagreement = 'true'; else delete dot.dataset.disagreement;
      if (this.altsByLine.has(line.index)) dot.dataset.alternatives = String(this.altsByLine.get(line.index)!.options.length - 1); else delete dot.dataset.alternatives;
      const ttlView = this.ttlByLine.get(line.index);
      if (ttlView) dot.dataset.ttl = ttlView.expired || ttlView.notTrue ? 'expired' : 'set'; else delete dot.dataset.ttl;
      dot.dataset.issue = issueLines.has(line.index) ? 'true' : 'false';
      // Accord layout: amber = needs you (the status bar counts these dots).
      const needsYou = this.needsYouSet.has(line.index);
      if (needsYou) dot.dataset.needsYou = 'true'; else delete dot.dataset.needsYou;
      // Step B3b: your mark survived a small edit (the rail shows what changed).
      if (mine?.carried) dot.dataset.carried = 'true'; else delete dot.dataset.carried;
      if (mine?.lapsed) dot.dataset.lapsed = 'true'; else delete dot.dataset.lapsed;
      // Step B4c: an amber tick for a line its writer flagged uncertain; B4d: a red tick for an
      // open objection; a selected line (shift-click) for a Reject that covers several lines.
      if (this.flagsByLine.has(line.index)) dot.dataset.uncertain = 'true'; else delete dot.dataset.uncertain;
      if (this.objectionsByLine.has(line.index)) dot.dataset.objection = 'true'; else delete dot.dataset.objection;
      if (this.selection.includes(line.index)) dot.dataset.selected = 'true'; else delete dot.dataset.selected;
      // Familiar proxy marks: a lavender outlined dot with the Familiar's initial on a line I have
      // not marked. It is not my mark (the glyph stays mine).
      const proxyItem = this.briefByLine.get(line.index);
      if (proxyItem) { dot.dataset.proxy = proxyItem.proxy.status; dot.dataset.proxyBucket = proxyItem.bucket; } else { delete dot.dataset.proxy; delete dot.dataset.proxyBucket; }
      // Line tiers: a diamond beside a decision line (once the document has tags); context dots are fainter.
      const tierView = this.tierEval?.views[line.index];
      const showTier = Boolean(tierView) && (tierView!.tier === 'context' || this.tierEval!.anyTagged || !TIER_POLICY.diamondOnlyWhenTagged);
      if (showTier) dot.dataset.tier = tierView!.tier; else delete dot.dataset.tier;
      if (tierView?.proposed) dot.dataset.tierProposed = 'true'; else delete dot.dataset.tierProposed;
      const lineHeight = parseFloat(getComputedStyle(dom).lineHeight) || 24;
      const top = rect.top - containerRect.top + Math.max(0, (Math.min(lineHeight, rect.height) - dotSize) / 2);
      dot.style.top = `${Math.round(top)}px`;
      dot.style.left = `${Math.round(Math.max(0, leftEdge))}px`;
      dot.style.width = `${dotSize}px`;
      dot.style.height = `${dotSize}px`;
      const others = [...state.marks.entries()].filter(([k]) => k !== me);
      const pipStatuses = others.slice(0, 4).map(([, entry]) => shownStatus(entry));
      // Rebuild the dot's children only when they change: a click whose target was replaced
      // between pointerdown and pointerup would be lost.
      const proxyInitial = proxyItem ? familiarInitial(this.aiName(proxyItem.proxy.familiar)) : '';
      // Accord layout: no ◆ in the margin (HIGHLIGHT_POLICY.decisionDiamond); the tier is in the line's box and this label.
      const tierGlyph = HIGHLIGHT_POLICY.decisionDiamond && showTier && tierView!.tier === 'decision' ? '◆' : '';
      const sig = `${myStatus}|${pipStatuses.join(',')}|${proxyInitial}|${tierGlyph}`;
      if (dot.dataset.sig !== sig) {
        dot.dataset.sig = sig;
        const glyph = document.createElement('span');
        glyph.className = 'plm-glyph';
        glyph.textContent = myStatus === 'stale' ? '' : STATUS_GLYPH[myStatus];
        const pips = document.createElement('span');
        pips.className = 'plm-pips';
        for (const status of pipStatuses) {
          const pip = document.createElement('i');
          pip.dataset.status = status;
          pips.append(pip);
        }
        dot.replaceChildren(glyph, pips);
        if (proxyInitial) {
          const badge = document.createElement('span');
          badge.className = 'plm-proxy';
          badge.textContent = proxyInitial;
          badge.setAttribute('aria-hidden', 'true');
          dot.append(badge);
        }
        if (tierGlyph) {
          const diamond = document.createElement('span');
          diamond.className = 'plm-tier';
          diamond.textContent = tierGlyph;
          diamond.setAttribute('aria-hidden', 'true');
          dot.append(diamond);
        }
      }
      const othersText = others.map(([, e]) => `${actorLabel(e.mark.by)}: ${shownLabel(shownStatus(e))}`).join('; ');
      const carriedText = (mine?.carried ? ' (carried over a small edit)' : '')
        + (this.flagsByLine.has(line.index) ? '. Flagged uncertain by its writer' : '')
        + (this.objectionsByLine.has(line.index) ? '. Has an open objection' : '');
      const extraText = (proxyItem ? `. Your Familiar ${this.aiName(proxyItem.proxy.familiar)} ${proxyItem.proxy.status === 'rejected-suggested' ? 'recommends rejecting it' : proxyItem.proxy.status === 'seen' ? 'read it' : `agrees (${proxyItem.proxy.confidence})`}, not yet yours` : '')
        + (this.disagreement.has(line.index) ? '. The team disagrees on this line' : '')
        + (this.altsByLine.has(line.index) ? '. Has competing wordings' : '')
        + (ttlView ? `. ${describeTtl(ttlView, Date.now() + this.clockSkewMs)}` : '')
        + (showTier ? (tierView!.tier === 'context' ? `. Context line${tierView!.proposed ? ' (AI proposed)' : ''}${tierView!.readBy.length ? `, read for you by ${tierView!.readBy.map(a => this.aiName(a)).join(', ')}` : ''}` : '. Decision line') : '');
      dot.setAttribute('aria-label', `Line ${line.index + 1}${needsYou ? ' (needs you)' : ''}: your mark ${myStatus === 'changed' ? 'is out of date (the line changed)' : shownLabel(myStatus)}${carriedText}${extraText}${othersText ? `. ${othersText}` : ''}. Mark this line`);
      dot.title = othersText ? `You: ${myStatus === 'changed' ? 'changed since you marked it' : shownLabel(myStatus)}\n${othersText.replace(/; /g, '\n')}` : 'Mark this line';
    }
    // Accord round 2 stage A: a visible way into editing on the cursor line only (Option+click has
    // no affordance at all). One small pencil in this same dot column, beside its dot.
    const cursor = this.host.cursorLine?.() ?? -1;
    const pencilKey = 'edit-pencil';
    const cursorLine = cursor >= 0 ? this.lines[cursor] : null;
    const canEdit = READING_MODE_POLICY.marginPencilStartsWriting && Boolean(this.host.startEditingLine) && this.canMark;
    const cursorDom = cursorLine ? view.nodeDOM(cursorLine.pos) as HTMLElement | null : null;
    if (canEdit && cursorLine && cursorDom && typeof cursorDom.getBoundingClientRect === 'function' && cursorDom.getBoundingClientRect().height > 0) {
      used.add(pencilKey);
      let pencil = existing.get(pencilKey);
      if (!pencil) {
        pencil = document.createElement('button');
        pencil.type = 'button';
        pencil.className = 'plm-edit-pencil';
        pencil.dataset.key = pencilKey;
        pencil.textContent = '✎';
        this.gutter.append(pencil);
      }
      const rect = cursorDom.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(cursorDom).lineHeight) || 24;
      pencil.dataset.line = String(cursor);
      pencil.setAttribute('aria-label', `Edit line ${cursor + 1}`);
      pencil.title = 'Edit this line (Option+click the words does the same). Cmd+Enter, a click outside, or Esc posts it as a proposal.';
      pencil.style.top = `${Math.round(rect.top - containerRect.top + Math.max(0, (Math.min(lh, rect.height) - dotSize) / 2))}px`;
      pencil.style.left = `${Math.round(Math.max(0, leftEdge) - (phone ? 22 : 20))}px`;
      pencil.style.width = `${dotSize}px`;
      pencil.style.height = `${dotSize}px`;
    }
    for (const [key, el] of existing) if (!used.has(key)) el.remove();
  }

  // --------------------------------------------------------------------------
  // Menu / bottom sheet
  // --------------------------------------------------------------------------

  private onGutterClick = (event: MouseEvent): void => {
    const pencil = (event.target as HTMLElement).closest('.plm-edit-pencil') as HTMLButtonElement | null;
    if (pencil) {
      event.preventDefault();
      event.stopPropagation();
      this.host.startEditingLine?.(Number(pencil.dataset.line));
      return;
    }
    const bubble = (event.target as HTMLElement).closest('.plm-chat-bubble') as HTMLButtonElement | null;
    if (bubble) {
      event.preventDefault();
      event.stopPropagation();
      this.host.onChatBubble?.(Number(bubble.dataset.line));
      return;
    }
    const dot = (event.target as HTMLElement).closest('.plm-dot') as HTMLButtonElement | null;
    if (!dot) return;
    event.preventDefault();
    event.stopPropagation();
    const index = Number(dot.dataset.line);
    const line = this.lines[index];
    if (!line) return;
    // Step B4d: shift-click selects a range of lines (from the focus line) for one Reject.
    if (event.shiftKey) {
      const from = this.selection.length ? this.selection[0] : (this.host.anchorLine?.() ?? index);
      this.selectLines(from, index);
      return;
    }
    if (this.host.onDotActivate?.(index)) { this.closeMenu(); return; }
    if (this.menu && this.menu.dataset.line === String(index)) { this.closeMenu(); return; }
    this.openMenu(line, dot);
  };

  /**
   * The mark box for one line: excerpt, Seen / Agree / Approve / Reject (with a one-line reason),
   * Clear, and every team member's mark. Used by the desktop popover and phone sheet (Step 1)
   * and by the reading walk's right rail (Step 1b).
   */
  buildMarkBox(line: DocLine, options: MarkBoxOptions = {}): MarkBox {
    const state = this.states[line.index];
    const me = actorKey(this.me());
    const mine = state?.marks.get(me);
    const root = document.createElement('div');
    root.className = 'plm-box';
    root.dataset.line = String(line.index);
    const margin = options.layout === 'margin';
    if (margin) root.classList.add('plm-box-margin');
    const excerpt = document.createElement('p');
    excerpt.className = margin ? 'plm-excerpt plm-quote' : 'plm-excerpt';
    excerpt.textContent = line.text.length > 140 ? `${line.text.slice(0, 140)}…` : line.text;
    root.append(excerpt);
    // Margin layout: ⋯ More (built below) and the parts that follow the primary buttons.
    const more = document.createElement('div');
    more.className = 'plm-more';
    more.id = `plm-more-${line.index}-${Math.random().toString(36).slice(2, 8)}`;
    more.hidden = true;
    more.setAttribute('role', 'group');
    more.setAttribute('aria-label', 'More marks for this line');
    const thread = document.createElement('div');
    thread.className = 'plm-thread';
    const place = (node: HTMLElement) => { (margin ? thread : root).append(node); };
    // Line tiers: what the line asks of you (decision / context: read for you by ...), and the flip.
    const tierView = this.tierEval?.views[line.index];
    const setTier = (tier: LineTier): boolean => {
      if (!this.canMark) return false;

      const fresh = this.lines[line.index] ?? line;
      void this.setTiers([fresh.index], tier);
      return true;
    };
    let tierRow: HTMLElement | null = null;
    if (tierView) {
      tierRow = buildTierRow({
        view: tierView,
        anyTagged: this.tierEval?.anyTagged ?? false,
        canTag: this.canMark,
        viewerIsPerson: !isAiActor(this.me()),
        name: actor => (isAiActor(actor) ? this.aiName(actor) : actorLabel(actor)),
        when: formatWhen,
        set: tier => { setTier(tier); },
      });
      if (!margin) root.append(tierRow);
    }

    // Step B3: the line's ask comes first: it is the decision the line carries.
    const askView = this.askForLine(line.index);
    const askControl = askView ? this.buildAskControlFor(askView, 'box') : undefined;
    if (askControl) place(askControl.root);
    // {do}: the line's action, with Approve (for the people named) and the disabled Run.
    const doView = this.doForLine(line.index);
    if (doView && doView.state !== 'withdrawn') place(this.buildDoControlFor(doView, 'box'));
    // Step B4d: open objections on this line (with Clear / Keep for the objector).
    for (const objection of this.objectionsByLine.get(line.index) ?? []) place(this.buildObjectionCard(objection));
    // Step B4c: the writer's uncertainty (flag, note, Clear), or "Flag uncertain…".
    const flagRow = this.buildFlagRow(line);
    place(flagRow);
    // Margin layout: "Flag uncertain…" and its form go under ⋯ More; the flags themselves stay.
    const flagMore = margin ? [...flagRow.querySelectorAll<HTMLElement>(':scope > .plm-flag-open, :scope > .plm-flag-form')] : [];
    // Step B4f: disagreement revealed by blind marking, competing wordings, time-to-live, Explain.
    if (this.disagreement.has(line.index)) {
      const note = document.createElement('p');
      note.className = 'plm-disagree';
      note.setAttribute('role', 'status');
      note.textContent = 'The team disagrees on this line: someone agreed and someone rejected it. It is a priority Issue.';
      place(note);
    }
    if (this.blind && this.hiddenOnLine(line.index) > 0) {
      const note = document.createElement('p');
      note.className = 'plm-blind-note';
      const n = this.hiddenOnLine(line.index);
      note.textContent = `Blind marking: ${n} ${n === 1 ? 'mark is' : 'marks are'} hidden until you mark this line.`;
      place(note);
    }
    const altSet = this.altsByLine.get(line.index);
    if (altSet) place(this.buildAltSection(line, altSet));
    const extras = this.buildExtrasRow(line, Boolean(altSet));
    if (!margin) root.append(extras);
    else {
      // The time-to-live status (when the line is perishable) stays in view; the links go under More.
      const ttlStatus = extras.querySelector<HTMLElement>('.plm-ttl-status');
      if (ttlStatus) { const row = document.createElement('div'); row.className = 'plm-ttl plm-ttl-shown'; row.append(ttlStatus); thread.append(row); }
    }
    const history = this.altHistoryFor(line.index);
    if (history.length) place(this.buildAltHistory(history));

    const proxyItem = this.briefByLine.get(line.index);
    const tail: HTMLElement[] = [];
    if (proxyItem) {
      const note = this.buildProxyNote(proxyItem);
      if (margin && MARGIN_POLICY.familiarFolds) {
        // "Familiar says (1)": the note folds to its headline in the Margin.
        const fold = document.createElement('details');
        fold.className = 'plm-familiar-fold';
        const summary = document.createElement('summary');
        summary.textContent = 'Familiar says (1)';
        fold.append(summary, note);
        tail.push(fold);
      } else if (margin) tail.push(note);
      else root.append(note);
    }
    // Accord round 2 stage C (brief 5): an agreement that LAPSED says so in those words, and shows
    // the wording that was agreed to beside the one that is there now. A line that merely changed
    // since a Seen mark keeps the older sentence: nothing was agreed, so nothing lapsed.
    const lapsed = Boolean(mine && !mine.current && mine.lapsed && (mine.mark.status === 'agreed' || mine.mark.status === 'approved'));
    if (mine && !mine.current && !lapsed) {
      const changed = document.createElement('p');
      changed.className = 'plm-changed';
      changed.textContent = `Changed since you marked it ${STATUS_LABEL[mine.mark.status]}. Mark it again.`;
      place(changed);
    }
    if (mine && lapsed) {
      const box = document.createElement('div');
      box.className = 'plm-lapsed';
      box.dataset.line = String(line.index);
      const text = document.createElement('p');
      text.className = 'plm-lapsed-text';
      text.textContent = `You agreed to an earlier version of this line. The meaning changed, so your ${STATUS_LABEL[mine.mark.status]} does not carry.`;
      box.append(text);
      if (mine.lapsedFrom) {
        const was = document.createElement('p');
        was.className = 'plm-lapsed-was';
        const label = document.createElement('span');
        label.textContent = 'You agreed to: ';
        const old = document.createElement('del');
        old.textContent = mine.lapsedFrom.length > 240 ? `${mine.lapsedFrom.slice(0, 240)}…` : mine.lapsedFrom;
        was.append(label, old);
        box.append(was);
        const now = document.createElement('p');
        now.className = 'plm-lapsed-now';
        const nowLabel = document.createElement('span');
        nowLabel.textContent = 'It now reads: ';
        const ins = document.createElement('ins');
        ins.textContent = line.text.length > 240 ? `${line.text.slice(0, 240)}…` : line.text;
        now.append(nowLabel, ins);
        box.append(now);
      }
      place(box);
    }
    // Step B3b: a mark carried over a small edit: say what changed, and let the reader undo it.
    if (mine?.carried) {
      const carried = document.createElement('div');
      carried.className = 'plm-carried';
      const text = document.createElement('p');
      text.textContent = `Your ${STATUS_LABEL[mine.mark.status]} mark carried over a small edit (spelling, case or punctuation).`;
      carried.append(text);
      if (mine.carriedFrom) {
        const was = document.createElement('p');
        was.className = 'plm-carried-was';
        const label = document.createElement('span');
        label.textContent = 'Was: ';
        const old = document.createElement('del');
        old.textContent = mine.carriedFrom.length > 200 ? `${mine.carriedFrom.slice(0, 200)}…` : mine.carriedFrom;
        was.append(label, old);
        carried.append(was);
      }
      const revert = document.createElement('button');
      revert.type = 'button';
      revert.className = 'plm-choice plm-carried-revert';
      revert.textContent = 'Mark unseen';
      revert.disabled = !this.canMark;
      revert.onclick = () => { options.onChosen?.('unseen'); void this.writeMark(line, 'unseen'); };
      carried.append(revert);
      place(carried);
    }
    if (mine?.current && mine.mark.status === 'skimmed') {
      const skim = document.createElement('p');
      skim.className = 'plm-skimmed-note';
      skim.textContent = 'You scrolled past this line faster than its reading time, so it is not Seen yet. Stay on it, or mark it.';
      place(skim);
    }

    const agreement = this.host.sectionAgreement?.(line.index) ?? null;
    if (agreement) {
      const sectionAgree = document.createElement('button');
      sectionAgree.type = 'button';
      sectionAgree.className = 'plm-section-note';
      const armAgree = (scope: SectionScope, count: number) => {
        sectionAgree.textContent = `Agree with this section (${count} lines)`;
        sectionAgree.disabled = !this.canMark;
        sectionAgree.onclick = () => { void this.writeSectionMark(scope, 'agreed'); };
      };
      if (agreement.allVisible && agreement.scope) {
        armAgree(agreement.scope, agreement.lineCount);
      } else {
        sectionAgree.textContent = `Show all ${agreement.lineCount} lines to agree with this section`;
        sectionAgree.disabled = false;
        sectionAgree.onclick = () => {
          this.host.showSectionLines?.(line.index);
          const next = this.host.sectionAgreement?.(line.index);
          // The rail rebuilds this box on the fold change. The phone sheet does not, so this
          // same button becomes Agree once every line is visible.
          if (next?.allVisible && next.scope) armAgree(next.scope, next.lineCount);
        };
      }
      place(sectionAgree);
    }
    const choose = (status: StatusChoice, reason?: string, via: MarkVia = 'click'): boolean => {
      if (!this.canMark) return false;

      options.onChosen?.(status);
      // Resolve the original passage by identity if remote edits moved it.
      const fresh = this.lines.find(now => now.hash === line.hash && now.occurrence === line.occurrence && now.text === line.text);
      if (!fresh) return false;
      void this.writeMark(fresh, status, reason, via);
      return true;
    };

    const actions = document.createElement('div');
    actions.className = 'plm-actions';
    const current: StatusChoice = mine?.current && mine.mark.status !== 'skimmed' ? mine.mark.status : 'unseen';
    const choices: StatusChoice[] = ['seen', 'agreed'];
    if (this.canApprove || !LINE_MARK_POLICY.approveRequiresOwner) choices.push('approved');
    choices.push('rejected');
    const reasonRow = document.createElement('form');
    reasonRow.className = 'plm-reason';
    reasonRow.hidden = true;
    // Step B4d: a Reject covers the selected lines when this line is one of them.
    const coverage = this.selection.length > 1 && this.selection.includes(line.index) ? [...this.selection] : [line.index];
    if (coverage.length > 1) {
      const scopeNote = document.createElement('p');
      scopeNote.className = 'plm-reject-scope';
      scopeNote.textContent = `This Reject covers lines ${coverage[0] + 1}–${coverage[coverage.length - 1] + 1} (${coverage.length} lines).`;
      const clearSel = document.createElement('button');
      clearSel.type = 'button';
      clearSel.className = 'plm-link';
      clearSel.textContent = 'Only this line';
      clearSel.onclick = () => this.clearSelection();
      scopeNote.append(' ', clearSel);
      reasonRow.append(scopeNote);
    }
    const reasonInput = document.createElement('input');
    reasonInput.type = 'text';
    reasonInput.maxLength = 500;
    reasonInput.placeholder = 'Reason (one line)';
    reasonInput.setAttribute('aria-label', 'Reason for rejecting this line');
    if (mine?.current && mine.mark.status === 'rejected' && mine.mark.reason) reasonInput.value = mine.mark.reason;
    // Step B4c: reason chips (static defaults, and hints an AI author gave for this line).
    const chips = document.createElement('div');
    chips.className = 'plm-chips';
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Common reasons');
    for (const chip of this.rejectChips(line.index)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'plm-chip';
      b.dataset.source = chip.source;
      b.textContent = chip.label;
      if (chip.by) b.title = `Suggested by ${actorLabel(chip.by)}`;
      b.onclick = () => {
        reasonInput.value = REJECT_CHIPS.fill === 'append' && reasonInput.value.trim() ? `${reasonInput.value.trim()}; ${chip.label}` : chip.label;
        reasonInput.removeAttribute('aria-invalid');
        reasonInput.focus({ preventScroll: true });
      };
      chips.append(b);
    }
    // Step B4d: "I'd agree if…" turns the Reject into an objection only you can clear.
    const conditionInput = document.createElement('input');
    conditionInput.type = 'text';
    conditionInput.maxLength = OBJECTION_POLICY.maxCondition;
    conditionInput.className = 'plm-condition';
    conditionInput.placeholder = 'I’d agree if… (optional)';
    conditionInput.setAttribute('aria-label', 'I would agree if (optional): what would change your mind');
    const reasonSave = document.createElement('button');
    reasonSave.type = 'submit';
    reasonSave.textContent = coverage.length > 1 ? `Reject ${coverage.length} lines` : 'Reject';
    const hint = document.createElement('p');
    hint.className = 'plm-reject-hint';
    hint.setAttribute('role', 'status');
    hint.hidden = true;
    reasonRow.append(reasonInput, chips, conditionInput, reasonSave, hint);
    reasonRow.onsubmit = (event) => {
      event.preventDefault();
      const reason = reasonInput.value.trim();
      if (!reason) { reasonInput.focus(); reasonInput.setAttribute('aria-invalid', 'true'); return; }
      const condition = conditionInput.value.trim();
      if (condition || coverage.length > 1) {
        if (isGuestActor(this.me()) && !OBJECTION_POLICY.guestsMayObject) {
          hint.hidden = false;
          hint.textContent = coverage.length > 1
            ? 'Sign in to reject several lines at once or to say what would change your mind: only a verified person can later clear it.'
            : 'Sign in to add “I’d agree if…”: only a verified person can later clear it. Clear that field to reject this line.';
          return;
        }

        options.onChosen?.('rejected');
        void this.createObjection(coverage, reason, condition);
        return;
      }
      choose('rejected', reason);
    };
    const escClose = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      reasonRow.hidden = true;
      (event.target as HTMLElement).blur();
    };
    reasonInput.addEventListener('keydown', escClose);
    conditionInput.addEventListener('keydown', escClose);
    const openReason = () => {
      if (!this.canMark) return;
      reasonRow.hidden = false;
      reasonInput.focus({ preventScroll: true });
    };
    // Margin layout (decision 8): Agree and Reject first, as the two primary buttons; the rest under More.
    const moreMarks = document.createElement('div');
    moreMarks.className = 'plm-actions plm-more-marks';
    const ordered = margin
      ? [...MARGIN_POLICY.primaryMarks.filter(c => choices.includes(c as StatusChoice)), ...MARGIN_POLICY.moreItems.filter(c => choices.includes(c as StatusChoice))] as StatusChoice[]
      : choices;
    for (const choice of ordered) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'plm-choice';
      btn.dataset.status = choice;
      btn.setAttribute('aria-pressed', String(current === choice));
      const primary = margin && MARGIN_POLICY.primaryMarks.includes(choice);
      const g = document.createElement('span'); g.className = 'plm-choice-glyph'; g.textContent = STATUS_GLYPH[choice]; g.setAttribute('aria-hidden', 'true');
      const l = document.createElement('span');
      l.textContent = primary
        ? (choice === 'agreed' ? (current === 'agreed' ? 'Agreed' : 'Agree') : (current === 'rejected' ? 'Rejected' : 'Reject'))
        : choice === 'rejected' ? 'Reject…' : STATUS_LABEL[choice].replace('Agreed', 'Agree').replace('Approved', 'Approve');
      btn.append(g, l);
      if (primary) {
        const key = document.createElement('kbd');
        key.className = 'plm-key';
        key.textContent = choice === 'agreed' ? 'A' : 'R';
        key.setAttribute('aria-hidden', 'true');
        btn.append(key);
        btn.classList.add('plm-primary');
        btn.title = choice === 'agreed' ? 'Agree with this line (key A)' : 'Reject this line, with a one-line reason (key R)';
      }
      btn.disabled = !this.canMark;
      btn.onclick = () => {
        if (choice === 'rejected') { openReason(); return; }
        choose(choice);
      };
      (margin && !primary ? moreMarks : actions).append(btn);
    }
    if (mine) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'plm-choice plm-clear';
      clear.textContent = 'Clear my mark';
      clear.disabled = !this.canMark;
      clear.onclick = () => {
        options.onChosen?.('unseen');
        void this.writeMark(line, 'unseen');
      };
      (margin ? moreMarks : actions).append(clear);
    }
    let openMore: (() => void) | undefined;
    let toggleMore: (() => void) | undefined;
    if (margin) {
      actions.classList.add('plm-primary-row');
      const moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'plm-more-btn';
      moreBtn.textContent = '⋯';
      moreBtn.setAttribute('aria-label', 'More marks for this line');
      moreBtn.setAttribute('aria-expanded', 'false');
      moreBtn.setAttribute('aria-controls', more.id);
      moreBtn.title = 'More: Approve, Seen, Clear my mark, Flag uncertain, Offer another wording, Explain, Time-to-live, decision or context';
      const setMore = (open: boolean) => { more.hidden = !open; moreBtn.setAttribute('aria-expanded', String(open)); };
      moreBtn.onclick = () => setMore(more.hidden);
      toggleMore = () => setMore(more.hidden);
      openMore = () => { setMore(true); (more.querySelector('button:not(:disabled)') as HTMLButtonElement | null)?.focus({ preventScroll: true }); };
      actions.append(moreBtn);
      more.append(moreMarks, ...flagMore);
      if (extras.querySelector('.plm-extras-links')?.childElementCount || extras.querySelector('form')) more.append(extras);
      if (tierRow) more.append(tierRow);
      root.append(actions, more, reasonRow, thread);
    } else {
      root.append(actions, reasonRow);
    }

    // Everyone's marks on this line.
    const team = this.summary?.team ?? [];
    const list = document.createElement('ul');
    list.className = 'plm-team';
    const teamStatuses: string[] = [];
    for (const member of team) {
      const entry = state?.marks.get(actorKey(member));
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.textContent = actorKey(member) === me ? `${actorLabel(member)} (you)` : actorLabel(member);
      // Cross invitation: an AI is shown with the human who added it — "Izzy — added by Eric".
      const sponsor = this.agentSponsors[member] ?? this.agentSponsors[actorKey(member)];
      if (sponsor?.sponsorName) {
        who.textContent = `${this.aiName(member)} — added by ${sponsor.sponsorName}`;
        who.dataset.sponsor = sponsor.sponsorName;
        if (sponsor.runtime) who.title = `${this.aiName(member)} runs on ${sponsor.runtime}; ${sponsor.sponsorName} added it to this document.`;
      }
      const what = document.createElement('span');
      what.className = 'plm-team-status';
      const status = !entry ? 'unseen' : shownStatus(entry);
      teamStatuses.push(status);
      what.dataset.status = status;
      what.textContent = status === 'changed' ? 'Changed since marked' : shownLabel(status);
      // Step B3b: how a Seen was earned ("Seen by scrolling" vs "Seen, marked").
      if (entry?.current && (entry.mark.status === 'seen' || (entry.mark.status === 'agreed' && entry.mark.via === 'dwell')) && !entry.mark.hidden) {
        const via = (entry.mark.via ?? 'api') as MarkVia;
        what.textContent += ` ${via === 'click' || via === 'key' ? '(marked)' : `(${VIA_LABEL[via]})`}`;
        what.dataset.via = via;
      }
      if (entry?.carried) { what.textContent += ' · carried over a small edit'; what.dataset.carried = 'true'; }
      if (entry?.current && entry.mark.status === 'rejected' && entry.mark.reason) what.textContent += `: ${entry.mark.reason}`;
      li.append(who, what);
      // Step B4c: an AI's rationale for its mark.
      if (entry?.current && entry.mark.why) {
        const why = document.createElement('span');
        why.className = 'plm-why';
        why.textContent = `Why: ${entry.mark.why}`;
        li.append(why);
      }
      // Evidence (Fable's rule): an AI mark shows what it checked, or reads "claimed".
      if (entry?.current && !entry.mark.hidden && entry.mark.via === 'proxy' && entry.mark.proxy) {
        what.textContent += ` (ratified from ${this.aiName(entry.mark.proxy.familiar)}, confidence ${entry.mark.proxy.confidence})`;
        what.dataset.via = 'proxy';
      }
      if (entry?.current && entry.mark.evidence && !entry.mark.hidden) {
        const ev = document.createElement('span');
        ev.className = 'plm-evidence';
        ev.textContent = `Evidence: ${entry.mark.evidence}`;
        li.append(ev);
      } else if (entry?.current && isClaimedMark(entry.mark)) {
        const claimed = document.createElement('span');
        claimed.className = 'plm-claimed';
        claimed.textContent = EVIDENCE_POLICY.claimedLabel;
        claimed.title = 'This AI gave no evidence for its mark: treat it as a claim, not a check.';
        li.append(claimed);
      }
      list.append(li);
    }
    if (margin && MARKED_BY_POLICY.foldInLineTab) tail.push(this.markedByFoldEl(line.index, list, teamStatuses));
    else if (margin) tail.push(list);
    else root.append(list);
    return {
      root, openReason, scope: coverage, choose: (status, via) => choose(status, undefined, via ?? 'click'), ...(askControl ? { ask: askControl } : {}),
      flipTier: () => setTier(flippedTier(tierView?.tier ?? TIER_POLICY.defaultTier)),
      ...(margin ? { tail, openMore, toggleMore } : {}),
    };
  }

  private openMenu(line: DocLine, dot: HTMLElement): void {
    this.closeMenu();
    const phone = isPhone();
    const menu = document.createElement('div');
    menu.className = phone ? 'plm-menu plm-sheet' : 'plm-menu';
    menu.dataset.line = String(line.index);
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', 'Mark this line');

    const head = document.createElement('div');
    head.className = 'plm-menu-head';
    const title = document.createElement('strong');
    title.textContent = 'Mark this line';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'plm-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close line marks');
    close.onclick = () => this.closeMenu();
    head.append(title, close);
    const box = this.buildMarkBox(line, { onChosen: () => this.closeMenu() });
    menu.append(head, box.root);
    document.body.append(menu);
    if (!phone) {
      // Below the line's first row, so the line being marked stays readable; above it if no room.
      const r = dot.getBoundingClientRect();
      const width = 280;
      const left = Math.min(window.innerWidth - width - 8, Math.max(8, r.left));
      menu.style.left = `${left}px`;
      const h = menu.offsetHeight;
      const below = r.bottom + 4;
      const top = below + h <= window.innerHeight - 8 ? below : Math.max(8, r.top - h - 4);
      menu.style.top = `${top}px`;
    }
    this.menu = menu;
    this.menuDot = dot;
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
    document.addEventListener('keydown', this.onDocKeyDown, true);
    this.menuCleanup = () => {
      document.removeEventListener('pointerdown', this.onDocPointerDown, true);
      document.removeEventListener('keydown', this.onDocKeyDown, true);
    };
    (menu.querySelector('.plm-actions button:not(:disabled)') as HTMLButtonElement | null)?.focus({ preventScroll: true });
  }

  private menuDot: HTMLElement | null = null;

  /** One listener pair for whichever menu is open (no per-menu closures that could go stale). */
  private onDocPointerDown = (event: Event): void => {
    const target = event.target as Node | null;
    if (!this.menu || !target) return;
    if (this.menu.contains(target) || this.menuDot?.contains(target)) return;
    // A tap on another dot is handled by that dot's click (it reopens the menu there).
    this.closeMenu();
  };

  private onDocKeyDown = (event: KeyboardEvent): void => {
    if (!this.menu || event.key !== 'Escape') return;
    event.stopPropagation();
    const dot = this.menuDot;
    this.closeMenu();
    dot?.focus({ preventScroll: true });
  };

  private closeMenu(): void {
    this.menuCleanup?.();
    this.menuCleanup = null;
    this.menu?.remove();
    this.menu = null;
    this.menuDot = null;
  }

  // --------------------------------------------------------------------------
  // Familiar proxy marks (Mike, 2026-09-19)
  // --------------------------------------------------------------------------

  /** My brief: my Familiar's current proxies, bucketed (null when I have no Familiar here). */
  private computeBrief(reviewMarks: ReviewMarkLike[]): void {
    const me = this.me();
    const verified = this.serverMe?.trust === 'verified';
    if (!verified || !this.serverFamiliar || !this.summary) {
      this.brief = null;
      this.briefByLine = new Map();
      return;
    }
    const suggestionLines: number[] = [];
    for (const mark of reviewMarks) {
      if (!mark.open || mark.kind === 'comment' || typeof mark.pos !== 'number') continue;
      const index = this.lineAtPos(mark.pos);
      if (index >= 0) suggestionLines.push(index);
    }
    this.brief = evaluateProxies({
      proxies: this.serverProxies,
      human: me,
      familiar: this.serverFamiliar.familiar,
      lines: this.lines,
      states: this.states,
      held: heldLines({ issues: this.summary.issues, human: me, suggestionLines }),
      humanIssueLines: humanIssueLines(this.summary.issues, me),
    });
    this.briefByLine = new Map(this.brief.items.map(item => [item.lineIndex, item]));
  }

  /** The proxy brief for this viewer (null: no Familiar, not signed in, or not loaded). */
  proxyBrief(): ProxyBrief | null { return this.brief; }
  /** The proxy on a line, when my Familiar marked it and I have not. */
  proxyOnLine(index: number): ProxyItem | null { return this.briefByLine.get(index) ?? null; }
  familiarBinding(): FamiliarBinding | null { return this.serverFamiliar; }
  /** AIs present in the document (active agent keys): the choices for "My Familiar". */
  familiarChoices(): Array<{ actor: string; label: string }> {
    return this.agentKeyActors.map(actor => ({ actor, label: this.aiName(actor) }));
  }
  /** An AI's name as the person who added it typed it ("Claude COS"), else its actor label. */
  aiName(actor: string): string {
    return this.agentKeyLabels[actor] ?? this.agentKeyLabels[actorKey(actor)] ?? actorLabel(actor);
  }
  undoableRatifications(): Array<{ id: string; at: string; count: number; familiar: string }> { return this.serverRatifications; }
  isVerifiedViewer(): boolean { return this.serverMe?.trust === 'verified'; }

  private async proxyPost(kind: string, path: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: Record<string, any> }> {
    const slug = this.host.slug();
    if (!slug) return { ok: false, status: 0, body: {} };
    this.writesInFlight += 1;
    try {
      const response = await fetch(`${this.host.apiBase()}/documents/${encodeURIComponent(slug)}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...this.host.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await response.json().catch(() => ({})) as Record<string, any>;
      this.proxyWrites.push({ kind, ok: response.ok, status: response.status });
      if (!response.ok) this.toast(json.error || 'Could not save that');
      return { ok: response.ok, status: response.status, body: json };
    } catch {
      this.proxyWrites.push({ kind, ok: false, status: 0 });
      this.toast('Could not save that (offline?)');
      return { ok: false, status: 0, body: {} };
    } finally {
      this.writesInFlight -= 1;
      this.fetchSeq += 1;
      await this.refresh();
    }
  }

  /** "My Familiar": choose an AI present in the document, or none. */
  async setFamiliar(actor: string | null): Promise<boolean> {
    return (await this.proxyPost('familiar', '/familiar', { familiar: actor })).ok;
  }

  /**
   * "Ratify all": my proxy-agreed lines in the brief become my Agreed marks (via proxy). The
   * server re-checks each one; lines that stopped qualifying come back as skipped.
   */
  async ratifyAll(): Promise<{ ok: boolean; id?: string; count: number; skipped: number }> {
    const result = await this.ratifyAllInner();
    if (result.ok && result.id) {
      const id = result.id;
      this.pushUndo('ratify', `ratified ${result.count} ${result.count === 1 ? 'line' : 'lines'} your Familiar read for you`,
        async () => { const ok = await this.undoRatification(id); return ok ? { ok: true } : { ok: false, reason: 'That ratification can no longer be undone.' }; });
    }
    return result;
  }

  private async ratifyAllInner(): Promise<{ ok: boolean; id?: string; count: number; skipped: number }> {
    const ids = (this.brief?.ratify ?? []).map(item => item.proxy.id);
    if (ids.length === 0) return { ok: false, count: 0, skipped: 0 };
    const result = await this.proxyPost('ratify', '/proxy/ratify', { proxyIds: ids });
    const r = result.body.ratification as { id?: string; count?: number } | undefined;
    return { ok: result.ok, id: r?.id, count: r?.count ?? 0, skipped: Array.isArray(result.body.skipped) ? result.body.skipped.length : 0 };
  }

  async undoRatification(id: string): Promise<boolean> {
    return (await this.proxyPost('undo', `/proxy/ratifications/${encodeURIComponent(id)}/undo`, {})).ok;
  }

  /** "Review the F flagged": Next issue walks only the flagged lines, then stops. */
  reviewFlagged(): boolean {
    const lines = (this.brief?.flagged ?? []).map(item => item.lineIndex);
    if (lines.length === 0) return false;
    this.walkOnly = { lines, visited: [] };
    this.gotoNextIssue();
    return true;
  }

  stopReviewFlagged(): void {
    this.walkOnly = null;
    this.notifyListeners();
  }

  /** While reviewing the flagged lines: how far along (null when not reviewing). */
  flaggedWalk(): { total: number; visited: number; current: number | null } | null {
    if (!this.walkOnly) return null;
    const visited = this.walkOnly.visited;
    return { total: this.walkOnly.lines.length, visited: visited.length, current: visited.length ? visited[visited.length - 1] : null };
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { console.warn('[plm] listener failed', error); }
    }
  }

  private gotoNextFlagged(): void {
    const walk = this.walkOnly!;
    const next = walk.lines.find(index => !walk.visited.includes(index));
    if (next === undefined) {
      this.walkOnly = null;
      this.toast('You have been through every line your Familiar flagged.');
      this.notifyListeners();
      return;
    }
    walk.visited.push(next);
    this.host.revealLine?.(next);
    const view = this.view;
    const line = this.lines[next];
    if (!(this.host.focusLine?.(next)) && view && line) {
      (view.nodeDOM(line.pos) as HTMLElement | null)?.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
    const dom = view && line ? view.nodeDOM(line.pos) as HTMLElement | null : null;
    if (dom) this.flash(dom);
    this.countEl.dataset.current = `flagged ${next + 1}`;
    this.notifyListeners();
  }

  /** The note in a line's mark box about my Familiar's proxy on it. */
  private buildProxyNote(item: ProxyItem): HTMLElement {
    const box = document.createElement('div');
    box.className = 'plm-proxy-note';
    box.dataset.bucket = item.bucket;
    const familiar = this.aiName(item.proxy.familiar);
    const head = document.createElement('p');
    head.className = 'plm-proxy-head';
    const verb = item.proxy.status === 'rejected-suggested' ? 'recommends rejecting this line'
      : item.proxy.status === 'seen' ? 'read this line for you (no position)'
      : `agrees for you (confidence ${item.proxy.confidence})`;
    head.textContent = `Your Familiar ${familiar} ${verb}.`;
    const evidence = document.createElement('p');
    evidence.className = 'plm-evidence';
    evidence.textContent = `Evidence: ${item.proxy.evidence}`;
    const status = document.createElement('p');
    status.className = 'plm-proxy-status';
    status.textContent = item.bucket === 'ratify'
      ? 'Not your mark until you ratify it (Ratify all at the top of the rail, or Agree here).'
      : item.bucket === 'reject'
        ? 'Not your mark: reject it yourself if you agree.'
        : `Not your mark. ${flaggedWhy(item, PROXY_POLICY.ratifyThreshold).replace(/^./, c => c.toUpperCase())}.`;
    box.append(head, evidence, status);
    return box;
  }

  // --------------------------------------------------------------------------
  // Next issue
  // --------------------------------------------------------------------------

  /**
   * Step B4c: Next issue follows stakes (ISSUE_PRIORITY), then document order. With a sitting
   * budget, once the reader has visited that many Issues it stops and says what is left.
   */
  /** The Review list keeps the existing sitting budget while choosing its own document order. */
  visitReviewItem(key: string, line: number): boolean {
    if (this.sittingStopped) this.startSitting();
    const sitting = this.sittingSummary();
    if (sitting.reached) {
      this.renderBudget();
      this.host.onBudgetReached?.(sitting);
      return false;
    }
    const ranked = this.ranked.find(r => ('lineIndex' in r.issue && typeof r.issue.lineIndex === 'number' ? r.issue.lineIndex : this.lineAtPos(r.issue.pos ?? -1)) === line);
    this.visitIssue(ranked?.key ?? key);
    this.renderBudget();
    return true;
  }

  gotoNextIssue(): void {
    if (this.walkOnly) { this.gotoNextFlagged(); return; }
    if (this.host.nextReview) { this.host.nextReview(); return; }
    let ranked = this.ranked.filter(r => r.issue.pos !== null);
    // Accord layout stage 2: the Issues that need the viewer (the pill's count) come first.
    if (NEXT_ISSUE_POLICY.viewerFirst) {
      const me = this.me();
      const mine = ranked.filter(r => issueNeedsViewer(r.issue, me, [this.host.actor()]));
      ranked = [...mine, ...ranked.filter(r => !mine.includes(r))];
    }
    const view = this.view;
    if (!view || ranked.length === 0) return;
    if (this.sittingStopped) this.startSitting();
    const sitting = this.sittingSummary();
    if (sitting.reached) {
      this.renderBudget();
      this.host.onBudgetReached?.(sitting);
      this.budgetEl.dataset.flash = String(Date.now());
      return;
    }
    const pick = nextRankedIssue(ranked, this.lastIssueKey, this.lastIssuePlace);
    if (!pick) return;
    const next = pick.issue;
    this.lastIssueKey = pick.key;
    this.lastIssuePlace = { priority: pick.priority, pos: next.pos as number };
    this.visitIssue(pick.key);
    this.countEl.dataset.priority = pick.rule;
    this.countEl.dataset.why = pick.explicit ? `${PRIORITY_LABEL[pick.rule]} · ${actorLabel(pick.explicit.by)}: ${pick.explicit.reason ?? ''}` : PRIORITY_LABEL[pick.rule];
    const lineIndex = 'lineIndex' in next && next.lineIndex !== null ? next.lineIndex : this.lineAtPos(next.pos as number);
    // Step B2: the next issue may sit in a folded section: unfold it first.
    if (lineIndex >= 0) this.host.revealLine?.(lineIndex);
    const target = this.issueElement(view, next);
    if (!target) return;
    // Step 1b: with the reading walk on, Next issue moves the focus line (which scrolls there).
    if (!(lineIndex >= 0 && this.host.focusLine?.(lineIndex))) {
      target.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
    // Highlight with an overlay: ProseMirror re-reads its own DOM when attributes change on it.
    this.flash(target);
    if ('lineIndex' in next && next.lineIndex !== null) {
      const dot = this.gutter.querySelector(`.plm-dot[data-line="${next.lineIndex}"]`) as HTMLButtonElement | null;
      dot?.focus({ preventScroll: true });
    }
    this.countEl.dataset.current = next.type === 'line' ? `line ${next.lineIndex + 1}`
      : next.type === 'ask' ? `ask ${next.lineIndex + 1}`
      : next.type === 'uncertain' ? `uncertain ${next.lineIndex + 1}`
      : next.type === 'objection' ? `objection ${(next.lineIndex ?? -1) + 1}`
      : next.type === 'alternative' ? `alternative ${next.lineIndex + 1}`
      : next.type === 'ttl' ? `ttl ${next.lineIndex + 1}`
      : next.type === 'do' ? `do ${next.lineIndex + 1}`
      : next.type;
    this.renderBudget();
  }

  private issueElement(view: EditorView, issue: ProofIssue): HTMLElement | null {
    if ('lineIndex' in issue && issue.lineIndex !== null) {
      const line = this.lines[issue.lineIndex];
      return line ? view.nodeDOM(line.pos) as HTMLElement | null : null;
    }
    if (issue.type !== 'comment' && issue.type !== 'suggestion') return null;
    const markEl = view.dom.querySelector(`[data-mark-id="${CSS.escape(issue.markId)}"]`) as HTMLElement | null;
    if (markEl) return markEl;
    try {
      const at = view.domAtPos(issue.pos ?? 0);
      const node = at.node.nodeType === Node.ELEMENT_NODE ? at.node as HTMLElement : at.node.parentElement;
      return node?.closest('p,li,h1,h2,h3,h4,h5,h6,tr,pre,blockquote') as HTMLElement | null ?? node;
    } catch {
      return null;
    }
  }

  private flash(target: HTMLElement): void {
    const container = this.gutter.parentElement;
    if (!container) return;
    container.querySelector('.plm-flash')?.remove();
    const c = container.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'plm-flash';
    el.setAttribute('aria-hidden', 'true');
    el.style.top = `${Math.round(r.top - c.top - 4)}px`;
    el.style.left = `${Math.round(r.left - c.left - 6)}px`;
    el.style.width = `${Math.round(r.width + 12)}px`;
    el.style.height = `${Math.round(r.height + 8)}px`;
    container.append(el);
    setTimeout(() => el.remove(), 2200);
  }

  /**
   * Mike, 2026-09-23 (usability brief): the viewer explicitly marks a captured section in one request (the batch form of the
   * line-marks route), then gets a one-step Undo that restores each line's earlier mark.
   */
  async writeSectionMark(scope: SectionScope, status: StatusChoice): Promise<boolean> {
    const slug = this.host.slug();
    if (!slug || !this.canMark || status === 'rejected') return false;
    const by = this.me();
    const me = actorKey(by);
    const indices = resolveSectionScope(scope, this.lines);
    let apply: number[];
    if (status === 'unseen') {
      apply = indices.filter(index => this.states[index]?.marks.has(me));
    } else {
      const plan = planSectionMark(indices, status, index => {
        const entry = this.states[index]?.marks.get(me);
        return entry ? { status: entry.mark.status, reason: entry.mark.reason ?? null, current: entry.current } : null;
      });
      apply = plan.apply;
    }
    if (apply.length === 0) {
      this.toast(`Nothing to change: every line in this section already has that mark${status === 'unseen' ? '' : ' or a stronger one'}.`);
      return true;
    }
    type Entry = { line: DocLine; previous: LineMark | null; replaceIds: string[] };
    const entries: Entry[] = apply.map(index => {
      const state = this.states[index];
      const own = state ? [...state.marks.values()].filter(e => actorKey(e.mark.by) === me) : [];
      const current = own.find(e => e.current)?.mark ?? null;
      return { line: this.lines[index], previous: current, replaceIds: own.map(e => e.mark.id).filter(id => !id.startsWith('local-')) };
    });
    const post = async (lines: Array<Record<string, unknown>>, batchStatus: StatusChoice): Promise<boolean> => {
      this.writesInFlight += 1;
      try {
        const response = await fetch(`${this.host.apiBase()}/documents/${encodeURIComponent(slug)}/line-marks`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { ...this.host.authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ by, status: batchStatus, lines, section: { heading: scope.heading.slice(0, 200) } }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({})) as { error?: string };
          this.toast(body.error || 'Could not save the marks');
          return false;
        }
        return true;
      } catch {
        this.toast('Could not save the marks (offline?)');
        return false;
      } finally {
        this.writesInFlight -= 1;
        this.fetchSeq += 1;
        void this.refresh();
      }
    };
    // Optimistic: show the new marks at once.
    const previous = this.serverMarks;
    const anchors = entries.map(entry => anchorForLine(entry.line));
    const replaced = new Set(entries.flatMap(entry => entry.replaceIds));
    const anchorKeys = new Set(anchors.map(anchor => `${anchor.hash}:${anchor.occurrence}`));
    this.serverMarks = this.serverMarks.filter(mark => !replaced.has(mark.id)
      && !(actorKey(mark.by) === me && anchorKeys.has(`${mark.anchor.hash}:${mark.anchor.occurrence}`)));
    if (status !== 'unseen') {
      const at = new Date().toISOString();
      anchors.forEach((anchor, i) => this.serverMarks.push({ id: `local-${Date.now()}-${i}`, by, status, reason: null, at, anchor }));
    }
    this.recompute();
    this.sectionWrites += 1;
    const ok = await post(entries.map((entry, i) => ({ anchor: anchors[i], replaceIds: entry.replaceIds })), status);
    if (!ok) {
      this.serverMarks = previous;
      this.recompute();
      return false;
    }
    const label = status === 'unseen' ? 'Cleared' : STATUS_LABEL[status];
    // One step back: every line gets the mark it had before (or none). The toast and the rail's
    // Undo both run this, and running it twice is harmless (it restores the same marks).
    const restore = async (): Promise<UndoOutcome> => {
      this.sectionWrites += 1;
      const ok = await post(entries.map((entry, i) => ({
        anchor: anchors[i],
        status: entry.previous ? entry.previous.status : 'unseen',
        ...(entry.previous?.reason ? { reason: entry.previous.reason } : {}),
      })), 'unseen');
      return ok ? { ok: true } : { ok: false, reason: 'Could not undo the section mark.' };
    };
    const description = `${status === 'unseen' ? 'cleared' : (STATUS_LABEL[status] ?? status).toLowerCase()} ${entries.length} ${entries.length === 1 ? 'line' : 'lines'} in “${scope.heading.slice(0, 40)}”`;
    this.pushUndo('section-mark', description, restore, async () => {
      this.sectionWrites += 1;
      const ok = await post(entries.map((entry, i) => ({ anchor: anchors[i], replaceIds: entry.replaceIds })), status);
      return ok ? { ok: true } : { ok: false, reason: 'Could not redo the section mark.' };
    });
    this.toastWithAction(`${label}: ${entries.length} ${entries.length === 1 ? 'line' : 'lines'} in “${scope.heading.slice(0, 40)}”.`, 'Undo', () => {
      void restore();
    }, FOLDING.undoToastMs);
    return true;
  }

  /** Test hook: how many section (batch) requests this page has sent. */
  private sectionWrites = 0;

  private toastWithAction(message: string, label: string, action: () => void, ms: number): void {
    document.querySelector('.plm-toast[data-action]')?.remove();
    const el = document.createElement('div');
    el.className = 'plm-toast';
    el.dataset.action = 'true';
    el.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = message;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'plm-toast-action';
    button.textContent = label;
    button.onclick = () => { el.remove(); action(); };
    el.append(text, button);
    document.body.append(el);
    setTimeout(() => el.remove(), ms);
  }

  private toast(message: string): void {
    const el = document.createElement('div');
    el.className = 'plm-toast';
    el.setAttribute('role', 'alert');
    el.textContent = message;
    document.body.append(el);
    setTimeout(() => el.remove(), 4000);
  }

  // --------------------------------------------------------------------------
  // Steps B4c + B4d: review aids and objections
  // --------------------------------------------------------------------------

  /** Pending suggestions (ids) whose start sits on this line. */
  // --------------------------------------------------------------------------
  /**
   * What is open for the viewer on a line: open suggestions and comments (with their reply
   * counts), asks still owed by the viewer, and open objections. A change here reopens a folded line.
   */
  openItemsOnLine(index: number): string[] {
    const out: string[] = [];
    for (const mark of this.reviewMarkCache) {
      if (!mark.open || typeof mark.pos !== 'number' || this.lineAtPos(mark.pos) !== index) continue;
      out.push(`${mark.kind === 'comment' ? 'c' : 's'}:${mark.id}:${mark.replies?.length ?? 0}`);
    }
    const me = actorKey(this.me());
    const ask = this.askViews.find(v => v.lineIndex === index);
    if (ask && ask.openFor.some(a => actorKey(a) === me || a === ANYONE)) out.push(`a:${ask.ask.id}`);
    for (const o of this.objectionsByLine.get(index) ?? []) out.push(`o:${o.objection.id}`);
    return out;
  }

  /** Opens the line's mark sheet (phones) or popover (desktop) anchored at `anchor`. */
  openLineSheet(index: number, anchor: HTMLElement): boolean {
    const line = this.lines[index];
    if (!line) return false;
    this.openMenu(line, anchor);
    return true;
  }

  suggestionsOnLine(index: number): string[] {
    return this.reviewMarkCache
      .filter(mark => mark.open && mark.kind !== 'comment' && typeof mark.pos === 'number' && this.lineAtPos(mark.pos) === index)
      .map(mark => mark.id);
  }

  flagsOn(index: number): UncertainFlag[] { return this.flagsByLine.get(index) ?? []; }
  objectionsOn(index: number): ObjectionView[] { return this.objectionsByLine.get(index) ?? []; }
  /** Lines with an open uncertain flag (the reading walk reads them slower). */
  flaggedLineSet(): Set<number> { return new Set(this.flagsByLine.keys()); }
  /** This viewer's Issues in Next-issue order. */
  rankedIssues(): RankedIssue[] { return this.ranked; }

  /** An AI's notes (why, reject hints, priority) on a suggestion. */
  notesForMark(markId: string): ReviewNote[] {
    return this.serverNotes.filter(note => note.target.kind === 'suggestion' && note.target.markId === markId);
  }

  /** Step B4c: the reason chips for a Reject on this line. */
  rejectChips(index: number) {
    const hints: Array<{ hint: string; by: string }> = [];
    const onLine = new Set(this.suggestionsOnLine(index));
    for (const note of this.serverNotes) {
      const here = note.target.kind === 'suggestion' ? onLine.has(note.target.markId) : noteLineIndex(note, this.lines) === index;
      if (!here) continue;
      for (const hint of note.rejectHints) hints.push({ hint, by: note.by });
    }
    return rejectChipsFor(hints);
  }

  /** Changes whenever the rail's box for this line would show different aids. */
  aidsSignature(index: number): string {
    const flags = this.flagsOn(index).map(f => `${f.id}:${f.note ?? ''}`).join(',');
    const objections = this.objectionsOn(index).map(o => `${o.objection.id}:${o.repairPending}:${o.deletedLines}`).join(',');
    const chips = this.rejectChips(index).map(c => c.label).join(',');
    const alt = this.altsByLine.get(index);
    const alts = alt ? JSON.stringify([alt.options.map(o => o.id), [...alt.picks.values()].map(p => [p.by, p.hidden ? '?' : p.choice])]) : '';
    const ttl = this.ttlByLine.get(index);
    const ttlSig = ttl ? `${ttl.ttl.id}:${ttl.expired}:${ttl.notTrue}:${ttl.decayed.length}:${ttl.ttl.checks.length}` : '';
    const extras = `${alts}|${ttlSig}|${this.disagreement.has(index)}|${this.hiddenOnLine(index)}|${this.altHistoryFor(index).length}|${this.blind}`;
    return `${flags}|${objections}|${chips}|${this.selection.join(',')}|${this.canApprove}|${extras}|${this.tierSignature(index)}`;
  }

  selectionLines(): number[] { return [...this.selection]; }

  /** Step B4d: select lines a..b (inclusive) for a Reject that covers them. */
  selectLines(a: number, b: number): void {
    const lo = Math.max(0, Math.min(a, b));
    const hi = Math.min(this.lines.length - 1, Math.max(a, b));
    this.selection = hi > lo ? Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) : [];
    this.queueRender();
    for (const listener of this.listeners) { try { listener(); } catch { /* next render */ } }
  }

  /** Step B4d: a text selection across several lines becomes the Reject's lines (R). */
  selectFromEditor(): boolean {
    const view = this.view;
    if (!view || this.selection.length > 1) return this.selection.length > 1;
    const { from, to, empty } = view.state.selection;
    if (empty) return false;
    const a = this.lineAtPos(from);
    const b = this.lineAtPos(Math.max(from, to - 1));
    if (a < 0 || b < 0 || a === b) return false;
    this.selectLines(a, b);
    return true;
  }

  clearSelection(): void {
    if (this.selection.length === 0) return;
    this.selection = [];
    this.queueRender();
    for (const listener of this.listeners) { try { listener(); } catch { /* next render */ } }
  }

  private async postAid(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; body: Record<string, unknown> }> {
    const slug = this.host.slug();
    if (!slug) return { ok: false, body: {} };
    this.writesInFlight += 1;
    try {
      const response = await fetch(`${this.host.apiBase()}/documents/${encodeURIComponent(slug)}${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...this.host.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ by: this.me(), ...body }),
      });
      const json = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) this.toast(typeof json.error === 'string' ? json.error : 'Could not save');
      return { ok: response.ok, body: json };
    } catch {
      this.toast('Could not save (offline?)');
      return { ok: false, body: {} };
    } finally {
      this.writesInFlight -= 1;
      this.fetchSeq += 1;
      void this.refresh();
    }
  }

  /** Step B4c: flag a line uncertain (or change your note on your flag). */
  async flagLine(index: number, note: string): Promise<boolean> {
    const line = this.lines[index];
    if (!line || !this.canMark) return false;
    const result = await this.postAid('/flags', { anchor: anchorForLine(line), note });
    if (result.ok) this.aidWrites += 1;
    return result.ok;
  }

  async clearFlag(id: string): Promise<boolean> {
    const view = this.flagViews.find(f => f.flag.id === id) ?? null;
    const flag = view?.flag ?? null;
    const index = view?.lineIndex ?? -1;
    const result = await this.postAid(`/flags/${encodeURIComponent(id)}/clear`, {});
    if (result.ok) {
      this.aidWrites += 1;
      if (flag && index >= 0) this.pushUndo('flag', `cleared your uncertain flag on line ${index + 1}`,
        async () => { const ok = await this.withoutUndo(() => this.flagLine(index, flag.note ?? '')); return ok ? { ok: true } : { ok: false, reason: 'Could not put the flag back.' }; },
        async () => { const ok = await this.withoutUndo(() => this.clearFlag(id)); return ok ? { ok: true } : { ok: false, reason: 'Could not clear it again.' }; });
    }
    return result.ok;
  }

  /** Step B4d: a Reject with "I'd agree if…" and/or several lines becomes an objection. */
  async createObjection(indices: number[], reason: string, condition: string): Promise<boolean> {
    const lines = [...new Set(indices)].map(index => this.lines[index]).filter((line): line is DocLine => Boolean(line));
    if (lines.length === 0 || !this.canMark) return false;
    const suggestions = [...new Set(lines.flatMap(line => this.suggestionsOnLine(line.index)))];
    const result = await this.postAid('/objections', { lines: lines.map(anchorForLine), reason, condition: condition || null, suggestions });
    if (result.ok) {
      this.aidWrites += 1;
      this.selection = [];
      this.toast(`Objection recorded on ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}. Only you can clear it.`);
    }
    return result.ok;
  }

  async clearObjection(id: string, reason?: string): Promise<boolean> {
    const result = await this.postAid(`/objections/${encodeURIComponent(id)}/clear`, reason ? { reason } : {});
    if (result.ok) {
      this.aidWrites += 1;
      // Undo: the objector keeps objecting after all (the /keep route is the inverse).
      this.pushUndo('objection', 'cleared your objection',
        async () => { const ok = await this.withoutUndo(() => this.keepObjection(id)); return ok ? { ok: true } : { ok: false, reason: 'Could not put the objection back.' }; },
        async () => { const ok = await this.withoutUndo(() => this.clearObjection(id, reason)); return ok ? { ok: true } : { ok: false, reason: 'Could not clear it again.' }; });
    }
    return result.ok;
  }

  /** The objector saw the proposed repair and still objects. */
  async keepObjection(id: string): Promise<boolean> {
    const view = this.objectionViews.find(v => v.objection.id === id);
    const result = await this.postAid(`/objections/${encodeURIComponent(id)}/keep`, view ? { ack: ackFor(view) } : {});
    if (result.ok) this.aidWrites += 1;
    return result.ok;
  }

  /** Step B4c: "Ask why" was tapped on a change (the reply itself goes through the editor). */
  noteWhyAsked(markId: string, author: string | null, lineIndex?: number): void {
    // Step B7: the line lets the chat's mirror of the question point at it.
    const line = typeof lineIndex === 'number' ? this.lines[lineIndex] : undefined;
    void this.postAid('/why-asked', { markId, author, ...(line ? { anchor: anchorForLine(line) } : {}) });
  }

  private buildFlagRow(line: DocLine): HTMLElement {
    const row = document.createElement('div');
    row.className = 'plm-flag';
    const me = actorKey(this.me());
    const flags = this.flagsOn(line.index);
    for (const flag of flags) {
      const p = document.createElement('p');
      p.className = 'plm-flag-note';
      const mineFlag = actorKey(flag.by) === me;
      p.textContent = `${mineFlag ? 'You flagged' : `${actorLabel(flag.by)} flagged`} this line uncertain${flag.note ? `: ${flag.note}` : '.'}`;
      if (mineFlag || this.canApprove) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'plm-link plm-flag-clear';
        clear.textContent = 'Clear flag';
        clear.disabled = !this.canMark;
        clear.onclick = () => { void this.clearFlag(flag.id); };
        p.append(' ', clear);
      }
      row.append(p);
    }
    if (!this.canMark) return row;
    const own = flags.find(flag => actorKey(flag.by) === me);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'plm-link plm-flag-open';
    open.textContent = own ? 'Edit my note' : 'Flag uncertain…';
    open.title = `Tell readers you are unsure of this line: an amber tick, a slower read (${UNCERTAIN_POLICY.dwellFactor}×), and an Issue until each reader agrees or rejects it.`;
    const form = document.createElement('form');
    form.className = 'plm-flag-form';
    form.hidden = true;
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = UNCERTAIN_POLICY.maxNote;
    input.placeholder = 'What are you unsure of? (optional)';
    input.setAttribute('aria-label', 'What are you unsure of? (optional)');
    input.value = own?.note ?? '';
    const save = document.createElement('button');
    save.type = 'submit';
    save.textContent = own ? 'Save note' : 'Flag';
    form.append(input, save);
    open.onclick = () => { form.hidden = false; open.hidden = true; input.focus({ preventScroll: true }); };
    form.onsubmit = (event) => { event.preventDefault(); void this.flagLine(line.index, input.value.trim()); };
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      form.hidden = true; open.hidden = false; input.blur();
    });
    row.append(open, form);
    return row;
  }

  private buildObjectionCard(view: ObjectionView): HTMLElement {
    const o = view.objection;
    const card = document.createElement('div');
    card.className = 'plm-objection';
    card.dataset.objectionId = o.id;
    if (view.repairPending) card.dataset.repair = 'true';
    const mineObj = actorKey(o.by) === actorKey(this.me());
    const head = document.createElement('p');
    head.className = 'plm-objection-head';
    const strong = document.createElement('strong');
    strong.textContent = mineObj ? 'Your objection' : `Objection by ${actorLabel(o.by)}`;
    head.append(strong, `: ${o.reason}`);
    card.append(head);
    if (o.condition) {
      const cond = document.createElement('p');
      cond.className = 'plm-objection-if';
      cond.textContent = `${mineObj ? 'You’d' : 'They’d'} agree if: ${o.condition}`;
      card.append(cond);
    }
    const status = document.createElement('p');
    status.className = 'plm-objection-status';
    const covered = view.lineIndices.filter((i): i is number => i !== null).map(i => i + 1);
    status.textContent = `${describeObjection(view)}${covered.length ? ` · line${covered.length === 1 ? '' : 's'} ${covered.join(', ')}` : ''}`;
    card.append(status);
    const actions = document.createElement('div');
    actions.className = 'plm-objection-actions';
    const button = (label: string, cls: string, run: () => void) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = `plm-choice ${cls}`; b.textContent = label; b.disabled = !this.canMark;
      b.onclick = run; actions.append(b); return b;
    };
    if (mineObj) {
      if (view.repairPending) {
        const repair = document.createElement('p');
        repair.className = 'plm-objection-repair';
        repair.textContent = 'A repair was proposed. Does it meet your condition?';
        card.append(repair);
        button('Clear', 'plm-objection-clear', () => { void this.clearObjection(o.id); });
        button('Keep', 'plm-objection-keep', () => { void this.keepObjection(o.id); });
      } else {
        button('Clear my objection', 'plm-objection-clear', () => { void this.clearObjection(o.id); });
      }
    } else if (this.canApprove && OBJECTION_POLICY.ownerMayOverride) {
      const form = document.createElement('form');
      form.className = 'plm-objection-override';
      form.hidden = true;
      const input = document.createElement('input');
      input.type = 'text'; input.maxLength = OBJECTION_POLICY.maxReason;
      input.placeholder = 'Why override? (recorded)';
      input.setAttribute('aria-label', 'Reason for overriding this objection (recorded)');
      const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Override';
      form.append(input, save);
      form.onsubmit = (event) => {
        event.preventDefault();
        const reason = input.value.trim();
        if (!reason) { input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
        void this.clearObjection(o.id, reason);
      };
      button('Override…', 'plm-objection-override-open', () => { form.hidden = false; input.focus({ preventScroll: true }); });
      card.append(actions, form);
      return card;
    }
    card.append(actions);
    return card;
  }

  // --------------------------------------------------------------------------
  // Steps B4e + B4f: bundles, alternatives, blind marking, Explain, times-to-live
  // --------------------------------------------------------------------------

  /** Where a suggestion is on this page, and whether it is still pending. */
  private locateSuggestion(markId: string): { state: MemberState; lineIndex: number | null } {
    const mark = this.reviewMarkCache.find(m => m.id === markId);
    if (!mark) return { state: 'missing', lineIndex: null };
    if (!mark.open) return { state: mark.status === 'rejected' ? 'rejected' : mark.status === 'accepted' ? 'accepted' : 'missing', lineIndex: null };
    return { state: 'pending', lineIndex: typeof mark.pos === 'number' ? this.lineAtPos(mark.pos) : null };
  }

  /** The open bundle a suggestion belongs to (evaluated against this page). */
  bundleForMark(markId: string): BundleView | null {
    return this.bundleViews.find(view => view.bundle.status === 'open' && view.bundle.members.some(m => m.markId === markId)) ?? null;
  }

  bundleList(): BundleView[] { return this.bundleViews; }

  /** Step B4e: the page applied or rejected a bundle in its editor: record it on the server. */
  async recordBundleDecision(id: string, decision: 'accepted' | 'rejected'): Promise<boolean> {
    const result = await this.postAid(`/bundles/${encodeURIComponent(id)}/decision`, { decision });
    if (result.ok) this.extrasWrites += 1;
    return result.ok;
  }

  altSetFor(index: number): AltSetView | null { return this.altsByLine.get(index) ?? null; }

  private hiddenOnLine(index: number): number {
    const state = this.states[index];
    const marks = state ? [...state.marks.values()].filter(e => e.current && e.mark.hidden).length : 0;
    const set = this.altsByLine.get(index);
    const picks = set ? [...set.picks.values()].filter(p => p.hidden).length : 0;
    return marks + picks;
  }

  private altHistoryFor(index: number): ProofAlternative[] {
    const cache = new Map<string, boolean>();
    return this.serverAltHistory.filter(alt => alt.status !== 'withdrawn' && altLineIndex(alt, this.lines, cache) === index).reverse();
  }

  /** Step B4f: pick a wording on a line: an option id, or its key "1".."9". */
  async pickAlternative(index: number, choice: string): Promise<boolean> {
    const set = this.altsByLine.get(index);
    const line = this.lines[index];
    if (!set || !line || !this.canMark) return false;
    const option = /^[1-9]$/.test(choice) ? set.options[Number(choice) - 1] : set.options.find(o => o.id === choice);
    if (!option) return false;
    // Optimistic: the pick shows at once.
    const by = this.me();
    this.serverPicks = [...this.serverPicks.filter(p => !(actorKey(p.by) === actorKey(by) && p.lineHash === line.hash)),
      { by, choice: option.id, lineHash: line.hash, at: new Date().toISOString() }];
    this.recompute();
    const before = pickOf(set, by);
    const result = await this.postAid('/alternatives/pick', { anchor: anchorForLine(line), choice: option.id });
    if (result.ok) {
      this.extrasWrites += 1;
      if (result.body.resolved) this.toast(`Everyone picked the same wording: it is now the line.`);
      // Undo: go back to the wording you had picked. Once everyone's picks resolved the line, the
      // pick has already become the text: that is an edit, and text undo owns it.
      if (result.body.resolved) {
        this.pushUndo('alternative', `picked a wording on line ${index + 1}`, () => ({ ok: false, reason: 'Not undone: that pick agreed with everyone else and is now the line. Suggest a change instead.' }));
      } else if (before && before.choice !== option.id) {
        this.pushUndo('alternative', `picked a wording on line ${index + 1}`,
          async () => { const ok = await this.withoutUndo(() => this.pickAlternative(index, before.choice)); return ok ? { ok: true } : { ok: false, reason: 'Could not go back to your earlier pick.' }; },
          async () => { const ok = await this.withoutUndo(() => this.pickAlternative(index, option.id)); return ok ? { ok: true } : { ok: false, reason: 'Could not pick that wording again.' }; });
      } else if (!before) {
        this.pushUndo('alternative', `picked a wording on line ${index + 1}`, () => ({ ok: false, reason: 'Not undone: a pick cannot be taken back once made, only changed. Pick another wording.' }));
      }
    }
    return result.ok;
  }

  async offerAlternative(index: number, text: string): Promise<boolean> {
    const line = this.lines[index];
    if (!line || !this.canMark || !text.trim()) return false;
    const result = await this.postAid('/alternatives', { anchor: anchorForLine(line), text });
    if (result.ok) this.extrasWrites += 1;
    return result.ok;
  }

  async decideAlternative(index: number, choice: string): Promise<boolean> {
    const line = this.lines[index];
    if (!line || !this.canApprove) return false;
    const result = await this.postAid('/alternatives/decide', { anchor: anchorForLine(line), choice });
    if (result.ok) { this.extrasWrites += 1; this.toast('Decided: that wording is now the line.'); }
    return result.ok;
  }

  async withdrawAlternative(id: string): Promise<boolean> {
    const result = await this.postAid(`/alternatives/${encodeURIComponent(id)}/withdraw`, {});
    if (result.ok) this.extrasWrites += 1;
    return result.ok;
  }

  /** Step B4f: a time-to-live on a line ("7d"). */
  async setTtl(index: number, ttl: string): Promise<boolean> {
    const line = this.lines[index];
    if (!line || !this.canMark) return false;
    const result = await this.postAid('/ttl', { anchor: anchorForLine(line), ttl });
    if (result.ok) {
      this.extrasWrites += 1;
      const id = typeof result.body.id === 'string' ? result.body.id : null;
      if (id) this.pushUndo('ttl', `set a review-by date on line ${index + 1}`,
        async () => { const ok = await this.withoutUndo(() => this.clearTtl(id)); return ok ? { ok: true } : { ok: false, reason: 'Could not clear that date.' }; },
        async () => { const ok = await this.withoutUndo(() => this.setTtl(index, ttl)); return ok ? { ok: true } : { ok: false, reason: 'Could not set that date again.' }; });
    }
    return result.ok;
  }

  async clearTtl(id: string): Promise<boolean> {
    const result = await this.postAid(`/ttl/${encodeURIComponent(id)}/clear`, {});
    if (result.ok) this.extrasWrites += 1;
    return result.ok;
  }

  ttlFor(index: number): TtlView | null { return this.ttlByLine.get(index) ?? null; }

  /**
   * Step B4f: Explain. Posts a comment thread on the line to the AI collaborators (tagged
   * `explain` on the server, with an explain.requested event). Never marks the line.
   */
  async explainLine(index: number, question = ''): Promise<boolean> {
    const line = this.lines[index];
    if (!line || !this.canMark) return false;
    const ais = (this.summary?.team ?? []).filter(isAiActor).map(actor => actorLabel(actor));
    const text = explainCommentText(question, ais);
    const markId = this.host.commentOnLine?.(line, text) ?? null;
    if (!markId) { this.toast('Could not place the question on this line'); return false; }
    const result = await this.postAid('/explain', { anchor: anchorForLine(line), question: question.trim() || EXPLAIN_POLICY.defaultQuestion, commentMarkId: markId });
    if (result.ok) {
      // Accord stage D: the `?` gesture and E produce the SAME object as T — a thread that asks
      // `clarify`. It is still never an Issue for the asker and still never marks the line; making
      // it a thread only means there is one resolve rule, one fold rule and one Undo.
      await this.postAid('/threads', { markId, asks: 'clarify', anchor: anchorsForThread(this.lines, [index]), selection: null, waitingOn: [] });
      this.extrasWrites += 1;
      this.toast(ais.length ? `Asked ${ais.join(', ')} to explain line ${index + 1}. The answer comes back on the line’s thread.` : `Asked for an explanation of line ${index + 1} (no AI has joined this document yet).`);
    }
    return result.ok;
  }

  // --------------------------------------------------------------------------
  // Accord round 2, stage D: threads
  //
  // A thread IS the comment or the suggestion. Starting one writes the comment mark the document
  // already understands, then stores what would close it and what it is anchored to beside the
  // document. Nothing already on a document needs either half to read as a thread.
  // --------------------------------------------------------------------------

  /** Every thread on the document now (rows, comments, suggestions and clarify requests alike). */
  allThreads(): ThreadView[] { return this.threadViews; }

  /**
   * The threads that are open FOR A VIEWER, each with the reason, in document order. This is the
   * one answer the Open list is built on (src/shared/threads.ts threadOpenFor).
   */
  openThreadsFor(viewer: string = this.me()): Array<{ id: string; line: number | null; why: string | null; because: string; detached: boolean }> {
    return openThreadsFor(this.threadViews, viewer, { team: this.summary?.team ?? [] })
      .map(({ view, openness }) => ({ id: view.thread.id, line: view.lineIndex, why: openness.why, because: openness.because, detached: openness.detached }));
  }

  /** The threads that sit on a line now. A detached thread sits on the line it detached to. */
  threadsOnLine(index: number): ThreadView[] { return this.threadsAtLine.get(index) ?? []; }

  threadById(id: string): ThreadView | null {
    return this.threadViews.find(view => view.thread.id === id || view.thread.markId === id) ?? null;
  }

  /**
   * T: starts a thread on a range of the document (or on one line). The closing condition is
   * required — the caller has already chosen one of THREAD_ASK_CHOICES.
   */
  async startThread(input: { lines: number[]; text: string; asks: ThreadAsks; selection?: string | null; waitingOn?: string[] }): Promise<string | null> {
    const indices = [...new Set(input.lines)].filter(index => this.lines[index]).sort((a, b) => a - b);
    if (indices.length === 0 || !this.canCommentHere()) return null;
    const text = input.text.trim();
    if (!text) return null;
    // The thread's words are a comment on its first line: the document already carries, syncs and
    // replies to those, so a thread is readable by every client and every AI from the moment it is
    // made — including ones that know nothing about threads.
    const markId = this.host.commentOnLine?.(this.lines[indices[0]], text) ?? null;
    if (!markId) { this.toast('Could not place the thread on that line'); return null; }
    const result = await this.postAid('/threads', {
      markId,
      asks: input.asks,
      text,
      anchor: anchorsForThread(this.lines, indices),
      selection: input.selection ?? null,
      waitingOn: input.waitingOn ?? [],
    });
    if (!result.ok) return null;
    const thread = result.body.thread as ThreadMeta | undefined;
    const id = thread?.id ?? markId;
    this.extrasWrites += 1;
    this.startedThreads.push({ id, lines: indices, asks: input.asks });
    this.toast(`Thread started on line ${indices[0] + 1}. It closes when: ${THREAD_ASK_LABEL[input.asks]}.`);
    this.pushUndo('thread', `started a thread on line ${indices[0] + 1}`, async () => {
      const undone = await this.postAid(`/threads/${encodeURIComponent(id)}/undo`, {});
      if (!undone.ok) return { ok: false, reason: 'That thread can no longer be taken back.' };
      this.decideOnMark?.([markId], 'resolve');
      return { ok: true };
    });
    return id;
  }

  /** Closes a thread by its own rule: a proposal is accepted or rejected, a discussion is resolved. */
  async closeThread(id: string, status: ThreadStatus): Promise<boolean> {
    const view = this.threadById(id);
    if (!view) return false;
    const threadId = view.thread.id;
    const result = await this.postAid(`/threads/${encodeURIComponent(threadId)}/close`, { status });
    const storedRow = result.ok;
    // A thread with no stored row is a plain comment or suggestion: it closes the way it always
    // did, on its mark. With a row, the mark is closed too, so both halves agree.
    if (view.thread.markId && status !== 'withdrawn') {
      this.decideOnMark?.([view.thread.markId], status === 'accepted' ? 'accept' : status === 'rejected' ? 'reject' : 'resolve');
    }
    if (storedRow) this.extrasWrites += 1;
    const line = view.lineIndex === null ? '' : ` on line ${view.lineIndex + 1}`;
    this.pushUndo('thread', `closed the thread${line}`, async () => {
      if (!storedRow) return { ok: false, reason: 'Reopen that comment from its thread.' };
      const back = await this.postAid(`/threads/${encodeURIComponent(threadId)}/reopen`, {});
      return back.ok ? { ok: true } : { ok: false, reason: 'That thread could not be reopened.' };
    });
    return storedRow || Boolean(view.thread.markId);
  }

  /** Reopens a closed thread (also the inverse the Undo runs). */
  async reopenThread(id: string): Promise<boolean> {
    const view = this.threadById(id);
    if (!view) return false;
    const result = await this.postAid(`/threads/${encodeURIComponent(view.thread.id)}/reopen`, {});
    if (result.ok) this.extrasWrites += 1;
    return result.ok;
  }

  /**
   * A reply on a thread goes to its mark (where it has always gone) AND to the thread's own row.
   *
   * Accord round 2 stage C, a loose end from stage D: replies lived only on the mark, and the mark
   * goes with the text. The thread survived a deletion because its words are on its own row; its
   * discussion did not. Both copies are written now, and src/shared/threads.ts mergeReplies shows
   * each reply once. A thread with no row of its own (a comment already on a live document that
   * nobody has given a closing condition) still keeps its replies only on its mark.
   */
  replyOnThread(id: string, text: string): boolean {
    const view = this.threadById(id);
    const body = text.trim();
    if (!view || !body) return false;
    if (view.thread.markId) this.decideOnMark?.([view.thread.markId], 'reply', body);
    if (view.thread.source === 'thread') {
      void this.postAid(`/threads/${encodeURIComponent(view.thread.id)}/reply`, { text: body })
        .then(result => { if (result.ok) this.extrasWrites += 1; });
    }
    return Boolean(view.thread.markId) || view.thread.source === 'thread';
  }

  /** How the page acts on a review mark (set by the editor; the Margin's Changes use the same one). */
  decideOnMark: ((ids: string[], action: 'accept' | 'reject' | 'resolve' | 'reply', text?: string) => void) | null = null;

  /** Step B4f: an Owner turns blind marking on or off. */
  async setBlind(on: boolean): Promise<boolean> {
    const result = await this.postAid('/settings', { blind: on });
    if (result.ok) { this.extrasWrites += 1; this.blind = on; this.renderBlind(); }
    return result.ok;
  }

  isBlind(): boolean { return this.blind; }

  /** Step B4f: the defined terms this reader has not seen yet (linked at their first use). */
  termLinkList(): TermUse[] { return this.termLinks; }

  private buildAltSection(line: DocLine, set: AltSetView): HTMLElement {
    const root = document.createElement('div');
    root.className = 'plm-alts';
    root.dataset.line = String(line.index);
    const head = document.createElement('p');
    head.className = 'plm-alts-head';
    const strong = document.createElement('strong');
    strong.textContent = 'Competing wordings';
    head.append(strong, ` · ${describeAltSet(set)} · keys 1–${set.options.length}`);
    root.append(head);
    const mine = pickOf(set, this.me());
    const group = document.createElement('div');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Pick one wording for this line');
    const counts = new Map<string, number>();
    for (const pick of set.picks.values()) if (!pick.hidden) counts.set(pick.choice, (counts.get(pick.choice) ?? 0) + 1);
    set.options.forEach((option, i) => {
      const label = document.createElement('label');
      label.className = 'plm-alt';
      label.dataset.choice = option.id;
      label.dataset.key = String(i + 1);
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `plm-alt-${line.index}`;
      radio.value = option.id;
      radio.checked = mine?.choice === option.id;
      radio.disabled = !this.canMark;
      radio.onchange = () => { if (radio.checked) void this.pickAlternative(line.index, option.id); };
      const key = document.createElement('span');
      key.className = 'plm-alt-key';
      key.textContent = String(i + 1);
      const text = document.createElement('span');
      text.className = 'plm-alt-text';
      text.textContent = option.text;
      const by = document.createElement('span');
      by.className = 'plm-alt-by';
      const n = counts.get(option.id) ?? 0;
      by.textContent = `${option.by ? `offered by ${actorLabel(option.by)}` : 'the line as it is'}${n ? ` · ${n} picked` : ''}`;
      label.append(radio, key, text, by);
      if (this.canApprove && ALT_POLICY.ownerDecides) {
        const decide = document.createElement('button');
        decide.type = 'button';
        decide.className = 'plm-link plm-alt-decide';
        decide.textContent = 'Decide';
        decide.title = 'As an Owner, make this the line now';
        decide.onclick = (event) => { event.preventDefault(); void this.decideAlternative(line.index, option.id); };
        label.append(decide);
      }
      if (option.by && (actorKey(option.by) === actorKey(this.me()) || this.canApprove)) {
        const withdraw = document.createElement('button');
        withdraw.type = 'button';
        withdraw.className = 'plm-link plm-alt-withdraw';
        withdraw.textContent = 'Withdraw';
        withdraw.onclick = (event) => { event.preventDefault(); void this.withdrawAlternative(option.id); };
        label.append(withdraw);
      }
      group.append(label);
    });
    root.append(group);
    const hidden = [...set.picks.values()].filter(p => p.hidden).length;
    const note = document.createElement('p');
    note.className = 'plm-alts-note';
    note.textContent = hidden
      ? `${hidden} ${hidden === 1 ? 'pick is' : 'picks are'} hidden until you pick or mark this line (blind marking).`
      : 'When everyone picks the same wording it becomes the line; the others are kept as its history.';
    root.append(note);
    return root;
  }

  private buildExtrasRow(line: DocLine, hasAlts: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'plm-extras';
    const links = document.createElement('div');
    links.className = 'plm-extras-links';
    const forms = document.createElement('div');
    const link = (label: string, cls: string, title: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = `plm-link ${cls}`; b.textContent = label; b.title = title; b.disabled = !this.canMark;
      b.onclick = onClick; links.append(b); return b;
    };
    const escHide = (form: HTMLElement) => (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); form.hidden = true; (event.target as HTMLElement).blur();
    };
    // Offer another wording (instead of rejecting).
    const altsCount = this.altsByLine.get(line.index)?.options.length ?? 1;
    if (ALT_POLICY.kinds.includes(line.kind) && altsCount - 1 < ALT_POLICY.maxPerLine) {
      const form = document.createElement('form');
      form.className = 'plm-alt-form';
      form.hidden = true;
      const input = document.createElement('textarea');
      input.rows = 2;
      input.maxLength = ALT_POLICY.maxText;
      input.value = line.text;
      input.setAttribute('aria-label', 'Your wording for this line');
      const save = document.createElement('button');
      save.type = 'submit';
      save.textContent = 'Offer this wording';
      form.append(input, save);
      form.onsubmit = (event) => { event.preventDefault(); const text = input.value.trim(); if (text && text !== line.text) void this.offerAlternative(line.index, text); };
      input.addEventListener('keydown', escHide(form));
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });
      link(hasAlts ? 'Offer another wording…' : 'Offer another wording…', 'plm-alt-open', 'Instead of rejecting, propose a different wording. Everyone picks one.', () => {
        form.hidden = false; input.focus({ preventScroll: true }); input.select();
      });
      forms.append(form);
    }
    // Explain (E).
    const explainForm = document.createElement('form');
    explainForm.className = 'plm-explain-form';
    explainForm.hidden = true;
    const q = document.createElement('input');
    q.type = 'text'; q.maxLength = EXPLAIN_POLICY.maxQuestion; q.placeholder = EXPLAIN_POLICY.defaultQuestion;
    q.setAttribute('aria-label', 'Your question about this line (optional)');
    const ask = document.createElement('button'); ask.type = 'submit'; ask.textContent = 'Ask';
    explainForm.append(q, ask);
    explainForm.onsubmit = (event) => { event.preventDefault(); void this.explainLine(line.index, q.value); explainForm.hidden = true; };
    q.addEventListener('keydown', escHide(explainForm));
    link('Explain…', 'plm-explain-open', 'Ask the document’s AI collaborators to explain this line (key E). It is not a rejection and not an Issue for you.', () => {
      explainForm.hidden = false; q.focus({ preventScroll: true });
    });
    forms.append(explainForm);
    // Time-to-live.
    const ttl = this.ttlByLine.get(line.index);
    const ttlRow = document.createElement('div');
    ttlRow.className = 'plm-ttl';
    if (ttl) {
      const p = document.createElement('p');
      p.className = 'plm-ttl-status';
      p.dataset.state = ttl.expired || ttl.notTrue ? 'expired' : 'set';
      const who = actorKey(ttl.ttl.by) === actorKey(this.me()) ? 'you' : actorLabel(ttl.ttl.by);
      let text = `Perishable (${ttl.ttl.label}, set by ${who}): ${describeTtl(ttl, Date.now() + this.clockSkewMs)}.`;
      if (ttl.decayed.length) text += ` ${ttl.decayed.length} Agreed/Approved ${ttl.decayed.length === 1 ? 'mark is' : 'marks are'} stale.`;
      if ((ttl.expired || ttl.notTrue) && ttl.openFor.length) text += ttl.reason === 'expired' ? ' Waiting for an AI to re-check it.' : ' Mark it again (Agree or Reject).';
      const last = ttl.ttl.checks[ttl.ttl.checks.length - 1];
      if (last) text += ` Last check: ${actorLabel(last.by)} said ${last.stillTrue ? 'still true' : 'no longer true'}${last.why ? ` (${last.why})` : ''}.`;
      p.textContent = text;
      if (actorKey(ttl.ttl.by) === actorKey(this.me()) || this.canApprove) {
        const clear = document.createElement('button');
        clear.type = 'button'; clear.className = 'plm-link plm-ttl-clear'; clear.textContent = 'Remove';
        clear.disabled = !this.canMark;
        clear.onclick = () => { void this.clearTtl(ttl.ttl.id); };
        p.append(' ', clear);
      }
      ttlRow.append(p);
    }
    const ttlForm = document.createElement('form');
    ttlForm.className = 'plm-ttl-form';
    ttlForm.hidden = true;
    for (const preset of TTL_POLICY.presets) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'plm-ttl-preset'; b.textContent = preset;
      b.onclick = () => { void this.setTtl(line.index, preset); ttlForm.hidden = true; };
      ttlForm.append(b);
    }
    const custom = document.createElement('input');
    custom.type = 'text'; custom.placeholder = 'or e.g. 12h'; custom.maxLength = 8;
    custom.setAttribute('aria-label', 'Time-to-live, for example 7d or 12h');
    const setBtn = document.createElement('button'); setBtn.type = 'submit'; setBtn.textContent = 'Set';
    ttlForm.append(custom, setBtn);
    ttlForm.onsubmit = (event) => { event.preventDefault(); if (custom.value.trim()) void this.setTtl(line.index, custom.value.trim()); ttlForm.hidden = true; };
    custom.addEventListener('keydown', escHide(ttlForm));
    link(ttl ? 'Change time-to-live…' : 'Time-to-live…', 'plm-ttl-open', 'Make this line perishable: when the time runs out, agreement to it goes stale and an AI re-checks it.', () => {
      ttlForm.hidden = false; (ttlForm.querySelector('button') as HTMLButtonElement | null)?.focus({ preventScroll: true });
    });
    forms.append(ttlForm);
    row.append(ttlRow, links, forms);
    return row;
  }

  private buildAltHistory(history: ProofAlternative[]): HTMLElement {
    const details = document.createElement('details');
    details.className = 'plm-alt-history';
    const summary = document.createElement('summary');
    summary.textContent = `Earlier wordings (${history.length})`;
    details.append(summary);
    const list = document.createElement('ul');
    for (const alt of history.slice(0, 20)) {
      const li = document.createElement('li');
      const how = alt.resolution?.how === 'owner' ? 'an Owner decided' : 'everyone picked';
      li.textContent = `${alt.status === 'chosen' ? 'Chosen' : 'Not chosen'}: “${alt.text}” — offered by ${actorLabel(alt.by)}${alt.resolution ? ` (${how})` : ''}`;
      list.append(li);
    }
    details.append(list);
    return details;
  }

  /** Step B4f: the rail's blind-marking row (an Owner's switch; a notice for everyone else). */
  private renderBlind(): void {
    const el = this.blindEl;
    const sig = JSON.stringify([this.blind, this.canApprove, this.loaded, this.blindInfo?.hiddenPositions ?? 0]);
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.className = 'plm-blind';
    el.dataset.on = String(this.blind);
    el.replaceChildren();
    el.hidden = !this.loaded || (!this.blind && !this.canApprove);
    if (el.hidden) return;
    if (this.canApprove) {
      const label = document.createElement('label');
      label.className = 'plm-blind-setting';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = this.blind;
      box.onchange = () => { void this.setBlind(box.checked); };
      const text = document.createElement('span');
      text.textContent = 'Blind marking';
      label.append(box, text);
      el.append(label);
    }
    const note = document.createElement('p');
    note.className = 'plm-blind-status';
    note.textContent = this.blind
      ? 'On: you see how others marked a line only after you mark it yourself. Disagreements then come first.'
      : 'Off: everyone sees everyone’s marks at once.';
    el.append(note);
  }

  /** The alternatives stacks under their lines and the term links (view-only decorations). */
  private queueExtrasDecorations(): void {
    if (this.extrasDecoQueued) return;
    this.extrasDecoQueued = true;
    requestAnimationFrame(() => {
      this.extrasDecoQueued = false;
      const view = this.view;
      if (!view) return;
      const alts: AltStackSpec[] = [];
      const sigs: string[] = [];
      for (const set of this.altViews) {
        const line = this.lines[set.lineIndex];
        if (!line || line.kind === 'table_row') continue;
        const mine = pickOf(set, this.me())?.choice ?? '';
        const sig = String(hashSig(JSON.stringify([set.options.map(o => [o.id, o.text, o.by]), mine, [...set.picks.values()].map(p => [p.by, p.hidden ? '?' : p.choice])])));
        sigs.push(`${set.lineIndex}@${line.pos}:${line.nodeSize}:${sig}`);
        alts.push({ lineIndex: set.lineIndex, pos: line.pos, nodeSize: line.nodeSize, sig, render: () => this.buildAltStack(set) });
      }
      const terms: TermLinkSpec[] = [];
      for (const use of this.termLinks) {
        const line = this.lines[use.lineIndex];
        if (!line || line.kind === 'table_row') continue;
        sigs.push(`t:${use.term}@${line.pos}`);
        terms.push({ term: use.term, definition: use.definition, defLineIndex: use.defLineIndex, pos: line.pos, nodeSize: line.nodeSize });
      }
      const signature = sigs.join('|');
      // A remote Yjs update replaces the whole document, which drops mapped decorations even when
      // every position is unchanged: rebuild whenever the set holds fewer than it should.
      const expected = alts.filter(spec => view.state.doc.nodeAt(spec.pos)?.isTextblock).length
        + terms.filter(spec => termRange(view.state.doc, spec.pos, spec.term)).length;
      const present = proofExtrasViewKey.getState(view.state)?.find().length ?? 0;
      if (signature === this.extrasDecoSig && present >= expected) return;
      this.extrasDecoSig = signature;
      try { setProofExtrasDecorations(view, alts, terms); } catch (error) { console.warn('[plm] extras decorations failed', error); }
    });
  }

  /** The wordings shown under a line in the text (original first; the rail has the controls). */
  private buildAltStack(set: AltSetView): HTMLElement {
    const root = document.createElement('div');
    root.className = 'pdx-alts';
    root.contentEditable = 'false';
    root.dataset.line = String(set.lineIndex);
    root.setAttribute('aria-label', 'Competing wordings for this line');
    const mine = pickOf(set, this.me())?.choice ?? null;
    set.options.forEach((option, i) => {
      const row = document.createElement('div');
      row.className = 'pdx-alt';
      row.dataset.choice = option.id;
      if (mine === option.id) row.dataset.mine = 'true';
      const key = document.createElement('span');
      key.className = 'pdx-alt-key';
      key.textContent = String(i + 1);
      const text = document.createElement('span');
      text.className = 'pdx-alt-text';
      text.textContent = i === 0 ? 'Original wording (above)' : option.text;
      const by = document.createElement('span');
      by.className = 'pdx-alt-by';
      by.textContent = option.by ? actorLabel(option.by) : '';
      row.append(key, text, by);
      row.onclick = (event) => { event.preventDefault(); event.stopPropagation(); void this.pickAlternative(set.lineIndex, option.id); };
      root.append(row);
    });
    return root;
  }

  /** Clicking a linked term shows its definition, with a way to go and read it. */
  private onTermClick = (event: MouseEvent): void => {
    const target = (event.target as HTMLElement | null)?.closest?.('.pdx-term') as HTMLElement | null;
    document.querySelector('.plm-term-pop')?.remove();
    if (!target) return;
    const term = target.dataset.term ?? '';
    const use = this.termLinks.find(u => u.term === term);
    if (!use) return;
    const pop = document.createElement('div');
    pop.className = 'plm-term-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', `Definition of ${term}`);
    const p = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = use.term;
    p.append(strong, ` — ${use.definition}`);
    const go = document.createElement('button');
    go.type = 'button'; go.className = 'plm-link'; go.textContent = 'Go to the definition';
    go.onclick = () => { pop.remove(); this.host.revealLine?.(use.defLineIndex); if (!this.host.focusLine?.(use.defLineIndex)) this.issueTarget(use.defLineIndex)?.scrollIntoView({ block: 'center' }); };
    pop.append(p, go);
    const r = target.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - 300, r.left))}px`;
    pop.style.top = `${Math.min(window.innerHeight - 120, r.bottom + 6)}px`;
    document.body.append(pop);
    setTimeout(() => pop.remove(), 8000);
  };

  private issueTarget(index: number): HTMLElement | null {
    const line = this.lines[index];
    return line && this.view ? this.view.nodeDOM(line.pos) as HTMLElement | null : null;
  }

  // ---------------- the sitting budget ----------------

  private sittingKey(): string | null {
    const slug = this.host.slug();
    return slug ? `proof:sitting:${slug}` : null;
  }

  private loadSitting(): void {
    const key = this.sittingKey();
    if (!key) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || 'null') as { visited?: string[]; stopped?: boolean } | null;
      this.sittingVisited = new Set(Array.isArray(saved?.visited) ? saved!.visited : []);
      this.sittingStopped = saved?.stopped === true;
    } catch { /* optional */ }
  }

  private saveSitting(): void {
    const key = this.sittingKey();
    if (!key) return;
    try { sessionStorage.setItem(key, JSON.stringify({ visited: [...this.sittingVisited], stopped: this.sittingStopped })); } catch { /* optional */ }
  }

  private visitIssue(key: string): void {
    this.sittingVisited.add(key);
    this.saveSitting();
  }

  sittingSummary(): SittingSummary {
    return sittingSummary(this.ranked, this.sittingVisited, this.budget);
  }

  /** "This sitting: N issues" (0 = off). Per browser. */
  setBudget(budget: number): void {
    this.budget = SITTING_BUDGET.choices.includes(budget) ? budget : SITTING_BUDGET.defaultBudget;
    try { localStorage.setItem(BUDGET_KEY, String(this.budget)); } catch { /* optional */ }
    this.startSitting();
  }

  startSitting(): void {
    this.sittingVisited = new Set();
    this.sittingStopped = false;
    this.saveSitting();
    this.renderBudget();
  }

  /** The reader stops here, told honestly what is left. */
  stopSitting(): void {
    this.sittingStopped = true;
    this.saveSitting();
    this.renderBudget();
  }

  private renderBudget(): void {
    const el = this.budgetEl;
    const summary = this.loaded ? this.sittingSummary() : null;
    const sig = JSON.stringify([this.budget, summary, this.sittingStopped]);
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.replaceChildren();
    const label = document.createElement('label');
    label.className = 'plm-budget-setting';
    const text = document.createElement('span');
    text.textContent = 'This sitting';
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'This sitting: how many issues to go through before stopping');
    for (const n of SITTING_BUDGET.choices) {
      const option = document.createElement('option');
      option.value = String(n);
      option.textContent = n === 0 ? 'no limit' : `${n} issues`;
      select.append(option);
    }
    select.value = String(this.budget);
    select.onchange = () => this.setBudget(Number(select.value));
    label.append(text, select);
    el.append(label);
    el.dataset.state = !summary || this.budget === 0 ? 'off' : this.sittingStopped ? 'stopped' : summary.reached ? 'reached' : 'on';
    if (!summary || this.budget === 0) return;
    const status = document.createElement('p');
    status.className = 'plm-budget-status';
    status.setAttribute('role', 'status');
    if (this.sittingStopped) {
      status.textContent = summary.remaining === 0 ? 'Stopped. Nothing left.' : `Stopped with ${summary.text}. They wait for next time.`;
      const again = document.createElement('button');
      again.type = 'button'; again.className = 'plm-link'; again.textContent = 'Start a new sitting';
      again.onclick = () => this.startSitting();
      el.append(status, again);
      return;
    }
    if (!summary.reached) {
      status.textContent = `${Math.min(summary.visited, this.budget)} of ${this.budget} issues this sitting.`;
      el.append(status);
      return;
    }
    status.textContent = `Sitting done: ${this.budget} of ${this.budget}. ${summary.text}.`;
    const actions = document.createElement('div');
    actions.className = 'plm-budget-actions';
    const stop = document.createElement('button');
    stop.type = 'button'; stop.className = 'plm-choice plm-budget-stop'; stop.textContent = 'Stop here';
    stop.onclick = () => this.stopSitting();
    const more = document.createElement('button');
    more.type = 'button'; more.className = 'plm-choice plm-budget-more'; more.textContent = `${this.budget} more`;
    more.onclick = () => { this.startSitting(); this.gotoNextIssue(); };
    actions.append(stop, more);
    el.append(status, actions);
  }

  /** Test hook: flag / objection writes this page made. */
  private aidWrites = 0;

  /** Test and agent hook: the numbers the UI shows. */
  // --------------------------------------------------------------------------
  // Line tiers
  // --------------------------------------------------------------------------

  /**
   * The lines that are an Issue for THIS viewer: one they have not read, one they rejected, or one
   * carrying an open comment, suggestion, ask or objection. The section auto-close (item 4) and
   * the tier fold both read it.
   */
  myIssueLineSet(): ReadonlySet<number> { return this.myIssueLines; }

  tierView(index: number): TierView | null { return this.tierEval?.views[index] ?? null; }
  tiersTagged(): boolean { return this.tierEval?.anyTagged ?? false; }

  tierSignature(index: number): string {
    const v = this.tierEval?.views[index];
    return v ? `${v.tier}:${v.proposed}:${v.record?.id ?? ''}:${v.readBy.join(',')}:${this.canMark}` : '';
  }

  /** A context line that is not an Issue for this viewer: J / K and Next issue skip it (scrolling still reads it). */
  tierSkippable(index: number): boolean {
    const v = this.tierEval?.views[index];
    return Boolean(v?.actsAsContext) && !this.myIssueLines.has(index);
  }

  /** Lines "Show only decisions" folds away now. */
  tierFoldedLines(): ReadonlySet<number> { return this.tierFolded; }
  onlyDecisionsOn(): boolean { return this.onlyDecisions; }

  setOnlyDecisions(on: boolean): void {
    if (this.onlyDecisions === on) return;
    this.onlyDecisions = on;
    saveOnlyDecisions(on);
    this.recompute();
  }

  private computeTierFold(): void {
    const me = actorKey(this.me());
    const mine = new Set<number>();
    for (const issue of this.summary?.issues ?? []) {
      if (!('lineIndex' in issue)) continue;
      if (issue.type === 'objection') { for (const index of issue.lineIndices) mine.add(index); continue; }
      if (issue.lineIndex === null) continue;
      if (issue.type === 'line' && !issue.unseenBy.some(m => actorKey(m) === me) && issue.rejectedBy.length === 0) continue;
      mine.add(issue.lineIndex);
    }
    for (const mark of this.reviewMarkCache) {
      if (!mark.open || typeof mark.pos !== 'number') continue;
      const index = this.lineAtPos(mark.pos);
      if (index >= 0) mine.add(index);
    }
    this.myIssueLines = mine;
    const folded = new Set<number>();
    if (this.onlyDecisions && this.tierEval?.anyTagged) {
      for (const view of this.tierEval.views) {
        if (!view.actsAsContext || mine.has(view.lineIndex)) continue;
        const line = this.lines[view.lineIndex];
        if (!line || (TIER_POLICY.foldKeepsHeadings && line.kind === 'heading')) continue;
        folded.add(view.lineIndex);
      }
    }
    this.tierFolded = folded;
  }

  /** Tags lines with a tier (anyone with comment access; every flip is recorded with who and when). */
  async setTiers(indices: number[], tier: LineTier, reason?: string): Promise<boolean> {
    const lines = indices.map(i => this.lines[i]).filter((l): l is DocLine => Boolean(l));
    if (lines.length === 0 || !this.canMark) return false;
    // Optimistic: the new tag shows at once.
    const previous = this.serverTiers;
    const at = new Date().toISOString();
    this.serverTiers = [...this.serverTiers, ...lines.map((line, i) => ({ id: `local-${Date.now()}-${i}`, tier, by: this.me(), at, reason: reason ?? null, anchor: anchorForLine(line) }))];
    this.recompute();
    const before = lines.map(line => this.tierEval?.views[line.index]?.tier ?? null);
    const result = await this.postAid('/tiers', { tier, anchors: lines.map(anchorForLine), ...(reason ? { reason } : {}) });
    this.tierWrites.push({ tier, lines: lines.map(l => l.index), ok: result.ok });
    if (!result.ok) { this.serverTiers = previous; this.recompute(); }
    else {
      // Undo: put each line back on the tier it carried. A tier flip is a tag, never text.
      const groups = new Map<LineTier, number[]>();
      lines.forEach((line, i) => {
        const was = before[i];
        if (!was || was === tier) return;
        groups.set(was, [...(groups.get(was) ?? []), line.index]);
      });
      if (groups.size) {
        this.pushUndo('tier', `set ${lines.length} ${lines.length === 1 ? 'line' : 'lines'} to ${tier}`, async () => {
          for (const [was, indices] of groups) {
            const ok = await this.withoutUndo(() => this.setTiers(indices, was, reason));
            if (!ok) return { ok: false, reason: 'Could not put the tiers back.' };
          }
          return { ok: true };
        }, async () => {
          const ok = await this.withoutUndo(() => this.setTiers(lines.map(l => l.index), tier, reason));
          return ok ? { ok: true } : { ok: false, reason: 'Could not set those tiers again.' };
        });
      }
    }
    return result.ok;
  }

  private renderTierControl(): void {
    renderTierControl(this.tierEl, {
      counts: this.summary ? { decision: this.summary.counts.decision, context: this.summary.counts.context } : null,
      anyTagged: this.tierEval?.anyTagged ?? false,
      onlyDecisions: this.onlyDecisions,
      toggle: on => this.setOnlyDecisions(on),
    });
  }

  /** Context lines quieter, folded ones hidden (view-only node decorations). */
  private queueTierDecorations(): void {
    if (this.tierDecoQueued) return;
    this.tierDecoQueued = true;
    requestAnimationFrame(() => {
      this.tierDecoQueued = false;
      const view = this.view;
      if (!view || !this.tierEval) return;
      const specs: TierLineSpec[] = [];
      for (const v of this.tierEval.views) {
        const line = this.lines[v.lineIndex];
        if (!line) continue;
        const folded = this.tierFolded.has(v.lineIndex);
        if (v.tier !== 'context' && !folded) continue;
        specs.push({ lineIndex: v.lineIndex, pos: line.pos, nodeSize: line.nodeSize, context: v.tier === 'context', proposed: v.proposed, folded });
      }
      const signature = specs.map(s => `${s.lineIndex}@${s.pos}:${s.nodeSize}:${s.proposed ? 'p' : ''}${s.folded ? 'f' : ''}`).join('|');
      // A remote Yjs update replaces the whole document and drops mapped decorations: rebuild then.
      const present = tierViewKey.getState(view.state)?.find().length ?? 0;
      if (signature === this.tierDecoSig && present >= specs.length) return;
      this.tierDecoSig = signature;
      try { setTierDecorations(view, specs); } catch (error) { console.warn('[plm] tier decorations failed', error); }
      this.queueRender();
    });
  }

  debugState(): { tiers: Record<string, unknown>; proxy: Record<string, unknown>; extras: Record<string, unknown>; aids: Record<string, unknown>; loaded: boolean; issues: number; aligned: boolean; team: string[]; lines: number; marks: LineMark[]; sectionWrites: number; askIssues: number; askAnswers: number; asks: Array<Record<string, unknown>>; doIssues: number; doWrites: number; dos: Array<Record<string, unknown>>; skimWrites: number; snapshot: { id: string; createdAt: string } | null; carried: Array<{ line: number; by: string; from: string | null }> } {
    return {
      tiers: {
        anyTagged: this.tierEval?.anyTagged ?? false,
        views: (this.tierEval?.views ?? []).filter(v => v.tagged || v.tier === 'context').map(v => ({ line: v.lineIndex, tier: v.tier, proposed: v.proposed, readBy: v.readBy, by: v.record?.by ?? null })),
        counts: { decision: this.summary?.counts.decision ?? null, context: this.summary?.counts.context ?? null },
        onlyDecisions: this.onlyDecisions,
        folded: [...this.tierFolded],
        skippable: this.lines.map(l => l.index).filter(i => this.tierSkippable(i)),
        myIssueLines: [...this.myIssueLines],
        writes: this.tierWrites,
        decorations: this.view ? tierDecorationCount(this.view) : null,
      },
      proxy: {
        familiar: this.serverFamiliar?.familiar ?? null,
        proxies: this.serverProxies.length,
        counts: this.brief?.counts ?? null,
        ratify: (this.brief?.ratify ?? []).map(i => i.lineIndex),
        flagged: (this.brief?.flagged ?? []).map(i => [i.lineIndex, i.bucket]),
        seen: (this.brief?.seen ?? []).map(i => i.lineIndex),
        reset: this.brief?.reset.length ?? 0,
        walk: this.flaggedWalk(),
        writes: this.proxyWrites,
        ratifications: this.serverRatifications,
      },
      aids: {
        flags: this.flagViews.map(v => ({ id: v.flag.id, by: v.flag.by, note: v.flag.note, line: v.lineIndex })),
        objections: this.objectionViews.map(v => ({ id: v.objection.id, by: v.objection.by, lines: v.lineIndices, repairPending: v.repairPending, deleted: v.deletedLines, condition: v.objection.condition })),
        notes: this.serverNotes.length,
        ranked: this.ranked.map(r => ({ key: r.key, rule: r.rule, priority: r.priority, type: r.issue.type, line: 'lineIndex' in r.issue ? r.issue.lineIndex : null })),
        selection: [...this.selection],
        sitting: this.sittingSummary(),
        stopped: this.sittingStopped,
        writes: this.aidWrites,
        uncertainIssues: this.summary?.counts.uncertainIssues ?? -1,
        objectionIssues: this.summary?.counts.objectionIssues ?? -1,
      },
      extras: {
        blind: this.blind,
        blindInfo: this.blindInfo,
        bundles: this.bundleViews.map(v => ({ id: v.bundle.id, title: v.bundle.title, status: v.status, pending: v.pending, stale: v.stale, acceptable: v.acceptable, summary: describeBundle(v) })),
        alternatives: this.altViews.map(v => ({ line: v.lineIndex, options: v.options.map(o => o.id), openFor: v.openFor, unanimous: v.unanimous, disagree: v.disagree, picks: [...v.picks.values()].map(p => ({ by: p.by, choice: p.hidden ? null : p.choice, hidden: Boolean(p.hidden) })) })),
        ttls: this.ttlViews.map(v => ({ id: v.ttl.id, line: v.lineIndex, expired: v.expired, notTrue: v.notTrue, decayed: v.decayed, openFor: v.openFor, reason: v.reason })),
        disagreement: [...this.disagreement],
        terms: this.termLinks.map(t => ({ term: t.term, line: t.lineIndex, def: t.defLineIndex })),
        explains: this.serverExplains.length,
        hiddenMarks: this.serverMarks.filter(m => m.hidden).length,
        alternativeIssues: this.summary?.counts.alternativeIssues ?? -1,
        ttlIssues: this.summary?.counts.ttlIssues ?? -1,
        writes: this.extrasWrites,
        decoSig: this.extrasDecoSig,
        decorations: this.view ? (proofExtrasViewKey.getState(this.view.state)?.find().length ?? 0) : null,
      },
      skimWrites: 0,
      snapshot: this.snapshot,
      carried: this.states.flatMap(state => [...state.marks.values()].filter(e => e.carried).map(e => ({ line: state.line.index, by: e.mark.by, from: e.carriedFrom ?? null }))),
      askIssues: this.summary?.counts.askIssues ?? -1,
      askAnswers: this.askAnswers,
      doIssues: this.summary?.counts.doIssues ?? -1,
      doWrites: this.doWrites,
      dos: this.doViews.map(v => ({ id: v.record.id, lineIndex: v.lineIndex, state: v.state, digest: v.digest, approvalCurrent: v.approvalCurrent, openFor: v.openFor })),
      asks: this.askViews.map(v => ({ id: v.ask.id, lineIndex: v.lineIndex, openFor: v.openFor, snoozedFor: v.snoozedFor, outcome: v.outcome, answers: v.answers.map(a => [a.by, a.choice, a.words]) })),
      sectionWrites: this.sectionWrites,
      loaded: this.loaded,
      issues: this.summary?.counts.total ?? -1,
      aligned: this.summary?.aligned ?? false,
      team: this.summary?.team ?? [],
      lines: this.lines.length,
      marks: this.serverMarks,
    };
  }
}

/** Step B4c: the reader's "This sitting" budget, per browser. */
const BUDGET_KEY = 'proof:sitting-budget';
function loadBudget(): number {
  try {
    const raw = Number(localStorage.getItem(BUDGET_KEY));
    return SITTING_BUDGET.choices.includes(raw) ? raw : SITTING_BUDGET.defaultBudget;
  } catch {
    return SITTING_BUDGET.defaultBudget;
  }
}

/** Step B3c: a short time for the top bar: "14:02" today, "Sep 17, 14:02" otherwise. */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return time;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

function hashSig(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  return h >>> 0;
}

/** Step B4f: what the page shows for a mark (a blind placeholder, a decayed mark, a stale one). */
function shownStatus(entry: { mark: LineMark; current: boolean; decayed?: boolean }): ShownStatus {
  if (!entry.current) return 'changed';
  if (entry.mark.hidden) return 'hidden';
  if (entry.decayed) return 'stale';
  return entry.mark.status;
}

function shownLabel(status: ShownStatus): string {
  if (status === 'hidden') return 'Marked · hidden until you mark this line';
  if (status === 'stale') return 'Stale: agreed before the line’s time-to-live ran out';
  if (status === 'changed') return 'changed since marked';
  return STATUS_LABEL[status];
}
