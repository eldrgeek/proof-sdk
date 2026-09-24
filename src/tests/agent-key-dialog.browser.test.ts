import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(process.env.PROOF_PLAYWRIGHT_PACKAGE_JSON || import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');

async function startLocalServer(): Promise<{ base: string; stop: () => Promise<void> }> {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const temp = mkdtempSync(path.join(tmpdir(), 'proof-agent-dialog-'));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  // Run the production entry point with isolated storage and no inherited service credentials.
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      PORT: String(port), COLLAB_EMBEDDED_WS: '1',
      DATABASE_PATH: path.join(temp, 'test.db'), SNAPSHOT_DIR: path.join(temp, 'snapshots'),
    },
    stdio: 'ignore',
  });
  let exited = false;
  const closed = new Promise<void>(resolve => child.once('close', () => { exited = true; resolve(); }));
  let startupFailed = false;
  child.once('error', () => { startupFailed = true; });
  const stop = async () => {
    if (!exited) {
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
      try { await closed; } finally { clearTimeout(force); }
    }
    rmSync(temp, { recursive: true, force: true });
  };
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      assert.ok(!startupFailed && !exited, 'Local browser-test server must start');
      const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) }).catch(() => null);
      if (health?.ok) {
        const body = await health.json() as { collab: { enabled: boolean } };
        assert.equal(body.collab.enabled, true, 'Owned server must start collaboration');
        return { base, stop };
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Local browser-test server readiness timed out');
  } catch (error) {
    await stop();
    throw error;
  }
}

const revocationNote = 'Revoking stops that key from working. While this document can be opened from its link without signing in, anyone who has the link can still edit it.';
const clientHeaders = {
  'X-Proof-Client-Version': '0.33.0',
  'X-Proof-Client-Build': 'test',
  'X-Proof-Client-Protocol': '3',
};

async function testDialog(base: string, ownsServer: boolean): Promise<void> {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Browser test requires a local server');
  const createDocument = async () => {
    const response = await fetch(`${base}/api/documents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...clientHeaders },
      body: JSON.stringify({ markdown: '# Browser key test\n\nHello agent.', title: 'Browser key test' }),
    });
    assert.equal(response.status, 200);
    return await response.json() as { slug: string; accessToken: string };
  };
  const browser = await chromium.launch({ headless: true });
  try {
    // X1e uses the owned embedded server and two simultaneously open pages.
    if (ownsServer) {
      const created = await createDocument();
      const context = await browser.newContext();
      await context.route('**/*', route => new URL(route.request().url()).origin === base
        ? route.continue() : route.abort());
      const pages = [await context.newPage(), await context.newPage()];
      for (const page of pages) {
        await page.goto(`${base}/d/${created.slug}`);
        const anonymous = page.getByRole('button', { name: 'Continue anonymously', exact: true });
        if (page === pages[0]) await anonymous.click();
        await page.getByRole('button', { name: 'Add agent', exact: true }).waitFor();
      }
      const page = pages[0];
      await page.getByRole('button', { name: 'Add agent', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Add agent', exact: true });
      const keys: string[] = [];
      for (const name of ['Key A', 'Key B']) {
        await dialog.getByLabel('Agent name', { exact: true }).fill(name);
        await dialog.getByRole('button', { name: 'Create agent key', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[data-status]')?.textContent === 'Key created. Copy the instructions to your AI.');
        const invitation = await dialog.getByLabel('Instructions to paste into your AI chat').inputValue();
        const key = invitation.match(/x-share-token: (\S+)/)?.[1];
        assert.ok(key, 'Created invitation must include a credential');
        keys.push(key);
      }
      await dialog.getByRole('button', { name: 'Close agent dialog' }).click();
      for (const key of keys) {
        const read = await fetch(`${base}/api/agent/${created.slug}/state`, { headers: { 'x-share-token': key } });
        assert.equal(read.status, 200);
      }
      for (const openPage of pages) {
        await openPage.waitForFunction(() => document.querySelectorAll('.share-pill-agent-face').length === 2);
      }
      await page.locator('.share-pill-agent-trigger').click();
      await page.getByRole('menuitem', { name: 'Add agent / manage keys', exact: true }).click();
      for (const [name, remaining] of [['Key A', 1], ['Key B', 0]] as const) {
        await dialog.getByRole('button', { name: `Revoke ${name}`, exact: true }).click();
        // Start both page deadlines together: each must update within five seconds.
        await Promise.all(pages.map(openPage => openPage.waitForFunction(
          count => document.querySelectorAll('.share-pill-agent-face').length === count
            && (count !== 0 || document.querySelector('.share-pill-agent-trigger')?.getAttribute('aria-label') === 'Add agent'),
          remaining, { timeout: 5_000 },
        )));
      }
      await dialog.getByRole('button', { name: 'Close agent dialog' }).click();
      for (const openPage of pages) {
        await openPage.getByRole('button', { name: 'Add agent', exact: true }).waitFor({ timeout: 5_000 });
        await openPage.reload();
        await openPage.waitForFunction(() => (window as any).proof?.collabConnectionStatus === 'connected' && (window as any).proof?.collabIsSynced === true);
        await openPage.getByRole('button', { name: 'Add agent', exact: true }).waitFor({ timeout: 5_000 });
        assert.equal(await openPage.locator('.share-pill-agent-face').count(), 0);
      }
      await context.close();
      console.log('✓ X1e: two keys read; dialog revocation updates both pages within five seconds; last AI restores Add agent through reload');
    }
    for (const width of [1280, 400]) {
      // Each viewport scenario gets an independent document.
      const created = await createDocument();
      const sessionResponse = await fetch(`${base}/api/documents/${created.slug}/collab-session`, { headers: clientHeaders });
      assert.equal(sessionResponse.status, 200);
      const sessionBody = await sessionResponse.json() as { session?: { collabWsUrl: string } };
      const embedded = Boolean(sessionBody.session
        && new URL(sessionBody.session.collabWsUrl).host === new URL(base).host);
      if (ownsServer) assert.equal(embedded, true, 'Owned server must advertise embedded collaboration');
      const context = await browser.newContext({ viewport: { width, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
      await context.route('**/*', route => new URL(route.request().url()).origin === base
        ? route.continue() : route.abort());
      const page = await context.newPage();
      let polls = 0;
      let mints = 0;
      const requestUrls: string[] = [];
      page.on('request', request => {
        requestUrls.push(request.url());
        if (request.url().includes('/events/pending')) polls++;
        if (request.method() === 'POST' && request.url().endsWith('/agent-keys')) mints++;
      });
      const entryResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/assets/editor.js');
      const navigation = await page.goto(`${base}/d/${created.slug}`);
      assert.equal(navigation?.status(), 200, 'The share page must load');
      assert.equal((await entryResponse).status(), 200, 'The local server must serve the editor bundle');
      await page.getByRole('button', { name: 'Continue anonymously', exact: true }).click();
      const addAgent = page.getByRole('button', { name: 'Add agent', exact: true });
      // Phones (700px and narrower) keep Add agent in the bar's overflow menu.
      const phone = width <= 700;
      const openFromOverflow = async () => {
        await page.getByRole('button', { name: 'More options', exact: true }).click();
        await page.getByRole('menuitem', { name: /Add agent/ }).click();
      };
      if (phone) {
        await page.getByRole('button', { name: 'More options', exact: true }).waitFor({ state: 'visible' });
        const bounds = await page.getByRole('button', { name: 'More options', exact: true }).boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, `More options must fit at ${width}px`);
        await openFromOverflow();
      } else {
        await addAgent.waitFor({ state: 'visible' });
        const bounds = await addAgent.boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, `Add agent must fit at ${width}px`);
        assert.equal(await addAgent.isEnabled(), true);
        await addAgent.click();
      }
      const dialog = page.getByRole('dialog', { name: 'Add agent', exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.locator('[data-keys] + [data-revocation-note]').textContent(), revocationNote);
      assert.equal(await dialog.getByText(revocationNote, { exact: true }).isVisible(), true);
      assert.equal(mints, 0, 'Opening the dialog should wait for the person to request a key');
      await dialog.getByLabel('Agent name', { exact: true }).fill(`Browser assistant ${width}`);
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
      if (phone) {
        await openFromOverflow();
      } else if (embedded) {
        const activeAgent = page.getByRole('button', {
          name: 'AI collaborator — active now. Open agent actions', exact: true,
        });
        await activeAgent.waitFor({ state: 'visible' });
        assert.equal(await addAgent.count(), 0, 'Active AI replaces the Add agent button');
        await activeAgent.click();
        await page.getByRole('menuitem', { name: 'Add agent / manage keys', exact: true }).click();
      } else {
        await addAgent.click();
      }
      await dialog.getByRole('button', { name: `Revoke Browser assistant ${width}`, exact: true }).waitFor();
      assert.ok(!((await dialog.textContent()) || '').includes(key!), 'Reopening must not recover the secret');
      await dialog.getByRole('button', { name: `Revoke Browser assistant ${width}`, exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-status]')?.textContent === 'Agent key revoked.');
      const revoked = await fetch(`${base}/api/agent/${created.slug}/state`, { headers: { 'x-share-token': key! } });
      assert.equal(revoked.status, 401);
      await page.screenshot({ path: `/tmp/proof-x1d-agent-dialog-${embedded ? 'embedded' : 'external'}-${width}.png` });
      await page.waitForTimeout(3500);
      assert.equal(polls, 0, 'A real tokenless editor page must not poll');
      console.log(`✓ browser at ${width}px (${embedded ? 'embedded collaboration, active AI menu' : 'no embedded collaboration, Add agent button'}): tokenless editor, named key, displayed/copied invitation, key list, revocation, no credential URLs or polls`);
      await context.close();
    }

    // Exercise the server's existing member marker (its real session injection is
    // covered by library.test.ts). A display name alone must not hide the note.
    const memberDocument = await createDocument();
    const memberContext = await browser.newContext();
    await memberContext.route('**/*', route => new URL(route.request().url()).origin === base
      ? route.continue() : route.abort());
    await memberContext.addInitScript(() => {
      window.__PROOF_LIBRARY_MEMBER__ = { name: 'Signed-in member' };
    });
    const memberPage = await memberContext.newPage();
    await memberPage.goto(`${base}/d/${memberDocument.slug}`);
    await memberPage.getByRole('button', { name: 'Add agent', exact: true }).click();
    const memberDialog = memberPage.getByRole('dialog', { name: 'Add agent', exact: true });
    await memberDialog.waitFor();
    assert.equal(await memberDialog.locator('[data-revocation-note]').count(), 0);
    await memberContext.close();
    console.log('✓ browser: signed-in member marker hides the anonymous-link revocation note');

    const retryDocument = await createDocument();
    const retryContext = await browser.newContext();
    await retryContext.route('**/*', route => new URL(route.request().url()).origin === base
      ? route.continue() : route.abort());
    const retryPage = await retryContext.newPage();
    const pollTimes: number[] = [];
    await retryPage.route('**/events/pending?**', route => {
      pollTimes.push(Date.now());
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Unauthorized' }) });
    });
    // This is the original page credential, not an agent key minted by the dialog.
    await retryPage.goto(`${base}/d/${retryDocument.slug}?token=${encodeURIComponent(retryDocument.accessToken)}`);
    await retryPage.getByRole('button', { name: 'Continue anonymously', exact: true }).click();
    await retryPage.getByRole('button', { name: 'Add agent', exact: true }).waitFor();
    await retryPage.waitForTimeout(16_000);
    assert.equal(pollTimes.length, 3);
    assert.ok(pollTimes[1] - pollTimes[0] >= 2800, 'First retry must back off');
    assert.ok(pollTimes[2] - pollTimes[1] >= 5800, 'Second retry must double the backoff');
    await retryContext.close();
    console.log('✓ browser: repeated 401s stop after three polls with exponential backoff');
  } finally {
    await browser.close();
  }
}

const local = process.env.SHARE_BASE_URL ? null : await startLocalServer();
try {
  await testDialog(new URL(process.env.SHARE_BASE_URL || local!.base).origin, local !== null);
} finally {
  await local?.stop();
}
