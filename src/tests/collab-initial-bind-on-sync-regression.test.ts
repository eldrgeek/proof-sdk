import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const source = readFileSync(path.resolve(process.cwd(), 'src/editor/index.ts'), 'utf8');
  const connectIdx = source.indexOf('collabClient.connect(collabSession.session);');
  assert(connectIdx >= 0, 'Expected share init to connect the collab client');

  const windowStart = Math.max(0, connectIdx - 500);
  const windowEnd = Math.min(source.length, connectIdx + 200);
  const snippet = source.slice(windowStart, windowEnd);

  assert(
    snippet.includes('this.pendingCollabRebindOnSync = true;'),
    'Expected share init to defer Milkdown binding until the first live collab sync',
  );
  assert(
    !source.includes('pendingCollabRebindResetDoc'),
    'Expected the synced Yjs fragment to hydrate the editor without a manual document reset',
  );
  assert(
    source.includes('private connectCollabService(): void {')
      && source.includes('collabService.bindDoc(ydoc);')
      && source.includes('collabService.connect();'),
    'Expected the editor to bind directly to the already-synced Yjs document',
  );
  assert(
    !source.includes('binding._forceRerender()'),
    'Expected application hydration code not to invoke y-prosemirror private re-render hooks',
  );
  const connectMethod = source.slice(
    source.indexOf('private connectCollabService(): void {'),
    source.indexOf('private ensureCollabCursorsInstalled(): void {'),
  );
  assert(
    !connectMethod.includes('.replaceWith('),
    'Expected collab binding not to dispatch a whole-document replacement before y-prosemirror restores its relative selection',
  );
  assert(
    !snippet.includes('this.connectCollabService(true);'),
    'Did not expect share init to bind Milkdown to Yjs before the first live collab sync',
  );

  console.log('✓ collab initial bind waits for first sync');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
