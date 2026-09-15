import assert from 'node:assert/strict';
import { withBrowser, openEditor } from './u2-browser-harness';
await withBrowser(async ({ browser, base, create, post }) => {
  for (const width of [1440, 1024, 400]) {
    const doc = await create(Array.from({ length: 35 }, (_, i) => `Paragraph ${i} has something worth reading.`).join('\n\n'));
    const a = await post(doc, '/ops', { type: 'suggestion.add', kind: 'replace', quote: 'Paragraph 12 has something worth reading.', content: 'Paragraph twelve is clearer.', by: 'ai:Test' });
    await post(doc, '/marks/comment', { quote: 'Paragraph 20 has something worth reading.', text: 'Explain this.', by: 'human:Reader' });
    const page = await openEditor(browser, `${base}/d/${doc.slug}`, 'Reader');
    await page.setViewportSize({ width, height: 900 });
    const chat = page.getByRole('complementary', { name: 'Verso chat', exact: true });
    const marks = page.getByRole('complementary', { name: 'Marks', exact: true });
    if (width >= 1024) { assert(await chat.isVisible()); assert(await marks.isVisible()); }
    else { await page.getByRole('button', { name: /^Marks \(/ }).click(); }
    await page.locator(`[data-review-row="${a.markId}"]`).click();
    if (width < 1024) {
      await page.getByRole('button', { name: 'Verso', exact: true }).click();
    }
    const card = chat.locator('.pm-chat-current [data-mark-id]');
    await card.waitFor(); assert.equal(await card.getAttribute('data-mark-id'), a.markId);
    const sheet = await page.locator('.ProseMirror').boundingBox(); assert(sheet && sheet.width <= 832.1);
    if (width >= 1024) {
      const left = (await chat.boundingBox())!; const right = (await marks.boundingBox())!;
      assert.equal(Math.round(left.width), 360); assert.equal(Math.round(right.width), 288);
      assert(Math.abs(sheet.x + sheet.width / 2 - (left.x + left.width + right.x) / 2) < 3, 'Sheet centered between columns');
    }
    await page.screenshot({ path: `/tmp/proof-u2-layout-${width}.png`, fullPage: false });
    await page.getByLabel('Go to the next mark after I decide').uncheck();
    await chat.getByRole('button', { name: 'Accept (A)', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('Paragraph twelve is clearer.'));
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('Paragraph 12 has something worth reading.'));
    if (width < 1024) {
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /^Marks \(/ }).click();
      await page.locator(`[data-review-row="${a.markId}"]`).click();
      await page.getByRole('button', { name: 'Verso', exact: true }).click();
    } else await page.locator(`.ProseMirror [data-mark-id="${a.markId}"]`).first().click();
    await chat.getByRole('textbox', { name: 'Message Verso', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('Paragraph twelve is clearer.'));
    await page.keyboard.press('Escape'); assert(!(await chat.isVisible()));
    await page.getByRole('button', { name: 'Verso', exact: true }).click();
    await page.keyboard.press('Escape');
    if (!(await marks.isVisible())) await page.getByRole('button', { name: /^Marks \(/ }).click();
    await marks.locator('button').first().focus(); await page.keyboard.press('Escape'); assert(!(await marks.isVisible()));
    assert.equal(await page.locator('.pm-panel-backdrop').count(), 0);
    await page.getByRole('button', { name: 'Verso', exact: true }).click();
    await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
    await page.waitForTimeout(1200); assert.equal(await chat.locator('.pm-chat-current [data-mark-id]').count(), 0, 'programmatic scroll never dwells');
    await page.evaluate(() => { document.querySelector('.ProseMirror [data-mark-id]')?.scrollIntoView({ block: 'center' }); });
    await page.mouse.move(width < 768 ? width - 5 : width / 2, 400); await page.mouse.wheel(0, 1);
    await page.waitForTimeout(650); await page.mouse.wheel(0, 1);
    await page.waitForTimeout(650); assert.equal(await chat.locator('.pm-chat-current [data-mark-id]').count(), 0, 'input restarts dwell');
    await chat.locator('.pm-chat-current [data-mark-id]').waitFor();
    assert.equal(await chat.locator('.pm-chat-current [data-mark-id]').count(), 1);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(100); assert.equal(await chat.locator('.pm-chat-current [data-mark-id]').count(), 0, 'offscreen clears slot');
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `/tmp/proof-u2-sheet-${width}.png`, fullPage: false });
    await page.context().close(); console.log(`✓ layout, cards, history, dwell and panels at ${width}px`);
  }
});
process.exit(0);
