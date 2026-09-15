# Butterfly for CF-Server-Monitor

A WinUI 3 / Mica-inspired server dashboard, ported from
[TomorrowX6/Komari-Butterfly](https://github.com/TomorrowX6/Komari-Butterfly) (MIT) to
[CF-Server-Monitor](https://github.com/huilang-me/CF-Server-Monitor) as a **private, self-hosted
third-party theme**. This is not a marketplace release; it is maintained for one instance.

[简体中文](README.zh-CN.md) · English

## What changed compared to upstream

| Area | Upstream (Komari) | This port (CF-Server-Monitor) |
|---|---|---|
| Data layer | Komari JSON-RPC 2.0 (`/api/rpc2`), 9 call sites | REST: `GET /api/config`, `/api/servers`, `/api/server?id=`, `/api/history/all?id=&hours=` (`src/assets/cfsm-api.js`) |
| Field mapping | native Komari model | `src/assets/cfsm-map.js` (units, traffic direction, monthly/all-time totals, line set, remaining traffic) |
| Live updates | polling | one `/api/servers` snapshot + `/api/ws` WebSocket deltas (~5 s coalescing window); falls back to 30→60→120 s polling (15–300 in settings) while the socket is down or refused, disconnects while the tab is hidden, and treat close code 1008 as terminal (polling from then on). |
| Settings | `komari-theme.json` manifest | in-theme panel → `POST /api/theme_options`, keys prefixed `butterfly_`, always read-modify-write |
| Deep links | — | `#/` and `#/server/<id>` (drawer + browser back/forward). A cold deep link fetches only `/api/config` + `/api/server?id=` and opens a `subscribe=<id>` single-server socket — never the full list; closing the drawer switches back to the list and `subscribe=all`. |
| Flags | 272 bundled SVGs | same-origin `/flags/<lowercase>.svg` provided by CFSM |
| Market packaging | `komari-theme.json`, `preview.png`, release ZIP | removed |
| Added blocks | — | IPv4/IPv6 badges, remaining traffic (with degraded mode), expiry countdown, price & billing cycle, all-time inbound/outbound totals |

Direction mapping is deliberate and must stay fixed: the theme's `net_in` is **upload** and `net_out`
is **download**, while CFSM's `net_in_speed` is download and `net_out_speed` is upload. Monthly totals
use `net_tx_monthly` (up) / `net_rx_monthly` (down); all-time totals use `net_tx` / `net_rx`.

## Deploy

Branch roles (the author's publishing flow):

| Branch | Holds | Written by |
|---|---|---|
| `main` | source + `dist/` — **the stable line** | verified changes only |
| `build` | built bundle at its root (`index.html`, `assets/*`), one commit per build | `sh scripts/publish-build.sh` |
| `test` | work in progress, may be broken | day-to-day changes |
| `stable` | alias of `main`, kept only so older `theme_url`s keep resolving | `sh scripts/promote-stable.sh` |

`theme_url` points at the **`build`** branch — the built output sits at its root, with no `dist/` subdirectory:

```text
https://github.com/LucaLin233/cfsm-theme-butterfly/tree/build
```

* Develop on `test`; merge into `main` only after the change is verified — `main` **is** the stable line,
  and `stable` is just an alias that follows it.
* Publish the bundle with `sh scripts/publish-build.sh`: it rebuilds, validates, refuses a dirty tree,
  lays `dist/` out at the root of `build`, and writes `BUILD-INFO.json` (version + source commit) so
  **every build is traceable to the commit it was built from**. Running it twice without changes is a no-op.
* To pin a release, use that build commit instead of the branch: `.../tree/<build-commit>` (immutable content).
* **Propagation is not instant.** The server caches the theme bundle per `theme_url` path, with the TTL
  depending on the ref kind (`src/utils/config.js`): a **branch** ref (`build`) is cached up to **1 hour**
  (`THEME_ASSET_CACHE_TTL_SECONDS = 3600`), a **commit** ref for 24 h
  (`THEME_COMMIT_CACHE_TTL_SECONDS = 86400` — harmless, commit content is immutable). `site_options`
  itself is cached for 5 min (`THEME_STORE_CACHE_TTL_SECONDS = 300`).
  To publish **immediately**, point `theme_url` at the new build commit: a different path is a different
  cache entry.
* If the theme's `index.html` cannot be fetched the site returns `502 Theme index.html is unavailable`
  and does **not** fall back to the built-in theme — recover through `/admin` by changing `theme_url`.

### Asset versioning (important)

CF-Server-Monitor serves theme assets with `Cache-Control: public, max-age=31536000, immutable`.
Every asset reference therefore carries a version query string — `/assets/app.js?v=<version>` — and every
module import does the same. **Bump `version` in `package.json` on each change**, otherwise the query
string stays the same and browsers keep serving the cached copy (this is also what makes a rollback to an
older commit look like "nothing happened").

## Theme settings

The gear button in the top bar opens the theme's own panel (16 settings, grouped appearance / dashboard /
copy, labels in zh-CN, en, ja).

* Saving writes `appearance_options.theme_options` through `POST /api/theme_options` (`{"theme_options": {…}}`).
  That endpoint **replaces the whole object** and always requires `Authorization: Bearer <jwt>`, so the
  panel reads `/api/config` immediately before writing and only merges its own `butterfly_*` keys.
  Keys that belong to other themes (for example LuminaPlus) are preserved.
* Not signed in → the panel is read-only; sign in at `/admin#admin` first.
* Global Turnstile enabled → **the theme handles it**. On boot it reads `/api/config` (exempt only while
  *both* Turnstile headers are absent), renders the Cloudflare widget with the returned `turnstile_site_key`,
  and exchanges the one-time token for a `turnstile_verified` credential. The unified request layer then
  attaches `X-Turnstile-Verified` to every `/api/*` call; `/api/ws` and `/admin/api` stay exempt, and a site
  with only login-flow Turnstile needs no challenge at all.
  When the credential expires, the theme runs **one recovery episode** (at most two automatic
  challenge/exchange attempts, at most one replay per request) and only recovers on a data-bearing success.
  If recovery fails it shows a retryable screen — never a blank page, and it never reloads the page itself.
* Changes apply locally while you edit; nothing is written until you press *Save settings*.

## Development

```bash
npm run check    # build into dist/ + structural validation
npm run build    # copies src/ → dist/ and injects the version token
```

* Node ≥ 20, zero runtime dependencies.
* `dist/` is committed and is what the site loads; CI fails if `dist/` does not match `src/`.
* `scripts/validate.mjs` asserts the deployment contract: `dist/index.html` + `dist/assets/*`, the
  `?v=` query on every module import, no leftover `__THEME_VERSION__`, no remote scripts, no bundled
  flags, plus the mobile-layout contract tokens and that every module really exports the names `app.js`
  imports.

## Known limitations

* `ping_bd` (BGP) reports 1–2 ms on most machines, which is not a plausible RTT for a home line to US/JP.
  BGP is still displayed in the line-latency panel, but it is **excluded** from "best latency"
  (card pill, latency histogram, region averages, drawer stat, latency sorting).
* No data source in CFSM for: virtualization type, IPv4/IPv6 address text, GPU (all empty here),
  CPU temperature, Komari-style `public_remark`. Those rows are hidden instead of showing "unknown".
* The traffic view fetches **6 h** of history per node by default (switchable to 24 h in the panel),
  cached per range and throttled to once per 5 minutes.
* The live link is one `/api/servers` snapshot plus `/api/ws` deltas. Credentials only go into the
  socket URL when the socket **host differs from the page**; a same-origin socket relies on the
  browser sending the `cfsm_auth` Cookie. On a private site whose Cookie is missing/expired while the
  localStorage JWT is still valid, the socket fails authorization and the theme falls back to
  interval polling (no functional loss).
* **Non-goals**: multiple `apiBase` values and cross-origin static hosting. The spec allows them;
  this port is a same-origin single-instance deployment and does not implement them.
* The "skip empty-window nodes" optimisation is **off by default** (`TRAFFIC_SKIP_STALE = false`).
  Enabling it requires all of: a finite status timestamp, local state refreshed within 10 minutes,
  the node offline, and `lastReport + max(1 h, 2 × report_interval)` still earlier than the window
  start — and, before switching it on, a manual `/api/history/all` for the same window on one
  skipped node must return an empty array (3 random skipped nodes all empty).
* The upstream `TW → CN` flag special case is not reproduced.

## License

MIT, as upstream. Upstream author: [TomorrowX6](https://github.com/TomorrowX6). Ported and maintained by
[LucaLin233](https://github.com/LucaLin233).
