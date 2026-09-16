import assert from 'node:assert/strict';
import { withBrowser, openEditor } from './u2-browser-harness';
await withBrowser(async ({ browser, base, create, post }) => {
  const doc = await create('An example for the reader.');
  await post(doc, '/marks/comment', { quote: 'An example', text: 'Can this be clearer?', by: 'human:Reader' });
  const page = await openEditor(browser, `${base}/d/${doc.slug}`, 'Reader');
  let sent: any;
  await page.route('**/verso', (route: any) => {
    sent = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reply: 'Here are two proposals.', proposals: [{ kind: 'suggestion', quote: 'An example', replacement: 'An illustration' }, { kind: 'comment', quote: 'the reader', text: 'Who is reading?' }] }) });
  });
  await page.locator('.pm-review-row').first().click();
  const before = await page.evaluate(() => (window as any).proof.getAllMarks().length);
  const chat = page.getByRole('complementary', { name: 'Verso chat' });
  await chat.getByRole('textbox', { name: 'Message Verso' }).fill('Suggest a change and a comment.'); await page.keyboard.press('Enter');
  await chat.getByText('Here are two proposals.', { exact: true }).waitFor();
  assert.equal(sent.mark.kind, 'comment'); assert.equal(sent.mark.quote, 'An example');
  assert.equal(sent.messages.at(-1).content, 'Suggest a change and a comment.');
  assert.equal(await page.evaluate(() => (window as any).proof.getAllMarks().length), before, 'A reply cannot mutate the document');
  let failures = 0;
  for (const [label, kind] of [['Suggest this change', 'replace'], ['Add this comment', 'comment']]) {
    if (process.argv[2] && process.argv[2] !== kind) continue;
    try {
    await chat.getByRole('button', { name: label, exact: true }).click();
    await page.waitForFunction((kind: string) => (window as any).proof.getAllMarks().some((m: any) => m.by === 'ai:verso' && m.kind === kind), kind);
    const applied = await page.evaluate(() => (window as any).proof.getAllMarks().filter((m: any) => m.by === 'ai:verso'));
    await page.keyboard.press('Control+z');
    assert.equal(await page.evaluate(() => (window as any).proof.getAllMarks().filter((m: any) => m.by === 'ai:verso').length), 0, `${kind}: one undo removes the clicked proposal`);
    await page.keyboard.press('Control+Shift+z');
    assert.deepEqual(await page.evaluate(() => (window as any).proof.getAllMarks().filter((m: any) => m.by === 'ai:verso')), applied, `${kind}: redo restores the same attributed proposal`);
    await page.keyboard.press('Control+z');
    console.log(`PASS clicked Verso ${kind}`);
    } catch (error) { failures++; console.error(`FAIL clicked Verso ${kind}: ${(error as Error).message}`); }
  }
  // The same public API called without a proposal click must stay outside history.
  const depth = await page.evaluate(() => (window as any).proof.getReviewDecisionHistory().manager.undoStack.length);
  await page.evaluate(() => (window as any).proof.markComment('the reader', 'ai:verso', 'Direct API comment'));
  assert.equal(await page.evaluate(() => (window as any).proof.getReviewDecisionHistory().manager.undoStack.length), depth);
  await post(doc, '/marks/comment', { quote: 'An example', text: 'Endpoint comment', by: 'ai:verso' });
  assert.equal(await page.evaluate(() => (window as any).proof.getReviewDecisionHistory().manager.undoStack.length), depth);
  await page.context().close();
  assert.equal(failures, 0);
  console.log('✓ mark context travels with chat; only human clicks add attributed, undoable proposals');
});
process.exit(0);
