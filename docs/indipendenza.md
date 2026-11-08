# Matrice di Indipendenza dei Livelli

Il sistema **brain** è progettato con una separazione netta tra i componenti, ciascuno con contratti espliciti e confini rigidi.

---

## 1. Matrice delle Dipendenze

| Livello | Percorso | Dipende da | NON può dipendere da | Stato attuale |
|---|---|---|---|---|
| **Knowledge Base** | `kb/` | *Nessuno* (è solo markdown/csv/txt, repo git separato) | `api`, `web`, `kb-core`, codice eseguibile | **Attivo** (indipendente) |
| **Tipi Condivisi** | `shared/` | *Nessuno* (solo interfacce e tipi TypeScript puri) | codice a runtime, node, dom | **Attivo** (contratto puro) |
| **Logica KB** | `packages/kb-core/` | `shared/`, Node standard (`fs`, `crypto`) | `api`, `web`, framework web | **Attivo** (libreria riutilizzabile) |
| **API Server** | `api/` | `shared/`, `packages/kb-core/`, `hono` | `web/`, internet, SDK esterni AI | **Attivo** (porta 4310) |
| **Interfaccia Web** | `web/` | `shared/`, `react`, `codemirror`, `marked` | `fs`, `api/src/*`, disco locale | **Attivo** (porta 5173) |
| **Servizio Agente AI** | `agent/` | `shared/`, `packages/kb-core/` | `web/`, `api/` | **Previsto, non ancora attivo** (porta 4311) |

---

## 2. Principi Chiave di Disaccoppiamento

1. **La Knowledge Base è sovrana**:
   - `kb/` è un repository Git a sé stante;
   - Può essere spostata o sincronizzata separatamente senza codice dell'applicazione;
   - Non contiene file generati dall'applicazione o metadati di vista (`.brain/` vive fuori da `kb/`).

2. **`kb-core` è l'unico custode delle regole del file system**:
   - Gestisce la sandbox dei percorsi (nessun traversal, nessun carattere vietato);
   - Esegue il controllo di concorrenza ottimistica tramite hash SHA-256 (`baseVersion`);
   - Mantiene lo storico automatico delle versioni in `.brain/history/`;
   - Gestisce l'indice in-memory di wikilink e tag;
   - Applica la protezione `agentDeny`.

3. **L'API non parla con l'esterno**:
   - Ascolta esclusivamente su `127.0.0.1:4310`;
   - Non effettua alcuna richiesta di rete verso Internet;
   - Protegge l'accesso tramite Host header, Origin validation e token casuale stampato all'avvio.

4. **L'Interfaccia Web è un client puro**:
   - Parla esclusivamente con l'API via HTTP;
   - Non tocca mai il file system né conserva chiavi;
   - Pulisce immediatamente il token dall'hash dell'URL (`history.replaceState`);
   - Il pannello chat è predisposto graficamente ma disattivato ("AI non ancora attivata"), senza traffico di rete.

5. **L'AI è isolabile**:
   - L'applicazione funziona al 100% delle sue capacità di navigazione, editing, ricerca, wikilink e storico anche in totale assenza del servizio AI.
   - Per abilitare l'AI in futuro basterà avviare il servizio `agent/` e inserire il suo URL in `.brain/config.json`.
