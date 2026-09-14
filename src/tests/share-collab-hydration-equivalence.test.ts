import {
  evaluateShareEditHydrationGate,
  isShareCollabHydrationEquivalent,
} from '../editor/share-collab-hydration-equivalence.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  assert(
    isShareCollabHydrationEquivalent({
      fragmentIsStructurallyEmpty: true,
      editorStructurallyEmpty: false,
      editorHydrationText: 'Welcome to Proof',
      liveFragmentHydrationText: 'Welcome to Proof',
      editorHydrationMarkdown: '# Welcome to Proof',
      liveYjsHydrationMarkdown: '# Welcome to Proof',
    }) === true,
    'Expected structurally empty fragments to stay reset-safe',
  );

  assert(
    isShareCollabHydrationEquivalent({
      fragmentIsStructurallyEmpty: false,
      editorStructurallyEmpty: false,
      editorHydrationText: 'Welcome to Proof Provenance',
      liveFragmentHydrationText: 'Welcome to Proof Provenance',
      editorHydrationMarkdown: '# Welcome to Proof\n\n**Provenance**',
      liveYjsHydrationMarkdown: '# Welcome to Proof\n\n**Provenance**',
    }) === true,
    'Expected identical text and collab markdown to allow the initial reset skip',
  );

  assert(
    isShareCollabHydrationEquivalent({
      fragmentIsStructurallyEmpty: false,
      editorStructurallyEmpty: false,
      editorHydrationText: 'Welcome to Proof Provenance',
      liveFragmentHydrationText: 'Welcome to Proof Provenance',
      editorHydrationMarkdown: '# Welcome to Proof\n\n**Provenance**',
      liveYjsHydrationMarkdown: '# Welcome to Proof\n\nProvenance',
    }) === false,
    'Expected matching plain text but drifted markdown structure to force a full editor reset before collab bind',
  );

  assert(
    isShareCollabHydrationEquivalent({
      fragmentIsStructurallyEmpty: false,
      editorStructurallyEmpty: false,
      editorHydrationText: 'Welcome to Proof Provenance',
      liveFragmentHydrationText: null,
      editorHydrationMarkdown: '# Welcome to Proof\n\n**Provenance**',
      liveYjsHydrationMarkdown: '# Welcome to Proof\n\n**Provenance**',
    }) === false,
    'Expected unreadable live fragment hydration to fail closed and force a reset before collab bind',
  );

  const initialMismatch = evaluateShareEditHydrationGate({
    baseAllowLocalEdits: true,
    hasCompletedInitialCollabHydration: false,
    isCollabHydratedForEditing: false,
  });
  assert(
    initialMismatch.allowLocalEdits === false
      && initialMismatch.shouldKickCollabHydration === true,
    'Expected an initial hydration mismatch to keep edits gated and force hydration',
  );

  const localEditInFlight = evaluateShareEditHydrationGate({
    baseAllowLocalEdits: true,
    hasCompletedInitialCollabHydration: true,
    isCollabHydratedForEditing: false,
  });
  assert(
    localEditInFlight.allowLocalEdits === true
      && localEditInFlight.shouldKickCollabHydration === false,
    'Expected a post-hydration mismatch to preserve a local edit in flight',
  );

  const rebindMismatch = evaluateShareEditHydrationGate({
    baseAllowLocalEdits: true,
    hasCompletedInitialCollabHydration: false,
    isCollabHydratedForEditing: false,
  });
  assert(
    rebindMismatch.allowLocalEdits === false
      && rebindMismatch.shouldKickCollabHydration === true,
    'Expected a reconnect or rebind reset to require hydration again',
  );

}

try {
  run();
  console.log('✓ share collab hydration gate protects initial sync without discarding local edits');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
