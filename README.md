# 💸 Expense Tracker

A private, **static** expense tracker that runs entirely in your browser — no
server, no database, nothing to host but plain files. It can:

- **Import credit-card transactions from Gmail** — reads the statement PDFs
  the banks email you, parses the transactions out of them, and lets you
  **review and edit** every row before saving.
- **Add other expenses by hand** (cash, transfers, anything not on a card).
- Track spend in **multiple currencies** (e.g. AED + INR) and roll everything
  up into one **base currency** you choose.
- Show a **dashboard**: spend by month, category, card, and currency.

All your data stays in **your browser** (IndexedDB / localStorage). Gmail is
read with **read-only** access directly from the browser — nothing is sent to
any third-party server.

---

## Quick start (run locally)

Because the app uses JavaScript modules, open it through a tiny local web
server rather than double-clicking the file:

```bash
cd expense-tracker
python3 -m http.server 8000
# then open http://localhost:8000
```

You can start adding expenses by hand immediately. Gmail import needs the
one-time setup below.

---

## Deploy to GitHub Pages

1. Push this repository to GitHub.
2. Repo **Settings → Pages**.
3. Under **Build and deployment**, set **Source = Deploy from a branch**,
   pick your branch, folder **`/ (root)`**, and Save.
4. After a minute your app is live at
   `https://<your-username>.github.io/<repo-name>/`.

The included `.nojekyll` file makes sure GitHub serves the `vendor/` and
`assets/` files unchanged.

---

## One-time Gmail setup (for statement import)

A static site can read Gmail directly from your browser using Google's
sign-in, but Google requires you to register the app once and get a **Client
ID**. It's free.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and
   create a project (any name).
2. **APIs & Services → Library →** search **Gmail API →** **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type **External**, fill the required app name + your email.
   - **Scopes:** add `.../auth/gmail.readonly`.
   - **Test users:** add your own Gmail address.
   - You can leave the app in **Testing** — no Google verification needed for
     personal use.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**.
   - **Authorized JavaScript origins** — add the exact origin(s) you'll open
     the app from, e.g.
     - `http://localhost:8000`
     - `https://<your-username>.github.io`
   - Create, then copy the **Client ID** (ends in
     `.apps.googleusercontent.com`).
5. Open the app → **Settings → Gmail connection** → paste the Client ID →
   **Save settings**.
6. Go to **Import from Gmail → Connect Gmail**, approve read-only access, then
   **Fetch & parse**.

> Statement PDFs from banks are password-protected. Put each bank's PDF
> password in **Settings → Statement PDF passwords** (stored only in your
> browser). For example, ADCB uses your **Customer ID**.

---

## How importing works

1. You pick which banks to pull statements from and a look-back window.
2. The app searches Gmail for matching emails, downloads statement PDFs,
   decrypts them with your saved password, and extracts the transaction rows.
3. Every parsed transaction is shown in an **editable review table**. You
   tick the ones to keep, fix anything the parser got wrong, then **Save
   selected**. Nothing is stored until you confirm.
4. Re-running import later automatically **skips transactions already
   imported** (deduplicated by date + amount + merchant + card).

### Supported sources (in `assets/js/config.js`)

| Bank | Sender | Currency | On by default |
|------|--------|----------|---------------|
| ADCB Credit Card | `estatement@adcb.com` | AED | ✅ |
| Axis Credit Card | `cc.statements@axis.bank.in` | INR | ✅ |
| FAB Credit Card | `estatement@bankfab.com` | AED | ✅ |
| Axis Bank A/c Statement | `statements@axis.bank.in` | INR | — |
| HDFC SmartStatement | `hdfcbanksmartstatement@hdfcbank.bank.in` | INR | — |
| Emirates NBD A/c | `statement@emiratesnbd.com` | AED | — |
| Bank of India | `noreply-estatement@alerts.bankofindia.bank.in` | INR | — |

Credit-card statements are enabled by default; **bank-account** statements are
off by default so account debits don't double-count spend you already see on a
card — tick them on in the Import screen if you want them.

Every source is a **statement PDF** — the app does not read individual
per-transaction alert emails.

**Emails that skip the inbox are still imported.** The search matches by the
bank's `from:` address and covers archived/labelled mail (everything except
Spam/Trash), so statements a Gmail filter auto-labels and archives are picked
up like any other. The one case that is *not* covered is a statement
**forwarded from a person's own email** — then the sender is that person, not
the bank, so add their address (or the bank's) to `SOURCES`.

**Wio** credit statements can't be imported — those emails just link to the Wio
app and carry no PDF. Add Wio spend via manual entry.

Parsing bank statements from PDF text is inherently fuzzy (layouts differ),
which is exactly why the review step exists. To add or tune a bank, edit
`SOURCES` in `config.js` and the matching parser in `assets/js/parsers.js`.

---

## Project layout

```
index.html                 App shell
assets/css/styles.css      Styles (light/dark aware)
assets/js/
  app.js                   UI controller + views + routing
  config.js                Defaults: currencies, categories, bank sources
  db.js                    IndexedDB storage + settings
  currency.js              FX conversion + amount parsing
  gmail.js                 Google sign-in + Gmail read-only API
  pdf.js                   PDF text extraction (wraps pdf.js)
  parsers.js               Statement PDF parsers → transactions
  dashboard.js             Aggregations + charts
vendor/pdfjs/              Bundled pdf.js (no CDN needed)
```

## Privacy

- Expenses and settings never leave your browser.
- Gmail access is **read-only** (`gmail.readonly`) and happens directly
  between your browser and Google.
- PDF passwords are stored in `localStorage` on your device only. Use the
  JSON export in **Settings → Data** to back up or move between browsers.
