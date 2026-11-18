// Tab renderers. Each gets (el, issues) where issues = the filtered set. Charts are drawn into
// slots after the HTML is in the DOM, so they can size themselves to the slot's width.

const Views = (() => {
  const { esc, fmtN, fmtD, fmtDShort, timeSeries, columns, spark, scatter, barList, stackBar, legend } = Charts;
  const A = S.A, DAY = JRA.DAY, WEEK = JRA.WEEK;
  const CAT_COLOR = { new: 'var(--cat-new)', indeterminate: 'var(--cat-prog)', done: 'var(--cat-done)' };
  const SERIES = n => `var(--series-${(n % 8) + 1})`;
  const drillAttr = (filters, tab = 'issues') => ` data-drill="${esc(JSON.stringify(filters))}" data-tab="${tab}"`;
  const days = d => (d == null ? '–' : d < 1 ? '<1 d' : `${Math.round(d)} d`);
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);

  // Flow metrics count standard work items only: epics are containers, subtasks would double count.
  const work = issues => issues.filter(i => i.lvl === 0);

  let fills = [];
  const slot = (fn, cls = '') => { const id = 'c' + fills.length; fills.push([id, fn]); return `<div class="slot ${cls}" id="${id}"></div>`; };
  function flush() {
    for (const [id, fn] of fills) { const el = document.getElementById(id); if (el) el.innerHTML = fn(Math.max(280, Math.floor(el.clientWidth))); }
    fills = [];
  }
  const card = (title, body, { sub = '', cls = '' } = {}) => `<section class="card ${cls}"><header><h3>${esc(title)}</h3>${sub ? `<p class="sub">${sub}</p>` : ''}</header>${body}</section>`;
  const tile = (label, value, { note = '', attrs = '' } = {}) => `<div class="tile"${attrs}><div class="t-label">${esc(label)}</div><div class="t-value">${value}</div>${note ? `<div class="t-note">${note}</div>` : ''}</div>`;

  // ---------- forecast (shared by Overview and Flow) ----------
  /** The forecast for this view; null when it spans several workstreams (their "done" differs). */
  function forecast(issues) {
    if (streamsIn(issues).length > 1) return null;
    const cfg = S.meta.forecast ?? {};
    return JRA.forecast(A, work(issues), { weeks: cfg.weeks ?? 12, runs: cfg.runs ?? 4000, growth: !!S.state.opts.growth, target: S.target() });
  }
  const probText = p => (p == null ? '–' : p >= 0.995 ? '>99%' : p < 0.005 ? '<1%' : `${Math.round(p * 100)}%`);
  const probClass = p => (p == null ? '' : p >= 0.85 ? 'good' : p >= 0.5 ? 'warning' : 'critical');

  function targetEditor() {
    const t = S.target();
    return `<span class="target">${t ? `<b>${esc(t.name)}</b> ${fmtD(t.t)}${t.custom ? ' <span class="muted">(edited)</span>' : ''}` : '<span class="muted">No target date</span>'}
      <button class="link" data-target-edit>Change</button></span>
      <form class="target-form" hidden><input name="name" value="${esc(t?.name ?? 'UAT')}" aria-label="Milestone name" size="8"><input name="date" type="date" value="${esc(t?.date ?? '')}" aria-label="Target date" required><button type="submit">Save</button>${t?.custom ? '<button type="button" class="link" data-target-reset>Reset to config</button>' : ''}</form>`;
  }
  document.addEventListener('click', e => {
    if (e.target.matches('[data-target-edit]')) { const f = e.target.closest('.target').nextElementSibling; f.hidden = !f.hidden; f.querySelector('[type=date]').focus(); }
    if (e.target.matches('[data-target-reset]')) { S.setTarget(null); App.render(); }
  });
  document.addEventListener('submit', e => {
    if (!e.target.matches('.target-form')) return;
    e.preventDefault();
    const f = new FormData(e.target);
    S.setTarget({ name: f.get('name') || 'Target', date: f.get('date') });
    App.render();
  });

  function forecastCard(fc, { compact = false } = {}) {
    if (!fc) return '';
    const t = fc.target;
    const verdict = !fc.mc.feasible
      ? '<p class="muted">No completions in the sample window, so there is nothing to forecast from.</p>'
      : `<div class="fc-grid">
          ${tile('Remaining work items', fmtN(fc.remaining))}
          ${tile('50% likely done by', fc.p50 ? fmtD(fc.p50) : 'beyond 5 years')}
          ${tile('85% likely done by', fc.p85 ? fmtD(fc.p85) : 'beyond 5 years')}
          ${t ? tile(`Done by ${t.name}`, `<span class="status ${probClass(fc.prob)}">${fc.prob == null ? 'date passed' : probText(fc.prob)}</span>`, { note: fmtD(t.t) }) : ''}
        </div>`;
    const how = `Monte Carlo over ${fmtN(fc.mc.weeks.length)} runs, sampling weekly throughput from the last ${fc.weeks} full weeks (${fc.samples.join(', ')}).
      ${fc.growth ? 'New scope arrives each simulated week, sampled from the same weeks.' : 'Assumes no new scope arrives.'}`;
    return card('Forecast', `<div class="fc-head">${targetEditor()}${compact ? '' : `<label class="toggle"><input type="checkbox" data-opt="growth"${fc.growth ? ' checked' : ''}> Include scope growth</label>`}</div>${verdict}<p class="sub">${how}</p>`, { sub: 'Standard work items only; epics and subtasks are excluded.' });
  }
  document.addEventListener('change', e => { if (e.target.matches('[data-opt]')) { S.state.opts[e.target.dataset.opt] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; S.changed(); App.render({ keepFilterBar: true }); } });

  // ---------- Overview ----------
  function overview(el, issues) {
    const byCat = { new: 0, indeterminate: 0, done: 0 };
    for (const i of issues) byCat[A.cat(i.st)]++;
    const since = A.now - 14 * DAY;
    const created = issues.filter(i => i.cr >= since).length;
    const completed = issues.filter(i => (A.completedAt(i) ?? 0) >= since).length;
    const recentCycle = work(issues).filter(i => (A.completedAt(i) ?? 0) >= A.now - 90 * DAY).map(A.cycleDays).filter(v => v != null);
    const fc = forecast(issues);

    const statusRows = S.sortValues('status', new Set(issues.map(i => S.statusName(i.st))))
      .map(n => { const sample = issues.find(i => S.statusName(i.st) === n); return { label: n, value: issues.filter(i => S.statusName(i.st) === n).length, color: CAT_COLOR[A.cat(sample.st)], attrs: drillAttr({ status: n }) }; });
    const dimRows = (dim, subset) => {
      const p = JRA.pivot(subset, S.DIMS[dim].values);
      return S.sortValues(dim, p.rows.keys(), v => p.rows.get(v)).map(v => ({ label: v, value: p.rows.get(v), attrs: drillAttr({ [dim]: v, category: ['To do', 'In progress'] }) }));
    };
    const open = issues.filter(i => !A.isDone(i));
    const recent = issues.flatMap(i => i.h.filter(h => h[2] === 'status').map(h => ({ i, h }))).sort((a, b) => b.h[0] - a.h[0]).slice(0, 12);

    el.innerHTML = `${mixedNotice(issues, 'overview')}
      <div class="tiles">
        ${tile('Issues in view', fmtN(issues.length), { note: `${S.model.issues.length} in scope` })}
        ${tile('To do', fmtN(byCat.new), { attrs: drillAttr({ category: 'To do' }) })}
        ${tile('In progress', fmtN(byCat.indeterminate), { attrs: drillAttr({ category: 'In progress' }) })}
        ${tile('Done', fmtN(byCat.done), { note: `${pct(byCat.done, issues.length)}% of issues in view`, attrs: drillAttr({ category: 'Done' }) })}
        ${tile('Last 14 days', `+${created} / ✓${completed}`, { note: 'created / completed' })}
        ${tile('Median cycle time', days(JRA.median(recentCycle)), { note: `items completed in the last 90 days (n=${recentCycle.length})` })}
      </div>
      ${forecastCard(fc, { compact: true })}
      ${card('Status', stackBar(S.CAT_ORDER.map(c => ({ label: S.CAT_LABEL[c], value: byCat[c], color: CAT_COLOR[c] })), { height: 14, showLegend: true }) + barList(statusRows), { sub: 'All issues in view. Click a row to list them.' })}
      <div class="grid2">
        ${card('Open by type', barList(dimRows('type', open)))}
        ${card('Open by priority', barList(dimRows('priority', open)))}
      </div>
      <div class="grid2">
        ${card('Longest in current status', oldestList(issues.filter(i => A.cat(i.st) === 'indeterminate')), { sub: 'In-progress issues' })}
        ${card('Recent status changes', `<ul class="feed">${recent.map(({ i, h }) => `<li><span class="muted nowrap">${fmtDShort(h[0])}</span> <a href="#" data-open="${esc(i.k)}">${esc(i.k)}</a> ${esc(h[3] ?? '∅')} → <b>${esc(h[4] ?? '∅')}</b> <span class="muted">${esc(S.personName(h[1]))}</span></li>`).join('') || '<li class="muted">None</li>'}</ul>`)}
      </div>`;
  }
  function oldestList(list) {
    const rows = list.map(i => ({ i, d: A.age(i).inStatus })).sort((a, b) => b.d - a.d).slice(0, 10);
    return `<ul class="feed">${rows.map(({ i, d }) => `<li><span class="age">${days(d)}</span> <a href="#" data-open="${esc(i.k)}">${esc(i.k)}</a> ${esc(i.t)} <span class="muted">${esc(S.statusName(i.st))} · ${esc(S.personName(i.as))}</span></li>`).join('') || '<li class="muted">None</li>'}</ul>`;
  }

  // ---------- Explore (pivot) ----------
  function explore(el, issues) {
    const o = S.state.opts;
    const dims = S.dimList();
    const rowDim = S.DIMS[o.rows] ? o.rows : 'epic';
    const colDim = o.cols === '' ? '' : S.DIMS[o.cols] ? o.cols : 'category';
    const scope = o.scope === 'open' ? issues.filter(i => !A.isDone(i)) : issues;
    const p = JRA.pivot(scope, S.DIMS[rowDim].values, colDim ? S.DIMS[colDim].values : null);
    const rows = S.sortValues(rowDim, p.rows.keys(), v => p.rows.get(v));
    const cols = colDim ? S.sortValues(colDim, p.cols.keys(), v => p.cols.get(v)) : ['Count'];
    const max = Math.max(1, ...rows.flatMap(r => cols.map(c => p.cell(r, c))));
    const opt = (sel, allowNone) => (allowNone ? `<option value=""${sel === '' ? ' selected' : ''}>(nothing)</option>` : '') + dims.map(d => `<option value="${d.id}"${d.id === sel ? ' selected' : ''}>${esc(d.name)}</option>`).join('');
    const multi = ['label', 'component', 'fixVersion', 'board'].includes(rowDim) || ['label', 'component', 'fixVersion', 'board'].includes(colDim) || S.DIMS[rowDim].custom || S.DIMS[colDim]?.custom;
    const cellF = (r, c) => { const f = { [rowDim]: r }; if (colDim) f[colDim] = c; if (o.scope === 'open') f.category = ['To do', 'In progress']; return f; };
    el.innerHTML = card('Explore', `
      <div class="controls">
        <label>Rows <select data-opt="rows">${opt(rowDim)}</select></label>
        <label>Columns <select data-opt="cols">${opt(colDim, true)}</select></label>
        <label>Issues <select data-opt="scope"><option value="all">All</option><option value="open"${o.scope === 'open' ? ' selected' : ''}>Open only</option></select></label>
      </div>
      ${multi ? '<p class="sub">An issue with several values (labels, boards, …) is counted once under each, so rows can add up to more than the total.</p>' : ''}
      <div class="table-wrap"><table class="pivot">
        <thead><tr><th>${esc(S.DIMS[rowDim].name)}</th>${cols.map(c => `<th class="num">${esc(c)}</th>`).join('')}${colDim ? '<th class="num">Total</th>' : ''}</tr></thead>
        <tbody>${rows.map(r => `<tr><th title="${esc(r)}">${esc(r)}</th>${cols.map(c => { const n = colDim ? p.cell(r, c) : p.rows.get(r); return `<td class="num heat"${n ? drillAttr(cellF(r, c)) : ''} style="--h:${(n / max).toFixed(3)}">${n || ''}</td>`; }).join('')}${colDim ? `<td class="num total"${drillAttr(cellF(r))}>${p.rows.get(r)}</td>` : ''}</tr>`).join('')}</tbody>
        ${colDim ? `<tfoot><tr><th>Total</th>${cols.map(c => `<td class="num total">${p.cols.get(c)}</td>`).join('')}<td class="num total">${p.total}</td></tr></tfoot>` : ''}
      </table></div>`, { sub: 'Count of issues. Click any cell to list its issues.' });
  }

  // ---------- Issues ----------
  const COLS = [
    ['k', 'Key', i => i.k, (a, b) => a.cr - b.cr],
    ['ty', 'Type', i => i.ty],
    ['t', 'Summary', i => i.t],
    ['st', 'Status', i => S.statusName(i.st), (a, b) => S.CAT_ORDER.indexOf(A.cat(a.st)) - S.CAT_ORDER.indexOf(A.cat(b.st)) || S.statusName(a.st).localeCompare(S.statusName(b.st))],
    ['pr', 'Priority', i => i.pr ?? '', (a, b) => S.meta.priorities.indexOf(a.pr) - S.meta.priorities.indexOf(b.pr)],
    ['as', 'Assignee', i => S.personName(i.as)],
    ['ep', 'Epic', i => { const e = S.epicOf(i); return e ? S.issueLabel(e) : ''; }],
    ['up', 'Updated', i => fmtDShort(i.up), (a, b) => a.up - b.up],
    ['age', 'Age', i => days(A.age(i).sinceCreated), (a, b) => a.cr - b.cr],
  ];
  function issuesView(el, issues) {
    const o = S.state.opts;
    const [sk, dir] = (o.sort ?? 'up:desc').split(':');
    const col = COLS.find(c => c[0] === sk) ?? COLS[7];
    const cmp = col[3] ?? ((a, b) => col[2](a).localeCompare(col[2](b)));
    const rows = [...issues].sort((a, b) => (dir === 'desc' ? -1 : 1) * cmp(a, b));
    const limit = o.all ? rows.length : 300;
    el.innerHTML = card(`Issues (${rows.length})`, `
      <div class="table-wrap"><table class="issues">
        <thead><tr>${COLS.map(c => `<th data-sort="${c[0]}" class="${c[0] === sk ? 'sorted ' + dir : ''}">${c[1]}</th>`).join('')}</tr></thead>
        <tbody>${rows.slice(0, limit).map(i => `<tr data-open="${esc(i.k)}">
          <td class="key nowrap">${esc(i.k)}</td><td class="nowrap">${esc(i.ty)}</td><td class="summary">${esc(i.t)}</td>
          <td class="nowrap"><span class="pill small cat-${A.cat(i.st)}">${esc(S.statusName(i.st))}</span></td>
          <td class="nowrap">${esc(i.pr ?? '')}</td><td class="nowrap">${esc(S.personName(i.as))}</td>
          <td class="epic">${esc(COLS[6][2](i))}</td><td class="nowrap num">${fmtDShort(i.up)}</td><td class="nowrap num">${days(A.age(i).sinceCreated)}</td></tr>`).join('')}</tbody>
      </table></div>
      ${rows.length > limit ? `<button class="link more" data-opt-set="all">Show all ${rows.length}</button>` : ''}`, { sub: 'Click a row for details, description, comments and history. Click a header to sort.' });
    el.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
      o.sort = `${th.dataset.sort}:${th.dataset.sort === sk && dir === 'desc' ? 'asc' : 'desc'}`;
      S.changed(); App.render({ keepFilterBar: true });
    }));
    el.querySelector('[data-opt-set]')?.addEventListener('click', () => { o.all = true; S.changed(); App.render({ keepFilterBar: true }); });
  }

  // ---------- Epics ----------
  function epics(el, issues) {
    const groups = new Map();
    for (const i of issues) { if (i.lvl === 1) continue; const e = S.epicOf(i) ?? '(no epic)'; (groups.get(e) ?? groups.set(e, []).get(e)).push(i); }
    for (const i of issues) if (i.lvl === 1 && !groups.has(i.k)) groups.set(i.k, []);
    const sortBy = S.state.opts.epicSort ?? 'open';
    const list = [...groups.entries()].map(([k, kids]) => {
      const c = { new: 0, indeterminate: 0, done: 0 };
      for (const x of kids) c[A.cat(x.st)]++;
      const epic = S.byKey.get(k);
      const last = Math.max(0, ...kids.map(x => x.up), epic?.up ?? 0);
      return { k, epic, kids, c, open: c.new + c.indeterminate, done: kids.length ? c.done / kids.length : 0, last };
    }).sort((a, b) => (a.k === '(no epic)') - (b.k === '(no epic)') || (sortBy === 'open' ? b.open - a.open : sortBy === 'progress' ? b.done - a.done : sortBy === 'activity' ? b.last - a.last : a.k.localeCompare(b.k, undefined, { numeric: true })));
    el.innerHTML = card(`Epics (${list.filter(g => g.k !== '(no epic)').length})`, `
      <div class="controls"><label>Sort <select data-opt="epicSort">${[['open', 'Most open work'], ['progress', 'Most complete'], ['activity', 'Recent activity'], ['key', 'Key']].map(([v, l]) => `<option value="${v}"${v === sortBy ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      ${legend(S.CAT_ORDER.map(c => ({ label: S.CAT_LABEL[c], color: CAT_COLOR[c] })))}</div>
      <div class="epics">${list.map(g => `
        <details class="epic-row">
          <summary>
            <span class="e-title">${g.epic ? `<a href="#" data-open="${esc(g.k)}" class="key">${esc(g.k)}</a> ${esc(g.epic.t)} <span class="pill small cat-${A.cat(g.epic.st)}">${esc(S.statusName(g.epic.st))}</span>` : g.k === '(no epic)' ? '<i>No epic</i>' : `<span class="key">${esc(g.k)}</span> ${esc(S.meta.externalParents[g.k] ?? '')}`}</span>
            <span class="e-bar">${stackBar(S.CAT_ORDER.map(c => ({ label: S.CAT_LABEL[c], value: g.c[c], color: CAT_COLOR[c] })))}</span>
            <span class="e-num">${g.c.done}/${g.kids.length} done</span>
          </summary>
          <ul class="links">${g.kids.sort((a, b) => S.CAT_ORDER.indexOf(A.cat(a.st)) - S.CAT_ORDER.indexOf(A.cat(b.st))).map(x => `<li><span class="pill small cat-${A.cat(x.st)}">${esc(S.statusName(x.st))}</span> <a href="#" data-open="${esc(x.k)}">${esc(x.k)}</a> ${esc(x.t)} <span class="muted">${esc(x.ty)} · ${esc(S.personName(x.as))}</span></li>`).join('') || '<li class="muted">No child issues in view</li>'}</ul>
        </details>`).join('')}</div>`, { sub: 'Children of each epic within the current filters (subtasks roll up through their parent).' });
  }

  // ---------- Process ----------
  function process(el, issues) {
    const tis = A.timeInStatus(issues).filter(r => A.cat(r.status) !== 'done');
    const order = S.sortValues('status', new Set(tis.map(r => S.statusName(r.status))));
    tis.sort((a, b) => order.indexOf(S.statusName(a.status)) - order.indexOf(S.statusName(b.status)));
    const tr = A.transitions(issues);
    const involved = S.sortValues('status', new Set(tr.flatMap(t => [S.statusName(t.from), S.statusName(t.to)])));
    const m = {}; for (const t of tr) { const k = S.statusName(t.from) + '\u0000' + S.statusName(t.to); m[k] = (m[k] ?? 0) + t.n; }
    const tmax = Math.max(1, ...Object.values(m));
    const reopened = issues.filter(i => A.reopens(i) > 0).sort((a, b) => A.reopens(b) - A.reopens(a));
    const wip = work(issues).filter(i => A.cat(i.st) === 'indeterminate');
    const cycles = work(issues).filter(i => (A.completedAt(i) ?? 0) >= A.now - 90 * DAY).map(A.cycleDays).filter(v => v != null);
    const p50 = JRA.median(cycles), p85 = JRA.quantile(cycles, 0.85);
    const wipCats = S.sortValues('status', new Set(wip.map(i => S.statusName(i.st))));
    const stale = issues.filter(i => !A.isDone(i) && i.up < A.now - 30 * DAY).sort((a, b) => a.up - b.up);

    el.innerHTML = `
      ${card('Aging work in progress', legend([{ label: 'Within the 85th-percentile cycle time', color: 'var(--series-1)' }, { label: 'Older than that', color: 'var(--status-serious)' }]) + slot(w => scatter({
        width: w, height: 300, xCats: wipCats, yLabel: 'days since start',
        points: wip.map(i => { const a = A.age(i).sinceStart ?? 0; return { x: S.statusName(i.st), y: a, color: a > (p85 ?? Infinity) ? 'var(--status-serious)' : 'var(--series-1)', id: i.k, tip: `<b>${esc(i.k)}</b> ${esc(i.t)}<div>${days(a)} since start · ${esc(S.personName(i.as))}</div>` }; }),
        refLines: [p50 != null && { v: p50, label: `50% of recent items finished within ${days(p50)}` }, p85 != null && { v: p85, label: `85% within ${days(p85)}` }].filter(Boolean),
      })), { sub: `${wip.length} in-progress work items, by current status. Items older than the 85th-percentile cycle time are highlighted. Click a dot to open it.` })}
      <div class="grid2">
        ${card('Time in status', barList(tis.map(r => ({ label: S.statusName(r.status), value: r.median, color: CAT_COLOR[A.cat(r.status)], tip: `<b>${esc(S.statusName(r.status))}</b><div>median ${days(r.median)}, 85th pct ${days(r.p85)}</div><div>${r.n} issues</div>` })), { fmt: days }), { sub: 'Median days per visit to each status (time so far included for issues still there).' })}
        ${card('Reopened', `<p class="big">${reopened.length} <span class="muted">issues moved back out of a done status</span></p><ul class="feed">${reopened.slice(0, 12).map(i => `<li><span class="age">×${A.reopens(i)}</span> <a href="#" data-open="${esc(i.k)}">${esc(i.k)}</a> ${esc(i.t)}</li>`).join('')}</ul>`)}
      </div>
      ${card('Status transitions', `<div class="table-wrap"><table class="pivot matrix"><thead><tr><th>from ↓ to →</th>${involved.map(s => `<th class="num">${esc(s)}</th>`).join('')}</tr></thead><tbody>${involved.map(f => `<tr><th>${esc(f)}</th>${involved.map(t => { const n = m[f + '\u0000' + t] ?? 0; return `<td class="num heat" style="--h:${(n / tmax).toFixed(3)}"${n ? ` data-tip="${esc(`${f} → ${t}: <b>${n}</b>`)}"` : ''}>${n || ''}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`, { sub: 'How often issues moved from one status to another. Backward moves show rework.' })}
      ${card('Stale open issues', `<p class="sub">${stale.length} open issues not updated for 30+ days.</p><ul class="feed">${stale.slice(0, 20).map(i => `<li><span class="age">${days((A.now - i.up) / DAY)}</span> <a href="#" data-open="${esc(i.k)}">${esc(i.k)}</a> ${esc(i.t)} <span class="muted">${esc(S.statusName(i.st))} · ${esc(S.personName(i.as))}</span></li>`).join('')}</ul>`)}`;
  }


  // ---------- Portfolio (portfolio reports only) ----------
  const P = S.P;
  /** Workstreams with standard work items in this set, in config order. */
  const streamsIn = issues => (P ? P.streams.filter(s => issues.some(i => i.lvl === 0 && i.ws.includes(s.id))) : []);
  /** The status names these items are done in: what "done" means in a workstream. */
  const doneMeans = items => [...new Set(items.filter(i => A.isDone(i)).map(i => S.statusName(i.st)))];

  /** Views that add up work items: say so when the view spans workstreams whose "done" differs. */
  function mixedNotice(issues, tab) {
    const ss = streamsIn(issues);
    if (ss.length < 2) return '';
    return `<section class="card notice"><p><b>${ss.length} workstreams in view.</b> Each counts different statuses as done, so their totals don't add up to anything meaningful and no forecast is shown.
      Pick one: ${ss.map(s => `<a href="#"${drillAttr({ stream: s.name }, tab)}>${esc(s.name)}</a>`).join(' · ')}, or compare them on the <a href="#"${drillAttr({}, 'portfolio')}>Portfolio</a> tab.</p></section>`;
  }

  function portfolio(el, issues) {
    const items = work(issues);
    const range = S.state.opts.range ?? '180';
    const first = items.length ? Math.min(...items.map(i => i.cr)) : A.now;
    const from = range === 'all' ? first : Math.max(first, A.now - Number(range) * DAY);
    const t = S.target(), cfg = S.meta.forecast ?? {}, growth = !!S.state.opts.growth;
    const since = A.now - 14 * DAY;
    const xMax = Math.max(A.now + 8 * WEEK, (t?.t ?? 0) + 3 * WEEK);

    const rows = P.streams.map(s => {
      const xs = items.filter(i => i.ws.includes(s.id));
      if (!xs.length) return null;
      const fc = JRA.forecast(A, xs, { weeks: cfg.weeks ?? 12, runs: cfg.runs ?? 4000, growth, target: t });
      const bu = A.burnup(xs, from), open = bu.scope.map((v, j) => v - bu.done[j]);
      const wk = A.burnup(xs, A.now - 12 * WEEK), wOpen = wk.scope.map((v, j) => v - wk.done[j]).filter((_, j, a) => (a.length - 1 - j) % 7 === 0);
      return {
        s, xs, fc, x: bu.x, open, wOpen, done: doneMeans(xs),
        nOpen: xs.filter(i => !A.isDone(i)).length,
        inn: xs.filter(i => i.cr >= since).length, out: xs.filter(i => (A.completedAt(i) ?? 0) >= since).length,
      };
    }).filter(Boolean);
    const when = v => (v ? fmtD(v) : 'beyond 5 years');
    const doneText = r => (r.done.length ? r.done.map(esc).join(', ') : '<span class="muted">nothing done yet</span>');

    const table = `<div class="table-wrap"><table class="portfolio"><thead><tr><th>Workstream</th><th>Space</th><th class="num">Work items</th><th class="num">Open</th><th class="num nowrap">Last 14 days</th><th class="nowrap">Open, 12 weeks</th><th class="nowrap">50% / 85% likely done by</th>${t ? `<th class="nowrap">Done by ${esc(t.name)}</th>` : ''}<th>Counts as done</th></tr></thead><tbody>
      ${rows.map(r => `<tr>
        <td><a href="#"${drillAttr({ stream: r.s.name }, 'flow')}>${esc(r.s.name)}</a></td><td class="nowrap">${esc(r.s.space)}</td>
        <td class="num">${fmtN(r.xs.length)}</td><td class="num">${fmtN(r.nOpen)}</td><td class="num nowrap">+${fmtN(r.inn)} / ✓${fmtN(r.out)}</td>
        <td>${spark(r.wOpen, { tip: `Open work items at the end of each of the last ${r.wOpen.length} weeks: <b>${r.wOpen.join(', ')}</b>` })}</td>
        <td class="nowrap">${r.fc.mc.feasible ? `${when(r.fc.p50)} / ${when(r.fc.p85)}` : '<span class="muted">no completions to forecast from</span>'}</td>
        ${t ? `<td class="nowrap">${r.fc.mc.feasible ? `<span class="status ${probClass(r.fc.prob)}">${r.fc.prob == null ? 'date passed' : probText(r.fc.prob)}</span>` : '–'}</td>` : ''}
        <td>${doneText(r)}</td></tr>`).join('')}
    </tbody></table></div>`;

    const multiples = rows.map(r => {
      const last = r.open[r.open.length - 1] ?? 0;
      const proj = r.fc.mc.feasible ? [r.fc.p50 && { name: '50%', color: 'var(--series-2)', points: [[A.now, last], [r.fc.p50, 0]] }, r.fc.p85 && { name: '85%', color: 'var(--series-2)', points: [[A.now, last], [r.fc.p85, 0]] }].filter(Boolean) : [];
      const markers = [t && t.t > from && { t: t.t, label: t.name }].filter(Boolean);
      return card(r.s.name, slot(w => timeSeries({ width: w, height: 180, x: r.x, series: [{ name: 'Open', color: 'var(--series-1)', values: r.open }], markers, extra: proj, xMax })),
        { sub: `${fmtN(r.open[0] ?? 0)} open at the start of the period, ${fmtN(last)} now. Done means: ${doneText(r)}.` });
    }).join('');

    // Dependencies between workstreams: issue links and parent/child, each pair counted once.
    const pairs = new Map(), outside = new Map(), seen = new Set();
    for (const i of issues) {
      if (!i.ws.length) continue;
      for (const [rel, k] of [...i.ln, ...(i.par ? [['is a child of', i.par]] : [])]) {
        const j = S.byKey.get(k);
        if (!j) { const sp = k.split('-')[0]; if (!P.spaces.some(x => x.key === sp)) (outside.get(sp) ?? outside.set(sp, new Set()).get(sp)).add(k); continue; }
        const id = [i.k, j.k].sort().join('|');
        if (seen.has(id) || !j.ws.length || i.ws.some(w => j.ws.includes(w))) continue;
        seen.add(id);
        const key = [S.streamName(i.ws[0]), S.streamName(j.ws[0])].sort().join(' ↔ ');
        (pairs.get(key) ?? pairs.set(key, []).get(key)).push([i, rel, j]);
      }
    }
    const link = i => `<a href="#" data-open="${esc(i.k)}">${esc(i.k)}</a>`;
    const deps = [...pairs].sort((a, b) => b[1].length - a[1].length);
    // Issue links first in the examples: parent/child pairs (an epic on one board, its children on another) are the common case.
    const isParent = p => p[1] === 'is a child of';
    const depBody = (deps.length ? `<div class="table-wrap"><table class="history"><thead><tr><th>Between</th><th class="num">Links</th><th class="num">Parent / child</th><th>For example</th></tr></thead><tbody>${deps.map(([k, ps]) => `<tr><td class="nowrap">${esc(k)}</td><td class="num">${fmtN(ps.filter(p => !isParent(p)).length)}</td><td class="num">${fmtN(ps.filter(isParent).length)}</td><td>${[...ps].sort((a, b) => isParent(a) - isParent(b)).slice(0, 4).map(([i, rel, j]) => `${link(i)} <span class="muted">${esc(rel)}</span> ${link(j)}`).join(' · ')}${ps.length > 4 ? ' …' : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No links or parent/child relations between workstreams in view.</p>')
      + (outside.size ? `<p class="sub">Also referenced, outside this portfolio: ${[...outside].map(([sp, ks]) => `<b>${esc(sp)}</b> (${ks.size} issue${ks.size === 1 ? '' : 's'})`).join(', ')}.</p>` : '');

    // People with open work in more than one workstream.
    const load = new Map();
    for (const i of items) if (i.as && !A.isDone(i)) for (const w of i.ws) { const m = load.get(i.as) ?? load.set(i.as, new Map()).get(i.as); m.set(w, (m.get(w) ?? 0) + 1); }
    const shared = [...load].filter(([, m]) => m.size > 1).sort((a, b) => b[1].size - a[1].size || S.personName(a[0]).localeCompare(S.personName(b[0])));
    const peopleBody = shared.length ? `<div class="table-wrap"><table class="history"><thead><tr><th>Person</th>${rows.map(r => `<th class="num">${esc(r.s.name)}</th>`).join('')}</tr></thead><tbody>${shared.map(([p, m]) => `<tr><td class="nowrap"><a href="#"${drillAttr({ assignee: S.personName(p) }, 'issues')}>${esc(S.personName(p))}</a></td>${rows.map(r => `<td class="num">${m.get(r.s.id) ? fmtN(m.get(r.s.id)) : '<span class="muted">–</span>'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nobody has open work in more than one workstream.</p>';

    el.innerHTML = `
      <div class="controls lead">
        <label>Period <select data-opt="range">${[['90', 'Last 90 days'], ['180', 'Last 180 days'], ['365', 'Last year'], ['all', 'All time']].map(([v, l]) => `<option value="${v}"${v === range ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="toggle"><input type="checkbox" data-opt="growth"${growth ? ' checked' : ''}> Include scope growth</label>
        ${targetEditor()}
      </div>
      ${card('Workstreams', rows.length ? table : '<p class="muted">No standard work items in view.</p>', { sub: `One row per workstream: a board, or the issues of a space on none of the listed boards. Each counts its own statuses as done, so they are forecast separately and never added up. Standard work items only. Click a workstream for its Flow tab; every other tab can be filtered by Workstream and Space.` })}
      ${rows.length ? `<div class="section-head"><h3>Burn-down per workstream</h3><p class="sub">Open work items at the end of each day, with projections to zero at the 50% and 85% dates. Same time axis for all; each has its own vertical scale.</p></div><div class="grid2">${multiples}</div>` : ''}
      ${card('Dependencies between workstreams', depBody, { sub: 'Issue links and parent/child relations that cross a workstream boundary, each pair counted once. Click a key to open it.' })}
      ${card('People in several workstreams', peopleBody, { sub: 'Open work items per person, for everyone with open work in more than one workstream.' })}`;
  }

  // ---------- Flow ----------
  /** Subtitle for the weekly chart: net change in open work over the full weeks shown and the last 8. */
  function weekSummary(created, completed) {
    const net = n => { const c = created.slice(-1 - n, -1).reduce((s, v) => s + v, 0), d = completed.slice(-1 - n, -1).reduce((s, v) => s + v, 0); return { c, d, txt: d > c ? `<b>down ${fmtN(d - c)}</b>` : d < c ? `<b>up ${fmtN(c - d)}</b>` : '<b>unchanged</b>' }; };
    const all = net(created.length - 1), last = net(8);
    return `Same scale, side by side. Over the last ${created.length - 1} full weeks ${fmtN(all.c)} created and ${fmtN(all.d)} completed: open work ${all.txt}. Last 8 weeks: ${last.txt} (${fmtN(last.c)} in, ${fmtN(last.d)} out). The current week is partial.`;
  }

  function flow(el, issues) {
    const items = work(issues);
    const range = S.state.opts.range ?? '180';
    const first = items.length ? Math.min(...items.map(i => i.cr)) : A.now;
    const from = range === 'all' ? first : Math.max(first, A.now - Number(range) * DAY);
    const fc = forecast(issues);
    const bu = A.burnup(items, from);
    const t = S.target();
    const lastScope = bu.scope[bu.scope.length - 1] ?? 0, lastDone = bu.done[bu.done.length - 1] ?? 0;
    const proj = [fc?.p50 && { name: '50%', color: 'var(--series-2)', points: [[A.now, lastDone], [fc.p50, lastScope]] }, fc?.p85 && { name: '85%', color: 'var(--series-2)', points: [[A.now, lastDone], [fc.p85, lastScope]] }].filter(Boolean);
    const open = bu.scope.map((s, j) => s - bu.done[j]);
    const projDown = proj.map(p => ({ ...p, points: [[A.now, lastScope - lastDone], [p.points[1][0], 0]] }));
    // Axis ends a few weeks past the target (or 8 weeks out); projections beyond it are clipped.
    const xMax = Math.max(A.now + 8 * WEEK, (t?.t ?? 0) + 3 * WEEK);
    const markers = [t && t.t > from && { t: t.t, label: t.name }, fc?.p50 && { t: fc.p50, label: '50%' }, fc?.p85 && { t: fc.p85, label: '85%' }].filter(Boolean);

    // CFD bands: the board's columns when the view is one board (a Board filter, one board workstream,
    // or a report with a single board), else status categories.
    const selBoards = [...(S.state.filters.board ?? [])], ss = streamsIn(issues);
    const board = selBoards.length === 1 ? S.meta.boards.find(b => b.name === selBoards[0])
      : ss.length === 1 && ss[0].board ? S.meta.boards.find(b => b.id === ss[0].board)
      : S.meta.boards.length === 1 ? S.meta.boards[0] : null;
    const catBands = S.CAT_ORDER.map(c => ({ name: S.CAT_LABEL[c], statuses: Object.keys(S.meta.statuses).filter(s => S.meta.statuses[s].c === c), color: CAT_COLOR[c] }));
    const bands = (board?.columns?.length ? board.columns.map((c, k) => ({ ...c, color: SERIES(k) })) : catBands);
    const cfd = A.cfd(items, [...bands].reverse(), from);
    const tp = A.throughput(items, 26), ar = A.arrivals(items, 26);
    const done = items.filter(i => (A.completedAt(i) ?? 0) >= from);
    const cyc = done.map(i => ({ i, c: A.cycleDays(i) })).filter(x => x.c != null);
    const p50 = JRA.median(cyc.map(x => x.c)), p85 = JRA.quantile(cyc.map(x => x.c), 0.85);

    el.innerHTML = `
      <div class="controls lead">
        <label>Period <select data-opt="range">${[['90', 'Last 90 days'], ['180', 'Last 180 days'], ['365', 'Last year'], ['all', 'All time']].map(([v, l]) => `<option value="${v}"${v === range ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        <span class="sub">Standard work items only (${items.length} in view); epics and subtasks are excluded.</span>
      </div>
      ${mixedNotice(issues, 'flow')}
      ${forecastCard(fc)}
      ${card('Burn-down', legend([{ label: 'Open work items', color: 'var(--series-1)' }, ...(projDown.length ? [{ label: 'Projection to zero (50% / 85%)', color: 'var(--series-2)' }] : [])]) + slot(w => timeSeries({
        width: w, height: 300, x: bu.x,
        series: [{ name: 'Open', color: 'var(--series-1)', values: open }],
        markers, extra: projDown, xMax,
      })), { sub: `Work items not in a done status at the end of each day: ${fmtN(open[0] ?? 0)} at the start of the period, ${fmtN(lastScope - lastDone)} now. Falling means you are closing faster than new work arrives.` })}
      ${card('Burn-up', legend([{ label: 'Scope (created)', color: 'var(--series-1)' }, { label: 'Done', color: 'var(--series-3)' }, ...(proj.length ? [{ label: 'Projection (50% / 85%)', color: 'var(--series-2)' }] : [])]) + slot(w => timeSeries({
        width: w, height: 300, x: bu.x,
        series: [{ name: 'Scope', color: 'var(--series-1)', values: bu.scope }, { name: 'Done', color: 'var(--series-3)', values: bu.done }],
        markers, extra: proj, xMax,
      })), { sub: 'Cumulative issues created vs. in a done status at the end of each day. The gap is the remaining work.' })}
      ${card('Cumulative flow', legend(bands.map(b => ({ label: b.name, color: b.color }))) + slot(w => timeSeries({ width: w, height: 300, x: cfd.x, stacked: true, series: cfd.bands.map((b, k) => ({ name: b.name, values: b.values, color: [...bands].reverse()[k].color })) })),
        { sub: board ? `Columns of board “${esc(board.name)}”.` : 'By status category. Filter to a single board to see its columns.' })}
      ${card('Created vs. completed per week', legend([{ label: 'Created', color: 'var(--series-1)' }, { label: 'Completed', color: 'var(--series-3)' }]) + slot(w => columns({
        width: w, labels: tp.x, labelFmt: fmtDShort,
        series: [{ name: 'Created', color: 'var(--series-1)', values: ar.values }, { name: 'Completed', color: 'var(--series-3)', values: tp.values }],
        tip: (l, j) => { const n = tp.values[j] - ar.values[j]; return `<b>Week of ${l}</b><div>${ar.values[j]} created · ${tp.values[j]} completed</div><div>Open work ${n > 0 ? `down ${n}` : n < 0 ? `up ${-n}` : 'unchanged'}</div>`; },
        refLine: tp.values.length > 1 ? { v: JRA.median(tp.values.slice(0, -1)), label: 'median completed' } : null,
      })), { sub: weekSummary(ar.values, tp.values) })}
      ${card('Cycle time', slot(w => scatter({
        width: w, height: 300, xDomain: [from, A.now], yLabel: 'days',
        points: cyc.map(({ i, c }) => ({ x: A.completedAt(i), y: c, color: 'var(--series-1)', id: i.k, tip: `<b>${esc(i.k)}</b> ${esc(i.t)}<div>${days(c)} from start to done · ${fmtD(A.completedAt(i))}</div>` })),
        refLines: [p50 != null && { v: p50, label: `50%: ${days(p50)}` }, p85 != null && { v: p85, label: `85%: ${days(p85)}` }].filter(Boolean),
      })), { sub: `${cyc.length} items completed in the period: days from first moving into progress until done. Click a dot to open it.` })}
      ${trackRecordCard(issues)}
      ${lostScopeCard()}`;
  }

  // ---------- history (per-run summaries; whole scope, filters do not apply) ----------
  const H = S.meta.history ?? null;
  const earlierRuns = () => (H ? H.runs.filter(r => !r.current) : []);
  const noHistory = what => `<p class="muted">${what} appears from the second run: every run saves a small summary in <code>history/</code> next to the report.</p>`;
  const runLabel = r => fmtD(r.generatedAt);

  function trackRecordCard(issues) {
    if (!H) return '';
    // A portfolio forecasts per workstream, so its track record is per workstream too.
    const ss = P ? streamsIn(issues) : [];
    if (P && ss.length !== 1) return card('Forecast track record', '<p class="muted">Each workstream is forecast on its own. Filter to one workstream to see how its earlier forecasts turned out.</p>');
    const runs = (P ? earlierRuns().filter(r => r.streams?.[ss[0].id]).map(r => ({ generatedAt: r.generatedAt, ...r.streams[ss[0].id] })) : earlierRuns()).slice(-12).reverse();
    const outcome = r => {
      const c = r.check, f = r.forecast, base = c.open - c.lost;
      const lostNote = c.lost ? ` <span class="muted">(${c.lost} left the scope)</span>` : '';
      if (!base) return `<span class="muted">nothing open${c.lost ? ' still in scope' : ''}</span>${lostNote}`;
      if (c.lastDone != null) {
        const ok = f.p85 != null && c.lastDone <= f.p85;
        return `All done ${fmtD(c.lastDone)} <span class="status ${ok ? 'good' : 'critical'}">${f.p50 != null && c.lastDone <= f.p50 ? 'by the 50% date' : ok ? 'by the 85% date' : 'after the 85% date'}</span>${lostNote}`;
      }
      const missed = f.p85 != null && f.p85 < A.now;
      return `${fmtN(c.done)} of ${fmtN(base)} done, ${fmtN(c.stillOpen)} open${missed ? ' <span class="status critical">85% date passed</span>' : ''}${lostNote}`;
    };
    const body = runs.length ? `<div class="table-wrap"><table class="history"><thead><tr><th>Forecast made</th><th class="num">Open then</th><th>50% likely by</th><th>85% likely by</th><th>Done by target</th><th>How that work turned out</th></tr></thead><tbody>${runs.map(r => `<tr>
        <td class="nowrap">${runLabel(r)}</td><td class="num">${fmtN(r.check.open)}</td>
        <td class="nowrap">${r.forecast.p50 ? fmtD(r.forecast.p50) : '–'}</td><td class="nowrap">${r.forecast.p85 ? fmtD(r.forecast.p85) : '–'}</td>
        <td class="nowrap">${r.forecast.target ? `${r.forecast.prob == null ? 'date passed' : probText(r.forecast.prob)} <span class="muted">${esc(r.forecast.target.name)} ${esc(r.forecast.target.date)}</span>` : '–'}</td>
        <td>${outcome(r)}</td></tr>`).join('')}</tbody></table></div>` : noHistory('The forecast track record');
    return card(P ? `Forecast track record: ${ss[0].name}` : 'Forecast track record', body, { sub: `Each earlier forecast against what happened since to the work items open at that moment (today's data). Saved forecasts use the report's default view: ${P ? 'the whole workstream' : 'whole project'}, no scope growth, the configured target. Other filters do not apply.` });
  }

  function lostScopeCard() {
    if (!H?.lost.length) return '';
    const lost = [...H.lost].sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
    const done = lost.filter(l => l.cat === 'done' && l.lvl === 0).length;
    return card(`Left the scope (${lost.length})`, `<div class="table-wrap"><table class="issues"><thead><tr><th>Key</th><th>Summary</th><th>Last known status</th><th>Completed</th><th>Last seen</th></tr></thead><tbody>${lost.map(l => `<tr>
        <td class="key nowrap">${esc(l.k)}</td><td class="summary">${esc(l.t)}</td><td class="nowrap"><span class="pill small cat-${esc(l.cat)}">${esc(S.CAT_LABEL[l.cat] ?? l.cat)}</span></td>
        <td class="nowrap">${l.completedAt ? fmtD(l.completedAt) : ''}</td><td class="nowrap">${fmtD(l.lastSeen)}</td></tr>`).join('')}</tbody></table></div>`,
      { sub: `Issues seen in an earlier run that are no longer in the project or on its boards: moved elsewhere or deleted. The charts above no longer count them${done ? `, so past throughput is ${done} completion${done === 1 ? '' : 's'} lower than it was` : ''}.` });
  }

  function qualityTrendCards() {
    if (!H) return '';
    const runs = H.runs.filter(r => r.quality.n).slice(-12);
    if (runs.length < 2) return card('Quality over time', noHistory('The quality trend'));
    const rows = [...runs].reverse().map((r, k, a) => {
      const prev = a[k + 1];
      const changed = prev && prev.quality.rules !== r.quality.rules;
      const q = r.quality;
      return `<tr><td class="nowrap">${runLabel(r)}${r.current ? ' <span class="muted">(this report)</span>' : ''}</td><td class="num">${fmtN(q.n)}</td><td class="num">${Math.round(q.mean * 100)}%</td>
        <td class="bar-cell">${stackBar(['Good', 'Fair', 'Poor'].map(g => ({ label: g, value: q[g], color: `var(--status-${GRADE[g]})` })), { height: 10 })}</td>
        <td>${changed ? '<span class="warn-tag">check rules changed since the run below: not comparable</span>' : ''}</td></tr>`;
    }).join('');
    const overall = card('Quality over time', `<div class="table-wrap"><table class="history"><thead><tr><th>Run</th><th class="num">Assessed</th><th class="num">Average score</th><th>Good / Fair / Poor</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`,
      { sub: 'Scores as they were at each run, for every issue in scope then. Changes come from new issues, edited issues and issues leaving the scope. Filters do not apply.' });

    const cols = runs.slice(-6), last = cols[cols.length - 1];
    const ids = Object.entries(last.quality.byReporter).filter(([, [, n]]) => n >= 3).sort((a, b) => b[1][1] - a[1][1]).map(([id]) => id);
    if (!ids.length) return overall;
    const name = id => S.people[id]?.[0] ?? H.people[id] ?? 'Unknown';
    const cell = (r, id) => { const v = r.quality.byReporter[id]; return v ? `${Math.round(v[0] * 100)}% <span class="muted small">${v[1]}</span>` : '<span class="muted">–</span>'; };
    const byReporter = card('Quality over time by reporter', `<div class="table-wrap"><table class="history"><thead><tr><th>Reporter</th>${cols.map(r => `<th class="num nowrap">${fmtDShort(r.generatedAt)}</th>`).join('')}<th class="num">Change</th></tr></thead><tbody>${ids.map(id => {
      // Baseline: the earliest run scored with the same rules as the latest, so a rule edit is not read as a change.
      const first = cols.find(r => r.quality.rules === last.quality.rules && r.quality.byReporter[id]);
      const d = first && first !== last ? Math.round((last.quality.byReporter[id][0] - first.quality.byReporter[id][0]) * 100) : null;
      return `<tr><th>${esc(name(id))}</th>${cols.map(r => `<td class="num nowrap">${cell(r, id)}</td>`).join('')}<td class="num">${d == null ? '' : `<span class="status ${d > 0 ? 'good' : d < 0 ? 'critical' : ''}">${d > 0 ? '+' : ''}${d} pts</span>`}</td></tr>`;
    }).join('')}</tbody></table></div>`, { sub: 'Average score of the issues each person reported (count in grey), for reporters with 3 or more assessed issues in the latest run.' });
    return overall + byReporter;
  }

  // ---------- People ----------
  function people(el, issues) {
    const since = A.now - 30 * DAY;
    const rows = new Map();
    const row = id => rows.get(id) ?? rows.set(id, { id, todo: 0, prog: 0, done30: 0, done: 0, oldest: 0, reported: 0 }).get(id);
    for (const i of issues) {
      const r = row(i.as ?? null), c = A.cat(i.st);
      if (c === 'new') r.todo++;
      else if (c === 'indeterminate') { r.prog++; r.oldest = Math.max(r.oldest, A.age(i).inStatus); }
      else { r.done++; if ((A.completedAt(i) ?? 0) >= since) r.done30++; }
      if (i.rp) row(i.rp).reported++;
    }
    const list = [...rows.values()].filter(r => r.todo + r.prog + r.done + r.reported).sort((a, b) => b.todo + b.prog - (a.todo + a.prog) || b.done - a.done);
    const max = Math.max(1, ...list.map(r => r.todo + r.prog));
    el.innerHTML = card('People', `<div class="table-wrap"><table class="people">
      <thead><tr><th>Person</th><th>Open work</th><th class="num">To do</th><th class="num">In progress</th><th class="num">Done (30 d)</th><th class="num">Done (all)</th><th class="num">Longest in status</th><th class="num">Reported</th></tr></thead>
      <tbody>${list.map(r => { const name = S.personName(r.id); return `<tr>
        <th><a href="#"${drillAttr({ assignee: name })}>${esc(name)}</a>${r.id && S.people[r.id]?.[1] ? `<div class="muted small">${esc(S.people[r.id][1])}</div>` : ''}</th>
        <td class="bar-cell">${stackBar([{ label: 'To do', value: r.todo, color: CAT_COLOR.new }, { label: 'In progress', value: r.prog, color: CAT_COLOR.indeterminate }], { height: 10, width: `${(100 * (r.todo + r.prog) / max).toFixed(1)}%` })}</td>
        <td class="num">${r.todo || ''}</td><td class="num">${r.prog || ''}</td><td class="num">${r.done30 || ''}</td><td class="num">${r.done || ''}</td>
        <td class="num">${r.prog ? days(r.oldest) : ''}</td><td class="num">${r.reported || ''}</td></tr>`; }).join('')}</tbody></table></div>`,
      { sub: 'Assigned work within the current filters. Click a name to list their issues.' });
  }

  // ---------- Quality ----------
  const GRADE = { Good: 'good', Fair: 'warning', Poor: 'critical' };
  const KIND_NAME = { bug: 'Bugs', feature: 'Features', story: 'Stories', other: 'Other issues', epic: 'Epics' };
  function quality(el, issues) {
    const Q = S.Q, qm = S.meta.quality;
    const assessed = issues.filter(i => Q.byKey.has(i.k));
    const grades = { Good: 0, Fair: 0, Poor: 0 };
    for (const i of assessed) grades[Q.byKey.get(i.k).grade]++;
    const inView = new Set(issues.map(i => i.k));
    const dups = Q.dups.filter(d => inView.has(d.a) || inView.has(d.b));
    const misfiled = assessed.filter(i => Q.byKey.get(i.k).failed.some(r => r.id === 'notDefect' || r.id === 'notQuestion'));
    const gradePill = g => `<span class="status ${GRADE[g]}">${g}</span>`;

    const kinds = ['bug', 'feature', 'story', 'other', 'epic'].map(kind => {
      const list = assessed.filter(i => Q.byKey.get(i.k).kind === kind);
      if (!list.length) return '';
      const types = [...new Set(list.map(i => i.ty))];
      const rows = Q.checks.filter(c => c.kinds.includes(kind)).map(c => {
        const ok = list.filter(i => Q.byKey.get(i.k).results.find(r => r.id === c.id)?.ok).length;
        return { label: c.label, value: Math.round((100 * ok) / list.length), color: 'var(--series-1)', tip: `${ok} of ${list.length} ${KIND_NAME[kind].toLowerCase()} pass. Click to list the ${list.length - ok} that don't.`, attrs: ok < list.length ? drillAttr({ qualityGap: c.label, type: types }) : '' };
      });
      const g = { Good: 0, Fair: 0, Poor: 0 }; for (const i of list) g[Q.byKey.get(i.k).grade]++;
      return card(`${KIND_NAME[kind]} (${list.length})`, stackBar(['Good', 'Fair', 'Poor'].map(x => ({ label: x, value: g[x], color: `var(--status-${GRADE[x]})` })), { height: 12, showLegend: true }) + barList(rows, { max: 100, fmt: v => `${v}%`, wideLabels: true }),
        { sub: `Share of ${KIND_NAME[kind].toLowerCase()} passing each check (${types.join(', ')}).` });
    }).join('');

    const weakest = assessed.filter(i => !A.isDone(i) && i.lvl !== 1).sort((a, b) => Q.byKey.get(a.k).score - Q.byKey.get(b.k).score || S.meta.priorities.indexOf(a.pr) - S.meta.priorities.indexOf(b.pr)).slice(0, 30);
    const weakTable = `<div class="table-wrap"><table class="issues"><thead><tr><th>Key</th><th>Type</th><th>Summary</th><th>Priority</th><th>Quality</th><th>What is missing</th></tr></thead><tbody>${weakest.map(i => {
      const q = Q.byKey.get(i.k);
      return `<tr data-open="${esc(i.k)}"><td class="key nowrap">${esc(i.k)}</td><td class="nowrap">${esc(i.ty)}</td><td class="summary">${esc(i.t)}</td><td class="nowrap">${esc(i.pr ?? '')}</td><td class="nowrap">${gradePill(q.grade)} <span class="muted">${Math.round(q.score * 100)}%</span></td><td class="gaps">${q.failed.map(r => esc(r.label)).join(' · ')}</td></tr>`;
    }).join('')}</tbody></table></div>`;

    const dupTable = dups.length ? `<div class="table-wrap"><table class="issues"><thead><tr><th>Issue</th><th>Copy</th><th>Summary</th><th>Statuses</th><th class="num">Overlap</th></tr></thead><tbody>${dups.map(d => {
      const a = S.byKey.get(d.a), b = S.byKey.get(d.b);
      const differ = A.cat(a.st) !== A.cat(b.st);
      return `<tr><td class="nowrap"><a href="#" data-open="${esc(a.k)}" class="key">${esc(a.k)}</a> <span class="muted">${esc(a.ty)}</span></td><td class="nowrap"><a href="#" data-open="${esc(b.k)}" class="key">${esc(b.k)}</a> <span class="muted">${esc(b.ty)}</span></td><td class="summary">${esc(a.t)}</td><td class="nowrap"><span class="pill small cat-${A.cat(a.st)}">${esc(S.statusName(a.st))}</span> / <span class="pill small cat-${A.cat(b.st)}">${esc(S.statusName(b.st))}</span>${differ ? ' <span class="warn-tag">disagree</span>' : ''}</td><td class="num">${Math.round(d.similarity * 100)}%</td></tr>`;
    }).join('')}</tbody></table></div>` : '<p class="muted">No unlinked copies among the issues in view.</p>';

    const gapLabel = id => Q.checks.find(c => c.id === id).label;
    el.innerHTML = `
      ${qm.notes ? `<section class="card notes"><details open><summary><h3>Reviewer notes</h3><span class="sub">${esc(qm.notesDate ? `Reviewed ${qm.notesDate}. ` : '')}A one-off reading of the issue text; the checks below are recomputed from the data on every build.</span></summary><div class="md">${qm.notes}</div></details></section>` : ''}
      <div class="tiles">
        ${tile('Issues assessed', fmtN(assessed.length), { note: 'epics: description only; subtasks not assessed' })}
        ${['Good', 'Fair', 'Poor'].map(g => tile(g, `${fmtN(grades[g])} <span class="t-pct">${pct(grades[g], assessed.length)}%</span>`, { note: g === 'Good' ? '80% or more of checks pass' : g === 'Fair' ? '50–79% of checks pass' : 'under 50% of checks pass', attrs: drillAttr({ quality: g }) })).join('')}
        ${tile('Unlinked copies', fmtN(dups.length), { note: `${dups.filter(d => A.cat(S.byKey.get(d.a).st) !== A.cat(S.byKey.get(d.b).st)).length} with disagreeing status` })}
        ${tile('Possibly misfiled', fmtN(misfiled.length), { note: 'defects or questions filed as requests', attrs: misfiled.length ? drillAttr({ qualityGap: [gapLabel('notDefect'), gapLabel('notQuestion')] }) : '' })}
      </div>
      <div class="grid2">${kinds}</div>
      ${card('Weakest open issues', weakTable, { sub: 'Lowest quality score first, then priority: the tickets to complete before they are worked on or tested.' })}
      ${card(`Unlinked copies (${dups.length})`, dupTable, { sub: 'Issues whose summary and description are (near-)identical to another issue, with no link between them. Copies whose statuses disagree inflate the remaining scope.' })}
      ${qualityTrendCards()}
      ${card('How issues are checked', `<div class="table-wrap"><table class="checks"><thead><tr><th>Check</th><th>Applies to</th></tr></thead><tbody>${Q.checks.map(c => `<tr><td>${esc(c.label)}${c.weight ? ' <span class="muted">(half weight)</span>' : ''}</td><td>${c.kinds.map(k => KIND_NAME[k]).join(', ')}</td></tr>`).join('')}</tbody></table></div>`, { sub: 'Simple, visible text rules: they test whether the parts a reader needs are present, not whether the writing is good. Score = passed ÷ applicable checks.' })}`;
  }

  return { portfolio, overview, explore, issues: issuesView, epics, process, flow, people, quality, flush };
})();
