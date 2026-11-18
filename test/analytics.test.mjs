import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from '../lib/config.mjs';

// Same realm as the test (a vm context would make deepStrictEqual fail on its arrays).
const JRA = new Function(readFileSync(join(REPO, 'template/app/analytics.js'), 'utf8') + '\nreturn JRA;')();
const DAY = 86_400_000;
const T0 = Date.parse('2026-01-05T09:00:00Z');   // a Monday
const NOW = T0 + 30 * DAY;

const meta = { generatedAt: NOW, statuses: { td: { n: 'To Do', c: 'new' }, ip: { n: 'In Progress', c: 'indeterminate' }, rt: { n: 'In review', c: 'indeterminate' }, dn: { n: 'Done', c: 'done' } } };
const st = (d, from, to) => [T0 + d * DAY, 'u', 'status', from, to, from, to];
const issue = (k, st_, h, crDay = 0) => ({ k, st: st_, cr: T0 + crDay * DAY, h, lvl: 0 });

test('timeline starts in the first transition\'s from-status and ends now', () => {
  const A = JRA.context({ meta, issues: [] });
  const i = issue('A-1', 'dn', [st(2, 'td', 'ip'), st(5, 'ip', 'dn')]);
  assert.deepEqual(A.timeline(i).map(s => [s[0], (s[1] - T0) / DAY, (s[2] - T0) / DAY]), [['td', 0, 2], ['ip', 2, 5], ['dn', 5, 30]]);
  assert.equal(A.cycleDays(i), 3);
  assert.equal(A.leadDays(i), 5);
});

test('an issue with no history sits in its current status since creation', () => {
  const A = JRA.context({ meta, issues: [] });
  const i = issue('A-2', 'ip', [], 4);
  assert.equal(A.statusAt(i, T0 + 10 * DAY), 'ip');
  assert.equal(A.statusAt(i, T0 + 3 * DAY), null, 'not yet created');
  assert.equal(A.completedAt(i), null);
});

test('reopened issues stop counting as done and completion is the last entry into done', () => {
  const A = JRA.context({ meta, issues: [] });
  const i = issue('A-3', 'dn', [st(1, 'td', 'ip'), st(3, 'ip', 'dn'), st(6, 'dn', 'ip'), st(9, 'ip', 'dn')]);
  assert.equal(A.reopens(i), 1);
  assert.equal(A.catAt(i, T0 + 7 * DAY), 'indeterminate');
  assert.equal(A.completedAt(i), T0 + 9 * DAY);
  assert.equal(A.cycleDays(i), 8, 'measured from the first start');
});

test('burn-up counts scope by creation and done by status at end of day', () => {
  const A = JRA.context({ meta, issues: [] });
  const issues = [issue('B-1', 'dn', [st(2, 'td', 'dn')]), issue('B-2', 'td', [], 1), issue('B-3', 'dn', [st(3, 'td', 'dn'), st(4, 'dn', 'td'), st(5, 'td', 'dn')], 1)];
  const bu = A.burnup(issues, T0, T0 + 6 * DAY);
  assert.equal(bu.x.length, 7);
  assert.deepEqual(bu.scope, [1, 3, 3, 3, 3, 3, 3]);
  assert.deepEqual(bu.done, [0, 0, 1, 2, 1, 2, 2]);
});

test('cumulative flow maps statuses to bands and skips unmapped ones', () => {
  const A = JRA.context({ meta, issues: [] });
  const issues = [issue('C-1', 'ip', [st(1, 'td', 'ip')]), issue('C-2', 'rt', [st(1, 'td', 'rt')])];
  const c = A.cfd(issues, [{ name: 'Todo', statuses: ['td'] }, { name: 'Doing', statuses: ['ip'] }], T0, T0 + 2 * DAY);
  assert.deepEqual(c.bands.map(b => b.values), [[2, 0, 0], [0, 1, 1]]);
});

test('throughput buckets completions into ISO weeks, current week last', () => {
  const A = JRA.context({ meta, issues: [] });
  const done = d => issue('D-' + d, 'dn', [st(d, 'td', 'dn')]);
  const tp = A.throughput([done(0), done(1), done(8), done(29)], 5);
  assert.equal(tp.x.length, 5);
  assert.equal(new Date(tp.x[4]).getDay(), 1, 'weeks start on Monday');
  assert.deepEqual(tp.values, [2, 1, 0, 0, 1]);
});

test('time in status and transitions', () => {
  const A = JRA.context({ meta, issues: [] });
  const issues = [issue('E-1', 'dn', [st(2, 'td', 'ip'), st(6, 'ip', 'dn')]), issue('E-2', 'dn', [st(1, 'td', 'ip'), st(3, 'ip', 'dn')])];
  const tis = Object.fromEntries(A.timeInStatus(issues).map(r => [r.status, r]));
  assert.equal(tis.ip.median, 3);
  assert.equal(tis.td.median, 1.5);
  assert.deepEqual(A.transitions(issues).map(t => [t.from, t.to, t.n]), [['td', 'ip', 2], ['ip', 'dn', 2]]);
});

test('Monte Carlo is deterministic, bounded and monotone', () => {
  const a = JRA.monteCarlo({ remaining: 20, throughput: [2, 3, 5, 0, 4], runs: 1000 });
  const b = JRA.monteCarlo({ remaining: 20, throughput: [2, 3, 5, 0, 4], runs: 1000 });
  assert.deepEqual(a.weeks, b.weeks, 'seeded');
  assert.ok(a.percentile(0.5) >= 4 && a.percentile(0.5) <= 10);
  assert.ok(a.percentile(0.85) >= a.percentile(0.5));
  assert.ok(a.probWithin(a.percentile(0.85)) >= 0.85);
  assert.equal(JRA.monteCarlo({ remaining: 5, throughput: [0, 0] }).feasible, false);
  assert.equal(JRA.monteCarlo({ remaining: 0, throughput: [] }).probWithin(0), 1);
  const g = JRA.monteCarlo({ remaining: 20, throughput: [2, 3, 5, 0, 4], arrivals: [1, 1, 1, 1, 1], runs: 1000 });
  assert.ok(g.percentile(0.5) >= a.percentile(0.5), 'scope growth never makes it faster');
});

test('pivot counts multi-valued dimensions once per value and uses (none)', () => {
  const issues = [{ lb: ['a', 'b'], ty: 'Bug' }, { lb: [], ty: 'Bug' }, { lb: ['a'], ty: 'Task' }];
  const p = JRA.pivot(issues, i => i.lb, i => [i.ty]);
  assert.equal(p.rows.get('a'), 2);
  assert.equal(p.rows.get('(none)'), 1);
  assert.equal(p.cell('a', 'Bug'), 1);
  assert.equal(p.cols.get('Bug'), 2);
  assert.equal(p.total, 3);
});

test('quantile interpolates', () => {
  assert.equal(JRA.quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(JRA.quantile([], 0.5), null);
});
