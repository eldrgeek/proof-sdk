import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const source = readFileSync(path.resolve(process.cwd(), 'src/editor/index.ts'), 'utf8');

  assert(
    source.includes('const ystate = (ySyncPluginKey.getState(view.state) as any) ?? null;')
      && source.includes('bindingReady = ystate?.type === fragment')
      && source.includes('binding?.prosemirrorView === view')
      && source.includes('mapping instanceof Map'),
    'Expected collab hydration to wait for the active y-prosemirror binding and mapping',
  );
  assert(
    !source.includes('binding._forceRerender()')
      && !source.includes("typeof binding._forceRerender === 'function'"),
    'Expected hydration checks never to force a whole-document re-render',
  );
  assert(
    !source.includes('return editorText === fragmentText;'),
    'Expected transient editor/Yjs text differences not to control the live edit gate',
  );
  assert(
    source.includes('if (this.hasCompletedInitialCollabHydration || isCollabHydratedForEditing)'),
    'Expected hydration polling to stop once the binding is ready without repairing content',
  );

  console.log('✓ collab hydration waits for binding readiness without forcing re-renders');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
