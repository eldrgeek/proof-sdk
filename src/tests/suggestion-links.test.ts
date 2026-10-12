import { parseSuggestionLinks, renderSuggestionLinks } from '../editor/suggestion-links';

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}. Expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)}`);
  }
}

// The two proposals Mike saw as literal text on ttq18nc1 (2026-10-12).
const aiwtf = "Today aiwtf.org still shows Porkbun's parking page.\n\nAction: [open the page](https://aiwtf.substack.com/publish/settings?search=domain)";
assertEqual(
  parseSuggestionLinks(aiwtf),
  [{ text: 'open the page', href: 'https://aiwtf.substack.com/publish/settings?search=domain' }],
  'an Action line yields one link',
);

const stripe = "Until it exists, step 4 links to [PlayMaker's Netlify settings](https://app.netlify.com/sites/playmaker-mw/configuration/env).\n\nAction: [open the page](https://dashboard.stripe.com/apikeys)";
assertEqual(parseSuggestionLinks(stripe).map(l => l.text), ["PlayMaker's Netlify settings", 'open the page'], 'inline and Action links are both found, in order');

assertEqual(parseSuggestionLinks('no links here, only [brackets] and (parens)'), [], 'plain text has no links');
assertEqual(parseSuggestionLinks('[x](javascript:alert(1))'), [], 'a javascript: link is refused');
assertEqual(parseSuggestionLinks('[x](data:text/html;base64,AAAA)'), [], 'a data: link is refused');
assertEqual(parseSuggestionLinks('[x](claude://claude.ai/epitaxy/local_x)'), [], 'a claude:// link is refused, as on the page');
assertEqual(parseSuggestionLinks('[mail](mailto:a@b.test)').length, 1, 'mailto is allowed');

// A minimal element, enough for renderSuggestionLinks (no DOM library in this repo's tests).
type Fake = { tag: string; attrs: Record<string, string>; children: unknown[]; hidden?: boolean; href?: string; target?: string; rel?: string; textContent?: string; append: (...n: unknown[]) => void; replaceChildren: () => void };
function el(tag: string): Fake {
  const e: Fake = { tag, attrs: {}, children: [], append: (...n) => { e.children.push(...n); }, replaceChildren: () => { e.children = []; } };
  return e;
}
const doc = { createElement: (t: string) => el(t), createTextNode: (s: string) => ({ text: s }) };
const row = el('span');
renderSuggestionLinks(row as unknown as HTMLElement, stripe, doc as unknown as Document);
const anchors = row.children.filter(c => (c as Fake).tag === 'a') as Fake[];
assertEqual(anchors.length, 2, 'two anchors rendered');
assertEqual(anchors[1].href, 'https://dashboard.stripe.com/apikeys', 'anchor href is the link target');
assertEqual([anchors[1].target, anchors[1].rel], ['_blank', 'noopener noreferrer'], 'anchor opens in a new tab safely');
assertEqual(row.hidden, false, 'row shown when links exist');
renderSuggestionLinks(row as unknown as HTMLElement, 'plain', doc as unknown as Document);
assertEqual([row.children.length, row.hidden], [0, true], 'row emptied and hidden when the text has no links');

console.log('suggestion-links: all checks passed');
