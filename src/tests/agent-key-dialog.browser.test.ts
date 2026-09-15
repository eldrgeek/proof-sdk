import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';

const base = process.env.SHARE_BASE_URL || 'http://127.0.0.1:44191';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Browser test requires a local server');
const response = await fetch(`${base}/api/documents`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Proof-Client-Version': '0.31.0',
    'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' },
  body: JSON.stringify({ markdown: '# Browser key test\n\nHello agent.', title: 'Browser key test' }),
});
assert.equal(response.status, 200);
const created = await response.json() as { slug: string; accessToken: string };
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  await context.route('**/*', route => new URL(route.request().url()).origin === base
    ? route.continue() : route.abort());
  // Production serves build assets through its front proxy; keep this local harness self-contained.
  await context.route('**/assets/**', route => route.fulfill({ path: path.resolve('dist', new URL(route.request().url()).pathname.slice(1)) }));
  const page = await context.newPage();
  let polls = 0;
  let mints = 0;
  const requestUrls: string[] = [];
  page.on('request', request => {
    requestUrls.push(request.url());
    if (request.url().includes('/events/pending')) polls++;
    if (request.method() === 'POST' && request.url().endsWith('/agent-keys')) mints++;
  });
  await page.goto(`${base}/d/${created.slug}`);
  await page.getByRole('button', { name: 'Continue anonymously', exact: true }).click();
  await page.getByRole('button', { name: 'Add agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add agent', exact: true });
  await dialog.waitFor();
  assert.equal(mints, 0, 'Opening the dialog should wait for the person to request a key');
  await dialog.getByLabel('Agent name', { exact: true }).fill('Browser assistant');
  await dialog.getByRole('button', { name: 'Create agent key', exact: true }).click();
  const instructions = dialog.getByLabel('Instructions to paste into your AI chat');
  await instructions.waitFor({ state: 'visible' });
  const message = await instructions.inputValue();
  const key = message.match(/x-share-token: (\S+)/)?.[1];
  assert.ok(key && key.length > 20, 'Invitation must include a real credential');
  assert.ok(!message.includes('<token-from-doc-url>'), 'Invitation must not contain a placeholder');
  assert.ok(!message.includes('?token='), 'Invitation must keep keys out of URLs');
  assert.ok(!requestUrls.some(url => url.includes(key!)), 'Minted key must never appear in a request URL');
  assert.equal(mints, 1);
  await dialog.getByRole('button', { name: 'Copy instructions', exact: true }).click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(clipboard === message, 'Copy must contain the exact displayed instructions');
  const state = await fetch(`${base}/api/agent/${created.slug}/state`, { headers: { 'x-share-token': key! } });
  assert.equal(state.status, 200);
  await dialog.getByRole('button', { name: 'Close agent dialog' }).click();
  await page.getByRole('button', { name: 'Add agent', exact: true }).click();
  await dialog.getByRole('button', { name: 'Revoke Browser assistant', exact: true }).waitFor();
  assert.ok(!((await dialog.textContent()) || '').includes(key!), 'Reopening must not recover the secret');
  await dialog.getByRole('button', { name: 'Revoke Browser assistant', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-status]')?.textContent === 'Agent key revoked.');
  const revoked = await fetch(`${base}/api/agent/${created.slug}/state`, { headers: { 'x-share-token': key! } });
  assert.equal(revoked.status, 401);
  await page.screenshot({ path: '/tmp/proof-x1-agent-dialog.png' });
  await page.waitForTimeout(3500);
  assert.equal(polls, 0, 'A real tokenless editor page must not poll');
  console.log('✓ browser: tokenless editor, named key, displayed/copied invitation, key list, revocation, no credential URLs or polls');

  const retryContext = await browser.newContext();
  await retryContext.route('**/*', route => new URL(route.request().url()).origin === base
    ? route.continue() : route.abort());
  await retryContext.route('**/assets/**', route => route.fulfill({ path: path.resolve('dist', new URL(route.request().url()).pathname.slice(1)) }));
  const retryPage = await retryContext.newPage();
  const pollTimes: number[] = [];
  await retryPage.route('**/events/pending?**', route => {
    pollTimes.push(Date.now());
    return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Unauthorized' }) });
  });
  // This is the original page credential, not an agent key minted by the dialog.
  await retryPage.goto(`${base}/d/${created.slug}?token=${encodeURIComponent(created.accessToken)}`);
  await retryPage.getByRole('button', { name: 'Continue anonymously', exact: true }).click();
  await retryPage.getByRole('button', { name: 'Add agent', exact: true }).waitFor();
  await retryPage.waitForTimeout(16_000);
  assert.equal(pollTimes.length, 3);
  assert.ok(pollTimes[1] - pollTimes[0] >= 2800, 'First retry must back off');
  assert.ok(pollTimes[2] - pollTimes[1] >= 5800, 'Second retry must double the backoff');
  console.log('✓ browser: repeated 401s stop after three polls with exponential backoff');
} finally {
  await browser.close();
}
