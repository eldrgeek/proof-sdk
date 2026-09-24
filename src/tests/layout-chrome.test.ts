/**
 * Accord layout stage 2 (Ren's proposal, Mike ruled 2026-09-21): the pure parts of the menu bar,
 * the toolbar's Issues pill, the Share dialog and the settings that left the main view.
 * Authorship: Claude Opus 5 (worker accord-layout2), 2026-09-21.
 */
import assert from 'node:assert/strict';
import {
  ISSUES_PILL_POLICY, KEYBOARD_SHORTCUTS, MARKS_LEGEND, MENU_BAR_POLICY, NEXT_ISSUE_POLICY, SETTINGS_POLICY,
  SHARE_DIALOG_POLICY, TOOLBAR_POLICY, issuesPillText, issuesPillTitle, menuForKey, searchMenus,
} from '../shared/layout-chrome';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

test('policy: the five menus in Docs order, a 28 px bar over a 44 px toolbar', () => {
  assert.deepEqual(MENU_BAR_POLICY.menus.map(m => m.label), ['File', 'Edit', 'View', 'People', 'Help']);
  assert.deepEqual(MENU_BAR_POLICY.menus.map(m => m.key), ['f', 'e', 'v', 'p', 'h']);
  assert.equal(MENU_BAR_POLICY.heightPx, 28);
  assert.equal(TOOLBAR_POLICY.heightPx, 44);
  assert.deepEqual(TOOLBAR_POLICY.groups, { centre: ['title', 'saved'], right: ['review', 'people', 'share'] });
  // Polish pass (COS, 2026-09-21): the phone toolbar is the mockup's: title, Issues, ⋯; the
  // switch and Share lead the ⋯ menu.
  assert.deepEqual([...TOOLBAR_POLICY.phoneKeeps], ['title', 'review', 'people', 'share']);
  assert.deepEqual([...TOOLBAR_POLICY.phoneMenuTop], ['mode']);
  assert.equal(TOOLBAR_POLICY.phoneSyncDotOnlyWhenNotSaved, true);
});

test('policy: the pill counts the viewer; Next goes to the viewer first; Share has three tabs; settings leave the view', () => {
  assert.equal(ISSUES_PILL_POLICY.counts, 'viewer');
  assert.equal(NEXT_ISSUE_POLICY.viewerFirst, true);
  assert.deepEqual(SHARE_DIALOG_POLICY.tabs.map(t => t.label), ['Link', 'People', 'AIs']);
  assert.equal(SHARE_DIALOG_POLICY.guestSettingOnLinkTab, true);
  assert.equal(SETTINGS_POLICY.readingSettingsInView, true);
  assert.equal(SETTINGS_POLICY.proxyBriefFolds, true);
});

test('issuesPillText: the viewer count, "Aligned" only when the team has nothing open', () => {
  assert.equal(issuesPillText(12, 30), '12 Issues');
  assert.equal(issuesPillText(1, 30), '1 Issue');
  assert.equal(issuesPillText(0, 30), '0 Issues');
  assert.equal(issuesPillText(0, 0), '0 Issues');
  assert.equal(issuesPillTitle(2, 9), '2 lines need you (the amber dots); the team has 9 open Issues.');
  assert.equal(issuesPillTitle(0, 0), 'Nothing needs you; the team has nothing open.');
});

test('menuForKey: Alt+letter while reading, Ctrl+Option+letter always, never in a field or with Cmd/Shift', () => {
  const key = (code: string, extra: Partial<Parameters<typeof menuForKey>[0]> = {}) => menuForKey({ code, altKey: true, ctrlKey: false, metaKey: false, writing: false, inField: false, ...extra });
  assert.equal(key('KeyF'), 'file');
  assert.equal(key('KeyH'), 'help');
  assert.equal(key('KeyP'), 'people');
  assert.equal(key('KeyX'), null);
  assert.equal(key('Slash'), 'search');
  assert.equal(key('KeyE', { writing: true }), null, 'Option+E is an accent key while writing');
  assert.equal(key('KeyE', { writing: true, ctrlKey: true }), 'edit');
  assert.equal(key('KeyV', { inField: true }), null);
  assert.equal(key('KeyV', { inField: true, ctrlKey: true }), 'view');
  assert.equal(key('KeyF', { metaKey: true }), null);
  assert.equal(key('KeyF', { shiftKey: true }), null);
  assert.equal(menuForKey({ code: 'KeyF', altKey: false, ctrlKey: true, metaKey: false, writing: false, inField: false }), null);
});

test('searchMenus: every word must start a word; enabled first; shorter labels first', () => {
  const entries = [
    { menu: 'View', label: 'Reading settings…', keywords: 'reading speed sitting budget', enabled: true },
    { menu: 'File', label: 'Download as Accord (.accord.md)', keywords: 'export markdown', enabled: true },
    { menu: 'People', label: 'Invite person…', enabled: false },
    { menu: 'People', label: 'Share…', enabled: true },
    { menu: 'Edit', label: 'Undo', enabled: true },
  ];
  assert.deepEqual(searchMenus(entries, 'sitting').map(e => e.label), ['Reading settings…']);
  assert.deepEqual(searchMenus(entries, 'exp mark').map(e => e.label), ['Download as Accord (.accord.md)']);
  assert.deepEqual(searchMenus(entries, 'people').map(e => e.label), ['Share…', 'Invite person…']);
  assert.deepEqual(searchMenus(entries, 'zzz'), []);
  assert.deepEqual(searchMenus(entries, '  '), []);
  assert.deepEqual(searchMenus(entries, 'UNDÓ').map(e => e.label), ['Undo']);
});

test('the keys list and the legend name what the menus and the page use', () => {
  assert.ok(KEYBOARD_SHORTCUTS.some(k => k.keys === 'S' && /draft/.test(k.does)));
  assert.ok(KEYBOARD_SHORTCUTS.some(k => k.keys === '⌘Enter / Ctrl+Enter' && k.does === 'Propose change'));
  assert.ok(KEYBOARD_SHORTCUTS.some(k => k.keys === 'Esc' && /Keep the draft/.test(k.does)));
  assert.ok(!KEYBOARD_SHORTCUTS.some(k => k.does === 'Start writing at the end of the line'));
  assert.ok(KEYBOARD_SHORTCUTS.some(k => k.keys === 'Alt+/'));
  assert.ok(KEYBOARD_SHORTCUTS.some(k => k.keys === 'F10'));
  assert.ok(KEYBOARD_SHORTCUTS.some(k => k.keys === 'A' && /Agree/.test(k.does)));
  assert.deepEqual(MARKS_LEGEND.slice(0, 2).map(m => m.label), ['Blue bar', 'Amber dot']);
});

console.log(`\n${passed} layout-chrome tests passed`);
