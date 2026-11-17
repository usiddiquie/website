import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFrontMatter, renderInline, renderMarkdown } from './markdown.mjs';

test('front matter: parses keys, quotes, booleans and comments', () => {
  const { data, body } = parseFrontMatter(
    ['---', '# a comment', 'title: A & B', 'venue: "Quoted: value"', 'draft: true', 'empty:', '---', '', 'Body text'].join('\n'),
  );
  assert.deepEqual(data, { title: 'A & B', venue: 'Quoted: value', draft: true, empty: '' });
  assert.equal(body.trim(), 'Body text');
});

test('front matter: absent block returns the whole text as body', () => {
  assert.deepEqual(parseFrontMatter('Just text'), { data: {}, body: 'Just text' });
});

test('front matter: tolerates "---" inside a value and CRLF line endings', () => {
  const { data } = parseFrontMatter('---\r\ntitle: a --- b\r\n---\r\nx');
  assert.equal(data.title, 'a --- b');
});

test('front matter: reports unclosed blocks and bad lines with context', () => {
  assert.throws(() => parseFrontMatter('---\ntitle: x', 'a.md'), /a\.md.*closing/);
  assert.throws(() => parseFrontMatter('---\nnot a pair\n---', 'a.md'), /a\.md:2/);
});

test('inline: bold, italic, code and escaping', () => {
  assert.equal(renderInline('**b** *i* _j_ `c<d>`'), '<strong>b</strong> <em>i</em> <em>j</em> <code>c&lt;d&gt;</code>');
  assert.equal(renderInline('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('inline: links keep URLs untouched by emphasis rules', () => {
  assert.equal(
    renderInline('[site](https://example.com/a_b_c?x=1&y=2) and *x*'),
    '<a href="https://example.com/a_b_c?x=1&amp;y=2">site</a> and <em>x</em>',
  );
  assert.equal(renderInline('[**bold** `code`](/x)'), '<a href="/x"><strong>bold</strong> <code>code</code></a>');
});

test('inline: unsafe schemes lose the link, and links can be disabled', () => {
  assert.equal(renderInline('[x](javascript:alert(1))'), 'x');
  assert.equal(renderInline('[x](mailto:a@b.de)'), '<a href="mailto:a@b.de">x</a>');
  assert.equal(renderInline('[x](https://a.b)', { links: false }), 'x');
});

test('inline: URLs may contain balanced parentheses', () => {
  assert.equal(
    renderInline('[w](https://en.wikipedia.org/wiki/Foo_(bar)) after'),
    '<a href="https://en.wikipedia.org/wiki/Foo_(bar)">w</a> after',
  );
});

test('inline: snake_case words are not italicised', () => {
  assert.equal(renderInline('some_snake_case_name'), 'some_snake_case_name');
});

test('blocks: paragraphs, headings and lists', () => {
  const html = renderMarkdown('# Title\n\nFirst line\nsecond line\n\n- one\n- two\n  continued\n\nLast');
  assert.equal(
    html,
    '<h1>Title</h1>\n<p>First line second line</p>\n<ul><li>one</li><li>two continued</li></ul>\n<p>Last</p>',
  );
});
