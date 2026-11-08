# Linee Guida di Sviluppo App (webapp/)

Questo documento contiene le direttive per gli sviluppatori e agenti AI che lavorano sul codice dell'applicazione `second-brain`.

## Architettura e Workspaces

L'applicazione è strutturata in un monorepo npm workspace sotto `webapp/`:
- `shared/`: contratti di tipo TypeScript puri (`Eol`, `TreeEntry`, `PageIdentity`, `DatabaseSchema`, `GithubSyncProfile`, ecc.). Zero runtime.
- `packages/kb-core/`: motore logico della Knowledge Base. **Modulo puro**: zero import da `node:*` o da browser. Deve funzionare sia con backend di filesystem (`FsStorage`) sia con backend remoto GitHub (`GithubBackend`) sia in-memory.
- `api/`: backend locale HTTP (Express) e server SSE.
- `web/`: interfaccia utente Single Page Application (React, Vite, CodeMirror, CSS modulare).
- `agent/`: predisposizione per orchestrazione agenti locali.

## Comandi di Sviluppo

Tutti i comandi vanno eseguiti all'interno di `webapp/`:

```bash
# Esecuzione di tutti i test + guardrail di separazione architetturale
npm test

# Controllo tipi statico
npm run typecheck

# Build di produzione dell'applicazione web
npm run build:web

# Stato sincronizzazione KB
npm run kb:status

# Sincronizzazione atomica sicura della sola KB
npm run kb:sync
```

## Regole di Codice e Sicurezza

1. **Purezza di `kb-core`**:
   - I file dentro `packages/kb-core/src/` non devono mai importare moduli nativi di Node (`node:fs`, `node:path`, `node:child_process`, ecc.).
   - Tutte le interazioni con i file passano attraverso l'interfaccia astratta `Storage` e `HistoryStore`.
2. **GithubBackend**:
   - Tutte le scritture e letture sono confinate dentro la sottocartella `percorsoKb` (default `'kb'`).
   - È attivo un guard di sicurezza rigido: path traversal (`..`), percorsi assoluti e scritture su cartelle di codice (`webapp/`, `.github/`) lanciano eccezioni `AppError` con codice `forbidden`.
   - Il confronto dell'albero remoto confronta solo l'albero di `kb/`, ignorando commit e push relativi a `webapp/`.
3. **Markdown come fonte di verità**:
   - I metadati delle note e dei database risiedono nei frontmatter YAML dei file `.md`.
   - La cache `pages.json` è puramente volatile e ricostruibile in qualsiasi momento scansionando i frontmatter.
