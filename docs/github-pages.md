# Pubblicazione su GitHub Pages

Questa guida illustra la strategia di deployment della webapp su **GitHub Pages** tramite un repository pubblico separato.

---

## 1. Perché un Repository Separato?

Sul piano gratuito di GitHub, la funzionalità **GitHub Pages** è disponibile unicamente per i repository **pubblici**.

Il nostro repository principale (`second-brain`) contiene:
- Tutto il codice sorgente dell'applicazione (`webapp/`).
- La Knowledge Base personale (`kb/`), con note, registri e dati privati.

Per garantire la **totale riservatezza dei dati personali**:
- Il repository principale rimane **privato**.
- Viene creato un secondo repository dedicato e **pubblico** (`second-brain-webapp`), contenente **esclusivamente i file statici compilati** (`dist/`: HTML, JS, CSS, icone).
- Nessun file Markdown (`.md`), foglio di calcolo (`.csv`), configurazione locale (`.brain/`) o file d'ambiente (`.env`) viene mai pubblicato nel repository del sito.

---

## 2. Configurazione e Primo Avvio

### A. Clonazione del Repository Pubblico
Clona il repository pubblico come cartella gemella a `brain`:

```bash
# Posizionati nella cartella contenitore (Desktop/Nuova cartella)
cd "C:\Users\Scuola\Desktop\Nuova cartella"

# Clona il repository pubblico
git clone https://github.com/aleg888-tech/second-brain-webapp.git
# oppure tramite SSH:
# git clone git@github.com:aleg888-tech/second-brain-webapp.git
```

### B. Deployment
Dalla cartella `webapp/`:

```bash
# 1. Prova a secco (compila, adatta per Pages e verifica la sicurezza senza fare push)
npm run deploy:pages:dry

# 2. Deploy effettivo (compila, aggiorna la cartella gemella, committa e fa push)
npm run deploy:pages
```

### C. Attivazione di Pages su GitHub
1. Vai su GitHub nel repository `second-brain-webapp`.
2. Apri **Settings** > **Pages**.
3. Sotto **Build and deployment**:
   - **Source**: `Deploy from a branch`
   - **Branch**: `main`, cartella `/ (root)`
4. Clicca su **Save**.
5. Il sito sarà attivo dopo circa 1-2 minuti all'indirizzo:
   `https://aleg888-tech.github.io/second-brain-webapp/`

---

## 3. Adattamenti Specifici per GitHub Pages

Lo script `deploy:pages` applica automaticamente:
1. **Base URL relativa (`./`)**: consente all'applicazione di risolvere correttamente script e fogli di stile anche quando viene servita da una sottocartella (`/second-brain-webapp/`).
2. **File `.nojekyll`**: impedisce a GitHub Pages di elaborare l'output con Jekyll (che scarterebbe file e cartelle che iniziano con underscore).
3. **Fallback SPA (`404.html`)**: copia di `index.html` che garantisce la corretta gestione del routing client-side (SPA) quando l'utente ricarica una pagina annidata.
4. **Content Security Policy (CSP)**: inserita come tag `<meta http-equiv="Content-Security-Policy">` nell'intestazione HTML per proteggere l'ambiente di esecuzione:
   - `default-src 'self'`
   - `connect-src 'self' https://api.github.com http://127.0.0.1:* http://localhost:*`
   - `img-src 'self' data: blob: https:`
   - `meta name="referrer" content="no-referrer"`

---

## 4. Limiti Architetturali di GitHub Pages

> [!WARNING]
> GitHub Pages è un hosting puramente statico e non consente di inviare intestazioni HTTP personalizzate dal server (i file `_headers` e `_redirects` non sono interpretati).

Di conseguenza:
- **`frame-ancestors` e `X-Frame-Options`**: non possono essere configurati tramite `<meta>` (lo standard W3C CSP richiede che siano inviati via header HTTP). L'app non può impedire l'incorporamento in iframe via header su Pages.
- **HSTS (`Strict-Transport-Security`) e `X-Content-Type-Options: nosniff`**: sono gestiti unicamente dai default della CDN di GitHub.
- **Nessun Backend Node.js**: l'app gira interamente nel browser del client (comunicando con GitHub tramite API e Personal Access Token o con l'istanza locale `127.0.0.1`).

---

## 5. Come Aggiornare o Annullare (Rollback)

- **Aggiornamento**: esegui semplicemente `npm run deploy:pages` ogni volta che rilasci una nuova versione del codice.
- **Rollback (Annullamento)**: entra nella cartella gemella `../second-brain-webapp`, usa `git revert HEAD` o `git checkout <commit-precedente> -- .` e pusha con `git push`.
