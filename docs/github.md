# Configurazione GitHub & Personal Access Token (PAT)

Questa guida spiega come configurare un Personal Access Token (PAT) con privilegi minimi per consentire all'applicazione di sincronizzare la Knowledge Base su GitHub in sicurezza.

---

## 1. Generazione del Token con Privilegi Minimi

Per proteggere il codice sorgente presente nel repository, si consiglia l'uso di un **Fine-Grained Personal Access Token**:

1. Su GitHub, vai in **Settings** > **Developer Settings** > **Personal access tokens** > **Fine-grained tokens**.
2. Clicca su **Generate new token**.
3. Compila le informazioni:
   - **Token name**: `second-brain-app`
   - **Expiration**: 30 o 90 giorni (a rotazione consigliata)
   - **Resource owner**: il tuo account GitHub
   - **Repository access**: seleziona **Only select repositories** e scegli esclusivamente `second-brain`.
4. Nei **Permissions**:
   - **Repository permissions**:
     - `Contents`: **Read and Write** (necessario per leggere e committare i file sotto `kb/`).
     - `Metadata`: **Read-only** (assegnato automaticamente).
   - Tutte le altre voci devono essere impostate su **No access**.
5. Clicca su **Generate token** e copia il valore generato.

---

## 2. Configurazione del Profilo nell'App

Nell'applicazione o nel file di configurazione, il profilo di sincronizzazione GitHub assume la seguente forma:

```json
{
  "nome": "GitHub Personale",
  "owner": "aleg888-tech",
  "repo": "second-brain",
  "branch": "main",
  "percorsoKb": "kb"
}
```

---

## 3. Garanzie di Sicurezza nel Monorepo

Anche se il token ha accesso all'intero repository, `GithubBackend` include protezioni a livello di codice:
- **Guardrail applicativo**: qualunque operazione di creazione, scrittura, rinomina o eliminazione indirizzata al di fuori di `kb/` (es. su `webapp/` o `.github/`) viene bloccata immediatamente con un errore `403 Forbidden`.
- **Commit identificabili**: tutti i commit generati dall'app sono prefissati con `kb: <descrizione>`.
- **Rilevamento conflitti isolato**: il check dei conflitti remoti confronta unicamente lo SHA dell'albero `kb/`. Modifiche al codice in `webapp/` pushate da altre postazioni non provocheranno falsi conflitti di sincronizzazione delle note.
