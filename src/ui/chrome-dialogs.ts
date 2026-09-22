/**
 * Accord layout stage 2: the small dialogs the menus open — File › Open (the documents list),
 * People › Who is here, Help › Keyboard shortcuts, Help › What the marks mean, Help › About — and
 * Edit › Find (a find bar that moves the focus line; it never selects text, so it never starts
 * writing).
 *
 * Authorship: Mike Wolf (rulings), Ren (SOMA UI, the proposal), built by Claude Opus 5 (worker
 * accord-layout2), 2026-09-21.
 */
import { KEYBOARD_SHORTCUTS, MARKS_LEGEND } from '../shared/layout-chrome';
import './chrome.css';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A plain modal with a title, a Close button and a body. Returns the body (fill it) and the dialog. */
export function showChromeDialog(id: string, title: string): { dialog: HTMLDialogElement; body: HTMLElement } {
  document.getElementById(id)?.remove();
  const opener = document.activeElement as HTMLElement | null;
  const dialog = el('dialog', 'acd-dialog');
  dialog.id = id;
  dialog.setAttribute('aria-labelledby', `${id}-title`);
  const head = el('header', 'acd-head');
  const heading = el('h2', 'acd-title', title);
  heading.id = `${id}-title`;
  const close = el('button', 'acd-close', 'Close');
  close.type = 'button';
  close.setAttribute('aria-label', `Close ${title.toLowerCase()}`);
  close.onclick = () => dialog.close();
  head.append(heading, close);
  const body = el('div', 'acd-body');
  dialog.append(head, body);
  dialog.addEventListener('close', () => { dialog.remove(); opener?.focus?.({ preventScroll: true }); }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
  return { dialog, body };
}

export interface DocumentsListing {
  docs: Array<{ slug: string; title: string; current: boolean; count: number }> | null;
  message: string;
}

/** File › Open: the documents list (the same list as the left rail). */
export function showOpenDialog(listing: DocumentsListing, title: string, nounPlural: string): void {
  const { body } = showChromeDialog('open-dialog', title);
  if (!listing.docs) {
    const p = el('p', 'acd-note', listing.message || `The ${nounPlural.toLowerCase()} list is not available.`);
    if (listing.message.startsWith('Sign in')) {
      const a = el('a', undefined, 'Sign in');
      a.href = '/';
      p.append(' ', a);
    }
    body.append(p);
    return;
  }
  if (listing.docs.length === 0) body.append(el('p', 'acd-note', listing.message || `No ${nounPlural.toLowerCase()} yet.`));
  const list = el('ul', 'acd-docs');
  for (const doc of listing.docs) {
    const li = el('li');
    const a = el('a', 'acd-doc');
    a.href = `/d/${encodeURIComponent(doc.slug)}`;
    a.dataset.slug = doc.slug;
    if (doc.current) a.setAttribute('aria-current', 'page');
    a.append(el('span', 'acd-doc-title', doc.title));
    if (doc.current) a.append(el('span', 'acd-doc-here', 'open now'));
    if (doc.count > 0) {
      const badge = el('span', 'acd-doc-count', String(doc.count));
      badge.title = doc.current ? `${doc.count} need you` : `${doc.count} open suggestions and comments`;
      a.append(badge);
    }
    li.append(a);
    list.append(li);
  }
  body.append(list);
  const all = el('a', 'acd-all', `All ${nounPlural.toLowerCase()}`);
  all.href = '/';
  body.append(all);
}

export interface WhoIsHere {
  people: Array<{ name: string; state: string; color: string; initial: string }>;
  ais: Array<{ name: string; state: string }>;
  viewerIssues: number;
  teamIssues: number;
  team: string[];
}

/** People › Who is here: who has the document open, and the team's open Issues. */
export function showWhoDialog(who: WhoIsHere): void {
  const { body } = showChromeDialog('who-dialog', 'Who is here');
  const counts = el('p', 'acd-counts');
  counts.dataset.viewer = String(who.viewerIssues);
  counts.dataset.team = String(who.teamIssues);
  counts.textContent = `${who.viewerIssues} ${who.viewerIssues === 1 ? 'Issue needs' : 'Issues need'} you. The team has ${who.teamIssues} open ${who.teamIssues === 1 ? 'Issue' : 'Issues'}.`;
  body.append(counts);
  body.append(el('h3', undefined, 'People here now'));
  if (who.people.length === 0) body.append(el('p', 'acd-note', 'Only you.'));
  const list = el('ul', 'acd-who');
  for (const person of who.people) {
    const li = el('li');
    const face = el('span', 'acd-face', person.initial);
    face.style.background = person.color;
    li.append(face, el('span', undefined, `${person.name} — ${person.state}`));
    list.append(li);
  }
  if (who.people.length) body.append(list);
  body.append(el('h3', undefined, 'AIs here now'));
  if (who.ais.length === 0) body.append(el('p', 'acd-note', 'No AI is connected. Share › AIs adds one.'));
  else {
    const ais = el('ul', 'acd-who');
    for (const ai of who.ais) ais.append(el('li', undefined, `${ai.name} — ${ai.state}`));
    body.append(ais);
  }
  if (who.team.length) {
    body.append(el('h3', undefined, 'The team'));
    body.append(el('p', 'acd-note', who.team.join(', ')));
  }
}

/** Help › Keyboard shortcuts. */
export function showKeysDialog(): void {
  const { body } = showChromeDialog('keys-dialog', 'Keyboard shortcuts');
  let group = '';
  let table: HTMLTableElement | null = null;
  for (const row of KEYBOARD_SHORTCUTS) {
    if (row.group !== group) {
      group = row.group;
      body.append(el('h3', undefined, group));
      table = el('table', 'acd-keys');
      body.append(table);
    }
    const tr = el('tr');
    const keys = el('td');
    keys.append(el('kbd', undefined, row.keys));
    tr.append(keys, el('td', undefined, row.does));
    table!.append(tr);
  }
}

/** Help › What the marks mean. */
export function showMarksLegend(): void {
  const { body } = showChromeDialog('marks-legend', 'What the marks mean');
  const list = el('dl', 'acd-legend');
  for (const row of MARKS_LEGEND) {
    const dt = el('dt');
    const swatch = el('span', `acd-swatch acd-swatch-${row.swatch}`);
    swatch.setAttribute('aria-hidden', 'true');
    if (row.swatch === 'settled') swatch.textContent = '✓';
    if (row.swatch === 'change') swatch.textContent = 'ab';
    dt.append(swatch, el('span', undefined, row.label));
    list.append(dt, el('dd', undefined, row.means));
  }
  body.append(list, el('p', 'acd-note', 'Nothing counts until a person marks it. Scrolling reads; it never agrees for you.'));
}

/** Help › About. */
export function showAboutDialog(name: string, tagline: string, engine: string): void {
  const { body } = showChromeDialog('about-dialog', `About ${name}`);
  body.append(el('p', undefined, tagline), el('p', 'acd-note', `Built on the open-source ${engine}.`));
}

export interface FindHost {
  lines(): string[];
  focusLine(index: number): boolean;
  /** The line to search from (the focus line). */
  from(): number;
}

/** Edit › Find: finds text in the document's lines and moves the focus line to each match. */
export class FindBar {
  readonly el = el('div', 'afd-bar');
  private readonly input = el('input', 'afd-input');
  private readonly count = el('span', 'afd-count');
  private matches: number[] = [];
  private at = -1;

  constructor(private readonly host: FindHost) {
    this.el.id = 'find-bar';
    this.el.setAttribute('role', 'search');
    this.el.hidden = true;
    this.input.type = 'search';
    this.input.placeholder = 'Find in this document';
    this.input.setAttribute('aria-label', 'Find in this document');
    this.count.setAttribute('role', 'status');
    this.count.setAttribute('aria-live', 'polite');
    const prev = el('button', 'afd-btn', '↑');
    prev.type = 'button';
    prev.setAttribute('aria-label', 'Previous match');
    prev.onclick = () => this.step(-1);
    const next = el('button', 'afd-btn', '↓');
    next.type = 'button';
    next.setAttribute('aria-label', 'Next match');
    next.onclick = () => this.step(1);
    const close = el('button', 'afd-btn', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close find');
    close.onclick = () => this.close();
    this.el.append(this.input, this.count, prev, next, close);
    this.input.oninput = () => this.search();
    this.input.onkeydown = (event) => {
      if (event.key === 'Enter') { event.preventDefault(); this.step(event.shiftKey ? -1 : 1); }
      else if (event.key === 'Escape') { event.preventDefault(); this.close(); }
      event.stopPropagation();
    };
  }

  open(): void {
    if (!this.el.isConnected) document.body.append(this.el);
    this.el.hidden = false;
    this.input.focus();
    this.input.select();
    this.search();
  }

  close(): void {
    this.el.hidden = true;
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  remove(): void { this.el.remove(); }

  private search(): void {
    const query = this.input.value.trim().toLowerCase();
    this.matches = [];
    if (query) this.host.lines().forEach((text, index) => { if (text.toLowerCase().includes(query)) this.matches.push(index); });
    this.at = -1;
    this.count.textContent = query ? (this.matches.length ? `${this.matches.length} found` : 'Not found') : '';
    this.el.dataset.matches = String(this.matches.length);
  }

  private step(delta: number): void {
    if (this.matches.length === 0) return;
    if (this.at < 0) {
      const from = this.host.from();
      const ahead = delta > 0 ? this.matches.findIndex(m => m > from) : [...this.matches].reverse().findIndex(m => m < from);
      this.at = ahead < 0 ? (delta > 0 ? 0 : this.matches.length - 1) : (delta > 0 ? ahead : this.matches.length - 1 - ahead);
    } else this.at = (this.at + delta + this.matches.length) % this.matches.length;
    const line = this.matches[this.at];
    this.host.focusLine(line);
    this.count.textContent = `${this.at + 1} of ${this.matches.length}`;
    this.el.dataset.line = String(line);
  }
}
