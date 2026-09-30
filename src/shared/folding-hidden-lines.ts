import type { DocLine } from './line-marks';

export type FoldHiddenLineState = {
  whole: boolean;
  clean: boolean;
  visible: ReadonlySet<number>;
} | undefined;

export function buildFoldHiddenLineSet(lines: readonly DocLine[], s: FoldHiddenLineState): Set<number> {
  return new Set(!s || s.whole || s.clean ? [] : lines.filter(l => !s.visible.has(l.pos)).map(l => l.index));
}

/** Test hook: times the hidden-line Set was rebuilt (not cache hits). */
export let hiddenLineSetBuildCount = 0;
export function resetHiddenLineSetBuildCountForTests(): void {
  hiddenLineSetBuildCount = 0;
}

export class FoldHiddenLineCache {
  private cache: ReadonlySet<number> = new Set();
  private dirty = true;

  invalidate(): void {
    this.dirty = true;
  }

  hiddenLines(lines: readonly DocLine[], s: FoldHiddenLineState): ReadonlySet<number> {
    if (!this.dirty) return this.cache;
    hiddenLineSetBuildCount += 1;
    this.cache = buildFoldHiddenLineSet(lines, s);
    this.dirty = false;
    return this.cache;
  }

  isHidden(lines: readonly DocLine[], s: FoldHiddenLineState, lineIndex: number): boolean {
    return this.hiddenLines(lines, s).has(lineIndex);
  }
}
