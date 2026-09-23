-- ============================================================================
-- Al-Waseel Farm — Critical-alert state.
-- One row per alert condition (temp_high, temp_frost, water_hot, leak,
-- vpd_high). The cron alert engine (api/cron-save.js → _lib/alerts.js) reads
-- and upserts these to avoid spamming WhatsApp: it notifies once on onset,
-- reminds hourly while still active, and sends a resolved notice when it
-- clears. Run ONCE in Supabase -> SQL Editor. Safe to re-run.
-- ============================================================================

create table if not exists alert_state (
  key           text primary key,
  active        boolean     not null default false,
  last_notified timestamptz,
  updated_at    timestamptz not null default now()
);

-- Keep updated_at fresh on every write.
create or replace function alert_state_touch() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists alert_state_touch_trg on alert_state;
create trigger alert_state_touch_trg
  before update on alert_state
  for each row execute function alert_state_touch();

-- RLS ON with no public policies (matches the rest of the schema): only the
-- server-side service key reads/writes this table. The browser never touches it.
alter table alert_state enable row level security;
