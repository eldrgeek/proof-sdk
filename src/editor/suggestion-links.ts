/** Clickable links for a pending suggestion's proposed words.
 * The proposal's words stay literal text, because that text is what a person edits and what
 * is published back as the mark's content. The links are a separate, read-only row next to
 * them, so a proposal that holds `[open the page](https://…)` can be opened with a click.
 * Mike, 2026-10-12, Waiting on Mike message 57: "The links in the actions are [markdown](link
 * format) and are not rendered so I cannot just click".
 */
import { normalizeAndValidateHref } from './plugins/markdown-link-click';

export interface SuggestionLink {
  text: string;
  href: string;
}

const LINK_RE = /\[([^\]\n]{1,200})\]\(([^()\s]{1,2000})\)/g;

export function parseSuggestionLinks(content: string): SuggestionLink[] {
  const out: SuggestionLink[] = [];
  for (const m of content.matchAll(LINK_RE)) {
    const href = normalizeAndValidateHref(m[2], 'https://proof.invalid/');
    if (href) out.push({ text: m[1], href });
  }
  return out;
}

type DocLike = Pick<Document, 'createElement' | 'createTextNode'>;

/** Replace the row's children with one anchor per link; the row is hidden when there are none. */
export function renderSuggestionLinks(row: HTMLElement, content: string, doc: DocLike = document): void {
  const links = parseSuggestionLinks(content);
  row.replaceChildren();
  row.hidden = links.length === 0;
  links.forEach((link, i) => {
    if (i > 0) row.append(doc.createTextNode(' · '));
    const a = doc.createElement('a');
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = link.text;
    row.append(a);
  });
}

export function createSuggestionLinksRow(content: string, markId: string, doc: DocLike = document): HTMLElement {
  const row = doc.createElement('span') as HTMLElement;
  row.className = 'proof-suggestion-links';
  row.setAttribute('data-suggestion-links-for', markId);
  row.style.cssText = 'display: block; font-size: 0.85em; margin-top: 2px;';
  renderSuggestionLinks(row, content, doc);
  return row;
}
