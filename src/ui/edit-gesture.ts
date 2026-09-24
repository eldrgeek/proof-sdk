/**
 * Inline local drafts; only explicit submission creates a shared suggestion.
 * Mike, 2026-09-23 (usability brief). Widgets are view decorations, never document content.
 * A draft re-attaches by exact text, then by the lapsed-mark search. A draft that cannot
 * re-attach is listed from the status bar, with its text, Copy and Discard.
 * Mike, 2026-09-23 (usability brief).
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, type Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { EDIT_SESSION_POLICY, beginDraft, describeEditProposal, draftAction, draftKey, draftPrefix, parseDraft, resolveDraft, type EditDraft, type EditDoor } from '../shared/edit-session';
import { extractLines, type DocLine, type LineSourceNode } from '../shared/line-marks';
import type { UndoStack } from '../shared/undo';

export interface EditGestureHost {
  view(): EditorView | null;
  slug(): string | null;
  actor(): string;
  canPropose(): boolean;
  suggestReplace(view: EditorView, quote: string, by: string, content: string, range: { from: number; to: number }): string | null;
  pending(id: string, content?: string): boolean;
  decide(ids: string[], action: 'reject'): void;
  undoStack(): UndoStack | null;
  proposed(lineIndex: number): void;
  notice(text: string): void;
}
interface LocalDraft {
  key: string;
  draft: EditDraft;
  pos: number | null;
  open: boolean;
  version: number;
  element?: HTMLElement;
  /** Caret in the draft field, kept across a remote redraw of the passage. */
  selection?: [number, number];
  focused?: boolean;
}
const draftViewKey = new PluginKey<DecorationSet>('accordDrafts');
let active: EditGestureUI | null = null;
export const draftViewPlugin = $prose(() => new Plugin<DecorationSet>({
  key: draftViewKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, previous) {
      if (!EDIT_SESSION_POLICY.privateDrafts || !active) return DecorationSet.empty;
      if (!tr.docChanged && !tr.getMeta(draftViewKey)) return previous;
      if (tr.docChanged) active.beginDocSync();
      active.map(tr);
      return active.decorations(tr.doc);
    },
  },
  props: { decorations: state => draftViewKey.getState(state) },
  view: () => ({
    update: () => {
      active?.updateWarnings();
      active?.anchorDraftView();
    },
  }),
}));

export class EditGestureUI {
  private started = false;
  private scope = '';
  private drafts = new Map<string, LocalDraft>();
  private lostButton: HTMLButtonElement | null = null;
  private lostPanel: HTMLElement | null = null;
  private lostObserver: MutationObserver | null = null;
  private paintingLost = false;
  private draftScreenTop: number | null = null;
  private anchorObserver: ResizeObserver | null = null;
  private anchoring = false;
  private userScroll = false;
  private readonly onWindowScroll = (): void => {
    if (this.anchoring || this.userScroll || this.draftScreenTop === null) return;
    this.anchorDraftView();
  };
  private readonly markUserScroll = (event: Event): void => {
    if (event instanceof KeyboardEvent) {
      const scrolls = event.key === 'PageDown' || event.key === 'PageUp' || event.key === 'Home' || event.key === 'End' || event.key === ' ';
      const target = event.target as HTMLElement | null;
      if (!scrolls || target?.closest?.('textarea, input, .accord-draft')) return;
    }
    this.userScroll = true;
    window.setTimeout(() => { this.userScroll = false; }, 250);
  };
  /** True while a document transaction is being drawn, so it cannot rewrite the draft. */
  private syncing = false;
  readonly posted: Array<{ line: number; door: string; original: string; proposed: string; markId: string }> = [];
  constructor(private readonly host: EditGestureHost) {}
  start(): void {
    if (!EDIT_SESSION_POLICY.privateDrafts || this.started) return;
    this.started = true; active = this;
    this.load(); this.refresh();
    this.watchDraftAnchor();
    window.addEventListener('scroll', this.onWindowScroll, true);
    window.addEventListener('wheel', this.markUserScroll, { passive: true });
    window.addEventListener('touchmove', this.markUserScroll, { passive: true });
    window.addEventListener('keydown', this.markUserScroll);
    document.addEventListener('click', this.leaveOutside, true);
  }
  stop(): void {
    this.started = false;
    document.removeEventListener('click', this.leaveOutside, true);
    window.removeEventListener('scroll', this.onWindowScroll, true);
    window.removeEventListener('wheel', this.markUserScroll);
    window.removeEventListener('touchmove', this.markUserScroll);
    window.removeEventListener('keydown', this.markUserScroll);
    this.lostObserver?.disconnect();
    this.lostObserver = null;
    this.anchorObserver?.disconnect();
    this.anchorObserver = null;
    this.lostButton?.remove();
    this.lostPanel?.remove();
    this.lostButton = null;
    this.lostPanel = null;
    if (active === this) active = null;
    this.refresh();
  }
  private lines(doc: ProseNode): DocLine[] { return extractLines(doc as unknown as LineSourceNode); }
  private load(): void {
    const slug = this.host.slug();
    const scope = slug ? draftPrefix(slug, this.host.actor()) : '';
    if (scope === this.scope) return;
    this.scope = scope; this.drafts.clear();
    if (!scope) return;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        if (!key.startsWith(scope)) continue;
        const draft = parseDraft(localStorage.getItem(key));
        if (draft) this.drafts.set(key, { key, draft, open: false, pos: null, version: 0 });
      }
    } catch { this.host.notice('Draft storage is unavailable. Keep this page open to keep your draft.'); }
  }
  private save(entry: LocalDraft): void {
    try { localStorage.setItem(entry.key, JSON.stringify(entry.draft)); }
    catch { this.host.notice('Your draft is kept on this page, but could not be saved for reload.'); }
  }
  private refresh(): void {
    const view = this.host.view();
    if (view && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(draftViewKey, true).setMeta('addToHistory', false));
  }
  open(lineIndex: number): boolean {
    if (!EDIT_SESSION_POLICY.privateDrafts) return false;
    this.load();
    const view = this.host.view();
    const slug = this.host.slug();
    if (!view || !slug || !this.host.canPropose()) return false;
    const lines = this.lines(view.state.doc);
    const line = lines[lineIndex];
    if (!line || !view.state.doc.nodeAt(line.pos)?.isTextblock) {
      this.host.notice('Select a paragraph, heading or list passage to suggest a change.'); return false;
    }
    let entry = [...this.drafts.values()].find(d => this.lineFor(d, lines)?.pos === line.pos);
    if (!entry) {
      const draft = beginDraft(line, view.state.doc.textBetween(line.pos + 1, line.pos + line.nodeSize - 1, '\n', '\n'));
      const key = draftKey(slug, this.host.actor(), draft.anchor);
      entry = { key, draft, open: false, pos: line.pos, version: 0 };
      this.drafts.set(key, entry); this.save(entry);
    }
    for (const other of this.drafts.values()) {
      if (other.open) { other.open = false; other.version++; }
    }
    entry.open = true; entry.version++;
    this.refresh();
    const field = entry.element?.querySelector('textarea');
    field?.focus({ preventScroll: true });
    return true;
  }
  /** Identity is the passage text, never a cached position. A stale position can be an unrelated line. */
  private lineFor(entry: LocalDraft, lines: DocLine[], taken?: ReadonlySet<number>): DocLine | null {
    return resolveDraft(entry.draft, lines, taken)?.line ?? null;
  }
  /** Drafts whose passage is no longer in the document, even as an edit of the old text. */
  lostDrafts(): Array<{ original: string; proposed: string }> {
    const view = this.host.view();
    const lines = view && !view.isDestroyed ? this.lines(view.state.doc) : [];
    const taken = new Set<number>();
    const lost: Array<{ original: string; proposed: string }> = [];
    for (const entry of this.drafts.values()) {
      const resolved = resolveDraft(entry.draft, lines, taken);
      if (resolved) taken.add(resolved.line.index);
      else lost.push({ original: entry.draft.original, proposed: entry.draft.proposed });
    }
    return lost;
  }
  map(tr: Transaction): void {
    if (!tr.docChanged) return;
    for (const entry of this.drafts.values()) {
      if (entry.pos === null) continue;
      const mapped = tr.mapping.mapResult(entry.pos, 1);
      entry.pos = mapped.deletedAcross ? -1 : mapped.pos;
    }
  }
  decorations(doc: ProseNode): DecorationSet {
    const lines = this.lines(doc);
    const widgets: Decoration[] = [];
    const taken = new Set<number>();
    for (const entry of this.drafts.values()) {
      const resolved = resolveDraft(entry.draft, lines, taken);
      if (!resolved) { entry.pos = null; continue; }
      taken.add(resolved.line.index);
      const line = resolved.line;
      entry.pos = line.pos;
      if (entry.draft.anchor.ordinal !== line.index) {
        entry.draft.anchor.ordinal = line.index; this.save(entry);
      }
      const at = line.pos + line.nodeSize;
      widgets.push(Decoration.widget(at, () => this.widgetNode(entry, doc, lines), {
        key: `${entry.key}:${entry.version}`, side: 1,
        stopEvent: () => true, ignoreSelection: true,
      }));
    }
    queueMicrotask(() => this.paintLost());
    return DecorationSet.create(doc, widgets);
  }
  updateWarnings(): void {
    // Identity can finish loading after the editor. Never mix two readers' drafts.
    const expected = this.host.slug() ? draftPrefix(this.host.slug()!, this.host.actor()) : '';
    if (expected !== this.scope) { this.load(); queueMicrotask(() => { if (this.started) this.refresh(); }); return; }
    const view = this.host.view();
    if (!view) return;
    const lines = this.lines(view.state.doc);
    const taken = new Set<number>();
    for (const entry of this.drafts.values()) {
      const resolved = resolveDraft(entry.draft, lines, taken);
      if (resolved) taken.add(resolved.line.index);
      const line = resolved?.line ?? null;
      const text = line ? view.state.doc.textBetween(line.pos + 1, line.pos + line.nodeSize - 1, '\n', '\n') : null;
      const warning = entry.element?.querySelector<HTMLElement>('.accord-draft-warning');
      if (warning) warning.textContent = this.warningText(line, text, entry);
      const submit = entry.element?.querySelector<HTMLButtonElement>('[data-draft-action="propose"]');
      if (submit) submit.disabled = !line || !this.host.canPropose() || entry.draft.original === entry.draft.proposed;
    }
    this.paintLost();
  }
  /** A document redraw must not change the draft's text, caret or place on screen. */
  beginDocSync(): void {
    if (this.syncing) return;
    this.syncing = true;
    for (const entry of this.drafts.values()) this.rememberField(entry);
    queueMicrotask(() => {
      this.syncing = false;
      this.protectDraftText();
      this.restoreOpenFields();
      this.anchorDraftView();
    });
  }
  private rememberField(entry: LocalDraft): void {
    const field = entry.element?.querySelector('textarea');
    if (!field) return;
    entry.selection = [field.selectionStart ?? 0, field.selectionEnd ?? 0];
    if (document.activeElement === field) entry.focused = true;
  }
  private protectDraftText(): void {
    for (const entry of this.drafts.values()) {
      const field = entry.element?.querySelector('textarea');
      if (!field || field.value === entry.draft.proposed) continue;
      field.value = entry.draft.proposed;
      const sel = entry.selection;
      if (sel) field.setSelectionRange(sel[0], sel[1]);
    }
  }
  private restoreOpenFields(): void {
    for (const entry of this.drafts.values()) {
      if (!entry.open || !entry.focused) continue;
      const field = entry.element?.querySelector('textarea');
      if (!field) continue;
      if (document.activeElement !== field) field.focus({ preventScroll: true });
      const sel = entry.selection;
      if (sel && (field.selectionStart !== sel[0] || field.selectionEnd !== sel[1])) field.setSelectionRange(sel[0], sel[1]);
    }
  }
  private watchDraftAnchor(): void {
    if (this.anchorObserver || typeof ResizeObserver === 'undefined' || !this.domReady()) return;
    const root = document.querySelector('.ProseMirror');
    if (!root) return;
    this.anchorObserver = new ResizeObserver(() => this.anchorDraftView());
    this.anchorObserver.observe(root);
  }
  /** Keep the open draft where it was on screen when someone else edits the passage. */
  anchorDraftView(): void {
    if (this.draftScreenTop === null) return;
    const field = this.openDraftField();
    if (!field || !field.isConnected) return;
    const rect = field.getBoundingClientRect();
    if (rect.height <= 0) return;
    const delta = rect.top - this.draftScreenTop;
    if (Math.abs(delta) > 1) {
      this.anchoring = true;
      window.scrollBy(0, delta);
      this.anchoring = false;
    }
    const corrected = field.getBoundingClientRect().top;
    if (Math.abs(corrected - this.draftScreenTop) <= 2) this.draftScreenTop = corrected;
  }
  private openDraftField(): HTMLTextAreaElement | null {
    for (const entry of this.drafts.values()) {
      if (!entry.open) continue;
      const field = entry.element?.querySelector('textarea');
      if (field) return field;
    }
    return null;
  }
  private warningText(line: DocLine | null, text: string | null, entry: LocalDraft): string {
    if (!line) return '';
    return text !== entry.draft.original
      ? 'This passage changed while you were drafting. Review its current text before proposing.'
      : '';
  }
  private button(label: string, action: string, run: () => void): HTMLButtonElement {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    b.dataset.draftAction = action; b.onclick = run;
    b.style.cssText = 'font:inherit;min-height:44px;padding:6px 12px;cursor:pointer';
    return b;
  }
  /** Reuse the field so a remote redraw cannot drop the caret or mix in the passage's new text. */
  private widgetNode(entry: LocalDraft, doc: ProseNode, lines: DocLine[]): HTMLElement {
    const showsField = Boolean(entry.element?.querySelector('textarea'));
    if (entry.element && showsField === entry.open) return entry.element;
    return this.build(entry, doc, lines);
  }
  private build(entry: LocalDraft, doc?: ProseNode, lines?: DocLine[]): HTMLElement {
    const box = document.createElement('div'); box.className = 'accord-draft'; box.contentEditable = 'false';
    box.addEventListener('keydown', event => event.stopPropagation());
    box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Passage draft');
    // scroll-margin keeps Propose and Cancel above the phone strip when the browser scrolls them into view.
    box.style.cssText = 'white-space:normal;border:1px solid #8aa9cf;border-radius:6px;padding:12px;margin:8px 0;scroll-margin-bottom:160px;background:var(--bg,#fff);color:var(--text,#172033);font:14px/1.5 system-ui';
    entry.element = box;
    const title = document.createElement('strong'); title.textContent = 'Draft';
    const warning = document.createElement('p'); warning.className = 'accord-draft-warning'; warning.setAttribute('role', 'status');
    if (doc && lines) {
      const line = this.lineFor(entry, lines);
      const text = line ? doc.textBetween(line.pos + 1, line.pos + line.nodeSize - 1, '\n', '\n') : null;
      warning.textContent = this.warningText(line, text, entry);
    }
    box.append(title, warning);
    if (entry.open) {
      const input = document.createElement('textarea'); input.value = entry.draft.proposed;
      input.setAttribute('aria-label', 'Proposed passage text');
      input.rows = 5; input.style.cssText = 'display:block;box-sizing:border-box;width:100%;font:inherit;resize:vertical;margin:8px 0';
      input.oninput = () => {
        if (this.syncing) {
          input.value = entry.draft.proposed;
          if (entry.selection) input.setSelectionRange(entry.selection[0], entry.selection[1]);
          return;
        }
        entry.draft.proposed = input.value;
        entry.selection = [input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length];
        entry.focused = true;
        this.save(entry);
        this.updateWarnings();
      };
      input.addEventListener('focus', () => {
        entry.focused = true;
        this.draftScreenTop = input.getBoundingClientRect().top;
        this.watchDraftAnchor();
      });
      input.addEventListener('blur', () => {
        this.rememberField(entry);
        // A remote redraw blurs the field without the reader leaving the draft.
        if (!this.syncing) entry.focused = false;
      });
      input.onkeydown = event => {
        if (event.isComposing) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.keep(entry); }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey) {
          event.preventDefault(); event.stopPropagation(); this.submit(entry, 'cmd-enter');
        }
      };
      box.append(input, this.button('Propose change', 'propose', () => this.submit(entry, 'propose')),
        this.button('Cancel', 'cancel', () => this.discard(entry)));
    } else {
      box.append(this.button('Resume', 'resume', () => {
        entry.open = true; entry.version++; this.refresh();
        entry.element?.querySelector('textarea')?.focus({ preventScroll: true });
      }), this.button('Discard', 'discard', () => this.discard(entry)));
    }
    queueMicrotask(() => this.updateWarnings());
    return box;
  }
  private keep(entry: LocalDraft): void {
    const heldFocus = entry.element?.contains(document.activeElement);
    this.save(entry); entry.open = false; entry.version++; this.refresh();
    if (heldFocus) entry.element?.querySelector<HTMLButtonElement>('[data-draft-action="resume"]')?.focus({ preventScroll: true });
  }
  private discard(entry: LocalDraft): void {
    try { localStorage.removeItem(entry.key); }
    catch { this.host.notice('The saved draft could not be removed. It may return on reload.'); }
    this.drafts.delete(entry.key); this.refresh();
  }
  private leaveOutside = (event: MouseEvent): void => {
    const target = event.target as Node;
    for (const entry of this.drafts.values()) {
      if (entry.open && !entry.element?.contains(target)) this.keep(entry);
    }
  };
  private submit(entry: LocalDraft, door: EditDoor): void {
    if (!EDIT_SESSION_POLICY.privateDrafts || !this.drafts.has(entry.key) || draftAction(entry.draft, door) !== 'publish') return;
    const view = this.host.view();
    if (!view || !this.host.canPropose()) { this.host.notice('You cannot propose a change with the current document permissions. Your draft is saved.'); return; }
    const line = this.lineFor(entry, this.lines(view.state.doc));
    if (!line || !view.state.doc.nodeAt(line.pos)?.isTextblock) { this.updateWarnings(); return; }
    const range = { from: line.pos + 1, to: line.pos + line.nodeSize - 1 };
    const original = view.state.doc.textBetween(range.from, range.to, '\n', '\n');
    try {
      // suggestReplace adds one mark and its metadata in one transaction. It never rewrites text.
      const id = this.host.suggestReplace(view, original, this.host.actor(), entry.draft.proposed, range);
      if (!id || !this.host.pending(id)) { this.host.notice('The proposal could not be posted. Your draft is saved.'); return; }
      this.posted.push({ line: line.index, door, original, proposed: entry.draft.proposed, markId: id });
      const description = describeEditProposal(line.index);
      const proposed = entry.draft.proposed;
      this.host.undoStack()?.pushSimple('suggestion', description, () => {
        if (!this.host.canPropose()) return { ok: false, reason: 'Connect with editing permission to undo this proposal.' };
        if (!this.host.pending(id, proposed)) return { ok: false, reason: 'This proposal has changed or has already been decided. Nothing was changed.' };
        try { this.host.decide([id], 'reject'); return { ok: true, description }; }
        catch (error) { return { ok: false, reason: error instanceof Error ? error.message : 'Could not undo this proposal.' }; }
      });
      this.discard(entry); this.host.proposed(line.index);
    } catch (error) { this.host.notice(`Your draft is saved. ${error instanceof Error ? error.message : 'The proposal could not be posted.'}`); }
  }
  debugState() {
    const lost = new Set(this.lostDrafts().map(d => `${d.original}\0${d.proposed}`));
    return {
      started: this.started, posted: [...this.posted],
      drafts: [...this.drafts.values()].map(e => ({ key: e.key, ...e.draft, open: e.open, lost: lost.has(`${e.draft.original}\0${e.draft.proposed}`) })),
    };
  }
  private domReady(): boolean {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function' || typeof document.createElement !== 'function') return false;
    const probe = document.createElement('span');
    return typeof probe.append === 'function' && typeof document.body?.append === 'function';
  }
  /** A status-bar control, or the phone strip when that bar is folded away. */
  private paintLost(): void {
    if (this.paintingLost || !this.domReady()) return;
    this.paintingLost = true;
    try {
      const lost = this.lostEntries();
      if (lost.length === 0) {
        this.lostButton?.remove();
        this.lostPanel?.remove();
        this.lostButton = null;
        this.lostPanel = null;
        return;
      }
      this.watchLost();
      if (!this.lostButton) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'accord-lost-drafts-open';
        btn.dataset.accordLostDrafts = 'open';
        btn.style.cssText = 'font:inherit;min-height:22px;max-width:100%;padding:0 8px;cursor:pointer;flex-shrink:1;overflow:hidden;text-overflow:ellipsis';
        btn.onclick = () => this.toggleLostPanel();
        this.lostButton = btn;
      }
      const label = 'Drafts that lost their passage';
      this.lostButton.textContent = lost.length === 1 ? label : `${label} (${lost.length})`;
      this.lostButton.setAttribute('aria-haspopup', 'dialog');
      this.lostButton.setAttribute('aria-label', this.lostButton.textContent);
      this.placeLostButton(this.lostButton);
      if (this.lostPanel && !this.lostPanel.hidden) this.fillLostPanel(lost);
    } finally { this.paintingLost = false; }
  }
  private lostEntries(): LocalDraft[] {
    const view = this.host.view();
    const lines = view && !view.isDestroyed ? this.lines(view.state.doc) : [];
    const taken = new Set<number>();
    const lost: LocalDraft[] = [];
    for (const entry of this.drafts.values()) {
      const resolved = resolveDraft(entry.draft, lines, taken);
      if (resolved) taken.add(resolved.line.index);
      else lost.push(entry);
    }
    return lost;
  }
  private placeLostButton(btn: HTMLButtonElement): void {
    const bar = document.querySelector('.pst-bar');
    const barShown = bar instanceof HTMLElement && bar.getClientRects().length > 0;
    if (barShown) {
      btn.style.position = '';
      btn.style.bottom = '';
      btn.style.zIndex = '';
      if (btn.parentElement !== bar) bar.append(btn);
      return;
    }
    const strip = document.querySelector('.prw-strip');
    const stripShown = strip instanceof HTMLElement && !strip.hasAttribute('hidden') && strip.getClientRects().length > 0;
    if (stripShown) {
      btn.style.position = '';
      btn.style.bottom = '';
      btn.style.zIndex = '';
      if (btn.parentElement !== strip) strip.append(btn);
      return;
    }
    btn.style.position = 'fixed';
    btn.style.bottom = '8px';
    btn.style.right = '8px';
    btn.style.zIndex = '80';
    if (btn.parentElement !== document.body) document.body.append(btn);
  }
  private watchLost(): void {
    if (this.lostObserver || typeof MutationObserver === 'undefined') return;
    this.lostObserver = new MutationObserver(() => {
      if (this.paintingLost || this.lostEntries().length === 0) return;
      if (!this.lostButton?.isConnected) this.paintLost();
    });
    this.lostObserver.observe(document.body, { childList: true, subtree: true });
  }
  private toggleLostPanel(): void {
    const lost = this.lostEntries();
    if (lost.length === 0) { this.paintLost(); return; }
    if (this.lostPanel && !this.lostPanel.hidden) { this.lostPanel.hidden = true; return; }
    this.fillLostPanel(lost);
    if (this.lostPanel) this.lostPanel.hidden = false;
  }
  private fillLostPanel(lost: LocalDraft[]): void {
    if (!this.lostPanel) {
      const panel = document.createElement('div');
      panel.className = 'accord-lost-drafts';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Drafts that lost their passage');
      panel.style.cssText = 'position:fixed;z-index:80;left:12px;right:12px;bottom:48px;max-height:50vh;overflow:auto;background:#fff;color:#172033;border:1px solid #8aa9cf;border-radius:8px;padding:12px;box-shadow:0 8px 28px rgba(0,0,0,.16);font:14px/1.5 system-ui';
      document.body.append(panel);
      this.lostPanel = panel;
    }
    const title = document.createElement('strong');
    title.textContent = 'Drafts that lost their passage';
    const items = lost.map(entry => {
      const article = document.createElement('article');
      article.className = 'accord-lost-draft';
      article.style.marginTop = '8px';
      const text = document.createElement('p');
      text.className = 'accord-lost-draft-text';
      text.style.cssText = 'white-space:pre-wrap;margin:4px 0';
      text.textContent = entry.draft.proposed;
      const copy = this.button('Copy', 'copy', () => { void this.copyDraft(entry, copy); });
      copy.dataset.lostAction = 'copy';
      const discard = this.button('Discard', 'discard', () => this.discard(entry));
      discard.dataset.lostAction = 'discard';
      article.append(text, copy, discard);
      return article;
    });
    this.lostPanel.replaceChildren(title, ...items);
  }
  private async copyDraft(entry: LocalDraft, button: HTMLButtonElement): Promise<void> {
    const text = entry.draft.proposed;
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch { /* the page may deny the clipboard; select the text below */ }
    if (!copied) {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('aria-hidden', 'true');
      document.body.append(area);
      area.select();
      try { copied = document.execCommand('copy'); } catch { copied = false; }
      area.remove();
    }
    button.textContent = copied ? 'Copied' : 'Copy';
    if (!copied) this.host.notice('Select the draft text to copy it.');
  }
}
