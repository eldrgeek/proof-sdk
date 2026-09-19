// Proof Documents — the dialect codec (pure): mark groups, text marks, line marks, front matter
// and handles, disambiguation from links / references / task lists / Pandoc attributes, block-line
// alignment, and CriticMarkup import and export.
// Authorship: Claude Opus 5 (worker proof-dialect) for Mike Wolf, 2026-09-19.
import assert from 'node:assert/strict';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import * as d from '../shared/proof-dialect';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

const mdast = (md: string) => unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']).parse(md) as unknown as d.MdNode;

test('mark group: type, @source, bare and quoted fields; serialize round-trips', () => {
  const g = d.parseMarkGroup('{agreed @mw at=2026-09-18 via=dwell}');
  assert.deepEqual(g, { type: 'agreed', source: 'mw', fields: { at: '2026-09-18', via: 'dwell' } });
  const q = d.parseMarkGroup('{rejected @claude reason="too \\"vague\\", see \\\\ x" note=a\\nb}');
  assert.equal(q?.fields.reason, 'too "vague", see \\ x');
  const back = d.serializeMarkGroup({ type: 'comment', source: 'mw', fields: { text: 'Line one\nline "two" {x}', n: '3' } });
  assert.equal(back, '{comment @mw text="Line one\\nline \\"two\\" {x}" n=3}');
  assert.deepEqual(d.parseMarkGroup(back), { type: 'comment', source: 'mw', fields: { text: 'Line one\nline "two" {x}', n: '3' } });
  assert.deepEqual(d.parseMarkGroup('{decision}'), { type: 'decision', source: null, fields: {} });
  assert.equal(d.serializeMarkGroup({ type: 'x', source: null, fields: { empty: '' } }), '{x empty=""}');
});

test('mark group: Pandoc attributes, raw attributes, templates and broken groups are not marks', () => {
  for (const s of ['{.class}', '{#id .c}', '{=html}', '{key=value}', '{Agreed}', '{agreed @}', '{agreed @mw @x}', '{agreed "x"}', '{agreed', '{}', '{ }', '{agreed x}', '{agreed @mw at=}x', '{agreed at="open}']) {
    assert.equal(d.parseMarkGroup(s), null, s);
  }
  assert.equal(d.parseMarkGroupAt('{agreed\n@mw}', 0), null, 'a group never spans a line break');
});

test('text marks: changed (replace, insert, delete), comment with replies, nesting; base keeps deleted text', () => {
  const doc = 'We launch in [~~Q2~~ Q3]{changed @claude why="dates moved"} and [really ]{changed @mw}ship [~~fast~~]{changed @mw}.\n\n[The budget [~~is~~ was]{changed @claude} fixed]{comment @mw text="Sure?"}{reply @claude text=Yes}.';
  const p = d.parseProofDocument(doc);
  assert.equal(p.base, 'We launch in Q2 and ship fast.\n\nThe budget is fixed.');
  const [replace, insert, del, comment, inner] = p.inline;
  assert.equal(p.base.slice(replace.start, replace.end), 'Q2');
  assert.equal(replace.deleted, 'Q2');
  assert.equal(replace.inserted, 'Q3');
  assert.equal(replace.groups[0].fields.why, 'dates moved');
  assert.equal(insert.start, insert.end);
  assert.equal(insert.inserted, 'really ');
  assert.equal(insert.deleted, null);
  assert.equal(p.base.slice(del.start, del.end), 'fast');
  assert.equal(del.inserted, '');
  assert.equal(comment.groups.length, 2);
  assert.equal(comment.groups[1].type, 'reply');
  assert.equal(p.base.slice(comment.start, comment.end), 'The budget is fixed');
  assert.equal(p.base.slice(inner.start, inner.end), 'is');
  // current = the document as the editor stores it: pending insertions in, deletions still there.
  assert.equal(p.current, 'We launch in Q2 and really ship fast.\n\nThe budget is fixed.');
  assert.equal(p.current.slice(insert.cstart, insert.cend), 'really ');
  assert.equal(p.current.slice(del.cstart, del.cend), 'fast');
  assert.equal(p.current.slice(comment.cstart, comment.cend), 'The budget is fixed');
});

test('line numbers in base and current: a whole inserted paragraph, and an insertion with a line break', () => {
  const doc = 'First. {agreed @mw}\n\n[A new paragraph.]{changed @claude}\n\nSecond [line\nbreak ]{changed @mw}here. {seen @mw}\n\nThird. {agreed @mw}';
  const p = d.parseProofDocument(doc);
  assert.equal(p.base, 'First.\n\n\n\nSecond here.\n\nThird.');
  assert.equal(p.current, 'First.\n\nA new paragraph.\n\nSecond line\nbreak here.\n\nThird.');
  assert.deepEqual(p.lines.map(l => [l.line, l.currentLine]), [[0, 0], [4, 5], [6, 7]]);
  const block = p.inline[0];
  assert.equal(block.start, 8);
  assert.equal(p.current.slice(block.cstart, block.cend), 'A new paragraph.');
  const crit = d.parseCriticMarkup('One {++two ++}three {~~four~>4~~}.');
  assert.equal(crit.current, 'One two three four.');
  assert.equal(crit.current.slice(crit.inline[0].cstart, crit.inline[0].cend), 'two ');
  assert.equal(crit.current.slice(crit.inline[1].cstart, crit.inline[1].cend), 'four');
});

test('disambiguation: links, references, task lists, footnotes, Pandoc spans, code spans and fences stay text', () => {
  const doc = [
    'See [the docs](https://example.com) and [ref][r] and [^1].',
    '- [ ] a task {not a mark}',
    '- [x] done',
    'A [pandoc span]{.smallcaps} here.',
    'Code `[x]{changed @mw}` stays.',
    '```',
    '[y]{changed @mw}',
    'line {agreed @mw}',
    '```',
    'Ends with a template {name}',
    '',
    '[r]: https://example.com',
  ].join('\n');
  const p = d.parseProofDocument(doc);
  assert.equal(p.inline.length, 0);
  assert.equal(p.lines.length, 0);
  assert.equal(p.base, doc);
});

test('line marks: several marks and authors per line; tables carry them in the last cell; fences on the info line', () => {
  const doc = [
    '# Plan {agreed @mw} {seen @claude}',
    '',
    'Some line. {agreed @mw via=dwell} {agreed @claude evidence="checked the dates"} {decision}',
    '',
    '| a | b {seen @mw} |',
    '|---|---|',
    '| 1 | 2 {rejected @mw reason="wrong total"} |',
    '',
    '```js {seen @claude}',
    'code()',
    '```',
  ].join('\n');
  const p = d.parseProofDocument(doc);
  assert.equal(p.base, '# Plan\n\nSome line.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\ncode()\n```');
  assert.deepEqual(p.lines.map(l => [l.line, l.groups.map(g => `${g.type}@${g.source}`)]), [
    [0, ['agreed@mw', 'seen@claude']],
    [2, ['agreed@mw', 'agreed@claude', 'decision@null']],
    [4, ['seen@mw']],
    [6, ['rejected@mw']],
    [8, ['seen@claude']],
  ]);
  assert.equal(p.lines[3].groups[0].fields.reason, 'wrong total');
  // Serialize the same structure back.
  const out = d.serializeProofDocument({ markdown: p.base, proof: {}, inline: [], lines: p.lines });
  assert.equal(out, doc);
});

test('a text mark at the end of a line is not a line mark; a line mark needs whitespace before it', () => {
  const p = d.parseProofDocument('Ends with [this]{comment @mw text=x}\nGlued text{agreed @mw}');
  assert.equal(p.lines.length, 0);
  assert.equal(p.inline.length, 1);
  assert.equal(p.base, 'Ends with this\nGlued text{agreed @mw}');
});

test('front matter: the proof block holds handles; other keys are kept; flow form reads too', () => {
  const doc = '---\ntitle: My plan\nproof:\n  version: 1\n  handles:\n    mw: "human:mw@mike-wolf.com"\n    claude: ai:claude\n  bundles:\n    launch: { title: "Move launch to October", why: "Q3 slipped" }\ntags: [a, b]\n---\n\nHello {agreed @mw}\n';
  const p = d.parseProofDocument(doc);
  assert.deepEqual(p.handles, { mw: 'human:mw@mike-wolf.com', claude: 'ai:claude' });
  assert.deepEqual(p.frontMatter.otherLines, ['title: My plan', 'tags: [a, b]']);
  assert.deepEqual((p.frontMatter.proof!.bundles as Record<string, unknown>).launch, { title: 'Move launch to October', why: 'Q3 slipped' });
  assert.equal(p.base, '\nHello\n');
  const flow = d.parseProofDocument('---\nproof: { handles: { mw: human:mw@mike-wolf.com, claude: ai:claude } }\n---\nx');
  assert.deepEqual(flow.handles, { mw: 'human:mw@mike-wolf.com', claude: 'ai:claude' });
  const fm = d.serializeFrontMatter({ otherLines: ['title: My plan'], proof: { version: '1', handles: { mw: 'human:mw@mike-wolf.com' }, bundles: { launch: { title: 'Move: now', why: 'x' } } } });
  const again = d.splitFrontMatter(`${fm}\nbody`);
  assert.deepEqual(again.frontMatter.proof, { version: '1', handles: { mw: 'human:mw@mike-wolf.com' }, bundles: { launch: { title: 'Move: now', why: 'x' } } });
  assert.equal(again.body, '\nbody');
});

test('handles: short, stable, unique; existing table entries are kept', () => {
  const t = d.buildHandleTable(['human:mw@mike-wolf.com', 'ai:claude-cos', 'guest:Ann Lee', 'human:mw@other.test', 'ai:claude-cos']);
  assert.deepEqual(t, { mw: 'human:mw@mike-wolf.com', 'claude-cos': 'ai:claude-cos', 'ann-lee': 'guest:Ann Lee', mw2: 'human:mw@other.test' });
  assert.equal(d.handleForActor(t, 'AI:claude-cos'), 'claude-cos');
  const kept = d.buildHandleTable(['human:mw@mike-wolf.com', 'ai:x'], { mike: 'human:mw@mike-wolf.com' });
  assert.deepEqual(kept, { mike: 'human:mw@mike-wolf.com', x: 'ai:x' });
});

test('serialize: nested and adjacent text marks, escaping of unbalanced brackets and ~~', () => {
  const md = 'The budget is fixed at [ten] thousand.';
  const out = d.serializeProofDocument({
    markdown: md,
    proof: { handles: { mw: 'human:mw@mike-wolf.com' } },
    inline: [
      { start: 4, end: 37, kind: 'comment', groups: [{ type: 'comment', source: 'mw', fields: { text: 'hm' } }] },
      { start: 11, end: 13, kind: 'replace', inserted: 'was]', groups: [{ type: 'changed', source: 'mw', fields: {} }] },
    ],
    lines: [{ line: 0, groups: [{ type: 'agreed', source: 'mw', fields: {} }] }],
  });
  assert.equal(out, '---\nproof:\n  handles:\n    mw: "human:mw@mike-wolf.com"\n---\n\nThe [budget [~~is~~ was\\]]{changed @mw} fixed at [ten] thousand]{comment @mw text=hm}. {agreed @mw}');
  const p = d.parseProofDocument(out);
  assert.equal(p.base, '\n' + md);
  assert.equal(p.inline.find(m => m.groups[0].type === 'changed')!.inserted, 'was\\]');
  assert.equal(d.escapeContent('a ] b [c] [d'), 'a \\] b [c] \\[d');
  const del = d.parseProofDocument('[~~a \\~~ b~~ c]{changed @mw}');
  assert.equal(del.inline[0].deleted, 'a \\~~ b');
  assert.equal(del.inline[0].inserted, 'c');
});

test('planInlineMarks: partial overlaps are set aside (written as line marks with quote=)', () => {
  const plan = d.planInlineMarks([{ start: 0, end: 10 }, { start: 2, end: 4 }, { start: 5, end: 12 }, { start: 12, end: 14 }]);
  assert.deepEqual(plan.inline, [{ start: 0, end: 10 }, { start: 2, end: 4 }, { start: 12, end: 14 }]);
  assert.deepEqual(plan.overlapping, [{ start: 5, end: 12 }]);
});

test('block lines: mdast positions give each editor line its markdown line; alignment by order and text', () => {
  const md = '# Plan\n\nWe launch\nin Q2.\n\n* item one\n* item two\n\n  second para\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\ncode\n```\n\n> quoted\n\n![img](x.png)\n\nSetext\n======\n';
  const blocks = d.blockLinesFromMdast(mdast(md));
  assert.deepEqual(blocks.map(b => [b.kind, b.text, b.markLine]), [
    ['heading', 'Plan', 0], ['paragraph', 'We launch in Q2.', 3], ['list_item', 'item one', 5], ['list_item', 'item two', 6],
    ['list_item', 'second para', 8], ['table_row', 'a | b', 10], ['table_row', '1 | 2', 12], ['code_block', 'code', 14],
    ['paragraph', 'quoted', 18], ['heading', 'Setext', 22],
  ]);
  const docLines = [
    { index: 0, kind: 'heading', text: 'Plan' }, { index: 1, kind: 'paragraph', text: 'We launch in Q2.' },
    { index: 2, kind: 'list_item', text: 'item one' }, { index: 3, kind: 'list_item', text: 'item two' },
    { index: 4, kind: 'list_item', text: 'second para' }, { index: 5, kind: 'table_row', text: 'a | b' },
    { index: 6, kind: 'table_row', text: '1 | 2' }, { index: 7, kind: 'code_block', text: 'code' },
    { index: 8, kind: 'paragraph', text: 'quoted' }, { index: 9, kind: 'heading', text: 'Setext' },
  ];
  const map = d.alignLines(docLines, blocks);
  assert.equal(map.size, 10);
  assert.equal(map.get(1)!.markLine, 3);
  // A line whose text differs slightly still aligns by position and kind.
  const map2 = d.alignLines([{ index: 0, kind: 'heading', text: 'Plan!' }, { index: 1, kind: 'paragraph', text: 'We launch in Q2.' }], blocks);
  assert.equal(map2.get(0)!.markLine, 0);
  assert.equal(map2.get(1)!.markLine, 3);
});

test('visible fragments and occurrence counting', () => {
  assert.equal(d.visibleFragment('the **bold** and [link](http://x) and `code` and _em_'), 'the bold and link and code and em');
  assert.equal(d.countOccurrences('a b a b a', 'a'), 3);
});

test('CriticMarkup import: ins, del, sub, highlight+comment (+reply), lone comment, authors, code untouched', () => {
  const doc = 'We launch in {~~Q2~>Q3~~} and {++really ++}ship {--fast--}.\n\n{==The budget is fixed==}{>>@mw: Sure?<<}{>>@claude Yes.<<} I think{>>unattributed<<}.\n\n{>>at start<<}Words here.\n\n`{++not++}`\n\n```\n{--code--}\n```\n\n{==lonely==} highlight.';
  const p = d.parseCriticMarkup(doc, { defaultSource: 'importer' });
  assert.equal(p.base, 'We launch in Q2 and ship fast.\n\nThe budget is fixed I think.\n\nWords here.\n\n`{++not++}`\n\n```\n{--code--}\n```\n\nlonely highlight.');
  const kinds = p.inline.map(m => `${m.groups[0].type}:${p.base.slice(m.start, m.end)}:${m.inserted ?? ''}:${m.groups[0].source}`);
  assert.deepEqual(kinds, [
    'changed:Q2:Q3:importer', 'changed::really :importer', 'changed:fast::importer',
    'comment:The budget is fixed::mw', 'comment:think::importer', 'comment:Words::importer',
  ]);
  const hl = p.inline.find(m => m.groups[0].fields.text === 'Sure?')!;
  assert.equal(hl.groups[1].type, 'reply');
  assert.equal(hl.groups[1].source, 'claude');
  assert.equal(hl.groups[1].fields.text, 'Yes.');
  assert.ok(p.warnings.some(w => w.includes('lonely')), 'a lone highlight is reported');
  assert.ok(d.looksLikeCriticMarkup(doc));
  assert.ok(!d.looksLikeCriticMarkup('[x]{changed @mw} and {>>c<<}'));
});

test('CriticMarkup import: files from the wild (MultiMarkdown / Scrivener / Marked style)', () => {
  // A MultiMarkdown-style review with substitutions spanning punctuation and an inline comment.
  const mmd = 'Lorem ipsum dolor{-- sit--} amet, consectetur{++ adipiscing++} elit.\n\nThis is a {~~red~>blue~~} house.{>>Is it though?<<}\n';
  const a = d.parseCriticMarkup(mmd);
  assert.equal(a.base, 'Lorem ipsum dolor sit amet, consectetur elit.\n\nThis is a red house.\n');
  assert.equal(a.inline.length, 4);
  assert.equal(a.inline[3].groups[0].fields.text, 'Is it though?');
  assert.equal(a.base.slice(a.inline[3].start, a.inline[3].end), 'house.');
  // Pandoc-flavoured: comments carry an author as "@name:".
  const pandoc = '# Title\n\nThe {==quick brown fox==}{>>@editor: cliché<<} jumps.\n\n- item {++added++}\n';
  const b = d.parseCriticMarkup(pandoc);
  assert.equal(b.base, '# Title\n\nThe quick brown fox jumps.\n\n- item \n');
  assert.equal(b.inline[0].groups[0].source, 'editor');
  // Our own export header is ignored on import.
  const ours = `${d.CRITIC_POLICY.exportHeader}\n\nHello {++there++}.`;
  const c = d.parseCriticMarkup(ours);
  assert.equal(c.base, 'Hello .');
});

test('CriticMarkup export: outermost marks only, comments with authors, header says it is lossy', () => {
  const out = d.serializeCriticMarkup({
    markdown: 'We launch in Q2 and ship fast. Really.',
    marks: [
      { start: 13, end: 15, kind: 'replace', inserted: 'Q3' },
      { start: 25, end: 29, kind: 'delete' },
      { start: 31, end: 38, kind: 'insert' },
      { start: 0, end: 2, kind: 'comment', comments: ['@mw: who?', '@claude: us'] },
    ],
  });
  assert.equal(out, `${d.CRITIC_POLICY.exportHeader}\n\n{==We==}{>>@mw: who?<<}{>>@claude: us<<} launch in {~~Q2~>Q3~~} and ship {--fast--}. {++Really.++}`);
  const back = d.parseCriticMarkup(out);
  assert.equal(back.base, 'We launch in Q2 and ship fast. ');
  assert.equal(back.inline.length, 4);
});

/** A plain-text view of simple markdown (escapes, *emphasis*, [link](url)) with its offset map. */
function plainView(body: string): d.StrippedText {
  let stripped = '';
  const map: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '\\' && i + 1 < body.length) { stripped += body[i + 1]; map.push(i + 1); i += 1; continue; }
    if (c === '*' || c === '[') continue;
    if (c === ']' && body[i + 1] === '(') { i = body.indexOf(')', i); continue; }
    stripped += c;
    map.push(i);
  }
  return { stripped, map };
}

test('placeInsertions: interrupted typing is placed as a chain, never by first occurrence, never overlapping', () => {
  const body = '# Waiting on Mike\n\nIt breaks nothing of ours. sk\\_live has no Roll Key option\n';
  const at = (n: number) => `2026-09-18T02:00:${String(n).padStart(2, '0')}.000Z`;
  const item = (id: string, content: string, n: number, expected: number | null = 2): d.InsertToPlace => ({ id, by: 'human:Mike', createdAt: at(n), content, quote: content.trim(), expected });
  // Stale offsets point at the title, where "on" and "i" also occur.
  const items = [item('a', ' sk', 1), item('b', '_live has no', 2), item('c', ' Roll', 3), item('d', ' Key o', 4), item('e', 'pt', 5), item('f', 'i', 6), item('g', 'on', 7)];
  const placed = d.placeInsertions(body, plainView(body), items);
  const text = (id: string) => { const p = placed.get(id)!; return body.slice(p.start, p.end); };
  assert.equal(text('b'), '\\_live has no', 'the escape belongs to the span');
  assert.equal(text('f'), 'i');
  assert.ok(placed.get('g')!.start > body.indexOf('Roll Key'), '"on" is the end of "option", not the title');
  const spans = [...placed.values()].map(p => p!).sort((x, y) => x.start - y.start);
  for (let k = 1; k < spans.length; k += 1) assert.ok(spans[k - 1].end <= spans[k].start, 'no two insertions share characters');
  assert.equal(spans.map(p => body.slice(p.start, p.end)).join(''), ' sk\\_live has no Roll Key option');
  // Text that is nowhere is an orphan; a span may not cross a link's "](url)" or emphasis.
  const md = 'See [the page](https://x.test) and *more* now.';
  const out = d.placeInsertions(md, plainView(md), [item('x', 'jere to', 1, null), item('y', 'page and', 2, null), item('z', 'more now', 3, null), item('w', 'the pa', 4, null)]);
  assert.equal(out.get('x'), null);
  assert.equal(out.get('y'), null, 'crosses the link syntax');
  assert.equal(out.get('z'), null, 'crosses the emphasis');
  assert.equal(md.slice(out.get('w')!.start, out.get('w')!.end), 'the pa', 'inside link text is fine');
  // Two insertions that could claim the same characters: each gets its own, the older one the nearer.
  const two = 'Done. Done.';
  const dd = d.placeInsertions(two, plainView(two), [item('p', 'Done', 1, 0), item('q', 'Done', 30, 0)]);
  assert.notEqual(dd.get('p')!.start, dd.get('q')!.start);
  assert.equal(dd.get('p')!.start, 0);
});

test('parse: marks inside a pure insertion are parsed (base keeps no inserted text); a change nested in one is its text', () => {
  const p = d.parseProofDocument('Say [hello [big]{comment @mw text=x} world]{changed @mw} now.');
  assert.equal(p.base, 'Say  now.');
  assert.equal(p.current, 'Say hello big world now.');
  const ins = p.inline.find(m => m.groups[0].type === 'changed')!;
  assert.equal(ins.inserted, 'hello big world');
  const c = p.inline.find(m => m.groups[0].type === 'comment')!;
  assert.equal(p.current.slice(c.cstart, c.cend), 'big');
  const n = d.parseProofDocument('A [b [c]{changed @mw}]{changed @mw}.');
  assert.equal(n.current, 'A b c.');
  assert.equal(n.inline.length, 1);
});

test('planInlineMarks: insertions stay inline; a comment crossing one becomes the line mark', () => {
  const ins = { start: 5, end: 10, kind: 'insert' };
  const com = { start: 2, end: 7, kind: 'comment' };
  const plan = d.planInlineMarks([com, ins], m => m.kind === 'insert');
  assert.deepEqual(plan.inline, [ins]);
  assert.deepEqual(plan.overlapping, [com]);
});

console.log(`\n${passed} proof-dialect codec tests passed`);
