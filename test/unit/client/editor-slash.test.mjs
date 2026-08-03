import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { slashCompletions, slashTheme, slashGlide } from '../../../client/editor-slash.js';

function contextFor(text, pos = text.length) {
  return { state: EditorState.create({ doc: text }), pos };
}

test('a bare slash at the start of a line offers every block type', () => {
  const result = slashCompletions(contextFor('/'));
  assert.ok(result);
  assert.deepEqual(
    result.options.map((o) => o.label),
    ['Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Bullet list', 'Numbered list',
      'Check list', 'Quote', 'Callout', 'Code block', 'Table', 'Divider'],
  );
});

test('indentation before the slash shifts the completion start, not the count', () => {
  const result = slashCompletions(contextFor('  /head'));
  assert.equal(result.from, 3);
  assert.equal(result.options.length, 12);
});

test('a slash preceded by other text on the line is not a command', () => {
  assert.equal(slashCompletions(contextFor('hello /')), null);
});

test('a slash mid-word is not a command either', () => {
  assert.equal(slashCompletions(contextFor('a/b')), null);
});

test('applying an option inserts its snippet and places the cursor', () => {
  const result = slashCompletions(contextFor('/tab', 1));
  const codeBlock = result.options.find((o) => o.label === 'Code block');
  const changes = [];
  const view = { dispatch: (tr) => changes.push(tr) };
  codeBlock.apply(view, null, 1, 4);
  assert.deepEqual(changes, [{
    changes: { from: 0, to: 4, insert: '```\n\n```' },
    selection: { anchor: 4 },
  }]);
});

test('an option without an explicit cursor lands after its own insert', () => {
  const result = slashCompletions(contextFor('/', 1));
  const heading = result.options.find((o) => o.label === 'Heading 1');
  const changes = [];
  heading.apply({ dispatch: (tr) => changes.push(tr) }, null, 1, 1);
  assert.equal(changes[0].selection.anchor, 2);
});

test('the theme and glide plugin are valid CodeMirror extensions', () => {
  assert.ok(slashTheme);
  assert.ok(slashGlide);
});
