import assert from 'node:assert/strict';
import { withBrowser } from './u2-browser-harness';
await withBrowser(async ({ browser, base, create, post }) => {
  const doc = await create('An example for review.');
  await post(doc, '/ops', { type: 'suggestion.add', kind: 'replace', quote: 'An example', content: 'The example', by: 'ai:Test' });
  const context = await browser.newContext();
  await context.route('**/*', (route: any) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on('response', (r: any) => { if (r.url().endsWith('/agent-keys')) console.log('agent-keys HTTP', r.status()); });
  await page.goto(`${base}/d/${doc.slug}`);
  const check = async (label: string) => {
    const blurred = await page.evaluate(() => [...document.querySelectorAll('*')].flatMap(el => [null, '::before', '::after', '::backdrop'].flatMap(pseudo => {
      const css = getComputedStyle(el, pseudo);
      return /blur/i.test(css.filter + css.backdropFilter + css.getPropertyValue('-webkit-backdrop-filter')) ? [el.tagName + '.' + el.className] : [];
    })));
    assert.deepEqual(blurred, [], label); console.log(`✓ no blur: ${label}`);
  };
  await page.getByPlaceholder('Your name').waitFor(); await check('name prompt');
  await page.getByRole('button', { name: 'Continue anonymously', exact: true }).click();
  await page.getByRole('button', { name: 'Add agent', exact: true }).click();
  await page.getByRole('dialog', { name: 'Add agent', exact: true }).waitFor(); await check('Add agent');
  await page.getByLabel('Agent name', { exact: true }).fill('Test AI');
  await page.getByRole('button', { name: 'Create agent key', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('dialog [data-status]')?.textContent === 'Key created. Copy the instructions to your AI.');
  const invitation = await page.getByLabel('Instructions to paste into your AI chat').inputValue();
  const key = invitation.match(/x-share-token: (\S+)/)?.[1]; assert(key);
  await page.getByRole('button', { name: 'Close agent dialog' }).click();
  const read = await fetch(`${base}/api/agent/${doc.slug}/state`, { headers: { 'x-share-token': key } }); assert.equal(read.status, 200);
  const agents = page.getByRole('button', { name: /Open agent actions/ });
  await agents.waitFor(); await agents.click(); await check('agent menu');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Share options', exact: true }).click(); await check('share menu');
  await page.keyboard.press('Escape');
  await page.locator('.pm-review-row').first().click(); await check('review and marks');
  await page.keyboard.press('Escape');
  await page.getByLabel('Review style', { exact: true }).selectOption('proof'); await check('Proof style');
  await context.close();
});
process.exit(0);
