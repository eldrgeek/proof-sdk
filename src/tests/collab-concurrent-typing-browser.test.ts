import { createRequire } from 'node:module';
import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocketServer } from 'ws';

import { stripAllProofSpanTags } from '../../server/proof-span-strip.js';
import { showWholeAccord } from './whole-accord';

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.2',
  'X-Proof-Client-Build': 'concurrent-typing-browser-test',
  'X-Proof-Client-Protocol': '3',
};

const INITIAL_MARKDOWN = [
  '# Proof E2E',
  '',
  'ERIC\\',
  'I think teh play is ready.',
  '',
  'DIANA\\',
  'The second act needs one more scene.',
  '',
].join('\n');

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function mustJson<T>(response: Response, label: string): Promise<T> {
  const body = await response.text();
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}: ${body.slice(0, 500)}`);
  return JSON.parse(body) as T;
}

async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function loadChromium(): any {
  const packageJson = process.env.PROOF_PLAYWRIGHT_PACKAGE_JSON;
  const require = createRequire(packageJson || import.meta.url);
  try {
    return require('playwright').chromium;
  } catch {
    throw new Error(
      'Playwright is required. Set PROOF_PLAYWRIGHT_PACKAGE_JSON to a package.json beside an installed playwright package.',
    );
  }
}

async function openEditor(browser: any, url: string, name: string, suggest: boolean): Promise<any> {
  const context = await browser.newContext({ viewport: { width: 1100, height: 640 } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true',
    null,
    { timeout: 30_000 },
  );

  const nameInput = page.getByPlaceholder('Your name');
  if (await nameInput.isVisible()) {
    await nameInput.fill(name);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await nameInput.waitFor({ state: 'hidden', timeout: 10_000 });
    await page.waitForTimeout(500);
  }
  // The scenario types into paragraphs that the folded view hides until the whole Accord is shown.
  await showWholeAccord(page);

  const suggestionsEnabled = await page.evaluate(() => (window as any).proof.isSuggestionsEnabled());
  if (suggestionsEnabled !== suggest) {
    await page.click('.share-pill-suggest-toggle');
  }
  return page;
}

async function placeCaretAfter(page: any, needle: string): Promise<void> {
  const found = await page.evaluate((text: string) => {
    const view = (window as any).proof.editor.ctx.get('editorView');
    let position = -1;
    view.state.doc.descendants((node: any, at: number) => {
      if (position >= 0 || !node.isText) return;
      const index = node.text.indexOf(text);
      if (index >= 0) position = at + index + text.length;
    });
    if (position < 0) return false;
    const Selection = view.state.selection.constructor;
    view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(position))));
    view.focus();
    return true;
  }, needle);
  assert(found, `Could not place caret after "${needle}"`);
}

async function readEditor(page: any): Promise<{
  text: string;
}> {
  return page.evaluate(() => {
    const proof = (window as any).proof;
    const view = proof.editor.ctx.get('editorView');
    return {
      text: view.state.doc.textContent,
    };
  });
}

async function readParagraph(page: any, needle: string): Promise<string> {
  return page.evaluate((text: string) => {
    const view = (window as any).proof.editor.ctx.get('editorView');
    let paragraph = '';
    view.state.doc.descendants((node: any) => {
      if (!paragraph && node.isTextblock && node.textContent.includes(text)) {
        paragraph = node.textContent;
        return false;
      }
      return !paragraph;
    });
    return paragraph;
  }, needle);
}

async function inspectSuggestionCoverage(
  page: any,
  actorName: string,
  insertedText: string,
): Promise<{
  uncoveredOffsets: number[];
  suggestions: Array<{ id: string; text: string; content: string }>;
}> {
  return page.evaluate(({ actorName, insertedText }: { actorName: string; insertedText: string }) => {
    const proof = (window as any).proof;
    const view = proof.editor.ctx.get('editorView');
    let from = -1;
    view.state.doc.descendants((node: any, at: number) => {
      if (from >= 0 || !node.isTextblock) return from < 0;
      const index = node.textContent.indexOf(insertedText);
      if (index >= 0) {
        from = at + 1 + index;
        return false;
      }
      return true;
    });
    if (from < 0) {
      return { uncoveredOffsets: insertedText.split('').map((_: string, index: number) => index), suggestions: [] };
    }

    const uncoveredOffsets: number[] = [];
    for (let offset = 0; offset < insertedText.length; offset += 1) {
      let covered = false;
      view.state.doc.nodesBetween(from + offset, from + offset + 1, (node: any) => {
        if (!node.isText) return true;
        covered ||= node.marks.some((mark: any) => (
          mark.type.name === 'proofSuggestion'
          && mark.attrs.kind === 'insert'
          && String(mark.attrs.by).includes(actorName)
        ));
        return !covered;
      });
      if (!covered) uncoveredOffsets.push(offset);
    }

    const suggestions = (proof.getAllMarks() || [])
      .filter((mark: any) => (
        mark.kind === 'insert'
        && mark.range
        && String(mark.by).includes(actorName)
      ))
      .map((mark: any) => ({
        id: String(mark.id),
        text: view.state.doc.textBetween(mark.range.from, mark.range.to, '\n', '\n'),
        content: String(mark.data?.content ?? ''),
      }));
    return { uncoveredOffsets, suggestions };
  }, { actorName, insertedText });
}

async function selectText(page: any, needle: string): Promise<void> {
  const selected = await page.evaluate((text: string) => {
    const view = (window as any).proof.editor.ctx.get('editorView');
    let from = -1;
    view.state.doc.descendants((node: any, at: number) => {
      if (from >= 0 || !node.isText) return;
      const index = node.text.indexOf(text);
      if (index >= 0) from = at + index;
    });
    if (from < 0) return false;
    const Selection = view.state.selection.constructor;
    view.dispatch(view.state.tr.setSelection(Selection.create(view.state.doc, from, from + text.length)));
    view.focus();
    return true;
  }, needle);
  assert(selected, `Could not select "${needle}"`);
}

async function suggestionIds(page: any, actorName?: string, kind: 'insert' | 'delete' = 'insert'): Promise<string[]> {
  return page.evaluate(({ actorName, kind }: { actorName?: string; kind: string }) => (
    ((window as any).proof.getAllMarks() || [])
      .filter((mark: any) => (
        mark.kind === kind
        && (!actorName || String(mark.by).includes(actorName))
      ))
      .map((mark: any) => String(mark.id))
  ), { actorName, kind });
}

async function resolveSuggestions(
  page: any,
  ids: string[],
  action: 'accept' | 'reject',
): Promise<boolean[]> {
  return page.evaluate(({ ids, action }: { ids: string[]; action: string }) => ids.map((id) => (
    action === 'accept'
      ? Boolean((window as any).proof.markAccept(id))
      : Boolean((window as any).proof.markReject(id))
  )), { ids, action });
}

async function readServerState(
  httpBase: string,
  slug: string,
  accessToken: string,
): Promise<{
  markdown: string;
  marks: Record<string, {
    kind?: string;
    status?: string;
    by?: string;
    content?: string;
    range?: { from: number; to: number };
  }>;
}> {
  const state = await mustJson<{
    markdown?: string;
    content?: string;
    marks?: Record<string, {
      kind?: string;
      status?: string;
      by?: string;
      content?: string;
      range?: { from: number; to: number };
    }>;
  }>(await fetch(`${httpBase}/documents/${slug}/state`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-Agent-Id': 'concurrent-typing-browser-test',
    },
  }), 'server document state');
  return {
    markdown: state.markdown ?? state.content ?? '',
    marks: state.marks ?? {},
  };
}

async function runMode(
  httpBase: string,
  chromium: any,
  mode: 'edit' | 'suggest',
  options: {
    sameParagraph?: boolean;
    resolution?: 'reject-mike' | 'accept-all';
  } = {},
): Promise<void> {
  const sameParagraph = options.sameParagraph === true;
  const created = await mustJson<{
    slug: string;
    tokenUrl: string;
    accessToken: string;
  }>(await fetch(`${httpBase}/api/documents`, {
    method: 'POST',
    headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: `Concurrent typing ${mode} ${sameParagraph ? 'same paragraph' : 'different paragraphs'}`,
      markdown: INITIAL_MARKDOWN,
      marks: {},
    }),
  }), `create ${mode} document`);

  const browserA = await chromium.launch();
  const browserB = await chromium.launch();
  try {
    const url = `${httpBase}/d/${created.slug}?token=${encodeURIComponent(created.accessToken)}`;
    const [mike, eric] = await Promise.all([
      openEditor(browserA, url, 'Mike Concurrent', mode === 'suggest'),
      openEditor(browserB, url, 'Eric Concurrent', mode === 'suggest'),
    ]);

    await Promise.all([
      placeCaretAfter(mike, sameParagraph ? 'The second act' : 'play is ready.'),
      placeCaretAfter(eric, 'one more scene.'),
    ]);
    await Promise.all([
      mike.keyboard.type(' mike typed words', { delay: 60 }),
      eric.keyboard.type(' eric typed words', { delay: 60 }),
    ]);

    const expectedMikeContext = sameParagraph
      ? 'The second act mike typed words needs one more scene.'
      : 'play is ready. mike typed words';
    await waitForAsync(async () => {
      const [mikeState, ericState] = await Promise.all([readEditor(mike), readEditor(eric)]);
      return mikeState.text.includes(expectedMikeContext)
        && mikeState.text.includes('one more scene. eric typed words')
        && ericState.text.includes(expectedMikeContext)
        && ericState.text.includes('one more scene. eric typed words');
    }, 15_000, `${mode} ${sameParagraph ? 'same-paragraph' : 'different-paragraph'} editors to converge`);

    const [mikeState, ericState] = await Promise.all([readEditor(mike), readEditor(eric)]);
    for (const [label, state] of [['Mike', mikeState], ['Eric', ericState]] as const) {
      assert(
        state.text.includes(expectedMikeContext),
        `${mode}: ${label} lost or moved Mike's insertion: ${state.text}`,
      );
      assert(
        state.text.includes('one more scene. eric typed words'),
        `${mode}: ${label} lost or moved Eric's insertion: ${state.text}`,
      );
    }

    if (mode === 'suggest') {
      for (const [pageLabel, page] of [['Mike', mike], ['Eric', eric]] as const) {
        for (const [actor, insertedText] of [
          ['Mike Concurrent', ' mike typed words'],
          ['Eric Concurrent', ' eric typed words'],
        ] as const) {
          const coverage = await inspectSuggestionCoverage(page, actor, insertedText);
          assert(
            coverage.uncoveredOffsets.length === 0,
            `${pageLabel}: ${actor} had unmarked offsets ${JSON.stringify(coverage.uncoveredOffsets)} in ${JSON.stringify(insertedText)}; suggestions=${JSON.stringify(coverage.suggestions)}`,
          );
          assert(
            coverage.suggestions.length === 1
              && coverage.suggestions.every((suggestion) => suggestion.text === suggestion.content),
            `${pageLabel}: ${actor} expected one content/range-aligned suggestion: ${JSON.stringify(coverage.suggestions)}`,
          );
        }
      }
    }

    await waitForAsync(async () => {
      const state = await mustJson<{ markdown?: string; content?: string }>(
        await fetch(`${httpBase}/documents/${created.slug}/state`, {
          headers: {
            Authorization: `Bearer ${created.accessToken}`,
            'X-Agent-Id': 'concurrent-typing-browser-test',
          },
        }),
        `${mode} server state`,
      );
      const markdown = state.markdown ?? state.content ?? '';
      return markdown.includes(expectedMikeContext)
        && markdown.includes('one more scene. eric typed words');
    }, 15_000, `${mode} server projection`);

    if (mode === 'suggest' && options.resolution === 'reject-mike') {
      await selectText(mike, 'teh');
      await mike.keyboard.press('Backspace');
      await waitForAsync(
        async () => (await suggestionIds(eric, 'Mike Concurrent', 'delete')).length === 1,
        10_000,
        'Mike deletion suggestion to reach Eric',
      );

      const ericInsertIds = await suggestionIds(mike, 'Eric Concurrent');
      const acceptedEric = await resolveSuggestions(mike, ericInsertIds, 'accept');
      assert(
        acceptedEric.length > 0 && acceptedEric.every(Boolean),
        `Expected every Eric insert accept to succeed, got ${JSON.stringify(acceptedEric)}`,
      );
      await waitForAsync(
        async () => (await suggestionIds(eric, 'Eric Concurrent')).length === 0,
        10_000,
        'Eric insert acceptance to converge',
      );

      const deletionIds = await suggestionIds(eric, 'Mike Concurrent', 'delete');
      const rejectedDeletion = await resolveSuggestions(eric, deletionIds, 'reject');
      assert(
        rejectedDeletion.length === 1 && rejectedDeletion.every(Boolean),
        `Expected Mike's deletion reject to succeed, got ${JSON.stringify(rejectedDeletion)}`,
      );
      const paragraphBeforeInsertReject = await readParagraph(eric, 'The second act');
      assert(
        paragraphBeforeInsertReject === 'DIANA\nThe second act mike typed words needs one more scene. eric typed words',
        `Resolution introduced whitespace drift: ${JSON.stringify(paragraphBeforeInsertReject)}`,
      );

      const mikeInsertIds = await suggestionIds(eric, 'Mike Concurrent');
      const rejectedMike = await resolveSuggestions(eric, mikeInsertIds, 'reject');
      assert(
        rejectedMike.length > 0 && rejectedMike.every(Boolean),
        `Expected every Mike insert reject to remove text, got ${JSON.stringify(rejectedMike)}`,
      );
      const rejectedParagraph = 'DIANA\nThe second act needs one more scene. eric typed words';
      await waitForAsync(async () => (
        await readParagraph(mike, 'The second act') === rejectedParagraph
        && await readParagraph(eric, 'The second act') === rejectedParagraph
      ), 10_000, 'Mike insert rejection to converge');

      await mike.reload({ waitUntil: 'domcontentloaded' });
      await mike.waitForFunction(
        () => document.querySelector('.ProseMirror')?.getAttribute('contenteditable') === 'true',
        null,
        { timeout: 30_000 },
      );
      assert(
        await readParagraph(mike, 'The second act') === rejectedParagraph,
        'Reload resurrected text from rejected Mike suggestions',
      );
      await waitForAsync(async () => {
        const state = await readServerState(httpBase, created.slug, created.accessToken);
        const visible = stripAllProofSpanTags(state.markdown);
        const pending = Object.values(state.marks).filter((mark) => (
          (mark.kind === 'insert' || mark.kind === 'delete' || mark.kind === 'replace')
          && mark.status !== 'accepted'
          && mark.status !== 'rejected'
        ));
        return visible.includes('DIANA\\\nThe second act needs one more scene. eric typed words\n')
          && !visible.includes('mike typed words')
          && pending.length === 0;
      }, 15_000, 'rejected text and marks to persist on the server');
    }

    if (mode === 'suggest' && options.resolution === 'accept-all') {
      const allInsertIds = await suggestionIds(mike);
      const accepted = await resolveSuggestions(mike, allInsertIds, 'accept');
      assert(
        accepted.length > 0 && accepted.every(Boolean),
        `Expected every insert accept to succeed, got ${JSON.stringify(accepted)}`,
      );
      const acceptedParagraph = 'DIANA\nThe second act mike typed words needs one more scene. eric typed words';
      await waitForAsync(async () => (
        await readParagraph(mike, 'The second act') === acceptedParagraph
        && await readParagraph(eric, 'The second act') === acceptedParagraph
        && (await suggestionIds(mike)).length === 0
        && (await suggestionIds(eric)).length === 0
      ), 10_000, 'accepted inserts to converge without pending suggestions');
      await waitForAsync(async () => {
        const state = await readServerState(httpBase, created.slug, created.accessToken);
        const visible = stripAllProofSpanTags(state.markdown);
        const pending = Object.values(state.marks).filter((mark) => (
          (mark.kind === 'insert' || mark.kind === 'delete' || mark.kind === 'replace')
          && mark.status !== 'accepted'
          && mark.status !== 'rejected'
        ));
        return visible.includes(
          'DIANA\\\nThe second act mike typed words needs one more scene. eric typed words\n',
        ) && pending.length === 0;
      }, 15_000, 'accepted text and cleared suggestions to persist on the server');
    }

    console.log(
      `✓ concurrent ${mode} typing ${sameParagraph ? 'in one paragraph' : 'in different paragraphs'}`
      + `${options.resolution ? ` (${options.resolution})` : ''}`,
    );
  } finally {
    await Promise.allSettled([browserA.close(), browserB.close()]);
  }
}

async function run(): Promise<void> {
  const root = process.cwd();
  const dbPath = path.join(
    os.tmpdir(),
    `proof-collab-concurrent-typing-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';

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

  try {
    const chromium = loadChromium();
    await runMode(httpBase, chromium, 'edit');
    await runMode(httpBase, chromium, 'suggest');
    await runMode(httpBase, chromium, 'suggest', {
      sameParagraph: true,
      resolution: 'reject-mike',
    });
    await runMode(httpBase, chromium, 'suggest', {
      sameParagraph: true,
      resolution: 'accept-all',
    });
  } finally {
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
