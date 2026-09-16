import assert from 'node:assert/strict';
import { withBrowser, openEditor } from './u2-browser-harness';
let failures = 0;
await withBrowser(async ({ browser, base, create, post }) => {
  for (const decision of ['insert', 'replace']) for (const redo of [false, true]) for (const change of ['insert', 'delete', 'comment']) {
    const label = `${decision} ${redo ? 'redo' : 'undo'} ${change}`;
    if (process.argv[2] && !label.includes(process.argv[2])) continue;
    const doc = await create('Original sentence. Another paragraph.');
    const suggestion = await post(doc, '/ops', { type: 'suggestion.add', kind: decision, quote: 'Original sentence.', content: decision === 'insert' ? ' added word' : 'Changed wording.', by: 'ai:Test' });
    const alice = await openEditor(browser, `${base}/d/${doc.slug}`, 'Alice');
    const bob = await openEditor(browser, `${base}/d/${doc.slug}`, 'Bob');
    try {
      await alice.getByLabel('Go to the next mark after I decide').uncheck();
      await alice.locator(`[data-review-row="${suggestion.markId}"]`).click();
      await alice.getByRole('button', { name: 'Accept (A)', exact: true }).click();
      await alice.locator(`.pm-settled[data-review-row="${suggestion.markId}"]`).waitFor();
      await bob.waitForFunction((id: string) => !(window as any).proof.getAllMarks().some((m: any) => m.id === id), suggestion.markId);
      if (redo) { await alice.locator('.ProseMirror').focus(); await alice.keyboard.press('Control+z'); }
      await bob.waitForFunction(({ id, redo }: any) => (window as any).proof.getAllMarks().some((m: any) => m.id === id) === redo, { id: suggestion.markId, redo });
      const aliceText = await alice.evaluate(() => (window as any).proof.editor.ctx.get('editorView').state.doc.textContent);
      if (change === 'delete' && redo) {
        // After Alice's undo, a pending suggestion covers the whole range, and the API
        // refuses a deletion that overlaps it. Bob deletes with the keyboard instead.
        await bob.getByRole('button', { name: /^Suggesting:/ }).click();
        await bob.locator('.ProseMirror').focus();
        await bob.evaluate((at: number) => {
          const view = (window as any).proof.editor.ctx.get('editorView');
          view.dispatch(view.state.tr.setSelection(view.state.selection.constructor.near(view.state.doc.resolve(at))));
        }, decision === 'insert' ? 26 : 8);
        await bob.keyboard.press('Backspace');
        await alice.waitForFunction((text: string) => {
          const proof = (window as any).proof;
          return proof.editor.ctx.get('editorView').state.doc.textContent !== text
            || proof.getAllMarks().some((m: any) => m.by === 'human:Bob' && m.kind === 'delete');
        }, aliceText);
      } else await bob.evaluate(({ change, decision, redo }: any) => {
        const proof = (window as any).proof, view = proof.editor.ctx.get('editorView');
        const at = decision === 'insert' ? 21 : 4;

        if (change === 'insert') view.dispatch(view.state.tr.insertText('BOB', at));
        if (change === 'delete') {
          const quote = decision === 'insert' ? 'word' : 'wording';
          const from = view.state.doc.textContent.indexOf(quote) + 1;
          if (!proof.markSuggestDelete(quote, 'human:Bob', { from, to: from + quote.length })) throw new Error('Fixture must create a pending deletion');
        }
        if (change === 'comment') proof.markCommentSelector({ range: { from: at, to: at + 1 } }, 'human:Bob', 'Bob comment');
      }, { change, decision, redo });
      if (!(change === 'delete' && redo)) await alice.waitForFunction((kind: string) => (window as any).proof.getAllMarks().some((m: any) => m.by === 'human:Bob' && m.kind === kind), change);
      const snapshot = async (page: any) => page.evaluate(() => {
        const proof = (window as any).proof, h = proof.getReviewDecisionHistory();
        return JSON.stringify([proof.editor.ctx.get('editorView').state.doc.toJSON(), h.doc.getMap('marks').toJSON(), h.manager.undoStack.length, h.manager.redoStack.length, h.manager.lastChange]);
      });
      const before = [await snapshot(alice), await snapshot(bob)];
      await alice.locator('.ProseMirror').focus();
      await alice.keyboard.press(redo ? 'Control+Shift+z' : 'Control+z');
      await alice.waitForTimeout(100);
      const notice = alice.locator('.pm-chat-current [role="alert"]');
      assert(await notice.isVisible(), 'Show the usual refusal beside the chat mark slot');
      assert.equal(await notice.innerText(), `Can't ${redo ? 'redo' : 'undo'}: someone has changed this text since.`);
      assert.deepEqual([await snapshot(alice), await snapshot(bob)], before, 'Both connected documents and both histories remain unchanged');
      console.log(`PASS connected pending mark ${label}`);
    } catch (error) { failures++; console.error(`FAIL connected pending mark ${label}: ${(error as Error).message.split('\n')[0]}`); }
    finally { await alice.context().close(); await bob.context().close(); }
  }
});
assert.equal(failures, 0);
process.exit(0);
