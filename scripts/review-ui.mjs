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
  const control = page.locator('[data-accord-whole-toggle]');
  if (await control.isVisible() && await control.innerText() === 'Show the whole Accord') await control.click();
}
