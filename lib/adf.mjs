// Atlassian Document Format → plain text (keeps paragraphs, lists, tables and mentions readable).

const BLOCK = new Set(['paragraph', 'heading', 'blockquote', 'codeBlock', 'panel', 'rule', 'table', 'bulletList', 'orderedList', 'mediaSingle', 'mediaGroup', 'expand', 'nestedExpand', 'decisionList', 'taskList']);

export function adfToText(doc) {
  if (doc == null) return '';
  if (typeof doc === 'string') return doc;
  return walk(doc, '').replace(/\n{3,}/g, '\n\n').trim();
}

function walk(n, indent) {
  if (!n) return '';
  const kids = (sep = '') => (n.content ?? []).map(c => walk(c, indent)).join(sep);
  switch (n.type) {
    case 'text': return n.text ?? '';
    case 'hardBreak': return '\n';
    case 'mention': return n.attrs?.text ?? '@user';
    case 'emoji': return n.attrs?.text ?? n.attrs?.shortName ?? '';
    case 'inlineCard': case 'blockCard': case 'embedCard': return n.attrs?.url ?? '';
    case 'status': return `[${n.attrs?.text ?? ''}]`;
    case 'date': return n.attrs?.timestamp ? new Date(Number(n.attrs.timestamp)).toISOString().slice(0, 10) : '';
    case 'rule': return '\n---\n';
    case 'media': case 'mediaInline': return '[attachment]';
    case 'bulletList': case 'orderedList': case 'taskList': case 'decisionList':
      return (n.content ?? []).map((li, i) => indent + (n.type === 'orderedList' ? `${i + 1}. ` : '• ') + walk(li, indent + '  ').trim()).join('\n') + '\n\n';
    case 'table': return (n.content ?? []).map(row => (row.content ?? []).map(c => walk(c, '').trim().replace(/\n+/g, ' ')).join(' | ')).join('\n') + '\n\n';
    case 'codeBlock': return kids() + '\n\n';
    default: {
      const t = kids();
      return BLOCK.has(n.type) || n.type === 'listItem' || n.type === 'taskItem' || n.type === 'decisionItem' ? t + (n.type.endsWith('Item') ? '' : '\n\n') : t;
    }
  }
}
