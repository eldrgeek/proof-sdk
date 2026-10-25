/**
 * Accord — arguments on a proposal (pure code, shared by the browser and the server).
 *
 * Mike, 2026-10-24 (Claude project "Accords", the per-participant accord model): an argument is
 * advocacy for or against a change. "An observer can comment (argue) but their agreement is not
 * required." Arguments retire once the change is agreed, and they stay in the log so the path to
 * accord can be replayed. An explanation written for a new reader is not an argument: it is an
 * ordinary proposal.
 *
 * An argument names one proposal (a pending suggestion mark), a stance (for or against) and its
 * words. Anyone who can comment may argue, observers included. Arguments are append-only. Nothing
 * stores "retired": an argument is retired exactly when its proposal is no longer open (common,
 * commonly cut, overruled, or gone from the document), so a replay derives it the same way.
 *
 * Authorship: Mike Wolf (rulings), built by Claude, 2026-10-25.
 */
import { actorKey } from './line-marks.js';

export const ARGUMENT_POLICY = {
  /** "An observer can comment (argue)": observers argue; they still do not promote or cut. */
  observersMayArgue: true,
  /** Arguments retire when their proposal is settled, and are kept for replay. */
  retireWhenSettled: true,
  /** Longest argument. */
  maxText: 2000,
  /** Stances, in the order the page offers them. */
  stances: ['for', 'against'] as const,
  /** What the page calls each stance. */
  stanceLabel: { for: 'For', against: 'Against' } as Record<'for' | 'against', string>,
} as const;

export type ArgumentStance = 'for' | 'against';

export interface Argument {
  id: number;
  markId: string;
  by: string;
  stance: ArgumentStance;
  text: string;
  at: string;
}

export function parseStance(value: unknown): ArgumentStance | null {
  return value === 'for' || value === 'against' ? value : null;
}

/** The words of an argument, trimmed; null when empty or too long. */
export function parseArgumentText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > ARGUMENT_POLICY.maxText) return null;
  return text;
}

/** Arguments whose proposal is still open, in the order they were made. The rest are retired. */
export function activeArguments(all: readonly Argument[], openMarkIds: Iterable<string>): Argument[] {
  const open = new Set(openMarkIds);
  return all.filter(a => open.has(a.markId)).sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.id - y.id));
}

export function retiredCount(all: readonly Argument[], openMarkIds: Iterable<string>): number {
  const open = new Set(openMarkIds);
  return all.filter(a => !open.has(a.markId)).length;
}

/** Arguments on these changes, by stance. */
export function argumentsOn(all: readonly Argument[], markIds: readonly string[]): Record<ArgumentStance, Argument[]> {
  const wanted = new Set(markIds);
  const out: Record<ArgumentStance, Argument[]> = { for: [], against: [] };
  for (const a of all) if (wanted.has(a.markId)) out[a.stance].push(a);
  return out;
}

/** The Review row's count: "2 for · 1 against". Null when nobody has argued. */
export function argumentsText(all: readonly Argument[], markIds: readonly string[]): string | null {
  const on = argumentsOn(all, markIds);
  const parts: string[] = [];
  if (on.for.length) parts.push(`${on.for.length} for`);
  if (on.against.length) parts.push(`${on.against.length} against`);
  return parts.length ? parts.join(' · ') : null;
}

/** One argument as the Review row lists it: "For, Ada: keeps the sentence short". */
export function argumentLine(a: Argument, name: (actor: string) => string = x => x): string {
  return `${ARGUMENT_POLICY.stanceLabel[a.stance]}, ${name(a.by)}: ${a.text}`;
}

/** The same person making the same argument twice is one argument (a double press, a retry). */
export function findDuplicateArgument(all: readonly Argument[], next: Pick<Argument, 'markId' | 'by' | 'stance' | 'text'>): Argument | undefined {
  return all.find(a => a.markId === next.markId && a.stance === next.stance && a.text === next.text && actorKey(a.by) === actorKey(next.by));
}

/** A change named for the argue box when a line has several: "\"in Boston\" → \"in Denver\"". */
export function changeLabel(change: { kind: string; quote?: string | null; content?: string | null }, max = 40): string {
  const cut = (text: string | null | undefined) => {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  if (change.kind === 'insert') return `Adds "${cut(change.content)}"`;
  if (change.kind === 'delete') return `Removes "${cut(change.quote)}"`;
  return `"${cut(change.quote)}" → "${cut(change.content)}"`;
}
