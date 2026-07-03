# Testing

The suite runs on [Vitest](https://vitest.dev/).

```bash
npm install
npm test           # run once
npm run test:watch # watch mode
npm run coverage   # run with a coverage report (text + html in coverage/)
```

CI runs `npm run coverage` on every pull request (`.github/workflows/test.yml`).

## Layout

```
test/
  metrics.test.js       # pure climate math (_lib/metrics.js)
  auth.test.js          # session guard + login/logout/check
  page.test.js          # HTML auth gate (api/page.js)
  cron-save.test.js     # scheduled data-collection pipeline
  incidents.test.js     # incident CRUD + resolve
  council.test.js       # council decision log
  ask-council.test.js   # Anthropic proxy + prompt selection
  save-reading.test.js  # reading ingest
  sensors.test.js       # devices / status / history read handlers
  helpers/http.js       # fake (req, res) doubles + HTTP-mock helpers
```

Outbound HTTP (Supabase, SwitchBot, Anthropic) is intercepted with
[`nock`](https://github.com/nock/nock); no real network calls are made.

## What is covered

~95% line coverage overall. Highlights:

- **`_lib/metrics.js`** — VPD, dew point, heat index, absolute humidity and
  the plant-stress index, including band boundaries and clamping. 100%.
- **`_lib/auth.js` + `api/auth/*` + `api/page.js`** — the session guard, the
  login flow (rate limiting, input validation, generic-error responses, JWT
  issuance and cookie hardening), logout, session check, and the HTML auth
  gate's redirect paths.
- **`api/cron-save.js`** — the scheduled pipeline: cron-token guard, device
  collection, weighted-average/derived-metric computation, and persistence.
- **Data handlers** — `incidents` (GET/POST/resolve, duration calc, error
  mapping), `council`, `ask-council` (prompt selection by mode), `save-reading`,
  `history`, `devices`, `status`: method guards, CORS, query defaults,
  request signing, validation and error paths.

## Not yet covered

- `api/gen-hash.js` — a self-described temporary bcrypt-hash endpoint. It is
  intentionally left untested because it should be **deleted**, not shipped.
- `api/page.js` dashboard-serve branch — depends on an `_index.html` file that
  isn't in the repo; only the auth-gate redirect paths are exercised.

## Authentication (currently disabled)

The browser-facing endpoints (`devices`, `status`, `history`, `incidents`,
`council`, `ask-council`) were briefly gated by `requireAuth` (session-cookie
JWT), but that gating has been **removed for now**: the dashboard has no login
UI wired up yet, so gating blocked all live data. The endpoints are public
again, matching their original behavior. `_lib/auth.js` and its tests remain in
place for when a proper login flow is built.

`api/cron-save.js` still authenticates with its own `CRON_SECRET` bearer token.

## Open follow-ups (not test work)

- Re-introduce auth once a login page is wired to `/api/auth/login` (gate the
  browser endpoints again, plus a device-token scheme for `api/save-reading.js`).
- `api/ask-council.js` targets model `claude-sonnet-4-6`, which is not a valid
  model id.
- Delete `api/gen-hash.js`.
