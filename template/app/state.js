// Data, dimensions and filter state. Every tab reads `S.filtered()`; filters live in the URL hash
// so a filtered view can be bookmarked or shared.

const S = (() => {
  const model = JSON.parse(document.getElementById('jr-data').textContent);
  const { meta, people } = model;
  const A = JRA.context(model);
  const byKey = new Map(model.issues.map(i => [i.k, i]));
  const statusName = id => meta.statuses[id]?.n ?? id ?? '—';
  const CAT_LABEL = { new: 'To do', indeterminate: 'In progress', done: 'Done' };
  const CAT_ORDER = ['new', 'indeterminate', 'done'];
  const personName = id => (id ? people[id]?.[0] ?? 'Unknown' : 'Unassigned');
  const boardName = id => meta.boards.find(b => b.id === id)?.name ?? `Board ${id}`;
  // Portfolio report: several workstreams (boards or spaces), compared on the Portfolio tab.
  const P = meta.portfolio ?? null;
  const streamName = id => P?.streams.find(s => s.id === id)?.name ?? id;
  const DEFAULT_TAB = P ? 'portfolio' : 'overview';

  const epicOf = JRA.epicResolver(model);
  const issueLabel = k => { const i = byKey.get(k); return `${k} ${i ? i.t : meta.externalParents[k] ?? ''}`.trim(); };
  const month = t => (t ? new Date(t).toISOString().slice(0, 7) : null);
  const ageBucket = i => {
    if (A.isDone(i)) return 'Done';
    const d = (A.now - i.cr) / JRA.DAY;
    return d < 7 ? '< 1 week' : d < 30 ? '1–4 weeks' : d < 90 ? '1–3 months' : d < 180 ? '3–6 months' : '> 6 months';
  };
  const AGE_ORDER = ['< 1 week', '1–4 weeks', '1–3 months', '3–6 months', '> 6 months', 'Done'];

  // Dimension: id → { name, values(issue) → string[], order? (sort for display) }
  const arr = v => (v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
  const priorityRank = p => { const k = meta.priorities.indexOf(p); return k < 0 ? 99 : k; };
  const statusRank = (() => {
    const cols = meta.boards[0]?.columns ?? [];
    const pos = {};
    cols.forEach((c, k) => c.statuses.forEach(s => { pos[statusName(s)] ??= k; }));
    return n => { const id = Object.keys(meta.statuses).find(s => statusName(s) === n); return (CAT_ORDER.indexOf(meta.statuses[id]?.c) * 100) + (pos[n] ?? 50); };
  })();

  const streamOrder = n => P.streams.findIndex(s => s.name === n);
  const DIMS = {
    ...(P ? {
      stream: { name: 'Workstream', values: i => i.ws.map(streamName), sort: (a, b) => streamOrder(a) - streamOrder(b) },
      space: { name: 'Space', values: i => [i.sp] },
    } : {}),
    type: { name: 'Type', values: i => [i.ty] },
    status: { name: 'Status', values: i => [statusName(i.st)], sort: (a, b) => statusRank(a) - statusRank(b) },
    category: { name: 'Status category', values: i => [CAT_LABEL[A.cat(i.st)]], sort: (a, b) => Object.values(CAT_LABEL).indexOf(a) - Object.values(CAT_LABEL).indexOf(b) },
    priority: { name: 'Priority', values: i => arr(i.pr), sort: (a, b) => priorityRank(a) - priorityRank(b) },
    assignee: { name: 'Assignee', values: i => [personName(i.as)] },
    reporter: { name: 'Reporter', values: i => [personName(i.rp)] },
    label: { name: 'Label', values: i => i.lb },
    component: { name: 'Component', values: i => i.cp },
    fixVersion: { name: 'Fix version', values: i => i.fv },
    epic: { name: 'Epic', values: i => { const e = epicOf(i); return e ? [issueLabel(e)] : []; } },
    board: { name: 'Board', values: i => i.b.map(boardName) },
    resolution: { name: 'Resolution', values: i => arr(i.res) },
    created: { name: 'Created (month)', values: i => arr(month(i.cr)), sort: (a, b) => a.localeCompare(b) },
    resolved: { name: 'Completed (month)', values: i => arr(month(A.completedAt(i))), sort: (a, b) => a.localeCompare(b) },
    age: { name: 'Age (open)', values: i => [ageBucket(i)], sort: (a, b) => AGE_ORDER.indexOf(a) - AGE_ORDER.indexOf(b) },
  };
  for (const f of meta.customFields) DIMS['cf:' + f.id] = { name: f.name, values: i => arr(i.cf[f.id]), custom: true };

  // Content quality (only when the report was built with --quality).
  const Q = meta.quality ? JRQ.assess(model.issues, { epicOf }) : null;
  if (Q) {
    DIMS.quality = { name: 'Quality', values: i => arr(Q.byKey.get(i.k)?.grade), sort: (a, b) => ['Good', 'Fair', 'Poor'].indexOf(a) - ['Good', 'Fair', 'Poor'].indexOf(b) };
    DIMS.qualityGap = { name: 'Quality gap', values: i => (Q.byKey.get(i.k)?.failed ?? []).map(r => r.label) };
  }
  // Drop dimensions that carry no information (a single value everywhere, or empty everywhere).
  for (const [id, d] of Object.entries(DIMS)) {
    const seen = new Set();
    for (const i of model.issues) for (const v of d.values(i)) { seen.add(v); if (seen.size > 1) break; }
    d.distinct = seen.size;
  }
  const dimList = () => Object.entries(DIMS).filter(([, d]) => d.distinct > 0).map(([id, d]) => ({ id, ...d }));
  const sortValues = (dimId, values, countOf) => {
    const d = DIMS[dimId];
    return [...values].sort((a, b) => (a === '(none)') - (b === '(none)') || (d.sort ? d.sort(a, b) : (countOf ? countOf(b) - countOf(a) : 0) || a.localeCompare(b)));
  };

  // Search haystack per issue.
  const hay = new Map(model.issues.map(i => [i.k, [i.k, i.t, i.d, ...i.cm.map(c => c[2]), ...i.lb, personName(i.as)].join('\n').toLowerCase()]));

  // ---------- filter state ----------
  const state = { filters: {}, q: '', tab: DEFAULT_TAB, opts: {} };
  function readHash() {
    try {
      const p = new URLSearchParams(location.hash.slice(1));
      state.tab = p.get('tab') || DEFAULT_TAB;
      state.q = p.get('q') || '';
      state.filters = {};
      for (const [k, v] of p) if (k.startsWith('f.') && DIMS[k.slice(2)]) state.filters[k.slice(2)] = new Set(JSON.parse(v));
      state.opts = JSON.parse(p.get('o') || '{}');
    } catch { /* malformed hash: keep defaults */ }
  }
  function writeHash() {
    const p = new URLSearchParams();
    if (state.tab !== DEFAULT_TAB) p.set('tab', state.tab);
    if (state.q) p.set('q', state.q);
    for (const [k, v] of Object.entries(state.filters)) if (v.size) p.set('f.' + k, JSON.stringify([...v]));
    if (Object.keys(state.opts).length) p.set('o', JSON.stringify(state.opts));
    // Sandboxed viewers (Teams / SharePoint preview render the file in an about:srcdoc iframe with
    // a null origin) forbid history writes. The URL is only a bookmark convenience, so the state
    // simply stays in memory there.
    try { history.replaceState(null, '', '#' + p.toString()); } catch { /* sandboxed: in-memory only */ }
  }
  readHash();

  let cache = null;
  function filtered({ except } = {}) {
    if (!except && cache) return cache;
    const q = state.q.trim().toLowerCase();
    const terms = q ? q.split(/\s+/) : [];
    const out = model.issues.filter(i => {
      for (const [k, set] of Object.entries(state.filters)) {
        if (k === except || !set.size) continue;
        const vs = DIMS[k].values(i);
        if (!(vs.length ? vs : ['(none)']).some(v => set.has(v))) return false;
      }
      return !terms.length || terms.every(t => hay.get(i.k).includes(t));
    });
    if (!except) cache = out;
    return out;
  }
  const changed = () => { cache = null; writeHash(); };

  // Target date (UAT by default), editable in the report, remembered per project in this browser.
  const TKEY = `jira-report:target:${meta.host}:${meta.project}`;
  function target() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(TKEY) || 'null'); } catch { /* storage blocked */ }
    const m = saved ?? meta.milestones[0] ?? null;
    return m ? { name: m.name, date: m.date, t: new Date(m.date + 'T23:59:59').getTime(), custom: !!saved } : null;
  }
  function setTarget(m) { try { m ? localStorage.setItem(TKEY, JSON.stringify(m)) : localStorage.removeItem(TKEY); } catch { /* storage blocked */ } }

  return { model, meta, people, A, Q, P, byKey, DIMS, dimList, sortValues, state, filtered, changed, statusName, personName, boardName, streamName, DEFAULT_TAB, epicOf, issueLabel, CAT_LABEL, CAT_ORDER, target, setTarget, readHash };
})();
