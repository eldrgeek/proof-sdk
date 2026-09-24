/**
 * Toolbar: title, Review with a scoped count, People, Share.
 * Mike, 2026-09-23 (usability brief).
 * Accord layout, stage 2 (Ren's proposal, Mike ruled 2026-09-21: "build the layout that you
 * proposed"; decisions 1, 10 and 12): the menu bar, the one toolbar row, the Share dialog, and the
 * settings that left the main view. Pure: src/ui/menu-bar.ts, src/ui/share-dialog.ts,
 * src/ui/reading-settings.ts and the editor render what these decide.
 *
 * Authorship: Mike Wolf (rulings), Ren (SOMA UI, the proposal), built by Claude Opus 5 (worker
 * accord-layout2), 2026-09-21.
 */

/** The menus, in the order Docs and Word taught (proposal: "File · Edit · View · People · Help"). */
export type MenuId = 'file' | 'edit' | 'view' | 'people' | 'help';

export const MENU_BAR_POLICY = {
  /** Height of the menu bar on desktop (px), per the proposal. */
  heightPx: 28,
  /** The menus, in order, with the letter that opens each (Alt+letter; Ctrl+Option+letter on a Mac). */
  menus: [
    { id: 'file', label: 'File', key: 'f' },
    { id: 'edit', label: 'Edit', key: 'e' },
    { id: 'view', label: 'View', key: 'v' },
    { id: 'people', label: 'People', key: 'p' },
    { id: 'help', label: 'Help', key: 'h' },
  ] as ReadonlyArray<{ id: MenuId; label: string; key: string }>,
  /** F10 moves the keyboard to the first menu (the Windows convention Docs follows). */
  f10FocusesMenuBar: true,
  /** Alt+/ (Ctrl+Option+/ on a Mac) opens "Search the menus", as in Docs. */
  searchKey: '/',
  /**
   * Alt+letter opens a menu only while reading: while writing, Option+letter types a character on a
   * Mac ("Option+E" is an accent key). Ctrl+Option+letter always opens it.
   */
  altLetterWhileWriting: false,
  /** Phones: the menu bar is not shown; its menus fold into the toolbar's ⋯ menu. */
  phoneCollapsesIntoOverflow: true,
} as const;

/** The one toolbar row under the menu bar (proposal: "Toolbar (44 px), one row, three groups"). */
export const TOOLBAR_POLICY = {
  heightPx: 44,
  /** Title and save state, followed by Review, People and Share. Editing and Undo remain in the menus. */
  groups: {
    centre: ['title', 'saved'],
    right: ['review', 'people', 'share'],
  },
  /** The same primary controls stay reachable on a phone. */
  phoneKeeps: ['title', 'review', 'people', 'share'] as readonly string[],
  /** Direct editing remains reachable at the top of the phone menu. */
  phoneMenuTop: ['mode'] as readonly string[],
  /**
   * The sync dot beside the title (the mockup has none): on phones it shows only while the state is
   * not "Saved" (Saving, Syncing, Offline, Unsaved…), so a real problem is still visible there.
   */
  phoneSyncDotOnlyWhenNotSaved: true,
  /** The Undo button names what it would reverse ("Undo agreed line 6"); this caps its width (px). */
  undoMaxWidthPx: 260,
} as const;

/**
 * The Issues pill (COS decision, 2026-09-21, from stage 1's questions): it shows the VIEWER's own
 * count, so it equals the status bar's "Issues left" and the number of amber dots. The team's
 * count lives in the pill's title and in People › Who is here.
 */
export const ISSUES_PILL_POLICY = {
  counts: 'viewer' as 'viewer' | 'team',
  /** The team's count is in the pill's tooltip and the People dialog. */
  teamCountInTitle: true,
} as const;

/**
 * Next issue: the Issues that need the viewer (amber dots) first, in stakes order; after them the
 * team's other Issues in stakes order as before, so Next never goes quiet while the team has work.
 */
export const NEXT_ISSUE_POLICY = {
  viewerFirst: true,
} as const;

/** The Share dialog absorbs Invite person and Add agent (decision 12). */
export type ShareTab = 'link' | 'people' | 'ais';
export const SHARE_DIALOG_POLICY = {
  tabs: [
    { id: 'link', label: 'Link' },
    { id: 'people', label: 'People' },
    { id: 'ais', label: 'AIs' },
  ] as ReadonlyArray<{ id: ShareTab; label: string }>,
  /** The guest setting ("people who are not signed in") sits under Link, not People. */
  guestSettingOnLinkTab: true,
  /** People is shown only to an Owner (inviting is an Owner's act); everyone else sees why. */
  peopleOwnerOnly: true,
} as const;

/** Settings that left the main view (decision 10). */
export const SETTINGS_POLICY = {
  /** Reading speed and This sitting live in View › Reading settings (blind marking, an Owner switch for the whole document, stays in the rail). */
  readingSettingsInView: true,
  /** The Familiar's brief is a fold at the top of the rail, closed until opened (View › Familiar's brief). */
  proxyBriefFolds: true,
  proxyBriefDefaultOpen: false,
  /** When Next issue hits the sitting budget, Reading settings opens to say what is left. */
  budgetReachedOpensSettings: true,
} as const;

/** "12 Issues" / "1 Issue" / "Aligned" (the team has nothing open) / "0 Issues" (nothing needs you). */
export function issuesPillText(viewerCount: number, teamCount: number): string {
  if (viewerCount > 0) return `${viewerCount} ${viewerCount === 1 ? 'Issue' : 'Issues'}`;
  return teamCount === 0 ? 'Aligned' : '0 Issues';
}

/** The pill's tooltip lead: the viewer's count, then the team's. */
export function issuesPillTitle(viewerCount: number, teamCount: number): string {
  const mine = viewerCount === 0 ? 'Nothing needs you' : `${viewerCount} ${viewerCount === 1 ? 'line needs' : 'lines need'} you (the amber dots)`;
  const team = teamCount === 0 ? 'the team has nothing open' : `the team has ${teamCount} open ${teamCount === 1 ? 'Issue' : 'Issues'}`;
  return `${mine}; ${team}.`;
}

/** One entry the menu search can find. */
export interface MenuSearchEntry {
  menu: string;
  label: string;
  /** Extra words that should find it ("download" finds "Download as Accord (.accord.md)"). */
  keywords?: string;
  enabled: boolean;
}

/**
 * "Search the menus" (Docs' Alt+/): every word of the query must start a word of the entry's menu,
 * label or keywords. Enabled entries first; then shorter labels. Case- and accent-insensitive.
 */
export function searchMenus<T extends MenuSearchEntry>(entries: readonly T[], query: string, limit = 12): T[] {
  const norm = (text: string) => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const words = norm(query).split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return [];
  const scored: Array<{ entry: T; score: number; index: number }> = [];
  entries.forEach((entry, index) => {
    const hay = norm(`${entry.menu} ${entry.label} ${entry.keywords ?? ''}`).split(/[^a-z0-9]+/).filter(Boolean);
    let score = 0;
    for (const word of words) {
      const exact = hay.includes(word);
      const prefix = exact || hay.some(h => h.startsWith(word));
      if (!prefix) return;
      score += exact ? 2 : 1;
    }
    scored.push({ entry, score: score + (entry.enabled ? 10 : 0), index });
  });
  scored.sort((a, b) => (b.score - a.score) || (a.entry.label.length - b.entry.label.length) || (a.index - b.index));
  return scored.slice(0, limit).map(s => s.entry);
}

/** Which menu an Alt / Ctrl+Option keystroke opens, or null. `code` is KeyboardEvent.code. */
export function menuForKey(input: { code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey?: boolean; writing: boolean; inField: boolean }): MenuId | 'search' | null {
  if (!input.altKey || input.metaKey || input.shiftKey) return null;
  const strong = input.ctrlKey; // Ctrl+Option on a Mac: never types a character.
  if (!strong && (input.inField || (input.writing && !MENU_BAR_POLICY.altLetterWhileWriting))) return null;
  if (input.code === 'Slash') return 'search';
  const match = /^Key([A-Z])$/.exec(input.code);
  if (!match) return null;
  const letter = match[1].toLowerCase();
  return MENU_BAR_POLICY.menus.find(menu => menu.key === letter)?.id ?? null;
}

/** Keyboard shortcuts (Help › Keyboard shortcuts). One list, so the dialog and the docs agree. */
export const KEYBOARD_SHORTCUTS: ReadonlyArray<{ group: string; keys: string; does: string }> = [
  { group: 'Reading (caret out of the text)', keys: 'A', does: 'Agree with the line you are on' },
  { group: 'Reading (caret out of the text)', keys: 'R', does: 'Reject it (with a reason)' },
  { group: 'Reading (caret out of the text)', keys: 'J / ↓', does: 'Next line' },
  { group: 'Reading (caret out of the text)', keys: 'K / ↑', does: 'Previous line' },
  { group: 'Reading (caret out of the text)', keys: 'Y / T / N', does: 'Answer the ask on this line: Yes / Not yet / No' },
  { group: 'Reading (caret out of the text)', keys: 'D', does: 'Make the line a decision or context' },
  { group: 'Reading (caret out of the text)', keys: 'E', does: 'Ask the AIs to explain the line' },
  { group: 'Reading (caret out of the text)', keys: '1–9', does: 'Pick one of the line’s competing wordings' },
  { group: 'Reading (caret out of the text)', keys: 'Enter', does: 'Start writing at the end of the line' },
  { group: 'Writing (caret in the text)', keys: 'Esc', does: 'Back to reading' },
  { group: 'Everywhere', keys: '⌘Z / Ctrl+Z', does: 'Undo the last thing you did (a mark, a decision or typing)' },
  { group: 'Everywhere', keys: '⇧⌘Z / Ctrl+Y', does: 'Redo' },
  { group: 'Menus', keys: 'Alt+F, E, V, P, H', does: 'Open File, Edit, View, People, Help (Ctrl+Option+letter on a Mac)' },
  { group: 'Menus', keys: 'F10', does: 'Move to the menu bar' },
  { group: 'Menus', keys: 'Alt+/', does: 'Search the menus (Ctrl+Option+/ on a Mac)' },
];

/** Help › What the marks mean. */
export const MARKS_LEGEND: ReadonlyArray<{ swatch: 'here' | 'need' | 'settled' | 'change' | 'status'; label: string; means: string }> = [
  { swatch: 'here', label: 'Blue bar', means: 'You are here: the keys and the rail act on this line.' },
  { swatch: 'need', label: 'Amber dot', means: 'Needs you: an ask to answer or a change to decide. Each one is an Issue.' },
  { swatch: 'settled', label: 'Grey check', means: 'Settled: marked by you, or decided.' },
  { swatch: 'change', label: 'Green / struck words', means: 'A pending change: green is inserted, struck out is deleted.' },
  { swatch: 'status', label: 'Seen', means: 'You read the line (scrolling reads). It is not agreement.' },
  { swatch: 'status', label: 'Agreed', means: 'You agree with the line as written.' },
  { swatch: 'status', label: 'Rejected', means: 'You do not agree; your reason goes to the team.' },
  { swatch: 'status', label: 'Approved', means: 'An Owner signed off on the line (Approve is under More).' },
  { swatch: 'status', label: 'Changed since you marked it', means: 'Your mark is out of date: the line changed after you marked it.' },
];
