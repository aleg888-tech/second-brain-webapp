import { useMemo } from 'react';
import { ListTree } from 'lucide-react';

export interface RightPanelProps {
  currentPath: string | null;
  currentContent: string;
}

export function RightPanel({
  currentPath,
  currentContent,
}: RightPanelProps) {
  // Estrazione sommario (Outline) dai titoli Markdown
  const headings = useMemo(() => {
    if (!currentContent) return [];
    const lines = currentContent.split(/\r?\n/);
    const out: Array<{ level: number; text: string; line: number }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const match = line.match(/^(#{1,4})\s+(.+)$/);
      if (match) {
        out.push({
          level: match[1]!.length,
          text: match[2]!.trim(),
          line: i + 1,
        });
      }
    }
    return out;
  }, [currentContent]);

  if (!currentPath) {
    return (
      <aside className="right-panel">
        <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
          Nessuna nota aperta
        </div>
      </aside>
    );
  }

  return (
    <aside className="right-panel">
      {/* Intestazione della sezione */}
      <div
        className="right-panel-header"
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          fontSize: '12px',
          fontWeight: 600,
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        <ListTree size={14} color="var(--accent)" />
        <span>Indice dei contenuti</span>
      </div>

      <div className="right-panel-body" style={{ padding: '16px 12px' }}>
        {headings.length === 0 ? (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
            Nessun titolo trovato nella nota corrente.
          </div>
        ) : (
          headings.map((h, i) => (
            <div
              key={i}
              style={{
                paddingLeft: `${(h.level - 1) * 12}px`,
                paddingTop: '4px',
                paddingBottom: '4px',
                fontSize: '12px',
                color: 'var(--text-main)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              <span style={{ color: 'var(--text-muted)', marginRight: '6px' }}>{'#'.repeat(h.level)}</span>
              {h.text}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
