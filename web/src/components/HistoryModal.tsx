import { RotateCcw, X } from 'lucide-react';

export interface HistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  path: string;
  versionId: string | null;
  content: string | null;
  onRestore: (versionId: string) => void;
}

export function HistoryModal({
  isOpen,
  onClose,
  path,
  versionId,
  content,
  onRestore,
}: HistoryModalProps) {
  if (!isOpen || !versionId) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-box" style={{ maxWidth: '780px', maxHeight: '80vh' }} onClick={(e) => e.stopPropagation()}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 18px',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'var(--bg-sidebar)',
          }}
        >
          <div>
            <h3 style={{ fontSize: '15px', fontWeight: 600 }}>Storico versione: {path}</h3>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Snapshot ID: {versionId}</span>
          </div>
          <button className="sidebar-action-btn" onClick={onClose} title="Chiudi">
            <X size={18} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '16px', background: 'var(--bg-surface)' }}>
          <pre
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '13px',
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              color: 'var(--text-main)',
            }}
          >
            {content ?? 'Caricamento versione...'}
          </pre>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: '8px',
            padding: '12px 18px',
            borderTop: '1px solid var(--border-subtle)',
            background: 'var(--bg-sidebar)',
          }}
        >
          <button className="view-mode-btn" onClick={onClose}>
            Annulla
          </button>
          <button
            className="view-mode-btn"
            style={{
              background: 'var(--accent)',
              color: '#ffffff',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
            onClick={() => onRestore(versionId)}
          >
            <RotateCcw size={14} /> Ripristina questa versione
          </button>
        </div>
      </div>
    </div>
  );
}
