import type { PageIdentity, TreeEntry } from '@brain/shared';
import { parseCsv } from '../core/csv.js';
import { parseFrontmatter } from '../core/frontmatter.js';
import { renderMarkdown } from '../core/markdown.js';
import { resolveInternalPageTarget } from '../core/pages.js';

export interface PreviewProps {
  path: string;
  content: string;
  entries?: TreeEntry[];
  pages?: PageIdentity[];
  liveTitleDrafts?: Record<string, string>;
  onOpenWikilink: (target: string) => void;
  onTagClick?: (tag: string) => void;
}

export function Preview({
  path,
  content,
  entries,
  pages,
  liveTitleDrafts,
  onOpenWikilink,
}: PreviewProps) {
  // 1. Visualizzazione file CSV (senza icone o emoji in alto)
  if (path.toLowerCase().endsWith('.csv')) {
    const csv = parseCsv(content);
    return (
      <div className="preview-pane" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 600 }}>{path}</h2>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>({csv.rows.length} record)</span>
        </div>
        <div style={{ overflowX: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ background: 'var(--bg-sidebar)', borderBottom: '2px solid var(--border-subtle)' }}>
                {csv.headers.map((h, i) => (
                  <th key={i} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-main)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {csv.rows.map((row, rIdx) => (
                <tr key={rIdx} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  {row.map((cell, cIdx) => (
                    <td key={cIdx} style={{ padding: '8px 12px', color: 'var(--text-main)' }}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // 2. Visualizzazione file di testo semplice (.txt)
  if (path.toLowerCase().endsWith('.txt')) {
    return (
      <div className="preview-pane" style={{ padding: '28px' }}>
        <pre style={{ fontFamily: 'var(--font-mono)', fontSize: '14px', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
          {content}
        </pre>
      </div>
    );
  }

  // 3. Visualizzazione Markdown con Wikilink risolti dinamicamente verso le pagine esistenti
  const { body } = parseFrontmatter(content);
  const html = renderMarkdown(
    body,
    entries
      ? (target) => resolveInternalPageTarget(target, path, entries, pages ?? [], liveTitleDrafts)
      : undefined,
  );

  const handleContainerClick = (e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest('[data-wikilink-target]');
    if (target) {
      e.preventDefault();
      const rawTarget = target.getAttribute('data-wikilink-target');
      if (rawTarget) {
        onOpenWikilink(decodeURIComponent(rawTarget));
      }
    }
  };

  return (
    <div className="preview-pane" onClick={handleContainerClick}>
      <div className="markdown-body">
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}
