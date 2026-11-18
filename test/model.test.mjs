import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, customValue } from '../lib/model.mjs';
import { adfToText } from '../lib/adf.mjs';
import { parseTarget } from '../lib/config.mjs';
import { render, loadBrand } from '../lib/render.mjs';
import { synthetic } from '../lib/example/synthetic.mjs';
import { join } from 'node:path';
import { REPO } from '../lib/config.mjs';

test('parseTarget reads board, project and browse URLs', () => {
  assert.deepEqual(parseTarget('https://example.atlassian.net/jira/software/c/projects/DEMO/boards/202'), { host: 'example.atlassian.net', project: 'DEMO', board: 202 });
  assert.deepEqual(parseTarget('https://example.atlassian.net/jira/software/c/projects/demo/boards/201/backlog?x=1'), { host: 'example.atlassian.net', project: 'DEMO', board: 201 });
  assert.deepEqual(parseTarget('https://x.atlassian.net/browse/ABC-12'), { host: 'x.atlassian.net', project: 'ABC', board: null });
  assert.deepEqual(parseTarget('https://x.atlassian.net/secure/RapidBoard.jspa?rapidView=9'), { host: 'x.atlassian.net', project: null, board: 9 });
  assert.throws(() => parseTarget('example.atlassian.net'), /not a Jira URL/);
  assert.throws(() => parseTarget('https://x.atlassian.net/wiki'), /cannot find/);
});

test('ADF becomes readable text', () => {
  const doc = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Hi ' }, { type: 'mention', attrs: { text: '@Ann' } }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }] }] },
  ] };
  assert.equal(adfToText(doc), 'Hi @Ann\n\n• one\n• two\n\na | b');
  assert.equal(adfToText(null), '');
});

test('customValue flattens Jira field shapes', () => {
  assert.equal(customValue({ value: 'Wave 1' }), 'Wave 1');
  assert.equal(customValue({ value: 'A', child: { value: 'B' } }), 'A › B');
  assert.deepEqual(customValue([{ value: 'x' }, { name: 'y' }]), ['x', 'y']);
  assert.equal(customValue([]), null);
  assert.equal(customValue(''), null);
  assert.equal(customValue(3), 3);
});

test('buildModel: people, board tags, custom fields over the fill threshold, history', () => {
  const raw = synthetic({ n: 60 });
  const m = buildModel(raw);
  assert.equal(m.issues.length, 65);
  assert.deepEqual(m.meta.customFields, [{ id: 'customfield_10050', name: 'Release wave' }], 'rank is skipped; wave kept');
  const bug = m.issues.find(i => i.ty === 'Bug');
  assert.deepEqual(bug.b.sort(), [201, 202]);
  assert.ok(m.people['acc-0'][0] === 'Ada Lind' && m.people['acc-0'][1].endsWith('@example.test'));
  const withHist = m.issues.find(i => i.h.some(h => h[2] === 'status'));
  const s = withHist.h.find(h => h[2] === 'status');
  assert.ok(m.meta.statuses[s[5]] && m.meta.statuses[s[6]], 'status ids resolve');
  assert.ok(withHist.h.every((h, k, a) => k === 0 || a[k - 1][0] <= h[0]), 'history sorted');
  assert.equal(m.meta.milestones[0].date, '2027-01-15');
  assert.deepEqual(m.meta.priorities.slice(0, 2), ['Highest', 'High']);

  const sparse = buildModel({ ...raw, config: { ...raw.config, customFieldMinFill: 0.99 } });
  assert.deepEqual(sparse.meta.customFields, [], 'below threshold → dropped');
});

test('buildModel keeps unknown historical statuses and external parents', () => {
  const raw = synthetic({ n: 3 });
  const i = raw.issues[raw.issues.length - 1];
  raw.changelogs[i.id] = [{ created: '2026-05-01T10:00:00.000+0000', author: null, items: [{ field: 'status', from: '999', fromString: 'Old status', to: '3', toString: 'In Progress' }] }];
  i.fields.parent = { key: 'OTHER-1', fields: { summary: 'Epic elsewhere' } };
  const m = buildModel(raw);
  assert.deepEqual(m.meta.statuses['999'], { n: 'Old status', c: 'indeterminate' });
  assert.equal(m.meta.externalParents['OTHER-1'], 'Epic elsewhere');
});

test('render inlines everything and data cannot break out of its script element', () => {
  const html = render(buildModel(synthetic({ n: 20 })), loadBrand(join(REPO, 'test', 'fixtures', 'brand')));
  const data = html.slice(html.indexOf('<script type="application/json" id="jr-data">'), html.indexOf('</script>', html.indexOf('id="jr-data"')));
  assert.ok(!data.slice(10).includes('<'), 'no raw < inside the data block');
  assert.ok(html.includes('Looks good $& \\u003c/script>'), '$& survives replacement literally');
  assert.ok(!/<(script|link)[^>]+(src|href)=["']https?:/i.test(html), 'no external resources');
  assert.ok(html.includes('data:image/svg+xml;base64,'), 'logo inlined');
  assert.ok(!html.includes('<!--#include'), 'all includes resolved');
  assert.ok(!/__[A-Z_]+__/.test(html.replace(/__proto__/g, '')), 'all placeholders filled');
});

test('an issue\'s own status category wins over a category guessed from history', () => {
  const raw = synthetic({ n: 3 });
  raw.statuses = [];                                   // e.g. /status not readable
  const done = raw.issues.find(i => i.fields.status.id === '10004') ?? raw.issues[raw.issues.length - 1];
  done.fields.status = { id: '10004', name: 'Done', statusCategory: { key: 'done' } };
  const other = raw.issues.find(i => i !== done && i.fields.issuetype.hierarchyLevel === 0);
  raw.changelogs[other.id] = [{ created: '2026-05-01T10:00:00.000+0000', author: null, items: [{ field: 'status', from: '3', fromString: 'In Progress', to: '10004', toString: 'Done' }] }];
  raw.issues = [other, done];                          // history seen before the issue itself
  assert.equal(buildModel(raw).meta.statuses['10004'].c, 'done');
});

test('history timestamps may be epoch numbers (bulk changelog API) or ISO strings', () => {
  const raw = synthetic({ n: 3 });
  const i = raw.issues[raw.issues.length - 1];
  raw.changelogs[i.id] = [
    { created: 1790000000000, author: null, items: [{ field: 'status', from: '10002', fromString: 'To Do', to: '3', toString: 'In Progress' }] },
    { created: '2026-09-20T12:00:00.000+0200', author: null, items: [{ field: 'status', from: '3', fromString: 'In Progress', to: '10003', toString: 'In review' }] },
  ];
  const h = buildModel(raw).issues.find(x => x.k === i.key).h.filter(e => e[2] === 'status');
  assert.deepEqual(h.map(e => e[0]), [Date.parse('2026-09-20T10:00:00.000Z'), 1790000000000], 'both parsed, sorted by time');
  assert.ok(h.every(e => Number.isFinite(e[0])));
});
