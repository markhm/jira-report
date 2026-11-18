// Render the example data (offline; no credentials) at a fixed date, for the smoke test:
//   reports/fixture.html            one space, with a made-up run history and the Quality tab
//   reports/fixture-first-run.html  a first run: no history, no Quality tab
//   reports/fixture-portfolio.html  two spaces, four workstreams, with a made-up history
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exampleModel } from '../../lib/example.mjs';
import { render, loadBrand } from '../../lib/render.mjs';
import { REPO } from '../../lib/config.mjs';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const brand = loadBrand(process.argv[2] ? join(REPO, 'brands', process.argv[2]) : join(REPO, 'test', 'fixtures', 'brand'));

for (const [file, model] of [
  ['fixture.html', exampleModel({ now: NOW })],
  ['fixture-first-run.html', exampleModel({ now: NOW, history: false, quality: false })],
  ['fixture-portfolio.html', exampleModel({ now: NOW, portfolio: true })],
]) {
  const out = join(REPO, 'reports', file);
  writeFileSync(out, render(model, brand));
  console.log(out);
}
