-- ============================================================================
-- Al-Waseel Farm — Daily Plant Log (Field Journal).
-- Stores each field entry: photos taken in the greenhouse, the activities
-- performed, and observations. Run ONCE in Supabase -> SQL Editor. Safe to
-- re-run.
--
-- Photos live in a public Storage bucket `plant-photos` under unguessable
-- paths; the row keeps their public URLs plus the structured metadata.
-- ============================================================================

create table if not exists field_logs (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  log_date    date        not null default current_date,
  author      text,
  location    text,
  activities  jsonb       not null default '[]'::jsonb,
  other_note  text,
  note        text,
  photo_urls  jsonb       not null default '[]'::jsonb
);

create index if not exists field_logs_created_idx on field_logs (created_at desc);
create index if not exists field_logs_date_idx    on field_logs (log_date desc);

-- RLS stays ON with no public policies (matches the rest of the schema): only
-- the server-side service key can read/write. The browser never touches this
-- table or bucket directly.
alter table field_logs enable row level security;

-- Public bucket for plant photos. Paths carry a random token so they are not
-- enumerable; the dashboard renders them with a plain <img src>.
insert into storage.buckets (id, name, public)
values ('plant-photos', 'plant-photos', true)
on conflict (id) do update set public = true;
