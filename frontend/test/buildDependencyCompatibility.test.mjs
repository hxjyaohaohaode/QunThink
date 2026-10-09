import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import parser from 'postcss-selector-parser';
import postcss from 'postcss';
import nested from 'postcss-nested';
import tailwindcss from 'tailwindcss';

const require = createRequire(import.meta.url);

test('both Tailwind 3 selector consumers resolve the reviewed security override', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(manifest.overrides['postcss-selector-parser'], '7.1.6');
  for (const consumer of ['tailwindcss', 'postcss-nested']) {
    const consumerRequire = createRequire(require.resolve(`${consumer}/package.json`));
    assert.equal(consumerRequire('postcss-selector-parser/package.json').version, '7.1.6');
  }
});

test('flat class, id and interpolation selectors retain every node and round-trip', () => {
  for (const [atom, type, value] of [['.a', 'class', 'a'], ['#a', 'id', 'a'], ['#{a}', 'tag', '#{a}']]) {
    const input = atom.repeat(2000);
    const ast = parser().astSync(input);
    assert.equal(ast.toString(), input);
    if (type !== 'tag') {
      assert.equal(ast.first.nodes.length, 2000);
      assert.ok(ast.first.nodes.every(node => node.type === type && node.value === value));
    } else {
      assert.equal(ast.first.nodes.length, 1);
      assert.equal(ast.first.first.type, 'tag');
      assert.equal(ast.first.first.value, input);
    }
  }
  assert.deepEqual(parser().astSync('#x.y').first.nodes.map(node => [node.type, node.value]), [
    ['id', 'x'], ['class', 'y'],
  ]);
});

test('nested selectors preserve parent replacement, attributes and pseudo selectors', async () => {
  const input = '.card, .panel { &:hover, &[data-state="open"] { color: red; } & > :is(.a, .b) { color: blue; } }';
  const result = await postcss([nested]).process(input, { from: undefined });
  const rules = [];
  result.root.walkRules(rule => rules.push(rule.selector));
  assert.deepEqual(rules, [
    '.card:hover, .card[data-state="open"], .panel:hover, .panel[data-state="open"]',
    '.card > :is(.a, .b), .panel > :is(.a, .b)',
  ]);
});

test('Tailwind 3 can generate chained, arbitrary, group and peer selectors with the override', async () => {
  const classes = [
    'hover:focus:text-red-500', 'dark:hover:bg-blue-500', 'group-hover:underline',
    'peer-checked:block', '[&>svg]:h-4', 'data-[state=open]:opacity-100',
    'supports-[display:grid]:grid', 'before:content-[\'hello\']',
  ];
  const result = await postcss([tailwindcss({
    darkMode: 'class', content: [{ raw: classes.join(' '), extension: 'html' }],
    corePlugins: { preflight: false },
  })]).process('@tailwind utilities;', { from: undefined });
  const generated = new Set();
  result.root.walkRules(rule => {
    parser(selectors => selectors.walkClasses(node => generated.add(node.value))).processSync(rule.selector);
  });
  for (const name of classes) assert.ok(generated.has(name), `Missing generated class: ${name}`);
});
