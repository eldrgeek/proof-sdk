// Accord round 2 stage B: the scroll camera's offset rule, with no browser.
// Authorship: Mike Wolf (rulings), built by Claude Opus 5 (worker accord-scroll), 2026-09-22.
import assert from 'node:assert/strict';
import {
  SCROLL_CAMERA_POLICY, bandFractionFor, cameraReadingY, cameraScroll, cameraWouldMove, deadZone,
  type CameraView,
} from '../shared/scroll-camera';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

/** A 900 px window, 100 px of chrome, a 5,000 px document: 4,100 px of scroll. */
const view = (over: Partial<CameraView> = {}): CameraView => ({
  viewportHeight: 900, topInset: 100, scrollY: 0, maxScroll: 4100, ...over,
});
const LINE = 30;
const zone = deadZone(view());

test('the dead zone is centred in the reading area and is a fifth of it', () => {
  assert.equal(zone.centre, 500, 'the middle of the reading area (100..900)');
  assert.equal(zone.height, 160, '20% of 800');
  assert.equal(zone.top, 420);
  assert.equal(zone.bottom, 580);
  assert.equal(bandFractionFor(false), SCROLL_CAMERA_POLICY.bandFraction);
  assert.ok(bandFractionFor(true) > bandFractionFor(false), 'the phone band is taller');
});

test('near the top of a document the cursor walks down a still page', () => {
  // Every line whose top is above the band keeps the page at 0.
  for (const top of [100, 200, 300, 419]) {
    assert.equal(cameraScroll({ top, height: LINE }, view()), 0, `line at ${top} scrolled the page`);
  }
  assert.equal(cameraWouldMove({ top: 300, height: LINE }, view()), false);
});

test('a cursor inside the band does not move the page: the dead zone', () => {
  const at = view({ scrollY: 1000 });
  // Viewport y 430 .. 550: inside the band (and the line's bottom is inside too).
  for (const y of [430, 480, 549]) {
    assert.equal(cameraScroll({ top: 1000 + y, height: LINE }, at), 1000, `y ${y} moved the page`);
  }
  assert.equal(cameraWouldMove({ top: 1480, height: LINE }, at), false);
});

test('past the band the page follows, keeping the cursor at the band edge', () => {
  const at = view({ scrollY: 1000 });
  // Below the band: the line's BOTTOM lands on the band's bottom edge.
  const down = cameraScroll({ top: 1000 + 700, height: LINE }, at);
  assert.equal(down, 1700 + LINE - zone.bottom, 'the cursor sits at the band bottom');
  assert.equal(1700 - down, zone.bottom - LINE);
  // Above the band (scrolling up is the mirror): the line's TOP lands on the band's top edge.
  const up = cameraScroll({ top: 1000 + 200, height: LINE }, at);
  assert.equal(up, 1200 - zone.top);
  assert.equal(1200 - up, zone.top);
});

test('one line of movement inside the band never moves the page (no jitter)', () => {
  const at = view({ scrollY: 1000 });
  let scrollY = 1000;
  let moved = 0;
  for (let top = 1000 + zone.top; top < 1000 + zone.bottom - LINE; top += LINE) {
    const next = cameraScroll({ top, height: LINE }, { ...at, scrollY });
    if (next !== scrollY) moved += 1;
    scrollY = next;
  }
  assert.equal(moved, 0, 'the page jittered inside the dead zone');
});

test('a document shorter than one viewport never scrolls', () => {
  const short = view({ maxScroll: 0 });
  for (const top of [100, 400, 700, 880]) {
    assert.equal(cameraScroll({ top, height: LINE }, short), 0, `line at ${top} scrolled a short page`);
  }
});

test('near the end the page stops and the cursor walks on alone', () => {
  const end = view({ scrollY: 4100 });
  // The last lines of a 5,000 px document: the page is already at its last offset.
  for (const top of [4600, 4800, 4960]) {
    assert.equal(cameraScroll({ top, height: LINE }, end), 4100, `line at ${top} scrolled past the end`);
  }
  // And the cursor's y grows: it is walking down a page that cannot follow.
  assert.equal(cameraReadingY({ top: 4600, height: LINE }, end), 500);
  assert.equal(cameraReadingY({ top: 4960, height: LINE }, end), 860);
});

test('a line taller than the band centres its TOP, so its first line shows', () => {
  const at = view({ scrollY: 1000 });
  const tall = { top: 1000 + 700, height: 400 };
  const offset = cameraScroll(tall, at);
  assert.equal(tall.top - offset, zone.top, 'the tall line\'s top is not at the band top');
  assert.ok(tall.top - offset >= 100, 'the top is under the chrome');
  // A tall line already inside the band keeps the page still (the band is its dead zone).
  assert.equal(cameraScroll({ top: 1000 + 500, height: 400 }, at), 1000);
});

test('a line that fits the reading area is never only partially visible', () => {
  const at = view({ scrollY: 1000 });
  // 700 px of the 800 px reading area: the band would cut its bottom off, so the camera moves it
  // only as far as it must — the whole line shows, with its top under the chrome.
  const big = { top: 1000 + 800, height: 700 };
  const offset = cameraScroll(big, at);
  assert.equal(big.top - offset, 200, 'the top is not under the chrome');
  assert.equal(big.top + big.height - offset, 900, 'the bottom is not at the bottom of the window');
  // Any line, from anywhere, ends fully visible.
  for (const height of [20, 120, 300, 640, 800]) {
    for (const top of [0, 500, 2000, 4200, 4900]) {
      const s = cameraScroll({ top, height }, at);
      const y = top - s;
      if (height <= 800 && top + height <= 5000 && s > 0 && s < 4100) {
        assert.ok(y >= 100 - 0.5, `top ${y} is under the chrome (h ${height}, top ${top})`);
        assert.ok(y + height <= 900 + 0.5, `bottom ${y + height} is off screen (h ${height}, top ${top})`);
      }
    }
  }
});

test('the offset is always a whole number inside the document', () => {
  for (const top of [-50, 0, 137.4, 2500.6, 4999, 9000]) {
    const s = cameraScroll({ top, height: LINE }, view({ scrollY: 1234 }));
    assert.ok(Number.isInteger(s), `offset ${s}`);
    assert.ok(s >= 0 && s <= 4100, `offset ${s} out of the document`);
  }
});

test('the camera never animates', () => {
  assert.equal(SCROLL_CAMERA_POLICY.behavior, 'instant');
});

console.log(`\n${passed} scroll camera tests passed`);
