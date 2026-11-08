# Servizio Agente AI (Predisposto — Non ancora attivo)

Questa cartella è riservata al futuro servizio di intelligenza artificiale per **brain**.
Attualmente è solo **predisposta**: non contiene codice di client LLM, cicli di tool-calling, file `.env` né chiamate a modelli esterni.

---

## 1. Architettura e Ruolo
Quando verrà implementato, l'agente sarà un **servizio HTTP/SSE autonomo e indipendente**:
- **Porta di ascolto prevista**: `127.0.0.1:4311`.
- **Nessuna dipendenza diretta dall'interfaccia web**: l'interfaccia comunica con l'agente solo tramite l'indirizzo configurato in `.brain/config.json` (`agentUrl`).
- **Nessuna alterazione del server API principale (`api/`)**: l'API file (`4310`) e l'agente (`4311`) restano processi separati.
- **Accesso alla Knowledge Base**: l'agente importerà direttamente `@brain/kb-core` e ne userà i metodi (`read`, `write`, `search`, `archive`, `historyList`...) come funzioni sottostanti per gli strumenti, garantendo le medesime garanzie di sandboxing, controllo versioni (409) e rispetto di `agentDeny`.

---

## 2. Regole di Dipendenza e Confini
```
┌──────────────┐         HTTP / SSE         ┌──────────────┐
│  web (5173)  ├───────────────────────────►│ agent (4311) │  (futuro)
└──────┬───────┘                            └──────┬───────┘
       │ HTTP                                      │
       ▼                                           ▼
┌──────────────┐                            ┌──────────────┐
│  api (4310)  │                            │   kb-core    │  (libreria condivisa)
└──────┬───────┘                            └──────┬───────┘
       │                                           │
       └───────────────────┬───────────────────────┘
                           ▼
                  ┌─────────────────┐
                  │   kb/ (file)    │
                  └─────────────────┘
```

- **Dipendenze permesse per `agent/`**: `@brain/shared` (tipi) e `@brain/kb-core` (logica KB).
- **Dipendenze vietate**: l'agente non importa nulla da `web/` né da `api/`.
- **Sicurezza e Token**: l'agente utilizzerà lo stesso token locale generato in `.brain/local.json` per autenticare le richieste provenienti dal browser autorizzato.
- **Stato effimero**: l'agente non manterrà cronologie di chat o memoria su disco; ogni richiesta riceve la cronologia necessaria dal client e il server risponde in streaming.

---

## 3. Come avviare l'agente (in futuro)
1. Implementare il servizio in questa cartella (`agent/src/server.ts`).
2. Configurare `agentUrl: "http://127.0.0.1:4311"` in `.brain/config.json`.
3. Avviare il processo agente sulla porta 4311.
4. L'interfaccia rileverà automaticamente `agentUrl` e abiliterà la chat.
