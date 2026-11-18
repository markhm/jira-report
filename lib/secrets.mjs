// Credential storage. macOS: the login Keychain (service "jira-report", account "<host>:<kind>").
// Elsewhere: ~/.config/jira-report/credentials.json, mode 0600. Values are JSON strings.
// Nothing here ever prints a secret.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SERVICE = 'jira-report';
const useKeychain = process.platform === 'darwin' && !process.env.JIRA_REPORT_NO_KEYCHAIN;
const FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'jira-report', 'credentials.json');

function fileStore() { return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {}; }
function fileSave(all) {
  mkdirSync(join(FILE, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
  chmodSync(FILE, 0o600);
}

export function getSecret(account) {
  if (!useKeychain) return fileStore()[account] ?? null;
  try {
    const raw = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function setSecret(account, value) {
  if (!useKeychain) { const all = fileStore(); all[account] = value; return fileSave(all); }
  // -U updates in place. The value travels as an argv element to `security`, which is visible to
  // other processes of the same user for the lifetime of that call — the same exposure `security`
  // itself documents; acceptable for a single-user workstation tool.
  execFileSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', JSON.stringify(value)], { stdio: 'ignore' });
}

export function deleteSecret(account) {
  if (!useKeychain) { const all = fileStore(); delete all[account]; return fileSave(all); }
  try { execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', account], { stdio: 'ignore' }); } catch { /* absent */ }
}
