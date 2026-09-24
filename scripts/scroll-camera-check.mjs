#!/usr/bin/env node
// Accord round 2 stage B — the scroll camera with a centred dead zone.
// Authorship: Mike Wolf (rulings), built by Claude Opus 5 (worker accord-scroll), 2026-09-22.
//
// Two halves, both about BEHAVIOUR, not markup:
//  1. Pure unit tests of the offset rule (src/shared/scroll-camera.ts), run in the page against the
//     same module the app uses: top of the document, inside the band, past the band, the end of the
//     document, a document shorter than the viewport, and a line taller than the band.
//  2. Browser tests: the cursor is never only partially visible, the cursor walks down a still page
//     at the top, the page follows once the cursor is in the band, the page stops at the end and the
//     cursor walks on alone, a jump lands centred with NO animated scroll (also under
//     prefers-reduced-motion), and hand-scrolling is never fought.
//
// Starts an isolated local server on the current dist/ build (run `npm run build` first) with a
// throwaway SQLite database. Screenshots go to .preview/ (or --shots <dir>) as scroll-*.png.
// Usage: node scripts/scroll-camera-check.mjs [--width 1440] [--shots dir]
import assert from 'node:assert/strict';

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const shots = arg('--shots') || path.join(root, '.preview');
mkdirSync(shots, { recursive: true });
const widths = arg('--width') ? [Number(arg('--width'))] : [1440];

const clientHeaders = { 'X-Proof-Client-Version': '0.33.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
let failures = 0;
const results = [];
let activePage = null;
async function check(name, fn) {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) {
    failures += 1; results.push(`FAIL ${name}: ${error?.message?.split('\n')[0]}`);
    await activePage?.screenshot({ path: path.join(shots, `scroll-FAIL-${failures}.png`) }).catch(() => {});
  }
  console.log(results[results.length - 1]);
}

async function startServer() {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-scroll-camera-check-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      PORT: String(port), COLLAB_EMBEDDED_WS: '1', PROOF_DEFAULT_REVIEW_STYLE: 'proof',
      PROOF_FEEDBACK_ENABLED: '1', SOMA_FEEDBACK_ENDPOINT: 'http://127.0.0.1:9/feedback',
      DATABASE_PATH: path.join(temp, 'test.db'), SNAPSHOT_DIR: path.join(temp, 'snapshots'),
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => { child.kill('SIGTERM'); await new Promise(r => setTimeout(r, 300)); rmSync(temp, { recursive: true, force: true }); };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const health = await fetch(`${base}/health`).catch(() => null);
    if (health?.ok) return { base, stop };
    await new Promise(r => setTimeout(r, 150));
  }
  await stop();
  throw new Error('server did not start');
}

const plain = (n) => `Paragraph ${n} is ordinary text for reading. It is long enough to be a real line on a wide screen and to wrap once on a phone, which is what the camera has to place.`;
// A long document: three sections, a paragraph that wraps into a tall block, and a code block that
// is taller than any band.
const TALL = `A wall of one paragraph: ${Array.from({ length: 26 }, (_, i) => `clause ${i + 1} of a single sentence that keeps going so that this one line is taller than the dead zone on every screen we support`).join('; ')}.`;
const CODE = ['```', ...Array.from({ length: 22 }, (_, i) => `const line${i + 1} = 'a code block is one line to the walk, and it is taller than the band';`), '```'].join('\n');
const markdown = [
  '# The scroll camera',
  ...Array.from({ length: 12 }, (_, i) => plain(i + 1)),
  '## The middle band',
  TALL,
  ...Array.from({ length: 12 }, (_, i) => plain(i + 13)),
  '## The end of the document',
  CODE,
  ...Array.from({ length: 12 }, (_, i) => plain(i + 25)),
].join('\n\n');
const short = ['# A short note', 'One paragraph, and the whole document is shorter than a window.', 'Two paragraphs, in fact.'].join('\n\n');

async function createDoc(base, source, title) {
  const response = await fetch(`${base}/api/documents`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
    body: JSON.stringify({ markdown: source, title }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function openDoc(browser, base, slug, name, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(viewer => {
    try { localStorage.setItem('proof-share-viewer-name', viewer); } catch {}
    // Record every programmatic scroll so an animated one cannot hide: the camera must be instant.
    window.__scrollCalls = [];
    const scrollTo = window.scrollTo.bind(window);
    window.scrollTo = (...args) => {
      const options = typeof args[0] === 'object' && args[0] !== null ? args[0] : null;
      window.__scrollCalls.push({ how: 'scrollTo', behavior: options?.behavior ?? 'auto' });
      return scrollTo(...args);
    };
    const scrollBy = window.scrollBy.bind(window);
    window.scrollBy = (...args) => {
      const options = typeof args[0] === 'object' && args[0] !== null ? args[0] : null;
      window.__scrollCalls.push({ how: 'scrollBy', behavior: options?.behavior ?? 'auto' });
      return scrollBy(...args);
    };
    const into = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function patched(...args) {
      const options = typeof args[0] === 'object' && args[0] !== null ? args[0] : null;
      window.__scrollCalls.push({ how: 'scrollIntoView', behavior: options?.behavior ?? 'auto' });
      return into.apply(this, args);
    };
  }, name);
  const page = await context.newPage();
  await page.goto(`${base}/d/${slug}`);
  await page.waitForFunction(() => window.proof?.collabConnectionStatus === 'connected' && window.proof?.collabIsSynced === true, null, { timeout: 20_000 });
  await page.waitForFunction(() => window.__proofReadingWalk?.debugState().ready === true, null, { timeout: 15_000 });
  const toast = page.locator('.proof-share-welcome-toast button');
  if (await toast.count()) await toast.first().click().catch(() => {});
  page.setDefaultTimeout(6000);
  return { context, page };
}

const walk = page => page.evaluate(() => window.__proofReadingWalk.debugState());
/**
 * The cursor as the reader sees it: the focus LINE's own box (the highlight is drawn over it), the
 * band, and the reading area. The line's box is what "only partially visible" is about.
 */
const cursor = page => page.evaluate(() => {
  const s = window.__proofReadingWalk.debugState();
  const node = document.querySelectorAll('.ProseMirror')[0]?.children[s.focus];
  const box = node ? node.getBoundingClientRect() : null;
  const f = document.querySelector('.prw-focus');
  return {
    focus: s.focus, lines: s.lines, scrollY: window.scrollY, maxScroll: Math.max(0, document.documentElement.scrollHeight - innerHeight),
    band: s.camera.band, view: s.camera.view, offset: s.camera.offset, height: innerHeight,
    top: box ? box.top : null, bottom: box ? box.bottom : null,
    highlighted: !!f && !f.hidden && Number(f.dataset.line) === s.focus,
    measuredTop: s.tops[s.focus], measuredHeight: s.heights[s.focus], readingY: s.readingY,
  };
});
function assertVisible(c, where) {
  assert.ok(c.top !== null, `${where}: no cursor line`);
  assert.ok(c.highlighted, `${where}: the cursor line ${c.focus} is not the highlighted one`);
  assert.ok(c.top >= c.view.topInset - 1, `${where}: the cursor's top ${Math.round(c.top)} is under the chrome (${Math.round(c.view.topInset)})`);
  const fits = c.bottom - c.top <= c.height - c.view.topInset;
  if (fits) assert.ok(c.bottom <= c.height + 1, `${where}: the cursor's bottom ${Math.round(c.bottom)} is off the window (${c.height}) [line ${c.focus} measured top ${Math.round(c.measuredTop)} h ${Math.round(c.measuredHeight)}, scrollY ${c.scrollY}, readingY ${Math.round(c.readingY)}]`);
  else assert.ok(c.top <= c.band.bottom + 1, `${where}: a line taller than the window did not show its top in the band`);
}

// ---------------------------------------------------------------------------
// 1. The offset rule, unit tested against the module the page is running.
// ---------------------------------------------------------------------------
async function units(page, tag) {
  await check(`${tag}: the offset rule — top, band, past the band, the end, a short document, a tall line`, async () => {
    const out = await page.evaluate(() => {
      const { cameraScroll, deadZone, policy } = window.__proofScrollCamera;
      const view = (over = {}) => ({ viewportHeight: 900, topInset: 100, scrollY: 0, maxScroll: 4100, ...over });
      const band = deadZone(view());
      const at = view({ scrollY: 1000 });
      return {
        policy,
        band,
        topStill: [100, 200, 300, 419].map(top => cameraScroll({ top, height: 30 }, view())),
        inBand: [430, 480, 549].map(y => cameraScroll({ top: 1000 + y, height: 30 }, at)),
        below: cameraScroll({ top: 1700, height: 30 }, at),
        above: cameraScroll({ top: 1200, height: 30 }, at),
        shortDoc: [100, 400, 700, 880].map(top => cameraScroll({ top, height: 30 }, view({ maxScroll: 0 }))),
        end: [4600, 4800, 4960].map(top => cameraScroll({ top, height: 30 }, view({ scrollY: 4100 }))),
        tallTop: 1700 - cameraScroll({ top: 1700, height: 400 }, at),
        tallStill: cameraScroll({ top: 1500, height: 400 }, at),
      };
    });
    assert.equal(out.policy.behavior, 'instant', 'the camera may never animate');
    assert.deepEqual([out.band.top, out.band.bottom, out.band.height], [420, 580, 160], 'the band is not the centred fifth');
    assert.deepEqual(out.topStill, [0, 0, 0, 0], 'the page moved while the cursor was above the band');
    assert.deepEqual(out.inBand, [1000, 1000, 1000], 'the page moved inside the dead zone');
    assert.equal(out.below, 1700 + 30 - out.band.bottom, 'past the band the cursor is not held at the band edge');
    assert.equal(out.above, 1200 - out.band.top, 'scrolling up is not the mirror of scrolling down');
    assert.deepEqual(out.shortDoc, [0, 0, 0, 0], 'a document shorter than the window scrolled');
    assert.deepEqual(out.end, [4100, 4100, 4100], 'the page scrolled past the end of the document');
    assert.equal(out.tallTop, out.band.top, 'a line taller than the band did not centre its TOP');
    assert.equal(out.tallStill, 1000, 'a tall line already in the band moved the page');
  });
}

// ---------------------------------------------------------------------------
// 2. The camera in a browser.
// ---------------------------------------------------------------------------
async function surface(browser, base, long, brief, tag, contextOptions, phone) {
  const { context, page } = await openDoc(browser, base, long.slug, phone ? 'Pat' : 'Ada', contextOptions);
  activePage = page;
  const press = async (n = 1) => { for (let i = 0; i < n; i += 1) { await page.keyboard.press('j'); await page.waitForTimeout(60); } };

  await units(page, tag);

  await check(`${tag}: the band is a share of the reading area, and the phone's is taller`, async () => {
    const c = await cursor(page);
    const reading = c.height - c.view.topInset;
    assert.ok(c.view.bandFraction === (phone ? 0.3 : 0.2), `band fraction ${c.view.bandFraction}`);
    assert.ok(Math.abs(c.band.height - reading * c.view.bandFraction) <= 1, `band ${c.band.height} of ${reading}`);
    assert.ok(Math.abs(c.band.centre - (c.view.topInset + reading / 2)) <= 1, 'the band is not centred');
  });

  await check(`${tag}: at the top of the document the cursor walks down a still page`, async () => {
    let c = await cursor(page);
    assert.equal(c.focus, 0);
    assert.equal(c.scrollY, 0);
    const first = c.top;
    let steps = 0;
    while (steps < 40) {
      await press();
      c = await cursor(page);
      steps += 1;
      if (c.scrollY > 0) break;
      assert.ok(c.top >= first - 1, `the cursor moved up (${Math.round(c.top)} < ${Math.round(first)})`);
      assert.ok(c.top <= c.band.bottom + 1, `the page stayed still with the cursor at ${Math.round(c.top)}, past the band (${Math.round(c.band.bottom)})`);
      assertVisible(c, 'walking down the still page');
    }
    assert.ok(steps > 1, 'the page moved on the very first J: the cursor never walked a still page');
    assert.ok(c.scrollY > 0, `the page never followed the cursor in ${steps} steps`);
    await page.screenshot({ path: path.join(shots, `scroll-${tag}-1-band.png`) });
  });

  await check(`${tag}: from there on the cursor stays in the band and is never partially visible`, async () => {
    for (let i = 0; i < 25; i += 1) {
      await press();
      const c = await cursor(page);
      assertVisible(c, `J step ${i}`);
      if (c.scrollY > 0 && c.scrollY < c.maxScroll - 1) {
        const tall = c.bottom - c.top > c.band.height;
        assert.ok(c.top >= c.band.top - 2, `step ${i}: the cursor ${Math.round(c.top)} is above the band ${Math.round(c.band.top)}`);
        if (!tall) assert.ok(c.bottom <= c.band.bottom + 2, `step ${i}: the cursor's bottom ${Math.round(c.bottom)} is below the band ${Math.round(c.band.bottom)}`);
        else assert.ok(c.top <= c.band.bottom + 2, `step ${i}: a tall line's top ${Math.round(c.top)} is below the band`);
      }
    }
  });

  await check(`${tag}: walking to the last line never scrolls past the end, and lands it whole`, async () => {
    await press(40);
    const c = await cursor(page);
    assert.equal(c.focus, c.lines - 1, `the walk did not reach the last line (${c.focus} of ${c.lines})`);
    assert.ok(c.scrollY <= c.maxScroll + 1, `the page scrolled past the end (${c.scrollY} of ${c.maxScroll})`);
    assert.ok(c.top >= c.band.top - 2, `the last line sat above the band (${Math.round(c.top)})`);
    assertVisible(c, 'the last line');
    await page.screenshot({ path: path.join(shots, `scroll-${tag}-2-end.png`) });
  });

  await check(`${tag}: a jump lands the target in the band, immediately, with no animated scroll`, async () => {
    await page.evaluate(() => { window.scrollTo(0, 0); window.__scrollCalls = []; });
    await page.waitForTimeout(250);
    if (phone) {
      await page.locator('#share-banner .share-pill-overflow').tap();
      await page.getByRole('menuitem', { name: /Review panel/ }).tap();
      await page.locator('.prw-left.prw-sheet-open').waitFor({ state: 'visible' });
    }
    const outlineTab = page.locator('.anv-tab[data-tab="outline"]');
    if (await outlineTab.count()) await (phone ? outlineTab.tap() : outlineTab.click());
    await page.waitForTimeout(200);
    const rows = page.locator('.anv-heading');
    assert.ok(await rows.count() >= 3, 'the outline has no rows to jump to');
    const target = Number(await rows.nth(2).getAttribute('data-line'));
    await rows.nth(2).click();
    const settling = await page.evaluate(() => window.scrollY);
    await page.waitForTimeout(500);
    const c = await cursor(page);
    assert.equal(c.focus, target, `the jump went to ${c.focus}, not ${target}`);
    assert.equal(c.scrollY, settling, `the scroll was still moving after the click (${settling} -> ${c.scrollY}): an animated jump`);
    assert.ok(c.top >= c.band.top - 2 && c.top <= c.band.bottom + 2, `the jump landed at ${Math.round(c.top)}, outside the band ${Math.round(c.band.top)}..${Math.round(c.band.bottom)}`);
    assertVisible(c, 'after a jump');
    const calls = await page.evaluate(() => window.__scrollCalls);
    const smooth = calls.filter(call => call.behavior === 'smooth');
    assert.equal(smooth.length, 0, `${smooth.length} animated scrolls during the jump`);
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'smooth', 'the page itself animates every scroll');
    await page.screenshot({ path: path.join(shots, `scroll-${tag}-3-jump.png`) });
  });

  await check(`${tag}: hand-scrolling is not fought: the page stays where the person put it`, async () => {
    const before = await page.evaluate(() => { window.__scrollCalls = []; return window.scrollY; });
    const box = await page.locator('.ProseMirror').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 120);
    await page.mouse.wheel(0, 420);
    await page.waitForTimeout(700);
    const after = await cursor(page);
    assert.ok(after.scrollY > before, `the page did not move (${before} -> ${after.scrollY})`);
    const settled = after.scrollY;
    await page.waitForTimeout(700);
    const late = await cursor(page);
    assert.equal(late.scrollY, settled, `the camera pulled the page back (${settled} -> ${late.scrollY})`);
    assert.equal(late.focus, after.focus, 'passive scroll changed the selected passage');
    const calls = await page.evaluate(() => window.__scrollCalls.filter(c => c.how !== 'scrollIntoView'));
    assert.equal(calls.length, 0, `the camera scrolled ${calls.length} times while the person was scrolling`);
  });

  await check(`${tag}: a document that fits the window never scrolls; the cursor just moves`, async () => {
    // A tall window, so the whole short document is on screen. (The page itself is always a little
    // taller than the window — the app keeps room under the last line — so what must be true is
    // that the camera never moves it: every line is above the band.)
    const tall = { width: contextOptions.viewport.width, height: 1400 };
    const brief$ = await openDoc(browser, base, brief.slug, phone ? 'Pat' : 'Ada', { ...contextOptions, viewport: tall, screen: tall });
    activePage = brief$.page;
    try {
      const seen = [];
      for (let i = 0; i < 4; i += 1) {
        await brief$.page.keyboard.press('j');
        await brief$.page.waitForTimeout(90);
        const c = await cursor(brief$.page);
        assert.ok(c.bottom <= c.height + 1, `the whole document does not fit the window (line ${c.focus} ends at ${Math.round(c.bottom)} of ${c.height})`);
        assert.equal(c.scrollY, 0, `a document that fits the window scrolled (line ${c.focus})`);
        assertVisible(c, 'a document that fits the window');
        seen.push(c.focus);
      }
      assert.ok(seen[seen.length - 1] > seen[0], `the cursor did not move (${seen.join(',')})`);
    } finally {
      await brief$.context.close();
      activePage = page;
    }
  });

  await context.close();
}

/**
 * The end of the document: the page stops and the cursor walks on alone.
 *
 * The app keeps a window's worth of room under the last line (scrollHeight is the content plus
 * about innerHeight), so on a real page the camera can always centre even the last line and the
 * bottom clamp never has to bite. Two things are still tested, with the page's OWN geometry rather
 * than made-up numbers: the camera never asks for an offset past the end, and if the page were
 * already at the end, the camera would leave it there and let the cursor walk down alone.
 */
async function endOfDocument(browser, base, long) {
  const viewport = { width: 1440, height: 900 };
  const { context, page } = await openDoc(browser, base, long.slug, 'Ada', { viewport, screen: viewport });
  activePage = page;
  await check('1440: the camera never asks for an offset past the end of the document', async () => {
    const out = await page.evaluate(() => {
      const { cameraScroll } = window.__proofScrollCamera;
      const s = window.__proofReadingWalk.debugState();
      const view = s.camera.view;
      const max = view.maxScroll;
      const asked = [];
      const atEnd = [];
      for (let i = 0; i < s.tops.length; i += 1) {
        const line = { top: s.tops[i], height: s.heights[i] };
        for (const scrollY of [0, Math.round(max / 2), max]) asked.push(cameraScroll(line, { ...view, scrollY }));
        // The page already at its last offset: what the camera does with the lines near the end.
        if (i >= s.tops.length - 6) atEnd.push({ i, offset: cameraScroll(line, { ...view, scrollY: max }), top: s.tops[i] - max });
      }
      return { max, asked, atEnd, height: innerHeight, band: s.camera.band };
    });
    assert.ok(out.max > 0, 'the document does not scroll');
    const over = out.asked.filter(offset => offset > out.max);
    assert.equal(over.length, 0, `${over.length} offsets past the end of the document (max ${out.max})`);
    assert.ok(out.asked.every(offset => offset >= 0), 'an offset above the top of the document');
    for (const line of out.atEnd) {
      assert.ok(line.offset <= out.max, `line ${line.i} would scroll to ${line.offset}, past ${out.max}`);
      // A line already below the band with the page at the end: the camera must leave the page.
      if (line.top > out.band.bottom) assert.equal(line.offset, out.max, `line ${line.i} moved the page after it had run out`);
    }
    await page.screenshot({ path: path.join(shots, 'scroll-1440-4-end-clamp.png') });
  });
  await context.close();
}

// ---------------------------------------------------------------------------
const browser = await chromium.launch();
try {
  const { base, stop } = await startServer();
  try {
    const long = await createDoc(base, markdown, 'The scroll camera');
    const brief = await createDoc(base, short, 'A short note');
    for (const width of widths) {
      await surface(browser, base, long, brief, `${width}`, { viewport: { width, height: 900 } }, false);
    }
    const viewport = { width: 390, height: 844 };
    await surface(browser, base, long, brief, '390', { ...devices['iPhone 13'], viewport, screen: viewport, hasTouch: true, isMobile: true }, true);
    // prefers-reduced-motion: the camera is instant there too (it is instant everywhere).
    await surface(browser, base, long, brief, '1440-reduced-motion', { viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' }, false);
    await endOfDocument(browser, base, long);
  } finally {
    await stop();
  }
} finally {
  await browser.close();
}
console.log(`\n${results.length - failures}/${results.length} scroll camera checks passed`);
process.exit(failures ? 1 : 0);
