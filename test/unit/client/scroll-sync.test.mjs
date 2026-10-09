import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorBlock, blockForHint, blockForLine, hintLines, lineTop, snippetAt, countBefore, nthIndex } from '../../../client/scroll-sync.js';

const blocks = [
  { line: 0, top: -300, bottom: -100 },
  { line: 4, top: -90, bottom: 40 },
  { line: 9, top: 50, bottom: 50 },
  { line: 12, top: 60, bottom: 200 },
];

test('anchorBlock picks the first block still visible below the view top, with its offset', () => {
  assert.deepEqual(anchorBlock(blocks, -90), { line: 4, offset: 0 });
  assert.deepEqual(anchorBlock(blocks, 45), { line: 12, offset: 15 });
  assert.equal(anchorBlock(blocks, 500), null);
});

test('blockForLine returns the last laid-out block at or before the line, skipping collapsed ones', () => {
  assert.equal(blockForLine(blocks, 10).line, 4);
  assert.equal(blockForLine(blocks, 12).line, 12);
  assert.equal(blockForLine(blocks, 0).line, 0);
  assert.equal(blockForLine([], 3), null);
});

const list = [
  { line: 0, top: 0, bottom: 100 },
  { line: 10, top: 100, bottom: 1100 },
  { line: 210, top: 1100, bottom: 1200 },
];

test('anchorBlock lands inside a tall block in proportion to the scrolled distance', () => {
  assert.deepEqual(anchorBlock(list, 600), { line: 110, offset: 0 });
  assert.deepEqual(anchorBlock(list, 603), { line: 110, offset: -3 });
});

test('lineTop maps a line inside a tall block to the proportional height', () => {
  assert.equal(lineTop(list, 110), 600);
  assert.equal(lineTop(list, 10), 100);
  assert.equal(lineTop(list, 5), 50);
});

test('lineTop and anchorBlock keep the last block at its top, with no end line to interpolate', () => {
  assert.equal(lineTop(list, 300), 1100);
  assert.deepEqual(anchorBlock(list, 1150), { line: 210, offset: -50 });
  assert.equal(lineTop([], 3), null);
});

test('anchorBlock prefers the nested block that holds the view top over its container', () => {
  const nested = [
    { line: 0, top: 0, bottom: 300 },
    { line: 0, top: 0, bottom: 100 },
    { line: 2, top: 100, bottom: 200 },
    { line: 4, top: 200, bottom: 300 },
  ];
  assert.deepEqual(anchorBlock(nested, 120), { line: 2, offset: -20 });
  assert.deepEqual(anchorBlock(nested, 100), { line: 2, offset: 0 });
});

test('snippetAt skips line markers and stops at inline markup in source text only', () => {
  assert.deepEqual(snippetAt('- [ ] **Warning:** done', 0, true), { text: 'Warning:', start: 8 });
  assert.deepEqual(snippetAt('> ## 1. Enter here', 0, true), { text: 'Enter he', start: 8 });
  assert.deepEqual(snippetAt('  a(b) c', 0, false), { text: 'a(b) c', start: 2 });
  assert.equal(snippetAt('**x**', 0, true), null);
});

test('nthIndex never reaches outside the text it is given', () => {
  assert.equal(nthIndex('see app.js for setup', 'js', 1), -1);
  assert.equal(nthIndex('print(1)', 'js', 0), -1);
  assert.equal(nthIndex('a js b js', 'js', 1), 7);
});

test('countBefore and nthIndex share one unit: occurrences within the block, source or rendered', () => {
  const source = '| a | ok |\n| b | ok |\n| c | ok |';
  const rendered = 'Aok' + 'Bok' + 'Cok';
  const at = source.indexOf('ok', source.indexOf('ok') + 1);
  const nth = countBefore(source, 'ok', at);
  assert.equal(nth, 1);
  assert.equal(nthIndex(rendered, 'ok', nth), 4);
  const phrase = 'the cat sat; the cat ran';
  assert.equal(countBefore(phrase, 'the cat', phrase.lastIndexOf('the cat')), 1);
  assert.equal(nthIndex(phrase, 'the cat', 1), phrase.lastIndexOf('the cat'));
});

test('a hint resolves inside its own block, never to an earlier mention of the same text', () => {
  const tops = [{ line: 1, text: 'intro: the cat sat' }, { line: 20, text: 'other words' }, { line: 40, text: 'the cat again, the cat' }];
  const find = (hintLine, snippet, nth) => {
    const block = blockForHint(tops, hintLine);
    return block ? nthIndex(block.text, snippet, nth) : -1;
  };
  assert.equal(blockForHint(tops, 0), null);
  assert.equal(blockForHint([], 5), null);
  assert.equal(blockForHint(tops, 25), tops[1]);
  assert.equal(find(25, 'the cat', 0), -1);
  assert.equal(find(45, 'the cat', 1), tops[2].text.lastIndexOf('the cat'));
  assert.equal(find(5, 'the cat', 0), 7);
});

test('hintLines limits the editor search to the hint block lines, clamped to the document', () => {
  assert.deepEqual(hintLines(40, 3, 500), { first: 40, last: 42 });
  assert.deepEqual(hintLines(40, 0, 500), { first: 40, last: 40 });
  assert.deepEqual(hintLines(499, 10, 500), { first: 499, last: 500 });
  assert.deepEqual(hintLines(900, 2, 500), { first: 500, last: 500 });
  assert.deepEqual(hintLines(-3, 2, 500), { first: 1, last: 2 });
});
