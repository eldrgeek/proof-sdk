/**
 * Links in the text (Mike, 2026-09-21: "Clicking a link should take you to the link, not through
 * the Open Link device.").
 *
 * A plain click on a link opens it: a link to another page opens in a new tab (the reading place
 * here is kept); a link to a heading in this document (`#section`) moves the focus line there.
 * The "Open link" card that used to appear on hover, and the Cmd/Ctrl+click rule behind it, are
 * gone. The press on a link does not put a caret in the text (so it never starts writing).
 *
 * Editing a link's words: Alt/Option+click on the link places the caret in it (nothing opens), or
 * click the text beside the link and move in with the arrow keys. Policy: LINK_CLICK_POLICY.
 * Authorship: Claude Opus 5 (worker proof-bugs6), 2026-09-21, replacing the hover card.
 */
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { captureEvent } from '../../analytics/telemetry';

const markdownLinkClickKey = new PluginKey('markdown-link-click');

export const LINK_CLICK_POLICY = {
  /** A plain primary click (or tap) on a link opens it, in editing and reading alike. */
  plainClickOpens: true,
  /** Alt/Option+click places the caret in the link's words instead (to edit them). */
  altClickEdits: true,
  /** Where a link to another page opens. */
  externalTarget: '_blank' as const,
  /** A `#fragment` link to a heading in this document moves the focus line there. */
  fragmentInPage: true,
  /** Links inside suggested deletions are not followed (that text is on its way out). */
  skipDeletedText: true,
} as const;

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const HAS_SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const FALLBACK_BASE_URL = 'https://proofeditor.ai/';

type ClosestCapable = {
  closest: (selector: string) => unknown;
};

type ParentElementCapable = {
  parentElement: unknown | null;
};

export type LinkTargetLike = {
  getAttribute: (name: string) => string | null;
};

export type LinkClickEventLike = Pick<MouseEvent, 'button' | 'metaKey' | 'ctrlKey' | 'defaultPrevented'>;
export type LinkModifierEventLike = Pick<MouseEvent, 'metaKey' | 'ctrlKey'>;

export type LinkPressEventLike = Pick<MouseEvent, 'button' | 'altKey'>;

type LinkOpenTrigger = 'read_only_click' | 'modifier_click' | 'plain_click';

function hasClosest(value: unknown): value is ClosestCapable {
  return typeof value === 'object'
    && value !== null
    && 'closest' in value
    && typeof (value as ClosestCapable).closest === 'function';
}

function hasParentElement(value: unknown): value is ParentElementCapable {
  return typeof value === 'object'
    && value !== null
    && 'parentElement' in value;
}

function hasGetAttribute(value: unknown): value is LinkTargetLike {
  return typeof value === 'object'
    && value !== null
    && 'getAttribute' in value
    && typeof (value as LinkTargetLike).getAttribute === 'function';
}

function getClosestSearchTarget(target: unknown): ClosestCapable | null {
  if (hasClosest(target)) return target;
  if (hasParentElement(target) && hasClosest(target.parentElement)) return target.parentElement;
  return null;
}

function resolveBaseUrl(baseHref?: string): URL {
  const runtimeBase = typeof window !== 'undefined' ? window.location?.href : undefined;
  const candidate = baseHref || runtimeBase || FALLBACK_BASE_URL;

  try {
    return new URL(candidate);
  } catch {
    return new URL(FALLBACK_BASE_URL);
  }
}

function extractLinkTarget(targetLike: unknown): LinkTargetLike | null {
  const target = getClosestSearchTarget(targetLike);
  if (!target) return null;

  // Text a suggestion deletes is not a place to go.
  if (LINK_CLICK_POLICY.skipDeletedText && target.closest('.mark-delete, .mark-replace-delete')) {
    return null;
  }

  const linkTarget = target.closest('a[href]');
  if (!hasGetAttribute(linkTarget)) return null;
  return linkTarget;
}

function getLinkProtocol(normalizedHref: string): string {
  try {
    return new URL(normalizedHref).protocol;
  } catch {
    return 'unknown';
  }
}

function openLinkInNewTab(rawHref: string, context: { editable: boolean; trigger: LinkOpenTrigger }): boolean {
  const normalizedHref = normalizeAndValidateHref(rawHref);
  if (!normalizedHref) {
    captureEvent('markdown_link_open_blocked', {
      reason: 'invalid_href',
      editable: context.editable,
      trigger: context.trigger,
    });
    return false;
  }

  const protocol = getLinkProtocol(normalizedHref);

  if (context.trigger === 'modifier_click') {
    captureEvent('markdown_link_open_modifier_click', {
      editable: context.editable,
      protocol,
    });
  }

  captureEvent('markdown_link_open_attempt', {
    editable: context.editable,
    protocol,
    trigger: context.trigger,
  });

  // With noopener the browser returns null even when the tab opened, so the call is the result.
  window.open(normalizedHref, LINK_CLICK_POLICY.externalTarget, 'noopener,noreferrer');
  captureEvent('markdown_link_opened', {
    reason: 'opened',
    editable: context.editable,
    protocol,
    trigger: context.trigger,
  });

  return true;
}

/**
 * Does this click open the link? A primary click does, editable or not (Mike, 2026-09-21), and
 * whether or not something default-prevented it (ProseMirror often does). Alt/Option+click edits.
 */
export function shouldOpenLinkForEvent(event: LinkClickEventLike & Partial<Pick<MouseEvent, 'altKey'>>, _isEditable: boolean): boolean {
  if (event.button !== 0) return false;
  if (LINK_CLICK_POLICY.altClickEdits && event.altKey) return false;
  if (LINK_CLICK_POLICY.plainClickOpens) return true;
  return isLinkModifierActive(event);
}

/** A press on a link: keep the caret out of the text unless the person asked to edit (Alt). */
export function pressKeepsCaretOut(event: LinkPressEventLike): boolean {
  return event.button === 0 && !(LINK_CLICK_POLICY.altClickEdits && event.altKey);
}

/** GitHub-style slug of a heading's text (what `#fragment` links name). */
export function headingSlug(text: string): string {
  return text.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

/** Is this href a link to a place in this document (`#fragment`)? Returns the decoded fragment. */
export function inPageFragment(rawHref: string): string | null {
  const trimmed = rawHref.trim();
  if (!trimmed.startsWith('#') || trimmed.length < 2) return null;
  try { return decodeURIComponent(trimmed.slice(1)); } catch { return trimmed.slice(1); }
}

export function isLinkModifierActive(event: LinkModifierEventLike): boolean {
  return Boolean(event.metaKey || event.ctrlKey);
}

export function normalizeAndValidateHref(rawHref: string, baseHref?: string): string | null {
  const trimmed = rawHref.trim();
  if (!trimmed) return null;

  const baseUrl = resolveBaseUrl(baseHref);

  let resolved: URL;
  try {
    resolved = new URL(trimmed, baseUrl);
  } catch {
    return null;
  }

  if (trimmed.startsWith('#')) {
    return resolved.toString();
  }

  if (HAS_SCHEME_RE.test(trimmed)) {
    if (!ALLOWED_PROTOCOLS.has(resolved.protocol)) return null;
    return resolved.toString();
  }

  if (resolved.origin !== baseUrl.origin) {
    return null;
  }

  return resolved.toString();
}

export function extractLinkTargetFromEvent(event: Pick<MouseEvent, 'target'>): LinkTargetLike | null {
  return extractLinkTarget(event.target);
}

/**
 * A `#fragment` link: the heading (or element with that id) in this document. The page moves the
 * focus line there when it listens for `proof:follow-in-page-link` (the reading walk does);
 * otherwise the heading is scrolled into view.
 */
function followInPageLink(view: EditorView, fragment: string): boolean {
  const wanted = headingSlug(fragment);
  let target: HTMLElement | null = null;
  for (const heading of Array.from(view.dom.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))) {
    if (heading.id === fragment || headingSlug(heading.textContent ?? '') === wanted) { target = heading; break; }
  }
  if (!target) {
    try { target = view.dom.querySelector<HTMLElement>(`#${CSS.escape(fragment)}`); } catch { target = null; }
  }
  if (!target) {
    captureEvent('markdown_link_open_blocked', { reason: 'fragment_not_found', editable: view.editable });
    return false;
  }
  let pos = -1;
  try { pos = view.posAtDOM(target, 0); } catch { pos = -1; }
  const detail = { pos, element: target, handled: false };
  window.dispatchEvent(new CustomEvent('proof:follow-in-page-link', { detail }));
  if (!detail.handled) target.scrollIntoView({ block: 'center', behavior: 'auto' });
  captureEvent('markdown_link_opened', { reason: 'in_page', editable: view.editable, protocol: 'fragment', trigger: 'plain_click' });
  return true;
}

/** Test hook: the last link a click followed. */
const followLog: Array<{ href: string; how: 'new-tab' | 'in-page' | 'blocked' }> = [];
export function linkFollowLog(): ReadonlyArray<{ href: string; how: 'new-tab' | 'in-page' | 'blocked' }> { return followLog; }

function handleLinkClick(view: EditorView, event: MouseEvent): boolean {
  const link = extractLinkTargetFromEvent(event);
  if (!link) return false;
  const href = link.getAttribute('href');
  if (!href) return false;
  if (!shouldOpenLinkForEvent(event, view.editable)) {
    // Alt/Option+click edits: the caret is placed by the press; the browser must not also act on
    // the link (Alt+click downloads in some browsers).
    if (event.button === 0 && event.altKey) event.preventDefault();
    return false;
  }
  event.preventDefault();
  const fragment = LINK_CLICK_POLICY.fragmentInPage ? inPageFragment(href) : null;
  if (fragment !== null) {
    const ok = followInPageLink(view, fragment);
    followLog.push({ href, how: ok ? 'in-page' : 'blocked' });
    return true;
  }
  const trigger: LinkOpenTrigger = !view.editable ? 'read_only_click' : isLinkModifierActive(event) ? 'modifier_click' : 'plain_click';
  const opened = openLinkInNewTab(href, { editable: view.editable, trigger });
  followLog.push({ href, how: opened ? 'new-tab' : 'blocked' });
  if (followLog.length > 20) followLog.shift();
  return true;
}

export const markdownLinkClickPlugin = $prose(() => {
  return new Plugin({
    key: markdownLinkClickKey,
    props: {
      handleDOMEvents: {
        // The press on a link opens it on release; it does not put a caret in the text.
        mousedown(_view, event) {
          if (!(event instanceof MouseEvent)) return false;
          if (!extractLinkTargetFromEvent(event)?.getAttribute('href')) return false;
          if (!pressKeepsCaretOut(event)) return false;
          event.preventDefault();
          return true;
        },
        click(view, event) {
          if (!(event instanceof MouseEvent)) return false;
          return handleLinkClick(view, event);
        },
      },
    },
  });
});

export default markdownLinkClickPlugin;
