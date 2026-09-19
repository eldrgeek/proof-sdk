/**
 * Proof Documents Step 1 — the line-marks UI.
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
  actorKey,
  actorLabel,
  anchorForLine,
  buildLineStates,
  computeIssues,
  computeStep1Team,
  extractLines,
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
import type { SinceYouReport } from '../shared/alignment';
import { FOLDING, planSectionMark } from '../shared/folding';
import { askIssueInputs, askTeamActors, evaluateAsks, type AskChoice, type AskView, type ProofAsk } from '../shared/asks';
import { setAskDecorations, type AskDecorationSpec } from '../editor/plugins/ask-view';
import { askControlSignature, buildAskControl, buildAskTag, type AskControl } from './asks';
import { setLineMarksViewListener, peekPendingLocalLineEdits, takePendingLocalLineEdits } from '../editor/plugins/line-marks-view';
import { EMPTY_DIRECTORY, actorTrust, normalizeActorString, resolveTargetActor, type IdentityDirectory, type ViewerIdentity } from '../shared/identity';
import './line-marks.css';

export interface LineMarksHost {
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
  /** Step B2: a folded heading's marking scope (every line of its section), or null. */
  markScope?(lineIndex: number): { lines: number[]; heading: string } | null;
  /** Step B2: unfold whatever hides a line. Returns true when something unfolded. */
  revealLine?(lineIndex: number): boolean;
  /** Step B3: the viewer is answering the ask on this line (the reading walk's explicit action). */
  onAskAnswered?(lineIndex: number): void;
}

export interface MarkBoxOptions {
  /** Called after the viewer chose a mark (the popover closes itself; the rail stays). */
  onChosen?(status: StatusChoice): void;
  /** Called with the chosen status before it is written (the reading walk commits scroll-accepts). */
  onExplicit?(status: StatusChoice): void;
}

export interface MarkBox {
  root: HTMLElement;
  /** Shows the one-line reason field (R). */
  openReason(): void;
  /** Sets a status as if its button was pressed (A). Returns false when marking is not allowed. */
  choose(status: StatusChoice, via?: MarkVia): boolean;
  /** Step B3: the line's ask control, when the line carries an ask (Y / N / T). */
  ask?: AskControl;
}

export type StatusChoice = LineMarkStatus | 'unseen';

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
  private owners: string[] = [];
  private agentKeyActors: string[] = [];
  /** Step B6: who the server says this viewer is, and the directory that reads names. */
  private serverMe: ViewerIdentity | null = null;
  private directory: IdentityDirectory = EMPTY_DIRECTORY;
  private canApprove = false;
  private canMark = true;
  private loaded = false;
  private summary: IssueSummary | null = null;
  private states: LineState[] = [];
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private renderQueued = false;
  private restampTimer: ReturnType<typeof setTimeout> | null = null;
  private fetchSeq = 0;
  private writesInFlight = 0;
  private menu: HTMLElement | null = null;
  private menuCleanup: (() => void) | null = null;
  private lastIssuePos = -1;
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
    this.renderBanner();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    setLineMarksViewListener({
      update: (view, prevState) => this.onViewUpdate(view, prevState),
    });
    document.body.classList.add('plm-on');
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('resize', this.queueRender);
    void this.refresh();
    this.schedulePoll();
  }

  stop(): void {
    this.started = false;
    document.body.classList.remove('plm-on');
    setLineMarksViewListener(null);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('resize', this.queueRender);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.closeMenu();
    this.resizeObserver?.disconnect();
    this.gutter.remove();
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
      const response = await fetch(`${this.host.apiBase()}/documents/${encodeURIComponent(slug)}/line-marks`, {
        headers: this.host.authHeaders(),
        credentials: 'same-origin',
      });
      if (!response.ok) return;
      const body = await response.json() as {
        lineMarks?: LineMark[]; owners?: string[]; agentKeyActors?: string[]; asks?: ProofAsk[];
        viewer?: { canApprove?: boolean; canMark?: boolean };
        identity?: { me?: ViewerIdentity; directory?: IdentityDirectory };
        alignedSnapshot?: { id: string; createdAt: string } | null;
      };
      // A newer fetch or a local write superseded this answer.
      if (seq !== this.fetchSeq || this.writesInFlight > 0) return;
      this.serverMarks = Array.isArray(body.lineMarks) ? body.lineMarks : [];
      this.serverAsks = Array.isArray(body.asks) ? body.asks : [];
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
      const reviewMarks = this.host.reviewMarks(view);
      const team = computeStep1Team({
        owners: this.owners,
        lineMarks: this.serverMarks,
        reviewMarks,
        agentKeyActors: this.agentKeyActors,
        extra: [this.me(), ...askTeamActors(this.serverAsks)],
        identity: { target: actor => resolveTargetActor(actor, this.directory) },
      });
      this.states = buildLineStates(this.lines, this.serverMarks);
      this.askViews = evaluateAsks(this.serverAsks, this.lines);
      this.summary = computeIssues({ lines: this.lines, lineMarks: this.serverMarks, team, reviewMarks, asks: askIssueInputs(this.askViews) });
      this.queueAskDecorations();
      this.maybeCheckAlignment();
    }
    this.renderBanner();
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
    const trust = this.serverMe?.actor ? this.serverMe.trust : actorTrust(actor);
    return {
      actor,
      trust,
      name: this.serverMe?.name || actor.replace(/^(human|ai|guest):/i, ''),
      ...(this.serverMe?.email ? { email: this.serverMe.email } : {}),
      signInUrl: this.serverMe?.signInUrl ?? null,
    };
  }

  isLoaded(): boolean { return this.loaded; }
  /** Step B3c: unfold whatever hides a line (a Since-you item was clicked). */
  revealLine(index: number): boolean { return this.host.revealLine?.(index) ?? false; }
  lineList(): DocLine[] { return this.lines; }
  lineState(index: number): LineState | undefined { return this.states[index]; }
  issueSummary(): IssueSummary | null { return this.summary; }
  editorView(): EditorView | null { return this.view; }

  /** The viewer's own status on a line ('changed' when their mark is out of date). */
  myStatus(index: number): StatusChoice | 'changed' {
    const mine = this.states[index]?.marks.get(actorKey(this.me()));
    return !mine ? 'unseen' : (mine.current ? mine.mark.status : 'changed');
  }

  /** Writes the viewer's mark on a line. */
  setLineStatus(index: number, status: StatusChoice, reason?: string, via: MarkVia = 'click'): Promise<boolean> {
    const line = this.lines[index];
    if (!line || !this.canMark) return Promise.resolve(false);
    return this.writeMark(line, status, reason, via);
  }

  /**
   * Step B3b: the reading walk passed these lines faster than their reading time. Each line the
   * viewer has no mark on becomes "skimmed", in one request. A skim never replaces a mark, not
   * even an out-of-date one (that one still says "changed since you marked it", and the
   * changer's own mark still follows their edit).
   */
  async markSkimmed(indices: number[]): Promise<boolean> {
    const slug = this.host.slug();
    if (!slug || !this.canMark || !this.loaded) return false;
    const by = this.me();
    const me = actorKey(by);
    const lines = [...new Set(indices)].map(index => this.lines[index]).filter((line): line is DocLine => Boolean(line))
      .filter(line => this.myStatus(line.index) === 'unseen' && !this.states[line.index]?.marks.has(me))
      .slice(0, FOLDING.maxBatchLines);
    if (lines.length === 0) return true;
    const entries = lines.map(line => {
      const own = [...(this.states[line.index]?.marks.values() ?? [])].filter(e => actorKey(e.mark.by) === me);
      return { line, anchor: anchorForLine(line), replaceIds: own.map(e => e.mark.id).filter(id => !id.startsWith('local-')) };
    });
    const replaced = new Set(entries.flatMap(entry => entry.replaceIds));
    const at = new Date().toISOString();
    this.serverMarks = this.serverMarks.filter(mark => !replaced.has(mark.id));
    entries.forEach((entry, i) => this.serverMarks.push({ id: `local-skim-${Date.now()}-${i}`, by, status: 'skimmed', reason: null, at, anchor: entry.anchor, via: 'dwell' }));
    this.recompute();
    this.skimWrites += entries.length;
    this.writesInFlight += 1;
    try {
      const response = await fetch(`${this.host.apiBase()}/documents/${encodeURIComponent(slug)}/line-marks`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...this.host.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ by, status: 'skimmed', via: 'dwell', lines: entries.map(entry => ({ anchor: entry.anchor, replaceIds: entry.replaceIds })) }),
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      this.writesInFlight -= 1;
      this.fetchSeq += 1;
      void this.refresh();
    }
  }

  /** Test hook: lines this page has marked skimmed. */
  private skimWrites = 0;

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
    return view ? askControlSignature(view, this.me(), this.canMark) : '';
  }

  /** Records the viewer's answer: Yes / Not yet / No in their own words. */
  async answerAsk(askId: string, choice: AskChoice, words: string): Promise<boolean> {
    const slug = this.host.slug();
    const view = this.askViews.find(v => v.ask.id === askId);
    if (!slug || !view || view.lineIndex === null || !this.canMark) return false;
    this.host.onAskAnswered?.(view.lineIndex);
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
      if (signature === this.askDecoSig) return;
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
      if (!mine) continue;
      // Still current somewhere (for example a duplicate line)? Then nothing went stale.
      if (lines.some(line => line.hash === mine.anchor.hash && line.occurrence === mine.anchor.occurrence)) continue;
      // The edited line is the one whose text is what this user last typed.
      const candidates = lines.filter(line => line.hash === edit.currentHash);
      if (candidates.length === 0) continue; // someone else changed it since: their edit resets it
      const line = candidates.reduce((best, next) =>
        Math.abs(next.index - mine.anchor.ordinal) < Math.abs(best.index - mine.anchor.ordinal) ? next : best);
      if (done.has(line.index)) continue;
      done.add(line.index);
      void this.writeMarkReplacing(line, mine);
    }
  }

  private async writeMarkReplacing(line: DocLine, old: LineMark): Promise<void> {
    const slug = this.host.slug();
    if (!slug) return;
    const anchor = anchorForLine(line);
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
    this.bannerEl.dataset.state = n === 0 ? 'aligned' : 'issues';
    this.countEl.textContent = n === 0 ? 'Aligned' : `${n} ${n === 1 ? 'issue' : 'issues'}`;
    this.countEl.title = n === 0
      ? `Every team member has seen every line and no one has rejected anything. Team: ${summary.team.map(actorLabel).join(', ')}`
      : `${summary.counts.lineIssues} lines not yet seen by everyone or rejected; ${summary.counts.reviewMarkIssues} open comments or suggestions; ${summary.counts.askIssues} unanswered ${summary.counts.askIssues === 1 ? 'ask' : 'asks'}. Team: ${summary.team.map(actorLabel).join(', ')}`;
    this.nextBtn.disabled = n === 0;
    this.setShort(n === 0 ? '✓ Aligned' : `${n} ›`);
    this.nextBtn.setAttribute('aria-label', n === 0 ? 'No issues: aligned' : `Next issue (${n} ${n === 1 ? 'issue' : 'issues'})`);
    this.renderAlignedAt(n === 0);
  }

  /** Step B3c: the snapshot link beside the Issue count. */
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
    for (const issue of this.summary?.issues ?? []) if (issue.type === 'line' || issue.type === 'ask') issueLines.add(issue.lineIndex);
    for (const state of this.states) {
      const line = state.line;
      const dom = view.nodeDOM(line.pos) as HTMLElement | null;
      if (!dom || typeof dom.getBoundingClientRect !== 'function') continue;
      const rect = dom.getBoundingClientRect();
      if (rect.height === 0) continue;
      const key = `${line.hash}:${line.occurrence}`;
      used.add(key);
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
      const myStatus: StatusChoice | 'changed' = !mine ? 'unseen' : (mine.current ? mine.mark.status : 'changed');
      dot.dataset.status = myStatus;
      dot.dataset.issue = issueLines.has(line.index) ? 'true' : 'false';
      // Step B3b: your mark survived a small edit (the rail shows what changed).
      if (mine?.carried) dot.dataset.carried = 'true'; else delete dot.dataset.carried;
      const lineHeight = parseFloat(getComputedStyle(dom).lineHeight) || 24;
      const top = rect.top - containerRect.top + Math.max(0, (Math.min(lineHeight, rect.height) - dotSize) / 2);
      dot.style.top = `${Math.round(top)}px`;
      dot.style.left = `${Math.round(Math.max(0, leftEdge))}px`;
      dot.style.width = `${dotSize}px`;
      dot.style.height = `${dotSize}px`;
      const others = [...state.marks.entries()].filter(([k]) => k !== me);
      const pipStatuses = others.slice(0, 4).map(([, entry]) => entry.current ? entry.mark.status : 'changed');
      // Rebuild the dot's children only when they change: a click whose target was replaced
      // between pointerdown and pointerup would be lost.
      const sig = `${myStatus}|${pipStatuses.join(',')}`;
      if (dot.dataset.sig !== sig) {
        dot.dataset.sig = sig;
        const glyph = document.createElement('span');
        glyph.className = 'plm-glyph';
        glyph.textContent = STATUS_GLYPH[myStatus];
        const pips = document.createElement('span');
        pips.className = 'plm-pips';
        for (const status of pipStatuses) {
          const pip = document.createElement('i');
          pip.dataset.status = status;
          pips.append(pip);
        }
        dot.replaceChildren(glyph, pips);
      }
      const othersText = others.map(([, e]) => `${actorLabel(e.mark.by)}: ${e.current ? STATUS_LABEL[e.mark.status] : 'changed since marked'}`).join('; ');
      const carriedText = mine?.carried ? ' (carried over a small edit)' : '';
      dot.setAttribute('aria-label', `Line ${line.index + 1}: your mark ${myStatus === 'changed' ? 'is out of date (the line changed)' : STATUS_LABEL[myStatus as StatusChoice]}${carriedText}${othersText ? `. ${othersText}` : ''}. Mark this line`);
      dot.title = othersText ? `You: ${myStatus === 'changed' ? 'changed since you marked it' : STATUS_LABEL[myStatus as StatusChoice]}\n${othersText.replace(/; /g, '\n')}` : 'Mark this line';
    }
    for (const [key, el] of existing) if (!used.has(key)) el.remove();
  }

  // --------------------------------------------------------------------------
  // Menu / bottom sheet
  // --------------------------------------------------------------------------

  private onGutterClick = (event: MouseEvent): void => {
    const dot = (event.target as HTMLElement).closest('.plm-dot') as HTMLButtonElement | null;
    if (!dot) return;
    event.preventDefault();
    event.stopPropagation();
    const index = Number(dot.dataset.line);
    const line = this.lines[index];
    if (!line) return;
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
    const excerpt = document.createElement('p');
    excerpt.className = 'plm-excerpt';
    excerpt.textContent = line.text.length > 140 ? `${line.text.slice(0, 140)}…` : line.text;
    root.append(excerpt);

    // Step B3: the line's ask comes first: it is the decision the line carries.
    const askView = this.askForLine(line.index);
    const askControl = askView ? this.buildAskControlFor(askView, 'box') : undefined;
    if (askControl) root.append(askControl.root);

    if (mine && !mine.current) {
      const changed = document.createElement('p');
      changed.className = 'plm-changed';
      changed.textContent = `Changed since you marked it ${STATUS_LABEL[mine.mark.status]}. Mark it again.`;
      root.append(changed);
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
      root.append(carried);
    }
    if (mine?.current && mine.mark.status === 'skimmed') {
      const skim = document.createElement('p');
      skim.className = 'plm-skimmed-note';
      skim.textContent = 'You scrolled past this line faster than its reading time, so it is not Seen yet. Stay on it, or mark it.';
      root.append(skim);
    }

    // Step B2: on a folded heading a mark applies to every line of the section (policy).
    const scope = this.host.markScope?.(line.index) ?? null;
    if (scope) {
      const note = document.createElement('p');
      note.className = 'plm-section-note';
      note.textContent = `Folded section: Seen, Agree${this.canApprove || !LINE_MARK_POLICY.approveRequiresOwner ? ' and Approve' : ''} apply to all ${scope.lines.length} lines in it.`;
      root.append(note);
    }
    const sectionHint = document.createElement('p');
    sectionHint.className = 'plm-section-hint';
    sectionHint.hidden = true;
    sectionHint.setAttribute('role', 'status');
    sectionHint.textContent = 'Reject needs a specific line. Unfold the section and reject the line.';
    const unfold = document.createElement('button');
    unfold.type = 'button';
    unfold.textContent = 'Unfold';
    unfold.onclick = () => { this.host.revealLine?.(line.index + 1); };
    sectionHint.append(unfold);

    const choose = (status: StatusChoice, reason?: string, via: MarkVia = 'click'): boolean => {
      if (!this.canMark) return false;
      if (scope && status === 'rejected' && !FOLDING.allowSectionReject) { sectionHint.hidden = false; return false; }
      options.onExplicit?.(status);
      options.onChosen?.(status);
      // onExplicit may have committed accepts on this line, which re-extracts the lines.
      const fresh = this.lines[line.index] ?? line;
      if (scope && status !== 'unseen' && status !== 'rejected') {
        void this.writeSectionMark(scope, status);
        return true;
      }
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
    const reasonInput = document.createElement('input');
    reasonInput.type = 'text';
    reasonInput.maxLength = 500;
    reasonInput.placeholder = 'Reason (one line)';
    reasonInput.setAttribute('aria-label', 'Reason for rejecting this line');
    if (mine?.current && mine.mark.status === 'rejected' && mine.mark.reason) reasonInput.value = mine.mark.reason;
    const reasonSave = document.createElement('button');
    reasonSave.type = 'submit';
    reasonSave.textContent = 'Reject';
    reasonRow.append(reasonInput, reasonSave);
    reasonRow.onsubmit = (event) => {
      event.preventDefault();
      const reason = reasonInput.value.trim();
      if (!reason) { reasonInput.focus(); reasonInput.setAttribute('aria-invalid', 'true'); return; }
      choose('rejected', reason);
    };
    reasonInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      reasonRow.hidden = true;
      reasonInput.blur();
    });
    const openReason = () => {
      if (!this.canMark) return;
      if (scope && !FOLDING.allowSectionReject) { sectionHint.hidden = false; return; }
      reasonRow.hidden = false;
      reasonInput.focus({ preventScroll: true });
    };
    for (const choice of choices) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'plm-choice';
      btn.dataset.status = choice;
      btn.setAttribute('aria-pressed', String(current === choice));
      const g = document.createElement('span'); g.className = 'plm-choice-glyph'; g.textContent = STATUS_GLYPH[choice];
      const l = document.createElement('span'); l.textContent = choice === 'rejected' ? 'Reject…' : STATUS_LABEL[choice].replace('Agreed', 'Agree').replace('Approved', 'Approve');
      btn.append(g, l);
      btn.disabled = !this.canMark;
      btn.onclick = () => {
        if (choice === 'rejected') { openReason(); return; }
        choose(choice);
      };
      actions.append(btn);
    }
    if (mine) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'plm-choice plm-clear';
      clear.textContent = 'Clear my mark';
      clear.disabled = !this.canMark;
      clear.onclick = () => {
        options.onChosen?.('unseen');
        if (scope && FOLDING.sectionClearAllowed) { void this.writeSectionMark(scope, 'unseen'); return; }
        void this.writeMark(line, 'unseen');
      };
      actions.append(clear);
    }
    root.append(actions, reasonRow, sectionHint);

    // Everyone's marks on this line.
    const team = this.summary?.team ?? [];
    const list = document.createElement('ul');
    list.className = 'plm-team';
    for (const member of team) {
      const entry = state?.marks.get(actorKey(member));
      const li = document.createElement('li');
      const who = document.createElement('span');
      who.textContent = actorKey(member) === me ? `${actorLabel(member)} (you)` : actorLabel(member);
      const what = document.createElement('span');
      what.className = 'plm-team-status';
      const status = !entry ? 'unseen' : (entry.current ? entry.mark.status : 'changed');
      what.dataset.status = status;
      what.textContent = status === 'changed' ? 'Changed since marked' : STATUS_LABEL[status as StatusChoice];
      // Step B3b: how a Seen was earned ("Seen by scrolling" vs "Seen, marked").
      if (entry?.current && entry.mark.status === 'seen') {
        const via = (entry.mark.via ?? 'api') as MarkVia;
        what.textContent += ` ${via === 'click' || via === 'key' ? '(marked)' : `(${VIA_LABEL[via]})`}`;
        what.dataset.via = via;
      }
      if (entry?.carried) { what.textContent += ' · carried over a small edit'; what.dataset.carried = 'true'; }
      if (entry?.current && entry.mark.status === 'rejected' && entry.mark.reason) what.textContent += `: ${entry.mark.reason}`;
      li.append(who, what);
      list.append(li);
    }
    root.append(list);
    return { root, openReason, choose: (status, via) => choose(status, undefined, via ?? 'click'), ...(askControl ? { ask: askControl } : {}) };
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
  // Next issue
  // --------------------------------------------------------------------------

  gotoNextIssue(): void {
    const issues = (this.summary?.issues ?? []).filter(issue => issue.pos !== null);
    const view = this.view;
    if (!view || issues.length === 0) return;
    const next = issues.find(issue => (issue.pos as number) > this.lastIssuePos) ?? issues[0];
    this.lastIssuePos = next.pos as number;
    const lineIndex = next.type === 'line' || next.type === 'ask' ? next.lineIndex : this.lineAtPos(next.pos as number);
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
    if (next.type === 'line' || next.type === 'ask') {
      const dot = this.gutter.querySelector(`.plm-dot[data-line="${next.lineIndex}"]`) as HTMLButtonElement | null;
      dot?.focus({ preventScroll: true });
    }
    this.countEl.dataset.current = next.type === 'line' ? `line ${next.lineIndex + 1}` : next.type === 'ask' ? `ask ${next.lineIndex + 1}` : next.type;
  }

  private issueElement(view: EditorView, issue: ProofIssue): HTMLElement | null {
    if (issue.type === 'line' || issue.type === 'ask') {
      const line = this.lines[issue.lineIndex];
      return line ? view.nodeDOM(line.pos) as HTMLElement | null : null;
    }
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
   * Step B2: the viewer marks a whole folded section in one request (the batch form of the
   * line-marks route), then gets a one-step Undo that restores each line's earlier mark.
   */
  async writeSectionMark(scope: { lines: number[]; heading: string }, status: StatusChoice): Promise<boolean> {
    const slug = this.host.slug();
    if (!slug || !this.canMark || status === 'rejected') return false;
    const by = this.me();
    const me = actorKey(by);
    const indices = scope.lines.filter(index => this.lines[index]);
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
    this.toastWithAction(`${label}: ${entries.length} ${entries.length === 1 ? 'line' : 'lines'} in “${scope.heading.slice(0, 40)}”.`, 'Undo', () => {
      // One step back: every line gets the mark it had before (or none).
      this.sectionWrites += 1;
      void post(entries.map((entry, i) => ({
        anchor: anchors[i],
        status: entry.previous ? entry.previous.status : 'unseen',
        ...(entry.previous?.reason ? { reason: entry.previous.reason } : {}),
      })), 'unseen');
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

  /** Test and agent hook: the numbers the UI shows. */
  debugState(): { loaded: boolean; issues: number; aligned: boolean; team: string[]; lines: number; marks: LineMark[]; sectionWrites: number; askIssues: number; askAnswers: number; asks: Array<Record<string, unknown>>; skimWrites: number; snapshot: { id: string; createdAt: string } | null; carried: Array<{ line: number; by: string; from: string | null }> } {
    return {
      skimWrites: this.skimWrites,
      snapshot: this.snapshot,
      carried: this.states.flatMap(state => [...state.marks.values()].filter(e => e.carried).map(e => ({ line: state.line.index, by: e.mark.by, from: e.carriedFrom ?? null }))),
      askIssues: this.summary?.counts.askIssues ?? -1,
      askAnswers: this.askAnswers,
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
