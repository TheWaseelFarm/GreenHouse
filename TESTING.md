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

## Authentication

The dashboard is behind a login. Flow:

1. `login.html` (served at `/login`) posts credentials to `/api/auth/login`,
   which validates them against the `DASHBOARD_USER` / `DASHBOARD_PASSWORD_HASH`
   env vars and sets an httpOnly `wf_session` JWT cookie (`SESSION_SECRET`).
2. On load, `index.html` calls `/api/auth/check`; a 401 redirects to `/login`.
3. All browser data endpoints — `devices`, `status`, `history`, `incidents`,
   `council`, `ask-council`, `save-reading` — are gated by `requireAuth`, so
   the sensor data itself is protected (each has a 401 test).
4. Sign Out hits `/api/auth/logout`, which clears the cookie and returns to
   `/login`.

`api/cron-save.js` authenticates separately with its own `CRON_SECRET` bearer
token (it writes to Supabase directly, not through `save-reading`).

Note: this is client-side gating — the dashboard HTML is still served to
unauthenticated visitors before the redirect. The data is protected; the HTML
is not. Server-side gating (routing `/` through `api/page.js`) would close that
gap but requires Vercel routing changes and is left as optional hardening.
