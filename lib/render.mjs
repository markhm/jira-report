// Model + brand → one self-contained HTML file (all CSS/JS/data/logo inlined; no network requests).

import { readFileSync, existsSync, statSync } from 'node:fs';
import { markdown } from './markdown.mjs';
import { join, extname } from 'node:path';
import { REPO } from './config.mjs';

const TEMPLATE = join(REPO, 'template');
const MIME = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const HEX = /^#[0-9a-f]{3,8}$/i;

export function loadBrand(dir) {
  const file = join(dir, 'brand.json');
  if (!existsSync(file)) throw new Error(`brand not found: ${file}`);
  const b = JSON.parse(readFileSync(file, 'utf8'));
  let logo = null;
  if (b.logo) {
    const p = join(dir, b.logo);
    if (!existsSync(p)) throw new Error(`brand logo not found: ${p}`);
    logo = `data:${MIME[extname(p).toLowerCase()] ?? 'application/octet-stream'};base64,${readFileSync(p).toString('base64')}`;
  }
  for (const k of ['accent', 'accentLight', 'accentDark']) if (b[k] && !HEX.test(b[k])) throw new Error(`brand ${k} must be a hex colour`);
  return { name: b.name ?? '', logo, accent: b.accent ?? '#2a78d6', accentLight: b.accentLight ?? b.accent ?? '#256abf', accentDark: b.accentDark ?? '#6da7ec' };
}

function assemble(file) {
  return readFileSync(join(TEMPLATE, file), 'utf8')
    .replace(/<!--#include (\S+) -->/g, (_, p) => readFileSync(join(TEMPLATE, p), 'utf8'));
}

/**
 * Turn on the Quality tab. The checks run in the page; this only attaches the optional reviewer
 * notes (Markdown) as safe HTML, dated by the file's modification time.
 */
export function attachQuality(model, notesFile) {
  const q = { notes: null, notesDate: null };
  if (notesFile) {
    if (!existsSync(notesFile)) throw new Error(`quality notes not found: ${notesFile}`);
    q.notes = markdown(readFileSync(notesFile, 'utf8'), { keys: new Set(model.issues.map(i => i.k)) });
    q.notesDate = statSync(notesFile).mtime.toISOString().slice(0, 10);
  }
  model.meta.quality = q;
  return model;
}

export function render(model, brand) {
  // JSON inside <script>: escape "<" so no string in the data can close the element.
  const data = JSON.stringify(model).replace(/</g, '\\u003c');
  const title = `${model.meta.title} · ${model.meta.projectName}`;
  const brandCss = `:root { --accent: ${brand.accent}; --accent-light: ${brand.accentLight}; --accent-dark: ${brand.accentDark}; }`;
  const logo = brand.logo ? `<img src="${brand.logo}" alt="${escHtml(brand.name)}">` : '';
  const html = assemble('report.html');
  // Function replacers: the data may contain "$&"-style sequences that string replacement would expand.
  return html
    .replace('__TITLE__', () => escHtml(title))
    .replace('__HEADING__', () => escHtml(model.meta.title))
    .replace('__BRAND_CSS__', () => brandCss)
    .replace('__LOGO__', () => logo)
    .replace('__DATA__', () => data);
}
