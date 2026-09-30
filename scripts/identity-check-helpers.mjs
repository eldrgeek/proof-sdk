// Exercise the page's comment composer and verify its server attribution.
import assert from 'node:assert/strict';
export async function attributedComment(page, slug, line, text, actor, headers) {
  await page.keyboard.press('Escape');
  await page.evaluate(i => { window.__proofReadingWalk.focusLine(i); window.__proofReadingWalk.startThreadHere(); }, line);
  const form = page.locator('.amg-thread-new');
  await form.locator('.amg-thread-text-input').fill(text);
  await form.locator('.amg-thread-send').click();
  await page.waitForFunction(t => window.__proofLineMarks.allThreads().some(v => v.thread.text === t), text);
  const read = () => page.evaluate(async ({ slug, headers }) => {
    const r = await fetch(`/api/documents/${slug}/line-marks`, { headers });
    return r.json();
  }, { slug, headers });
  // Thread storage is the comment's canonical record, with identity supplied by the session.
  let body;
  for (let i = 0; i < 40; i++) {
    body = await read();
    if (body.threads?.some(t => (t.thread ?? t).text === text && (t.thread ?? t).by === actor)) return;
    await page.waitForTimeout(150);
  }
  assert.fail(`Comment was not attributed to ${actor}: ${JSON.stringify(body)}`);
}
