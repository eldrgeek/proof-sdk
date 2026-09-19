/**
 * Proof Documents Step B7 — chat in the right rail (desktop) and a bottom sheet (phone).
 *
 * Authorship: requirement by Mike Wolf ("A Proof document has a chat sidebar. The sidebar can be
 * closed or open. It must be usable on mobile." and, 18 Sept, "room on the right for a chat
 * panel"); the COS's proposal; built by Claude Opus 5 (worker proof-chat), 2026-09-19.
 *
 * - Any team member, human or AI, posts. A message can point at lines ("📍 this line", or the
 *   lines selected with shift-click in the margin); a pointer is a chip that moves the focus line.
 * - An AI's message that proposes an edit arrives with a suggestion the server already created:
 *   the chat shows a card, "proposed a change → View", and the change is in the text as a normal
 *   suggestion. The page itself never edits the text for chat.
 * - Messages live beside the document (their own table). This UI reads GET /chat?after=<cursor>
 *   (poll, woken by the room's chat.updated broadcast) and writes POST /chat. It never touches the
 *   editor's state, so it cannot start a write loop.
 * - An unread @mention of the viewer is a badge on the rail toggle and the phone's ⋯ button. Chat is
 *   never an Issue.
 */
import type { Mark, CommentData, ReplaceData } from '../formats/marks';
import { actorKey, actorLabel, anchorForLine, isAiActor, registerActorLabels, resolveLineAnchor, type DocLine, type LineAnchor } from '../shared/line-marks';
import { actorTrust } from '../shared/identity';
import {
  CHAT_POLICY,
  cleanChatText,
  findMentions,
  mentionNamesFor,
  mentionQueryAt,
  tokenizeChat,
  unreadMentions,
  type MentionCandidate,
  type ProofChatMessage,
} from '../shared/chat';
import type { LineMarksUI } from './line-marks';
import './chat.css';

export interface ChatHost {
  slug(): string | null;
  apiBase(): string;
  authHeaders(): Record<string, string>;
  lineMarks(): LineMarksUI;
  /** The reading walk's focus line. */
  focusIndex(): number;
  /** Moves the focus line (the reading walk scrolls there). */
  focusLine(index: number): boolean;
  /** Every review mark in the editor (suggestion status, comment replies). */
  marks(): Mark[];
  /** Desktop: the right rail is open (not collapsed). */
  railOpen(): boolean;
  /** Desktop: opens the right rail. */
  openRail(): void;
  /** The unread @mention count changed (badges on the rail toggle and the ⋯ button). */
  onUnread(count: number): void;
  /** Phones: other bottom sheets close when the chat sheet opens. */
  closeOtherSheets?(): void;
}

const PHONE_QUERY = '(max-width: 700px)';
const COLLAPSE_KEY = 'proof:chat-collapsed';
const READ_KEY = 'proof:chat-read';

function isPhone(): boolean {
  try { return window.matchMedia(PHONE_QUERY).matches; } catch { return window.innerWidth <= 700; }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  b.onclick = onClick;
  return b;
}

function formatTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const now = new Date();
  const sameDay = at.toDateString() === now.toDateString();
  return sameDay
    ? at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : at.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

interface Attachment { anchor: LineAnchor; index: number }

export class ChatUI {
  /** The chat section (lives in the right rail on desktop, in the sheet on a phone). */
  readonly root = el('section', 'pch');
  private readonly head = el('div', 'pch-head');
  private readonly toggle = el('button', 'pch-toggle');
  private readonly countEl = el('span', 'pch-count');
  private readonly list = el('ol', 'pch-list');
  private readonly empty = el('p', 'pch-empty', 'No messages yet. 📍 points a message at a line.');
  private readonly composer = el('form', 'pch-composer');
  private readonly replyBar = el('div', 'pch-replybar');
  private readonly chips = el('div', 'pch-attached');
  private readonly input = el('textarea', 'pch-input');
  private readonly suggest = el('ul', 'pch-suggest');
  private readonly pin = el('button', 'pch-pin');
  private readonly send = el('button', 'pch-send', 'Send');
  private readonly status = el('p', 'pch-status');
  private readonly sheet = el('div', 'pch-sheet');
  private readonly sheetHead = el('div', 'pch-sheet-head');
  private messages: ProofChatMessage[] = [];
  private cursor = 0;
  private loaded = false;
  private candidates: MentionCandidate[] = [];
  private canPost = true;
  private attachments: Attachment[] = [];
  private picked: string[] = [];
  private replyTo: ProofChatMessage | null = null;
  private suggestIndex = 0;
  private suggestItems: Array<{ actor: string; name: string }> = [];
  /** The reader's own choice (null: never chosen; then CHAT_POLICY decides). */
  private collapsedPref: boolean | null = null;
  private get collapsed(): boolean {
    if (this.collapsedPref !== null) return this.collapsedPref;
    // Short windows: an empty chat starts folded so the line's box keeps its room.
    return this.loaded && this.messages.length === 0 && window.innerHeight < CHAT_POLICY.foldEmptyChatBelowHeightPx;
  }
  private sheetOpen = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private fetching: Promise<void> | null = null;
  private refetch = false;
  private started = false;
  private sending = false;
  private listSig = '';
  private lastUnread = -1;
  private lineCountCache: { sig: string; counts: Map<number, number> } = { sig: '', counts: new Map() };
  /** Test hooks. */
  private readonly sent: number[] = [];
  private readonly pointerClicks: number[] = [];

  constructor(private readonly host: ChatHost) {
    this.root.setAttribute('aria-label', 'Chat');
    this.toggle.type = 'button';
    this.toggle.onclick = () => this.setCollapsed(!this.collapsed);
    const title = el('strong', undefined, 'Chat');
    this.toggle.append(el('span', 'pch-caret'), title, this.countEl);
    this.head.append(this.toggle);
    this.list.setAttribute('aria-live', 'polite');
    this.list.setAttribute('aria-label', 'Messages');
    this.buildComposer();
    this.root.append(this.head, this.empty, this.list, this.composer);
    // Phone sheet.
    this.sheet.setAttribute('role', 'dialog');
    this.sheet.setAttribute('aria-label', 'Chat');
    this.sheet.hidden = true;
    const close = button('×', 'pch-sheet-close', () => this.closeSheet());
    close.setAttribute('aria-label', 'Close chat');
    this.sheetHead.append(el('strong', undefined, 'Chat'), close);
    this.sheet.append(this.sheetHead);
    try { const saved = localStorage.getItem(COLLAPSE_KEY); this.collapsedPref = saved === null ? null : saved === '1'; } catch { this.collapsedPref = null; }
    this.applyCollapsed();
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;
    document.body.append(this.sheet);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('resize', this.onResize);
    window.visualViewport?.addEventListener('resize', this.syncKeyboard);
    window.visualViewport?.addEventListener('scroll', this.syncKeyboard);
    this.unsubscribe = this.host.lineMarks().subscribe(() => this.onLinesChanged());
    this.place();
    void this.refresh();
    this.schedulePoll();
  }

  stop(): void {
    this.started = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('resize', this.onResize);
    window.visualViewport?.removeEventListener('resize', this.syncKeyboard);
    window.visualViewport?.removeEventListener('scroll', this.syncKeyboard);
    this.unsubscribe?.();
    this.sheet.remove();
  }

  private unsubscribe: (() => void) | null = null;

  /** Desktop: the right rail hosts the chat. Called by the reading walk with its rail body. */
  private railHost: HTMLElement | null = null;
  mountIn(host: HTMLElement): void {
    this.railHost = host;
    this.place();
  }

  /** A room broadcast or an event said the chat changed. */
  notifyRemoteChange(): void { void this.refresh(); }

  private place(): void {
    if (isPhone()) {
      if (this.root.parentElement !== this.sheet) this.sheet.append(this.root);
    } else {
      this.closeSheet();
      if (this.railHost && this.root.parentElement !== this.railHost) this.railHost.append(this.root);
    }
    this.root.classList.toggle('pch-in-sheet', isPhone());
    this.applyCollapsed();
  }

  private onResize = (): void => { this.place(); this.markReadIfVisible(); };

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') { void this.refresh(); this.markReadIfVisible(); }
  };

  /** Keeps the sheet (and its composer) above the on-screen keyboard. */
  private syncKeyboard = (): void => {
    const vv = window.visualViewport;
    const offset = vv ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) : 0;
    document.documentElement.style.setProperty('--proof-keyboard-offset', `${offset}px`);
  };

  // --------------------------------------------------------------------------
  // Data
  // --------------------------------------------------------------------------

  private schedulePoll(): void {
    if (!this.started) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (document.visibilityState === 'visible') void this.refresh();
      this.schedulePoll();
    }, CHAT_POLICY.pollMs);
  }

  async refresh(): Promise<void> {
    if (this.fetching) { this.refetch = true; return this.fetching; }
    this.fetching = this.fetchNow().finally(() => {
      this.fetching = null;
      if (this.refetch) { this.refetch = false; void this.refresh(); }
    });
    return this.fetching;
  }

  private async fetchNow(): Promise<void> {
    const slug = this.host.slug();
    if (!slug) return;
    const after = this.loaded ? `?after=${this.cursor}` : '';
    try {
      const response = await fetch(`${this.host.apiBase()}/documents/${encodeURIComponent(slug)}/chat${after}`, {
        headers: this.host.authHeaders(), credentials: 'same-origin',
      });
      if (!response.ok) return;
      const body = await response.json() as { messages?: ProofChatMessage[]; cursor?: number; candidates?: MentionCandidate[]; labels?: Record<string, string>; canPost?: boolean };
      registerActorLabels(body.labels ?? {});
      if (Array.isArray(body.candidates)) this.candidates = body.candidates;
      this.canPost = body.canPost !== false;
      const incoming = Array.isArray(body.messages) ? body.messages : [];
      const known = new Set(this.messages.map(m => m.id));
      for (const message of incoming) if (!known.has(message.id)) this.messages.push(message);
      this.messages.sort((a, b) => a.id - b.id);
      if (typeof body.cursor === 'number' && body.cursor > this.cursor) this.cursor = body.cursor;
      this.loaded = true;
      this.render();
      // The margin's speech bubbles follow the messages.
      if (incoming.length) this.host.lineMarks().notifyChatChanged();
    } catch {
      // Offline: the next poll retries.
    }
  }

  private onLinesChanged(): void {
    if (!this.loaded) return;
    this.render();
  }

  // --------------------------------------------------------------------------
  // Lines
  // --------------------------------------------------------------------------

  private lines(): DocLine[] { return this.host.lineMarks().lineList(); }

  private resolve(anchor: LineAnchor): { index: number; current: boolean } | null {
    const r = resolveLineAnchor(this.lines(), anchor);
    return r ? { index: r.lineIndex, current: r.current } : null;
  }

  /** Messages that point at each line (for the margin's speech bubbles). */
  lineCounts(): Map<number, number> {
    const lines = this.lines();
    const sig = `${this.messages.length}:${this.cursor}:${lines.length}:${lines[0]?.hash ?? ''}:${lines[lines.length - 1]?.hash ?? ''}`;
    if (sig === this.lineCountCache.sig) return this.lineCountCache.counts;
    const counts = new Map<number, number>();
    for (const message of this.messages) {
      const seen = new Set<number>();
      for (const anchor of message.lines) {
        const r = resolveLineAnchor(lines, anchor);
        if (!r || !r.current || seen.has(r.lineIndex)) continue;
        seen.add(r.lineIndex);
        counts.set(r.lineIndex, (counts.get(r.lineIndex) ?? 0) + 1);
      }
    }
    this.lineCountCache = { sig, counts };
    return counts;
  }

  /** A speech bubble in the margin was clicked: open the chat at the newest message about that line. */
  showLine(index: number): void {
    this.open();
    const target = [...this.messages].reverse().find(m => m.lines.some(a => this.resolve(a)?.index === index));
    if (!target) return;
    const item = this.list.querySelector(`[data-id="${target.id}"]`) as HTMLElement | null;
    if (item) { item.scrollIntoView({ block: 'nearest' }); this.flash(item); }
  }

  private flash(node: HTMLElement): void {
    node.classList.remove('pch-flash');
    void node.offsetWidth;
    node.classList.add('pch-flash');
    setTimeout(() => node.classList.remove('pch-flash'), 1300);
  }

  // --------------------------------------------------------------------------
  // Open / close
  // --------------------------------------------------------------------------

  /** Opens the chat (the rail section on desktop, the bottom sheet on a phone) and focuses the composer. */
  open(focus = false): void {
    if (isPhone()) {
      this.host.closeOtherSheets?.();
      this.sheetOpen = true;
      this.sheet.hidden = false;
      this.syncKeyboard();
    } else {
      if (!this.host.railOpen()) this.host.openRail();
      if (this.collapsed) this.setCollapsed(false);
    }
    this.scrollToEnd();
    this.markReadIfVisible();
    if (focus) this.input.focus({ preventScroll: true });
  }

  closeSheet(): void {
    if (!this.sheetOpen) return;
    this.sheetOpen = false;
    this.sheet.hidden = true;
    this.closeSuggest();
  }

  isSheetOpen(): boolean { return this.sheetOpen; }

  private setCollapsed(collapsed: boolean): void {
    this.collapsedPref = collapsed;
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* optional */ }
    this.applyCollapsed();
    if (!collapsed) { this.scrollToEnd(); this.markReadIfVisible(); }
  }

  private applyCollapsed(): void {
    const collapsed = this.collapsed && !isPhone();
    this.root.dataset.collapsed = String(collapsed);
    this.toggle.setAttribute('aria-expanded', String(!collapsed));
    this.toggle.setAttribute('aria-label', collapsed ? 'Show chat' : 'Hide chat');
  }

  /** The chat is on screen for the viewer right now. */
  private visible(): boolean {
    if (document.visibilityState !== 'visible') return false;
    if (isPhone()) return this.sheetOpen;
    return this.host.railOpen() && !this.collapsed && Boolean(this.railHost?.isConnected);
  }

  // --------------------------------------------------------------------------
  // Unread @mentions
  // --------------------------------------------------------------------------

  private readKey(): string | null {
    const slug = this.host.slug();
    return slug ? `${READ_KEY}:${slug}:${actorKey(this.host.lineMarks().me())}` : null;
  }

  private lastRead(): number {
    const key = this.readKey();
    if (!key) return 0;
    try { return Number(localStorage.getItem(key) || 0) || 0; } catch { return 0; }
  }

  private markReadIfVisible(): void {
    if (!this.loaded || !this.visible()) return;
    const key = this.readKey();
    const newest = this.messages[this.messages.length - 1]?.id ?? 0;
    if (key && newest > this.lastRead()) {
      try { localStorage.setItem(key, String(newest)); } catch { /* optional */ }
    }
    this.updateUnread();
  }

  unreadCount(): number {
    return unreadMentions(this.messages, this.host.lineMarks().me(), this.lastRead(), actorKey);
  }

  private updateUnread(): void {
    const n = this.unreadCount();
    this.countEl.textContent = n > 0 ? `${n} @you` : (this.messages.length ? String(this.messages.length) : '');
    this.countEl.dataset.unread = String(n > 0);
    if (n !== this.lastUnread) {
      this.lastUnread = n;
      this.host.onUnread(n);
    }
  }

  // --------------------------------------------------------------------------
  // Rendering
  // --------------------------------------------------------------------------

  private scrollToEnd(): void {
    requestAnimationFrame(() => { this.list.scrollTop = this.list.scrollHeight; });
  }

  private mentionNames(): string[] {
    const names = new Set<string>();
    for (const c of this.allCandidates(true)) for (const n of c.names) names.add(n);
    return [...names];
  }

  /** Server candidates plus the page's team (so a new AI can be @mentioned before it chats). */
  private allCandidates(includeMe = false): MentionCandidate[] {
    const out = new Map<string, MentionCandidate>();
    for (const c of this.candidates) out.set(actorKey(c.actor), { actor: c.actor, names: [...c.names] });
    for (const actor of this.host.lineMarks().issueSummary()?.team ?? []) {
      const key = actorKey(actor);
      if (out.has(key)) continue;
      out.set(key, { actor, names: mentionNamesFor(actor, actorLabel(actor)) });
    }
    const me = this.host.lineMarks().me();
    if (includeMe && !out.has(actorKey(me))) out.set(actorKey(me), { actor: me, names: mentionNamesFor(me, actorLabel(me)) });
    return [...out.values()].filter(c => (includeMe || actorKey(c.actor) !== actorKey(me)) && c.names.length > 0);
  }

  private render(): void {
    const lines = this.lines();
    const marks = this.safeMarks();
    const markSig = marks.filter(m => this.messages.some(msg => msg.suggestion?.markId === m.id || msg.commentMarkId === m.id))
      .map(m => `${m.id}:${(m.data as { status?: string })?.status ?? ''}:${((m.data as CommentData)?.replies ?? []).length}`).join(',');
    const sig = `${this.messages.map(m => m.id).join(',')}|${lines.length}:${lines.map(l => l.hash).join('').length}|${markSig}|${this.host.lineMarks().me()}|${this.canPost}`;
    this.applyCollapsed();
    this.empty.hidden = this.messages.length > 0;
    this.composer.hidden = !this.canPost;
    if (sig !== this.listSig) {
      const nearEnd = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 60;
      this.listSig = sig;
      const byId = new Map(this.messages.map(m => [m.id, m]));
      const names = this.mentionNames();
      this.list.replaceChildren(...this.messages.map(m => this.renderMessage(m, byId, names, marks)));
      if (nearEnd || !this.list.dataset.scrolled) { this.list.dataset.scrolled = '1'; this.scrollToEnd(); }
    }
    this.renderPin();
    this.updateUnread();
    this.markReadIfVisible();
  }

  private safeMarks(): Mark[] {
    try { return this.host.marks(); } catch { return []; }
  }

  /** The name shown for an actor: an AI by its key's label ("Claude COS"), everyone else as the rail names them. */
  private label(actor: string): string {
    if (isAiActor(actor)) {
      const c = this.candidates.find(x => actorKey(x.actor) === actorKey(actor));
      if (c?.names[0]) return c.names[0];
    }
    return actorLabel(actor);
  }

  private renderAuthor(actor: string): HTMLElement {
    const who = el('span', 'pch-who');
    const trust = actorTrust(actor);
    who.dataset.trust = trust;
    const name = el('strong', 'pch-name', this.label(actor));
    who.append(name);
    if (trust === 'verified') {
      const badge = el('span', 'pch-verified', '✓');
      badge.title = 'Signed in';
      badge.setAttribute('aria-label', 'signed in');
      who.append(badge);
    } else if (trust === 'ai') {
      const badge = el('span', 'pch-ai', 'AI');
      badge.title = actor;
      who.append(badge);
    } else {
      who.append(el('span', 'pch-guest', 'unverified'));
    }
    who.title = actor;
    return who;
  }

  private renderText(text: string, names: string[]): HTMLElement {
    const p = el('div', 'pch-text');
    const me = this.host.lineMarks().me();
    const myNames = mentionNamesFor(me, actorLabel(me)).map(n => n.toLowerCase());
    for (const seg of tokenizeChat(text, names)) {
      if (seg.type === 'text') p.append(seg.text);
      else if (seg.type === 'code') p.append(el('code', undefined, seg.text));
      else if (seg.type === 'bold') p.append(el('strong', undefined, seg.text));
      else if (seg.type === 'mention') {
        const m = el('span', 'pch-mention', seg.text);
        if (myNames.includes(seg.text.slice(1).toLowerCase())) m.dataset.me = 'true';
        p.append(m);
      } else {
        const a = el('a', undefined, seg.text);
        a.href = seg.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer nofollow';
        p.append(a);
      }
    }
    return p;
  }

  private pointerChip(anchor: LineAnchor): HTMLElement {
    const r = this.resolve(anchor);
    const chip = el('button', 'pch-pointer');
    chip.type = 'button';
    if (!r) {
      chip.disabled = true;
      chip.textContent = `📍 (line removed) ${anchor.excerpt.slice(0, 40)}`;
      chip.title = 'This line is no longer in the document';
      return chip;
    }
    const line = this.lines()[r.index];
    chip.dataset.line = String(r.index);
    chip.textContent = `📍 ${r.index + 1}${r.current ? '' : ' (changed)'} · ${(line?.text ?? anchor.excerpt).slice(0, 48)}`;
    chip.title = `Go to line ${r.index + 1}`;
    chip.onclick = () => this.gotoLine(r.index);
    return chip;
  }

  private gotoLine(index: number): void {
    this.pointerClicks.push(index);
    if (isPhone()) this.closeSheet();
    this.host.focusLine(index);
  }

  private findMark(id: string | null | undefined, marks: Mark[]): Mark | null {
    return id ? marks.find(m => m.id === id) ?? null : null;
  }

  private renderMessage(message: ProofChatMessage, byId: Map<number, ProofChatMessage>, names: string[], marks: Mark[]): HTMLElement {
    const li = el('li', 'pch-msg');
    li.dataset.id = String(message.id);
    li.dataset.kind = message.kind;
    const me = actorKey(this.host.lineMarks().me());
    if (actorKey(message.by) === me) li.dataset.mine = 'true';
    if (message.mentions.some(a => actorKey(a) === me) && actorKey(message.by) !== me) li.dataset.mentionsMe = 'true';
    const head = el('div', 'pch-msg-head');
    const time = el('time', 'pch-time', formatTime(message.createdAt));
    time.dateTime = message.createdAt;
    head.append(this.renderAuthor(message.by));
    if (message.kind !== 'message') head.append(el('span', 'pch-kind', message.kind === 'explain' ? 'Explain' : 'Ask why'));
    head.append(time);
    li.append(head);
    if (message.replyTo) {
      const parent = byId.get(message.replyTo);
      const quote = el('button', 'pch-quote');
      quote.type = 'button';
      quote.textContent = parent ? `↪ ${this.label(parent.by)}: ${parent.text.replace(/\*\*|`/g, '').replace(/\s+/g, ' ').slice(0, CHAT_POLICY.replyExcerpt)}` : '↪ an earlier message';
      quote.onclick = () => {
        const target = this.list.querySelector(`[data-id="${message.replyTo}"]`) as HTMLElement | null;
        if (target) { target.scrollIntoView({ block: 'nearest' }); this.flash(target); }
      };
      li.append(quote);
    }
    li.append(this.renderText(message.text, names));
    if (message.lines.length) {
      const row = el('div', 'pch-pointers');
      for (const anchor of message.lines) row.append(this.pointerChip(anchor));
      li.append(row);
    }
    if (message.suggestion) li.append(this.suggestionCard(message, marks));
    if (message.commentMarkId) {
      const thread = this.threadView(message.commentMarkId, marks, message.kind);
      if (thread) li.append(thread);
    }
    const actions = el('div', 'pch-msg-actions');
    if (this.canPost) actions.append(button('Reply', 'pch-link pch-reply', () => this.startReply(message)));
    li.append(actions);
    return li;
  }

  private suggestionCard(message: ProofChatMessage, marks: Mark[]): HTMLElement {
    const s = message.suggestion!;
    const card = el('div', 'pch-proposal');
    card.dataset.markId = s.markId;
    const mark = this.findMark(s.markId, marks);
    const status = mark ? ((mark.data as { status?: string })?.status ?? 'pending') : 'gone';
    card.dataset.status = status;
    const title = el('div', 'pch-proposal-head');
    title.append(el('span', undefined, `${this.label(message.by)} proposed a change`));
    const view = button('View →', 'pch-link pch-view', () => this.viewMark(s.markId));
    view.disabled = !mark;
    title.append(view);
    card.append(title);
    const body = el('div', 'pch-proposal-body');
    if (s.kind === 'replace' || s.kind === 'delete') body.append(el('del', undefined, s.quote.slice(0, 300)));
    if (s.kind === 'replace') body.append(' → ');
    if (s.kind === 'insert') body.append(el('span', 'pch-after', `after “${s.quote.slice(0, 60)}”: `));
    if (s.kind !== 'delete') body.append(el('ins', undefined, (s.content ?? (mark?.data as ReplaceData)?.content ?? '').slice(0, 400)));
    card.append(body);
    if (s.why) {
      const why = el('p', 'pch-why');
      why.append(el('span', 'pch-why-label', 'Why: '), s.why);
      card.append(why);
    }
    const label = status === 'pending' ? 'In the text as a suggestion: accept or reject it there.'
      : status === 'accepted' ? 'Accepted.' : status === 'rejected' ? 'Rejected.' : 'No longer pending.';
    card.append(el('p', 'pch-proposal-status', label));
    return card;
  }

  private threadView(markId: string, marks: Mark[], kind: string): HTMLElement | null {
    const mark = this.findMark(markId, marks);
    if (!mark) return null;
    const replies = (mark.data as CommentData)?.replies ?? [];
    const wrap = el('div', 'pch-thread');
    const head = el('div', 'pch-thread-head');
    head.append(el('span', undefined, replies.length ? `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'} on the line’s thread` : (kind === 'message' ? 'Thread on the line' : 'Waiting for an answer on the line’s thread')));
    head.append(button('View →', 'pch-link pch-view', () => this.viewMark(markId)));
    wrap.append(head);
    for (const reply of replies.slice(-5)) {
      const r = el('div', 'pch-thread-reply');
      r.append(this.renderAuthor(reply.by ?? ''), el('span', 'pch-thread-text', ` ${reply.text ?? ''}`));
      wrap.append(r);
    }
    return wrap;
  }

  /** Moves the focus to the line that holds a review mark and flashes the mark in the text. */
  private viewMark(markId: string): void {
    const mark = this.findMark(markId, this.safeMarks());
    if (!mark || typeof mark.range?.from !== 'number') return;
    const index = this.host.lineMarks().lineAtPos(mark.range.from);
    if (index >= 0) this.gotoLine(index);
    requestAnimationFrame(() => {
      const node = document.querySelector(`.ProseMirror [data-mark-id="${CSS.escape(markId)}"]`) as HTMLElement | null;
      if (!node) return;
      node.classList.remove('pch-mark-flash');
      void node.offsetWidth;
      node.classList.add('pch-mark-flash');
      setTimeout(() => node.classList.remove('pch-mark-flash'), 1600);
    });
  }

  // --------------------------------------------------------------------------
  // Composer
  // --------------------------------------------------------------------------

  private buildComposer(): void {
    this.composer.setAttribute('aria-label', 'Write a message');
    this.input.rows = 2;
    this.input.placeholder = 'Message the team… (@ to mention)';
    this.input.setAttribute('aria-label', 'Chat message');
    this.input.maxLength = CHAT_POLICY.maxText;
    this.suggest.hidden = true;
    this.suggest.setAttribute('role', 'listbox');
    this.suggest.setAttribute('aria-label', 'Mention');
    this.replyBar.hidden = true;
    this.pin.type = 'button';
    this.pin.onclick = () => this.attachFocus();
    this.send.type = 'submit';
    this.status.setAttribute('role', 'status');
    const row = el('div', 'pch-row');
    row.append(this.pin, this.send);
    const field = el('div', 'pch-field');
    field.append(this.input, this.suggest);
    this.composer.append(this.replyBar, this.chips, field, row, this.status);
    this.composer.onsubmit = (event) => { event.preventDefault(); void this.submit(); };
    this.input.addEventListener('keydown', this.onInputKey);
    this.input.addEventListener('input', () => { this.input.classList.toggle('pch-has-text', this.input.value.length > 0); this.updateSuggest(); });
    this.input.addEventListener('click', () => this.updateSuggest());
    this.input.addEventListener('blur', () => setTimeout(() => this.closeSuggest(), 150));
    this.input.addEventListener('focus', () => { if (isPhone()) this.syncKeyboard(); });
    // Keys typed in the chat belong to the chat: the reading walk's A/R/J/K/Y/N/T/E/1-9 must not fire.
    this.composer.addEventListener('keydown', event => event.stopPropagation());
    this.composer.addEventListener('keyup', event => event.stopPropagation());
    this.composer.addEventListener('keypress', event => event.stopPropagation());
  }

  private onInputKey = (event: KeyboardEvent): void => {
    if (!this.suggest.hidden && this.suggestItems.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const n = this.suggestItems.length;
        this.suggestIndex = (this.suggestIndex + (event.key === 'ArrowDown' ? 1 : n - 1)) % n;
        this.renderSuggest();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        this.pickMention(this.suggestItems[this.suggestIndex]);
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); this.closeSuggest(); return; }
    }
    if (event.key === 'Escape' && this.replyTo) { event.preventDefault(); this.cancelReply(); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void this.submit();
    }
  };

  private updateSuggest(): void {
    const q = mentionQueryAt(this.input.value, this.input.selectionStart ?? this.input.value.length);
    if (!q) { this.closeSuggest(); return; }
    const query = q.query.toLowerCase();
    const items: Array<{ actor: string; name: string }> = [];
    for (const c of this.allCandidates()) {
      const name = c.names.find(n => n.toLowerCase().startsWith(query)) ?? (query ? c.names.find(n => n.toLowerCase().includes(query)) : c.names[0]);
      if (name) items.push({ actor: c.actor, name: query ? name : c.names[0] });
    }
    items.sort((a, b) => Number(isAiActor(b.actor)) - Number(isAiActor(a.actor)) || a.name.localeCompare(b.name));
    this.suggestItems = items.slice(0, 8);
    this.suggestIndex = 0;
    if (!this.suggestItems.length) { this.closeSuggest(); return; }
    this.renderSuggest();
  }

  private renderSuggest(): void {
    this.suggest.hidden = false;
    this.suggest.replaceChildren(...this.suggestItems.map((item, i) => {
      const li = el('li', 'pch-suggest-item');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === this.suggestIndex));
      li.dataset.actor = item.actor;
      li.append(el('span', 'pch-suggest-name', item.name), el('span', 'pch-suggest-kind', isAiActor(item.actor) ? 'AI' : actorTrust(item.actor) === 'verified' ? 'person' : 'guest'));
      li.onmousedown = (event) => { event.preventDefault(); this.pickMention(item); };
      return li;
    }));
  }

  private closeSuggest(): void {
    this.suggest.hidden = true;
    this.suggestItems = [];
  }

  private pickMention(item: { actor: string; name: string } | undefined): void {
    if (!item) return;
    const caret = this.input.selectionStart ?? this.input.value.length;
    const q = mentionQueryAt(this.input.value, caret);
    if (!q) return;
    const before = this.input.value.slice(0, q.start);
    const after = this.input.value.slice(caret);
    const insert = `@${item.name} `;
    this.input.value = before + insert + after;
    const at = before.length + insert.length;
    this.input.setSelectionRange(at, at);
    if (!this.picked.some(a => actorKey(a) === actorKey(item.actor))) this.picked.push(item.actor);
    this.closeSuggest();
    this.input.focus({ preventScroll: true });
  }

  /** "📍 this line": attaches the focus line, or the lines selected with shift-click in the margin. */
  private attachFocus(): void {
    const lm = this.host.lineMarks();
    const lines = lm.lineList();
    const selected = lm.selectionLines();
    const indices = selected.length > 1 ? selected : [this.host.focusIndex()];
    for (const index of indices) {
      const line = lines[index];
      if (!line || this.attachments.some(a => a.anchor.hash === line.hash && a.anchor.occurrence === line.occurrence)) continue;
      if (this.attachments.length >= CHAT_POLICY.maxLines) break;
      this.attachments.push({ anchor: anchorForLine(line), index });
    }
    if (selected.length > 1) lm.clearSelection();
    this.renderChips();
    this.input.focus({ preventScroll: true });
  }

  private renderPin(): void {
    const lm = this.host.lineMarks();
    const selected = lm.selectionLines();
    this.pin.textContent = selected.length > 1 ? `📍 lines ${selected[0] + 1}–${selected[selected.length - 1] + 1}` : '📍 this line';
    this.pin.title = selected.length > 1 ? 'Point this message at the lines selected in the margin' : `Point this message at line ${this.host.focusIndex() + 1} (the focus line). Shift-click margin dots to select several.`;
    this.renderChips();
  }

  private renderChips(): void {
    this.chips.hidden = this.attachments.length === 0;
    this.chips.replaceChildren(...this.attachments.map((a, i) => {
      const r = this.resolve(a.anchor);
      const chip = el('span', 'pch-chip');
      chip.dataset.line = String(r?.index ?? a.index);
      chip.append(el('span', undefined, `📍 ${(r?.index ?? a.index) + 1} · ${a.anchor.excerpt.slice(0, 32)}`));
      const x = button('×', 'pch-chip-x', () => { this.attachments.splice(i, 1); this.renderChips(); });
      x.setAttribute('aria-label', `Remove line ${(r?.index ?? a.index) + 1}`);
      chip.append(x);
      return chip;
    }));
  }

  private startReply(message: ProofChatMessage): void {
    this.replyTo = message;
    this.replyBar.hidden = false;
    this.replyBar.replaceChildren(el('span', undefined, `Replying to ${this.label(message.by)}: ${message.text.slice(0, 60)}`), button('×', 'pch-chip-x', () => this.cancelReply()));
    if (isPhone() && !this.sheetOpen) this.open();
    this.input.focus({ preventScroll: true });
  }

  private cancelReply(): void {
    this.replyTo = null;
    this.replyBar.hidden = true;
    this.replyBar.replaceChildren();
  }

  private async submit(): Promise<void> {
    const text = cleanChatText(this.input.value);
    if (!text || this.sending) return;
    const slug = this.host.slug();
    if (!slug) return;
    this.sending = true;
    this.send.disabled = true;
    this.status.textContent = '';
    // Mentions: the ones picked from the list that are still in the text, plus any typed @name.
    const candidates = this.allCandidates();
    const typed = findMentions(text, candidates);
    const mentions = [...this.picked.filter(actor => {
      const c = candidates.find(x => actorKey(x.actor) === actorKey(actor));
      return c ? c.names.some(n => text.toLowerCase().includes(`@${n.toLowerCase()}`)) : false;
    }), ...typed].filter((a, i, all) => all.findIndex(b => actorKey(b) === actorKey(a)) === i);
    try {
      const response = await fetch(`${this.host.apiBase()}/documents/${encodeURIComponent(slug)}/chat`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { ...this.host.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ by: this.host.lineMarks().me(), text, lines: this.attachments.map(a => a.anchor), mentions, replyTo: this.replyTo?.id ?? null }),
      });
      const body = await response.json().catch(() => ({})) as { message?: ProofChatMessage; error?: string };
      if (!response.ok || !body.message) {
        this.status.textContent = body.error || 'Could not send the message';
        return;
      }
      this.sent.push(body.message.id);
      this.input.value = '';
      this.input.classList.remove('pch-has-text');
      this.attachments = [];
      this.picked = [];
      this.cancelReply();
      this.renderChips();
      if (!this.messages.some(m => m.id === body.message!.id)) this.messages.push(body.message);
      this.messages.sort((a, b) => a.id - b.id);
      this.render();
      this.scrollToEnd();
      this.host.lineMarks().notifyChatChanged();
      void this.refresh();
    } catch {
      this.status.textContent = 'Could not send the message (offline?)';
    } finally {
      this.sending = false;
      this.send.disabled = false;
    }
  }

  // --------------------------------------------------------------------------
  // Test hook
  // --------------------------------------------------------------------------

  debugState(): Record<string, unknown> {
    return {
      loaded: this.loaded,
      cursor: this.cursor,
      messages: this.messages.map(m => ({ id: m.id, by: m.by, text: m.text, kind: m.kind, lines: m.lines.length, mentions: m.mentions, suggestion: m.suggestion?.markId ?? null, commentMarkId: m.commentMarkId, replyTo: m.replyTo })),
      unread: this.unreadCount(),
      lastRead: this.lastRead(),
      sheetOpen: this.sheetOpen,
      collapsed: this.collapsed,
      visible: this.visible(),
      attachments: this.attachments.map(a => a.index),
      sent: [...this.sent],
      pointerClicks: [...this.pointerClicks],
      lineCounts: [...this.lineCounts().entries()],
    };
  }
}
