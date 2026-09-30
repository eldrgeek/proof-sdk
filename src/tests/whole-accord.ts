/**
 * Since Accord step 2 (2026-09-25) every visit opens the folded view: the title, the top-level
 * headings and the open items. In a document with no open items every other line is hidden, and
 * a hidden line takes no caret and no typing; a document with nothing shown is not editable at
 * all. A browser suite whose scenario needs the whole text does what a person does first: it
 * clicks "Show the whole Accord". Arrival and folding are tested in scripts/folded-view-check.mjs.
 */
export async function showWholeAccord(page: any): Promise<void> {
  await page.waitForFunction(() => (window as any).__proofFolding?.debugState?.().ready === true, null, { timeout: 30_000 });
  if (await page.evaluate(() => (window as any).__proofFolding.debugState().whole === true)) return;
  await page.locator('[data-accord-whole-toggle]').click();
  await page.waitForFunction(() => (window as any).__proofFolding.debugState().whole === true, null, { timeout: 15_000 });
}
