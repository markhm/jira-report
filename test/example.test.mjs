import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO } from '../lib/config.mjs';

const run = (...args) => execFileSync(process.execPath, [join(REPO, 'bin', 'jira-report.mjs'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const data = file => JSON.parse(readFileSync(file, 'utf8').match(/<script type="application\/json" id="jr-data">([\s\S]*?)<\/script>/)[1]);

test('`jira-report example` writes a report from made-up data, without Jira', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jr-example-'));
  run('example', '--no-open', '-o', join(dir, 'a.html'));
  const m = data(join(dir, 'a.html'));
  assert.equal(m.meta.host, 'example.atlassian.net');
  assert.ok(m.issues.length > 100 && m.meta.quality && m.meta.history.runs.length > 1, 'issues, Quality tab and a history');
  assert.ok(m.meta.milestones[0].date > new Date().toISOString().slice(0, 10), 'the target lies ahead');
  assert.equal(statSync(join(dir, 'a.html')).mode & 0o777, 0o600);
  assert.ok(!readFileSync(join(dir, 'a.html'), 'utf8').includes('<img src="data:'), 'neutral brand: no logo');
  assert.throws(() => run('example', '--no-open', '--brand', 'default', '-o', join(dir, 'b.html')), /neutral brand/);
  run('example', '--portfolio', '--no-open', '-o', join(dir, 'p.html'), '--target', 'Launch=2030-01-01');
  const p = data(join(dir, 'p.html'));
  assert.equal(p.meta.portfolio.streams.length, 4);
  assert.deepEqual(p.meta.milestones[0], { name: 'Launch', date: '2030-01-01' });
});
