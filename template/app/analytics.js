// Pure analytics over the embedded model. No DOM. Loaded into the report and, in tests, into a vm
// context (the file evaluates to the JRA namespace).
//
// Time model: an issue's status timeline is rebuilt from its status history. The status before the
// first recorded transition is that transition's `from`; with no transitions the issue has sat in
// its current status since creation. "Done" means status category done at that moment, so an
// issue that was reopened stops counting as done while it is open again.

const JRA = (() => {
  const DAY = 86_400_000, WEEK = 7 * DAY;

  const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  // ISO week start (Monday 00:00 local).
  const startOfWeek = t => { const d = new Date(startOfDay(t)); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return d.getTime(); };
  const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };

  function quantile(values, q) {
    if (!values.length) return null;
    const a = [...values].sort((x, y) => x - y);
    const pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }
  const median = v => quantile(v, 0.5);

  /** Build a context bound to one model: status lookup + per-issue memoised timelines. */
  function context(model, now = model.meta.generatedAt) {
    const statuses = model.meta.statuses;
    const cat = id => statuses[id]?.c ?? 'indeterminate';
    const tl = new Map();

    function timeline(i) {
      if (tl.has(i.k)) return tl.get(i.k);
      const ev = i.h.filter(h => h[2] === 'status' && h[0] != null);
      const segs = [];
      let s = ev.length ? (ev[0][5] ?? i.st) : i.st, from = i.cr;
      for (const e of ev) {
        const at = Math.max(e[0], from);
        segs.push([s, from, at]);
        s = e[6] ?? s; from = at;
      }
      segs.push([s, from, Math.max(now, from)]);
      tl.set(i.k, segs);
      return segs;
    }

    const statusAt = (i, t) => {
      if (t < i.cr) return null;
      const segs = timeline(i);
      for (const [s, a, b] of segs) if (t >= a && t < b) return s;
      return segs[segs.length - 1][0];
    };
    const catAt = (i, t) => { const s = statusAt(i, t); return s == null ? null : cat(s); };
    const isDone = i => cat(i.st) === 'done';

    /** When the issue last entered a done status (null while open). */
    function completedAt(i) {
      if (!isDone(i)) return null;
      const segs = timeline(i);
      let t = null;
      for (let k = segs.length - 1; k >= 0 && cat(segs[k][0]) === 'done'; k--) t = segs[k][1];
      return t ?? i.rs ?? i.cr;
    }
    /** First move into work: first in-progress status, else the completion itself. */
    function startedAt(i) {
      for (const [s, a] of timeline(i)) if (cat(s) === 'indeterminate') return a;
      for (const [s, a] of timeline(i)) if (cat(s) === 'done') return a;
      return null;
    }
    const cycleDays = i => { const c = completedAt(i), s = startedAt(i); return c != null && s != null ? (c - s) / DAY : null; };
    const leadDays = i => { const c = completedAt(i); return c != null ? (c - i.cr) / DAY : null; };
    /** Done → not-done transitions. */
    const reopens = i => i.h.filter(h => h[2] === 'status' && cat(h[5]) === 'done' && cat(h[6]) !== 'done').length;

    // ---------- series ----------

    function days(from, to = now) { const out = []; for (let t = startOfDay(from); t <= to; t = addDays(t, 1)) out.push(t); return out; }

    /** Cumulative scope (created) and done (in a done status at end of day). */
    function burnup(issues, from, to = now) {
      const xs = days(from ?? Math.min(...issues.map(i => i.cr)), to);
      const eod = xs.map(d => Math.min(addDays(d, 1) - 1, now));
      return {
        x: xs,
        scope: eod.map(t => issues.filter(i => i.cr <= t).length),
        done: eod.map(t => issues.filter(i => catAt(i, t) === 'done').length),
      };
    }

    /** Cumulative flow: count per band per day. bands: [{name, statuses:[id]}]; unmapped statuses are skipped. */
    function cfd(issues, bands, from, to = now) {
      const xs = days(from ?? Math.min(...issues.map(i => i.cr)), to);
      const bandOf = {};
      bands.forEach((b, k) => b.statuses.forEach(s => { bandOf[s] = k; }));
      const counts = bands.map(() => new Array(xs.length).fill(0));
      xs.forEach((d, j) => {
        const t = Math.min(addDays(d, 1) - 1, now);
        for (const i of issues) { const s = statusAt(i, t); const k = s == null ? undefined : bandOf[s]; if (k !== undefined) counts[k][j]++; }
      });
      return { x: xs, bands: bands.map((b, k) => ({ name: b.name, values: counts[k] })) };
    }

    /** Completions per ISO week, oldest first, over the last `weeks` weeks (current partial week last). */
    function throughput(issues, weeks = 26) {
      const cur = startOfWeek(now);
      const xs = Array.from({ length: weeks }, (_, k) => addDays(cur, -7 * (weeks - 1 - k)));
      const n = new Array(weeks).fill(0);
      for (const i of issues) {
        const c = completedAt(i); if (c == null) continue;
        const k = xs.findIndex((w, j) => c >= w && (j === weeks - 1 || c < xs[j + 1]));
        if (k >= 0) n[k]++;
      }
      return { x: xs, values: n };
    }

    /** Arrivals (created) per ISO week, same axis as throughput. */
    function arrivals(issues, weeks = 26) {
      const cur = startOfWeek(now);
      const xs = Array.from({ length: weeks }, (_, k) => addDays(cur, -7 * (weeks - 1 - k)));
      const n = new Array(weeks).fill(0);
      for (const i of issues) { const k = xs.findIndex((w, j) => i.cr >= w && (j === weeks - 1 || i.cr < xs[j + 1])); if (k >= 0) n[k]++; }
      return { x: xs, values: n };
    }

    /** Median / p85 days spent per status (time so far included for the current status). */
    function timeInStatus(issues) {
      const per = {};
      for (const i of issues) {
        const acc = {};
        for (const [s, a, b] of timeline(i)) acc[s] = (acc[s] ?? 0) + (b - a);
        for (const [s, ms] of Object.entries(acc)) (per[s] ??= []).push(ms / DAY);
      }
      return Object.entries(per).map(([s, v]) => ({ status: s, n: v.length, median: median(v), p85: quantile(v, 0.85), total: v.reduce((x, y) => x + y, 0) }));
    }

    function transitions(issues) {
      const m = {};
      for (const i of issues) for (const h of i.h) if (h[2] === 'status') { const key = `${h[5]}>${h[6]}`; m[key] = (m[key] ?? 0) + 1; }
      return Object.entries(m).map(([k, n]) => { const [from, to] = k.split('>'); return { from, to, n }; }).sort((a, b) => b.n - a.n);
    }

    /** Days since the issue entered its current status, and since work started. */
    function age(i) {
      const segs = timeline(i);
      const last = segs[segs.length - 1];
      const s = startedAt(i);
      return { inStatus: (now - last[1]) / DAY, sinceStart: s != null ? (now - s) / DAY : null, sinceCreated: (now - i.cr) / DAY };
    }

    return { cat, timeline, statusAt, catAt, isDone, completedAt, startedAt, cycleDays, leadDays, reopens, burnup, cfd, throughput, arrivals, timeInStatus, transitions, age, now };
  }

  // ---------- forecast ----------

  function rng(seed) { // mulberry32
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  /**
   * Monte Carlo "when will the remaining items be done", sampling weekly throughput from history.
   * With `arrivals`, each simulated week also samples new scope from the same history.
   * Returns weeks-to-done per run (Infinity when not done within `maxWeeks`) and summary helpers.
   */
  function monteCarlo({ remaining, throughput, arrivals = null, runs = 4000, maxWeeks = 260, seed = 42 }) {
    if (remaining <= 0) return { weeks: [0], percentile: () => 0, probWithin: () => 1, feasible: true };
    if (!throughput.length || throughput.every(v => v === 0)) return { weeks: [], percentile: () => null, probWithin: () => 0, feasible: false };
    const r = rng(seed), out = new Array(runs);
    for (let k = 0; k < runs; k++) {
      let left = remaining, w = 0;
      while (left > 0 && w < maxWeeks) {
        const j = Math.floor(r() * throughput.length);
        left -= throughput[j];
        if (arrivals) left += arrivals[j];
        w++;
      }
      out[k] = left > 0 ? Infinity : w;
    }
    out.sort((a, b) => a - b);
    return {
      weeks: out, feasible: true,
      percentile: q => out[Math.min(out.length - 1, Math.floor(q * out.length))],
      probWithin: weeks => out.filter(w => w <= weeks).length / out.length,
    };
  }

  /**
   * The forecast shown in the report, as a pure function so the page and the per-run history
   * compute the same numbers. items = standard work items; target = { t } or null.
   */
  function forecast(A, items, { weeks = 12, runs = 4000, growth = false, target = null } = {}) {
    const tp = A.throughput(items, weeks + 1), ar = A.arrivals(items, weeks + 1);
    const samples = tp.values.slice(0, -1), arrivals = ar.values.slice(0, -1);   // full weeks only
    const remaining = items.filter(i => !A.isDone(i)).length;
    const mc = monteCarlo({ remaining, throughput: samples, arrivals: growth ? arrivals : null, runs });
    const at = w => (w == null || w === Infinity ? null : A.now + w * WEEK);
    const prob = target ? (target.t < A.now ? null : mc.probWithin(Math.floor((target.t - A.now) / WEEK))) : null;
    return { remaining, samples, arrivals, growth, mc, p50: at(mc.percentile(0.5)), p85: at(mc.percentile(0.85)), p95: at(mc.percentile(0.95)), target, prob, weeks };
  }

  /** The epic an issue rolls up to (itself for an epic; via parent or grandparent; or an out-of-scope parent epic). */
  function epicResolver(model) {
    const byKey = new Map(model.issues.map(i => [i.k, i]));
    const ext = model.meta.externalParents ?? {};
    return i => {
      if (i.lvl >= 1) return i.lvl === 1 ? i.k : null;
      const p = i.par && byKey.get(i.par);
      if (p?.lvl === 1) return p.k;
      if (p?.par) { const g = byKey.get(p.par); if (g?.lvl === 1) return g.k; }
      if (!p && i.par && ext[i.par]) return i.par;
      return null;
    };
  }

  // ---------- pivot ----------

  /** Count issues by (row value, column value). dimension fns return arrays; empty → "(none)". */
  function pivot(issues, rowFn, colFn) {
    const cells = new Map(), rows = new Map(), cols = new Map();
    const vals = (fn, i) => { const v = fn(i); return v.length ? v : ['(none)']; };
    for (const i of issues) {
      const rs = [...new Set(vals(rowFn, i))], cs = colFn ? [...new Set(vals(colFn, i))] : ['Count'];
      for (const r of rs) { rows.set(r, (rows.get(r) ?? 0) + 1); for (const c of cs) { const k = r + '\u0000' + c; cells.set(k, (cells.get(k) ?? 0) + 1); } }
      for (const c of cs) cols.set(c, (cols.get(c) ?? 0) + 1);
    }
    return { rows, cols, cell: (r, c) => cells.get(r + '\u0000' + c) ?? 0, total: issues.length };
  }

  return { DAY, WEEK, startOfDay, startOfWeek, addDays, quantile, median, context, monteCarlo, forecast, epicResolver, pivot, rng };
})();
