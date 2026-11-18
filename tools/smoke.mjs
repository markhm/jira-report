// Browser smoke test: opens a rendered report in headless Chrome (DevTools protocol, no deps),
// renders every tab, exercises filters, drill-down, the issue drawer and the target editor, and
// fails on any page error.   node tools/smoke.mjs [report.html]   (default: reports/fixture.html)

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REPO } from '../lib/config.mjs';

const CHROME = process.env.CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
if (!CHROME) { console.error('smoke: Chrome not found (set $CHROME)'); process.exit(2); }
const file = resolve(process.argv[2] ?? join(REPO, 'reports', 'fixture.html'));
const profile = mkdtempSync(join(tmpdir(), 'jr-smoke-'));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let ws, id = 0;
const pending = new Map(), errors = [];
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expr => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const checks = [];
const check = (name, ok, detail = '') => { checks.push([name, ok]); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); };

try {
  let target;
  for (let k = 0; k < 50 && !target; k++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch { await sleep(100); }
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', m => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map(a => a.value ?? a.description).join(' '));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: 'file://' + file });
  await sleep(1200);

  const tabs = await evaluate(`return [...document.querySelectorAll('#tabs [data-tab]')].map(b => b.dataset.tab)`);
  for (const tab of tabs) {
    const r = await evaluate(`document.querySelector('[data-tab="${tab}"]').click(); await new Promise(r => setTimeout(r, 150));
      const v = document.getElementById('view'); return { len: v.innerHTML.length, err: v.textContent.includes('Something went wrong'), svg: v.querySelectorAll('svg').length };`);
    check(`tab ${tab} renders`, r.len > 500 && !r.err, `${r.svg} chart(s)`);
  }
  const flowCards = await evaluate(`document.querySelector('[data-tab="flow"]').click(); await new Promise(r => setTimeout(r, 150));
    const want = ['Burn-up', 'Burn-down', 'Cumulative flow', 'Created vs. completed per week', 'Cycle time'];
    const have = [...document.querySelectorAll('#view .card h3')].map(h => h.textContent);
    return want.filter(t => !have.includes(t));`);
  check('flow tab has burn-up, burn-down and created vs. completed', !flowCards.length, flowCards.length ? `missing: ${flowCards.join(', ')}` : '');

  // Per-run history cards: filled when the report has earlier runs, an explanatory note otherwise.
  const hist = await evaluate(`const runs = S.meta.history?.runs.filter(r => !r.current).length ?? 0;
    const text = async tab => { document.querySelector('[data-tab="' + tab + '"]')?.click(); await new Promise(r => setTimeout(r, 150)); return document.getElementById('view').textContent; };
    // A portfolio keeps a track record per workstream: look at the first one.
    if (S.P) { S.state.filters.stream = new Set([S.P.streams[0].name]); S.changed(); }
    const flow = await text('flow'), quality = S.Q ? await text('quality') : '';
    document.querySelector('[data-tab="flow"]').click(); await new Promise(r => setTimeout(r, 150));
    const rows = document.querySelectorAll('table.history tbody tr').length;
    if (S.P) { S.state.filters = {}; S.changed(); App.render(); }
    // The stored summary must grade exactly as the page does.
    const cur = S.meta.history?.runs.find(r => r.current)?.quality, page = { Good: 0, Fair: 0, Poor: 0 };
    if (S.Q) for (const q of S.Q.byKey.values()) page[q.grade]++;
    const same = !S.Q || (cur && ['Good', 'Fair', 'Poor'].every(g => cur[g] === page[g]));
    return { runs, quality: !!S.Q, track: flow.includes('Forecast track record'), rows, note: flow.includes('appears from the second run'), qtrend: quality.includes('Quality over time'), lost: flow.includes('Left the scope'), same };`);
  check('history cards render', hist.track && (hist.runs ? !hist.note && hist.rows > 0 : hist.note) && (!hist.quality || hist.qtrend), `${hist.runs} earlier run(s), ${hist.rows} track-record row(s)${hist.lost ? ', lost-scope card' : ''}${hist.quality ? '' : ', no Quality tab'}`);
  check('stored quality grades match the page', hist.same);

  // Portfolio: workstream table, one burn-down each, a click-through to one workstream's Flow, and a
  // notice wherever a view would add up workstreams whose "done" differs.
  const isPortfolio = await evaluate(`return !!S.P`);
  if (isPortfolio) {
    const pf = await evaluate(`S.state.filters = {}; S.state.tab = S.DEFAULT_TAB; S.changed(); App.render(); await new Promise(r => setTimeout(r, 150));
      const v = document.getElementById('view'), first = document.querySelector('[data-tab]')?.dataset.tab;
      const rows = v.querySelectorAll('table.portfolio tbody tr').length, multiples = v.querySelectorAll('.grid2 svg.chart').length;
      const titles = [...v.querySelectorAll('.card h3')].map(h => h.textContent);
      const streams = S.P.streams.length;
      document.querySelector('[data-tab="flow"]').click(); await new Promise(r => setTimeout(r, 150));
      const mixed = !!document.querySelector('#view .card.notice');
      document.querySelector('[data-tab="portfolio"]').click(); await new Promise(r => setTimeout(r, 150));
      document.querySelector('table.portfolio tbody tr a[data-drill]').click(); await new Promise(r => setTimeout(r, 150));
      const v1 = document.getElementById('view'), cfdTitle = [...v1.querySelectorAll('.card')].find(c => c.querySelector('h3')?.textContent === 'Cumulative flow');
      const one = { tab: S.state.tab, stream: [...(S.state.filters.stream ?? [])], notice: !!v1.querySelector('.card.notice'), forecast: [...v1.querySelectorAll('.card h3')].some(h => h.textContent === 'Forecast'), columns: cfdTitle?.textContent.includes('Columns of board') };
      document.querySelector('[data-tab="overview"]').click(); await new Promise(r => setTimeout(r, 50));
      S.state.filters = {}; S.changed(); App.render(); await new Promise(r => setTimeout(r, 100));
      const mixedForecast = [...document.querySelectorAll('#view .card h3')].some(h => h.textContent === 'Forecast');
      S.state.filters = {}; S.changed(); App.render();
      return { first, rows, multiples, streams, titles, mixed, one, mixedForecast };`);
    check('portfolio tab is first and lists every workstream', pf.first === 'portfolio' && pf.rows === pf.streams && pf.multiples === pf.streams, `${pf.rows} rows, ${pf.multiples} burn-downs, ${pf.streams} workstreams`);
    check('portfolio shows dependencies and shared people', ['Dependencies between workstreams', 'People in several workstreams'].every(t => pf.titles.includes(t)));
    check('flow warns when it mixes workstreams', pf.mixed);
    check('a workstream click-through opens its Flow without the warning', pf.one.tab === 'flow' && pf.one.stream.length === 1 && !pf.one.notice, `${pf.one.tab}: ${pf.one.stream.join(', ')}`);
    check("one workstream's Flow has its forecast and its board's columns", pf.one.forecast && pf.one.columns);
    check('no forecast over several workstreams', !pf.mixedForecast);
  }

  const total = await evaluate(`return S.model.issues.length`);
  const f = await evaluate(`
    document.querySelector('.chip[data-dim="type"]').click(); await new Promise(r => setTimeout(r, 50));
    const box = document.querySelector('.menu input[type=checkbox]'); const v = box.value; box.click(); await new Promise(r => setTimeout(r, 80));
    return { v, n: S.filtered().length, hash: location.hash };`);
  check('filter menu narrows the set and lands in the URL', f.n > 0 && f.n < total && f.hash.includes('f.type'), `${f.v}: ${f.n}/${total}`);
  await evaluate(`document.querySelector('[data-act="close"]').click(); document.getElementById('clear')?.click()`);

  const q = await evaluate(`const i = document.getElementById('q'); i.value = S.model.issues[5].k; i.dispatchEvent(new Event('input')); await new Promise(r => setTimeout(r, 300)); return S.filtered().length;`);
  check('search by key finds the issue', q >= 1);
  await evaluate(`document.getElementById('clear').click()`);

  const drill = await evaluate(`document.querySelector('[data-tab="explore"]').click(); await new Promise(r => setTimeout(r, 50));
    document.querySelector('td[data-drill]').click(); await new Promise(r => setTimeout(r, 80)); return { tab: S.state.tab, n: S.filtered().length };`);
  check('pivot cell drills into Issues', drill.tab === 'issues' && drill.n > 0 && drill.n < total, `${drill.n} issues`);

  const drawer = await evaluate(`document.querySelector('table.issues tbody tr').click(); await new Promise(r => setTimeout(r, 50));
    const d = document.getElementById('drawer'); return { open: d.classList.contains('open'), h: d.querySelector('h2')?.textContent, hist: d.querySelectorAll('table.hist tr').length };`);
  check('issue drawer opens with history', drawer.open && drawer.h && drawer.hist >= 1, drawer.h);
  await evaluate(`document.getElementById('drawer-close').click(); document.getElementById('clear')?.click()`);

  // The target editor sits with the forecast: on Flow, or on Portfolio in a portfolio report.
  const tgt = await evaluate(`document.querySelector('[data-tab="' + (S.P ? 'portfolio' : 'flow') + '"]').click(); await new Promise(r => setTimeout(r, 100));
    document.querySelector('[data-target-edit]').click(); const form = document.querySelector('.target-form');
    form.querySelector('[name=date]').value = '2027-03-01'; form.querySelector('[name=name]').value = 'Go-live';
    form.requestSubmit(); await new Promise(r => setTimeout(r, 150));
    return { t: S.target(), txt: document.querySelector('.target').textContent };`);
  check('target date can be changed in the report', tgt.t?.date === '2027-03-01' && tgt.t.custom && /Go-live/.test(tgt.txt));
  const reset = await evaluate(`document.querySelector('[data-target-reset]').click(); await new Promise(r => setTimeout(r, 100)); return S.target();`);
  check('target resets to the configured milestone', reset && !reset.custom, reset && `${reset.name} ${reset.date}`);

  const theme = await evaluate(`document.getElementById('theme').click(); await new Promise(r => setTimeout(r, 80)); return document.documentElement.getAttribute('data-theme');`);
  check('theme toggle', theme === 'dark' || theme === 'light', theme);

  // Teams / SharePoint preview: the file runs in a sandboxed about:srcdoc iframe with a null origin,
  // where history and localStorage throw. Filtering must still work there.
  const probe = `<script>addEventListener('load', () => setTimeout(() => { try {
      document.querySelector('.chip[data-dim="type"]').click();
      document.querySelector('.menu input[type=checkbox]').click();
      document.querySelector('[data-tab="flow"]').click();
      let blocked = 'no'; try { history.replaceState(null, '', '#probe'); } catch (e) { blocked = e.name; }
      const shown = document.querySelector('[data-tab="flow"]').getAttribute('aria-selected') === 'true' && document.getElementById('view').textContent.includes('Burn-up');
      parent.postMessage({ ok: shown, n: S.filtered().length, total: S.model.issues.length, tab: S.state.tab, blocked }, '*');
    } catch (e) { parent.postMessage({ ok: false, err: String(e) }, '*'); } }, 300));<\/script>`;
  const html = readFileSync(file, 'utf8').replace('</body>', probe + '</body>');
  // The parent must be an http(s) page: a srcdoc frame inherits the parent's base URL, and it is
  // that https URL the null-origin frame may not write to history (Teams uses a blob:https URL).
  const host = createServer((_, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>host</title>'));
  await new Promise(r => host.listen(0, '127.0.0.1', r));
  await send('Page.navigate', { url: `http://127.0.0.1:${host.address().port}/` });
  await sleep(400);
  const sandboxed = await evaluate(`const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts');
    const got = new Promise(r => addEventListener('message', e => r(e.data), { once: true }));
    f.srcdoc = ${JSON.stringify(html)}; document.body.appendChild(f);
    return await Promise.race([got, new Promise(r => setTimeout(() => r({ ok: false, err: 'timeout' }), 5000))]);`);
  host.close();
  check('works inside a sandboxed srcdoc iframe (Teams / SharePoint preview)', sandboxed.ok && sandboxed.n < sandboxed.total && sandboxed.tab === 'flow', sandboxed.err ?? `${sandboxed.n}/${sandboxed.total}, history writes blocked: ${sandboxed.blocked}`);

  check('no page errors', !errors.length, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('smoke run', false, e.stack?.split('\n').slice(0, 4).join(' ⏎ '));
} finally {
  ws?.close(); chrome.kill(); await sleep(200);
  rmSync(profile, { recursive: true, force: true });
}
const failed = checks.filter(c => !c[1]).length;
console.log(failed ? `\n${failed} check(s) failed` : `\nall ${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
