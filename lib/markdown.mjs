// Minimal, safe Markdown → HTML for reviewer notes: headings, paragraphs, bullet and numbered
// lists (one nesting level), **bold**, *italic*, `code`, [links](https://…) and horizontal rules.
// Everything is escaped first; only the constructs above produce markup. Issue keys that exist in
// the report (e.g. DEMO-330) become links that open the issue drawer.

const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(s, keys) {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  if (keys) h = h.replace(/\b([A-Z][A-Z0-9_]+-\d+)\b/g, (m, k) => (keys.has(k) ? `<a href="#" data-open="${k}">${k}</a>` : m));
  return h;
}

export function markdown(src, { keys } = {}) {
  const lines = src.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const out = [];
  let para = [], list = null;   // list: { type, items: [{ text, sub: [] }] }
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(' '), keys)}</p>`); para = []; };
  const flushList = () => {
    if (!list) return;
    const sub = s => (s.length ? `<ul>${s.map(t => `<li>${inline(t, keys)}</li>`).join('')}</ul>` : '');
    out.push(`<${list.type}>${list.items.map(it => `<li>${inline(it.text, keys)}${sub(it.sub)}</li>`).join('')}</${list.type}>`);
    list = null;
  };
  for (const line of lines) {
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); flushList(); const n = Math.min(4, m[1].length + 2); out.push(`<h${n}>${inline(m[2], keys)}</h${n}>`); continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }
    if ((m = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/))) {
      flushPara();
      const nested = m[1].length >= 2 && list;
      if (nested) { list.items[list.items.length - 1].sub.push(m[3]); continue; }
      const type = /\d/.test(m[2]) ? 'ol' : 'ul';
      if (list && list.type !== type) flushList();
      (list ??= { type, items: [] }).items.push({ text: m[3], sub: [] });
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { const it = list.items[list.items.length - 1]; (it.sub.length ? it.sub : null) ? (it.sub[it.sub.length - 1] += ' ' + line.trim()) : (it.text += ' ' + line.trim()); continue; }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join('\n');
}
