// Shared browser adapter for the Review panel. No document or mark writes.
export async function showReview(page) {
  const toggle = page.locator('[data-accord-review-toggle]');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await page.locator('.anv-tab[data-tab="issues"]').click();
}
export async function nextReview(page) {
  await showReview(page);
  await page.locator('.anv-next').click();
}

// Existing behaviour checks deliberately choose full context before exercising their feature.
// Arrival and persistence assertions live in folded-view-check; this clicks the real control.
export async function showWholeAccord(page) {
  await page.waitForFunction(() => window.__proofFolding?.debugState().ready, null, { timeout: 15000 });
  if (await page.evaluate(() => window.__proofFolding.debugState().whole === true)) return;
  // A first-visit guest sees the name prompt over the page; its checks read identity, not the
  // whole text, and clicking through a dialog is not something a person can do.
  if (await page.locator('[data-proof-name-prompt="overlay"]').isVisible().catch(() => false)) return;
  // Wait for the control: an isVisible() read races the count line's first render, and a skipped
  // click left the caller measuring a folded page (caret-stability typed into the title).
  const control = page.locator('[data-accord-whole-toggle]');
  await control.waitFor({ state: 'visible', timeout: 15000 });
  if ((await control.innerText()).trim() === 'Show the whole Accord') await control.click();
  // Then wait until the whole view is applied and laid out before the caller measures or clicks.
  await page.waitForFunction(() => window.__proofFolding?.debugState().whole === true, null, { timeout: 15000 });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}
