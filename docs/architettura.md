# Architettura di brain

## 1. Visione d'Insieme
Il sistema personale di conoscenza **brain** è suddiviso in componenti modulari rigidamente disaccoppiati:

```
[ Browser: web (5173) ]
          │  HTTP + Bearer Token
          ▼
[ Server: api (4310) ]
          │  invoca direttamente
          ▼
[ Libreria: @brain/kb-core ]
     ├── Sandbox percorsi & FsStorage
     ├── Version Control (SHA-256)
     ├── Storico (.brain/history/)
     └── Indice in-memory (wikilink & tag)
          │  opera su disco
          ▼
[ Knowledge Base: kb/ ]  (Git repo indipendente)
```

---

## 2. Modello di Sicurezza
1. **Rete e Ascolto**:
   - L'API si lega esclusivamente all'interfaccia di loopback `127.0.0.1` sulla porta `4310`.
   - L'interfaccia Vite si lega su `127.0.0.1:5173`.
2. **Protezione Cross-Origin e Host Header Injection**:
   - Qualsiasi richiesta con header `Host` diverso da `127.0.0.1` o `localhost` viene respinta con HTTP 403 Forbidden.
   - Le richieste con header `Origin` estraneo vengono respinte con 403.
   - Nessun CORS aperto (`*` vietato): le intestazioni CORS consentono solo le origini esatte di `web`.
3. **Autenticazione con Token Casuale**:
   - A ogni avvio l'API genera un token crittografico di 32 byte (`crypto.randomBytes(32)`).
   - Il token viene salvato in `.brain/local.json` (ignorato da git).
   - L'API stampa `http://127.0.0.1:5173/#token=...`.
   - Il browser legge il token dal fragment `#token=...`, lo salva in `sessionStorage` e ripulisce subito la cronologia con `window.history.replaceState`.
4. **Sandbox del File System (`packages/kb-core`)**:
   - I percorsi sono normalizzati con `/` come separatore.
   - Rifiuto categorico di: `..`, `.`, stringhe vuote, percorsi assoluti, backslash di Windows, percent-encoding (`%2e%2e`), caratteri illegali Windows (`< > : " | ? *`), nomi riservati Windows (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`) e file/cartelle nascoste `.git`.
   - Risoluzione fisica con `fs.realpath`: symlink o junction che fuoriescono dalla directory radice vengono bloccati.

---

## 3. Gestione della Concorrenza e Versioning
- Per ogni file viene calcolato un hash SHA-256 a 16 caratteri del contenuto (`version`).
- Durante il salvataggio (`POST /v1/files/content`), il client invia `baseVersion`.
- Se il file su disco è stato modificato (l'hash non coincide), la richiesta fallisce con **HTTP 409 Conflict**, restituendo i metadati e il contenuto corrente del file su disco.
- Prima di ogni modifica o ripristino, `packages/kb-core` salva automaticamente la versione precedente in `.brain/history/<percorso>/<timestamp>`, conservando le ultime 20 versioni per file.

---

## 4. Rilevamento Modifiche Esterne
- L'API calcola una firma lightweight dell'albero (`signature`) combinando percorsi, dimensioni e `mtime`.
- Il client web interroga l'endpoint `GET /v1/status` ogni 2 secondi.
- Se la firma cambia, l'interfaccia aggiorna l'albero e i tag.
- Se la nota attualmente in visualizzazione è stata alterata su disco:
  - Se non ci sono modifiche pendenti non salvate nel tab, la scheda si aggiorna automaticamente.
  - Se ci sono modifiche non salvate, compare un banner di avviso che permette all'utente di ricaricare o decidere come procedere.

---

## 5. Moduli Puri di `@brain/kb-core` (Zero `node:*`) e Viste a Tabella
Tutta la logica di dominio per proprietà tipizzate, schemi di database, blocchi ```` ```vista ```` e interrogazione tabellare risiede in moduli puri di `packages/kb-core` privi di dipendenze `node:*`, così da funzionare in modo identico sia su `FsBackend` (disco locale) sia su `GithubBackend` (API GitHub Contents/Trees):

1. **`schema.ts`**:
   - Definisce e valida i 12 tipi di proprietà (`testo`, `numero`, `seleziona`, `selezione-multipla`, `stato`, `data`, `casella`, `url`, `email`, `telefono`, `creato`, `modificato`), la palette a 9 colori e i 3 gruppi di stato (`da-fare`, `in-corso`, `completato`).
   - Genera chiavi slug immutabili, protegge le chiavi riservate, impone `tag` come `selezione-multipla` e applica la **lettura tollerante** (valori fuori schema o non validi vengono segnalati con avviso senza mai essere alterati o cancellati).
   - Implementa le operazioni pure sullo schema (`addPropertyToSchema`, `renamePropertyInSchema`, `changePropertyTypeInSchema`, `updatePropertyOptionsInSchema`, `deletePropertyFromSchema`, `restoreUndefinedPropertyToSchema`, ecc.).
2. **`vista-block.ts`**:
   - Esegue il parsing e la serializzazione YAML dei blocchi ```` ```vista ```` e supporta la retrocompatibilità con `![[page:p_...]]`.
3. **`table-engine.ts`**:
   - Risolve lo schema effettivo con precedenza `proprieta del blocco vista > schema database > inferenza dal valore`, rileva i campi presenti nelle righe ma non definiti nello schema (`undefinedFields`), applica i 10 operatori di filtro in `AND` e l'ordinamento multi-colonna stabile (valori vuoti sempre in fondo).
4. **`frontmatter-index.ts`**:
   - Mantiene un indice in memoria dei frontmatter e del grafo dei link aggiornabile incrementalmente a ogni scrittura di singola pagina, permettendo query su `1000` pagine in pochi millisecondi senza rileggere tutti i file.
5. **PATCH Mirata del Frontmatter (`frontmatter.ts`)**:
   - Ogni modifica di cella o proprietà aggiorna esclusivamente il singolo nodo AST YAML (`parseDocument` di `yaml`), preservando byte per byte ordine delle chiavi, commenti YAML, virgolette, fine riga (`LF`/`CRLF`) e corpo Markdown.
