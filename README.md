# FLICO Performance Dashboard

Shows sales (cash, credit, hire purchase), stock and top items for the 13 showrooms.
Data comes from the MySQL database `eleacc_flico` using a **read-only** user.

## Run it (Windows, VS Code)

1. Install **Node.js LTS** from https://nodejs.org (one time).
2. Open this folder in VS Code. Open a terminal (Terminal > New Terminal).
3. Install the packages (one time):
   ```
   npm install
   ```
4. Copy `.env.example` to a new file named `.env`. Open it and set `DB_PASSWORD`
   to the password of the `dashboard` MySQL user you created.
5. Start:
   ```
   npm start
   ```
6. Open http://localhost:3000 in your browser. Stop with `Ctrl + C`.

## How it works

```
MySQL (read-only user)  ->  server.js (Node.js)  ->  public/index.html (charts)
```
- `server.js` runs the SQL queries and gives JSON at `/api/...`. The password stays here, never in the browser.
- Results are cached for 60 seconds (`CACHE_SECONDS`) so many viewers do not overload the database.
- The page refreshes itself every 60 seconds.

## Switching to the live server later

Only edit `.env` (`DB_HOST`, `DB_USER`, `DB_PASSWORD`). Ask IT for a **read-only (SELECT only)**
MySQL user, ideally on a read replica. No code change is needed.

## Which data is used

| Item | Tables |
|---|---|
| Sales | `t_cash_sales_sum`, `t_credit_sales_sum`, `t_hp_sales_sum` (cancelled bills removed) |
| Top items | `t_cash_sales_det`, `t_credit_sales_det`, `t_hp_sales_det`, `m_item` |
| Stock | `m_item_batch_stock` (qty x purchase price) |
| Branches | `m_branch` (showrooms = group `C3`, test branches in `EXCLUDE_BRANCHES` hidden) |

Future-dated rows are ignored. If you restore a backup, "Latest sales data" at the top shows how old the data is.

## Problems?

- `ECONNREFUSED`: MySQL is not running, or `DB_HOST` / `DB_PORT` is wrong.
- `Access denied`: wrong `DB_USER` / `DB_PASSWORD` in `.env`.
- `Unknown database`: check `DB_NAME`.
- Page shows an error banner: read the message, and look at the terminal where `npm start` runs.

## Security

- Use a read-only user only. Never put the root password in `.env`.
- Do not share `.env`. Do not show customer or user tables on the dashboard.
- The server listens on `127.0.0.1` (this computer only). To let others on the network open it,
  set `HOST=0.0.0.0` only after IT approves, and add a login first.

## Company Analysis page

Button **Company Analysis** (top right of the dashboard) opens `/analysis.html`.
It shows: same-months comparison with last year (positive / negative verdict), monthly sales (head office vs showrooms),
returns, categories, showrooms, and stock health (dead stock, fast sellers with low stock).
Everything is calculated from the same MySQL database that the daily backup fills, so no Excel / CSV export is needed.
It refreshes itself when a new backup is imported (or press **Refresh** on that page).

Files: `analysis-core.js` (calculations), `analysis.js` (SQL + API), `public/analysis.html` (page).

Optional `.env` settings (only if the page shows empty categories or no returns):

```
ANALYSIS_MONTHS=36
ANALYSIS_CACHE_MINUTES=15
ANALYSIS_CATEGORY_COLUMN=main_category
ANALYSIS_RETURN_TABLES=t_sales_return_sum:t_sales_return_det
```

Open `http://localhost:3000/api/analysis/schema` to see which category column and return tables were found.
