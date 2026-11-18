import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from '../lib/config.mjs';
import { markdown } from '../lib/markdown.mjs';

const JRQ = new Function(readFileSync(join(REPO, 'template/app/quality.js'), 'utf8') + '\nreturn JRQ;')();
const issue = (k, ty, t, d = '', extra = {}) => ({ k, ty, t, d, lvl: 0, ln: [], ...extra });
const assess = (issues, epicOf = () => 'EPIC-1') => JRQ.assess(issues, { epicOf }).byKey;

test('a verification-style bug report is Good, a screenshot-only bug is Poor', () => {
  const good = issue('X-1', 'Bug', 'Loan id is not unique: 37 duplicates',
    'Expected: every loan id is unique.\nImport: loans_week_12\nFile: loans_week_12.csv\nSeen instead: row 9 repeats "LN-00042" from row 8\nSteps to reproduce:\n1. Open the import checker.\n2. Pick the import.');
  const poor = issue('X-2', 'Bug', 'Member_Email is blank', '[attachment]');
  const q = assess([good, poor]);
  assert.equal(q.get('X-1').grade, 'Good');
  assert.equal(q.get('X-2').grade, 'Poor');
  assert.deepEqual(q.get('X-2').failed.map(r => r.id).sort(), ['described', 'evidence', 'expected', 'steps', 'where'].sort());
});

test('features: acceptance criteria, questions, disguised defects, bundles', () => {
  const ac = issue('F-1', 'Feature', 'Reading list sign-off', 'Summary: record the reading list with sign-offs from librarians and staff so the list is approved.\nAcceptance criteria\n• Reading list must be completed.\n• Sign-offs obtained.');
  const question = issue('F-2', 'Feature', 'Text of the overdue notice', 'What should the text be on the notice sent to members reminding them of overdue books');
  const defect = issue('F-3', 'Feature', 'Branch transfer form', 'The form will not take a date, and there is no way to pick a branch.');
  const bundle = issue('F-4', 'Feature', 'Loan screen: tidy up', '[attachment]\nHide the shelf field.\n[attachment]\nHide the IDs.\n[attachment]\nRemove the old barcode.\n[attachment]\nLock the member field once lent, it should only change via a transfer.');
  const q = assess([ac, question, defect, bundle]);
  assert.ok(q.get('F-1').results.find(r => r.id === 'criteria').ok);
  assert.ok(!q.get('F-2').results.find(r => r.id === 'notQuestion').ok, 'opens with an interrogative');
  assert.ok(!q.get('F-3').results.find(r => r.id === 'notDefect').ok);
  assert.ok(!q.get('F-4').results.find(r => r.id === 'single').ok, '4 screenshots → bundle');
});

test('text-dependent checks do not apply to an issue without text, and a bare user story is Poor', () => {
  const q = assess([issue('S-1', 'Story', 'As a member I need the catalogue to refresh daily')]).get('S-1');
  assert.ok(!q.results.some(r => ['single', 'textNotScreenshot', 'notDuplicate'].includes(r.id)));
  assert.equal(q.grade, 'Poor');
  const spec = assess([issue('S-2', 'Story', 'Loan sync 6', 'Trigger\n• Nightly run at 02:00\nLogic\n• Last_Loan_Date = latest loan date among open loans, refreshed by each run')]).get('S-2');
  assert.equal(spec.grade, 'Good');
});

test('duplicates: cross-type copies are found, linked or sibling specs are not', () => {
  const text = 'Suspending a membership must also suspend its loans and reservations; today only the membership itself moves';
  const a = issue('D-1', 'Feature', 'Membership Suspended', text), b = issue('D-2', 'Story', 'Membership Suspended', text);
  assert.deepEqual(JRQ.duplicates([a, b]).map(d => [d.a, d.b]), [['D-1', 'D-2']]);
  assert.equal(JRQ.duplicates([{ ...a, ln: [['duplicates', 'D-2']] }, b]).length, 0, 'linked pairs are fine');
  const s1 = issue('T-1', 'Story', '9. Fine review → Loan blocked at review', 'Pre-conditions: membership in Fine review, a note is entered. Post-conditions: membership moves on to Loan blocked at review.');
  const s2 = issue('T-2', 'Story', '10. Fine review → Checkout (Go back)', 'Pre-conditions: membership in Fine review, user is a librarian. Post-conditions: membership moves back to Checkout.');
  assert.equal(JRQ.duplicates([s1, s2]).length, 0, 'sibling workflow specs share words but are not copies');
  const dq = JRQ.assess([a, b], { epicOf: () => null }).byKey.get('D-1');
  assert.deepEqual(dq.dupOf, ['D-2']);
});

test('markdown notes: escaped, structured, issue keys linked only when known', () => {
  const h = markdown('### Bugs\n\n**Bold** and *it* with `code`, see XX-1 and YY-9.\n\n- one\n  - nested [l](https://a.test/b)\n- two\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))', { keys: new Set(['XX-1']) });
  assert.match(h, /<h4>Bugs<\/h4>/);
  assert.match(h, /<strong>Bold<\/strong> and <em>it<\/em> with <code>code<\/code>/);
  assert.match(h, /<a href="#" data-open="XX-1">XX-1<\/a> and YY-9/);
  assert.match(h, /<ul><li>one<ul><li>nested <a href="https:\/\/a.test\/b"/);
  assert.ok(!h.includes('<script>') && h.includes('&lt;script&gt;'));
  assert.ok(!h.includes('javascript:alert(1)"'), 'only http(s) links become anchors');
});
