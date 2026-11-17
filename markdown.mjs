// A deliberately small Markdown + front-matter implementation (no dependencies).
//
// Supported front matter: `key: value` lines between two `---` lines. Values are plain text,
// optionally wrapped in single or double quotes; `true` / `false` become booleans; lines
// starting with `#` are comments. No nesting, lists or multi-line values.
//
// Supported Markdown: paragraphs, `#`-style headings, `-` / `*` bullet lists, and inline
// **bold**, *italic* / _italic_, `code` and [links](url). Raw HTML is escaped, never passed through.

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function parseFrontMatter(source, file = 'input') {
  const lines = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') return { data: {}, body: lines.join('\n') };

  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end === -1) throw new Error(`${file}: front matter is missing its closing ---`);

  const data = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][\w-]*):(?:\s+(.*))?$/);
    if (!match) throw new Error(`${file}:${i + 1}: cannot parse front matter line "${line}"`);
    data[match[1]] = parseValue((match[2] ?? '').trim());
  }
  return { data, body: lines.slice(end + 1).join('\n') };
}

function parseValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const quoted = raw.match(/^(["'])(.*)\1$/);
  return quoted ? quoted[2] : raw;
}

// Only http(s), mailto and tel links (and scheme-less relative links) are allowed.
function isSafeUrl(url) {
  const scheme = url.match(/^([a-z][a-z0-9+.-]*):/i);
  return !scheme || ['http', 'https', 'mailto', 'tel'].includes(scheme[1].toLowerCase());
}

// Inline rendering works by "stashing" finished fragments (code spans, links) behind private-use
// placeholder characters so that later emphasis rules cannot touch URLs or code.
const OPEN = '';
const CLOSE = '';

export function renderInline(text, { links = true } = {}) {
  const stash = [];
  const out = inline(String(text).replace(/[]/g, ''), links, stash);
  return restore(out, stash);
}

function inline(text, links, stash) {
  const hold = (html) => `${OPEN}${stash.push(html) - 1}${CLOSE}`;
  let s = text.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`));
  // The URL may contain one level of balanced parentheses, e.g. https://en.wikipedia.org/wiki/Foo_(bar).
  s = s.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_, label, url) => {
    const body = inline(label, false, stash);
    return hold(links && isSafeUrl(url) ? `<a href="${escapeHtml(url)}">${body}</a>` : body);
  });
  s = escapeHtml(s);
  s = s.replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<![\w*])\*(?![\s*])(.+?)(?<![\s*])\*(?![\w*])/g, '<em>$1</em>');
  s = s.replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, '<em>$1</em>');
  return s;
}

function restore(text, stash) {
  const pattern = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g');
  let out = text;
  while (pattern.test(out)) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, (_, i) => stash[Number(i)]);
  }
  return out;
}

export function renderMarkdown(source, options = {}) {
  const html = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${renderInline(paragraph.join(' '), options)}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) html.push(`<ul>${list.map((item) => `<li>${renderInline(item, options)}</li>`).join('')}</ul>`);
    list = null;
  };

  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^[-*]\s+(.*)$/);

    if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (heading) {
      flushParagraph();
      flushList();
      html.push(`<h${heading[1].length}>${renderInline(heading[2], options)}</h${heading[1].length}>`);
    } else if (bullet) {
      flushParagraph();
      (list ??= []).push(bullet[1]);
    } else if (list && /^\s/.test(raw)) {
      list[list.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return html.join('\n');
}
