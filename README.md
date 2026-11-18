# Personal website

A single-page static site. No framework, no npm dependencies: a ~250-line Node script
(`build.mjs`) turns the markdown in `content/` into `dist/index.html`. Needs Node 20+ (CI uses 22).

```bash
node build.mjs --serve   # build, serve at http://localhost:4173, rebuild when files change
node build.mjs           # one-off build into dist/
node build.mjs --strict  # same, but warnings (missing images, dead local links) fail the build
node --test              # tests for the markdown parser
```

## Where things live

```
content/
  site.md              name, tagline, page title/description, canonical URL, avatar, `me`
  about.md             the bio paragraph(s)
  links.md             the link row under the tagline (one line of markdown)
  publications/        _index.md = heading + "View Google Scholar" link, then one .md per paper
  projects/            _index.md = heading + "View Github" link,       then one .md per project
public/                copied to the site as-is: style.css, script.js, favicon.svg, fonts/, assets/
template.html          page skeleton ({{x}} = escaped value, {{{x}}} = raw HTML)
build.mjs              the builder (and a tiny dev server)
markdown.mjs           front-matter + markdown subset
```

Entries are shown in **file-name order** (`01-…`, `02-…`). Files starting with `_` are ignored
(except `_index.md`), as are entries with `draft: true`. Copy `_template.md` to add one.

### Publication (`content/publications/NN-name.md`)

```yaml
---
title: Paper title
venue: Conference or journal
year: 2026
authors: First Author, Usama Ahmed Siddiquie, Last Author   # `me` from site.md is highlighted
url: https://arxiv.org/abs/…                                 # the whole row is the link
image: assets/paper.gif                                      # optional thumbnail (grey box if omitted)
---
```

### Project (`content/projects/NN-name.md`)

Same idea; the text under the front matter is the one-line description, and the whole card links to `url`.

### Thumbnails: videos that play on hover

Put `foo.mp4` in `public/assets/`, put its **first frame** next to it as `foo.jpg` (or `.png`,
`.webp`, `.avif`), and reference the video: `image: assets/foo.mp4`. The page shows the still;
`script.js` plays the muted, looping video on hover or keyboard focus (while scrolled into view on
touch devices; never with "reduce motion" or the browser's data-saver on). Nothing is downloaded
until a clip is first played, and later plays come from the browser cache. The still has to be the
video's first frame, because the thumbnail returns to frame 0 when the pointer leaves.

MP4 (H.264) beats GIF here: at 640×480 and 30 fps it was roughly 3–12× smaller than the 400×300,
10 fps GIFs it replaced, and closer to the original (text stays sharp, no dithering or banding).
Encode without audio and with `+faststart` so playback can begin before the file has finished
downloading:

```bash
# Card thumbnail (shown at 320×240): 4:3 centre crop, 640×480, 30 fps, plus the first frame as the still
ffmpeg -i demo.mp4 -an -vf "fps=30,crop=ih*4/3:ih,scale=640:480" -c:v libx264 -preset slow -crf 27 -pix_fmt yuv420p -movflags +faststart public/assets/demo.mp4
ffmpeg -i demo.mp4 -frames:v 1 -vf "crop=ih*4/3:ih,scale=640:480" -q:v 3 public/assets/demo.jpg

# Keep the clip's own shape instead (e.g. a 16:9 publication thumbnail), 720 px wide
ffmpeg -i demo.mp4 -an -vf "scale=720:-2" -c:v libx264 -preset slow -crf 27 -pix_fmt yuv420p -movflags +faststart public/assets/demo.mp4
ffmpeg -i demo.mp4 -frames:v 1 -vf "scale=720:-2" -q:v 3 public/assets/demo.jpg
```

Put `-t 6` before `-i` to keep only the first 6 s; raise `-crf` (up to ~33) for smaller files. Thumbnails
are cropped to fit their box (`object-fit: cover`), so a clip with another shape still works.

GIFs are still supported: `image: assets/foo.gif`, with a same-named still, is swapped in on the first
hover. They are much larger for the same footage, so prefer video.

### Markdown supported

Paragraphs, `#` headings, `-` lists, `**bold**`, `*italic*`, `` `code` ``, `[links](https://…)`.
Raw HTML is escaped, and only `http(s)`, `mailto` and `tel` links are kept.
Front matter is flat `key: value` lines (optionally quoted); no lists or multi-line values.

## Deploying (GitHub Pages)

The workflow in `.github/workflows/deploy.yml` runs the tests, builds with `--strict`, and
deploys `dist/` on every push to `main`. This folder is meant to be **the root of its own public
repository**, separate from the private job-search repo.

1. Create the public repo and push this folder as its root (workflows only run from the repo root).
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Custom domain: **Settings → Pages → Custom domain → `usamas.com`**, then tick *Enforce HTTPS*
   once the certificate is issued. (With Actions deploys a `CNAME` file is not needed.)
4. DNS at the registrar (the mail records stay as they are):

   | Type  | Host  | Value |
   |-------|-------|-------|
   | A     | `@`   | `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` |
   | AAAA  | `@`   | `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153` |
   | CNAME | `www` | `<github-user>.github.io` |

The build fails on purpose if `links.md` points to a file that is not in `public/` (for example
`cv.pdf`), so a dead link cannot be deployed. Add the file or remove the link.

## Deploying (Netlify, DNS stays at the registrar)

An alternative that needs neither GitHub Actions nor GitHub Pages. Netlify serves an apex domain
from any DNS provider, so only two web records change and the mail records (MX, SPF, ...) are not
touched. (Cloudflare Pages would need the domain's nameservers moved to Cloudflare.)
`netlify.toml` holds the build settings, `public/404.html` is the not-found page and
`public/_headers` sets cache and security headers; `.node-version` pins Node.

1. app.netlify.com → **Add new project → Import an existing project → GitHub**, pick this repo.
   The build settings are read from `netlify.toml` (`node build.mjs --strict`, publish `dist`).
2. After the first deploy: **Domain management → Add a domain → `usamas.com`** (and `www`).
3. At the registrar's DNS, change only these two records and leave everything else as it is:

   | Type  | Host  | Value |
   |-------|-------|-------|
   | A     | `@`   | `75.2.60.5` |
   | CNAME | `www` | `<project>.netlify.app` |

   Remove the registrar's parking records for `@` and `www`; they would clash with these.
4. Back in Netlify, verify DNS and let it issue the HTTPS certificate. Check with
   `dig usamas.com` and `dig www.usamas.com`, and check that mail (`dig MX usamas.com`) is unchanged.
5. Use one host at a time: if you switch back to GitHub Pages, point the records back as in the
   table above.

## Design notes

Tokens in `public/style.css` come from the Figma file (colours, 2px dividers, 4px white thumbnail
borders, 16px radius, and `--hover` / `--radius-hover` for the rounded background that appears,
bleeding 8px beyond it, when a publication row or project card is hovered or keyboard-focused). Layout tiers: mobile (≤640px, the 402px design), tablet, desktop (≥1000px,
the 1512px design with a 1024px column). Font: Gelasio, self-hosted (`public/fonts/`, OFL).
