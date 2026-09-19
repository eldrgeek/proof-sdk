/**
 * Proof Documents — Step B4f: competing alternatives `{alt}` (pure code, shared by the browser and
 * the server).
 *
 * Authorship: idea from Anthropic Fable (research round 2, idea 3); brief by the COS (Claude),
 * 2026-09-19; built by Claude Opus 5 (worker proof-bundles), 2026-09-19. POLICY rules are Claude's
 * decisions where the brief is silent.
 *
 * Instead of rejecting a line, any team member can offer another wording for it. The line's
 * wordings are shown stacked under it, the original first, each with who offered it. Each member
 * picks one (a radio in the rail, or keys 1-9 on the focus line). When every member has picked the
 * same one, or an Owner decides, it becomes the line (a normal edit, so line marks reset) and the
 * other wordings are folded into the line's history. Open alternatives are an Issue.
 * Alternatives and picks are stored beside the document, never in its text.
 */
import { actorKey, findCarryTarget, isAiActor, resolveLineAnchor, type DocLine, type LineAnchor } from './line-marks.js';

export const ALT_POLICY = {
  /** The pick that keeps the line as it is. */
  originalId: 'original',
  /** Keys 1-9: the original is 1, so at most 8 open alternatives per line. */
  maxPerLine: 8,
  maxText: 2000,
  /** Lines that can take alternatives (a table row or a code block is edited another way). */
  kinds: ['paragraph', 'heading', 'list_item'] as readonly string[],
  /** Anyone with comment access may offer an alternative (the same people who may reject). */
  whoMayOffer: 'commenter' as const,
  /** Offering an alternative also records the offerer's pick for it (they prefer their wording). */
  offererPicksOwn: true,
  /** Every team member (people and AIs) must pick the same wording; an Owner can decide instead. */
  unanimity: 'team' as const,
  /**
   * Unanimity needs at least one person's pick: a team of AIs alone never rewrites a line (an Owner
   * can still decide).
   */
  unanimityNeedsHuman: true,
  ownerDecides: true,
  /** A pick counts only for the line text it was made on (an edit reopens the choice). */
  picksResetWhenLineChanges: true,
  /** The winning wording becomes the line through a normal edit: every line mark on it resets. */
  winnerIsNormalEdit: true,
  /** The losing wordings are kept as the line's history (not a comment, so not an Issue). */
  foldIntoHistory: true,
  /** Picks and the Owner's decision are the members' explicit act; they do not mark the line. */
  pickMarksLine: false,
  /** The offerer (or an Owner) can withdraw an alternative while it is open. */
  withdrawBy: 'offerer-or-owner' as const,
} as const;

export type AltStatus = 'open' | 'chosen' | 'folded' | 'withdrawn';

export interface ProofAlternative {
  id: string;
  by: string;
  text: string;
  /** The line as it was when the alternative was offered (re-anchored as the line moves). */
  anchor: LineAnchor;
  createdAt: string;
  status: AltStatus;
  closedAt: string | null;
  closedBy: string | null;
  /** When closed: what the line became and how ("unanimous" / "owner" / "withdrawn"). */
  resolution: { how: 'unanimous' | 'owner' | 'withdrawn'; winner: string; winnerText: string } | null;
}

export interface AltPick {
  by: string;
  /** An alternative id, or ALT_POLICY.originalId. */
  choice: string;
  /** Hash of the line when the pick was made. */
  lineHash: string;
  at: string;
  /** Step B4f blind marking: someone's pick the viewer may not see yet (choice is a placeholder). */
  hidden?: boolean;
}

export interface AltOption {
  id: string;
  text: string;
  /** Null for the original wording. */
  by: string | null;
  createdAt: string | null;
}

export interface AltSetView {
  lineIndex: number;
  lineHash: string;
  /** The original first, then the open alternatives, oldest first. */
  options: AltOption[];
  /** Each member's current pick (keyed by actorKey). */
  picks: Map<string, AltPick>;
  /** Team members who have not picked for this text yet. */
  openFor: string[];
  /** The option every member picked (null until all picked the same one). */
  unanimous: string | null;
  /** At least two different visible picks. */
  disagree: boolean;
}

export function cleanAltText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, ALT_POLICY.maxText);
}

/** Where an alternative's line is now: its exact text, a cosmetic edit of it, or its old place. */
export function altLineIndex(alt: ProofAlternative, lines: DocLine[], cache?: Map<string, boolean>): number | null {
  const resolved = resolveLineAnchor(lines, alt.anchor);
  if (resolved?.current) return resolved.lineIndex;
  const carried = findCarryTarget(lines, alt.anchor, cache);
  if (carried) return carried.index;
  return resolved ? resolved.lineIndex : null;
}

/**
 * Groups the open alternatives by line and reads each member's pick. `team` decides who must pick.
 * Picks are the latest per member (and per line text: an older text's pick does not count).
 */
export function evaluateAlternatives(alts: ProofAlternative[], picks: AltPick[], lines: DocLine[], team: string[]): AltSetView[] {
  const byLine = new Map<number, ProofAlternative[]>();
  const cache = new Map<string, boolean>();
  for (const alt of alts) {
    if (alt.status !== 'open') continue;
    const index = altLineIndex(alt, lines, cache);
    if (index === null) continue;
    // A wording that is already the line's text is no longer a competitor (it was applied).
    if (cleanAltText(alt.text) === lines[index].text) continue;
    const list = byLine.get(index) ?? [];
    list.push(alt);
    byLine.set(index, list);
  }
  const views: AltSetView[] = [];
  for (const [lineIndex, list] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    const line = lines[lineIndex];
    list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
    const options: AltOption[] = [
      { id: ALT_POLICY.originalId, text: line.text, by: null, createdAt: null },
      ...list.slice(0, ALT_POLICY.maxPerLine).map(alt => ({ id: alt.id, text: alt.text, by: alt.by, createdAt: alt.createdAt })),
    ];
    const valid = new Set(options.map(o => o.id));
    const current = new Map<string, AltPick>();
    for (const pick of picks) {
      if (!pick.hidden && !valid.has(pick.choice)) continue;
      if (ALT_POLICY.picksResetWhenLineChanges && pick.lineHash !== line.hash) continue;
      const key = actorKey(pick.by);
      const prev = current.get(key);
      if (!prev || String(pick.at) >= String(prev.at)) current.set(key, pick);
    }
    const openFor = team.filter(member => !current.has(actorKey(member)));
    const visible = [...current.values()].filter(p => !p.hidden).map(p => p.choice);
    const distinct = new Set(visible);
    const anyHidden = [...current.values()].some(p => p.hidden);
    const humanPicked = [...current.values()].some(p => !isAiActor(p.by));
    const unanimous = team.length > 0 && openFor.length === 0 && !anyHidden && distinct.size === 1
      && (!ALT_POLICY.unanimityNeedsHuman || humanPicked) ? visible[0] : null;
    views.push({ lineIndex, lineHash: line.hash, options, picks: current, openFor, unanimous, disagree: distinct.size > 1 });
  }
  return views;
}

/** Input for computeIssues: one entry per line with open alternatives. When all picked but they
 * differ, the Issue is open for everyone (it waits on agreement, or an Owner's decision). */
export function alternativeIssueInputs(views: AltSetView[], team: string[]): Array<{ lineIndex: number; alternatives: number; openFor: string[]; disagree: boolean }> {
  return views.map(view => ({
    lineIndex: view.lineIndex,
    alternatives: view.options.length - 1,
    openFor: view.openFor.length > 0 ? view.openFor : (view.unanimous ? [] : [...team]),
    disagree: view.disagree,
  }));
}

/** The pick a member made on this set (null when none counts). */
export function pickOf(view: AltSetView, actor: string): AltPick | null {
  return view.picks.get(actorKey(actor)) ?? null;
}

/** Plain language for the rail and for AIs. */
export function describeAltSet(view: AltSetView): string {
  const n = view.options.length - 1;
  const picked = view.picks.size;
  const parts = [`${n} other ${n === 1 ? 'wording' : 'wordings'}`, `${picked} picked`];
  if (view.openFor.length) parts.push(`waiting on ${view.openFor.length}`);
  if (view.disagree) parts.push('the picks differ');
  return parts.join(' · ');
}
