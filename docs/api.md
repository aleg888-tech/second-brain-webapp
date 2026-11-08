# Specifiche API HTTP (v1)

L'API ascolta su `http://127.0.0.1:4310` e accetta richieste autenticate tramite header `Authorization: Bearer <token>`.

---

## 1. Stato e Configurazione

### `GET /v1/status`
Restituisce la firma attuale dell'albero e il conteggio file.
- **Risposta (200)**:
  ```json
  {
    "signature": "a8f3b49c0d12e...",
    "files": 42
  }
  ```

### `GET /v1/config`
Restituisce le impostazioni attive della knowledge base.
- **Risposta (200)**:
  ```json
  {
    "extensions": [".md", ".csv", ".txt"],
    "archiveDir": "_archivio",
    "agentDeny": ["segreto"]
  }
  ```

---

## 2. File e Cartelle

### `GET /v1/tree?all=false`
Elenco ad albero di tutti i file e cartelle. Se `all=true`, include anche i file archiviati.
- **Risposta (200)**:
  ```json
  {
    "entries": [
      {
        "path": "note/corsa.md",
        "type": "file",
        "size": 1024,
        "mtimeMs": 1730840000000,
        "archived": false
      }
    ]
  }
  ```

### `GET /v1/files/content?path=<path>`
Legge il contenuto e i metadati di un file.
- **Risposta (200)**:
  ```json
  {
    "path": "note/corsa.md",
    "content": "# Corsa\n...",
    "version": "4f9d2a1b8c0e1234",
    "eol": "lf",
    "size": 1024,
    "mtimeMs": 1730840000000
  }
  ```

### `POST /v1/files/content`
Salva un file con controllo di concorrenza ottimistica.
- **Corpo**:
  ```json
  {
    "path": "note/corsa.md",
    "content": "# Corsa modificata\n...",
    "baseVersion": "4f9d2a1b8c0e1234"
  }
  ```
- **Risposta (200)**:
  ```json
  {
    "file": { "path": "note/corsa.md", "version": "...", "size": 1050, "eol": "lf", "mtimeMs": 1730840100000 },
    "historyId": "20261105T220000000Z"
  }
  ```
- **Errore di conflitto (409 Conflict)**: se `baseVersion` non corrisponde al contenuto attuale su disco.

### `POST /v1/files/create`
Crea un nuovo file (fallisce se esiste già).
- **Corpo**: `{ "path": "inbox/idea.md", "content": "..." }`

### `POST /v1/folders/create`
Crea una cartella con il rispettivo `_index.md`.
- **Corpo**: `{ "path": "domini/nuovo-dominio" }`

### `POST /v1/files/rename`
Rinomina o sposta un file o una cartella.
- **Corpo**: `{ "from": "inbox/nota.md", "to": "note/nota.md" }`

### `POST /v1/files/archive`
Archivia un file spostandolo in `_archivio/AAAA-MM-GG/<percorso>`. Non cancella mai.
- **Corpo**: `{ "path": "note/vecchia.md" }`

---

## 3. Storico Versioni

### `GET /v1/files/history?path=<path>`
Elenco degli snapshot salvati per il file, dal più recente al più vecchio.
- **Risposta (200)**:
  ```json
  {
    "path": "note/corsa.md",
    "entries": [
      { "id": "20261105T210000000Z", "size": 950, "createdAt": "2026-11-05T21:00:00.000Z" }
    ]
  }
  ```

### `GET /v1/files/history/version?path=<path>&id=<id>`
Recupera il testo salvato in uno snapshot.

### `POST /v1/files/history/restore`
Ripristina lo snapshot indicato salvando preventivamente lo stato attuale nello storico.
- **Corpo**: `{ "path": "note/corsa.md", "id": "20261105T210000000Z" }`

---

## 4. Ricerca e Connessioni

### `GET /v1/search?q=<query>&limit=100&includeArchived=false`
Ricerca full-text rapida con anteprima contestuale.

### `GET /v1/links?path=<path>`
Restituisce i wikilink uscenti con stato (`ok`, `broken`, `archived`), i backlink entranti e i tag della nota.

### `GET /v1/tags`
Elenco di tutti i tag presenti nella knowledge base con il conteggio delle note associate.

---

## 5. Preferenze Utente (Vista)

### `GET /v1/vista`
Recupera preferenze UI da `.brain/vista.json`.

### `PUT /v1/vista`
Aggiorna preferenze UI (tema, preferiti, schede, modalità visualizzazione).

---

## 6. Database, Schemi per Tabella e Viste (`vista`)

### `POST /v1/databases/create`
Crea un nuovo database ospitato nella pagina indicata (convertendola atomicamente in pagina-nodo se necessario), crea `<cartella-db>/_index.md` con `tipo: database`, `versione-schema: 1`, `proprieta` predefinite (`Stato`, `Scadenza`, `Tag`) e 2 righe iniziali, e restituisce il blocco ```` ```vista ```` da inserire.

### `GET /v1/databases/:dbId`
Restituisce metadati, versione e schema `proprieta` del database identificato da `:dbId`.

### `POST /v1/databases/:dbId/schema-op`
Esegue un'operazione mirata sullo schema del database (`add_property`, `rename_property`, `change_type`, `set_options`, `rename_option`, `delete_option`, `set_default`, `set_decimals`, `reorder_properties`, `delete_property`, `restore_undefined_property`, `generate_options_from_values`). Supporta `dryRun: true` per restituire il conteggio delle pagine coinvolte prima della conferma.

### `POST /v1/databases/:dbId/rows`
Crea una nuova pagina-riga dentro il database applicando i valori `predefinito` dello schema e `creato: AAAA-MM-GG`.

### `POST /v1/views/query`
Esegue una query tabellare per un blocco `vista` (`database p_...`, `sottopagine`, `discendenti`, `tutte`), restituendo colonne effettive, righe con validazione tollerante e campi non definiti rilevati nelle righe.

### `POST /v1/pages/align-ids`
Allinea gli `id: p_...` mancanti nei frontmatter delle pagine Markdown e rileva eventuali `id` duplicati (supporta `dryRun: true` per anteprima e conferma esplicita).
