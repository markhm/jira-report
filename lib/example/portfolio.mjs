// A synthetic two-space portfolio, shaped like what bin/jira-report.mjs feeds mergeSpaces():
//   DEMO, two boards: "Requirements" (features and epics, done = Approved) and "Development"
//   (bugs, tasks, subtasks, done = Done).
//   OPS, one board "Operations" (no bugs); its bugs are on no board and form their own workstream.
// Crossings: OPS issues under a DEMO epic, an OPS → DEMO link, and a link to a space outside (EXT).
import { synthetic } from './synthetic.mjs';
import { mergeSpaces } from '../portfolio.mjs';

const URL = (space, board) => `https://example.atlassian.net/jira/software/c/projects/${space}/boards/${board}`;

/** Requirements are done when Approved: move their Done status (and history) to Approved. */
function approveInsteadOfDone(issue, changelog) {
  const swap = (id, name) => (id === '10004' ? ['10005', 'Approved'] : [id, name]);
  const st = issue.fields.status;
  if (st.id === '10004') issue.fields.status = { ...st, id: '10005', name: 'Approved' };
  for (const h of changelog ?? []) for (const it of h.items) {
    if (it.field !== 'status') continue;
    [it.from, it.fromString] = swap(it.from, it.fromString);
    [it.to, it.toString] = swap(it.to, it.toString);
  }
}

export function portfolioRaw({ now } = {}) {
  const demo = synthetic({ now, key: 'DEMO' });
  const ops = synthetic({ now, n: 70, seed: 11, key: 'OPS', idBase: 50000, projectName: 'OPS - Operations' });

  const isReq = i => ['Feature', 'Epic'].includes(i.fields.issuetype.name);
  for (const i of demo.issues) if (isReq(i)) approveInsteadOfDone(i, demo.changelogs[i.id]);
  const cols = demo.boards[0].columns;
  demo.boards = [
    { id: 202, name: 'Requirements', type: 'kanban', jql: 'project = DEMO AND type in (Feature, Epic)', keys: demo.issues.filter(isReq).map(i => i.key), columns: cols },
    { id: 201, name: 'Development', type: 'kanban', jql: 'project = DEMO AND type not in (Feature, Epic)', keys: demo.issues.filter(i => !isReq(i)).map(i => i.key), columns: cols },
  ];

  const isBug = i => i.fields.issuetype.name === 'Bug';
  ops.boards = [{ id: 900, name: 'Operations', type: 'kanban', jql: 'project = OPS AND type != Bug', keys: ops.issues.filter(i => !isBug(i)).map(i => i.key), columns: cols }];
  // Crossings between and beyond the spaces.
  ops.issues.filter(i => !isBug(i) && i.fields.issuetype.name !== 'Epic' && !i.fields.issuetype.subtask).slice(0, 3).forEach(i => { i.fields.parent = { key: 'DEMO-1', fields: { summary: 'Order Capture' } }; });
  const linker = ops.issues.find(i => !isBug(i) && i.fields.issuetype.hierarchyLevel === 0 && !i.fields.parent?.key?.startsWith('DEMO-'));
  linker.fields.issuelinks = [...linker.fields.issuelinks, { type: { inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'DEMO-20' } }, { type: { inward: 'relates to', outward: 'relates to' }, outwardIssue: { key: 'EXT-7' } }];

  const spec = { name: 'demo-ops', title: 'Demo portfolio' };
  const resolved = {
    host: 'example.atlassian.net',
    streams: [{ project: 'DEMO', board: 202, url: URL('DEMO', 202) }, { project: 'DEMO', board: 201, url: URL('DEMO', 201) }, { project: 'OPS', board: 900, url: URL('OPS', 900) }],
  };
  return { ...mergeSpaces([demo, ops], resolved, spec), generatedAt: demo.generatedAt };
}
