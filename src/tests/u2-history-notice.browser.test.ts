import assert from 'node:assert/strict';
import { withBrowser, openEditor } from './u2-browser-harness';
await withBrowser(async ({ browser, base, create, post }) => {
  const doc = await create('Original sentence.');
  const suggestion = await post(doc, '/ops', { type: 'suggestion.add', kind: 'replace', quote: 'Original', content: 'Changed', by: 'ai:Test' });
  const alice = await openEditor(browser, `${base}/d/${doc.slug}`, 'Alice');
  const bob = await openEditor(browser, `${base}/d/${doc.slug}`, 'Bob');
  await alice.getByLabel('Go to the next mark after I decide').uncheck();
  await alice.locator(`[data-review-row="${suggestion.markId}"]`).click();
  await alice.getByRole('button', { name: 'Accept (A)', exact: true }).click();
  await bob.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('Changed'));
  await bob.getByRole('button', { name: /^Suggesting:/ }).click();
  await bob.evaluate(() => { const view = (window as any).proof.editor.ctx.get('editorView'); view.dispatch(view.state.tr.insertText('BOB', 4)); });
  await alice.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('BOB'));
  const message = "Can't undo: someone has changed this text since.";
  for (const style of ['playmaker', 'proof']) {
    await alice.getByLabel('Review style', { exact: true }).selectOption(style);
    // Verso's chat exists only in PlayMaker style.
    for (const open of style === 'playmaker' ? [true, false] : [false]) {
      const chat = alice.getByRole('complementary', { name: 'Verso chat' });
      if (style === 'proof') assert.equal(await alice.getByRole('button', { name: 'Verso', exact: true }).isVisible(), false, 'Proof style has no Verso button');
      else if (await chat.isVisible() !== open) await alice.getByRole('button', { name: 'Verso', exact: true }).click();
      assert.equal(await chat.isVisible(), open);
      await alice.locator('.ProseMirror').focus();
      await alice.keyboard.press('Control+z');
      const notice = alice.locator(open ? '.pm-chat-current [role="alert"]' : style === 'proof' ? '.review-history-notice' : '.pm-review-panel [role="alert"]');
      assert(await notice.isVisible(), `${style} ${open}: refusal must be visible`);
      assert.equal(await notice.innerText(), message);
      assert.equal(await alice.getByRole('alert').filter({ hasText: message }).count(), 1, `${style} ${open}: the refusal shows in one place only`);
      // Repeating or refreshing the panel must not duplicate the notice.
      await alice.keyboard.press('Control+z');
      assert.equal(await notice.count(), 1);
      if (style === 'playmaker') {
        await alice.getByRole('button', { name: 'People', exact: true }).click();
        assert.equal(await notice.count(), 1);
        await alice.getByRole('button', { name: 'Everyone', exact: true }).click();
      }
      assert.equal(await notice.innerText(), message);
      console.log(`PASS refusal visible once: ${style} chat ${open ? 'open' : 'collapsed'}`);
    }
  }
  // Successful history input clears the old refusal, including in the chat slot.
  await alice.getByLabel('Review style', { exact: true }).selectOption('playmaker');
  if (!await alice.locator('.pm-chat').isVisible()) await alice.getByRole('button', { name: 'Verso', exact: true }).click();
  await alice.getByRole('button', { name: /^Suggesting:/ }).click();
  await alice.locator('.ProseMirror').focus(); await alice.keyboard.press('End'); await alice.keyboard.type(' mine');
  await alice.keyboard.press('Control+z');
  assert.equal(await alice.locator('.pm-chat-current [role="alert"]').count(), 0);
  await alice.context().close(); await bob.context().close();
});
process.exit(0);
