import { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, Smile, Trash2, Upload } from 'lucide-react';
import { api } from '../api/client.js';

export interface PageHeaderDecorationsProps {
  icona: string | null;
  copertina: string | null;
  onChangeIcona: (next: string | null) => void;
  onChangeCopertina: (next: string | null) => void;
}

const EMOJI_PRESETS = [
  '📄', '📝', '📌', '🚀', '💡', '🧠', '📚', '🎯',
  '✅', '📅', '📊', '🗂️', '🏃', '💻', '🔬', '🎨',
  '🏠', '⭐', '🔥', '🌿', '🧭', '🛠️', '📈', '🎓',
  '💼', '🧪', '🎵', '📷', '🌍', '⚡', '🔒', '💎',
  '🧩', '🏆', '🍎', '☕', '✈️', '🏋️', '📖', '💬',
];

const COVER_COLOR_PRESETS: Array<{ label: string; value: string }> = [
  { label: 'Azzurro', value: '#dbeafe' },
  { label: 'Salvia', value: '#dcfce7' },
  { label: 'Ambra', value: '#fef3c7' },
  { label: 'Rosa tenue', value: '#fce7f3' },
  { label: 'Lavanda', value: '#ede9fe' },
  { label: 'Ardesia', value: '#e2e8f0' },
  { label: 'Oceano', value: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)' },
  { label: 'Tramonto', value: 'linear-gradient(135deg, #f97316 0%, #db2777 100%)' },
  { label: 'Foresta', value: 'linear-gradient(135deg, #10b981 0%, #047857 100%)' },
  { label: 'Notte', value: 'linear-gradient(135deg, #312e81 0%, #1e1b4b 100%)' },
];

export function PageHeaderDecorations({
  icona,
  copertina,
  onChangeIcona,
  onChangeCopertina,
}: PageHeaderDecorationsProps) {
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [coverPickerOpen, setCoverPickerOpen] = useState(false);
  const [coverTab, setCoverTab] = useState<'colors' | 'images'>('colors');
  const [customEmoji, setCustomEmoji] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [attachmentThumbs, setAttachmentThumbs] = useState<Record<string, string>>({});
  const [coverBlobUrl, setCoverBlobUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const iconPopoverRef = useRef<HTMLDivElement>(null);
  const coverPopoverRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isAttachmentCover = Boolean(
    copertina && copertina.trim().toLowerCase().startsWith('allegati/'),
  );

  useEffect(() => {
    let cancelled = false;
    if (!copertina || !isAttachmentCover) {
      setCoverBlobUrl(null);
      return;
    }
    void api.getAttachmentObjectUrl(copertina).then((url) => {
      if (!cancelled) setCoverBlobUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [copertina, isAttachmentCover]);

  useEffect(() => {
    if (!coverPickerOpen || coverTab !== 'images') return;
    let cancelled = false;
    void api.listAttachments().then(async (files) => {
      if (cancelled) return;
      setAttachments(files);
      const thumbs: Record<string, string> = {};
      for (const f of files) {
        const url = await api.getAttachmentObjectUrl(f);
        if (url) thumbs[f] = url;
      }
      if (!cancelled) setAttachmentThumbs(thumbs);
    });
    return () => {
      cancelled = true;
    };
  }, [coverPickerOpen, coverTab]);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (
        iconPickerOpen &&
        iconPopoverRef.current &&
        !iconPopoverRef.current.contains(e.target as Node)
      ) {
        setIconPickerOpen(false);
      }
      if (
        coverPickerOpen &&
        coverPopoverRef.current &&
        !coverPopoverRef.current.contains(e.target as Node)
      ) {
        setCoverPickerOpen(false);
      }
    };
    if (iconPickerOpen || coverPickerOpen) {
      document.addEventListener('mousedown', handleOutside);
    }
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [iconPickerOpen, coverPickerOpen]);

  const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(new Error('Lettura immagine fallita'));
        reader.readAsDataURL(file);
      });
      const uploaded = await api.uploadAttachment(file.name, dataUrl);
      onChangeCopertina(uploaded.path);
      setCoverPickerOpen(false);
    } catch (err) {
      alert(`Impossibile caricare la copertina: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="notion-page-decorations">
      {/* Copertina di pagina */}
      {copertina && (
        <div
          className="notion-page-cover"
          style={{
            height: '150px',
            width: '100%',
            position: 'relative',
            background: isAttachmentCover
              ? coverBlobUrl
                ? `center / cover no-repeat url("${coverBlobUrl}")`
                : 'var(--bg-sidebar)'
              : copertina,
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <div
            className="notion-cover-hover-controls"
            style={{
              position: 'absolute',
              right: '16px',
              bottom: '10px',
              display: 'flex',
              gap: '6px',
            }}
          >
            <button
              type="button"
              className="notion-header-pill-btn solid"
              onClick={() => setCoverPickerOpen((v) => !v)}
            >
              <ImageIcon size={12} />
              <span>Cambia copertina</span>
            </button>
            <button
              type="button"
              className="notion-header-pill-btn solid"
              onClick={() => {
                setCoverPickerOpen(false);
                onChangeCopertina(null);
              }}
              title="Rimuovi copertina"
            >
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      )}

      {/* Barra azioni sopra al titolo: Icona + Aggiungi icona / Aggiungi copertina */}
      <div
        className="notion-page-meta-bar"
        style={{
          maxWidth: '860px',
          width: '100%',
          margin: '0 auto',
          padding: copertina ? '12px 48px 0 48px' : '18px 48px 0 48px',
          position: 'relative',
        }}
      >
        <div
          className="notion-page-quick-actions"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            minHeight: '26px',
            marginBottom: icona ? '6px' : '2px',
          }}
        >
          {!icona && (
            <button
              type="button"
              className="notion-header-pill-btn"
              onClick={() => setIconPickerOpen((v) => !v)}
            >
              <Smile size={13} />
              <span>Aggiungi icona</span>
            </button>
          )}

          {!copertina && (
            <button
              type="button"
              className="notion-header-pill-btn"
              onClick={() => setCoverPickerOpen((v) => !v)}
            >
              <ImageIcon size={13} />
              <span>Aggiungi copertina</span>
            </button>
          )}
        </div>

        {icona && (
          <div style={{ display: 'inline-block', position: 'relative', marginBottom: '4px' }}>
            <button
              type="button"
              className="notion-page-icon-badge"
              onClick={() => setIconPickerOpen((v) => !v)}
              title="Cambia o rimuovi icona"
              style={{
                fontSize: '36px',
                lineHeight: 1.1,
                padding: '4px 6px',
                borderRadius: 'var(--radius-md)',
                background: 'transparent',
                cursor: 'pointer',
              }}
            >
              {icona}
            </button>
          </div>
        )}

        {/* Selettore Emoji Icona */}
        {iconPickerOpen && (
          <div
            ref={iconPopoverRef}
            className="tree-dropdown-menu"
            style={{
              position: 'absolute',
              top: icona ? '72px' : '38px',
              left: '48px',
              width: '280px',
              padding: '10px',
              zIndex: 120,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '8px',
                fontSize: '12px',
                fontWeight: 600,
                color: 'var(--text-muted)',
              }}
            >
              <span>Icona pagina</span>
              {icona && (
                <button
                  type="button"
                  className="notion-link-edit-btn danger"
                  onClick={() => {
                    onChangeIcona(null);
                    setIconPickerOpen(false);
                  }}
                >
                  Rimuovi
                </button>
              )}
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(8, 1fr)',
                gap: '4px',
                marginBottom: '8px',
              }}
            >
              {EMOJI_PRESETS.map((em) => (
                <button
                  key={em}
                  type="button"
                  onClick={() => {
                    onChangeIcona(em);
                    setIconPickerOpen(false);
                  }}
                  style={{
                    fontSize: '18px',
                    padding: '4px',
                    borderRadius: 'var(--radius-sm)',
                    background: icona === em ? 'var(--bg-hover)' : 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  {em}
                </button>
              ))}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                const val = customEmoji.trim();
                if (val) {
                  onChangeIcona(val.slice(0, 8));
                  setCustomEmoji('');
                  setIconPickerOpen(false);
                }
              }}
              style={{ display: 'flex', gap: '6px' }}
            >
              <input
                type="text"
                className="notion-link-edit-input"
                placeholder="Oppure incolla emoji..."
                value={customEmoji}
                onChange={(e) => setCustomEmoji(e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="submit" className="notion-link-edit-btn primary">
                Usa
              </button>
            </form>
          </div>
        )}

        {/* Selettore Copertina (Colori o Immagini in kb/allegati/) */}
        {coverPickerOpen && (
          <div
            ref={coverPopoverRef}
            className="tree-dropdown-menu"
            style={{
              position: 'absolute',
              top: '38px',
              left: '48px',
              width: '320px',
              padding: '10px',
              zIndex: 120,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottom: '1px solid var(--border-subtle)',
                paddingBottom: '6px',
                marginBottom: '8px',
              }}
            >
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  className={`notion-link-edit-btn ${coverTab === 'colors' ? 'primary' : ''}`}
                  onClick={() => setCoverTab('colors')}
                >
                  Colori
                </button>
                <button
                  type="button"
                  className={`notion-link-edit-btn ${coverTab === 'images' ? 'primary' : ''}`}
                  onClick={() => setCoverTab('images')}
                >
                  Allegati
                </button>
              </div>
              {copertina && (
                <button
                  type="button"
                  className="notion-link-edit-btn danger"
                  onClick={() => {
                    onChangeCopertina(null);
                    setCoverPickerOpen(false);
                  }}
                >
                  Rimuovi
                </button>
              )}
            </div>

            {coverTab === 'colors' ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(5, 1fr)',
                  gap: '6px',
                }}
              >
                {COVER_COLOR_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    title={preset.label}
                    onClick={() => {
                      onChangeCopertina(preset.value);
                      setCoverPickerOpen(false);
                    }}
                    style={{
                      height: '34px',
                      borderRadius: 'var(--radius-sm)',
                      background: preset.value,
                      border:
                        copertina === preset.value
                          ? '2px solid var(--accent)'
                          : '1px solid var(--border-subtle)',
                      cursor: 'pointer',
                    }}
                  />
                ))}
              </div>
            ) : (
              <div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".png,.jpg,.jpeg,.webp,.gif,.svg"
                  style={{ display: 'none' }}
                  onChange={handleUploadFile}
                />
                <button
                  type="button"
                  className="notion-link-edit-btn primary"
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '6px',
                    marginBottom: '8px',
                  }}
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload size={13} />
                  <span>{uploading ? 'Caricamento...' : 'Carica immagine in kb/allegati/'}</span>
                </button>

                {attachments.length === 0 ? (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'center', padding: '8px 0' }}>
                    Nessuna immagine presente in <code>kb/allegati/</code>.
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(3, 1fr)',
                      gap: '6px',
                      maxHeight: '150px',
                      overflowY: 'auto',
                    }}
                  >
                    {attachments.map((att) => (
                      <button
                        key={att}
                        type="button"
                        title={att}
                        onClick={() => {
                          onChangeCopertina(att);
                          setCoverPickerOpen(false);
                        }}
                        style={{
                          height: '48px',
                          borderRadius: 'var(--radius-sm)',
                          border:
                            copertina === att
                              ? '2px solid var(--accent)'
                              : '1px solid var(--border-subtle)',
                          background: attachmentThumbs[att]
                            ? `center / cover no-repeat url("${attachmentThumbs[att]}")`
                            : 'var(--bg-sidebar)',
                          cursor: 'pointer',
                          fontSize: '10px',
                          overflow: 'hidden',
                        }}
                      >
                        {!attachmentThumbs[att] && att.split('/').pop()}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
