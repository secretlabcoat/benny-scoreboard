# benny-scoreboard

Tiny no-dependency Node server for the Benny and the Jets Top 20.

- `GET /health` – warm-up ping (Render free plan sleeps after 15 min idle).
- `GET /scores` – `{ ok, week, epoch, scores }` Top 20 for **this week**, same entry shape as the game (`id,n,s,j,t,d,b,p,c,cc,k`).
- `GET /scores?week=ID` – a past week's Top 20 (read-only archive, last 104 weeks).

### Weekly board
The board follows the game's weekly layout seed: a new week starts **Sunday 00:00 America/Toronto** and the board starts empty.
`week` is the game's `weekIdToronto()` (day number of that Sunday). At rollover the old rows move to `weeks[ID]` in the
server doc (kept, not deleted) and `epoch` becomes the week start, so the game's textdb fallback docs also reset.
`POST /scores` may carry `w` (the week whose layout the run used); if it isn't the current week the server answers
`409 { error: "week over" }`, so a phone still on last week's layout can't post into the new week.
- `POST /scores` – one entry; validated with the game's `plausible()` rule, name cleaning, rude-name filter.
  One best per name, at most 6 names per connection (`k` = salted hash of the caller IP, computed here).
- `POST /admin/reset`, `POST /admin/remove` – need header `x-admin-secret` = `ADMIN_SECRET` env var.

Durability: the board lives in memory and is saved (debounced, ~1 s) to a private textdb.dev doc
(`SRV_DOC`, top 100) and to the game's v2 main doc (top 20). On boot it reloads and unions the server doc,
the v2 main/mirror/slot docs and the legacy v1 docs (valid rows only, newer than the last reset epoch),
so sleeps/restarts/redeploys keep the board. It also re-pulls the v2 docs every 3 min while awake so
scores saved by the game's textdb fallback path get absorbed.
