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

`theme_url` must point at a **pinned commit** and the `dist/` subdirectory:

```text
https://github.com/LucaLin233/cfsm-theme-butterfly/tree/<commit-sha>/dist
```

* Pin the commit, not a branch — pushing to the branch would change a live site with no preview step.
  To roll back, point `theme_url` at a previous stage tag's commit.
* `theme_url` lives in `site_options` and is cached for ~120 s, so switching takes up to two minutes.
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
* Global Turnstile enabled → the panel stays read-only, because this port does not implement
  `X-Turnstile-Token` / `X-Turnstile-Verified`.
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
* The traffic view fetches 24 h of history per node (12 nodes ≈ 12 requests, a few hundred KB) and
  throttles to once per 5 minutes.
* The upstream `TW → CN` flag special case is not reproduced.

## License

MIT, as upstream. Upstream author: [TomorrowX6](https://github.com/TomorrowX6). Ported and maintained by
[LucaLin233](https://github.com/LucaLin233).
