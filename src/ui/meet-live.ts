/**
 * The top bar's one "Meet live" link. The words and the href rule live in
 * src/shared/meet-live.ts. This module only draws the anchor.
 */
import { MEET_LIVE_POLICY } from '../shared/meet-live';

/** A quiet text link. `href` is already checked by meetLiveHref. */
export function createMeetLiveLink(href: string): HTMLAnchorElement {
  const link = document.createElement('a');
  link.className = 'meet-live-link';
  link.dataset.meetLive = '';
  link.href = href;
  link.textContent = MEET_LIVE_POLICY.label;
  if (MEET_LIVE_POLICY.openInNewTab) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  return link;
}
