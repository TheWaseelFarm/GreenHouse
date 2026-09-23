# Al-Waseel Farm — WhatsApp Critical Alerts

Sends a WhatsApp to the on-site engineer when the greenhouse hits a **critical**
condition, so nobody has to watch the dashboard. Runs server-side inside the
scheduled cron (`api/cron-save.js` → `_lib/alerts.js`), so it works with no
browser open.

## What triggers an alert (critical only)
Evaluated against the same seasonal day/night quality bands as the dashboard:

- **Temperature** above the season's `crit` line (e.g. Summer day > 30 °C, night > 28 °C)
- **Frost** (winter/spring nights at or below the frost line)
- **Irrigation water** above 26 °C at the roots
- **Water leak** detected
- **VPD critically dry** (above the day/night hard limit)

Minor "below ideal" drift does **not** notify — the WhatsApp channel is kept
high-signal.

## No spam — the notification rules
Per condition, a small state machine (Supabase `alert_state` table):

1. **Onset** — one message when the condition first goes critical.
2. **Reminder** — if still not resolved, one message every `ALERT_REMINDER_MIN`
   minutes (default **60**).
3. **Resolved** — one "back to normal" message when it clears, then silence.

## Activation — required environment variables (set in Vercel)
The engine is a **no-op until these are set**, so logging keeps working
meanwhile.

| Variable | Example | Notes |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | `ACxxxxxxxx…` | Twilio console |
| `TWILIO_AUTH_TOKEN` | `xxxxxxxx…` | Twilio console (keep secret) |
| `TWILIO_WHATSAPP_FROM` | `whatsapp:+14155238886` | Twilio sandbox number, or an approved sender |
| `ALERT_WHATSAPP_TO` | `whatsapp:+9665XXXXXXXX` | Engineer's WhatsApp number |
| `ALERT_REMINDER_MIN` | `60` | Optional; reminder cadence in minutes |

**Twilio sandbox (fastest test):** in the Twilio console open the WhatsApp
sandbox and have the engineer send the shown join code (e.g. `join <word>`) to
the sandbox number once, to opt in. Then a test cron run will deliver a message.

## Dependency
Alerts only fire when the cron actually runs. If the external scheduler
(cron-job.org) that calls `/api/cron-save` is disabled, **no alerts and no
logging happen** — re-enabling it is required for this to work.

## Setup SQL
Run `db/add-alert-state.sql` once in Supabase → SQL Editor (already applied to
the production project).
