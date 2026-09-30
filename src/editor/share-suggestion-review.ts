export function shouldUpdateShareSuggestionReviewDisplay(args: {
  docChanged: boolean;
  marksMeta: unknown;
}): boolean {
  return args.docChanged || args.marksMeta !== undefined;
}

export function createShareSuggestionReviewUpdateScheduler(
  scheduleFrame: (run: () => void) => number,
  cancelFrame: (frameId: number) => void,
): {
  schedule(run: () => void): void;
  cancel(): void;
  isScheduled(): boolean;
} {
  let frameId: number | null = null;

  return {
    schedule(run: () => void): void {
      if (frameId !== null) return;
      frameId = scheduleFrame(() => {
        frameId = null;
        run();
      });
    },
    cancel(): void {
      if (frameId === null) return;
      cancelFrame(frameId);
      frameId = null;
    },
    isScheduled(): boolean {
      return frameId !== null;
    },
  };
}
