// Per-run summaries, kept next to the report, for the trends Jira's changelog cannot give back:
// content quality over time, issues that left the scope, and how past forecasts turned out.
// Flow trends (burn-up, CFD, throughput, cycle time) are rebuilt from the changelog on every run
// and are not stored here.
//
// One file per run: <report folder>/history/<YYYY-MM-DD>_<HHMMSS>.json (local time, 0600).
// When reading, the last run of each day counts. Summary rows (compact, like the model):
//   issues: [[id, key, summary, lvl, statusCategory, completedAt|null, reporter|null, qualityScore|null, streams?]]
// Portfolio reports add, without a format change: each row's workstream ids (row[8]) and one
// forecast per workstream (`streams`). Board membership is not in Jira's changelog, so it has to
// be kept from the first run for per-workstream track records.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { REPO } from './config.mjs';

export const SUMMARY_VERSION = 1;
const app = (file, name) => { const src = readFileSync(join(REPO, 'template/app', file), 'utf8'); return { ns: new Function(`${src}\nreturn ${name};`)(), src }; };
/** The page's own analytics and quality checks, evaluated in Node so stored numbers match the report. */
export const { ns: JRA } = app('analytics.js', 'JRA');
export const { ns: JRQ, src: QSRC } = app('quality.js', 'JRQ');
/** Fingerprint of the quality rules: scores from different rule sets are not comparable. */
export const QUALITY_RULES = createHash('sha256').update(QSRC).digest('hex').slice(0, 10);

const pad = n => String(n).padStart(2, '0');
const localDay = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const stamp = t => { const d = new Date(t); return `${localDay(t)}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; };

export const historyDir = reportFile => join(dirname(reportFile), 'history');

/** Model → the summary stored for this run. Pure. The forecast is the report's default view. */
export function summarize(model) {
  const { meta } = model;
  const A = JRA.context(model);
  const Q = JRQ.assess(model.issues, { epicOf: JRA.epicResolver(model) });
  const m = meta.milestones?.[0];
  const target = m ? { name: m.name, date: m.date, t: new Date(m.date + 'T23:59:59').getTime() } : null;
  const work = model.issues.filter(i => i.lvl === 0);
  const fcOf = items => {
    const fc = JRA.forecast(A, items, { weeks: meta.forecast?.weeks ?? 12, runs: meta.forecast?.runs ?? 4000, target });
    return { weeks: fc.weeks, samples: fc.samples, remaining: fc.remaining, p50: fc.p50, p85: fc.p85, p95: fc.p95, target, prob: fc.prob };
  };
  const P = meta.portfolio;
  const people = {};
  for (const i of model.issues) if (i.rp) people[i.rp] = model.people[i.rp]?.[0] ?? 'Unknown';
  return {
    v: SUMMARY_VERSION, host: meta.host, project: meta.project, generatedAt: meta.generatedAt, day: localDay(meta.generatedAt),
    qualityRules: QUALITY_RULES, people,
    forecast: fcOf(work),
    ...(P ? { streams: Object.fromEntries(P.streams.map(s => [s.id, fcOf(work.filter(i => i.ws.includes(s.id)))])) } : {}),
    issues: model.issues.map(i => [i.id, i.k, i.t, i.lvl, A.cat(i.st), A.completedAt(i), i.rp, Q.byKey.get(i.k)?.score ?? null, ...(P ? [i.ws] : [])]),
  };
}

export function writeSummary(dir, summary) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${stamp(summary.generatedAt)}.json`);
  writeFileSync(file, JSON.stringify(summary), { mode: 0o600 });
  return file;
}

/** Earlier summaries for this host + project, skipping files that are unreadable or belong elsewhere. */
export function loadHistory(dir, { host, project, log = () => {} }) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    try {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (s.v !== SUMMARY_VERSION) { log(`  ! history: skipping ${f} (format v${s.v}, expected v${SUMMARY_VERSION})`); continue; }
      if (s.host !== host || s.project !== project) { log(`  ! history: skipping ${f} (${s.host} ${s.project}, not ${host} ${project})`); continue; }
      out.push(s);
    } catch (e) { log(`  ! history: skipping ${f} (${e.message})`); }
  }
  return out;
}

/** The last run of each day, oldest first. */
export function lastPerDay(summaries) {
  const byDay = new Map();
  for (const s of [...summaries].sort((a, b) => a.generatedAt - b.generatedAt)) byDay.set(s.day, s);
  return [...byDay.values()];
}

/**
 * Earlier runs + the current model → the small trend data embedded in the report (meta.history).
 * Issues are matched by id, so an issue moved to another key is not counted as lost.
 *   runs:  per run, its forecast; how the work open at that run turned out (from today's data);
 *          and the quality scores at that run (overall, by grade, by reporter).
 *   lost:  issues seen in an earlier run that are no longer in scope (moved out or deleted).
 */
export function trends(summaries, model) {
  const A = JRA.context(model);
  const now = new Map(model.issues.map(i => [i.id, i]));
  const people = {};
  // How the standard work items open at a run turned out, from today's data.
  const check = rows => {
    const open = rows.filter(r => r[3] === 0 && r[4] !== 'done');
    let done = 0, lost = 0, lastDone = null;
    for (const r of open) {
      const i = now.get(r[0]);
      if (!i) { lost++; continue; }
      if (A.isDone(i)) { done++; lastDone = Math.max(lastDone ?? 0, A.completedAt(i)); }
    }
    return { open: open.length, done, stillOpen: open.length - done - lost, lost, lastDone: done && done === open.length - lost ? lastDone : null };
  };
  const runs = lastPerDay(summaries).map(s => {
    Object.assign(people, s.people);
    const scored = s.issues.filter(r => r[7] != null);
    const grades = { Good: 0, Fair: 0, Poor: 0 }, byReporter = {};
    let sum = 0;
    for (const r of scored) {
      sum += r[7];
      grades[r[7] >= 0.8 ? 'Good' : r[7] >= 0.5 ? 'Fair' : 'Poor']++;
      if (r[6]) { const b = (byReporter[r[6]] ??= [0, 0]); b[0] += r[7]; b[1]++; }
    }
    for (const [id, [tot, n]] of Object.entries(byReporter)) byReporter[id] = [tot / n, n];
    const current = s.generatedAt === model.meta.generatedAt;
    return {
      day: s.day, generatedAt: s.generatedAt, current,
      forecast: s.forecast,
      check: current ? null : check(s.issues),
      ...(s.streams ? { streams: Object.fromEntries(Object.entries(s.streams).map(([id, forecast]) => [id, { forecast, check: current ? null : check(s.issues.filter(r => r[8]?.includes(id))) }])) } : {}),
      quality: { rules: s.qualityRules, n: scored.length, mean: scored.length ? sum / scored.length : null, ...grades, byReporter },
    };
  });
  const lost = new Map();
  for (const s of lastPerDay(summaries)) for (const r of s.issues) if (!now.has(r[0])) lost.set(r[0], { k: r[1], t: r[2], lvl: r[3], cat: r[4], completedAt: r[5], lastSeen: s.generatedAt });
  return { runs, lost: [...lost.values()], people };
}
