// Collects everything the report needs, incrementally.
//
// Scope = the project + every issue any of the project's boards shows (board filters can reach
// into other projects). Each run lists the scope's keys and `updated` stamps (cheap), then fetches
// full issues + changelogs only for keys that are new or changed since the cached copy.
// Cache: ~/.cache/jira-report/<host>/<project>.json — outside the repo, it holds full issue data.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { HttpError, pool } from './http.mjs';

const CACHE_VERSION = 1;
export const cachePath = (host, project) => join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'jira-report', host, `${project}.json`);

const stripOrder = jql => jql.replace(/\bORDER\s+BY\b[\s\S]*$/i, '').trim();
const quote = s => `"${String(s).replace(/"/g, '\\"')}"`;

function loadCache(file) {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    return c.version === CACHE_VERSION ? c : null;
  } catch { return null; }
}
function saveCache(file, c) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file + '.tmp', JSON.stringify(c), { mode: 0o600 });
  renameSync(file + '.tmp', file);
}

export async function collect({ jira, host, project, board, config, refresh = false, log = () => {} }) {
  if (!project && board) project = (await jira.board(board)).location?.projectKey;
  if (!project) throw new Error(`board ${board} is not located in a project; pass a project URL instead`);
  const proj = await jira.project(project);

  // Boards: all of the project's, plus the one named in the URL.
  let boards = [];
  try {
    boards = await jira.boardsForProject(project);
    if (board && !boards.some(b => b.id === board)) boards.push(await jira.board(board));
  } catch (e) {
    if (!(e instanceof HttpError) || ![401, 403, 404].includes(e.status)) throw e;
    log(`  ! cannot read boards (${e.status}); continuing with the project only — board filters and columns will be missing`);
  }
  boards = (await pool(boards, 4, async b => {
    try {
      const cfg = await jira.boardConfig(b.id);
      const jql = cfg.filter?.id ? stripOrder((await jira.filter(cfg.filter.id)).jql ?? '') : '';
      const columns = (cfg.columnConfig?.columns ?? []).map(c => ({ name: c.name, statuses: (c.statuses ?? []).map(s => String(s.id)) }));
      return { id: b.id, name: b.name, type: b.type, jql, columns };
    } catch (e) {
      log(`  ! board ${b.id} "${b.name}": cannot read its configuration (${e.status ?? e.message}); skipped`);
      return null;
    }
  })).filter(Boolean);
  log(`  project ${project} "${proj.name}", ${boards.length} board(s): ${boards.map(b => `${b.id} ${b.name}`).join('; ') || '—'}`);

  // Scope index.
  const scope = [`project = ${quote(project)}`, ...boards.filter(b => b.jql).map(b => b.jql)].map(q => `(${q})`).join(' OR ');
  const index = await jira.search(scope, ['updated']);
  for (const b of boards) b.keys = b.jql ? (await jira.search(b.jql, ['updated'])).map(i => i.key) : [];
  log(`  ${index.length} issues in scope`);

  // Incremental fetch.
  const file = cachePath(host, project);
  const cache = (!refresh && loadCache(file)) || { version: CACHE_VERSION, issues: {}, changelogs: {} };
  const stale = index.filter(i => cache.issues[i.key]?.fields?.updated !== i.fields.updated);
  log(`  ${stale.length} new or changed since the last run${refresh ? ' (--refresh)' : ''}`);

  const full = [];
  for (let i = 0; i < stale.length; i += 100) {
    const keys = stale.slice(i, i + 100).map(x => x.key);
    full.push(...await jira.search(`key in (${keys.join(',')})`, ['*all']));
    log(`  fetched ${full.length}/${stale.length}`, true);
  }
  await pool(full.filter(i => (i.fields.comment?.total ?? 0) > (i.fields.comment?.comments?.length ?? 0)), config.concurrency ?? 6,
    async i => { i.fields.comment.comments = await jira.comments(i.key); });
  const logs = await jira.changelogs(full);
  for (const i of full) { cache.issues[i.key] = i; cache.changelogs[i.id] = logs[i.id] ?? []; }

  // Drop what left the scope.
  const live = new Set(index.map(i => i.key));
  for (const k of Object.keys(cache.issues)) if (!live.has(k)) { delete cache.changelogs[cache.issues[k].id]; delete cache.issues[k]; }
  cache.fetchedAt = Date.now();
  saveCache(file, cache);

  const [fields, statuses, priorities] = await Promise.all([jira.fields(), jira.statuses(), jira.priorities()]);
  return {
    host, project, projectName: proj.name, boards, fields, statuses, priorities,
    issues: index.map(i => cache.issues[i.key]).filter(Boolean), changelogs: cache.changelogs, config,
  };
}
