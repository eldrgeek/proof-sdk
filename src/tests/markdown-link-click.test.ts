import {
  LINK_CLICK_POLICY,
  extractLinkTargetFromEvent,
  headingSlug,
  inPageFragment,
  isLinkModifierActive,
  pressKeepsCaretOut,
  normalizeAndValidateHref,
  shouldOpenLinkForEvent,
  type LinkClickEventLike,
  type LinkModifierEventLike,
} from '../editor/plugins/markdown-link-click';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}. Expected: ${String(expected)}, got: ${String(actual)}`);
  }
}

function createEvent(overrides: Partial<LinkClickEventLike & { altKey: boolean }> = {}): LinkClickEventLike & { altKey: boolean } {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    defaultPrevented: false,
    ...overrides,
  };
}

function createModifierEvent(overrides: Partial<LinkModifierEventLike> = {}): LinkModifierEventLike {
  return {
    metaKey: false,
    ctrlKey: false,
    ...overrides,
  };
}

type SelectorMap = {
  markWrapper?: MockClosestTarget | null;
  anchor?: MockClosestTarget | null;
};

class MockClosestTarget {
  private selectors: SelectorMap & { deleted?: MockClosestTarget | null };
  private attrs: Record<string, string>;

  constructor(selectors: SelectorMap & { deleted?: MockClosestTarget | null } = {}, attrs: Record<string, string> = {}) {
    this.selectors = selectors;
    this.attrs = attrs;
  }

  closest(selector: string): unknown {
    if (selector === '[data-mark-id]') return this.selectors.markWrapper ?? null;
    if (selector === '.mark-delete, .mark-replace-delete') return this.selectors.deleted ?? null;
    if (selector === 'a[href]') return this.selectors.anchor ?? null;
    return null;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
}

class MockTextNode {
  parentElement: MockClosestTarget | null;

  constructor(parentElement: MockClosestTarget | null) {
    this.parentElement = parentElement;
  }
}

// Mike, 2026-09-21: "Clicking a link should take you to the link, not through the Open Link device."
function testShouldOpenLinkForEvent(): void {
  assertEqual(LINK_CLICK_POLICY.plainClickOpens, true, 'A plain click opens the link');
  assertEqual(shouldOpenLinkForEvent(createEvent(), false), true, 'Read-only: a plain primary click opens');
  assertEqual(shouldOpenLinkForEvent(createEvent(), true), true, 'Editable: a plain primary click opens too (no card, no modifier)');
  assertEqual(shouldOpenLinkForEvent(createEvent({ ctrlKey: true }), true), true, 'Ctrl+click still opens');
  assertEqual(shouldOpenLinkForEvent(createEvent({ metaKey: true }), true), true, 'Cmd+click still opens');
  assertEqual(shouldOpenLinkForEvent(createEvent({ button: 1 }), false), false, 'A non-primary click never opens');
  assertEqual(shouldOpenLinkForEvent(createEvent({ defaultPrevented: true }), true), true, 'ProseMirror default-preventing the click does not stop it');
  assertEqual(shouldOpenLinkForEvent(createEvent({ altKey: true }), true), false, 'Alt/Option+click edits the link instead');
}

function testPressAndFragments(): void {
  assertEqual(pressKeepsCaretOut(createEvent()), true, 'The press on a link places no caret');
  assertEqual(pressKeepsCaretOut(createEvent({ altKey: true })), false, 'Alt/Option+press places the caret (to edit)');
  assertEqual(pressKeepsCaretOut(createEvent({ button: 2 })), false, 'A right press is left alone');
  assertEqual(isLinkModifierActive(createModifierEvent({ metaKey: true })), true, 'Meta is a modifier');
  assertEqual(isLinkModifierActive(createModifierEvent()), false, 'No modifier');
  assertEqual(inPageFragment('#the-end'), 'the-end', 'A #fragment is a place in this document');
  assertEqual(inPageFragment('#caf%C3%A9'), 'café', 'Fragments are decoded');
  assertEqual(inPageFragment('https://example.com/#x'), null, 'A link with a page is not in-page');
  assertEqual(inPageFragment('#'), null, 'A bare # goes nowhere');
  assertEqual(headingSlug('The end'), 'the-end', 'Headings slug like GitHub');
  assertEqual(headingSlug('  Step 2: ship it!  '), 'step-2-ship-it', 'Punctuation drops, spaces become dashes');
  assertEqual(headingSlug('Café & bar'), 'café--bar', 'Letters beyond ASCII stay');
}

function testNormalizeAndValidateHref(): void {
  const base = 'https://proofeditor.ai/d/doc-1';

  assertEqual(
    normalizeAndValidateHref('https://example.com/path', base),
    'https://example.com/path',
    'https links should be allowed',
  );
  assertEqual(
    normalizeAndValidateHref('mailto:test@example.com', base),
    'mailto:test@example.com',
    'mailto links should be allowed',
  );
  assertEqual(
    normalizeAndValidateHref('tel:+15551231234', base),
    'tel:+15551231234',
    'tel links should be allowed',
  );

  const relativePath = normalizeAndValidateHref('/docs/getting-started', base);
  assert(relativePath === 'https://proofeditor.ai/docs/getting-started', 'Relative links should normalize to same-origin URL');

  const queryOnly = normalizeAndValidateHref('?focus=1', base);
  assert(queryOnly === 'https://proofeditor.ai/d/doc-1?focus=1', 'Query-only links should stay same-origin');

  const fragment = normalizeAndValidateHref('#intro', base);
  assert(fragment === 'https://proofeditor.ai/d/doc-1#intro', 'Fragment links should be allowed');

  assertEqual(
    normalizeAndValidateHref('//evil.example/path', base),
    null,
    'Protocol-relative cross-origin URLs should be blocked',
  );
  assertEqual(
    normalizeAndValidateHref('javascript:alert(1)', base),
    null,
    'javascript URLs should be blocked',
  );
  assertEqual(
    normalizeAndValidateHref('data:text/html;base64,AAAA', base),
    null,
    'data URLs should be blocked',
  );
  assertEqual(
    normalizeAndValidateHref('ftp://example.com/file.txt', base),
    null,
    'Disallowed protocols should be blocked',
  );
  assertEqual(
    normalizeAndValidateHref('https://[invalid', base),
    null,
    'Malformed URLs should be blocked',
  );
}

function testExtractLinkTargetFromEvent(): void {
  const anchor = new MockClosestTarget({}, { href: 'https://example.com' });
  const target = new MockClosestTarget({ anchor });
  const event = { target } as Pick<MouseEvent, 'target'>;
  const extracted = extractLinkTargetFromEvent(event);
  assert(extracted === anchor, 'Should return closest anchor for non-mark clicks');

  // A link inside a comment or a suggested insertion opens (Mike, 2026-09-21); one inside text a
  // suggestion deletes does not.
  const markWrapper = new MockClosestTarget();
  const insideMark = new MockClosestTarget({ markWrapper, anchor });
  const markEvent = { target: insideMark } as Pick<MouseEvent, 'target'>;
  assert(extractLinkTargetFromEvent(markEvent) === anchor, 'A link inside a comment or suggestion mark opens');
  const deleted = new MockClosestTarget();
  const insideDeleted = new MockClosestTarget({ markWrapper, anchor, deleted });
  assert(extractLinkTargetFromEvent({ target: insideDeleted } as Pick<MouseEvent, 'target'>) === null, 'A link in deleted text does not open');

  const noClosestEvent = { target: { nodeType: 3 } } as Pick<MouseEvent, 'target'>;
  const noClosest = extractLinkTargetFromEvent(noClosestEvent);
  assert(noClosest === null, 'Should return null for targets without closest()');

  const textNodeEvent = { target: new MockTextNode(target) } as Pick<MouseEvent, 'target'>;
  const textNodeExtracted = extractLinkTargetFromEvent(textNodeEvent);
  assert(textNodeExtracted === anchor, 'Should resolve text-node clicks via parentElement.closest()');
}

function run(): void {
  testShouldOpenLinkForEvent();
  testPressAndFragments();
  testNormalizeAndValidateHref();
  testExtractLinkTargetFromEvent();
  console.log('✓ markdown link click behavior guards');
}

run();
