# Deploy su Cloudflare Pages

Questa guida spiega come configurare Cloudflare Pages per effettuare il build e l'hosting dell'interfaccia web di `second-brain` dal monorepo, evitando che modifiche ai soli contenuti in `kb/` inneschino ricostruzioni superflue del sito.

---

## 1. Connessione del Repository

1. Nella dashboard di Cloudflare, vai in **Compute (Workers & Pages)** > **Pages** > **Connect to Git**.
2. Seleziona il repository GitHub `second-brain`.
3. Scegli il branch di produzione (es. `main`).

---

## 2. Parametri di Build

Imposta i parametri come segue:

- **Framework preset**: `Vite` (oppure `None`)
- **Root directory**: `webapp` *(FONDAMENTALE: permette a Cloudflare di considerare solo i commit che toccano `webapp/`)*
- **Build command**: `npm run build:web`
- **Build output directory**: `web/dist`

---

## 3. Variabili d'Ambiente (Environment Variables)

Aggiungi la seguente variabile di produzione per Node:
- `NODE_VERSION`: `20.12.0` (o coerente con `.node-version`)

---

## 4. Regola di Skip Build per Modifiche a kb/

Grazie all'impostazione di **Root directory** su `webapp`:
- Cloudflare Pages valuta le modifiche relative alla directory `webapp`.
- Eventuali commit con prefisso `kb:` che modificano esclusivamente note e file sotto `kb/` non avvieranno un nuovo ciclo di compilazione dell'interfaccia, risparmiando minuti di build e preservando i deploy.

---

## 5. Nota: Alternativa Privata a GitHub Pages

> [!TIP]
> A differenza di GitHub Pages (che sul piano gratuito richiede un repository pubblico separato per ospitare i file compilati), **Cloudflare Pages supporta repository GitHub privati anche sul piano gratuito**.
> 
> Se desideri mantenere l'intero progetto in un unico repository privato senza mai pubblicare codice o build in chiaro su GitHub, Cloudflare Pages è la soluzione architetturale raccomandata.

