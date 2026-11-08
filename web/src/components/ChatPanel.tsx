import { BotOff, X } from 'lucide-react';

export interface ChatPanelProps {
  isOpen: boolean;
  onClose: () => void;
  agentUrl?: string;
}

export function ChatPanel({ isOpen, onClose, agentUrl }: ChatPanelProps) {
  if (!isOpen) return null;

  return (
    <div className="chat-drawer">
      <div className="chat-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <BotOff size={16} color="var(--text-muted)" />
          <span>Assistente AI (brain)</span>
        </div>
        <button className="sidebar-action-btn" onClick={onClose} title="Chiudi chat">
          <X size={16} />
        </button>
      </div>

      <div className="chat-disabled-banner">
        <div
          style={{
            width: '48px',
            height: '48px',
            borderRadius: '50%',
            background: 'var(--bg-sidebar)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <BotOff size={24} color="var(--text-muted)" />
        </div>
        <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-main)' }}>AI non ancora attivata</h3>
        <p style={{ fontSize: '12px', lineHeight: 1.5, color: 'var(--text-muted)' }}>
          Il modulo AI agentico è predisposto (porta prevista <code>4311</code>).
          <br />
          Quando il servizio sarà attivo, basterà impostare il parametro <code>"agentUrl"</code> nel file <code>.brain/config.json</code> per abilitare la conversazione.
        </p>

        {agentUrl && (
          <div style={{ fontSize: '11px', color: 'var(--text-faint)', marginTop: '8px' }}>
            URL configurato: <code>{agentUrl}</code>
          </div>
        )}
      </div>

      <div style={{ padding: '12px', borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-sidebar)' }}>
        <input
          type="text"
          disabled
          placeholder="AI disattivata — nessuna richiesta di rete"
          style={{
            width: '100%',
            padding: '8px 12px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-subtle)',
            background: 'var(--bg-surface)',
            color: 'var(--text-muted)',
            cursor: 'not-allowed',
            fontSize: '12px',
          }}
        />
      </div>
    </div>
  );
}
