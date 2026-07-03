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

## Known issue surfaced by the tests

`calcAbsHumidity` returns values ~10x below the physically expected magnitude
(~1.4 g/m³ vs ~13.8 g/m³ at 25°C / 60% RH), consistent with a kPa-vs-hPa unit
mismatch. `test/metrics.test.js` has a deliberately-failing `.fails` test
documenting the correct target — fix the formula and remove that marker.

## Not yet covered

- `api/gen-hash.js` — a self-described temporary bcrypt-hash endpoint. It is
  intentionally left untested because it should be **deleted**, not shipped.
- `api/page.js` dashboard-serve branch — depends on an `_index.html` file that
  isn't in the repo; only the auth-gate redirect paths are exercised.

## Authentication

The browser-facing endpoints — `devices`, `status`, `history`, `incidents`,
`council`, `ask-council` — are gated by `requireAuth` (session-cookie JWT).
Each has an unauthenticated-request test asserting a 401.

Two ingest paths are intentionally **not** session-gated:

- `api/cron-save.js` authenticates with its own `CRON_SECRET` bearer token.
- `api/save-reading.js` is the device ingest endpoint (wide-open CORS, hit by
  the sensor hardware, which has no browser session). It needs a **device API
  key** rather than the cookie guard — a separate change, not done here.

## Open follow-ups (not test work)

- Give `api/save-reading.js` a device-token auth scheme (see above).
- `api/ask-council.js` targets model `claude-sonnet-4-6`, which is not a valid
  model id.
- Delete `api/gen-hash.js`.
