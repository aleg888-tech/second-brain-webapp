# Contratto del Servizio Agente (Specifica Futura)

Questo documento definisce il contratto tecnico del servizio agente AI per **brain** quando verrà attivato.

---

## 1. Endpoint HTTP previsti (Porta 4311)

### `GET /health`
Verifica lo stato del servizio e del provider configurato.

**Risposta (200 OK)**:
```json
{
  "status": "ok",
  "provider": "ollama",
  "model": "qwen2.5:7b",
  "maxSteps": 12
}
```

---

### `POST /v1/agent/chat`
Endpoint di chat con streaming Server-Sent Events (SSE).
Richiede header di autenticazione: `Authorization: Bearer <token>` (lo stesso token di `.brain/local.json`).

**Richiesta (`AgentChatRequest` in `@brain/shared`)**:
```json
{
  "messages": [
    { "role": "user", "content": "Riepiloga la nota sui chilometri di corsa." }
  ]
}
```

**Flusso di eventi SSE (`AgentEvent` in `@brain/shared`)**:
- `event: text` con `data: {"type":"text","delta":"Sto leggendo la nota..."}`
- `event: tool_start` con `data: {"type":"tool_start","id":"call_1","name":"leggi_file","args":{"percorso":"domini/corsa/registro-km.csv"}}`
- `event: tool_result` con `data: {"type":"tool_result","id":"call_1","name":"leggi_file","ok":true,"summary":"Letto 120 byte","effect":{"action":"read","path":"domini/corsa/registro-km.csv"}}`
- `event: done` con `data: {"type":"done","steps":1,"reason":"complete"}`
- In caso di errore: `event: error` con `data: {"type":"error","message":"Messaggio errore"}`

---

## 2. Mappatura degli Strumenti sulle funzioni di `kb-core`

Tutti gli strumenti dell'agente utilizzano esclusivamente le API fornite da `@brain/kb-core`.
Nessun accesso diretto al disco o chiamate di sistema shell.

| Nome Strumento | Descrizione | Funzione `kb-core` sottostante |
|---|---|---|
| `elenca_cartella` | Elenca file e directory con filtri | `kb.tree(includeArchived)` |
| `leggi_file` | Legge il contenuto testuale di una nota | `kb.read(path)` |
| `cerca` | Ricerca testuale con anteprima | `kb.search(query, { limit, filter })` |
| `backlink` | Ritorna link entranti, uscenti e tag | `kb.linksOf(path)` |
| `crea_file` | Crea una nuova nota (con frontmatter) | `kb.create(path, content)` |
| `modifica_file` | Sostituzione mirata di testo univoco | `kb.read` + string replace + `kb.write` |
| `aggiungi_riga` | Aggiunge una riga in coda (log/csv) | `kb.read` (o `create`) + `kb.write` |
| `sposta` | Sposta o rinomina file o cartella | `kb.rename(from, to)` |
| `archivia` | Sposta in `_archivio/AAAA-MM-GG/` | `kb.archive(path)` |

---

## 3. Limiti e Regole di Sicurezza

1. **Massimo 12 passi per turno**: se il modello esegue 12 chiamate di tool consecutive senza fermarsi, il ciclo termina con `reason: "max_steps"`.
2. **Troncamento output**: l'output di ogni strumento restituito al modello è troncato a massimo 8.000 caratteri per non saturare la finestra di contesto.
3. **agentDeny**: prima di eseguire qualsiasi strumento, viene verificato `kb.assertNotDenied(path)`. Se il percorso ricade in una cartella protetta da `agentDeny`, l'azione viene rifiutata con errore 403 immediato.
4. **MAI cancellare**: l'eliminazione fisica di file non è contemplata tra gli strumenti; è previsto esclusivamente `archivia`.
5. **Controllo concorrenza (409)**: `modifica_file` usa `baseVersion`; se il file è cambiato nel frattempo, la scrittura fallisce preservando i dati.
6. **Storico automatico**: ogni scrittura (`modifica_file`, `aggiungi_riga`, `ripristina`) genera uno snapshot nello storico locale in `.brain/history/`.

---

## 4. Esempio di configurazione provider (`providers.json`)

Il servizio futuro potrà gestire fallback e modelli locali tramite un file di configurazione, ad esempio:

```json
{
  "active": "locale",
  "providers": {
    "locale": {
      "type": "openai-compatible",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "model": "qwen2.5:7b",
      "apiKey": ""
    },
    "fallback-cloud": {
      "type": "openai-compatible",
      "baseUrl": "https://openrouter.ai/api/v1",
      "model": "anthropic/claude-3.5-sonnet",
      "apiKey": "${OPENROUTER_API_KEY}"
    }
  }
}
```
