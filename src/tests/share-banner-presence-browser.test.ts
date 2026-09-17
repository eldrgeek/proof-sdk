import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocketServer } from 'ws';
const { chromium } = createRequire(import.meta.url)('playwright');
const CLIENT_HEADERS = { 'X-Proof-Client-Version': '0.31.2', 'X-Proof-Client-Build': 'u1-browser-test', 'X-Proof-Client-Protocol': '3' };
async function mustJson(response: Response): Promise<any> {
  const body = await response.text();
  assert(response.ok, `HTTP ${response.status}: ${body}`);
  return JSON.parse(body);
}
async function openEditor(browser: any, url: string, name: string): Promise<any> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // This test uses only the local server, including all browser requests.
  await context.route('**/*', (route: any) => {
    const target = new URL(route.request().url());
    return target.hostname === '127.0.0.1' || target.hostname === 'localhost' ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  await page.addInitScript((slug: string) => sessionStorage.setItem(`proof_share_welcome_${slug}`, '1'), new URL(url).pathname.split('/').pop());
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true');
  const nameInput = page.getByPlaceholder('Your name');
  if (await nameInput.isVisible()) {
    await nameInput.fill(name);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await nameInput.waitFor({ state: 'hidden' });
  }
  return page;
}
async function run(): Promise<void> {
  const root = process.cwd();
  const dbPath = path.join(
    os.tmpdir(),
    `proof-share-banner-presence-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';
  delete process.env.AGENT_PRESENCE_TTL_MS;

  const [
    { apiRoutes },
    { agentRoutes },
    { setupWebSocket },
    collab,
    { shareWebRoutes },
    { createBridgeMountRouter },
    { enforceApiClientCompatibility, enforceBridgeClientCompatibility },
  ] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
    import('../../server/share-web-routes.js'),
    import('../../server/bridge.js'),
    import('../../server/client-capabilities.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/assets', express.static(path.join(root, 'dist', 'assets')));
  app.use(express.static(path.join(root, 'public')));
  app.use('/api', enforceApiClientCompatibility, apiRoutes);
  app.use('/api/agent', agentRoutes);
  app.use(apiRoutes);
  app.use('/d', createBridgeMountRouter(enforceBridgeClientCompatibility));
  app.use('/documents', createBridgeMountRouter(enforceBridgeClientCompatibility));
  app.use('/documents', agentRoutes);
  app.use(shareWebRoutes);

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const httpBase = `http://127.0.0.1:${port}`;
  await collab.startCollabRuntimeEmbedded(port);

  let browser: any;
  try {
    browser = await chromium.launch();
    const artifacts = path.join(root, 'test-results', 'u1');
    mkdirSync(artifacts, { recursive: true });
    const created = await mustJson(await fetch(`${httpBase}/api/documents`, {
      method: 'POST', headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'A shared document with a long title to check the larger top bar', markdown: '# Working together\n\nPresence stays visible while an agent works.\n', marks: {} }),
    }));
    const url = `${httpBase}/d/${created.slug}?token=${encodeURIComponent(created.accessToken)}`;
    const page = await openEditor(browser, url, 'Mike');
    await openEditor(browser, url, 'Eric');
    await openEditor(browser, url, 'Diana');
    await page.waitForFunction(() => document.querySelector('.share-pill-human-count')?.textContent === '2 here');
    const presence = async (status: string, agentId = 'ai:claude', name = 'Claude') => mustJson(await fetch(`${httpBase}/api/agent/${created.slug}/presence`, {
      method: 'POST', headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json', 'x-share-token': created.accessToken },
      body: JSON.stringify({ agentId, name, status }),
    }));
    // Install before presence creates its timeout so the clock owns the idle/TTL timers.
    await page.clock.install();
    await presence('editing');
    await presence('editing', 'ai:codex', 'Codex');
    await presence('editing', 'ai:gemini', 'Gemini');
    await page.locator('.share-pill-agent-face').first().waitFor();
    // Include the existing suggestion-count control without changing document content.
    await page.evaluate(() => {
      const count = document.querySelector<HTMLButtonElement>('.share-pill-suggestion-review')!;
      count.textContent = '12 suggestions';
      count.style.display = 'inline-flex';
    });
    const policy = await page.evaluate(() => (window as any).proof.getConnectedAgentEntries()[0]);
    assert.equal(Date.parse(policy.expiresAt) - Date.parse(policy.at), 900_000, 'Server default is 15 minutes');
    const human = page.locator('.share-pill-human-avatars .proof-avatar-wrap').first();
    await human.focus();
    await page.waitForTimeout(200);
    assert.match(await human.getAttribute('aria-label'), /Eric — (editing|viewing)/);
    assert.equal(await human.locator('.proof-avatar-tooltip').evaluate((el: HTMLElement) => getComputedStyle(el).opacity), '1');
    assert.equal(await human.locator('span').first().evaluate((el: HTMLElement) => el.getBoundingClientRect().width), 32);
    await human.hover();
    assert.equal(await human.locator('.proof-avatar-tooltip').evaluate((el: HTMLElement) => getComputedStyle(el).opacity), '1');
    await page.locator('.share-pill-title').focus();
    await page.mouse.move(0, 0);
    const measurements: any[] = [];
    for (const width of [1280, 400]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      const measured = await page.evaluate(() => {
        const bar = document.querySelector('#share-banner')!;
        const rect = bar.getBoundingClientRect();
        const targets = Array.from(bar.querySelectorAll('a, button, [role="button"]')).filter((el) => (el as HTMLElement).offsetWidth > 0);
        return {
          width: innerWidth, scrollWidth: document.documentElement.scrollWidth, bar: { left: rect.left, right: rect.right, height: rect.height },
          targets: targets.map((el) => { const r = el.getBoundingClientRect(); return { label: el.getAttribute('aria-label') || el.textContent, width: r.width, height: r.height, left: r.left, right: r.right }; }),
          contentTop: document.querySelector('.ProseMirror')!.getBoundingClientRect().top, barBottom: rect.bottom,
          faces: Array.from(bar.querySelectorAll('.share-pill-agent-face')).map((el) => el.getBoundingClientRect().width),
        };
      });
      measurements.push(measured);
      await page.screenshot({ path: path.join(artifacts, `bar-${width}.png`), fullPage: true });
      assert(measured.contentTop >= measured.barBottom, `Bar overlaps document: ${JSON.stringify(measured)}`);
      assert(measured.scrollWidth <= width, JSON.stringify(measured));
      assert(measured.bar.left >= 0 && measured.bar.right <= width, JSON.stringify(measured));
      for (const target of measured.targets) {
        assert(target.width >= 44 && target.height >= 44, `Small target: ${JSON.stringify(target)}`);
        assert(target.left >= measured.bar.left && target.right <= measured.bar.right, `Overflow: ${JSON.stringify(target)}`);
      }
      assert(measured.faces.every((size: number) => size >= 32));
      if (width === 400) {
        await page.locator('.share-pill-human-count').click();
        await page.getByRole('menuitem').filter({ hasText: 'Eric' }).waitFor();
        await page.screenshot({ path: path.join(artifacts, 'bar-400-people.png'), fullPage: true });
        await page.keyboard.press('Escape');
      }
    }
    writeFileSync(path.join(artifacts, 'bar-measurements.json'), JSON.stringify(measurements, null, 2));
    await presence('left', 'ai:codex', 'Codex');
    await presence('left', 'ai:gemini', 'Gemini');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.clock.fastForward(61_000);
    await page.waitForFunction(() => document.querySelector('[data-agent-id="ai:claude"]')?.getAttribute('data-presence-state') === 'idle');
    assert.equal(await page.locator('[data-agent-id="ai:claude"]').evaluate((el: HTMLElement) => getComputedStyle(el).opacity), '0.45');
    await page.clock.fastForward(5 * 60_000);
    await page.locator('.share-pill-agent-trigger').focus();
    assert.match(await page.locator('.share-pill-agent-trigger').getAttribute('aria-label'), /Claude — last active 6 min ago/);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(artifacts, 'bar-1280-idle.png'), fullPage: true });
    await page.clock.setFixedTime(new Date());
    await presence('editing');
    await page.waitForFunction(() => document.querySelector('[data-agent-id="ai:claude"]')?.getAttribute('data-presence-state') === 'active');
    await presence('left');
    await page.locator('[data-agent-id="ai:claude"]').waitFor({ state: 'detached' });
    await presence('editing');
    await page.locator('[data-agent-id="ai:claude"]').waitFor();
    // Fixed time only changes Date; resume advancing time for the TTL check.
    await page.clock.setSystemTime(new Date());
    await page.clock.fastForward(900_100);
    await page.locator('[data-agent-id="ai:claude"]').waitFor({ state: 'detached' });
    await page.setViewportSize({ width: 400, height: 900 });
    // Phones (700px and narrower): with no AI present, Add agent lives in the overflow menu after Share.
    const more = page.getByRole('button', { name: 'More options', exact: true });
    await more.waitFor();
    const moreRect = await more.boundingBox();
    const shareRect = await page.getByRole('button', { name: 'Share options', exact: true }).boundingBox();
    assert(moreRect && shareRect && moreRect.width >= 44 && moreRect.height >= 44 && moreRect.x >= shareRect.x + shareRect.width && moreRect.x + moreRect.width <= 400, 'More options must fit beside Share');
    await more.click();
    await page.getByRole('menuitem', { name: /Add agent/ }).waitFor();
    await page.screenshot({ path: path.join(artifacts, 'bar-400-add-agent.png'), fullPage: true });
    console.log('✓ 1280/400 px bar, 44 px targets, 32 px faces, mobile people list, idle tooltip, reactivation, leave and TTL');
  } finally {
    await browser?.close();
    await collab.stopCollabRuntime();
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections();
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // Ignore missing temporary database files.
      }
    }
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
