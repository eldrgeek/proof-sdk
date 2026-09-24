/**
 * Inline local drafts; only explicit submission creates a shared suggestion.
 * Mike, 2026-09-23 (usability brief). Widgets are view decorations, never document content.
 */
import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey, type Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { beginDraft, describeEditProposal, draftAction, draftKey, draftPrefix, parseDraft, resolveDraft, type EditDraft, type EditDoor } from '../shared/edit-session';
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
}
const draftViewKey = new PluginKey<DecorationSet>('accordDrafts');
let active: EditGestureUI | null = null;
export const draftViewPlugin = $prose(() => new Plugin<DecorationSet>({
  key: draftViewKey,
  state: {
    init: () => DecorationSet.empty,
    apply(tr, previous) {
      if (!active) return DecorationSet.empty;
      if (!tr.docChanged && !tr.getMeta(draftViewKey)) return previous;
      active.map(tr);
      return active.decorations(tr.doc);
    },
  },
  props: { decorations: state => draftViewKey.getState(state) },
  view: () => ({ update: () => active?.updateWarnings() }),
}));

export class EditGestureUI {
  private started = false;
  private scope = '';
  private drafts = new Map<string, LocalDraft>();
  readonly posted: Array<{ line: number; door: string; original: string; proposed: string; markId: string }> = [];
  constructor(private readonly host: EditGestureHost) {}
  start(): void {
    if (this.started) return;
    this.started = true; active = this;
    this.load(); this.refresh();
    document.addEventListener('click', this.leaveOutside, true);
  }
  stop(): void {
    this.started = false;
    document.removeEventListener('click', this.leaveOutside, true);
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
  private lineFor(entry: LocalDraft, lines: DocLine[]): DocLine | null {
    if (entry.pos !== null) return lines.find(line => line.pos === entry.pos) ?? null;
    return resolveDraft(entry.draft, lines)?.line ?? null;
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
    for (const entry of this.drafts.values()) {
      const line = this.lineFor(entry, lines);
      if (line) {
        entry.pos = line.pos;
        if (entry.draft.anchor.ordinal !== line.index) {
          entry.draft.anchor.ordinal = line.index; this.save(entry);
        }
      }
      const at = line ? line.pos + line.nodeSize : doc.content.size;
      widgets.push(Decoration.widget(at, () => this.build(entry), {
        key: `${entry.key}:${entry.version}`, side: 1,
        stopEvent: () => true, ignoreSelection: true,
      }));
    }
    return DecorationSet.create(doc, widgets);
  }
  updateWarnings(): void {
    // Identity can finish loading after the editor. Never mix two readers' drafts.
    const expected = this.host.slug() ? draftPrefix(this.host.slug()!, this.host.actor()) : '';
    if (expected !== this.scope) { this.load(); queueMicrotask(() => { if (this.started) this.refresh(); }); return; }
    const view = this.host.view();
    if (!view) return;
    const lines = this.lines(view.state.doc);
    for (const entry of this.drafts.values()) {
      const line = this.lineFor(entry, lines);
      const text = line ? view.state.doc.textBetween(line.pos + 1, line.pos + line.nodeSize - 1, '\n', '\n') : null;
      const warning = entry.element?.querySelector<HTMLElement>('.accord-draft-warning');
      if (warning) warning.textContent = !line ? 'This passage is no longer here. Your draft is still saved.'
        : text !== entry.draft.original ? 'This passage changed while you were drafting. Review its current text before proposing.' : '';
      const submit = entry.element?.querySelector<HTMLButtonElement>('[data-draft-action="propose"]');
      if (submit) submit.disabled = !line || !this.host.canPropose() || entry.draft.original === entry.draft.proposed;
    }
  }
  private button(label: string, action: string, run: () => void): HTMLButtonElement {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    b.dataset.draftAction = action; b.onclick = run;
    b.style.cssText = 'font:inherit;min-height:44px;padding:6px 12px;cursor:pointer';
    return b;
  }
  private build(entry: LocalDraft): HTMLElement {
    const box = document.createElement('div'); box.className = 'accord-draft'; box.contentEditable = 'false';
    box.addEventListener('keydown', event => event.stopPropagation());
    box.setAttribute('role', 'group'); box.setAttribute('aria-label', 'Passage draft');
    box.style.cssText = 'white-space:normal;border:1px solid #8aa9cf;border-radius:6px;padding:12px;margin:8px 0;background:var(--bg,#fff);color:var(--text,#172033);font:14px/1.5 system-ui';
    entry.element = box;
    const title = document.createElement('strong'); title.textContent = 'Draft';
    const warning = document.createElement('p'); warning.className = 'accord-draft-warning'; warning.setAttribute('role', 'status');
    box.append(title, warning);
    if (entry.open) {
      const input = document.createElement('textarea'); input.value = entry.draft.proposed;
      input.setAttribute('aria-label', 'Proposed passage text');
      input.rows = 5; input.style.cssText = 'display:block;box-sizing:border-box;width:100%;font:inherit;resize:vertical;margin:8px 0';
      input.oninput = () => { entry.draft.proposed = input.value; this.save(entry); this.updateWarnings(); };
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
    if (!this.drafts.has(entry.key) || draftAction(entry.draft, door) !== 'publish') return;
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
  debugState() { return { started: this.started, posted: [...this.posted], drafts: [...this.drafts.values()].map(e => ({ key: e.key, ...e.draft, open: e.open })) }; }
}
