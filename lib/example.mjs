// Example reports from synthetic data: no Jira, no credentials, fictional people and issues.
// Used by `jira-report example` and by the test fixtures (with a fixed date, so they are stable).

import { join } from 'node:path';
import { REPO } from './config.mjs';
import { buildModel } from './model.mjs';
import { attachQuality } from './render.mjs';
import { summarize, trends, JRA } from './history.mjs';
import { synthetic } from './example/synthetic.mjs';
import { portfolioRaw } from './example/portfolio.mjs';

const DAY = 86_400_000;
export const EXAMPLE_NOTES = join(REPO, 'lib', 'example', 'quality-notes.md');

/** The model as a run at time T would have seen it: issues created by then, history up to then. */
function asOf(model, T) {
  const A = JRA.context(model);
  const issues = model.issues.filter(i => i.cr <= T).map(i => ({ ...i, st: A.statusAt(i, T), h: i.h.filter(h => h[0] <= T) }));
  return { ...model, meta: { ...model.meta, generatedAt: T }, issues };
}

/** Earlier runs every two weeks, with lower quality scores and one issue that later left the scope. */
export function exampleHistory(model) {
  const now = model.meta.generatedAt;
  const runs = [56, 42, 28, 14].map(ago => summarize(asOf(model, now - ago * DAY)));
  runs.forEach((s, k) => { for (const r of s.issues) if (r[7] != null) r[7] = Math.max(0, r[7] - 0.04 * (runs.length - k)); });
  runs[0].qualityRules = 'older-rules';
  for (const s of runs) s.issues.push(['99999', 'DEMO-999', 'Moved to another project', 0, 'done', now - 70 * DAY, 'acc-1', 0.4]);
  return runs;
}

/**
 * An example model, ready to render.
 *   portfolio: the two-space, four-workstream portfolio instead of a single space
 *   history:   embed made-up earlier runs (trend cards filled) or only this run
 *   quality:   add the Quality tab (single space: with example reviewer notes)
 *   milestones: overrides the example's own target date
 */
export function exampleModel({ now = Date.now(), portfolio = false, history = true, quality = true, milestones = null, title = null } = {}) {
  const raw = portfolio ? portfolioRaw({ now }) : synthetic({ now });
  if (milestones) raw.config = { ...raw.config, milestones };
  if (title) raw.config = { ...raw.config, title };
  const model = buildModel(raw);
  if (quality) attachQuality(model, portfolio ? null : EXAMPLE_NOTES);
  model.meta.history = trends([...(history ? exampleHistory(model) : []), summarize(model)], model);
  return model;
}
