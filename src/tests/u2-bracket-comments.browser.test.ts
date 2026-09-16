import assert from 'node:assert/strict';
import { withBrowser, openEditor } from './u2-browser-harness';
await withBrowser(async ({ browser, base, create }) => {
  let failures = 0;
  for (const input of ['typing', 'paste', 'api']) {
    if (process.argv[2] && process.argv[2] !== input) continue;
    const doc = await create('First sentence. Second sentence. Last sentence.');
    const page = await openEditor(browser, `${base}/d/${doc.slug}`, 'Reader');
    try {
      await page.getByRole('button', { name: /^Suggesting:/ }).click();
      await page.locator('.ProseMirror p').click();
      await page.keyboard.press('Home');
      for (let i = 0; i < 22; i++) await page.keyboard.press('ArrowRight');
      await page.evaluate(() => (window as any).proof.getReviewDecisionHistory().manager.clear());
      const original = await page.locator('.ProseMirror').textContent();
      await page.evaluate(() => {
        const proof = (window as any).proof, view = proof.editor.ctx.get('editorView');
        const dispatch = view.dispatch.bind(view);
        view.dispatch = (tr: any) => {
          dispatch(tr);
          const text = view.state.doc.textContent;
          if (text.includes('[[Please explain.]]') && !proof.literalBeforeConversion) proof.literalBeforeConversion = text;
        };
      });
      if (input === 'typing') await page.keyboard.type('[[Please explain.]]');
      else if (input === 'paste') await page.locator('.ProseMirror').evaluate((element: HTMLElement) => {
        const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', '[[Please explain.]]');
        element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
      });
      else await page.evaluate(() => (window as any).proof.insertAtCursor('API sentence [[Please explain.]].', 'ai:API'));
      await page.waitForFunction(() => (window as any).proof.getAllMarks().some((m: any) => m.kind === 'comment' && m.data.text === 'Please explain.'));
      const converted = await page.locator('.ProseMirror').textContent();
      assert(!converted!.includes('[['));
      const comment = await page.evaluate(() => (window as any).proof.getAllMarks().find((m: any) => m.kind === 'comment'));
      if (input === 'api') {
        assert.equal(comment.by, 'ai:API');
        assert.equal(await page.evaluate(() => (window as any).proof.getReviewDecisionHistory().manager.undoStack.length), 0, 'API insertion and conversion create no human undo entry');
        await page.keyboard.press('Control+z');
        assert.equal(await page.locator('.ProseMirror').textContent(), converted);
      } else {
        if (input === 'typing') assert.equal(comment.quote, 'Second sentence.');
        else assert(original!.includes(comment.quote), 'Paste anchors to surrounding text');
        assert.equal(comment.by, 'human:Reader');
        assert((await page.getByRole('complementary', { name: 'Marks', exact: true }).innerText()).includes('◆'));
        await page.keyboard.press('Control+z');
        const restored = await page.locator('.ProseMirror').textContent();
        assert.equal(restored, await page.evaluate(() => (window as any).proof.literalBeforeConversion), 'One undo restores exactly the input text');
        assert(restored!.includes('[[Please explain.]]'));
        assert.equal(await page.evaluate(() => (window as any).proof.getAllMarks().filter((m: any) => m.kind === 'comment').length), 0);
        await page.waitForTimeout(200);
        assert.equal(await page.locator('.ProseMirror').textContent(), restored, 'Undo must not immediately reconvert');
        await page.keyboard.press('Control+Shift+z');
        assert.equal(await page.locator('.ProseMirror').textContent(), converted, 'One redo converts again');
        assert.equal(await page.evaluate(() => (window as any).proof.getAllMarks().filter((m: any) => m.kind === 'comment').length), 1);
      }
      console.log(`PASS bracket ${input}`);
    } catch (error) { failures++; console.error(`FAIL bracket ${input}: ${(error as Error).message}`); }
    finally { await page.context().close(); }
  }
  // A fresh page tests literal escapes through real typing and reload.
  const literal = await create('Literal examples: ');
  const other = await openEditor(browser, `${base}/d/${literal.slug}`, 'Reader');
  await other.getByRole('button', { name: /^Suggesting:/ }).click();
  await other.locator('.ProseMirror p').click(); await other.keyboard.press('End');
  await other.keyboard.type(String.raw` \[[literal\]]`);
  await other.waitForTimeout(800);
  assert((await other.locator('.ProseMirror').innerText()).includes('[[literal]]'));
  assert(!(await other.locator('.ProseMirror').innerText()).includes('\\'));
  const markdown = await other.evaluate(() => (window as any).proof.getMarkdownSnapshot().content);
  assert(markdown.includes(String.raw`\[[`)); assert(markdown.includes(String.raw`\]]`));
  await other.reload(); await other.waitForFunction(() => (window as any).proof?.getAllMarks);
  assert.equal(await other.evaluate(() => (window as any).proof.getAllMarks().filter((m: any) => m.kind === 'comment').length), 0);
  assert((await other.locator('.ProseMirror').innerText()).includes('[[literal]]'));
  await other.context().close();
  assert.equal(failures, 0);
  console.log('✓ typed comments, mark panel, one-step undo, and literal escapes through reload');
});
process.exit(0);
