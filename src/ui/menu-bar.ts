/**
 * Accord layout stage 2: the menu bar (File · Edit · View · People · Help), its keyboard access
 * (Alt+letter, Ctrl+Option+letter on a Mac, F10, arrows, type-ahead), "Search the menus"
 * (Alt+/), and the same menus folded into the phone's ⋯ menu. The editor supplies the items; this
 * module only draws and drives them. Policies: src/shared/layout-chrome.ts.
 *
 * Authorship: Mike Wolf (rulings), Ren (SOMA UI, the proposal), built by Claude Opus 5 (worker
 * accord-layout2), 2026-09-21.
 */
import { MENU_BAR_POLICY, menuForKey, searchMenus, type MenuId } from '../shared/layout-chrome';
import './chrome.css';

export interface MenuItemSpec {
  id: string;
  label: string;
  /** A shortcut or a short state shown at the right ("⌘Z", "PlayMaker"). */
  detail?: string;
  /** Extra words for Search the menus. */
  keywords?: string;
  run(): void;
  enabled?: boolean;
  /** A checkbox or radio item: its state. */
  checked?: boolean;
  kind?: 'item' | 'checkbox' | 'radio';
  /** Draw a divider above this item. */
  separatorBefore?: boolean;
}

export interface MenuSpec {
  id: MenuId;
  label: string;
  key: string;
  /** Built each time the menu opens, so labels and states are current. */
  items(): MenuItemSpec[];
}

export interface MenuBarHost {
  menus(): MenuSpec[];
  /** Is the person writing (the caret in the text)? Alt+letter types there. */
  writing(): boolean;
  /** Called before a menu opens (close other popovers). */
  beforeOpen?(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isField(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node || typeof node.closest !== 'function') return false;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)) return true;
  return node.isContentEditable && !node.closest('.ProseMirror');
}

/** Builds one menu's item buttons (desktop dropdown and the phone's ⋯ list share this). */
export function buildMenuItems(items: MenuItemSpec[], onRun: (item: MenuItemSpec) => void): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  for (const item of items) {
    if (item.separatorBefore && nodes.length > 0) {
      const sep = el('div', 'amb-sep');
      sep.setAttribute('role', 'separator');
      nodes.push(sep);
    }
    const button = el('button', 'amb-item');
    button.type = 'button';
    button.dataset.item = item.id;
    const role = item.kind === 'checkbox' ? 'menuitemcheckbox' : item.kind === 'radio' ? 'menuitemradio' : 'menuitem';
    button.setAttribute('role', role);
    if (item.kind === 'checkbox' || item.kind === 'radio') button.setAttribute('aria-checked', String(Boolean(item.checked)));
    const check = el('span', 'amb-check', item.kind && item.kind !== 'item' ? (item.checked ? (item.kind === 'radio' ? '●' : '✓') : '') : '');
    check.setAttribute('aria-hidden', 'true');
    const label = el('span', 'amb-label', item.label);
    button.append(check, label);
    if (item.detail) button.append(el('span', 'amb-detail', item.detail));
    if (item.enabled === false) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
    }
    // The press must not move the caret out of the text or end writing before the item acts.
    button.addEventListener('mousedown', event => event.preventDefault());
    button.onclick = () => { if (item.enabled !== false) onRun(item); };
    nodes.push(button);
  }
  return nodes;
}

export class MenuBar {
  /** The bar itself: brand, the five menus, and a slot at the right (people here). */
  readonly el = el('div', 'amb-bar');
  readonly rightSlot = el('div', 'amb-right');
  private readonly buttons = new Map<MenuId, HTMLButtonElement>();
  private openId: MenuId | null = null;
  private menuEl: HTMLElement | null = null;
  private searchEl: HTMLElement | null = null;
  private installed = false;
  /** Test hook: what ran from the menus, newest last. */
  readonly runs: string[] = [];

  constructor(private readonly host: MenuBarHost, brand: HTMLElement) {
    this.el.id = 'accord-menubar';
    this.el.setAttribute('role', 'menubar');
    this.el.setAttribute('aria-label', 'Menu bar');
    brand.classList.add('amb-brand');
    this.el.append(brand);
    for (const menu of MENU_BAR_POLICY.menus) {
      const button = el('button', 'amb-top', menu.label);
      button.type = 'button';
      button.dataset.menu = menu.id;
      button.setAttribute('role', 'menuitem');
      button.setAttribute('aria-haspopup', 'menu');
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-keyshortcuts', `Alt+${menu.key.toUpperCase()}`);
      button.title = `${menu.label} (Alt+${menu.key.toUpperCase()}; Ctrl+Option+${menu.key.toUpperCase()} on a Mac)`;
      button.addEventListener('mousedown', event => event.preventDefault());
      button.onclick = () => { if (this.openId === menu.id) this.close(true); else this.open(menu.id, false); };
      button.onmouseenter = () => { if (this.openId && this.openId !== menu.id) this.open(menu.id, false); };
      button.onkeydown = (event) => this.onTopKey(event, menu.id);
      this.buttons.set(menu.id, button);
      this.el.append(button);
    }
    this.el.append(el('span', 'amb-spacer'), this.rightSlot);
  }

  install(): void {
    if (this.installed) return;
    this.installed = true;
    window.addEventListener('keydown', this.onGlobalKey, true);
    document.addEventListener('pointerdown', this.onOutside, true);
  }

  destroy(): void {
    this.close(false);
    this.closeSearch();
    window.removeEventListener('keydown', this.onGlobalKey, true);
    document.removeEventListener('pointerdown', this.onOutside, true);
    this.installed = false;
    this.el.remove();
  }

  isOpen(): boolean { return this.openId !== null || this.searchEl !== null; }

  private externalAnchor: HTMLButtonElement | null = null;

  private spec(id: MenuId): MenuSpec | undefined {
    return this.host.menus().find(menu => menu.id === id);
  }

  /** Opens a menu under its button. `focusFirst`: keyboard opened it, so the first item takes focus. */
  open(id: MenuId, focusFirst: boolean, anchor?: HTMLButtonElement): void {
    const spec = this.spec(id);
    const button = anchor ?? this.buttons.get(id);
    if (!spec || !button) return;
    this.close(false);
    this.closeSearch();
    this.externalAnchor = anchor ?? null;
    anchor?.setAttribute('aria-expanded', 'true');
    this.host.beforeOpen?.();
    const menu = el('div', 'amb-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', spec.label);
    menu.dataset.menu = id;
    menu.append(...buildMenuItems(spec.items(), item => this.run(item)));
    menu.addEventListener('keydown', this.onMenuKey);
    document.body.append(menu);
    const r = button.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 2)}px`;
    menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)))}px`;
    this.menuEl = menu;
    this.openId = id;
    for (const [menuId, top] of this.buttons) {
      top.setAttribute('aria-expanded', String(menuId === id));
      top.classList.toggle('amb-top-open', menuId === id);
    }
    if (focusFirst) this.focusItem(0);
  }

  close(returnFocus: boolean): void {
    const was = this.openId;
    const anchor = this.externalAnchor;
    anchor?.setAttribute('aria-expanded', 'false');
    this.externalAnchor = null;
    this.menuEl?.remove();
    this.menuEl = null;
    this.openId = null;
    for (const top of this.buttons.values()) {
      top.setAttribute('aria-expanded', 'false');
      top.classList.remove('amb-top-open');
    }
    if (returnFocus && was) (anchor ?? this.buttons.get(was))?.focus({ preventScroll: true });
  }

  private run(item: MenuItemSpec): void {
    this.close(false);
    this.closeSearch();
    this.runs.push(item.id);
    if (this.runs.length > 40) this.runs.shift();
    item.run();
  }

  private items(): HTMLButtonElement[] {
    return Array.from(this.menuEl?.querySelectorAll<HTMLButtonElement>('.amb-item:not([disabled])') ?? []);
  }

  private focusItem(index: number): void {
    const items = this.items();
    if (items.length === 0) return;
    items[(index + items.length) % items.length].focus({ preventScroll: true });
  }

  private step(delta: number): void {
    const items = this.items();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    this.focusItem(at < 0 ? (delta > 0 ? 0 : items.length - 1) : at + delta);
  }

  private sibling(delta: number): void {
    const order = MENU_BAR_POLICY.menus.map(menu => menu.id);
    const at = order.indexOf(this.openId ?? order[0]);
    this.open(order[(at + delta + order.length) % order.length], true);
  }

  private onTopKey(event: KeyboardEvent, id: MenuId): void {
    const order = MENU_BAR_POLICY.menus.map(menu => menu.id);
    const at = order.indexOf(id);
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); event.stopPropagation();
      this.open(id, true);
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault(); event.stopPropagation();
      const next = order[(at + (event.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length];
      if (this.openId) this.open(next, true); else this.buttons.get(next)?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      this.close(false);
      (document.activeElement as HTMLElement | null)?.blur();
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // A letter on the menu bar is not a reading command.
      event.stopPropagation();
    }
  }

  private onMenuKey = (event: KeyboardEvent): void => {
    const key = event.key;
    if (key === 'ArrowDown') { event.preventDefault(); this.step(1); }
    else if (key === 'ArrowUp') { event.preventDefault(); this.step(-1); }
    else if (key === 'Home') { event.preventDefault(); this.focusItem(0); }
    else if (key === 'End') { event.preventDefault(); this.focusItem(-1); }
    else if (key === 'ArrowRight') { event.preventDefault(); this.sibling(1); }
    else if (key === 'ArrowLeft') { event.preventDefault(); this.sibling(-1); }
    else if (key === 'Escape') { event.preventDefault(); this.close(true); }
    else if (key === 'Tab') { this.close(false); return; }
    else if (key === 'Enter' || key === ' ') { return; } // the button's own click
    else if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // Type-ahead: jump to the next item starting with that letter. Never a reading command.
      event.preventDefault();
      this.typeAhead(key);
    } else return;
    event.stopPropagation();
  };

  private typeAhead(key: string): void {
    const items = this.items();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const letter = key.toLowerCase();
    for (let i = 1; i <= items.length; i += 1) {
      const item = items[(at + i + items.length) % items.length];
      if ((item.querySelector('.amb-label')?.textContent ?? '').toLowerCase().startsWith(letter)) { item.focus(); break; }
    }
  }

  private onGlobalKey = (event: KeyboardEvent): void => {
    if (!this.el.isConnected || this.el.getClientRects().length === 0) return;
    // A menu opened by the mouse: Esc still closes it, and letters never reach the reading keys.
    if (this.openId && this.menuEl && !this.menuEl.contains(event.target as Node)) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(false); return; }
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); this.focusItem(event.key === 'ArrowDown' ? 0 : -1); return; }
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && !isField(event.target)) {
        event.preventDefault(); event.stopPropagation(); this.typeAhead(event.key); return;
      }
    }
    if (event.key === 'F10' && MENU_BAR_POLICY.f10FocusesMenuBar && !event.altKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault(); event.stopPropagation();
      if (this.openId) this.close(true);
      else this.buttons.get(MENU_BAR_POLICY.menus[0].id)?.focus();
      return;
    }
    const target = menuForKey({
      code: event.code, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
      writing: this.host.writing(), inField: isField(event.target),
    });
    if (!target) return;
    event.preventDefault(); event.stopPropagation();
    if (target === 'search') this.openSearch();
    else this.open(target, true);
  };

  private onOutside = (event: Event): void => {
    const node = event.target as Node | null;
    if (!node) return;
    if (this.menuEl && !this.menuEl.contains(node) && !this.el.contains(node)) this.close(false);
    if (this.searchEl && !this.searchEl.contains(node)) this.closeSearch();
  };

  // --------------------------------------------------------------------------
  // Search the menus
  // --------------------------------------------------------------------------

  /** Every enabled item, for Search the menus. */
  private entries(): Array<{ menu: string; label: string; keywords?: string; enabled: boolean; item: MenuItemSpec }> {
    const out: Array<{ menu: string; label: string; keywords?: string; enabled: boolean; item: MenuItemSpec }> = [];
    for (const menu of this.host.menus()) {
      for (const item of menu.items()) {
        if (item.id === 'help-search') continue;
        out.push({ menu: menu.label, label: item.label, keywords: item.keywords, enabled: item.enabled !== false, item });
      }
    }
    return out;
  }

  openSearch(): void {
    this.close(false);
    this.closeSearch();
    this.host.beforeOpen?.();
    const box = el('div', 'amb-search');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Search the menus');
    const input = el('input', 'amb-search-input');
    input.type = 'search';
    input.placeholder = 'Search the menus (Alt+/)';
    input.setAttribute('aria-label', 'Search the menus');
    input.setAttribute('aria-autocomplete', 'list');
    const list = el('div', 'amb-search-results');
    list.setAttribute('role', 'listbox');
    list.id = 'amb-search-results';
    input.setAttribute('aria-controls', list.id);
    box.append(input, list);
    let results: ReturnType<MenuBar['entries']> = [];
    let active = 0;
    const render = () => {
      results = searchMenus(this.entries(), input.value, 10);
      active = Math.min(active, Math.max(0, results.length - 1));
      list.replaceChildren();
      results.forEach((entry, index) => {
        const option = el('button', 'amb-search-option');
        option.type = 'button';
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(index === active));
        option.dataset.item = entry.item.id;
        option.disabled = !entry.enabled;
        option.append(el('span', 'amb-label', entry.label), el('span', 'amb-detail', entry.menu));
        option.addEventListener('mousedown', event => event.preventDefault());
        option.onclick = () => { if (entry.enabled) this.run(entry.item); };
        list.append(option);
      });
      if (input.value.trim() && results.length === 0) list.append(el('p', 'amb-search-none', 'No menu item matches.'));
    };
    input.oninput = () => { active = 0; render(); };
    input.onkeydown = (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); active = Math.min(results.length - 1, active + 1); render(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); active = Math.max(0, active - 1); render(); }
      else if (event.key === 'Enter') {
        event.preventDefault();
        const pick = results[active];
        if (pick?.enabled) this.run(pick.item);
      } else if (event.key === 'Escape') { event.preventDefault(); this.closeSearch(); }
      event.stopPropagation();
    };
    document.body.append(box);
    const anchor = this.buttons.get('help')?.getBoundingClientRect();
    if (anchor && this.el.getClientRects().length) {
      box.style.top = `${Math.round(anchor.bottom + 2)}px`;
      box.style.left = `${Math.round(Math.max(8, Math.min(anchor.left, window.innerWidth - 348)))}px`;
    } else box.classList.add('amb-search-centered');
    this.searchEl = box;
    input.focus();
  }

  closeSearch(): void {
    this.searchEl?.remove();
    this.searchEl = null;
  }

  debugState(): Record<string, unknown> {
    return {
      open: this.openId,
      search: Boolean(this.searchEl),
      runs: [...this.runs],
      menus: this.host.menus().map(menu => ({ id: menu.id, items: menu.items().map(item => ({ id: item.id, label: item.label, enabled: item.enabled !== false, checked: item.checked ?? null })) })),
    };
  }
}
