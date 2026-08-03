import test from 'node:test';
import assert from 'node:assert/strict';
import { mathSpans, markEnd, markSpans, toggleTaskMark, parseWikilink, frontmatterEndLine, TASK_ITEM_RE, TASK_MARK_RE } from '../../../client/syntax.js';

const fmEnd = (text) => {
  const lines = text.split('\n');
  return frontmatterEndLine((n) => lines[n - 1], lines.length);
};

test('frontmatterEndLine finds a --- terminated block', () => {
  assert.equal(fmEnd('---\ntitle: x\n---\nbody'), 3);
});

test('frontmatterEndLine accepts the YAML ... terminator', () => {
  assert.equal(fmEnd('---\ntitle: x\n...\nbody'), 3);
});

test('frontmatterEndLine returns 0 without an opener or a closer', () => {
  assert.equal(fmEnd('# heading\n---\n'), 0);
  assert.equal(fmEnd('---\ntitle: x\nbody'), 0);
  assert.equal(fmEnd('---'), 0);
});

test('frontmatterEndLine scans past 60 lines', () => {
  assert.equal(fmEnd(['---', ...Array(80).fill('a: 1'), '---', 'body'].join('\n')), 82);
});

test('mathSpans finds inline math', () => {
  const spans = mathSpans('before $a+b$ after');
  assert.equal(spans.length, 1);
  assert.deepEqual(spans[0], { from: 7, to: 12, src: 'a+b', display: false });
});

test('mathSpans finds display math and trims it', () => {
  const spans = mathSpans('$$ x = 1 $$');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].display, true);
  assert.equal(spans[0].src, 'x = 1');
});

test('mathSpans treats currency as text, not math', () => {
  assert.deepEqual(mathSpans('costs $5 and $10 total'), []);
  assert.deepEqual(mathSpans('$5 or $6'), []);
});

test('mathSpans ignores a trailing space before the closing delimiter', () => {
  assert.deepEqual(mathSpans('$a + b $'), []);
});

test('mathSpans does not report inline spans inside display math', () => {
  const spans = mathSpans('$$a$$');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].display, true);
});

test('mathSpans spans multiple lines for display math only', () => {
  const spans = mathSpans('$$\nx\n$$');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].src, 'x');
  assert.deepEqual(mathSpans('$a\nb$'), []);
});

test('mathSpans returns spans in document order', () => {
  const spans = mathSpans('$a$ then $$b$$ then $c$');
  assert.deepEqual(spans.map((s) => s.src), ['a', 'b', 'c']);
});

test('markEnd rejects non-marks, empty marks and newlines', () => {
  assert.equal(markEnd('==a==', 0), 3);
  assert.equal(markEnd('xx', 0), -1);
  assert.equal(markEnd('====', 0), -1);
  assert.equal(markEnd('==a\nb==', 0), -1);
  assert.equal(markEnd('==a', 0), -1);
});

test('markSpans finds every highlight on a line', () => {
  const spans = markSpans('a ==one== b ==two== c');
  assert.deepEqual(spans.map((s) => s.inner), ['one', 'two']);
  assert.deepEqual(spans[0], { from: 2, to: 9, inner: 'one' });
});

test('markSpans keeps inner equals signs', () => {
  assert.deepEqual(markSpans('==a=b==').map((s) => s.inner), ['a=b']);
});

test('toggleTaskMark flips only the marker', () => {
  assert.equal(toggleTaskMark('- [ ] buy milk', true), '- [x] buy milk');
  assert.equal(toggleTaskMark('- [x] buy milk', false), '- [ ] buy milk');
  assert.equal(toggleTaskMark('- [X] done [ ] later', false), '- [ ] done [ ] later');
});

test('task regexes match the two positions they are used at', () => {
  assert.match('[ ] thing', TASK_ITEM_RE);
  assert.match('[x] thing', TASK_ITEM_RE);
  assert.doesNotMatch('[ ]thing', TASK_ITEM_RE);
  assert.match('[ ]', TASK_MARK_RE);
  assert.doesNotMatch('[ ] ', TASK_MARK_RE);
});

test('parseWikilink: no alias', () => {
  assert.deepEqual(parseWikilink('target'), { target: 'target', alias: 'target' });
});

test('parseWikilink: with alias', () => {
  assert.deepEqual(parseWikilink('target|Alias Text'), { target: 'target', alias: 'Alias Text' });
});

test('parseWikilink: empty alias', () => {
  assert.deepEqual(parseWikilink('target|'), { target: 'target', alias: '' });
});

test('parseWikilink: target containing # or /', () => {
  assert.deepEqual(parseWikilink('folder/note#heading'), { target: 'folder/note#heading', alias: 'folder/note#heading' });
  assert.deepEqual(parseWikilink('folder/note#heading|Shown'), { target: 'folder/note#heading', alias: 'Shown' });
});

test('parseWikilink: trims whitespace around target and alias', () => {
  assert.deepEqual(parseWikilink('  target  |  Alias  '), { target: 'target', alias: 'Alias' });
});
