/**
 * Rail scrolling (Mike, 2026-09-21): "The marks in the sidebar don't automatically scroll down to
 * the bottom." and "Scrolling in the chat sidebar and scrolling in the text are not decoupled.
 * Scrolling in the text should always scroll the chat to the bottom, where the mark for the text
 * is found."
 *
 * Two rules, for every scrolling list in a rail (the right rail's body, the chat's messages):
 *   1. Independent scroll roots. A wheel or swipe over a rail scrolls that list only; at its ends
 *      it stops (overscroll-behavior: contain), and over a part of the rail that does not scroll
 *      the wheel does nothing. Neither list ever scrolls the page, and the page never scrolls them.
 *   2. Follow the end. While the person has not scrolled a list away from its end, the list keeps
 *      its newest item in view: when items arrive, and when the text's focus line changes. Once
 *      they scroll up in it, it stays where they put it and a "New below ↓" pill offers the way
 *      back (clicking it, or scrolling back down to the end, follows again). Nothing moves under a
 *      reader who is looking at something else (the one model's rule 2).
 *
 * Authorship: Claude Opus 5 (worker proof-bugs6), 2026-09-21.
 */

export const RAIL_FOLLOW_POLICY = {
  enabled: true,
  /** Within this many pixels of the end counts as "at the end" (following). */
  slackPx: 24,
  /** The pill shown when something new is below a list the person scrolled up in. */
  pillLabel: 'New below ↓',
  /** A wheel over a rail never scrolls the page. */
  containWheel: true,
} as const;

export interface FollowerOptions {
  /** The scrolling element. */
  scroller: HTMLElement;
  /**
   * The scrollTop that shows the newest item at the bottom. Default: the very end of the list.
   * The right rail's body returns the end of the focus line's box and changes instead.
   */
  endTop?: () => number;
  /** Where the pill goes (a positioned ancestor of the scroller). Default: the scroller's parent. */
  pillHost?: HTMLElement;
  /** A name for the test hook. */
  name: string;
}

export class ScrollFollower {
  private following = true;
  /** The scrollTop this follower last set (its own scroll events are not the person's). */
  private autoTop: number | null = null;
  private readonly pill: HTMLButtonElement;
  private follows = 0;
  private pillShows = 0;
  private personScrolls = 0;

  constructor(private readonly opts: FollowerOptions) {
    this.pill = document.createElement('button');
    this.pill.type = 'button';
    this.pill.className = 'prw-follow-pill';
    this.pill.dataset.follow = opts.name;
    this.pill.textContent = RAIL_FOLLOW_POLICY.pillLabel;
    this.pill.hidden = true;
    this.pill.addEventListener('mousedown', event => event.preventDefault());
    this.pill.onclick = () => { this.following = true; this.pill.hidden = true; this.scrollToEnd(); };
    opts.scroller.addEventListener('scroll', this.onScroll, { passive: true });
    opts.scroller.classList.add('prw-scroll-root');
  }

  /** Attach the pill (call once the scroller is in the page). */
  mount(): void {
    const host = this.opts.pillHost ?? this.opts.scroller.parentElement;
    if (host && this.pill.parentElement !== host) host.append(this.pill);
  }

  destroy(): void {
    this.opts.scroller.removeEventListener('scroll', this.onScroll);
    this.pill.remove();
  }

  isFollowing(): boolean { return this.following; }

  /** The pill, for callers that place it themselves. */
  get pillElement(): HTMLButtonElement { return this.pill; }

  /** Something new is at the end (items arrived, the focus line changed): keep it in view, or offer the pill. */
  follow(): void {
    if (!RAIL_FOLLOW_POLICY.enabled) return;
    if (this.following) { this.scrollToEnd(); return; }
    if (this.distanceFromEnd() <= RAIL_FOLLOW_POLICY.slackPx) { this.following = true; this.pill.hidden = true; return; }
    if (this.pill.hidden) this.pillShows += 1;
    this.pill.hidden = false;
  }

  private target(): number {
    const s = this.opts.scroller;
    const max = Math.max(0, s.scrollHeight - s.clientHeight);
    const wanted = this.opts.endTop ? this.opts.endTop() : max;
    return Math.max(0, Math.min(max, Math.round(wanted)));
  }

  /** How far the person is above the end (0 at or below it: below the end still counts as following). */
  private distanceFromEnd(): number {
    return Math.max(0, this.target() - this.opts.scroller.scrollTop);
  }

  private scrollToEnd(): void {
    const s = this.opts.scroller;
    const top = this.target();
    this.follows += 1;
    if (Math.abs(s.scrollTop - top) < 1) { this.autoTop = null; return; }
    this.autoTop = top;
    s.scrollTop = top;
  }

  private onScroll = (): void => {
    const s = this.opts.scroller;
    if (this.autoTop !== null && Math.abs(s.scrollTop - this.autoTop) <= 1) { this.autoTop = null; return; }
    this.autoTop = null;
    // The person scrolled this list: following while they are at the end, not once they leave it.
    this.personScrolls += 1;
    const atEnd = this.distanceFromEnd() <= RAIL_FOLLOW_POLICY.slackPx;
    this.following = atEnd;
    if (atEnd) this.pill.hidden = true;
  };

  debugState(): Record<string, unknown> {
    const s = this.opts.scroller;
    return {
      following: this.following, pill: !this.pill.hidden, follows: this.follows, pillShows: this.pillShows,
      personScrolls: this.personScrolls, scrollTop: Math.round(s.scrollTop), target: this.target(),
      scrollHeight: s.scrollHeight, clientHeight: s.clientHeight,
    };
  }
}

/**
 * Rule 1 for a whole rail: a wheel over it scrolls the nearest list inside it that can move that
 * way; if none can, the wheel is stopped so it never reaches the page.
 */
export function containRailWheel(rail: HTMLElement): () => void {
  const onWheel = (event: WheelEvent): void => {
    if (!RAIL_FOLLOW_POLICY.containWheel || event.ctrlKey) return;
    const dy = event.deltaY;
    const dx = event.deltaX;
    let node = event.target as HTMLElement | null;
    while (node && node !== rail.parentElement) {
      if (canScroll(node, dx, dy)) return; // that list takes it (and stops at its end: contain)
      if (node === rail) break;
      node = node.parentElement;
    }
    event.preventDefault();
  };
  rail.addEventListener('wheel', onWheel, { passive: false });
  return () => rail.removeEventListener('wheel', onWheel);
}

function canScroll(el: HTMLElement, dx: number, dy: number): boolean {
  const style = getComputedStyle(el);
  if (Math.abs(dy) >= Math.abs(dx)) {
    if (!/(auto|scroll)/.test(style.overflowY) || el.scrollHeight <= el.clientHeight + 1) return false;
    return dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  }
  if (!/(auto|scroll)/.test(style.overflowX) || el.scrollWidth <= el.clientWidth + 1) return false;
  return dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
}
