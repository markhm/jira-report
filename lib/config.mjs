// Config discovery and board-URL parsing.
//
// Discovery order: --config → $JIRA_REPORT_CONFIG → ./jira-report.config.json walking up from
// $PWD → <repo>/jira-report.local.json → <repo>/defaults/jira-report.config.json. Every file is
// merged over the reference defaults, so a local config only needs the keys it changes.
// Relative paths inside a config resolve against that config's own folder.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULTS = join(REPO, 'defaults', 'jira-report.config.json');

const readJson = f => JSON.parse(readFileSync(f, 'utf8'));
const PATH_KEYS = ['brand', 'outputDir', 'qualityNotes'];

function findUp(name, from) {
  for (let d = resolve(from); ; d = dirname(d)) {
    if (existsSync(join(d, name))) return join(d, name);
    if (dirname(d) === d) return null;
  }
}

/** Resolve a config's path-valued keys against its own folder. */
function anchor(cfg, file) {
  const out = { ...cfg };
  for (const k of PATH_KEYS) if (typeof out[k] === 'string' && !isAbsolute(out[k])) out[k] = resolve(dirname(file), out[k]);
  return out;
}

export function loadConfig(explicit) {
  const base = anchor(readJson(DEFAULTS), DEFAULTS);
  const file = explicit ? resolve(explicit)
    : process.env.JIRA_REPORT_CONFIG ? resolve(process.env.JIRA_REPORT_CONFIG)
    : findUp('jira-report.config.json', process.cwd())
      ?? (existsSync(join(REPO, 'jira-report.local.json')) ? join(REPO, 'jira-report.local.json') : null);
  if (file && !existsSync(file)) throw new Error(`config not found: ${file}`);
  const own = file ? anchor(readJson(file), file) : {};
  return { ...base, ...own, oauth: { ...base.oauth, ...own.oauth }, forecast: { ...base.forecast, ...own.forecast }, _file: file ?? DEFAULTS };
}

/**
 * Accepts a board URL (…/jira/software/c/projects/DEMO/boards/202), a project URL, a browse URL,
 * or a bare "host PROJECT" pair. Returns { host, project, board }.
 */
export function parseTarget(input) {
  let u;
  try { u = new URL(input); } catch { throw new Error(`not a Jira URL: ${input}`); }
  if (u.protocol !== 'https:') throw new Error('expected an https:// Jira Cloud URL');
  const p = u.pathname;
  const project = p.match(/\/projects\/([A-Z][A-Z0-9_]+)/i)?.[1] ?? p.match(/\/browse\/([A-Z][A-Z0-9_]+)-\d+/i)?.[1] ?? null;
  const board = p.match(/\/boards\/(\d+)/)?.[1] ?? u.searchParams.get('rapidView');
  if (!project && !board) throw new Error(`cannot find a project or board in ${input}`);
  return { host: u.host, project: project?.toUpperCase() ?? null, board: board ? Number(board) : null };
}
