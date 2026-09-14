type ShareCollabHydrationEquivalenceArgs = {
  fragmentIsStructurallyEmpty: boolean;
  editorStructurallyEmpty: boolean;
  editorHydrationText: string | null;
  liveFragmentHydrationText: string | null;
  editorHydrationMarkdown: string | null;
  liveYjsHydrationMarkdown: string | null;
};

type ShareEditHydrationGateArgs = {
  baseAllowLocalEdits: boolean;
  hasCompletedInitialCollabHydration: boolean;
  isCollabHydratedForEditing: boolean;
};

type CollabHydrationRerenderArgs = {
  hasCompletedInitialCollabHydration: boolean;
  isCollabHydratedForEditing: boolean;
};

export type ShareEditHydrationGate = {
  allowLocalEdits: boolean;
  shouldKickCollabHydration: boolean;
};

export function isShareCollabHydrationEquivalent(
  args: ShareCollabHydrationEquivalenceArgs,
): boolean {
  if (args.fragmentIsStructurallyEmpty) return true;
  if (args.liveFragmentHydrationText === null) {
    return false;
  }
  if (args.editorHydrationText === null) return false;
  if (args.editorHydrationText !== args.liveFragmentHydrationText) return false;
  if (args.editorHydrationMarkdown === null || args.liveYjsHydrationMarkdown === null) {
    return true;
  }
  return args.editorHydrationMarkdown === args.liveYjsHydrationMarkdown;
}

export function evaluateShareEditHydrationGate(
  args: ShareEditHydrationGateArgs,
): ShareEditHydrationGate {
  if (!args.baseAllowLocalEdits) {
    return {
      allowLocalEdits: false,
      shouldKickCollabHydration: false,
    };
  }

  if (args.hasCompletedInitialCollabHydration) {
    return {
      allowLocalEdits: true,
      shouldKickCollabHydration: false,
    };
  }

  return {
    allowLocalEdits: args.isCollabHydratedForEditing,
    shouldKickCollabHydration: !args.isCollabHydratedForEditing,
  };
}

export function shouldForceCollabHydrationRerender(
  args: CollabHydrationRerenderArgs,
): boolean {
  return !args.hasCompletedInitialCollabHydration
    && !args.isCollabHydratedForEditing;
}
