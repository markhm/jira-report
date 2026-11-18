// SVG / HTML chart builders. Each returns markup; hover tooltips come from `data-tip` attributes
// read by one delegated handler (see ui.js). Specs: 2px lines, ≤24px bars with 4px rounded data
// ends, hairline solid grid, 10% area washes, 2px surface gaps, text in ink tokens only.

const Charts = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtN = n => (n == null ? '–' : Math.abs(n) >= 1000 ? n.toLocaleString('en-GB', { maximumFractionDigits: 0 }) : Number.isInteger(n) ? String(n) : n.toFixed(1));
  const fmtD = t => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
  const fmtDShort = t => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  function niceTicks(max, count = 4) {
    if (!(max > 0)) return [0, 1];
    const raw = max / count, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
    const out = [];
    for (let v = 0; v <= max + step * 0.001; v += step) out.push(+v.toFixed(6));
    if (out[out.length - 1] < max) out.push(+(out[out.length - 1] + step).toFixed(6));
    return out;
  }

  /** Date ticks: ~n evenly spaced, snapped to the given x values. */
  function dateTicks(xs, n) {
    if (xs.length <= n) return xs.map((_, i) => i);
    const step = (xs.length - 1) / (n - 1);
    return Array.from({ length: n }, (_, k) => Math.round(k * step));
  }

  const PAD = { l: 40, r: 16, t: 12, b: 26 };

  function frame(w, h, yMax, { yFmt = fmtN } = {}) {
    const ticks = niceTicks(yMax);
    const top = ticks[ticks.length - 1];
    const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
    const y = v => PAD.t + ih - (v / top) * ih;
    const grid = ticks.map(t => `<line class="grid" x1="${PAD.l}" x2="${w - PAD.r}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${PAD.l - 6}" y="${y(t) + 4}" text-anchor="end">${yFmt(t)}</text>`).join('');
    return { iw, ih, y, top, grid };
  }

  /**
   * Time series (lines, or stacked areas). series: [{name, color, values, dash?}].
   * markers: [{t, label}] vertical reference lines (dates may fall beyond the data: the axis extends).
   * extra: [{name, color, points:[[t, v]]}] projected polylines drawn thin (forecast).
   */
  function timeSeries({ x, series, width, height = 260, stacked = false, markers = [], extra = [], tipTitle = fmtD, xMax = null }) {
    if (!x.length) return empty(width, height);
    const t0 = x[0];
    const tEnd = xMax ?? Math.max(x[x.length - 1], ...markers.map(m => m.t), ...extra.flatMap(e => e.points.map(p => p[0])));
    // Clip projections and drop markers beyond the axis end.
    markers = markers.filter(m => m.t <= tEnd);
    extra = extra.map(e => ({ ...e, points: clipLine(e.points, tEnd) }));
    const totals = x.map((_, j) => stacked ? series.reduce((s, se) => s + se.values[j], 0) : Math.max(...series.map(se => se.values[j])));
    const yMax = Math.max(1, ...totals, ...extra.flatMap(e => e.points.map(p => p[1])));
    const f = frame(width, height, yMax);
    const xt = t => PAD.l + ((t - t0) / Math.max(1, tEnd - t0)) * f.iw;
    const xi = i => xt(x[i]);
    let body = '';
    if (stacked) {
      const base = new Array(x.length).fill(0);
      // Draw bottom band first; each band is an area between its baseline and top.
      series.forEach(se => {
        const top = se.values.map((v, j) => base[j] + v);
        const up = top.map((v, j) => `${xi(j).toFixed(1)},${f.y(v).toFixed(1)}`);
        const down = base.map((v, j) => `${xi(j).toFixed(1)},${f.y(v).toFixed(1)}`).reverse();
        body += `<polygon class="band" points="${up.join(' ')} ${down.join(' ')}" style="fill:${se.color}"/>`;
        top.forEach((v, j) => { base[j] = v; });
      });
    } else {
      for (const se of series) {
        const pts = se.values.map((v, j) => `${xi(j).toFixed(1)},${f.y(v).toFixed(1)}`).join(' ');
        body += `<polygon class="wash" points="${xi(0)},${f.y(0)} ${pts} ${xi(x.length - 1)},${f.y(0)}" style="fill:${se.color}"/>`;
        body += `<polyline class="line" points="${pts}" style="stroke:${se.color}"/>`;
        const j = x.length - 1;
        body += `<circle class="dot" cx="${xi(j)}" cy="${f.y(se.values[j])}" r="4" style="fill:${se.color}"/>`;
      }
    }
    for (const e of extra) {
      body += `<polyline class="proj" points="${e.points.map(p => `${xt(p[0]).toFixed(1)},${f.y(p[1]).toFixed(1)}`).join(' ')}" style="stroke:${e.color}"/>`;
    }
    // Markers on the same pixel share one line and label ("50% · 85%"); a label that would run into
    // the one before it drops a row.
    const lines = [];
    for (const m of markers.map(m => ({ x: Math.round(xt(m.t)), label: m.label })).sort((a, b) => a.x - b.x)) {
      const same = lines.find(l => Math.abs(l.x - m.x) <= 1);
      if (same) same.label += ` · ${m.label}`; else lines.push({ ...m });
    }
    const rowEnds = [];
    for (const l of lines) {
      const w = l.label.length * 6.5 + 8;
      let row = rowEnds.findIndex(end => end <= l.x);
      if (row < 0) row = rowEnds.length;
      rowEnds[row] = l.x + w;
      body += `<line class="marker" x1="${l.x}" x2="${l.x}" y1="${PAD.t}" y2="${PAD.t + f.ih}"/><text class="marker-label" x="${l.x + 4}" y="${PAD.t + 12 + row * 13}">${esc(l.label)}</text>`;
    }
    // Hover bands: one per x, carrying every series' value.
    const bw = f.iw / Math.max(1, (tEnd - t0) / (x.length > 1 ? x[1] - x[0] : 1));
    const hover = x.map((t, j) => {
      const tip = `<b>${esc(tipTitle(t))}</b>` + series.map(se => `<div><i style="background:${se.color}"></i>${esc(se.name)} <b>${fmtN(se.values[j])}</b></div>`).join('');
      return `<rect class="hover" x="${(xi(j) - bw / 2).toFixed(1)}" y="${PAD.t}" width="${Math.max(bw, 1).toFixed(1)}" height="${f.ih}" data-tip="${esc(tip)}"/>`;
    }).join('');
    const nT = Math.max(2, Math.floor(width / 110));
    const axisX = Array.from({ length: nT }, (_, k) => t0 + ((tEnd - t0) * k) / (nT - 1)).map(t => `<text class="tick" x="${xt(t).toFixed(1)}" y="${height - 8}" text-anchor="middle">${esc(fmtDShort(t))}</text>`).join('');
    return svg(width, height, f.grid + `<line class="axis" x1="${PAD.l}" x2="${width - PAD.r}" y1="${PAD.t + f.ih}" y2="${PAD.t + f.ih}"/>` + body + axisX + hover);
  }

  /**
   * Columns over categories (weeks). One series via values/color, or grouped bars on one shared
   * scale via series: [{name, color, values}]; tip then gets (label, index).
   */
  function columns({ labels, values, color, series = null, width, height = 220, tip = (l, v) => `${l}: <b>${fmtN(v)}</b>`, labelFmt = String, refLine = null }) {
    if (!labels.length) return empty(width, height);
    const groups = series ?? [{ values, color }];
    const f = frame(width, height, Math.max(1, ...groups.flatMap(g => g.values), refLine?.v ?? 0));
    const slot = f.iw / labels.length, gw = Math.min(24 * groups.length, slot * 0.7), bw = (gw - 2 * (groups.length - 1)) / groups.length;
    let body = '';
    labels.forEach((l, i) => {
      const cx = PAD.l + slot * (i + 0.5);
      groups.forEach((g, k) => {
        const v = g.values[i], top = f.y(v), h = PAD.t + f.ih - top;
        if (v > 0) body += `<path style="fill:${g.color}" d="${roundTop(cx - gw / 2 + k * (bw + 2), top, bw, h, Math.min(4, bw / 3))}"/>`;
      });
      body += `<rect class="hover" x="${cx - slot / 2}" y="${PAD.t}" width="${slot}" height="${f.ih}" data-tip="${esc(series ? tip(labelFmt(l), i) : tip(labelFmt(l), values[i]))}"/>`;
    });
    if (refLine) body += `<line class="marker" x1="${PAD.l}" x2="${width - PAD.r}" y1="${f.y(refLine.v)}" y2="${f.y(refLine.v)}"/><text class="marker-label" x="${PAD.l + 6}" y="${f.y(refLine.v) - 5}">${esc(refLine.label)}</text>`;
    const idx = dateTicks(labels, Math.max(2, Math.floor(width / 90)));
    const ax = idx.map(i => `<text class="tick" x="${PAD.l + slot * (i + 0.5)}" y="${height - 8}" text-anchor="middle">${esc(labelFmt(labels[i]))}</text>`).join('');
    return svg(width, height, f.grid + `<line class="axis" x1="${PAD.l}" x2="${width - PAD.r}" y1="${PAD.t + f.ih}" y2="${PAD.t + f.ih}"/>` + body + ax);
  }

  /** Inline sparkline (no axes) for table cells; tip describes the series. */
  function spark(values, { width = 96, height = 24, color = 'var(--series-1)', tip = '' } = {}) {
    if (values.length < 2) return '';
    const lo = Math.min(...values), hi = Math.max(...values), span = Math.max(1, hi - lo);
    const pts = values.map((v, k) => `${(2 + (k / (values.length - 1)) * (width - 4)).toFixed(1)},${(height - 3 - ((v - lo) / span) * (height - 6)).toFixed(1)}`);
    const last = pts[pts.length - 1].split(',');
    return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"${tip ? ` data-tip="${esc(tip)}"` : ''}><polyline class="line" points="${pts.join(' ')}" style="stroke:${color}"/><circle class="dot" cx="${last[0]}" cy="${last[1]}" r="2.5" style="fill:${color}"/></svg>`;
  }

  function clipLine(pts, tMax) {
    const out = [];
    for (let k = 0; k < pts.length; k++) {
      const [t, v] = pts[k];
      if (t <= tMax) { out.push(pts[k]); continue; }
      const [pt, pv] = pts[k - 1] ?? pts[k];
      out.push([tMax, pv + (v - pv) * ((tMax - pt) / Math.max(1, t - pt))]);
      break;
    }
    return out;
  }

  function roundTop(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  /** Scatter with a date or categorical x. points: [{x, y, tip, color, id}] ; xCats → categorical. */
  function scatter({ points, width, height = 280, xCats = null, xDomain = null, refLines = [], yLabel = 'days' }) {
    if (!points.length) return empty(width, height);
    const f = frame(width, height, Math.max(1, ...points.map(p => p.y), ...refLines.map(r => r.v)), { yFmt: v => fmtN(v) });
    let xOf, axis = '';
    if (xCats) {
      const slot = f.iw / xCats.length;
      xOf = (p, k) => PAD.l + slot * (xCats.indexOf(p.x) + 0.5) + (((k * 7919) % 100) / 100 - 0.5) * Math.min(slot * 0.6, 40);
      axis = xCats.map((c, i) => `<text class="tick" x="${PAD.l + slot * (i + 0.5)}" y="${height - 8}" text-anchor="middle">${esc(trunc(c, Math.max(6, Math.floor(slot / 7))))}</text>`).join('')
        + xCats.slice(1).map((_, i) => `<line class="grid" x1="${PAD.l + slot * (i + 1)}" x2="${PAD.l + slot * (i + 1)}" y1="${PAD.t}" y2="${PAD.t + f.ih}"/>`).join('');
    } else {
      const [a, b] = xDomain ?? [Math.min(...points.map(p => p.x)), Math.max(...points.map(p => p.x))];
      xOf = p => PAD.l + ((p.x - a) / Math.max(1, b - a)) * f.iw;
      const n = Math.max(2, Math.floor(width / 110));
      axis = Array.from({ length: n }, (_, k) => a + ((b - a) * k) / (n - 1)).map(t => `<text class="tick" x="${PAD.l + ((t - a) / Math.max(1, b - a)) * f.iw}" y="${height - 8}" text-anchor="middle">${esc(fmtDShort(t))}</text>`).join('');
    }
    // Alternate label sides so two nearby reference lines never print over each other.
    let body = refLines.map((r, k) => `<line class="marker" x1="${PAD.l}" x2="${width - PAD.r}" y1="${f.y(r.v)}" y2="${f.y(r.v)}"/><text class="marker-label" x="${k % 2 ? width - PAD.r - 6 : PAD.l + 6}" y="${f.y(r.v) - 5}"${k % 2 ? ' text-anchor="end"' : ''}>${esc(r.label)}</text>`).join('');
    body += points.map((p, k) => `<circle class="pt" cx="${xOf(p, k).toFixed(1)}" cy="${f.y(p.y).toFixed(1)}" r="4.5" style="fill:${p.color}" data-tip="${esc(p.tip)}"${p.id ? ` data-issue="${esc(p.id)}"` : ''}/>`).join('');
    return svg(width, height, f.grid + `<line class="axis" x1="${PAD.l}" x2="${width - PAD.r}" y1="${PAD.t + f.ih}" y2="${PAD.t + f.ih}"/>` + axis + body);
  }

  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const svg = (w, h, inner) => `<svg class="chart" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img">${inner}</svg>`;
  const empty = (w, h) => `<div class="empty" style="height:${h}px">No data for the current filters</div>`;

  /** HTML bar list: rows [{label, value, color?, tip?, onclickAttr?}] */
  function barList(rows, { max = Math.max(1, ...rows.map(r => r.value)), color = 'var(--series-1)', fmt = fmtN, wideLabels = false } = {}) {
    if (!rows.length) return '<div class="empty small">Nothing to show</div>';
    return `<div class="barlist${wideLabels ? ' wide' : ''}">${rows.map(r => `<div class="bl-row"${r.attrs ?? ''}${r.tip ? ` data-tip="${esc(r.tip)}"` : ''}><div class="bl-label" title="${esc(r.label)}">${esc(r.label)}</div><div class="bl-track"><div class="bl-bar" style="width:${(100 * r.value / max).toFixed(2)}%;background:${r.color ?? color}"></div></div><div class="bl-val">${fmt(r.value)}</div></div>`).join('')}</div>`;
  }

  /** Horizontal 100% stacked bar: parts [{label, value, color}] */
  function stackBar(parts, { height = 10, width = null, showLegend = false } = {}) {
    const total = parts.reduce((s, p) => s + p.value, 0);
    const style = `height:${height}px${width ? `;width:${width}` : ''}`;
    if (!total) return `<div class="stack" style="${style}"></div>`;
    const bar = `<div class="stack" style="${style}">${parts.filter(p => p.value).map(p => `<span style="flex:${p.value};background:${p.color}" data-tip="${esc(`${p.label}: <b>${fmtN(p.value)}</b> (${Math.round(100 * p.value / total)}%)`)}"></span>`).join('')}</div>`;
    return showLegend ? bar + legend(parts.map(p => ({ ...p, label: `${p.label} ${fmtN(p.value)}` }))) : bar;
  }

  const legend = items => `<div class="legend">${items.map(i => `<span><i style="background:${i.color}"></i>${esc(i.label)}</span>`).join('')}</div>`;

  return { esc, fmtN, fmtD, fmtDShort, timeSeries, columns, spark, scatter, barList, stackBar, legend, niceTicks };
})();
