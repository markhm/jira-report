// Page chrome: tooltip, theme toggle, filter bar, tab strip, issue drawer.

const UI = (() => {
  const { esc, fmtD } = Charts;
  const $ = (sel, root = document) => root.querySelector(sel);

  // ---------- tooltip (one element, delegated) ----------
  const tip = document.createElement('div');
  tip.className = 'tip';
  document.body.appendChild(tip);
  document.addEventListener('mouseover', e => {
    const t = e.target.closest('[data-tip]');
    if (!t) { tip.style.display = 'none'; return; }
    tip.innerHTML = t.getAttribute('data-tip');
    tip.style.display = 'block';
  });
  document.addEventListener('mousemove', e => {
    if (tip.style.display !== 'block') return;
    const r = tip.getBoundingClientRect();
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  });
  document.addEventListener('scroll', () => { tip.style.display = 'none'; }, true);

  // ---------- theme ----------
  const THEME_KEY = 'jira-report:theme';
  function applyTheme(t) { if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme'); }
  try { applyTheme(localStorage.getItem(THEME_KEY)); } catch { /* storage blocked */ }
  function toggleTheme() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!document.documentElement.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = dark ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage blocked */ }
    App.render();
  }

  // ---------- filter bar ----------
  const PRIMARY = ['stream', 'space', 'board', 'type', 'category', 'status', 'priority', 'assignee', 'epic', 'label'];
  let openMenu = null;

  function filterBar() {
    const el = $('#filters');
    const dims = S.dimList();
    const shown = dims.filter(d => PRIMARY.includes(d.id) || S.state.filters[d.id]?.size);
    const more = dims.filter(d => !shown.includes(d));
    const active = Object.values(S.state.filters).some(s => s.size) || S.state.q;
    el.innerHTML = `
      <input id="q" type="search" placeholder="Search key, summary, description, comments…" value="${esc(S.state.q)}" aria-label="Search">
      ${shown.map(d => chip(d)).join('')}
      ${more.length ? `<select id="more-filter" aria-label="Add filter"><option value="">+ Filter</option>${more.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select>` : ''}
      <span class="count"></span>
      <button id="clear" class="link"${active ? '' : ' hidden'}>Clear all</button>`;
    barStatus();
    const q = $('#q');
    let timer;
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { S.state.q = q.value; S.changed(); App.render({ keepFilterBar: true }); barStatus(); }, 200); });
    $('#clear')?.addEventListener('click', () => { S.state.filters = {}; S.state.q = ''; S.changed(); App.render(); });
    $('#more-filter')?.addEventListener('change', e => { if (e.target.value) { S.state.filters[e.target.value] = new Set(); openMenu = e.target.value; filterBar(); } });
    el.querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => { openMenu = openMenu === c.dataset.dim ? null : c.dataset.dim; filterBar(); }));
    if (openMenu) menu(openMenu);
  }

  function chip(d) {
    const sel = S.state.filters[d.id];
    const n = sel?.size ?? 0;
    const label = n === 1 ? `${d.name}: ${[...sel][0]}` : n ? `${d.name}: ${n}` : d.name;
    return `<button class="chip${n ? ' on' : ''}${openMenu === d.id ? ' open' : ''}" data-dim="${d.id}" aria-expanded="${openMenu === d.id}">${esc(label.length > 42 ? label.slice(0, 41) + '…' : label)} ▾</button>`;
  }

  function menu(dimId) {
    const d = S.DIMS[dimId];
    const btn = document.querySelector(`.chip[data-dim="${CSS.escape(dimId)}"]`);
    if (!btn) return;
    // Counts reflect every other active filter, so the menu shows what selecting a value would give.
    const base = S.filtered({ except: dimId });
    const counts = new Map();
    for (const i of base) { const vs = d.values(i); for (const v of vs.length ? vs : ['(none)']) counts.set(v, (counts.get(v) ?? 0) + 1); }
    const all = new Set(counts.keys());
    for (const v of S.state.filters[dimId] ?? []) all.add(v);
    const values = S.sortValues(dimId, all, v => counts.get(v) ?? 0);
    const sel = S.state.filters[dimId] ?? new Set();
    const m = document.createElement('div');
    m.className = 'menu';
    m.innerHTML = `<input type="search" placeholder="Filter ${esc(d.name.toLowerCase())}…"><div class="opts">${values.map(v => `<label><input type="checkbox" value="${esc(v)}"${sel.has(v) ? ' checked' : ''}><span>${esc(v)}</span><em>${counts.get(v) ?? 0}</em></label>`).join('')}</div><div class="menu-foot"><button class="link" data-act="only-none">Clear</button><button class="link" data-act="close">Done</button></div>`;
    document.body.appendChild(m);
    const r = btn.getBoundingClientRect();
    m.style.top = `${r.bottom + scrollY + 4}px`;
    m.style.left = `${Math.max(8, Math.min(r.left + scrollX, innerWidth - m.offsetWidth - 8))}px`;
    const search = m.querySelector('input[type=search]');
    search.focus();
    search.addEventListener('input', () => { const q = search.value.toLowerCase(); m.querySelectorAll('.opts label').forEach(l => { l.style.display = l.textContent.toLowerCase().includes(q) ? '' : 'none'; }); });
    m.addEventListener('change', e => {
      const set = S.state.filters[dimId] ??= new Set();
      e.target.checked ? set.add(e.target.value) : set.delete(e.target.value);
      S.changed(); App.render({ keepFilterBar: true }); refreshChips();
    });
    m.addEventListener('click', e => {
      const act = e.target.dataset?.act;
      if (act === 'only-none') { S.state.filters[dimId] = new Set(); S.changed(); closeMenu(); App.render(); }
      if (act === 'close') { closeMenu(); filterBar(); }
    });
  }
  function refreshChips() {
    document.querySelectorAll('#filters .chip').forEach(c => { c.outerHTML = chip(S.DIMS[c.dataset.dim] ? { id: c.dataset.dim, ...S.DIMS[c.dataset.dim] } : null); });
    document.querySelectorAll('#filters .chip').forEach(c => c.addEventListener('click', () => { openMenu = openMenu === c.dataset.dim ? null : c.dataset.dim; filterBar(); }));
    barStatus();
  }
  /** Issue count and the Clear-all button, updated without re-rendering the bar (keeps focus). */
  function barStatus() {
    const cnt = $('#filters .count'), clear = $('#clear');
    if (cnt) cnt.textContent = `${S.filtered().length} of ${S.model.issues.length} issues`;
    if (clear) clear.hidden = !(S.state.q || Object.values(S.state.filters).some(v => v.size));
  }
  function closeMenu() { document.querySelectorAll('.menu').forEach(m => m.remove()); openMenu = null; }
  document.addEventListener('mousedown', e => { if (openMenu && !e.target.closest('.menu') && !e.target.closest('.chip')) { closeMenu(); filterBar(); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (openMenu) { closeMenu(); filterBar(); } else closeDrawer(); } });

  /** Replace a filter with exactly these values and switch tab (used by click-throughs). */
  function drill(filters, tab = 'issues') {
    for (const [k, v] of Object.entries(filters)) S.state.filters[k] = new Set([v].flat());
    S.state.tab = tab;
    S.changed();
    App.render();
    scrollTo({ top: 0 });
  }

  // ---------- issue drawer ----------
  function openIssue(key) {
    const i = S.byKey.get(key);
    if (!i) return;
    const A = S.A, d = $('#drawer');
    const url = `https://${S.meta.host}/browse/${i.k}`;
    const epic = S.epicOf(i);
    const kv = (k, v) => (v == null || v === '' || (Array.isArray(v) && !v.length) ? '' : `<dt>${esc(k)}</dt><dd>${Array.isArray(v) ? v.map(x => `<span class="tag">${esc(x)}</span>`).join(' ') : esc(v)}</dd>`);
    const cycle = A.cycleDays(i);
    d.innerHTML = `
      <div class="drawer-head">
        <div><a href="${url}" target="_blank" rel="noopener" class="key">${esc(i.k)} ↗</a> <span class="muted">${esc(i.ty)}</span></div>
        <button class="icon" id="drawer-close" aria-label="Close">✕</button>
      </div>
      <h2>${esc(i.t)}</h2>
      <div class="status-line"><span class="pill cat-${A.cat(i.st)}">${esc(S.statusName(i.st))}</span>${i.pr ? ` <span class="muted">${esc(i.pr)}</span>` : ''}${A.reopens(i) ? ` <span class="warn-tag">reopened ×${A.reopens(i)}</span>` : ''}</div>
      <dl class="kv">
        ${kv('Assignee', S.personName(i.as))}${kv('Reporter', S.personName(i.rp))}
        ${kv('Created', fmtD(i.cr))}${kv('Updated', fmtD(i.up))}${kv('Completed', A.completedAt(i) && fmtD(A.completedAt(i)))}
        ${kv('Cycle time', cycle != null ? `${cycle.toFixed(1)} days` : null)}${kv('Due', i.due)}
        ${kv('Epic', epic && S.issueLabel(epic))}${kv('Parent', i.par && i.par !== epic ? S.issueLabel(i.par) : null)}
        ${kv('Labels', i.lb)}${kv('Components', i.cp)}${kv('Fix versions', i.fv)}${kv('Resolution', i.res)}
        ${kv('Boards', i.b.map(S.boardName))}
        ${S.meta.customFields.map(f => kv(f.name, i.cf[f.id])).join('')}
      </dl>
      ${i.ln.length ? `<h3>Links</h3><ul class="links">${i.ln.map(([rel, k]) => `<li>${esc(rel)} <a href="#" data-open="${esc(k)}">${esc(k)}</a> ${esc(S.byKey.get(k)?.t ?? '')}</li>`).join('')}</ul>` : ''}
      ${childrenOf(i)}
      ${i.d ? `<h3>Description</h3><div class="prose">${esc(i.d)}</div>` : ''}
      ${i.at.length ? `<h3>Attachments</h3><ul class="links">${i.at.map(([n, size, u]) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(n)}</a> <span class="muted">${Math.round(size / 1024)} KB</span></li>`).join('')}</ul>` : ''}
      ${i.cm.length ? `<h3>Comments (${i.cm.length})</h3>${i.cm.map(([a, t, body]) => `<div class="comment"><div class="muted">${esc(S.personName(a))} · ${fmtD(t)}</div><div class="prose">${esc(body)}</div></div>`).join('')}` : ''}
      <h3>History</h3>
      <table class="hist">${[...i.h].reverse().map(h => `<tr><td class="muted nowrap">${fmtD(h[0])}</td><td>${esc(S.personName(h[1]))}</td><td>${esc(h[2])}</td><td>${h[2] === 'description' ? '<span class="muted">edited</span>' : `${esc(h[3] ?? '∅')} → ${esc(h[4] ?? '∅')}`}</td></tr>`).join('') || '<tr><td class="muted">No changes recorded</td></tr>'}<tr><td class="muted nowrap">${fmtD(i.cr)}</td><td>${esc(S.personName(i.rp))}</td><td>created</td><td></td></tr></table>`;
    d.classList.add('open');
    $('#scrim').classList.add('open');
    d.scrollTop = 0;
    $('#drawer-close').addEventListener('click', closeDrawer);
  }
  function childrenOf(i) {
    const kids = S.model.issues.filter(x => x.par === i.k);
    if (!kids.length) return '';
    return `<h3>Children (${kids.length})</h3><ul class="links">${kids.map(k => `<li><span class="pill small cat-${S.A.cat(k.st)}">${esc(S.statusName(k.st))}</span> <a href="#" data-open="${esc(k.k)}">${esc(k.k)}</a> ${esc(k.t)}</li>`).join('')}</ul>`;
  }
  function closeDrawer() { $('#drawer').classList.remove('open'); $('#scrim').classList.remove('open'); }
  document.addEventListener('click', e => {
    const o = e.target.closest('[data-open]');
    if (o) { e.preventDefault(); openIssue(o.dataset.open); return; }
    const pt = e.target.closest('[data-issue]');
    if (pt) { openIssue(pt.dataset.issue); return; }
    if (e.target.id === 'scrim') closeDrawer();
    const dr = e.target.closest('[data-drill]');
    if (dr) { e.preventDefault(); drill(JSON.parse(dr.dataset.drill), dr.dataset.tab || 'issues'); }
  });

  return { filterBar, toggleTheme, openIssue, drill, closeMenu, $ };
})();
