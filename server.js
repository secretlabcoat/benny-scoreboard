"use strict";
// Benny and the Jets – Top 20 scoreboard server (no dependencies, Node 18+).
// Phones send ONE new score; the server merges it. A phone can never rewrite or wipe the whole list.
const http = require("http");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 10000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const TEXTDB = "https://textdb.dev/api/data/";
// Server's own backup doc (top 100 + reset epoch + removed ids). Only this server writes it.
const SRV_DOC = TEXTDB + (process.env.SRV_DOC_ID || "d459d861-2eca-4272-8d06-7a9d990d50b2");
// Game's v2 docs: the server writes main (top 20) so the game's textdb fallback still sees the board;
// it reads main + mirror + slots (+ legacy v1) to absorb scores saved while the server was unreachable.
const V2_MAIN = TEXTDB + (process.env.V2_MAIN_ID || "5916151d-6c37-4a28-91c9-89eaac19c885");
const V2_MIRROR = "https://textdb.online/benny-jets-v2-e84ce8586d7ab46cffce";
const V2_SLOTS = ["0e338981-5fab-4155-a8bf-b2021463ce2b", "e7f90a91-88a9-4205-b561-6ee3986e801e",
  "5a726bae-ae7e-4687-86bb-3cd267aa6ad1", "a9718c15-facc-413e-9253-0ac952ed02f7"].map((u) => TEXTDB + u);
const V1_DOCS = [TEXTDB + "a83a65d3-c3a9-4e5f-8c71-636b8586721e", "https://textdb.online/benny-jets-8dede63c834ea2388388ce9c"];
const LB_GAME = "benny-and-the-jets";
const LB_SIZE = 20, KEEP = 100, NAME_MAX = 12, FP_MAX = 3, CITY_MAX = 24;
const IP_SALT = "benny-jets-ipgate-v1-4a33d2f56891269ef972b04914124ce9";   // same hobby salt as the game, so k matches
const ALLOWED_ORIGINS = ["https://4nqyxkp.sharehtml.org", "https://oddobiography.itch.io", "https://html.itch.zone", "https://html-classic.itch.zone"];

// ---------- validation: copied from site-app.tsx (keep in sync) ----------
const BAD_WORDS = ["fuck", "shit", "cunt", "nigg", "fag", "bitch", "whore", "slut", "rape", "nazi", "hitler", "kike", "spic", "chink", "retard", "dick", "cock", "pussy", "penis", "vagina", "porn", "twat", "wank", "asshole", "bastard", "kkk"];
const BAD_EXTRA = ["cum", "kum", "baggio"];
const ALLOW = ["cucumber", "encumber", "accum", "circum", "document", "cumul", "succumb", "incumb", "cumin", "talcum", "scum", "kumar", "kumquat", "kumbaya"];
function deLeet(s) {
  return s.toLowerCase().replace(/[0@]/g, "o").replace(/[1!|]/g, "i").replace(/3/g, "e").replace(/[4]/g, "a").replace(/[5$]/g, "s").replace(/7/g, "t").replace(/[^a-z]/g, "");
}
function isRude(name) {
  const low = String(name || "").toLowerCase();
  const forms = [deLeet(low), deLeet(low.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[*vµ]/g, "u"))];
  return forms.some((k0) => {
    let k = k0; for (const a of ALLOW) k = k.split(a).join("_");
    return BAD_WORDS.some((w) => k0.includes(w)) || BAD_EXTRA.some((w) => k.includes(w));
  });
}
function cleanName(raw) {
  let s = String(raw || "");
  try { s = s.normalize("NFKC"); } catch { /* */ }
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff0-\uffff]/g, "");
  s = s.replace(/[<>`"\\]/g, "").replace(/\s+/g, " ").trim();
  return Array.from(s).slice(0, NAME_MAX).join("").trim();
}
// score = floor(time*5) + bonus − penalties (exact copy of the game's rule)
function plausible(s, j, t, b = 0, pen = 0) {
  if (![s, j, t, b, pen].every((v) => Number.isFinite(v) && v >= 0)) return false;
  if (t > 7200 || s > 500000 || j > t * 4 + 3) return false;
  if (b % 25 !== 0 || b > Math.floor(t * 110) + 800) return false;
  if (pen > Math.floor(t * 25) + 500) return false;
  return Math.abs(s - (Math.floor(t * 5) + b - pen)) <= 2;
}
const STINK_CITY = "Stinktown", STINK_CC = "XX";
function cleanCity(raw) {
  let s = String(raw ?? "");
  try { s = s.normalize("NFKC"); } catch { /* */ }
  s = s.replace(/[^\p{L}\p{M}\p{N} .,'\-()]/gu, "").replace(/\s+/g, " ").trim();
  s = Array.from(s).slice(0, CITY_MAX).join("").trim();
  if (s === STINK_CITY) return s;
  return s && !isRude(s) ? s : "";
}
function cleanCC(raw) { const c = String(raw ?? "").toUpperCase(); return /^[A-Z]{2}$/.test(c) ? c : ""; }
function validEntry(e) {
  if (!e || typeof e !== "object") return null;
  const o = e;
  const n = cleanName(String(o.n ?? "")), s = Math.floor(Number(o.s)), j = Math.floor(Number(o.j)), t = Math.round(Number(o.t) * 10) / 10;
  const id = String(o.id ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 16), d = Math.floor(Number(o.d)) || 0;
  const b = o.b === undefined || o.b === null ? 0 : Math.floor(Number(o.b));
  const pen = o.p === undefined || o.p === null ? 0 : Math.floor(Number(o.p));
  if (!n || !id || isRude(n) || !plausible(s, j, t, b, pen)) return null;
  let c = cleanCity(o.c), cc = cleanCC(o.cc);
  if (!c && !cc) { c = STINK_CITY; cc = STINK_CC; }   // every entry has a place (game's ensurePlace)
  const kRaw = String(o.k ?? "").toLowerCase();
  const k = /^[0-9a-f]{16}$/.test(kRaw) ? kRaw : "";
  return { id, n, s, j, t, d, ...(b > 0 ? { b } : {}), ...(pen > 0 ? { p: pen } : {}), ...(c ? { c } : {}), ...(cc ? { cc } : {}), ...(k ? { k } : {}) };
}
// same ranking as the game: same id → stronger row; one best per name; ≤3 names per connection k
function rankBoard(list, size) {
  const byId = new Map();
  for (const e of list) {
    const prev = byId.get(e.id);
    if (!prev) { byId.set(e.id, { ...e }); continue; }
    const preferNew = e.s > prev.s || (e.s === prev.s && (e.d || 0) > (prev.d || 0));
    const base = preferNew ? e : prev, other = preferNew ? prev : e;
    const merged = { ...other, ...base };
    for (const k of Object.keys(other)) if (merged[k] === undefined) merged[k] = other[k];
    byId.set(e.id, merged);
  }
  const byName = new Map();
  for (const e of byId.values()) {
    const key = String(e.n || "").trim().toLowerCase();
    const prev = byName.get(key);
    if (!prev || e.s > prev.s || (e.s === prev.s && (e.d || 0) > (prev.d || 0))) byName.set(key, e);
  }
  const named = [...byName.values()].sort((a, b) => b.s - a.s || a.d - b.d);
  const fpCount = new Map(), out = [];
  for (const e of named) {
    const fk = typeof e.k === "string" && /^[0-9a-f]{16}$/i.test(e.k) ? e.k.toLowerCase() : "";
    if (fk) { const n = fpCount.get(fk) || 0; if (n >= FP_MAX) continue; fpCount.set(fk, n + 1); }
    out.push(e);
  }
  return out.slice(0, size);
}

// ---------- state ----------
let board = [];          // ranked, up to KEEP
let epoch = 1;           // last deliberate reset (ms); rows older are ignored when pulling docs
let removed = [];        // admin-removed ids (tombstones so a pull can't bring them back)
let loaded = false;      // true once the server backup doc has been read successfully
let loadErr = "";
const bootAt = Date.now();
const pendingAdds = [];  // entries accepted before the first successful load

function top20() { return board.slice(0, LB_SIZE); }
function absorb(rows) {
  const rm = new Set(removed);
  const ok = rows.filter((e) => e && !rm.has(e.id) && (e.d || 0) >= epoch);
  const before = JSON.stringify(board.map((e) => e.id + ":" + e.s + ":" + (e.c || "")));
  board = rankBoard([...board, ...ok], KEEP);
  return JSON.stringify(board.map((e) => e.id + ":" + e.s + ":" + (e.c || ""))) !== before;
}

async function fetchText(url, init, ms = 10000) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { cache: "no-store", ...init, signal: ctl.signal });
    if (!r.ok) throw new Error("http " + r.status);
    return await r.text();
  } finally { clearTimeout(timer); }
}
function readDoc(txt) {
  try {
    const raw = JSON.parse(txt);
    const arr = Array.isArray(raw) ? raw : raw && Array.isArray(raw.scores) ? raw.scores : null;
    if (!arr) return null;
    return { epoch: Math.floor(Number(raw.epoch)) || 0, removed: Array.isArray(raw.removed) ? raw.removed.map(String).slice(-300) : [],
      scores: arr.map(validEntry).filter(Boolean) };
  } catch { return null; }
}
async function readUrl(u) { try { return readDoc(await fetchText(u + (u.includes("?") ? "&" : "?") + "_=" + Date.now())); } catch { return null; } }

// Pull every doc and union. The server doc must be readable on first load, otherwise we never write (a blank read ≠ empty board).
async function pull(first) {
  const [srv, ...v2] = await Promise.all([SRV_DOC, V2_MAIN, V2_MIRROR, ...V2_SLOTS].map(readUrl));
  const v1 = await Promise.all(V1_DOCS.map(readUrl));
  if (first && !srv) throw new Error("server doc unreadable");
  const healthy = [srv, ...v2].filter(Boolean);
  const newEpoch = Math.max(epoch, ...healthy.map((d) => d.epoch));
  if (newEpoch > epoch) { epoch = newEpoch; board = board.filter((e) => (e.d || 0) >= epoch); }
  if (srv) removed = [...new Set([...removed, ...srv.removed])].slice(-300);
  let changed = false;
  for (const d of [srv, ...v2, ...v1]) if (d) changed = absorb(d.scores) || changed;
  return changed;
}
async function boot() {
  for (let i = 0; !loaded; i++) {
    try {
      await pull(true);
      loaded = true; loadErr = "";
      if (pendingAdds.length) { absorb(pendingAdds.splice(0)); }
      scheduleSave();
      console.log(`[boot] loaded ${board.length} rows, epoch ${epoch}`);
    } catch (e) {
      loadErr = String(e && e.message || e);
      console.log("[boot] load failed, retrying:", loadErr);
      await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * (i + 1))));
    }
  }
}
function whenLoaded(ms) {
  if (loaded) return Promise.resolve(true);
  return new Promise((res) => { const t0 = Date.now(); const iv = setInterval(() => { if (loaded || Date.now() - t0 > ms) { clearInterval(iv); res(loaded); } }, 100); });
}

// ---------- saving (debounced, one write at a time) ----------
let saveTimer = null, saving = false, dirty = false;
function scheduleSave(delay = 1000) {
  dirty = true;
  if (!loaded || saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; void flush(); }, delay);
}
async function flush() {
  if (!loaded || !dirty) return;
  if (saving) { scheduleSave(800); return; }
  saving = true; dirty = false;
  const now = Date.now();
  const srvBody = JSON.stringify({ v: 1, game: LB_GAME + "-server", updated: now, epoch, removed, scores: board });
  const mainBody = JSON.stringify({ v: 1, game: LB_GAME, updated: now, epoch, scores: top20() });
  try {
    const res = await Promise.allSettled([
      fetchText(SRV_DOC, { method: "POST", headers: { "Content-Type": "text/plain" }, body: srvBody }, 15000),
      fetchText(V2_MAIN, { method: "POST", headers: { "Content-Type": "text/plain" }, body: mainBody }, 15000),
    ]);
    if (res[0].status !== "fulfilled") { console.log("[save] server doc write failed, will retry"); dirty = true; }
  } finally {
    saving = false;
    if (dirty) scheduleSave(3000);
  }
}

// ---------- http ----------
const hits = new Map();   // ip -> {post:[ts], get:[ts]}
function limited(ip, kind, max, windowMs) {
  const now = Date.now(); let h = hits.get(ip); if (!h) { h = { post: [], get: [] }; hits.set(ip, h); }
  const arr = h[kind].filter((t) => now - t < windowMs); arr.push(now); h[kind] = arr;
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [ip, h] of hits) if (!h.post.some((t) => now - t < 3600000) && !h.get.some((t) => now - t < 60000)) hits.delete(ip); }, 600000).unref();
function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.socket.remoteAddress || "";
}
function fingerprint(ip) { return ip ? crypto.createHash("sha256").update(IP_SALT + "|" + ip).digest("hex").slice(0, 16) : ""; }
function cors(req, res) {
  const o = String(req.headers.origin || "");
  const ok = ALLOWED_ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+\.(itch\.io|itch\.zone|sharehtml\.org)$/.test(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  res.setHeader("Access-Control-Allow-Origin", ok ? o : "*");   // no cookies are used, so * is a safe fallback (file://, previews)
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}
function readBody(req, max = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > max) { reject(new Error("too big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function adminOk(req) {
  const got = Buffer.from(String(req.headers["x-admin-secret"] || ""));
  const want = Buffer.from(ADMIN_SECRET);
  return ADMIN_SECRET.length >= 16 && got.length === want.length && crypto.timingSafeEqual(got, want);
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  const url = new URL(req.url || "/", "http://x");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const ip = clientIp(req);
  try {
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    if (req.method === "GET" && (path === "/health" || path === "/")) {
      return send(res, 200, { ok: true, loaded, rows: board.length, upSec: Math.round((Date.now() - bootAt) / 1000) });
    }
    if (req.method === "GET" && path === "/scores") {
      if (limited(ip, "get", 120, 60000)) return send(res, 429, { ok: false, error: "slow down" });
      const ready = await whenLoaded(9000);
      if (!ready) return send(res, 503, { ok: false, error: "loading" });
      return send(res, 200, { ok: true, epoch, scores: top20() });
    }
    if (req.method === "POST" && path === "/scores") {
      if (limited(ip, "post", 12, 60000)) return send(res, 429, { ok: false, error: "Too many saves – try again in a minute." });
      let raw;
      try { raw = JSON.parse(await readBody(req)); } catch { return send(res, 400, { ok: false, error: "bad json" }); }
      const src = raw && typeof raw === "object" && raw.entry && typeof raw.entry === "object" ? raw.entry : raw;
      const now = Date.now();
      const k = fingerprint(ip);
      const e = validEntry({ ...src, d: now, ...(k ? { k } : {}) });
      if (!e) {
        const n = cleanName(src && src.n);
        return send(res, 400, { ok: false, error: !n ? "name required" : isRude(n) ? "rude name" : "score rejected" });
      }
      const ready = await whenLoaded(9000);
      const existing = board.find((x) => x.id === e.id);
      if (existing) e.d = existing.d;   // idempotent re-send (pending retry): keep the original time
      if (ready) { absorb([e]); scheduleSave(); }
      else { pendingAdds.push(e); absorb([e]); }
      const t = top20();
      const rank = t.findIndex((x) => x.id === e.id);
      return send(res, 200, { ok: true, epoch, accepted: true, onBoard: rank >= 0, rank: rank + 1, id: e.id, scores: t, persisted: ready });
    }
    if (req.method === "POST" && path === "/admin/reset") {
      if (!adminOk(req)) return send(res, 403, { ok: false });
      let body = {}; try { body = JSON.parse(await readBody(req) || "{}"); } catch { /* */ }
      const ep = Math.floor(Number(body.epoch)) || Date.now();
      epoch = ep; board = []; removed = []; pendingAdds.length = 0;
      if (!loaded) { loaded = true; }
      dirty = true; await flush();
      return send(res, 200, { ok: true, epoch, rows: board.length });
    }
    if (req.method === "POST" && path === "/admin/remove") {
      if (!adminOk(req)) return send(res, 403, { ok: false });
      let body = {}; try { body = JSON.parse(await readBody(req) || "{}"); } catch { /* */ }
      await whenLoaded(15000);
      const names = new Set((Array.isArray(body.names) ? body.names : []).map((n) => String(n).trim().toLowerCase()));
      const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(String));
      const gone = board.filter((e) => ids.has(e.id) || names.has(String(e.n).trim().toLowerCase()));
      board = board.filter((e) => !gone.includes(e));
      removed = [...new Set([...removed, ...gone.map((e) => e.id), ...ids])].slice(-300);
      dirty = true; await flush();
      return send(res, 200, { ok: true, removed: gone.map((e) => e.n), rows: board.length });
    }
    return send(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    console.log("[err]", err && err.message);
    return send(res, 500, { ok: false, error: "server error" });
  }
});
server.keepAliveTimeout = 65000;
server.listen(PORT, () => console.log(`benny-scoreboard on :${PORT}`));
void boot();
// While awake, absorb scores saved through the game's textdb fallback (every 3 min).
setInterval(() => { if (loaded) void pull(false).then((ch) => { if (ch) scheduleSave(); }).catch(() => {}); }, 180000).unref();
async function shutdown() { try { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } dirty = dirty || false; await flush(); } finally { process.exit(0); } }
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
