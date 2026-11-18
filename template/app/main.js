// Boot: header, tabs, render loop.

const App = (() => {
  const TABS = [...(S.P ? [['portfolio', 'Portfolio']] : []), ['overview', 'Overview'], ['explore', 'Explore'], ['issues', 'Issues'], ['epics', 'Epics'], ['process', 'Process'], ['flow', 'Flow'], ['people', 'People'], ...(S.Q ? [['quality', 'Quality']] : [])];
  const { esc } = Charts;

  function header() {
    const m = S.meta;
    document.getElementById('project').textContent = S.P ? `${S.P.title} · ${S.P.spaces.map(s => s.key).join(' + ')}` : `${m.projectName} (${m.project})`;
    document.getElementById('generated').textContent = `Data as of ${new Date(m.generatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} · ${m.host}`;
    document.getElementById('theme').addEventListener('click', UI.toggleTheme);
  }

  function tabs() {
    const el = document.getElementById('tabs');
    el.innerHTML = TABS.map(([id, label]) => `<button role="tab" data-tab="${id}" aria-selected="${S.state.tab === id}">${label}</button>`).join('');
    el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { S.state.tab = b.dataset.tab; S.changed(); render({ keepFilterBar: true }); }));
  }

  function render({ keepFilterBar = false } = {}) {
    if (!keepFilterBar) { UI.closeMenu(); UI.filterBar(); }
    if (!TABS.some(([id]) => id === S.state.tab)) S.state.tab = S.DEFAULT_TAB;
    tabs();
    const el = document.getElementById('view');
    const view = Views[S.state.tab];
    try {
      view(el, S.filtered());
      Views.flush();
    } catch (e) {
      el.innerHTML = `<section class="card"><h3>Something went wrong rendering this tab</h3><pre>${esc(e.stack || e.message)}</pre></section>`;
      console.error(e);
    }
  }

  let lastW = innerWidth;
  addEventListener('resize', () => { if (Math.abs(innerWidth - lastW) < 40) return; lastW = innerWidth; clearTimeout(App._t); App._t = setTimeout(() => render({ keepFilterBar: true }), 150); });
  addEventListener('hashchange', () => { S.readHash(); S.changed(); render(); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => render({ keepFilterBar: true }));

  return { render, header };
})();

App.header();
App.render();
