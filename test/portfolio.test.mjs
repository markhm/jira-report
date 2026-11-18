import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { portfolioSpec, resolveStreams, savePortfolio } from '../lib/portfolio.mjs';
import { buildModel } from '../lib/model.mjs';
import { summarize, trends } from '../lib/history.mjs';
import { synthetic } from '../lib/example/synthetic.mjs';
import { portfolioRaw } from '../lib/example/portfolio.mjs';

const U = (space, board) => `https://example.atlassian.net/jira/software/c/projects/${space}/boards/${board}`;

test('portfolio spec: one URL stays a plain report, several need a name, saved ones load by name', () => {
  assert.equal(portfolioSpec([U('DEMO', 1)]), null);
  assert.throws(() => portfolioSpec([U('DEMO', 1), U('OPS', 2)]), /--name/);
  assert.deepEqual(portfolioSpec([U('DEMO', 1), U('OPS', 2)], { name: 'demo-ops' }).streams.map(s => s.url), [U('DEMO', 1), U('OPS', 2)]);
  assert.throws(() => portfolioSpec([U('DEMO', 1)], { name: 'login' }), /is a command/);
  assert.throws(() => portfolioSpec([U('DEMO', 1)], { name: 'a b' }), /letters, digits/);
  const config = { portfolios: { 'demo-ops': { title: 'Demo', streams: [U('DEMO', 1), { url: U('OPS', 2), name: 'Ops' }] } } };
  assert.deepEqual(portfolioSpec(['demo-ops'], {}, config), { name: 'demo-ops', title: 'Demo', streams: [{ url: U('DEMO', 1) }, { url: U('OPS', 2), name: 'Ops' }] });
  assert.throws(() => portfolioSpec(['nope'], {}, config), /known: demo-ops/);
  assert.throws(() => portfolioSpec(['demo-ops', U('DEMO', 1)], {}, config), /not both/);
});

test('streams resolve a board to its space, one collect per space, one site only', async () => {
  const jira = { board: async id => ({ location: { projectKey: id === 3 ? 'OPS' : 'DEMO' } }) };
  const r = await resolveStreams({ streams: [{ url: U('DEMO', 1) }, { url: U('DEMO', 2) }, { url: 'https://example.atlassian.net/jira/software/c/boards/3' }] }, jira);
  assert.deepEqual(r.spaces, [{ project: 'DEMO', board: 1 }, { project: 'OPS', board: 3 }]);
  await assert.rejects(resolveStreams({ streams: [{ url: U('DEMO', 1) }, { url: 'https://other.atlassian.net/jira/software/c/projects/OPS/boards/3' }] }, jira), /one Jira site/);
  await assert.rejects(resolveStreams({ streams: [{ url: U('DEMO', 1) }, { url: U('DEMO', 1) + '/backlog' }] }, jira), /listed twice/);
});

test('merge: board workstreams, off-board issues as their own workstream, nothing in scope uncounted', () => {
  const raw = portfolioRaw();
  const p = raw.portfolio;
  assert.deepEqual(p.streams.map(s => [s.id, s.name]), [['b202', 'Requirements'], ['b201', 'Development'], ['b900', 'Operations'], ['n:OPS', 'OPS · not on a listed board']]);
  assert.deepEqual(p.spaces.map(s => s.key), ['DEMO', 'OPS']);
  const bugs = raw.issues.filter(i => i.key.startsWith('OPS-') && i.fields.issuetype.name === 'Bug').map(i => i.key).sort();
  assert.ok(bugs.length > 0);
  assert.deepEqual(Object.keys(raw.streamOf).filter(k => raw.streamOf[k].includes('n:OPS')).sort(), bugs);
  for (const i of raw.issues) assert.ok(raw.streamOf[i.key]?.length, `${i.key} belongs to a workstream`);
  assert.equal(new Set(raw.issues.map(i => i.key)).size, raw.issues.length, 'no duplicates');
  assert.ok(!raw.issues.some(i => i.key.startsWith('EXT-')), 'a linked space outside the portfolio stays outside');
});

test('boards with the same name in different spaces stay apart', async () => {
  const { mergeSpaces } = await import('../lib/portfolio.mjs');
  const a = synthetic({ n: 10, key: 'DEMO' }), b = synthetic({ n: 10, seed: 3, key: 'OPS', idBase: 50000 });
  a.boards = [{ ...a.boards[0], id: 1, name: 'Delivery' }]; b.boards = [{ ...b.boards[0], id: 2, name: 'Delivery' }];
  const raw = mergeSpaces([a, b], { host: 'example.atlassian.net', streams: [{ project: 'DEMO', board: 1, url: U('DEMO', 1) }, { project: 'OPS', board: 2, url: U('OPS', 2) }] }, { name: 'x', title: 'X' });
  assert.deepEqual(raw.portfolio.streams.map(s => s.name), ['Delivery (DEMO)', 'Delivery (OPS)']);
});

test('model: space and workstreams per issue, cross-space parents resolve inside the portfolio', () => {
  const m = buildModel(portfolioRaw());
  const i = m.issues.find(x => x.ln.some(l => l[1] === 'DEMO-20'));
  assert.equal(i.sp, 'OPS');
  assert.deepEqual(i.ws, ['b900']);
  assert.equal(m.meta.portfolio.name, 'demo-ops');
  assert.equal(m.meta.project, 'demo-ops');
  assert.ok(!('DEMO-1' in m.meta.externalParents), 'the DEMO epic of OPS issues is in scope now');
  assert.equal(m.issues.filter(x => x.par === 'DEMO-1' && x.sp === 'OPS').length, 3);
});

test('a plain report has no portfolio fields', () => {
  const m = buildModel(synthetic({ n: 20 }));
  assert.ok(!('portfolio' in m.meta));
  assert.ok(m.issues.every(i => !('sp' in i) && !('ws' in i)));
});

test('custom fields count their fill per space in a portfolio', () => {
  const raw = portfolioRaw();
  raw.fields = [...raw.fields, { id: 'customfield_20000', name: 'Ops team', custom: true, schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' } }];
  const ops = raw.issues.filter(i => i.key.startsWith('OPS-')).slice(0, 5);
  for (const i of ops) i.fields.customfield_20000 = { value: 'Night shift' };
  assert.ok(ops.length / raw.issues.length < 0.05, 'below the threshold across the portfolio');
  assert.ok(buildModel(raw).meta.customFields.some(f => f.id === 'customfield_20000'), 'kept: above the threshold within its space');
});

test('history keeps a forecast and the membership per workstream, from the first run', () => {
  const m = buildModel(portfolioRaw());
  const s = summarize(m);
  assert.deepEqual(Object.keys(s.streams), ['b202', 'b201', 'b900', 'n:OPS']);
  assert.ok(s.streams.b202.remaining > 0);
  const linker = m.issues.find(x => x.ln.some(l => l[1] === 'DEMO-20'));
  assert.deepEqual(s.issues.find(r => r[1] === linker.k)[8], ['b900']);
  const earlier = { ...s, generatedAt: s.generatedAt - 14 * 86_400_000, day: '2026-09-10' };
  const h = trends([earlier, s], m);
  const run = h.runs.find(r => !r.current);
  assert.equal(run.streams.b900.check.open, earlier.issues.filter(r => r[3] === 0 && r[4] !== 'done' && r[8].includes('b900')).length);
  assert.ok(h.runs.find(r => r.current).streams.b900.forecast);
});

test('a plain report keeps its summary format', () => {
  const s = summarize(buildModel(synthetic({ n: 20 })));
  assert.ok(!('streams' in s));
  assert.ok(s.issues.every(r => r.length === 8));
});

test('--save writes the portfolio into the local config file and keeps its other keys', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'jr-')), 'jira-report.local.json');
  writeFileSync(file, JSON.stringify({ brand: 'brands/acme', milestones: [{ name: 'UAT', date: '2027-01-15' }] }));
  savePortfolio({ _file: file, brand: '/abs/brands/acme' }, { name: 'demo-ops', title: 'Demo', streams: [{ url: U('DEMO', 1), name: 'Requirements' }] });
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.brand, 'brands/acme', 'relative paths stay as written');
  assert.deepEqual(saved.portfolios['demo-ops'], { title: 'Demo', streams: [{ name: 'Requirements', url: U('DEMO', 1) }] });
});
