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
  metrics.test.js   # pure climate math (_lib/metrics.js)
  auth.test.js      # session guard + login/logout/check
  helpers/http.js   # fake (req, res) doubles for handler tests
```

## What is covered

- **`_lib/metrics.js`** — VPD, dew point, heat index, absolute humidity and
  the plant-stress index, including band boundaries and clamping. 100%.
- **`_lib/auth.js` + `api/auth/*`** — the session guard and the login flow
  (rate limiting, input validation, generic-error responses, JWT issuance and
  cookie hardening), logout, and the session check. 100%.

## Known issue surfaced by the tests

`calcAbsHumidity` returns values ~10x below the physically expected magnitude
(~1.4 g/m³ vs ~13.8 g/m³ at 25°C / 60% RH), consistent with a kPa-vs-hPa unit
mismatch. `test/metrics.test.js` has a deliberately-failing `.fails` test
documenting the correct target — fix the formula and remove that marker.

## Not yet covered (next steps)

The outbound-HTTP handlers still have 0% coverage. In rough priority order:

1. `api/incidents.js` — GET/POST/resolve branching, duration calc, error mapping.
2. `api/council.js` / `api/ask-council.js` — required-field validation, prompt
   selection, method guards.
3. `api/save-reading.js`, `api/history.js`, `api/devices.js`, `api/status.js` —
   CORS/OPTIONS handling, query defaults, request-signing, error paths.

These need the `https` module mocked (e.g. `nock` or dependency injection).

Also worth doing: none of the data endpoints currently call `requireAuth`, and
`api/gen-hash.js` is a self-described temporary file that should be deleted.
