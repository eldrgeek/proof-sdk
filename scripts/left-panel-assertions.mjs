// Mike, 2026-09-24, Accord gfmd0z5p / ac-2vs. Shared assertions for the retired marking UI.
import assert from 'node:assert/strict';

export async function assertRetiredMarks(page) {
  assert.equal(await page.locator('.prw-right, .plm-box-margin, .plm-dot, .plm-glyph, .plm-pips').count(), 0);
  assert.equal(await page.locator('.plm-choice[data-status="agreed"], .plm-choice[data-status="rejected"]').count(), 0);
}

export async function assertMarkKeysInactive(page) {
  const writes = [];
  const listen = req => {
    if (req.method() !== 'POST' || !req.url().includes('/line-marks')) return;
    const body = req.postDataJSON();
    // Silent reading continues. A/R must produce no deliberate marking write.
    if (body.via !== 'dwell' && body.via !== 'section') writes.push(body);
  };
  const snapshot = () => page.evaluate(() => ({
    cursor: window.__proofReadingWalk.cursorLine(),
    text: window.proof.getMarkdownSnapshot()?.content,
    marks: window.__proofLineMarks.debugState().marks.filter(m => ['agreed', 'rejected', 'approved'].includes(m.status)),
    folds: window.__proofFolding.debugState().folded,
  }));
  await page.evaluate(() => document.activeElement?.blur());
  const before = await snapshot();
  page.on('request', listen);
  try {
    for (const key of ['a', 'r', 'A', 'R']) await page.keyboard.press(key);
    await page.waitForTimeout(350);
    assert.deepEqual(await snapshot(), before, 'A/R changed the selection, text, marks or folds');
    assert.deepEqual(writes, [], 'A/R sent a marking write');
    await assertRetiredMarks(page);
  } finally { page.off('request', listen); }
}

export async function assertSinglePanel(page) {
  await assertRetiredMarks(page);
  assert.deepEqual(await page.locator('.anv-tab').evaluateAll(nodes => nodes.map(n => n.dataset.tab)), ['issues', 'outline', 'since', 'room']);
  const layout = await page.evaluate(() => ({
    phone: innerWidth <= 700,
    left: document.querySelector('.prw-left').getBoundingClientRect().toJSON(),
    text: document.querySelector('.ProseMirror').getBoundingClientRect().toJSON(),
    page: document.querySelector('#editor-container').getBoundingClientRect().toJSON(),
    sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
  }));
  assert.ok(layout.sw <= layout.cw + 1, 'horizontal overflow');
  if (!layout.phone) {
    assert.ok(layout.left.right <= layout.text.left, 'side panel covers document');
    assert.ok(layout.page.right <= layout.cw + 1);
  }
}

export async function assertPassageActions(page) {
  const actions = page.locator('.accord-passage-actions');
  await actions.waitFor({ state: 'visible' });
  assert.deepEqual(await actions.locator('button').allTextContents(), ['Suggest change', 'Discuss']);
  assert.equal(await actions.getAttribute('data-line'), String(await page.evaluate(() => window.__proofReadingWalk.cursorLine())));
  const boxes = await actions.locator('button').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().toJSON()));
  for (const box of boxes) assert.ok(box.height >= 44, 'action is too small to tap');
  const r = await actions.boundingBox();
  const prose = await page.locator('.ProseMirror').boundingBox();
  const width = await page.evaluate(() => innerWidth);
  assert.ok(r.x >= prose.x + prose.width, 'actions cover prose');
  assert.ok(r.x + r.width <= width + 1, 'actions extend off screen');
  for (const button of await actions.locator('button').all()) {
    await button.focus();
    assert.equal(await button.evaluate(n => n === document.activeElement), true);
  }
  await page.evaluate(() => document.activeElement?.blur());
}

export async function assertPanelToggle(page) {
  const phone = await page.evaluate(() => innerWidth <= 700);
  await page.evaluate(() => {
    const walk = window.__proofReadingWalk;
    if (!walk.railShown('left')) walk.toggleRailFromMenu('left');
  });
  const toggle = page.locator('.prw-left .prw-collapse');
  const width = () => page.locator('.ProseMirror').evaluate(n => n.getBoundingClientRect().width);
  const open = await width();
  await toggle.click();
  if (phone) {
    assert.equal(await page.locator('.prw-left.prw-sheet-open').count(), 0);
    await page.locator('.prw-strip-review').click();
    assert.equal(await page.locator('.prw-left.prw-sheet-open').count(), 1);
  } else {
    const closed = await width();
    assert.ok(closed > open + 200, `closing did not return panel width: ${open} -> ${closed}`);
    await toggle.click();
    assert.ok(Math.abs(await width() - open) <= 1, 'reopening did not restore width');
  }
}

// Legacy marks are fixtures, never reader controls. This exercises unchanged persistence/undo paths.
export async function seedLegacyMark(page, index, status, reason) {
  const ok = await page.evaluate(async ({ index, status, reason }) => window.__proofLineMarks.setLineStatus(index, status, reason, 'api'), { index, status, reason });
  assert.notEqual(ok, false, 'could not seed legacy mark fixture');
}
