/**
 * Selected passages keep their screen position when layout changes above them.
 * Mike, 2026-09-23 (usability brief). Explicit navigation uses the centred dead zone.
 *
 * Mike, 2026-09-22: "Highlighted line tends to be at the top of the scrolling area and sometimes is
 * only partially visible. What about moving toward the center of the screen as the user scrolls
 * down."
 *
 * The rule:
 *  - The cursor sits where it is. Moving it does NOT scroll the page while it is outside the middle
 *    band, so near the top of a document the cursor walks down a still page.
 *  - Once the cursor would leave the middle band, the page scrolls to keep it inside the band. The
 *    band is a dead zone (a share of the reading area, not one line), so small moves never jitter
 *    the page.
 *  - Near the end of the document the page has no more to give: the offset clamps at the last
 *    scroll position and the cursor walks on alone to the last line.
 *  - A document shorter than one viewport never scrolls (maxScroll is 0).
 *  - A line taller than the band centres its TOP, so its first line is always visible.
 *  - A line that fits in the reading area is ALWAYS fully visible: the band result is tightened so
 *    neither edge of the line is cut off.
 *  - The camera never animates. A jump lands centred immediately; an animated scroll is what makes
 *    people motion-sick, and prefers-reduced-motion would forbid it anyway.
 *
 * Pure on purpose: it takes numbers and returns a number, so the offset rule is unit tested without
 * a browser (src/tests/scroll-camera.test.ts). src/ui/reading-walk.ts applies it.
 *
 * Authorship: Mike Wolf (rulings), built by Claude Opus 5 (worker accord-scroll), 2026-09-22.
 */

export const SCROLL_CAMERA_POLICY = {
  /** Desktop: the dead zone's height, as a share of the reading area (the viewport under the chrome). */
  bandFraction: 0.2,
  /** Phones: a taller band, because one line is a bigger share of a small screen. */
  phoneBandFraction: 0.3,
  /** A band is never thinner than this, so a tall line still has a dead zone. */
  minBandPx: 48,
  /** The camera never animates, on any surface, with or without prefers-reduced-motion. */
  behavior: 'instant' as const,
  /**
   * The camera only ever runs for a cursor move the person caused (a key, a click, a jump, a
   * restored session). It never runs on its own, never on a remote edit, and never while the person
   * is scrolling by hand: the page is theirs, and the camera re-engages on the next cursor move.
   */
  runsOn: ['key', 'click', 'jump', 'restore'] as readonly string[],
} as const;

/** The viewport, in the camera's terms. All px. */
export interface CameraView {
  /** The window's inner height. */
  viewportHeight: number;
  /** The top of the reading area: the chrome (banner, toolbar) covers everything above it. */
  topInset: number;
  /** The current scroll offset. */
  scrollY: number;
  /** The largest offset the document allows: max(0, documentHeight - viewportHeight). */
  maxScroll: number;
  /** Overrides SCROLL_CAMERA_POLICY.bandFraction (the phone passes its own). */
  bandFraction?: number;
}

/** The cursor line's box, in DOCUMENT coordinates (its top with the page at offset 0). */
export interface CameraLine {
  top: number;
  height: number;
}

export interface DeadZone {
  /** Viewport y of the band's top edge. */
  top: number;
  /** Viewport y of the band's bottom edge. */
  bottom: number;
  height: number;
  /** Viewport y of the band's centre — the middle of the reading area. */
  centre: number;
}

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);

/** The middle band: centred in the reading area, bandFraction of its height. */
export function deadZone(view: CameraView): DeadZone {
  const top = Math.max(0, view.topInset);
  const bottom = Math.max(top, view.viewportHeight);
  const reading = bottom - top;
  const fraction = view.bandFraction ?? SCROLL_CAMERA_POLICY.bandFraction;
  const height = Math.min(reading, Math.max(SCROLL_CAMERA_POLICY.minBandPx, reading * fraction));
  const centre = top + reading / 2;
  return { top: centre - height / 2, bottom: centre + height / 2, height, centre };
}

/**
 * The offset the page should have so the cursor line is inside the band.
 * Returns view.scrollY unchanged when the cursor is already in the dead zone, and clamps to what
 * the document has (0 at the top, maxScroll at the end), which is how the cursor walks alone.
 */
export function cameraScroll(line: CameraLine, view: CameraView): number {
  const zone = deadZone(view);
  const max = Math.max(0, view.maxScroll);
  const height = Math.max(0, line.height);
  const top = line.top - view.scrollY;
  let want = view.scrollY;

  if (height > zone.height) {
    // Taller than the band: the band is the dead zone for its TOP, and the top is what must show.
    if (top < zone.top || top > zone.bottom) want = line.top - zone.top;
  } else if (top < zone.top) {
    want = line.top - zone.top;
  } else if (top + height > zone.bottom) {
    want = line.top + height - zone.bottom;
  }

  // Never partially visible: a line that fits under the chrome is shown whole.
  const reading = Math.max(0, view.viewportHeight - Math.max(0, view.topInset));
  if (height <= reading) {
    want = clamp(want, line.top + height - view.viewportHeight, line.top - Math.max(0, view.topInset));
  }
  return clamp(Math.round(want), 0, max);
}

/**
 * Where the cursor line's top sits in the viewport once the camera has run — the new reading line.
 * src/ui/reading-walk.ts keeps that as its reading line, so scrolling by hand afterwards moves the
 * cursor line for line from where it is, instead of snapping it back to the top of the page.
 */
export function cameraReadingY(line: CameraLine, view: CameraView): number {
  return line.top - cameraScroll(line, view);
}

/** True when the camera would move the page for this line. Used by the tests and the checks. */
export function cameraWouldMove(line: CameraLine, view: CameraView): boolean {
  return cameraScroll(line, view) !== Math.round(view.scrollY);
}

/** The band fraction for a surface. Phones get their own. */
export function bandFractionFor(phone: boolean): number {
  return phone ? SCROLL_CAMERA_POLICY.phoneBandFraction : SCROLL_CAMERA_POLICY.bandFraction;
}

/** Restore a passage's screen position, accounting for deliberate scrolling since capture. */
export function anchoredScroll(before: { top: number; scrollY: number }, after: { top: number; scrollY: number }, maxScroll: number): number {
  const layoutShift = after.top - before.top + after.scrollY - before.scrollY;
  return clamp(after.scrollY + layoutShift, 0, Math.max(0, maxScroll));
}
