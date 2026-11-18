// Raw Jira responses → the compact model embedded in the report. Pure; no I/O.
//
// Issue keys (compact on purpose — ~400 issues × full history must stay a few MB):
//   k key · id · t summary · ty type · lvl hierarchy level (1 = epic, -1 = subtask) · st status id
//   pr priority · lb labels · cp components · fv fix versions · as assignee · rp reporter
//   cr/up/rs created/updated/resolved (epoch ms) · res resolution · due (YYYY-MM-DD)
//   par parent key · ln [[relation, key]] · d description text · cm [[author, ts, text]]
//   at [[filename, bytes, url]] · cf {fieldId: value} · h [[ts, author, field, fromStr, toStr, from, to]]
//   b [boardId…]
// Portfolio reports only (raw.portfolio set): sp space key · ws [workstream id…]; meta.portfolio.

import { adfToText } from './adf.mjs';

// Jira returns ISO strings from most endpoints but epoch milliseconds from the bulk changelog API.
const ts = v => (v == null || v === '' ? null : typeof v === 'number' ? v : (n => (Number.isNaN(n) ? null : n))(Date.parse(v)));
const SKIP_CUSTOM = /lexo-rank|:development|servicedesk|sd-|:jsw-story-points-estimation-rank|vp-origin|atlassian-team-type/i;
const SKIP_HISTORY = new Set(['Rank', 'RemoteIssueLink', 'Attachment', 'timeestimate', 'timeoriginalestimate', 'WorklogId']);
const clip = (s, n = 240) => (s == null ? null : s.length > n ? s.slice(0, n - 1) + '…' : s);

export function customValue(v) {
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) { const a = v.map(customValue).filter(x => x != null).map(String); return a.length ? a : null; }
  if (v.type === 'doc') return adfToText(v) || null;
  const s = v.value ?? v.name ?? v.displayName ?? v.key ?? v.title ?? null;
  if (s != null && v.child?.value) return `${s} › ${v.child.value}`;
  return s;
}

export function buildModel(raw) {
  const { host, project, projectName, boards = [], fields = [], statuses = [], priorities = [], issues, changelogs = {}, config = {}, generatedAt = Date.now(), portfolio = null, streamOf = {} } = raw;
  const people = {};
  const person = u => { if (!u?.accountId) return null; people[u.accountId] ??= [u.displayName ?? 'Unknown', u.emailAddress ?? null]; return u.accountId; };

  const status = {};
  for (const s of statuses) status[s.id] = { n: s.name, c: s.statusCategory?.key ?? 'indeterminate' };
  // Every issue carries its current status with its category: seed those before history can
  // introduce the same id with a guessed category.
  for (const i of issues) { const s = i.fields?.status; if (s?.id && !status[s.id]) status[s.id] = { n: s.name, c: s.statusCategory?.key ?? 'indeterminate' }; }

  // Custom fields filled on at least `minFill` of the issues, by display name. In a portfolio the
  // share counts per space, so a field one space uses is kept however small that space is.
  const minFill = config.customFieldMinFill ?? 0.05;
  const customs = fields.filter(f => f.custom && !SKIP_CUSTOM.test(f.schema?.custom ?? ''));
  const spaceOf = i => i.key.split('-')[0];
  const groups = portfolio ? [...issues.reduce((m, i) => m.set(spaceOf(i), [...(m.get(spaceOf(i)) ?? []), i]), new Map()).values()] : [issues];
  const keptCustoms = customs.filter(f => groups.some(g => g.filter(i => customValue(i.fields?.[f.id]) != null).length >= Math.max(1, minFill * g.length)));

  const boardOf = {};
  for (const b of boards) for (const k of b.keys ?? []) (boardOf[k] ??= []).push(b.id);

  const out = issues.map(i => {
    const f = i.fields ?? {};
    const hist = (changelogs[i.id] ?? []).flatMap(h => (h.items ?? []).filter(it => !SKIP_HISTORY.has(it.field)).map(it => {
      const author = person(h.author);
      if (it.field === 'status' || it.fieldId === 'status') {
        for (const [id, n] of [[it.from, it.fromString], [it.to, it.toString]]) if (id && !status[id]) status[id] = { n: n ?? id, c: 'indeterminate' };
        return [ts(h.created), author, 'status', it.fromString, it.toString, it.from, it.to];
      }
      if (it.field === 'description') return [ts(h.created), author, 'description', null, null, null, null];
      return [ts(h.created), author, it.field, clip(it.fromString), clip(it.toString), it.field === 'assignee' ? it.from : null, it.field === 'assignee' ? it.to : null];
    })).sort((a, b) => a[0] - b[0]);

    const cf = {};
    for (const c of keptCustoms) { const v = customValue(f[c.id]); if (v != null) cf[c.id] = v; }
    return {
      k: i.key, id: i.id, t: f.summary ?? '', ty: f.issuetype?.name ?? 'Issue',
      lvl: f.issuetype?.subtask ? -1 : (f.issuetype?.hierarchyLevel ?? 0),
      st: f.status?.id ?? null, pr: f.priority?.name ?? null,
      lb: f.labels ?? [], cp: (f.components ?? []).map(c => c.name), fv: (f.fixVersions ?? []).map(v => v.name),
      as: person(f.assignee), rp: person(f.reporter),
      cr: ts(f.created), up: ts(f.updated), rs: ts(f.resolutiondate), res: f.resolution?.name ?? null, due: f.duedate ?? null,
      par: f.parent?.key ?? null,
      ln: (f.issuelinks ?? []).map(l => l.outwardIssue ? [l.type?.outward ?? 'relates to', l.outwardIssue.key] : [l.type?.inward ?? 'relates to', l.inwardIssue?.key]).filter(l => l[1]),
      d: adfToText(f.description),
      cm: (f.comment?.comments ?? []).map(c => [person(c.author), ts(c.created), adfToText(c.body)]),
      at: (f.attachment ?? []).map(a => [a.filename, a.size, `https://${host}/secure/attachment/${a.id}/${encodeURIComponent(a.filename)}`]),
      cf, h: hist, b: boardOf[i.key] ?? [],
      ...(portfolio ? { sp: spaceOf(i), ws: streamOf[i.key] ?? [] } : {}),
    };
  });

  // Parents referenced but outside the scope (e.g. an epic in another project) still get a label.
  const known = new Set(out.map(i => i.k));
  const external = {};
  for (const i of issues) { const p = i.fields?.parent; if (p && !known.has(p.key)) external[p.key] = p.fields?.summary ?? p.key; }

  return {
    meta: {
      host, project, projectName: projectName ?? project, generatedAt, title: config.title ?? 'Jira report',
      milestones: config.milestones ?? [], forecast: config.forecast ?? {},
      boards: boards.map(b => ({ id: b.id, name: b.name, type: b.type, columns: b.columns ?? [] })),
      statuses: status, priorities: priorities.map(p => p.name),
      customFields: keptCustoms.map(c => ({ id: c.id, name: c.name })), externalParents: external,
      ...(portfolio ? { portfolio } : {}),
    },
    people, issues: out,
  };
}
