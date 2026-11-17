#!/usr/bin/env node
// Static site builder (no dependencies): content/*.md + template.html + public/  ->  dist/
//
//   node build.mjs            build once into dist/
//   node build.mjs --serve    build, serve on http://localhost:4173 and rebuild on every change
//   node build.mjs --strict   treat warnings (missing images, dead local links) as errors; used in CI

import { createHash } from 'node:crypto';
import { existsSync, watch } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml, parseFrontMatter, renderInline, renderMarkdown } from './markdown.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONTENT = join(ROOT, 'content');
const PUBLIC = join(ROOT, 'public');
const DIST = join(ROOT, 'dist');
const TEMPLATE = join(ROOT, 'template.html');
const POSTER_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.avif'];
const VIDEO_EXTENSIONS = ['.mp4', '.webm'];

const args = new Set(process.argv.slice(2));
const strict = args.has('--strict');
const warnings = [];
const warn = (message) => warnings.push(message);

const ARROW =
  '<svg class="arrow" viewBox="0 0 10 10" width="8" height="8" aria-hidden="true"><path d="M1.5 8.5 8.5 1.5M3 1.5h5.5V7" fill="none" stroke="currentColor"/></svg>';

// ---------------------------------------------------------------------------------------------
// Reading content

async function readMarkdown(path) {
  const file = relative(ROOT, path);
  return { ...parseFrontMatter(await readFile(path, 'utf8'), file), file };
}

// Every `*.md` in a folder, sorted by file name (prefix with 01-, 02-, ... to order).
// Files starting with `_` and entries with `draft: true` are skipped.
async function readEntries(dir) {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.md') && !name.startsWith('_')).sort();
  const entries = await Promise.all(names.map((name) => readMarkdown(join(dir, name))));
  return entries.filter((entry) => entry.data.draft !== true);
}

function need(entry, ...keys) {
  for (const key of keys) {
    if (!entry.data[key]) throw new Error(`${entry.file}: front matter is missing "${key}"`);
  }
  return entry.data;
}

// ---------------------------------------------------------------------------------------------
// Rendering

function render(template, values) {
  return template.replace(/\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}/g, (_, raw, escaped) => {
    const key = raw ?? escaped;
    if (!(key in values)) throw new Error(`template.html uses {{${key}}}, which build.mjs does not provide`);
    return raw ? values[key] : escapeHtml(values[key]);
  });
}

const src = (path) => escapeHtml(encodeURI(path));

// The still image that sits next to a clip: same name, image extension (foo.mp4 -> foo.jpg).
function stillFor(path) {
  const base = path.slice(0, -extname(path).length);
  return POSTER_EXTENSIONS.map((ext) => base + ext).find((candidate) => existsSync(join(PUBLIC, candidate)));
}

// A thumbnail box.
//  - foo.mp4 / foo.webm: a muted, looping <video> that shows the still foo.jpg and downloads nothing
//    until script.js plays it (hover / keyboard focus / scrolled into view on touch).
//  - foo.gif: with a still next to it, the still is shown and script.js swaps the GIF in the same
//    way; without one the GIF is shown directly (and therefore always plays).
//  - anything else: a plain image.
function thumb(image, file) {
  if (!image) return '<span class="thumb thumb--empty" aria-hidden="true"></span>';
  if (!existsSync(join(PUBLIC, image))) warn(`${file}: image "${image}" not found in public/`);

  const extension = extname(image).toLowerCase();
  const still = stillFor(image);

  if (VIDEO_EXTENSIONS.includes(extension)) {
    if (!still) warn(`${file}: video "${image}" needs a still next to it (e.g. ${image.slice(0, -extension.length)}.jpg), shown until it plays`);
    return (
      `<span class="thumb"><video src="${src(image)}"${still ? ` poster="${src(still)}"` : ''} ` +
      `muted loop playsinline preload="${still ? 'none' : 'metadata'}" disablepictureinpicture ` +
      'aria-hidden="true" data-hover-play></video></span>'
    );
  }

  const animated = extension === '.gif' && still;
  return (
    `<span class="thumb"><img src="${src(animated ? still : image)}"${animated ? ` data-animated="${src(image)}"` : ''} ` +
    'alt="" loading="lazy" decoding="async"></span>'
  );
}

function linkOrBox(tag, className, url, inner) {
  return url
    ? `<a class="${className}" href="${escapeHtml(url)}">${inner}</a>`
    : `<${tag} class="${className}">${inner}</${tag}>`;
}

function publication(entry, me) {
  const { title, url, venue, year, authors, image } = need(entry, 'title', 'authors');
  const meta = [venue, year].filter(Boolean).join(' · ');
  // Each name is unbreakable ("Sicong Pan" never wraps between first and last name).
  const names = authors
    .split(/\s*,\s*/)
    .map((name) => `<span class="author">${name === me ? `<strong class="me">${escapeHtml(name)}</strong>` : escapeHtml(name)}</span>`)
    .join(', ');
  return `<li>${linkOrBox(
    'div',
    'pub',
    url,
    `${thumb(image, entry.file)}<div class="pub__text">` +
      `<h3 class="pub__title">${escapeHtml(title)}</h3>` +
      (meta ? `<p class="pub__venue">${escapeHtml(meta)}</p>` : '') +
      `<p class="pub__authors">${names}</p></div>`,
  )}</li>`;
}

function project(entry) {
  const { title, url, image } = need(entry, 'title');
  const description = renderInline(entry.body.trim().replace(/\s*\n\s*/g, ' '), { links: false });
  return `<li>${linkOrBox(
    'div',
    'card',
    url,
    `${thumb(image, entry.file)}<h3 class="card__title">${escapeHtml(title)}</h3>` +
      (description ? `<p class="card__desc">${description}</p>` : ''),
  )}</li>`;
}

// Cache-busting query for style.css / script.js (GitHub Pages caches them for ~10 minutes).
async function versioned(name) {
  const hash = createHash('sha1').update(await readFile(join(PUBLIC, name))).digest('hex').slice(0, 8);
  return `${name}?v=${hash}`;
}

// Every relative href/src in the output must point at a real file in public/.
function checkLocalReferences(html) {
  for (const [, ref] of html.matchAll(/(?:href|src|poster|data-animated)="([^"]*)"/g)) {
    if (!ref || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) continue;
    const path = decodeURIComponent(ref.split(/[?#]/)[0]);
    if (!existsSync(join(PUBLIC, path))) warn(`index.html links to "${ref}", but public/${path} does not exist`);
  }
}

// ---------------------------------------------------------------------------------------------
// Build

async function build() {
  warnings.length = 0;
  const started = performance.now();

  const siteData = need(await readMarkdown(join(CONTENT, 'site.md')), 'name', 'tagline', 'title', 'description', 'url', 'avatar');
  const about = await readMarkdown(join(CONTENT, 'about.md'));
  const links = await readMarkdown(join(CONTENT, 'links.md'));
  const pubsIndex = need(await readMarkdown(join(CONTENT, 'publications', '_index.md')), 'title');
  const projectsIndex = need(await readMarkdown(join(CONTENT, 'projects', '_index.md')), 'title');
  const [pubs, projects] = await Promise.all([
    readEntries(join(CONTENT, 'publications')),
    readEntries(join(CONTENT, 'projects')),
  ]);

  const baseUrl = siteData.url.endsWith('/') ? siteData.url : `${siteData.url}/`;
  const html = render(await readFile(TEMPLATE, 'utf8'), {
    title: siteData.title,
    description: siteData.description,
    url: baseUrl,
    og_image: new URL(siteData.avatar, baseUrl).href,
    avatar: src(siteData.avatar),
    name: siteData.name,
    tagline: siteData.tagline,
    links: renderInline(links.body.trim().replace(/\s*\n\s*/g, ' ')),
    about: renderMarkdown(about.body),
    pubs_title: pubsIndex.title,
    pubs_link_text: pubsIndex.link_text ?? '',
    pubs_link_url: pubsIndex.link_url ?? '',
    pubs: pubs.map((entry) => publication(entry, siteData.me)).join('\n'),
    projects_title: projectsIndex.title,
    projects_link_text: projectsIndex.link_text ?? '',
    projects_link_url: projectsIndex.link_url ?? '',
    projects: projects.map(project).join('\n'),
    arrow: ARROW,
    css: await versioned('style.css'),
    js: await versioned('script.js'),
  });

  checkLocalReferences(html);
  if (!existsSync(join(PUBLIC, siteData.avatar))) warn(`content/site.md: avatar "${siteData.avatar}" not found in public/`);

  await rm(DIST, { recursive: true, force: true });
  await cp(PUBLIC, DIST, { recursive: true });
  await writeFile(join(DIST, 'index.html'), html);

  for (const message of warnings) console.warn(`${strict ? 'error' : 'warning'}: ${message}`);
  if (strict && warnings.length) throw new Error(`${warnings.length} problem(s) found (--strict)`);
  console.log(`built ${pubs.length} publication(s), ${projects.length} project(s) -> dist/ in ${Math.round(performance.now() - started)} ms`);
}

// ---------------------------------------------------------------------------------------------
// Dev server

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

function serve(port) {
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(DIST, path));
      if (!file.startsWith(DIST + sep)) return res.writeHead(403).end('Forbidden');
      const body = await readFile(file);
      const headers = {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'accept-ranges': 'bytes',
      };
      // Browsers fetch (and seek in) videos with Range requests, like GitHub Pages answers them.
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      if (range && (range[1] || range[2])) {
        const start = range[1] === '' ? Math.max(0, body.length - Number(range[2])) : Number(range[1]);
        const end = range[1] === '' || range[2] === '' ? body.length - 1 : Math.min(Number(range[2]), body.length - 1);
        if (start > end || start >= body.length) return res.writeHead(416, { 'content-range': `bytes */${body.length}` }).end();
        res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1 });
        return res.end(body.subarray(start, end + 1));
      }
      res.writeHead(200, { ...headers, 'content-length': body.length });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    }
  });
  server.listen(port, '127.0.0.1', () => console.log(`serving dist/ at http://localhost:${port}  (watching for changes)`));

  let timer;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => build().catch((error) => console.error(`error: ${error.message}`)), 150);
  };
  for (const target of [CONTENT, PUBLIC, TEMPLATE]) watch(target, { recursive: true }, rebuild);
}

// ---------------------------------------------------------------------------------------------

try {
  await mkdir(PUBLIC, { recursive: true });
  await build();
  if (args.has('--serve')) serve(Number(process.env.PORT) || 4173);
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(1);
}
