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
