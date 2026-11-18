// Deterministic synthetic Jira data, shaped like the real API responses collect() returns.
// Fictional people and issues only.

const DAY = 86_400_000;

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export const STATUSES = [
  { id: '10001', name: 'Draft', statusCategory: { key: 'new' } },
  { id: '10002', name: 'To Do', statusCategory: { key: 'new' } },
  { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
  { id: '10003', name: 'In review', statusCategory: { key: 'indeterminate' } },
  { id: '10004', name: 'Done', statusCategory: { key: 'done' } },
  { id: '10005', name: 'Approved', statusCategory: { key: 'done' } },
];
const FLOW = ['10002', '3', '10003', '10004'];
const PEOPLE = ['Ada Lind', 'Bo Kern', 'Cai Moreno', 'Dee Park', 'Eli Voss'].map((n, k) => ({ accountId: `acc-${k}`, displayName: n, emailAddress: `${n.split(' ')[0].toLowerCase()}@example.test` }));
const LABELS = ['UserInterface', 'OpenItems', 'Integration', 'Reporting', 'Migration'];
const TYPES = [{ name: 'Feature', hierarchyLevel: 0 }, { name: 'Bug', hierarchyLevel: 0 }, { name: 'Task', hierarchyLevel: 0 }];
const EPIC = { name: 'Epic', hierarchyLevel: 1 };
const SUB = { name: 'Sub-task', hierarchyLevel: -1, subtask: true };

const iso = t => new Date(t).toISOString().replace('Z', '+0000');

export function synthetic({ now = Date.parse('2026-09-24T12:00:00Z'), n = 160, seed = 7, key: KEY = 'DEMO', idBase = 20000, projectName = 'DEMO - Demo programme' } = {}) {
  const r = rng(seed), pick = a => a[Math.floor(r() * a.length)];
  const start = now - 240 * DAY;
  const issues = [], changelogs = {};
  let id = idBase;
  const status = sid => { const s = STATUSES.find(x => x.id === sid); return { id: s.id, name: s.name, statusCategory: s.statusCategory }; };

  const epics = ['Order Capture', 'Billing', 'Reporting and Analytics', 'Integrations', 'Deployment & Go-live'].map((t, k) => {
    const key = `${KEY}-${k + 1}`, iid = String(++id);
    const st = k < 2 ? '10005' : '10001';
    issues.push({ id: iid, key, fields: { summary: t, issuetype: EPIC, status: status(st), priority: { name: 'Medium' }, labels: [], components: [], fixVersions: [], assignee: null, reporter: PEOPLE[0], created: iso(start + k * DAY), updated: iso(start + 30 * DAY), resolutiondate: null, parent: null, issuelinks: [], description: null, comment: { comments: [], total: 0 }, attachment: [] } });
    changelogs[iid] = k < 2 ? [{ created: iso(start + 20 * DAY), author: PEOPLE[0], items: [{ field: 'status', fieldId: 'status', from: '10001', fromString: 'Draft', to: '10005', toString: 'Approved' }] }] : [];
    return key;
  });

  // A project in its later phase. Most scope is known early and new work tapers off towards now.
  // The team grows from two to five people and picks work roughly oldest first, so open work
  // rises, peaks and comes down, and the forecast lands in the weeks ahead.
  const arrivals = Array.from({ length: n }, () => start + (r() < 0.8 ? 1 - Math.pow(1 - r(), 0.45) : r()) * (now - start - DAY)).sort((x, y) => x - y);
  const slots = [3, 3, 40, 80, 110].map(d => start + d * DAY);              // when each person is free
  const order = arrivals.map((c, k) => [c + r() * 30 * DAY, k]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
  const plan = [];                                                          // per issue: [start, ready for test, done] or null
  for (const k of order) {
    if (r() < 0.06) { plan[k] = null; continue; }                           // parked: never picked up
    const slot = slots.indexOf(Math.min(...slots));
    const begin = Math.max(slots[slot], arrivals[k] + (0.5 + r() * 3) * DAY);
    const build = (1 + r() * 8.5) * DAY, test = (0.5 + r() * 3.5) * DAY;
    slots[slot] = begin + build + test;
    const blocked = r() < 0.07 ? (20 + r() * 25) * DAY : 0;                 // waits on someone else; the person moves on
    plan[k] = [begin, begin + build + blocked, begin + build + blocked + test];
  }

  for (let k = 0; k < n; k++) {
    const key = `${KEY}-${k + 10}`, iid = String(++id);
    const created = arrivals[k];
    const hist = [];
    let t = created, s = '10002';
    const move = (at, to) => { hist.push({ created: iso(at), author: pick(PEOPLE), items: [{ field: 'status', fieldId: 'status', from: s, fromString: status(s).name, to, toString: status(to).name }] }); s = to; t = at; };
    for (const [at, to] of (plan[k] ?? []).map((at, j) => [at, FLOW[j + 1]])) { if (at > now - 3600_000) break; move(at, to); }
    // Some reopen, and most of those are done again.
    if (s === '10004' && r() < 0.12) {
      const back = t + (1 + r() * 4) * DAY, again = back + (1 + r() * 3) * DAY;
      if (back < now - 3600_000) move(back, '3');
      if (s === '3' && again < now - 3600_000) move(again, '10004');
    }
    const who = r() < 0.1 ? null : pick(PEOPLE);
    if (who && r() < 0.4) hist.push({ created: iso(created + DAY), author: PEOPLE[0], items: [{ field: 'assignee', fieldId: 'assignee', from: null, fromString: null, to: who.accountId, toString: who.displayName }] });
    hist.sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
    const sub = k % 23 === 0 && k > 0;
    const parent = sub ? { key: `${KEY}-${k + 9}`, fields: { summary: 'x' } } : r() < 0.8 ? { key: pick(epics), fields: { summary: '' } } : null;
    issues.push({
      id: iid, key,
      fields: {
        summary: `${pick(['Add', 'Fix', 'Validate', 'Migrate', 'Expose'])} ${pick(['order', 'invoice', 'customer', 'payment terms', 'approval step', 'currency'])} ${pick(['field', 'export', 'report', 'rule', 'view'])} #${k}`,
        issuetype: sub ? SUB : pick(TYPES), status: status(s), priority: { name: pick(['Highest', 'High', 'Medium', 'Medium', 'Low']) },
        labels: r() < 0.6 ? [pick(LABELS)] : [], components: [], fixVersions: [],
        assignee: who, reporter: pick(PEOPLE), created: iso(created), updated: iso(Math.max(created, t)),
        resolutiondate: s === '10004' ? iso(t) : null, resolution: s === '10004' ? { name: 'Done' } : null, parent,
        issuelinks: k % 17 === 3 ? [{ type: { inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: `${KEY}-${k + 11}` } }] : [],
        description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: `Synthetic description for ${key}. Contains <b>markup</b> & "quotes".` }] }] },
        comment: { comments: k % 5 === 0 ? [{ author: pick(PEOPLE), created: iso(created + DAY), body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Looks good $& </script>' }] }] } }] : [], total: k % 5 === 0 ? 1 : 0 },
        attachment: [], customfield_10050: r() < 0.5 ? { value: pick(['Wave 1', 'Wave 2']) } : null,
      },
    });
    changelogs[iid] = hist;
  }
  const demo = issues.map(i => i.key);
  return {
    host: 'example.atlassian.net', project: KEY, projectName,
    boards: [
      { id: 202, name: 'Delivery', type: 'kanban', jql: `project = ${KEY}`, keys: demo, columns: [{ name: 'Backlog', statuses: ['10001', '10002'] }, { name: 'Doing', statuses: ['3'] }, { name: 'Review', statuses: ['10003'] }, { name: 'Done', statuses: ['10004', '10005'] }] },
      { id: 201, name: 'Bugs', type: 'kanban', jql: `project = ${KEY} AND type = Bug`, keys: issues.filter(i => i.fields.issuetype.name === 'Bug').map(i => i.key), columns: [{ name: 'Open', statuses: ['10002'] }, { name: 'Fixing', statuses: ['3', '10003'] }, { name: 'Closed', statuses: ['10004'] }] },
    ],
    fields: [
      { id: 'customfield_10050', name: 'Release wave', custom: true, schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' } },
      { id: 'customfield_10019', name: 'Rank', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-lexo-rank' } },
    ],
    statuses: STATUSES, priorities: ['Highest', 'High', 'Medium', 'Low', 'Lowest'].map(name => ({ name })),
    issues, changelogs,
    config: { title: 'Programme status', milestones: [{ name: 'UAT', date: '2027-01-15' }], customFieldMinFill: 0.05, forecast: { weeks: 12, runs: 2000 } },
    generatedAt: now,
  };
}
