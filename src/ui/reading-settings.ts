/**
 * Accord layout stage 2, decision 10: the reader's settings leave the main view. View › Reading
 * settings opens this panel: reading speed (how long a line must stay the focus line to count as
 * read) and This sitting (how many Issues Next issue walks before it stops). It is a panel, not a
 * modal: the page stays usable behind it, and Esc or Close puts it away.
 *
 * Authorship: Mike Wolf (rulings), Ren (SOMA UI, the proposal), built by Claude Opus 5 (worker
 * accord-layout2), 2026-09-21.
 */
import './chrome.css';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class ReadingSettingsUI {
  readonly el = el('section', 'ars-panel');
  private readonly body = el('div', 'ars-body');
  private opener: HTMLElement | null = null;

  constructor() {
    this.el.id = 'reading-settings';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-labelledby', 'reading-settings-title');
    this.el.hidden = true;
    const head = el('header', 'ars-head');
    const title = el('h2', 'ars-title', 'Reading settings');
    title.id = 'reading-settings-title';
    const close = el('button', 'ars-close', 'Close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close reading settings');
    close.onclick = () => this.close();
    head.append(title, close);
    this.el.append(head, this.body, el('p', 'ars-note', 'These are yours, in this browser. Nobody else sees them.'));
    this.el.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); }
    });
  }

  /** The settings rows, in order (the reading walk's speed, the line marks' sitting budget). */
  mount(...nodes: HTMLElement[]): void {
    for (const node of nodes) if (node.parentElement !== this.body) this.body.append(node);
    if (!this.el.isConnected) document.body.append(this.el);
  }

  isOpen(): boolean { return !this.el.hidden; }

  open(focus = true): void {
    if (!this.el.isConnected) document.body.append(this.el);
    if (this.el.hidden) this.opener = document.activeElement as HTMLElement | null;
    this.el.hidden = false;
    if (focus) (this.body.querySelector('select, button, input') as HTMLElement | null)?.focus({ preventScroll: true });
  }

  close(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    const back = this.opener;
    this.opener = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }

  remove(): void { this.el.remove(); }
}
