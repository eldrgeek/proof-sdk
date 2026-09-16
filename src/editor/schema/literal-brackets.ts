import { $nodeSchema, $remark } from '@milkdown/kit/utils';

/** Preserve escaped bracket pairs as visible inline atoms with escaped Markdown output. */
export const literalBracketsSchema = $nodeSchema('literalBrackets', () => ({
  group: 'inline', inline: true, atom: true, selectable: false,
  attrs: { value: { default: '[[' } },
  leafText: node => node.attrs.value,
  parseDOM: [{ tag: 'span[data-literal-brackets]', getAttrs: (dom: HTMLElement) => ({ value: dom.getAttribute('data-literal-brackets') === ']]' ? ']]' : '[[' }) }],
  toDOM: node => ['span', { 'data-literal-brackets': node.attrs.value }, node.attrs.value],
  parseMarkdown: { match: node => node.type === 'literalBrackets', runner: (state, node, type) => { state.addNode(type, { value: node.value }); } },
  toMarkdown: { match: node => node.type.name === 'literalBrackets', runner: (state, node) => { state.addNode('literalBrackets', undefined, node.attrs.value); } },
}));
export function literalBracketsHandler(node: { value?: string }): string { return '\\' + (node.value === ']]' ? ']]' : '[['); }
export function remarkLiteralBrackets() {
  return (tree: any, file: any) => {
    const source = String(file.value ?? file);
    const visit = (parent: any) => {
      if (!parent.children || ['code', 'inlineCode'].includes(parent.type)) return;
      parent.children = parent.children.flatMap((node: any) => {
        if (node.type !== 'text' || !node.position) { visit(node); return [node]; }
        const raw = source.slice(node.position.start.offset, node.position.end.offset);
        const literal: { at: number; pair: string }[] = []; let cursor = 0;
        for (const match of raw.matchAll(/\[\[|\]\]/g)) {
          const at = node.value.indexOf(match[0], cursor); if (at < 0) continue;
          cursor = at + 2; let slashes = 0, back = match.index!;
          while (back > 0 && raw[--back] === '\\') slashes++;
          if (slashes % 2) literal.push({ at, pair: match[0] });
        }
        if (!literal.length) return [node];
        const result: any[] = []; let from = 0;
        for (const item of literal) {
          if (item.at > from) result.push({ type: 'text', value: node.value.slice(from, item.at) });
          result.push({ type: 'literalBrackets', value: item.pair }); from = item.at + 2;
        }
        if (from < node.value.length) result.push({ type: 'text', value: node.value.slice(from) });
        return result;
      });
    };
    visit(tree);
  };
}
export const remarkLiteralBracketsPlugin = $remark('remarkLiteralBrackets', () => remarkLiteralBrackets);
