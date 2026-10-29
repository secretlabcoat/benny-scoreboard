# benny-scoreboard

Tiny no-dependency Node server for the Benny and the Jets Top 20.

- `GET /health` – warm-up ping (Render free plan sleeps after 15 min idle).
- `GET /scores` – `{ ok, epoch, scores }` Top 20, same entry shape as the game (`id,n,s,j,t,d,b,p,c,cc,k`).
- `POST /scores` – one entry; validated with the game's `plausible()` rule, name cleaning, rude-name filter.
  One best per name, at most 3 names per connection (`k` = salted hash of the caller IP, computed here).
- `POST /admin/reset`, `POST /admin/remove` – need header `x-admin-secret` = `ADMIN_SECRET` env var.

Durability: the board lives in memory and is saved (debounced, ~1 s) to a private textdb.dev doc
(`SRV_DOC`, top 100) and to the game's v2 main doc (top 20). On boot it reloads and unions the server doc,
the v2 main/mirror/slot docs and the legacy v1 docs (valid rows only, newer than the last reset epoch),
so sleeps/restarts/redeploys keep the board. It also re-pulls the v2 docs every 3 min while awake so
scores saved by the game's textdb fallback path get absorbed.
