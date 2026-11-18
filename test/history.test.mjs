import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarize, writeSummary, loadHistory, lastPerDay, trends, SUMMARY_VERSION, QUALITY_RULES } from '../lib/history.mjs';
import { buildModel } from '../lib/model.mjs';
import { synthetic } from '../lib/example/synthetic.mjs';

const DAY = 86_400_000;
const T0 = Date.parse('2026-03-02T10:00:00Z');
const statuses = { td: { n: 'To Do', c: 'new' }, ip: { n: 'In Progress', c: 'indeterminate' }, dn: { n: 'Done', c: 'done' } };
const st = (d, from, to) => [T0 + d * DAY, 'u', 'status', from, to, from, to];
const issue = (id, k, cur, h = [], extra = {}) => ({ id, k, t: `Issue ${k}`, ty: 'Task', lvl: 0, st: cur, cr: T0, h, rp: 'acc-1', d: '', ln: [], par: null, ...extra });
const model = (issues, now) => ({ meta: { host: 'x.atlassian.net', project: 'P', generatedAt: now, statuses, milestones: [], forecast: { runs: 200 }, externalParents: {} }, people: { 'acc-1': ['Ada Lind'] }, issues });
// A stored row: [id, key, summary, lvl, cat, completedAt, reporter, score]
const run = (day, rows, extra = {}) => ({ v: SUMMARY_VERSION, host: 'x.atlassian.net', project: 'P', generatedAt: T0 + day * DAY, day: `d${day}`, qualityRules: 'r1', people: { 'acc-1': 'Ada Lind' }, forecast: { remaining: rows.length, p50: T0 + (day + 10) * DAY, p85: T0 + (day + 20) * DAY, target: null, prob: null }, issues: rows, ...extra });

test('summarize stores one compact row per issue, quality and the default forecast', () => {
  const m = buildModel(synthetic());
  const s = summarize(m);
  assert.equal(s.v, SUMMARY_VERSION);
  assert.equal(s.issues.length, m.issues.length);
  assert.equal(s.qualityRules, QUALITY_RULES);
  const [id, k, , lvl, cat, , , score] = s.issues[0];
  assert.equal(id, m.issues[0].id); assert.equal(k, m.issues[0].k);
  assert.equal(typeof lvl, 'number'); assert.ok(['new', 'indeterminate', 'done'].includes(cat));
  assert.ok(score === null || (score >= 0 && score <= 1));
  assert.ok(s.issues.some(r => r[7] != null), 'quality is scored even without --quality');
  assert.equal(s.forecast.remaining, m.issues.filter(i => i.lvl === 0 && m.meta.statuses[i.st].c !== 'done').length);
  assert.equal(s.forecast.target?.name, m.meta.milestones[0]?.name);
});

test('write and load: 0600 files, last run per day, foreign or broken files skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-hist-'));
  try {
    const base = { v: SUMMARY_VERSION, host: 'h', project: 'P', issues: [] };
    const a = writeSummary(dir, { ...base, generatedAt: Date.parse('2026-03-02T09:00:00'), day: '2026-03-02' });
    writeSummary(dir, { ...base, generatedAt: Date.parse('2026-03-02T15:00:00'), day: '2026-03-02', mark: 'later' });
    writeSummary(dir, { ...base, generatedAt: Date.parse('2026-03-03T09:00:00'), day: '2026-03-03' });
    writeFileSync(join(dir, 'other.json'), JSON.stringify({ ...base, project: 'Q', generatedAt: 1, day: 'x' }));
    writeFileSync(join(dir, 'broken.json'), '{');
    assert.equal(statSync(a).mode & 0o777, 0o600);
    assert.equal(readdirSync(dir).length, 5, 'two runs on one day are two files');
    const logged = [];
    const got = loadHistory(dir, { host: 'h', project: 'P', log: m => logged.push(m) });
    assert.equal(got.length, 3);
    assert.equal(logged.length, 2);
    const days = lastPerDay(got);
    assert.deepEqual(days.map(s => s.day), ['2026-03-02', '2026-03-03']);
    assert.equal(days[0].mark, 'later');
    assert.deepEqual(loadHistory(join(dir, 'missing'), { host: 'h', project: 'P' }), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('trends: the forecast check follows the work open at each run, matched by id', () => {
  const now = T0 + 40 * DAY;
  const current = model([
    issue('1', 'P-1', 'dn', [st(1, 'td', 'ip'), st(5, 'ip', 'dn')]),
    issue('2', 'Q-7', 'dn', [st(25, 'td', 'dn')]),       // moved to another key: still matched by id
    issue('3', 'P-3', 'ip', [st(3, 'td', 'ip')]),
  ], now);
  const earlier = [
    run(0, [['1', 'P-1', 'a', 0, 'new', null, 'acc-1', 0.5], ['2', 'P-2', 'b', 0, 'new', null, 'acc-1', 0.3], ['9', 'P-9', 'gone', 0, 'done', T0, 'acc-1', 0.2]]),
    run(2, [['1', 'P-1', 'a', 0, 'indeterminate', null, 'acc-1', 0.9], ['2', 'P-2', 'b', 0, 'new', null, 'acc-1', 0.7], ['4', 'P-4', 'gone too', 0, 'new', null, null, null]]),
  ];
  const t = trends(earlier, current);
  assert.deepEqual(t.runs.map(r => r.check), [
    { open: 2, done: 2, stillOpen: 0, lost: 0, lastDone: T0 + 25 * DAY },
    { open: 3, done: 2, stillOpen: 0, lost: 1, lastDone: T0 + 25 * DAY },
  ]);
  assert.deepEqual(t.lost.map(l => l.k).sort(), ['P-4', 'P-9']);
  assert.equal(t.lost.find(l => l.k === 'P-4').lastSeen, T0 + 2 * DAY);
  const q = t.runs[0].quality;
  assert.equal(q.n, 3); assert.equal(q.Good, 0); assert.equal(q.Fair, 1); assert.equal(q.Poor, 2);
  assert.ok(Math.abs(q.mean - (0.5 + 0.3 + 0.2) / 3) < 1e-9);
  assert.deepEqual(t.runs[1].quality.byReporter['acc-1'], [0.8, 2]);
});

test('trends: work still open is counted, and the current run has no check', () => {
  const now = T0 + 40 * DAY;
  const current = model([issue('1', 'P-1', 'dn', [st(5, 'td', 'dn')]), issue('3', 'P-3', 'ip', [st(3, 'td', 'ip')])], now);
  const t = trends([run(0, [['1', 'P-1', 'a', 0, 'new', null, null, null], ['3', 'P-3', 'c', 0, 'new', null, null, null]]), { ...run(40, []), generatedAt: now }], current);
  assert.deepEqual(t.runs[0].check, { open: 2, done: 1, stillOpen: 1, lost: 0, lastDone: null });
  assert.equal(t.runs[1].current, true);
  assert.equal(t.runs[1].check, null);
});
