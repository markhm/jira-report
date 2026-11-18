#!/usr/bin/env node
// jira-report — self-contained, branded HTML report over a Jira Cloud project.

import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { loadConfig, parseTarget, REPO } from '../lib/config.mjs';
import { resolveSession, login, logout, oauthSetup, openBrowser } from '../lib/auth.mjs';
import { Jira } from '../lib/jira.mjs';
import { collect } from '../lib/collect.mjs';
import { buildModel } from '../lib/model.mjs';
import { render, loadBrand, attachQuality } from '../lib/render.mjs';
import { summarize, writeSummary, loadHistory, historyDir, trends } from '../lib/history.mjs';
import { portfolioSpec, resolveStreams, mergeSpaces, savePortfolio } from '../lib/portfolio.mjs';
import { exampleModel } from '../lib/example.mjs';

const HELP = `jira-report — branded, self-contained HTML report over a Jira Cloud project

Usage
  jira-report <board-or-project-url> [options]
  jira-report <url> <url>… --name <name> [--save]      portfolio: several boards/spaces in one report
  jira-report <name> [options]                         a portfolio saved with --save
  jira-report example [--portfolio]                    an example report from made-up data (no Jira needed)
  jira-report login  <url|host> [--oauth | --token]    sign in (browser OAuth, or guided API token)
  jira-report logout <url|host>                        forget stored credentials for a site
  jira-report oauth-setup                              store the OAuth app's client ID + secret

Options
  -c, --config <file>     config file (default: discovered; see README)
  -b, --brand <dir|name>  brand folder, or a name under brands/ (default from config: default)
  -o, --output <file>     output HTML (default: <outputDir>/<site>-<PROJECT>/<site>-<PROJECT>.html)
  -t, --title <text>      report heading
      --name <name>       portfolio name (required with several URLs; names the output folder)
      --save              keep the portfolio in your local config (jira-report.local.json)
      --portfolio         with example: the portfolio example (two spaces, four workstreams)
      --target <NAME=YYYY-MM-DD>   default target date (overrides the config's first milestone)
      --quality           add the Quality tab (content checks on bugs, features, stories)
      --quality-notes <file.md>   reviewer notes shown on the Quality tab (implies --quality;
                          default: <output>.quality-notes.md next to the report, if present)
      --no-history        do not save this run's summary (history/ next to the report)
      --refresh           ignore the local cache and fetch everything again
      --no-open           do not open the report in the browser
  -h, --help

Examples
  jira-report https://example.atlassian.net/jira/software/c/projects/DEMO/boards/202
  jira-report https://example.atlassian.net/jira/software/c/projects/DEMO/boards/202 \
              https://example.atlassian.net/jira/software/c/projects/OPS/boards/900 --name demo-ops --save
  jira-report demo-ops

A portfolio report has one workstream per board (or per space, for a space URL). Issues of those
spaces on none of the listed boards form one more workstream per space. A Portfolio tab compares
the workstreams; every other tab gives the detail, sliced by the Workstream and Space filters.

Credentials: $JIRA_EMAIL + $JIRA_API_TOKEN, else a stored OAuth session or API token
(macOS Keychain), else an interactive sign-in. The report contains full issue data
(names, e-mails, descriptions, comments): treat it as confidential.`;

const log = (msg, transient = false) => {
  if (transient && process.stderr.isTTY) process.stderr.write(`\r\x1b[2K${msg}`);
  else process.stderr.write((process.stderr.isTTY ? '\r\x1b[2K' : '') + msg + '\n');
};
const hostOf = s => (s.includes('://') ? new URL(s).host : s.replace(/\/.*$/, ''));

async function main() {
  const { values: o, positionals: pos } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' }, brand: { type: 'string', short: 'b' }, output: { type: 'string', short: 'o' },
      title: { type: 'string', short: 't' }, target: { type: 'string' }, quality: { type: 'boolean' }, 'quality-notes': { type: 'string' }, refresh: { type: 'boolean' }, 'no-open': { type: 'boolean' }, 'no-history': { type: 'boolean' },
      name: { type: 'string' }, save: { type: 'boolean' }, portfolio: { type: 'boolean' },
      oauth: { type: 'boolean' }, token: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (o.help || !pos.length) { console.log(HELP); return; }
  const config = loadConfig(o.config);

  if (pos[0] === 'login') { if (!pos[1]) throw new Error('usage: jira-report login <url|host>'); await login(hostOf(pos[1]), config, { method: o.oauth ? 'oauth' : o.token ? 'token' : undefined }); return; }
  if (pos[0] === 'logout') { if (!pos[1]) throw new Error('usage: jira-report logout <url|host>'); logout(hostOf(pos[1])); return; }
  if (pos[0] === 'oauth-setup') { await oauthSetup(); return; }
  if (pos[0] === 'example') { example(o, config); return; }

  const spec = portfolioSpec(pos, { name: o.name }, config);
  if (spec && !spec.streams.length) throw new Error(`portfolio "${spec.name}" lists no workstreams`);
  if (o.save && !spec) throw new Error('--save keeps a portfolio: give several URLs and --name');
  const target = spec ? { ...parseTarget(spec.streams[0].url), project: null, board: null } : parseTarget(pos[0]);
  if (o.title) config.title = o.title;
  if (o.target) {
    const m = o.target.match(/^(.+)=(\d{4}-\d{2}-\d{2})$/);
    if (!m) throw new Error('--target expects NAME=YYYY-MM-DD, e.g. UAT=2027-01-15');
    config.milestones = [{ name: m[1], date: m[2] }, ...(config.milestones ?? []).filter(x => x.name !== m[1])];
  }
  const brandDir = o.brand ? (existsSync(join(REPO, 'brands', o.brand)) ? join(REPO, 'brands', o.brand) : resolve(o.brand)) : config.brand;
  const brand = loadBrand(brandDir);

  log(`jira-report · ${target.host}${spec ? ` · portfolio ${spec.name} (${spec.streams.length} workstream(s))` : ''}${target.project ? ' · ' + target.project : ''}${target.board ? ' · board ' + target.board : ''}`);
  const session = await resolveSession(target.host, config);
  log(`  signed in as ${session.who} (${session.kind}, ${session.source ?? 'login'})`);
  const jira = new Jira(session, { concurrency: config.concurrency });
  let raw;
  if (spec) {
    const resolved = await resolveStreams(spec, jira);
    const raws = [];
    for (const s of resolved.spaces) raws.push(await collect({ jira, host: resolved.host, project: s.project, board: s.board, config, refresh: o.refresh, log }));
    raw = mergeSpaces(raws, resolved, spec);
    for (const s of raw.portfolio.streams) log(`  workstream ${s.name}: ${Object.values(raw.streamOf).filter(ids => ids.includes(s.id)).length} issues`);
    if (o.save) log(`  portfolio "${spec.name}" saved in ${savePortfolio(config, { name: spec.name, title: spec.title, streams: resolved.streams.map((s, k) => ({ url: s.url, name: raw.portfolio.streams[k].name })) })}`);
  } else raw = await collect({ jira, ...target, config, refresh: o.refresh, log });
  const model = buildModel({ ...raw, generatedAt: Date.now() });
  const out = o.output ? resolve(o.output) : (n => join(config.outputDir, n, `${n}.html`))(`${target.host.split('.')[0]}-${model.meta.project}`);
  if (o.quality || o['quality-notes'] || config.quality) {
    const beside = out.replace(/\.html?$/i, '') + '.quality-notes.md';
    const notes = o['quality-notes'] ? resolve(o['quality-notes']) : config.qualityNotes ?? (existsSync(beside) ? beside : null);
    attachQuality(model, notes);
    log(`  quality tab on${notes ? `, reviewer notes from ${notes}` : ''}`);
  }

  // Per-run summary: the trends the changelog cannot give back (quality, lost scope, forecast track record).
  const hdir = historyDir(out);
  const current = summarize(model);
  const earlier = loadHistory(hdir, { host: model.meta.host, project: model.meta.project, log });
  model.meta.history = trends([...earlier, current], model);
  const html = render(model, brand);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, { mode: 0o600 });
  log(`  history: ${earlier.length} earlier run(s)${o['no-history'] ? '; this run not saved (--no-history)' : `; saved ${writeSummary(hdir, current)}`}`);
  log(`  ✓ ${model.issues.length} issues, ${model.meta.boards.length} board(s), ${model.meta.customFields.length} custom field(s) → ${out} (${(html.length / 1e6).toFixed(1)} MB)`);
  if (!o['no-open']) openBrowser('file://' + realpathSync(out));
}

/**
 * An example report from synthetic data: fictional people and issues, a made-up run history.
 * Always in the neutral brand: made-up data under a real organisation's brand would pass for
 * that organisation's report.
 */
function example(o, config) {
  if (o.brand) throw new Error('example reports always use the neutral brand; --brand applies to real reports only');
  const now = Date.now();
  const inWeeks = w => new Date(now + w * 7 * 86_400_000).toISOString().slice(0, 10);
  const m = o.target?.match(/^(.+)=(\d{4}-\d{2}-\d{2})$/);
  if (o.target && !m) throw new Error('--target expects NAME=YYYY-MM-DD, e.g. Go-live=2027-01-15');
  const model = exampleModel({ now, portfolio: !!o.portfolio, milestones: [m ? { name: m[1], date: m[2] } : { name: 'Go-live', date: inWeeks(10) }], title: o.title ?? null });
  const brand = loadBrand(join(REPO, 'brands', 'default'));
  const out = o.output ? resolve(o.output) : join(config.outputDir, 'example', o.portfolio ? 'example-portfolio.html' : 'example.html');
  const html = render(model, brand);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, { mode: 0o600 });
  log(`jira-report example${o.portfolio ? ' (portfolio)' : ''}: made-up data, ${model.issues.length} issues → ${out}`);
  if (!o['no-open']) openBrowser('file://' + realpathSync(out));
}

main().catch(e => { process.stderr.write(`\njira-report: ${e.message}\n`); process.exit(1); });
