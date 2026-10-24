// Mike, 2026-09-23 (usability brief). Shared browser assertions; loopback fixtures only.
import assert from 'node:assert/strict';

export async function selectPassage(page, index) {
  await page.evaluate(i => {
    document.activeElement?.blur();
    window.__proofLineMarks.revealLine(i);
    window.__proofReadingWalk.focusLine(i);
  }, index);
  await page.waitForTimeout(100);
}

export async function hoverChangesNothing(page, index) {
  const box = await page.evaluate(i => {
    const lm = window.__proofLineMarks;
    return lm.editorView().nodeDOM(lm.lineList()[i].pos).getBoundingClientRect().toJSON();
  }, index);
  const snapshot = () => page.evaluate(() => {
    const w = window.__proofReadingWalk.debugState();
    const view = window.__proofLineMarks.editorView();
    return {
      target: w.target, cursor: w.cursor, writing: window.__proofEditingGuard().writing,
      selection: view.state.selection.toJSON(), scroll: window.scrollY,
      folded: window.__proofFolding.debugState().folded,
      boxes: [...view.dom.children].map(n => {
        const r = n.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
      }),
      active: [document.activeElement?.tagName, document.activeElement?.id, document.activeElement?.className],
    };
  });
  const before = await snapshot();
  await page.mouse.move(box.x + Math.min(80, box.width / 2), box.y + Math.min(12, box.height / 2));
  await page.waitForTimeout(400);
  const after = await snapshot();
  assert.deepEqual(after, before, 'hover changed target, selection, mode, layout, folds or focus');
}

export async function scrollAcceptsNothing(page) {
  const decisions = [];
  const listen = req => {
    if (req.method() !== 'POST' || !req.url().includes('/line-marks')) return;
    const body = req.postDataJSON();
    if (body.status === 'agreed' || body.status === 'approved') decisions.push(body);
  };
  page.on('request', listen);
  const pending = () => page.evaluate(() => (window.proof.getAllMarks() ?? [])
    .filter(m => ['insert', 'delete', 'replace'].includes(m.kind) && (m.data?.status ?? 'pending') === 'pending')
    .map(m => m.id).sort());
  try {
    const before = await pending();
    const selected = await page.evaluate(() => window.__proofReadingWalk.debugState().cursor);
    await page.evaluate(() => document.activeElement?.blur());
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => window.__proofReadingWalk.debugState().cursor), selected, 'scroll changed the action target');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(350);
    // A deliberate later navigation must not commit anything read on the way.
    await page.evaluate(() => window.__proofReadingWalk.focusLine(window.__proofLineMarks.lineList().length - 1));
    await page.waitForTimeout(350);
    assert.deepEqual(await pending(), before, 'reading or later navigation accepted a proposal');
    assert.deepEqual(decisions, [], 'reading recorded agreement');
    assert.equal(await page.locator('.prw-commit, .pst-save').count(), 0, 'scroll acceptance control remains');
  } finally { page.off('request', listen); }
}

export async function expandedStaysExpanded(page) {
  await page.evaluate(() => window.__proofFolding.unfoldAll());
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  assert.deepEqual(await page.evaluate(() => window.__proofFolding.debugState().folded), []);
  assert.equal(await page.locator('.pclose-folded, .pclose-controls').count(), 0, 'closed-Issue folding remains');
}

export async function explicitAcceptUndo(page, line) {
  await selectPassage(page, line);
  const toggle = page.locator('[data-accord-review-toggle]');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const accept = page.locator('.anv-detail .prw-accept, .prw-changes .prw-accept').first();
  const pending = () => page.evaluate(() => window.proof.getAllMarks().filter(m => ['replace', 'insert', 'delete'].includes(m.kind) && (m.data?.status ?? 'pending') === 'pending').map(m => m.id).sort());
  const before = await pending();
  assert.ok(before.length > 0);
  await accept.click();
  await page.waitForFunction(n => window.proof.getAllMarks().filter(m => ['replace', 'insert', 'delete'].includes(m.kind) && (m.data?.status ?? 'pending') === 'pending').length === n - 1, before.length);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  assert.equal((await pending()).length, before.length - 1, 'scrolling reversed an explicit decision');
  await page.locator('.pundo-btn').first().click();
  await page.waitForFunction(n => window.proof.getAllMarks().filter(m => ['replace', 'insert', 'delete'].includes(m.kind) && (m.data?.status ?? 'pending') === 'pending').length === n, before.length);
  assert.deepEqual(await pending(), before, 'Undo did not restore the explicitly accepted proposal');
}

export async function explicitRefusalPreservesText(page, line) {
  await selectPassage(page, line);
  const toggle = page.locator('[data-accord-review-toggle]');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  const before = await page.evaluate(() => window.proof.getMarkdownSnapshot()?.content);
  await page.evaluate(() => {
    const host = window.__proofReadingWalk.host;
    window.__s1Decide = host.decide;
    host.decide = () => { throw new Error('The proposal changed. Nothing was changed.'); };
  });
  try {
    await page.locator('.anv-detail .prw-accept, .prw-changes .prw-accept').first().click();
    assert.match(await page.locator('.prw-provisional .prw-error, .prw-error').first().textContent(), /Nothing was changed/);
    assert.equal(await page.evaluate(() => window.proof.getMarkdownSnapshot()?.content), before);
  } finally {
    await page.evaluate(() => { window.__proofReadingWalk.host.decide = window.__s1Decide; delete window.__s1Decide; });
  }
}
