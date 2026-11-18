// Portfolio: several workstreams, possibly across spaces, in one report.
//
// A workstream is one board (its issues), or a whole space when the URL names no board. Issues of
// a member space that are on none of the listed boards form one extra workstream per space, so
// nothing in scope goes uncounted. "Done" can mean different things per workstream (a requirement
// approved, a feature delivered), so the report forecasts per workstream and never adds them up.
//
// Stream ids are stable across runs (history keys on them): b<boardId>, s:<SPACE>, n:<SPACE>.
//
// Config (only in a local, gitignored config: names and URLs identify the organisation):
//   "portfolios": { "<name>": { "title": "…", "streams": [ "<board or space URL>" | { "url", "name" } ] } }

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTarget, REPO } from './config.mjs';

export const RESERVED = new Set(['login', 'logout', 'oauth-setup', 'example']);
const NAME = /^[a-z0-9][a-z0-9._-]*$/i;

/** CLI positionals + options → { name, title, streams: [{url, name?}] } or null for a plain single-URL run. */
export function portfolioSpec(positionals, { name } = {}, config = {}) {
  const urls = positionals.filter(p => p.includes('://'));
  const names = positionals.filter(p => !p.includes('://'));
  if (names.length && urls.length) throw new Error('give either board/space URLs or a saved portfolio name, not both');
  if (names.length) {
    if (names.length > 1) throw new Error(`one portfolio at a time (got ${names.join(', ')})`);
    const saved = config.portfolios?.[names[0]];
    if (!saved) {
      const known = Object.keys(config.portfolios ?? {});
      throw new Error(`no portfolio "${names[0]}" in ${config._file ?? 'the config'}${known.length ? `; known: ${known.join(', ')}` : '; create one with: jira-report <url> <url>… --name <name> --save'}`);
    }
    return { name: names[0], title: saved.title ?? names[0], streams: (saved.streams ?? []).map(s => (typeof s === 'string' ? { url: s } : s)) };
  }
  if (urls.length === 1 && !name) return null;
  if (!name) throw new Error('several URLs make a portfolio: name it with --name <name> (add --save to keep it in your local config)');
  checkName(name);
  return { name, title: config.portfolios?.[name]?.title ?? name, streams: urls.map(url => ({ url })) };
}

export function checkName(name) {
  if (!NAME.test(name)) throw new Error(`portfolio name "${name}": use letters, digits, dot, dash or underscore`);
  if (RESERVED.has(name)) throw new Error(`"${name}" is a command; pick another portfolio name`);
}

/**
 * Resolve each stream URL to { host, project, board } (a board's project comes from Jira).
 * Returns the streams plus the distinct spaces to collect, each with one of its listed boards.
 */
export async function resolveStreams(spec, jira) {
  const streams = [];
  for (const s of spec.streams) {
    const t = parseTarget(s.url);
    let project = t.project;
    if (t.board) project = (await jira.board(t.board)).location?.projectKey ?? project;
    if (!project) throw new Error(`cannot tell which space ${s.url} belongs to`);
    streams.push({ ...t, project, name: s.name ?? null, url: s.url });
  }
  const hosts = new Set(streams.map(s => s.host));
  if (hosts.size > 1) throw new Error(`a portfolio covers one Jira site; got ${[...hosts].join(', ')}`);
  const ids = streams.map(s => (s.board ? `b${s.board}` : `s:${s.project}`));
  const dup = ids.find((id, k) => ids.indexOf(id) !== k);
  if (dup) throw new Error(`workstream listed twice: ${streams[ids.indexOf(dup)].url}`);
  const spaces = [...new Set(streams.map(s => s.project))].map(project => ({ project, board: streams.find(s => s.project === project && s.board)?.board ?? null }));
  return { host: streams[0].host, streams, spaces };
}

/**
 * Per-space collect() results → one raw dataset for buildModel, with the portfolio described in
 * raw.portfolio and each issue's workstreams in raw.streamOf. Pure.
 */
export function mergeSpaces(raws, resolved, spec) {
  const members = new Set(raws.map(r => r.project));
  const boards = new Map();
  for (const r of raws) for (const b of r.boards) if (!boards.has(b.id)) boards.set(b.id, b);
  const spaceOf = k => k.split('-')[0];

  const streams = resolved.streams.map(s => {
    if (!s.board) {
      const r = raws.find(x => x.project === s.project);
      return { id: `s:${s.project}`, name: s.name ?? r?.projectName ?? s.project, space: s.project, board: null, keys: null };
    }
    const b = boards.get(s.board);
    if (!b) throw new Error(`board ${s.board} could not be read; check your access to it`);
    return { id: `b${s.board}`, name: s.name ?? b.name, space: s.project, board: s.board, keys: new Set(b.keys ?? []) };
  });
  const listed = new Set(streams.flatMap(s => (s.keys ? [...s.keys] : [])));

  // Scope: the member spaces, plus anything a listed board shows from elsewhere.
  const issues = new Map();
  for (const r of raws) for (const i of r.issues) if (!issues.has(i.key) && (members.has(spaceOf(i.key)) || listed.has(i.key))) issues.set(i.key, i);

  const streamOf = {};
  for (const k of issues.keys()) {
    const ids = streams.filter(s => (s.keys ? s.keys.has(k) : s.space === spaceOf(k))).map(s => s.id);
    if (ids.length) streamOf[k] = ids;
  }
  // A member space with board workstreams only: the rest of its issues become one more workstream.
  for (const space of members) {
    if (streams.some(s => s.space === space && !s.keys)) continue;
    const rest = [...issues.keys()].filter(k => spaceOf(k) === space && !streamOf[k]);
    if (!rest.length) continue;
    const id = `n:${space}`;
    streams.push({ id, name: `${space} · not on a listed board`, space, board: null, keys: null, unlisted: true });
    for (const k of rest) streamOf[k] = [id];
  }

  // Names key the Workstream filter: boards with the same name in different spaces get the space added.
  const clash = new Set(streams.filter(st => streams.some(o => o !== st && o.name === st.name)));
  for (const st of clash) st.name = `${st.name} (${st.space})`;

  const changelogs = Object.assign({}, ...raws.map(r => r.changelogs));
  const first = raws[0];
  return {
    host: resolved.host, project: spec.name, projectName: spec.title,
    boards: [...boards.values()], fields: first.fields, statuses: first.statuses, priorities: first.priorities,
    issues: [...issues.values()], changelogs, config: first.config,
    streamOf,
    portfolio: {
      name: spec.name, title: spec.title,
      spaces: raws.map(r => ({ key: r.project, name: r.projectName })),
      streams: streams.map(({ id, name, space, board, unlisted }) => ({ id, name, space, board, ...(unlisted ? { unlisted: true } : {}) })),
    },
  };
}

/**
 * Save a portfolio in the local config: the discovered config file, or <repo>/jira-report.local.json
 * when only the shipped defaults are in use. Edits the file's own JSON, so its other keys and relative
 * paths stay as written. Never writes the shipped defaults.
 */
export function savePortfolio(config, { name, title, streams }) {
  const defaults = join(REPO, 'defaults', 'jira-report.config.json');
  const file = config._file && config._file !== defaults ? config._file : join(REPO, 'jira-report.local.json');
  const own = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  own.portfolios ??= {};
  own.portfolios[name] = { title, streams: streams.map(s => ({ name: s.name, url: s.url })) };
  writeFileSync(file, JSON.stringify(own, null, 2) + '\n', { mode: 0o600 });
  return file;
}
