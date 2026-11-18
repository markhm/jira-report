// Quality checks for issue content. Pure; no DOM. Loaded into the report when --quality is on and,
// in tests, evaluated on its own (the file evaluates to the JRQ namespace).
//
// Checks are deliberately simple, visible rules: they test whether the parts a reader needs are
// present, not whether the prose is good. Each check applies to one kind of issue (bug, feature,
// story, other) and every issue gets a score = passed / applicable, graded Good / Fair / Poor.

const JRQ = (() => {
  const words = s => (s || '').replace(/\[attachment\]/g, ' ').split(/\s+/).filter(w => /\w/.test(w)).length;
  const kindOf = i => (i.lvl === 1 ? 'epic' : i.lvl < 0 ? 'subtask' : /bug|defect/i.test(i.ty) ? 'bug' : /feature|improvement|enhancement/i.test(i.ty) ? 'feature' : /story/i.test(i.ty) ? 'story' : 'other');

  const RE = {
    expected: /\b(expected|should|must|shall|agreed|required|needs? to|correct (format|value|is)|instead of|supposed to|verif(y|ies)|allowed|unique|only hold)\b/i,
    observed: /\b(actual(ly)?|observed|shows?|is not|are not|isn'?t|aren'?t|not (generated|populated|working|visible|possible|created|updated)|included in both|listed as|in place of|contains?|appears?|missing|blank|null|empty|duplicate[sd]?|invalid|wrong|incorrect|error|fail(s|ed|ing)?|cannot|can'?t|does not|doesn'?t|locked|blocking|not)\b/i,
    where: /\b(prod|production|uat|test env|environment|delivery|\.csv|files?|stage|entity|screen|dashboard|workflow|view|field|page|report|rows?|logs?|export|import|integration)\b|\d{4}_\d{8}/i,
    steps: /steps to reproduce|^\s*(\d+\.|•)\s+\S/im,
    textEvidence: /\|.*\|.*\||\brow \d+|"[^"]{2,}"|“[^”]{2,}”|\b\d+[/.*:-]\d+[/.*:-]\d+\b|[A-Z]{2,}[-_]?\d{3,}|\b(shows?|observed|found)\s*:/i,
    criteria: /acceptance criteria|definition of done|\bgiven\b[\s\S]{0,200}\bwhen\b[\s\S]{0,200}\bthen\b|pre-?conditions?|post-?conditions?|\btrigger\b[\s\S]*\b(fields updated|logic)\b|\bthe system shall\b/i,
    testable: /\b(should|must|shall|needs? to|has to|will be|is to be)\b/i,
    interrogative: /^\s*(@[\w ]+?\s*:?\s*)?(what|how|why|who|which|where|is there|are there|can we|could we|do we|does)\b/i,
    defect: /\b(not working|doesn'?t work|does not work|cannot|can'?t|error|page not found|there is no|no notification|is broken|fails?)\b/i,
    userStory: /^\s*as an?\b/i,
  };
  // First sentence of the description (up to the first full stop, question mark or line break).
  const lead = d => (d.match(/^[^\n.?!]*[.?!]?/) || [''])[0].trim();
  // A question rather than a request: '?' in the summary, or a description that opens with one.
  const isQuestion = i => /\?/.test(i.t) || /\?$/.test(lead(i.d)) || RE.interrogative.test(lead(i.d));
  // A bundle: many screenshots or many separate change requests ("Hide…", "Remove…", …) in one issue.
  const DIRECTIVE = /^\s*(•|-|o\s)?\s*(hide|remove|add|rename|change|lock|make|move|replace|set|show|delete)\b/gim;
  const bundled = d => (d.match(/\[attachment\]/g) || []).length >= 4 || (d.match(DIRECTIVE) || []).length >= 5;

  // id → { kind(s), label, test(i, ctx) → true/false }. Labels read as the thing that is wanted.
  const CHECKS = [
    { id: 'described', kinds: ['bug', 'feature', 'story', 'other', 'epic'], label: 'Has a description (15+ words of text)', test: i => words(i.d) >= 15, weight: 2 },
    { id: 'expected', kinds: ['bug'], label: 'States the expected behaviour', test: i => RE.expected.test(i.t + '\n' + i.d) },
    { id: 'observed', kinds: ['bug'], label: 'States what actually happens', test: i => RE.observed.test(i.t + '\n' + i.d) },
    { id: 'where', kinds: ['bug'], label: 'Says where it was seen (file, delivery, stage, screen…)', test: i => RE.where.test(i.t + '\n' + i.d) },
    { id: 'evidence', kinds: ['bug'], label: 'Evidence in text, not only a screenshot', test: i => RE.textEvidence.test(i.d) || RE.steps.test(i.d) || (words(i.d) >= 25 && !/\[attachment\]/.test(i.d)) },
    { id: 'steps', kinds: ['bug'], label: 'Has steps to reproduce', test: i => RE.steps.test(i.d), weight: 0.5 },
    { id: 'criteria', kinds: ['feature', 'story'], label: 'Has acceptance criteria or pre-/post-conditions', test: i => RE.criteria.test(i.d) },
    { id: 'testable', kinds: ['feature', 'story'], label: 'States testable outcomes (should / must / shall…)', test: i => RE.testable.test(i.t + '\n' + i.d) || RE.criteria.test(i.d) },
    { id: 'single', kinds: ['feature', 'story'], label: 'One change per issue (not a bundle of many requests or screenshots)', test: i => !bundled(i.d), needsText: true },
    { id: 'notQuestion', kinds: ['feature', 'story', 'other'], label: 'A request, not an open question', test: i => !isQuestion(i) },
    { id: 'notDefect', kinds: ['feature', 'story'], label: 'Not a defect filed as a request', test: i => !RE.defect.test(i.t + '\n' + lead(i.d)) },
    { id: 'textNotScreenshot', kinds: ['feature', 'story'], label: 'Readable without the screenshots', test: i => !/\[attachment\]/.test(i.d) || words(i.d) >= 25, needsText: true },
    { id: 'userStoryBody', kinds: ['story'], label: 'A user-story title has a body', test: i => !RE.userStory.test(i.t) || words(i.d) >= 15 },
    { id: 'underEpic', kinds: ['feature', 'story', 'bug'], label: 'Placed under an epic', test: (i, ctx) => !!ctx.epicOf(i), weight: 0.5 },
    { id: 'notDuplicate', kinds: ['bug', 'feature', 'story', 'other'], label: 'No unlinked copy of another issue', test: (i, ctx) => !ctx.dupOf.has(i.k), needsText: true },
  ];

  const tokens = s => new Set(s.toLowerCase().replace(/[^a-z0-9æøåäö ]/g, ' ').split(/\s+/).filter(w => w.length > 2));
  function jaccard(a, b) { let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n || 1); }

  /**
   * Unlinked near-copies. Across issue types (a Feature copied from a Story) a high overlap is
   * enough; within one type the bar is near-identity, because sibling specs (workflow transitions)
   * legitimately share most of their words.
   */
  function duplicates(issues, { crossType = 0.8, sameType = 0.97 } = {}) {
    const docs = issues.filter(i => i.lvl === 0).map(i => ({ i, t: tokens(i.t + ' ' + i.d.slice(0, 600)) })).filter(d => d.t.size >= 5);
    const linked = (a, b) => a.ln.some(l => l[1] === b.k) || b.ln.some(l => l[1] === a.k);
    const out = [];
    for (let x = 0; x < docs.length; x++) for (let y = x + 1; y < docs.length; y++) {
      const a = docs[x], b = docs[y];
      const j = jaccard(a.t, b.t);
      if (j >= (a.i.ty === b.i.ty ? sameType : crossType) && !linked(a.i, b.i)) out.push({ a: a.i.k, b: b.i.k, similarity: j });
    }
    return out.sort((p, q) => q.similarity - p.similarity);
  }

  function assess(issues, { epicOf = () => null } = {}) {
    const dups = duplicates(issues);
    const dupOf = new Map();
    for (const d of dups) { (dupOf.get(d.a) ?? dupOf.set(d.a, []).get(d.a)).push(d.b); (dupOf.get(d.b) ?? dupOf.set(d.b, []).get(d.b)).push(d.a); }
    const ctx = { epicOf, dupOf };
    const byKey = new Map();
    for (const i of issues) {
      const kind = kindOf(i);
      // Checks that look for a problem *in* the text (bundling, screenshots, copies) say nothing
      // about an issue that has no text, so they do not count for it.
      const hasText = words(i.d) > 0;
      const applicable = CHECKS.filter(c => c.kinds.includes(kind) && (hasText || !c.needsText));
      if (!applicable.length) continue;
      const results = applicable.map(c => ({ id: c.id, label: c.label, ok: !!c.test(i, ctx), w: c.weight ?? 1 }));
      const total = results.reduce((s, r) => s + r.w, 0), got = results.reduce((s, r) => s + (r.ok ? r.w : 0), 0);
      const score = got / total;
      byKey.set(i.k, { kind, score, grade: score >= 0.8 ? 'Good' : score >= 0.5 ? 'Fair' : 'Poor', results, failed: results.filter(r => !r.ok), dupOf: dupOf.get(i.k) ?? [] });
    }
    return { byKey, dups, checks: CHECKS };
  }

  return { assess, duplicates, kindOf, words, CHECKS };
})();
